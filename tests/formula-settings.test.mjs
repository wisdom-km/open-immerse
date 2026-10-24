import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { multimodalTarget } from "../lib/mm-client.js";
import { displayFormulaWidthCss } from "../lib/pdf-blocks.js";
import { cacheableLayout } from "../lib/pdf-layout-client.js";
import {
  placeholderCssLength,
  placeholderNativeBox,
  placeholderUsedBox
} from "../lib/pdf-formula-size.js";
import { READER_THEMES } from "../lib/pdf-reader-flow.js";
import { DEFAULT_SETTINGS, saveSettings } from "../lib/storage.js";
import { multimodalTier } from "../lib/formula-tiers/multimodal.js";
import { ocrTier } from "../lib/formula-tiers/ocr.js";
import { scheduleFormulaBlock } from "../lib/formula-schedule.js";
import {
  ARK_DIRECT_BASE_URL,
  ARK_PLAN_BASE_URL,
  ARK_PLAN_PAYG_HINT,
  FORMULA_BASE_URL_NOTE,
  FORMULA_ORDER,
  FORMULA_PRIVACY_NOTE,
  FORMULA_SETTINGS_AREA,
  FORMULA_SETTINGS_KEY,
  FORMULA_SWITCH_KEYS,
  MULTIMODAL_PROVIDERS,
  OCR_PROVIDERS,
  applyFormulaPart,
  EMPTY_KEY_HINT,
  classifyFormulaProbe,
  customBaseUrlError,
  defaultFormulaSettings,
  formulaChainFlags,
  formulaOrderText,
  modelChoice,
  multimodalReady,
  multimodalTestDisabled,
  normalizeFormulaSettings,
  ocrTestDisabled,
  probeNeedsAttention,
  ocrSwitchState,
  placeholderCopy,
  probeClock,
  probeExplanation,
  providerSwitchState,
  requestUsesArkPlan,
  readFormulaSettings,
  runFormulaProbe,
  stubFormulaProbe,
  tier2SwitchState,
  tierActive,
  writeFormulaSettings
} from "../lib/formula-settings.js";
import { renderFormulaPanel, renderFormulaSwitchList } from "../lib/formula-settings-ui.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

function memoryStorage(initial = {}) {
  const bag = { ...initial };
  return {
    bag,
    async get(key) {
      return { [key]: bag[key] };
    },
    async set(patch) {
      Object.assign(bag, patch);
    }
  };
}

class DomNode {
  constructor() {
    this.childNodes = [];
  }
  append(...nodes) {
    for (const node of nodes) this.childNodes.push(node);
  }
  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }
  prepend(node) {
    this.childNodes.unshift(node);
  }
  get textContent() {
    return this.childNodes.map((node) => node.textContent || "").join("");
  }
  set textContent(value) {
    this.childNodes = [{ textContent: String(value ?? "") }];
  }
}

