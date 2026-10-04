/**
 * Continuous reader flow (SPEC Loom rev 3, PR-1).
 * Font steps, page markers, and the multiply fallback.
 * Theme colors and other visual numbers live in pdf/reader-tokens.css.
 * Pair geometry and follow state live in pdf-pairing.js.
 * This module stores reader.follow and reader.sourceSide with the other prefs.
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
/** Block follow. "1" on, "0" off. Missing means on. Paused is never stored. */
export const READER_FOLLOW_STORAGE_KEY = "reader.follow";
/** Which edge the source pane occupies. "start" or "end". */
export const READER_SOURCE_SIDE_STORAGE_KEY = "reader.sourceSide";
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
/** Pages of 100 or more may sit this close on the default view before later yields. */
export const CAPSULE_START_RELAXED = 40;
/** Shift the measure only while its start inset stays at least this wide. */
export const CAPSULE_START_FLOOR = 24;
/** Capsule horizontal padding. Matches --oi-reader-capsule-pad-x. */
export const CAPSULE_PAD_X = 11;
/**
 * How far the 1440/16 default view may shrink that padding.
 * Matches --oi-reader-capsule-pad-x-min. Two-digit labels that still fit at
 * 8px stay there; 7px is only the next step, and only on that default view.
 */
export const CAPSULE_PAD_X_MIN = 7;

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

/** Missing, "1", and anything other than an explicit off stay on. Do not read pdfScroll. */
export function normalizeReaderFollow(value) {
  return !(value === "0" || value === false || value === 0);
}

export function normalizeSourceSide(value) {
  return value === "end" ? "end" : "start";
}

export function readReaderPrefs(storage) {
  const single = storageGet(storage, READER_SINGLE_KEY_STORAGE_KEY);
  return {
    fontSize: normalizeReaderFontSize(storageGet(storage, READER_FONT_STORAGE_KEY)),
    theme: normalizeReaderTheme(storageGet(storage, READER_THEME_STORAGE_KEY)),
    singleKey: single === "0" || single === false || single === 0 ? false : true,
    splitRatio: normalizeSplitRatio(storageGet(storage, READER_SPLIT_STORAGE_KEY)),
    follow: normalizeReaderFollow(storageGet(storage, READER_FOLLOW_STORAGE_KEY)),
    sourceSide: normalizeSourceSide(storageGet(storage, READER_SOURCE_SIDE_STORAGE_KEY))
  };
}

