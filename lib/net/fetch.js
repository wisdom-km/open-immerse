/**
 * One outbound HTTP entry. The extension, the future desktop app, and tests
 * each pass a different transport. Product code does not call fetch itself.
 *
 * Defaults below apply only when a caller omits the field.
 * Existing call sites opt out where today's code has no timeout or retry:
 *   - providers.js passes timeoutMs:false and retry:false (no timeout, no retry).
 *   - the arXiv client passes the same. Its own 20s race and 24h cooldown stay.
 *
 * Purpose timeouts, used when timeoutMs is omitted:
 *   translate 60s, multimodal 90s, ocr 120s, layout 30s,
 *   arxiv 20s (the live client value; the desktop sketch said 60s),
 *   probe 1.2s, local-service 1.2s,
 *   asset 60s (picked; nothing in the tree had an asset timeout).
 * Unknown purposes get no timeout.
 *
 * Retry, used when retry is omitted:
 *   translate / multimodal / ocr: 1 retry (LLM posts are not idempotent).
 *   every other purpose: 2 retries (picked; no caller had a net-level count).
 *   backoff 200ms, cap 2000ms (picked), doubling, jitter down to half.
 *   Retry-After replaces that wait, capped at 60s (picked cap).
 *   429, any 5xx (500 in `on` stands for the class), and network errors.
 *   A caller's abort is not retried. The per-provider cooldown runs only then.
 *   Multimodal calls also share an account lane of 3 in flight. The lane key
 *   is a hash of the credential, so the key itself is not stored. A 429 wait
 *   holds that lane. 429 is retried once, same as other multimodal retries;
 *   it is not a model failure. The lane is what bounds the concurrency that
 *   produced AccountRateLimitExceeded. A further 429-only retry is not added:
 *   the POST is not idempotent, and a plan-endpoint run at this cap
 *   (372 calls) saw no 429.
 *
 * The deadline covers the body, not just the headers. The timer is cleared
 * after the body has been read or the read has failed. A timeout during the
 * read is reported as timeout, not AbortError. A timeout that fires after
 * the response headers have arrived is not retried: the POST already started
 * and the body was in hand. A timeout before any headers still follows the
 * retry policy. The caller's own abort still rejects as AbortError.
 * timeoutMs:false never arms a timer.
 *
 * Cache runs only for an explicit cache.key, and only for a successful body.
 * In-flight dedupe is on for GET/HEAD unless dedupeKey is false. The map key
 * is a hash, so a raw API key is not stored. POST is not deduped unless the
 * caller passes a dedupeKey. Providers pass false: two identical translations
 * still make two requests, matching today.
 *
 * Logs go through redactText / redactHeaders. The bytes on the wire are not
 * redacted. Chrome 114 has no AbortSignal.any; we merge signals by hand when
 * it is missing.
 */

const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|ocp-apim-subscription-key)$/i;
const SECRET_HEADER_NAME = /key|token|secret|auth/i;
const RETRY_AFTER_CAP_MS = 60_000;
export const MM_ACCOUNT_CONCURRENCY = 3;

export const PURPOSE_TIMEOUT_MS = Object.freeze({
  translate: 60_000,
  multimodal: 90_000,
  ocr: 120_000,
  layout: 30_000,
  arxiv: 20_000,
  probe: 1_200,
  "local-service": 1_200,
  asset: 60_000
});

let installed = null;
let builtinFetch = null;

export function isBuiltinFetch(fn = globalThis.fetch) {
  if (typeof fn !== "function") return false;
  try {
    const source = Function.prototype.toString.call(fn);
    return source.includes("undici") || source.includes("[native code]");
  } catch {
    return false;
  }
}

function noteBuiltin() {
  if (!builtinFetch && isBuiltinFetch(globalThis.fetch)) builtinFetch = globalThis.fetch;
}

noteBuiltin();

export function redactText(text) {
  return String(text ?? "")
    .replace(/\/\/[^/\s@]*:[^/\s@]+@/g, "//***:***@")
    .replace(/sk-[A-Za-z0-9_-]+/g, "***")
    .replace(/\bBearer\s+\S+/gi, "Bearer ***")
    .replace(/\bDeepL-Auth-Key\s+\S+/gi, "DeepL-Auth-Key ***")
    .replace(
      /([?&#](?:x[-_]?api[-_]?key|api[-_]?key|access[-_]?(?:token|key)|token|secret|key)=)[^&\s#]+/gi,
      "$1***"
    );
}

export function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const secret = SECRET_HEADER.test(key) || SECRET_HEADER_NAME.test(key);
    out[key] = secret ? "***" : redactText(value);
  }
  return out;
}

