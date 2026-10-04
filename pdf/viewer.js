import { getDocument, GlobalWorkerOptions } from "./vendor/pdf.min.mjs";
import {
  articleBlocksToMarkdown,
  articleBlocksToPdf,
  canExportReadout,
  downloadBlob,
  translationExportFilename
} from "../lib/export.js";
import {
  DEFAULT_ZOOM,
  PDF_COPY,
  clampZoom,
  ZOOM_CHIP_DRAG_THRESHOLD_PX,
  ZOOM_CHIP_GUTTER_FALLBACK,
  ZOOM_CHIP_INSET,
  ZOOM_CHIP_STORAGE_KEY,
  MIRROR_ZOOM_STORAGE_KEY,
  MIRROR_ZOOM_CHIP_POS_KEY,
  abortTranslateSession,
  applyDraftTranslations,
  canvasOutputScale,
  clampZoomChipPos,
  collectArticlePages,
  collectReadoutExportNodes,
  createPageCache,
  createTranslateSession,
  exceedsDragThreshold,
  effectiveScrollbarWidth,
  measureScrollbarWidth,
  normalizeZoomChipPos,
  pdfExportControlState,
  pdfSourceBasename,
  pdfToolbarActionState,
  pdfTranslateBusy,
  blocksForForceRetranslate,
  forceRetranslateOutcome,
  neighborPages,
  nextZoom,
  normalizePdfTranslateScope,
  wheelPageDelta,
  pageBlocksCopy,
  pageFromViewport,
  pageHasTranslation,
  pageIndex,
  pageLabel,
  progressDocumentStatus,
  progressStatus,
  readoutPlaceholder,
  readViewerSrc,
  showsBlockReadout,
  readoutPageSelector,
  shouldSyncReadout,
  textLayerCopy,
  translateDocumentPages,
  translatePageBlocks,
  articleNodeSpec,
  extractPageItems,
  pageCacheKey,
  zoomButtonState,
  zoomChipDefaultPos,
  zoomChipRightClearance,
  zoomLabel
} from "../lib/pdf-viewer.js";
import {
  PANE_SYNC_BEHAVIOR,
  alignScrollTop,
  createScrollSyncGate,
  createSyncOwner,
  createWheelFlipGuard
} from "../lib/pdf-scroll.js";
import {
  appliedSourceSide,
  blockAtAnchor,
  buildBlockPairs,
  createJumpLock,
  decodeSrcRects,
  encodeSrcRects,
  followReducer,
  isUnlockEvent,
  menuNext,
  pageArrivalText,
  pairBoxStyle,
  pairClickKept,
  sourceAnchorScroll,
  sourceFollowScroll,
  sourceHit,
  sourcePageLabel,
  splitKeyStep,
  splitPointerRatio,
  structureRolePairs,
  translationJumpScroll,
  visualPaneOrder
} from "../lib/pdf-pairing.js";
import {
  pagesInTranslateScope,
  PDF_PAPER_GUTTER_X,
  basePageBox,
  paperAvailWidth,
  paperCssPx,
  readoutPaperSize
} from "../lib/pdf-paper.js";
import { describeBodyFont } from "../lib/pdf-body-font.js";
import {
  PDF_READOUT_COPY,
  extractReadoutBlocks,
  mergeReadoutTranslations,
  readoutFlowForPage,
  translatableReadoutUnits
} from "../lib/pdf-readout.js";
import { unwrapLatex, wrapLatexMarkdown } from "../lib/pdf-latex.js";
import {
  CROP_SCALE,
  OCR_PAGE_HINT,
  PROTOCOL,
  applyBlockTranslations,
  blockReadoutPlan,
  displayCropColumnFraction,
  displayFormulaWidthCss,
  blockRenderPieces,
  cropBlockCanvas,
  cropBlockImage,
  isTranslatableBlock,
  isVisualBlock,
  preparePageBlocks,
  translatableBlocks,
  visualAlt
} from "../lib/pdf-blocks.js";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";
import { redrawFormulaGlyphs } from "../lib/pdf-formula-redraw.js";
import {
  LAYOUT_EMPTY_KEY_STATUS,
  LAYOUT_FALLBACK_STATUS,
  LAYOUT_STARTING_STATUS,
  cacheableLayout,
  fetchCloudEnvelope,
  fetchLocalEnvelope,
  layoutCacheKey,
  normalizePdfLayout,
  resolveLayoutMode,
  shouldFetchCloud
} from "../lib/pdf-layout-client.js";
import { blankFormulaMask, boxesInCrop, measureFormulaCrop, textLayerToBlocks } from "../lib/pdf-text-layer.js";
import {
  INLINE_BODY_HARD_MAX,
  READER_SOURCE_BODY_PT,
  displayFormulaColumnPx,
  displayFormulaMinEm,
  formulaScriptPt,
  readerFormulaCssSize
} from "../lib/pdf-formula-size.js";
import {
  READER_FONT_SIZES,
  READER_THEME_LABELS,
  CAPSULE_END_BAND,
  CAPSULE_END_MIN,
  CAPSULE_PAD_X,
  CAPSULE_PAD_X_MIN,
  CAPSULE_START_BAND_MIN,
  CAPSULE_START_FLOOR,
  CAPSULE_START_RELAXED,
  applyReaderFontAction,
  capsuleLabel,
  capsulePlacement,
  capsuleSamplePages,
  reserveCapsuleContent,
  reserveDefaultCapsuleContent,
  stableCapsulePane,
  clearFadeScroll,
  contentPagesForScope,
  defaultSplitRatio,
  formulaScrollLeft,
  indexFormulaScrolls,
  needsFade,
  pageAtAnchor,
  pageBreakLabel,
  planReaderFlow,
  precompositeMultiplyPixels,
  readReaderPrefs,
  readerFontShortcut,
  readerImageBlend,
  readerThemeAriaLabel,
  splitLayout,
  themePaperRgb,
  untranslatedLabel,
  writeReaderPrefs
} from "../lib/pdf-reader-flow.js";
import { canvasMeasure, detectCjkSerif } from "../lib/pdf-reader-cjk.js";
import { attachFontRealNames } from "../lib/pdf-mirror.js";
import {
  assetLayoutCapPx,
  createFormulaRasterCache,
  fitSnappedFormulaCss,
  formulaDevicePixels,
  formulaRasterCacheKey,
  formulaRasterPlan,
  isSourceRedrawBlock,
  visualDisplayCssSize
} from "../lib/pdf-formula-raster.js";
import { applySavedPairs, blockSoftLead, createLibraryWriteQueue, fetchLibraryDocument, isSkipOnlyPage, libraryHoldCopy, libraryProbeFailure, pageSoftStatus, PAGE_STATUS_BIBLIOGRAPHY, pairsFromResults, repairMatrixProjectionPairs, replaceLibraryPagePairs, saveLibraryPage, selectSavedTranslation, storedReadoutBlocks } from "../lib/pdf-library.js";
import {
  applyStructureTranslations,
  authorBylineGridOk,
  isTitlePageCandidate,
  pageTextForStructure,
  resolveTitleStructure,
  structureAuthorsLookTruncated,
  structureTranslateSlots,
  structureTranslationRows
} from "../lib/pdf-structure-schema.js";
import {
  blocksOutsideStructure,
  decorateAbstractHeading,
  renderAuthorGrid,
  renderPdfStructure
} from "../lib/pdf-structure-render.js";

const $ = (id) => document.getElementById(id);
const RENDER_RADIUS = 2;

GlobalWorkerOptions.workerSrc = workerSrc();

let pdfDoc = null;
let pageNum = 1;
let zoom = DEFAULT_ZOOM;
let sourceUrl = "";
let docId = 0;
let restoreGen = 0;
let textGen = 0;
let renderGen = 0;
let pageItems = 0;
let pageOriginals = [];
let pageResults = [];
let translatingPage = 0;
let forceReadoutHold = false;
let pageViews = [];
let scrollTick = 0;
const pageCache = createPageCache();
let libraryArticle = null;
let libraryDoc = null;
let titleStructure = null;
const librarySourceSent = new Set();
const enqueueLibraryWrite = createLibraryWriteQueue();
const layoutCache = new Map();
let session = createTranslateSession();
let zoomChipCustom = false;
let mirrorZoomChipCustom = false;
let exporting = false;
let followState = "on";
let appliedSide = "";
let currentPairId = "";
let jumpPairId = "";
let jumpPart = "";
let arrivalText = "";
let arrivalTimer = 0;
let pairPress = null;
let sourceHotTick = 0;
const jumpLock = createJumpLock();
let followGeneration = 0;
const syncOwner = createSyncOwner();
const wheelFlip = createWheelFlipGuard();
const pdfSyncGate = createScrollSyncGate();
const readoutSyncGate = createScrollSyncGate();
let translateScrollTick = 0;
let viewMode = "readout";
let mirrorZoom = DEFAULT_ZOOM;
let readerPrefs = readReaderPrefs(null);
let readerBlend = readerImageBlend({ supportsMultiply: true, forcedColors: false });

init();

function workerSrc() {
  try {
    if (globalThis.chrome?.runtime?.getURL) {
      return chrome.runtime.getURL("pdf/vendor/pdf.worker.min.mjs");
    }
  } catch {
    /* opened outside the extension */
  }
  return new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
}

function init() {
  $("pick").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", async () => {
    const file = $("file").files?.[0];
    $("file").value = "";
    if (file) await openFile(file);
  });
  $("prev").addEventListener("click", () => {
    noteUserSourceInput();
    goPage(-1);
  });
  $("next").addEventListener("click", () => {
    noteUserSourceInput();
    goPage(1);
  });
  $("zoomOut").addEventListener("click", () => setZoom(nextZoom(zoom, -1)));
  $("zoomIn").addEventListener("click", () => setZoom(nextZoom(zoom, 1)));
  $("mirrorZoomOut")?.addEventListener("click", () => setMirrorZoom(nextZoom(mirrorZoom, -1)));
  $("mirrorZoomIn")?.addEventListener("click", () => setMirrorZoom(nextZoom(mirrorZoom, 1)));
  bindSplitResize();
  initZoomChip();
  initMirrorZoomChip();
  readMirrorZoom().then((saved) => {
    if (saved != null) mirrorZoom = saved;
    applyMirrorZoom();
    refreshFormulaCropsForDisplay();
  });
  watchFormulaRasterRatio();
  document.querySelector(".scope-seg")?.addEventListener("click", onScopeClick);
  document.querySelector(".view-seg")?.addEventListener("click", onViewSegClick);
  $("readerFlow")?.addEventListener("click", onReaderFlowClick);
  $("readerFlow")?.addEventListener("pointerdown", onFlowPointerDown);
  $("readerFlow")?.addEventListener("pointerup", onFlowPointerUp);
  $("pageCapsule")?.addEventListener("click", onPageCapsuleClick);
  $("followSwitch")?.addEventListener("click", toggleFollow);
  $("sourceStatus")?.addEventListener("click", onSourceStatusClick);
  bindReaderChrome();
  bindPaperMetrics();
  bindPaneScroll();
  bindMoreMenu();
  bindSourcePointer();
  watchSourceAvailability();
  $("translatePage").addEventListener("click", () => startTranslate());
  $("retranslatePage").addEventListener("click", () => forceRetranslateCurrentPage());
  $("stopTranslate").addEventListener("click", stopTranslateWork);
  $("restoreOriginal").addEventListener("click", restoreOriginal);
  $("exportMd").addEventListener("click", () => exportReadout("md"));
  $("exportPdf").addEventListener("click", () => exportReadout("pdf"));
  document.addEventListener("keydown", onKey);
  listenProgress();

  const src = readViewerSrc(location.search);
  applyViewMode();
  if (src) {
    sourceUrl = src;
    openFromSrc(src);
  } else {
    setStatus(PDF_COPY.empty);
    updateTranslateControls();
  }
}

function listenProgress() {
  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "OI_TRANSLATE_PROGRESS") {
        applyPageProgress(message);
        sendResponse({ ok: true });
      }
      return true;
    });
  } catch {
    /* opened outside the extension */
  }
}

function applyPageProgress(message) {
  if (forceReadoutHold) return;
  if (!pdfTranslateBusy(session) || !translatingPage) return;
  const current = pageCache.get(docId, translatingPage) || pageResults;
  const next = applyDraftTranslations(session, message, current);
  if (next === current) return;
  pageResults = next;
  pageCache.set(docId, translatingPage, next);
  if (translatingPage === pageNum) pageResults = next;
  renderArticle();
  setStatus(PDF_COPY.polishing);
}

function onKey(event) {
  if (event.key === "Escape" && closeAaPanel()) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && closeMoreMenu(true)) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && clearJumpMark()) {
    event.preventDefault();
    return;
  }
  if (onMenuKey(event)) return;
  if (isUnlockEvent({ type: "keydown", key: event.key })) releaseJumpLock();
  if (event.key === "Enter" && event.target?.classList?.contains("oi-pdf-inline-math")) {
    event.preventDefault();
    jumpTranslationToSource(event.target);
    return;
  }
  const shortcut = readerFontShortcut({
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    inField: eventTargetIsField(event.target),
    editing: Boolean(event.target?.isContentEditable),
    inReader: focusInReader(event.target),
    singleKey: readerPrefs.singleKey !== false
  });
  if (shortcut) {
    event.preventDefault();
    applyReaderFontStep(shortcut);
    return;
  }
  if (eventTargetIsField(event.target) || event.target?.isContentEditable) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const sourceScrollKey = event.key === "ArrowUp" || event.key === "ArrowDown"
    || event.key === "PageUp" || event.key === "PageDown"
    || event.key === "Home" || event.key === "End" || event.key === " ";
  if (sourceScrollKey && focusInSource(event.target)) noteUserSourceInput();
  if (readerPrefs.singleKey !== false && !focusInOpenMenu() && !focusInAaPanel()) {
    if (event.key === "f" || event.key === "F") {
      event.preventDefault();
      toggleFollow();
      return;
    }
    if (event.key === "s" || event.key === "S") {
      event.preventDefault();
      toggleSourceSide();
      return;
    }
  }
  if (event.key === "ArrowLeft") {
    noteUserSourceInput();
    goPage(-1);
  }
  if (event.key === "ArrowRight") {
    noteUserSourceInput();
    goPage(1);
  }
  if (focusInReader(event.target)) return;
  if (event.key === "-" || event.key === "_") setZoom(nextZoom(zoom, -1));
  if (event.key === "+" || event.key === "=") setZoom(nextZoom(zoom, 1));
}

function eventTargetIsField(target) {
  const tag = target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
    || target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}

function focusInReader(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest(".oi-reader, .pane-translate, .aa-panel"));
}

function focusInSource(target) {
  const pane = $("pdfPane");
  if (!pane || !target) return false;
  return target === pane || pane.contains(target);
}

function focusInOpenMenu() {
  const menu = $("moreMenu");
  if (!menu || menu.hidden) return false;
  const active = document.activeElement;
  return Boolean(active && (menu.contains(active) || active === $("moreButton")));
}

function focusInAaPanel() {
  const panel = $("aaPanel");
  if (!panel || panel.hidden) return false;
  const active = document.activeElement;
  return Boolean(active && panel.contains(active));
}

function detectReaderBlend() {
  let supportsMultiply = true;
  let forcedColors = false;
  try {
    supportsMultiply = window.CSS?.supports?.("mix-blend-mode", "multiply") !== false;
  } catch {
    supportsMultiply = true;
  }
  try {
    forcedColors = window.matchMedia?.("(forced-colors: active)")?.matches === true;
  } catch {
    forcedColors = false;
  }
  readerBlend = readerImageBlend({ supportsMultiply, forcedColors });
  return readerBlend;
}

function readerPaperRgb() {
  const el = readerRootEl() || $("aaPanel");
  if (!el || typeof getComputedStyle !== "function") return null;
  const theme = el.dataset.readerTheme || "warm";
  const raw = getComputedStyle(el).getPropertyValue(`--oi-reader-${theme}-paper`);
  return themePaperRgb(raw);
}

function applyReaderImageBlend(img) {
  if (!img) return img;
  const mode = readerBlend || detectReaderBlend();
  img.dataset.rfBlend = mode;
  if (mode !== "precomposite") return img;
  const paper = readerPaperRgb();
  if (!paper || !img.src) return img;
  const source = img.src;
  const image = new Image();
  image.onload = () => {
    if (img.dataset.rfBlend !== "precomposite") return;
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    if (!(canvas.width > 0) || !(canvas.height > 0)) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(image, 0, 0);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    frame.data.set(precompositeMultiplyPixels(frame.data, paper));
    ctx.putImageData(frame, 0, 0);
    img.src = canvas.toDataURL("image/png");
    img.dataset.rfComposited = readerPrefs.theme;
  };
  image.src = source;
  return img;
}

function commitReaderFont(next) {
  if (next === readerPrefs.fontSize) return;
  const anchor = captureReaderAnchor();
  readerPrefs = { ...readerPrefs, fontSize: next };
  persistReaderPrefs();
  applyReaderSurface();
  renderArticle();
  layoutCapsule();
  applyPaperMetrics();
  restoreReaderAnchor(anchor);
}

function applyReaderFontStep(action) {
  commitReaderFont(applyReaderFontAction(readerPrefs.fontSize, action));
}

function setReaderTheme(theme) {
  if (theme === readerPrefs.theme) return;
  readerPrefs = { ...readerPrefs, theme };
  persistReaderPrefs();
  applyReaderSurface();
  if (readerBlend === "precomposite") renderArticle();
}

function persistReaderPrefs() {
  try {
    writeReaderPrefs(localStorage, readerPrefs);
  } catch {
    /* private mode */
  }
}

function readerThemeRoots() {
  return [document.body, readerRootEl(), $("aaPanel")].filter(Boolean);
}

function applyReaderSurface() {
  const size = `${readerPrefs.fontSize}px`;
  for (const el of readerThemeRoots()) {
    el.dataset.readerTheme = readerPrefs.theme;
    el.style.setProperty("--oi-reader-font-size", size);
    el.style.setProperty("--oi-pdf-body-fs", size);
  }
  syncAaPanel();
}

const CJK_CACHE_KEY = "oi.reader.cjk";

function applyCjkMode(mode) {
  for (const el of readerThemeRoots()) el.dataset.readerCjk = mode;
  const hint = $("aaFontHint");
  if (hint) hint.hidden = mode !== "sans";
}

function runCjkDetect() {
  const mode = detectCjkSerif(canvasMeasure()).serif ? "serif" : "sans";
  try { sessionStorage.setItem(CJK_CACHE_KEY, mode); } catch { /* private mode */ }
  applyCjkMode(mode);
  return mode;
}

function initCjkMode() {
  const forced = new URLSearchParams(location.search).get("cjk");
  if (forced === "sans" || forced === "serif") {
    applyCjkMode(forced);
    return;
  }
  let cached = null;
  try { cached = sessionStorage.getItem(CJK_CACHE_KEY); } catch { /* private mode */ }
  if (cached === "serif" || cached === "sans") applyCjkMode(cached);
  else runCjkDetect();
  document.fonts?.addEventListener?.("loadingdone", () => {
    const prev = document.body.dataset.readerCjk;
    if (runCjkDetect() === prev) return;
    const anchor = captureReaderAnchor();
    layoutCapsule();
    restoreReaderAnchor(anchor);
  });
}

function loadReaderPrefs() {
  try {
    readerPrefs = readReaderPrefs(localStorage);
  } catch {
    readerPrefs = readReaderPrefs(null);
  }
  detectReaderBlend();
  applyReaderSurface();
  applyStoredSplitRatio();
  followState = readerPrefs.follow === false ? "off" : "on";
  const workspace = document.querySelector(".workspace");
  if (workspace) workspace.dataset.follow = followState;
  applySourceSide(false);
  syncFollowControls();
}

function syncAaPanel() {
  const value = $("aaFontValue");
  if (value) value.textContent = `${readerPrefs.fontSize}px`;
  const down = $("aaFontDown");
  const up = $("aaFontUp");
  const reset = $("aaFontDefault");
  if (down) down.disabled = readerPrefs.fontSize <= READER_FONT_SIZES[0];
  if (up) up.disabled = readerPrefs.fontSize >= READER_FONT_SIZES[READER_FONT_SIZES.length - 1];
  if (reset) reset.disabled = readerPrefs.fontSize === 16;
  document.querySelectorAll("#aaFontScale [data-size]").forEach((tick) => {
    const on = Number(tick.dataset.size) === readerPrefs.fontSize;
    tick.setAttribute("aria-checked", on ? "true" : "false");
    tick.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll("#aaThemes [data-theme]").forEach((swatch) => {
    const on = swatch.dataset.theme === readerPrefs.theme;
    swatch.setAttribute("aria-checked", on ? "true" : "false");
    swatch.tabIndex = on ? 0 : -1;
    const mark = swatch.querySelector(".aa-swatch-check");
    if (mark) mark.hidden = !on;
  });
  const single = $("aaSingleKey");
  if (single) single.checked = readerPrefs.singleKey !== false;
}

function buildAaScale() {
  const scale = $("aaFontScale");
  if (!scale || scale.childElementCount) return;
  for (const size of READER_FONT_SIZES) {
    const tick = document.createElement("button");
    tick.type = "button";
    tick.className = "aa-tick";
    tick.dataset.size = String(size);
    tick.setAttribute("role", "radio");
    tick.setAttribute("aria-checked", size === readerPrefs.fontSize ? "true" : "false");
    tick.tabIndex = size === readerPrefs.fontSize ? 0 : -1;
    const mark = document.createElement("span");
    mark.className = "aa-tick-mark";
    mark.setAttribute("aria-hidden", "true");
    const num = document.createElement("span");
    num.textContent = String(size);
    tick.append(mark, num);
    if (size === 16) {
      const note = document.createElement("span");
      note.className = "aa-tick-note";
      note.textContent = "默认";
      tick.append(note);
    }
    scale.append(tick);
  }
}

function buildAaThemes() {
  const group = $("aaThemes");
  if (!group || group.childElementCount) return;
  for (const theme of ["warm", "white", "sepia", "green"]) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "aa-swatch";
    swatch.dataset.theme = theme;
    swatch.setAttribute("role", "radio");
    swatch.setAttribute("aria-label", readerThemeAriaLabel(theme));
    swatch.setAttribute("aria-checked", "false");
    const chip = document.createElement("span");
    chip.className = "aa-swatch-chip";
    chip.textContent = "文";
    const check = document.createElement("span");
    check.className = "aa-swatch-check";
    check.textContent = "✓";
    check.hidden = true;
    chip.append(check);
    const name = document.createElement("span");
    name.textContent = READER_THEME_LABELS[theme];
    swatch.append(chip, name);
    group.append(swatch);
  }
}

function openAaPanel() {
  const panel = $("aaPanel");
  const button = $("aaButton");
  if (!panel) return;
  panel.hidden = false;
  if (button) button.setAttribute("aria-expanded", "true");
  syncAaPanel();
}

function closeAaPanel() {
  const panel = $("aaPanel");
  if (!panel || panel.hidden) return false;
  panel.hidden = true;
  const button = $("aaButton");
  if (button) {
    button.setAttribute("aria-expanded", "false");
    button.focus();
  }
  return true;
}

function onAaFontScaleKey(event) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
  const index = READER_FONT_SIZES.indexOf(readerPrefs.fontSize);
  const next = READER_FONT_SIZES[Math.min(READER_FONT_SIZES.length - 1, Math.max(0, index + delta))];
  commitReaderFont(next);
  $("aaFontScale")?.querySelector(`[data-size="${next}"]`)?.focus();
}

