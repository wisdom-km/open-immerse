import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CROP_SCALE, DISPLAY_BODY_HARD_MAX, displayFormulaWidthCss } from "../lib/pdf-blocks.js";
import { FORMULA_CROP_PAD, equationKeepFraction } from "../lib/pdf-text-layer.js";
import {
  INLINE_SIDE_GAP_EM,
  FORMULA_FIT_SLACK,
  SCRIPT_INK_TARGET_PX,
  SCRIPT_SHARE_DEFAULT,
  SCRIPT_SHARE_HIGH,
  SCRIPT_SHARE_LOW,
  SCRIPT_SHARE_SAFETY,
  UNIFORM_SCALE_TOL,
  displayFormulaMinEm,
  matchedDisplayCssSize,
  inlineFormulaCssSize,
  inlinePaintBox,
  displayFormulaColumnPx,
  readerFormulaCssSize,
  formulaReadabilityFloor,
  FORMULA_NATIVE_SCALE,
  FORMULA_SHRINK_FLOOR,
  BODY_X_HEIGHT_RATIO,
  inlinePromotesToDisplay,
  scriptInkPx,
  scriptMinEm,
  uniformScaleDelta,
  uniformScaleOk
} from "../lib/pdf-formula-size.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("F3-S2 uniform scale stays inside 0.02 when only one axis is set", () => {
  assert.equal(UNIFORM_SCALE_TOL, 0.02);
  assert.equal(uniformScaleOk(120, 60, 240, 120), true);
  assert.equal(uniformScaleDelta(120, 60, 240, 120), 0);
  assert.equal(uniformScaleOk(100, 40, 200, 100), false);
});

test("F3-S3 script ink paints toward 8px and promotes a tall inline", () => {
  assert.equal(SCRIPT_INK_TARGET_PX, 8);
  const cssH = 7 / 0.25;
  assert.ok(scriptInkPx(cssH, 0.25) >= 7);
  assert.equal(SCRIPT_SHARE_SAFETY, 0.5);
  assert.equal(SCRIPT_SHARE_LOW, 0.28);
  assert.equal(SCRIPT_SHARE_HIGH, 0.4);
  assert.equal(SCRIPT_SHARE_DEFAULT, 0.24);
  assert.equal(inlinePromotesToDisplay(16 / 24, null), true);
  assert.equal(inlinePromotesToDisplay(16 / 24, 0.8), true);
  const painted = displayFormulaMinEm(0.76, 0.8);
  assert.equal(painted, DISPLAY_BODY_HARD_MAX);
  assert.ok(scriptInkPx(scriptMinEm(SCRIPT_SHARE_DEFAULT) * 15, SCRIPT_SHARE_DEFAULT * SCRIPT_SHARE_SAFETY) >= SCRIPT_INK_TARGET_PX - 1e-6);
  const tall = inlinePaintBox(0.5, 0.1);
  assert.equal(tall.promote, true);
  assert.ok(tall.box > 2.2);
  // Font-box share 0.28 at the old 7px floor stays inside 2.2em and measured ~6.5.
  // Paint target 8 plus the safety margin pushes that line box to display.
  const footnote = inlinePaintBox(16 / 24, 0.28);
  assert.equal(footnote.promote, true);
  assert.ok(footnote.box > 2.2);
  const inflated = inlinePaintBox(16 / 24, 0.7);
  assert.equal(inflated.promote, true);
  assert.ok(inflated.box > 2.2);
});

