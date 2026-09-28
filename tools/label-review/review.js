import { verifyPageLabels } from "/lib/label-schema.js";
import {
  applyEquationNumber,
  applyMerge,
  applySplit,
  attachExtensionPairs,
  bindExtensionPairUnits,
  clampZoom,
  confirmBlocked,
  dragSelectsElement,
  expandPairIds,
  extensionDelimiterPairs,
  EXTRA_SELECTION_HEADING,
  formatPageQueueLabel,
  formatQueueStatus,
  formatUnitQueueLabel,
  importRejection,
  isRenderingCancelled,
  missingPdfBanner,
  nextClickSelection,
  nextDragSelection,
  otherQueueMarks,
  overlayClass,
  pageRectFromPointer,
  pageUnitColor,
  parseQueueJump,
  parseQueueQuery,
  queueIndexesOnPage,
  rebuildFormulaUnits,
  reviewActionsLocked,
  reviewMarkBoxes,
  selectionAside,
  selectionForReviewUnit,
  selectionKey,
  zoomToFitWidth
} from "/lib/review-actions.js";
import * as pdfjs from "/pdf/vendor/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf/vendor/pdf.worker.min.mjs";

const state = {
  manifest: null,
  status: null,
  paperId: "",
  pageNumber: 1,
  page: null,
  prelabel: null,
  selected: new Set(),
  scale: 1.25,
  pdf: null,
  uncertain: [],
  mode: "units",
  reviewSet: { units: [] },
  unitCursor: 0,
  pendingFocus: null,
  pdfMissing: false,
  scrollSelection: false,
  notice: null,
  queueUnit: null,
  zoomBefore: 1.25,
  zoomFitted: false
};

const pdfBytes = new Map();
let pdfLoad = null;
let pageToken = 0;

const progress = document.querySelector("#progress");
const saveState = document.querySelector("#save-state");
const stage = document.querySelector("#stage");
const queue = document.querySelector("#queue");
const detail = document.querySelector("#detail");
const summary = document.querySelector("#selection-summary");
const notice = document.querySelector("#action-notice");
const queueStatus = document.querySelector("#queue-unit-status");
const overlayLegend = document.querySelector("#overlay-legend");

function pageFile(pageNumber) {
  return `page-${String(pageNumber).padStart(3, "0")}.json`;
}

async function loadManifest() {
  state.manifest = await (await fetch("/api/manifest")).json();
  state.status = await (await fetch("/api/status")).json();
  const setResponse = await fetch("/api/review-set");
  state.reviewSet = setResponse.ok ? await setResponse.json() : { units: [] };
  const units = state.reviewSet.units || [];
  const jump = parseQueueQuery(location.search, units.length);
  if (jump.ok) {
    await openUnit(jump.index);
    return;
  }
  if (!jump.absent) saveState.textContent = jump.message;
  const params = new URLSearchParams(location.search);
  if (params.get("paper")) {
    await openPage(params.get("paper"), Number(params.get("page") || 1));
    return;
  }
  if (state.reviewSet.units?.length) {
    const start = nextUnreviewed(0);
    await openUnit(start < 0 ? 0 : start);
    return;
  }
  const first = state.status.queue[0] || {
    paperId: state.manifest.documents[0].id,
    page: 1
  };
  await openPage(first.paperId, first.page || 1);
}

function unitKey(unit) {
  return `${unit.paperId}:${unit.page}:${unit.unitId}`;
}

function reviewedKeySet() {
  const keys = new Set(state.status?.reviewedKeys || []);
  if (state.page?.reviewedUnitIds && state.paperId) {
    for (const id of state.page.reviewedUnitIds) keys.add(`${state.paperId}:${state.pageNumber}:${id}`);
  }
  return keys;
}

function reviewedCount() {
  const keys = reviewedKeySet();
  return (state.reviewSet.units || []).filter((unit) => keys.has(unitKey(unit))).length;
}

