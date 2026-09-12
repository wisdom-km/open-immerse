/** PDF Viewer V1 — page/document translate goes through OI_TRANSLATE_BATCH. */

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
  translatingWait: "正在翻译，请稍候…",
  translate: "翻译",
  stop: "停止",
  restore: "原文",
  translating: "翻译中",
  polishing: "润色中",
  polishFail: "润色失败",
  emptyPage: "本页没有可翻译的文字。",
  done: "本页已翻译。",
  doneDocument: "全文已翻译。",
  stopped: "已停止。",
  runtimeUnavailable: "请在扩展中打开此阅读器后再翻译。",
  scopeLabel: "范围",
  scopePage: "当前页",
  scopeDocument: "全文"
};

export const DEFAULT_PDF_TRANSLATE_SCOPE = "page";

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

export function progressDocumentStatus(page, total) {
  return `翻译中 · ${page}/${total}`;
}

/** Empty readout: idle hint, or in-progress wait. Hidden once any page has Chinese. */
export function readoutPlaceholder({ running, hasArticle } = {}) {
  if (hasArticle) return "";
  return running ? PDF_COPY.translatingWait : PDF_COPY.translateHint;
}

export function normalizePdfTranslateScope(value) {
  return value === "all" || value === "document" ? "all" : DEFAULT_PDF_TRANSLATE_SCOPE;
}

export function wheelPageDelta({ deltaY, atTop, atBottom, overflow } = {}) {
  if (overflow) return 0;
  if (Number(deltaY) > 0 && atBottom !== false) return 1;
  if (Number(deltaY) < 0 && atTop !== false) return -1;
  return 0;
}

export function pageHasTranslation(blocks) {
  return (blocks || []).some((item) => String(item?.translation || "").trim());
}

export function pageTranslationComplete(blocks) {
  const list = blocks || [];
  return list.length > 0 && list.every((item) => String(item?.translation || "").trim());
}

export function collectArticlePages(cache, docId, numPages) {
  const total = Math.max(0, Number(numPages) || 0);
  const out = [];
  for (let page = 1; page <= total; page++) {
    const blocks = cache?.get(docId, page);
    if (!pageHasTranslation(blocks)) continue;
    out.push({ page, blocks });
  }
  return out;
}

export function pageFromViewport(rects, viewportTop, viewportBottom) {
  const list = Array.isArray(rects) ? rects : [];
  if (!list.length) return 1;
  const mid = (Number(viewportTop) + Number(viewportBottom)) / 2;
  let best = list[0].page;
  let bestDist = Infinity;
  for (const rect of list) {
    const center = (Number(rect.top) + Number(rect.bottom)) / 2;
    const dist = Math.abs(center - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = rect.page;
    }
  }
  return best;
}

export function neighborPages(current, total, radius = 1) {
  const t = Math.max(1, Number(total) || 1);
  const c = Math.min(t, Math.max(1, Number(current) || 1));
  const r = Math.max(0, Number(radius) || 0);
  const out = [];
  for (let page = c - r; page <= c + r; page++) {
    if (page >= 1 && page <= t) out.push(page);
  }
  return out;
}

export function readoutPageSelector(page) {
  return `[data-page="${page}"]`;
}

export function shouldSyncReadout(nodeTop, paneTop, slop = 80) {
  if (!Number.isFinite(Number(nodeTop)) || !Number.isFinite(Number(paneTop))) return false;
  const top = Number(nodeTop);
  const origin = Number(paneTop);
  return top < origin - 4 || top > origin + slop;
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

export function normalizeBlockRole(role) {
  if (role === "title" || role === "h1") return "title";
  if (role === "heading" || role === "h2") return "heading";
  return "paragraph";
}

/** One article part: page title, section heading, or body paragraph. */
export function translationBlock({ original, translation, page, filename, role } = {}) {
  return {
    original: String(original || "").trim(),
    translation: String(translation || "").trim(),
    page: page == null ? "" : page,
    filename: String(filename || "").trim(),
    role: normalizeBlockRole(role)
  };
}

/** Map a translated block to a readout node (h1 / h2 / p). */
export function articleNodeSpec(block = {}) {
  const role = normalizeBlockRole(block.role);
  const text = String(block.translation || "").trim();
  if (role === "title") return { tag: "h1", className: "oi-pdf-h1", role, text };
  if (role === "heading") return { tag: "h2", className: "oi-pdf-h2", role, text };
  return { tag: "p", className: "oi-pdf-p", role: "paragraph", text };
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
    next[sliceStart + idx] = { ...(next[sliceStart + idx] || {}), original, translation };
  });
  return next;
}

