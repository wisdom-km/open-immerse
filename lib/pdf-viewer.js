/** PDF Viewer V1 — page/document translate goes through OI_TRANSLATE_BATCH. */

import { PDF_PROMPT_ADDENDUM, translatableBlocks, visualBlockMarkdown } from "./pdf-blocks.js";
import { buildSavedPairIndex, isLiveSlotRetranslate, savedPairNeedsRetranslate, selectSavedHit, sourceReuseHash } from "./pdf-library.js";
import { looksLikeFormulaItem } from "./pdf-mirror.js";

export const PDF_COPY = {
  title: "PDF 阅读",
  openInImmerse: "在沉浸译中打开",
  openFile: "打开 PDF",
  loading: "正在打开 PDF…",
  empty: "还没有打开 PDF。",
  error: "无法打开这个 PDF。",
  fetchFail: "无法从此地址读取 PDF，请改用本地文件。",
  noTextLayer: "本页没有文字层。",
  noTextLayerHint: "本页没有文字层，无法提取阅读文本。扫描件翻译将在后续版本支持。",
  mirrorCaption: "版式镜像",
  viewMirror: "版式",
  viewReadout: "通读",
  readoutHint: "按阅读顺序提取标题与正文，译成 Markdown 通读。公式尽量用 LaTeX；图可略。",
  mirrorHint: "按阅读顺序提取标题与正文，译成 Markdown 通读。公式尽量用 LaTeX；图可略。",
  figureFallback: "图（见左侧）",
  formulaFallback: "（公式见左栏）",
  translateHint: "点击翻译",
  translatingWait: "正在翻译，请稍候…",
  translate: "翻译",
  stop: "停止",
  restore: "原文",
  translating: "翻译中",
  polishing: "润色中",
  polishFail: "润色失败",
  emptyPage: "本页没有可翻译的文字。",
  done: "本页已翻译。",
  doneDocument: "全文已翻译。",
  retranslateRunning: "正在重译本页译文…",
  retranslateDone: "本页译文已更新",
  retranslateFailed: "本页重译失败，仍显示原译文",
  stopped: "已停止。",
  pausedStreak: "连续 3 页翻译失败，已暂停。点「翻译」继续。",
  incompletePages: "有页面没有译完。点「翻译」继续。",
  noReturnedTranslation: "没有返回译文。点「翻译」再试。",
  runtimeUnavailable: "无法翻译：阅读器不在扩展里。请用沉浸译打开这份 PDF；已打开的话，到 chrome://extensions 重新加载后再试。",
  exportMd: "导出 MD",
  exportPdf: "导出 PDF",
  exporting: "正在导出…",
  exportFail: "导出失败"
};

export const DEFAULT_PDF_VIEW = "readout";

export const ZOOM_MIN = 0.5;
/** Product lock: hard cap at 500%. Not unlimited. */
export const ZOOM_MAX = 5;
export const ZOOM_STEP = 0.25;
export const DEFAULT_ZOOM = 1;
export const ZOOM_CHIP_STORAGE_KEY = "pdfZoomChipPos";
export const MIRROR_ZOOM_STORAGE_KEY = "pdfMirrorZoom";
export const MIRROR_ZOOM_CHIP_POS_KEY = "pdfMirrorZoomChipPos";
export const ZOOM_CHIP_INSET = 8;
export const ZOOM_CHIP_DEFAULT_BOTTOM = 12;
export const ZOOM_CHIP_MIN_RIGHT = 12;
export const ZOOM_CHIP_GUTTER_FALLBACK = 14;
export const ZOOM_CHIP_GUTTER_PAD = 4;
export const ZOOM_CHIP_HANDLE_GAP = 8;
export const SPLIT_HANDLE_WIDTH = 12;
export const ZOOM_CHIP_DRAG_THRESHOLD_PX = 6;
export const PDF_CANVAS_MAX_DIM = 8192;

export function clampZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_ZOOM;
  const snapped = Math.round(n / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(snapped.toFixed(2))));
}

/**
 * Zoom that fits one PDF page into the mini column.
 * `pageWidth` is the CSS width at zoom 1. `innerWidth` is the page slot after
 * the column's padding and scrollbar gutter. The ratio is not snapped to
 * ZOOM_STEP, and it may sit below ZOOM_MIN so a wide page still fits.
 * Manual steps keep clampZoom. The result stops at ZOOM_MAX so a tiny page
 * cannot ask for an unbounded bitmap. Source zoom is not stored.
 */
export function fitWidthZoom(pageWidth, innerWidth) {
  const page = Number(pageWidth);
  const inner = Number(innerWidth);
  if (!(page > 0) || !(inner > 0)) return null;
  const scale = inner / page;
  if (!Number.isFinite(scale) || !(scale > 0)) return null;
  return Math.min(ZOOM_MAX, scale);
}

/** Label for the live source zoom, including a fit-width value off the 25% grid. */
export function formatZoomPercent(scale) {
  const n = Number(scale);
  if (!Number.isFinite(n) || !(n > 0)) return zoomLabel(DEFAULT_ZOOM);
  return `${Math.round(n * 100)}%`;
}

/**
 * Source-pane zoom for a layout mode.
 * Source zoom is not stored. `touched` keeps a choice made this document.
 * Mini mode uses the page fit when `pageWidth` and `innerWidth` are known.
 */
export function defaultSourceZoom(mode, { touched = false, current = DEFAULT_ZOOM, pageWidth = 0, innerWidth = 0 } = {}) {
  if (touched) return clampZoom(current);
  if (mode !== "mini") return DEFAULT_ZOOM;
  return fitWidthZoom(pageWidth, innerWidth) ?? DEFAULT_ZOOM;
}

export function nextZoom(current, dir) {
  return clampZoom(Number(current) + (Number(dir) || 0) * ZOOM_STEP);
}

export function pageIndex(current, total, dir) {
  const t = Math.max(1, Number(total) || 1);
  const c = Math.min(t, Math.max(1, Number(current) || 1));
  return Math.min(t, Math.max(1, c + (Number(dir) || 0)));
}

export function pageLabel(current, total) {
  return `${current} / ${total}`;
}

export function zoomLabel(scale) {
  return `${Math.round(clampZoom(scale) * 100)}%`;
}

/**
 * Specified width of `.paper-stack`.
 * CSS zoom multiplies px on that element, and scrollWidth follows the border
 * box. This is the unzoomed paper width, not `100% * zoom`.
 */
export const PAPER_STACK_WIDTH = "max(100%, var(--oi-pdf-stack-w, 0px))";

export function zoomButtonState({ hasDoc = false, zoom = DEFAULT_ZOOM } = {}) {
  const n = Number(zoom);
  const scale = Number.isFinite(n) ? n : DEFAULT_ZOOM;
  return {
    outDisabled: !hasDoc || scale <= ZOOM_MIN,
    inDisabled: !hasDoc || scale >= ZOOM_MAX
  };
}

export function exceedsDragThreshold(dx, dy, threshold = ZOOM_CHIP_DRAG_THRESHOLD_PX) {
  const limit = Number(threshold);
  const t = Number.isFinite(limit) ? limit : ZOOM_CHIP_DRAG_THRESHOLD_PX;
  return Math.hypot(Number(dx) || 0, Number(dy) || 0) >= t;
}

export function measureScrollbarWidth(el) {
  if (!el) return 0;
  return Math.max(0, (Number(el.offsetWidth) || 0) - (Number(el.clientWidth) || 0));
}

export function measureScrollbarHeight(el) {
  if (!el) return 0;
  return Math.max(0, (Number(el.offsetHeight) || 0) - (Number(el.clientHeight) || 0));
}

/** Overlay scrollbars report 0; if the pane overflows, still reserve a gutter. */
export function effectiveScrollbarWidth(el) {
  const measured = measureScrollbarWidth(el);
  if (measured) return measured;
  if (!el) return 0;
  return Number(el.scrollHeight) - Number(el.clientHeight) > 4 ? ZOOM_CHIP_GUTTER_FALLBACK : 0;
}

export function effectiveScrollbarHeight(el) {
  const measured = measureScrollbarHeight(el);
  if (measured) return measured;
  if (!el) return 0;
  return Number(el.scrollWidth) - Number(el.clientWidth) > 4 ? ZOOM_CHIP_GUTTER_FALLBACK : 0;
}

export function zoomChipGutterGap({ paneEdge, pagesEdge, scrollbar = 0 } = {}) {
  const pane = Number(paneEdge);
  const pages = Number(pagesEdge);
  const sb = Math.max(0, Number(scrollbar) || 0);
  const measured = Number.isFinite(pane) && Number.isFinite(pages) && pages > 0 && pane >= pages;
  const gap = measured ? pane - pages : ZOOM_CHIP_GUTTER_FALLBACK;
  return Math.max(0, gap) + sb;
}

