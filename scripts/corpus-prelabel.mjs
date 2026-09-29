/**
 * Write pre-labels for every corpus page.
 *
 *   npm ci
 *   node scripts/corpus-fetch.mjs
 *   node scripts/corpus-prelabel.mjs
 *
 * Already written pages are kept. Pass --force to redo them.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchCorpus } from "./corpus-fetch.mjs";
import { openDocuments, prelabelOnePage } from "./m1-pdf.mjs";
import { verifyPageLabels } from "../lib/label-schema.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const labelRoot = join(root, "labels/prelabel");

function pagePath(paperId, page) {
  return join(labelRoot, paperId, `page-${String(page).padStart(3, "0")}.json`);
}

export async function prelabelCorpus({ only = "", pages = null, force = false } = {}) {
  const fetched = await fetchCorpus();
  const files = fetched.results.filter((row) => row.status === "ok");
  if (!files.length) throw new Error("没有可用的 PDF。先运行 node scripts/corpus-fetch.mjs，或用 --import 放入手动下载的文件。");
  const manifest = JSON.parse(readFileSync(join(root, "corpus/manifest.json"), "utf8"));
  const summary = [];
  for (const file of files) {
    if (only && file.id !== only) continue;
    const doc = manifest.documents.find((entry) => entry.id === file.id);
    const bytes = readFileSync(file.path);
    const { face, outline } = await openDocuments(bytes);
    try {
      const pageCount = face.numPages;
      if (doc && doc.pageCount !== pageCount) {
        throw new Error(`${file.id} 页数 ${pageCount} 与清单 ${doc.pageCount} 不一致`);
      }
      let units = 0;
      let elements = 0;
      const wanted = pages || Array.from({ length: pageCount }, (_, index) => index + 1);
      for (const pageNumber of wanted) {
        const dest = pagePath(file.id, pageNumber);
        if (!force && existsSync(dest)) {
          const existing = JSON.parse(readFileSync(dest, "utf8"));
          units += existing.units.length;
          elements += existing.elements.length;
          continue;
        }
        const facePage = await face.getPage(pageNumber);
        const outlinePage = await outline.getPage(pageNumber);
        const result = await prelabelOnePage({
          paperId: file.id,
          pageNumber,
          facePage,
          outlinePage
        });
        const issues = verifyPageLabels(result.labels);
        if (issues.length) throw new Error(`${file.id} p${pageNumber} ${issues.slice(0, 6).join("; ")}`);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, JSON.stringify(result.labels));
        units += result.labels.units.length;
        elements += result.labels.elements.length;
        console.log(`${file.id} p${pageNumber} elements ${result.labels.elements.length} units ${result.labels.units.length} record ${Math.round(result.recordMs)}ms`);
        facePage.cleanup?.();
        outlinePage.cleanup?.();
      }
      summary.push({ id: file.id, pages: pageCount, elements, units });
    } finally {
      await face.destroy();
      await outline.destroy();
    }
  }
  const totals = summary.reduce((sum, row) => sum + row.units, 0);
  writeFileSync(join(root, "labels/prelabel-summary.json"), JSON.stringify({ papers: summary, formulaUnits: totals }, null, 2));
  if (!only && !pages && summary.length === manifest.documents.length) {
    const byId = new Map(summary.map((row) => [row.id, row.units]));
    for (const doc of manifest.documents) {
      if (byId.has(doc.id)) doc.formulaUnitsEstimate = byId.get(doc.id);
    }
    writeFileSync(join(root, "corpus/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  console.log(`formula units ${totals}`);
  return summary;
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pages = arg("--pages");
  prelabelCorpus({
    only: arg("--only"),
    pages: pages ? pages.split(",").map((value) => Number(value)) : null,
    force: process.argv.includes("--force")
  }).catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