class DomEl extends DomNode {
  constructor(tag) {
    super();
    this.tagName = String(tag || "").toUpperCase();
    this.attrs = {};
    this.className = "";
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.type = "";
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  addEventListener() {}
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      if (node?.tagName && matches(node, selector)) found.push(node);
      for (const child of node?.childNodes || []) visit(child);
    };
    visit(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  focus() {
    this.focused = true;
  }
  scrollIntoView() {}
}

function matches(node, selector) {
  if (selector === "input, select") return node.tagName === "INPUT" || node.tagName === "SELECT";
  const attr = selector.match(/^\[([^=]+)="([^"]+)"\]$/);
  if (attr) return node.attrs[attr[1]] === attr[2];
  return false;
}

function installDocument() {
  globalThis.document = {
    createElement(tag) {
      return new DomEl(tag);
    },
    createTextNode(text) {
      return { textContent: String(text ?? "") };
    }
  };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
}

function switchesOf(node) {
  const found = [];
  walk(node, (item) => {
    if (item.attrs?.["data-formula-switch"]) found.push(item.attrs["data-formula-switch"]);
  });
  return found;
}

function textOf(node) {
  return node.textContent || "";
}

function inkImage() {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  for (let i = 0; i < 4; i += 1) {
    data[i * 4 + 3] = 255;
  }
  return { width: 2, height: 2, data };
}

function blankImage() {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  for (let i = 0; i < 4; i += 1) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  return { width: 2, height: 2, data };
}

const formulaBlock = {
  label: "formula",
  id: "f1",
  bid: "b1",
  bbox: [0.2, 0.3, 0.5, 0.4],
  text: "E = mc^2",
  display: true,
  page: 4
};

test("F3-20 three formula switches default off and stay independent", () => {
  const stored = defaultFormulaSettings();
  assert.equal(stored[FORMULA_SWITCH_KEYS.tier2], false);
  assert.equal(stored[FORMULA_SWITCH_KEYS.ocr], false);
  assert.equal(stored[FORMULA_SWITCH_KEYS.tier3], false);
  const next = normalizeFormulaSettings({ ...stored, [FORMULA_SWITCH_KEYS.tier2]: true });
  assert.equal(next[FORMULA_SWITCH_KEYS.tier2], true);
  assert.equal(next[FORMULA_SWITCH_KEYS.ocr], false);
  assert.equal(next[FORMULA_SWITCH_KEYS.tier3], false);
  assert.equal(normalizeFormulaSettings({ [FORMULA_SWITCH_KEYS.ocr]: "yes" })[FORMULA_SWITCH_KEYS.ocr], false);
});

test("F3-20 multimodal settings stay out of translation settings", async () => {
  assert.equal(FORMULA_SETTINGS_AREA, "local");
  assert.equal(DEFAULT_SETTINGS[FORMULA_SETTINGS_KEY], undefined);
  assert.equal(DEFAULT_SETTINGS[FORMULA_SWITCH_KEYS.tier2], undefined);
  const translation = {
    provider: "openai",
    providers: { openai: { apiKey: "sk-translate", model: "gpt-4o-mini" } }
  };
  const before = JSON.stringify(translation);
  const local = memoryStorage();
  const sync = memoryStorage({ settings: translation });
  const saved = await writeFormulaSettings({
    multimodal: { provider: "openai", apiKey: "sk-formula", model: "gpt-4o" },
    [FORMULA_SWITCH_KEYS.tier2]: true
  }, local);
  assert.equal(JSON.stringify(translation), before);
  assert.equal(sync.bag.settings, translation);
  assert.equal(saved.multimodal.apiKey, "sk-formula");
  assert.equal(saved.multimodal.model, "gpt-4o");
  assert.equal(local.bag[FORMULA_SETTINGS_KEY].multimodal.apiKey, "sk-formula");
  assert.equal(local.bag.settings, undefined);
  const round = await readFormulaSettings(local);
  assert.equal(round.multimodal.model, "gpt-4o");
  assert.notEqual(round.multimodal.model, translation.providers.openai.model);
  const options = read("options/options.js");
  const persist = options.slice(options.indexOf("async function persist"), options.indexOf("function fillSelect"));
  assert.equal(persist.includes(FORMULA_SETTINGS_KEY), false);
  assert.equal(persist.includes("formula.tier2"), false);
  assert.match(persist, /OI_SAVE_SETTINGS/);

  const formulaKey = "sk-formula-local-only";
  const ocrKey = "ocr-local-only";
  const syncWrites = [];
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
    storage: {
      local,
      sync: {
        async get() {
          return { settings: translation };
        },
        async set(patch) {
          syncWrites.push(JSON.parse(JSON.stringify(patch)));
        }
      }
    }
  };
  try {
    await writeFormulaSettings({
      multimodal: { provider: "openai", apiKey: formulaKey, model: "gpt-4o" },
      ocr: { provider: "zhipu", apiKey: ocrKey },
      [FORMULA_SWITCH_KEYS.tier2]: true
    }, globalThis.chrome.storage.local);
    await saveSettings({ provider: "openai" });
  } finally {
    globalThis.chrome = previousChrome;
  }
  const synced = JSON.stringify(syncWrites);
  assert.equal(syncWrites.length > 0, true);
  assert.equal(synced.includes(formulaKey), false);
  assert.equal(synced.includes(ocrKey), false);
  assert.equal(local.bag[FORMULA_SETTINGS_KEY].multimodal.apiKey, formulaKey);
  assert.equal(local.bag[FORMULA_SETTINGS_KEY].ocr.apiKey, ocrKey);
  assert.equal(local.bag[FORMULA_SETTINGS_KEY][FORMULA_SWITCH_KEYS.tier2], true);
});

test("SET-05 an empty key input does not overwrite a stored key", async () => {
  const stored = normalizeFormulaSettings({
    multimodal: { provider: "openai", apiKey: "sk-kept", model: "gpt-4o" },
    ocr: { provider: "zhipu", apiKey: "ocr-kept" },
    [FORMULA_SWITCH_KEYS.tier2]: true
  });
  const cleared = applyFormulaPart(stored, "multimodal", { apiKey: "" });
  const blanked = applyFormulaPart(stored, "ocr", { apiKey: "   " });
  const replaced = applyFormulaPart(stored, "multimodal", { apiKey: "sk-new" });
  assert.equal(cleared.multimodal.apiKey, "sk-kept");
  assert.equal(cleared.ocr.apiKey, "ocr-kept");
  assert.equal(blanked.ocr.apiKey, "ocr-kept");
  assert.equal(blanked.multimodal.apiKey, "sk-kept");
  assert.equal(replaced.multimodal.apiKey, "sk-new");
  assert.equal(replaced.ocr.apiKey, "ocr-kept");
  const local = memoryStorage();
  const saved = await writeFormulaSettings(cleared, local);
  assert.equal(saved.multimodal.apiKey, "sk-kept");
  assert.equal(local.bag[FORMULA_SETTINGS_KEY].multimodal.apiKey, "sk-kept");
  const options = read("options/options.js");
  assert.match(options, /formulaSettings = applyFormulaPart\(formulaSettings, which, patch\)/);
});

test("F3-20 an unconfigured multimodal model hides the tier-2 switch", () => {
  installDocument();
  const panel = new DomEl("div");
  renderFormulaPanel(panel, defaultFormulaSettings(), {});
  assert.deepEqual(switchesOf(panel), [FORMULA_SWITCH_KEYS.tier3]);
  assert.match(textOf(panel), /需先配置多模态模型/);
  assert.match(textOf(panel), /去配置/);
  const picked = normalizeFormulaSettings({
    multimodal: { provider: "openai", apiKey: "" }
  });
  renderFormulaPanel(panel, picked, {});
  assert.equal(switchesOf(panel).includes(FORMULA_SWITCH_KEYS.tier2), false);
  assert.equal(tier2SwitchState(picked).visible, false);
  assert.equal(multimodalReady(picked), false);
});