export function zoomChipRightGutter({ paneRight, pagesRight, scrollbarWidth = 0 } = {}) {
  return zoomChipGutterGap({ paneEdge: paneRight, pagesEdge: pagesRight, scrollbar: scrollbarWidth });
}

/** right: max(12px, gutter + 4px). Gutter defaults to 14 → 18px. */
export function zoomChipDefaultRight(gutter = ZOOM_CHIP_GUTTER_FALLBACK) {
  const g = Number.isFinite(Number(gutter)) ? Math.max(0, Number(gutter)) : ZOOM_CHIP_GUTTER_FALLBACK;
  return Math.max(ZOOM_CHIP_MIN_RIGHT, g + ZOOM_CHIP_GUTTER_PAD);
}

export function zoomChipRightClearance({
  inset = ZOOM_CHIP_INSET,
  gutter = ZOOM_CHIP_GUTTER_FALLBACK,
  handleWidth = SPLIT_HANDLE_WIDTH,
  handleGap = ZOOM_CHIP_HANDLE_GAP
} = {}) {
  const edge = Number.isFinite(Number(inset)) ? Number(inset) : ZOOM_CHIP_INSET;
  const handleHalf = Math.max(0, Number(handleWidth) || SPLIT_HANDLE_WIDTH) / 2;
  const gap = Number.isFinite(Number(handleGap)) ? Number(handleGap) : ZOOM_CHIP_HANDLE_GAP;
  return Math.max(edge, zoomChipDefaultRight(gutter), handleHalf + gap);
}

export function clampZoomChipPos({
  left,
  top,
  width,
  height,
  paneWidth,
  paneHeight,
  inset = ZOOM_CHIP_INSET,
  rightInset
} = {}) {
  const pad = Number(inset);
  const edge = Number.isFinite(pad) ? pad : ZOOM_CHIP_INSET;
  const right = Number.isFinite(Number(rightInset)) ? Number(rightInset) : zoomChipRightClearance({ inset: edge });
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const pw = Math.max(0, Number(paneWidth) || 0);
  const ph = Math.max(0, Number(paneHeight) || 0);
  const minL = edge;
  const minT = edge;
  const maxL = Math.max(minL, pw - w - right);
  const maxT = Math.max(minT, ph - h - edge);
  const rawL = Number(left);
  const rawT = Number(top);
  return {
    left: Math.round(Math.min(Math.max(minL, Number.isFinite(rawL) ? rawL : minL), maxL)),
    top: Math.round(Math.min(Math.max(minT, Number.isFinite(rawT) ? rawT : minT), maxT))
  };
}

export function zoomChipDefaultPos({
  paneWidth,
  paneHeight,
  chipWidth,
  chipHeight,
  gutter = ZOOM_CHIP_GUTTER_FALLBACK,
  inset = ZOOM_CHIP_INSET
} = {}) {
  const w = Math.max(0, Number(chipWidth) || 0);
  const h = Math.max(0, Number(chipHeight) || 0);
  const pw = Math.max(0, Number(paneWidth) || 0);
  const ph = Math.max(0, Number(paneHeight) || 0);
  const right = zoomChipDefaultRight(gutter);
  return clampZoomChipPos({
    left: pw - w - right,
    top: ph - h - ZOOM_CHIP_DEFAULT_BOTTOM,
    width: w,
    height: h,
    paneWidth: pw,
    paneHeight: ph,
    inset,
    rightInset: zoomChipRightClearance({ inset, gutter })
  });
}

export function normalizeZoomChipPos(value) {
  if (!value || typeof value !== "object") return null;
  const left = Number(value.left);
  const top = Number(value.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, top };
}

export function canvasOutputScale(cssWidth, cssHeight, devicePixelRatio = 1) {
  const dpr = Math.max(1, Number(devicePixelRatio) || 1);
  const w = Math.max(1, Number(cssWidth) || 1);
  const h = Math.max(1, Number(cssHeight) || 1);
  return Math.max(0.1, Math.min(dpr, PDF_CANVAS_MAX_DIM / w, PDF_CANVAS_MAX_DIM / h));
}

export function textLayerCopy(itemCount) {
  return Number(itemCount) > 0 ? "" : PDF_COPY.noTextLayer;
}

export function pageBlocksCopy(blockCount, itemCount) {
  if (Number(itemCount) <= 0) return PDF_COPY.noTextLayer;
  if (Number(blockCount) <= 0) return PDF_COPY.emptyPage;
  return "";
}

/** OCR pages still open the readout when the only content is the warning. */
export function showsBlockReadout(layout) {
  if (layout?.kind !== "blocks") return false;
  if (layout.textSource === "ocr") return true;
  return Boolean(layout.blocks?.length);
}

export function progressStatus(k, n) {
  return `正在翻译第 ${k} / ${n} 段`;
}

export function progressDocumentStatus(page, total) {
  return `翻译中 · ${page}/${total}`;
}

/** In-page running hint. Middle dot is U+00B7 with spaces. Unknown m omits the fraction. */
export function psRunning(done, total) {
  const m = Math.max(0, Number(total) || 0);
  if (!(m > 0)) return "正在翻译…";
  return `正在翻译 · ${Math.max(0, Number(done) || 0)} / ${m} 段`;
}

/** Queued pages that have no layout yet, collapsed into one row. */
export function qQueued(from, to) {
  const a = Math.max(1, Number(from) || 1);
  const b = Math.max(a, Number(to) || a);
  if (a === b) return `第 ${a} 页 · 排队翻译`;
  return `第 ${a}–${b} 页 · 排队翻译（${b - a + 1} 页）`;
}

/** The same collapsed row after three whole pages fail and the job pauses. */
export function qPaused(from, to) {
  const a = Math.max(1, Number(from) || 1);
  const b = Math.max(a, Number(to) || a);
  const why = "连续 3 页翻译失败，已暂停";
  if (a === b) return `第 ${a} 页 · ${why}`;
  return `第 ${a}–${b} 页 · ${why}（${b - a + 1} 页）`;
}

export function psSkippedCopy() {
  return "参考文献 · 保留原文";
}

export function psEmptyCopy() {
  return "本页没有可翻译的文字";
}

export function psNoTextCopy() {
  return "本页没有文字层";
}

const TRANSLATED_PAGE_STATES = new Set(["done", "partial", "skipped", "empty", "held"]);

/** n counts finished pages. A failed page is not finished. partial still needs retry. */
export function translatedPageTotal(states) {
  let n = 0;
  let needsRetry = 0;
  for (const row of states || []) {
    const state = row?.state || "";
    if (TRANSLATED_PAGE_STATES.has(state)) n += 1;
    if (state === "failed" || state === "partial") needsRetry += 1;
  }
  return { n, needsRetry };
}

/**
 * Toolbar slot. 全文已译 only when every page is finished and none need retry.
 * A failed batch must not be able to light this up.
 */
export function docStatusView({ n = 0, t = 0, needsRetry = 0, phase = "idle" } = {}) {
  // Opening hides the count only before any page is known. A library or old
  // cache can already settle pages while the first layout is still running.
  if (phase === "opening" && !(Number(n) > 0 && Number(t) > 0)) {
    return { state: "opening", text: "正在读取 PDF…" };
  }
  const clean = phase !== "running" && phase !== "opening" && t > 0 && n === t && needsRetry === 0;
  if (clean) return { state: "done", text: "全文已译" };
  if (t > 0) {
    const state = phase === "running" ? "running" : (needsRetry ? "retry" : "idle");
    return { state, text: `已译 ${n} / ${t} 页` };
  }
  return { state: "idle", text: "" };
}

