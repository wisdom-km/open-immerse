/**
 * Reader drawer table of contents.
 * Outline entries keep the PDF tree depth. Numbers come from a matched
 * heading's prefix, then a standalone same-line text-layer number, then a
 * prefix on the outline title.
 */

export const DRAWER_WIDTH = 288;
export const DRAWER_DOCK_MIN = 618;
export const DRAWER_DOCK_HYSTERESIS = 24;
export const DRAWER_NARROW = 900;

const DECIMAL_PREFIX = /^(\d+(?:\.\d+)*)(?![\p{L}])/u;
const APPENDIX_NUMBERED = /^([A-Z](?:\.\d+)+)(?![\p{L}])/u;

export function normalizeTocText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function prefixBoundary(text, length) {
  if (length >= text.length) return true;
  return /[\s.、:：]/.test(text.charAt(length));
}

/**
 * A decimal number has to end on a boundary, and the next character cannot be
 * a letter (`2D`, `3D`). A single appendix letter counts only when `.` / `:` /
 * `、` introduces a title, so `A Simple` and `E. coli` stay words.
 */
export function titleNumber(title) {
  const text = String(title || "").trim();
  const decimal = text.match(DECIMAL_PREFIX);
  if (decimal && prefixBoundary(text, decimal[1].length)) return decimal[1];
  const numbered = text.match(APPENDIX_NUMBERED);
  if (numbered && prefixBoundary(text, numbered[1].length)) return numbered[1];
  const single = text.match(/^([A-Z])[.、:：]\s*(\S.*)$/);
  if (single && /^[\p{Lu}\u4e00-\u9fff]/u.test(single[2])) return single[1];
  return "";
}

export function stripNumber(title) {
  const text = String(title || "").trim();
  const num = titleNumber(text);
  if (!num) return text;
  const at = text.indexOf(num);
  if (at < 0) return text;
  return text.slice(at + num.length).replace(/^[\s.、:：]+/, "").trim();
}

export function tocKey(value) {
  return normalizeTocText(stripNumber(value));
}

/** Heading-block level. `3.2.1` is 3, `3.2` is 2, a bare number is 1. */
export function headingLevel(num) {
  const text = String(num || "");
  if (/^\d+(?:\.\d+){2,}$/.test(text)) return 3;
  if (/^\d+\.\d+$/.test(text)) return 2;
  if (/^\d+$/.test(text)) return 1;
  if (/^[A-Z](?:\.\d+)*$/.test(text)) return Math.min(3, text.split(".").length);
  return 1;
}

export function flattenOutline(outline, level = 1) {
  const entries = [];
  for (const item of outline || []) {
    const title = String(item?.title || "").trim();
    if (title) {
      entries.push({
        level: Math.min(3, Math.max(1, level)),
        title,
        original: title,
        dest: item?.dest ?? null,
        page: Number(item?.page) || 0,
        num: String(item?.num || ""),
        translated: false
      });
    }
    if (item?.items?.length) entries.push(...flattenOutline(item.items, level + 1));
  }
  return entries;
}

export function headingsToToc(layouts) {
  const entries = [];
  for (const layout of layouts || []) {
    const page = Number(layout?.page ?? layout?.pageNumber) || 0;
    for (const block of layout?.blocks || []) {
      if (!block || (block.label !== "heading" && block.type !== "heading")) continue;
      const raw = String(block.text || block.sourceText || "").trim();
      if (!raw) continue;
      const num = titleNumber(raw);
      const translation = String(block.translation || "").trim();
      const translated = Boolean(translation) && normalizeTocText(translation) !== normalizeTocText(raw);
      const box = block.bbox || block.box;
      const topFraction = Array.isArray(box) ? Number(box[1]) : NaN;
      entries.push({
        level: num ? Math.min(3, headingLevel(num)) : 1,
        num,
        title: translated ? translation : (num ? stripNumber(raw) || raw : raw),
        original: raw,
        translated,
        page,
        ...(Number.isFinite(topFraction) ? { topFraction } : {})
      });
    }
  }
  return entries;
}

function matchHeading(entry, headings) {
  const want = normalizeTocText(stripNumber(entry?.original || entry?.title || ""));
  if (!want) return null;
  const page = Number(entry?.page) || 0;
  const pool = (headings || []).filter((heading) => !page || Number(heading?.page) === page);
  return pool.find((heading) => normalizeTocText(stripNumber(heading?.text || "")) === want) || null;
}

