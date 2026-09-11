const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd";
const SKIP_SELECTOR = "script, style, noscript, textarea, pre, code, kbd, samp, svg, canvas, [contenteditable], .oi-translation, .oi-toast, .oi-selection-card, .oi-fab";
const MAIN_SELECTOR = "main, article, [role='main'], [role='article']";
const CHROME_SELECTOR = "nav, aside, header, footer, [role='navigation'], [role='complementary'], [role='banner'], [role='contentinfo'], [role='menu'], [role='menubar'], [data-aside-rail], [data-aside-track], [class*='hero_blog_post_details'], [class*='blog_post_details'], [class*='marginalia']";
const ALWAYS_CHROME_SELECTOR = "nav, aside, header, [role='navigation'], [role='complementary'], [role='banner'], [role='menu'], [role='menubar'], [data-aside-rail], [data-aside-track], [class*='hero_blog_post_details'], [class*='blog_post_details'], [class*='marginalia']";
const HARD_SKIP_SELECTOR = [
  "[data-aside-rail]",
  "[data-aside-track]",
  "[data-rail]",
  "[class*='marginalia']",
  "[class*='hero_blog_post_details']",
  ".hero_blog_post_details",
  ".hero_blog_post_details_list",
  ".hero_blog_post_details_item",
  ".hero_blog_post_details_content",
  "[class*='blog_post_details']",
  "[class*='details_list']",
  "[class*='details_item']"
].join(", ");
const CHROME_META_RE = /^(category|product|date|author(?:\(s\))?|share|reading time|copy link|\d+\s*min\b)/i;
const MIN_LEN = 2;

let running = false;
let epoch = 0;
let pageObserver = null;
let hoverBound = false;
let timer = 0;

init();

async function init() {
  window.addEventListener("oi-please-start", () => start());
  window.addEventListener("oi-please-stop", () => restore());
  window.addEventListener("oi-please-restore", () => restore());

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "OI_START") start().then(() => sendResponse({ ok: true }));
    else if (message.type === "OI_RESTORE") {
      restore();
      sendResponse({ ok: true });
    } else if (message.type === "OI_STOP") {
      restore();
      sendResponse({ ok: true });
    } else if (message.type === "OI_SHOW_SELECTION") {
      showSelectionCard(message.original, message.translated);
      sendResponse({ ok: true });
    } else if (message.type === "OI_ERROR" || message.type === "OI_TOAST") {
      toast(message.message || "翻译失败");
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
    applyStyle(changes.settings.newValue || {});
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
  const shouldAuto = Boolean(pageOn && (rule?.auto || settings.autoOnNewPages));
  if (shouldAuto) await start();
  else if (!pageOn) restore();
  if (hoverOn) enableHover();
  else disableHover();
}

