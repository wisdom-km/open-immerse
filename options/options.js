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
import {
  normalizeSecrets,
  prepareSettingsImport,
  readLiveSecrets,
  sealSettingsPatch,
  settingsForExport,
  settingsImportHasChanges,
  SECRET_STORAGE_KEY,
  captureEngineSlice,
  decideKeyReconcile,
  restoreEngineSlice,
  runAfterSecretBagIdle,
  withSecretBagLock
} from "../lib/settings-secrets.js";
import {
  PROVIDER_ATTENTION_KEY,
  clearProviderAttention,
  markProviderAttention,
  readProviderAttention
} from "../lib/provider-attention.js";
import { bindSecretInput } from "../lib/secret-field.js";
import { ASK_TRANSLATION_LINE } from "../lib/ask-route.js";
import {
  FORMULA_SETTINGS_KEY,
  acceptStoredFormulaSettings,
  applyFormulaPart,
  classifyFormulaProbe,
  customBaseUrlError,
  multimodalTestDisabled,
  normalizeFormulaSettings,
  ocrTestDisabled,
  readFormulaSettings,
  removeFormulaKey,
  runFormulaProbe,
  stubFormulaProbe,
  writeFormulaSettings
} from "../lib/formula-settings.js";
import { createProbeController, probeMultimodal, settleProbeResult } from "../lib/mm-probe.js";
import { focusFormulaCard, renderFormulaPanel } from "../lib/formula-settings-ui.js";
import { createNotesPrefsSession } from "../lib/reader-notes-local.js";
import { NOTES_PANEL_WIDTH_DEFAULT, NOTES_PANE_WIDTH_DEFAULT } from "../lib/notes-prefs.js";
import { downloadBlob } from "../lib/export.js";
import { sharedLibraryStore } from "../lib/library-session.js";
import { mountDataPanel } from "./data-panel.js";
import { SETTINGS_PAGES, parseSettingsHash } from "./route.js";

let hostDocument = null;
let hostWindow = null;

function liveHost(read) {
  return new Proxy({}, {
    get(_target, prop) {
      const target = read();
      if (!target) return undefined;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, prop, value) {
      const target = read();
      if (!target) return false;
      return Reflect.set(target, prop, value, target);
    },
    has(_target, prop) {
      const target = read();
      return target ? prop in target : false;
    }
  });
}

const document = liveHost(() => hostDocument || globalThis.document);
const window = liveHost(() => hostWindow || globalThis.window);

/** Bind this module instance to one tab's document. Tests load one instance per tab. */
export function attachOptionsHost(page = {}) {
  hostDocument = page.document || null;
  hostWindow = page.window || null;
}

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
let formulaCommitted = formulaSettings;
let formulaUndo = null;
let formulaBusy = "";
let formulaWriting = false;
let formulaEchoKey = "";
let formulaExternal = null;
let formulaWrite = Promise.resolve();
// Bumps on every key commit and removal, including saving the same key again.
let formulaSecretEpoch = { multimodal: 0, ocr: 0 };
// 已提交卡片是这一页唯一写入来源。不变量：
// 1. formulaCommitted 是唯一事实来源。逐字输入留在 formulaSettings，change / blur 才提交。
// 2. 所有存储写入进同一条队列。出队时读当时的 formulaCommitted，不读入队时的旧快照。
// 3. 同一拍先提交 URL 再切换开关或移除密钥，两次出队都看见新 URL。
// 4. 芯片只画 formulaSaved.probe。队列排空后，存储等于已提交卡片，屏幕上的已保存值等于存储，草稿不进存储。
// 5. 被拒绝的 URL 不改 formulaCommitted，输入回滚到已提交值，并显示「没保存上」。
// 6. 自己的 storage 回声用写入时的 JSON 识别，迟到的 onChanged 也不把草稿弹回。
// 7. pagehide 只中止探测，不提交未保存的地址。
// 8. 保存或移除密钥（含换回同一把）清掉该卡的「已连通」，并增加写入序号。旧探测晚到时序号对不上就丢弃。
const formulaProbeCtl = createProbeController();
let notesSession = null;
let dataPanel = null;
let focusMm = false;
let toastTimer = 0;
let toastUndo = null;
let attentionProvider = "";
let pdfCloudEdit = null;
let providerEdits = new Map();
const providerKeyChain = new Map();
const providerKeyHold = new Set();
const providerKeyUi = new Map();
let providerSecretPaint = null;
let secretSyncBound = false;
let secretReadTicket = 0;
let pageClosed = false;
let secretChangeListener = null;

function pageAlive() {
  return pageClosed !== true;
}

