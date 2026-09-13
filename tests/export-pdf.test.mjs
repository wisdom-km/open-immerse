import test from "node:test";
import assert from "node:assert/strict";

import {
  articleBlocksToMarkdown,
  articleBlocksToPdf,
  canExport,
  canExportReadout,
  toDocx,
  toMarkdown,
  toPdf,
  translationExportFilename,
  wrapExportLine
} from "../lib/export.js";

const sample = {
  type: "word",
  original: "immerse",
  translation: "沉浸",
  context: "bilingual",
  title: "Docs",
  url: "https://example.com"
};

test("toPdf writes a real PDF with original and translation", () => {
  const bytes = toPdf([sample]);
  assert.ok(bytes instanceof Uint8Array);
  const ascii = new TextDecoder("latin1").decode(bytes);
  assert.ok(ascii.startsWith("%PDF-1.4"));
  assert.match(ascii, /%%EOF/);
  assert.match(ascii, /immerse/);
  assert.match(ascii, /\/Type \/Page/);
});

test("markdown and docx still export original + translation + context", async () => {
  const md = toMarkdown([sample]);
  assert.match(md, /immerse/);
  assert.match(md, /沉浸/);
  assert.match(md, /bilingual/);
  const docx = await toDocx([sample]);
  assert.ok(docx.byteLength > 100);
  assert.equal(canExport([]), false);
  assert.equal(canExport([sample]), true);
});

test("readout export is markdown + PDF of Chinese blocks only", () => {
  const nodes = [
    { tag: "h1", text: "注意力机制就够了" },
    { tag: "h2", text: "摘要" },
    { tag: "p", text: "我们提出一种新架构。" }
  ];
  assert.equal(canExportReadout([]), false);
  assert.equal(canExportReadout([{ tag: "p", text: "  " }]), false);
  assert.equal(canExportReadout(nodes), true);
  assert.equal(translationExportFilename("paper", "md"), "paper-译文.md");
  assert.equal(translationExportFilename("Attention Is All You Need", "pdf"), "Attention Is All You Need-译文.pdf");
  assert.equal(translationExportFilename("", "md"), "PDF-译文.md");
  const md = articleBlocksToMarkdown(nodes);
  assert.match(md, /^# 注意力机制就够了/m);
  assert.match(md, /^## 摘要/m);
  assert.match(md, /我们提出一种新架构。/);
  assert.doesNotMatch(md, /Attention|Abstract/);
  const withMath = articleBlocksToMarkdown([
    { tag: "p", text: "注意力定义为" },
    { tag: "p", text: "$$\n\\operatorname{Attention}(Q,K,V)=\\mathrm{softmax}(\\frac{QK^{T}}{\\sqrt{d_k}})V\n$$" }
  ]);
  assert.match(withMath, /注意力定义为/);
  assert.match(withMath, /\$\$\n\\operatorname\{Attention\}/);
  assert.match(withMath, /QK\^\{T\}/);
  const bytes = articleBlocksToPdf(nodes);
  assert.ok(bytes instanceof Uint8Array);
  const ascii = new TextDecoder("latin1").decode(bytes);
  assert.ok(ascii.startsWith("%PDF-1.4"));
  assert.match(ascii, /%%EOF/);
  assert.match(ascii, /\/Type \/Page/);
  assert.deepEqual(wrapExportLine("短"), ["短"]);
  assert.equal(wrapExportLine("一二三四五六七八九十".repeat(5), 10).length, 5);
});
