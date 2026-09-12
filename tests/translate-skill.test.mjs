import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LLM_PROMPT,
  TRANSLATION_SKILL_CONTRACT,
  ZH_GLOSSARY_HINT
} from "../lib/translate-skill.js";

test("translation Skill contract documents 信达雅 and the safety-net boundary", () => {
  assert.match(TRANSLATION_SKILL_CONTRACT, /信/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /达/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /雅/);
  assert.match(TRANSLATION_SKILL_CONTRACT, /faithful/i);
  assert.match(TRANSLATION_SKILL_CONTRACT, /guardZhBusinessSense/);
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

test("ZH glossary hint stays optional and never 主教", () => {
  assert.match(ZH_GLOSSARY_HINT, /Glossary hint \(zh\)/);
  assert.match(ZH_GLOSSARY_HINT, /企业主/);
  assert.match(ZH_GLOSSARY_HINT, /never 主教/i);
});
