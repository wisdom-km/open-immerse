/**
 * Formula fallback switches and model settings.
 * Keys live in chrome.storage.local. Translation models stay in sync settings.
 * Probes do not use the network. F7 and F9 replace the stub.
 */

export const FORMULA_SETTINGS_KEY = "formulaSettings";
export const FORMULA_SETTINGS_AREA = "local";

export const FORMULA_SWITCH_KEYS = Object.freeze({
  tier2: "formula.tier2.enabled",
  ocr: "formula.ocr.enabled",
  tier3: "formula.tier3.enabled"
});

export const FORMULA_PRIVACY_NOTE = "认不出的公式会把单张裁图发给模型，按次计费。不上传整页 PDF。密钥只存本机。行内公式和行间公式共用这一开关。";
export const FORMULA_OCR_NOTE = "只上传单个公式的裁图，不上传整页 PDF。密钥只存本机。";
export const FORMULA_MM_EMPTY = "填好后，下方会出现『用多模态模型补全公式』开关";

export const FORMULA_SWITCH_COPY = Object.freeze({
  tier2: {
    title: "用多模态模型补全公式",
    note: "行内公式和行间公式都走这一级，不另设开关。"
  },
  ocr: {
    title: "用 OCR 补全公式",
    note: "和多模态开关互相独立。"
  },
  tier3: {
    title: "认不好时显示占位",
    note: "裁图没过检查，或被强制改用裁图但仍不合格时，打开就显示占位，关掉仍显示裁图。"
  }
});

export const FORMULA_ORDER = Object.freeze([
  { id: "arxiv", label: "arXiv 源码" },
  { id: "multimodal", label: "多模态" },
  { id: "ocr", label: "OCR" },
  { id: "self", label: "自研识别" },
  { id: "vector", label: "矢量重绘" },
  { id: "crop", label: "裁图" },
  { id: "placeholder", label: "占位" }
]);

const ORDER_MARKS = ["①", "②", "③", "④", "⑤", "⑥", "⑦"];
const BUILTIN_TIERS = new Set(["self", "vector", "crop"]);

export const MULTIMODAL_PROVIDERS = Object.freeze([
  { id: "openai", label: "OpenAI", vision: true, models: ["gpt-4o", "gpt-4o-mini"] },
  { id: "gemini", label: "Gemini", vision: true, models: ["gemini-2.0-flash"] },
  { id: "deepseek", label: "DeepSeek", vision: false, unavailable: "DeepSeek · 暂不可用（不能看图）" },
  { id: "doubao", label: "豆包", vision: true, models: ["doubao-1.5-vision-pro"] },
  { id: "kimi", label: "Kimi", vision: true, models: ["kimi-k2.5"] },
  { id: "grok", label: "Grok", vision: true, models: ["grok-4"] },
  { id: "custom", label: "自定义兼容端点", vision: true, models: [], baseUrlRequired: true }
]);

export const OCR_PROVIDERS = Object.freeze([
  { id: "zhipu", label: "智谱 GLM-OCR", vision: true },
  { id: "baidu", label: "百度", vision: true },
  { id: "other", label: "其他（待定）", vision: false, disabled: true }
]);

export function defaultFormulaSettings() {
  return {
    [FORMULA_SWITCH_KEYS.tier2]: false,
    [FORMULA_SWITCH_KEYS.ocr]: false,
    [FORMULA_SWITCH_KEYS.tier3]: false,
    multimodal: { provider: "", apiKey: "", model: "", customModel: false, baseUrl: "", probe: null },
    ocr: { provider: "", apiKey: "", probe: null }
  };
}

export function formulaOrderText() {
  return FORMULA_ORDER.map((item, index) => `${ORDER_MARKS[index]} ${item.label}`).join(" → ");
}

export function clipProbeSummary(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (raw.length <= 80) return raw;
  return raw.slice(0, 80);
}

