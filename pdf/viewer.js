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
  defaultSourceZoom,
  fitWidthZoom,
  formatZoomPercent,
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
  combinePageResults,
  docStatusView,
  libraryPageRunState,
  libraryCoversLiveBlocks,
  shouldPaintPageBody,
  shouldStampPagePainted,
  pageRunState,
  runTitleStructureBatch,
  translationLanded,
  translationSettled,
  canRetranslatePage,
  psEmptyCopy,
  psNoTextCopy,
  psRunning,
  psSkippedCopy,
  qQueued,
  qPaused,
  translatedPageTotal,
  pdfOpenTranslateBlocker,
  pdfTranslateFailureCopy,
  wheelPageDelta,
  pageBlocksCopy,
  pageFromViewport,
  pageHasTranslation,
  pageTranslationComplete,
  unitsNeedingTranslation,
  claimTranslationUnits,
  mergeTranslationRows,
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
  readerToolbarChrome,
  pairBoxStyle,
  pairClickKept,
  sourceAnchorScroll,
  sourceFollowScroll,
  sourceHit,
  splitKeyStep,
  splitPointerRatio,
  structureRolePairs,
  translationJumpScroll,
  visualPaneOrder
} from "../lib/pdf-pairing.js";
import {
  SEL_EDGE_INSET,
  blockWantsSrcFold,
  blocksMeetingSelection,
  createSrcFoldMemory,
  nextSelCollapse,
  placeSelToolbar,
  registerSelAction,
  selAction,
  selScrollDismissed,
  selToolbarModel,
  unionRect
} from "../lib/pdf-sel-toolbar.js";
import {
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
  retainCaptionFormulas,
  cropBlockCanvas,
  cropBlockImage,
  rasterCropRect,
  isTranslatableBlock,
  isVisualBlock,
  preparePageBlocks,
  translatableBlocks,
  visualAlt
} from "../lib/pdf-blocks.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";
import { redrawFormulaGlyphs } from "../lib/pdf-formula-redraw.js";
import {
  LAYOUT_EMPTY_KEY_STATUS,
  LAYOUT_FALLBACK_STATUS,
  LAYOUT_NO_BOXES_STATUS,
  LAYOUT_STARTING_STATUS,
  cacheableLayout,
  currentLayoutVersion,
  fetchCloudEnvelope,
  fetchLocalEnvelope,
  layoutCacheKey,
  layoutFallbackOf,
  normalizePdfLayout,
  resolveLayoutMode,
  shouldFetchCloud,
  storedLayoutCurrent,
  storedLayoutDisplayable
} from "../lib/pdf-layout-client.js";
import { blankFormulaMask, boxesInCrop, measureFormulaCrop, textLayerToBlocks } from "../lib/pdf-text-layer.js";
import {
  READER_SOURCE_BODY_PT,
  displayFormulaColumnPx,
  formulaReadabilityFloor,
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
  splitAriaModel,
  splitLayout,
  themePaperRgb,
  writeReaderPrefs
} from "../lib/pdf-reader-flow.js";
import {
  MINI_RAIL_PX,
  MINI_WIDTH_DEFAULT,
  SIDE_SLOT_TOAST,
  SOURCE_MODE_NARROW_HINT,
  cycleSourceMode,
  effectiveSourceMode,
  f6RegionIds,
  miniWidthFromPointer,
  normalizeMiniWidth,
  normalizeSourceMode,
  sourceModeChoices,
  sourceModeMenuLabel,
  sourcePagingAllowed,
  sourcePopPlace
} from "../lib/pdf-source-mode.js";
import { canvasMeasure, detectCjkSerif } from "../lib/pdf-reader-cjk.js";
import { attachFontRealNames } from "../lib/pdf-mirror.js";
import {
  acceptVisualRedraw,
  assetLayoutCapPx,
  createFormulaRasterCache,
  fitSnappedFormulaCss,
  formulaDevicePixels,
  formulaRasterCacheKey,
  formulaRasterPlan,
  imageInkRatio,
  isSourceRedrawBlock,
  pageCropLooksEmpty,
  visualDisplayCssSize
} from "../lib/pdf-formula-raster.js";
import { applySavedPairs, blockSoftLead, createLibraryWriteQueue, fetchLibraryDocument, isSkipOnlyPage, libraryHoldCopy, libraryProbeFailure, mergeLibraryPairs, pageSoftStatus, PAGE_STATUS_BIBLIOGRAPHY, pairsFromResults, pairsVerifiedForLibrary, pairsWithLiveFormulaSlots, pairsWithoutUnalignedSlots, repairMatrixProjectionPairs, replaceLibraryPagePairs, saveLibraryPage, selectSavedTranslation, storedReadoutBlocks } from "../lib/pdf-library.js";
import { getProvider, missingRequiredField } from "../lib/providers.js";
import { normalizePdfAutoTranslate } from "../lib/storage.js";
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
let pdfPageWidth = 0;
let sourceZoomTouched = false;
let sourceUrl = "";
let docId = 0;
let restoreGen = 0;
let textGen = 0;
let textLoadPage = 0;
let navGen = 0;
let navRevealPage = 0;
let renderGen = 0;
let pageItems = 0;
let pageOriginals = [];
let pageResults = [];
let translatingPage = 0;
let forceReadoutHold = false;
let pageViews = [];
let scrollTick = 0;
const pageCache = createPageCache();
const pageStates = new Map();
let docPhase = "idle";
let pdfTargetLang = "zh-CN";
let pdfProvider = "";
let translatePaused = false;
let autoAfterForce = false;
let forceRetranslatePending = false;
let libraryArticle = null;
let libraryDoc = null;
let titleStructure = null;
const librarySourceSent = new Set();
const enqueueLibraryWrite = createLibraryWriteQueue();
const layoutCache = new Map();
// Pages the library or a previous layout cache already marked skip-only.
// They count as done before the new layout, and must not take a layout slot
// ahead of a page that still needs translation.
const skipLocked = new Set();
let legacySkipSeeded = false;
let session = createTranslateSession();
let zoomChipCustom = false;
let mirrorZoomChipCustom = false;
let exporting = false;
let followState = "on";
let appliedSide = "";
let currentPairId = "";
let jumpPairId = "";
let jumpPart = "";
let peekPairId = "";
let selCtx = null;
let selScrollBase = 0;
let selRestoring = false;
let seeSourceKey = "";
const srcFoldMemory = createSrcFoldMemory(typeof sessionStorage === "undefined" ? null : sessionStorage);
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
let sourcePopTrigger = null;
let sourcePopSwipeY = 0;
let readerBlend = readerImageBlend({ supportsMultiply: true, forcedColors: false });
let toolbarSnapFrame = 0;
const READER_VIEWS = ["zh", "bi", "src"];

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

function toolbarWidthTargets(bar) {
  return [...bar.querySelectorAll("button, [data-tb='text'], [data-tb='status']")].filter((el) => {
    if (el.closest(".more-menu")) return false;
    if (el.dataset.tb === "icon") return false;
    if (el.matches(".more-item")) return false;
    if (el.classList.contains("tb-primary")) return false;
    if (el.classList.contains("tb-title")) return false;
    return true;
  });
}

function wholeToolbarPx(value) {
  if (!Number.isFinite(value) || value < 1) return 0;
  return Math.ceil(value - 1e-3);
}

// 带文字的顶栏控件在挂载、字体 loadingdone、文案变化后把宽度向上取整，
// 这样 DPR1 下 left/width 是整数。图标按钮宽度由 CSS 锁在 30。
function snapToolbarControlWidths() {
  const bar = document.querySelector(".toolbar");
  if (!bar) return;
  const title = bar.querySelector(".tb-title");
  if (title) {
    title.style.width = "";
    title.style.flex = "1 1 auto";
  }
  for (const el of toolbarWidthTargets(bar)) {
    if (el.closest("[hidden]")) continue;
    const style = getComputedStyle(el);
    if (style.display === "none") continue;
    const prevWidth = el.style.width;
    const prevFlex = el.style.flex;
    el.style.flex = "0 0 auto";
    el.style.width = "max-content";
    const snapped = wholeToolbarPx(el.getBoundingClientRect().width);
    el.style.flex = prevFlex;
    el.style.width = snapped ? `${snapped}px` : prevWidth;
  }
  if (title && getComputedStyle(title).display !== "none") {
    const snapped = Math.floor(title.getBoundingClientRect().width + 1e-3);
    title.style.flex = "0 0 auto";
    title.style.width = `${Math.max(0, snapped)}px`;
  }
  document.documentElement.dataset.tbSnap = String(Number(document.documentElement.dataset.tbSnap || 0) + 1);
}

function scheduleToolbarSnap() {
  cancelAnimationFrame(toolbarSnapFrame);
  toolbarSnapFrame = requestAnimationFrame(() => snapToolbarControlWidths());
}

function bindToolbarGeometry() {
  const bar = document.querySelector(".toolbar");
  if (!bar || bar.dataset.tbBound) return;
  bar.dataset.tbBound = "1";
  snapToolbarControlWidths();
  document.fonts?.ready?.then(() => scheduleToolbarSnap()).catch(() => {});
  document.fonts?.addEventListener?.("loadingdone", scheduleToolbarSnap);
  window.addEventListener("resize", scheduleToolbarSnap);
  const observer = new MutationObserver(scheduleToolbarSnap);
  observer.observe(bar, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden"]
  });
}

function init() {
  bindToolbarGeometry();
  bindViewChrome();
  applyToolbarBand();
  $("pick").addEventListener("click", () => $("file").click());
  $("openPdfItem")?.addEventListener("click", () => {
    closeMoreMenu(true);
    $("file").click();
  });
  $("file").addEventListener("change", async () => {
    const file = $("file").files?.[0];
    $("file").value = "";
    if (file) await openFile(file);
  });
  $("sourcePrev")?.addEventListener("click", () => {
    noteUserSourceInput();
    goPage(-1);
  });
  $("sourceNext")?.addEventListener("click", () => {
    noteUserSourceInput();
    goPage(1);
  });
  $("zoomOut").addEventListener("click", () => {
    sourceZoomTouched = true;
    setZoom(nextZoom(zoom, -1));
  });
  $("zoomIn").addEventListener("click", () => {
    sourceZoomTouched = true;
    setZoom(nextZoom(zoom, 1));
  });
  $("mirrorZoomOut")?.addEventListener("click", () => setMirrorZoom(nextZoom(mirrorZoom, -1)));
  $("mirrorZoomIn")?.addEventListener("click", () => setMirrorZoom(nextZoom(mirrorZoom, 1)));
  bindSplitResize();
  bindAutoHideScrollbars();
  initZoomChip();
  initMirrorZoomChip();
  readMirrorZoom().then((saved) => {
    if (saved != null) mirrorZoom = saved;
    applyMirrorZoom();
    refreshFormulaCropsForDisplay();
  });
  watchFormulaRasterRatio();
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
  bindSelToolbar();
  $("translatePage").addEventListener("click", () => startTranslate());
  $("retranslatePage").addEventListener("click", () => forceRetranslateCurrentPage());
  $("translateMenuRetranslate")?.addEventListener("click", () => {
    closeTranslateMenu(true);
    forceRetranslateCurrentPage();
  });
  $("stopTranslate").addEventListener("click", stopTranslateWork);
  $("exportMd").addEventListener("click", () => {
    closeMoreMenu(true);
    exportReadout("md");
  });
  $("exportPdf").addEventListener("click", () => {
    closeMoreMenu(true);
    exportReadout("pdf");
  });
  document.addEventListener("keydown", onKey);
  window.addEventListener("pagehide", abortInflightLayouts);
  window.addEventListener("beforeunload", abortInflightLayouts);
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
      if (message?.type !== "OI_TRANSLATE_PROGRESS") return;
      applyPageProgress(message);
      sendResponse({ ok: true });
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
  if (event.key === "Escape" && closeTranslateMenu(true)) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && closeSourceModeMenu(true)) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && closeSelMenu()) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && closeSelToolbar({ restore: true, dismissPeek: true })) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && dismissSeeSource()) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && closeSourcePop(true)) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && clearJumpMark()) {
    event.preventDefault();
    return;
  }
  if (enterSelMenuFromPointer(event)) return;
  if (onMenuKey(event)) return;
  if (onSourceModeMenuKey(event)) return;
  if (event.key === "F10" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    if (!eventTargetIsField(event.target) && !event.target?.isContentEditable && openSelToolbarFromSelection({ focus: true })) {
      event.preventDefault();
      return;
    }
  }
  if (event.key === "F6" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    closeMoreMenu(false);
    closeTranslateMenu(false);
    closeSourceModeMenu(false);
    cycleF6(event.shiftKey);
    return;
  }
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
  if (readerPrefs.singleKey !== false && !event.shiftKey && !focusInOpenMenu() && !focusInAaPanel()) {
    if (event.key === "t") {
      event.preventDefault();
      cycleReaderView();
      return;
    }
    if (event.key === "[") {
      event.preventDefault();
      if (!sourcePagingAllowed(currentSourceMode())) return;
      noteUserSourceInput();
      goPage(-1);
      return;
    }
    if (event.key === "]") {
      event.preventDefault();
      if (!sourcePagingAllowed(currentSourceMode())) return;
      noteUserSourceInput();
      goPage(1);
      return;
    }
    if (event.key === "\\") {
      event.preventDefault();
      if (!focusInOpenMenu()) cycleSourceModeFromKey();
      return;
    }
    if (event.key === "p" || event.key === "P") {
      event.preventDefault();
      if (!jumpSelectionIfLive()) jumpCurrentToSource();
      return;
    }
    if (event.key === "o") {
      const here = event.target?.closest?.(".oi-sel-toolbar, .oi-sel-menu, .aa-panel")
        || document.activeElement?.closest?.(".oi-sel-toolbar, .oi-sel-menu, .aa-panel");
      if (here) return;
      const pane = event.target?.closest?.(".pane-translate") || document.activeElement?.closest?.(".pane-translate");
      if (!pane) return;
      event.preventDefault();
      toggleFocusedSrcFold(event.target);
      return;
    }
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
  if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && event.target?.closest?.(".split-handle")) return;
  if (event.key === "ArrowLeft") {
    noteUserSourceInput();
    goPage(-1);
  }
  if (event.key === "ArrowRight") {
    noteUserSourceInput();
    goPage(1);
  }
  if (focusInReader(event.target)) return;
  if (event.key === "-" || event.key === "_") {
    sourceZoomTouched = true;
    setZoom(nextZoom(zoom, -1));
  }
  if (event.key === "+" || event.key === "=") {
    sourceZoomTouched = true;
    setZoom(nextZoom(zoom, 1));
  }
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
  const active = document.activeElement;
  const menus = [
    [$("moreMenu"), $("moreButton")],
    [$("translateMenu"), $("translateMenuButton")],
    [$("sourceModeList"), $("sourceModeMenu")]
  ];
  return menus.some(([menu, button]) => {
    if (!menu || menu.hidden) return false;
    return Boolean(active && (menu.contains(active) || active === button));
  });
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
  applySourceLayout(false);
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
  readout?.addEventListener("touchstart", onTranslationTouchStart, { passive: true });
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
  window.addEventListener("resize", () => {
    syncSplitAria(workspace);
    scheduleMiniFitSettle();
  });
}

/** Apply the stored fraction after prefs load. CSS minmax keeps the minimum widths. */
function applyStoredSplitRatio() {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const width = workspace.getBoundingClientRect().width || window.innerWidth || 1200;
  const ratio = readerPrefs.splitRatio == null ? defaultSplitRatio(width) : readerPrefs.splitRatio;
  workspace.style.setProperty("--oi-split-ratio", String(ratio));
  writeSplitAria(workspace, ratio);
}

function startSplitDrag(event, workspace, handle) {
  if (event.button !== 0) return;
  const mode = workspace.dataset.sourceMode || "side";
  if (mode === "hidden" || (mode === "mini" && workspace.dataset.miniCollapsed === "true")) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  workspace.classList.add("is-splitting");
  const onMove = (moveEvent) => applySplit(workspace, moveEvent.clientX);
  const onUp = () => {
    workspace.classList.remove("is-splitting");
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    if (mode === "mini") endMiniFitDrag();
    if (workspace.dataset.sourceMode === "mini") persistMiniWidth(workspace);
    else persistSplitRatio(workspace);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  if (mode === "mini") beginMiniFitDrag();
  applySplit(workspace, event.clientX);
}

function paintSplitRatio(workspace, ratio) {
  const rect = workspace.getBoundingClientRect();
  const width = rect.width || window.innerWidth || 1200;
  const requested = Number(ratio);
  const safe = Number.isFinite(requested) ? requested : defaultSplitRatio(width);
  if (!(rect.width > 0)) {
    const held = requested > 0 && requested < 1 ? requested : defaultSplitRatio(width);
    const rounded = Math.round(held * 10000) / 10000;
    workspace.style.setProperty("--oi-split-ratio", String(rounded));
    writeSplitAria(workspace, rounded);
    return;
  }
  const layout = splitLayout({ width, ratio: safe, splitW: splitColumnWidth(workspace) });
  workspace.style.setProperty("--oi-split-ratio", String(layout.ratio));
  writeSplitAria(workspace, layout.ratio);
}

function persistSplitRatio(workspace) {
  const ratio = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio"));
  if (!Number.isFinite(ratio)) return;
  readerPrefs = { ...readerPrefs, splitRatio: ratio };
  persistReaderPrefs();
}

function resetSplit(workspace) {
  if (workspace?.dataset.sourceMode === "mini") {
    readerPrefs = { ...readerPrefs, miniWidth: MINI_WIDTH_DEFAULT };
    persistReaderPrefs();
    paintMiniWidth(workspace, MINI_WIDTH_DEFAULT);
    syncZoomChip();
    syncMirrorZoomChip();
    applyPaperMetrics();
    layoutCapsule({ keepAnchor: true });
    return;
  }
  const width = workspace.getBoundingClientRect().width || window.innerWidth || 1200;
  paintSplitRatio(workspace, defaultSplitRatio(width));
  persistSplitRatio(workspace);
  syncZoomChip();
  syncMirrorZoomChip();
  applyPaperMetrics();
  layoutCapsule({ keepAnchor: true });
}

function writeSplitAria(workspace, ratio) {
  const handle = workspace?.querySelector(".split-handle");
  if (!handle) return;
  const width = workspace.getBoundingClientRect().width || window.innerWidth || 1200;
  const model = splitAriaModel({
    width,
    ratio,
    splitW: splitColumnWidth(workspace)
  });
  handle.setAttribute("aria-valuemin", String(model.valuemin));
  handle.setAttribute("aria-valuemax", String(model.valuemax));
  handle.setAttribute("aria-valuenow", String(model.valuenow));
  handle.setAttribute("aria-valuetext", model.valuetext);
  const bubble = handle.querySelector(".split-bubble");
  if (bubble) bubble.textContent = model.bubble;
}

function syncSplitAria(workspace) {
  const pdf = workspace.querySelector(".pane-pdf");
  if (!pdf) return;
  const splitW = splitColumnWidth(workspace);
  const available = Math.max(1, workspace.clientWidth - splitW);
  const measured = pdf.getBoundingClientRect().width / available;
  const stored = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio"));
  const ratio = measured > 0 && measured < 1 ? measured : stored;
  writeSplitAria(workspace, ratio);
}

function scrollbarHideDelayMs() {
  const raw = getComputedStyle(document.body).getPropertyValue("--oi-reader-scrollbar-hide-delay");
  const ms = parseFloat(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : 1200;
}

function bindAutoHideScrollbars(root = document) {
  for (const el of root.querySelectorAll(".oi-sb")) {
    if (el.dataset.oiSbBound === "1") continue;
    el.dataset.oiSbBound = "1";
    let timer = 0;
    el.addEventListener("scroll", () => {
      el.dataset.scrolling = "";
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        delete el.dataset.scrolling;
      }, scrollbarHideDelayMs());
    }, { passive: true });
  }
}

function onSplitKey(event, workspace) {
  const step = splitKeyStep({ key: event.key, shift: event.shiftKey, side: appliedSide === "end" ? "end" : "start" });
  if (!step) return;
  event.preventDefault();
  event.stopPropagation();
  if (workspace.dataset.sourceMode === "mini") {
    if (workspace.dataset.miniCollapsed === "true") return;
    let next = normalizeMiniWidth(readerPrefs.miniWidth);
    if (step.to === "min") next = 300;
    else if (step.to === "max") next = 480;
    else if (step.to === "reset") next = MINI_WIDTH_DEFAULT;
    else if (Number.isFinite(step.delta)) next = normalizeMiniWidth(next + step.delta);
    else return;
    readerPrefs = { ...readerPrefs, miniWidth: next };
    persistReaderPrefs();
    paintMiniWidth(workspace, next);
    syncZoomChip();
    syncMirrorZoomChip();
    applyPaperMetrics();
    layoutCapsule({ keepAnchor: true });
    return;
  }
  const width = workspace.getBoundingClientRect().width;
  if (width < 900) return;
  const splitW = splitColumnWidth(workspace);
  const available = Math.max(1, width - splitW);
  const current = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio")) || defaultSplitRatio(width);
  const layout = splitLayout({ width, ratio: current, splitW });
  let next = null;
  if (step.to === "min") next = 0;
  else if (step.to === "max") next = 1;
  else if (step.to === "reset") {
    resetSplit(workspace);
    return;
  } else if (Number.isFinite(step.delta)) next = (layout.source + step.delta) / available;
  else return;
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
  if (workspace?.dataset.sourceMode === "mini") {
    if (workspace.dataset.miniCollapsed === "true") return;
    const rect = workspace.getBoundingClientRect();
    const width = miniWidthFromPointer({
      clientX,
      rect: { x: rect.x, width: rect.width, end: rect.x + rect.width },
      side: appliedSide === "end" ? "end" : "start"
    });
    paintMiniWidth(workspace, width);
    syncZoomChip();
    syncMirrorZoomChip();
    applyPaperMetrics();
    layoutCapsule({ keepAnchor: true });
    return;
  }
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
  if (layout) {
    stampLayoutBids(page, layout);
    noteFormulaCropPlan(layout);
  }
  layoutCache.set(layoutKey(page), layout);
  if (viewerUnderTest() && layout?.blocks) {
    const bucket = globalThis.__oiLayouts || (globalThis.__oiLayouts = {});
    bucket[page] = translatableBlocks(layout.blocks).map((block) => ({
      id: String(block.id || ""),
      bid: String(block.bid || ""),
      sourceId: String(block.sourceId || ""),
      text: String(block.text || ""),
      sourceText: String(block.sourceText || block.text || ""),
      label: String(block.label || "")
    }));
  }
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
    rememberTargetLang(res?.settings);
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
  if (block?.label === "formula") {
    // Crop ink is a raster measurement. setPageLayout hashes the layout-stage
    // 0–1 box frozen here, never the trimmed box or a DOM rect.
    if (!Array.isArray(block.layoutBbox) && Array.isArray(block.bbox)) {
      block.layoutBbox = block.bbox.slice(0, 4);
    }
    block.bbox = formulaInkBbox(raster?.canvas, block);
  }
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
    const originX = Number(block.bbox[0]) || 0;
    const originY = Number(block.bbox[1]) || 0;
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
    if (!formula && !redrawKeepsInk(context, canvas, raster, block)) {
      canvas.width = 0;
      canvas.height = 0;
      return "";
    }
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

function rasterRegionInk(canvas, bbox) {
  if (!canvas || typeof canvas.getContext !== "function" || !Array.isArray(bbox)) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.getImageData !== "function") return null;
  const rect = rasterCropRect(bbox, canvas.width, canvas.height);
  const sw = Math.min(rect.sw, Math.max(0, canvas.width - rect.sx));
  const sh = Math.min(rect.sh, Math.max(0, canvas.height - rect.sy));
  if (sw < 1 || sh < 1) return null;
  try {
    return imageInkRatio(ctx.getImageData(rect.sx, rect.sy, sw, sh));
  } catch {
    return null;
  }
}

