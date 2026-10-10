/**
 * Hi-DPI crops for formulas, figures, and tables.
 *
 * The page raster stays at CROP_SCALE so ink trim keeps today's boxes.
 * A visual whose CSS box × devicePixelRatio × FORMULA_RASTER_SLACK is
 * larger than that bitmap is redrawn from the same PDF page, only inside
 * its bbox, at:
 *
 *   pixels = CSS size × devicePixelRatio × FORMULA_RASTER_SLACK
 *
 * The render scale is the next integer multiple of CROP_SCALE that covers
 * those pixels, so the bitmap keeps today's crop aspect and the CSS box
 * does not move. The 2× page crop is reused when it already meets that
 * bar. Edge and pixel caps step the multiple back down instead of
 * allocating a canvas that cannot be created.
 */

import { CROP_SCALE, contentColumnShare, rasterCropRect } from "./pdf-blocks.js";
import {
  formulaScriptPt,
  readerFormulaCssSize
} from "./pdf-formula-size.js";
import { FORMULA_INK_PAD_PX } from "./pdf-text-layer.js";

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
 * CSS pixel size of the formula image.
 * 1 CSS px per PDF point of the page. The left pane, the paper, and zoom
 * do not scale the box. When a reader font and column are known, a formula
 * wider than the column shrinks to the readability floor.
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
  readerFontPx = 0,
  sourceBodyPt = 0,
  columnPx = 0
} = {}) {
  void leftWidth;
  void paperWidth;
  void paperHeight;
  void mirrorZoom;
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const pageW = finite(pageWidth);
  const pageH = finite(pageHeight);
  if (!(pageW > 0) || !(pageH > 0)) return null;
  const fracW = finite(bbox[2]) - finite(bbox[0]);
  const fracH = finite(bbox[3]) - finite(bbox[1]);
  if (!(fracW > 0) || !(fracH > 0)) return null;
  const pdfW = fracW * pageW;
  const pdfH = fracH * pageH;
  if (!(pdfW > 0) || !(pdfH > 0)) return null;
  const inline = block.display === false || Boolean(block.inlineOf);
  const readerFont = finite(readerFontPx);
  if (readerFont > 0) {
    const sized = readerFormulaCssSize({
      bodyFontPx: readerFont,
      sourceBodyPt: positive(sourceBodyPt, 10),
      inkPt: pdfH,
      widthPt: pdfW,
      scriptPt: formulaScriptPt(block, pdfH),
      columnPx: finite(columnPx) || 0,
      inline
    });
    if (!sized || !(sized.cssHeight > 0)) return null;
    return {
      cssWidth: sized.cssWidth || 0,
      cssHeight: sized.cssHeight,
      pdfWidth: pdfW,
      pdfHeight: pdfH,
      inline: Boolean(sized.inline) && !sized.raised
    };
  }
  return {
    cssWidth: pdfW,
    cssHeight: pdfH,
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
 * Decide the PDF render scale for one formula, figure, or table bbox.
 * The scale is an integer multiple of CROP_SCALE so the bitmap keeps the
 * same aspect as today's crop and the CSS height does not move.
 * `reusePageRaster` means that 2× crop already covers
 * CSS × devicePixelRatio × slack and fits the caps, so no second render.
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
  const needW = cssW * dpr * margin;
  const needH = cssH * dpr * margin;
  const covered = withinCap
    && haveW >= Math.ceil(needW - 1e-9)
    && haveH >= Math.ceil(needH - 1e-9);
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

/**
 * Device-pixel redraw for one formula. cssWidth/cssHeight are the layout box
 * before mirror zoom. targetPx = round(cssH × mirrorZoom × DPR). Scale may be
 * fractional. CSS snaps back onto that pixel grid so the bitmap is 1:1.
 * Figure and table plans stay on formulaRasterPlan.
 */
export function formulaDevicePixels({
  cssWidth,
  cssHeight,
  pdfWidth,
  pdfHeight,
  mirrorZoom = 1,
  devicePixelRatio = 1,
  maxEdge = FORMULA_CROP_MAX_EDGE,
  maxPixels = FORMULA_CROP_MAX_PIXELS
} = {}) {
  const zoom = Math.max(1e-6, finite(mirrorZoom) || 1);
  const dpr = Math.max(1, finite(devicePixelRatio) || 1);
  const cssW = finite(cssWidth);
  const cssH = finite(cssHeight);
  const pdfW = finite(pdfWidth) > 0 ? finite(pdfWidth) : cssW;
  const pdfH = finite(pdfHeight) > 0 ? finite(pdfHeight) : cssH;
  if (!(cssW > 0) || !(cssH > 0) || !(pdfW > 0) || !(pdfH > 0)) return null;
  const edge = positive(maxEdge, FORMULA_CROP_MAX_EDGE);
  const pixels = positive(maxPixels, FORMULA_CROP_MAX_PIXELS);
  let targetH = Math.max(1, Math.round(cssH * zoom * dpr));
  let scale = targetH / pdfH;
  const fit = Math.min(edge / pdfW, edge / pdfH, Math.sqrt(pixels / (pdfW * pdfH)));
  if (Number.isFinite(fit) && fit > 0 && scale > fit) {
    scale = fit;
    targetH = Math.max(1, Math.round(pdfH * scale));
  }
  const targetW = Math.max(1, Math.round(pdfW * scale));
  scale = targetH / pdfH;
  return {
    targetPx: targetH,
    scale,
    pixelWidth: targetW,
    pixelHeight: targetH,
    cssWidth: targetW / (dpr * zoom),
    cssHeight: targetH / (dpr * zoom),
    devicePixelRatio: dpr,
    mirrorZoom: zoom,
    reusePageRaster: false,
    multiplier: 1
  };
}

/**
 * Snap a formula onto the device-pixel grid, then keep the snapped width
 * inside the live column. Rounding the height up at a wide aspect (about
 * 16:1) otherwise pushes the width past the host. Height steps down by one
 * device pixel. A box that was already wider than the column before the snap
 * is left alone so a 1.0× overflow can still scroll.
 */
export function fitSnappedFormulaCss({
  cssWidth,
  cssHeight,
  columnPx = 0,
  mirrorZoom = 1,
  devicePixelRatio = 1
} = {}) {
  const snapped = formulaDevicePixels({
    cssWidth,
    cssHeight,
    pdfWidth: cssWidth,
    pdfHeight: cssHeight,
    mirrorZoom,
    devicePixelRatio
  });
  if (!snapped) return null;
  const column = Number(columnPx);
  const before = Number(cssWidth);
  if (!(column > 0) || !(snapped.cssWidth > column) || before > column + 0.5) return snapped;
  const zoom = Math.max(1e-6, finite(mirrorZoom) || 1);
  const dpr = Math.max(1, finite(devicePixelRatio) || 1);
  const cssH = finite(cssHeight);
  const cssW = finite(cssWidth);
  let targetH = snapped.pixelHeight;
  let targetW = snapped.pixelWidth;
  while (targetH > 1 && targetW / (dpr * zoom) > column) {
    targetH -= 1;
    targetW = Math.max(1, Math.round(cssW * (targetH / cssH)));
  }
  return {
    ...snapped,
    targetPx: targetH,
    scale: targetH / cssH,
    pixelWidth: targetW,
    pixelHeight: targetH,
    cssWidth: targetW / (dpr * zoom),
    cssHeight: targetH / (dpr * zoom)
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

const SOURCE_REDRAW_LABELS = new Set(["formula", "figure", "table"]);

/** Formula, figure, and table images share one redraw quality bar. */
export function isSourceRedrawBlock(block) {
  return SOURCE_REDRAW_LABELS.has(block?.label);
}

const VISUAL_INK_LUMA = 245;
const VISUAL_REDRAW_INK_FLOOR = 0.45;
const VISUAL_CROP_EMPTY_INK = 0.012;
const VISUAL_CROP_EMPTY_AREA = 0.02;

/** Share of sampled pixels that are not paper-white. Null when the bitmap is missing. */
export function imageInkRatio(image) {
  const data = image?.data;
  const width = Number(image?.width) || 0;
  const height = Number(image?.height) || 0;
  if (!data || width < 1 || height < 1) return null;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 8000)));
  let seen = 0;
  let ink = 0;
  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < width; x += step) {
      const i = (row + x) * 4;
      seen += 1;
      if (data[i + 3] < 16) continue;
      if (data[i] < VISUAL_INK_LUMA || data[i + 1] < VISUAL_INK_LUMA || data[i + 2] < VISUAL_INK_LUMA) ink += 1;
    }
  }
  return seen ? ink / seen : null;
}

