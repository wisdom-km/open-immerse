/**
 * Reader drawer table of contents.
 * Outline entries keep the PDF tree depth. Numbers come from a matched
 * heading, then from a prefix on the title, and otherwise stay blank.
 */

export const DRAWER_WIDTH = 288;
export const DRAWER_DOCK_MIN = 618;
export const DRAWER_DOCK_HYSTERESIS = 24;
export const DRAWER_NARROW = 900;

const DECIMAL_PREFIX = /^(\d+(?:\.\d+)*)(?=$|\s|[.、:：]|(?=[A-Za-z\u4e00-\u9fff]))/;
const APPENDIX_PREFIX = /^([A-Z](?:\.\d+)*)(?=$|\s|[.、:：]|(?=[\u4e00-\u9fff]))/;

export function normalizeTocText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

export function titleNumber(title) {
  const text = String(title || "").trim();
  const decimal = text.match(DECIMAL_PREFIX);
  if (decimal) return decimal[1];
  const appendix = text.match(APPENDIX_PREFIX);
  if (appendix && /^[A-Z](?:\.\d+)*$/.test(appendix[1])) return appendix[1];
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
      entries.push({
        level: num ? Math.min(3, headingLevel(num)) : 1,
        num,
        title: translated ? translation : (num ? stripNumber(raw) || raw : raw),
        original: raw,
        translated,
        page
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
    const num = fromHeading || fromTitle || entry?.num || "";
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

/**
 * Number printed on the same text-layer line as an outline title.
 * Outline titles in the wild usually omit the section number.
 */
export function numberBesideTitle(items, title) {
  const want = normalizeTocText(title);
  if (!want) return "";
  const rows = new Map();
  for (const item of items || []) {
    const str = String(item?.str ?? item?.text ?? "").trim();
    if (!str) continue;
    const yRaw = Number(item?.y ?? item?.transform?.[5]);
    const xRaw = Number(item?.x ?? item?.transform?.[4]);
    const y = Number.isFinite(yRaw) ? Math.round(yRaw) : 0;
    const row = rows.get(y) || [];
    row.push({ str, x: Number.isFinite(xRaw) ? xRaw : 0 });
    rows.set(y, row);
  }
  let loose = "";
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x);
    const joined = row.map((part) => part.str).join(" ");
    const normalized = normalizeTocText(stripNumber(joined));
    if (normalized !== want && !normalized.includes(want)) continue;
    const num = titleNumber(joined);
    if (!num) continue;
    if (normalized === want) return num;
    if (!loose) loose = num;
  }
  return loose;
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
  let current = -1;
  for (let index = 0; index < list.length; index += 1) {
    const at = Number(list[index]?.offset ?? list[index]?.page);
    if (!Number.isFinite(at)) continue;
    if (at <= line) current = index;
    else break;
  }
  return current;
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