function redrawKeepsInk(context, canvas, raster, block) {
  let redrawInk = null;
  try {
    if (context && typeof context.getImageData === "function") {
      redrawInk = imageInkRatio(context.getImageData(0, 0, canvas.width, canvas.height));
    }
  } catch {
    redrawInk = null;
  }
  return acceptVisualRedraw(redrawInk, rasterRegionInk(raster?.canvas, block?.bbox));
}

async function withRasterCrop(raster, page, block, pageNumber, options = {}) {
  if (!isVisualBlock(block) || !Array.isArray(block.bbox)) return block;
  const next = { ...block };
  next.imageUrl = imageForVisualBlock(raster, next);
  if (next.imageUrl) next.surface = "png";
  if ((next.label === "figure" || next.label === "table") && next.imageUrl && pageCropLooksEmpty(rasterRegionInk(raster?.canvas, next.bbox), next.bbox)) {
    next.imageUrl = "";
    delete next.surface;
  }
  if ((next.label === "figure" || next.label === "table") && raster) {
    const cap = assetLayoutCapPx(
      next.bbox,
      raster.pixelWidth || raster.canvas?.width,
      raster.pixelHeight || raster.canvas?.height
    );
    if (cap > 0) next.assetCapPx = cap;
  }
  if (options.sharp !== false && isSourceRedrawBlock(next) && next.imageUrl) {
    const sharp = await renderSharpVisualCrop(page, raster, next, pageNumber);
    if (sharp) {
      next.imageUrl = sharp;
      next.surface = "redraw";
    }
  }
  return next;
}

async function cropLayoutBlocks(raster, page, blocks, pageNumber, isStale, options = {}) {
  const cropped = [];
  for (const block of blocks || []) {
    if (isStale()) return null;
    cropped.push(await withRasterCrop(raster, page, block, pageNumber, options));
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
    const layout = getPageLayout(page);
    const bodyPt = Number(layout?.bodyItemHeight) > 0 ? Number(layout.bodyItemHeight) : READER_SOURCE_BODY_PT;
    const width = pageFraction ? displayFormulaWidthCss(pageFraction, 0, {
      pageWidthPt: Number(layout?.pageWidth) || 0,
      floor: formulaReadabilityFloor(readerPrefs.fontSize, bodyPt)
    }) : "";
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
  const shownPage = page ?? node.dataset.page;
  const img = cropImage(block);
  if (img) {
    img.className = imageClass || "oi-pdf-math-crop";
    if (block.label === "formula") {
      mountDisplayMath(node, block, img, shownPage);
      return;
    }
    if ((block.label === "figure" || block.label === "table") && block.surface === "redraw" && block.assetCapPx > 0) {
      img.style.setProperty("max-width", `min(100%, ${block.assetCapPx}px)`);
      img.style.setProperty("height", "auto");
    }
    const pageFraction = displayCropColumnFraction(block);
    if (pageFraction) {
      const layout = getPageLayout(shownPage);
      const bodyPt = Number(layout?.bodyItemHeight) > 0 ? Number(layout.bodyItemHeight) : READER_SOURCE_BODY_PT;
      img.style.width = displayFormulaWidthCss(pageFraction, Number(block.bbox[3]) - Number(block.bbox[1]), {
        pageWidthPt: Number(layout?.pageWidth) || 0,
        floor: formulaReadabilityFloor(readerPrefs.fontSize, bodyPt)
      });
    }
    if (block.label === "figure" || block.label === "table") noteAssetPaint("image", block, shownPage);
    node.append(img);
    return;
  }
  if (visualCropStillPending(block, shownPage)) {
    node.append(visualCropPendingBox(block, shownPage));
    return;
  }
  const notice = visualCropNotice(block, shownPage);
  if (notice?.classList?.contains("oi-pdf-asset-fallback")) noteAssetPaint("fallback", block, shownPage);
  node.append(notice);
}

const visualCropPendingPages = new Set();

function armStoredVisualCrops(page, layout) {
  if (layoutNeedsVisualCrops(layout)) visualCropPendingPages.add(Number(page));
}

function visualCropStillPending(block, page) {
  const n = Number(page) || 0;
  if (!(n >= 1) || !visualCropPendingPages.has(n) || block?.visualCropFailed === true) return false;
  return block?.label === "figure" || block?.label === "table";
}

function noteAssetPaint(kind, block, page, extra = null) {
  if (!viewerUnderTest()) return;
  const log = globalThis.__oiAssetPaint || (globalThis.__oiAssetPaint = []);
  log.push({
    kind,
    page: Number(page) || 0,
    label: String(block?.label || ""),
    id: String(block?.id || ""),
    ...(extra && typeof extra === "object" ? extra : {})
  });
}

/**
 * Neutral hold while a stored page is still rasterizing.
 * Size comes from visualDisplayCssSize, the same crop-pixel width and
 * aspect the figure image uses, then min(100%, that width) so the column
 * cap matches max-width: 100% on the bitmap.
 */
function visualCropPendingBox(block, page) {
  const n = Number(page) || 0;
  const hold = document.createElement("span");
  hold.className = "oi-pdf-asset-pending";
  hold.setAttribute("role", "status");
  hold.setAttribute("aria-busy", "true");
  const kind = block?.label === "table" ? "表" : "图";
  hold.setAttribute("aria-label", `${kind}正在载入`);
  const layout = getPageLayout(n);
  const pageW = Number(layout?.pageWidth) || 0;
  const pageH = Number(layout?.pageHeight) || 0;
  let aspect = "";
  let width = "";
  if (pageW > 0 && pageH > 0) {
    const sized = visualDisplayCssSize({
      block,
      pageWidth: pageW,
      pageHeight: pageH,
      rasterWidth: Math.max(1, Math.floor(pageW * CROP_SCALE)),
      rasterHeight: Math.max(1, Math.floor(pageH * CROP_SCALE))
    });
    const widthPx = Number(sized?.layoutCapPx) || 0;
    const heightPx = Number(sized?.cssHeight) || 0;
    if (widthPx > 0 && heightPx > 0) {
      width = `min(100%, ${widthPx}px)`;
      aspect = `${widthPx} / ${heightPx}`;
      hold.style.setProperty("width", width);
      hold.style.setProperty("aspect-ratio", aspect);
    }
  }
  noteAssetPaint("pending", block, n, { aspect, width });
  return hold;
}

function markVisualCropsFailed(layout) {
  for (const block of layout?.blocks || []) {
    if ((block?.label === "figure" || block?.label === "table") && Array.isArray(block.bbox) && !block.imageUrl) {
      block.visualCropFailed = true;
    }
  }
}

function visualCropNotice(block, page) {
  const n = Number(page) || 0;
  if ((block?.label === "figure" || block?.label === "table") && n >= 1) {
    const kind = block.label === "table" ? "表" : "图";
    const notice = document.createElement("button");
    notice.type = "button";
    notice.className = "oi-pdf-asset-fallback";
    notice.dataset.page = String(n);
    notice.textContent = `${kind}见原文第 ${n} 页（点击查看）`;
    notice.setAttribute("aria-label", `${kind}见原文第 ${n} 页`);
    notice.addEventListener("click", (event) => {
      event.preventDefault();
      jumpAssetFallback(notice);
    });
    return notice;
  }
  return document.createTextNode(block?.label === "formula"
    ? PDF_COPY.formulaFallback
    : `（${visualAlt(block?.label)}裁图失败，请查看左栏原页）`);
}

function orphanVisualNotice(block, page) {
  const table = /^(?:Table\s*|表\s*)\d+\s*[:：.]/i.test(block?.text || "");
  const notice = visualCropNotice({ label: table ? "table" : "figure" }, page);
  if (notice?.classList?.contains("oi-pdf-asset-fallback")) {
    notice.textContent = PDF_READOUT_COPY.figurePlaceholder;
    const n = Number(page) || 0;
    if (n >= 1) notice.setAttribute("aria-label", `${table ? "表" : "图"}见原文第 ${n} 页`);
  }
  return notice;
}

function jumpAssetFallback(notice) {
  const page = Number(notice?.dataset?.page);
  if (!(page >= 1)) return;
  const host = notice.closest?.("[data-pair-id]");
  if (host?.dataset?.pairId) jumpTranslationToSource(host);
  else {
    dismissSeeSource();
    const presented = presentSourceForJump(notice);
    const run = () => {
      revealSourcePage(page);
      syncSourcePopChrome(page, false);
    };
    if (presented === "ready") run();
    else requestAnimationFrame(() => requestAnimationFrame(run));
  }
  if (followState === "off") applyFollow({ type: "toggle" });
  else if (followState === "paused") applyFollow({ type: "resume" });
}

function captionNode(block, page, layout) {
  const node = document.createElement("figcaption");
  node.className = "oi-pdf-caption";
  node.dataset.page = String(page);
  node.dataset.blockId = String(block.id || "");
  if (block.bid) node.dataset.bid = String(block.bid);
  node.dataset.label = "caption";
  fillBlockText(node, retainCaptionFormulas(block), layout);
  return node;
}

function fillBlockText(node, block, layout) {
  const zh = document.createElement("span");
  zh.className = "rf-zh";
  const src = document.createElement("span");
  src.className = "rf-src";
  writeBlockPieces(zh, block, layout);
  writeBlockPieces(src, { ...block, translation: "", translationStatus: "", failed: false }, layout);
  node.append(zh, src);
}

function writeBlockPieces(node, block, layout) {
  const lead = blockSoftLead(block);
  if (lead) node.append(document.createTextNode(lead));
  // A failed empty translation is not done, but the paragraph still has to
  // show. Use the source sentence and its formula crops rather than an empty box.
  const pending = block?.failed === true && !String(block.translation || "").trim();
  const pieces = blockRenderPieces(pending ? { ...block, translation: "", failed: false } : block, layout.blocks || []);
  if (!pieces.length) {
    const fallback = String((pending ? block.text : block.translation) || block.text || "");
    if (fallback) node.append(document.createTextNode(fallback));
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
      ...(block.bid ? { bid: block.bid } : {}),
      text: block.text,
      sourceText: block.sourceText || block.text,
      original: block.text,
      role: block.label,
      label: block.label
    }));
  }
  return translatableReadoutUnits(layout?.blocks);
}

function viewerUnderTest() {
  try {
    return Boolean(new URLSearchParams(location.search).get("oiAuto"));
  } catch {
    return false;
  }
}

function publishViewerTestHooks() {
  if (!viewerUnderTest()) return;
  globalThis.__oiRenderArticle = () => renderArticle();
  globalThis.__oiOpenPage = async (page) => {
    const n = Number(page);
    if (!(n >= 1) || !pdfDoc) return 0;
    pageNum = n;
    updatePager();
    updateSourcePageLabel(n);
    await loadCurrentPageText(n);
    renderArticle();
    return getPageLayout(n)?.blocks?.length || 0;
  };
  globalThis.__oiTitleState = () => {
    const record = titleStructure;
    if (!record || record.docId !== docId) return null;
    return { slotsDone: record.slotsDone === true, failed: record.failed === true };
  };
  globalThis.__oiSetTarget = (code) => {
    pdfTargetLang = String(code || "").trim() || "zh-CN";
    renderArticle();
  };
  globalThis.__oiNoteState = (page, state) => {
    notePageState(page, { state: String(state || ""), hasLayout: false });
    updateTranslateControls();
  };
  globalThis.__oiLiveBlocks = (page) => translatableBlocks(getPageLayout(Number(page))?.blocks || []).map((block) => ({
    id: String(block.id || ""),
    sourceId: String(block.sourceId || ""),
    text: String(block.text || "")
  }));
}

function landedText(translation, source = "") {
  return translationLanded(translation, source, pdfTargetLang);
}

function settledText(translation, source = "") {
  return translationSettled(translation, source, pdfTargetLang);
}

function rememberTargetLang(settings) {
  const code = String(settings?.targetLang || "").trim();
  if (code) pdfTargetLang = code;
  const provider = String(settings?.provider || "").trim();
  if (provider) pdfProvider = provider;
}

function savedPairSettings() {
  return { targetLang: pdfTargetLang, provider: pdfProvider };
}

/** Keep settled reuse and provider failures. A library echo is a fresh hole, not a bypass. */
function cacheableReuse(units) {
  return (units || []).map((unit) => {
    const source = unit?.original || unit?.text || unit?.sourceText || "";
    if (settledText(unit?.translation, source) || unit?.failed === true) return unit;
    if (!String(unit?.translation || "").trim()) return unit;
    return { ...unit, translation: "" };
  });
}

function libraryEntry(page) {
  return (libraryDoc?.pages || []).find((item) => Number(item.page) === Number(page)) || null;
}

function blocksFromLibraryPairs(page, pairs) {
  return (pairs || []).filter((item) => settledText(item?.translation, item?.text || item?.sourceText || item?.original || "")).map((pair, index) => ({
    id: String(pair.id || pair.sourceId || `lib-${page}-${index}`),
    ...(pair.sourceId ? { sourceId: String(pair.sourceId) } : {}),
    ...(pair.bid ? { bid: String(pair.bid) } : {}),
    label: "text",
    text: String(pair.text || pair.sourceText || ""),
    sourceText: String(pair.sourceText || pair.text || ""),
    translation: String(pair.translation || "")
  }));
}

function readoutTextWithoutFold(el) {
  if (!el?.querySelector?.(".rf-src-fold")) return el?.textContent || "";
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".rf-src-fold").forEach((node) => node.remove());
  return clone.textContent || "";
}

function slotHasTranslation(slot) {
  if (!slot) return false;
  const nodes = [...slot.querySelectorAll(".rf-zh")];
  if (nodes.length) {
    return nodes.some((el) => settledText(el.textContent, el.parentElement?.querySelector(".rf-src")?.textContent || ""));
  }
  return [...slot.querySelectorAll(".oi-pdf-p, h1, h2, h3")].some((el) => settledText(readoutTextWithoutFold(el), ""));
}

function layoutForReadout(layout) {
  const cached = pageCache.get(docId, layout.page);
  const libraryPairs = libraryEntry(layout.page)?.pairs || [];
  let blocks = layout.blocks || [];
  const saved = (Array.isArray(cached) && cached.length) ? cached : libraryPairs;
  if (saved.length && blocks.length) {
    const merged = applySavedPairs(unitsForLayout(layout), saved, savedPairSettings());
    const settled = merged.some((unit) => settledText(unit.translation, unit.original || unit.text || unit.sourceText || ""));
    const retry = merged.some((unit) => unit.failed === true && !String(unit.translation || "").trim());
    // Saved pairs land on the live blocks. They must not replace the block list,
    // or a pre-recovery library page hides the figures the new layout just built.
    // Rows that do not settle for the current language still keep their text:
    // the merged pass blanks them, and the source would then count as landed.
    // A formula slot that cannot be lined up still paints the translation, or the source.
    blocks = applyBlockTranslations(layout.blocks, (settled || retry) ? merged : saved);
  }
  if (!blocks.some((block) => settledText(block.translation, block.text || block.sourceText || ""))) {
    const fallback = blocksFromLibraryPairs(layout.page, libraryPairs.length ? libraryPairs : cached);
    if (fallback.length) {
      const visuals = (layout.blocks || []).filter((block) => block.label === "figure" || block.label === "table");
      if (!visuals.length) return { ...layout, blocks: fallback, textSource: "library" };
      return { ...layout, blocks: [...visuals, ...fallback] };
    }
  }
  return { ...layout, blocks };
}

function appendFixtureReadout(parent, layout, options = {}) {
  const record = titleStructure && titleStructure.docId === docId ? titleStructure : null;
  if (!options.skipStructure && record?.status === "ok" && record.page === layout.page && record.structure) {
    const before = parent.childElementCount;
    renderPdfStructure(record.structure, parent);
    bilingualizeStructure(parent, before, record.source || null);
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
    if (visual && used.has(visual.id)) {
      if (block.label !== "caption") continue;
      // A second caption must not paint the same figure again.
    } else if (visual && (block.label === "figure" || block.label === "table" || block.label === "caption")) {
      const caption = blocks.find((item) => item.captionFor === visual.id);
      used.add(visual.id);
      if (caption) used.add(caption.id);
      const plan = blockReadoutPlan(visual);
      const node = document.createElement(plan.tag);
      node.className = plan.className;
      node.dataset.page = String(page);
      node.dataset.blockId = String(visual.id || "");
      if (visual.bid) node.dataset.bid = String(visual.bid);
      node.dataset.label = String(visual.label || "");
      const capNode = caption ? captionNode(caption, page, layout) : null;
      if (capNode && caption && blocks.indexOf(caption) < blocks.indexOf(visual)) node.append(capNode);
      appendCropOrNotice(node, visual, plan.imageClass, page);
      if (capNode && caption && blocks.indexOf(caption) > blocks.indexOf(visual)) node.append(capNode);
      parent.append(node);
      continue;
    }
    if (block.label === "caption" && !hasFigure && !block.captionFor) {
      parent.append(orphanVisualNotice(block, page));
    }
    const plan = blockReadoutPlan(block);
    const node = document.createElement(plan.tag);
    node.className = plan.className;
    if (plan.role) node.dataset.role = plan.role;
    node.dataset.page = String(page);
    node.dataset.blockId = String(block.id || "");
    if (block.bid) node.dataset.bid = String(block.bid);
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

function splitBilingual(node, sourceText) {
  if (!node || node.querySelector(":scope > .rf-zh, :scope > .rf-src")) return;
  const srcText = String(sourceText || "");
  if (!srcText.trim()) return;
  const zhText = node.textContent || "";
  node.replaceChildren();
  const zh = document.createElement("span");
  zh.className = "rf-zh";
  zh.textContent = zhText;
  const src = document.createElement("span");
  src.className = "rf-src";
  src.textContent = srcText;
  node.append(zh, src);
}

function bilingualizeStructure(parent, start, source) {
  if (!parent || !source) return;
  const added = [...parent.children].slice(start);
  const heading = added.find((el) => el.dataset?.role === "abstract_heading");
  const body = added.find((el) => el.dataset?.role === "abstract_body");
  splitBilingual(added.find((el) => el.tagName === "H1"), source.title);
  splitBilingual(heading, source.abstract?.heading);
  splitBilingual(body, source.abstract?.body);
  const restSource = (source.rest || []).filter((entry) => entry?.role !== "other");
  const extras = added.filter((el) => (el.tagName === "H2" || el.tagName === "P") && el !== heading && el !== body);
  extras.forEach((el, index) => splitBilingual(el, restSource[index]?.text));
  const notes = added.find((el) => el.classList?.contains("oi-pdf-footnotes"));
  const noteSource = (source.rest || []).filter((entry) => entry?.role === "other");
  if (notes) {
    [...notes.querySelectorAll(".oi-pdf-footnote")].forEach((el, index) => {
      splitBilingual(el, noteSource[index]?.text);
    });
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
  dismissSeeSource();
  const presented = presentSourceForJump(node);
  const run = () => {
    const part = node.dataset.pairPart === "inline" ? "inline" : "";
    const rects = decodeSrcRects(node.dataset.srcRects);
    const rect = rects[0];
    if (!rect) {
      const page = Number(node.dataset.page || node.dataset.srcPage);
      if (page >= 1) revealSourcePage(page);
      syncSourcePopChrome(page, false);
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
    syncSourcePopChrome(undefined, Boolean(document.querySelector("#pages .pair-box.is-jump")));
  };
  if (presented === "ready") run();
  else requestAnimationFrame(() => requestAnimationFrame(run));
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

function revealClickedSource(rect) {
  const pane = pdfScrollRoot();
  const placed = rectInSource(rect);
  if (!pane || !placed) return false;
  const top = sourceFollowScroll({
    rectTop: placed.top,
    rectBottom: placed.bottom,
    scrollTop: pane.scrollTop,
    clientHeight: pane.clientHeight,
    scrollHeight: pane.scrollHeight
  });
  if (top == null) return false;
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
  const own = node?.classList?.contains("rf-block") || node?.classList?.contains("rf-ps");
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
  if (peekPairId) {
    const peekNode = flow.querySelector(`[data-pair-id="${cssEscape(peekPairId)}"]:not([data-pair-part="inline"])`)
      || flow.querySelector(`[data-pair-id="${cssEscape(peekPairId)}"]`);
    paintSourceHighlight({ rects: decodeSrcRects(peekNode?.dataset.srcRects), mode: "peek", outset: 5 });
  }
}

function firstNodeRects(pairId) {
  const flow = readerFlowEl();
  const node = [...(flow?.querySelectorAll(`[data-pair-id="${cssEscape(pairId)}"]`) || [])]
    .find((el) => el.dataset.pairPart !== "inline");
  return decodeSrcRects(node?.dataset.srcRects);
}

function drawPairBoxes(rects, jump, outset) {
  paintSourceHighlight({ rects, mode: jump ? "jump" : "passive", outset });
}

function paintSourceHighlight({ rects, mode, outset } = {}) {
  for (const rect of rects || []) {
    const size = pagePointSize(rect.p);
    const wrap = document.querySelector(`#pages .pdf-page[data-page="${rect.p}"]`);
    const style = size ? pairBoxStyle(rect, size.width, size.height, outset) : null;
    if (!wrap || !style) continue;
    const box = document.createElement("div");
    const kind = mode === "jump" ? "is-jump" : mode === "peek" ? "is-peek" : "";
    box.className = kind ? `pair-box ${kind}` : "pair-box";
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
    applySourceLayout(false);
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

function onTranslationTouchStart() {
  releaseJumpLock();
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
  dismissSeeSource();
  jumpPairId = hit.pairId;
  jumpPart = hit.part === "inline" ? "inline" : "";
  currentPairId = hit.pairId;
  writeTranslationJump(block);
  applyFollow({ type: "clickJump" });
  armJumpLock();
  paintPairChrome();
  revealClickedSource(hit);
}

function pageHasFlow(page) {
  return Boolean(readerFlowEl()?.querySelector(`.rf-block[data-src-page="${page}"], .rf-page[data-src-page="${page}"] .rf-block`));
}

function focusUntranslated(page) {
  const row = readerFlowEl()?.querySelector(`.rf-page[data-page="${page}"] > .rf-ps, .rf-q`);
  if (!row) return;
  writeTranslationJump(row);
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
  const blockById = new Map();
  const blockByBid = new Map();
  for (const block of blocks) {
    if (block?.id) blockById.set(String(block.id), block);
    if (block?.bid) blockByBid.set(String(block.bid), block);
  }
  for (const spec of built.nodes) {
    for (const id of spec.blockIds || []) byId.set(`id:${id}`, spec);
    for (const bid of spec.memberBids || []) byId.set(`bid:${bid}`, spec);
  }
  slot.querySelectorAll(".rf-block").forEach((el) => {
    const own = (el.dataset.blockId && blockById.get(String(el.dataset.blockId)))
      || (el.dataset.bid && blockByBid.get(String(el.dataset.bid)))
      || null;
    if (own?.bid) el.dataset.bid = String(own.bid);
    const spec = (el.dataset.blockId && byId.get(`id:${el.dataset.blockId}`))
      || (el.dataset.bid && byId.get(`bid:${el.dataset.bid}`))
      || null;
    if (spec?.pairId && spec.rects?.length) assignPair(el, spec);
  });
  const authors = built.nodes.find((spec) => spec.kind === "authors");
  slot.querySelectorAll("[data-role='authors'], .oi-pdf-authors").forEach((el) => {
    if (!el.dataset.pairId && authors?.pairId) assignPair(el, authors);
    if (!el.dataset.bid && authors?.memberBids?.[0]) el.dataset.bid = String(authors.memberBids[0]);
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
    slot.querySelectorAll(`.oi-pdf-inline-math[data-block-id="${cssEscape(String(spec.blockId))}"]`).forEach((span) => {
      span.dataset.pairId = spec.pairId;
      span.dataset.pairPart = "inline";
      span.dataset.srcRects = encodeSrcRects(spec.rects);
    });
  }
}

function assignPair(el, spec) {
  if (!el || !spec?.pairId || !spec.rects?.length) return;
  el.dataset.pairId = spec.pairId;
  el.dataset.srcRects = encodeSrcRects(spec.rects);
  if (!el.dataset.bid && spec.memberBids?.[0]) el.dataset.bid = String(spec.memberBids[0]);
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
  if (source.parentElement !== workspace) return;
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
  applyToolbarBand();
}

function bindMoreMenu() {
  $("moreButton")?.addEventListener("click", () => {
    if (moreMenuOpen()) closeMoreMenu(true);
    else openMoreMenu();
  });
  $("translateMenuButton")?.addEventListener("click", () => {
    if (translateMenuOpen()) closeTranslateMenu(true);
    else openTranslateMenu();
  });
  $("swapPanes")?.addEventListener("click", () => {
    toggleSourceSide();
    closeMoreMenu(true);
  });
  $("glossaryItem")?.addEventListener("click", () => {
    closeMoreMenu(true);
    showSoonToast();
  });
  for (const id of ["menuNotes", "menuAsk", "menuLibrary"]) {
    $(id)?.addEventListener("click", () => {
      closeMoreMenu(true);
      showSoonToast();
    });
  }
  $("menuAa")?.addEventListener("click", () => {
    closeMoreMenu(false);
    openAaPanel();
  });
  document.addEventListener("pointerdown", (event) => {
    const menu = $("moreMenu");
    const button = $("moreButton");
    if (moreMenuOpen() && !menu?.contains(event.target) && !button?.contains(event.target)) closeMoreMenu(false);
    const translateMenu = $("translateMenu");
    const translateButton = $("translateMenuButton");
    if (translateMenuOpen() && !translateMenu?.contains(event.target) && !translateButton?.contains(event.target)) {
      closeTranslateMenu(false);
    }
    const sourceMenu = $("sourceModeList");
    const sourceButton = $("sourceModeMenu");
    if (sourceModeMenuOpen() && !sourceMenu?.contains(event.target) && !sourceButton?.contains(event.target)) {
      closeSourceModeMenu(false);
    }
  });
  window.addEventListener("resize", applyToolbarBand);
  applyToolbarBand();
  syncSwapCheck();
}

let toastTimer = 0;

function showToast(text) {
  const el = $("tbToast");
  if (!el) return;
  el.hidden = false;
  el.textContent = text || "即将推出";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 1600);
}

function showSoonToast() {
  showToast("即将推出");
}

function setDocTitle(title) {
  const el = $("docTitle");
  if (!el) return;
  const text = title ? shortTitle(title) : PDF_COPY.title;
  el.textContent = text;
  el.title = text;
}

function setReaderView(next) {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const view = READER_VIEWS.includes(next) ? next : "zh";
  workspace.dataset.view = view;
  for (const button of document.querySelectorAll("#viewSeg [data-view]")) {
    button.setAttribute("aria-checked", button.dataset.view === view ? "true" : "false");
  }
}

function cycleReaderView() {
  const current = document.querySelector(".workspace")?.dataset.view || "zh";
  const index = Math.max(0, READER_VIEWS.indexOf(current));
  setReaderView(READER_VIEWS[(index + 1) % READER_VIEWS.length]);
}

function bindViewChrome() {
  $("viewSeg")?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-view]");
    if (!button || !$("viewSeg")?.contains(button)) return;
    setReaderView(button.dataset.view);
  });
  bindSourceModeChrome();
  for (const id of ["tocButton", "notesButton", "askButton", "libraryButton"]) {
    $(id)?.addEventListener("click", () => showSoonToast());
  }
  setReaderView(document.querySelector(".workspace")?.dataset.view || "zh");
}

function readerWidth() {
  return window.innerWidth || document.documentElement?.clientWidth || 1200;
}

function currentSourceMode() {
  return document.querySelector(".workspace")?.dataset.sourceMode || effectiveSourceMode({
    width: readerWidth(),
    stored: readerPrefs.sourceMode
  });
}

function sideSlotOpen() {
  const flagged = document.querySelector("#notesButton[data-open='true'], #askButton[data-open='true'], #libraryButton[data-open='true'], [data-side-panel][data-open='true']");
  if (flagged) return true;
  const slot = document.querySelector("[data-side-slot]");
  if (!slot || slot.hidden) return false;
  if (slot.dataset.open === "false") return false;
  return slot.dataset.open === "true" || slot.getAttribute("aria-hidden") === "false";
}

function sourcePopOpen() {
  const pop = $("sourcePop");
  return Boolean(pop && !pop.hidden);
}

function bindSourceModeChrome() {
  $("sourceModeSeg")?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-source-mode]");
    if (!button || !$("sourceModeSeg")?.contains(button)) return;
    commitSourceMode(button.dataset.sourceMode);
  });
  $("sourceModeSeg")?.addEventListener("keydown", onSourceModeSegKey);
  $("sourceModeMenu")?.addEventListener("click", () => {
    if (sourceModeMenuOpen()) closeSourceModeMenu(true);
    else openSourceModeMenu();
  });
  $("sourceModeList")?.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-source-mode]");
    if (!button) return;
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      showToast(button.title || SOURCE_MODE_NARROW_HINT);
      return;
    }
    commitSourceMode(button.dataset.sourceMode);
    closeSourceModeMenu(true);
  });
  $("sourceModeNarrow")?.addEventListener("click", onSourcePageButton);
  $("sourceToSide")?.addEventListener("click", () => commitSourceMode("side"));
  $("sourceCollapse")?.addEventListener("click", () => setMiniCollapsed(true));
  $("sourceRail")?.addEventListener("click", () => setMiniCollapsed(false));
  $("sourcePopPin")?.addEventListener("click", pinSourcePop);
  $("sourcePopFull")?.addEventListener("click", toggleSourcePopFull);
  $("sourcePopClose")?.addEventListener("click", () => closeSourcePop(true));
  const head = document.querySelector(".source-pop-head");
  head?.addEventListener("touchstart", (event) => {
    sourcePopSwipeY = event.touches?.[0]?.clientY || 0;
  }, { passive: true });
  head?.addEventListener("touchend", (event) => {
    const y = event.changedTouches?.[0]?.clientY || 0;
    if (y - sourcePopSwipeY > 48) closeSourcePop(true);
  }, { passive: true });
  const pages = $("pages");
  if (pages && pages.tabIndex < 0) pages.tabIndex = -1;
}

