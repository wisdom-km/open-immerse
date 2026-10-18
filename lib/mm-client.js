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
  fixedVendorHostMismatch,
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
  "network",
  "http",
  "aborted"
]);

const NO_VISION_RE = /does not support image|do not support image|image input[^.\n]{0,40}not supported|not support(?:ed)?[^.\n]{0,40}image|cannot process image|can't process image|no vision capability|image_url[^.\n]{0,40}not supported|不支持(?:图片|图像|看图)|不能看图|无法(?:识别|处理)图/i;

export function textDeniesVision(text) {
  return NO_VISION_RE.test(String(text || ""));
}

const SECRET_QUERY_RE = /^(?:x[-_]?goog[-_]?api[-_]?key|x[-_]?api[-_]?key|api[-_]?key(?:[-_]id)?|access[-_]?(?:token|key)|token|secret|key|auth|password|passwd|pwd|credential|credentials|session)$/i;

/** Decoded PNG cap. The plan lists vendor limits and no client cap; 10 MiB matches 豆包's documented single-image limit, the strictest preset this client still sends. */
export const MAX_PNG_BYTES = 10 * 1024 * 1024;

const PNG_MAGIC = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function hostOf(url) {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

function stripSecretQuery(url) {
  return buildEndpoint(url, "");
}

function buildEndpoint(base, suffix) {
  const raw = String(base || "").trim();
  if (!raw) return "";
  // `user:secret@host` has no scheme. Only http(s) is left as written;
  // anything else is parsed as https so userinfo and query keys can be stripped.
  const hadScheme = /^https?:\/\//i.test(raw);
  try {
    const parsed = new URL(hadScheme ? raw : `https://${raw}`);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_RE.test(key)) parsed.searchParams.delete(key);
    }
    if (suffix) {
      const path = parsed.pathname.replace(/\/+$/, "");
      const extra = suffix.startsWith("/") ? suffix : `/${suffix}`;
      parsed.pathname = path.toLowerCase().endsWith(extra.toLowerCase()) ? path : `${path}${extra}`;
    }
    const out = parsed.toString();
    return hadScheme ? out : out.replace(/^https:\/\//, "");
  } catch {
    return "";
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function knownSecrets(secrets) {
  const list = Array.isArray(secrets) ? secrets : [secrets];
  const out = [];
  const add = (key) => {
    if (key && key.length >= 6 && !out.includes(key)) out.push(key);
  };
  for (const item of list) {
    const key = String(item ?? "");
    // Stored keys are not trimmed. The request sends the trimmed form, and a
    // vendor may echo either one. Needles shorter than 6 characters match
    // inside ordinary words. Six-character keys still redact.
    add(key);
    add(key.trim());
    const trimmed = key.trim();
    const colon = /^(?:bearer|token)\s*[:：]\s*(\S+)/iu.exec(trimmed);
    const plain = /^(?:bearer|token)\s+(\S+)/i.exec(trimmed);
    if (colon) add(colon[1]);
    else if (plain) add(plain[1]);
  }
  return out.sort((a, b) => b.length - a.length);
}

function publicSummary(text, secrets) {
  let raw = redactText(text);
  for (const key of knownSecrets(secrets)) {
    raw = raw.replace(new RegExp(escapeRegExp(key), "gi"), "***");
  }
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
  const base = String(mm.baseUrl || spec.baseUrl || "").trim();
  let url = "";
  if (shape === "gemini") {
    if (base && /:generateContent\b/i.test(base)) url = buildEndpoint(base, "");
    else if (base && model) url = buildEndpoint(base, `/models/${encodeURIComponent(model)}:generateContent`);
  } else if (base) {
    url = buildEndpoint(base, "/chat/completions");
  }
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
  let shape = "openai";
  if (target?.shape === "gemini" || target?.shape === "openai") shape = target.shape;
  else if (spec?.shape === "gemini" || spec?.shape === "openai") shape = spec.shape;
  else if (provider === "gemini") shape = "gemini";
  return {
    provider,
    model: model || spec?.models?.[0] || "",
    url,
    host: hostOf(url) || String(target?.host || ""),
    shape
  };
}

function rejectPng(summary) {
  return { error: failure("http", 0, summary) };
}

function decodePngBase64(data) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return { error: "只接受 PNG" };
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const estimated = (data.length / 4) * 3 - padding;
  if (estimated > MAX_PNG_BYTES) return { error: "图片超过 10MB" };
  let binary;
  try {
    binary = atob(data);
  } catch {
    return { error: "只接受 PNG" };
  }
  if (binary.length > MAX_PNG_BYTES) return { error: "图片超过 10MB" };
  if (binary.length < PNG_MAGIC.length) return { error: "只接受 PNG" };
  for (let i = 0; i < PNG_MAGIC.length; i += 1) {
    if (binary.charCodeAt(i) !== PNG_MAGIC[i]) return { error: "只接受 PNG" };
  }
  return { ok: true };
}

function barePng(image) {
  const mime = String(image?.mime || "").trim().toLowerCase();
  if (mime !== "image/png") return rejectPng("只接受 PNG");
  let data = String(image?.base64 || "").trim().replace(/\s+/g, "");
  if (!data) return rejectPng("只接受 PNG");
  if (/^https?:\/\//i.test(data) || /^\/\//.test(data)) return rejectPng("不接受图片网址");
  if (/^data:/i.test(data)) {
    const dataUrl = data.match(/^data:(image\/png)(;base64),([\s\S]*)$/i);
    if (!dataUrl) return rejectPng("只接受 PNG");
    data = dataUrl[3].replace(/\s+/g, "");
  }
  if (!data || /[\s:]/.test(data)) return rejectPng("只接受 PNG");
  const decoded = decodePngBase64(data);
  if (decoded.error) return rejectPng(decoded.error);
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

function openAICompletionCap(target) {
  if (target?.provider === "openai") return true;
  try {
    return new URL(String(target?.url || "")).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

function openAIBody(target, system, text, images, outputLimit) {
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
  const body = {
    model: target.model,
    temperature: 0,
    messages
  };
  const limit = Number(outputLimit);
  if (Number.isFinite(limit) && limit > 0) {
    // New OpenAI models reject max_tokens. A custom card aimed at api.openai.com
    // is the same API. Every other OpenAI-shaped endpoint only accepts max_tokens.
    if (openAICompletionCap(target)) body.max_completion_tokens = limit;
    else body.max_tokens = limit;
  }
  return applyThinkingOff(body, target);
}

function geminiBody(system, text, images, outputLimit) {
  const parts = [{ text: String(text ?? "") }];
  for (const image of images) {
    parts.push({
      inline_data: {
        mime_type: "image/png",
        data: image.base64
      }
    });
  }
  const generation = { temperature: 0 };
  const limit = Number(outputLimit);
  if (Number.isFinite(limit) && limit > 0) generation.maxOutputTokens = limit;
  const body = {
    contents: [{ role: "user", parts }],
    generation_config: generation
  };
  const systemText = String(system ?? "").trim();
  if (systemText) body.system_instruction = { parts: [{ text: systemText }] };
  return body;
}

/**
 * Wire body for one vision call. `secret` is placed only on the auth header.
 * Returns `{ error }` when the images or the address cannot be sent.
 */
export function buildVisionRequest(target, { system, text, images, secret, outputLimit } = {}) {
  const prepared = normalizeImages(images);
  if (prepared.error) return prepared;
  const clean = cleanTarget(target);
  if (!clean.url) return { error: failure("http", 0, "缺少请求地址", secret) };
  if (!clean.model) return { error: failure("http", 0, "缺少模型", secret) };
  // The key is not attached until the host belongs to this vendor.
  if (fixedVendorHostMismatch({ multimodal: { provider: clean.provider, baseUrl: clean.url, apiKey: "x" } })) {
    return { error: failure("http", 0, "", secret) };
  }
  const key = String(secret ?? "");
  const headers = { "Content-Type": "application/json" };
  if (clean.shape === "gemini") headers["x-goog-api-key"] = key;
  else if (key) headers.Authorization = `Bearer ${key}`;
  const json = clean.shape === "gemini"
    ? geminiBody(system, text, prepared.images, outputLimit)
    : openAIBody(clean, system, text, prepared.images, outputLimit);
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
  // Only the answer. reasoning_content is not a SEEN, even when content is empty.
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

function finishReasonOf(shape, data) {
  const raw = shape === "gemini"
    ? String(data?.candidates?.[0]?.finishReason || "")
    : String(data?.choices?.[0]?.finish_reason || "");
  if (raw === "MAX_TOKENS" || raw.toLowerCase() === "length") return "length";
  return raw;
}

export function parseVisionResponse(shape, data) {
  const text = shape === "gemini" ? textFromGemini(data) : textFromOpenAI(data);
  const usage = usageOf(data, shape);
  const finishReason = finishReasonOf(shape, data);
  const out = usage ? { text, usage } : { text };
  if (finishReason) out.finishReason = finishReason;
  return out;
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

const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNABORTED"
]);

function isFetchTypeError(err) {
  return err?.name === "TypeError"
    && (err.message === "fetch failed" || err.message === "Failed to fetch");
}

/** Transport failures only. A programming TypeError is not a network error. */
export function isTransportFailure(err, seen = new Set()) {
  if (!err || seen.has(err) || err.code === "real-network-in-test") return false;
  seen.add(err);
  if (err.name === "AbortError" || err.code === "aborted") return false;
  if (err.code === "timeout" || err.name === "TimeoutError") return false;
  if (err.code === "network") return true;
  if (TRANSPORT_CODES.has(String(err.code || ""))) return true;
  if (isFetchTypeError(err)) return true;
  if (err.cause && isTransportFailure(err.cause, seen)) return true;
  return false;
}

function classifyThrown(err, secret) {
  if (err?.code === "real-network-in-test") throw err;
  if (err?.name === "AbortError" || err?.code === "aborted") return aborted(secret);
  if (err?.code === "timeout" || err?.name === "TimeoutError") return failure("timeout", 0, "超时", secret);
  if (isTransportFailure(err)) return failure("network", 0, "网络错误", secret);
  return failure("http", 0, err?.message || "请求失败", secret);
}

function attachKnown(err, known) {
  if (err?.code === "real-network-in-test") return err;
  const extra = [err?.secret, err?.key, err?.apiKey];
  const merged = knownSecrets([...(err?.knownSecrets || []), ...known, ...extra]);
  if (err && typeof err === "object") {
    err.knownSecrets = merged;
    return err;
  }
  const wrapped = new Error(String(err?.message || err || "读取密钥失败"));
  wrapped.knownSecrets = merged;
  return wrapped;
}

async function loadSecret({ secret, readSecret, storage }) {
  const known = [];
  if (secret !== undefined && secret !== null) known.push(String(secret));
  try {
    let value = "";
    if (typeof readSecret === "function") {
      value = String(await readSecret() ?? "");
    } else if (secret !== undefined) {
      value = String(secret ?? "");
    } else if (storage) {
      const settings = await readFormulaSettings(storage);
      value = String(settings?.multimodal?.apiKey || "");
    }
    known.push(value);
    return { key: value.trim(), known };
  } catch (err) {
    throw attachKnown(err, known);
  }
}

/**
 * Send one vision request.
 * Interrupt points, each with its own check: after the key is read, after a
 * microtask yield and before fetch, and after the response (including the
 * catch if the transport throws). `stillCurrent() === false` or a caller
 * abort at any of those points discards the result and does not start
 * another request.
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
  net,
  outputLimit
} = {}) {
  void purpose;
  const prepared = normalizeImages(images);
  if (prepared.error) return prepared.error;
  if (isAborted(signal)) return aborted();
  let loaded = { key: "", known: [] };
  try {
    loaded = await loadSecret({ secret, readSecret, storage });
  } catch (err) {
    if (err?.code === "real-network-in-test") throw err;
    const secrets = err?.knownSecrets || secret;
    if (isAborted(signal) || !stillCurrent(currentCheck)) {
      return aborted(secrets, isAborted(signal) ? "已中止" : "设置已变，结果作废");
    }
    // The thrown text may contain the key and nothing else identifies it.
    return failure("http", 0, "读取密钥失败", secrets);
  }
  const key = loaded.key;
  const secrets = loaded.known;
  // Interrupt 1: the key is in hand. A stale or aborted call stops here,
  // before the yield below would observe a newer settings value.
  if (isAborted(signal) || !stillCurrent(currentCheck)) {
    return aborted(secrets, isAborted(signal) ? "已中止" : "设置已变，结果作废");
  }
  await Promise.resolve();
  if (!key) return failure("401", 401, "缺少密钥", secrets);
  const built = buildVisionRequest(target, { system, text, images: prepared.images, secret: key, outputLimit });
  if (built.error) return built.error;
  // Interrupt 2: after the yield, before any byte is sent.
  if (isAborted(signal) || !stillCurrent(currentCheck)) {
    return aborted(secrets, isAborted(signal) ? "已中止" : "设置已变，结果作废");
  }
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
      errorBody: true,
      provider: built.provider || undefined
    });
  } catch (err) {
    if (isAborted(signal) || !stillCurrent(currentCheck)) {
      return aborted(secrets, isAborted(signal) ? "已中止" : "设置已变，结果作废");
    }
    return classifyThrown(err, secrets);
  }
  // Interrupt 3: the body is in hand. Do not return it if the call went stale.
  if (isAborted(signal) || !stillCurrent(currentCheck)) {
    return aborted(secrets, isAborted(signal) ? "已中止" : "设置已变，结果作废");
  }
  const status = Number(result?.status || 0);
  const ok = typeof result?.ok === "boolean" ? result.ok : status >= 200 && status < 300;
  if (!ok) return classifyVisionError({ status, data: result?.data, secret: secrets });
  const parsed = parseVisionResponse(built.shape, result?.data);
  const out = { ok: true, text: parsed.text };
  if (parsed.usage) out.usage = parsed.usage;
  if (parsed.finishReason) out.finishReason = parsed.finishReason;
  return out;
}
