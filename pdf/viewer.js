import { getDocument, GlobalWorkerOptions } from "./vendor/pdf.min.mjs";
import {
  DEFAULT_ZOOM,
  PDF_COPY,
  abortTranslateSession,
  applyDraftTranslations,
  createPageCache,
  createTranslateSession,
  extractPageItems,
  nextZoom,
  pageBlocksCopy,
  pageIndex,
  pageLabel,
  progressStatus,
  readViewerSrc,
  segmentPageBlocks,
  textLayerCopy,
  translatePageBlocks,
  articleNodeSpec,
  zoomLabel
} from "../lib/pdf-viewer.js";

const $ = (id) => document.getElementById(id);

GlobalWorkerOptions.workerSrc = workerSrc();

let pdfDoc = null;
let pageNum = 1;
let zoom = DEFAULT_ZOOM;
let renderTask = null;
let sourceUrl = "";
let docId = 0;
let viewEpoch = 0;
let restoreGen = 0;
let pageItems = 0;
let pageOriginals = [];
let pageResults = [];
const pageCache = createPageCache();
const session = createTranslateSession();

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
  $("translatePage").addEventListener("click", () => translateCurrentPage());
  $("stopTranslate").addEventListener("click", () => {
    abortTranslateSession(session);
    if (session.running) setStatus(PDF_COPY.stopped);
  });
  $("restoreOriginal").addEventListener("click", restoreOriginal);
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
  if (!session.running) return;
  const next = applyDraftTranslations(session, message, pageResults);
  if (next === pageResults) return;
  pageResults = next;
  renderResults(pageResults);
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

function appendArticleNode(input) {
  const spec = articleNodeSpec(input);
  const node = document.createElement(spec.tag);
  node.className = spec.role === "heading" ? "article-heading" : "article-p";
  node.textContent = spec.text;
  $("blocks").append(node);
  $("emptyTranslate").hidden = true;
  return node;
}

function runtimeSend(message) {
  const send = globalThis.chrome?.runtime?.sendMessage;
  if (typeof send !== "function") {
    return Promise.reject(new Error("runtime unavailable"));
  }
  return send(message);
}

async function translateCurrentPage() {
  if (!pdfDoc || session.running) return;
  if (!pageOriginals.length) {
    setStatus(pageBlocksCopy(0, pageItems) || PDF_COPY.emptyPage);
    $("noTextLayerHint").hidden = pageItems > 0;
    updateTranslateControls();
    return;
  }
  const ticket = viewEpoch;
  const gen = restoreGen;
  const translatingPage = pageNum;
  const translatingDoc = docId;
  session.running = true;
  session.aborted = false;
  pageResults = pageOriginals.map((block) => ({
    original: block.text || block.original || block,
    translation: "",
    role: block.role === "heading" ? "heading" : "paragraph"
  }));
  renderResults(pageResults);
  updateTranslateControls();
  setStatus(PDF_COPY.translating);
  let batchSize = 8;
  try {
    const settingsRes = await runtimeSend({ type: "OI_GET_SETTINGS" });
    batchSize = Math.max(1, Number(settingsRes?.settings?.batchSize) || 8);
  } catch (err) {
    session.running = false;
    if (String(err?.message || err) === "runtime unavailable") {
      setStatus(PDF_COPY.runtimeUnavailable, true);
      updateTranslateControls();
      return;
    }
  }
  const { aborted, results } = await translatePageBlocks(pageOriginals, {
    send: runtimeSend,
    session,
    batchSize,
    onBatchStart({ index, total }) {
      if (ticket !== viewEpoch || gen !== restoreGen) return;
      setStatus(progressStatus(index + 1, total));
    },
    onBatchResult({ results: next, res }) {
      if (translatingDoc !== docId) return;
      if (gen !== restoreGen) return;
      pageCache.set(translatingDoc, translatingPage, next);
      if (ticket !== viewEpoch) return;
      pageResults = next;
      renderResults(next);
      if (res?.polishError) setStatus(PDF_COPY.polishFail, true);
    }
  });
  if (translatingDoc !== docId || gen !== restoreGen) {
    updateTranslateControls();
    return;
  }
  pageCache.set(translatingDoc, translatingPage, results);
  if (ticket !== viewEpoch) {
    updateTranslateControls();
    return;
  }
  pageResults = results;
  renderResults(results);
  if (aborted) setStatus(PDF_COPY.stopped);
  else if (!results.some((item) => item.translation)) setStatus(PDF_COPY.error, true);
  else setStatus(PDF_COPY.done);
  updateTranslateControls();
}

function restoreOriginal() {
  abortTranslateSession(session);
  restoreGen += 1;
  pageResults = [];
  pageCache.clearPage(docId, pageNum);
  renderResults([]);
  const copy = pageBlocksCopy(pageOriginals.length, pageItems);
  setStatus(copy);
  $("noTextLayerHint").hidden = pageItems > 0;
  $("emptyTranslate").hidden = false;
  updateTranslateControls();
}