export function applyHeadingMatch(entries, headings) {
  return (entries || []).map((entry) => {
    const heading = matchHeading(entry, headings);
    const fromHeading = heading ? titleNumber(heading.text) : "";
    const fromTitle = titleNumber(entry?.original || entry?.title || "");
    // Tier 2 only after a heading is matched: Q4 matched a layout heading,
    // or the text layer already matched this title on that line. A bare
    // `num` with neither match stays empty, so it cannot outrank a title.
    const lineAllowed = Boolean(heading) || entry?.lineMatched === true;
    const fromLine = lineAllowed ? standaloneSectionNumber(entry?.lineNum || entry?.num || "") : "";
    const num = fromHeading || fromLine || fromTitle || "";
    const translation = String(heading?.translation || "").trim();
    const translated = Boolean(heading) && Boolean(translation)
      && normalizeTocText(translation) !== normalizeTocText(heading.text);
    const original = entry?.original || entry?.title || "";
    return {
      ...entry,
      num,
      title: translated ? translation : (entry?.title || original),
      original,
      translated
    };
  });
}

const SECTION_TOKEN = /^\d+(?:\.\d+)*\.?$/;
const APPENDIX_TOKEN = /^[A-Z](?:\.\d+)*$/;
const ROMAN_TOKEN = /^(?:M{0,4})(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

/** A section token. Equation marks, page numbers, and Roman numerals are not. */
export function standaloneSectionNumber(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.startsWith("(")) return "";
  if (SECTION_TOKEN.test(raw)) return raw.replace(/\.$/, "");
  // A roman numeral is the whole token (`I`, `IV`), not an appendix like `C.1`.
  if (APPENDIX_TOKEN.test(raw) && !ROMAN_TOKEN.test(raw)) return raw;
  return "";
}

