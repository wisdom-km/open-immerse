/**
 * Provider adapters. Each item: { id, name, kind, fields, translate(texts, ctx) }
 * ctx = { sourceLang, targetLang, settings }
 */

export const LANGUAGE_OPTIONS = [
  { code: "auto", label: "自动检测 / Auto" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "it", label: "Italiano" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "th", label: "ไทย" },
  { code: "ar", label: "العربية" },
  { code: "hi", label: "हिन्दी" },
  { code: "id", label: "Bahasa Indonesia" }
];

export const DEFAULT_LLM_PROMPT = `You are a professional translator. Translate each numbered segment into {{targetLang}}.
Keep meaning, tone, and proper nouns. Do not translate code, URLs, or file paths.
Preserve the source domain (business, technical, everyday). Never replace it with religious or homophone nonsense.
When the target is Chinese (zh-CN / zh-TW):
- Keep business sense: "business owners" / "small business owners" → 企业主 / 小企业主 / 老板. NEVER 主教 (bishop).
- Do not fuse adjacent words into an unrelated term (e.g. "owners taught" must not become 主教).
- "taught us" / "taught us about" is a verb phrase → 告诉我们 / 让我们了解到, not a 教 suffix glued onto the previous noun.
Return ONLY the translations, one per line, prefixed with the same numbers. No explanations.`;

const ZH_CN_SENSE_HINT =
  "Glossary hint (zh): business owner(s) = 企业主/小企业主/老板 — never 主教.";

function isChineseTarget(code) {
  const lang = String(code || "").toLowerCase();
  return lang === "zh" || lang.startsWith("zh-");
}

/** Shared prompt helper used by every LLM adapter. */
export function resolveTranslatorPrompt(ctx = {}) {
  const custom = String(ctx.settings?.prompt || "").trim();
  const prompt = fillTemplate(custom || DEFAULT_LLM_PROMPT, ctx);
  if (!custom && isChineseTarget(ctx.targetLang)) {
    return `${prompt}\n${ZH_CN_SENSE_HINT}`;
  }
  return prompt;
}

/**
 * Narrow zh-CN safety net for the known "business owners" → 主教 fusion.
 * Only rewrites 企业主教 / 小企业主教 when the source is about business owners
 * and is not actually religious.
 */
export function guardZhBusinessSense(texts, translations, targetLang) {
  if (!isChineseTarget(targetLang) || !Array.isArray(translations)) return translations;
  return translations.map((dst, i) => {
    const src = String(texts?.[i] || "");
    const out = String(dst || "");
    if (!/\bbusiness owners?\b/i.test(src) || !/主教/.test(out)) return out;
    if (/\b(bishop|bishops|church|catholic|priest|pope|diocese|clergy)\b/i.test(src)) return out;
    return out
      .replace(/小型企业主教/g, "小企业主")
      .replace(/小企业主教/g, "小企业主")
      .replace(/企业主教/g, "企业主");
  });
}

function parseLlmTranslations(raw, texts, targetLang) {
  return guardZhBusinessSense(texts, parseNumbered(raw, texts.length), targetLang);
}

function assertOk(res, label) {
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
}

function fillTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] == null ? "" : String(vars[key])));
}

function getByPath(obj, path) {
  if (!path) return obj;
  return path.split(".").reduce((acc, key) => {
    if (acc == null) return acc;
    const m = key.match(/^(\w+)\[(\d+)\]$/);
    return m ? acc[m[1]]?.[Number(m[2])] : acc[key];
  }, obj);
}

