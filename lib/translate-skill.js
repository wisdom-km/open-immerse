/**
 * Shared translation Skill / interface — vendor-agnostic.
 *
 * Product contract: the user may switch provider or model. As long as the
 * model is capable, every LLM adapter must produce 信达雅 output that stays
 * faithful to the source. This is not a one-off Claude-blog fix.
 *
 * Quality lives in DEFAULT_LLM_PROMPT. `guardZhBusinessSense` is only a
 * safety net for the known 主教 fusion — not the quality strategy.
 *
 * Optional two-step (`translateQuality: "refined"` / `twoStepTranslate: true`)
 * is ordinary language conversion (especially EN → modern Chinese):
 *   step1 信 — faithful draft
 *   step2 达雅 — natural fluent polish, no invented meaning
 * It is NOT classical Chinese, NOT 文言文, NOT 《诗经》, NOT literary multi-pass.
 * Default remains single-shot (`standard`) to save tokens.
 */

/** Maintainer-facing contract. Do not encode a vendor or a stock gloss here. */
export const TRANSLATION_SKILL_CONTRACT = [
  "Vendor/model may change; capable models share one Skill.",
  "信 first (faithful to the source), then 达 and 雅 (clear, elegant target language).",
  "Optional two-step (translateQuality=refined / twoStepTranslate): step1 faithful draft, step2 natural fluent polish.",
  "Two-step is ordinary language conversion (e.g. EN→modern ZH), not 文言文, not 《诗经》, not literary multi-pass.",
  "Titles: tight verb-led Chinese; no hollow calques.",
  "Never 主教 for business owners. Numbered one-per-line output.",
  "guardZhBusinessSense is a safety net, not this Skill.",
  "Default remains single-shot (standard) to save tokens."
].join(" ");

export const TRANSLATE_QUALITY_STANDARD = "standard";
export const TRANSLATE_QUALITY_REFINED = "refined";

export const DEFAULT_LLM_PROMPT = `You are a professional translator. Apply this shared translation Skill to every numbered segment.

Quality (信 first, then 达雅):
- 信: stay faithful to the source meaning, claim, tone, and proper nouns. Do not invent, omit, or change the domain.
- 达: use natural {{targetLang}} syntax. No word-for-word calques.
- 雅: once meaning is secure, prefer concise, elegant phrasing.

Translate each numbered segment into {{targetLang}}.
Do not translate code, URLs, or file paths.
Preserve the source domain (business, technical, everyday). Never replace it with religious or homophone nonsense.

When the target is Chinese (zh-CN / zh-TW):
- Keep business sense: "business owners" / "small business owners" → 企业主 / 小企业主 / 老板. NEVER 主教 (bishop).
- Do not fuse adjacent words into an unrelated term (e.g. "owners taught" must not become 主教).
- Phrases like "taught us" / "taught us about" are verbs, not a 教 suffix on the previous noun. Render them faithfully first, then in natural elegant Chinese — do not lock onto a stock phrase.
- Titles: prefer tight, verb-led Chinese. Avoid hollow calques such as 「让我们了解到的…的经验」.

Return ONLY the translations, one per line, prefixed with the same numbers. No explanations.`;

/** Optional glossary appended only when the default Skill is used for Chinese. */
export const ZH_GLOSSARY_HINT =
  "Glossary hint (zh): business owner(s) = 企业主/小企业主/老板 — never 主教.";

/**
 * Step 1 addendum when two-step is on. Thin wrapper around the Skill / custom prompt.
 * Faithful draft only — do not polish for style yet.
 */
export const STEP1_FAITHFUL_INSTRUCTION = `This is step 1 of 2 (信 / faithful draft).
Produce a faithful draft into {{targetLang}}.
Stay true to meaning, claim, tone, and proper nouns. Do not invent, omit, or change the domain.
Do not polish for style yet. This is ordinary language conversion — not classical Chinese, not 文言文, not 《诗经》.
Return ONLY the translations, one per line, prefixed with the same numbers. No explanations.`;

/**
 * Step 2 addendum when two-step is on. Polish the draft only.
 * Natural fluent modern target language — never invent meaning.
 */
export const STEP2_POLISH_INSTRUCTION = `This is step 2 of 2 (达雅 / polish).
You receive the source and a faithful draft. Polish the draft into natural, fluent, modern {{targetLang}}.
Do NOT invent, omit, or change meaning. Polish only — no new facts, no domain shift.
This is ordinary language conversion (especially English → modern Chinese), NOT literary classical Chinese, NOT 文言文, NOT 《诗经》 style.
Return ONLY the final translations, one per line, prefixed with the same numbers. No explanations.`;

/** True when the user opted into two-step refine. Default (standard / unset) is single-shot. */
export function isTwoStepTranslate(settings = {}) {
  if (settings && settings.twoStepTranslate === true) return true;
  return String(settings?.translateQuality || "").toLowerCase() === TRANSLATE_QUALITY_REFINED;
}

export function numberedSegments(texts) {
  return (Array.isArray(texts) ? texts : []).map((t, i) => `${i + 1}. ${t}`).join("\n");
}

/**
 * Build one LLM turn. Custom `settings.prompt` is already resolved into `skillPrompt`
 * and is reused as the Skill for both steps; two-step only appends these wrappers.
 */
export function buildLlmTurn({ texts, ctx = {}, skillPrompt, step = "single", drafts = [] } = {}) {
  const source = numberedSegments(texts);
  if (step === "polish") {
    return {
      system: `${skillPrompt}\n\n${fillSkillTemplate(STEP2_POLISH_INSTRUCTION, ctx)}`,
      user: `<source>\n${source}\n</source>\n<draft>\n${numberedSegments(drafts)}\n</draft>`
    };
  }
  if (step === "faithful") {
    return {
      system: `${skillPrompt}\n\n${fillSkillTemplate(STEP1_FAITHFUL_INSTRUCTION, ctx)}`,
      user: source
    };
  }
  return { system: skillPrompt, user: source };
}

function fillSkillTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] == null ? "" : String(vars[key])));
}
