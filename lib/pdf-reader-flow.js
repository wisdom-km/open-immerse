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
/** Source-pane fraction of the width beside the splitter. SPEC §3.1. */
export const READER_SPLIT_STORAGE_KEY = "reader.splitRatio";
export const SPLIT_SOURCE_MIN = 320;
export const SPLIT_TRANSLATE_MIN = 560;
export const SPLIT_TRANSLATE_MIN_MID = 540;
export const SPLIT_GAP = 8;
/** Capsule margin against the scrollbar. Matches --oi-reader-capsule-end-min. */
export const CAPSULE_END_MIN = 8;
/**
 * Lowest end margin while the 1440/16 default view keeps its start band.
 * Matches --oi-reader-capsule-end-floor. Used only when 8px would push the
 * start inset out of 49–56.
 */
export const CAPSULE_END_BAND = 4;
/** Approved default-view start inset (vs-01, 1440/16, measure 576). */
export const CAPSULE_START_BAND_MIN = 49;
export const CAPSULE_START_BAND_MAX = 56;
/** Shift the measure only while its start inset stays at least this wide. */
export const CAPSULE_START_FLOOR = 24;

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

/** A stored fraction of the free width. Empty or out of range means "use the breakpoint default". */
export function normalizeSplitRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return Math.round(n * 10000) / 10000;
}

/** 50% from 1200px up, 40% from 900 through 1199. */
export function defaultSplitRatio(width) {
  return Number(width) >= 1200 ? 0.5 : 0.4;
}

export function splitTranslateMin(width) {
  return Number(width) >= 1200 ? SPLIT_TRANSLATE_MIN : SPLIT_TRANSLATE_MIN_MID;
}

/**
 * Source width is clamp(320px, ratio × (W − gap), W − gap − T_min).
 * The returned ratio is that clamped source as a fraction of the free width,
 * so a later resize keeps the proportion instead of a frozen pixel width.
 */
export function splitLayout({
  width,
  ratio = 0.5,
  splitW = SPLIT_GAP,
  sourceMin = SPLIT_SOURCE_MIN,
  translateMin
} = {}) {
  const w = Number(width);
  const gap = Number(splitW) > 0 ? Number(splitW) : SPLIT_GAP;
  const available = Number.isFinite(w) ? Math.max(0, w - gap) : 0;
  const tMin = Number.isFinite(Number(translateMin)) ? Number(translateMin) : splitTranslateMin(w);
  let maxSource = Math.max(0, available - tMin);
  let minSource = sourceMin;
  if (minSource > maxSource) minSource = maxSource;
  const want = Number(ratio);
  const preferred = (Number.isFinite(want) ? want : 0.5) * available;
  const source = available > 0 ? Math.min(maxSource, Math.max(minSource, preferred)) : 0;
  const used = available > 0 ? source / available : defaultSplitRatio(w);
  return {
    source,
    translate: available - source,
    ratio: Math.round(used * 10000) / 10000,
    available,
    minSource,
    maxSource
  };
}

export function readReaderPrefs(storage) {
  const single = storageGet(storage, READER_SINGLE_KEY_STORAGE_KEY);
  return {
    fontSize: normalizeReaderFontSize(storageGet(storage, READER_FONT_STORAGE_KEY)),
    theme: normalizeReaderTheme(storageGet(storage, READER_THEME_STORAGE_KEY)),
    singleKey: single === "0" || single === false || single === 0 ? false : true,
    splitRatio: normalizeSplitRatio(storageGet(storage, READER_SPLIT_STORAGE_KEY))
  };
}

