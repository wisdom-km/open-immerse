import { getProvider } from "../lib/providers.js";
import { getSettings, saveSettings } from "../lib/storage.js";

const cache = new Map();
const CACHE_LIMIT = 2000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "oi-translate-selection",
    title: "翻译选中文本 / Translate selection",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "oi-translate-selection" || !tab?.id) return;
  const text = info.selectionText || "";
  if (!text.trim()) return;
  try {
    const [translated] = await translateBatch([text]);
    await chrome.tabs.sendMessage(tab.id, {
      type: "OI_SHOW_SELECTION",
      original: text,
      translated
    });
  } catch (err) {
    await chrome.tabs.sendMessage(tab.id, { type: "OI_ERROR", message: String(err.message || err) });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-translate") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const settings = await getSettings();
  const enabled = !settings.enabled;
  await saveSettings({ enabled });
  await chrome.tabs.sendMessage(tab.id, { type: enabled ? "OI_START" : "OI_STOP" }).catch(() => {});
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
    case "OI_SAVE_SETTINGS":
      return { ok: true, settings: await saveSettings(message.patch || {}) };
    case "OI_TRANSLATE_BATCH": {
      const translations = await translateBatch(message.texts || []);
      return { ok: true, translations };
    }
    case "OI_TOGGLE_TAB": {
      const settings = await saveSettings({ enabled: Boolean(message.enabled) });
      if (sender.tab?.id) {
        await chrome.tabs
          .sendMessage(sender.tab.id, { type: settings.enabled ? "OI_START" : "OI_STOP" })
          .catch(() => {});
      }
      return { ok: true, settings };
    }
    default:
      return { ok: false, error: "unknown message" };
  }
}

async function translateBatch(texts) {
  const settings = await getSettings();
  const provider = getProvider(settings.provider);
  const providerSettings = settings.providers?.[settings.provider] || {};
  const pending = [];
  const results = new Array(texts.length);

  texts.forEach((text, index) => {
    const key = cacheKey(settings.provider, settings.sourceLang, settings.targetLang, text);
    if (cache.has(key)) {
      results[index] = cache.get(key);
    } else {
      pending.push({ text, index, key });
    }
  });

  const size = Math.max(1, Number(settings.batchSize) || 8);
  for (let i = 0; i < pending.length; i += size) {
    const chunk = pending.slice(i, i + size);
    const translated = await provider.translate(
      chunk.map((c) => c.text),
      {
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        settings: providerSettings
      }
    );
    chunk.forEach((item, j) => {
      const value = translated[j] || "";
      results[item.index] = value;
      remember(item.key, value);
    });
  }
  return results;
}

function cacheKey(provider, from, to, text) {
  return `${provider}|${from}|${to}|${text}`;
}

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}
