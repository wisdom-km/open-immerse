/**
 * Node adapter for the product hi-res vision crop (F7W-1 / mm-3).
 *
 * Measurement, scale, and pad come from lib/formula-vision-crop.js.
 * The pixel steps follow pdf/viewer.js renderVisionFormulaCrop: render the
 * layout box at the vision scale, tight-crop with measureVisionRegion, then
 * mask neighbor ink. This file does not change the product prompt or defaults.
 *
 * The paragraph and context crops are script-only. They render at the same
 * vision scale and do not go through visionCropSpec (that spec stays tight).
 * Both draw a red rectangle outside the target glyphs.
 */

export const TARGET_BOX_COLOR = "#e10600";
export const TARGET_BOX_PX = 3;
/** White pixels between the context stroke and the glyph box. Paragraph seating uses the same gap. */
export const TARGET_BOX_GAP = 2;

import { createRequire } from "node:module";
import { deflateSync, inflateSync } from "node:zlib";

import { CROP_SCALE, rasterCropRect } from "../lib/pdf-blocks.js";
import { parseCropDataUrl } from "../lib/formula-crop-png.js";
import { formulaInkPadPx, formulaRegionWindow } from "../lib/pdf-formula-raster.js";
import { blankFormulaMask, boxesInCrop, measureFormulaCrop } from "../lib/pdf-text-layer.js";
import {
  VISION_CROP_SCALE,
  measureVisionRegion,
  visionPadFor,
  visionRasterPlan,
  visionSourceBbox
} from "../lib/formula-vision-crop.js";
import { contextWindow } from "../lib/mm-dpo-ab.js";

const require = createRequire(import.meta.url);

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
  }
  return (~crc) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.from(data);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  const name = Buffer.from(type);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(Buffer.concat([name, body])), 0);
  return Buffer.concat([head, name, body, sum]);
}

/** RGBA PNG. Callers only need a real IHDR; the bytes are still a valid image. */
export function decodeRgbaPng(base64) {
  const buf = Buffer.from(String(base64 || ""), "base64");
  if (buf.length < 8) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts = [];
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + len;
    if (end + 4 > buf.length) return null;
    if (type === "IHDR") {
      width = buf.readUInt32BE(start);
      height = buf.readUInt32BE(start + 4);
    } else if (type === "IDAT") parts.push(buf.subarray(start, end));
    else if (type === "IEND") break;
    offset = end + 4;
  }
  if (!(width > 0) || !(height > 0) || !parts.length) return null;
  const raw = inflateSync(Buffer.concat(parts));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    const from = y * (stride + 1) + 1;
    rgba.set(raw.subarray(from, from + stride), y * stride);
  }
  return { width, height, rgba };
}