export async function translatePageBlocks(originals, options = {}) {
  const units = normalizeTranslateUnits(originals);
  const texts = units.map((unit) => unit.original);
  const session = options.session || createTranslateSession();
  const send = options.send;
  const size = Math.max(1, Number(options.batchSize) || 8);
  const preserveSession = Boolean(options.preserveSession);
  const results = units.map((unit) => ({ original: unit.original, translation: "", role: unit.role }));
  session.running = true;
  if (!preserveSession) session.aborted = false;
  if (typeof send !== "function") {
    if (!preserveSession) session.running = false;
    return { ok: false, error: "runtime unavailable", results };
  }
  if (preserveSession && session.aborted) {
    return { ok: false, aborted: true, results };
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
        results[i + idx] = { original, translation, role: existing.role || units[i + idx].role };
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
    session.inflight = null;
    if (!preserveSession) session.running = false;
  }
}

export async function translateDocumentPages(options = {}) {
  const session = options.session || createTranslateSession();
  const cache = options.cache;
  const docId = options.docId;
  const numPages = Math.max(0, Number(options.numPages) || 0);
  const skipCached = options.skipCached !== false;
  const pages = [];
  session.running = true;
  session.aborted = false;
  try {
    for (let page = 1; page <= numPages; page++) {
      if (session.aborted) break;
      const cached = cache?.get(docId, page);
      if (skipCached && pageTranslationComplete(cached)) {
        pages.push({ page, results: cached, skipped: true });
        continue;
      }
      options.onPageStart?.({ page, total: numPages });
      const originals = (await options.getPageOriginals?.(page)) || [];
      if (session.aborted) break;
      if (!originals.length) {
        pages.push({ page, results: [], skipped: true });
        continue;
      }
      const { aborted, results } = await translatePageBlocks(originals, {
        send: options.send,
        session,
        batchSize: options.batchSize,
        preserveSession: true,
        requestIdFor: options.requestIdFor && ((index) => options.requestIdFor(page, index)),
        onBatchStart: options.onBatchStart,
        onBatchResult: (payload) => {
          cache?.set(docId, page, payload.results);
          options.onPageResult?.({ page, ...payload });
        }
      });
      cache?.set(docId, page, results);
      pages.push({ page, results, skipped: false });
      options.onPageDone?.({ page, results, aborted });
      if (aborted) break;
    }
    return { ok: !session.aborted, aborted: session.aborted, pages };
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
  return readingOrder(lines, splitX, pageWidth).filter((block) => (block.text || "").length > 1);
}

export function normalizeTranslateUnits(originals) {
  return (originals || [])
    .map((item) => {
      if (item && typeof item === "object") {
        return {
          original: String(item.text || item.original || "").trim(),
          role: normalizeBlockRole(item.role)
        };
      }
      return { original: String(item || "").trim(), role: "paragraph" };
    })
    .filter((item) => item.original);
}

function normalizePdfItem(item) {
  if (!item || typeof item !== "object") {
    return { str: "", x: 0, y: 0, width: 0, height: 0, hasEOL: false, bold: false };
  }
  const transform = Array.isArray(item.transform) ? item.transform : [];
  return {
    str: String(item.str || ""),
    x: Number.isFinite(Number(item.x)) ? Number(item.x) : Number(transform[4]) || 0,
    y: Number.isFinite(Number(item.y)) ? Number(item.y) : Number(transform[5]) || 0,
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    hasEOL: Boolean(item.hasEOL),
    bold: itemLooksBold(item)
  };
}

function itemLooksBold(item) {
  if (item?.bold === true) return true;
  const font = String(item?.fontName || "");
  return /bold|black|heavy|semibold/i.test(font);
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
    bold: sorted.some((item) => item.bold),
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
  const stats = pageLineStats(lines);
  if (splitX == null) return linesToParagraphs(lines, stats);
  const blocks = [];
  let left = [];
  let right = [];
  const flushCols = () => {
    blocks.push(...linesToParagraphs(left, stats));
    blocks.push(...linesToParagraphs(right, stats));
    left = [];
    right = [];
  };
  for (const line of lines) {
    const full = line.width > pageWidth * 0.6 && line.x < splitX && line.x + line.width > splitX;
    if (full) {
      flushCols();
      blocks.push(...linesToParagraphs([line], stats));
    } else if (line.x + line.width / 2 < splitX) {
      left.push(line);
    } else {
      right.push(line);
    }
  }
  flushCols();
  return blocks;
}

function pageLineStats(lines) {
  const heights = lines.map((line) => line.height).filter((h) => h > 0);
  const medianH = typicalHeight(heights);
  const leadings = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const lead = lines[i].y - lines[i + 1].y;
    if (lead > 0) leadings.push(lead);
  }
  leadings.sort((a, b) => a - b);
  const medianLead = leadings[Math.floor(leadings.length / 2)] || medianH * 1.2;
  const body = lines.filter((line) => line.height <= medianH * 1.45);
  const widths = body.map((line) => line.width).sort((a, b) => a - b);
  const medianW = widths[Math.floor(widths.length / 2)] || lines[0]?.width || 200;
  const maxH = Math.max(0, ...heights);
  return { medianH, medianW, medianLead, maxH };
}

