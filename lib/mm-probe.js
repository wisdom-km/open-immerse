/**
 * Multimodal connectivity probe. One built-in PNG, sent through sendVision.
 * The caller decides whether the classified result is written.
 *
 * Interrupt points in probeMultimodal:
 * 1. After the settings snapshot, before sendVision. Abort or a stale
 *    stillCurrent returns without calling send.
 * 2. Delegated to sendVision: after the key is read, before fetch, and after
 *    the response. stillCurrent and signal are passed through.
 * 3. After sendVision returns (including a thrown transport error) and before
 *    the classified result is handed back. A stale call becomes aborted so
 *    the caller must not write it.
 *
 * createProbeController:
 * 1. open() aborts the previous signal before the new probe is allowed to send.
 * 2. drop() (provider, key, model, base URL, unload) bumps the token and
 *    aborts. A result that arrives afterwards fails current().
 *
 * settleProbeResult:
 * 1. The still flag is checked before a probe record is attached. Aborted
 *    and stale results do not become the stored probe.
 */

import { isTransportFailure, multimodalTarget, sendVision } from "./mm-client.js";
import {
  acceptStoredFormulaSettings,
  classifyFormulaProbe,
  customBaseUrlError,
  multimodalProvider,
  redactProbeText
} from "./formula-settings.js";

/**
 * 64×64 PNG, white field with a red square. Vendors such as 火山方舟 reject
 * a 1×1 probe (width and height must be >14px and the pixel count ≥196).
 * Built in; not a page crop and not a public URL. Every preset, including 豆包, sends this.
 */
export const PROBE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAZElEQVR4nO3PAQ3AIAADQaTgX9O8DA1kWR6S+1RAb7yXN+oDXwOoA6gDqAOoA6gDqAOo2wY8c/46AAAAAAAAAAAAAAAAAAAAAAAAAAAAAIDzAKcFUAdQB1AHUAdQB1AHUHc9YAGaK05ZxL7SVgAAAABJRU5ErkJggg==";

/** Caps a reasoning model that ignores thinking=disabled and spends the whole budget. */
export const PROBE_OUTPUT_TOKENS = 1024;

const PROBE_SYSTEM = "你在检查自己能不能看见图片。不要复述密钥。";
const PROBE_TEXT = "如果能看见图片，只回复 SEEN。如果不能看图，只回复 NO_IMAGE。";

function isSeenWrap(ch) {
  // Punctuation and brackets, plus the ASCII quote/bracket marks Unicode
  // files under symbols (` ~ < >). Other symbols (¬, 👍) stay put.
  return /\s/u.test(ch) || /\p{P}/u.test(ch) || ch === "`" || ch === "~" || ch === "<" || ch === ">";
}

/**
 * The whole reply is SEEN. Case-insensitive. Whitespace and punctuation
 * (including fullwidth marks and brackets) may wrap it, because the prompt
 * itself says 「只回复 SEEN。」. A symbol such as ¬ or 👍 stays, and SEEN
 * inside another word is not a connection.
 */
export function confirmsSeen(text) {
  const raw = String(text || "").toLowerCase();
  let start = 0;
  let end = raw.length;
  while (start < end && isSeenWrap(raw[start])) start += 1;
  while (end > start && isSeenWrap(raw[end - 1])) end -= 1;
  return raw.slice(start, end) === "seen";
}

function rawFromVision(result, secret) {
  if (!result || result.ok === false) {
    const error = result?.error || {};
    const code = String(error.code || "");
    const summary = redactProbeText(error.summary || "", secret);
    if (code === "aborted") return { ok: false, code: "aborted", summary };
    if (code === "no-vision") return { ok: false, code: "no-vision", sawImage: false, status: error.status, summary };
    if (code === "timeout") return { ok: false, code: "timeout", summary };
    if (code === "401" || code === "403" || code === "404" || code === "429") {
      return { ok: false, code, status: Number(code), summary };
    }
    if (code === "network") return { ok: false, code: "network", summary: summary || "网络错误" };
    return { ok: false, code: code || "http", status: Number(error.status) || 0, summary };
  }
  const text = String(result.text || "");
  if (confirmsSeen(text)) return { ok: true, sawImage: true, summary: "" };
  // Empty content cut off by the length cap is not 「不能看图」. reasoning_content is ignored above.
  if (!text.trim() && result?.finishReason === "length") {
    return { ok: false, code: "length", summary: "" };
  }
  return {
    ok: false,
    code: "no-vision",
    sawImage: false,
    summary: redactProbeText(text, secret)
  };
}

