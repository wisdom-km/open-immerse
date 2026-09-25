/**
 * Build the stratified 1000-unit review queue from pre-labels.
 *
 *   node scripts/review-set.mjs
 *
 * Writes labels/review-set.json. The seed is fixed in lib/review-set.js.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewSet } from "../lib/review-set.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function pageFile(page) {
  return `page-${String(page).padStart(3, "0")}.json`;
}

export function unitsFromCorpus(manifest, readPage) {
  const units = [];
  for (const doc of manifest.documents) {
    for (let page = 1; page <= doc.pageCount; page += 1) {
      const labels = readPage(doc.id, page);
      if (!labels) continue;
      for (const unit of labels.units || []) {
        units.push({
          paperId: doc.id,
          field: doc.field,
          sourceType: doc.sourceType,
          page,
          unitId: unit.id,
          confidence: unit.confidence,
          type: unit.type,
          equationNumber: unit.equationNumber === true,
          elementIds: unit.elementIds || []
        });
      }
    }
  }
  return units;
}

function main() {
  const manifest = JSON.parse(readFileSync(join(root, "corpus/manifest.json"), "utf8"));
  const units = unitsFromCorpus(manifest, (paperId, page) => {
    const path = join(root, "labels/prelabel", paperId, pageFile(page));
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  });
  const set = buildReviewSet(units);
  writeFileSync(join(root, "labels/review-set.json"), JSON.stringify(set));
  console.log(JSON.stringify(set.composition));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