function linesToParagraphs(lines, sharedStats) {
  if (!lines.length) return [];
  const stats = sharedStats || pageLineStats(lines);
  const { medianH, medianW, medianLead } = stats;
  const paras = [];
  let buf = [];
  const flush = (role) => {
    if (!buf.length) return;
    const text = joinHyphenated(buf.map((line) => line.text));
    if (text.length > 1) paras.push({ text, role: normalizeBlockRole(role) });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const role = headingRole(line, next, stats);
    const nextRole = next ? headingRole(next, lines[i + 2], stats) : "paragraph";
    buf.push(line);
    if (!next) {
      flush(role);
      break;
    }
    const gap = line.y - next.y;
    const largeGap = gap > medianLead * 1.45;
    const shortEnd = role === "paragraph" && line.width < medianW * 0.72 && /[.!?:]$/.test(line.text);
    const sameHeadingBand =
      role !== "paragraph" &&
      role === nextRole &&
      Math.abs(line.height - next.height) <= Math.max(1, medianH * 0.2);
    const keepHeading = sameHeadingBand && !largeGap;
    if (keepHeading) continue;
    if (largeGap || shortEnd || role !== "paragraph" || nextRole !== "paragraph") flush(role);
  }
  return paras;
}

function typicalHeight(heights) {
  const list = (heights || []).filter((h) => h > 0).sort((a, b) => a - b);
  if (!list.length) return 12;
  const counts = new Map();
  for (const h of list) {
    const key = Math.round(h);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = list[Math.floor(list.length / 2)];
  let bestN = 0;
  for (const [h, n] of counts) {
    if (n > bestN || (n === bestN && h < best)) {
      bestN = n;
      best = h;
    }
  }
  return best;
}

function headingRole(line, next, stats) {
  if (!isHeadingLine(line, next, stats)) return "paragraph";
  return isPageTitleLine(line, stats) ? "title" : "heading";
}

function isPageTitleLine(line, stats) {
  const { medianH, maxH } = stats;
  const words = line.text.split(/\s+/).filter(Boolean);
  const titleLike = words.length <= 14 && !/[.!?]$/.test(line.text);
  if (!titleLike) return false;
  const veryLarge = line.height > medianH * 1.55;
  const largest = maxH > 0 && line.height >= maxH * 0.95 && line.height > medianH * 1.35;
  return veryLarge || largest;
}

function isHeadingLine(line, next, stats) {
  const { medianH } = stats;
  if (!line?.text) return false;
  if (/[A-Za-z]-$/.test(line.text)) return false;
  if (/^[a-z]/.test(line.text)) return false;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(line.text)) return false;
  const endsSentence = /[.!?]$/.test(line.text);
  if (endsSentence && line.text.length > 40) return false;
  const words = line.text.split(/\s+/).filter(Boolean);
  const short = words.length <= 12 && line.text.length <= 72 && !endsSentence;
  const larger = line.height > medianH * 1.28;
  const allCaps = looksAllCaps(line.text);
  const cue = larger || line.bold || allCaps;
  if (cue && short) return true;
  if (cue && !endsSentence && words.length <= 14) return true;
  const nextIsLongBody = next && next.text.length >= 40 && !looksAllCaps(next.text) && next.height <= medianH * 1.15;
  return Boolean(short && nextIsLongBody && words.length <= 6);
}

function looksAllCaps(text) {
  const letters = String(text || "").replace(/[^A-Za-z\u4e00-\u9fff]/g, "");
  return letters.length >= 3 && letters === letters.toUpperCase() && /[A-Z]/.test(letters);
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