function onSourceModeSegKey(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const buttons = [...($("sourceModeSeg")?.querySelectorAll("[data-source-mode]") || [])];
  const enabled = buttons.filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  if (!enabled.length) return;
  event.preventDefault();
  const current = enabled.findIndex((button) => button.getAttribute("aria-checked") === "true");
  const delta = event.key === "ArrowRight" ? 1 : -1;
  const next = enabled[(current + delta + enabled.length) % enabled.length];
  commitSourceMode(next.dataset.sourceMode);
  next.focus();
}

function sourceModeMenuOpen() {
  const menu = $("sourceModeList");
  return Boolean(menu && !menu.hidden);
}

function openSourceModeMenu() {
  const menu = $("sourceModeList");
  const button = $("sourceModeMenu");
  if (!menu || !button) return;
  closeMoreMenu(false);
  closeTranslateMenu(false);
  syncSourceModeControls();
  menu.hidden = false;
  button.setAttribute("aria-expanded", "true");
  const current = menu.querySelector("[aria-checked='true']") || menu.querySelector("[data-source-mode]");
  current?.focus();
}

function closeSourceModeMenu(focusButton) {
  const menu = $("sourceModeList");
  if (!menu || menu.hidden) return false;
  menu.hidden = true;
  $("sourceModeMenu")?.setAttribute("aria-expanded", "false");
  if (focusButton) $("sourceModeMenu")?.focus();
  return true;
}

function onSourceModeMenuKey(event) {
  if (!sourceModeMenuOpen()) return false;
  const items = [...($("sourceModeList")?.querySelectorAll("[data-source-mode]") || [])];
  const enabled = items.filter((item) => !item.disabled && item.getAttribute("aria-disabled") !== "true");
  if (event.key === "Escape") return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    event.preventDefault();
    if (!enabled.length) return true;
    const index = enabled.indexOf(document.activeElement);
    let next = 0;
    if (event.key === "End") next = enabled.length - 1;
    else if (event.key === "ArrowDown") next = index < 0 ? 0 : Math.min(enabled.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = index < 0 ? enabled.length - 1 : Math.max(0, index - 1);
    enabled[next]?.focus();
    return true;
  }
  if (event.key === "Enter" || event.key === " ") {
    const button = document.activeElement?.closest?.("[data-source-mode]");
    if (button && $("sourceModeList")?.contains(button)) {
      event.preventDefault();
      commitSourceMode(button.dataset.sourceMode);
      closeSourceModeMenu(true);
      return true;
    }
  }
  return false;
}

function commitSourceMode(mode) {
  const next = normalizeSourceMode(mode);
  if (!next) return;
  const choices = sourceModeChoices(readerWidth());
  if (!choices.includes(next)) {
    showToast(SOURCE_MODE_NARROW_HINT);
    return;
  }
  readerPrefs = { ...readerPrefs, sourceMode: next };
  persistReaderPrefs();
  if (sourcePopOpen() && next !== "hidden") closeSourcePop(false);
  applySourceLayout(true);
  applyFollow({ type: "sourceModeChange" });
}

function setMiniCollapsed(collapsed) {
  readerPrefs = { ...readerPrefs, sourceMode: "mini", miniCollapsed: Boolean(collapsed) };
  persistReaderPrefs();
  applySourceLayout(true);
  applyFollow({ type: "sourceModeChange" });
}

function cycleSourceModeFromKey() {
  const result = cycleSourceMode({
    width: readerWidth(),
    current: currentSourceMode(),
    sideSlotOpen: sideSlotOpen()
  });
  if (result.blocked) {
    if (result.toast) showToast(result.toast || SIDE_SLOT_TOAST);
    return;
  }
  commitSourceMode(result.mode);
}

function applySourceLayout(anchor) {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const width = readerWidth();
  const mode = effectiveSourceMode({ width, stored: readerPrefs.sourceMode });
  const prev = workspace.dataset.sourceMode || "";
  const changed = Boolean(prev) && prev !== mode;
  const token = anchor || changed ? captureReaderAnchor() : null;
  workspace.dataset.sourceMode = mode;
  const collapsed = mode === "mini" && readerPrefs.miniCollapsed === true;
  workspace.dataset.miniCollapsed = collapsed ? "true" : "false";
  const px = collapsed ? MINI_RAIL_PX : normalizeMiniWidth(readerPrefs.miniWidth);
  workspace.style.setProperty("--oi-mini-width", `${px}px`);
  if (mode === "mini" && !collapsed) paintMiniWidth(workspace, px);
  else if (mode === "side") {
    const ratio = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio"));
    writeSplitAria(workspace, Number.isFinite(ratio) ? ratio : defaultSplitRatio(width));
  }
  const handle = workspace.querySelector(".split-handle");
  if (handle) {
    const draggable = mode === "side" || (mode === "mini" && !collapsed);
    handle.tabIndex = draggable ? 0 : -1;
    handle.setAttribute("aria-hidden", draggable ? "false" : "true");
  }
  if (mode !== "hidden" && sourcePopOpen()) closeSourcePop(false);
  else if (sourcePopOpen()) {
    placeSourcePop(sourcePopPlace(width));
    if (bottomSheetOpen()) closeSelToolbar({ restore: false });
  }
  syncSourceModeControls();
  if (changed) {
    applyDefaultSourceZoom(mode);
    applyFollow({ type: "sourceModeChange" });
  }
  syncSourceFollowAvailability();
  if (token) {
    requestAnimationFrame(() => {
      layoutCapsule({ keepAnchor: true });
      restoreReaderAnchor(token);
      requestAnimationFrame(() => restoreReaderAnchor(token));
    });
  }
}

function syncSourceModeControls() {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const width = readerWidth();
  const mode = workspace.dataset.sourceMode || "side";
  const choices = sourceModeChoices(width);
  const collapsed = workspace.dataset.miniCollapsed === "true";
  for (const button of document.querySelectorAll("#sourceModeSeg [data-source-mode], #sourceModeList [data-source-mode]")) {
    const on = button.dataset.sourceMode === mode;
    button.setAttribute("aria-checked", on ? "true" : "false");
    const allowed = choices.includes(button.dataset.sourceMode);
    const block = !allowed && !on;
    button.disabled = block;
    button.setAttribute("aria-disabled", block ? "true" : "false");
    button.title = block ? SOURCE_MODE_NARROW_HINT : sourceModeMenuLabel(button.dataset.sourceMode).replace(/^原文：/, "");
  }
  const menu = $("sourceModeMenu");
  if (menu) menu.textContent = `${sourceModeMenuLabel(mode)} ▾`;
  const toSide = $("sourceToSide");
  const collapse = $("sourceCollapse");
  const rail = $("sourceRail");
  if (toSide) toSide.hidden = !(mode === "mini" && !collapsed && choices.includes("side"));
  if (collapse) collapse.hidden = !(mode === "mini" && !collapsed);
  if (rail) rail.hidden = !(mode === "mini" && collapsed);
  const pin = $("sourcePopPin");
  if (pin) {
    const canPin = choices.includes("mini");
    pin.disabled = !canPin;
    pin.title = canPin ? "固定为小窗" : SOURCE_MODE_NARROW_HINT;
  }
  const full = $("sourcePopFull");
  if (full) full.hidden = sourcePopPlace(width) !== "bottom";
}

function paintMiniWidth(workspace, width) {
  const next = normalizeMiniWidth(width);
  workspace.style.setProperty("--oi-mini-width", `${next}px`);
  const handle = workspace.querySelector(".split-handle");
  if (!handle || workspace.dataset.miniCollapsed === "true") return;
  handle.setAttribute("aria-valuemin", "300");
  handle.setAttribute("aria-valuemax", "480");
  handle.setAttribute("aria-valuenow", String(next));
  handle.setAttribute("aria-valuetext", `原文栏 ${next}px`);
  const bubble = handle.querySelector(".split-bubble");
  if (bubble) bubble.textContent = `原文栏 ${next}px`;
  syncMiniFitZoom();
}

function persistMiniWidth(workspace) {
  const raw = parseFloat(workspace.style.getPropertyValue("--oi-mini-width"));
  const width = normalizeMiniWidth(raw);
  readerPrefs = { ...readerPrefs, miniWidth: width };
  persistReaderPrefs();
}

function captureSourceScroll() {
  const pane = $("pages");
  return {
    top: pane?.scrollTop || 0,
    left: pane?.scrollLeft || 0
  };
}

function restoreSourceScroll(saved) {
  const pane = $("pages");
  if (!pane || !saved) return;
  pane.scrollTop = saved.top;
  pane.scrollLeft = saved.left;
}

function placeSourceInWorkspace() {
  const workspace = document.querySelector(".workspace");
  const source = $("pdfPane");
  const split = workspace?.querySelector(":scope > .split-handle") || document.querySelector(".split-handle");
  if (!workspace || !source || !split) return;
  const side = workspace.dataset.sourceSide === "end" ? "end" : "start";
  if (side === "end") split.after(source);
  else split.before(source);
}

function placeSourcePop(place) {
  const pop = $("sourcePop");
  const workspace = document.querySelector(".workspace");
  if (!pop) return;
  pop.dataset.place = place === "bottom" ? "bottom" : "side";
  pop.dataset.side = workspace?.dataset.sourceSide === "end" ? "end" : "start";
  if (pop.dataset.place !== "bottom") pop.dataset.full = "0";
}

function openSourcePop(trigger) {
  const pop = $("sourcePop");
  const body = $("sourcePopBody");
  const pane = $("pdfPane");
  if (!pop || !body || !pane) return false;
  if (!pop.hidden && pane.parentElement === body) return true;
  sourcePopTrigger = trigger && trigger.nodeType === 1 ? trigger : null;
  const saved = captureSourceScroll();
  body.append(pane);
  restoreSourceScroll(saved);
  pop.hidden = false;
  const workspace = document.querySelector(".workspace");
  if (workspace) workspace.dataset.sourcePop = "open";
  raiseFloatingChrome("pop");
  placeSourcePop(sourcePopPlace(readerWidth()));
  if (bottomSheetOpen()) closeSelToolbar({ restore: false });
  if (!document.querySelector("#pages canvas")) {
    const title = $("sourcePopTitle");
    if (title) title.textContent = "正在定位…";
  } else syncSourcePopChrome(undefined, false);
  $("sourcePopClose")?.focus();
  scheduleVisibleRenders();
  syncSourceFollowAvailability();
  return true;
}

function closeSourcePop(restoreFocus) {
  const pop = $("sourcePop");
  if (!pop || pop.hidden) return false;
  const saved = captureSourceScroll();
  placeSourceInWorkspace();
  restoreSourceScroll(saved);
  pop.hidden = true;
  const workspace = document.querySelector(".workspace");
  if (workspace) delete workspace.dataset.sourcePop;
  const trigger = sourcePopTrigger;
  sourcePopTrigger = null;
  if (restoreFocus && trigger?.isConnected) trigger.focus();
  syncSourceFollowAvailability();
  return true;
}

function syncSourceFollowAvailability() {
  const mode = currentSourceMode();
  applyFollow({
    type: "sourceAvailable",
    available: mode !== "hidden" || sourcePopOpen(),
    stored: readerPrefs.follow === false ? "0" : "1"
  });
}

function syncSourcePopChrome(page, located) {
  const title = $("sourcePopTitle");
  if (!title || !sourcePopOpen()) return;
  const n = Number.isFinite(Number(page)) && Number(page) >= 1
    ? Number(page)
    : Number($("pageCapsule")?.dataset.srcPage) || pageNum || 0;
  if (!(n >= 1)) {
    title.textContent = "原文";
    return;
  }
  const boxed = located === true || (located == null && Boolean(document.querySelector("#pages .pair-box.is-jump")));
  title.textContent = boxed ? `原文第 ${n} 页 · 已定位` : `原文第 ${n} 页`;
}

function toggleSourcePopFull() {
  const pop = $("sourcePop");
  if (!pop || pop.dataset.place !== "bottom") return;
  pop.dataset.full = pop.dataset.full === "1" ? "0" : "1";
}

function pinSourcePop() {
  if (!sourceModeChoices(readerWidth()).includes("mini")) {
    showToast(SOURCE_MODE_NARROW_HINT);
    return;
  }
  readerPrefs = { ...readerPrefs, sourceMode: "mini", miniCollapsed: false };
  persistReaderPrefs();
  closeSourcePop(false);
  applySourceLayout(true);
  applyFollow({ type: "sourceModeChange" });
}

function presentSourceForJump(trigger) {
  const mode = currentSourceMode();
  if (mode === "hidden") {
    openSourcePop(trigger);
    return "pop";
  }
  const workspace = document.querySelector(".workspace");
  if (mode === "mini" && workspace?.dataset.miniCollapsed === "true") {
    setMiniCollapsed(false);
    return "expand";
  }
  return "ready";
}

function jumpCurrentToSource() {
  const flow = readerFlowEl();
  const node = flow?.querySelector(".is-pair-current[data-pair-id]") || anchorBlock(translateScrollRoot());
  if (node?.dataset?.pairId) {
    jumpTranslationToSource(node);
    return;
  }
  const trigger = document.activeElement;
  const presented = presentSourceForJump(trigger);
  const page = Number($("pageCapsule")?.dataset.srcPage) || pageNum;
  const run = () => {
    if (page >= 1) revealSourcePage(page);
    syncSourcePopChrome(page, false);
  };
  if (presented === "ready") run();
  else requestAnimationFrame(() => requestAnimationFrame(run));
}

function bindSelToolbar() {
  registerSelAction({ id: "see-source", run: (ctx) => seeSourceForSelection(ctx) });
  registerSelAction({ id: "jump-source", run: (ctx) => jumpSourceForSelection(ctx) });
  registerSelAction({ id: "copy", run: (ctx) => copySelectionText(ctx) });
  document.addEventListener("mouseup", onSelGestureEnd);
  document.addEventListener("touchend", onSelGestureEnd);
  document.addEventListener("keyup", onSelGestureEnd);
  document.addEventListener("selectionchange", onSelSelectionChange);
  document.addEventListener("pointerdown", onSelPointerDown);
}

function onSelGestureEnd(event) {
  if (event.type === "mouseup" && event.button !== 0) return;
  if (event.type === "keyup") {
    const key = event.key || "";
    const selectionKey = key === "Shift" || key.startsWith("Arrow") || key === "Home" || key === "End"
      || key === "PageUp" || key === "PageDown";
    if (!selectionKey) return;
    // Shift+F10 and roving keyup land here after focus has moved. Rebuilding would drop it.
    const inChrome = event.target?.closest?.(".oi-sel-toolbar, .oi-sel-menu")
      || document.activeElement?.closest?.(".oi-sel-toolbar, .oi-sel-menu");
    if (inChrome) return;
  } else if (event.target?.closest?.("button, a, input, textarea, select, .oi-sel-toolbar, .oi-sel-menu, .oi-src-strip")) {
    return;
  }
  const ctx = readSelContext();
  if (!ctx) return;
  showSelToolbar(ctx);
}

function onSelSelectionChange() {
  if (selRestoring) return;
  if (readSelContext()) return;
  const active = document.activeElement;
  if (active?.closest?.(".oi-sel-toolbar, .oi-sel-menu")) return;
  closeSelToolbar({ restore: false });
}

function onSelPointerDown(event) {
  const menu = document.querySelector(".oi-sel-menu");
  const more = document.querySelector(".oi-sel-toolbar [data-sel-action='more']");
  if (!menu || menu.hidden) return;
  if (menu.contains(event.target) || more?.contains(event.target)) return;
  closeSelMenu();
}

function openSelToolbarFromSelection(options) {
  const ctx = readSelContext();
  if (!ctx) return false;
  showSelToolbar(ctx, options);
  return true;
}

function jumpSelectionIfLive() {
  const ctx = readSelContext();
  if (!ctx) return false;
  jumpSourceForSelection(ctx);
  return true;
}

function bottomSheetOpen() {
  const pop = $("sourcePop");
  return Boolean(pop && !pop.hidden && pop.dataset.place === "bottom");
}

function showSelToolbar(ctx, { focus = false } = {}) {
  if (!ctx) return;
  if (bottomSheetOpen()) {
    closeSelToolbar({ restore: false });
    return;
  }
  const bar = ensureSelToolbar();
  if (!focus && !bar.hidden && selCtx?.key === ctx.key) {
    positionSelToolbar(ctx);
    return;
  }
  if (seeSourceKey && seeSourceKey !== ctx.key) dismissSeeSource();
  selCtx = ctx;
  selScrollBase = translateScrollRoot()?.scrollTop || 0;
  const collapsed = [];
  bar.hidden = false;
  renderSelToolbar(ctx, collapsed);
  const root = translateScrollRoot();
  let guard = 0;
  while (root && bar.offsetWidth > root.clientWidth - SEL_EDGE_INSET * 2 && guard < 4) {
    const ids = [...bar.querySelectorAll(":scope > .oi-sel-btn")]
      .map((btn) => btn.dataset.selAction)
      .filter((id) => id && id !== "more");
    const next = nextSelCollapse(ids);
    if (!next) break;
    collapsed.push(next);
    renderSelToolbar(ctx, collapsed);
    guard += 1;
  }
  positionSelToolbar(ctx);
  raiseFloatingChrome("sel");
  armSelTabStops();
  if (focus) focusFirstSelButton();
}

