const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd";
const SKIP_SELECTOR = "script, style, noscript, textarea, pre, code, kbd, samp, svg, canvas, [contenteditable], .oi-translation, .oi-toast, .oi-selection-card";
const MIN_LEN = 2;

let running = false;
let observer = null;
let hoverBound = false;

init();

async function init() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "OI_START") start().then(() => sendResponse({ ok: true }));
    else if (message.type === "OI_STOP") {
      stop();
      sendResponse({ ok: true });
    } else if (message.type === "OI_SHOW_SELECTION") {
      showSelectionCard(message.original, message.translated);
      sendResponse({ ok: true });
    } else if (message.type === "OI_ERROR") {
      toast(message.message || "翻译失败");
      sendResponse({ ok: true });
    } else if (message.type === "OI_PING") {
      sendResponse({ ok: true, running });
    }
    return true;
  });

  const res = await send({ type: "OI_GET_SETTINGS" });
  const settings = res.settings;
  applyStyle(settings);
  if (settings.enabled) start();
  if (settings.hoverEnabled) enableHover();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    const next = changes.settings.newValue;
    applyStyle(next);
    if (next.hoverEnabled) enableHover();
    else disableHover();
  });
}

async function start() {
  if (running) return;
  running = true;
  document.documentElement.classList.add("oi-active");
  await translateVisible();
  observe();
}

function stop() {
  running = false;
  document.documentElement.classList.remove("oi-active");
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function observe() {
  if (observer) observer.disconnect();
  observer = new MutationObserver((mutations) => {
    if (!running) return;
    const added = mutations.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !n.classList?.contains("oi-translation")));
    if (added) debounceTranslate();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

let timer = 0;
function debounceTranslate() {
  clearTimeout(timer);
  timer = setTimeout(() => translateVisible(), 400);
}

async function translateVisible() {
  const settingsRes = await send({ type: "OI_GET_SETTINGS" });
  const settings = settingsRes.settings;
  const nodes = collectNodes(settings);
  if (!nodes.length) return;

  const batchSize = Math.max(1, Number(settings.batchSize) || 8);
  for (let i = 0; i < nodes.length; i += batchSize) {
    if (!running) return;
    const chunk = nodes.slice(i, i + batchSize);
    chunk.forEach((el) => el.classList.add("oi-pending"));
    try {
      const res = await send({
        type: "OI_TRANSLATE_BATCH",
        texts: chunk.map(getText)
      });
      if (!res.ok) throw new Error(res.error || "translate failed");
      chunk.forEach((el, idx) => {
        el.classList.remove("oi-pending");
        mountTranslation(el, res.translations[idx] || "", settings);
      });
    } catch (err) {
      chunk.forEach((el) => el.classList.remove("oi-pending"));
      toast(String(err.message || err));
      break;
    }
  }
}

function collectNodes(settings) {
  const all = [...document.body.querySelectorAll(BLOCK_SELECTOR)];
  return all.filter((el) => {
    if (el.closest(SKIP_SELECTOR)) return false;
    if (el.querySelector(".oi-translation")) return false;
    if (el.nextElementSibling?.classList?.contains("oi-translation")) return false;
    if (settings.skipCode && el.closest("pre, code")) return false;
    if (isTinyChrome(el)) return false;
    const text = getText(el);
    if (text.length < MIN_LEN) return false;
    if (/^[\d\s.,:;!?()[\]{}\-_/\\]+$/.test(text)) return false;
    if (!isMostlyVisible(el)) return false;
    return true;
  });
}

function getText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".oi-translation, script, style, noscript").forEach((n) => n.remove());
  return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
}

function mountTranslation(el, text, settings) {
  if (!text) return;
  const existing = el.nextElementSibling?.classList?.contains("oi-translation")
    ? el.nextElementSibling
    : el.querySelector(":scope > .oi-translation");
  if (existing) {
    existing.textContent = text;
    return;
  }
  const node = document.createElement("div");
  node.className = "oi-translation";
  node.lang = settings.targetLang || "zh-CN";
  node.textContent = text;
  if (["LI", "TD", "TH", "DT", "DD"].includes(el.tagName)) el.appendChild(node);
  else el.insertAdjacentElement("afterend", node);
}

function isTinyChrome(el) {
  if (["NAV", "FOOTER", "HEADER"].includes(el.parentElement?.tagName)) return getText(el).length < 24;
  if (el.tagName === "A" || el.closest("nav, [role='navigation']")) return getText(el).length < 40;
  return false;
}

function isMostlyVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const style = getComputedStyle(el);
  return !(style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0);
}

function applyStyle(settings) {
  const root = document.documentElement;
  root.style.setProperty("--oi-font-scale", settings.fontScale || 0.95);
  if (settings.color) root.style.setProperty("--oi-color", settings.color);
  else root.style.removeProperty("--oi-color");
  root.dataset.oiStyle = settings.translationStyle || "under";
}

function enableHover() {
  if (hoverBound) return;
  hoverBound = true;
  document.addEventListener("mouseover", onHover, true);
}

function disableHover() {
  hoverBound = false;
  document.removeEventListener("mouseover", onHover, true);
}

let hoverTimer = 0;
function onHover(ev) {
  const el = ev.target.closest(BLOCK_SELECTOR);
  if (!el || el.closest(SKIP_SELECTOR)) return;
  if (el.querySelector(".oi-translation") || el.nextElementSibling?.classList?.contains("oi-translation")) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(async () => {
    const text = getText(el);
    if (text.length < MIN_LEN) return;
    const res = await send({ type: "OI_TRANSLATE_BATCH", texts: [text] });
    if (res.ok) {
      const settings = (await send({ type: "OI_GET_SETTINGS" })).settings;
      mountTranslation(el, res.translations[0], settings);
    }
  }, 350);
}

function showSelectionCard(original, translated) {
  document.querySelector(".oi-selection-card")?.remove();
  const card = document.createElement("div");
  card.className = "oi-selection-card";
  card.innerHTML = `<div class="oi-sel-org"></div><div class="oi-sel-dst"></div><button type="button">关闭</button>`;
  card.querySelector(".oi-sel-org").textContent = original;
  card.querySelector(".oi-sel-dst").textContent = translated;
  card.querySelector("button").onclick = () => card.remove();
  document.body.appendChild(card);
}

function toast(message) {
  let el = document.querySelector(".oi-toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "oi-toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3200);
}

function send(payload) {
  return chrome.runtime.sendMessage(payload);
}