function renderQueue() {
  queue.innerHTML = "";
  const picker = document.createElement("select");
  for (const doc of state.manifest.documents) {
    const option = document.createElement("option");
    option.value = doc.id;
    option.textContent = `${doc.field} · ${doc.id}`;
    if (doc.id === state.paperId) option.selected = true;
    picker.append(option);
  }
  picker.addEventListener("change", () => {
    state.mode = "pages";
    openPage(picker.value, 1);
  });
  queue.append(picker);
  const total = state.reviewSet.units?.length || state.status?.reviewTarget || 0;
  progress.textContent = `已复核 ${reviewedCount()}/${total} 个单元`;
  const head = document.createElement("p");
  if (state.mode === "pages") {
    const here = queueIndexesOnPage(state.reviewSet.units, state.paperId, state.pageNumber);
    head.textContent = here.length
      ? `整页队列 · 低置信度优先 · 本页 ${here.map((n) => `#${n}`).join(" ")}`
      : "整页队列 · 低置信度优先";
    queue.append(head);
    for (const row of state.status.queue.slice(0, 40)) {
      const button = document.createElement("button");
      button.textContent = formatPageQueueLabel({
        row,
        queueIndexes: queueIndexesOnPage(state.reviewSet.units, row.paperId, row.page)
      });
      button.className = row.paperId === state.paperId && row.page === state.pageNumber ? "current" : "";
      button.addEventListener("click", () => openPage(row.paperId, row.page));
      queue.append(button);
    }
    return;
  }
  head.textContent = "单元队列 · 领域和论文交错";
  queue.append(head);
  const keys = reviewedKeySet();
  const units = state.reviewSet.units || [];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const button = document.createElement("button");
    const reviewed = keys.has(unitKey(unit));
    button.textContent = formatUnitQueueLabel({ index, unit, reviewed });
    button.className = [index === state.unitCursor ? "current" : "", reviewed ? "reviewed" : ""].filter(Boolean).join(" ");
    button.addEventListener("click", () => openUnit(index));
    queue.append(button);
  }
  queue.querySelector("button.current")?.scrollIntoView({ block: "nearest" });
}

function setLocked(locked) {
  state.pdfMissing = locked;
  document.body.classList.toggle("pdf-missing", locked);
  for (const button of document.querySelectorAll(".actions button, #confirm-unit")) {
    button.disabled = locked;
  }
}

async function showMissingPdf(paperId) {
  pdfBytes.delete(paperId);
  if (state.pdf) await state.pdf.destroy();
  state.pdf = null;
  state.selected = new Set();
  state.scrollSelection = false;
  state.pendingFocus = null;
  setLocked(true);
  stage.innerHTML = "";
  summary.textContent = "还没有选中元素。";
  detail.textContent = "";
  state.notice = null;
  state.queueUnit = null;
  if (overlayLegend) overlayLegend.hidden = true;
  if (queueStatus) {
    queueStatus.hidden = true;
    queueStatus.textContent = "";
  }
  if (notice) {
    notice.hidden = true;
    notice.textContent = "";
    notice.className = "";
  }
  const banner = document.createElement("div");
  banner.id = "pdf-missing";
  banner.setAttribute("role", "alert");
  banner.textContent = missingPdfBanner(paperId);
  stage.append(banner);
  saveState.textContent = "缺少 PDF，已停止复核这一单元";
  renderQueue();
}

