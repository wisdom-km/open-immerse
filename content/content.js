const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd";
const SKIP_SELECTOR = "script, style, noscript, textarea, pre, code, kbd, samp, svg, canvas, [contenteditable], .oi-translation, .oi-toast, .oi-selection-card, .oi-fab";
const MIN_LEN = 2;

let running = false;
let pageObserver = null;
let hoverBound = false;

init();

async function init() {
  window.addEventListener("oi-please-start", () => start());
  window.addEventListener("oi-please-stop", () => stop());
  window.addEventListener("oi-please-restore", () => restore());

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "OI_START") start().then(() => sendResponse({ ok: true }));
    else if (message.type === "OI_STOP") {
      stop();
      sendResponse({ ok: true });
    } else if (message.type === "OI_RESTORE") {
      restore();
      sendResponse({ ok: true });
    } else if (message.type === "OI_SHOW_SELECTION") {
      showSelectionCard(message.original, message.translated);
      sendResponse({ ok: true });
    } else if (message.type === "OI_ERROR" || message.type === "OI_TOAST") {
      toast(message.message || "translate failed");
      sendResponse({ ok: true });
    } else if (message.type === "OI_PING") {
      sendResponse({ ok: true, running });
    } else if (message.type === "OI_SAVE_CURRENT_SELECTION") {
      saveCurrentSelection().then(() => sendResponse({ ok: true }));
    } else if (message.type === "OI_FEATURES_CHANGED") {
      applyFeatures().then(() => sendResponse({ ok: true }));
    }
    return true;
  });

  await applyFeatures();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    applyFeatures();
  });
}

async function applyFeatures() {
  const res = await send({ type: "OI_GET_SETTINGS" });
  const settings = res.settings || {};
  applyStyle(settings);
  const feats = settings.features || {};
  const rule = matchRule(location.hostname, settings.siteRules || []);
  const pageOn = feats.webpage !== false;
  const hoverOn = Boolean(feats.hover || settings.hoverEnabled || rule?.hover);
  if (pageOn && (settings.enabled || rule?.auto)) await start();
  else if (!pageOn) restore();
  if (hoverOn) enableHover();
  else disableHover();
}

async function start() {
  const settings = (await send({ type: "OI_GET_SETTINGS" })).settings || {};
  if ((settings.features || {}).webpage === false) return;
  if (running) return;
  running = true;
  document.documentElement.classList.add("oi-active");
  window.dispatchEvent(new CustomEvent("oi-running", { detail: true }));
  await translateVisible();
  observePage();
}

function stop() {
  running = false;
  document.documentElement.classList.remove("oi-active");
  window.dispatchEvent(new CustomEvent("oi-running", { detail: false }));
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
}

function restore() {
  stop();
  document.querySelectorAll(".oi-translation").forEach((el) => el.remove());
  document.querySelectorAll(".oi-pending").forEach((el) => el.classList.remove("oi-pending"));
}

function observePage() {
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new MutationObserver((mutations) => {
    if (!running) return;
    const added = mutations.some((m) =>
      [...m.addedNodes].some((n) => n.nodeType === 1 && !n.classList?.contains("oi-translation") && !n.classList?.contains("oi-fab"))
    );
    if (added) debounceTranslate();
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });
}

let timer = 0;
function debounceTranslate() {
  clearTimeout(timer);
  timer = setTimeout(() => translateVisible(), 400);
}

async function translateVisible() {
  const settingsRes = await send({ type: "OI_GET_SETTINGS" });
  const settings = settingsRes.settings;
  if ((settings.features || {}).webpage === false) return;
  const nodes = collectNodes(settings);
  if (!nodes.length) return;
  const batchSize = Math.max(1, Number(settings.batchSize) || 8);
  for (let i = 0; i < nodes.length; i += batchSize) {
    if (!running) return;
    const chunk = nodes.slice(i, i + batchSize);
    chunk.forEach((el) => el.classList.add("oi-pending"));
    try {
      const res = await send({ type: "OI_TRANSLATE_BATCH", texts: chunk.map(getText) });
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
  return [...document.body.querySelectorAll(BLOCK_SELECTOR)].filter((el) => {
    if (el.closest(SKIP_SELECTOR)) return false;
    if (el.querySelector(".oi-translation")) return false;
    if (el.nextElementSibling?.classList?.contains("oi-translation")) return false;
    if (settings.skipCode && el.closest("pre, code")) return false;
    if (isTinyChrome(el)) return false;
    const text = getText(el);
    if (text.length < MIN_LEN) return false;
    if (/^[\d\s.,:;!?()[\]{}\-_/\\]+$/.test(text)) return false;
    return isMostlyVisible(el);
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
  node.title = "double click to save";
  node.addEventListener("dblclick", () => {
    send({
      type: "OI_SAVE_LEARNING",
      item: {
        original: getText(el),
        translation: text,
        context: getText(el),
        url: location.href,
        title: document.title,
        type: "sentence"
      }
    }).then(() => toast("saved"));
  });
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
  card.innerHTML = '<div class="oi-sel-org"></div><div class="oi-sel-dst"></div><div class="oi-sel-actions"><button type="button" class="save">Save</button><button type="button" class="close">Close</button></div>';
  card.querySelector(".oi-sel-org").textContent = original;
  card.querySelector(".oi-sel-dst").textContent = translated;
  card.querySelector(".close").onclick = () => card.remove();
  card.querySelector(".save").onclick = async () => {
    await send({
      type: "OI_SAVE_LEARNING",
      item: { original, translation: translated, context: original, url: location.href, title: document.title }
    });
    toast("saved");
    card.remove();
  };
  document.body.appendChild(card);
}

async function saveCurrentSelection() {
  const text = String(window.getSelection() || "").trim();
  if (!text) {
    toast("select text first");
    return;
  }
  const res = await send({ type: "OI_TRANSLATE_BATCH", texts: [text] });
  const translated = res.translations?.[0] || "";
  await send({
    type: "OI_SAVE_LEARNING",
    item: { original: text, translation: translated, context: surroundingContext(), url: location.href, title: document.title }
  });
  toast("saved");
}

function surroundingContext() {
  const node = window.getSelection()?.anchorNode?.parentElement;
  return node ? getText(node).slice(0, 280) : "";
}

function matchRule(hostname, rules) {
  const host = String(hostname || "").replace(/^www\./, "");
  return (
    rules.find((rule) => {
      const target = String(rule.host || "").replace(/^www\./, "").trim();
      return target && (host === target || host.endsWith("." + target));
    }) || null
  );
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