function stopSecretPage() {
  pageClosed = true;
  const listener = secretChangeListener;
  secretChangeListener = null;
  if (listener && chrome.storage?.onChanged?.removeListener) chrome.storage.onChanged.removeListener(listener);
}

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
  cachedSettings = JSON.parse(JSON.stringify(res.settings || { providers: {} }));
  if (readsOk) {
    try {
      await reconcileOpenSecrets();
      await overlayLocalKeyOpinion();
    } catch {
      // The form still opens with what the background returned.
    }
  }
  applyStoredForm();
  el("translateScope").addEventListener("change", () => syncTranslateScopeHint());
  bindData();
  bindPanelNav();
  el("laterList")?.addEventListener("change", () => {
    syncPdfLayoutBox();
    syncPdfBanner();
    void persist(el("laterList"));
  });
  bindFormulaSettings();
  bindNotes();
  bindSecretsList();
  el("provider").addEventListener("change", () => {
    const left = attentionProvider;
    harvestVisibleProvider();
    renderProviderFields();
    syncQualityLocks();
    invalidateTest("clear");
    attentionProvider = el("provider").value;
    void (async () => {
      if (left && left !== attentionProvider) await clearProviderAttention(chrome.storage?.local, left);
      await syncAttentionBadge();
    })();
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
  bindSecretSync();
  await pinKeySync();
  await syncAttentionBadge();
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
  attentionProvider = el("provider")?.value || settings.provider || "";
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
  if (!readsOk) {
    el("status").textContent = "没能读取已保存的设置，先重试再导入。";
    return;
  }
  try {
    const raw = JSON.parse(await file.text());
    const incoming = raw.settings || raw;
    if (!incoming || typeof incoming !== "object") throw new Error("无效的备份文件");
    if (Number(incoming.settingsVersion) > SETTINGS_VERSION) {
      el("status").textContent = "文件来自更新版本";
      return;
    }
    const prepared = prepareSettingsImport(raw);
    if (!settingsImportHasChanges(prepared.settings)) {
      const note = el("importKeyNote");
      if (note) note.hidden = !prepared.ignoredKeys;
      el("status").textContent = prepared.ignoredKeys ? "文件里的 API 密钥已忽略，请在本机重新填写。" : "已导入";
      return;
    }
    const res = await enqueueSave(async () => {
      const live = await readLiveSecrets(chrome.storage);
      const patch = sealSettingsPatch(prepared.settings, { pdfCloudApiKey: live.pdfCloudApiKey });
      return chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch });
    });
    if (!res || res.ok === false) throw new Error("save failed");
    cachedSettings = JSON.parse(JSON.stringify(res.settings || prepared.settings));
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
      if (!cachedSettings.pdfLayout || typeof cachedSettings.pdfLayout !== "object") cachedSettings.pdfLayout = {};
      cachedSettings.pdfLayout.cloudApiKey = result.value;
      if (result.changed) pdfCloudEdit = result.value;
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

function rememberPdfCloud(value) {
  pdfCloudKey = value || "";
  if (!cachedSettings.pdfLayout || typeof cachedSettings.pdfLayout !== "object") cachedSettings.pdfLayout = {};
  cachedSettings.pdfLayout.cloudApiKey = pdfCloudKey;
}

async function clearPdfCloud() {
  const previous = pdfCloudKey;
  pdfCloudEdit = null;
  rememberPdfCloud("");
  pdfCloudBound?.paint();
  const res = await enqueueSave(() => chrome.runtime.sendMessage({
    type: "OI_SAVE_SETTINGS",
    patch: { pdfLayout: readPdfLayout() },
    clear: { pdfCloud: true }
  }));
  if (!res || res.ok === false) {
    rememberPdfCloud(previous);
    pdfCloudBound?.paint();
    return;
  }
  showToast("已移除 PDF 云端密钥 · 撤销", () => {
    rememberPdfCloud(previous);
    pdfCloudEdit = previous;
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

function attentionArea() {
  return globalThis.chrome?.storage?.local;
}

async function syncAttentionBadge(options = {}) {
  const badge = document.querySelector('[data-badge="translate"]');
  if (!badge) return;
  attentionProvider = el("provider")?.value || attentionProvider || "";
  let flagged = false;
  try {
    const flags = await readProviderAttention(attentionArea());
    flagged = flags[attentionProvider] === true;
  } catch {
    flagged = false;
  }
  if (flagged) {
    badge.hidden = false;
    return;
  }
  const status = el("testConnectionStatus");
  if (!options.trustStorage && status?.classList?.contains("is-err")) return;
  badge.hidden = true;
}

function bindSecretSync() {
  if (secretSyncBound) return;
  secretSyncBound = true;
  secretChangeListener = (changes, area) => {
    if (!pageAlive()) return;
    if (area === "local" && changes[PROVIDER_ATTENTION_KEY]) void syncAttentionBadge({ trustStorage: true });
    const secretWrite = (area === "local" && Object.prototype.hasOwnProperty.call(changes, SECRET_STORAGE_KEY))
      || (area === "sync" && Object.prototype.hasOwnProperty.call(changes, "settings"));
    if (!secretWrite) return;
    const busy = new Set([...providerKeyHold, ...providerEdits.keys()]);
    const ticket = ++secretReadTicket;
    void runAfterSecretBagIdle(async () => {
      if (!pageAlive() || ticket !== secretReadTicket) return;
      try {
        await reconcileOpenSecrets(busy);
      } catch {
        // Still paint whatever is stored now.
      }
      if (!pageAlive() || ticket !== secretReadTicket) return;
      const live = await readLiveSecrets(chrome.storage);
      if (!pageAlive() || ticket !== secretReadTicket) return;
      applyLiveSecrets(live, busy);
    }).catch(() => {});
  };
  chrome.storage?.onChanged?.addListener(secretChangeListener);
  window.addEventListener("pagehide", stopSecretPage);
}

function applyLiveSecrets(live, busy = new Set()) {
  const stored = live || { providers: {}, pdfCloudApiKey: "" };
  cachedSettings.providers = cachedSettings.providers || {};
  const ids = new Set([...Object.keys(cachedSettings.providers), ...Object.keys(stored.providers || {})]);
  for (const id of ids) {
    if (providerEdits.has(id) || providerKeyHold.has(id) || busy.has(id)) continue;
    const key = stored.providers?.[id] || "";
    cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey: key });
  }
  if (pdfCloudEdit == null) {
    rememberPdfCloud(stored.pdfCloudApiKey || "");
    const pdfInput = el("pdfCloudApiKey");
    if (pdfInput && document.activeElement !== pdfInput) pdfCloudBound?.paint();
  }
  const current = el("provider")?.value || "";
  const providerInput = document.querySelector("[data-key-slot='translate'] input");
  if (providerInput && document.activeElement !== providerInput && !providerEdits.has(current)) providerSecretPaint?.();
}

async function sealOutgoingPatch(patch) {
  const live = await readLiveSecrets(chrome.storage);
  const next = JSON.parse(JSON.stringify(patch || {}));
  if (next.providers && typeof next.providers === "object") {
    for (const [id, cfg] of Object.entries(next.providers)) {
      if (!cfg || typeof cfg !== "object") continue;
      delete cfg.apiKey;
    }
  }
  const cloud = pdfCloudEdit != null ? pdfCloudEdit : live.pdfCloudApiKey;
  if (next.pdfLayout && typeof next.pdfLayout === "object") next.pdfLayout.cloudApiKey = cloud || "";
  return sealSettingsPatch(next, { pdfCloudApiKey: cloud });
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
    await markProviderAttention(attentionArea(), providerId);
    if (el("provider")?.value !== providerId) return;
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
    if (res && res.ok) await clearProviderAttention(attentionArea(), providerId);
    else await markProviderAttention(attentionArea(), providerId);
    if (requestId !== testRequestId) return;
    setTestStatus(formatConnectionStatus(res || { ok: false, error: "无响应" }), res && res.ok ? "ok" : "err");
  } catch (err) {
    if (requestId !== testRequestId) return;
    await markProviderAttention(attentionArea(), providerId);
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
        const beforeKey = (cachedSettings.providers?.[provider.id] || {})[field.key] || "";
        cachedSettings.providers[provider.id][field.key] = result.value;
        bound.paint();
        bound.showSaved();
        if (result.changed) {
          providerEdits.set(provider.id, result.value);
          invalidateTest("clear");
          void clearProviderAttention(attentionArea(), provider.id);
          const ticket = claimProviderKey(provider.id);
          void queueProviderKey(provider.id, result.value, false, beforeKey, ticket);
        }
        void persist(input);
      });
      bound.paint();
      providerSecretPaint = () => bound.paint();
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

function claimProviderKey(id) {
  const ticket = (providerKeyUi.get(id) || 0) + 1;
  providerKeyUi.set(id, ticket);
  return ticket;
}

function ownsProviderKey(id, ticket) {
  return providerKeyUi.get(id) === ticket;
}

let saveChain = null;

function enqueueSave(run) {
  const prev = saveChain;
  const next = prev ? prev.then(() => run(), () => run()) : run();
  const idle = Promise.resolve(next).then(() => undefined, () => undefined);
  saveChain = idle;
  void idle.then(() => {
    if (saveChain === idle) saveChain = null;
  });
  return Promise.resolve(next);
}

function enqueueProviderKey(id, run) {
  providerKeyHold.add(id);
  const done = enqueueSave(run);
  const marker = Promise.resolve(done).then(() => undefined, () => undefined);
  providerKeyChain.set(id, marker);
  void marker.then(() => {
    if (providerKeyChain.get(id) === marker) providerKeyHold.delete(id);
  });
  return Promise.resolve(done);
}

async function readProviderBag() {
  try {
    const bag = await chrome.storage.local.get(SECRET_STORAGE_KEY);
    return normalizeSecrets(bag?.[SECRET_STORAGE_KEY]);
  } catch {
    return normalizeSecrets(null);
  }
}

function appliedProviderSeq(bag, id) {
  if (bag?.applied && Object.prototype.hasOwnProperty.call(bag.applied, id)) return Number(bag.applied[id]) || 0;
  return Number(bag?.seq?.[id]) || 0;
}

function withEngineLock(id, run) {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== "function") return run();
  return locks.request(`oi-secret-${id}`, () => run());
}