test("F3-S1 fallback width is page points at the readability floor", () => {
  assert.equal(DISPLAY_BODY_HARD_MAX, 2.5);
  const em = displayFormulaMinEm(0.5, 0.2);
  assert.equal(em, DISPLAY_BODY_HARD_MAX);
  assert.ok(em <= DISPLAY_BODY_HARD_MAX);
  const low = displayFormulaMinEm(0.22, 0.05);
  assert.ok(low <= DISPLAY_BODY_HARD_MAX);
  const pageWidth = 612;
  const pageHeight = 792;
  const css = displayFormulaWidthCss(0.48, 0.04, { pageWidthPt: pageWidth, floor: FORMULA_SHRINK_FLOOR });
  assert.equal(css, "max(220.32px, min(100%, 293.76px))");
  assert.doesNotMatch(css, /em|oi-pdf-left-w|paper-h-base/);
  const xHeight = displayFormulaWidthCss(0.48, 0.04, {
    pageWidthPt: pageWidth,
    floor: formulaReadabilityFloor(20, 10)
  });
  assert.equal(xHeight, "max(282.0096px, min(100%, 293.76px))");
  assert.equal(displayFormulaWidthCss(0.48, 0.04, 8), "");
  const bbox = [0.26, 0.4, 0.74, 0.44];
  const matched = matchedDisplayCssSize({ bbox, pageWidth, pageHeight, paperHeight: 400 });
  assert.ok(Math.abs(matched.cssHeight - 0.04 * pageHeight) < 1e-6);
  assert.ok(Math.abs(matched.cssWidth - 0.48 * pageWidth) < 1e-6);
  const exploded = displayFormulaWidthCss(0.9, 0.015, { pageWidthPt: pageWidth, floor: 0.5 });
  assert.equal(exploded, "max(413.1px, min(100%, 550.8px))");
  assert.doesNotMatch(exploded, /em|0\.015|oi-pdf-left-w/);
  const tiny = displayFormulaWidthCss(0.9, 1e-8, { pageWidthPt: pageWidth, floor: 0.75 });
  assert.equal(tiny, exploded);
  assert.doesNotMatch(tiny, /1e-8|0\.00000001/);
});

test("inline formulas match the page point size and have no font-scaled fallback", () => {
  const pageWidth = 612;
  const pageHeight = 792;
  const bbox = [0.2, 0.4, 0.28, 0.412];
  const matched = inlineFormulaCssSize({ bbox, pageWidth, pageHeight, paperHeight: 400, bodyFontPx: 9.56 });
  assert.equal(matched.source, "bbox");
  assert.ok(Math.abs(matched.cssHeight - 0.012 * pageHeight) < 1e-6);
  assert.ok(Math.abs(matched.cssWidth - 0.08 * pageWidth) < 1e-6);
  assert.ok(matched.cssHeight < 9.56 * 2.2);
  const tall = inlineFormulaCssSize({
    bbox: [0.1, 0.4, 0.7, 0.457],
    pageWidth,
    pageHeight,
    paperHeight: 400,
    bodyFontPx: 9.56
  });
  assert.equal(tall.source, "bbox");
  assert.ok(tall.cssHeight > 9.56 * 2.5);
  assert.equal(inlineFormulaCssSize({ bodyFontPx: 9.56 }), null);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  assert.match(viewer, /oi-pdf-inline-math/);
  assert.match(viewer, /matchedFormulaStyle\(formula, layout\?\.page \?\? node\.dataset\.page\)/);
  const readout = viewer.slice(viewer.indexOf("function appendFixtureReadout"), viewer.indexOf("function onReadoutBlockClick"));
  const paragraph = readout.slice(readout.lastIndexOf("const plan = blockReadoutPlan(block)"));
  const pageStamp = paragraph.indexOf("node.dataset.page = String(page)");
  const fillAt = paragraph.indexOf("fillBlockText(node, block, layout)");
  assert.ok(pageStamp >= 0 && fillAt > pageStamp);
  assert.doesNotMatch(viewer, /INLINE_BODY_HARD_MAX|SCRIPT_INK_MIN_PX|DISPLAY_INK_PAINT/);
  assert.doesNotMatch(viewer, /classList\.add\("is-promoted"\)/);
  assert.match(css, /\.oi-pdf-inline-math\.is-matched:has\(\.oi-pdf-math-crop\)\s*\{[^}]*display:\s*inline-block/s);
  assert.match(css, /\.oi-pdf-inline-math\.is-matched \.oi-pdf-math-crop\s*\{[^}]*height:\s*var\(--oi-formula-h\)/s);
  assert.match(css, /\.oi-pdf-inline-math\s*\{[^}]*display:\s*inline-block/s);
});