function ensureSelToolbar() {
  let bar = document.querySelector(".oi-sel-toolbar");
  if (bar) return bar;
  bar = document.createElement("div");
  bar.className = "oi-sel-toolbar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "选区工具条");
  bar.hidden = true;
  bar.addEventListener("mousedown", keepSelPointer);
  bar.addEventListener("click", onSelToolbarClick);
  bar.addEventListener("keydown", onSelToolbarRoving);
  const menu = document.createElement("div");
  menu.className = "oi-sel-menu";
  menu.id = "oiSelMenu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  menu.addEventListener("mousedown", keepSelPointer);
  menu.addEventListener("click", onSelMenuClick);
  menu.addEventListener("keydown", onSelMenuKey);
  bar.append(menu);
  translateScrollRoot()?.append(bar);
  return bar;
}

function keepSelPointer(event) {
  if (event.button != null && event.button !== 0) return;
  event.preventDefault();
}

function renderSelToolbar(ctx, collapsedIds) {
  const bar = ensureSelToolbar();
  const menu = bar.querySelector(".oi-sel-menu");
  const model = selToolbarModel(ctx, { collapsedIds });
  [...bar.children].forEach((el) => {
    if (el !== menu) el.remove();
  });
  for (const item of model.buttons) bar.insertBefore(selToolbarButton(item), menu);
  menu.replaceChildren();
  for (const item of model.menu) menu.append(selMenuButton(item));
  const more = bar.querySelector("[data-sel-action='more']");
  if (more) more.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
}

function selToolbarButton(item) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "oi-sel-btn";
  btn.dataset.selAction = item.id;
  btn.textContent = item.label;
  btn.tabIndex = -1;
  if (item.ariaLabel) btn.setAttribute("aria-label", item.ariaLabel);
  if (item.id === "more") {
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", "oiSelMenu");
  }
  if (item.disabled) {
    btn.disabled = true;
    btn.title = item.title || "这段没有配对";
  }
  if (item.keyshortcuts) btn.setAttribute("aria-keyshortcuts", item.keyshortcuts);
  return btn;
}

function selMenuButton(item) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "menuitem");
  btn.dataset.selAction = item.id;
  btn.tabIndex = -1;
  if (item.id === "copy") {
    btn.append(document.createTextNode(item.label));
    const key = document.createElement("span");
    key.className = "k";
    key.textContent = "⌘C";
    btn.append(key);
  } else btn.textContent = item.label;
  if (item.keyshortcuts) btn.setAttribute("aria-keyshortcuts", item.keyshortcuts);
  return btn;
}

function positionSelToolbar(ctx) {
  const root = translateScrollRoot();
  const bar = document.querySelector(".oi-sel-toolbar");
  if (!root || !bar || bar.hidden || !ctx?.anchor) return;
  const place = placeSelToolbar({
    anchor: ctx.anchor,
    toolbar: { width: bar.offsetWidth, height: bar.offsetHeight },
    root: { width: root.clientWidth, height: root.clientHeight }
  });
  bar.dataset.placement = place.placement;
  bar.style.top = `${Math.round(place.top + root.scrollTop)}px`;
  bar.style.insetInlineStart = `${Math.round(place.inlineStart + root.scrollLeft)}px`;
}

function armSelTabStops() {
  const buttons = selToolbarButtons();
  const enabled = buttons.filter((btn) => !btn.disabled);
  buttons.forEach((btn) => {
    btn.tabIndex = enabled.length && btn === enabled[0] ? 0 : -1;
  });
}

function focusFirstSelButton() {
  const buttons = selToolbarButtons();
  const enabled = buttons.filter((btn) => !btn.disabled);
  if (!enabled[0]) return;
  buttons.forEach((btn) => {
    btn.tabIndex = btn === enabled[0] ? 0 : -1;
  });
  enabled[0].focus();
}

function selToolbarButtons() {
  return [...document.querySelectorAll(".oi-sel-toolbar > .oi-sel-btn")];
}

function onSelToolbarRoving(event) {
  if (event.target?.closest?.(".oi-sel-menu")) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const buttons = selToolbarButtons();
  const enabled = buttons.filter((btn) => !btn.disabled);
  if (!enabled.length) return;
  event.preventDefault();
  event.stopPropagation();
  const index = enabled.indexOf(document.activeElement);
  const delta = event.key === "ArrowRight" ? 1 : -1;
  const next = enabled[(index + delta + enabled.length) % enabled.length];
  buttons.forEach((btn) => {
    btn.tabIndex = btn === next ? 0 : -1;
  });
  next.focus();
}

function onSelToolbarClick(event) {
  const btn = event.target?.closest?.("[data-sel-action]");
  if (!btn || btn.disabled || btn.closest(".oi-sel-menu")) return;
  const fromKeyboard = event.detail === 0;
  if (btn.dataset.selAction === "more") {
    if (selMenuOpen()) closeSelMenu();
    else openSelMenu(fromKeyboard);
    return;
  }
  if (fromKeyboard) btn.focus({ preventScroll: true });
  invokeSelAction(btn.dataset.selAction);
}

function onSelMenuClick(event) {
  const btn = event.target?.closest?.("[data-sel-action]");
  if (!btn) return;
  event.stopPropagation();
  closeSelMenu();
  invokeSelAction(btn.dataset.selAction);
}

function enterSelMenuFromPointer(event) {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const key = event.key;
  const toEnd = key === "ArrowUp" || key === "End";
  const toStart = key === "ArrowDown" || key === "Home";
  if (!toEnd && !toStart) return false;
  if (!selMenuOpen()) return false;
  if (eventTargetIsField(event.target) || event.target?.isContentEditable) return false;
  if (event.target?.closest?.(".oi-sel-menu") || document.activeElement?.closest?.(".oi-sel-menu")) return false;
  const items = [...document.querySelectorAll(".oi-sel-menu [role='menuitem']")];
  if (!items.length) return false;
  event.preventDefault();
  items[toEnd ? items.length - 1 : 0].focus({ preventScroll: true });
  return true;
}

function onSelMenuKey(event) {
  const items = [...event.currentTarget.querySelectorAll("[role='menuitem']")];
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    event.preventDefault();
    event.stopPropagation();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    let next = 0;
    if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = index < 0 ? 0 : Math.min(items.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = index < 0 ? items.length - 1 : Math.max(0, index - 1);
    items[next]?.focus();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeSelMenu();
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    document.activeElement?.click();
  }
}

function invokeSelAction(id) {
  const action = selAction(id);
  if (!action || !selCtx) return;
  Promise.resolve(action.run(selCtx)).catch(() => {});
}

function selMenuOpen() {
  const menu = document.querySelector(".oi-sel-menu");
  return Boolean(menu && !menu.hidden);
}

function openSelMenu(focusItem = true) {
  const menu = document.querySelector(".oi-sel-menu");
  const more = document.querySelector(".oi-sel-toolbar [data-sel-action='more']");
  if (!menu || !more) return;
  menu.hidden = false;
  more.setAttribute("aria-expanded", "true");
  if (focusItem) menu.querySelector("[role='menuitem']")?.focus();
}

function closeSelMenu() {
  const menu = document.querySelector(".oi-sel-menu");
  if (!menu || menu.hidden) return false;
  menu.hidden = true;
  const more = document.querySelector(".oi-sel-toolbar [data-sel-action='more']");
  more?.setAttribute("aria-expanded", "false");
  if (document.activeElement?.closest?.(".oi-sel-menu")) more?.focus();
  return true;
}

function closeSelToolbar({ restore = false, dismissPeek = false } = {}) {
  const bar = document.querySelector(".oi-sel-toolbar");
  if (!bar || bar.hidden) return false;
  closeSelMenu();
  bar.hidden = true;
  bar.classList.remove("is-front");
  if (dismissPeek) dismissSeeSource();
  if (restore) restoreSelRange();
  return true;
}

function restoreSelRange() {
  const range = selCtx?.range;
  if (!range) return;
  selRestoring = true;
  try {
    const sel = window.getSelection?.();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* the live range died with a re-render */
  } finally {
    selRestoring = false;
  }
}

function selToolbarOpen() {
  const bar = document.querySelector(".oi-sel-toolbar");
  return Boolean(bar && !bar.hidden);
}

function noteSelToolbarScroll() {
  if (!selToolbarOpen()) return;
  const pane = translateScrollRoot();
  if (selScrollDismissed(selScrollBase, pane?.scrollTop || 0)) closeSelToolbar({ restore: false });
}

function raiseFloatingChrome(which) {
  const pop = $("sourcePop");
  const bar = document.querySelector(".oi-sel-toolbar");
  const sel = which === "sel";
  pop?.classList.toggle("is-front", !sel && sourcePopOpen());
  bar?.classList.toggle("is-front", sel);
}

function readSelContext() {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount < 1) return null;
  const range = sel.getRangeAt(0);
  const flow = readerFlowEl();
  const root = translateScrollRoot();
  if (!flow || !root) return null;
  const node = range.commonAncestorContainer;
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  if (!el || !root.contains(el) || el.closest?.(".oi-sel-toolbar, .oi-sel-menu")) return null;
  const blocks = [...flow.querySelectorAll(".rf-block")].map((block) => {
    const box = block.getBoundingClientRect();
    return {
      bid: block.dataset.bid || "",
      pairId: block.dataset.pairId || "",
      srcPage: Number(block.dataset.srcPage || block.dataset.page) || 0,
      box: { x: box.left, y: box.top, width: box.width, height: box.height },
      node: block
    };
  });
  const rawRects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
  const rects = rawRects.map((rect) => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }));
  let hits = blocksMeetingSelection(blocks, rects);
  if (!hits.length) {
    const host = el.closest?.(".rf-block");
    const bid = host?.dataset?.bid || "";
    if (bid) hits = blocks.filter((block) => block.bid === bid && block.node === host);
  }
  if (!hits.length) return null;
  const view = document.querySelector(".workspace")?.dataset.view || "zh";
  const text = selectedTranslationText(range, hits, view);
  if (!String(text || "").trim()) return null;
  const union = unionRect(rects.length ? rects : [clientBox(range.getBoundingClientRect())]);
  const rootBox = root.getBoundingClientRect();
  const rtl = getComputedStyle(root).direction === "rtl";
  const startEdge = rtl ? rootBox.right - root.clientLeft : rootBox.left + root.clientLeft;
  const anchor = {
    x: rtl ? startEdge - (union.x + union.width) : union.x - startEdge,
    y: union.y - (rootBox.top + root.clientTop),
    width: union.width,
    height: union.height
  };
  const bids = hits.map((hit) => hit.bid);
  return {
    bids,
    pairIds: hits.map((hit) => hit.pairId || ""),
    srcPage: hits[0].srcPage,
    text,
    range: range.cloneRange(),
    anchor,
    key: `${bids.join("|")}::${text}`
  };
}

function clientBox(rect) {
  return { x: rect?.left || 0, y: rect?.top || 0, width: rect?.width || 0, height: rect?.height || 0 };
}

function selectedTranslationText(range, hits, view) {
  if (view === "src") return range.toString();
  const parts = [];
  for (const hit of hits) {
    const zh = hit.node.querySelector(".rf-zh");
    const piece = zh ? textWithin(range, zh) : "";
    if (piece) parts.push(piece);
  }
  const joined = parts.join("").trim();
  return joined || range.toString();
}

function textWithin(range, node) {
  if (!node) return "";
  try {
    if (typeof range.intersectsNode === "function" && !range.intersectsNode(node)) return "";
  } catch {
    return "";
  }
  const sub = document.createRange();
  sub.selectNodeContents(node);
  if (range.compareBoundaryPoints(Range.END_TO_START, sub) >= 0) return "";
  if (range.compareBoundaryPoints(Range.START_TO_END, sub) <= 0) return "";
  const startAfter = range.compareBoundaryPoints(Range.START_TO_START, sub) > 0;
  const endBefore = range.compareBoundaryPoints(Range.END_TO_END, sub) < 0;
  const piece = document.createRange();
  try {
    piece.setStart(startAfter ? range.startContainer : sub.startContainer, startAfter ? range.startOffset : sub.startOffset);
    piece.setEnd(endBefore ? range.endContainer : sub.endContainer, endBefore ? range.endOffset : sub.endOffset);
    return piece.toString();
  } catch {
    return "";
  }
}

/* 看原文：原地瞄一眼，不改跟随，hidden 不弹出。跳到原页：把原文栏带到这段并恢复跟随。 */
function seeSourceForSelection(ctx) {
  const block = selStartBlock(ctx);
  if (!block?.dataset?.pairId) return;
  const pane = translateScrollRoot();
  const beforeTop = pane?.scrollTop;
  dismissSeeSource();
  const rects = decodeSrcRects(block.dataset.srcRects);
  peekPairId = block.dataset.pairId;
  if (rects[0]) scrollSourcePeek(rects[0]);
  if (pane && Number.isFinite(beforeTop)) pane.scrollTop = beforeTop;
  armJumpLock();
  paintPairChrome();
  const view = document.querySelector(".workspace")?.dataset.view || "zh";
  if (view === "bi") expandSrcFold(block, { highlight: true });
  else insertInlineSource(block, sourceTextOf(block));
  seeSourceKey = ctx?.key || "";
}

function jumpSourceForSelection(ctx) {
  const block = selStartBlock(ctx);
  if (!block?.dataset?.pairId) return;
  jumpTranslationToSource(block);
  // Paragraph click leaves follow off. Toolbar 跳到原页 and a live p turn it on.
  if (followState === "off") applyFollow({ type: "toggle" });
  else if (followState === "paused") applyFollow({ type: "resume" });
}

function selStartBlock(ctx) {
  const bid = ctx?.bids?.[0] || "";
  if (!bid) return null;
  return readerFlowEl()?.querySelector(`.rf-block[data-bid="${cssEscape(bid)}"]`) || null;
}

function scrollSourcePeek(rect) {
  const pane = pdfScrollRoot();
  const placed = rect ? rectInSource(rect) : null;
  if (!pane || !placed || !(pane.clientHeight > 1)) return false;
  const top = sourceFollowScroll({
    rectTop: placed.top,
    rectBottom: placed.bottom,
    scrollTop: pane.scrollTop,
    clientHeight: pane.clientHeight,
    scrollHeight: pane.scrollHeight
  });
  if (top == null) return false;
  takeDriver("click");
  pane.scrollTop = top;
  noteSourcePage(false);
  return true;
}

function sourceTextOf(block) {
  return block?.querySelector(".rf-src")?.textContent || "";
}

function insertInlineSource(block, text) {
  document.querySelectorAll(".oi-src-strip").forEach((el) => el.remove());
  const strip = document.createElement("div");
  strip.className = "oi-src-strip";
  strip.setAttribute("aria-live", "polite");
  const live = document.createElement("span");
  live.className = "sr-only";
  live.textContent = "已显示原文";
  const label = document.createElement("span");
  label.className = "oi-src-strip-k";
  label.textContent = "原文 ·";
  const body = document.createElement("span");
  body.className = "oi-src-strip-text";
  body.textContent = String(text || "");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "oi-src-strip-x";
  close.setAttribute("aria-label", "关闭原文");
  close.textContent = "×";
  close.addEventListener("click", () => dismissSeeSource());
  strip.append(live, label, body, close);
  block.after(strip);
}

function dismissSeeSource() {
  const strips = document.querySelectorAll(".oi-src-strip");
  const marks = document.querySelectorAll(".rf-src-fold-panel.is-see-source");
  const had = strips.length > 0 || marks.length > 0 || Boolean(peekPairId);
  strips.forEach((el) => el.remove());
  marks.forEach((el) => el.classList.remove("is-see-source"));
  seeSourceKey = "";
  if (peekPairId) {
    peekPairId = "";
    paintPairChrome();
  }
  return had;
}

async function copySelectionText(ctx) {
  const text = String(ctx?.text || "");
  if (!text) return;
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
  }
  if (!ok) return;
  showToast("已复制");
  closeSelToolbar({ restore: false });
}

function mountSrcFolds(slot) {
  if (!slot) return;
  slot.querySelectorAll(".rf-block").forEach((block) => {
    if (block.querySelector(":scope > .rf-src-fold")) return;
    const src = block.querySelector(":scope > .rf-src");
    if (!blockWantsSrcFold({ label: block.dataset.label || "", sourceText: src?.textContent || "" })) return;
    const fold = document.createElement("div");
    fold.className = "rf-src-fold";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rf-src-fold-toggle";
    const panel = document.createElement("div");
    panel.className = "rf-src-fold-panel";
    panel.append(src);
    fold.append(btn, panel);
    block.append(fold);
    setSrcFoldOpen(fold, srcFoldMemory.has(block.dataset.bid));
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = srcFoldMemory.toggle(block.dataset.bid);
      setSrcFoldOpen(fold, open);
    });
  });
}

function setSrcFoldOpen(fold, open) {
  if (!fold) return;
  fold.dataset.open = open ? "true" : "false";
  const btn = fold.querySelector(".rf-src-fold-toggle");
  if (btn) {
    btn.textContent = open ? "▾ 原文 · 收起（o）" : "▸ 原文";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (!open) fold.querySelector(".rf-src-fold-panel")?.classList.remove("is-see-source");
}

function expandSrcFold(block, { highlight = false } = {}) {
  const fold = block?.querySelector?.(":scope > .rf-src-fold");
  if (!fold) return;
  srcFoldMemory.expand(block.dataset.bid);
  setSrcFoldOpen(fold, true);
  fold.querySelector(".rf-src-fold-panel")?.classList.toggle("is-see-source", Boolean(highlight));
}

function toggleFocusedSrcFold(from) {
  const active = from?.nodeType === 1 ? from : document.activeElement;
  const flow = readerFlowEl();
  let block = active?.closest?.(".rf-block");
  if (!block) block = flow?.querySelector(".rf-block.is-pair-current") || anchorBlock(translateScrollRoot());
  const fold = block?.querySelector?.(":scope > .rf-src-fold");
  if (!fold || !block?.dataset?.bid) return;
  const open = srcFoldMemory.toggle(block.dataset.bid);
  setSrcFoldOpen(fold, open);
}

function onSourcePageButton() {
  if (sourcePopOpen()) {
    closeSourcePop(true);
    return;
  }
  const presented = presentSourceForJump($("sourceModeNarrow"));
  if (presented === "pop") {
    const page = Number($("pageCapsule")?.dataset.srcPage) || pageNum;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const node = readerFlowEl()?.querySelector(".is-pair-current[data-pair-id]") || anchorBlock(translateScrollRoot());
      if (node?.dataset?.pairId) jumpTranslationToSource(node);
      else if (page >= 1) {
        revealSourcePage(page);
        syncSourcePopChrome(page, false);
      }
    }));
    return;
  }
  jumpCurrentToSource();
}

function cycleF6(backward) {
  const workspace = document.querySelector(".workspace");
  const ids = f6RegionIds({
    mode: workspace?.dataset.sourceMode || "side",
    popOpen: sourcePopOpen(),
    side: workspace?.dataset.sourceSide === "end" ? "end" : "start",
    sideSlotOpen: sideSlotOpen()
  });
  const current = f6CurrentRegion(ids);
  const step = backward ? -1 : 1;
  const next = (current + step + ids.length) % ids.length;
  focusF6Region(ids[next]);
}

function f6CurrentRegion(ids) {
  const active = document.activeElement;
  const map = {
    toolbar: document.querySelector(".toolbar"),
    source: $("pdfPane"),
    translation: document.querySelector(".pane-translate"),
    popup: $("sourcePop"),
    sideSlot: document.querySelector("[data-side-slot]")
  };
  for (let i = 0; i < ids.length; i += 1) {
    const host = map[ids[i]];
    if (host && (host === active || host.contains(active))) return i;
  }
  return -1;
}

function focusF6Region(id) {
  const target = {
    toolbar: () => $("tocButton"),
    source: () => $("pages") || $("pdfPane"),
    translation: () => $("readerFlow"),
    popup: () => $("sourcePopClose") || $("sourcePop"),
    sideSlot: () => document.querySelector("[data-side-slot]")
  }[id]?.();
  if (!target) return;
  if (target.tabIndex < 0 && target.id !== "sourcePopClose") target.tabIndex = -1;
  target.focus();
}

function placeViewSegment(inSubbar) {
  const seg = $("viewSeg");
  const sub = $("tbSubbar");
  const anchor = $("viewSegAnchor");
  if (!seg || !sub || !anchor) return;
  if (inSubbar) {
    sub.append(seg);
    sub.hidden = false;
  } else {
    anchor.after(seg);
    sub.hidden = true;
  }
}

function applyToolbarBand() {
  const bar = document.querySelector(".toolbar");
  if (!bar) return;
  const chrome = readerToolbarChrome(window.innerWidth || 0);
  bar.dataset.band = chrome.band;
  const swap = $("swapPanes");
  if (swap) swap.hidden = !chrome.swapInMenu;
  for (const id of ["menuNotes", "menuAsk", "menuLibrary", "menuAa"]) {
    const el = $(id);
    if (el) el.hidden = !chrome.collapsedInMenu;
  }
  placeViewSegment(chrome.viewInSubbar);
  applySourceLayout(false);
  refreshDocStatus();
  scheduleToolbarSnap();
}

function translateMenuOpen() {
  const menu = $("translateMenu");
  return Boolean(menu && !menu.hidden);
}

function openTranslateMenu() {
  const menu = $("translateMenu");
  const button = $("translateMenuButton");
  if (!menu || !button) return;
  closeMoreMenu(false);
  closeSourceModeMenu(false);
  menu.hidden = false;
  button.setAttribute("aria-expanded", "true");
}

function closeTranslateMenu(focusButton) {
  const menu = $("translateMenu");
  if (!menu || menu.hidden) return false;
  menu.hidden = true;
  $("translateMenuButton")?.setAttribute("aria-expanded", "false");
  if (focusButton) $("translateMenuButton")?.focus();
  return true;
}

function moreMenuOpen() {
  const menu = $("moreMenu");
  return Boolean(menu && !menu.hidden);
}

function openMoreMenu() {
  const menu = $("moreMenu");
  const button = $("moreButton");
  if (!menu || !button) return;
  closeTranslateMenu(false);
  closeSourceModeMenu(false);
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
  const total = pdfDoc?.numPages || 0;
  const shown = page || measureVisible() || pageNum || 0;
  const n = Number(shown);
  const safe = !(total >= 1)
    ? 0
    : (Number.isFinite(n) && n >= 1 ? Math.min(total, Math.floor(n)) : 1);
  if (el) {
    if (!(total >= 1)) el.textContent = pageLabel(0, 0);
    else el.textContent = pageLabel(safe, total);
  }
  const rail = $("sourceRail");
  if (rail) {
    rail.textContent = safe >= 1 ? `原文 · 第 ${safe} 页` : "原文";
    rail.setAttribute("aria-label", safe >= 1 ? `展开原文，第 ${safe} 页` : "展开原文");
  }
  syncSourcePopChrome(safe);
}

