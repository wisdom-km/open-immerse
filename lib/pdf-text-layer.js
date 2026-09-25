/** Text-layer fallback: body sentences from the PDF text layer, formulas and figures as page crops. */

import { CROP_SCALE, PROTOCOL, preparePageBlocks, textLayerTrust } from "./pdf-blocks.js";
import { formatPlaintextRelation, plaintextRelationParts } from "./pdf-plaintext-formula.js";
import {
  fontNameForFormula,
  hasMathUnicode,
  imageRectsFromUnitCtms,
  isMathFontName,
  looksLikeCaption,
  looksLikeFormulaItem,
  walkImageCtms
} from "./pdf-mirror.js";
import { isPageChromeItem, looksLikeAuthorLine } from "./pdf-readout.js";
import { authorNameFromLine } from "./pdf-structure-schema.js";
import { paragraphsFromLines, readingOrderLines } from "./pdf-viewer.js";

const FORMULA_WORD = /^(softmax|layernorm|attention|multihead|concat|ffn|head|where|sqrt|exp|log|sin|cos|tan|max|min)$/i;
const FORMULA_WORDS = new Set([
  "softmax",
  "LayerNorm",
  "Attention",
  "MultiHead",
  "Concat",
  "FFN",
  "head",
  "where",
  "exp",
  "log",
  "sin",
  "cos",
  "tan",
  "max",
  "min"
]);

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function unionBbox(boxes) {
  const list = (boxes || []).filter((box) => Array.isArray(box) && box.length >= 4);
  if (!list.length) return null;
  return [
    Math.min(...list.map((box) => box[0])),
    Math.min(...list.map((box) => box[1])),
    Math.max(...list.map((box) => box[2])),
    Math.max(...list.map((box) => box[3]))
  ];
}

function padBbox(bbox, padX, padY = padX) {
  if (!bbox) return null;
  return [
    clamp01(bbox[0] - padX),
    clamp01(bbox[1] - padY),
    clamp01(bbox[2] + padX),
    clamp01(bbox[3] + padY)
  ];
}

/**
 * Hairline around the glyph union. Script/delimiter runs may add scriptX/scriptY.
 * Inline is tighter than display. This is not a whole-line inflate:
 * contentAwareFormulaBbox stops at neighboring glyphs, captions, and figure/table regions.
 * At crop scale 2 on a 612×792 page, 0.0060 × 612 × 2 ≈ 7.3 CSS px
 * and 0.0050 × 792 × 2 ≈ 7.9 CSS px (still under ~8).
 */
export const FORMULA_CROP_PAD = {
  displayX: 0.0045,
  displayY: 0.0030,
  inlineX: 0.0020,
  inlineY: 0.0016,
  scriptX: 0.0012,
  scriptY: 0.0016
};

/** Hard ceiling. About 7–8 CSS px at crop scale 2 (612×792), still under ~8. */
export const FORMULA_PAD_LIMIT = { x: 0.0060, y: 0.0050 };

/**
 * A pixel is paper when every channel is at least this value.
 * Antialiased strokes and gray subscripts stay darker and count as ink.
 */
export const FORMULA_PAPER_MIN = 246;

/**
 * Raster pixels kept outside detected ink. Display stays looser than inline so
 * equation numbers and script overhang keep a hairline. These sit above the #60
 * trim (4/5 and 2/3) so the paper margin is visible again, and still stop at the
 * content-aware box.
 */
export const FORMULA_INK_PAD_PX = {
  display: 6,
  displayProtect: 7,
  inline: 4,
  inlineProtect: 5
};

const FORMULA_OBSTACLE_GAP = 0.0012;

/**
 * Ink scan stays inside the formula glyph union plus this pad.
 * The pad keeps a radical bar or fraction rule that sits a hair outside a
 * glyph box. It is not the content-aware pad, and it does not reach the next line.
 */
export const FORMULA_GLYPH_SCAN_PAD = { x: 0.003, y: 0.002 };

/** Fallback when the pdf.js font has no descent metric. One em is the item height. */
export const FORMULA_GLYPH_DESCENT_EM = 0.25;

/** Keep a small margin, then stop before the next glyph, caption, or figure. */
export function contentAwareFormulaBbox(glyphBox, pad, obstacles = []) {
  if (!glyphBox) return null;
  const padX = Math.max(0, Number(pad?.x) || 0);
  const padTop = Math.max(0, Number(pad?.top ?? pad?.y) || 0);
  const padBottom = Math.max(0, Number(pad?.bottom ?? pad?.y) || 0);
  const [x0, y0, x1, y1] = glyphBox;
  let left = x0 - padX;
  let top = y0 - padTop;
  let right = x1 + padX;
  let bottom = y1 + padBottom;
  for (const box of obstacles) {
    if (!Array.isArray(box) || box.length < 4) continue;
    const [a0, b0, a1, b1] = box;
    if (!(a1 > a0) || !(b1 > b0)) continue;
    const vBand = b0 < bottom && b1 > top;
    const hBand = a0 < right && a1 > left;
    const midX = (a0 + a1) / 2;
    const midY = (b0 + b1) / 2;
    // Font boxes of the next line can overlap a subscript by a hair. Keep the
    // glyph union, but do not pad into an obstacle whose center is outside it.
    if (vBand && midX <= x0 && a1 > left) left = Math.max(left, Math.min(x0, a1 + FORMULA_OBSTACLE_GAP));
    if (vBand && midX >= x1 && a0 < right) right = Math.min(right, Math.max(x1, a0 - FORMULA_OBSTACLE_GAP));
    if (hBand && midY <= y0 && b1 > top) top = Math.max(top, Math.min(y0, b1 + FORMULA_OBSTACLE_GAP));
    if (hBand && midY >= y1 && b0 < bottom) bottom = Math.min(bottom, Math.max(y1, b0 - FORMULA_OBSTACLE_GAP));
  }
  return [
    clamp01(Math.min(left, x0)),
    clamp01(Math.min(top, y0)),
    clamp01(Math.max(right, x1)),
    clamp01(Math.max(bottom, y1))
  ];
}

function finitePad(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isPaperPixel(data, index) {
  const alpha = data[index + 3];
  if (alpha < 16) return true;
  return data[index] >= FORMULA_PAPER_MIN &&
    data[index + 1] >= FORMULA_PAPER_MIN &&
    data[index + 2] >= FORMULA_PAPER_MIN;
}

function growCropEdge(start, end, minSpan, low, high) {
  let from = start;
  let to = end;
  if (high - low < minSpan || to - from >= minSpan) return [from, to];
  const extra = minSpan - (to - from);
  const growLow = Math.min(from - low, Math.ceil(extra / 2));
  from -= growLow;
  to = Math.min(high, to + (extra - growLow));
  if (to - from < minSpan) from = Math.max(low, to - minSpan);
  return [from, to];
}

/**
 * Shrink a content-aware formula box to the ink, then restore a short paper hairline.
 * The result never extends past `bbox`, so a neighbor or caption already excluded by
 * contentAwareFormulaBbox cannot re-enter. No ink, or no pixel buffer, keeps `bbox`.
 * `image` is the page raster RGBA `{ data, width, height }`.
 * `inkShare` is dark-pixel height / padded crop height. The #62 hairline sits inside
 * the box the right pane sizes, so CSS must divide by this share.
 */
function boxesOverlap(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length >= 4 && b.length >= 4 &&
    a[2] > a[0] && a[3] > a[1] && b[2] > b[0] && b[3] > b[1] &&
    Math.min(a[2], b[2]) > Math.max(a[0], b[0]) &&
    Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
}

function pointInBox(nx, ny, box) {
  return nx >= box[0] && nx < box[2] && ny >= box[1] && ny < box[3];
}

/** Obstacle boxes that meet the formula bbox. Glyph overlap is decided per pixel. */
export function intersectingMaskBoxes(boxes, bbox) {
  return (boxes || []).filter((box) => boxesOverlap(box, bbox));
}

/**
 * Page-normalized boxes mapped into a crop that fills the image.
 * Boxes that miss the crop are dropped. Glyph boxes use the same map.
 */
export function boxesInCrop(boxes, crop) {
  if (!Array.isArray(crop) || crop.length < 4) return [];
  const w = Number(crop[2]) - Number(crop[0]);
  const h = Number(crop[3]) - Number(crop[1]);
  if (!(w > 0) || !(h > 0)) return [];
  const mapped = [];
  for (const box of boxes || []) {
    if (!boxesOverlap(box, crop)) continue;
    mapped.push([
      (Math.max(box[0], crop[0]) - crop[0]) / w,
      (Math.max(box[1], crop[1]) - crop[1]) / h,
      (Math.min(box[2], crop[2]) - crop[0]) / w,
      (Math.min(box[3], crop[3]) - crop[1]) / h
    ]);
  }
  return mapped;
}

function glyphScanLimit(bbox, glyphBoxes, pad = FORMULA_GLYPH_SCAN_PAD, scanBottomCap = null) {
  const union = unionBbox(glyphBoxes);
  if (!union) return bbox;
  const padX = Math.max(0, Number(pad?.x) || 0);
  const padY = Math.max(0, Number(pad?.y) || 0);
  let bottom = Math.min(bbox[3], union[3]);
  const cap = Number(scanBottomCap);
  if (scanBottomCap != null && Number.isFinite(cap)) bottom = Math.min(bottom, cap);
  return [
    Math.max(bbox[0], union[0] - padX),
    Math.max(bbox[1], union[1] - padY),
    Math.min(bbox[2], union[2] + padX),
    Math.max(Math.max(bbox[1], union[1]), bottom)
  ];
}

/** True when a page pixel sits in a neighbor box and not in a formula glyph box. */
export function formulaPixelMasked(nx, ny, maskBoxes, glyphBoxes) {
  if (!Array.isArray(maskBoxes) || !maskBoxes.length) return false;
  for (const box of glyphBoxes || []) {
    if (Array.isArray(box) && box.length >= 4 && pointInBox(nx, ny, box)) return false;
  }
  return maskBoxes.some((box) => Array.isArray(box) && box.length >= 4 && pointInBox(nx, ny, box));
}

/** Paint masked pixels paper-white. Glyph-overlapping pixels stay. */
export function blankFormulaMask(image, { maskBoxes = [], glyphBoxes = [] } = {}) {
  const width = image?.width | 0;
  const height = image?.height | 0;
  const data = image?.data;
  if (!width || !height || !data || !maskBoxes.length) return image;
  for (let y = 0; y < height; y += 1) {
    const ny = (y + 0.5) / height;
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (!formulaPixelMasked((x + 0.5) / width, ny, maskBoxes, glyphBoxes)) continue;
      const index = row + x * 4;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = 255;
    }
  }
  return image;
}

