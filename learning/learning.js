const listEl = document.getElementById("list");
const cardEl = document.getElementById("card");
const grades = document.getElementById("grades");
const reviewBox = document.getElementById("reviewBox");
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
  grades.addEventListener("click", async (ev) => {
    const g = ev.target.dataset.g;
    if (!g || !current) return;
    await chrome.runtime.sendMessage({ type: "OI_REVIEW_LEARNING", id: current.id, grade: Number(g) });
    await reload();
  });
  await reload();
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
  const shown = tab === "review" ? due : items;
  listEl.innerHTML = shown.map((item) => `
    <li data-id="${item.id}">
      <strong>${escapeHtml(item.original)}</strong>
      <div>${escapeHtml(item.translation)}</div>
      <div class="meta">${escapeHtml(item.type)} · ${escapeHtml(item.title || item.url || "")} · 下次复习 ${new Date(item.nextReview).toLocaleDateString()}</div>
      ${item.context ? `<div class="meta">语境：${escapeHtml(item.context)}</div>` : ""}
      <button data-del="${item.id}">删除</button>
    </li>
  `).join("") || "<li class='meta'>还没有收藏。在网页里选中文本右键「收藏到学习中心」，或双击译文。</li>";
  listEl.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async () => {
      await chrome.runtime.sendMessage({ type: "OI_REMOVE_LEARNING", id: btn.dataset.del });
      await reload();
    };
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
