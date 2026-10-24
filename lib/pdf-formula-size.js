/**
 * Tip F3 display-side sizing.
 * Layout width + height:auto only. No transform:scale. No CROP_SCALE change.
 */

import { DISPLAY_BODY_HARD_MAX, DISPLAY_CROP_MIN_HEIGHT_EM, displayInkMinEm } from "./pdf-blocks.js";
import {
  INLINE_INK_STRONG_HI,
  INLINE_INK_TARGET,
  INLINE_LINE_BOX_HI,
  inlineCropBoxEm,
  inlineLineTopEm
} from "./pdf-text-layer.js";

/** F3-S3 paint target for a script glyph, in CSS px. */
export const SCRIPT_INK_TARGET_PX = 8;
/**
 * PDF glyph height / crop height overstates dark script ink.
 * Anvil 324e4fc: font-box sizing that "cleared" 7px still measured
 * F01 6.51, F04 6.29, F06 5.48, F09 6.5. Treat the share as this
 * fraction of the font box so the painted ink can clear 7.
 */
export const SCRIPT_SHARE_SAFETY = 0.5;
/**
 * Anvil 2daa243: a font-box share at or above ~0.28 left seven inlines under
 * 7px (worst dark share ≈ 0.11). Shares outside [LOW, HIGH] are that
 * overestimate, so they use DEFAULT. 0.24 × safety 0.5 paints cssH ≈ 67,
 * which clears 7px at a 0.11 dark share.
 */
export const SCRIPT_SHARE_LOW = 0.28;
export const SCRIPT_SHARE_HIGH = 0.4;
export const SCRIPT_SHARE_DEFAULT = 0.24;
/** F3-S2 hard gate: |sx/sy − 1|. */
export const UNIFORM_SCALE_TOL = 0.02;
/** F3-S6 CJK side gap. Midpoint of the locked 0.15–0.25em band. */
export const INLINE_SIDE_GAP_EM = 0.2;
export const FORMULA_BODY_FS_PX = 15;

export function uniformScaleDelta(cssW, cssH, natW, natH) {
  const cw = Number(cssW);
  const ch = Number(cssH);
  const nw = Number(natW);
  const nh = Number(natH);
  if (!(cw > 0) || !(ch > 0) || !(nw > 0) || !(nh > 0)) return Infinity;
  const sx = cw / nw;
  const sy = ch / nh;
  if (!(sy > 0)) return Infinity;
  return Math.abs(sx / sy - 1);
}

export function uniformScaleOk(cssW, cssH, natW, natH, tol = UNIFORM_SCALE_TOL) {
  return uniformScaleDelta(cssW, cssH, natW, natH) <= tol + 1e-9;
}

/** CSS px of the shortest script glyph once the crop is `cssH` tall. */
export function scriptInkPx(cssH, scriptShare) {
  const share = Number(scriptShare);
  const height = Number(cssH);
  if (!(share > 0) || share > 1 || !(height > 0)) return null;
  return height * share;
}

/**
 * em box so the dark script ink can clear the 8px paint target.
 * The hard gate remains 7. 0 when the crop has no script.
 */
export function scriptMinEm(scriptShare, bodyFs = FORMULA_BODY_FS_PX, minPx = SCRIPT_INK_TARGET_PX) {
  const raw = Number(scriptShare);
  const font = Number(bodyFs);
  const gate = Number(minPx);
  const share = raw * SCRIPT_SHARE_SAFETY;
  if (!(raw > 0) || raw > 1 || !(share > 0) || !(font > 0) || !(gate > 0)) return 0;
  return Math.ceil((gate / (share * font)) * 10000) / 10000;
}

/**
 * Keep a share only inside [LOW, HIGH]. Missing, tiny, and font-box-high
 * values all use DEFAULT so the paint box actually grows.
 */
export function effectiveScriptShare(scriptShare) {
  const raw = Number(scriptShare);
  if (!(raw >= SCRIPT_SHARE_LOW) || raw > SCRIPT_SHARE_HIGH) return SCRIPT_SHARE_DEFAULT;
  return raw;
}

/**
 * Inline crop em. Ink stays on the 1.30 target. A missing script share uses
 * the conservative default so an F09-class subscript can clear 7px.
 * A box over ~2.2em, or an ink ratio above the 1.35 prefer cap, becomes
 * display instead of a fatter inline.
 */
