/**
 * Node adapter for the product hi-res vision crop (F7W-1 / mm-3).
 *
 * Measurement, scale, and pad come from lib/formula-vision-crop.js.
 * The pixel steps follow pdf/viewer.js renderVisionFormulaCrop: render the
 * layout box at the vision scale, tight-crop with measureVisionRegion, then
 * mask neighbor ink. This file does not change the product prompt or defaults.
 *
 * The paragraph crop is script-only. It renders the paragraph box at the same
 * vision scale and does not go through visionCropSpec (that spec stays tight).
 */

import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";

import { rasterCropRect } from "../lib/pdf-blocks.js";
import { parseCropDataUrl } from "../lib/formula-crop-png.js";
import { formulaInkPadPx, formulaRegionWindow } from "../lib/pdf-formula-raster.js";
import { blankFormulaMask, boxesInCrop } from "../lib/pdf-text-layer.js";
import {
  VISION_CROP_SCALE,
  measureVisionRegion,
  visionPadFor,
  visionRasterPlan,
  visionSourceBbox
} from "../lib/formula-vision-crop.js";

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

function cropCanvas(canvas, relativeBbox, createCanvas) {
  if (!canvas || !Array.isArray(relativeBbox) || relativeBbox.length < 4) return null;
  const rect = rasterCropRect(relativeBbox, canvas.width, canvas.height);
  if (rect.sw < 1 || rect.sh < 1) return null;
  if (rect.sx === 0 && rect.sy === 0 && rect.sw === canvas.width && rect.sh === canvas.height) return canvas;
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

/**
 * Script-only paragraph bitmap at the product vision scale.
 * No ink trim: the crop is the paragraph box. Text stays with the caller.
 */
export async function renderParagraphCrop(page, formula, hooks = {}) {
  const bbox = Array.isArray(formula?.paragraphBbox) ? formula.paragraphBbox : null;
  if (!bbox) return null;
  const drawn = await renderWindow(page, bbox, VISION_CROP_SCALE, hooks);
  if (!drawn) return null;
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