/** Han is the Chinese-target signal. Other targets use their own script. */
export function translationHasHan(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

const TARGET_SCRIPT = {
  "zh-CN": "han",
  "zh-TW": "han",
  ja: "ja",
  ko: "hangul",
  ru: "cyrillic",
  uk: "cyrillic",
  ar: "arabic",
  fa: "arabic",
  he: "hebrew",
  hi: "devanagari",
  bn: "bengali",
  th: "thai",
  el: "greek"
};

const SCRIPT_RE = {
  han: /[\u4e00-\u9fff]/,
  kana: /[\u3040-\u30ff\uff66-\uff9d]/,
  hangul: /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/,
  cyrillic: /[\u0400-\u04ff]/,
  arabic: /[\u0600-\u06ff]/,
  hebrew: /[\u0590-\u05ff]/,
  devanagari: /[\u0900-\u097f]/,
  bengali: /[\u0980-\u09ff]/,
  thai: /[\u0e00-\u0e7f]/,
  greek: /[\u0370-\u03ff]/
};

export function normalizeTranslateTarget(code) {
  const value = String(code || "").trim();
  return value || "zh-CN";
}

function foldedTranslation(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

const LETTER_RE = /\p{L}/u;

/**
 * A block counts as translated for the active target language.
 * Chinese requires Han. Japanese accepts Han or kana. Korean requires Hangul.
 * Latin targets (English, German, …) count when the text is non-empty and not the source.
 * Empty text, or text that only repeats the source, is not a translation.
 */
export function translationLanded(translation, source = "", targetLang = "zh-CN") {
  const text = String(translation || "").trim();
  if (!text) return false;
  const src = foldedTranslation(source);
  if (src && foldedTranslation(text) === src) return false;
  const script = TARGET_SCRIPT[normalizeTranslateTarget(targetLang)] || "latin";
  if (script === "han") return SCRIPT_RE.han.test(text);
  if (script === "ja") return SCRIPT_RE.han.test(text) || SCRIPT_RE.kana.test(text);
  if (script === "latin") {
    if (SCRIPT_RE.han.test(text)) return false;
    return LETTER_RE.test(text);
  }
  return SCRIPT_RE[script].test(text);
}

/**
 * A short segment returned unchanged is already the target text (BLEU, a model
 * name, a symbol). Longer echoes are settled too, by translationEcho.
 */
export function translationUnchangedOk(translation, source = "") {
  const text = String(translation || "").trim();
  if (!text) return false;
  const src = foldedTranslation(source);
  if (!src || foldedTranslation(text) !== src) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 3) return true;
  return !LETTER_RE.test(text);
}

/** The translator returned the source itself. Empty text is not an echo. */
export function translationEcho(translation, source = "") {
  const text = String(translation || "").trim();
  if (!text) return false;
  const src = foldedTranslation(source);
  return Boolean(src) && foldedTranslation(text) === src;
}

export function translationSettled(translation, source = "", targetLang = "zh-CN") {
  return translationLanded(translation, source, targetLang) || translationEcho(translation, source);
}

/** A short token (≤3 words, or no letters) may stay as written. A real sentence may not. */
export function sourceIsShortToken(source = "") {
  return translationUnchangedOk(source, source);
}

function translationSource(item) {
  return item?.original || item?.text || item?.sourceText || "";
}

function rowSettled(item, targetLang) {
  if (isLiveSlotRetranslate(item)) return false;
  const translation = item?.translation;
  const source = translationSource(item);
  if (item?.failed === true) return translationLanded(translation, source, targetLang);
  return translationSettled(translation, source, targetLang);
}

/**
 * Title-structure rows and body rows share one page state.
 * A failed structure batch stays failed even when its English source is still on screen.
 */
export function combinePageResults(structureRows, bodyResults, structureFailed = false) {
  const head = (Array.isArray(structureRows) ? structureRows : []).map((row) => (
    structureFailed || row?.failed === true ? { ...row, failed: true } : row
  ));
  const body = Array.isArray(bodyResults) ? bodyResults : [];
  if (!head.length) return body.slice();
  return [...head, ...body];
}

function foldedPairText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function savedHitCovers(block, index, targetLang) {
  const selected = selectSavedHit(block, index);
  if (!selected?.hit || selected.uncertain) return false;
  if (isLiveSlotRetranslate(selected.hit)) return false;
  if (savedPairNeedsRetranslate(block, selected.hit)) return false;
  const text = foldedPairText(block?.text || block?.sourceText || "");
  return translationSettled(
    selected.hit.translation,
    text || selected.hit.text || selected.hit.sourceText || "",
    targetLang
  );
}

/**
 * How many live blocks can reuse a saved pair. A unique normalized-source hash
 * counts. An identifier match counts only when the source text still agrees.
 * Conflicting hashes do not count. An echo of the source does: it was returned
 * and is kept. A later real translation of that source still wins.
 */
export function savedTranslationCoverage(pairs, blocks, targetLang = "zh-CN", provider = "") {
  const live = translatableBlocks(blocks);
  if (!live.length) return { live: 0, covered: 0 };
  const index = buildSavedPairIndex(Array.isArray(pairs) ? pairs : [], { targetLang, provider });
  let covered = 0;
  for (const block of live) {
    if (savedHitCovers(block, index, targetLang)) covered += 1;
  }
  return { live: live.length, covered };
}

/**
 * A library page is complete only when every live translatable block has its own
 * settled pair. One merged abstract_body does not cover the abstract paragraph
 * and the footnote once the layout splits them. An echo covers its own block.
 * A later real translation of the same source still wins.
 */
export function libraryCoversLiveBlocks(pairs, blocks, targetLang = "zh-CN", provider = "") {
  const stats = savedTranslationCoverage(pairs, blocks, targetLang, provider);
  return stats.live > 0 && stats.covered === stats.live;
}

/**
 * Done only when the library covers the live blocks, or when the caller has no
 * layout yet and a settled row is already stored. Skip-only and empty stay out
 * of the queue. A hole, including "fewer pairs than live blocks", is queued.
 */
export function libraryPageRunState({
  pairs = null,
  cached = null,
  skipped = false,
  empty = false,
  targetLang = "zh-CN",
  provider = "",
  blocks = null
} = {}) {
  if (skipped) return "skipped";
  if (Array.isArray(blocks)) {
    const live = translatableBlocks(blocks);
    if (!live.length) return empty ? "empty" : "skipped";
    const fromPairs = savedTranslationCoverage(pairs, blocks, targetLang, provider).covered;
    const fromCache = savedTranslationCoverage(cached, blocks, targetLang, provider).covered;
    let covered = 0;
    if (fromPairs === live.length || fromCache === live.length) covered = live.length;
    else {
      const pairIndex = buildSavedPairIndex(Array.isArray(pairs) ? pairs : [], { targetLang, provider });
      const cacheIndex = buildSavedPairIndex(Array.isArray(cached) ? cached : [], { targetLang, provider });
      for (const block of live) {
        if (savedHitCovers(block, pairIndex, targetLang) || savedHitCovers(block, cacheIndex, targetLang)) {
          covered += 1;
        }
      }
    }
    if (covered === live.length) return "done";
    if (covered > 0) return "partial";
    return "queued";
  }
  const rows = [
    ...(Array.isArray(pairs) ? pairs : []),
    ...(Array.isArray(cached) ? cached : [])
  ];
  const landed = rows.some((item) => (
    isFlowTranslationRole(item?.role || item?.label || "paragraph") &&
    rowSettled(item, targetLang)
  ));
  if (landed) return "done";
  if (empty) return "empty";
  return "queued";
}

/**
 * Queued and in-flight pages paint body text only after a settled translation
 * is cached, unless the caller is revealing source because translation is not
 * running. Otherwise translation||text would show library English as if it
 * were the translation. Layout and empty pages stay on their status line.
 */
export function shouldPaintPageBody({ state = "", hasSettled = false, revealSource = false } = {}) {
  if (state === "layout" || state === "empty") return false;
  if ((state === "queued" || state === "running") && !hasSettled && !revealSource) return false;
  return true;
}

/**
 * Freeze a slot only after its pair nodes exist. A queued page that is still
 * waiting for translation stays unstamped so a later pass can paint it.
 * Stamping that empty slot would make the next renderArticle skip the body.
 * Running and layout pages stay unstamped because their body is still changing.
 */
export function shouldStampPagePainted({ state = "", collapsed = false, hasLandedBody = false } = {}) {
  if (collapsed || state === "running" || state === "layout") return false;
  if (state === "queued" && !hasLandedBody) return false;
  return true;
}

/**
 * No landed translation is failed when the page had something to translate.
 * k < m is partial. partial still counts, and it still blocks 全文已译.
 * targetLang defaults to zh-CN, which still requires Han.
 */
export function pageRunState(results, options = {}) {
  const list = (Array.isArray(results) ? results : []).filter((item) => (
    isFlowTranslationRole(item?.role || item?.label || "paragraph")
  ));
  const targetLang = options.targetLang || "zh-CN";
  const long = list.filter((item) => !sourceIsShortToken(translationSource(item)));
  if (long.length && !long.some((item) => {
    const source = translationSource(item);
    return translationLanded(item?.translation, source, targetLang) || translationEcho(item?.translation, source);
  })) {
    const attempted = long.some((item) => item?.failed === true || String(item?.translation || "").trim());
    if (attempted) return "failed";
  }
  const landed = list.filter((item) => rowSettled(item, targetLang));
  const failed = list.some((item) => item?.failed === true);
  const expected = Math.max(0, Number(options.expected) || 0);
  const m = expected > 0 ? expected : list.length;
  const k = landed.length;
  if (k === 0) {
    const attempted = failed || list.some((item) => String(item?.translation || translationSource(item) || "").trim());
    if (attempted) return "failed";
    return "empty";
  }
  if (failed || k < m) return "partial";
  return "done";
}

/** failed and partial stay retranslatable even when the page has no live blocks. */
export function canRetranslatePage({
  state = "",
  translatableCount = 0,
  titleCandidate = false,
  originals = 0
} = {}) {
  if (state === "failed" || state === "partial") return true;
  if (Number(translatableCount) > 0) return true;
  if (titleCandidate) return true;
  return Number(originals) > 0;
}

/**
 * Apply one title-structure batch onto the viewer record.
 * A throw is a failure: the caller keeps translating later pages.
 */
export async function runTitleStructureBatch(record, run) {
  try {
    const outcome = await run();
    const results = outcome?.results || [];
    record.failed = Boolean(outcome?.error) || results.some((row) => row?.failed === true);
    record.translated = true;
    return outcome || { ok: false, error: "", results: [] };
  } catch (err) {
    record.failed = true;
    record.translated = true;
    return { ok: false, error: String(err?.message || err), thrown: true, results: [] };
  }
}

/** One line in the right pane while a full-document job is running. */
export function documentTranslatePlaceholder(page, total) {
  const n = Math.max(1, Number(total) || 1);
  const k = Math.min(n, Math.max(1, Number(page) || 1));
  return `正在翻译第 ${k}/${n} 页…`;
}

/**
 * Short status-bar copy when a PDF translation cannot start.
 * reason: runtime | missing-field | local-service, or a raw error string.
 */
export function pdfTranslateFailureCopy(input = {}) {
  const field = String(input?.field || input?.missingField || "").trim();
  const reason = String(input?.reason || "").trim();
  const raw = String(input?.error || input?.message || (typeof input === "string" ? input : reason) || "").trim();
  if (reason === "runtime" || /runtime unavailable/i.test(raw)) {
    return PDF_COPY.runtimeUnavailable;
  }
  if (reason === "missing-field" || field) {
    const name = field || "引擎密钥";
    return `无法翻译：还没填写${name}。打开设置 → 引擎，填好后重新打开 PDF。`;
  }
  if (
    reason === "local-service" ||
    /local PDF library unavailable|GLM-OCR|127\.0\.0\.1:8765|ECONNREFUSED|划区服务不可用/i.test(raw)
  ) {
    return "无法翻译：本机服务没启动。先启动 127.0.0.1:8765 上的本地库或 GLM-OCR，再重新打开 PDF。";
  }
  const detail = raw.replace(/\s+/g, " ").slice(0, 80);
  if (detail) return `无法翻译：${detail}。检查设置 → 引擎里的模型和密钥后再试。`;
  return "无法翻译：翻译服务没有响应。检查设置 → 引擎里的模型和密钥后再试。";
}

/** Empty string means the job may start. */
export function pdfOpenTranslateBlocker({
  runtimeReady = true,
  missingField = "",
  layoutMode = "text-layer",
  localServiceUp = true
} = {}) {
  if (!runtimeReady) return pdfTranslateFailureCopy({ reason: "runtime" });
  if (String(missingField || "").trim()) {
    return pdfTranslateFailureCopy({ reason: "missing-field", field: missingField });
  }
  if (layoutMode === "local-ocr" && localServiceUp === false) {
    return pdfTranslateFailureCopy({ reason: "local-service" });
  }
  return "";
}

/** Empty readout: idle hint, or in-progress wait. Hidden once any page has Chinese. */
export function readoutPlaceholder({ running, hasArticle } = {}) {
  if (hasArticle) return "";
  return running ? PDF_COPY.translatingWait : PDF_COPY.translateHint;
}

export function wheelPageDelta({
  deltaY,
  deltaX = 0,
  atTop,
  atBottom,
  overflow,
  gestureLatched = false
} = {}) {
  const dx = Number(deltaX) || 0;
  const dy = Number(deltaY) || 0;
  if (Math.abs(dx) > Math.abs(dy)) return 0;
  if (gestureLatched) return 0;
  if (overflow) return 0;
  if (dy > 0 && atBottom !== false) return 1;
  if (dy < 0 && atTop !== false) return -1;
  return 0;
}

export function isFlowTranslationRole(role) {
  const key = normalizeBlockRole(role);
  return key !== "formula" && key !== "figure";
}

export function pageHasTranslation(blocks, targetLang = "zh-CN") {
  return (blocks || []).some((item) => (
    isFlowTranslationRole(item?.role) &&
    rowSettled(item, targetLang)
  ));
}

export function pageTranslationComplete(blocks, targetLang = "zh-CN") {
  const list = (blocks || []).filter((item) => isFlowTranslationRole(item?.role));
  return list.length > 0 && list.every((item) => rowSettled(item, targetLang));
}

/** Retry a page that already failed or came back empty/same-as-source. Fresh placeholders do not. */
export function pageNeedsBypass(cached, targetLang = "zh-CN") {
  if (!Array.isArray(cached) || !cached.length) return false;
  if (pageTranslationComplete(cached, targetLang)) return false;
  return cached.some((item) => {
    if (rowSettled(item, targetLang)) return false;
    return item?.failed === true || Boolean(String(item?.translation || "").trim());
  });
}

export function collectArticlePages(cache, docId, numPages) {
  const total = Math.max(0, Number(numPages) || 0);
  const out = [];
  for (let page = 1; page <= total; page++) {
    const blocks = cache?.get(docId, page);
    if (!pageHasTranslation(blocks)) continue;
    out.push({ page, blocks });
  }
  return out;
}

export function pageFromViewport(rects, viewportTop, viewportBottom) {
  const list = Array.isArray(rects) ? rects : [];
  if (!list.length) return 1;
  const mid = (Number(viewportTop) + Number(viewportBottom)) / 2;
  let best = list[0].page;
  let bestDist = Infinity;
  for (const rect of list) {
    const center = (Number(rect.top) + Number(rect.bottom)) / 2;
    const dist = Math.abs(center - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = rect.page;
    }
  }
  return best;
}

export function neighborPages(current, total, radius = 1) {
  const t = Math.max(1, Number(total) || 1);
  const c = Math.min(t, Math.max(1, Number(current) || 1));
  const r = Math.max(0, Number(radius) || 0);
  const out = [];
  for (let page = c - r; page <= c + r; page++) {
    if (page >= 1 && page <= t) out.push(page);
  }
  return out;
}

export function readoutPageSelector(page) {
  return `[data-page="${page}"]`;
}

export function shouldSyncReadout(nodeTop, paneTop, slop = 80) {
  if (!Number.isFinite(Number(nodeTop)) || !Number.isFinite(Number(paneTop))) return false;
  const top = Number(nodeTop);
  const origin = Number(paneTop);
  return top < origin - 4 || top > origin + slop;
}

export function looksLikePdfUrl(url) {
  if (!url || typeof url !== "string") return false;
  const raw = url.trim();
  if (!raw) return false;
  if (/^data:application\/pdf/i.test(raw)) return true;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "chrome-extension:" && parsed.hostname === "mhjfbmdgcfjbbpaeojofohoefgiehjai") {
      return true;
    }
    const path = decodeURIComponent(parsed.pathname).toLowerCase();
    if (path.endsWith(".pdf")) return true;
    for (const key of ["filename", "file", "name"]) {
      if (/\.pdf$/i.test(parsed.searchParams.get(key) || "")) return true;
    }
    return /\.pdf(?:$|[?#])/i.test(parsed.href);
  } catch {
    return /\.pdf(?:$|[?#])/i.test(raw);
  }
}

export function isPdfViewerPage(url) {
  const raw = String(url || "");
  try {
    const path = new URL(raw).pathname;
    return path.endsWith("/pdf/viewer.html") || path.endsWith("pdf/viewer.html");
  } catch {
    return /pdf\/viewer\.html/i.test(raw);
  }
}

export function shouldOfferPdfOpen(url) {
  return looksLikePdfUrl(url) && !isPdfViewerPage(url);
}

export function viewerSearch(src) {
  const url = String(src || "").trim();
  return url ? `?src=${encodeURIComponent(url)}` : "";
}

export function readViewerSrc(search) {
  const query = String(search || "").replace(/^\?/, "");
  return new URLSearchParams(query).get("src") || "";
}

export function blockLocation({ filename, page } = {}) {
  const fileBit = String(filename || "").trim();
  const pageBit = page == null || page === "" ? "" : `p.${page}`;
  if (!fileBit && !pageBit) return "";
  return ["PDF", fileBit, pageBit].filter(Boolean).join(" · ");
}

export function favoriteSegmentItem({ original, translation, url, title, context, filename, page } = {}) {
  const loc = blockLocation({ filename, page });
  return {
    original: String(original || "").trim(),
    translation: String(translation || "").trim(),
    context: loc || String(context || original || "").trim(),
    url: url || "",
    title: title || loc
  };
}

export function normalizeBlockRole(role) {
  if (role === "title" || role === "h1") return "title";
  if (role === "heading" || role === "h2") return "heading";
  if (role === "authors" || role === "author") return "authors";
  if (role === "caption") return "caption";
  if (role === "formula") return "formula";
  if (role === "figure") return "figure";
  return "paragraph";
}

/** One article part: page title, section heading, or body paragraph. */
export function translationBlock({ original, translation, page, filename, role } = {}) {
  return {
    original: String(original || "").trim(),
    translation: String(translation || "").trim(),
    page: page == null ? "" : page,
    filename: String(filename || "").trim(),
    role: normalizeBlockRole(role)
  };
}

/** Map a translated block to a readout node (h1 / h2 / p). */
export function articleNodeSpec(block = {}) {
  const role = normalizeBlockRole(block.role);
  const text = String(block.translation || "").trim();
  if (role === "title") return { tag: "h1", className: "oi-pdf-h1", role, text };
  if (role === "heading") return { tag: "h2", className: "oi-pdf-h2", role, text };
  return { tag: "p", className: "oi-pdf-p", role, text };
}

/** File stem for `{basename}-译文.md|pdf`. URL path or local name; strips `.pdf`. */
export function pdfSourceBasename(nameOrUrl) {
  const raw = String(nameOrUrl || "").trim();
  if (!raw) return "PDF";
  let name = raw;
  try {
    name = decodeURIComponent(new URL(raw).pathname.split("/").filter(Boolean).pop() || raw);
  } catch {
    name = raw.split(/[/\\]/).filter(Boolean).pop() || raw;
  }
  name = String(name || "").replace(/\.pdf$/i, "").trim();
  return name || "PDF";
}

export function collectReadoutExportNodes(root) {
  if (!root?.querySelectorAll) return [];
  return [...root.querySelectorAll("h1, h2, p")]
    .map((el) => {
      if (el?.dataset?.label === "note") return null;
      const text = readoutNodeExportText(el);
      return {
        tag: String(el.tagName || "p").toLowerCase(),
        text
      };
    })
    .filter((node) => node?.text);
}

function readoutNodeExportText(el) {
  const label = el?.dataset?.label || el?.dataset?.role || "";
  const visual = label === "formula" || label === "figure" || label === "table" || el?.dataset?.kind === "math";
  const zh = typeof el?.querySelector === "function" ? el.querySelector(".rf-zh") : null;
  const host = zh || el;
  const img = typeof host?.querySelector === "function" ? host.querySelector("img") : host?.img || null;
  if (img?.src || visual) {
    if (img?.src) return visualBlockMarkdown({ alt: img.alt || "公式", src: img.src });
    if (visual) return visualBlockMarkdown({ alt: img?.alt || "公式", src: "" });
  }
  const children = host?.childNodes;
  if (children?.length) {
    let out = "";
    for (const child of children) {
      const tag = String(child?.tagName || "").toUpperCase();
      if (child?.nodeType === 3 || (!tag && child?.textContent != null && child?.src == null)) {
        out += child.textContent || "";
      } else if (tag === "IMG" || child?.src) {
        out += visualBlockMarkdown({ alt: child.alt || "公式", src: child.src || "" });
      }
    }
    const text = out.replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return String(host?.textContent || "").trim();
}

export function pdfExportControlState({ hasDoc = false, hasReadout = false, exporting = false } = {}) {
  const disabled = !hasDoc || !hasReadout || Boolean(exporting);
  return {
    mdDisabled: disabled,
    pdfDisabled: disabled,
    exporting: Boolean(exporting)
  };
}

/** M2 hook: save a translated PDF block through the existing learning API. */
export async function favoriteSegment(item, send = globalThis.chrome?.runtime?.sendMessage) {
  const payload = favoriteSegmentItem(item);
  if (!payload.original) return { ok: false, error: "缺少原文" };
  if (typeof send !== "function") return { ok: false, error: "runtime unavailable" };
  return send({ type: "OI_SAVE_LEARNING", item: payload });
}

export function pagePath(page) {
  if (page === "documents") return "documents/documents.html";
  if (page === "learning") return "learning/learning.html";
  if (page === "pdf") return "pdf/viewer.html";
  return "";
}

export function pageCacheKey(docId, page) {
  return `${docId}::${page}`;
}

export function createPageCache() {
  const map = new Map();
  return {
    get(docId, page) {
      return map.get(pageCacheKey(docId, page)) || null;
    },
    set(docId, page, blocks) {
      map.set(pageCacheKey(docId, page), blocks);
    },
    has(docId, page) {
      return map.has(pageCacheKey(docId, page));
    },
    clearPage(docId, page) {
      map.delete(pageCacheKey(docId, page));
    },
    clear() {
      map.clear();
    }
  };
}

export function createTranslateSession() {
  return { running: false, aborted: false, inflight: null };
}

/** Scheme B (same as webpage FAB): 停止 only while a job is busy. */
export function pdfTranslateBusy(session) {
  return Boolean(session?.running);
}

export function pdfTranslatePrimaryLabel(busy) {
  return busy ? PDF_COPY.stop : PDF_COPY.translate;
}

export function pdfToolbarActionState({
  busy = false,
  hasDoc = false,
  canTranslate = false,
  canRetranslate = false
} = {}) {
  const on = Boolean(busy);
  return {
    primary: on ? "stop" : "translate",
    translateHidden: on,
    stopHidden: !on,
    translateDisabled: !hasDoc || !canTranslate || on,
    retranslateDisabled: !hasDoc || !canRetranslate || on,
    stopDisabled: !on
  };
}

/** Current-page force retranslate: every translatable block, never skipTranslate. */
export function blocksForForceRetranslate(blocks) {
  return translatableBlocks(blocks);
}

/**
 * aborted: user stop, do not write.
 * success: at least one new translation, caller may overwrite the page.
 * failed: nothing landed, caller keeps the previous readout and does not write.
 */
export function forceRetranslateOutcome({ aborted = false, results = [], structureLanded = false } = {}) {
  if (aborted) return "aborted";
  const list = results || [];
  if (list.length && list.every((item) => String(item?.translation || "").trim())) return "success";
  if (!list.length && structureLanded) return "success";
  return "failed";
}

export function abortTranslateSession(session) {
  if (!session) return;
  session.aborted = true;
  session.running = false;
  session.inflight = null;
}

export function shouldApplyDraft(session, message) {
  if (!session?.inflight || message?.phase !== "draft") return false;
  if (message.requestId && session.inflight.requestId && message.requestId !== session.inflight.requestId) {
    return false;
  }
  return true;
}

/**
 * Bind a batch response to the bids that were requested.
 * A list of {bid, translation} may arrive in any order.
 * A parallel string array belongs to the request slot at that index, then to that slot's bid.
 * A bid that was not requested is dropped. It is never given to another block.
 */
export function translationsByBid(response, requestItems = []) {
  const requested = new Map();
  (requestItems || []).forEach((item, index) => {
    const bid = String(item?.bid || "");
    if (!bid || requested.has(bid)) return;
    requested.set(bid, index);
  });
  const out = new Map();
  const accept = (bid, translation) => {
    const key = String(bid || "");
    const text = String(translation ?? "").trim();
    if (!key || !text || !requested.has(key) || out.has(key)) return;
    out.set(key, text);
  };
  const translations = response?.translations;
  if (translations && typeof translations === "object" && !Array.isArray(translations)) {
    for (const [bid, translation] of Object.entries(translations)) accept(bid, translation);
    return out;
  }
  const list = Array.isArray(translations) ? translations : [];
  if (list.some((item) => item && typeof item === "object" && item.bid)) {
    for (const item of list) accept(item?.bid, item?.translation ?? item?.text);
    return out;
  }
  list.forEach((translation, index) => {
    const bid = requestItems[index]?.bid;
    accept(bid, translation);
  });
  return out;
}

export function applyDraftTranslations(session, message, results) {
  if (!shouldApplyDraft(session, message)) return results;
  const items = session.inflight.items || [];
  const next = Array.isArray(results) ? results.slice() : [];
  if (items.some((item) => item?.bid)) {
    const bound = translationsByBid(message, items);
    let changed = false;
    for (let index = 0; index < next.length; index += 1) {
      const bid = String(next[index]?.bid || "");
      if (!bid || !bound.has(bid)) continue;
      if (rowSettled(next[index], "zh-CN")) continue;
      next[index] = { ...next[index], translation: bound.get(bid) };
      changed = true;
    }
    return changed ? next : results;
  }
  const translations = message.translations || [];
  const { slice, sliceStart } = session.inflight;
  (slice || []).forEach((original, idx) => {
    const translation = typeof translations[idx] === "string" ? translations[idx] : (translations[idx]?.translation || "");
    if (!translation) return;
    const at = sliceStart + idx;
    const prior = next[at] || {};
    if (rowSettled(prior, "zh-CN")) return;
    next[at] = { ...prior, original, translation };
  });
  return next;
}

/**
 * One open sends each block once. A later pass in the same session sees the
 * bid and source hash already claimed and does not submit them again.
 */
export function claimTranslationUnits(units, sent) {
  const fresh = [];
  const seen = sent || new Map();
  for (const unit of units || []) {
    const bid = String(unit?.bid || "");
    const hash = sourceReuseHash(unit?.sourceText || unit?.text || unit?.original || "");
    if (bid && seen.get(bid) === hash) continue;
    if (bid) seen.set(bid, hash);
    fresh.push(unit);
  }
  return fresh;
}

/** Blocks that still need a request. A settled reuse, including an echo, stays out. */
export function unitsNeedingTranslation(units, targetLang = "zh-CN") {
  return (units || []).filter((unit) => {
    if (!unit || unit.skipTranslate === true) return false;
    const source = unit.original || unit.text || unit.sourceText || "";
    if (!String(source).trim()) return false;
    if (isLiveSlotRetranslate(unit)) return true;
    if (unit.failed === true) return !translationLanded(unit.translation, source, targetLang);
    return !translationSettled(unit.translation, source, targetLang);
  });
}

function translationRowKey(row) {
  const bid = String(row?.bid || "");
  if (bid) return `b:${bid}`;
  const id = String(row?.id || "");
  if (id) return `i:${id}`;
  return "";
}

/** A settled row keeps its translation. A retry may fill a hole, not replace it. */
function keepSettledTranslation(prior, incoming, targetLang) {
  if (!rowSettled(prior, targetLang)) return false;
  const nextText = String(incoming?.translation || "").trim();
  if (!nextText) return true;
  return nextText !== String(prior?.translation || "").trim();
}

/**
 * Overlay a batch onto rows already reused from the library.
 * Match by bid, then by an explicit block id. Rows with neither are dropped.
 * The incoming array never replaces the page by position.
 * A block that already has a settled translation is left as it is.
 */
export function mergeTranslationRows(prior, incoming, targetLang = "zh-CN") {
  const next = Array.isArray(incoming) ? incoming.slice() : [];
  const prev = Array.isArray(prior) ? prior : [];
  if (!prev.length) return next;
  if (!next.length) return prev.slice();
  const incomingByKey = new Map();
  for (const row of next) {
    const key = translationRowKey(row);
    if (key) incomingByKey.set(key, row);
  }
  if (!incomingByKey.size) return prev.slice();
  const seen = new Set();
  const merged = prev.map((row) => {
    const key = translationRowKey(row);
    const hit = key ? incomingByKey.get(key) : undefined;
    if (!hit) return row;
    seen.add(key);
    if (keepSettledTranslation(row, hit, targetLang)) return row;
    const mergedRow = { ...row, ...hit };
    if (hit.failed !== true) delete mergedRow.failed;
    if (!isLiveSlotRetranslate(hit) && String(hit.translation || "").trim()) {
      if (mergedRow.status === "retranslate") delete mergedRow.status;
      if (mergedRow.translationStatus === "retranslate") delete mergedRow.translationStatus;
    }
    return mergedRow;
  });
  for (const row of next) {
    const key = translationRowKey(row);
    if (key && !seen.has(key)) merged.push(row);
  }
  return merged;
}

export async function translatePageBlocks(originals, options = {}) {
  const units = normalizeTranslateUnits(originals);
  const texts = units.map((unit) => unit.original);
  const session = options.session || createTranslateSession();
  const send = options.send;
  const size = Math.max(1, Number(options.batchSize) || 8);
  const preserveSession = Boolean(options.preserveSession);
  const results = units.map((unit) => ({ ...unit, translation: "" }));
  session.running = true;
  if (!preserveSession) session.aborted = false;
  if (typeof send !== "function") {
    if (!preserveSession) session.running = false;
    return { ok: false, error: "runtime unavailable", results };
  }
  if (preserveSession && session.aborted) {
    return { ok: false, aborted: true, results };
  }
  try {
    for (let i = 0; i < texts.length; i += size) {
      if (session.aborted) break;
      const sliceUnits = units.slice(i, i + size);
      const slice = sliceUnits.map((unit) => unit.original);
      const items = sliceUnits.map((unit) => ({
        bid: String(unit.bid || ""),
        text: unit.original,
        sourceText: String(unit.sourceText || unit.original || ""),
        sourceHash: sourceReuseHash(unit.sourceText || unit.original || "")
      }));
      const requestId = options.requestIdFor?.(i) || `pdf-${i}-${Date.now()}`;
      session.inflight = { requestId, slice, sliceStart: i, items };
      options.onBatchStart?.({ index: i, total: texts.length, requestId, slice });
      let res = { ok: false, translations: [] };
      try {
        res = (await send({
          type: "OI_TRANSLATE_BATCH",
          texts: slice,
          items,
          requestId,
          promptAddendum: PDF_PROMPT_ADDENDUM,
          ...(options.bypassCache ? { bypassCache: true } : {})
        })) || res;
      } catch (err) {
        res = { ok: false, translations: [], error: String(err?.message || err) };
      }
      if (session.inflight?.requestId === requestId) session.inflight = null;
      if (session.aborted) break;
      const batchFailed = res.ok === false || Boolean(res.error);
      const bound = translationsByBid(res, items);
      const keyed = Array.isArray(res.translations) && res.translations.some((item) => item && typeof item === "object" && item.bid);
      sliceUnits.forEach((unit, idx) => {
        const existing = results[i + idx];
        const bid = String(unit.bid || "");
        let translation = "";
        let missed = false;
        if (batchFailed) translation = existing.translation || "";
        else if (bid && bound.has(bid)) translation = bound.get(bid);
        else if (!bid && !keyed) translation = String(res.translations?.[idx] || "");
        else {
          translation = existing.translation || "";
          missed = Boolean(bid);
        }
        const displayRetry = isLiveSlotRetranslate(existing);
        const keepFailed = batchFailed || missed || (existing.failed === true && !displayRetry);
        const row = {
          ...existing,
          original: unit.original,
          translation,
          role: existing.role || unit.role
        };
        if (keepFailed) row.failed = true;
        else delete row.failed;
        if (!batchFailed && !missed && String(translation || "").trim()) {
          if (row.status === "retranslate") delete row.status;
          if (row.translationStatus === "retranslate") delete row.translationStatus;
        }
        results[i + idx] = row;
      });
      options.onBatchResult?.({ results: results.slice(), res, sliceStart: i, requestId });
      if (res.error) {
        return {
          ok: false,
          aborted: session.aborted,
          error: String(res.error),
          missingField: res.missingField || "",
          results
        };
      }
    }
    return {
      ok: !session.aborted,
      aborted: session.aborted,
      error: "",
      results
    };
  } finally {
    session.inflight = null;
    if (!preserveSession) session.running = false;
  }
}

export async function translateDocumentPages(options = {}) {
  const session = options.session || createTranslateSession();
  const cache = options.cache;
  const docId = options.docId;
  const numPages = Math.max(0, Number(options.numPages) || 0);
  const skipCached = options.skipCached !== false;
  const targetLang = options.targetLang || "zh-CN";
  const pages = [];
  let wholePageFailures = 0;
  session.running = true;
  if (options.preserveSession !== true) session.aborted = false;
  try {
    for (let page = 1; page <= numPages; page++) {
      if (session.aborted) break;
      if (typeof options.includePage === "function" && !options.includePage(page)) continue;
      if (typeof options.preparePage === "function") {
        const prep = await options.preparePage(page);
        if (session.aborted) break;
        if (prep === "stop") break;
        if (prep === "skip") {
          const adopted = cache?.get(docId, page);
          pages.push({ page, results: adopted, skipped: true, reason: "cached" });
          options.onPageSkip?.({ page, reason: "cached" });
          wholePageFailures = 0;
          continue;
        }
      }
      const cached = cache?.get(docId, page);
      if (skipCached && pageTranslationComplete(cached, targetLang)) {
        pages.push({ page, results: cached, skipped: true, reason: "cached" });
        options.onPageSkip?.({ page, reason: "cached" });
        wholePageFailures = 0;
        continue;
      }
      options.onPageStart?.({ page, total: numPages });
      const originals = (await options.getPageOriginals?.(page)) || [];
      if (session.aborted) break;
      if (!originals.length) {
        const hinted = options.pageSkipReason?.(page);
        const reason = hinted === "skip-only" || hinted === "cached" ? hinted : "empty";
        pages.push({ page, results: cache?.get(docId, page) || [], skipped: true, reason });
        options.onPageSkip?.({ page, reason });
        wholePageFailures = 0;
        continue;
      }
      const retryBypass = options.bypassCache === true || pageNeedsBypass(cached, targetLang);
      const translated = await translatePageBlocks(originals, {
        send: options.send,
        session,
        batchSize: options.batchSize,
        preserveSession: true,
        bypassCache: retryBypass,
        requestIdFor: options.requestIdFor && ((index) => options.requestIdFor(page, index)),
        onBatchStart: options.onBatchStart,
        onBatchResult: (payload) => {
          const merged = mergeTranslationRows(cache?.get(docId, page), payload.results, targetLang);
          cache?.set(docId, page, merged);
          options.onPageResult?.({ page, ...payload, results: merged });
        }
      });
      const { aborted, results, error, missingField } = translated;
      const merged = mergeTranslationRows(cache?.get(docId, page), results, targetLang);
      cache?.set(docId, page, merged);
      pages.push({ page, results: merged, skipped: false, error: error || "", missingField: missingField || "" });
      const state = pageRunState(merged, { targetLang });
      const whole = state === "failed";
      if (whole) wholePageFailures += 1;
      else wholePageFailures = 0;
      if (whole || error) options.onPageError?.({ page, results: merged, aborted, error: error || "", missingField: missingField || "" });
      else options.onPageDone?.({ page, results: merged, aborted, error: "" });
      if (aborted || wholePageFailures >= 3) break;
    }
    const stopped = wholePageFailures >= 3;
    const failure = stopped ? pages.find((entry) => entry.error) : null;
    return {
      ok: !session.aborted && !stopped,
      aborted: session.aborted,
      paused: stopped,
      error: failure?.error || "",
      missingField: failure?.missingField || "",
      pages
    };
  } finally {
    session.inflight = null;
    if (options.preserveSession !== true) session.running = false;
  }
}

export function extractPageItems(textContent) {
  return (textContent?.items || []).map(normalizePdfItem).filter((item) => item.str);
}

/** Lines in reading order, each still carrying its text items. */
export function readingOrderLines(rawItems) {
  const items = (Array.isArray(rawItems) ? rawItems : []).map(normalizePdfItem).filter((item) => item.str);
  if (!items.length) return [];
  const splitX = detectItemColumnSplit(items);
  const lines = clusterLines(items, splitX);
  if (!lines.length) return [];
  if (splitX == null) return lines;
  const pageLeft = Math.min(...lines.map((line) => line.x));
  const pageRight = Math.max(...lines.map((line) => line.x + line.width));
  const pageWidth = Math.max(1, pageRight - pageLeft);
  const ordered = [];
  let left = [];
  let right = [];
  const flushCols = () => {
    ordered.push(...left, ...right);
    left = [];
    right = [];
  };
  for (const line of lines) {
    const full = line.width > pageWidth * 0.6 && line.x < splitX && line.x + line.width > splitX;
    if (full) {
      flushCols();
      ordered.push(line);
    } else if (line.x + line.width / 2 < splitX) {
      left.push(line);
    } else {
      right.push(line);
    }
  }
  flushCols();
  return ordered;
}

/** Paragraphs for one run of prose lines. `statsLines` keeps heading size relative to the whole page. */
export function paragraphsFromLines(lines, statsLines = lines, options = {}) {
  if (!lines?.length) return [];
  return linesToParagraphs(lines, pageLineStats(statsLines?.length ? statsLines : lines),
    options.preserveLineHyphens === true);
}

export function segmentPageBlocks(input) {
  const items = Array.isArray(input) ? input.map(normalizePdfItem).filter((item) => item.str) : extractPageItems(input);
  if (!items.length) return [];
  const splitX = detectItemColumnSplit(items);
  const lines = clusterLines(items, splitX);
  if (!lines.length) return [];
  const pageLeft = Math.min(...lines.map((line) => line.x));
  const pageRight = Math.max(...lines.map((line) => line.x + line.width));
  const pageWidth = Math.max(1, pageRight - pageLeft);
  return readingOrder(lines, splitX, pageWidth).filter((block) => (block.text || "").length > 1);
}

export function normalizeTranslateUnits(originals) {
  return (originals || [])
    .map((item) => {
      if (item && typeof item === "object") {
        const extra = {};
        if (item.rect) extra.rect = item.rect;
        if (item.kind) extra.kind = item.kind;
        if (item.id) extra.id = item.id;
        if (item.bid) extra.bid = item.bid;
        if (item.sourceId) extra.sourceId = item.sourceId;
        if (item.sourceText) extra.sourceText = item.sourceText;
        if (item.label) extra.label = item.label;
        if (item.pageWidth) extra.pageWidth = item.pageWidth;
        if (item.pageHeight) extra.pageHeight = item.pageHeight;
        return {
          original: String(item.text || item.original || "").trim(),
          role: normalizeBlockRole(item.role),
          ...extra
        };
      }
      return { original: String(item || "").trim(), role: "paragraph" };
    })
    .filter((item) => item.original);
}

function normalizePdfItem(item) {
  if (!item || typeof item !== "object") {
    return { str: "", x: 0, y: 0, width: 0, height: 0, hasEOL: false, bold: false, fontName: "" };
  }
  const transform = Array.isArray(item.transform) ? item.transform : [];
  return {
    str: String(item.str || ""),
    x: Number.isFinite(Number(item.x)) ? Number(item.x) : Number(transform[4]) || 0,
    y: Number.isFinite(Number(item.y)) ? Number(item.y) : Number(transform[5]) || 0,
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    hasEOL: Boolean(item.hasEOL),
    bold: itemLooksBold(item),
    fontName: String(item.fontName || ""),
    sourceIndex: Number.isInteger(item.sourceIndex) ? item.sourceIndex : undefined
  };
}

function itemLooksBold(item) {
  if (item?.bold === true) return true;
  const font = String(item?.fontName || "");
  return /bold|black|heavy|semibold/i.test(font);
}

function detectItemColumnSplit(items) {
  if (items.length < 6) return null;
  const minX = Math.min(...items.map((item) => item.x));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const pageWidth = Math.max(1, maxX - minX);
  const gutters = [];
  for (const group of clusterYGroups(items)) {
    const sorted = [...group].sort((a, b) => a.x - b.x);
    if (sorted.length < 2) continue;
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width);
      const mid = sorted[i - 1].x + sorted[i - 1].width + gap / 2;
      const rel = (mid - minX) / pageWidth;
      if (rel > 0.25 && rel < 0.75) {
        const left = sorted.slice(0, i);
        const right = sorted.slice(i);
        const leftSpan = sorted[i - 1].x + sorted[i - 1].width - left[0].x;
        const rightSpan = right.at(-1).x + right.at(-1).width - right[0].x;
        const substantive = leftSpan > pageWidth * 0.22 && rightSpan > pageWidth * 0.22 &&
          left.map((item) => item.str).join("").trim().length >= 18 &&
          right.map((item) => item.str).join("").trim().length >= 18;
        if (substantive) gaps.push({ gap, mid });
      }
    }
    if (!gaps.length) continue;
    gaps.sort((a, b) => b.gap - a.gap);
    const top = gaps[0];
    const second = gaps[1]?.gap || 0;
    if (top.gap > Math.max(16, pageWidth * 0.045) && top.gap > second * 1.5) gutters.push(top.mid);
  }
  if (gutters.length < 2) return null;
  const sorted = [...gutters].sort((a, b) => a - b);
  let best = 0;
  let splitX = null;
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j < sorted.length && sorted[j] - sorted[i] <= 24) j += 1;
    const count = j - i;
    if (count > best) {
      best = count;
      const slice = sorted.slice(i, j);
      splitX = slice.reduce((sum, value) => sum + value, 0) / slice.length;
    }
  }
  return best >= 2 ? splitX : null;
}

