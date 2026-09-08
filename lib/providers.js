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

const DEFAULT_LLM_PROMPT = `You are a professional translator. Translate each numbered segment into {{targetLang}}.
Keep meaning, tone, and proper nouns. Do not translate code, URLs, or file paths.
Return ONLY the translations, one per line, prefixed with the same numbers. No explanations.`;

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

  openai: {
    id: "openai",
    name: "OpenAI 兼容（OpenAI / DeepSeek / Qwen / Groq / SiliconFlow / Ollama / xAI…）",
    kind: "llm",
    fields: [
      { key: "apiKey", label: "API Key", type: "password" },
      { key: "baseUrl", label: "Base URL", type: "text", placeholder: "https://api.openai.com/v1" },
      { key: "model", label: "模型 Model", type: "text", placeholder: "gpt-4o-mini" },
      { key: "prompt", label: "系统提示词", type: "textarea" }
    ],
    async translate(texts, ctx) {
      const base = (ctx.settings.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
      const prompt = fillTemplate(ctx.settings.prompt || DEFAULT_LLM_PROMPT, ctx);
      const user = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
      const headers = { "Content-Type": "application/json" };
      if (ctx.settings.apiKey) headers.Authorization = `Bearer ${ctx.settings.apiKey}`;
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: ctx.settings.model || "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: user }
          ]
        })
      });
      assertOk(res, "OpenAI-compatible");
      const data = await res.json();
      return parseNumbered(data.choices?.[0]?.message?.content || "", texts.length);
    }
  },

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
      const prompt = fillTemplate(ctx.settings.prompt || DEFAULT_LLM_PROMPT, ctx);
      const user = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ctx.settings.apiKey)}`;
      const res = await postJson(url, {
        contents: [{ role: "user", parts: [{ text: `${prompt}\n\n${user}` }] }]
      });
      assertOk(res, "Gemini");
      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";
      return parseNumbered(raw, texts.length);
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
      const prompt = fillTemplate(ctx.settings.prompt || DEFAULT_LLM_PROMPT, ctx);
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
      return parseNumbered((data.content || []).map((c) => c.text || "").join("\n"), texts.length);
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
      const prompt = fillTemplate(ctx.settings.prompt || DEFAULT_LLM_PROMPT, ctx);
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
      return parseNumbered(data.choices?.[0]?.message?.content || "", texts.length);
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