async function withEngineLocks(ids, run) {
  const names = [...new Set(ids.filter(Boolean))].sort();
  if (!names.length) return run();
  return withEngineLock(names[0], () => withEngineLocks(names.slice(1), run));
}

async function reserveProviderSeq(id, want) {
  return withSecretBagLock(async () => {
    const bag = await readProviderBag();
    const snapshot = captureEngineSlice(bag, id);
    const applied = appliedProviderSeq(bag, id);
    const next = Math.max(applied, Number(bag.seq[id]) || 0) + 1;
    bag.applied[id] = applied;
    bag.seq[id] = next;
    bag.pending[id] = { seq: next, value: String(want ?? ""), sent: false };
    await chrome.storage.local.set({ [SECRET_STORAGE_KEY]: normalizeSecrets(bag) });
    return { id, seq: next, snapshot };
  });
}

async function rollbackReservation(reserved) {
  if (!reserved) return;
  await withSecretBagLock(async () => {
    const bag = await readProviderBag();
    if ((Number(bag.seq[reserved.id]) || 0) !== reserved.seq) return;
    const pending = bag.pending?.[reserved.id];
    if (pending && Number(pending.seq) !== reserved.seq) return;
    await chrome.storage.local.set({ [SECRET_STORAGE_KEY]: restoreEngineSlice(bag, reserved.snapshot) });
  });
}