export function inlinePaintBox(inkShare, scriptShare, bodyFs = FORMULA_BODY_FS_PX) {
  const inkBox = inlineCropBoxEm(inkShare, INLINE_INK_TARGET);
  const scriptBox = scriptMinEm(effectiveScriptShare(scriptShare), bodyFs, SCRIPT_INK_TARGET_PX);
  const box = Math.round(Math.max(inkBox, scriptBox) * 10000) / 10000;
  const line = scriptBox > inkBox + 1e-9 ? box : inlineLineTopEm(inkShare, INLINE_INK_TARGET);
  const inkRatio = inkBox > 0 ? INLINE_INK_TARGET * (box / inkBox) : INLINE_INK_TARGET;
  const promote = box > INLINE_LINE_BOX_HI + 1e-9 || inkRatio > INLINE_INK_STRONG_HI + 1e-9;
  return { box, line: Math.round(line * 10000) / 10000, promote };
}

/** F3-S3 / F3-S6: a line box over ~2.2em becomes display instead of squashing. */
export function inlinePromotesToDisplay(inkShare, scriptShare, bodyFs = FORMULA_BODY_FS_PX) {
  return inlinePaintBox(inkShare, scriptShare, bodyFs).promote;
}

/**
 * Em helper for a display crop that has no page box. Prefer the ink/script
 * box, but never past DISPLAY_BODY_HARD_MAX (2.5× body). displayInkMinEm
 * still feeds this helper. The viewer does not call it: the live crop is
 * PDF pt × (reference px / source pt), not this em and not a 1.4× magnification.
 */
export function displayFormulaMinEm(inkShare, scriptShare, bodyFs = FORMULA_BODY_FS_PX) {
  const ink = displayInkMinEm(inkShare);
  const script = scriptMinEm(effectiveScriptShare(scriptShare), bodyFs, SCRIPT_INK_TARGET_PX);
  const em = Math.min(Math.max(ink, script), DISPLAY_BODY_HARD_MAX);
  return Math.round(em * 10000) / 10000;
}

/**
 * Inline crop box at the page glyph size. 1 CSS px per PDF point.
 * Without a bbox there is no page size to match, so the caller keeps the
 * CSS default instead of a font-scaled box.
 */
export function inlineFormulaCssSize({ bbox, pageWidth, pageHeight } = {}) {
  const matched = matchedDisplayCssSize({ bbox, pageWidth, pageHeight });
  if (!matched) return null;
  return { ...matched, source: "bbox" };
}

/**
 * Formula CSS box at the PDF page's glyph size.
 * 1 CSS px per PDF point. Paper height, the left pane, and zoom do not scale it.
 */
export function matchedDisplayCssSize({ bbox, pageWidth, pageHeight } = {}) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const fracW = Number(bbox[2]) - Number(bbox[0]);
  const fracH = Number(bbox[3]) - Number(bbox[1]);
  const pageW = Number(pageWidth);
  const pageH = Number(pageHeight);
  if (!(fracW > 0) || !(fracH > 0) || !(pageW > 0) || !(pageH > 0)) return null;
  const cssWidth = fracW * pageW;
  const cssHeight = fracH * pageH;
  if (!(cssWidth > 0) || !(cssHeight > 0) || !Number.isFinite(cssWidth) || !Number.isFinite(cssHeight)) return null;
  return { cssWidth, cssHeight, aspect: cssWidth / cssHeight };
}

/** Source body when the text layer has no trusted sample. SPEC §6.2 uses 10pt. */
export const READER_SOURCE_BODY_PT = 10;
/**
 * Fixed crop reference size. Inline, short, and display crops share it.
 * It does not follow the Aa slider. arXiv KaTeX stays on em.
 */
export const FORMULA_REF_SIZE_PX = 18;
/** Page glyph size in CSS px per PDF point. pdf.js scale 1 is 1px per point. */
export const FORMULA_NATIVE_SCALE = 1;
/**
 * Lowest uniform scale of a crop, as a fraction of the reference size.
 * 0.75 × 18px = 13.5px of body em. Wider formulas stop here and scroll.
 */
export const FORMULA_REF_SHRINK = 0.75;
/**
 * Legacy name for the 0.75 fraction. The live floor is FORMULA_REF_SHRINK
 * times the reference scale, not 0.75 CSS px per PDF point.
 */
