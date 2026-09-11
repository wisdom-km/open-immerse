export const TRANSLATE_LIMIT_ALL = "all";
export const TRANSLATE_LIMIT_PREVIEW = "preview";

const HEADING_RE = /^H[1-6]$/;
const BODY_RE = /^(P|BLOCKQUOTE)$/;

/**
 * Normalize persistable setting.
 * 0 / "all" → unlimited
 * "preview" / 2 → title + first body paragraph (not merely slice(0, 2))
 * other positive integers → max node count
 */
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

/**
 * Cap collected block nodes before batching.
 * `batchSize` only chunks requests; this is the total-node cap.
 */
export function applyTranslateLimit(nodes, limit) {
  const list = Array.isArray(nodes) ? nodes : [];
  const mode = normalizeTranslateLimit(limit);
  if (!list.length || mode === TRANSLATE_LIMIT_ALL) return list;
  if (mode === TRANSLATE_LIMIT_PREVIEW) return pickTitleAndFirstParagraph(list);
  return list.slice(0, mode);
}

export function pickTitleAndFirstParagraph(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const heading = list.find((el) => HEADING_RE.test(el?.tagName || ""));
  const para =
    list.find((el) => el !== heading && BODY_RE.test(el?.tagName || "")) ||
    list.find((el) => el !== heading);
  const picked = [];
  if (heading) picked.push(heading);
  if (para) picked.push(para);
  return picked.length ? picked : list.slice(0, 2);
}