test("FUI-03 providers list vision vendors plus custom, and DeepSeek stays unproven", () => {
  assert.equal(MULTIMODAL_PROVIDERS.length, 8);
  assert.deepEqual(MULTIMODAL_PROVIDERS.map((item) => item.id), [
    "openai", "gemini", "deepseek", "doubao", "kimi", "grok", "qwen", "custom"
  ]);
  const deepseek = MULTIMODAL_PROVIDERS.find((item) => item.id === "deepseek");
  assert.equal(deepseek.vision, false);
  assert.equal(deepseek.visionBasis, "docs");
  assert.equal(deepseek.unavailable, "DeepSeek · 待实测");
  assert.deepEqual(deepseek.models, ["deepseek-flash"]);
  const gemini = MULTIMODAL_PROVIDERS.find((item) => item.id === "gemini");
  assert.equal(gemini.models.includes("gemini-2.0-flash"), false);
  assert.equal(gemini.models[0], "gemini-3.8-flash");
  const qwen = MULTIMODAL_PROVIDERS.find((item) => item.id === "qwen");
  assert.equal(qwen.label, "千问");
  assert.equal(qwen.vision, true);
  assert.deepEqual(qwen.models, ["qwen3-vl-plus", "qwen3-vl-flash"]);
  for (const item of MULTIMODAL_PROVIDERS) {
    if (item.id === "custom") assert.deepEqual(item.models, []);
    else assert.ok(item.models.length >= 1 && item.models.length <= 2, item.id);
  }
  installDocument();
  const panel = new DomEl("div");
  renderFormulaPanel(panel, defaultFormulaSettings(), {});
  const labels = [];
  walk(panel, (node) => {
    if (node.tagName === "OPTION" && (node.value === "deepseek" || node.value === "qwen")) labels.push(node);
  });
  const deepseekOpt = labels.find((node) => node.value === "deepseek");
  const qwenOpt = labels.find((node) => node.value === "qwen");
  assert.equal(deepseekOpt.disabled, true);
  assert.equal(deepseekOpt.textContent, "DeepSeek · 待实测");
  assert.equal(qwenOpt.disabled, false);
  assert.equal(qwenOpt.textContent, "千问");
});

test("F7-PR1 a typed model is kept and the vendor base URL is only a placeholder", () => {
  const typed = normalizeFormulaSettings({
    multimodal: { provider: "qwen", apiKey: "sk", model: "qwen-vl-user-typed", customModel: true }
  });
  assert.equal(typed.multimodal.model, "qwen-vl-user-typed");
  assert.deepEqual(modelChoice(typed), { mode: "select", select: "__custom", custom: "qwen-vl-user-typed" });
  installDocument();
  const panel = new DomEl("div");
  renderFormulaPanel(panel, normalizeFormulaSettings({
    multimodal: { provider: "qwen", apiKey: "sk", model: "qwen3-vl-plus" }
  }), {});
  const placeholders = [];
  walk(panel, (node) => {
    if (node.placeholder) placeholders.push(node.placeholder);
  });
  assert.ok(placeholders.includes("https://dashscope.aliyuncs.com/compatible-mode/v1"));
  assert.equal(typed.multimodal.baseUrl, "");
  assert.match(textOf(panel), /不要把密钥写进地址/);
  assert.equal(FORMULA_BASE_URL_NOTE.includes("不要把密钥写进地址"), true);
});

test("FUI-04 custom base URL is required before the vision probe can run", () => {
  const open = normalizeFormulaSettings({
    multimodal: { provider: "custom", apiKey: "sk", baseUrl: "" }
  });
  assert.equal(multimodalTestDisabled(open), true);
  const ready = normalizeFormulaSettings({
    multimodal: { provider: "custom", apiKey: "sk", baseUrl: "https://example.test/v1" }
  });
  assert.equal(multimodalTestDisabled(ready), false);
  assert.equal(multimodalTestDisabled(defaultFormulaSettings()), true);
  const noKey = normalizeFormulaSettings({
    multimodal: { provider: "openai", apiKey: "  ", model: "gpt-5.6-luna" }
  });
  assert.equal(multimodalTestDisabled(noKey), true);
  assert.equal(ocrTestDisabled(normalizeFormulaSettings({ ocr: { provider: "baidu", apiKey: "" } })), true);
  assert.equal(ocrTestDisabled(normalizeFormulaSettings({ ocr: { provider: "baidu", apiKey: "ocr-key-1" } })), false);
  const missing = classifyFormulaProbe({ code: "empty-key", summary: EMPTY_KEY_HINT }, 9);
  assert.equal(missing.chip, "");
  assert.equal(missing.code, "empty-key");
  assert.equal(missing.summary, EMPTY_KEY_HINT);
  assert.equal(probeNeedsAttention(missing), false);
  assert.notEqual(missing.chip, "密钥无效 (401)");
});

