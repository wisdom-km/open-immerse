import { normalizedSourceText, sourceReuseHash } from "./pdf-library.js";
import { isCurrentMmPage } from "./mm-page.js";
import { isTranslatableBlock } from "./pdf-blocks.js";

/**
 * A library page that is not already an mp-1 layout has to enter the multimodal
 * queue. A current mm page is the cache hit. No vision key keeps the text layer
 * and the translations already stored for it.
 */
export function pageNeedsMultimodalQueue({ configured = false, layout = null } = {}) {
  if (configured !== true) return false;
  if (isCurrentMmPage(layout)) return false;
  return true;
}

/**
 * Library pairs replace the page only when it has no block layout.
 * An mm page, including one reloaded without `kind`, keeps its own blocks.
 */
export function libraryPairsReplaceLayout(layout) {
  if (!layout || !Array.isArray(layout.blocks) || !layout.blocks.length) return true;
  if (isCurrentMmPage(layout)) return false;
  if (layout.kind === "blocks") return false;
  if (String(layout.mode || "") === "mm-page") return false;
  if (String(layout.pagePipeline || "") === "mp-1") return false;
  return true;
}

/** The stored translation is the English source again. Empty text is not an echo. */
function sourceEcho(translation, source) {
  const text = normalizedSourceText(translation).toLowerCase();
  const src = normalizedSourceText(source).toLowerCase();
  return Boolean(text) && Boolean(src) && text === src;
}

function translationLandsOn(block, translation) {
  const text = String(translation || "").trim();
  if (!text) return false;
  const source = String(block?.text || block?.sourceText || "").trim();
  return text !== source;
}

/**
 * Paint a multimodal block. The live bid wins when that row actually landed.
 * A 200 stored on the pre-stamp bid is an alias. A source echo on the live bid
 * must not hide it. This stays out of pdf-blocks.js so the text-layer revision
 * does not move.
 */
export function applyMmBlockTranslations(blocks, results = []) {
  const byBid = new Map();
  const byId = new Map();
  for (const row of results || []) {
    const result = {
      translation: String(row?.translation || ""),
      status: row?.translationStatus || row?.status || "",
      failed: row?.failed === true
    };
    const bid = String(row?.bid || "");
    if (bid) byBid.set(bid, result);
    else if (row?.id) byId.set(String(row.id), result);
  }
  return (blocks || []).map((block) => {
    if (!isTranslatableBlock(block)) return { ...block };
    const keys = [];
    const bid = String(block.bid || "");
    if (bid) keys.push(bid);
    for (const alias of block.bidAliases || []) {
      const key = String(alias || "");
      if (key && !keys.includes(key)) keys.push(key);
    }
    const found = keys.map((key) => byBid.get(key)).filter(Boolean);
    const idHit = block.id ? byId.get(String(block.id)) : null;
    if (idHit) found.push(idHit);
    const result = found.find((item) => translationLandsOn(block, item.translation)) || found[0] || null;
    if (!result) return { ...block };
    if (!result.translation && block.translation && !result.failed) return { ...block };
    const next = {
      ...block,
      translation: result.translation,
      ...(result.status ? { translationStatus: result.status } : {})
    };
    if (result.failed && !result.translation) next.failed = true;
    else delete next.failed;
    return next;
  });
}

/**
 * Keep a pair only when its bid is a block on this multimodal page and the
 * source still matches. A pair whose translation repeats the English source
 * is discarded: an echo is not already translated, and it must not cover the
 * new block or overwrite a later 200.
 */
export function pairsKeptForMultimodal(pairs, blocks) {
  const live = new Map();
  for (const block of blocks || []) {
    const hash = sourceReuseHash(block.sourceText || block.text || "");
    if (!hash) continue;
    const bids = [block?.bid, ...(Array.isArray(block?.bidAliases) ? block.bidAliases : [])];
    for (const bid of bids) {
      const key = String(bid || "");
      if (key && !live.has(key)) live.set(key, hash);
    }
  }
  return (pairs || []).filter((pair) => {
    const bid = String(pair?.bid || "");
    const hash = live.get(bid);
    if (!hash) return false;
    const source = pair?.sourceText || pair?.text || pair?.original || "";
    if (sourceReuseHash(source) !== hash) return false;
    return !sourceEcho(pair?.translation, source);
  });
}

function blockIdentity(layout) {
  return (layout?.blocks || []).map((block) => String(block?.bid || block?.id || "")).join("\n");
}

/**
 * Drop this page's old layout rows and translations that do not name the
 * multimodal blocks about to be painted. Other pages stay. `notes` is returned
 * as the same object: notes anchor to source position and are not part of this.
 * `rebuilding` is cleared so the page can enter the normal queues.
 */
export function commitMultimodalPageData({ pages, layoutRows, page, layout, notes }) {
  const pageNo = Number(page);
  const identity = blockIdentity(layout);
  const nextPages = (pages || []).map((entry) => {
    if (!entry || Number(entry.page) !== pageNo) return entry;
    const pairs = pairsKeptForMultimodal(entry.pairs, layout?.blocks);
    const next = { ...entry, pairs };
    if (next.layout && !isCurrentMmPage(next.layout)) delete next.layout;
    return next;
  });
  const nextRows = (layoutRows || []).filter((row) => {
    if (!row || Number(row.page) !== pageNo) return true;
    const rowLayout = row.layout || row;
    return isCurrentMmPage(rowLayout) && blockIdentity(rowLayout) === identity;
  });
  return {
    pages: nextPages,
    layoutRows: nextRows,
    notes,
    rebuilding: ""
  };
}
