import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyChatThinking, isThinkingEnabled, providers } from "../lib/providers.js";
import { DEFAULT_SETTINGS } from "../lib/storage.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function mockFetch(impl) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = prev;
  };
}

test("enableThinking defaults off and only true is on", () => {
  assert.equal(DEFAULT_SETTINGS.enableThinking, false);
  assert.equal(isThinkingEnabled(undefined), false);
  assert.equal(isThinkingEnabled({}), false);
  assert.equal(isThinkingEnabled({ enableThinking: false }), false);
  assert.equal(isThinkingEnabled({ enableThinking: "true" }), false);
  assert.equal(isThinkingEnabled({ enableThinking: true }), true);
});

test("applyChatThinking disables thinking by default and enables when toggled", () => {
  const off = applyChatThinking({ model: "deepseek-v4-flash" }, {});
  assert.deepEqual(off.thinking, { type: "disabled" });
  assert.equal(off.reasoning_effort, "minimal");
  assert.equal(off.model, "deepseek-v4-flash");

  const explicitOff = applyChatThinking({ reasoning_effort: "high" }, { enableThinking: false });
  assert.deepEqual(explicitOff.thinking, { type: "disabled" });
  assert.equal(explicitOff.reasoning_effort, "minimal");

  const on = applyChatThinking({ reasoning_effort: "minimal" }, { enableThinking: true });
  assert.deepEqual(on.thinking, { type: "enabled" });
  assert.equal(on.reasoning_effort, undefined);
});

test("OpenAI-compat translate payload includes thinking disabled by default", async () => {
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
    for (const id of ["openai", "kimi", "minimax", "grok", "openrouter"]) {
      calls.length = 0;
      const out = await providers[id].translate(["Hello"], {
        sourceLang: "en",
        targetLang: "zh-CN",
        settings: {
          apiKey: "sk-test",
          baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
          model: "deepseek-v4-flash"
        }
      });
      assert.equal(out[0], "你好", id);
      const body = JSON.parse(calls[0].body);
      assert.equal(body.stream, undefined, id);
      assert.deepEqual(body.thinking, { type: "disabled" }, id);
      assert.equal(body.reasoning_effort, "minimal", id);
    }
  } finally {
    restore();
  }
});

test("OpenAI-compat translate payload enables thinking when toggle is on", async () => {
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
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        model: "deepseek-v4-flash",
        enableThinking: true
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

test("Gemini and Claude stay non-stream and do not get thinking fields", async () => {
  const calls = [];
  const restore = mockFetch(async (_url, init) => {
    calls.push(init);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          candidates: [{ content: { parts: [{ text: "1. 你好" }] } }],
          content: [{ text: "1. 你好" }]
        };
      }
    };
  });
  try {
    const ctx = {
      sourceLang: "en",
      targetLang: "zh-CN",
      settings: { apiKey: "sk-test", model: "gemini-2.0-flash", enableThinking: false }
    };
    await providers.gemini.translate(["Hello"], ctx);
    const gemini = JSON.parse(calls[0].body);
    assert.equal(gemini.thinking, undefined);
    assert.equal(gemini.reasoning_effort, undefined);
    assert.equal(gemini.stream, undefined);

    await providers.claude.translate(["Hello"], ctx);
    const claude = JSON.parse(calls[1].body);
    assert.equal(claude.thinking, undefined);
    assert.equal(claude.reasoning_effort, undefined);
    assert.equal(claude.stream, undefined);
  } finally {
    restore();
  }
});

test("SW and options persist enableThinking on the shared translate path", () => {
  const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");
  const optJs = readFileSync(join(root, "options/options.js"), "utf8");
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  assert.match(sw, /enableThinking: settings\.enableThinking === true/);
  assert.match(optJs, /enableThinking: el\("enableThinking"\)\.checked/);
  assert.match(html, /id="enableThinking"/);
  assert.doesNotMatch(sw, /\/responses/);
});
