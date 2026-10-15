import {
  PROVIDER_LIST,
  PROVIDER_PROBE_TEXT,
  formatConnectionStatus,
  getProvider,
  missingRequiredField,
  redactProviderText
} from "../lib/providers.js";
import { LANGUAGE_OPTIONS } from "../lib/languages.js";
import { laterFeatures, resolveFeatures, v1Features } from "../lib/features.js";
import { TRANSLATE_LIMIT_TITLE_LEAD, isTitleLeadLimit } from "../lib/translate-limit.js";
import { SETTINGS_VERSION, normalizeBodyGlossGap, normalizeBodyGlossStackGap, normalizePdfAutoTranslate } from "../lib/storage.js";
import { prepareSettingsImport, settingsForExport } from "../lib/settings-secrets.js";
import { bindSecretInput } from "../lib/secret-field.js";
import { ASK_TRANSLATION_LINE } from "../lib/ask-route.js";
import {
  FORMULA_SETTINGS_KEY,
  applyFormulaPart,
  multimodalTestDisabled,
  normalizeFormulaSettings,
  ocrTestDisabled,
  readFormulaSettings,
  removeFormulaKey,
  runFormulaProbe,
  stubFormulaProbe,
  writeFormulaSettings
} from "../lib/formula-settings.js";
import { focusFormulaCard, renderFormulaPanel } from "../lib/formula-settings-ui.js";
import { createNotesPrefsSession } from "../lib/reader-notes-local.js";
import { NOTES_PANEL_WIDTH_DEFAULT, NOTES_PANE_WIDTH_DEFAULT } from "../lib/notes-prefs.js";
import { mountDataPanel } from "./data-panel.js";
import { SETTINGS_PAGES, parseSettingsHash } from "./route.js";

function el(id) {
  return document.getElementById(id);
}

function syncTranslateScopeHint() {
  const hint = el("translateScopeHint");
  if (!hint) return;
  const scope = el("translateScope")?.value || "article";
  hint.textContent = TRANSLATE_SCOPE_HINTS[scope] || TRANSLATE_SCOPE_HINTS.article;
}

const TRANSLATE_SCOPE_HINTS = {
  article: "只译主栏正文，跳过侧栏与导航。",
  page: "含侧栏短目录；主标题（含页头 H1）必译。顶栏导航链仍可跳过。"
};

let cachedSettings = { providers: {} };
let readsOk = true;
let writing = false;
let testRequestId = 0;
let pdfCloudKey = "";
let pdfCloudBound = null;
let formulaSettings = normalizeFormulaSettings(null);
let formulaSaved = formulaSettings;
let formulaUndo = null;
let formulaBusy = "";
let formulaWriting = false;
let formulaWrite = Promise.resolve();
let notesSession = null;
let dataPanel = null;
let focusMm = false;
let toastTimer = 0;
let toastUndo = null;

export function startOptions() {
  return init();
}

if (!globalThis.OI_OPTIONS_MANUAL && globalThis.document?.body?.classList?.contains("oi-settings")) {
  init();
}

async function init() {
  fillSelect(el("provider"), PROVIDER_LIST.map((p) => ({ value: p.id, label: p.name })));
  fillSelect(el("sourceLang"), LANGUAGE_OPTIONS.map((l) => ({ value: l.code, label: l.label })));
  fillSelect(
    el("targetLang"),
    LANGUAGE_OPTIONS.filter((l) => l.code !== "auto").map((l) => ({ value: l.code, label: l.label }))
  );
  fillPageSelect();
  const slow = setTimeout(() => {
    const sk = el("setSkeleton");
    if (sk) sk.hidden = false;
  }, 150);
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
    if (!res || res.ok === false || !res.settings) throw new Error("read failed");
    readsOk = true;
    hideReadError();
  } catch {
    readsOk = false;
    showReadError();
    res = { settings: {} };
  } finally {
    clearTimeout(slow);
    const sk = el("setSkeleton");
    if (sk) sk.hidden = true;
  }
  cachedSettings = res.settings || { providers: {} };
  applyStoredForm();
  el("translateScope").addEventListener("change", () => syncTranslateScopeHint());
  bindPanelNav();
  el("laterList")?.addEventListener("change", () => {
    syncPdfLayoutBox();
    syncPdfBanner();
    void persist(el("laterList"));
  });
  bindFormulaSettings();
  bindNotes();
  bindData();
  bindSecretsList();
  el("provider").addEventListener("change", () => {
    harvestVisibleProvider();
    renderProviderFields();
    syncQualityLocks();
    invalidateTest("clear");
    void persist(el("provider"));
  });
  el("testConnection").addEventListener("click", () => testConnection());
  el("exportSettings").addEventListener("click", () => exportSettings());
  el("importSettings").addEventListener("click", () => el("importFile").click());
  el("importFile").addEventListener("change", (ev) => importSettingsFile(ev));
  el("setRetry")?.addEventListener("click", () => location.reload());
  el("mmEnablePdf")?.addEventListener("click", () => enablePdf());
  syncSiteRulesBox();
  bindSteppers();
  document.addEventListener("click", jumpToProvider);
  bindInstant();
  bindSearch();
  const manifest = chrome.runtime?.getManifest?.();
  if (manifest?.version && el("aboutVersion")) el("aboutVersion").textContent = manifest.version;
  await pinKeySync();
}

