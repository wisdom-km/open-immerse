import { currentItems, canExport, toMarkdown, toDocx, toPdf, downloadBlob } from "../lib/export.js";
import { escapeHtml } from "../lib/html.js";
import { LEARNING_COPY, itemMeta, emptyAllHtml } from "../lib/learning-ui.js";

const listEl = document.getElementById("list");
const cardEl = document.getElementById("card");
const grades = document.getElementById("grades");
const reviewBox = document.getElementById("reviewBox");
const exportStatus = document.getElementById("exportStatus");
let items = [];
let due = [];
let current = null;
let tab = "all";

init();

async function init() {
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
  document.querySelector(".export-menu").addEventListener("click", (ev) => {
    const type = ev.target.closest("[data-export]")?.dataset.export;
    if (!type) return;
    ev.currentTarget.open = false;
    exportList(type);
  });
  grades.addEventListener("click", async (ev) => {
    const g = ev.target.closest("[data-g]")?.dataset.g;
    if (!g || !current) return;
    await chrome.runtime.sendMessage({ type: "OI_REVIEW_LEARNING", id: current.id, grade: Number(g) });
    await reload();
  });
  listEl.addEventListener("click", onListClick);
  await reload();
}

function switchTab(next) {
  tab = next;
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  reviewBox.hidden = tab !== "review";
  exportStatus.textContent = "";
  render();
}

async function onListClick(ev) {
  const confirmBtn = ev.target.closest("[data-confirm-del]");
  if (confirmBtn) {
    await chrome.runtime.sendMessage({ type: "OI_REMOVE_LEARNING", id: confirmBtn.dataset.confirmDel });
    await reload();
    return;
  }
  const cancelBtn = ev.target.closest("[data-cancel-del]");
  if (cancelBtn) {
    showDeleteGhost(cancelBtn.closest("li"));
    return;
  }
  const delBtn = ev.target.closest("[data-del]");
  if (delBtn) showDeleteConfirm(delBtn.closest("li"), delBtn.dataset.del);
}

function showDeleteGhost(row) {
  if (!row) return;
  const id = row.dataset.id;
  row.querySelector(".row-actions").innerHTML =
    `<button type="button" class="ghost" data-del="${escapeHtml(id)}">${LEARNING_COPY.delete}</button>`;
}

function showDeleteConfirm(row, id) {
  if (!row) return;
  row.querySelector(".row-actions").innerHTML =
    `<button type="button" class="danger" data-confirm-del="${escapeHtml(id)}">${LEARNING_COPY.confirmDelete}</button>` +
    `<button type="button" class="ghost" data-cancel-del>${LEARNING_COPY.cancel}</button>`;
}

async function exportList(type) {
  const list = currentItems(tab, items, due);
  if (!canExport(list)) {
    exportStatus.textContent = LEARNING_COPY.emptyExport;
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `open-immerse-learning-${tab}-${stamp}`;
  try {
    if (type === "md") {
      downloadBlob(`${base}.md`, new Blob([toMarkdown(list)], { type: "text/markdown;charset=utf-8" }));
    } else if (type === "pdf") {
      downloadBlob(`${base}.pdf`, new Blob([toPdf(list)], { type: "application/pdf" }));
    } else if (type === "docx") {
      downloadBlob(`${base}.docx`, new Blob([await toDocx(list)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    }
    exportStatus.textContent = `已导出 ${list.length} 条为 ${type.toUpperCase()}`;
  } catch (err) {
    exportStatus.textContent = `导出失败：${err.message || err}`;
  }
}

async function reload() {
  const res = await chrome.runtime.sendMessage({ type: "OI_LIST_LEARNING" });
  items = res.items || [];
  due = res.due || [];
  render();
}

function render() {
  if (tab === "review") renderReview();
  renderList();
}

function renderReview() {
  current = due[0] || null;
  grades.hidden = !current;
  if (!current) {
    cardEl.className = "card empty";
    cardEl.replaceChildren();
    const p = document.createElement("p");
    p.textContent = LEARNING_COPY.emptyReview;
    const link = document.createElement("button");
    link.type = "button";
    link.className = "ghost-link";
    link.textContent = LEARNING_COPY.viewAll;
    link.addEventListener("click", () => switchTab("all"));
    cardEl.append(p, link);
    return;
  }
  cardEl.className = "card";
  cardEl.replaceChildren();
  const org = document.createElement("div");
  org.className = "org";
  org.textContent = current.original;
  const dst = document.createElement("div");
  dst.className = "dst";
  dst.textContent = current.translation;
  cardEl.append(org, dst);
  if (current.context) {
    const ctx = document.createElement("div");
    ctx.className = "ctx";
    ctx.textContent = current.context;
    cardEl.append(ctx);
  }
}

function renderList() {
  const shown = currentItems(tab, items, due);
  if (!shown.length) {
    listEl.innerHTML = tab === "all" ? emptyAllHtml() : "";
    return;
  }
  listEl.innerHTML = shown.map((item) => {
    const id = escapeHtml(item.id);
    const ctx = item.context
      ? `<div class="meta">${escapeHtml(item.context)}</div>`
      : "";
    return `
    <li class="row" data-id="${id}">
      <strong class="org">${escapeHtml(item.original)}</strong>
      <div class="dst">${escapeHtml(item.translation)}</div>
      <div class="meta">${escapeHtml(itemMeta(item))}</div>
      ${ctx}
      <div class="row-actions">
        <button type="button" class="ghost" data-del="${id}">${LEARNING_COPY.delete}</button>
      </div>
    </li>`;
  }).join("");
}