function clusterYGroups(items) {
  const sorted = [...items].sort((a, b) => {
    const tol = Math.max(2, Math.max(a.height || 0, b.height || 0) * 0.45);
    if (Math.abs(a.y - b.y) > tol) return b.y - a.y;
    return a.x - b.x;
  });
  const groups = [];
  let bucket = [];
  let y = null;
  let height = 0;
  for (const item of sorted) {
    const tol = Math.max(2, (item.height || height || 10) * 0.45);
    if (y == null || Math.abs(item.y - y) <= tol) {
      bucket.push(item);
      y = y == null ? item.y : (y * (bucket.length - 1) + item.y) / bucket.length;
      height = Math.max(height, item.height || 0);
    } else {
      groups.push(bucket);
      bucket = [item];
      y = item.y;
      height = item.height || 0;
    }
  }
  if (bucket.length) groups.push(bucket);
  return groups;
}

function clusterLines(items, splitX = null) {
  const sorted = [...items].sort((a, b) => {
    const tol = Math.max(2, Math.max(a.height || 0, b.height || 0) * 0.45);
    if (Math.abs(a.y - b.y) > tol) return b.y - a.y;
    return a.x - b.x;
  });
  const lines = [];
  let bucket = [];
  let y = null;
  let height = 0;
  const flush = () => {
    if (!bucket.length) return;
    splitLineBucket(bucket, splitX).forEach((part) => lines.push(finalizeLine(part)));
    bucket = [];
    y = null;
    height = 0;
  };
  for (const item of sorted) {
    const tol = Math.max(2, (item.height || height || 10) * 0.45);
    if (y == null || Math.abs(item.y - y) <= tol) {
      bucket.push(item);
      y = y == null ? item.y : (y * (bucket.length - 1) + item.y) / bucket.length;
      height = Math.max(height, item.height || 0);
    } else {
      flush();
      bucket.push(item);
      y = item.y;
      height = item.height || 0;
    }
  }
  flush();
  return lines.filter((line) => line.text);
}

