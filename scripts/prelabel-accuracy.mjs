/**
 * Score the fixed agent-judgment set against labels/prelabel.
 *
 *   node scripts/prelabel-accuracy.mjs
 *
 * These judgments are the agent's, from rendered crops and glyph geometry.
 * They are not the owner's ground truth.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgePage, summarizeJudgments } from "../lib/prelabel-accuracy.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(root, "tests/fixtures/prelabel-judgments.json"), "utf8"));

function readPage(paper, page) {
  const path = join(root, "labels/prelabel", paper, `page-${String(page).padStart(3, "0")}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const results = fixture.cases.map((judgment) => ({
  ...judgePage(readPage(judgment.paper, judgment.page), judgment),
  source: judgment.source,
  must: judgment.must === true
}));
const summary = summarizeJudgments(fixture.cases, results);
console.log(fixture.note);
console.log(JSON.stringify(summary, null, 2));
for (const result of results) {
  if (result.ok) continue;
  console.log(`miss ${result.id} ${result.source} ${result.reason}`);
}
