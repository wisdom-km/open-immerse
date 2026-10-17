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
import { connect as connectTcp } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseHTML } from "linkedom";

import { createNet, installNet } from "../lib/net/fetch.js";
import { sendVision } from "../lib/mm-client.js";
import {
  PROBE_PNG_BASE64,
  confirmsSeen,
  createProbeController,
  probeMultimodal,
  settleProbeResult
} from "../lib/mm-probe.js";
import { resolveAskTarget } from "../lib/ask-route.js";
import * as askRoute from "../lib/ask-route.js";
import * as mmProbe from "../lib/mm-probe.js";
import { createAskSession } from "../lib/ask-session.js";
import { multimodalTier } from "../lib/formula-tiers/multimodal.js";
import { selfTier } from "../lib/formula-tiers/self.js";
import { vectorTier } from "../lib/formula-tiers/vector.js";
import {
  CUSTOM_BASE_URL_ERROR,
  FORMULA_SETTINGS_KEY,
  FORMULA_SWITCH_KEYS,
  MULTIMODAL_PROVIDERS,
  acceptStoredFormulaSettings,
  applyFormulaPart,
  customBaseUrlError,
  defaultFormulaSettings,
  formulaChainFlags,
  httpBaseUrl,
  normalizedBaseUrl,
  isProvenVisionProvider,
  multimodalReady,
  readFormulaSettings,
  redactProbeText,
  removeFormulaKey,
  tierActive,
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

test("a 200 is connected only when the whole reply is SEEN", async () => {
  const replies = [
    ["", "这个模型不能看图"],
    ["I cannot see the image.", "这个模型不能看图"],
    ["我看不到图片", "这个模型不能看图"],
    ["NO_IMAGE.", "这个模型不能看图"],
    ["Sorry, I can only process text.", "这个模型不能看图"],
    ["not seen", "这个模型不能看图"],
    ["I have not seen the image", "这个模型不能看图"],
    ["Seen? No.", "这个模型不能看图"],
    ["No, not SEEN", "这个模型不能看图"],
    ["Not SEEN.", "这个模型不能看图"],
    ["never seen", "这个模型不能看图"],
    ["I haven't seen any image", "这个模型不能看图"],
    ["seen: false", "这个模型不能看图"],
    ["SEEN NO_IMAGE", "这个模型不能看图"],
    ["NO_IMAGE SEEN", "这个模型不能看图"],
    ["没有 SEEN", "这个模型不能看图"],
    ["我无法看到图片，所以不能回复 SEEN", "这个模型不能看图"],
    ["If I could see it I would say SEEN, but NO_IMAGE", "这个模型不能看图"],
    ["UNSEEN", "这个模型不能看图"],
    ["SEENING", "这个模型不能看图"],
    ["I have seen it", "这个模型不能看图"],
    ["SEEN（看见了）", "这个模型不能看图"],
    ["¬SEEN", "这个模型不能看图"],
    ["SEEN 👍", "这个模型不能看图"],
    ["SEEN", "已连通"],
    ["  SeEn!  ", "已连通"],
    ["seen.", "已连通"],
    ["**SEEN**", "已连通"],
    ["`SEEN`", "已连通"],
    ["「SEEN」", "已连通"],
    ["- SEEN", "已连通"],
    ["SEEN\n", "已连通"]
  ];
  for (const [text, chip] of replies) {
    const box = responseNet(() => jsonResponse(200, { choices: [{ message: { content: text } }] }));
    const probe = await probeMultimodal(openaiSettings(), { secret: SECRET, net: box.net });
    assert.equal(probe.chip, chip, JSON.stringify(text));
    assert.equal(probe.ok, chip === "已连通", JSON.stringify(text));
    assert.equal(probe.summary.includes(SECRET), false);
  }
  assert.equal(confirmsSeen("seen."), true);
  assert.equal(confirmsSeen("unseen"), false);
  assert.equal(confirmsSeen("SEENING"), false);
  assert.equal(confirmsSeen("not seen"), false);
  assert.equal(confirmsSeen("¬SEEN"), false);
  assert.equal(confirmsSeen("**SEEN**"), true);
  assert.equal(confirmsSeen("「SEEN」"), true);
});

test("a key-read failure is not classified as a network error", async () => {
  const probe = await probeMultimodal(openaiSettings(), {
    secret: SECRET,
    readSecret: async () => {
      throw new Error(`cannot read ${SECRET}`);
    }
  });
  assert.notEqual(probe.code, "network");
  assert.notEqual(probe.chip, "网络错误");
  assert.equal(probe.chip, "暂不可用");
  assert.equal(probe.summary.includes(SECRET), false);
});

test("a thrown send stays a failure", async () => {
  const probe = await probeMultimodal(openaiSettings(), {
    secret: SECRET,
    sendVision: async () => {
      throw new Error("probe send failed");
    }
  });
  assert.equal(probe.ok, false);
  assert.notEqual(probe.chip, "已连通");
  assert.notEqual(probe.code, "network");
});

test("Bearer keys and mixed-case secrets are stripped from the summary", async () => {
  const token = "sk-Live-Token";
  const secret = `Bearer ${token}`;
  const box = responseNet(() => jsonResponse(200, {
    choices: [{ message: { content: `NO_IMAGE ${token} ${token.toUpperCase()}` } }]
  }));
  const probe = await probeMultimodal(openaiSettings({ apiKey: secret }), { secret, net: box.net });
  assert.equal(probe.code, "no-vision");
  assert.equal(probe.summary.toLowerCase().includes(token.toLowerCase()), false);
  const mixed = "AbCsecret";
  assert.equal(redactProbeText(`prefix ${mixed} ABCSECRET suffix`, mixed).toLowerCase().includes("abcsecret"), false);
});

function loopbackUnavailable(err) {
  const code = String(err?.code || err?.cause?.code || "");
  return ["EPERM", "EACCES", "EADDRNOTAVAIL", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAFNOSUPPORT", "EINVAL"].includes(code);
}

test("a local server receives the probe PNG and a 401 Response is not a shortcut object", async (t) => {
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
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (err) {
    t.skip(`loopback 不可用（${err?.code || err?.message}），本沙箱不能开 127.0.0.1 套接字，跳过本地服务探测。`);
    return;
  }
  const { port } = server.address();
  try {
    try {
      await preflightLoopback(port);
    } catch (err) {
      if (loopbackUnavailable(err)) {
        t.skip(`loopback 不可用（${err.code || err.message}），本沙箱不能连接 127.0.0.1，跳过本地服务探测。`);
        return;
      }
      throw err;
    }
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

function preflightLoopback(port) {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", fail);
  });
}

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

test("a saved connection is dropped when the vendor or model changes", async () => {
  const connected = {
    ...openaiSettings(),
    "formula.tier2.enabled": true,
    multimodal: {
      ...openaiSettings().multimodal,
      probe: { ok: true, chip: "已连通", code: "ok", summary: "", at: 5 }
    }
  };
  const otherModel = applyFormulaPart(connected, "multimodal", { model: "gpt-5.4-mini", customModel: false });
  assert.equal(otherModel.multimodal.probe, null);
  assert.equal(otherModel.multimodal.model, "gpt-5.4-mini");
  const otherVendor = applyFormulaPart(connected, "multimodal", {
    provider: "qwen",
    model: "qwen3-vl-plus",
    customModel: false,
    baseUrl: ""
  });
  assert.equal(otherVendor.multimodal.provider, "qwen");
  assert.equal(otherVendor.multimodal.probe, null);
  const sameKey = applyFormulaPart(connected, "multimodal", { apiKey: `${SECRET}-2` });
  assert.equal(sameKey.multimodal.probe.chip, "已连通");
  const local = memoryStorage({ [FORMULA_SETTINGS_KEY]: connected });
  const written = await writeFormulaSettings({
    ...connected,
    multimodal: { ...connected.multimodal, model: "gpt-5.4-mini" }
  }, local);
  assert.equal(written.multimodal.probe, null);
  assert.equal(local.bag[FORMULA_SETTINGS_KEY].multimodal.probe, null);
});

test("a saved connection is dropped when the Base URL changes", async () => {
  const connected = {
    "formula.tier2.enabled": true,
    multimodal: {
      provider: "custom",
      apiKey: SECRET,
      model: "local-vision",
      customModel: true,
      baseUrl: "https://vendor.example/v1",
      probe: { ok: true, chip: "已连通", code: "ok", summary: "", at: 5 }
    }
  };
  const moved = applyFormulaPart(connected, "multimodal", { baseUrl: "https://other.example/v1" });
  assert.equal(moved.multimodal.baseUrl, "https://other.example/v1");
  assert.equal(moved.multimodal.probe, null);
  const slash = applyFormulaPart(connected, "multimodal", { baseUrl: "https://vendor.example/v1/" });
  assert.equal(slash.multimodal.probe.chip, "已连通");
  assert.equal(normalizedBaseUrl("https://vendor.example/v1/"), normalizedBaseUrl("https://vendor.example/v1"));
  const queried = applyFormulaPart(connected, "multimodal", { baseUrl: "https://vendor.example/v1?" });
  assert.equal(queried.multimodal.probe, null);
  assert.notEqual(normalizedBaseUrl("https://vendor.example/v1?"), normalizedBaseUrl("https://vendor.example/v1"));
  assert.equal(httpBaseUrl("https:///x"), "");
  assert.equal(httpBaseUrl("https://."), "");
  assert.equal(httpBaseUrl("http://0"), "");
  assert.equal(httpBaseUrl("https://127.0.0.1/v1"), "https://127.0.0.1/v1");
  const local = memoryStorage({ [FORMULA_SETTINGS_KEY]: connected });
  const written = await writeFormulaSettings({
    ...connected,
    multimodal: { ...connected.multimodal, baseUrl: "https://other.example/v1" }
  }, local);
  assert.equal(written.multimodal.probe, null);
  assert.equal(written.multimodal.baseUrl, "https://other.example/v1");
});

test("a stored empty custom URL accepts switch toggles and key edits only", async () => {
  const already = memoryStorage({
    [FORMULA_SETTINGS_KEY]: {
      multimodal: {
        provider: "custom",
        apiKey: SECRET,
        model: "m",
        customModel: true,
        baseUrl: "",
        probe: null
      }
    }
  });
  const written = await writeFormulaSettings({
    multimodal: {
      provider: "custom",
      apiKey: "sk-other",
      model: "other-model",
      customModel: true,
      baseUrl: "vendor.example/v1",
      probe: { ok: true, chip: "已连通", code: "ok", summary: "", at: 9 }
    },
    "formula.tier2.enabled": true,
    "formula.ocr.enabled": true
  }, already);
  assert.equal(written["formula.tier2.enabled"], true);
  assert.equal(written["formula.ocr.enabled"], true);
  assert.equal(written.multimodal.provider, "custom");
  assert.equal(written.multimodal.model, "m");
  assert.equal(written.multimodal.apiKey, "sk-other");
  assert.equal(written.multimodal.baseUrl, "");
  assert.equal(written.multimodal.probe, null);
  assert.equal(customBaseUrlError(written), CUSTOM_BASE_URL_ERROR);
  const cleared = await writeFormulaSettings({
    ...written,
    multimodal: {
      ...written.multimodal,
      apiKey: "",
      model: "nope",
      baseUrl: "",
      probe: { ok: true, chip: "已连通", code: "ok", summary: "", at: 11 }
    }
  }, already);
  assert.equal(cleared.multimodal.apiKey, "");
  assert.equal(cleared.multimodal.model, "m");
  assert.equal(cleared.multimodal.baseUrl, "");
  assert.equal(cleared.multimodal.probe, null);
});

test("a bearer token that crosses the summary clip is fully redacted", async () => {
  const token = `tok_LIVE_${"abc".repeat(30)}`;
  const secret = `Bearer ${token}`;
  const box = responseNet(() => jsonResponse(401, {
    error: { message: `${"n".repeat(70)}${token}` }
  }));
  const probe = await probeMultimodal(openaiSettings({ apiKey: secret }), { secret, net: box.net });
  assert.equal(probe.summary.length <= 80, true);
  assert.equal(probe.summary.includes("tok_"), false);
  assert.equal(probe.summary.toLowerCase().includes(token.slice(0, 8).toLowerCase()), false);
});

test("only a fetch TypeError is a network failure", async () => {
  const fetched = await probeMultimodal(openaiSettings(), {
    secret: SECRET,
    sendVision: async () => {
      throw new TypeError("fetch failed");
    }
  });
  assert.equal(fetched.code, "network");
  assert.equal(fetched.chip, "网络错误");
  const bug = await probeMultimodal(openaiSettings(), {
    secret: SECRET,
    sendVision: async () => {
      throw new TypeError("Cannot read private member #state");
    }
  });
  assert.notEqual(bug.code, "network");
  assert.notEqual(bug.chip, "网络错误");
  assert.equal(bug.chip, "暂不可用");
});

test("an empty or schemeless custom Base URL is not a ready multimodal card", async () => {
  const llm = { provider: "openai", providers: { openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" } } };
  for (const baseUrl of ["", "   ", "vendor.example/v1", "/v1", "ftp://vendor.example/v1", "https:///x", "https://.", "http://0"]) {
    const settings = {
      [FORMULA_SWITCH_KEYS.tier2]: true,
      multimodal: { provider: "custom", apiKey: SECRET, model: "m", customModel: true, baseUrl }
    };
    assert.equal(httpBaseUrl(baseUrl.trim()), "");
    assert.equal(multimodalReady(settings), false, baseUrl);
    assert.equal(tierActive("multimodal", settings), false, baseUrl);
    const flags = formulaChainFlags(settings, { arxivEnabled: false });
    assert.equal(flags.multimodalEnabled, false, baseUrl);
    assert.equal(flags.multimodalConfigured, false, baseUrl);
    const ask = resolveAskTarget(llm, settings);
    assert.equal(ask.via, "translation", baseUrl);
    assert.notEqual(ask.provider, "custom");
  }
  const ready = {
    [FORMULA_SWITCH_KEYS.tier2]: true,
    multimodal: { provider: "custom", apiKey: SECRET, model: "m", customModel: true, baseUrl: "https://vendor.example/v1" }
  };
  assert.equal(multimodalReady(ready), true);
  assert.equal(tierActive("multimodal", ready), true);
  assert.equal(formulaChainFlags(ready, { arxivEnabled: false }).multimodalEnabled, true);
  assert.equal(resolveAskTarget(llm, ready).via, "multimodal");
  let calls = 0;
  const blocked = await probeMultimodal({
    multimodal: { provider: "custom", apiKey: SECRET, model: "m", baseUrl: "vendor.example/v1" }
  }, {
    secret: SECRET,
    sendVision: async () => {
      calls += 1;
      return { ok: true, text: "SEEN" };
    }
  });
  assert.equal(calls, 0);
  assert.equal(blocked.ok, false);
  assert.match(blocked.summary, /Base URL/);
});

test("a stored summary is redacted before it is clipped", () => {
  const token = `sk-Stored-${"Abc".repeat(20)}`;
  const summary = `${"n".repeat(70)}${token}`;
  const { document } = parseHTML("<!doctype html><div id='root'></div>");
  const previous = globalThis.document;
  globalThis.document = document;
  patchSelectValue(document);
  try {
    const panel = document.getElementById("root");
    renderFormulaPanel(panel, {
      ...openaiSettings(),
      multimodal: {
        ...openaiSettings().multimodal,
        apiKey: token,
        probe: { ok: false, chip: "密钥无效 (401)", code: "401", summary, at: 1 }
      }
    }, {});
    const shown = panel.querySelector("[data-probe-summary]")?.textContent || "";
    assert.equal(shown.length <= 80, true);
    assert.equal(shown.includes("sk-"), false);
    assert.equal(shown.toLowerCase().includes(token.slice(0, 12).toLowerCase()), false);
  } finally {
    globalThis.document = previous;
  }
});

test("a colon bearer token is stripped from a 401 echo", async () => {
  const token = "tok_colon_live_edge";
  const secret = `Bearer:${token}`;
  const box = responseNet(() => jsonResponse(401, { error: { message: `bad ${token}` } }));
  const probe = await probeMultimodal(openaiSettings({ apiKey: secret }), { secret, net: box.net });
  assert.equal(probe.chip, "密钥无效 (401)");
  assert.equal(probe.summary.includes(token), false);
  assert.equal(redactProbeText(`echo ${token}`, secret).includes(token), false);
});

test("the settings summary redacts a key regardless of case", () => {
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
        probe: { ok: false, chip: "密钥无效 (401)", code: "401", summary: `bad ${SECRET.toUpperCase()} tail`, at: 1 }
      }
    }, {});
    assert.equal(panel.textContent.toLowerCase().includes(SECRET.toLowerCase()), false);
  } finally {
    globalThis.document = previous;
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
  // apiKey edits keep a stored 「已连通」. Vendor, model, and normalized Base URL do not.
  return [mm.provider, mm.model, normalizedBaseUrl(mm.baseUrl)].join("\n");
}

const optionsHtml = read("options/options.html").replace(/<script\b[\s\S]*?<\/script>/g, "");
const llmSettings = { provider: "openai", providers: { openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" } } };

function installChromeHarness(bag, sync, listeners) {
  globalThis.OI_OPTIONS_MANUAL = true;
  globalThis.location = { hash: "#mm" };
  globalThis.history = { replaceState(_state, _title, url) {
    if (typeof url === "string" && url.includes("#")) globalThis.location.hash = url.slice(url.indexOf("#"));
  } };
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
  function area(store, name) {
    return {
      async get(key) {
        if (typeof key !== "string") return structuredClone(store);
        return { [key]: structuredClone(store[key]) };
      },
      async set(patch) {
        Object.assign(store, structuredClone(patch));
        const changes = {};
        for (const [item, value] of Object.entries(patch)) changes[item] = { newValue: structuredClone(value) };
        if (name === "local") {
          for (const listener of [...listeners]) listener(changes, name);
        }
      }
    };
  }
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
}

async function flush(times = 40) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function openOptionsTab(id) {
  const { document, window } = parseHTML(optionsHtml);
  patchSelectValue(document);
  globalThis.document = document;
  globalThis.window = window;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  window.location = globalThis.location;
  window.history = globalThis.history;
  const url = pathToFileURL(join(root, "options/options.js"));
  url.searchParams.set("instance", id);
  const mod = await import(url.href);
  mod.attachOptionsHost({ document, window });
  await mod.startOptions();
  await flush();
  return { id, document, window };
}

function mmRoot(tab) {
  return tab.document.querySelector("[data-formula-card='mm']");
}

function probeButton(tab) {
  return mmRoot(tab).querySelector("[data-formula-action='mm']");
}

function providerSelect(tab) {
  return mmRoot(tab).querySelector("select");
}

async function clickProbe(tab, arm) {
  const button = probeButton(tab);
  if (!button || button.disabled) return false;
  const before = arm.pending.length;
  arm.current = tab;
  button.click();
  for (let i = 0; i < 40 && arm.pending.length === before; i += 1) await Promise.resolve();
  arm.current = null;
  await flush();
  return arm.pending.length > before;
}

function changeBaseUrl(tab, value) {
  const input = tab.document.querySelector("[data-base-url]");
  input.value = value;
  input.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
}

function changeProvider(tab, value) {
  const select = providerSelect(tab);
  select.value = value;
  select.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
}

function changeModel(tab, value) {
  const selects = [...mmRoot(tab).querySelectorAll("select")];
  const model = selects[1];
  if (!model) {
    const typed = [...mmRoot(tab).querySelectorAll("input[type='text']")].find((node) => (
      !node.hasAttribute("data-secret") && !node.hasAttribute("data-base-url")
    ));
    if (!typed) return;
    typed.value = value;
    typed.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
    return;
  }
  model.value = value;
  model.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
}

function commitKey(tab, value) {
  const input = tab.document.querySelector("[data-key-slot='mm'] input");
  input.value = value;
  input.dispatchEvent(new tab.window.Event("blur", { bubbles: true }));
}

function clickRemoveKey(tab) {
  const button = [...tab.document.querySelectorAll("[data-key-slot='mm'] button")].find((node) => node.textContent === "移除密钥");
  button?.click();
}

function clickUndo(tab) {
  const button = tab.document.querySelector("#setToast button");
  if (!button) return false;
  button.click();
  return true;
}

function toggleTier2(tab) {
  const input = tab.document.querySelector(`[data-formula-switch="${FORMULA_SWITCH_KEYS.tier2}"]`);
  if (!input) return;
  input.checked = !input.checked;
  input.dispatchEvent(new tab.window.Event("change", { bubbles: true }));
}

function responseFor(kind, secret) {
  if (kind === "ok") return jsonResponse(200, { choices: [{ message: { content: "SEEN" } }] });
  if (kind === "401") return jsonResponse(401, { error: { message: `bad ${secret}` } });
  if (kind === "429") return jsonResponse(429, { error: { message: "slow down" } });
  if (kind === "novision") return jsonResponse(400, { error: { message: "does not support image input" } });
  return null;
}

async function settleHit(hit, kind, secret) {
  if (kind === "timeout") hit.reject(Object.assign(new Error("timeout"), { name: "TimeoutError", code: "timeout" }));
  else if (kind === "network") hit.reject(Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" }));
  else hit.resolve(responseFor(kind, secret));
  await flush();
}

function assertStoredProbe(seed, step, bag, secret, requests, logs, syncBag, known, tierCalls, askSession) {
  const stored = bag[FORMULA_SETTINGS_KEY];
  const provider = stored?.multimodal?.provider || "";
  if (provider && !isProvenVisionProvider(provider)) {
    throw new Error(`seed ${seed} step ${step} unproven provider ${provider}`);
  }
  const summary = String(stored?.multimodal?.probe?.summary || "");
  if (summary.toLowerCase().includes(secret.toLowerCase()) || summary.length > 80) {
    throw new Error(`seed ${seed} step ${step} summary leak`);
  }
  if (stored) {
    const clone = structuredClone(stored);
    if (clone.multimodal) clone.multimodal.apiKey = "";
    if (clone.ocr) clone.ocr.apiKey = "";
    if (JSON.stringify(clone).toLowerCase().includes(secret.toLowerCase())) {
      throw new Error(`seed ${seed} step ${step} key outside apiKey`);
    }
  }
  const publicHeaders = requests.map((hit) => {
    const headers = { ...(hit.headers || {}) };
    delete headers.Authorization;
    delete headers.authorization;
    return headers;
  });
  const dump = JSON.stringify({
    syncBag,
    logs,
    urls: requests.map((hit) => hit.url),
    bodies: requests.map((hit) => hit.body),
    headers: publicHeaders,
    summary,
    askTurns: askSession?.turns || []
  });
  if (dump.toLowerCase().includes(secret.toLowerCase())) throw new Error(`seed ${seed} step ${step} secret in public dump`);
  for (const hit of requests) {
    if (!hit.body.includes(PNG)) throw new Error(`seed ${seed} step ${step} non-probe request`);
  }
  const cacheKey = Object.keys(bag).find((key) => /formula.?cache|probeCache|visionCache/i.test(key));
  if (cacheKey) throw new Error(`seed ${seed} step ${step} wrote a formula cache ${cacheKey}`);
  if (stored && Object.prototype.hasOwnProperty.call(stored, "cache")) {
    throw new Error(`seed ${seed} step ${step} stored a formula cache`);
  }
  if (!askSession || askSession.turns.length !== 0 || askSession.flight) {
    throw new Error(`seed ${seed} step ${step} probe touched the ask queue`);
  }
  const probeQueue = mmProbe.queue || mmProbe.pending;
  const askQueue = askRoute.queue || askRoute.pending;
  if ((probeQueue && askQueue && probeQueue === askQueue) || (probeQueue && probeQueue.length)) {
    throw new Error(`seed ${seed} step ${step} probe and ask share a queue`);
  }
  const probe = stored?.multimodal?.probe;
  if (probe?.ok) {
    const fp = fingerprint(stored);
    if (!known.probe || known.probe.at !== probe.at) known.probe = { at: probe.at, fp, chip: probe.chip };
    else if (known.probe.fp !== fp || known.probe.chip !== probe.chip) {
      throw new Error(`seed ${seed} step ${step} connected probe moved onto ${fp}`);
    }
  }
  if (!multimodalReady(stored || {})) {
    const ask = resolveAskTarget(llmSettings, stored || {});
    if (ask.via === "multimodal") throw new Error(`seed ${seed} step ${step} ask used an unready card`);
  }
  if (tierCalls.n !== 0) throw new Error(`seed ${seed} step ${step} called a formula tier`);
  if (multimodalTier.version !== "stub-0") throw new Error(`seed ${seed} step ${step} multimodal tier changed`);
}

test("editing Base URL or the typed model clears the on-screen 已连通 chip", async () => {
  const stamp = { ok: true, chip: "已连通", code: "ok", summary: "", at: Date.now() };
  const connected = () => ({
    multimodal: {
      provider: "custom",
      apiKey: SECRET,
      model: "local-vision",
      customModel: true,
      baseUrl: "https://vendor.example/v1",
      probe: { ...stamp }
    }
  });
  const bag = { [FORMULA_SETTINGS_KEY]: connected() };
  const previous = captureGlobals();
  installChromeHarness(bag, { settings: llmSettings }, []);
  const chipOf = (tab) => mmRoot(tab).querySelector(".oi-set-chip")?.textContent || "";
  try {
    const tab = await openOptionsTab("chip-url");
    assert.match(chipOf(tab), /已连通/);
    changeBaseUrl(tab, "https://vendor.example/v1/");
    await flush();
    assert.match(chipOf(tab), /已连通/);
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.probe.ok, true);
    changeBaseUrl(tab, "https://VENDOR.example/v1");
    await flush();
    assert.match(chipOf(tab), /已连通/);
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.probe.ok, true);
    changeBaseUrl(tab, "https://other.example/v1");
    await flush();
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.probe, null);
    assert.equal(chipOf(tab).includes("已连通"), false);
    tab.document.querySelector("[data-nav='data']").click();
    tab.document.querySelector("[data-nav='mm']").click();
    assert.equal(chipOf(tab).includes("已连通"), false);

    bag[FORMULA_SETTINGS_KEY] = connected();
    const path = await openOptionsTab("chip-path");
    assert.match(chipOf(path), /已连通/);
    changeBaseUrl(path, "https://vendor.example/v2");
    await flush();
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.probe, null);
    assert.equal(chipOf(path).includes("已连通"), false);

    bag[FORMULA_SETTINGS_KEY] = connected();
    const modelTab = await openOptionsTab("chip-model");
    assert.match(chipOf(modelTab), /已连通/);
    changeModel(modelTab, "other-vision");
    await flush();
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.model, "other-vision");
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.probe, null);
    assert.equal(chipOf(modelTab).includes("已连通"), false);
    modelTab.document.querySelector("[data-nav='pdf']").click();
    modelTab.document.querySelector("[data-nav='mm']").click();
    assert.equal(chipOf(modelTab).includes("已连通"), false);
  } finally {
    restoreGlobals(previous);
  }
});

