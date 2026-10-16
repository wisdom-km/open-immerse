/** Layout HTTP. The viewer calls these. Both modes return a vendor envelope, then one mapper. */

import { PROTOCOL } from "./pdf-blocks.js";

export const LAYOUT_FALLBACK_STATUS = "划区服务不可用，已使用文字层";
export const LAYOUT_NO_BOXES_STATUS = "本页没有返回划区，已使用文字层";
export const LAYOUT_EMPTY_KEY_STATUS = "云端密钥为空，已使用文字层";
export const LAYOUT_STARTING_STATUS = "正在连接本机 GLM-OCR…";

export const DEFAULT_LOCAL_BASE = "http://127.0.0.1:8765";
export const DEFAULT_CLOUD_BASE = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";

const MODES = new Set(["text-layer", "local-ocr", "cloud-ocr"]);
const OVERRIDES = new Set(["legacy", "fixture", "text-layer", "local-ocr", "cloud-ocr"]);

export function normalizePdfLayout(value) {
  const src = value && typeof value === "object" ? value : {};
  const mode = MODES.has(src.mode) ? src.mode : "";
  return {
    mode,
    localBaseUrl: String(src.localBaseUrl || DEFAULT_LOCAL_BASE).replace(/\/$/, ""),
    cloudBaseUrl: String(src.cloudBaseUrl || DEFAULT_CLOUD_BASE).replace(/\/$/, ""),
    cloudModel: String(src.cloudModel || "glm-ocr"),
    cloudApiKey: String(src.cloudApiKey || "")
  };
}

/** Empty mode reads the PDF text layer. local-ocr and cloud-ocr stay explicit adapters. */
export function resolveLayoutMode(layout, override = "") {
  if (OVERRIDES.has(override)) return override;
  const normalized = normalizePdfLayout(layout);
  return normalized.mode || "text-layer";
}

export function shouldFetchCloud(layout) {
  return Boolean(normalizePdfLayout(layout).cloudApiKey.trim());
}

export function layoutCacheKey({ hash, page, mode }) {
  return `oi-pdf-layout:${hash}:${page}:${mode}:${PROTOCOL}:source-v3`;
}

/**
 * Layout identity. The cache key stays source-v3; this revision is stored on
 * the layout itself. It changes when the block-building sources change, so the
 * next algorithm edit invalidates saved layouts without a hand-bumped number.
 */
const LAYOUT_ALGORITHM_FILES = [
  "pdf-text-layer.js",
  "pdf-layout-adapter.js",
  "pdf-blocks.js",
  "pdf-mirror.js"
];

let layoutVersionTask = null;

async function readAlgorithmSource(name) {
  const url = new URL(`./${name}`, import.meta.url);
  if (url.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    return readFile(url, "utf8");
  }
  // P-A whitelist: this reads the extension's own algorithm files, not an API.
  // file: uses node:fs above. Routing the page fetch through Net would change that split.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`layout revision ${name} HTTP ${res.status}`);
  return res.text();
}

export async function currentLayoutVersion() {
  if (!layoutVersionTask) {
    layoutVersionTask = computeLayoutVersion().catch((error) => {
      layoutVersionTask = null;
      throw error;
    });
  }
  return layoutVersionTask;
}

async function computeLayoutVersion() {
  const parts = [];
  for (const name of LAYOUT_ALGORITHM_FILES) parts.push(await readAlgorithmSource(name));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
  const hex = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
  return `source-v3:${hex.slice(0, 16)}`;
}

/**
 * Text-layer stand-in stored with the layout. A transient reason (http-502,
 * network) is shown immediately and recomputed later. "no-boxes" is the
 * vendor's answer for this page, not an outage.
 */
export function layoutFallbackOf(layout) {
  const fallback = layout?.fallback;
  if (!fallback || typeof fallback !== "object") return null;
  const source = String(fallback.source || "");
  const reason = String(fallback.reason || "");
  if (!source && !reason) return null;
  return { source: source || "text-layer", reason };
}

/** Sidecar body for 「layout returned no boxes」. Empty body cannot be told apart from a real 502. */
export function layoutNoBoxesMessage(text) {
  const body = String(text || "");
  return /no boxes/i.test(body) || /没有框|无框|未返回框/.test(body);
}

/**
 * A saved layout can be painted when its revision matches and it has blocks,
 * including a text-layer fallback that is still waiting on the vendor.
 * The layout's own revision wins. The row's revision is used only when the
 * layout carries none, so a stale body is not current just because the row is.
 */