function applyStoredForm() {
  const settings = cachedSettings || {};
  const features = resolveFeatures(settings);
  if (el("provider")) el("provider").value = settings.provider || "mymemory";
  if (el("sourceLang")) el("sourceLang").value = settings.sourceLang || "auto";
  if (el("targetLang")) el("targetLang").value = settings.targetLang || "zh-CN";
  if (el("batchSize")) el("batchSize").value = settings.batchSize || 8;
  if (el("translateLimit")) {
    el("translateLimit").value = isTitleLeadLimit(settings.translateLimit) ? TRANSLATE_LIMIT_TITLE_LEAD : "all";
  }
  if (el("twoStepPolish")) {
    el("twoStepPolish").checked = settings.twoStepPolish === true;
    syncSwitch(el("twoStepPolish"));
  }
  if (el("deepThink")) {
    el("deepThink").checked = settings.deepThink === true;
    syncSwitch(el("deepThink"));
  }
  if (el("translateScope")) el("translateScope").value = settings.translateScope || "article";
  syncTranslateScopeHint();
  if (el("fontScale")) el("fontScale").value = settings.fontScale || 0.95;
  if (el("bodyGlossGap")) el("bodyGlossGap").value = String(normalizeBodyGlossGap(settings.bodyGlossGap));
  if (el("bodyGlossStackGap")) el("bodyGlossStackGap").value = String(normalizeBodyGlossStackGap(settings.bodyGlossStackGap));
  if (el("skipCode")) {
    el("skipCode").checked = Boolean(settings.skipCode);
    syncSwitch(el("skipCode"));
  }
  if (el("autoOnNewPages")) {
    el("autoOnNewPages").checked = Boolean(settings.autoOnNewPages);
    syncSwitch(el("autoOnNewPages"));
  }
  if (el("pdfAutoTranslate")) {
    el("pdfAutoTranslate").checked = normalizePdfAutoTranslate(settings.pdfAutoTranslate);
    syncSwitch(el("pdfAutoTranslate"));
  }
  if (el("siteRules")) el("siteRules").value = (settings.siteRules || []).map((rule) => rule.host).join("\n");
  renderFeatures(el("featureList"), v1Features(), features);
  renderFeatures(el("laterList"), laterFeatures(), features);
  fillPdfLayout(settings.pdfLayout);
  syncPdfLayoutBox();
  syncPdfBanner();
  syncQualityLocks();
  renderProviderFields();
  paintKeyList();
  for (const id of ["batchSize", "fontScale", "bodyGlossGap", "bodyGlossStackGap"]) syncStepperBounds(el(id));
  const keysSync = el("keysSync");
  if (keysSync) {
    keysSync.checked = false;
    keysSync.disabled = true;
    keysSync.setAttribute("aria-checked", "false");
  }
}

async function pinKeySync() {
  const input = el("keysSync");
  if (input) {
    input.checked = false;
    input.disabled = true;
    input.setAttribute("aria-checked", "false");
  }
  const area = globalThis.chrome?.storage?.local;
  if (!area || typeof area.get !== "function" || typeof area.set !== "function") return;
  const bag = await area.get("keys.syncOptIn");
  if (!bag || bag["keys.syncOptIn"] !== false) await area.set({ "keys.syncOptIn": false });
}

function fillPageSelect() {
  const select = el("setPageSelect");
  if (!select) return;
  select.textContent = "";
  for (const page of SETTINGS_PAGES) {
    const option = document.createElement("option");
    option.value = page.id;
    option.textContent = page.label;
    select.appendChild(option);
  }
  select.addEventListener("change", () => showPage(select.value));
}

function syncSwitch(input) {
  if (!input || input.getAttribute("role") !== "switch") return;
  input.setAttribute("aria-checked", input.checked ? "true" : "false");
}

function syncSiteRulesBox() {
  const box = el("siteRulesBox");
  if (box) box.hidden = !el("autoOnNewPages")?.checked;
}

function syncStepperBounds(input) {
  if (!input?.id) return;
  const rawMin = input.getAttribute("min");
  const rawMax = input.getAttribute("max");
  const min = rawMin == null || rawMin === "" ? -Infinity : Number(rawMin);
  const max = rawMax == null || rawMax === "" ? Infinity : Number(rawMax);
  const value = Number(input.value);
  const finite = Number.isFinite(value);
  document.querySelectorAll(`[data-step-for="${input.id}"]`).forEach((button) => {
    const dir = Number(button.getAttribute("data-dir") || 1);
    button.disabled = finite && (dir < 0 ? value <= min : value >= max);
  });
}