export const FORMULA_SHRINK_FLOOR = FORMULA_REF_SHRINK;
export const BODY_X_HEIGHT_RATIO = 0.48;
/** Inline crop cap, in em of the reference size. 12 × 18px = 216px. */
export const FORMULA_INLINE_MAX_EM = 12;
/** Rounding room so a fitted formula stays inside the live scrollport. */
export const FORMULA_FIT_SLACK = 2;
/** Line box cap in em of the reference size, not the Aa size. 2.2 × 18 = 39.6px. */
export const INLINE_LINE_BOX_EM = 2.2;

/** CSS px per PDF point that paints body em at the reference size. 18/10 = 1.8. */
export function formulaRefScale(sourceBodyPt = READER_SOURCE_BODY_PT, refPx = FORMULA_REF_SIZE_PX) {
  const pt = Number(sourceBodyPt) > 0 && Number.isFinite(Number(sourceBodyPt))
    ? Number(sourceBodyPt)
    : READER_SOURCE_BODY_PT;
  const ref = Number(refPx) > 0 && Number.isFinite(Number(refPx)) ? Number(refPx) : FORMULA_REF_SIZE_PX;
  return ref / pt;
}

/** Smallest scale that still paints body em at 0.75 × the reference size. */
export function formulaRefFloorScale(sourceBodyPt = READER_SOURCE_BODY_PT, refPx = FORMULA_REF_SIZE_PX) {
  return formulaRefScale(sourceBodyPt, refPx) * FORMULA_REF_SHRINK;
}

/**
 * Scrollport for one display formula. The flow width is the column; a reader
 * equation number and its gap sit beside the crop and are not part of the box.
 */
export function displayFormulaColumnPx({ flowPx = 0, eqNumPx = 0, gapPx = 0 } = {}) {
  const flow = Number(flowPx);
  if (!(flow > 0)) return 0;
  const num = Number(eqNumPx) > 0 ? Number(eqNumPx) : 0;
  const gap = num > 0 && Number(gapPx) > 0 ? Number(gapPx) : 0;
  return Math.max(0, flow - num - gap);
}

/** Body px per source pt. 16px on a 10pt body is 1.6. */
export function readerBodyScale(bodyFontPx, sourceBodyPt = READER_SOURCE_BODY_PT) {
  const font = Number(bodyFontPx);
  const pt = Number(sourceBodyPt);
  if (!(font > 0) || !(pt > 0)) return 0;
  return font / pt;
}

/**
 * Legacy shrink limit relative to 1 CSS px per PDF point.
 * Live crops use formulaRefFloorScale, which does not read the Aa size.
 * 0.75× native, or the scale that holds a body-sized page glyph at the
 * reader x-height, whichever is larger. Never above native size.
 */
export function formulaReadabilityFloor(bodyFontPx, glyphPx = READER_SOURCE_BODY_PT) {
  const font = Number(bodyFontPx);
  const glyph = Number(glyphPx);
  let floor = FORMULA_SHRINK_FLOOR;
  if (font > 0 && glyph > 0) floor = Math.max(floor, (font * BODY_X_HEIGHT_RATIO) / glyph);
  if (!(floor > 0)) return FORMULA_SHRINK_FLOOR;
  return Math.round(Math.min(FORMULA_NATIVE_SCALE, floor) * 10000) / 10000;
}

/**
 * Subscript height in source pt. A share above half the crop is the old
 * font-box estimate, not a subscript, so it does not drive promotion.
 */
export function formulaScriptPt(block, inkPt) {
  const direct = Number(block?.scriptPt ?? block?.scriptInkPt);
  if (direct > 0 && Number.isFinite(direct)) return direct;
  const share = Number(block?.scriptShare);
  const ink = Number(inkPt);
  if (share > 0 && share <= 0.5 && ink > 0) return share * ink;
  return 0;
}

/**
 * Reading-pane crop at the fixed reference size.
 * k = R / f. CSS px = PDF pt × k. Aa (`bodyFontPx`) does not enter k, the
 * shrink floor, or the inline line cap. A display crop wider than the column
 * shrinks uniformly down to 0.75R, then scrolls. An inline crop wider than
 * 12em of R does the same. An inline taller than 2.2R is raised onto the
 * column rule. The line box itself stays on the CSS negative-margin cap.
 */
