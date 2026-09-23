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
  createWheelFlipGuard,
  planPaneFollow,
  readSoftPageFollow
} from "../lib/pdf-scroll.js";
import {
  PDF_PAPER_GUTTER_X,
  pagesInTranslateScope,
  paperAvailWidth,
  paperCssPx,
  readoutPaperSize
} from "../lib/pdf-paper.js";
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
  displayCropWidthCss,
  displayInkMinEm,
  blockRenderPieces,
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
import { inlineCropBoxEm, inlineLineTopEm, measureFormulaCrop, textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { applySavedPairs, blockSoftLead, createLibraryWriteQueue, fetchLibraryDocument, isSkipOnlyPage, libraryHoldCopy, libraryProbeFailure, pageSoftStatus, PAGE_STATUS_BIBLIOGRAPHY, pairsFromResults, repairMatrixProjectionPairs, replaceLibraryPagePairs, saveLibraryPage, selectSavedTranslation, storedReadoutBlocks } from "../lib/pdf-library.js";
import {
  applyStructureTranslations,
  isTitlePageCandidate,
  pageTextForStructure,
  resolveTitleStructure,
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
let softPageFollow = false;
let followGeneration = 0;
const syncOwner = createSyncOwner();
const wheelFlip = createWheelFlipGuard();
const pdfSyncGate = createScrollSyncGate();
const readoutSyncGate = createScrollSyncGate();
let translateScrollTick = 0;
let viewMode = "readout";
let mirrorZoom = DEFAULT_ZOOM;

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
  $("prev").addEventListener("click", () => goPage(-1));
  $("next").addEventListener("click", () => goPage(1));
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
  });
  document.querySelector(".scope-seg")?.addEventListener("click", onScopeClick);
  document.querySelector(".view-seg")?.addEventListener("click", onViewSegClick);
  $("paperStack")?.addEventListener("click", onReadoutBlockClick);
  bindPaperMetrics();
  bindPaneScroll();
  bindPdfScrollSettings();
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
  if (eventTargetIsField(event.target)) return;
  if (event.key === "ArrowLeft") goPage(-1);
  if (event.key === "ArrowRight") goPage(1);
  if (event.key === "-" || event.key === "_") setZoom(nextZoom(zoom, -1));
  if (event.key === "+" || event.key === "=") setZoom(nextZoom(zoom, 1));
}

function eventTargetIsField(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function bindPaneScroll() {
  const pdf = pdfScrollRoot();
  const readout = translateScrollRoot();
  pdf.addEventListener("scroll", onPdfScroll, { passive: true });
  pdf.addEventListener("scrollend", onPdfScrollEnd, { passive: true });
  pdf.addEventListener("pointerdown", () => takeDriver("pdf"), { passive: true });
  $("pdfPane").addEventListener("wheel", onPdfWheel, { passive: true });
  readout?.addEventListener("scroll", onTranslateScroll, { passive: true });
  readout?.addEventListener("scrollend", onReadoutScrollEnd, { passive: true });
  readout?.addEventListener("wheel", onReadoutWheel, { passive: true });
  readout?.addEventListener("pointerdown", () => takeDriver("readout"), { passive: true });
}

function takeDriver(side) {
  if (syncOwner.owner !== side) followGeneration += 1;
  syncOwner.claim(side);
}

function bindPdfScrollSettings() {
  loadPdfScrollPrefs();
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "sync" || !changes?.settings) return;
      softPageFollow = readSoftPageFollow(changes.settings.newValue);
    });
  } catch {
    /* opened outside the extension */
  }
}

async function loadPdfScrollPrefs() {
  try {
    const res = await runtimeSend({ type: "OI_GET_SETTINGS" });
    softPageFollow = readSoftPageFollow(res?.settings);
  } catch {
    softPageFollow = false;
  }
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
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  applySplit(workspace, event.clientX);
}

function applySplit(workspace, clientX) {
  const rect = workspace.getBoundingClientRect();
  if (rect.width <= 0) return;
  const pct = Math.min(80, Math.max(20, ((clientX - rect.left) / rect.width) * 100));
  workspace.style.setProperty("--oi-split", `${pct}%`);
  workspace.style.gridTemplateColumns = `${pct}% ${100 - pct}%`;
  syncZoomChip();
  syncMirrorZoomChip();
  applyPaperMetrics();
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
      protect: block.formulaInkProtect === true
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
  return cropBlockImage(raster?.canvas, block?.bbox);
}