export function encodeRgbaPng(width, height, rgba) {
  const w = width | 0;
  const h = height | 0;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  const source = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < h; y += 1) {
    const at = y * (stride + 1);
    raw[at] = 0;
    source.copy(raw, at + 1, y * stride, (y + 1) * stride);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function colorOf(style) {
  const raw = String(style || "").trim().toLowerCase();
  if (raw === "white" || raw === "#fff" || raw === "#ffffff") return [255, 255, 255, 255];
  if (raw === "black" || raw === "#000" || raw === "#000000") return [0, 0, 0, 255];
  const hex = raw.match(/^#([0-9a-f]{6})$/);
  if (!hex) return [0, 0, 0, 255];
  const value = hex[1];
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    255
  ];
}

/**
 * Small canvas for dry-run tests. Live PDF rendering uses @napi-rs/canvas.
 * Pixel storage is enough for measureVisionRegion and a real PNG header.
 */
export function createMemoryCanvas(width, height) {
  let w = Math.max(0, width | 0);
  let h = Math.max(0, height | 0);
  let data = new Uint8ClampedArray(w * h * 4);
  const canvas = {};
  const ctx = {
    canvas,
    fillStyle: "#000000",
    globalCompositeOperation: "source-over",
    fillRect(x, y, rw, rh) {
      const color = colorOf(ctx.fillStyle);
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(w, Math.ceil(x + rw));
      const y1 = Math.min(h, Math.ceil(y + rh));
      const over = ctx.globalCompositeOperation === "destination-over";
      for (let py = y0; py < y1; py += 1) {
        for (let px = x0; px < x1; px += 1) {
          const index = (py * w + px) * 4;
          if (over && data[index + 3] >= 16) continue;
          data[index] = color[0];
          data[index + 1] = color[1];
          data[index + 2] = color[2];
          data[index + 3] = color[3];
        }
      }
    },
    getImageData(sx, sy, sw, sh) {
      const iw = Math.max(0, sw | 0);
      const ih = Math.max(0, sh | 0);
      const copy = new Uint8ClampedArray(iw * ih * 4);
      for (let py = 0; py < ih; py += 1) {
        for (let px = 0; px < iw; px += 1) {
          const from = ((sy + py) * w + (sx + px)) * 4;
          const to = (py * iw + px) * 4;
          if (from < 0 || from + 3 >= data.length) continue;
          copy[to] = data[from];
          copy[to + 1] = data[from + 1];
          copy[to + 2] = data[from + 2];
          copy[to + 3] = data[from + 3];
        }
      }
      return { data: copy, width: iw, height: ih };
    },
    putImageData(image, dx, dy) {
      const iw = image?.width | 0;
      const ih = image?.height | 0;
      const source = image?.data;
      if (!source) return;
      for (let py = 0; py < ih; py += 1) {
        for (let px = 0; px < iw; px += 1) {
          const tx = dx + px;
          const ty = dy + py;
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          const from = (py * iw + px) * 4;
          const to = (ty * w + tx) * 4;
          data[to] = source[from];
          data[to + 1] = source[from + 1];
          data[to + 2] = source[from + 2];
          data[to + 3] = source[from + 3];
        }
      }
    },
    drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
      const src = source?.getContext?.("2d")?.getImageData?.(0, 0, source.width, source.height);
      if (!src) return;
      const rectW = sw | 0;
      const rectH = sh | 0;
      const outW = dw | 0;
      const outH = dh | 0;
      if (rectW < 1 || rectH < 1 || outW < 1 || outH < 1) return;
      for (let py = 0; py < outH; py += 1) {
        for (let px = 0; px < outW; px += 1) {
          const fromX = (sx | 0) + Math.floor(px * rectW / outW);
          const fromY = (sy | 0) + Math.floor(py * rectH / outH);
          if (fromX < 0 || fromY < 0 || fromX >= src.width || fromY >= src.height) continue;
          const tx = (dx | 0) + px;
          const ty = (dy | 0) + py;
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          const from = (fromY * src.width + fromX) * 4;
          const to = (ty * w + tx) * 4;
          data[to] = src.data[from];
          data[to + 1] = src.data[from + 1];
          data[to + 2] = src.data[from + 2];
          data[to + 3] = src.data[from + 3];
        }
      }
    }
  };
  Object.defineProperty(canvas, "width", {
    get() { return w; },
    set(value) {
      w = Math.max(0, value | 0);
      data = new Uint8ClampedArray(w * h * 4);
    }
  });
  Object.defineProperty(canvas, "height", {
    get() { return h; },
    set(value) {
      h = Math.max(0, value | 0);
      data = new Uint8ClampedArray(w * h * 4);
    }
  });
  canvas.getContext = () => ctx;
  canvas.toDataURL = () => {
    if (!(w > 0) || !(h > 0)) return "";
    const png = encodeRgbaPng(w, h, data);
    return `data:image/png;base64,${png.toString("base64")}`;
  };
  return canvas;
}

export function visionCanvasAvailable() {
  try {
    require("@napi-rs/canvas");
    return true;
  } catch {
    return false;
  }
}