export function readerFormulaCssSize({
  bodyFontPx,
  sourceBodyPt = READER_SOURCE_BODY_PT,
  inkPt,
  widthPt,
  scriptPt = 0,
  columnPx = 0,
  inline = false,
  refPx = FORMULA_REF_SIZE_PX
} = {}) {
  void bodyFontPx;
  const ref = Number(refPx) > 0 && Number.isFinite(Number(refPx)) ? Number(refPx) : FORMULA_REF_SIZE_PX;
  const ink = Number(inkPt);
  const width = Number(widthPt);
  const glyph = Number(sourceBodyPt) > 0 ? Number(sourceBodyPt) : READER_SOURCE_BODY_PT;
  if (!(ink > 0) || !(glyph > 0)) return null;
  const script = Number(scriptPt) > 0 ? Number(scriptPt) : 0;
  const column = Number(columnPx) > 0 ? Number(columnPx) : 0;
  const kRef = formulaRefScale(glyph, ref);
  const kFloor = kRef * FORMULA_REF_SHRINK;
  const lineCapPx = INLINE_LINE_BOX_EM * ref;
  const raise = inline && ink * kRef > lineCapPx + 1e-6;
  const inlineMax = FORMULA_INLINE_MAX_EM * ref;
  let budget = 0;
  if (inline && !raise) {
    budget = inlineMax;
    if (column > 0) budget = Math.min(budget, Math.max(0, column - FORMULA_FIT_SLACK));
  } else if (column > 0) {
    budget = Math.max(0, column - FORMULA_FIT_SLACK);
  }
  let k = kRef;
  if (width > 0 && budget > 0) {
    const fit = budget / width;
    if (fit < k) k = Math.max(kFloor, fit);
  }
  return formulaScaleBox({
    sBody: 1,
    k,
    ink,
    width,
    script,
    column: budget,
    lineCapPx,
    inline: inline && !raise,
    raised: raise
  });
}

/** Display placeholder floor. Column width still wins in CSS. */
export const PH_DISPLAY_MIN_W = 112;
export const PH_DISPLAY_MIN_H = 32;
/** Inline placeholder floor. The 24px hit target is a ::before, not the box. */
export const PH_INLINE_MIN_W = 20;
export const PH_INLINE_MIN_H = 16;

function placeholderCssNumber(value) {
  const n = Math.round(Number(value) * 10000) / 10000;
  return String(n);
}

/** Same rounding displayFormulaWidthCss uses for a px length. */
export function placeholderCssLength(value) {
  const n = Number(value);
  if (!(n > 0) || !Number.isFinite(n)) return "";
  return `${placeholderCssNumber(n)}px`;
}

/**
 * Native placeholder box. 1 CSS px per PDF point. Placeholders are not
 * crops, so they do not take the reference-size scale. Do not apply ×4/3.
 * Returns null when the bbox or the page size is missing.
 */
export function placeholderNativeBox({ bbox, pageWidth, pageHeight } = {}) {
  const matched = matchedDisplayCssSize({ bbox, pageWidth, pageHeight });
  if (!matched) return null;
  return { w: matched.cssWidth, h: matched.cssHeight };
}

/**
 * Used box after the placeholder CSS clamps.
 * Width is min(column, max(minW, w0)). Growing up to the minimum does not
 * scale height. Shrinking below w0 scales height, then the minimum height
 * still wins.
 */
export function placeholderUsedBox({ w0, h0, column = 0, inline = false } = {}) {
  const minW = inline ? PH_INLINE_MIN_W : PH_DISPLAY_MIN_W;
  const minH = inline ? PH_INLINE_MIN_H : PH_DISPLAY_MIN_H;
  const nativeW = Number(w0) > 0 && Number.isFinite(Number(w0)) ? Number(w0) : minW;
  const nativeH = Number(h0) > 0 && Number.isFinite(Number(h0)) ? Number(h0) : minH;
  let w = Math.max(minW, nativeW);
  const col = Number(column);
  if (col > 0 && Number.isFinite(col)) w = Math.min(col, w);
  let h = Math.max(minH, nativeH);
  if (!inline && w + 1e-6 < nativeW) h = Math.max(minH, nativeH * (w / nativeW));
  return { w, h };
}

function formulaScaleBox({ sBody, k, ink, width, script, column, lineCapPx, inline, raised }) {
  const scale = sBody * k;
  const cssHeight = ink * scale;
  const cssWidth = width > 0 ? width * scale : null;
  const scriptPx = script > 0 ? script * scale : null;
  return {
    k: Math.round(k * 10000) / 10000,
    cssHeight,
    cssWidth,
    aspect: cssWidth > 0 && cssHeight > 0 ? cssWidth / cssHeight : null,
    inline,
    raised,
    scrolls: Boolean(cssWidth > 0 && column > 0 && cssWidth > column + 0.5),
    inkPx: cssHeight,
    scriptPx,
    lineCapPx
  };
}