export function storedLayoutDisplayable(record, version) {
  if (!record || !version) return null;
  const layout = Array.isArray(record.blocks) ? record : record.layout;
  if (!layout || !Array.isArray(layout.blocks) || !layout.blocks.length) return null;
  const own = String(layout.layoutVersion || layout.layoutRev || "");
  const row = layout === record ? "" : String(record.layoutVersion || record.layoutRev || "");
  const effective = own || row;
  return effective && effective === String(version) ? layout : null;
}

/**
 * A saved layout is settled when it can be painted and it is not a transient
 * text-layer fallback. "no-boxes" stays settled: the vendor already answered.
 */
export function storedLayoutCurrent(record, version) {
  const layout = storedLayoutDisplayable(record, version);
  if (!layout) return null;
  const fallback = layoutFallbackOf(layout);
  if (!fallback) return layout;
  if (fallback.reason === "no-boxes") return layout;
  return null;
}

/**
 * A layout the reader can keep without asking the vendor again.
 * The revision may sit on the layout, or on the row when the layout has
 * none. No revision still has to be zoned. A transient text-layer stand-in does too.
 */
export function layoutReadyForZone(record, version) {
  return storedLayoutCurrent(record, version);
}

const ENGINE_MODES = new Set(["text-layer", "local-ocr", "cloud-ocr"]);

/** Explicit mode on a layout or its row. A missing mode is not guessed from textSource. */
export function layoutRecordMode(record) {
  const layout = record && Array.isArray(record.blocks) ? record : record?.layout;
  const named = String(layout?.mode || record?.mode || "");
  if (ENGINE_MODES.has(named) || named === "unknown") return named;
  return "";
}

/**
 * Another engine's explicit layout is not this one.
 * main stores no mode. A missing mode, and the migrated `unknown` tag for that
 * same layout, count as current for every engine. Only an explicit recorded
 * mode that differs from the engine is not current.
 */
export function layoutServesEngine(record, engine) {
  const want = String(engine || "");
  if (!ENGINE_MODES.has(want)) return true;
  const mode = layoutRecordMode(record);
  if (!mode || mode === "unknown") return true;
  return mode === want;
}

/**
 * Library documents use the same rule as main's mode-less page. `unknown` is
 * kept on the row for later, and it still counts as current for every engine.
 */
export function layoutServesLibrary(record, engine) {
  return layoutServesEngine(record, engine);
}

/**
 * Tag a layout this session produced.
 * unknown stays unknown: a library row migrated from main must keep main's
 * behaviour. A transient fallback is not relabeled. `mode` is text-layer for
 * a text-layer stand-in, or the vendor engine for a layout the vendor just returned.
 */
export function stampSessionLayout(layout, mode) {
  if (!layout || layout.fallback) return layout;
  if (String(layout.mode || "") === "unknown") return layout;
  if (mode === "text-layer" || mode === "local-ocr" || mode === "cloud-ocr") layout.mode = mode;
  return layout;
}

function layoutJudged(record, layout) {
  const mode = layoutRecordMode({
    ...record,
    layout: { ...layout, mode: layout.mode || record?.mode || "" }
  });
  return { layout: { ...layout, mode }, mode };
}

/** Current for this engine only. A text-layer row does not skip local-ocr zoning. */
export function layoutCurrentForEngine(record, version, engine) {
  const layout = storedLayoutCurrent(record, version);
  if (!layout) return null;
  const judged = layoutJudged(record, layout);
  if (!layoutServesEngine(judged, engine)) return null;
  return layout;
}

/** Same revision check as the cache. unknown and mode-less count as on main. */
export function layoutCurrentForLibrary(record, version, engine) {
  const layout = storedLayoutCurrent(record, version);
  if (!layout) return null;
  const judged = layoutJudged(record, layout);
  if (!layoutServesLibrary(judged, engine)) return null;
  return layout;
}

/**
 * One layout POST at a time. A priority page (the one on screen) skips ahead
 * of pages that are queued and not yet started.
 */