test("an explicit Base URL clear is stored empty; a write that omitted the URL keeps the saved one", async () => {
  const kept = memoryStorage({
    [FORMULA_SETTINGS_KEY]: {
      multimodal: {
        provider: "custom",
        apiKey: "sk-custom",
        model: "m",
        customModel: true,
        baseUrl: "https://vendor.example/v1"
      }
    }
  });
  const omitted = await writeFormulaSettings({
    multimodal: { provider: "custom", apiKey: "sk-custom", model: "m", customModel: true, baseUrl: "" },
    [FORMULA_SWITCH_KEYS.tier3]: true
  }, kept);
  assert.equal(omitted.multimodal.baseUrl, "https://vendor.example/v1");
  assert.equal(kept.bag[FORMULA_SETTINGS_KEY].multimodal.baseUrl, "https://vendor.example/v1");

  const cleared = await writeFormulaSettings({
    ...omitted,
    multimodal: { ...omitted.multimodal, baseUrl: "" }
  }, kept, { baseUrlCleared: true });
  assert.equal(cleared.multimodal.baseUrl, "");
  assert.equal(kept.bag[FORMULA_SETTINGS_KEY].multimodal.baseUrl, "");
  assert.equal(customBaseUrlError(cleared), "请填写 Base URL");
  const reread = await readFormulaSettings(kept);
  assert.equal(reread.multimodal.baseUrl, "");
  assert.equal(multimodalTarget(reread).url, "");
  assert.equal(multimodalReady(reread), false);

  const ark = memoryStorage({
    [FORMULA_SETTINGS_KEY]: {
      multimodal: {
        provider: "doubao",
        apiKey: "sk-ark",
        model: "glm-5.3-flash",
        customModel: false,
        baseUrl: ARK_DIRECT_BASE_URL,
        presetGeneration: 2
      }
    }
  });
  const arkCleared = await writeFormulaSettings({
    multimodal: {
      provider: "doubao",
      apiKey: "sk-ark",
      model: "glm-5.3-flash",
      customModel: false,
      baseUrl: "",
      presetGeneration: 2
    }
  }, ark, { baseUrlCleared: true });
  assert.equal(arkCleared.multimodal.baseUrl, "");
  const arkRead = await readFormulaSettings(ark);
  assert.equal(arkRead.multimodal.baseUrl, "");
  assert.equal(arkRead.multimodal.model, "glm-5.3-flash");
  assert.equal(multimodalTarget(arkRead).url, `${ARK_PLAN_BASE_URL}/chat/completions`);

  const legacy = memoryStorage({
    [FORMULA_SETTINGS_KEY]: {
      multimodal: {
        provider: "doubao",
        apiKey: "sk-old",
        model: "doubao-seed-2-1-pro-260915",
        baseUrl: ""
      }
    }
  });
  const legacyRead = await readFormulaSettings(legacy);
  assert.equal(legacyRead.multimodal.baseUrl, "");
  assert.equal(legacyRead.multimodal.model, "doubao-seed-2-1-pro-260915");
  assert.equal(multimodalTarget(legacyRead).url, `${ARK_PLAN_BASE_URL}/chat/completions`);
});

test("a plan-endpoint 401 keeps the invalid-key chip and shows the pay-as-you-go hint", () => {
  assert.equal(requestUsesArkPlan(`${ARK_PLAN_BASE_URL}/chat/completions`), true);
  assert.equal(requestUsesArkPlan(`${ARK_PLAN_BASE_URL}/`), true);
  assert.equal(requestUsesArkPlan("https://ark.cn-beijing.volcengine.com/api/plan/v3/chat/completions"), true);
  assert.equal(requestUsesArkPlan(`${ARK_DIRECT_BASE_URL}/chat/completions`), false);
  assert.equal(requestUsesArkPlan("https://api.openai.com/v1/chat/completions"), false);
  assert.equal(requestUsesArkPlan("https://ark.cn-beijing.volces.com.evil/api/plan/v3"), false);
  assert.equal(requestUsesArkPlan(""), false);
  assert.ok(ARK_PLAN_PAYG_HINT.length <= 80);
  assert.match(ARK_PLAN_PAYG_HINT, /https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3/);
  const probe = classifyFormulaProbe({ status: 401, code: "401", summary: ARK_PLAN_PAYG_HINT }, 1);
  assert.equal(probe.chip, "密钥无效 (401)");
  assert.equal(probeExplanation(probe), ARK_PLAN_PAYG_HINT);
});