function urlOf(input) {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  if (input && typeof input.url === "string") return input.url;
  return String(input || "");
}

function realNetworkError(input) {
  const error = new Error(`real network in test: ${redactText(urlOf(input))}`);
  error.code = "real-network-in-test";
  return error;
}

export async function globalFetchTransport(input, init) {
  noteBuiltin();
  const impl = globalThis.fetch;
  // Chrome has no process. A bare process.env throws before the request leaves.
  if (globalThis.process?.env?.NODE_TEST_CONTEXT && isBuiltinFetch(impl)) {
    throw realNetworkError(input);
  }
  if (typeof impl !== "function") {
    const error = new Error("fetch unavailable");
    error.code = "fetch-unavailable";
    throw error;
  }
  return impl(input, init);
}

export function fixtureTransport(routes) {
  return async function transport(input, init) {
    const url = urlOf(input);
    if (typeof routes === "function") {
      const result = await routes(url, init, input);
      if (result === undefined) throw realNetworkError(url);
      return result;
    }
    if (routes && typeof routes.get === "function" && routes.has(url)) {
      const route = routes.get(url);
      return typeof route === "function" ? route(input, init) : route;
    }
    throw realNetworkError(url);
  };
}

export function installNet(net) {
  installed = net || null;
}

export function currentNet() {
  if (!installed) installed = createNet({ transport: globalFetchTransport });
  return installed;
}

export function getNativeFetch() {
  noteBuiltin();
  return builtinFetch;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function timeoutError(afterHeaders) {
  const error = new Error("timeout");
  error.code = "timeout";
  error.name = "TimeoutError";
  // Headers already arrived, so this POST is not safe to send again.
  if (afterHeaders) error.bodyRead = true;
  return error;
}

function hashText(text) {
  let hash = 2166136261;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function bodyKey(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) {
    let hash = 2166136261;
    const bytes = body;
    for (let i = 0; i < bytes.length; i += 1) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) return null;
  return String(body);
}

function methodOf(req) {
  return String(req.method || "GET").toUpperCase();
}

function dedupeKeyOf(req) {
  if (req.dedupeKey === false) return null;
  if (typeof req.dedupeKey === "string" && req.dedupeKey) return `k:${req.dedupeKey}`;
  const method = methodOf(req);
  if (method !== "GET" && method !== "HEAD") return null;
  const body = bodyKey(req.body);
  if (body == null) return null;
  return `h:${hashText(`${method}\n${urlOf(req.url)}\n${body}`)}`;
}

function defaultRetry(purpose) {
  const llm = purpose === "translate" || purpose === "multimodal" || purpose === "ocr";
  return {
    max: llm ? 1 : 2,
    on: [429, 500, 502, 503, 504],
    backoffMs: [200, 2000],
    honorRetryAfter: true
  };
}

function resolveRetry(req) {
  if (req.retry === false) return null;
  const base = defaultRetry(req.purpose);
  if (req.retry == null || req.retry === true) return base;
  const max = Number.isFinite(req.retry.max) ? req.retry.max : base.max;
  if (max <= 0) return null;
  const backoff = Array.isArray(req.retry.backoffMs) && req.retry.backoffMs.length >= 2
    ? req.retry.backoffMs
    : base.backoffMs;
  return {
    max,
    on: Array.isArray(req.retry.on) ? req.retry.on : base.on,
    backoffMs: backoff,
    honorRetryAfter: req.retry.honorRetryAfter !== false
  };
}

function resolveTimeout(req) {
  if (req.timeoutMs === false || req.timeoutMs === 0) return 0;
  if (Number.isFinite(req.timeoutMs) && req.timeoutMs > 0) return req.timeoutMs;
  return PURPOSE_TIMEOUT_MS[req.purpose] || 0;
}

function statusRetryable(status, policy) {
  if (!policy || !status) return false;
  if (policy.on.includes(status)) return true;
  return status >= 500 && status <= 599 && policy.on.includes(500);
}

function networkRetryable(err, req) {
  if (!err) return false;
  if (err.code === "real-network-in-test") return false;
  if (req.signal?.aborted) return false;
  if (err.name === "AbortError" && err.code !== "timeout") return false;
  return true;
}

function headerGet(headers, name) {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === want) return value;
  }
  return undefined;
}