export function createPrioritySerialLane() {
  const inflight = new Map();
  const queue = [];
  let active = false;
  let generation = 0;

  function fail(entry) {
    if (inflight.get(entry.key) === entry.job) inflight.delete(entry.key);
    entry.reject(entry.abortError());
  }

  function pump() {
    if (active) return;
    const entry = queue.shift();
    if (!entry) return;
    if (entry.generation !== generation) {
      fail(entry);
      pump();
      return;
    }
    active = true;
    Promise.resolve()
      .then(() => entry.task())
      .then(
        (value) => {
          if (inflight.get(entry.key) === entry.job) inflight.delete(entry.key);
          entry.resolve(value);
        },
        (error) => {
          if (inflight.get(entry.key) === entry.job) inflight.delete(entry.key);
          entry.reject(error);
        }
      )
      .finally(() => {
        active = false;
        pump();
      });
  }

  return {
    reset() {
      generation += 1;
      for (const entry of queue.splice(0)) fail(entry);
    },
    run(key, task, { priority = false, abortError } = {}) {
      const id = String(key);
      const existing = inflight.get(id);
      if (existing) return existing;
      let resolve;
      let reject;
      const job = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const entry = {
        key: id,
        job,
        task,
        resolve,
        reject,
        generation,
        priority: Boolean(priority),
        abortError: typeof abortError === "function" ? abortError : () => {
          const error = new Error("layout aborted");
          error.name = "AbortError";
          error.code = "aborted";
          return error;
        }
      };
      inflight.set(id, job);
      if (entry.priority) {
        const at = queue.findIndex((item) => !item.priority);
        if (at < 0) queue.push(entry);
        else queue.splice(at, 0, entry);
      } else queue.push(entry);
      pump();
      return job;
    }
  };
}

/**
 * One POST holds the lane. The backoff between failures waits after the lane
 * is released, so the page on screen waits for at most the POST already running.
 */
export async function runLaneAttempts(lane, key, attempt, {
  priority = false,
  abortError,
  sleep,
  shouldStop
} = {}) {
  const wait = typeof sleep === "function"
    ? sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stop = typeof abortError === "function" ? abortError : () => {
    const error = new Error("layout aborted");
    error.name = "AbortError";
    error.code = "aborted";
    return error;
  };
  const attempts = LAYOUT_RETRY_DELAYS_MS.length + 1;
  let last = null;
  for (let index = 0; index < attempts; index += 1) {
    if (typeof shouldStop === "function" && shouldStop()) throw stop();
    try {
      return await lane.run(key, () => attempt(index), { priority, abortError: stop });
    } catch (error) {
      last = error;
      if (!layoutRetryable(error) || index === attempts - 1) throw error;
      await wait(LAYOUT_RETRY_DELAYS_MS[Math.min(index, LAYOUT_RETRY_DELAYS_MS.length - 1)]);
    }
  }
  throw last;
}

/** The page on screen is the only layout retry a document job should wait for. */
export function layoutRetrySplit(total, currentPage) {
  const current = Number(currentPage) || 0;
  const count = Math.max(0, Number(total) || 0);
  const blocking = [];
  const background = [];
  for (let page = 1; page <= count; page += 1) {
    if (page === current) blocking.push(page);
    else background.push(page);
  }
  return { blocking, background };
}

/**
 * The document job awaits only the page on screen, including its fill-in
 * translation. Other pages re-zone after that, and their new blocks are
 * translated when the re-zone finishes. That follow-up does not hold the job.
 */
export function startDocumentLayoutRetry({
  total,
  viewing,
  isStale,
  retryLayouts,
  adoptUpgraded
} = {}) {
  const split = layoutRetrySplit(total, viewing);
  const stale = () => (typeof isStale === "function" ? isStale() : false);
  const adopt = (upgraded, background) => {
    if (!upgraded?.length || typeof adoptUpgraded !== "function" || stale()) return Promise.resolve(upgraded || []);
    return Promise.resolve(adoptUpgraded(upgraded, { background })).then(() => upgraded);
  };
  const blocking = (async () => {
    if (!split.blocking.length || stale()) return [];
    const upgraded = await retryLayouts({ onlyPage: viewing });
    return adopt(upgraded, false);
  })();
  const background = blocking.then(async () => {
    if (!split.background.length || stale()) return [];
    const upgraded = await retryLayouts({ skipPage: viewing });
    return adopt(upgraded, true);
  }).catch((error) => {
    if (error?.name === "AbortError" || error?.code === "aborted") return [];
    throw error;
  });
  return { blocking, background };
}

/** Gaps before each retry of a 429/5xx layout call. The last value is the cap. */
export const LAYOUT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

function layoutRetryable(error) {
  if (!error) return false;
  if (error.name === "AbortError" || error.code === "aborted" || error.code === "no-boxes" || error.code === "empty-key") {
    return false;
  }
  const status = Number(error.status) || 0;
  if (status === 429 || status >= 500) return true;
  if (status >= 400) return false;
  return true;
}

function httpError(scope, status) {
  const error = new Error(`${scope} HTTP ${status}`);
  error.status = status;
  return error;
}

async function readErrorBody(res) {
  if (typeof res?.text !== "function") return "";
  try {
    return String(await res.text() || "");
  } catch {
    return "";
  }
}

async function errorFromResponse(scope, res) {
  const body = await readErrorBody(res);
  const error = httpError(scope, res?.status || 0);
  if (body) error.body = body.slice(0, 500);
  if (layoutNoBoxesMessage(body)) error.code = "no-boxes";
  return error;
}