export function writeReaderPrefs(storage, prefs = {}) {
  const fontSize = normalizeReaderFontSize(prefs.fontSize);
  const theme = normalizeReaderTheme(prefs.theme);
  const singleKey = prefs.singleKey === false ? false : true;
  const splitRatio = normalizeSplitRatio(prefs.splitRatio);
  const follow = normalizeReaderFollow(prefs.follow);
  const sourceSide = normalizeSourceSide(prefs.sourceSide);
  storageSet(storage, READER_FONT_STORAGE_KEY, String(fontSize));
  storageSet(storage, READER_THEME_STORAGE_KEY, theme);
  storageSet(storage, READER_SINGLE_KEY_STORAGE_KEY, singleKey ? "1" : "0");
  storageSet(storage, READER_SPLIT_STORAGE_KEY, splitRatio == null ? "" : String(splitRatio));
  storageSet(storage, READER_FOLLOW_STORAGE_KEY, follow ? "1" : "0");
  storageSet(storage, READER_SOURCE_SIDE_STORAGE_KEY, sourceSide);
  return { fontSize, theme, singleKey, splitRatio, follow, sourceSide };
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

function pageFlowRow(pages, page) {
  if (!pages) return { state: "queued", hasLayout: false };
  const row = typeof pages.get === "function" ? pages.get(page) : pages[page];
  if (!row) return { state: "queued", hasLayout: false };
  return { state: row.state || "queued", hasLayout: Boolean(row.hasLayout) };
}

/**
 * Full-document flow. Pages queued without a layout collapse into one range.
 * Every real page still gets a slot, hidden while it sits inside that range.
 */
export function planReaderFlow({ pageCount = 0, pages } = {}) {
  const total = Math.max(0, Number(pageCount) || 0);
  const items = [];
  let seenVisible = false;
  let rangeFrom = 0;
  const flush = (end) => {
    if (!rangeFrom) return;
    const from = rangeFrom;
    const to = end;
    items.push({ kind: "range", from, to, state: "queued" });
    for (let page = from; page <= to; page += 1) {
      items.push({ kind: "break", page, hidden: true, state: "queued" });
      items.push({ kind: "slot", page, hidden: true, state: "queued" });
    }
    rangeFrom = 0;
  };
  for (let page = 1; page <= total; page += 1) {
    const row = pageFlowRow(pages, page);
    if (row.state === "queued" && !row.hasLayout) {
      if (!rangeFrom) rangeFrom = page;
      continue;
    }
    flush(page - 1);
    if (seenVisible) items.push({ kind: "break", page, hidden: false, state: row.state });
    items.push({ kind: "slot", page, hidden: false, state: row.state });
    seenVisible = true;
  }
  flush(total);
  return items;
}

export function pageBreakLabel(page) {
  return `原文第 ${Number(page)} 页`;
}

export function capsuleLabel(page, options = {}) {
  const n = Number(page);
  if (!(n >= 1) || !Number.isFinite(n)) return "";
  return options.short ? `第 ${n} 页` : `原文第 ${n} 页`;
}

/**
 * Pages whose labels are measured. Up to 120 pages, every page. Beyond that,
 * one sample per digit length, built from the widest digits in each place,
 * plus the last page. The composed sample may sit past the last page; it is
 * only a width probe.
 */
export function capsuleSamplePages(maxPage, digitWidths) {
  const total = Math.max(1, Math.floor(Number(maxPage) || 1));
  if (total <= 120 || !digitWidths) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const widthOf = (digit) => {
    const width = Number(digitWidths[digit]);
    return Number.isFinite(width) ? width : 0;
  };
  const pick = (chars) => [...chars].sort((a, b) => widthOf(b) - widthOf(a) || (a < b ? -1 : 1))[0];
  const samples = new Set([1, total]);
  const len = String(total).length;
  for (let n = 1; n <= len; n += 1) {
    let text = "";
    const top = Math.min(9, Math.floor(total / 10 ** (n - 1)));
    for (let i = 0; i < n; i += 1) {
      const chars = i === 0 ? "123456789".slice(0, Math.max(1, top)) : "0123456789";
      text += pick(chars) || "1";
    }
    const value = Number(text);
    if (value >= 1) samples.add(value);
  }
  return [...samples];
}

function widestCapsuleLabel(widths) {
  const list = [...(Array.isArray(widths) ? widths : [widths])]
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return list.length ? Math.max(...list) : 0;
}

/**
 * Content width for the capsule. Always at least ceil(widest label). Add at
 * most 1px when `budget` still holds that width. A finite budget never
 * returns a box narrower than the widest label.
 */
export function reserveCapsuleContent(widths, budget = Infinity) {
  const max = widestCapsuleLabel(widths);
  if (!(max > 0)) return 0;
  const ceil = Math.ceil(max - 1e-9);
  const cap = Number.isFinite(Number(budget)) ? Number(budget) : Infinity;
  if (ceil + 1 <= cap + 1e-6) return ceil + 1;
  return ceil;
}

/** Largest content width that still leaves the default-view band at `pad`. */
export function defaultCapsuleContentBudget({
  visible,
  measure = 576,
  gap = 12,
  startMin = CAPSULE_START_BAND_MIN,
  endMin = CAPSULE_END_BAND,
  pad = CAPSULE_PAD_X_MIN
} = {}) {
  return Number(visible) - Number(measure) - Number(gap) - Number(startMin) - Number(endMin) - 2 * Number(pad);
}

/**
 * Content width on the 1440/16 default view. Try padding 8, then
 * CAPSULE_PAD_X_MIN. The optional extra pixel is added only when the same
 * padding still has room, so a label that fits at 8px does not shrink to 7
 * just to gain that pixel. When even the minimum misses the band, the result
 * is still ceil(widest): the start inset may then fall below 49, and the
 * text stays inside the capsule.
 */
export function reserveDefaultCapsuleContent(widths, {
  visible,
  startMin = CAPSULE_START_BAND_MIN,
  measure = 576,
  gap = 12,
  endMin = CAPSULE_END_BAND
} = {}) {
  const max = widestCapsuleLabel(widths);
  if (!(max > 0)) return 0;
  const ceil = Math.ceil(max - 1e-9);
  const first = Math.max(CAPSULE_PAD_X_MIN, 8);
  for (let pad = first; pad >= CAPSULE_PAD_X_MIN; pad -= 1) {
    const room = defaultCapsuleContentBudget({
      visible, measure, gap, startMin, endMin, pad
    });
    if (ceil <= room + 1e-6) return ceil + 1 <= room + 1e-6 ? ceil + 1 : ceil;
  }
  return ceil;
}

/**
 * Same content box whether or not the scrollbar is currently painted.
 * `client` is the scrollport clientWidth. When `scrollbar` is 0, `gutter`
 * is still reserved so the box matches the overflow case.
 */
export function stableCapsulePane({ client, scrollbar = 0, gutter = 0 } = {}) {
  const box = Number(client);
  const bar = Number(scrollbar);
  const reserve = bar > 0 ? bar : Math.max(0, Number(gutter) || 0);
  if (!Number.isFinite(box)) return { paneW: 0, scrollbar: 0 };
  const outer = bar > 0 ? box + bar : box;
  return { paneW: outer - reserve, scrollbar: reserve };
}

function roundCapsulePx(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** Border box of one label. Padding changes move the box by twice the delta. */
function capsuleWidthAtPad(wide, narrow, padHi, padLo, pad) {
  const hi = Number(padHi);
  const lo = Number(padLo);
  const full = Number(wide);
  const slim = Number.isFinite(Number(narrow)) ? Number(narrow) : full - 2 * (hi - lo);
  if (!(pad < hi - 1e-9)) return full;
  if (!(pad > lo + 1e-9)) return slim;
  if (!(hi > lo)) return slim;
  return full + (slim - full) * ((hi - pad) / (hi - lo));
}

/**
 * Start inset in [bandMin, bandMax], gap held, end at least endBand.
 * Null when the label is too wide or the pane is too wide for that band.
 */
function placeCapsuleBand({
  visible, measure, labelW, gap, inset, minEnd, endBand, bandMin, bandMax
}) {
  const slack = visible - measure - labelW - gap;
  if (slack < bandMin + endBand - 1e-6) return null;
  const endLow = Math.max(endBand, slack - bandMax);
  const endHigh = Math.min(inset, slack - bandMin);
  if (endLow > endHigh + 1e-6) return null;
  const end = roundCapsulePx(Math.min(endHigh, Math.max(endLow, minEnd)));
  return { start: slack - end, gap, end };
}

/**
 * Largest capsule padding in [padXMin, padX] that lands the default view in
 * its start band. shrink is the pad yield when even the minimum is too wide.
 */
function chooseCapsulePad({
  visible, measure, shortW, shortWMin, padX, padXMin, maxPage,
  gap, inset, minEnd, endBand, bandMin, bandMax, relaxed
}) {
  const hi = Number(padX);
  const lo = Math.min(hi, Number(padXMin));
  const targets = Number(maxPage) >= 100 ? [bandMin, relaxed] : [bandMin];
  for (let i = 0; i < targets.length; i += 1) {
    for (let pad = hi; pad >= lo - 1e-9; pad -= 1) {
      const capsuleW = roundCapsulePx(capsuleWidthAtPad(shortW, shortWMin, hi, lo, pad));
      const slack = visible - measure - capsuleW - gap;
      if (slack > bandMax + inset && pad === hi && i === 0) return { fit: false, shrink: false };
      const hit = placeCapsuleBand({
        visible, measure, labelW: capsuleW, gap, inset, minEnd, endBand,
        bandMin: targets[i], bandMax
      });
      if (hit) return { fit: true, padX: pad, capsuleW, ...hit };
    }
  }
  const capsuleW = roundCapsulePx(capsuleWidthAtPad(shortW, shortWMin, hi, lo, lo));
  const slack = visible - measure - capsuleW - gap;
  if (slack > bandMax + inset) return { fit: false, shrink: false };
  return { fit: false, shrink: true, padX: lo, capsuleW };
}

/**
 * Keep the page capsule off the glyphs. Widths are px.
 * paneW is the scrollport clientWidth. The measure uses client + scrollbar so
 * a classic 15px bar does not push 36em into the narrow branch. The capsule
 * itself is placed in the visible client width, and the clear gap stays at
 * least `gap`. Yield order when that gap does not fit: short label, then on
 * the 1440/16 default view shrink the capsule padding from `padX` down to
 * `padXMin` (8px while the label fits, otherwise 7px), then shift the measure toward the start edge, narrow the
 * measure, then the sub-bar.
 * The end margin stays at least `minEnd` and is never negative. On the
 * 1440/16 default view the clear gap stays at 12px. Documents under 100
 * pages keep the start inset in 49–56 while the label fits at 7px or more;
 * 100 pages or more may sit at 40 or more before the later yields. If 7px
 * still misses that band, the start inset may fall below 49. The content
 * box is never narrower than the widest label. The end margin may drop to
 * `endBand` when 8px would leave that band. A shift that would push the start inset under
 * `startFloor` takes the next yield instead. Other widths keep the 8px end
 * and the 24px floor, and do not shrink the capsule padding.
 * start is the measure's start inset; null means the measure stays centered.
 * end is the capsule's margin against the visible end edge.
 * padX is the padding the capsule actually uses. capsuleW is the border box
 * reserved for this document's max-page label at that padding; the capsule
 * width stays on that value while the reader pages.
 * forceBar is the stacked layout below 900px.
 * shortW is the max-page short label at padX. shortWMin is the same label
 * at padXMin. maxPage is the document length, not how many pages are translated.
 */
export function capsulePlacement({
  paneW,
  scrollbar = 0,
  pad,
  fontPx,
  fullW,
  shortW,
  shortWMin,
  padX = CAPSULE_PAD_X,
  padXMin = CAPSULE_PAD_X_MIN,
  maxPage = 0,
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
  let short = Number(shortW);
  const endInset = Number(inset);
  const clear = Number(gap);
  const endMin = Number.isFinite(Number(minEnd)) ? Math.max(0, Number(minEnd)) : CAPSULE_END_MIN;
  const bandEnd = Number.isFinite(Number(endBand)) ? Math.max(0, Number(endBand)) : CAPSULE_END_BAND;
  const bandMin = Number.isFinite(Number(startBandMin)) ? Number(startBandMin) : CAPSULE_START_BAND_MIN;
  const bandMax = Number.isFinite(Number(startBandMax)) ? Number(startBandMax) : CAPSULE_START_BAND_MAX;
  const floor = Number.isFinite(Number(startFloor)) ? Number(startFloor) : CAPSULE_START_FLOOR;
  const capsulePad = Number.isFinite(Number(padX)) ? Number(padX) : CAPSULE_PAD_X;
  const capsulePadMin = Number.isFinite(Number(padXMin)) ? Number(padXMin) : CAPSULE_PAD_X_MIN;
  const pages = Number(maxPage) || 0;
  if (![width, visible, side, size, full, short, endInset, clear].every((n) => Number.isFinite(n))) {
    return {
      mode: "float", label: "full", measure: 0, start: null, gap: null,
      end: Math.max(endInset, endMin), padX: capsulePad, capsuleW: 0
    };
  }
  const want = Math.min(36 * size, width - 2 * side);
  const defaultView = !forceBar && size === 16 && side === 40 && Math.abs(want - 36 * 16) < 1e-6;
  if (forceBar) {
    return {
      mode: "bar", label: "full", measure: want, start: null, gap: null,
      end: endInset, padX: capsulePad, capsuleW: full
    };
  }
  const slot = (labelWidth) => labelWidth + endInset + clear;
  const centered = (width - want) / 2;
  const place = {
    visible, inset: endInset, gap: clear, side, minMeasure, want, fullW: full, basePad: capsulePad,
    minEnd: endMin, endBand: bandEnd, startBandMin: bandMin, startBandMax: bandMax, startFloor: floor
  };
  if (centered >= slot(full)) {
    return fitCapsuleGap({
      ...place, measure: want, start: null, label: "full", labelW: full, padX: capsulePad, capsuleW: full
    });
  }
  let resolvedPad = capsulePad;
  if (defaultView) {
    const chosen = chooseCapsulePad({
      visible, measure: want, shortW: short, shortWMin, padX: capsulePad, padXMin: capsulePadMin,
      maxPage: pages, gap: clear, inset: endInset, minEnd: endMin, endBand: bandEnd,
      bandMin, bandMax, relaxed: CAPSULE_START_RELAXED
    });
    if (chosen.fit) {
      return {
        mode: "float", label: "short", measure: want, start: chosen.start, gap: chosen.gap,
        end: chosen.end, padX: chosen.padX, capsuleW: chosen.capsuleW
      };
    }
    if (chosen.shrink) {
      short = chosen.capsuleW;
      resolvedPad = chosen.padX;
    }
  }
  if (centered >= slot(short)) {
    return fitCapsuleGap({
      ...place, measure: want, start: null, label: "short", labelW: short, padX: resolvedPad, capsuleW: short
    });
  }
  const shortSlot = slot(short);
  if (width - want - shortSlot >= side) {
    return fitCapsuleGap({
      ...place, measure: want, start: width - want - shortSlot, label: "short",
      labelW: short, padX: resolvedPad, capsuleW: short
    });
  }
  const narrowed = width - side - shortSlot;
  if (narrowed >= minMeasure) {
    return fitCapsuleGap({
      ...place, measure: narrowed, start: side, label: "short", labelW: short,
      padX: resolvedPad, capsuleW: short
    });
  }
  return {
    mode: "bar", label: "full", measure: want, start: null, gap: null,
    end: Math.max(endInset, endMin), padX: capsulePad, capsuleW: full
  };
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
  startFloor,
  padX,
  capsuleW,
  fullW,
  basePad
}) {
  const pack = (result) => ({ padX, capsuleW, ...result });
  const lead = start == null ? (visible - measure) / 2 : start;
  const free = visible - lead - measure;
  const maxGap = free - labelW;
  const roomForEnd = maxGap - gap;
  if (roomForEnd >= minEnd - 1e-6) {
    const end = Math.min(Math.max(inset, minEnd), Math.max(minEnd, roomForEnd));
    return pack({ mode: "float", label, measure, start, gap: free - labelW - end, end });
  }
  // 1440/16 default: gap stays 12 and the start inset stays in 49–56.
  // The leftover, not an inflated gap, is the end margin, and it may be 4px.
  const band = placeCapsuleBand({
    visible, measure, labelW, gap, inset, minEnd, endBand,
    bandMin: startBandMin, bandMax: startBandMax
  });
  if (band) return pack({ mode: "float", label, measure, ...band });
  const shifted = visible - labelW - measure - gap - minEnd;
  if (shifted >= startFloor - 1e-6) {
    return pack({ mode: "float", label, measure, start: shifted, gap, end: minEnd });
  }
  const anchor = Math.max(side, startFloor);
  const endFull = Math.max(inset, minEnd);
  const room = visible - anchor - labelW - endFull - gap;
  if (room >= minMeasure) {
    return pack({ mode: "float", label, measure: room, start: anchor, gap, end: endFull });
  }
  return {
    mode: "bar", label: "full", measure: want, start: null, gap: null,
    end: endFull, padX: basePad, capsuleW: fullW
  };
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
