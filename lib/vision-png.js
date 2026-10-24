/**
 * Pad a PNG that is under Ark's vision floor.
 * A picture that already fits is returned unchanged, byte for byte.
 * Decode failure leaves the original bytes in place.
 */

import { arkImagePlan } from "./mm-caps.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytesFromBase64(data) {
  const binary = atob(String(data || ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function base64FromBytes(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function readU32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function readPngInfo(base64) {
  let bytes;
  try {
    bytes = bytesFromBase64(base64);
  } catch {
    return null;
  }
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (readU32(bytes, 8) !== 13) return null;
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (type !== "IHDR") return null;
  return {
    bytes,
    width: readU32(bytes, 16),
    height: readU32(bytes, 20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    interlace: bytes[28]
  };
}

function channelsFor(colorType) {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 0;
}

function concatIdat(bytes) {
  const parts = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) return null;
    if (type === "IDAT") parts.push(bytes.subarray(start, end));
    if (type === "IEND") break;
    offset = end + 4;
  }
  if (!parts.length) return null;
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const pa = Math.abs(estimate - left);
  const pb = Math.abs(estimate - up);
  const pc = Math.abs(estimate - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function unfilter(inflated, width, height, channels) {
  const stride = width * channels;
  const expected = height * (stride + 1);
  if (inflated.length < expected) return null;
  const out = new Uint8Array(height * stride);
  let input = 0;
  let output = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[input];
    input += 1;
    if (filter > 4) return null;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[input];
      input += 1;
      const left = x >= channels ? out[output - channels] : 0;
      const up = y > 0 ? out[output - stride] : 0;
      const upLeft = x >= channels && y > 0 ? out[output - stride - channels] : 0;
      let value = raw;
      if (filter === 1) value = (raw + left) & 255;
      else if (filter === 2) value = (raw + up) & 255;
      else if (filter === 3) value = (raw + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) value = (raw + paeth(left, up, upLeft)) & 255;
      out[output] = value;
      output += 1;
    }
  }
  return out;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

function concatParts(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

async function inflateBytes(data) {
  if (globalThis.process?.versions?.node) {
    const { inflateSync } = await import("node:zlib");
    return new Uint8Array(inflateSync(data));
  }
  if (typeof DecompressionStream !== "function") return null;
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateBytes(data) {
  if (globalThis.process?.versions?.node) {
    const { deflateSync } = await import("node:zlib");
    return new Uint8Array(deflateSync(data));
  }
  if (typeof CompressionStream !== "function") return null;
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paint(src, srcW, srcH, channels, plan) {
  const dest = new Uint8Array(plan.height * plan.width * channels);
  const white = channels === 2 || channels === 4 ? [255, 255, 255, 255] : [255, 255, 255];
  for (let i = 0; i < dest.length; i += channels) {
    for (let c = 0; c < channels; c += 1) dest[i + c] = white[c] ?? 255;
  }
  const scaledW = srcW * plan.scale;
  const scaledH = srcH * plan.scale;
  const offsetX = Math.floor((plan.width - scaledW) / 2);
  const offsetY = Math.floor((plan.height - scaledH) / 2);
  for (let y = 0; y < scaledH; y += 1) {
    const srcY = Math.min(srcH - 1, Math.floor(y / plan.scale));
    for (let x = 0; x < scaledW; x += 1) {
      const srcX = Math.min(srcW - 1, Math.floor(x / plan.scale));
      const from = (srcY * srcW + srcX) * channels;
      const to = ((offsetY + y) * plan.width + (offsetX + x)) * channels;
      dest.set(src.subarray(from, from + channels), to);
    }
  }
  return dest;
}

function encodePng(width, height, channels, pixels) {
  const colorType = channels === 4 ? 6 : channels === 2 ? 4 : channels === 1 ? 0 : 2;
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const stride = width * channels;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const dest = y * (stride + 1);
    raw[dest] = 0;
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), dest + 1);
  }
  return { ihdr, raw };
}

/**
 * @returns {Promise<string>} base64 PNG. The input is returned when it already fits or cannot be padded.
 */
export async function fitPngForArk(base64) {
  const info = readPngInfo(base64);
  if (!info) return base64;
  const plan = arkImagePlan(info.width, info.height);
  if (!plan) return base64;
  const channels = channelsFor(info.colorType);
  if (!channels || info.bitDepth !== 8 || info.interlace !== 0) return base64;
  try {
    const idat = concatIdat(info.bytes);
    if (!idat) return base64;
    const inflated = await inflateBytes(idat);
    if (!inflated) return base64;
    const pixels = unfilter(inflated, info.width, info.height, channels);
    if (!pixels) return base64;
    const painted = paint(pixels, info.width, info.height, channels, plan);
    const encoded = encodePng(plan.width, plan.height, channels, painted);
    const compressed = await deflateBytes(encoded.raw);
    if (!compressed) return base64;
    const png = concatParts([
      new Uint8Array(PNG_SIGNATURE),
      chunk("IHDR", encoded.ihdr),
      chunk("IDAT", compressed),
      chunk("IEND", new Uint8Array())
    ]);
    return base64FromBytes(png);
  } catch {
    return base64;
  }
}
