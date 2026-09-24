/**
 * Hi-DPI formula crops.
 *
 * The page raster stays at CROP_SCALE so figures, tables, and ink trim keep
 * today's boxes. A formula whose CSS box is larger than that bitmap is
 * redrawn from the PDF, only inside its bbox, at:
 *
 *   pixels = CSS size × devicePixelRatio × FORMULA_RASTER_SLACK
 *
 * The render scale is the next integer multiple of CROP_SCALE that covers
 * those pixels, so the bitmap keeps today's crop aspect and the CSS box
 * does not move. Target is ≥ 1 source pixel per device pixel. The 2× page
 * crop is reused when it already meets that bar. Edge and pixel caps
 * step the multiple back down instead of allocating a canvas that cannot
 * be created.
 */

import { CROP_SCALE, contentColumnShare, displayInkMinEm, rasterCropRect } from "./pdf-blocks.js";
import { FORMULA_INK_PAD_PX, inlineCropBoxEm } from "./pdf-text-layer.js";

/** .oi-pdf-display-math and .oi-pdf-p. Not a layout control. */
export const FORMULA_DISPLAY_FONT_PX = 15;
export const FORMULA_BODY_FONT_PX = 15;
/** .oi-pdf-inline-math .oi-pdf-math-crop max-width. */
export const FORMULA_INLINE_MAX_EM = 12;

/**
 * Small headroom so rounding still leaves at least one source pixel
 * per device pixel. Not an extra sharpness pass.
 */
export const FORMULA_RASTER_SLACK = 1.05;

/** One formula bitmap. Both limits are hard; the scale drops until both hold. */
export const FORMULA_CROP_MAX_EDGE = 4096;
export const FORMULA_CROP_MAX_PIXELS = 4096 * 1024;

/** Same page, same formula, same scale: do not render again. */
export const FORMULA_RASTER_CACHE_LIMIT = 32;

/** Min crop span inside measureFormulaCrop, in CROP_SCALE pixels. */
export const FORMULA_INK_MIN_SPAN = { x: 24, y: 12 };

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function positive(value, fallback) {
  const n = Number(value);
  return n > 0 && Number.isFinite(n) ? n : fallback;
}

/**
 * Smallest scale whose rounded pixel count covers `needPx`.
 * round(pdfUnits × scale) ≥ ceil(needPx).
 */
export function scaleCovering(pdfUnits, needPx) {
  const pdf = finite(pdfUnits);
  const need = Math.ceil(finite(needPx));
  if (!(pdf > 0) || !(need > 0)) return 0;
  let scale = need / pdf;
  if (Math.round(pdf * scale) < need) scale = (need + 0.5) / pdf;
  if (Math.round(pdf * scale) < need) scale = (need + 1) / pdf;
  return scale;
}

/**
 * Largest scale that keeps the crop inside the edge and pixel caps.
 * Non-finite input falls back to CROP_SCALE, then still obeys the caps.
 */
export function capFormulaRasterScale(scale, pdfWidth, pdfHeight, limits = {}) {
  const maxEdge = positive(limits.maxEdge, FORMULA_CROP_MAX_EDGE);
  const maxPixels = positive(limits.maxPixels, FORMULA_CROP_MAX_PIXELS);
  let next = finite(scale);
  if (!(next > 0)) next = CROP_SCALE;
  const w = finite(pdfWidth);
  const h = finite(pdfHeight);
  if (!(w > 0) || !(h > 0)) return Math.min(next, maxEdge);
  const fitEdge = Math.min((maxEdge - 0.5) / w, (maxEdge - 0.5) / h);
  const fitPixels = (Math.sqrt(maxPixels) - 1) / Math.sqrt(w * h);
  next = Math.min(next, fitEdge, Math.max(fitPixels, 0));
  if (!(next > 0) || !Number.isFinite(next)) next = Math.min(CROP_SCALE, fitEdge);
  for (let guard = 0; guard < 6; guard += 1) {
    const pw = Math.max(1, Math.round(w * next));
    const ph = Math.max(1, Math.round(h * next));
    if (pw <= maxEdge && ph <= maxEdge && pw * ph <= maxPixels) return next;
    next *= 0.99;
  }
  return next > 0 && Number.isFinite(next) ? next : Math.min(CROP_SCALE, fitEdge);
}

/**
 * CSS pixel size of the formula image as the right pane lays it out.
 * Mirrors displayCropWidthCss / inlineCropBoxEm. Does not change them.
 * `mirrorZoom` is the paper-stack CSS zoom, which scales the used box.
 */
