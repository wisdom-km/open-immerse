const source = document.getElementById("source");
const out = document.getElementById("out");
const status = document.getElementById("status");
let pairs = [];

document.getElementById("file").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".html") || name.endsWith(".htm")) {
    source.value = await file.text();
    status.textContent = `已读入 ${file.name}`;
  } else {
    status.textContent = `${file.name} 暂不解析排版，请把正文粘贴到上方文本框。`;
  }
});

document.getElementById("run").onclick = async () => {
  const text = source.value.trim();
  if (!text) return;
  const chunks = text.split(/\n\s*\n/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 1);
  status.textContent = `正在翻译 ${chunks.length} 段…`;
  pairs = [];
  out.innerHTML = "";
  const size = 6;
  for (let i = 0; i < chunks.length; i += size) {
    const slice = chunks.slice(i, i + size);
    const res = await chrome.runtime.sendMessage({ type: "OI_TRANSLATE_BATCH", texts: slice });
    slice.forEach((org, idx) => {
      const dst = res.translations?.[idx] || "";
      pairs.push({ org, dst });
      const el = document.createElement("div");
      el.className = "pair";
      el.innerHTML = `<div class="org"></div><div class="dst" contenteditable="true"></div>`;
      el.querySelector(".org").textContent = org;
      el.querySelector(".dst").textContent = dst;
      el.querySelector(".dst").oninput = (e) => {
        pairs[pairs.length - slice.length + idx] && (pairs.find((p) => p.org === org).dst = e.target.textContent);
      };
      out.appendChild(el);
    });
  }
  status.textContent = "完成。可直接改译文后导出。";
};

document.getElementById("export").onclick = () => {
  const html = `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>双语文档</title><body>${pairs.map((p) => `<p>${escapeHtml(p.org)}</p><p><em>${escapeHtml(p.dst)}</em></p>`).join("")}</body></html>`;
  const blob = new Blob([html], { type: "text/html" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "open-immerse-bilingual.html";
  a.click();
};

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
