import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LLM_PROMPT,
  resolveTranslatorPrompt,
  guardZhBusinessSense
} from "../lib/providers.js";

const CLAUDE_TITLE = "What 1,000 small business owners taught us about AI";

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

test("resolveTranslatorPrompt fills targetLang and adds zh glossary for zh-CN", () => {
  const prompt = resolveTranslatorPrompt({ targetLang: "zh-CN", settings: {} });
  assert.match(prompt, /zh-CN/);
  assert.doesNotMatch(prompt, /\{\{targetLang\}\}/);
  assert.match(prompt, /Glossary hint \(zh\)/);
  assert.match(prompt, /never 主教/i);
  assert.match(prompt, /one per line/i);
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
