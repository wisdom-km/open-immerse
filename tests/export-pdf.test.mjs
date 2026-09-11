import test from "node:test";
import assert from "node:assert/strict";

import { toPdf, toMarkdown, toDocx, canExport } from "../lib/export.js";

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
