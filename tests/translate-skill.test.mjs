import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LLM_PROMPT,
  STEP1_FAITHFUL_INSTRUCTION,
  STEP2_POLISH_INSTRUCTION,
  TRANSLATION_SKILL_CONTRACT,
  ZH_GLOSSARY_HINT,
  buildLlmTurn,
  hasCustomTranslatorPrompt,
  isTwoStepPolish,
  numberedSegments
} from "../lib/translate-skill.js";

test("translation Skill contract documents 信达雅 and the safety-net boundary", () => {
  assert.match(TRANSLATION_SKILL_CONTRACT, /信/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /达/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /雅/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /faithful/i);
  assert.match(TRANSLATION_SKILL_CONTRACT, /guardZhBusinessSense/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /guardZhTitleCalques/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /safety net/i);
  assert.doesNotMatch(TRANSLATION_SKILL_CONTRACT, /volc|ark|doubao|openai|claude|gemini/i);
  assert.doesNotMatch(TRANSLATION_SKILL_CONTRACT, /让我们了解到/);
});

test("default Skill prompt is 信-first 达雅, not a stock taught-us gloss", () => {
  assert.match(DEFAULT_LLM_PROMPT, /信 first|信：|信:/);
  assert.match(DEFAULT_LLM_PROMPT, /faithful/i);
  assert.match(DEFAULT_LLM_PROMPT, /达雅|elegant/i);
  assert.match(DEFAULT_LLM_PROMPT, /Titles:|titles:/i);
  assert.match(DEFAULT_LLM_PROMPT, /verb-led/i);
  assert.match(DEFAULT_LLM_PROMPT, /calque/i);
  assert.match(DEFAULT_LLM_PROMPT, /one per line/i);
  assert.match(DEFAULT_LLM_PROMPT, /same numbers/i);
  assert.match(DEFAULT_LLM_PROMPT, /\{\{targetLang\}\}/);
  assert.doesNotMatch(DEFAULT_LLM_PROMPT, /taught us[^\n]*→[^\n]*(告诉我们|让我们了解到)/);
  assert.doesNotMatch(DEFAULT_LLM_PROMPT, /告诉我们 \/ 让我们了解到/);
});

test("default Skill and step2 hard-ban title calques 让我们了解到 / 关于…哪些内容", () => {
  assert.match(DEFAULT_LLM_PROMPT, /FORBID|禁止/);
  assert.match(DEFAULT_LLM_PROMPT, /让我们了解到/);
  assert.match(DEFAULT_LLM_PROMPT, /让我们了解到的/);
  assert.match(DEFAULT_LLM_PROMPT, /哪些内容/);
  assert.match(DEFAULT_LLM_PROMPT, /taught us about/);
  assert.match(STEP2_POLISH_INSTRUCTION, /FORBID|禁止/);
  assert.match(STEP2_POLISH_INSTRUCTION, /让我们了解到/);
  assert.match(STEP2_POLISH_INSTRUCTION, /让我们了解到的/);
  assert.match(STEP2_POLISH_INSTRUCTION, /哪些内容/);
  assert.match(STEP2_POLISH_INSTRUCTION, /title/i);
  assert.doesNotMatch(DEFAULT_LLM_PROMPT + STEP2_POLISH_INSTRUCTION, /taught us[^\n]*→[^\n]*(告诉我们|让我们了解到)/);
});

test("ZH glossary hint stays optional and never 主教", () => {
  assert.match(ZH_GLOSSARY_HINT, /Glossary hint \(zh\)/);
  assert.match(ZH_GLOSSARY_HINT, /企业主/);
  assert.match(ZH_GLOSSARY_HINT, /never 主教/i);
});

test("two-step is ordinary language conversion, not classical literary style", () => {
  assert.match(TRANSLATION_SKILL_CONTRACT, /two-step|两步/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /ordinary language conversion/i);
  assert.match(TRANSLATION_SKILL_CONTRACT, /文言文/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /诗经/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /single-shot|standard/);
  assert.doesNotMatch(TRANSLATION_SKILL_CONTRACT, /Li Jigang|五轮|SVG/i);
});