function itemBox(item) {
  const x = Number(item?.x ?? item?.transform?.[4]);
  const y = Number(item?.y ?? item?.transform?.[5]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const height = Number(item?.height);
  const width = Number(item?.width);
  const h = Number.isFinite(height) && height > 0 ? height : Math.abs(Number(item?.transform?.[3])) || 0;
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const str = String(item?.str ?? item?.text ?? "").trim();
  if (!str || !(h > 0)) return null;
  return { str, x, y, w, h, top: y + h, bottom: y };
}

function verticalOverlap(a, b) {
  const overlap = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
  const denom = Math.min(a.h, b.h);
  if (!(overlap > 0) || !(denom > 0)) return 0;
  return overlap / denom;
}

function clusterLines(boxes) {
  const lines = [];
  for (const box of boxes) {
    const line = lines.find((row) => verticalOverlap(box, row) >= 0.5);
    if (!line) {
      lines.push({ ...box, items: [box] });
      continue;
    }
    line.items.push(box);
    line.bottom = Math.min(line.bottom, box.bottom);
    line.top = Math.max(line.top, box.top);
    line.h = line.top - line.bottom;
  }
  return lines;
}

function isPageNumber(box, text, pageHeight) {
  if (!/^\d+$/.test(text) || !(pageHeight > 0)) return false;
  const margin = pageHeight * 0.08;
  return box.bottom <= margin || box.top >= pageHeight - margin;
}

/**
 * Standalone section number on the same baseline as the title, to its left.
 * Line boxes must overlap by at least half the shorter box. `(3)`, Roman
 * numerals, and a bare integer in the page margin are rejected.
 */
export function numberBesideTitle(items, title, options = {}) {
  const want = tocKey(title);
  if (!want) return "";
  const boxes = (items || []).map(itemBox).filter(Boolean);
  if (!boxes.length) return "";
  const pageHeight = Number(options.pageHeight) || Math.max(...boxes.map((box) => box.top), 0);
  for (const line of clusterLines(boxes)) {
    const row = [...line.items].sort((a, b) => a.x - b.x);
    let run = null;
    for (let start = 0; start < row.length && !run; start += 1) {
      let joined = "";
      for (let end = start; end < row.length; end += 1) {
        joined = `${joined} ${row[end].str}`.trim();
        if (tocKey(joined) !== want) {
          if (tocKey(joined).length > want.length + 2) break;
          continue;
        }
        run = row.slice(start, end + 1);
        break;
      }
    }
    if (!run) continue;
    let titleItems = run;
    let peeled = "";
    while (titleItems.length > 1) {
      const lead = standaloneSectionNumber(titleItems[0].str);
      const rest = tocKey(titleItems.slice(1).map((part) => part.str).join(" "));
      if (!lead || rest !== want || isPageNumber(titleItems[0], lead, pageHeight)) break;
      peeled = lead;
      titleItems = titleItems.slice(1);
    }
    const titleLeft = Math.min(...titleItems.map((part) => part.x));
    const titleBox = {
      top: Math.max(...titleItems.map((part) => part.top)),
      bottom: Math.min(...titleItems.map((part) => part.bottom)),
      h: 0
    };
    titleBox.h = titleBox.top - titleBox.bottom;
    let closest = peeled;
    let closestX = peeled ? titleLeft : -Infinity;
    for (const part of row) {
      if (titleItems.includes(part)) continue;
      if (part.x + part.w > titleLeft + 1) continue;
      if (verticalOverlap(part, titleBox) < 0.5) continue;
      const num = standaloneSectionNumber(part.str);
      if (!num || isPageNumber(part, num, pageHeight)) continue;
      if (part.x >= closestX) {
        closest = num;
        closestX = part.x;
      }
    }
    if (closest) return closest;
  }
  return "";
}

/**
 * Last entry whose page is at or above the reading line.
 * A line before the first entry is -1. The boundary belongs to the entry that starts there.
 */
export function currentTocIndex(entries, readingLine) {
  const list = entries || [];
  if (!list.length) return -1;
  const line = Number(readingLine);
  if (!Number.isFinite(line)) return -1;
  const positioned = list.some((entry) => Number.isFinite(Number(entry?.offset)));
  let current = -1;
  for (let index = 0; index < list.length; index += 1) {
    const at = positioned ? Number(list[index]?.offset) : Number(list[index]?.offset ?? list[index]?.page);
    if (!Number.isFinite(at)) continue;
    if (at <= line) current = index;
    else break;
  }
  return current;
}

/** PDF destination y, measured from the bottom of the page. */
export function destinationTop(dest) {
  if (!Array.isArray(dest)) return null;
  const kind = dest[1] && typeof dest[1] === "object" ? dest[1].name : dest[1];
  const raw = kind === "XYZ" ? dest[3] : (kind === "FitH" || kind === "FitBH" ? dest[2] : null);
  const top = Number(raw);
  return typeof raw === "number" && Number.isFinite(top) ? top : null;
}

/**
 * Scrollport offset for each entry. The first entry on a page owns the page
 * top (a figure above its heading still belongs to that section). Later
 * entries on the same page start at the heading.
 */
export function sectionOffsets(entries, pages) {
  const boxes = new Map();
  for (const box of pages || []) {
    const page = Number(box?.page) || 0;
    const top = Number(box?.top);
    const height = Number(box?.height);
    if (page && Number.isFinite(top) && height > 0) boxes.set(page, { top, height, pdfHeight: Number(box.pdfHeight) || 0 });
  }
  const seen = new Set();
  return (entries || []).map((entry) => {
    const page = Number(entry?.page) || 0;
    const box = boxes.get(page);
    if (!box) return null;
    const first = !seen.has(page);
    seen.add(page);
    const mark = Number(entry?.markTop);
    if (Number.isFinite(mark)) return first ? Math.min(box.top, mark) : mark;
    const pdfH = Number(entry?.pageHeight) > 0 ? Number(entry.pageHeight) : box.pdfHeight;
    const destY = Number(entry?.destY);
    let fraction = Number.isFinite(Number(entry?.topFraction)) ? Number(entry.topFraction) : null;
    if (pdfH > 0 && Number.isFinite(destY)) fraction = (pdfH - destY) / pdfH;
    if (!Number.isFinite(fraction)) return first ? box.top : null;
    const clamped = Math.min(1, Math.max(0, fraction));
    const heading = box.top + clamped * box.height;
    return first ? box.top : heading;
  });
}

export function partialHint(laidOut, total) {
  const done = Math.max(0, Math.floor(Number(laidOut) || 0));
  const all = Math.max(0, Math.floor(Number(total) || 0));
  if (!(all > 0) || done >= all) return "";
  return `后面的小节等页面排版好后出现（${done} / ${all} 页）`;
}

export function drawerShouldDock({
  windowWidth = 0,
  sourceWidth = 0,
  sideSlot = 0,
  docked = false
} = {}) {
  const width = Number(windowWidth) || 0;
  if (width < DRAWER_NARROW) return false;
  const side = (Number(sideSlot) || 0) > 0 ? 8 + Number(sideSlot) : 0;
  const space = width - (Number(sourceWidth) || 0) - 8 - DRAWER_WIDTH - side;
  const need = docked ? DRAWER_DOCK_MIN - DRAWER_DOCK_HYSTERESIS : DRAWER_DOCK_MIN;
  return space >= need;
}