function headersOf(response) {
  const headers = response?.headers;
  if (!headers) return {};
  if (typeof headers.forEach === "function" && typeof headers.entries !== "function") {
    const out = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (typeof headers.entries === "function") {
    const out = {};
    for (const [key, value] of headers.entries()) out[key] = value;
    return out;
  }
  return { ...headers };
}

function retryAfterMs(headers, now) {
  const raw = headerGet(headers, "retry-after");
  if (raw == null || raw === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, seconds * 1000));
  const date = Date.parse(String(raw));
  if (Number.isFinite(date)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, date - now));
  return null;
}

function backoffDelay(attempt, policy, random) {
  const base = Number(policy.backoffMs[0]) || 0;
  const cap = Number(policy.backoffMs[1]) || base;
  const raw = Math.min(cap, base * 2 ** attempt);
  const roll = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(raw * (1 - 0.5 * roll));
}

function createMemoryCache() {
  const map = new Map();
  return {
    get(key, now) {
      const row = map.get(key);
      if (!row) return null;
      if (row.expires <= now) {
        map.delete(key);
        return null;
      }
      return row.value;
    },
    set(key, value, expires) {
      map.set(key, { value, expires });
    }
  };
}

function copyData(data) {
  if (data == null || typeof data !== "object") return data;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(data);
    } catch {
      /* keep the original when the body cannot be cloned */
    }
  }
  return data;
}

function linkSignals(signals) {
  const present = signals.filter(Boolean);
  if (!present.length) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(present);
  }
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function limitKey(req) {
  if (req.provider) return `p:${req.provider}`;
  try {
    return `h:${new URL(urlOf(req.url)).host}`;
  } catch {
    return "h:";
  }
}

function accountCredential(req) {
  const headers = req?.headers || {};
  const auth = headerGet(headers, "authorization") || headerGet(headers, "x-goog-api-key") || "";
  return String(auth).replace(/^Bearer\s+/i, "").trim();
}

