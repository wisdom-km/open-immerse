import { getDocument, GlobalWorkerOptions } from "./vendor/pdf.min.mjs";
import {
  DEFAULT_ZOOM,
  PDF_COPY,
  abortTranslateSession,
  applyDraftTranslations,
  collectArticlePages,
  createPageCache,
  createTranslateSession,
  pdfToolbarActionState,
  pdfTranslateBusy,
  extractPageItems,
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
  segmentPageBlocks,
  shouldSyncReadout,
  textLayerCopy,
  translateDocumentPages,
  translatePageBlocks,
  articleNodeSpec,
  zoomLabel
} from "../lib/pdf-viewer.js";

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
let session = createTranslateSession();

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
  document.querySelector(".scope-seg")?.addEventListener("click", onScopeClick);
  $("translatePage").addEventListener("click", () => startTranslate());
  $("stopTranslate").addEventListener("click", stopTranslateWork);
  $("restoreOriginal").addEventListener("click", restoreOriginal);
  $("pdfPane").addEventListener("scroll", onPdfScroll, { passive: true });
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

function bindSplitResize() {
  const workspace = document.querySelector(".workspace");
  const handle = document.querySelector(".split-handle");
  const chip = document.querySelector(".zoom-gutter");
  if (!workspace || !handle) return;
  chip?.addEventListener("mousedown", (event) => event.stopPropagation());
  chip?.addEventListener("pointerdown", (event) => event.stopPropagation());
  handle.addEventListener("pointerdown", (event) => startSplitDrag(event, workspace, handle));
}

function startSplitDrag(event, workspace, handle) {
  if (event.button !== 0) return;
  const rect = workspace.getBoundingClientRect();
  const midBand = Math.abs(event.clientY - (rect.top + rect.height / 2)) <= 60;
  if (midBand) return;
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
  const chip = document.querySelector(".zoom-gutter");
  if (chip) chip.style.left = `${pct}%`;
}

function appendReadoutNode(input) {
  const spec = articleNodeSpec(input);
  const node = document.createElement(spec.tag);
  node.className = spec.className;
  node.textContent = spec.text;
  if (input.page != null && input.page !== "") node.dataset.page = String(input.page);
  $("readout").append(node);
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
  $("readout").replaceChildren();
  const pages = collectArticlePages(pageCache, docId, pdfDoc?.numPages || 0);
  if (!pages.length) {
    syncReadoutEmpty(false);
    return;
  }
  syncReadoutEmpty(true);
  pages.forEach(({ page, blocks }) => {
    (blocks || []).forEach((item) => {
      if (!item?.original || !item.translation) return;
      appendReadoutNode({
        translation: item.translation,
        role: item.role,
        page
      });
    });
  });
  if (pane) pane.scrollTop = keep;
}

function syncReadoutToPage(page) {
  const pane = document.querySelector(".pane-translate");
  const node = $("readout").querySelector(readoutPageSelector(page));
  if (!pane || !node) return;
  const paneRect = pane.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  if (!shouldSyncReadout(nodeRect.top, paneRect.top)) return;
  node.scrollIntoView({ block: "start", behavior: "smooth" });
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
    role: block.role === "title" ? "title" : block.role === "heading" ? "heading" : "paragraph"
  }));
}

async function originalsForPage(n, gen, translatingDoc) {
  let blocks = n === pageNum && pageOriginals.length ? pageOriginals : null;
  if (!blocks) {
    const page = await pdfDoc.getPage(n);
    if (gen !== restoreGen || translatingDoc !== docId) return [];
    blocks = segmentPageBlocks(await page.getTextContent());
  }
  if (gen !== restoreGen || translatingDoc !== docId) return [];
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
  pageOriginals = [];
  pageResults = [];
  pageItems = 0;
  pageViews = [];
  $("pages").replaceChildren();
  $("pdfPane").scrollTop = 0;
  renderArticle();
  if (title) document.title = `${PDF_COPY.title} · ${shortTitle(title)}`;
  setHasDoc(true);
  await buildPages();
  updatePager();
  await scheduleVisibleRenders();
  await loadCurrentPageText();
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
    wrap.style.maxWidth = "100%";
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
  const pane = $("pdfPane");
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
  const pane = $("pdfPane");
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
  if (!pdfDoc || next === zoom) return;
  zoom = next;
  $("zoomLabel").textContent = zoomLabel(zoom);
  await layoutPages();
  await scheduleVisibleRenders();
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
  const outputScale = window.devicePixelRatio || 1;
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

async function loadCurrentPageText() {
  if (!pdfDoc) return;
  const ticket = ++textGen;
  const n = pageNum;
  const translatingDoc = docId;
  try {
    const page = await pdfDoc.getPage(n);
    if (ticket !== textGen || translatingDoc !== docId) return;
    const content = await page.getTextContent();
    if (ticket !== textGen || translatingDoc !== docId) return;
    const items = extractPageItems(content);
    pageItems = items.length;
    pageOriginals = segmentPageBlocks(content);
    const cached = pageCache.get(docId, n);
    pageResults = cached || [];
    const copy = pageBlocksCopy(pageOriginals.length, pageItems) || textLayerCopy(pageItems);
    if (!pdfTranslateBusy(session)) {
      if (pageHasTranslation(cached)) setStatus(copy || PDF_COPY.done);
      else setStatus(copy);
    }
    $("noTextLayerHint").hidden = pageItems > 0;
  } catch {
    if (ticket !== textGen || translatingDoc !== docId) return;
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
}

function setHasDoc(has) {
  $("zoomOut").disabled = !has;
  $("zoomIn").disabled = !has;
  if (!has) {
    $("pages").replaceChildren();
    pageViews = [];
    $("pager").textContent = pageLabel(0, 0);
    $("zoomLabel").textContent = zoomLabel(DEFAULT_ZOOM);
    $("noTextLayerHint").hidden = true;
    pageItems = 0;
    pageOriginals = [];
    pageResults = [];
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
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", Boolean(isError));
}