test("移除密钥 and a replacement key persist on a stored empty custom card", async () => {
  const bag = {
    [FORMULA_SETTINGS_KEY]: {
      multimodal: {
        provider: "custom",
        apiKey: SECRET,
        model: "m",
        customModel: true,
        baseUrl: "",
        probe: null
      }
    }
  };
  const previous = captureGlobals();
  installChromeHarness(bag, { settings: llmSettings }, []);
  const storedKey = () => bag[FORMULA_SETTINGS_KEY].multimodal.apiKey;
  const keyInput = (tab) => tab.document.querySelector("[data-key-slot='mm'] input");
  try {
    const tab = await openOptionsTab("empty-key");
    assert.equal(storedKey(), SECRET);
    assert.notEqual(keyInput(tab).value, "");
    clickRemoveKey(tab);
    await flush();
    assert.match(tab.document.getElementById("setToast").textContent, /已移除/);
    assert.equal(storedKey(), "");
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.model, "m");
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.baseUrl, "");
    const reopened = await openOptionsTab("empty-key-again");
    assert.equal(keyInput(reopened).value, "");
    assert.equal(clickUndo(tab), true);
    await flush();
    assert.equal(storedKey(), SECRET);
    clickRemoveKey(tab);
    await flush();
    assert.equal(storedKey(), "");
    commitKey(tab, "sk-replaced-key");
    await flush();
    assert.equal(storedKey(), "sk-replaced-key");
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.model, "m");
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.baseUrl, "");
    const replaced = await openOptionsTab("empty-key-replaced");
    assert.notEqual(keyInput(replaced).value, "");
    assert.equal(keyInput(replaced).value.includes(SECRET), false);
  } finally {
    restoreGlobals(previous);
  }
});

