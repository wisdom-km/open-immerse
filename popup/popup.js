import { getProvider, isProviderConfigured } from "../lib/providers.js";
import { LANGUAGE_OPTIONS } from "../lib/languages.js";
import { TRANSLATE_LIMIT_TITLE_LEAD, isTitleLeadLimit } from "../lib/translate-limit.js";

const $ = (id) => document.getElementById(id);

init();

async function init() {
  fillSelect($("sourceLang"), LANGUAGE_OPTIONS.map((l) => ({ value: l.code, label: l.label })));
  fillSelect($("targetLang"), LANGUAGE_OPTIONS.filter((l) => l.code !== "auto").map((l) => ({ value: l.code, label: l.label })));

  const { settings } = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  $("sourceLang").value = settings.sourceLang;
  $("targetLang").value = settings.targetLang;
  $("translateScope").value = settings.translateScope || "article";
  $("translateLimit").value = isTitleLeadLimit(settings.translateLimit) ? TRANSLATE_LIMIT_TITLE_LEAD : "all";
  $("enabled").checked = Boolean(settings.enabled);
  renderEngine(settings);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    const ping = await chrome.tabs.sendMessage(tab.id, { type: "OI_PING" }).catch(() => null);
    if (typeof ping?.running === "boolean") $("enabled").checked = ping.running;
  }

  const host = hostOf(tab?.url);
  const rule = (settings.siteRules || []).find((r) => host === r.host || host.endsWith("." + r.host));
  $("autoSite").checked = Boolean(rule?.auto);

  $("enabled").addEventListener("change", async () => {
    const enabled = $("enabled").checked;
    await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled } });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: enabled ? "OI_START" : "OI_RESTORE" }).catch(() => {});
  });

  $("autoSite").addEventListener("change", async () => {
    if (!host) return;
    await chrome.runtime.sendMessage({ type: "OI_TOGGLE_SITE_RULE", host, rule: { auto: $("autoSite").checked } });
  });

  for (const id of ["sourceLang", "targetLang", "translateScope", "translateLimit"]) {
    $(id).addEventListener("change", () =>
      chrome.runtime.sendMessage({
        type: "OI_SAVE_SETTINGS",
        patch: {
          sourceLang: $("sourceLang").value,
          targetLang: $("targetLang").value,
          translateScope: $("translateScope").value,
          translateLimit: $("translateLimit").value === TRANSLATE_LIMIT_TITLE_LEAD ? TRANSLATE_LIMIT_TITLE_LEAD : "all"
        }
      })
    );
  }

  const openOptions = () => chrome.runtime.openOptionsPage();
  $("engineLink").addEventListener("click", (ev) => {
    ev.preventDefault();
    openOptions();
  });
  $("goSetup").addEventListener("click", openOptions);
  $("openOptions").addEventListener("click", openOptions);
  $("openLearning").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "learning" }));
  $("openDocs").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "documents" }));
}

function renderEngine(settings) {
  const provider = getProvider(settings.provider);
  const shortName = {
    openai: "OpenAI",
    openrouter: "OpenRouter",
    deepl: "DeepL",
    microsoft: "Microsoft",
    google: "Google",
    mymemory: "MyMemory",
    grok: "Grok",
    kimi: "Kimi",
    minimax: "MiniMax",
    gemini: "Gemini",
    claude: "Claude",
    azure: "Azure",
    custom: "Custom"
  }[provider.id] || provider.name.split("/")[0].trim();
  const link = $("engineLink");
  link.textContent = `引擎：${shortName}`;
  link.title = provider.name;
  const cfg = settings.providers?.[provider.id] || {};
  const ok = isProviderConfigured(provider, cfg);
  $("engineWarn").hidden = ok;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function fillSelect(select, items) {
  select.textContent = "";
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  });
}