function onAaThemeKey(event) {
  const order = ["warm", "white", "sepia", "green"];
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
  const index = Math.max(0, order.indexOf(readerPrefs.theme));
  const next = order[Math.min(order.length - 1, Math.max(0, index + delta))];
  setReaderTheme(next);
  $("aaThemes")?.querySelector(`[data-theme="${next}"]`)?.focus();
}

function bindReaderChrome() {
  buildAaScale();
  buildAaThemes();
  initCjkMode();
  loadReaderPrefs();
  $("aaButton")?.addEventListener("click", () => {
    const panel = $("aaPanel");
    if (!panel) return;
    if (panel.hidden) openAaPanel();
    else closeAaPanel();
  });
  $("aaFontDown")?.addEventListener("click", () => applyReaderFontStep("decrease"));
  $("aaFontUp")?.addEventListener("click", () => applyReaderFontStep("increase"));
  $("aaFontDefault")?.addEventListener("click", () => {
    commitReaderFont(16);
  });
  $("aaFontScale")?.addEventListener("click", (event) => {
    const tick = event.target.closest?.("[data-size]");
    if (!tick) return;
    const size = Number(tick.dataset.size);
    if (!READER_FONT_SIZES.includes(size)) return;
    commitReaderFont(size);
  });
  $("aaFontScale")?.addEventListener("keydown", onAaFontScaleKey);
  $("aaThemes")?.addEventListener("click", (event) => {
    const swatch = event.target.closest?.("[data-theme]");
    if (!swatch) return;
    setReaderTheme(swatch.dataset.theme);
  });
  $("aaThemes")?.addEventListener("keydown", onAaThemeKey);
  $("aaSingleKey")?.addEventListener("change", () => {
    readerPrefs = { ...readerPrefs, singleKey: $("aaSingleKey").checked };
    persistReaderPrefs();
  });
  document.addEventListener("click", (event) => {
    const panel = $("aaPanel");
    if (!panel || panel.hidden) return;
    const target = event.target;
    if (panel.contains(target) || $("aaButton")?.contains(target)) return;
    panel.hidden = true;
    $("aaButton")?.setAttribute("aria-expanded", "false");
  });
}

function bindPaneScroll() {
  const pdf = pdfScrollRoot();
  const readout = translateScrollRoot();
  pdf.addEventListener("scroll", onPdfScroll, { passive: true });
  pdf.addEventListener("scrollend", onPdfScrollEnd, { passive: true });
  pdf.addEventListener("pointerdown", onSourceSurfaceDown, { passive: true });
  pdf.addEventListener("wheel", onPaneWheelUnlock, { passive: true });
  pdf.addEventListener("touchstart", onSourceContentTouchStart, { passive: true });
  pdf.addEventListener("touchmove", onSourceContentTouchMove, { passive: true });
  pdf.addEventListener("touchend", onSourceContentTouchEnd, { passive: true });
  pdf.addEventListener("touchcancel", onSourceContentTouchEnd, { passive: true });
  $("pdfPane").addEventListener("wheel", onPdfWheel, { passive: true });
  readout?.addEventListener("scroll", onTranslateScroll, { passive: true });
  readout?.addEventListener("scrollend", onReadoutScrollEnd, { passive: true });
  readout?.addEventListener("wheel", onReadoutWheel, { passive: true });
  readout?.addEventListener("pointerdown", onTranslationSurfaceDown, { passive: true });
}

function takeDriver(side) {
  if (syncOwner.owner !== side) followGeneration += 1;
  syncOwner.claim(side);
}

function pdfScrollRoot() {
  return $("pages");
}

function translateScrollRoot() {
  return $("translateScroll") || document.querySelector(".pane-translate");
}

function bindSplitResize() {
  const workspace = document.querySelector(".workspace");
  const handle = document.querySelector(".split-handle");
  if (!workspace || !handle) return;
  handle.addEventListener("pointerdown", (event) => startSplitDrag(event, workspace, handle));
  handle.addEventListener("dblclick", () => resetSplit(workspace));
  handle.addEventListener("keydown", (event) => onSplitKey(event, workspace));
  window.addEventListener("resize", () => syncSplitAria(workspace));
}

/** Apply the stored fraction after prefs load. CSS minmax keeps the minimum widths. */
function applyStoredSplitRatio() {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const width = workspace.getBoundingClientRect().width || window.innerWidth || 1200;
  const ratio = readerPrefs.splitRatio == null ? defaultSplitRatio(width) : readerPrefs.splitRatio;
  workspace.style.setProperty("--oi-split-ratio", String(ratio));
  const handle = workspace.querySelector(".split-handle");
  if (handle && ratio > 0 && ratio < 1) {
    handle.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  }
}

function startSplitDrag(event, workspace, handle) {
  if (event.button !== 0) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  workspace.classList.add("is-splitting");
  const onMove = (moveEvent) => applySplit(workspace, moveEvent.clientX);
  const onUp = () => {
    workspace.classList.remove("is-splitting");
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    persistSplitRatio(workspace);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  applySplit(workspace, event.clientX);
}

function paintSplitRatio(workspace, ratio) {
  const rect = workspace.getBoundingClientRect();
  const width = rect.width || window.innerWidth || 1200;
  const requested = Number(ratio);
  const safe = Number.isFinite(requested) ? requested : defaultSplitRatio(width);
  if (!(rect.width > 0)) {
    const held = requested > 0 && requested < 1 ? requested : defaultSplitRatio(width);
    workspace.style.setProperty("--oi-split-ratio", String(Math.round(held * 10000) / 10000));
    return;
  }
  const layout = splitLayout({ width, ratio: safe, splitW: splitColumnWidth(workspace) });
  workspace.style.setProperty("--oi-split-ratio", String(layout.ratio));
  const handle = workspace.querySelector(".split-handle");
  if (handle) handle.setAttribute("aria-valuenow", String(Math.round(layout.ratio * 100)));
}

function persistSplitRatio(workspace) {
  const ratio = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio"));
  if (!Number.isFinite(ratio)) return;
  readerPrefs = { ...readerPrefs, splitRatio: ratio };
  persistReaderPrefs();
}

function resetSplit(workspace) {
  const width = workspace.getBoundingClientRect().width || window.innerWidth || 1200;
  paintSplitRatio(workspace, defaultSplitRatio(width));
  persistSplitRatio(workspace);
  syncZoomChip();
  syncMirrorZoomChip();
  applyPaperMetrics();
  layoutCapsule({ keepAnchor: true });
}

function syncSplitAria(workspace) {
  const handle = workspace.querySelector(".split-handle");
  const pdf = workspace.querySelector(".pane-pdf");
  if (!handle || !pdf) return;
  const splitW = splitColumnWidth(workspace);
  const available = Math.max(1, workspace.clientWidth - splitW);
  const ratio = pdf.getBoundingClientRect().width / available;
  if (ratio > 0 && ratio < 1) handle.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
}

function onSplitKey(event, workspace) {
  const width = workspace.getBoundingClientRect().width;
  if (width < 900) return;
  const splitW = splitColumnWidth(workspace);
  const available = Math.max(1, width - splitW);
  const current = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio")) || defaultSplitRatio(width);
  const layout = splitLayout({ width, ratio: current, splitW });
  let next = null;
  const step = splitKeyStep({ key: event.key, shift: event.shiftKey, side: appliedSide === "end" ? "end" : "start" });
  if (!step) return;
  if (step.to === "min") next = 0;
  else if (step.to === "max") next = 1;
  else if (step.to === "reset") {
    event.preventDefault();
    resetSplit(workspace);
    return;
  } else if (Number.isFinite(step.delta)) next = (layout.source + step.delta) / available;
  else return;
  event.preventDefault();
  paintSplitRatio(workspace, next);
  persistSplitRatio(workspace);
  syncZoomChip();
  syncMirrorZoomChip();
  applyPaperMetrics();
  layoutCapsule({ keepAnchor: true });
}

function splitColumnWidth(workspace) {
  const raw = getComputedStyle(workspace).getPropertyValue("--oi-reader-split-w");
  const width = parseFloat(raw);
  return Number.isFinite(width) && width > 0 ? width : 8;
}

function applySplit(workspace, clientX) {
  const rect = workspace.getBoundingClientRect();
  if (rect.width < 900) return;
  const splitW = splitColumnWidth(workspace);
  const ratio = splitPointerRatio({
    clientX,
    rect: { x: rect.x, width: rect.width, end: rect.x + rect.width },
    splitW,
    side: appliedSide === "end" ? "end" : "start"
  });
  paintSplitRatio(workspace, ratio);
  syncZoomChip();
  syncMirrorZoomChip();
  applyPaperMetrics();
  layoutCapsule({ keepAnchor: true });
}

function initZoomChip() {
  const chip = $("zoomChip");
  const pane = $("pdfPane");
  if (!chip || !pane) return;
  bindZoomChipDrag(chip, pane);
  chip.addEventListener(
    "click",
    (event) => {
      if (chip.dataset.oiDragged !== "1") return;
      delete chip.dataset.oiDragged;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
  readZoomChipPos().then((saved) => {
    zoomChipCustom = Boolean(saved);
    placeZoomChip(saved, { persist: false });
    requestAnimationFrame(() => placeZoomChip(zoomChipCustom ? currentZoomChipPos() || saved : null, { persist: false }));
  });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => syncZoomChip()).observe(pane);
  }
  window.addEventListener("resize", () => syncZoomChip());
}

function syncZoomChip() {
  placeZoomChip(zoomChipCustom ? currentZoomChipPos() : null, { persist: false });
}

function currentZoomChipPos() {
  const chip = $("zoomChip");
  if (!chip) return null;
  return normalizeZoomChipPos({
    left: parseFloat(chip.style.left),
    top: parseFloat(chip.style.top)
  });
}

function placeZoomChip(pos, { persist = false } = {}) {
  const chip = $("zoomChip");
  const pane = $("pdfPane");
  const pages = $("pages");
  if (!chip || !pane) return null;
  const gutter = Math.max(ZOOM_CHIP_GUTTER_FALLBACK, effectiveScrollbarWidth(pages));
  const box = {
    width: chip.offsetWidth || 0,
    height: chip.offsetHeight || 0,
    paneWidth: pane.clientWidth || 0,
    paneHeight: pane.clientHeight || 0,
    inset: ZOOM_CHIP_INSET,
    rightInset: zoomChipRightClearance({ inset: ZOOM_CHIP_INSET, gutter })
  };
  const next = pos
    ? clampZoomChipPos({ ...box, left: pos.left, top: pos.top })
    : zoomChipDefaultPos({
        paneWidth: box.paneWidth,
        paneHeight: box.paneHeight,
        chipWidth: box.width,
        chipHeight: box.height,
        gutter: ZOOM_CHIP_GUTTER_FALLBACK,
        inset: ZOOM_CHIP_INSET
      });
  chip.classList.add("is-free");
  chip.style.left = `${next.left}px`;
  chip.style.top = `${next.top}px`;
  chip.style.right = "auto";
  chip.style.bottom = "auto";
  if (persist) persistZoomChipPos(next);
  return next;
}

async function readZoomChipPos() {
  try {
    const get = globalThis.chrome?.storage?.local?.get;
    if (typeof get === "function") {
      const bag = await get(ZOOM_CHIP_STORAGE_KEY);
      const stored = normalizeZoomChipPos(bag?.[ZOOM_CHIP_STORAGE_KEY]);
      if (stored) return stored;
    }
  } catch {
    /* opened outside the extension */
  }
  try {
    return normalizeZoomChipPos(JSON.parse(localStorage.getItem(ZOOM_CHIP_STORAGE_KEY)));
  } catch {
    return null;
  }
}

function persistZoomChipPos(pos) {
  const payload = normalizeZoomChipPos(pos);
  if (!payload) return;
  zoomChipCustom = true;
  try {
    localStorage.setItem(ZOOM_CHIP_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* private mode / quota */
  }
  try {
    globalThis.chrome?.storage?.local?.set?.({ [ZOOM_CHIP_STORAGE_KEY]: payload });
  } catch {
    /* opened outside the extension */
  }
}

function bindZoomChipDrag(chip, pane) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let grabX = 0;
  let grabY = 0;
  let armed = false;
  let dragging = false;
  const moveOpts = { capture: true, passive: false };

  const onMove = (event) => {
    if (!armed || event.pointerId !== pointerId) return;
    if (!dragging) {
      if (!exceedsDragThreshold(event.clientX - startX, event.clientY - startY, ZOOM_CHIP_DRAG_THRESHOLD_PX)) {
        return;
      }
      dragging = true;
      chip.classList.add("is-dragging");
      try {
        chip.setPointerCapture(event.pointerId);
      } catch {
        /* capture is optional */
      }
    }
    event.preventDefault();
    followZoomChip(chip, pane, event.clientX, event.clientY, grabX, grabY);
  };

  const finish = (event) => {
    if (!armed || event.pointerId !== pointerId) return;
    const wasDragging = dragging;
    armed = false;
    dragging = false;
    pointerId = null;
    window.removeEventListener("pointermove", onMove, moveOpts);
    window.removeEventListener("pointerup", finish, moveOpts);
    window.removeEventListener("pointercancel", finish, moveOpts);
    if (!wasDragging) return;
    chip.classList.remove("is-dragging");
    const paneRect = pane.getBoundingClientRect();
    const rect = chip.getBoundingClientRect();
    placeZoomChip({ left: rect.left - paneRect.left, top: rect.top - paneRect.top }, { persist: true });
    chip.dataset.oiDragged = "1";
    setTimeout(() => {
      delete chip.dataset.oiDragged;
    }, 0);
  };

  chip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointerId = event.pointerId;
    armed = true;
    dragging = false;
    startX = event.clientX;
    startY = event.clientY;
    const rect = chip.getBoundingClientRect();
    grabX = event.clientX - rect.left;
    grabY = event.clientY - rect.top;
    window.addEventListener("pointermove", onMove, moveOpts);
    window.addEventListener("pointerup", finish, moveOpts);
    window.addEventListener("pointercancel", finish, moveOpts);
  });
}

function followZoomChip(chip, pane, clientX, clientY, grabX, grabY) {
  const paneRect = pane.getBoundingClientRect();
  placeZoomChip(
    {
      left: clientX - grabX - paneRect.left,
      top: clientY - grabY - paneRect.top
    },
    { persist: false }
  );
}

function initMirrorZoomChip() {
  const chip = $("mirrorZoomChip");
  const pane = document.querySelector(".pane-translate");
  if (!chip || !pane) return;
  bindMirrorZoomChipDrag(chip, pane);
  chip.addEventListener(
    "click",
    (event) => {
      if (chip.dataset.oiDragged !== "1") return;
      delete chip.dataset.oiDragged;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );
  readMirrorZoomChipPos().then((saved) => {
    mirrorZoomChipCustom = Boolean(saved);
    placeMirrorZoomChip(saved, { persist: false });
    requestAnimationFrame(() =>
      placeMirrorZoomChip(mirrorZoomChipCustom ? currentMirrorZoomChipPos() || saved : null, { persist: false })
    );
  });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => syncMirrorZoomChip()).observe(pane);
  }
  window.addEventListener("resize", () => syncMirrorZoomChip());
}

function syncMirrorZoomChip() {
  placeMirrorZoomChip(mirrorZoomChipCustom ? currentMirrorZoomChipPos() : null, { persist: false });
}

function currentMirrorZoomChipPos() {
  const chip = $("mirrorZoomChip");
  if (!chip) return null;
  return normalizeZoomChipPos({
    left: parseFloat(chip.style.left),
    top: parseFloat(chip.style.top)
  });
}

function placeMirrorZoomChip(pos, { persist = false } = {}) {
  const chip = $("mirrorZoomChip");
  const pane = document.querySelector(".pane-translate");
  const scroll = translateScrollRoot();
  if (!chip || !pane) return null;
  const gutter = Math.max(ZOOM_CHIP_GUTTER_FALLBACK, effectiveScrollbarWidth(scroll));
  const box = {
    width: chip.offsetWidth || 0,
    height: chip.offsetHeight || 0,
    paneWidth: pane.clientWidth || 0,
    paneHeight: pane.clientHeight || 0,
    inset: ZOOM_CHIP_INSET,
    rightInset: zoomChipRightClearance({ inset: ZOOM_CHIP_INSET, gutter })
  };
  const next = pos
    ? clampZoomChipPos({ ...box, left: pos.left, top: pos.top })
    : zoomChipDefaultPos({
        paneWidth: box.paneWidth,
        paneHeight: box.paneHeight,
        chipWidth: box.width,
        chipHeight: box.height,
        gutter,
        inset: ZOOM_CHIP_INSET
      });
  chip.classList.add("is-free");
  chip.style.left = `${next.left}px`;
  chip.style.top = `${next.top}px`;
  chip.style.right = "auto";
  chip.style.bottom = "auto";
  if (persist) persistMirrorZoomChipPos(next);
  return next;
}

async function readMirrorZoomChipPos() {
  try {
    const get = globalThis.chrome?.storage?.local?.get;
    if (typeof get === "function") {
      const bag = await get(MIRROR_ZOOM_CHIP_POS_KEY);
      const stored = normalizeZoomChipPos(bag?.[MIRROR_ZOOM_CHIP_POS_KEY]);
      if (stored) return stored;
    }
  } catch {
    /* opened outside the extension */
  }
  try {
    return normalizeZoomChipPos(JSON.parse(localStorage.getItem(MIRROR_ZOOM_CHIP_POS_KEY)));
  } catch {
    return null;
  }
}

function persistMirrorZoomChipPos(pos) {
  const payload = normalizeZoomChipPos(pos);
  if (!payload) return;
  mirrorZoomChipCustom = true;
  try {
    localStorage.setItem(MIRROR_ZOOM_CHIP_POS_KEY, JSON.stringify(payload));
  } catch {
    /* private mode / quota */
  }
  try {
    globalThis.chrome?.storage?.local?.set?.({ [MIRROR_ZOOM_CHIP_POS_KEY]: payload });
  } catch {
    /* opened outside the extension */
  }
}

function bindMirrorZoomChipDrag(chip, pane) {
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let grabX = 0;
  let grabY = 0;
  let armed = false;
  let dragging = false;
  const moveOpts = { capture: true, passive: false };

  const onMove = (event) => {
    if (!armed || event.pointerId !== pointerId) return;
    if (!dragging) {
      if (!exceedsDragThreshold(event.clientX - startX, event.clientY - startY, ZOOM_CHIP_DRAG_THRESHOLD_PX)) {
        return;
      }
      dragging = true;
      chip.classList.add("is-dragging");
      try {
        chip.setPointerCapture(event.pointerId);
      } catch {
        /* capture is optional */
      }
    }
    event.preventDefault();
    followMirrorZoomChip(chip, pane, event.clientX, event.clientY, grabX, grabY);
  };

  const finish = (event) => {
    if (!armed || event.pointerId !== pointerId) return;
    const wasDragging = dragging;
    armed = false;
    dragging = false;
    pointerId = null;
    window.removeEventListener("pointermove", onMove, moveOpts);
    window.removeEventListener("pointerup", finish, moveOpts);
    window.removeEventListener("pointercancel", finish, moveOpts);
    if (!wasDragging) return;
    chip.classList.remove("is-dragging");
    const paneRect = pane.getBoundingClientRect();
    const rect = chip.getBoundingClientRect();
    placeMirrorZoomChip({ left: rect.left - paneRect.left, top: rect.top - paneRect.top }, { persist: true });
    chip.dataset.oiDragged = "1";
    setTimeout(() => {
      delete chip.dataset.oiDragged;
    }, 0);
  };

  chip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointerId = event.pointerId;
    armed = true;
    dragging = false;
    startX = event.clientX;
    startY = event.clientY;
    const rect = chip.getBoundingClientRect();
    grabX = event.clientX - rect.left;
    grabY = event.clientY - rect.top;
    window.addEventListener("pointermove", onMove, moveOpts);
    window.addEventListener("pointerup", finish, moveOpts);
    window.addEventListener("pointercancel", finish, moveOpts);
  });
}

function followMirrorZoomChip(chip, pane, clientX, clientY, grabX, grabY) {
  const paneRect = pane.getBoundingClientRect();
  placeMirrorZoomChip(
    {
      left: clientX - grabX - paneRect.left,
      top: clientY - grabY - paneRect.top
    },
    { persist: false }
  );
}

