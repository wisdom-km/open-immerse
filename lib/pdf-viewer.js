/** PDF Viewer V1 — current-page translate goes through OI_TRANSLATE_BATCH. */

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
  stop: "停止",
  restore: "原文",
  favorite: "收藏",
  translating: "翻译中",
  polishing: "润色中",
  polishFail: "润色失败",
  emptyPage: "本页没有可翻译的文字。",
  done: "本页已翻译。",
  stopped: "已停止。",
  runtimeUnavailable: "请在扩展中打开此阅读器后再翻译。"
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

export function pageBlocksCopy(blockCount, itemCount) {
  if (Number(itemCount) <= 0) return PDF_COPY.noTextLayer;
  if (Number(blockCount) <= 0) return PDF_COPY.emptyPage;
  return "";
}

export function progressStatus(k, n) {
  return `正在翻译第 ${k} / ${n} 段`;
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
  if (!fileBit && !pageBit) return "";
  return ["PDF", fileBit, pageBit].filter(Boolean).join(" · ");
}

export function favoriteSegmentItem({ original, translation, url, title, context, filename, page } = {}) {
  const loc = blockLocation({ filename, page });
  return {
    original: String(original || "").trim(),
    translation: String(translation || "").trim(),
    context: loc || String(context || original || "").trim(),
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

export function pageCacheKey(docId, page) {
  return `${docId}::${page}`;
}

export function createPageCache() {
  const map = new Map();
  return {
    get(docId, page) {
      return map.get(pageCacheKey(docId, page)) || null;
    },
    set(docId, page, blocks) {
      map.set(pageCacheKey(docId, page), blocks);
    },
    has(docId, page) {
      return map.has(pageCacheKey(docId, page));
    },
    clearPage(docId, page) {
      map.delete(pageCacheKey(docId, page));
    },
    clear() {
      map.clear();
    }
  };
}

export function createTranslateSession() {
  return { running: false, aborted: false, inflight: null };
}

export function abortTranslateSession(session) {
  if (!session) return;
  session.aborted = true;
}

export function shouldApplyDraft(session, message) {
  if (!session?.inflight || message?.phase !== "draft") return false;
  if (message.requestId && session.inflight.requestId && message.requestId !== session.inflight.requestId) {
    return false;
  }
  return true;
}

export function applyDraftTranslations(session, message, results) {
  if (!shouldApplyDraft(session, message)) return results;
  const translations = message.translations || [];
  const { slice, sliceStart } = session.inflight;
  const next = Array.isArray(results) ? results.slice() : [];
  (slice || []).forEach((original, idx) => {
    const translation = translations[idx] || "";
    if (!translation) return;
    next[sliceStart + idx] = { original, translation };
  });
  return next;
}

export async function translatePageBlocks(originals, options = {}) {
  const texts = (originals || []).map((text) => String(text || "").trim()).filter(Boolean);
  const session = options.session || createTranslateSession();
  const send = options.send;
  const size = Math.max(1, Number(options.batchSize) || 8);
  const results = texts.map((original) => ({ original, translation: "" }));
  session.running = true;
  session.aborted = false;
  if (typeof send !== "function") {
    session.running = false;
    return { ok: false, error: "runtime unavailable", results };
  }
  try {
    for (let i = 0; i < texts.length; i += size) {
      if (session.aborted) break;
      const slice = texts.slice(i, i + size);
      const requestId = options.requestIdFor?.(i) || `pdf-${i}-${Date.now()}`;
      session.inflight = { requestId, slice, sliceStart: i };
      options.onBatchStart?.({ index: i, total: texts.length, requestId, slice });
      let res = { ok: false, translations: [] };
      try {
        res = (await send({ type: "OI_TRANSLATE_BATCH", texts: slice, requestId })) || res;
      } catch (err) {
        res = { ok: false, translations: [], error: String(err?.message || err) };
      }
      if (session.inflight?.requestId === requestId) session.inflight = null;
      if (session.aborted) break;
      slice.forEach((original, idx) => {
        const existing = results[i + idx];
        const translation = res.translations?.[idx] || existing.translation || "";
        results[i + idx] = { original, translation };
      });
      options.onBatchResult?.({ results: results.slice(), res, sliceStart: i, requestId });
      if (res.error === "runtime unavailable") break;
    }
    return {
      ok: !session.aborted,
      aborted: session.aborted,
      results
    };
  } finally {
    session.running = false;
    session.inflight = null;
  }
}

export function extractPageItems(textContent) {
  return (textContent?.items || []).map(normalizePdfItem).filter((item) => item.str);
}

export function segmentPageBlocks(input) {
  const items = Array.isArray(input) ? input.map(normalizePdfItem).filter((item) => item.str) : extractPageItems(input);
  if (!items.length) return [];
  const splitX = detectItemColumnSplit(items);
  const lines = clusterLines(items, splitX);
  if (!lines.length) return [];
  const pageLeft = Math.min(...lines.map((line) => line.x));
  const pageRight = Math.max(...lines.map((line) => line.x + line.width));
  const pageWidth = Math.max(1, pageRight - pageLeft);
  return readingOrder(lines, splitX, pageWidth).filter((block) => block.length > 1);
}

function normalizePdfItem(item) {
  if (!item || typeof item !== "object") {
    return { str: "", x: 0, y: 0, width: 0, height: 0, hasEOL: false };
  }
  const transform = Array.isArray(item.transform) ? item.transform : [];
  return {
    str: String(item.str || ""),
    x: Number.isFinite(Number(item.x)) ? Number(item.x) : Number(transform[4]) || 0,
    y: Number.isFinite(Number(item.y)) ? Number(item.y) : Number(transform[5]) || 0,
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    hasEOL: Boolean(item.hasEOL)
  };
}

function detectItemColumnSplit(items) {
  if (items.length < 6) return null;
  const minX = Math.min(...items.map((item) => item.x));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const pageWidth = Math.max(1, maxX - minX);
  const gutters = [];
  for (const group of clusterYGroups(items)) {
    const sorted = [...group].sort((a, b) => a.x - b.x);
    if (sorted.length < 2) continue;
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width);
      const mid = sorted[i - 1].x + sorted[i - 1].width + gap / 2;
      const rel = (mid - minX) / pageWidth;
      if (rel > 0.25 && rel < 0.75) gaps.push({ gap, mid });
    }
    if (!gaps.length) continue;
    gaps.sort((a, b) => b.gap - a.gap);
    const top = gaps[0];
    const second = gaps[1]?.gap || 0;
    if (top.gap > Math.max(16, pageWidth * 0.045) && top.gap > second * 1.5) gutters.push(top.mid);
  }
  if (gutters.length < 2) return null;
  const sorted = [...gutters].sort((a, b) => a - b);
  let best = 0;
  let splitX = null;
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j < sorted.length && sorted[j] - sorted[i] <= 24) j += 1;
    const count = j - i;
    if (count > best) {
      best = count;
      const slice = sorted.slice(i, j);
      splitX = slice.reduce((sum, value) => sum + value, 0) / slice.length;
    }
  }
  return best >= 2 ? splitX : null;
}