/**
 * Keep a figure/table redraw only when it is not much emptier than the page crop.
 * A missing measurement accepts the redraw. A redraw of the page corner is rejected.
 */
export function acceptVisualRedraw(redrawRatio, pageRatio) {
  if (redrawRatio == null || !Number.isFinite(redrawRatio)) return true;
  if (pageRatio == null || !Number.isFinite(pageRatio)) return redrawRatio >= 0.02;
  if (pageRatio < 0.02) return redrawRatio + 0.015 >= pageRatio;
  return redrawRatio >= pageRatio * VISUAL_REDRAW_INK_FLOOR;
}

/** A large figure or table crop with almost no ink is a failed crop, not a diagram. */
export function pageCropLooksEmpty(pageRatio, bbox) {
  if (pageRatio == null || !Number.isFinite(pageRatio)) return false;
  const box = Array.isArray(bbox) ? bbox : [];
  const width = Number(box[2]) - Number(box[0]);
  const height = Number(box[3]) - Number(box[1]);
  if (!(width > 0) || !(height > 0) || width * height < VISUAL_CROP_EMPTY_AREA) return false;
  return pageRatio < VISUAL_CROP_EMPTY_INK;
}

/**
 * CSS pixel size of a figure or table as the right pane lays it out.
 * The page-raster crop is the intrinsic size. max-width: 100% caps it at
 * the padded column. height stays auto, so the box is never stretched.
 * `layoutCapPx` is that intrinsic width before mirror zoom, used to stop
 * a sharper bitmap from growing the figure.
 */
