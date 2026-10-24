/**
 * glm-5.3-flash is the v1 multimodal default.
 * Fake endpoints only. No API key is written or logged.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createFormulaCache, isDurableFormulaResult } from "../lib/formula-cache.js";
import { resolveAskTarget } from "../lib/ask-route.js";
import {
  ARK_DIRECT_BASE_URL,
  ARK_PLAN_BASE_URL,
  ARK_PLAN_PAYG_HINT,
  FORMULA_ARK_BASE_NOTE,
  FORMULA_SETTINGS_KEY,
  LEGACY_DOUBAO_MODEL,
  MM_PRESET_GENERATION,
  defaultFormulaSettings,
  fixedVendorHostMismatch,
  modelChoice,
  multimodalProvider,
  normalizeFormulaSettings,
  readFormulaSettings
} from "../lib/formula-settings.js";
import { renderFormulaPanel } from "../lib/formula-settings-ui.js";
import { classifyMmDecision } from "../lib/formula-mm-ledger.js";
import { PROBE_PNG_BASE64 } from "../lib/mm-probe.js";
import { applyChatThinking } from "../lib/providers.js";
import { buildVisionRequest, classifyVisionError, multimodalTarget, sendVision } from "../lib/mm-client.js";
import { arkImagePlan, normalizeGlmRetryBody } from "../lib/mm-caps.js";
import { createNet, MM_ACCOUNT_CONCURRENCY } from "../lib/net/fetch.js";
import { readPngInfo } from "../lib/vision-png.js";

const ARK = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
const TINY = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const KEY_A = "account-a-not-a-real-key";
const KEY_B = "account-b-not-a-real-key";
const LITE = "doubao-seed-2-1-lite-260915";

class DomNode {
  constructor() {
    this.childNodes = [];
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
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
    this.dataset = {};
    this.className = "";
    this.disabled = false;
    this.value = "";
    this.type = "";
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) {
    return this.attrs[name];
  }
  addEventListener() {}
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
}

function glmTarget(model = "glm-5.3-flash") {
  return {
    provider: "doubao",
    model,
    url: ARK,
    host: "ark.cn-beijing.volces.com",
    shape: "openai"
  };
}

function netOf(handler, { random = () => 0, waits = null } = {}) {
  let now = 0;
  return createNet({
    clock: () => now,
    random,
    sleep(ms, signal) {
      if (ms >= 30000) {
        return new Promise((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (signal?.aborted) {
            fail();
            return;
          }
          signal?.addEventListener("abort", fail, { once: true });
        });
      }
      if (waits) waits.push(ms);
      now += ms;
      return Promise.resolve();
    },
    transport(url, init) {
      return handler(url, init);
    }
  });
}

test("glm omits thinking and uses reasoning_effort low; ark and kimi keep their fields", () => {
  const glm = buildVisionRequest(glmTarget(), {
    system: "只输出 LaTeX",
    text: "行内公式",
    images: [{ mime: "image/png", base64: PROBE_PNG_BASE64 }],
    secret: KEY_A,
    outputLimit: 200000
  });
  assert.equal(Object.hasOwn(glm.json, "thinking"), false);
  assert.equal(glm.json.reasoning_effort, "low");
  assert.equal(glm.json.temperature, 0);
  assert.equal(glm.json.max_tokens, 131072);
  assert.equal(glm.json.model, "glm-5.3-flash");

  const deepseek = buildVisionRequest({
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
    url: "https://api.deepseek.com/chat/completions",
    shape: "openai"
  }, {
    text: "独立公式",
    images: [{ mime: "image/png", base64: PROBE_PNG_BASE64 }],
    secret: KEY_A
  });
  assert.deepEqual(deepseek.json.thinking, { type: "disabled" });
  assert.equal(deepseek.json.reasoning_effort, "minimal");

  const doubao = buildVisionRequest({
    provider: "doubao",
    model: "doubao-seed-2-1-pro-260915",
    url: ARK,
    shape: "openai"
  }, {
    text: "独立公式",
    images: [{ mime: "image/png", base64: PROBE_PNG_BASE64 }],
    secret: KEY_A
  });
  assert.deepEqual(doubao.json.thinking, { type: "disabled" });
  assert.equal(doubao.json.reasoning_effort, "minimal");

  const kimi = buildVisionRequest({
    provider: "kimi",
    model: "kimi-k3",
    url: "https://api.moonshot.cn/v1/chat/completions",
    shape: "openai"
  }, {
    text: "行内公式",
    images: [{ mime: "image/png", base64: PROBE_PNG_BASE64 }],
    secret: KEY_A
  });
  assert.deepEqual(kimi.json.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(kimi.json, "reasoning_effort"), false);

  const translated = applyChatThinking({ model: "glm-5.3-flash" }, { baseUrl: ARK, deepThink: false });
  assert.equal(Object.hasOwn(translated, "thinking"), false);
  assert.equal(translated.reasoning_effort, "low");
  const thinkingOn = applyChatThinking({ model: "glm-5.3-flash" }, { baseUrl: ARK, deepThink: true });
  assert.equal(Object.hasOwn(thinkingOn, "thinking"), false);
  assert.equal(thinkingOn.reasoning_effort, "high");
});

test("a glm image under the Ark floor is padded; a legal image is unchanged", async () => {
  const seen = [];
  const net = netOf((_url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, data: { choices: [{ message: { content: "x" } }] } };
  });
  const tiny = await sendVision({
    target: glmTarget(),
    text: "行内公式",
    images: [{ mime: "image/png", base64: TINY }],
    secret: KEY_A,
    net
  });
  assert.equal(tiny.ok, true);
  const sent = seen[0].messages.at(-1).content[1].image_url.url.replace(/^data:image\/png;base64,/, "");
  const info = readPngInfo(sent);
  assert.ok(info.width >= 15 && info.height >= 15);
  assert.ok(info.width * info.height >= 196);
  assert.ok(info.width / info.height < 150);
  assert.equal(arkImagePlan(info.width, info.height), null);

  seen.length = 0;
  await sendVision({
    target: glmTarget(),
    text: "行内公式",
    images: [{ mime: "image/png", base64: PROBE_PNG_BASE64 }],
    secret: KEY_A,
    net
  });
  const legal = seen[0].messages.at(-1).content[1].image_url.url;
  assert.equal(legal, `data:image/png;base64,${PROBE_PNG_BASE64}`);
});

test("glm 400 InvalidParameter retries once, keeps reasoning_effort low, and does not switch model", async () => {
  const bodies = [];
  let calls = 0;
  const net = netOf((_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (calls === 1) {
      return {
        ok: false,
        status: 400,
        data: { error: { code: "InvalidParameter", message: "A parameter specified in the request is not valid" } }
      };
    }
    return { ok: true, status: 200, data: { choices: [{ message: { content: "E=mc^2" } }] } };
  });
  const result = await sendVision({
    target: glmTarget(),
    text: "行内公式",
    images: [{ mime: "image/png", base64: PROBE_PNG_BASE64 }],
    secret: KEY_A,
    net
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "E=mc^2");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].model, "glm-5.3-flash");
  assert.equal(bodies[0].reasoning_effort, "low");
  assert.equal(Object.hasOwn(bodies[0], "thinking"), false);
  assert.equal(bodies[1].model, "glm-5.3-flash");
  assert.equal(bodies[1].reasoning_effort, "low");
  assert.equal(Object.hasOwn(bodies[1], "thinking"), false);
  assert.equal(bodies[1].temperature, 0);
  assert.equal(JSON.stringify(bodies).includes(KEY_A), false);

  const normalized = normalizeGlmRetryBody({
    model: "glm-5.3-flash",
    temperature: 0,
    messages: [{ role: "user", content: "x" }],
    reasoning_effort: "low",
    thinking: { type: "disabled" },
    stream: true,
    extra: 1
  });
  assert.equal(normalized.reasoning_effort, "low");
  assert.equal(Object.hasOwn(normalized, "thinking"), false);
  assert.equal(Object.hasOwn(normalized, "stream"), false);
  assert.equal(Object.hasOwn(normalized, "extra"), false);
  assert.equal(normalized.temperature, 0);
  assert.equal(normalizeGlmRetryBody({ reasoning_effort: "minimal", thinking: { type: "disabled" } }).reasoning_effort, "low");
  assert.equal(normalizeGlmRetryBody({ reasoning_effort: "high" }).reasoning_effort, "high");
});

test("a 400 that is still invalid after the normalized retry is not a cached model failure", async () => {
  const net = netOf(() => ({
    ok: false,
    status: 400,
    data: { error: { code: "InvalidParameter", message: "A parameter specified in the request is not valid" } }
  }));
  const result = await sendVision({
    target: glmTarget(),
    text: "行内公式",
    images: [{ mime: "image/png", base64: PROBE_PNG_BASE64 }],
    secret: KEY_A,
    net
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "http");
  assert.equal(result.error.status, 400);
  const row = {
    tier: "multimodal",
    status: "error",
    reason: "http",
    meta: { visionCode: "http", cache: false }
  };
  assert.equal(isDurableFormulaResult(row), false);
  const commits = [];
  const cache = createFormulaCache({
    async getTier() {
      return null;
    },
    async commitTier(_key, record) {
      commits.push(record);
      return true;
    }
  });
  assert.equal(await cache.writeTier("unit:mm", row, { model: "glm-5.3-flash" }), false);
  assert.equal(commits.length, 0);
});

test("429 backs off with jitter or Retry-After, stays inside the account cap, and is not a model failure", async () => {
  assert.equal(MM_ACCOUNT_CONCURRENCY, 3);
  const honored = [];
  let honoredCalls = 0;
  const honoredNet = netOf(() => {
    honoredCalls += 1;
    if (honoredCalls === 1) return { ok: false, status: 429, headers: { "Retry-After": "2" } };
    return { ok: true, status: 200, data: { choices: [{ message: { content: "ok" } }] } };
  }, { waits: honored, random: () => 1 });
  const honoredResult = await honoredNet.fetch({
    url: ARK,
    method: "POST",
    purpose: "multimodal",
    headers: { Authorization: `Bearer ${KEY_A}` },
    json: { model: "glm-5.3-flash" },
    timeoutMs: false
  });
  assert.equal(honoredResult.ok, true);
  assert.equal(honoredResult.attempts, 2);
  assert.deepEqual(honored, [2000]);

  const jitter = [];
  let jitterCalls = 0;
  const jitterNet = netOf(() => {
    jitterCalls += 1;
    if (jitterCalls === 1) return { ok: false, status: 429, headers: {} };
    return { ok: true, status: 200, data: {} };
  }, { waits: jitter, random: () => 1 });
  await jitterNet.fetch({
    url: ARK,
    method: "POST",
    purpose: "multimodal",
    headers: { Authorization: `Bearer ${KEY_A}` },
    json: { model: "glm-5.3-flash" },
    timeoutMs: false
  });
  assert.deepEqual(jitter, [100]);

  const full = [];
  let fullCalls = 0;
  const fullNet = netOf(() => {
    fullCalls += 1;
    if (fullCalls === 1) return { ok: false, status: 429 };
    return { ok: true, status: 200, data: {} };
  }, { waits: full, random: () => 0 });
  await fullNet.fetch({
    url: ARK,
    method: "POST",
    purpose: "multimodal",
    headers: { Authorization: `Bearer ${KEY_A}` },
    json: { model: "glm-5.3-flash" },
    timeoutMs: false
  });
  assert.deepEqual(full, [200]);

  const active = new Map();
  const gates = [];
  const lane = createNet({
    transport(_url, init) {
      const account = init.headers.Authorization;
      active.set(account, (active.get(account) || 0) + 1);
      return new Promise((resolve) => {
        gates.push(() => {
          active.set(account, active.get(account) - 1);
          resolve({ ok: true, status: 200, data: {} });
        });
      });
    }
  });
  const pending = [];
  for (let i = 0; i < 5; i += 1) {
    pending.push(lane.fetch({
      url: ARK,
      method: "POST",
      purpose: "multimodal",
      headers: { Authorization: `Bearer ${KEY_A}` },
      json: { n: i },
      timeoutMs: false,
      retry: false
    }));
  }
  for (let i = 0; i < 20 && gates.length < 3; i += 1) await Promise.resolve();
  assert.equal(gates.length, 3);
  assert.equal(active.get(`Bearer ${KEY_A}`), 3);
  const other = lane.fetch({
    url: ARK,
    method: "POST",
    purpose: "multimodal",
    headers: { Authorization: `Bearer ${KEY_B}` },
    json: {},
    timeoutMs: false,
    retry: false
  });
  for (let i = 0; i < 20 && gates.length < 4; i += 1) await Promise.resolve();
  assert.equal(gates.length, 4);
  assert.equal(active.get(`Bearer ${KEY_B}`), 1);
  gates[0]();
  for (let i = 0; i < 20 && gates.length < 5; i += 1) await Promise.resolve();
  assert.equal(gates.length, 5);
  assert.ok(active.get(`Bearer ${KEY_A}`) <= 3);
  const all = Promise.all([...pending, other]);
  let settled = false;
  all.then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  for (let turn = 0; turn < 8 && !settled; turn += 1) {
    const batch = gates.splice(0, gates.length);
    for (const gate of batch) gate();
    await Promise.resolve();
  }
  await all;

  const limited = {
    tier: "multimodal",
    status: "error",
    reason: "cooldown",
    meta: { visionCode: "429", cache: false, summary: "额度或限流" }
  };
  assert.equal(isDurableFormulaResult(limited), false);
  const decision = classifyMmDecision({
    trace: [limited],
    chosen: { tier: "crop", status: "ok", render: "image" },
    decidedAt: 1
  }, { sent: 1 });
  assert.equal(decision.failure, null);
  assert.equal(decision.sent, 1);
});

test("new installs default to glm-5.3-flash and an explicit saved model stays", async () => {
  const fresh = defaultFormulaSettings();
  assert.equal(fresh.multimodal.provider, "doubao");
  assert.equal(fresh.multimodal.model, "glm-5.3-flash");
  assert.equal(fresh.multimodal.presetGeneration, MM_PRESET_GENERATION);
  assert.equal(fresh["formula.tier2.enabled"], false);
  assert.deepEqual(multimodalProvider("doubao").models, ["glm-5.3-flash", "deepseek-v4.1-flash"]);
  assert.deepEqual(modelChoice(fresh), { mode: "select", select: "glm-5.3-flash", custom: "" });
  assert.equal(multimodalTarget(fresh).model, "glm-5.3-flash");

  const emptyStore = {
    async get() {
      return {};
    }
  };
  const installed = await readFormulaSettings(emptyStore);
  assert.equal(installed.multimodal.model, "glm-5.3-flash");

  const explicit = normalizeFormulaSettings({
    multimodal: { provider: "doubao", apiKey: KEY_A, model: "doubao-seed-2-1-lite-260915" }
  });
  assert.equal(explicit.multimodal.model, LITE);
  assert.equal(explicit.multimodal.provider, "doubao");
  assert.equal(explicit.multimodal.customModel, false);

  const implicitOld = normalizeFormulaSettings({
    multimodal: { provider: "doubao", apiKey: KEY_A, model: "" }
  });
  assert.equal(implicitOld.multimodal.model, LEGACY_DOUBAO_MODEL);
  assert.equal(implicitOld.multimodal.customModel, true);

  const other = normalizeFormulaSettings({
    multimodal: { provider: "openai", apiKey: KEY_A, model: "gpt-5.6-luna" }
  });
  assert.equal(other.multimodal.provider, "openai");
  assert.equal(other.multimodal.model, "gpt-5.6-luna");

  const saved = await readFormulaSettings({
    async get() {
      return {
        formulaSettings: {
          multimodal: { provider: "kimi", apiKey: KEY_A, model: "kimi-k3" },
          "formula.tier2.enabled": true
        }
      };
    }
  });
  assert.equal(saved.multimodal.provider, "kimi");
  assert.equal(saved.multimodal.model, "kimi-k3");
  assert.equal(saved["formula.tier2.enabled"], true);

  assert.equal(fresh.multimodal.baseUrl, "");
  assert.equal(multimodalProvider("doubao").baseUrl, ARK_PLAN_BASE_URL);
  assert.equal(multimodalProvider("deepseek").baseUrl, "https://api.deepseek.com");
  assert.equal(multimodalTarget(fresh).url, `${ARK_PLAN_BASE_URL}/chat/completions`);
  assert.equal(multimodalTarget({
    multimodal: { provider: "doubao", model: "deepseek-v4.1-flash", baseUrl: "" }
  }).url, `${ARK_PLAN_BASE_URL}/chat/completions`);
});

test("a saved Ark Base URL stays, and an empty one uses the plan endpoint", async () => {
  const direct = {
    multimodal: {
      provider: "doubao",
      apiKey: KEY_A,
      model: "glm-5.3-flash",
      baseUrl: ARK_DIRECT_BASE_URL
    }
  };
  const kept = normalizeFormulaSettings(direct);
  assert.equal(kept.multimodal.baseUrl, ARK_DIRECT_BASE_URL);
  assert.equal(kept.multimodal.model, "glm-5.3-flash");
  assert.equal(multimodalTarget(direct).url, `${ARK_DIRECT_BASE_URL}/chat/completions`);
  assert.equal(fixedVendorHostMismatch(direct), false);
  const loaded = await readFormulaSettings({
    async get() {
      return { [FORMULA_SETTINGS_KEY]: direct };
    }
  });
  assert.equal(loaded.multimodal.baseUrl, ARK_DIRECT_BASE_URL);

  const llm = {
    provider: "openai",
    providers: { openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" } }
  };
  const planAsk = resolveAskTarget(llm, {
    multimodal: { provider: "doubao", apiKey: KEY_A, model: "deepseek-v4.1-flash", baseUrl: "" }
  });
  assert.equal(planAsk.via, "multimodal");
  assert.equal(planAsk.model, "deepseek-v4.1-flash");
  assert.equal(planAsk.url, `${ARK_PLAN_BASE_URL}/chat/completions`);
  const directAsk = resolveAskTarget(llm, direct);
  assert.equal(directAsk.url, `${ARK_DIRECT_BASE_URL}/chat/completions`);
  const translation = resolveAskTarget(llm, { multimodal: { provider: "", apiKey: "" } });
  assert.equal(translation.via, "translation");
  assert.equal(translation.url, "https://api.openai.com/v1/chat/completions");

  const previous = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      return new DomEl(tag);
    },
    createTextNode(text) {
      return { textContent: String(text ?? "") };
    }
  };
  try {
    const panel = new DomEl("div");
    renderFormulaPanel(panel, defaultFormulaSettings(), {});
    const inputs = [];
    walk(panel, (node) => {
      if (node.tagName === "INPUT") inputs.push(node);
    });
    const base = inputs.find((input) => input.attrs["data-base-url"]);
    assert.equal(base.placeholder, ARK_PLAN_BASE_URL);
    assert.equal(base.value, "");
    assert.equal(panel.textContent.includes(FORMULA_ARK_BASE_NOTE), true);
    assert.equal(panel.textContent.includes(ARK_DIRECT_BASE_URL), true);
  } finally {
    globalThis.document = previous;
  }
});

test("a saved doubao-seed lite model is shown as that model, not as glm", async () => {
  const raw = {
    multimodal: { provider: "doubao", apiKey: KEY_A, model: LITE, customModel: false }
  };
  const stored = normalizeFormulaSettings(raw);
  assert.equal(stored.multimodal.model, LITE);
  assert.equal(stored.multimodal.customModel, false);
  assert.deepEqual(modelChoice(raw), { mode: "select", select: "__custom", custom: LITE });
  assert.equal(multimodalTarget(raw).model, LITE);

  const loaded = await readFormulaSettings({
    async get(key) {
      assert.equal(key, FORMULA_SETTINGS_KEY);
      return { [FORMULA_SETTINGS_KEY]: raw };
    }
  });
  assert.equal(loaded.multimodal.model, LITE);
  assert.equal(loaded.multimodal.customModel, false);
  assert.notEqual(loaded.multimodal.model, "glm-5.3-flash");

  const previous = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      return new DomEl(tag);
    },
    createTextNode(text) {
      return { textContent: String(text ?? "") };
    }
  };
  try {
    const panel = new DomEl("div");
    renderFormulaPanel(panel, raw, {});
    const selects = [];
    const inputs = [];
    walk(panel, (node) => {
      if (node.tagName === "SELECT") selects.push(node);
      if (node.tagName === "INPUT") inputs.push(node);
    });
    assert.equal(selects[0].value, "doubao");
    assert.equal(selects[1].value, "__custom");
    assert.notEqual(selects[1].value, "glm-5.3-flash");
    const optionValues = [];
    walk(selects[1], (node) => {
      if (node.tagName === "OPTION") optionValues.push(node.value);
    });
    assert.deepEqual(optionValues, ["", "glm-5.3-flash", "deepseek-v4.1-flash", "__custom"]);
    assert.equal(inputs.some((input) => input.value === LITE), true);
    assert.equal(inputs.some((input) => input.value === "glm-5.3-flash"), false);
    assert.match(panel.textContent, /自定义模型/);
  } finally {
    globalThis.document = previous;
  }
});

test("a 401 from the default plan Base URL names /api/v3; a direct or other host does not", async () => {
  const planUrl = `${ARK_PLAN_BASE_URL}/chat/completions`;
  const directUrl = `${ARK_DIRECT_BASE_URL}/chat/completions`;
  const denied = () => ({
    ok: false,
    status: 401,
    data: { error: { message: "AuthenticationError" } }
  });
  const plan = await sendVision({
    target: { ...glmTarget(), url: planUrl },
    text: "行内公式",
    images: [{ mime: "image/png", base64: PROBE_PNG_BASE64 }],
    secret: KEY_A,
    net: netOf(denied)
  });
  assert.equal(plan.error.code, "401");
  assert.equal(plan.error.summary, ARK_PLAN_PAYG_HINT);
  assert.match(plan.error.summary, /\/api\/v3/);
  assert.equal(plan.error.summary.includes(KEY_A), false);
  assert.ok(plan.error.summary.length <= 80);

  const direct = await sendVision({
    target: glmTarget(),
    text: "行内公式",
    images: [{ mime: "image/png", base64: PROBE_PNG_BASE64 }],
    secret: KEY_A,
    net: netOf(denied)
  });
  assert.equal(direct.error.code, "401");
  assert.match(direct.error.summary, /AuthenticationError/);
  assert.equal(direct.error.summary.includes("按量"), false);
  assert.equal(directUrl.endsWith("/api/v3/chat/completions"), true);

  const other = classifyVisionError({
    status: 401,
    data: { error: { message: "invalid" } },
    url: "https://api.openai.com/v1/chat/completions"
  });
  assert.equal(other.error.summary, "invalid");
  const missing = classifyVisionError({ status: 401, data: { error: { message: "paper9z" } } });
  assert.equal(missing.error.summary, "paper9z");
});
