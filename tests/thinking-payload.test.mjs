import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyChatThinking, isThinkingEnabled, providers, shouldAttachThinking } from "../lib/providers.js";
import { DEFAULT_SETTINGS } from "../lib/storage.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const DEEPSEEK_BASE = "https://api.deepseek.com";

function mockFetch(impl) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = prev;
  };
}

test("deepThink defaults off and only true is on", () => {
  assert.equal(DEFAULT_SETTINGS.deepThink, false);
  assert.equal(isThinkingEnabled(undefined), false);
  assert.equal(isThinkingEnabled({}), false);
  assert.equal(isThinkingEnabled({ deepThink: false }), false);
  assert.equal(isThinkingEnabled({ deepThink: "true" }), false);
  assert.equal(isThinkingEnabled({ enableThinking: true }), false);
  assert.equal(isThinkingEnabled({ deepThink: true }), true);
});

test("shouldAttachThinking only for Ark / DeepSeek, never other engines", () => {
  assert.equal(shouldAttachThinking({ baseUrl: ARK_BASE, model: "deepseek-v4-flash" }), true);
  assert.equal(shouldAttachThinking({ baseUrl: DEEPSEEK_BASE, model: "deepseek-v4-flash" }), true);
  assert.equal(shouldAttachThinking({ model: "deepseek-v4-flash" }, {}), true);
  assert.equal(shouldAttachThinking({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }), false);
  assert.equal(shouldAttachThinking({ baseUrl: "https://api.openai.com/v1", model: "deepseek-v4-flash" }), false);
  assert.equal(shouldAttachThinking({ baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.5" }), false);
  assert.equal(shouldAttachThinking({ baseUrl: "https://api.minimax.cn/v1", model: "MiniMax-M2.5" }), false);
  assert.equal(shouldAttachThinking({ baseUrl: "https://api.x.ai/v1", model: "grok-4-fast" }), false);
  assert.equal(shouldAttachThinking({ baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4-flash" }), false);
});

test("applyChatThinking disables thinking for Ark/DeepSeek and omits elsewhere", () => {
  const arkOff = applyChatThinking({ model: "deepseek-v4-flash" }, { baseUrl: ARK_BASE });
  assert.deepEqual(arkOff.thinking, { type: "disabled" });
  assert.equal(arkOff.reasoning_effort, "minimal");

  const arkOn = applyChatThinking({ model: "deepseek-v4-flash", reasoning_effort: "minimal" }, {
    baseUrl: ARK_BASE,
    deepThink: true
  });
  assert.deepEqual(arkOn.thinking, { type: "enabled" });
  assert.equal(arkOn.reasoning_effort, undefined);

  const openai = applyChatThinking({ model: "gpt-4o-mini" }, { baseUrl: "https://api.openai.com/v1" });
  assert.equal(openai.thinking, undefined);
  assert.equal(openai.reasoning_effort, undefined);

  const leftover = applyChatThinking(
    { model: "gpt-4o-mini", thinking: { type: "disabled" }, reasoning_effort: "minimal" },
    { baseUrl: "https://api.openai.com/v1" }
  );
  assert.equal(leftover.thinking, undefined);
  assert.equal(leftover.reasoning_effort, undefined);
});

test("Ark / DeepSeek translate payload includes thinking disabled by default", async () => {
  const calls = [];
  const restore = mockFetch(async (_url, init) => {
    calls.push(init);
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "1. 你好" } }] };
      }
    };
  });
  try {
    const out = await providers.openai.translate(["Hello"], {
      sourceLang: "en",
      targetLang: "zh-CN",
      settings: {
        apiKey: "sk-test",
        baseUrl: ARK_BASE,
        model: "deepseek-v4-flash"
      }
    });
    assert.equal(out[0], "你好");
    const body = JSON.parse(calls[0].body);
    assert.equal(body.stream, undefined);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.reasoning_effort, "minimal");
  } finally {
    restore();
  }
});

test("Ark / DeepSeek translate payload enables thinking when deepThink is on", async () => {
  const calls = [];
  const restore = mockFetch(async (_url, init) => {
    calls.push(init);
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "1. 你好" } }] };
      }
    };
  });
  try {
    const out = await providers.openai.translate(["Hello"], {
      sourceLang: "en",
      targetLang: "zh-CN",
      settings: {
        apiKey: "sk-test",
        baseUrl: ARK_BASE,
        model: "deepseek-v4-flash",
        deepThink: true
      }
    });
    assert.equal(out[0], "你好");
    const body = JSON.parse(calls[0].body);
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.stream, undefined);
  } finally {
    restore();
  }
});

test("other engines omit thinking fields even when deepThink is on", async () => {
  const calls = [];
  const restore = mockFetch(async (_url, init) => {
    calls.push(init);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: "1. 你好" } }],
          candidates: [{ content: { parts: [{ text: "1. 你好" }] } }],
          content: [{ text: "1. 你好" }]
        };
      }
    };
  });
  const others = [
    ["openai", { apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", deepThink: true }],
    ["kimi", { apiKey: "sk-test", model: "kimi-k2.5", deepThink: true }],
    ["minimax", { apiKey: "sk-test", model: "MiniMax-M2.5", deepThink: true }],
    ["grok", { apiKey: "sk-test", model: "grok-4-fast", deepThink: true }],
    ["openrouter", { apiKey: "sk-test", model: "deepseek/deepseek-v4-flash", deepThink: true }],
    ["gemini", { apiKey: "sk-test", model: "gemini-2.0-flash", deepThink: true }],
    ["claude", { apiKey: "sk-test", model: "claude-3-5-haiku-latest", deepThink: true }]
  ];
  try {
    for (const [id, settings] of others) {
      calls.length = 0;
      const out = await providers[id].translate(["Hello"], {
        sourceLang: "en",
        targetLang: "zh-CN",
        settings
      });
      assert.equal(out[0], "你好", id);
      const body = JSON.parse(calls[0].body);
      assert.equal(body.thinking, undefined, id);
      assert.equal(body.reasoning_effort, undefined, id);
      assert.equal(body.stream, undefined, id);
    }
  } finally {
    restore();
  }
});

test("SW and options persist deepThink on the shared translate path", () => {
  const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");
  const optJs = readFileSync(join(root, "options/options.js"), "utf8");
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  assert.match(sw, /deepThink: settings\.deepThink === true/);
  assert.match(optJs, /deepThink: el\("deepThink"\)\.checked/);
  assert.match(html, /id="deepThink"[^>]*>\s*深度思考/);
  assert.match(html, /id="deepThinkHint">\s*关闭可加快 DeepSeek \/ Ark 翻译；默认关。/);
  assert.doesNotMatch(sw, /\/responses/);
  assert.doesNotMatch(readFileSync(join(root, "lib/providers.js"), "utf8"), /stream:\s*true/);
});