function clusterYGroups(items) {
  const sorted = [...items].sort((a, b) => {
    const tol = Math.max(2, Math.max(a.height || 0, b.height || 0) * 0.45);
    if (Math.abs(a.y - b.y) > tol) return b.y - a.y;
    return a.x - b.x;
  });
  const groups = [];
  let bucket = [];
  let y = null;
  let height = 0;
  for (const item of sorted) {
    const tol = Math.max(2, (item.height || height || 10) * 0.45);
    if (y == null || Math.abs(item.y - y) <= tol) {
      bucket.push(item);
      y = y == null ? item.y : (y * (bucket.length - 1) + item.y) / bucket.length;
      height = Math.max(height, item.height || 0);
    } else {
      groups.push(bucket);
      bucket = [item];
      y = item.y;
      height = item.height || 0;
    }
  }
  if (bucket.length) groups.push(bucket);
  return groups;
}

function clusterLines(items, splitX = null) {
  const sorted = [...items].sort((a, b) => {
    const tol = Math.max(2, Math.max(a.height || 0, b.height || 0) * 0.45);
    if (Math.abs(a.y - b.y) > tol) return b.y - a.y;
    return a.x - b.x;
  });
  const lines = [];
  let bucket = [];
  let y = null;
  let height = 0;
  const flush = () => {
    if (!bucket.length) return;
    splitLineBucket(bucket, splitX).forEach((part) => lines.push(finalizeLine(part)));
    bucket = [];
    y = null;
    height = 0;
  };
  for (const item of sorted) {
    const tol = Math.max(2, (item.height || height || 10) * 0.45);
    if (y == null || Math.abs(item.y - y) <= tol) {
      bucket.push(item);
      y = y == null ? item.y : (y * (bucket.length - 1) + item.y) / bucket.length;
      height = Math.max(height, item.height || 0);
    } else {
      flush();
      bucket.push(item);
      y = item.y;
      height = item.height || 0;
    }
  }
  flush();
  return lines.filter((line) => line.text);
}

