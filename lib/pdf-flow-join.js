/**
 * Cross-column and cross-page paragraph joins.
 * MinerU para_split: the previous block's last line filled the measure and
 * does not end a sentence, and the next block starts with a lowercase letter
 * or continues a hyphen. The pair becomes one translation unit. The later
 * block stays for its source items and is not sent again.
 */

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

/** True when `next` continues `prev` across a column or a page boundary. */
export function continuesBlock(prev, next) {
  if (!joinable(prev) || !joinable(next)) return false;
  if (sideBySide(prev, next)) return false;
  const left = proseText(prev);
  const right = proseText(next);
  if (HYPHEN_END.test(left) && /^[a-z]/.test(right)) return true;
  if (SENTENCE_END.test(left)) return false;
  if (LOWER_START.test(right)) return true;
  return false;
}

export function dehyphenJoin(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (HYPHEN_END.test(a) && /^[a-z]/.test(b)) return `${a.slice(0, -1)}${b}`;
  return `${a} ${b}`.replace(/\s+/g, " ").trim();
}

/**
 * Merge continuations inside one page's block list.
 * `blocks` stays the same length. A joined tail has `flowHost` and `skipTranslate`.
 */
export function joinFlowBlocks(blocks) {
  const list = (blocks || []).map((block) => ({ ...block }));
  let host = null;
  for (const block of list) {
    const label = String(block.label || "");
    if (label === "formula" || label === "figure" || label === "table") {
      host = null;
      continue;
    }
    if (!joinable(block)) {
      host = null;
      continue;
    }
    if (host && continuesBlock(host, block)) {
      host.text = dehyphenJoin(host.text, block.text);
      if (host.sourceText || block.sourceText) {
        host.sourceText = dehyphenJoin(host.sourceText || host.text, block.sourceText || block.text);
      }
      block.skipTranslate = true;
      block.flowHost = host.id || "";
      block.continues = true;
    } else {
      host = block;
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
  const host = [...left].reverse().find((block) => joinable(block));
  const tail = right.find((block) => joinable(block));
  if (!host || !tail || !continuesBlock(host, tail)) return { previous: left, next: right, joined: false };
  host.text = dehyphenJoin(host.text, tail.text);
  if (host.sourceText || tail.sourceText) {
    host.sourceText = dehyphenJoin(host.sourceText || host.text, tail.sourceText || tail.text);
  }
  tail.skipTranslate = true;
  tail.flowHost = host.id || "";
  tail.continues = true;
  return { previous: left, next: right, joined: true };
}

/** Body blocks only, in order, after joins. Asides and footnotes stay out of this sequence. */
export function bodyFlow(blocks) {
  return (blocks || []).filter((block) => {
    if (block?.flowHost) return false;
    const label = String(block?.label || "");
    if (label === "aside" || label === "footnote" || label === "header" || label === "footer") return false;
    if (label === "formula" || label === "figure" || label === "table") return false;
    return proseText(block).length > 0;
  });
}