export function formulaDisplayCssSize({
  block = {},
  bbox = block?.bbox,
  pageWidth,
  pageHeight,
  leftWidth,
  paperWidth,
  paperHeight,
  mirrorZoom = 1,
  bodyFontPx = FORMULA_BODY_FONT_PX,
  displayFontPx = FORMULA_DISPLAY_FONT_PX
} = {}) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const pageW = finite(pageWidth);
  const pageH = finite(pageHeight);
  const leftW = finite(leftWidth);
  const paperW = finite(paperWidth);
  const paperH = finite(paperHeight);
  if (!(pageW > 0) || !(pageH > 0) || !(leftW > 0) || !(paperW > 0) || !(paperH > 0)) return null;
  const fracW = finite(bbox[2]) - finite(bbox[0]);
  const fracH = finite(bbox[3]) - finite(bbox[1]);
  if (!(fracW > 0) || !(fracH > 0)) return null;
  const pdfW = fracW * pageW;
  const pdfH = fracH * pageH;
  const zoom = Math.max(1e-6, finite(mirrorZoom) || 1);
  const inline = block.display === false || Boolean(block.inlineOf);
  const columnW = paperW * contentColumnShare();
  let cssW = 0;
  let cssH = 0;
  if (inline) {
    const font = positive(bodyFontPx, FORMULA_BODY_FONT_PX);
    cssH = inlineCropBoxEm(block.inkShare) * font;
    cssW = cssH * (pdfW / pdfH);
    const maxW = Math.min(columnW, FORMULA_INLINE_MAX_EM * font);
    if (maxW > 0 && cssW > maxW) {
      cssH *= maxW / cssW;
      cssW = maxW;
    }
  } else {
    const font = positive(displayFontPx, FORMULA_DISPLAY_FONT_PX);
    const minEm = displayInkMinEm(block.inkShare);
    const boosted = leftW * fracW;
    const floorW = font * minEm * paperW * fracW / (paperH * fracH);
    cssW = Math.min(columnW, Math.max(boosted, finite(floorW)));
    if (!(cssW > 0)) return null;
    cssH = cssW * (pdfH / pdfW);
  }
  if (!(cssW > 0) || !(cssH > 0)) return null;
  return {
    cssWidth: cssW * zoom,
    cssHeight: cssH * zoom,
    pdfWidth: pdfW,
    pdfHeight: pdfH,
    inline
  };
}

function capMultiplier(multiplier, width, height, maxEdge, maxPixels) {
  let next = Math.max(1, Math.floor(finite(multiplier)));
  const w = Math.max(1, Math.round(finite(width)));
  const h = Math.max(1, Math.round(finite(height)));
  while (next > 1) {
    const pw = w * next;
    const ph = h * next;
    if (pw <= maxEdge && ph <= maxEdge && pw * ph <= maxPixels) return next;
    next -= 1;
  }
  return 1;
}

/**
 * Decide the PDF render scale for one formula bbox.
 * The scale is an integer multiple of CROP_SCALE so the bitmap keeps the
 * same aspect as today's crop and the CSS height does not move.
 * `reusePageRaster` means that 2× crop already has ≥ 1 source pixel per
 * device pixel and fits the caps, so no second render.
 */