async function loadPdfBytes(paperId) {
  pdfLoad?.abort();
  const controller = new AbortController();
  pdfLoad = controller;
  if (pdfBytes.has(paperId)) {
    const head = await fetch(`/api/pdf/${encodeURIComponent(paperId)}`, { method: "HEAD", signal: controller.signal });
    if (controller.signal.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    if (head.ok) return pdfBytes.get(paperId);
    await head.body?.cancel?.();
    pdfBytes.delete(paperId);
    const missing = new Error("missing-pdf");
    missing.code = "missing-pdf";
    throw missing;
  }
  const response = await fetch(`/api/pdf/${encodeURIComponent(paperId)}`, { signal: controller.signal });
  if (!response.ok) {
    await response.body?.cancel?.();
    const error = new Error("missing-pdf");
    error.code = "missing-pdf";
    throw error;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (controller.signal.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }
  pdfBytes.set(paperId, bytes);
  return bytes;
}

async function openPage(paperId, pageNumber, focus = null) {
  const token = ++pageToken;
  state.paperId = paperId;
  state.pageNumber = pageNumber;
  state.pendingFocus = focus?.elementIds ? focus : null;
  state.queueUnit = state.pendingFocus;
  state.selected = new Set();
  state.notice = null;
  const response = await fetch(`/api/page/${encodeURIComponent(paperId)}/${pageNumber}`);
  if (token !== pageToken) {
    await response.body?.cancel?.();
    return;
  }
  if (!response.ok) {
    await response.body?.cancel?.();
    await showMissingPdf(paperId);
    return;
  }
  const payload = await response.json();
  if (token !== pageToken) return;
  state.page = payload.page;
  state.prelabel = payload.prelabel;
  state.uncertain = state.page.elements
    .filter((element) => Number(element.confidence) < 0.75)
    .sort((a, b) => a.confidence - b.confidence)
    .map((element) => element.id);
  try {
    const bytes = await loadPdfBytes(paperId);
    if (token !== pageToken) return;
    if (state.pdf) await state.pdf.destroy();
    const pdf = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    if (token !== pageToken) {
      await pdf.destroy();
      return;
    }
    state.pdf = pdf;
  } catch (error) {
    if (token !== pageToken || error?.name === "AbortError") return;
    console.error(error);
    await showMissingPdf(paperId);
    return;
  }
  setLocked(false);
  document.querySelector("#sheet-link").href = `/api/sheet/${encodeURIComponent(paperId)}/${pageNumber}`;
  await paint();
  renderQueue();
  saveState.textContent = payload.source === "reviewed" ? "已载入复核稿" : "预标注";
}

let paintToken = 0;
function scrollCurrentToCenter() {
  const main = stage.closest("main");
  const currentNodes = [...stage.querySelectorAll("rect.hit.current")];
  const nodes = currentNodes.length ? currentNodes : [...stage.querySelectorAll("rect.hit.picked")];
  if (!main || !nodes.length) {
    stage.style.margin = "12px";
    return;
  }
  const view = main.getBoundingClientRect();
  stage.style.margin = `${view.height / 2}px ${view.width / 2}px`;
  const mainBox = main.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const box = node.getBoundingClientRect();
    minX = Math.min(minX, box.left);
    minY = Math.min(minY, box.top);
    maxX = Math.max(maxX, box.right);
    maxY = Math.max(maxY, box.bottom);
  }
  main.scrollBy({
    left: (minX + maxX) / 2 - (mainBox.left + mainBox.width / 2),
    top: (minY + maxY) / 2 - (mainBox.top + mainBox.height / 2)
  });
}

function paperPageCount() {
  const doc = state.manifest?.documents?.find((entry) => entry.id === state.paperId);
  return doc?.pageCount || state.pdf?.numPages || state.pageNumber;
}

function isNavigationKey(key) {
  return key === "j" || key === "k" || key === "n" || key === "p";
}

function appendQueueBadge(overlay, members, scale, queueNumber) {
  let x1 = -Infinity;
  let y0 = Infinity;
  for (const element of members) {
    const box = element?.bbox;
    if (!box) continue;
    x1 = Math.max(x1, box[2]);
    y0 = Math.min(y0, box[1]);
  }
  if (!Number.isFinite(x1)) return;
  const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
  text.setAttribute("class", "queue-badge");
  text.setAttribute("x", String(x1 * scale + 3));
  text.setAttribute("y", String(Math.max(10, y0 * scale + 8)));
  text.textContent = String(queueNumber);
  overlay.append(text);
}

async function paint() {
  stage.style.margin = "12px";
  if (reviewActionsLocked(state.pdfMissing) || !state.pdf) return;
  const token = ++paintToken;
  const pdfPage = await state.pdf.getPage(state.pageNumber);
  if (token !== paintToken) return;
  const viewport = pdfPage.getViewport({ scale: state.scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  } catch (error) {
    if (isRenderingCancelled(error)) return;
    throw error;
  }
  if (token !== paintToken) return;
  if (state.pendingFocus) {
    const mapped = selectionForReviewUnit(state.page.elements, state.pendingFocus.elementIds, state.pendingFocus.unitId);
    if (mapped.ids.length) state.selected = new Set(mapped.ids);
  }
  stage.innerHTML = "";
  stage.append(canvas);
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  overlay.setAttribute("id", "overlay");
  overlay.setAttribute("width", canvas.width);
  overlay.setAttribute("height", canvas.height);
  const unitMode = state.mode === "units";
  overlay.setAttribute("class", unitMode ? "unit-mode" : "page-mode");
  const currentMapped = unitMode && state.queueUnit
    ? selectionForReviewUnit(state.page.elements, state.queueUnit.elementIds, state.queueUnit.unitId)
    : null;
  const currentIds = new Set(currentMapped?.ids || []);
  const marks = unitMode
    ? otherQueueMarks({
      units: state.reviewSet.units,
      paperId: state.paperId,
      page: state.pageNumber,
      elements: state.page.elements,
      currentReviewUnitId: state.queueUnit?.unitId
    })
    : [];
  const queuedIds = new Set(marks.flatMap((mark) => mark.elementIds));
  const hueByUnit = new Map();
  let hueIndex = 0;
  const byId = new Map(state.page.elements.map((element) => [element.id, element]));
  const paintCurrent = new Set(expandPairIds(state.page.elements, currentIds));
  const paintSelected = new Set(expandPairIds(state.page.elements, state.selected));
  const paintQueued = new Set(expandPairIds(state.page.elements, queuedIds));
  for (const mark of reviewMarkBoxes(state.page.elements)) {
    const element = byId.get(mark.id);
    if (!element) continue;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const [x0, y0, x1, y1] = mark.bbox;
    rect.setAttribute("x", x0 * state.scale);
    rect.setAttribute("y", y0 * state.scale);
    rect.setAttribute("width", Math.max(0.5, (x1 - x0) * state.scale));
    rect.setAttribute("height", Math.max(0.5, (y1 - y0) * state.scale));
    rect.dataset.id = element.id;
    if (mark.paired) rect.dataset.pair = (mark.inkIds || []).join(",");
    const className = overlayClass({
      mode: unitMode ? "units" : "pages",
      elementId: element.id,
      label: element.label,
      uncertain: Number(element.confidence) < 0.75,
      currentIds: paintCurrent,
      selectedIds: paintSelected,
      queuedIds: paintQueued
    });
    rect.setAttribute("class", className);
    if (!unitMode && element.label === "formula" && element.unitId && !className.includes("picked")) {
      if (!hueByUnit.has(element.unitId)) hueByUnit.set(element.unitId, pageUnitColor(hueIndex++));
      rect.style.stroke = hueByUnit.get(element.unitId);
    }
    overlay.append(rect);
  }
  if (unitMode) {
    for (const mark of marks) {
      appendQueueBadge(overlay, mark.elementIds.map((id) => byId.get(id)).filter(Boolean), state.scale, mark.queueNumber);
    }
  }
  stage.append(overlay);
  overlay.addEventListener("mousedown", onPointerDown);
  overlay.addEventListener("click", onClick);
  describeSelection();
  if (state.pendingFocus || state.scrollSelection) {
    state.pendingFocus = null;
    state.scrollSelection = false;
    requestAnimationFrame(() => requestAnimationFrame(scrollCurrentToCenter));
  }
}

function rebuild() {
  state.page.units = rebuildFormulaUnits(state.page.elements);
  state.page.source = "reviewed";
  const issues = verifyPageLabels(state.page);
  if (issues.length) {
    saveState.textContent = importRejection(issues);
    return;
  }
  scheduleSave();
}

let saveTimer = 0;
function scheduleSave() {
  saveState.textContent = "正在保存…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

async function save(payload = state.page, paperId = state.paperId, pageNumber = state.pageNumber) {
  const response = await fetch(`/api/page/${encodeURIComponent(paperId)}/${pageNumber}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    saveState.textContent = "保存失败";
    return;
  }
  saveState.textContent = "已自动保存";
  state.status = await (await fetch("/api/status")).json();
  renderQueue();
}

function selectedElements() {
  return state.page.elements.filter((element) => state.selected.has(element.id));
}

function describeSelection() {
  const elements = selectedElements();
  const mapped = state.queueUnit && state.page
    ? selectionForReviewUnit(state.page.elements, state.queueUnit.elementIds, state.queueUnit.unitId)
    : null;
  const nonFormula = new Set(mapped?.nonFormulaIds || []);
  if (overlayLegend) overlayLegend.hidden = state.mode !== "units";
  if (queueStatus) {
    if (mapped && state.queueUnit) {
      const reviewed = (state.page.reviewedUnitIds || []).includes(state.queueUnit.unitId);
      const status = formatQueueStatus({
        reviewedCount: reviewedCount(),
        reviewTotal: state.reviewSet.units?.length || state.status?.reviewTarget || 0,
        reviewed,
        changed: mapped.changed,
        unitIds: mapped.unitIds,
        elementCount: mapped.count,
        equationNumber: mapped.equationNumber,
        spanned: mapped.spanned,
        nonFormulaCount: nonFormula.size
      });
      queueStatus.hidden = false;
      queueStatus.textContent = `${status.countLine}\n${status.statusLine}`;
    } else {
      queueStatus.hidden = true;
      queueStatus.textContent = "";
    }
  }
  summary.textContent = elements.length ? `选中 ${elements.length} 个` : "还没有选中元素。";
  if (notice) {
    if (state.notice?.text) {
      notice.hidden = false;
      notice.textContent = state.notice.text;
      notice.className = state.notice.ok ? "ok" : "fail";
    } else {
      notice.hidden = true;
      notice.textContent = "";
      notice.className = "";
    }
  }
  detail.replaceChildren();
  const aside = selectionAside(elements, state.mode === "units" && mapped ? mapped.ids : []);
  appendInspectorGroups(aside.inside, nonFormula);
  if (state.mode === "units" && mapped && aside.extra.count) {
    const extraHead = document.createElement("p");
    extraHead.className = "unit-head extra-selection";
    extraHead.textContent = EXTRA_SELECTION_HEADING;
    detail.append(extraHead);
    appendInspectorGroups(aside.extra, nonFormula);
  }
}

function appendInspectorGroups(model, nonFormula) {
  const paired = new Set();
  for (const pair of extensionDelimiterPairs(state.page?.elements || [])) {
    paired.add(pair.glyphId);
    for (const inkId of pair.inkIds || []) paired.add(inkId);
  }
  for (const group of model.groups) {
    const block = document.createElement("section");
    block.className = "unit-group";
    if (group.unitId) block.dataset.unit = group.unitId;
    const head = document.createElement("p");
    head.className = "unit-head";
    if (group.unitId) {
      const kind = group.type === "display" ? " · 行间" : group.type === "inline" ? " · 行内" : "";
      const numbered = group.equationNumber ? " · 含公式编号" : "";
      head.textContent = `单元 ${group.unitId}${kind}${numbered}`;
    } else {
      head.textContent = "非公式";
    }
    block.append(head);
    for (const row of group.rows) {
      const line = document.createElement("p");
      line.className = nonFormula.has(row.id) ? "element-line non-formula" : "element-line";
      const bits = [row.char || (row.label === "formula" ? "路径" : "空"), row.label];
      if (row.equationNumber) bits.push("编号");
      if (row.paired || paired.has(row.id)) bits.push("成对");
      if (nonFormula.has(row.id)) bits.push("已不是公式");
      bits.push(row.unitId || "—");
      line.textContent = bits.join(" · ");
      block.append(line);
    }
    detail.append(block);
  }
}

function noteResult(result) {
  state.notice = {
    ok: result.ok === true,
    text: result.message || "",
    selectionKey: selectionKey(state.selected)
  };
}

function finishEdit(result) {
  noteResult(result);
  if (!result.ok || result.changed === false) {
    describeSelection();
    return;
  }
  state.page.units = result.units;
  state.page.source = "reviewed";
  const issues = verifyPageLabels(state.page);
  if (issues.length) {
    state.notice = {
      ok: false,
      text: importRejection(issues),
      selectionKey: selectionKey(state.selected)
    };
    describeSelection();
    return;
  }
  scheduleSave();
  paint();
}

function selectionWithPairs(ids = state.selected) {
  const next = expandPairIds(state.page?.elements, ids);
  state.selected = new Set(next);
  return next;
}

function forgetNoticeIfSelectionMoved() {
  const next = selectionKey(state.selected);
  if (state.notice?.selectionKey && state.notice.selectionKey !== next) state.notice = null;
}

let dragSelect = false;

function onClick(event) {
  if (reviewActionsLocked(state.pdfMissing)) return;
  if (dragSelect) {
    dragSelect = false;
    return;
  }
  const id = event.target?.dataset?.id;
  if (!id) return;
  const ids = expandPairIds(state.page?.elements, [id]);
  state.selected = new Set(nextClickSelection(state.selected, ids, {
    shift: event.shiftKey,
    toggle: event.altKey || event.ctrlKey || event.metaKey
  }));
  forgetNoticeIfSelectionMoved();
  paint();
}

function onPointerDown(event) {
  if (reviewActionsLocked(state.pdfMissing)) return;
  if (event.target?.dataset?.id && !event.altKey) return;
  const start = point(event);
  const band = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  band.setAttribute("fill", "rgba(20,20,20,0.08)");
  band.setAttribute("stroke", "#111");
  event.currentTarget.append(band);
  function move(ev) {
    const now = point(ev);
    const x = Math.min(start.x, now.x);
    const y = Math.min(start.y, now.y);
    band.setAttribute("x", x);
    band.setAttribute("y", y);
    band.setAttribute("width", Math.abs(now.x - start.x));
    band.setAttribute("height", Math.abs(now.y - start.y));
  }
  function up(ev) {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    band.remove();
    const now = point(ev);
    const moved = Math.abs(now.x - start.x) + Math.abs(now.y - start.y) > 3;
    if (!moved) {
      if (!event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.target?.dataset?.id) {
        state.selected = new Set();
        forgetNoticeIfSelectionMoved();
        paint();
      }
      return;
    }
    dragSelect = true;
    const rect = pageRectFromPointer(start, now, state.scale);
    const hits = expandPairIds(
      state.page.elements,
      state.page.elements.filter((element) => dragSelectsElement(element.bbox, rect)).map((element) => element.id)
    );
    state.selected = new Set(nextDragSelection(state.selected, hits, {
      shift: event.shiftKey,
      alt: event.altKey
    }));
    forgetNoticeIfSelectionMoved();
    paint();
  }
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function point(event) {
  const bounds = stage.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function relabel(label) {
  if (reviewActionsLocked(state.pdfMissing)) return;
  selectionWithPairs();
  state.notice = null;
  for (const element of selectedElements()) {
    element.label = label;
    element.confidence = 1;
    element.rule = "human";
    if (label === "formula" && !element.unitId) element.unitId = `tmp-${element.id}`;
  }
  bindExtensionPairUnits(state.page.elements, state.selected);
  rebuild();
  paint();
}

function setType(type) {
  if (reviewActionsLocked(state.pdfMissing)) return;
  selectionWithPairs();
  state.notice = null;
  for (const element of selectedElements()) {
    if (element.label !== "formula") continue;
    element.unitType = type;
  }
  bindExtensionPairUnits(state.page.elements, state.selected);
  rebuild();
  paint();
}

function merge() {
  if (reviewActionsLocked(state.pdfMissing)) return;
  finishEdit(applyMerge(state.page?.elements, selectionWithPairs()));
}

function split() {
  if (reviewActionsLocked(state.pdfMissing)) return;
  finishEdit(applySplit(state.page?.elements, selectionWithPairs()));
}

function jumpUncertain(step) {
  if (reviewActionsLocked(state.pdfMissing)) return;
  if (!state.uncertain.length) return;
  const current = [...state.selected][0];
  let index = state.uncertain.indexOf(current);
  index = index < 0 ? 0 : (index + step + state.uncertain.length) % state.uncertain.length;
  state.selected = new Set(expandPairIds(state.page?.elements, [state.uncertain[index]]));
  forgetNoticeIfSelectionMoved();
  state.scrollSelection = true;
  paint();
}

document.querySelectorAll("[data-label]").forEach((button) => {
  button.addEventListener("click", () => relabel(button.dataset.label));
});
document.querySelector("#as-display").addEventListener("click", () => setType("display"));
document.querySelector("#as-inline").addEventListener("click", () => setType("inline"));
document.querySelector("#eq-toggle").addEventListener("click", () => {
  if (reviewActionsLocked(state.pdfMissing)) return;
  finishEdit(applyEquationNumber(state.page?.elements, selectionWithPairs()));
});
document.querySelector("#merge").addEventListener("click", merge);
document.querySelector("#split").addEventListener("click", split);
function setZoom(value, { fitted = false } = {}) {
  state.scale = clampZoom(value);
  const slider = document.querySelector("#zoom");
  if (slider) slider.value = String(state.scale);
  if (!fitted) state.zoomFitted = false;
  paint();
}

function currentQueueMembers() {
  if (state.mode !== "units" || !state.queueUnit || !state.page) return [];
  const mapped = selectionForReviewUnit(state.page.elements, state.queueUnit.elementIds, state.queueUnit.unitId);
  const ids = new Set(mapped.ids);
  return state.page.elements.filter((element) => ids.has(element.id));
}

function toggleZoomFit() {
  if (state.zoomFitted) {
    const previous = state.zoomBefore ?? 1.25;
    state.zoomFitted = false;
    state.scrollSelection = true;
    setZoom(previous);
    return;
  }
  const members = currentQueueMembers();
  if (!members.length) return;
  const main = stage.closest("main");
  state.zoomBefore = state.scale;
  state.zoomFitted = true;
  state.scrollSelection = true;
  setZoom(zoomToFitWidth(members, main?.clientWidth || 800), { fitted: true });
}

document.querySelector("#zoom").addEventListener("input", (event) => {
  setZoom(event.target.value);
});
document.querySelector("#revert").addEventListener("click", async () => {
  state.page = structuredClone(state.prelabel);
  state.page.source = "reviewed";
  await save();
  await paint();
});
document.querySelector("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.page, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.paperId}-${pageFile(state.pageNumber)}`;
  link.click();
});
document.querySelector("#import").addEventListener("click", () => document.querySelector("#import-file").click());
document.querySelector("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const page = JSON.parse(await file.text());
  const issues = verifyPageLabels(page);
  if (issues.length) {
    saveState.textContent = importRejection(issues);
    return;
  }
  state.page = page;
  state.page.source = "reviewed";
  await save();
  await paint();
});
function nextUnreviewed(start) {
  const keys = reviewedKeySet();
  const units = state.reviewSet.units || [];
  for (let index = start; index < units.length; index += 1) {
    if (!keys.has(unitKey(units[index]))) return index;
  }
  return -1;
}

async function openUnit(index) {
  const unit = state.reviewSet.units?.[index];
  if (!unit) return;
  state.mode = "units";
  state.unitCursor = index;
  await openPage(unit.paperId, unit.page, unit);
}

async function confirmUnit() {
  if (reviewActionsLocked(state.pdfMissing)) return;
  if (confirmBlocked(state.notice, state.selected)) {
    describeSelection();
    return;
  }
  const unit = state.reviewSet.units?.[state.unitCursor];
  if (!unit || state.paperId !== unit.paperId || state.pageNumber !== unit.page) return;
  const mapped = selectionForReviewUnit(state.page.elements, unit.elementIds, unit.unitId);
  const snapshot = structuredClone(state.page.elements);
  const snapshotUnits = state.page.units;
  const attached = attachExtensionPairs(state.page.elements, mapped.ids);
  if (attached.blocked) {
    state.page.elements = snapshot;
    state.page.units = snapshotUnits;
    state.notice = {
      ok: false,
      text: attached.message,
      selectionKey: selectionKey(state.selected)
    };
    describeSelection();
    return;
  }
  if (attached.changed) {
    state.page.units = attached.units;
    state.page.source = "reviewed";
    const issues = verifyPageLabels(state.page);
    if (issues.length) {
      state.page.elements = snapshot;
      state.page.units = snapshotUnits;
      state.notice = {
        ok: false,
        text: importRejection(issues),
        selectionKey: selectionKey(state.selected)
      };
      describeSelection();
      return;
    }
  }
  if (!Array.isArray(state.page.reviewedUnitIds)) state.page.reviewedUnitIds = [];
  if (!state.page.reviewedUnitIds.includes(unit.unitId)) state.page.reviewedUnitIds.push(unit.unitId);
  const payload = state.page;
  const paperId = state.paperId;
  const pageNumber = state.pageNumber;
  const next = nextUnreviewed(state.unitCursor + 1);
  clearTimeout(saveTimer);
  await save(payload, paperId, pageNumber);
  if (next >= 0) await openUnit(next);
  else describeSelection();
}

document.querySelector("#mode-units").addEventListener("click", () => {
  state.mode = "units";
  const index = state.unitCursor || 0;
  openUnit(index);
});
document.querySelector("#mode-pages").addEventListener("click", () => {
  state.mode = "pages";
  renderQueue();
  if (state.page) {
    describeSelection();
    paint();
  } else if (overlayLegend) overlayLegend.hidden = true;
});
document.querySelector("#confirm-unit").addEventListener("click", confirmUnit);

document.querySelector("#jump-queue").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const input = event.currentTarget;
  const parsed = parseQueueJump(input.value, state.reviewSet.units?.length || 0);
  if (!parsed.ok) {
    saveState.textContent = parsed.message;
    return;
  }
  openUnit(parsed.index);
});