function renderResults(results) {
  $("blocks").replaceChildren();
  const list = (results || []).filter((item) => item?.original);
  if (!list.length) {
    $("emptyTranslate").hidden = false;
    return;
  }
  $("emptyTranslate").hidden = true;
  list.forEach((item) => {
    if (!item.translation) return;
    appendArticleNode({
      translation: item.translation,
      role: item.role
    });
  });
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
  viewEpoch += 1;
  restoreGen += 1;
  pageCache.clear();
  pageOriginals = [];
  pageResults = [];
  pageItems = 0;
  renderResults([]);
  if (title) document.title = `${PDF_COPY.title} · ${shortTitle(title)}`;
  setHasDoc(true);
  await renderPage();
}

function shortTitle(value) {
  try {
    const path = new URL(value).pathname;
    return decodeURIComponent(path.split("/").filter(Boolean).pop() || value);
  } catch {
    return String(value || "").split(/[/\\]/).filter(Boolean).pop() || value;
  }
}

async function goPage(dir) {
  if (!pdfDoc) return;
  const next = pageIndex(pageNum, pdfDoc.numPages, dir);
  if (next === pageNum) return;
  abortTranslateSession(session);
  pageNum = next;
  await renderPage({ bumpEpoch: true });
}

async function setZoom(next) {
  if (!pdfDoc || next === zoom) return;
  zoom = next;
  await renderPage({ bumpEpoch: false });
}

async function renderPage({ bumpEpoch = false } = {}) {
  if (!pdfDoc) return;
  if (bumpEpoch) viewEpoch += 1;
  const ticket = viewEpoch;
  const page = await pdfDoc.getPage(pageNum);
  if (ticket !== viewEpoch) return;
  const viewport = page.getViewport({ scale: zoom });
  const canvas = $("page");
  const context = canvas.getContext("2d", { alpha: false });
  const outputScale = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  canvas.hidden = false;
  if (renderTask) {
    renderTask.cancel();
    try {
      await renderTask.promise;
    } catch {
      /* cancelled */
    }
  }
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  renderTask = page.render({ canvasContext: context, viewport, transform });
  try {
    await renderTask.promise;
  } catch (err) {
    if (err?.name === "RenderingCancelledException") return;
    setStatus(PDF_COPY.error, true);
    return;
  }
  if (ticket !== viewEpoch) return;
  $("pager").textContent = pageLabel(pageNum, pdfDoc.numPages);
  $("zoomLabel").textContent = zoomLabel(zoom);
  $("prev").disabled = pageNum <= 1;
  $("next").disabled = pageNum >= pdfDoc.numPages;
  await loadPageText(page, ticket);
}

async function loadPageText(page, ticket) {
  try {
    const content = await page.getTextContent();
    if (ticket !== viewEpoch) return;
    const items = extractPageItems(content);
    pageItems = items.length;
    pageOriginals = segmentPageBlocks(content);
    const copy = pageBlocksCopy(pageOriginals.length, pageItems) || textLayerCopy(pageItems);
    const cached = pageCache.get(docId, pageNum);
    if (cached?.length) {
      pageResults = cached;
      renderResults(cached);
      setStatus(copy || PDF_COPY.done);
      $("noTextLayerHint").hidden = true;
    } else {
      pageResults = [];
      renderResults([]);
      setStatus(copy);
      $("noTextLayerHint").hidden = pageItems > 0;
      $("emptyTranslate").hidden = false;
    }
  } catch {
    if (ticket !== viewEpoch) return;
    pageItems = 0;
    pageOriginals = [];
    pageResults = [];
    renderResults([]);
    setStatus(PDF_COPY.noTextLayer);
    $("noTextLayerHint").hidden = false;
    $("emptyTranslate").hidden = false;
  }
  updateTranslateControls();
}

function setHasDoc(has) {
  $("prev").disabled = !has;
  $("next").disabled = !has;
  $("zoomOut").disabled = !has;
  $("zoomIn").disabled = !has;
  if (!has) {
    $("page").hidden = true;
    $("pager").textContent = pageLabel(0, 0);
    $("zoomLabel").textContent = zoomLabel(DEFAULT_ZOOM);
    $("noTextLayerHint").hidden = true;
    pageItems = 0;
    pageOriginals = [];
    pageResults = [];
    renderResults([]);
  }
  updateTranslateControls();
}

function updateTranslateControls() {
  const hasBlocks = pageOriginals.length > 0;
  const hasResults = pageResults.some((item) => item?.original);
  $("translatePage").disabled = !pdfDoc || !hasBlocks || session.running;
  $("stopTranslate").disabled = !session.running;
  $("restoreOriginal").disabled = !hasResults && !pageCache.has(docId, pageNum);
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", Boolean(isError));
}