test("changing Base URL during a probe aborts that request and clears the button", async () => {
  const bag = {
    [FORMULA_SETTINGS_KEY]: {
      multimodal: {
        provider: "custom",
        apiKey: SECRET,
        model: "local-vision",
        customModel: true,
        baseUrl: "https://vendor.example/v1",
        probe: { ok: true, chip: "已连通", code: "ok", summary: "", at: 5 }
      }
    }
  };
  const listeners = [];
  const pending = [];
  const previous = captureGlobals();
  installChromeHarness(bag, { settings: llmSettings }, listeners);
  installNet(createNet({
    log: () => {},
    random: () => 0,
    sleep: (ms) => (ms < 1000 ? Promise.resolve() : new Promise(() => {})),
    transport(_url, init) {
      const hit = { signal: init?.signal };
      pending.push(hit);
      return new Promise((resolve) => { hit.resolve = resolve; });
    }
  }));
  try {
    const tab = await openOptionsTab("guard-url");
    assert.equal(await clickProbe(tab, { pending, current: null }), true);
    assert.equal(probeButton(tab).textContent, "测试中…");
    changeBaseUrl(tab, "https://other.example/v1");
    await flush();
    assert.equal(pending[0].signal.aborted, true);
    assert.equal(probeButton(tab).textContent, "测试连通");
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.baseUrl, "https://other.example/v1");
    assert.notEqual(bag[FORMULA_SETTINGS_KEY].multimodal.probe?.ok, true);
    assert.notEqual(bag[FORMULA_SETTINGS_KEY].multimodal.probe?.chip, "已连通");
    pending[0].resolve(jsonResponse(200, { choices: [{ message: { content: "SEEN" } }] }));
    await flush();
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.baseUrl, "https://other.example/v1");
    assert.notEqual(bag[FORMULA_SETTINGS_KEY].multimodal.probe?.ok, true);
  } finally {
    installNet(null);
    restoreGlobals(previous);
  }
});

