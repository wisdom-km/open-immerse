/**
 * Formula decision cache. Multimodal and OCR results only.
 * Self, vector, crop, arXiv source, and placeholder stay out of the store.
 * Same key in flight runs once. Abort or stale does not write.
 */

import { CHAIN_VERSION, cropHashOf, tierCacheKey, tierResult, unitKeyOf } from "./formula-contract.js";
import { decideFormula } from "./formula-chain.js";
import { createDefaultTiers } from "./formula-tiers/index.js";

export const FORMULA_DB = "oi-formula";
export const FORMULA_DOC_LIMIT = 2000;
export const FORMULA_BYTE_LIMIT = 50 * 1024 * 1024;

const CACHED_TIERS = new Set(["multimodal", "ocr"]);
const DURABLE_REJECT = new Set([
  "charset-mismatch",
  "katex-error",
  "unknown-command",
  "uncheckable-glyph"
]);
// One realm, one nonce. Two tabs do not share this counter, so the id is
// nonce:serial and a delete in this tab cannot match the other tab's row.
const writeRealm = globalThis.crypto?.randomUUID?.()
  || `realm-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
let writeSerial = 0;

function nextFormulaWriteId() {
  writeSerial += 1;
  return `${writeRealm}:${writeSerial}`;
}

function writeSerialOf(writeId) {
  const text = String(writeId ?? "");
  const cut = text.lastIndexOf(":");
  if (cut <= 0) return null;
  const nonce = text.slice(0, cut);
  const serial = Number(text.slice(cut + 1));
  if (!nonce || !Number.isFinite(serial)) return null;
  return { nonce, serial };
}

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

export function isDurableFormulaResult(result) {
  if (!result || !isCachedTier(result.tier)) return false;
  if (result.status === "skip") return false;
  if (verifiedKatex(result)) return true;
  if (result.status === "reject" && DURABLE_REJECT.has(result.reason)) return true;
  if (result.reason === "no-vision" || result.meta?.visionCode === "no-vision") return true;
  return false;
}

export function tierCommitAllowed(previous, incoming) {
  const prev = previous?.result;
  const next = incoming?.result;
  // guard:verified-downgrade
  if (verifiedKatex(prev) && !verifiedKatex(next)) return false;
  const prevEpoch = Number(prev?.meta?.epoch);
  const nextEpoch = Number(next?.meta?.epoch);
  if (Number.isFinite(prevEpoch) && Number.isFinite(nextEpoch) && nextEpoch < prevEpoch) return false;
  // guard:write-order — an earlier sample must not cover a newer verified row
  if (verifiedKatex(prev) && verifiedKatex(next)) {
    const prevOrder = writeSerialOf(previous?.writeId);
    const nextOrder = writeSerialOf(incoming?.writeId);
    if (prevOrder && nextOrder && prevOrder.nonce === nextOrder.nonce && nextOrder.serial < prevOrder.serial) {
      return false;
    }
    const prevAt = Number(previous?.decidedAt);
    const nextAt = Number(incoming?.decidedAt);
    if (Number.isFinite(prevAt) && Number.isFinite(nextAt) && nextAt < prevAt) return false;
  }
  return true;
}

export function decisionCommitAllowed(previous, incoming) {
  const prev = previous?.decision?.chosen;
  const next = incoming?.decision?.chosen;
  if (verifiedKatex(prev) && !verifiedKatex(next)) return false;
  const prevEpoch = Number(previous?.epoch);
  const nextEpoch = Number(incoming?.epoch);
  if (Number.isFinite(prevEpoch) && Number.isFinite(nextEpoch) && nextEpoch < prevEpoch) return false;
  return true;
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
    async commitTier(key, record) {
      if (!isCacheableFormulaRecord(record)) return false;
      const existing = tiers.get(key) || null;
      if (!tierCommitAllowed(existing, record)) return false;
      tiers.set(key, stamped(record, key));
      evict(record?.docHash || "");
      return true;
    },
    async deleteTier(key, writeId) {
      const row = tiers.get(key);
      if (!row || row.writeId !== writeId) return false;
      tiers.delete(key);
      return true;
    },
    async getDecision(key) {
      return decisions.has(key) ? clone(decisions.get(key)) : null;
    },
    async putDecision(key, record) {
      if (!isCacheableFormulaRecord(record)) return false;
      const existing = decisions.get(key) || null;
      // guard:decision-commit
      if (!decisionCommitAllowed(existing, record)) return false;
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

  function live(ctx, signal) {
    if (signal?.aborted || ctx?.signal?.aborted) return false;
    if (ctx?.isStale?.()) return false;
    if (typeof ctx?.stillCurrent === "function" && ctx.stillCurrent() === false) return false;
    return true;
  }

  function staleShared(result) {
    return result?.reason === "stale" || result?.reason === "aborted";
  }

  function voided(tier) {
    return tierResult({
      tier: tier?.id || tier || "multimodal",
      status: "error",
      reason: "stale",
      confidence: null,
      meta: { cache: false }
    });
  }

  async function readTier(key) {
    const row = await store.getTier(key);
    if (!row || row.chainVersion !== CHAIN_VERSION) return null;
    return row.result ?? null;
  }

  async function writeTier(key, result, meta) {
    // guard:abort-write
    if (result?.reason === "aborted" || result?.reason === "stale") return false;
    // guard:cache-false
    if (result?.meta?.cache === false) return false;
    // guard:durable-only
    if (!isDurableFormulaResult(result)) return false;
    const storedResult = stripFormulaImageUrl(result);
    const decidedAt = now();
    // Assigned before the pre-commit read, so two writes in one millisecond
    // still have a stable sample order and a distinct delete identity.
    const writeId = nextFormulaWriteId();
    const record = {
      docHash: meta.docHash || "",
      unitKey: meta.unitKey || "",
      cropHash: meta.cropHash || "",
      configFingerprint: meta.configFingerprint || "",
      decidedAt,
      writeId,
      chainVersion: CHAIN_VERSION,
      tier: storedResult.tier,
      model: meta.model || "",
      result: storedResult
    };
    await store.getTier(key);
    // guard:still-before-write
    if (typeof meta.stillCurrent === "function" && meta.stillCurrent() === false) return false;
    const stored = await store.commitTier(key, record);
    if (stored === true && typeof meta.noteWrite === "function") meta.noteWrite(writeId, decidedAt);
    // guard:still-after-write
    if (typeof meta.stillCurrent === "function" && meta.stillCurrent() === false) {
      if (stored && typeof store.deleteTier === "function") await store.deleteTier(key, writeId);
      return false;
    }
    return stored === true;
  }

  return {
    store,
    readTier,
    writeTier,
    async loadTier(tier, unit, ctx, opts) {
      const model = ctx?.model || "-";
      const key = tierRecordKey(unit, tier, model);
      const callerSignal = opts?.signal;
      const tierId = tier?.id || String(tier || "");
      const tierWrite = { key, ok: false, justWrote: false, durable: false, writeId: null };
      // This call's record only. A later caller on the same formula must not replace it.
      if (opts?.writes) opts.writes.set(tierId, tierWrite);
      const hit = await readTier(key);
      if (!live(ctx, callerSignal)) return voided(tier);
      if (hit) {
        tierWrite.ok = true;
        tierWrite.durable = isDurableFormulaResult(hit);
        return hit;
      }
      // guard:retry-takeover
      // Only the caller that starts the shared run puts its ctx inside it.
      // A stale result from someone else's run is not an answer: a live waiter
      // starts or joins one replacement, and that replacement is shared too.
      let shared = null;
      for (;;) {
        let owned = false;
        shared = await gate.run(
          key,
          (sharedSignal) => {
            owned = true;
            return tier.run(unit, ctx, { ...opts, signal: sharedSignal });
          },
          callerSignal
        );
        if (!staleShared(shared) || !live(ctx, callerSignal) || owned) break;
      }
      if (!live(ctx, callerSignal)) return shared;
      const durable = isDurableFormulaResult(shared);
      tierWrite.durable = durable;
      try {
        const wrote = await writeTier(key, shared, {
          docHash: unit?.docHash || "",
          unitKey: unitKeyOf(unit),
          cropHash: cropHashOf(unit),
          configFingerprint: ctx?.configFingerprint || "",
          model,
          stillCurrent: () => live(ctx, callerSignal),
          noteWrite: (id) => {
            tierWrite.writeId = id;
          }
        });
        tierWrite.ok = wrote === true;
        tierWrite.justWrote = wrote === true;
      } catch {
        tierWrite.ok = false;
        tierWrite.justWrote = false;
      }
      return shared;
    },
    async rememberDecision(unit, decision, meta) {
      const chosen = decision?.chosen;
      if (!chosen || !isCachedTier(chosen.tier)) return false;
      // guard:abort-decision
      if (chosen.reason === "aborted" || chosen.reason === "stale") return false;
      if (!isDurableFormulaResult(chosen)) return false;
      const tierWrite = meta?.writes?.get(chosen.tier) || null;
      // guard:tier-decision
      if (tierWrite && tierWrite.durable && !tierWrite.ok) return false;
      const key = unitKeyOf(unit);
      const nextEpoch = Number(chosen?.meta?.epoch ?? meta?.epoch);
      const record = {
        docHash: unit?.docHash || "",
        decidedAt: decision.decidedAt || now(),
        chainVersion: decision.chainVersion || CHAIN_VERSION,
        cropHash: meta.cropHash || cropHashOf(unit),
        model: meta.model || "-",
        tier: chosen.tier,
        epoch: Number.isFinite(nextEpoch) ? nextEpoch : null,
        decision: summarizeDecision(decision)
      };
      await store.getDecision(key);
      // guard:decision-still
      if (typeof meta.stillCurrent === "function" && meta.stillCurrent() === false) return false;
      const stored = await store.putDecision(key, record);
      // guard:decision-after-put — the row may already be visible; do not delete
      // it here, another caller may have replaced it. Refuse this caller instead.
      if (typeof meta.stillCurrent === "function" && meta.stillCurrent() === false) return false;
      return stored === true;
    }
  };
}

function wrapCachedTiers(tiers, cache, writes) {
  const next = { ...tiers };
  for (const id of CACHED_TIERS) {
    const tier = tiers[id];
    if (!tier) continue;
    next[id] = {
      ...tier,
      async run(unit, ctx, opts) {
        return cache.loadTier(tier, unit, ctx, { ...opts, writes });
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
  const writes = new Map();
  const tiers = wrapCachedTiers(ctx.tiers || createDefaultTiers(), cache, writes);
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
    let storedDecision = false;
    try {
      storedDecision = await cache.rememberDecision(unit, decision, {
        model: ctx.model || "-",
        writes,
        stillCurrent: () => !signal?.aborted && !isStale?.() && ctx.stillCurrent?.() !== false
      });
    } catch {
      storedDecision = false;
    }
    const write = writes.get(decision?.chosen?.tier) || null;
    if (write?.justWrote && write.writeId != null && isCachedTier(decision?.chosen?.tier) && isDurableFormulaResult(decision?.chosen) && storedDecision !== true) {
      if (typeof cache.store.deleteTier === "function") {
        try {
          await cache.store.deleteTier(write.key, write.writeId);
        } catch {
          /* the decision and the tier row stay absent together */
        }
      }
    }
  }
  return decision;
}