function defaultCreateCanvas(width, height) {
  let lib;
  try {
    lib = require("@napi-rs/canvas");
  } catch {
    const error = new Error("高清裁图需要 @napi-rs/canvas。在仓库根目录运行 npm ci。");
    error.code = "no-canvas";
    throw error;
  }
  return lib.createCanvas(width, height);
}

function compositeWhitePaper(context, canvas) {
  if (!context || !canvas) return;
  const previous = context.globalCompositeOperation;
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = previous || "source-over";
}

function paintFormulaMask(canvas, crop, block) {
  if (!canvas || block?.label !== "formula" || !block.maskBoxes?.length) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.getImageData !== "function") return false;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  blankFormulaMask(image, {
    maskBoxes: boxesInCrop(block.maskBoxes, crop),
    glyphBoxes: boxesInCrop(block.glyphBoxes, crop),
    seedBoxes: boxesInCrop(block.seedBoxes, crop)
  });
  ctx.putImageData(image, 0, 0);
  return true;
}

function cropCanvas(canvas, relativeBbox, createCanvas, alwaysCopy = false) {
  if (!canvas || !Array.isArray(relativeBbox) || relativeBbox.length < 4) return null;
  const rect = rasterCropRect(relativeBbox, canvas.width, canvas.height);
  if (rect.sw < 1 || rect.sh < 1) return null;
  if (!alwaysCopy && rect.sx === 0 && rect.sy === 0 && rect.sw === canvas.width && rect.sh === canvas.height) return canvas;
  const out = createCanvas(rect.sw, rect.sh);
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.sw, rect.sh);
  return out;
}

function release(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // A host canvas that rejects resize still has its PNG already encoded.
  }
}

