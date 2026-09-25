import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewSet, REVIEW_FIELDS } from "../lib/review-set.js";

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
