/** PDF Viewer V1 — page/document translate goes through OI_TRANSLATE_BATCH. */

import { noteTranslateException } from "./diag-log.js";
import { pageCountsAsTranslated } from "./library-record.js";
import { PDF_PROMPT_ADDENDUM, translatableBlocks, visualBlockMarkdown } from "./pdf-blocks.js";
import { blocksOutsideStructure } from "./pdf-structure-render.js";
import { structureTranslateSlots } from "./pdf-structure-schema.js";
import { applyFormulaVerdict } from "./formula-pipeline.js";
import { buildSavedPairIndex, isLiveSlotRetranslate, savedPairNeedsRetranslate, selectSavedHit, sourceReuseHash, stripUserVisibleSlots } from "./pdf-library.js";
import { gapNeedsSpace, looksLikeFormulaItem } from "./pdf-mirror.js";

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
  staleFormula: "这页译文来自旧的公式识别",
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
  if (layout?.kind === "blocks") {
    if (layout.textSource === "ocr") return true;
    return Boolean(layout.blocks?.length);
  }
  // The layout cache stores an mm page without `kind`. Those blocks are still
  // the page. Falling through to library pairs paints every label as text.
  return String(layout?.mode || "") === "mm-page" && Boolean(layout?.blocks?.length);
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

const NULL_LAYOUT_QUEUE_REASONS = new Set(["stopped", "stale", "aborted", "engine", "epoch"]);

/**
 * noText is the "本页没有文字层" flag.
 * It is true only after a text layer was actually read and itemCount is 0.
 * A null layout (aborted, stale, stopped, engine switch) is not that case.
 */
export function pageNoText(layout) {
  if (!layout || typeof layout !== "object") return false;
  if (layout.itemCount == null || layout.itemCount === "") return false;
  const count = Number(layout.itemCount);
  return Number.isFinite(count) && count === 0;
}

/** Why originals came back without a layout. Interruptions stay queued. */
export function layoutMissReasonFor({
  stopped = false,
  stale = false,
  aborted = false,
  engineChanged = false,
  offline = false
} = {}) {
  if (stopped || aborted) return "aborted";
  if (engineChanged || stale) return "stale";
  if (offline) return "epoch";
  return "empty";
}

/**
 * A null layout is queued or failed, never empty.
 * empty is inside the translated set, so a missing OCR layout must not land there.
 * noText stays false until a real text layer reports itemCount === 0.
 */
export function settleUnsentPage({ layout = null, reason = "", skip = "" } = {}) {
  if (skip === "cached") {
    return { state: "done", noText: false, hasLayout: true, diagState: "translated", diagReason: "cached" };
  }
  if (skip === "skip-only") {
    return { state: "skipped", noText: false, hasLayout: true, diagState: "translated", diagReason: "skip-only" };
  }
  if (layout == null) {
    const raw = String(reason || "empty");
    if (raw === "library-empty") {
      return {
        state: "queued",
        noText: false,
        hasLayout: false,
        diagState: "empty-layout",
        diagReason: "library-empty"
      };
    }
    const why = raw.startsWith("layout-null:") ? raw : layoutNullReason(raw);
    const suffix = why.slice("layout-null:".length);
    const queued = NULL_LAYOUT_QUEUE_REASONS.has(raw) || NULL_LAYOUT_QUEUE_REASONS.has(suffix);
    return {
      state: queued ? "queued" : "failed",
      noText: false,
      hasLayout: false,
      diagState: "empty-layout",
      diagReason: why
    };
  }
  const noText = pageNoText(layout);
  return {
    state: "empty",
    noText,
    hasLayout: true,
    diagState: noText ? "empty-layout" : "translated",
    diagReason: noText ? "no-blocks" : "no-translatable"
  };
}

/** Pass interrupt reasons through. Anything else stays the real empty page. */
export function normalizePageSkipReason(hinted) {
  if (hinted === "skip-only" || hinted === "cached" || hinted === "unavailable") return hinted;
  return "empty";
}

const COUNTABLE_SKIP_STATES = new Set(["empty", "skipped", "held"]);

/**
 * Toolbar state for a page the walker did not send.
 * empty, skipped, and held count toward 全文已译 only after the library stores them.
 * A failed or partial row stays failed: it must not be rewritten as finished.
 * A cached translation was already stored when it landed. Only a cached skip is new.
 */
export function persistedSkipRunState({ reason = "", state = "", blocking = "" } = {}) {
  if (blocking === "failed" || blocking === "partial") return "";
  if (reason === "skip-only") return "skipped";
  const next = String(state || "");
  if (reason === "cached") return next === "skipped" || next === "held" ? next : "";
  if (reason === "empty" && COUNTABLE_SKIP_STATES.has(next)) return next;
  return "";
}

/**
 * Status copy for retranslate.
 * 重译全文 starts immediately: done and failed are status lines, not a confirm.
 */
export function retranslateButtonLabel({ busy = false, scope = "", n = 0, t = 0 } = {}) {
  if (busy && scope === "document") return `重译中 ${Math.max(0, Number(n) || 0)}/${Math.max(0, Number(t) || 0)}`;
  if (busy && scope === "page") return "重译中…";
  return "重译本页";
}

const RETRANSLATE_DOC_NOTE = "从第 1 页起重新翻译所有页";
const RETRANSLATE_DOC_NOTE_BUSY = "会先停止当前翻译，再从第 1 页重译";

/**
 * Split chrome. The caret stays the right segment except while a retranslate
 * is running, when that segment becomes ×. The independent 停止 is only the
 * first translation, and it never shares the split frame.
 */
