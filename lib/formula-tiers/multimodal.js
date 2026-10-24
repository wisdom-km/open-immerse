/**
 * Formula tier 2. One PNG crop, one vision call, then the shared check.
 * version mm-4 is part of the cache key. mm-3, mm-2, and mm-1 rows are different keys.
 *
 * Interrupt points, each able to drop the call before a send or a cache write:
 *   after-settings  — key and provider are known; vision:false sends nothing
 *   before-send     — crop is in hand; stale, abort, or a settings change stops here
 *   after-response  — the body is back; a stale body is not verified and not cached
 *   before-return   — the tier result is about to leave; the cache writes only after this
 *
 * The ask-AI queue is not touched. This module keeps no shared mutable state.
 */

import { formulaIsInline } from "../formula-context-crop.js";
import { tierResult } from "../formula-contract.js";
import { VISION_CROP_SCALE, visionCropFor } from "../formula-vision-crop.js";
import {
  FORMULA_SWITCH_KEYS,
  multimodalProvider,
  normalizeFormulaSettings
} from "../formula-settings.js";
import { multimodalTarget, sendVision } from "../mm-client.js";
import { sha256Hex } from "../sha256.js";
import { parseLatexCandidate, punctuationOnlyFormula, verifyCandidate, visionSkipped } from "../formula-verify.js";
import { diagLog } from "../diag-log.js";

export const MM_TIER_VERSION = "mm-4";

/** Retired generation. The live cache key carries mm-4, so a stub-0 row is a different key. */
export const RETIRED_MM_VERSION = "stub-0";

export const FORMULA_VISION_SYSTEM = "只输出这一个公式的 LaTeX，不加 $，不加解释；看不清就输出 UNREADABLE";

/**
 * Appended only when the image is a context crop. Display formulas keep
 * FORMULA_VISION_SYSTEM alone. The red box is on the inline image; the note
 * tells the model not to finish a formula that continues past it.
 */
export const FORMULA_CONTEXT_PROMPT = "只输出红框内公式的 LaTeX，不要补全，也不要延伸到红框之外；周围文字仅作上下文。";

export function formulaVisionText(unit) {
  return formulaIsInline(unit) ? "行内公式" : "独立公式";
}

/** System prompt plus the user text. Context note is inline crops only. */
export function formulaVisionPrompt(unit, crop) {
  const context = formulaIsInline(unit) && crop?.meta?.mode === "context";
  return {
    system: context ? `${FORMULA_VISION_SYSTEM}\n${FORMULA_CONTEXT_PROMPT}` : FORMULA_VISION_SYSTEM,
    text: formulaVisionText(unit)
  };
}

function skip(reason) {
  return tierResult({
    tier: "multimodal",
    status: "skip",
    reason,
    confidence: null,
    meta: { version: MM_TIER_VERSION }
  });
}

function failed(reason, extra = {}) {
  const result = tierResult({
    tier: "multimodal",
    status: reason === "unreadable" || reason === "charset-mismatch" || reason === "katex-error"
      || reason === "unknown-command" || reason === "uncheckable-glyph"
      ? "reject"
      : "error",
    reason,
    confidence: extra.confidence ?? null,
    latex: extra.latex ?? null,
    checks: extra.checks ?? {},
    meta: {
      version: MM_TIER_VERSION,
      epoch: extra.epoch ?? null,
      visionCode: extra.visionCode || "",
      summary: extra.summary || "",
      parseReason: extra.parseReason || "",
      ...(extra.cache === false ? { cache: false } : {})
    }
  });
  if (result.status === "error") diagLog("mm.error", { code: String(reason || "error") });
  return result;
}

function keyHashOf(settings) {
  const stored = normalizeFormulaSettings(settings);
  const key = String(stored.multimodal.apiKey || "").trim();
  return key ? sha256Hex(key).slice(0, 16) : "";
}

export function mmConfigStamp(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = multimodalProvider(stored.multimodal.provider);
  const target = multimodalTarget(stored);
  const keyHash = keyHashOf(stored);
  return {
    enabled: stored[FORMULA_SWITCH_KEYS.tier2] === true && provider?.vision === true && keyHash !== "",
    provider: target.provider || stored.multimodal.provider,
    model: target.model || stored.multimodal.model,
    endpoint: target.url || "",
    vision: provider?.vision === true,
    keyHash
  };
}

/** Irreversible id of provider, model, endpoint, and key. The key itself is not in it. */
export function mmConfigFingerprint(settings) {
  const stamp = mmConfigStamp(settings);
  return sha256Hex([stamp.provider, stamp.model, stamp.endpoint, stamp.keyHash].join("\n")).slice(0, 16);
}

export function sameMmConfig(left, right) {
  if (!left || !right) return false;
  return left.enabled === right.enabled
    && left.provider === right.provider
    && left.model === right.model
    && left.endpoint === right.endpoint
    && left.vision === right.vision
    && left.keyHash === right.keyHash;
}