async function commitLocalKey(id, want, seq) {
  await withSecretBagLock(async () => {
    const bag = await readProviderBag();
    if ((Number(bag.seq[id]) || 0) > seq) return;
    const pending = bag.pending?.[id];
    if (pending && Number(pending.seq) > seq) return;
    bag.providers[id] = want;
    bag.applied[id] = seq;
    bag.seq[id] = Math.max(Number(bag.seq[id]) || 0, seq);
    if (bag.pending?.[id] && Number(bag.pending[id].seq) <= seq) delete bag.pending[id];
    await chrome.storage.local.set({ [SECRET_STORAGE_KEY]: normalizeSecrets(bag) });
  });
}

const secretRepairs = new Set();

async function deliverSecretRepair(message) {
  let last = { ok: false };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!pageAlive()) return last;
    try {
      last = await chrome.runtime.sendMessage(message);
      if (last && last.ok !== false) return last;
    } catch {
      last = { ok: false };
    }
  }
  return last;
}

async function runSecretRepairs(repairs) {
  for (const item of repairs) {
    if (!pageAlive() || secretRepairs.has(item.id)) continue;
    secretRepairs.add(item.id);
    try {
      await withEngineLock(item.id, async () => {
        if (!pageAlive()) return;
        const bag = await readProviderBag();
        let syncKey = "";
        let syncSeq;
        try {
          const syncBag = await chrome.storage.sync.get("settings");
          const syncCfg = syncBag?.settings?.providers?.[item.id];
          syncKey = String(syncCfg?.apiKey || "");
          const recorded = Number(syncCfg?.oiAppliedSeq);
          if (Number.isFinite(recorded)) syncSeq = recorded;
        } catch {
          return;
        }
        const decision = decideKeyReconcile(bag, item.id, syncKey, syncSeq);
        if (decision.action !== item.action) return;
        if (decision.action === "writeSync" && decision.value !== item.value) return;
        const message = decision.action === "clearSync"
          ? {
              type: "OI_SAVE_SETTINGS",
              patch: { providers: { [item.id]: { apiKey: "", oiAppliedSeq: decision.seq } } },
              clear: { providers: [item.id] },
              keySeq: { [item.id]: decision.seq }
            }
          : {
              type: "OI_SAVE_SETTINGS",
              patch: { providers: { [item.id]: { apiKey: decision.value, oiAppliedSeq: decision.seq } } },
              keySeq: { [item.id]: decision.seq }
            };
        await deliverSecretRepair(message);
      });
    } finally {
      secretRepairs.delete(item.id);
    }
  }
}

async function reconcileOpenSecrets(skipIds = new Set()) {
  const repairs = [];
  const locked = await withSecretBagLock(async () => {
    const bag = await readProviderBag();
    let syncSettings = {};
    try {
      const syncBag = await chrome.storage.sync.get("settings");
      syncSettings = syncBag?.settings && typeof syncBag.settings === "object" ? syncBag.settings : {};
    } catch {
      return;
    }
    const ids = new Set([
      ...Object.keys(bag.providers || {}),
      ...Object.keys(bag.pending || {}),
      ...Object.keys(bag.applied || {}),
      ...Object.keys(syncSettings.providers || {})
    ]);
    let changed = false;
    for (const id of ids) {
      if (skipIds.has(id)) continue;
      const syncCfg = syncSettings.providers?.[id];
      const syncKey = String(syncCfg?.apiKey || "");
      const recorded = Number(syncCfg?.oiAppliedSeq);
      const decision = decideKeyReconcile(bag, id, syncKey, Number.isFinite(recorded) ? recorded : undefined);
      if (decision.action === "commit") {
        bag.providers[id] = decision.value;
        bag.applied[id] = decision.seq;
        bag.seq[id] = Math.max(Number(bag.seq[id]) || 0, decision.seq);
        if (bag.pending?.[id]) delete bag.pending[id];
        changed = true;
      } else if (decision.action === "dropPending") {
        if (bag.pending?.[id]) {
          delete bag.pending[id];
          changed = true;
        }
      } else if (decision.action === "clearSync" || decision.action === "writeSync") {
        repairs.push({ id, action: decision.action, value: decision.value, seq: decision.seq });
        const pending = bag.pending?.[id];
        if (pending && pending.sent !== true && String(pending.value ?? "") === "") {
          delete bag.pending[id];
          changed = true;
        }
      }
    }
    if (changed) await chrome.storage.local.set({ [SECRET_STORAGE_KEY]: normalizeSecrets(bag) });
    return { ok: true };
  }, { ifAvailable: true });
  if (!locked || locked.skipped || !pageAlive()) return;
  await runSecretRepairs(repairs);
}