export function retranslateSplitChrome({
  hasDoc = false,
  busy = false,
  scope = "",
  canRetranslatePage = false
} = {}) {
  const retranslating = Boolean(busy) && (scope === "page" || scope === "document");
  const translating = Boolean(busy) && !retranslating;
  return {
    caretHidden: retranslating,
    caretDisabled: !hasDoc || retranslating,
    stopRetranslateHidden: !retranslating,
    primaryStopHidden: !translating,
    pageItemDisabled: !hasDoc || retranslating || !canRetranslatePage,
    docItemDisabled: !hasDoc || retranslating,
    docNote: translating ? RETRANSLATE_DOC_NOTE_BUSY : RETRANSLATE_DOC_NOTE
  };
}

/** 重译全文 never confirms. A running first translation is stopped, then page 1 starts. */
export function documentRetranslateEntry({ busy = false, retranslating = false } = {}) {
  if (retranslating) return { action: "ignore", confirm: false };
  if (busy) return { action: "stop-then-start", confirm: false, startPage: 1, forceAll: true };
  return { action: "start", confirm: false, startPage: 1, forceAll: true };
}

/** 重译本页 during a document walk cuts in. It does not abort that walk. */
export function pageRetranslateEntry({
  busy = false,
  retranslating = false,
  page = 0,
  canRetranslate = true
} = {}) {
  const target = Math.floor(Number(page) || 0);
  if (!canRetranslate || target < 1 || retranslating) return { action: "ignore", abortDocument: false };
  if (busy) return { action: "rush", page: target, abortDocument: false };
  return { action: "retranslate", page: target, abortDocument: false };
}

/** Keep click order. A page already queued, or the page in flight, is not added again. */
export function rememberRushPage(queue, page, inflight = 0) {
  const next = (Array.isArray(queue) ? queue : [])
    .map((item) => Math.floor(Number(item) || 0))
    .filter((item) => item >= 1);
  const n = Math.floor(Number(page) || 0);
  const current = Math.floor(Number(inflight) || 0);
  if (n < 1 || n === current || next.includes(n)) return next;
  next.push(n);
  return next;
}

export function takeRushPage(queue) {
  const next = (Array.isArray(queue) ? queue : [])
    .map((item) => Math.floor(Number(item) || 0))
    .filter((item) => item >= 1);
  const page = next.shift() || 0;
  return { page, queue: next };
}

/** Queued or in-flight cut-in. The toolbar and the library row say 重译中. */
export function rushRetranslateLive({ queued = 0, inflight = 0 } = {}) {
  return Math.max(0, Number(queued) || 0) > 0 || Math.floor(Number(inflight) || 0) >= 1;
}

export function liveWorkPhase({ scope = "", rush = false } = {}) {
  if (scope === "page" || scope === "document" || rush) return "retranslate";
  return "translating";
}

/**
 * Menu under the whole split, 4px below its bottom edge.
 * Start-aligned to the button's left, at least as wide as the button.
 * Not enough room on the right: align the menu's right to the button's right,
 * and keep the box inside the viewport.
 */
export function retranslateMenuBox({
  buttonLeft = 0,
  buttonRight = 0,
  buttonBottom = 0,
  buttonWidth = 0,
  menuWidth = 0,
  viewportWidth = 0,
  viewportLeft = 0,
  gap = 4
} = {}) {
  const minWidth = Math.max(0, Number(buttonWidth) || (Number(buttonRight) - Number(buttonLeft)) || 0);
  const width = Math.max(minWidth, Number(menuWidth) || 0);
  const leftEdge = Number(buttonLeft) || 0;
  const rightEdge = Number(buttonRight) || leftEdge + minWidth;
  const viewL = Number(viewportLeft) || 0;
  const viewW = Math.max(0, Number(viewportWidth) || 0);
  const viewR = viewL + viewW;
  const top = (Number(buttonBottom) || 0) + (Number(gap) || 0);
  let align = "start";
  let left = leftEdge;
  let maxWidth = width;
  if (viewW > 0 && left + width > viewR) {
    align = "end";
    const cap = Math.max(minWidth, rightEdge - viewL);
    maxWidth = Math.min(width, cap, viewW);
    left = rightEdge - maxWidth;
    if (left < viewL) left = viewL;
    if (left + maxWidth > viewR) {
      maxWidth = Math.max(minWidth, viewR - left);
      if (left + maxWidth > viewR) left = Math.max(viewL, viewR - maxWidth);
    }
  } else if (viewW > 0) {
    maxWidth = Math.max(minWidth, Math.min(width, viewR - left));
    if (left + maxWidth > viewR) left = Math.max(viewL, viewR - maxWidth);
  }
  return { top, left, minWidth, align, maxWidth };
}

export function retranslateStatusCopy({ scope = "page", phase = "running", n = 0, t = 0, failed = 0 } = {}) {
  if (scope === "document") {
    if (phase === "failed") return unfinishedDocCopy(n, t, failed);
    if (phase === "done") return "全文已译";
    return `重译中 · ${Math.max(0, Number(n) || 0)}/${Math.max(0, Number(t) || 0)}`;
  }
  if (phase === "failed") return PDF_COPY.retranslateFailed;
  if (phase === "done") return PDF_COPY.retranslateDone;
  return "重译中…";
}

export const BATCH_RETRY_ATTEMPTS = 3;
const BATCH_RETRY_CAP_MS = 60_000;

/** 429, 5xx, and timeout can be retried. Abort and other errors cannot. */
export function batchCanRetry(err, res) {
  if (err?.name === "AbortError" || res?.aborted) return false;
  const code = translateExceptionCode(err, res);
  if (code === "timeout") return true;
  const status = Number(code);
  return status === 429 || (status >= 500 && status <= 599);
}