function bindSteppers() {
  const seen = new Set();
  document.querySelectorAll("[data-step-for]").forEach((button) => {
    const id = button.getAttribute("data-step-for");
    button.addEventListener("click", () => {
      const input = el(id);
      if (!input || button.disabled) return;
      const dir = Number(button.getAttribute("data-dir") || 1);
      const rawStep = input.getAttribute("step") || input.step || "1";
      const step = Number(rawStep) * (dir < 0 ? -1 : 1);
      const rawMin = input.getAttribute("min");
      const rawMax = input.getAttribute("max");
      const min = rawMin == null || rawMin === "" ? -Infinity : Number(rawMin);
      const max = rawMax == null || rawMax === "" ? Infinity : Number(rawMax);
      const current = Number(input.value);
      const base = Number.isFinite(current) ? current : 0;
      const next = Math.min(max, Math.max(min, Math.round((base + step) * 1000) / 1000));
      const places = String(rawStep).split(".")[1]?.length || 0;
      input.value = places ? next.toFixed(places) : String(next);
      syncStepperBounds(input);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    if (id && !seen.has(id)) {
      seen.add(id);
      const input = el(id);
      input?.addEventListener("input", () => syncStepperBounds(input));
      syncStepperBounds(input);
    }
  });
}

function showReadError() {
  const row = el("setReadError");
  if (row) row.hidden = false;
}

function hideReadError() {
  const row = el("setReadError");
  if (row) row.hidden = true;
}

function snapshotControl(control) {
  if (!control) return null;
  if (control.id === "featureList" || control.id === "laterList" || control.dataset?.feat) {
    const features = {};
    document.querySelectorAll("[data-feat]").forEach((input) => {
      features[input.dataset.feat] = input.checked;
    });
    return { kind: "features", features };
  }
  if (control.id === "pdfCloudApiKey") return { kind: "pdfKey", value: pdfCloudKey };
  if (control.type === "checkbox") return { kind: "check", id: control.id, checked: control.checked };
  return { kind: "value", id: control.id, value: control.value };
}

function applySnapshot(snap) {
  if (!snap) return;
  if (snap.kind === "features") {
    document.querySelectorAll("[data-feat]").forEach((input) => {
      input.checked = snap.features[input.dataset.feat] === true;
      syncSwitch(input);
    });
    syncPdfLayoutBox();
    syncPdfBanner();
    return;
  }
  if (snap.kind === "pdfKey") {
    pdfCloudKey = snap.value;
    pdfCloudBound?.paint();
    return;
  }
  const node = el(snap.id);
  if (!node) return;
  if (snap.kind === "check") {
    node.checked = snap.checked;
    syncSwitch(node);
    syncSiteRulesBox();
    return;
  }
  node.value = snap.value;
  if (snap.id === "batchSize" || snap.id === "fontScale" || snap.id === "bodyGlossGap" || snap.id === "bodyGlossStackGap") {
    syncStepperBounds(node);
  }
}

function hideMiss(control) {
  const note = control?.parentElement?.querySelector?.(".set-save-miss");
  if (note) note.hidden = true;
}

function showMiss(control, retry) {
  if (!control) return;
  let note = control.parentElement?.querySelector?.(".set-save-miss");
  if (!note) {
    note = document.createElement("span");
    note.className = "set-save-miss";
    control.insertAdjacentElement?.("afterend", note) || control.parentElement?.appendChild(note);
  }
  note.hidden = false;
  note.replaceChildren(document.createTextNode("没保存上 · "));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "set-inline";
  button.textContent = "重试";
  button.addEventListener("click", () => {
    note.hidden = true;
    if (typeof retry === "function") retry();
    else void persist(control);
  });
  note.append(button);
}

async function exportSettings() {
  harvestVisibleProvider();
  const res = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  const settings = settingsForExport(res.settings || cachedSettings);
  const payload = {
    app: "open-immerse",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `open-immerse-settings-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  el("status").textContent = "已导出（不含密钥）";
  setTimeout(() => { el("status").textContent = ""; }, 2400);
}

async function importSettingsFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    const incoming = raw.settings || raw;
    if (!incoming || typeof incoming !== "object") throw new Error("无效的备份文件");
    if (Number(incoming.settingsVersion) > SETTINGS_VERSION) {
      el("status").textContent = "文件来自更新版本";
      return;
    }
    const prepared = prepareSettingsImport(raw);
    const res = await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: prepared.settings });
    if (!res || res.ok === false) throw new Error("save failed");
    cachedSettings = res.settings || prepared.settings;
    applyStoredForm();
    const note = el("importKeyNote");
    if (note) note.hidden = !prepared.ignoredKeys;
    el("status").textContent = prepared.ignoredKeys ? "文件里的 API 密钥已忽略，请在本机重新填写。" : "已导入";
  } catch (err) {
    el("status").textContent = "导入失败：" + String(err.message || err);
  }
}

function fillPdfLayout(value) {
  const layout = value && typeof value === "object" ? value : {};
  if (el("pdfLayoutMode")) el("pdfLayoutMode").value = layout.mode || "";
  if (el("pdfLocalBaseUrl")) el("pdfLocalBaseUrl").value = layout.localBaseUrl || "http://127.0.0.1:8765";
  if (el("pdfCloudBaseUrl")) el("pdfCloudBaseUrl").value = layout.cloudBaseUrl || "https://open.bigmodel.cn/api/paas/v4/layout_parsing";
  pdfCloudKey = layout.cloudApiKey || "";
  const input = el("pdfCloudApiKey");
  if (input && !pdfCloudBound) {
    input.setAttribute("data-key-slot", "pdf");
    pdfCloudBound = bindSecretInput(input, { getValue: () => pdfCloudKey });
    input.addEventListener("blur", () => {
      const result = pdfCloudBound.commit();
      if (result.ignored) return;
      pdfCloudKey = result.value;
      pdfCloudBound.showSaved();
      void persist(input);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "set-inline";
    remove.textContent = "移除密钥";
    remove.addEventListener("click", () => clearPdfCloud());
    input.parentElement?.appendChild(remove);
  }
  pdfCloudBound?.paint();
}

function readPdfLayout() {
  return {
    mode: el("pdfLayoutMode")?.value || "",
    localBaseUrl: el("pdfLocalBaseUrl")?.value || "http://127.0.0.1:8765",
    cloudBaseUrl: el("pdfCloudBaseUrl")?.value || "https://open.bigmodel.cn/api/paas/v4/layout_parsing",
    cloudModel: "glm-ocr",
    cloudApiKey: pdfCloudKey || ""
  };
}

async function clearPdfCloud() {
  const previous = pdfCloudKey;
  pdfCloudKey = "";
  pdfCloudBound?.paint();
  const res = await chrome.runtime.sendMessage({
    type: "OI_SAVE_SETTINGS",
    patch: { pdfLayout: readPdfLayout() },
    clear: { pdfCloud: true }
  });
  if (!res || res.ok === false) {
    pdfCloudKey = previous;
    pdfCloudBound?.paint();
    return;
  }
  showToast("已移除 PDF 云端密钥 · 撤销", () => {
    pdfCloudKey = previous;
    pdfCloudBound?.paint();
    void persist();
  });
}

function syncPdfLayoutBox() {
  const on = Boolean(document.querySelector('[data-feat="pdf"]')?.checked);
  const box = el("pdfLayoutBox");
  if (box) box.hidden = !on;
}

function syncPdfBanner() {
  const on = Boolean(document.querySelector('[data-feat="pdf"]')?.checked);
  const banner = el("mmPdfBanner");
  if (banner) banner.hidden = on;
}

function enablePdf() {
  const input = document.querySelector('[data-feat="pdf"]');
  if (input) {
    input.checked = true;
    syncSwitch(input);
  }
  syncPdfLayoutBox();
  syncPdfBanner();
  void persist(input);
}

function paintQualityNote(note, llm, provider, ready) {
  if (!note) return;
  note.replaceChildren();
  if (llm) {
    note.textContent = ready;
    return;
  }
  const why = document.createElement("span");
  why.className = "set-why";
  why.textContent = `当前引擎（${provider?.name || "当前"}）不支持 · `;
  note.append(why);
  const link = document.createElement("a");
  link.className = "set-engine-jump";
  link.href = "#provider";
  link.textContent = "换引擎";
  note.append(link);
}

function syncQualityLocks() {
  const provider = getProvider(el("provider")?.value);
  const llm = provider?.kind === "llm";
  for (const id of ["twoStepPolish", "deepThink"]) {
    const input = el(id);
    if (!input) continue;
    input.disabled = !llm;
    input.setAttribute("aria-disabled", llm ? "false" : "true");
  }
  paintQualityNote(el("twoStepPolishHint"), llm, provider, "先直译再润色，质量更好，更耗 token");
  paintQualityNote(el("deepThinkHint"), llm, provider, "关闭可加快 DeepSeek / Ark 翻译");
}

function jumpToProvider(event) {
  const link = event.target?.closest?.(".set-engine-jump");
  if (!link) return;
  event.preventDefault();
  const select = el("provider");
  if (!select) return;
  select.scrollIntoView?.({ block: "center" });
  select.focus();
}

function renderFeatures(box, list, features) {
  if (!box) return;
  box.textContent = "";
  list.forEach((feat) => {
    const row = document.createElement("div");
    row.className = "set-row";
    const txt = document.createElement("div");
    txt.className = "set-txt";
    const title = document.createElement("p");
    title.className = "set-title";
    title.textContent = feat.label;
    const note = document.createElement("p");
    note.className = "set-note";
    note.textContent = feat.hint;
    txt.append(title, note);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.feat = feat.id;
    input.setAttribute("role", "switch");
    input.checked = Boolean(features[feat.id]);
    syncSwitch(input);
    input.addEventListener("change", () => syncSwitch(input));
    row.append(txt, input);
    box.appendChild(row);
  });
}

function harvestVisibleProvider() {
  const providers = Object.assign({}, cachedSettings.providers || {});
  document.querySelectorAll("[data-provider]").forEach((input) => {
    if (input.dataset.secret === "1") return;
    const id = input.dataset.provider;
    providers[id] = Object.assign({}, providers[id] || {});
    providers[id][input.dataset.key] = input.type === "checkbox" ? input.checked : input.value;
  });
  cachedSettings.providers = providers;
}

function restoreTestButton() {
  const btn = el("testConnection");
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = "测试连接";
}

function invalidateTest(mode) {
  testRequestId += 1;
  restoreTestButton();
  if (mode === "clear") setTestStatus("");
}

function setTestStatus(text, kind) {
  const status = el("testConnectionStatus");
  if (!status) return;
  status.textContent = redactProviderText(text || "");
  status.className = kind ? `provider-test-status is-${kind}` : "provider-test-status";
  const badge = document.querySelector('[data-badge="translate"]');
  if (badge) badge.hidden = kind !== "err";
}

async function testConnection() {
  const btn = el("testConnection");
  if (!btn || btn.disabled) return;
  harvestVisibleProvider();
  const providerId = el("provider").value;
  const providerConfig = Object.assign({}, (cachedSettings.providers || {})[providerId] || {});
  const targetLang = el("targetLang").value || "zh-CN";
  const missing = missingRequiredField(getProvider(providerId), providerConfig);
  if (missing) {
    setTestStatus(formatConnectionStatus({ ok: false, missingField: missing.label }), "err");
    restoreTestButton();
    return;
  }
  const requestId = ++testRequestId;
  btn.disabled = true;
  btn.textContent = "测试中…";
  setTestStatus("正在探测…");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "OI_TEST_PROVIDER",
      provider: providerId,
      providerConfig,
      sourceLang: "en",
      targetLang,
      texts: [PROVIDER_PROBE_TEXT]
    });
    if (requestId !== testRequestId) return;
    const kind = res && res.ok ? "ok" : "err";
    setTestStatus(formatConnectionStatus(res || { ok: false, error: "无响应" }), kind);
  } catch (err) {
    if (requestId !== testRequestId) return;
    setTestStatus(formatConnectionStatus({ ok: false, error: String(err.message || err) }), "err");
  } finally {
    if (requestId === testRequestId) restoreTestButton();
  }
}

function renderProviderFields() {
  const root = el("providerFields");
  if (!root) return;
  root.textContent = "";
  const provider = getProvider(el("provider").value);
  const cfg = (cachedSettings.providers || {})[provider.id] || {};
  const card = document.createElement("div");
  card.className = "provider-card";
  const title = document.createElement("h3");
  title.textContent = provider.name;
  card.appendChild(title);
  if (provider.kind === "llm") {
    const ask = document.createElement("p");
    ask.className = "set-note";
    ask.textContent = ASK_TRANSLATION_LINE;
    card.appendChild(ask);
  }
  provider.fields.forEach((field) => {
    const wrap = document.createElement("label");
    wrap.appendChild(document.createTextNode(field.key === "apiKey" ? "API 密钥" : field.label));
    if (field.key === "apiKey") wrap.setAttribute("data-key-slot", "translate");
    let input;
    if (field.type === "textarea") {
      input = document.createElement("textarea");
      if (field.key === "headersJson" || field.key === "bodyTemplate") input.rows = 4;
    } else if (field.type === "select") {
      input = document.createElement("select");
      (field.options || []).forEach((opt) => {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        input.appendChild(option);
      });
    } else {
      input = document.createElement("input");
      input.type = "text";
    }
    input.dataset.provider = provider.id;
    input.dataset.key = field.key;
    if (field.placeholder) input.placeholder = field.placeholder;
    input.value = cfg[field.key] == null ? "" : String(cfg[field.key]);
    if (field.key === "apiKey") {
      input.dataset.secret = "1";
      input.autocomplete = "off";
      input.spellcheck = false;
      const bound = bindSecretInput(input, {
        getValue: () => (cachedSettings.providers?.[provider.id] || {})[field.key] || ""
      });
      input.addEventListener("blur", () => {
        const result = bound.commit();
        if (result.ignored) return;
        cachedSettings.providers = cachedSettings.providers || {};
        cachedSettings.providers[provider.id] = Object.assign({}, cachedSettings.providers[provider.id] || {});
        cachedSettings.providers[provider.id][field.key] = result.value;
        bound.showSaved();
        void persist(input);
      });
      bound.paint();
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "set-inline";
      toggle.textContent = "显示";
      toggle.addEventListener("click", () => {
        const shown = toggle.getAttribute("aria-pressed") === "true";
        toggle.setAttribute("aria-pressed", shown ? "false" : "true");
        toggle.textContent = shown ? "显示" : "隐藏";
        bound.reveal(!shown);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "set-inline";
      remove.textContent = "移除密钥";
      remove.addEventListener("click", () => clearProviderKey(provider.id));
      wrap.appendChild(input);
      wrap.appendChild(toggle);
      wrap.appendChild(remove);
      const saved = document.createElement("span");
      saved.setAttribute("data-secret-saved", "1");
      wrap.appendChild(saved);
    } else {
      wrap.appendChild(input);
      const event = field.type === "select" ? "change" : "blur";
      input.addEventListener(event, () => {
        harvestVisibleProvider();
        void persist(input);
      });
    }
    card.appendChild(wrap);
  });
  root.appendChild(card);
}

async function clearProviderKey(id) {
  const previous = (cachedSettings.providers?.[id] || {}).apiKey || "";
  cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey: "" });
  renderProviderFields();
  const res = await chrome.runtime.sendMessage({
    type: "OI_SAVE_SETTINGS",
    patch: { providers: { [id]: { apiKey: "" } } },
    clear: { providers: [id] }
  });
  if (!res || res.ok === false) {
    cachedSettings.providers[id].apiKey = previous;
    renderProviderFields();
    return;
  }
  const name = getProvider(id).name;
  showToast(`已移除 ${name} 密钥 · 撤销`, () => {
    cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey: previous });
    renderProviderFields();
    void persist();
  });
}

function restoreControl(control) {
  if (!control) return;
  const stored = cachedSettings || {};
  if (control.id === "featureList" || control.id === "laterList" || control.dataset?.feat) {
    const features = resolveFeatures(stored);
    document.querySelectorAll("[data-feat]").forEach((input) => {
      input.checked = Boolean(features[input.dataset.feat]);
      syncSwitch(input);
    });
    syncPdfLayoutBox();
    syncPdfBanner();
    return;
  }
  const checks = {
    twoStepPolish: stored.twoStepPolish === true,
    deepThink: stored.deepThink === true,
    skipCode: Boolean(stored.skipCode),
    autoOnNewPages: Boolean(stored.autoOnNewPages),
    pdfAutoTranslate: normalizePdfAutoTranslate(stored.pdfAutoTranslate)
  };
  if (Object.prototype.hasOwnProperty.call(checks, control.id)) {
    control.checked = checks[control.id];
    syncSwitch(control);
    syncSiteRulesBox();
    return;
  }
  const values = {
    provider: stored.provider || "mymemory",
    sourceLang: stored.sourceLang || "auto",
    targetLang: stored.targetLang || "zh-CN",
    batchSize: stored.batchSize || 8,
    translateLimit: isTitleLeadLimit(stored.translateLimit) ? TRANSLATE_LIMIT_TITLE_LEAD : "all",
    translateScope: stored.translateScope || "article",
    fontScale: stored.fontScale || 0.95,
    bodyGlossGap: normalizeBodyGlossGap(stored.bodyGlossGap),
    bodyGlossStackGap: normalizeBodyGlossStackGap(stored.bodyGlossStackGap),
    pdfLayoutMode: stored.pdfLayout?.mode || "",
    pdfLocalBaseUrl: stored.pdfLayout?.localBaseUrl || "http://127.0.0.1:8765",
    pdfCloudBaseUrl: stored.pdfLayout?.cloudBaseUrl || "https://open.bigmodel.cn/api/paas/v4/layout_parsing",
    siteRules: (stored.siteRules || []).map((rule) => rule.host).join("\n")
  };
  if (Object.prototype.hasOwnProperty.call(values, control.id)) control.value = String(values[control.id] ?? "");
}

async function persist(control) {
  if (!readsOk) return;
  const before = JSON.parse(JSON.stringify(cachedSettings));
  const beforePdf = pdfCloudKey;
  harvestVisibleProvider();
  const features = {};
  document.querySelectorAll("[data-feat]").forEach((input) => {
    features[input.dataset.feat] = input.checked;
  });
  const siteRules = String(el("siteRules")?.value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const bad = siteRules.filter((host) => !/^[a-z0-9.-]+$/i.test(host.replace(/^www\./, "")));
  const siteError = el("siteRulesError");
  if (siteError) {
    siteError.hidden = bad.length === 0;
    siteError.textContent = bad.length ? `这些行不像域名：${bad.join("、")}` : "";
  }
  const patch = {
    provider: el("provider").value,
    sourceLang: el("sourceLang").value,
    targetLang: el("targetLang").value,
    batchSize: Number(el("batchSize").value) || 8,
    translateLimit: el("translateLimit").value === TRANSLATE_LIMIT_TITLE_LEAD ? TRANSLATE_LIMIT_TITLE_LEAD : "all",
    twoStepPolish: el("twoStepPolish").checked,
    deepThink: el("deepThink").checked,
    translationStyle: cachedSettings.translationStyle || "under",
    translateScope: el("translateScope").value || "article",
    fontScale: Number(el("fontScale").value) || 0.95,
    bodyGlossGap: normalizeBodyGlossGap(el("bodyGlossGap").value),
    bodyGlossStackGap: normalizeBodyGlossStackGap(el("bodyGlossStackGap").value),
    skipCode: el("skipCode").checked,
    autoOnNewPages: el("autoOnNewPages").checked,
    pdfAutoTranslate: el("pdfAutoTranslate") ? el("pdfAutoTranslate").checked : true,
    hoverEnabled: Boolean(features.hover),
    showFab: features.fab !== false,
    subtitleEnabled: Boolean(features.youtube || features.x),
    features: features,
    siteRules: siteRules.filter((host) => !bad.includes(host)).map((host) => ({ host: host.replace(/^www\./, ""), auto: true })),
    providers: cachedSettings.providers,
    pdfLayout: readPdfLayout()
  };
  writing = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: patch });
    if (!res || res.ok === false) {
      const attempt = snapshotControl(control);
      cachedSettings = before;
      pdfCloudKey = beforePdf;
      restoreControl(control);
      showMiss(control, () => {
        applySnapshot(attempt);
        void persist(control);
      });
      return;
    }
    cachedSettings = res.settings || cachedSettings;
    hideMiss(control);
    paintKeyList();
  } catch {
    const attempt = snapshotControl(control);
    cachedSettings = before;
    pdfCloudKey = beforePdf;
    restoreControl(control);
    showMiss(control, () => {
      applySnapshot(attempt);
      void persist(control);
    });
  } finally {
    writing = false;
  }
}

function fillSelect(select, items) {
  if (!select) return;
  select.textContent = "";
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  });
}

function bindInstant() {
  const ids = [
    "sourceLang", "targetLang", "batchSize", "translateLimit", "twoStepPolish", "deepThink",
    "translateScope", "fontScale", "bodyGlossGap", "bodyGlossStackGap", "skipCode",
    "autoOnNewPages", "pdfAutoTranslate", "pdfLayoutMode"
  ];
  for (const id of ids) {
    const node = el(id);
    if (!node) continue;
    const event = node.type === "checkbox" || node.tagName === "SELECT" ? "change" : "change";
    node.addEventListener(event, () => {
      if (node.getAttribute("role") === "switch") syncSwitch(node);
      syncSiteRulesBox();
      void persist(node);
    });
  }
  el("siteRules")?.addEventListener("blur", () => void persist(el("siteRules")));
  el("pdfLocalBaseUrl")?.addEventListener("blur", () => void persist(el("pdfLocalBaseUrl")));
  el("pdfCloudBaseUrl")?.addEventListener("blur", () => void persist(el("pdfCloudBaseUrl")));
  el("featureList")?.addEventListener("change", () => void persist(el("featureList")));
  el("restoreReaderPrefs")?.addEventListener("click", () => restoreReaderPrefs());
  el("restorePanelWidth")?.addEventListener("click", () => resetNotesWidth("panel"));
  el("restoreNotesWidth")?.addEventListener("click", () => resetNotesWidth("notes"));
  el("notesPaneSide")?.addEventListener("change", () => {
    notesSession?.write({ notesPaneSide: el("notesPaneSide").value });
  });
}

function paintFormulaSettings() {
  const root = el("formulaSettingsRoot");
  if (!root) return;
  renderFormulaPanel(root, formulaSettings, {
    busy: formulaBusy,
    onMultimodal: (patch, opts) => updateFormulaPart("multimodal", patch, opts),
    onOcr: (patch, opts) => updateFormulaPart("ocr", patch, opts),
    onToggle: (key, enabled) => updateFormulaSwitch(key, enabled),
    onConfigure: (target) => focusFormulaCard(root, target),
    onRemove: (which) => removeFormulaSecret(which),
    onTest: (kind) => testFormulaConnection(kind)
  });
  syncFormulaDerived();
  refreshBadges();
  if (focusMm) {
    focusMm = false;
    focusFormulaCard(root, "mm");
  }
}

function syncFormulaDerived() {
  const root = el("formulaSettingsRoot");
  if (!root || formulaBusy) return;
  const mm = root.querySelector("[data-formula-action='mm']");
  if (mm) mm.disabled = multimodalTestDisabled(formulaSettings);
  const ocr = root.querySelector("[data-formula-action='ocr']");
  if (ocr) ocr.disabled = ocrTestDisabled(formulaSettings);
}

function updateFormulaPart(which, patch, opts = {}) {
  formulaSettings = applyFormulaPart(formulaSettings, which, patch);
  if (opts.live) {
    syncFormulaDerived();
    return;
  }
  const structural = Object.prototype.hasOwnProperty.call(patch, "provider")
    || Object.prototype.hasOwnProperty.call(patch, "customModel");
  return persistFormulaSettings(structural);
}

async function updateFormulaSwitch(key, enabled) {
  const next = { ...formulaSettings, [key]: enabled === true };
  formulaSettings = normalizeFormulaSettings(next);
  await persistFormulaSettings(true);
}

async function removeFormulaSecret(which) {
  const snapshot = formulaSettings;
  formulaSettings = removeFormulaKey(formulaSettings, which);
  paintFormulaSettings();
  await persistFormulaSettings(false);
  const name = which === "ocr" ? "OCR" : "多模态";
  showToast(`已移除 ${name} 密钥 · 撤销`, async () => {
    formulaSettings = snapshot;
    await persistFormulaSettings(true);
  });
}

function showFormulaMiss() {
  let note = el("formulaSaveMiss");
  if (!note) {
    note = document.createElement("p");
    note.id = "formulaSaveMiss";
    note.className = "set-save-miss";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "set-inline";
    button.textContent = "重试";
    button.addEventListener("click", () => {
      note.hidden = true;
      if (formulaUndo) {
        formulaSettings = formulaUndo;
        paintFormulaSettings();
      }
      void persistFormulaSettings(true);
    });
    note.append(document.createTextNode("没保存上 · "), button);
    el("formulaSettingsRoot")?.insertAdjacentElement("afterend", note);
  }
  note.hidden = false;
}

function hideFormulaMiss() {
  const note = el("formulaSaveMiss");
  if (note) note.hidden = true;
}

function persistFormulaSettings(rerender) {
  const job = formulaWrite.then(async () => {
    formulaWriting = true;
    const snapshot = formulaSettings;
    let failed = false;
    try {
      await writeFormulaSettings(snapshot, globalThis.chrome?.storage?.local);
      formulaSaved = snapshot;
      formulaUndo = null;
      hideFormulaMiss();
    } catch {
      failed = true;
      formulaUndo = snapshot;
      if (formulaSettings === snapshot) {
        formulaSettings = formulaSaved;
        paintFormulaSettings();
      }
      showFormulaMiss();
    } finally {
      formulaWriting = false;
    }
    if (!failed && rerender && formulaSettings === snapshot) paintFormulaSettings();
  });
  formulaWrite = job.catch(() => {});
  return job;
}

async function testFormulaConnection(kind) {
  if (formulaBusy) return;
  const which = kind === "ocr" ? "ocr" : "multimodal";
  formulaBusy = kind === "ocr" ? "ocr" : "mm";
  paintFormulaSettings();
  const card = formulaSettings[which];
  const probe = await runFormulaProbe({
    kind: which,
    provider: card.provider,
    model: card.model,
    baseUrl: card.baseUrl || "",
    apiKey: card.apiKey
  }, stubFormulaProbe);
  formulaSettings = normalizeFormulaSettings({
    ...formulaSettings,
    [which]: { ...formulaSettings[which], probe }
  });
  formulaBusy = "";
  await persistFormulaSettings(true);
}

function bindFormulaSettings() {
  const storage = globalThis.chrome?.storage;
  storage?.onChanged?.addListener((changes, area) => {
    if (formulaWriting || area !== "local" || !changes[FORMULA_SETTINGS_KEY]) return;
    formulaSettings = normalizeFormulaSettings(changes[FORMULA_SETTINGS_KEY].newValue);
    paintFormulaSettings();
  });
  readFormulaSettings(storage?.local).then((stored) => {
    formulaSettings = stored;
    formulaSaved = stored;
    paintFormulaSettings();
  }).catch(() => paintFormulaSettings());
}

function bindNotes() {
  notesSession = createNotesPrefsSession();
  const paint = (prefs) => {
    if (!prefs) return;
    if (el("notesPaneSide")) el("notesPaneSide").value = prefs.notesPaneSide || "end";
    if (el("panelWidthValue")) el("panelWidthValue").textContent = String(prefs.panelWidth);
    if (el("notesWidthValue")) el("notesWidthValue").textContent = String(prefs.notesWidth);
    const panelBtn = el("restorePanelWidth");
    const notesBtn = el("restoreNotesWidth");
    if (panelBtn) panelBtn.disabled = prefs.panelWidth === NOTES_PANEL_WIDTH_DEFAULT;
    if (notesBtn) notesBtn.disabled = prefs.notesWidth === NOTES_PANE_WIDTH_DEFAULT;
  };
  notesSession.prime().then(paint);
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes["reader.panelWidth"] || changes["reader.notesWidth"] || changes["reader.notesPaneSide"]) {
      paint(notesSession.read());
    }
  });
}

function resetNotesWidth(which) {
  if (!notesSession) return;
  if (which === "panel") notesSession.write({ panelWidth: NOTES_PANEL_WIDTH_DEFAULT });
  else notesSession.write({ notesWidth: NOTES_PANE_WIDTH_DEFAULT });
  const prefs = notesSession.read();
  if (el("panelWidthValue")) el("panelWidthValue").textContent = String(prefs.panelWidth);
  if (el("notesWidthValue")) el("notesWidthValue").textContent = String(prefs.notesWidth);
  const panelBtn = el("restorePanelWidth");
  const notesBtn = el("restoreNotesWidth");
  if (panelBtn) panelBtn.disabled = prefs.panelWidth === NOTES_PANEL_WIDTH_DEFAULT;
  if (notesBtn) notesBtn.disabled = prefs.notesWidth === NOTES_PANE_WIDTH_DEFAULT;
}

function restoreReaderPrefs() {
  const storage = globalThis.localStorage;
  if (!storage) return;
  const snapshot = [];
  const keep = new Set(["reader.panelWidth", "reader.notesWidth", "reader.notesPaneSide", "reader.notesPersistHintDismissed"]);
  const keys = [];
  for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
  for (const key of keys) {
    if (!key) continue;
    const reader = key.startsWith("reader.") || key === "oi.reader.cjk" || key === "oi.rfSrcFold";
    if (!reader || keep.has(key) || key.startsWith("reader.notesPersistHintDismissed.")) continue;
    snapshot.push([key, storage.getItem(key)]);
    storage.removeItem(key);
  }
  showToast("已恢复阅读偏好默认值 · 撤销", () => {
    for (const [key, value] of snapshot) storage.setItem(key, value);
  });
}

function bindData() {
  const root = el("dataPanelMount");
  if (!root) return;
  dataPanel = mountDataPanel(root);
  root.addEventListener("oi-data-status", () => refreshBadges());
  root.addEventListener("click", (ev) => {
    const button = ev.target?.closest?.("[data-act='persist-again']");
    if (!button) return;
    const persist = globalThis.navigator?.storage?.persist;
    if (typeof persist === "function") persist.call(globalThis.navigator.storage).catch(() => {});
  });
}

function paintKeyList() {
  const host = el("keyList");
  if (!host) return;
  host.textContent = "";
  const rows = [
    ["translate", "翻译", Boolean((cachedSettings.providers?.[cachedSettings.provider] || {}).apiKey)],
    ["mm", "多模态", Boolean(formulaSettings?.multimodal?.apiKey)],
    ["ocr", "OCR", Boolean(formulaSettings?.ocr?.apiKey)],
    ["pdf", "PDF 云端", Boolean(pdfCloudKey)]
  ];
  for (const [slot, name, on] of rows) {
    const line = document.createElement("button");
    line.type = "button";
    line.className = "set-row set-hit";
    line.textContent = `${name} · ${on ? "本机" : "—"}`;
    line.addEventListener("click", () => jumpSlot(slot));
    host.appendChild(line);
  }
}

function jumpSlot(slot) {
  const map = { translate: "translate", mm: "mm", ocr: "mm", pdf: "pdf" };
  showPage(map[slot] || "translate");
  const node = document.querySelector(`[data-key-slot="${slot}"]`);
  if (!node) return;
  node.classList.add("set-flash");
  const input = node.querySelector?.("input") || node;
  input.focus?.();
  setTimeout(() => node.classList.remove("set-flash"), 1200);
}

function bindSecretsList() {
  paintKeyList();
}

function refreshBadges() {
  const mm = document.querySelector('[data-badge="mm"]');
  const probeBad = [formulaSettings?.multimodal?.probe, formulaSettings?.ocr?.probe].some((probe) => probe && probe.ok === false && probe.chip);
  if (mm) mm.hidden = !probeBad;
  const data = document.querySelector('[data-badge="data"]');
  if (data) data.hidden = !dataPanel?.needsAttention?.();
}

function searchHits(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  if (q === "密钥") {
    return ["translate", "mm", "ocr", "pdf"]
      .map((slot) => document.querySelector(`[data-key-slot="${slot}"]`))
      .filter(Boolean);
  }
  const focusOf = { 导入: "import", 导出: "export", 备份: "backup" };
  if (Object.prototype.hasOwnProperty.call(focusOf, q)) {
    const group = document.querySelector(`[data-focus="${focusOf[q]}"]`);
    return group ? [group] : [];
  }
  const nodes = [...document.querySelectorAll("[data-key-slot], .set-row, .set-gh, .oi-set-field, h3, label")];
  const hits = [];
  const seen = new Set();
  for (const node of nodes) {
    const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
    if (!text.toLowerCase().includes(q)) continue;
    const slot = node.getAttribute?.("data-key-slot");
    const id = slot || `${text.slice(0, 48)}:${node.className || node.tagName}`;
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push(node);
  }
  return hits;
}

function bindSearch() {
  const boxes = [el("setSearch"), el("setSearchNarrow")].filter(Boolean);
  const results = el("setResults");
  const paint = (query) => {
    if (!results) return;
    const hits = searchHits(query);
    results.textContent = "";
    results.hidden = hits.length === 0;
    for (const node of hits.slice(0, 8)) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 48);
      button.addEventListener("click", () => {
        const panel = node.closest?.("[data-panel]")?.dataset.panel;
        if (panel) showPage(panel);
        node.classList.add("set-flash");
        const focus = node.querySelector?.("input, select, button, a") || node;
        if (node.tabIndex < 0) node.tabIndex = -1;
        (focus.focus ? focus : node).focus?.();
        node.scrollIntoView?.({ block: "center" });
        setTimeout(() => node.classList.remove("set-flash"), 1200);
        results.hidden = true;
      });
      results.appendChild(button);
    }
  };
  for (const box of boxes) box.addEventListener("input", () => paint(box.value));
}

function showToast(text, undo) {
  const toast = el("setToast");
  if (!toast) return;
  toast.textContent = "";
  toast.appendChild(document.createTextNode(text + " "));
  if (undo) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "set-inline";
    button.textContent = "撤销";
    button.addEventListener("click", () => {
      clearTimeout(toastTimer);
      toast.hidden = true;
      undo();
    });
    toast.appendChild(button);
  }
  toast.hidden = false;
  toastUndo = undo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
    toastUndo = null;
  }, 5000);
}

function showPage(id, focus) {
  const parsed = parseSettingsHash(`#${id}`);
  const next = parsed.id;
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    const on = panel.dataset.panel === next;
    panel.classList.toggle("is-on", on);
    panel.hidden = !on;
  });
  document.querySelectorAll("[data-nav]").forEach((tab) => {
    const on = tab.dataset.nav === next;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  });
  const select = el("setPageSelect");
  if (select) select.value = next;
  if (location.hash !== `#${next}`) history.replaceState(null, "", `#${next}`);
  if (next === "mm") focusMm = true;
  if (focus && next === "data") {
    const group = document.querySelector(`[data-focus="${focus}"]`);
    if (group) {
      group.tabIndex = -1;
      group.scrollIntoView?.({ block: "center" });
      group.focus?.();
      group.classList.add("set-flash");
      setTimeout(() => group.classList.remove("set-flash"), 1200);
    }
  }
  if (next === "mm") {
    const root = el("formulaSettingsRoot");
    if (root?.childNodes?.length) {
      focusMm = false;
      focusFormulaCard(root, "mm");
    }
  }
}

function bindPanelNav() {
  const tabs = [...document.querySelectorAll("[data-nav]")];
  tabs.forEach((tab, index) => {
    tab.tabIndex = index === 0 ? 0 : -1;
    tab.addEventListener("click", () => showPage(tab.dataset.nav));
    tab.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Enter") return;
      const list = [...document.querySelectorAll("[data-nav]")];
      const at = list.indexOf(tab);
      if (ev.key === "Enter") {
        showPage(tab.dataset.nav);
        return;
      }
      ev.preventDefault();
      const dir = ev.key === "ArrowDown" ? 1 : -1;
      const next = list[(at + dir + list.length) % list.length];
      next?.focus();
    });
  });
  window.addEventListener("hashchange", () => {
    const parsed = parseSettingsHash(location.hash);
    showPage(parsed.id, parsed.focus);
  });
  const parsed = parseSettingsHash(location.hash);
  if (parsed.redirected) history.replaceState(null, "", parsed.replace);
  showPage(parsed.id, parsed.focus);
}

export { searchHits, showPage };