function settingsNow(ctx) {
  if (typeof ctx?.readSettings === "function") return ctx.readSettings();
  return ctx?.settings;
}

export function providerBlocksVision(ctx) {
  const settings = settingsNow(ctx);
  if (!settings) return true;
  const stored = normalizeFormulaSettings(settings);
  const provider = multimodalProvider(stored.multimodal.provider);
  if (!provider || provider.vision !== true) return true;
  if (!stored.multimodal.apiKey.trim()) return true;
  return false;
}

function live(ctx, stamp) {
  if (ctx?.signal?.aborted) return false;
  if (ctx?.isStale?.()) return false;
  if (typeof ctx?.stillCurrent === "function" && ctx.stillCurrent() === false) return false;
  const settings = settingsNow(ctx);
  if (stamp && settings && !sameMmConfig(stamp, mmConfigStamp(settings))) return false;
  return true;
}

async function checkpoint(ctx, name, stamp) {
  if (typeof ctx?.onCheckpoint === "function") {
    try {
      await ctx.onCheckpoint(name);
    } catch {
      return false;
    }
  }
  return live(ctx, stamp);
}

function knownSecrets(settings) {
  const stored = settings ? normalizeFormulaSettings(settings) : null;
  const key = String(stored?.multimodal?.apiKey || "");
  return [key, key.trim()].filter(Boolean);
}

function scrubSummary(summary, secrets) {
  let out = String(summary || "");
  for (const key of secrets) {
    if (key) out = out.split(key).join("***");
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 80);
}

function containsSecret(value, secrets) {
  const raw = String(value || "");
  return secrets.some((key) => key && raw.includes(key));
}

function visionReason(code) {
  if (code === "timeout") return "timeout";
  if (code === "aborted") return "aborted";
  if (code === "429") return "cooldown";
  if (code === "no-vision") return "no-vision";
  return "http";
}

function blockFromUnit(unit) {
  // crop.pixels is the string cropHashOf already hashed. The display URL is a
  // different bitmap (zoom and DPR). Sending it would cache one picture's
  // answer under another picture's key. bid lets a caller that has not
  // extracted pixels yet find the page-raster PNG instead of that URL.
  const pixels = unit?.crop?.pixels;
  const raw = typeof pixels === "string"
    && pixels.length > 0
    && !/^https?:/i.test(pixels)
    && !/^data:/i.test(pixels);
  const inline = formulaIsInline(unit);
  const bbox = Array.isArray(unit?.bbox) ? unit.bbox : null;
  return {
    bid: unit?.bid || "",
    id: unit?.bid || "",
    label: "formula",
    display: inline ? false : true,
    inlineOf: unit?.inlineOf || "",
    bbox,
    layoutBbox: Array.isArray(unit?.layoutBbox) ? unit.layoutBbox : bbox,
    paragraphBbox: Array.isArray(unit?.paragraphBbox) ? unit.paragraphBbox : null,
    glyphBoxes: unit?.glyphBoxes,
    maskBoxes: unit?.maskBoxes,
    formulaInkProtect: unit?.formulaInkProtect === true,
    imageUrl: raw ? `data:image/png;base64,${pixels}` : (unit?.crop?.url || ""),
    crop: unit?.crop || null
  };
}

export const multimodalTier = {
  id: "multimodal",
  version: MM_TIER_VERSION,
  kind: "candidate",
  available(ctx) {
    if (ctx?.flags?.multimodalEnabled !== true) return false;
    if (providerBlocksVision(ctx)) return false;
    return true;
  },
  unavailableReason(ctx) {
    if (providerBlocksVision(ctx)) return "not-configured";
    if (ctx?.flags?.multimodalConfigured === true && ctx?.flags?.multimodalEnabled !== true) return "disabled";
    return "not-configured";
  },
  run(unit, ctx, opts) {
    return runMultimodal(unit, ctx, opts);
  }
};