/** Retry-After wins. Otherwise 200ms doubles up to 2s, jittered down to half. */
export function batchBackoffMs(attempt, { retryAfterMs = 0, random = Math.random } = {}) {
  const honored = Number(retryAfterMs);
  if (Number.isFinite(honored) && honored > 0) return Math.min(BATCH_RETRY_CAP_MS, honored);
  const base = Math.min(2000, 200 * (2 ** Math.max(0, Number(attempt) || 0)));
  const roll = Math.min(1, Math.max(0, Number(typeof random === "function" ? random() : random) || 0));
  return Math.round(base * (0.5 + 0.5 * roll));
}

export function failureChipModel({ state = "", unfinished = 0, pending = false, still = false } = {}) {
  if (pending) return { text: "重试中…", retry: "", still: "", settings: "" };
  if (state === "failed") {
    return {
      text: "这页没译完",
      retry: "重试本页",
      still: still ? "仍然失败，可在设置里检查引擎或稍后再试" : "",
      settings: still ? "去设置" : ""
    };
  }
  if (state === "partial") {
    const k = Math.max(0, Math.floor(Number(unfinished) || 0));
    // A partial page can fail with k === m (failed rows that still count as landed).
    // "有 0 段没译完" is the wrong sentence; the whole page is unfinished.
    if (k <= 0) {
      return {
        text: "这页没译完",
        retry: "重试本页",
        still: still ? "仍然失败，可在设置里检查引擎或稍后再试" : "",
        settings: still ? "去设置" : ""
      };
    }
    return {
      text: `有 ${k} 段没译完`,
      retry: "重试本页",
      still: still ? "仍然失败，可在设置里检查引擎或稍后再试" : "",
      settings: still ? "去设置" : ""
    };
  }
  return null;
}

export function runningPageHint() {
  return "排队中";
}

/** Reason strings stay under 20 characters so the key scrubber does not mask them. */
export function layoutNullReason(token) {
  const suffix = String(token || "empty").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 7) || "empty";
  return `layout-null:${suffix}`;
}

/** Request failure, timeout, or a non-text fallback code. The message body is not kept. */
export function translateExceptionCode(err, res) {
  const status = Number(err?.httpStatus || err?.status || res?.httpStatus || res?.status);
  if (Number.isFinite(status) && status >= 400 && status < 600) return String(Math.floor(status));
  const raw = String(err?.code || res?.code || "");
  const message = String(err?.message || res?.error || "");
  if (raw === "timeout" || err?.name === "TimeoutError" || /timeout/i.test(message)) return "timeout";
  const http = message.match(/\b([45]\d\d)\b/);
  if (http) return http[1];
  if (/^[a-z0-9._-]{1,40}$/i.test(raw)) return raw.slice(0, 40);
  if (res?.ok === false || res?.error || err) return "error";
  return "";
}

/** Returned translations that do not line up with the requested blocks. */
export function batchWritebackMismatch(res, units) {
  if (!res || res.ok === false || res.error) return false;
  const list = Array.isArray(units) ? units : [];
  const translations = res.translations;
  if (!Array.isArray(translations)) return list.length > 0;
  const keyed = translations.some((item) => item && typeof item === "object" && item.bid);
  if (keyed) {
    const bound = new Set(translations.map((item) => String(item?.bid || "")).filter(Boolean));
    return list.some((unit) => String(unit?.bid || "") && !bound.has(String(unit.bid)));
  }
  return translations.length !== list.length;
}

/**
 * n counts finished pages, including a full translation that is still waiting
 * on the formula check. That check must not hold the open count behind a slow
 * layout. partial and failed are not finished. formulaPending blocks 全文已译.
 */
export function translatedPageTotal(states) {
  let n = 0;
  let needsRetry = 0;
  let formulaPending = 0;
  for (const row of states || []) {
    const state = row?.state || "";
    if (state === "formula-check" || state === "stale-formula") formulaPending += 1;
    if (state === "formula-check" || state === "stale-formula" || pageCountsAsTranslated({ runState: state, skipped: state === "skipped" })) n += 1;
    if (state === "failed" || state === "partial") needsRetry += 1;
  }
  return { n, needsRetry, formulaPending };
}

export function unfinishedDocCopy(n, t, f) {
  return `已译 ${Math.max(0, Number(n) || 0)}/${Math.max(0, Number(t) || 0)} 页 · ${Math.max(0, Number(f) || 0)} 页没译完`;
}

/**
 * Toolbar slot. 全文已译 only when every page is finished and none need retry.
 * A failed batch must not be able to light this up.
 */