async function overlayLocalKeyOpinion() {
  const bag = await readProviderBag();
  cachedSettings.providers = cachedSettings.providers || {};
  const ids = new Set([
    ...Object.keys(bag.providers || {}),
    ...Object.keys(bag.applied || {}),
    ...Object.keys(bag.pending || {})
  ]);
  for (const id of ids) {
    const opinion = Object.prototype.hasOwnProperty.call(bag.applied || {}, id) || Boolean(bag.pending?.[id]);
    const local = String(bag.providers[id] || "");
    if (!opinion && !local.trim()) continue;
    cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey: local });
  }
}

async function syncProviderKey(id) {
  try {
    const bag = await chrome.storage.sync.get("settings");
    return String(bag?.settings?.providers?.[id]?.apiKey || "");
  } catch {
    return null;
  }
}

async function verifyProviderKey(id, want, seq) {
  const local = await readProviderBag();
  const localKey = String(local.providers[id] || "");
  const applied = appliedProviderSeq(local, id);
  if (localKey === want && applied >= seq) return { ok: true, needsLocalCommit: false };
  const syncKey = await syncProviderKey(id);
  if (syncKey == null) return { ok: false };
  if (syncKey === want && applied < seq) return { ok: true, needsLocalCommit: true };
  return { ok: false };
}

async function markPendingSent(id, seq) {
  await withSecretBagLock(async () => {
    const bag = await readProviderBag();
    const pending = bag.pending?.[id];
    if (!pending || Number(pending.seq) !== seq) return;
    pending.sent = true;
    await chrome.storage.local.set({ [SECRET_STORAGE_KEY]: normalizeSecrets(bag) });
  });
}

async function sendProviderKey(id, apiKey, clear) {
  const res = await withEngineLock(id, () => sendProviderKeyLocked(id, apiKey, clear));
  if (pageAlive() && res && res.closed !== true && res.ok !== false) {
    try {
      await reconcileOpenSecrets();
    } catch {
      // The confirmed local key still paints. The next open compares sync again.
    }
  }
  return res;
}

async function sendProviderKeyLocked(id, apiKey, clear) {
  const want = clear ? "" : String(apiKey ?? "");
  let reserved = null;
  try {
    reserved = await reserveProviderSeq(id, want);
  } catch {
    return { ok: false };
  }
  if (!pageAlive()) return { ok: false, closed: true };
  try {
    await markPendingSent(id, reserved.seq);
  } catch {
    if (!pageAlive()) return { ok: false, closed: true };
    await rollbackReservation(reserved);
    return { ok: false };
  }
  if (!pageAlive()) return { ok: false, closed: true };
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "OI_SAVE_SETTINGS",
      patch: { providers: { [id]: { apiKey: want, oiAppliedSeq: reserved.seq } } },
      clear: clear ? { providers: [id] } : {},
      keySeq: { [id]: reserved.seq }
    });
  } catch {
    if (!pageAlive()) return { ok: false, closed: true };
    await rollbackReservation(reserved);
    return { ok: false };
  }
  if (!pageAlive()) return { ok: false, closed: true };
  if (!res || res.ok === false) {
    await rollbackReservation(reserved);
    return { ok: false };
  }
  const verified = await verifyProviderKey(id, want, reserved.seq);
  if (!pageAlive()) return { ok: false, closed: true };
  if (!verified.ok) {
    await rollbackReservation(reserved);
    return { ok: false };
  }
  if (verified.needsLocalCommit) {
    try {
      await commitLocalKey(id, want, reserved.seq);
    } catch {
      return { ok: false };
    }
  }
  if (!pageAlive()) return { ok: false, closed: true };
  return res;
}

function queueProviderKey(id, apiKey, clear, before, ticket) {
  return enqueueProviderKey(id, async () => {
    const res = await sendProviderKey(id, apiKey, clear);
    if (!ownsProviderKey(id, ticket) || !pageAlive() || res?.closed) return res;
    const want = clear ? "" : String(apiKey ?? "");
    cachedSettings.providers = cachedSettings.providers || {};
    let saved = Boolean(res?.ok);
    if (!saved) {
      try {
        await reconcileOpenSecrets();
        const bag = await readProviderBag();
        saved = String(bag.providers?.[id] || "") === want;
      } catch {
        saved = false;
      }
    }
    if (!pageAlive()) return res;
    if (!saved) {
      cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey: before });
      if (providerEdits.get(id) === apiKey) providerEdits.delete(id);
      renderProviderFields();
      showToast("密钥没保存上");
      return res;
    }
    if (clear) {
      cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey: "" });
      if (el("provider")?.value === id) invalidateTest("clear");
      const name = getProvider(id).name;
      showToast(`已移除 ${name} 密钥 · 撤销`, () => {
        cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey: before });
        providerEdits.set(id, before);
        renderProviderFields();
        const undoTicket = claimProviderKey(id);
        void queueProviderKey(id, before, false, "", undoTicket);
      });
      await clearProviderAttention(attentionArea(), id);
      return res;
    }
    if (providerEdits.get(id) === apiKey) providerEdits.delete(id);
    cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey });
    if (el("provider")?.value === id) providerSecretPaint?.();
    return res;
  });
}

function clearProviderKey(id) {
  const previous = (cachedSettings.providers?.[id] || {}).apiKey || "";
  providerEdits.delete(id);
  cachedSettings.providers = cachedSettings.providers || {};
  cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey: "" });
  const ticket = claimProviderKey(id);
  renderProviderFields();
  void queueProviderKey(id, "", true, previous, ticket);
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

