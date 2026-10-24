/**
 * Per-model Chat Completions fields for one vision call.
 *
 * Verified on Ark `/api/plan/v3` (2026-10-24, concurrency 3, 372 calls,
 * the two benchmark 400 crops plus 30 other glm crops):
 * `thinking.type=disabled` is HTTP 400 on every glm-5.3-flash call
 * ("thinking.type disabled is not supported").
 * The same images with `reasoning_effort` "low", with "minimal", and with
 * neither field all returned 200. Omitting `reasoning_effort` made glm
 * think by default (p50 about 5.7s, reasoning tokens present). "low" kept
 * reasoning tokens near 0 (p50 about 2.7s).
 * The benchmark's residual InvalidParameter 400s did not reproduce.
 * Their root cause is unconfirmed. `/api/v3` was not measured.
 *
 * Formula calls omit `thinking` and send `reasoning_effort` "low".
 * An InvalidParameter retry keeps "low" and drops `thinking` plus any
 * field outside the chat allowlist. It does not switch models.
 *
 * deepseek, doubao, and kimi keep the fields they accept today:
 * Ark/DeepSeek get thinking disabled plus reasoning_effort minimal;
 * Kimi on Moonshot gets thinking disabled and no reasoning_effort.
 */

const GLM53_RE = /glm-5\.3/i;
const ARK_HOST_RE = /volces\.com|volcengine\.com|api\.deepseek\.com/i;
const KIMI_HOST_RE = /moonshot\.(cn|ai)/i;

/** Output cap applied when a caller asks glm-5.3-flash for more tokens. */
export const GLM53_MAX_TOKENS = 131072;

/** Chat fields a glm InvalidParameter retry is allowed to send again. */
const GLM_RETRY_FIELDS = new Set([
  "model",
  "temperature",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "reasoning_effort"
]);

const GLM_EFFORT = new Set(["low", "high", "max"]);

/**
 * Ark vision floor, already used by the probe PNG.
 * Each edge must be greater than 14, and the pixel count at least 196.
 * Aspect must stay under 150:1. A legal image is not rewritten.
 */
export const ARK_IMAGE_MIN_EDGE = 15;
export const ARK_IMAGE_MIN_PIXELS = 196;
export const ARK_IMAGE_MAX_ASPECT = 150;

export function isGlm53(model) {
  return GLM53_RE.test(String(model || ""));
}

export function visionBodyFields(model, target = {}) {
  const name = String(model || "");
  const provider = String(target.provider || "");
  const url = String(target.url || target.baseUrl || "");
  if (isGlm53(name)) {
    return {
      kind: "glm",
      thinking: "omit",
      reasoningEffort: "low",
      maxTokens: GLM53_MAX_TOKENS,
      fitImage: true,
      invalidParameterRetry: "strip-unknown"
    };
  }
  if (provider === "kimi" || KIMI_HOST_RE.test(url)) {
    return {
      kind: "kimi",
      thinking: "disabled",
      reasoningEffort: "omit",
      fitImage: false,
      invalidParameterRetry: ""
    };
  }
  if (provider === "doubao" || provider === "deepseek" || ARK_HOST_RE.test(url)) {
    return {
      kind: "ark",
      thinking: "disabled",
      reasoningEffort: "minimal",
      fitImage: false,
      invalidParameterRetry: ""
    };
  }
  return {
    kind: "default",
    thinking: "omit",
    reasoningEffort: "omit",
    fitImage: false,
    invalidParameterRetry: ""
  };
}

export function applyVisionFields(body, fields, { deepThink = false } = {}) {
  const next = body && typeof body === "object" ? body : {};
  if (!fields || fields.kind === "default") return next;
  if (fields.thinking === "omit") delete next.thinking;
  else next.thinking = { type: deepThink ? "enabled" : "disabled" };
  const effort = fields.kind === "glm" && deepThink ? "high" : fields.reasoningEffort;
  if (!effort || effort === "omit") delete next.reasoning_effort;
  else next.reasoning_effort = effort;
  if (fields.kind === "glm") delete next.thinking;
  return next;
}

/**
 * Second glm body after InvalidParameter.
 * Keeps reasoning_effort (low, unless the first body already used high or max)
 * so the model does not fall back to default thinking. Drops `thinking` and
 * any field that is not a normal chat field.
 */
export function normalizeGlmRetryBody(json) {
  const next = {};
  for (const [key, value] of Object.entries(json || {})) {
    if (!GLM_RETRY_FIELDS.has(key)) continue;
    next[key] = value;
  }
  if (!GLM_EFFORT.has(next.reasoning_effort)) next.reasoning_effort = "low";
  return next;
}

export function clampMaxTokens(model, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const cap = visionBodyFields(model).maxTokens;
  if (cap && n > cap) return cap;
  return Math.floor(n);
}

/** Target canvas for an image Ark would reject. Null when the image is already legal. */
export function arkImagePlan(width, height) {
  const srcW = width | 0;
  const srcH = height | 0;
  if (srcW < 1 || srcH < 1) return null;
  let scale = 1;
  while (scale < 64) {
    const w = srcW * scale;
    const h = srcH * scale;
    if (w >= ARK_IMAGE_MIN_EDGE && h >= ARK_IMAGE_MIN_EDGE && w * h >= ARK_IMAGE_MIN_PIXELS) break;
    scale += 1;
  }
  let outW = srcW * scale;
  let outH = srcH * scale;
  if (outW / outH >= ARK_IMAGE_MAX_ASPECT) outH = Math.ceil(outW / (ARK_IMAGE_MAX_ASPECT - 1));
  if (outH / outW >= ARK_IMAGE_MAX_ASPECT) outW = Math.ceil(outH / (ARK_IMAGE_MAX_ASPECT - 1));
  if (outW === srcW && outH === srcH) return null;
  return { width: outW, height: outH, scale, srcWidth: srcW, srcHeight: srcH };
}
