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
  createBackgroundSessions,
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
  pageNeedsBypass,
  reuseSettledLibraryFailures,
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
  translationCacheWhile,
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
import { blocksForNotes } from "../lib/note-page-blocks.js";
import { createBlockAnchor, injectDeadExactNote, reanchorOpenPage, sharedNotesStore } from "../lib/notes-anchor.js";
import { exportMarkdown } from "../lib/notes-io.js";
import { NOTES_PANE_WIDTH_DEFAULT, NOTES_PANE_WIDTH_MIN, dismissPersistHint, persistHintDismissed } from "../lib/notes-prefs.js";
import { createNotesPrefsSession } from "../lib/reader-notes-local.js";
import {
  NOTES_PANE_RESIZE_DEBOUNCE_MS,
  applyNotesSplitAria,
  clampDraggedNotesWidth,
  notesChromeKind,
  notesDomOrder,
  notesSideFromSource,
  notesSplitAria,
  notesSplitKeyStep,
  notesWidthLimit,
  notesWorkspaceWidth,
  reorderWorkspacePanes,
  sourceSideFromNotes,
  threePaneColumns,
  threeSourceAria
} from "../lib/notes-pane.js";
import { recordedPersistDenied } from "../lib/notes-store.js";
import { firstLineQuote } from "../lib/notes-view-model.js";
import { mountNotesUi, textRangeOffsets } from "./notes-panel.js";
import { mountAskUi } from "./ask-panel.js";
import { mountLibraryUi } from "./library-panel.js";
import { bindLibraryWriteMarks, noteLibraryLoaded, resetLibraryWriteStops } from "../lib/library-writes.js";
import { performAsk } from "../lib/ask-transport.js";
import { currentNet } from "../lib/net/fetch.js";
import { ASK_CONFIRM_KEY, askTarget } from "../lib/ask-model.js";
import { readStoredAskConfirm, writeStoredAskConfirm } from "../lib/ask-confirm.js";
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
  layoutCurrentForEngine,
  layoutCurrentForLibrary,
  layoutFallbackOf,
  layoutServesEngine,
  layoutServesLibrary,
  normalizePdfLayout,
  resolveLayoutMode,
  runLaneAttempts,
  shouldFetchCloud,
  startDocumentLayoutRetry,
  createPrioritySerialLane,
  stampSessionLayout,
  storedLayoutDisplayable
} from "../lib/pdf-layout-client.js";
import { blankFormulaMask, boxesInCrop, measureFormulaCrop, textLayerToBlocks } from "../lib/pdf-text-layer.js";
import {
  READER_SOURCE_BODY_PT,
  displayFormulaColumnPx,
  formulaReadabilityFloor,
  formulaScriptPt,
  placeholderCssLength,
  placeholderNativeBox,
  readerFormulaCssSize
} from "../lib/pdf-formula-size.js";
import {
  READER_FONT_SIZES,
  READER_FONT_TICKS,
  READER_THEME_LABELS,
  CAPSULE_END_BAND,
  CAPSULE_END_MIN,
  CAPSULE_PAD_X,
  CAPSULE_PAD_X_MIN,
  CAPSULE_START_BAND_MIN,
  CAPSULE_START_FLOOR,
  CAPSULE_START_RELAXED,
  applyReaderFontAction,
  applyReaderFontSliderAction,
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
  READER_SOURCE_SIDE_STORAGE_KEY,
  readReaderPrefs,
  readerFontAnchorTop,
  readerFontBand,
  readerFontCapHint,
  readerFontRatio,
  readerFontShortcut,
  readerFontSizeFromRatio,
  readerFontValueText,
  readerInlineCropEm,
  readerLayoutFontCap,
  readerImageBlend,
  readerThemeAriaLabel,
  splitAriaModel,
  splitLayout,
  syncReaderFontStorage,
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
import { detectArxivId } from "../lib/arxiv-id.js";
import { resolveArxivSession } from "../lib/formula-arxiv-gate.js";
import { KATEX_RENDER_OPTIONS } from "../lib/formula-katex.js";
import { formulaArxivSourceEnabled, setFormulaArxivSourceEnabled } from "../lib/formula-flags.js";
import { scheduleFormulaBlock, publishRestampedBlocks } from "../lib/formula-schedule.js";
import { cropPngFor } from "../lib/formula-crop-png.js";
import { createFormulaCache } from "../lib/formula-cache.js";
import { createMessageFormulaStore } from "../lib/formula-cache-client.js";
import { mmPageLedger, resetMmPages } from "../lib/formula-mm-ledger.js";
import {
  ARXIV_SOURCE_AUTO_KEY,
  ARXIV_SOURCE_ON_KEY,
  ARXIV_SOURCE_SKIP_KEY,
  chipModel,
  inlineSplicePlans,
  keptSourceId,
  normalizeArxivPrefs,
  pageGlyphsFromText,
  prepareArxivAlignment,
  skippedId,
  slotAssignments,
  spliceInlinePieces,
  verifiedArxivFormula
} from "../lib/formula-arxiv-session.js";
import {
  failedInlineKind,
  flashCopiedLatex,
  markFormulaOverflow,
  mountArxivDisplay,
  mountArxivInline,
  plainWithInlineMath
} from "../lib/formula-arxiv-pane.js";
import {
  FORMULA_SETTINGS_KEY,
  defaultFormulaSettings,
  formulaChainFlags,
  normalizeFormulaSettings,
  placeholderCopy,
  readFormulaSettings,
  writeFormulaSettings
} from "../lib/formula-settings.js";
import { renderFormulaSwitchList } from "../lib/formula-settings-ui.js";
import { applySavedPairs, bindStructureRowBids, blockSoftLead, commitLandedStructurePairs, createLibraryWriteQueue, currentLayoutIfArrived, fetchLibraryDocument, flushPendingPages, isSkipOnlyPage, LIBRARY_ZONE_WAIT_MS, libraryFetchInFlight, libraryHoldCopy, libraryProbeFailure, mergeLibraryPairs, pageSoftStatus, PAGE_STATUS_BIBLIOGRAPHY, pairsFromResults, pairsVerifiedForLibrary, pairsWithLiveFormulaSlots, pairsWithoutUnalignedSlots, paperFullyInLibrary, repairMatrixProjectionPairs, replaceLibraryPagePairs, resolveZoneForVendor, openLibraryPdf, saveLibraryPage, selectPageLayout, selectSavedTranslation, setLibraryUiHooks, settleFreshZone, shouldProbeLocalService, storedReadoutBlocks, structurePairsChanged, translationWaitsForLibrary, waitForFirstZone, waitForZoneMigration, whenZoneReadSettles } from "../lib/pdf-library.js";
import { readLayoutCache, readLayoutCaches, writeLayoutCache } from "../lib/pdf-layout-cache.js";
import { createLibraryChip } from "../lib/library-chip.js";
import { bindImportChip } from "../options/data-panel.js";
import { PERSIST_CARD_SESSION_KEY, createPersistCard, persistCardHiddenThisSession, readPersistCardState } from "../lib/persist-card.js";
import { cleanTitle, httpSourceUrl } from "../lib/library-record.js";
import { LIBRARY_PERSIST_HINT_KEY } from "../lib/library-store.js";
import { bindPendingUnload, chromeSessionArea, createPendingNotes } from "../lib/pending-notes.js";
import { isStorageBlocked, storageFailureCause, storageFailureSince } from "../lib/storage-copy.js";
import { getProvider, missingRequiredField, resolveOutboundProvider } from "../lib/providers.js";
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
// Anvil can turn tier 0 on from the console. There is no settings control.
globalThis.__oiSetFormulaArxivSource = setFormulaArxivSourceEnabled;
const RENDER_RADIUS = 2;

GlobalWorkerOptions.workerSrc = workerSrc();

let pdfDoc = null;
let pageNum = 1;
let zoom = DEFAULT_ZOOM;
let pdfPageWidth = 0;
let sourceZoomTouched = false;
let sourceUrl = "";
let libraryFileName = "";
let libraryHttpUrl = "";
let libraryTitle = "";
let docId = 0;
let restoreGen = 0;
let textGen = 0;
let textLoadPage = 0;
let navGen = 0;
let pageNavDepth = 0;
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
let pdfModel = "";
let translatePaused = false;
let autoAfterForce = false;
let forceRetranslatePending = false;
let libraryArticle = null;
let libraryDoc = null;
let libraryProbe = null;
let notesDocHash = "";
let notesUi = null;
let libraryUi = null;
let libraryAdoptHold = null;
let libraryAdoptWouldSkip = false;
let libraryOpenNotedAt = 0;
let askUi = null;
let libraryChip = null;
let importBinding = null;
let persistCard = null;
let pendingNotes = null;
let pendingUnload = () => {};
let notesLayoutLatch = "";
let notesPaintedKind = "";
let notesUserPin = "";
let notesTempUpgrade = "";
let notesResizeTimer = 0;
let notesChromeLock = false;
let titleStructure = null;
const librarySourceSent = new Set();
// The original PDF was stored. This is not "pages written this session":
// savedTranslationFor uses librarySourceSent for that, and an open must not
// join it or a slow library read refuses the stored translation.
const libraryOriginalStored = new Set();
// Readable without the oiAuto gate. Opening must not add the hash here.
globalThis.__oiLibrarySourceSentHas = (hash) => librarySourceSent.has(String(hash || ""));
globalThis.__oiDropLibraryDoc = () => {
  libraryDoc = null;
  libraryProbe = null;
};
let libraryWritesPending = 0;
const enqueueLibraryWrite = (() => {
  const enqueue = createLibraryWriteQueue();
  return (write) => {
    libraryWritesPending += 1;
    return enqueue(() => Promise.resolve().then(write).finally(() => {
      libraryWritesPending -= 1;
    }));
  };
})();
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
const notesPrefsSession = createNotesPrefsSession();
let sourcePopTrigger = null;
let sourcePopSwipeY = 0;
let readerBlend = readerImageBlend({ supportsMultiply: true, forcedColors: false });
let toolbarSnapFrame = 0;
const READER_VIEWS = ["zh", "bi", "src"];
let formulaViewerSettings = defaultFormulaSettings();
let formulaViewerCache = null;

function viewerFormulaCache() {
  if (!formulaViewerCache) {
    formulaViewerCache = createFormulaCache(createMessageFormulaStore((message) => runtimeSend(message)));
  }
  return formulaViewerCache;
}
let formulaSettingsWriting = false;
let formulaSettingsReady = Promise.resolve();
let arxivPrefs = { auto: false, skip: [], on: [] };
let arxivPrefsReady = Promise.resolve();
let arxivIdentity = null;
let arxivAlignmentMemory = null;
let arxivSlotMap = new Map();
let arxivSpliceByBlock = new Map();
let arxivPhase = "off";
let arxivFailReason = "";
let arxivJob = 0;
let page1TextItems = null;
let page1Viewport = null;

let lastShownFont = 0;
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
    if (el.closest(".oi-arxiv-chip") && !el.classList.contains("oi-arxiv-chip")) return false;
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

function readNotesPanelPrefs() {
  return notesPrefsSession.read();
}

function writeNotesPanelPrefs(patch) {
  return notesPrefsSession.write(patch);
}

function init() {
  // Copy legacy localStorage keys into the local area once. Until that
  // finishes, reads still use localStorage. On a later open those keys are
  // already gone, so this window sees defaults rather than the saved values.
  void notesPrefsSession.prime();
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
  bindArxivChip();
  installNotesUi();
  installAskUi();
  installLibraryUi();
  installLibraryChrome();
  bindLibraryWriteMarks({
    sourceSent: librarySourceSent,
    originalStored: libraryOriginalStored,
    dropDoc(hash) {
      if (libraryDoc?.hash === hash) libraryDoc = null;
    }
  });
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
  window.addEventListener("pagehide", closeViewerWork);
  window.addEventListener("beforeunload", closeViewerWork);
  listenProgress();

  const src = readViewerSrc(location.search);
  applyViewMode();
  if (src) {
    sourceUrl = src;
    openFromSrc(src);
  } else {
    setStatus(PDF_COPY.empty);
    // init() runs before later lets in this module. Open after they exist.
    queueMicrotask(() => libraryUi?.open({ reason: "empty" }));
  }
  if (String(location.hash || "").startsWith("#library")) {
    queueMicrotask(() => libraryUi?.open({ reason: "hash" }));
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
  if (event.key === "Escape" && event.target?.closest?.(".oi-note-editor") && notesUi?.consumeEscape()) {
    event.preventDefault();
    return;
  }
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
  if (event.key === "Escape" && libraryUi?.consumeEscape()) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && askUi?.consumeEscape()) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && notesUi?.consumeEscape()) {
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
  if (eventTargetIsField(event.target) || event.target?.isContentEditable || focusInLibraryField(event.target)) return;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "z" || event.key === "Z")) {
    if (notesUi?.undo()) {
      event.preventDefault();
      return;
    }
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (readerPrefs.singleKey !== false && event.shiftKey && !focusInOpenMenu() && !focusInAaPanel() && (event.key === "N" || event.key === "n")) {
      event.preventDefault();
      void notesQuestionShortcut();
      return;
    }
    if (event.shiftKey && !focusInOpenMenu() && !focusInAaPanel() && (event.key === "M" || event.key === "m")) {
      event.preventDefault();
      const current = readNotesPanelPrefs().notesPaneSide;
      setNotesPaneSide(current === "start" ? "end" : "start");
      return;
    }
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
      if (document.querySelector(".workspace")?.dataset.layout === "3") {
        const current = readNotesPanelPrefs().notesPaneSide;
        setNotesPaneSide(current === "start" ? "end" : "start");
      } else toggleSourceSide();
      return;
    }
    if (event.key === "m" || event.key === "M") {
      event.preventDefault();
      notesUi?.toggle();
      return;
    }
    if (event.key === "a" || event.key === "A") {
      event.preventDefault();
      askUi?.toggle();
      return;
    }
    if (event.key === "l" || event.key === "L") {
      if (eventTargetIsField(event.target)) return;
      event.preventDefault();
      libraryUi?.toggle();
      return;
    }
    if (event.key === "q" || event.key === "Q") {
      event.preventDefault();
      askFromKey();
      return;
    }
    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      void notesShortcut("note");
      return;
    }
    if (event.key === "h" || event.key === "H") {
      event.preventDefault();
      void notesShortcut("highlight");
      return;
    }
  }
  if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && event.target?.closest?.(".split-handle, .oi-notes")) return;
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

function focusInLibraryField(target) {
  const candidates = [target, document.activeElement];
  for (const el of candidates) {
    if (!el || typeof el.closest !== "function") continue;
    if (!el.closest(".oi-library")) continue;
    if (eventTargetIsField(el)) return true;
  }
  return false;
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
  const anchor = captureFontAnchor();
  readerPrefs = { ...readerPrefs, fontSize: next };
  persistReaderPrefs();
  applyReaderSurface();
  renderArticle();
  layoutCapsule();
  applyPaperMetrics();
  finishFontAnchor(anchor);
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

function readerShownFont() {
  return Math.min(readerPrefs.fontSize, liveReaderFontCap());
}

function liveReaderFontCap() {
  const pane = document.querySelector(".pane-translate");
  const column = pane?.clientWidth || 0;
  if (!(column > 0)) return READER_FONT_SIZES[READER_FONT_SIZES.length - 1];
  const windowWidth = window.innerWidth || column;
  const inBar = translateScrollRoot()?.dataset.capsuleMode === "bar" || windowWidth < 900;
  return readerLayoutFontCap({ windowWidth, columnPx: column, capsuleInBar: inBar });
}

function readerHasBody() {
  const flow = readerFlowEl();
  return Boolean(flow?.querySelector(".rf-block, .oi-pdf-p, .oi-pdf-h1, .oi-pdf-h2, .oi-pdf-h3"));
}

function readerFontControlsDisabled() {
  if (!pdfDoc) return true;
  if (readerHasBody()) return false;
  return pdfTranslateBusy(session);
}

function applyReaderSurface() {
  const shown = readerShownFont();
  const size = `${shown}px`;
  const band = readerFontBand(shown);
  for (const el of readerThemeRoots()) {
    el.dataset.readerTheme = readerPrefs.theme;
    el.dataset.readerFsBand = band;
    el.style.setProperty("--oi-reader-font-size", size);
    el.style.setProperty("--oi-pdf-body-fs", size);
    el.style.setProperty("--oi-reader-fs-num", String(shown));
    if (readerInlineCropEm(shown) === 1.8) el.style.setProperty("--oi-pdf-inline-crop-em", "1.8em");
    else el.style.removeProperty("--oi-pdf-inline-crop-em");
  }
  syncAaPanel();
}

function refreshReaderFontCap() {
  const next = readerShownFont();
  const changed = lastShownFont > 0 && next !== lastShownFont;
  const anchor = changed ? captureFontAnchor() : null;
  applyReaderSurface();
  lastShownFont = readerShownFont();
  if (!changed) return;
  layoutCapsule({ keepAnchor: true });
  applyPaperMetrics();
  finishFontAnchor(anchor);
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
    const snapped = syncReaderFontStorage(localStorage);
    if (snapped !== readerPrefs.fontSize) readerPrefs = { ...readerPrefs, fontSize: snapped };
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
  const setting = readerPrefs.fontSize;
  const shown = readerShownFont();
  const capped = shown < setting;
  const hasBody = readerHasBody();
  const mode = currentSourceMode();
  const hint = readerFontCapHint({
    cap: liveReaderFontCap(),
    setting,
    mode,
    hasBody
  });
  const value = $("aaFontValue");
  if (value) {
    value.replaceChildren();
    value.append(document.createTextNode(`${setting} px`));
    if (capped && hasBody) {
      const mark = document.createElement("span");
      mark.className = "aa-font-capped";
      mark.textContent = ` → ${shown}`;
      value.append(mark);
    }
  }
  const reset = $("aaFontDefault");
  if (reset) reset.disabled = setting === 16;
  const slider = $("aaFontScale");
  const disabled = readerFontControlsDisabled();
  const group = $("aaFontGroup");
  if (group) group.setAttribute("aria-disabled", disabled ? "true" : "false");
  if (slider) {
    const ratio = readerFontRatio(setting);
    slider.setAttribute("aria-valuenow", String(setting));
    slider.setAttribute("aria-valuetext", hint ? hint.valuetext : readerFontValueText(setting));
    slider.setAttribute("aria-disabled", disabled ? "true" : "false");
    slider.tabIndex = disabled ? -1 : 0;
    const fill = $("aaFontFill");
    const thumb = $("aaFontThumb");
    if (fill) fill.style.width = `${ratio * 100}%`;
    if (thumb) thumb.style.left = `${ratio * 100}%`;
  }
  const cap = $("aaFontCap");
  const capText = $("aaFontCapText");
  const hide = $("aaFontHideSource");
  if (cap && capText) {
    cap.hidden = !hint;
    capText.textContent = hint ? hint.text : "";
    if (hide) hide.hidden = !hint?.hideSource;
  }
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
  const ticks = $("aaFontTicks");
  if (!ticks || ticks.childElementCount) return;
  const last = READER_FONT_SIZES.length - 1;
  for (const size of READER_FONT_TICKS) {
    const index = READER_FONT_SIZES.indexOf(size);
    const tick = document.createElement("span");
    tick.className = "aa-slider-tick";
    tick.dataset.size = String(size);
    tick.style.left = `${(index / last) * 100}%`;
    const mark = document.createElement("i");
    mark.setAttribute("aria-hidden", "true");
    const num = document.createElement("span");
    num.textContent = String(size);
    tick.append(mark, num);
    if (size === 16) {
      const dot = document.createElement("span");
      dot.className = "aa-slider-default";
      dot.setAttribute("aria-hidden", "true");
      tick.append(dot);
    }
    ticks.append(tick);
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
  const actions = {
    ArrowLeft: "decrease",
    ArrowDown: "decrease",
    ArrowRight: "increase",
    ArrowUp: "increase",
    Home: "min",
    End: "max",
    PageUp: "tick-up",
    PageDown: "tick-down"
  };
  const action = actions[event.key];
  if (!action || readerFontControlsDisabled()) return;
  event.preventDefault();
  commitReaderFont(applyReaderFontSliderAction(readerPrefs.fontSize, action));
}

let fontDragFrame = 0;
let fontDragSize = null;

function queueReaderFont(size) {
  fontDragSize = size;
  if (fontDragFrame) return;
  fontDragFrame = requestAnimationFrame(() => {
    fontDragFrame = 0;
    const next = fontDragSize;
    fontDragSize = null;
    if (next == null) return;
    commitReaderFont(next);
  });
}

function sliderFontRatio(event) {
  const track = $("aaFontScale")?.querySelector(".aa-slider-track");
  if (!track) return 0;
  const box = track.getBoundingClientRect();
  const width = box.width || 1;
  return (event.clientX - box.left) / width;
}

function placeFontTip(ratio) {
  const tip = $("aaFontTip");
  const slider = $("aaFontScale");
  const track = slider?.querySelector(".aa-slider-track");
  if (!tip || !slider || !track) return;
  const size = readerFontSizeFromRatio(ratio);
  tip.hidden = false;
  tip.textContent = String(size);
  const box = track.getBoundingClientRect();
  const host = slider.getBoundingClientRect();
  const x = box.left + Math.min(1, Math.max(0, ratio)) * box.width - host.left;
  tip.style.left = `${x}px`;
  tip.style.top = `${box.top - host.top - 6}px`;
}

function onAaFontPointerDown(event) {
  const slider = $("aaFontScale");
  if (!slider || readerFontControlsDisabled()) return;
  if (event.button != null && event.button !== 0) return;
  event.preventDefault();
  slider.focus();
  slider.classList.add("is-dragging");
  slider.setPointerCapture?.(event.pointerId);
  queueReaderFont(readerFontSizeFromRatio(sliderFontRatio(event)));
}

function onAaFontPointerMove(event) {
  const slider = $("aaFontScale");
  if (!slider || readerFontControlsDisabled()) return;
  const ratio = sliderFontRatio(event);
  if (slider.classList.contains("is-dragging")) {
    queueReaderFont(readerFontSizeFromRatio(ratio));
    return;
  }
  if (event.pointerType === "mouse") placeFontTip(ratio);
}

function onAaFontPointerUp(event) {
  const slider = $("aaFontScale");
  if (!slider?.classList.contains("is-dragging")) return;
  slider.classList.remove("is-dragging");
  if (slider.hasPointerCapture?.(event.pointerId)) slider.releasePointerCapture(event.pointerId);
  const ratio = sliderFontRatio(event);
  queueReaderFont(readerFontSizeFromRatio(ratio));
}

function hideFontTip() {
  const tip = $("aaFontTip");
  if (tip) tip.hidden = true;
}

function bindFontCapObserver() {
  const pane = document.querySelector(".pane-translate");
  let timer = 0;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      refreshReaderFontCap();
    }, 150);
  };
  if (pane && typeof ResizeObserver === "function") new ResizeObserver(schedule).observe(pane);
  else window.addEventListener("resize", schedule);
  requestAnimationFrame(() => refreshReaderFontCap());
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

function renderAaFormulaSwitches() {
  const host = $("aaFormulaSwitches");
  if (!host) return;
  renderFormulaSwitchList(host, formulaViewerSettings, {
    onToggle: (key, enabled) => updateFormulaViewerSwitch(key, enabled),
    onConfigure: () => openFormulaSettings()
  });
}