function finalizeLine(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let text = "";
  let prev = null;
  for (const item of sorted) {
    if (prev) {
      const gap = item.x - (prev.x + prev.width);
      const spaceWidth = Math.max(prev.height || 0, item.height || 0, 8) * 0.22;
      if (gap > spaceWidth && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
    }
    text += item.str;
    prev = item;
  }
  return {
    text: text.replace(/\s+/g, " ").trim(),
    x: Math.min(...sorted.map((item) => item.x)),
    y: median(sorted.map((item) => item.y)),
    width: Math.max(...sorted.map((item) => item.x + item.width)) - Math.min(...sorted.map((item) => item.x)),
    height: Math.max(...sorted.map((item) => item.height || 0)),
    bold: sorted.some((item) => item.bold),
    fontName: sorted.map((item) => item.fontName).find((name) => /CM(MI|SY|EX)|Math|Symbol/i.test(name || "")) || sorted[0]?.fontName || "",
    math: sorted.some((item) => looksLikeFormulaItem(item)),
    items: sorted
  };
}

function splitLineBucket(items, splitX) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  if (sorted.length < 2) return [sorted];
  if (splitX != null) {
    const left = sorted.filter((item) => item.x + item.width / 2 < splitX);
    const right = sorted.filter((item) => item.x + item.width / 2 >= splitX);
    return [left, right].filter((part) => part.length);
  }
  const minX = sorted[0].x;
  const maxX = Math.max(...sorted.map((item) => item.x + item.width));
  const width = Math.max(1, maxX - minX);
  let bestGap = 0;
  let at = -1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width);
    if (gap > bestGap) {
      bestGap = gap;
      at = i;
    }
  }
  if (at > 0 && bestGap > Math.max(20, width * 0.1)) {
    return [sorted.slice(0, at), sorted.slice(at)];
  }
  return [sorted];
}

