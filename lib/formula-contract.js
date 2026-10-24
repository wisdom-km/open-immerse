/**
 * Shared formula-chain contract: tier ids, result shape, failure reasons, cache keys.
 * Confidence is compared only inside one tier. chainVersion invalidates a whole decision.
 */

import { sha256Hex } from "./sha256.js";

export const CHAIN_VERSION = "f3-1";

export const TIER_IDS = Object.freeze([
  "arxiv",
  "multimodal",
  "ocr",
  "self",
  "vector",
  "crop",
  "placeholder"
]);

export const TIER_ORDER = TIER_IDS;

export const STATUSES = Object.freeze(["ok", "reject", "skip", "error"]);

export const RENDERS = Object.freeze(["katex", "image", "unicode", "svg", "placeholder"]);

export const REASONS = Object.freeze([
  "disabled",
  "not-configured",
  "not-implemented",
  "punctuation-only",
  "no-source",
  "doc-align-low",
  "not-located",
  "charset-mismatch",
  "number-mismatch",
  // Decision A (2026-10-19) does not emit version-mismatch or version-uncertain.
  "unknown-command",
  "uncheckable-glyph",
  "katex-error",
  "latex-too-long",
  "unreadable",
  "timeout",
  "http",
  "no-vision",
  "cooldown",
  "aborted",
  "arbiter-undecided",
  "single-provider-reject",
  "crop-blurry",
  "crop-blank",
  "crop-neighbor-ink",
  "stale"
]);

export const CALL_FAILURES = Object.freeze(["timeout", "http", "cooldown", "aborted"]);

export const JACCARD_MIN = 0.9;
export const USE_SOURCE_MIN = 0.85;
export const NEIGHBOR_INK_MAX = 0.05;
export const VECTOR_MIN = 0.9;
export const CROP_GRID = 0.005;

export const DEFAULT_FLAGS = Object.freeze({
  arxivEnabled: false,
  multimodalEnabled: false,
  multimodalConfigured: false,
  ocrEnabled: false,
  ocrConfigured: false,
  placeholderEnabled: false
});

export function flagsOf(flags = {}) {
  return { ...DEFAULT_FLAGS, ...flags };
}

export function tierResult(partial = {}) {
  const status = partial.status;
  return {
    tier: partial.tier,
    status,
    render: partial.render ?? null,
    latex: partial.latex ?? null,
    image: partial.image ?? null,
    text: partial.text ?? null,
    confidence: partial.confidence ?? null,
    checks: partial.checks ?? {},
    reason: status === "ok" ? (partial.reason ?? null) : partial.reason,
    meta: partial.meta ?? {}
  };
}

export function contractViolations(result) {
  const problems = [];
  if (!result || typeof result !== "object") return ["result"];
  if (!TIER_IDS.includes(result.tier)) problems.push("tier");
  if (!STATUSES.includes(result.status)) problems.push("status");
  if (result.render != null && !RENDERS.includes(result.render)) problems.push("render");
  if (result.status !== "ok" && !REASONS.includes(result.reason)) problems.push("reason");
  if (result.confidence != null && !(result.confidence >= 0 && result.confidence <= 1)) problems.push("confidence");
  for (const key of ["tier", "status", "render", "confidence", "checks", "reason", "meta"]) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) problems.push(`missing:${key}`);
  }
  return problems;
}

export function unitKeyOf(unit) {
  return `${unit?.docHash || ""}:${unit?.bid || ""}`;
}

export function tierCacheKey({ unitKey, tier, version, model, cropHash } = {}) {
  return `${unitKey}:${tier}:${version}:${model || "-"}:${cropHash || "-"}`;
}

export function cropHashOf(unit) {
  const pixels = unit?.crop?.pixels;
  if (typeof pixels === "string" && pixels) return sha256Hex(pixels).slice(0, 12);
  if (pixels instanceof Uint8Array && pixels.length) {
    let raw = "";
    const step = 0x8000;
    for (let i = 0; i < pixels.length; i += step) {
      raw += String.fromCharCode(...pixels.subarray(i, i + step));
    }
    return sha256Hex(raw).slice(0, 12);
  }
  const bbox = Array.isArray(unit?.bbox) ? unit.bbox : null;
  if (!bbox || bbox.length < 4) return "-";
  const grid = bbox.slice(0, 4).map((n) => {
    const value = Number(n);
    if (!Number.isFinite(value)) return "nan";
    const snapped = Math.round(value / CROP_GRID) * CROP_GRID;
    return snapped.toFixed(3);
  }).join(",");
  return sha256Hex(grid).slice(0, 12);
}

const HTTP_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ECONNABORTED",
  "UND_ERR_SOCKET"
]);

function messageOf(err) {
  return String(err?.message || "");
}

function readStatus(err) {
  const raw = err?.status ?? err?.statusCode ?? err?.response?.status;
  const numericCode = Number(err?.code);
  const fromCode = Number.isInteger(numericCode) && numericCode >= 100 && numericCode <= 599
    ? numericCode
    : null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  return fromCode;
}

function isAbort(err) {
  const name = String(err?.name || "");
  const code = String(err?.code || "");
  return name === "AbortError" || code === "ABORT_ERR" || code === "UND_ERR_ABORTED";
}

function isTimeout(err) {
  const name = String(err?.name || "");
  const code = String(err?.code || "");
  if (name === "TimeoutError" || code === "ETIMEDOUT" || /TIMEOUT/i.test(code)) return true;
  if (readStatus(err) === 408) return true;
  return /\btimeout\b|timed out/i.test(messageOf(err));
}

function isCooldown(err) {
  const code = String(err?.code || "");
  if (/cooldown|rate[-_ ]?limit/i.test(code)) return true;
  if (readStatus(err) === 429) return true;
  return /cooldown|rate[-_ ]?limit|too many requests/i.test(messageOf(err));
}

function isUnknownCommand(err) {
  return /unknown command|undefined control sequence|unknown control sequence/i.test(messageOf(err));
}

function isKatex(err) {
  if (String(err?.name || "") === "ParseError") return true;
  return /\bKaTeX\b/.test(messageOf(err));
}

function isHttp(err) {
  const name = String(err?.name || "");
  const code = String(err?.code || "");
  if (name === "FetchError" || name === "HTTPError" || name === "NetworkError") return true;
  if (HTTP_CODES.has(code) || (code.startsWith("UND_ERR_") && !/TIMEOUT|ABORT/i.test(code))) return true;
  const status = readStatus(err);
  if (status != null && status >= 400) return true;
  return /failed to fetch|fetch failed|network ?error|network request failed|getaddrinfo|socket hang up/i.test(messageOf(err));
}

/**
 * Map a thrown error onto a locked reason.
 * "http" is only a transport or HTTP request failure.
 * Returns null when no locked reason fits. Callers must not record that as http.
 */
export function failureReason(err, depth = 0) {
  if (!err || depth > 4) return null;
  const code = err.reason || err.code;
  if (REASONS.includes(code)) return code;
  if (isAbort(err)) return "aborted";
  if (isTimeout(err)) return "timeout";
  if (isCooldown(err)) return "cooldown";
  if (isUnknownCommand(err)) return "unknown-command";
  if (isKatex(err)) return "katex-error";
  if (err.cause && err.cause !== err) {
    const nested = failureReason(err.cause, depth + 1);
    if (nested) return nested;
  }
  if (isHttp(err)) return "http";
  return null;
}
