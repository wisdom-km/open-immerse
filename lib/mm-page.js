/**
 * Page-level multimodal reconstruction (pipeline mp-1).
 * The API key is forwarded only into sendVision. This module does not log it.
 * Diagnostics receive counts and reason codes only.
 */

import { FORMULA_PIPELINE_VERSION } from "./formula-pipeline.js";
import { layoutCacheKey } from "./pdf-layout-client.js";
import { GLYPH_GAP_MARK } from "./pdf-glyph-sanitize.js";
import { mmConfigFingerprint } from "./formula-tiers/multimodal.js";
import { ARK_PLAN_BASE_URL, multimodalProvider, normalizeFormulaSettings } from "./formula-settings.js";
import { multimodalTarget } from "./mm-client.js";

export const PAGE_PIPELINE_VERSION = "mp-1";
export const MM_PAGE_MODE = "mm-page";
export const MM_PAGE_TIMEOUT_MS = 90_000;
/** A plain-text retry needs this much of the page budget left, or the page falls back. */
export const MM_PAGE_RETRY_MIN_MS = 35_000;
export const MM_PAGE_COVERAGE_MIN = 0.85;
export const MM_PAGE_MAX_EDGE = 2000;

/** Cache stamp. A model change is recorded on the row and does not change this key. */
export function mmPageCachePipeline() {
  return `${PAGE_PIPELINE_VERSION}+${FORMULA_PIPELINE_VERSION}`;
}

export function mmPageCacheKey({ hash, page }) {
  return layoutCacheKey({
    hash,
    page,
    mode: MM_PAGE_MODE,
    pipeline: mmPageCachePipeline()
  });
}

/**
 * Spike hosts. Product calls use the saved multimodal card.
 * Ark is the default Kimi host; Moonshot is the backup configuration.
 */
export const MM_PAGE_SPIKE_HOSTS = Object.freeze({
  ark: Object.freeze({
    provider: "kimi",
    model: "kimi-k3",
    baseUrl: ARK_PLAN_BASE_URL
  }),
  moonshot: Object.freeze({
    provider: "kimi",
    model: "kimi-k3",
    baseUrl: "https://api.moonshot.cn/v1"
  })
});

const PAGE_LABELS = new Set([
  "heading",
  "text",
  "caption",
  "formula",
  "figure",
  "table",
  "footnote",
  "header",
  "footer",
  "aside"
]);

const REQUEST_REASONS = new Set([
  "401",
  "403",
  "404",
  "429",
  "http",
  "network",
  "no-vision",
  "empty-key"
]);

export function mmPageConfigured(settings) {
  const stored = normalizeFormulaSettings(settings);
  const provider = multimodalProvider(stored.multimodal.provider);
  if (!provider || provider.vision !== true) return false;
  if (!String(stored.multimodal.apiKey || "").trim()) return false;
  return multimodalTarget(stored).ok === true;
}

export function mmPageFingerprint(settings) {
  try {
    return mmConfigFingerprint(settings);
  } catch {
    return "";
  }
}

export function isCurrentMmPage(layout) {
  return String(layout?.mode || "") === MM_PAGE_MODE
    && String(layout?.pagePipeline || "") === PAGE_PIPELINE_VERSION;
}

/**
 * A translated page from text-layer / fp-1 stays on screen.
 * It is not an mp-1 hit, and a fallback row is not held (the next open retries).
 */
export function legacyPageShouldHold(layout, { force = false, hasTranslation = false } = {}) {
  if (force || !hasTranslation) return false;
  if (!layout || !Array.isArray(layout.blocks) || !layout.blocks.length) return false;
  if (isCurrentMmPage(layout)) return false;
  if (layout.fallback) return false;
  return true;
}

export function mmPageScheduleOrder(pages, visible) {
  const focus = Number(visible) || 0;
  const band = (page) => {
    const distance = Math.abs(Number(page) - focus);
    if (distance === 0) return 0;
    if (distance <= 2) return 1;
    return 2;
  };
  return [...(pages || [])].sort((a, b) => {
    const byBand = band(a) - band(b);
    if (byBand) return byBand;
    const byDistance = Math.abs(a - focus) - Math.abs(b - focus);
    if (byDistance) return byDistance;
    return Number(a) - Number(b);
  });
}

export function scaleToMaxEdge(width, height, maxEdge = MM_PAGE_MAX_EDGE) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const cap = Number(maxEdge) || MM_PAGE_MAX_EDGE;
  if (w < 1 || h < 1) return { width: w, height: h, scale: 1 };
  const edge = Math.max(w, h);
  if (edge <= cap) return { width: Math.round(w), height: Math.round(h), scale: 1 };
  const scale = cap / edge;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale
  };
}