export function probeClock(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function providerList(list, id) {
  return list.find((item) => item.id === id) || null;
}

export function multimodalProvider(id) {
  return providerList(MULTIMODAL_PROVIDERS, id);
}

export function ocrProvider(id) {
  return providerList(OCR_PROVIDERS, id);
}

function cleanProbe(probe) {
  if (!probe || typeof probe !== "object") return null;
  const chip = String(probe.chip || "").trim();
  if (!chip) return null;
  const at = Number(probe.at);
  return {
    ok: probe.ok === true,
    chip,
    code: String(probe.code || ""),
    summary: clipProbeSummary(probe.summary),
    at: Number.isFinite(at) ? at : 0
  };
}

/** Drop one stored key. Empty commits still go through applyFormulaPart and keep it. */
export function removeFormulaKey(settings, which) {
  const stored = normalizeFormulaSettings(settings);
  const part = which === "ocr" ? "ocr" : "multimodal";
  return normalizeFormulaSettings({
    ...stored,
    [part]: { ...stored[part], apiKey: "" }
  });
}

/** Empty key input means "leave the stored key". A non-empty value replaces it. */
export function applyFormulaPart(settings, which, patch) {
  const stored = normalizeFormulaSettings(settings);
  const part = which === "ocr" ? "ocr" : "multimodal";
  const incoming = patch && typeof patch === "object" ? { ...patch } : {};
  if (Object.prototype.hasOwnProperty.call(incoming, "apiKey") && !String(incoming.apiKey ?? "").trim()) {
    delete incoming.apiKey;
  }
  return normalizeFormulaSettings({
    ...stored,
    [part]: { ...stored[part], ...incoming }
  });
}

export function normalizeFormulaSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const mm = src.multimodal && typeof src.multimodal === "object" ? src.multimodal : {};
  const ocr = src.ocr && typeof src.ocr === "object" ? src.ocr : {};
  const mmProvider = multimodalProvider(mm.provider);
  const ocrSpec = ocrProvider(ocr.provider);
  return {
    [FORMULA_SWITCH_KEYS.tier2]: src[FORMULA_SWITCH_KEYS.tier2] === true,
    [FORMULA_SWITCH_KEYS.ocr]: src[FORMULA_SWITCH_KEYS.ocr] === true,
    [FORMULA_SWITCH_KEYS.tier3]: src[FORMULA_SWITCH_KEYS.tier3] === true,
    multimodal: {
      provider: mmProvider ? mmProvider.id : "",
      apiKey: String(mm.apiKey || ""),
      model: String(mm.model || "").trim(),
      customModel: mm.customModel === true || mmProvider?.baseUrlRequired === true,
      baseUrl: String(mm.baseUrl || "").trim(),
      probe: cleanProbe(mm.probe)
    },
    ocr: {
      provider: ocrSpec ? ocrSpec.id : "",
      apiKey: String(ocr.apiKey || ""),
      probe: cleanProbe(ocr.probe)
    }
  };
}

export function multimodalReady(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = multimodalProvider(stored.multimodal.provider);
  if (!provider || provider.vision !== true) return false;
  return stored.multimodal.apiKey.trim() !== "";
}

export function ocrReady(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = ocrProvider(stored.ocr.provider);
  if (!provider || provider.vision !== true) return false;
  return stored.ocr.apiKey.trim() !== "";
}

export function tierActive(id, settings, extra = {}) {
  const stored = normalizeFormulaSettings(settings);
  if (BUILTIN_TIERS.has(id)) return true;
  if (id === "arxiv") return extra.arxivEnabled === true;
  if (id === "multimodal") return multimodalReady(stored) && stored[FORMULA_SWITCH_KEYS.tier2] === true;
  if (id === "ocr") return ocrReady(stored) && stored[FORMULA_SWITCH_KEYS.ocr] === true;
  if (id === "placeholder") return stored[FORMULA_SWITCH_KEYS.tier3] === true;
  return false;
}

function switchHidden(kind, provider, key) {
  if (provider && provider.vision === false && provider.disabled !== true) {
    return {
      visible: false,
      message: "当前厂家不支持看图，请换厂家",
      configure: false,
      target: kind
    };
  }
  if (!provider || provider.vision !== true || !String(key || "").trim()) {
    const name = kind === "ocr" ? " OCR" : "多模态模型";
    return {
      visible: false,
      message: `需先配置${name}`,
      configure: true,
      target: kind
    };
  }
  return { visible: true, message: "", configure: false, target: kind };
}

export function tier2SwitchState(settings) {
  const stored = normalizeFormulaSettings(settings);
  return switchHidden("mm", multimodalProvider(stored.multimodal.provider), stored.multimodal.apiKey);
}

export function ocrSwitchState(settings) {
  const stored = normalizeFormulaSettings(settings);
  return switchHidden("ocr", ocrProvider(stored.ocr.provider), stored.ocr.apiKey);
}

export function multimodalTestDisabled(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = multimodalProvider(stored.multimodal.provider);
  if (!provider || provider.vision !== true) return true;
  if (provider.baseUrlRequired && !stored.multimodal.baseUrl) return true;
  return false;
}

