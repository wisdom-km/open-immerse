/**
 * Formula tier 2. One PNG crop, one vision call, then the shared check.
 * version mm-1 is part of the cache key.
 *
 * Interrupt points, each able to drop the call before a send or a cache write:
 *   after-settings  — key and provider are known; vision:false sends nothing
 *   before-send     — crop is in hand; stale, abort, or a settings change stops here
 *   after-response  — the body is back; a stale body is not verified and not cached
 *   before-return   — the tier result is about to leave; the cache writes only after this
 *
 * The ask-AI queue is not touched. This module keeps no shared mutable state.
 */

import { cropPngFor } from "../formula-crop-png.js";
import { tierResult } from "../formula-contract.js";
import {
  FORMULA_SWITCH_KEYS,
  multimodalProvider,
  normalizeFormulaSettings
} from "../formula-settings.js";
import { multimodalTarget, sendVision } from "../mm-client.js";
import { parseLatexCandidate, verifyCandidate } from "../formula-verify.js";

export const MM_TIER_VERSION = "mm-1";

export const FORMULA_VISION_SYSTEM = "只输出这一个公式的 LaTeX，不加 $，不加解释；看不清就输出 UNREADABLE";

export function formulaVisionText(unit) {
  return unit?.display === false ? "行内公式" : "独立公式";
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
  return tierResult({
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
}

export function mmConfigStamp(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = multimodalProvider(stored.multimodal.provider);
  const key = String(stored.multimodal.apiKey || "");
  return {
    enabled: stored[FORMULA_SWITCH_KEYS.tier2] === true && provider?.vision === true && key.trim() !== "",
    provider: stored.multimodal.provider,
    model: stored.multimodal.model,
    vision: provider?.vision === true,
    keyPresent: key.trim() !== ""
  };
}

export function sameMmConfig(left, right) {
  if (!left || !right) return false;
  return left.enabled === right.enabled
    && left.provider === right.provider
    && left.model === right.model
    && left.vision === right.vision
    && left.keyPresent === right.keyPresent;
}

function settingsNow(ctx) {
  if (typeof ctx?.readSettings === "function") return ctx.readSettings();
  return ctx?.settings;
}

export function providerBlocksVision(ctx) {
  const settings = settingsNow(ctx);
  if (!settings) return false;
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
  return "http";
}

function blockFromUnit(unit) {
  return {
    imageUrl: unit?.crop?.url || "",
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
  if (!stamp || stamp.vision !== true || stamp.enabled !== true || stamp.keyPresent !== true) {
    const turnedOff = stamp && stamp.vision === true && stamp.keyPresent === true && stamp.enabled !== true;
    return skip(turnedOff ? "disabled" : "not-configured");
  }

  const cropFn = typeof scoped.cropPngFor === "function" ? scoped.cropPngFor : cropPngFor;
  let png = null;
  try {
    png = await cropFn(blockFromUnit(unit), scoped);
  } catch {
    png = null;
  }
  if (!(await checkpoint(scoped, "before-send", stamp))) {
    return failed(scoped.signal?.aborted ? "aborted" : "stale", { epoch, cache: false });
  }
  if (!png || png.mime !== "image/png" || !png.base64 || /^https?:/i.test(png.base64)) {
    return failed("http", { epoch, cache: false, summary: "需要 PNG 裁图", visionCode: "http" });
  }

  const settings = settingsNow(scoped);
  const secrets = knownSecrets(settings);
  const target = multimodalTarget(settings || {});
  const send = typeof scoped.sendVision === "function" ? scoped.sendVision : sendVision;
  let response;
  try {
    response = await send({
      target,
      system: FORMULA_VISION_SYSTEM,
      text: formulaVisionText(unit),
      images: [{ mime: "image/png", base64: png.base64 }],
      signal: scoped.signal,
      purpose: "multimodal",
      readSecret: typeof scoped.readSecret === "function"
        ? scoped.readSecret
        : async () => String(settingsNow(scoped)?.multimodal?.apiKey || ""),
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
    const reason = code === "aborted" && !scoped.signal?.aborted ? "stale" : visionReason(code);
    if (scoped.mmTraffic && reason !== "aborted" && reason !== "stale") scoped.mmTraffic.sent += 1;
    return failed(reason, {
      epoch,
      cache: reason === "aborted" || reason === "stale" ? false : undefined,
      visionCode: code,
      summary: scrubSummary(response?.error?.summary || "", secrets)
    });
  }

  const text = response.text;
  const keepSent = () => {
    if (scoped.mmTraffic) scoped.mmTraffic.sent += 1;
  };
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
  if (containsSecret(parsed.latex, secrets)) {
    keepSent();
    return failed("unreadable", { epoch, cache: false, parseReason: "secret", summary: "" });
  }
  const verdict = verifyCandidate(parsed.latex, unit, scoped.katex);
  if (!(await checkpoint(scoped, "before-return", stamp))) {
    return failed(scoped.signal?.aborted ? "aborted" : "stale", { epoch, cache: false });
  }
  keepSent();
  if (!verdict.pass) {
    return failed(verdict.reason || "charset-mismatch", {
      epoch,
      latex: parsed.latex,
      confidence: verdict.confidence,
      checks: verdict.checks
    });
  }
  return tierResult({
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: parsed.latex,
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
