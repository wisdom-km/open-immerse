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
  "no-source",
  "doc-align-low",
  "not-located",
  "charset-mismatch",
  "number-mismatch",
  "unknown-command",
  "uncheckable-glyph",
  "katex-error",
  "timeout",
  "http",
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

export function failureReason(err) {
  const code = err?.reason || err?.code;
  if (REASONS.includes(code)) return code;
  if (err?.name === "AbortError") return "aborted";
  return "http";
}
