/**
 * Formula fallback switches and model settings.
 * Keys live in chrome.storage.local. Translation models stay in sync settings.
 * This module classifies probe results. The multimodal network probe lives in
 * lib/mm-probe.js and calls sendVision. OCR stays on the stub until F9.
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
export const FORMULA_BASE_URL_NOTE = "不要把密钥写进地址。路径里的密钥无法识别，也不会被去掉。";
/** Flat-rate Ark plan. A pay-as-you-go key can be pointed at ARK_DIRECT_BASE_URL by hand. */
export const ARK_PLAN_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
export const ARK_DIRECT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const FORMULA_ARK_BASE_NOTE = "默认是编码计划地址。按量密钥可改成 https://ark.cn-beijing.volces.com/api/v3。";
export const CUSTOM_BASE_URL_ERROR = "请填写 Base URL";

/** Shown on a card that has a vendor and no key. Not a probe failure. */
export const EMPTY_KEY_HINT = "请先填写密钥";

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

/**
 * Presets checked against public docs on 2026-10-17. One or two live model
 * ids each; the settings field still accepts a typed model string.
 * DeepSeek's preset is documentary only. Wisdom 2026-10-17: this PR marks it
 * 「待实测」 (`vision: false`) until a PR2 live probe passes. It is not offered
 * as a vision provider before that.
 * ask-route.js and the translation Gemini default stay on gemini-2.0-flash.
 */
export const MULTIMODAL_PROVIDERS = Object.freeze([
  {
    id: "openai",
    label: "OpenAI",
    vision: true,
    models: ["gpt-5.6-luna", "gpt-5.4-mini"],
    baseUrl: "https://api.openai.com/v1",
    shape: "openai"
  },
  {
    id: "gemini",
    label: "Gemini",
    vision: true,
    models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    shape: "gemini"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    vision: false,
    visionBasis: "docs",
    unavailable: "DeepSeek · 待实测",
    models: ["deepseek-flash"],
    baseUrl: "https://api.deepseek.com",
    shape: "openai"
  },
  {
    id: "doubao",
    label: "豆包",
    vision: true,
    // v1 Ark presets (2026-10-24): glm-5.3-flash is the default, deepseek-v4.1-flash
    // is the other choice. Both use the plan endpoint. A stored Base URL is left as written.
    models: ["glm-5.3-flash", "deepseek-v4.1-flash"],
    baseUrl: ARK_PLAN_BASE_URL,
    shape: "openai"
  },
  {
    id: "kimi",
    label: "Kimi",
    vision: true,
    models: ["kimi-k3", "kimi-k2.6"],
    baseUrl: "https://api.moonshot.cn/v1",
    shape: "openai"
  },
  {
    id: "grok",
    label: "Grok",
    vision: true,
    models: ["grok-4.7", "grok-4"],
    baseUrl: "https://api.x.ai/v1",
    shape: "openai"
  },
  {
    id: "qwen",
    label: "千问",
    vision: true,
    models: ["qwen3-vl-plus", "qwen3-vl-flash"],
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    shape: "openai"
  },
  { id: "custom", label: "自定义兼容端点", vision: true, models: [], baseUrlRequired: true, shape: "openai" }
]);

export const OCR_PROVIDERS = Object.freeze([
  { id: "zhipu", label: "智谱 GLM-OCR", vision: true },
  { id: "baidu", label: "百度", vision: true },
  { id: "other", label: "其他（待定）", vision: false, disabled: true }
]);

/** Settings written before glm was the Ark default. An empty doubao model meant this id. */
export const LEGACY_DOUBAO_MODEL = "doubao-seed-2-1-pro-260915";
export const MM_PRESET_GENERATION = 2;

