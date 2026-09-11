import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SETTINGS } from "../lib/storage.js";
import {
  TRANSLATE_LIMIT_ALL,
  TRANSLATE_LIMIT_PREVIEW,
  applyTranslateLimit,
  normalizeTranslateLimit,
  pickTitleAndFirstParagraph
} from "../lib/translate-limit.js";

const node = (tagName) => ({ tagName });

test("default translateLimit is unlimited all", () => {
  assert.equal(DEFAULT_SETTINGS.translateLimit, "all");
  assert.equal(normalizeTranslateLimit(DEFAULT_SETTINGS.translateLimit), TRANSLATE_LIMIT_ALL);
});

test("normalizeTranslateLimit maps 0/all and preview/2", () => {
  for (const value of [0, "0", "all", "", null, undefined, "nope"]) {
    assert.equal(normalizeTranslateLimit(value), TRANSLATE_LIMIT_ALL, String(value));
  }
  for (const value of ["preview", 2, "2"]) {
    assert.equal(normalizeTranslateLimit(value), TRANSLATE_LIMIT_PREVIEW, String(value));
  }
  assert.equal(normalizeTranslateLimit(3), 3);
  assert.equal(normalizeTranslateLimit("5"), 5);
});

test("preview keeps heading + first paragraph, not the next blocks", () => {
  const h1 = node("H1");
  const p1 = node("P");
  const p2 = node("P");
  const p3 = node("P");
  const limited = applyTranslateLimit([h1, p1, p2, p3], "preview");
  assert.deepEqual(limited, [h1, p1]);
  assert.equal(limited.includes(p2), false);
  assert.deepEqual(applyTranslateLimit([h1, p1, p2], 2), [h1, p1]);
});

test("preview skips extra headings to reach the first body paragraph", () => {
  const h1 = node("H1");
  const h2 = node("H2");
  const p1 = node("P");
  const p2 = node("P");
  assert.deepEqual(pickTitleAndFirstParagraph([h1, h2, p1, p2]), [h1, p1]);
  assert.deepEqual(applyTranslateLimit([h1, h2, p1, p2], "preview"), [h1, p1]);
});

test("all / 0 does not slice; numeric 3 does", () => {
  const nodes = [node("H1"), node("P"), node("P"), node("P")];
  assert.equal(applyTranslateLimit(nodes, "all").length, 4);
  assert.equal(applyTranslateLimit(nodes, 0).length, 4);
  assert.deepEqual(applyTranslateLimit(nodes, 3), nodes.slice(0, 3));
});

test("content.js caps nodes with translateLimit before batchSize", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../content/content.js"), "utf8");
  assert.match(src, /applyTranslateLimit/);
  assert.match(src, /settings\.translateLimit/);
  assert.match(src, /includeTranslated/);
  assert.match(src, /batchSize only chunks/);
  const applyAt = src.indexOf("applyTranslateLimit(collected");
  const batchAt = src.indexOf("settings.batchSize");
  assert.ok(applyAt > 0 && batchAt > applyAt);
});