test("reader formula size stays at the page glyph and ignores the font step", () => {
  assert.equal(FORMULA_NATIVE_SCALE, 1);
  assert.equal(BODY_X_HEIGHT_RATIO, 0.48);
  assert.equal(formulaReadabilityFloor(15, 10), FORMULA_SHRINK_FLOOR);
  assert.ok(formulaReadabilityFloor(20, 10) > FORMULA_SHRINK_FLOOR);
  assert.equal(formulaReadabilityFloor(20, 10), 0.96);
  const inkPt = 62 / 2.24;
  const eq = readerFormulaCssSize({
    bodyFontPx: 16,
    sourceBodyPt: 10,
    inkPt,
    widthPt: 173,
    columnPx: 800
  });
  assert.equal(eq.k, FORMULA_NATIVE_SCALE);
  assert.ok(Math.abs(eq.cssHeight - inkPt) < 0.05);
  assert.ok(Math.abs(eq.cssWidth - 173) < 0.05);
  const larger = readerFormulaCssSize({
    bodyFontPx: 20,
    sourceBodyPt: 10,
    inkPt,
    widthPt: 173,
    columnPx: 800
  });
  assert.equal(larger.cssHeight, eq.cssHeight);
  assert.equal(larger.cssWidth, eq.cssWidth);
  const cramped = readerFormulaCssSize({
    bodyFontPx: 16,
    sourceBodyPt: 10,
    inkPt: 10,
    widthPt: 400,
    columnPx: 200
  });
  assert.equal(cramped.k, formulaReadabilityFloor(16, 10));
  assert.equal(cramped.scrolls, true);
  assert.ok(cramped.cssWidth > 200);
  const attention = { inkPt: 13.98, scriptPt: 3.54, widthPt: 40, sourceBodyPt: 10, inline: true, columnPx: 800 };
  for (const font of [14, 15, 16, 17, 18, 20]) {
    const box = readerFormulaCssSize({ ...attention, bodyFontPx: font });
    assert.equal(box.k, FORMULA_NATIVE_SCALE);
    assert.equal(box.raised, false);
    assert.ok(Math.abs(box.cssHeight - 13.98) < 0.05);
    assert.ok(Math.abs(box.scriptPx - 3.54) < 0.05);
  }
});

