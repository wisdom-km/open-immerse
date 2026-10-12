import "./helpers/block-live-fetch.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { detectArxivId, normalizeArxivId, parseArxivUrl } from "../lib/arxiv-id.js";
import { ATTENTION_PDF, ATTENTION_PDF_SHA, loadAttentionPages, requireFile } from "./helpers/arxiv-paper.mjs";

requireFile(ATTENTION_PDF, ATTENTION_PDF_SHA, "把 Attention v7 PDF 放到 tests/fixtures/。");

const paper = await loadAttentionPages();

test("AX-01 page-1 stamp is 1706.03762v7", () => {
  const found = detectArxivId({ page1Items: paper.items[0], page: { width: 612, height: 792 } });
  assert.equal(found.id, "1706.03762");
  assert.equal(found.version, "v7");
  assert.equal(found.source, "stamp");
});

test("AX-02 bibliography ids are not selected", () => {
  const all = paper.items.flat();
  const blob = all.map((item) => item.str || "").join("\n");
  assert.match(blob, /1607\.06450/);
  const found = detectArxivId({ page1Items: all, page: { width: 612, height: 792 } });
  assert.equal(found.id, "1706.03762");
  assert.equal(found.version, "v7");
  const bibliography = [{ str: "arXiv:1607.06450", x: 20, y: 100 }];
  assert.equal(detectArxivId({ page1Items: bibliography, page: { width: 612, height: 792 } }), null);
});

test("AX-03 stamp wins over a versionless or conflicting URL", () => {
  const page1Items = paper.items[0];
  const page = { width: 612, height: 792 };
  const bare = detectArxivId({
    url: "https://arxiv.org/pdf/1706.03762",
    page1Items,
    page
  });
  assert.equal(bare.version, "v7");
  assert.equal(bare.source, "stamp");
  const conflict = detectArxivId({
    url: "https://arxiv.org/abs/1706.03762v1",
    page1Items,
    page
  });
  assert.equal(conflict.id, "1706.03762");
  assert.equal(conflict.version, "v7");
  assert.equal(conflict.source, "stamp");
  assert.equal(detectArxivId({ url: "https://example.com/pdf/1706.03762v7" }), null);
  assert.equal(detectArxivId({}), null);
});

test("AX-04 old ids and arxiv.org path shapes", () => {
  assert.equal(normalizeArxivId("hep-th/9711200v2"), "hep-th/9711200v2");
  assert.equal(normalizeArxivId("HEP-TH/9711200"), "hep-th/9711200");
  assert.deepEqual(parseArxivUrl("https://arxiv.org/pdf/hep-th/9711200v2.pdf"), {
    id: "hep-th/9711200",
    version: "v2"
  });
  assert.deepEqual(parseArxivUrl("https://arxiv.org/abs/1706.03762v7"), {
    id: "1706.03762",
    version: "v7"
  });
  assert.deepEqual(parseArxivUrl("https://arxiv.org/src/1706.03762"), {
    id: "1706.03762",
    version: null
  });
  assert.deepEqual(parseArxivUrl("https://ar5iv.labs.arxiv.org/html/1706.03762"), null);
  assert.equal(parseArxivUrl("https://arxiv.org/html/1706.03762v7").version, "v7");
});
