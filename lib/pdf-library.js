/** Saved PDF readout. The viewer restores this instead of translating again. */

import { blockTranslationIntegrity, isTranslatableBlock, alignReusedFormulaSlots, remapLiveExtraPlaceholders, remapRetiredPlaintextPlaceholders, translationWithLiveSlots } from "./pdf-blocks.js";
import { layoutCurrentForEngine, layoutCurrentForLibrary, layoutReadyForZone } from "./pdf-layout-client.js";
import {
  LIBRARY_SOURCE_MAX_BYTES,
  arxivPdfUrl,
  cleanTitle,
  countTranslated,
  httpSourceUrl,
  matchLibraryBytes,
  sha256HexOf
} from "./library-record.js";
import { diagLog } from "./diag-log.js";
import { libraryLoadedAt, libraryReviveAllowed, libraryWritesStopped } from "./library-writes.js";
import { storedFormulaPipeline } from "./formula-pipeline.js";

export { LIBRARY_SOURCE_MAX_BYTES, cleanTitle, countTranslated, matchLibraryBytes };

function noteLibraryDiag(code, page) {
  const fields = { code: String(code || "write") };
  const pageNo = Math.floor(Number(page));
  if (pageNo >= 1) fields.page = pageNo;
  diagLog("library.error", fields);
}

const LIBRARY_BASE = "http://127.0.0.1:8765";

export const LIBRARY_PROBE_DELAYS_MS = Object.freeze([0, 400, 1000, 1800]);

/**
 * How long zoning waits for the IndexedDB read before it will also join an
 * in-flight migration GET. The GET's own retries are not part of this wait.
 */
export const LIBRARY_ZONE_WAIT_MS = 300;

/**
 * Hard cap from the start of the library open to the zoning decision.
 * It covers the open and the read. Past this, zoning is requested anyway.
 * A later current layout still wins: the deferred write does not overwrite it.
 */
export const LIBRARY_ZONE_HARD_MS = 1500;

const libraryUiHooks = {
  onMoveStart() {},
  onMoveEnd() {},
  onStorageBlocked() {},
  onWriteFailed() {},
  onLibraryPageSaved() {}
};

export function setLibraryUiHooks(hooks = {}) {
  libraryUiHooks.onMoveStart = typeof hooks.onMoveStart === "function" ? hooks.onMoveStart : () => {};
  libraryUiHooks.onMoveEnd = typeof hooks.onMoveEnd === "function" ? hooks.onMoveEnd : () => {};
  libraryUiHooks.onStorageBlocked = typeof hooks.onStorageBlocked === "function" ? hooks.onStorageBlocked : () => {};
  libraryUiHooks.onWriteFailed = typeof hooks.onWriteFailed === "function" ? hooks.onWriteFailed : () => {};
  libraryUiHooks.onLibraryPageSaved = typeof hooks.onLibraryPageSaved === "function" ? hooks.onLibraryPageSaved : () => {};
}

const pendingLibraryPages = [];

export function pendingLibraryPagesSnapshot() {
  return pendingLibraryPages.map((item) => ({ ...item }));
}

export function notePendingLibraryPage(payload) {
  if (!payload || !payload.hash || !(Number(payload.page) >= 1)) return;
  const page = Number(payload.page);
  const index = pendingLibraryPages.findIndex((item) => item.hash === payload.hash && Number(item.page) === page);
  const copy = { ...payload, page };
  if (index >= 0) pendingLibraryPages[index] = copy;
  else pendingLibraryPages.push(copy);
}

export function clearPendingLibraryPages() {
  pendingLibraryPages.length = 0;
}

export const LIBRARY_PROBE_WARNING = "本地库不可用，将直接翻译。";

/** Bibliography / skipTranslate pages keep the original. This is not a review failure. */
export const PAGE_STATUS_BIBLIOGRAPHY = "本页为参考文献，保留原文（不自动翻译）。";

/** A real pending, source-uncertain, or integrity failure on a translatable block. */
export const PAGE_STATUS_PENDING_REVIEW = "本页旧译文有待核对的段落；原文已保留。";

/** Library hole that is not a skip-only page and not a corrupt translation. */
export const PAGE_STATUS_UNSAVED = "本页尚未写入本地库。";

/** Whole-document reuse when stored pairs still need review on translatable blocks. Holes are filled automatically. */
export const LIBRARY_HOLD_PENDING = "本地库有逐页记录；待核对段落将自动补译。";

/** Whole-document reuse. Intentional skips are not described as pending-review failures. */
export const LIBRARY_HOLD_READY = "本地库已有逐页记录，已沿用保存的译文。参考文献保留原文，不会自动翻译。";

/** A down library is a warning. Live OI_TRANSLATE_BATCH still runs. */
export function libraryProbeFailure() {
  return { continue: true, warning: LIBRARY_PROBE_WARNING };
}

/** Preserve page-save order, including when an earlier write fails. */
export function createLibraryWriteQueue() {
  let tail = Promise.resolve();
  return (write) => {
    const job = tail.then(write);
    tail = job.catch(() => {});
    return job;
  };
}

function readablePng(dataUrl) {
  try {
    const header = atob(String(dataUrl).split(",")[1].slice(0, 36));
    if (header.slice(1, 4) !== "PNG") return false;
    const value = (at) => (
      (header.charCodeAt(at) * 0x1000000) +
      (header.charCodeAt(at + 1) << 16) +
      (header.charCodeAt(at + 2) << 8) +
      header.charCodeAt(at + 3)
    );
    return value(16) >= 24 && value(20) >= 12;
  } catch {
    return false;
  }
}

