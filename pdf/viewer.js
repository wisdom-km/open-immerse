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
  readoutPageSelector,
  shouldSyncReadout,
  textLayerCopy,
  translateDocumentPages,
  translatePageBlocks,
  articleNodeSpec,
  normalizeBlockRole,
  pageCacheKey,
  zoomButtonState,
  zoomChipDefaultPos,
  zoomChipRightClearance,
  zoomLabel
} from "../lib/pdf-viewer.js";
import {
  PDF_MIRROR_COPY,
  appendOperatorImages,
  bboxAttr,
  buildMirrorLayout,
  cropCanvasToDataUrl,
  formulaRenderPlan,
  shouldRenderFormulaCrop,
  imageRectsFromUnitCtms,
  mergeMirrorTranslations,
  pageRectToPercent,
  percentRectToStyle,
  toMirrorItem,
  translatableMirrorUnits,
  walkImageCtms
} from "../lib/pdf-mirror.js";

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
const layoutCache = new Map();
let session = createTranslateSession();
let zoomChipCustom = false;
let exporting = false;
let syncLock = false;
let translateScrollTick = 0;
let viewMode = "mirror";

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
  bindSplitResize();
  initZoomChip();
  document.querySelector(".scope-seg")?.addEventListener("click", onScopeClick);
  document.querySelector(".view-seg")?.addEventListener("click", onViewSegClick);
  document.querySelector(".pane-translate")?.addEventListener("scroll", onTranslateScroll, { passive: true });
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
  if (input.page != null && input.page !== "") node.dataset.page = String(input.page);
  if (input.rect && input.pageWidth && input.pageHeight) {
    const item = toMirrorItem(
      { text: input.original || spec.text, role: spec.role, kind: input.kind || spec.role || "text", rect: input.rect },
      { page: input.page, translation: spec.text }
    );
    node.classList.add("mirror-box", "mirror-item");
    node.dataset.role = item.role;
    node.dataset.bbox = bboxAttr(item.bbox);
    node.dataset.kind = item.kind;
    Object.assign(node.style, percentRectToStyle(pageRectToPercent(input.rect, input.pageWidth, input.pageHeight)));
  }
  parent.append(node);
  syncReadoutEmpty(true);
  return node;
}

function syncReadoutEmpty(hasArticle) {
  const copy = readoutPlaceholder({ running: pdfTranslateBusy(session), hasArticle });
  $("emptyRead").hidden = copy !== PDF_COPY.translateHint;
  $("pendingRead").hidden = copy !== PDF_COPY.translatingWait;
}

function renderArticle() {
  const pane = document.querySelector(".pane-translate");
  const keep = pane ? pane.scrollTop : 0;
  const pagesRoot = $("mirrorPages");
  const flowRoot = $("readout");
  if (pagesRoot) pagesRoot.replaceChildren();
  flowRoot.replaceChildren();
  const pages = collectArticlePages(pageCache, docId, pdfDoc?.numPages || 0);
  const showMirror = pages.some(({ page, blocks }) => canMirrorPage(page, blocks));
  if (!pages.length) {
    syncReadoutEmpty(false);
    applyViewMode(false);
    updateTranslateControls();
    return;
  }
  syncReadoutEmpty(true);
  pages.forEach(({ page, blocks }) => {
    if (showMirror) appendMirrorPage(page, blocks);
    (blocks || []).forEach((item) => {
      if (!item?.original || !item.translation) return;
      appendReadoutNode(
        {
          translation: item.translation,
          role: item.role,
          page
        },
        flowRoot
      );
    });
  });
  applyViewMode(showMirror);
  if (pane) pane.scrollTop = keep;
  updateTranslateControls();
}

function applyViewMode(canMirror) {
  const mirrorOn = viewMode === "mirror" && Boolean(canMirror);
  if ($("mirrorPages")) $("mirrorPages").hidden = !mirrorOn;
  if ($("readout")) $("readout").hidden = mirrorOn;
  if ($("viewSeg")) $("viewSeg").hidden = !canMirror;
  if ($("mirrorHint")) $("mirrorHint").hidden = !mirrorOn;
  document.querySelectorAll(".view-seg-btn").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.view === viewMode);
  });
}