async function readMirrorZoom() {
  try {
    const get = globalThis.chrome?.storage?.local?.get;
    if (typeof get === "function") {
      const bag = await get(MIRROR_ZOOM_STORAGE_KEY);
      const stored = clampZoom(bag?.[MIRROR_ZOOM_STORAGE_KEY]);
      if (bag?.[MIRROR_ZOOM_STORAGE_KEY] != null && stored) return stored;
    }
  } catch {
    /* opened outside the extension */
  }
  try {
    const raw = localStorage.getItem(MIRROR_ZOOM_STORAGE_KEY);
    if (raw == null || raw === "") return null;
    return clampZoom(raw);
  } catch {
    return null;
  }
}

function persistMirrorZoom(scale) {
  const next = clampZoom(scale);
  try {
    localStorage.setItem(MIRROR_ZOOM_STORAGE_KEY, String(next));
  } catch {
    /* private mode / quota */
  }
  try {
    globalThis.chrome?.storage?.local?.set?.({ [MIRROR_ZOOM_STORAGE_KEY]: next });
  } catch {
    /* opened outside the extension */
  }
}

function layoutKey(page) {
  return pageCacheKey(docId, page);
}

function getPageLayout(page) {
  return layoutCache.get(layoutKey(page)) || null;
}

function setPageLayout(page, layout) {
  if (layout) noteFormulaCropPlan(layout);
  layoutCache.set(layoutKey(page), layout);
}

function appendReadoutNode(input, parent) {
  if (!parent) return null;
  const spec = articleNodeSpec(input);
  const node = document.createElement(spec.tag);
  node.className = spec.className;
  node.textContent = spec.text;
  node.dataset.role = spec.role;
  if (input.page != null && input.page !== "") node.dataset.page = String(input.page);
  if (spec.role === "formula") node.dataset.kind = input.kind || "math";
  if (input.original) node.dataset.sourceText = String(input.original);
  const latex = unwrapLatex(input.latex || "");
  if (spec.role === "formula" && latex) {
    node.dataset.latex = latex;
    node.dataset.mathDisplay = input.display ? "1" : "0";
    node.textContent = input.translation || spec.text || wrapLatexMarkdown(latex, input.display);
  } else if (spec.role === "formula") {
    node.textContent = input.translation || spec.text || PDF_COPY.formulaFallback;
  }
  parent.append(node);
  syncReadoutEmpty(true);
  return node;
}

function renderFormulaNode(node, latex, display) {
  const katex = globalThis.katex;
  if (!katex?.render || !latex) {
    node.textContent = wrapLatexMarkdown(latex, display);
    return;
  }
  try {
    katex.render(latex, node, { throwOnError: false, displayMode: Boolean(display), output: "html" });
  } catch {
    node.textContent = wrapLatexMarkdown(latex, display);
  }
}

let cachedPdfLayout = null;
let pdfBytes = null;
let layoutNotice = "";

function storedEngineOverride() {
  try {
    return localStorage.getItem("oi-pdf-engine") || "";
  } catch {
    return "";
  }
}

function pdfEngineMode() {
  return resolveLayoutMode(cachedPdfLayout, storedEngineOverride());
}

async function loadPdfLayout() {
  if (cachedPdfLayout) return cachedPdfLayout;
  try {
    const res = await runtimeSend({ type: "OI_GET_SETTINGS" });
    cachedPdfLayout = normalizePdfLayout(res?.settings?.pdfLayout);
  } catch {
    cachedPdfLayout = normalizePdfLayout(null);
  }
  return cachedPdfLayout;
}

let samplePagePromise = null;

function loadSamplePage() {
  if (!samplePagePromise) {
    const url = new URL("../tests/fixtures/pdf-blocks/sample-page.json", import.meta.url);
    samplePagePromise = fetch(url).then((res) => {
      if (!res.ok) throw new Error("sample page missing");
      return res.json();
    });
  }
  return samplePagePromise;
}

const formulaRasterPixels = new WeakMap();

function formulaPagePixels(canvas) {
  if (!canvas || typeof canvas.getContext !== "function") return null;
  const cached = formulaRasterPixels.get(canvas);
  if (cached) return cached;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.getImageData !== "function") return null;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  formulaRasterPixels.set(canvas, image);
  return image;
}

/** Ink trim for formula crops only. Never grows past the content-aware bbox. */
function formulaInkBbox(canvas, block) {
  const bbox = block?.bbox;
  if (!Array.isArray(bbox)) return bbox;
  try {
    const image = formulaPagePixels(canvas);
    if (!image) return bbox;
    const measured = measureFormulaCrop(bbox, image, {
      inline: block.display === false || Boolean(block.inlineOf),
      protect: block.formulaInkProtect === true,
      maskBoxes: block.maskBoxes,
      glyphBoxes: block.glyphBoxes
    });
    if (measured?.inkShare) block.inkShare = measured.inkShare;
    return measured?.bbox || bbox;
  } catch {
    return bbox;
  }
}

function imageForVisualBlock(raster, block) {
  if (block?.label === "formula" && block.glyphRedraw) {
    const drawn = redrawFormulaGlyphs(raster?.canvas, block.glyphBoxes, block.bbox);
    if (drawn) return drawn;
  }
  if (block?.label === "formula") block.bbox = formulaInkBbox(raster?.canvas, block);
  return cropFormulaImage(raster?.canvas, block);
}

function cropFormulaImage(canvas, block) {
  if (block?.label !== "formula" || !block.maskBoxes?.length) return cropBlockImage(canvas, block?.bbox);
  const out = cropBlockCanvas(canvas, block?.bbox);
  if (!out) return "";
  paintFormulaMask(out, block.bbox, block);
  try {
    const url = out.toDataURL("image/png");
    out.width = 0;
    out.height = 0;
    return /^data:image\/png;base64,/.test(url) ? url : "";
  } catch {
    return "";
  }
}

/** Grayscale AA. An opaque canvas makes Chrome use LCD subpixel text. */
function formulaDrawContext(canvas) {
  return canvas.getContext("2d");
}

function compositeWhitePaper(context, canvas) {
  if (!context || !canvas) return;
  const previous = context.globalCompositeOperation;
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = previous || "source-over";
}

function paintFormulaMask(canvas, crop, block) {
  if (!canvas || block?.label !== "formula" || !block.maskBoxes?.length) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.getImageData !== "function") return false;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  blankFormulaMask(image, {
    maskBoxes: boxesInCrop(block.maskBoxes, crop),
    glyphBoxes: boxesInCrop(block.glyphBoxes, crop),
    seedBoxes: boxesInCrop(block.seedBoxes, crop)
  });
  ctx.putImageData(image, 0, 0);
  return true;
}

const formulaRasterCache = createFormulaRasterCache();

function formulaPaneMetrics(pageNumber, unitViewport) {
  const unitW = Number(unitViewport?.width) || 0;
  const unitH = Number(unitViewport?.height) || 0;
  const scale = Number(zoom) > 0 ? Number(zoom) : 1;
  const zoomedW = Math.floor(unitW * scale);
  const zoomedH = unitW > 0 ? zoomedW * (unitH / unitW) : 0;
  const fallback = basePageBox({ width: zoomedW, height: zoomedH }, scale);
  const left = leftBaseBox(pageNumber) || fallback;
  const leftWidth = left?.width || 0;
  const leftHeight = left?.height || 0;
  const scroll = translateScrollRoot();
  const avail = paperAvailWidth(scroll?.clientWidth || 0);
  const paper = readoutPaperSize({ leftWidth, leftHeight, availWidth: avail });
  const layout = getPageLayout(pageNumber);
  return {
    pageWidth: unitW,
    pageHeight: unitH,
    leftWidth,
    paperWidth: paper.width > 0 ? paper.width : leftWidth,
    paperHeight: paper.heightBase > 0 ? paper.heightBase : leftHeight,
    mirrorZoom: 1,
    devicePixelRatio: Math.max(1, Number(window.devicePixelRatio) || 1),
    readerFontPx: readerPrefs.fontSize,
    sourceBodyPt: Number(layout?.bodyItemHeight) > 0 ? Number(layout.bodyItemHeight) : READER_SOURCE_BODY_PT,
    columnPx: readerColumnPx()
  };
}

/**
 * Redraw one formula, figure, or table bbox when the CROP_SCALE crop is
 * softer than the CSS box. The page raster stays as it is; a miss keeps
 * that crop. No badge.
 */
async function renderSharpVisualCrop(page, raster, block, pageNumber) {
  if (!page || !isSourceRedrawBlock(block) || !Array.isArray(block.bbox) || !block.imageUrl) return "";
  let unit = null;
  try {
    unit = page.getViewport({ scale: 1 });
  } catch {
    return "";
  }
  const metrics = formulaPaneMetrics(pageNumber, unit);
  const css = visualDisplayCssSize({
    ...metrics,
    block,
    rasterWidth: raster?.pixelWidth,
    rasterHeight: raster?.pixelHeight
  });
  if (!css) return "";
  const formula = block.label === "formula";
  const plan = formula
    ? formulaDevicePixels({
      cssWidth: css.cssWidth / metrics.mirrorZoom,
      cssHeight: css.cssHeight / metrics.mirrorZoom,
      pdfWidth: css.pdfWidth,
      pdfHeight: css.pdfHeight,
      mirrorZoom: metrics.mirrorZoom,
      devicePixelRatio: metrics.devicePixelRatio
    })
    : formulaRasterPlan({
      bbox: block.bbox,
      pageWidth: metrics.pageWidth,
      pageHeight: metrics.pageHeight,
      rasterWidth: raster?.pixelWidth,
      rasterHeight: raster?.pixelHeight,
      cssWidth: css.cssWidth,
      cssHeight: css.cssHeight,
      devicePixelRatio: metrics.devicePixelRatio
    });
  if (!plan || (!formula && plan.reusePageRaster)) return "";
  const key = formulaRasterCacheKey({
    docId,
    page: pageNumber,
    bbox: block.bbox,
    scale: plan.scale,
    devicePixelRatio: metrics.devicePixelRatio
  });
  const cached = formulaRasterCache.get(key);
  if (cached) return cached;
  try {
    if (plan.pixelWidth < 1 || plan.pixelHeight < 1 || !(plan.multiplier > 0)) return "";
    const full = page.getViewport({ scale: plan.scale });
    const rasterW = Number(raster?.pixelWidth) || 0;
    const rasterH = Number(raster?.pixelHeight) || 0;
    const originX = formula
      ? Number(block.bbox[0]) || 0
      : (rasterW > 0 ? (plan.offsetX / plan.multiplier) / rasterW : 0);
    const originY = formula
      ? Number(block.bbox[1]) || 0
      : (rasterH > 0 ? (plan.offsetY / plan.multiplier) / rasterH : 0);
    const viewport = page.getViewport({
      scale: plan.scale,
      offsetX: -originX * full.width,
      offsetY: -originY * full.height
    });
    const canvas = document.createElement("canvas");
    canvas.width = plan.pixelWidth;
    canvas.height = plan.pixelHeight;
    const context = formula ? formulaDrawContext(canvas) : canvas.getContext("2d", { alpha: false });
    if (!context) return "";
    await page.render({ canvasContext: context, viewport }).promise;
    if (formula) compositeWhitePaper(context, canvas);
    paintFormulaMask(canvas, block.bbox, block);
    const url = canvas.toDataURL("image/png");
    canvas.width = 0;
    canvas.height = 0;
    if (!/^data:image\/png;base64,/.test(url)) return "";
    formulaRasterCache.set(key, url);
    return url;
  } catch {
    return "";
  }
}

async function renderSharpFormulaCrop(page, raster, block, pageNumber) {
  return renderSharpVisualCrop(page, raster, block, pageNumber);
}

async function withRasterCrop(raster, page, block, pageNumber) {
  if (!isVisualBlock(block) || !Array.isArray(block.bbox)) return block;
  const next = { ...block };
  next.imageUrl = imageForVisualBlock(raster, next);
  if (next.imageUrl) next.surface = "png";
  if ((next.label === "figure" || next.label === "table") && raster) {
    const cap = assetLayoutCapPx(
      next.bbox,
      raster.pixelWidth || raster.canvas?.width,
      raster.pixelHeight || raster.canvas?.height
    );
    if (cap > 0) next.assetCapPx = cap;
  }
  if (isSourceRedrawBlock(next) && next.imageUrl) {
    const sharp = await renderSharpVisualCrop(page, raster, next, pageNumber);
    if (sharp) {
      next.imageUrl = sharp;
      next.surface = "redraw";
    }
  }
  return next;
}

async function cropLayoutBlocks(raster, page, blocks, pageNumber, isStale) {
  const cropped = [];
  for (const block of blocks || []) {
    if (isStale()) return null;
    cropped.push(await withRasterCrop(raster, page, block, pageNumber));
  }
  return cropped;
}

function cropImage(block) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(block?.imageUrl || "")) return null;
  const img = document.createElement("img");
  img.alt = visualAlt(block.label);
  img.src = block.imageUrl;
  if (block?.surface === "redraw" || block?.surface === "png") {
    img.setAttribute("data-oi-surface", block.surface);
  }
  applyReaderImageBlend(img);
  return img;
}

function formulaPageFraction(block) {
  if (!Array.isArray(block?.bbox) || block.bbox.length < 4) return null;
  const fraction = Number(block.bbox[2]) - Number(block.bbox[0]);
  if (!(fraction > 0) || !Number.isFinite(fraction)) return null;
  return Math.min(1, fraction);
}

function mountDisplayMath(node, block, img, page) {
  const row = document.createElement("div");
  row.className = "oi-pdf-math-row";
  const scroll = document.createElement("div");
  scroll.className = "oi-pdf-math-scroll";
  scroll.tabIndex = 0;
  const clip = document.createElement("div");
  clip.className = "oi-pdf-math-clip";
  const matched = matchedFormulaStyle(block, page);
  if (matched) {
    row.classList.add("is-matched");
    row.style.setProperty("--oi-formula-h", matched.height);
    row.style.setProperty("--oi-formula-ar", matched.aspect);
  } else {
    const pageFraction = formulaPageFraction(block);
    const bboxH = Array.isArray(block?.bbox) ? Number(block.bbox[3]) - Number(block.bbox[1]) : 0;
    const minEm = displayFormulaMinEm(block?.inkShare, block?.scriptShare);
    const width = pageFraction ? displayFormulaWidthCss(pageFraction, bboxH, minEm) : "";
    if (width) row.style.setProperty("--oi-formula-w", width);
  }
  const keep = Number(block?.eqKeep);
  if (keep > 0 && keep < 1) row.style.setProperty("--oi-eq-keep", String(keep));
  clip.append(img);
  scroll.append(clip);
  row.append(scroll);
  if (block?.eqLabel) {
    const num = document.createElement("span");
    num.className = "oi-pdf-eq-num";
    num.textContent = block.eqLabel;
    row.append(num);
  }
  node.append(row);
  requestAnimationFrame(() => {
    if (scroll.scrollWidth > scroll.clientWidth + 1) scroll.classList.add("is-overflowing");
  });
}

function appendCropOrNotice(node, block, imageClass, page) {
  const img = cropImage(block);
  if (img) {
    img.className = imageClass || "oi-pdf-math-crop";
    if (block.label === "formula") {
      mountDisplayMath(node, block, img, page ?? node.dataset.page);
      return;
    }
    if ((block.label === "figure" || block.label === "table") && block.surface === "redraw" && block.assetCapPx > 0) {
      img.style.setProperty("max-width", `min(100%, ${block.assetCapPx}px)`);
      img.style.setProperty("height", "auto");
    }
    const pageFraction = displayCropColumnFraction(block);
    if (pageFraction) img.style.width = displayFormulaWidthCss(pageFraction, Number(block.bbox[3]) - Number(block.bbox[1]));
    node.append(img);
    return;
  }
  const notice = block.label === "formula"
    ? PDF_COPY.formulaFallback
    : `（${visualAlt(block.label)}裁图失败，请查看左栏原页）`;
  node.append(document.createTextNode(notice));
}

function captionNode(block, page, layout) {
  const node = document.createElement("figcaption");
  node.className = "oi-pdf-caption";
  node.dataset.page = String(page);
  node.dataset.blockId = String(block.id || "");
  node.dataset.label = "caption";
  fillBlockText(node, block, layout);
  return node;
}

function fillBlockText(node, block, layout) {
  const lead = blockSoftLead(block);
  if (lead) node.append(document.createTextNode(lead));
  const pieces = blockRenderPieces(block, layout.blocks || []);
  if (!pieces.length) {
    node.append(document.createTextNode(String(block.translation || block.text || "")));
    return;
  }
  pieces.forEach((piece) => {
    if (piece.type === "text") {
      if (piece.text) node.append(document.createTextNode(piece.text));
      return;
    }
    const formula = (layout.blocks || []).find((item) => item.id === piece.blockId);
    const img = cropImage({ ...(formula || {}), imageUrl: piece.src || formula?.imageUrl || "", label: "formula" });
    const span = document.createElement("span");
    span.className = "oi-pdf-inline-math";
    span.tabIndex = 0;
    if (formula?.id) {
      span.dataset.blockId = String(formula.id);
      span.dataset.label = "formula";
      if (node.dataset.page) span.dataset.page = node.dataset.page;
    }
    const matched = matchedFormulaStyle(formula, layout?.page ?? node.dataset.page);
    if (matched) {
      span.classList.add("is-matched");
      if (matched.raised) span.classList.add("is-raised");
      span.style.setProperty("--oi-formula-h", matched.height);
      span.style.setProperty("--oi-formula-ar", matched.aspect);
    } else {
      span.style.setProperty("--oi-pdf-inline-crop-em", `${INLINE_BODY_HARD_MAX}em`);
      span.style.setProperty("--oi-pdf-inline-line-em", `${INLINE_BODY_HARD_MAX}em`);
    }
    if (img) {
      img.className = "oi-pdf-math-crop";
      const keep = Number(formula?.eqKeep);
      if (keep > 0 && keep < 1) {
        const clip = document.createElement("span");
        clip.className = "oi-pdf-math-clip";
        span.style.setProperty("--oi-eq-keep", String(keep));
        clip.append(img);
        span.append(clip);
      } else span.append(img);
    } else span.textContent = PDF_COPY.formulaFallback;
    node.append(span);
  });
}

function unitsForLayout(layout) {
  if (layout?.kind === "blocks") {
    return translatableBlocks(layout.blocks).map((block) => ({
      id: block.id,
      sourceId: block.sourceId,
      text: block.text,
      sourceText: block.sourceText || block.text,
      original: block.text,
      role: block.label,
      label: block.label
    }));
  }
  return translatableReadoutUnits(layout?.blocks);
}

function layoutForReadout(layout) {
  const cached = pageCache.get(docId, layout.page);
  if (!Array.isArray(cached)) return layout;
  return { ...layout, blocks: applyBlockTranslations(layout.blocks, cached) };
}

function appendFixtureReadout(parent, layout, options = {}) {
  const record = titleStructure && titleStructure.docId === docId ? titleStructure : null;
  if (!options.skipStructure && record?.status === "ok" && record.page === layout.page && record.structure) {
    renderPdfStructure(record.structure, parent);
    const rest = blocksOutsideStructure(layout.blocks, record.source || record.structure);
    appendFixtureReadout(parent, { ...layout, blocks: rest }, { skipStructure: true });
    return;
  }
  if (!options.skipStructure && record?.status === "fallback" && record.page === layout.page) {
    parent.dataset.fallback = "1";
  }
  const page = layout.page;
  const blocks = layout.blocks || [];
  const hasFigure = blocks.some((block) => block.label === "figure");
  if (layout.textSource === "ocr") {
    const note = document.createElement("p");
    note.className = "oi-pdf-p";
    note.dataset.page = String(page);
    note.dataset.label = "note";
    note.textContent = OCR_PAGE_HINT;
    parent.append(note);
  }
  const used = new Set();
  for (const block of blocks) {
    if (block.inlineOf || used.has(block.id)) continue;
    if (block.presentation === "byline") {
      const run = [];
      for (let index = blocks.indexOf(block); index < blocks.length; index += 1) {
        const item = blocks[index];
        if (item.presentation !== "byline" || used.has(item.id)) break;
        run.push(item);
        used.add(item.id);
      }
      const cells = run.map((item) => item.authorCell).filter((cell) => cell?.name);
      if (cells.length === run.length && authorBylineGridOk(cells, pageTextForStructure(blocks))) {
        renderAuthorGrid(parent, cells);
      } else {
        const node = document.createElement("p");
        node.className = "oi-pdf-p";
        node.dataset.role = "authors";
        node.dataset.page = String(page);
        node.textContent = run.map((item) => {
          const cell = item.authorCell;
          if (!cell?.name) return item.text || "";
          return [cell.name, cell.affiliation, cell.email].filter(Boolean).join(" ");
        }).filter(Boolean).join(" ");
        parent.append(node);
      }
      continue;
    }
    const paired = block.label === "caption" ? blocks.find((item) => item.id === block.captionFor) : null;
    const visual = (block.label === "figure" || block.label === "table") ? block : paired;
    if (visual && (block.label === "figure" || block.label === "table" || block.label === "caption")) {
      const caption = blocks.find((item) => item.captionFor === visual.id);
      used.add(visual.id);
      if (caption) used.add(caption.id);
      const plan = blockReadoutPlan(visual);
      const node = document.createElement(plan.tag);
      node.className = plan.className;
      node.dataset.page = String(page);
      node.dataset.blockId = String(visual.id || "");
      node.dataset.label = String(visual.label || "");
      const capNode = caption ? captionNode(caption, page, layout) : null;
      if (capNode && caption && blocks.indexOf(caption) < blocks.indexOf(visual)) node.append(capNode);
      appendCropOrNotice(node, visual, plan.imageClass, page);
      if (capNode && caption && blocks.indexOf(caption) > blocks.indexOf(visual)) node.append(capNode);
      parent.append(node);
      continue;
    }
    if (block.label === "caption" && !hasFigure) {
      const slot = document.createElement("p");
      slot.className = "oi-pdf-p";
      slot.dataset.page = String(page);
      slot.dataset.label = "figure";
      slot.textContent = PDF_READOUT_COPY.figurePlaceholder;
      parent.append(slot);
    }
    const plan = blockReadoutPlan(block);
    const node = document.createElement(plan.tag);
    node.className = plan.className;
    if (plan.role) node.dataset.role = plan.role;
    node.dataset.page = String(page);
    node.dataset.blockId = String(block.id || "");
    node.dataset.label = String(block.label || "");
    if (block.translationStatus) node.dataset.translationStatus = block.translationStatus;
    if (plan.image) appendCropOrNotice(node, block, plan.imageClass, page);
    else fillBlockText(node, block, layout);
    if (block.label === "heading") {
      decorateAbstractHeading(node, block.text);
      decorateAbstractHeading(node, block.translation);
    }
    parent.append(node);
  }
}