export function storedReadoutBlocks(markdown) {
  const blocks = [];
  const recentParagraphs = new Map();
  const normalized = String(markdown || "").replace(/\r\n?/g, "\n");
  for (const part of normalized.split(/\n{2,}/)) {
    const chunk = part.trim();
    if (!chunk) continue;
    const visual = chunk.replace(/^#{1,2}[ \t]+(?=!\[)/, "");
    const image = visual.match(/^!\[([^\]]*)\]\((data:image\/png;base64,[A-Za-z0-9+/=]+)\)$/);
    if (image) {
      if (readablePng(image[2])) blocks.push({ tag: "img", alt: image[1] || "公式", src: image[2] });
      continue;
    }
    if (visual.startsWith("![") || /data:image\/|chrome-extension:\/\//.test(chunk)) continue;
    const heading = chunk.match(/^(#{1,2})[ \t]+([^\n]+)$/);
    if (heading && heading[2].length <= 100 && !/[。；;]/.test(heading[2])) {
      blocks.push({ tag: heading[1].length === 1 ? "h1" : "h2", text: heading[2].trim() });
      continue;
    }
    const text = chunk.replace(/^#+\s*/, "");
    const previous = recentParagraphs.get(text);
    if (text.length >= 80 && previous != null && blocks.length - previous < 30) continue;
    if (text.length >= 80) recentParagraphs.set(text, blocks.length);
    blocks.push({ tag: "p", text });
  }
  return blocks;
}

/**
 * Old library rows stored the title and Abstract without a bid. Bind those
 * bids, and fold a just-finished structure pass into the same page record.
 * The next reopen can reuse the row instead of asking for the page again.
 * Two live blocks with the same text stay unbound.
 */
export function commitLandedStructurePairs(existing, landedRows, blocks, lang = "zh-CN") {
  const settings = { targetLang: lang || "zh-CN" };
  const healed = bindStructureRowBids(existing, blocks);
  const landed = bindStructureRowBids(landedRows, blocks);
  const verified = pairsVerifiedForLibrary(landed, blocks, settings);
  if (!verified.length) return healed;
  return mergeLibraryPairs(healed, verified, blocks, settings.targetLang);
}

export function structurePairsChanged(before, after) {
  const prev = before || [];
  const next = after || [];
  if (prev.length !== next.length) return true;
  return next.some((row, index) => {
    const prior = prev[index] || {};
    return String(row?.bid || "") !== String(prior.bid || "")
      || String(row?.translation || "") !== String(prior.translation || "");
  });
}

/** Attach the single live block bid that shares this row's source text. */
export function bindStructureRowBids(rows, blocks) {
  const byText = new Map();
  for (const block of blocks || []) {
    if (!isTranslatableBlock(block)) continue;
    const bid = String(block?.bid || "");
    if (!bid) continue;
    const key = normalizedSourceText(block.sourceText || block.text);
    if (!key) continue;
    const bucket = byText.get(key) || [];
    bucket.push(block);
    byText.set(key, bucket);
  }
  return (rows || []).map((row) => {
    if (!row || String(row.bid || "")) return row;
    const key = normalizedSourceText(row.sourceText || row.text || row.original);
    const matches = key ? byText.get(key) || [] : [];
    if (matches.length !== 1) return row;
    const block = matches[0];
    return {
      ...row,
      bid: String(block.bid),
      ...(block.sourceId ? { sourceId: String(block.sourceId) } : {}),
      ...(block.id ? { id: String(block.id) } : {}),
      sourceText: String(block.sourceText || block.text || "")
    };
  });
}

export function pairsFromResults(results, settings = {}) {
  const targetLang = String(settings?.targetLang || "").trim();
  const provider = String(settings?.provider || "").trim();
  return (results || []).map((item) => ({
    text: String(item?.text || item?.original || "").trim(),
    translation: String(item?.translation || "").trim(),
    ...(item?.sourceId ? { sourceId: String(item.sourceId) } : {}),
    ...(item?.sourceText ? { sourceText: String(item.sourceText) } : {}),
    ...(item?.id ? { id: String(item.id) } : {}),
    ...(item?.bid ? { bid: String(item.bid) } : {}),
    ...(targetLang ? { targetLang } : {}),
    ...(provider ? { provider } : {}),
    formulaPipeline: storedFormulaPipeline(settings?.formulaPipeline || item?.formulaPipeline)
  })).filter((item) => item.text && item.translation);
}

/**
 * Keep a pair only when its bid is a live block and the source hash still matches.
 * A pair with no bid, or a hash that belongs to a different block, is not written back.
 * When the page has no bids (a readout), the pairs are returned unchanged.
 */
export function pairsVerifiedForLibrary(results, blocks, settings = {}) {
  const live = new Map();
  for (const block of blocks || []) {
    const bid = String(block?.bid || "");
    if (bid) live.set(bid, block);
  }
  const pairs = pairsFromResults(results, settings);
  if (!live.size) return pairs;
  return pairs.filter((pair) => {
    const block = live.get(String(pair.bid || ""));
    if (!block) return false;
    const pairHash = sourceReuseHash(pair.sourceText || pair.text);
    const liveHash = sourceReuseHash(block.sourceText || block.text);
    return Boolean(pairHash) && pairHash === liveHash;
  });
}

/**
 * Fill library holes by bid. A settled pair whose source hash still matches stays,
 * even when the incoming row carries a different translation. Pairs with no bid are
 * kept only when they were already stored; a new row without a bid is dropped.
 */
export function mergeLibraryPairs(existing, incoming, blocks, targetLang = "zh-CN") {
  const live = new Map();
  for (const block of blocks || []) {
    const bid = String(block?.bid || "");
    if (bid) live.set(bid, block);
  }
  const byBid = new Map();
  const rest = [];
  for (const pair of existing || []) {
    const bid = String(pair?.bid || "");
    if (!bid) {
      rest.push(pair);
      continue;
    }
    if (!byBid.has(bid)) byBid.set(bid, pair);
  }
  for (const pair of incoming || []) {
    const bid = String(pair?.bid || "");
    if (!bid) continue;
    if (live.size) {
      const block = live.get(bid);
      if (!block) continue;
      const pairHash = sourceReuseHash(pair.sourceText || pair.text);
      const liveHash = sourceReuseHash(block.sourceText || block.text);
      if (!pairHash || pairHash !== liveHash) continue;
    }
    const prev = byBid.get(bid);
    if (prev && reuseSettled(prev, { targetLang })) {
      const prevHash = sourceReuseHash(prev.sourceText || prev.text);
      const nextHash = sourceReuseHash(pair.sourceText || pair.text);
      if (!nextHash || prevHash === nextHash) {
        const prevEcho = normalizedSourceText(prev.translation).toLowerCase() === normalizedSourceText(prev.text || prev.sourceText).toLowerCase();
        const nextEcho = normalizedSourceText(pair.translation).toLowerCase() === normalizedSourceText(pair.text || pair.sourceText).toLowerCase();
        if (!(prevEcho && !nextEcho && reuseSettled(pair, { targetLang }))) continue;
      }
    }
    byBid.set(bid, pair);
  }
  return [...byBid.values(), ...rest];
}

/** Attention page 5. Locate by this sentence; the stored sourceId may change. */
export function isMatrixProjectionSentence(text) {
  return /Where the projections are parameter matrices\b/.test(String(text || ""));
}

/**
 * Chinese for the trusted matrix sentence. Both formula crops stay ⟦fN⟧ tokens.
 * Returns "" unless the live sentence has exactly two placeholders in order.
 * This is not a reviewed translation.
 */
export function composeMatrixProjectionTranslation(text) {
  const source = String(text || "");
  const tokens = [...source.matchAll(/⟦f\d+⟧/g)].map((match) => match[0]);
  if (tokens.length !== 2) return "";
  const translation = `其中这些投影是参数矩阵 ${tokens[0]} 和 ${tokens[1]}。`;
  return blockTranslationIntegrity({ text: source, translation }).valid ? translation : "";
}

function normalizedField(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/** NFKC plus collapsed whitespace. Punctuation stays, so nearby sentences do not collapse. */
export function normalizedSourceText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** 128-bit FNV-1a of the normalized source. Empty source has no hash. */
export function sourceReuseHash(value) {
  const text = normalizedSourceText(value);
  if (!text) return "";
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const mix = (seed) => {
    let hash = seed;
    for (const ch of text) {
      hash ^= BigInt(ch.codePointAt(0));
      hash = (hash * prime) & mask;
    }
    return hash.toString(16).padStart(16, "0");
  };
  return mix(0xcbf29ce484222325n) + mix(0x84222325cbf29ce4n);
}

function pairSourceText(row) {
  return row?.text || row?.original || row?.sourceText || "";
}

function isSourceEcho(pair) {
  const translation = normalizedSourceText(pair?.translation).toLowerCase();
  const source = normalizedSourceText(pairSourceText(pair)).toLowerCase();
  return Boolean(source) && translation === source;
}

/**
 * Settled for reuse. An echo (the translator returned the source) is kept.
 * A later real translation of the same source still replaces it.
 */
function reuseSettled(pair, settings = {}) {
  const translation = String(pair?.translation || "").trim();
  if (!translation) return false;
  if (isSourceEcho(pair)) return true;
  const lang = String(settings?.targetLang || pair?.targetLang || "zh-CN").trim() || "zh-CN";
  if (lang === "zh-CN" || lang === "zh-TW") return /[\u4e00-\u9fff]/.test(translation);
  if (lang === "ja") return /[\u4e00-\u9fff]/.test(translation) || /[\u3040-\u30ff]/.test(translation);
  if (lang === "ko") return /[\uac00-\ud7af]/.test(translation);
  if (/[\u4e00-\u9fff]/.test(translation)) return false;
  return /\p{L}/u.test(translation);
}

function pairAcceptsSettings(pair, settings = {}) {
  const wantLang = String(settings?.targetLang || "").trim();
  const wantProvider = String(settings?.provider || "").trim();
  const lang = String(pair?.targetLang || "").trim();
  const provider = String(pair?.provider || "").trim();
  if (wantLang && lang && lang !== wantLang) return false;
  if (wantProvider && provider && provider !== wantProvider) return false;
  // No recorded engine and no recorded language: only when this translation
  // is already in the requested target language.
  if (!provider && wantLang && !lang && !reuseSettled(pair, { targetLang: wantLang })) return false;
  return true;
}

/**
 * Same source, two writes. An echo does not hide a real translation.
 * Two different real translations are a conflict: the caller retranslates.
 * Returns null when neither write may be kept.
 */
function reuseChoice(prev, next, settings) {
  if (!next) return prev || null;
  if (!prev) return next;
  const prevText = String(prev.translation || "").trim();
  const nextText = String(next.translation || "").trim();
  if (prevText === nextText) return prev;
  const prevEcho = isSourceEcho(prev);
  const nextEcho = isSourceEcho(next);
  if (prevEcho !== nextEcho) return prevEcho ? next : prev;
  const prevSettled = reuseSettled(prev, settings);
  const nextSettled = reuseSettled(next, settings);
  if (prevSettled !== nextSettled) return prevSettled ? prev : next;
  return null;
}

function sourcesAgree(hit, unit) {
  const left = normalizedSourceText(hit?.sourceText || "");
  const right = normalizedSourceText(unit?.sourceText || "");
  if (!left || !right) return true;
  return left === right;
}

function textsAgree(hit, unit) {
  const left = normalizedSourceText(hit?.text || hit?.original || "");
  const right = normalizedSourceText(unit?.text || unit?.original || "");
  if (!left || !right) return true;
  return left === right;
}

function identifierAgrees(hit, unit) {
  if (!hit) return false;
  const left = normalizedSourceText(hit.sourceText || "");
  const right = normalizedSourceText(unit.sourceText || "");
  // Same sourceId with the same source sentence is the same block. Display text
  // may still differ when formula placeholders are split out later.
  if (left && right) return left === right;
  return textsAgree(hit, unit);
}

function noteIdentifier(map, conflicts, id, item, settings) {
  if (!id) return;
  const key = String(id);
  if (conflicts.has(key)) return;
  const prev = map.get(key);
  if (!prev) {
    map.set(key, item);
    return;
  }
  const sameSource = normalizedSourceText(pairSourceText(prev)) === normalizedSourceText(pairSourceText(item));
  if (!sameSource) {
    map.delete(key);
    conflicts.add(key);
    return;
  }
  const chosen = reuseChoice(prev, item, settings);
  if (!chosen) {
    map.delete(key);
    conflicts.add(key);
    return;
  }
  map.set(key, chosen);
}

/**
 * Index saved pairs for reuse. A colliding bid or sourceId is not the first
 * write: different sources fall through to the hash, and two real translations
 * of the same source are left unused. An echo does not hide a later translation.
 * A hash maps to one translation only when the settled translations agree.
 * Legacy pairs with no engine stay eligible only when the target language matches.
 */
export function buildSavedPairIndex(pairs, settings = {}) {
  const byBid = new Map();
  const bySourceId = new Map();
  const byText = new Map();
  const byHash = new Map();
  const conflictBids = new Set();
  const conflictSourceIds = new Set();
  const conflictTexts = new Set();
  for (const item of pairs || []) {
    if (!item || !pairAcceptsSettings(item, settings)) continue;
    noteIdentifier(byBid, conflictBids, item.bid, item, settings);
    noteIdentifier(bySourceId, conflictSourceIds, item.sourceId, item, settings);
    if (item.text && !item.sourceId) noteIdentifier(byText, conflictTexts, String(item.text).trim(), item, settings);
    const translation = String(item.translation || "").trim();
    const key = sourceReuseHash(pairSourceText(item));
    if (!key || !translation) continue;
    const prev = byHash.get(key);
    if (!prev) {
      byHash.set(key, { pair: item, translation, conflict: false });
      continue;
    }
    const chosen = reuseChoice(prev.pair, item, settings);
    if (!chosen) prev.conflict = true;
    else if (!prev.conflict) {
      prev.pair = chosen;
      prev.translation = String(chosen.translation || "").trim();
    }
  }
  return { byBid, bySourceId, byText, byHash, conflictBids, conflictSourceIds };
}

/**
 * bid, then sourceId, then a unique source hash, then a legacy text-only pair.
 * An identifier whose source text changed is source-uncertain, not a reuse.
 * An identifier whose source sentence is unchanged is reused even when the
 * display text gained or lost formula placeholders.
 * A hash that maps to two different translations is left unused.
 */
export function selectSavedHit(unit, index) {
  if (!unit || !index) return { hit: null, uncertain: false };
  const bidKey = unit.bid ? String(unit.bid) : "";
  const idKey = unit.sourceId ? String(unit.sourceId) : "";
  const bidHit = bidKey && !index.conflictBids?.has(bidKey) ? index.byBid.get(bidKey) : undefined;
  const idHit = idKey && !index.conflictSourceIds?.has(idKey) ? index.bySourceId.get(idKey) : undefined;
  if (identifierAgrees(bidHit, unit)) return { hit: bidHit, uncertain: false };
  if (identifierAgrees(idHit, unit)) return { hit: idHit, uncertain: false };
  const key = sourceReuseHash(pairSourceText(unit));
  const hashed = key ? index.byHash.get(key) : undefined;
  if (hashed && !hashed.conflict && sourcesAgree(hashed.pair, unit)) {
    return { hit: hashed.pair, uncertain: false };
  }
  const textHit = index.byText.get(String(unit.text || "").trim());
  if (identifierAgrees(textHit, unit)) return { hit: textHit, uncertain: false };
  if ((bidHit && !sourcesAgree(bidHit, unit)) || (idHit && !sourcesAgree(idHit, unit))) {
    return { hit: null, uncertain: true };
  }
  return { hit: null, uncertain: false };
}

function matrixPairIndexes(pairs, unit) {
  const indexes = [];
  pairs.forEach((pair, index) => {
    const sameId = unit.sourceId && String(pair.sourceId || "") === String(unit.sourceId);
    const fingerprint = isMatrixProjectionSentence(pair.text) || isMatrixProjectionSentence(pair.sourceText);
    if (sameId || fingerprint) indexes.push(index);
  });
  return indexes;
}

function keptMatrixTranslation(pair, text, sourceText) {
  const translation = String(pair?.translation || "").trim();
  if (!translation) return "";
  if (!blockTranslationIntegrity({ text, sourceText, translation }).valid) return "";
  return translation;
}

/**
 * Replace a historical empty/uncertain pair for this sentence with supplemented
 * Chinese. Bibliography skipTranslate units are ignored. A sentence that does
 * not yet have two placeholders is left alone — no invented Chinese.
 * Does not mutate `pairs`. Callers that store the result replace the page array.
 */
export function repairMatrixProjectionPairs(pairs, units) {
  const next = (pairs || []).map((pair) => ({ ...pair }));
  let changed = false;
  const matrixUnits = (units || []).filter((unit) =>
    unit &&
    unit.skipTranslate !== true &&
    isTranslatableBlock(unit) &&
    isMatrixProjectionSentence(unit.text || unit.original)
  );
  for (const unit of matrixUnits) {
    const text = String(unit.text || unit.original || "").trim();
    const sourceText = String(unit.sourceText || text);
    const indexes = matrixPairIndexes(next, unit);
    const composed = composeMatrixProjectionTranslation(text);
    const primary = indexes.length ? next[indexes[0]] : null;
    const kept = primary ? keptMatrixTranslation(primary, text, sourceText) : "";
    const translation = kept || composed;
    if (!translation) continue;
    if (!indexes.length && !(pairs || []).length) continue;
    const previous = String(primary?.status || "");
    const status = kept && (previous === "verified" || previous === "supplemented")
      ? previous
      : "supplemented";
    const replacement = {
      ...(kept ? primary : {}),
      ...(unit.id ? { id: String(unit.id) } : {}),
      ...(unit.sourceId ? { sourceId: String(unit.sourceId) } : {}),
      text,
      sourceText,
      translation,
      status
    };
    if (!kept) delete replacement.legacyIndex;
    if (!indexes.length) {
      next.push(replacement);
      changed = true;
      continue;
    }
    const same = indexes.length === 1 &&
      primary.translation === replacement.translation &&
      primary.status === replacement.status &&
      String(primary.sourceId || "") === String(replacement.sourceId || "") &&
      String(primary.id || "") === String(replacement.id || "") &&
      normalizedField(primary.text) === normalizedField(replacement.text) &&
      normalizedField(primary.sourceText) === normalizedField(replacement.sourceText);
    next[indexes[0]] = replacement;
    for (let cursor = indexes.length - 1; cursor >= 1; cursor -= 1) next.splice(indexes[cursor], 1);
    if (!same) changed = true;
  }
  return { pairs: next, changed };
}

export function applySavedPairs(units, pairs, settings = {}) {
  const repaired = repairMatrixProjectionPairs(pairs, units);
  if (repaired.changed && Array.isArray(pairs)) pairs.splice(0, pairs.length, ...repaired.pairs);
  const index = buildSavedPairIndex(repaired.pairs, settings);
  return (units || []).map((unit) => {
    if (unit?.skipTranslate === true) {
      return { ...unit, translation: "", translationStatus: "skipped" };
    }
    const selected = selectSavedHit(unit, index);
    if (selected.uncertain) {
      return { ...unit, translation: "", translationStatus: "source-uncertain" };
    }
    const hit = selected.hit;
    const rawTranslation = String(hit?.translation || unit.translation || "");
    const payload = {
      text: unit.text,
      sourceText: unit.sourceText || unit.text,
      translation: rawTranslation
    };
    const remapped = remapRetiredPlaintextPlaceholders(payload) || remapLiveExtraPlaceholders(payload);
    const aligned = alignReusedFormulaSlots({
      text: unit.text,
      sourceText: unit.sourceText || unit.text,
      translation: remapped || rawTranslation
    }, hit);
    if (aligned.kind === "retranslate") {
      // Keep a visible sentence. A stored translation that still has slots is
      // drawn with this block's crops; if that cannot be done, the source
      // text is the fallback. An empty block is never the result.
      // status "retranslate" paints that sentence and still queues the block.
      // A rewritten slot list must not count as a settled library hit.
      const shown = translationWithLiveSlots(unit, remapped || rawTranslation);
      const visible = String(shown || "").trim() || String(unit.text || unit.sourceText || "");
      return retranslateDisplay(unit, visible);
    }
    const retry = isLiveSlotRetranslate(hit);
    return {
      ...unit,
      translation: aligned.kind === "remapped" ? aligned.translation : (remapped || rawTranslation),
      ...(hit?.failed === true || retry ? { failed: true } : {}),
      ...(retry
        ? { status: "retranslate", translationStatus: "retranslate" }
        : (hit?.status ? { translationStatus: String(hit.status) } : {}))
    };
  });
}

function retranslateDisplay(unit, translation) {
  return {
    ...unit,
    translation,
    failed: true,
    status: "retranslate",
    translationStatus: "retranslate"
  };
}

/** A display rewrite of a misaligned slot list. It is not a settled translation. */
export function isLiveSlotRetranslate(row) {
  return row?.status === "retranslate" || row?.translationStatus === "retranslate";
}

/**
 * The stored pair's formula slots cannot be lined up with the live block.
 * The caller sends that block again. A translation with no slots, or one
 * that remaps cleanly, is not this case.
 */
export function savedPairNeedsRetranslate(unit, hit) {
  if (!unit || !hit) return false;
  const rawTranslation = String(hit.translation || unit.translation || "");
  const payload = {
    text: unit.text,
    sourceText: unit.sourceText || unit.text,
    translation: rawTranslation
  };
  const remapped = remapRetiredPlaintextPlaceholders(payload) || remapLiveExtraPlaceholders(payload);
  const aligned = alignReusedFormulaSlots({
    text: unit.text,
    sourceText: unit.sourceText || unit.text,
    translation: remapped || rawTranslation
  }, hit);
  return aligned.kind === "retranslate";
}

/**
 * Rewrite a just-written translation onto the live block's slots before it is
 * stored. The next open can reuse it: the slot ids match, so it is not sent again.
 */
export function pairsWithLiveFormulaSlots(pairs, blocks) {
  const byBid = new Map();
  for (const block of blocks || []) {
    const bid = String(block?.bid || "");
    if (bid) byBid.set(bid, block);
  }
  return (pairs || []).map((pair) => {
    const block = byBid.get(String(pair?.bid || ""));
    if (!block) return pair;
    const translation = translationWithLiveSlots(block, pair.translation);
    if (!String(translation || "").trim() || translation === pair.translation) return pair;
    return { ...pair, translation };
  });
}

/**
 * The reader's page write. Unaligned stored slots are dropped first, otherwise
 * mergeLibraryPairs keeps that settled pair and the retranslation never lands.
 */
export function mergeStoredPagePairs(existing, incoming, blocks, lang, page) {
  const settings = { targetLang: lang };
  let base = pairsWithoutUnalignedSlots(existing, blocks, settings);
  // A verified bid write replaces the stored pair even when the source hash
  // still matches. mergeLibraryPairs would otherwise keep the settled row, and
  // a translation that was just returned never lands. A layout persist does
  // not set replaceBids, so a stale snapshot cannot restore the old text.
  const replace = page?.replaceBids || incoming?.replaceBids;
  if (replace && typeof replace[Symbol.iterator] === "function") {
    const ids = new Set();
    for (const bid of replace) {
      const key = String(bid || "");
      if (key) ids.add(key);
    }
    if (ids.size) base = base.filter((pair) => !ids.has(String(pair?.bid || "")));
  }
  return mergeLibraryPairs(base, incoming, blocks, lang);
}

/**
 * Drop stored pairs whose formula slots do not line up, so a new translation
 * can be merged. mergeLibraryPairs itself still keeps a settled same-hash pair.
 */
export function pairsWithoutUnalignedSlots(existing, blocks, settings = {}) {
  const pairs = Array.isArray(existing) ? existing.slice() : [];
  if (!pairs.length || !Array.isArray(blocks) || !blocks.length) return pairs;
  const index = buildSavedPairIndex(pairs, settings);
  const drop = new Set();
  for (const block of blocks) {
    if (!isTranslatableBlock(block)) continue;
    const selected = selectSavedHit(block, index);
    if (selected?.hit && savedPairNeedsRetranslate(block, selected.hit)) drop.add(selected.hit);
  }
  if (!drop.size) return pairs;
  return pairs.filter((pair) => !drop.has(pair));
}

function normalizedPairText(row) {
  return String(row?.sourceText || row?.text || "").replace(/\s+/g, " ").trim();
}

function sameSavedBlock(row, block) {
  const rowId = String(row?.sourceId || row?.id || "");
  const blockId = String(block?.sourceId || block?.id || "");
  if (rowId && blockId && rowId === blockId) return true;
  const rowText = normalizedPairText(row);
  const blockText = normalizedPairText(block);
  return Boolean(rowText && blockText && rowText === blockText);
}

/** A page whose prose is entirely intentional skipTranslate and has nothing to translate. */
export function isSkipOnlyPage(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return false;
  const hasSkip = blocks.some((block) => block?.skipTranslate === true);
  const hasTranslatable = blocks.some((block) => isTranslatableBlock(block));
  return hasSkip && !hasTranslatable;
}

function referenceEntryText(row) {
  return /^\[\d+\]/.test(normalizedPairText(row));
}

/** pending / source-uncertain / integrity-fail. skipped and skipTranslate are not review. */
export function isReviewRow(row) {
  if (!row || row.skipTranslate === true) return false;
  const status = String(row.status || row.translationStatus || "");
  if (status === "skipped") return false;
  if (status === "pending" || status === "source-uncertain") return true;
  return Boolean(String(row.translation || "").trim()) && !blockTranslationIntegrity(row).valid;
}

/**
 * Review counts only on a block that would be translated.
 * Bare library holes, bibliography skipTranslate, and `[n]` reference entries do not.
 * Without a layout, a reference-shaped pair stays an intentional skip (historical migration).
 */
export function reviewOnTranslatableBlock(row, blocks) {
  if (!isReviewRow(row)) return false;
  if (!Array.isArray(blocks)) return !referenceEntryText(row);
  const match = blocks.find((block) => sameSavedBlock(row, block));
  if (!match) return false;
  return isTranslatableBlock(match);
}

/**
 * Page soft status.
 * A missing library page (`migrated` + empty pairs) is a hole, not a bad translation.
 * Skip-only holes use the bibliography sentence. True review stays on translatable blocks.
 */
function rowIsMatrixHold(row) {
  return isMatrixProjectionSentence(row?.text) || isMatrixProjectionSentence(row?.sourceText);
}

/** A stored matrix sentence whose Chinese still carries both formula tokens. */
function validMatrixTranslation(row) {
  if (!row || row.skipTranslate === true || !rowIsMatrixHold(row)) return false;
  const status = String(row.status || row.translationStatus || "");
  if (status === "source-uncertain" || status === "pending" || status === "skipped") return false;
  const translation = String(row.translation || "").trim();
  const text = String(row.text || "");
  if (!translation || !isMatrixProjectionSentence(text)) return false;
  return blockTranslationIntegrity({ text, sourceText: row.sourceText || text, translation }).valid;
}

export function pageSoftStatus({ saved = null, restored = [], blocks = null, done = "本页已翻译。" } = {}) {
  const rows = [...(saved?.pairs || []), ...(restored || [])];
  const matrixReady = rows.some((row) => validMatrixTranslation(row));
  if (rows.some((row) => reviewOnTranslatableBlock(row, blocks) && !(matrixReady && rowIsMatrixHold(row)))) {
    return { kind: "pending-review", copy: PAGE_STATUS_PENDING_REVIEW };
  }
  const skipRecord = saved?.skipped === true &&
    !(saved?.pairs || []).some((pair) => String(pair?.translation || "").trim());
  if (isSkipOnlyPage(blocks) || skipRecord) {
    return { kind: "bibliography", copy: PAGE_STATUS_BIBLIOGRAPHY };
  }
  if (saved?.migrated && !(saved?.pairs || []).length) {
    return { kind: "library-hole", copy: PAGE_STATUS_UNSAVED };
  }
  return { kind: "done", copy: done };
}

/** Library-up short-circuit. Do not call intentional non-translation a pending failure. */
export function libraryHoldCopy(pages, blocksByPage = null) {
  const list = Array.isArray(pages) ? pages : [];
  const blocksFor = (page) => {
    if (!blocksByPage) return null;
    if (typeof blocksByPage.get === "function") return blocksByPage.get(page) || null;
    return blocksByPage[page] || null;
  };
  const review = list.some((page) => {
    const blocks = blocksFor(page?.page);
    const pairs = Array.isArray(blocks)
      ? repairMatrixProjectionPairs(page?.pairs, blocks).pairs
      : (page?.pairs || []);
    return pairs.some((pair) => reviewOnTranslatableBlock(pair, blocks));
  });
  return review ? LIBRARY_HOLD_PENDING : LIBRARY_HOLD_READY;
}

/** Lead-in for one block. Intentional skips stay silent; real review still explains itself. */
export function blockSoftLead(block) {
  if (!block || block.skipTranslate === true || block.translationStatus === "skipped" || block.status === "skipped") {
    return "";
  }
  if (block.translationStatus === "source-uncertain" && !block.translation) {
    return "（旧译文未沿用。以下为文字层原文） ";
  }
  if (block.translationStatus === "pending" && !block.translation) {
    return "（译文待核对，以下为原文） ";
  }
  if (block.translation) {
    const integrity = blockTranslationIntegrity(block);
    if (!integrity.valid) {
      if (integrity.reason === "citation-mismatch") return "（引用待对齐） ";
      return "（公式槽待对齐） ";
    }
  }
  return "";
}

/** Internal alignment copy. The reader paints a badge instead of this string. */
export function isInternalSlotLead(lead) {
  return /槽待对齐|⟦f\d+⟧/.test(String(lead || ""));
}

export function slotBadgeForLead(lead) {
  const citation = /引用待对齐/.test(String(lead || ""));
  return {
    kind: "badge",
    label: citation ? "引用" : "公式",
    title: citation ? "引用未对齐，左栏为原文" : "公式未对齐，左栏为原文"
  };
}

/** Drop slot names from exported Markdown. blockSoftLead itself stays internal. */
export function stripUserVisibleSlots(text) {
  return String(text || "")
    .replace(/（公式槽待对齐）\s*/g, "")
    .replace(/（引用待对齐）\s*/g, "")
    .replace(/槽待对齐\s*/g, "")
    .replace(/⟦f\d+⟧/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Page records supersede the legacy whole-document Markdown when both exist. */
export function selectSavedTranslation(document, page, blocks) {
  if (!document) return null;
  const pages = Array.isArray(document.pages) ? document.pages : [];
  if (pages.length) {
    const found = pages.find((item) => item.page === page);
    if (found) return found;
    if (isSkipOnlyPage(blocks)) return { page, pairs: [], skipped: true };
    return { page, pairs: [], migrated: true };
  }
  return document.readout ? { readout: true } : null;
}

function libraryFailure(error) {
  return error?.name === "BlockedError" || error?.type === "blocked" || error?.type === "quota" || error?.type === "corrupt" || error?.type === "private";
}

async function readerStore(options) {
  if (options?.store) return options.store;
  const { sharedLibraryStore } = await import("./library-session.js");
  return sharedLibraryStore();
}

function sleepMs(ms, sleep) {
  if (!ms) return Promise.resolve();
  if (typeof sleep === "function") return Promise.resolve(sleep(ms));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchLegacyDocument(hash, fetchImpl, sleep) {
  for (const delay of LIBRARY_PROBE_DELAYS_MS) {
    await sleepMs(delay, sleep);
    try {
      const res = await fetchImpl(`${LIBRARY_BASE}/v1/library/document?hash=${encodeURIComponent(hash)}`);
      if (res?.status === 404) return null;
      if (!res?.ok) throw new Error(`library HTTP ${res.status}`);
      return await res.json();
    } catch {
      // The Native Messaging host may have just launched port 8765.
    }
  }
  throw new Error("local PDF library unavailable");
}

const KNOWN_LAYOUT_MODES = new Set(["text-layer", "local-ocr", "cloud-ocr"]);

/**
 * Migration must keep the engine that produced the layout.
 * mode / engine / source are that engine. textSource is which text was trusted,
 * not the engine, so it must not turn a local-ocr page into text-layer.
 * A record with none of those is unknown. main's cacheableLayout never wrote an
 * engine, and both text-layer and local-ocr saved through it. The tag stays
 * unknown. It still counts as current for every engine, the way main treats
 * a mode-less layout. Misclassifying a legacy text-layer page under OCR is a
 * pre-existing limitation.
 */
export function migratedLayoutMode(...sources) {
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const key of ["mode", "engine", "source"]) {
      const named = String(src[key] || "");
      if (KNOWN_LAYOUT_MODES.has(named)) return named;
    }
  }
  return "unknown";
}

export function toLibraryRecords(doc, docHash) {
  const hash = String(docHash || doc?.hash || doc?.docHash || "");
  const pagesIn = Array.isArray(doc?.pages) ? doc.pages : [];
  const pages = [];
  const layouts = [];
  for (const page of pagesIn) {
    const pageNo = Math.floor(Number(page?.page));
    const record = {
      page: pageNo,
      pairs: Array.isArray(page?.pairs) ? page.pairs : page?.pairs,
      skipped: page?.skipped === true,
      migrated: page?.migrated === true
    };
    const layoutVersion = page?.layoutVersion || page?.layout?.layoutVersion;
    if (layoutVersion) record.layoutVersion = String(layoutVersion);
    if (page?.rev != null) record.rev = page.rev;
    if (page?.updatedAt != null) record.updatedAt = page.updatedAt;
    pages.push(record);
    if (page?.layout && pageNo >= 1) {
      layouts.push({
        docHash: hash,
        page: pageNo,
        mode: migratedLayoutMode(page.layout, page),
        protocol: String(page.layout.protocol || "blocks-1"),
        layoutRev: layoutVersion ? String(layoutVersion) : "",
        layout: page.layout
      });
    }
  }
  for (const extra of Array.isArray(doc?.layouts) ? doc.layouts : []) {
    const pageNo = Math.floor(Number(extra?.page));
    if (!(pageNo >= 1)) continue;
    const mode = migratedLayoutMode(extra, extra?.layout);
    const protocol = String(extra?.protocol || extra?.layout?.protocol || "blocks-1");
    if (layouts.some((row) => row.page === pageNo && row.mode === mode && row.protocol === protocol)) continue;
    const rev = extra?.layoutRev || extra?.layoutVersion || extra?.layout?.layoutVersion || "";
    const body = extra?.layout && typeof extra.layout === "object" ? extra.layout : null;
    if (!body) continue;
    layouts.push({
      docHash: hash,
      page: pageNo,
      mode,
      protocol,
      layoutRev: rev ? String(rev) : "",
      layout: body
    });
  }
  const translated = countTranslated(pages);
  return {
    paper: {
      title: doc?.title || "",
      fileName: doc?.fileName || "",
      pageCount: Number(doc?.pageCount) || pages.length,
      pagesTranslated: translated,
      readout: doc?.readout || ""
    },
    pages,
    layouts
  };
}

/**
 * The row for this engine wins, even when an older save is newer.
 * With no row for this engine, an unknown or mode-less row wins over a row
 * explicitly tagged with a different engine. unknown is kept. A row with no
 * mode becomes unknown, so the tag survives in the library document.
 * Judgment still treats that tag as main treats a mode-less layout.
 */
export function selectPageLayout(layouts, page, engine) {
  const rows = (layouts || []).filter((item) => Number(item?.page) === Number(page));
  if (!rows.length) return null;
  const want = String(engine || "");
  const rank = (row) => {
    const mode = String(row?.mode || "");
    if (want && mode === want) return 2;
    if (!mode || mode === "unknown") return 1;
    return 0;
  };
  rows.sort((a, b) => {
    const byEngine = rank(b) - rank(a);
    if (byEngine) return byEngine;
    return Number(b?.savedAt || 0) - Number(a?.savedAt || 0);
  });
  const row = rows[0];
  const layout = row?.layout;
  if (!layout || typeof layout !== "object") return null;
  const next = { ...layout };
  const own = String(layout.layoutVersion || layout.layoutRev || "");
  const rev = own ? "" : String(row.layoutRev || "");
  if (rev) {
    next.layoutVersion = rev;
    next.layoutRev = rev;
  }
  if (!next.mode) next.mode = String(row.mode || "") || "unknown";
  return next;
}

export function libraryDocumentFromRecords(paper, pages, layouts, engine) {
  if (!paper || paper.deletedAt) return null;
  return {
    hash: paper.docHash,
    title: paper.title || "",
    pageCount: Number(paper.pageCount) || 0,
    readout: paper.readout || "",
    sourcePath: paper.origin === "local-service" ? "idb" : (paper.docHash ? "idb" : ""),
    layoutRows: Array.isArray(layouts) ? layouts : [],
    pages: (pages || []).map((page) => {
      const layout = selectPageLayout(layouts, page.page, engine);
      const view = {
        page: page.page,
        pairs: Array.isArray(page.pairs) ? page.pairs : []
      };
      if (page.skipped != null) view.skipped = page.skipped === true;
      if (page.migrated != null) view.migrated = page.migrated === true;
      if (page.layoutVersion) view.layoutVersion = page.layoutVersion;
      if (layout) {
        view.layout = layout;
        if (!view.layoutVersion && layout.layoutVersion) view.layoutVersion = layout.layoutVersion;
      }
      return view;
    })
  };
}

async function readStoredDocument(store, hash, engine) {
  const paper = await store.getPaper(hash);
  if (!paper) return null;
  if (paper.deletedAt) return { deleted: true };
  const [pages, layouts] = await Promise.all([
    store.getPages(hash),
    typeof store.listLayouts === "function" ? store.listLayouts(hash) : Promise.resolve([])
  ]);
  return { document: libraryDocumentFromRecords(paper, pages, layouts, engine) };
}

let libraryStoreBlocked = false;
let storageWatchStarted = false;

function noteLibraryStoreUnavailable(error) {
  // Quota, a corrupt database, and private mode are not "blocked".
  // Only a blocked open should make later zoning skip the read.
  if (error?.name === "BlockedError" || error?.type === "blocked") libraryStoreBlocked = true;
}

/**
 * oi-annotations, the same database notes-store.js names NOTES_DB_NAME.
 * Imported lazily so a flat copy of lib/*.js can still load this module.
 */
const LIBRARY_DB_NAME = "oi-annotations";

async function libraryStoreKnownUnavailable() {
  if (libraryStoreBlocked) return true;
  try {
    const { onStorageAvailable, storageOpenIsBlocked } = await import("./platform/idb-open.js");
    if (!storageWatchStarted) {
      storageWatchStarted = true;
      onStorageAvailable(() => { libraryStoreBlocked = false; });
    }
    return storageOpenIsBlocked(LIBRARY_DB_NAME);
  } catch {
    return false;
  }
}

const zoneReads = new Map();

// Last document a read or a migration actually produced. A newer read that is
// still pending must not hide it, or a late text-layer write overwrites unknown.
const zoneSettled = new Map();

const legacyFetches = new Map();
const libraryFetches = new Map();

function documentFromStored(value) {
  if (!value || value.deleted) return null;
  return value.document || null;
}

/**
 * One in-flight IndexedDB read per paper. Zoning and the library probe share it
 * so a slow open is not started twice. A finished read is not reused: the next
 * open has to see what was saved since.
 */
export function beginZoneStoredRead(hash, options = {}) {
  const key = String(hash || "");
  const existing = zoneReads.get(key);
  if (existing?.state === "pending") return existing.promise;
  const entry = { promise: null, state: "pending", value: null, error: null, startedAt: Date.now() };
  entry.promise = (async () => {
    const store = options.store || await readerStore(options);
    try {
      return await readStoredDocument(store, hash, options.engine);
    } catch (error) {
      if (libraryFailure(error)) noteLibraryStoreUnavailable(error);
      throw error;
    }
  })();
  entry.promise.then(
    (value) => {
      entry.state = "ok";
      entry.value = value;
      const doc = documentFromStored(value);
      if (doc) zoneSettled.set(key, doc);
    },
    (error) => {
      entry.state = "error";
      entry.error = error;
    }
  );
  zoneReads.set(key, entry);
  return entry.promise;
}

/** Resolves when the shared IndexedDB read has settled. Does not start a new one. */
export function whenZoneReadSettles(hash) {
  const entry = zoneReads.get(String(hash || ""));
  if (!entry || entry.state !== "pending") return Promise.resolve(entry || null);
  return entry.promise.then(() => entry, () => entry);
}

/**
 * How long zoning may pause before the vendor request.
 * Waits for the IndexedDB read, capped at LIBRARY_ZONE_WAIT_MS.
 * A known blocked or unavailable store returns immediately.
 * This function does not call the 8765 GET.
 */
export async function waitForFirstZone(hash, options = {}) {
  const startedAt = Date.now();
  const waited = () => Date.now() - startedAt;
  const empty = (reason, extra = {}) => ({
    waitedMs: waited(),
    document: null,
    cached: null,
    reason,
    layoutToken: null,
    ...extra
  });
  if (!hash || hash === "nohash") return empty("nohash");
  if (await libraryStoreKnownUnavailable()) return empty("unavailable");
  const cap = Number.isFinite(options.waitMs) ? Math.max(0, options.waitMs) : LIBRARY_ZONE_WAIT_MS;
  const layoutToken = { state: "absent", value: null };
  let layoutPromise = Promise.resolve(null);
  if (typeof options.layoutRead === "function") {
    layoutToken.state = "pending";
    try {
      layoutPromise = Promise.resolve(options.layoutRead()).then(
        (value) => {
          layoutToken.state = "ok";
          layoutToken.value = value;
          return value;
        },
        () => {
          layoutToken.state = "error";
          layoutToken.value = null;
          return null;
        }
      );
    } catch {
      layoutToken.state = "error";
      layoutPromise = Promise.resolve(null);
    }
  }
  const storedPromise = beginZoneStoredRead(hash, options);
  let timer = null;
  let stopWatch = false;
  const capped = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), cap);
  });
  // onblocked records the open immediately. The promise itself still waits
  // out the 10s deadline. Zoning has to notice the flag, or the first blocked
  // open holds the page until that deadline.
  const blockedWatch = (async () => {
    while (!stopWatch) {
      if (await libraryStoreKnownUnavailable()) return { blocked: true };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { blocked: false };
  })();
  let outcome;
  try {
    outcome = await Promise.race([
      Promise.all([
        storedPromise.then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error })
        ),
        layoutPromise
      ]).then(([stored]) => ({ timedOut: false, stored })),
      capped,
      blockedWatch.then((watched) => (watched.blocked ? { blocked: true } : new Promise(() => {})))
    ]);
  } finally {
    stopWatch = true;
    clearTimeout(timer);
  }
  if (outcome.blocked) return empty("unavailable");
  const cached = layoutToken.state === "ok" ? layoutToken.value : null;
  if (outcome.timedOut) {
    const entry = zoneReads.get(String(hash));
    return {
      waitedMs: waited(),
      document: entry?.state === "ok" ? documentFromStored(entry.value) : null,
      cached,
      reason: "cap",
      layoutToken
    };
  }
  if (!outcome.stored.ok) {
    return {
      waitedMs: waited(),
      document: null,
      cached,
      reason: libraryFailure(outcome.stored.error) ? "unavailable" : "error",
      layoutToken
    };
  }
  return {
    waitedMs: waited(),
    document: documentFromStored(outcome.stored.value),
    cached,
    reason: "stored",
    layoutToken
  };
}

