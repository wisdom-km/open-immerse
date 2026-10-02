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

/** F3-S3 hard gate, CSS px at default body size and zoom 100%. */
export const SCRIPT_INK_MIN_PX = 7;
/** F3-S3 target. Under 8 but at least 7 is a hard pass plus a note. */
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
/** Display paint target. Prefer stays 1.4; this hair clears a 1.398 measure. */
export const DISPLAY_INK_PAINT = 1.45;
/**
 * Inline fallback when the left bbox cannot be mapped.
 * A trusted bbox uses the left box instead, even when that box is taller.
 */
export const INLINE_BODY_HARD_MAX = 1.4;
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
 * Paint fallback em. Prefer the ink/script box, but never past
 * DISPLAY_BODY_HARD_MAX (2.5× body). The live display height is the
 * left-pane bbox, not this em.
 */
export function displayFormulaMinEm(inkShare, scriptShare, bodyFs = FORMULA_BODY_FS_PX) {
  const ink = displayInkPaintEm(inkShare);
  const script = scriptMinEm(effectiveScriptShare(scriptShare), bodyFs, SCRIPT_INK_TARGET_PX);
  const em = Math.min(Math.max(ink, script), DISPLAY_BODY_HARD_MAX);
  return Math.round(em * 10000) / 10000;
}

/**
 * Inline crop box. A trusted bbox matches the left pane. Without one, the
 * box stays on the line and stops at INLINE_BODY_HARD_MAX × body.
 */
export function inlineFormulaCssSize({ bbox, pageWidth, pageHeight, paperHeight, bodyFontPx = FORMULA_BODY_FS_PX } = {}) {
  const matched = matchedDisplayCssSize({ bbox, pageWidth, pageHeight, paperHeight });
  if (matched) return { ...matched, source: "bbox" };
  const font = Number(bodyFontPx);
  const cssHeight = (font > 0 && Number.isFinite(font) ? font : FORMULA_BODY_FS_PX) * INLINE_BODY_HARD_MAX;
  return { cssWidth: null, cssHeight, aspect: null, source: "cap" };
}

/**
 * Display formula CSS box before mirror zoom.
 * Height is the bbox's share of the paper. The paper tracks the left page,
 * so this is that page's formula box, scaled uniformly when the pane clamps
 * the paper. Width follows the PDF aspect (height-driven).
 */
export function matchedDisplayCssSize({ bbox, pageWidth, pageHeight, paperHeight } = {}) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const fracW = Number(bbox[2]) - Number(bbox[0]);
  const fracH = Number(bbox[3]) - Number(bbox[1]);
  const pageW = Number(pageWidth);
  const pageH = Number(pageHeight);
  const paperH = Number(paperHeight);
  if (!(fracW > 0) || !(fracH > 0) || !(pageW > 0) || !(pageH > 0) || !(paperH > 0)) return null;
  const cssHeight = fracH * paperH;
  const cssWidth = cssHeight * ((fracW * pageW) / (fracH * pageH));
  if (!(cssWidth > 0) || !(cssHeight > 0) || !Number.isFinite(cssWidth) || !Number.isFinite(cssHeight)) return null;
  return { cssWidth, cssHeight, aspect: cssWidth / cssHeight };
}

function displayInkPaintEm(inkShare) {
  const base = displayInkMinEm(inkShare);
  const share = Number(inkShare);
  if (!(share > 0.2) || share > 1 || !Number.isFinite(share)) return base;
  const paint = DISPLAY_INK_PAINT / share;
  return Math.max(base, paint);
}

/** Source body when the text layer has no trusted sample. SPEC §6.2 uses 10pt. */
export const READER_SOURCE_BODY_PT = 10;
/** SPEC §6.5. An inline crop that stays inline always paints at this k. */
export const INLINE_CROP_K = 1.35;
/** F3 prefer / hard gate, as a multiple of the body px/pt. */
export const DISPLAY_INK_PREFER = 1.4;
export const DISPLAY_INK_HARD = 1.0;
/** Local line box cap. 2.2em is 35.2px at the 16px step. */
export const INLINE_LINE_BOX_EM = 2.2;

/** Body px per source pt. 16px on a 10pt body is 1.6. */
export function readerBodyScale(bodyFontPx, sourceBodyPt = READER_SOURCE_BODY_PT) {
  const font = Number(bodyFontPx);
  const pt = Number(sourceBodyPt);
  if (!(font > 0) || !(pt > 0)) return 0;
  return font / pt;
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
 * Reading-pane formula box from the current font step.
 * Display prefers 1.4× the body px/pt and never drops under 1.0×.
 * Wider than the column: shrink toward the hard gate, then scroll.
 * Inline crops paint at k=1.35 at every font size. After that scale, ink
 * taller than 2.2em, a subscript under 7px, or a crop wider than the column
 * is raised to a display crop (1.45×, then the same width rule). Nothing
 * that stays inline is scaled below k.
 */
export function readerFormulaCssSize({
  bodyFontPx,
  sourceBodyPt = READER_SOURCE_BODY_PT,
  inkPt,
  widthPt,
  scriptPt = 0,
  columnPx = 0,
  inline = false
} = {}) {
  const font = Number(bodyFontPx);
  const sBody = readerBodyScale(font, sourceBodyPt);
  const ink = Number(inkPt);
  const width = Number(widthPt);
  if (!(sBody > 0) || !(ink > 0) || !(font > 0)) return null;
  const script = Number(scriptPt) > 0 ? Number(scriptPt) : 0;
  const column = Number(columnPx) > 0 ? Number(columnPx) : 0;
  const lineCapPx = INLINE_LINE_BOX_EM * font;
  const raise = inline && inlineCropRaises({ sBody, ink, script, width, column, lineCapPx });
  if (inline && !raise) {
    return formulaScaleBox({
      sBody,
      k: INLINE_CROP_K,
      ink,
      width,
      script,
      column: 0,
      lineCapPx,
      inline: true,
      raised: false
    });
  }
  const prefer = raise ? DISPLAY_INK_PAINT : DISPLAY_INK_PREFER;
  let k = prefer;
  if (width > 0 && column > 0) {
    const fit = column / (width * sBody);
    if (fit < k) k = Math.max(DISPLAY_INK_HARD, fit);
  }
  return formulaScaleBox({
    sBody,
    k,
    ink,
    width,
    script,
    column,
    lineCapPx,
    inline: false,
    raised: raise
  });
}

function inlineCropRaises({ sBody, ink, script, width, column, lineCapPx }) {
  const s = sBody * INLINE_CROP_K;
  const inkPx = ink * s;
  const scriptPx = script > 0 ? script * s : null;
  const cssWidth = width > 0 ? width * s : 0;
  if (inkPx > lineCapPx + 1e-6) return true;
  if (scriptPx != null && scriptPx < SCRIPT_INK_MIN_PX - 1e-9) return true;
  return cssWidth > 0 && column > 0 && cssWidth > column + 0.5;
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