function noteSourcePage() {
  if (!pdfDoc || !pageViews.length) return;
  const current = measureVisible();
  updateSourcePageLabel(current);
  scheduleVisibleRenders();
  syncFollowControls();
  updatePager();
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
  // A broken paper metric once produced a 33554432px box and a blank image.
  if (!(height > 0) || height > 16384) return null;
  if (width > 16384) return null;
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

function notePageState(page, patch) {
  const key = Number(page);
  if (!(key >= 1)) return;
  const prev = pageStates.get(key) || { state: "queued", hasLayout: false, k: 0, m: 0, noText: false };
  pageStates.set(key, { ...prev, ...patch });
}

function filledCount(results) {
  return (results || []).filter((item) => String(item?.translation || "").trim()).length;
}

function pageFlowState(page) {
  const stored = pageStates.get(page);
  const layout = getPageLayout(page);
  const hasBlocks = Boolean(layout && (showsBlockReadout(layout) || layout.blocks?.length));
  if (!stored) return { state: "queued", hasLayout: hasBlocks, k: 0, m: 0, noText: false };
  return { ...stored, hasLayout: Boolean(stored.hasLayout || hasBlocks) };
}

function pageTotals() {
  const t = Number(pdfDoc?.numPages) || 0;
  const rows = [];
  for (let n = 1; n <= t; n += 1) rows.push({ state: pageStates.get(n)?.state || "queued" });
  return { t, ...translatedPageTotal(rows) };
}

function refreshDocStatus() {
  const el = $("docStatus");
  if (!el) return;
  const { n, t, needsRetry } = pageTotals();
  const view = docStatusView({ n, t, needsRetry, phase: docPhase });
  el.dataset.state = view.state || "idle";
  const compact = document.querySelector(".toolbar")?.dataset.band !== "wide";
  const text = el.querySelector(".doc-text");
  if (text) text.textContent = compact && t > 0 ? `${n}/${t}` : view.text;
  const live = el.querySelector(".sr-only");
  if (live) live.textContent = view.text;
  const ring = el.querySelector(".val");
  if (ring) {
    const pct = t > 0 ? Math.max(0, Math.min(100, Math.round((n / t) * 100))) : 0;
    ring.setAttribute("stroke-dasharray", `${pct} 100`);
  }
}

function finishDocPhase({ aborted = false, error = false } = {}) {
  const { n, t, needsRetry } = pageTotals();
  if (aborted) docPhase = "stopped";
  else if (!error && t > 0 && n === t && needsRetry === 0) docPhase = "done";
  else docPhase = "idle";
  refreshDocStatus();
}

function clearSlotPainted(page) {
  const slot = readerFlowEl()?.querySelector(`:scope > .rf-page[data-page="${page}"]`);
  if (slot) delete slot.dataset.painted;
}

function noteLayoutReady(page) {
  if (skipLocked.has(page)) {
    notePageState(page, { state: "skipped", hasLayout: true });
    clearSlotPainted(page);
    return;
  }
  const row = pageStates.get(page);
  const terminal = row && ["running", "done", "partial", "failed", "skipped", "empty", "held"].includes(row.state);
  if (terminal) notePageState(page, { hasLayout: true });
  else notePageState(page, { state: "queued", hasLayout: true });
  clearSlotPainted(page);
}

function capsulePage() {
  const shown = Number($("pageCapsule")?.dataset.srcPage);
  return shown >= 1 ? shown : pageNum;
}

function captureFlowAnchor() {
  const pane = translateScrollRoot();
  const flow = readerFlowEl();
  if (!pane || !flow) return null;
  const paneTop = pane.getBoundingClientRect().top;
  const block = [...flow.querySelectorAll(".rf-block")].find((el) => el.getBoundingClientRect().bottom > paneTop + 1);
  if (!block) return null;
  return {
    top: block.getBoundingClientRect().top,
    id: block.dataset.blockId || "",
    pairId: block.dataset.pairId || "",
    srcPage: block.dataset.srcPage || ""
  };
}

function holdReadoutScroll(apply) {
  const held = syncOwner.owner;
  if (!held) takeDriver("pdf");
  try {
    apply();
  } finally {
    if (!held) releaseScrollDriver("pdf");
  }
}

function restoreFlowAnchor(anchor) {
  const pane = translateScrollRoot();
  const flow = readerFlowEl();
  if (!pane || !flow || !anchor) return;
  const esc = globalThis.CSS?.escape || ((value) => String(value).replace(/"/g, '\\"'));
  let node = null;
  if (anchor.id) node = flow.querySelector(`[data-block-id="${esc(anchor.id)}"]`);
  if (!node && anchor.pairId) node = flow.querySelector(`[data-pair-id="${esc(anchor.pairId)}"]`);
  if (!node && anchor.srcPage) node = flow.querySelector(`.rf-block[data-src-page="${esc(anchor.srcPage)}"]`);
  if (!node) return;
  const delta = node.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) > 0.5) holdReadoutScroll(() => { pane.scrollTop += delta; });
}

function pageStatusSpec(page, row) {
  if (row.state === "running") {
    const m = Number(row.m) || 0;
    return { kind: "running", text: psRunning(row.k || 0, m), bar: m > 0 };
  }
  if (row.state === "layout") return { kind: "layout", text: "正在读取本页…" };
  if (row.state === "queued") return { kind: "queued", text: "排队翻译" };
  if (row.state === "skipped") return { kind: "skipped", text: psSkippedCopy() };
  if (row.state === "empty") return { kind: "empty", text: row.noText ? psNoTextCopy() : psEmptyCopy() };
  if (row.state === "failed") return { kind: "failed", text: `第 ${page} 页翻译失败`, warn: true };
  if (row.state === "partial") return { kind: "partial", text: "有段落翻译失败", warn: true };
  return null;
}

function syncPageStatus(slot, page, row) {
  const spec = pageStatusSpec(page, row);
  let ps = slot.querySelector(":scope > .rf-ps");
  if (!spec) {
    ps?.remove();
    return null;
  }
  if (!ps) {
    ps = document.createElement("div");
    ps.className = "rf-ps";
    slot.insertBefore(ps, slot.firstChild);
  } else if (slot.firstChild !== ps) {
    slot.insertBefore(ps, slot.firstChild);
  }
  ps.dataset.kind = spec.kind;
  if (spec.warn) ps.dataset.tone = "warn";
  else delete ps.dataset.tone;
  let text = ps.querySelector(":scope > .rf-ps-text");
  if (!text) {
    text = document.createElement("span");
    text.className = "rf-ps-text";
    ps.append(text);
  }
  text.textContent = spec.text;
  let bar = ps.querySelector(":scope > .rf-ps-bar");
  if (spec.bar) {
    if (!bar) {
      bar = document.createElement("span");
      bar.className = "rf-ps-bar";
      bar.setAttribute("role", "progressbar");
      bar.append(document.createElement("i"));
      ps.append(bar);
    }
    const m = Math.max(0, Number(row.m) || 0);
    const k = Math.max(0, Number(row.k) || 0);
    bar.setAttribute("aria-label", `第 ${page} 页翻译进度`);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(m));
    bar.setAttribute("aria-valuenow", String(Math.min(k, m || k)));
    const fill = bar.querySelector("i");
    if (fill) fill.style.inlineSize = `${m > 0 ? (k / m) * 100 : 0}%`;
  } else {
    bar?.remove();
  }
  return ps;
}

function pageHasSettledReadout(page) {
  const cached = pageCache.get(docId, page);
  // An echo is done for the page, but it is still the source text. Opening the
  // body while the page is queued or running would paint that English as the translation.
  if (Array.isArray(cached) && cached.some((item) => landedText(
    item?.translation,
    item?.original || item?.text || item?.sourceText || ""
  ))) return true;
  return structureLanded(page);
}

/** Drop unsettled prose and source echoes so translation||text cannot paint library English. */
function settledOnlyReadout(layout) {
  const painted = layoutForReadout(layout);
  const blocks = (painted.blocks || []).filter((block) => {
    const label = block?.label;
    if (label === "formula" || label === "figure" || label === "table") return true;
    if (block?.skipTranslate === true || block?.translationStatus === "skipped") return false;
    return landedText(block?.translation, block?.text || block?.sourceText || "");
  });
  const settled = blocks.some((block) => landedText(block?.translation, block?.text || block?.sourceText || ""));
  return { ...painted, blocks: settled ? blocks : [], settled };
}

function revealQueuedSource() {
  return docPhase === "idle" || docPhase === "stopped" || docPhase === "done";
}

function paintPageSlot(page) {
  const row = pageFlowState(page);
  const slot = ensurePaper(page);
  if (!slot) return;
  slot.dataset.page = String(page);
  slot.dataset.srcPage = String(page);
  slot.dataset.state = row.state;
  if (row.state === "queued" && !row.hasLayout) {
    if (slot.childNodes.length) slot.replaceChildren();
    delete slot.dataset.painted;
    return;
  }
  if ((row.state === "done" || row.state === "partial") && !slotHasTranslation(slot)) {
    delete slot.dataset.painted;
  }
  const bareTerminal = (row.state === "skipped" || row.state === "empty") && !slot.querySelector(".rf-block");
  const stable = slot.dataset.painted === "1" && row.state !== "running" && row.state !== "layout" && !bareTerminal;
  if (stable) return;
  const ps = syncPageStatus(slot, page, row);
  [...slot.children].forEach((child) => {
    if (child !== ps) child.remove();
  });
  const layout = getPageLayout(page);
  const revealSource = revealQueuedSource();
  const showBlocks = Boolean(layout && showsBlockReadout(layout) && shouldPaintPageBody({
    state: row.state,
    hasSettled: pageHasSettledReadout(page),
    revealSource
  }));
  if (showBlocks) {
    const narrow = (row.state === "queued" || row.state === "running") && !revealSource;
    const readout = narrow ? settledOnlyReadout(layout) : layoutForReadout(layout);
    if (!narrow || readout.settled || structureLanded(page)) {
      appendFixtureReadout(slot, readout);
      if (viewerUnderTest()) notePaintSample(page, readout);
    }
  } else if (libraryArticle?.length && page === 1 && row.state !== "layout" && row.state !== "empty" && row.state !== "queued") {
    renderStoredArticle(libraryArticle);
  } else if (row.state === "done" || row.state === "partial") {
    const stored = blocksFromLibraryPairs(page, libraryEntry(page)?.pairs || pageCache.get(docId, page));
    if (stored.length) appendFixtureReadout(slot, { page, kind: "blocks", blocks: stored, textSource: "library" });
  }
  if ((row.state === "done" || row.state === "partial") && !slotHasTranslation(slot)) delete slot.dataset.painted;
}

function markTitleFailure() {
  const flow = readerFlowEl();
  if (!flow) return;
  const record = titleStructure;
  const failedPage = record?.failed && record.docId === docId ? String(record.page || "") : "";
  flow.querySelectorAll(":scope > .rf-page").forEach((slot) => {
    if (failedPage && slot.dataset.page === failedPage) slot.dataset.titleFailed = "1";
    else delete slot.dataset.titleFailed;
  });
}

function renderArticle() {
  const pane = translateScrollRoot();
  const flow = readerFlowEl();
  const anchor = captureFlowAnchor();
  const keptTop = pane ? pane.scrollTop : 0;
  const keepLeft = pane ? pane.scrollLeft : 0;
  const pin = flow && flow.offsetHeight > 0 ? flow.offsetHeight : 0;
  if (flow && pin) flow.style.minHeight = `${pin}px`;
  const formulaScrolls = captureFormulaScrolls(flow);
  applyViewMode();
  const total = pdfDoc?.numPages || 0;
  for (let n = 1; n <= total; n += 1) paintPageSlot(n);
  const hasContent = finalizeReaderFlow();
  syncReadoutEmpty(hasContent);
  if (flow) flow.style.minHeight = "";
  restoreFlowAnchor(anchor);
  if (viewerUnderTest() && globalThis.__oiForceScrollCollapse && pane) pane.scrollTop = 0;
  if (pane && keptTop > 0 && pane.scrollTop < 1 && pane.scrollHeight - pane.clientHeight >= keptTop - 1) {
    holdReadoutScroll(() => { pane.scrollTop = keptTop; });
    restoreFlowAnchor(anchor);
  }
  if (pane) pane.scrollLeft = keepLeft;
  restoreFormulaScrolls(readerFlowEl(), formulaScrolls);
  if (viewerUnderTest()) {
    const flowNow = readerFlowEl();
    globalThis.__oiDoneWithoutTranslation = flowNow
      ? [...flowNow.querySelectorAll(":scope > .rf-page")].filter((slot) => (
        slot.dataset.state === "done" && !slotHasTranslation(slot)
      )).map((slot) => slot.dataset.page || "")
      : [];
    publishViewerTestHooks();
  }
  const bare = demoteUnpaintedDonePages();
  if (bare) {
    const again = pdfDoc?.numPages || 0;
    for (let n = 1; n <= again; n += 1) paintPageSlot(n);
    finalizeReaderFlow();
  }
  markTitleFailure();
  settlePairChrome();
  updateTranslateControls();
  refreshDocStatus();
  noteAutoProgress();
}

function noteAutoProgress() {
  if (!viewerUnderTest()) return;
  const bucket = globalThis.__oiAuto;
  if (!bucket) return;
  const flow = readerFlowEl();
  if (!flow) return;
  const doc = $("docStatus")?.querySelector(".doc-text")?.textContent || "";
  const status = $("status")?.textContent || "";
  const pages = [...flow.querySelectorAll(":scope > .rf-page")].map((slot) => {
    const zh = [...slot.querySelectorAll(".rf-zh")].map((el) => el.textContent || "").join("");
    const src = [...slot.querySelectorAll(".rf-src")].map((el) => el.textContent || "").join("");
    const zhFold = zh.trim().replace(/\s+/g, " ");
    const srcFold = src.trim().replace(/\s+/g, " ");
    return {
      page: Number(slot.dataset.page) || 0,
      state: slot.dataset.state || "",
      zh: zhFold.slice(0, 80),
      echo: zhFold.length > 40 && srcFold.length > 40 && zhFold === srcFold
    };
  });
  const signature = `${doc}|${status}|${pages.map((item) => `${item.page}:${item.state}:${item.zh ? 1 : 0}:${item.echo ? 1 : 0}`).join(",")}`;
  const timeline = bucket.timeline || (bucket.timeline = []);
  if (timeline.length && timeline[timeline.length - 1].signature === signature) return;
  if (timeline.length >= 500) return;
  timeline.push({ doc, status, pages, signature });
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
    const shift = before.getBoundingClientRect().top - line;
    holdReadoutScroll(() => { pane.scrollTop += shift; });
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

function ensureRange(item) {
  const flow = readerFlowEl();
  let el = [...flow.querySelectorAll(":scope > .rf-q")].find((node) =>
    node.dataset.from === String(item.from) && node.dataset.to === String(item.to) && node.dataset.state === (item.state || "queued")
  );
  if (!el) {
    el = document.createElement("div");
    el.className = "rf-q";
    el.setAttribute("role", "status");
    const ring = document.createElement("span");
    ring.className = "rf-q-ring";
    ring.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "rf-q-text";
    el.append(ring, text);
  }
  el.dataset.from = String(item.from);
  el.dataset.to = String(item.to);
  el.dataset.state = item.state || "queued";
  const text = el.querySelector(".rf-q-text");
  if (text) text.textContent = translatePaused ? qPaused(item.from, item.to) : qQueued(item.from, item.to);
  return el;
}

function ensureBreak(item) {
  const flow = readerFlowEl();
  const key = String(item.page);
  let el = flow.querySelector(`:scope > .rf-pagebreak[data-src-page="${key}"]`);
  if (!el) el = makePageBreak(item.page);
  el.dataset.state = item.state || "";
  el.hidden = Boolean(item.hidden);
  return el;
}

function orderFlowChildren(nodes) {
  const flow = readerFlowEl();
  const keep = new Set(nodes.filter(Boolean));
  [...flow.children].forEach((child) => {
    if (!keep.has(child)) child.remove();
  });
  let ref = flow.firstChild;
  for (const node of nodes) {
    if (!node) continue;
    if (ref === node) {
      ref = node.nextSibling;
      continue;
    }
    flow.insertBefore(node, ref);
  }
}

function finalizeReaderFlow() {
  const flow = readerFlowEl();
  if (!flow) return false;
  const total = Number(pdfDoc?.numPages) || 0;
  const pages = new Map();
  for (let n = 1; n <= total; n += 1) {
    const row = pageFlowState(n);
    pages.set(n, { state: row.state, hasLayout: row.state === "queued" ? row.hasLayout : true });
  }
  const plan = planReaderFlow({ pageCount: total, pages });
  const nodes = [];
  for (const item of plan) {
    if (item.kind === "range") nodes.push(ensureRange(item));
    else if (item.kind === "break") nodes.push(ensureBreak(item));
    else if (item.kind === "slot") {
      const slot = ensurePaper(item.page);
      if (!slot) continue;
      slot.dataset.state = item.state || slot.dataset.state || "queued";
      slot.hidden = Boolean(item.hidden);
      nodes.push(slot);
    }
  }
  orderFlowChildren(nodes);
  flow.querySelectorAll(":scope > .rf-page").forEach((slot) => {
    if (slot.dataset.painted === "1") return;
    stampReaderPage(slot);
    stampFlowPairs(slot);
    mountSrcFolds(slot);
    refreshMatchedFormulas(slot);
    const row = pageFlowState(Number(slot.dataset.page));
    const collapsed = row.state === "queued" && !row.hasLayout;
    const hasBlocks = Boolean(slot.querySelector(".rf-block"));
    const waitingForSource = (row.state === "skipped" || row.state === "empty") && !hasBlocks;
    if (!waitingForSource && shouldStampPagePainted({
      state: row.state,
      collapsed,
      hasLandedBody: hasBlocks
    })) {
      slot.dataset.painted = "1";
    }
  });
  layoutCapsule();
  return Boolean(flow.querySelector(".rf-block, .rf-ps, .rf-q"));
}

function settlePairChrome() {
  if (jumpLock.locked) paintPairChrome();
  else refreshPairCurrent();
  const marked = readerFlowEl()?.querySelector(".rf-block.is-pair-current");
  if (currentPairId && marked?.dataset.pairId !== currentPairId) paintPairChrome();
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
  syncToolbarFromCapsule();
}

function syncToolbarFromCapsule() {
  if (!pdfDoc) return;
  const shown = Number($("pageCapsule")?.dataset.srcPage);
  if (!(shown >= 1) || shown === pageNum) return;
  pageNum = shown;
  updatePager();
}

function onPageCapsuleClick() {
  const page = Number($("pageCapsule")?.dataset.srcPage);
  if (!Number.isFinite(page) || page < 1) return;
  const presented = presentSourceForJump($("pageCapsule"));
  const run = () => revealCapsulePage(page);
  if (presented === "ready") run();
  else requestAnimationFrame(() => requestAnimationFrame(run));
}

function revealCapsulePage(page) {
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
  syncSourcePopChrome();
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
  if ($("mirrorHint")) $("mirrorHint").hidden = true;
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
  noteSelToolbarScroll();
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
  const node = readerFlowEl()?.querySelector(`.rf-block[data-src-page="${page}"]`)
    || readerFlowEl()?.querySelector(`.rf-page[data-page="${page}"] > .rf-ps`);
  return writeAnchorScroll(pane, node);
}

function runtimeSend(message) {
  const send = globalThis.chrome?.runtime?.sendMessage;
  if (typeof send !== "function") {
    return Promise.reject(new Error("runtime unavailable"));
  }
  return send(message);
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
  for (const [page, row] of pageStates) {
    if (row.state === "running" || row.state === "layout") {
      notePageState(page, { state: "queued", hasLayout: Boolean(row.hasLayout) });
      clearSlotPainted(page);
    }
  }
  docPhase = "stopped";
  setStatus(PDF_COPY.stopped);
  renderArticle();
  updateTranslateControls();
  resumePendingRetranslate();
}

function resumePendingRetranslate() {
  if (!forceRetranslatePending) return;
  if (!pdfDoc || pdfTranslateBusy(session) || forceReadoutHold) return;
  void forceRetranslateCurrentPage();
}

function revealTranslationPage(page) {
  const gen = navGen;
  const apply = () => {
    if (gen !== navGen) return false;
    const pane = translateScrollRoot();
    const flow = readerFlowEl();
    const node = flow?.querySelector(`.rf-block[data-src-page="${page}"]`)
      || flow?.querySelector(`.rf-page[data-page="${page}"] > .rf-ps`);
    if (!pane || !node) return false;
    const paneBox = pane.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    if (box.width < 1 && box.height < 1) return false;
    const bar = pane.dataset.capsuleMode === "bar" ? capsuleBarHeight() : 0;
    const line = paneBox.top + bar + (paneBox.height - bar) * 0.3;
    holdReadoutScroll(() => { pane.scrollTop += box.top - line; });
    updatePageCapsule();
    return true;
  };
  const moved = apply();
  requestAnimationFrame(() => { apply(); });
  return moved;
}

function extensionRuntimeReady() {
  return typeof globalThis.chrome?.runtime?.sendMessage === "function";
}

async function probeLocalService(baseUrl) {
  const root = String(baseUrl || "http://127.0.0.1:8765").replace(/\/$/, "");
  try {
    await fetch(root, { method: "GET", signal: AbortSignal.timeout(1200) });
    return true;
  } catch {
    return false;
  }
}

async function translatePreflight() {
  if (!extensionRuntimeReady()) return pdfTranslateFailureCopy({ reason: "runtime" });
  let settings = {};
  try {
    const res = await runtimeSend({ type: "OI_GET_SETTINGS" });
    settings = res?.settings || {};
    rememberTargetLang(settings);
  } catch (err) {
    return pdfTranslateFailureCopy({ error: String(err?.message || err) });
  }
  cachedPdfLayout = normalizePdfLayout(settings.pdfLayout);
  const providerId = settings.provider || "mymemory";
  const missing = missingRequiredField(getProvider(providerId), settings.providers?.[providerId] || {});
  const layoutMode = pdfEngineMode();
  let localServiceUp = true;
  if (layoutMode === "local-ocr") localServiceUp = await probeLocalService(cachedPdfLayout?.localBaseUrl);
  return pdfOpenTranslateBlocker({
    runtimeReady: true,
    missingField: missing?.label || "",
    layoutMode,
    localServiceUp
  });
}

async function readAutoTranslateEnabled() {
  if (!extensionRuntimeReady()) return true;
  try {
    const res = await runtimeSend({ type: "OI_GET_SETTINGS" });
    rememberTargetLang(res?.settings);
    return normalizePdfAutoTranslate(res?.settings?.pdfAutoTranslate);
  } catch {
    return true;
  }
}

function documentTranslateSuperseded() {
  if (!forceReadoutHold && !pdfTranslateBusy(session)) return false;
  if (forceReadoutHold) autoAfterForce = true;
  return true;
}

async function maybeAutoTranslateDocument() {
  if (!pdfDoc) return;
  if (documentTranslateSuperseded()) return;
  const adopting = docId;
  if (!(await readAutoTranslateEnabled())) {
    if (adopting === docId && docPhase === "opening") {
      docPhase = "idle";
      refreshDocStatus();
      renderArticle();
    }
    return;
  }
  if (adopting !== docId || !pdfDoc || documentTranslateSuperseded()) return;
  await startTranslate();
}

async function startTranslate() {
  if (pdfTranslateBusy(session) || forceReadoutHold) {
    if (forceReadoutHold) autoAfterForce = true;
    return;
  }
  const adopting = docId;
  const blocker = await translatePreflight();
  if (adopting !== docId) return;
  if (documentTranslateSuperseded()) return;
  if (blocker) {
    setStatus(blocker, true);
    if (docPhase === "opening" || docPhase === "running") docPhase = "idle";
    refreshDocStatus();
    renderArticle();
    updateTranslateControls();
    return;
  }
  docPhase = "running";
  refreshDocStatus();
  await translateWholeDocument();
}

async function resolveBatchSize() {
  const settingsRes = await runtimeSend({ type: "OI_GET_SETTINGS" });
  rememberTargetLang(settingsRes?.settings);
  return Math.max(1, Number(settingsRes?.settings?.batchSize) || 8);
}

function rememberTranslation(page, results) {
  const rawLayout = getPageLayout(page);
  const layout = cacheableLayout(rawLayout);
  const blocks = rawLayout?.blocks || [];
  const verified = pairsWithLiveFormulaSlots(
    pairsVerifiedForLibrary(results, blocks, savedPairSettings()),
    blocks
  );
  const skipOnly = isSkipOnlyPage(blocks);
  const existing = libraryDoc?.pages?.find((item) => item.page === page);
  if (!verified.length && !skipOnly) return Promise.resolve();
  if (!verified.length && existing && (existing.pairs?.length || existing.skipped)) return Promise.resolve();
  const keptPairs = pairsWithoutUnalignedSlots(existing?.pairs, blocks, savedPairSettings());
  const pairs = verified.length
    ? mergeLibraryPairs(keptPairs, verified, blocks, pdfTargetLang)
    : [];
  if (pairs.length) replaceLibraryPagePairs(libraryDoc, page, pairs);
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
      ...(layout?.layoutVersion ? { layoutVersion: layout.layoutVersion } : {}),
      sourceBase64,
      ...(skipped ? { skipped: true } : {})
    });
    librarySourceSent.add(hash);
    const savedPage = libraryDoc?.pages?.find((item) => item.page === page);
    if (savedPage && layout) {
      savedPage.layout = layout;
      if (layout.layoutVersion) savedPage.layoutVersion = layout.layoutVersion;
    } else if (skipped && libraryDoc && Array.isArray(libraryDoc.pages)) {
      libraryDoc.pages.push({ page, pairs: [], skipped: true, ...(layout ? { layout, layoutVersion: layout.layoutVersion } : {}) });
    }
  });
}