/**
 * A cap means the IndexedDB read is still running, not that the page has no
 * layout. Vendor HTTP waits for that read unless the store is blocked, and
 * only until LIBRARY_ZONE_HARD_MS from the start of the open. After that the
 * page zones anyway. A blocked open is noticed from the flag, so zoning does
 * not sit out the 10s deadline. A slow read that returns a current layout
 * before the hard cap never starts HTTP.
 */
export async function resolveZoneForVendor(hash, zone, options = {}) {
  if (!zone || zone.reason !== "cap") return zone;
  if (await libraryStoreKnownUnavailable()) return { ...zone, reason: "unavailable", document: null };
  const key = String(hash || "");
  const entry = zoneReads.get(key);
  if (!entry || entry.state !== "pending") {
    if (entry?.state === "ok") {
      return { ...zone, reason: "stored", document: documentFromStored(entry.value) };
    }
    return { ...zone, reason: "unavailable", document: null };
  }
  const hard = Number.isFinite(options.hardMs) ? Math.max(0, options.hardMs) : LIBRARY_ZONE_HARD_MS;
  const startedAt = Number(entry.startedAt) || (Date.now() - (Number(zone.waitedMs) || 0));
  const remain = Math.max(0, hard - (Date.now() - startedAt));
  const waitedMs = () => Date.now() - startedAt;
  if (remain === 0) return { ...zone, reason: "cap", document: null, waitedMs: waitedMs() };
  let stop = false;
  let timer = null;
  const blocked = (async () => {
    while (!stop) {
      if (await libraryStoreKnownUnavailable()) return "blocked";
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return "stopped";
  })();
  const settled = entry.promise.then(
    (value) => ({ kind: "ok", value }),
    () => ({ kind: "error" })
  );
  const capped = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "hard" }), remain);
  });
  try {
    const outcome = await Promise.race([
      settled,
      blocked.then((kind) => (kind === "blocked" ? { kind: "blocked" } : new Promise(() => {}))),
      capped
    ]);
    if (outcome.kind === "blocked" && zoneReads.get(key)?.state === "pending") {
      return { ...zone, reason: "unavailable", document: null, waitedMs: waitedMs() };
    }
    if (outcome.kind === "hard") {
      return { ...zone, reason: "cap", document: null, waitedMs: waitedMs() };
    }
    if (outcome.kind !== "ok") return { ...zone, reason: "unavailable", document: null, waitedMs: waitedMs() };
    return { ...zone, reason: "stored", document: documentFromStored(outcome.value), waitedMs: waitedMs() };
  } finally {
    stop = true;
    if (timer) clearTimeout(timer);
  }
}