function onViewSegClick(event) {
  const btn = event.target.closest(".view-seg-btn");
  if (!btn) return;
  viewMode = btn.dataset.view === "readout" ? "readout" : "mirror";
  const pages = collectArticlePages(pageCache, docId, pdfDoc?.numPages || 0);
  applyViewMode(pages.some(({ page, blocks }) => canMirrorPage(page, blocks)));
}

function canMirrorPage(page, blocks) {
  const layout = getPageLayout(page);
  if (layout?.kind === "mirror") return true;
  return (blocks || []).some((item) => item?.rect);
}

function appendMirrorPage(page, blocks) {
  const layout = getPageLayout(page) || layoutFromBlocks(blocks);
  if (!layout || layout.kind === "empty") return;
  const pageEl = document.createElement("section");
  pageEl.className = "mirror-page";
  pageEl.dataset.page = String(page);
  pageEl.style.aspectRatio = `${layout.pageWidth} / ${layout.pageHeight}`;
  (layout.visuals || []).forEach((vis, index) => {
    if (vis.kind === "formula" && !shouldRenderFormulaCrop(vis)) return;
    pageEl.append(appendMirrorVisual(page, vis, index, layout));
  });
  (layout.boxes || []).forEach((box) => {
    if (box.kind !== "formula") return;
    const plan = box.render || formulaRenderPlan(box);
    if (plan.mode !== "unicode" || !plan.text) return;
    appendReadoutNode(
      {
        translation: plan.text,
        original: box.text,
        role: "formula",
        kind: "formula",
        page,
        rect: box.rect,
        pageWidth: layout.pageWidth,
        pageHeight: layout.pageHeight
      },
      pageEl
    );
  });
  mergeMirrorTranslations(layout, blocks).forEach((item) => {
    if (!item.translation) return;
    appendReadoutNode(
      {
        translation: item.translation,
        role: item.role,
        page,
        rect: item.rect,
        pageWidth: layout.pageWidth,
        pageHeight: layout.pageHeight
      },
      pageEl
    );
  });
  ($("mirrorPages") || $("readout")).append(pageEl);
}

function layoutFromBlocks(blocks) {
  const list = (blocks || []).filter((item) => item?.rect);
  if (!list.length) return null;
  const pageWidth = Number(list[0].pageWidth) || 612;
  const pageHeight = Number(list[0].pageHeight) || 792;
  const boxes = list.map((item) => ({
    text: item.original || item.text,
    role: item.role || "paragraph",
    kind: item.kind || "text",
    rect: item.rect
  }));
  return { kind: "mirror", pageWidth, pageHeight, boxes, visuals: [], translatable: boxes };
}

function appendMirrorVisual(page, vis, index, layout) {
  const ready = withVisualSrc(page, vis, layout);
  const fallback = vis.kind === "formula" ? PDF_MIRROR_COPY.formulaFallback : PDF_MIRROR_COPY.figureFallback;
  const node = ready.src ? document.createElement("img") : document.createElement("div");
  node.className = ready.src ? "mirror-visual mirror-item" : "mirror-visual mirror-item is-pending";
  node.dataset.visual = String(index);
  node.dataset.role = vis.kind === "formula" ? "formula" : "figure";
  node.dataset.kind = vis.kind || "figure";
  node.dataset.bbox = bboxAttr(vis.rect);
  node.dataset.page = String(page);
  Object.assign(node.style, percentRectToStyle(pageRectToPercent(vis.rect, layout.pageWidth, layout.pageHeight)));
  if (node.tagName === "IMG") {
    node.alt = vis.caption || fallback;
    node.draggable = false;
    node.src = ready.src;
  } else {
    node.textContent = fallback;
  }
  node.addEventListener("click", () => highlightSourcePage(page, vis.rect, layout));
  return node;
}