function staleCall(deps) {
  if (deps?.signal?.aborted === true) return true;
  if (typeof deps?.stillCurrent === "function" && deps.stillCurrent() === false) return true;
  return false;
}

function abortedProbe(at) {
  return classifyFormulaProbe({ ok: false, code: "aborted", summary: "已中止" }, at);
}

/**
 * Probe one multimodal card. `deps.sendVision` defaults to the real client.
 * A test double must return the same `{ ok, text }` or `{ ok:false, error }` shape.
 */
export async function probeMultimodal(settings, deps = {}) {
  const send = deps.sendVision || sendVision;
  const stored = acceptStoredFormulaSettings(settings);
  const at = Number.isFinite(deps.at) ? deps.at : Date.now();
  if (staleCall(deps)) return abortedProbe(at);
  const spec = multimodalProvider(stored.multimodal.provider);
  if (!spec || spec.vision !== true) {
    return classifyFormulaProbe({ ok: false, code: "unavailable", summary: "当前厂家不能测" }, at);
  }
  if (customBaseUrlError(stored)) {
    return classifyFormulaProbe({ ok: false, code: "http", summary: customBaseUrlError(stored) }, at);
  }
  const secret = deps.secret === undefined ? stored.multimodal.apiKey : deps.secret;
  let result;
  try {
    result = await send({
      target: multimodalTarget(stored),
      system: PROBE_SYSTEM,
      text: PROBE_TEXT,
      images: [{ mime: "image/png", base64: PROBE_PNG_BASE64 }],
      signal: deps.signal,
      secret,
      readSecret: deps.readSecret,
      storage: deps.storage,
      stillCurrent: deps.stillCurrent,
      net: deps.net,
      purpose: "multimodal",
      outputLimit: PROBE_OUTPUT_TOKENS
    });
  } catch (err) {
    if (err?.code === "real-network-in-test") throw err;
    if (staleCall(deps)) return abortedProbe(at);
    result = isTransportFailure(err)
      ? { ok: false, error: { code: "network", status: 0, summary: "网络错误" } }
      : { ok: false, error: { code: "http", status: 0, summary: "请求失败" } };
  }
  if (staleCall(deps)) return abortedProbe(at);
  const classified = classifyFormulaProbe(rawFromVision(result, secret), at);
  // Interrupt: the classified result is in hand. Yield once so a change that
  // was already queued becomes aborted here. A change that lands after this
  // function returns is the caller's still() to discard.
  await Promise.resolve();
  if (staleCall(deps)) return abortedProbe(at);
  return classified;
}

export function createProbeController() {
  let token = 0;
  let currentAbort = null;
  return {
    open() {
      token += 1;
      currentAbort?.abort();
      const controller = new AbortController();
      currentAbort = controller;
      const mine = token;
      return {
        token: mine,
        signal: controller.signal,
        current() {
          return token === mine;
        }
      };
    },
    drop() {
      token += 1;
      currentAbort?.abort();
      currentAbort = null;
    }
  };
}

/**
 * Attach a finished probe only when this generation is still the current one.
 * Aborted results are not attached.
 */
export function settleProbeResult(settings, probe, { still = true } = {}) {
  const base = acceptStoredFormulaSettings(settings);
  if (still !== true || !probe || probe.code === "aborted") {
    return { write: false, settings: base };
  }
  const next = acceptStoredFormulaSettings({
    ...base,
    multimodal: { ...base.multimodal, probe }
  });
  if (customBaseUrlError(next)) {
    return { write: false, settings: base, error: customBaseUrlError(next) };
  }
  return { write: true, settings: next };
}