export async function runMultimodal(unit, ctx = {}, opts = {}) {
  const scoped = {
    ...ctx,
    signal: opts?.signal || ctx?.signal,
    isStale: opts?.isStale || ctx?.isStale
  };
  const stamp = settingsNow(scoped) ? mmConfigStamp(settingsNow(scoped)) : null;
  const epoch = Number.isFinite(Number(scoped.epoch)) ? Number(scoped.epoch) : null;
  if (!(await checkpoint(scoped, "after-settings", stamp))) {
    return failed(scoped.signal?.aborted ? "aborted" : "stale", { epoch, cache: false });
  }
  if (!multimodalTier.available(scoped)) {
    return skip(multimodalTier.unavailableReason(scoped));
  }
  // Flags alone are not enough. No stamp, vision:false, or a missing key
  // returns before the crop and before sendVision.
  if (!stamp || stamp.vision !== true || stamp.enabled !== true || !stamp.keyHash) {
    const turnedOff = stamp && stamp.vision === true && stamp.keyHash && stamp.enabled !== true;
    return skip(turnedOff ? "disabled" : "not-configured");
  }
  // Parentheses and punctuation have nothing for the model to read. This is a
  // skip, not a reject, so the failure cache stays empty and the chain falls
  // through to the existing crop / source fallback.
  if (punctuationOnlyFormula(unit)) return skip("punctuation-only");
  // The text layer cannot be checked. Skip the crop and the vision call.
  if (visionSkipped(unit)) {
    return failed("uncheckable-glyph", { epoch, confidence: 0 });
  }

  const cropFn = typeof scoped.visionCropFor === "function" ? scoped.visionCropFor : visionCropFor;
  let png = null;
  try {
    png = await cropFn(blockFromUnit(unit), {
      mode: "tight",
      scale: scoped.visionScale || VISION_CROP_SCALE,
      renderVisionCrop: scoped.renderVisionCrop,
      cropPngFor: scoped.cropPngFor,
      readCropImage: scoped.readCropImage,
      isStale: scoped.isStale
    });
  } catch {
    png = null;
  }
  if (!(await checkpoint(scoped, "before-send", stamp))) {
    return failed(scoped.signal?.aborted ? "aborted" : "stale", { epoch, cache: false });
  }
  // guard:png-shape
  if (!png || png.mime !== "image/png" || !png.base64 || /^https?:/i.test(png.base64)) {
    return failed("http", { epoch, cache: false, summary: "需要 PNG 裁图", visionCode: "http" });
  }

  const settings = settingsNow(scoped);
  const secrets = knownSecrets(settings);
  const target = multimodalTarget(settings || {});
  const send = typeof scoped.sendVision === "function" ? scoped.sendVision : sendVision;
  let response;
  try {
    const prompt = formulaVisionPrompt(unit, png);
    response = await send({
      target,
      system: prompt.system,
      text: prompt.text,
      images: [{ mime: "image/png", base64: png.base64 }],
      signal: scoped.signal,
      purpose: "multimodal",
      readSecret: typeof scoped.readSecret === "function"
        ? scoped.readSecret
        : async () => String(settingsNow(scoped)?.multimodal?.apiKey || ""),
      // guard:send-still
      stillCurrent: () => live(scoped, stamp),
      net: scoped.net
    });
  } catch (err) {
    if (err?.code === "real-network-in-test") throw err;
    if (!(await checkpoint(scoped, "after-response", stamp))) {
      return failed(scoped.signal?.aborted ? "aborted" : "stale", { epoch, cache: false });
    }
    return failed("http", { epoch, cache: false, summary: "请求失败", visionCode: "http" });
  }

  if (!(await checkpoint(scoped, "after-response", stamp))) {
    return failed(scoped.signal?.aborted ? "aborted" : "stale", { epoch, cache: false });
  }
  if (!response || response.ok !== true) {
    const code = response?.error?.code || "http";
    // The key disappeared between the stamp and the send. That is not a
    // stored HTTP failure and it must not count as a send.
    if (code === "empty-key") return skip("not-configured");
    const reason = code === "aborted" && !scoped.signal?.aborted ? "stale" : visionReason(code);
    if (scoped.mmTraffic && reason !== "aborted" && reason !== "stale") scoped.mmTraffic.sent += 1;
    return failed(reason, {
      epoch,
      visionCode: code,
      summary: scrubSummary(response?.error?.summary || "", secrets),
      // A 429 is the account limit, not a bad model. Do not store it.
      ...(reason === "cooldown" ? { cache: false } : {})
    });
  }

  const text = response.text;
  const keepSent = () => {
    if (scoped.mmTraffic) scoped.mmTraffic.sent += 1;
  };
  // guard:secret-echo — the candidate is a slice of this text, so one check covers both
  if (containsSecret(text, secrets)) {
    keepSent();
    return failed("unreadable", { epoch, cache: false, parseReason: "secret", summary: "" });
  }
  const parsed = parseLatexCandidate(text);
  if (!parsed.ok) {
    keepSent();
    return failed("unreadable", {
      epoch,
      parseReason: parsed.reason || "unreadable",
      summary: ""
    });
  }
  const verdict = verifyCandidate(parsed.latex, unit, scoped.katex);
  if (!(await checkpoint(scoped, "before-return", stamp))) {
    return failed(scoped.signal?.aborted ? "aborted" : "stale", { epoch, cache: false });
  }
  keepSent();
  if (!verdict.pass) {
    // guard:reject-latex — the rejected source stays out of the result and the cache row
    return failed(verdict.reason || "charset-mismatch", {
      epoch,
      confidence: verdict.confidence,
      checks: verdict.checks
    });
  }
  return tierResult({
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: verdict.latex || parsed.latex,
    confidence: verdict.confidence,
    checks: verdict.checks,
    meta: {
      version: MM_TIER_VERSION,
      epoch,
      latexSource: "vlm",
      cropHash: png.hash
    }
  });
}
