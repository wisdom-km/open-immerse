/**
 * Stable block ids (bid). Content and page, not render order.
 * Scheme b1 is locked: assignBids / bidSeed / bidText / fnv36.
 * Cross-page grouping production is PR-2b-2; this file only names the id.
 */

export const BID_VERSION = 1;

/** OCR blocks get a bid and a pair. Set false to keep pairId "" while bids stay. */
export let ocrBlockPairing = true;

export function setOcrBlockPairing(enabled) {
  ocrBlockPairing = enabled !== false;
}

const VISUAL = { formula: "m", figure: "g", table: "g" };
const cls = (b) => VISUAL[b?.label] || "t";

function normalizedBidText(s) {
  return String(s || "").normalize("NFKC").replace(/⟦f\d+⟧/g, " ").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function bidText(s) {
  return normalizedBidText(s).slice(0, 200);
}

/** Notes srcHead: first 64 characters of bidText. */
export function blockSrcHead(s) {
  return bidText(s).slice(0, 64);
}

/** Notes srcHash: FNV of the full normalized source, not the 200-char seed. */
export function blockSrcHash(s) {
  return fnv36(normalizedBidText(s));
}

const q = (v) => Math.round(Number(v) * 200);

function layoutBbox(block) {
  const saved = block?.layoutBbox;
  if (Array.isArray(saved) && saved.length >= 4) return saved;
  return block?.bbox;
}

export function bidSeed(b) {
  const c = cls(b);
  const text = c === "t" ? bidText(b.sourceText || b.text) : "";
  if (text) return `t|${text}`;
  const source = layoutBbox(b);
  const box = Array.isArray(source) && source.length >= 4 ? source.slice(0, 4).map(q).join(",") : "";
  return box ? `${c}|${box}` : "";
}

function fnv36(s) {
  let h = 2166136261;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    h = Math.imul(h ^ (c & 0xffff), 16777619) >>> 0;
    if (c > 0xffff) h = Math.imul(h ^ (c >>> 16), 16777619) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

/**
 * Collision `-n` follows reading order, not whatever order the array happens
 * to be in. Reading order is top then left. Callers must still pass reading
 * order: the result keeps that order, and a block with no bbox is numbered by
 * its place in the array.
 */
function readingRank(block, index) {
  const box = layoutBbox(block);
  const y = Array.isArray(box) && box.length >= 4 ? Number(box[1]) : Number.NaN;
  const x = Array.isArray(box) && box.length >= 4 ? Number(box[0]) : Number.NaN;
  return {
    y: Number.isFinite(y) ? y : Number.POSITIVE_INFINITY,
    x: Number.isFinite(x) ? x : Number.POSITIVE_INFINITY,
    index
  };
}

export function assignBids(page, blocks) {
  const list = blocks || [];
  const ranked = list.map((block, index) => ({ block, index, ...readingRank(block, index) }));
  ranked.sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index);
  const seen = new Map();
  const bids = new Array(list.length);
  for (const item of ranked) {
    const seed = bidSeed(item.block);
    if (!seed) continue;
    const base = `b${BID_VERSION}-p${page}-${seed[0]}${fnv36(seed)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    bids[item.index] = n === 1 ? base : `${base}-${n}`;
  }
  return list.map((block, index) => (
    bids[index] ? { ...block, bid: bids[index] } : { ...block }
  ));
}

const BID_RE = /^b1-p[1-9]\d*-[tmg][0-9a-z]{7}(-[2-9]|-[1-9]\d+)?$/;

export function isBid(value) {
  return BID_RE.test(String(value || ""));
}

function aliasList(prior, nextBid) {
  const aliases = [];
  const seen = new Set();
  const push = (value) => {
    const id = value == null ? "" : String(value);
    if (!id || id === nextBid || seen.has(id)) return;
    seen.add(id);
    aliases.push(id);
  };
  if (Array.isArray(prior?.bidAliases)) {
    for (const item of prior.bidAliases) push(item);
  }
  push(prior?.bid);
  return aliases;
}

/**
 * Recompute bids for one page layout. A stored bid that differs is kept as an alias.
 * The live bid is always the recomputed one. Does not rewrite block.id.
 */
export function stampLayoutBids(page, layout) {
  if (!layout || typeof layout !== "object") return layout;
  layout.bidVersion = BID_VERSION;
  if (!Array.isArray(layout.blocks)) return layout;
  const prior = layout.blocks;
  const assigned = assignBids(page, prior);
  layout.blocks = assigned.map((block, index) => {
    if (!block?.bid) return block;
    const aliases = aliasList(prior[index], block.bid);
    if (!aliases.length) {
      if (!block.bidAliases) return block;
      const next = { ...block };
      delete next.bidAliases;
      return next;
    }
    return { ...block, bidAliases: aliases };
  });
  return layout;
}

function pageNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0;
}

function asPages(pagesBlocks) {
  const pages = [];
  if (Array.isArray(pagesBlocks)) {
    for (const entry of pagesBlocks) {
      if (Array.isArray(entry)) {
        pages.push({ page: 0, blocks: entry });
        continue;
      }
      if (entry && Array.isArray(entry.blocks)) {
        pages.push({ page: pageNumber(entry.page), blocks: entry.blocks });
        continue;
      }
      if (entry && (entry.bid || entry.id || entry.sourceId)) {
        pages.push({ page: pageNumber(entry.page), blocks: [entry] });
      }
    }
    return pages;
  }
  if (pagesBlocks && typeof pagesBlocks === "object") {
    for (const [key, blocks] of Object.entries(pagesBlocks)) {
      if (Array.isArray(blocks)) pages.push({ page: pageNumber(key), blocks });
    }
  }
  return pages;
}

function blockPage(block, fallback) {
  return pageNumber(block?.page) || fallback || 0;
}

function walk(pages, visit) {
  for (const entry of pages) {
    for (const block of entry.blocks || []) {
      if (!block || typeof block !== "object") continue;
      const found = visit(block, blockPage(block, entry.page));
      if (found) return found;
    }
  }
  return null;
}

function hit(block, page) {
  const bid = block?.bid ? String(block.bid) : "";
  return { block, bid, page: page || pageNumber(block?.page) };
}

function parseLegacyPair(value) {
  const match = /^p([1-9]\d*):(.+)$/.exec(String(value || ""));
  if (!match) return null;
  return { page: Number(match[1]), id: match[2] };
}

function textBlock(block) {
  return cls(block) === "t";
}

function pageOrder(anchorPage) {
  const page = pageNumber(anchorPage);
  if (!page) return [];
  return [page, page - 1, page + 1].filter((n, index, list) => n >= 1 && list.indexOf(n) === index);
}

function blocksOnPages(pages, wanted) {
  const want = new Set(wanted);
  const out = [];
  for (const entry of pages) {
    for (const block of entry.blocks || []) {
      if (!block) continue;
      const page = blockPage(block, entry.page);
      if (!want.has(page) || !textBlock(block)) continue;
      out.push({ block, page });
    }
  }
  const rank = new Map(wanted.map((page, index) => [page, index]));
  out.sort((a, b) => (rank.get(a.page) ?? 9) - (rank.get(b.page) ?? 9));
  return out;
}

function textQuoteHit(translation, anchor) {
  const text = String(translation || "");
  const quote = String(anchor?.quote || "");
  if (!quote || !text.includes(quote)) return false;
  const prefix = anchor?.prefix == null ? "" : String(anchor.prefix);
  const suffix = anchor?.suffix == null ? "" : String(anchor.suffix);
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(quote, from);
    if (at < 0) return false;
    const beforeOk = !prefix || text.slice(Math.max(0, at - prefix.length), at) === prefix;
    const afterStart = at + quote.length;
    const afterOk = !suffix || text.slice(afterStart, afterStart + suffix.length) === suffix;
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
  return false;
}

/**
 * Find a note anchor: bid, alias, source head, TextQuote, then lost.
 * pagesBlocks is [{ page, blocks }] in reading order.
 */
export function resolveBlockAnchor(anchor, pagesBlocks) {
  const pages = asPages(pagesBlocks);
  const wanted = String(anchor?.bid || "");
  const hinted = pageNumber(anchor?.page);

  if (wanted) {
    const exact = walk(pages, (block, page) => {
      if (block.bid && String(block.bid) === wanted) return hit(block, page);
      const members = Array.isArray(block.memberBids) ? block.memberBids.map(String) : [];
      if (members.includes(wanted) && block.bid) return hit(block, page);
      return null;
    });
    if (exact?.bid) return { status: "exact", bid: exact.bid, page: exact.page || hinted };
  }

  const legacy = anchor?.legacy || {};
  const pair = parseLegacyPair(legacy.pairId);
  const aliasPasses = [
    (block) => wanted && Array.isArray(block.bidAliases) && block.bidAliases.map(String).includes(wanted),
    (block) => legacy.sourceId && block.sourceId && String(block.sourceId) === String(legacy.sourceId),
    (block) => legacy.id && block.id && String(block.id) === String(legacy.id),
    (block, page) => pair && block.id && String(block.id) === pair.id && page === pair.page
  ];
  for (const pass of aliasPasses) {
    const alias = walk(pages, (block, page) => (pass(block, page) && block.bid ? hit(block, page) : null));
    if (alias?.bid) return { status: "alias", bid: alias.bid, page: alias.page || hinted };
  }

  const head = String(anchor?.srcHead || "");
  const nearby = blocksOnPages(pages, pageOrder(hinted));
  if (head) {
    const text = nearby.find((item) => item.block?.bid && bidText(item.block.sourceText || item.block.text).startsWith(head));
    if (text) return { status: "text", bid: String(text.block.bid), page: text.page };
  }

  if (anchor?.quote) {
    const quoted = nearby.find((item) => item.block?.bid && textQuoteHit(item.block.translation, anchor));
    if (quoted) return { status: "quote", bid: String(quoted.block.bid), page: quoted.page };
  }

  const lost = { status: "lost" };
  if (Number.isFinite(Number(anchor?.page))) lost.page = Number(anchor.page);
  return lost;
}