test("a 200 that arrives after the card changed is not written onto the new card", async () => {
  const bag = {
    [FORMULA_SETTINGS_KEY]: {
      multimodal: { provider: "custom", apiKey: SECRET, model: "local-vision", customModel: true, baseUrl: "https://vendor.example/v1" }
    }
  };
  const listeners = [];
  const pending = [];
  const previous = captureGlobals();
  installChromeHarness(bag, { settings: llmSettings }, listeners);
  let tab = null;
  installNet(createNet({
    log: () => {},
    random: () => 0,
    sleep: (ms) => (ms < 1000 ? Promise.resolve() : new Promise(() => {})),
    transport() {
      pending.push(true);
      // The body is parsed, then four turns pass before classification and one
      // during the probe yield. The sixth turn is after that success has been
      // returned and before settle reads still().
      const response = jsonResponse(200, { choices: [{ message: { content: "SEEN" } }] });
      return new Proxy(response, {
        get(target, prop, receiver) {
          if (prop === "json") {
            return () => {
              const body = target.json();
              body.then(() => {
                let left = 0;
                const step = () => {
                  left += 1;
                  if (left === 6) changeBaseUrl(tab, "https://other.example/v1");
                  else queueMicrotask(step);
                };
                queueMicrotask(step);
              });
              return body;
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  }));
  try {
    tab = await openOptionsTab("guard-still");
    assert.equal(await clickProbe(tab, { pending, current: null }), true);
    await flush();
    const saved = bag[FORMULA_SETTINGS_KEY].multimodal;
    assert.equal(saved.baseUrl, "https://other.example/v1");
    assert.notEqual(saved.probe?.ok, true);
    assert.notEqual(saved.probe?.chip, "已连通");
  } finally {
    installNet(null);
    restoreGlobals(previous);
  }
});

test("another tab's formula write drops the in-flight probe", async () => {
  const bag = {
    [FORMULA_SETTINGS_KEY]: {
      multimodal: { provider: "openai", apiKey: SECRET, model: "gpt-5.6-luna", baseUrl: "" }
    }
  };
  const listeners = [];
  const pending = [];
  const arm = { pending, current: null };
  const previous = captureGlobals();
  installChromeHarness(bag, { settings: llmSettings }, listeners);
  installNet(createNet({
    log: () => {},
    random: () => 0,
    sleep: (ms) => (ms < 1000 ? Promise.resolve() : new Promise(() => {})),
    transport(_url, init) {
      const hit = { signal: init?.signal, resolve: null };
      pending.push(hit);
      return new Promise((resolve) => { hit.resolve = resolve; });
    }
  }));
  try {
    const first = await openOptionsTab("guard-tab-a");
    const second = await openOptionsTab("guard-tab-b");
    assert.equal(await clickProbe(first, arm), true);
    changeModel(second, "gpt-5.4-mini");
    await flush();
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.model, "gpt-5.4-mini");
    assert.equal(pending[0].signal.aborted, true);
    pending[0].resolve(jsonResponse(200, { choices: [{ message: { content: "SEEN" } }] }));
    await flush();
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.model, "gpt-5.4-mini");
    assert.notEqual(bag[FORMULA_SETTINGS_KEY].multimodal.probe?.ok, true);
    assert.equal(second.document.querySelector("[data-formula-card='mm'] select")?.value || providerSelect(second).value, "openai");
  } finally {
    installNet(null);
    restoreGlobals(previous);
  }
});

test("choosing custom without a Base URL does not turn tier 2 on for the previous vendor", async () => {
  const bag = {
    [FORMULA_SETTINGS_KEY]: {
      "formula.tier2.enabled": false,
      multimodal: { provider: "openai", apiKey: SECRET, model: "gpt-5.6-luna", baseUrl: "" }
    }
  };
  const listeners = [];
  const previous = captureGlobals();
  installChromeHarness(bag, { settings: llmSettings }, listeners);
  installNet(createNet({
    log: () => {},
    random: () => 0,
    sleep: () => Promise.resolve(),
    transport() { return jsonResponse(200, { choices: [{ message: { content: "SEEN" } }] }); }
  }));
  try {
    const tab = await openOptionsTab("guard-custom-switch");
    assert.equal(providerSelect(tab).value, "openai");
    changeProvider(tab, "custom");
    await flush();
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.provider, "openai");
    toggleTier2(tab);
    await flush();
    assert.equal(bag[FORMULA_SETTINGS_KEY].multimodal.provider, "openai");
    assert.equal(bag[FORMULA_SETTINGS_KEY]["formula.tier2.enabled"], false);
    assert.equal(providerSelect(tab).value, "openai");
  } finally {
    installNet(null);
    restoreGlobals(previous);
  }
});

test("an unexpected probe failure is unavailable, not a network error", async () => {
  const mod = await import(pathToFileURL(join(root, "options/options.js")).href);
  const probe = mod.classifyUnexpectedProbe(new Error("probe send failed"));
  assert.equal(probe.chip, "暂不可用");
  assert.notEqual(probe.code, "network");
  assert.notEqual(probe.chip, "网络错误");
  assert.throws(() => mod.classifyUnexpectedProbe(Object.assign(new Error("net"), { code: "real-network-in-test" })));
});

test("undo during a probe restores the button and drops the result", async () => {
  const bag = {
    [FORMULA_SETTINGS_KEY]: {
      multimodal: { provider: "openai", apiKey: SECRET, model: "gpt-5.6-luna", baseUrl: "" }
    }
  };
  const listeners = [];
  const pending = [];
  const previous = captureGlobals();
  installChromeHarness(bag, { settings: llmSettings }, listeners);
  installNet(createNet({
    log: () => {},
    random: () => 0,
    sleep: (ms) => (ms < 1000 ? Promise.resolve() : new Promise(() => {})),
    transport() {
      return new Promise((resolve) => { pending.push(resolve); });
    }
  }));
  try {
    const tab = await openOptionsTab("guard-undo");
    clickRemoveKey(tab);
    await flush();
    commitKey(tab, SECRET);
    await flush();
    assert.equal(await clickProbe(tab, { pending, current: null }), true);
    assert.equal(probeButton(tab).textContent, "测试中…");
    assert.equal(clickUndo(tab), true);
    await flush();
    assert.equal(probeButton(tab).textContent, "测试连通");
    pending[0](jsonResponse(200, { choices: [{ message: { content: "SEEN" } }] }));
    await flush();
    assert.notEqual(bag[FORMULA_SETTINGS_KEY].multimodal.probe?.ok, true);
  } finally {
    installNet(null);
    restoreGlobals(previous);
  }
});

function captureGlobals() {
  return {
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
}

function restoreGlobals(previous) {
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

async function settleLateSuccess(seed, tab, arm, bag, secret) {
  tab.window.dispatchEvent(new tab.window.Event("pagehide"));
  changeProvider(tab, "openai");
  await flush();
  changeModel(tab, "gpt-5.6-luna");
  await flush();
  commitKey(tab, secret);
  await flush();
  if (!await clickProbe(tab, arm)) throw new Error(`seed ${seed} late probe did not start`);
  const hit = arm.pending[arm.pending.length - 1];
  await settleHit(hit, "ok", secret);
  const index = arm.pending.indexOf(hit);
  if (index >= 0) arm.pending.splice(index, 1);
  const saved = bag[FORMULA_SETTINGS_KEY]?.multimodal?.probe;
  if (!saved?.ok) throw new Error(`seed ${seed} late setup did not store 已连通`);
  const at = saved.at;
  if (!await clickProbe(tab, arm)) throw new Error(`seed ${seed} second probe did not start`);
  const late = arm.pending[arm.pending.length - 1];
  commitKey(tab, `${secret}-late`);
  await flush();
  await settleHit(late, "ok", secret);
  const lateIndex = arm.pending.indexOf(late);
  if (lateIndex >= 0) arm.pending.splice(lateIndex, 1);
  const after = bag[FORMULA_SETTINGS_KEY]?.multimodal;
  if (after?.probe?.ok !== true || after.probe.at !== at || after.probe.chip !== "已连通") {
    throw new Error(`seed ${seed} late result replaced the stored success`);
  }
  commitKey(tab, secret);
  await flush();
  const kept = bag[FORMULA_SETTINGS_KEY]?.multimodal;
  if (kept?.probe?.ok) {
    const next = normalizedBaseUrl(kept.baseUrl) === normalizedBaseUrl("https://other.example/v1")
      ? "https://vendor.example/v2"
      : "https://other.example/v1";
    changeBaseUrl(tab, next);
    await flush();
  }
}

async function runSeed(seed, tierCalls) {
  const rand = mulberry32(seed);
  const secret = `probe-secret-${seed}-zz`;
  const bag = {
    [FORMULA_SETTINGS_KEY]: {
      multimodal: { provider: "openai", apiKey: secret, model: "gpt-5.6-luna", baseUrl: "" }
    }
  };
  const syncBag = { settings: llmSettings };
  const listeners = [];
  const logs = [];
  const requests = [];
  const pending = [];
  const known = { probe: null };
  const askSession = createAskSession({ docHash: `seed-${seed}`, nonce: "probe" });
  const arm = { pending, current: null };
  const previous = captureGlobals();
  installChromeHarness(bag, syncBag, listeners);
  installNet(createNet({
    log: (row) => logs.push(row),
    random: () => 0,
    sleep: (ms) => (ms < 1000 ? Promise.resolve() : new Promise(() => {})),
    transport(url, init) {
      const hit = {
        url,
        body: String(init?.body || ""),
        headers: { ...(init?.headers || {}) },
        signal: init?.signal,
        tab: arm.current,
        seq: requests.length
      };
      requests.push({ url: hit.url, body: hit.body, headers: hit.headers });
      pending.push(hit);
      return new Promise((resolve, reject) => {
        hit.resolve = resolve;
        hit.reject = reject;
      });
    }
  }));
  const tabs = [];
  try {
    tabs.push(await openOptionsTab(`seed-${seed}-a`));
    tabs.push(await openOptionsTab(`seed-${seed}-b`));
    const events = [
      "openai", "key", "model", "probe", "both", "ok", "401", "429", "novision", "timeout", "network",
      "deepseek-select", "url", "url-b", "url-only", "empty-url", "schemeless", "remove-key", "undo",
      "toggle", "unload", "retry", "other-tab", "late"
    ];
    for (let step = 0; step < 24; step += 1) {
      const tab = tabs[Math.floor(rand() * tabs.length)];
      const other = tabs[0] === tab ? tabs[1] : tabs[0];
      const event = events[Math.floor(rand() * events.length)];
      if (event === "openai") changeProvider(tab, "openai");
      else if (event === "key") commitKey(tab, secret);
      else if (event === "model") changeModel(tab, rand() < 0.5 ? "gpt-5.4-mini" : "gpt-5.6-luna");
      else if (event === "probe" || event === "retry" || event === "both") {
        await clickProbe(tab, arm);
        if (event === "both" || rand() < 0.5) await clickProbe(other, arm);
      }
      else if (event === "deepseek-select") {
        const before = providerSelect(tab).value;
        changeProvider(tab, "deepseek");
        await flush();
        assert.notEqual(providerSelect(tab).value, "deepseek");
        assert.equal(providerSelect(tab).value, before);
      } else if (event === "url" || event === "url-b") {
        const mm = bag[FORMULA_SETTINGS_KEY]?.multimodal;
        if (mm?.provider !== "custom") {
          changeProvider(tab, "custom");
          await flush();
        }
        changeBaseUrl(tab, event === "url" ? "https://vendor.example/v1" : "https://other.example/v1");
      } else if (event === "url-only") {
        const mm = bag[FORMULA_SETTINGS_KEY]?.multimodal;
        if (mm?.probe?.ok) {
          const next = normalizedBaseUrl(mm.baseUrl) === normalizedBaseUrl("https://vendor.example/v2")
            ? "https://other.example/v1"
            : "https://vendor.example/v2";
          changeBaseUrl(tab, next);
        }
      } else if (event === "empty-url" || event === "schemeless") {
        changeProvider(tab, "custom");
        await flush();
        const before = bag[FORMULA_SETTINGS_KEY]?.multimodal?.baseUrl || "";
        changeBaseUrl(tab, event === "empty-url" ? "   " : "vendor.example/v1");
        await flush();
        const after = bag[FORMULA_SETTINGS_KEY]?.multimodal?.baseUrl || "";
        if (httpBaseUrl(before)) assert.equal(after, before);
        else assert.equal(httpBaseUrl(after), "");
      } else if (event === "remove-key") clickRemoveKey(tab);
      else if (event === "undo") clickUndo(tab);
      else if (event === "toggle") toggleTier2(tab);
      else if (event === "unload") tab.window.dispatchEvent(new tab.window.Event("pagehide"));
      else if (event === "other-tab") changeModel(other, "gpt-5.4-mini");
      else if (event === "late") await settleLateSuccess(seed, tab, arm, bag, secret);
      else if (pending.length) {
        const hit = pending.splice(Math.floor(rand() * pending.length), 1)[0];
        const before = structuredClone(bag[FORMULA_SETTINGS_KEY] || null);
        const aborted = hit.signal?.aborted === true;
        await settleHit(hit, event, secret);
        const after = bag[FORMULA_SETTINGS_KEY];
        if (aborted) {
          if (before?.multimodal?.probe?.ok === true) {
            assert.equal(after?.multimodal?.probe?.ok, true);
            assert.equal(after?.multimodal?.probe?.at, before.multimodal.probe.at);
            assert.equal(after?.multimodal?.probe?.chip, "已连通");
          } else {
            assert.notEqual(after?.multimodal?.probe?.ok, true);
          }
        }
      }
      await flush();
      for (const open of pending) {
        if (open.signal?.aborted) continue;
        if (open.tab && probeButton(open.tab).textContent !== "测试中…") {
          throw new Error(`seed ${seed} step ${step} live probe left the button`);
        }
      }
      assertStoredProbe(seed, step, bag, secret, requests, logs, syncBag, known, tierCalls, askSession);
    }
    for (const hit of pending.splice(0)) {
      const aborted = hit.signal?.aborted === true;
      const before = structuredClone(bag[FORMULA_SETTINGS_KEY] || null);
      hit.reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted" }));
      await flush();
      if (aborted && before?.multimodal?.probe?.ok === true) {
        assert.equal(bag[FORMULA_SETTINGS_KEY]?.multimodal?.probe?.at, before.multimodal.probe.at);
      }
    }
    assertStoredProbe(seed, "end", bag, secret, requests, logs, syncBag, known, tierCalls, askSession);
    assert.equal(isProvenVisionProvider("deepseek"), false);
    if (!multimodalReady(bag[FORMULA_SETTINGS_KEY] || {})) {
      assert.notEqual(resolveAskTarget(llmSettings, bag[FORMULA_SETTINGS_KEY] || {}).via, "multimodal");
    }
  } finally {
    installNet(null);
    restoreGlobals(previous);
  }
}

test("500 seeds drive two real settings pages, including concurrent probes", async () => {
  const tierCalls = { n: 0 };
  const originals = [selfTier, vectorTier, multimodalTier].map((tier) => tier.run);
  for (const tier of [selfTier, vectorTier, multimodalTier]) {
    const run = tier.run;
    tier.run = async (...args) => {
      tierCalls.n += 1;
      return run.apply(tier, args);
    };
  }
  try {
    for (let seed = 1; seed <= 500; seed += 1) {
      try {
        await runSeed(seed, tierCalls);
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}`;
        throw err;
      }
    }
  } finally {
    [selfTier, vectorTier, multimodalTier].forEach((tier, index) => {
      tier.run = originals[index];
    });
  }
});

test("default probe client is sendVision, not a private shortcut", () => {
  const src = read("lib/mm-probe.js");
  assert.match(src, /deps\.sendVision \|\| sendVision/);
  assert.match(src, /PROBE_PNG_BASE64/);
  assert.match(src, /confirmsSeen/);
  assert.equal(sendVision.name, "sendVision");
  const options = read("options/options.js");
  assert.match(options, /probeMultimodal\(formulaSettings/);
  assert.match(options, /settleProbeResult\(/);
  assert.match(options, /pagehide/);
});
