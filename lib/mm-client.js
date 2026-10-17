/**
 * Shared vision request layer for formula tier 2 and Ask AI.
 *
 * `target` is provider / model / url / host only. The API key is read at
 * call time from `readSecret`, a caller-supplied `secret`, or
 * `formulaSettings` in local storage. It is never copied onto `target`,
 * into the URL, or into logs (those go through lib/net redact).
 *
 * Two adapters: OpenAI-compatible `image_url` data URLs (openai, deepseek,
 * doubao, kimi, qwen, grok, custom) and Gemini `inline_data` bare base64.
 * Images are PNG only. No public image URLs.
 *
 * This module keeps no shared mutable state: no queue, no cache, no
 * in-flight map. Ask AI and the formula chain each own their queue.
 */

import {
  clipProbeSummary,
  multimodalProvider,
  normalizeFormulaSettings,
  readFormulaSettings
} from "./formula-settings.js";
import { applyChatThinking } from "./providers.js";
import { currentNet, redactText } from "./net/fetch.js";

export const MM_PURPOSE = "multimodal";

export const VISION_ERROR_CODES = Object.freeze([
  "401",
  "403",
  "404",
  "429",
  "timeout",
  "no-vision",
  "http",
  "aborted"
]);

const NO_VISION_RE = /does not support image|do not support image|image input[^.\n]{0,40}not supported|not support(?:ed)?[^.\n]{0,40}image|cannot process image|can't process image|no vision capability|image_url[^.\n]{0,40}not supported|不支持(?:图片|图像|看图)|不能看图|无法(?:识别|处理)图/i;

const SECRET_QUERY_RE = /^(?:x[-_]?api[-_]?key|api[-_]?key|access[-_]?(?:token|key)|token|secret|key)$/i;