export function assetDisplayCssSize({
  block = {},
  bbox = block?.bbox,
  pageWidth,
  pageHeight,
  paperWidth,
  rasterWidth,
  rasterHeight,
  mirrorZoom = 1
} = {}) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const pageW = finite(pageWidth);
  const pageH = finite(pageHeight);
  if (!(pageW > 0) || !(pageH > 0)) return null;
  const fracW = finite(bbox[2]) - finite(bbox[0]);
  const fracH = finite(bbox[3]) - finite(bbox[1]);
  if (!(fracW > 0) || !(fracH > 0)) return null;
  const rasterW = finite(rasterWidth) > 0 ? finite(rasterWidth) : pageW * CROP_SCALE;
  const rasterH = finite(rasterHeight) > 0 ? finite(rasterHeight) : pageH * CROP_SCALE;
  const crop = formulaRegionWindow(bbox, rasterW, rasterH);
  if (!(crop.pixelWidth > 0) || !(crop.pixelHeight > 0)) return null;
  const paperW = finite(paperWidth);
  const column = paperW > 0 ? paperW * contentColumnShare() : 0;
  let cssW = crop.pixelWidth;
  let cssH = crop.pixelHeight;
  if (column > 0 && cssW > column) {
    cssW = column;
    cssH = cssW * (crop.pixelHeight / crop.pixelWidth);
  }
  if (!(cssW > 0) || !(cssH > 0)) return null;
  const zoom = Math.max(1e-6, finite(mirrorZoom) || 1);
  return {
    cssWidth: cssW * zoom,
    cssHeight: cssH * zoom,
    layoutCapPx: crop.pixelWidth,
    pdfWidth: fracW * pageW,
    pdfHeight: fracH * pageH,
    inline: false
  };
}

/**
 * CSS box for one right-pane visual. Formulas keep formulaDisplayCssSize.
 * Figures and tables use the column-capped page-raster crop.
 */
export function visualDisplayCssSize(args = {}) {
  const label = args.block?.label;
  if (label === "figure" || label === "table") return assetDisplayCssSize(args);
  return formulaDisplayCssSize(args);
}

/** Page-raster crop width in CSS pixels. A sharper bitmap must not exceed it. */
export function assetLayoutCapPx(bbox, rasterWidth, rasterHeight) {
  const crop = formulaRegionWindow(bbox, rasterWidth, rasterHeight);
  return crop.pixelWidth > 0 && crop.pixelHeight > 0 ? crop.pixelWidth : 0;
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