export function writeReaderPrefs(storage, prefs = {}) {
  const fontSize = normalizeReaderFontSize(prefs.fontSize);
  const theme = normalizeReaderTheme(prefs.theme);
  const singleKey = prefs.singleKey === false ? false : true;
  const splitRatio = normalizeSplitRatio(prefs.splitRatio);
  storageSet(storage, READER_FONT_STORAGE_KEY, String(fontSize));
  storageSet(storage, READER_THEME_STORAGE_KEY, theme);
  storageSet(storage, READER_SINGLE_KEY_STORAGE_KEY, singleKey ? "1" : "0");
  storageSet(storage, READER_SPLIT_STORAGE_KEY, splitRatio == null ? "" : String(splitRatio));
  return { fontSize, theme, singleKey, splitRatio };
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
 * paneW is the scrollport clientWidth. The measure uses client + scrollbar so
 * a classic 15px bar does not push 36em into the narrow branch. The capsule
 * itself is placed in the visible client width, and the clear gap stays at
 * least `gap`. Yield order when that gap does not fit: short label, shift the
 * measure toward the start edge, narrow the measure, then the sub-bar.
 * The end margin stays at least `minEnd` and is never negative. On the
 * 1440/16 default view the clear gap stays at 12px and the start inset stays
 * in 49–56; the end margin may drop to `endBand` when 8px would leave that
 * band. A shift that would push the start inset under `startFloor` takes the
 * next yield instead. Other widths keep the 8px end and the 24px floor.
 * start is the measure's start inset; null means the measure stays centered.
 * end is the capsule's margin against the visible end edge.
 * forceBar is the stacked layout below 900px.
 */
export function capsulePlacement({
  paneW,
  scrollbar = 0,
  pad,
  fontPx,
  fullW,
  shortW,
  inset = 12,
  gap = 12,
  minEnd = CAPSULE_END_MIN,
  endBand = CAPSULE_END_BAND,
  startBandMin = CAPSULE_START_BAND_MIN,
  startBandMax = CAPSULE_START_BAND_MAX,
  startFloor = CAPSULE_START_FLOOR,
  minMeasure = 480,
  forceBar = false
} = {}) {
  const client = Number(paneW);
  const bar = Number(scrollbar);
  const width = client + (Number.isFinite(bar) && bar > 0 ? bar : 0);
  const visible = Number.isFinite(client) ? client : width;
  const side = Number(pad);
  const size = Number(fontPx);
  const full = Number(fullW);
  const short = Number(shortW);
  const endInset = Number(inset);
  const clear = Number(gap);
  const endMin = Number.isFinite(Number(minEnd)) ? Math.max(0, Number(minEnd)) : CAPSULE_END_MIN;
  const bandEnd = Number.isFinite(Number(endBand)) ? Math.max(0, Number(endBand)) : CAPSULE_END_BAND;
  const bandMin = Number.isFinite(Number(startBandMin)) ? Number(startBandMin) : CAPSULE_START_BAND_MIN;
  const bandMax = Number.isFinite(Number(startBandMax)) ? Number(startBandMax) : CAPSULE_START_BAND_MAX;
  const floor = Number.isFinite(Number(startFloor)) ? Number(startFloor) : CAPSULE_START_FLOOR;
  if (![width, visible, side, size, full, short, endInset, clear].every((n) => Number.isFinite(n))) {
    return { mode: "float", label: "full", measure: 0, start: null, gap: null, end: Math.max(endInset, endMin) };
  }
  const want = Math.min(36 * size, width - 2 * side);
  if (forceBar) return { mode: "bar", label: "full", measure: want, start: null, gap: null, end: endInset };
  const slot = (labelWidth) => labelWidth + endInset + clear;
  const centered = (width - want) / 2;
  const place = {
    visible, inset: endInset, gap: clear, side, minMeasure, want,
    minEnd: endMin, endBand: bandEnd, startBandMin: bandMin, startBandMax: bandMax, startFloor: floor
  };
  if (centered >= slot(full)) {
    return fitCapsuleGap({
      ...place, measure: want, start: null, label: "full", labelW: full
    });
  }
  if (centered >= slot(short)) {
    return fitCapsuleGap({
      ...place, measure: want, start: null, label: "short", labelW: short
    });
  }
  const shortSlot = slot(short);
  if (width - want - shortSlot >= side) {
    return fitCapsuleGap({
      ...place, measure: want, start: width - want - shortSlot, label: "short", labelW: short
    });
  }
  const narrowed = width - side - shortSlot;
  if (narrowed >= minMeasure) {
    return fitCapsuleGap({
      ...place, measure: narrowed, start: side, label: "short", labelW: short
    });
  }
  return { mode: "bar", label: "full", measure: want, start: null, gap: null, end: Math.max(endInset, endMin) };
}

/** Place the capsule in the visible box. The end margin never drops under minEnd. */
function fitCapsuleGap({
  visible,
  measure,
  start,
  label,
  labelW,
  inset,
  gap,
  side,
  minMeasure,
  want,
  minEnd,
  endBand,
  startBandMin,
  startBandMax,
  startFloor
}) {
  const lead = start == null ? (visible - measure) / 2 : start;
  const free = visible - lead - measure;
  const maxGap = free - labelW;
  const roomForEnd = maxGap - gap;
  if (roomForEnd >= minEnd - 1e-6) {
    const end = Math.min(Math.max(inset, minEnd), Math.max(minEnd, roomForEnd));
    return { mode: "float", label, measure, start, gap: free - labelW - end, end };
  }
  // 1440/16 default: gap stays 12 and the start inset stays in 49–56.
  // The leftover, not an inflated gap, is the end margin, and it may be 4px.
  const slack = visible - measure - labelW - gap;
  if (slack >= startBandMin + endBand - 1e-6) {
    const endLow = Math.max(endBand, slack - startBandMax);
    const endHigh = Math.min(inset, slack - startBandMin);
    if (endLow <= endHigh + 1e-6) {
      const end = Math.round(Math.min(endHigh, Math.max(endLow, minEnd)) * 100) / 100;
      return { mode: "float", label, measure, start: slack - end, gap, end };
    }
  }
  const shifted = visible - labelW - measure - gap - minEnd;
  if (shifted >= startFloor - 1e-6) {
    return { mode: "float", label, measure, start: shifted, gap, end: minEnd };
  }
  const anchor = Math.max(side, startFloor);
  const endFull = Math.max(inset, minEnd);
  const room = visible - anchor - labelW - endFull - gap;
  if (room >= minMeasure) {
    return { mode: "float", label, measure: room, start: anchor, gap, end: endFull };
  }
  return { mode: "bar", label: "full", measure: want, start: null, gap: null, end: endFull };
}

/** Remember each formula scroller's horizontal offset across a re-render. */
export function indexFormulaScrolls(entries) {
  const saved = new Map();
  for (const entry of entries || []) {
    const left = Number(entry?.left);
    const id = entry?.id == null ? "" : String(entry.id);
    const page = entry?.page == null ? "" : String(entry.page);
    if (!(left > 0) || !id) continue;
    saved.set(`${page}:${id}`, left);
  }
  return saved;
}

/** Restore value for one formula box. Missing and zero offsets stay at 0. */
export function formulaScrollLeft(saved, page, id) {
  const key = `${page == null ? "" : String(page)}:${id == null ? "" : String(id)}`;
  const left = saved instanceof Map ? saved.get(key) : saved?.[key];
  return left > 0 ? left : 0;
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
