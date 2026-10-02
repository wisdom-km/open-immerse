/**
 * Continuous reader flow (SPEC Loom rev 3, PR-1).
 * Font steps, page markers, and the multiply fallback.
 * Theme colors and other visual numbers live in pdf/reader-tokens.css.
 * Pairing, follow, and tier-2 KaTeX stay out of this module.
 */

export const READER_FONT_SIZES = Object.freeze([14, 15, 16, 17, 18, 20]);
export const READER_FONT_DEFAULT = 16;
export const READER_THEMES = Object.freeze(["warm", "white", "sepia", "green"]);
export const READER_THEME_DEFAULT = "warm";
export const READER_FONT_STORAGE_KEY = "reader.fontSize";
export const READER_THEME_STORAGE_KEY = "reader.theme";
/** Not named in S-15. The Aa switch is specified; the key is recorded as open. */
export const READER_SINGLE_KEY_STORAGE_KEY = "reader.singleKey";

export const READER_THEME_LABELS = Object.freeze({
  warm: "暖纸",
  white: "纯白",
  sepia: "灰褐",
  green: "淡灰绿"
});

export function normalizeReaderFontSize(value) {
  const n = Number(value);
  return READER_FONT_SIZES.includes(n) ? n : READER_FONT_DEFAULT;
}

export function stepReaderFontSize(current, delta) {
  const size = normalizeReaderFontSize(current);
  const index = READER_FONT_SIZES.indexOf(size);
  const next = index + Number(delta);
  if (next < 0 || next >= READER_FONT_SIZES.length) return size;
  return READER_FONT_SIZES[next];
}

export function normalizeReaderTheme(value) {
  const theme = String(value || "");
  return READER_THEMES.includes(theme) ? theme : READER_THEME_DEFAULT;
}

export function readerThemeAriaLabel(theme) {
  const id = normalizeReaderTheme(theme);
  const name = READER_THEME_LABELS[id];
  return id === READER_THEME_DEFAULT ? `${name}（默认）` : name;
}

/** `-` smaller, `=` or `+` larger, `0` back to 16. Empty when the key is not a font key. */
export function readerFontKeyAction(key) {
  if (key === "-" || key === "_") return "decrease";
  if (key === "=" || key === "+") return "increase";
  if (key === "0") return "reset";
  return "";
}

/**
 * Reader-local font shortcut. Modifier chords (⌘− / ⌘+ / ⌘0) are left to the
 * browser. Inputs and contenteditable hosts are not intercepted.
 */
export function readerFontShortcut({
  key,
  metaKey = false,
  ctrlKey = false,
  altKey = false,
  inField = false,
  editing = false,
  inReader = false,
  singleKey = true
} = {}) {
  if (singleKey === false) return "";
  if (metaKey || ctrlKey || altKey) return "";
  if (inField || editing || !inReader) return "";
  return readerFontKeyAction(key);
}

export function applyReaderFontAction(current, action) {
  if (action === "decrease") return stepReaderFontSize(current, -1);
  if (action === "increase") return stepReaderFontSize(current, 1);
  if (action === "reset") return READER_FONT_DEFAULT;
  return normalizeReaderFontSize(current);
}

function storageGet(storage, key) {
  if (!storage) return null;
  if (typeof storage.getItem === "function") return storage.getItem(key);
  if (typeof storage === "object" && Object.prototype.hasOwnProperty.call(storage, key)) return storage[key];
  return null;
}

function storageSet(storage, key, value) {
  if (!storage) return;
  if (typeof storage.setItem === "function") storage.setItem(key, value);
  else if (typeof storage === "object") storage[key] = value;
}

export function readReaderPrefs(storage) {
  const single = storageGet(storage, READER_SINGLE_KEY_STORAGE_KEY);
  return {
    fontSize: normalizeReaderFontSize(storageGet(storage, READER_FONT_STORAGE_KEY)),
    theme: normalizeReaderTheme(storageGet(storage, READER_THEME_STORAGE_KEY)),
    singleKey: single === "0" || single === false || single === 0 ? false : true
  };
}

export function writeReaderPrefs(storage, prefs = {}) {
  const fontSize = normalizeReaderFontSize(prefs.fontSize);
  const theme = normalizeReaderTheme(prefs.theme);
  const singleKey = prefs.singleKey === false ? false : true;
  storageSet(storage, READER_FONT_STORAGE_KEY, String(fontSize));
  storageSet(storage, READER_THEME_STORAGE_KEY, theme);
  storageSet(storage, READER_SINGLE_KEY_STORAGE_KEY, singleKey ? "1" : "0");
  return { fontSize, theme, singleKey };
}

/**
 * Pages that actually render blocks. Current-page scope keeps only that page
 * (SPEC C7); every other page becomes an untranslated fold.
 */
export function contentPagesForScope({ scope, currentPage, pagesWithContent } = {}) {
  const pages = [...(pagesWithContent || [])].map(Number).filter((n) => Number.isFinite(n) && n >= 1);
  if (scope === "all") return pages;
  const current = Number(currentPage);
  return pages.filter((n) => n === current);
}

/**
 * Flow order: translated pages in reading order, a page-break line whenever
 * the source page changes after the first translated page, and a fold row
 * for every page that is not rendered as blocks.
 */