test("inline promotion ignores the font step and never scales a staying crop below k", () => {
  const sizeSrc = readFileSync(join(root, "lib/pdf-formula-size.js"), "utf8");
  const body = sizeSrc.slice(
    sizeSrc.indexOf("export function readerFormulaCssSize"),
    sizeSrc.indexOf("function inlineCropRaises")
  );
  assert.doesNotMatch(body, /font\s*<=\s*14/);
  assert.doesNotMatch(body, /font\s*<\s*15/);
  const inlineBranch = body.slice(body.indexOf("if (inline && !raise)"), body.indexOf("const floor"));
  assert.match(inlineBranch, /k:\s*FORMULA_NATIVE_SCALE/);
  assert.doesNotMatch(inlineBranch, /DISPLAY_INK_HARD|column \/|fit/);
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  assert.doesNotMatch(
    css,
    /\.oi-pdf-inline-math\.is-matched \.oi-pdf-math-crop\s*\{[^}]*max-height:\s*var\(--oi-reader-inline-line-max\)/s
  );
  assert.doesNotMatch(
    css,
    /\.oi-pdf-inline-math\.is-matched:has\(\.oi-pdf-math-crop\)\s*\{[^}]*overflow:\s*hidden/s
  );
  assert.match(
    css,
    /\.oi-pdf-inline-math\.is-matched:has\(\.oi-pdf-math-crop\)\s*\{[^}]*(vertical-align|margin-top)/s
  );
  for (const font of [14, 15, 16, 17, 18, 20]) {
    const tall = readerFormulaCssSize({
      bodyFontPx: font,
      sourceBodyPt: 10,
      inkPt: 80,
      widthPt: 40,
      columnPx: 800,
      inline: true
    });
    assert.equal(tall.raised, true, `font ${font} should raise a crop taller than the line`);
    assert.equal(tall.k, FORMULA_NATIVE_SCALE);
    assert.ok(Math.abs(tall.cssHeight - 80) < 0.05);
    const subscript = readerFormulaCssSize({
      bodyFontPx: font,
      sourceBodyPt: 10,
      inkPt: 13.98,
      scriptPt: 3.54,
      widthPt: 20,
      columnPx: 800,
      inline: true
    });
    assert.equal(subscript.raised, false, `font ${font} keeps a native subscript inline`);
    assert.equal(subscript.k, FORMULA_NATIVE_SCALE);
  }
  const wide = readerFormulaCssSize({
    bodyFontPx: 20,
    sourceBodyPt: 10,
    inkPt: 12,
    widthPt: 230,
    columnPx: 586,
    inline: true
  });
  assert.equal(wide.raised, false);
  assert.equal(wide.k, FORMULA_NATIVE_SCALE);
  assert.ok(Math.abs(wide.cssWidth - 230) < 0.05);
  const stay = readerFormulaCssSize({
    bodyFontPx: 16,
    sourceBodyPt: 10,
    inkPt: 13.98,
    scriptPt: 3.54,
    widthPt: 200,
    columnPx: 80,
    inline: true
  });
  assert.equal(stay.raised, true);
  assert.equal(stay.k, formulaReadabilityFloor(16, 10));
  assert.equal(stay.scrolls, true);
  assert.ok(stay.cssWidth > 80);
});

test("a display formula wider than the column shrinks to the readability floor before it scrolls", () => {
  const widthPt = 640;
  for (const font of [14, 16, 20]) {
    const open = readerFormulaCssSize({
      bodyFontPx: font,
      sourceBodyPt: 10,
      inkPt: 40,
      widthPt,
      columnPx: 2000
    });
    assert.equal(open.k, FORMULA_NATIVE_SCALE);
    assert.equal(open.scrolls, false);
    assert.ok(Math.abs(open.cssWidth - widthPt) < 0.05);
    assert.ok(Math.abs(open.cssHeight - 40) < 0.05);
  }
  const fitted = readerFormulaCssSize({
    bodyFontPx: 15,
    sourceBodyPt: 10,
    inkPt: 40,
    widthPt,
    columnPx: 560
  });
  assert.ok(fitted.k < FORMULA_NATIVE_SCALE);
  assert.ok(fitted.k >= formulaReadabilityFloor(15, 10));
  assert.ok(fitted.cssWidth <= 560 + 0.6);
  assert.equal(fitted.scrolls, false);
  const overflow = readerFormulaCssSize({
    bodyFontPx: 15,
    sourceBodyPt: 10,
    inkPt: 40,
    widthPt,
    columnPx: 280
  });
  assert.equal(overflow.k, FORMULA_SHRINK_FLOOR);
  assert.equal(overflow.scrolls, true);
  assert.ok(overflow.cssWidth > 280);
  const xHeight = readerFormulaCssSize({
    bodyFontPx: 20,
    sourceBodyPt: 10,
    inkPt: 40,
    widthPt,
    columnPx: 400
  });
  assert.equal(xHeight.k, formulaReadabilityFloor(20, 10));
  assert.ok(xHeight.k > FORMULA_SHRINK_FLOOR);
  assert.equal(xHeight.scrolls, true);
  assert.ok(Math.abs(xHeight.cssHeight - 40 * xHeight.k) < 0.05);
});

