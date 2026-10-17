/**
 * Formula decision cache. Multimodal and OCR results only.
 * Self, vector, crop, arXiv source, and placeholder stay out of the store.
 * Same key in flight runs once. Abort or stale does not write.
 */

import { CHAIN_VERSION, cropHashOf, tierCacheKey, unitKeyOf } from "./formula-contract.js";
import { decideFormula } from "./formula-chain.js";
import { createDefaultTiers } from "./formula-tiers/index.js";

export const FORMULA_DB = "oi-formula";
export const FORMULA_DOC_LIMIT = 2000;
export const FORMULA_BYTE_LIMIT = 50 * 1024 * 1024;

const CACHED_TIERS = new Set(["multimodal", "ocr"]);
const SKIP_WRITE = new Set(["aborted", "stale"]);

export function isCachedTier(tier) {
  return CACHED_TIERS.has(tier);
}

export function stripFormulaImageUrl(result) {
  if (!result || typeof result !== "object") return result;
  const next = { ...result };
  if (next.image && typeof next.image === "object") {
    const image = { ...next.image };
    if (typeof image.url === "string" && image.url.startsWith("data:")) delete image.url;
    next.image = image;
  }
  return next;
}

export function summarizeDecision(decision) {
  const chosen = decision?.chosen || {};
  return {
    unitKey: decision?.unitKey || "",
    chosen: {
      tier: chosen.tier || "",
      status: chosen.status || "",
      render: chosen.render ?? null,
      reason: chosen.reason ?? null,
      confidence: chosen.confidence ?? null,
      latex: chosen.render === "katex" ? (chosen.latex ?? null) : null
    },
    trace: (decision?.trace || []).map((item) => ({
      tier: item.tier,
      status: item.status,
      reason: item.reason ?? null,
      render: item.render ?? null
    })),
    forcedCrop: decision?.forcedCrop === true,
    forcedReason: decision?.forcedReason ?? null,
    decidedAt: decision?.decidedAt ?? null,
    chainVersion: decision?.chainVersion || CHAIN_VERSION
  };
}

export function tierRecordKey(unit, tier, model) {
  return tierCacheKey({
    unitKey: unitKeyOf(unit),
    tier: tier?.id || tier,
    version: tier?.version || "",
    model: model || "-",
    cropHash: cropHashOf(unit)
  });
}

export function isCacheableFormulaRecord(record) {
  const tier = record?.tier || record?.result?.tier || record?.decision?.chosen?.tier;
  return isCachedTier(tier);
}

function byAge(a, b) {
  const at = Number(a?.decidedAt) || 0;
  const bt = Number(b?.decidedAt) || 0;
  if (at !== bt) return at - bt;
  return String(a?.key || "").localeCompare(String(b?.key || ""));
}

