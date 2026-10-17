/**
 * F7-PR2 multimodal connectivity probe.
 *
 * 交付前刁钻自测:
 * 1. 并发 — 两个标签页交错写 formulaSettings，探测结果只落到还没过期的那一页。
 * 2. 页面生命周期 — pagehide / drop() 中止在途探测，回来的结果不写存储。
 * 3. 新旧版本兼容 — 不适用（Wisdom 决定不做旧后台兼容）。
 * 4. 失败与回滚 — 401/403/404/429/超时/不能看图/网络错误；空 Base URL 不写入；失败芯片留下。
 * 5. 边界输入 — 未实测厂商、空 Base URL、超长摘要、密钥混进摘要、大小写厂商名。
 * 6. 交付要求 — 先红后绿。删掉保存端或读取端的校验、空地址拒绝、过期结果丢弃，对应测试变红。
 *
 * 不变量（随机测试每一步都检查）:
 * ① 密钥不出现在 sync、日志、探测摘要、请求 URL 和去掉 apiKey 之后的存储里。
 * ② 中止或过期的探测不写入存储。
 * ③ 换厂商、模型、密钥、Base URL，或卸载之后，旧配置不再被当成这次探测的结果写下。
 * ④ 本 PR 不写公式缓存；写下的探测记录属于刚刚仍有效的那次调用。
 * ⑤ 一次成功的探测不会被更早那次的迟到结果覆盖。
 * ⑥ 探测不和问 AI 共用可变队列（mm-probe 没有队列）。
 * ⑦ 本 PR 不调用自研算法或矢量重绘。
 *
 * 中断点见 lib/mm-probe.js 文件头。每个点在下面有单独的对抗测试。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

import { createNet, installNet } from "../lib/net/fetch.js";
import { sendVision } from "../lib/mm-client.js";
import {
  PROBE_PNG_BASE64,
  createProbeController,
  probeMultimodal,
  settleProbeResult
} from "../lib/mm-probe.js";
import {
  CUSTOM_BASE_URL_ERROR,
  FORMULA_SETTINGS_KEY,
  MULTIMODAL_PROVIDERS,
  acceptStoredFormulaSettings,
  applyFormulaPart,
  customBaseUrlError,
  defaultFormulaSettings,
  isProvenVisionProvider,
  readFormulaSettings,
  removeFormulaKey,
  writeFormulaSettings
} from "../lib/formula-settings.js";
import { commitProviderSelect, renderFormulaPanel } from "../lib/formula-settings-ui.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function patchSelectValue(document) {
  const proto = Object.getPrototypeOf(document.createElement("select"));
  if (proto._oiValuePatched) return;
  Object.defineProperty(proto, "value", {
    configurable: true,
    get() { return this._value ?? ""; },
    set(next) { this._value = String(next ?? ""); }
  });
  proto._oiValuePatched = true;
}
const read = (path) => readFileSync(join(root, path), "utf8");
const SECRET = "mm-probe-secret-value";
const PNG = PROBE_PNG_BASE64;

function memoryStorage(initial = {}) {
  const bag = { ...initial };
  return {
    bag,
    async get(key) {
      if (typeof key !== "string") return { ...bag };
      return { [key]: bag[key] };
    },
    async set(patch) {
      Object.assign(bag, structuredClone(patch));
    }
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function responseNet(handler, { sleep } = {}) {
  const seen = [];
  const logs = [];
  const net = createNet({
    log: (row) => logs.push(row),
    random: () => 0,
    sleep: sleep || ((ms) => (ms < 1000 ? Promise.resolve() : new Promise(() => {}))),
    transport(url, init) {
      const hit = {
        url,
        headers: { ...(init?.headers || {}) },
        body: String(init?.body || ""),
        signal: init?.signal
      };
      seen.push(hit);
      return Promise.resolve().then(() => handler(hit, seen));
    }
  });
  return { seen, logs, net };
}

function openaiSettings(extra = {}) {
  return {
    multimodal: {
      provider: "openai",
      apiKey: SECRET,
      model: "gpt-5.6-luna",
      baseUrl: "",
      ...extra
    }
  };
}

function assertNoSecret(value, secret = SECRET, label = "secret leaked") {
  assert.equal(JSON.stringify(value).includes(secret), false, label);
}

test("DeepSeek stays unproven and is not opened by this probe", () => {
  const deepseek = MULTIMODAL_PROVIDERS.find((item) => item.id === "deepseek");
  assert.equal(deepseek.vision, false);
  assert.equal(deepseek.visionBasis, "docs");
  assert.equal(deepseek.unavailable, "DeepSeek · 待实测");
  assert.equal(isProvenVisionProvider("deepseek"), false);
  assert.equal(isProvenVisionProvider("DeepSeek"), false);
  assert.equal(isProvenVisionProvider("openai"), true);
  const src = read("lib/formula-settings.js");
  const chunk = src.slice(src.indexOf('id: "deepseek"'), src.indexOf('id: "doubao"'));
  assert.match(chunk, /vision:\s*false/);
  assert.equal(chunk.includes("vision: true"), false);
  assert.equal(/\bfetch\s*\(/.test(read("lib/mm-probe.js")), false);
  const sealed = ["held-" + "out", "prelabel-" + "judgments.json"];
  for (const needle of sealed) {
    assert.equal(read("lib/mm-probe.js").includes(needle), false);
    assert.equal(src.includes(needle), false);
  }
});

test("read strips an unproven provider before it becomes effective", async () => {
  const local = memoryStorage({
    [FORMULA_SETTINGS_KEY]: {
      multimodal: { provider: "deepseek", apiKey: SECRET, model: "deepseek-flash", probe: { ok: true, chip: "已连通", code: "ok", at: 1 } }
    }
  });
  const readBack = await readFormulaSettings(local);
  assert.equal(readBack.multimodal.provider, "");
  assert.equal(readBack.multimodal.probe, null);
  assert.equal(readBack.multimodal.apiKey, SECRET);
  assert.equal(local.bag[FORMULA_SETTINGS_KEY].multimodal.provider, "deepseek");
  const odd = await readFormulaSettings(memoryStorage({
    [FORMULA_SETTINGS_KEY]: { multimodal: { provider: "DeepSeek", apiKey: SECRET } }
  }));
  assert.equal(odd.multimodal.provider, "");
});

test("write strips an unproven provider before storage.set", async () => {
  const local = memoryStorage();
  const saved = await writeFormulaSettings({
    multimodal: { provider: "deepseek", apiKey: SECRET, model: "deepseek-flash" },
    "formula.tier2.enabled": true
  }, local);
  assert.equal(saved.multimodal.provider, "");
  assert.equal(local.bag[FORMULA_SETTINGS_KEY].multimodal.provider, "");
  assert.equal(local.bag[FORMULA_SETTINGS_KEY].multimodal.apiKey, SECRET);
  assert.equal(local.bag[FORMULA_SETTINGS_KEY]["formula.tier2.enabled"], true);
  assert.equal(JSON.stringify(local.bag).includes('"provider":"deepseek"'), false);
});

test("applyFormulaPart refuses a DeepSeek patch and keeps the previous vendor", () => {
  const prior = acceptStoredFormulaSettings(openaiSettings());
  const next = applyFormulaPart(prior, "multimodal", {
    provider: "deepseek",
    model: "",
    customModel: false,
    baseUrl: ""
  });
  assert.equal(next.multimodal.provider, "openai");
  assert.equal(next.multimodal.apiKey, SECRET);
  const direct = acceptStoredFormulaSettings({
    multimodal: { provider: "deepseek", apiKey: SECRET, model: "deepseek-flash" }
  });
  assert.equal(direct.multimodal.provider, "");
});

test("commitProviderSelect drops a script-selected disabled DeepSeek option", () => {
  const { document } = parseHTML("<!doctype html><select></select>");
  patchSelectValue(document);
  const select = document.querySelector("select");
  for (const [value, disabled] of [["", false], ["openai", false], ["deepseek", true]]) {
    const option = document.createElement("option");
    option.value = value;
    option.disabled = disabled;
    select.append(option);
  }
  select.value = "deepseek";
  const refused = commitProviderSelect(select, "openai");
  assert.equal(refused.ok, false);
  assert.equal(select.value, "openai");
  select.value = "";
  const cleared = commitProviderSelect(select, "openai");
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value, "");
});

test("the settings select does not save DeepSeek when script selectOption fires change", () => {
  const { document, window } = parseHTML("<!doctype html><div id='root'></div>");
  const previous = globalThis.document;
  globalThis.document = document;
  patchSelectValue(document);
  const calls = [];
  try {
    const panel = document.getElementById("root");
    renderFormulaPanel(panel, openaiSettings(), {
      onMultimodal: (patch) => calls.push(patch)
    });
    const select = panel.querySelector("select");
    select.value = "deepseek";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(calls.length, 0);
    assert.equal(select.value, "openai");
    select.value = "qwen";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(calls.at(-1).provider, "qwen");
  } finally {
    globalThis.document = previous;
  }
});

test("an empty custom Base URL renders an inline error", () => {
  const { document } = parseHTML("<!doctype html><div id='root'></div>");
  const previous = globalThis.document;
  globalThis.document = document;
  patchSelectValue(document);
  try {
    const panel = document.getElementById("root");
    renderFormulaPanel(panel, {
      multimodal: { provider: "custom", apiKey: SECRET, model: "m", customModel: true, baseUrl: "   " }
    }, {});
    const input = panel.querySelector("[data-base-url]");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.match(panel.textContent, /请填写 Base URL/);
    assert.equal(panel.querySelector("[data-base-url-error]").textContent, CUSTOM_BASE_URL_ERROR);
    renderFormulaPanel(panel, {
      multimodal: { provider: "custom", apiKey: SECRET, model: "m", baseUrl: "https://vendor.example/v1" }
    }, {});
    assert.equal(panel.querySelector("[data-base-url-error]"), null);
  } finally {
    globalThis.document = previous;
  }
});

test("write refuses to store an empty custom Base URL", async () => {
  const local = memoryStorage({
    [FORMULA_SETTINGS_KEY]: {
      multimodal: { provider: "openai", apiKey: SECRET, model: "gpt-5.6-luna", baseUrl: "" }
    }
  });
  await assert.rejects(
    () => writeFormulaSettings({
      multimodal: { provider: "custom", apiKey: SECRET, model: "m", customModel: true, baseUrl: "  " }
    }, local),
    (err) => err?.code === "base-url-required"
  );
  assert.equal(local.bag[FORMULA_SETTINGS_KEY].multimodal.provider, "openai");
  const kept = memoryStorage({
    [FORMULA_SETTINGS_KEY]: {
      multimodal: { provider: "custom", apiKey: SECRET, model: "m", baseUrl: "https://vendor.example/v1" }
    }
  });
  const saved = await writeFormulaSettings({
    multimodal: { provider: "custom", apiKey: SECRET, model: "m", baseUrl: "" },
    "formula.tier3.enabled": true
  }, kept);
  assert.equal(saved.multimodal.baseUrl, "https://vendor.example/v1");
  assert.equal(kept.bag[FORMULA_SETTINGS_KEY].multimodal.baseUrl, "https://vendor.example/v1");
  assert.equal(kept.bag[FORMULA_SETTINGS_KEY]["formula.tier3.enabled"], true);
  const already = memoryStorage({
    [FORMULA_SETTINGS_KEY]: {
      multimodal: { provider: "custom", apiKey: SECRET, model: "m", baseUrl: "" }
    }
  });
  const again = await writeFormulaSettings({
    ...already.bag[FORMULA_SETTINGS_KEY],
    "formula.tier3.enabled": true
  }, already);
  assert.equal(again["formula.tier3.enabled"], true);
  assert.equal(customBaseUrlError(again), CUSTOM_BASE_URL_ERROR);
});

test("probe sends the built-in PNG through sendVision and classifies the real Response", async () => {
  const box = responseNet(() => jsonResponse(200, {
    choices: [{ message: { content: "SEEN" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }));
  const at = Date.parse("2026-10-17T02:32:00Z");
  const probe = await probeMultimodal(openaiSettings(), { secret: SECRET, net: box.net, at });
  assert.equal(probe.ok, true);
  assert.equal(probe.chip, "已连通");
  assert.equal(probe.code, "ok");
  assert.equal(probe.summary, "");
  assert.equal(box.seen.length, 1);
  const body = JSON.parse(box.seen[0].body);
  assert.equal(body.messages.at(-1).content.some((part) => part.image_url?.url === `data:image/png;base64,${PNG}`), true);
  assert.equal(box.seen[0].headers.Authorization, `Bearer ${SECRET}`);
  assertNoSecret(box.logs);
  assert.equal(JSON.stringify(probe).includes(SECRET), false);

  const gemini = responseNet(() => jsonResponse(200, {
    candidates: [{ content: { parts: [{ text: "SEEN" }] } }]
  }));
  const geminiProbe = await probeMultimodal({
    multimodal: { provider: "gemini", apiKey: SECRET, model: "gemini-3.8-flash" }
  }, { secret: SECRET, net: gemini.net, at });
  assert.equal(geminiProbe.chip, "已连通");
  const geminiBody = JSON.parse(gemini.seen[0].body);
  assert.equal(geminiBody.contents[0].parts[1].inline_data.data, PNG);
  assert.equal(gemini.seen[0].headers["x-goog-api-key"], SECRET);
});

test("probe classifies 401, 403, 404, 429, no-vision, timeout, and network from real results", async () => {
  const cases = [
    [401, "密钥无效 (401)", "401"],
    [403, "无权限 (403)", "403"],
    [404, "地址或模型不对 (404)", "404"],
    [429, "额度或限流 (429)", "429"]
  ];
  for (const [status, chip, code] of cases) {
    const box = responseNet(() => jsonResponse(status, { error: { message: `nope ${SECRET} ${"x".repeat(120)}` } }));
    const probe = await probeMultimodal(openaiSettings(), { secret: SECRET, net: box.net });
    assert.equal(probe.chip, chip, String(status));
    assert.equal(probe.code, code);
    assert.equal(probe.summary.includes(SECRET), false);
    assert.ok(probe.summary.length <= 80);
  }
  const blind = responseNet(() => jsonResponse(400, { error: { message: `${SECRET} does not support image input` } }));
  const noVision = await probeMultimodal(openaiSettings(), { secret: SECRET, net: blind.net });
  assert.equal(noVision.chip, "这个模型不能看图");
  assert.equal(noVision.code, "no-vision");
  assert.equal(noVision.summary.toLowerCase().includes(SECRET), false);

  const textBlind = responseNet(() => jsonResponse(200, { choices: [{ message: { content: "NO_IMAGE" } }] }));
  const fromText = await probeMultimodal(openaiSettings(), { secret: SECRET, net: textBlind.net });
  assert.equal(fromText.code, "no-vision");

  const timed = createNet({
    log: () => {},
    random: () => 0,
    sleep(ms) { return Promise.resolve(); void ms; },
    transport(_url, init) {
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener("abort", fail, { once: true });
      });
    }
  });
  const timeout = await probeMultimodal(openaiSettings(), { secret: SECRET, net: timed });
  assert.equal(timeout.chip, "超时");
  assert.equal(timeout.code, "timeout");

  const broken = responseNet(() => {
    const error = new TypeError("fetch failed");
    error.code = "ECONNRESET";
    throw error;
  });
  const network = await probeMultimodal(openaiSettings(), { secret: SECRET, net: broken.net });
  assert.equal(network.chip, "网络错误");
  assert.equal(network.code, "network");
  assert.equal(network.summary.includes(SECRET), false);
});

test("a local server receives the probe PNG and a 401 Response is not a shortcut object", async () => {
  let captured = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      captured = {
        raw: Buffer.concat(chunks).toString("utf8"),
        authorization: req.headers.authorization
      };
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `bad ${SECRET}` } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const seen = [];
    const net = createNet({
      log: (row) => seen.push(row),
      random: () => 0,
      sleep: (ms) => (ms < 1000 ? Promise.resolve() : new Promise(() => {})),
      transport(url, init) {
        assert.equal(url.startsWith(`http://127.0.0.1:${port}/`), true);
        return fetchLocal(url, init);
      }
    });
    const probe = await probeMultimodal({
      multimodal: {
        provider: "custom",
        apiKey: SECRET,
        model: "local-vision",
        customModel: true,
        baseUrl: `http://127.0.0.1:${port}/v1`
      }
    }, { secret: SECRET, net });
    assert.equal(captured.raw.includes(PNG), true);
    assert.equal(captured.raw.includes(SECRET), false);
    assert.equal(captured.authorization, `Bearer ${SECRET}`);
    assert.equal(probe.chip, "密钥无效 (401)");
    assert.equal(probe.summary.includes(SECRET), false);
    assertNoSecret(seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function fetchLocal(url, init) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const httpReq = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: init?.method || "POST",
      headers: init?.headers
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(new Response(text, {
          status: res.statusCode,
          headers: { "content-type": res.headers["content-type"] || "application/json" }
        }));
      });
    });
    httpReq.on("error", reject);
    httpReq.end(init?.body || "");
  });
}

test("interrupt before send does not call the client", async () => {
  let calls = 0;
  const sendVision = async () => {
    calls += 1;
    return { ok: true, text: "SEEN" };
  };
  const controller = new AbortController();
  controller.abort();
  const aborted = await probeMultimodal(openaiSettings(), { signal: controller.signal, sendVision, secret: SECRET });
  assert.equal(calls, 0);
  assert.equal(aborted.code, "aborted");
  const current = { live: false };
  const stale = await probeMultimodal(openaiSettings(), {
    stillCurrent: () => current.live,
    sendVision,
    secret: SECRET
  });
  assert.equal(calls, 0);
  assert.equal(stale.code, "aborted");
});

test("interrupt after the key is read does not send the built-in PNG", async () => {
  let live = true;
  const box = responseNet(() => jsonResponse(200, { choices: [{ message: { content: "SEEN" } }] }));
  const probe = await probeMultimodal(openaiSettings(), {
    secret: SECRET,
    net: box.net,
    readSecret: async () => {
      live = false;
      return SECRET;
    },
    stillCurrent: () => live
  });
  assert.equal(box.seen.length, 0);
  assert.equal(probe.code, "aborted");
  assert.equal(probe.summary.includes(SECRET), false);
});

test("interrupt after a successful vision result still discards it", async () => {
  let live = true;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const send = async () => {
    await gate;
    return { ok: true, text: "SEEN" };
  };
  const pending = probeMultimodal(openaiSettings(), {
    secret: SECRET,
    stillCurrent: () => live,
    sendVision: send
  });
  live = false;
  release();
  const probe = await pending;
  assert.equal(probe.code, "aborted");
  assert.equal(probe.ok, false);
  assert.notEqual(probe.chip, "已连通");
});

test("settleProbeResult does not store an aborted or stale probe", () => {
  const settings = acceptStoredFormulaSettings(openaiSettings());
  const ok = { ok: true, chip: "已连通", code: "ok", summary: "", at: 1 };
  const stale = settleProbeResult(settings, ok, { still: false });
  assert.equal(stale.write, false);
  assert.equal(stale.settings.multimodal.probe, null);
  const aborted = settleProbeResult(settings, { ok: false, chip: "已中止", code: "aborted", summary: "", at: 2 }, { still: true });
  assert.equal(aborted.write, false);
  const fresh = settleProbeResult(settings, ok, { still: true });
  assert.equal(fresh.write, true);
  assert.equal(fresh.settings.multimodal.probe.chip, "已连通");
  const late = settleProbeResult(fresh.settings, { ok: false, chip: "超时", code: "timeout", summary: "late", at: 9 }, { still: false });
  assert.equal(late.write, false);
  assert.equal(late.settings.multimodal.probe.chip, "已连通");
});

test("createProbeController drop aborts the open signal and invalidates current()", () => {
  const ctl = createProbeController();
  const first = ctl.open();
  const second = ctl.open();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.current(), false);
  assert.equal(second.current(), true);
  ctl.drop();
  assert.equal(second.signal.aborted, true);
  assert.equal(second.current(), false);
});

test("an unproven vendor and an empty custom URL do not send", async () => {
  let calls = 0;
  const sendVision = async () => {
    calls += 1;
    return { ok: true, text: "SEEN" };
  };
  const deepseek = await probeMultimodal({
    multimodal: { provider: "deepseek", apiKey: SECRET, model: "deepseek-flash" }
  }, { sendVision, secret: SECRET });
  assert.equal(calls, 0);
  assert.equal(deepseek.ok, false);
  assert.equal(isProvenVisionProvider("deepseek"), false);
  const empty = await probeMultimodal({
    multimodal: { provider: "custom", apiKey: SECRET, model: "m", baseUrl: "" }
  }, { sendVision, secret: SECRET });
  assert.equal(calls, 0);
  assert.match(empty.summary, /Base URL/);
});

test("a stored probe summary that contains the key is not rendered", () => {
  const { document } = parseHTML("<!doctype html><div id='root'></div>");
  const previous = globalThis.document;
  globalThis.document = document;
  patchSelectValue(document);
  try {
    const panel = document.getElementById("root");
    renderFormulaPanel(panel, {
      ...openaiSettings(),
      "formula.tier2.enabled": true,
      multimodal: {
        ...openaiSettings().multimodal,
        probe: { ok: false, chip: "密钥无效 (401)", code: "401", summary: `bad ${SECRET} tail`, at: Date.now() }
      }
    }, {});
    assert.equal(panel.textContent.includes(SECRET), false);
    assert.match(panel.textContent, /最近失败 · 密钥无效 \(401\)/);
    assert.match(panel.textContent, /失败的公式已改用后面的级别/);
    assert.equal(panel.querySelector("[data-probe-summary]").textContent.includes(SECRET), false);
  } finally {
    globalThis.document = previous;
  }
});

test("failed probe stays visible when the tier-2 switch is hidden", () => {
  const { document } = parseHTML("<!doctype html><div id='root'></div>");
  const previous = globalThis.document;
  globalThis.document = document;
  patchSelectValue(document);
  try {
    const panel = document.getElementById("root");
    renderFormulaPanel(panel, {
      multimodal: {
        provider: "openai",
        apiKey: "",
        probe: { ok: false, chip: "超时", code: "timeout", summary: "late", at: Date.parse("2026-10-17T02:00:00Z") }
      }
    }, {});
    assert.match(panel.textContent, /最近失败 · 超时/);
    assert.match(panel.textContent, /需先配置多模态模型/);
  } finally {
    globalThis.document = previous;
  }
});

test("options page: selectOption, empty Base URL, probe, and unload", async () => {
  const { document, window } = parseHTML(readFileSync(join(root, "options/options.html"), "utf8").replace(/<script\b[\s\S]*?<\/script>/g, ""));
  patchSelectValue(document);
  const bag = {
    [FORMULA_SETTINGS_KEY]: {
      multimodal: {
        provider: "custom",
        apiKey: SECRET,
        model: "local-vision",
        customModel: true,
        baseUrl: "https://vendor.example/v1"
      }
    }
  };
  const sync = { settings: { provider: "openai", providers: {}, features: { pdf: true } } };
  const listeners = [];
  function area(store, name) {
    return {
      async get(key) {
        if (typeof key !== "string") return { ...store };
        return { [key]: store[key] };
      },
      async set(patch) {
        Object.assign(store, structuredClone(patch));
        const changes = {};
        for (const [item, value] of Object.entries(patch)) changes[item] = { newValue: value };
        if (name === "local") {
          for (const listener of listeners) listener(changes, name);
        }
      }
    };
  }
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    chrome: globalThis.chrome,
    navigator: globalThis.navigator,
    Event: globalThis.Event,
    BroadcastChannel: globalThis.BroadcastChannel
  };
  const seen = [];
  let release = () => {};
  let gate = Promise.resolve();
  installNet(createNet({
    random: () => 0,
    sleep: (ms) => (ms < 1000 ? Promise.resolve() : new Promise(() => {})),
    log: () => {},
    transport(url, init) {
      seen.push({ url, body: String(init?.body || ""), headers: { ...(init?.headers || {}) } });
      return gate.then(() => jsonResponse(200, { choices: [{ message: { content: "SEEN" } }] }));
    }
  }));
  try {
    globalThis.document = document;
    globalThis.window = window;
    globalThis.Event = window.Event;
    globalThis.CustomEvent = window.CustomEvent;
    globalThis.location = { hash: "#mm" };
    globalThis.history = { replaceState() {} };
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
    globalThis.BroadcastChannel = class { postMessage() {} close() {} };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request(_name, options, callback) {
            if (typeof options === "function") callback = options;
            return Promise.resolve(callback({ name: "formula", mode: "exclusive" }));
          }
        }
      }
    });
    window.location = globalThis.location;
    globalThis.OI_OPTIONS_MANUAL = true;
    globalThis.chrome = {
      runtime: {
        getManifest: () => ({ version: "0.0.0" }),
        getURL: (path) => path,
        async sendMessage(message) {
          if (message?.type === "OI_GET_SETTINGS") return { ok: true, settings: sync.settings };
          if (message?.type === "OI_SAVE_SETTINGS") return { ok: true, settings: sync.settings };
          return { ok: true };
        }
      },
      storage: {
        local: area(bag, "local"),
        sync: area(sync, "sync"),
        onChanged: { addListener(fn) { listeners.push(fn); } }
      },
      tabs: { create() {} }
    };
    const { startOptions } = await import("../options/options.js");
    await startOptions();
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    const card = document.querySelector("[data-formula-card='mm']");
    const select = card.querySelector("select");
    assert.equal(select.value, "custom");
    select.value = "deepseek";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    assert.equal(select.value, "custom");
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.provider, "custom");

    gate = new Promise((resolve) => { release = resolve; });
    const button = document.querySelector("[data-formula-action='mm']");
    assert.equal(button.disabled, false);
    button.click();
    for (let i = 0; i < 40 && seen.length === 0; i += 1) await Promise.resolve();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.includes(PNG), true);
    assert.equal(seen[0].headers.Authorization, `Bearer ${SECRET}`);
    window.dispatchEvent(new window.Event("pagehide"));
    release();
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    assert.notEqual(bag[FORMULA_SETTINGS_KEY].multimodal.probe?.ok, true);

    const base = document.querySelector("[data-base-url]");
    base.value = "";
    base.dispatchEvent(new window.Event("change", { bubbles: true }));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    assert.match(document.getElementById("formulaSettingsRoot").textContent, /请填写 Base URL/);
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.baseUrl, "https://vendor.example/v1");
    assertNoSecret(seen.map((hit) => ({ url: hit.url, body: hit.body })));
  } finally {
    installNet(null);
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.location = previous.location;
    globalThis.history = previous.history;
    globalThis.localStorage = previous.localStorage;
    globalThis.chrome = previous.chrome;
    globalThis.Event = previous.Event;
    globalThis.BroadcastChannel = previous.BroadcastChannel;
    if (previous.navigator) {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: previous.navigator });
    }
  }
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fingerprint(settings) {
  const mm = settings?.multimodal || {};
  return [mm.provider, mm.model, mm.baseUrl, mm.apiKey].join("\n");
}

async function runSeed(seed) {
  const rand = mulberry32(seed);
  const secret = `probe-secret-${seed}-zz`;
  const bag = {};
  const syncBag = {};
  const logs = [];
  const requests = [];
  const storage = {
    async get(key) {
      if (typeof key !== "string") return { ...bag };
      return { [key]: bag[key] };
    },
    async set(patch) {
      Object.assign(bag, structuredClone(patch));
    }
  };
  const net = createNet({
    log: (row) => logs.push(row),
    random: () => 0,
    sleep: (ms) => (ms < 1000 ? Promise.resolve() : new Promise(() => {})),
    transport(url, init) {
      const hit = { url, body: String(init?.body || ""), headers: { ...(init?.headers || {}) } };
      requests.push({ url: hit.url, body: hit.body });
      return new Promise((resolve, reject) => {
        if (!world.inflight) {
          reject(Object.assign(new Error("no inflight"), { code: "http" }));
          return;
        }
        world.inflight.pending.push({ resolve, reject, hit });
      });
    }
  });
  const tabs = [0, 1].map(() => ({
    memory: defaultFormulaSettings(),
    ctl: createProbeController()
  }));
  const world = { inflight: null, writes: [] };

  function assertStep(step) {
    const stored = bag[FORMULA_SETTINGS_KEY];
    const provider = stored?.multimodal?.provider || "";
    if (provider && !isProvenVisionProvider(provider)) {
      throw new Error(`seed ${seed} step ${step} unproven provider ${provider}`);
    }
    const summary = stored?.multimodal?.probe?.summary || "";
    if (summary.includes(secret) || summary.length > 80) {
      throw new Error(`seed ${seed} step ${step} summary leak`);
    }
    if (stored) {
      const clone = structuredClone(stored);
      if (clone.multimodal) clone.multimodal.apiKey = "";
      if (clone.ocr) clone.ocr.apiKey = "";
      if (JSON.stringify(clone).includes(secret)) throw new Error(`seed ${seed} step ${step} key outside apiKey`);
    }
    const dump = JSON.stringify({ syncBag, logs, requests, summary });
    if (dump.includes(secret)) throw new Error(`seed ${seed} step ${step} secret in public dump`);
    for (const tab of tabs) {
      if (tab.memory?.multimodal?.provider === "deepseek") {
        throw new Error(`seed ${seed} step ${step} tab holds deepseek`);
      }
    }
  }

  async function drainInflight() {
    const flight = world.inflight;
    if (!flight) return;
    for (let guard = 0; guard < 6; guard += 1) {
      const queued = flight.pending.splice(0);
      if (!queued.length) break;
      for (const hit of queued) {
        hit.reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted" }));
      }
      await Promise.resolve();
    }
    flight.tab.ctl.drop();
    await flight.task;
    world.inflight = null;
  }

  async function finish(kind) {
    const flight = world.inflight;
    if (!flight || !flight.pending.length) return;
    const hit = flight.pending.shift();
    if (kind === "ok") hit.resolve(jsonResponse(200, { choices: [{ message: { content: "SEEN" } }] }));
    else if (kind === "401") hit.resolve(jsonResponse(401, { error: { message: `bad ${secret}` } }));
    else if (kind === "429") hit.resolve(jsonResponse(429, { error: { message: "slow down" } }));
    else if (kind === "novision") hit.resolve(jsonResponse(400, { error: { message: "does not support image input" } }));
    else if (kind === "timeout") hit.reject(Object.assign(new Error("timeout"), { name: "TimeoutError", code: "timeout" }));
    else hit.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }));
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    if (!flight.pending.length) {
      await flight.task;
      if (world.inflight === flight) world.inflight = null;
    }
  }

  const events = [
    "openai", "key", "model", "probe", "ok", "401", "429", "novision", "timeout", "network",
    "deepseek-select", "deepseek-write", "read", "custom-empty", "custom-url", "remove-key",
    "toggle", "unload", "retry", "other-tab"
  ];

  for (let step = 0; step < 24; step += 1) {
    const index = Math.floor(rand() * tabs.length);
    const tab = tabs[index];
    const event = events[Math.floor(rand() * events.length)];
    if (event === "openai") {
      tab.ctl.drop();
      tab.memory = applyFormulaPart(tab.memory, "multimodal", { provider: "openai", model: "gpt-5.6-luna", customModel: false, baseUrl: "" });
      await writeFormulaSettings(tab.memory, storage);
    } else if (event === "key") {
      tab.ctl.drop();
      tab.memory = applyFormulaPart(tab.memory, "multimodal", { apiKey: secret });
      if (!customBaseUrlError(tab.memory)) await writeFormulaSettings(tab.memory, storage);
    } else if (event === "model") {
      tab.ctl.drop();
      tab.memory = applyFormulaPart(tab.memory, "multimodal", { model: rand() < 0.5 ? "gpt-5.4-mini" : "typed-model", customModel: true });
      if (!customBaseUrlError(tab.memory)) await writeFormulaSettings(tab.memory, storage);
    } else if (event === "probe") {
      if (!world.inflight) {
        const fp = fingerprint(tab.memory);
        const run = tab.ctl.open();
        const flight = { tab, pending: [], task: null };
        world.inflight = flight;
        flight.task = probeMultimodal(tab.memory, {
          signal: run.signal,
          stillCurrent: () => run.current() && fingerprint(tab.memory) === fp,
          secret: tab.memory.multimodal.apiKey || secret,
          net
        }).then(async (probe) => {
          const before = structuredClone(bag[FORMULA_SETTINGS_KEY] || null);
          const settled = settleProbeResult(tab.memory, probe, {
            still: run.current() && fingerprint(tab.memory) === fp
          });
          if (!settled.write) {
            if (before && bag[FORMULA_SETTINGS_KEY]) {
              assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal?.probe?.at, before.multimodal?.probe?.at);
            }
            return;
          }
          tab.memory = settled.settings;
          try {
            await writeFormulaSettings(settled.settings, storage);
            world.writes.push({
              provider: settled.settings.multimodal.provider,
              baseUrl: settled.settings.multimodal.baseUrl,
              introduced: false,
              at: probe.at
            });
          } catch (err) {
            if (err?.code !== "base-url-required") throw err;
          }
        });
        for (let i = 0; i < 16 && flight.pending.length === 0; i += 1) await Promise.resolve();
        if (!flight.pending.length) {
          await flight.task;
          if (world.inflight === flight) world.inflight = null;
        }
      }
    } else if (event === "ok" || event === "401" || event === "429" || event === "novision" || event === "timeout" || event === "network" || event === "retry") {
      const kind = event === "retry" ? "401" : event;
      await finish(kind);
    } else if (event === "deepseek-select") {
      tab.ctl.drop();
      const next = applyFormulaPart(tab.memory, "multimodal", { provider: "deepseek", model: "", customModel: false, baseUrl: "" });
      assert.notEqual(next.multimodal.provider, "deepseek");
      tab.memory = next;
    } else if (event === "deepseek-write") {
      tab.ctl.drop();
      await writeFormulaSettings({
        ...tab.memory,
        multimodal: { ...tab.memory.multimodal, provider: "deepseek", apiKey: secret }
      }, storage);
      const readBack = await readFormulaSettings(storage);
      assert.notEqual(readBack.multimodal.provider, "deepseek");
      tab.memory = readBack;
    } else if (event === "read") {
      bag[FORMULA_SETTINGS_KEY] = {
        multimodal: { provider: "deepseek", apiKey: secret, model: "deepseek-flash", baseUrl: "" }
      };
      const readBack = await readFormulaSettings(storage);
      assert.equal(readBack.multimodal.provider, "");
      tab.memory = readBack;
      if (world.inflight) world.inflight.tab.memory = readBack;
      await writeFormulaSettings(readBack, storage);
    } else if (event === "custom-empty") {
      tab.ctl.drop();
      const before = structuredClone(bag[FORMULA_SETTINGS_KEY] || null);
      const draft = applyFormulaPart(tab.memory, "multimodal", { provider: "custom", model: "m", customModel: true, baseUrl: "   " });
      assert.equal(customBaseUrlError(draft), CUSTOM_BASE_URL_ERROR);
      tab.memory = draft;
      try {
        await writeFormulaSettings(draft, storage);
      } catch (err) {
        if (err?.code !== "base-url-required") throw err;
      }
      const after = bag[FORMULA_SETTINGS_KEY];
      const introduced = after?.multimodal?.provider === "custom"
        && !String(after?.multimodal?.baseUrl || "").trim()
        && !(before?.multimodal?.provider === "custom" && !String(before?.multimodal?.baseUrl || "").trim());
      if (introduced) throw new Error(`seed ${seed} step ${step} empty base url saved`);
    } else if (event === "custom-url") {
      tab.ctl.drop();
      tab.memory = applyFormulaPart(tab.memory, "multimodal", {
        provider: "custom",
        model: "m",
        customModel: true,
        baseUrl: "https://vendor.example/v1"
      });
      await writeFormulaSettings(tab.memory, storage);
    } else if (event === "remove-key") {
      tab.ctl.drop();
      tab.memory = removeFormulaKey(tab.memory, "multimodal");
      if (!customBaseUrlError(tab.memory)) await writeFormulaSettings(tab.memory, storage);
    } else if (event === "toggle") {
      tab.ctl.drop();
      const enabled = rand() < 0.5;
      const draft = acceptStoredFormulaSettings({ ...tab.memory, "formula.tier2.enabled": enabled });
      tab.memory = draft;
      const toWrite = customBaseUrlError(draft)
        ? acceptStoredFormulaSettings({ ...(await readFormulaSettings(storage)), "formula.tier2.enabled": enabled })
        : draft;
      try {
        await writeFormulaSettings(toWrite, storage);
      } catch (err) {
        if (err?.code !== "base-url-required") throw err;
      }
    } else if (event === "unload") {
      tab.ctl.drop();
      await drainInflight();
    } else if (event === "other-tab") {
      const other = tabs[1 - index];
      other.ctl.drop();
      other.memory = applyFormulaPart(other.memory, "multimodal", { provider: "qwen", model: "qwen3-vl-plus", customModel: false, baseUrl: "" });
      await writeFormulaSettings({ ...other.memory, multimodal: { ...other.memory.multimodal, apiKey: secret } }, storage);
      tab.memory = await readFormulaSettings(storage);
      if (world.inflight) world.inflight.tab.memory = tab.memory;
    }
    assertStep(step);
  }
  for (const tab of tabs) tab.ctl.drop();
  await drainInflight();
  assertStep("end");
  assert.equal(isProvenVisionProvider("deepseek"), false);
}

test("500 seeds cover two tabs, in-flight edits, unload, and retry", async () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    try {
      await runSeed(seed);
    } catch (err) {
      err.message = `seed ${seed}: ${err.message}`;
      throw err;
    }
  }
});

test("default probe client is sendVision, not a private shortcut", () => {
  const src = read("lib/mm-probe.js");
  assert.match(src, /deps\.sendVision \|\| sendVision/);
  assert.match(src, /PROBE_PNG_BASE64/);
  assert.equal(sendVision.name, "sendVision");
  const options = read("options/options.js");
  assert.match(options, /probeMultimodal\(formulaSettings/);
  assert.match(options, /settleProbeResult\(/);
  assert.match(options, /customBaseUrlError\(formulaSettings\)/);
  assert.match(options, /acceptStoredFormulaSettings\(changes\[FORMULA_SETTINGS_KEY\]\.newValue\)/);
  assert.match(options, /pagehide/);
});
