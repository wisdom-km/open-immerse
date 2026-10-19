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

/**
 * Query keys that carry a bearer token, a signature, or a temporary credential.
 * Names are compared case-insensitively, with `-` treated the same as `_`.
 * `X-Amz-*` and `x_amz_*` are the same prefix. Ordinary keys such as `q` or
 * `page` stay.
 */
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "auth",
  "auth_token",
  "authorization",
  "sig",
  "signature",
  "jwt",
  "password",
  "passwd",
  "pwd",
  "secret",
  "client_secret",
  "apikey",
  "api_key",
  "key",
  "code",
  "access_key",
  "otp",
  "hmac",
  "credential",
  "credentials",
  "security_token",
  "sessionid",
  "session_id",
  "session_token",
  "awsaccesskeyid",
  "googleaccessid",
  "key_pair_id",
  "x_goog_signature",
  "x_goog_credential",
  "x_goog_signedheaders"
]);

function sensitiveQueryKey(name) {
  const raw = String(name || "").toLowerCase().replace(/-/g, "_");
  if (raw.startsWith("x_amz_")) return true;
  return SENSITIVE_QUERY_KEYS.has(raw);
}

function decodeQueryKey(raw) {
  const text = String(raw || "").replace(/\+/g, " ");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function decodePathPiece(raw) {
  try {
    return decodeURIComponent(String(raw || ""));
  } catch {
    return String(raw || "");
  }
}

/** Keep every ordinary `a=b` / bare `q` segment exactly. Drop secret keys only. */
function scrubSearch(search) {
  const raw = String(search || "").replace(/^\?/, "");
  if (!raw) return "";
  const kept = [];
  for (const part of raw.split("&")) {
    if (!part) {
      kept.push(part);
      continue;
    }
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    if (sensitiveQueryKey(decodeQueryKey(rawKey))) continue;
    kept.push(part);
  }
  while (kept.length && kept[0] === "") kept.shift();
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  return kept.length ? `?${kept.join("&")}` : "";
}

/**
 * Drop `;token=` matrix parameters and `/token=value/` path segments.
 * A segment that has no secret is returned unchanged, encoding included.
 */
function scrubPath(pathname) {
  const segments = String(pathname || "").split("/");
  const next = [];
  for (const segment of segments) {
    if (!segment) {
      next.push(segment);
      continue;
    }
    const decoded = decodePathPiece(segment);
    if (!decoded.includes(";") && !decoded.includes("=")) {
      next.push(segment);
      continue;
    }
    const pieces = decoded.split(";");
    const head = pieces[0];
    const headEq = head.indexOf("=");
    if (headEq !== -1 && sensitiveQueryKey(head.slice(0, headEq))) continue;
    const params = [];
    for (const param of pieces.slice(1)) {
      const eq = param.indexOf("=");
      const key = eq === -1 ? param : param.slice(0, eq);
      if (sensitiveQueryKey(key)) continue;
      params.push(param);
    }
    const cleaned = params.length ? `${head};${params.join(";")}` : head;
    next.push(cleaned === decoded ? segment : cleaned);
  }
  let path = next.join("/").replace(/\/{2,}/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  return path || "/";
}

/**
 * http(s) only. `file:` and `blob:` are not library source URLs.
 * Before a URL is stored or exported: drop userinfo, drop `#fragment`,
 * drop known sensitive query keys, and drop the same names from `;key=`
 * matrix parameters and `key=value` path segments. Other parameters stay,
 * with their original encoding.
 */
export function httpSourceUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const search = scrubSearch(url.search);
    const path = scrubPath(url.pathname);
    url.username = "";
    url.password = "";
    url.hash = "";
    if (path !== url.pathname) url.pathname = path;
    if (search !== url.search) url.search = search;
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