export function formulaRasterPlan({
  bbox,
  pageWidth,
  pageHeight,
  rasterWidth,
  rasterHeight,
  cssWidth,
  cssHeight,
  devicePixelRatio = 1,
  slack = FORMULA_RASTER_SLACK,
  maxEdge = FORMULA_CROP_MAX_EDGE,
  maxPixels = FORMULA_CROP_MAX_PIXELS
} = {}) {
  const pageW = finite(pageWidth);
  const pageH = finite(pageHeight);
  const box = Array.isArray(bbox) ? bbox : [];
  const pdfW = (finite(box[2]) - finite(box[0])) * pageW;
  const pdfH = (finite(box[3]) - finite(box[1])) * pageH;
  const dpr = Math.max(1, finite(devicePixelRatio) || 1);
  const margin = positive(slack, FORMULA_RASTER_SLACK);
  const cssW = finite(cssWidth);
  const cssH = finite(cssHeight);
  const edgeCap = positive(maxEdge, FORMULA_CROP_MAX_EDGE);
  const pixelCap = positive(maxPixels, FORMULA_CROP_MAX_PIXELS);
  const rasterW = finite(rasterWidth) > 0 ? finite(rasterWidth) : pageW * CROP_SCALE;
  const rasterH = finite(rasterHeight) > 0 ? finite(rasterHeight) : pageH * CROP_SCALE;
  const crop = (pdfW > 0 && pdfH > 0 && rasterW > 0 && rasterH > 0)
    ? formulaRegionWindow(box, rasterW, rasterH)
    : { offsetX: 0, offsetY: 0, pixelWidth: 0, pixelHeight: 0 };
  const base = {
    scale: CROP_SCALE,
    multiplier: 1,
    rawMultiplier: 1,
    rawScale: CROP_SCALE,
    capped: false,
    reusePageRaster: true,
    devicePixelRatio: dpr,
    slack: margin,
    offsetX: crop.offsetX,
    offsetY: crop.offsetY,
    pixelWidth: crop.pixelWidth,
    pixelHeight: crop.pixelHeight,
    pdfWidth: pdfW,
    pdfHeight: pdfH
  };
  if (!(pdfW > 0) || !(pdfH > 0) || !(cssW > 0) || !(cssH > 0) || !(crop.pixelWidth > 0) || !(crop.pixelHeight > 0)) {
    return base;
  }
  const haveW = crop.pixelWidth;
  const haveH = crop.pixelHeight;
  const withinCap = haveW <= edgeCap && haveH <= edgeCap && haveW * haveH <= pixelCap;
  const covered = withinCap && haveW >= cssW * dpr && haveH >= cssH * dpr;
  const needW = cssW * dpr * margin;
  const needH = cssH * dpr * margin;
  const rawMultiplier = Math.max(1, Math.ceil(needW / haveW), Math.ceil(needH / haveH));
  const multiplier = capMultiplier(rawMultiplier, haveW, haveH, edgeCap, pixelCap);
  const capped = multiplier < rawMultiplier;
  if (covered || multiplier <= 1) {
    return {
      ...base,
      rawMultiplier,
      rawScale: CROP_SCALE * rawMultiplier,
      capped: covered ? false : capped
    };
  }
  return {
    scale: CROP_SCALE * multiplier,
    multiplier,
    rawMultiplier,
    rawScale: CROP_SCALE * rawMultiplier,
    capped,
    reusePageRaster: false,
    devicePixelRatio: dpr,
    slack: margin,
    offsetX: crop.offsetX * multiplier,
    offsetY: crop.offsetY * multiplier,
    pixelWidth: haveW * multiplier,
    pixelHeight: haveH * multiplier,
    pdfWidth: pdfW,
    pdfHeight: pdfH
  };
}

/** Viewport offset that puts the bbox origin at the canvas origin. */
export function formulaRegionWindow(bbox, viewportWidth, viewportHeight) {
  const rect = rasterCropRect(bbox, finite(viewportWidth), finite(viewportHeight));
  return {
    offsetX: rect.sx,
    offsetY: rect.sy,
    pixelWidth: rect.sw,
    pixelHeight: rect.sh
  };
}

/**
 * #62 ink pad expressed in raster pixels at `scale`.
 * PDF user units stay padPx / CROP_SCALE, so the crop box does not move.
 */
export function formulaInkPadPx(padPx, scale, baseScale = CROP_SCALE) {
  const pad = finite(padPx);
  const next = finite(scale);
  const base = finite(baseScale);
  if (!(pad >= 0) || !(next > 0) || !(base > 0)) return Math.max(0, pad);
  return pad * (next / base);
}

/** Options for measureFormulaCrop so a higher raster matches the CROP_SCALE box. */
export function formulaInkMeasureOptions(scale, { inline = false, protect = false, baseScale = CROP_SCALE } = {}) {
  const named = inline
    ? (protect ? FORMULA_INK_PAD_PX.inlineProtect : FORMULA_INK_PAD_PX.inline)
    : (protect ? FORMULA_INK_PAD_PX.displayProtect : FORMULA_INK_PAD_PX.display);
  const ratio = formulaInkPadPx(1, scale, baseScale);
  return {
    inline: Boolean(inline),
    protect: Boolean(protect),
    padPx: named * ratio,
    minSpanX: FORMULA_INK_MIN_SPAN.x * ratio,
    minSpanY: FORMULA_INK_MIN_SPAN.y * ratio
  };
}

export function formulaRasterCacheKey({ docId = "", page = 0, bbox = [], scale = 0, devicePixelRatio = 1 } = {}) {
  const box = (Array.isArray(bbox) ? bbox : []).map((n) => finite(n).toFixed(4)).join(",");
  return `${docId}|${page}|${box}|${finite(scale).toFixed(4)}|${finite(devicePixelRatio).toFixed(3)}`;
}

export function createFormulaRasterCache(limit = FORMULA_RASTER_CACHE_LIMIT) {
  const map = new Map();
  const max = Math.max(1, limit | 0);
  return {
    get size() {
      return map.size;
    },
    get(key) {
      if (!map.has(key)) return "";
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (!key || !value) return;
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    clear() {
      map.clear();
    }
  };
}