function onReadoutBlockClick(event) {
  const node = pairNodeFromEvent(event);
  if (!node) return;
  const behavior = PANE_SYNC_BEHAVIOR;
  if (behavior !== "auto") return;
  takeDriver("click");
  jumpTranslationToSource(node);
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
  return String(value).replace(/"/g, "\\'");
}

function pairNodeFromEvent(event) {
  if (pairControlBlocked(event)) return null;
  const node = event.target?.closest?.("[data-pair-id]");
  if (!node || node.closest("#pages")) return null;
  return node;
}

function pairControlBlocked(event) {
  const target = event?.target;
  if (!target?.closest) return false;
  if (target.closest("button, a, input, textarea, select, [role='button']")) return true;
  const scroller = target.closest(".oi-pdf-math-scroll, .oi-pdf-inline-math.is-raised");
  if (scroller && target === scroller && event.offsetY > scroller.clientHeight) return true;
  return false;
}

function selectionIsCollapsed() {
  const sel = window.getSelection?.();
  return !sel || sel.isCollapsed;
}

function onFlowPointerDown(event) {
  if (event.button != null && event.button !== 0) return;
  const interactive = event.target.closest?.("button, a, input, textarea, select, [role='button']");
  if (!interactive) $("readerFlow")?.focus({ preventScroll: true });
  pairPress = { x: event.clientX, y: event.clientY };
}

function onFlowPointerUp(event) {
  const press = pairPress;
  pairPress = null;
  if (!press) return;
  if (!pairClickKept({
    dx: event.clientX - press.x,
    dy: event.clientY - press.y,
    collapsed: selectionIsCollapsed(),
    blocked: pairControlBlocked(event)
  })) return;
  onReadoutBlockClick(event);
}

function onFlowKey(event) {
  if (event.key !== "Enter") return;
  if (!event.target?.classList?.contains("oi-pdf-inline-math")) return;
  event.preventDefault();
  jumpTranslationToSource(event.target);
}

function jumpTranslationToSource(node) {
  if (!node?.dataset?.pairId) return;
  const part = node.dataset.pairPart === "inline" ? "inline" : "";
  const rects = decodeSrcRects(node.dataset.srcRects);
  const rect = rects[0];
  if (!rect) {
    const page = Number(node.dataset.page || node.dataset.srcPage);
    if (page >= 1) revealSourcePage(page);
    return;
  }
  const before = translateScrollRoot()?.scrollTop;
  scrollSourceToRect(rect, part === "inline" ? 2 : 5);
  if (translateScrollRoot() && Number.isFinite(before)) translateScrollRoot().scrollTop = before;
  currentPairId = node.dataset.pairId;
  jumpPairId = node.dataset.pairId;
  jumpPart = part;
  applyFollow({ type: "clickJump" });
  armJumpLock();
  paintPairChrome();
  ensureSourcePage(Number(rect.p));
}

function revealSourcePage(page) {
  const wrap = document.querySelector(`#pages .pdf-page[data-page="${page}"]`);
  const pane = pdfScrollRoot();
  if (wrap && pane) {
    const top = alignScrollTop(pane, wrap);
    if (Number.isFinite(top)) pane.scrollTop = Math.max(0, top);
  }
  arrivalText = pageArrivalText(page);
  syncFollowControls();
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(() => {
    arrivalText = "";
    syncFollowControls();
  }, JUMP_HOLD_MS());
}

function JUMP_HOLD_MS() {
  return 1500;
}

function ensureSourcePage(page) {
  if (!pdfDoc || !Number.isFinite(page) || page < 1 || page === pageNum) return;
  if (currentScope() === "all") return;
  pageNum = page;
  updatePager();
  loadCurrentPageText();
}

function scrollSourceToRect(rect) {
  const pane = pdfScrollRoot();
  const placed = rectInSource(rect);
  if (!pane || !placed) return false;
  const top = sourceAnchorScroll({
    rectTop: placed.top,
    clientHeight: pane.clientHeight,
    scrollHeight: pane.scrollHeight
  });
  takeDriver("click");
  pane.scrollTop = top;
  noteSourcePage(false);
  return true;
}

function rectInSource(rect) {
  const page = Number(rect?.p);
  const wrap = pageViews[page - 1]?.wrap || document.querySelector(`#pages .pdf-page[data-page="${page}"]`);
  const pane = pdfScrollRoot();
  if (!wrap || !pane) return null;
  const size = pagePointSize(page);
  if (!size) return null;
  const paneBox = pane.getBoundingClientRect();
  const wrapBox = wrap.getBoundingClientRect();
  const scaleY = wrapBox.height / size.height;
  const scaleX = wrapBox.width / size.width;
  const top = pane.scrollTop + (wrapBox.top - paneBox.top) + rect.y * scaleY;
  return {
    top,
    bottom: top + rect.h * scaleY,
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    w: rect.w * scaleX,
    h: rect.h * scaleY,
    scaleX,
    scaleY
  };
}

function pagePointSize(page) {
  const layout = getPageLayout(page);
  const width = Number(layout?.pageWidth) || 0;
  const height = Number(layout?.pageHeight) || 0;
  if (width > 0 && height > 0) return { width, height };
  const wrap = pageViews[page - 1]?.wrap;
  const styled = parseFloat(wrap?.style?.width || "");
  const parts = String(wrap?.style?.aspectRatio || "").split("/").map((part) => parseFloat(part.trim()));
  const zoomScale = Number(zoom) > 0 ? Number(zoom) : 1;
  if (styled > 0 && parts[0] > 0 && parts[1] > 0) {
    return { width: styled / zoomScale, height: (styled * (parts[1] / parts[0])) / zoomScale };
  }
  return null;
}

function writeTranslationJump(node) {
  const pane = translateScrollRoot();
  const own = node?.classList?.contains("rf-block") || node?.classList?.contains("rf-untranslated");
  const block = own ? node : node?.closest?.(".rf-block");
  if (!pane || !block) return false;
  const paneBox = pane.getBoundingClientRect();
  const blockBox = block.getBoundingClientRect();
  const blockTop = pane.scrollTop + (blockBox.top - paneBox.top);
  let top = translationJumpScroll({
    blockTopInContent: blockTop,
    blockHeight: blockBox.height,
    paneHeight: pane.clientHeight,
    scrollHeight: pane.scrollHeight
  });
  pane.scrollTop = top;
  const entries = anchorEntries();
  const offset = anchorOffset(pane);
  top = nudgeScrollToTarget(top, entries, offset, block.dataset.pairId || currentPairId);
  pane.scrollTop = top;
  updateReaderFade();
  updatePageCapsule();
  return true;
}

function nudgeScrollToTarget(proposed, entries, offset, targetId) {
  const at = (value) => blockAtAnchorSafe(entries, value + offset);
  if (!targetId) return proposed;
  if (at(proposed)?.pairId === targetId) return proposed;
  for (const delta of [1, -1]) {
    if (at(proposed + delta)?.pairId === targetId) return proposed + delta;
  }
  return proposed;
}

function anchorOffset(pane) {
  const box = pane.getBoundingClientRect();
  return capsuleAnchorY(pane) - box.top;
}

function anchorEntries() {
  const flow = readerFlowEl();
  const pane = translateScrollRoot();
  if (!flow || !pane) return [];
  const paneBox = pane.getBoundingClientRect();
  return [...flow.querySelectorAll(".rf-block[data-pair-id]")].map((el) => {
    const box = el.getBoundingClientRect();
    return {
      pairId: el.dataset.pairId,
      node: el,
      top: pane.scrollTop + (box.top - paneBox.top),
      bottom: pane.scrollTop + (box.bottom - paneBox.top)
    };
  });
}

function blockAtAnchorSafe(entries, line) {
  return blockAtAnchor(entries, line);
}

function refreshPairCurrent() {
  if (jumpLock.locked) return;
  const pane = translateScrollRoot();
  const flow = readerFlowEl();
  if (!pane || !flow) return;
  const paneBox = pane.getBoundingClientRect();
  const line = pane.scrollTop + anchorOffset(pane);
  const entries = [...flow.querySelectorAll(".rf-block")].map((el) => {
    const box = el.getBoundingClientRect();
    return {
      pairId: el.dataset.pairId || "",
      top: pane.scrollTop + (box.top - paneBox.top),
      bottom: pane.scrollTop + (box.bottom - paneBox.top)
    };
  });
  const hit = blockAtAnchor(entries, line);
  if (!hit?.pairId) {
    const changed = Boolean(currentPairId) || Boolean(jumpPairId);
    currentPairId = "";
    if (jumpPairId) {
      jumpPairId = "";
      jumpPart = "";
    }
    if (changed) paintPairChrome();
    syncFollowControls();
    return;
  }
  const changed = hit.pairId !== currentPairId;
  currentPairId = hit.pairId;
  if (jumpPairId && jumpPairId !== currentPairId) {
    jumpPairId = "";
    jumpPart = "";
    paintPairChrome();
  } else if (changed) paintPairChrome();
  if (followState === "on") followSourceToCurrent();
  syncFollowControls();
}

function followSourceToCurrent() {
  if (followState !== "on" || jumpLock.locked) return;
  if (syncOwner.ignores("readout")) return;
  const rect = firstRectFor(currentPairId);
  const placed = rect ? rectInSource(rect) : null;
  const pane = pdfScrollRoot();
  if (!placed || !pane) return;
  const top = sourceFollowScroll({
    rectTop: placed.top,
    rectBottom: placed.bottom,
    scrollTop: pane.scrollTop,
    clientHeight: pane.clientHeight,
    scrollHeight: pane.scrollHeight
  });
  if (top == null || Math.abs(pane.scrollTop - top) < 1) return;
  takeDriver("readout");
  pane.scrollTop = top;
  noteSourcePage(false);
}

function bringSourceToAnchor() {
  const rect = firstRectFor(currentPairId);
  if (!rect) return;
  scrollSourceToRect(rect, 5);
  paintPairChrome();
}

function firstRectFor(pairId) {
  if (!pairId) return null;
  const flow = readerFlowEl();
  const node = flow?.querySelector(`[data-pair-id="${cssEscape(pairId)}"]`);
  return decodeSrcRects(node?.dataset.srcRects)[0] || null;
}

function currentRectOutside() {
  const rect = firstRectFor(currentPairId);
  const placed = rect ? rectInSource(rect) : null;
  const pane = pdfScrollRoot();
  if (!placed || !pane) return false;
  return sourceFollowScroll({
    rectTop: placed.top,
    rectBottom: placed.bottom,
    scrollTop: pane.scrollTop,
    clientHeight: pane.clientHeight,
    scrollHeight: pane.scrollHeight
  }) != null;
}

function paintPairChrome() {
  document.querySelectorAll("#pages .pair-box").forEach((el) => el.remove());
  const flow = readerFlowEl();
  if (!flow) return;
  flow.querySelectorAll(".is-pair-current, .is-pair-jump").forEach((el) => {
    el.classList.remove("is-pair-current", "is-pair-jump");
  });
  if (currentPairId) {
    flow.querySelectorAll(`[data-pair-id="${cssEscape(currentPairId)}"]`).forEach((el) => {
      if (el.dataset.pairPart === "inline") return;
      el.classList.add("is-pair-current");
    });
  }
  const inlineJump = jumpPairId && jumpPart === "inline";
  if (jumpPairId) {
    const jumpNode = inlineJump
      ? flow.querySelector(`[data-pair-id="${cssEscape(jumpPairId)}"][data-pair-part="inline"]`)
      : flow.querySelector(`[data-pair-id="${cssEscape(jumpPairId)}"]:not([data-pair-part="inline"])`);
    jumpNode?.classList.add("is-pair-jump");
  }
  if (currentPairId && (!jumpPairId || inlineJump)) {
    drawPairBoxes(firstNodeRects(currentPairId), false, 5);
  }
  if (jumpPairId) {
    const node = inlineJump
      ? flow.querySelector(`[data-pair-id="${cssEscape(jumpPairId)}"][data-pair-part="inline"]`)
      : flow.querySelector(`[data-pair-id="${cssEscape(jumpPairId)}"]`);
    const outset = inlineJump ? 2 : 5;
    drawPairBoxes(decodeSrcRects(node?.dataset.srcRects), true, outset);
  }
}

function firstNodeRects(pairId) {
  const flow = readerFlowEl();
  const node = [...(flow?.querySelectorAll(`[data-pair-id="${cssEscape(pairId)}"]`) || [])]
    .find((el) => el.dataset.pairPart !== "inline");
  return decodeSrcRects(node?.dataset.srcRects);
}

function drawPairBoxes(rects, jump, outset) {
  for (const rect of rects || []) {
    const size = pagePointSize(rect.p);
    const wrap = document.querySelector(`#pages .pdf-page[data-page="${rect.p}"]`);
    const style = size ? pairBoxStyle(rect, size.width, size.height, outset) : null;
    if (!wrap || !style) continue;
    const box = document.createElement("div");
    box.className = jump ? "pair-box is-jump" : "pair-box";
    box.style.insetInlineStart = style.x;
    box.style.insetBlockStart = style.y;
    box.style.width = style.w;
    box.style.height = style.h;
    wrap.append(box);
  }
}

function armJumpLock() {
  jumpLock.lock();
  syncJumpLock();
  const wait = Math.max(0, jumpLock.until - Date.now());
  setTimeout(() => {
    if (!jumpLock.locked) syncJumpLock();
  }, wait + 20);
}

function releaseJumpLock() {
  if (!jumpLock.locked && !document.querySelector(".workspace")?.dataset.jumpLock) return;
  jumpLock.unlock();
  syncJumpLock();
}

function syncJumpLock() {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  if (jumpLock.locked) workspace.dataset.jumpLock = "1";
  else delete workspace.dataset.jumpLock;
}

function clearJumpMark() {
  if (!jumpPairId) return false;
  jumpPairId = "";
  jumpPart = "";
  paintPairChrome();
  return true;
}

function applyFollow(event) {
  const result = followReducer(followState, event);
  followState = result.state;
  if (result.persist != null) {
    readerPrefs = { ...readerPrefs, follow: result.persist === "1" };
    persistReaderPrefs();
  }
  const workspace = document.querySelector(".workspace");
  if (workspace) workspace.dataset.follow = followState;
  syncFollowControls();
}

function toggleFollow() {
  if (followState === "unavailable") return;
  const prev = followState;
  applyFollow({ type: "toggle" });
  if (followState === "on" && prev !== "on") bringSourceToAnchor();
}

function noteUserSourceInput() {
  releaseJumpLock();
  applyFollow({ type: "userSourceScroll" });
}

function onSourceStatusClick(event) {
  const action = event.target?.closest?.("button")?.dataset?.action;
  if (action === "resume-follow") {
    applyFollow({ type: "resume" });
    if (followState === "on") bringSourceToAnchor();
  } else if (action === "show-current") {
    bringSourceToAnchor();
  }
}

function syncFollowControls() {
  const sw = $("followSwitch");
  const enabled = followState === "on" || followState === "paused";
  if (sw) {
    sw.setAttribute("aria-checked", enabled ? "true" : "false");
    sw.disabled = followState === "unavailable";
    sw.title = followState === "unavailable"
      ? "原文区已隐藏"
      : "译文栏读到哪，原文栏就跟到哪（f）";
  }
  const slot = $("sourceStatus");
  if (!slot) return;
  slot.replaceChildren();
  if (followState === "paused") {
    slot.append(document.createTextNode("⏸ 跟随已暂停 · "));
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "source-status-btn hit-pad";
    resume.dataset.action = "resume-follow";
    resume.textContent = "恢复";
    slot.append(resume);
    return;
  }
  if (followState === "off" && currentRectOutside()) {
    const show = document.createElement("button");
    show.type = "button";
    show.className = "source-status-btn hit-pad";
    show.dataset.action = "show-current";
    show.textContent = "↧ 当前段";
    slot.append(show);
    return;
  }
  if (arrivalText) slot.textContent = arrivalText;
}

function watchSourceAvailability() {
  const pane = $("pdfPane");
  const sync = () => {
    const box = pane?.getBoundingClientRect();
    applyFollow({
      type: "sourceAvailable",
      available: Boolean(box && box.width > 1 && box.height > 1),
      stored: readerPrefs.follow === false ? "0" : "1"
    });
  };
  if (typeof ResizeObserver === "function" && pane) new ResizeObserver(sync).observe(pane);
  window.addEventListener("resize", () => {
    applySourceSide(true);
    sync();
    paintPairChrome();
  });
  sync();
}

function bindSourcePointer() {
  const pages = $("pages");
  if (!pages) return;
  pages.addEventListener("pointermove", onSourcePointerMoveEvent);
  pages.addEventListener("click", onSourceClick);
}

function onSourceSurfaceDown(event) {
  if (event.target === pdfScrollRoot()) noteUserSourceInput();
  else takeDriver("pdf");
  if (isUnlockEvent({ type: "pointerdown", onScrollSurface: event.target === pdfScrollRoot() })) {
    releaseJumpLock();
  }
}

function onTranslationSurfaceDown(event) {
  takeDriver("readout");
  if (isUnlockEvent({ type: "pointerdown", onScrollSurface: event.target === translateScrollRoot() })) {
    releaseJumpLock();
  }
}

function onPaneWheelUnlock() {
  releaseJumpLock();
}

const SOURCE_TOUCH_PAN_PX = 8;
let sourceTouch = null;

function onSourceContentTouchStart(event) {
  const touch = event.changedTouches?.[0];
  if (!touch || sourceTouch) return;
  sourceTouch = { id: touch.identifier, x: touch.clientX, y: touch.clientY, panned: false };
  releaseJumpLock();
}

function onSourceContentTouchMove(event) {
  if (!sourceTouch || sourceTouch.panned) return;
  const touch = [...(event.changedTouches || [])].find((item) => item.identifier === sourceTouch.id);
  if (!touch) return;
  const distance = Math.hypot(touch.clientX - sourceTouch.x, touch.clientY - sourceTouch.y);
  if (distance <= SOURCE_TOUCH_PAN_PX) return;
  sourceTouch.panned = true;
  noteUserSourceInput();
}

function onSourceContentTouchEnd(event) {
  if (!sourceTouch) return;
  const ended = [...(event.changedTouches || [])].some((item) => item.identifier === sourceTouch.id);
  if (ended) sourceTouch = null;
}

function onSourcePointerMove() {
  if (sourceHotTick) return;
  sourceHotTick = requestAnimationFrame(() => {
    sourceHotTick = 0;
    const pages = $("pages");
    if (!pages) return;
    const hit = sourceHitAt(lastPointer);
    pages.classList.toggle("is-pair-hot", Boolean(hit));
  });
}

let lastPointer = null;
function onSourcePointerMoveEvent(event) {
  lastPointer = event;
  onSourcePointerMove();
}

function sourceHitAt(event) {
  if (!event) return null;
  const pageEl = event.target?.closest?.(".pdf-page");
  if (!pageEl) return null;
  const page = Number(pageEl.dataset.page);
  const size = pagePointSize(page);
  if (!size) return null;
  const box = pageEl.getBoundingClientRect();
  const x = ((event.clientX - box.x) / box.width) * size.width;
  const y = ((event.clientY - box.y) / box.height) * size.height;
  return sourceHit(rectsOnPage(page), { x, y });
}

function rectsOnPage(page) {
  const flow = readerFlowEl();
  if (!flow) return [];
  const out = [];
  flow.querySelectorAll("[data-src-rects]").forEach((node) => {
    for (const rect of decodeSrcRects(node.dataset.srcRects)) {
      if (Number(rect.p) !== page) continue;
      out.push({
        ...rect,
        pairId: node.dataset.pairId,
        part: node.dataset.pairPart || "",
        node
      });
    }
  });
  return out;
}

function onSourceClick(event) {
  const pageEl = event.target?.closest?.(".pdf-page");
  if (!pageEl || event.target?.closest?.("button, a, input, textarea, select")) return;
  const page = Number(pageEl.dataset.page);
  const hit = sourceHitAt(event);
  if (!hit) {
    if (!pageHasFlow(page)) focusUntranslated(page);
    return;
  }
  const node = hit.node;
  const block = node?.classList?.contains("rf-block") ? node : node?.closest?.(".rf-block") || node;
  jumpPairId = hit.pairId;
  jumpPart = hit.part === "inline" ? "inline" : "";
  currentPairId = hit.pairId;
  writeTranslationJump(block);
  applyFollow({ type: "clickJump" });
  armJumpLock();
  paintPairChrome();
  if (followState === "on") scrollSourceToRect(hit, jumpPart === "inline" ? 2 : 5);
}

function pageHasFlow(page) {
  return Boolean(readerFlowEl()?.querySelector(`.rf-block[data-src-page="${page}"], .rf-page[data-src-page="${page}"] .rf-block`));
}

function focusUntranslated(page) {
  const row = readerFlowEl()?.querySelector(`.rf-untranslated[data-src-page="${page}"]`);
  if (!row) return;
  writeTranslationJump(row);
  row.querySelector("[data-action='translate-page']")?.focus();
}

function stampFlowPairs(slot) {
  const page = Number(slot?.dataset?.page || slot?.dataset?.srcPage);
  const layout = getPageLayout(page);
  const blocks = layout?.blocks || [];
  const size = pagePointSize(page);
  if (!slot || !size || !blocks.length) return;
  const built = buildBlockPairs({
    page,
    blocks,
    pageWidth: size.width,
    pageHeight: size.height
  });
  const byId = new Map();
  for (const spec of built.nodes) {
    for (const id of spec.blockIds || []) byId.set(String(id), spec);
  }
  slot.querySelectorAll(".rf-block").forEach((el) => {
    const spec = el.dataset.blockId ? byId.get(String(el.dataset.blockId)) : null;
    if (spec?.pairId && spec.rects?.length) assignPair(el, spec);
  });
  const authors = built.nodes.find((spec) => spec.kind === "authors");
  slot.querySelectorAll("[data-role='authors'], .oi-pdf-authors").forEach((el) => {
    if (!el.dataset.pairId && authors?.pairId) assignPair(el, authors);
  });
  const record = titleStructure && titleStructure.docId === docId ? titleStructure : null;
  if (record?.structure && record.page === page) {
    const roles = structureRolePairs({
      page,
      blocks,
      pageWidth: size.width,
      pageHeight: size.height,
      structure: record.structure
    });
    assignRole(slot, "h1", roles.find((role) => role.role === "title"));
    assignRole(slot, "[data-role='authors'], .oi-pdf-authors", roles.find((role) => role.role === "authors"));
    assignRole(slot, "[data-role='abstract_heading']", roles.find((role) => role.role === "abstract_heading"));
    assignRole(slot, "[data-role='abstract_body']", roles.find((role) => role.role === "abstract_body"));
  }
  for (const spec of built.inlines) {
    const span = slot.querySelector(`.oi-pdf-inline-math[data-block-id="${cssEscape(String(spec.blockId))}"]`);
    if (!span) continue;
    span.dataset.pairId = spec.pairId;
    span.dataset.pairPart = "inline";
    span.dataset.srcRects = encodeSrcRects(spec.rects);
  }
}

function assignPair(el, spec) {
  if (!el || !spec?.pairId || !spec.rects?.length) return;
  el.dataset.pairId = spec.pairId;
  el.dataset.srcRects = encodeSrcRects(spec.rects);
}

function assignRole(slot, selector, spec) {
  const el = slot.querySelector(selector);
  assignPair(el, spec);
}

function applySourceSide(anchor) {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const width = workspace.getBoundingClientRect().width || window.innerWidth || 1200;
  const applied = appliedSourceSide(width, readerPrefs.sourceSide);
  workspace.dataset.sourceSide = applied;
  const changed = applied !== appliedSide;
  appliedSide = applied;
  if (changed) reorderPanes(applied, anchor);
  syncSwapCheck();
  syncSwapItem();
}

function reorderPanes(side, anchor) {
  const workspace = document.querySelector(".workspace");
  const source = $("pdfPane");
  const translation = document.querySelector(".pane-translate");
  const split = document.querySelector(".split-handle");
  if (!workspace || !source || !translation || !split) return;
  const map = { source, translation, split };
  const order = visualPaneOrder(side).map((name) => map[name]);
  const token = anchor ? captureReaderAnchor() : null;
  const sourcePane = $("pages");
  const translationPane = $("translateScroll");
  const saved = {
    sourceTop: sourcePane?.scrollTop || 0,
    sourceAcross: sourcePane?.scrollLeft || 0,
    translationTop: translationPane?.scrollTop || 0,
    translationAcross: translationPane?.scrollLeft || 0
  };
  for (const node of order) workspace.append(node);
  if (sourcePane) {
    sourcePane.scrollTop = saved.sourceTop;
    sourcePane.scrollLeft = saved.sourceAcross;
  }
  if (translationPane) {
    translationPane.scrollTop = saved.translationTop;
    translationPane.scrollLeft = saved.translationAcross;
  }
  if (token) requestAnimationFrame(() => restoreReaderAnchor(token));
}

function toggleSourceSide() {
  readerPrefs = { ...readerPrefs, sourceSide: readerPrefs.sourceSide === "end" ? "start" : "end" };
  persistReaderPrefs();
  applySourceSide(true);
}

function syncSwapCheck() {
  const item = $("swapPanes");
  if (!item) return;
  const on = readerPrefs.sourceSide === "end";
  item.setAttribute("aria-checked", on ? "true" : "false");
}

function syncSwapItem() {
  const item = $("swapPanes");
  const sep = document.querySelector("#moreMenu [role='separator']");
  const narrow = (window.innerWidth || 0) < 900;
  if (item) item.hidden = narrow;
  if (sep) sep.hidden = narrow;
}

function bindMoreMenu() {
  $("moreButton")?.addEventListener("click", () => {
    if (moreMenuOpen()) closeMoreMenu(true);
    else openMoreMenu();
  });
  $("swapPanes")?.addEventListener("click", () => {
    toggleSourceSide();
    closeMoreMenu(true);
  });
  document.addEventListener("pointerdown", (event) => {
    const menu = $("moreMenu");
    const button = $("moreButton");
    if (!moreMenuOpen()) return;
    if (menu?.contains(event.target) || button?.contains(event.target)) return;
    closeMoreMenu(false);
  });
  window.addEventListener("resize", syncSwapItem);
  syncSwapItem();
  syncSwapCheck();
}

function moreMenuOpen() {
  const menu = $("moreMenu");
  return Boolean(menu && !menu.hidden);
}

function openMoreMenu() {
  const menu = $("moreMenu");
  const button = $("moreButton");
  if (!menu || !button) return;
  syncSwapItem();
  menu.hidden = false;
  button.setAttribute("aria-expanded", "true");
  const items = menuEntries();
  const index = menuNext(items.map(menuEntryState), -1, "Home");
  items[index]?.focus();
}

function closeMoreMenu(focusButton) {
  const menu = $("moreMenu");
  if (!menu || menu.hidden) return false;
  menu.hidden = true;
  $("moreButton")?.setAttribute("aria-expanded", "false");
  if (focusButton) $("moreButton")?.focus();
  return true;
}

function menuEntries() {
  return [...($("moreMenu")?.querySelectorAll("[role='menuitem'], [role='menuitemcheckbox'], [role='separator']") || [])];
}

function menuEntryState(el) {
  return {
    separator: el.getAttribute("role") === "separator",
    disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
    hidden: el.hidden
  };
}

function onMenuKey(event) {
  if (!moreMenuOpen()) return false;
  if (event.key === "Tab") {
    closeMoreMenu(false);
    return false;
  }
  const items = menuEntries();
  const states = items.map(menuEntryState);
  const index = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const next = menuNext(states, index, event.key);
    if (next >= 0) items[next].focus();
    return true;
  }
  if (event.key === "Enter" || event.key === " ") {
    const current = items[index];
    if (!current || menuEntryState(current).disabled || menuEntryState(current).separator) return true;
    event.preventDefault();
    current.click();
    return true;
  }
  return false;
}