async function updateFormulaViewerSwitch(key, enabled) {
  formulaViewerSettings = normalizeFormulaSettings({ ...formulaViewerSettings, [key]: enabled === true });
  formulaSettingsWriting = true;
  try {
    formulaViewerSettings = await writeFormulaSettings(formulaViewerSettings, globalThis.chrome?.storage?.local);
  } catch {
    /* keep the in-memory switch */
  } finally {
    formulaSettingsWriting = false;
  }
  renderAaFormulaSwitches();
}

function openFormulaSettings() {
  const url = globalThis.chrome?.runtime?.getURL?.("options/options.html#formula");
  if (url) window.open(url);
}

function bindFormulaViewerSettings() {
  renderAaFormulaSwitches();
  $("aaFormulaSettings")?.addEventListener("click", () => openFormulaSettings());
  const storage = globalThis.chrome?.storage;
  storage?.onChanged?.addListener((changes, area) => {
    if (formulaSettingsWriting || area !== "local" || !changes[FORMULA_SETTINGS_KEY]) return;
    formulaViewerSettings = normalizeFormulaSettings(changes[FORMULA_SETTINGS_KEY].newValue);
    renderAaFormulaSwitches();
  });
  formulaSettingsReady = readFormulaSettings(storage?.local).then((stored) => {
    formulaViewerSettings = stored;
    renderAaFormulaSwitches();
  }).catch(() => {});
}