function highlightSourcePage(page, rect, layout) {
  document.querySelectorAll(".mirror-source-mark").forEach((el) => el.remove());
  const view = pageViews[page - 1];
  if (!view?.wrap) return;
  view.wrap.scrollIntoView({ block: "start", behavior: "smooth" });
  view.wrap.classList.add("is-mirror-target");
  if (rect && layout) {
    const mark = document.createElement("div");
    mark.className = "mirror-source-mark";
    Object.assign(mark.style, percentRectToStyle(pageRectToPercent(rect, layout.pageWidth, layout.pageHeight)));
    view.wrap.append(mark);
  }
  window.setTimeout(() => {
    view.wrap.classList.remove("is-mirror-target");
    view.wrap.querySelectorAll(".mirror-source-mark").forEach((el) => el.remove());
  }, 900);
}

function withVisualSrc(page, vis, layout) {
  if (vis?.src) return vis;
  const canvas = pageViews[page - 1]?.canvas;
  if (!canvas?.width) return vis || {};
  const src = cropCanvasToDataUrl(canvas, pageRectToPercent(vis.rect, layout.pageWidth, layout.pageHeight));
  return src ? { ...vis, src } : vis;
}

function refreshMirrorVisuals(page) {
  const layout = getPageLayout(page);
  const root = ($("mirrorPages") || $("readout"))?.querySelector(`.mirror-page[data-page="${page}"]`);
  if (!layout?.visuals?.length || !root) return;
  root.querySelectorAll(".mirror-visual").forEach((node) => {
    const index = Number(node.dataset.visual);
    const vis = layout.visuals[index];
    if (!vis) return;
    const ready = withVisualSrc(page, vis, layout);
    if (!ready.src) return;
    if (node.tagName === "IMG") {
      node.src = ready.src;
      node.classList.remove("is-pending");
      return;
    }
    node.replaceWith(appendMirrorVisual(page, { ...vis, src: ready.src }, index, layout));
  });
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
    const pane = document.querySelector(".pane-translate");
    if (!pane) return;
    if (viewMode !== "mirror") return;
    const rects = [...pane.querySelectorAll(".mirror-page")].map((el) => {
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
  const pane = document.querySelector(".pane-translate");
  const root = viewMode === "mirror" && $("mirrorPages") ? $("mirrorPages") : $("readout");
  const node =
    root.querySelector(`.mirror-page${readoutPageSelector(page)}`) ||
    root.querySelector(readoutPageSelector(page));
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

async function translateCurrentPage() {
  if (!pdfDoc || pdfTranslateBusy(session)) return;
  if (!pageOriginals.length) {
    setStatus(pageBlocksCopy(0, pageItems) || PDF_COPY.emptyPage);
    $("noTextLayerHint").hidden = pageItems > 0;
    updateTranslateControls();
    return;
  }
  const gen = restoreGen;
  const translatingDoc = docId;
  const targetPage = pageNum;
  translatingPage = targetPage;
  const work = beginViewerSession();
  pageResults = emptyPageResults(pageOriginals);
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
      pageCache.set(translatingDoc, targetPage, next);
      pageResults = next;
      renderArticle();
      if (res?.polishError) setStatus(PDF_COPY.polishFail, true);
    }
  });
  if (!isCurrentWork(work, gen, translatingDoc)) return;
  pageCache.set(translatingDoc, targetPage, results);
  pageResults = results;
  renderArticle();
  if (aborted) setStatus(PDF_COPY.stopped);
  else if (!results.some((item) => item.translation)) setStatus(PDF_COPY.error, true);
  else setStatus(PDF_COPY.done);
  translatingPage = 0;
  updateTranslateControls();
}

async function translateWholeDocument() {
  if (!pdfDoc || pdfTranslateBusy(session)) return;
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
      if (page === pageNum) pageResults = results;
      renderArticle();
      if (res?.polishError) setStatus(PDF_COPY.polishFail, true);
    },
    onPageDone({ page, results }) {
      if (!isCurrentWork(work, gen, translatingDoc)) return;
      if (page === pageNum) pageResults = results;
      renderArticle();
    }
  });
  if (!isCurrentWork(work, gen, translatingDoc)) return;
  renderArticle();
  const any = pages.some((entry) => pageHasTranslation(entry.results));
  if (aborted) setStatus(PDF_COPY.stopped);
  else if (!any) setStatus(PDF_COPY.error, true);
  else setStatus(PDF_COPY.doneDocument);
  translatingPage = 0;
  updateTranslateControls();
}