function rememberSkipHole(page, blocks) {
  if (!isSkipOnlyPage(blocks)) return;
  if (libraryDoc?.pages?.some((item) => item.page === page)) return;
  rememberTranslation(page, []).catch(() => {});
}

const COUNTED_PAGE_STATES = new Set(["done", "partial", "skipped", "empty", "held"]);

function countedPageState(state) {
  return COUNTED_PAGE_STATES.has(state || "");
}

let knownLayoutVersion = "";

async function layoutVersionNow() {
  try {
    const version = await currentLayoutVersion();
    if (version) knownLayoutVersion = version;
    return knownLayoutVersion;
  } catch {
    return knownLayoutVersion;
  }
}

function layoutFromStored(page, stored) {
  const fallback = layoutFallbackOf(stored);
  return {
    kind: "blocks",
    protocol: stored.protocol || PROTOCOL,
    page: Number(page),
    textSource: stored.textSource || "text-layer",
    sourceAudit: stored.sourceAudit || null,
    ...(stored.layoutVersion ? { layoutVersion: String(stored.layoutVersion) } : {}),
    ...(fallback ? { fallback } : {}),
    blocks: stored.blocks,
    itemCount: Number(stored.itemCount) || stored.blocks.length
  };
}

/** Paint the library's current blocks before any pair-only or text-layer stand-in. */
function installDisplayableLibraryLayouts(version = knownLayoutVersion) {
  if (!version || !libraryDoc?.pages?.length) return false;
  let changed = false;
  for (const entry of libraryDoc.pages) {
    const page = Number(entry?.page);
    if (!(page >= 1)) continue;
    const stored = storedLayoutDisplayable(entry, version);
    if (!stored?.blocks?.length) continue;
    if (getPageLayout(page)?.blocks?.length) continue;
    const laid = layoutFromStored(page, stored);
    setPageLayout(page, laid);
    armStoredVisualCrops(page, laid);
    if (isSkipOnlyPage(stored.blocks)) skipLocked.add(page);
    changed = true;
  }
  return changed;
}

/** Write a freshly built layout back so the next open does not recompute it. */
function libraryLayoutNeedsWrite(page) {
  const raw = getPageLayout(page);
  const version = String(raw?.layoutVersion || "");
  if (!version || !raw?.blocks?.length) return false;
  const entry = libraryEntry(page);
  if (!entry) return false;
  const storedBlocks = entry.layout?.blocks;
  const hasLayout = Array.isArray(storedBlocks) && storedBlocks.length > 0;
  const hasVersion = Boolean(entry.layoutVersion || entry.layout?.layoutVersion);
  if (!hasLayout && !hasVersion) return false;
  return !storedLayoutCurrent(entry, version);
}

function persistDisplayedLayout(page) {
  if (!libraryLayoutNeedsWrite(page)) return Promise.resolve();
  return persistPageLayout(page);
}
function persistPageLayout(page) {
  const raw = getPageLayout(page);
  const version = String(raw?.layoutVersion || "");
  if (!version || !raw?.blocks?.length) return Promise.resolve();
  const layout = cacheableLayout(raw);
  const entry = libraryEntry(page);
  const pairs = Array.isArray(entry?.pairs) ? entry.pairs : [];
  const skipped = Boolean(entry?.skipped) || (isSkipOnlyPage(raw.blocks) && !pairs.length);
  if (entry) {
    entry.layout = layout;
    entry.layoutVersion = version;
    if (skipped) entry.skipped = true;
  } else if (libraryDoc && Array.isArray(libraryDoc.pages)) {
    libraryDoc.pages.push({ page, pairs, layout, layoutVersion: version, ...(skipped ? { skipped: true } : {}) });
  }
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
      pairs,
      layout,
      layoutVersion: version,
      ...(skipped ? { skipped: true } : {})
    });
  });
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
      ...(layout?.layoutVersion ? { layoutVersion: layout.layoutVersion } : {}),
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
  const outside = new Set(blocksOutsideStructure(layout?.blocks || [], record.source || record.structure).map((block) => block.id));
  const slotText = new Set(structureTranslateSlots(record.source).map((slot) => String(slot.text || "").replace(/\s+/g, " ").trim()));
  return (units || []).filter((unit) => {
    if (!unit?.id || outside.has(unit.id)) return true;
    const text = String(unit.text || unit.original || "").replace(/\s+/g, " ").trim();
    // The structure slot already translates an exact match. A block that only
    // sits inside a longer slot (abstract paragraph, footnote) is stored on its own.
    return Boolean(text) && !slotText.has(text);
  });
}

async function translateTitleStructure(work, gen, translatingDoc, batchSize, options = {}) {
  const record = titleStructure;
  if (!record || record.status !== "ok" || record.docId !== translatingDoc) return;
  if (options.page != null && Number(options.page) !== Number(record.page)) return;
  if (record.slotsDone && !record.failed) return;
  const retryFailed = record.failed === true;
  const slots = structureTranslateSlots(record.source);
  if (!slots.length) {
    record.translated = true;
    record.failed = false;
    record.slotsDone = true;
    return;
  }
  await runTitleStructureBatch(record, async () => {
    const outcome = await translatePageBlocks(slots.map((item) => ({
      text: item.text,
      original: item.text,
      role: "paragraph"
    })), {
      send: runtimeSend,
      session: work,
      batchSize,
      preserveSession: true,
      bypassCache: options.bypassCache === true || retryFailed,
      onBatchResult({ results: next }) {
        if (!isCurrentWork(work, gen, translatingDoc)) return;
        record.structure = applyStructureTranslations(record.source, slots, next.map((row) => row.translation));
        renderArticle();
      }
    });
    if (!isCurrentWork(work, gen, translatingDoc)) return outcome;
    const results = outcome?.results || [];
    record.structure = applyStructureTranslations(
      record.source,
      slots,
      results.map((row) => row.translation)
    );
    renderArticle();
    return outcome;
  });
  if (!isCurrentWork(work, gen, translatingDoc)) {
    record.slotsDone = false;
    return;
  }
  const rows = structureTranslationRows(record.source, record.structure);
  const landed = rows.some((row) => settledText(row.translation, row.original || row.text || ""));
  if (record.failed || !landed) {
    record.slotsDone = false;
    record.failed = true;
  } else {
    record.slotsDone = true;
    record.failed = false;
  }
}

