import { completePdfStructure, guardZhTranslations, isThinkingEnabled, isTwoStepPolish, sanitizeProviderError, testProviderConnection } from "../lib/providers.js";
import { getSettings, matchSiteRule, noteTranslationSucceeded, saveSettings } from "../lib/storage.js";
import { listItems, saveItem, removeItem, reviewItem, dueItems } from "../lib/learning.js";
import { featureOn, resolveFeatures } from "../lib/features.js";
import { handleArxivSourceMessage } from "./arxiv-source.js";
import { handleFormulaCacheMessage } from "./formula-cache.js";
import { defaultFormulaSettings, readFormulaSettings } from "../lib/formula-settings.js";
import { resolveTranslateOutbound } from "../lib/translate-borrow.js";

const cache = new Map();
const CACHE_LIMIT = 2000;
const CACHE_VER = "v5-title-calque";
cache.clear();
const BORROW_EPISODE_KEY = "oiTranslateBorrowEpisode";
let borrowEpisode = "";
let borrowEpisodeKnown = false;
let borrowEpisodeChain = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  cache.clear();
  bootExtension();
});
chrome.runtime.onStartup.addListener(() => {
  cache.clear();
  bootExtension();
});

function bootExtension() {
  getSettings()
    .then(() => rebuildMenus())
    .catch((err) => console.error("Open Immerse: startup failed", err));
}