function readingOrder(lines, splitX, pageWidth) {
  const stats = pageLineStats(lines);
  if (splitX == null) return linesToParagraphs(lines, stats);
  const blocks = [];
  let left = [];
  let right = [];
  const flushCols = () => {
    blocks.push(...linesToParagraphs(left, stats));
    blocks.push(...linesToParagraphs(right, stats));
    left = [];
    right = [];
  };
  for (const line of lines) {
    const full = line.width > pageWidth * 0.6 && line.x < splitX && line.x + line.width > splitX;
    if (full) {
      flushCols();
      blocks.push(...linesToParagraphs([line], stats));
    } else if (line.x + line.width / 2 < splitX) {
      left.push(line);
    } else {
      right.push(line);
    }
  }
  flushCols();
  return blocks;
}

function pageLineStats(lines) {
  const heights = lines.map((line) => line.height).filter((h) => h > 0);
  const medianH = typicalHeight(heights);
  const leadings = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const lead = lines[i].y - lines[i + 1].y;
    if (lead > 0) leadings.push(lead);
  }
  leadings.sort((a, b) => a - b);
  const medianLead = leadings[Math.floor(leadings.length / 2)] || medianH * 1.2;
  const body = lines.filter((line) => line.height <= medianH * 1.45);
  const widths = body.map((line) => line.width).sort((a, b) => a - b);
  const medianW = widths[Math.floor(widths.length / 2)] || lines[0]?.width || 200;
  const maxH = Math.max(0, ...heights);
  return { medianH, medianW, medianLead, maxH };
}