function updateSourcePageLabel(page) {
  const el = $("sourcePageLabel");
  if (!el) return;
  const total = pdfDoc?.numPages || 0;
  const shown = page || measureVisible() || pageNum || 0;
  el.textContent = sourcePageLabel(shown, total);
}

function noteSourcePage(load) {
  if (!pdfDoc || !pageViews.length) return;
  const current = measureVisible();
  updateSourcePageLabel(current);
  if (current && current !== pageNum) {
    pageNum = current;
    updatePager();
    if (currentScope() !== "all") {
      renderArticle();
      const readout = translateScrollRoot();
      if (readout) readout.scrollTop = 0;
      loadCurrentPageText();
    } else if (load !== false && !getPageLayout(current)) {
      loadCurrentPageText();
    }
  }
  scheduleVisibleRenders();
  syncFollowControls();
}

function syncReadoutEmpty(hasArticle) {
  const copy = readoutPlaceholder({ running: pdfTranslateBusy(session), hasArticle });
  $("emptyRead").hidden = copy !== PDF_COPY.translateHint;
  $("pendingRead").hidden = copy !== PDF_COPY.translatingWait;
}

function readerRootEl() {
  return $("reader");
}

function readerFlowEl() {
  return $("readerFlow");
}

function paperStackEl() {
  return readerFlowEl();
}

function scopeShowsPage(page) {
  return pagesInTranslateScope([{ page }], currentScope(), pageNum).length > 0;
}

/** CSS box of `#pages .pdf-page` (viewport = MediaBox/CropBox × left zoom). Not canvas bitmap pixels. */
function leftPageBox(page) {
  const el = document.querySelector(`#pages .pdf-page[data-page="${page}"]`);
  if (!el) return null;
  const styled = parseFloat(el.style.width);
  const parts = String(el.style.aspectRatio || "").split("/").map((part) => parseFloat(part.trim()));
  if (styled > 0 && parts[0] > 0 && parts[1] > 0) {
    return { width: styled, height: styled * (parts[1] / parts[0]) };
  }
  if (el.offsetWidth > 0 && el.offsetHeight > 0) {
    return { width: el.offsetWidth, height: el.offsetHeight };
  }
  return null;
}

/** Unscaled left page box. Right-pane paper uses this, not the zoomed CSS box. */
function leftBaseBox(page) {
  return basePageBox(leftPageBox(page), zoom);
}

function stampBodyFont(layout, items, viewport) {
  if (!layout) return layout;
  const described = describeBodyFont(items, {
    pageWidth: viewport?.width,
    pageHeight: viewport?.height
  });
  layout.pageWidth = described.pageWidth || layout.pageWidth || null;
  layout.pageHeight = described.pageHeight || layout.pageHeight || null;
  layout.bodyItemHeight = described.bodyItemHeight;
  layout.bodyFontTrusted = described.trusted;
  return layout;
}

function paperHeightFor(pageNumber) {
  const layout = getPageLayout(pageNumber);
  const pageW = Number(layout?.pageWidth) || 0;
  const pageH = Number(layout?.pageHeight) || 0;
  const scale = Number(zoom) > 0 ? Number(zoom) : 1;
  const zoomedW = pageW > 0 ? pageW * scale : 0;
  const zoomedH = pageW > 0 && pageH > 0 && zoomedW > 0 ? zoomedW * (pageH / pageW) : 0;
  const fallback = basePageBox({ width: zoomedW, height: zoomedH }, scale);
  const left = leftBaseBox(pageNumber) || fallback;
  const leftW = left?.width || 0;
  const leftH = left?.height || 0;
  const scroll = translateScrollRoot();
  const avail = paperAvailWidth(scroll?.clientWidth || 0, PDF_PAPER_GUTTER_X);
  const paper = readoutPaperSize({ leftWidth: leftW, leftHeight: leftH, availWidth: avail });
  return paper.heightBase > 0 ? paper.heightBase : leftH;
}

function snappedFormulaBox(matched, columnPx) {
  const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
  const mirror = Number(mirrorZoom) > 0 ? Number(mirrorZoom) : 1;
  return fitSnappedFormulaCss({
    cssWidth: matched.cssWidth,
    cssHeight: matched.cssHeight,
    columnPx,
    mirrorZoom: mirror,
    devicePixelRatio: dpr
  });
}

function readerColumnPx(row) {
  const pane = translateScrollRoot();
  const flow = readerFlowEl();
  let flowPx = flow?.clientWidth || 0;
  if (!(flowPx > 0) && pane) {
    const measure = parseFloat(pane.style.getPropertyValue("--rf-measure") || "");
    flowPx = measure > 0 ? measure : (pane.clientWidth || 0);
  }
  const host = row?.classList?.contains("oi-pdf-math-row") ? row : null;
  const num = host?.querySelector(":scope > .oi-pdf-eq-num");
  const eqNumPx = num ? (num.getBoundingClientRect().width || num.offsetWidth || 0) : 0;
  let gapPx = 0;
  if (eqNumPx > 0 && host) {
    const gap = parseFloat(getComputedStyle(host).columnGap);
    gapPx = Number.isFinite(gap) ? gap : 0;
  }
  return displayFormulaColumnPx({ flowPx, eqNumPx, gapPx });
}

function readerFormulaStyle(block, page, inline, columnPx) {
  const layout = getPageLayout(page);
  const bbox = block?.bbox;
  const pageW = Number(layout?.pageWidth) || 0;
  const pageH = Number(layout?.pageHeight) || 0;
  if (!Array.isArray(bbox) || bbox.length < 4 || !(pageW > 0) || !(pageH > 0)) return null;
  const fracW = Number(bbox[2]) - Number(bbox[0]);
  const fracH = Number(bbox[3]) - Number(bbox[1]);
  if (!(fracW > 0) || !(fracH > 0)) return null;
  const inkPt = fracH * pageH;
  const column = columnPx > 0 ? columnPx : readerColumnPx();
  const sized = readerFormulaCssSize({
    bodyFontPx: readerPrefs.fontSize,
    sourceBodyPt: Number(layout?.bodyItemHeight) > 0 ? Number(layout.bodyItemHeight) : READER_SOURCE_BODY_PT,
    inkPt,
    widthPt: fracW * pageW,
    scriptPt: formulaScriptPt(block, inkPt),
    columnPx: column,
    inline
  });
  if (!sized) return null;
  const limit = inline && !sized.raised ? 0 : (sized.scrolls ? 0 : column);
  const snapped = snappedFormulaBox(sized, limit) || sized;
  const height = snapped.cssHeight || sized.cssHeight;
  const width = snapped.cssWidth > 0 ? snapped.cssWidth : sized.cssWidth;
  if (!(height > 0)) return null;
  return {
    height: paperCssPx(height),
    aspect: width > 0 ? String(Math.round((width / height) * 10000) / 10000) : "1",
    raised: Boolean(sized.raised)
  };
}

function matchedFormulaStyle(block, page) {
  const inline = block?.display === false || Boolean(block?.inlineOf);
  return readerFormulaStyle(block, page, inline, readerColumnPx());
}

function refreshMatchedFormulas(paper) {
  const layout = getPageLayout(paper.dataset.page);
  paper.querySelectorAll(".oi-pdf-math-row.is-matched").forEach((row) => {
    const host = row.closest("[data-block-id]");
    const block = (layout?.blocks || []).find((item) => item.id === host?.dataset?.blockId);
    const matched = readerFormulaStyle(block, paper.dataset.page, false, readerColumnPx(row));
    if (!matched) return;
    row.style.setProperty("--oi-formula-h", matched.height);
    row.style.setProperty("--oi-formula-ar", matched.aspect);
  });
  paper.querySelectorAll(".oi-pdf-inline-math.is-matched").forEach((span) => {
    const block = (layout?.blocks || []).find((item) => item.id === span.dataset.blockId);
    const matched = readerFormulaStyle(block, paper.dataset.page, true, readerColumnPx(span));
    if (!matched) return;
    span.style.setProperty("--oi-formula-h", matched.height);
    span.style.setProperty("--oi-formula-ar", matched.aspect);
    span.classList.toggle("is-raised", matched.raised);
  });
}

function applyPaperMetrics() {
  const flow = readerFlowEl();
  if (!flow) return;
  flow.querySelectorAll(":scope > .rf-page").forEach((slot) => {
    const left = leftBaseBox(slot.dataset.page);
    if (left?.width > 0) slot.style.setProperty("--oi-pdf-left-w", paperCssPx(left.width));
    refreshMatchedFormulas(slot);
  });
  refreshFormulaCropsForDisplay();
}

function bindPaperMetrics() {
  let pass = 0;
  const watch = () => {
    const token = ++pass;
    layoutCapsule({ keepAnchor: true });
    applyPaperMetrics();
    updateReaderFade();
    requestAnimationFrame(() => {
      if (token !== pass) return;
      applyPaperMetrics();
      updateReaderFade();
    });
  };
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(watch);
    const scroll = translateScrollRoot();
    const pages = $("pages");
    if (scroll) observer.observe(scroll);
    if (pages) observer.observe(pages);
  }
  window.addEventListener("resize", watch);
}

function ensurePaper(page) {
  const flow = readerFlowEl();
  if (!flow || page == null || page === "") return null;
  const key = String(page);
  let slot = flow.querySelector(`:scope > .rf-page[data-page="${key}"]`);
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "rf-page readout md-readout";
    slot.dataset.page = key;
    slot.dataset.srcPage = key;
    flow.append(slot);
  }
  return slot;
}

function renderStoredArticle(blocks) {
  const flowRoot = ensurePaper(1);
  if (!flowRoot) return;
  flowRoot.replaceChildren();
  flowRoot.dataset.fallback = "1";
  const source = getPageLayout(1)?.blocks || [];
  const bylines = source.filter((block) => block.presentation === "byline");
  const abstractAt = (blocks || []).findIndex((block) => block.tag === "h2" && /^(abstract|摘要)$/i.test(block.text || ""));
  let start = 0;
  if (bylines.length && abstractAt > 1) {
    const title = document.createElement("h1");
    title.className = "oi-pdf-h1";
    title.textContent = blocks[0]?.text || "";
    title.dataset.page = "1";
    title.dataset.blockId = source.find((block) => block.label === "title")?.id || "";
    flowRoot.append(title);
    for (const block of bylines) {
      const node = document.createElement("p");
      node.className = "oi-pdf-p";
      node.dataset.role = "authors";
      node.dataset.page = "1";
      node.dataset.blockId = block.id;
      node.textContent = block.text;
      flowRoot.append(node);
    }
    start = abstractAt;
  }
  for (const block of (blocks || []).slice(start)) {
    if (block.tag === "img") {
      const img = document.createElement("img");
      img.alt = block.alt || "公式";
      img.src = block.src;
      flowRoot.append(img);
      continue;
    }
    const node = document.createElement(block.tag || "p");
    node.textContent = block.text || "";
    decorateAbstractHeading(node, block.text);
    flowRoot.append(node);
  }
}

function captureFormulaScrolls(root) {
  const entries = [];
  if (!root) return indexFormulaScrolls(entries);
  root.querySelectorAll(".oi-pdf-math-scroll, .oi-pdf-inline-math.is-raised").forEach((scroll) => {
    const host = scroll.closest("[data-block-id]") || scroll;
    entries.push({
      page: host.dataset.page || host.closest("[data-src-page]")?.dataset.srcPage || "",
      id: host.dataset.blockId || "",
      left: scroll.scrollLeft
    });
  });
  return indexFormulaScrolls(entries);
}

function restoreFormulaScrolls(root, saved) {
  if (!root || !saved?.size) return;
  const apply = () => {
    root.querySelectorAll(".oi-pdf-math-scroll, .oi-pdf-inline-math.is-raised").forEach((scroll) => {
      const host = scroll.closest("[data-block-id]") || scroll;
      const page = host.dataset.page || host.closest("[data-src-page]")?.dataset.srcPage || "";
      const left = formulaScrollLeft(saved, page, host.dataset.blockId || "");
      if (left > 0 && scroll.scrollLeft !== left) scroll.scrollLeft = left;
    });
  };
  apply();
  requestAnimationFrame(() => {
    apply();
    root.querySelectorAll(".oi-pdf-math-scroll img, .oi-pdf-inline-math.is-raised img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", apply, { once: true });
    });
  });
}

function renderArticle() {
  const pane = translateScrollRoot();
  const keep = pane ? pane.scrollTop : 0;
  const keepLeft = pane ? pane.scrollLeft : 0;
  const formulaScrolls = captureFormulaScrolls(readerFlowEl());
  const stack = paperStackEl();
  if (stack) stack.replaceChildren();
  if (libraryArticle?.length && scopeShowsPage(1)) {
    renderStoredArticle(libraryArticle);
    applyViewMode();
    finalizeReaderFlow();
    syncReadoutEmpty(true);
    if (pane) pane.scrollTop = keep;
    if (pane) pane.scrollLeft = keepLeft;
    restoreFormulaScrolls(readerFlowEl(), formulaScrolls);
    return;
  }
  const pages = pagesInTranslateScope(
    collectArticlePages(pageCache, docId, pdfDoc?.numPages || 0),
    currentScope(),
    pageNum
  );
  applyViewMode();
  const blockPages = [];
  const total = pdfDoc?.numPages || 0;
  for (let n = 1; n <= total; n += 1) {
    const layout = getPageLayout(n);
    if (showsBlockReadout(layout) && scopeShowsPage(n)) blockPages.push(layout);
  }
  if (!pages.length && !blockPages.length) {
    finalizeReaderFlow();
    syncReadoutEmpty(false);
    updateTranslateControls();
    if (pane) pane.scrollTop = keep;
    return;
  }
  if (blockPages.length) {
    blockPages.forEach((layout) => {
      const flow = ensurePaper(layout.page);
      if (flow) appendFixtureReadout(flow, layoutForReadout(layout));
    });
  }
  pages.forEach(({ page, blocks }) => {
    if (blockPages.some((layout) => layout.page === page)) return;
    const flow = readoutFlowForPage(getPageLayout(page), blocks)
      .filter((item) => item?.translation || item?.latex);
    if (!flow.length) return;
    const flowRoot = ensurePaper(page);
    if (!flowRoot) return;
    flow.forEach((item) => {
      appendReadoutNode(
        {
          translation: item.translation,
          original: item.original,
          role: item.role,
          kind: item.kind,
          latex: item.latex,
          display: item.display,
          page
        },
        flowRoot
      );
    });
  });
  const hasContent = finalizeReaderFlow();
  syncReadoutEmpty(hasContent);
  if (!hasContent) {
    updateTranslateControls();
    if (pane) pane.scrollTop = keep;
    return;
  }
  if (pane) pane.scrollTop = keep;
  if (pane) pane.scrollLeft = keepLeft;
  restoreFormulaScrolls(readerFlowEl(), formulaScrolls);
  updateTranslateControls();
}

function stampReaderPage(slot) {
  const page = String(slot.dataset.page || slot.dataset.srcPage || "");
  slot.dataset.srcPage = page;
  slot.querySelectorAll(":scope > *").forEach((node) => {
    node.dataset.srcPage = page;
    if (!node.dataset.page) node.dataset.page = page;
    const tag = node.tagName;
    const block = tag === "P" || tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4"
      || tag === "FIGURE" || node.classList.contains("oi-pdf-authors")
      || node.classList.contains("oi-pdf-footnotes");
    if (block) node.classList.add("rf-block");
  });
}

function makePageBreak(page) {
  const el = document.createElement("div");
  el.className = "rf-pagebreak";
  el.dataset.srcPage = String(page);
  const label = document.createElement("span");
  label.textContent = pageBreakLabel(page);
  const before = document.createElement("span");
  const after = document.createElement("span");
  before.className = "rf-pagebreak-rule";
  after.className = "rf-pagebreak-rule";
  before.setAttribute("aria-hidden", "true");
  after.setAttribute("aria-hidden", "true");
  el.append(before, label, after);
  return el;
}

