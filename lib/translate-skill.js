/**
 * Shared translation Skill / interface — vendor-agnostic.
 *
 * Product contract: the user may switch provider or model. As long as the
 * model is capable, every LLM adapter must produce 信达雅 output that stays
 * faithful to the source. This is not a one-off Claude-blog fix.
 *
 * Quality lives in DEFAULT_LLM_PROMPT. `guardZhBusinessSense` is only a
 * safety net for the known 主教 fusion — not the quality strategy.
 */

/** Maintainer-facing contract. Do not encode a vendor or a stock gloss here. */
export const TRANSLATION_SKILL_CONTRACT = [
  "Vendor/model may change; capable models share one Skill.",
  "信 first (faithful to the source), then 达 and 雅 (clear, elegant target language).",
  "Titles: tight verb-led Chinese; no hollow calques.",
  "Never 主教 for business owners. Numbered one-per-line output.",
  "guardZhBusinessSense is a safety net, not this Skill."
].join(" ");

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