export function pageVisionPrompt({ page = 1, columns = 0, text = "" } = {}) {
  const hint = String(text || "").slice(0, 8000);
  const cols = Number(columns) > 0 ? String(columns) : "未知";
  return {
    system: [
      "你是版面读取器。只输出一个 JSON 对象，不要 Markdown，不要解释。",
      `对象形如 {"v":"${PAGE_PIPELINE_VERSION}","columns":1,"blocks":[{"id":"b1","label":"heading|text|caption|formula|figure|table|footnote|header|aside","bbox":[0,0,1,1],"order":1,"continues":false,"text":"","latex":"","conf":0}]}`,
      "bbox 是相对整页的 0 到 1，阅读顺序用 order，从 1 起连续编号。",
      "侧栏、方框、页边元数据和脚注标 aside 或 footnote，不要插进正文中间。",
      "continues 为 true 表示这一块接着上一块，或接着上一页最后一个正文块。",
      "行内公式写在 text 里，用 $...$。只有 label 为 formula 的块填写 latex。",
      `文字层仅供参考，可能有缺字 ${GLYPH_GAP_MARK}。以图像为准，不要编造图里没有的句子。`
    ].join("\n"),
    text: `第 ${Number(page) || 1} 页。栏数提示：${cols}。\n文字层参考：\n${hint}`
  };
}

export function pageVisionRetryText(prompt) {
  return `${prompt?.text || ""}\n上一次不是合法 JSON。只输出 JSON 对象，不要 Markdown。`;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function clampBbox(raw) {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const coords = raw.slice(0, 4).map(clamp01);
  if (coords.some((item) => item == null)) return null;
  const x0 = Math.min(coords[0], coords[2]);
  const x1 = Math.max(coords[0], coords[2]);
  const y0 = Math.min(coords[1], coords[3]);
  const y1 = Math.max(coords[1], coords[3]);
  return [x0, y0, x1, y1];
}

function mapLabel(value) {
  const label = String(value || "").trim().toLowerCase();
  if (label === "title") return "heading";
  if (PAGE_LABELS.has(label)) return label;
  return "text";
}

function stripFence(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : raw;
}

export function parsePageJson(text) {
  const body = stripFence(text);
  if (!body) return { ok: false, reason: "parse" };
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, reason: "parse" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: "parse" };
  const blocksIn = Array.isArray(data.blocks) ? data.blocks : null;
  if (!blocksIn) return { ok: false, reason: "parse" };
  const blocks = [];
  const seenOrder = new Set();
  for (let index = 0; index < blocksIn.length; index += 1) {
    const row = blocksIn[index];
    if (!row || typeof row !== "object") return { ok: false, reason: "parse" };
    let order = Number(row.order);
    if (!Number.isFinite(order)) order = index + 1;
    order = Math.floor(order);
    if (seenOrder.has(order)) return { ok: false, reason: "parse" };
    seenOrder.add(order);
    const bbox = clampBbox(row.bbox);
    const label = mapLabel(row.label);
    const block = {
      id: String(row.id || `b${index + 1}`),
      label,
      order,
      text: label === "formula" || label === "figure" || label === "table" ? "" : String(row.text || ""),
      conf: Number.isFinite(Number(row.conf)) ? Number(row.conf) : null
    };
    if (bbox) block.bbox = bbox;
    if (label === "formula" && row.latex) block.latex = String(row.latex);
    if (label === "footnote") block.role = "footnote";
    if (label === "aside") block.role = "aside";
    if (row.continues === true || row.continuesFromPrev === true) block.continues = true;
    blocks.push(block);
  }
  blocks.sort((a, b) => a.order - b.order);
  blocks.forEach((block, index) => {
    block.order = index + 1;
  });
  const columns = Math.max(0, Math.floor(Number(data.columns) || 0));
  return {
    ok: true,
    page: {
      v: PAGE_PIPELINE_VERSION,
      columns,
      blocks
    }
  };
}

function countableChars(text) {
  return String(text || "").replace(new RegExp(GLYPH_GAP_MARK, "g"), "").replace(/\s+/g, "");
}

export function pageTextCoverage(mmBlocks, textLayerText) {
  const layer = countableChars(textLayerText);
  if (!layer.length) return 1;
  const mm = countableChars((mmBlocks || []).map((block) => block.text || block.latex || "").join(""));
  return mm.length / layer.length;
}

export function attachMissingBbox(mmBlocks, textBlocks) {
  const donors = (textBlocks || []).filter((block) => Array.isArray(block?.bbox));
  return (mmBlocks || []).map((block) => {
    if (Array.isArray(block.bbox) || !donors.length) return block;
    const needle = String(block.text || "").replace(/\s+/g, " ").trim();
    const donor = donors.find((item) => needle && String(item.text || "").includes(needle.slice(0, 24)));
    if (!donor) return block;
    return { ...block, bbox: donor.bbox.slice(0, 4) };
  });
}

