import { unitIdFromMembers, verifyPageLabels } from "/lib/label-schema.js";
import { importRejection, missingPdfBanner, planMerge, reviewActionsLocked } from "/lib/review-actions.js";
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
  scrollSelection: false
};

const progress = document.querySelector("#progress");
const saveState = document.querySelector("#save-state");
const stage = document.querySelector("#stage");
const queue = document.querySelector("#queue");
const detail = document.querySelector("#detail");
const summary = document.querySelector("#selection-summary");

function pageFile(pageNumber) {
  return `page-${String(pageNumber).padStart(3, "0")}.json`;
}

async function loadManifest() {
  state.manifest = await (await fetch("/api/manifest")).json();
  state.status = await (await fetch("/api/status")).json();
  const setResponse = await fetch("/api/review-set");
  state.reviewSet = setResponse.ok ? await setResponse.json() : { units: [] };
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
    head.textContent = "整页队列 · 低置信度优先";
    queue.append(head);
    for (const row of state.status.queue.slice(0, 40)) {
      const button = document.createElement("button");
      button.textContent = `${row.field} ${row.paperId} 第 ${row.page} 页 · ${row.uncertain}`;
      button.className = row.paperId === state.paperId && row.page === state.pageNumber ? "current" : "";
      button.addEventListener("click", () => openPage(row.paperId, row.page));
      queue.append(button);
    }
    return;
  }
  head.textContent = "单元队列 · 低置信度靠前，领域交错";
  queue.append(head);
  const keys = reviewedKeySet();
  const units = state.reviewSet.units || [];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const button = document.createElement("button");
    const done = keys.has(unitKey(unit)) ? "已看 · " : "";
    button.textContent = `${done}${unit.field} ${unit.paperId} 第 ${unit.page} 页 ${unit.type === "display" ? "行间" : "行内"} ${unit.confidence}`;
    button.className = index === state.unitCursor ? "current" : "";
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
  if (state.pdf) await state.pdf.destroy();
  state.pdf = null;
  state.scrollSelection = false;
  state.pendingFocus = null;
  setLocked(true);
  stage.innerHTML = "";
  const banner = document.createElement("div");
  banner.id = "pdf-missing";
  banner.setAttribute("role", "alert");
  banner.textContent = missingPdfBanner(paperId);
  stage.append(banner);
  saveState.textContent = "缺少 PDF，已停止复核这一单元";
  renderQueue();
}