/** Page-fraction box → integer pixels on a crop whose origin is `crop`. */
export function targetBoxPixels(crop, target, pageWidth, pageHeight, scale) {
  const fullW = pageWidth * scale;
  const fullH = pageHeight * scale;
  if (!(fullW > 0) || !(fullH > 0) || !Array.isArray(crop) || !Array.isArray(target)) return null;
  const x = Math.round((target[0] - crop[0]) * fullW);
  const y = Math.round((target[1] - crop[1]) * fullH);
  const x2 = Math.round((target[2] - crop[0]) * fullW);
  const y2 = Math.round((target[3] - crop[1]) * fullH);
  const w = x2 - x;
  const h = y2 - y;
  if (!(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

/** Stroke outside `rect` so the glyphs inside stay unpainted. `gap` is extra white pixels. */
export function paintTargetBox(canvas, rect, thickness = TARGET_BOX_PX, gap = 0) {
  if (!canvas || !rect || !(rect.w > 0) || !(rect.h > 0)) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.fillRect !== "function") return false;
  const t = thickness > 0 ? thickness : TARGET_BOX_PX;
  const g = gap > 0 ? gap : 0;
  const { x, y, w, h } = rect;
  ctx.fillStyle = TARGET_BOX_COLOR;
  ctx.fillRect(x - t - g, y - t - g, w + 2 * (t + g), t);
  ctx.fillRect(x - t - g, y + h + g, w + 2 * (t + g), t);
  ctx.fillRect(x - t - g, y - g, t, h + 2 * g);
  ctx.fillRect(x + w + g, y - g, t, h + 2 * g);
  return true;
}

function strokeGap(rect, width, height, thickness, gap) {
  if (!(gap > 0) || !rect || !(width > 0) || !(height > 0)) return 0;
  const room = Math.min(
    rect.x,
    rect.y,
    width - (rect.x + rect.w),
    height - (rect.y + rect.h)
  );
  return Math.max(0, Math.min(gap, Math.floor(room) - thickness));
}

function darkPixel(rgba, width, x, y) {
  const index = (y * width + x) * 4;
  return rgba[index] < 96 && rgba[index + 1] < 96 && rgba[index + 2] < 96 && rgba[index + 3] > 180;
}

function inkBands(rgba, width, x0, x1, y0, y1) {
  const bands = [];
  const span = Math.max(1, x1 - x0 + 1);
  const minCount = Math.max(8, Math.floor(span * 0.015));
  let start = -1;
  let hole = 0;
  for (let y = y0; y <= y1; y += 1) {
    let count = 0;
    for (let x = x0; x <= x1; x += 1) {
      if (darkPixel(rgba, width, x, y)) count += 1;
    }
    if (count >= minCount) {
      if (start < 0) start = y;
      hole = 0;
    } else if (start >= 0) {
      hole += 1;
      if (hole > 4) {
        bands.push([start, y - hole]);
        start = -1;
        hole = 0;
      }
    }
  }
  if (start >= 0) bands.push([start, y1 - hole]);
  return bands.filter((band) => band[1] >= band[0]);
}

/**
 * Pull a paragraph box edge off a neighboring text line into the gap.
 * Interior bands stay, so a detector box that also contains the next line
 * (p4-b7's "where Z(x)=…") is not trimmed away. Edges only move inward.
 */
export function seatTargetRect(image, rect, { thickness = TARGET_BOX_PX, gap = TARGET_BOX_GAP } = {}) {
  const rgba = image?.rgba || image?.data;
  if (!rgba || !rect || !(rect.w > 0) || !(rect.h > 0)) return rect;
  const width = image.width | 0;
  const height = image.height | 0;
  if (!(width > 0) || !(height > 0)) return rect;
  const x0 = Math.max(0, Math.min(width - 1, rect.x));
  const x1 = Math.max(x0, Math.min(width - 1, rect.x + rect.w - 1));
  const y0 = Math.max(0, Math.min(height - 1, rect.y));
  const y1 = Math.max(y0, Math.min(height - 1, rect.y + rect.h - 1));
  const bands = inkBands(rgba, width, x0, x1, Math.max(0, y0 - 80), Math.min(height - 1, y1 + 80));
  const roleOf = (band) => {
    const [top, bottom] = band;
    const insideTop = Math.max(top, y0);
    const insideBottom = Math.min(bottom, y1);
    const inside = insideBottom >= insideTop ? insideBottom - insideTop + 1 : 0;
    const above = Math.max(0, y0 - top);
    const below = Math.max(0, bottom - y1);
    if (inside === 0) return above > 0 ? "above" : "below";
    if (above >= 4 && inside <= Math.max(8, above)) return "above";
    if (below >= 4 && inside <= Math.max(8, below)) return "below";
    return "content";
  };
  const tagged = bands.map((band) => ({ band, role: roleOf(band) }));
  const aboveBands = tagged.filter((item) => item.role === "above");
  let content = tagged.filter((item) => item.role === "content").map((item) => item.band);
  let droppedTail = -1;
  if (aboveBands.length && content.length > 1) {
    const neighborEnd = aboveBands.reduce((max, item) => Math.max(max, item.band[1]), -1);
    const first = content[0];
    const second = content[1];
    const tail = first[1] - first[0] + 1;
    const gapToNeighbor = first[0] - neighborEnd - 1;
    const gapToNext = second[0] - first[1] - 1;
    if (tail <= 12 && gapToNeighbor <= thickness + gap && gapToNext >= 16) {
      droppedTail = first[1];
      content = content.slice(1);
    }
  }
  if (!content.length) return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  const contentTop = Math.max(y0, Math.min(...content.map((band) => band[0])));
  const contentBottom = Math.min(y1, Math.max(...content.map((band) => band[1])));
  const aboveBottom = Math.max(
    droppedTail,
    bands.filter((band) => roleOf(band) === "above").reduce((max, band) => Math.max(max, band[1]), -1)
  );
  const belowTop = bands.filter((band) => roleOf(band) === "below").reduce((min, band) => Math.min(min, band[0]), height);
  const t = thickness > 0 ? thickness : TARGET_BOX_PX;
  const g = gap > 0 ? gap : 0;
  let top = rect.y;
  let bottom = rect.y + rect.h;
  const clearAbove = aboveBottom >= 0 ? contentTop - aboveBottom - 1 : contentTop - y0 + t + g;
  if (aboveBottom >= 0 && clearAbove >= t) {
    const usedGap = Math.min(g, clearAbove - t);
    const seated = contentTop - usedGap;
    if (seated > top) top = seated;
  } else if (contentTop > y0 + 4) {
    const seated = contentTop - Math.min(g, contentTop - y0);
    if (seated > top) top = seated;
  }
  const clearBelow = belowTop < height ? belowTop - contentBottom - 1 : y1 - contentBottom + t + g;
  if (belowTop < height && clearBelow >= t) {
    const usedGap = Math.min(g, clearBelow - t);
    const seated = contentBottom + 1 + usedGap;
    if (seated < bottom) bottom = seated;
  } else if (contentBottom < y1 - 4) {
    const seated = contentBottom + 1 + Math.min(g, y1 - contentBottom);
    if (seated < bottom) bottom = seated;
  }
  if (!(bottom > top)) return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  return { x: rect.x, y: top, w: rect.w, h: bottom - top };
}

function paintFormulaFrame(page, canvas, cropBbox, targetBbox, scale, gap = 0) {
  if (!page || typeof page.getViewport !== "function") return false;
  let unit = null;
  try {
    unit = page.getViewport({ scale: 1 });
  } catch {
    return false;
  }
  const rect = targetBoxPixels(cropBbox, targetBbox, unit.width, unit.height, scale);
  if (!rect) return false;
  let image = null;
  try {
    image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    image = null;
  }
  const seated = gap > 0 || !image ? rect : seatTargetRect(image, rect);
  const fitted = strokeGap(seated, canvas.width, canvas.height, TARGET_BOX_PX, gap);
  return paintTargetBox(canvas, seated, TARGET_BOX_PX, fitted);
}

/**
 * Paragraph bitmap is the paragraph box grown so the red stroke is inside the
 * crop. Context and hi-res windows are not this function.
 */
export function paragraphCropBbox(formula, pageWidth, pageHeight, scale = VISION_CROP_SCALE) {
  const column = Array.isArray(formula?.paragraphBbox) ? formula.paragraphBbox : null;
  const target = Array.isArray(formula?.layoutBbox) ? formula.layoutBbox : formula?.bbox;
  if (!column && !Array.isArray(target)) return null;
  const width = Number(pageWidth) > 0 ? Number(pageWidth) : 1;
  const height = Number(pageHeight) > 0 ? Number(pageHeight) : 1;
  const used = scale > 0 ? scale : VISION_CROP_SCALE;
  const padX = (TARGET_BOX_PX + TARGET_BOX_GAP + 2) / (width * used);
  const padY = (TARGET_BOX_PX + TARGET_BOX_GAP + 2) / (height * used);
  let crop = column ? column.slice(0, 4) : target.slice(0, 4);
  if (Array.isArray(target)) {
    crop = [
      Math.min(crop[0], target[0] - padX),
      Math.min(crop[1], target[1] - padY),
      Math.max(crop[2], target[2] + padX),
      Math.max(crop[3], target[3] + padY)
    ];
  }
  return [
    Math.max(0, crop[0]),
    Math.max(0, crop[1]),
    Math.min(1, crop[2]),
    Math.min(1, crop[3])
  ];
}

function pngOf(canvas) {
  if (!canvas) return null;
  if (typeof canvas.toDataURL === "function") {
    const url = canvas.toDataURL("image/png");
    const parsed = parseCropDataUrl(url);
    if (parsed) return parsed;
  }
  if (typeof canvas.toBuffer === "function") {
    const base64 = canvas.toBuffer("image/png").toString("base64");
    return parseCropDataUrl(`data:image/png;base64,${base64}`);
  }
  return null;
}

async function renderWindow(page, bbox, scale, hooks) {
  if (!page || typeof page.getViewport !== "function" || !Array.isArray(bbox)) return null;
  let unit = null;
  try {
    unit = page.getViewport({ scale: 1 });
  } catch {
    return null;
  }
  const plan = visionRasterPlan({
    bbox,
    pageWidth: unit.width,
    pageHeight: unit.height,
    scale: scale > 0 ? scale : VISION_CROP_SCALE
  });
  if (!plan || plan.pixelWidth < 1 || plan.pixelHeight < 1) return null;
  const createCanvas = hooks.createCanvas || defaultCreateCanvas;
  let full = null;
  try {
    full = page.getViewport({ scale: plan.scale });
  } catch {
    return null;
  }
  const fitted = formulaRegionWindow(bbox, full.width, full.height);
  if (fitted.pixelWidth < 1 || fitted.pixelHeight < 1) return null;
  const viewport = page.getViewport({
    scale: plan.scale,
    offsetX: -bbox[0] * full.width,
    offsetY: -bbox[1] * full.height
  });
  const canvas = createCanvas(fitted.pixelWidth, fitted.pixelHeight);
  const context = canvas.getContext("2d");
  if (!context) {
    release(canvas);
    return null;
  }
  try {
    const task = page.render({ canvasContext: context, viewport });
    await (task?.promise || task);
  } catch {
    release(canvas);
    return null;
  }
  compositeWhitePaper(context, canvas);
  return { canvas, plan, createCanvas };
}

/**
 * Same crop the viewer asks renderVisionCrop to paint.
 * Returns a PNG data URL, or "" when the page cannot be drawn.
 */
export async function renderVisionCrop(page, block, spec = {}, hooks = {}) {
  if (!page || block?.label !== "formula") return "";
  const source = visionSourceBbox(block);
  if (!source) return "";
  const requested = Number(spec?.scale) > 0 ? Number(spec.scale) : VISION_CROP_SCALE;
  const drawn = await renderWindow(page, source, requested, hooks);
  if (!drawn) return "";
  const pad = visionPadFor(block, drawn.plan.scale);
  const namedPx = Number(spec?.pad?.namedPx) > 0 ? Number(spec.pad.namedPx) : pad.namedPx;
  let image = null;
  try {
    image = drawn.canvas.getContext("2d").getImageData(0, 0, drawn.canvas.width, drawn.canvas.height);
  } catch {
    image = null;
  }
  const measured = image
    ? measureVisionRegion(block, image, {
      scale: drawn.plan.scale,
      sourceBbox: source,
      padPx: formulaInkPadPx(namedPx, drawn.plan.scale)
    })
    : null;
  let out = drawn.canvas;
  let pageBbox = source;
  if (measured?.relativeBbox) {
    const tight = cropCanvas(drawn.canvas, measured.relativeBbox, drawn.createCanvas);
    if (tight) {
      out = tight;
      pageBbox = measured.pageBbox || source;
    }
  }
  paintFormulaMask(out, pageBbox, block);
  const png = pngOf(out);
  if (out !== drawn.canvas) release(out);
  release(drawn.canvas);
  if (!png) return "";
  return `data:image/png;base64,${png.base64}`;
}

const tightPageCache = new WeakMap();

async function pageAtCropScale(page, hooks) {
  if (!page || typeof page.getViewport !== "function") return null;
  const cached = tightPageCache.get(page);
  if (cached) return cached;
  let viewport = null;
  try {
    viewport = page.getViewport({ scale: CROP_SCALE });
  } catch {
    return null;
  }
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const createCanvas = hooks.createCanvas || defaultCreateCanvas;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    const task = page.render({ canvasContext: context, viewport });
    await (task?.promise || task);
  } catch {
    release(canvas);
    return null;
  }
  compositeWhitePaper(context, canvas);
  let image = null;
  try {
    image = context.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    image = null;
  }
  if (!image) {
    release(canvas);
    return null;
  }
  const raster = { canvas, image, createCanvas };
  tightPageCache.set(page, raster);
  return raster;
}

/**
 * Product tight crop at CROP_SCALE. Pad stays on measureFormulaCrop's default
 * (inline 4 / display 6). The page raster is cached; the returned PNG is a copy.
 */
export async function renderTightCrop(page, formula, hooks = {}) {
  const bbox = Array.isArray(formula?.layoutBbox) ? formula.layoutBbox : formula?.bbox;
  if (!page || !Array.isArray(bbox)) return null;
  const raster = await pageAtCropScale(page, hooks);
  if (!raster) return null;
  const inline = formula.display === false || Boolean(formula.inlineOf);
  const measured = measureFormulaCrop(bbox, raster.image, {
    inline,
    protect: formula.formulaInkProtect === true,
    maskBoxes: formula.maskBoxes,
    glyphBoxes: formula.glyphBoxes
  });
  const cropBox = measured?.bbox || bbox;
  const rect = rasterCropRect(cropBox, raster.canvas.width, raster.canvas.height);
  if (rect.sw < 24 || rect.sh < 12) return null;
  const out = cropCanvas(raster.canvas, cropBox, raster.createCanvas, true);
  if (!out) return null;
  paintFormulaMask(out, cropBox, {
    label: "formula",
    maskBoxes: formula.maskBoxes || [],
    glyphBoxes: formula.glyphBoxes || [],
    seedBoxes: formula.seedBoxes || []
  });
  const png = pngOf(out);
  release(out);
  if (!png) return null;
  return {
    mime: png.mime,
    base64: png.base64,
    w: png.w,
    h: png.h,
    hash: png.hash,
    scale: CROP_SCALE
  };
}

/**
 * Script-only paragraph bitmap at the product vision scale.
 * No ink trim: the crop is the paragraph box. A red frame marks the target.
 * Text stays with the caller.
 */
export async function renderParagraphCrop(page, formula, hooks = {}) {
  let unit = null;
  try {
    unit = page?.getViewport?.({ scale: 1 }) || null;
  } catch {
    unit = null;
  }
  const bbox = unit
    ? paragraphCropBbox(formula, unit.width, unit.height, VISION_CROP_SCALE)
    : (Array.isArray(formula?.paragraphBbox) ? formula.paragraphBbox : null);
  if (!bbox) return null;
  const drawn = await renderWindow(page, bbox, VISION_CROP_SCALE, hooks);
  if (!drawn) return null;
  const target = Array.isArray(formula?.layoutBbox) ? formula.layoutBbox : formula?.bbox;
  // gap 0: seating pulls the stroke into the gap. Context keeps its own window and only adds TARGET_BOX_GAP.
  if (target) paintFormulaFrame(page, drawn.canvas, bbox, target, drawn.plan.scale, 0);
  const png = pngOf(drawn.canvas);
  release(drawn.canvas);
  if (!png) return null;
  return {
    mime: png.mime,
    base64: png.base64,
    w: png.w,
    h: png.h,
    hash: png.hash,
    scale: drawn.plan.scale,
    paragraphText: typeof formula.paragraphText === "string" ? formula.paragraphText : ""
  };
}

/**
 * Script-only context crop at the product vision scale.
 * One text line above and below, a few words left and right, clamped to the
 * column. The red frame sits outside the target glyphs.
 */
export async function renderContextCrop(page, formula, hooks = {}) {
  const windowBox = contextWindow(formula);
  if (!windowBox) return null;
  const drawn = await renderWindow(page, windowBox.bbox, VISION_CROP_SCALE, hooks);
  if (!drawn) return null;
  paintFormulaFrame(page, drawn.canvas, windowBox.bbox, windowBox.target, drawn.plan.scale, TARGET_BOX_GAP);
  const png = pngOf(drawn.canvas);
  release(drawn.canvas);
  if (!png) return null;
  const neighbor = typeof formula?.paragraphText === "string" ? formula.paragraphText : "";
  return {
    mime: png.mime,
    base64: png.base64,
    w: png.w,
    h: png.h,
    hash: png.hash,
    scale: drawn.plan.scale,
    paragraphText: neighbor,
    neighborText: neighbor
  };
}
