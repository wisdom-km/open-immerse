/**
 * Repeatable reading-order gate.
 *
 * Text layer (no key):
 *   node scripts/pdf-flow-gate.mjs /path/to/paper-dir ...
 * A paper dir contains paper.pdf and, when present, the arXiv .tex sources.
 *
 * Multimodal, on a machine that has a key. The key is read from the
 * environment and is never printed or written:
 *   OI_MM_API_KEY=... \
 *   OI_MM_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \
 *   OI_MM_MODEL=kimi-k3 \
 *   node scripts/pdf-flow-gate.mjs --mm /path/to/paper-dir
 * ARK_API_KEY and MOONSHOT_API_KEY are also accepted. Moonshot's backup host
 * is used only when MOONSHOT_API_KEY is the key that was found and
 * OI_MM_BASE_URL is unset. Rendering needs @napi-rs/canvas. Without it the
 * text-layer numbers still print and mm is "no-canvas".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { alignBodyFlow, latexParagraphs } from "../lib/pdf-flow-gate.js";
import { bodyFlow, joinPageBoundary } from "../lib/pdf-flow-join.js";

const args = process.argv.slice(2);
const multimodal = args.includes("--mm");
const roots = args.filter((arg) => arg !== "--mm");
if (!roots.length) {
  console.error("usage: node scripts/pdf-flow-gate.mjs [--mm] <paper-dir>...");
  process.exit(2);
}

const { getDocument, GlobalWorkerOptions } = await import("../pdf/vendor/pdf.min.mjs");
const { textLayerToBlocks } = await import("../lib/pdf-text-layer.js");
GlobalWorkerOptions.workerSrc = resolve("pdf/vendor/pdf.worker.min.mjs");

function find(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...find(path, ext));
    else if (name.endsWith(ext)) out.push(path);
  }
  return out;
}

function expandTex(path, seen = new Set()) {
  const full = resolve(path);
  if (seen.has(full)) return "";
  seen.add(full);
  let text = "";
  try { text = readFileSync(full, "utf8"); } catch { return ""; }
  return text.replace(/\\(?:input|include)\{([^}]+)\}/g, (_, name) => {
    const base = name.endsWith(".tex") ? name : `${name}.tex`;
    return expandTex(join(full, "..", base), seen);
  });
}

function endpoint(base) {
  const trimmed = String(base || "").trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (/\/chat\/completions$/i.test(trimmed) || /:generateContent\b/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function joinedFlow(flows) {
  const pages = (flows || []).map((blocks) => (blocks || []).map((block) => ({ ...block })));
  for (let index = 1; index < pages.length; index += 1) {
    const joined = joinPageBoundary(pages[index - 1], pages[index]);
    pages[index - 1] = joined.previous;
    pages[index] = joined.next;
  }
  return pages.flat();
}

function publicReason(reason) {
  return String(reason || "failed")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 80);
}

function mmEnv() {
  const ark = String(process.env.ARK_API_KEY || "").trim();
  const moonshot = String(process.env.MOONSHOT_API_KEY || "").trim();
  const own = String(process.env.OI_MM_API_KEY || "").trim();
  const key = own || ark || moonshot;
  if (!key) return null;
  const base = String(process.env.OI_MM_BASE_URL || "").trim();
  const model = String(process.env.OI_MM_MODEL || "").trim();
  const moonshotOnly = !own && !ark && !base;
  const url = endpoint(base || (moonshotOnly
    ? "https://api.moonshot.cn/v1"
    : "https://ark.cn-beijing.volces.com/api/plan/v3"));
  return {
    key,
    url,
    model: model || (moonshotOnly ? "moonshot-v1-8k-vision-preview" : "kimi-k3"),
    provider: /moonshot\.(cn|ai)/i.test(url) ? "kimi" : "custom"
  };
}

let createCanvas = null;
if (multimodal) {
  try {
    ({ createCanvas } = await import("@napi-rs/canvas"));
  } catch {
    createCanvas = null;
  }
}

async function renderPng(pdfPage) {
  if (!createCanvas) return null;
  const viewport = pdfPage.getViewport({ scale: 1.4 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  await pdfPage.render({ canvasContext: context, viewport }).promise;
  return canvas.toBuffer("image/png").toString("base64");
}

const mm = multimodal ? mmEnv() : null;

for (const root of roots) {
  const dir = resolve(root);
  const pdfs = find(dir, ".pdf").filter((path) => path.endsWith("/paper.pdf"));
  const texFiles = find(dir, ".tex").filter((path) => /\\begin\{document\}/.test(readFileSync(path, "utf8").slice(0, 400000)));
  texFiles.sort((a, b) => statSync(b).size - statSync(a).size);
  const tex = texFiles[0] ? expandTex(texFiles[0]) : "";
  const paragraphs = tex.trim() ? latexParagraphs(tex) : [];
  for (const pdf of pdfs) {
    const doc = await getDocument({
      data: new Uint8Array(readFileSync(pdf)),
      verbosity: 0,
      isOffscreenCanvasSupported: false
    }).promise;
    const pageFlows = [];
    const mmPages = [];
    let missing = 0;
    let mmState = multimodal ? (mm ? (createCanvas ? "text" : "no-canvas") : "no-key") : "off";
    const limit = Math.min(doc.numPages, 8);
    for (let page = 1; page <= limit; page += 1) {
      const pdfPage = await doc.getPage(page);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      let images = null;
      try {
        const ops = await pdfPage.getOperatorList();
        images = { fnArray: ops.fnArray, argsArray: ops.argsArray };
      } catch {
        images = null;
      }
      const laid = textLayerToBlocks({ items: content.items, viewport, images, page });
      missing += laid.sourceAudit?.missing?.length || 0;
      pageFlows.push(bodyFlow(laid.blocks || []));
      if (mm && createCanvas) {
        const png = await renderPng(pdfPage);
        if (!png) {
          mmState = "no-canvas";
          continue;
        }
        const { runMmPage } = await import("../lib/mm-page.js");
        const { sendVision } = await import("../lib/mm-client.js");
        const { reconcilePage, readingOrderOff } = await import("../lib/mm-reconcile.js");
        const result = await runMmPage({
          pngBase64: png,
          text: (laid.blocks || []).map((block) => block.text || "").join("\n"),
          page,
          target: { url: mm.url, model: mm.model, provider: mm.provider },
          sendVision,
          secret: mm.key,
          configured: true
        });
        if (!result.ok) {
          mmState = publicReason(result.reason);
          mmPages.push(bodyFlow(laid.blocks || []));
          continue;
        }
        const reconciled = reconcilePage(result.page.blocks, laid.blocks || []);
        if (readingOrderOff(reconciled.blocks, laid.blocks || [])) {
          mmPages.push(bodyFlow(laid.blocks || []));
          continue;
        }
        mmState = "ran";
        mmPages.push(bodyFlow(reconciled.blocks || []));
      }
    }
    const pages = joinedFlow(pageFlows);
    const aligned = paragraphs.length
      ? alignBodyFlow(paragraphs, pages)
      : { coverage: null, inversions: null, breaks: null, matched: 0, total: 0, note: "no-tex" };
    const report = {
      pdf,
      pages: limit,
      blocks: pages.length,
      missing,
      coverage: aligned.coverage,
      blockCoverage: aligned.blockCoverage,
      inversions: aligned.inversions,
      noiseInversions: aligned.noiseInversions,
      breaks: aligned.breaks,
      noiseBreaks: aligned.noiseBreaks,
      matched: aligned.matched,
      total: aligned.total,
      absent: aligned.absent ?? aligned.gap?.absent ?? 0,
      window: aligned.window || null,
      inversionExamples: aligned.inversionExamples || [],
      breakExamples: aligned.breakExamples || [],
      gap: aligned.gap || null,
      mm: mmState
    };
    if (mmPages.length && paragraphs.length) {
      const mmAligned = alignBodyFlow(paragraphs, joinedFlow(mmPages));
      report.mmAlign = {
        coverage: mmAligned.coverage,
        inversions: mmAligned.inversions,
        noiseInversions: mmAligned.noiseInversions,
        breaks: mmAligned.breaks,
        noiseBreaks: mmAligned.noiseBreaks,
        matched: mmAligned.matched,
        total: mmAligned.total
      };
    }
    console.log(JSON.stringify(report));
  }
}