async function openPage(paperId, pageNumber, focus = null) {
  state.paperId = paperId;
  state.pageNumber = pageNumber;
  state.pendingFocus = focus;
  state.selected = new Set();
  const response = await fetch(`/api/page/${encodeURIComponent(paperId)}/${pageNumber}`);
  if (!response.ok) {
    await showMissingPdf(paperId);
    return;
  }
  const payload = await response.json();
  state.page = payload.page;
  state.prelabel = payload.prelabel;
  state.uncertain = state.page.elements
    .filter((element) => Number(element.confidence) < 0.75)
    .sort((a, b) => a.confidence - b.confidence)
    .map((element) => element.id);
  const pdfResponse = await fetch(`/api/pdf/${encodeURIComponent(paperId)}`);
  if (!pdfResponse.ok) {
    await showMissingPdf(paperId);
    return;
  }
  if (state.pdf) await state.pdf.destroy();
  try {
    const pdf = await pdfjs.getDocument({ url: `/api/pdf/${encodeURIComponent(paperId)}`, verbosity: 0 }).promise;
    state.pdf = pdf;
  } catch (error) {
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
  const nodes = [...stage.querySelectorAll("rect.hit.selected")];
  if (!main || !nodes.length) return;
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

async function paint() {
  if (reviewActionsLocked(state.pdfMissing) || !state.pdf) return;
  const token = ++paintToken;
  const pdfPage = await state.pdf.getPage(state.pageNumber);
  if (token !== paintToken) return;
  const viewport = pdfPage.getViewport({ scale: state.scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  if (token !== paintToken) return;
  if (state.pendingFocus) {
    const ids = new Set(state.pendingFocus.elementIds || []);
    const matched = state.page.elements.filter((element) => ids.has(element.id));
    const fallback = matched.length ? matched : state.page.elements.filter((element) => element.unitId === state.pendingFocus.unitId);
    if (fallback.length) state.selected = new Set(fallback.map((element) => element.id));
  }
  stage.innerHTML = "";
  stage.append(canvas);
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  overlay.setAttribute("id", "overlay");
  overlay.setAttribute("width", canvas.width);
  overlay.setAttribute("height", canvas.height);
  const hues = new Map();
  for (const element of state.page.elements) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const [x0, y0, x1, y1] = element.bbox;
    rect.setAttribute("x", x0 * state.scale);
    rect.setAttribute("y", y0 * state.scale);
    rect.setAttribute("width", Math.max(0.5, (x1 - x0) * state.scale));
    rect.setAttribute("height", Math.max(0.5, (y1 - y0) * state.scale));
    rect.dataset.id = element.id;
    const classes = ["hit", element.label];
    if (state.selected.has(element.id)) classes.push("selected");
    if (Number(element.confidence) < 0.75) classes.push("uncertain");
    rect.setAttribute("class", classes.join(" "));
    if (state.selected.has(element.id)) {
      rect.style.stroke = "#b00000";
      rect.style.strokeWidth = "3.5px";
      rect.style.strokeDasharray = "none";
      rect.style.fill = "rgba(176, 0, 0, 0.25)";
    } else if (element.label === "formula" && element.unitId) {
      if (!hues.has(element.unitId)) hues.set(element.unitId, hues.size * 47);
      rect.style.stroke = `hsl(${hues.get(element.unitId)} 70% 32%)`;
    }
    overlay.append(rect);
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
  const groups = new Map();
  for (const element of state.page.elements) {
    if (element.label !== "formula") {
      element.unitId = null;
      element.unitType = null;
      element.equationNumber = false;
      continue;
    }
    if (!element.unitId) element.unitId = `tmp-${element.id}`;
    if (!element.unitType) element.unitType = "inline";
    element.equationNumber = element.equationNumber === true;
    if (!groups.has(element.unitId)) groups.set(element.unitId, []);
    groups.get(element.unitId).push(element);
  }
  state.page.units = [];
  for (const members of groups.values()) {
    const id = unitIdFromMembers(members.map((member) => member.id));
    const type = members.some((member) => member.unitType === "display") ? "display" : "inline";
    const equationNumber = members.some((member) => member.equationNumber === true);
    const confidence = Math.min(...members.map((member) => Number(member.confidence) || 0));
    for (const member of members) {
      member.unitId = id;
      member.unitType = type;
      member.equationNumber = member.equationNumber === true && equationNumber;
    }
    state.page.units.push({
      id,
      type,
      equationNumber,
      confidence: Math.round(confidence * 1000) / 1000,
      fallback: confidence < 0.65,
      elementIds: members.map((member) => member.id)
    });
  }
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
  summary.textContent = elements.length ? `选中 ${elements.length} 个` : "还没有选中元素。";
  detail.textContent = elements.slice(0, 8).map((element) => {
    return `${element.label} ${element.confidence} ${element.rule || ""}\n${JSON.stringify(element.char)} ${element.font}\n${element.bbox.join(", ")} ${element.unitId || ""}`;
  }).join("\n\n");
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
  if (event.shiftKey) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
  } else {
    state.selected = new Set([id]);
  }
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
    if (Math.abs(now.x - start.x) + Math.abs(now.y - start.y) > 3) dragSelect = true;
    const rect = [
      Math.min(start.x, now.x) / state.scale,
      Math.min(start.y, now.y) / state.scale,
      Math.max(start.x, now.x) / state.scale,
      Math.max(start.y, now.y) / state.scale
    ];
    if (!event.shiftKey) state.selected = new Set();
    for (const element of state.page.elements) {
      const box = element.bbox;
      const hit = box[0] < rect[2] && box[2] > rect[0] && box[1] < rect[3] && box[3] > rect[1];
      if (hit) state.selected.add(element.id);
    }
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
  for (const element of selectedElements()) {
    element.label = label;
    element.confidence = 1;
    element.rule = "human";
    if (label === "formula" && !element.unitId) element.unitId = `tmp-${element.id}`;
  }
  rebuild();
  paint();
}

function setType(type) {
  if (reviewActionsLocked(state.pdfMissing)) return;
  for (const element of selectedElements()) {
    if (element.label !== "formula") continue;
    element.unitType = type;
  }
  rebuild();
  paint();
}

function merge() {
  if (reviewActionsLocked(state.pdfMissing)) return;
  const plan = planMerge(state.page?.elements, state.selected);
  if (!plan.ok) {
    summary.textContent = plan.message;
    return;
  }
  const id = `merge-${plan.ids[0]}`;
  for (const element of state.page.elements) {
    if (plan.ids.includes(element.id)) element.unitId = id;
  }
  rebuild();
  paint();
}

function split() {
  if (reviewActionsLocked(state.pdfMissing)) return;
  for (const element of selectedElements()) {
    if (element.label !== "formula") continue;
    element.unitId = `split-${element.id}`;
  }
  rebuild();
  paint();
}

function jumpUncertain(step) {
  if (reviewActionsLocked(state.pdfMissing)) return;
  if (!state.uncertain.length) return;
  const current = [...state.selected][0];
  let index = state.uncertain.indexOf(current);
  index = index < 0 ? 0 : (index + step + state.uncertain.length) % state.uncertain.length;
  state.selected = new Set([state.uncertain[index]]);
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
  for (const element of selectedElements()) {
    if (element.label !== "formula") continue;
    element.equationNumber = element.equationNumber !== true;
  }
  rebuild();
  paint();
});
document.querySelector("#merge").addEventListener("click", merge);
document.querySelector("#split").addEventListener("click", split);
document.querySelector("#zoom").addEventListener("input", (event) => {
  state.scale = Number(event.target.value);
  paint();
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
  const unit = state.reviewSet.units?.[state.unitCursor];
  if (!unit || state.paperId !== unit.paperId || state.pageNumber !== unit.page) return;
  if (!Array.isArray(state.page.reviewedUnitIds)) state.page.reviewedUnitIds = [];
  if (!state.page.reviewedUnitIds.includes(unit.unitId)) state.page.reviewedUnitIds.push(unit.unitId);
  const payload = state.page;
  const paperId = state.paperId;
  const pageNumber = state.pageNumber;
  const next = nextUnreviewed(state.unitCursor + 1);
  clearTimeout(saveTimer);
  await save(payload, paperId, pageNumber);
  if (next >= 0) await openUnit(next);
}

document.querySelector("#mode-units").addEventListener("click", () => {
  state.mode = "units";
  const index = state.unitCursor || 0;
  openUnit(index);
});
document.querySelector("#mode-pages").addEventListener("click", () => {
  state.mode = "pages";
  renderQueue();
});
document.querySelector("#confirm-unit").addEventListener("click", confirmUnit);

window.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea, select")) return;
  if (reviewActionsLocked(state.pdfMissing)) return;
  const key = event.key.toLowerCase();
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
  else if (key === "j" && state.mode === "units") openUnit(Math.min((state.reviewSet.units?.length || 1) - 1, state.unitCursor + 1));
  else if (key === "k" && state.mode === "units") openUnit(Math.max(0, state.unitCursor - 1));
  else if (key === "j") jumpUncertain(1);
  else if (key === "k") jumpUncertain(-1);
  else if (key === "n") openPage(state.paperId, Math.min(state.pdf.numPages, state.pageNumber + 1));
  else if (key === "p") openPage(state.paperId, Math.max(1, state.pageNumber - 1));
  else return;
  event.preventDefault();
});

loadManifest().catch((error) => {
  progress.textContent = error.message || String(error);
});
