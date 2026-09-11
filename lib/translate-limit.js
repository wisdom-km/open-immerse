export const TRANSLATE_LIMIT_ALL = "all";
export const TRANSLATE_LIMIT_PREVIEW = "preview";

const HEADING_RE = /^H[1-6]$/;
const BODY_RE = /^(P|BLOCKQUOTE|LI|DIV)$/;
const SHORT_LEAD = 220;

export function normalizeTranslateLimit(value) {
  if (value === TRANSLATE_LIMIT_PREVIEW || value === 2 || value === "2") {
    return TRANSLATE_LIMIT_PREVIEW;
  }
  if (
    value == null ||
    value === "" ||
    value === TRANSLATE_LIMIT_ALL ||
    value === 0 ||
    value === "0"
  ) {
    return TRANSLATE_LIMIT_ALL;
  }
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return TRANSLATE_LIMIT_ALL;
}

export function applyTranslateLimit(nodes, limit) {
  const list = Array.isArray(nodes) ? nodes : [];
  const mode = normalizeTranslateLimit(limit);
  if (!list.length || mode === TRANSLATE_LIMIT_ALL) return list;
  if (mode === TRANSLATE_LIMIT_PREVIEW) return pickTitleAndLead(list);
  return list.slice(0, mode);
}

/** Title + short lead lines (byline / first sentence block), not the whole article. */
export function pickTitleAndLead(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const heading = list.find((el) => HEADING_RE.test(el?.tagName || ""));
  const rest = list.filter((el) => el !== heading);
  const short = rest.filter((el) => {
    const t = String(el?.textContent || "").replace(/\s+/g, " ").trim();
    return t.length > 0 && t.length <= SHORT_LEAD;
  });
  const picked = [];
  if (heading) picked.push(heading);
  for (const el of short.slice(0, 2)) picked.push(el);
  if (picked.length <= 1) {
    const para =
      rest.find((el) => BODY_RE.test(el?.tagName || "")) || rest[0];
    if (para) picked.push(para);
  }
  return picked.length ? picked : list.slice(0, 2);
}

/** For preview API payloads: only first sentence of a long block. */
export function previewSourceText(text, limit) {
  const mode = normalizeTranslateLimit(limit);
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (mode !== TRANSLATE_LIMIT_PREVIEW || t.length <= SHORT_LEAD) return t;
  const m = t.match(/^[\s\S]{1,180}?[.!?。！？]/);
  return (m ? m[0] : t.slice(0, 160)).trim();
}

export const pickTitleAndFirstParagraph = pickTitleAndLead;
