/** Pure e-print unpacker. gunzip is injected (node zlib or DecompressionStream). */

const TEXT_EXT = new Set([
  ".tex", ".ltx", ".sty", ".cls", ".bib", ".bbl", ".bst", ".def",
  ".fd", ".cfg", ".clo", ".ins", ".dtx", ".txt", ".md"
]);

const ASSET_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".pdf", "application/pdf"],
  [".eps", "application/postscript"],
  [".svg", "image/svg+xml"]
]);

export const MAX_ASSET_BYTES = 30 * 1024 * 1024;

export function sniffSourceKind(bytes) {
  const data = toBytes(bytes);
  if (data.length >= 5 && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46 && data[4] === 0x2d) {
    return "pdf";
  }
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return "gzip";
  return "unknown";
}

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(bytes)) return new Uint8Array(bytes);
  return new Uint8Array(bytes || []);
}

function isUstar(data) {
  if (data.length < 262) return false;
  const magic = String.fromCharCode(data[257], data[258], data[259], data[260], data[261]);
  return magic.startsWith("ustar");
}

function readOctal(bytes, offset, length) {
  let text = "";
  for (let i = 0; i < length; i++) {
    const code = bytes[offset + i];
    if (!code || code === 0x20) continue;
    text += String.fromCharCode(code);
  }
  if (!text) return 0;
  const value = parseInt(text.replace(/\0/g, "").trim(), 8);
  return Number.isFinite(value) ? value : 0;
}

function cString(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    const code = bytes[offset + i];
    if (!code) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function pad512(size) {
  const rem = size % 512;
  return rem === 0 ? size : size + (512 - rem);
}

function safePath(raw) {
  const path = String(raw || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!path || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return { ok: false, path, reason: "absolute" };
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) return { ok: false, path, reason: "traversal" };
  return { ok: true, path: parts.join("/") };
}

function extensionOf(path) {
  const dot = String(path || "").lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot).toLowerCase();
}

function isTextPath(path) {
  return TEXT_EXT.has(extensionOf(path));
}

function assetMime(path) {
  return ASSET_MIME.get(extensionOf(path)) || "";
}

function decodeText(bytes) {
  if (bytes.some((b) => b === 0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

function parsePax(bytes) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const fields = {};
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space < 0) break;
    const len = Number(text.slice(i, space));
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(i, i + len);
    const eq = record.indexOf("=");
    if (eq > 0) {
      const key = record.slice(space - i + 1, eq).trim();
      const value = record.slice(eq + 1).replace(/\n$/, "");
      if (key) fields[key] = value;
    }
    i += len;
  }
  return fields;
}

function readTar(data, { maxFiles, maxBytes, maxAssetBytes }) {
  const files = [];
  const assets = [];
  const skipped = [];
  let regularFileCount = 0;
  let total = 0;
  let assetTotal = 0;
  let longName = "";
  let paxPath = "";
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = cString(header, 345, 155);
    const name = cString(header, 0, 100);
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > data.length) {
      return { kind: "rejected", reason: "truncated", files: [], assets: [], skipped, regularFileCount };
    }
    const payload = data.subarray(dataStart, dataEnd);
    offset = dataStart + pad512(size);

    if (typeflag === "L") {
      longName = new TextDecoder("utf-8").decode(payload).replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "K") {
      longName = "";
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      const fields = parsePax(payload);
      if (fields.path) paxPath = fields.path;
      continue;
    }
    const rawPath = paxPath || longName || headerPath;
    longName = "";
    paxPath = "";
    if (typeflag === "5") continue;
    const regular = typeflag === "0" || typeflag === "\0";
    if (!regular) {
      skipped.push({ path: rawPath, reason: "not-regular" });
      continue;
    }
    regularFileCount += 1;
    if (regularFileCount > maxFiles) {
      return { kind: "rejected", reason: "max-files", files: [], assets: [], skipped, regularFileCount };
    }
    total += payload.length;
    if (total > maxBytes) {
      return { kind: "rejected", reason: "max-bytes", files: [], assets: [], skipped, regularFileCount };
    }
    const judged = safePath(rawPath);
    if (!judged.ok) {
      skipped.push({ path: rawPath, reason: judged.reason });
      continue;
    }
    const mime = assetMime(judged.path);
    if (mime) {
      if (assetTotal + payload.length > maxAssetBytes) {
        skipped.push({ path: judged.path, reason: "asset-budget" });
        continue;
      }
      assetTotal += payload.length;
      assets.push({ path: judged.path, mime, bytes: new Uint8Array(payload) });
      continue;
    }
    if (!isTextPath(judged.path)) {
      skipped.push({ path: judged.path, reason: "unsupported" });
      continue;
    }
    const text = decodeText(payload);
    if (text == null) {
      skipped.push({ path: judged.path, reason: "binary" });
      continue;
    }
    files.push({ path: judged.path, text });
  }
  return { kind: "tar", files, assets, skipped, regularFileCount, reason: null };
}

async function inflate(bytes, gunzip) {
  const out = await gunzip(bytes);
  return toBytes(out);
}

export async function unpackSource(bytes, options = {}) {
  const maxFiles = options.maxFiles ?? 2000;
  const maxBytes = options.maxBytes ?? 50 * 2 ** 20;
  const maxAssetBytes = options.maxAssetBytes ?? MAX_ASSET_BYTES;
  const data = toBytes(bytes);
  const kind = sniffSourceKind(data);
  if (kind === "pdf") {
    return { kind: "pdf-only", files: [], assets: [], skipped: [], regularFileCount: 0, reason: null };
  }
  if (kind !== "gzip") {
    return { kind: "rejected", files: [], assets: [], skipped: [], regularFileCount: 0, reason: "unknown" };
  }
  if (typeof options.gunzip !== "function") {
    throw new Error("unpackSource requires gunzip");
  }
  let inflated;
  try {
    inflated = await inflate(data, options.gunzip);
  } catch (err) {
    const reason = /max|too large|output/i.test(String(err?.message || err)) ? "max-bytes" : "gzip";
    return { kind: "rejected", files: [], assets: [], skipped: [], regularFileCount: 0, reason };
  }
  if (inflated.length > maxBytes) {
    return { kind: "rejected", files: [], assets: [], skipped: [], regularFileCount: 0, reason: "max-bytes" };
  }
  if (!isUstar(inflated)) {
    const text = decodeText(inflated);
    if (text == null) {
      return { kind: "rejected", files: [], assets: [], skipped: [], regularFileCount: 1, reason: "binary" };
    }
    return {
      kind: "single",
      files: [{ path: "source.tex", text }],
      assets: [],
      skipped: [],
      regularFileCount: 1,
      reason: null
    };
  }
  return readTar(inflated, { maxFiles, maxBytes, maxAssetBytes });
}
