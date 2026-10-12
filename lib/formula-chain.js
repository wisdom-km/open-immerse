/**
 * Formula fallback chain. Pure aside from the dependencies injected on ctx.
 * Order: arxiv, multimodal, ocr, self, vector, crop, placeholder.
 * arXiv success returns immediately. One provider, or an undecided pair,
 * goes to crop and does not call self or vector.
 */

import { arbitrateCandidates, verifyCandidate } from "./formula-arbiter.js";
import {
  CALL_FAILURES,
  CHAIN_VERSION,
  VECTOR_MIN,
  failureReason,
  flagsOf,
  tierResult,
  unitKeyOf
} from "./formula-contract.js";
import { cropShownAnyway } from "./formula-tiers/crop.js";
import { createDefaultTiers } from "./formula-tiers/index.js";

const CANDIDATES = ["multimodal", "ocr"];

function staleResult() {
  return tierResult({ tier: "crop", status: "reject", reason: "stale", confidence: null });
}

function skipTier(tier, reason) {
  return tierResult({
    tier: tier.id,
    status: "skip",
    reason,
    confidence: null,
    meta: { version: tier.version }
  });
}

function providerJoined(result) {
  if (!result) return false;
  if (result.status === "skip" && (result.reason === "not-configured" || result.reason === "disabled" || result.reason === "not-implemented")) {
    return false;
  }
  return true;
}

function asError(tier, reason) {
  return tierResult({
    tier: tier.id,
    status: "error",
    reason: CALL_FAILURES.includes(reason) ? reason : failureReason({ reason }),
    confidence: null
  });
}