export function defaultFormulaSettings() {
  return {
    [FORMULA_SWITCH_KEYS.tier2]: false,
    [FORMULA_SWITCH_KEYS.ocr]: false,
    [FORMULA_SWITCH_KEYS.tier3]: false,
    multimodal: {
      provider: "doubao",
      apiKey: "",
      model: "glm-5.3-flash",
      customModel: false,
      baseUrl: "",
      probe: null,
      presetGeneration: MM_PRESET_GENERATION
    },
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

/**
 * A vendor can be the effective multimodal provider only after it is marked
 * able to see images. DeepSeek stays `vision: false` («待实测») until Wisdom
 * approves a live key budget and a real probe passes. This PR does not flip it.
 */
export function isProvenVisionProvider(id) {
  const spec = multimodalProvider(id);
  return spec?.vision === true;
}

export function ocrProvider(id) {
  return providerList(OCR_PROVIDERS, id);
}

function cleanProbe(probe, secret) {
  if (!probe || typeof probe !== "object") return null;
  const chip = String(probe.chip || "").trim();
  if (!chip) return null;
  const at = Number(probe.at);
  return {
    ok: probe.ok === true,
    chip,
    code: String(probe.code || ""),
    summary: clipProbeSummary(redactProbeText(probe.summary, secret)),
    at: Number.isFinite(at) ? at : 0
  };
}

/** Grey 「待测试」 after a key is saved. No clock. Not a failure. */
export function pendingProbe() {
  return { ok: false, chip: "待测试", code: "pending", summary: "", at: 0 };
}

/** Drop one stored key and that card's connectivity. Empty commits still go through applyFormulaPart and keep the key. */
export function removeFormulaKey(settings, which) {
  const stored = normalizeFormulaSettings(settings);
  const part = which === "ocr" ? "ocr" : "multimodal";
  return normalizeFormulaSettings({
    ...stored,
    [part]: { ...stored[part], apiKey: "", probe: null }
  });
}

/** Empty key input means "leave the stored key". A non-empty value replaces it. */
export function applyFormulaPart(settings, which, patch) {
  const stored = acceptStoredFormulaSettings(settings);
  const part = which === "ocr" ? "ocr" : "multimodal";
  const incoming = patch && typeof patch === "object" ? { ...patch } : {};
  if (Object.prototype.hasOwnProperty.call(incoming, "apiKey") && !String(incoming.apiKey ?? "").trim()) {
    delete incoming.apiKey;
  }
  // Interrupt: the patch is in hand and has not been merged. An unproven
  // vendor is refused here, before it can replace the previous provider.
  if (part === "multimodal" && Object.prototype.hasOwnProperty.call(incoming, "provider")) {
    const id = String(incoming.provider || "");
    if (id && !isProvenVisionProvider(id)) return stored;
  }
  // Interrupt: provider, model, Base URL, or a key commit (including the same
  // key again) and the old 「已连通」 is still on the card. Wisdom 2026-10-18:
  // saving a key always requires a new successful probe, and the card shows 「待测试」.
  const providerChanged = part === "multimodal"
    && Object.prototype.hasOwnProperty.call(incoming, "provider")
    && String(incoming.provider || "") !== stored.multimodal.provider;
  const modelChanged = part === "multimodal"
    && Object.prototype.hasOwnProperty.call(incoming, "model")
    && String(incoming.model || "").trim() !== stored.multimodal.model;
  const baseUrlChanged = part === "multimodal"
    && Object.prototype.hasOwnProperty.call(incoming, "baseUrl")
    && normalizedBaseUrl(incoming.baseUrl) !== normalizedBaseUrl(stored.multimodal.baseUrl);
  const keyCommit = Object.prototype.hasOwnProperty.call(incoming, "apiKey");
  const next = acceptStoredFormulaSettings({
    ...stored,
    [part]: { ...stored[part], ...incoming }
  });
  if (providerChanged || modelChanged || baseUrlChanged) {
    return { ...next, multimodal: { ...next.multimodal, probe: null } };
  }
  if (keyCommit) return { ...next, [part]: { ...next[part], probe: pendingProbe() } };
  return next;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A 1–5 character needle matches inside ordinary words and garbles the summary.
 * Six-character keys still redact: existing clients store keys of that length.
 */
const MIN_REDACT_LENGTH = 6;

function bearerToken(secret) {
  const trimmed = String(secret ?? "").trim();
  const colon = /^(?:bearer|token)\s*[:：]\s*(\S+)/iu.exec(trimmed);
  if (colon) return colon[1];
  const plain = /^(?:bearer|token)\s+(\S+)/i.exec(trimmed);
  return plain ? plain[1] : "";
}

/** Case-insensitive. `Bearer tok`, `Bearer:tok`, `Bearer : tok`, and fullwidth `Bearer：tok` also redact the bare token. */
export function redactProbeText(text, secret) {
  let raw = String(text || "");
  const needles = [];
  const add = (value) => {
    const item = String(value || "");
    if (item.length < MIN_REDACT_LENGTH) return;
    if (needles.some((have) => have.toLowerCase() === item.toLowerCase())) return;
    needles.push(item);
  };
  const whole = String(secret ?? "");
  add(whole);
  add(whole.trim());
  add(bearerToken(whole));
  for (const key of needles) raw = raw.replace(new RegExp(escapeRegExp(key), "gi"), "***");
  return raw;
}

/**
 * http(s) with a host the URL parser accepts. `https:///x` is not usable:
 * WHATWG recovers a host from the path, but the authority is empty.
 * `https://.` and `https://..` are not hosts. The stored string is not rewritten.
 */
export function httpBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!/^https?:\/\/[^/\s?#]/i.test(raw)) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.hostname || url.hostname === "." || url.hostname === "..") return "";
    return raw;
  } catch {
    return "";
  }
}

/**
 * Comparison key for the request URL. Trailing slashes do not count as a
 * different endpoint. A bare `?` does: the request string keeps it.
 */
export function normalizedBaseUrl(value) {
  const raw = httpBaseUrl(value);
  if (!raw) return "";
  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, "");
  const bare = url.href.split("#")[0];
  const search = url.search || (bare.endsWith("?") ? "?" : "");
  return `${url.protocol}//${url.host}${path}${search}`;
}

/** Read path and write path both end here. normalize alone still keeps a raw id. */
export function acceptStoredFormulaSettings(raw) {
  const stored = normalizeFormulaSettings(raw);
  if (!stored.multimodal.provider || isProvenVisionProvider(stored.multimodal.provider)) return stored;
  return {
    ...stored,
    multimodal: {
      ...stored.multimodal,
      provider: "",
      probe: null
    }
  };
}

export function customBaseUrlError(settings) {
  const stored = normalizeFormulaSettings(settings);
  const spec = multimodalProvider(stored.multimodal.provider);
  if (!spec?.baseUrlRequired) return "";
  if (httpBaseUrl(stored.multimodal.baseUrl)) return "";
  return CUSTOM_BASE_URL_ERROR;
}

export function normalizeFormulaSettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const mm = src.multimodal && typeof src.multimodal === "object" ? src.multimodal : {};
  const ocr = src.ocr && typeof src.ocr === "object" ? src.ocr : {};
  const mmProvider = multimodalProvider(mm.provider);
  const ocrSpec = ocrProvider(ocr.provider);
  let model = String(mm.model || "").trim();
  let customModel = mm.customModel === true || mmProvider?.baseUrlRequired === true;
  const presetGeneration = mm.presetGeneration === MM_PRESET_GENERATION ? MM_PRESET_GENERATION : 0;
  // A saved doubao card with no model was the old first preset. New installs
  // carry presetGeneration 2 and an explicit glm id, so they are not rewritten.
  if (mmProvider?.id === "doubao" && !model && presetGeneration !== MM_PRESET_GENERATION) {
    model = LEGACY_DOUBAO_MODEL;
    customModel = true;
  }
  return {
    [FORMULA_SWITCH_KEYS.tier2]: src[FORMULA_SWITCH_KEYS.tier2] === true,
    [FORMULA_SWITCH_KEYS.ocr]: src[FORMULA_SWITCH_KEYS.ocr] === true,
    [FORMULA_SWITCH_KEYS.tier3]: src[FORMULA_SWITCH_KEYS.tier3] === true,
    multimodal: {
      provider: mmProvider ? mmProvider.id : "",
      apiKey: String(mm.apiKey || ""),
      model,
      customModel,
      baseUrl: String(mm.baseUrl || "").trim(),
      probe: cleanProbe(mm.probe, mm.apiKey),
      presetGeneration
    },
    ocr: {
      provider: ocrSpec ? ocrSpec.id : "",
      apiKey: String(ocr.apiKey || ""),
      probe: cleanProbe(ocr.probe, ocr.apiKey)
    }
  };
}

