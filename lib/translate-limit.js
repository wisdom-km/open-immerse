export const TRANSLATE_LIMIT_ALL = "all";
/** Title (h1) + first body block. Aliases: preview / lead / 2 */
export const TRANSLATE_LIMIT_TITLE_LEAD = "title_lead";
export const TRANSLATE_LIMIT_PREVIEW = TRANSLATE_LIMIT_TITLE_LEAD;

const HEADING_RE = /^H[1-6]$/;
const BODY_RE = /^(P|BLOCKQUOTE)$/;
/** Cap a long first paragraph so preview still stays cheap */
export const PREVIEW_MAX_LINES = 3;
export const PREVIEW_MAX_CHARS = 220;

const TITLE_LEAD_ALIASES = new Set(["title_lead", "preview", "lead", 2, "2"]);

export function isTitleLeadLimit(value) {
  return TITLE_LEAD_ALIASES.has(value);
}

export function normalizeTranslateLimit(value) {
  if (isTitleLeadLimit(value)) {
    return TRANSLATE_LIMIT_TITLE_LEAD;
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

/** Exactly: one heading + at most one body block (never more nodes). */
export function pickTitleAndLead(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const heading =
    list.find((el) => (el?.tagName || "") === "H1") ||
    list.find((el) => HEADING_RE.test(el?.tagName || ""));
  const rest = list.filter((el) => el !== heading);
  const para =
    rest.find((el) => BODY_RE.test(el?.tagName || "")) ||
    rest.find((el) => String(el?.textContent || "").trim().length > 0);
  const picked = [];
  if (heading) picked.push(heading);
  if (para) picked.push(para);
  return picked.length ? picked : list.slice(0, 1);
}

/** Keep at most first N visual lines / char budget for preview API text. */
export function previewSourceText(text, limit) {
  const mode = normalizeTranslateLimit(limit);
  const raw = String(text || "").replace(/\r/g, "");
  if (mode !== TRANSLATE_LIMIT_PREVIEW) return raw.replace(/\s+/g, " ").trim();
  const lines = raw
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let out = lines.slice(0, PREVIEW_MAX_LINES).join(" ");
  if (!out) out = raw.replace(/\s+/g, " ").trim();
  if (out.length > PREVIEW_MAX_CHARS) {
    const cut = out.slice(0, PREVIEW_MAX_CHARS);
    const m = cut.match(/^[\s\S]*?[.!?。！？]/);
    out = (m ? m[0] : cut).trim();
  }
  return out;
}

export const pickTitleAndFirstParagraph = pickTitleAndLead;
