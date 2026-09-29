import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReviewSet, orderReviewQueue, REVIEW_FIELDS } from "../lib/review-set.js";

function synthetic() {
  const units = [];
  const sources = {
    ai: ["author-latex-preprint", "publisher-typeset"],
    math: ["author-latex-journal", "publisher-typeset"],
    physics: ["author-latex-journal", "publisher-typeset"],
    qbio: ["publisher-typeset"],
    med: ["publisher-typeset"],
    econ: ["author-latex-preprint", "author-latex-journal", "publisher-typeset"]
  };
  for (const field of REVIEW_FIELDS) {
    for (const sourceType of sources[field]) {
      for (let index = 0; index < 200; index += 1) {
        units.push({
          paperId: `${field}-${sourceType}`,
          field,
          sourceType,
          page: 1 + (index % 5),
          unitId: `${field}-${sourceType}-${index}`,
          confidence: index < 40 ? 0.4 : 0.96,
          type: index % 2 === 0 ? "display" : "inline",
          equationNumber: index % 4 === 0,
          elementIds: [`e${index}`]
        });
      }
    }
  }
  return units;
}

test("the review set is a seeded thousand-unit sample balanced by field", () => {
  const units = synthetic();
  const first = buildReviewSet(units);
  const second = buildReviewSet(units);
  assert.deepEqual(first, second);
  assert.equal(first.units.length, 1000);
  assert.equal(first.seed, 20260925);
  const counts = Object.values(first.composition.byField);
  assert.equal(counts.length, 6);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  for (const source of ["author-latex-preprint", "author-latex-journal", "publisher-typeset"]) {
    assert.ok(first.composition.bySource[source] > 0, source);
  }
  assert.ok(first.composition.byType.display > 0);
  assert.ok(first.composition.byType.inline > 0);
  const low = first.units.filter((unit) => unit.confidence < 0.5).length;
  assert.ok(low > 300, `expected low-confidence weight, got ${low}`);
});

test("the queue interleaves papers inside a field before repeating one", () => {
  const units = [];
  for (const paperId of ["aa", "bb", "cc"]) {
    for (let index = 0; index < 4; index += 1) {
      units.push({
        paperId,
        field: "math",
        sourceType: "publisher-typeset",
        page: index + 1,
        unitId: `${paperId}-${index}`,
        confidence: 0.5,
        type: "inline",
        equationNumber: false,
        elementIds: [`e-${paperId}-${index}`]
      });
    }
  }
  const set = buildReviewSet(units, { target: 12 });
  assert.deepEqual(set.units.map((unit) => unit.unitId), [
    "aa-0", "bb-0", "cc-0",
    "aa-1", "bb-1", "cc-1",
    "aa-2", "bb-2", "cc-2",
    "aa-3", "bb-3", "cc-3"
  ]);
  const again = orderReviewQueue(set.units.slice().reverse());
  assert.deepEqual(again.map((unit) => unit.unitId), set.units.map((unit) => unit.unitId));
});

test("the committed review queue keeps the same thousand ids and varies early papers", () => {
  const set = JSON.parse(readFileSync(new URL("../labels/review-set.json", import.meta.url), "utf8"));
  assert.equal(set.seed, 20260925);
  assert.equal(set.units.length, 1000);
  const ids = set.units.map((unit) => `${unit.paperId}:${unit.page}:${unit.unitId}`);
  assert.equal(new Set(ids).size, 1000);
  assert.deepEqual(set.units.slice(0, 6).map((unit) => unit.field), REVIEW_FIELDS);
  const early = set.units.slice(0, 30);
  assert.equal(new Set(early.map((unit) => unit.paperId)).size, 30);
  const ordered = orderReviewQueue(set.units);
  assert.deepEqual(ordered.map((unit) => unit.unitId), set.units.map((unit) => unit.unitId));
});
