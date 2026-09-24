import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CROP_SCALE, DISPLAY_INK_PREFER, displayFormulaWidthCss } from "../lib/pdf-blocks.js";
import { FORMULA_CROP_PAD } from "../lib/pdf-text-layer.js";
import {
  INLINE_SIDE_GAP_EM,
  SCRIPT_INK_MIN_PX,
  SCRIPT_INK_TARGET_PX,
  UNIFORM_SCALE_TOL,
  displayFormulaMinEm,
  inlinePaintBox,
  inlinePromotesToDisplay,
  scriptInkPx,
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
  assert.equal(inlinePromotesToDisplay(16 / 24, null), false);
  const tall = inlinePaintBox(0.5, 0.1);
  assert.equal(tall.promote, true);
  assert.ok(tall.box > 2.2);
  const fitted = inlinePaintBox(16 / 24, 0.28);
  assert.equal(fitted.promote, false);
  assert.ok(fitted.box <= 2.2);
  assert.ok(scriptInkPx(fitted.box * 15, 0.28) >= 7 - 1e-6);
});

test("F3-S1 display em keeps prefer ink and does not cap the width at the column", () => {
  const em = displayFormulaMinEm(0.5, 0.2);
  assert.ok(em * 0.5 >= DISPLAY_INK_PREFER - 1e-9);
  assert.ok(scriptInkPx(em * 15, 0.2) >= 7 - 1e-6);
  const css = displayFormulaWidthCss(0.48, 0.04, em);
  assert.match(css, /^max\(calc\(var\(--oi-pdf-left-w/);
  assert.doesNotMatch(css, /^min\(100%/);
  assert.match(css, new RegExp(`${em}em`));
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