function emptyPageResults(blocks) {
  return (blocks || []).map((block) => ({
    original: block.text || block.original || block,
    translation: "",
    role: normalizeBlockRole(block.role),
    kind: block.kind || "text",
    rect: block.rect || null,
    pageWidth: block.pageWidth,
    pageHeight: block.pageHeight
  }));
}

async function ingestPageLayout(n, isStale) {
  const page = await pdfDoc.getPage(n);
  if (isStale()) return null;
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  if (isStale()) return null;
  const layout = buildMirrorLayout(content, { width: viewport.width, height: viewport.height });
  try {
    const opList = await page.getOperatorList();
    if (!isStale()) {
      const paints = walkImageCtms(opList.fnArray, opList.argsArray);
      const imageRects = imageRectsFromUnitCtms(paints, viewport.height);
      layout.visuals = appendOperatorImages(layout.visuals, imageRects, viewport.width, viewport.height);
    }
  } catch {
    /* operator list is optional for the first mirror shell */
  }
  if (isStale()) return null;
  setPageLayout(n, layout);
  return layout;
}

async function originalsForPage(n, gen, translatingDoc) {
  const isStale = () => gen !== restoreGen || translatingDoc !== docId;
  let blocks = n === pageNum && pageOriginals.length ? pageOriginals : null;
  if (!blocks) {
    const layout = getPageLayout(n) || (await ingestPageLayout(n, isStale));
    if (!layout || isStale()) return [];
    blocks = translatableMirrorUnits(layout);
  }
  if (isStale()) return [];
  const cached = pageCache.get(translatingDoc, n);
  pageResults = pageHasTranslation(cached) ? cached : emptyPageResults(blocks);
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
  setStatus(copy);
  $("noTextLayerHint").hidden = pageItems > 0;
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
    const loading = getDocument({ url: src, verbosity: 0 });
    await adoptDoc(await loading.promise, src);
  } catch {
    setStatus(PDF_COPY.fetchFail, true);
    setHasDoc(false);
  }
}

async function openPdfData(data, title) {
  setStatus(PDF_COPY.loading);
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
  layoutCache.clear();
  pageOriginals = [];
  pageResults = [];
  pageItems = 0;
  pageViews = [];
  $("pages").replaceChildren();
  pdfScrollRoot().scrollTop = 0;
  renderArticle();
  if (title) document.title = `${PDF_COPY.title} · ${shortTitle(title)}`;
  setHasDoc(true);
  await buildPages();
  updatePager();
  await scheduleVisibleRenders();
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
    refreshMirrorVisuals(view.num);
  } catch (err) {
    if (err?.name === "RenderingCancelledException") return;
    setStatus(PDF_COPY.error, true);
  }
}

async function loadCurrentPageText() {
  if (!pdfDoc) return;
  const ticket = ++textGen;
  const n = pageNum;
  const translatingDoc = docId;
  const isStale = () => ticket !== textGen || translatingDoc !== docId;
  try {
    const layout = await ingestPageLayout(n, isStale);
    if (!layout || isStale()) return;
    pageItems = Number(layout.itemCount) || (layout.kind === "empty" ? 0 : layout.boxes.length);
    pageOriginals = translatableMirrorUnits(layout);
    const cached = pageCache.get(docId, n);
    pageResults = cached || [];
    const copy = pageBlocksCopy(pageOriginals.length, pageItems) || textLayerCopy(pageItems);
    if (!pdfTranslateBusy(session)) {
      if (pageHasTranslation(cached)) setStatus(copy || PDF_COPY.done);
      else setStatus(copy);
    }
    $("noTextLayerHint").hidden = pageItems > 0;
  } catch {
    if (isStale()) return;
    pageItems = 0;
    pageOriginals = [];
    pageResults = [];
    if (!pdfTranslateBusy(session)) setStatus(PDF_COPY.noTextLayer);
    $("noTextLayerHint").hidden = false;
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

function setHasDoc(has) {
  if (!has) {
    $("pages").replaceChildren();
    pageViews = [];
    $("pager").textContent = pageLabel(0, 0);
    $("zoomLabel").textContent = zoomLabel(DEFAULT_ZOOM);
    $("noTextLayerHint").hidden = true;
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
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", Boolean(isError));
}