function structureLanded(page) {
  const record = titleStructure;
  if (!record?.translated || record.failed || record.docId !== docId || record.page !== page) return false;
  return structureTranslationRows(record.source, record.structure).some((row) => (
    settledText(row.translation, row.original || row.text || "")
  ));
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
      const merged = applySavedPairs(pageOriginals, prepared.pairs, savedPairSettings());
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
  if (libraryArticle || pageHasTranslation(pageCache.get(docId, pageNum), pdfTargetLang)) {
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
      setStatus(pdfTranslateFailureCopy({ reason: "runtime" }), true);
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
  else if (!results.some((item) => item.translation) && !structureLanded(targetPage)) {
    setStatus(pdfTranslateFailureCopy({ error: "没有返回译文" }), true);
  } else setStatus(PDF_COPY.done);
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

function pageMarkedSkip(entry, blocks) {
  return Boolean(entry?.skipped) || isSkipOnlyPage(blocks) || isSkipOnlyPage(entry?.layout?.blocks);
}

/** Previous layout cache. The live key stays source-v3; this only recognizes an old skip. */
function legacyLayoutCacheKey(args) {
  return layoutCacheKey(args).replace(/:source-v3$/, ":source-v2");
}

function installKnownSkipLayout(page, stored) {
  const blocks = stored?.blocks;
  if (!isSkipOnlyPage(blocks)) return false;
  skipLocked.add(page);
  if (isSkipOnlyPage(getPageLayout(page)?.blocks)) return false;
  const laid = {
    kind: "blocks",
    protocol: stored.protocol || PROTOCOL,
    page: Number(page),
    textSource: stored.textSource || "text-layer",
    sourceAudit: stored.sourceAudit || null,
    blocks,
    itemCount: Number(stored.itemCount) || blocks.length
  };
  setPageLayout(page, laid);
  armStoredVisualCrops(page, laid);
  return true;
}

async function readStoredLayouts(keys) {
  try {
    if (!keys?.length || typeof globalThis.chrome?.storage?.local?.get !== "function") return {};
    const bag = await globalThis.chrome.storage.local.get(keys);
    return bag && typeof bag === "object" ? bag : {};
  } catch {
    return {};
  }
}

function seedLibraryProgress() {
  const pages = libraryDoc?.pages || [];
  if (!pages.length || !pdfDoc) return false;
  const installed = installDisplayableLibraryLayouts();
  let changed = installed;
  for (const entry of pages) {
    const page = Number(entry?.page);
    if (!(page >= 1) || page > pdfDoc.numPages) continue;
    const prior = pageStates.get(page);
    if (skipLocked.has(page) && prior?.state === "skipped") continue;
    if (prior?.hasLayout && prior.state && prior.state !== "layout" && prior.state !== "queued") continue;
    const blocks = getPageLayout(page)?.blocks || null;
    const skipped = pageMarkedSkip(entry, blocks);
    if (isSkipOnlyPage(entry?.layout?.blocks)) installKnownSkipLayout(page, entry.layout);
    const state = libraryPageRunState({
      pairs: entry?.pairs,
      cached: pageCache.get(docId, page),
      targetLang: pdfTargetLang,
      provider: pdfProvider,
      skipped,
      blocks: getPageLayout(page)?.blocks || blocks,
      empty: Array.isArray(blocks)
        && !translatableBlocks(blocks).length
        && !isTitlePageCandidate(page, pageTextForStructure(blocks))
    });
    if (state === "queued") continue;
    if (state === "skipped") skipLocked.add(page);
    const hasLayout = Boolean((getPageLayout(page)?.blocks || blocks)?.length);
    if (prior?.state === state && Boolean(prior?.hasLayout) === hasLayout) continue;
    notePageState(page, { state, hasLayout });
    changed = true;
  }
  if (changed) refreshDocStatus();
  return changed;
}

/**
 * Count skip-only pages before any new layout request.
 * The old source-v2 cache and a library skip flag are enough: the page keeps
 * its original blocks and the skip label, and the sidecar runs only after
 * pages that still need translation have taken the layout slots.
 */
async function seedLegacySkipPages() {
  if (legacySkipSeeded || !pdfDoc) return false;
  const stamp = docId;
  await loadPdfLayout();
  if (stamp !== docId) return false;
  const hash = await pdfByteHash();
  const mode = pdfEngineMode();
  const total = pdfDoc.numPages;
  const keys = [];
  for (let page = 1; page <= total; page += 1) {
    if (hash && hash !== "nohash") keys.push(legacyLayoutCacheKey({ hash, page, mode }));
  }
  const bag = await readStoredLayouts(keys);
  if (stamp !== docId) return false;
  legacySkipSeeded = true;
  let changed = false;
  for (let page = 1; page <= total; page += 1) {
    if (stamp !== docId) return changed;
    const entry = libraryEntry(page);
    const cached = hash && hash !== "nohash" ? bag[legacyLayoutCacheKey({ hash, page, mode })] : null;
    const marked = pageMarkedSkip(entry, cached?.blocks) || skipLocked.has(page);
    if (!marked) continue;
    if (isSkipOnlyPage(cached?.blocks)) installKnownSkipLayout(page, cached);
    else if (isSkipOnlyPage(entry?.layout?.blocks)) installKnownSkipLayout(page, entry.layout);
    skipLocked.add(page);
    if (!isSkipOnlyPage(getPageLayout(page)?.blocks)) {
      try {
        await ingestSkippedSourceLayout(page, () => stamp !== docId);
      } catch {
        /* the skip still counts; reconcile can fill the blocks later */
      }
    }
    if (stamp !== docId) return changed;
    const hasLayout = Boolean(getPageLayout(page)?.blocks?.length);
    const prior = pageStates.get(page);
    if (prior?.state === "skipped" && Boolean(prior?.hasLayout) === hasLayout) continue;
    notePageState(page, { state: "skipped", hasLayout });
    changed = true;
  }
  if (changed) refreshDocStatus();
  return changed;
}

/** New layout may replace skip blocks. It must not take the page out of the done count. */
async function reconcileLockedSkipLayouts(isStale) {
  const pages = [...skipLocked].sort((a, b) => a - b);
  for (const page of pages) {
    if (isStale()) return;
    const previous = getPageLayout(page);
    let laid = null;
    try {
      laid = await ingestPageLayout(page, isStale);
    } catch {
      laid = null;
    }
    if (isStale()) return;
    if (!(laid && isSkipOnlyPage(laid.blocks)) && previous) setPageLayout(page, previous);
    notePageState(page, { state: "skipped", hasLayout: Boolean(getPageLayout(page)?.blocks?.length) });
    clearSlotPainted(page);
    renderArticle();
  }
}

async function adoptLibraryPages(options = {}) {
  const onlyPage = Number(options.onlyPage) || 0;
  const stamp = docId;
  const listed = (libraryDoc?.pages || []).map((item) => Number(item?.page)).filter((n) => n >= 1);
  const lastListed = listed.length ? Math.max(...listed) : 0;
  const total = Math.max(Number(pdfDoc?.numPages) || 0, ...listed, 0);
  const start = onlyPage >= 1 ? onlyPage : 1;
  const end = onlyPage >= 1 ? onlyPage : total;
  let hole = false;
  const publish = () => {
    if (stamp === docId) renderArticle();
  };
  const noteLibraryGap = (page, blocks, entry) => {
    const live = translatableBlocks(blocks || []).length;
    const pairCount = Array.isArray(entry?.pairs) ? entry.pairs.length : 0;
    if (!viewerUnderTest() || !entry || pairCount >= live) return;
    const gap = globalThis.__oiLibraryGap || [];
    gap.push({ page, pairs: pairCount, live });
    globalThis.__oiLibraryGap = gap;
  };
  if (seedLibraryProgress() && stamp === docId) renderArticle();
  if (await seedLegacySkipPages() && stamp === docId) renderArticle();
  for (let page = start; page <= end; page += 1) {
    if (stamp !== docId) return true;
    const entry = libraryEntry(page);
    let layout = getPageLayout(page);
    let blocks = layout?.blocks || null;
    const cached = pageCache.get(docId, page);
    const prior = pageStates.get(page);
    let skipped = pageMarkedSkip(entry, blocks) || skipLocked.has(page);
    if (skipped) {
      // Already done. Do not take a layout slot ahead of pages that still need translation.
      skipLocked.add(page);
      notePageState(page, { state: "skipped", hasLayout: Boolean(blocks?.length) });
      clearSlotPainted(page);
      publish();
      continue;
    }
    if (!layout) {
      try {
        layout = await ingestPageLayout(page, () => stamp !== docId);
      } catch {
        layout = null;
      }
      if (stamp !== docId) return true;
      blocks = layout?.blocks || null;
      skipped = pageMarkedSkip(entry, blocks) || skipLocked.has(page);
    }
    if (!skipped && !Array.isArray(blocks)) {
      hole = true;
      notePageState(page, { state: "queued", hasLayout: false });
      clearSlotPainted(page);
      publish();
      if (!entry && page >= lastListed) break;
      continue;
    }
    const state = libraryPageRunState({
      pairs: entry?.pairs,
      cached,
      targetLang: pdfTargetLang,
      provider: pdfProvider,
      skipped,
      blocks,
      empty: Array.isArray(blocks)
        && !translatableBlocks(blocks).length
        && !isTitlePageCandidate(page, pageTextForStructure(blocks))
    });
    if (state === "queued") {
      if (entry?.skipped || isSkipOnlyPage(blocks)) {
        notePageState(page, { state: "skipped", hasLayout: Boolean(blocks?.length) });
        clearSlotPainted(page);
        publish();
        continue;
      }
      // A page that already counted stays counted while changed blocks are filled.
      if (countedPageState(prior?.state)) {
        noteLibraryGap(page, blocks, entry);
        notePageState(page, { state: "partial", hasLayout: Boolean(blocks?.length) });
        clearSlotPainted(page);
        publish();
        hole = true;
        if (!entry && page >= lastListed) break;
        continue;
      }
      noteLibraryGap(page, blocks, entry);
      if (prior?.state === "done" || prior?.state === "partial") pageCache.clearPage(docId, page);
      else if (cached && !libraryCoversLiveBlocks(cached, blocks, pdfTargetLang, pdfProvider)) pageCache.clearPage(docId, page);
      notePageState(page, { state: "queued", hasLayout: Boolean(blocks?.length) });
      clearSlotPainted(page);
      publish();
      hole = true;
      if (!entry && page >= lastListed) break;
      continue;
    }
    if (state === "done" || state === "partial") {
      const units = unitsForLayout(layout || { kind: "blocks", blocks: blocks || [], page });
      const filled = units.length
        ? applySavedPairs(units, entry?.pairs || cached || [], savedPairSettings())
        : blocksFromLibraryPairs(page, entry?.pairs || cached);
      const covers = !Array.isArray(blocks) || libraryCoversLiveBlocks(entry?.pairs || cached, blocks, pdfTargetLang, pdfProvider);
      if (state === "done" && (!filled.length || !covers)) {
        if (countedPageState(prior?.state)) {
          noteLibraryGap(page, blocks, entry);
          if (filled.length) pageCache.set(docId, page, cacheableReuse(filled));
          notePageState(page, { state: "partial", hasLayout: Boolean(blocks?.length) });
          clearSlotPainted(page);
          publish();
          hole = true;
          if (!entry && page >= lastListed) break;
          continue;
        }
        hole = true;
        notePageState(page, { state: "queued", hasLayout: Boolean(blocks?.length) });
        clearSlotPainted(page);
        publish();
        if (!entry && page >= lastListed) break;
        continue;
      }
      if (filled.length) pageCache.set(docId, page, cacheableReuse(filled));
      notePageState(page, { state, hasLayout: true });
      clearSlotPainted(page);
      publish();
      if (state === "partial") {
        noteLibraryGap(page, blocks, entry);
        hole = true;
      }
      continue;
    }
    const noText = state === "empty" && !blocks?.length && !(Number(layout?.itemCount) > 0);
    notePageState(page, { state, hasLayout: true, noText });
    clearSlotPainted(page);
    publish();
  }
  return hole;
}

function demoteUnpaintedDonePages() {
  let hole = false;
  for (const [page, row] of pageStates) {
    if (row.state !== "done") continue;
    if (libraryEntry(page)?.skipped || isSkipOnlyPage(getPageLayout(page)?.blocks)) {
      notePageState(page, { state: "skipped", hasLayout: Boolean(getPageLayout(page)?.blocks?.length) });
      clearSlotPainted(page);
      continue;
    }
    const slot = readerFlowEl()?.querySelector(`:scope > .rf-page[data-page="${page}"]`);
    if (!slot || slotHasTranslation(slot)) continue;
    pageCache.clearPage(docId, page);
    notePageState(page, { state: "queued", hasLayout: false });
    clearSlotPainted(page);
    hole = true;
  }
  return hole;
}

async function translateWholeDocument() {
  if (!pdfDoc || documentTranslateSuperseded()) return;
  translatePaused = false;
  try {
    const saved = await savedTranslationFor(pageNum);
    if (documentTranslateSuperseded()) return;
    if ((saved?.readout || libraryArticle) && !libraryDoc?.pages?.length) {
      notePageState(1, { state: "done", hasLayout: true });
      clearSlotPainted(1);
      if (libraryArticle?.length && !pageHasTranslation(pageCache.get(docId, 1), pdfTargetLang)) {
        const text = libraryArticle.map((block) => block.text || "").filter(Boolean).join("\n");
        if (landedText(text, "")) pageCache.set(docId, 1, [{ original: "", translation: text, role: "paragraph" }]);
      }
    }
    if (libraryDoc?.pages?.length || libraryArticle) {
      const blocksByPage = {};
      for (const entry of libraryDoc?.pages || []) {
        const layout = getPageLayout(entry.page);
        if (layout?.blocks) blocksByPage[entry.page] = layout.blocks;
      }
      const currentBlocks = getPageLayout(pageNum)?.blocks || null;
      if (currentBlocks) blocksByPage[pageNum] = currentBlocks;
      if (libraryDoc?.pages?.length) {
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
      }
    }
  } catch {
    noteLibraryUnavailable();
  }
  if (documentTranslateSuperseded()) return;
  const gen = restoreGen;
  const translatingDoc = docId;
  const total = pdfDoc.numPages;
  const libraryPass = Boolean(libraryDoc?.pages?.length || libraryArticle);
  const work = beginViewerSession();
  updateTranslateControls();
  if (!libraryPass && !$("status").classList.contains("warn")) setStatus(progressDocumentStatus(1, total));
  renderArticle();
  let batchSize = 8;
  try {
    batchSize = await resolveBatchSize();
  } catch (err) {
    if (!isCurrentWork(work, gen, translatingDoc)) return;
    work.running = false;
    translatingPage = 0;
    if (String(err?.message || err) === "runtime unavailable") {
      setStatus(pdfTranslateFailureCopy({ reason: "runtime" }), true);
      finishDocPhase({ error: true });
      renderArticle();
      updateTranslateControls();
      return;
    }
  }
  if (work.aborted || !isCurrentWork(work, gen, translatingDoc)) {
    if (isCurrentWork(work, gen, translatingDoc)) {
      finishDocPhase({ aborted: work.aborted });
      updateTranslateControls();
    }
    return;
  }
  const saveTasks = [];
  const sentSource = new Map();
  const pageJob = {
    session: work,
    cache: pageCache,
    docId: translatingDoc,
    numPages: total,
    batchSize,
    targetLang: pdfTargetLang,
    send: runtimeSend,
    getPageOriginals: async (page) => {
      const units = await originalsForPage(page, gen, translatingDoc, work, batchSize);
      // One open, one request per submitted text. A later layout pass skips a
      // block already sent with this source and display, and still sends a
      // display that changed when formula slots moved.
      return claimTranslationUnits(units, sentSource);
    },
    pageSkipReason: (page) => {
      if (titleStructureFailed(page)) return "empty";
      const cached = pageCache.get(translatingDoc, page);
      // getPageOriginals already returned nothing to send. A settled body or a
      // landed title is done; stale failed rows must not turn that into an empty page.
      if (pageTranslationComplete(cached, pdfTargetLang) ||
          pageHasTranslation(cached, pdfTargetLang) ||
          structureLanded(page)) return "cached";
      return isSkipOnlyPage(getPageLayout(page)?.blocks) ? "skip-only" : "empty";
    },
    onPageSkip({ page, reason }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      if (reason !== "cached" && titleStructureFailed(page)) {
        const merged = withStructureRows(getPageLayout(page), []);
        notePageState(page, {
          state: pageRunState(merged, { expected: Number(pageStates.get(page)?.m) || 0, targetLang: pdfTargetLang }),
          hasLayout: true
        });
        clearSlotPainted(page);
        refreshDocStatus();
        renderArticle();
        return;
      }
      if (reason === "cached") {
        const prior = pageStates.get(page);
        const keepSkip = prior?.state === "skipped" || prior?.state === "held"
          || skipLocked.has(page)
          || libraryEntry(page)?.skipped
          || isSkipOnlyPage(getPageLayout(page)?.blocks)
          || isSkipOnlyPage(libraryEntry(page)?.layout?.blocks);
        if (keepSkip) {
          notePageState(page, {
            state: "skipped",
            hasLayout: Boolean(getPageLayout(page)?.blocks?.length) || Boolean(prior?.hasLayout)
          });
        } else notePageState(page, { state: "done", hasLayout: true });
      }
      else if (reason === "skip-only") {
        notePageState(page, { state: "skipped", hasLayout: true });
        saveTasks.push(rememberTranslation(page, []).then(() => null, (error) => error));
      }
      else {
        const layout = getPageLayout(page);
        const blocks = layout?.blocks || [];
        if (skipLocked.has(page) || libraryEntry(page)?.skipped || isSkipOnlyPage(blocks) || isSkipOnlyPage(libraryEntry(page)?.layout?.blocks)) {
          skipLocked.add(page);
          notePageState(page, { state: "skipped", hasLayout: blocks.length > 0 });
        } else {
          const noText = !blocks.length && !(Number(layout?.itemCount) > 0);
          notePageState(page, { state: "empty", hasLayout: Boolean(layout), noText });
        }
      }
      clearSlotPainted(page);
      refreshDocStatus();
      renderArticle();
    },
    onPageStart({ page, total: pageTotal }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      if (skipLocked.has(page)) {
        notePageState(page, { state: "skipped", hasLayout: Boolean(getPageLayout(page)?.blocks?.length) });
        clearSlotPainted(page);
        refreshDocStatus();
        renderArticle();
        return;
      }
      translatingPage = page;
      const prev = pageStates.get(page);
      const hold = countedPageState(prev?.state);
      notePageState(page, {
        state: hold ? "partial" : "running",
        hasLayout: Boolean(prev?.hasLayout) || Boolean(getPageLayout(page)?.blocks?.length),
        k: hold ? (prev?.k || 0) : 0,
        m: prev?.m || 0
      });
      clearSlotPainted(page);
      docPhase = "running";
      if (!$("status").classList.contains("warn") && !$("status").classList.contains("error")) {
        setStatus(progressDocumentStatus(page, pageTotal));
      }
      refreshDocStatus();
      renderArticle();
    },
    onBatchStart({ total: blockTotal }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      const page = translatingPage;
      const prev = pageStates.get(page);
      const hold = prev?.state === "partial";
      notePageState(page, {
        state: hold ? "partial" : "running",
        m: Math.max(blockTotal, prev?.m || 0),
        k: prev?.k || 0
      });
      clearSlotPainted(page);
      renderArticle();
    },
    onPageResult({ page, results, res }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      const layout = getPageLayout(page);
      const merged = pageResultsFromTranslation(layout, results);
      pageCache.set(translatingDoc, page, merged);
      if (page === pageNum) pageResults = merged;
      const k = Math.max(pageStates.get(page)?.k || 0, filledCount(merged));
      if (res?.ok === false || res?.error) {
        notePageState(page, {
          state: pageRunState(merged, { expected: Number(pageStates.get(page)?.m) || 0, targetLang: pdfTargetLang }),
          hasLayout: true,
          k
        });
      } else {
        const prev = pageStates.get(page);
        notePageState(page, {
          state: prev?.state === "partial" ? "partial" : "running",
          hasLayout: true,
          k
        });
      }
      clearSlotPainted(page);
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
      const expected = Number(pageStates.get(page)?.m) || merged.length;
      const k = (merged || []).filter((item) => settledText(item?.translation, item?.original || item?.text || "")).length;
      const state = pageRunState(merged, { expected, targetLang: pdfTargetLang });
      notePageState(page, { state, hasLayout: true, k });
      const slot = readerFlowEl()?.querySelector(`:scope > .rf-page[data-page="${page}"]`);
      if (slot && slotHasTranslation(slot)) {
        slot.querySelector(":scope > .rf-ps")?.remove();
        slot.dataset.painted = "1";
      } else clearSlotPainted(page);
      refreshDocStatus();
      renderArticle();
      if (state !== "failed") saveTasks.push(rememberTranslation(page, merged).then(() => null, (error) => error));
    },
    onPageError({ page, results }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      const layout = getPageLayout(page);
      const base = layout?.kind === "blocks" ? results : mergeReadoutTranslations(layout?.blocks || results, results);
      const merged = withStructureRows(layout, base);
      pageCache.set(translatingDoc, page, merged);
      if (page === pageNum) pageResults = merged;
      const expected = Number(pageStates.get(page)?.m) || 0;
      const k = (merged || []).filter((item) => settledText(item?.translation, item?.original || item?.text || "")).length;
      notePageState(page, { state: pageRunState(merged, { expected, targetLang: pdfTargetLang }), hasLayout: true, k });
      clearSlotPainted(page);
      refreshDocStatus();
      renderArticle();
    }
  };
  // documentTranslateSuperseded() is true whenever this session is running.
  // It gates a second job, and must not stop the job that is already adopting.
  const prepareLibraryPage = libraryPass ? async (page) => {
    if (work.aborted || !isCurrentWork(work, gen, translatingDoc)) return "stop";
    await adoptLibraryPages({ onlyPage: page });
    if (work.aborted || !isCurrentWork(work, gen, translatingDoc)) return "stop";
    const state = pageStates.get(page)?.state || "queued";
    if (state === "done" || state === "skipped" || state === "empty" || state === "held") return "skip";
    return "translate";
  } : undefined;
  let translatedDoc = await translateDocumentPages({
    ...pageJob,
    preserveSession: libraryPass,
    preparePage: prepareLibraryPage
  });
  if (libraryPass && isCurrentWork(work, gen, translatingDoc) && !translatedDoc.aborted && !work.aborted) {
    renderArticle();
    if (!translatedDoc.paused) {
      let stillQueued = false;
      for (let page = 1; page <= total; page += 1) {
        if ((pageStates.get(page)?.state || "") === "queued") stillQueued = true;
      }
      if (stillQueued) {
        const again = await translateDocumentPages({
          ...pageJob,
          preserveSession: true,
          includePage: (page) => (pageStates.get(page)?.state || "") === "queued"
        });
        translatedDoc = {
          ok: translatedDoc.ok && again.ok,
          aborted: translatedDoc.aborted || again.aborted,
          paused: translatedDoc.paused || again.paused,
          error: translatedDoc.error || again.error,
          missingField: translatedDoc.missingField || again.missingField,
          pages: translatedDoc.pages.concat(again.pages)
        };
      }
    }
    // A translation pause must not abandon layout. Skip pages and any page
    // whose sidecar call failed still get a recompute, then an immediate write-back.
    if (!translatedDoc.aborted && !work.aborted) {
      await reconcileLockedSkipLayouts(() => !isCurrentWork(work, gen, translatingDoc));
      const upgraded = await retryPendingVendorLayouts(() => !isCurrentWork(work, gen, translatingDoc));
      const needs = [];
      for (const page of upgraded || []) {
        if (!isCurrentWork(work, gen, translatingDoc)) break;
        const blocks = getPageLayout(page)?.blocks || null;
        if (!blocks || isSkipOnlyPage(blocks)) continue;
        const covered = libraryPageRunState({
          pairs: libraryEntry(page)?.pairs || [],
          cached: pageCache.get(translatingDoc, page),
          blocks,
          targetLang: pdfTargetLang,
          provider: pdfProvider
        });
        if (covered === "done" || covered === "skipped" || covered === "empty") continue;
        const prior = pageStates.get(page);
        notePageState(page, {
          state: countedPageState(prior?.state) ? "partial" : "queued",
          hasLayout: true
        });
        clearSlotPainted(page);
        needs.push(page);
      }
      if (needs.length && !translatedDoc.paused && isCurrentWork(work, gen, translatingDoc) && !work.aborted) {
        const filled = await translateDocumentPages({
          ...pageJob,
          preserveSession: true,
          includePage: (page) => needs.includes(page)
        });
        translatedDoc = {
          ok: translatedDoc.ok && filled.ok,
          aborted: translatedDoc.aborted || filled.aborted,
          paused: translatedDoc.paused || filled.paused,
          error: translatedDoc.error || filled.error,
          missingField: translatedDoc.missingField || filled.missingField,
          pages: translatedDoc.pages.concat(filled.pages)
        };
      }
    }
  }
  if (libraryPass && work === session && !forceReadoutHold) work.running = false;
  if (!isCurrentWork(work, gen, translatingDoc)) return;
  const { aborted, pages, error, missingField, paused } = translatedDoc;
  translatePaused = Boolean(paused);
  for (const entry of pages) {
    if (entry.reason === "cached" || entry.reason === "skip-only" || entry.reason === "empty") continue;
    const merged = withStructureRows(getPageLayout(entry.page), entry.results);
    if (entry.error || merged?.some((item) => item?.failed)) {
      const expected = Number(pageStates.get(entry.page)?.m) || 0;
      notePageState(entry.page, { state: pageRunState(merged, { expected, targetLang: pdfTargetLang }), hasLayout: true });
      clearSlotPainted(entry.page);
    }
  }
  renderArticle();
  const totals = pageTotals();
  const any = pages.some((entry) => pageHasTranslation(entry.results, pdfTargetLang) ||
    pageHasTranslation(pageCache.get(translatingDoc, entry.page), pdfTargetLang) ||
    (titleStructure?.page === entry.page && structureLanded(entry.page)));
  const clean = !error && !aborted && any && totals.n === total && totals.needsRetry === 0;
  if (paused) setStatus(PDF_COPY.pausedStreak, true);
  else if (error) setStatus(pdfTranslateFailureCopy({ error, field: missingField, missingField }), true);
  else if (aborted) setStatus(PDF_COPY.stopped);
  else if (!clean) setStatus(any ? PDF_COPY.incompletePages : PDF_COPY.noReturnedTranslation, true);
  else setStatus(PDF_COPY.doneDocument);
  finishDocPhase({ aborted, error: Boolean(error) || totals.needsRetry > 0 || totals.n !== total });
  const saveErrors = await Promise.all(saveTasks);
  // A retranslate click during the save wait takes a new session. Do not
  // clear its page or start another job over the batches it just sent.
  if (!isCurrentWork(work, gen, translatingDoc) || forceReadoutHold || forceRetranslatePending) return;
  if (!paused && !error && !aborted && totals.needsRetry === 0 && saveErrors.some(Boolean)) {
    setStatus("译文已生成，但部分页面写入本地库失败。", true);
  }
  translatingPage = 0;
  updateTranslateControls();
  resumePendingRetranslate();
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
        translated: record.translated,
        failed: record.failed === true
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
    titleStructure.failed = prior.title.failed === true;
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
  notePageState(page, { state: "failed", hasLayout: Boolean(getPageLayout(page)?.blocks?.length) });
  clearSlotPainted(page);
  restoreForceReadout(prior, doc, page);
  finishDocPhase({ error: true });
  setStatus(PDF_COPY.retranslateFailed, true);
  updateTranslateControls();
}

function abortForceRetranslate(work, prior, doc, page) {
  if (work === session) work.running = false;
  translatingPage = 0;
  forceReadoutHold = false;
  restoreForceReadout(prior, doc, page);
  finishDocPhase({ aborted: true });
  setStatus(PDF_COPY.stopped);
  updateTranslateControls();
}

async function forceRetranslateCurrentPage() {
  if (!pdfDoc || pdfTranslateBusy(session) || forceReadoutHold) {
    if (pdfDoc) forceRetranslatePending = true;
    return;
  }
  forceRetranslatePending = false;
  const sourceLayout = getPageLayout(capsulePage());
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
  const targetPage = capsulePage();
  const prior = snapshotForceReadout(translatingDoc, targetPage);
  // Drop the document job's session so its next batch cannot land in this
  // retranslate, and so its save-wait tail cannot clear translatingPage.
  abortTranslateSession(session);
  session = createTranslateSession();
  forceReadoutHold = true;
  const work = beginViewerSession();
  translatingPage = targetPage;
  notePageState(targetPage, { state: "running", hasLayout: Boolean(sourceLayout?.blocks?.length), k: 0 });
  clearSlotPainted(targetPage);
  docPhase = "running";
  renderArticle();
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
    await translateTitleStructure(work, gen, translatingDoc, batchSize, { bypassCache: true });
    if (left()) return;
    const translated = await translatePageBlocks(pageUnits, {
      send: runtimeSend,
      session: work,
      batchSize,
      bypassCache: true,
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
      notePageState(targetPage, { state: pageRunState(merged, { targetLang: pdfTargetLang }), hasLayout: true });
      clearSlotPainted(targetPage);
      finishDocPhase();
      renderArticle();
      if (!work.aborted && isCurrentWork(work, gen, translatingDoc)) setStatus(PDF_COPY.retranslateDone);
    } catch {
      restoreForceReadout(prior, translatingDoc, targetPage);
      notePageState(targetPage, { state: "failed", hasLayout: Boolean(getPageLayout(targetPage)?.blocks?.length) });
      clearSlotPainted(targetPage);
      setStatus(PDF_COPY.retranslateFailed, true);
      renderArticle();
    }
    work.running = false;
    translatingPage = 0;
    updateTranslateControls();
  } catch {
    if (isCurrentWork(work, gen, translatingDoc)) failForceRetranslate(work, prior, translatingDoc, targetPage);
    else if (work === session) work.running = false;
  } finally {
    const resumeAuto = autoAfterForce;
    autoAfterForce = false;
    forceReadoutHold = false;
    const row = pageStates.get(targetPage);
    if (row && (row.state === "running" || row.state === "layout")) {
      notePageState(targetPage, {
        state: work.aborted ? "queued" : "failed",
        hasLayout: Boolean(getPageLayout(targetPage)?.blocks?.length)
      });
      clearSlotPainted(targetPage);
      renderArticle();
    }
    if (work === session) work.running = false;
    if (translatingPage === targetPage) translatingPage = 0;
    updateTranslateControls();
    resumePendingRetranslate();
    if (resumeAuto) void maybeAutoTranslateDocument();
  }
}

function titleStructureFailed(page) {
  const record = titleStructure;
  return Boolean(record?.failed && record.docId === docId && record.page === page);
}

function withStructureRows(layout, merged) {
  const record = titleStructure;
  if (!record || record.docId !== docId || record.page !== layout?.page) return merged;
  if (!record.translated && !record.failed) return merged;
  const rows = structureTranslationRows(record.source, record.structure);
  return combinePageResults(rows, merged, Boolean(record.failed));
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

/** Pages still waiting on the sidecar, including ones skipped by a translation pause. */
async function retryPendingVendorLayouts(isStale) {
  const upgraded = [];
  const mode = pdfEngineMode();
  if (mode !== "local-ocr" && mode !== "cloud-ocr") return upgraded;
  const version = await layoutVersionNow();
  const total = pdfDoc?.numPages || 0;
  for (let page = 1; page <= total; page += 1) {
    if (isStale()) return upgraded;
    const entry = libraryEntry(page);
    const storedBlocks = entry?.layout?.blocks;
    const hasStored = (Array.isArray(storedBlocks) && storedBlocks.length > 0) ||
      Boolean(entry?.layoutVersion || entry?.layout?.layoutVersion);
    const stale = Boolean(entry && hasStored && version && !storedLayoutCurrent(entry, version));
    if (!stale && !vendorLayoutPending.has(page)) continue;
    try {
      const laid = await ingestPageLayout(page, isStale);
      if (laid) {
        vendorLayoutPending.delete(page);
        upgraded.push(page);
      }
    } catch {
      /* this page can be tried on the next open; keep going */
    }
  }
  return upgraded;
}

async function ingestPageLayout(n, isStale) {
  if (!isStale()) layoutNotice = "";
  await loadPdfLayout();
  const mode = pdfEngineMode();
  if (mode === "legacy") return ingestReadoutLayout(n, isStale);
  if (mode === "fixture" && n === 1) return ingestFixtureLayout(n, isStale);
  if (mode === "local-ocr" || mode === "cloud-ocr") {
    const laid = await ingestVendorLayout(n, mode, isStale);
    if (laid) {
      vendorLayoutReason.delete(n);
      return laid;
    }
    const reason = vendorLayoutReason.get(n) || "";
    vendorLayoutReason.delete(n);
    if (reason === "aborted") return null;
    if (!reason) return null;
    if (reason === "empty-key") return ingestTextLayerLayout(n, isStale);
    return ingestTextLayerLayout(n, isStale, { fallback: { source: "text-layer", reason } });
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

const vendorLayoutPending = new Set();
const vendorLayoutReason = new Map();
let vendorLayoutChain = Promise.resolve();
const vendorLayoutInflight = new Map();
let layoutAbort = new AbortController();
let layoutEpoch = 0;

function abortError() {
  const error = new Error("layout aborted");
  error.name = "AbortError";
  error.code = "aborted";
  return error;
}

/** Drop in-flight layout POSTs. The sidecar is one request at a time; a closed tab must not keep it. */
function abortInflightLayouts() {
  layoutEpoch += 1;
  try {
    layoutAbort.abort();
  } catch {
    /* already aborted */
  }
  layoutAbort = new AbortController();
  vendorLayoutInflight.clear();
  vendorLayoutChain = Promise.resolve();
}

/** One sidecar POST at a time. A second caller for the same page shares the first. */
function runVendorLayoutHttp(page, task) {
  const key = Number(page) || 0;
  const existing = vendorLayoutInflight.get(key);
  if (existing) return existing;
  const epoch = layoutEpoch;
  const signal = layoutAbort.signal;
  const run = () => {
    if (epoch !== layoutEpoch || signal.aborted) throw abortError();
    return task(signal);
  };
  const job = vendorLayoutChain.then(run, run);
  vendorLayoutInflight.set(key, job);
  const settled = job.then(() => {
    if (vendorLayoutInflight.get(key) === job) vendorLayoutInflight.delete(key);
  }, () => {
    if (vendorLayoutInflight.get(key) === job) vendorLayoutInflight.delete(key);
  });
  if (epoch === layoutEpoch) vendorLayoutChain = settled;
  return job;
}

async function ingestVendorLayout(n, mode, isStale) {
  const settings = cachedPdfLayout || normalizePdfLayout(null);
  if (mode === "cloud-ocr" && !shouldFetchCloud(settings)) {
    if (!isStale()) layoutNotice = LAYOUT_EMPTY_KEY_STATUS;
    vendorLayoutReason.set(n, "empty-key");
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
  const version = await layoutVersionNow();
  // A source-v3 entry with no revision, or an older revision, is not the current
  // block structure. Library page layouts follow the same rule.
  let mapped = storedLayoutCurrent(await readStoredLayout(key), version)
    || storedLayoutCurrent(libraryEntry(n), version);
  let recomputed = false;
  if (!mapped) {
    try {
      const envelope = await runVendorLayoutHttp(n, (signal) => (mode === "cloud-ocr"
        ? fetchCloudEnvelope({
            baseUrl: settings.cloudBaseUrl,
            apiKey: settings.cloudApiKey,
            model: settings.cloudModel,
            pngDataUrl: png,
            signal
          })
        : fetchLocalEnvelope({
            baseUrl: settings.localBaseUrl,
            page: n,
            imageBase64: png.replace(/^data:image\/png;base64,/, ""),
            pixelWidth: raster.pixelWidth,
            pixelHeight: raster.pixelHeight,
            signal
          })));
      let images = null;
      try {
        const ops = await page.getOperatorList();
        images = { fnArray: ops.fnArray, argsArray: ops.argsArray };
      } catch {
        images = null;
      }
      attachFontRealNames(content.items, page.commonObjs);
      mapped = vendorLayoutToBlocks(envelope, { items: content.items, viewport, images, page: n });
      if (version) mapped.layoutVersion = version;
      await writeStoredLayout(key, mapped);
      recomputed = true;
      vendorLayoutPending.delete(n);
    } catch (err) {
      if (err?.name === "AbortError" || err?.code === "aborted") {
        vendorLayoutReason.set(n, "aborted");
        vendorLayoutPending.delete(n);
        return null;
      }
      if (err?.code === "no-boxes") {
        vendorLayoutReason.set(n, "no-boxes");
        vendorLayoutPending.delete(n);
        if (!isStale()) layoutNotice = LAYOUT_NO_BOXES_STATUS;
        return null;
      }
      if (err?.code === "empty-key") {
        vendorLayoutReason.set(n, "empty-key");
        if (!isStale()) layoutNotice = LAYOUT_EMPTY_KEY_STATUS;
        return null;
      }
      if (!isStale()) layoutNotice = LAYOUT_FALLBACK_STATUS;
      const status = Number(err?.status) || 0;
      vendorLayoutReason.set(n, status ? `http-${status}` : "network");
      vendorLayoutPending.add(n);
      return null;
    }
  }
  if (isStale()) return null;
  const blocks = await cropLayoutBlocks(raster, page, mapped.blocks, n, isStale);
  if (!blocks || isStale()) return null;
  const layout = stampBodyFont({
    ...mapped,
    kind: "blocks",
    ...(version ? { layoutVersion: version } : {}),
    blocks,
    itemCount: extractPageItems(content).length
  }, content.items, viewport);
  setPageLayout(n, layout);
  if (recomputed) persistPageLayout(n).catch(() => {});
  return layout;
}

/** A page the library already skipped: same text blocks as a full ingest, without the page raster. */
async function ingestSkippedSourceLayout(n, isStale) {
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
  if (!isSkipOnlyPage(built.blocks)) return { ...built, kind: "blocks", blocks: built.blocks || [] };
  const version = await layoutVersionNow();
  const layout = stampBodyFont({
    ...built,
    kind: "blocks",
    protocol: built.protocol || PROTOCOL,
    ...(version ? { layoutVersion: version } : {}),
    blocks: built.blocks,
    itemCount: extractPageItems(content).length
  }, content.items, viewport);
  setPageLayout(n, layout);
  return layout;
}

async function ingestTextLayerLayout(n, isStale, options = {}) {
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
  const version = await layoutVersionNow();
  const fallback = options.fallback?.reason
    ? { source: String(options.fallback.source || "text-layer"), reason: String(options.fallback.reason) }
    : null;
  const layout = stampBodyFont({
    ...built,
    kind: "blocks",
    protocol: built.protocol || PROTOCOL,
    ...(version ? { layoutVersion: version } : {}),
    ...(fallback ? { fallback } : {}),
    blocks,
    itemCount: extractPageItems(content).length
  }, content.items, viewport);
  setPageLayout(n, layout);
  if (fallback) persistPageLayout(n).catch(() => {});
  else if (options.persist !== false) persistDisplayedLayout(n).catch(() => {});
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
  if (skipLocked.has(n)) return [];
  const isStale = () => gen !== restoreGen || translatingDoc !== docId;
  const layout = getPageLayout(n) || (await ingestPageLayout(n, isStale));
  if (!layout || isStale()) return [];
  if (work) {
    await ensureTitleStructure(n, layout);
    if (isStale()) return [];
    const record = titleStructure && titleStructure.docId === translatingDoc && titleStructure.page === n && titleStructure.status === "ok"
      ? titleStructure
      : null;
    const slotCount = record ? structureTranslateSlots(record.source).length : 0;
    const bodyCount = liveOriginals(layout, unitsForLayout(layout)).length;
    const known = slotCount + bodyCount;
    if (known > 0) {
      const prev = pageStates.get(n);
      const hold = countedPageState(prev?.state);
      notePageState(n, {
        state: hold ? "partial" : "running",
        hasLayout: true,
        m: Math.max(known, prev?.m || 0),
        k: prev?.k || 0
      });
      clearSlotPainted(n);
      renderArticle();
    }
    await translateTitleStructure(work, gen, translatingDoc, batchSize, { page: n });
    if (isStale()) return [];
    $("status")?.classList.remove("warn");
  }
  const blocks = unitsForLayout(layout);
  if (n === pageNum) pageOriginals = blocks;
  const cached = pageCache.get(translatingDoc, n);
  const saved = libraryEntry(n)?.pairs;
  const filled = applySavedPairs(
    liveOriginals(layout, blocks),
    (Array.isArray(cached) && cached.length ? cached : saved) || [],
    savedPairSettings()
  );
  const pending = unitsNeedingTranslation(filled, pdfTargetLang);
  if (filled.length && pending.length < filled.length) {
    const kept = mergeTranslationRows(Array.isArray(cached) ? cached : [], cacheableReuse(filled));
    pageCache.set(translatingDoc, n, kept);
    pageResults = kept;
  } else {
    pageResults = pageHasTranslation(cached, pdfTargetLang) ? cached : emptyPageResults(layout);
    if (!pageHasTranslation(cached, pdfTargetLang)) pageCache.set(translatingDoc, n, pageResults);
  }
  return pending;
}

/** 原文: view toggle only. Does not abort the session or clear the page cache. */
function restoreOriginal() {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const next = workspace.dataset.view === "src" ? "zh" : "src";
  setReaderView(next);
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
  sourceZoomTouched = false;
  const first = await doc.getPage(1);
  pdfPageWidth = first.getViewport({ scale: 1 }).width;
  zoom = defaultSourceZoom(currentSourceMode(), {
    pageWidth: pdfPageWidth,
    innerWidth: miniPagesInnerWidth()
  });
  docId += 1;
  restoreGen += 1;
  textGen += 1;
  renderGen += 1;
  translatingPage = 0;
  pageCache.clear();
  pageStates.clear();
  skipLocked.clear();
  legacySkipSeeded = false;
  if (viewerUnderTest()) {
    globalThis.__oiLayouts = {};
    globalThis.__oiPaint = [];
    globalThis.__oiAssetPaint = [];
  }
  visualCropPendingPages.clear();
  abortInflightLayouts();
  vendorLayoutPending.clear();
  vendorLayoutReason.clear();
  docPhase = "opening";
  notePageState(1, { state: "layout", hasLayout: false });
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
  if (title) {
    document.title = `${PDF_COPY.title} · ${shortTitle(title)}`;
    setDocTitle(title);
  }
  setHasDoc(true);
  await buildPages();
  if (!syncMiniFitZoom()) {
    requestAnimationFrame(() => {
      if (!syncMiniFitZoom()) requestAnimationFrame(() => syncMiniFitZoom());
    });
  }
  updatePager();
  await scheduleVisibleRenders();
  setStatus("原页已打开，正在读取文字层…");
  await loadCurrentPageText();
  syncZoomChip();
  await maybeAutoTranslateDocument();
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
  let widest = 0;
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const baseWidth = page.getViewport({ scale: 1 }).width;
    if (baseWidth > widest) widest = baseWidth;
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
  if (widest > 0) pdfPageWidth = widest;
  applyPaperMetrics();
}

async function layoutPages() {
  if (!pdfDoc) return;
  for (const view of pageViews) {
    const page = await pdfDoc.getPage(view.num);
    const viewport = page.getViewport({ scale: zoom });
    view.wrap.style.width = `${Math.floor(viewport.width)}px`;
    view.wrap.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    if (view.renderedScale !== zoom) {
      view.canvas.hidden = true;
      view.renderedScale = 0;
    }
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

function sourceNavPage() {
  const seen = measureVisible();
  return seen >= 1 ? seen : pageNum;
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
  if (syncOwner.ignores("pdf")) {
    updateSourcePageLabel(measureVisible());
    updatePager();
    return;
  }
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
  const origin = sourceNavPage() || pageNum;
  const next = pageIndex(origin, pdfDoc.numPages, dir);
  if (next === origin) return;
  const gen = ++navGen;
  const bringTranslation = dir > 0 && capsulePage() === origin;
  takeDriver("pdf");
  const view = pageViews[next - 1];
  view?.wrap.scrollIntoView({ block: "start", behavior: PANE_SYNC_BEHAVIOR });
  updatePager();
  updateSourcePageLabel(next);
  // Library pairs can paint a page before its layout exists. That flow has no
  // bids yet, so the page still needs its text layer or sidecar layout.
  const laid = Boolean(getPageLayout(next)?.blocks?.length);
  if (bringTranslation && pageHasFlow(next) && laid) {
    pageNum = next;
    updatePager();
    revealTranslationPage(next);
  } else if (!pageHasFlow(next) || !laid) {
    if (bringTranslation) {
      pageNum = next;
      updatePager();
      navRevealPage = next;
    }
    const row = pageStates.get(next);
    if (!row || row.state === "queued") {
      notePageState(next, { state: "layout", hasLayout: Boolean(getPageLayout(next)?.blocks?.length) });
    }
    await loadCurrentPageText(next);
    if (gen !== navGen) return;
    if (bringTranslation && navRevealPage === next) {
      navRevealPage = 0;
      revealTranslationPage(next);
    }
  }
  if (gen !== navGen) return;
  settlePairChrome();
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
        clearSlotPainted(n);
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

function miniPagesInnerWidth() {
  const pages = $("pages");
  if (!pages) return 0;
  const width = pages.clientWidth;
  return width > 0 ? width : 0;
}

let miniFitDragging = false;
let miniFitTimer = 0;
let miniFitMidDragApplied = false;

let miniFitSettleTimer = 0;

function beginMiniFitDrag() {
  miniFitDragging = true;
  miniFitMidDragApplied = false;
  if (miniFitTimer) {
    clearTimeout(miniFitTimer);
    miniFitTimer = 0;
  }
  if (miniFitSettleTimer) {
    clearTimeout(miniFitSettleTimer);
    miniFitSettleTimer = 0;
  }
}

function endMiniFitDrag() {
  if (miniFitTimer) {
    clearTimeout(miniFitTimer);
    miniFitTimer = 0;
  }
  const wasDragging = miniFitDragging;
  miniFitDragging = false;
  miniFitMidDragApplied = false;
  if (!wasDragging) return;
  syncMiniFitZoom();
  scheduleMiniFitSettle();
}

function scheduleMiniFitSettle() {
  if (miniFitSettleTimer) clearTimeout(miniFitSettleTimer);
  miniFitSettleTimer = setTimeout(() => {
    miniFitSettleTimer = 0;
    if (miniFitDragging) return;
    syncMiniFitZoom();
  }, 150);
}

function syncMiniFitZoom() {
  if (!pdfDoc || sourceZoomTouched) return false;
  if (currentSourceMode() !== "mini") return false;
  const workspace = document.querySelector(".workspace");
  if (!workspace || workspace.dataset.miniCollapsed === "true") return false;
  const fit = fitWidthZoom(pdfPageWidth, miniPagesInnerWidth());
  if (fit == null) return false;
  if (miniFitDragging) {
    if (!miniFitMidDragApplied && !miniFitTimer) {
      miniFitTimer = setTimeout(() => {
        miniFitTimer = 0;
        if (!miniFitDragging || miniFitMidDragApplied) return;
        miniFitMidDragApplied = true;
        commitMiniFitZoom({ exact: false });
      }, 150);
    }
    return true;
  }
  return commitMiniFitZoom({ exact: true });
}

function commitMiniFitZoom({ exact = false } = {}) {
  if (!pdfDoc || sourceZoomTouched) return false;
  if (currentSourceMode() !== "mini") return false;
  const workspace = document.querySelector(".workspace");
  if (!workspace || workspace.dataset.miniCollapsed === "true") return false;
  const fit = fitWidthZoom(pdfPageWidth, miniPagesInnerWidth());
  if (fit == null) return false;
  if (Math.abs(fit - zoom) < 1e-6) return true;
  if (!exact && Math.abs(fit - zoom) <= 0.01) return true;
  applyZoom(fit);
  return true;
}

function applyDefaultSourceZoom(mode) {
  if (!pdfDoc) return;
  if (sourceZoomTouched) {
    const kept = defaultSourceZoom(mode, { touched: true, current: zoom });
    if (kept !== zoom) applyZoom(kept);
    return;
  }
  if (mode === "mini") {
    syncMiniFitZoom();
    return;
  }
  const next = defaultSourceZoom(mode);
  if (next !== zoom) applyZoom(next);
}

async function setZoom(next) {
  const scale = clampZoom(next);
  return applyZoom(scale);
}

async function applyZoom(scale) {
  const next = Number(scale);
  if (!pdfDoc || !Number.isFinite(next) || !(next > 0)) {
    syncZoomButtons();
    return;
  }
  if (Math.abs(next - zoom) < 1e-6) {
    $("zoomLabel").textContent = formatZoomPercent(zoom);
    syncZoomButtons();
    return;
  }
  zoom = next;
  $("zoomLabel").textContent = formatZoomPercent(zoom);
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
  const want = neighborPages(sourceNavPage(), pdfDoc.numPages, RENDER_RADIUS);
  for (const n of want) {
    if (gen !== renderGen) return;
    const view = pageViews[n - 1];
    if (view) await renderView(view);
  }
}

async function renderView(view) {
  if (!pdfDoc || !view) return;
  if (view.renderedScale === zoom && view.canvas.width) {
    view.canvas.hidden = false;
    return;
  }
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

function notePaintSample(page, readout) {
  const visuals = (readout?.blocks || []).filter((block) => block.label === "figure" || block.label === "table").length;
  const blocks = (readout?.blocks || []).length;
  const log = globalThis.__oiPaint || (globalThis.__oiPaint = []);
  const last = log[log.length - 1];
  if (last && last.page === page && last.visuals === visuals && last.blocks === blocks) return;
  log.push({ page, visuals, blocks });
}

function showOpenedLayout(layout, isStale) {
  if (!layout || isStale()) return false;
  const laidPage = Number(layout.page) || textLoadPage || pageNum;
  pageItems = Number(layout.itemCount) || 0;
  pageOriginals = unitsForLayout(layout);
  const cached = pageCache.get(docId, laidPage);
  pageResults = cached || [];
  const copy = isSkipOnlyPage(layout.blocks)
    ? PAGE_STATUS_BIBLIOGRAPHY
    : (pageBlocksCopy(pageOriginals.length, pageItems) || textLayerCopy(pageItems));
  if (!pdfTranslateBusy(session)) {
    if (layoutNotice) setStatus(layoutNotice);
    else if (pageHasTranslation(cached, pdfTargetLang)) setStatus(copy || PDF_COPY.done);
    else setStatus(copy);
  }
  syncNoTextLayerHint(pageItems <= 0);
  noteLayoutReady(laidPage);
  if (layout.kind === "blocks" || layout.kind === "readout") renderArticle();
  if (navRevealPage === laidPage) {
    navRevealPage = 0;
    revealTranslationPage(laidPage);
  }
  return true;
}

/** A stored text-layer fallback stays on screen while the vendor layout is tried again. */
async function upgradeStoredFallback(n, mode, isStale) {
  const laid = await ingestVendorLayout(n, mode, isStale);
  vendorLayoutReason.delete(n);
  if (!laid || isStale()) return;
  showOpenedLayout(laid, isStale);
  const saved = libraryEntry(n);
  if (saved?.pairs) {
    const merged = applySavedPairs(unitsForLayout(laid), saved.pairs, savedPairSettings());
    pageCache.set(docId, n, merged);
    if (n === pageNum || n === textLoadPage) pageResults = merged;
  }
  renderArticle();
}

function layoutNeedsVisualCrops(layout) {
  return (layout?.blocks || []).some((block) => (
    isVisualBlock(block) && Array.isArray(block.bbox) && !block.imageUrl
  ));
}

let visualCropToken = 0;

/** Stored layouts keep bboxes and drop image bytes. Rebuild the same page-raster crops a fresh compute starts from. */
async function hydrateMissingVisualCrops(isStale = () => false) {
  if (!pdfDoc) return false;
  const token = ++visualCropToken;
  const stale = () => isStale() || token !== visualCropToken;
  const total = Number(pdfDoc.numPages) || 0;
  const order = [];
  for (let n = 1; n <= total; n += 1) {
    const layout = getPageLayout(n);
    if (!layoutNeedsVisualCrops(layout)) continue;
    const asset = (layout.blocks || []).some((block) => block.label === "figure" || block.label === "table");
    order.push({ n, asset });
  }
  order.sort((a, b) => Number(b.asset) - Number(a.asset) || a.n - b.n);
  let changed = false;
  const paint = () => {
    if (changed && !stale()) renderArticle();
  };
  for (const item of order) {
    if (stale()) {
      paint();
      return changed;
    }
    const n = item.n;
    const layout = getPageLayout(n);
    if (!layoutNeedsVisualCrops(layout)) continue;
    let page = null;
    try {
      page = await pdfDoc.getPage(n);
      if (stale()) {
        paint();
        return changed;
      }
      const viewport = page.getViewport({ scale: 1 });
      if (!(Number(layout.pageWidth) > 0) || !(Number(layout.pageHeight) > 0)) {
        layout.pageWidth = viewport.width;
        layout.pageHeight = viewport.height;
        clearSlotPainted(n);
        if (!stale()) renderArticle();
      }
      const raster = await renderPageRaster(page);
      if (stale()) {
        paint();
        return changed;
      }
      const blocks = await cropLayoutBlocks(raster, page, layout.blocks, n, stale, { sharp: false });
      if (raster.canvas) {
        raster.canvas.width = 0;
        raster.canvas.height = 0;
      }
      if (stale()) {
        paint();
        return changed;
      }
      if (!blocks) continue;
      layout.blocks = blocks;
      delete layout.formulaPlanKey;
      markVisualCropsFailed(layout);
      visualCropPendingPages.delete(n);
      clearSlotPainted(n);
      changed = true;
      if (item.asset) paint();
    } catch {
      const failedLayout = getPageLayout(n);
      markVisualCropsFailed(failedLayout);
      visualCropPendingPages.delete(n);
      clearSlotPainted(n);
      changed = true;
      continue;
    }
  }
  paint();
  if (changed && !stale()) refreshFormulaCropsForDisplay();
  return changed;
}

async function primeKnownPages() {
  if (!pdfDoc) return;
  const stamp = docId;
  const stale = () => docId !== stamp;
  await loadPdfLayout();
  try {
    await savedTranslationFor(pageNum);
  } catch {
    noteLibraryUnavailable();
  }
  if (stale()) return;
  await layoutVersionNow();
  if (stale()) return;
  const libraryChanged = seedLibraryProgress();
  const legacyChanged = await seedLegacySkipPages();
  if (stale()) return;
  const sized = await stampPendingVisualPages(stale);
  if (stale()) return;
  if (libraryChanged || legacyChanged || sized) renderArticle();
  hydrateMissingVisualCrops(stale).catch(() => {});
}

/** Page box for a stored crop, before the slow page raster. The pending hold uses it. */
async function stampPendingVisualPages(isStale) {
  if (!pdfDoc || !visualCropPendingPages.size) return false;
  let stamped = false;
  for (const n of [...visualCropPendingPages]) {
    if (isStale()) return stamped;
    const layout = getPageLayout(n);
    if (!layout) {
      visualCropPendingPages.delete(n);
      continue;
    }
    if (Number(layout.pageWidth) > 0 && Number(layout.pageHeight) > 0) continue;
    try {
      const page = await pdfDoc.getPage(n);
      if (isStale()) return stamped;
      const viewport = page.getViewport({ scale: 1 });
      layout.pageWidth = viewport.width;
      layout.pageHeight = viewport.height;
      stamped = true;
    } catch {
      /* hydrate marks a real crop failure */
    }
  }
  return stamped;
}

async function loadCurrentPageText(explicitPage) {
  if (!pdfDoc) return;
  const ticket = ++textGen;
  const requested = Number(explicitPage);
  const n = requested >= 1 ? requested : pageNum;
  textLoadPage = n;
  const translatingDoc = docId;
  const isStale = () => ticket !== textGen || translatingDoc !== docId;
  await primeKnownPages();
  if (isStale()) return;
  const version = knownLayoutVersion || await layoutVersionNow();
  const openedStored = getPageLayout(n);
  if (openedStored?.blocks?.length && storedLayoutDisplayable(openedStored, version)) {
    if (!showOpenedLayout(openedStored, isStale)) return;
    const saved = await savedTranslationFor(n).catch(() => null);
    if (isStale()) return;
    if (saved?.pairs) {
      const prepared = bindSavedPairs(saved, unitsForLayout(openedStored));
      const merged = applySavedPairs(unitsForLayout(openedStored), prepared.pairs, savedPairSettings());
      const blocks = openedStored.blocks || [];
      pageResults = merged;
      pageCache.set(docId, n, merged);
      const covers = libraryCoversLiveBlocks(prepared.pairs, blocks, pdfTargetLang, pdfProvider) ||
        libraryCoversLiveBlocks(merged, blocks, pdfTargetLang, pdfProvider);
      const skipped = skipLocked.has(n) || isSkipOnlyPage(blocks);
      notePageState(n, { state: skipped ? "skipped" : (covers ? "done" : "partial"), hasLayout: true });
      if (!pdfTranslateBusy(session)) setStatus(savedPageStatus(prepared, merged, blocks));
      rememberSkipHole(n, blocks);
    } else if (skipLocked.has(n) || isSkipOnlyPage(openedStored.blocks)) {
      notePageState(n, { state: "skipped", hasLayout: true });
    }
    clearSlotPainted(n);
    refreshDocStatus();
    renderArticle();
    updateTranslateControls();
    if (!storedLayoutCurrent(openedStored, version) && (pdfEngineMode() === "local-ocr" || pdfEngineMode() === "cloud-ocr")) {
      upgradeStoredFallback(n, pdfEngineMode(), isStale).catch(() => {});
    }
    return;
  }
  if (skipLocked.has(n)) {
    const known = getPageLayout(n);
    if (known) showOpenedLayout(known, isStale);
    notePageState(n, { state: "skipped", hasLayout: Boolean(known?.blocks?.length) });
    clearSlotPainted(n);
    refreshDocStatus();
    renderArticle();
    updateTranslateControls();
    return;
  }
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
      const quick = await ingestTextLayerLayout(n, isStale, { persist: false });
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
        const merged = applySavedPairs(unitsForLayout(quick), prepared.pairs, savedPairSettings());
        const quickBlocks = quick.blocks || [];
        if (libraryCoversLiveBlocks(prepared.pairs, quickBlocks, pdfTargetLang, pdfProvider) ||
            libraryCoversLiveBlocks(merged, quickBlocks, pdfTargetLang, pdfProvider)) {
          pageResults = merged;
          pageCache.set(docId, n, merged);
          notePageState(n, { state: "done", hasLayout: true });
        }
        persistDisplayedLayout(n).catch(() => {});
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
        const reason = vendorLayoutReason.get(n) || "";
        vendorLayoutReason.delete(n);
        if (reason && reason !== "aborted" && quick && !isStale()) {
          quick.fallback = { source: "text-layer", reason };
          quick.layoutVersion = quick.layoutVersion || knownLayoutVersion;
          setPageLayout(n, quick);
          persistPageLayout(n).catch(() => {});
        }
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
      const merged = applySavedPairs(unitsForLayout(layout), prepared.pairs, savedPairSettings());
      if (libraryCoversLiveBlocks(prepared.pairs, blocks, pdfTargetLang, pdfProvider) ||
          libraryCoversLiveBlocks(merged, blocks, pdfTargetLang, pdfProvider)) {
        pageResults = merged;
        pageCache.set(docId, n, merged);
        notePageState(n, { state: "done", hasLayout: true });
      }
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
  const nav = sourceNavPage();
  updateSourcePageLabel(measureVisible() || pageNum);
  for (const id of ["translatePage", "retranslatePage"]) {
    const button = $(id);
    if (button) button.dataset.page = String(pageNum);
  }
  $("zoomLabel").textContent = formatZoomPercent(zoom);
  const prev = $("sourcePrev");
  const next = $("sourceNext");
  if (prev) prev.disabled = !pdfDoc || nav <= 1;
  if (next) next.disabled = !pdfDoc || nav >= total;
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
  const bar = document.querySelector(".toolbar");
  if (bar) bar.dataset.hasDoc = has ? "1" : "0";
  if (!has) {
    $("pages").replaceChildren();
    pageViews = [];
    setDocTitle("");
    $("zoomLabel").textContent = formatZoomPercent(DEFAULT_ZOOM);
    pdfPageWidth = 0;
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

function retranslatePageOpen() {
  const page = capsulePage();
  const row = pageStates.get(page);
  const layout = getPageLayout(page);
  return canRetranslatePage({
    state: row?.state || "",
    translatableCount: translatableBlocks(layout?.blocks || []).length,
    titleCandidate: isTitlePageCandidate(page, pageTextForStructure(layout?.blocks)),
    originals: page === pageNum ? pageOriginals.length : 0
  });
}

function updateTranslateControls() {
  const ui = pdfToolbarActionState({
    busy: pdfTranslateBusy(session),
    hasDoc: Boolean(pdfDoc),
    canTranslate: Boolean(pdfDoc),
    canRetranslate: retranslatePageOpen()
  });
  $("translatePage").disabled = ui.translateDisabled;
  $("translatePage").hidden = ui.translateHidden;
  $("retranslatePage").disabled = ui.retranslateDisabled;
  const menuRetranslate = $("translateMenuRetranslate");
  if (menuRetranslate) menuRetranslate.disabled = ui.retranslateDisabled;
  $("stopTranslate").hidden = ui.stopHidden;
  $("stopTranslate").disabled = ui.stopDisabled;
  syncExportControls();
  syncMirrorZoomButtons();
}

function setStatus(text, isError = false, isWarn = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  el.classList.toggle("warn", Boolean(isWarn) && !isError);
}
