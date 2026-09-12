import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LLM_PROMPT as SKILL_PROMPT,
  ZH_GLOSSARY_HINT
} from "../lib/translate-skill.js";
import {
  DEFAULT_LLM_PROMPT,
  resolveTranslatorPrompt,
  guardZhBusinessSense,
  providers
} from "../lib/providers.js";

const CLAUDE_TITLE = "What 1,000 small business owners taught us about AI";

function mockFetch(impl) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = prev;
  };
}

function readLlmTurn(body) {
  if (body.system) {
    return { system: body.system, user: body.messages[0].content, temperature: body.temperature };
  }
  if (body.contents) {
    const text = body.contents[0].parts[0].text;
    return { system: text, user: text, temperature: body.generationConfig?.temperature };
  }
  return {
    system: body.messages[0].content,
    user: body.messages[1].content,
    temperature: body.temperature
  };
}

test("providers re-exports the shared Skill prompt unchanged", () => {
  assert.equal(DEFAULT_LLM_PROMPT, SKILL_PROMPT);
});

test("default LLM prompt keeps numbered one-per-line output", () => {
  assert.match(DEFAULT_LLM_PROMPT, /one per line/i);
  assert.match(DEFAULT_LLM_PROMPT, /same numbers/i);
  assert.match(DEFAULT_LLM_PROMPT, /\{\{targetLang\}\}/);
});

test("default LLM prompt hardens zh-CN business-owner sense", () => {
  assert.match(DEFAULT_LLM_PROMPT, /企业主/);
  assert.match(DEFAULT_LLM_PROMPT, /小企业主/);
  assert.match(DEFAULT_LLM_PROMPT, /老板/);
  assert.match(DEFAULT_LLM_PROMPT, /NEVER 主教/);
  assert.match(DEFAULT_LLM_PROMPT, /business owners/);
  assert.match(DEFAULT_LLM_PROMPT, /homophone|religious/i);
});

test("default Skill does not prescribe 让我们了解到 as the taught-us rendering", () => {
  assert.doesNotMatch(DEFAULT_LLM_PROMPT, /taught us[^\n]*→[^\n]*(告诉我们|让我们了解到)/);
  assert.doesNotMatch(DEFAULT_LLM_PROMPT, /告诉我们 \/ 让我们了解到/);
  assert.match(DEFAULT_LLM_PROMPT, /faithful/i);
  assert.match(DEFAULT_LLM_PROMPT, /elegant|雅/);
  assert.match(DEFAULT_LLM_PROMPT, /verb-led/);
});

test("resolveTranslatorPrompt fills targetLang and adds zh glossary for zh-CN", () => {
  const prompt = resolveTranslatorPrompt({ targetLang: "zh-CN", settings: {} });
  assert.match(prompt, /zh-CN/);
  assert.doesNotMatch(prompt, /\{\{targetLang\}\}/);
  assert.match(prompt, /Glossary hint \(zh\)/);
  assert.match(prompt, /never 主教/i);
  assert.match(prompt, /one per line/i);
  assert.equal(prompt.includes(ZH_GLOSSARY_HINT), true);
  assert.match(prompt, /信 first|faithful/i);
});

test("resolveTranslatorPrompt does not add zh glossary for English", () => {
  const prompt = resolveTranslatorPrompt({ targetLang: "en", settings: {} });
  assert.match(prompt, /Translate each numbered segment into en/);
  assert.doesNotMatch(prompt, /Glossary hint \(zh\)/);
});

test("resolveTranslatorPrompt honors a custom prompt without rewriting it", () => {
  const prompt = resolveTranslatorPrompt({
    targetLang: "zh-CN",
    settings: { prompt: "Translate into {{targetLang}} only." }
  });
  assert.equal(prompt, "Translate into zh-CN only.");
  assert.doesNotMatch(prompt, /Glossary hint \(zh\)/);
  assert.doesNotMatch(prompt, /信 first/);
});

test("guardZhBusinessSense fixes fused 小企业主教 on the Claude blog title", () => {
  const [out] = guardZhBusinessSense(
    [CLAUDE_TITLE],
    ["1,000 位小企业主教我们了解人工智能"],
    "zh-CN"
  );
  assert.equal(out.includes("主教"), false);
  assert.match(out, /小企业主/);
});

