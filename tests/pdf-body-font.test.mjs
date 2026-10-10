import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BODY_FONT_FALLBACK_PX,
  CJK_BODY_FACTOR,
  bodyFontPxFromItems,
  clampCjkBodyFactor,
  describeBodyFont,
  mapBodyFontPx
} from "../lib/pdf-body-font.js";
import { DISPLAY_BODY_HARD_MAX, displayFormulaWidthCss } from "../lib/pdf-blocks.js";
import { displayFormulaMinEm, matchedDisplayCssSize } from "../lib/pdf-formula-size.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function bodyItems(height, count, text = "Attention") {
  return Array.from({ length: count }, () => ({ str: text, height }));
}

test("body size is the modal text-layer height mapped by page width", () => {
  const items = [
    ...bodyItems(10, 24, "sentence"),
    ...bodyItems(16, 3, "Title"),
    ...bodyItems(7, 4, "note")
  ];
  const mapped = bodyFontPxFromItems({ items, pageWidth: 612, paperWidth: 612 });
  assert.equal(mapped.source, "text-layer");
  assert.equal(mapped.factor, CJK_BODY_FACTOR);
  assert.ok(Math.abs(mapped.px - 10 * 0.96) < 1e-9);
  assert.ok(Math.abs(mapped.described.bodyItemHeight - 10) < 1e-9);
  const squeezed = bodyFontPxFromItems({ items, pageWidth: 612, paperWidth: 306 });
  assert.ok(Math.abs(squeezed.px - 10 * 0.96 * (306 / 612)) < 1e-9);
  const fromTransform = describeBodyFont(
    Array.from({ length: 10 }, () => ({ str: "sentence", transform: [10, 0, 0, 10, 72, 700] })),
    { pageWidth: 612, pageHeight: 792 }
  );
  assert.equal(fromTransform.trusted, true);
  assert.ok(Math.abs(fromTransform.bodyItemHeight - 10) < 1e-9);
});

test("CJK factor stays inside 0.92 to 1", () => {
  assert.equal(CJK_BODY_FACTOR, 0.96);
  assert.equal(clampCjkBodyFactor(0.5), 0.92);
  assert.equal(clampCjkBodyFactor(1.4), 1);
  assert.equal(clampCjkBodyFactor(0.97), 0.97);
  assert.equal(clampCjkBodyFactor(Number.NaN), 0.96);
  const items = bodyItems(11, 12);
  const mapped = bodyFontPxFromItems({ items, pageWidth: 600, paperWidth: 600, cjkFactor: 1.5 });
  assert.ok(Math.abs(mapped.px - 11 * 1) < 1e-9);
  const low = bodyFontPxFromItems({ items, pageWidth: 600, paperWidth: 600, cjkFactor: 0.8 });
  assert.ok(Math.abs(low.px - 11 * 0.92) < 1e-9);
});

test("low trust keeps the 15px CSS fallback", () => {
  assert.equal(BODY_FONT_FALLBACK_PX, 15);
  const few = bodyFontPxFromItems({ items: bodyItems(10, 3), pageWidth: 612, paperWidth: 500 });
  assert.equal(few.source, "fallback");
  assert.equal(few.px, null);
  const garbled = bodyFontPxFromItems({
    items: Array.from({ length: 12 }, () => ({ str: "\uFFFD\uFFFD", height: 10 })),
    pageWidth: 612,
    paperWidth: 612
  });
  assert.equal(garbled.source, "fallback");
  assert.equal(garbled.px, null);
  const spread = bodyFontPxFromItems({
    items: [8, 9, 10, 11, 12, 13, 14, 15, 16, 18].map((height) => ({ str: "wordword", height })),
    pageWidth: 612,
    paperWidth: 612
  });
  assert.equal(spread.source, "fallback");
  assert.equal(spread.px, null);
  const missing = mapBodyFontPx({ bodyHeight: 10, pageWidth: 612, paperWidth: 0, trusted: true });
  assert.equal(missing.source, "fallback");
  assert.equal(missing.px, null);
  const untrusted = mapBodyFontPx({ bodyHeight: 10, pageWidth: 612, paperWidth: 612, trusted: false });
  assert.equal(untrusted.source, "fallback");
});

test("display em helper stays within 2.5 body and fallback width is page points", () => {
  assert.equal(DISPLAY_BODY_HARD_MAX, 2.5);
  const low = displayFormulaMinEm(0.22, 0.05);
  assert.ok(low <= 2.5);
  assert.ok(low < 4);
  const css = displayFormulaWidthCss(0.9, 0.015, { pageWidthPt: 612, floor: 0.75 });
  assert.equal(css, "max(413.1px, min(100%, 550.8px))");
  assert.doesNotMatch(css, /em|0\.015|oi-pdf-left-w/);
  const xHeight = displayFormulaWidthCss(0.9, 0.015, { pageWidthPt: 612, floor: 0.96 });
  assert.equal(xHeight, "max(528.768px, min(100%, 550.8px))");
  const pageWidth = 612;
  const pageHeight = 792;
  const bbox = [0.12, 0.42, 0.88, 0.47];
  const matched = matchedDisplayCssSize({ bbox, pageWidth, pageHeight, paperHeight: 400 });
  assert.ok(Math.abs(matched.cssHeight - 0.05 * pageHeight) < 1e-6);
  assert.ok(Math.abs(matched.cssWidth - 0.76 * pageWidth) < 1e-6);
  assert.ok(Math.abs(matched.aspect - ((0.76 * pageWidth) / (0.05 * pageHeight))) < 1e-6);
});

test("viewer maps body font and matches formula height without dropping the redraw", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  assert.match(viewer, /describeBodyFont/);
  assert.doesNotMatch(viewer, /mapBodyFontPx/);
  assert.doesNotMatch(viewer, /function applyBodyFont/);
  assert.match(viewer, /stampBodyFont/);
  assert.match(viewer, /readerPrefs\.fontSize/);
  assert.match(viewer, /is-matched/);
  assert.match(viewer, /readerFormulaCssSize/);
  assert.match(viewer, /renderSharpVisualCrop/);
  assert.match(css, /\.reader-flow\s*\{[^}]*font-size:\s*var\(--oi-reader-font-size\)/s);
  assert.match(css, /\.reader-flow \.oi-pdf-p\s*\{[^}]*line-height:\s*var\(--oi-reader-line-height\)/s);
  assert.match(css, /\.oi-pdf-math-row\.is-matched \.oi-pdf-math-crop\s*\{[^}]*height:\s*var\(--oi-formula-h\)/s);
  assert.match(css, /\.oi-pdf-math-row\.is-matched \.oi-pdf-math-crop\s*\{[^}]*width:\s*auto/s);
  assert.match(css, /\.oi-pdf-math-row\.is-matched \.oi-pdf-math-crop\s*\{[^}]*max-height:\s*none/s);
  assert.match(css, /\.oi-pdf-math-scroll \.oi-pdf-math-crop\s*\{[^}]*max-height:\s*2\.5em/s);
  assert.doesNotMatch(css, /\.paper-stack\s*\{[^}]*zoom:/s);
  assert.match(css, /\.reader-flow\s*\{[^}]*width:\s*var\(--rf-measure,\s*min\(var\(--oi-reader-measure\)/s);
  assert.equal(readFileSync(join(root, "lib/pdf-formula-size.js"), "utf8").includes("SCRIPT_INK_MIN_PX"), false);
});