export function docStatusView({ n = 0, t = 0, needsRetry = 0, formulaPending = 0, phase = "idle", retranslate = false } = {}) {
  // Opening hides the count only before any page is known. A library or old
  // cache can already settle pages while the first layout is still running.
  if (phase === "opening" && !(Number(n) > 0 && Number(t) > 0)) {
    return { state: "opening", text: "正在读取 PDF…" };
  }
  const pages = Math.max(0, Number(t) || 0);
  const done = Math.max(0, Number(n) || 0);
  const failed = Math.max(0, Number(needsRetry) || 0);
  const running = phase === "running" || phase === "layout";
  if (running && pages > 0) {
    const text = retranslate ? `重译中 · ${done}/${pages}` : `翻译中 · ${done}/${pages}`;
    return { state: "running", text, warnCount: 0 };
  }
  const pendingFormula = Math.max(0, Number(formulaPending) || 0);
  const clean = !running && phase !== "opening" && pages > 0 && done === pages && failed === 0 && pendingFormula === 0;
  if (clean) return { state: "done", text: "全文已译", warnCount: 0 };
  if (!running && phase !== "opening" && pages > 0 && failed > 0) {
    return { state: "retry", text: unfinishedDocCopy(done, pages, failed), warnCount: failed };
  }
  if (pages > 0) {
    return { state: phase === "opening" ? "opening" : "idle", text: `已译 ${done} / ${pages} 页`, warnCount: 0 };
  }
  return { state: "idle", text: "", warnCount: 0 };
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
  blocks = null,
  runState = "",
  formulaVerdict = ""
} = {}) {
  const finish = (state) => applyFormulaVerdict(state, formulaVerdict);
  if (skipped) return "skipped";
  const stored = String(runState || "");
  if (!Array.isArray(blocks) && (stored === "failed" || stored === "partial" || stored === "empty" || stored === "done" || stored === "held")) {
    return finish(stored);
  }
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
    if (covered === live.length) return finish("done");
    if (covered > 0) return finish("partial");
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
  if (landed) return finish("done");
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
  if (state === "layout" || state === "empty" || state === "cleared") return false;
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
 * k < m is partial. partial does not count as translated, and it blocks 全文已译.
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
 * An explicit page uses the same gate as the current page.
 * A page with nothing to translate stays put. An old formula mark is the
 * in-page label: that page is retranslated even when it has no live text blocks.
 */
export function canRetranslateRequestedPage({
  state = "",
  translatableCount = 0,
  titleCandidate = false,
  originals = 0
} = {}) {
  if (state === "stale-formula" || state === "formula-check") return true;
  return canRetranslatePage({ state, translatableCount, titleCandidate, originals });
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

function foldedLibraryOriginal(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/**
 * A failed row whose original already has a landed library pair in this
 * target language keeps that translation. An echo of the source is not reused.
 * A recorded provider or model must match the caller. Other languages are not reused.
 * Rows that are still unsettled stay failed so the retry can resend them.
 */
export function reuseSettledLibraryFailures(rows, pairs, targetLang = "zh-CN", settings = null) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const lang = String(targetLang || "zh-CN");
  const wantProvider = String(settings?.provider || "").trim();
  const wantModel = String(settings?.model || "").trim();
  const list = Array.isArray(pairs) ? pairs : [];
  let changed = false;
  const next = rows.map((row) => {
    if (!row || row.failed !== true) return row;
    const original = foldedLibraryOriginal(row.original || row.text || row.sourceText);
    if (!original) return row;
    const hit = list.find((pair) => {
      if (!pair || pair.failed === true) return false;
      if (String(pair.targetLang || "") !== lang) return false;
      const provider = String(pair.provider || "").trim();
      const model = String(pair.model || "").trim();
      if (wantProvider && provider && provider !== wantProvider) return false;
      if (wantModel && model && model !== wantModel) return false;
      const source = foldedLibraryOriginal(pair.text || pair.sourceText || pair.original);
      if (source !== original) return false;
      return translationLanded(pair.translation, original, lang);
    });
    if (!hit) return row;
    changed = true;
    const reused = { ...row, translation: String(hit.translation), failed: false, targetLang: lang };
    if (wantProvider) reused.provider = wantProvider;
    if (wantModel) reused.model = wantModel;
    return reused;
  });
  return changed ? next : rows;
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

const PDF_ID_PATH = /^\/pdf\/(\d+(?:v\d+)?|\d{4}\.\d{4,5}(?:v\d+)?|[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)$/;
const PDF_DOC_EXT = /\.(?:html?|php|aspx?|jsp|shtml)$/;

function pdfIdPath(pathname) {
  const path = String(pathname || "").replace(/\/+$/, "");
  if (PDF_DOC_EXT.test(path)) return false;
  return PDF_ID_PATH.test(path);
}

export function looksLikePdfUrl(url) {
  if (!url || typeof url !== "string") return false;
  const raw = url.trim();
  if (!raw) return false;
  if (/^data:application\/pdf/i.test(raw)) return true;
  try {
    const parsed = new URL(raw);
    // 内置 PDF 查看器的 tab.url 仍是原始网址，不是
    // chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai，该分支真机不可达。
    const path = decodeURIComponent(parsed.pathname).toLowerCase();
    if (path.endsWith(".pdf")) return true;
    // 只认 /pdf/<数字或 arxiv id>。/docs/pdf/guide.html 这类页面不是 PDF。
    if (pdfIdPath(path)) return true;
    for (const key of ["filename", "file", "name"]) {
      if (/\.pdf$/i.test(parsed.searchParams.get(key) || "")) return true;
    }
    return /\.pdf(?:$|[?#])/i.test(parsed.href);
  } catch {
    return /\.pdf(?:$|[?#])/i.test(raw);
  }
}

export function resolvePopupPdfSrc(url, contentType) {
  const raw = String(url || "").trim();
  // data: PDF 暂不带 src 打开：读取它需要 tabs 权限，待 Wisdom 决定。
  if (!raw || isPdfViewerPage(raw) || /^data:/i.test(raw)) return "";
  if (typeof contentType === "string") {
    return /^application\/pdf\b/i.test(contentType.trim()) ? raw : "";
  }
  return looksLikePdfUrl(raw) ? raw : "";
}

export const PDF_CONTENT_TYPE_TIMEOUT_MS = 400;

export async function readPdfContentType(tabId, executeScript, timeoutMs = PDF_CONTENT_TYPE_TIMEOUT_MS) {
  if (!tabId || typeof executeScript !== "function") return null;
  const limit = Number.isFinite(timeoutMs) ? timeoutMs : PDF_CONTENT_TYPE_TIMEOUT_MS;
  let timer;
  try {
    const injected = await Promise.race([
      executeScript({
        target: { tabId },
        func: () => document.contentType || ""
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), limit);
      })
    ]);
    if (injected == null) return null;
    const type = Array.isArray(injected) ? injected[0]?.result : injected;
    return typeof type === "string" ? type : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function openPopupPdfEntry({ url, probe, sendMessage, close, button, error }) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (error) error.hidden = true;
  try {
    const src = resolvePopupPdfSrc(url, await probe);
    const message = src
      ? { type: "OI_OPEN_PAGE", page: "pdf", src }
      : { type: "OI_OPEN_PAGE", page: "pdf" };
    const res = await sendMessage(message);
    if (!res || res.ok === false) throw new Error("open failed");
  } catch {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (error) error.hidden = false;
    return;
  }
  if (error) error.hidden = true;
  close();
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
    const text = stripUserVisibleSlots(out.replace(/\s+/g, " ").trim());
    if (text) return text;
  }
  return stripUserVisibleSlots(String(host?.textContent || "").trim());
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
  const abortController = typeof AbortController === "function" ? new AbortController() : null;
  return { running: false, aborted: false, inflight: null, abortController };
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
    retranslateDocDisabled: !hasDoc || on,
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
  const controller = session.abortController;
  if (controller && controller.signal?.aborted !== true) {
    try { controller.abort(); } catch { /* already aborted */ }
  }
}

function translateAbortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function pauseForRetry(session, ms, sleep) {
  const wait = Math.max(0, Number(ms) || 0);
  if (!(wait > 0)) return Promise.resolve(!session?.aborted);
  const signal = session?.abortController?.signal;
  const fn = typeof sleep === "function"
    ? sleep
    : (delay, abortSignal) => new Promise((resolve) => {
      const timer = setTimeout(resolve, delay);
      abortSignal?.addEventListener?.("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  return Promise.resolve(fn(wait, signal)).then(() => !session?.aborted, () => !session?.aborted);
}

async function sendTranslateBatch(send, message, signal, onAbortRequest) {
  if (signal?.aborted) {
    try { onAbortRequest?.(message?.requestId); } catch { /* local stop still wins */ }
    throw translateAbortError();
  }
  let rejectAbort = null;
  const onAbort = () => {
    try { onAbortRequest?.(message?.requestId); } catch { /* local stop still wins */ }
    rejectAbort?.(translateAbortError());
  };
  if (signal) signal.addEventListener("abort", onAbort);
  try {
    const job = Promise.resolve().then(() => send(message));
    if (!signal) return await job;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    return await Promise.race([job, aborted]);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Background fill-in sessions are not the document job.
 * Stop, retranslate, a new job, a document switch, and page close abort every one.
 */
export function createBackgroundSessions() {
  const sessions = new Set();
  let epoch = 0;
  return {
    get active() { return sessions.size > 0; },
    get epoch() { return epoch; },
    track(session) {
      if (!session) return { session, current: () => false, release() {} };
      sessions.add(session);
      const born = epoch;
      return {
        session,
        current: () => born === epoch && !session.aborted,
        release() { sessions.delete(session); }
      };
    },
    abortAll() {
      epoch += 1;
      for (const session of sessions) abortTranslateSession(session);
      sessions.clear();
    }
  };
}

/** A fill-in may write only while that fill-in is still current. */
export function translationCacheWhile(cache, alive) {
  const open = typeof alive === "function" ? alive : () => true;
  return {
    get: (docId, page) => cache?.get(docId, page) || null,
    set(docId, page, rows) {
      if (open()) cache?.set(docId, page, rows);
    },
    has: (docId, page) => Boolean(cache?.has(docId, page)),
    clearPage: (docId, page) => cache?.clearPage?.(docId, page),
    clear: () => cache?.clear?.()
  };
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
 * One open sends each distinct block text once. A later pass skips a block
 * whose bid, source sentence, and submitted display text were already sent.
 * A layout pass that changes the display (formula slots moved) still sends
 * that new text once. The same display is not submitted twice.
 */
export function claimTranslationUnits(units, sent) {
  const fresh = [];
  const seen = sent || new Map();
  for (const unit of units || []) {
    const bid = String(unit?.bid || "");
    const submitted = String(unit?.original || unit?.text || "");
    const source = String(unit?.sourceText || submitted);
    const hash = `${sourceReuseHash(source)}:${sourceReuseHash(submitted)}`;
    if (bid && seen.get(bid) === hash) continue;
    if (bid) seen.set(bid, hash);
    fresh.push(unit);
  }
  return fresh;
}

/**
 * Body units that still need their own request.
 * A multimodal page paints blocks, not the title shell, so a block whose text
 * matches a structure slot is still sent and written back onto its own bid.
 * Text-layer pages keep the slot: an exact match is already the shell's job,
 * and a block that only sits inside a longer slot is stored on its own.
 */
export function unitsAfterStructure(layout, units, record, docId) {
  const list = units || [];
  if (String(layout?.mode || "") === "mm-page") return list.slice();
  if (!record || record.status !== "ok" || record.docId !== docId || record.page !== layout?.page) return list.slice();
  const outside = new Set(
    blocksOutsideStructure(layout?.blocks || [], record.source || record.structure).map((block) => block.id)
  );
  const slotText = new Set(
    structureTranslateSlots(record.source || record.structure).map((slot) => (
      String(slot.text || "").replace(/\s+/g, " ").trim()
    ))
  );
  return list.filter((unit) => {
    if (!unit?.id || outside.has(unit.id)) return true;
    const text = String(unit.text || unit.original || "").replace(/\s+/g, " ").trim();
    return Boolean(text) && !slotText.has(text);
  });
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

/**
 * A settled row keeps its translation. A retry may fill a hole, not replace it.
 * An echo of the source does not count: a later translation that actually
 * landed replaces it. Otherwise a placeholder that repeats the English source
 * stays on screen after the 200.
 */
function keepSettledTranslation(prior, incoming, targetLang) {
  if (!rowSettled(prior, targetLang)) return false;
  const nextText = String(incoming?.translation || "").trim();
  if (!nextText) return true;
  if (nextText === String(prior?.translation || "").trim()) return false;
  const source = translationSource(prior) || translationSource(incoming);
  if (translationEcho(prior?.translation, source) && translationLanded(nextText, source, targetLang)) return false;
  return true;
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
    // A later reuse that did not land must not wipe a failed attempt.
    // Otherwise the next 翻译 looks like a first send and drops bypassCache.
    const landed = translationLanded(mergedRow.translation, translationSource(mergedRow), targetLang);
    if (hit.failed === true || (row.failed === true && !landed)) mergedRow.failed = true;
    else delete mergedRow.failed;
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
      let abortedSend = false;
      let loggedFailure = false;
      let attempt = 0;
      while (attempt < BATCH_RETRY_ATTEMPTS) {
        res = { ok: false, translations: [] };
        abortedSend = false;
        let err = null;
        session.inflight = { requestId, slice, sliceStart: i, items };
        try {
          res = (await sendTranslateBatch(send, {
            type: "OI_TRANSLATE_BATCH",
            texts: slice,
            items,
            requestId,
            promptAddendum: PDF_PROMPT_ADDENDUM,
            ...(options.bypassCache ? { bypassCache: true } : {})
          }, session.abortController?.signal, options.onAbortRequest)) || res;
        } catch (caught) {
          err = caught;
          if (caught?.name === "AbortError" || session.aborted) abortedSend = true;
          else {
            res = {
              ok: false,
              translations: [],
              error: String(caught?.message || caught),
              httpStatus: caught?.httpStatus,
              retryAfterMs: caught?.retryAfterMs,
              code: caught?.code || caught?.name
            };
          }
        }
        if (session.inflight?.requestId === requestId) session.inflight = null;
        if (abortedSend || session.aborted || res?.aborted) {
          abortedSend = true;
          break;
        }
        const failedNow = res.ok === false || Boolean(res.error);
        const retry = failedNow && batchCanRetry(err, res) && attempt + 1 < BATCH_RETRY_ATTEMPTS;
        if (!retry) {
          if (failedNow) {
            noteTranslateException(translateExceptionCode(err, res), { page: options.page, count: slice.length });
            loggedFailure = true;
          }
          break;
        }
        const wait = batchBackoffMs(attempt, {
          retryAfterMs: Number(res.retryAfterMs) || Number(err?.retryAfterMs) || 0,
          random: options.random
        });
        attempt += 1;
        const alive = await pauseForRetry(session, wait, options.sleep);
        if (!alive || session.aborted) {
          abortedSend = true;
          break;
        }
      }
      if (abortedSend || session.aborted) break;
      const batchFailed = res.ok === false || Boolean(res.error);
      if (batchFailed && !loggedFailure) {
        noteTranslateException(translateExceptionCode(null, res), { page: options.page, count: slice.length });
      } else if (!batchFailed && batchWritebackMismatch(res, sliceUnits)) {
        noteTranslateException("writeback-mismatch", { page: options.page, count: slice.length });
      }
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
  const startPage = Math.min(
    Math.max(1, Math.floor(Number(options.startPage) || 1)),
    numPages > 0 ? numPages : 1
  );
  const pages = [];
  let wholePageFailures = 0;
  session.running = true;
  if (options.preserveSession !== true) session.aborted = false;
  const trackGeneration = options.generation !== undefined && typeof options.readGeneration === "function";
  const generationCurrent = () => !trackGeneration || options.readGeneration() === options.generation;
  const walkLive = () => !session.aborted && generationCurrent();
  const rushedDone = new Set();
  const readRushPage = () => {
    if (typeof options.pullRushPage !== "function") return 0;
    let rush = 0;
    try { rush = Math.floor(Number(options.pullRushPage()) || 0); } catch { rush = 0; }
    if (rush < 1 || rush > numPages) return 0;
    return rush;
  };
  // A rush page cuts in front of the remaining walk and is sent even when cached.
  // The in-flight page is not aborted; the cut-in is the next iteration.
  // A finished cut-in is skipped when the walk reaches that page, including 重译全文.
  async function visit(page, rushed) {
    if (!walkLive()) return "break";
    if (rushed) rushedDone.delete(page);
    else if (rushedDone.has(page)) {
      pages.push({ page, results: cache?.get(docId, page), skipped: true, reason: "cached" });
      options.onPageSkip?.({ page, reason: "cached" });
      wholePageFailures = 0;
      return "";
    }
    if (!rushed && typeof options.includePage === "function" && !options.includePage(page)) return "";
    let prep = "";
    if (typeof options.preparePage === "function") {
      prep = await options.preparePage(page);
      if (!walkLive()) return "break";
      if (prep === "stop") return "break";
      if (prep === "skip" && rushed) prep = "retry";
      if (prep === "skip") {
        const adopted = cache?.get(docId, page);
        pages.push({ page, results: adopted, skipped: true, reason: "cached" });
        options.onPageSkip?.({ page, reason: "cached" });
        wholePageFailures = 0;
        return "";
      }
    }
    const cached = cache?.get(docId, page);
    // "retry" still reads originals when the cached body is already complete.
    // A failed title batch is not one of those rows. A rush page is a retranslate.
    if (!rushed && prep !== "retry" && skipCached && pageTranslationComplete(cached, targetLang)) {
      pages.push({ page, results: cached, skipped: true, reason: "cached" });
      options.onPageSkip?.({ page, reason: "cached" });
      wholePageFailures = 0;
      return "";
    }
    if (!walkLive()) return "break";
    options.onPageStart?.({ page, total: numPages });
    const originals = (await options.getPageOriginals?.(page)) || [];
    if (!walkLive()) return "break";
    if (!originals.length) {
      const hinted = options.pageSkipReason?.(page);
      const reason = normalizePageSkipReason(hinted);
      pages.push({ page, results: cache?.get(docId, page) || [], skipped: true, reason });
      options.onPageSkip?.({ page, reason });
      wholePageFailures = 0;
      return "";
    }
    const retryBypass = rushed || options.bypassCache === true || pageNeedsBypass(cached, targetLang);
    const translated = await translatePageBlocks(originals, {
      send: options.send,
      session,
      batchSize: options.batchSize,
      preserveSession: true,
      page,
      bypassCache: retryBypass,
      requestIdFor: options.requestIdFor && ((index) => options.requestIdFor(page, index)),
      onAbortRequest: options.onAbortRequest,
      onBatchStart: options.onBatchStart,
      onBatchResult: (payload) => {
        if (!walkLive()) return;
        const merged = mergeTranslationRows(cache?.get(docId, page), payload.results, targetLang);
        cache?.set(docId, page, merged);
        options.onPageResult?.({ page, ...payload, results: merged });
      }
    });
    if (!walkLive()) return "break";
    const { aborted, results, error, missingField } = translated;
    const merged = mergeTranslationRows(cache?.get(docId, page), results, targetLang);
    cache?.set(docId, page, merged);
    pages.push({ page, results: merged, skipped: false, error: error || "", missingField: missingField || "" });
    const state = pageRunState(merged, { targetLang });
    const whole = state === "failed";
    if (whole) wholePageFailures += 1;
    else wholePageFailures = 0;
    if (rushed && !aborted && !whole && !error) rushedDone.add(page);
    if (whole || error) options.onPageError?.({ page, results: merged, aborted, error: error || "", missingField: missingField || "" });
    else options.onPageDone?.({ page, results: merged, aborted, error: "" });
    if (aborted || !walkLive() || wholePageFailures >= 3) return "break";
    return "";
  }
  try {
    let stopWalk = false;
    for (let page = startPage; page <= numPages; page++) {
      if (!walkLive()) break;
      while (walkLive()) {
        const rush = readRushPage();
        if (!rush) break;
        if (await visit(rush, true) === "break") {
          stopWalk = true;
          break;
        }
      }
      if (stopWalk || !walkLive()) break;
      if (await visit(page, false) === "break") break;
    }
    while (!stopWalk && walkLive()) {
      const rush = readRushPage();
      if (!rush) break;
      if (await visit(rush, true) === "break") break;
    }
    const stopped = wholePageFailures >= 3;
    const superseded = !generationCurrent();
    const failure = stopped ? pages.find((entry) => entry.error) : null;
    return {
      ok: !session.aborted && !stopped && !superseded,
      aborted: session.aborted || superseded,
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

/**
 * Column reading order for lines already grouped (scripts stay on their line).
 * A gutter inside one line is a stitched pair of columns, not a full-width
 * title. Each column is top to bottom, then the next column. No split leaves
 * the line list unchanged, including its original order.
 */
/**
 * A subtitle is marked `band` so a column cut cannot file it by its center.
 * Put it back by vertical position. Other lines keep the order they arrived in.
 */
function placeFullBands(lines) {
  const bands = [];
  const rest = [];
  for (const line of lines || []) {
    if (line?.band === true) bands.push(line);
    else rest.push(line);
  }
  if (!bands.length) return rest;
  const ordered = rest.slice();
  const ranked = [...bands].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const band of ranked) {
    const at = ordered.findIndex((line) => line.y < band.y - 0.5);
    if (at < 0) ordered.push(band);
    else ordered.splice(at, 0, band);
  }
  return ordered;
}

export function orderLinesInColumns(lines) {
  const list = (Array.isArray(lines) ? lines : []).filter((line) => line && String(line.text || "").trim());
  if (list.length < 2) return placeFullBands(list);
  const body = list.filter((line) => line.band !== true);
  const items = body.flatMap((line) => line.items || []);
  const splitX = detectItemColumnSplit(items);
  if (splitX == null) return placeFullBands(list);
  // A gutter, or a shared baseline, is not enough: algorithms, figure
  // captions, and a name list do that too, and reordering them moves formula
  // crops and translation bids. Reorder when both pieces are prose.
  const stitched = body.some((line) => proseColumnStitch(line, splitX));
  if (!stitched) return placeFullBands(list);
  const pageLeft = Math.min(...body.map((line) => line.x));
  const pageRight = Math.max(...body.map((line) => line.x + line.width));
  const pageWidth = Math.max(1, pageRight - pageLeft);
  const ordered = [];
  let left = [];
  let right = [];
  const flushCols = () => {
    ordered.push(...tagColumn(sortColumnDown(left), 0), ...tagColumn(sortColumnDown(right), 1));
    left = [];
    right = [];
  };
  for (const line of body) {
    const pieces = splitStitchedLine(line, splitX);
    if (pieces.length === 1 && lineSpansColumns(pieces[0], splitX, pageWidth)) {
      flushCols();
      ordered.push(pieces[0]);
      continue;
    }
    for (const piece of pieces) {
      if (piece.x + piece.width / 2 < splitX) left.push(piece);
      else right.push(piece);
    }
  }
  flushCols();
  return placeFullBands([...ordered, ...list.filter((line) => line.band === true)]);
}

const COLUMN_PROSE = /\b(?:the|and|of|for|from|with|that|this|among|into|over)\b/i;

function proseColumnStitch(line, splitX) {
  const parts = splitStitchedLine(line, splitX);
  if (parts.length < 2) return false;
  return parts.every((part) => {
    const text = String(part.text || "").trim();
    return text.length >= 18 && COLUMN_PROSE.test(text);
  });
}

function tagColumn(lines, column) {
  for (const line of lines) line.column = column;
  return lines;
}

function sortColumnDown(lines) {
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => {
      const dy = b.line.y - a.line.y;
      if (Math.abs(dy) > 0.5) return dy;
      return a.index - b.index;
    })
    .map((entry) => entry.line);
}

function lineSpansColumns(line, splitX, pageWidth) {
  return line.width > pageWidth * 0.6 && line.x < splitX && line.x + line.width > splitX;
}

function splitStitchedLine(line, splitX) {
  const items = [...(line.items || [])].sort((a, b) => a.x - b.x || b.y - a.y);
  if (items.length < 2) return [line];
  let at = -1;
  let bestGap = 0;
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const gap = items[i].x - (prev.x + (Number(prev.width) || 0));
    const mid = prev.x + (Number(prev.width) || 0) + gap / 2;
    if (Math.abs(mid - splitX) > 28) continue;
    if (gap > bestGap) {
      bestGap = gap;
      at = i;
    }
  }
  if (at < 1 || bestGap < 16) return [line];
  const pieces = [finalizeLine(items.slice(0, at)), finalizeLine(items.slice(at))].filter((part) => part.text);
  if (pieces.length < 2) return [line];
  for (const piece of pieces) {
    if (piece.bold) continue;
    const own = (piece.items || []).some((item) => /bold|black|heavy|semibold/i.test(item.fontName || ""));
    if (own) piece.bold = true;
  }
  return pieces;
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
    const piece = item.str || "";
    if (prev && gapNeedsSpace(prev, item, text, piece) && !/\s$/.test(text) && !/^\s/.test(piece)) text += " ";
    text += piece;
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
  let sawTitle = false;
  const flush = (role) => {
    if (!buf.length) return;
    const text = joinHyphenated(buf.map((line) => line.text), preserveLineHyphens);
    const use = sawTitle ? "title" : role;
    if (text.length > 1) {
      paras.push({
        text,
        role: normalizeBlockRole(use),
        kind: use === "formula" ? "math" : "text",
        fontName: buf[0]?.fontName || "",
        region: buf[0]?.region || "body",
        sourceItems: buf.flatMap((line) => line.items || [])
      });
    }
    buf = [];
    sawTitle = false;
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
    if (role === "title") sawTitle = true;
    buf.push(line);
    // "illus-" must not swallow the next sentence, which starts with a capital.
    // A capitalized name ("Berkeley-") still joins "Parser" on the next line.
    const hyphenTail = String(line.text || "").trim().match(/([A-Za-z]+)-$/);
    const danglingHyphen = hyphenTail && /^[a-z]/.test(hyphenTail[1]) && next && !/^[a-z]/.test(String(next.text || "").trim());
    if (danglingHyphen) {
      flush(role);
      continue;
    }
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
    // Any tagged column change ends the paragraph. The piece that
    // continues at the top of the next column is joined later, and only
    // when it actually sits below the column break rather than beside it.
    // A full-width line has no column. The next column's first line is not
    // its tail. "1https://github.com/…" must not swallow "Term Memory…".
    const columnRestart = (line.column !== next.column) && (line.column != null || next.column != null);
    // The next column starts above this line. A lowercase tail still joins.
    // "transformer-xl" must not swallow "Term Memory", which starts a sentence.
    const columnJumpUp = next.y > line.y + medianH * 3 && /^[A-Z0-9]/.test(String(next.text || "").trim());
    const regionRestart = line.region && next.region && line.region !== next.region;
    const shortEnd = role === "paragraph" && line.width < medianW * 0.72 && /[.!?:]$/.test(line.text);
    // "an evidence synthesis model" stays on the title. A body sentence does not:
    // it is smaller, or it is a full clause rather than a short lowercase tail.
    const nextWords = String(next.text || "").trim().split(/\s+/).filter(Boolean);
    const titleCarry = sawTitle && !largeGap && !columnRestart && !columnJumpUp &&
      next.height >= line.height * 0.72 &&
      /^[a-z]/.test(String(next.text || "").trim()) &&
      nextWords.length <= 12 && next.text.length <= 72;
    if (titleCarry) continue;
    const sameHeadingBand =
      role !== "paragraph" &&
      role === nextRole &&
      Math.abs(line.height - next.height) <= Math.max(1, medianH * 0.2);
    const keepHeading = sameHeadingBand && !largeGap && !columnRestart && !columnJumpUp;
    if (keepHeading) continue;
    if (regionRestart || columnRestart || columnJumpUp || largeGap || shortEnd || role !== "paragraph" || nextRole !== "paragraph") flush(role);
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
  const text = String(line.text).trim();
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  // A summation limit ("Θ N", "i=1") is not the prose sentence under it.
  if (text.length < 24 && letters <= 2 && (/[ΘΣ∑∫∏√∂ℓ∞]/.test(text) || /^[A-Za-z]?\s*=\s*\d/.test(text))) return true;
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
  if (/^(?:\d+(?:\.\d+)*\s+)?(abstract|introduction|conclusion|references|related work|acknowledgements|acknowledgment|appendix|background|methods|results|discussion)$/i.test(line.text.trim())) return true;
  const nextText = String(next?.text || "").trim();
  const sentenceContinues = /^[a-z(]/.test(nextText) ||
    /\b(?:and|or|of|the|a|an|to|for|with|in|on|by|from|that|as)$/i.test(String(line.text || "").trim()) ||
    /[.!?]["”')\]]*\s+\S/.test(line.text);
  // A body-sized bold first line of a column is still the sentence. A larger
  // heading stays a heading even when the next line is lowercase.
  if (cue && short && !(sentenceContinues && !larger)) return true;
  if (cue && !endsSentence && words.length <= 14 && !(sentenceContinues && !larger)) return true;
  const nextIsLongBody = next && next.text.length >= 40 && !looksAllCaps(next.text) && next.height <= medianH * 1.15;
  // A column's first six words are the sentence, not a heading. "Transformers
  // have a potential of learning" / "longer-term dependency…" is that case.
  // Bold or larger type already returned above. This rule stays for a real
  // short heading whose next line starts a new sentence.
  if (!(short && nextIsLongBody && words.length <= 6)) return false;
  if (sentenceContinues) return false;
  return true;
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
