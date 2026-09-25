/**
 * Score the M0 baseline selector against prelabels.
 *
 *   node scripts/baseline-checks.mjs
 *
 * Writes docs/v1-m1-baseline.md. Per-paper progress is kept in
 * labels/checks/ so a rerun continues. Pass --force to recompute.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchCorpus } from "./corpus-fetch.mjs";
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

export async function runChecks({ force = false } = {}) {
  const files = await fetchCorpus();
  const manifest = JSON.parse(readFileSync(join(root, "corpus/manifest.json"), "utf8"));
  mkdirSync(checkDir, { recursive: true });
  const byPaper = [];
  for (const file of files) {
    const doc = manifest.documents.find((entry) => entry.id === file.id);
    const cache = join(checkDir, `${file.id}.json`);
    if (!force && existsSync(cache)) {
      byPaper.push(JSON.parse(readFileSync(cache, "utf8")));
      console.log(`${file.id} cached`);
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
        const score = await scoreBaselinePage({
          paperId: file.id,
          pageNumber: page,
          facePage: await face.getPage(page),
          outlinePage: await outline.getPage(page),
          labels
        });
        add(row, score);
        if (page === 1 || page % 10 === 0 || page === face.numPages) {
          console.log(`${file.id} p${page}/${face.numPages} units ${row.units} missing ${row.missing}`);
        }
        const facePage = await face.getPage(page);
        const outlinePage = await outline.getPage(page);
        facePage.cleanup?.();
        outlinePage.cleanup?.();
      }
    } finally {
      await face.destroy();
      await outline.destroy();
    }
    writeFileSync(cache, JSON.stringify(row));
    byPaper.push(row);
  }
  const markdown = renderReport(manifest, byPaper);
  writeFileSync(join(root, "docs/v1-m1-baseline.md"), markdown);
  writeFileSync(join(root, "labels/baseline-summary.json"), JSON.stringify(byPaper, null, 2));
  console.log(`wrote docs/v1-m1-baseline.md`);
  return byPaper;
}

function renderReport(manifest, rows) {
  const headers = ["paper", "field", "source", "pages", "units", "A1 miss/solid", "A2 neighbours", "A3 exact", "A3 Jaccard", "A4 empty SVG", "prelabel fallback", "record ms/page", "build ms/page", "SVG kB/page"];
  const tableRows = rows.map((row) => [
    row.id,
    row.field,
    row.sourceType,
    row.pages,
    row.units,
    `${row.missing}/${row.solid}`,
    row.neighbours,
    rate(row.correct, row.units),
    rate(row.jaccard, row.units),
    rate(row.emptySvgs, row.baselineBlocks),
    rate(row.prelabelFallback, row.units),
    rate(row.recordMs, row.pages),
    rate(row.buildMs, row.pages),
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
      rate(row.correct, row.units),
      rate(row.jaccard, row.units),
      rate(row.emptySvgs, row.baselineBlocks),
      rate(row.prelabelFallback, row.units)
    ]);
    return `## ${title}\n\n${markdownTable(["group", "pages", "units", "A1 miss/solid", "A2", "A3 exact", "A3 Jaccard", "A4 empty", "prelabel fallback"], body)}\n`;
  };
  return `# M1 baseline\n\nThe selector is \`lib/formula-svg.js\` as carried from the M0 spike. It was not changed. Ground truth for this table is the pre-label set, not a finished human review. When \`labels/reviewed/\` has a page, that file is not substituted here yet; re-run after review if you want the reviewed numbers.\n\nA1 counts left-hand outline ink with no SVG ink within r = 1, over the whole pre-label unit crop. The reference render is pdf.js with font faces off, the same paint the recorder saw. A2 counts a selected element whose label is not \`formula\`. A3 is exact element-set equality against pre-label units, plus mean Jaccard. A4 is the share of text-layer formula blocks whose SVG is empty. Prelabel fallback is the share of units whose confidence is below 0.65; that is the review queue, not the selector.\n\nIdentity conflicts are paints that matched two labels at once and were not given a character.\n\n${markdownTable(headers, tableRows)}\n\n${groupTable("By field", groups[0][1])}\n${groupTable("By source type", groups[1][1])}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runChecks({ force: process.argv.includes("--force") }).catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