/**
 * 429/5xx and network failures are retried with capped exponential backoff.
 * A 4xx other than 429 fails immediately. A 502 whose body says the layout
 * returned no boxes is that answer, not an outage, so it is not retried.
 * Abort is not retried. The caller still owes a transient failure another
 * attempt later.
 */
function layoutAbortError() {
  const error = new Error("layout aborted");
  error.name = "AbortError";
  error.code = "aborted";
  return error;
}

async function fetchEnvelopeRetrying({ label, run, sleep, onNetworkFailure, maxAttempts, signal, shouldStop }) {
  const wait = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const budget = Number(maxAttempts);
  const attempts = Number.isFinite(budget) && budget >= 1
    ? Math.floor(budget)
    : LAYOUT_RETRY_DELAYS_MS.length + 1;
  let last = null;
  let noted = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted || (typeof shouldStop === "function" && shouldStop())) throw layoutAbortError();
    try {
      const res = await run();
      if (!res?.ok) throw await errorFromResponse(label, res);
      return res.json();
    } catch (error) {
      last = error;
      const status = Number(error?.status) || 0;
      if (!noted && !status && error?.name !== "AbortError" && error?.code !== "aborted" && typeof onNetworkFailure === "function") {
        noted = true;
        try {
          onNetworkFailure(error);
        } catch {
          /* the notice must not stop the retry */
        }
      }
      if (!layoutRetryable(error) || attempt === attempts - 1) throw error;
      await wait(LAYOUT_RETRY_DELAYS_MS[Math.min(attempt, LAYOUT_RETRY_DELAYS_MS.length - 1)]);
    }
  }
  throw last;
}

export async function fetchLocalEnvelope({
  baseUrl = DEFAULT_LOCAL_BASE,
  page = 1,
  imageBase64 = "",
  pixelWidth = 0,
  pixelHeight = 0,
  // P-A whitelist: local layout keeps LAYOUT_RETRY_DELAYS_MS and the no-boxes rule.
  // Net's retry defaults would change those delays, so the default transport stays fetch.
  fetchImpl = fetch,
  sleep,
  signal,
  onNetworkFailure,
  maxAttempts,
  shouldStop
} = {}) {
  const root = String(baseUrl || DEFAULT_LOCAL_BASE).replace(/\/$/, "");
  return fetchEnvelopeRetrying({
    label: "local layout",
    sleep,
    onNetworkFailure,
    maxAttempts,
    signal,
    shouldStop,
    run: () => fetchImpl(`${root}/v1/layout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: PROTOCOL,
        page,
        imageBase64,
        pixelWidth,
        pixelHeight
      }),
      signal
    })
  });
}

export async function fetchCloudEnvelope({
  baseUrl = DEFAULT_CLOUD_BASE,
  apiKey = "",
  model = "glm-ocr",
  pngDataUrl = "",
  // P-A whitelist: cloud layout uses the same retry schedule and empty-key failure as local.
  fetchImpl = fetch,
  sleep,
  signal,
  onNetworkFailure,
  maxAttempts,
  shouldStop
} = {}) {
  if (!String(apiKey || "").trim()) {
    const err = new Error("cloud api key missing");
    err.code = "empty-key";
    throw err;
  }
  return fetchEnvelopeRetrying({
    label: "cloud layout",
    sleep,
    onNetworkFailure,
    maxAttempts,
    signal,
    shouldStop,
    run: () => fetchImpl(String(baseUrl || DEFAULT_CLOUD_BASE), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || "glm-ocr",
        file: pngDataUrl
      }),
      signal
    })
  });
}

export function cacheableLayout(page) {
  const stored = {
    protocol: page?.protocol || PROTOCOL,
    page: page?.page,
    textSource: page?.textSource || "text-layer",
    ...(page?.mode ? { mode: String(page.mode) } : {}),
    sourceAudit: page?.sourceAudit || null,
    ...(page?.layoutVersion ? { layoutVersion: String(page.layoutVersion) } : {}),
    ...(layoutFallbackOf(page) ? { fallback: layoutFallbackOf(page) } : {}),
    blocks: (page?.blocks || []).map((block) => {
      const next = { ...block };
      delete next.imageUrl;
      delete next.surface;
      delete next.formulaTier;
      delete next.formulaReason;
      delete next.assetCapPx;
      delete next.visualCropFailed;
      delete next.vendorText;
      delete next.content;
      delete next.latex;
      delete next.latexSource;
      delete next.verified;
      delete next.sourceUnitId;
      delete next.html;
      delete next.md;
      return next;
    })
  };
  return stored;
}