async function postJson(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

async function translateChatCompletions(texts, ctx, opts) {
  const base = String(ctx.settings.baseUrl || opts.fallbackBase || "").replace(/\/$/, "");
  if (!base) throw new Error(`${opts.label} 缺少 Base URL`);
  const prompt = resolveTranslatorPrompt(ctx);
  const user = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const headers = { "Content-Type": "application/json", ...(opts.extraHeaders || {}) };
  if (ctx.settings.apiKey) headers.Authorization = `Bearer ${ctx.settings.apiKey}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: ctx.settings.model || opts.fallbackModel,
      temperature: 0.2,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: user }
      ]
    })
  });
  assertOk(res, opts.label || "LLM");
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content || "";
  return parseLlmTranslations(raw, texts, ctx.targetLang);
}

function openaiCompatProvider({ id, name, defaultBase, defaultModel, extraFields = [], extraHeaders }) {
  return {
    id,
    name,
    kind: "llm",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", required: true },
      { key: "baseUrl", label: "Base URL（可改）", type: "text", placeholder: defaultBase },
      { key: "model", label: "模型", type: "text", placeholder: defaultModel },
      ...extraFields,
      { key: "prompt", label: "系统提示词", type: "textarea" }
    ],
    async translate(texts, ctx) {
      const headers = typeof extraHeaders === "function" ? extraHeaders(ctx) : extraHeaders;
      return translateChatCompletions(texts, ctx, {
        label: name,
        fallbackBase: resolveBase(ctx, defaultBase),
        fallbackModel: defaultModel,
        extraHeaders: headers
      });
    }
  };
}

function resolveBase(ctx, fallback) {
  if (ctx.settings.baseUrl) return ctx.settings.baseUrl;
  if (ctx.settings.endpoint === "global" && fallback.includes("moonshot.cn")) return "https://api.moonshot.ai/v1";
  if (ctx.settings.endpoint === "global" && fallback.includes("minimax.cn")) return "https://api.minimax.io/v1";
  if (ctx.settings.endpoint === "cn" && fallback.includes("moonshot.ai")) return "https://api.moonshot.cn/v1";
  if (ctx.settings.endpoint === "cn" && fallback.includes("minimax.io")) return "https://api.minimax.cn/v1";
  return fallback;
}

export const providers = {
  mymemory: {
    id: "mymemory",
    name: "MyMemory (免费试用)",
    kind: "machine",
    fields: [{ key: "email", label: "Email（提高额度，可选）", type: "text" }],
    async translate(texts, ctx) {
      const pair = `${ctx.sourceLang === "auto" ? "Autodetect" : ctx.sourceLang}|${ctx.targetLang}`;
      const out = [];
      for (const text of texts) {
        const url = new URL("https://api.mymemory.translated.net/get");
        url.searchParams.set("q", text.slice(0, 500));
        url.searchParams.set("langpair", pair);
        if (ctx.settings.email) url.searchParams.set("de", ctx.settings.email);
        const res = await fetch(url);
        assertOk(res, "MyMemory");
        const data = await res.json();
        out.push(data?.responseData?.translatedText || "");
      }
      return out;
    }
  },

  microsoft: {
    id: "microsoft",
    name: "Microsoft Translator",
    kind: "machine",
    fields: [
      { key: "apiKey", label: "订阅密钥 Subscription Key", type: "password", required: true },
      { key: "region", label: "区域 Region（如 eastasia）", type: "text", placeholder: "eastasia" },
      { key: "endpoint", label: "Endpoint", type: "text", placeholder: "https://api.cognitive.microsofttranslator.com" }
    ],
    async translate(texts, ctx) {
      const endpoint = (ctx.settings.endpoint || "https://api.cognitive.microsofttranslator.com").replace(/\/$/, "");
      const to = encodeURIComponent(mapMsLang(ctx.targetLang));
      const from = ctx.sourceLang !== "auto" ? `&from=${encodeURIComponent(mapMsLang(ctx.sourceLang))}` : "";
      const res = await postJson(
        `${endpoint}/translate?api-version=3.0&to=${to}${from}`,
        texts.map((text) => ({ text })),
        {
          "Ocp-Apim-Subscription-Key": ctx.settings.apiKey,
          ...(ctx.settings.region ? { "Ocp-Apim-Subscription-Region": ctx.settings.region } : {})
        }
      );
      assertOk(res, "Microsoft");
      const data = await res.json();
      return data.map((item) => item?.translations?.[0]?.text || "");
    }
  },

  deepl: {
    id: "deepl",
    name: "DeepL",
    kind: "machine",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", required: true },
      {
        key: "plan",
        label: "套餐",
        type: "select",
        options: [
          { value: "free", label: "Free (api-free.deepl.com)" },
          { value: "pro", label: "Pro (api.deepl.com)" }
        ]
      }
    ],
    async translate(texts, ctx) {
      const host = ctx.settings.plan === "pro" ? "https://api.deepl.com" : "https://api-free.deepl.com";
      const body = new URLSearchParams();
      texts.forEach((t) => body.append("text", t));
      if (ctx.sourceLang !== "auto") body.set("source_lang", mapDeepL(ctx.sourceLang));
      body.set("target_lang", mapDeepL(ctx.targetLang));
      const res = await fetch(`${host}/v2/translate`, {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${ctx.settings.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body
      });
      assertOk(res, "DeepL");
      const data = await res.json();
      return (data.translations || []).map((t) => t.text || "");
    }
  },

  google: {
    id: "google",
    name: "Google Cloud Translation",
    kind: "machine",
    fields: [{ key: "apiKey", label: "API Key", type: "password", required: true }],
    async translate(texts, ctx) {
      const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(ctx.settings.apiKey)}`;
      const res = await postJson(url, {
        q: texts,
        target: ctx.targetLang,
        ...(ctx.sourceLang !== "auto" ? { source: ctx.sourceLang } : {}),
        format: "text"
      });
      assertOk(res, "Google");
      const data = await res.json();
      return (data.data?.translations || []).map((t) => t.translatedText || "");
    }
  },

  openai: openaiCompatProvider({
    id: "openai",
    name: "OpenAI / 兼容通道",
    defaultBase: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini"
  }),

  kimi: openaiCompatProvider({
    id: "kimi",
    name: "Kimi / 月之暗面",
    defaultBase: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.5",
    extraFields: [
      {
        key: "endpoint",
        label: "区域",
        type: "select",
        options: [
          { value: "cn", label: "国内 api.moonshot.cn" },
          { value: "global", label: "国际 api.moonshot.ai" }
        ]
      }
    ]
  }),

  minimax: openaiCompatProvider({
    id: "minimax",
    name: "MiniMax",
    defaultBase: "https://api.minimax.cn/v1",
    defaultModel: "MiniMax-M2.5",
    extraFields: [
      {
        key: "endpoint",
        label: "区域",
        type: "select",
        options: [
          { value: "cn", label: "国内 api.minimax.cn" },
          { value: "global", label: "国际 api.minimax.io" }
        ]
      }
    ]
  }),

  grok: openaiCompatProvider({
    id: "grok",
    name: "xAI Grok",
    defaultBase: "https://api.x.ai/v1",
    defaultModel: "grok-4-fast"
  }),

  openrouter: openaiCompatProvider({
    id: "openrouter",
    name: "OpenRouter",
    defaultBase: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    extraFields: [
      { key: "referer", label: "HTTP-Referer（可选）", type: "text", placeholder: "https://github.com/wisdom-km/open-immerse" },
      { key: "appTitle", label: "X-Title（可选）", type: "text", placeholder: "Open Immerse" }
    ],
    extraHeaders: (ctx) => ({
      "HTTP-Referer": ctx.settings.referer || "https://github.com/wisdom-km/open-immerse",
      "X-Title": ctx.settings.appTitle || "Open Immerse"
    })
  }),

  gemini: {
    id: "gemini",
    name: "Google Gemini",
    kind: "llm",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", required: true },
      { key: "model", label: "模型", type: "text", placeholder: "gemini-2.0-flash" },
      { key: "prompt", label: "系统提示词", type: "textarea" }
    ],
    async translate(texts, ctx) {
      const model = ctx.settings.model || "gemini-2.0-flash";
      const prompt = resolveTranslatorPrompt(ctx);
      const user = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ctx.settings.apiKey)}`;
      const res = await postJson(url, {
        contents: [{ role: "user", parts: [{ text: `${prompt}\n\n${user}` }] }]
      });
      assertOk(res, "Gemini");
      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
      return parseLlmTranslations(raw, texts, ctx.targetLang);
    }
  },

  claude: {
    id: "claude",
    name: "Anthropic Claude",
    kind: "llm",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", required: true },
      { key: "model", label: "模型", type: "text", placeholder: "claude-3-5-haiku-latest" },
      { key: "prompt", label: "系统提示词", type: "textarea" }
    ],
    async translate(texts, ctx) {
      const prompt = resolveTranslatorPrompt(ctx);
      const user = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ctx.settings.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: ctx.settings.model || "claude-3-5-haiku-latest",
          max_tokens: 4096,
          system: prompt,
          messages: [{ role: "user", content: user }]
        })
      });
      assertOk(res, "Claude");
      const data = await res.json();
      return parseLlmTranslations((data.content || []).map((c) => c.text || "").join("\n"), texts, ctx.targetLang);
    }
  },

  azure: {
    id: "azure",
    name: "Azure OpenAI",
    kind: "llm",
    fields: [
      { key: "endpoint", label: "Endpoint（https://xxx.openai.azure.com）", type: "text", required: true },
      { key: "apiKey", label: "API Key", type: "password", required: true },
      { key: "deployment", label: "Deployment 名称", type: "text", required: true },
      { key: "apiVersion", label: "API Version", type: "text", placeholder: "2024-10-21" },
      { key: "prompt", label: "系统提示词", type: "textarea" }
    ],
    async translate(texts, ctx) {
      const endpoint = ctx.settings.endpoint.replace(/\/$/, "");
      const version = ctx.settings.apiVersion || "2024-10-21";
      const url = `${endpoint}/openai/deployments/${encodeURIComponent(ctx.settings.deployment)}/chat/completions?api-version=${encodeURIComponent(version)}`;
      const prompt = resolveTranslatorPrompt(ctx);
      const user = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
      const res = await postJson(
        url,
        {
          temperature: 0.2,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: user }
          ]
        },
        { "api-key": ctx.settings.apiKey }
      );
      assertOk(res, "Azure OpenAI");
      const data = await res.json();
      return parseLlmTranslations(data.choices?.[0]?.message?.content || "", texts, ctx.targetLang);
    }
  },

  custom: {
    id: "custom",
    name: "自定义 HTTP API",
    kind: "custom",
    fields: [
      { key: "url", label: "请求 URL", type: "text", required: true, placeholder: "https://api.example.com/translate" },
      { key: "method", label: "Method", type: "select", options: [{ value: "POST", label: "POST" }, { value: "GET", label: "GET" }] },
      { key: "headersJson", label: "请求头 JSON", type: "textarea", placeholder: "{\"Authorization\":\"Bearer xxx\"}" },
      { key: "bodyTemplate", label: "Body 模板（{{text}} {{textsJson}} {{sourceLang}} {{targetLang}}）", type: "textarea" },
      { key: "responsePath", label: "结果 JSON Path", type: "text", placeholder: "data.translations" }
    ],
    async translate(texts, ctx) {
      const headers = parseJson(ctx.settings.headersJson, {});
      const vars = {
        text: texts[0] || "",
        textsJson: JSON.stringify(texts),
        sourceLang: ctx.sourceLang,
        targetLang: ctx.targetLang
      };
      const method = (ctx.settings.method || "POST").toUpperCase();
      let url = fillTemplate(ctx.settings.url, vars);
      const init = { method, headers };
      if (method === "GET") {
        const u = new URL(url);
        u.searchParams.set("q", texts.join("\n"));
        u.searchParams.set("source", ctx.sourceLang);
        u.searchParams.set("target", ctx.targetLang);
        url = u.toString();
      } else {
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
        init.body = fillTemplate(ctx.settings.bodyTemplate || '{"text":{{textsJson}}}', vars);
      }
      const res = await fetch(url, init);
      assertOk(res, "Custom");
      const data = await res.json();
      const extracted = getByPath(data, ctx.settings.responsePath);
      if (Array.isArray(extracted)) {
        return extracted.map((item) => (typeof item === "string" ? item : item?.text || item?.translatedText || "")).slice(0, texts.length);
      }
      if (typeof extracted === "string") {
        return texts.length === 1 ? [extracted] : parseNumbered(extracted, texts.length);
      }
      throw new Error("自定义 API 未能解析出译文，请检查 responsePath");
    }
  }
};

export const PROVIDER_LIST = Object.values(providers);

export function getProvider(id) {
  return providers[id] || providers.mymemory;
}

function parseNumbered(raw, count) {
  const lines = String(raw)
    .split(/\n+/)
    .map((l) => l.replace(/^\s*\d+[\.\)、]\s*/, "").trim())
    .filter(Boolean);
  while (lines.length < count) lines.push("");
  return lines.slice(0, count);
}

function parseJson(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

function mapMsLang(code) {
  return { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" }[code] || code;
}

function mapDeepL(code) {
  return { "zh-CN": "ZH", "zh-TW": "ZH", en: "EN", ja: "JA", ko: "KO", fr: "FR", de: "DE", es: "ES", pt: "PT", ru: "RU", it: "IT" }[code] || String(code).toUpperCase();
}
