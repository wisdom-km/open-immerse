/** Layout HTTP. The viewer calls these. Both modes return a vendor envelope, then one mapper. */

import { PROTOCOL } from "./pdf-blocks.js";

export const LAYOUT_FALLBACK_STATUS = "划区服务不可用，已使用文字层";
export const LAYOUT_EMPTY_KEY_STATUS = "云端密钥为空，已使用文字层";

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

/** Empty mode tries the local GLM-OCR base first. A saved mode is used as written. */
export function resolveLayoutMode(layout, override = "") {
  if (OVERRIDES.has(override)) return override;
  const normalized = normalizePdfLayout(layout);
  return normalized.mode || "local-ocr";
}

export function shouldFetchCloud(layout) {
  return Boolean(normalizePdfLayout(layout).cloudApiKey.trim());
}

export function layoutCacheKey({ hash, page, mode }) {
  return `oi-pdf-layout:${hash}:${page}:${mode}:${PROTOCOL}`;
}

export async function fetchLocalEnvelope({
  baseUrl = DEFAULT_LOCAL_BASE,
  page = 1,
  imageBase64 = "",
  pixelWidth = 0,
  pixelHeight = 0,
  fetchImpl = fetch
} = {}) {
  const root = String(baseUrl || DEFAULT_LOCAL_BASE).replace(/\/$/, "");
  const res = await fetchImpl(`${root}/v1/layout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocol: PROTOCOL,
      page,
      imageBase64,
      pixelWidth,
      pixelHeight
    })
  });
  if (!res.ok) throw new Error(`local layout HTTP ${res.status}`);
  return res.json();
}

export async function fetchCloudEnvelope({
  baseUrl = DEFAULT_CLOUD_BASE,
  apiKey = "",
  model = "glm-ocr",
  pngDataUrl = "",
  fetchImpl = fetch
} = {}) {
  if (!String(apiKey || "").trim()) {
    const err = new Error("cloud api key missing");
    err.code = "empty-key";
    throw err;
  }
  const res = await fetchImpl(String(baseUrl || DEFAULT_CLOUD_BASE), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || "glm-ocr",
      file: pngDataUrl
    })
  });
  if (!res.ok) throw new Error(`cloud layout HTTP ${res.status}`);
  return res.json();
}

export function cacheableLayout(page) {
  return {
    protocol: page?.protocol || PROTOCOL,
    page: page?.page,
    textSource: page?.textSource || "text-layer",
    blocks: (page?.blocks || []).map((block) => {
      const next = { ...block };
      delete next.imageUrl;
      delete next.vendorText;
      delete next.content;
      delete next.latex;
      delete next.html;
      delete next.md;
      return next;
    })
  };
}
