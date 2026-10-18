/**
 * Pure paper-record helpers. No IndexedDB and no network.
 * The viewer tab title is `${PDF_COPY.title} · ${name}` (`lib/pdf-viewer.js`).
 * Stored titles and the list strip that prefix so old rows still read cleanly.
 */

import { parseArxivUrl } from "./arxiv-id.js";
import { sha256Bytes } from "./sha256.js";

export const PDF_TITLE_PREFIX = "PDF 阅读 · ";

/** One original PDF. Larger files stay out of `sources` and are marked too-large. */
export const LIBRARY_SOURCE_MAX_BYTES = 100 * 1024 * 1024;

export function cleanTitle(value) {
  let title = String(value || "").trim();
  while (title.startsWith(PDF_TITLE_PREFIX)) title = title.slice(PDF_TITLE_PREFIX.length).trim();
  return title;
}

/** http(s) only. `file:` and `blob:` are not library source URLs. */
export function httpSourceUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function pageCountsAsTranslated(page) {
  if (page?.skipped) return true;
  const pairs = page?.pairs;
  return Array.isArray(pairs) && pairs.some((pair) => String(pair?.translation || "").trim());
}

/** Pages with a non-empty translation or `skipped`. Duplicate page numbers count once. */
export function countTranslated(pages) {
  const seen = new Set();
  let count = 0;
  let index = 0;
  for (const page of pages || []) {
    index += 1;
    const pageNo = Math.floor(Number(page?.page));
    const key = pageNo >= 1 ? `p:${pageNo}` : `i:${index}`;
    if (seen.has(key) || !pageCountsAsTranslated(page)) continue;
    seen.add(key);
    count += 1;
  }
  return count;
}

export function arxivRecordFromUrl(url) {
  const parsed = parseArxivUrl(url);
  if (!parsed?.id) return undefined;
  const version = parsed.version || "";
  const record = { id: parsed.id, key: `${parsed.id}${version}` };
  if (version) record.version = version;
  return record;
}

export function arxivPdfUrl(arxiv) {
  const id = String(arxiv?.id || "").trim();
  if (!id || /[\s/?#]/.test(id)) return "";
  const version = String(arxiv?.version || "").trim();
  if (version && !/^v?\d+$/i.test(version)) return "";
  const suffix = !version ? "" : (version[0] === "v" || version[0] === "V" ? version.toLowerCase() : `v${version}`);
  return `https://arxiv.org/pdf/${id}${suffix}`;
}

export function sha256HexOf(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const digest = sha256Bytes(view);
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function matchLibraryBytes(hash, bytes) {
  const view = bytes instanceof Uint8Array ? bytes : (bytes == null ? null : new Uint8Array(bytes));
  if (!view?.byteLength) return { status: "empty" };
  const digest = sha256HexOf(view);
  if (digest !== String(hash || "").trim().toLowerCase()) {
    return { status: "hash-mismatch", via: "file", size: view.byteLength };
  }
  return { status: "match", bytes: view, size: view.byteLength };
}
