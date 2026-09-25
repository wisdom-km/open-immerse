import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../corpus/manifest.json", import.meta.url), "utf8"));

test("the corpus is six fields of five downloadable papers, including the two required anchors", () => {
  assert.equal(manifest.schema, "open-immerse.corpus/v1");
  assert.equal(manifest.documents.length, 30);
  const counts = new Map();
  const sources = new Map();
  for (const doc of manifest.documents) {
    counts.set(doc.field, (counts.get(doc.field) || 0) + 1);
    sources.set(doc.sourceType, (sources.get(doc.sourceType) || 0) + 1);
    assert.match(doc.sha256, /^[a-f0-9]{64}$/);
    assert.ok(doc.url.startsWith("https://"));
    assert.ok(doc.license);
    assert.ok(doc.pageCount > 0);
    assert.ok(doc.producer);
    assert.equal(/microsoft word/i.test(`${doc.producer} ${doc.creator}`), false);
    assert.ok(["publisher-typeset", "author-latex-journal", "author-latex-preprint"].includes(doc.sourceType));
  }
  for (const field of ["ai", "math", "physics", "qbio", "med", "econ"]) {
    assert.equal(counts.get(field), 5, field);
  }
  const ids = new Set(manifest.documents.map((doc) => doc.id));
  assert.ok(ids.has("1706.03762"));
  assert.ok(ids.has("2006.11239"));
  assert.ok(sources.get("publisher-typeset") >= 1);
  assert.ok(sources.get("author-latex-preprint") >= 1);
});
