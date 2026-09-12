import { getProvider, guardZhTranslations, isTwoStepPolish, testProviderConnection } from "../lib/providers.js";
import { getSettings, saveSettings, matchSiteRule } from "../lib/storage.js";
import { listItems, saveItem, removeItem, reviewItem, dueItems } from "../lib/learning.js";
import { resolveFeatures } from "../lib/features.js";

const cache = new Map();
const CACHE_LIMIT = 2000;
const CACHE_VER = "v5-title-calque";
cache.clear();

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
    chrome.contextMenus.create({
      id: "oi-translate-selection",
      title: "翻译选中",
      contexts: ["selection"]
    });
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
  if (info.menuItemId === "oi-translate-selection") {
    try {
      const [translated] = await translateBatch([text]);
      await chrome.tabs.sendMessage(tab.id, { type: "OI_SHOW_SELECTION", original: text, translated });
    } catch (err) {
      await chrome.tabs.sendMessage(tab.id, { type: "OI_ERROR", message: String(err.message || err) });
    }
  }
  if (info.menuItemId === "oi-save-selection" && features.learning) {
    try {
      const [translated] = await translateBatch([text]);
      await saveItem({
        original: text,
        translation: translated,
        url: info.pageUrl || tab.url,
        title: tab.title,
        context: text
      });
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

async function handleMessage(message, sender) {
  switch (message.type) {
    case "OI_GET_SETTINGS":
      return { ok: true, settings: await getSettings() };
    case "OI_SAVE_SETTINGS": {
      const settings = await saveSettings(message.patch || {});
      await rebuildMenus();
      return { ok: true, settings };
    }
    case "OI_TRANSLATE_BATCH": {
      const batchOpts = {
        onProgress: (progress) => emitTranslateProgress(sender, message.requestId, progress)
      };
      const translations = await translateBatch(message.texts || [], batchOpts);
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
      const features = resolveFeatures(await getSettings());
      if (message.page === "documents" && !features.documents) return { ok: false, error: "documents off" };
      if (message.page === "learning" && !features.learning) return { ok: false, error: "learning off" };
      const path = message.page === "documents" ? "documents/documents.html" : "learning/learning.html";
      await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
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
    default:
      return { ok: false, error: "unknown message" };
  }
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

async function translateBatch(texts, options = {}) {
  const settings = await getSettings();
  const provider = getProvider(settings.provider);
  const providerSettings = {
    ...(settings.providers?.[settings.provider] || {}),
    twoStepPolish: settings.twoStepPolish === true
  };
  const pending = [];
  const results = new Array(texts.length);
  texts.forEach((text, index) => {
    const key = cacheKey(settings.provider, settings.sourceLang, settings.targetLang, text, providerSettings);
    if (cache.has(key)) results[index] = readCachedTranslation(key, text, settings.targetLang);
    else pending.push({ text, index, key });
  });
  const size = Math.max(1, Number(settings.batchSize) || 8);
  for (let i = 0; i < pending.length; i += size) {
    const chunk = pending.slice(i, i + size);
    let translated;
    try {
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
      throw err;
    }
    const guarded = guardZhTranslations(
      chunk.map((c) => c.text),
      translated,
      settings.targetLang
    );
    chunk.forEach((item, j) => {
      const value = guarded[j] || "";
      results[item.index] = value;
      remember(item.key, value);
    });
  }
  return guardZhTranslations(texts, results, settings.targetLang);
}

function cacheKey(provider, from, to, text, settings) {
  const quality = isTwoStepPolish(settings) ? "polish" : "single";
  return `${CACHE_VER}|${provider}|${from}|${to}|${quality}|${text}`;
}

function readCachedTranslation(key, text, targetLang) {
  const [guarded] = guardZhTranslations([text], [cache.get(key)], targetLang);
  if (guarded !== cache.get(key)) remember(key, guarded);
  return guarded;
}

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

export { translateBatch, CACHE_VER, cache as translationCache };
