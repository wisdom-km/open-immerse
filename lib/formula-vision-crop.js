/**
 * Hi-res tight crop sent to the vision model.
 * Screen crops stay on CROP_SCALE and FORMULA_INK_PAD_PX. This module does not
 * draw the page; the viewer renders at `scale` and passes the bitmap back.
 * Paragraph and full-page arms are not produced here.
 */

import { CROP_SCALE } from "./pdf-blocks.js";
import { cropPngFor, parseCropDataUrl } from "./formula-crop-png.js";
import {
  FORMULA_INK_MIN_SPAN,
  capFormulaRasterScale,
  formulaInkPadPx,
  formulaRegionWindow
} from "./pdf-formula-raster.js";
import {
  FORMULA_GLYPH_SCAN_PAD,
  boxesInCrop,
  measureFormulaCrop
} from "./pdf-text-layer.js";
import { sha256Hex } from "./sha256.js";

/** PDF render scale for the model image. CROP_SCALE × 2. */
export const VISION_CROP_SCALE = CROP_SCALE * 2;

/**
 * Paper kept outside ink, in the same pixel unit as FORMULA_INK_PAD_PX
 * (raster pixels at CROP_SCALE). formulaInkPadPx scales them onto the vision raster.
 * Inline 10 and display 14 sit in the approved 8–12 / 12–16 bands.
 * Protect is one pixel tighter to the screen protect step, still inside the band.
 */
export const VISION_INK_PAD_PX = Object.freeze({
  inline: 10,
  inlineProtect: 11,
  display: 14,
  displayProtect: 15
});

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function boxOf(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const box = value.slice(0, 4).map((n) => Number(n));
  if (box.some((n) => !Number.isFinite(n))) return null;
  if (!(box[2] > box[0]) || !(box[3] > box[1])) return null;
  return box;
}

export function visionBlockKind(block) {
  return {
    inline: block?.display === false || Boolean(block?.inlineOf),
    protect: block?.formulaInkProtect === true
  };
}

/** Content-aware box before the screen ink trim. The screen bbox is already tight. */
export function visionSourceBbox(block) {
  return boxOf(block?.layoutBbox) || boxOf(block?.bbox);
}

export function normalizeVisionScale(scale) {
  const next = finite(scale);
  return next > 0 ? next : VISION_CROP_SCALE;
}

/** Named pad is CROP_SCALE pixels. padPx is pixels on the vision raster. */
export function visionPadFor(block, scale = VISION_CROP_SCALE) {
  const kind = visionBlockKind(block);
  const namedPx = kind.inline
    ? (kind.protect ? VISION_INK_PAD_PX.inlineProtect : VISION_INK_PAD_PX.inline)
    : (kind.protect ? VISION_INK_PAD_PX.displayProtect : VISION_INK_PAD_PX.display);
  const next = normalizeVisionScale(scale);
  return {
    inline: kind.inline,
    protect: kind.protect,
    namedPx,
    padPx: formulaInkPadPx(namedPx, next, CROP_SCALE),
    scale: next
  };
}

export function visionMeasureOptions(block, scale = VISION_CROP_SCALE, padPx) {
  const pad = visionPadFor(block, scale);
  const ratio = formulaInkPadPx(1, pad.scale, CROP_SCALE);
  const pixels = finite(padPx) > 0 ? finite(padPx) : pad.padPx;
  return {
    inline: pad.inline,
    protect: pad.protect,
    padPx: pixels,
    minSpanX: FORMULA_INK_MIN_SPAN.x * ratio,
    minSpanY: FORMULA_INK_MIN_SPAN.y * ratio,
    scale: pad.scale
  };
}

/**
 * Pixel size of `bbox` at the vision scale. Caps match the screen bitmap limits
 * so a huge formula steps the scale down instead of allocating a failed canvas.
 */
export function visionRasterPlan({
  bbox,
  pageWidth,
  pageHeight,
  scale = VISION_CROP_SCALE,
  maxEdge,
  maxPixels
} = {}) {
  const source = boxOf(bbox);
  const pageW = finite(pageWidth);
  const pageH = finite(pageHeight);
  if (!source || !(pageW > 0) || !(pageH > 0)) return null;
  const pdfW = (source[2] - source[0]) * pageW;
  const pdfH = (source[3] - source[1]) * pageH;
  if (!(pdfW > 0) || !(pdfH > 0)) return null;
  const requested = normalizeVisionScale(scale);
  const fitted = capFormulaRasterScale(requested, pdfW, pdfH, { maxEdge, maxPixels });
  const crop = formulaRegionWindow(source, pageW * fitted, pageH * fitted);
  if (!(crop.pixelWidth > 0) || !(crop.pixelHeight > 0)) return null;
  return {
    scale: fitted,
    requestedScale: requested,
    capped: fitted + 1e-6 < requested,
    pixelWidth: crop.pixelWidth,
    pixelHeight: crop.pixelHeight,
    offsetX: crop.offsetX,
    offsetY: crop.offsetY,
    pdfWidth: pdfW,
    pdfHeight: pdfH
  };
}

function mapRelativeToPage(source, relative) {
  const w = source[2] - source[0];
  const h = source[3] - source[1];
  return [
    source[0] + relative[0] * w,
    source[1] + relative[1] * h,
    source[0] + relative[2] * w,
    source[1] + relative[3] * h
  ];
}

/**
 * Tight crop inside a raster that covers `sourceBbox` (page fractions).
 * The bitmap may be the whole page or only the layout box. Glyph scan opens
 * far enough for the vision pad, then stops at the source box. Neighbor ink
 * still goes through the existing mask boxes.
 */
