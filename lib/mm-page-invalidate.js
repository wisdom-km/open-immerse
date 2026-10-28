import { sourceReuseHash } from "./pdf-library.js";
import { isCurrentMmPage } from "./mm-page.js";

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

/** Keep a pair only when its bid is a block on this multimodal page and the source still matches. */
export function pairsKeptForMultimodal(pairs, blocks) {
  const live = new Map();
  for (const block of blocks || []) {
    const bid = String(block?.bid || "");
    if (!bid) continue;
    const hash = sourceReuseHash(block.sourceText || block.text || "");
    if (hash) live.set(bid, hash);
  }
  return (pairs || []).filter((pair) => {
    const bid = String(pair?.bid || "");
    const hash = live.get(bid);
    if (!hash) return false;
    return sourceReuseHash(pair?.sourceText || pair?.text || pair?.original || "") === hash;
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