export function measureFormulaCrop(bbox, image, options = {}) {
  const { inline = false, protect = false } = options || {};
  if (!Array.isArray(bbox) || bbox.length < 4) return { bbox: null, inkShare: null };
  const original = [clamp01(bbox[0]), clamp01(bbox[1]), clamp01(bbox[2]), clamp01(bbox[3])];
  const width = image?.width | 0;
  const height = image?.height | 0;
  const data = image?.data;
  if (!width || !height || !data || data.length < width * height * 4) {
    return { bbox: original, inkShare: null };
  }
  if (!(original[2] > original[0]) || !(original[3] > original[1])) {
    return { bbox: original, inkShare: null };
  }

  const glyphBoxes = Array.isArray(options?.glyphBoxes) ? options.glyphBoxes.filter((box) => boxesOverlap(box, original)) : [];
  const scan = glyphBoxes.length
    ? glyphScanLimit(original, glyphBoxes, options?.scanPad, options?.scanBottomCap)
    : original;
  const maskBoxes = intersectingMaskBoxes(options?.maskBoxes, scan);

  let left = Math.max(0, Math.floor(scan[0] * width));
  let top = Math.max(0, Math.floor(scan[1] * height));
  let right = Math.min(width, Math.ceil(scan[2] * width));
  let bottom = Math.min(height, Math.ceil(scan[3] * height));
  if (right - left < 1 || bottom - top < 1) return { bbox: original, inkShare: null };

  let minX = right;
  let minY = bottom;
  let maxX = left - 1;
  let maxY = top - 1;
  for (let y = top; y < bottom; y += 1) {
    const row = y * width * 4;
    const ny = (y + 0.5) / height;
    for (let x = left; x < right; x += 1) {
      const index = row + x * 4;
      if (formulaPixelMasked((x + 0.5) / width, ny, maskBoxes, glyphBoxes)) continue;
      if (isPaperPixel(data, index)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return { bbox: original, inkShare: null };

  const namedPad = inline
    ? (protect ? FORMULA_INK_PAD_PX.inlineProtect : FORMULA_INK_PAD_PX.inline)
    : (protect ? FORMULA_INK_PAD_PX.displayProtect : FORMULA_INK_PAD_PX.display);
  // Optional overrides keep the same PDF hairline when the raster scale changes.
  // Callers that omit them stay on the frozen #62 pixel pad at CROP_SCALE.
  const pad = finitePad(options?.padPx, namedPad);
  const minSpanX = finitePad(options?.minSpanX, 24);
  const minSpanY = finitePad(options?.minSpanY, 12);
  let ix0 = Math.max(left, minX - pad);
  let iy0 = Math.max(top, minY - pad);
  let ix1 = Math.min(right, maxX + 1 + pad);
  let iy1 = Math.min(bottom, maxY + 1 + pad);
  [ix0, ix1] = growCropEdge(ix0, ix1, minSpanX, left, right);
  [iy0, iy1] = growCropEdge(iy0, iy1, minSpanY, top, bottom);
  if (!(ix1 > ix0) || !(iy1 > iy0)) return { bbox: original, inkShare: null };
  const cropH = iy1 - iy0;
  const inkH = maxY - minY + 1;
  const inkShare = cropH > 0 ? inkH / cropH : null;
  return {
    bbox: [
      clamp01(ix0 / width),
      clamp01(iy0 / height),
      clamp01(ix1 / width),
      clamp01(iy1 / height)
    ],
    inkShare: inkShare > 0 && inkShare <= 1 ? inkShare : null
  };
}

export function trimFormulaBboxToInk(bbox, image, options) {
  return measureFormulaCrop(bbox, image, options).bbox;
}

/**
 * Dark ink of a typical inline glyph, in crop-raster pixels, before the frozen
 * inline hairline (FORMULA_INK_PAD_PX.inline on both sides). At CROP_SCALE 2 a
 * ~10pt em box is ~20px; the dark strokes plus a short subscript are closer to 16px.
 */
export const INLINE_NOMINAL_INK_PX = 16;
/**
 * Measured ink / right-pane body font-size.
 * Hard floor stays 1 (#64). Strong-read band is 1.25–1.35; the target is that center
 * so a measured med lands in the band. 1.05–1.15 is parity only, not the target.
 */
export const INLINE_INK_STRONG_LO = 1.25;
export const INLINE_INK_STRONG_HI = 1.35;
export const INLINE_INK_TARGET = 1.3;
export const INLINE_INK_FLOOR = 1;
/** Crop box allowed while the strong-read ink is reached. Nominal share lands inside it. */
export const INLINE_LINE_BOX_LO = 1.9;
export const INLINE_LINE_BOX_HI = 2.2;
/** After ink is in the strong band, the line top pulls into this band. */
export const INLINE_LINE_TOP_LO = 1.8;
export const INLINE_LINE_TOP_HI = 2.1;

/** ink / (ink + 2·pad). The pad is inside the CSS box, so it dilutes the ink. */
export function nominalInlineInkShare(padPx = FORMULA_INK_PAD_PX.inline, inkPx = INLINE_NOMINAL_INK_PX) {
  const ink = Number(inkPx);
  const pad = Number(padPx);
  if (!(ink > 0) || !(pad >= 0)) return 1;
  return ink / (ink + 2 * pad);
}

function inlineInkShareOrNominal(inkShare) {
  const nominal = nominalInlineInkShare();
  const share = Number(inkShare);
  if (!(share > 0.2) || share > 1 || !Number.isFinite(share)) return nominal;
  return share;
}

/**
 * CSS em height of the inline crop box so the ink, not the padded box, hits the target.
 * Do not clamp back to the old 1.45em line cap; that cap is what left the ink under bodyFs.
 * Do not clamp into 1.9–2.2em either: a thin share may need a taller box to keep the ink.
 */
export function inlineCropBoxEm(inkShare, target = INLINE_INK_TARGET) {
  const share = inlineInkShareOrNominal(inkShare);
  const goal = Number(target);
  const want = (Number.isFinite(goal) && goal > 0 ? goal : INLINE_INK_TARGET) / share;
  const floor = INLINE_INK_FLOOR / share;
  return Math.round(Math.max(want, floor) * 10000) / 10000;
}

/**
 * Layout em of the inline line once the crop is tall enough for the strong-read ink.
 * Inside the 1.9–2.2em box allowance the line top sits one band-offset under the box,
 * which lands in 1.8–2.1em. A taller box pulls only down to 2.1em, and never through
 * the top paper pad, so the ink stays inside the line.
 */
export function inlineLineTopEm(inkShare, target = INLINE_INK_TARGET) {
  const box = inlineCropBoxEm(inkShare, target);
  const goal = Number(target);
  const inkGoal = Number.isFinite(goal) && goal > 0 ? goal : INLINE_INK_TARGET;
  if (inkGoal + 1e-9 < INLINE_INK_STRONG_LO) return box;
  const share = inlineInkShareOrNominal(inkShare);
  const ink = box * share;
  const topPad = Math.max(0, (box - ink) / 2);
  const slack = box <= INLINE_LINE_BOX_HI
    ? (INLINE_LINE_BOX_LO - INLINE_LINE_TOP_LO)
    : (box - INLINE_LINE_TOP_HI);
  let line = box - Math.min(Math.max(0, slack), topPad);
  if (line > INLINE_LINE_TOP_HI) line = Math.max(INLINE_LINE_TOP_HI, box - topPad);
  if (line < INLINE_LINE_TOP_LO) line = box;
  if (line > box) line = box;
  return Math.round(line * 10000) / 10000;
}

function itemBbox(item, viewport) {
  const x = Number(item.x) || 0;
  const y = Number(item.y) || 0;
  const width = Number(item.width) || 0;
  const height = Number(item.height) || 0;
  const rect = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
  const [x1, y1, x2, y2] = rect;
  const vw = Math.max(1, Number(viewport.width) || 1);
  const vh = Math.max(1, Number(viewport.height) || 1);
  return [
    clamp01(Math.min(x1, x2) / vw),
    clamp01(Math.min(y1, y2) / vh),
    clamp01(Math.max(x1, x2) / vw),
    clamp01(Math.max(y1, y2) / vh)
  ];
}

/** pdf.js ascent/descent are em fractions, or font units near 1000. */
export function emFraction(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  const mag = Math.abs(n);
  if (mag <= 2) return mag;
  return mag / 1000;
}

export function glyphBodyEm(item) {
  const descent = emFraction(item?.descent);
  const ascent = emFraction(item?.ascent);
  return {
    descentEm: descent == null ? FORMULA_GLYPH_DESCENT_EM : descent,
    ascentEm: ascent == null ? 1 : ascent
  };
}

/** Full em box: baseline−descent through baseline+ascent, in page fractions. */
export function glyphBodyBox(item, viewport) {
  const x = Number(item?.x) || 0;
  const baseline = Number(item?.y) || 0;
  const width = Number(item?.width) || 0;
  const em = Number(item?.height) || 0;
  const { ascentEm, descentEm } = glyphBodyEm(item);
  const rect = viewport.convertToViewportRectangle([
    x,
    baseline - descentEm * em,
    x + width,
    baseline + ascentEm * em
  ]);
  const [x1, y1, x2, y2] = rect;
  const vw = Math.max(1, Number(viewport.width) || 1);
  const vh = Math.max(1, Number(viewport.height) || 1);
  return [
    clamp01(Math.min(x1, x2) / vw),
    clamp01(Math.min(y1, y2) / vh),
    clamp01(Math.max(x1, x2) / vw),
    clamp01(Math.max(y1, y2) / vh)
  ];
}

function viewportFractionY(pdfY, viewport) {
  const rect = viewport.convertToViewportRectangle([0, pdfY, 0, pdfY]);
  const vh = Math.max(1, Number(viewport.height) || 1);
  return clamp01(Number(rect[1]) / vh);
}

/** Top of the next non-formula line (baseline−ascent). Null when nothing sits below. */
export function nextLineLetterTop(formulaItems, pageItems, viewport) {
  const own = new Set();
  for (const item of expandedItems(formulaItems || [])) {
    if (Number.isInteger(item?.sourceIndex)) own.add(item.sourceIndex);
  }
  const bases = (formulaItems || []).map((item) => viewportFractionY(Number(item?.y) || 0, viewport));
  if (!bases.length) return null;
  const formulaBase = Math.max(...bases);
  let cap = null;
  for (const item of pageItems || []) {
    if (!item || own.has(item.sourceIndex) || !String(item.str || "").trim()) continue;
    const base = viewportFractionY(Number(item.y) || 0, viewport);
    if (!(base > formulaBase + 1e-6)) continue;
    const { ascentEm } = glyphBodyEm(item);
    const em = (Number(item.height) || 0) / Math.max(1, Number(viewport.height) || 1);
    const letterTop = viewportFractionY((Number(item.y) || 0) + ascentEm * (Number(item.height) || 0), viewport);
    if (!Number.isFinite(letterTop)) continue;
    if (cap == null || letterTop < cap) cap = letterTop;
  }
  return cap;
}

function isFormulaItem(item) {
  return item?.keepText !== true && looksLikeFormulaItem(item);
}

function foldScriptItems(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const used = new Set();
  const folded = [];
  for (let index = 0; index < sorted.length; index += 1) {
    if (used.has(index)) continue;
    const base = sorted[index];
    // pdf.js may place the final base letter in a larger punctuation run (", ..., x").
    if (!/(?:^|[\s,(])([A-Za-z\u0370-\u03FF])$/.test(base.str) || base.height < 8) {
      folded.push(base);
      continue;
    }
    const scripts = [];
    let edge = base.x + base.width;
    for (let next = index + 1; next < sorted.length; next += 1) {
      const item = sorted[next];
      if (item.x - edge > 1.5) break;
      const glyph = String(item.str || "");
      if (used.has(next) || !/^[A-Za-z0-9−–+\-]+$/.test(glyph)) break;
      const lowered = base.y - item.y;
      const inScriptBand = lowered >= 0.5 && lowered <= base.height * 0.5;
      const scriptSized = item.height < base.height * 0.85;
      // CMSY can report a full em box for a subscript minus. Keep it on the tail.
      const loweredOperator = /^[−–+\-]$/.test(glyph) && item.height <= base.height * 1.05 &&
        lowered >= 0.4 && lowered <= base.height * 0.7;
      if (!(scriptSized && inScriptBand) && !loweredOperator) break;
      scripts.push(item);
      used.add(next);
      edge = item.x + item.width;
    }
    if (!scripts.length) {
      folded.push(base);
      continue;
    }
    const script = scripts.map((item) => item.str).join("");
    folded.push({
      ...base,
      str: `${base.str}_${script.length === 1 ? script : `{${script}}`}`,
      width: edge - base.x,
      keepText: true,
      sourceItems: [base, ...scripts]
    });
  }
  return folded;
}

function lineWithScripts(line) {
  const items = foldScriptItems(line.items || []);
  const state = { text: "", prev: null };
  items.forEach((item) => pushPiece(state, item.str, item));
  return {
    ...line,
    items,
    text: state.text.replace(/\s+/g, " ").trim(),
    math: items.some(isFormulaItem)
  };
}

function lineBaseline(group) {
  const bodyH = Math.max(8, ...group.map((item) => item.height || 0));
  const bodies = group.filter((item) => (item.height || 0) >= bodyH * 0.85);
  const source = bodies.length ? bodies : group;
  return {
    y: source[0].y,
    bodyH,
    left: Math.min(...group.map((item) => item.x))
  };
}

function horizontalGap(item, group) {
  const left = Math.min(...group.map((entry) => entry.x));
  const right = Math.max(...group.map((entry) => entry.x + Math.max(entry.width, 0)));
  const itemRight = item.x + Math.max(item.width, 0);
  if (item.x <= right + 0.01 && itemRight >= left - 0.01) return 0;
  if (item.x > right) return item.x - right;
  return left - itemRight;
}

/** Scripts stay with their base. A new body line does not, even when the leading is close to a tall superscript. */
function staysOnLine(item, group) {
  const base = lineBaseline(group);
  const dy = Math.abs(item.y - base.y);
  const shorter = item.height > 0 && item.height < base.bodyH * 0.85;
  const overlaps = group.some((entry) =>
    item.x < entry.x + Math.max(entry.width, 1) + 2 &&
    item.x + Math.max(item.width, 1) > entry.x - 2);
  const atLeft = item.x <= base.left + 8;
  const below = base.y - item.y > base.bodyH * 0.55;
  if (shorter && overlaps && dy > 0.35 && dy < base.bodyH * 1.5 && !(atLeft && below)) return true;
  // A large operator and its limits share one formula line when they sit in
  // the line's x-span. A following body line still starts its own group.
  const near = horizontalGap(item, group) <= Math.max(8, base.bodyH * 0.8);
  const scriptLike = shorter && dy > 0.35 && dy < base.bodyH * 1.6;
  const tallOperator = /[∏∑∫√∐∮]/.test(String(item.str || "")) && dy < base.bodyH * 1.6;
  if ((scriptLike || tallOperator) && near && !(atLeft && below && !overlaps)) return true;
  if (dy > Math.max(9.2, base.bodyH * 0.88)) return false;
  const first = group[0];
  const last = group.at(-1);
  const height = Math.max(8, first.height || 0, item.height || 0);
  const reset = item.x < first.x + 20 && last.x + last.width - item.x > 20;
  if (reset && (dy > height * 0.35 || last.hasEOL)) return false;
  return true;
}

function sourceOrderLines(items) {
  const lines = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const ordered = [...group].sort((a, b) => a.x - b.x || b.y - a.y);
    const left = Math.min(...ordered.map((item) => item.x));
    const right = Math.max(...ordered.map((item) => item.x + item.width));
    const state = { text: "", prev: null };
    ordered.forEach((item) => pushPiece(state, item.str, item));
    const base = lineBaseline(ordered);
    lines.push({
      text: state.text.replace(/\s+/g, " ").trim(),
      x: left,
      y: base.y,
      width: right - left,
      height: Math.max(...ordered.map((item) => item.height)),
      bold: ordered.some((item) => /bold|black|heavy|semibold/i.test(item.fontName)),
      fontName: ordered[0].fontName,
      math: ordered.some(isFormulaItem),
      items: ordered
    });
    group = [];
  };
  for (const item of items) {
    if (!item.str) continue;
    if (group.length && !staysOnLine(item, group)) flush();
    group.push(item);
  }
  flush();
  return lines.filter((line) => line.text);
}

function bibliographyFrom(lines) {
  const heading = lines.findIndex((line) => /^(references|bibliography)$/i.test(String(line.text || "").trim()));
  const citeIndexes = lines
    .map((line, index) => /^\[\d+\]/.test(String(line.text || "").trim()) ? index : -1)
    .filter((index) => index >= 0);
  if (heading < 0 && citeIndexes.length < 4) return lines;
  const start = heading >= 0 ? heading + 1 : citeIndexes[0];
  return lines.map((line, index) => (index >= start ? { ...line, bibliography: true } : line));
}

/** Function words mark a sentence. Identifier fragments such as model/step do not. */
function hasProseFunctionWord(text) {
  const words = String(text || "").match(/[A-Za-z]+/g) || [];
  return words.some((word) => /^(and|or|the|with|for|from|into|over|than|that|this|are|was|were|not|but|also|each|then|such|these|those|while|which|their|there|about|after|before|between|during|under|above|within|without|through|because|however|therefore)$/i.test(word));
}

/**
 * Soft-merge band for adjacent display rows.
 * The unit is the page body leading when several body lines share one pitch,
 * otherwise the taller row's em. Inclusive at lo, exclusive at hi: a gap of
 * 1.6 units stays two blocks. Real Attention rows sit near 1.55 leading
 * (about 1.69 em). Paragraph gaps sit above 2. Do not widen hi.
 */
export const DISPLAY_CROSSLINE_GAP = Object.freeze({ lo: 0.8, hi: 1.6 });

/**
 * Ink outside the pdf.js em box, in ems. Descenders sit below the baseline,
 * and italic side bearings / delimiter strokes sit past the advance width.
 * Applied only to display crops, inside the content-aware clamp, so a neighbor
 * still cannot enter. FORMULA_CROP_PAD itself is unchanged.
 */
export const DISPLAY_INK_OUTSET = Object.freeze({ x: 0.14, top: 0.10, bottom: 0.32 });

const CROSSLINE_DISCOURSE = /^(and|or|the|from|into|over|than|that|this|are|was|were|not|but|also|each|then|such|these|those|while|which|their|there|about|after|before|between|during|under|above|within|without|through|because|however|therefore|following|given|defined|shown|figure|table|section|equation|below|above)$/i;

/**
 * Baseline gap divided by body leading when `leading` is set, else by the taller em.
 * Tests lock lo/hi against the em form (no leading argument).
 */
export function displayLineGapRatio(upper, lower, leading = 0) {
  const dy = Math.abs(Number(upper?.y) - Number(lower?.y));
  const em = Math.max(8, Number(upper?.height) || 0, Number(lower?.height) || 0);
  const unit = Number(leading) > 0 ? Math.max(em, Number(leading)) : em;
  return dy / Math.max(unit, 1e-6);
}

/**
 * Median baseline pitch of body lines. Display rows in these papers are one
 * body em tall, but the next baseline is the leading (~1.09 em), so an em
 * denominator reads a normal display gap as 1.69 and rejects it.
 */
export function pageBodyLeading(lines) {
  const heights = (lines || [])
    .map((line) => Number(line?.height) || 0)
    .filter((height) => height >= 8 && height <= 16);
  if (heights.length < 4) return 0;
  const sorted = [...heights].sort((a, b) => a - b);
  const body = sorted[Math.floor(sorted.length / 2)];
  if (!(body > 0)) return 0;
  const ordered = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  const gaps = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const upper = ordered[index];
    const lower = ordered[index + 1];
    if (Math.abs((Number(upper.height) || 0) - body) > body * 0.12) continue;
    if (Math.abs((Number(lower.height) || 0) - body) > body * 0.12) continue;
    const dy = Math.abs(upper.y - lower.y);
    const ratio = dy / body;
    if (ratio < 0.98 || ratio > 1.25) continue;
    gaps.push(dy);
  }
  if (gaps.length < 3) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function lineEm(line) {
  return Math.max(8, Number(line?.height) || 0);
}

function isEquationNumberText(text) {
  return /^\(\d+\)$/.test(String(text || "").trim());
}

function ordinaryProseWords(text) {
  const words = String(text || "").match(/[A-Za-z]+/g) || [];
  return words.filter((word) => word.length >= 4 && !FORMULA_WORD.test(word) && !CROSSLINE_DISCOURSE.test(word));
}

function formulaShapedText(text) {
  const raw = String(text || "");
  if (/[=∑∫√∈≤≥≠]/.test(raw) || hasMathUnicode(raw)) return true;
  const words = raw.match(/[A-Za-z]+/g) || [];
  return words.some((word) => FORMULA_WORD.test(word));
}

/**
 * A full sentence. Formula identifiers (model, step, lrate) stay with an equation.
 * Several ordinary words, or any ordinary word outside a formula shape, are prose.
 */
function hasBlockingProse(text) {
  const raw = String(text || "");
  if (/[\u4e00-\u9fff]/.test(raw)) return true;
  const words = raw.match(/[A-Za-z]+/g) || [];
  if (words.some((word) => CROSSLINE_DISCOURSE.test(word))) return true;
  const ordinary = ordinaryProseWords(raw);
  if (formulaShapedText(raw)) return ordinary.length >= 4;
  return ordinary.length >= 1;
}

function relationHeadMatch(text) {
  return /^(where|with|for)\b/i.exec(String(text || "").trim());
}

/** "and" / "or" may join two formula clauses. They are not a sentence by themselves. */
function withoutFormulaConjunctions(text) {
  return String(text || "").replace(/\b(and|or)\b/gi, " ");
}

/**
 * "where / with / for" plus math continues a display.
 * A prose where-clause does not. "where μ := … and β := …" does: the only
 * function word is the conjunction between two formulas.
 */
function isRelationHead(line) {
  const text = String(line?.text || "");
  const match = relationHeadMatch(text);
  if (!match) return false;
  const rest = text.trim().slice(match[0].length);
  if (ordinaryProseWords(rest).length) return false;
  const stripped = withoutFormulaConjunctions(rest);
  if (hasBlockingProse(stripped) || hasProseFunctionWord(stripped)) return false;
  const items = line?.items || [];
  return items.some(isFormulaItem) || /[=:+\-−∑∫√^_∈<>]/.test(rest) || hasMathUnicode(rest);
}

function indentedDisplayEquation(line, pageWidth) {
  const text = String(line?.text || "");
  return line.x > pageWidth * 0.24 && line.width >= 70 && line.width < pageWidth * 0.7 &&
    /=/.test(text) && text.length < 160 && !hasProseFunctionWord(text);
}

function isFormulaDisplayLine(line, pageWidth) {
  if (!line) return false;
  const text = String(line.text || "").trim();
  if (!text || /^\[\d+\]/.test(text) || isEquationNumberText(text)) return false;
  if (line.width < 24 || line.width >= pageWidth) return false;
  if (isRelationHead(line)) return true;
  if (hasBlockingProse(text)) return false;
  return lineShouldBeOneFormula(line.items) || indentedDisplayEquation(line, pageWidth);
}

function sharesDisplayAlignment(a, b, pageWidth) {
  const aMid = a.x + a.width / 2;
  const bMid = b.x + b.width / 2;
  if (Math.abs(aMid - bMid) <= Math.max(36, pageWidth * 0.08)) return true;
  if (Math.abs(a.x - b.x) <= Math.max(18, pageWidth * 0.045)) return true;
  const band = pageWidth * 0.18;
  const mid = pageWidth / 2;
  return Math.abs(aMid - mid) <= band && Math.abs(bMid - mid) <= band &&
    Math.abs(aMid - bMid) <= pageWidth * 0.14;
}

function relationAligns(formula, where, pageWidth) {
  if (sharesDisplayAlignment(formula, where, pageWidth)) return true;
  const left = formula.x;
  const right = formula.x + formula.width;
  const overlap = Math.min(right, where.x + where.width) - Math.max(left, where.x);
  if (overlap >= Math.min(formula.width, where.width) * 0.4) return true;
  return Math.abs(where.x - formula.x) <= pageWidth * 0.12;
}

function farLeftBodyWrap(line, group, pageWidth) {
  if (isRelationHead(line)) return false;
  const groupLeft = Math.min(...group.map((entry) => entry.x));
  return line.x <= pageWidth * 0.16 && groupLeft > pageWidth * 0.22;
}

function lineStrictlyBetween(a, b, ordered, group) {
  const hi = Math.max(a.y, b.y);
  const lo = Math.min(a.y, b.y);
  return ordered.some((other) =>
    !group.includes(other) && other !== a && other !== b &&
    other.y < hi - 0.35 && other.y > lo + 0.35);
}

function withinLegacyWindow(a, b) {
  const em = Math.max(lineEm(a), lineEm(b));
  return Math.abs(a.y - b.y) <= Math.max(12, em * 1.2);
}

function equationNumberOnGroup(line, group) {
  if (!isEquationNumberText(line?.text)) return false;
  const em = Math.max(...group.map(lineEm));
  const top = Math.max(...group.map((entry) => entry.y));
  const bottom = Math.min(...group.map((entry) => entry.y));
  const slack = Math.max(12, em * 1.2);
  if (line.y > top + slack || line.y < bottom - slack) return false;
  const right = Math.max(...group.map((entry) => entry.x + entry.width));
  if (line.x < right - em) return false;
  return line.x - right < Math.max(160, em * 14);
}

function legacyInnerLine(line, group) {
  const text = String(line.text || "").trim();
  if (!text || text.length > 12 || proseCarriesSentence(line.items)) return false;
  const left = Math.min(...group.map((entry) => entry.x));
  const right = Math.max(...group.map((entry) => entry.x + entry.width));
  const middle = line.x + line.width / 2;
  const inside = middle >= left - 10 && middle <= right + 10;
  const prefix = group.some((entry) =>
    Math.abs(line.y - entry.y) < 2 && line.x < entry.x && entry.x - (line.x + line.width) < 3);
  return inside || prefix;
}

function mathFragment(line, group) {
  const text = String(line.text || "").trim();
  if (!text || text.length > 24 || hasBlockingProse(text) || isEquationNumberText(text)) return false;
  if (/^[A-Za-z]{4,}$/.test(text) && !FORMULA_WORD.test(text)) return false;
  const mathLike = line.math || (line.items || []).some(isFormulaItem) ||
    /[=+\-−^_√∑∫0-9()∈]/.test(text);
  if (!mathLike) return false;
  const left = Math.min(...group.map((entry) => entry.x));
  const right = Math.max(...group.map((entry) => entry.x + entry.width));
  const width = Math.max(1, right - left);
  const middle = line.x + line.width / 2;
  if (middle < left - 14 || middle > right + 14) return false;
  return line.width <= Math.min(160, width * 0.72);
}

function horizontalLineGap(a, b) {
  const aRight = a.x + Math.max(a.width, 0);
  const bRight = b.x + Math.max(b.width, 0);
  if (a.x <= bRight + 0.01 && aRight >= b.x - 0.01) return 0;
  if (a.x > bRight) return a.x - bRight;
  return b.x - aRight;
}

/** pdf.js often splits one display row into side-by-side runs. Their centers do not match. */
function sameDisplayRow(a, b) {
  const em = Math.max(lineEm(a), lineEm(b));
  if (Math.abs(a.y - b.y) > Math.max(1.6, em * 0.2)) return false;
  return horizontalLineGap(a, b) <= Math.max(36, em * 3.2);
}

function lineInkSpan(line) {
  const items = line?.items || [];
  if (!items.length) {
    const y = Number(line?.y) || 0;
    const height = Number(line?.height) || 0;
    return { top: y + height, bottom: y };
  }
  let top = -Infinity;
  let bottom = Infinity;
  for (const item of items) {
    const y = Number(item?.y) || 0;
    const height = Number(item?.height) || 0;
    top = Math.max(top, y + height);
    bottom = Math.min(bottom, y);
  }
  return { top, bottom };
}

/**
 * Distance between glyph boxes, in the same unit as displayLineGapRatio.
 * A stacked fraction hangs into the row above, so the baseline gap overstates
 * the visual gap. Overlap is 0.
 */
function inkGapRatio(a, b, leading) {
  const spanA = lineInkSpan(a);
  const spanB = lineInkSpan(b);
  const upper = spanA.top >= spanB.top ? spanA : spanB;
  const lower = upper === spanA ? spanB : spanA;
  const gap = Math.max(0, upper.bottom - lower.top);
  const em = Math.max(lineEm(a), lineEm(b));
  const unit = Number(leading) > 0 ? Math.max(em, Number(leading)) : em;
  return gap / Math.max(unit, 1e-6);
}

/** Brackets, limits, and norm bars that sourceOrderLines left off the formula row. */
function stackedMathLine(line, group, pageWidth) {
  if (!line || hasBlockingProse(line.text) || isRelationHead(line)) return false;
  if (isFormulaDisplayLine(line, pageWidth)) return false;
  const text = String(line.text || "").trim();
  if (!text || text.length > 18 || isEquationNumberText(text)) return false;
  if (/[A-Za-z]{4,}/.test(text) && !FORMULA_WORD.test(text)) return false;
  const mathLike = line.math || (line.items || []).some(isFormulaItem) ||
    /[∑∫√∏∥‖\[\]()∈≤≥≠±×÷^_]/.test(text);
  if (!mathLike || line.width >= pageWidth * 0.45) return false;
  const left = Math.min(...group.map((entry) => entry.x));
  const right = Math.max(...group.map((entry) => entry.x + entry.width));
  const overlap = Math.min(right, line.x + line.width) - Math.max(left, line.x);
  const shorter = Math.min(Math.max(line.width, 1), Math.max(1, right - left));
  if (overlap >= shorter * 0.35) return true;
  const em = Math.max(...group.map(lineEm));
  const span = { x: left, width: Math.max(0, right - left) };
  return horizontalLineGap(line, span) <= em * 1.25 && line.width <= em * 4;
}

/**
 * A numerator and its denominator are separate formula lines whose centers do
 * not match. Join them when they are close in both axes. A second display
 * equation is farther than 1.15 leading, so this does not widen DISPLAY_CROSSLINE_GAP.
 */
function stackedFormulaPiece(line, nearest, group, pageWidth, leading) {
  if (!isFormulaDisplayLine(line, pageWidth) || isRelationHead(line)) return false;
  if (displayLineGapRatio(nearest, line, leading) >= 1.15) return false;
  const left = Math.min(...group.map((entry) => entry.x));
  const right = Math.max(...group.map((entry) => entry.x + entry.width));
  const em = Math.max(...group.map(lineEm), lineEm(line));
  return horizontalLineGap(line, { x: left, width: Math.max(0, right - left) }) <= em * 1.6;
}

function conflictingEquationNumber(line, group) {
  if (!isEquationNumberText(line?.text)) return false;
  const incoming = String(line.text).match(/\d+/);
  if (!incoming) return false;
  const token = `(${incoming[0]})`;
  return group.some((entry) => {
    const found = String(entry.text || "").match(/\(\d+\)/g) || [];
    return found.some((item) => item !== token);
  });
}

function canJoinDisplayLine(line, nearest, group, ordered, pageWidth, leading = 0) {
  if (!line || group.includes(line) || /^\[\d+\]/.test(String(line.text || "").trim())) return false;
  if (conflictingEquationNumber(line, group)) return false;
  if (lineStrictlyBetween(nearest, line, ordered, group)) return false;
  const ratio = displayLineGapRatio(nearest, line, leading);
  if (equationNumberOnGroup(line, group) && ratio < DISPLAY_CROSSLINE_GAP.hi) return true;
  const relation = isRelationHead(line);
  const inkClose = relation && inkGapRatio(nearest, line, leading) < DISPLAY_CROSSLINE_GAP.hi &&
    relationAligns(nearest, line, pageWidth);
  if (ratio >= DISPLAY_CROSSLINE_GAP.hi && !inkClose) return false;
  if (farLeftBodyWrap(line, group, pageWidth)) return false;
  if (withinLegacyWindow(nearest, line) && legacyInnerLine(line, group)) return true;
  if (hasBlockingProse(line.text) && !relation) return false;
  if (sameDisplayRow(nearest, line) &&
      (relation || line.math || isFormulaDisplayLine(line, pageWidth))) return true;
  if (mathFragment(line, group)) return true;
  if (relation) return relationAligns(nearest, line, pageWidth) || inkClose;
  if (stackedMathLine(line, group, pageWidth)) return true;
  if (stackedFormulaPiece(line, nearest, group, pageWidth, leading)) return true;
  if (!isFormulaDisplayLine(line, pageWidth)) return false;
  return sharesDisplayAlignment(nearest, line, pageWidth);
}

function nearestGroupLine(group, line) {
  return group.reduce((best, entry) =>
    Math.abs(entry.y - line.y) < Math.abs(best.y - line.y) ? entry : best);
}

function absorbDisplayGroup(group, ordered, pageWidth, leading) {
  let grew = true;
  while (grew) {
    grew = false;
    for (const line of ordered) {
      if (group.includes(line)) continue;
      const nearest = nearestGroupLine(group, line);
      if (!canJoinDisplayLine(line, nearest, group, ordered, pageWidth, leading)) continue;
      group.push(line);
      grew = true;
    }
  }
}

function bindDisplayGroup(group, lines, members) {
  let anchor = group[0];
  let anchorAt = lines.indexOf(anchor);
  for (const line of group) {
    const at = lines.indexOf(line);
    if (at >= 0 && (anchorAt < 0 || at < anchorAt)) {
      anchor = line;
      anchorAt = at;
    }
  }
  const record = { anchor, group, emitted: false };
  group.forEach((line) => members.set(line, record));
}

function displayFormulaGroups(lines, viewport) {
  const members = new Map();
  const pageWidth = Math.max(1, Number(viewport?.width) || 1);
  const leading = pageBodyLeading(lines);
  const ordered = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  const consumed = new Set();
  for (const anchor of ordered) {
    if (consumed.has(anchor) || !isFormulaDisplayLine(anchor, pageWidth)) continue;
    const group = [anchor];
    absorbDisplayGroup(group, ordered, pageWidth, leading);
    group.forEach((line) => consumed.add(line));
    bindDisplayGroup(group, lines, members);
  }
  attachLoneEquationNumbers(members, lines);
  return members;
}

function attachLoneEquationNumbers(members, lines) {
  const groups = [...new Set(members.values())];
  for (const line of lines) {
    if (!isEquationNumberText(line.text) || members.has(line)) continue;
    let best = null;
    let bestDy = Infinity;
    for (const record of groups) {
      if (conflictingEquationNumber(line, record.group)) continue;
      const top = Math.max(...record.group.map((entry) => lineInkSpan(entry).top));
      const bottom = Math.min(...record.group.map((entry) => lineInkSpan(entry).bottom));
      const em = Math.max(...record.group.map(lineEm));
      if (line.y > top + em * 0.35 || line.y < bottom - em * 1.35) continue;
      const right = Math.max(...record.group.map((entry) => entry.x + entry.width));
      if (line.x + line.width < right - em * 3) continue;
      const dy = Math.min(...record.group.map((entry) => Math.abs(entry.y - line.y)));
      if (dy < bestDy) {
        best = record;
        bestDy = dy;
      }
    }
    if (!best) continue;
    best.group.push(line);
    members.set(line, best);
  }
}

function separateAuthorRows(lines, viewport) {
  const abstract = lines.find((line) => /^abstract$/i.test(line.text));
  const bodyHeight = [...lines].map((line) => line.height).sort((a, b) => a - b)[Math.floor(lines.length / 2)] || 10;
  const title = abstract && lines
    .filter((line) => line.y > abstract.y + 20 && line.height > bodyHeight * 1.3 &&
      line.text.split(/\s+/).length >= 3 && !/@/.test(line.text))
    .sort((a, b) => b.height - a.height)[0];
  if (!title || !abstract || title.y <= abstract.y || title.y - abstract.y > viewport.height * 0.36) {
    return { body: lines, authors: [] };
  }
  const selected = lines.filter((line) => line.y < title.y - 8 && line.y > abstract.y + 8);
  if (!selected.some((line) => /@/.test(line.text))) return { body: lines, authors: [] };
  const body = lines.filter((line) => line.y <= title.y + 8 && !selected.includes(line));
  const items = selected.flatMap((line) => line.items || []);
  const people = packAuthorPeople(items);
  const authors = people.length >= 2
    ? people.map((person) => authorDraftFromPerson(person, viewport)).filter((draft) => draft?.text)
    : [];
  if (authors.length >= 2) return { body, authors };
  const text = selected.map((line) => line.text).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return { body: lines, authors: [] };
  return {
    body,
    authors: [{
      kind: "prose",
      role: "authors",
      text,
      flatAuthor: true,
      bbox: unionBbox(items.map((item) => itemBbox(item, viewport))),
      sourceItems: items,
      placeholders: []
    }]
  };
}

const AUTHOR_MARKER_ONLY = /^[*†‡⁎∗＊§¶‖※]+$/u;

function authorItemLines(items) {
  const lines = [];
  const sorted = [...(items || [])].filter((item) => String(item?.str || "").trim())
    .sort((a, b) => b.y - a.y || a.x - b.x);
  for (const item of sorted) {
    const line = lines.find((entry) => Math.abs(entry.y - item.y) <= 4);
    if (line) line.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }
  lines.forEach((line) => line.items.sort((a, b) => a.x - b.x));
  return lines;
}

function joinedItemText(items) {
  const state = { text: "", prev: null };
  for (const item of items) pushPiece(state, item.str, item);
  return state.text.replace(/\s+/g, " ").trim();
}

function clustersOnAuthorLine(items) {
  const clusters = [];
  for (const item of items) {
    const prev = clusters.at(-1);
    const gap = prev ? item.x - prev.right : 0;
    const limit = Math.max(12, (Number(item.height) || 10) * 1.1);
    if (prev && gap <= limit) {
      prev.items.push(item);
      prev.right = Math.max(prev.right, item.x + (Number(item.width) || 0));
    } else {
      clusters.push({
        items: [item],
        x: item.x,
        right: item.x + (Number(item.width) || 0)
      });
    }
  }
  return clusters.map((cluster) => {
    const text = joinedItemText(cluster.items);
    return {
      text,
      items: cluster.items,
      center: (cluster.x + cluster.right) / 2,
      kind: authorClusterKind(text)
    };
  }).filter((cluster) => cluster.kind !== "skip");
}

function authorClusterKind(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "skip";
  if (AUTHOR_MARKER_ONLY.test(trimmed.replace(/\s+/g, ""))) return "marker";
  if (/@/.test(trimmed)) return "email";
  if (authorNameFromLine(trimmed)) return "name";
  return "affiliation";
}

function nearestAuthor(people, cluster) {
  let best = null;
  let bestDist = Infinity;
  for (const person of people) {
    const dist = Math.abs(person.center - cluster.center);
    if (dist < bestDist) {
      bestDist = dist;
      best = person;
    }
  }
  return best;
}

/**
 * One cell per person across author rows. A later name line starts new people.
 * It does not fall into the first row as affiliation.
 */
function packAuthorPeople(items) {
  const people = [];
  let row = [];
  const parked = [];
  const give = (cluster, targets) => {
    if (!targets.length) {
      parked.push(cluster);
      return;
    }
    const person = nearestAuthor(targets, cluster);
    person.items.push(...cluster.items);
    if (cluster.kind === "marker") {
      const mark = cluster.text.replace(/\s+/g, "");
      if (mark && !person.name.includes(mark)) person.name += mark;
      return;
    }
    if (cluster.kind === "email") {
      person.email = person.email ? `${person.email} ${cluster.text}` : cluster.text;
      return;
    }
    if (cluster.text.split(/\s+/).length > 8) return;
    person.affiliation = person.affiliation ? `${person.affiliation} ${cluster.text}` : cluster.text;
  };
  for (const line of authorItemLines(items)) {
    const clusters = clustersOnAuthorLine(line.items);
    const names = clusters.filter((cluster) => cluster.kind === "name");
    if (!names.length) {
      clusters.forEach((cluster) => give(cluster, row));
      continue;
    }
    row = [];
    for (const cluster of names) {
      const person = {
        name: authorNameFromLine(cluster.text),
        affiliation: "",
        email: "",
        items: [...cluster.items],
        center: cluster.center
      };
      people.push(person);
      row.push(person);
    }
    if (parked.length) parked.splice(0).forEach((cluster) => give(cluster, row));
    clusters.filter((cluster) => cluster.kind !== "name").forEach((cluster) => give(cluster, row));
  }
  if (parked.length && people.length) parked.forEach((cluster) => {
    const person = nearestAuthor(people, cluster);
    if (person) person.items.push(...cluster.items);
  });
  return people.filter((person) => person.name);
}

function authorDraftFromPerson(person, viewport) {
  const sourceItems = person.items || [];
  if (!person.name) return null;
  const authorCell = { name: person.name };
  if (person.affiliation) authorCell.affiliation = person.affiliation;
  if (person.email) authorCell.email = person.email;
  return {
    kind: "prose",
    role: "authors",
    text: person.name,
    authorCell,
    bbox: unionBbox(sourceItems.map((item) => itemBbox(item, viewport))),
    sourceItems,
    placeholders: []
  };
}

function hasOrdinaryWord(text) {
  const words = String(text || "").match(/[A-Za-z]{4,}/g) || [];
  return words.some((word) => !FORMULA_WORDS.has(word));
}

/** Roman function names such as softmax stay inside the formula crop. A real sentence does not. */
export function proseCarriesSentence(items) {
  const text = (items || []).map((item) => String(item.str || "")).join(" ");
  if (/[\u4e00-\u9fff]{2,}/.test(text)) return true;
  const words = text.match(/[A-Za-z]+/g) || [];
  return words.some((word) => /^(and|or|the|with|for|from|into|over|than|that|this|are|was|were|not|but|also)$/i.test(word) ||
    (word.length >= 4 && !FORMULA_WORD.test(word)));
}

export function lineShouldBeOneFormula(items) {
  const list = items || [];
  const text = list.map((item) => item.str || "").join("");
  if (!list.some(isFormulaItem) && !/=/.test(text)) return false;
  const prose = list.filter((item) => !isFormulaItem(item));
  return !proseCarriesSentence(prose);
}

function pushPiece(state, piece, item) {
  if (state.prev) {
    const gap = item.x - (state.prev.x + state.prev.width);
    const spaceWidth = Math.max(state.prev.height || 0, item.height || 0, 8) * 0.22;
    if (gap > spaceWidth && piece && !/\s$/.test(state.text) && !/^\s/.test(piece)) state.text += " ";
  }
  state.text += piece;
  state.prev = item;
}

function figureDrafts(images, viewport) {
  const width = Math.max(1, Number(viewport.width) || 1);
  const height = Math.max(1, Number(viewport.height) || 1);
  let rects = [];
  if (images?.fnArray) {
    rects = imageRectsFromUnitCtms(walkImageCtms(images.fnArray, images.argsArray || []), height);
  } else if (Array.isArray(images) && images[0]?.ctm) {
    rects = imageRectsFromUnitCtms(images, height);
  }
  return rects
    .filter((item) => {
      const rect = item?.rect;
      if (!rect) return false;
      if (rect.width < width * 0.04 && rect.height < height * 0.04) return false;
      return true;
    })
    .map((item) => ({
      kind: "figure",
      bbox: [
        item.rect.left / width,
        item.rect.top / height,
        (item.rect.left + item.rect.width) / width,
        (item.rect.top + item.rect.height) / height
      ]
    }));
}

function centerInside(item, box, viewport) {
  const own = itemBbox(item, viewport);
  const x = (own[0] + own[2]) / 2;
  const y = (own[1] + own[3]) / 2;
  return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

/** A caption anchors complete page crops; image XObjects and layout boxes are only candidates. */
function pageVisualDrafts(items, images, viewport) {
  const rows = sourceOrderLines(items).sort((a, b) => b.y - a.y);
  const imagesOnPage = figureDrafts(images, viewport);
  const usedImages = new Set();
  const visuals = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const figure = /^Fig(?:ure)?\.?\s*\d+\s*:/i.test(row.text);
    const table = /^Table\s*\d+\s*:/i.test(row.text);
    if (!figure && !table) continue;
    const caption = [row];
    let tail = index;
    while (tail + 1 < rows.length && caption.length < 4) {
      const next = rows[tail + 1];
      const gap = rows[tail].y - next.y;
      if (gap < 5 || gap > 13 || Math.abs(next.x - row.x) > 14) break;
      caption.push(next);
      tail += 1;
    }
    const capTop = Math.min(...caption.flatMap((line) => line.items.map((item) => itemBbox(item, viewport)[1])));
    const capBottom = Math.max(...caption.flatMap((line) => line.items.map((item) => itemBbox(item, viewport)[3])));
    if (figure) {
      const adjacent = imagesOnPage.filter((image, imageIndex) =>
        !usedImages.has(imageIndex) && image.bbox[3] <= capTop + 0.015 &&
        capTop - image.bbox[3] < 0.09 && image.bbox[1] < capTop - 0.015);
      if (!adjacent.length) {
        // Some appendix figures are vector-only. Repeated diagram labels above
        // a bottom caption provide a bounded source region without OCR text.
        const above = items.filter((item) => itemBbox(item, viewport)[3] < capTop - 0.01);
        const repeatedLabels = above.filter((item) => /<EOS>|<pad>/i.test(item.str)).length >= 2;
        if (!repeatedLabels || above.length < 20) continue;
        const box = padBbox(unionBbox(above.map((item) => itemBbox(item, viewport))), 0.006);
        if (box[3] - box[1] < 0.2) continue;
        visuals.push({ kind: "figure", bbox: box, sourceItems: above });
        continue;
      }
      adjacent.forEach((image) => usedImages.add(imagesOnPage.indexOf(image)));
      const imageBox = unionBbox(adjacent.map((image) => image.bbox));
      // Figure labels often use PDF text operators above and inside the raster pieces.
      const internal = items.filter((item) => {
        const box = itemBbox(item, viewport);
        const midX = (box[0] + box[2]) / 2;
        const midY = (box[1] + box[3]) / 2;
        return midY >= imageBox[1] - 0.035 && midY < capTop - 0.002 &&
          midX >= imageBox[0] - 0.09 && midX <= imageBox[2] + 0.09;
      });
      const bbox = padBbox(unionBbox([imageBox, ...internal.map((item) => itemBbox(item, viewport))]), 0.005);
      visuals.push({ kind: "figure", bbox, sourceItems: internal });
      continue;
    }
    // A table begins after its caption and ends at the first true paragraph gap.
    const below = rows.slice(tail + 1).filter((line) => line.y < caption.at(-1).y - 12);
    const first = below[0];
    if (!first || caption.at(-1).y - first.y > 55 || first.x <= row.x + 5) continue;
    const tableRows = [first];
    for (let next = 1; next < below.length; next += 1) {
      const gap = tableRows.at(-1).y - below[next].y;
      if (gap > 27 || gap < -3) break;
      tableRows.push(below[next]);
    }
    if (tableRows.length < 3) continue;
    const tableItems = tableRows.flatMap((line) => line.items || []);
    const tableBox = padBbox(unionBbox(tableItems.map((item) => itemBbox(item, viewport))), 0.008);
    tableBox[0] = clamp01(tableBox[0] - 0.01);
    tableBox[2] = clamp01(tableBox[2] + 0.01);
    tableBox[1] = Math.max(tableBox[1], capBottom + 0.003);
    if (!tableBox || tableBox[1] <= capBottom - 0.003) continue;
    visuals.push({ kind: "table", bbox: tableBox, sourceItems: tableItems });
  }
  imagesOnPage.forEach((image, index) => {
    if (usedImages.has(index)) return;
    visuals.push({ ...image, sourceItems: items.filter((item) => centerInside(item, image.bbox, viewport)) });
  });
  return visuals.sort((a, b) => a.bbox[1] - b.bbox[1]);
}

function desiredFormulaPad(items, inline) {
  const base = inline
    ? { x: FORMULA_CROP_PAD.inlineX, y: FORMULA_CROP_PAD.inlineY }
    : { x: FORMULA_CROP_PAD.displayX, y: FORMULA_CROP_PAD.displayY };
  const heights = items.map((item) => Number(item?.height) || 0).filter((height) => height > 0);
  const body = heights.length ? Math.max(...heights) : 10;
  const hasScript = items.some((item) => {
    const height = Number(item?.height) || 0;
    return height > 0 && height < body * 0.85;
  });
  const text = items.map((item) => item?.str || "").join("");
  const hasDelimiter = /[()[\]√∑∫]/.test(text);
  return {
    x: Math.min(FORMULA_PAD_LIMIT.x, base.x + (hasDelimiter ? FORMULA_CROP_PAD.scriptX : 0)),
    y: Math.min(FORMULA_PAD_LIMIT.y, base.y + ((hasScript || hasDelimiter) ? FORMULA_CROP_PAD.scriptY : 0)),
    protect: hasScript || hasDelimiter
  };
}

function formulaFontName(item) {
  return isMathFontName(fontNameForFormula(item));
}

/** Vector redraw only when every glyph is a formula font and the ink stays inside the text box. */
export function formulaGlyphsRedrawSafe(items) {
  const list = items || [];
  if (!list.length) return false;
  const text = list.map((item) => item?.str || "").join("");
  if (/[√∑∫∏()]/.test(text)) return false;
  return list.every(formulaFontName);
}

function displayInkOutset(items, viewport) {
  const heights = (items || []).map((item) => Number(item?.height) || 0).filter((height) => height > 0);
  const em = heights.length ? Math.max(...heights) : 10;
  const width = Math.max(1, Number(viewport?.width) || 1);
  const height = Math.max(1, Number(viewport?.height) || 1);
  return {
    x: (em * DISPLAY_INK_OUTSET.x) / width,
    top: (em * DISPLAY_INK_OUTSET.top) / height,
    bottom: (em * DISPLAY_INK_OUTSET.bottom) / height
  };
}

/**
 * Display-side paint facts from items F1/F2 already grouped.
 * Does not change which items join the formula.
 * scriptShare = shortest script glyph / crop height (viewport px).
 * eqKeep = fraction of the crop to the left of a trailing (n).
 */
function formulaPaintMeta(items, viewport, bbox) {
  const width = Math.max(1, Number(viewport?.width) || 1);
  const height = Math.max(1, Number(viewport?.height) || 1);
  const cropW = (Number(bbox?.[2]) - Number(bbox?.[0])) * width;
  const cropH = (Number(bbox?.[3]) - Number(bbox?.[1])) * height;
  const heights = [];
  const labels = [];
  for (const item of expandedItems(items)) {
    const glyph = Number(item?.height) || 0;
    if (glyph > 0) heights.push(glyph);
    if (/^\(\d+\)$/.test(String(item?.str || "").trim())) labels.push(item);
  }
  let scriptShare = null;
  if (heights.length && cropH > 0) {
    const body = Math.max(...heights);
    const scripts = heights.filter((glyph) => glyph < body * 0.85);
    if (scripts.length) {
      const share = Math.min(...scripts) / cropH;
      if (share > 0 && share <= 1) scriptShare = Math.round(share * 10000) / 10000;
    }
  }
  let eqLabel = "";
  let eqKeep = null;
  if (labels.length && cropW > 0) {
    eqLabel = String(labels[labels.length - 1].str || "").trim();
    const left = Math.min(...labels.map((item) => Number(item.x) || 0));
    const keep = (left - Number(bbox[0]) * width) / cropW;
    if (keep > 0.4 && keep < 0.98) eqKeep = Math.round(keep * 10000) / 10000;
  }
  return { scriptShare, eqLabel, eqKeep };
}

function formulaDraft(items, viewport, { inline = false, obstacles = [], pageItems = [] } = {}) {
  const boxes = items.map((item) => glyphBodyBox(item, viewport));
  const glyphBox = unionBbox(boxes);
  const pad = desiredFormulaPad(items, inline);
  // Display ink (descenders, side bearings) is part of the union the pad grows
  // from. contentAware still stops at neighbors, and never shrinks back through
  // that ink on the second pass.
  const inkBox = inline ? glyphBox : contentAwareFormulaBbox(glyphBox, displayInkOutset(items, viewport), obstacles);
  const bbox = contentAwareFormulaBbox(inkBox, { x: pad.x, y: pad.y }, obstacles);
  const paint = formulaPaintMeta(items, viewport, bbox);
  return {
    kind: "formula",
    bbox,
    display: !inline,
    inlineOf: null,
    sourceItems: items,
    glyphBoxes: boxes,
    maskBoxes: intersectingMaskBoxes(obstacles, bbox),
    scanBottomCap: nextLineLetterTop(items, pageItems, viewport),
    glyphRedraw: formulaGlyphsRedrawSafe(items),
    formulaInkProtect: pad.protect === true,
    scriptShare: paint.scriptShare,
    eqLabel: paint.eqLabel,
    eqKeep: paint.eqKeep
  };
}

function obstacleBoxes(items, viewport, visuals, formulaItems) {
  const skip = new Set();
  for (const item of expandedItems(formulaItems)) {
    if (Number.isInteger(item?.sourceIndex)) skip.add(item.sourceIndex);
  }
  const boxes = [];
  for (const item of items || []) {
    if (skip.has(item.sourceIndex) || !String(item.str || "").trim()) continue;
    boxes.push(itemBbox(item, viewport));
  }
  for (const visual of visuals || []) {
    if (Array.isArray(visual?.bbox)) boxes.push(visual.bbox);
  }
  return boxes;
}

/**
 * A multi-line group that is wide, or carries an equation number, is one display
 * even when its first source run sits at the paragraph indent. A short indented
 * wrap (no number, narrow) stays inline.
 */
function groupLooksLikeDisplay(group, pageWidth) {
  if (!group || group.length < 2) return false;
  const width = Math.max(1, Number(pageWidth) || 1);
  const left = Math.min(...group.map((entry) => entry.x));
  const right = Math.max(...group.map((entry) => entry.x + entry.width));
  if (right - left >= width * 0.28) return true;
  return group.some((entry) =>
    isEquationNumberText(entry.text) || /\(\d+\)\s*$/.test(String(entry.text || "")));
}

/**
 * A short formula wrapped at the paragraph indent continues the sentence.
 * Centered equations, and any line that ends with an equation number, stay display.
 */
function isMarginContinuation(line, viewport, prosePending, host) {
  if (!prosePending || !line) return false;
  const width = Math.max(1, Number(viewport?.width) || 1);
  if (/\(\d+\)\s*$/.test(String(line.text || ""))) return false;
  const lineWidth = line.width || 0;
  if (lineWidth > width * 0.62) return false;
  if (line.x <= width * 0.22) return true;
  const hostLeft = Number(host?.x);
  if (!Number.isFinite(hostLeft)) return false;
  return Math.abs(line.x - hostLeft) <= 16 && lineWidth <= width * 0.5;
}

function expandedItems(items) {
  return items.flatMap((item) => item.sourceItems ? expandedItems(item.sourceItems) : [item]);
}

function sourceTextOf(items) {
  const state = { text: "", prev: null };
  items.forEach((item) => pushPiece(state, item.str, item));
  return state.text.replace(/\s+/g, " ").trim();
}

function scriptOffsets(items) {
  const flat = expandedItems(items);
  const heights = flat.map((item) => Number(item?.height) || 0).filter((height) => height > 0);
  if (!heights.length) return { super: false, sub: false };
  const body = Math.max(...heights);
  const bodies = flat.filter((item) => (Number(item?.height) || 0) >= body * 0.85);
  if (!bodies.length) return { super: false, sub: false };
  const baseY = bodies.reduce((sum, item) => sum + item.y, 0) / bodies.length;
  let superInk = false;
  let subInk = false;
  for (const item of flat) {
    const height = Number(item?.height) || 0;
    if (!(height > 0) || height >= body * 0.85) continue;
    if (item.y > baseY + 0.4) superInk = true;
    if (item.y < baseY - 0.4) subInk = true;
  }
  return { super: superInk, sub: subInk };
}

/**
 * Simple N = 6 / h = 8 / P_drop = 0.1 / ε_ls = 0.1 relations.
 * Subscript ink is allowed only as the identifier tail (glyph assembly of P_drop).
 * Roots, sums, superscripts, PE, and d_* dimension subscripts stay crops.
 */
export function isPlaintextFormulaSpan(items) {
  const list = items || [];
  if (!list.length) return false;
  const compact = sourceTextOf(list).replace(/\s+/g, "");
  if (/PE[_({]|P E/.test(compact)) return false;
  const parts = plaintextRelationParts(compact);
  if (!parts) return false;
  const offsets = scriptOffsets(list);
  if (offsets.super) return false;
  if (offsets.sub && !parts.sub) return false;
  return true;
}

function plaintextLine(line, items) {
  const parts = plaintextRelationParts(sourceTextOf(items).replace(/\s+/g, ""));
  const text = formatPlaintextRelation(parts, true);
  if (!text) return line;
  return { ...line, text, sourceText: line.text, math: false };
}

function inlineFormulaSpans(items) {
  const spans = [];
  const used = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const text = String(items[index].str || "").trim();
    if (!/^=/.test(text) || text.length > 30) continue;
    let first = index - 1;
    while (first >= 0 && !String(items[first].str || "").trim()) first -= 1;
    if (first < 0 || !/^[A-Za-z\u0370-\u03FF](?:_\{?[A-Za-z0-9−+\-]+\}?)?$/.test(items[first].str)) continue;
    let last = index;
    if (text.includes("(")) {
      while (last + 1 < items.length && !String(items[last].str).includes(")")) last += 1;
      if (!String(items[last].str).includes(")")) continue;
    } else if (/\d/.test(text)) {
      if (items[last + 1]?.str === "." && /^\d+$/.test(items[last + 2]?.str || "")) last += 2;
      // A scientific-notation exponent is drawn above the baseline as separate
      // glyphs. Keep it with the base instead of leaving a dangling "−9".
      if (/^[−-]$/.test(items[last + 1]?.str || "") && /^\d+$/.test(items[last + 2]?.str || "") &&
          items[last + 1].y > items[last].y + 1 && items[last + 2].y > items[last].y + 1) last += 2;
    } else if (!/[0-9A-Za-z]/.test(text.replace(/^=/, ""))) {
      while (last + 1 < items.length && !String(items[last + 1].str).trim()) last += 1;
      const next = String(items[last + 1]?.str || "");
      if (/^P(?:_|$)/.test(next)) {
        let dot = first - 1;
        while (dot >= 0 && !String(items[dot].str || "").trim()) dot -= 1;
        let left = dot - 1;
        while (left >= 0 && !String(items[left].str || "").trim()) left -= 1;
        if (dot < 0 || left < 0 || items[dot].str !== "·" || !/^[A-Za-z]$/.test(items[left].str)) continue;
        first = left;
        last += 1;
        while (last + 1 < items.length && last - index < 20 &&
               !/^,\s*[A-Za-z]{3,}/.test(String(items[last + 1].str || ""))) last += 1;
      } else {
        // An unsupported operator needs vertical grouping. Do not crop a lone glyph.
        if (!/^\d/.test(next)) continue;
        last += 1;
      }
    }
    if (last - first > 16) continue;
    spans.push([first, last]);
    for (let part = first; part <= last; part += 1) used.add(part);
  }
  for (let index = 0; index < items.length; index += 1) {
    if (used.has(index) || !/^\($/.test(String(items[index].str || "").trim())) continue;
    let last = index + 1;
    while (last < items.length && !String(items[last].str || "").includes(")") && last - index < 16) last += 1;
    if (last >= items.length || last - index >= 16) continue;
    const expression = items.slice(index, last + 1).map((item) => item.str).join("");
    if (!/[A-Za-z]/.test(expression) || !/_|,\s*\.\.\.|[+=−]/.test(expression)) continue;
    spans.push([index, last]);
    for (let part = index; part <= last; part += 1) used.add(part);
  }
  for (let index = 0; index < items.length - 2; index += 1) {
    if (used.has(index) || items[index].str !== "√") continue;
    const numerator = items[index + 1];
    const denominator = items[index + 2];
    if (numerator?.str !== "1" || !/^d/.test(denominator?.str || "") ||
        numerator.y <= items[index].y + 1 || denominator.y >= items[index].y - 1) continue;
    const last = items[index + 3]?.str === "k" ? index + 3 : index + 2;
    spans.push([index, last]);
    for (let part = index; part <= last; part += 1) used.add(part);
  }
  for (let index = 0; index < items.length - 1; index += 1) {
    if (used.has(index)) continue;
    const base = items[index];
    if (/^P E_\{?pos(?:\+k)?\}?$/.test(base.str || "")) {
      spans.push([index, index]);
      used.add(index);
      continue;
    }
    if (base.str === "√" && /^d_?\{?model\}?/.test(items[index + 1]?.str || "")) {
      spans.push([index, index + 1]);
      used.add(index);
      used.add(index + 1);
      continue;
    }
    if (base.str !== "P E" || items[index + 1]?.str !== "pos" ||
        items[index + 1].height >= base.height * 0.85 ||
        items[index + 1].y >= base.y - 0.5) continue;
    let last = index + 1;
    if (items[last + 1]?.str === "+" && items[last + 2]?.str === "k") last += 2;
    spans.push([index, last]);
    for (let part = index; part <= last; part += 1) used.add(part);
  }
  return spans.sort((a, b) => a[0] - b[0]).filter(([first, last]) => {
    const width = items[last].x + items[last].width - items[first].x;
    return width >= 24 || (items[first].str === "√" && width >= 12);
  });
}

function isBodyProseItem(item, bodyH) {
  if ((item.height || 0) < bodyH * 0.85) return false;
  const text = String(item.str || "").trim();
  if (!text || FORMULA_WORD.test(text)) return false;
  if (/^(and|or|the|with|for|from|into|over|than|that|this|are|was|were|not|but)$/i.test(text)) return true;
  return /[A-Za-z]{4,}/.test(text);
}

/** A relation such as W ∈ R with real superscripts is one crop. Do not spell those glyphs into the sentence. */
function scriptedRelationSpans(items) {
  const heights = items.map((item) => item.height || 0).filter((height) => height >= 8);
  if (!heights.length) return [];
  const bodyH = Math.max(...heights);
  const bases = items.filter((item) => (item.height || 0) >= bodyH * 0.85);
  if (!bases.length) return [];
  const baseY = bases.reduce((sum, item) => sum + item.y, 0) / bases.length;
  const isScript = (item) => (item.height || 0) > 0 && item.height < bodyH * 0.85 &&
    Math.abs(item.y - baseY) > 0.4;
  if (!items.some((item) => /[∈⊆]/.test(item.str || "")) || !items.some(isScript)) return [];
  const spans = [];
  let start = -1;
  let sawRelation = false;
  const flush = (end) => {
    if (start < 0) return;
    if (sawRelation && end >= start) spans.push([start, end]);
    start = -1;
    sawRelation = false;
  };
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const text = String(item.str || "").trim();
    if (!text) continue;
    if (isBodyProseItem(item, bodyH) || text === "." || text === "。") {
      flush(index - 1);
      continue;
    }
    const mathToken = /^[A-Za-z\u0370-\u03FF](?:_\{?[A-Za-z0-9−+\-]+\}?)?$/.test(text);
    const atom = isScript(item) || /[∈⊆×∑∏√]/.test(text) || mathToken || /^[,;:()]$/.test(text);
    if (start < 0) {
      if (!(isScript(item) || /[∈⊆×]/.test(text) || mathToken)) continue;
      start = index;
    } else if (!atom) {
      flush(index - 1);
      continue;
    }
    if (/[∈⊆]/.test(text)) sawRelation = true;
  }
  flush(items.length - 1);
  return spans.filter(([first, last]) => items[last].x + items[last].width - items[first].x >= 24);
}

/** A subscript or superscript is clearly smaller than the line's body size. */
export const FORMULA_SCRIPT_RATIO = 0.79;

/** Inline runs narrower than this stay in the sentence (fragment crops). */
export const FORMULA_RUN_MIN_WIDTH = 12;

const DISCOURSE_WORD = /^(and|or|the|with|for|from|into|over|than|that|this|are|was|were|not|but|also|where|which|their|there|about|after|before|between|these|those|while|such|each|then|when|what|have|has|had|been|being|its|his|her|our|your|they|them|who|whom|whose|will|can|may|shall|must|onto|upon|within|without|across|against|because|however|therefore)$/i;

function mathFontKind(item) {
  const name = fontNameForFormula(item);
  if (!name || !isMathFontName(name)) return "";
  if (/CMSY|CMEX|MSAM|MSBM|rsfs|eufm|Symbol/i.test(name)) return "symbol";
  return "letter";
}

function lineBodyMetrics(items) {
  const heights = (items || []).map((item) => Number(item?.height) || 0).filter((height) => height > 0);
  const bodyH = heights.length ? Math.max(...heights) : 10;
  const bodies = (items || []).filter((item) => (Number(item?.height) || 0) >= bodyH * FORMULA_SCRIPT_RATIO);
  const baseY = bodies.length
    ? bodies.reduce((sum, item) => sum + (Number(item.y) || 0), 0) / bodies.length
    : 0;
  return { bodyH, baseY };
}

function isScriptGlyph(item, bodyH, baseY) {
  const height = Number(item?.height) || 0;
  if (!(height > 0) || !(bodyH > 0) || height >= bodyH * FORMULA_SCRIPT_RATIO) return false;
  return Math.abs((Number(item?.y) || 0) - baseY) > 0.4;
}

function xGapBetween(a, b) {
  const aRight = a.x + Math.max(a.width, 0);
  const bRight = b.x + Math.max(b.width, 0);
  if (a.x <= bRight + 0.01 && aRight >= b.x - 0.01) return 0;
  if (a.x > bRight) return a.x - bRight;
  return b.x - aRight;
}

function isProseFormulaBreaker(item) {
  if (mathFontKind(item) || hasMathUnicode(item?.str)) return false;
  const text = String(item?.str || "").trim();
  if (/[\u4e00-\u9fff]/.test(text)) return true;
  const words = text.match(/[A-Za-z]+/g) || [];
  if (!words.length) return false;
  if (words.some((word) => DISCOURSE_WORD.test(word))) return true;
  if (words.some((word) => word.length >= 3 && !FORMULA_WORD.test(word))) return true;
  return false;
}

function isFormulaGlue(item, script) {
  if (isProseFormulaBreaker(item)) return false;
  const text = String(item?.str || "").trim();
  // A sentence period is not a decimal point. Digits already carry their dot.
  if (/^[.?!。]$/.test(text)) return false;
  if (mathFontKind(item) || script || hasMathUnicode(item?.str)) return true;
  if (!text) return true;
  if (/^[0-9.,:;+\-−–=<>≤≥≠±×÷∈∑∫√∞^_{}\\()[\]|·]+$/.test(text)) return true;
  if (FORMULA_WORD.test(text.replace(/[()]/g, ""))) return true;
  if (/[:=+\-−=<>∈∑∫√∏|()]/.test(text) && !/[A-Za-z]{3,}/.test(text)) return true;
  return false;
}

function isIdentifierAssembly(text) {
  return /^[A-Za-z\u0370-\u03FF]_\{?[A-Za-z0-9−–+\-]+\}?$/.test(String(text || "").trim());
}

/**
 * h_{t−1} class: one base plus an index tail that contains a minus or plus.
 * Dimension names (d_model, d_ff) and bare h_t are not this class.
 */
function isIndexIdentifierAssembly(text) {
  const raw = String(text || "").trim();
  if (!isIdentifierAssembly(raw)) return false;
  const tail = raw.match(/_\{?([A-Za-z0-9−–+\-]+)\}?$/);
  if (!tail || !/[−–+\-]/.test(tail[1]) || tail[1].length > 6) return false;
  if (/[A-Za-z]{3,}/.test(tail[1])) return false;
  return /[A-Za-z0-9]/.test(tail[1]);
}

/** Glyphs of one h_{t−1}-class identifier, already folded or still split. */
function indexIdentifierUnicode(items) {
  const list = items || [];
  if (!list.length) return "";
  const first = String(list[0].str || "").trim();
  if (list.length === 1) return isIndexIdentifierAssembly(first) ? first : "";
  let base = "";
  let tail = "";
  if (/^[A-Za-z\u0370-\u03FF]$/.test(first)) {
    base = first;
  } else {
    const folded = first.match(/^([A-Za-z\u0370-\u03FF])_\{?([A-Za-z0-9]+)\}?$/);
    if (!folded) return "";
    base = folded[1];
    tail = folded[2];
  }
  for (let index = 1; index < list.length; index += 1) {
    const glyph = String(list[index].str || "").trim();
    if (!/^[A-Za-z0-9−–+\-]+$/.test(glyph) || /[A-Za-z]{3,}/.test(glyph)) return "";
    tail += glyph;
  }
  const unicode = `${base}_{${tail}}`;
  return isIndexIdentifierAssembly(unicode) ? unicode : "";
}

function isScriptSized(item, metrics) {
  const height = Number(item?.height) || 0;
  return height > 0 && metrics.bodyH > 0 && height < metrics.bodyH * FORMULA_SCRIPT_RATIO;
}

function isStrongMathItem(item, items, index, metrics) {
  const text = String(item?.str || "");
  // h_{t−1} stays in the sentence on a text face and on CMMI/CMSY. d_model still anchors.
  if (isIndexIdentifierAssembly(text)) return false;
  if (isIdentifierAssembly(text) && mathFontKind(item) !== "letter" && mathFontKind(item) !== "symbol") return false;
  if (mathFontKind(item) === "symbol" && !isScriptSized(item, metrics)) return true;
  if (hasMathUnicode(text) && !isScriptSized(item, metrics)) return true;
  if (/[+\-−*=<>≤≥≠±×÷∈∑∫√∏∞^_]/.test(text) && !isProseFormulaBreaker(item)) {
    const symbols = (text.match(/[+\-−*=<>≤≥≠±×÷∈∑∫√∏∞^_{}\\]/g) || []).length;
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    if (symbols >= 1 && symbols >= letters) return true;
  }
  if (mathFontKind(item) !== "letter") return false;
  if (/[_^]/.test(text)) return true;
  const limit = Math.max(2.5, metrics.bodyH * 0.35);
  return items.some((other, otherIndex) => {
    if (otherIndex === index) return false;
    if (!isScriptGlyph(other, metrics.bodyH, metrics.baseY)) return false;
    return xGapBetween(item, other) <= limit;
  });
}

function unionFormulaSpans(spans) {
  const sorted = (spans || []).filter((span) => span && span[1] >= span[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/**
 * One inline formula per same-line run of math glyphs, scripts, and the
 * operators between them. A prose word ends the run.
 */
export function sameLineFormulaSpans(items) {
  const list = items || [];
  const metrics = lineBodyMetrics(list);
  const strong = list.map((item, index) => isStrongMathItem(item, list, index, metrics));
  const script = list.map((item) => isScriptGlyph(item, metrics.bodyH, metrics.baseY));
  const include = strong.slice();
  const gapLimit = Math.max(14, metrics.bodyH * 1.2);
  let grew = true;
  while (grew) {
    grew = false;
    for (let index = 0; index < list.length; index += 1) {
      if (include[index] || isProseFormulaBreaker(list[index])) continue;
      if (!isFormulaGlue(list[index], script[index])) continue;
      const touches = list.some((other, otherIndex) => {
        if (!include[otherIndex] || otherIndex === index) return false;
        if (xGapBetween(list[index], other) > gapLimit) return false;
        const left = Math.min(index, otherIndex);
        const right = Math.max(index, otherIndex);
        for (let between = left + 1; between < right; between += 1) {
          if (isProseFormulaBreaker(list[between])) return false;
        }
        return true;
      });
      if (touches) {
        include[index] = true;
        grew = true;
      }
    }
  }
  const spans = [];
  let start = -1;
  const flush = (end) => {
    if (start < 0 || end < start) return;
    let anchored = false;
    for (let index = start; index <= end; index += 1) if (strong[index]) anchored = true;
    if (!anchored) return;
    const width = list[end].x + Math.max(list[end].width, 0) - list[start].x;
    if (width >= FORMULA_RUN_MIN_WIDTH) spans.push([start, end]);
    start = -1;
  };
  for (let index = 0; index < list.length; index += 1) {
    if (!include[index]) {
      flush(index - 1);
      continue;
    }
    if (start < 0) start = index;
  }
  flush(list.length - 1);
  return spans;
}

function formulaSpans(items) {
  const primary = inlineFormulaSpans(items);
  const used = new Set();
  primary.forEach(([first, last]) => {
    for (let index = first; index <= last; index += 1) used.add(index);
  });
  const extra = scriptedRelationSpans(items).filter(([first, last]) => {
    for (let index = first; index <= last; index += 1) if (used.has(index)) return false;
    return true;
  });
  return unionFormulaSpans([...primary, ...extra, ...sameLineFormulaSpans(items)]);
}

function lineWithInlineFormulas(line, viewport, nextFormula, formulaByToken, context = {}) {
  const items = [...(line.items || [])].sort((a, b) => a.x - b.x);
  const spans = formulaSpans(items);
  const state = { text: "", prev: null };
  const sourceState = { text: "", prev: null };
  items.forEach((item) => pushPiece(sourceState, item.str, item));
  const proseItems = [];
  let index = 0;
  let spanIndex = 0;
  while (index < items.length) {
    const span = spans[spanIndex];
    if (span && index === span[0]) {
      const run = items.slice(span[0], span[1] + 1);
      const raw = expandedItems(run);
      const indexUnicode = indexIdentifierUnicode(run);
      if (indexUnicode) {
        if (state.text && /[A-Za-z0-9)]$/.test(state.text)) state.text += " ";
        pushPiece(state, indexUnicode, run[0]);
        state.prev = run.at(-1);
        proseItems.push(...raw);
        index = span[1] + 1;
        spanIndex += 1;
        continue;
      }
      if (isPlaintextFormulaSpan(run)) {
        const unicode = formatPlaintextRelation(
          plaintextRelationParts(sourceTextOf(run).replace(/\s+/g, "")),
          true
        );
        if (state.text && /[A-Za-z0-9)]$/.test(state.text)) state.text += " ";
        pushPiece(state, unicode || sourceTextOf(raw), run[0]);
        state.prev = run.at(-1);
        proseItems.push(...raw);
        index = span[1] + 1;
        spanIndex += 1;
        continue;
      }
      const token = `⟦f${nextFormula()}⟧`;
      const formula = formulaDraft(raw, viewport, {
        inline: true,
        obstacles: obstacleBoxes(context.visible, viewport, context.visuals, raw),
        pageItems: context.visible
      });
      const source = run[0].str === "√" && run[1]?.str === "1" ? "1/√d_k"
        : run[0].str.startsWith("P E_") ? run[0].str.replace(/^P E_/, "PE_")
        : run[0].str === "P E" ? `PE_{${run.slice(1).map((item) => item.str).join("")}}`
        : sourceTextOf(run);
      formulaByToken.set(token, { token, formula, source });
      if (state.text && /[A-Za-z0-9)]$/.test(state.text)) state.text += " ";
      pushPiece(state, token, run[0]);
      state.prev = run.at(-1);
      index = span[1] + 1;
      spanIndex += 1;
    } else {
      pushPiece(state, items[index].str, items[index]);
      proseItems.push(...expandedItems([items[index]]));
      index += 1;
    }
  }
  return {
    ...line,
    text: state.text.replace(/\s+/g, " ").trim(),
    sourceText: sourceState.text.replace(/\s+/g, " ").trim(),
    items: proseItems,
    math: false,
    fontName: proseItems[0]?.fontName || ""
  };
}

function proseDrafts(lines, allLines, viewport, formulaByToken) {
  return paragraphsFromLines(lines, allLines, { preserveLineHyphens: true }).flatMap((block) => {
    const entries = [...block.text.matchAll(/⟦f\d+⟧/g)]
      .map((match) => formulaByToken.get(match[0])).filter(Boolean);
    const sourceItems = block.sourceItems || [];
    const allItems = [...sourceItems, ...entries.flatMap((entry) => entry.formula.sourceItems)];
    const host = {
      kind: "prose",
      role: looksLikeCaption(block.text) ? "caption" : block.role,
      text: block.text,
      sourceText: block.text.replace(/⟦f\d+⟧/g, (token) => formulaByToken.get(token)?.source || token),
      bbox: unionBbox(allItems.map((item) => itemBbox(item, viewport))),
      placeholders: entries,
      sourceItems,
      allSourceItems: allItems,
      skipTranslate: lines.every((line) => line.bibliography) || undefined
    };
    entries.forEach((entry) => {
      entry.formula.inlineOf = host;
      entry.formula.display = false;
    });
    return [host, ...entries.map((entry) => entry.formula)];
  });
}

function insertFigures(drafts, figures) {
  const ordered = drafts.slice();
  const pending = figures.slice().sort((a, b) => a.bbox[1] - b.bbox[1]);
  for (const figure of pending) {
    const at = ordered.findIndex((draft) => draft.bbox && draft.bbox[1] > figure.bbox[1]);
    if (at < 0) ordered.push(figure);
    else ordered.splice(at, 0, figure);
  }
  return ordered;
}

function nearestVisualId(blocks, index, label) {
  let best = null;
  let bestDist = Infinity;
  let bestBefore = false;
  blocks.forEach((block, i) => {
    if (block.label !== label) return;
    const dist = Math.abs(i - index);
    const before = i < index;
    if (dist < bestDist || (dist === bestDist && before && !bestBefore)) {
      bestDist = dist;
      best = block.id;
      bestBefore = before;
    }
  });
  return best;
}

function sourceIndexes(items) {
  return [...new Set(expandedItems(items || []).map((item) => item.sourceIndex)
    .filter(Number.isInteger))].sort((a, b) => a - b);
}

function stableSourceId(draft, page) {
  const indexes = sourceIndexes(draft.allSourceItems || draft.sourceItems);
  const seed = indexes.length ? indexes.join(",") : `${draft.kind}:${(draft.bbox || []).map((n) => n.toFixed(5)).join(",")}`;
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `p${page}-s${hash.toString(36)}`;
}

function auditSources(raw, excluded, drafts, blocks) {
  const owners = new Map();
  drafts.forEach((draft, draftIndex) => {
    const block = blocks[draftIndex];
    const owner = draft.kind === "prose" ? "body" : "visual";
    for (const index of sourceIndexes(draft.sourceItems)) {
      if (!owners.has(index)) owners.set(index, []);
      owners.get(index).push({ owner, blockId: block.id, sourceId: block.sourceId });
    }
  });
  const items = raw.map((item, index) => {
    if (!String(item.str || "").trim()) return { index, owner: "excluded", reason: "empty-or-spacing" };
    if (excluded.has(index)) return { index, owner: "excluded", reason: "page-chrome" };
    const claims = owners.get(index) || [];
    if (claims.length === 1) return { index, ...claims[0] };
    if (!claims.length) return { index, owner: "unresolved", reason: "no-source-block" };
    return { index, owner: "unresolved", reason: "duplicate-ownership", blockIds: claims.map((claim) => claim.blockId) };
  });
  return {
    items,
    missing: items.filter((item) => item.reason === "no-source-block").map((item) => item.index),
    duplicates: items.filter((item) => item.reason === "duplicate-ownership").map((item) => item.index)
  };
}

function toProtocol(drafts, pageNumber, trust) {
  const page = Number(pageNumber) || 1;
  drafts.forEach((draft, index) => {
    draft.id = `p${page}-b${index + 1}`;
    draft.sourceId = stableSourceId(draft, page);
  });
  const blocks = drafts.map((draft) => {
    if (draft.kind === "figure" || draft.kind === "table") {
      return { id: draft.id, sourceId: draft.sourceId, label: draft.kind, bbox: draft.bbox };
    }
    if (draft.kind === "formula") {
      const block = {
        id: draft.id,
        sourceId: draft.sourceId,
        label: "formula",
        bbox: draft.bbox,
        display: draft.display !== false && !draft.inlineOf
      };
      if (draft.inlineOf?.id) block.inlineOf = draft.inlineOf.id;
      if (draft.scriptShare) block.scriptShare = draft.scriptShare;
      if (draft.eqLabel) block.eqLabel = draft.eqLabel;
      if (draft.eqKeep) block.eqKeep = draft.eqKeep;
      if (draft.formulaInkProtect) block.formulaInkProtect = true;
      if (draft.glyphBoxes?.length) block.glyphBoxes = draft.glyphBoxes;
      if (draft.maskBoxes?.length) block.maskBoxes = draft.maskBoxes;
      if (Number.isFinite(draft.scanBottomCap)) block.scanBottomCap = draft.scanBottomCap;
      if (draft.glyphRedraw && draft.glyphBoxes?.length) block.glyphRedraw = true;
      return block;
    }
    const role = draft.role;
    let label = "text";
    if (role === "title") label = "title";
    else if (role === "heading") label = "heading";
    else if (role === "caption") label = "caption";
    const text = trust.trusted ? draft.text || "" : "";
    const block = { id: draft.id, sourceId: draft.sourceId, label, bbox: draft.bbox, text };
    if (trust.trusted) block.sourceText = draft.sourceText || draft.text || "";
    if (role === "authors") {
      block.label = "text";
      block.skipTranslate = true;
      block.presentation = "byline";
      if (draft.authorCell?.name) block.authorCell = { ...draft.authorCell };
      if (draft.flatAuthor) block.flatAuthor = true;
    }
    if (draft.skipTranslate) block.skipTranslate = true;
    if (draft.placeholders?.length && trust.trusted) {
      block.placeholders = draft.placeholders.map((entry) => ({
        token: entry.token,
        blockId: entry.formula.id
      }));
    }
    return block;
  });
  blocks.forEach((block, index) => {
    if (block.label !== "caption") return;
    const label = /^Table\s*\d+\s*:/i.test(block.text || "") ? "table" :
      /^Fig(?:ure)?\.?\s*\d+\s*:/i.test(block.text || "") ? "figure" : "";
    const visualId = label ? nearestVisualId(blocks, index, label) : null;
    if (visualId) block.captionFor = visualId;
  });
  return blocks;
}

function preparedTextLines({ items, viewport, images, styles } = {}) {
  const view = viewport || { width: 1, height: 1, convertToViewportRectangle: (rect) => rect };
  const raw = Array.isArray(items) ? items : [];
  const trust = textLayerTrust(raw.map((item) => ({ str: item?.str || item?.text || "" })));
  const normalized = raw.map((item, sourceIndex) => {
    const transform = Array.isArray(item?.transform) ? item.transform : [];
    const style = styles?.[item?.fontName] || null;
    return {
      ...item,
      str: String(item?.str || ""),
      x: Number.isFinite(Number(item?.x)) ? Number(item.x) : Number(transform[4]) || 0,
      y: Number.isFinite(Number(item?.y)) ? Number(item.y) : Number(transform[5]) || 0,
      width: Number(item?.width) || 0,
      height: Number(item?.height) || 0,
      fontName: String(item?.fontName || ""),
      fontRealName: String(item?.fontRealName || ""),
      ascent: item?.ascent ?? style?.ascent,
      descent: item?.descent ?? style?.descent,
      sourceIndex
    };
  });
  const excluded = new Set(normalized.filter((item) =>
    isPageChromeItem(item, { width: view.width, height: view.height })).map((item) => item.sourceIndex));
  const notice = normalized.find((item) => /^Provided proper attribution is provided/i.test(item.str));
  if (notice && excluded.has(notice.sourceIndex)) {
    normalized.forEach((item) => {
      if (item.y <= notice.y && notice.y - item.y <= notice.height * 2.6 &&
          item.height >= notice.height * 0.8 && item.sourceIndex <= notice.sourceIndex + 4) {
        excluded.add(item.sourceIndex);
      }
    });
  }
  const visible = normalized.filter((item) => !excluded.has(item.sourceIndex) && String(item.str).trim());
  const visuals = pageVisualDrafts(visible, images, view);
  visuals.forEach((visual) => {
    visual.sourceItems = visible.filter((item) => centerInside(item, visual.bbox, view));
  });
  const readable = visible.filter((item) => !visuals.some((visual) => centerInside(item, visual.bbox, view)));
  const prepared = separateAuthorRows(readingOrderLines(readable), view);
  const rawLines = prepared.authors.length ? prepared.body : sourceOrderLines(readable);
  return { view, trust, normalized, excluded, visible, visuals, rawLines, authors: prepared.authors };
}

/**
 * Why two display rows did or did not soft-merge. Used to lock real PDF geometry.
 * Each row is one text-layer line: `{ text, x, y, width, height, formula }`.
 */
export function diagnoseDisplayMerge({ items, viewport, images } = {}) {
  const { view, rawLines } = preparedTextLines({ items, viewport, images });
  const pageWidth = Math.max(1, Number(view.width) || 1);
  const leading = pageBodyLeading(rawLines);
  const ordered = [...rawLines].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = ordered.map((line, index) => ({
    index,
    text: String(line.text || "").slice(0, 140),
    x: round3(line.x),
    y: round3(line.y),
    width: round3(line.width),
    height: round3(line.height),
    formula: isFormulaDisplayLine(line, pageWidth),
    relation: isRelationHead(line),
    blocking: hasBlockingProse(line.text)
  }));
  const joins = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const upper = ordered[index];
    const lower = ordered[index + 1];
    if (!isFormulaDisplayLine(upper, pageWidth) && !isFormulaDisplayLine(lower, pageWidth) &&
        !isRelationHead(lower)) continue;
    const nearest = upper;
    joins.push({
      upper: String(upper.text || "").slice(0, 80),
      lower: String(lower.text || "").slice(0, 80),
      dy: round3(Math.abs(upper.y - lower.y)),
      emRatio: round3(displayLineGapRatio(upper, lower)),
      ratio: round3(displayLineGapRatio(upper, lower, leading)),
      inkRatio: round3(inkGapRatio(upper, lower, leading)),
      leading: round3(leading),
      between: lineStrictlyBetween(upper, lower, ordered, [upper]),
      align: sharesDisplayAlignment(upper, lower, pageWidth),
      relationAlign: relationAligns(upper, lower, pageWidth),
      formulaUpper: isFormulaDisplayLine(upper, pageWidth),
      formulaLower: isFormulaDisplayLine(lower, pageWidth),
      relationLower: isRelationHead(lower),
      join: canJoinDisplayLine(lower, nearest, [upper], ordered, pageWidth, leading)
    });
  }
  return { leading: round3(leading), rows, joins };
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

/**
 * Page object for one digital PDF page.
 * `images` is `{ fnArray, argsArray }` from pdf.js getOperatorList, or CTM entries.
 */
export function textLayerToBlocks({ items, viewport, images, page, styles } = {}) {
  const pageNumber = Number(page) || 1;
  const { view, trust, normalized, excluded, visible, visuals, rawLines, authors } = preparedTextLines({
    items, viewport, images, styles
  });
  const displayGroups = displayFormulaGroups(rawLines, view);
  const lines = bibliographyFrom(rawLines.map(lineWithScripts));
  const drafts = [];
  let prose = [];
  let formulaSerial = 0;
  const formulaByToken = new Map();
  const nextFormula = () => {
    formulaSerial += 1;
    return formulaSerial;
  };
  const flushProse = () => {
    if (!prose.length) return;
    drafts.push(...proseDrafts(prose, lines, view, formulaByToken));
    prose = [];
  };
  const cropContext = { visible, visuals };
  const pushDisplay = (formulaItems) => {
    drafts.push(formulaDraft(formulaItems, view, {
      inline: false,
      obstacles: obstacleBoxes(visible, view, visuals, formulaItems),
      pageItems: visible
    }));
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const grouped = displayGroups.get(rawLines[lineIndex]);
    const cluster = grouped && groupLooksLikeDisplay(grouped.group, view.width);
    // Once the anchor is emitted as one display crop, later rows stay in it.
    // A margin continuation that keeps the anchor inline must not drop them,
    // unless the group is a real display cluster (wide, or numbered).
    if (grouped && grouped.anchor !== rawLines[lineIndex] && (grouped.emitted || cluster)) continue;
    // A numbered footnote can sit just one line-height below the final body
    // line. Its marker is smaller and near the page bottom; keep its source
    // sentence separate even when the generic paragraph gap does not fire.
    if (/^\d{1,2}(?:$|(?=[A-Z]))/.test(line.text) && line.y < view.height * 0.15 &&
        line.height < view.height * 0.012) flushProse();
    const continuation = isMarginContinuation(line, view, prose.length > 0, prose.at(-1));
    const parts = line.items || [];
    const formulaLine = parts.length > 0 && lineShouldBeOneFormula(parts);
    if (continuation && formulaLine && !cluster) {
      const raw = expandedItems(parts);
      if (isPlaintextFormulaSpan(parts)) {
        prose.push(plaintextLine(line, parts));
        continue;
      }
      const token = `⟦f${nextFormula()}⟧`;
      const formula = formulaDraft(raw, view, {
        inline: true,
        obstacles: obstacleBoxes(visible, view, visuals, raw),
        pageItems: visible
      });
      formulaByToken.set(token, { token, formula, source: line.text });
      prose.push({
        ...line,
        text: token,
        sourceText: line.text,
        items: [],
        math: false,
        fontName: ""
      });
      continue;
    }
    if (grouped && grouped.anchor === rawLines[lineIndex] && (!continuation || cluster)) {
      flushProse();
      pushDisplay(grouped.group.flatMap((part) => expandedItems(part.items || [])));
      grouped.emitted = true;
      continue;
    }
    if (formulaLine && parts.length && !continuation) {
      const raw = expandedItems(parts);
      if (isPlaintextFormulaSpan(parts)) {
        prose.push(plaintextLine(line, parts));
        continue;
      }
      flushProse();
      pushDisplay(raw);
      continue;
    }
    if (line.bibliography) {
      const freshEntry = /^\[\d+\]/.test(String(line.text || "").trim());
      if (freshEntry || !prose.length || !prose.at(-1).bibliography) flushProse();
      prose.push(lineWithInlineFormulas(line, view, nextFormula, formulaByToken, cropContext));
      continue;
    }
    prose.push(lineWithInlineFormulas(line, view, nextFormula, formulaByToken, cropContext));
  }
  flushProse();
  const titleAt = drafts.findIndex((draft) => draft.role === "title");
  if (titleAt >= 0 && authors.length) drafts.splice(titleAt + 1, 0, ...authors);
  const ordered = insertFigures(drafts, visuals);
  const blocks = toProtocol(ordered, pageNumber, trust);
  const kept = trust.trusted ? blocks : blocks.filter((block) => block.label === "figure");
  return preparePageBlocks({
    protocol: PROTOCOL,
    page: pageNumber,
    pixelWidth: Math.round((Number(view.width) || 0) * CROP_SCALE),
    pixelHeight: Math.round((Number(view.height) || 0) * CROP_SCALE),
    textSource: trust.trusted ? "text-layer" : "ocr",
    blocks: kept,
    sourceAudit: trust.trusted ? auditSources(normalized, excluded, ordered, blocks) : null
  });
}

export { looksLikeAuthorLine };