test("FUI-07 and FUI-08 probe copy is classified without a network call", async () => {
  const at = Date.parse("2026-10-13T01:05:00Z");
  assert.equal(classifyFormulaProbe({ status: 401, summary: "nope" }, at).chip, "密钥无效 (401)");
  assert.equal(classifyFormulaProbe({ status: 403 }, at).chip, "无权限 (403)");
  assert.equal(classifyFormulaProbe({ status: 404 }, at).chip, "地址或模型不对 (404)");
  assert.equal(classifyFormulaProbe({ status: 429 }, at).chip, "额度或限流 (429)");
  assert.equal(classifyFormulaProbe({ code: "timeout" }, at).chip, "超时");
  assert.equal(classifyFormulaProbe({ sawImage: false }, at).chip, "这个模型不能看图");
  const ok = classifyFormulaProbe({ ok: true }, at);
  assert.equal(ok.ok, true);
  assert.equal(ok.chip, "已连通");
  assert.equal(probeClock(at), probeClock(at));
  const long = "x".repeat(120);
  assert.equal(classifyFormulaProbe({ status: 500, summary: long }, at).summary.length, 80);
  const stub = await runFormulaProbe({ provider: "openai" }, stubFormulaProbe, at);
  assert.equal(stub.ok, false);
  assert.equal(stub.chip, "测试失败");
  const src = read("lib/formula-settings.js") + read("lib/formula-settings-ui.js");
  assert.equal(/\bfetch\s*\(/.test(src), false);
  assert.equal(src.includes("confirm("), false);
});

test("FUI-09 FUI-10 FUI-11 FUI-12 switch visibility follows configuration, not a failed probe", () => {
  installDocument();
  const pending = normalizeFormulaSettings({
    multimodal: { provider: "deepseek", apiKey: "sk-secret", model: "deepseek-flash" },
    [FORMULA_SWITCH_KEYS.tier2]: true
  });
  assert.equal(tier2SwitchState(pending).visible, false);
  assert.equal(multimodalReady(pending), false);
  assert.match(tier2SwitchState(pending).message, /待实测/);
  const blind = providerSwitchState({ id: "blind", vision: false }, "sk-secret", "mm");
  assert.equal(blind.visible, false);
  assert.match(blind.message, /不支持看图/);
  const ready = normalizeFormulaSettings({
    multimodal: { provider: "openai", apiKey: "sk-secret", model: "gpt-4o" },
    ocr: { provider: "zhipu", apiKey: "ocr-key" },
    [FORMULA_SWITCH_KEYS.tier2]: true,
    [FORMULA_SWITCH_KEYS.ocr]: false
  });
  const failed = normalizeFormulaSettings({
    ...ready,
    multimodal: {
      ...ready.multimodal,
      probe: { ok: false, chip: "超时", code: "timeout", summary: "late", at: Date.now() }
    }
  });
  assert.equal(failed[FORMULA_SWITCH_KEYS.tier2], true);
  const panel = new DomEl("div");
  renderFormulaSwitchList(panel, failed, {});
  assert.deepEqual(switchesOf(panel), [
    FORMULA_SWITCH_KEYS.tier2,
    FORMULA_SWITCH_KEYS.ocr,
    FORMULA_SWITCH_KEYS.tier3
  ]);
  assert.match(textOf(panel), /最近失败 · 超时/);
  assert.match(textOf(panel), /失败的公式已改用后面的级别/);
  const bareOcr = ocrSwitchState(defaultFormulaSettings());
  assert.equal(bareOcr.visible, false);
  assert.match(bareOcr.message, /需先配置 OCR/);
  assert.equal(OCR_PROVIDERS.some((item) => item.label === "智谱 GLM-OCR"), true);
  assert.equal(OCR_PROVIDERS.some((item) => item.label === "百度"), true);
});

test("FUI-02 FUI-13 FUI-14 order, privacy, and placeholder copy", () => {
  assert.equal(formulaOrderText(), "① arXiv 源码 → ② 多模态 → ③ OCR → ④ 自研识别 → ⑤ 矢量重绘 → ⑥ 裁图 → ⑦ 占位");
  assert.equal(FORMULA_ORDER.length, 7);
  const stored = defaultFormulaSettings();
  assert.equal(tierActive("arxiv", stored), false);
  assert.equal(tierActive("multimodal", stored), false);
  assert.equal(tierActive("crop", stored), true);
  assert.match(FORMULA_PRIVACY_NOTE, /不上传整页 PDF/);
  assert.match(FORMULA_PRIVACY_NOTE, /密钥只存本机/);
  assert.match(FORMULA_PRIVACY_NOTE, /行内公式和行间公式/);
  installDocument();
  const panel = new DomEl("div");
  renderFormulaPanel(panel, stored, {});
  assert.match(textOf(panel), /不上传整页 PDF/);
  assert.match(textOf(panel), /密钥只存本机/);
  const numbered = placeholderCopy({ page: 4, eqLabel: "(3)" }, { inline: false });
  assert.deepEqual(numbered.visible, ["点击查看原公式", "看原公式", "原公式"]);
  assert.equal(numbered.aria, "公式 (3) · 原文第 4 页 · 点击查看原公式");
  assert.equal(placeholderCopy({ page: 4, eqLabel: "3" }).aria, "公式 (3) · 原文第 4 页 · 点击查看原公式");
  assert.equal(placeholderCopy({ page: 4 }).aria, "公式 · 原文第 4 页 · 点击查看原公式");
  assert.equal(placeholderCopy({ page: 4 }, { inline: true }).aria, "行内公式 · 原文第 4 页 · 点击查看原公式");
  assert.equal(placeholderCopy({ page: null, eqLabel: "(3)" }).aria, "公式 (3) · 点击查看原公式");
  assert.equal(placeholderCopy({ page: null }, { inline: true }).aria, "行内公式 · 点击查看原公式");
  assert.equal(placeholderCopy({ page: 3, figureLabel: "1" }, { kind: "figure" }).aria, "图 1 · 原文第 3 页 · 点击查看原图");
  assert.deepEqual(placeholderCopy({ page: 3 }, { kind: "figure" }).visible, ["点击查看原图", "看原图", "原图"]);
});

test("F3-20 connectivity uses the stub, and tier adapters stay unavailable", async () => {
  let calls = 0;
  const seen = await runFormulaProbe({ provider: "openai", apiKey: "sk" }, async (config) => {
    calls += 1;
    assert.equal(config.provider, "openai");
    return { ok: true, sawImage: true };
  });
  assert.equal(calls, 1);
  assert.equal(seen.chip, "已连通");
  assert.equal(multimodalTier.available({ flags: { multimodalEnabled: true, multimodalConfigured: true } }), false);
  assert.equal(ocrTier.available({ flags: { ocrEnabled: true, ocrConfigured: true } }), false);
  assert.equal(read("lib/formula-tiers/multimodal.js").includes("return false"), true);
  assert.equal(read("lib/formula-tiers/ocr.js").includes("return false"), true);
});

test("placeholder switch follows crop criteria and does not change the default crop", async () => {
  const shown = await scheduleFormulaBlock(formulaBlock, {
    arxivEnabled: false,
    placeholderEnabled: false,
    withRasterCrop: async (item) => ({
      ...item,
      imageUrl: "data:image/png;base64,abc",
      surface: "redraw"
    })
  });
  assert.equal(shown.formulaTier, "crop");
  assert.equal(shown.imageUrl, "data:image/png;base64,abc");
  assert.equal(shown.surface, "redraw");

  let reads = 0;
  await scheduleFormulaBlock(formulaBlock, {
    placeholderEnabled: false,
    readCropImage: async () => {
      reads += 1;
      return { image: blankImage() };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: "data:image/png;base64,abc", surface: "png" })
  });
  assert.equal(reads, 0);

  const blank = await scheduleFormulaBlock({ ...formulaBlock, bid: "blank" }, {
    placeholderEnabled: true,
    page: 4,
    readCropImage: async () => ({ image: blankImage(), pixelSize: { width: 2, height: 2 } }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: "data:image/png;base64,abc", surface: "png" })
  });
  assert.equal(blank.formulaTier, "placeholder");
  assert.equal(blank.formulaReason, "crop-blank");
  assert.equal(blank.imageUrl, "data:image/png;base64,abc");

  const sharp = await scheduleFormulaBlock({ ...formulaBlock, bid: "sharp" }, {
    placeholderEnabled: true,
    readCropImage: async () => ({ image: inkImage(), pixelSize: { width: 2, height: 2 } }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: "data:image/png;base64,ink", surface: "redraw" })
  });
  assert.equal(sharp.formulaTier, "crop");
  assert.equal(sharp.imageUrl, "data:image/png;base64,ink");

  const flags = formulaChainFlags({
    [FORMULA_SWITCH_KEYS.tier2]: true,
    [FORMULA_SWITCH_KEYS.tier3]: true,
    multimodal: { provider: "openai", apiKey: "sk", model: "gpt-4o" }
  });
  assert.equal(flags.placeholderEnabled, true);
  assert.equal(flags.multimodalEnabled, true);
  assert.equal(flags.multimodalConfigured, true);
  assert.equal(flags.ocrEnabled, false);
  assert.equal(flags.arxivEnabled, false);
});

