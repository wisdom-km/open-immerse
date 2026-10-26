/** arXiv e-print client. Network, cooldown, and the oi-arxiv-src cache stay here. */

import { unpackSource } from "../lib/arxiv-src-unpack.js";
import { currentNet } from "../lib/net/fetch.js";
import { diagLog, handleDiagMessage, installServiceWorkerDiag, noteTranslateBorrow, noteTranslateFailure } from "../lib/diag-log.js";

export const ARXIV_DB = "oi-arxiv-src";
export const MIN_GAP_MS = 3000;
export const TIMEOUT_MS = 20000;
export const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const POLITENESS_KEY = "meta:politeness";

/**
 * A dropped network is offline. DNS, HTTP, and timeouts stay their own reasons
 * so the pane does not call a server failure 「离线」.
 */
export function arxivFailureReason(err, online) {
  if (err?.code === "timeout" || err?.name === "AbortError") return "timeout";
  const text = `${err?.code || ""} ${err?.message || ""} ${err?.cause?.code || ""} ${err?.cause?.message || ""}`;
  if (/ERR_INTERNET_DISCONNECTED/i.test(text)) return "offline";
  const line = typeof online === "boolean" ? online : globalThis.navigator?.onLine;
  if (line === false) return "offline";
  return "error";
}

export function sourceCacheKey(id, version) {
  return `src:${id}${version ? `@${version}` : "@latest"}`;
}

export function alignmentCacheKey(id, version, pdfSha256) {
  return `align:${id}${version ? `@${version}` : "@latest"}:${pdfSha256 || ""}`;
}

export function createMemoryStore() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async clear() {
      map.clear();
    },
    async keys() {
      return [...map.keys()];
    }
  };
}

