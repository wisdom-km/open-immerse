import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importRejection, missingPdfBanner, planMerge, reviewActionsLocked } from "../lib/review-actions.js";

test("a missing PDF locks confirm and names the file", () => {
  assert.equal(reviewActionsLocked(true), true);
  assert.equal(reviewActionsLocked(false), false);
  const banner = missingPdfBanner("crmath-64");
  assert.match(banner, /corpus\/pdfs\/crmath-64\.pdf/);
  assert.match(banner, /--import/);
  assert.match(banner, /不能复核/);
  const review = readFileSync(new URL("../tools/label-review/review.js", import.meta.url), "utf8");
  const confirm = review.slice(review.indexOf("async function confirmUnit"));
  assert.match(confirm, /reviewActionsLocked\(state\.pdfMissing\)/);
  const keys = review.slice(review.indexOf("window.addEventListener(\"keydown\""));
  assert.match(keys, /reviewActionsLocked\(state\.pdfMissing\)/);
  assert.match(review, /missingPdfBanner\(/);
  const css = readFileSync(new URL("../tools/label-review/review.css", import.meta.url), "utf8");
  assert.ok(css.indexOf(".hit.uncertain") < css.indexOf("rect.hit.selected"));
  assert.match(css, /rect\.hit\.selected[\s\S]*stroke:\s*#b00000 !important/);
  assert.match(css, /#pdf-missing/);
});

test("merge refuses a partial unit instead of pulling glyphs out", () => {
  const elements = [
    { id: "a", label: "formula", unitId: "u1" },
    { id: "b", label: "formula", unitId: "u1" },
    { id: "c", label: "formula", unitId: "u2" },
    { id: "d", label: "formula", unitId: "u2" }
  ];
  const oneGlyph = planMerge(elements, ["a"]);
  assert.equal(oneGlyph.ok, false);
  assert.match(oneGlyph.message, /拖出方框/);
  const partial = planMerge(elements, ["a", "c"]);
  assert.equal(partial.ok, false);
  assert.match(partial.message, /拆碎/);
  const whole = planMerge(elements, ["a", "b", "c", "d"]);
  assert.equal(whole.ok, true);
  assert.deepEqual(whole.ids.sort(), ["a", "b", "c", "d"]);
});

test("import rejection is Chinese and does not echo the English id mismatch", () => {
  const message = importRejection(["element 0 id does not match char/font/bbox"]);
  assert.match(message, /^导入被拒绝：/);
  assert.match(message, /第 0 个元素/);
  assert.equal(message.includes("id does not match"), false);
  assert.match(message, /不要手改元素编号/);
});
