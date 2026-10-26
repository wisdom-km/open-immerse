/**
 * Journal running furniture and decorative text-layer strings.
 * Position is required for anything that could also be a body line.
 * Decorative rules (a11111…, dot leaders) are dropped anywhere.
 *
 * This is the text-layer fallback. Appendix R may later bypass the
 * text layer for complex layouts; it does not live in this module.
 */

import { isDecorativeText } from "./pdf-glyph-sanitize.js";

const SECTION_HEADING = /^(?:abstract|introduction|background|results|discussion|conclusions?|references|bibliography|acknowledgements?|related work|appendix|materials and methods|methods)$/i;

const ARTICLE_TYPE = /^(?:method|methods|original article|research article|review article|brief communication|short communication|systematic review|meta-analysis|case report|perspective|commentary|editorial|letter)$/i;

const JOURNAL_BANNER = /^(?:plos(?:\s+[a-z]+)?|nature(?:\s+[a-z]+)?|science|the lancet|cell|physical review(?:\s+[a-z]+)?|bmj(?:\s+open)?|frontiers in [a-z][\w\s]{0,40}|scientific reports|rsc advances)$/i;

const DOI_LINE = /^(?:doi\s*[:：]\s*)?(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/\S+$/i;
const ISSN_LINE = /^(?:e-?issn|issn|isbn)\b[:\s-]*[\dXx-]{8,}$/i;
const VOLUME_LINE = /^(?:vol(?:ume)?\.?\s*\d[\w.\s–-]{0,40}|no\.?\s*\d+|issue\s+\d[\w.\s–-]{0,24}|pp?\.\s*\d+(?:\s*[–-]\s*\d+)?)$/i;
const COPYRIGHT_LINE = /^(?:©|\(c\)|copyright)\b/i;
const OPEN_ACCESS_LINE = /^open\s+access$/i;

export function normalizeChromeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function isOpenAccessLine(text) {
  return OPEN_ACCESS_LINE.test(normalizeChromeText(text));
}

export function isDoiOnlyLine(text) {
  return DOI_LINE.test(normalizeChromeText(text));
}

export function isIssnOnlyLine(text) {
  return ISSN_LINE.test(normalizeChromeText(text));
}

/** Whole-item metadata. Callers still apply a position gate for banners and article types. */
export function isSectionHeadingLine(text) {
  return SECTION_HEADING.test(normalizeChromeText(text));
}

export function isMetadataLine(text) {
  const t = normalizeChromeText(text);
  if (!t || t.length > 160) return false;
  if (isOpenAccessLine(t) || isDoiOnlyLine(t) || isIssnOnlyLine(t)) return true;
  if (ARTICLE_TYPE.test(t) || JOURNAL_BANNER.test(t)) return true;
  if (VOLUME_LINE.test(t) && t.length < 80) return true;
  if (COPYRIGHT_LINE.test(t) && t.length < 120) return true;
  return false;
}

function isEdgeLabel(text) {
  const t = normalizeChromeText(text);
  return ARTICLE_TYPE.test(t) || JOURNAL_BANNER.test(t);
}

function isRunningHeader(text, itemHeight) {
  const t = normalizeChromeText(text);
  if (!t || t.length < 6 || t.length > 90) return false;
  if (itemHeight >= 11) return false;
  if (SECTION_HEADING.test(t)) return false;
  if (/[.!?]\s+\S/.test(t)) return false;
  if (/\b(?:19|20)\d{2}\b/.test(t)) return true;
  if (/\bet al\.?\b/i.test(t)) return true;
  if (/\|/.test(t)) return true;
  return false;
}

function isOrcidIcon(text, fontName, band) {
  if (!/^ID$/i.test(normalizeChromeText(text))) return false;
  if (/orcid|wingding|zapfding|icon/i.test(fontName || "")) return true;
  return Boolean(band.margin) && band.itemHeight > 0 && band.itemHeight <= 9;
}

function decideChrome({ text, header, footer, margin, itemHeight, fontName }) {
  const t = normalizeChromeText(text);
  if (!t) return false;
  if (isDecorativeText(t)) return true;
  if (SECTION_HEADING.test(t) && itemHeight >= 11) return false;
  if (isOrcidIcon(t, fontName, { margin, itemHeight })) return true;
  if (!header && !footer && !margin) return false;
  if (header && isRunningHeader(t, itemHeight)) return true;
  if (!isMetadataLine(t)) return false;
  if (isEdgeLabel(t)) return Boolean(header || margin);
  return true;
}

function bandsOf(item, page) {
  const h = Number(page?.height) || 0;
  const w = Number(page?.width) || 0;
  const y = Number(item?.y);
  const height = Number(item?.height) || 0;
  const x = Number(item?.x);
  if (!(h > 0) || !Number.isFinite(y)) {
    return { known: false, header: false, footer: false, margin: false, itemHeight: height };
  }
  const fromTop = h - y - height;
  const header = fromTop >= -2 && fromTop < h * 0.08;
  const footer = y < h * 0.08;
  let margin = false;
  if (w > 0 && Number.isFinite(x)) {
    const width = Number(item?.width) || 0;
    margin = x < w * 0.18 || (x > w * 0.82 && width < w * 0.28);
  }
  return { known: true, header, footer, margin, itemHeight: height };
}

export function isJournalChromeItem(item, page = {}) {
  const text = String(item?.str || item?.text || "");
  if (isDecorativeText(text)) return true;
  const band = bandsOf(item, page);
  if (!band.known) return false;
  const fontName = `${item?.fontRealName || ""} ${item?.fontName || ""}`;
  return decideChrome({ text, fontName, ...band });
}

/**
 * Normalized top-left bbox (0–1), the shape relabelText already has.
 * A tall section heading in the top band stays a heading.
 */
export function isJournalChromeBlock(text, bbox) {
  const t = normalizeChromeText(text);
  if (!t) return false;
  if (isDecorativeText(t)) return true;
  if (!Array.isArray(bbox) || bbox.length < 4) return false;
  const [x0, y0, x1, y1] = bbox.map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return false;
  const height = Math.max(0, y1 - y0);
  const width = Math.max(0, x1 - x0);
  const header = y0 < 0.08;
  const footer = y1 > 0.92;
  const margin = width < 0.22 && (x0 < 0.12 || x1 > 0.88);
  return decideChrome({
    text: t,
    header,
    footer,
    margin,
    itemHeight: height * 792,
    fontName: ""
  });
}
