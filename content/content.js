let running = false;
let epoch = 0;
let pageObserver = null;
let hoverBound = false;
let scanApi = null;
let timer = 0;

bindPageControls();
const ready = boot();
ready.then(() => applyFeatures()).catch(() => {});

async function boot() {
  scanApi = await import(chrome.runtime.getURL("lib/page-scan.js"));
}

function bindPageControls() {
  window.addEventListener("oi-please-start", () => start());
  window.addEventListener("oi-please-stop", () => restore());
  window.addEventListener("oi-please-restore", () => restore());

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "OI_START") start().then(() => sendResponse({ ok: true }));
    else if (message.type === "OI_STOP" || message.type === "OI_RESTORE") {
      restore();
      sendResponse({ ok: true });
    } else if (message.type === "OI_SHOW_SELECTION") {
      showSelectionCard(message.original, message.translated);
      sendResponse({ ok: true });
    } else if (message.type === "OI_ERROR" || message.type === "OI_TOAST") {
      toast(message.message || "translate failed");
      sendResponse({ ok: true });
    } else if (message.type === "OI_PING") {
      sendResponse({
        ok: true,
        running,
        active: document.documentElement.classList.contains("oi-active"),
        hasTranslations: hasTranslations()
      });
    } else if (message.type === "OI_SAVE_CURRENT_SELECTION") {
      saveCurrentSelection().then(() => sendResponse({ ok: true }));
    } else if (message.type === "OI_FEATURES_CHANGED") {
      applyFeatures().then(() => sendResponse({ ok: true }));
    }
    return true;
  });

  window.__oiPage = {
    start,
    stop: restore,
    restore,
    isRunning: () => running,
    hasTranslations
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.settings) return;
    applyStyle(changes.settings.newValue || {});
  });
}

function stillCurrent(ticket) {
  return running && ticket === epoch;
}

function hasTranslations() {
  return Boolean(document.querySelector(".oi-translation"));
}

async function applyFeatures() {
  await ready;
  if (!scanApi) return;
  const res = await send({ type: "OI_GET_SETTINGS" });
  const settings = res.settings || {};
  applyStyle(settings);
  const feats = settings.features || {};
  const rule = matchRule(location.hostname, settings.siteRules || []);
  const pageOn = feats.webpage !== false;
  const hoverOn = Boolean(feats.hover || settings.hoverEnabled || rule?.hover);
  const shouldAuto = Boolean(pageOn && (rule?.auto || settings.autoOnNewPages));
  if (shouldAuto) await start();
  else if (!pageOn) restore();
  if (hoverOn) enableHover();
  else disableHover();
}

async function start() {
  const ticket = epoch;
  await ready;
  if (epoch !== ticket) return;
  const settings = (await send({ type: "OI_GET_SETTINGS" })).settings || {};
  if (epoch !== ticket) return;
  if ((settings.features || {}).webpage === false) return;
  if (running) return;
  running = true;
  document.documentElement.classList.add("oi-active");
  window.dispatchEvent(new CustomEvent("oi-running", { detail: true }));
  await translateVisible(ticket);
  if (stillCurrent(ticket)) observePage(ticket);
}

function stop() {
  running = false;
  document.documentElement.classList.remove("oi-active");
  window.dispatchEvent(new CustomEvent("oi-running", { detail: false }));
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
  clearTimeout(timer);
  timer = 0;
}

function restore() {
  epoch += 1;
  stop();
  document.querySelectorAll(".oi-translation, .oi-selection-card").forEach((el) => el.remove());
  document.querySelectorAll(".oi-pending, .oi-failed").forEach((el) => {
    el.classList.remove("oi-pending", "oi-failed");
  });
  send({ type: "OI_SAVE_SETTINGS", patch: { enabled: false } }).catch(() => {});
}

function observePage(ticket) {
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new MutationObserver((mutations) => {
    if (!stillCurrent(ticket)) return;
    const added = mutations.some((m) =>
      [...m.addedNodes].some((n) => n.nodeType === 1 && !n.classList?.contains("oi-translation") && !n.classList?.contains("oi-fab"))
    );
    if (added) debounceTranslate(ticket);
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });
}

function debounceTranslate(ticket) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (stillCurrent(ticket)) translateVisible(ticket);
  }, 400);
}

async function translateVisible(ticket) {
  if (!stillCurrent(ticket)) return;
  const settingsRes = await send({ type: "OI_GET_SETTINGS" });
  if (!stillCurrent(ticket)) return;
  const settings = settingsRes.settings;
  if ((settings.features || {}).webpage === false) return;
  const nodes = collectNodes(settings);
  if (!nodes.length) return;
  const batchSize = Math.max(1, Number(settings.batchSize) || 8);
  for (let i = 0; i < nodes.length; i += batchSize) {
    if (!stillCurrent(ticket)) return;
    const chunk = nodes.slice(i, i + batchSize);
    chunk.forEach((el) => el.classList.add("oi-pending"));
    try {
      const res = await send({ type: "OI_TRANSLATE_BATCH", texts: chunk.map(getText) });
      if (!stillCurrent(ticket)) {
        chunk.forEach((el) => el.classList.remove("oi-pending"));
        return;
      }
      if (!res.ok) throw new Error(res.error || "translate failed");
      chunk.forEach((el, idx) => {
        el.classList.remove("oi-pending");
        if (stillCurrent(ticket)) mountTranslation(el, res.translations[idx] || "", settings);
      });
    } catch (err) {
      chunk.forEach((el) => el.classList.remove("oi-pending"));
      if (stillCurrent(ticket)) toast(String(err.message || err));
      break;
    }
  }
}

function collectNodes(settings) {
  if (scanApi?.collectNodes) {
    return scanApi.collectNodes(document, settings, {
      hostname: location.hostname,
      innerWidth: window.innerWidth
    });
  }
  return [];
}

function getText(el) {
  if (scanApi?.getText) return scanApi.getText(el);
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".oi-translation, script, style, noscript").forEach((n) => n.remove());
  return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
}

function shouldInline(el) {
  if (scanApi?.shouldInline) return scanApi.shouldInline(el);
  return el.tagName === "A" || el.tagName === "BUTTON";
}

function mountTranslation(el, text, settings) {
  if (!text || !el.isConnected) return;
  const existing = el.querySelector(":scope > .oi-translation") ||
    (el.nextElementSibling?.classList?.contains("oi-translation") ? el.nextElementSibling : null);
  if (existing) {
    existing.textContent = text;
    return;
  }
  const inline = shouldInline(el);
  const node = document.createElement(inline ? "span" : "div");
  node.className = inline ? "oi-translation oi-inline" : "oi-translation";
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
  if (inline || ["LI", "TD", "TH", "DT", "DD"].includes(el.tagName)) el.appendChild(node);
  else el.insertAdjacentElement("afterend", node);
}

function applyStyle(settings) {
  const root = document.documentElement;
  if (!settings) return;
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
  const el = ev.target.closest(scanApi?.BLOCK_SELECTOR || "p, h1, h2, h3, h4, h5, h6, li, blockquote");
  if (!el || el.closest(scanApi?.SKIP_SELECTOR || ".oi-translation, .oi-fab")) return;
  if (el.querySelector(".oi-translation") || el.nextElementSibling?.classList?.contains("oi-translation")) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(async () => {
    const text = getText(el);
    if (text.length < 2) return;
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
