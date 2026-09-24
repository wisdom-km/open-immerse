import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CROP_SCALE, DISPLAY_BODY_HARD_MAX, displayFormulaWidthCss } from "../lib/pdf-blocks.js";
import { FORMULA_CROP_PAD } from "../lib/pdf-text-layer.js";
import {
  INLINE_SIDE_GAP_EM,
  SCRIPT_INK_MIN_PX,
  SCRIPT_INK_TARGET_PX,
  SCRIPT_SHARE_DEFAULT,
  SCRIPT_SHARE_HIGH,
  SCRIPT_SHARE_LOW,
  SCRIPT_SHARE_SAFETY,
  DISPLAY_INK_PAINT,
  UNIFORM_SCALE_TOL,
  displayFormulaMinEm,
  matchedDisplayCssSize,
  INLINE_BODY_HARD_MAX,
  inlineFormulaCssSize,
  inlinePaintBox,
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

test("F3-S3 script ink uses the 7px hard gate and promotes a tall inline", () => {
  assert.equal(SCRIPT_INK_MIN_PX, 7);
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

test("F3-S1 display paint stays capped at 2.5em and the live box matches the page", () => {
  assert.equal(DISPLAY_INK_PAINT, 1.45);
  assert.equal(DISPLAY_BODY_HARD_MAX, 2.5);
  const em = displayFormulaMinEm(0.5, 0.2);
  assert.equal(em, DISPLAY_BODY_HARD_MAX);
  assert.ok(em <= DISPLAY_BODY_HARD_MAX);
  const low = displayFormulaMinEm(0.22, 0.05);
  assert.ok(low <= DISPLAY_BODY_HARD_MAX);
  assert.ok(low * 0.22 <= DISPLAY_BODY_HARD_MAX);
  const css = displayFormulaWidthCss(0.48, 0.04, 8);
  assert.match(css, /^max\(calc\(var\(--oi-pdf-left-w/);
  assert.match(css, /2\.5em/);
  assert.doesNotMatch(css, /8em/);
  const pageWidth = 612;
  const pageHeight = 792;
  const paperHeight = 764.47;
  const bbox = [0.26, 0.4, 0.74, 0.44];
  const matched = matchedDisplayCssSize({ bbox, pageWidth, pageHeight, paperHeight });
  assert.ok(Math.abs(matched.cssHeight - 0.04 * paperHeight) < 1e-6);
  assert.ok(Math.abs(matched.cssWidth / matched.cssHeight - (0.48 * pageWidth) / (0.04 * pageHeight)) < 1e-6);
  const exploded = displayFormulaWidthCss(0.9, 0.015, displayFormulaMinEm(0.22, null));
  assert.match(exploded, /2\.5em/);
  assert.doesNotMatch(exploded, /(?<![0-9.])[3-9](?:\.\d+)?em/);
});

test("inline formulas stay on the bbox and cap at 1.4 body without one", () => {
  assert.equal(INLINE_BODY_HARD_MAX, 1.4);
  const pageWidth = 612;
  const pageHeight = 792;
  const paperHeight = 792;
  const bbox = [0.2, 0.4, 0.28, 0.412];
  const matched = inlineFormulaCssSize({ bbox, pageWidth, pageHeight, paperHeight, bodyFontPx: 9.56 });
  assert.equal(matched.source, "bbox");
  assert.ok(Math.abs(matched.cssHeight - 0.012 * paperHeight) < 1e-6);
  assert.ok(matched.cssHeight < 9.56 * 2.2);
  const tall = inlineFormulaCssSize({
    bbox: [0.1, 0.4, 0.7, 0.457],
    pageWidth,
    pageHeight,
    paperHeight,
    bodyFontPx: 9.56
  });
  assert.equal(tall.source, "bbox");
  assert.ok(tall.cssHeight > 9.56 * 2.5);
  const capped = inlineFormulaCssSize({ bodyFontPx: 9.56 });
  assert.equal(capped.source, "cap");
  assert.ok(Math.abs(capped.cssHeight - 9.56 * 1.4) < 1e-9);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  assert.match(viewer, /oi-pdf-inline-math/);
  assert.doesNotMatch(viewer, /classList\.add\("is-promoted"\)/);
  assert.match(css, /\.oi-pdf-inline-math\.is-matched:has\(\.oi-pdf-math-crop\)\s*\{[^}]*display:\s*inline-block/s);
  assert.match(css, /\.oi-pdf-inline-math\.is-matched \.oi-pdf-math-crop\s*\{[^}]*height:\s*var\(--oi-formula-h\)/s);
  assert.match(css, /\.oi-pdf-inline-math\s*\{[^}]*display:\s*inline-block/s);
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