async function start() {
  const ticket = epoch;
  const settings = (await send({ type: "OI_GET_SETTINGS" }))?.settings || {};
  if (epoch !== ticket) return;
  if ((settings.features || {}).webpage === false) return;
  if (running) return;
  running = true;
  document.documentElement.classList.add("oi-active");
  window.dispatchEvent(new CustomEvent("oi-running", { detail: true }));
  await translateVisible(ticket);
  if (running && epoch === ticket) observePage();
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
  running = false;
  stop();
  document.querySelectorAll(".oi-translation, .oi-selection-card").forEach((el) => el.remove());
  document.querySelectorAll(".oi-pending, .oi-failed").forEach((el) => {
    el.classList.remove("oi-pending", "oi-failed");
  });
  const fab = document.querySelector('.oi-fab [data-act="toggle"]');
  if (fab) {
    fab.textContent = "译";
    fab.classList.remove("on");
  }
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

function debounceTranslate() {
  clearTimeout(timer);
  timer = setTimeout(() => translateVisible(epoch), 400);
}

async function translateVisible(ticket = epoch) {
  if (!running || ticket !== epoch) return;
  const settingsRes = await send({ type: "OI_GET_SETTINGS" });
  if (!running || ticket !== epoch) return;
  const settings = settingsRes.settings;
  if ((settings.features || {}).webpage === false) return;
  // batchSize only chunks API requests. translateLimit caps total nodes.
  const collected = collectNodes(settings, { includeTranslated: true });
  const limited = applyTranslateLimit(collected, settings.translateLimit);
  const nodes = limited.filter((el) => !hasTranslation(el));
  if (!nodes.length) return;
  if (settings.translateLimit === "preview" || settings.translateLimit === 2 || settings.translateLimit === "2") {
    toast("预览：仅标题+开头（省 token）");
  }
  const batchSize = Math.max(1, Number(settings.batchSize) || 8);
  for (let i = 0; i < nodes.length; i += batchSize) {
    if (!running || ticket !== epoch) return;
    const chunk = nodes.slice(i, i + batchSize);
    chunk.forEach((el) => el.classList.add("oi-pending"));
    try {
      const res = await send({ type: "OI_TRANSLATE_BATCH", texts: chunk.map((el) => previewSourceText(getText(el), settings.translateLimit)) });
      if (!running || ticket !== epoch) {
        chunk.forEach((el) => el.classList.remove("oi-pending"));
        return;
      }
      if (!res.ok) throw new Error(res.error || "翻译失败");
      chunk.forEach((el, idx) => {
        el.classList.remove("oi-pending");
        if (running && ticket === epoch) mountTranslation(el, res.translations[idx] || "", settings);
      });
    } catch (err) {
      chunk.forEach((el) => el.classList.remove("oi-pending"));
      toast(String(err.message || err));
      break;
    }
  }
}

function hasTranslation(el) {
  return Boolean(el.querySelector(".oi-translation") || el.nextElementSibling?.classList?.contains("oi-translation"));
}

/** Keep in sync with lib/translate-limit.js */
function applyTranslateLimit(nodes, limit) {
  const list = Array.isArray(nodes) ? nodes : [];
  const preview = limit === "preview" || limit === 2 || limit === "2";
  const all = limit == null || limit === "" || limit === "all" || limit === 0 || limit === "0";
  if (!list.length || (all && !preview)) return list;
  if (preview) {
    const heading = list.find((el) => /^H[1-6]$/.test(el.tagName || ""));
    const rest = list.filter((el) => el !== heading);
    const short = rest.filter((el) => {
      const text = getText(el);
      return text.length > 0 && text.length <= 220;
    });
    const picked = [];
    if (heading) picked.push(heading);
    for (const el of short.slice(0, 2)) picked.push(el);
    if (picked.length <= 1) {
      const para = rest.find((el) => /^(P|BLOCKQUOTE)$/.test(el.tagName || "")) || rest[0];
      if (para) picked.push(para);
    }
    return picked.length ? picked : list.slice(0, 2);
  }
  const n = Number(limit);
  if (Number.isFinite(n) && n > 0) return list.slice(0, Math.floor(n));
  return list;
}

function previewSourceText(text, limit) {
  const preview = limit === "preview" || limit === 2 || limit === "2";
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!preview || t.length <= 220) return t;
  const m = t.match(/^[\s\S]{1,180}?[.!?。！？]/);
  return (m ? m[0] : t.slice(0, 160)).trim();
}

function collectNodes(settings, opts = {}) {
  const scope = settings.translateScope || "article";
  const includeTranslated = Boolean(opts.includeTranslated);
  const nodes = [...document.body.querySelectorAll(BLOCK_SELECTOR)].filter((el) => {
    if (el.closest(SKIP_SELECTOR)) return false;
    if (!includeTranslated && hasTranslation(el)) return false;
    if (settings.skipCode && el.closest("pre, code")) return false;
    if (el.tagName === "A" && el.closest("li, p, h1, h2, h3, h4, h5, h6")) return false;
    if (el.closest(HARD_SKIP_SELECTOR) || el.closest(ALWAYS_CHROME_SELECTOR) || el.closest(CHROME_SELECTOR)) return false;
    if (isInMetaRail(el)) return false;
    if (isSideColumn(el)) return false;
    if (scope === "article" && isTinyChrome(el)) return false;
    const text = getText(el);
    if (text.length < MIN_LEN) return false;
    if (/^[\d\s.,:;!?()[\]{}\-_/\\]+$/.test(text)) return false;
    return isMostlyVisible(el);
  });
  return nodes.sort((a, b) => {
    const diff = contentRank(a) - contentRank(b);
    if (diff) return diff;
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

function contentRank(el) {
  if (el.closest(MAIN_SELECTOR) && !el.closest(CHROME_SELECTOR) && !el.closest(HARD_SKIP_SELECTOR)) return 0;
  if (isSideColumn(el) || el.closest(CHROME_SELECTOR) || el.closest(HARD_SKIP_SELECTOR)) return 2;
  return 1;
}

function isSideColumn(el) {
  const rect = el.getBoundingClientRect();
  const vw = Math.max(window.innerWidth || 0, 800);
  if (rect.width < 4) return false;
  if (rect.right < vw * 0.28 && rect.width < vw * 0.38) return true;
  if (rect.left > vw * 0.58 && rect.width < vw * 0.45) return true;
  const main = el.closest(MAIN_SELECTOR);
  if (main) {
    const box = main.getBoundingClientRect();
    if (box.width > 4 && rect.left > box.left + box.width * 0.58 && rect.width < box.width * 0.5) return true;
  }
  return false;
}

function isChromeMetaText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || value.length >= 80) return false;
  return CHROME_META_RE.test(value);
}

function isInMetaRail(el) {
  if (el.closest(HARD_SKIP_SELECTOR) || el.closest("aside, [role='complementary']")) return true;
  let node = el;
  for (let i = 0; i < 8 && node; i++) {
    const cls = typeof node.className === "string" ? node.className : "";
    if (/hero_blog_post_details|blog_post_details|details_list|details_item|marginalia|aside-rail|aside_rail/i.test(cls)) return true;
    node = node.parentElement;
  }
  const cluster = el.closest("li, dt, dd, [class*='details'], [class*='marginalia']");
  if (cluster) {
    const t = getText(cluster);
    if (t.length > 0 && t.length < 160 && CHROME_META_RE.test(t)) return true;
  }
  return isChromeMetaText(getText(el));
}

function getText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(".oi-translation, script, style, noscript").forEach((n) => n.remove());
  return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
}

