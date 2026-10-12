/**
 * Block anchors for notes.
 * resolveBlockAnchor is used as-is (BID-10). This file does not fuzzy-match
 * and does not search more than one page away from the note.
 */

import {
  BID_VERSION,
  bidText,
  blockSrcHash,
  blockSrcHead,
  resolveBlockAnchor
} from "./pdf-block-id.js";
import { currentLayoutVersion } from "./pdf-layout-client.js";
import { createNotesStore } from "./notes-store.js";

export const QUOTE_CONTEXT = 32;

let shared = null;

export function sharedNotesStore() {
  if (!shared) shared = createNotesStore();
  return shared;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function textQuote(text, start, end, width = QUOTE_CONTEXT) {
  const body = String(text || "");
  const from = Math.max(0, Math.min(start, body.length));
  const to = Math.max(from, Math.min(end, body.length));
  return {
    quote: body.slice(from, to),
    prefix: body.slice(Math.max(0, from - width), from),
    suffix: body.slice(to, to + width)
  };
}

function copyRects(block) {
  const source = Array.isArray(block?.srcRects)
    ? block.srcRects
    : (Array.isArray(block?.rects) ? block.rects : (Array.isArray(block?.bbox) ? [block.bbox] : null));
  if (!source) return undefined;
  return source.map((rect) => (Array.isArray(rect) ? rect.map((value) => Number(value)) : rect));
}

/**
 * Anchor for the block that holds a selection.
 * Translation TextQuote uses prefix/suffix of QUOTE_CONTEXT characters.
 * quoteSrc is the source-text quote and stays valid after a retranslation.
 * offset is a hint inside the translation, not a second source of truth.
 */
export function createBlockAnchor({
  docHash,
  block,
  page,
  translation,
  layoutRev = "",
  start,
  end,
  sourceStart,
  sourceEnd,
  memberBid,
  checkedAt = 0
} = {}) {
  const source = String(block?.sourceText || block?.text || "");
  const trans = String(translation ?? block?.translation ?? "");
  const pageNumber = Number(page) || Number(block?.page) || 0;
  const hasRange = Number.isFinite(Number(start)) && Number.isFinite(Number(end));
  const lo = hasRange ? clamp(Math.min(Number(start), Number(end)), 0, trans.length) : 0;
  const hi = hasRange ? clamp(Math.max(Number(start), Number(end)), 0, trans.length) : trans.length;
  const quote = textQuote(trans, lo, hi);
  const hasSource = Number.isFinite(Number(sourceStart)) && Number.isFinite(Number(sourceEnd));
  const sourceLo = hasSource ? clamp(Math.min(Number(sourceStart), Number(sourceEnd)), 0, source.length) : 0;
  const sourceHi = hasSource ? clamp(Math.max(Number(sourceStart), Number(sourceEnd)), 0, source.length) : source.length;
  const legacy = {};
  if (block?.id && pageNumber >= 1) legacy.pairId = `p${pageNumber}:${block.id}`;
  if (block?.sourceId) legacy.sourceId = String(block.sourceId);
  if (block?.id) legacy.id = String(block.id);
  const anchor = {
    docHash: String(docHash || ""),
    bid: String(block?.bid || ""),
    bidV: BID_VERSION,
    page: pageNumber,
    srcHead: blockSrcHead(source),
    srcHash: blockSrcHash(source),
    quote: quote.quote,
    prefix: quote.prefix,
    suffix: quote.suffix,
    offset: { start: lo, end: hi }
  };
  if (memberBid) anchor.memberBid = String(memberBid);
  const rects = copyRects(block);
  if (rects) anchor.srcRects = rects;
  if (source) anchor.quoteSrc = textQuote(source, sourceLo, sourceHi);
  if (Object.keys(legacy).length) anchor.legacy = legacy;
  return {
    anchor,
    anchorState: {
      status: "exact",
      layoutRev: String(layoutRev || ""),
      checkedAt: Number.isFinite(Number(checkedAt)) ? Number(checkedAt) : 0
    }
  };
}

/** Pages the note is allowed to search: its own page, the one before, and the one after. */
export function pagesTouching(pages, page) {
  const center = Number(page);
  if (!Number.isFinite(center) || center < 1) return Array.isArray(pages) ? pages : [];
  const want = new Set([center - 1, center, center + 1]);
  return (pages || []).filter((entry) => want.has(Number(entry?.page)));
}

export function findTextQuote(text, quote, prefix, suffix) {
  const body = String(text || "");
  const needle = String(quote || "");
  if (!needle || !body.includes(needle)) return null;
  const pre = prefix == null ? "" : String(prefix);
  const post = suffix == null ? "" : String(suffix);
  let from = 0;
  while (from <= body.length) {
    const at = body.indexOf(needle, from);
    if (at < 0) return null;
    const beforeOk = !pre || body.slice(Math.max(0, at - pre.length), at) === pre;
    const afterStart = at + needle.length;
    const afterOk = !post || body.slice(afterStart, afterStart + post.length) === post;
    if (beforeOk && afterOk) return { start: at, end: afterStart };
    from = at + 1;
  }
  return null;
}

function locateOffset(translation, offset) {
  if (!offset || !Number.isFinite(Number(offset.start)) || !Number.isFinite(Number(offset.end))) return null;
  const len = String(translation || "").length;
  const start = clamp(offset.start, 0, len);
  const end = clamp(offset.end, 0, len);
  if (end <= start) return null;
  return { start, end };
}

function findBlock(pages, bid) {
  const wanted = String(bid || "");
  if (!wanted) return null;
  for (const entry of pages || []) {
    for (const block of entry?.blocks || []) {
      if (block?.bid && String(block.bid) === wanted) {
        return { block, page: Number(entry.page) || Number(block.page) || 0 };
      }
    }
  }
  return null;
}

function rememberBid(anchor, nextBid) {
  const bid = String(nextBid || "");
  if (!bid || bid === anchor.bid) return anchor;
  const prior = Array.isArray(anchor.legacy?.bids) ? anchor.legacy.bids.map(String) : [];
  const old = anchor.bid ? String(anchor.bid) : "";
  const bids = !old || prior.includes(old) ? prior : [...prior, old];
  return {
    ...anchor,
    bid,
    legacy: { ...(anchor.legacy || {}), bids: bids.filter((item) => item && item !== bid) }
  };
}

function sameAnchor(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function materiallySame(before, after) {
  return before.page === after.page
    && sameAnchor(before.anchor, after.anchor)
    && (before.anchorState?.status || "") === (after.anchorState?.status || "")
    && (before.anchorState?.layoutRev || "") === (after.anchorState?.layoutRev || "")
    && Boolean(before.anchorState?.drift) === Boolean(after.anchorState?.drift);
}

/** quote / block / lost: layoutRev and checkedAt alone are not a user-visible edit. */
function contentStable(before, after) {
  const status = after?.anchorState?.status || "";
  if (status !== "quote" && status !== "block" && status !== "lost") return false;
  return before.page === after.page
    && sameAnchor(before.anchor, after.anchor)
    && (before.anchorState?.status || "") === status
    && Boolean(before.anchorState?.drift) === Boolean(after.anchorState?.drift);
}

function finish(before, after, located) {
  const changed = !materiallySame(before, after);
  return {
    note: changed ? after : before,
    changed,
    durable: changed && !contentStable(before, after),
    skipped: false,
    located: located || null
  };
}

/**
 * Re-anchor one note.
 * Fast path: same layoutRev and last status exact, unless this pass is a retranslate.
 * Lost keeps the original anchor and page (jump to page N). No fuzzy reattachment.
 */
export function reanchorNote(note, pages, options = {}) {
  if (!note || note.kind === "paperNote" || !note.anchor) {
    return { note, changed: false, skipped: true, located: null };
  }
  const layoutRev = String(options.layoutRev || "");
  const checkedAt = Number.isFinite(Number(options.checkedAt)) ? Number(options.checkedAt) : Date.now();
  const reason = options.reason || "layout";
  const state = note.anchorState || {};
  if (reason !== "retranslate" && layoutRev && state.layoutRev === layoutRev && state.status === "exact") {
    return { note, changed: false, skipped: true, located: null };
  }

  const scoped = pagesTouching(pages, note.anchor.page || note.page);
  const resolved = resolveBlockAnchor(note.anchor, scoped);
  if (resolved.status === "lost" || resolved.status === "quote") {
    const after = {
      ...note,
      page: note.page,
      anchor: note.anchor,
      anchorState: { status: resolved.status, layoutRev, checkedAt }
    };
    return finish(note, after, resolved.status === "quote" ? { how: "quote" } : null);
  }

  const found = findBlock(scoped, resolved.bid);
  if (!found?.block) {
    const after = {
      ...note,
      page: note.page,
      anchor: note.anchor,
      anchorState: { status: "lost", layoutRev, checkedAt }
    };
    return finish(note, after, null);
  }

  const translation = String(found.block.translation || "");
  const source = String(found.block.sourceText || found.block.text || "");
  let located = findTextQuote(translation, note.anchor.quote, note.anchor.prefix, note.anchor.suffix);
  if (located) located = { how: "quote", ...located };
  if (!located && note.anchor.quoteSrc) {
    const src = note.anchor.quoteSrc;
    const hit = findTextQuote(source, src.quote, src.prefix, src.suffix);
    if (hit) located = { how: "quoteSrc", ...hit };
  }
  if (!located) {
    const off = locateOffset(translation, note.anchor.offset);
    if (off) located = { how: "offset", ...off };
  }

  let anchor = rememberBid(note.anchor, resolved.bid);
  const resolvedPage = Number(resolved.page) || found.page || anchor.page;
  if (resolvedPage && resolvedPage !== anchor.page) anchor = { ...anchor, page: resolvedPage };
  const liveHash = blockSrcHash(source);
  const drift = Boolean(anchor.srcHash) && liveHash !== anchor.srcHash;
  const after = {
    ...note,
    page: resolvedPage || note.page,
    anchor,
    anchorState: {
      status: located ? resolved.status : "block",
      layoutRev,
      checkedAt,
      ...(drift ? { drift: true } : {})
    }
  };
  return finish(note, after, located || { how: "block" });
}

export function reanchorNotes(notes, pages, options = {}) {
  const center = Number(options.page) || 0;
  const list = Array.isArray(notes) ? notes : [];
  const selected = center >= 1
    ? list.filter((note) => Math.abs(Number(note?.page) - center) <= 1)
    : list;
  return selected.map((note) => reanchorNote(note, pages, options));
}

/**
 * Viewer hook body. Writes anchor updates through the store and does not render.
 * A failed disk write leaves the note in the store's memory and is reported on the result.
 */
export async function reanchorOpenPage(input = {}) {
  const store = input.store || sharedNotesStore();
  let docHash = String(input.docHash || "");
  if (!docHash && typeof input.resolveDocHash === "function") {
    try {
      docHash = String((await input.resolveDocHash()) || "");
    } catch {
      docHash = "";
    }
  }
  if (!docHash || docHash === "nohash") return null;
  let layoutRev = String(input.layoutRev || "");
  if (!layoutRev) {
    try {
      layoutRev = String(await currentLayoutVersion());
    } catch {
      layoutRev = "";
    }
  }
  const page = Number(input.page) || 0;
  const reason = input.reason || "layout";
  const notes = await store.list(docHash, {});
  const outcomes = reanchorNotes(notes, input.pages || [], {
    page,
    layoutRev,
    checkedAt: Number.isFinite(Number(input.checkedAt)) ? Number(input.checkedAt) : Date.now(),
    reason
  });
  const results = [];
  for (const outcome of outcomes) {
    if (outcome.skipped || !outcome.changed || outcome.durable === false) {
      results.push({ ...outcome, stored: false });
      continue;
    }
    try {
      // Re-anchoring is not the user writing a note, so it must not call persist().
      const saved = await store.put(outcome.note, { persist: false });
      results.push({ ...outcome, note: saved, stored: true });
    } catch (error) {
      results.push({ ...outcome, stored: false, error: error?.type || "write" });
    }
  }
  return { docHash, page, reason, layoutRev, results };
}

const VISUAL_LABELS = new Set(["formula", "figure", "table"]);

function usableProbeBlock(block) {
  if (!block?.bid || !block?.id) return false;
  if (VISUAL_LABELS.has(block.label)) return false;
  return String(block.sourceText || block.text || "").length >= 8;
}

/** A bid that is not the live bid, an alias, or a member bid, so exact match cannot hit. */
export function unusedExactBid(page, blocks) {
  const used = new Set();
  for (const block of blocks || []) {
    if (block?.bid) used.add(String(block.bid));
    for (const alias of block?.bidAliases || []) used.add(String(alias));
    for (const member of block?.memberBids || []) used.add(String(member));
  }
  const pageNumber = Number(page) || 1;
  for (let n = 0; n < 8; n += 1) {
    const bid = `b1-p${pageNumber}-t000dea${n}`;
    if (!used.has(bid)) return bid;
  }
  return `b1-p${pageNumber}-t000deax`;
}

function pickProbeBlock(blocks, blockId, path) {
  const list = (blocks || []).filter(usableProbeBlock);
  if (blockId) return list.find((block) => String(block.id) === String(blockId)) || null;
  if (path === "text") {
    for (const block of list) {
      const head = blockSrcHead(block.sourceText || block.text);
      if (!head) continue;
      const hits = list.filter((item) => bidText(item.sourceText || item.text).startsWith(head));
      if (hits.length === 1) return block;
    }
  }
  return list[0] || null;
}

/**
 * Note whose exact bid cannot match.
 * alias: legacy pairId / sourceId / id still point at the block, srcHead is cleared.
 * text: legacy is removed, srcHead still matches the block.
 * Neither path fuzzy-matches. A miss stays lost and keeps its page.
 */
export function noteWithDeadExactBid({
  block,
  page,
  docHash,
  path,
  id,
  blocks,
  translation
} = {}) {
  if (path !== "alias" && path !== "text") {
    throw new Error("path must be alias or text");
  }
  const pageNumber = Number(page) || Number(block?.page) || 1;
  const made = createBlockAnchor({
    docHash,
    block,
    page: pageNumber,
    translation: translation ?? block?.translation ?? "",
    layoutRev: "dead-exact",
    checkedAt: 0
  });
  const deadBid = unusedExactBid(pageNumber, blocks || [block]);
  const anchor = { ...made.anchor, bid: deadBid, quote: "", prefix: "", suffix: "" };
  if (path === "alias") anchor.srcHead = "";
  else delete anchor.legacy;
  return {
    deadBid,
    note: {
      id: id || `dead-${path}-${pageNumber}-${block?.id || "block"}`,
      schema: 1,
      docHash: String(docHash || ""),
      kind: "highlight",
      author: "me",
      page: pageNumber,
      anchor,
      anchorState: { status: "exact", layoutRev: "dead-exact", checkedAt: 0 }
    }
  };
}

/**
 * Put one dead-exact note and re-anchor it.
 * Real viewer: __oiNotes.injectDeadExact({ path: "alias" | "text" }) when oiAuto is set.
 */
export async function injectDeadExactNote(spec = {}, context = {}) {
  const path = spec.path === "text" ? "text" : (spec.path === "alias" ? "alias" : "");
  if (!path) throw new Error("path must be alias or text");
  const store = typeof context.store === "function" ? context.store() : context.store;
  if (!store) throw new Error("notes store missing");
  let page = Number(spec.page) || 0;
  let pages = page >= 1 && typeof context.pagesFor === "function" ? context.pagesFor(page) : [];
  if (!pages.length && typeof context.pagesFor === "function") {
    const laid = typeof context.laidPages === "function" ? context.laidPages() : [];
    for (const n of laid) {
      const candidate = context.pagesFor(n);
      if ((candidate || []).some((entry) => pickProbeBlock(entry?.blocks, "", path))) {
        page = n;
        pages = candidate;
        break;
      }
    }
  }
  const center = (pages || []).find((entry) => Number(entry?.page) === page)
    || (pages || []).find((entry) => pickProbeBlock(entry?.blocks, "", path));
  const block = pickProbeBlock(center?.blocks, spec.blockId, path);
  if (!block || !center) {
    const error = new Error("no block");
    error.code = "no-block";
    throw error;
  }
  let docHash = String((typeof context.docHash === "function" ? context.docHash() : context.docHash) || "");
  if ((!docHash || docHash === "nohash") && typeof context.resolveDocHash === "function") {
    docHash = String((await context.resolveDocHash()) || "");
  }
  if (!docHash || docHash === "nohash") throw new Error("docHash missing");
  const draft = noteWithDeadExactBid({
    block,
    page: center.page,
    docHash,
    path,
    id: spec.id,
    blocks: center.blocks
  });
  const { deadBid, note } = draft;
  await store.put(note);
  const layoutRev = String((typeof context.layoutRev === "function" ? context.layoutRev() : context.layoutRev) || "probe");
  const result = await reanchorOpenPage({
    store,
    docHash,
    page: center.page,
    pages,
    reason: "probe",
    layoutRev,
    checkedAt: Number.isFinite(Number(spec.checkedAt)) ? Number(spec.checkedAt) : Date.now()
  });
  const saved = await store.get(note.id);
  const row = (result?.results || []).find((item) => item?.note?.id === note.id) || null;
  return {
    noteId: note.id,
    path,
    status: saved?.anchorState?.status || "",
    bid: saved?.anchor?.bid || "",
    page: saved?.page ?? null,
    located: row?.located || null,
    deadBid,
    blockId: String(block.id || "")
  };
}
