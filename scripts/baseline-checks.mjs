/**
 * Score the M0 baseline selector against prelabels.
 *
 *   node scripts/baseline-checks.mjs
 *   node scripts/baseline-checks.mjs --write-docs
 *
 * Does not download. Papers whose PDF is missing are listed and skipped.
 * The default report is labels/checks/baseline-report.md (gitignored).
 * --write-docs updates docs/v1-m1-baseline.md and
 * labels/baseline-summary.json. Those files omit timings. Timings are
 * printed on stdout. Per-paper progress is kept in labels/checks/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDocuments, scoreBaselinePage } from "./m1-pdf.mjs";
import { markdownTable, round3 } from "../lib/label-checks.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const checkDir = join(root, "labels/checks");

function emptyRow() {
  return {
    pages: 0,
    units: 0,
    correct: 0,
    jaccard: 0,
    neighbours: 0,
    conflicts: 0,
    missing: 0,
    solid: 0,
    crops: 0,
    prelabelFallback: 0,
    baselineBlocks: 0,
    emptySvgs: 0,
    recordMs: 0,
    buildMs: 0,
    svgBytes: 0
  };
}

function add(row, score) {
  row.pages += 1;
  row.units += score.formulaUnits;
  row.correct += score.accuracy.correct;
  row.jaccard += score.accuracy.meanJaccard * score.formulaUnits;
  row.neighbours += score.neighbourCount;
  row.conflicts += score.identityConflicts;
  row.missing += score.missing;
  row.solid += score.solid;
  row.crops += score.crops;
  row.prelabelFallback += score.prelabelFallback.fallback;
  row.baselineBlocks += score.baselineBlocks;
  row.emptySvgs += score.emptySvgs;
  row.recordMs += score.recordMs;
  row.buildMs += score.buildMs;
  row.svgBytes += score.svgBytes;
}

function rate(part, total) {
  if (!total) return "0";
  return round3(part / total).toFixed(3);
}

export function publicRow(row) {
  const copy = { ...row };
  delete copy.recordMs;
  delete copy.buildMs;
  return copy;
}

export function formatTiming(rows) {
  const lines = ["id  record ms/page  build ms/page"];
  for (const row of rows) {
    lines.push(`${row.id}  ${rate(row.recordMs, row.pages)}  ${rate(row.buildMs, row.pages)}`);
  }
  return lines.join("\n");
}

export async function runChecks({
  force = false,
  writeDocs = false,
  manifestPath = join(root, "corpus/manifest.json"),
  pdfDir = join(root, "corpus/pdfs"),
  cacheDir = checkDir,
  reportPath = "",
  summaryPath = ""
} = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mkdirSync(cacheDir, { recursive: true });
  const missing = [];
  const files = [];
  for (const doc of manifest.documents) {
    const path = join(pdfDir, `${doc.id}.pdf`);
    if (!existsSync(path)) missing.push(doc.id);
    else files.push({ id: doc.id, path, doc });
  }
  console.log(`本地 PDF ${files.length} 篇，缺少 ${missing.length} 篇（不下载）`);
  if (missing.length) {
    console.log("缺少这些文件，已跳过：");
    for (const id of missing) console.log(`  corpus/pdfs/${id}.pdf`);
  }
  const byPaper = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const doc = file.doc;
    const cache = join(cacheDir, `${file.id}.json`);
    console.log(`开始 ${index + 1}/${files.length} ${file.id}`);
    if (!force && existsSync(cache)) {
      byPaper.push(JSON.parse(readFileSync(cache, "utf8")));
      console.log(`${file.id} 使用缓存`);
      continue;
    }
    const labelsDir = join(root, "labels/prelabel", file.id);
    const bytes = readFileSync(file.path);
    const { face, outline } = await openDocuments(bytes);
    const row = emptyRow();
    row.id = file.id;
    row.field = doc.field;
    row.sourceType = doc.sourceType;
    row.title = doc.title;
    try {
      for (let page = 1; page <= face.numPages; page += 1) {
        const labelPath = join(labelsDir, `page-${String(page).padStart(3, "0")}.json`);
        const labels = JSON.parse(readFileSync(labelPath, "utf8"));
        const facePage = await face.getPage(page);
        const outlinePage = await outline.getPage(page);
        try {
          const score = await scoreBaselinePage({
            paperId: file.id,
            pageNumber: page,
            facePage,
            outlinePage,
            labels
          });
          add(row, score);
          if (page === 1 || page % 10 === 0 || page === face.numPages) {
            console.log(`${file.id} p${page}/${face.numPages} units ${row.units} missing ${row.missing}`);
          }
        } finally {
          facePage.cleanup?.();
          outlinePage.cleanup?.();
        }
      }
    } finally {
      await face.destroy();
      await outline.destroy();
    }
    writeFileSync(cache, JSON.stringify(row));
    byPaper.push(row);
  }
  const markdown = renderReport(manifest, byPaper, missing);
  const stored = byPaper.map(publicRow);
  const reportDest = reportPath || (writeDocs ? join(root, "docs/v1-m1-baseline.md") : join(cacheDir, "baseline-report.md"));
  const summaryDest = summaryPath || (writeDocs ? join(root, "labels/baseline-summary.json") : join(cacheDir, "baseline-summary.json"));
  mkdirSync(join(reportDest, ".."), { recursive: true });
  mkdirSync(join(summaryDest, ".."), { recursive: true });
  writeFileSync(reportDest, markdown);
  writeFileSync(summaryDest, JSON.stringify(stored, null, 2));
  console.log(formatTiming(byPaper));
  console.log(writeDocs ? `wrote ${reportDest}` : `wrote ${reportDest}（未改写 docs/v1-m1-baseline.md）`);
  return { rows: byPaper, missing };
}

export function renderReport(manifest, rows, missing = []) {
  const headers = ["paper", "field", "source", "pages", "units", "A1 miss/solid", "A2 neighbours", "identity conflicts", "A3 exact", "A3 Jaccard", "empty SVG", "A4 fallback", "SVG kB/page"];
  const tableRows = rows.map((row) => [
    row.id,
    row.field,
    row.sourceType,
    row.pages,
    row.units,
    `${row.missing}/${row.solid}`,
    row.neighbours,
    row.conflicts,
    rate(row.correct, row.units),
    rate(row.jaccard, row.units),
    rate(row.emptySvgs, row.baselineBlocks),
    rate(row.prelabelFallback, row.units),
    rate(row.svgBytes / 1024, row.pages)
  ]);
  const groups = [];
  for (const key of ["field", "sourceType"]) {
    const map = new Map();
    for (const row of rows) {
      const id = row[key];
      if (!map.has(id)) map.set(id, emptyRow());
      const acc = map.get(id);
      for (const name of Object.keys(acc)) acc[name] += row[name] || 0;
      acc.id = id;
    }
    groups.push([key, [...map.values()]]);
  }
  const groupTable = (title, list) => {
    const body = list.map((row) => [
      row.id,
      row.pages,
      row.units,
      `${row.missing}/${row.solid}`,
      row.neighbours,
      row.conflicts,
      rate(row.correct, row.units),
      rate(row.jaccard, row.units),
      rate(row.emptySvgs, row.baselineBlocks),
      rate(row.prelabelFallback, row.units)
    ]);
    return `## ${title}\n\n${markdownTable(["group", "pages", "units", "A1 miss/solid", "A2", "identity conflicts", "A3 exact", "A3 Jaccard", "empty SVG", "A4 fallback"], body)}\n`;
  };
  const skipped = missing.length
    ? missing.map((id) => `- corpus/pdfs/${id}.pdf`).join("\n")
    : "No papers were skipped.";
  return `# M1 baseline\n\nThe selector is \`lib/formula-svg.js\` as carried from the M0 spike. It was not changed. These numbers are measured against the unreviewed pre-labels in \`labels/prelabel/\`. Reviewed JSON under \`labels/reviewed/\` is not substituted.\n\nA1 counts left-hand outline ink with no SVG ink within r = 1, over the whole pre-label unit crop. The reference render is pdf.js with font faces off, the same paint the recorder saw. A2 counts a selected element whose label is not \`formula\`. A3 is exact element-set equality against pre-label units, plus mean Jaccard. Empty SVG is the share of text-layer formula blocks whose SVG is empty. A4 fallback is the share of pre-label formula units whose confidence is below 0.65. Those are different columns.\n\nIdentity conflicts are paints that matched two labels at once and were not given a character.\n\nRecord and build timings are printed by the script and are not stored in this file.\n\n${markdownTable(headers, tableRows)}\n\n${groupTable("By field", groups[0][1])}\n${groupTable("By source type", groups[1][1])}\n## Skipped\n\n${skipped}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runChecks({
    force: process.argv.includes("--force"),
    writeDocs: process.argv.includes("--write-docs")
  }).catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