function shouldInline(el) {
  if (el.tagName === "A" || el.tagName === "BUTTON") return true;
  if (el.closest("nav, aside, header, [role='navigation']")) return true;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.width < 240 && isSideColumn(el);
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
  const inline = shouldInline(el);
  const node = document.createElement(inline ? "span" : "div");
  const heading = /^H[1-3]$/.test(el.tagName);
  node.className = inline
    ? "oi-translation oi-inline"
    : heading
      ? "oi-translation oi-after-heading"
      : "oi-translation";
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
    }).then(() => toast("已收藏"));
  });
  if (inline || ["LI", "TD", "TH", "DT", "DD"].includes(el.tagName)) el.appendChild(node);
  else el.insertAdjacentElement("afterend", node);
}

function isTinyChrome(el) {
  if (["NAV", "FOOTER", "HEADER"].includes(el.parentElement?.tagName)) return getText(el).length < 24;
  if (el.tagName === "A" || el.closest("nav, aside, [role='navigation']")) return getText(el).length < 48;
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
  const el = ev.target.closest(BLOCK_SELECTOR);
  if (!el || el.closest(SKIP_SELECTOR)) return;
  if (el.closest(HARD_SKIP_SELECTOR) || el.closest(ALWAYS_CHROME_SELECTOR) || isInMetaRail(el) || isSideColumn(el)) return;
  if (el.querySelector(".oi-translation") || el.nextElementSibling?.classList?.contains("oi-translation")) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(async () => {
    const text = getText(el);
    if (text.length < MIN_LEN) return;
    const res = await send({ type: "OI_TRANSLATE_BATCH", texts: [text] });
    if (res.ok) {
      const settings = (await send({ type: "OI_GET_SETTINGS" }))?.settings;
      mountTranslation(el, res.translations[0], settings);
    }
  }, 350);
}

function showSelectionCard(original, translated) {
  document.querySelector(".oi-selection-card")?.remove();
  const card = document.createElement("div");
  card.className = "oi-selection-card";
  card.innerHTML = '<div class="oi-sel-org"></div><div class="oi-sel-dst"></div><div class="oi-sel-actions"><button type="button" class="save">收藏</button><button type="button" class="close">关闭</button></div>';
  card.querySelector(".oi-sel-org").textContent = original;
  card.querySelector(".oi-sel-dst").textContent = translated;
  card.querySelector(".close").onclick = () => card.remove();
  card.querySelector(".save").onclick = async () => {
    await send({
      type: "OI_SAVE_LEARNING",
      item: { original, translation: translated, context: original, url: location.href, title: document.title }
    });
    toast("已收藏");
    card.remove();
  };
  document.body.appendChild(card);
}

async function saveCurrentSelection() {
  const text = String(window.getSelection() || "").trim();
  if (!text) {
    toast("请先选中文本");
    return;
  }
  const res = await send({ type: "OI_TRANSLATE_BATCH", texts: [text] });
  const translated = res.translations?.[0] || "";
  await send({
    type: "OI_SAVE_LEARNING",
    item: { original: text, translation: translated, context: surroundingContext(), url: location.href, title: document.title }
  });
  toast("已收藏");
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

async function send(payload) {
  try {
    if (!chrome.runtime?.id) return null;
    return await chrome.runtime.sendMessage(payload);
  } catch (err) {
    const msg = String(err && err.message || err);
    if (/Extension context invalidated|message port closed/i.test(msg)) return null;
    throw err;
  }
}