function makeUntranslated(page) {
  const el = document.createElement("div");
  el.className = "rf-untranslated";
  el.dataset.srcPage = String(page);
  const label = document.createElement("span");
  label.textContent = untranslatedLabel(page);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rf-untranslated-btn";
  btn.dataset.action = "translate-page";
  btn.dataset.srcPage = String(page);
  btn.textContent = pdfTranslateBusy(session) ? "排队中" : "翻译本页";
  btn.disabled = pdfTranslateBusy(session);
  el.append(label, btn);
  return el;
}

function readerMeasurePad() {
  const width = window.innerWidth || 0;
  if (width < 600) return 16;
  if (width < 900) return 20;
  if (width < 1200) return 28;
  return 40;
}

function capsuleBarHeight() {
  const raw = getComputedStyle(document.body).getPropertyValue("--oi-reader-capsule-bar-h");
  const height = parseFloat(raw);
  return Number.isFinite(height) && height > 0 ? height : 44;
}

function capsuleAnchorY(pane) {
  const paneRect = pane.getBoundingClientRect();
  const bar = pane.dataset.capsuleMode === "bar" ? capsuleBarHeight() : 0;
  return paneRect.top + bar + (paneRect.height - bar) * 0.3;
}

function anchorBlock(pane) {
  const flow = readerFlowEl();
  if (!pane || !flow) return null;
  const blocks = [...flow.querySelectorAll(".rf-block[data-src-page]")];
  if (!blocks.length) return null;
  const line = capsuleAnchorY(pane);
  const page = pageAtAnchor(blocks.map((el) => {
    const box = el.getBoundingClientRect();
    return { page: Number(el.dataset.srcPage), top: box.top, bottom: box.bottom };
  }), line);
  if (!page) return null;
  return blocks.find((el) => Number(el.dataset.srcPage) === page && el.getBoundingClientRect().bottom >= line)
    || blocks.find((el) => Number(el.dataset.srcPage) === page)
    || null;
}

function captureReaderAnchor() {
  const block = anchorBlock(translateScrollRoot());
  if (!block) return null;
  return { page: block.dataset.srcPage || "", id: block.dataset.blockId || "" };
}

function restoreReaderAnchor(token) {
  const pane = translateScrollRoot();
  const flow = readerFlowEl();
  if (!pane || !flow || !token) return;
  const esc = globalThis.CSS?.escape || ((value) => String(value).replace(/"/g, '\\"'));
  const node = token.id
    ? flow.querySelector(`[data-block-id="${esc(token.id)}"]`)
    : flow.querySelector(`.rf-block[data-src-page="${esc(token.page)}"]`);
  if (!node) return;
  const paneRect = pane.getBoundingClientRect();
  const line = capsuleAnchorY(pane);
  pane.scrollTop += node.getBoundingClientRect().top - line;
  updateReaderFade();
}

let cachedScrollbarWidth = null;

function classicScrollbarWidth() {
  if (cachedScrollbarWidth != null) return cachedScrollbarWidth;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden;";
  document.documentElement.append(probe);
  cachedScrollbarWidth = Math.max(0, probe.offsetWidth - probe.clientWidth);
  probe.remove();
  return cachedScrollbarWidth;
}

function capsuleLabelWidths(maxPage) {
  const probe = document.createElement("span");
  probe.className = "rf-capsule-probe";
  const capsule = $("pageCapsule");
  if (capsule) {
    const style = getComputedStyle(capsule);
    probe.style.font = style.font;
    probe.style.letterSpacing = style.letterSpacing;
  }
  probe.style.fontVariantNumeric = "tabular-nums";
  probe.style.whiteSpace = "nowrap";
  probe.style.padding = "0";
  const padX = readerTokenPx("--oi-reader-capsule-pad-x", CAPSULE_PAD_X);
  const padXMin = readerTokenPx("--oi-reader-capsule-pad-x-min", CAPSULE_PAD_X_MIN);
  document.body.append(probe);
  const measure = (text) => {
    probe.textContent = text;
    const box = probe.getBoundingClientRect();
    return box.width > 0 ? box.width : probe.offsetWidth;
  };
  const digitWidths = {};
  if (maxPage > 120) {
    for (const digit of "0123456789") digitWidths[digit] = measure(digit);
  }
  const pages = capsuleSamplePages(maxPage, maxPage > 120 ? digitWidths : null);
  const shortWidths = [];
  const fullWidths = [];
  for (const page of pages) {
    shortWidths.push(measure(capsuleLabel(page, { short: true })));
    fullWidths.push(measure(capsuleLabel(page)));
  }
  probe.remove();
  const measured = (list) => {
    const widths = list.filter((n) => n > 0);
    return widths.length ? widths : [1];
  };
  return {
    shortWidths: measured(shortWidths),
    fullWidths: measured(fullWidths),
    padX,
    padXMin
  };
}

function readerTokenPx(name, fallback) {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function layoutCapsule({ keepAnchor = false } = {}) {
  const pane = translateScrollRoot();
  if (!pane || pane.clientWidth <= 0) return;
  const had = pane.style.getPropertyValue("--rf-measure");
  const before = keepAnchor && had ? anchorBlock(pane) : null;
  const maxPage = Math.max(1, Number(pdfDoc?.numPages) || 0);
  const narrow = (window.innerWidth || 0) < 900;
  const box = stableCapsulePane({
    client: pane.clientWidth,
    scrollbar: measureScrollbarWidth(pane),
    gutter: narrow ? 0 : classicScrollbarWidth()
  });
  const widths = capsuleLabelWidths(maxPage);
  const fontPx = readerPrefs.fontSize;
  const measurePad = readerMeasurePad();
  const column = box.paneW + (box.scrollbar > 0 ? box.scrollbar : 0);
  const want = Math.min(36 * fontPx, column - 2 * measurePad);
  const defaultFull = !narrow && fontPx === 16 && measurePad === 40 && Math.abs(want - 576) < 1e-6;
  const shortContent = defaultFull
    ? reserveDefaultCapsuleContent(widths.shortWidths, {
      visible: box.paneW,
      startMin: maxPage >= 100 ? CAPSULE_START_RELAXED : CAPSULE_START_BAND_MIN
    })
    : reserveCapsuleContent(widths.shortWidths);
  const fullContent = reserveCapsuleContent(widths.fullWidths);
  const place = capsulePlacement({
    paneW: box.paneW,
    scrollbar: box.scrollbar,
    pad: measurePad,
    fontPx,
    fullW: fullContent + 2 * widths.padX,
    shortW: shortContent + 2 * widths.padX,
    shortWMin: shortContent + 2 * widths.padXMin,
    padX: widths.padX,
    padXMin: widths.padXMin,
    maxPage,
    minEnd: readerTokenPx("--oi-reader-capsule-end-min", CAPSULE_END_MIN),
    endBand: readerTokenPx("--oi-reader-capsule-end-floor", CAPSULE_END_BAND),
    startFloor: CAPSULE_START_FLOOR,
    forceBar: (window.innerWidth || 0) < 900
  });
  const prev = `${pane.dataset.capsuleMode}|${pane.dataset.capsuleLabel}|${had}|${pane.style.getPropertyValue("--rf-start")}`;
  pane.style.setProperty("--rf-measure", `${place.measure}px`);
  pane.style.setProperty("--rf-start", place.start == null ? "auto" : `${place.start}px`);
  pane.style.setProperty("--rf-capsule-end", `${Number.isFinite(place.end) ? place.end : 12}px`);
  pane.style.setProperty("--rf-capsule-w", `${place.capsuleW}px`);
  pane.style.setProperty("--rf-capsule-pad-x", `${place.padX}px`);
  pane.dataset.capsuleMode = place.mode;
  pane.dataset.capsuleLabel = place.label;
  const next = `${place.mode}|${place.label}|${place.measure}px|${place.start == null ? "auto" : `${place.start}px`}`;
  if (before && prev !== next) {
    const line = capsuleAnchorY(pane);
    pane.scrollTop += before.getBoundingClientRect().top - line;
  }
  updatePageCapsule();
  updateReaderFade();
}

function updateReaderFade() {
  const pane = translateScrollRoot();
  const fade = $("readerFade");
  if (!pane || !fade) return;
  fade.hidden = !needsFade(pane.scrollTop, pane.clientHeight, pane.scrollHeight);
  const scrollbar = pane.offsetHeight - pane.clientHeight;
  fade.style.bottom = scrollbar > 0 ? `${scrollbar}px` : "0px";
}

function finalizeReaderFlow() {
  const flow = readerFlowEl();
  if (!flow) return false;
  const slots = new Map();
  flow.querySelectorAll(":scope > .rf-page").forEach((slot) => {
    if (!slot.childNodes.length) {
      slot.remove();
      return;
    }
    slots.set(Number(slot.dataset.page), slot);
  });
  const slotMax = slots.size ? Math.max(...slots.keys()) : 0;
  const total = Math.max(Number(pdfDoc?.numPages) || 0, slotMax);
  const wanted = new Set(contentPagesForScope({
    scope: currentScope(),
    currentPage: pageNum,
    pagesWithContent: [...slots.keys()]
  }));
  for (const [page, slot] of slots) {
    if (!wanted.has(page)) {
      slot.remove();
      slots.delete(page);
    }
  }
  const plan = planReaderFlow({ pageCount: total, contentPages: [...wanted] });
  const frag = document.createDocumentFragment();
  for (const item of plan) {
    if (item.kind === "break") frag.append(makePageBreak(item.page));
    else if (item.kind === "untranslated") frag.append(makeUntranslated(item.page));
    else if (slots.get(item.page)) frag.append(slots.get(item.page));
  }
  flow.replaceChildren(frag);
  flow.querySelectorAll(":scope > .rf-page").forEach((slot) => stampReaderPage(slot));
  flow.querySelectorAll(":scope > .rf-page").forEach((slot) => stampFlowPairs(slot));
  layoutCapsule();
  flow.querySelectorAll(":scope > .rf-page").forEach((slot) => refreshMatchedFormulas(slot));
  if (jumpLock.locked) paintPairChrome();
  else refreshPairCurrent();
  return wanted.size > 0;
}

function updatePageCapsule() {
  const cap = $("pageCapsule");
  const flow = readerFlowEl();
  const pane = translateScrollRoot();
  if (!cap) return;
  const blocks = flow ? [...flow.querySelectorAll(".rf-block[data-src-page]")] : [];
  if (!blocks.length || !pane) {
    cap.hidden = true;
    return;
  }
  const line = capsuleAnchorY(pane);
  const entries = blocks.map((el) => {
    const box = el.getBoundingClientRect();
    return { page: Number(el.dataset.srcPage), top: box.top, bottom: box.bottom };
  });
  const page = pageAtAnchor(entries, line);
  if (!page) {
    cap.hidden = true;
    return;
  }
  cap.hidden = false;
  const short = pane.dataset.capsuleLabel === "short";
  cap.textContent = capsuleLabel(page, { short });
  cap.setAttribute("aria-label", capsuleLabel(page));
  cap.dataset.srcPage = String(page);
}

function onPageCapsuleClick() {
  const page = Number($("pageCapsule")?.dataset.srcPage);
  if (!Number.isFinite(page) || page < 1) return;
  if (page !== pageNum) {
    pageNum = page;
    updatePager();
  }
  const wrap = pageViews[page - 1]?.wrap;
  const pane = pdfScrollRoot();
  if (wrap && pane) {
    const top = alignScrollTop(pane, wrap);
    if (Number.isFinite(top)) {
      takeDriver("click");
      pane.scrollTop = Math.max(0, top);
    }
  }
  applyFollow({ type: "capsuleJump" });
  updateSourcePageLabel(page);
}

function onReaderFlowClick(event) {
  const btn = event.target.closest?.("[data-action='translate-page']");
  if (btn && !btn.disabled) {
    const page = Number(btn.dataset.srcPage);
    if (Number.isFinite(page) && page >= 1) {
      pageNum = page;
      updatePager();
      loadCurrentPageText().then(() => translateCurrentPage());
    }
    return;
  }
}

function applyViewMode() {
  viewMode = "readout";
  if ($("mirrorPages")) $("mirrorPages").hidden = true;
  if ($("viewSeg")) $("viewSeg").hidden = true;
  if ($("mirrorHint")) $("mirrorHint").hidden = true;
}

function onViewSegClick(event) {
  const btn = event.target.closest(".view-seg-btn");
  if (!btn) return;
  applyViewMode();
}

function currentReadoutNodes() {
  return collectReadoutExportNodes(paperStackEl());
}

function syncExportControls() {
  const ui = pdfExportControlState({
    hasDoc: Boolean(pdfDoc),
    hasReadout: canExportReadout(currentReadoutNodes()),
    exporting
  });
  for (const [id, off] of [["exportMd", ui.mdDisabled], ["exportPdf", ui.pdfDisabled]]) {
    const btn = $(id);
    if (!btn) continue;
    btn.disabled = off;
    btn.setAttribute("aria-disabled", off ? "true" : "false");
  }
}

async function exportReadout(kind) {
  const nodes = currentReadoutNodes();
  if (!pdfDoc || !canExportReadout(nodes) || exporting) return;
  exporting = true;
  const prev = $("status").textContent;
  const prevError = $("status").classList.contains("error");
  setStatus(PDF_COPY.exporting);
  updateTranslateControls();
  try {
    const filename = translationExportFilename(pdfSourceBasename(sourceUrl), kind === "pdf" ? "pdf" : "md");
    if (kind === "pdf") {
      downloadBlob(filename, new Blob([articleBlocksToPdf(nodes)], { type: "application/pdf" }));
    } else {
      downloadBlob(
        filename,
        new Blob([articleBlocksToMarkdown(nodes)], { type: "text/markdown;charset=utf-8" })
      );
    }
    setStatus(prev, prevError);
  } catch {
    setStatus(PDF_COPY.exportFail, true);
  } finally {
    exporting = false;
    updateTranslateControls();
  }
}

function onTranslateScroll() {
  updatePageCapsule();
  updateReaderFade();
  if (!pdfDoc) return;
  if (jumpLock.locked) return;
  if (syncOwner.ignores("readout")) return;
  if (translateScrollTick) return;
  const generation = followGeneration;
  readoutSyncGate.begin();
  translateScrollTick = requestAnimationFrame(() => {
    translateScrollTick = 0;
    try {
      if (generation !== followGeneration) return;
      refreshPairCurrent();
      followSourceToCurrent();
    } finally {
      if (readoutSyncGate.finish() === "release") releaseScrollDriver("readout");
    }
  });
}

function onReadoutScrollEnd() {
  if (readoutSyncGate.noteEnd() === "defer") return;
  releaseScrollDriver("readout");
}

function onReadoutWheel() {
  releaseJumpLock();
  takeDriver("readout");
}

function writeAnchorScroll(pane, node) {
  if (!pane || !node) return false;
  const paneRect = pane.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  if (!shouldSyncReadout(nodeRect.top, paneRect.top)) return false;
  let top = alignScrollTop(pane, node);
  if (!Number.isFinite(top)) return false;
  if (pane === translateScrollRoot()) {
    top = clearFadeScroll({
      wantTop: top,
      paneHeight: pane.clientHeight,
      blockHeight: nodeRect.height + 12,
      blockTopInPane: nodeRect.top - paneRect.top + pane.scrollTop
    });
  }
  pane.scrollTop = top;
  updateReaderFade();
  return true;
}

function syncPdfToPage(page) {
  const view = pageViews[page - 1];
  return writeAnchorScroll(pdfScrollRoot(), view?.wrap || null);
}

function syncReadoutToPage(page) {
  const pane = translateScrollRoot();
  const node = readerFlowEl()?.querySelector(`.rf-block[data-src-page="${page}"], .rf-untranslated[data-src-page="${page}"]`);
  return writeAnchorScroll(pane, node);
}

function runtimeSend(message) {
  const send = globalThis.chrome?.runtime?.sendMessage;
  if (typeof send !== "function") {
    return Promise.reject(new Error("runtime unavailable"));
  }
  return send(message);
}

function currentScope() {
  const on = document.querySelector(".scope-seg-btn.is-on");
  return normalizePdfTranslateScope(on?.dataset.scope);
}

function onScopeClick(event) {
  const btn = event.target.closest(".scope-seg-btn");
  if (!btn || btn.disabled || pdfTranslateBusy(session)) return;
  setTranslateScope(btn.dataset.scope);
}

function beginViewerSession() {
  if (session.aborted) session = createTranslateSession();
  session.running = true;
  session.aborted = false;
  return session;
}

function isCurrentWork(work, gen, translatingDoc) {
  return work === session && gen === restoreGen && translatingDoc === docId;
}

function stopTranslateWork() {
  abortTranslateSession(session);
  translatingPage = 0;
  setStatus(PDF_COPY.stopped);
  renderArticle();
  updateTranslateControls();
}

function setTranslateScope(value) {
  const scope = normalizePdfTranslateScope(value);
  document.querySelectorAll(".scope-seg-btn").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.scope === scope);
  });
  renderArticle();
  const pane = translateScrollRoot();
  if (pane) pane.scrollTop = 0;
  updateTranslateControls();
}

function setScopeEnabled(enabled) {
  document.querySelectorAll(".scope-seg-btn").forEach((btn) => {
    btn.disabled = !enabled;
  });
}

async function startTranslate() {
  if (currentScope() === "all") await translateWholeDocument();
  else await translateCurrentPage();
}

async function resolveBatchSize() {
  const settingsRes = await runtimeSend({ type: "OI_GET_SETTINGS" });
  return Math.max(1, Number(settingsRes?.settings?.batchSize) || 8);
}

function rememberTranslation(page, results) {
  const rawLayout = getPageLayout(page);
  const layout = cacheableLayout(rawLayout);
  const pairs = pairsFromResults(results);
  const skipOnly = isSkipOnlyPage(rawLayout?.blocks);
  const existing = libraryDoc?.pages?.find((item) => item.page === page);
  if (!pairs.length && !skipOnly) return Promise.resolve();
  if (!pairs.length && existing && (existing.pairs?.length || existing.skipped)) return Promise.resolve();
  // Capture this document before queuing: the user may open another PDF while
  // earlier pages are still being saved.
  const bytes = pdfBytes;
  const title = document.title;
  const pageCount = pdfDoc?.numPages || 0;
  const skipped = skipOnly && !pairs.length;
  return enqueueLibraryWrite(async () => {
    const hash = await pdfByteHash(bytes);
    if (!hash || hash === "nohash") return;
    let sourceBase64 = "";
    if (!librarySourceSent.has(hash) && bytes?.length) {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      sourceBase64 = btoa(binary);
    }
    await saveLibraryPage({
      hash,
      title,
      pageCount,
      page,
      pairs,
      layout,
      sourceBase64,
      ...(skipped ? { skipped: true } : {})
    });
    librarySourceSent.add(hash);
    if (skipped && libraryDoc && Array.isArray(libraryDoc.pages) &&
        !libraryDoc.pages.some((item) => item.page === page)) {
      libraryDoc.pages.push({ page, pairs: [], skipped: true });
    }
  });
}

function rememberSkipHole(page, blocks) {
  if (!isSkipOnlyPage(blocks)) return;
  if (libraryDoc?.pages?.some((item) => item.page === page)) return;
  rememberTranslation(page, []).catch(() => {});
}

function persistPagePairs(saved) {
  const page = Number(saved?.page);
  if (!page || !saved?.pairs?.length) return Promise.resolve();
  const rawLayout = getPageLayout(page);
  const layout = rawLayout ? cacheableLayout(rawLayout) : null;
  const bytes = pdfBytes;
  const title = document.title;
  const pageCount = pdfDoc?.numPages || 0;
  return enqueueLibraryWrite(async () => {
    const hash = await pdfByteHash(bytes);
    if (!hash || hash === "nohash") return;
    await saveLibraryPage({
      hash,
      title,
      pageCount,
      page,
      pairs: saved.pairs,
      ...(layout ? { layout } : {}),
      ...(saved.skipped ? { skipped: true } : {})
    });
  });
}

/** Drop a historical source-uncertain hold on the page-5 matrix sentence and store its Chinese. */
function bindSavedPairs(saved, units) {
  if (!saved?.pairs?.length || !units?.length) return saved;
  const repaired = repairMatrixProjectionPairs(saved.pairs, units);
  if (!repaired.changed) return saved;
  saved.pairs = repaired.pairs;
  const stored = libraryDoc?.pages?.find((item) => item !== saved && item.page === saved.page);
  if (stored) stored.pairs = repaired.pairs;
  persistPagePairs(saved).catch(() => {});
  return saved;
}

async function savedTranslationFor(page) {
  const hash = await pdfByteHash();
  if (!hash || hash === "nohash") return null;
  if (!libraryDoc || libraryDoc.hash !== hash) {
    libraryDoc = await fetchLibraryDocument(hash);
    if (libraryDoc) libraryDoc.hash = hash;
    if (libraryDoc?.sourcePath) librarySourceSent.add(hash);
  }
  if (!libraryDoc) return null;
  const selected = selectSavedTranslation(libraryDoc, page, getPageLayout(page)?.blocks);
  if (libraryDoc.pages?.length) {
    libraryArticle = null;
    return selected;
  }
  if (selected?.readout) {
    libraryArticle = storedReadoutBlocks(libraryDoc.readout);
    return selected;
  }
  return selected;
}

function savedPageStatus(saved, restored = [], blocks = null) {
  const layoutBlocks = Array.isArray(blocks)
    ? blocks
    : (getPageLayout(Number(saved?.page) || pageNum)?.blocks || null);
  return pageSoftStatus({ saved, restored, blocks: layoutBlocks, done: PDF_COPY.done }).copy;
}

const STRUCTURE_TIMEOUT_MS = 20000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("structure timeout")), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function noteLibraryUnavailable() {
  const failure = libraryProbeFailure();
  setStatus(failure.warning, false, true);
}

