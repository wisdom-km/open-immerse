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
  blockRenderPieces,
  blockTranslationIntegrity,
  cropBlockImage,
  isVisualBlock,
  preparePageBlocks,
  translatableBlocks,
  visualAlt
} from "../lib/pdf-blocks.js";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";
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
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { applySavedPairs, createLibraryWriteQueue, fetchLibraryDocument, pairsFromResults, saveLibraryPage, selectSavedTranslation, storedReadoutBlocks } from "../lib/pdf-library.js";

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
let pageViews = [];
let scrollTick = 0;
const pageCache = createPageCache();
let libraryArticle = null;
let libraryDoc = null;
const librarySourceSent = new Set();
const enqueueLibraryWrite = createLibraryWriteQueue();
const layoutCache = new Map();
let session = createTranslateSession();
let zoomChipCustom = false;
let mirrorZoomChipCustom = false;
let exporting = false;
let syncLock = false;
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
  $("readout")?.addEventListener("click", onReadoutBlockClick);
  translateScrollRoot()?.addEventListener("scroll", onTranslateScroll, { passive: true });
  $("translatePage").addEventListener("click", () => startTranslate());
  $("stopTranslate").addEventListener("click", stopTranslateWork);
  $("restoreOriginal").addEventListener("click", restoreOriginal);
  $("exportMd").addEventListener("click", () => exportReadout("md"));
  $("exportPdf").addEventListener("click", () => exportReadout("pdf"));
  pdfScrollRoot().addEventListener("scroll", onPdfScroll, { passive: true });
  $("pdfPane").addEventListener("wheel", onPdfWheel, { passive: true });
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

function appendReadoutNode(input, parent = $("readout")) {
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

function cropImage(block) {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(block?.imageUrl || "")) return null;
  const img = document.createElement("img");
  img.alt = visualAlt(block.label);
  img.src = block.imageUrl;
  return img;
}

function appendCropOrNotice(node, block) {
  const img = cropImage(block);
  if (img) node.append(img);
  else node.textContent = `（${visualAlt(block.label)}裁图失败，请查看左栏原页）`;
}