/** True when every page of the stored paper is already in the library. */
export function paperFullyInLibrary(doc) {
  const total = Number(doc?.pageCount) || 0;
  if (!(total >= 1)) return false;
  const have = new Set();
  for (const page of Array.isArray(doc?.pages) ? doc.pages : []) {
    const n = Number(page?.page);
    if (n >= 1 && n <= total) have.add(n);
  }
  return have.size === total;
}

/**
 * GET / on 8765 is the library-and-OCR probe. Skip it only when this paper
 * is already fully stored. A read that is still inside the cap must not
 * probe either: the red banner would flash and then go away.
 */
export function shouldProbeLocalService({ layoutMode, document, zoneReason } = {}) {
  if (layoutMode !== "local-ocr") return false;
  if (paperFullyInLibrary(document)) return false;
  if (zoneReason === "cap") return false;
  return true;
}

/** Translation sits on a finished library read. A blocked or still-open read does not hold it. */
export function translationWaitsForLibrary(zone) {
  return zone?.reason !== "unavailable" && zone?.reason !== "cap";
}

/** A current layout that is already in hand. A read that is still running does not hide one that already landed. */
export function currentLayoutIfArrived({ hash, page, version, cached, engine } = {}) {
  const fromCache = engine
    ? layoutCurrentForEngine(cached, version, engine)
    : layoutReadyForZone(cached, version);
  if (fromCache) return fromCache;
  const key = String(hash || "");
  const entry = zoneReads.get(key);
  if (entry?.state === "ok" && entry.value?.deleted) return null;
  let document = entry?.state === "ok" ? documentFromStored(entry.value) : null;
  if (!document) document = zoneSettled.get(key) || null;
  if (!document) return null;
  const row = (document.pages || []).find((item) => Number(item.page) === Number(page));
  const selected = selectPageLayout(document.layoutRows, page, engine);
  const judged = selected ? { ...(row || {}), layout: selected } : row;
  if (!judged) return null;
  return engine
    ? layoutCurrentForLibrary(judged, version, engine)
    : layoutReadyForZone(judged, version);
}

