/**
 * Continuous reader flow (SPEC Loom rev 3, PR-1).
 * Font steps, theme tokens, page markers, and the multiply fallback.
 * Pairing, follow, and tier-2 KaTeX stay out of this module.
 */

export const READER_FONT_SIZES = Object.freeze([14, 15, 16, 17, 18, 20]);
export const READER_FONT_DEFAULT = 16;
export const READER_THEMES = Object.freeze(["warm", "white", "sepia", "green"]);
export const READER_THEME_DEFAULT = "warm";
export const READER_MEASURE_EM = 38;
export const READER_MEASURE_MIN_EM = 30;
export const READER_BODY_LINE = 1.85;
export const READER_BODY_TRACKING = "0.02em";
export const READER_PARAGRAPH_GAP_PX = 16;
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

export const READER_THEME_TOKENS = Object.freeze({
  warm: Object.freeze({
    paper: "#F7F3EA",
    surface: "#FBF9F4",
    ink: "#22201C",
    ink2: "#4A463E",
    muted: "#615B50",
    line: "#DDD5C4",
    lineStrong: "#8A806C",
    disabled: "#9A9282"
  }),
  white: Object.freeze({
    paper: "#FFFFFF",
    surface: "#FFFFFF",
    ink: "#202020",
    ink2: "#454545",
    muted: "#5E5E5E",
    line: "#E3E3E3",
    lineStrong: "#888888",
    disabled: "#9A9A9A"
  }),
  sepia: Object.freeze({
    paper: "#ECE7DD",
    surface: "#F3EFE8",
    ink: "#26221C",
    ink2: "#463F35",
    muted: "#57504A",
    line: "#D6CEC0",
    lineStrong: "#827868",
    disabled: "#948B7E"
  }),
  green: Object.freeze({
    paper: "#E8EDE6",
    surface: "#F1F4EF",
    ink: "#1E2420",
    ink2: "#3E4740",
    muted: "#4F5A52",
    line: "#CED6CB",
    lineStrong: "#747F75",
    disabled: "#8E968D"
  })
});

export const READER_SHARED_TOKENS = Object.freeze({
  pair: "#A86B12",
  pairBg: "rgba(168, 107, 18, 0.10)",
  pairHalo: "rgba(168, 107, 18, 0.25)",
  warn: "#8A4B0F",
  focus: "#2F55D4",
  mark: "rgba(34, 32, 28, 0.12)",
  tooltipBg: "#22201C",
  tooltipFg: "#F7F3EA"
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

export function capsuleLabel(page) {
  const n = Number(page);
  if (!(n >= 1) || !Number.isFinite(n)) return "";
  return `原文第 ${n} 页`;
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

export function themePaperRgb(theme) {
  return parseHexColor(READER_THEME_TOKENS[normalizeReaderTheme(theme)].paper);
}
