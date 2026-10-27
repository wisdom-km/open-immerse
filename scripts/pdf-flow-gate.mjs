/**
 * Repeatable reading-order gate.
 * Text-layer blocks are aligned to LaTeX paragraphs when a .tex is present.
 * No API key is read. A directory of papers:
 *   papers/<id>/*.pdf and optional *.tex
 * Prints one JSON line per paper.
 *
 *   node scripts/pdf-flow-gate.mjs papers/txl
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { alignBodyFlow, latexParagraphs, paragraphsOnBlocks } from "../lib/pdf-flow-gate.js";
import { bodyFlow } from "../lib/pdf-flow-join.js";

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error("usage: node scripts/pdf-flow-gate.mjs <paper-dir>...");
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
    const pages = [];
    let missing = 0;
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
      pages.push(...bodyFlow(laid.blocks || []));
    }
    const present = paragraphs.length ? paragraphsOnBlocks(paragraphs, pages) : [];
    const aligned = paragraphs.length
      ? { ...alignBodyFlow(present, pages), sourceParagraphs: paragraphs.length, present: present.length }
      : { coverage: null, inversions: null, breaks: null, fakeHeadings: null, matched: 0, total: 0, note: "no-tex" };
    console.log(JSON.stringify({
      pdf,
      pages: limit,
      blocks: pages.length,
      missing,
      ...aligned
    }));
  }
}