/** A current layout wins. The fresh zone is what gets stored only when nothing current arrived. */
export function preferArrivedLayout(zoned, arrived) {
  if (arrived) return { layout: arrived, recomputed: false };
  return { layout: zoned, recomputed: true };
}

/**
 * Persist a fresh zone only when no current layout has arrived.
 * A read that is still inside the cap window is rechecked when it settles,
 * and that recheck does not hold up the page.
 */
export function settleFreshZone({ hash, page, version, cachedRead, reason, write, persist, engine } = {}) {
  const cached = () => (typeof cachedRead === "function" ? cachedRead() : null);
  const arrived = currentLayoutIfArrived({ hash, page, version, cached: cached(), engine });
  if (arrived) return Promise.resolve({ recomputed: false, deferred: false, layout: arrived });
  const run = async () => {
    const later = currentLayoutIfArrived({ hash, page, version, cached: cached(), engine });
    if (later) return false;
    // The open failed, usually at the 10s deadline. The current row may still
    // be on disk. A fresh layout must not replace it.
    const entry = zoneReads.get(String(hash || ""));
    if (entry?.state === "error") return false;
    if (typeof write === "function") await write();
    if (typeof persist === "function") await Promise.resolve(persist()).catch(() => {});
    return true;
  };
  if (reason === "cap" || reason === "unavailable") {
    void whenZoneReadSettles(hash).then(run, run).catch(() => {});
    return Promise.resolve({ recomputed: false, deferred: true, layout: null });
  }
  return run().then((wrote) => ({ recomputed: wrote === true, deferred: false, layout: null }));
}