export function evictionKeys(records, { docHash, docLimit, byteLimit } = {}) {
  const rows = (records || []).filter((row) => row && row.key);
  const drop = [];
  const dropped = new Set();
  const mine = rows.filter((row) => row.docHash === docHash).sort(byAge);
  while (mine.length > docLimit) {
    const row = mine.shift();
    drop.push(row.key);
    dropped.add(row.key);
  }
  let total = 0;
  for (const row of rows) {
    if (!dropped.has(row.key)) total += Number(row.bytes) || 0;
  }
  const rest = rows.filter((row) => !dropped.has(row.key)).sort(byAge);
  while (total > byteLimit && rest.length) {
    const row = rest.shift();
    drop.push(row.key);
    dropped.add(row.key);
    total -= Number(row.bytes) || 0;
  }
  return drop;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function verifiedKatex(result) {
  return result?.status === "ok"
    && result?.render === "katex"
    && typeof result?.latex === "string"
    && result.latex.length > 0;
}

function stamped(record, key) {
  const stored = { ...clone(record), key: record?.key || key };
  stored.bytes = JSON.stringify({ ...stored, bytes: 0 }).length;
  return stored;
}

export function createMemoryStore({
  docLimit = FORMULA_DOC_LIMIT,
  byteLimit = FORMULA_BYTE_LIMIT
} = {}) {
  const tiers = new Map();
  const decisions = new Map();

  function rows() {
    return [...tiers.values(), ...decisions.values()];
  }

  function evict(docHash) {
    const keys = new Set(evictionKeys(rows(), { docHash, docLimit, byteLimit }));
    for (const key of keys) {
      tiers.delete(key);
      decisions.delete(key);
    }
  }

  return {
    kind: "memory",
    async getTier(key) {
      return tiers.has(key) ? clone(tiers.get(key)) : null;
    },
    async putTier(key, record) {
      if (!isCacheableFormulaRecord(record)) return false;
      tiers.set(key, stamped(record, key));
      evict(record?.docHash || "");
      return true;
    },
    async getDecision(key) {
      return decisions.has(key) ? clone(decisions.get(key)) : null;
    },
    async putDecision(key, record) {
      if (!isCacheableFormulaRecord(record)) return false;
      decisions.set(key, stamped(record, key));
      evict(record?.docHash || "");
      return true;
    },
    async clearDoc(docHash) {
      for (const [key, row] of tiers) {
        if (row?.docHash === docHash) tiers.delete(key);
      }
      for (const [key, row] of decisions) {
        if (row?.docHash === docHash) decisions.delete(key);
      }
    },
    async clearAll() {
      tiers.clear();
      decisions.clear();
    }
  };
}

function attachCaller(entry, signal) {
  if (signal?.aborted) {
    if (entry.callers.size === 0) entry.controller.abort();
    return;
  }
  const token = {};
  entry.callers.add(token);
  if (!signal || typeof signal.addEventListener !== "function") return;
  const onAbort = () => {
    entry.unlisten.delete(stop);
    entry.callers.delete(token);
    if (entry.callers.size === 0) entry.controller.abort();
  };
  const stop = () => signal.removeEventListener("abort", onAbort);
  entry.unlisten.add(stop);
  signal.addEventListener("abort", onAbort);
}

export function createCallGate() {
  const inflight = new Map();
  return {
    has(key) {
      return inflight.has(key);
    },
    run(key, fn, signal) {
      let entry = inflight.get(key);
      if (!entry || entry.controller.signal.aborted) {
        const controller = new AbortController();
        entry = { controller, callers: new Set(), unlisten: new Set(), promise: null };
        entry.promise = Promise.resolve().then(() => fn(controller.signal)).finally(() => {
          for (const stop of entry.unlisten) stop();
          entry.unlisten.clear();
          if (inflight.get(key) === entry) inflight.delete(key);
        });
        inflight.set(key, entry);
      }
      attachCaller(entry, signal);
      return entry.promise;
    }
  };
}

export function createFormulaCache(store, { now = () => Date.now(), gate = createCallGate() } = {}) {
  if (!store) throw new Error("createFormulaCache requires a store");

  async function readTier(key) {
    const row = await store.getTier(key);
    if (!row || row.chainVersion !== CHAIN_VERSION) return null;
    return row.result ?? null;
  }

  async function writeTier(key, result, meta) {
    if (!result || !isCachedTier(result.tier)) return false;
    if (result.status === "skip") return false;
    if (SKIP_WRITE.has(result.reason)) return false;
    if (result.meta?.cache === false) return false;
    const existing = await store.getTier(key);
    const prev = existing?.result;
    if (verifiedKatex(prev) && !verifiedKatex(result)) return false;
    const prevEpoch = Number(prev?.meta?.epoch);
    const nextEpoch = Number(result?.meta?.epoch);
    if (Number.isFinite(prevEpoch) && Number.isFinite(nextEpoch) && nextEpoch < prevEpoch) return false;
    return store.putTier(key, {
      docHash: meta.docHash || "",
      decidedAt: now(),
      chainVersion: CHAIN_VERSION,
      tier: result.tier,
      model: meta.model || "",
      result: stripFormulaImageUrl(result)
    });
  }

  return {
    store,
    readTier,
    writeTier,
    async loadTier(tier, unit, ctx, opts) {
      const model = ctx?.model || "-";
      const key = tierRecordKey(unit, tier, model);
      const hit = await readTier(key);
      if (hit) return hit;
      const callerSignal = opts?.signal;
      const result = await gate.run(
        key,
        (sharedSignal) => tier.run(unit, ctx, { ...opts, signal: sharedSignal }),
        callerSignal
      );
      if (callerSignal?.aborted || ctx?.isStale?.()) return result;
      if (typeof ctx?.stillCurrent === "function" && ctx.stillCurrent() === false) return result;
      if (typeof ctx?.beforeCacheWrite === "function") {
        const allow = await ctx.beforeCacheWrite(result);
        if (allow === false) return result;
      }
      try {
        await writeTier(key, result, { docHash: unit?.docHash || "", model });
      } catch {
        /* a write that dies halfway must not drop the decision */
      }
      return result;
    },
    async rememberDecision(unit, decision, meta) {
      const chosen = decision?.chosen;
      if (!chosen || !isCachedTier(chosen.tier)) return false;
      if (chosen.reason === "aborted" || chosen.reason === "stale") return false;
      const key = unitKeyOf(unit);
      const existing = await store.getDecision(key);
      const prev = existing?.decision?.chosen;
      if (verifiedKatex(prev) && !verifiedKatex(chosen)) return false;
      const prevEpoch = Number(existing?.epoch);
      const nextEpoch = Number(chosen?.meta?.epoch ?? meta?.epoch);
      if (Number.isFinite(prevEpoch) && Number.isFinite(nextEpoch) && nextEpoch < prevEpoch) return false;
      return store.putDecision(key, {
        docHash: unit?.docHash || "",
        decidedAt: decision.decidedAt || now(),
        chainVersion: decision.chainVersion || CHAIN_VERSION,
        cropHash: meta.cropHash || cropHashOf(unit),
        model: meta.model || "-",
        tier: chosen.tier,
        epoch: Number.isFinite(nextEpoch) ? nextEpoch : null,
        decision: summarizeDecision(decision)
      });
    }
  };
}

function wrapCachedTiers(tiers, cache) {
  const next = { ...tiers };
  for (const id of CACHED_TIERS) {
    const tier = tiers[id];
    if (!tier) continue;
    next[id] = {
      ...tier,
      async run(unit, ctx, opts) {
        return cache.loadTier(tier, unit, ctx, opts);
      }
    };
  }
  return next;
}

export async function decideFormulaCached(unit, ctx = {}, options = {}) {
  const cache = ctx.cache;
  if (!cache) return decideFormula(unit, ctx, options);
  const signal = options.signal || ctx.signal;
  const isStale = options.isStale || ctx.isStale;
  const userUpgrade = options.onUpgrade || ctx.onUpgrade;
  const onUpgrade = (decision) => {
    if (signal?.aborted || isStale?.()) return;
    if (typeof userUpgrade === "function") userUpgrade(decision);
  };
  const tiers = wrapCachedTiers(ctx.tiers || createDefaultTiers(), cache);
  const decision = await decideFormula(unit, {
    ...ctx,
    tiers,
    onUpgrade
  }, {
    ...options,
    signal,
    isStale,
    onUpgrade
  });
  if (!signal?.aborted && !isStale?.() && ctx.stillCurrent?.() !== false) {
    try {
      await cache.rememberDecision(unit, decision, { model: ctx.model || "-" });
    } catch {
      /* the in-memory decision still stands */
    }
  }
  return decision;
}
