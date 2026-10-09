/** Layout HTTP. The viewer calls these. Both modes return a vendor envelope, then one mapper. */

import { PROTOCOL } from "./pdf-blocks.js";

export const LAYOUT_FALLBACK_STATUS = "划区服务不可用，已使用文字层";
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

/** A saved layout is current only when its revision matches and it has blocks. */
export function storedLayoutCurrent(record, version) {
  if (!record || !version) return null;
  const layout = Array.isArray(record.blocks) ? record : record.layout;
  if (!layout || !Array.isArray(layout.blocks) || !layout.blocks.length) return null;
  const found = String(layout.layoutVersion || record.layoutVersion || "");
  return found === version ? layout : null;
}

/** Gaps before each retry of a 429/5xx layout call. The last value is the cap. */
export const LAYOUT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

function layoutRetryable(error) {
  const status = Number(error?.status) || 0;
  if (status === 429 || status >= 500) return true;
  if (status >= 400) return false;
  return true;
}

function httpError(scope, status) {
  const error = new Error(`${scope} HTTP ${status}`);
  error.status = status;
  return error;
}

/**
 * 429/5xx and network failures are retried with capped exponential backoff.
 * A 4xx other than 429 fails immediately. The caller still owes unfinished
 * pages another attempt later in the session.
 */
async function fetchEnvelopeRetrying({ label, run, sleep }) {
  const wait = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const attempts = LAYOUT_RETRY_DELAYS_MS.length + 1;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await run();
      if (!res?.ok) throw httpError(label, res?.status || 0);
      return res.json();
    } catch (error) {
      last = error;
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
  fetchImpl = fetch,
  sleep
} = {}) {
  const root = String(baseUrl || DEFAULT_LOCAL_BASE).replace(/\/$/, "");
  return fetchEnvelopeRetrying({
    label: "local layout",
    sleep,
    run: () => fetchImpl(`${root}/v1/layout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol: PROTOCOL,
        page,
        imageBase64,
        pixelWidth,
        pixelHeight
      })
    })
  });
}

export async function fetchCloudEnvelope({
  baseUrl = DEFAULT_CLOUD_BASE,
  apiKey = "",
  model = "glm-ocr",
  pngDataUrl = "",
  fetchImpl = fetch,
  sleep
} = {}) {
  if (!String(apiKey || "").trim()) {
    const err = new Error("cloud api key missing");
    err.code = "empty-key";
    throw err;
  }
  return fetchEnvelopeRetrying({
    label: "cloud layout",
    sleep,
    run: () => fetchImpl(String(baseUrl || DEFAULT_CLOUD_BASE), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || "glm-ocr",
        file: pngDataUrl
      })
    })
  });
}

export function cacheableLayout(page) {
  const stored = {
    protocol: page?.protocol || PROTOCOL,
    page: page?.page,
    textSource: page?.textSource || "text-layer",
    sourceAudit: page?.sourceAudit || null,
    ...(page?.layoutVersion ? { layoutVersion: String(page.layoutVersion) } : {}),
    blocks: (page?.blocks || []).map((block) => {
      const next = { ...block };
      delete next.imageUrl;
      delete next.surface;
      delete next.assetCapPx;
      delete next.vendorText;
      delete next.content;
      delete next.latex;
      delete next.html;
      delete next.md;
      return next;
    })
  };
  return stored;
}