export function planReaderFlow({ pageCount = 0, contentPages = [] } = {}) {
  const total = Math.max(0, Number(pageCount) || 0);
  const content = new Set(
    [...(contentPages || [])].map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= total)
  );
  const items = [];
  let seenContent = false;
  for (let page = 1; page <= total; page += 1) {
    if (content.has(page)) {
      if (seenContent) items.push({ kind: "break", page });
      items.push({ kind: "content", page });
      seenContent = true;
    } else {
      items.push({ kind: "untranslated", page });
    }
  }
  return items;
}

export function pageBreakLabel(page) {
  return `原文第 ${Number(page)} 页`;
}

export function untranslatedLabel(page) {
  return `原文第 ${Number(page)} 页 · 未翻译`;
}

export function capsuleLabel(page, options = {}) {
  const n = Number(page);
  if (!(n >= 1) || !Number.isFinite(n)) return "";
  return options.short ? `第 ${n} 页` : `原文第 ${n} 页`;
}

/**
 * Keep the page capsule off the glyphs. Widths are px.
 * paneW is the scrollport clientWidth. start is the measure's start inset;
 * null means the measure stays centered.
 */
export function capsulePlacement({
  paneW,
  pad,
  fontPx,
  fullW,
  shortW,
  inset = 12,
  gap = 12,
  minMeasure = 480
} = {}) {
  const width = Number(paneW);
  const side = Number(pad);
  const size = Number(fontPx);
  const full = Number(fullW);
  const short = Number(shortW);
  if (![width, side, size, full, short].every((n) => Number.isFinite(n))) {
    return { mode: "float", label: "full", measure: 0, start: null };
  }
  const want = Math.min(36 * size, width - 2 * side);
  const slot = (labelWidth) => labelWidth + inset + gap;
  const centered = (width - want) / 2;
  if (centered >= slot(full)) return { mode: "float", label: "full", measure: want, start: null };
  if (centered >= slot(short)) return { mode: "float", label: "short", measure: want, start: null };
  const shortSlot = slot(short);
  if (width - want - shortSlot >= side) {
    return { mode: "float", label: "short", measure: want, start: width - want - shortSlot };
  }
  const narrowed = width - side - shortSlot;
  if (narrowed >= minMeasure) return { mode: "float", label: "short", measure: narrowed, start: side };
  return { mode: "bar", label: "full", measure: want, start: null };
}

/** True when the scrollport still has content below the fold. */
export function needsFade(scrollTop, clientHeight, scrollHeight) {
  return Number(scrollHeight) - Number(clientHeight) - Number(scrollTop) > 1;
}

/**
 * Pull a programmatic scroll up so the whole block sits above the bottom fade.
 * Only moves upward relative to wantTop.
 */
export function clearFadeScroll({
  wantTop,
  paneHeight,
  blockHeight,
  blockTopInPane,
  fade = 40,
  topPad = 8,
  anchor = 0.3
} = {}) {
  const desiredTopOffset = Math.max(
    topPad,
    Math.min(anchor * paneHeight, paneHeight - fade - blockHeight)
  );
  return Math.min(wantTop, blockTopInPane - desiredTopOffset);
}

/**
 * Page whose block meets the anchor line. A line in a gap uses the next
 * block below; past the last block, the last page.
 */
export function pageAtAnchor(entries, line) {
  const list = (entries || []).filter((item) => (
    Number(item?.page) >= 1 && Number.isFinite(Number(item.top)) && Number.isFinite(Number(item.bottom))
  ));
  if (!list.length) return null;
  const y = Number(line);
  if (!Number.isFinite(y)) return Number(list[0].page);
  for (const item of list) {
    if (item.bottom >= y && item.top <= y) return Number(item.page);
  }
  const below = list.find((item) => item.top > y);
  if (below) return Number(below.page);
  return Number(list[list.length - 1].page);
}

/** `multiply` on supporting engines; canvas precomposite otherwise; original pixels in forced-colors. */
export function readerImageBlend({ supportsMultiply = true, forcedColors = false } = {}) {
  if (forcedColors) return "original";
  if (!supportsMultiply) return "precomposite";
  return "multiply";
}

export function parseHexColor(hex) {
  const raw = String(hex || "").trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16)
  ];
}

/** White × paper = paper, black × paper = black. Result is opaque. */
export function precompositeMultiplyPixels(pixels, paperRgb) {
  const src = pixels instanceof Uint8ClampedArray ? pixels : Uint8ClampedArray.from(pixels || []);
  const paper = paperRgb;
  const out = new Uint8ClampedArray(src.length);
  if (!paper || paper.length < 3) return out;
  for (let i = 0; i < src.length; i += 4) {
    out[i] = Math.round((src[i] * paper[0]) / 255);
    out[i + 1] = Math.round((src[i + 1] * paper[1]) / 255);
    out[i + 2] = Math.round((src[i + 2] * paper[2]) / 255);
    out[i + 3] = 255;
  }
  return out;
}

/** Paper color comes from reader-tokens.css. Accepts #rrggbb or rgb()/rgba(). */
export function themePaperRgb(color) {
  const text = String(color || "").trim();
  const hex = parseHexColor(text);
  if (hex) return hex;
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!rgb) return null;
  return [Math.round(Number(rgb[1])), Math.round(Number(rgb[2])), Math.round(Number(rgb[3]))];
}
