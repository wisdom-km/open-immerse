/**
 * PNG crop for one formula. Callers send this to a vision model.
 * Only a base64 PNG data URL is accepted. http(s) URLs are refused
 * and never fetched. The return shape is `{ mime, base64, w, h, hash }`.
 */

import { sha256Hex } from "./sha256.js";

const PNG_MAGIC = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decoded PNG cap. Matches the vision client's single-image limit. */
export const MAX_CROP_PNG_BYTES = 10 * 1024 * 1024;

function bytesOf(base64) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const estimated = (base64.length / 4) * 3 - padding;
  if (estimated > MAX_CROP_PNG_BYTES) return null;
  let binary;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  if (binary.length > MAX_CROP_PNG_BYTES || binary.length < 24) return null;
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (binary.charCodeAt(i) !== PNG_MAGIC[i]) return null;
  }
  return binary;
}

function uint32(binary, offset) {
  return (
    (binary.charCodeAt(offset) << 24)
    | (binary.charCodeAt(offset + 1) << 16)
    | (binary.charCodeAt(offset + 2) << 8)
    | binary.charCodeAt(offset + 3)
  ) >>> 0;
}

function fromDataUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || /^\/\//.test(raw) || /^blob:/i.test(raw)) return null;
  const match = raw.match(/^data:(image\/png);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const base64 = match[2].replace(/\s+/g, "");
  const binary = bytesOf(base64);
  if (!binary) return null;
  const w = uint32(binary, 16);
  const h = uint32(binary, 20);
  if (!(w > 0) || !(h > 0)) return null;
  return {
    mime: "image/png",
    base64,
    w,
    h,
    hash: sha256Hex(base64).slice(0, 12)
  };
}

/**
 * Crop one formula to a PNG the vision client can send.
 * `block` is a formula block (`imageUrl`) or a chain unit (`crop.url` / `crop.pixels`).
 * Interrupt point: after an optional async `readCropImage`, the url is read again
 * and a stale or non-PNG result is dropped.
 *
 * @returns {Promise<{mime:"image/png", base64:string, w:number, h:number, hash:string} | null>}
 */
export async function cropPngFor(block, hooks = {}) {
  const direct = fromDataUrl(block?.imageUrl || block?.crop?.url || "");
  if (direct) return direct;
  const pixels = String(block?.crop?.pixels || "");
  if (pixels && !/^https?:/i.test(pixels) && !/^data:/i.test(pixels)) {
    const embedded = fromDataUrl(`data:image/png;base64,${pixels}`);
    if (embedded) return embedded;
  }
  if (typeof hooks?.readCropImage !== "function") return null;
  const url = block?.imageUrl || block?.crop?.url || "";
  if (!url || /^https?:\/\//i.test(url)) return null;
  let sample = null;
  try {
    sample = await hooks.readCropImage(url);
  } catch {
    return null;
  }
  if (hooks?.isStale?.()) return null;
  const again = fromDataUrl(block?.imageUrl || block?.crop?.url || sample?.url || "");
  if (again) return again;
  return null;
}
