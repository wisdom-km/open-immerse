/** PDF Viewer V1 — M1 helpers. Translate batches stay on OI_TRANSLATE_BATCH in M2. */

export const PDF_COPY = {
  title: "PDF 阅读",
  openInImmerse: "在沉浸译中打开",
  openFile: "打开 PDF",
  loading: "正在打开 PDF…",
  empty: "还没有打开 PDF。",
  error: "无法打开这个 PDF。",
  fetchFail: "无法从此地址读取 PDF，请改用本地文件。",
  noTextLayer: "本页没有文字层。",
  noTextLayerHint: "扫描件翻译将在后续版本支持。",
  translateHint: "点击翻译",
  translate: "翻译",
  favorite: "收藏本段"
};

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.25;
export const DEFAULT_ZOOM = 1;

export function clampZoom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_ZOOM;
  const snapped = Math.round(n / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(snapped.toFixed(2))));
}

export function nextZoom(current, dir) {
  return clampZoom(Number(current) + (Number(dir) || 0) * ZOOM_STEP);
}

export function pageIndex(current, total, dir) {
  const t = Math.max(1, Number(total) || 1);
  const c = Math.min(t, Math.max(1, Number(current) || 1));
  return Math.min(t, Math.max(1, c + (Number(dir) || 0)));
}

export function pageLabel(current, total) {
  return `${current} / ${total}`;
}

export function zoomLabel(scale) {
  return `${Math.round(clampZoom(scale) * 100)}%`;
}

export function textLayerCopy(itemCount) {
  return Number(itemCount) > 0 ? "" : PDF_COPY.noTextLayer;
}

export function looksLikePdfUrl(url) {
  if (!url || typeof url !== "string") return false;
  const raw = url.trim();
  if (!raw) return false;
  if (/^data:application\/pdf/i.test(raw)) return true;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "chrome-extension:" && parsed.hostname === "mhjfbmdgcfjbbpaeojofohoefgiehjai") {
      return true;
    }
    const path = decodeURIComponent(parsed.pathname).toLowerCase();
    if (path.endsWith(".pdf")) return true;
    for (const key of ["filename", "file", "name"]) {
      if (/\.pdf$/i.test(parsed.searchParams.get(key) || "")) return true;
    }
    return /\.pdf(?:$|[?#])/i.test(parsed.href);
  } catch {
    return /\.pdf(?:$|[?#])/i.test(raw);
  }
}

export function isPdfViewerPage(url) {
  const raw = String(url || "");
  try {
    const path = new URL(raw).pathname;
    return path.endsWith("/pdf/viewer.html") || path.endsWith("pdf/viewer.html");
  } catch {
    return /pdf\/viewer\.html/i.test(raw);
  }
}

export function shouldOfferPdfOpen(url) {
  return looksLikePdfUrl(url) && !isPdfViewerPage(url);
}

export function viewerSearch(src) {
  const url = String(src || "").trim();
  return url ? `?src=${encodeURIComponent(url)}` : "";
}

export function readViewerSrc(search) {
  const query = String(search || "").replace(/^\?/, "");
  return new URLSearchParams(query).get("src") || "";
}

export function blockLocation({ filename, page } = {}) {
  const fileBit = String(filename || "").trim();
  const pageBit = page == null || page === "" ? "" : `p.${page}`;
  return [fileBit, pageBit].filter(Boolean).join(" ");
}

export function favoriteSegmentItem({ original, translation, url, title, context, filename, page } = {}) {
  const loc = blockLocation({ filename, page });
  return {
    original: String(original || "").trim(),
    translation: String(translation || "").trim(),
    context: String(context || loc || original || "").trim(),
    url: url || "",
    title: title || loc
  };
}

/** M2/M3: one translation block in the right pane, each with its own 收藏本段. */
export function translationBlock({ original, translation, page, filename } = {}) {
  return {
    original: String(original || "").trim(),
    translation: String(translation || "").trim(),
    page: page == null ? "" : page,
    filename: String(filename || "").trim()
  };
}

/** M2 hook: save a translated PDF block through the existing learning API. */
export async function favoriteSegment(item, send = globalThis.chrome?.runtime?.sendMessage) {
  const payload = favoriteSegmentItem(item);
  if (!payload.original) return { ok: false, error: "缺少原文" };
  if (typeof send !== "function") return { ok: false, error: "runtime unavailable" };
  return send({ type: "OI_SAVE_LEARNING", item: payload });
}

export function pagePath(page) {
  if (page === "documents") return "documents/documents.html";
  if (page === "learning") return "learning/learning.html";
  if (page === "pdf") return "pdf/viewer.html";
  return "";
}