export function formulaLatexCandidates(blocks) {
  const out = [];
  for (const block of blocks || []) {
    if (block?.label !== "formula") continue;
    const latex = String(block.latex || "").trim();
    if (!latex) continue;
    out.push({
      id: String(block.id || ""),
      bbox: Array.isArray(block.bbox) ? block.bbox.slice(0, 4) : null,
      latex
    });
  }
  return out;
}

export function mmPageReason(code) {
  const token = String(code || "");
  if (token === "timeout") return "timeout";
  if (token === "empty-key" || token === "not-configured") return "not-configured";
  if (token === "aborted") return "aborted";
  if (token === "parse" || token === "coverage") return token;
  if (REQUEST_REASONS.has(token)) return token;
  return token || "http";
}

export function mmPageReasonIsRequest(reason) {
  return REQUEST_REASONS.has(String(reason || "")) && reason !== "empty-key";
}

function linkAbort(signal, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    timedOut() {
      return ctrl.signal.aborted && !signal?.aborted;
    },
    done() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  };
}

/**
 * One page vision call, plus one plain-text retry when the first body is not JSON.
 * The 90s budget is per page and covers both calls. A retry is skipped when
 * less than 35s remain. callMs / retryMs are durations only. The key stays in sendVision.
 */
export async function runMmPage({
  pngBase64,
  text = "",
  page = 1,
  columns = 0,
  target,
  sendVision,
  signal,
  timeoutMs = MM_PAGE_TIMEOUT_MS,
  configured = true,
  outputLimit = 8192,
  readSecret,
  secret,
  now = Date.now
} = {}) {
  if (configured === false) return { ok: false, reason: "not-configured" };
  if (typeof sendVision !== "function") return { ok: false, reason: "not-configured" };
  if (!pngBase64) return { ok: false, reason: "http" };
  const prompt = pageVisionPrompt({ page, columns, text });
  const budget = linkAbort(signal, timeoutMs);
  const clock = typeof now === "function" ? now : Date.now;
  const started = clock();
  const elapsed = () => Math.max(0, clock() - started);
  const sendOnce = (userText) => sendVision({
    target,
    system: prompt.system,
    text: userText,
    images: [{ mime: "image/png", base64: String(pngBase64).replace(/^data:image\/png;base64,/, "") }],
    signal: budget.signal,
    purpose: "multimodal",
    outputLimit,
    readSecret,
    secret
  });
  const untilAbort = () => new Promise((_, reject) => {
    if (budget.signal.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    budget.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
  const sendRaced = async (userText) => {
    const at = clock();
    const response = await Promise.race([sendOnce(userText), untilAbort()]);
    return { response, ms: Math.max(0, clock() - at) };
  };
  const timing = {};
  const withTiming = (body) => ({ ...body, ...timing });
  try {
    const first = await sendRaced(prompt.text);
    timing.callMs = first.ms;
    let response = first.response;
    if (!response || response.ok !== true) {
      const code = response?.error?.code || "http";
      if (budget.timedOut() || code === "timeout") return withTiming({ ok: false, reason: "timeout" });
      if (code === "aborted" || signal?.aborted) return withTiming({ ok: false, reason: "aborted" });
      return withTiming({ ok: false, reason: mmPageReason(code) });
    }
    let parsed = parsePageJson(response.text);
    if (!parsed.ok && !budget.signal.aborted) {
      if (timeoutMs - elapsed() < MM_PAGE_RETRY_MIN_MS) return withTiming({ ok: false, reason: "timeout" });
      const second = await sendRaced(pageVisionRetryText(prompt));
      timing.retryMs = second.ms;
      response = second.response;
      if (!response || response.ok !== true) {
        const code = response?.error?.code || "http";
        if (budget.timedOut() || code === "timeout") return withTiming({ ok: false, reason: "timeout" });
        if (code === "aborted" || signal?.aborted) return withTiming({ ok: false, reason: "aborted" });
        return withTiming({ ok: false, reason: mmPageReason(code) });
      }
      parsed = parsePageJson(response.text);
    }
    if (budget.timedOut()) return withTiming({ ok: false, reason: "timeout" });
    if (signal?.aborted) return withTiming({ ok: false, reason: "aborted" });
    if (!parsed.ok) return withTiming({ ok: false, reason: "parse" });
    const coverage = pageTextCoverage(parsed.page.blocks, text);
    if (coverage < MM_PAGE_COVERAGE_MIN) return withTiming({ ok: false, reason: "coverage", coverage });
    return withTiming({ ok: true, page: parsed.page, coverage });
  } catch (err) {
    if (budget.timedOut()) return withTiming({ ok: false, reason: "timeout" });
    if (signal?.aborted || err?.name === "AbortError") return withTiming({ ok: false, reason: "aborted" });
    return withTiming({ ok: false, reason: "http" });
  } finally {
    budget.done();
  }
}
