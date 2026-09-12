import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVIDER_PROBE_TEXT,
  formatConnectionStatus,
  redactProviderText,
  sanitizeProviderError,
  testProviderConnection,
  truncateStatus
} from "../lib/providers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "sk-secret-should-not-leak-123456";
const VOLC_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3";

function mockFetch(impl) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = prev;
  };
}

test("redactProviderText strips sk-*, Bearer, and 20+ token runs", () => {
  const out = redactProviderText(`Bearer ${SECRET} other ${"a".repeat(20)} ok`);
  assert.equal(out.includes(SECRET), false);
  assert.equal(out.includes("a".repeat(20)), false);
  assert.match(out, /\*\*\*/);
  assert.match(out, /ok/);
});

test("sanitizeProviderError never echoes the API key", () => {
  const err = new Error(`OpenAI HTTP 401: invalid_api_key ${SECRET} Bearer ${SECRET}`);
  const out = sanitizeProviderError(err, { apiKey: SECRET, baseUrl: VOLC_BASE });
  assert.equal(out.includes(SECRET), false);
  assert.match(out, /401/);
  assert.match(out, /\*\*\*/);
});

test("formatConnectionStatus covers success, HTTP fail, and missing field", () => {
  assert.equal(formatConnectionStatus({ ok: true, translation: "你好" }), "连接成功 · Hello → 你好");
  assert.equal(
    formatConnectionStatus({ ok: true, translation: "这是一段超过二十四字的译文用来检查截断是否生效" }),
    `连接成功 · Hello → ${truncateStatus("这是一段超过二十四字的译文用来检查截断是否生效", 24)}`
  );
  assert.equal(
    formatConnectionStatus({ ok: false, httpStatus: 401, error: "OpenAI / 兼容通道 HTTP 401" }),
    "连接失败 · HTTP 401 · OpenAI / 兼容通道"
  );
  assert.equal(formatConnectionStatus({ ok: false, error: "网络中断" }), "连接失败 · 网络中断");
  assert.equal(formatConnectionStatus({ ok: false, missingField: "API Key" }), "请先填写 API Key");
});

test("testProviderConnection validates required fields without network", async () => {
  const restore = mockFetch(async () => {
    throw new Error("network should not run");
  });
  try {
    const result = await testProviderConnection({
      providerId: "openai",
      providerConfig: { apiKey: "", baseUrl: VOLC_BASE, model: "doubao-seed" }
    });
    assert.equal(result.ok, false);
    assert.equal(result.missingField, "API Key");
    assert.equal(formatConnectionStatus(result), "请先填写 API Key");
  } finally {
    restore();
  }
});