window.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea, select")) return;
  const key = event.key.toLowerCase();
  if (key === "g" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const input = document.querySelector("#jump-queue");
    input.focus();
    input.select();
    event.preventDefault();
    return;
  }
  if (reviewActionsLocked(state.pdfMissing) && !isNavigationKey(key)) return;
  if (key === "enter") confirmUnit();
  else if (key === "1") relabel("formula");
  else if (key === "2") relabel("text");
  else if (key === "3") relabel("code");
  else if (key === "4") relabel("other");
  else if (key === "d") setType("display");
  else if (key === "i") setType("inline");
  else if (key === "e") document.querySelector("#eq-toggle").click();
  else if (key === "m") merge();
  else if (key === "s") split();
  else if ((key === "+" || key === "=") && !event.ctrlKey && !event.metaKey) setZoom(state.scale + 0.1);
  else if ((key === "-" || key === "_") && !event.ctrlKey && !event.metaKey) setZoom(state.scale - 0.1);
  else if (key === "z" && !event.ctrlKey && !event.metaKey) toggleZoomFit();
  else if (key === "j" && state.mode === "units") openUnit(Math.min((state.reviewSet.units?.length || 1) - 1, state.unitCursor + 1));
  else if (key === "k" && state.mode === "units") openUnit(Math.max(0, state.unitCursor - 1));
  else if (key === "j") jumpUncertain(1);
  else if (key === "k") jumpUncertain(-1);
  else if (key === "n") openPage(state.paperId, Math.min(paperPageCount(), state.pageNumber + 1));
  else if (key === "p") openPage(state.paperId, Math.max(1, state.pageNumber - 1));
  else return;
  event.preventDefault();
});

loadManifest().catch((error) => {
  progress.textContent = error.message || String(error);
});