function persist(control) {
  return enqueueSave(() => withEngineLocks(Object.keys(cachedSettings.providers || {}), () => persistNow(control)));
}

async function persistNow(control) {
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
  const pendingPdf = pdfCloudEdit;
  const keptKeys = new Map();
  for (const [id, cfg] of Object.entries(cachedSettings.providers || {})) {
    if (providerEdits.has(id) || providerKeyHold.has(id)) keptKeys.set(id, cfg?.apiKey ?? "");
  }
  writing = true;
  try {
    const sealed = await sealOutgoingPatch(patch);
    const res = await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: sealed });
    if (!res || res.ok === false) {
      const attempt = snapshotControl(control);
      cachedSettings = before;
      pdfCloudKey = beforePdf;
      for (const [id, apiKey] of keptKeys) {
        cachedSettings.providers = cachedSettings.providers || {};
        cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey });
      }
      restoreControl(control);
      showMiss(control, () => {
        applySnapshot(attempt);
        void persist(control);
      });
      return;
    }
    cachedSettings = JSON.parse(JSON.stringify(res.settings || cachedSettings));
    cachedSettings.providers = cachedSettings.providers || {};
    for (const [id, apiKey] of keptKeys) {
      cachedSettings.providers[id] = Object.assign({}, cachedSettings.providers[id] || {}, { apiKey });
    }
    if (pdfCloudEdit === pendingPdf) pdfCloudEdit = null;
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
  const savedProbe = formulaSaved?.multimodal?.probe ?? null;
  const view = {
    ...formulaSettings,
    multimodal: { ...formulaSettings.multimodal, probe: savedProbe }
  };
  renderFormulaPanel(root, view, {
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

function formulaProbeFingerprint(settings) {
  const mm = settings?.multimodal || {};
  const ocr = settings?.ocr || {};
  return [
    mm.provider,
    mm.model,
    mm.baseUrl,
    mm.apiKey,
    formulaSecretEpoch.multimodal,
    ocr.provider,
    ocr.apiKey,
    formulaSecretEpoch.ocr
  ].join("\n");
}

function releaseProbeButtons() {
  const root = el("formulaSettingsRoot");
  if (!root) return;
  for (const button of root.querySelectorAll("[data-formula-action]")) {
    button.removeAttribute("data-busy");
    const spin = button.querySelector(".oi-set-spin");
    spin?.remove();
    button.textContent = "测试连通";
  }
  syncFormulaDerived();
}

function invalidateFormulaProbe() {
  formulaProbeCtl.drop();
  const wasBusy = formulaBusy !== "";
  formulaBusy = "";
  if (wasBusy) releaseProbeButtons();
}

function clearFormulaProbeChrome(which) {
  const root = el("formulaSettingsRoot");
  const id = which === "ocr" ? "ocr" : "mm";
  const card = root?.querySelector?.(`[data-formula-card="${id}"]`);
  if (!card) return;
  for (const node of [...card.querySelectorAll(".oi-set-chip, .oi-set-probe-summary")]) {
    node.parentNode?.removeChild(node);
  }
}

function queueFormulaWrite({ rerender = false, clearProbe = "" } = {}) {
  const job = formulaWrite.then(() => flushCommitted({ rerender, clearProbe }));
  formulaWrite = job.catch(() => {});
  return job;
}

async function flushCommitted({ rerender = false, clearProbe = "" } = {}) {
  formulaWriting = true;
  formulaExternal = null;
  const snapshot = formulaCommitted;
  const storage = globalThis.chrome?.storage?.local;
  const wrapped = storage && {
    get: (key) => storage.get(key),
    set: (patch) => {
      if (patch && Object.prototype.hasOwnProperty.call(patch, FORMULA_SETTINGS_KEY)) {
        formulaEchoKey = JSON.stringify(patch[FORMULA_SETTINGS_KEY]);
      }
      return storage.set(patch);
    }
  };
  let failed = false;
  try {
    const saved = await writeFormulaSettings(snapshot, wrapped || storage);
    if (formulaExternal) {
      const incoming = formulaExternal;
      formulaExternal = null;
      formulaWriting = false;
      adoptFormulaRecord(incoming);
      return;
    }
    formulaSaved = saved;
    if (formulaCommitted === snapshot) formulaCommitted = saved;
    formulaUndo = null;
    hideFormulaMiss();
  } catch (err) {
    failed = true;
    formulaUndo = err?.code === "base-url-required" ? null : snapshot;
    if (formulaCommitted === snapshot) {
      formulaCommitted = formulaSaved;
      formulaSettings = formulaSaved;
      paintFormulaSettings();
    }
    showFormulaMiss();
  } finally {
    formulaWriting = false;
  }
  if (failed) return;
  if (rerender) paintFormulaSettings();
  else if (clearProbe) clearFormulaProbeChrome(clearProbe);
}

function updateFormulaPart(which, patch, opts = {}) {
  const watch = ["provider", "apiKey", "model", "baseUrl", "customModel"];
  if (watch.some((key) => Object.prototype.hasOwnProperty.call(patch || {}, key))) invalidateFormulaProbe();
  // The provider control echoes the on-screen Base URL. That echo is the draft.
  // A vendor switch keeps the last committed URL, or clears it for a fixed vendor.
  if (
    !opts.live
    && patch
    && which !== "ocr"
    && Object.prototype.hasOwnProperty.call(patch, "provider")
    && Object.prototype.hasOwnProperty.call(patch, "baseUrl")
  ) {
    patch = {
      ...patch,
      baseUrl: patch.provider === "custom" ? String(formulaCommitted?.multimodal?.baseUrl ?? "") : ""
    };
  }
  formulaSettings = applyFormulaPart(formulaSettings, which, patch);
  // Interrupt: each keystroke updates the draft only. The chip stays with storage until change.
  if (opts.live) {
    syncFormulaDerived();
    return;
  }
  const part = which === "ocr" ? "ocr" : "multimodal";
  // Interrupt: a key commit writes that key onto the committed card and drops 「已连通」.
  // A blank field is not a commit. The same key again still counts.
  if (Object.prototype.hasOwnProperty.call(patch || {}, "apiKey")) {
    if (!String(patch.apiKey ?? "").trim()) return;
    formulaSecretEpoch[part] += 1;
    // An unsaved「自定义」cannot be stored. The key lands on the last stored card.
    const base = customBaseUrlError(formulaCommitted) ? formulaSaved : formulaCommitted;
    formulaCommitted = applyFormulaPart(base, which, { apiKey: patch.apiKey });
    return queueFormulaWrite({ clearProbe: part });
  }
  const beforeMm = formulaCommitted.multimodal;
  const next = applyFormulaPart(formulaCommitted, which, patch);
  if (customBaseUrlError(next)) {
    // Choosing 自定义 with no URL stays on screen and is not stored. A later
    // switch then snaps back, so the previous vendor's tier 2 is not turned on.
    const enteringUnusableCustom = Object.prototype.hasOwnProperty.call(patch || {}, "provider")
      && next.multimodal.provider === "custom"
      && !customBaseUrlError(formulaCommitted);
    if (enteringUnusableCustom) {
      formulaCommitted = next;
      formulaEchoKey = "";
      paintFormulaSettings();
      return;
    }
    // A blank Base URL stays on screen so the inline 「请填写 Base URL」 remains.
    // A non-empty refused URL rolls back to the stored value and shows 没保存上.
    if (Object.prototype.hasOwnProperty.call(patch || {}, "baseUrl") && !String(patch.baseUrl ?? "").trim()) {
      paintFormulaSettings();
      return;
    }
    const committedMm = formulaCommitted.multimodal;
    formulaSettings = {
      ...formulaSettings,
      multimodal: {
        ...formulaSettings.multimodal,
        provider: committedMm.provider,
        model: committedMm.model,
        customModel: committedMm.customModel,
        baseUrl: committedMm.baseUrl
      }
    };
    showFormulaMiss();
    paintFormulaSettings();
    return;
  }
  const afterMm = next.multimodal;
  const structural = Object.prototype.hasOwnProperty.call(patch, "provider")
    || Object.prototype.hasOwnProperty.call(patch, "customModel");
  const beforeProbe = beforeMm?.probe || null;
  const afterProbe = afterMm?.probe || null;
  const probeChanged = (beforeProbe?.chip || "") !== (afterProbe?.chip || "")
    || (beforeProbe?.at || 0) !== (afterProbe?.at || 0);
  formulaCommitted = next;
  return queueFormulaWrite({ rerender: structural || probeChanged });
}

async function updateFormulaSwitch(key, enabled) {
  invalidateFormulaProbe();
  const onScreen = acceptStoredFormulaSettings({ ...formulaSettings, [key]: enabled === true });
  if (customBaseUrlError(onScreen)) {
    // An unsaved「自定义」with no URL must not turn the previous vendor's switch on.
    const sameUnusableCard = customBaseUrlError(formulaSaved)
      && formulaSaved.multimodal.provider === onScreen.multimodal.provider;
    if (!sameUnusableCard) {
      formulaSettings = formulaSaved;
      formulaCommitted = formulaSaved;
      formulaEchoKey = "";
      paintFormulaSettings();
      return;
    }
  }
  formulaCommitted = acceptStoredFormulaSettings({ ...formulaCommitted, [key]: enabled === true });
  formulaSettings = acceptStoredFormulaSettings({ ...formulaSettings, [key]: enabled === true });
  await queueFormulaWrite({ rerender: true });
}

async function removeFormulaSecret(which) {
  invalidateFormulaProbe();
  const part = which === "ocr" ? "ocr" : "multimodal";
  formulaSecretEpoch[part] += 1;
  const memorySnapshot = formulaSettings;
  const committedSnapshot = formulaCommitted;
  formulaSettings = removeFormulaKey(formulaSettings, which);
  formulaCommitted = removeFormulaKey(formulaCommitted, which);
  paintFormulaSettings();
  await queueFormulaWrite({ clearProbe: part });
  const name = which === "ocr" ? "OCR" : "多模态";
  showToast(`已移除 ${name} 密钥 · 撤销`, async () => {
    // Interrupt: undo lands while a later probe is still in flight.
    invalidateFormulaProbe();
    formulaSettings = memorySnapshot;
    formulaCommitted = committedSnapshot;
    await queueFormulaWrite({ rerender: true });
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
        formulaCommitted = formulaUndo;
        formulaSettings = formulaUndo;
      }
      void queueFormulaWrite({ rerender: true });
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

function adoptFormulaRecord(stored) {
  // The echo key is only the record this tab just wrote. Adopting someone
  // else's card retires that key, or a later write of the old record is ignored.
  formulaEchoKey = JSON.stringify(stored);
  formulaSettings = stored;
  formulaSaved = stored;
  formulaCommitted = stored;
  invalidateFormulaProbe();
  paintFormulaSettings();
}

/** A throw that escapes the probe is not a network error. Chip stays 「暂不可用」. */
export function classifyUnexpectedProbe(err) {
  if (err?.code === "real-network-in-test") throw err;
  return classifyFormulaProbe({ ok: false, code: "http", summary: "请求失败" });
}

async function testFormulaConnection(kind) {
  if (formulaBusy) return;
  const which = kind === "ocr" ? "ocr" : "multimodal";
  // Keystrokes stay on formulaSettings. The probe and its write use the last commit.
  const cardSource = formulaCommitted;
  if (which === "multimodal" && (multimodalTestDisabled(cardSource) || customBaseUrlError(cardSource))) return;
  const fingerprint = formulaProbeFingerprint(cardSource);
  const run = formulaProbeCtl.open();
  formulaBusy = which === "ocr" ? "ocr" : "mm";
  paintFormulaSettings();
  const card = cardSource[which];
  // Interrupt: a key commit bumps formulaSecretEpoch even when the text is unchanged.
  // A result that arrives afterwards fails this check and is not written.
  const still = () => run.current() && formulaProbeFingerprint(formulaCommitted) === fingerprint;
  let probe;
  try {
    probe = which === "multimodal"
      ? await probeMultimodal(cardSource, {
        signal: run.signal,
        stillCurrent: still,
        secret: card.apiKey
      })
      : await runFormulaProbe({
        kind: which,
        provider: card.provider,
        model: card.model,
        baseUrl: card.baseUrl || "",
        apiKey: card.apiKey
      }, stubFormulaProbe);
  } catch (err) {
    probe = classifyUnexpectedProbe(err);
  }
  // Interrupt: the result is in hand. A settings change queued on this turn
  // must be visible to still() before anything is written.
  await Promise.resolve();
  await Promise.resolve();
  const settled = which === "multimodal"
    ? settleProbeResult(formulaCommitted, probe, { still: still() })
    : { write: still() && probe?.code !== "aborted", settings: normalizeFormulaSettings({
      ...formulaCommitted,
      [which]: { ...formulaCommitted[which], probe }
    }) };
  if (!settled.write) {
    if (run.current() && formulaProbeFingerprint(formulaCommitted) === fingerprint) {
      formulaBusy = "";
      paintFormulaSettings();
    }
    return;
  }
  formulaCommitted = settled.settings;
  const part = which === "ocr" ? "ocr" : "multimodal";
  formulaSettings = {
    ...formulaSettings,
    [part]: { ...(formulaSettings[part] || {}), probe: settled.settings[part]?.probe ?? null }
  };
  formulaBusy = "";
  await queueFormulaWrite({ rerender: true });
}

function bindFormulaSettings() {
  const storage = globalThis.chrome?.storage;
  window.addEventListener("pagehide", () => invalidateFormulaProbe());
  storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[FORMULA_SETTINGS_KEY]) return;
    const raw = changes[FORMULA_SETTINGS_KEY].newValue;
    const rawJson = JSON.stringify(raw);
    if (formulaEchoKey && rawJson === formulaEchoKey) {
      // This tab already wrote the record. If the chip is still the old 「已连通」, drop it
      // without repainting, so an open Base URL draft stays put.
      const shown = document.querySelector("[data-formula-card='mm'] .oi-set-chip");
      if (!raw?.multimodal?.probe && shown) clearFormulaProbeChrome("multimodal");
      const ocrShown = document.querySelector("[data-formula-card='ocr'] .oi-set-chip");
      if (!raw?.ocr?.probe && ocrShown) clearFormulaProbeChrome("ocr");
      return;
    }
    const incoming = acceptStoredFormulaSettings(raw);
    if (formulaWriting) {
      formulaExternal = incoming;
      return;
    }
    adoptFormulaRecord(incoming);
  });
  readFormulaSettings(storage?.local).then((stored) => {
    formulaSettings = stored;
    formulaSaved = stored;
    formulaCommitted = stored;
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
  if (!root || dataPanel) return;
  const parsed = parseSettingsHash(location.hash);
  dataPanel = mountDataPanel(root, {
    store: sharedLibraryStore(),
    focus: parsed.id === "data" ? (parsed.focus || null) : null,
    history,
    hash: "#data",
    openData({ focus: next }) {
      showPage("data", next || "import");
    },
    download(filename, text) {
      return downloadBlob(filename, new Blob([text], { type: "application/json" })) === true;
    }
  });
  dataPanel.coordinator?.subscribe?.(() => refreshBadges());
  window.addEventListener("pagehide", () => {
    stopSecretPage();
    void dataPanel?.closeData?.();
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
  if (data) data.hidden = dataPanel?.state?.()?.phase !== "incomplete";
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
    const name = focusOf[q];
    const group = document.querySelector(`[data-focus-group="${name}"]`) || document.querySelector(`[data-focus="${name}"]`);
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
    const group = document.querySelector(`[data-focus-group="${focus}"]`) || document.querySelector(`[data-focus="${focus}"]`);
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