export async function decideFormula(unit, ctx = {}, options = {}) {
  const flags = flagsOf(ctx.flags);
  const scoped = { ...ctx, flags };
  const tiers = ctx.tiers || createDefaultTiers();
  const signal = options.signal || ctx.signal;
  const isStale = options.isStale || ctx.isStale || (() => false);
  const onUpgrade = options.onUpgrade || ctx.onUpgrade;
  const trace = [];
  const now = ctx.now || Date.now;
  let cropMemo = null;

  const halt = () => {
    if (signal?.aborted) {
      return finish({
        chosen: tierResult({ tier: "crop", status: "reject", reason: "aborted" }),
        forcedReason: "aborted"
      });
    }
    if (isStale()) return finish({ chosen: staleResult(), forcedReason: "stale" });
    return null;
  };

  const finish = ({ chosen, forcedCrop = false, forcedReason = null, preliminary = false } = {}) => {
    const decision = {
      unitKey: unitKeyOf(unit),
      chosen,
      trace: preliminary ? trace.slice() : trace,
      forcedCrop,
      forcedReason,
      decidedAt: now(),
      chainVersion: CHAIN_VERSION,
      preliminary
    };
    return decision;
  };

  const runTier = async (tier) => {
    try {
      if (signal?.aborted) return asError(tier, "aborted");
      if (isStale()) return asError(tier, "stale");
      const result = await tier.run(unit, scoped, { signal });
      return result?.tier ? result : tierResult({ ...result, tier: tier.id });
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") return asError(tier, "aborted");
      return asError(tier, failureReason(err));
    }
  };

  const ensureCrop = async () => {
    if (!cropMemo) cropMemo = await runTier(tiers.crop);
    return cropMemo;
  };

  const showCrop = (result) => (result?.status === "ok" && result.render === "image" ? result : cropShownAnyway(result));

  const afterCrop = async (crop, { forcedCrop, forcedReason }) => {
    trace.push(crop);
    if (crop.status === "ok") {
      return finish({ chosen: crop, forcedCrop, forcedReason });
    }
    const placeholder = tiers.placeholder;
    if (placeholder?.available(scoped)) {
      const placed = await runTier(placeholder);
      trace.push(placed);
      if (placed.status === "ok") return finish({ chosen: placed, forcedCrop, forcedReason });
    } else if (placeholder) {
      trace.push(skipTier(placeholder, placeholder.unavailableReason?.(scoped) || "disabled"));
    }
    return finish({ chosen: showCrop(crop), forcedCrop, forcedReason });
  };

  const forceCrop = async (forcedReason) => {
    const crop = await ensureCrop();
    return afterCrop(crop, { forcedCrop: true, forcedReason });
  };

  const halted = halt();
  if (halted) return halted;

  const arxiv = tiers.arxiv;
  if (arxiv) {
    if (arxiv.available(scoped)) {
      const result = await runTier(arxiv);
      trace.push(result);
      if (result.status === "ok") {
        const decision = finish({ chosen: result, forcedCrop: false, forcedReason: null });
        if (onUpgrade) onUpgrade(decision);
        return decision;
      }
    } else {
      trace.push(skipTier(arxiv, arxiv.unavailableReason?.(scoped) || "disabled"));
    }
  }

  const haltedAfterArxiv = halt();
  if (haltedAfterArxiv) return haltedAfterArxiv;

  const joinedTiers = [];
  for (const id of CANDIDATES) {
    const tier = tiers[id];
    if (!tier) continue;
    if (tier.available(scoped) === true) joinedTiers.push(tier);
    else trace.push(skipTier(tier, tier.unavailableReason?.(scoped) || "not-configured"));
  }

  if (!joinedTiers.length) return fallback(false, null);

  let sentPreview = false;
  const publish = (decision) => {
    if (typeof onUpgrade !== "function") return decision;
    const chosen = decision.chosen;
    const previewCrop = sentPreview && chosen?.tier === "crop" && chosen?.render === "image" && !decision.preliminary;
    if (!previewCrop) onUpgrade(decision);
    return decision;
  };

  if (onUpgrade) {
    const preview = await ensureCrop();
    sentPreview = true;
    onUpgrade(finish({
      chosen: showCrop(preview),
      forcedCrop: false,
      forcedReason: null,
      preliminary: true
    }));
  }

  const ran = await Promise.all(joinedTiers.map((tier) => runTier(tier)));
  ran.forEach((result) => trace.push(result));
  const joined = ran.filter(providerJoined);
  if (!joined.length) return publish(await fallback(false, null));
  const produced = joined.filter((result) => result.status === "ok" && result.latex);
  if (!produced.length) return publish(await forceCrop("single-provider-reject"));
  if (produced.length === 1) return publish(await singleProvider(produced[0]));

  const verdict = await arbitrateCandidates({
    left: produced[0],
    right: produced[1],
    unit,
    katex: ctx.katex,
    pixelJudge: ctx.pixelJudge
  });
  if (verdict.decided) {
    return publish(finish({ chosen: verdict.chosen, forcedCrop: false, forcedReason: null }));
  }
  return publish(await forceCrop(verdict.reason || "arbiter-undecided"));

  async function singleProvider(result) {
    if (result.status === "error" || CALL_FAILURES.includes(result.reason) || !result.latex) {
      return forceCrop("single-provider-reject");
    }
    const verified = verifyCandidate(result.latex, unit, ctx.katex);
    const enriched = tierResult({
      ...result,
      status: verified.pass ? "ok" : "reject",
      render: verified.pass ? "katex" : null,
      confidence: verified.confidence,
      checks: verified.checks,
      reason: verified.pass ? null : verified.reason
    });
    const index = trace.findIndex((item) => item === result);
    if (index >= 0) trace[index] = enriched;
    if (verified.pass) return finish({ chosen: enriched, forcedCrop: false, forcedReason: null });
    const forcedReason = verified.reason === "katex-error" ? "katex-error" : "single-provider-reject";
    return forceCrop(forcedReason);
  }

  async function fallback(forcedCrop, forcedReason) {
    const self = tiers.self;
    if (self) {
      const result = await runTier(self);
      trace.push(result);
      if (result.status === "ok") {
        return finish({ chosen: result, forcedCrop, forcedReason });
      }
    }
    const vector = tiers.vector;
    if (vector) {
      const result = await runTier(vector);
      trace.push(result);
      if (result.status === "ok" && (result.confidence == null || result.confidence >= VECTOR_MIN)) {
        return finish({ chosen: result, forcedCrop, forcedReason });
      }
    }
    const crop = await ensureCrop();
    return afterCrop(crop, { forcedCrop, forcedReason });
  }
}