function fillBlockText(node, block, layout) {
  if (block.translationStatus === "source-uncertain" && !block.translation) {
    node.textContent = "（本块原文顺序或译文对应关系尚不能可靠确认，请查看左栏原页）";
    return;
  }
  if (block.translationStatus === "pending" && !block.translation) {
    node.append(document.createTextNode("（译文待核对，以下为原文） "));
  }
  if (block.translation && !blockTranslationIntegrity(block).valid) {
    node.append(document.createTextNode("（译文中的公式或引用与原文不符，以下为原文） "));
  }
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
    if (img) node.append(img);
    else node.append(document.createTextNode("（公式裁图失败，请查看左栏原页）"));
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

function appendFixtureReadout(parent, layout) {
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
  for (const block of blocks) {
    if (block.inlineOf) continue;
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
    if (plan.image) appendCropOrNotice(node, block);
    else fillBlockText(node, block, layout);
    if (block.translationStatus) node.dataset.translationStatus = block.translationStatus;
    node.dataset.page = String(page);
    node.dataset.blockId = String(block.id || "");
    node.dataset.label = String(block.label || "");
    parent.append(node);
  }
}

function onReadoutBlockClick(event) {
  const node = event.target.closest?.("[data-block-id]");
  if (!node?.dataset?.blockId) return;
  const page = Number(node.dataset.page);
  const wrap = document.querySelector(`#pages .pdf-page[data-page="${page}"]`);
  if (wrap) wrap.scrollIntoView({ block: "start" });
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

function renderStoredArticle(blocks) {
  const flowRoot = $("readout");
  flowRoot.replaceChildren();
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
    flowRoot.append(node);
  }
}

function renderArticle() {
  const pane = translateScrollRoot();
  const keep = pane ? pane.scrollTop : 0;
  const flowRoot = $("readout");
  if ($("mirrorPages")) $("mirrorPages").replaceChildren();
  if (libraryArticle?.length) {
    renderStoredArticle(libraryArticle);
    applyViewMode();
    syncReadoutEmpty(true);
    if (pane) pane.scrollTop = keep;
    return;
  }
  flowRoot.replaceChildren();
  const pages = collectArticlePages(pageCache, docId, pdfDoc?.numPages || 0);
  applyViewMode();
  const blockPages = [];
  const total = pdfDoc?.numPages || 0;
  for (let n = 1; n <= total; n += 1) {
    const layout = getPageLayout(n);
    if (showsBlockReadout(layout)) blockPages.push(layout);
  }
  if (!pages.length && !blockPages.length) {
    syncReadoutEmpty(false);
    updateTranslateControls();
    return;
  }
  syncReadoutEmpty(true);
  if (blockPages.length) {
    blockPages.forEach((layout) => appendFixtureReadout(flowRoot, layoutForReadout(layout)));
  }
  pages.forEach(({ page, blocks }) => {
    if (blockPages.some((layout) => layout.page === page)) return;
    const flow = readoutFlowForPage(getPageLayout(page), blocks);
    flow.forEach((item) => {
      if (!item?.translation && !item?.latex) return;
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
  if (pane) pane.scrollTop = keep;
  updateTranslateControls();
}

function applyViewMode() {
  viewMode = "readout";
  if ($("mirrorPages")) $("mirrorPages").hidden = true;
  if ($("readout")) $("readout").hidden = false;
  if ($("viewSeg")) $("viewSeg").hidden = true;
  if ($("mirrorHint")) $("mirrorHint").hidden = true;
}

function onViewSegClick(event) {
  const btn = event.target.closest(".view-seg-btn");
  if (!btn) return;
  applyViewMode();
}

function currentReadoutNodes() {
  return collectReadoutExportNodes($("readout"));
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
  if (syncLock || !pdfDoc) return;
  if (translateScrollTick) return;
  translateScrollTick = requestAnimationFrame(() => {
    translateScrollTick = 0;
    const pane = translateScrollRoot();
    if (!pane) return;
    const rects = [...pane.querySelectorAll("[data-page]")].map((el) => {
      const box = el.getBoundingClientRect();
      return { page: Number(el.dataset.page), top: box.top, bottom: box.bottom };
    });
    if (!rects.length) return;
    const paneRect = pane.getBoundingClientRect();
    const next = pageFromViewport(rects, paneRect.top, paneRect.bottom);
    if (next === pageNum) return;
    pageNum = next;
    updatePager();
    loadCurrentPageText();
    const view = pageViews[next - 1];
    syncLock = true;
    view?.wrap.scrollIntoView({ block: "start", behavior: "smooth" });
    scheduleVisibleRenders();
    window.setTimeout(() => {
      syncLock = false;
    }, 360);
  });
}

function syncReadoutToPage(page) {
  if (syncLock) return;
  const pane = translateScrollRoot();
  const root = $("readout");
  const node = root?.querySelector(readoutPageSelector(page));
  if (!pane || !node) return;
  const paneRect = pane.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  if (!shouldSyncReadout(nodeRect.top, paneRect.top)) return;
  syncLock = true;
  node.scrollIntoView({ block: "start", behavior: "smooth" });
  window.setTimeout(() => {
    syncLock = false;
  }, 360);
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
  const pairs = pairsFromResults(results);
  if (!pairs.length) return Promise.resolve();
  // Capture this document before queuing: the user may open another PDF while
  // earlier pages are still being saved.
  const bytes = pdfBytes;
  const title = document.title;
  const pageCount = pdfDoc?.numPages || 0;
  const layout = cacheableLayout(getPageLayout(page));
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
    await saveLibraryPage({ hash, title, pageCount, page, pairs, layout, sourceBase64 });
    librarySourceSent.add(hash);
  });
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
  const selected = selectSavedTranslation(libraryDoc, page);
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

function savedPageStatus(saved, restored = []) {
  return (saved?.pairs || []).some((pair) => pair.status === "pending" || pair.status === "source-uncertain" ||
    !blockTranslationIntegrity(pair).valid) || restored.some((row) => row.translationStatus === "source-uncertain") ||
    saved?.migrated
    ? "本页旧译文有待核对的段落；原文已保留。"
    : PDF_COPY.done;
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
    if (saved?.pairs?.length) {
      const merged = applySavedPairs(pageOriginals, saved.pairs);
      pageCache.set(docId, pageNum, merged);
      pageResults = merged;
      renderArticle();
      setStatus(savedPageStatus(saved, merged));
      return;
    }
    if (saved?.migrated || libraryDoc?.pages?.length) {
      setStatus(savedPageStatus(saved));
      return;
    }
  } catch {
    setStatus("本地库不可用，无法确认是否已翻译。", true);
    return;
  }
  if (libraryArticle || pageHasTranslation(pageCache.get(docId, pageNum))) {
    setStatus(libraryArticle ? PDF_COPY.doneDocument : PDF_COPY.done);
    return;
  }
  if (!pageOriginals.length) {
    setStatus(pageBlocksCopy(0, pageItems) || PDF_COPY.emptyPage);
    syncNoTextLayerHint(pageItems <= 0);
    updateTranslateControls();
    return;
  }
  const gen = restoreGen;
  const translatingDoc = docId;
  const targetPage = pageNum;
  translatingPage = targetPage;
  const work = beginViewerSession();
  const sourceLayout = getPageLayout(targetPage);
  pageResults = emptyPageResults(sourceLayout);
  pageCache.set(translatingDoc, targetPage, pageResults);
  updateTranslateControls();
  setStatus(PDF_COPY.translating);
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
  const { aborted, results } = await translatePageBlocks(pageOriginals, {
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
  else if (!results.some((item) => item.translation)) setStatus(PDF_COPY.error, true);
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
      setStatus("本地库已有逐页记录；待核对段落不会自动重新翻译。");
      renderArticle();
      return;
    }
  } catch {
    setStatus("本地库不可用，无法确认是否已翻译。", true);
    return;
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
  setStatus(progressDocumentStatus(1, total));
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
    getPageOriginals: (page) => originalsForPage(page, gen, translatingDoc),
    onPageStart({ page, total: pageTotal }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      translatingPage = page;
      setStatus(progressDocumentStatus(page, pageTotal));
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
      const merged = layout?.kind === "blocks" ? results : mergeReadoutTranslations(layout?.blocks || results, results);
      pageCache.set(translatingDoc, page, merged);
      if (page === pageNum) pageResults = merged;
      renderArticle();
      saveTasks.push(rememberTranslation(page, merged).then(() => null, (error) => error));
    }
  });
  if (!isCurrentWork(work, gen, translatingDoc)) return;
  renderArticle();
  const any = pages.some((entry) => pageHasTranslation(entry.results));
  if (aborted) setStatus(PDF_COPY.stopped);
  else if (!any) setStatus(PDF_COPY.error, true);
  else setStatus(PDF_COPY.doneDocument);
  const saveErrors = await Promise.all(saveTasks);
  if (!aborted && saveErrors.some(Boolean)) setStatus("译文已生成，但部分页面写入本地库失败。", true);
  translatingPage = 0;
  updateTranslateControls();
}

function pageResultsFromTranslation(layout, results) {
  return layout?.kind === "blocks" ? results : mergeReadoutTranslations(layout?.blocks || [], results);
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
  const blocks = (mapped.blocks || []).map((block) => {
    if (!isVisualBlock(block) || !Array.isArray(block.bbox)) return block;
    return { ...block, imageUrl: cropBlockImage(raster.canvas, block.bbox) };
  });
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
  const blocks = (built.blocks || []).map((block) => {
    if (!isVisualBlock(block) || !Array.isArray(block.bbox)) return block;
    return { ...block, imageUrl: cropBlockImage(raster.canvas, block.bbox) };
  });
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
  const blocks = sample.blocks.map((block) => {
    if (!isVisualBlock(block) || !Array.isArray(block.bbox)) return block;
    return { ...block, imageUrl: cropBlockImage(raster.canvas, block.bbox) };
  });
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

async function originalsForPage(n, gen, translatingDoc) {
  const isStale = () => gen !== restoreGen || translatingDoc !== docId;
  const layout = getPageLayout(n) || (await ingestPageLayout(n, isStale));
  if (!layout || isStale()) return [];
  const blocks = unitsForLayout(layout);
  if (n === pageNum) pageOriginals = blocks;
  const cached = pageCache.get(translatingDoc, n);
  pageResults = pageHasTranslation(cached) ? cached : emptyPageResults(layout);
  if (!pageHasTranslation(cached)) pageCache.set(translatingDoc, n, pageResults);
  return blocks;
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

function onPdfScroll() {
  if (scrollTick) return;
  scrollTick = requestAnimationFrame(() => {
    scrollTick = 0;
    syncVisiblePage();
  });
}

function onPdfWheel(event) {
  if (!pdfDoc) return;
  const pane = pdfScrollRoot();
  const overflow = pane.scrollHeight - pane.clientHeight > 4;
  const atTop = pane.scrollTop <= 0;
  const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1;
  const dir = wheelPageDelta({ deltaY: event.deltaY, atTop, atBottom, overflow });
  if (dir) goPage(dir);
}

function syncVisiblePage() {
  if (!pdfDoc || !pageViews.length) return;
  const current = measureVisible();
  if (current !== pageNum) {
    pageNum = current;
    updatePager();
    loadCurrentPageText();
    syncReadoutToPage(current);
  }
  scheduleVisibleRenders();
}

async function goPage(dir) {
  if (!pdfDoc) return;
  const next = pageIndex(pageNum, pdfDoc.numPages, dir);
  if (next === pageNum) return;
  pageNum = next;
  const view = pageViews[next - 1];
  view?.wrap.scrollIntoView({ block: "start", behavior: "smooth" });
  updatePager();
  loadCurrentPageText();
  syncReadoutToPage(next);
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
  if ($("readout")) $("readout").style.setProperty("--oi-mirror-zoom", scale);
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
  const copy = pageBlocksCopy(pageOriginals.length, pageItems) || textLayerCopy(pageItems);
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
  const ensuring = runtimeSend({ type: "OI_ENSURE_GLMOCR" }).catch(() => null);
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
        const merged = applySavedPairs(unitsForLayout(quick), saved.pairs);
        pageResults = merged;
        pageCache.set(docId, n, merged);
        if (!pdfTranslateBusy(session)) setStatus(savedPageStatus(saved, merged));
        renderArticle();
        syncReadoutToPage(n);
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
      const merged = applySavedPairs(unitsForLayout(layout), saved.pairs);
      pageResults = merged;
      pageCache.set(docId, n, merged);
      setStatus(savedPageStatus(saved, merged));
      renderArticle();
      syncReadoutToPage(n);
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
    canTranslate
  });
  $("translatePage").disabled = ui.translateDisabled;
  $("translatePage").hidden = ui.translateHidden;
  $("stopTranslate").hidden = ui.stopHidden;
  $("stopTranslate").disabled = ui.stopDisabled;
  $("restoreOriginal").disabled = !pageHasTranslation(pageCache.get(docId, pageNum));
  setScopeEnabled(ui.scopeEnabled);
  syncExportControls();
  syncMirrorZoomButtons();
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", Boolean(isError));
}