async function rebuildMenus() {
  try {
    const settings = await getSettings();
    const features = resolveFeatures(settings);
    await chrome.contextMenus.removeAll();
    if (features.learning) {
      chrome.contextMenus.create({
        id: "oi-save-selection",
        title: "收藏",
        contexts: ["selection"]
      });
    }
  } catch (err) {
    console.error("Open Immerse: rebuildMenus failed", err);
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const text = (info.selectionText || "").trim();
  if (!text || !tab?.id) return;
  const features = resolveFeatures(await getSettings());
  if (info.menuItemId === "oi-save-selection" && features.learning) {
    try {
      const batchOpts = {};
      const [translated] = await translateBatch([text], batchOpts);
      await saveItem({
        original: text,
        translation: translated,
        url: info.pageUrl || tab.url,
        title: tab.title,
        context: text
      });
      if (batchOpts.providerCalled) await noteTranslationSucceeded(batchOpts.providerId);
      await chrome.tabs.sendMessage(tab.id, { type: "OI_TOAST", message: "已收藏到学习中心" });
    } catch (err) {
      await chrome.tabs.sendMessage(tab.id, { type: "OI_ERROR", message: String(err.message || err) });
    }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const settings = await getSettings();
  if (resolveFeatures(settings).webpage === false) return;
  const enabled = !settings.enabled;
  await saveSettings({ enabled });
  await chrome.tabs.sendMessage(tab.id, { type: enabled ? "OI_START" : "OI_RESTORE" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true;
});

const GLMOCR_HOST = "com.open_immerse.glmocr";

function ensureLocalGlmOcr() {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(GLMOCR_HOST);
    } catch (err) {
      resolve({ ok: false, error: String(err?.message || err) });
      return;
    }
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch { /* already closed */ }
      resolve(payload);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), 8000);
    port.onMessage.addListener((message) => finish(message || { ok: true }));
    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message;
      finish({ ok: false, error: reason || "disconnected" });
    });
    port.postMessage({ action: "ensure" });
  });
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case "OI_ENSURE_GLMOCR":
      return ensureLocalGlmOcr();
    case "OI_GET_SETTINGS":
      return { ok: true, settings: await getSettings() };
    case "OI_SAVE_SETTINGS": {
      const settings = await saveSettings(message.patch || {}, message.clear || {}, message.keySeq);
      await rebuildMenus();
      return { ok: settings?.settingsSaved !== false, settings };
    }
    case "OI_PDF_STRUCTURE":
      return completePdfStructure(await getSettings(), {
        system: message.system,
        user: message.user
      });
    case "OI_TRANSLATE_BATCH": {
      const batchOpts = {
        onProgress: (progress) => emitTranslateProgress(sender, message.requestId, progress),
        polish: message.polish,
        promptAddendum: message.promptAddendum,
        bypassCache: message.bypassCache === true
      };
      const translations = await translateBatch(message.texts || [], batchOpts);
      if (batchOpts.providerCalled) await noteTranslationSucceeded(batchOpts.providerId);
      return {
        ok: true,
        translations,
        ...(batchOpts.polishFailed ? { polishError: "润色失败" } : {})
      };
    }
    case "OI_TEST_PROVIDER": {
      const providerConfig =
        message.providerConfig && typeof message.providerConfig === "object" ? message.providerConfig : {};
      return testProviderConnection({
        providerId: message.provider,
        providerConfig,
        sourceLang: message.sourceLang || "en",
        targetLang: message.targetLang || "zh-CN",
        texts: message.texts
      });
    }
    case "OI_MATCH_RULE": {
      const settings = await getSettings();
      return { ok: true, rule: matchSiteRule(message.host || sender.tab?.url, settings.siteRules) };
    }
    case "OI_SAVE_LEARNING": {
      if (!resolveFeatures(await getSettings()).learning) return { ok: false, error: "learning off" };
      return { ok: true, item: await saveItem(message.item || {}) };
    }
    case "OI_LIST_LEARNING": {
      const items = await listItems();
      return { ok: true, items, due: dueItems(items) };
    }
    case "OI_REMOVE_LEARNING":
      await removeItem(message.id);
      return { ok: true };
    case "OI_REVIEW_LEARNING":
      return { ok: true, item: await reviewItem(message.id, message.grade) };
    case "OI_OPEN_PAGE": {
      const settings = await getSettings();
      const features = resolveFeatures(settings);
      if (message.page === "documents" && !features.documents) return { ok: false, error: "documents off" };
      if (message.page === "learning" && !features.learning) return { ok: false, error: "learning off" };
      if (message.page === "pdf" && !featureOn(settings, "pdf")) return { ok: false, error: "pdf off" };
      const path =
        message.page === "documents"
          ? "documents/documents.html"
          : message.page === "pdf"
            ? "pdf/viewer.html"
            : message.page === "learning"
              ? "learning/learning.html"
              : "";
      if (!path) return { ok: false, error: "unknown page" };
      const suffix = message.page === "pdf" && message.src ? `?src=${encodeURIComponent(message.src)}` : "";
      await chrome.tabs.create({ url: chrome.runtime.getURL(path) + suffix });
      return { ok: true };
    }
    case "OI_TOGGLE_SITE_RULE": {
      const settings = await getSettings();
      const host = String(message.host || "").replace(/^www\./, "");
      const rules = [...(settings.siteRules || [])];
      const idx = rules.findIndex((r) => r.host === host);
      if (idx >= 0) rules[idx] = { ...rules[idx], ...message.rule, host };
      else rules.push({ host, auto: true, hover: false, subtitle: false, ...message.rule });
      return { ok: true, settings: await saveSettings({ siteRules: rules }) };
    }
    case "OI_ARXIV_SOURCE":
      // AX-11 and sw-startup lock this file's imports. Diagnostic actions are not arXiv.
      if (message?.action === "diag" || message?.action === "diag-note") return { ok: false };
      return handleArxivSourceMessage(message);
    case "OI_FORMULA_CACHE":
      return handleFormulaCacheMessage(message);
    case "OI_DIAG_LOG":
    case "OI_DIAG_EXPORT":
    case "OI_DIAG_CLEAR":
    case "OI_DIAG_STATS":
      return handleArxivSourceMessage({ action: "diag", message, sender });
    default:
      return { ok: false, error: "unknown message" };
  }
}

function reportTranslateFailure(err, fields) {
  Promise.resolve(handleArxivSourceMessage({
    action: "diag-note",
    failure: {
      message: String(err?.message || err || ""),
      httpStatus: err?.httpStatus,
      code: err?.code
    },
    fields: fields || {}
  })).catch(() => {});
}

