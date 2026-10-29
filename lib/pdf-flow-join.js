/**
 * Cross-column and cross-page paragraph joins.
 * MinerU para_split: the previous block's last line filled the measure and
 * does not end a sentence, and the next block starts with a lowercase letter
 * or continues a hyphen. The pair becomes one translation unit. The later
 * block stays for its source items and is not sent again.
 */

import { assignBids, stampLayoutBids } from "./pdf-block-id.js";

const SENTENCE_END = /[.!?:;。！？]["”')\]]*$/;
const HYPHEN_END = /[A-Za-z]-$/;
const LOWER_START = /^[a-z(]/;

function proseText(block) {
  return String(block?.text || block?.sourceText || "").trim();
}

function joinable(block) {
  if (!block || block.skipTranslate === true || block.flowHost) return false;
  const label = String(block.label || block.role || "text");
  if (label === "aside" || label === "footnote" || label === "header" || label === "footer") return false;
  if (label === "formula" || label === "figure" || label === "table" || label === "caption") return false;
  if (label === "heading" || label === "title") return false;
  return proseText(block).length > 0;
}

function sideBySide(prev, next) {
  const a = prev?.bbox;
  const b = next?.bbox;
  if (!a || !b || a.length < 4 || b.length < 4) return false;
  const ay = (Number(a[1]) + Number(a[3])) / 2;
  const by = (Number(b[1]) + Number(b[3])) / 2;
  const ax = (Number(a[0]) + Number(a[2])) / 2;
  const bx = (Number(b[0]) + Number(b[2])) / 2;
  return Math.abs(ay - by) < 0.12 && Math.abs(ax - bx) > 0.18;
}

function sameColumn(prev, next) {
  if (!prev?.bbox || !next?.bbox || prev.bbox.length < 4 || next.bbox.length < 4) return true;
  if (sideBySide(prev, next)) return false;
  const prevW = Number(prev.bbox[2]) - Number(prev.bbox[0]);
  const nextW = Number(next.bbox[2]) - Number(next.bbox[0]);
  const overlap = Math.min(Number(prev.bbox[2]), Number(next.bbox[2])) - Math.max(Number(prev.bbox[0]), Number(next.bbox[0]));
  const narrow = Math.min(prevW, nextW);
  const wide = Math.max(prevW, nextW);
  if (!(overlap > 0.02 && overlap >= narrow * 0.4)) return false;
  // A full-width stitch does not continue a single column.
  if (wide > 0.55 && narrow < wide * 0.7) {
    const narrowBox = prevW <= nextW ? prev.bbox : next.bbox;
    const wideBox = prevW > nextW ? prev.bbox : next.bbox;
    const center = (Number(wideBox[0]) + Number(wideBox[2])) / 2;
    if (center < Number(narrowBox[0]) || center > Number(narrowBox[2])) return false;
  }
  return true;
}

function nextColumnTop(prev, next) {
  if (!prev?.bbox || !next?.bbox || prev.bbox.length < 4 || next.bbox.length < 4) return false;
  const hostMid = (Number(prev.bbox[1]) + Number(prev.bbox[3])) / 2;
  const tailMid = (Number(next.bbox[1]) + Number(next.bbox[3])) / 2;
  return tailMid + 0.05 < hostMid;
}

/** True when `next` continues `prev` across a column or a page boundary. */
/** The page's last body block when the sentence continues on the next page. */
export function openPageHost(blocks) {
  const host = [...(blocks || [])].reverse().find((block) => joinable(block));
  if (!host) return null;
  const left = proseText(host);
  if (!left) return null;
  if (HYPHEN_END.test(left) || !SENTENCE_END.test(left)) return host;
  return null;
}

/** The page's last body block still continues on the next page. */
export function pageEndsOpen(blocks) {
  return Boolean(openPageHost(blocks));
}

/**
 * The first body block of a page that can only be the tail of a sentence.
 * Figure, caption, and heading lines before it do not count.
 */
export function pageOpensMidSentence(blocks) {
  const tail = (blocks || []).find((block) => joinable(block));
  if (!tail) return false;
  return continuesBlock({ id: "prior-open", label: "text", text: "continued" }, tail, { acrossPage: true });
}

export function continuesBlock(prev, next, { acrossPage = false } = {}) {
  if (!joinable(prev) || !joinable(next)) return false;
  if (sideBySide(prev, next)) return false;
  const left = proseText(prev);
  const right = proseText(next);
  if (HYPHEN_END.test(left) && /^[a-z]/.test(right)) return true;
  if (SENTENCE_END.test(left)) return false;
  // "where g is a nonlinear function." still continues the formula.
  // A later paragraph ("where the second equality follows. We have proven…")
  // keeps its own bid so a stored translation still lands.
  // A lowercase tail continues the sentence when it is prose.
  // A code statement ("def dpo_loss") keeps the bid it already has.
  const codeTail = /^(?:def|class|return|import|from)\b/.test(right) ||
    (/[=;{}]/.test(right) && !/\b(?:where|the|and|of|is|a)\b/.test(right));
  // A second sentence on the same page keeps its bid. Across a page,
  // "length n is smaller…" still continues "when the sequence".
  const proseTail = /[a-z]{3,}/.test(right) && /\s/.test(right) && !codeTail;
  const anotherSentence = /[.!?]["”')\]]*\s+\S/.test(right);
  const freshClause = /^(?:where|which|when|while)\b/.test(right);
  if (LOWER_START.test(right) && proseTail && (acrossPage || !anotherSentence) && !(anotherSentence && freshClause)) return true;
  return false;
}

export function dehyphenJoin(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (HYPHEN_END.test(a) && /^[a-z]/.test(b)) return `${a.slice(0, -1)}${b}`;
  return `${a} ${b}`.replace(/\s+/g, " ").trim();
}

function formulaToken(block, index) {
  const existing = String(block?.text || "").match(/⟦f\d+⟧/);
  if (existing) return existing[0];
  const id = String(block?.id || "");
  // A synthetic id "f12" is the placeholder. A page id p21-b28 is not a
  // formula number; inventing ⟦f28⟧ makes the sentence fail slot alignment.
  if (/^f\d+$/i.test(id)) return `⟦${id}⟧`;
  if (/^p\d+-b\d+$/.test(id)) return "";
  const digits = id.replace(/\D/g, "");
  return digits ? `⟦f${digits}⟧` : `⟦f${index}⟧`;
}

/** The two halves of one sentence, with each formula kept as a placeholder. */
export function joinAcrossFormulas(left, right, formulas) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  const marks = (formulas || []).map((block, index) => formulaToken(block, index)).filter(Boolean);
  const prose = dehyphenJoin(a, b);
  if (!marks.length) return prose;
  if (HYPHEN_END.test(a) && /^[a-z]/.test(b)) {
    return `${a.slice(0, -1)} ${marks.join(" ")} ${b}`.replace(/\s+/g, " ").trim();
  }
  const head = a.length ? `${a} ` : "";
  return `${head}${marks.join(" ")} ${b}`.replace(/\s+/g, " ").trim();
}

function rememberFormulas(host, formulas) {
  const entries = (formulas || []).map((block, index) => ({
    token: formulaToken(block, index),
    blockId: block.id || ""
  })).filter((entry) => entry.token);
  if (!entries.length) return;
  host.placeholders = [...(host.placeholders || []), ...entries];
}

/**
 * Merge continuations inside one page's block list.
 * `blocks` stays the same length. A joined tail has `flowHost` and `skipTranslate`.
 */
function claimHyphenTail(list, from, host) {
  if (!HYPHEN_END.test(proseText(host))) return false;
  for (let index = from; index < list.length && index < from + 12; index += 1) {
    const block = list[index];
    if (block.flowHost) continue;
    const label = String(block.label || "");
    if (label === "formula" || label === "figure" || label === "aside" || label === "caption" ||
        label === "table" || label === "footnote" || label === "header" || label === "footer") continue;
    if (label === "heading" || label === "title") return false;
    if (!joinable(block)) continue;
    if (sideBySide(host, block) || !/^[a-z]/.test(proseText(block)) || !sameColumn(host, block)) continue;
    rememberBid(host, block);
    const hostText = host.text;
    const hostSource = host.sourceText;
    host.text = dehyphenJoin(hostText, block.text);
    if (hostSource || block.sourceText) host.sourceText = dehyphenJoin(hostSource || hostText, block.sourceText || block.text);
    if (block.placeholders?.length) host.placeholders = [...(host.placeholders || []), ...block.placeholders];
    block.skipTranslate = true;
    block.flowHost = host.id || "";
    block.continues = true;
    return true;
  }
  return false;
}

function rememberBid(host, block) {
  if (!block?.bid || block.bid === host.bid) return;
  const aliases = new Set(host.bidAliases || []);
  aliases.add(block.bid);
  host.bidAliases = [...aliases];
}

function attachTail(host, block, held) {
  rememberBid(host, block);
  const hostText = host.text;
  const hostSource = host.sourceText;
  host.text = joinAcrossFormulas(hostText, block.text, held);
  if (hostSource || block.sourceText) {
    host.sourceText = joinAcrossFormulas(hostSource || hostText, block.sourceText || block.text, held);
  }
  rememberFormulas(host, held);
  if (block.placeholders?.length) host.placeholders = [...(host.placeholders || []), ...block.placeholders];
  block.skipTranslate = true;
  block.flowHost = host.id || "";
  block.continues = true;
}

export function joinFlowBlocks(blocks) {
  const list = (blocks || []).map((block) => ({ ...block }));
  const page = Number(String(list.find((block) => block?.id)?.id || "").match(/^p(\d+)/)?.[1]) || 0;
  if (page) {
    assignBids(page, list).forEach((block, index) => {
      if (block.bid) list[index].bid = block.bid;
    });
  }
  let host = null;
  let held = [];
  const keep = (label) => label === "aside" || label === "caption" || label === "figure" || label === "table" ||
    label === "footnote" || label === "header" || label === "footer";
  for (let index = 0; index < list.length; index += 1) {
    const block = list[index];
    if (block.flowHost) continue;
    const label = String(block.label || "");
    // A figure, its caption, or an in-figure label sits between the halves.
    // A caption that ends mid-word still takes the rest of that word.
    if (keep(label)) {
      if (label === "caption") claimHyphenTail(list, index + 1, block);
      continue;
    }
    // A display formula does not end the sentence. Hold it as a placeholder
    // until the same column continues.
    if (label === "formula") {
      // A formula in the other column is not the sentence's placeholder.
      if (host && !SENTENCE_END.test(proseText(host)) && sameColumn(host, block)) held.push(block);
      else {
        host = null;
        held = [];
      }
      continue;
    }
    if (!joinable(block)) {
      host = null;
      held = [];
      continue;
    }
    const acrossFormula = held.length > 0;
    const columnJump = nextColumnTop(host, block);
    if (host && continuesBlock(host, block) && (!acrossFormula || sameColumn(host, block) || columnJump)) {
      attachTail(host, block, held);
      held = [];
    } else {
      host = block;
      held = [];
      claimHyphenTail(list, index + 1, host);
    }
  }
  return list;
}

/**
 * Join the last body block of one page to the first body block of the next.
 * Returns copies. The previous page's host text grows. The next page's tail
 * is marked `flowHost` so it is not translated again.
 */
export function joinPageBoundary(previous, next) {
  const left = (previous || []).map((block) => ({ ...block }));
  const right = (next || []).map((block) => ({ ...block }));
  // A previous ingest can mark the tail `flowHost` and then the previous page
  // is rebuilt without that sentence. Keeping the mark would drop the line.
  releaseUnhostedTails(left, right);
  const hostAt = left.findLastIndex((block) => joinable(block));
  const tailAt = right.findIndex((block) => joinable(block));
  const host = hostAt >= 0 ? left[hostAt] : null;
  const tail = tailAt >= 0 ? right[tailAt] : null;
  // A second ingest sees the host already holding this sentence. Appending
  // again would paint the tail as its own block after retranslate.
  // The alias alone is not enough: the host text has to contain the line.
  if (host && tail && carriesTail(host, tail)) {
    claimJoinedTail(host, tail);
    return { previous: left, next: right, joined: true };
  }
  if (!host || !tail || !continuesBlock(host, tail, { acrossPage: true })) return { previous: left, next: right, joined: false };
  const between = [
    ...left.slice(hostAt + 1).filter((block) => block.label === "formula"),
    ...right.slice(0, tailAt).filter((block) => block.label === "formula")
  ];
  const hostText = host.text;
  const hostSource = host.sourceText;
  host.text = joinAcrossFormulas(hostText, tail.text, between);
  if (hostSource || tail.sourceText) {
    host.sourceText = joinAcrossFormulas(hostSource || hostText, tail.sourceText || tail.text, between);
  }
  rememberFormulas(host, between);
  claimJoinedTail(host, tail);
  return { previous: left, next: right, joined: true };
}

function carriesTail(host, tail) {
  const tailText = proseText(tail);
  const hostText = proseText(host);
  return tailText.length >= 24 && hostText.includes(tailText);
}

function blockPageNumber(block) {
  return Number(String(block?.id || "").match(/^p(\d+)/)?.[1]) || 0;
}

function flowHostPageNumber(block) {
  return Number(String(block?.flowHost || "").match(/^p(\d+)/)?.[1]) || 0;
}

/** A tail whose host id is on the previous page. Same-page joins stay put. */
function isCrossPageTail(block) {
  const hostPage = flowHostPageNumber(block);
  const page = blockPageNumber(block);
  return Boolean(block?.flowHost && hostPage && page && hostPage !== page);
}

function releaseUnhostedTails(previous, next) {
  const hosts = (previous || []).map((block) => proseText(block)).filter(Boolean);
  for (const block of next || []) {
    if (!isCrossPageTail(block)) continue;
    const tail = proseText(block);
    if (!tail || hosts.some((text) => text.includes(tail))) continue;
    delete block.flowHost;
    if (block.continues === true) delete block.skipTranslate;
    delete block.continues;
  }
}

/**
 * A cached previous page can still be the short block, while the next page
 * already hides the tail. Rejoin only when that merge is safe to paint.
 * A stored translation, formula slot, or URL line stays as cached.
 */
export function restoreCachedContinuation(previous, next, options = {}) {
  const prevBlocks = previous || [];
  const nextBlocks = next || [];
  const stale = nextBlocks.some((block) => {
    if (!isCrossPageTail(block)) return false;
    const tail = proseText(block);
    return Boolean(tail) && !prevBlocks.some((host) => proseText(host).includes(tail));
  });
  if (!stale) return { previous: prevBlocks, next: nextBlocks, restored: false, repaint: false };
  const joined = joinPageBoundary(prevBlocks, nextBlocks);
  const previousPage = Number(options.previousPage) || pageNumberFromBlocks(joined.previous);
  const stamped = previousPage
    ? stampLayoutBids(previousPage, { blocks: joined.previous }).blocks
    : joined.previous;
  const repaint = continuationRepaintSafe({
    before: prevBlocks,
    after: stamped,
    pairs: options.pairs || []
  });
  if (!repaint) return { previous: prevBlocks, next: nextBlocks, restored: false, repaint: false };
  const nextPage = Number(options.nextPage) || pageNumberFromBlocks(joined.next);
  const stampedNext = nextPage
    ? stampLayoutBids(nextPage, { blocks: joined.next }).blocks
    : joined.next;
  return { previous: stamped, next: stampedNext, restored: true, repaint: true };
}

function pageNumberFromBlocks(blocks) {
  const id = String((blocks || []).find((block) => block?.id)?.id || "");
  return Number(id.match(/^p(\d+)/)?.[1]) || 0;
}

/**
 * Repaint the previous page only when the merged sentence is new there.
 * A block that keeps its bid and already has a stored translation for the
 * pre-merge text must stay as painted: rewriting it marks the translation
 * source-uncertain and the reader shows the placeholder.
 */
export function continuationRepaintSafe({ before, after, pairs } = {}) {
  let grew = false;
  for (const block of after || []) {
    const prior = (before || []).find((item) => item && block && item.id === block.id);
    if (!prior || String(prior.text || "") === String(block.text || "")) continue;
    grew = true;
    const combined = `${prior.text || ""}${block.text || ""}`;
    // Formula slots are aligned to the stored translation. A longer source
    // rewrites those tokens into the sentence and the reader shows the wrong text.
    // A URL line is not the prose host; repainting it drops the bid the translation used.
    if (/⟦f\d+⟧/.test(combined) || /https?:\/\//i.test(combined)) return false;
    if (!prior.bid || String(prior.bid) !== String(block.bid || "")) continue;
    // The bid still names the stored block. Repainting the longer source
    // makes that translation source-uncertain, so the old paint stays.
    const pair = (pairs || []).find((item) => String(item?.bid || "") === String(block.bid) && String(item?.translation || "").trim());
    if (pair) return false;
  }
  return grew;
}

/**
 * A cross-page host keeps both stored translations. The tail is not painted,
 * so its Chinese has to ride on the host or the line disappears.
 * Pieces are the saved pairs named by `bidAliases` whose source is inside the
 * host and shorter than the host. A translation that is already something
 * else (a fresh full-sentence translation) is left alone.
 */
export function applyContinuationTranslations(blocks, ...pairLists) {
  const pairs = pairLists.flat().filter((pair) => pair && typeof pair === "object");
  if (!pairs.length) return blocks || [];
  return (blocks || []).map((block) => composeContinuationBlock(block, pairs));
}

function composeContinuationBlock(block, pairs) {
  const aliases = (block?.bidAliases || []).map(String).filter(Boolean);
  if (block?.bid) aliases.push(String(block.bid));
  if (!aliases.length) return block;
  const hostText = proseText(block);
  if (hostText.length < 24) return block;
  const pieces = [];
  const seen = new Set();
  for (const pair of pairs) {
    const bid = String(pair?.bid || "");
    if (!aliases.includes(bid) || seen.has(bid)) continue;
    const piece = String(pair.text || pair.sourceText || pair.original || "").replace(/\s+/g, " ").trim();
    if (piece.length < 24 || piece === hostText || !hostText.includes(piece)) continue;
    seen.add(bid);
    pieces.push({
      bid,
      piece,
      translation: String(pair.translation || "").trim(),
      at: hostText.indexOf(piece)
    });
  }
  pieces.sort((a, b) => a.at - b.at || b.piece.length - a.piece.length);
  const kept = [];
  for (const piece of pieces) {
    if (kept.some((item) => item.at === piece.at || item.piece.includes(piece.piece))) continue;
    kept.push(piece);
  }
  if (kept.length < 2 || kept.some((item) => !item.translation)) return block;
  // This bid already owns the first stored translation. Appending the next
  // page's translation onto it is a different sentence, not this block's reuse.
  if (kept[0].bid && kept[0].bid === String(block.bid || "")) return block;
  const composed = kept.map((item) => item.translation).join("");
  const current = String(block.translation || "").trim();
  if (!composed || current === composed || kept.every((item) => current.includes(item.translation))) return block;
  if (current && current !== kept[0].translation) return block;
  return {
    ...block,
    translation: composed,
    translationStatus: block.translationStatus && block.translationStatus !== "source-uncertain"
      ? block.translationStatus
      : "reused"
  };
}

function claimJoinedTail(host, tail) {
  rememberBid(host, tail);
  tail.skipTranslate = true;
  tail.flowHost = host.id || "";
  tail.continues = true;
}

/** The continuation is already inside the previous block. Do not paint it again. */
export function visibleFlowBlocks(blocks) {
  return (blocks || []).filter((block) => block && !block.flowHost);
}

/** Body blocks only, in order, after joins. Asides and footnotes stay out of this sequence. */
export function bodyFlow(blocks) {
  return (blocks || []).filter((block) => {
    if (block?.flowHost) return false;
    const label = String(block?.label || "");
    if (label === "aside" || label === "footnote" || label === "header" || label === "footer") return false;
    if (label === "formula" || label === "figure" || label === "table" || label === "caption") return false;
    return proseText(block).length > 0;
  });
}