async function ensureTitleStructure(page, layout, options = {}) {
  const text = pageTextForStructure(layout?.blocks || []);
  if (titleStructure && titleStructure.docId === docId && !options.force) {
    const authors = titleStructure.source?.authors || titleStructure.structure?.authors || [];
    const stale = titleStructure.status === "ok" && structureAuthorsLookTruncated(authors, text);
    if (!stale) return titleStructure;
  }
  if (!isTitlePageCandidate(page, text)) return null;
  const stamp = docId;
  const pending = {
    docId: stamp,
    page,
    status: "pending",
    structure: null,
    source: null,
    slotsDone: false,
    translated: false
  };
  titleStructure = pending;
  try {
    const parsed = await resolveTitleStructure(text, page, (payload) => withTimeout(runtimeSend({
      type: "OI_PDF_STRUCTURE",
      system: payload.system,
      user: payload.user
    }), STRUCTURE_TIMEOUT_MS));
    if (stamp !== docId) return null;
    if (parsed.ok) {
      pending.status = "ok";
      pending.source = parsed.structure;
      pending.structure = parsed.structure;
    } else pending.status = "fallback";
  } catch {
    if (stamp === docId) pending.status = "fallback";
  }
  return pending;
}

function liveOriginals(layout, units) {
  const record = titleStructure;
  if (!record || record.status !== "ok" || record.docId !== docId || record.page !== layout?.page) return units || [];
  const keep = new Set(blocksOutsideStructure(layout?.blocks || [], record.source || record.structure).map((block) => block.id));
  return (units || []).filter((unit) => !unit?.id || keep.has(unit.id));
}

async function translateTitleStructure(work, gen, translatingDoc, batchSize) {
  const record = titleStructure;
  if (!record || record.status !== "ok" || record.docId !== translatingDoc || record.slotsDone) return;
  record.slotsDone = true;
  const slots = structureTranslateSlots(record.source);
  if (!slots.length) {
    record.translated = true;
    return;
  }
  const { results } = await translatePageBlocks(slots.map((item) => ({
    text: item.text,
    original: item.text,
    role: "paragraph"
  })), {
    send: runtimeSend,
    session: work,
    batchSize,
    preserveSession: true,
    onBatchResult({ results: next }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      record.structure = applyStructureTranslations(record.source, slots, next.map((row) => row.translation));
      renderArticle();
    }
  });
  if (!isCurrentWork(work, gen, translatingDoc)) return;
  record.structure = applyStructureTranslations(
    record.source,
    slots,
    (results || []).map((row) => row.translation)
  );
  record.translated = true;
  renderArticle();
}

function structureLanded(page) {
  const record = titleStructure;
  if (!record?.translated || record.docId !== docId || record.page !== page) return false;
  return structureTranslationRows(record.source, record.structure).some((row) => String(row.translation || "").trim());
}

async function translateCurrentPage() {
  if (!pdfDoc || pdfTranslateBusy(session)) return;
  try {
    const saved = await savedTranslationFor(pageNum);
    if (saved?.readout) {
      setStatus(PDF_COPY.doneDocument);
      renderArticle();
      return;
    }
    const openedBlocks = getPageLayout(pageNum)?.blocks ?? null;
    if (saved?.pairs?.length) {
      const prepared = bindSavedPairs(saved, pageOriginals);
      const merged = applySavedPairs(pageOriginals, prepared.pairs);
      pageCache.set(docId, pageNum, merged);
      pageResults = merged;
      renderArticle();
      setStatus(savedPageStatus(prepared, merged, openedBlocks));
      return;
    }
    if (saved?.migrated || saved?.skipped || libraryDoc?.pages?.length) {
      const status = pageSoftStatus({ saved, blocks: openedBlocks, done: PDF_COPY.done });
      const translatableHole = Boolean(
        saved?.migrated &&
        !saved?.skipped &&
        Array.isArray(openedBlocks) &&
        openedBlocks.some((block) => isTranslatableBlock(block)) &&
        status.kind === "library-hole"
      );
      if (!translatableHole) {
        setStatus(status.copy);
        if (status.kind === "bibliography") rememberSkipHole(pageNum, openedBlocks);
        return;
      }
    }
  } catch {
    noteLibraryUnavailable();
  }
  if (libraryArticle || pageHasTranslation(pageCache.get(docId, pageNum))) {
    setStatus(libraryArticle ? PDF_COPY.doneDocument : PDF_COPY.done);
    return;
  }
  const openedLayout = getPageLayout(pageNum);
  if (!pageOriginals.length && !isTitlePageCandidate(pageNum, pageTextForStructure(openedLayout?.blocks))) {
    setStatus(isSkipOnlyPage(openedLayout?.blocks) ? PAGE_STATUS_BIBLIOGRAPHY : (pageBlocksCopy(0, pageItems) || PDF_COPY.emptyPage));
    syncNoTextLayerHint(pageItems <= 0);
    updateTranslateControls();
    return;
  }
  const gen = restoreGen;
  const translatingDoc = docId;
  const targetPage = pageNum;
  translatingPage = targetPage;
  const work = beginViewerSession();
  const sourceLayout = openedLayout;
  updateTranslateControls();
  if (!$("status").classList.contains("warn")) setStatus(PDF_COPY.translating);
  let batchSize = 8;
  try {
    batchSize = await resolveBatchSize();
  } catch (err) {
    if (!isCurrentWork(work, gen, translatingDoc)) return;
    work.running = false;
    translatingPage = 0;
    if (String(err?.message || err) === "runtime unavailable") {
      setStatus(PDF_COPY.runtimeUnavailable, true);
      renderArticle();
      updateTranslateControls();
      return;
    }
  }
  if (work.aborted || !isCurrentWork(work, gen, translatingDoc)) {
    if (isCurrentWork(work, gen, translatingDoc)) updateTranslateControls();
    return;
  }
  await ensureTitleStructure(targetPage, sourceLayout);
  if (work.aborted || !isCurrentWork(work, gen, translatingDoc)) {
    if (isCurrentWork(work, gen, translatingDoc)) updateTranslateControls();
    return;
  }
  pageResults = emptyPageResults(sourceLayout);
  pageCache.set(translatingDoc, targetPage, pageResults);
  renderArticle();
  await translateTitleStructure(work, gen, translatingDoc, batchSize);
  if (work.aborted || !isCurrentWork(work, gen, translatingDoc)) {
    if (isCurrentWork(work, gen, translatingDoc)) updateTranslateControls();
    return;
  }
  const { aborted, results } = await translatePageBlocks(liveOriginals(sourceLayout, pageOriginals), {
    send: runtimeSend,
    session: work,
    batchSize,
    onBatchStart({ index, total }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      setStatus(progressStatus(index + 1, total));
    },
    onBatchResult({ results: next, res }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      const merged = pageResultsFromTranslation(sourceLayout, next);
      pageCache.set(translatingDoc, targetPage, merged);
      pageResults = merged;
      renderArticle();
      if (res?.polishError) setStatus(PDF_COPY.polishFail, true);
    }
  });
  if (!isCurrentWork(work, gen, translatingDoc)) return;
  const merged = pageResultsFromTranslation(sourceLayout, results);
  pageCache.set(translatingDoc, targetPage, merged);
  pageResults = merged;
  renderArticle();
  if (aborted) setStatus(PDF_COPY.stopped);
  else if (!results.some((item) => item.translation) && !structureLanded(targetPage)) setStatus(PDF_COPY.error, true);
  else setStatus(PDF_COPY.done);
  translatingPage = 0;
  if (!aborted) {
    try {
      await rememberTranslation(targetPage, merged);
    } catch {
      setStatus("译文已生成，但写入本地库失败。", true);
    }
  }
  updateTranslateControls();
}

async function translateWholeDocument() {
  if (!pdfDoc || pdfTranslateBusy(session)) return;
  try {
    const saved = await savedTranslationFor(pageNum);
    if (saved?.readout) {
      setStatus(PDF_COPY.doneDocument);
      renderArticle();
      return;
    }
    if (libraryDoc?.pages?.length) {
      const blocksByPage = {};
      for (const entry of libraryDoc.pages) {
        const layout = getPageLayout(entry.page);
        if (layout?.blocks) blocksByPage[entry.page] = layout.blocks;
      }
      const currentBlocks = getPageLayout(pageNum)?.blocks || null;
      if (currentBlocks) blocksByPage[pageNum] = currentBlocks;
      const current = pageSoftStatus({
        saved: selectSavedTranslation(libraryDoc, pageNum, currentBlocks),
        blocks: currentBlocks,
        done: PDF_COPY.done
      });
      if (current.kind === "bibliography") {
        setStatus(current.copy);
        rememberSkipHole(pageNum, currentBlocks);
      } else {
        setStatus(libraryHoldCopy(libraryDoc.pages, blocksByPage));
      }
      renderArticle();
      return;
    }
  } catch {
    noteLibraryUnavailable();
  }
  if (libraryArticle) {
    setStatus(PDF_COPY.doneDocument);
    return;
  }
  const gen = restoreGen;
  const translatingDoc = docId;
  const total = pdfDoc.numPages;
  const work = beginViewerSession();
  updateTranslateControls();
  if (!$("status").classList.contains("warn")) setStatus(progressDocumentStatus(1, total));
  renderArticle();
  let batchSize = 8;
  try {
    batchSize = await resolveBatchSize();
  } catch (err) {
    if (!isCurrentWork(work, gen, translatingDoc)) return;
    work.running = false;
    translatingPage = 0;
    if (String(err?.message || err) === "runtime unavailable") {
      setStatus(PDF_COPY.runtimeUnavailable, true);
      renderArticle();
      updateTranslateControls();
      return;
    }
  }
  if (work.aborted || !isCurrentWork(work, gen, translatingDoc)) {
    if (isCurrentWork(work, gen, translatingDoc)) updateTranslateControls();
    return;
  }
  const saveTasks = [];
  const { aborted, pages } = await translateDocumentPages({
    session: work,
    cache: pageCache,
    docId: translatingDoc,
    numPages: total,
    batchSize,
    send: runtimeSend,
    getPageOriginals: (page) => originalsForPage(page, gen, translatingDoc, work, batchSize),
    onPageStart({ page, total: pageTotal }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      translatingPage = page;
      if (!$("status").classList.contains("warn")) setStatus(progressDocumentStatus(page, pageTotal));
    },
    onPageResult({ page, results, res }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      const layout = getPageLayout(page);
      const merged = pageResultsFromTranslation(layout, results);
      pageCache.set(translatingDoc, page, merged);
      if (page === pageNum) pageResults = merged;
      renderArticle();
      if (res?.polishError) setStatus(PDF_COPY.polishFail, true);
    },
    onPageDone({ page, results }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      const layout = getPageLayout(page);
      const base = layout?.kind === "blocks" ? results : mergeReadoutTranslations(layout?.blocks || results, results);
      const merged = withStructureRows(layout, base);
      pageCache.set(translatingDoc, page, merged);
      if (page === pageNum) pageResults = merged;
      renderArticle();
      saveTasks.push(rememberTranslation(page, merged).then(() => null, (error) => error));
    }
  });
  if (!isCurrentWork(work, gen, translatingDoc)) return;
  renderArticle();
  const any = pages.some((entry) => pageHasTranslation(entry.results) ||
    pageHasTranslation(pageCache.get(translatingDoc, entry.page)) ||
    (titleStructure?.page === entry.page && structureLanded(entry.page)));
  if (aborted) setStatus(PDF_COPY.stopped);
  else if (!any) setStatus(PDF_COPY.error, true);
  else setStatus(PDF_COPY.doneDocument);
  const saveErrors = await Promise.all(saveTasks);
  if (!aborted && saveErrors.some(Boolean)) setStatus("译文已生成，但部分页面写入本地库失败。", true);
  translatingPage = 0;
  updateTranslateControls();
}

function snapshotForceReadout(doc, page) {
  const record = titleStructure;
  return {
    pageResults,
    hadCache: pageCache.has(doc, page),
    cached: pageCache.get(doc, page),
    title: record
      ? {
        docId: record.docId,
        page: record.page,
        status: record.status,
        structure: record.structure,
        source: record.source,
        slotsDone: record.slotsDone,
        translated: record.translated
      }
      : null
  };
}

function restoreForceReadout(prior, doc, page) {
  pageResults = prior.pageResults;
  if (prior.hadCache) pageCache.set(doc, page, prior.cached);
  else pageCache.clearPage(doc, page);
  if (!prior.title) titleStructure = null;
  else if (titleStructure) {
    titleStructure.docId = prior.title.docId;
    titleStructure.page = prior.title.page;
    titleStructure.status = prior.title.status;
    titleStructure.structure = prior.title.structure;
    titleStructure.source = prior.title.source;
    titleStructure.slotsDone = prior.title.slotsDone;
    titleStructure.translated = prior.title.translated;
  }
  renderArticle();
}

function unitsForForceRetranslate(layout) {
  if (layout?.kind === "blocks") {
    return unitsForLayout({ ...layout, blocks: blocksForForceRetranslate(layout.blocks) });
  }
  return (unitsForLayout(layout) || []).filter((unit) => unit?.skipTranslate !== true);
}

function structureRetranslateMissed(translatingDoc, targetPage) {
  const record = titleStructure;
  if (!record || record.status !== "ok" || record.docId !== translatingDoc || record.page !== targetPage) return false;
  const slots = structureTranslateSlots(record.source || record.structure);
  if (!slots.length) return false;
  return !structureLanded(targetPage);
}

function armTitleRetranslate(translatingDoc, targetPage) {
  const record = titleStructure;
  if (!record || record.docId !== translatingDoc || record.page !== targetPage) return;
  if (record.status !== "ok") return;
  record.slotsDone = false;
  record.translated = false;
}

function failForceRetranslate(work, prior, doc, page) {
  if (work === session) work.running = false;
  translatingPage = 0;
  forceReadoutHold = false;
  restoreForceReadout(prior, doc, page);
  setStatus(PDF_COPY.retranslateFailed, true);
  updateTranslateControls();
}

function abortForceRetranslate(work, prior, doc, page) {
  if (work === session) work.running = false;
  translatingPage = 0;
  forceReadoutHold = false;
  restoreForceReadout(prior, doc, page);
  setStatus(PDF_COPY.stopped);
  updateTranslateControls();
}

async function forceRetranslateCurrentPage() {
  if (!pdfDoc || pdfTranslateBusy(session)) return;
  const sourceLayout = getPageLayout(pageNum);
  const units = liveOriginals(sourceLayout, unitsForForceRetranslate(sourceLayout));
  const titleCandidate = isTitlePageCandidate(pageNum, pageTextForStructure(sourceLayout?.blocks));
  if (isSkipOnlyPage(sourceLayout?.blocks)) {
    setStatus(PAGE_STATUS_BIBLIOGRAPHY);
    updateTranslateControls();
    return;
  }
  if (!units.length && !titleCandidate) {
    setStatus(pageBlocksCopy(0, pageItems) || PDF_COPY.emptyPage);
    syncNoTextLayerHint(pageItems <= 0);
    updateTranslateControls();
    return;
  }
  const gen = restoreGen;
  const translatingDoc = docId;
  const targetPage = pageNum;
  const prior = snapshotForceReadout(translatingDoc, targetPage);
  const work = beginViewerSession();
  translatingPage = targetPage;
  forceReadoutHold = true;
  updateTranslateControls();
  setStatus(PDF_COPY.retranslateRunning);
  const left = () => {
    if (isCurrentWork(work, gen, translatingDoc)) {
      if (!work.aborted) return false;
      abortForceRetranslate(work, prior, translatingDoc, targetPage);
      return true;
    }
    forceReadoutHold = false;
    if (work === session) work.running = false;
    return true;
  };
  try {
    let batchSize = 8;
    try {
      batchSize = await resolveBatchSize();
    } catch {
      if (!isCurrentWork(work, gen, translatingDoc)) {
        forceReadoutHold = false;
        if (work === session) work.running = false;
        return;
      }
      failForceRetranslate(work, prior, translatingDoc, targetPage);
      return;
    }
    if (left()) return;
    await ensureTitleStructure(targetPage, sourceLayout, { force: true });
    if (left()) return;
    const pageUnits = liveOriginals(sourceLayout, unitsForForceRetranslate(sourceLayout));
    armTitleRetranslate(translatingDoc, targetPage);
    await translateTitleStructure(work, gen, translatingDoc, batchSize);
    if (left()) return;
    const translated = await translatePageBlocks(pageUnits, {
      send: runtimeSend,
      session: work,
      batchSize,
      onBatchStart() {
        if (!isCurrentWork(work, gen, translatingDoc) || work.aborted) return;
        setStatus(PDF_COPY.retranslateRunning);
      }
    });
    if (!isCurrentWork(work, gen, translatingDoc)) return;
    let outcome = forceRetranslateOutcome({
      aborted: Boolean(translated.aborted || work.aborted),
      results: translated.results,
      structureLanded: structureLanded(targetPage)
    });
    if (outcome === "success" && structureRetranslateMissed(translatingDoc, targetPage)) outcome = "failed";
    if (outcome === "aborted") {
      abortForceRetranslate(work, prior, translatingDoc, targetPage);
      return;
    }
    if (outcome !== "success") {
      failForceRetranslate(work, prior, translatingDoc, targetPage);
      return;
    }
    const merged = pageResultsFromTranslation(sourceLayout, translated.results);
    work.running = true;
    translatingPage = targetPage;
    updateTranslateControls();
    try {
      const pairs = pairsFromResults(merged);
      await rememberTranslation(targetPage, merged);
      if (!pairs.length) throw new Error("empty retranslation");
      replaceLibraryPagePairs(libraryDoc, targetPage, pairs);
      pageCache.set(translatingDoc, targetPage, merged);
      pageResults = merged;
      renderArticle();
      if (!work.aborted && isCurrentWork(work, gen, translatingDoc)) setStatus(PDF_COPY.retranslateDone);
    } catch {
      restoreForceReadout(prior, translatingDoc, targetPage);
      setStatus(PDF_COPY.retranslateFailed, true);
    }
    work.running = false;
    translatingPage = 0;
    updateTranslateControls();
  } catch {
    if (isCurrentWork(work, gen, translatingDoc)) failForceRetranslate(work, prior, translatingDoc, targetPage);
    else if (work === session) work.running = false;
  } finally {
    forceReadoutHold = false;
  }
}

function withStructureRows(layout, merged) {
  const record = titleStructure;
  if (!record?.translated || record.docId !== docId || record.page !== layout?.page) return merged;
  const rows = structureTranslationRows(record.source, record.structure);
  return rows.length ? [...rows, ...(merged || [])] : merged;
}

function pageResultsFromTranslation(layout, results) {
  const merged = layout?.kind === "blocks" ? results : mergeReadoutTranslations(layout?.blocks || [], results);
  return withStructureRows(layout, merged);
}

function emptyPageResults(layout) {
  return layout?.kind === "blocks"
    ? unitsForLayout(layout).map((unit) => ({ ...unit, translation: "" }))
    : mergeReadoutTranslations(layout?.blocks || [], []);
}

async function ingestPageLayout(n, isStale) {
  if (!isStale()) layoutNotice = "";
  await loadPdfLayout();
  const mode = pdfEngineMode();
  if (mode === "legacy") return ingestReadoutLayout(n, isStale);
  if (mode === "fixture" && n === 1) return ingestFixtureLayout(n, isStale);
  if (mode === "local-ocr" || mode === "cloud-ocr") {
    const laid = await ingestVendorLayout(n, mode, isStale);
    if (laid) return laid;
    return ingestTextLayerLayout(n, isStale);
  }
  return ingestTextLayerLayout(n, isStale);
}