test("guardZhBusinessSense leaves 主教 when the source is actually religious", () => {
  const src = "Small business owners met the bishop";
  const [out] = guardZhBusinessSense([src], ["小企业主会见了主教"], "zh-CN");
  assert.equal(out, "小企业主会见了主教");
});

test("guardZhBusinessSense is a no-op for non-Chinese targets", () => {
  const [out] = guardZhBusinessSense(["small business owners"], ["bishops"], "en");
  assert.equal(out, "bishops");
});

test("guard rewrites 小型企业主教", () => {
  const out = guardZhBusinessSense(
    ["What 1,000 small business owners taught us about AI"],
    ["1000位小型企业主教给我们的AI经验"],
    "zh-CN"
  );
  assert.equal(out[0].includes("主教"), false);
  assert.match(out[0], /企业主/);
});

test("guard rewrites 小型企业主教 even when source index is misaligned", () => {
  const out = guardZhBusinessSense(
    ["Some other sentence without the phrase"],
    ["1000家小型企业主教给我们的AI经验"],
    "zh-CN"
  );
  assert.equal(out[0].includes("主教"), false);
  assert.match(out[0], /企业主/);
});

test("guard rewrites 小型企业主教 when source is Lesson 1", () => {
  const [out] = guardZhBusinessSense(
    ["Lesson 1"],
    ["1000位小型企业主教给我们的AI经验"],
    "zh-CN"
  );
  assert.equal(out.includes("主教"), false);
  assert.match(out, /小企业主/);
  assert.equal(out, "1000位小企业主给我们的AI经验");
});

test("guard keeps 主教 when the misaligned source is actually religious", () => {
  const [out] = guardZhBusinessSense(
    ["Lesson 1: the bishop spoke"],
    ["1000位小型企业主教给我们的AI经验"],
    "zh-CN"
  );
  assert.equal(out, "1000位小型企业主教给我们的AI经验");
});

test("OpenAI-compat adapters send settings.model and the shared Skill prompt", async () => {
  const calls = [];
  const restore = mockFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: "1. 你好" } }] };
      }
    };
  });
  const ctx = {
    sourceLang: "en",
    targetLang: "zh-CN",
    settings: {
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
      model: "user-picked-model"
    }
  };
  const expectedPrompt = resolveTranslatorPrompt(ctx);
  try {
    for (const id of ["openai", "kimi", "minimax", "grok", "openrouter"]) {
      calls.length = 0;
      const out = await providers[id].translate(["Hello"], ctx);
      assert.equal(out[0], "你好");
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.model, "user-picked-model");
      assert.equal(body.messages[0].role, "system");
      assert.equal(body.messages[0].content, expectedPrompt);
      assert.doesNotMatch(body.messages[0].content, /告诉我们 \/ 让我们了解到/);
    }
  } finally {
    restore();
  }
});

