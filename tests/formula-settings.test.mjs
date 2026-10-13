import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cacheableLayout } from "../lib/pdf-layout-client.js";
import { DEFAULT_SETTINGS } from "../lib/storage.js";
import { multimodalTier } from "../lib/formula-tiers/multimodal.js";
import { ocrTier } from "../lib/formula-tiers/ocr.js";
import { scheduleFormulaBlock } from "../lib/formula-schedule.js";
import {
  FORMULA_ORDER,
  FORMULA_PRIVACY_NOTE,
  FORMULA_SETTINGS_AREA,
  FORMULA_SETTINGS_KEY,
  FORMULA_SWITCH_KEYS,
  MULTIMODAL_PROVIDERS,
  OCR_PROVIDERS,
  classifyFormulaProbe,
  defaultFormulaSettings,
  formulaChainFlags,
  formulaOrderText,
  multimodalReady,
  multimodalTestDisabled,
  normalizeFormulaSettings,
  ocrSwitchState,
  placeholderCopy,
  probeClock,
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

test("FUI-03 providers list six vendors plus custom, and DeepSeek cannot be chosen", () => {
  assert.equal(MULTIMODAL_PROVIDERS.length, 7);
  assert.deepEqual(MULTIMODAL_PROVIDERS.map((item) => item.id), [
    "openai", "gemini", "deepseek", "doubao", "kimi", "grok", "custom"
  ]);
  const deepseek = MULTIMODAL_PROVIDERS.find((item) => item.id === "deepseek");
  assert.equal(deepseek.vision, false);
  assert.equal(deepseek.unavailable, "DeepSeek · 暂不可用（不能看图）");
  installDocument();
  const panel = new DomEl("div");
  renderFormulaPanel(panel, defaultFormulaSettings(), {});
  const labels = [];
  walk(panel, (node) => {
    if (node.tagName === "OPTION" && node.value === "deepseek") labels.push(node);
  });
  assert.equal(labels.length, 1);
  assert.equal(labels[0].disabled, true);
  assert.equal(labels[0].textContent, "DeepSeek · 暂不可用（不能看图）");
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
  assert.equal(stub.chip, "暂不可用");
  const src = read("lib/formula-settings.js") + read("lib/formula-settings-ui.js");
  assert.equal(/\bfetch\s*\(/.test(src), false);
  assert.equal(src.includes("confirm("), false);
});

test("FUI-09 FUI-10 FUI-11 FUI-12 switch visibility follows configuration, not a failed probe", () => {
  installDocument();
  const blind = normalizeFormulaSettings({
    multimodal: { provider: "deepseek", apiKey: "sk-secret" },
    [FORMULA_SWITCH_KEYS.tier2]: true
  });
  assert.equal(tier2SwitchState(blind).visible, false);
  assert.match(tier2SwitchState(blind).message, /不支持看图/);
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
  assert.equal(placeholderCopy({ page: 4, eqLabel: "(3)" }, { inline: false }), "公式 (3) · 原文第 4 页");
  assert.equal(placeholderCopy({ page: 4, eqLabel: "3" }, { inline: false }), "公式 (3) · 原文第 4 页");
  assert.equal(placeholderCopy({ page: 4 }, { inline: false }), "公式 · 原文第 4 页");
  assert.equal(placeholderCopy({ page: 4 }, { inline: true }), "〔公式 · 原文第 4 页〕");
  assert.equal(placeholderCopy({ page: null }, { inline: false }), "公式 · 原文");
  assert.equal(placeholderCopy({ page: null }, { inline: true }), "〔公式 · 原文〕");
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
  assert.match(html, /data-nav="formula"[^>]*>多模态 · OCR</);
  assert.match(html, /id="panel-formula"/);
  assert.match(html, /引用公式时用「多模态 · OCR」里的模型/);
  assert.doesNotMatch(html.match(/id="panel-reading"[\s\S]*?<\/section>/)[0], /formulaSettings|用多模态模型补全公式/);
  assert.match(viewer, /id="aaFormulaSwitches"/);
  assert.match(viewer, /id="aaFormulaSettings"[^>]*>公式设置…/);
  assert.match(viewerJs, /formulaChainFlags\(formulaViewerSettings/);
  assert.match(viewerJs, /placeholderEnabled: formulaFlags\.placeholderEnabled/);
  assert.match(viewerJs, /readCropImage: formulaFlags\.placeholderEnabled \? readFormulaCropImage/);
  assert.match(viewerJs, /data-oi-tier/);
  assert.equal(viewerJs.includes("innerHTML"), false);
  assert.match(css, /\.oi-formula-placeholder\s*\{[^}]*min-height:\s*52px/);
  assert.match(css, /\.oi-formula-ph-thumb\s*\{[^}]*height:\s*28px/);
  assert.match(css, /\.oi-formula-ph-thumb\s*\{[^}]*max-width:\s*168px/);
  assert.match(css, /\.oi-formula-ph-missing\s*\{[^}]*width:\s*96px/);
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