function accountLaneKey(req) {
  if (req?.purpose !== "multimodal") return "";
  const credential = accountCredential(req);
  if (credential) return `acct:${hashText(credential)}`;
  return `acct:${limitKey(req)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function headerSecretValues(headers) {
  const values = [];
  const add = (key) => {
    const text = String(key ?? "");
    if (text && !values.includes(text)) values.push(text);
  };
  for (const [name, value] of Object.entries(headers || {})) {
    if (!(SECRET_HEADER.test(name) || SECRET_HEADER_NAME.test(name))) continue;
    const raw = String(value ?? "");
    add(raw);
    const trimmed = raw.trim();
    add(trimmed);
    const bearer = trimmed.replace(/^Bearer\s+/i, "");
    if (bearer !== trimmed) {
      add(bearer);
      add(bearer.trim());
    }
  }
  return values.sort((a, b) => b.length - a.length);
}

function redactLoggedError(req, error) {
  const text = redactText(error);
  if (req?.purpose !== "multimodal") return text;
  let raw = text;
  for (const key of headerSecretValues(req.headers)) {
    raw = raw.replace(new RegExp(escapeRegExp(key), "gi"), "***");
  }
  return raw;
}

function logRecord(req, info) {
  return {
    purpose: req.purpose || "",
    provider: req.provider || "",
    method: methodOf(req),
    url: redactText(urlOf(req.url)),
    status: info.status ?? 0,
    attempts: info.attempts || 0,
    headers: redactHeaders(req.headers),
    error: info.error ? redactLoggedError(req, info.error) : ""
  };
}

async function readJsonOrText(response) {
  if (typeof response?.text === "function") {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (typeof response?.json === "function") {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
}

function bodyShortcut(response) {
  return Boolean(response
    && Object.prototype.hasOwnProperty.call(response, "data")
    && typeof response.json !== "function"
    && typeof response.text !== "function"
    && typeof response.arrayBuffer !== "function");
}

function cancelUnread(response) {
  const body = response?.body;
  if (!body || typeof body.cancel !== "function") return;
  body.cancel().then(() => {}, () => {});
}

function markBodyRead(err) {
  if (err && typeof err === "object") {
    try {
      err.bodyRead = true;
    } catch {
      /* a frozen error is still not retried; the caller sees the original */
    }
    return err;
  }
  const wrapped = new Error(String(err ?? "body read failed"));
  wrapped.bodyRead = true;
  return wrapped;
}

function settleResponse(req, response, attempt, policy, timedOut) {
  const headers = headersOf(response);
  const status = Number(response?.status || 0);
  const ok = typeof response?.ok === "boolean" ? response.ok : status >= 200 && status < 300;
  const meta = { headers, status, ok };
  if (policy && !ok && statusRetryable(status, policy) && attempt < policy.max) {
    cancelUnread(response);
    return { ...meta, retry: true };
  }
  const responseType = req.responseType || "json";
  if (bodyShortcut(response)) return { ...meta, data: response.data };
  if (responseType === "stream") return { ...meta, data: response };
  return readBody(response, responseType, ok, req.errorBody === true).then((data) => ({ ...meta, data }), (err) => {
    if (req.signal?.aborted) throw err;
    if (timedOut()) throw timeoutError(true);
    throw markBodyRead(err);
  });
}

async function readBody(response, responseType, ok, errorBody) {
  if (bodyShortcut(response)) return response.data;
  if (responseType === "stream") return response;
  if (responseType === "bytes") {
    if (!ok || typeof response?.arrayBuffer !== "function") return new Uint8Array();
    const buf = await response.arrayBuffer();
    if (buf instanceof Uint8Array) return buf;
    return new Uint8Array(buf);
  }
  if (responseType === "text") {
    if (!ok) return "";
    if (typeof response?.text === "function") return response.text();
    return "";
  }
  // Failures stay empty unless this request opted in. Only the multimodal
  // client does; translate, arXiv, and probe callers still see null.
  if (!ok && errorBody !== true) return null;
  if (!ok) return readJsonOrText(response);
  if (typeof response?.json === "function") return response.json();
  return null;
}

function buildInit(req, signal) {
  const init = {};
  let has = false;
  const method = req.method ? String(req.method).toUpperCase() : "";
  if (method) {
    init.method = method;
    has = true;
  }
  if (req.headers && Object.keys(req.headers).length) {
    init.headers = req.headers;
    has = true;
  }
  if (req.body !== undefined) {
    init.body = req.body;
    has = true;
  }
  if (signal) {
    init.signal = signal;
    has = true;
  }
  return has ? init : undefined;
}

export function createNet(options = {}) {
  const transport = options.transport || globalFetchTransport;
  const clock = options.clock || (() => Date.now());
  const sleep = options.sleep || defaultSleep;
  const random = options.random || Math.random;
  const log = typeof options.log === "function" ? options.log : () => {};
  const cacheStore = options.cache && typeof options.cache.get === "function"
    ? options.cache
    : createMemoryCache();
  const inflight = new Map();
  const limitedUntil = new Map();
  const accountLanes = new Map();

  function releaseAccountLane(state) {
    if (!state || state.released) return;
    state.released = true;
    const lane = state.lane;
    const next = lane.waiters.shift();
    if (next) {
      next.grant();
      return;
    }
    lane.active -= 1;
    if (lane.active <= 0 && lane.waiters.length === 0) accountLanes.delete(state.key);
  }

  function acquireAccountLane(req) {
    const key = accountLaneKey(req);
    if (!key) return Promise.resolve(() => {});
    let lane = accountLanes.get(key);
    if (!lane) {
      lane = { active: 0, waiters: [] };
      accountLanes.set(key, lane);
    }
    const state = { key, lane, released: false };
    const release = () => releaseAccountLane(state);
    if (lane.active < MM_ACCOUNT_CONCURRENCY) {
      lane.active += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        grant() {
          req.signal?.removeEventListener("abort", onAbort);
          resolve(release);
        }
      };
      function onAbort() {
        const index = lane.waiters.indexOf(waiter);
        if (index >= 0) lane.waiters.splice(index, 1);
        reject(abortError());
      }
      if (req.signal?.aborted) {
        onAbort();
        return;
      }
      req.signal?.addEventListener("abort", onAbort, { once: true });
      lane.waiters.push(waiter);
    });
  }

  async function waitLimit(key, policy, signal) {
    if (!policy) return;
    const until = limitedUntil.get(key);
    const now = clock();
    if (until && until > now) await sleep(until - now, signal);
  }

  function rememberLimit(key, delay) {
    const until = clock() + delay;
    const prev = limitedUntil.get(key) || 0;
    if (until > prev) limitedUntil.set(key, until);
  }

  async function sendOnce(req, timeoutMs, attempt, policy) {
    const timeoutCtrl = new AbortController();
    const timerGate = new AbortController();
    const signal = linkSignals([req.signal, timeoutMs ? timeoutCtrl.signal : null]);
    const init = buildInit(req, signal);
    const target = urlOf(req.url);
    let timedOut = false;
    let headersSeen = false;
    let timer = null;
    if (timeoutMs) {
      timer = sleep(timeoutMs, timerGate.signal).then(() => {
        timedOut = true;
        timeoutCtrl.abort();
        return "timeout";
      }, () => "cancelled");
    }
    const work = Promise.resolve().then(() => {
      let pending;
      try {
        pending = init ? transport(target, init) : transport(target);
      } catch (err) {
        return Promise.reject(err);
      }
      const finish = (response) => {
        // The transport resolved, so status and headers are in hand even if
        // the body read is still pending. A later timeout must not POST again.
        headersSeen = true;
        return settleResponse(req, response, attempt, policy, () => timedOut || timeoutCtrl.signal.aborted);
      };
      if (!pending || typeof pending.then !== "function") return finish(pending);
      return pending.then(finish);
    });
    try {
      if (!timer) return await work;
      const winner = await Promise.race([
        work.then((value) => ({ type: "value", value }), (error) => ({ type: "error", error })),
        timer.then((kind) => ({ type: kind }))
      ]);
      if (winner.type === "timeout") throw timeoutError(headersSeen);
      if (winner.type === "error") {
        if (req.signal?.aborted) throw winner.error;
        if (timedOut || timeoutCtrl.signal.aborted) throw timeoutError(headersSeen);
        throw winner.error;
      }
      if (winner.type === "value") return winner.value;
      return await work;
    } finally {
      timerGate.abort();
    }
  }

  async function perform(req) {
    const release = await acquireAccountLane(req);
    try {
      return await performBody(req);
    } finally {
      release();
    }
  }

  async function performBody(req) {
    const policy = resolveRetry(req);
    const timeoutMs = resolveTimeout(req);
    const key = limitKey(req);
    let lastError = null;
    const max = policy ? policy.max : 0;
    for (let attempt = 0; attempt <= max; attempt += 1) {
      if (policy) await waitLimit(key, policy, req.signal);
      let outcome;
      try {
        outcome = await sendOnce(req, timeoutMs, attempt, policy);
      } catch (err) {
        lastError = err;
        log(logRecord(req, { attempts: attempt + 1, error: err?.message || err }));
        if (err?.bodyRead || !policy || attempt === max || !networkRetryable(err, req)) throw err;
        const delay = backoffDelay(attempt, policy, random);
        rememberLimit(key, delay);
        await sleep(delay, req.signal);
        continue;
      }
      const attempts = attempt + 1;
      if (outcome.retry) {
        log(logRecord(req, { status: outcome.status, attempts }));
        const honored = policy.honorRetryAfter ? retryAfterMs(outcome.headers, clock()) : null;
        const delay = honored == null ? backoffDelay(attempt, policy, random) : honored;
        rememberLimit(key, delay);
        await sleep(delay, req.signal);
        continue;
      }
      const result = {
        ok: outcome.ok,
        status: outcome.status,
        headers: outcome.headers,
        data: outcome.data,
        fromCache: false,
        attempts
      };
      log(logRecord(req, { status: outcome.status, attempts }));
      return result;
    }
    throw lastError || new Error("net fetch failed");
  }

  function fetch(req) {
    if (!req || !req.url) {
      const error = new Error("net.fetch requires a url");
      error.code = "bad-request";
      throw error;
    }
    if (!req.purpose) {
      const error = new Error("net.fetch requires a purpose");
      error.code = "bad-request";
      throw error;
    }
    const prepared = { ...req };
    if (prepared.json !== undefined && prepared.body === undefined) {
      prepared.body = JSON.stringify(prepared.json);
      prepared.headers = {
        "Content-Type": "application/json",
        ...(prepared.headers || {})
      };
    }
    const cacheKey = prepared.cache && prepared.cache.key ? String(prepared.cache.key) : "";
    if (cacheKey) {
      const hit = cacheStore.get(cacheKey, clock());
      if (hit) return Promise.resolve({ ...hit, data: copyData(hit.data), fromCache: true, attempts: 0 });
    }
    const dedupeKey = dedupeKeyOf(prepared);
    if (dedupeKey && inflight.has(dedupeKey)) return inflight.get(dedupeKey);
    const job = perform(prepared).then((result) => {
      if (cacheKey && result.ok) {
        const ttl = Number(prepared.cache.ttlMs) || 0;
        if (ttl > 0) cacheStore.set(cacheKey, { ...result, data: copyData(result.data) }, clock() + ttl);
      }
      return result;
    });
    if (dedupeKey) {
      inflight.set(dedupeKey, job);
      job.then(() => {
        if (inflight.get(dedupeKey) === job) inflight.delete(dedupeKey);
      }, () => {
        if (inflight.get(dedupeKey) === job) inflight.delete(dedupeKey);
      });
    }
    return job;
  }

  return { fetch };
}
