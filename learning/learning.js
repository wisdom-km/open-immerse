import { currentItems, toTxt, toMarkdown, toDocx, toPptx, downloadBlob } from "../lib/export.js";

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
    btn.onclick = () => {
      tab = btn.dataset.tab;
      document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b === btn));
      reviewBox.hidden = tab !== "review";
      render();
    };
  });
  document.querySelector(".export-bar").addEventListener("click", (ev) => {
    const type = ev.target.closest("[data-export]")?.dataset.export;
    if (type) exportList(type);
  });
  grades.addEventListener("click", async (ev) => {
    const g = ev.target.dataset.g;
    if (!g || !current) return;
    await chrome.runtime.sendMessage({ type: "OI_REVIEW_LEARNING", id: current.id, grade: Number(g) });
    await reload();
  });
  await reload();
}

async function exportList(type) {
  const list = currentItems(tab, items, due);
  if (!list.length) {
    exportStatus.textContent = "当前列表是空的，没有可导出的内容。";
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `open-immerse-learning-${tab}-${stamp}`;
  try {
    if (type === "txt") {
      downloadBlob(`${base}.txt`, new Blob([toTxt(list)], { type: "text/plain;charset=utf-8" }));
    } else if (type === "md") {
      downloadBlob(`${base}.md`, new Blob([toMarkdown(list)], { type: "text/markdown;charset=utf-8" }));
    } else if (type === "docx") {
      downloadBlob(`${base}.docx`, new Blob([await toDocx(list)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    } else if (type === "pptx") {
      downloadBlob(`${base}.pptx`, new Blob([await toPptx(list)], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }));
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
  if (tab === "review") {
    current = due[0] || null;
    grades.hidden = !current;
    if (!current) {
      cardEl.className = "card empty";
      cardEl.textContent = "没有到期项目";
    } else {
      cardEl.className = "card";
      cardEl.innerHTML = `<div class="org"></div><div class="dst"></div><div class="ctx"></div>`;
      cardEl.querySelector(".org").textContent = current.original;
      cardEl.querySelector(".dst").textContent = current.translation;
      cardEl.querySelector(".ctx").textContent = current.context || current.url || "";
    }
  }
  const shown = currentItems(tab, items, due);
  listEl.innerHTML = shown.map((item) => `
    <li data-id="${item.id}">
      <strong>${escapeHtml(item.original)}</strong>
      <div>${escapeHtml(item.translation)}</div>
      <div class="meta">${escapeHtml(item.type)} · ${escapeHtml(item.title || item.url || "")} · 下次复习 ${new Date(item.nextReview).toLocaleDateString()}</div>
      ${item.context ? `<div class="meta">语境：${escapeHtml(item.context)}</div>` : ""}
      <button data-del="${item.id}">删除</button>
    </li>
  `).join("") || "<li class='meta'>还没有收藏。</li>";
  listEl.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "OI_REMOVE_LEARNING", id: btn.dataset.del });
      await reload();
    };
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&", "<": "<", ">": ">", '"': """, "'": "&#39;" }[c]));
}
