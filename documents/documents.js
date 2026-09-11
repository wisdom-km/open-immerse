import { escapeHtml } from "../lib/html.js";
import { DOCUMENTS_COPY, isPlainTextFile, progressStatus, splitSegments } from "../lib/documents-ui.js";

const source = document.getElementById("source");
const out = document.getElementById("out");
const status = document.getElementById("status");
const fileInput = document.getElementById("file");
const runBtn = document.getElementById("run");
const exportBtn = document.getElementById("export");
const stopBtn = document.getElementById("stop");

let pairs = [];
let aborted = false;
let running = false;

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", Boolean(isError));
}

function setIdleControls() {
  running = false;
  runBtn.disabled = false;
  runBtn.setAttribute("aria-busy", "false");
  stopBtn.disabled = true;
  exportBtn.disabled = pairs.length === 0;
}

function setRunningControls() {
  running = true;
  runBtn.disabled = true;
  runBtn.setAttribute("aria-busy", "true");
  stopBtn.disabled = false;
  exportBtn.disabled = pairs.length === 0;
}

function renderEmpty() {
  out.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty-out";
  empty.textContent = DOCUMENTS_COPY.emptyOut;
  out.append(empty);
  exportBtn.disabled = true;
}

function renderPairs() {
  if (!pairs.length) {
    renderEmpty();
    return;
  }
  out.replaceChildren();
  pairs.forEach((pair, index) => out.append(renderPair(pair, index)));
  exportBtn.disabled = false;
}

function renderPair(pair, index) {
  const el = document.createElement("div");
  el.className = "pair";
  el.dataset.index = String(index);

  const org = document.createElement("div");
  org.className = "org";
  org.textContent = pair.org;

  const dst = document.createElement("div");
  dst.className = "dst";
  if (pair.failed) {
    const msg = document.createElement("p");
    msg.className = "fail-msg";
    msg.textContent = DOCUMENTS_COPY.segmentFail;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-ghost";
    retry.dataset.retry = String(index);
    retry.textContent = DOCUMENTS_COPY.retry;
    dst.append(msg, retry);
  } else {
    dst.contentEditable = "true";
    dst.spellcheck = false;
    dst.textContent = pair.dst;
    dst.addEventListener("input", (e) => {
      pairs[index].dst = e.target.textContent;
    });
  }
  el.append(org, dst);
  return el;
}

function isFailedTranslation(res, value) {
  return res?.ok === false || !String(value || "").trim();
}

document.getElementById("pick").addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  if (isPlainTextFile(file.name)) {
    source.value = await file.text();
    setStatus(`已读入 ${file.name}`);
  } else {
    setStatus(DOCUMENTS_COPY.layoutUnsupported);
  }
});

runBtn.addEventListener("click", async () => {
  const text = source.value.trim();
  if (!text) {
    setStatus(DOCUMENTS_COPY.emptyTranslate, true);
    return;
  }
  const chunks = splitSegments(text);
  if (!chunks.length) {
    setStatus(DOCUMENTS_COPY.emptyTranslate, true);
    return;
  }
  aborted = false;
  pairs = [];
  renderEmpty();
  setRunningControls();
  const size = 6;
  for (let i = 0; i < chunks.length; i += size) {
    if (aborted) break;
    setStatus(progressStatus(i + 1, chunks.length));
    const slice = chunks.slice(i, i + size);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "OI_TRANSLATE_BATCH", texts: slice });
    } catch {
      res = { ok: false, translations: [] };
    }
    if (aborted) break;
    slice.forEach((org, idx) => {
      const dst = res.translations?.[idx] || "";
      const failed = isFailedTranslation(res, dst);
      pairs.push({ org, dst: failed ? "" : dst, failed });
    });
    renderPairs();
  }
  setIdleControls();
  if (!aborted) setStatus(DOCUMENTS_COPY.done);
});

stopBtn.addEventListener("click", () => {
  if (!running) return;
  aborted = true;
});

exportBtn.addEventListener("click", () => {
  if (!pairs.length) return;
  const html = `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>双语文档</title><body>${pairs.map((p) => `<p>${escapeHtml(p.org)}</p><p><em>${escapeHtml(p.dst)}</em></p>`).join("")}</body></html>`;
  const blob = new Blob([html], { type: "text/html" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "open-immerse-bilingual.html";
  a.click();
});

out.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-retry]");
  if (!btn) return;
  const index = Number(btn.dataset.retry);
  const pair = pairs[index];
  if (!pair) return;
  btn.disabled = true;
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "OI_TRANSLATE_BATCH", texts: [pair.org] });
  } catch {
    res = { ok: false, translations: [] };
  }
  const dst = res.translations?.[0] || "";
  const failed = isFailedTranslation(res, dst);
  pairs[index] = { org: pair.org, dst: failed ? "" : dst, failed };
  renderPairs();
});