function withRasterCrop(raster, block) {
  if (!isVisualBlock(block) || !Array.isArray(block.bbox)) return block;
  const next = { ...block };
  next.imageUrl = imageForVisualBlock(raster, next);
  return next;
}

function cropImage(block) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(block?.imageUrl || "")) return null;
  const img = document.createElement("img");
  img.alt = visualAlt(block.label);
  img.src = block.imageUrl;
  return img;
}

function appendCropOrNotice(node, block, imageClass) {
  const img = cropImage(block);
  if (img) {
    img.className = imageClass || "oi-pdf-math-crop";
    const pageFraction = displayCropColumnFraction(block);
    if (pageFraction) {
      const bboxH = Number(block.bbox[3]) - Number(block.bbox[1]);
      const minEm = displayInkMinEm(block.inkShare);
      img.style.width = displayCropWidthCss(pageFraction, bboxH, minEm);
      img.style.minHeight = `${minEm}em`;
    }
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
    span.style.setProperty("--oi-pdf-inline-crop-em", `${inlineCropBoxEm(formula?.inkShare)}em`);
    span.style.setProperty("--oi-pdf-inline-line-em", `${inlineLineTopEm(formula?.inkShare)}em`);
    if (formula?.id) {
      span.dataset.blockId = String(formula.id);
      span.dataset.label = "formula";
      if (node.dataset.page) span.dataset.page = node.dataset.page;
    }
    if (img) {
      img.className = "oi-pdf-math-crop";
      span.append(img);
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
      if (run.length && run.every((item) => item.authorCell?.name)) {
        renderAuthorGrid(parent, run.map((item) => item.authorCell));
      } else {
        const node = document.createElement("p");
        node.className = "oi-pdf-p";
        node.dataset.role = "authors";
        node.dataset.page = String(page);
        node.textContent = run.map((item) => item.text || "").filter(Boolean).join(" ");
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
      appendCropOrNotice(node, visual, plan.imageClass);
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
    if (plan.image) appendCropOrNotice(node, block, plan.imageClass);
    else fillBlockText(node, block, layout);
    if (block.translationStatus) node.dataset.translationStatus = block.translationStatus;
    node.dataset.page = String(page);
    node.dataset.blockId = String(block.id || "");
    node.dataset.label = String(block.label || "");
    if (block.label === "heading") {
      decorateAbstractHeading(node, block.text);
      decorateAbstractHeading(node, block.translation);
    }
    parent.append(node);
  }
}

function onReadoutBlockClick(event) {
  const node = event.target.closest?.("[data-block-id]");
  if (!node?.dataset?.blockId) return;
  const page = Number(node.dataset.page);
  const wrap = document.querySelector(`#pages .pdf-page[data-page="${page}"]`);
  takeDriver("click");
  if (pdfDoc && Number.isFinite(page) && page >= 1 && page !== pageNum) {
    pageNum = page;
    updatePager();
    loadCurrentPageText();
  }
  if (wrap) wrap.scrollIntoView({ block: "start", behavior: PANE_SYNC_BEHAVIOR });
  const layout = getPageLayout(page);
  const block = (layout?.blocks || []).find((item) => item.id === node.dataset.blockId);
  paintSourceMark(wrap, block?.bbox);
}

function paintSourceMark(wrap, bbox) {
  document.querySelectorAll(".mirror-source-mark").forEach((el) => el.remove());
  if (!wrap || !Array.isArray(bbox) || bbox.length < 4) return;
  const [x0, y0, x1, y1] = bbox;
  const mark = document.createElement("div");
  mark.className = "mirror-source-mark";
  mark.style.left = `${x0 * 100}%`;
  mark.style.top = `${y0 * 100}%`;
  mark.style.width = `${(x1 - x0) * 100}%`;
  mark.style.height = `${(y1 - y0) * 100}%`;
  wrap.append(mark);
}

function syncReadoutEmpty(hasArticle) {
  const copy = readoutPlaceholder({ running: pdfTranslateBusy(session), hasArticle });
  $("emptyRead").hidden = copy !== PDF_COPY.translateHint;
  $("pendingRead").hidden = copy !== PDF_COPY.translatingWait;
}

function paperStackEl() {
  return $("paperStack");
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

function applyPaperMetrics() {
  const stack = paperStackEl();
  const scroll = translateScrollRoot();
  if (!stack || !scroll) return;
  const avail = paperAvailWidth(scroll.clientWidth, PDF_PAPER_GUTTER_X);
  stack.querySelectorAll(".readout-paper").forEach((paper) => {
    const left = leftPageBox(paper.dataset.page);
    if (!left) return;
    const size = readoutPaperSize({
      leftWidth: left.width,
      leftHeight: left.height,
      availWidth: avail
    });
    if (!(size.width > 0)) return;
    paper.style.setProperty("--oi-pdf-paper-w", paperCssPx(size.width));
    paper.style.setProperty("--oi-pdf-paper-h-base", paperCssPx(size.heightBase));
    paper.style.setProperty("--oi-pdf-left-w", paperCssPx(left.width));
  });
}

function bindPaperMetrics() {
  const watch = () => applyPaperMetrics();
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
  const stack = paperStackEl();
  if (!stack || page == null || page === "") return null;
  const key = String(page);
  let paper = stack.querySelector(`.readout-paper[data-page="${key}"]`);
  if (!paper) {
    paper = document.createElement("article");
    paper.className = "readout-paper";
    paper.dataset.page = key;
    const type = document.createElement("div");
    type.className = "readout-type";
    const readout = document.createElement("div");
    readout.className = "readout md-readout";
    type.append(readout);
    paper.append(type);
    stack.append(paper);
  }
  return paper.querySelector(".readout");
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

function renderArticle() {
  const pane = translateScrollRoot();
  const keep = pane ? pane.scrollTop : 0;
  const stack = paperStackEl();
  if ($("mirrorPages")) $("mirrorPages").replaceChildren();
  if (stack) stack.replaceChildren();
  if (libraryArticle?.length && scopeShowsPage(1)) {
    renderStoredArticle(libraryArticle);
    applyViewMode();
    syncReadoutEmpty(true);
    applyPaperMetrics();
    if (pane) pane.scrollTop = keep;
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
    syncReadoutEmpty(false);
    updateTranslateControls();
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
  stack?.querySelectorAll(".readout-paper").forEach((paper) => {
    if (!paper.querySelector(".readout")?.childNodes.length) paper.remove();
  });
  if (!stack?.querySelector(".readout-paper")) {
    syncReadoutEmpty(false);
    updateTranslateControls();
    return;
  }
  syncReadoutEmpty(true);
  applyPaperMetrics();
  if (pane) pane.scrollTop = keep;
  updateTranslateControls();
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
  $("exportMd").disabled = ui.mdDisabled;
  $("exportPdf").disabled = ui.pdfDisabled;
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
  if (!pdfDoc) return;
  if (syncOwner.ignores("readout")) return;
  takeDriver("readout");
  if (translateScrollTick) return;
  const generation = followGeneration;
  readoutSyncGate.begin();
  translateScrollTick = requestAnimationFrame(() => {
    translateScrollTick = 0;
    try {
      if (generation !== followGeneration || syncOwner.owner !== "readout") return;
      const pane = translateScrollRoot();
      if (!pane) return;
      const rects = [...pane.querySelectorAll(".readout-paper[data-page]")].map((el) => {
        const box = el.getBoundingClientRect();
        return { page: Number(el.dataset.page), top: box.top, bottom: box.bottom };
      });
      if (!rects.length) return;
      const paneRect = pane.getBoundingClientRect();
      const next = pageFromViewport(rects, paneRect.top, paneRect.bottom);
      if (next === pageNum) return;
      const fromPage = pageNum;
      const plan = planPaneFollow({
        softPageFollow,
        owner: syncOwner.owner,
        driver: "readout",
        fromPage,
        toPage: next
      });
      if (!plan.align || plan.behavior !== PANE_SYNC_BEHAVIOR) return;
      pageNum = next;
      updatePager();
      loadCurrentPageText();
      syncPdfToPage(next);
      scheduleVisibleRenders();
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
  takeDriver("readout");
}

function writeAnchorScroll(pane, node) {
  if (!pane || !node) return false;
  const paneRect = pane.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  if (!shouldSyncReadout(nodeRect.top, paneRect.top)) return false;
  const top = alignScrollTop(pane, node);
  if (!Number.isFinite(top)) return false;
  pane.scrollTop = top;
  return true;
}

function syncPdfToPage(page) {
  const view = pageViews[page - 1];
  return writeAnchorScroll(pdfScrollRoot(), view?.wrap || null);
}

function syncReadoutToPage(page) {
  const pane = translateScrollRoot();
  const node = paperStackEl()?.querySelector(`.readout-paper${readoutPageSelector(page)}`);
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

async function ensureTitleStructure(page, layout) {
  if (titleStructure && titleStructure.docId === docId) return titleStructure;
  const text = pageTextForStructure(layout?.blocks || []);
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
    await ensureTitleStructure(targetPage, sourceLayout);
    if (left()) return;
    armTitleRetranslate(translatingDoc, targetPage);
    await translateTitleStructure(work, gen, translatingDoc, batchSize);
    if (left()) return;
    const translated = await translatePageBlocks(units, {
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
      mapped = vendorLayoutToBlocks(envelope, { items: content.items, viewport, images, page: n });
      await writeStoredLayout(key, mapped);
    } catch (err) {
      if (!isStale() && err?.code !== "empty-key") layoutNotice = LAYOUT_FALLBACK_STATUS;
      return null;
    }
  }
  if (isStale()) return null;
  const blocks = (mapped.blocks || []).map((block) => withRasterCrop(raster, block));
  const layout = {
    ...mapped,
    kind: "blocks",
    blocks,
    itemCount: extractPageItems(content).length
  };
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
  const built = textLayerToBlocks({ items: content.items, viewport, images, page: n });
  const raster = await renderPageRaster(page);
  if (isStale()) return null;
  const blocks = (built.blocks || []).map((block) => withRasterCrop(raster, block));
  const layout = {
    ...built,
    kind: "blocks",
    protocol: built.protocol || PROTOCOL,
    blocks,
    itemCount: extractPageItems(content).length
  };
  setPageLayout(n, layout);
  return layout;
}

async function renderPageRaster(page) {
  const viewport = page.getViewport({ scale: CROP_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: context, viewport }).promise;
  return { canvas, pixelWidth: canvas.width, pixelHeight: canvas.height };
}

async function ingestFixtureLayout(n, isStale) {
  const page = await pdfDoc.getPage(n);
  if (isStale()) return null;
  const sample = preparePageBlocks({ ...(await loadSamplePage()), page: n });
  if (isStale()) return null;
  const content = await page.getTextContent();
  if (isStale()) return null;
  const raster = await renderPageRaster(page);
  if (isStale()) return null;
  const blocks = sample.blocks.map((block) => withRasterCrop(raster, block));
  const layout = {
    kind: "blocks",
    protocol: sample.protocol || PROTOCOL,
    page: n,
    pixelWidth: raster.pixelWidth,
    pixelHeight: raster.pixelHeight,
    textSource: sample.textSource || "text-layer",
    blocks,
    itemCount: extractPageItems(content).length
  };
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
  const layout = {
    kind: "readout",
    blocks,
    itemCount: items.length,
    pageWidth: viewport.width,
    pageHeight: viewport.height
  };
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
  if (!pdfDoc || !pageViews.length) return;
  const current = measureVisible();
  if (current !== pageNum) {
    const fromPage = pageNum;
    const plan = planPaneFollow({
      softPageFollow,
      owner: syncOwner.owner,
      driver: "pdf",
      fromPage,
      toPage: current
    });
    pageNum = current;
    updatePager();
    loadCurrentPageText();
    if (currentScope() !== "all") {
      renderArticle();
      const readout = translateScrollRoot();
      if (readout) readout.scrollTop = 0;
    }
    if (plan.align && plan.behavior === PANE_SYNC_BEHAVIOR) syncReadoutToPage(current);
  }
  scheduleVisibleRenders();
}

async function goPage(dir) {
  if (!pdfDoc) return;
  const next = pageIndex(pageNum, pdfDoc.numPages, dir);
  if (next === pageNum) return;
  const fromPage = pageNum;
  takeDriver("pdf");
  pageNum = next;
  const view = pageViews[next - 1];
  view?.wrap.scrollIntoView({ block: "start", behavior: PANE_SYNC_BEHAVIOR });
  updatePager();
  loadCurrentPageText();
  if (currentScope() !== "all") {
    renderArticle();
    const readout = translateScrollRoot();
    if (readout) readout.scrollTop = 0;
  }
  const plan = planPaneFollow({
    softPageFollow,
    owner: syncOwner.owner,
    driver: "pdf",
    fromPage,
    toPage: next
  });
  if (plan.align && plan.behavior === PANE_SYNC_BEHAVIOR) syncReadoutToPage(next);
  await scheduleVisibleRenders();
}

function setMirrorZoom(next) {
  mirrorZoom = clampZoom(next);
  persistMirrorZoom(mirrorZoom);
  applyMirrorZoom();
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
  await scheduleVisibleRenders();
  syncZoomChip();
  syncZoomButtons();
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