export async function withLibraryDocLock(docHash, fn, locks = globalThis.navigator?.locks) {
  const name = `oi-library-doc:${docHash}`;
  if (!locks || typeof locks.request !== "function") return fn();
  return locks.request(name, { ifAvailable: true }, (lock) => {
    if (!lock) return { skipped: true };
    return fn();
  });
}

async function migrateLegacyDocument(store, hash, legacy, options) {
  const hooks = options.hooks || libraryUiHooks;
  hooks.onMoveStart?.(hash);
  try {
    const locked = await withLibraryDocLock(hash, async () => {
      const current = await readStoredDocument(store, hash);
      if (current?.deleted) return null;
      // A page save can create the paper before the other pages are copied.
      // putLegacyDocument fills only the pages that save never wrote.
      if (current?.document && paperFullyInLibrary(current.document)) return current.document;
      const records = toLibraryRecords(legacy, hash);
      await store.putLegacyDocument(hash, records);
      const stored = await readStoredDocument(store, hash);
      return stored?.document || current?.document || null;
    }, options.locks);
    if (locked && locked.skipped) return { ...legacy, hash: legacy?.hash || hash };
    return locked || null;
  } finally {
    hooks.onMoveEnd?.(hash);
  }
}

/** A library document, or a legacy 8765 body turned into the same shape. */
export function asLibraryDocument(doc, hash, engine) {
  if (!doc) return null;
  if (Array.isArray(doc.layoutRows)) {
    if (!doc.hash && hash) return { ...doc, hash };
    return doc;
  }
  const id = String(hash || doc.hash || doc.docHash || "");
  const rec = toLibraryRecords(doc, id);
  rec.paper.docHash = id;
  return libraryDocumentFromRecords(
    rec.paper,
    rec.pages.map((page) => ({ ...page, docHash: id })),
    rec.layouts,
    engine
  );
}

function rememberZoneDocument(hash, document) {
  const view = asLibraryDocument(document, hash);
  if (!hash || !view) return;
  zoneSettled.set(String(hash), view);
}

/** One legacy GET per paper. Zoning joins it instead of starting another. */
export function beginLegacyLibraryFetch(hash, options = {}) {
  const key = String(hash || "");
  if (!key || key === "nohash") return Promise.resolve(null);
  const existing = legacyFetches.get(key);
  if (existing) return existing.promise;
  // P-A whitelist: 8765 legacy library GET. Probe delays and the unavailable throw stay here.
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  const promise = fetchLegacyDocument(key, fetchImpl, options.sleep);
  const entry = { promise, startedAt: Date.now() };
  legacyFetches.set(key, entry);
  const clear = () => {
    if (legacyFetches.get(key) === entry) legacyFetches.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

/** The in-flight probe for this paper, if zoning or translation already started one. */
export function libraryFetchInFlight(hash) {
  return libraryFetches.get(String(hash || "")) || null;
}

function pageLayoutArrived(document, hash, page, version, engine) {
  const view = asLibraryDocument(document, hash, engine);
  if (!view || !(Number(page) >= 1) || !version) return null;
  const selected = selectPageLayout(view.layoutRows, page, engine);
  if (!selected) return null;
  const row = (view.pages || []).find((item) => Number(item.page) === Number(page));
  const judged = { ...(row || {}), layout: selected };
  return layoutCurrentForLibrary(judged, version, engine) ? view : null;
}

/**
 * Zoning waits for an in-flight migration of this page, and only until
 * LIBRARY_ZONE_HARD_MS from the start of the open. A legacy GET that is still
 * behind a slow IndexedDB read is started once that read passes
 * LIBRARY_ZONE_WAIT_MS, so a 2s open still sees the unknown row before the cap.
 * While that IndexedDB read is still pending, its document wins over a faster
 * legacy GET. The GET is kept and used when the read comes back empty or the
 * cap fires first. Past the cap the page zones anyway. A current row that
 * lands later is not overwritten.
 */
export async function waitForZoneMigration(hash, zone, options = {}) {
  const key = String(hash || "");
  const page = Number(options.page) || 0;
  const engine = options.engine;
  const version = options.version || "";
  const entry = zoneReads.get(key);
  const startedAt = Number(entry?.startedAt) || (Date.now() - (Number(zone?.waitedMs) || 0));
  const hard = Number.isFinite(options.hardMs) ? Math.max(0, options.hardMs) : LIBRARY_ZONE_HARD_MS;
  const left = () => Math.max(0, hard - (Date.now() - startedAt));
  const arrived = pageLayoutArrived(zone?.document, key, page, version, engine);
  if (arrived) return { ...zone, reason: "stored", document: arrived };
  if (entry?.state === "ok") {
    const storedNow = pageLayoutArrived(documentFromStored(entry.value), key, page, version, engine);
    if (storedNow) return { ...zone, reason: "stored", document: storedNow };
  }
  // The IndexedDB read is still going, it came back empty, or the open is
  // blocked. The migration GET has to start now. A blocked open has no row
  // to wait for, and translation still has to see this GET inside the cap.
  if (!zone?.document && !legacyFetches.get(key)) {
    beginLegacyLibraryFetch(key, { fetch: options.fetch, sleep: options.sleep });
  }
  // Reopen stores the updated pairs in IndexedDB. The legacy GET is the
  // original fixture and is often faster. While that read is still in
  // flight it has to win, or translation adopts the fixture and posts again.
  // An empty or failed read still takes the legacy row. Past the cap the
  // held legacy row is used, so a 2s open still sees unknown before zoning.
  const idbPending = zone?.reason === "cap" && entry?.state === "pending";
  const sources = [];
  if (idbPending) {
    sources.push({
      kind: "idb",
      promise: entry.promise.then((value) => documentFromStored(value), () => null)
    });
  }
  const legacy = legacyFetches.get(key);
  if (legacy) sources.push({ kind: "legacy", promise: legacy.promise.then((doc) => doc, () => null) });
  const flight = libraryFetches.get(key);
  if (flight) sources.push({ kind: "probe", promise: flight.promise.then((doc) => doc, () => null) });
  const remain = left();
  if (!sources.length || remain === 0) return zone;
  const found = await new Promise((resolve) => {
    let open = sources.length;
    let settled = false;
    let held = null;
    let idbDone = !idbPending;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(held), remain);
    const maybeFinish = () => {
      if (settled || !idbDone || open > 0) return;
      finish(held);
    };
    for (const source of sources) {
      Promise.resolve(source.promise).then((doc) => {
        if (settled) return;
        const view = pageLayoutArrived(doc, key, page, version, engine);
        if (source.kind === "idb") {
          idbDone = true;
          if (view) {
            finish(view);
            return;
          }
          if (held) {
            finish(held);
            return;
          }
          open -= 1;
          maybeFinish();
          return;
        }
        if (view && !held) held = view;
        if (view && idbDone) {
          finish(held);
          return;
        }
        open -= 1;
        maybeFinish();
      });
    }
  });
  if (!found) return zone;
  rememberZoneDocument(key, found);
  return {
    ...zone,
    reason: "stored",
    document: found,
    waitedMs: Date.now() - startedAt
  };
}

async function readStoredForFetch(hash, store, options, hooks) {
  try {
    return await beginZoneStoredRead(hash, { store, engine: options.engine });
  } catch (error) {
    if (libraryFailure(error) && (error?.type === "blocked" || error?.name === "BlockedError")) {
      hooks.onStorageBlocked?.(error);
    } else if (!libraryFailure(error)) {
      return null;
    } else {
      throw error;
    }
    return null;
  }
}

function legacyView(legacy, hash, engine) {
  const fallback = asLibraryDocument({ ...legacy, hash: legacy.hash || hash }, hash, engine);
  rememberZoneDocument(hash, fallback);
  return fallback || { ...legacy, hash: legacy.hash || hash };
}

function noteAbandonedMigration(error, hooks) {
  if (error?.type === "blocked" || error?.name === "BlockedError") hooks.onStorageBlocked?.(error);
  else if (error?.type === "quota") hooks.onWriteFailed?.(error);
  else if (error?.type !== "corrupt" && error?.type !== "private") hooks.onWriteFailed?.(error);
}

/**
 * A blocked upgrade rejects only when the 10s deadline fires. Translation
 * already has the legacy body. Return as soon as the open is blocked, and
 * never later than the zoning cap. A healthy write still finishes and is
 * what the caller stores.
 */
async function migrateUnlessBlocked(store, hash, legacy, options, hooks, deadlineAt) {
  if (await libraryStoreKnownUnavailable()) return null;
  const remain = Math.max(0, deadlineAt - Date.now());
  if (remain === 0) return null;
  const migrating = migrateLegacyDocument(store, hash, legacy, options);
  let stop = false;
  let timer = null;
  const blocked = (async () => {
    while (!stop) {
      if (await libraryStoreKnownUnavailable()) return "blocked";
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return "open";
  })();
  try {
    const outcome = await Promise.race([
      migrating.then((value) => ({ kind: "done", value }), (error) => ({ kind: "error", error })),
      blocked.then((kind) => (kind === "blocked" ? { kind: "blocked" } : new Promise(() => {}))),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "cap" }), remain);
      })
    ]);
    if (outcome.kind === "done") return outcome.value;
    if (outcome.kind === "error") throw outcome.error;
    migrating.catch((error) => noteAbandonedMigration(error, hooks));
    return null;
  } finally {
    stop = true;
    if (timer) clearTimeout(timer);
  }
}

