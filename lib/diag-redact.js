/**
 * Allow-list and scrub for the local diagnostic log.
 * Unknown fields are dropped. Secrets are masked. No network.
 */

import { httpSourceUrl } from "./library-record.js";
import { redactText } from "./net/fetch.js";
import { SECRET_FIELD_RE, redactProviderText } from "./providers.js";

export const DIAG_MSG_MAX = 300;
export const DIAG_RAW_MAX = 2048;

const CONTEXTS = new Set(["sw", "viewer", "options", "content"]);
const TYPE_RE = /^[a-z][a-z0-9._-]{0,40}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,40}$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]+$/;
export const DIAG_MODEL_MAX = 40;
const REASON_ENUM = new Set(["translate-unconfigured", "own-configured"]);
const URL_IN_TEXT = /(?:\b(?:https?|wss?|ftp|file|blob|chrome-extension|data):|\/\/)[^\s<>"'`]+/gi;
const HEADER_SECRET = /["']?(?:proxy-authorization|authorization|x-goog-api-key|x-api-key|api-key|deepl-auth-key|cookie)["']?\s*[:=]\s*(?:["'][^"']*["']|[^\n|]+)/gi;

export function scrubDiagUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) {
    const asHttp = scrubDiagUrl(`https:${text}`);
    return asHttp ? asHttp.replace(/^https:/, "") : "";
  }
  const match = text.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!match) return "";
  const scheme = match[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") return `${scheme}:`;
  return httpSourceUrl(text) || `${scheme}:`;
}

function stripUrlTail(raw) {
  return String(raw || "").replace(/[),.;]+$/g, "");
}

/**
 * Collect secret values at any depth. Short values are ignored, same as sanitizeProviderError.
 * Every string under `oiSecrets` counts, because provider keys are stored as
 * `oiSecrets.providers.<providerId> = "<key>"` and the leaf name is not secret-shaped.
 * A leaf named apiKey (legacy sync settings) still counts anywhere in the tree.
 */
export function collectSecretValues(root) {
  const found = new Set();
  const walk = (value, key, underOiSecrets) => {
    if (value == null) return;
    const name = String(key || "");
    const inSecrets = underOiSecrets || name === "oiSecrets";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const named = name && SECRET_FIELD_RE.test(name);
      if (named || (inSecrets && typeof value === "string")) {
        const text = String(value).trim();
        if (text.length >= 6) found.add(text);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, inSecrets);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) walk(child, childKey, inSecrets);
    }
  };
  walk(root, "", false);
  return [...found];
}

export function scrubDiagMessage(text, secrets) {
  let msg = String(text ?? "");
  if (msg.length > DIAG_RAW_MAX) msg = msg.slice(0, DIAG_RAW_MAX);
  msg = msg.replace(URL_IN_TEXT, (raw) => {
    const trimmed = stripUrlTail(raw);
    return scrubDiagUrl(trimmed) + raw.slice(trimmed.length);
  });
  const values = [...(secrets || [])]
    .map((item) => String(item || ""))
    .filter((item) => item.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const secret of values) msg = msg.split(secret).join("***");
  msg = msg.replace(HEADER_SECRET, "***");
  msg = redactText(msg);
  msg = redactProviderText(msg).replace(/\s+/g, " ").trim();
  if (msg.length > DIAG_MSG_MAX) msg = msg.slice(0, DIAG_MSG_MAX);
  return msg;
}

function scrubDiagId(value, secrets) {
  let text = String(value ?? "").trim();
  const values = [...(secrets || [])]
    .map((item) => String(item || ""))
    .filter((item) => item.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const secret of values) text = text.split(secret).join("***");
  text = text.replace(URL_IN_TEXT, (raw) => {
    const trimmed = stripUrlTail(raw);
    return scrubDiagUrl(trimmed) + raw.slice(trimmed.length);
  });
  text = text.replace(HEADER_SECRET, "***");
  return text;
}

function modelField(value, secrets) {
  let text = scrubDiagId(value, secrets).trim();
  const values = [...(secrets || [])]
    .map((item) => String(item || ""))
    .filter((item) => item.length >= 6)
    .sort((a, b) => b.length - a.length);
  // A raw model clipped to DIAG_MODEL_MAX can be a prefix of a longer key.
  if (text.length >= 20) {
    for (const secret of values) {
      if (text.length < secret.length && secret.startsWith(text)) {
        text = "***";
        break;
      }
    }
  }
  if (!text || text.includes("***") || text.includes("//")) return "";
  if (/(?:https?|wss?|ftp|file|blob|chrome-extension|data):/i.test(text)) return "";
  if (!MODEL_RE.test(text)) return "";
  return text.slice(0, DIAG_MODEL_MAX);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Copy only the allow-listed diagnostic fields.
 * `text` / `title` / `translation` / `note` / `answer` and anything else are dropped.
 */
export function redactDiagEvent(raw, secrets, now = Date.now()) {
  const source = raw && typeof raw === "object" ? raw : {};
  const type = String(source.type || "").trim();
  if (!TYPE_RE.test(type)) return null;
  const event = {
    t: finiteNumber(source.t) ?? now,
    type
  };
  const ctx = String(source.ctx || "");
  if (CONTEXTS.has(ctx)) event.ctx = ctx;
  if (source.code != null && String(source.code) !== "") {
    event.code = scrubDiagMessage(source.code, secrets).slice(0, 80);
  }
  if (source.msg != null && String(source.msg) !== "") {
    event.msg = scrubDiagMessage(source.msg, secrets);
  }
  if (source.provider != null && String(source.provider).trim() !== "") {
    const provider = scrubDiagMessage(source.provider, secrets);
    if (ID_RE.test(provider)) event.provider = provider;
  }
  if (source.model != null && String(source.model).trim() !== "") {
    const model = modelField(source.model, secrets);
    if (model) event.model = model;
  }
  const page = finiteNumber(source.page);
  if (page != null) event.page = Math.floor(page);
  const count = finiteNumber(source.count);
  if (count != null) event.count = Math.max(0, Math.floor(count));
  const ms = finiteNumber(source.ms);
  if (ms != null) event.ms = Math.max(0, Math.floor(ms));
  if (source.ver != null && String(source.ver) !== "") {
    const ver = scrubDiagMessage(source.ver, secrets).slice(0, 40);
    if (ver) event.ver = ver;
  }
  if (typeof source.ok === "boolean") event.ok = source.ok;
  if (source.reason != null && String(source.reason) !== "") {
    const rawReason = String(source.reason).trim();
    if (REASON_ENUM.has(rawReason)) {
      event.reason = rawReason;
    } else {
      const reason = scrubDiagMessage(rawReason, secrets).slice(0, 40);
      if (reason) event.reason = reason;
    }
  }
  if (source.mode != null && String(source.mode).trim() !== "") {
    const mode = scrubDiagMessage(source.mode, secrets).slice(0, 40);
    if (ID_RE.test(mode)) event.mode = mode;
  }
  const itemCount = finiteNumber(source.itemCount);
  if (itemCount != null) event.itemCount = Math.max(0, Math.floor(itemCount));
  return event;
}