function reportTranslateBorrow(fields) {
  const payload = {
    provider: fields?.provider || "",
    model: fields?.model || ""
  };
  if (typeof fields?.ok === "boolean") payload.ok = fields.ok;
  Promise.resolve(handleArxivSourceMessage({
    action: "diag-borrow",
    fields: payload
  })).catch(() => {});
}

function borrowSession() {
  const session = globalThis.chrome?.storage?.session;
  if (!session || typeof session.get !== "function" || typeof session.set !== "function") return null;
  return session;
}

async function loadBorrowEpisode() {
  if (borrowEpisodeKnown) return;
  borrowEpisodeKnown = true;
  const session = borrowSession();
  if (!session) return;
  try {
    const bag = await session.get(BORROW_EPISODE_KEY);
    const stored = bag?.[BORROW_EPISODE_KEY];
    if (typeof stored === "string") borrowEpisode = stored;
  } catch {
    // session 缺失时只靠本进程内存，不能挡住翻译。
  }
}

function noteBorrowEpisode(outbound) {
  const episode = outbound?.borrowed ? `${outbound.vendorId}\0${outbound.model}` : "";
  const run = borrowEpisodeChain.then(async () => {
    await loadBorrowEpisode();
    const entering = episode !== "" && episode !== borrowEpisode;
    if (episode !== borrowEpisode) {
      borrowEpisode = episode;
      const session = borrowSession();
      if (session) {
        try {
          await session.set({ [BORROW_EPISODE_KEY]: episode });
        } catch {
          // 内存里的 episode 仍然有效，避免同一次进程重复记日志。
        }
      }
    }
    return entering;
  });
  borrowEpisodeChain = run.then(() => {}, () => {});
  return run;
}

function emitTranslateProgress(sender, requestId, progress) {
  const payload = {
    type: "OI_TRANSLATE_PROGRESS",
    requestId: requestId || "",
    phase: progress.phase,
    translations: progress.translations || []
  };
  const tasks = [];
  const isExtensionPage = String(sender?.url || "").startsWith("chrome-extension://");
  if (isExtensionPage) {
    tasks.push(chrome.runtime.sendMessage(payload).catch(() => {}));
  } else if (sender?.tab?.id != null) {
    const opts = sender.frameId != null ? { frameId: sender.frameId } : {};
    tasks.push(chrome.tabs.sendMessage(sender.tab.id, payload, opts).catch(() => {}));
  }
  return Promise.all(tasks);
}

function resolveBatchPolish(message = {}, settings = {}) {
  if (message?.polish === false) return false;
  return settings?.twoStepPolish === true;
}