test("settings screen and Aa panel expose the same switch keys", () => {
  const html = read("options/options.html");
  const viewer = read("pdf/viewer.html");
  const viewerJs = read("pdf/viewer.js");
  const css = read("pdf/viewer.css");
  assert.match(html, /data-nav="mm"[^>]*>多模态 · OCR</);
  assert.match(html, /id="panel-formula"/);
  assert.doesNotMatch(html, /问 AI 模型/);
  assert.doesNotMatch(html, /引用公式时用「多模态 · OCR」里的模型/);
  assert.doesNotMatch(html, /data-nav="ask"/);
  assert.doesNotMatch(html, /id="panel-ask"/);
  assert.doesNotMatch(html.match(/id="panel-pdf"[\s\S]*?<\/section>/)[0], /formulaSettings|用多模态模型补全公式/);
  assert.match(viewer, /id="aaFormulaSwitches"/);
  assert.match(viewer, /id="aaFormulaSettings"[^>]*>公式设置…/);
  assert.match(viewerJs, /formulaChainFlags\(formulaViewerSettings/);
  assert.match(viewerJs, /placeholderEnabled: formulaFlags\.placeholderEnabled/);
  assert.match(viewerJs, /readCropImage: formulaFlags\.placeholderEnabled \? readFormulaCropImage/);
  assert.match(viewerJs, /data-oi-tier/);
  assert.equal(viewerJs.includes("innerHTML"), false);
  assert.match(css, /\.oi-formula-placeholder:not\(\.is-inline\)\s*\{[^}]*min\(100%,\s*max\(112px,\s*var\(--oi-ph-w,\s*112px\)\)\)/);
  assert.match(css, /\.oi-formula-placeholder:not\(\.is-inline\)\s*\{[^}]*min-height:\s*32px/);
  assert.match(css, /container:\s*oi-ph\s*\/\s*inline-size/);
  assert.match(css, /@container\s+oi-ph\s+\(width\s*<\s*128px\)/);
  assert.match(css, /@container\s+oi-ph\s+\(width\s*<\s*64px\)/);
  assert.match(css, /@container\s+oi-ph\s+\(width\s*<\s*52px\)/);
  assert.match(css, /\.oi-formula-placeholder\.is-inline\s*\{[^}]*clamp\(16px,\s*var\(--oi-ph-h,\s*16px\),\s*calc\(1lh\s*-\s*6px\)\)/);
  assert.doesNotMatch(css, /oi-formula-ph-thumb/);
  assert.doesNotMatch(css, /oi-formula-ph-missing/);
  assert.doesNotMatch(viewerJs, /oi-formula-ph-thumb/);
  assert.doesNotMatch(viewerJs, /oi-formula-ph-missing/);
  assert.match(css, /\.oi-formula-reserve\s*\{[^}]*width:\s*48px/);
  const stored = cacheableLayout({
    page: 1,
    blocks: [{ id: "f", label: "formula", formulaTier: "placeholder", formulaReason: "crop-blank", imageUrl: "data:image/png;base64,aa" }]
  });
  assert.equal(stored.blocks[0].formulaTier, undefined);
  assert.equal(stored.blocks[0].formulaReason, undefined);
  assert.equal(stored.blocks[0].imageUrl, undefined);
});

test("new formula settings files do not fetch, confirm, or touch sealed inputs", () => {
  const files = [
    "lib/formula-settings.js",
    "lib/formula-settings-ui.js",
    "lib/formula-schedule.js",
    "options/options.js",
    "pdf/viewer.js",
    "tests/formula-settings.test.mjs"
  ];
  const sealed = ["held-" + "out", "prelabel-" + "judgments.json", "sealed " + "corpus"];
  for (const file of files) {
    const src = read(file);
    for (const needle of sealed) assert.equal(src.includes(needle), false, `${file} ${needle}`);
  }
  for (const file of ["lib/formula-settings.js", "lib/formula-settings-ui.js", "lib/formula-schedule.js"]) {
    const src = read(file);
    assert.equal(/\bfetch\s*\(/.test(src), false, file);
    assert.equal(src.includes("confirm("), false, file);
  }
});

class PhEl extends DomNode {
  constructor(tag) {
    super();
    this.tagName = String(tag || "").toUpperCase();
    this.attrs = {};
    this.className = "";
    this.type = "";
    this.title = "";
    this.dataset = {};
    this.styleProps = {};
    const self = this;
    this.style = {
      setProperty(name, value) {
        self.styleProps[name] = String(value);
      }
    };
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  addEventListener(type, fn) {
    this.listeners = this.listeners || {};
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
}

function phDocument() {
  return {
    createElement(tag) {
      return new PhEl(tag);
    },
    createElementNS(_ns, tag) {
      return new PhEl(tag);
    }
  };
}

function loadPlaceholderMount(document, getPageLayout, jumped) {
  const src = read("pdf/viewer.js");
  const start = src.indexOf("function placeholderCssNumber");
  const end = src.indexOf("function jumpFormulaPlaceholder");
  assert.ok(start > 0 && end > start);
  const factory = new Function(
    "placeholderCopy",
    "placeholderNativeBox",
    "placeholderCssLength",
    "getPageLayout",
    "document",
    "jumpFormulaPlaceholder",
    `${src.slice(start, end)}\nreturn mountFormulaPlaceholder;`
  );
  return factory(
    placeholderCopy,
    placeholderNativeBox,
    placeholderCssLength,
    getPageLayout,
    document,
    jumped
  );
}

function fractionBox(union, pageW, pageH) {
  return [union[0] / pageW, union[1] / pageH, union[2] / pageW, union[3] / pageH];
}

test("placeholder buttons append visible text for display and inline", () => {
  const document = phDocument();
  const jumped = [];
  const mount = loadPlaceholderMount(document, (page) => {
    if (Number(page) !== 7) return null;
    return { pageWidth: 612, pageHeight: 792 };
  }, (button) => jumped.push(button));
  const union = [162.89, 615.8, 504.67, 629.92];
  const displayHost = new PhEl("div");
  mount(displayHost, {
    label: "formula",
    bbox: fractionBox(union, 612, 792),
    eqLabel: "(3)",
    formulaReason: "crop-blank",
    imageUrl: "data:image/png;base64,abc",
    page: 7
  }, 7, false);
  const row = displayHost.childNodes[0];
  const button = row.childNodes.find((node) => node.tagName === "BUTTON");
  assert.notEqual(button.textContent.trim(), "");
  assert.match(button.textContent, /点击查看原公式/);
  assert.equal(button.textContent.includes("原文第"), false);
  assert.equal(button.textContent.includes("(3)"), false);
  assert.equal(button.getAttribute("aria-label"), "公式 (3) · 原文第 7 页 · 点击查看原公式");
  assert.equal(button.title, "");
  assert.equal(button.getAttribute("title"), null);
  assert.equal(button.dataset.oiTier, "placeholder");
  assert.equal(button.dataset.kind, "formula");
  assert.equal(button.dataset.oiReason, "crop-blank");
  assert.equal(button.dataset.oiBbox, "1");
  assert.equal(row.styleProps["--oi-ph-w"], "341.78px");
  assert.equal(row.styleProps["--oi-ph-h"], "14.12px");
  assert.equal(row.styleProps["--oi-ph-wn"], "341.78");
  assert.equal(row.childNodes.some((node) => node.className === "oi-pdf-eq-num"), false);
  assert.equal(row.childNodes.some((node) => String(node.className || "").includes("oi-formula-ph")), false);
  const visible = button.childNodes.find((node) => node.className === "oi-ph-text");
  assert.equal(visible.getAttribute("aria-hidden"), "true");
  assert.deepEqual(
    visible.childNodes.filter((node) => node.tagName === "SPAN").map((node) => node.textContent),
    ["点击查看原公式", "看原公式", "原公式"]
  );
  button.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(jumped.length, 1);

  const inlineHost = new PhEl("span");
  mount(inlineHost, {
    bbox: fractionBox([0, 0, 56, 11], 612, 792),
    page: 7
  }, 7, true);
  const inlineButton = inlineHost.childNodes[0];
  assert.equal(inlineButton.tagName, "BUTTON");
  assert.match(inlineButton.className, /is-inline/);
  assert.notEqual(inlineButton.textContent.trim(), "");
  assert.match(inlineButton.textContent, /看原公式/);
  assert.match(inlineButton.textContent, /原公式/);
  assert.equal(inlineButton.textContent.includes("原文第"), false);
  assert.equal(inlineButton.getAttribute("aria-label"), "行内公式 · 原文第 7 页 · 点击查看原公式");
  assert.equal(inlineButton.title, "");
  assert.equal(inlineButton.getAttribute("title"), null);
  assert.equal(inlineButton.styleProps["--oi-ph-w"], "56px");
  assert.equal(inlineButton.styleProps["--oi-ph-h"], "11px");
  assert.equal(inlineHost.childNodes.some((node) => node.className === "oi-pdf-eq-num"), false);

  const bare = new PhEl("div");
  mount(bare, { page: 4 }, 4, false);
  assert.equal(bare.childNodes[0].styleProps["--oi-ph-w"], "112px");
  assert.equal(bare.childNodes[0].styleProps["--oi-ph-h"], "32px");
  assert.equal(bare.childNodes[0].childNodes.find((node) => node.tagName === "BUTTON").dataset.oiBbox, "0");
  const bareInline = new PhEl("span");
  mount(bareInline, {}, null, true);
  assert.equal(bareInline.childNodes[0].styleProps["--oi-ph-w"], "20px");
  assert.equal(bareInline.childNodes[0].styleProps["--oi-ph-h"], "16px");
  assert.equal(bareInline.childNodes[0].getAttribute("aria-label"), "行内公式 · 点击查看原公式");
});

test("placeholder size follows displayFormulaWidthCss at ×1 and shortens copy by width", () => {
  const pageW = 612;
  const pageH = 792;
  const union = [162.89, 615.8, 504.67, 629.92];
  const bbox = fractionBox(union, pageW, pageH);
  const native = placeholderNativeBox({ bbox, pageWidth: pageW, pageHeight: pageH });
  assert.equal(placeholderCssLength(native.w), "341.78px");
  assert.equal(placeholderCssLength(native.h), "14.12px");
  assert.ok(union[0] + native.w >= 504.67 - 0.001);
  const frac = bbox[2] - bbox[0];
  const crop = displayFormulaWidthCss(frac, bbox[3] - bbox[1], { pageWidthPt: pageW, scale: 1.8, floor: 1.44 });
  assert.equal(crop, "max(492.1632px, min(100%, 615.204px))");
  assert.equal(crop.includes("455.7067px"), false);
  const wide = placeholderUsedBox({ w0: native.w, h0: native.h, column: 640 });
  assert.ok(Math.abs(wide.w - 341.78) <= 0.001);
  assert.equal(wide.h, 32);
  const col320 = placeholderUsedBox({ w0: native.w, h0: native.h, column: 320 });
  assert.equal(col320.w, 320);
  assert.equal(col320.h, 32);
  assert.deepEqual(placeholderUsedBox({ w0: 110, h0: 14, column: 640 }), { w: 112, h: 32 });
  assert.deepEqual(placeholderUsedBox({ w0: 150, h0: 20, column: 640 }), { w: 150, h: 32 });
  assert.deepEqual(placeholderUsedBox({ w0: 40, h0: 12, column: 640 }), { w: 112, h: 32 });
  const shrunk = placeholderUsedBox({ w0: 397, h0: 41, column: 360 });
  assert.equal(shrunk.w, 360);
  assert.ok(Math.abs(shrunk.h - (41 * 360 / 397)) < 0.001);
  const narrower = placeholderUsedBox({ w0: 397, h0: 41, column: 320 });
  assert.equal(narrower.w, 320);
  assert.ok(Math.abs(narrower.h - (41 * 320 / 397)) < 0.001);
  assert.deepEqual(placeholderUsedBox({ w0: 14, h0: 9, inline: true }), { w: 20, h: 16 });
  assert.deepEqual(placeholderUsedBox({ w0: 56, h0: 11, inline: true }), { w: 56, h: 16 });
  assert.deepEqual(placeholderUsedBox({ w0: 70, h0: 13, inline: true }), { w: 70, h: 16 });
  assert.equal(placeholderNativeBox({ bbox: null, pageWidth: pageW, pageHeight: pageH }), null);

  const css = read("pdf/viewer.css");
  assert.match(css, /@container\s+oi-ph\s+\(width\s*<\s*128px\)[\s\S]*?\.l0\s*\{\s*display:\s*none/);
  assert.match(css, /@container\s+oi-ph\s+\(width\s*<\s*128px\)[\s\S]*?\.l1\s*\{\s*display:\s*inline/);
  assert.match(css, /@container\s+oi-ph\s+\(width\s*<\s*64px\)[\s\S]*?\.l2\s*\{\s*display:\s*inline/);
  assert.match(css, /@container\s+oi-ph\s+\(width\s*<\s*52px\)[\s\S]*?\.oi-ph-icon\s*\{\s*display:\s*block/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.oi-formula-placeholder::after\s*\{[^}]*transition:\s*none/);
  assert.match(css, /\.oi-formula-placeholder:hover::after\s*\{[^}]*border-style:\s*solid/);
  const tokens = read("pdf/reader-tokens.css");
  assert.match(tokens, /\.oi-reader\[data-reader-theme="dark"\]/);
  assert.match(tokens, /--oi-reader-paper:\s*#1C1D1F/);
  assert.match(tokens, /--oi-reader-well:\s*#2A2B2E/);
  assert.match(tokens, /--oi-reader-line:\s*#3A3C40/);
  assert.match(tokens, /--oi-reader-line-strong:\s*#8A8F98/);
  assert.match(tokens, /--oi-reader-ink:\s*#E8E6E1/);
  assert.match(tokens, /--oi-reader-muted:\s*#A8A49B/);
  assert.match(tokens, /--oi-reader-focus:\s*#8FA8FF/);
  assert.deepEqual([...READER_THEMES], ["warm", "white", "sepia", "green"]);
  const jump = read("pdf/viewer.js");
  const jumpBody = jump.slice(jump.indexOf("function jumpFormulaPlaceholder"), jump.indexOf("function appendCropOrNotice"));
  assert.match(jumpBody, /presentSourceForJump\(button\)/);
  assert.match(jumpBody, /jumpTranslationToSource\(host\)/);
  assert.match(jumpBody, /revealSourcePage\(page\)/);
  assert.doesNotMatch(jumpBody, /placeholderCopy|--oi-ph-w|oi-ph-text/);
});

test("figure and table blocks stay off the formula placeholder path", async () => {
  const figure = await scheduleFormulaBlock({ label: "figure", id: "fig", imageUrl: "data:image/png;base64,abc" }, {
    placeholderEnabled: true,
    withRasterCrop: async (item) => item
  });
  assert.equal(figure.formulaTier, undefined);
  const table = await scheduleFormulaBlock({ label: "table", id: "tab" }, {
    placeholderEnabled: true,
    withRasterCrop: async (item) => item
  });
  assert.equal(table.formulaTier, undefined);
  const viewer = read("pdf/viewer.js");
  const append = viewer.slice(viewer.indexOf("function appendCropOrNotice"), viewer.indexOf("const visualCropPendingPages"));
  assert.match(append, /if \(block\?\.label === "formula" && block\.formulaTier === "placeholder"\) \{\s*mountFormulaPlaceholder\(node, block, shownPage, false\)/);
  assert.doesNotMatch(append, /label === "figure" && block\.formulaTier === "placeholder"/);
  assert.doesNotMatch(append, /label === "table" && block\.formulaTier === "placeholder"/);
});