test("Gemini, Claude, and Azure reuse the same Skill; custom prompt still wins", async () => {
  const calls = [];
  const restore = mockFetch(async (url, init) => {
    calls.push({ url: String(url), init });
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
  try {
    const defaultCtx = {
      sourceLang: "en",
      targetLang: "zh-CN",
      settings: { apiKey: "sk-test", model: "user-gemini", endpoint: "https://azure.example", deployment: "dep-1" }
    };
    const skill = resolveTranslatorPrompt(defaultCtx);

    await providers.gemini.translate(["Hello"], defaultCtx);
    assert.match(calls.at(-1).url, /models\/user-gemini:generateContent/);
    const geminiBody = JSON.parse(calls.at(-1).init.body);
    assert.equal(geminiBody.contents[0].parts[0].text.startsWith(`${skill}\n\n`), true);

    await providers.claude.translate(["Hello"], { ...defaultCtx, settings: { ...defaultCtx.settings, model: "user-claude" } });
    const claudeBody = JSON.parse(calls.at(-1).init.body);
    assert.equal(claudeBody.model, "user-claude");
    assert.equal(claudeBody.system, skill);

    await providers.azure.translate(["Hello"], defaultCtx);
    const azureBody = JSON.parse(calls.at(-1).init.body);
    assert.equal(azureBody.messages[0].content, skill);
    assert.equal(azureBody.model, undefined);

    const customCtx = {
      sourceLang: "en",
      targetLang: "zh-CN",
      settings: {
        apiKey: "sk-test",
        baseUrl: "https://api.example.com/v1",
        model: "still-user-model",
        prompt: "Translate into {{targetLang}} only."
      }
    };
    await providers.openai.translate(["Hello"], customCtx);
    const customBody = JSON.parse(calls.at(-1).init.body);
    assert.equal(customBody.model, "still-user-model");
    assert.equal(customBody.messages[0].content, "Translate into zh-CN only.");
  } finally {
    restore();
  }
});

test("two-step refined path is two chat calls; public translate() returns final lines only", async () => {
  const calls = [];
  let n = 0;
  const restore = mockFetch(async (url, init) => {
    n += 1;
    calls.push({ url: String(url), init });
    const content = n % 2 === 1 ? "1. 草稿你好" : "1. 你好呀";
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content } }],
          candidates: [{ content: { parts: [{ text: content }] } }],
          content: [{ text: content }]
        };
      }
    };
  });
  const ctx = {
    sourceLang: "en",
    targetLang: "zh-CN",
    settings: {
      apiKey: "sk-test",
      baseUrl: "https://api.example.com/v1",
      model: "user-picked-model",
      endpoint: "https://azure.example",
      deployment: "dep-1",
      translateQuality: "refined"
    }
  };
  const skill = resolveTranslatorPrompt(ctx);
  try {
    for (const id of ["openai", "kimi", "minimax", "grok", "openrouter", "gemini", "claude", "azure"]) {
      calls.length = 0;
      n = 0;
      const out = await providers[id].translate(["Hello"], ctx);
      assert.deepEqual(out, ["你好呀"]);
      assert.equal(calls.length, 2, id);
      const first = readLlmTurn(JSON.parse(calls[0].init.body));
      const second = readLlmTurn(JSON.parse(calls[1].init.body));
      assert.match(first.system, /step 1 of 2/i);
      assert.equal(first.system.includes(skill.slice(0, 40)), true);
      assert.match(second.system, /step 2 of 2/i);
      assert.match(second.system, /Do NOT invent/i);
      assert.match(second.user, /<source>/);
      assert.match(second.user, /<draft>/);
      assert.match(second.user, /草稿你好/);
      assert.match(first.user, /1\. Hello/);
      assert.equal(first.temperature, 0.2);
      assert.equal(second.temperature, 0.2);
    }
  } finally {
    restore();
  }
});

test("custom prompt is the Skill for both two-step turns", async () => {
  const calls = [];
  let n = 0;
  const restore = mockFetch(async (_url, init) => {
    n += 1;
    calls.push(init);
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: n === 1 ? "1. 草" : "1. 成" } }] };
      }
    };
  });
  try {
    const out = await providers.openai.translate(["Hello"], {
      sourceLang: "en",
      targetLang: "zh-CN",
      settings: {
        apiKey: "sk-test",
        baseUrl: "https://api.example.com/v1",
        model: "still-user-model",
        prompt: "Translate into {{targetLang}} only.",
        twoStepTranslate: true
      }
    });
    assert.deepEqual(out, ["成"]);
    assert.equal(calls.length, 2);
    const first = JSON.parse(calls[0].body);
    const second = JSON.parse(calls[1].body);
    assert.match(first.messages[0].content, /^Translate into zh-CN only\./);
    assert.match(first.messages[0].content, /step 1 of 2/i);
    assert.match(second.messages[0].content, /^Translate into zh-CN only\./);
    assert.match(second.messages[0].content, /step 2 of 2/i);
    assert.doesNotMatch(first.messages[0].content, /Glossary hint \(zh\)/);
  } finally {
    restore();
  }
});

test("machine providers ignore two-step and stay single-shot", async () => {
  const calls = [];
  const restore = mockFetch(async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      async json() {
        return { responseData: { translatedText: "hola" } };
      }
    };
  });
  try {
    const out = await providers.mymemory.translate(["Hello"], {
      sourceLang: "en",
      targetLang: "es",
      settings: { translateQuality: "refined", twoStepTranslate: true }
    });
    assert.deepEqual(out, ["hola"]);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test("default single-shot still one request when translateQuality is standard", async () => {
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
        baseUrl: "https://api.example.com/v1",
        model: "user-picked-model",
        translateQuality: "standard"
      }
    });
    assert.deepEqual(out, ["你好"]);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].body);
    assert.doesNotMatch(body.messages[0].content, /step 1 of 2/i);
    assert.equal(body.temperature, 0.2);
  } finally {
    restore();
  }
});