/**
 * A readout-only legacy document has no pages, so it is never "fully in the
 * library". Once migration has copied it, another open must not GET 8765.
 * A paper that already has some pages still fetches, so the missing pages
 * can be filled.
 */
async function migratedReadoutOnly(store, hash, document) {
  if (!document?.readout) return false;
  if ((document.pages || []).length > 0) return false;
  if (typeof store.migrationStatus !== "function") return false;
  try {
    const status = await store.migrationStatus();
    return Array.isArray(status?.doneDocs) && status.doneDocs.includes(String(hash));
  } catch {
    return false;
  }
}

async function fetchLibraryDocumentBody(hash, options = {}) {
  const store = await readerStore(options);
  // P-A whitelist: same 8765 library read. Net retry would change this probe schedule.
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  const hooks = options.hooks || libraryUiHooks;
  const startedAt = Date.now();
  const storedPromise = readStoredForFetch(hash, store, options, hooks);
  let timer = null;
  const early = await Promise.race([
    storedPromise.then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ pending: true }), LIBRARY_ZONE_WAIT_MS);
    })
  ]);
  if (timer) clearTimeout(timer);
  if (early.error) throw early.error;
  let stored = early.pending ? null : early.value;
  let idbStillPending = false;
  const ensureLegacy = () => beginLegacyLibraryFetch(hash, { fetch: fetchImpl, sleep: options.sleep });
  if (early.pending) {
    // The migration GET has to be in flight before the zoning cap. Waiting
    // here for the IndexedDB open is the 10s timeout translation still hit:
    // the GET had already returned, and this await was the only thing left.
    ensureLegacy();
    const remain = Math.max(0, LIBRARY_ZONE_HARD_MS - (Date.now() - startedAt));
    let lateTimer = null;
    const late = await Promise.race([
      storedPromise.then((value) => ({ value }), (error) => ({ error })),
      new Promise((resolve) => {
        lateTimer = setTimeout(() => resolve({ cap: true }), remain);
      })
    ]);
    if (lateTimer) clearTimeout(lateTimer);
    if (late.cap) idbStillPending = true;
    else if (late.error) throw late.error;
    else stored = late.value;
  }
  if (stored?.deleted) return null;
  if (stored?.document && paperFullyInLibrary(stored.document)) {
    rememberZoneDocument(hash, stored.document);
    return stored.document;
  }
  if (stored?.document && await migratedReadoutOnly(store, hash, stored.document)) {
    rememberZoneDocument(hash, stored.document);
    return stored.document;
  }
  const partialDocument = stored?.document || null;
  if (idbStillPending) {
    void storedPromise.then((value) => {
      if (value?.document) rememberZoneDocument(hash, value.document);
    }, () => {});
    let legacy = null;
    try {
      legacy = await ensureLegacy();
    } catch (error) {
      if (error?.message === "local PDF library unavailable") throw error;
      throw new Error("local PDF library unavailable");
    }
    if (!legacy) return partialDocument;
    // IndexedDB is still the open that may time out. Migrating now would
    // sit on that same open. The view is enough for translation and for
    // refusing a later text-layer write. The write waits until the read lands.
    return legacyView(legacy, hash, options.engine);
  }
  let legacy = null;
  try {
    legacy = await ensureLegacy();
  } catch (error) {
    if (partialDocument) return partialDocument;
    if (error?.message === "local PDF library unavailable") throw error;
    throw new Error("local PDF library unavailable");
  }
  if (!legacy) return partialDocument;
  try {
    // The read already finished, so this is not the slow-open path. A v1
    // connection still blocks the upgrade inside putLegacyDocument, and that
    // promise rejects only at the 10s deadline. Translation returns the GET
    // at the block, or at the cap, whichever comes first.
    const migrated = await migrateUnlessBlocked(
      store,
      hash,
      legacy,
      options,
      hooks,
      startedAt + LIBRARY_ZONE_HARD_MS
    );
    if (migrated) {
      rememberZoneDocument(hash, migrated);
      return migrated;
    }
  } catch (error) {
    noteAbandonedMigration(error, hooks);
    return partialDocument || legacyView(legacy, hash, options.engine);
  }
  return partialDocument || legacyView(legacy, hash, options.engine);
}