function linesToParagraphs(lines, sharedStats, preserveLineHyphens = false) {
  if (!lines.length) return [];
  const stats = sharedStats || pageLineStats(lines);
  const { medianH, medianW, medianLead } = stats;
  const paras = [];
  let buf = [];
  const flush = (role) => {
    if (!buf.length) return;
    const text = joinHyphenated(buf.map((line) => line.text), preserveLineHyphens);
    if (text.length > 1) {
      paras.push({
        text,
        role: normalizeBlockRole(role),
        kind: role === "formula" ? "math" : "text",
        fontName: buf[0]?.fontName || "",
        sourceItems: buf.flatMap((line) => line.items || [])
      });
    }
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const role = isFormulaLine(line) ? "formula" : headingRole(line, next, stats);
    const nextRole = next ? (isFormulaLine(next) ? "formula" : headingRole(next, lines[i + 2], stats)) : "paragraph";
    if (role === "formula") {
      if (buf.length) flush(isFormulaLine(buf[0]) ? "formula" : headingRole(buf[0], line, stats));
      buf.push(line);
      flush("formula");
      continue;
    }
    buf.push(line);
    if (!next) {
      flush(role);
      break;
    }
    if (nextRole === "formula") {
      flush(role);
      continue;
    }
    const gap = line.y - next.y;
    const largeGap = gap > medianLead * 1.45 || gap > medianH * 3;
    const shortEnd = role === "paragraph" && line.width < medianW * 0.72 && /[.!?:]$/.test(line.text);
    const sameHeadingBand =
      role !== "paragraph" &&
      role === nextRole &&
      Math.abs(line.height - next.height) <= Math.max(1, medianH * 0.2);
    const keepHeading = sameHeadingBand && !largeGap;
    if (keepHeading) continue;
    if (largeGap || shortEnd || role !== "paragraph" || nextRole !== "paragraph") flush(role);
  }
  return paras;
}

