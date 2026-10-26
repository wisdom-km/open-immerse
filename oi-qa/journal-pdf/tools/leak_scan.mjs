/**
 * Product-path leak scan.
 *
 *   node oi-qa/journal-pdf/tools/leak_scan.mjs --corpus /path/to/pdfs
 *   node oi-qa/journal-pdf/tools/leak_scan.mjs --corpus /path/to/pdfs --out /tmp/m1-leak.json
 *
 * Every PDF in the directory is scanned (the 54-paper run). The bundled
 * 20-paper sample is scored from those results. Paper 13 is never scored.
 * PDFs are not in this repository. Pass the directory; nothing is uploaded.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { countLeaks, countNoise, readingSurfaceText } from "../../../lib/pdf-leak-rules.js";
import { layoutRouteForPage } from "../../../lib/pdf-layout-route.js";
import { attachFontRealNames } from "../../../lib/pdf-mirror.js";
import { textLayerToBlocks } from "../../../lib/pdf-text-layer.js";

const SAMPLE_PATH = fileURLToPath(new URL("../sample.json", import.meta.url));
const MERGE_LEAKS = 20;
const MERGE_PAPERS = 5;

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] || fallback;
}

function has(name) {
  return process.argv.includes(name);
}

export function paperIdFromName(name) {
  const base = basename(name, extname(name));
  const hit = base.match(/^(\d{2})(?:_|\b)/);
  return hit ? hit[1] : base;
}

function rawSurface(items) {
  const rows = new Map();
  for (const item of items || []) {
    const str = String(item?.str || "");
    if (!str.trim()) continue;
    const y = Math.round(((item.transform?.[5] ?? item.y ?? 0) * 2)) / 2;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(item);
  }
  const lines = [...rows.keys()].sort((a, b) => b - a).map((y) => {
    const row = rows.get(y).sort((a, b) => (a.transform?.[4] ?? a.x ?? 0) - (b.transform?.[4] ?? b.x ?? 0));
    return row.map((item) => item.str).join(" ");
  });
  return lines.join("\n");
}

async function loadPdfjs() {
  const pdfjs = await import("../../../pdf/vendor/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  return pdfjs;
}

export async function scanPdf(bytes, { maxPages = Infinity } = {}) {
  const { getDocument } = await loadPdfjs();
  const doc = await getDocument({
    data: new Uint8Array(bytes).slice(),
    verbosity: 0,
    isOffscreenCanvasSupported: false,
    disableFontFace: true,
    isEvalSupported: false
  }).promise;
  const route = layoutRouteForPage();
  let raw = "";
  let product = "";
  const pages = Math.min(doc.numPages, maxPages);
  try {
    for (let number = 1; number <= pages; number += 1) {
      const page = await doc.getPage(number);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        attachFontRealNames(content.items, page.commonObjs);
        raw += `${rawSurface(content.items)}\n`;
        const built = textLayerToBlocks({
          items: content.items,
          viewport,
          page: number
        });
        product += `${readingSurfaceText(built)}\n`;
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.destroy();
  }
  const before = countLeaks(raw);
  const after = countLeaks(product);
  const noise = countNoise(product);
  const rawNoise = countNoise(raw);
  return {
    route: route.route,
    routeReason: route.reason,
    pageCount: doc.numPages,
    pagesScanned: pages,
    before: { leaks: before.total, counts: before.counts, examples: before.examples, noise: rawNoise.total },
    after: { leaks: after.total, counts: after.counts, examples: after.examples, noise: noise.total, noiseExamples: noise.examples },
    chars: product.length
  };
}

export function summarizeSample(scanPapers, sample) {
  const byId = new Map((scanPapers || []).map((paper) => [paper.id, paper]));
  const rows = [];
  const missing = [];
  for (const paper of sample?.papers || []) {
    if (paper.id === "13") continue;
    const found = byId.get(paper.id);
    if (!found) {
      missing.push(paper.id);
      continue;
    }
    rows.push({
      id: paper.id,
      layout: paper.layout,
      file: found.file,
      m0: paper.m0 || null,
      before: found.before.leaks,
      after: found.after.leaks,
      noise: found.after.noise,
      counts: found.after.counts
    });
  }
  const leaks = rows.reduce((sum, row) => sum + row.after, 0);
  const papers = rows.filter((row) => row.after > 0).length;
  return {
    scored: rows.length,
    expected: (sample?.papers || []).filter((paper) => paper.id !== "13").length,
    missing,
    excluded: ["13"],
    leaks,
    papers,
    mergeBar: { leaks: MERGE_LEAKS, papers: MERGE_PAPERS },
    pass: rows.length > 0 && missing.length === 0 && leaks <= MERGE_LEAKS && papers <= MERGE_PAPERS,
    v1ReleaseGate: leaks === 0 && papers === 0 && missing.length === 0 && rows.length > 0,
    rows
  };
}

async function main() {
  const corpus = arg("--corpus");
  if (!corpus || has("--help")) {
    console.log("usage: node oi-qa/journal-pdf/tools/leak_scan.mjs --corpus DIR [--out FILE] [--max-pages N] [--sample FILE]");
    process.exit(corpus ? 0 : 1);
  }
  const maxPages = arg("--max-pages") ? Number(arg("--max-pages")) : Infinity;
  const samplePath = arg("--sample", SAMPLE_PATH);
  const sample = JSON.parse(await readFile(samplePath, "utf8"));
  const dir = resolve(corpus);
  const names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
  const papers = [];
  for (const name of names) {
    const id = paperIdFromName(name);
    process.stderr.write(`scan ${name}\n`);
    try {
      const result = await scanPdf(await readFile(join(dir, name)), { maxPages });
      papers.push({ id, file: name, ...result });
    } catch (error) {
      papers.push({ id, file: name, error: String(error?.message || error) });
    }
  }
  const scanned = papers.filter((paper) => paper.after);
  const report = {
    corpus: dir,
    pdfs: names.length,
    scanned: scanned.length,
    route: layoutRouteForPage().route,
    totals: {
      before: scanned.reduce((sum, paper) => sum + paper.before.leaks, 0),
      after: scanned.reduce((sum, paper) => sum + paper.after.leaks, 0),
      noise: scanned.reduce((sum, paper) => sum + paper.after.noise, 0),
      papersWithLeaks: scanned.filter((paper) => paper.after.leaks > 0).length
    },
    papers,
    sample: summarizeSample(scanned, sample)
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const out = arg("--out");
  if (out) await writeFile(resolve(out), json);
  else process.stdout.write(json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