function finalizeLine(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let text = "";
  let prev = null;
  for (const item of sorted) {
    if (prev) {
      const gap = item.x - (prev.x + prev.width);
      const spaceWidth = Math.max(prev.height || 0, item.height || 0, 8) * 0.22;
      if (gap > spaceWidth && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
    }
    text += item.str;
    prev = item;
  }
  return {
    text: text.replace(/\s+/g, " ").trim(),
    x: Math.min(...sorted.map((item) => item.x)),
    y: median(sorted.map((item) => item.y)),
    width: Math.max(...sorted.map((item) => item.x + item.width)) - Math.min(...sorted.map((item) => item.x)),
    height: Math.max(...sorted.map((item) => item.height || 0)),
    items: sorted
  };
}

function splitLineBucket(items, splitX) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  if (sorted.length < 2) return [sorted];
  if (splitX != null) {
    const left = sorted.filter((item) => item.x + item.width / 2 < splitX);
    const right = sorted.filter((item) => item.x + item.width / 2 >= splitX);
    return [left, right].filter((part) => part.length);
  }
  const minX = sorted[0].x;
  const maxX = Math.max(...sorted.map((item) => item.x + item.width));
  const width = Math.max(1, maxX - minX);
  let bestGap = 0;
  let at = -1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width);
    if (gap > bestGap) {
      bestGap = gap;
      at = i;
    }
  }
  if (at > 0 && bestGap > Math.max(20, width * 0.1)) {
    return [sorted.slice(0, at), sorted.slice(at)];
  }
  return [sorted];
}

function readingOrder(lines, splitX, pageWidth) {
  if (splitX == null) return linesToParagraphs(lines);
  const blocks = [];
  let left = [];
  let right = [];
  const flushCols = () => {
    blocks.push(...linesToParagraphs(left));
    blocks.push(...linesToParagraphs(right));
    left = [];
    right = [];
  };
  for (const line of lines) {
    const full = line.width > pageWidth * 0.6 && line.x < splitX && line.x + line.width > splitX;
    if (full) {
      flushCols();
      blocks.push(...linesToParagraphs([line]));
    } else if (line.x + line.width / 2 < splitX) {
      left.push(line);
    } else {
      right.push(line);
    }
  }
  flushCols();
  return blocks;
}

function linesToParagraphs(lines) {
  if (!lines.length) return [];
  const heights = lines.map((line) => line.height).filter((h) => h > 0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 12;
  const leadings = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const lead = lines[i].y - lines[i + 1].y;
    if (lead > 0) leadings.push(lead);
  }
  leadings.sort((a, b) => a - b);
  const medianLead = leadings[Math.floor(leadings.length / 2)] || medianH * 1.2;
  const body = lines.filter((line) => line.height <= medianH * 1.45);
  const widths = body.map((line) => line.width).sort((a, b) => a - b);
  const medianW = widths[Math.floor(widths.length / 2)] || lines[0].width || 200;
  const paras = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const text = joinHyphenated(buf.map((line) => line.text));
    if (text.length > 1) paras.push(text);
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    buf.push(line);
    if (!next) {
      flush();
      break;
    }
    const gap = line.y - next.y;
    const largeGap = gap > medianLead * 1.45;
    const shortEnd = line.width < medianW * 0.72 && /[.!?:]$/.test(line.text);
    const heading = line.height > medianH * 1.35;
    const nextHeading = next.height > medianH * 1.35;
    if (largeGap || shortEnd || heading || nextHeading) flush();
  }
  return paras;
}

function joinHyphenated(lineTexts) {
  let out = "";
  for (let i = 0; i < lineTexts.length; i++) {
    const line = lineTexts[i];
    const next = lineTexts[i + 1];
    if (next && /[A-Za-z]-$/.test(line) && /^[a-z]/.test(next)) out += line.slice(0, -1);
    else {
      out += line;
      if (next) out += " ";
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

function median(values) {
  const list = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return 0;
  return list[Math.floor(list.length / 2)];
}
