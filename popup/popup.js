import { getProvider, providers } from "../lib/providers.js";
import { readFormulaSettings } from "../lib/formula-settings.js";
import { describeTranslateBorrow } from "../lib/translate-borrow.js";
import { LANGUAGE_OPTIONS } from "../lib/languages.js";
import { TRANSLATE_LIMIT_TITLE_LEAD, isTitleLeadLimit } from "../lib/translate-limit.js";
import { featureOn } from "../lib/features.js";
import { openPopupPdfEntry, readPdfContentType } from "../lib/pdf-viewer.js";
import { NO_ENGINE_COPY } from "../lib/no-engine-prompt.js";
import { POPUP_PAGE_WAIT_MS, withTimeout } from "./popup-ready.js";

const $ = (id) => document.getElementById(id);
const PRIMARY_IDLE = "翻译此页";
const PRIMARY_STOP = "停止";
let engineMissing = false;

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
  $("engineSetup").addEventListener("click", (ev) => {
    ev.preventDefault();
    chrome.runtime.sendMessage({ type: "OI_OPEN_TRANSLATE_SETTINGS" });
  });
  $("openOptions").addEventListener("click", openOptions);
  $("openLearning").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "learning" }));
  $("openDocs").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "documents" }));

  fillSelect($("sourceLang"), LANGUAGE_OPTIONS.map((l) => ({ value: l.code, label: l.label })));
  fillSelect($("targetLang"), LANGUAGE_OPTIONS.filter((l) => l.code !== "auto").map((l) => ({ value: l.code, label: l.label })));

  let tab = null;
  let settings = {};
  let settingsLoaded = false;
  let pdfProbe = Promise.resolve(null);
  let probeStarted = false;
  let tabsSettled = false;
  let engineBound = false;

  const settingsPromise = Promise.resolve()
    .then(() => chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" }))
    .catch(() => null);
  const tabsPromise = Promise.resolve()
    .then(() => chrome.tabs.query({ active: true, currentWindow: true }))
    .catch(() => []);
  const ready = await withTimeout(Promise.all([settingsPromise, tabsPromise]), POPUP_PAGE_WAIT_MS);
  if (ready) {
    tabsSettled = true;
    if (ready[0]?.settings) {
      settings = ready[0].settings;
      settingsLoaded = true;
    }
    if (ready[1]?.[0]) tab = ready[1][0];
    if (settingsLoaded) applyFields();
  } else {
    void settingsPromise.then((res) => {
      if (!res?.settings || settingsLoaded) return;
      settings = res.settings;
      settingsLoaded = true;
      applyFields();
      void paintEngine();
      armTabWatch();
    });
  }
  void tabsPromise.then((tabs) => {
    tabsSettled = true;
    const next = Array.isArray(tabs) ? tabs[0] : null;
    if (next) tab = next;
    if (settingsLoaded) mountPdf();
    armTabWatch();
  });

  $("translatePage").addEventListener("click", async () => {
    if ($("translatePage").dataset.busy === "1") {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "OI_STOP" }).catch(() => {});
      setPrimaryBusy(false);
      return;
    }
    if (engineMissing) {
      const note = $("engineNote");
      if (note) {
        note.hidden = false;
        note.textContent = NO_ENGINE_COPY.body;
      }
      $("engineSetup")?.focus();
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
    const host = hostOf(tab?.url);
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

  $("openPdf").addEventListener("click", () => {
    if (!settingsLoaded) return;
    if (!featureOn(settings, "pdf")) return;
    openPopupPdfEntry({
      url: tab?.url,
      probe: pdfProbe,
      sendMessage: (message) => chrome.runtime.sendMessage(message),
      close: () => window.close(),
      button: $("openPdf"),
      error: $("openPdfError")
    });
  });

  armTabWatch();
  void paintEngine();

  function applyFields() {
    $("sourceLang").value = settings.sourceLang;
    $("targetLang").value = settings.targetLang;
    $("translateScope").value = settings.translateScope || "article";
    $("translateLimit").value = isTitleLeadLimit(settings.translateLimit) ? TRANSLATE_LIMIT_TITLE_LEAD : "all";
    mountPdf();
  }

  function mountPdf() {
    if (!settingsLoaded) return;
    const pdfOn = featureOn(settings, "pdf");
    $("pdfEntry").hidden = !pdfOn;
    syncSiteRule();
    if (!pdfOn || probeStarted || (!tab?.id && !tabsSettled)) return;
    probeStarted = true;
    pdfProbe = readPdfContentType(tab?.id, (details) => chrome.scripting.executeScript(details));
  }

  function syncSiteRule() {
    const host = hostOf(tab?.url);
    const rule = (settings.siteRules || []).find((r) => host === r.host || host.endsWith("." + r.host));
    $("autoSite").checked = Boolean(rule?.auto);
  }

  async function paintEngine() {
    if (!settingsLoaded || engineBound) return;
    engineBound = true;
    const formula = await readFormulaSettings(chrome.storage?.local);
    renderEngine(settings, formula);
    bindEngineRefresh();
  }

  function armTabWatch() {
    if (armTabWatch.started || !tab?.id) return;
    armTabWatch.started = true;
    setInterval(() => syncPrimary(tab), 400);
    void syncPrimary(tab);
  }
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
  const ping = await withTimeout(
    Promise.resolve()
      .then(() => chrome.tabs.sendMessage(tab.id, { type: "OI_PING" }))
      .catch(() => null),
    POPUP_PAGE_WAIT_MS
  );
  if (!ping) return;
  setPrimaryBusy(Boolean(ping?.inflight));
  const restore = $("restorePage");
  if (!restore) return;
  restore.disabled = !(ping.running || ping.hasTranslations || ping.inflight);
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
  const borrowed = described.mode === "borrow";
  const outbound = borrowed
    ? { providerId: described.vendorId, fallback: false, borrowed: true, notice: "" }
    : described.outbound;
  const link = $("engineLink");
  const unset = $("engineUnset");
  const note = $("engineNote");
  if (!borrowed && outbound?.code === "NO_ENGINE") {
    engineMissing = true;
    if (link) link.hidden = true;
    if (unset) unset.hidden = false;
    if (note) note.hidden = true;
    return;
  }
  engineMissing = false;
  if (link) link.hidden = false;
  if (unset) unset.hidden = true;
  if (note) note.hidden = true;
  const known = providers[outbound.providerId];
  const provider = known
    ? getProvider(outbound.providerId)
    : { id: outbound.providerId, name: described.vendorLabel || outbound.providerId };
  const shortName = borrowed
    ? (described.shortName || provider.name.split("/")[0].trim())
    : {
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
  if (borrowed && described.vendorId === "custom") link.title = described.shortName || provider.name;
  if (!borrowed && provider.id === "mymemory" && outbound.notice) link.title = outbound.notice;
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