function bindReaderChrome() {
  buildAaScale();
  buildAaThemes();
  initCjkMode();
  loadReaderPrefs();
  bindFormulaViewerSettings();
  $("aaButton")?.addEventListener("click", () => {
    const panel = $("aaPanel");
    if (!panel) return;
    if (panel.hidden) openAaPanel();
    else closeAaPanel();
  });
  $("aaFontDefault")?.addEventListener("click", () => {
    commitReaderFont(16);
  });
  $("aaFontHideSource")?.addEventListener("click", () => {
    commitSourceMode("hidden");
  });
  const slider = $("aaFontScale");
  slider?.addEventListener("keydown", onAaFontScaleKey);
  slider?.addEventListener("pointerdown", onAaFontPointerDown);
  slider?.addEventListener("pointermove", onAaFontPointerMove);
  slider?.addEventListener("pointerup", onAaFontPointerUp);
  slider?.addEventListener("pointercancel", onAaFontPointerUp);
  slider?.addEventListener("pointerleave", hideFontTip);
  bindFontCapObserver();
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

function sourceSplitHandle(workspace) {
  const root = workspace || document.querySelector(".workspace");
  return root?.querySelector('.split-handle[data-split="source"]') || null;
}

function notesSplitHandle(workspace) {
  const root = workspace || document.querySelector(".workspace");
  return root?.querySelector('.split-handle[data-split="notes"]') || null;
}

function bindSplitResize() {
  const workspace = document.querySelector(".workspace");
  const handle = sourceSplitHandle(workspace);
  if (!workspace || !handle) return;
  handle.addEventListener("pointerdown", (event) => startSplitDrag(event, workspace, handle));
  handle.addEventListener("dblclick", () => resetSplit(workspace));
  handle.addEventListener("keydown", (event) => onSplitKey(event, workspace));
  const notesHandle = notesSplitHandle(workspace);
  if (notesHandle) {
    notesHandle.addEventListener("pointerdown", (event) => startNotesSplitDrag(event, workspace, notesHandle));
    notesHandle.addEventListener("dblclick", () => resetNotesSplit(workspace));
    notesHandle.addEventListener("keydown", (event) => onNotesSplitKey(event, workspace));
  }
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
    if (workspace.dataset.layout === "3") persistSplitRatio(workspace);
    else if (workspace.dataset.sourceMode === "mini") {
      if (sideChromeOn(workspace)) persistSlotPanelWidth(workspace);
      else persistMiniWidth(workspace);
    } else {
      persistSplitRatio(workspace);
      if (sideChromeOn(workspace)) persistSlotPanelWidth(workspace);
    }
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
  if (workspace?.dataset.layout === "3") {
    paintThreeColumns(workspace, { splitRatio: defaultSplitRatio(readerWidth()) });
    persistSplitRatio(workspace);
    syncZoomChip();
    syncMirrorZoomChip();
    applyPaperMetrics();
    layoutCapsule({ keepAnchor: true });
    return;
  }
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
  const handle = sourceSplitHandle(workspace);
  if (!handle) return;
  if (workspace?.dataset.layout === "3") {
    const prefs = readNotesPanelPrefs();
    const model = threeSourceAria({
      workspaceWidth: measuredWorkspaceWidth(workspace),
      notesWidth: prefs.notesWidth,
      splitRatio: ratio
    });
    handle.setAttribute("aria-valuemin", String(model.valuemin));
    handle.setAttribute("aria-valuemax", String(model.valuemax));
    handle.setAttribute("aria-valuenow", String(model.valuenow));
    handle.setAttribute("aria-valuetext", model.valuetext);
    const bubble = handle.querySelector(".split-bubble");
    if (bubble) bubble.textContent = model.bubble;
    return;
  }
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
  if (workspace?.dataset.layout === "3") {
    onThreeSourceKey(event, workspace);
    return;
  }
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
    if (sideChromeOn(workspace)) {
      writeNotesPanelPrefs({ panelWidth: next });
      paintMiniWidth(workspace, next);
      syncZoomChip();
      syncMirrorZoomChip();
      applyPaperMetrics();
      layoutCapsule({ keepAnchor: true });
      return;
    }
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
  if (workspace?.dataset.layout === "3") {
    applyThreeSourceSplit(workspace, clientX);
    return;
  }
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

function warnViewerStorage(scope, err) {
  const raw = err && typeof err.name === "string" ? err.name : "Error";
  const name = raw.replace(/[^\w]/g, "").slice(0, 40) || "Error";
  const label = String(scope || "storage").replace(/[^\w ]/g, "").slice(0, 40) || "storage";
  const log = globalThis.console?.warn;
  if (typeof log !== "function") return;
  log.call(globalThis.console, `${label} storage failed (${name})`);
}

/**
 * Chrome reports quota and other storage failures as a rejected promise.
 * A sync try/catch does not see that rejection. On failure the stale chrome
 * value is removed so the next read uses the localStorage write from this call.
 * A promise that never settles is left alone: it may still land.
 */
function commitViewerLocal(scope, values) {
  const local = globalThis.chrome?.storage?.local;
  const set = local?.set;
  if (typeof set !== "function") return;
  let pending;
  try {
    pending = set.call(local, values);
  } catch (err) {
    warnViewerStorage(scope, err);
    return;
  }
  if (!pending || typeof pending.catch !== "function") return;
  pending.catch((err) => {
    warnViewerStorage(scope, err);
    const remove = local?.remove;
    if (typeof remove !== "function") return;
    let dropped;
    try {
      dropped = remove.call(local, Object.keys(values));
    } catch (removeErr) {
      warnViewerStorage(scope, removeErr);
      return;
    }
    if (dropped && typeof dropped.catch === "function") {
      dropped.catch((removeErr) => warnViewerStorage(scope, removeErr));
    }
  });
}

/**
 * Interrupt points: local missing; get throws; bag undefined or not an object;
 * stored position malformed; localStorage missing or unreadable.
 * A throw logs the error name only. This read does not write either store.
 */
async function readZoomChipPos() {
  try {
    const local = globalThis.chrome?.storage?.local;
    const get = local?.get;
    if (typeof get === "function") {
      const bag = await get.call(local, ZOOM_CHIP_STORAGE_KEY);
      const stored = normalizeZoomChipPos(bag?.[ZOOM_CHIP_STORAGE_KEY]);
      if (stored) return stored;
    }
  } catch (err) {
    warnViewerStorage("zoom chip", err);
  }
  try {
    return normalizeZoomChipPos(JSON.parse(localStorage.getItem(ZOOM_CHIP_STORAGE_KEY)));
  } catch (err) {
    warnViewerStorage("zoom chip", err);
    return null;
  }
}

/**
 * Interrupt points: position rejected before any write; localStorage set throws;
 * chrome set rejects after the local write; chrome set never settles.
 * A rejection logs the error name only and drops that chrome key. The next
 * read then uses localStorage. Only pdfZoomChipPos is written.
 */
function persistZoomChipPos(pos) {
  const payload = normalizeZoomChipPos(pos);
  if (!payload) return;
  zoomChipCustom = true;
  try {
    localStorage.setItem(ZOOM_CHIP_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    warnViewerStorage("zoom chip", err);
  }
  commitViewerLocal("zoom chip", { [ZOOM_CHIP_STORAGE_KEY]: payload });
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

/**
 * Interrupt points: local missing; get throws; bag undefined or malformed;
 * localStorage missing or unreadable. A throw logs the error name only.
 * This read does not write either store.
 */
async function readMirrorZoomChipPos() {
  try {
    const local = globalThis.chrome?.storage?.local;
    const get = local?.get;
    if (typeof get === "function") {
      const bag = await get.call(local, MIRROR_ZOOM_CHIP_POS_KEY);
      const stored = normalizeZoomChipPos(bag?.[MIRROR_ZOOM_CHIP_POS_KEY]);
      if (stored) return stored;
    }
  } catch (err) {
    warnViewerStorage("mirror zoom chip", err);
  }
  try {
    return normalizeZoomChipPos(JSON.parse(localStorage.getItem(MIRROR_ZOOM_CHIP_POS_KEY)));
  } catch (err) {
    warnViewerStorage("mirror zoom chip", err);
    return null;
  }
}

/**
 * Interrupt points: position rejected before any write; localStorage set throws;
 * chrome set rejects after the local write; chrome set never settles.
 * A rejection logs the error name only and drops that chrome key.
 * Only pdfMirrorZoomChipPos is written.
 */
function persistMirrorZoomChipPos(pos) {
  const payload = normalizeZoomChipPos(pos);
  if (!payload) return;
  mirrorZoomChipCustom = true;
  try {
    localStorage.setItem(MIRROR_ZOOM_CHIP_POS_KEY, JSON.stringify(payload));
  } catch (err) {
    warnViewerStorage("mirror zoom chip", err);
  }
  commitViewerLocal("mirror zoom chip", { [MIRROR_ZOOM_CHIP_POS_KEY]: payload });
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

/**
 * Interrupt points: local missing; get throws; bag undefined; key absent;
 * localStorage empty or unreadable. A throw logs the error name only.
 * This read does not write either store.
 */
async function readMirrorZoom() {
  try {
    const local = globalThis.chrome?.storage?.local;
    const get = local?.get;
    if (typeof get === "function") {
      const bag = await get.call(local, MIRROR_ZOOM_STORAGE_KEY);
      const stored = clampZoom(bag?.[MIRROR_ZOOM_STORAGE_KEY]);
      if (bag?.[MIRROR_ZOOM_STORAGE_KEY] != null && stored) return stored;
    }
  } catch (err) {
    warnViewerStorage("mirror zoom", err);
  }
  try {
    const raw = localStorage.getItem(MIRROR_ZOOM_STORAGE_KEY);
    if (raw == null || raw === "") return null;
    return clampZoom(raw);
  } catch (err) {
    warnViewerStorage("mirror zoom", err);
    return null;
  }
}

/**
 * Interrupt points: localStorage set throws; chrome set rejects after the
 * local write; chrome set never settles. A rejection logs the error name
 * only and drops that chrome key. Only pdfMirrorZoom is written.
 */
function persistMirrorZoom(scale) {
  const next = clampZoom(scale);
  try {
    localStorage.setItem(MIRROR_ZOOM_STORAGE_KEY, String(next));
  } catch (err) {
    warnViewerStorage("mirror zoom", err);
  }
  commitViewerLocal("mirror zoom", { [MIRROR_ZOOM_STORAGE_KEY]: next });
}

function layoutKey(page) {
  return pageCacheKey(docId, page);
}

function getPageLayout(page) {
  return layoutCache.get(layoutKey(page)) || null;
}

function reanchorLaidPage(page) {
  refreshNoteAnchors(page, "layout");
}

function reanchorTranslatedPage(page) {
  refreshNoteAnchors(page, "retranslate");
}

function notePagesAround(center) {
  const pages = [];
  for (const n of [center - 1, center, center + 1]) {
    if (n < 1) continue;
    const layout = getPageLayout(n);
    if (!layout?.blocks?.length) continue;
    const rows = pageCache.get(docId, n) || (n === pageNum ? pageResults : null) || [];
    pages.push({ page: n, blocks: blocksForNotes(applyBlockTranslations(layout.blocks, rows)) });
  }
  return pages;
}

function noteLibrarySaveError(error) {
  if (!error) return null;
  if (isStorageBlocked(error)) {
    libraryChip?.block(error);
    notesUi?.setStorageState?.({
      blocked: true,
      cause: storageFailureCause(error),
      since: storageFailureSince(error)
    });
    return null;
  }
  if (error?.type === "quota") {
    libraryChip?.writeFailed(error);
    return null;
  }
  return error;
}

async function persistHiddenThisSession() {
  try {
    return await persistCardHiddenThisSession(globalThis.chrome?.storage?.session);
  } catch {
    return false;
  }
}

function flushStagedNotes(hash, options = {}) {
  if (!hash || hash === "nohash" || !pendingNotes) return Promise.resolve(0);
  const job = pendingNotes.flush(hash, (item) => sharedNotesStore().put(item), { allTabs: true });
  // The chip must see a blocked flush and stay on 暂时存不了. Opening
  // the paper only tries; a failure leaves the staged rows for the next time.
  if (options.quiet) return job.catch(() => 0);
  return job;
}

async function maybeShowPersistCard() {
  if (!persistCard || persistCard.isOpen()) return;
  if (await persistHiddenThisSession()) return;
  let decision = { show: false };
  try {
    // Pass the area, not a detached get. Chrome throws Illegal invocation
    // when storage.local.get is called without its receiver, and the card
    // then never opens.
    decision = await readPersistCardState(globalThis.chrome?.storage?.local, notesDocHashNow());
  } catch {
    decision = { show: false };
  }
  if (decision.show) persistCard.show();
}

function installLibraryChrome() {
  const slot = document.getElementById("oiLibSlot");
  const cardHost = document.createElement("div");
  cardHost.id = "oiPersistSlot";
  document.body.append(cardHost);
  pendingNotes = pendingNotes || createPendingNotes({
    storage: chromeSessionArea() || undefined,
    tabId: () => globalThis.__oiReaderTabId || "tab"
  });
  try {
    globalThis.chrome?.tabs?.getCurrent?.((tab) => {
      if (tab?.id != null) globalThis.__oiReaderTabId = String(tab.id);
      pendingNotes?.holdLive?.();
    });
  } catch {
    /* opened outside the extension */
  }
  libraryChip = createLibraryChip({
    host: slot,
    openStorage: async () => {
      const { sharedLibraryStore } = await import("../lib/library-session.js");
      return sharedLibraryStore().retryOpen();
    },
    flushNotes: () => flushStagedNotes(notesDocHashNow()),
    flushPages: () => flushPendingPages(),
    onRecovered() {
      notesUi?.setStorageState?.(null);
      void maybeShowPersistCard();
    },
    onImportCommand(command) {
      return importBinding?.command(command);
    }
  });
  void import("../lib/library-session.js").then(({ sharedLibraryStore }) => {
    importBinding = bindImportChip(libraryChip, {
      store: sharedLibraryStore(),
      openData({ focus }) {
        const url = globalThis.chrome?.runtime?.getURL?.("options/options.html");
        if (url) globalThis.chrome?.tabs?.create?.({ url: `${url}#data?focus=${focus || "import"}` });
      }
    });
  }).catch(() => {
    importBinding = null;
  });
  persistCard = createPersistCard({
    host: cardHost,
    onDismiss: () => {
      globalThis.chrome?.storage?.local?.set?.({ [LIBRARY_PERSIST_HINT_KEY]: true });
    },
    onHideSession: () => {
      globalThis.chrome?.storage?.session?.set?.({ [PERSIST_CARD_SESSION_KEY]: true });
    },
    onExport: () => {
      const url = globalThis.chrome?.runtime?.getURL?.("options/options.html");
      if (url) globalThis.chrome?.tabs?.create?.({ url: `${url}#data?focus=export` });
    }
  });
  setLibraryUiHooks({
    onMoveStart() { libraryChip?.startMove({ holds: true }); },
    onMoveEnd() { libraryChip?.finishMove(); },
    onStorageBlocked(error) {
      libraryChip?.block(error);
      notesUi?.setStorageState?.({
        blocked: true,
        cause: storageFailureCause(error),
        since: storageFailureSince(error)
      });
    },
    onWriteFailed(error) { libraryChip?.writeFailed(error); },
    onLibraryPageSaved() { void maybeShowPersistCard(); }
  });
  pendingUnload = bindPendingUnload(() => pendingNotes?.pendingNow?.(notesDocHashNow()) || 0);
  void maybeShowPersistCard();
}

/**
 * Interrupt points: local missing; get throws; bag undefined; key absent;
 * stored true or false. A throw logs the error name only and returns false.
 * This read does not write.
 */
async function readStoredPersistDenied() {
  try {
    const local = globalThis.chrome?.storage?.local;
    const get = local?.get;
    if (typeof get !== "function") return false;
    const bag = await get.call(local, "notesPersistGranted");
    if (!bag || !Object.prototype.hasOwnProperty.call(bag, "notesPersistGranted")) return false;
    return recordedPersistDenied(null, bag.notesPersistGranted);
  } catch (err) {
    warnViewerStorage("notes persist", err);
    return false;
  }
}

function installNotesUi() {
  pendingNotes = pendingNotes || createPendingNotes({
    storage: chromeSessionArea() || undefined,
    tabId: () => globalThis.__oiReaderTabId || "tab"
  });
  notesUi = mountNotesUi({
    hasDoc: () => Boolean(pdfDoc),
    docHash: () => notesDocHashNow(),
    docTitle: () => $("docTitle")?.title || $("docTitle")?.textContent || "笔记",
    list: (hash) => sharedNotesStore().list(hash),
    listTrash: (hash) => sharedNotesStore().listTrash(hash),
    put: async (input) => {
      try {
        const saved = await sharedNotesStore().put(input);
        void maybeShowPersistCard();
        return saved;
      } catch (error) {
        if (isStorageBlocked(error)) libraryChip?.block(error);
        throw error;
      }
    },
    stageNote: (input) => pendingNotes?.stage(notesDocHashNow(), input),
    onStorageBlocked: (error) => libraryChip?.block(error),
    sharedPersistCard: true,
    softDelete: (id) => sharedNotesStore().softDelete(id),
    restore: (id) => sharedNotesStore().restore(id),
    purge: (id) => sharedNotesStore().purge(id),
    exportDoc: (hash) => sharedNotesStore().exportDoc(hash),
    exportMarkdown: (bundle) => exportMarkdown(bundle),
    importBundle: (bundle) => sharedNotesStore().import(bundle, { mode: "merge" }),
    subscribe: (cb) => sharedNotesStore().subscribe(cb),
    download: (filename, blob) => downloadBlob(filename, blob),
    readPrefs: () => readNotesPanelPrefs(),
    persistDismissed: (hash) => persistHintDismissed(readNotesPanelPrefs(), hash),
    // The panel waits on this before showing the refusal banner. It is the
    // same loadDocHint call the reader started for the open document.
    loadDocHint: (hash) => notesPrefsSession.loadDocHint(hash),
    dismissPersist: (hash) => {
      const next = dismissPersistHint(readNotesPanelPrefs(), hash);
      writeNotesPanelPrefs(next);
    },
    persistDenied: async () => {
      // persist() runs on the user's put, not when the panel opens and not
      // when a background re-anchor writes. A later open reads the recorded
      // refusal and does not ask the browser again.
      const store = sharedNotesStore();
      const record = store.persistRecord || store.memory?.persistRecord || null;
      if (record && Object.prototype.hasOwnProperty.call(record, "notesPersistGranted")) {
        return recordedPersistDenied(record, undefined);
      }
      return readStoredPersistDenied();
    },
    flow: () => readerFlowEl(),
    pane: () => translateScrollRoot(),
    pointerFine: () => window.matchMedia?.("(pointer: fine)")?.matches !== false,
    currentParagraph: () => currentNoteParagraph(),
    anchorForParagraph: (current) => anchorForParagraph(current),
    blockOrder: () => noteBlockOrder(),
    jumpPage: (page) => jumpToNotePage(page),
    jumpAnchor: (note) => jumpToNoteAnchor(note),
    onOpenChange: (open, meta) => {
      if (open) {
        if (askUi?.isOpen()) askUi.close({ handoff: true, focus: false });
        if (libraryUi?.isOpen()) libraryUi.close(false, { handoff: true, focus: false });
        syncNotesChrome({ opening: true });
      } else if (meta?.handoff || sideChromeOn()) {
        /* Ask still holds the shared column. */
      } else closeNotesChrome();
    },
    setNotesPaneSide: (side) => setNotesPaneSide(side)
  });
}

function sideChromeOn(workspace = document.querySelector(".workspace")) {
  return workspace?.dataset.notesOpen === "true" || workspace?.dataset.askOpen === "true" || workspace?.dataset.libraryOpen === "true";
}

function onLibraryOpenChange(open, meta) {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  if (open) {
    workspace.dataset.libraryOpen = "true";
    const slot = document.getElementById("sideSlot");
    if (slot) {
      slot.hidden = false;
      slot.dataset.open = "true";
      slot.setAttribute("aria-hidden", "false");
    }
    if (notesUi?.isOpen()) notesUi.close(false, { handoff: true });
    if (askUi?.isOpen()) askUi.close({ handoff: true, focus: false });
    syncNotesChrome({ opening: true });
    return;
  }
  delete workspace.dataset.libraryOpen;
  if (meta?.handoff || workspace.dataset.notesOpen === "true" || workspace.dataset.askOpen === "true") return;
  closeNotesChrome();
  const slot = document.getElementById("sideSlot");
  if (slot && workspace.dataset.notesOpen !== "true" && workspace.dataset.askOpen !== "true") {
    slot.hidden = true;
    delete slot.dataset.open;
    slot.setAttribute("aria-hidden", "true");
  }
}

function installLibraryUi() {
  libraryUi = mountLibraryUi({
    store: async () => {
      const { sharedLibraryStore } = await import("../lib/library-session.js");
      return sharedLibraryStore();
    },
    listNotes: (hash) => sharedNotesStore().list(hash),
    openHash: async () => {
      const hash = libraryDoc?.hash || notesDocHash || await pdfByteHash();
      return hash && hash !== "nohash" ? hash : "";
    },
    openBytes: (bytes, title) => openPdfData(bytes, title || ""),
    pickPdf: () => $("file")?.click(),
    toast: (text) => showToast(text),
    onOpenChange: (open, meta) => onLibraryOpenChange(open, meta),
    hash: () => location.hash,
    width: () => window.innerWidth,
    delay: async () => {
      const ms = Number(globalThis.__oiLibraryDelay) || 0;
      if (ms > 0) await new Promise((done) => setTimeout(done, ms));
    }
  });
  void import("../lib/library-session.js").then(({ sharedLibraryStore: openStore }) => {
    openStore().subscribe((event) => {
      if (event?.collection === "papers") libraryUi?.refresh?.();
    });
  }).catch(() => {});
}

function installAskUi() {
  askUi = mountAskUi({
    hasDoc: () => Boolean(pdfDoc),
    width: () => readerWidth(),
    flow: () => readerFlowEl(),
    blocks: () => askBlocks(),
    currentCitation: () => citationFromCurrent(),
    docHash: () => notesDocHashNow(),
    readRoute: () => readAskRoute(),
    readConfirm: () => readAskConfirm(),
    writeConfirm: (value) => writeAskConfirm(value),
    send: (req) => sendAsk(req),
    saveNote: async (input, options) => {
      if (options?.signal?.aborted) return null;
      const saved = await sharedNotesStore().put(input);
      if (options?.signal?.aborted) return null;
      return saved;
    },
    listNotes: () => sharedNotesStore().list(notesDocHashNow()),
    anchorFor: (citation) => anchorForAsk(citation),
    revealNote: (id) => notesUi?.revealNote?.(id),
    showSource: (citation) => showAskSource(citation),
    openSettings: (href) => openAskSettings(href),
    toast: (text) => showToast(text),
    writeText: (text) => navigator.clipboard?.writeText?.(text),
    onOpenChange: (open, meta) => onAskOpenChange(open, meta)
  });
}

function onAskOpenChange(open, meta) {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  if (open) {
    workspace.dataset.askOpen = "true";
    const slot = document.getElementById("sideSlot");
    if (slot) {
      slot.hidden = false;
      slot.dataset.open = "true";
      slot.setAttribute("aria-hidden", "false");
    }
    if (notesUi?.isOpen()) notesUi.close(false, { handoff: true });
    if (libraryUi?.isOpen()) libraryUi.close(false, { handoff: true, focus: false });
    const opening = workspace.dataset.layout !== "3" && workspace.dataset.layout !== "pair";
    syncNotesChrome({ opening });
    return;
  }
  delete workspace.dataset.askOpen;
  if (meta?.handoff || workspace.dataset.notesOpen === "true") return;
  closeNotesChrome();
  const slot = document.getElementById("sideSlot");
  if (slot && workspace.dataset.notesOpen !== "true") {
    slot.hidden = true;
    delete slot.dataset.open;
    slot.setAttribute("aria-hidden", "true");
  }
}

async function readAskRoute() {
  let settings = {};
  try {
    const res = await runtimeSend({ type: "OI_GET_SETTINGS" });
    settings = res?.settings || {};
  } catch {
    settings = {};
  }
  const target = askTarget(settings, formulaViewerSettings);
  const apiKey = target?.via === "multimodal"
    ? String(formulaViewerSettings?.multimodal?.apiKey || "")
    : String(settings?.providers?.[target?.provider]?.apiKey || "");
  return { settings, target, apiKey };
}

function readAskConfirm() {
  return readStoredAskConfirm(globalThis.chrome?.storage, ASK_CONFIRM_KEY);
}

function writeAskConfirm(value) {
  return writeStoredAskConfirm(globalThis.chrome?.storage, ASK_CONFIRM_KEY, value);
}

async function sendAsk(req) {
  return performAsk({
    target: req,
    messages: req.messages,
    apiKey: req.apiKey,
    signal: req.signal,
    fetchImpl: async (url, init) => {
      const result = await currentNet().fetch({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
        purpose: "ask",
        timeoutMs: false,
        retry: false,
        cache: false,
        dedupeKey: false,
        responseType: "json"
      });
      return {
        ok: result.ok,
        status: result.status,
        async json() { return result.data; }
      };
    }
  });
}

function askBlocks() {
  const flow = readerFlowEl();
  if (!flow) return [];
  return [...flow.querySelectorAll(".rf-block[data-bid]")].map((el) => ({
    bid: el.dataset.bid,
    page: Number(el.dataset.srcPage) || Number(el.dataset.page) || 0,
    text: el.querySelector(".rf-zh")?.textContent || "",
    label: el.dataset.label || ""
  }));
}

function formulaCropSrc(el) {
  const img = el?.querySelector?.("img");
  const src = String(img?.getAttribute?.("src") || "");
  return /^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/i.test(src) ? src.trim() : "";
}

function citationFromElement(el, text) {
  if (!el) return null;
  const page = Number(el.dataset.srcPage) || Number(el.dataset.page) || 0;
  const kind = el.dataset.label === "formula" ? "formula" : "text";
  const image = kind === "formula" ? formulaCropSrc(el) : "";
  return {
    bid: el.dataset.bid || "",
    page,
    text: text || el.querySelector(".rf-zh")?.textContent || "",
    kind,
    section: el.dataset.section || "",
    ...(image ? { image } : {})
  };
}

function citationFromCurrent() {
  const current = currentNoteParagraph();
  if (!current?.el) return null;
  return citationFromElement(current.el, current.translation);
}

function citationFromSel(ctx) {
  const bid = ctx?.bids?.[0] || "";
  const el = bid ? readerFlowEl()?.querySelector(`.rf-block[data-bid="${cssEscape(bid)}"]`) : null;
  return citationFromElement(el, ctx?.text || "") || {
    bid,
    page: Number(ctx?.srcPage) || 0,
    text: ctx?.text || "",
    kind: "text",
    section: ""
  };
}

function anchorForAsk(citation) {
  if (!citation?.bid) return null;
  const current = {
    bid: citation.bid,
    page: citation.page || 0,
    translation: citation.text || "",
    preview: firstLineQuote(citation.text || "")
  };
  return anchorForParagraph(current);
}

function showAskSource(citation) {
  const pane = translateScrollRoot();
  const before = pane?.scrollTop;
  const el = citation?.bid ? readerFlowEl()?.querySelector(`.rf-block[data-bid="${cssEscape(citation.bid)}"]`) : null;
  if (!el) return;
  if (el.dataset.pairId) {
    dismissSeeSource();
    currentPairId = el.dataset.pairId;
    jumpPairId = "";
    paintPairChrome();
  }
  const presented = presentSourceForJump(el);
  const run = () => {
    const rect = decodeSrcRects(el.dataset.srcRects)[0];
    if (rect) scrollSourceToRect(rect);
    else {
      const page = Number(el.dataset.page || el.dataset.srcPage);
      if (page >= 1) revealSourcePage(page);
    }
    if (pane && Number.isFinite(before)) pane.scrollTop = before;
  };
  if (presented === "ready") run();
  else requestAnimationFrame(() => requestAnimationFrame(run));
}

function openAskSettings(href) {
  const path = String(href || "options/options.html#mm");
  const url = globalThis.chrome?.runtime?.getURL?.(path.replace(/^\//, ""));
  if (url && globalThis.chrome?.tabs?.create) {
    globalThis.chrome.tabs.create({ url });
    return;
  }
  window.open(url || path);
}

function askFromKey() {
  if (!pdfDoc || !askUi) return;
  const ctx = readSelContext();
  if (ctx) {
    closeSelToolbar({ restore: false });
    void askUi.askCitation(citationFromSel(ctx), { fresh: true });
    return;
  }
  void askUi.askCitation(citationFromCurrent(), { fresh: true });
}

function currentNoteParagraph() {
  const flow = readerFlowEl();
  if (!flow) return null;
  const el = flow.querySelector(".rf-block.is-pair-current[data-bid]")
    || (currentPairId && flow.querySelector(`.rf-block[data-pair-id="${cssEscape(currentPairId)}"]`));
  if (!el?.dataset?.bid) return null;
  const page = Number(el.dataset.srcPage) || Number(el.dataset.page) || 0;
  const translation = el.querySelector(".rf-zh")?.textContent || "";
  return {
    el,
    bid: el.dataset.bid,
    page,
    translation,
    preview: firstLineQuote(translation),
    pairId: el.dataset.pairId || ""
  };
}

function anchorForParagraph(current) {
  const page = current?.page || 0;
  const block = (getPageLayout(page)?.blocks || []).find((item) => String(item.bid || "") === current.bid)
    || { bid: current.bid, id: current.bid, sourceText: "", page };
  const translation = current.translation || "";
  const preview = current.preview || firstLineQuote(translation);
  const end = preview ? Math.max(preview.length, translation.indexOf(preview) + preview.length) : 0;
  return createBlockAnchor({
    docHash: notesDocHashNow(),
    block,
    page,
    translation,
    layoutRev: knownLayoutVersion || "",
    start: 0,
    end
  });
}

function noteBlockOrder() {
  const order = new Map();
  const flow = readerFlowEl();
  if (!flow) return order;
  [...flow.querySelectorAll(".rf-block[data-bid]")].forEach((el, index) => {
    if (el.dataset.bid) order.set(el.dataset.bid, index);
  });
  return order;
}

function jumpToNotePage(page) {
  const n = Number(page);
  if (!(n >= 1)) return;
  const pane = translateScrollRoot();
  const flow = readerFlowEl();
  const node = flow?.querySelector(`.rf-block[data-src-page="${n}"]`)
    || flow?.querySelector(`.rf-page[data-page="${n}"]`);
  if (node && pane) {
    const top = node.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTop = Math.max(0, top - pane.clientHeight / 3);
  }
  revealSourcePage(n);
}

function jumpToNoteAnchor(note) {
  const bid = note?.anchor?.bid || "";
  const flow = readerFlowEl();
  const el = bid ? flow?.querySelector(`.rf-block[data-bid="${cssEscape(bid)}"]`) : null;
  if (!el) {
    jumpToNotePage(note?.page);
    return;
  }
  const pane = translateScrollRoot();
  if (pane) {
    const top = el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTop = Math.max(0, top - pane.clientHeight / 3);
  }
  if (!el.dataset.pairId) {
    jumpToNotePage(note?.page);
    return;
  }
  // Keep the current-block pair bar and scroll the source. Do not set
  // jumpPairId, so the paragraph gets no pair outline and no jump pair-box.
  dismissSeeSource();
  currentPairId = el.dataset.pairId;
  jumpPairId = "";
  jumpPart = "";
  paintPairChrome();
  const presented = presentSourceForJump(el);
  const run = () => {
    const rect = decodeSrcRects(el.dataset.srcRects)[0];
    const before = translateScrollRoot()?.scrollTop;
    if (rect) scrollSourceToRect(rect);
    else {
      const page = Number(el.dataset.page || el.dataset.srcPage);
      if (page >= 1) revealSourcePage(page);
    }
    if (translateScrollRoot() && Number.isFinite(before)) translateScrollRoot().scrollTop = before;
    applyFollow({ type: "clickJump" });
    armJumpLock();
    paintPairChrome();
    syncSourcePopChrome(Number(el.dataset.page || el.dataset.srcPage), false);
  };
  if (presented === "ready") run();
  else requestAnimationFrame(() => requestAnimationFrame(run));
}

function notesFromSel(ctx, kind) {
  const payload = notePayloadFromSelection(ctx, kind);
  if (!payload) return;
  closeSelToolbar({ restore: false });
  void notesUi?.fromSelection(payload);
}

async function notesShortcut(kind) {
  if (!pdfDoc || !notesUi) return;
  const ctx = readSelContext();
  if (ctx) {
    notesFromSel(ctx, kind);
    return;
  }
  if (kind === "note") notesUi.composeCurrent();
}

async function notesQuestionShortcut() {
  if (!pdfDoc || !notesUi) return;
  const ctx = readSelContext();
  if (!ctx) return;
  notesFromSel(ctx, "question");
}

function notePayloadFromSelection(ctx, kind) {
  const bid = ctx?.bids?.[0] || "";
  if (!bid) return null;
  const el = readerFlowEl()?.querySelector(`.rf-block[data-bid="${cssEscape(bid)}"]`);
  const page = Number(el?.dataset?.srcPage) || Number(ctx.srcPage) || 0;
  const block = (getPageLayout(page)?.blocks || []).find((item) => String(item.bid || "") === bid)
    || { bid, id: bid, sourceText: "", page };
  const zh = el?.querySelector(".rf-zh");
  const translation = zh?.textContent || ctx.text || "";
  const offsets = zh && ctx.range ? textRangeOffsets(zh, ctx.range) : { start: 0, end: String(ctx.text || "").length };
  const built = createBlockAnchor({
    docHash: notesDocHashNow(),
    block,
    page,
    translation,
    layoutRev: knownLayoutVersion || "",
    start: offsets.start,
    end: offsets.end
  });
  return {
    kind,
    page,
    pairId: ctx.pairIds?.[0] || el?.dataset?.pairId || "",
    ...built
  };
}

function notesDocHashNow() {
  return libraryDoc?.hash || notesDocHash || "";
}

async function resolveNotesDocHash() {
  const hash = libraryDoc?.hash || notesDocHash || await pdfByteHash();
  if (hash && hash !== "nohash") notesDocHash = hash;
  return notesDocHash || hash;
}

/** oiAuto only. Inject a note whose exact bid cannot match, then re-anchor. */
function exposeNotesProbe() {
  if (!viewerUnderTest()) return;
  const bucket = globalThis.__oiNotes || (globalThis.__oiNotes = {});
  bucket.store = sharedNotesStore();
  bucket.reanchor = async (page, reason) => {
    const center = Number(page);
    if (!(center >= 1)) return null;
    const result = await reanchorOpenPage({
      docHash: notesDocHashNow(),
      page: center,
      pages: notePagesAround(center),
      reason: reason || "layout",
      layoutRev: knownLayoutVersion,
      resolveDocHash: resolveNotesDocHash
    });
    if (result) bucket.last = result;
    notesUi?.paint();
    return result;
  };
  bucket.injectDeadExact = (spec) => injectDeadExactNote(spec, {
    store: () => bucket.store,
    docHash: notesDocHashNow,
    resolveDocHash: resolveNotesDocHash,
    layoutRev: () => knownLayoutVersion || "probe",
    laidPages: () => Object.keys(globalThis.__oiLayouts || {}).map((key) => Number(key)).filter((n) => n >= 1),
    pagesFor: notePagesAround
  });
}

/** Layout or retranslate finished. Re-anchor this page ±1, then repaint marks. */
function refreshNoteAnchors(page, reason) {
  const center = Number(page);
  if (!(center >= 1)) return;
  const pages = notePagesAround(center);
  if (!pages.length) return;
  const underTest = viewerUnderTest();
  void reanchorOpenPage({
    docHash: notesDocHashNow(),
    page: center,
    pages,
    reason,
    layoutRev: knownLayoutVersion,
    resolveDocHash: resolveNotesDocHash
  }).then((result) => {
    if (!underTest) return;
    exposeNotesProbe();
    const bucket = globalThis.__oiNotes;
    if (!result || !bucket) return;
    bucket[center] = result;
    bucket.last = result;
  }).then(() => {
    notesUi?.paint();
  }).catch(() => {});
}

function setPageLayout(page, layout, { reanchor = true } = {}) {
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
  if (reanchor && layout?.blocks?.length) reanchorLaidPage(page);
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

// 只用于非回退链展示。回退链一律走 lib/formula-katex.js。F5 再决定复用或删除。
function renderFormulaNode(node, latex, display) {
  const katex = globalThis.katex;
  if (!katex?.render || !latex) {
    node.textContent = wrapLatexMarkdown(latex, display);
    return;
  }
  try {
    katex.render(latex, node, { ...KATEX_RENDER_OPTIONS, displayMode: Boolean(display) });
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

/** text-layer, local-ocr, or cloud-ocr already recorded on a layout. unknown stays unset. */
function engineModeOf(layout) {
  const mode = String(layout?.mode || "");
  return mode === "text-layer" || mode === "local-ocr" || mode === "cloud-ocr" ? mode : "";
}

/**
 * A layout the vendor produced on this open belongs to the current engine.
 * unknown is left alone. A transient fallback is left alone.
 */
function stampProducedEngine(layout, mode = pdfEngineMode()) {
  return stampSessionLayout(layout, mode);
}

/** Text-layer geometry, including the quick stand-in and the empty-key path. */
function stampTextLayerEngine(layout) {
  return stampSessionLayout(layout, "text-layer");
}

/**
 * The in-memory row libraryEntry reads. A known engine is tagged. A mode-less
 * or unknown layout, including a no-boxes fallback, replaces that unknown row
 * so a finished answer is not requested again.
 */
function rememberEngineLayout(page, layout) {
  if (!layout || !libraryDoc) return;
  const mode = engineModeOf(layout) || "unknown";
  if (!Array.isArray(libraryDoc.layoutRows)) libraryDoc.layoutRows = [];
  const protocol = String(layout?.protocol || "blocks-1");
  const version = String(layout?.layoutVersion || "");
  const row = {
    page: Number(page),
    mode,
    protocol,
    savedAt: Date.now(),
    layoutRev: version,
    layout: { ...layout, mode: layout.mode || mode }
  };
  const at = libraryDoc.layoutRows.findIndex((item) => (
    Number(item?.page) === Number(page) &&
    String(item?.mode || "") === mode &&
    String(item?.protocol || "blocks-1") === protocol
  ));
  if (at >= 0) libraryDoc.layoutRows[at] = { ...libraryDoc.layoutRows[at], ...row };
  else libraryDoc.layoutRows.push(row);
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
    // P-A whitelist: same-origin fixture JSON. A Net timeout default would change this read.
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
    // The stored bbox is already trimmed. Measuring it again walks the
    // pixel round trip and shifts about one edge in twenty by 1px.
    if (!Array.isArray(block.layoutBbox) && Array.isArray(block.bbox)) {
      block.layoutBbox = block.bbox.slice(0, 4);
    }
    const probe = { ...block, bbox: block.layoutBbox };
    const trimmed = formulaInkBbox(raster?.canvas, probe);
    if (probe.inkShare) block.inkShare = probe.inkShare;
    block.bbox = trimmed;
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
    readerFontPx: readerShownFont(),
    sourceBodyPt: Number(layout?.bodyItemHeight) > 0 ? Number(layout.bodyItemHeight) : READER_SOURCE_BODY_PT,
    columnPx: readerColumnPx()
  };
}

// pdf.js 4.10.38 continues a display render only on requestAnimationFrame.
// If no frame arrives, page.render() never settles and open / goPage stay
// there. The vendored build forces that flag off and continues each slice
// on a 4ms timer (pdf/vendor/pdf.min.mjs). A 0ms timer is always due, so
// a chain of slices runs before library probes and every other delayed
// timer. 4ms stays ordered with those delays without stretching a
// full-page raster past the reopen crop budget. RenderTask hides the
// internal task behind a private field, so
// this cannot be switched from here. window.requestAnimationFrame is not
// replaced.
// Only the sharp-crop page.render is recorded. A page canvas started while
// that crop is awaited must stay on its own task, or the next crop cancels
// the canvas.
let formulaCropRenderTask = null;

function renderPdfPage(page, params) {
  return page.render(params);
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
    const task = renderPdfPage(page, { canvasContext: context, viewport });
    formulaCropRenderTask = task;
    try {
      await task.promise;
    } finally {
      if (formulaCropRenderTask === task) formulaCropRenderTask = null;
    }
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

function arxivPaneHooks() {
  return {
    onJump: jumpFormulaFromUi,
    onCopy: (latex, button) => copyArxivLatex(latex, button),
    onMenu: (latex, event, node) => openArxivLatexMenu(latex, event, node),
    katex: globalThis.katex
  };
}

function arxivMemoryFor(query) {
  const memory = arxivAlignmentMemory;
  if (!memory) return null;
  const wantId = String(query?.id || "");
  if (wantId && memory.id && wantId !== memory.id) return null;
  const wantHash = String(query?.pdfSha256 || "");
  if (wantHash && memory.pdfSha256 && wantHash !== memory.pdfSha256) return null;
  return memory;
}

function arxivSourceUnitFor(block) {
  if (!block || block.label !== "formula") return "";
  const row = arxivSlotMap.get(String(block.id || ""));
  return row?.unitId ? String(row.unitId) : "";
}

function rememberArxivAlignment(alignment) {
  arxivAlignmentMemory = alignment || null;
  arxivSlotMap = alignment ? slotAssignments(alignment.formulas) : new Map();
  arxivSpliceByBlock = new Map();
  if (!alignment || !formulaArxivSourceEnabled()) return;
  for (const plan of inlineSplicePlans(alignment.formulas)) {
    const list = arxivSpliceByBlock.get(plan.blockId) || [];
    list.push(plan);
    arxivSpliceByBlock.set(plan.blockId, list);
  }
}

function resetArxivSession() {
  arxivJob += 1;
  arxivIdentity = null;
  arxivAlignmentMemory = null;
  arxivSlotMap = new Map();
  arxivSpliceByBlock = new Map();
  arxivPhase = "off";
  arxivFailReason = "";
  page1TextItems = null;
  page1Viewport = null;
  setFormulaArxivSourceEnabled(false);
  paintArxivChip();
}

function currentArxivId() {
  return detectArxivId({
    url: sourceUrl,
    page1Items: page1TextItems,
    page: page1Viewport
  });
}

function arxivColumnNarrow() {
  const flow = readerFlowEl();
  const width = flow?.clientWidth || 0;
  return width > 0 && width < 560;
}

function syncArxivColumn() {
  const flow = readerFlowEl();
  if (!flow) return;
  const narrow = arxivColumnNarrow();
  const prev = flow.dataset.oiNarrow === "1";
  flow.dataset.oiNarrow = narrow ? "1" : "0";
  if (prev !== narrow && arxivPhase === "ready") {
    paintArxivChip();
    scheduleToolbarSnap();
  }
  flow.querySelectorAll(".oi-pdf-math-row.is-katex .oi-pdf-math-scroll").forEach((scroll) => {
    markFormulaOverflow(scroll);
  });
  flow.querySelectorAll(".oi-pdf-inline-math.is-katex").forEach((node) => {
    node.classList.remove("is-overflowing");
  });
}

function arxivFormulaShown(node) {
  if (!node || node.closest?.("[hidden]")) return false;
  let el = node;
  while (el && el.nodeType === 1) {
    const view = el.ownerDocument?.defaultView;
    const style = view?.getComputedStyle?.(el);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    el = el.parentElement;
  }
  return true;
}

function arxivDomCounts() {
  const flow = readerFlowEl();
  if (!flow) return { display: 0, inline: 0 };
  return {
    display: [...flow.querySelectorAll(".oi-pdf-math-row.is-katex")].filter(arxivFormulaShown).length,
    inline: [...flow.querySelectorAll(".oi-pdf-inline-math.is-katex")].filter(arxivFormulaShown).length
  };
}

function paintArxivChip() {
  const chip = $("arxivSourceChip");
  if (!chip) return;
  const label = chip.querySelector(".oi-arxiv-label");
  const auto = chip.querySelector(".oi-arxiv-auto");
  const restore = chip.querySelector(".oi-arxiv-restore");
  const box = $("arxivSourceAuto");
  if (!arxivIdentity || arxivPhase === "off") {
    chip.hidden = true;
    closeArxivMenu();
    return;
  }
  chip.hidden = false;
  if (auto) auto.hidden = arxivPhase !== "offer";
  if (restore) restore.hidden = arxivPhase !== "skipped";
  if (box) box.checked = arxivPrefs.auto === true;
  if (arxivPhase === "skipped") {
    const model = chipModel({ phase: "skipped" });
    if (label) label.textContent = model.text;
    if (restore) restore.textContent = model.restore;
    chip.title = model.title;
    closeArxivMenu();
    scheduleToolbarSnap();
    return;
  }
  let text = "用 arXiv 源码";
  let title = "用 arXiv 源码";
  if (arxivPhase === "loading") {
    const model = chipModel({ phase: "loading" });
    text = model.text;
    title = model.title;
  } else if (arxivPhase === "failed") {
    const model = chipModel({ phase: "failed", reason: arxivFailReason });
    text = model.text;
    title = model.title;
  } else if (arxivPhase === "ready" || arxivPhase === "empty") {
    const model = chipModel({
      version: arxivIdentity.version,
      formulas: arxivAlignmentMemory?.formulas,
      shown: arxivDomCounts(),
      narrow: arxivColumnNarrow(),
      phase: "ready"
    });
    text = model.text;
    title = model.title;
  }
  if (label) label.textContent = text;
  chip.title = title;
  scheduleToolbarSnap();
}

function closeArxivMenu() {
  const menu = $("arxivSourceMenu");
  if (menu) menu.hidden = true;
}

function openArxivMenu() {
  const menu = $("arxivSourceMenu");
  const chip = $("arxivSourceChip");
  if (!menu || !chip) return;
  menu.hidden = false;
  const rect = chip.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.left)}px`;
}

let arxivPrefsLoaded = false;

async function loadArxivPrefs() {
  let fromStore = false;
  try {
    const store = globalThis.chrome?.storage?.local;
    if (store?.get) {
      const bag = await store.get([ARXIV_SOURCE_AUTO_KEY, ARXIV_SOURCE_SKIP_KEY, ARXIV_SOURCE_ON_KEY]);
      arxivPrefs = normalizeArxivPrefs(bag);
      fromStore = true;
    }
  } catch {
    /* local fallback */
  }
  if (!fromStore) {
    try {
      const raw = JSON.parse(localStorage.getItem("oi.arxivSourcePrefs") || "{}");
      arxivPrefs = normalizeArxivPrefs(raw);
    } catch {
      arxivPrefs = { auto: false, skip: [], on: [] };
    }
  }
  arxivPrefsLoaded = true;
  syncArxivOffer();
}

async function saveArxivPrefs() {
  const payload = { auto: arxivPrefs.auto === true, skip: arxivPrefs.skip || [], on: arxivPrefs.on || [] };
  try {
    const store = globalThis.chrome?.storage?.local;
    if (store?.set) {
      await store.set({
        [ARXIV_SOURCE_AUTO_KEY]: payload.auto,
        [ARXIV_SOURCE_SKIP_KEY]: payload.skip,
        [ARXIV_SOURCE_ON_KEY]: payload.on
      });
      return;
    }
  } catch {
    /* local fallback */
  }
  try {
    localStorage.setItem("oi.arxivSourcePrefs", JSON.stringify(payload));
  } catch {
    /* private mode */
  }
}

function syncArxivOffer() {
  if (!arxivPrefsLoaded) return;
  const found = currentArxivId();
  if (!found) {
    if (arxivPhase !== "off") resetArxivSession();
    return;
  }
  arxivIdentity = found;
  if (skippedId(arxivPrefs, found.id)) {
    setFormulaArxivSourceEnabled(false);
    if (arxivPhase !== "skipped") arxivPhase = "skipped";
    paintArxivChip();
    return;
  }
  if (arxivPhase === "off" || arxivPhase === "skipped") {
    if (arxivPrefs.auto === true || keptSourceId(arxivPrefs, found.id)) {
      startArxivSource();
      return;
    }
    arxivPhase = "offer";
  }
  paintArxivChip();
}

function bindArxivChip() {
  arxivPrefsReady = loadArxivPrefs();
  const chip = $("arxivSourceChip");
  const box = $("arxivSourceAuto");
  const skip = $("arxivSourceSkip");
  chip?.addEventListener("click", (event) => {
    if (event.target?.closest?.(".oi-arxiv-auto, .oi-arxiv-restore")) return;
    if (arxivPhase === "offer" || arxivPhase === "failed") startArxivSource();
    else if (arxivPhase === "ready" || arxivPhase === "empty") openArxivMenu();
  });
  box?.addEventListener("click", (event) => event.stopPropagation());
  box?.addEventListener("change", () => {
    arxivPrefs = { ...arxivPrefs, auto: box.checked === true };
    saveArxivPrefs();
    if (box.checked && (arxivPhase === "offer" || arxivPhase === "failed")) startArxivSource();
  });
  chip?.querySelector(".oi-arxiv-restore")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    restoreArxivForThisPaper();
  });
  skip?.addEventListener("click", () => {
    closeArxivMenu();
    skipArxivForThisPaper();
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.target?.closest?.("#arxivSourceChip, #arxivSourceMenu")) return;
    closeArxivMenu();
  });
}

function skipArxivForThisPaper() {
  const id = arxivIdentity?.id;
  if (id) {
    arxivPrefs = {
      ...arxivPrefs,
      skip: (arxivPrefs.skip || []).includes(id) ? arxivPrefs.skip : [...(arxivPrefs.skip || []), id],
      on: (arxivPrefs.on || []).filter((item) => item !== id)
    };
    saveArxivPrefs();
  }
  setFormulaArxivSourceEnabled(false);
  rememberArxivAlignment(null);
  arxivPhase = "skipped";
  restampArxivLayouts().then(() => {
    renderArticle();
    paintArxivChip();
  });
}

function restoreArxivForThisPaper() {
  const found = arxivIdentity || currentArxivId();
  if (!found?.id) return;
  const id = found.id;
  arxivPrefs = {
    ...arxivPrefs,
    skip: (arxivPrefs.skip || []).filter((item) => item !== id),
    on: (arxivPrefs.on || []).includes(id) ? arxivPrefs.on : [...(arxivPrefs.on || []), id]
  };
  arxivIdentity = found;
  arxivPhase = "off";
  saveArxivPrefs();
  startArxivSource();
}

async function startArxivSource() {
  const found = arxivIdentity || currentArxivId();
  if (!found || skippedId(arxivPrefs, found.id)) return;
  if (arxivPhase === "loading") return;
  arxivIdentity = found;
  const job = ++arxivJob;
  arxivPhase = "loading";
  arxivFailReason = "";
  paintArxivChip();
  const pdfSha256 = notesDocHashNow();
  let resolved = null;
  try {
    resolved = await resolveArxivSession({
      id: found.id,
      pdfVersion: found.version || "",
      pdfSha256,
      readAlignment: (query) => readCachedArxivAlignment(query),
      download: async () => {
        try {
          return await runtimeSend({
            type: "OI_ARXIV_SOURCE",
            id: found.id,
            version: found.version || "",
            userTriggered: true,
            pdfSha256
          });
        } catch {
          return { ok: false, reason: "offline" };
        }
      },
      prepare: async ({ files, id, version, pdfSha256: hash }) => {
        try {
          await ensureMissingLayouts();
        } catch {
          /* pages that fail to lay out stay on the crop path */
        }
        if (job !== arxivJob) return { ok: false, reason: "aborted" };
        let pages = [];
        try {
          pages = await collectAlignPages();
        } catch {
          pages = [];
        }
        if (job !== arxivJob) return { ok: false, reason: "aborted" };
        try {
          return prepareArxivAlignment({
            files,
            pages,
            katex: globalThis.katex,
            id,
            version,
            pdfSha256: hash
          });
        } catch {
          return { ok: false, reason: "no-main" };
        }
      }
    });
  } catch {
    resolved = { ok: false, reason: "offline" };
  }
  if (job !== arxivJob) return;
  if (!resolved?.ok) {
    arxivPhase = "failed";
    arxivFailReason = resolved?.reason || "offline";
    setFormulaArxivSourceEnabled(false);
    paintArxivChip();
    return;
  }
  rememberArxivAlignment(resolved.alignment);
  setFormulaArxivSourceEnabled(true);
  rememberArxivAlignment(resolved.alignment);
  if (!resolved.reused) {
    try {
      await runtimeSend({
        type: "OI_ARXIV_SOURCE",
        action: "save-alignment",
        id: found.id,
        version: found.version || "",
        pdfSha256,
        alignment: resolved.alignment
      });
    } catch {
      /* this session still uses the in-memory alignment */
    }
  }
  if (job !== arxivJob) return;
  try {
    await ensureMissingLayouts();
  } catch {
    /* pages that fail to lay out stay on the crop path */
  }
  if (job !== arxivJob) return;
  try {
    await restampArxivLayouts();
  } catch {
    /* a page that fails to restamp stays on the crop path */
  }
  if (job !== arxivJob) return;
  arxivPhase = "ready";
  if (viewerUnderTest()) {
    const tiers = new Map();
    for (let n = 1; n <= (pdfDoc?.numPages || 0); n += 1) {
      const blocks = getPageLayout(n)?.blocks || [];
      const formulas = blocks.filter((block) => block?.label === "formula");
      tiers.set(n, {
        blocks: blocks.length,
        formulas: formulas.length,
        arxiv: formulas.filter((block) => block?.formulaTier === "arxiv").length
      });
    }
    globalThis.__oiF5Align = {
      slotCount: arxivSlotMap.size,
      spliceBlocks: arxivSpliceByBlock.size,
      displays: (arxivAlignmentMemory?.formulas || []).filter((row) => row?.kind === "display").map((row) => ({
        page: row.page || 0,
        pass: row.pass === true,
        slot: String(row.slotId || ""),
        unit: String(row.unitId || "")
      })),
      pages: [...tiers.entries()].map(([page, row]) => ({ page, ...row }))
    };
  }
  for (let n = 1; n <= (pdfDoc?.numPages || 0); n += 1) clearSlotPainted(n);
  renderArticle();
  paintArxivChip();
}

async function ensureMissingLayouts() {
  const total = pdfDoc?.numPages || 0;
  for (let n = 1; n <= total; n += 1) {
    if (getPageLayout(n)?.blocks?.length) continue;
    try {
      await ingestTextLayerLayout(n, () => false);
    } catch {
      /* this page stays without a layout */
    }
  }
}

async function collectAlignPages() {
  const total = pdfDoc?.numPages || 0;
  const pages = [];
  for (let n = 1; n <= total; n += 1) {
    const page = await pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    if (n === 1) {
      page1TextItems = content.items;
      page1Viewport = viewport;
      syncArxivOffer();
    }
    const stored = getPageLayout(n)?.blocks;
    let blocks = stored?.length ? stored : null;
    if (!blocks) {
      let images = null;
      try {
        const ops = await page.getOperatorList();
        images = { fnArray: ops.fnArray, argsArray: ops.argsArray };
      } catch {
        images = null;
      }
      blocks = textLayerToBlocks({ items: content.items, viewport, images, page: n }).blocks;
    }
    pages.push({
      page: n,
      blocks,
      glyphs: pageGlyphsFromText(content.items, viewport)
    });
  }
  return pages;
}

async function restampArxivLayouts() {
  const epoch = layoutEpoch;
  const job = arxivJob;
  const total = pdfDoc?.numPages || 0;
  for (let n = 1; n <= total; n += 1) {
    if (!getPageLayout(n)) continue;
    try {
      await restampArxivPage(n, epoch, job);
    } catch {
      /* this page stays on the crop path */
    }
  }
}

function restampFormulaStale(pageNumber, epoch, job, layout) {
  return layout !== getPageLayout(pageNumber)
    || job !== arxivJob
    || !layoutAttemptLive(epoch);
}

async function restampArxivPage(pageNumber, epoch = layoutEpoch, job = arxivJob) {
  const layout = getPageLayout(pageNumber);
  if (!layout?.blocks) return;
  const flags = formulaChainFlags(formulaViewerSettings, { arxivEnabled: formulaArxivSourceEnabled() });
  const mmLedger = mmPageLedger(pageNumber);
  const next = [];
  for (const block of layout.blocks) {
    if (block?.label !== "formula") {
      next.push(block);
      continue;
    }
    const stamped = { ...block };
    const sourceUnitId = formulaArxivSourceEnabled() ? arxivSourceUnitFor(stamped) : "";
    if (sourceUnitId) stamped.sourceUnitId = sourceUnitId;
    else delete stamped.sourceUnitId;
    next.push(await scheduleFormulaBlock(stamped, {
      withRasterCrop: async (item) => item,
      cropPngFor: (block, hooks) => formulaModelPng(pageNumber, block, hooks),
      isStale: () => restampFormulaStale(pageNumber, epoch, job, layout),
      arxivEnabled: formulaArxivSourceEnabled(),
      multimodalEnabled: flags.multimodalEnabled,
      multimodalConfigured: flags.multimodalConfigured,
      ocrEnabled: flags.ocrEnabled,
      ocrConfigured: flags.ocrConfigured,
      placeholderEnabled: flags.placeholderEnabled,
      arxivId: arxivIdentity?.id || "",
      arxivVersion: arxivIdentity?.version || "",
      pdfVersion: formulaArxivSourceEnabled() ? (arxivIdentity?.version || "") : undefined,
      readAlignment: async () => arxivAlignmentMemory,
      docHash: notesDocHashNow(),
      page: pageNumber,
      katex: globalThis.katex,
      settings: formulaViewerSettings,
      readSettings: () => formulaViewerSettings,
      model: formulaViewerSettings?.multimodal?.model || "",
      mmLedger,
      cache: viewerFormulaCache()
    }));
  }
  publishRestampedBlocks(layout, next, restampFormulaStale(pageNumber, epoch, job, layout), () => {
    clearSlotPainted(pageNumber);
  });
}

async function copyArxivLatex(latex, button) {
  const writeText = async (text) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-1000px";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  };
  const ok = await flashCopiedLatex(button, latex, writeText);
  if (ok) showToast("已复制 LaTeX");
}

function openArxivLatexMenu(latex, event, node) {
  const rect = node?.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
  const root = translateScrollRoot();
  const rootBox = root?.getBoundingClientRect?.() || { left: 0, top: 0 };
  showSelToolbar({
    bids: [node?.dataset?.blockId || ""],
    pairIds: [],
    srcPage: Number(node?.dataset?.page) || 0,
    text: String(latex || ""),
    arxivLatex: String(latex || ""),
    anchor: {
      x: rect.left - rootBox.left,
      y: rect.top - rootBox.top,
      width: rect.width,
      height: rect.height
    },
    key: `latex::${latex || ""}`
  });
}

function captureFormulaBoxes(flow) {
  if (!flow) return [];
  const pane = translateScrollRoot();
  const view = pane?.getBoundingClientRect();
  return [...flow.querySelectorAll(".oi-pdf-math-row, .oi-pdf-inline-math")].map((el) => {
    const rect = el.getBoundingClientRect();
    const host = el.closest("[data-block-id]") || el;
    const inView = view ? rect.bottom > view.top + 1 && rect.top < view.bottom - 1 : false;
    return {
      id: host.dataset.blockId || el.dataset.blockId || "",
      height: rect.height,
      inView
    };
  }).filter((row) => row.id && row.height > 0);
}

function releaseFormulaHeightLock(row) {
  if (!row) return;
  row.style.minHeight = "";
  row.style.maxHeight = "";
  delete row.dataset.oiHeightLock;
}

function ensureFormulaLockRelease(flow) {
  if (!flow || flow.dataset.oiLockRelease === "1") return;
  flow.dataset.oiLockRelease = "1";
  const release = (event) => {
    const row = event.target?.closest?.("[data-oi-height-lock='1']");
    if (!row || !flow.contains(row)) return;
    releaseFormulaHeightLock(row);
  };
  flow.addEventListener("click", release);
  flow.addEventListener("focusin", release);
}

function lockFormulaHeights(flow, previous) {
  ensureFormulaLockRelease(flow);
  if (!flow || !previous?.length) return;
  for (const prev of previous) {
    if (!prev.inView) continue;
    const host = flow.querySelector(`[data-block-id="${cssEscape(prev.id)}"]`);
    if (!host) continue;
    const row = host.classList.contains("oi-pdf-math-row") || host.classList.contains("oi-pdf-inline-math")
      ? host
      : host.querySelector(".oi-pdf-math-row.is-katex, .oi-pdf-inline-math.is-katex");
    if (!row) continue;
    const next = row.getBoundingClientRect().height;
    if (!(next > 0) || Math.abs(next - prev.height) <= 2) continue;
    const px = `${Math.round(prev.height * 100) / 100}px`;
    row.style.minHeight = px;
    row.style.maxHeight = px;
    row.dataset.oiHeightLock = "1";
  }
}

function unlockOffscreenFormulaHeights() {
  const flow = readerFlowEl();
  const pane = translateScrollRoot();
  if (!flow || !pane) return;
  const view = pane.getBoundingClientRect();
  flow.querySelectorAll("[data-oi-height-lock='1']").forEach((row) => {
    const rect = row.getBoundingClientRect();
    const inView = rect.bottom > view.top + 1 && rect.top < view.bottom - 1;
    if (inView) return;
    releaseFormulaHeightLock(row);
  });
}

async function readCachedArxivAlignment(query) {
  const memory = arxivMemoryFor(query);
  if (memory) return memory;
  try {
    const res = await runtimeSend({
      type: "OI_ARXIV_SOURCE",
      action: "read-alignment",
      id: query?.id || "",
      version: query?.version || "",
      pdfSha256: query?.pdfSha256 || notesDocHashNow()
    });
    if (!res || res.ok === false) return null;
    return res;
  } catch {
    return null;
  }
}

// Page-raster PNG keyed by the stable bid. Display may later swap imageUrl
// for a zoom-dependent redraw; the model cache keeps this URL.
const formulaModelCrops = new Map();

function modelPngPayloadUrl(block) {
  const pixels = block?.crop?.pixels;
  if (typeof pixels !== "string" || !pixels) return "";
  if (/^https?:/i.test(pixels) || /^data:/i.test(pixels)) return "";
  return `data:image/png;base64,${pixels}`;
}

function formulaModelCropId(pageNumber, block) {
  const id = String(block?.bid || block?.id || "");
  if (!id) return "";
  return `${docId}:${pageNumber}:${id}`;
}

function rememberFormulaModelCrop(pageNumber, block) {
  const id = formulaModelCropId(pageNumber, block);
  if (!id || block?.label !== "formula" || !block.imageUrl) return;
  formulaModelCrops.set(id, block.imageUrl);
}

function formulaModelPng(pageNumber, block, hooks) {
  // The hash was taken from crop.pixels. A second lookup must not substitute
  // another bitmap, including the display redraw now sitting on imageUrl.
  const carried = modelPngPayloadUrl(block);
  if (carried) return cropPngFor({ ...block, imageUrl: carried }, hooks);
  const stable = formulaModelCrops.get(formulaModelCropId(pageNumber, block));
  return cropPngFor(stable ? { ...block, imageUrl: stable } : block, hooks);
}

async function formulaModelDisplayCrop(raster, page, item, pageNumber, options = {}) {
  const pageCrop = await withRasterCrop(raster, page, item, pageNumber, { ...options, sharp: false });
  rememberFormulaModelCrop(pageNumber, pageCrop);
  if (options.sharp === false || !pageCrop.imageUrl) return pageCrop;
  const sharp = await renderSharpVisualCrop(page, raster, pageCrop, pageNumber);
  if (!sharp) return pageCrop;
  return { ...pageCrop, imageUrl: sharp, surface: "redraw" };
}

async function cropLayoutBlocks(raster, page, blocks, pageNumber, isStale, options = {}) {
  // The PNG sent to the model is always the CROP_SCALE page raster.
  // Display keeps the pre-fix redraw. Reopen hydrate opts out, then refreshes
  // the screen without scheduling another formula request.
  try { await formulaSettingsReady; } catch { /* defaults stay off */ }
  const cropped = [];
  const arxivOn = formulaArxivSourceEnabled();
  const arxiv = arxivOn ? detectArxivId({
    url: sourceUrl,
    page1Items: page1TextItems,
    page: page1Viewport
  }) || arxivIdentity : null;
  const formulaFlags = formulaChainFlags(formulaViewerSettings, { arxivEnabled: arxivOn });
  const mmLedger = mmPageLedger(pageNumber);
  for (const block of blocks || []) {
    if (isStale()) return null;
    if (block?.label !== "formula") {
      cropped.push(await withRasterCrop(raster, page, block, pageNumber, options));
      continue;
    }
    const sourceUnitId = arxivOn ? arxivSourceUnitFor(block) : "";
    if (sourceUnitId) block.sourceUnitId = sourceUnitId;
    cropped.push(await scheduleFormulaBlock(block, {
      withRasterCrop: (item) => formulaModelDisplayCrop(raster, page, item, pageNumber, options),
      cropPngFor: (block, hooks) => formulaModelPng(pageNumber, block, hooks),
      isStale,
      signal: options.signal,
      arxivEnabled: arxivOn,
      multimodalEnabled: formulaFlags.multimodalEnabled,
      multimodalConfigured: formulaFlags.multimodalConfigured,
      ocrEnabled: formulaFlags.ocrEnabled,
      ocrConfigured: formulaFlags.ocrConfigured,
      placeholderEnabled: formulaFlags.placeholderEnabled,
      readCropImage: formulaFlags.placeholderEnabled ? readFormulaCropImage : undefined,
      arxivId: arxiv?.id || "",
      arxivVersion: arxiv?.version || "",
      pdfVersion: arxivOn ? (arxiv?.version || "") : undefined,
      readAlignment: readCachedArxivAlignment,
      docHash: notesDocHashNow(),
      page: pageNumber,
      katex: globalThis.katex,
      settings: formulaViewerSettings,
      readSettings: () => formulaViewerSettings,
      model: formulaViewerSettings?.multimodal?.model || "",
      mmLedger,
      cache: viewerFormulaCache()
    }));
  }
  return cropped;
}

function readFormulaCropImage(url) {
  return new Promise((resolve) => {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url || "")) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (!(width > 0) || !(height > 0)) {
        resolve(null);
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context || typeof context.getImageData !== "function") {
        resolve(null);
        return;
      }
      context.drawImage(img, 0, 0);
      let image = null;
      try {
        image = context.getImageData(0, 0, width, height);
      } catch {
        image = null;
      }
      canvas.width = 0;
      canvas.height = 0;
      resolve(image ? { image, pixelSize: { width, height } } : null);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function cropImage(block) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(block?.imageUrl || "")) return null;
  const img = document.createElement("img");
  img.alt = visualAlt(block.label);
  img.src = block.imageUrl;
  if (block?.surface === "redraw" || block?.surface === "png") {
    img.setAttribute("data-oi-surface", block.surface);
  }
  if (block?.formulaTier === "crop") img.setAttribute("data-oi-tier", "crop");
  applyReaderImageBlend(img);
  return img;
}

function formulaPageFraction(block) {
  if (!Array.isArray(block?.bbox) || block.bbox.length < 4) return null;
  const fraction = Number(block.bbox[2]) - Number(block.bbox[0]);
  if (!(fraction > 0) || !Number.isFinite(fraction)) return null;
  return Math.min(1, fraction);
}

/** Readability floor and inline line cap follow the size on screen, not the stored setting. */
function readerFormulaFloor(page) {
  const layout = getPageLayout(page);
  const bodyPt = Number(layout?.bodyItemHeight) > 0 ? Number(layout.bodyItemHeight) : READER_SOURCE_BODY_PT;
  return formulaReadabilityFloor(readerShownFont(), bodyPt);
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
    stampDisplayFormulaScale(row, matched, page);
  } else {
    const pageFraction = formulaPageFraction(block);
    const layout = getPageLayout(page);
    const width = pageFraction ? displayFormulaWidthCss(pageFraction, 0, {
      pageWidthPt: Number(layout?.pageWidth) || 0,
      floor: readerFormulaFloor(page)
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

function placeholderCssNumber(value) {
  return String(Math.round(Number(value) * 10000) / 10000);
}

function placeholderBoxLengths(block, inline) {
  const layout = getPageLayout(block?.page);
  const native = placeholderNativeBox({
    bbox: block?.bbox,
    pageWidth: Number(layout?.pageWidth) || 0,
    pageHeight: Number(layout?.pageHeight) || 0
  });
  const minW = inline ? 20 : 112;
  const minH = inline ? 16 : 32;
  const w = native?.w > 0 ? native.w : minW;
  const h = native?.h > 0 ? native.h : minH;
  return {
    w: placeholderCssLength(w),
    h: placeholderCssLength(h),
    wn: placeholderCssNumber(w),
    hn: placeholderCssNumber(h)
  };
}

function stampPlaceholderBox(node, lengths) {
  node.style.setProperty("--oi-ph-w", lengths.w);
  node.style.setProperty("--oi-ph-h", lengths.h);
  node.style.setProperty("--oi-ph-wn", lengths.wn);
  node.style.setProperty("--oi-ph-hn", lengths.hn);
}

function placeholderIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "oi-ph-icon");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3.2 8.8 L8.8 3.2 M5.2 3.2 H8.8 V6.8");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.4");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function jumpFormulaFromUi(button) {
  const jump = globalThis.__oiJumpFormula;
  if (typeof jump === "function") jump(button);
  else jumpFormulaPlaceholder(button);
}

function mountFormulaPlaceholder(parent, block, page, inline) {
  const shown = { ...block, page: page ?? block?.page };
  const copy = placeholderCopy(shown, { inline, kind: "formula" });
  const known = Number(shown.page) >= 1;
  const lengths = placeholderBoxLengths(shown, Boolean(inline));
  const button = document.createElement("button");
  button.type = "button";
  button.className = inline ? "oi-formula-placeholder is-inline" : "oi-formula-placeholder";
  button.dataset.oiTier = "placeholder";
  button.dataset.kind = "formula";
  if (block?.formulaReason) button.dataset.oiReason = String(block.formulaReason);
  const hasBbox = Array.isArray(block?.bbox) && block.bbox.length >= 4;
  button.dataset.oiBbox = hasBbox ? "1" : "0";
  if (known) button.dataset.page = String(Math.floor(Number(shown.page)));
  button.title = copy.aria;
  button.setAttribute("aria-label", copy.aria);
  const text = document.createElement("span");
  text.className = "oi-ph-text";
  text.setAttribute("aria-hidden", "true");
  ["l0", "l1", "l2"].forEach((level, index) => {
    const line = document.createElement("span");
    line.className = level;
    line.textContent = copy.visible[index] || "";
    text.append(line);
  });
  text.append(placeholderIcon());
  button.append(text);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    jumpFormulaFromUi(button);
  });
  if (inline) {
    stampPlaceholderBox(button, lengths);
    parent.append(button);
    return;
  }
  const row = document.createElement("div");
  row.className = "oi-formula-placeholder-row";
  stampPlaceholderBox(row, lengths);
  const reserve = document.createElement("span");
  reserve.className = "oi-formula-reserve";
  reserve.dataset.oiReserve = "f8";
  reserve.setAttribute("aria-hidden", "true");
  row.append(reserve, button);
  parent.append(row);
}

function jumpFormulaPlaceholder(button) {
  const page = Number(button.dataset.page);
  const hasBbox = button.dataset.oiBbox === "1";
  const host = button.closest?.("[data-pair-id]");
  const presented = presentSourceForJump(button);
  const run = () => {
    if (!hasBbox) {
      if (page >= 1) {
        revealSourcePage(page);
        if (button.dataset.oiTier === "arxiv") showToast(`已到第 ${page} 页`);
      } else if (host?.dataset?.pairId) jumpTranslationToSource(host);
      return;
    }
    if (host?.dataset?.pairId) jumpTranslationToSource(host);
    else if (page >= 1) revealSourcePage(page);
  };
  if (presented === "ready") run();
  else requestAnimationFrame(() => requestAnimationFrame(run));
}

function appendCropOrNotice(node, block, imageClass, page) {
  const shownPage = page ?? node.dataset.page;
  if (block?.label === "formula" && block.formulaTier === "placeholder") {
    mountFormulaPlaceholder(node, block, shownPage, false);
    return;
  }
  if (block?.label === "formula" && verifiedArxivFormula(block)) {
    const outcome = mountArxivDisplay(node, block, shownPage, arxivPaneHooks());
    if (outcome !== "katex-error") return;
    block = { ...block, formulaTier: "crop", formulaReason: "katex-error" };
  }
  const img = cropImage(block);
  if (img && block?.formulaReason === "katex-error") img.setAttribute("data-oi-reason", "katex-error");
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
      img.style.width = displayFormulaWidthCss(pageFraction, Number(block.bbox[3]) - Number(block.bbox[1]), {
        pageWidthPt: Number(layout?.pageWidth) || 0,
        floor: readerFormulaFloor(page ?? node.dataset.page)
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
  const view = pending ? { ...block, translation: "", failed: false } : block;
  const showingSource = !String(view.translation || "").trim();
  if (showingSource && formulaArxivSourceEnabled()) {
    const plans = arxivSpliceByBlock.get(String(block.id || "")) || [];
    const spliced = plans.length ? spliceInlinePieces(String(view.text || block.text || ""), plans) : null;
    if (spliced) {
      paintSplicedPieces(node, spliced, block, layout);
      return;
    }
  }
  const pieces = blockRenderPieces(view, layout.blocks || []);
  paintRenderPieces(node, pieces, view, layout);
}

function paintSplicedPieces(node, pieces, block, layout) {
  pieces.forEach((piece) => {
    if (piece.type === "math") {
      mountSplicedInline(node, piece, block, layout);
      return;
    }
    const text = String(piece.text || "");
    if (!text) return;
    if (/⟦f\d+⟧/.test(text)) {
      const sub = blockRenderPieces({ ...block, translation: "", failed: false, text }, layout.blocks || []);
      paintRenderPieces(node, sub, block, layout);
      return;
    }
    node.append(document.createTextNode(text));
  });
}

function mountSplicedInline(node, piece, block, layout) {
  const inlinePage = layout?.page ?? node.dataset.page ?? piece.page;
  const formula = {
    id: piece.unitId || "",
    latex: piece.latex,
    latexSource: "arxiv-src",
    verified: true,
    formulaTier: "arxiv",
    page: piece.page || inlinePage,
    eqLabel: piece.number || "",
    display: false
  };
  const span = document.createElement("span");
  if (inlinePage) span.dataset.page = String(inlinePage);
  span.dataset.label = "formula";
  const outcome = mountArxivInline(span, formula, inlinePage, arxivPaneHooks());
  if (outcome === "ok") {
    node.append(span);
    return;
  }
  const matched = (layout?.blocks || []).find((item) => {
    if (item?.label !== "formula") return false;
    const unit = String(piece.unitId || "");
    return unit && (String(item.sourceUnitId || "") === unit || String(item.id || "") === unit);
  });
  const failed = matched
    ? { ...matched, formulaReason: "katex-error" }
    : {
      ...formula,
      id: piece.unitId || formula.id,
      label: "formula",
      formulaTier: "placeholder",
      formulaReason: "katex-error"
    };
  mountInlineFormulaFallback(node, failed, inlinePage);
}

function mountInlineFormulaFallback(node, formula, page) {
  const shown = { ...formula, label: "formula", formulaReason: formula?.formulaReason || "katex-error" };
  const host = document.createElement("span");
  host.className = "oi-pdf-inline-math";
  if (page) host.dataset.page = String(page);
  if (shown.id) {
    host.dataset.blockId = String(shown.id);
    host.dataset.label = "formula";
  }
  if (failedInlineKind(shown) === "crop") {
    const img = cropImage({ ...shown, formulaTier: "crop" });
    host.tabIndex = 0;
    if (img) {
      img.className = "oi-pdf-math-crop";
      img.setAttribute("data-oi-reason", "katex-error");
      host.append(img);
    }
    node.append(host);
    return;
  }
  shown.formulaTier = "placeholder";
  mountFormulaPlaceholder(host, shown, page, true);
  node.append(host);
}

function paintRenderPieces(node, pieces, block, layout) {
  if (!pieces.length) {
    const pending = block?.failed === true && !String(block.translation || "").trim();
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
    const inlinePage = layout?.page ?? node.dataset.page;
    if (verifiedArxivFormula(formula)) {
      const span = document.createElement("span");
      if (formula.id) {
        span.dataset.blockId = String(formula.id);
        span.dataset.label = "formula";
        if (inlinePage) span.dataset.page = String(inlinePage);
      }
      const outcome = mountArxivInline(span, formula, inlinePage, arxivPaneHooks());
      if (outcome === "ok") {
        node.append(span);
        return;
      }
      if (outcome === "katex-error") formula.formulaReason = "katex-error";
    }
    if (formula?.formulaTier === "placeholder") {
      const span = document.createElement("span");
      span.className = "oi-pdf-inline-math";
      span.tabIndex = -1;
      if (formula.id) {
        span.dataset.blockId = String(formula.id);
        span.dataset.label = "formula";
        if (inlinePage) span.dataset.page = String(inlinePage);
      }
      mountFormulaPlaceholder(span, formula, inlinePage, true);
      node.append(span);
      return;
    }
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
      if (formula?.formulaReason === "katex-error") img.setAttribute("data-oi-reason", "katex-error");
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
  globalThis.__oiLibrarySourceSentHas = (hash) => librarySourceSent.has(String(hash || ""));
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
  globalThis.__oiSetPageCache = (page, rows) => {
    const n = Number(page);
    if (!(n >= 1)) return false;
    pageCache.set(docId, n, Array.isArray(rows) ? rows : []);
    return true;
  };
  globalThis.__oiSetLibraryPairs = (page, pairs) => {
    const pageNo = Number(page);
    if (!(pageNo >= 1)) return false;
    if (!libraryDoc) libraryDoc = { hash: docId, pages: [] };
    if (!Array.isArray(libraryDoc.pages)) libraryDoc.pages = [];
    let row = libraryDoc.pages.find((item) => Number(item.page) === pageNo);
    if (!row) {
      row = { page: pageNo, pairs: [] };
      libraryDoc.pages.push(row);
    }
    row.pairs = Array.isArray(pairs) ? pairs : [];
    return true;
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
  exposeNotesProbe();
  globalThis.__oiJumpFormula = jumpFormulaPlaceholder;
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
  const id = provider || pdfProvider;
  const model = String(settings?.model || settings?.providers?.[id]?.model || "").trim();
  if (model) pdfModel = model;
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
  const row = (libraryDoc?.pages || []).find((item) => Number(item.page) === Number(page)) || null;
  if (!row) return null;
  const layout = selectPageLayout(libraryDoc?.layoutRows, page, pdfEngineMode());
  if (!layout) return row;
  const view = { ...row, layout };
  if (!view.layoutVersion && layout.layoutVersion) view.layoutVersion = layout.layoutVersion;
  return view;
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
  const split = sourceSplitHandle(workspace);
  if (!workspace || !source || !translation || !split) return;
  if (workspace.dataset.layout === "3" || workspace.dataset.layout === "pair") return;
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
  // The notes splitter stays after the source splitter. Tests and the mini
  // drag path take the first .split-handle, which has to be the source one.
  const slot = workspace.querySelector("#sideSlot");
  const notesSplit = notesSplitHandle(workspace);
  if (slot?.parentElement === workspace) workspace.append(slot);
  if (notesSplit?.parentElement === workspace) workspace.append(notesSplit);
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
  $("menuNotes")?.addEventListener("click", () => {
    closeMoreMenu(true);
    notesUi?.toggle();
  });
  $("menuAsk")?.addEventListener("click", () => {
    closeMoreMenu(true);
    askUi?.toggle();
  });
  $("menuLibrary")?.addEventListener("click", () => {
    closeMoreMenu(true);
    libraryUi?.toggle({ trigger: $("menuLibrary") });
  });
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
  paintArxivChip();
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
  $("tocButton")?.addEventListener("click", () => {
    showSoonToast();
  });
  $("libraryButton")?.addEventListener("click", () => {
    libraryUi?.toggle({ trigger: $("libraryButton") });
  });
  $("askButton")?.addEventListener("click", () => askUi?.toggle());
  $("notesButton")?.addEventListener("click", () => notesUi?.toggle());
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
  if (sideChromeOn()) {
    chooseNotesSourceMode(next);
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
  const workspace = document.querySelector(".workspace");
  const layout = workspace?.dataset.layout || "";
  if (workspace?.dataset.notesOpen === "true" && (layout === "3" || layout === "pair")) {
    const shown = layout === "3" ? "side" : "hidden";
    const order = ["side", "mini", "hidden"];
    const next = order[(Math.max(0, order.indexOf(shown)) + 1) % order.length];
    chooseNotesSourceMode(next);
    return;
  }
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

function measuredWorkspaceWidth(workspace) {
  const rect = workspace?.getBoundingClientRect();
  return notesWorkspaceWidth({
    windowWidth: readerWidth(),
    measured: rect?.width,
    drawerDocked: Boolean(document.querySelector("[data-drawer-docked]"))
  });
}

function persistSlotPanelWidth(workspace) {
  if (!sideChromeOn(workspace)) return;
  if (workspace.dataset.layout === "3" || workspace.dataset.layout === "pair") return;
  if (workspace.dataset.sourceMode === "mini") {
    const raw = parseFloat(workspace.style.getPropertyValue("--oi-mini-width"));
    if (raw > 0) writeNotesPanelPrefs({ panelWidth: raw });
    return;
  }
  const slot = document.getElementById("sideSlot");
  const measured = slot?.getBoundingClientRect().width;
  if (measured > 0) writeNotesPanelPrefs({ panelWidth: measured });
}

function setNotesSplitVisible(on) {
  const handle = notesSplitHandle();
  if (!handle) return;
  handle.hidden = !on;
  handle.tabIndex = on ? 0 : -1;
  handle.setAttribute("aria-hidden", on ? "false" : "true");
}

function paintThreeColumns(workspace, { notesWidth, splitRatio } = {}) {
  const prefs = readNotesPanelPrefs();
  const width = measuredWorkspaceWidth(workspace);
  const ratio = Number.isFinite(splitRatio)
    ? splitRatio
    : (Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio")) || defaultSplitRatio(readerWidth()));
  const notes = notesWidth == null ? prefs.notesWidth : notesWidth;
  const columns = threePaneColumns({ workspaceWidth: width, notesWidth: notes, splitRatio: ratio });
  workspace.style.setProperty("--oi-three-source", `${columns.source}px`);
  workspace.style.setProperty("--oi-three-translate", `${columns.translate}px`);
  workspace.style.setProperty("--oi-split-ratio", String(columns.ratio));
  workspace.style.setProperty("--notes-width", `${columns.notes}px`);
  workspace.style.setProperty("--oi-notes-pane-w", `${columns.notes}px`);
  const sourceAria = threeSourceAria({
    workspaceWidth: width,
    notesWidth: columns.notes,
    splitRatio: columns.ratio
  });
  const handle = sourceSplitHandle(workspace);
  if (handle) {
    handle.setAttribute("aria-valuemin", String(sourceAria.valuemin));
    handle.setAttribute("aria-valuemax", String(sourceAria.valuemax));
    handle.setAttribute("aria-valuenow", String(sourceAria.valuenow));
    handle.setAttribute("aria-valuetext", sourceAria.valuetext);
    const bubble = handle.querySelector(".split-bubble");
    if (bubble) bubble.textContent = sourceAria.bubble;
  }
  applyNotesSplitAria(notesSplitHandle(workspace), notesSplitAria({ notesWidth: columns.notes, workspaceWidth: width }));
  return columns;
}

function applyThreeSourceSplit(workspace, clientX) {
  const prefs = readNotesPanelPrefs();
  const rect = workspace.getBoundingClientRect();
  const width = measuredWorkspaceWidth(workspace);
  const columns = threePaneColumns({ workspaceWidth: width, notesWidth: prefs.notesWidth, splitRatio: 0.5 });
  const notesSide = workspace.dataset.notesSide === "start" ? "start" : "end";
  const blockWidth = Math.max(1, columns.rest + 8);
  const origin = notesSide === "start" ? rect.x + columns.notes + 8 : rect.x;
  const ratio = splitPointerRatio({
    clientX,
    rect: { x: origin, width: blockWidth, end: origin + blockWidth },
    splitW: 8,
    side: notesSide === "start" ? "end" : "start"
  });
  paintThreeColumns(workspace, { notesWidth: prefs.notesWidth, splitRatio: ratio });
}

function applyNotesColumnDrag(workspace, clientX) {
  const rect = workspace.getBoundingClientRect();
  const width = measuredWorkspaceWidth(workspace);
  const notesSide = workspace.dataset.notesSide === "start" ? "start" : "end";
  const raw = notesSide === "start" ? clientX - rect.x : rect.right - clientX;
  const next = clampDraggedNotesWidth({ workspaceWidth: width, requested: raw - 4 });
  const ratio = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio"));
  paintThreeColumns(workspace, {
    notesWidth: next,
    splitRatio: Number.isFinite(ratio) ? ratio : defaultSplitRatio(readerWidth())
  });
}

function persistNotesColumnWidth(workspace) {
  const painted = parseFloat(workspace.style.getPropertyValue("--notes-width"));
  if (painted > 0) writeNotesPanelPrefs({ notesWidth: painted });
}

function startNotesSplitDrag(event, workspace, handle) {
  if (event.button !== 0 || workspace?.dataset.layout !== "3") return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  handle.classList.add("is-dragging");
  workspace.classList.add("is-splitting");
  const onMove = (moveEvent) => applyNotesColumnDrag(workspace, moveEvent.clientX);
  const onUp = () => {
    handle.classList.remove("is-dragging");
    workspace.classList.remove("is-splitting");
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    persistNotesColumnWidth(workspace);
    notesUi?.syncLayoutChrome?.();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  applyNotesColumnDrag(workspace, event.clientX);
}

function resetNotesSplit(workspace) {
  if (workspace?.dataset.layout !== "3") return;
  const next = clampDraggedNotesWidth({
    workspaceWidth: measuredWorkspaceWidth(workspace),
    requested: NOTES_PANE_WIDTH_DEFAULT
  });
  const ratio = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio"));
  paintThreeColumns(workspace, {
    notesWidth: next,
    splitRatio: Number.isFinite(ratio) ? ratio : defaultSplitRatio(readerWidth())
  });
  persistNotesColumnWidth(workspace);
  notesUi?.syncLayoutChrome?.();
}

function onNotesSplitKey(event, workspace) {
  if (workspace?.dataset.layout !== "3") return;
  const step = notesSplitKeyStep({
    key: event.key,
    shift: event.shiftKey,
    notesSide: workspace.dataset.notesSide
  });
  if (!step) return;
  event.preventDefault();
  event.stopPropagation();
  const width = measuredWorkspaceWidth(workspace);
  const prefs = readNotesPanelPrefs();
  let next = prefs.notesWidth;
  if (step.to === "min") next = NOTES_PANE_WIDTH_MIN;
  else if (step.to === "max") next = notesWidthLimit(width);
  else if (step.to === "reset") next = NOTES_PANE_WIDTH_DEFAULT;
  else if (Number.isFinite(step.delta)) next = prefs.notesWidth + step.delta;
  else return;
  next = clampDraggedNotesWidth({ workspaceWidth: width, requested: next });
  const ratio = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio"));
  paintThreeColumns(workspace, {
    notesWidth: next,
    splitRatio: Number.isFinite(ratio) ? ratio : defaultSplitRatio(readerWidth())
  });
  persistNotesColumnWidth(workspace);
  notesUi?.syncLayoutChrome?.();
}

function onThreeSourceKey(event, workspace) {
  const step = splitKeyStep({
    key: event.key,
    shift: event.shiftKey,
    side: workspace.dataset.notesSide === "start" ? "end" : "start"
  });
  if (!step) return;
  event.preventDefault();
  event.stopPropagation();
  if (step.to === "reset") {
    resetSplit(workspace);
    return;
  }
  const prefs = readNotesPanelPrefs();
  const width = measuredWorkspaceWidth(workspace);
  const current = threePaneColumns({
    workspaceWidth: width,
    notesWidth: prefs.notesWidth,
    splitRatio: Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio")) || defaultSplitRatio(readerWidth())
  });
  let ratio = current.ratio;
  if (step.to === "min") ratio = 0;
  else if (step.to === "max") ratio = 1;
  else if (Number.isFinite(step.delta)) ratio = (current.source + step.delta) / Math.max(1, current.rest);
  paintThreeColumns(workspace, { notesWidth: prefs.notesWidth, splitRatio: ratio });
  persistSplitRatio(workspace);
}

function applyNotesChrome(kind) {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  notesChromeLock = true;
  try {
    const prevKind = notesPaintedKind;
    notesPaintedKind = kind;
    if (kind === "three" || kind === "slot") notesLayoutLatch = kind;
    const prefs = readNotesPanelPrefs();
    const notesSide = prefs.notesPaneSide === "start" ? "start" : "end";
    workspace.dataset.notesSide = notesSide;
    const storedSide = readerPrefs.sourceSide === "end" ? "end" : "start";
    if (kind === "three") {
      const paired = sourceSideFromNotes(notesSide);
      workspace.dataset.layout = "3";
      workspace.dataset.sourceSide = paired;
      workspace.dataset.sourceMode = "side";
      workspace.dataset.miniCollapsed = "false";
      appliedSide = paired;
      reorderWorkspacePanes(workspace, notesDomOrder({ layout: "3", notesSide, sourceSide: paired }));
      setNotesSplitVisible(true);
      const ratio = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio"));
      paintThreeColumns(workspace, { splitRatio: Number.isFinite(ratio) ? ratio : defaultSplitRatio(readerWidth()) });
    } else if (kind === "pair") {
      workspace.dataset.layout = "pair";
      workspace.dataset.sourceMode = "hidden";
      reorderWorkspacePanes(workspace, notesDomOrder({ layout: "pair", notesSide, sourceSide: storedSide }));
      setNotesSplitVisible(false);
      workspace.style.setProperty("--notes-width", `${prefs.notesWidth}px`);
      workspace.style.setProperty("--oi-notes-pane-w", `${prefs.notesWidth}px`);
    } else {
      delete workspace.dataset.layout;
      setNotesSplitVisible(false);
      const mode = kind === "sheet"
        ? "hidden"
        : effectiveSourceMode({ width: readerWidth(), stored: readerPrefs.sourceMode });
      workspace.dataset.sourceMode = mode;
      reorderWorkspacePanes(workspace, notesDomOrder({
        layout: "",
        notesSide,
        sourceSide: workspace.dataset.sourceSide === "end" ? "end" : "start"
      }));
      if (mode === "mini" || mode === "hidden") {
        workspace.style.setProperty("--oi-notes-panel-w", `${prefs.panelWidth}px`);
        if (mode === "mini") workspace.style.setProperty("--oi-mini-width", `${prefs.panelWidth}px`);
      }
    }
    if (prevKind && prevKind !== kind) applyDefaultSourceZoom(workspace.dataset.sourceMode || "side");
    syncSourceModeControls();
    notesUi?.syncLayoutChrome?.();
  } finally {
    notesChromeLock = false;
  }
}

function syncNotesChrome({ opening = false } = {}) {
  const workspace = document.querySelector(".workspace");
  if (!workspace || !sideChromeOn(workspace)) return;
  if (opening) {
    const implied = notesSideFromSource(readerPrefs.sourceSide);
    const prefs = readNotesPanelPrefs();
    if (prefs.notesPaneSide !== implied) writeNotesPanelPrefs({ notesPaneSide: implied });
    notesUserPin = "";
    notesTempUpgrade = "";
    notesLayoutLatch = "";
  }
  const prefs = readNotesPanelPrefs();
  const windowWidth = readerWidth();
  const kind = notesChromeKind({
    windowWidth,
    workspaceWidth: measuredWorkspaceWidth(workspace),
    notesWidth: prefs.notesWidth,
    latched: notesLayoutLatch,
    opening,
    pinned: notesUserPin
  });
  if (opening && kind === "three") {
    const stored = effectiveSourceMode({ width: windowWidth, stored: readerPrefs.sourceMode });
    if (stored === "mini" || stored === "hidden") notesTempUpgrade = stored;
  }
  applyNotesChrome(kind);
}

function scheduleNotesChrome() {
  window.clearTimeout(notesResizeTimer);
  notesResizeTimer = window.setTimeout(() => {
    if (sideChromeOn()) syncNotesChrome({ opening: false });
  }, NOTES_PANE_RESIZE_DEBOUNCE_MS);
}

function closeNotesChrome() {
  const workspace = document.querySelector(".workspace");
  if (workspace?.dataset.askOpen === "true" || workspace?.dataset.libraryOpen === "true") return;
  window.clearTimeout(notesResizeTimer);
  notesPaintedKind = "";
  notesLayoutLatch = "";
  notesUserPin = "";
  notesTempUpgrade = "";
  if (workspace) {
    delete workspace.dataset.layout;
    delete workspace.dataset.notesSide;
    workspace.style.removeProperty("--oi-three-source");
    workspace.style.removeProperty("--oi-three-translate");
    workspace.style.removeProperty("--oi-notes-pane-w");
    workspace.style.removeProperty("--notes-width");
  }
  setNotesSplitVisible(false);
  applySourceLayout(false);
  appliedSide = "";
  applySourceSide(false);
}

function chooseNotesSourceMode(next) {
  readerPrefs = { ...readerPrefs, sourceMode: next };
  persistReaderPrefs();
  notesTempUpgrade = "";
  notesUserPin = next === "mini" ? "mini" : next === "hidden" ? "hidden" : "";
  if (sourcePopOpen() && next !== "hidden") closeSourcePop(false);
  syncNotesChrome({ opening: next === "side" });
  applyFollow({ type: "sourceModeChange" });
}

function setNotesPaneSide(side) {
  const notesPaneSide = side === "start" ? "start" : "end";
  const sourceSide = sourceSideFromNotes(notesPaneSide);
  writeNotesPanelPrefs({ notesPaneSide });
  // ⇧M must not dump the rest of the reader defaults (font, theme, sourceMode, …).
  if (readerPrefs.sourceSide !== sourceSide) {
    readerPrefs = { ...readerPrefs, sourceSide };
    try {
      localStorage.setItem(READER_SOURCE_SIDE_STORAGE_KEY, sourceSide);
    } catch {
      /* private mode */
    }
  }
  syncSwapCheck();
  const workspace = document.querySelector(".workspace");
  const layout = workspace?.dataset.layout || "";
  const open = sideChromeOn(workspace);
  if (open && (layout === "3" || layout === "pair")) {
    workspace.dataset.sourceSide = sourceSide;
    workspace.dataset.notesSide = notesPaneSide;
    appliedSide = sourceSide;
    reorderWorkspacePanes(workspace, notesDomOrder({ layout, notesSide: notesPaneSide, sourceSide }));
    if (layout === "3") {
      const ratio = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio"));
      paintThreeColumns(workspace, { splitRatio: Number.isFinite(ratio) ? ratio : defaultSplitRatio(readerWidth()) });
    }
  } else if (!open) applySourceSide(true);
  notesUi?.syncLayoutChrome?.();
}

function applySourceLayout(anchor) {
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  const width = readerWidth();
  let mode = effectiveSourceMode({ width, stored: readerPrefs.sourceMode });
  if (sideChromeOn(workspace) && notesPaintedKind === "three") mode = "side";
  else if (sideChromeOn(workspace) && notesPaintedKind === "pair") mode = "hidden";
  else if (sideChromeOn(workspace) && notesUserPin === "mini") mode = "mini";
  const prev = workspace.dataset.sourceMode || "";
  const changed = Boolean(prev) && prev !== mode;
  const token = anchor || changed ? captureReaderAnchor() : null;
  workspace.dataset.sourceMode = mode;
  const collapsed = mode === "mini" && readerPrefs.miniCollapsed === true;
  workspace.dataset.miniCollapsed = collapsed ? "true" : "false";
  const px = collapsed ? MINI_RAIL_PX : normalizeMiniWidth(readerPrefs.miniWidth);
  workspace.style.setProperty("--oi-mini-width", `${px}px`);
  if (mode === "mini" && !collapsed) paintMiniWidth(workspace, px);
  // Notes in mini occupy the source column at reader.panelWidth. Apply after
  // paintMiniWidth so the stored source width (and its aria) stay untouched.
  if (sideChromeOn(workspace) && mode === "mini") {
    workspace.style.setProperty("--oi-mini-width", `${readNotesPanelPrefs().panelWidth}px`);
  }
  else if (mode === "side") {
    const ratio = Number.parseFloat(workspace.style.getPropertyValue("--oi-split-ratio"));
    writeSplitAria(workspace, Number.isFinite(ratio) ? ratio : defaultSplitRatio(width));
  }
  const handle = sourceSplitHandle(workspace);
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
  if (!notesChromeLock && sideChromeOn(workspace) && notesPaintedKind) scheduleNotesChrome();
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
  const handle = sourceSplitHandle(workspace);
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
  // While notes are open the column shows reader.panelWidth, not the source mini width.
  if (sideChromeOn(workspace)) return;
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
  const split = sourceSplitHandle(workspace);
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
  registerSelAction({
    id: "copy-latex",
    slot: "overflow",
    order: 18,
    label: "复制 LaTeX",
    enabled: (ctx) => Boolean(ctx?.arxivLatex),
    run: (ctx) => copyArxivLatex(ctx?.arxivLatex, null)
  });
  document.addEventListener("copy", onCopyWithInlineLatex);
  registerSelAction({
    id: "note",
    enabled: () => Boolean(pdfDoc),
    run: (ctx) => notesFromSel(ctx, "note")
  });
  registerSelAction({
    id: "ask",
    label: "问 AI",
    enabled: () => Boolean(pdfDoc),
    run: (ctx) => {
      closeSelToolbar({ restore: false });
      void askUi?.askCitation(citationFromSel(ctx), { fresh: true });
    }
  });
  registerSelAction({
    id: "highlight",
    enabled: () => Boolean(pdfDoc),
    run: (ctx) => notesFromSel(ctx, "highlight")
  });
  registerSelAction({
    id: "question",
    enabled: () => Boolean(pdfDoc),
    run: (ctx) => notesFromSel(ctx, "question")
  });
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

function selMenuHint(item) {
  if (item.keyshortcuts === "Shift+N") return "⇧N";
  if (item.keyshortcuts === "h") return "h";
  return "";
}

function selMenuButton(item) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "menuitem");
  btn.dataset.selAction = item.id;
  btn.tabIndex = -1;
  const hint = item.id === "copy" ? "⌘C" : selMenuHint(item);
  if (hint) {
    btn.append(document.createTextNode(item.label));
    const key = document.createElement("span");
    key.className = "k";
    key.textContent = hint;
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

function selKeyboardHome(buttons) {
  const enabled = buttons.filter((btn) => !btn.disabled);
  // 笔记 is the leftmost main action once a PDF is open. F10 still starts on
  // 看原文 so ArrowRight walks see-source → jump-source → more.
  return enabled.find((btn) => btn.dataset.selAction === "see-source") || enabled[0] || null;
}

function armSelTabStops() {
  const buttons = selToolbarButtons();
  const home = selKeyboardHome(buttons);
  buttons.forEach((btn) => {
    btn.tabIndex = home && btn === home ? 0 : -1;
  });
}

function focusFirstSelButton() {
  const buttons = selToolbarButtons();
  const home = selKeyboardHome(buttons);
  if (!home) return;
  buttons.forEach((btn) => {
    btn.tabIndex = btn === home ? 0 : -1;
  });
  home.focus();
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
    arxivLatex: arxivLatexFromSelection(range, el),
    range: range.cloneRange(),
    anchor,
    key: `${bids.join("|")}::${text}`
  };
}

function arxivLatexFromSelection(range, el) {
  const host = el?.closest?.(".is-katex");
  if (host?.dataset?.oiTier === "arxiv" && host.dataset.latex) return host.dataset.latex;
  let frag = null;
  try { frag = range?.cloneContents?.(); } catch { frag = null; }
  const nodes = frag?.querySelectorAll?.(".is-katex") || [];
  if (nodes.length === 1 && nodes[0].dataset?.oiTier === "arxiv" && nodes[0].dataset.latex) {
    return nodes[0].dataset.latex;
  }
  return "";
}

function onCopyWithInlineLatex(event) {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount < 1) return;
  let frag = null;
  try { frag = sel.getRangeAt(0).cloneContents(); } catch { return; }
  if (!frag?.querySelector?.(".oi-pdf-inline-math.is-katex")) return;
  const text = plainWithInlineMath(frag);
  if (!text) return;
  event.clipboardData?.setData("text/plain", text);
  event.preventDefault();
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
  const layout = workspace?.dataset.layout === "3" ? "3" : (workspace?.dataset.layout === "pair" ? "pair" : "");
  const ids = f6RegionIds({
    mode: workspace?.dataset.sourceMode || "side",
    popOpen: sourcePopOpen(),
    side: workspace?.dataset.sourceSide === "end" ? "end" : "start",
    sideSlotOpen: layout ? false : sideSlotOpen(),
    notesLayout: layout,
    notesSide: workspace?.dataset.notesSide === "start" ? "start" : "end"
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
    sideSlot: document.querySelector("[data-side-slot]"),
    notes: document.querySelector(".oi-notes") || document.querySelector("[data-side-slot]")
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
    sideSlot: () => document.querySelector("[data-side-slot]"),
    notes: () => document.querySelector(".oi-notes [data-notes-segment]") || document.querySelector(".oi-notes") || document.querySelector("[data-side-slot]")
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
  syncArxivColumn();
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
  const widthPt = fracW * pageW;
  const column = columnPx > 0 ? columnPx : readerColumnPx();
  const sized = readerFormulaCssSize({
    bodyFontPx: readerShownFont(),
    sourceBodyPt: Number(layout?.bodyItemHeight) > 0 ? Number(layout.bodyItemHeight) : READER_SOURCE_BODY_PT,
    inkPt,
    widthPt,
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
    raised: Boolean(sized.raised),
    k: sized.k,
    widthPt
  };
}

function stampDisplayFormulaScale(row, matched, page) {
  if (!row || !matched) return;
  const layout = getPageLayout(page);
  const bodyPt = Number(layout?.bodyItemHeight) > 0 ? Number(layout.bodyItemHeight) : READER_SOURCE_BODY_PT;
  if (matched.k > 0) row.dataset.formulaK = String(matched.k);
  if (matched.widthPt > 0) row.dataset.widthPt = String(Math.round(matched.widthPt * 100) / 100);
  row.dataset.bodyPt = String(bodyPt);
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
    stampDisplayFormulaScale(row, matched, paper.dataset.page);
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

function refreshFallbackFormulaWidths(paper) {
  const page = paper.dataset.page;
  const layout = getPageLayout(page);
  const blocks = layout?.blocks || [];
  const pageWidthPt = Number(layout?.pageWidth) || 0;
  const floor = readerFormulaFloor(page);
  const blockFor = (node) => {
    const id = node.closest?.("[data-block-id]")?.dataset?.blockId;
    if (!id) return null;
    return blocks.find((item) => item.id === id) || null;
  };
  paper.querySelectorAll(".oi-pdf-math-row:not(.is-matched)").forEach((row) => {
    const pageFraction = formulaPageFraction(blockFor(row));
    const width = pageFraction ? displayFormulaWidthCss(pageFraction, 0, { pageWidthPt, floor }) : "";
    if (width) row.style.setProperty("--oi-formula-w", width);
  });
  paper.querySelectorAll("img.oi-pdf-math-crop, img.oi-pdf-asset-crop").forEach((img) => {
    if (img.closest(".oi-pdf-math-row, .oi-pdf-inline-math")) return;
    const block = blockFor(img);
    const pageFraction = displayCropColumnFraction(block);
    if (!pageFraction) return;
    const heightFrac = Number(block.bbox[3]) - Number(block.bbox[1]);
    const width = displayFormulaWidthCss(pageFraction, heightFrac, { pageWidthPt, floor });
    if (width) img.style.width = width;
  });
}

function applyPaperMetrics() {
  const flow = readerFlowEl();
  if (!flow) return;
  flow.querySelectorAll(":scope > .rf-page").forEach((slot) => {
    const left = leftBaseBox(slot.dataset.page);
    if (left?.width > 0) slot.style.setProperty("--oi-pdf-left-w", paperCssPx(left.width));
    refreshMatchedFormulas(slot);
    refreshFallbackFormulaWidths(slot);
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
  const next = { ...prev, ...patch };
  pageStates.set(key, next);
  if (viewerUnderTest() && globalThis.__oiWatchPageState) {
    const log = globalThis.__oiPageStateLog || [];
    log.push({ page: key, state: next.state || "" });
    globalThis.__oiPageStateLog = log;
  }
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
  const formulaBoxes = captureFormulaBoxes(flow);
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
  lockFormulaHeights(readerFlowEl(), formulaBoxes);
  syncArxivColumn();
  syncArxivOffer();
  noteAutoProgress();
  notesUi?.paint();
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

function captureFontAnchor() {
  const pane = translateScrollRoot();
  const flow = readerFlowEl();
  if (!pane || !flow) return null;
  const paneTop = pane.getBoundingClientRect().top;
  const blocks = [...flow.querySelectorAll(".rf-block[data-src-page]")];
  const block = blocks.find((el) => el.getBoundingClientRect().bottom > paneTop + 1);
  if (!block) return null;
  const box = block.getBoundingClientRect();
  const height = box.height || 1;
  return {
    page: block.dataset.srcPage || "",
    id: block.dataset.blockId || "",
    ratio: (paneTop - box.top) / height
  };
}

let fontAnchorTimer = 0;
let fontAnchorSerial = 0;

function readerBlockNode(flow, token) {
  const esc = globalThis.CSS?.escape || ((value) => String(value).replace(/"/g, '\\"'));
  if (token?.id) {
    const nodes = [...flow.querySelectorAll(`[data-block-id="${esc(token.id)}"]`)];
    const blocks = nodes.filter((node) => node.classList.contains("rf-block"));
    const onPage = token.page
      ? blocks.filter((node) => node.dataset.srcPage === String(token.page) || node.dataset.page === String(token.page))
      : blocks;
    const pool = onPage.length ? onPage : blocks;
    const visible = pool.find((node) => node.getClientRects().length);
    if (visible) return visible;
    if (pool[0]) return pool[0];
  }
  if (token?.page) return flow.querySelector(`.rf-block[data-src-page="${esc(token.page)}"]`);
  return null;
}

function restoreFontAnchor(token) {
  const pane = translateScrollRoot();
  const flow = readerFlowEl();
  if (!pane || !flow || !token) return;
  const node = readerBlockNode(flow, token);
  if (!node) return;
  const paneBox = pane.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  const target = readerFontAnchorTop({
    blockTop: box.top,
    blockHeight: box.height,
    ratio: token.ratio
  });
  let delta = target - paneBox.top;
  const slice = Math.min(16, box.height || 0);
  if (slice > 0) {
    const nextBottom = box.bottom - delta;
    const nextTop = box.top - delta;
    if (nextBottom < paneBox.top + slice) delta -= paneBox.top + slice - nextBottom;
    else if (nextTop > paneBox.bottom - slice) delta += nextTop - (paneBox.bottom - slice);
  }
  if (Math.abs(delta) > 0.5) pane.scrollTop += delta;
  updateReaderFade();
}

function finishFontAnchor(anchor) {
  const serial = ++fontAnchorSerial;
  const root = document.documentElement;
  if (root) root.dataset.oiFontAnchor = "run";
  restoreFontAnchor(anchor);
  requestAnimationFrame(() => {
    restoreFontAnchor(anchor);
    if (serial !== fontAnchorSerial || anchor) return;
    if (root) root.dataset.oiFontAnchor = "idle";
  });
  clearTimeout(fontAnchorTimer);
  if (!anchor) return;
  fontAnchorTimer = setTimeout(() => {
    fontAnchorTimer = 0;
    restoreFontAnchor(anchor);
    if (serial !== fontAnchorSerial) return;
    if (root) root.dataset.oiFontAnchor = "idle";
  }, 180);
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
  const fontPx = readerShownFont();
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
  unlockOffscreenFormulaHeights();
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

const backgroundSessions = createBackgroundSessions();

function abortBackgroundFills() {
  backgroundSessions.abortAll();
}

function beginViewerSession() {
  abortTranslateSession(session);
  abortBackgroundFills();
  session = createTranslateSession();
  session.running = true;
  return session;
}

function isCurrentWork(work, gen, translatingDoc) {
  return work === session && gen === restoreGen && translatingDoc === docId;
}

function stopTranslateWork() {
  abortTranslateSession(session);
  abortBackgroundFills();
  cancelQueuedVendorLayouts();
  translatingPage = 0;
  forceRetranslatePending = false;
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
    // P-A whitelist: 1.2s probe. Any throw means down. Net retry would change that boolean.
    await fetch(root, { method: "GET", signal: AbortSignal.timeout(1200) });
    return true;
  } catch {
    return false;
  }
}

function noteFreeDefaultOutbound(outbound) {
  const root = document.documentElement;
  if (!root) return;
  if (!outbound?.fallback) {
    delete root.dataset.oiOutbound;
    return;
  }
  root.dataset.oiOutbound = "mymemory-free";
  const notice = String(outbound.notice || "");
  const status = $("status");
  if (status && notice) {
    status.title = notice;
    if (!status.classList.contains("error")) status.textContent = notice;
  }
  const button = $("translatePage");
  if (button && notice) button.title = notice;
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
  const outbound = resolveOutboundProvider(settings);
  noteFreeDefaultOutbound(outbound);
  const missing = outbound.fallback
    ? null
    : missingRequiredField(getProvider(outbound.providerId), settings.providers?.[outbound.providerId] || {});
  const layoutMode = pdfEngineMode();
  let localServiceUp = true;
  // GET / on 8765 is the library-and-OCR probe, not a /v1/layout failure.
  // Skip it only when this paper is already fully stored. A read that has
  // not finished must not probe either: the red banner would flash and then
  // go away. A real /v1/layout failure keeps its own layout notice.
  let document = libraryDoc;
  let zoneReason = "";
  if (layoutMode === "local-ocr" && !paperFullyInLibrary(document)) {
    const hash = await pdfByteHash();
    if (hash && hash !== "nohash") {
      const gate = await waitForFirstZone(hash);
      const ready = gate.reason === "cap" ? await resolveZoneForVendor(hash, gate) : gate;
      zoneReason = ready?.reason || "";
      if (ready?.document) document = ready.document;
    }
  }
  if (shouldProbeLocalService({ layoutMode, document, zoneReason })) {
    localServiceUp = await probeLocalService(cachedPdfLayout?.localBaseUrl);
  }
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
  if (!pdfDoc || docPhase === "stopped") return;
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
  if (adopting !== docId || !pdfDoc || docPhase === "stopped" || documentTranslateSuperseded()) return;
  // The retranslate button is enabled while docPhase is still "opening".
  // Settings reads resolve as microtasks, so without a timer the phase
  // flips to running before any click or interval can run. The library
  // probe used to leave that gap, and it also held page-nav. Page-nav has
  // already ended; this 16ms only keeps opening observable. A 0ms timer
  // would run before a pending interval and close the gap again.
  await new Promise((resolve) => setTimeout(resolve, 16));
  if (adopting !== docId || !pdfDoc || docPhase === "stopped" || documentTranslateSuperseded()) return;
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

function rememberLibraryIdentity(value) {
  const raw = String(value || "");
  const http = httpSourceUrl(raw);
  libraryHttpUrl = http;
  libraryFileName = http ? "" : (shortTitle(raw) || "");
  libraryTitle = cleanTitle(shortTitle(raw) || raw);
}

function captureLibraryIdentity() {
  return {
    title: libraryTitle || cleanTitle(document.title),
    fileName: libraryFileName,
    sourceUrl: libraryHttpUrl
  };
}

function librarySourceBlob(hash, bytes) {
  if (libraryOriginalStored.has(hash) || !bytes?.byteLength) return null;
  return new Blob([bytes], { type: "application/pdf" });
}

function rememberLibraryOriginal(hash, sentFor, saved) {
  if (docId !== sentFor) return;
  const status = saved?.source;
  if (status !== "saved" && status !== "exists") return;
  libraryOriginalStored.add(hash);
}

function rememberLibrarySourceAttempt(hash, sentFor, saved) {
  if (docId !== sentFor) return;
  // Stick only when a source blob was actually stored. Quota, a missing
  // paper, and any other miss must try again on the next open.
  // This set means pages were written this session. Opening does not call it.
  const status = saved?.source;
  if (status !== "saved" && status !== "exists") return;
  librarySourceSent.add(hash);
  libraryOriginalStored.add(hash);
}

function storeOpenedPdf(openedStamp, captured = null, mode = "") {
  const bytes = captured?.bytes || pdfBytes;
  const pageCount = captured?.pageCount ?? (pdfDoc?.numPages || 0);
  const identity = captured?.identity || captureLibraryIdentity();
  const recordOnly = mode === "record";
  return (async () => {
    try {
      const hash = await pdfByteHash(bytes);
      if (docId !== openedStamp || !hash || hash === "nohash") return;
      noteLibraryLoaded(hash, libraryOpenNotedAt || Date.now());
      // The record call does not store the blob and does not revive a
      // tombstone. The later source call must not move lastOpenedAt.
      const saved = await openLibraryPdf({
        hash,
        title: identity.title,
        fileName: identity.fileName,
        sourceUrl: identity.sourceUrl,
        pageCount,
        ...(recordOnly ? {} : { source: librarySourceBlob(hash, bytes) })
      }, recordOnly ? {} : { record: false });
      if (!recordOnly) rememberLibraryOriginal(hash, openedStamp, saved);
    } catch {
      /* the PDF stays open when the library record cannot be written */
    }
  })();
}

function scheduleOpenedPdf(openedStamp) {
  const captured = {
    bytes: pdfBytes,
    pageCount: pdfDoc?.numPages || 0,
    identity: captureLibraryIdentity()
  };
  // Paper row first. Auto-translate and a slow 8765 read must not hold it.
  // The original blob still waits until page writes settle: a blob
  // transaction opened earlier holds the paper row the same-tab reopen reads.
  // Neither call treats the open as a saved page.
  void storeOpenedPdf(openedStamp, captured, "record");
  const startedAt = Date.now();
  const arm = () => {
    if (docId !== openedStamp) return;
    const quiet = !pdfTranslateBusy(session) && libraryWritesPending === 0;
    const translating = docPhase === "opening" || docPhase === "running";
    if (!quiet || (translating && Date.now() - startedAt < 15000)) {
      setTimeout(arm, 40);
      return;
    }
    void storeOpenedPdf(openedStamp, captured, "source");
  };
  setTimeout(arm, 40);
}

function libraryPayloadFields(identity, hash, bytes) {
  const source = librarySourceBlob(hash, bytes);
  return {
    ...(identity.title ? { title: identity.title } : {}),
    ...(identity.fileName ? { fileName: identity.fileName } : {}),
    ...(identity.sourceUrl ? { sourceUrl: identity.sourceUrl } : {}),
    ...(source ? { source } : {})
  };
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
  if (!verified.length && !skipOnly) {
    void maybeShowPersistCard();
    return Promise.resolve();
  }
  if (!verified.length && existing && (existing.pairs?.length || existing.skipped)) {
    void maybeShowPersistCard();
    return Promise.resolve();
  }
  const keptPairs = pairsWithoutUnalignedSlots(existing?.pairs, blocks, savedPairSettings());
  const pairs = verified.length
    ? mergeLibraryPairs(keptPairs, verified, blocks, pdfTargetLang)
    : [];
  if (pairs.length) replaceLibraryPagePairs(libraryDoc, page, pairs);
  // Capture this document before queuing: the user may open another PDF while
  // earlier pages are still being saved.
  const bytes = pdfBytes;
  const identity = captureLibraryIdentity();
  const pageCount = pdfDoc?.numPages || 0;
  const skipped = skipOnly && !pairs.length;
  const sentFor = docId;
  return enqueueLibraryWrite(async () => {
    const hash = await pdfByteHash(bytes);
    if (!hash || hash === "nohash") {
      void maybeShowPersistCard();
      return;
    }
    const keepLayout = !(await layoutWriteSuperseded(hash, page, String(layout?.layoutVersion || "")));
    const savedPayload = {
      hash,
      pageCount,
      page,
      pairs,
      // The layout row stays when it is already current. The blocks still have
      // to ride along, or the page merge keeps a settled but misaligned pair.
      ...(blocks?.length ? { blocks } : {}),
      targetLang: pdfTargetLang,
      ...(keepLayout ? { layout } : {}),
      ...(keepLayout && layout?.layoutVersion ? { layoutVersion: layout.layoutVersion } : {}),
      ...(keepLayout && engineModeOf(rawLayout) ? { mode: engineModeOf(rawLayout) } : {}),
      ...libraryPayloadFields(identity, hash, bytes),
      ...(skipped ? { skipped: true } : {})
    };
    const saved = await saveLibraryPage(savedPayload);
    void maybeShowPersistCard();
    rememberLibrarySourceAttempt(hash, sentFor, saved);
    const savedPage = libraryDoc?.pages?.find((item) => item.page === page);
    if (keepLayout && savedPage && layout) {
      savedPage.layout = layout;
      if (layout.layoutVersion) savedPage.layoutVersion = layout.layoutVersion;
      rememberEngineLayout(page, rawLayout);
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
    ...(stored.mode ? { mode: String(stored.mode) } : {}),
    ...(fallback ? { fallback } : {}),
    blocks: stored.blocks,
    itemCount: Number(stored.itemCount) || stored.blocks.length
  };
}

/** Paint the library's current blocks before any pair-only or text-layer stand-in. */
function installDisplayableLibraryLayouts(version = knownLayoutVersion) {
  if (!version || !libraryDoc?.pages?.length) return false;
  const engine = pdfEngineMode();
  let changed = false;
  for (const entry of libraryDoc.pages) {
    const page = Number(entry?.page);
    if (!(page >= 1)) continue;
    const view = libraryEntry(page) || entry;
    if (!layoutServesLibrary(view, engine)) continue;
    const stored = storedLayoutDisplayable(view, version);
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
  return !layoutCurrentForLibrary(entry, version, pdfEngineMode());
}

function persistDisplayedLayout(page) {
  if (!libraryLayoutNeedsWrite(page)) return Promise.resolve();
  return persistPageLayout(page);
}

/** A current row, including unknown, is already stored. Do not add a text-layer row over it. */
async function layoutWriteSuperseded(hash, page, version) {
  const seen = () => currentLayoutIfArrived({
    hash,
    page,
    version,
    engine: pdfEngineMode()
  });
  if (seen()) return true;
  const flight = libraryFetchInFlight(hash);
  if (flight) await flight.promise.catch(() => null);
  return Boolean(seen());
}

function persistPageLayout(page) {
  const raw = getPageLayout(page);
  const version = String(raw?.layoutVersion || "");
  if (!version || !raw?.blocks?.length) return Promise.resolve();
  const layout = cacheableLayout(raw);
  const entry = libraryEntry(page);
  const pairs = Array.isArray(entry?.pairs) ? entry.pairs : [];
  const skipped = Boolean(entry?.skipped) || (isSkipOnlyPage(raw.blocks) && !pairs.length);
  const bytes = pdfBytes;
  const identity = captureLibraryIdentity();
  const pageCount = pdfDoc?.numPages || 0;
  const epoch = layoutEpoch;
  const sentFor = docId;
  return enqueueLibraryWrite(async () => {
    const hash = await pdfByteHash(bytes);
    if (!hash || hash === "nohash") return;
    if (await layoutWriteSuperseded(hash, page, version)) return;
    if (!layoutAttemptLive(epoch)) return;
    const live = libraryEntry(page);
    if (live) {
      live.layout = layout;
      live.layoutVersion = version;
      if (skipped) live.skipped = true;
      rememberEngineLayout(page, raw);
    } else if (libraryDoc && Array.isArray(libraryDoc.pages)) {
      libraryDoc.pages.push({ page, pairs, layout, layoutVersion: version, ...(skipped ? { skipped: true } : {}) });
      rememberEngineLayout(page, raw);
    }
    const savedPayload = {
      hash,
      pageCount,
      page,
      pairs,
      layout,
      blocks: raw.blocks,
      targetLang: pdfTargetLang,
      layoutVersion: version,
      ...(engineModeOf(raw) ? { mode: engineModeOf(raw) } : {}),
      ...(skipped ? { skipped: true } : {}),
      ...libraryPayloadFields(identity, hash, bytes)
    };
    const saved = await saveLibraryPage(savedPayload);
    void maybeShowPersistCard();
    rememberLibrarySourceAttempt(hash, sentFor, saved);
  });
}

function persistPagePairs(saved) {
  const page = Number(saved?.page);
  if (!page || !saved?.pairs?.length) return Promise.resolve();
  const rawLayout = getPageLayout(page);
  const layout = rawLayout ? cacheableLayout(rawLayout) : null;
  const bytes = pdfBytes;
  const identity = captureLibraryIdentity();
  const pageCount = pdfDoc?.numPages || 0;
  const sentFor = docId;
  return enqueueLibraryWrite(async () => {
    const hash = await pdfByteHash(bytes);
    if (!hash || hash === "nohash") return;
    const keepLayout = layout && !(await layoutWriteSuperseded(hash, page, String(layout.layoutVersion || "")));
    const savedPayload = {
      hash,
      pageCount,
      page,
      pairs: saved.pairs,
      ...(rawLayout?.blocks?.length ? { blocks: rawLayout.blocks } : {}),
      targetLang: pdfTargetLang,
      ...(keepLayout ? { layout, ...(layout.layoutVersion ? { layoutVersion: layout.layoutVersion } : {}), ...(engineModeOf(rawLayout) ? { mode: engineModeOf(rawLayout) } : {}) } : {}),
      ...(saved.skipped ? { skipped: true } : {}),
      ...libraryPayloadFields(identity, hash, bytes)
    };
    const savedPage = await saveLibraryPage(savedPayload);
    void maybeShowPersistCard();
    rememberLibrarySourceAttempt(hash, sentFor, savedPage);
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

function ensureLibraryDocument() {
  if (libraryDoc) return Promise.resolve(libraryDoc);
  if (libraryProbe) return libraryProbe;
  const stamp = docId;
  libraryProbe = (async () => {
    try {
      const hash = await pdfByteHash();
      if (docId !== stamp || !hash || hash === "nohash") return null;
      if (libraryDoc && libraryDoc.hash === hash) return libraryDoc;
      const doc = await fetchLibraryDocument(hash, { engine: pdfEngineMode() });
      if (docId !== stamp) return null;
      // Translation may already have filled this document while the probe was
      // still reading. A late legacy snapshot must not replace it, or the next
      // layout write stores the original pairs over the translation.
      if (libraryDoc && libraryDoc.hash === hash) return libraryDoc;
      if (doc) doc.hash = hash;
      libraryDoc = doc || null;
      if (hash) void pendingNotes?.hydrate?.(hash);
      return libraryDoc;
    } catch {
      // One probe per document. Page turns do not wait for these delays,
      // and a failed probe is not started again on the next page.
      if (docId === stamp && !getPageLayout(pageNum)?.blocks?.length) noteLibraryUnavailable();
      return null;
    }
  })();
  return libraryProbe;
}

function savedTranslationForNav(page) {
  if (!libraryDoc) return Promise.resolve(null);
  return savedTranslationFor(page).catch(() => null);
}

function paintLateLibrary(n, ticket) {
  if (libraryDoc) return;
  const stamp = docId;
  ensureLibraryDocument().then(async () => {
    if (ticket !== textGen || docId !== stamp || !libraryDoc) return;
    const saved = await savedTranslationFor(n).catch(() => null);
    if (ticket !== textGen || docId !== stamp || !saved) return;
    if (saved.readout && !saved.pairs) {
      setStatus(PDF_COPY.doneDocument);
      renderArticle();
      updateTranslateControls();
      return;
    }
    const layout = getPageLayout(n);
    if (!layout?.blocks?.length || !saved.pairs) return;
    const prepared = bindSavedPairs(saved, unitsForLayout(layout));
    const merged = applySavedPairs(unitsForLayout(layout), prepared.pairs, savedPairSettings());
    const blocks = layout.blocks || [];
    const covers = libraryCoversLiveBlocks(prepared.pairs, blocks, pdfTargetLang, pdfProvider) ||
      libraryCoversLiveBlocks(merged, blocks, pdfTargetLang, pdfProvider);
    // The probe can resolve after this open has already translated the page.
    // A thinner library snapshot must not replace that translation or demote
    // the page, or a one-pair fixture leaves the page partial.
    const already = pageCache.get(docId, n);
    if (!covers && (pageStates.get(n)?.state === "done" || pageHasTranslation(already, pdfTargetLang))) return;
    if (n === pageNum || n === textLoadPage) pageResults = merged;
    pageCache.set(docId, n, merged);
    const skipped = skipLocked.has(n) || isSkipOnlyPage(blocks);
    notePageState(n, { state: skipped ? "skipped" : (covers ? "done" : "partial"), hasLayout: true });
    if (!pdfTranslateBusy(session)) {
      setStatus(savedPageStatus(prepared, merged, blocks));
      rememberSkipHole(n, blocks);
    }
    clearSlotPainted(n);
    refreshDocStatus();
    renderArticle();
    updateTranslateControls();
  }).catch(() => {});
}

async function savedTranslationFor(page) {
  const hash = await pdfByteHash();
  if (!hash || hash === "nohash") return null;
  if (!libraryDoc || libraryDoc.hash !== hash) {
    // A blocked open must not hold translation. A read that is still inside
    // the cap used to await the probe here, and that probe awaited the
    // IndexedDB open until the 10s deadline even after the migration GET
    // had already returned the page. Join that GET, and only until the
    // zoning cap. Do not await the probe.
    const zone = await waitForFirstZone(hash);
    // A finished read is not reused, so this call starts a new IndexedDB read
    // once the open's first read has settled. That re-read includes pages this
    // translation just saved. Those pairs have no failed flag. Adopting them
    // turns the failed batch into a fresh request and drops bypassCache.
    const savedThisSession = librarySourceSent.has(hash);
    if (!translationWaitsForLibrary(zone)) {
      if (!libraryProbe) void ensureLibraryDocument();
    }
    if (zone?.reason === "unavailable" || !zone?.document) {
      // A blocked open used to stop here. The page then paid for a new
      // batch, and the row on screen waited until the upgrade's 10s
      // BlockedError. The migration GET is the translation, until the cap.
      if (!libraryProbe) void ensureLibraryDocument();
      const adopted = await waitForZoneMigration(hash, zone, { page, version: knownLayoutVersion, engine: pdfEngineMode() });
      if (adopted?.document && !librarySourceSent.has(hash) && (!libraryDoc || libraryDoc.hash !== hash)) {
        if (!adopted.document.hash) adopted.document.hash = hash;
        libraryDoc = adopted.document;
      }
    } else if (zone?.document && !savedThisSession) {
      if (!zone.document.hash) zone.document.hash = hash;
      libraryDoc = zone.document;
    }
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

async function rememberLandedStructure(page, translatingDoc) {
  const record = titleStructure;
  if (!record || record.docId !== translatingDoc || Number(record.page) !== Number(page)) return;
  if (!record.slotsDone || record.failed) return;
  const blocks = getPageLayout(page)?.blocks || [];
  const landed = structureTranslationRows(record.source, record.structure);
  if (!landed.length) return;
  const results = bindStructureRowBids(landed, blocks);
  if (!results.some((row) => row.bid)) return;
  const cached = pageCache.get(translatingDoc, page);
  pageCache.set(translatingDoc, page, mergeTranslationRows(Array.isArray(cached) ? cached : [], results));
  await rememberTranslation(page, results);
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
    } catch (error) {
      if (noteLibrarySaveError(error)) setStatus("译文已生成，但写入本地库失败。", true);
    } finally {
      void maybeShowPersistCard();
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
    if (!keys?.length) return {};
    return await readLayoutCaches(keys);
  } catch {
    return {};
  }
}

function seedLibraryProgress(skipPage = 0) {
  const pages = libraryDoc?.pages || [];
  if (!pages.length || !pdfDoc) return false;
  const installed = installDisplayableLibraryLayouts();
  let changed = installed;
  for (const entry of pages) {
    const page = Number(entry?.page);
    if (!(page >= 1) || page > pdfDoc.numPages) continue;
    // A failed cache is restored after adopt. Seeding must not paint that page done first.
    if (skipPage && page === skipPage) continue;
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
  const bag = await Promise.race([
    readStoredLayouts(keys),
    new Promise((resolve) => setTimeout(() => resolve({}), LIBRARY_ZONE_WAIT_MS))
  ]);
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
  if (docPhase === "stopped") return false;
  const epoch = layoutEpoch;
  const pages = [...skipLocked].sort((a, b) => a - b);
  for (const page of pages) {
    if (isStale() || !layoutAttemptLive(epoch)) return;
    const previous = getPageLayout(page);
    let laid = null;
    try {
      laid = await ingestPageLayout(page, () => isStale() || !layoutAttemptLive(epoch), epoch);
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
  if (docPhase === "stopped") return false;
  const onlyPage = Number(options.onlyPage) || 0;
  const stamp = docId;
  const epoch = layoutEpoch;
  const heldCache = Array.isArray(options.priorCache)
    ? options.priorCache
    : (Array.isArray(libraryAdoptHold) ? libraryAdoptHold : null);
  libraryAdoptHold = null;
  const heldPage = onlyPage >= 1 && heldCache && pageNeedsBypass(heldCache, pdfTargetLang) ? onlyPage : 0;
  if (heldPage) {
    pageCache.set(docId, heldPage, heldCache);
    notePageState(heldPage, {
      state: heldCache.some((row) => row?.failed === true) ? "failed" : "partial",
      hasLayout: Boolean(getPageLayout(heldPage)?.blocks?.length)
    });
    clearSlotPainted(heldPage);
    const would = libraryPageRunState({
      pairs: libraryEntry(heldPage)?.pairs || null,
      cached: null,
      targetLang: pdfTargetLang,
      provider: pdfProvider,
      blocks: getPageLayout(heldPage)?.blocks || null
    });
    if (would === "done" || would === "skipped") libraryAdoptWouldSkip = true;
  }
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
  if (seedLibraryProgress(heldPage) && stamp === docId) renderArticle();
  if (await seedLegacySkipPages() && stamp === docId) renderArticle();
  for (let page = start; page <= end; page += 1) {
    if (stamp !== docId || docPhase === "stopped") return true;
    if (heldPage && page === heldPage) continue;
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
        layout = await ingestPageLayout(page, () => stamp !== docId || !layoutAttemptLive(epoch), epoch);
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
    if (!skipped && entry?.pairs?.length && Array.isArray(blocks) && blocks.length) {
      const healed = commitLandedStructurePairs(entry.pairs, [], blocks, pdfTargetLang);
      if (structurePairsChanged(entry.pairs, healed)) {
        entry.pairs = healed;
        replaceLibraryPagePairs(libraryDoc, page, healed);
        persistPagePairs({ page, pairs: healed }).catch(() => {});
      }
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
      // A partial paint may already have stamped the slot. Clearing it lets the
      // settled page rebuild, so the chip recounts visible inline formulas.
      clearSlotPainted(page);
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
    // Snapshot before adopt. A page saved this session has no failed flag.
    // Adopting it turns a failed body batch into a fresh request and drops bypassCache.
    let priorCache = pageCache.get(translatingDoc, page);
    let failedBody = pageNeedsBypass(priorCache, pdfTargetLang);
    if (failedBody && Array.isArray(priorCache)) {
      const reused = reuseSettledLibraryFailures(priorCache, libraryEntry(page)?.pairs, pdfTargetLang, {
        provider: pdfProvider,
        model: pdfModel
      });
      if (reused !== priorCache) {
        priorCache = reused;
        pageCache.set(translatingDoc, page, priorCache);
        failedBody = pageNeedsBypass(priorCache, pdfTargetLang);
      }
    }
    libraryAdoptWouldSkip = false;
    libraryAdoptHold = failedBody ? priorCache : null;
    await adoptLibraryPages({ onlyPage: page });
    if (work.aborted || !isCurrentWork(work, gen, translatingDoc)) return "stop";
    if (viewerUnderTest() && globalThis.__oiStopAfterAdopt) {
      work.aborted = true;
      return "stop";
    }
    if (failedBody && priorCache) pageCache.set(translatingDoc, page, priorCache);
    // Body coverage is not a finished title. The open record can already
    // hold a layout or a skip page, and resume would skip before the failed
    // title batch is sent again with bypassCache. A failed body row needs the
    // same retry: the restored cache still has failed, so the resend bypasses.
    if (titleStructureFailed(page) || failedBody) return "retry";
    // Pairs that already cover the page would have painted it done. Without the
    // failed-body retry above, that hold must skip instead of sending again.
    if (libraryAdoptWouldSkip) return "skip";
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
      const layoutScheduled = layoutEpoch;
      // Filled in after the blocking page, before this job drops session.running.
      // Stop stays up for the background re-zone; aborting the session ends that round.
      let backgroundTracked = null;
      const staleWork = () => !isCurrentWork(work, gen, translatingDoc)
        || work.aborted
        || !layoutAttemptLive(layoutScheduled)
        || Boolean(backgroundTracked && !backgroundTracked.current());
      await reconcileLockedSkipLayouts(staleWork);
      const adoptUpgraded = async (upgraded, info = {}) => {
        const needs = [];
        for (const page of upgraded || []) {
          if (staleWork()) break;
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
        if (needs.length && !translatedDoc.paused && !staleWork() && !work.aborted) {
          const tracked = info.background ? backgroundSessions.track(createTranslateSession()) : null;
          if (tracked) updateTranslateControls();
          const fillAlive = () => !staleWork() && !work.aborted && (!tracked || tracked.current());
          const guarded = tracked ? {
            session: tracked.session,
            cache: translationCacheWhile(pageCache, fillAlive),
            onPageResult(payload) {
              if (!fillAlive() || !isCurrentWork(work, gen, translatingDoc)) return;
              pageJob.onPageResult(payload);
            },
            onPageDone(payload) {
              if (!fillAlive() || !isCurrentWork(work, gen, translatingDoc)) return;
              pageJob.onPageDone(payload);
            },
            onPageError(payload) {
              if (!fillAlive() || !isCurrentWork(work, gen, translatingDoc)) return;
              pageJob.onPageError(payload);
            }
          } : {};
          let filled;
          try {
            filled = await translateDocumentPages({
              ...pageJob,
              ...guarded,
              preserveSession: true,
              includePage: (page) => needs.includes(page) && fillAlive()
            });
          } finally {
            tracked?.release();
            if (tracked) updateTranslateControls();
          }
          translatedDoc = {
            ok: translatedDoc.ok && filled.ok,
            aborted: translatedDoc.aborted || filled.aborted,
            paused: translatedDoc.paused || filled.paused,
            error: translatedDoc.error || filled.error,
            missingField: translatedDoc.missingField || filled.missingField,
            pages: translatedDoc.pages.concat(filled.pages)
          };
        }
      };
      // Retranslate waits on this job. Only the page on screen may hold it.
      // Other stale pages post after the job releases, and their new blocks
      // are translated on a side session so they do not mark this job busy.
      const viewing = Number(pageNum) || 0;
      const layoutPass = startDocumentLayoutRetry({
        total,
        viewing,
        isStale: staleWork,
        retryLayouts: (options) => retryPendingVendorLayouts(staleWork, { ...options, epoch: layoutScheduled }),
        adoptUpgraded
      });
      await layoutPass.blocking;
      // Other pages re-zone only after this await. Track that round before
      // session.running drops, or Stop hides and the POST cannot be cancelled.
      if ((pdfDoc?.numPages || 0) > 1 && !staleWork()) {
        backgroundTracked = backgroundSessions.track(createTranslateSession());
        updateTranslateControls();
      }
      void layoutPass.background.finally(() => {
        const tracked = backgroundTracked;
        if (!tracked) return;
        backgroundTracked = null;
        tracked.release();
        updateTranslateControls();
      }).catch(() => {});
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
  renderArticle();
  const saveErrors = (await Promise.all(saveTasks)).map((error) => noteLibrarySaveError(error));
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

/** Stop leaves layoutClosed false. This capture is the epoch after that bump. */
async function zoneForRetranslate(page, work) {
  const mode = pdfEngineMode();
  if (mode !== "local-ocr" && mode !== "cloud-ocr") return null;
  const epoch = layoutEpoch;
  if (docPhase === "stopped" || work?.aborted || !layoutAttemptLive(epoch)) return null;
  const version = knownLayoutVersion || await layoutVersionNow();
  if (docPhase === "stopped" || work?.aborted || !layoutAttemptLive(epoch)) return null;
  const current = getPageLayout(page);
  if (layoutCurrentForEngine(current, version, mode)) return null;
  return ingestVendorLayout(page, mode, () => docPhase === "stopped" || Boolean(work?.aborted) || !layoutAttemptLive(epoch), epoch);
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
  abortBackgroundFills();
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
    const refreshed = await zoneForRetranslate(targetPage, work);
    if (left()) return;
    const zonedLayout = refreshed || getPageLayout(targetPage) || sourceLayout;
    await ensureTitleStructure(targetPage, zonedLayout, { force: true });
    if (left()) return;
    const pageUnits = liveOriginals(zonedLayout, unitsForForceRetranslate(zonedLayout));
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
    const merged = pageResultsFromTranslation(zonedLayout, translated.results);
    work.running = true;
    translatingPage = targetPage;
    updateTranslateControls();
    try {
      const pairs = pairsFromResults(merged);
      try {
        await rememberTranslation(targetPage, merged);
      } catch (error) {
        const leftover = noteLibrarySaveError(error);
        if (leftover) throw leftover;
      } finally {
        void maybeShowPersistCard();
      }
      if (!pairs.length) throw new Error("empty retranslation");
      replaceLibraryPagePairs(libraryDoc, targetPage, pairs);
      pageCache.set(translatingDoc, targetPage, merged);
      pageResults = merged;
      notePageState(targetPage, { state: pageRunState(merged, { targetLang: pdfTargetLang }), hasLayout: true });
      clearSlotPainted(targetPage);
      finishDocPhase();
      renderArticle();
      reanchorTranslatedPage(targetPage);
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
    if (resumeAuto && !work.aborted && docPhase !== "stopped") void maybeAutoTranslateDocument();
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
  const rows = bindStructureRowBids(
    structureTranslationRows(record.source, record.structure),
    layout?.blocks || []
  );
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
async function retryPendingVendorLayouts(isStale, options = {}) {
  const upgraded = [];
  const mode = pdfEngineMode();
  if (mode !== "local-ocr" && mode !== "cloud-ocr") return upgraded;
  // Captured when this pass was scheduled. Stop bumps the epoch, and a pass
  // that then reaches a page must not start that POST.
  const epoch = options.epoch;
  if (docPhase === "stopped" || !Number.isFinite(epoch)) return upgraded;
  if ((typeof isStale === "function" && isStale()) || !layoutAttemptLive(epoch)) return upgraded;
  const version = await layoutVersionNow();
  const total = pdfDoc?.numPages || 0;
  const only = Number(options.onlyPage) || 0;
  const skip = Number(options.skipPage) || 0;
  const pages = [];
  for (let page = 1; page <= total; page += 1) {
    if (only && page !== only) continue;
    if (skip && page === skip) continue;
    pages.push(page);
  }
  pages.sort((a, b) => Number(b === Number(pageNum)) - Number(a === Number(pageNum)) || a - b);
  for (const page of pages) {
    if (isStale() || !layoutAttemptLive(epoch)) return upgraded;
    const entry = libraryEntry(page);
    const storedBlocks = entry?.layout?.blocks;
    const hasStored = (Array.isArray(storedBlocks) && storedBlocks.length > 0) ||
      Boolean(entry?.layoutVersion || entry?.layout?.layoutVersion);
    const stale = Boolean(entry && hasStored && version && !layoutCurrentForLibrary(entry, version, mode));
    if (!stale && !vendorLayoutPending.has(page)) continue;
    try {
      const laid = await ingestPageLayout(page, () => isStale() || !layoutAttemptLive(epoch), epoch);
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

async function ingestPageLayout(n, isStale, epoch) {
  if (!layoutAttemptLive(epoch)) return null;
  if (!isStale()) layoutNotice = "";
  await loadPdfLayout();
  if (!layoutAttemptLive(epoch) || isStale()) return null;
  const mode = pdfEngineMode();
  if (mode === "legacy") return ingestReadoutLayout(n, isStale);
  if (mode === "fixture" && n === 1) return ingestFixtureLayout(n, isStale);
  if (mode === "local-ocr" || mode === "cloud-ocr") {
    const laid = await ingestVendorLayout(n, mode, isStale, epoch);
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
    return await readLayoutCache(key);
  } catch {
    return null;
  }
}

async function writeStoredLayout(key, page) {
  try {
    await writeLayoutCache(key, page);
  } catch {
    /* storage is optional */
  }
}

const vendorLayoutPending = new Set();
const vendorLayoutReason = new Map();
const vendorLayoutLane = createPrioritySerialLane();
let layoutAbort = new AbortController();
let layoutEpoch = 0;
let layoutClosed = false;

/** Stop bumps layoutEpoch. An attempt keeps the epoch it was scheduled with. */
function layoutAttemptLive(epoch) {
  return !layoutClosed && epoch === layoutEpoch && !layoutAbort.signal.aborted;
}

/** Page close: stop fill-ins, the document job, and any layout POST that has not started. */
function closeViewerWork() {
  layoutClosed = true;
  abortTranslateSession(session);
  abortInflightLayouts();
  void importBinding?.close?.();
}

function abortError() {
  const error = new Error("layout aborted");
  error.name = "AbortError";
  error.code = "aborted";
  return error;
}

/** A retry that then succeeds must not leave the zoning-failure line up. */
function clearLayoutFallbackStatus() {
  const showing = layoutNotice === LAYOUT_FALLBACK_STATUS || $("status")?.textContent === LAYOUT_FALLBACK_STATUS;
  if (layoutNotice === LAYOUT_FALLBACK_STATUS) layoutNotice = "";
  if (showing && !pdfTranslateBusy(session)) setStatus("");
}

/**
 * Drop layout POSTs that have not been sent. An in-flight POST keeps the
 * signal it already started with; this aborts that signal too. The lane
 * generation fails anything still queued, so Stop cannot leave a later
 * page to start after the click. The viewer stays open for a retranslate.
 */
function cancelQueuedVendorLayouts() {
  layoutEpoch += 1;
  try {
    layoutAbort.abort();
  } catch {
    /* already aborted */
  }
  layoutAbort = new AbortController();
  vendorLayoutLane.reset();
}

/** Drop in-flight layout POSTs. The sidecar is one request at a time; a closed tab must not keep it. */
function abortInflightLayouts() {
  abortBackgroundFills();
  cancelQueuedVendorLayouts();
}

/**
 * One sidecar POST at a time. Retry backoff waits outside the lane, so the
 * page on screen is not stuck behind another page's 429/5xx sleeps.
 */
function postVendorLayout(page, run, epoch) {
  const stopped = () => docPhase === "stopped" || !layoutAttemptLive(epoch);
  if (stopped()) return Promise.reject(abortError());
  const key = Number(page) || 0;
  let notified = false;
  return runLaneAttempts(vendorLayoutLane, key, (attempt) => {
    if (stopped()) throw abortError();
    return run({
      signal: layoutAbort.signal,
      maxAttempts: 1,
      shouldStop: stopped,
      onNetworkFailure: attempt === 0 && !notified
        ? () => {
          notified = true;
        }
        : undefined
    });
  }, {
    priority: key === Number(pageNum),
    abortError,
    shouldStop: stopped
  });
}

async function ingestVendorLayout(n, mode, isStale, epoch) {
  if (docPhase === "stopped" || !layoutAttemptLive(epoch)) {
    vendorLayoutReason.set(n, "aborted");
    return null;
  }
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
  // The full probe, including the 8765 retries, keeps running for saved
  // translations. Zoning waits for the IndexedDB read, and only until
  // LIBRARY_ZONE_HARD_MS from the start of the open. Past that cap the page
  // requests zoning. settleFreshZone and the two current-layout checks still
  // refuse to overwrite a layout that arrives later. A blocked open is
  // noticed from the flag and does not sit out the 10s deadline.
  // The migration GET has to be in flight before the zoning decision. A slow
  // IndexedDB open used to hold that GET past the 1.5s cap, so page 1 was
  // zoned before the unknown legacy row existed.
  void ensureLibraryDocument();
  const zoneWait = await waitForFirstZone(hash, {
    layoutRead: () => readStoredLayout(key),
    engine: mode
  });
  const zone = await waitForZoneMigration(hash, zoneWait, {
    page: n,
    version,
    engine: mode
  });
  if (zone.document && (!libraryDoc || libraryDoc.hash !== hash)) {
    if (!zone.document.hash) zone.document.hash = hash;
    libraryDoc = zone.document;
  }
  // Stop during the raster or the zone wait. The epoch was captured when this
  // attempt was scheduled, so a POST that has not been sent does not start.
  if (docPhase === "stopped" || !layoutAttemptLive(epoch) || isStale()) {
    vendorLayoutReason.set(n, "aborted");
    return null;
  }
  // A source-v3 entry with no revision, or an older revision, is not the current
  // block structure. Library page layouts follow the same rule.
  let mapped = layoutCurrentForEngine(zone.cached, version, mode)
    || layoutCurrentForLibrary(libraryEntry(n), version, mode);
  let recomputed = false;
  if (!mapped) {
    try {
      const envelope = await postVendorLayout(n, ({ signal, maxAttempts, onNetworkFailure, shouldStop }) => {
        if (docPhase === "stopped" || !layoutAttemptLive(epoch)) throw abortError();
        const notify = () => {
          if (typeof onNetworkFailure === "function") onNetworkFailure();
          if (isStale()) return;
          layoutNotice = LAYOUT_FALLBACK_STATUS;
          if (!pdfTranslateBusy(session)) setStatus(layoutNotice);
        };
        const stop = () => docPhase === "stopped" || (typeof shouldStop === "function" && shouldStop());
        return mode === "cloud-ocr"
          ? fetchCloudEnvelope({
            baseUrl: settings.cloudBaseUrl,
            apiKey: settings.cloudApiKey,
            model: settings.cloudModel,
            pngDataUrl: png,
            signal,
            maxAttempts,
            shouldStop: stop,
            onNetworkFailure: notify
          })
          : fetchLocalEnvelope({
            baseUrl: settings.localBaseUrl,
            page: n,
            imageBase64: png.replace(/^data:image\/png;base64,/, ""),
            pixelWidth: raster.pixelWidth,
            pixelHeight: raster.pixelHeight,
            signal,
            maxAttempts,
            shouldStop: stop,
            onNetworkFailure: notify
          });
      }, epoch);
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
      // The engine that produced this POST. A mismatch re-zone used to skip
      // the stamp whenever recomputed was false, and the row was saved as text-layer.
      stampProducedEngine(mapped, mode);
      const settled = await settleFreshZone({
        hash,
        page: n,
        version,
        reason: zone.reason,
        engine: mode,
        cachedRead: () => (zone.layoutToken?.state === "ok" ? zone.layoutToken.value : null),
        write: () => {
          if (!layoutAttemptLive(epoch)) return Promise.resolve();
          return writeStoredLayout(key, mapped);
        }
      });
      if (settled.layout) mapped = settled.layout;
      recomputed = settled.recomputed;
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
  const arrived = currentLayoutIfArrived({
    hash,
    page: n,
    version,
    engine: mode,
    cached: zone.layoutToken?.state === "ok" ? zone.layoutToken.value : null
  });
  if (arrived) {
    mapped = arrived;
    recomputed = false;
  }
  stampLayoutBids(n, mapped);
  let blocks = await cropLayoutBlocks(raster, page, mapped.blocks, n, isStale);
  if (!blocks || isStale()) return null;
  const latePaint = currentLayoutIfArrived({
    hash,
    page: n,
    version,
    engine: mode,
    cached: zone.layoutToken?.state === "ok" ? zone.layoutToken.value : null
  });
  if (latePaint) {
    mapped = latePaint;
    recomputed = false;
    blocks = latePaint.blocks;
  }
  const layout = stampBodyFont({
    ...mapped,
    kind: "blocks",
    ...(version ? { layoutVersion: version } : {}),
    blocks,
    itemCount: extractPageItems(content).length
  }, content.items, viewport);
  if (recomputed && !layoutAttemptLive(epoch)) return null;
  if (recomputed) stampProducedEngine(layout);
  setPageLayout(n, layout);
  if (!isStale()) clearLayoutFallbackStatus();
  if (recomputed && layoutAttemptLive(epoch)) persistPageLayout(n).catch(() => {});
  else if (zone.reason === "cap" || zone.reason === "unavailable") {
    void whenZoneReadSettles(hash).then((entry) => {
      if (!layoutAttemptLive(epoch) || entry?.state === "error") return;
      const still = currentLayoutIfArrived({
        hash,
        page: n,
        version,
        engine: mode,
        cached: zone.layoutToken?.state === "ok" ? zone.layoutToken.value : null
      });
      if (still || !layoutAttemptLive(epoch)) return;
      persistPageLayout(n).catch(() => {});
    });
  }
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
  if (n === 1) {
    page1TextItems = content.items;
    page1Viewport = viewport;
    syncArxivOffer();
  }
  const built = textLayerToBlocks({ items: content.items, viewport, images, page: n });
  const raster = await renderPageRaster(page);
  if (isStale()) return null;
  stampLayoutBids(n, built);
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
  if (!fallback) stampTextLayerEngine(layout);
  // The quick stand-in (persist: false) is replaced by the vendor layout.
  // Re-anchoring it marks 位置近似 notes lost, then the real layout writes them back.
  setPageLayout(n, layout, { reanchor: options.persist !== false });
  if (fallback) persistPageLayout(n).catch(() => {});
  else if (options.persist !== false) persistDisplayedLayout(n).catch(() => {});
  return layout;
}

async function renderPageRaster(page) {
  const hold = viewerUnderTest() ? Number(globalThis.__oiHoldRasterMs) || 0 : 0;
  if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
  const viewport = page.getViewport({ scale: CROP_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = formulaDrawContext(canvas);
  await renderPdfPage(page, { canvasContext: context, viewport }).promise;
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
  stampLayoutBids(n, sample);
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
  // A skip lock has no body units. A failed title on that page is still sent;
  // otherwise pageSkipReason stops on titleStructureFailed and slotsDone stays false.
  const retryFailedTitle = titleStructureFailed(n);
  if (skipLocked.has(n) && !retryFailedTitle) return [];
  const epoch = layoutEpoch;
  if (docPhase === "stopped" || !layoutAttemptLive(epoch)) return [];
  const isStale = () => gen !== restoreGen || translatingDoc !== docId || docPhase === "stopped" || !layoutAttemptLive(epoch);
  const layout = getPageLayout(n) || (await ingestPageLayout(n, isStale, epoch));
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
    await rememberLandedStructure(n, translatingDoc);
    if (isStale()) return [];
    $("status")?.classList.remove("warn");
  }
  if (skipLocked.has(n)) return [];
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
    // P-A whitelist: one fetch of a user PDF URL. The failure copy depends on that single throw.
    const res = await fetch(src);
    if (!res.ok) throw new Error("fetch");
    await openPdfData(new Uint8Array(await res.arrayBuffer()), src);
  } catch {
    setStatus(PDF_COPY.fetchFail, true);
    setHasDoc(false);
  }
}

async function openPdfData(data, title) {
  rememberLibraryIdentity(title);
  setStatus(PDF_COPY.loading);
  pdfBytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data || []);
  const loading = getDocument({ data, verbosity: 0 });
  await adoptDoc(await loading.promise, title);
}

async function adoptDoc(doc, title) {
  resetArxivSession();
  // A new document, including the same PDF opened again in this tab, may
  // adopt what was saved. The set stays for a retry that does not adopt:
  // those pages were saved without a failed flag, and adopting them would
  // drop bypassCache on the failed batch.
  librarySourceSent.clear();
  libraryOriginalStored.clear();
  resetLibraryWriteStops();
  libraryOpenNotedAt = Date.now();
  if (pdfDoc) {
    try {
      await pdfDoc.destroy();
    } catch {
      /* previous doc may already be destroyed */
    }
  }
  layoutClosed = false;
  abortTranslateSession(session);
  abortBackgroundFills();
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
  formulaModelCrops.clear();
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
  resetMmPages();
  vendorLayoutPending.clear();
  vendorLayoutReason.clear();
  docPhase = "opening";
  notePageState(1, { state: "layout", hasLayout: false });
  libraryArticle = null;
  libraryDoc = null;
  libraryProbe = null;
  notesDocHash = "";
  notesUi?.onDocumentReset();
  askUi?.onDocumentReset();
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
  void maybeShowPersistCard();
  // Read this document's hint key only. The local area also holds layout
  // cache and notes, so opening must not scan every stored item.
  void resolveNotesDocHash().then(async (hash) => {
    if (hash && hash !== "nohash") {
      await notesPrefsSession.loadDocHint(hash);
      void flushStagedNotes(hash, { quiet: true });
    }
    notesUi?.onDocument(hash);
  });
  await buildPages();
  if (!syncMiniFitZoom()) {
    requestAnimationFrame(() => {
      if (!syncMiniFitZoom()) requestAnimationFrame(() => syncMiniFitZoom());
    });
  }
  updatePager();
  await scheduleVisibleRenders();
  setStatus("原页已打开，正在读取文字层…");
  beginPageNav();
  try {
    await loadCurrentPageText();
  } finally {
    endPageNav();
  }
  syncZoomChip();
  // The paper row is written as soon as the hash is known. The original
  // blob still waits until page writes settle.
  scheduleOpenedPdf(docId);
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

function beginPageNav() {
  pageNavDepth += 1;
  if (document.documentElement) document.documentElement.dataset.oiPageNav = "run";
}

function endPageNav() {
  pageNavDepth = Math.max(0, pageNavDepth - 1);
  if (pageNavDepth === 0 && document.documentElement) document.documentElement.dataset.oiPageNav = "idle";
}

async function goPage(dir) {
  if (!pdfDoc) return;
  const origin = sourceNavPage() || pageNum;
  const next = pageIndex(origin, pdfDoc.numPages, dir);
  if (next === origin) return;
  const gen = ++navGen;
  beginPageNav();
  try {
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
  } finally {
    endPageNav();
  }
}

function formulaCropPlanKeyNow() {
  const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
  const mirror = Number(mirrorZoom) > 0 ? Number(mirrorZoom) : 1;
  const left = Number(zoom) > 0 ? Number(zoom) : 1;
  const avail = paperAvailWidth(translateScrollRoot()?.clientWidth || 0);
  return `${mirror.toFixed(4)}|${left.toFixed(4)}|${dpr.toFixed(3)}|${avail.toFixed(1)}|${readerShownFont()}`;
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
let formulaCropJob = null;
let formulaCropPending = false;

function preemptFormulaCropRender() {
  formulaCropPending = true;
  const task = formulaCropRenderTask;
  formulaCropRenderTask = null;
  if (!task) return;
  try {
    task.cancel();
  } catch {
    /* already finished */
  }
}

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
  // A resize storm used to start one walk per event and leave every walk's
  // page.render() scheduling slice timers. One walk runs at a time. A newer
  // plan cancels the block currently drawing and is applied once after it.
  if (formulaCropJob) {
    preemptFormulaCropRender();
    return;
  }
  const root = document.documentElement;
  let finishWalk = () => {};
  formulaCropJob = new Promise((resolve) => {
    finishWalk = resolve;
  });
  (async () => {
    if (root) root.dataset.oiFormulaCrop = "run";
    try {
      do {
        formulaCropPending = false;
        const key = formulaCropPlanKeyNow();
        const total = Number(pdfDoc?.numPages) || 0;
        let changed = false;
        for (let n = 1; n <= total; n += 1) {
          if (formulaCropPending || !pdfDoc) break;
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
          if (formulaCropPending || !pdfDoc) break;
          const raster = {
            pixelWidth: layout.pixelWidth,
            pixelHeight: layout.pixelHeight
          };
          let pageDone = true;
          for (const block of layout.blocks) {
            if (formulaCropPending || !pdfDoc) {
              pageDone = false;
              break;
            }
            if (!isSourceRedrawBlock(block) || !block.imageUrl) continue;
            let sharp = "";
            try {
              sharp = await renderSharpFormulaCrop(page, raster, block, n);
            } finally {
              formulaCropRenderTask = null;
            }
            if (formulaCropPending) {
              pageDone = false;
              break;
            }
            if (sharp && sharp !== block.imageUrl) {
              block.imageUrl = sharp;
              block.surface = "redraw";
              changed = true;
              clearSlotPainted(n);
            }
          }
          if (!pageDone) break;
          noteFormulaCropPlan(layout);
        }
        if (changed) renderArticle();
      } while (formulaCropPending && pdfDoc);
    } finally {
      formulaCropJob = null;
      if (!formulaCropPending && root) root.dataset.oiFormulaCrop = "idle";
      finishWalk();
    }
    if (formulaCropPending) {
      formulaCropPending = false;
      if (pdfDoc) refreshFormulaCropsForDisplay();
      else if (root) root.dataset.oiFormulaCrop = "idle";
    }
  })();
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
  const serial = (view.renderSerial = (view.renderSerial || 0) + 1);
  // A round trip of the mini divider can land back on this zoom while the
  // previous render is still drawing. Returning here used to bump the serial
  // and leave that render running, so the canvas kept the other scale.
  if (view.renderedScale === zoom && view.canvas.width && !view.renderTask) {
    view.canvas.hidden = false;
    return;
  }
  const page = await pdfDoc.getPage(view.num);
  if (serial !== view.renderSerial) return;
  const viewport = page.getViewport({ scale: zoom });
  const canvas = view.canvas;
  const context = canvas.getContext("2d", { alpha: false });
  const outputScale = canvasOutputScale(viewport.width, viewport.height, window.devicePixelRatio || 1);
  if (view.renderTask) {
    const pending = view.renderTask;
    try {
      pending.cancel();
    } catch {
      /* already finished */
    }
    // The cancelled task stays on the view so a third caller can still cancel
    // it. pdf.js can also leave that promise pending; don't wait past 1s.
    await Promise.race([
      pending.promise.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
  }
  if (serial !== view.renderSerial) return;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  let task = null;
  try {
    task = renderPdfPage(page, { canvasContext: context, viewport, transform });
    view.renderTask = task;
    await task.promise;
    if (task && view.renderTask === task) view.renderTask = null;
    if (serial !== view.renderSerial) return;
    canvas.hidden = false;
    view.renderedScale = zoom;
  } catch (err) {
    if (view.renderTask === task) view.renderTask = null;
    if (err?.name === "RenderingCancelledException") return;
    if (serial !== view.renderSerial) return;
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
async function upgradeStoredFallback(n, mode, isStale, epoch) {
  if (docPhase === "stopped" || !layoutAttemptLive(epoch)) return;
  const laid = await ingestVendorLayout(n, mode, isStale, epoch);
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
  if (stale()) return;
  await layoutVersionNow();
  if (stale()) return;
  const seed = async () => {
    if (stale() || !libraryDoc) return;
    const libraryChanged = seedLibraryProgress();
    const legacyChanged = await seedLegacySkipPages();
    if (stale()) return;
    const sized = await stampPendingVisualPages(stale);
    if (stale()) return;
    if (libraryChanged || legacyChanged || sized) renderArticle();
    // Stored library layouts have no image bytes. Hydrate after they land;
    // an earlier pass sees an empty cache and returns without scheduling.
    hydrateMissingVisualCrops(stale).catch(() => {});
  };
  // The probe's 400/1000/1800ms delays used to sit on the page-turn await.
  // Layout paints first. Pairs land when the probe resolves.
  if (libraryDoc) await seed();
  else ensureLibraryDocument().then(() => seed()).catch(() => {});
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
  const epoch = layoutEpoch;
  await primeKnownPages();
  if (isStale()) return;
  const version = knownLayoutVersion || await layoutVersionNow();
  const openedStored = getPageLayout(n);
  const openedEngine = pdfEngineMode();
  if (openedStored?.blocks?.length && storedLayoutDisplayable(openedStored, version) && layoutServesEngine(openedStored, openedEngine)) {
    if (!showOpenedLayout(openedStored, isStale)) return;
    const saved = await savedTranslationForNav(n);
    if (!libraryDoc) paintLateLibrary(n, ticket);
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
    if (!layoutCurrentForEngine(openedStored, version, openedEngine) && (openedEngine === "local-ocr" || openedEngine === "cloud-ocr")) {
      upgradeStoredFallback(n, pdfEngineMode(), () => isStale() || !layoutAttemptLive(epoch), epoch).catch(() => {});
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
    preloadedSaved = await savedTranslationForNav(n);
    if (!libraryDoc) paintLateLibrary(n, ticket);
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
      const saved = preloadedSaved || await savedTranslationForNav(n);
      if (!libraryDoc) paintLateLibrary(n, ticket);
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
      const laid = await ingestVendorLayout(n, mode, () => isStale() || !layoutAttemptLive(epoch), epoch);
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
      : await ingestPageLayout(n, () => isStale() || !layoutAttemptLive(epoch), epoch);
    if (!showOpenedLayout(layout, isStale)) return;
    await ensuring;
    const saved = preloadedSaved || await savedTranslationForNav(n);
    if (!libraryDoc) paintLateLibrary(n, ticket);
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
  if (!isStale()) hydrateMissingVisualCrops(isStale).catch(() => {});
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
  const notesBtn = $("notesButton");
  if (notesBtn) notesBtn.disabled = !has;
  const menuNotes = $("menuNotes");
  if (menuNotes) {
    menuNotes.disabled = !has;
    menuNotes.setAttribute("aria-disabled", has ? "false" : "true");
  }
  if (!has) notesUi?.close(false);
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
  if (!pdfTranslateBusy(session) && backgroundSessions.active) {
    $("stopTranslate").hidden = false;
    $("stopTranslate").disabled = false;
  }
  syncExportControls();
  syncMirrorZoomButtons();
}

function setStatus(text, isError = false, isWarn = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("error", Boolean(isError));
  el.classList.toggle("warn", Boolean(isWarn) && !isError);
}
