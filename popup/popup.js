import { getProvider, isProviderConfigured } from "../lib/providers.js";
import { readFormulaSettings } from "../lib/formula-settings.js";
import { describeTranslateBorrow } from "../lib/translate-borrow.js";
import { LANGUAGE_OPTIONS } from "../lib/languages.js";
import { TRANSLATE_LIMIT_TITLE_LEAD, isTitleLeadLimit } from "../lib/translate-limit.js";
import { featureOn } from "../lib/features.js";
import { shouldOfferPdfOpen } from "../lib/pdf-viewer.js";

const $ = (id) => document.getElementById(id);
const PRIMARY_IDLE = "翻译此页";
const PRIMARY_STOP = "停止";

init();

async function init() {
  const openOptionsPage = () => {
    const url = chrome.runtime.getURL("options/options.html#translate");
    if (url && chrome.tabs?.create) chrome.tabs.create({ url });
    else chrome.runtime.openOptionsPage();
  };
  const openOptions = () => openOptionsPage();
  $("engineLink").addEventListener("click", (ev) => {
    ev.preventDefault();
    openOptions();
  });
  $("goSetup").addEventListener("click", openOptions);
  $("openOptions").addEventListener("click", openOptions);
  $("openLearning").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "learning" }));
  $("openDocs").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "documents" }));

  fillSelect($("sourceLang"), LANGUAGE_OPTIONS.map((l) => ({ value: l.code, label: l.label })));
  fillSelect($("targetLang"), LANGUAGE_OPTIONS.filter((l) => l.code !== "auto").map((l) => ({ value: l.code, label: l.label })));

  const { settings } = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  $("sourceLang").value = settings.sourceLang;
  $("targetLang").value = settings.targetLang;
  $("translateScope").value = settings.translateScope || "article";
  $("translateLimit").value = isTitleLeadLimit(settings.translateLimit) ? TRANSLATE_LIMIT_TITLE_LEAD : "all";
  await renderEngine(settings, await readFormulaSettings(chrome.storage?.local));
  bindEngineRefresh();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await syncPrimary(tab);

  const host = hostOf(tab?.url);
  const rule = (settings.siteRules || []).find((r) => host === r.host || host.endsWith("." + r.host));
  $("autoSite").checked = Boolean(rule?.auto);

  $("translatePage").addEventListener("click", async () => {
    if ($("translatePage").dataset.busy === "1") {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "OI_STOP" }).catch(() => {});
      setPrimaryBusy(false);
      return;
    }
    await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled: true } });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "OI_START" }).catch(() => {});
    setPrimaryBusy(true);
  });

  $("restorePage").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled: false } });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "OI_RESTORE" }).catch(() => {});
    setPrimaryBusy(false);
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

  const pdfOn = featureOn(settings, "pdf");
  $("openPdfPage").hidden = !pdfOn;
  $("openPdfSep").hidden = !pdfOn;
  $("openPdfPage").addEventListener("click", () => {
    if (!featureOn(settings, "pdf")) return;
    chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "pdf" });
  });

  const pdfTab = shouldOfferPdfOpen(tab?.url);
  $("pdfEntry").hidden = !(pdfOn && pdfTab);
  $("openPdf").addEventListener("click", () => {
    if (!featureOn(settings, "pdf") || !pdfTab) return;
    chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "pdf", src: tab.url });
  });

  if (tab?.id) setInterval(() => syncPrimary(tab), 400);
}

function setPrimaryBusy(busy) {
  const btn = $("translatePage");
  btn.dataset.busy = busy ? "1" : "0";
  btn.textContent = busy ? PRIMARY_STOP : PRIMARY_IDLE;
  btn.classList.toggle("is-stop", busy);
}

async function syncPrimary(tab) {
  if (!tab?.id) {
    setPrimaryBusy(false);
    return;
  }
  const ping = await chrome.tabs.sendMessage(tab.id, { type: "OI_PING" }).catch(() => null);
  setPrimaryBusy(Boolean(ping?.inflight));
}

function bindEngineRefresh() {
  let ticket = 0;
  chrome.storage?.onChanged?.addListener((changes, area) => {
    const syncSettings = area === "sync" && Object.prototype.hasOwnProperty.call(changes, "settings");
    const localBorrow = area === "local" && (
      Object.prototype.hasOwnProperty.call(changes, "formulaSettings")
      || Object.prototype.hasOwnProperty.call(changes, "oiSecrets")
    );
    if (!syncSettings && !localBorrow) return;
    const current = ++ticket;
    void refreshEngine(() => current === ticket);
  });
}

async function refreshEngine(still = () => true) {
  try {
    const res = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
    if (!still()) return;
    const formula = await readFormulaSettings(chrome.storage?.local);
    if (!still()) return;
    renderEngine(res?.settings || {}, formula);
  } catch {
    /* keep the last engine line */
  }
}

function renderEngine(settings, formula) {
  const described = describeTranslateBorrow(settings, formula);
  const outbound = described.outbound;
  const link = $("engineLink");
  const warn = $("engineWarn");
  const warnText = $("engineWarnText");
  if (described.mode === "borrow") {
    link.textContent = `引擎：${described.shortName}`;
    link.title = described.vendorLabel || described.shortName;
    warn.hidden = true;
    return;
  }
  const provider = getProvider(outbound.providerId);
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
  link.textContent = provider.id === "mymemory" ? `引擎：${shortName}（免费）` : `引擎：${shortName}`;
  link.title = provider.name;
  if (provider.id === "mymemory" && outbound.notice) link.title = outbound.notice;
  const selected = getProvider(settings.provider);
  const cfg = settings.providers?.[selected.id] || {};
  const ok = !outbound.fallback && isProviderConfigured(selected, cfg);
  if (outbound.fallback && warnText) warnText.textContent = outbound.notice;
  warn.hidden = outbound.borrowed || ok;
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