export function ocrTestDisabled(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = ocrProvider(stored.ocr.provider);
  return !provider || provider.vision !== true;
}

export function modelChoice(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = multimodalProvider(stored.multimodal.provider);
  const model = stored.multimodal.model;
  if (provider?.baseUrlRequired) return { mode: "text", select: "", custom: model };
  const presets = provider?.models || [];
  if (stored.multimodal.customModel || (model && !presets.includes(model))) {
    return { mode: "select", select: "__custom", custom: presets.includes(model) ? "" : model };
  }
  if (presets.includes(model)) return { mode: "select", select: model, custom: "" };
  return { mode: "select", select: "", custom: "" };
}

export function classifyFormulaProbe(raw, at = Date.now()) {
  const summary = clipProbeSummary(raw?.summary || raw?.error || "");
  const status = Number(raw?.status);
  const code = String(raw?.code || "");
  const fail = (chip, failCode) => ({ ok: false, chip, code: failCode, summary, at });
  if (raw?.sawImage === false || code === "no-vision") return fail("这个模型不能看图", "no-vision");
  if (status === 401) return fail("密钥无效 (401)", "401");
  if (status === 403) return fail("无权限 (403)", "403");
  if (status === 404) return fail("地址或模型不对 (404)", "404");
  if (status === 429) return fail("额度或限流 (429)", "429");
  if (code === "timeout" || status === 408) return fail("超时", "timeout");
  if (raw?.ok === true) return { ok: true, chip: "已连通", code: "ok", summary: "", at };
  return fail("暂不可用", code || "unavailable");
}

/** Default probe. No request is sent. */
export async function stubFormulaProbe() {
  return { ok: false, code: "unavailable", summary: "这一级还没接上" };
}

export async function runFormulaProbe(config, impl = stubFormulaProbe, at = Date.now()) {
  const raw = await impl(config);
  return classifyFormulaProbe(raw || { ok: false, code: "unavailable" }, at);
}

export function formulaChainFlags(settings, extra = {}) {
  const stored = normalizeFormulaSettings(settings);
  const mmReady = multimodalReady(stored);
  const readyOcr = ocrReady(stored);
  return {
    arxivEnabled: extra.arxivEnabled === true,
    multimodalEnabled: stored[FORMULA_SWITCH_KEYS.tier2] === true && mmReady,
    multimodalConfigured: mmReady,
    ocrEnabled: stored[FORMULA_SWITCH_KEYS.ocr] === true && readyOcr,
    ocrConfigured: readyOcr,
    placeholderEnabled: stored[FORMULA_SWITCH_KEYS.tier3] === true
  };
}

const FORMULA_VISIBLE = Object.freeze(["点击查看原公式", "看原公式", "原公式"]);
const FIGURE_VISIBLE = Object.freeze(["点击查看原图", "看原图", "原图"]);

function placeholderNumber(block) {
  return String(block?.eqLabel || block?.equationNumber || block?.figureLabel || "")
    .trim()
    .replace(/^\(|\)$/g, "");
}

/**
 * Visible lines stay on the button. The number and the page stay in aria
 * and title only. kind "figure" is copy only; the figure pipeline is separate.
 */
export function placeholderCopy(block, { inline = false, kind = "formula" } = {}) {
  const figure = kind === "figure";
  const visible = figure ? FIGURE_VISIBLE : FORMULA_VISIBLE;
  const page = Number(block?.page);
  const known = Number.isFinite(page) && page >= 1;
  const n = known ? Math.floor(page) : 0;
  const num = placeholderNumber(block);
  let head = "公式";
  if (figure) head = num ? `图 ${num}` : "图";
  else if (inline) head = "行内公式";
  else if (num) head = `公式 (${num})`;
  const parts = [head];
  if (known) parts.push(`原文第 ${n} 页`);
  parts.push(visible[0]);
  return { visible: visible.slice(), aria: parts.join(" · ") };
}

export async function readFormulaSettings(storage) {
  if (!storage || typeof storage.get !== "function") return defaultFormulaSettings();
  const bag = await storage.get(FORMULA_SETTINGS_KEY);
  const raw = bag && typeof bag === "object" ? bag[FORMULA_SETTINGS_KEY] : null;
  return normalizeFormulaSettings(raw);
}

export async function writeFormulaSettings(settings, storage) {
  const next = normalizeFormulaSettings(settings);
  if (storage && typeof storage.set === "function") {
    await storage.set({ [FORMULA_SETTINGS_KEY]: next });
  }
  return next;
}