async function pdfByteHash(bytes = pdfBytes) {
  if (!bytes?.byteLength || !globalThis.crypto?.subtle) return "nohash";
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function readStoredLayout(key) {
  try {
    const bag = await chrome.storage.local.get(key);
    return bag?.[key] || null;
  } catch {
    return null;
  }
}

async function writeStoredLayout(key, page) {
  try {
    await chrome.storage.local.set({ [key]: cacheableLayout(page) });
  } catch {
    /* storage is optional */
  }
}

async function ingestVendorLayout(n, mode, isStale) {
  const settings = cachedPdfLayout || normalizePdfLayout(null);
  if (mode === "cloud-ocr" && !shouldFetchCloud(settings)) {
    if (!isStale()) layoutNotice = LAYOUT_EMPTY_KEY_STATUS;
    return null;
  }
  const page = await pdfDoc.getPage(n);
  if (isStale()) return null;
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  if (isStale()) return null;
  const raster = await renderPageRaster(page);
  if (isStale()) return null;
  const png = raster.canvas.toDataURL("image/png");
  const hash = await pdfByteHash();
  const key = layoutCacheKey({ hash, page: n, mode });
  let mapped = await readStoredLayout(key);
  if (!mapped) {
    try {
      const envelope = mode === "cloud-ocr"
        ? await fetchCloudEnvelope({
            baseUrl: settings.cloudBaseUrl,
            apiKey: settings.cloudApiKey,
            model: settings.cloudModel,
            pngDataUrl: png
          })
        : await fetchLocalEnvelope({
            baseUrl: settings.localBaseUrl,
            page: n,
            imageBase64: png.replace(/^data:image\/png;base64,/, ""),
            pixelWidth: raster.pixelWidth,
            pixelHeight: raster.pixelHeight
          });
      let images = null;
      try {
        const ops = await page.getOperatorList();
        images = { fnArray: ops.fnArray, argsArray: ops.argsArray };
      } catch {
        images = null;
      }
      attachFontRealNames(content.items, page.commonObjs);
      mapped = vendorLayoutToBlocks(envelope, { items: content.items, viewport, images, page: n });
      await writeStoredLayout(key, mapped);
    } catch (err) {
      if (!isStale() && err?.code !== "empty-key") layoutNotice = LAYOUT_FALLBACK_STATUS;
      return null;
    }
  }
  if (isStale()) return null;
  const blocks = await cropLayoutBlocks(raster, page, mapped.blocks, n, isStale);
  if (!blocks || isStale()) return null;
  const layout = stampBodyFont({
    ...mapped,
    kind: "blocks",
    blocks,
    itemCount: extractPageItems(content).length
  }, content.items, viewport);
  setPageLayout(n, layout);
  return layout;
}

async function ingestTextLayerLayout(n, isStale) {
  const page = await pdfDoc.getPage(n);
  if (isStale()) return null;
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  if (isStale()) return null;
  let images = null;
  try {
    const ops = await page.getOperatorList();
    images = { fnArray: ops.fnArray, argsArray: ops.argsArray };
  } catch {
    images = null;
  }
  if (isStale()) return null;
  attachFontRealNames(content.items, page.commonObjs);
  const built = textLayerToBlocks({ items: content.items, viewport, images, page: n });
  const raster = await renderPageRaster(page);
  if (isStale()) return null;
  const blocks = await cropLayoutBlocks(raster, page, built.blocks, n, isStale);
  if (!blocks || isStale()) return null;
  const layout = stampBodyFont({
    ...built,
    kind: "blocks",
    protocol: built.protocol || PROTOCOL,
    blocks,
    itemCount: extractPageItems(content).length
  }, content.items, viewport);
  setPageLayout(n, layout);
  return layout;
}

async function renderPageRaster(page) {
  const viewport = page.getViewport({ scale: CROP_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = formulaDrawContext(canvas);
  await page.render({ canvasContext: context, viewport }).promise;
  compositeWhitePaper(context, canvas);
  return { canvas, pixelWidth: canvas.width, pixelHeight: canvas.height };
}

async function ingestFixtureLayout(n, isStale) {
  const page = await pdfDoc.getPage(n);
  if (isStale()) return null;
  const sample = preparePageBlocks({ ...(await loadSamplePage()), page: n });
  if (isStale()) return null;
  const content = await page.getTextContent();
  if (isStale()) return null;
  const viewport = page.getViewport({ scale: 1 });
  const raster = await renderPageRaster(page);
  if (isStale()) return null;
  const blocks = await cropLayoutBlocks(raster, page, sample.blocks, n, isStale);
  if (!blocks || isStale()) return null;
  const layout = stampBodyFont({
    kind: "blocks",
    protocol: sample.protocol || PROTOCOL,
    page: n,
    pixelWidth: raster.pixelWidth,
    pixelHeight: raster.pixelHeight,
    textSource: sample.textSource || "text-layer",
    blocks,
    itemCount: extractPageItems(content).length
  }, content.items, viewport);
  setPageLayout(n, layout);
  return layout;
}

async function ingestReadoutLayout(n, isStale) {
  const page = await pdfDoc.getPage(n);
  if (isStale()) return null;
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  if (isStale()) return null;
  const items = extractPageItems(content);
  const blocks = extractReadoutBlocks(content, { width: viewport.width, height: viewport.height });
  const layout = stampBodyFont({
    kind: "readout",
    blocks,
    itemCount: items.length,
    pageWidth: viewport.width,
    pageHeight: viewport.height
  }, content.items, viewport);
  setPageLayout(n, layout);
  return layout;
}

async function originalsForPage(n, gen, translatingDoc, work, batchSize) {
  const isStale = () => gen !== restoreGen || translatingDoc !== docId;
  const layout = getPageLayout(n) || (await ingestPageLayout(n, isStale));
  if (!layout || isStale()) return [];
  if (work) {
    await ensureTitleStructure(n, layout);
    if (isStale()) return [];
    await translateTitleStructure(work, gen, translatingDoc, batchSize);
    if (isStale()) return [];
    $("status")?.classList.remove("warn");
  }
  const blocks = unitsForLayout(layout);
  if (n === pageNum) pageOriginals = blocks;
  const cached = pageCache.get(translatingDoc, n);
  pageResults = pageHasTranslation(cached) ? cached : emptyPageResults(layout);
  if (!pageHasTranslation(cached)) pageCache.set(translatingDoc, n, pageResults);
  return liveOriginals(layout, blocks);
}

/** 原文: current page only (clearPage). Does not clear the whole document. */
function restoreOriginal() {
  abortTranslateSession(session);
  restoreGen += 1;
  translatingPage = 0;
  pageResults = [];
  pageCache.clearPage(docId, pageNum);
  renderArticle();
  const copy = pageBlocksCopy(pageOriginals.length, pageItems);
  setStatus(layoutNotice || copy);
  syncNoTextLayerHint(pageItems <= 0);
  updateTranslateControls();
}

async function openFile(file) {
  sourceUrl = file.name || "";
  try {
    await openPdfData(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch {
    setStatus(PDF_COPY.error, true);
    setHasDoc(false);
  }
}

async function openFromSrc(src) {
  setStatus(PDF_COPY.loading);
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error("fetch");
    await openPdfData(new Uint8Array(await res.arrayBuffer()), src);
  } catch {
    setStatus(PDF_COPY.fetchFail, true);
    setHasDoc(false);
  }
}

async function openPdfData(data, title) {
  setStatus(PDF_COPY.loading);
  pdfBytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data || []);
  const loading = getDocument({ data, verbosity: 0 });
  await adoptDoc(await loading.promise, title);
}

async function adoptDoc(doc, title) {
  if (pdfDoc) {
    try {
      await pdfDoc.destroy();
    } catch {
      /* previous doc may already be destroyed */
    }
  }
  abortTranslateSession(session);
  pdfDoc = doc;
  pageNum = 1;
  zoom = DEFAULT_ZOOM;
  docId += 1;
  restoreGen += 1;
  textGen += 1;
  renderGen += 1;
  translatingPage = 0;
  pageCache.clear();
  libraryArticle = null;
  libraryDoc = null;
  titleStructure = null;
  layoutCache.clear();
  formulaRasterCache.clear();
  pageOriginals = [];
  pageResults = [];
  pageItems = 0;
  pageViews = [];
  $("pages").replaceChildren();
  pdfScrollRoot().scrollTop = 0;
  translateScrollRoot().scrollTop = 0;
  renderArticle();
  if (title) document.title = `${PDF_COPY.title} · ${shortTitle(title)}`;
  setHasDoc(true);
  await buildPages();
  updatePager();
  await scheduleVisibleRenders();
  setStatus("原页已打开，正在读取文字层…");
  await loadCurrentPageText();
  syncZoomChip();
}

function shortTitle(value) {
  try {
    const path = new URL(value).pathname;
    return decodeURIComponent(path.split("/").filter(Boolean).pop() || value);
  } catch {
    return String(value || "").split(/[/\\]/).filter(Boolean).pop() || value;
  }
}

async function buildPages() {
  if (!pdfDoc) return;
  const container = $("pages");
  container.replaceChildren();
  pageViews = [];
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale: zoom });
    const wrap = document.createElement("div");
    wrap.className = "pdf-page";
    wrap.dataset.page = String(n);
    wrap.style.width = `${Math.floor(viewport.width)}px`;
    wrap.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    const canvas = document.createElement("canvas");
    canvas.hidden = true;
    wrap.append(canvas);
    container.append(wrap);
    pageViews.push({
      num: n,
      wrap,
      canvas,
      renderedScale: 0,
      renderTask: null
    });
  }
  applyPaperMetrics();
}

async function layoutPages() {
  if (!pdfDoc) return;
  for (const view of pageViews) {
    const page = await pdfDoc.getPage(view.num);
    const viewport = page.getViewport({ scale: zoom });
    view.wrap.style.width = `${Math.floor(viewport.width)}px`;
    view.wrap.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    if (view.renderedScale !== zoom) view.canvas.hidden = true;
  }
}

function pageRects() {
  return pageViews.map((view) => {
    const rect = view.wrap.getBoundingClientRect();
    return { page: view.num, top: rect.top, bottom: rect.bottom };
  });
}

function measureVisible() {
  const pane = pdfScrollRoot();
  const paneRect = pane.getBoundingClientRect();
  return pageFromViewport(pageRects(), paneRect.top, paneRect.bottom);
}

function releaseScrollDriver(side) {
  if (side === "pdf") {
    if (syncOwner.owner === "pdf" || syncOwner.owner === "click") syncOwner.release(syncOwner.owner);
    return;
  }
  if (syncOwner.owner === side) syncOwner.release(side);
}

function onPdfScroll() {
  if (!pdfDoc) return;
  if (syncOwner.ignores("pdf")) return;
  takeDriver("pdf");
  if (scrollTick) return;
  const generation = followGeneration;
  pdfSyncGate.begin();
  scrollTick = requestAnimationFrame(() => {
    scrollTick = 0;
    try {
      if (generation !== followGeneration || syncOwner.owner !== "pdf") return;
      syncVisiblePage();
    } finally {
      if (pdfSyncGate.finish() === "release") releaseScrollDriver("pdf");
    }
  });
}

function onPdfScrollEnd() {
  if (pdfSyncGate.noteEnd() === "defer") return;
  releaseScrollDriver("pdf");
}

function onPdfWheel(event) {
  if (!pdfDoc) return;
  noteUserSourceInput();
  takeDriver("pdf");
  wheelFlip.beginGesture();
  const pane = pdfScrollRoot();
  const overflow = pane.scrollHeight - pane.clientHeight > 4;
  const atTop = pane.scrollTop <= 0;
  const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1;
  const dir = wheelPageDelta({
    deltaY: event.deltaY,
    deltaX: event.deltaX,
    atTop,
    atBottom,
    overflow,
    gestureLatched: wheelFlip.latched
  });
  if (!dir) return;
  wheelFlip.consume();
  goPage(dir);
}

function syncVisiblePage() {
  noteSourcePage(false);
}

async function goPage(dir) {
  if (!pdfDoc) return;
  const next = pageIndex(pageNum, pdfDoc.numPages, dir);
  if (next === pageNum) return;
  takeDriver("pdf");
  pageNum = next;
  const view = pageViews[next - 1];
  view?.wrap.scrollIntoView({ block: "start", behavior: PANE_SYNC_BEHAVIOR });
  updatePager();
  updateSourcePageLabel(next);
  if (currentScope() !== "all") {
    renderArticle();
    const readout = translateScrollRoot();
    if (readout) readout.scrollTop = 0;
    loadCurrentPageText();
  } else if (!getPageLayout(next)) {
    loadCurrentPageText();
  }
  await scheduleVisibleRenders();
}

function formulaCropPlanKeyNow() {
  const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
  const mirror = Number(mirrorZoom) > 0 ? Number(mirrorZoom) : 1;
  const left = Number(zoom) > 0 ? Number(zoom) : 1;
  const avail = paperAvailWidth(translateScrollRoot()?.clientWidth || 0);
  return `${mirror.toFixed(4)}|${left.toFixed(4)}|${dpr.toFixed(3)}|${avail.toFixed(1)}|${readerPrefs.fontSize}`;
}

function noteFormulaCropPlan(layout) {
  if (layout && typeof layout === "object") layout.formulaPlanKey = formulaCropPlanKeyNow();
}

/**
 * Mirror zoom, left-pane zoom, and devicePixelRatio change the CSS size
 * of a formula, figure, or table. The cache key already includes scale
 * and DPR; this replans visuals whose stored key is stale. A miss keeps
 * the page-raster crop.
 */
let formulaCropGen = 0;

function watchFormulaRasterRatio() {
  if (typeof window.matchMedia !== "function") return;
  const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
  let query = null;
  try {
    query = window.matchMedia(`(resolution: ${dpr}dppx)`);
  } catch {
    return;
  }
  const onChange = () => {
    query.removeEventListener?.("change", onChange);
    watchFormulaRasterRatio();
    refreshFormulaCropsForDisplay();
  };
  query.addEventListener?.("change", onChange);
}

async function refreshFormulaCropsForDisplay() {
  if (!pdfDoc) return;
  const key = formulaCropPlanKeyNow();
  const gen = ++formulaCropGen;
  const total = Number(pdfDoc.numPages) || 0;
  let changed = false;
  for (let n = 1; n <= total; n += 1) {
    if (gen !== formulaCropGen) return;
    const layout = getPageLayout(n);
    if (!layout?.blocks?.length || layout.formulaPlanKey === key) continue;
    if (!layout.blocks.some((block) => isSourceRedrawBlock(block) && block.imageUrl)) {
      noteFormulaCropPlan(layout);
      continue;
    }
    let page = null;
    try {
      page = await pdfDoc.getPage(n);
    } catch {
      continue;
    }
    if (gen !== formulaCropGen) return;
    const raster = {
      pixelWidth: layout.pixelWidth,
      pixelHeight: layout.pixelHeight
    };
    for (const block of layout.blocks) {
      if (gen !== formulaCropGen) return;
      if (!isSourceRedrawBlock(block) || !block.imageUrl) continue;
      const sharp = await renderSharpFormulaCrop(page, raster, block, n);
      if (sharp && sharp !== block.imageUrl) {
        block.imageUrl = sharp;
        block.surface = "redraw";
        changed = true;
      }
    }
    noteFormulaCropPlan(layout);
  }
  if (changed && gen === formulaCropGen) renderArticle();
}

function setMirrorZoom(next) {
  mirrorZoom = clampZoom(next);
  persistMirrorZoom(mirrorZoom);
  applyMirrorZoom();
  refreshFormulaCropsForDisplay();
}

function applyMirrorZoom() {
  const scale = String(mirrorZoom);
  const root = $("translateScroll");
  if (root) root.style.setProperty("--oi-mirror-zoom", scale);
  if ($("mirrorPages")) $("mirrorPages").style.setProperty("--oi-mirror-zoom", scale);
  const stack = paperStackEl();
  if (stack) {
    stack.style.setProperty("--oi-mirror-zoom", scale);
    stack.querySelectorAll(".readout").forEach((readout) => {
      readout.style.setProperty("--oi-mirror-zoom", "1");
    });
  }
  if ($("mirrorZoomLabel")) $("mirrorZoomLabel").textContent = zoomLabel(mirrorZoom);
  syncMirrorZoomButtons();
}

function syncMirrorZoomButtons() {
  const chip = $("mirrorZoomChip");
  if (!chip) return;
  const ui = zoomButtonState({ hasDoc: Boolean(pdfDoc), zoom: mirrorZoom });
  $("mirrorZoomOut").disabled = ui.outDisabled;
  $("mirrorZoomIn").disabled = ui.inDisabled;
}

async function setZoom(next) {
  const scale = clampZoom(next);
  if (!pdfDoc || scale === zoom) {
    syncZoomButtons();
    return;
  }
  zoom = scale;
  $("zoomLabel").textContent = zoomLabel(zoom);
  await layoutPages();
  applyPaperMetrics();
  refreshFormulaCropsForDisplay();
  await scheduleVisibleRenders();
  syncZoomChip();
  syncZoomButtons();
  paintPairChrome();
}

async function scheduleVisibleRenders() {
  if (!pdfDoc) return;
  const gen = ++renderGen;
  const want = neighborPages(pageNum, pdfDoc.numPages, RENDER_RADIUS);
  for (const n of want) {
    if (gen !== renderGen) return;
    const view = pageViews[n - 1];
    if (view) await renderView(view);
  }
}

async function renderView(view) {
  if (!pdfDoc || !view) return;
  if (view.renderedScale === zoom && view.canvas.width) return;
  const page = await pdfDoc.getPage(view.num);
  const viewport = page.getViewport({ scale: zoom });
  const canvas = view.canvas;
  const context = canvas.getContext("2d", { alpha: false });
  const outputScale = canvasOutputScale(viewport.width, viewport.height, window.devicePixelRatio || 1);
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  if (view.renderTask) {
    view.renderTask.cancel();
    try {
      await view.renderTask.promise;
    } catch {
      /* cancelled */
    }
  }
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  view.renderTask = page.render({ canvasContext: context, viewport, transform });
  try {
    await view.renderTask.promise;
    canvas.hidden = false;
    view.renderedScale = zoom;
  } catch (err) {
    if (err?.name === "RenderingCancelledException") return;
    setStatus(PDF_COPY.error, true);
  }
}

function showOpenedLayout(layout, isStale) {
  if (!layout || isStale()) return false;
  pageItems = Number(layout.itemCount) || 0;
  pageOriginals = unitsForLayout(layout);
  const cached = pageCache.get(docId, pageNum);
  pageResults = cached || [];
  const copy = isSkipOnlyPage(layout.blocks)
    ? PAGE_STATUS_BIBLIOGRAPHY
    : (pageBlocksCopy(pageOriginals.length, pageItems) || textLayerCopy(pageItems));
  if (!pdfTranslateBusy(session)) {
    if (layoutNotice) setStatus(layoutNotice);
    else if (pageHasTranslation(cached)) setStatus(copy || PDF_COPY.done);
    else setStatus(copy);
  }
  syncNoTextLayerHint(pageItems <= 0);
  if (layout.kind === "blocks") renderArticle();
  return true;
}

async function loadCurrentPageText() {
  if (!pdfDoc) return;
  const ticket = ++textGen;
  const n = pageNum;
  const translatingDoc = docId;
  const isStale = () => ticket !== textGen || translatingDoc !== docId;
  let mode = pdfEngineMode();
  let preloadedSaved = null;
  if (mode === "legacy") {
    preloadedSaved = await savedTranslationFor(n).catch(() => null);
    if (isStale()) return;
    if (libraryDoc?.pages?.length) mode = "text-layer";
  }
  const wantsVendor = mode === "local-ocr" || mode === "cloud-ocr";
  const ensuring = mode === "local-ocr"
    ? runtimeSend({ type: "OI_ENSURE_GLMOCR" }).catch(() => null)
    : Promise.resolve(null);
  try {
    if (wantsVendor) {
      const quick = await ingestTextLayerLayout(n, isStale);
      if (!showOpenedLayout(quick, isStale)) return;
      await ensuring;
      const saved = preloadedSaved || await savedTranslationFor(n).catch(() => null);
      if (saved?.readout && !isStale()) {
        setStatus(PDF_COPY.doneDocument);
        renderArticle();
        updateTranslateControls();
        return;
      }
      if (saved?.pairs && !isStale()) {
        const prepared = bindSavedPairs(saved, unitsForLayout(quick));
        const merged = applySavedPairs(unitsForLayout(quick), prepared.pairs);
        pageResults = merged;
        pageCache.set(docId, n, merged);
        if (!pdfTranslateBusy(session)) {
          setStatus(savedPageStatus(prepared, merged, quick.blocks || []));
          rememberSkipHole(n, quick.blocks);
        }
        renderArticle();
        updateTranslateControls();
        return;
      }
      if (!pdfTranslateBusy(session) && !layoutNotice) setStatus(LAYOUT_STARTING_STATUS);
      updateTranslateControls();
      const laid = await ingestVendorLayout(n, mode, isStale);
      if (!laid || isStale()) {
        if (!isStale() && layoutNotice && !pdfTranslateBusy(session)) setStatus(layoutNotice);
        return;
      }
      layoutNotice = "";
      showOpenedLayout(laid, isStale);
      updateTranslateControls();
      return;
    }
    const layout = mode === "text-layer" && pdfEngineMode() === "legacy"
      ? await ingestTextLayerLayout(n, isStale)
      : await ingestPageLayout(n, isStale);
    if (!showOpenedLayout(layout, isStale)) return;
    await ensuring;
    const saved = preloadedSaved || await savedTranslationFor(n).catch(() => null);
    if (saved?.readout && !isStale()) {
      setStatus(PDF_COPY.doneDocument);
      renderArticle();
    } else if (saved?.pairs && !isStale()) {
      const blocks = layout.blocks || [];
      const prepared = bindSavedPairs(saved, unitsForLayout(layout));
      const merged = applySavedPairs(unitsForLayout(layout), prepared.pairs);
      pageResults = merged;
      pageCache.set(docId, n, merged);
      setStatus(savedPageStatus(prepared, merged, blocks));
      rememberSkipHole(n, blocks);
      renderArticle();
    }
  } catch {
    if (isStale()) return;
    pageItems = 0;
    pageOriginals = [];
    pageResults = [];
    if (!pdfTranslateBusy(session)) setStatus(PDF_COPY.noTextLayer);
    syncNoTextLayerHint(true);
  }
  updateTranslateControls();
}

function updatePager() {
  const total = pdfDoc?.numPages || 0;
  $("pager").textContent = pageLabel(pageNum, total);
  updateSourcePageLabel(pageNum);
  $("zoomLabel").textContent = zoomLabel(zoom);
  $("prev").disabled = !pdfDoc || pageNum <= 1;
  $("next").disabled = !pdfDoc || pageNum >= total;
  syncZoomButtons();
}

function syncZoomButtons() {
  const ui = zoomButtonState({ hasDoc: Boolean(pdfDoc), zoom });
  $("zoomOut").disabled = ui.outDisabled;
  $("zoomIn").disabled = ui.inDisabled;
}

function syncNoTextLayerHint(showLegacy) {
  $("noTextLayerHint").hidden = pdfEngineMode() !== "legacy" || !showLegacy;
}

function setHasDoc(has) {
  if (!has) {
    $("pages").replaceChildren();
    pageViews = [];
    $("pager").textContent = pageLabel(0, 0);
    $("zoomLabel").textContent = zoomLabel(DEFAULT_ZOOM);
    syncNoTextLayerHint(false);
    pageItems = 0;
    pageOriginals = [];
    pageResults = [];
    layoutCache.clear();
    formulaRasterCache.clear();
    renderArticle();
  }
  updatePager();
  updateTranslateControls();
}

function updateTranslateControls() {
  const scope = currentScope();
  const hasBlocks = pageOriginals.length > 0;
  const canTranslate = scope === "all" ? Boolean(pdfDoc) : hasBlocks;
  const ui = pdfToolbarActionState({
    busy: pdfTranslateBusy(session),
    hasDoc: Boolean(pdfDoc),
    canTranslate,
    canRetranslate: pageOriginals.length > 0
  });
  $("translatePage").disabled = ui.translateDisabled;
  $("translatePage").hidden = ui.translateHidden;
  $("retranslatePage").disabled = ui.retranslateDisabled;
  $("stopTranslate").hidden = ui.stopHidden;
  $("stopTranslate").disabled = ui.stopDisabled;
  $("restoreOriginal").disabled = !pageHasTranslation(pageCache.get(docId, pageNum));
  setScopeEnabled(ui.scopeEnabled);
  syncExportControls();
  syncMirrorZoomButtons();
}

function setStatus(text, isError = false, isWarn = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  el.classList.toggle("warn", Boolean(isWarn) && !isError);
}