function hostOf(url) {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

function stripSecretQuery(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_RE.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

function publicSummary(text, secret) {
  let raw = redactText(text);
  const key = String(secret || "");
  if (key.length >= 8 && raw.includes(key)) raw = raw.split(key).join("***");
  return clipProbeSummary(raw);
}

function failure(code, status, summary, secret) {
  return {
    ok: false,
    error: {
      code,
      status: Number.isFinite(Number(status)) ? Number(status) : 0,
      summary: publicSummary(summary, secret)
    }
  };
}

function aborted(secret, summary = "已中止") {
  return failure("aborted", 0, summary, secret);
}

function isAborted(signal) {
  return signal?.aborted === true;
}

function stillCurrent(check) {
  if (typeof check !== "function") return true;
  try {
    return check() !== false;
  } catch {
    return false;
  }
}

/**
 * Target for a formula-settings multimodal card. No API key.
 * An empty model falls back to the first preset (Gemini's preset is not
 * the retired gemini-2.0-flash). An empty base URL uses the preset.
 */
export function multimodalTarget(settings) {
  const stored = normalizeFormulaSettings(settings);
  return targetFromNormalized(stored.multimodal);
}

function targetFromNormalized(mm) {
  const spec = multimodalProvider(mm.provider);
  if (!spec) {
    return { ok: false, via: "multimodal", provider: "", model: "", url: "", host: "", shape: "" };
  }
  const model = mm.model || spec.models?.[0] || "";
  const shape = spec.shape === "gemini" ? "gemini" : "openai";
  const base = String(mm.baseUrl || spec.baseUrl || "").replace(/\/$/, "");
  let url = "";
  if (shape === "gemini") {
    if (base && /:generateContent\b/.test(base)) url = stripSecretQuery(base);
    else if (base && model) url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
  } else if (base) {
    url = `${base}/chat/completions`;
  }
  url = stripSecretQuery(url);
  return {
    ok: Boolean(url),
    via: "multimodal",
    provider: spec.id,
    model,
    url,
    host: hostOf(url),
    shape
  };
}

function cleanTarget(target) {
  const provider = String(target?.provider || "");
  const model = String(target?.model || "").trim();
  const spec = multimodalProvider(provider);
  let url = stripSecretQuery(target?.url || "");
  if (!url) {
    url = targetFromNormalized({
      provider,
      model,
      baseUrl: ""
    }).url;
  }
  const gemini = target?.shape === "gemini"
    || spec?.shape === "gemini"
    || provider === "gemini"
    || /:generateContent\b/.test(url)
    || /generativelanguage\.googleapis\.com/.test(url);
  return {
    provider,
    model: model || spec?.models?.[0] || "",
    url,
    host: hostOf(url) || String(target?.host || ""),
    shape: gemini ? "gemini" : "openai"
  };
}

function barePng(image) {
  const mime = String(image?.mime || "").trim().toLowerCase();
  if (!mime.startsWith("image/png")) {
    return { error: failure("http", 0, "只接受 PNG") };
  }
  let data = String(image?.base64 || "").trim().replace(/\s+/g, "");
  if (!data) return { error: failure("http", 0, "只接受 PNG") };
  if (/^https?:\/\//i.test(data) || /^\/\//.test(data)) {
    return { error: failure("http", 0, "不接受图片网址") };
  }
  const dataUrl = data.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i);
  if (dataUrl) {
    if (dataUrl[1].toLowerCase() !== "image/png" || !dataUrl[2]) {
      return { error: failure("http", 0, "只接受 PNG") };
    }
    data = dataUrl[3].replace(/\s+/g, "");
  }
  if (/^https?:\/\//i.test(data) || data.includes("data:")) {
    return { error: failure("http", 0, "不接受图片网址") };
  }
  return { mime: "image/png", base64: data };
}

function normalizeImages(images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return { error: failure("http", 0, "需要 PNG 裁图") };
  const out = [];
  for (const image of list) {
    const parsed = barePng(image);
    if (parsed.error) return parsed;
    out.push(parsed);
  }
  return { images: out };
}

function kimiHost(provider, url) {
  if (provider === "kimi") return true;
  return /moonshot\.(cn|ai)/i.test(String(url || ""));
}

function applyThinkingOff(body, target) {
  const next = applyChatThinking(body, {
    baseUrl: target.url,
    model: target.model,
    deepThink: false
  });
  if (kimiHost(target.provider, target.url)) {
    next.thinking = { type: "disabled" };
  }
  return next;
}

function openAIBody(target, system, text, images) {
  const content = [{ type: "text", text: String(text ?? "") }];
  for (const image of images) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${image.base64}` }
    });
  }
  const messages = [];
  const systemText = String(system ?? "").trim();
  if (systemText) messages.push({ role: "system", content: systemText });
  messages.push({ role: "user", content });
  return applyThinkingOff({
    model: target.model,
    temperature: 0,
    messages
  }, target);
}

function geminiBody(system, text, images) {
  const parts = [{ text: String(text ?? "") }];
  for (const image of images) {
    parts.push({
      inline_data: {
        mime_type: "image/png",
        data: image.base64
      }
    });
  }
  const body = {
    contents: [{ role: "user", parts }],
    generation_config: { temperature: 0 }
  };
  const systemText = String(system ?? "").trim();
  if (systemText) body.system_instruction = { parts: [{ text: systemText }] };
  return body;
}

/**
 * Wire body for one vision call. `secret` is placed only on the auth header.
 * Returns `{ error }` when the images or the address cannot be sent.
 */
export function buildVisionRequest(target, { system, text, images, secret } = {}) {
  const prepared = normalizeImages(images);
  if (prepared.error) return prepared;
  const clean = cleanTarget(target);
  if (!clean.url) return { error: failure("http", 0, "缺少请求地址", secret) };
  if (!clean.model) return { error: failure("http", 0, "缺少模型", secret) };
  const key = String(secret ?? "");
  const headers = { "Content-Type": "application/json" };
  if (clean.shape === "gemini") headers["x-goog-api-key"] = key;
  else if (key) headers.Authorization = `Bearer ${key}`;
  const json = clean.shape === "gemini"
    ? geminiBody(system, text, prepared.images)
    : openAIBody(clean, system, text, prepared.images);
  return {
    url: clean.url,
    method: "POST",
    headers,
    json,
    purpose: MM_PURPOSE,
    provider: clean.provider,
    shape: clean.shape
  };
}

function errorMessage(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  const err = data.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") return String(err.message || err.status || "");
  if (typeof data.message === "string") return data.message;
  const block = data.promptFeedback?.blockReason || data.prompt_feedback?.blockReason;
  if (block) return String(block);
  return "";
}

function usageOf(data, shape) {
  const source = shape === "gemini" ? data?.usageMetadata || data?.usage_metadata : data?.usage;
  if (!source || typeof source !== "object") return undefined;
  const out = {};
  const fields = shape === "gemini"
    ? ["promptTokenCount", "candidatesTokenCount", "totalTokenCount"]
    : ["prompt_tokens", "completion_tokens", "total_tokens"];
  for (const key of fields) {
    if (Number.isFinite(source[key])) out[key] = source[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function textFromOpenAI(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    return typeof part?.text === "string" ? part.text : "";
  }).join("");
}

function textFromGemini(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => {
    if (!part || part.thought === true) return "";
    return typeof part.text === "string" ? part.text : "";
  }).join("");
}

export function parseVisionResponse(shape, data) {
  const text = shape === "gemini" ? textFromGemini(data) : textFromOpenAI(data);
  const usage = usageOf(data, shape);
  return usage ? { text, usage } : { text };
}

export function classifyVisionError({ status, data, code, secret } = {}) {
  const httpStatus = Number(status) || 0;
  const message = errorMessage(data);
  if (code === "timeout" || httpStatus === 408) return failure("timeout", httpStatus === 408 ? 408 : 0, message || "超时", secret);
  if (code === "aborted") return aborted(secret);
  if (httpStatus === 401) return failure("401", 401, message || "密钥无效", secret);
  if (httpStatus === 403) return failure("403", 403, message || "无权限", secret);
  if (httpStatus === 404) return failure("404", 404, message || "地址或模型不对", secret);
  if (httpStatus === 429) return failure("429", 429, message || "额度或限流", secret);
  if (code === "no-vision" || NO_VISION_RE.test(message)) {
    return failure("no-vision", httpStatus, message || "这个模型不能看图", secret);
  }
  return failure("http", httpStatus, message || "请求失败", secret);
}

function classifyThrown(err, secret) {
  if (err?.code === "real-network-in-test") throw err;
  if (err?.name === "AbortError" || err?.code === "aborted") return aborted(secret);
  if (err?.code === "timeout" || err?.name === "TimeoutError") return failure("timeout", 0, "超时", secret);
  return failure("http", 0, err?.message || "网络错误", secret);
}

async function loadSecret({ secret, readSecret, storage }) {
  if (typeof readSecret === "function") return String(await readSecret() ?? "").trim();
  if (secret !== undefined) return String(secret ?? "").trim();
  if (storage) {
    const settings = await readFormulaSettings(storage);
    return String(settings?.multimodal?.apiKey || "").trim();
  }
  return "";
}

/**
 * Send one vision request.
 * Interrupt points: after the key is read, before fetch, after the response.
 * `stillCurrent() === false` at either later point discards the result and
 * does not start a new request. A caller abort does the same.
 *
 * @returns {{ ok: true, text: string, usage?: object } | { ok: false, error: { code: string, status: number, summary: string } }}
 */
export async function sendVision({
  target,
  system,
  text,
  images,
  signal,
  purpose,
  secret,
  readSecret,
  storage,
  stillCurrent: currentCheck,
  net
} = {}) {
  void purpose;
  const prepared = normalizeImages(images);
  if (prepared.error) return prepared.error;
  if (isAborted(signal)) return aborted();
  let key = "";
  try {
    key = await loadSecret({ secret, readSecret, storage });
  } catch (err) {
    if (err?.code === "real-network-in-test") throw err;
    return failure("http", 0, err?.message || "读取密钥失败", secret);
  }
  if (isAborted(signal) || !stillCurrent(currentCheck)) return aborted(key, isAborted(signal) ? "已中止" : "设置已变，结果作废");
  if (!key) return failure("401", 401, "缺少密钥");
  const built = buildVisionRequest(target, { system, text, images: prepared.images, secret: key });
  if (built.error) return built.error;
  if (isAborted(signal) || !stillCurrent(currentCheck)) return aborted(key, isAborted(signal) ? "已中止" : "设置已变，结果作废");
  const client = net || currentNet();
  let result;
  try {
    result = await client.fetch({
      url: built.url,
      method: "POST",
      headers: built.headers,
      json: built.json,
      signal,
      purpose: MM_PURPOSE,
      cache: false,
      dedupeKey: false,
      provider: built.provider || undefined
    });
  } catch (err) {
    if (isAborted(signal) || !stillCurrent(currentCheck)) return aborted(key, isAborted(signal) ? "已中止" : "设置已变，结果作废");
    return classifyThrown(err, key);
  }
  if (isAborted(signal) || !stillCurrent(currentCheck)) return aborted(key, isAborted(signal) ? "已中止" : "设置已变，结果作废");
  const status = Number(result?.status || 0);
  const ok = typeof result?.ok === "boolean" ? result.ok : status >= 200 && status < 300;
  if (!ok) return classifyVisionError({ status, data: result?.data, secret: key });
  const parsed = parseVisionResponse(built.shape, result?.data);
  const out = { ok: true, text: parsed.text };
  if (parsed.usage) out.usage = parsed.usage;
  return out;
}