test("OpenAI-compatible probe uses unsaved Volcengine base, model, and key", async () => {
  const calls = [];
  const restore = mockFetch(async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "1. 你好" } }] };
      }
    };
  });
  try {
    const result = await testProviderConnection({
      providerId: "openai",
      providerConfig: {
        apiKey: SECRET,
        baseUrl: `${VOLC_BASE}/`,
        model: "doubao-seed-1-6-250615"
      },
      sourceLang: "en",
      targetLang: "zh-CN",
      texts: [PROVIDER_PROBE_TEXT]
    });
    assert.equal(result.ok, true);
    assert.equal(result.translation, "你好");
    assert.equal(result.error, undefined);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${VOLC_BASE}/chat/completions`);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "doubao-seed-1-6-250615");
    assert.match(body.messages[1].content, new RegExp(PROVIDER_PROBE_TEXT));
    assert.equal(formatConnectionStatus(result).includes(SECRET), false);
  } finally {
    restore();
  }
});

test("probe failure includes HTTP status and never echoes the key", async () => {
  const restore = mockFetch(async () => ({
    ok: false,
    status: 401,
    async json() {
      return { error: { message: `invalid api key ${SECRET}` } };
    }
  }));
  try {
    const result = await testProviderConnection({
      providerId: "openai",
      providerConfig: { apiKey: SECRET, baseUrl: VOLC_BASE, model: "doubao-seed" }
    });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
    assert.match(result.error, /401/);
    assert.equal(result.error.includes(SECRET), false);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.match(formatConnectionStatus(result), /连接失败 · HTTP 401/);
    assert.equal(formatConnectionStatus(result).includes(SECRET), false);
  } finally {
    restore();
  }
});

test("Gemini probe reuses generateContent and redacts key-in-URL failures", async () => {
  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(url);
    return { ok: false, status: 403, async json() { return {}; } };
  });
  try {
    const result = await testProviderConnection({
      providerId: "gemini",
      providerConfig: { apiKey: SECRET, model: "gemini-2.0-flash" }
    });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 403);
    assert.equal(result.error.includes(SECRET), false);
    assert.equal(String(calls[0]).includes(SECRET), true);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  } finally {
    restore();
  }
});

test("MyMemory (no key) is allowed to probe", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { responseData: { translatedText: "你好" } };
    }
  }));
  try {
    const result = await testProviderConnection({
      providerId: "mymemory",
      providerConfig: { email: "" }
    });
    assert.equal(result.ok, true);
    assert.equal(result.translation, "你好");
  } finally {
    restore();
  }
});

test("empty translation is a failure, not a silent success", async () => {
  const restore = mockFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: "" } }] };
    }
  }));
  try {
    const result = await testProviderConnection({
      providerId: "openai",
      providerConfig: { apiKey: SECRET, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /未返回译文/);
  } finally {
    restore();
  }
});

test("options page wires 测试连接 as secondary and harvests unsaved form values", () => {
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  const css = readFileSync(join(root, "options/options.css"), "utf8");
  const js = readFileSync(join(root, "options/options.js"), "utf8");
  const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");

  assert.match(html, /翻译引擎与密钥/);
  assert.match(html, /id="providerFields"/);
  assert.match(html, /class="provider-test-row"/);
  assert.match(html, /id="testConnection"[^>]*class="btn-secondary">测试连接</);
  assert.match(html, /id="testConnectionStatus"[^>]*class="provider-test-status"[^>]*role="status"/);
  assert.match(html, /id="save"[^>]*class="btn-primary">保存设置</);
  assert.equal(html.includes('id="testConnection"') && html.indexOf("provider-test-row") < html.indexOf("actions-bar"), true);
  assert.match(css, /\.provider-test-row\s*\{[^}]*align-items:\s*flex-start/);
  assert.match(css, /\.provider-test-row\s*\{[^}]*gap:\s*12px/);
  assert.match(css, /\.provider-test-row\s*\{[^}]*margin-top:\s*12px/);
  assert.match(css, /\.provider-test-status\s*\{[^}]*flex:\s*1 1 180px/);
  assert.match(css, /\.provider-test-status\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.provider-test-status\s*\{[^}]*font:\s*400 12px\/1.45 var\(--oi-font\)/);
  assert.match(css, /#testConnection\.btn-secondary[^}]*font-weight:\s*500/);
  assert.match(css, /\.provider-test-status\.is-ok[^}]*var\(--oi-success/);
  assert.match(css, /\.provider-test-status\.is-err[^}]*var\(--oi-danger/);
  assert.equal(css.includes("actions-bar") && /actions-bar[\s\S]*testConnection/.test(html), false);

  assert.match(js, /harvestVisibleProvider\(\)/);
  assert.match(js, /missingRequiredField/);
  assert.match(js, /type:\s*["']OI_TEST_PROVIDER["']/);
  assert.match(js, /providerConfig/);
  assert.match(js, /texts:\s*\[PROVIDER_PROBE_TEXT\]/);
  assert.match(js, /sourceLang:\s*["']en["']/);
  assert.match(js, /targetLang/);
  assert.match(js, /测试中…/);
  assert.match(js, /正在探测…/);
  assert.match(js, /testRequestId/);
  assert.match(js, /btn\.disabled = true/);
  assert.match(js, /redactProviderText/);
  const testFn = js.slice(js.indexOf("async function testConnection"), js.indexOf("function renderProviderFields"));
  assert.match(testFn, /OI_TEST_PROVIDER/);
  assert.equal(testFn.includes("OI_SAVE_SETTINGS"), false);
  assert.ok(testFn.indexOf("missingRequiredField") < testFn.indexOf("OI_TEST_PROVIDER"));
  assert.ok(testFn.indexOf("return;") < testFn.indexOf("OI_TEST_PROVIDER"));
  assert.equal(js.includes("alert("), false);

  assert.match(sw, /case "OI_TEST_PROVIDER"/);
  assert.match(sw, /testProviderConnection/);
  assert.match(sw, /providerConfig/);
  const caseStart = sw.indexOf('case "OI_TEST_PROVIDER"');
  const caseBody = sw.slice(caseStart, sw.indexOf("case ", caseStart + 1));
  assert.match(caseBody, /testProviderConnection/);
  assert.equal(caseBody.includes("saveSettings"), false);
});