async function translateBatch(texts, options = {}) {
  const settings = await getSettings();
  let formula;
  try {
    formula = await readFormulaSettings(chrome.storage?.local);
  } catch {
    formula = defaultFormulaSettings();
  }
  const outbound = resolveTranslateOutbound(settings, formula);
  options.providerId = outbound.providerId;
  options.outboundFallback = outbound.fallback === true;
  options.borrowed = outbound.borrowed === true;
  options.providerCalled = false;
  const enteringBorrow = await noteBorrowEpisode(outbound);
  const provider = outbound.provider;
  const borrowed = outbound.borrowed === true ? outbound.runtimeConfig : null;
  const providerSettings = borrowed
    ? {
        apiKey: borrowed.apiKey,
        model: borrowed.model,
        baseUrl: borrowed.baseUrl,
        twoStepPolish: resolveBatchPolish(options, settings),
        deepThink: settings.deepThink === true,
        promptAddendum: String(options.promptAddendum || "")
      }
    : {
        ...(settings.providers?.[outbound.providerId] || {}),
        twoStepPolish: resolveBatchPolish(options, settings),
        deepThink: settings.deepThink === true,
        promptAddendum: String(options.promptAddendum || "")
      };
  const pending = [];
  const results = new Array(texts.length);
  texts.forEach((text, index) => {
    const cacheProvider = outbound.borrowed
      ? `${outbound.providerId}|${outbound.model}|${outbound.baseUrl}`
      : outbound.providerId;
    const key = cacheKey(cacheProvider, settings.sourceLang, settings.targetLang, text, providerSettings);
    if (!options.bypassCache && cache.has(key)) results[index] = readCachedTranslation(key, text, settings.targetLang);
    else pending.push({ text, index, key });
  });
  const size = Math.max(1, Number(settings.batchSize) || 8);
  for (let i = 0; i < pending.length; i += size) {
    const chunk = pending.slice(i, i + size);
    let translated;
    try {
      options.providerCalled = true;
      translated = await provider.translate(chunk.map((c) => c.text), {
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        settings: providerSettings,
        onProgress: async (progress) => {
          if (progress?.phase !== "draft" || typeof options.onProgress !== "function") return;
          const guarded = guardZhTranslations(
            chunk.map((c) => c.text),
            progress.translations,
            settings.targetLang
          );
          const draftResults = results.slice();
          chunk.forEach((item, j) => {
            draftResults[item.index] = guarded[j] || "";
          });
          try {
            await options.onProgress({
              phase: "draft",
              translations: guardZhTranslations(texts, draftResults, settings.targetLang)
            });
          } catch {
            /* progress is best-effort */
          }
        }
      });
    } catch (err) {
      if (err?.polishFailed && Array.isArray(err.drafts)) {
        const guardedDrafts = guardZhTranslations(
          chunk.map((c) => c.text),
          err.drafts,
          settings.targetLang
        );
        chunk.forEach((item, j) => {
          results[item.index] = guardedDrafts[j] || "";
        });
        options.polishFailed = true;
        continue;
      }
      const safe = borrowed
        ? Object.assign(new Error(sanitizeProviderError(err, { apiKey: borrowed.apiKey })), {
            httpStatus: err?.httpStatus,
            code: err?.code
          })
        : err;
      reportTranslateFailure(safe, {
        provider: options.providerId || "",
        count: chunk.length
      });
      if (enteringBorrow) {
        reportTranslateBorrow({
          provider: outbound.vendorId,
          model: outbound.model,
          ok: false
        });
      }
      throw safe;
    }
    const guarded = guardZhTranslations(
      chunk.map((c) => c.text),
      translated,
      settings.targetLang
    );
    chunk.forEach((item, j) => {
      const value = guarded[j] || "";
      results[item.index] = value;
      remember(item.key, value, item.text);
    });
  }
  // 借用成功也不算这台引擎自己测通：providerCalled 保持 false，
  // 因此不会清掉原引擎的「需处理」。这里不写存储（TBM-08）。
  if (outbound.borrowed) options.providerCalled = false;
  if (enteringBorrow) {
    reportTranslateBorrow({
      provider: outbound.vendorId,
      model: outbound.model,
      ok: true
    });
  }
  return guardZhTranslations(texts, results, settings.targetLang);
}

function cacheKey(provider, from, to, text, settings) {
  const quality = isTwoStepPolish(settings) ? "polish" : "single";
  const think = isThinkingEnabled(settings) ? "think" : "fast";
  const polish = settings?.twoStepPolish === true ? "polish-on" : "polish-off";
  const addendum = String(settings?.promptAddendum || "");
  return `${CACHE_VER}|${provider}|${from}|${to}|${quality}|${think}|${polish}|${addendum}|${text}`;
}

function readCachedTranslation(key, text, targetLang) {
  const [guarded] = guardZhTranslations([text], [cache.get(key)], targetLang);
  if (guarded !== cache.get(key)) remember(key, guarded, text);
  return guarded;
}

function remember(key, value, source = "") {
  const text = String(value || "").trim();
  const fold = (item) => String(item || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!text || (source && fold(text) === fold(source))) {
    cache.delete(key);
    return;
  }
  cache.set(key, text);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

export { translateBatch, resolveBatchPolish, CACHE_VER, cache as translationCache };
