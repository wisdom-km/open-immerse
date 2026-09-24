/**
 * Right-pane body size from the PDF text layer.
 * Item height is in page units (viewport scale 1). Map it by the paper
 * width, then apply the CJK factor. A weak sample keeps the CSS fallback.
 */

import { textLayerTrust } from "./pdf-blocks.js";

/** Previous `.oi-pdf-p` size. Used only when the text layer is not trusted. */
export const BODY_FONT_FALLBACK_PX = 15;
/** CJK glyphs at the Latin em look larger. Locked band 0.92–1.0. */
export const CJK_BODY_FACTOR = 0.96;
export const CJK_BODY_FACTOR_MIN = 0.92;
export const CJK_BODY_FACTOR_MAX = 1.0;
/** Below this, a page does not have a stable body size. */
export const BODY_FONT_MIN_ITEMS = 8;
/** The modal cluster must be at least this share of measured items. */
export const BODY_FONT_MODE_SHARE = 0.4;

export function clampCjkBodyFactor(value = CJK_BODY_FACTOR) {
  const n = Number(value);
  const factor = Number.isFinite(n) ? n : CJK_BODY_FACTOR;
  return Math.min(CJK_BODY_FACTOR_MAX, Math.max(CJK_BODY_FACTOR_MIN, factor));
}

function itemFontHeight(item) {
  const height = Number(item?.height);
  if (height > 0 && Number.isFinite(height)) return height;
  const transform = Array.isArray(item?.transform) ? item.transform : null;
  if (!transform) return 0;
  const fromTransform = Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0);
  return fromTransform > 0 && Number.isFinite(fromTransform) ? fromTransform : 0;
}

function median(values) {
  const list = [...values].sort((a, b) => a - b);
  if (!list.length) return 0;
  return list[Math.floor(list.length / 2)];
}

/**
 * Modal body height in page units. Ties break toward the median so a
 * short footnote cluster does not beat the body when counts match.
 * Returns null when the sample is too small or no cluster dominates.
 */
export function bodyItemHeight(items) {
  const heights = [];
  for (const item of items || []) {
    if (!String(item?.str ?? item?.text ?? "").trim()) continue;
    const height = itemFontHeight(item);
    if (height > 0) heights.push(height);
  }
  if (heights.length < BODY_FONT_MIN_ITEMS) return null;
  const bins = new Map();
  for (const height of heights) {
    const key = Math.round(height * 10) / 10;
    const bin = bins.get(key);
    if (bin) bin.push(height);
    else bins.set(key, [height]);
  }
  const mid = median(heights);
  let best = null;
  for (const [key, bin] of bins) {
    const rank = { key, count: bin.length, distance: Math.abs(key - mid) };
    if (!best || rank.count > best.count || (rank.count === best.count && rank.distance < best.distance)) {
      best = rank;
    }
  }
  if (!best) return null;
  const window = 0.35;
  const cluster = heights.filter((height) => Math.abs(height - best.key) <= window);
  if (cluster.length / heights.length < BODY_FONT_MODE_SHARE) return null;
  const body = median(cluster);
  return body > 0 ? body : null;
}

/**
 * Trust plus the page-unit body height. `trusted` is false for a garbled
 * layer or a sample with no dominant body size.
 */
export function describeBodyFont(items, { pageWidth, pageHeight } = {}) {
  const page = Number(pageWidth);
  const height = Number(pageHeight);
  const trust = textLayerTrust(items);
  const body = trust.trusted ? bodyItemHeight(items) : null;
  const trusted = Boolean(trust.trusted && body > 0 && page > 0);
  return {
    trusted,
    reason: trusted ? "text-layer" : (trust.trusted ? "low-sample" : trust.reason),
    bodyItemHeight: body > 0 ? body : null,
    pageWidth: page > 0 ? page : null,
    pageHeight: height > 0 ? height : null
  };
}

/**
 * CSS px for the right-pane body. `paperWidth / pageWidth` is the same
 * scale as the paper. Low trust returns a null px so the 15px fallback stays.
 */
export function mapBodyFontPx({
  bodyHeight,
  pageWidth,
  paperWidth,
  trusted = true,
  cjkFactor = CJK_BODY_FACTOR
} = {}) {
  const factor = clampCjkBodyFactor(cjkFactor);
  if (trusted === false) return { px: null, source: "fallback", reason: "trust", factor };
  const body = Number(bodyHeight);
  const page = Number(pageWidth);
  const paper = Number(paperWidth);
  if (!(body > 0) || !(page > 0) || !(paper > 0)) {
    return { px: null, source: "fallback", reason: "geometry", factor };
  }
  const px = body * (paper / page) * factor;
  if (!(px > 0) || !Number.isFinite(px)) return { px: null, source: "fallback", reason: "nan", factor };
  return {
    px,
    source: "text-layer",
    reason: "text-layer",
    bodyHeight: body,
    factor
  };
}

/** Measure items and map them. One call for tests and for a live page. */
export function bodyFontPxFromItems({ items, pageWidth, pageHeight, paperWidth, cjkFactor } = {}) {
  const described = describeBodyFont(items, { pageWidth, pageHeight });
  const mapped = mapBodyFontPx({
    bodyHeight: described.bodyItemHeight,
    pageWidth: described.pageWidth,
    paperWidth,
    trusted: described.trusted,
    cjkFactor
  });
  return { ...mapped, described };
}