export function createIdbStore({
  indexedDB: idb = globalThis.indexedDB,
  name = ARXIV_DB
} = {}) {
  if (!idb) return createMemoryStore();
  const open = () => new Promise((resolve, reject) => {
    const request = idb.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("entries", mode);
        const store = tx.objectStore("entries");
        const result = fn(store);
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    async get(key) {
      const value = await run("readonly", (store) => store.get(key));
      return value ?? null;
    },
    async put(key, value) {
      await run("readwrite", (store) => store.put(value, key));
    },
    async delete(key) {
      await run("readwrite", (store) => store.delete(key));
    },
    async clear() {
      await run("readwrite", (store) => store.clear());
    },
    async keys() {
      const value = await run("readonly", (store) => store.getAllKeys());
      return value || [];
    }
  };
}

function textOnly(files) {
  return (files || []).map((file) => ({
    path: String(file.path || ""),
    text: String(file.text || "")
  }));
}

function byteSize(bytes) {
  if (!bytes) return 0;
  if (typeof bytes.size === "number") return bytes.size;
  if (typeof bytes.byteLength === "number") return bytes.byteLength;
  return 0;
}

function asBlob(bytes, mime) {
  if (bytes instanceof Blob) return bytes;
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  return new Blob([data], { type: mime || "application/octet-stream" });
}

function storeAssets(assets) {
  return (assets || []).map((asset) => ({
    path: String(asset.path || ""),
    mime: String(asset.mime || ""),
    bytes: asBlob(asset.bytes, asset.mime)
  }));
}

function assetMeta(assets) {
  return (assets || []).map((asset) => ({
    path: String(asset.path || ""),
    mime: String(asset.mime || ""),
    size: byteSize(asset.bytes)
  }));
}

function skipMeta(skipped) {
  return (skipped || []).map((row) => ({
    path: String(row.path || ""),
    reason: String(row.reason || "")
  }));
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function assetForMessage(result) {
  if (!result || result.ok !== true || result.bytes == null) return result;
  const blob = result.bytes instanceof Blob ? result.bytes : asBlob(result.bytes, result.mime);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    ok: true,
    path: result.path,
    mime: result.mime,
    encoding: "base64",
    data: bytesToBase64(bytes)
  };
}

export async function gunzipBytes(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("gunzipBytes requires DecompressionStream; inject gunzip in tests");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function srcUrl(id, version) {
  return `https://arxiv.org/src/${id}${version || ""}`;
}

export function createArxivSourceClient({
  fetch: doFetch,
  now,
  sleep,
  store,
  gunzip,
  maxAssetBytes,
  online
} = {}) {
  if (typeof doFetch !== "function") throw new Error("createArxivSourceClient requires fetch");
  const clock = now || (() => Date.now());
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const cache = store || createMemoryStore();
  const inflate = gunzip || gunzipBytes;
  const inflight = new Map();
  const sessionFailed = new Set();
  let chain = Promise.resolve();
  let lastStart = null;
  let cooldownUntil = 0;
  let active = 0;
  let politenessLoaded = null;

  function applyPoliteness(row) {
    if (!row || typeof row !== "object") return;
    if (Number.isFinite(row.cooldownUntil) && row.cooldownUntil > cooldownUntil) {
      cooldownUntil = row.cooldownUntil;
    }
    if (Number.isFinite(row.lastStart) && (lastStart == null || row.lastStart > lastStart)) {
      lastStart = row.lastStart;
    }
  }

  function ensurePoliteness() {
    if (!politenessLoaded) {
      politenessLoaded = cache.get(POLITENESS_KEY).then(applyPoliteness, () => {});
    }
    return politenessLoaded;
  }

  function rememberPoliteness() {
    return cache.put(POLITENESS_KEY, { cooldownUntil, lastStart });
  }

  function enqueue(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function fetchOne(url) {
    await ensurePoliteness();
    const gap = lastStart == null ? 0 : MIN_GAP_MS - (clock() - lastStart);
    if (gap > 0) await wait(gap);
    lastStart = clock();
    await rememberPoliteness();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timeout = wait(TIMEOUT_MS).then(() => {
      try { controller?.abort(); } catch { /* already finished */ }
      const error = new Error("timeout");
      error.code = "timeout";
      throw error;
    });
    timeout.catch(() => {});
    try {
      return await Promise.race([
        Promise.resolve().then(() => doFetch(url, controller ? { signal: controller.signal } : {})),
        timeout
      ]);
    } catch (err) {
      if (err?.code === "timeout" || err?.name === "AbortError") {
        const error = new Error("timeout");
        error.code = "timeout";
        throw error;
      }
      throw err;
    }
  }

  async function download(id, version) {
    active += 1;
    try {
      const response = await fetchOne(srcUrl(id, version));
      const status = Number(response?.status || 0);
      if (status === 403 || status === 429) {
        cooldownUntil = clock() + COOLDOWN_MS;
        await rememberPoliteness();
        return { ok: false, reason: "cooldown", status };
      }
      if (status && status >= 400) {
        return { ok: false, reason: "http", status };
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      const unpacked = await unpackSource(buffer, { gunzip: inflate, maxAssetBytes });
      if (unpacked.kind === "pdf-only") {
        return { ok: false, reason: "pdf-only", files: [], assets: [] };
      }
      if (unpacked.kind === "rejected") {
        return { ok: false, reason: unpacked.reason || "unpack" };
      }
      return {
        ok: true,
        files: textOnly(unpacked.files),
        assets: storeAssets(unpacked.assets),
        skipped: skipMeta(unpacked.skipped),
        kind: unpacked.kind,
        regularFileCount: unpacked.regularFileCount
      };
    } finally {
      active -= 1;
    }
  }

  function get(request = {}) {
    const id = String(request.id || "").trim();
    const version = request.version ? String(request.version) : "";
    if (request.userTriggered !== true) {
      return Promise.resolve({ ok: false, reason: "not-triggered" });
    }
    if (!id) return Promise.resolve({ ok: false, reason: "missing-id" });
    const key = sourceCacheKey(id, version);
    if (inflight.has(key)) return inflight.get(key);
    const job = runGet(id, version, key);
    inflight.set(key, job);
    job.finally(() => {
      if (inflight.get(key) === job) inflight.delete(key);
    });
    return job;
  }

  async function runGet(id, version, key) {
    await ensurePoliteness();
    const cached = await cache.get(key);
    if (cached) {
      return {
        ok: cached.reason !== "pdf-only",
        reason: cached.reason || undefined,
        files: cached.files || [],
        assets: assetMeta(cached.assets),
        skipped: skipMeta(cached.skipped),
        cached: true,
        id,
        version: version || null
      };
    }
    if (clock() < cooldownUntil) return { ok: false, reason: "cooldown" };
    if (sessionFailed.has(key)) return { ok: false, reason: "session-failed" };
    let outcome;
    try {
      outcome = await enqueue(() => download(id, version));
    } catch (err) {
      sessionFailed.add(key);
      const line = typeof online === "function" ? online() : online;
      const reason = arxivFailureReason(err, line);
      if (reason === "offline") diagLog("net.offline", { ctx: "sw", code: "offline" });
      return { ok: false, reason, id, version: version || null };
    }
    if (outcome.reason === "pdf-only") {
      await cache.put(key, { reason: "pdf-only", files: [], assets: [], skipped: [], id, version: version || null });
      return { ok: false, reason: "pdf-only", files: [], assets: [], skipped: [], cached: true, id, version: version || null };
    }
    if (!outcome.ok) {
      if (outcome.reason === "timeout" || outcome.reason === "http" || outcome.reason === "unpack" || outcome.reason === "error") {
        sessionFailed.add(key);
      }
      return { ok: false, reason: outcome.reason || "error", id, version: version || null };
    }
    const assets = storeAssets(outcome.assets);
    const skipped = skipMeta(outcome.skipped);
    await cache.put(key, {
      files: textOnly(outcome.files),
      assets,
      skipped,
      id,
      version: version || null
    });
    return {
      ok: true,
      files: textOnly(outcome.files),
      assets: assetMeta(assets),
      skipped,
      id,
      version: version || null,
      cached: false
    };
  }

  async function readAsset(request = {}) {
    const id = String(request.id || "").trim();
    const version = request.version ? String(request.version) : "";
    const path = String(request.path || "");
    if (!id || !path) return { ok: false, reason: "missing-id" };
    const row = await cache.get(sourceCacheKey(id, version));
    const asset = (row?.assets || []).find((item) => item.path === path);
    if (!asset) return { ok: false, reason: "missing" };
    return { ok: true, path: asset.path, mime: asset.mime, bytes: asset.bytes };
  }

  // clear() drops cached source text, figure bytes, and the alignment cache.
  // The persisted 403/429 cooldown (meta:politeness) stays.
  async function clear() {
    const keys = await cache.keys();
    for (const key of keys || []) {
      if (key === POLITENESS_KEY) continue;
      await cache.delete(key);
    }
    sessionFailed.clear();
    return { ok: true };
  }

  function status() {
    return {
      ok: true,
      database: ARXIV_DB,
      cooldownUntil,
      coolingDown: clock() < cooldownUntil,
      inFlight: active,
      lastStart
    };
  }

  async function readAlignment({ id, version, pdfSha256 }) {
    const row = await cache.get(alignmentCacheKey(id, version || "", pdfSha256));
    return row?.alignment || null;
  }

  async function saveAlignment({ id, version, pdfSha256, alignment }) {
    await cache.put(alignmentCacheKey(id, version || "", pdfSha256), {
      alignment,
      id,
      version: version || null,
      pdfSha256
    });
    return { ok: true };
  }

  return { get, clear, status, readAsset, readAlignment, saveAlignment, ready: ensurePoliteness };
}

let singleton = null;

/**
 * Production download goes through platform net. fetchOne still owns the 20s
 * race, so this wrapper does not add a second timeout or a retry. A 403/429
 * stays a 24h cooldown inside the client, not a net-level retry.
 */
export async function arxivNetFetch(url, init = {}) {
  const result = await currentNet().fetch({
    url: typeof url === "string" ? url : String(url?.url || url || ""),
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    purpose: "arxiv",
    timeoutMs: false,
    retry: false,
    cache: false,
    dedupeKey: false,
    responseType: "bytes"
  });
  return {
    ok: result.ok,
    status: result.status,
    headers: result.headers,
    async arrayBuffer() {
      const data = result.data;
      if (data instanceof ArrayBuffer) return data;
      if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      }
      return new ArrayBuffer(0);
    }
  };
}

export function sharedArxivSourceClient() {
  if (!singleton) {
    singleton = createArxivSourceClient({
      fetch: arxivNetFetch,
      store: createIdbStore(),
      gunzip: gunzipBytes
    });
  }
  return singleton;
}

export function handleArxivSourceMessage(message = {}, client = sharedArxivSourceClient()) {
  // The service worker's import list and its ban on import() are both locked.
  // Diagnostic messages and translate failures arrive through this function.
  if (message.action === "diag") {
    return handleDiagMessage(message.message || {}, { sender: message.sender || null });
  }
  if (message.action === "diag-note") {
    // Only the service worker's own translate catch calls this, with no sender.
    if (message.sender) return { ok: false };
    try {
      installServiceWorkerDiag();
      noteTranslateFailure(message.failure, message.fields || {});
    } catch {
      /* diag is best-effort */
    }
    return { ok: true };
  }
  if (message.action === "diag-borrow") {
    if (message.sender) return { ok: false };
    try {
      installServiceWorkerDiag();
      noteTranslateBorrow(message.fields || {});
    } catch {
      /* diag is best-effort */
    }
    return { ok: true };
  }
  if (message.action === "clear") return client.clear();
  if (message.action === "status") {
    return Promise.resolve(typeof client.ready === "function" ? client.ready() : null).then(() => client.status());
  }
  if (message.action === "asset") return Promise.resolve(client.readAsset(message)).then(assetForMessage);
  if (message.action === "read-alignment") {
    return client.readAlignment(message);
  }
  if (message.action === "save-alignment") {
    return client.saveAlignment(message);
  }
  return client.get({
    id: message.id,
    version: message.version,
    userTriggered: message.userTriggered === true,
    pdfSha256: message.pdfSha256
  });
}