/** A fixed vendor only talks to its own host, and only over https. Empty Base URL means that host. Custom may use any http(s) host. */
export function fixedVendorHostMismatch(settings) {
  const stored = normalizeFormulaSettings(settings);
  const spec = multimodalProvider(stored.multimodal.provider);
  if (!spec || spec.baseUrlRequired || !spec.baseUrl) return false;
  const raw = String(stored.multimodal.baseUrl || "").trim();
  if (!raw) return false;
  try {
    const given = new URL(raw);
    // http would send the key in the clear, even when the hostname matches.
    if (given.protocol !== "https:") return true;
    return given.hostname !== new URL(spec.baseUrl).hostname;
  } catch {
    return true;
  }
}

export function multimodalReady(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = multimodalProvider(stored.multimodal.provider);
  if (!provider || provider.vision !== true) return false;
  if (!stored.multimodal.apiKey.trim()) return false;
  if (provider.baseUrlRequired && !httpBaseUrl(stored.multimodal.baseUrl)) return false;
  if (fixedVendorHostMismatch(stored)) return false;
  return true;
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

/** Gate for one provider card. Exported so a non-vision vendor can be tested without listing one. */
export function providerSwitchState(provider, key, kind) {
  return switchHidden(kind, provider, key);
}

function switchHidden(kind, provider, key) {
  if (provider && provider.vision === false && provider.disabled !== true) {
    return {
      visible: false,
      message: provider.unavailable || "当前厂家不支持看图，请换厂家",
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
  return providerSwitchState(multimodalProvider(stored.multimodal.provider), stored.multimodal.apiKey, "mm");
}

export function ocrSwitchState(settings) {
  const stored = normalizeFormulaSettings(settings);
  return providerSwitchState(ocrProvider(stored.ocr.provider), stored.ocr.apiKey, "ocr");
}

export function multimodalTestDisabled(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = multimodalProvider(stored.multimodal.provider);
  if (!provider || provider.vision !== true) return true;
  if (!String(stored.multimodal.apiKey || "").trim()) return true;
  if (provider.baseUrlRequired && !httpBaseUrl(stored.multimodal.baseUrl)) return true;
  if (fixedVendorHostMismatch(stored)) return true;
  return false;
}

export function ocrTestDisabled(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = ocrProvider(stored.ocr.provider);
  if (!provider || provider.vision !== true) return true;
  if (!String(stored.ocr.apiKey || "").trim()) return true;
  return false;
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

/** Shown under the chip. Not a tooltip. Loom 2026-10-18. */
export const PROBE_EXPLAIN = Object.freeze({
  network: "检查网络或服务地址后重新测试",
  length: "推理模型把输出额度用在了思考上，换个非推理模型再测"
});

export function probeChipText(probe) {
  if (!probe?.chip || probe.code === "aborted") return "";
  if (probe.code === "pending") return String(probe.chip);
  const clock = probeClock(probe.at);
  return clock ? `${probe.chip} · ${clock}` : String(probe.chip);
}

export function probeChipTone(probe) {
  if (probe?.code === "pending") return "oi-set-chip is-off";
  return probe?.ok === true ? "oi-set-chip is-ok" : "oi-set-chip is-warn";
}

export function probeExplanation(probe, secret) {
  if (!probe || probe.ok === true) return "";
  const code = String(probe.code || "");
  if (code === "aborted" || code === "pending") return "";
  if (PROBE_EXPLAIN[code]) return PROBE_EXPLAIN[code];
  return clipProbeSummary(redactProbeText(probe.summary, secret));
}

/** Sidebar 「需处理」. Pending, aborted, and a missing key are not failures. */
export function probeNeedsAttention(probe) {
  if (!probe || probe.ok === true) return false;
  const code = String(probe.code || "");
  if (code === "pending" || code === "aborted" || code === "empty-key") return false;
  return Boolean(String(probe.chip || "").trim());
}

export function classifyFormulaProbe(raw, at = Date.now()) {
  const summary = clipProbeSummary(raw?.summary || raw?.error || "");
  const status = Number(raw?.status);
  const code = String(raw?.code || "");
  const fail = (chip, failCode) => ({ ok: false, chip, code: failCode, summary, at });
  if (code === "aborted") return { ok: false, chip: "", code: "aborted", summary, at };
  if (code === "empty-key") {
    return { ok: false, chip: "", code: "empty-key", summary: summary || EMPTY_KEY_HINT, at };
  }
  if (code === "length") return fail("回答被截断", "length");
  if (raw?.sawImage === false || code === "no-vision") return fail("这个模型不能看图", "no-vision");
  if (status === 401 || code === "401") return fail("密钥无效 (401)", "401");
  if (status === 403 || code === "403") return fail("无权限 (403)", "403");
  if (status === 404 || code === "404") return fail("地址或模型不对 (404)", "404");
  if (status === 429 || code === "429") return fail("额度或限流 (429)", "429");
  if (code === "timeout" || status === 408) return fail("超时", "timeout");
  if (code === "network") return fail("无法连接", "network");
  if (raw?.ok === true) return { ok: true, chip: "已连通", code: "ok", summary: "", at };
  return fail("测试失败", code || "unavailable");
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
export const TABLE_VISIBLE = Object.freeze(["点击查看原表", "看原表", "原表"]);

function placeholderNumber(block) {
  return String(block?.eqLabel || block?.equationNumber || block?.figureLabel || "")
    .trim()
    .replace(/^\(|\)$/g, "");
}

function figureSecondLine(noun, num, known, n) {
  const dot = " · ";
  const full = num && known ? `${noun} ${num}${dot}原文第 ${n} 页`
    : num ? `${noun} ${num}`
    : known ? `原文第 ${n} 页`
    : "";
  const mid = num && known ? `${noun} ${num}${dot}第 ${n} 页`
    : num ? `${noun} ${num}`
    : known ? `第 ${n} 页`
    : "";
  return [full, mid, ""];
}

/**
 * Visible lines stay on the button. Formula numbers stay in aria and title.
 * Figure and table cards also return a second line for the three widths
 * (full, under 200px, under 128px). kind "formula" returns only
 * { visible, aria }, the same fields as before.
 */
export function placeholderCopy(block, { inline = false, kind = "formula" } = {}) {
  const table = kind === "table";
  const figure = kind === "figure" || table;
  const visible = table ? TABLE_VISIBLE : figure ? FIGURE_VISIBLE : FORMULA_VISIBLE;
  const page = Number(block?.page);
  const known = Number.isFinite(page) && page >= 1;
  const n = known ? Math.floor(page) : 0;
  const num = placeholderNumber(block);
  let head = "公式";
  if (table) head = num ? `表 ${num}` : "表";
  else if (figure) head = num ? `图 ${num}` : "图";
  else if (inline) head = "行内公式";
  else if (num) head = `公式 (${num})`;
  const parts = [head];
  if (known) parts.push(`原文第 ${n} 页`);
  parts.push(visible[0]);
  const copy = { visible: visible.slice(), aria: parts.join(" · ") };
  if (figure) copy.second = figureSecondLine(table ? "表" : "图", num, known, n);
  return copy;
}

export async function readFormulaSettings(storage) {
  if (!storage || typeof storage.get !== "function") return defaultFormulaSettings();
  const bag = await storage.get(FORMULA_SETTINGS_KEY);
  // Interrupt: the bag is in hand. Strip an unproven vendor before returning
  // it as the effective settings, even if it was written around this module.
  const raw = bag && typeof bag === "object" ? bag[FORMULA_SETTINGS_KEY] : null;
  // No record yet: glm-5.3-flash. A saved object keeps the model the user stored.
  if (raw == null) return defaultFormulaSettings();
  return acceptStoredFormulaSettings(raw);
}

function explicitKey(rawPart, previousKey) {
  if (!rawPart || typeof rawPart !== "object" || !Object.prototype.hasOwnProperty.call(rawPart, "apiKey")) {
    return String(previousKey ?? "");
  }
  return String(rawPart.apiKey ?? "");
}

function carriedProbe(rawPart, prevPart) {
  const prevKey = String(prevPart?.apiKey ?? "");
  const key = explicitKey(rawPart, prevKey);
  // A key change never keeps the previous probe. The check lives here, not in the
  // later key-diff, so a draft card cannot carry 「已连通」 onto a new key.
  if (key !== prevKey) return key ? pendingProbe() : null;
  if (rawPart && Object.prototype.hasOwnProperty.call(rawPart, "probe") && rawPart.probe == null) return null;
  if (rawPart && rawPart.probe && typeof rawPart.probe === "object") return rawPart.probe;
  return prevPart?.probe ?? null;
}

/** Draft custom card: keep the stored URL, and take model, key, and switches from this write. */
function mergeDraftCard(previous, next, raw) {
  const prevMm = previous.multimodal || {};
  const prevOcr = previous.ocr || {};
  return acceptStoredFormulaSettings({
    ...next,
    multimodal: {
      ...next.multimodal,
      baseUrl: String(prevMm.baseUrl || ""),
      apiKey: explicitKey(raw?.multimodal, prevMm.apiKey),
      probe: carriedProbe(raw?.multimodal, prevMm)
    },
    ocr: {
      ...next.ocr,
      apiKey: explicitKey(raw?.ocr, prevOcr.apiKey),
      probe: carriedProbe(raw?.ocr, prevOcr)
    }
  });
}

export async function writeFormulaSettings(settings, storage, meta = {}) {
  let next = acceptStoredFormulaSettings(settings);
  // Interrupt: after the previous record is read, before storage.set.
  // A custom card with no usable Base URL is stored as that custom provider.
  // It is not rewritten to another vendor, and it does not wipe a saved URL.
  // A provider, model, or Base URL change drops a probe that belonged to the previous card.
  // The same key saved again is marked 「待测试」 by the caller before it reaches here.
  let previous = null;
  if (storage && typeof storage.get === "function") {
    const bag = await storage.get(FORMULA_SETTINGS_KEY);
    previous = acceptStoredFormulaSettings(bag && typeof bag === "object" ? bag[FORMULA_SETTINGS_KEY] : null);
  }
  // A key that arrived with a different vendor was not entered for this host.
  // A key the page just accepted for the snapshot's own provider is kept, even
  // when storage still holds the previous vendor and the same string.
  const keyFor = meta?.keyFor || {};
  if (
    previous?.multimodal?.provider
    && next.multimodal.provider
    && previous.multimodal.provider !== next.multimodal.provider
    && previous.multimodal.apiKey
    && next.multimodal.apiKey === previous.multimodal.apiKey
    && keyFor.multimodal !== next.multimodal.provider
  ) {
    next = { ...next, multimodal: { ...next.multimodal, apiKey: "", probe: null } };
  }
  if (
    previous?.ocr?.provider
    && next.ocr.provider
    && previous.ocr.provider !== next.ocr.provider
    && previous.ocr.apiKey
    && next.ocr.apiKey === previous.ocr.apiKey
    && keyFor.ocr !== next.ocr.provider
  ) {
    next = { ...next, ocr: { ...next.ocr, apiKey: "", probe: null } };
  }
  let draftMerged = false;
  if (customBaseUrlError(next)) {
    if (previous && previous.multimodal.provider === next.multimodal.provider && httpBaseUrl(previous.multimodal.baseUrl)) {
      next = {
        ...next,
        multimodal: { ...next.multimodal, baseUrl: previous.multimodal.baseUrl }
      };
    } else if (previous && customBaseUrlError(previous)) {
      next = mergeDraftCard(previous, next, settings);
      draftMerged = true;
    } else if (!httpBaseUrl(next.multimodal.baseUrl)) {
      next = { ...next, multimodal: { ...next.multimodal, baseUrl: "" } };
    }
  }
  const mmEndpointChanged = previous?.multimodal?.provider && (
    previous.multimodal.provider !== next.multimodal.provider
    || previous.multimodal.model !== next.multimodal.model
    || normalizedBaseUrl(previous.multimodal.baseUrl) !== normalizedBaseUrl(next.multimodal.baseUrl)
  );
  if (mmEndpointChanged) {
    next = { ...next, multimodal: { ...next.multimodal, probe: null } };
  } else if (!draftMerged && previous && previous.multimodal.apiKey !== next.multimodal.apiKey) {
    next = {
      ...next,
      multimodal: {
        ...next.multimodal,
        probe: next.multimodal.apiKey ? pendingProbe() : null
      }
    };
  }
  if (previous && previous.ocr.apiKey !== next.ocr.apiKey) {
    next = {
      ...next,
      ocr: {
        ...next.ocr,
        probe: next.ocr.apiKey ? pendingProbe() : null
      }
    };
  }
  if (storage && typeof storage.set === "function") {
    await storage.set({ [FORMULA_SETTINGS_KEY]: next });
  }
  return next;
}