test("a display formula still above 1.0× fits the live box with rounding slack", () => {
  assert.equal(FORMULA_FIT_SLACK, 2);
  const column = 466;
  const widthPt = 500;
  const fitted = readerFormulaCssSize({
    bodyFontPx: 16,
    sourceBodyPt: 10,
    inkPt: 40,
    widthPt,
    columnPx: column
  });
  assert.ok(fitted.k > formulaReadabilityFloor(16, 10));
  assert.ok(fitted.k < FORMULA_NATIVE_SCALE);
  assert.ok(fitted.cssWidth <= column - FORMULA_FIT_SLACK + 0.05);
  assert.equal(fitted.scrolls, false);
  assert.equal(displayFormulaColumnPx({ flowPx: 490, eqNumPx: 20, gapPx: 4 }), 466);
  assert.equal(displayFormulaColumnPx({ flowPx: 456 }), 456);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const columnFn = viewer.slice(viewer.indexOf("function readerColumnPx"), viewer.indexOf("function readerFormulaStyle"));
  assert.match(columnFn, /displayFormulaColumnPx/);
  assert.doesNotMatch(columnFn, /oi-pdf-math-scroll/);
  const watch = viewer.slice(viewer.indexOf("function bindPaperMetrics"), viewer.indexOf("function ensurePaper"));
  assert.match(watch, /requestAnimationFrame/);
  assert.match(watch, /applyPaperMetrics\(\)/);
});

test("a display formula clip crops the trailing equation number", () => {
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  const start = css.indexOf(".oi-pdf-math-row.is-matched .oi-pdf-math-clip");
  const rule = css.slice(start, css.indexOf(".oi-pdf-eq-num", start));
  assert.ok(rule.includes(".oi-pdf-math-row.is-matched .oi-pdf-math-clip"));
  assert.match(rule, /\.oi-pdf-inline-math\.is-matched(?:\.is-raised)? \.oi-pdf-math-clip/);
  assert.match(rule, /overflow:\s*hidden/);
  assert.match(rule, /--oi-eq-keep/);
  assert.doesNotMatch(rule, /overflow:\s*visible/);
  const cropW = 552.5;
  const numberLeft = 523.2;
  const keep = equationKeepFraction(0, cropW, numberLeft);
  assert.ok(keep > 0.4 && keep < 0.98);
  const kept = cropW * keep;
  assert.ok(kept <= numberLeft);
  assert.ok(numberLeft - kept < 0.1);
  const text = readFileSync(join(root, "lib/pdf-text-layer.js"), "utf8");
  const meta = text.slice(text.indexOf("function formulaPaintMeta"), text.indexOf("function formulaSeedBoxes"));
  assert.match(meta, /equationKeepFraction/);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const fill = viewer.slice(viewer.indexOf("function fillBlockText"), viewer.indexOf("function unitsForLayout"));
  assert.match(fill, /oi-pdf-math-clip/);
  assert.match(fill, /eqKeep/);
});

test("F3-S6 side gap is the locked 0.2em and freezes stay put", () => {
  assert.equal(INLINE_SIDE_GAP_EM, 0.2);
  assert.equal(CROP_SCALE, 2);
  assert.equal(FORMULA_CROP_PAD.displayX, 0.0045);
  assert.equal(FORMULA_CROP_PAD.displayY, 0.0030);
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  assert.match(css, /margin:\s*0 0\.2em/);
  assert.match(css, /vertical-align:\s*baseline/);
  assert.doesNotMatch(css, /\.oi-pdf-inline-math\s*\{[^}]*vertical-align:\s*middle/s);
  assert.doesNotMatch(css, /\.oi-pdf-(inline|display)-math[\s\S]{0,400}transform:\s*scale/);
  assert.doesNotMatch(css, /\.oi-pdf-math-crop\s*\{[^}]*object-fit:\s*fill/s);
  assert.match(css, /background:\s*transparent/);
  assert.equal(readFileSync(join(root, "ui/tokens.css"), "utf8").length > 0, true);
});
