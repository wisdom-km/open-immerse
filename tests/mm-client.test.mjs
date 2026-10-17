/**
 * F7-PR1 vision client. Fake endpoints only.
 *
 * 交付前刁钻自测:
 * 1. 并发 — two in-flight sends, responses applied to the matching call.
 * 2. 页面生命周期 — abort before send and mid-request; result is not ok.
 * 3. 新旧版本兼容 — 不适用（Wisdom 决定不做旧后台兼容）。
 * 4. 失败与回滚 — 401/403/404/429/timeout/no-vision/http; 429 retries once; abort does not.
 * 5. 边界输入 — PNG only, no public URL, typed model, key stuffed into target, summary ≤ 80.
 * 6. 交付要求 — 契约、假端点和 500 个种子都在本 PR，合入前跑绿。
 *
 * 不变量（本模块没有共享可变状态，所以种子打的是每次调用）:
 * ① key 不出现在 target、URL、日志、返回的 error 里；
 * ② 中止或设置过期的结果不作为成功返回；
 * ③ 设置变了之后不再为旧配置发出新请求，在途结果作废。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createNet } from "../lib/net/fetch.js";
import {
  MM_PURPOSE,
  VISION_ERROR_CODES,
  buildVisionRequest,
  multimodalTarget,
  sendVision
} from "../lib/mm-client.js";
import { MULTIMODAL_PROVIDERS, normalizeFormulaSettings } from "../lib/formula-settings.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SECRET = "sk-mm-secret-should-not-leak-123456";
const PLAIN = "plain-key-should-not-leak-987654";
const STUFFED = "sk-stuffed-target-key-zzzzzzzz";

const VENDORS = [
  { id: "openai", model: "gpt-5.6-luna", shape: "openai" },
  { id: "deepseek", model: "deepseek-flash", shape: "openai", thinking: "ark" },
  { id: "doubao", model: "doubao-seed-2-1-pro-260915", shape: "openai", thinking: "ark" },
  { id: "kimi", model: "kimi-k3", shape: "openai", thinking: "kimi" },
  { id: "qwen", model: "qwen3-vl-plus", shape: "openai" },
  { id: "grok", model: "grok-4.7", shape: "openai" },
  { id: "custom", model: "my-vision-model", shape: "openai", baseUrl: "https://vendor.example/v1" },
  { id: "gemini", model: "gemini-3.8-flash", shape: "gemini" }
];

function settingsFor(vendor, apiKey = SECRET, model = vendor.model) {
  return normalizeFormulaSettings({
    multimodal: {
      provider: vendor.id,
      apiKey,
      model,
      baseUrl: vendor.baseUrl || ""
    }
  });
}

function chatOrGemini(vendor, text, { thought = false } = {}) {
  if (vendor.shape === "gemini") {
    const parts = [];
    if (thought) parts.push({ thought: true, text: "hidden chain" });
    parts.push({ text });
    return {
      ok: true,
      status: 200,
      data: {
        candidates: [{ content: { parts } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }
      }
    };
  }
  return {
    ok: true,
    status: 200,
    data: {
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }
  };
}

function httpError(status, message) {
  return { ok: false, status, data: { error: { message } } };
}

function harness(handler) {
  const seen = [];
  const logs = [];
  const calls = [];
  const net = createNet({
    log: (row) => logs.push(row),
    random: () => 0,
    sleep(ms, signal) {
      if (ms < 1000) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const fail = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      });
    },
    transport(url, init) {
      const hit = {
        url,
        headers: { ...(init?.headers || {}) },
        body: init?.body,
        signal: init?.signal
      };
      seen.push(hit);
      return new Promise((resolve, reject) => {
        const fail = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) {
          fail();
          return;
        }
        init?.signal?.addEventListener("abort", fail, { once: true });
        Promise.resolve()
          .then(() => handler(hit, seen))
          .then(resolve, reject);
      });
    }
  });
  return {
    seen,
    logs,
    calls,
    net: {
      fetch(req) {
        calls.push(req);
        return net.fetch(req);
      }
    }
  };
}

function assertNoSecret(value, secret, label) {
  assert.equal(JSON.stringify(value).includes(secret), false, label || "secret leaked");
}

function wireAuth(hit) {
  return hit.headers.Authorization || hit.headers["x-goog-api-key"] || "";
}

async function until(fn) {
  for (let i = 0; i < 30; i += 1) {
    if (fn()) return;
    await Promise.resolve();
  }
  assert.equal(fn(), true);
}

test("registry presets are the documented vision models, including 千问", () => {
  assert.deepEqual(MULTIMODAL_PROVIDERS.map((item) => item.id), [
    "openai", "gemini", "deepseek", "doubao", "kimi", "grok", "qwen", "custom"
  ]);
  const deepseek = MULTIMODAL_PROVIDERS.find((item) => item.id === "deepseek");
  assert.equal(deepseek.vision, true);
  assert.equal(deepseek.visionBasis, "docs");
  assert.notEqual(deepseek.visionBasis, "probe");
  const gemini = MULTIMODAL_PROVIDERS.find((item) => item.id === "gemini");
  assert.equal(gemini.models.includes("gemini-2.0-flash"), false);
  assert.equal(read("lib/ask-route.js").includes("gemini-2.0-flash"), true);
  assert.equal(read("lib/providers.js").includes("gemini-2.0-flash"), true);
  assert.match(read("lib/formula-tiers/multimodal.js"), /stub-0/);
  const source = read("lib/mm-client.js");
  assert.equal(/\bfetch\s*\(/.test(source.replace(/\.fetch\s*\(/g, "")), false);
  assert.match(source, /purpose: MM_PURPOSE/);
});

test("multimodalTarget never carries the API key and uses the new Gemini default", () => {
  const stored = settingsFor(VENDORS[0]);
  const target = multimodalTarget(stored);
  assert.equal(target.apiKey, undefined);
  assert.equal(JSON.stringify(target).includes(SECRET), false);
  assert.equal(target.provider, "openai");
  assert.equal(target.model, "gpt-5.6-luna");
  assert.equal(target.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(target.host, "api.openai.com");
  const gemini = multimodalTarget({
    multimodal: { provider: "gemini", apiKey: SECRET, model: "" }
  });
  assert.equal(gemini.model, "gemini-3.8-flash");
  assert.match(gemini.url, /\/models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(gemini.url.includes("key="), false);
  assert.equal(JSON.stringify(gemini).includes(SECRET), false);
  const typed = multimodalTarget(settingsFor(
    VENDORS.find((item) => item.id === "qwen"),
    SECRET,
    "qwen-vl-user-typed"
  ));
  assert.equal(typed.model, "qwen-vl-user-typed");
  assert.equal(typed.url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
});

test("each vendor fake endpoint has the right image shape and thinking switch", async () => {
  const prev = globalThis.fetch;
  let native = 0;
  globalThis.fetch = () => {
    native += 1;
    throw new Error("real fetch");
  };
  try {
    for (const vendor of VENDORS) {
      const target = multimodalTarget(settingsFor(vendor));
      const box = harness(() => chatOrGemini(vendor, "E=mc^2"));
      const result = await sendVision({
        target,
        system: "只输出 LaTeX",
        text: "看这张裁图",
        images: [{ mime: "image/png", base64: PNG }],
        secret: SECRET,
        purpose: MM_PURPOSE,
        net: box.net
      });
      assert.equal(result.ok, true, vendor.id);
      assert.equal(result.text, "E=mc^2");
      assert.equal(box.calls.length, 1, vendor.id);
      assert.equal(box.calls[0].purpose, "multimodal");
      assert.equal(box.calls[0].cache, false);
      assert.equal(box.calls[0].dedupeKey, false);
      assert.equal(box.calls[0].timeoutMs, undefined);
      assert.equal(box.seen.length, 1);
      const body = JSON.parse(box.seen[0].body);
      assert.equal(body.temperature, vendor.shape === "gemini" ? undefined : 0);
      if (vendor.shape === "gemini") {
        assert.equal(box.seen[0].headers["x-goog-api-key"], SECRET);
        assert.equal(box.seen[0].headers.Authorization, undefined);
        assert.equal(box.seen[0].url.includes("key="), false);
        assert.match(box.seen[0].url, /:generateContent$/);
        const inline = body.contents[0].parts[1].inline_data;
        assert.equal(inline.mime_type, "image/png");
        assert.equal(inline.data, PNG);
        assert.equal(inline.data.includes("data:"), false);
        assert.equal(body.contents[0].parts[1].inlineData, undefined);
        assert.equal(body.system_instruction.parts[0].text, "只输出 LaTeX");
        assert.deepEqual(result.usage, {
          promptTokenCount: 3,
          candidatesTokenCount: 2,
          totalTokenCount: 5
        });
      } else {
        assert.equal(box.seen[0].headers.Authorization, `Bearer ${SECRET}`);
        assert.equal(box.seen[0].headers["x-goog-api-key"], undefined);
        assert.equal(body.model, vendor.model);
        const part = body.messages.at(-1).content;
        assert.equal(Array.isArray(part), true);
        assert.equal(part[0].text, "看这张裁图");
        assert.equal(part[1].type, "image_url");
        assert.equal(part[1].image_url.url, `data:image/png;base64,${PNG}`);
        assert.equal(part[1].image_url.url.startsWith("https:"), false);
        assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
      }
      if (vendor.thinking === "ark") {
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.equal(body.reasoning_effort, "minimal");
      } else if (vendor.thinking === "kimi") {
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.equal(body.reasoning_effort, undefined);
      } else if (vendor.shape !== "gemini") {
        assert.equal(Object.hasOwn(body, "thinking"), false);
        assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
      }
      assertNoSecret(box.logs, SECRET, vendor.id);
      assert.equal(box.seen[0].url.includes(SECRET), false);
      assert.equal(JSON.stringify(target).includes(SECRET), false);
    }
    assert.equal(native, 0);
  } finally {
    globalThis.fetch = prev;
  }
});

test("Gemini drops thought parts and a custom model string is sent as typed", async () => {
  const vendor = VENDORS.find((item) => item.id === "gemini");
  const box = harness(() => chatOrGemini(vendor, "a+b", { thought: true }));
  const result = await sendVision({
    target: multimodalTarget(settingsFor(vendor, SECRET, "gemini-user-typed")),
    text: "x",
    images: [{ mime: "Image/PNG", base64: `data:image/png;base64,${PNG}` }],
    secret: SECRET,
    net: box.net
  });
  assert.equal(result.text, "a+b");
  assert.equal(JSON.parse(box.seen[0].body).contents[0].parts[1].inline_data.data, PNG);
  assert.match(box.seen[0].url, /gemini-user-typed:generateContent/);
  const custom = VENDORS.find((item) => item.id === "custom");
  const customBox = harness(() => chatOrGemini(custom, "y"));
  const customTarget = multimodalTarget(settingsFor(custom, SECRET, "endpoint-id/custom"));
  await sendVision({
    target: customTarget,
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    secret: SECRET,
    net: customBox.net
  });
  assert.equal(JSON.parse(customBox.seen[0].body).model, "endpoint-id/custom");
  assert.equal(customBox.seen[0].url, "https://vendor.example/v1/chat/completions");
});

test("error statuses are classified and the summary never contains the key", async () => {
  const cases = [
    [401, "bad", "401"],
    [403, "no", "403"],
    [404, "missing", "404"],
    [429, "slow", "429"],
    [400, "This model does not support image input", "no-vision"],
    [500, "x".repeat(200) + SECRET, "http"],
    [408, "late", "timeout"]
  ];
  for (const [status, message, code] of cases) {
    let hits = 0;
    const box = harness(() => {
      hits += 1;
      return httpError(status, message);
    });
    const result = await sendVision({
      target: multimodalTarget(settingsFor(VENDORS[0])),
      text: "x",
      images: [{ mime: "image/png", base64: PNG }],
      secret: PLAIN,
      net: box.net
    });
    assert.equal(result.ok, false, String(status));
    assert.equal(result.error.code, code);
    assert.equal(result.error.status, status);
    assert.ok(result.error.summary.length <= 80);
    assert.equal(result.error.summary.includes(PLAIN), false);
    assert.equal(result.error.summary.includes(SECRET), false);
    assert.equal(result.text, undefined);
    assert.equal(hits, status === 429 || status === 500 ? 2 : 1, String(status));
    assertNoSecret(box.logs, PLAIN);
    assertNoSecret(box.logs, SECRET);
  }
});

test("timeout is classified after the single retry and abort is not retried", async () => {
  let timeouts = 0;
  const timeoutBox = harness(() => {
    timeouts += 1;
    const error = new Error("timeout");
    error.code = "timeout";
    error.name = "TimeoutError";
    throw error;
  });
  const timed = await sendVision({
    target: multimodalTarget(settingsFor(VENDORS[0])),
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    secret: SECRET,
    net: timeoutBox.net
  });
  assert.equal(timed.error.code, "timeout");
  assert.equal(timed.error.summary, "超时");
  assert.equal(timeouts, 2);
  assertNoSecret(timeoutBox.logs, SECRET);

  const controller = new AbortController();
  let aborts = 0;
  const abortBox = harness(() => new Promise(() => {}));
  const pending = sendVision({
    target: multimodalTarget(settingsFor(VENDORS[0])),
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    signal: controller.signal,
    secret: SECRET,
    net: abortBox.net
  });
  await until(() => abortBox.seen.length >= 1);
  controller.abort();
  const aborted = await pending;
  aborts = abortBox.seen.length;
  assert.equal(aborted.error.code, "aborted");
  assert.equal(aborted.text, undefined);
  assert.equal(aborts, 1);
  assertNoSecret(abortBox.logs, SECRET);
});

test("abort after the key is read does not send, and a removed key does not reuse the old one", async () => {
  const controller = new AbortController();
  let reads = 0;
  const box = harness(() => chatOrGemini(VENDORS[0], "nope"));
  const early = await sendVision({
    target: multimodalTarget(settingsFor(VENDORS[0])),
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    signal: controller.signal,
    readSecret: () => {
      reads += 1;
      controller.abort();
      return SECRET;
    },
    net: box.net
  });
  assert.equal(reads, 1);
  assert.equal(box.seen.length, 0);
  assert.equal(early.error.code, "aborted");

  let key = SECRET;
  const firstBox = harness(() => chatOrGemini(VENDORS[0], "ok"));
  const first = await sendVision({
    target: multimodalTarget(settingsFor(VENDORS[0])),
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    readSecret: () => key,
    net: firstBox.net
  });
  assert.equal(first.ok, true);
  key = "";
  const secondBox = harness(() => chatOrGemini(VENDORS[0], "late"));
  const second = await sendVision({
    target: multimodalTarget(settingsFor(VENDORS[0])),
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    readSecret: () => key,
    secret: SECRET,
    net: secondBox.net
  });
  assert.equal(second.error.code, "401");
  assert.equal(secondBox.seen.length, 0);
  assert.equal(JSON.stringify(second).includes("late"), false);
});

test("settings that change mid-flight discard the result and do not start another request", async () => {
  let live = true;
  let release;
  const started = new Promise((resolve) => {
    release = resolve;
  });
  let response;
  const gate = new Promise((resolve) => {
    response = resolve;
  });
  const box = harness(() => {
    release();
    return gate;
  });
  const pending = sendVision({
    target: multimodalTarget(settingsFor(VENDORS[0])),
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    secret: SECRET,
    stillCurrent: () => live,
    net: box.net
  });
  await started;
  live = false;
  response(chatOrGemini(VENDORS[0], "LATEX"));
  const result = await pending;
  assert.equal(box.seen.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "aborted");
  assert.equal(result.text, undefined);
  assert.equal(JSON.stringify(result).includes("LATEX"), false);
  assertNoSecret(result, SECRET);
  const blocked = harness(() => chatOrGemini(VENDORS[0], "no"));
  const dropped = await sendVision({
    target: multimodalTarget(settingsFor(VENDORS[0])),
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    secret: SECRET,
    stillCurrent: () => false,
    net: blocked.net
  });
  assert.equal(blocked.seen.length, 0);
  assert.equal(dropped.error.code, "aborted");
});

test("concurrent sends keep their own secret, body, and reply", async () => {
  let left;
  let right;
  const leftGate = new Promise((resolve) => {
    left = resolve;
  });
  const rightGate = new Promise((resolve) => {
    right = resolve;
  });
  const box = harness((hit) => {
    const body = JSON.parse(hit.body);
    return body.model === "left-model" ? leftGate : rightGate;
  });
  const image = [{ mime: "image/png", base64: PNG }];
  const pendingLeft = sendVision({
    target: { provider: "openai", model: "left-model", url: "https://left.example/v1/chat/completions", host: "left.example" },
    text: "L",
    images: image,
    secret: SECRET,
    net: box.net
  });
  const pendingRight = sendVision({
    target: { provider: "openai", model: "right-model", url: "https://right.example/v1/chat/completions", host: "right.example" },
    text: "R",
    images: image,
    secret: PLAIN,
    net: box.net
  });
  await until(() => box.seen.length >= 2);
  right(chatOrGemini({ shape: "openai" }, "FROM-RIGHT"));
  const rightResult = await pendingRight;
  left(chatOrGemini({ shape: "openai" }, "FROM-LEFT"));
  const leftResult = await pendingLeft;
  assert.equal(leftResult.text, "FROM-LEFT");
  assert.equal(rightResult.text, "FROM-RIGHT");
  assert.equal(box.seen[0].headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(box.seen[1].headers.Authorization, `Bearer ${PLAIN}`);
  assert.equal(JSON.parse(box.seen[0].body).messages.at(-1).content[0].text, "L");
  assert.equal(JSON.parse(box.seen[1].body).messages.at(-1).content[0].text, "R");
  assertNoSecret(box.logs, SECRET);
  assertNoSecret(box.logs, PLAIN);
});

test("a key on the target or in the URL is ignored; storage is read only when no secret is passed", async () => {
  const target = multimodalTarget(settingsFor(VENDORS[0]));
  target.apiKey = STUFFED;
  target.secret = STUFFED;
  const dirty = new URL(target.url);
  dirty.username = "alice";
  dirty.password = STUFFED;
  dirty.searchParams.set("api_key", STUFFED);
  dirty.searchParams.set("key", SECRET);
  target.url = dirty.toString();
  const box = harness(() => chatOrGemini(VENDORS[0], "kept"));
  const result = await sendVision({
    target,
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    secret: PLAIN,
    net: box.net
  });
  assert.equal(result.ok, true);
  assert.equal(target.apiKey, STUFFED);
  assert.equal(box.seen[0].headers.Authorization, `Bearer ${PLAIN}`);
  assert.equal(box.seen[0].url.includes(STUFFED), false);
  assert.equal(box.seen[0].url.includes(SECRET), false);
  assert.equal(box.seen[0].url.includes("alice"), false);
  assert.equal(box.seen[0].url.includes("api_key"), false);
  assertNoSecret(box.logs, STUFFED);
  assertNoSecret(box.logs, PLAIN);
  assertNoSecret(result, STUFFED);

  let writes = 0;
  const storage = {
    async get(key) {
      assert.equal(key, "formulaSettings");
      return {
        formulaSettings: {
          multimodal: { provider: "kimi", apiKey: SECRET, model: "kimi-k2.6" }
        }
      };
    },
    async set() {
      writes += 1;
    }
  };
  const storedBox = harness(() => chatOrGemini(VENDORS.find((item) => item.id === "kimi"), "k"));
  const stored = await sendVision({
    target: multimodalTarget(await storage.get("formulaSettings").then((bag) => bag.formulaSettings)),
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    storage,
    net: storedBox.net
  });
  assert.equal(stored.ok, true);
  assert.equal(storedBox.seen[0].headers.Authorization, `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(storedBox.seen[0].body).thinking, { type: "disabled" });
  assert.equal(writes, 0);
  const emptyBox = harness(() => chatOrGemini(VENDORS[0], "no"));
  const empty = await sendVision({
    target: multimodalTarget(settingsFor(VENDORS[0])),
    text: "x",
    images: [{ mime: "image/png", base64: PNG }],
    secret: "",
    storage,
    net: emptyBox.net
  });
  assert.equal(empty.error.code, "401");
  assert.equal(emptyBox.seen.length, 0);
  assert.equal(writes, 0);
});

test("non-PNG and public URLs never leave the process", async () => {
  const box = harness(() => chatOrGemini(VENDORS[0], "no"));
  const jpeg = await sendVision({
    target: multimodalTarget(settingsFor(VENDORS[0])),
    text: "x",
    images: [{ mime: "image/jpeg", base64: PNG }],
    secret: SECRET,
    net: box.net
  });
  const remote = await sendVision({
    target: multimodalTarget(settingsFor(VENDORS[0])),
    text: "x",
    images: [{ mime: "image/png", base64: "https://example.test/a.png" }],
    secret: SECRET,
    net: box.net
  });
  const svg = buildVisionRequest(multimodalTarget(settingsFor(VENDORS[0])), {
    text: "x",
    images: [{ mime: "image/png", base64: "data:image/svg+xml;base64,AAAA" }],
    secret: SECRET
  });
  assert.equal(jpeg.error.code, "http");
  assert.match(jpeg.error.summary, /PNG/);
  assert.match(remote.error.summary, /网址/);
  assert.equal(svg.error.ok, false);
  assert.equal(box.seen.length, 0);
  assert.equal(JSON.stringify(jpeg).includes(SECRET), false);
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 0x6D2B79F5 | 0;
    let next = Math.imul(state ^ state >>> 15, 1 | state);
    next = next + Math.imul(next ^ next >>> 7, 61 | next) ^ next;
    return ((next ^ next >>> 14) >>> 0) / 4294967296;
  };
}

const FAULTS = [
  "ok",
  "401",
  "403",
  "404",
  "429",
  "500",
  "timeout",
  "no-vision",
  "abort-during",
  "stale-before",
  "stale-after",
  "empty-key",
  "bad-image",
  "key-in-target"
];

async function runSeed(seed) {
  const rand = mulberry32(seed);
  const vendor = VENDORS[Math.floor(rand() * VENDORS.length)];
  const fault = FAULTS[Math.floor(rand() * FAULTS.length)];
  const secret = seed % 2 === 0 ? SECRET : PLAIN;
  const target = multimodalTarget(settingsFor(vendor, secret));
  assert.equal(JSON.stringify(target).includes(secret), false);
  assert.equal(target.apiKey, undefined);
  target.apiKey = STUFFED;
  if (fault === "key-in-target") {
    const dirty = new URL(target.url);
    dirty.username = "alice";
    dirty.password = secret;
    dirty.searchParams.set("api_key", secret);
    target.url = dirty.toString();
  }
  const controller = new AbortController();
  let live = fault !== "stale-before";
  const box = harness(() => {
    if (fault === "abort-during") {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    if (fault === "timeout") {
      const error = new Error("timeout");
      error.code = "timeout";
      error.name = "TimeoutError";
      throw error;
    }
    if (fault === "stale-after") {
      live = false;
      return chatOrGemini(vendor, `LATEX-${seed}`);
    }
    if (fault === "no-vision") return httpError(400, `This model does not support image ${secret}`);
    if (fault === "401") return httpError(401, `bad ${secret}`);
    if (fault === "403") return httpError(403, `no ${secret}`);
    if (fault === "404") return httpError(404, `missing ${secret}`);
    if (fault === "429") return httpError(429, `slow ${secret}`);
    if (fault === "500") return httpError(500, `down ${secret}`);
    return chatOrGemini(vendor, `E=mc^2 ${seed}`);
  });
  const images = fault === "bad-image"
    ? [{ mime: "image/jpeg", base64: PNG }]
    : [{ mime: "image/png", base64: PNG }];
  const result = await sendVision({
    target,
    system: "只输出 LaTeX",
    text: "公式",
    images,
    signal: controller.signal,
    purpose: seed % 5 === 0 ? "translate" : "multimodal",
    secret: fault === "empty-key" ? "" : secret,
    stillCurrent: () => live,
    net: box.net
  });
  assert.equal(target.apiKey, STUFFED);
  assertNoSecret(result, secret);
  assertNoSecret(result, STUFFED);
  assertNoSecret(box.logs, secret);
  assertNoSecret(box.logs, STUFFED);
  for (const hit of box.seen) {
    assert.equal(hit.url.includes(secret), false);
    assert.equal(hit.url.includes(STUFFED), false);
    assert.equal(hit.url.includes("alice"), false);
    assert.equal(/[?&](?:api_key|key)=/i.test(hit.url), false);
    const packed = hit.body;
    assert.equal(packed.includes(secret), false);
    assert.equal(packed.includes("https://"), false);
    assert.equal(packed.includes("http://"), false);
  }
  if (box.calls.length) assert.equal(box.calls[0].purpose, "multimodal");
  if (result.error) {
    assert.ok(VISION_ERROR_CODES.includes(result.error.code), result.error.code);
    assert.ok(result.error.summary.length <= 80);
    assert.equal(result.ok, false);
    assert.equal(result.text, undefined);
  }
  if (fault === "bad-image" || fault === "empty-key" || fault === "stale-before") {
    assert.equal(box.seen.length, 0);
  }
  if (fault === "stale-after" || fault === "abort-during") {
    assert.equal(result.error.code, "aborted");
    assert.equal(JSON.stringify(result).includes("LATEX"), false);
  }
  if (fault === "ok" || fault === "key-in-target") {
    assert.equal(result.ok, true);
    assert.match(result.text, new RegExp(`E=mc\\^2 ${seed}`));
    const auth = wireAuth(box.seen[0]);
    assert.equal(auth === `Bearer ${secret}` || auth === secret, true);
    assert.equal(auth.includes(STUFFED), false);
  }
  if (fault === "401" || fault === "403" || fault === "404" || fault === "429") {
    assert.equal(result.error.code, fault);
  }
  if (fault === "no-vision") assert.equal(result.error.code, "no-vision");
  if (fault === "500") assert.equal(result.error.code, "http");
  if (fault === "timeout") {
    assert.equal(result.error.code, "timeout");
    assert.equal(box.seen.length, 2);
  }
  if (fault === "429" || fault === "500") assert.equal(box.seen.length, 2);
  if (fault === "401" || fault === "abort-during" || fault === "no-vision") assert.equal(box.seen.length, 1);
}

test("500 seeds cover abort, stale discard, retry, and key absence", async () => {
  const prev = globalThis.fetch;
  let native = 0;
  globalThis.fetch = () => {
    native += 1;
    throw new Error("real fetch");
  };
  try {
    for (let seed = 1; seed <= 500; seed += 1) {
      try {
        await runSeed(seed);
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}`;
        throw err;
      }
    }
    assert.equal(native, 0);
  } finally {
    globalThis.fetch = prev;
  }
});
