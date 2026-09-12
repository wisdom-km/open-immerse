import { getDocument, GlobalWorkerOptions } from "./vendor/pdf.min.mjs";
import {
  DEFAULT_ZOOM,
  PDF_COPY,
  favoriteSegment,
  nextZoom,
  pageIndex,
  pageLabel,
  readViewerSrc,
  textLayerCopy,
  zoomLabel
} from "../lib/pdf-viewer.js";

const $ = (id) => document.getElementById(id);

GlobalWorkerOptions.workerSrc = workerSrc();

let pdfDoc = null;
let pageNum = 1;
let zoom = DEFAULT_ZOOM;
let renderTask = null;
let sourceUrl = "";

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
  $("favoriteSegment").addEventListener("click", onFavorite);
  // M2: wire #translatePage to the shared batch translate message. Keep disabled in M1.
  document.addEventListener("keydown", onKey);

  const src = readViewerSrc(location.search);
  if (src) {
    sourceUrl = src;
    openFromSrc(src);
  } else {
    setStatus(PDF_COPY.empty);
  }
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

async function onFavorite() {
  const result = await favoriteSegment({
    original: "",
    translation: "",
    url: sourceUrl || location.href,
    title: document.title
  });
  if (!result?.ok) return;
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
  pdfDoc = doc;
  pageNum = 1;
  zoom = DEFAULT_ZOOM;
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
  pageNum = next;
  await renderPage();
}

async function setZoom(next) {
  if (!pdfDoc || next === zoom) return;
  zoom = next;
  await renderPage();
}

async function renderPage() {
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(pageNum);
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
  $("pager").textContent = pageLabel(pageNum, pdfDoc.numPages);
  $("zoomLabel").textContent = zoomLabel(zoom);
  $("prev").disabled = pageNum <= 1;
  $("next").disabled = pageNum >= pdfDoc.numPages;
  await noteTextLayer(page);
}

async function noteTextLayer(page) {
  try {
    const content = await page.getTextContent();
    const copy = textLayerCopy(content?.items?.length || 0);
    setStatus(copy || "");
    $("noTextLayerHint").hidden = !copy;
  } catch {
    setStatus(PDF_COPY.noTextLayer);
    $("noTextLayerHint").hidden = false;
  }
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
  }
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", Boolean(isError));
}