test("isTwoStepPolish defaults off; custom prompt skips polish", () => {
  assert.equal(isTwoStepPolish(), false);
  assert.equal(isTwoStepPolish({}), false);
  assert.equal(isTwoStepPolish({ twoStepPolish: false }), false);
  assert.equal(isTwoStepPolish({ twoStepPolish: true }), true);
  assert.equal(hasCustomTranslatorPrompt({ prompt: "  " }), false);
  assert.equal(hasCustomTranslatorPrompt({ prompt: "Translate only." }), true);
  assert.equal(isTwoStepPolish({ twoStepPolish: true, prompt: "Translate into zh-CN only." }), false);
});

test("step1 is 信 draft; step2 is 达雅 polish without inventing meaning", () => {
  assert.match(STEP1_FAITHFUL_INSTRUCTION, /step 1 of 2/i);
  assert.match(STEP1_FAITHFUL_INSTRUCTION, /信/);
  assert.match(STEP1_FAITHFUL_INSTRUCTION, /faithful/i);
  assert.match(STEP1_FAITHFUL_INSTRUCTION, /Do not polish/i);
  assert.match(STEP1_FAITHFUL_INSTRUCTION, /one per line/i);
  assert.match(STEP1_FAITHFUL_INSTRUCTION, /文言文|诗经/);
  assert.match(STEP2_POLISH_INSTRUCTION, /step 2 of 2/i);
  assert.match(STEP2_POLISH_INSTRUCTION, /达雅|polish/i);
  assert.match(STEP2_POLISH_INSTRUCTION, /Do NOT invent/i);
  assert.match(STEP2_POLISH_INSTRUCTION, /Polish only/i);
  assert.match(STEP2_POLISH_INSTRUCTION, /modern/i);
  assert.match(STEP2_POLISH_INSTRUCTION, /NOT.*文言文/i);
  assert.match(STEP2_POLISH_INSTRUCTION, /NOT.*诗经/);
  assert.match(STEP2_POLISH_INSTRUCTION, /one per line/i);
  assert.match(STEP2_POLISH_INSTRUCTION, /让我们了解到/);
  assert.doesNotMatch(STEP1_FAITHFUL_INSTRUCTION + STEP2_POLISH_INSTRUCTION, /Li Jigang|五轮|SVG card/i);
});

test("buildLlmTurn single-shot is numbered lines with the Skill as system", () => {
  const turn = buildLlmTurn({
    texts: ["Hello"],
    ctx: { targetLang: "zh-CN" },
    skillPrompt: "SKILL",
    step: "single"
  });
  assert.equal(turn.system, "SKILL");
  assert.equal(turn.user, "1. Hello");
  assert.equal(numberedSegments(["A", "B"]), "1. A\n2. B");
});

test("buildLlmTurn two-step wraps the shared Skill for polish", () => {
  const skill = "Translate into zh-CN only.";
  const draft = buildLlmTurn({
    texts: ["Hello"],
    ctx: { targetLang: "zh-CN" },
    skillPrompt: skill,
    step: "faithful"
  });
  assert.match(draft.system, /Translate into zh-CN only/);
  assert.match(draft.system, /step 1 of 2/i);
  assert.match(draft.system, /zh-CN/);
  assert.equal(draft.user, "1. Hello");

  const polish = buildLlmTurn({
    texts: ["Hello"],
    ctx: { targetLang: "zh-CN" },
    skillPrompt: skill,
    step: "polish",
    drafts: ["你好草稿"]
  });
  assert.match(polish.system, /Translate into zh-CN only/);
  assert.match(polish.system, /step 2 of 2/i);
  assert.match(polish.system, /Do NOT invent/i);
  assert.match(polish.system, /让我们了解到/);
  assert.match(polish.system, /哪些内容/);
  assert.match(polish.user, /<source>/);
  assert.match(polish.user, /1\. Hello/);
  assert.match(polish.user, /<draft>/);
  assert.match(polish.user, /1\. 你好草稿/);
});
