import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { paperIdFromName, summarizeSample } from "../oi-qa/journal-pdf/tools/leak_scan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sample = JSON.parse(readFileSync(join(root, "oi-qa/journal-pdf/sample.json"), "utf8"));

function row(id, after) {
  return {
    id,
    file: `${id}_example.pdf`,
    before: { leaks: after + 3 },
    after: { leaks: after, noise: 0, counts: { a: 0, b: after, c: 0, r2: 0 } }
  };
}

test("paper ids come from the corpus filename", () => {
  assert.equal(paperIdFromName("08_10_1371_journal_pmed_1003346.pdf"), "08");
  assert.equal(paperIdFromName("35_10_1186_s13059_014_0550_8.pdf"), "35");
});

test("sample score ignores paper 13 and applies the merge bar", () => {
  assert.equal(sample.papers.length, 20);
  assert.equal(sample.papers.some((paper) => paper.id === "13"), false);
  const papers = sample.papers.map((paper) => row(paper.id, 0));
  const clean = summarizeSample(papers, sample);
  assert.equal(clean.scored, 20);
  assert.equal(clean.missing.length, 0);
  assert.equal(clean.leaks, 0);
  assert.equal(clean.pass, true);
  assert.equal(clean.v1ReleaseGate, true);

  const leaked = sample.papers.map((paper, index) => row(paper.id, index < 4 ? 4 : 0));
  const mid = summarizeSample(leaked, sample);
  assert.equal(mid.leaks, 16);
  assert.equal(mid.papers, 4);
  assert.equal(mid.pass, true);
  assert.equal(mid.v1ReleaseGate, false);

  const over = sample.papers.map((paper, index) => row(paper.id, index < 6 ? 4 : 0));
  const fail = summarizeSample(over, sample);
  assert.equal(fail.leaks, 24);
  assert.equal(fail.papers, 6);
  assert.equal(fail.pass, false);
});