function typicalHeight(heights) {
  const list = (heights || []).filter((h) => h > 0).sort((a, b) => a - b);
  if (!list.length) return 12;
  const counts = new Map();
  for (const h of list) {
    const key = Math.round(h);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = list[Math.floor(list.length / 2)];
  let bestN = 0;
  for (const [h, n] of counts) {
    if (n > bestN || (n === bestN && h < best)) {
      bestN = n;
      best = h;
    }
  }
  return best;
}

function isFormulaLine(line) {
  if (!line?.text) return false;
  if (line.math) return true;
  if (looksLikeFormulaItem({ str: line.text, fontName: line.fontName || "" })) return true;
  return /=/.test(line.text) && /\b(softmax|LayerNorm|Attention)\b/.test(line.text) && line.text.length < 160;
}

function headingRole(line, next, stats) {
  if (!isHeadingLine(line, next, stats)) return "paragraph";
  return isPageTitleLine(line, stats) ? "title" : "heading";
}

function isPageTitleLine(line, stats) {
  const { medianH, maxH } = stats;
  const words = line.text.split(/\s+/).filter(Boolean);
  const titleLike = words.length <= 14 && !/[.!?]$/.test(line.text);
  if (!titleLike) return false;
  const veryLarge = line.height > medianH * 1.55;
  const largest = maxH > 0 && line.height >= maxH * 0.95 && line.height > medianH * 1.35;
  return veryLarge || largest;
}

function isHeadingLine(line, next, stats) {
  const { medianH } = stats;
  if (!line?.text) return false;
  if (/[A-Za-z]-$/.test(line.text)) return false;
  if (/^[a-z]/.test(line.text)) return false;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(line.text)) return false;
  const endsSentence = /[.!?]$/.test(line.text);
  if (endsSentence && line.text.length > 40) return false;
  const words = line.text.split(/\s+/).filter(Boolean);
  const short = words.length <= 12 && line.text.length <= 72 && !endsSentence;
  const larger = line.height > medianH * 1.28;
  const allCaps = looksAllCaps(line.text);
  const cue = larger || line.bold || allCaps;
  if (cue && short) return true;
  if (cue && !endsSentence && words.length <= 14) return true;
  const nextIsLongBody = next && next.text.length >= 40 && !looksAllCaps(next.text) && next.height <= medianH * 1.15;
  return Boolean(short && nextIsLongBody && words.length <= 6);
}

function looksAllCaps(text) {
  const letters = String(text || "").replace(/[^A-Za-z\u4e00-\u9fff]/g, "");
  return letters.length >= 3 && letters === letters.toUpperCase() && /[A-Z]/.test(letters);
}

function joinHyphenated(lineTexts, preserveLineHyphens = false) {
  let out = "";
  for (let i = 0; i < lineTexts.length; i++) {
    const line = lineTexts[i];
    const next = lineTexts[i + 1];
    if (next && /[A-Za-z]-$/.test(line) && /^[a-z]/.test(next)) {
      out += preserveLineHyphens ? line : line.slice(0, -1);
    } else {
      out += line;
      if (next) out += " ";
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

function median(values) {
  const list = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return 0;
  return list[Math.floor(list.length / 2)];
}