export function fetchLibraryDocument(hash, options = {}) {
  if (!hash || hash === "nohash") return Promise.resolve(null);
  const key = String(hash);
  const existing = libraryFetches.get(key);
  if (existing) return existing.promise;
  const promise = fetchLibraryDocumentBody(hash, options);
  const entry = { promise, startedAt: Date.now() };
  libraryFetches.set(key, entry);
  const clear = () => {
    if (libraryFetches.get(key) === entry) libraryFetches.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

export async function flushPendingPages(options = {}) {
  const batch = pendingLibraryPages.splice(0, pendingLibraryPages.length);
  let saved = 0;
  for (const payload of batch) {
    try {
      await saveLibraryPage(payload, { ...options, rememberPending: false });
      saved += 1;
    } catch (error) {
      notePendingLibraryPage(payload);
      if (error?.type === "blocked" || error?.name === "BlockedError") {
        for (const rest of batch.slice(batch.indexOf(payload) + 1)) notePendingLibraryPage(rest);
        throw error;
      }
    }
  }
  return saved;
}

/**
 * Overwrite one page's in-memory pairs after a successful force retranslate.
 * A readout-only document (no page list yet) is left alone so 「翻译」 still
 * short-circuits on the legacy readout. Returns whether the page list changed.
 */
export function replaceLibraryPagePairs(document, page, pairs) {
  const pageNo = Number(page);
  if (!document || !pageNo || !Array.isArray(document.pages) || !document.pages.length) return false;
  const nextPairs = (pairs || []).map((pair) => ({ ...pair }));
  const existing = document.pages.find((item) => Number(item?.page) === pageNo);
  if (existing) {
    existing.pairs = nextPairs;
    delete existing.migrated;
    delete existing.skipped;
    return true;
  }
  document.pages.push({ page: pageNo, pairs: nextPairs });
  return true;
}

/** A known engine on the write wins. Otherwise keep unknown, including a mode-less body. */
export function recordedLayoutMode(payload) {
  const named = String(payload?.mode || "");
  if (KNOWN_LAYOUT_MODES.has(named)) return named;
  const fromLayout = String(payload?.layout?.mode || "");
  if (KNOWN_LAYOUT_MODES.has(fromLayout) || fromLayout === "unknown") return fromLayout;
  return "unknown";
}

function sourceByteLength(bytes) {
  if (bytes == null) return 0;
  if (typeof Blob !== "undefined" && bytes instanceof Blob) return Number(bytes.size) || 0;
  if (typeof bytes.byteLength === "number") return bytes.byteLength;
  return 0;
}

function asPdfBlob(bytes) {
  if (typeof Blob !== "undefined" && bytes instanceof Blob) return bytes;
  if (bytes instanceof Uint8Array) return new Blob([bytes], { type: "application/pdf" });
  if (bytes instanceof ArrayBuffer) return new Blob([bytes], { type: "application/pdf" });
  if (ArrayBuffer.isView(bytes)) return new Blob([new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)], { type: "application/pdf" });
  return null;
}

/**
 * Store the original PDF once, as a Blob. An existing blob is kept.
 * Over the limit returns too-large and writes nothing. Quota does not throw:
 * the page translation can still be saved.
 */
export async function saveLibrarySource(hash, bytes, options = {}) {
  const id = String(hash || "");
  const size = sourceByteLength(bytes);
  if (!id || id === "nohash" || size <= 0) return { status: "empty", size: 0 };
  const store = await readerStore(options);
  const maxBytes = Number.isFinite(Number(options.maxBytes)) ? Number(options.maxBytes) : LIBRARY_SOURCE_MAX_BYTES;
  if (size > maxBytes) return { status: "too-large", size, maxBytes };
  const blob = asPdfBlob(bytes);
  if (!blob) return { status: "empty", size: 0 };
  let existing = null;
  try {
    existing = typeof store.getSource === "function" ? await store.getSource(id) : null;
  } catch (error) {
    if (error?.type === "blocked" || error?.name === "BlockedError") {
      noteLibraryDiag("blocked");
      throw error;
    }
    if (error?.type === "quota" || error?.name === "QuotaExceededError") {
      noteLibraryDiag("quota");
      return { status: "quota", size };
    }
    throw error;
  }
  if (existing && Number(existing.size) > 0) return { status: "exists", size: Number(existing.size) || size };
  try {
    const wrote = await store.putSource(id, blob);
    if (wrote === false) return { status: "missing", size };
  } catch (error) {
    if (error?.type === "quota" || error?.name === "QuotaExceededError") {
      noteLibraryDiag("source-save");
      return { status: "quota", size };
    }
    noteLibraryDiag(error?.type || "source-save");
    throw error;
  }
  return { status: "saved", size };
}

/**
 * Opening a PDF creates the library row immediately and stores the original
 * once. A tombstone is left deleted. Quota and other source errors stay on
 * the source status so the open itself still returns the paper.
 * `options.record === false` only attaches a blob to a row that already
 * exists. It does not move `lastOpenedAt`. A missing row is still created.
 */
export async function openLibraryPdf(payload, options = {}) {
  const id = String(payload?.hash || "");
  if (!id || id === "nohash") return { paper: null, source: "empty" };
  const store = await readerStore(options);
  if (typeof store.markOpened !== "function") return { paper: null, source: "absent" };
  const identity = {
    title: payload?.title,
    fileName: payload?.fileName,
    sourceUrl: payload?.sourceUrl,
    pageCount: payload?.pageCount,
    origin: payload?.origin
  };
  let paper = null;
  if (options.record === false && typeof store.getPaper === "function") {
    paper = await store.getPaper(id).catch((error) => {
      if (error?.type === "blocked" || error?.name === "BlockedError") throw error;
      return null;
    });
    if (!paper || paper.deletedAt) paper = null;
  }
  if (!paper) paper = await store.markOpened(id, identity);
  if (!paper || payload?.source == null) return { paper, source: "absent" };
  try {
    const source = await saveLibrarySource(id, payload.source, options);
    return { paper, source: source.status };
  } catch (error) {
    if (error?.type === "quota" || error?.name === "QuotaExceededError") return { paper, source: "quota" };
    if (error?.type === "blocked" || error?.name === "BlockedError") return { paper, source: "blocked" };
    return { paper, source: "error" };
  }
}

/** Open a paper. A missing PDF gets a row. A tombstone stays deleted. */
export async function markLibraryOpened(hash, options = {}) {
  const id = String(hash || "");
  if (!id || id === "nohash") return null;
  const store = await readerStore(options);
  if (typeof store.markOpened !== "function") return null;
  return store.markOpened(id);
}

async function bytesFromResponse(res) {
  if (!res || res.ok === false) return null;
  if (res instanceof Uint8Array) return res;
  if (typeof res.arrayBuffer === "function") return new Uint8Array(await res.arrayBuffer());
  return null;
}

/**
 * How to open a library paper. Order: local blob, then sourceUrl / arXiv id
 * (only when `fetch` is injected), then the caller must pick the file again.
 * This does not call the network by itself.
 */
export async function resolveLibraryOpen(hash, options = {}) {
  const id = String(hash || "");
  if (!id) return { status: "missing" };
  const store = await readerStore(options);
  let blob = null;
  try {
    blob = typeof store.getSource === "function" ? await store.getSource(id) : null;
  } catch (error) {
    if (error?.type === "blocked" || error?.name === "BlockedError") throw error;
    blob = null;
  }
  if (blob && Number(blob.size) > 0) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { status: "local", bytes, size: bytes.byteLength };
  }
  const paper = await store.getPaper(id).catch((error) => {
    if (error?.type === "blocked" || error?.name === "BlockedError") throw error;
    return null;
  });
  if (!paper || paper.deletedAt) return { status: "missing" };
  const url = httpSourceUrl(paper.sourceUrl) || arxivPdfUrl(paper.arxiv);
  let urlMismatch = null;
  if (url && typeof options.fetch !== "function" && options.fileBytes == null) {
    return { status: "needs-network", url, arxivId: paper.arxiv?.id ? String(paper.arxiv.id) : "" };
  }
  if (url && typeof options.fetch === "function") {
    let res = null;
    try {
      res = await options.fetch(url);
    } catch {
      res = null;
    }
    const bytes = await bytesFromResponse(res);
    if (bytes?.byteLength) {
      if (sha256HexOf(bytes) === id.toLowerCase()) {
        return { status: "downloaded", bytes, size: bytes.byteLength, url };
      }
      urlMismatch = { status: "hash-mismatch", via: "url", size: bytes.byteLength, url };
      if (options.fileBytes == null) return urlMismatch;
    }
  }
  if (options.fileBytes != null) {
    const raw = typeof Blob !== "undefined" && options.fileBytes instanceof Blob
      ? new Uint8Array(await options.fileBytes.arrayBuffer())
      : options.fileBytes;
    const matched = matchLibraryBytes(id, raw);
    if (matched.status === "match") return { status: "file", bytes: matched.bytes, size: matched.size };
    return matched;
  }
  if (urlMismatch) return urlMismatch;
  return { status: "needs-file" };
}

export async function saveLibraryPage(payload, options = {}) {
  const hash = String(payload?.hash || "");
  const page = Math.floor(Number(payload?.page));
  if (!hash || hash === "nohash" || !(page >= 1)) return;
  const store = await readerStore(options);
  const hooks = options.hooks || libraryUiHooks;
  let source = { status: "absent" };
  try {
    // The translation commits before the original. A slow or failed blob
    // must not leave the page missing: the same-tab reopen reads it immediately.
    const existing = await store.getPaper(hash).catch((error) => {
      if (error?.type === "blocked" || error?.name === "BlockedError") throw error;
      return null;
    });
    // A delete notice stops this tab. revive stays false so a late page
    // write cannot clear deletedAt. A fresh open clears the stop first.
    const stopped = libraryWritesStopped(hash);
    const revive = stopped ? false : payload.revive !== false;
    if (revive !== true && (stopped || existing?.deletedAt)) {
      return { source: "absent" };
    }
    const paperPatch = (row) => {
      const patch = {
        title: payload.title || undefined,
        pageCount: payload.pageCount,
        revive
      };
      if (payload.fileName) patch.fileName = String(payload.fileName);
      if (payload.sourceUrl) patch.sourceUrl = payload.sourceUrl;
      if (!row) patch.opened = true;
      if (!row || row.deletedAt) patch.origin = row?.origin || "native";
      return patch;
    };
    const pageInput = {
      pairs: Array.isArray(payload.pairs) ? payload.pairs : [],
      skipped: payload.skipped === true,
      runState: payload.runState,
      migrated: payload.migrated === true,
      layoutVersion: payload.layoutVersion || payload.layout?.layoutVersion,
      blocks: payload.blocks,
      targetLang: payload.targetLang,
      ...(Array.isArray(payload.replaceBids) && payload.replaceBids.length
        ? { replaceBids: payload.replaceBids.map((bid) => String(bid || "")).filter(Boolean) }
        : {})
    };
    const own = (method) => typeof store[method] === "function"
      && store[method] === store.constructor?.prototype?.[method];
    // A replaced touchPaper or putPage is the test double. Those keep the
    // separate calls. The real store commits both rows in one transaction.
    if (!own("writeLibraryPage") || !own("putPage")) {
      if (typeof store.touchPaper === "function") await store.touchPaper(hash, paperPatch(existing));
      await store.putPage(hash, page, pageInput);
    } else {
      if (!own("touchPaper")) await store.touchPaper(hash, paperPatch(existing));
      const written = await store.writeLibraryPage(hash, page, {
        accept(row) {
          return libraryReviveAllowed({
            existing: row,
            stopped,
            openedAt: libraryLoadedAt(hash),
            revive
          });
        },
        paper: paperPatch,
        page: pageInput
      });
      if (!written || written.refused) return { source: "absent" };
    }
    if (payload.layout) {
      try {
        await store.putLayout({
          docHash: hash,
          page,
          mode: recordedLayoutMode(payload),
          protocol: String(payload.layout.protocol || "blocks-1"),
          layoutRev: String(payload.layoutVersion || payload.layout.layoutVersion || ""),
          layout: payload.layout
        });
      } catch {
        /* the page text is already stored; the layout can be rebuilt */
      }
    }
    if (payload?.source != null) {
      try {
        source = await saveLibrarySource(hash, payload.source, options);
      } catch (error) {
        noteLibraryDiag(error?.type || error?.name || "source-save");
        const blocked = error?.type === "blocked" || error?.name === "BlockedError";
        const quota = error?.type === "quota" || error?.name === "QuotaExceededError";
        if (blocked) {
          source = { status: "blocked" };
          if (options.rememberPending !== false) notePendingLibraryPage(payload);
          hooks.onStorageBlocked?.(error);
        } else if (quota) {
          source = { status: "quota" };
        } else {
          // The page row is already committed. A source miss is not a page failure.
          source = { status: "error" };
        }
      }
      if (source.status === "saved" || source.status === "exists") {
        const current = await store.getPaper(hash);
        if (current && !current.deletedAt && current.sourceSize !== source.size) {
          await store.touchPaper(hash, { sourceSize: source.size });
        }
      }
    }
    await hooks.onLibraryPageSaved?.(payload);
    return { source: source.status };
  } catch (error) {
    noteLibraryDiag(error?.type || "page-save", page);
    if (options.rememberPending !== false && (error?.type === "blocked" || error?.type === "quota" || error?.name === "BlockedError")) {
      notePendingLibraryPage(payload);
    }
    if (error?.type === "blocked" || error?.name === "BlockedError") hooks.onStorageBlocked?.(error);
    else if (error?.type === "quota") hooks.onWriteFailed?.(error);
    throw error;
  }
}