export function measureVisionRegion(block, image, {
  scale = VISION_CROP_SCALE,
  sourceBbox = null,
  padPx
} = {}) {
  const source = boxOf(sourceBbox) || visionSourceBbox(block);
  const width = image?.width | 0;
  const height = image?.height | 0;
  if (!source || !width || !height) return null;
  const options = visionMeasureOptions(block, scale, padPx);
  const spanX = width > 0 ? options.padPx / width : 0;
  const spanY = height > 0 ? options.padPx / height : 0;
  const measured = measureFormulaCrop([0, 0, 1, 1], image, {
    inline: options.inline,
    protect: options.protect,
    padPx: options.padPx,
    minSpanX: options.minSpanX,
    minSpanY: options.minSpanY,
    scanPad: {
      x: Math.max(FORMULA_GLYPH_SCAN_PAD.x, spanX),
      y: Math.max(FORMULA_GLYPH_SCAN_PAD.y, spanY)
    },
    glyphBoxes: boxesInCrop(block?.glyphBoxes, source),
    maskBoxes: boxesInCrop(block?.maskBoxes, source)
  });
  const relative = boxOf(measured?.bbox);
  if (!relative) return null;
  return {
    relativeBbox: relative,
    pageBbox: mapRelativeToPage(source, relative),
    padPx: options.padPx,
    namedPx: visionPadFor(block, options.scale).namedPx,
    scale: options.scale,
    inline: options.inline,
    protect: options.protect,
    inkShare: measured?.inkShare ?? null
  };
}

export function visionCropCacheKey({
  docId = "",
  page = 0,
  bbox = [],
  scale = 0,
  namedPx = 0,
  inline = false,
  protect = false
} = {}) {
  const box = (Array.isArray(bbox) ? bbox : []).map((n) => finite(n).toFixed(4)).join(",");
  return [
    "vision",
    docId,
    page,
    box,
    finite(scale).toFixed(4),
    finite(namedPx),
    inline ? 1 : 0,
    protect ? 1 : 0
  ].join("|");
}

/**
 * What the renderer should draw. Paragraph and page arms collapse to the tight crop.
 * `pad.namedPx` is the CROP_SCALE-pixel pad. `pad.padPx` is the vision-raster pad.
 */
export function visionCropSpec(block, hooks = {}) {
  const scale = normalizeVisionScale(hooks.scale);
  const namedOverride = finite(hooks.pad);
  const pad = visionPadFor(block, scale);
  const namedPx = namedOverride > 0 ? namedOverride : pad.namedPx;
  return {
    mode: "tight",
    scale,
    pad: {
      inline: pad.inline,
      protect: pad.protect,
      namedPx,
      padPx: formulaInkPadPx(namedPx, scale, CROP_SCALE)
    },
    paragraph: null
  };
}

function hashOf(base64) {
  return sha256Hex(String(base64 || "")).slice(0, 12);
}

function carriedModelPng(block) {
  const pixels = block?.crop?.pixels;
  if (typeof pixels !== "string" || !pixels) return null;
  if (/^https?:/i.test(pixels) || /^data:/i.test(pixels)) return null;
  return parseCropDataUrl(`data:image/png;base64,${pixels}`);
}

function payloadOf(value) {
  if (!value || typeof value !== "object") return null;
  const base64 = String(value.base64 || "");
  if (!base64 || /^https?:/i.test(base64)) return null;
  if (value.mime && value.mime !== "image/png") return null;
  return {
    mime: "image/png",
    base64,
    w: value.w,
    h: value.h,
    hash: value.hash || hashOf(base64)
  };
}

function coerceRendered(rendered) {
  if (!rendered) return null;
  if (typeof rendered === "string") return parseCropDataUrl(rendered);
  if (typeof rendered.url === "string") {
    const parsed = parseCropDataUrl(rendered.url);
    if (parsed) return parsed;
  }
  const payload = payloadOf(rendered);
  if (!payload) return null;
  const parsed = parseCropDataUrl(`data:image/png;base64,${payload.base64}`);
  return parsed || null;
}

/**
 * PNG the multimodal tier sends.
 * Already-extracted model pixels win, so a second lookup does not redraw.
 * Otherwise `renderVisionCrop` paints the hi-res tight crop. A miss falls
 * back to the page-raster PNG. `block.imageUrl` is the screen bitmap and is
 * not preferred over the render hook.
 *
 * @returns {Promise<{mime:string, base64:string, w?:number, h?:number, hash:string, meta:object} | null>}
 */
export async function visionCropFor(block, hooks = {}) {
  if (hooks?.isStale?.()) return null;
  const carried = carriedModelPng(block);
  if (carried) {
    return { ...carried, meta: { mode: "tight", kind: "carried" } };
  }
  const spec = visionCropSpec(block, hooks);
  if (typeof hooks.renderVisionCrop === "function") {
    let rendered = null;
    try {
      rendered = await hooks.renderVisionCrop(block, spec);
    } catch {
      rendered = null;
    }
    if (hooks?.isStale?.()) return null;
    const png = coerceRendered(rendered);
    if (png) {
      return {
        ...png,
        meta: {
          mode: "tight",
          kind: "vision",
          scale: spec.scale,
          pad: spec.pad.namedPx,
          padPx: spec.pad.padPx,
          inline: spec.pad.inline
        }
      };
    }
  }
  if (hooks?.isStale?.()) return null;
  let fallback = null;
  try {
    fallback = typeof hooks.cropPngFor === "function"
      ? await hooks.cropPngFor(block, hooks)
      : await cropPngFor(block, hooks);
  } catch {
    fallback = null;
  }
  if (hooks?.isStale?.()) return null;
  const png = payloadOf(fallback);
  if (!png) return null;
  return {
    ...png,
    meta: { mode: "tight", kind: "page-raster", scale: CROP_SCALE }
  };
}
