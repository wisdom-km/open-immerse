/**
 * Tier-0 session for the right pane.
 * Turns a downloaded arXiv source into an alignment, then decides which
 * formulas can be placed. No network, and no process / Buffer / require.
 */

import { parseLatexSource } from "./latex-units.js";
import { alignSourceToBlocks } from "./source-align.js";

export const ARXIV_SOURCE_AUTO_KEY = "arxivSourceAuto";
export const ARXIV_SOURCE_SKIP_KEY = "arxivSourceSkip";
export const ARXIV_SOURCE_ON_KEY = "arxivSourceOn";

const FAIL_PHRASE = Object.freeze({
  timeout: "超时",
  error: "下载失败",
  http: "下载失败",
  offline: "离线",
  unpack: "无法解析源码",
  "session-failed": "请稍后再试",
  cooldown: "请稍后再试",
  "pdf-only": "此编号无源码",
  "plain-tex": "无法解析源码",
  "no-main": "无法解析源码",
  "multiple-main": "无法解析源码",
  "doc-align-low": "对齐不足",
  "alignment-below-85": "对齐不足"
  // Decision A does not emit version-mismatch or version-uncertain.
});

const PLACEHOLDER_ONLY = /^(?:\s*⟦f\d+⟧\s*)+$/;

export function versionLabel(version) {
  const raw = String(version || "").trim();
  if (!raw) return "";
  return /^v/i.test(raw) ? raw.toLowerCase() : `v${raw}`;
}

export function arxivFailSentence(reason) {
  const phrase = FAIL_PHRASE[String(reason || "")] || "未能取得源码";
  return `未用 arXiv 源码：${phrase}`;
}

function idList(raw) {
  return Array.isArray(raw) ? raw.map((id) => String(id || "")).filter(Boolean) : [];
}

export function normalizeArxivPrefs(raw) {
  const bag = raw && typeof raw === "object" ? raw : {};
  const auto = bag.auto === true || bag[ARXIV_SOURCE_AUTO_KEY] === true;
  const skip = idList(Array.isArray(bag.skip) ? bag.skip : bag[ARXIV_SOURCE_SKIP_KEY]);
  const on = idList(Array.isArray(bag.on) ? bag.on : bag[ARXIV_SOURCE_ON_KEY]);
  return { auto, skip, on };
}

export function skippedId(prefs, id) {
  return (prefs?.skip || []).includes(String(id || ""));
}

export function keptSourceId(prefs, id) {
  return (prefs?.on || []).includes(String(id || ""));
}

export function verifiedArxivFormula(block) {
  return Boolean(
    block
    && block.formulaTier === "arxiv"
    && block.latexSource === "arxiv-src"
    && block.verified === true
    && typeof block.latex === "string"
    && block.latex
  );
}

function rowsOf(formulas) {
  return Array.isArray(formulas) ? formulas : [];
}

function rowPasses(row) {
  return Boolean(row && row.pass === true && typeof row.latex === "string" && row.latex);
}

export function sourceTotals(formulas) {
  const rows = rowsOf(formulas);
  const display = rows.filter((row) => row?.kind === "display").length;
  const inlines = rows.filter((row) => row?.kind === "inline");
  const zoned = inlines.some((row) => row?.zone);
  const inline = zoned
    ? inlines.filter((row) => row?.zone === "body").length
    : inlines.length;
  return { display, inline };
}

export function slotAssignments(formulas) {
  const groups = new Map();
  for (const row of rowsOf(formulas)) {
    const id = String(row?.slotId || "");
    if (!id || !rowPasses(row)) continue;
    const list = groups.get(id) || [];
    list.push(row);
    groups.set(id, list);
  }
  const map = new Map();
  for (const [id, list] of groups) {
    if (list.length === 1) map.set(id, list[0]);
  }
  return map;
}

export function inlineSplicePlans(formulas) {
  const groups = new Map();
  for (const row of rowsOf(formulas)) {
    const place = row?.place;
    if (!place || place.blockId == null || place.start == null || place.end == null) continue;
    const key = `${place.blockId}\n${place.start}\n${place.end}`;
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  const plans = [];
  for (const list of groups.values()) {
    if (!list.every(rowPasses)) continue;
    if (list.some((row) => row.slotId)) continue;
    const ordered = list.slice().sort((a, b) => (Number(a.place?.index) || 0) - (Number(b.place?.index) || 0));
    plans.push({
      blockId: String(ordered[0].place.blockId),
      start: Number(ordered[0].place.start),
      end: Number(ordered[0].place.end),
      formulas: ordered.map((row) => ({
        latex: row.latex,
        unitId: String(row.unitId || ""),
        page: row.page ?? null,
        number: row.number || ""
      }))
    });
  }
  plans.sort((a, b) => a.start - b.start || a.end - b.end);
  return plans;
}

export function spliceInlinePieces(text, plans) {
  const src = String(text ?? "");
  const sorted = (plans || [])
    .filter((plan) => plan && Number.isFinite(plan.start) && Number.isFinite(plan.end))
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const pieces = [];
  let cursor = 0;
  let used = false;
  for (const plan of sorted) {
    const start = plan.start;
    const end = plan.end;
    if (start < cursor || end < start || end > src.length) continue;
    const slice = src.slice(start, end);
    if (!slice.trim() || PLACEHOLDER_ONLY.test(slice)) continue;
    if (cursor < start) pieces.push({ type: "text", text: src.slice(cursor, start) });
    for (const formula of plan.formulas || []) {
      if (!formula?.latex) continue;
      pieces.push({
        type: "math",
        latex: formula.latex,
        unitId: formula.unitId || "",
        page: formula.page,
        number: formula.number || ""
      });
      used = true;
    }
    cursor = end;
  }
  if (!used) return null;
  if (cursor < src.length) pieces.push({ type: "text", text: src.slice(cursor) });
  return pieces;
}

export function shownCounts(formulas) {
  const slots = slotAssignments(formulas);
  let display = 0;
  let inline = 0;
  for (const row of slots.values()) {
    if (row.kind === "display") display += 1;
    else inline += 1;
  }
  for (const plan of inlineSplicePlans(formulas)) inline += (plan.formulas || []).length;
  return { display, inline };
}

export function chipModel({ version, formulas, shown, narrow, phase, reason } = {}) {
  const ver = versionLabel(version);
  const totals = sourceTotals(formulas);
  const on = shown || { display: 0, inline: 0 };
  const head = ver ? `公式 · arXiv 源码 ${ver}` : "公式 · arXiv 源码";
  const full = `${head} · 独立 ${on.display}/${totals.display} · 行内 ${on.inline}/${totals.inline}`;
  const empty = `${head} · 本文无公式`;
  if (phase === "loading") return { text: "正在取 arXiv 源码…", title: "正在取 arXiv 源码…", phase };
  if (phase === "skipped") {
    const title = "公式 · 已不用源码 · 改回";
    return { text: "公式 · 已不用源码 ·", restore: "改回", title, phase };
  }
  if (phase === "failed") {
    const text = arxivFailSentence(reason);
    return { text, title: text, phase };
  }
  if (phase === "empty" || (phase === "ready" && totals.display + totals.inline === 0)) {
    return { text: empty, title: empty, phase: "empty" };
  }
  if (phase === "ready") {
    const text = narrow
      ? `公式 · 源码 ${on.display}/${totals.display} · ${on.inline}/${totals.inline}`
      : full;
    return { text, title: full, phase };
  }
  return { text: "", title: "", phase: phase || "off" };
}

export function pageGlyphsFromText(items, viewport) {
  const vw = Math.max(1, Number(viewport?.width) || 1);
  const vh = Math.max(1, Number(viewport?.height) || 1);
  const convert = viewport?.convertToViewportRectangle;
  return (items || []).filter((item) => String(item?.str || "").trim()).map((item) => {
    const transform = item.transform || [];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const w = Number(item.width) || 0;
    const h = Number(item.height) || 0;
    let x1 = x;
    let y1 = y;
    let x2 = x + w;
    let y2 = y + h;
    if (typeof convert === "function") {
      const rect = convert.call(viewport, [x, y, x + w, y + h]);
      x1 = Number(rect?.[0]) || 0;
      y1 = Number(rect?.[1]) || 0;
      x2 = Number(rect?.[2]) || 0;
      y2 = Number(rect?.[3]) || 0;
    }
    return {
      str: String(item.str || ""),
      fontName: String(item.fontName || ""),
      bbox: [
        Math.min(x1, x2) / vw,
        Math.min(y1, y2) / vh,
        Math.max(x1, x2) / vw,
        Math.max(y1, y2) / vh
      ]
    };
  });
}

export function prepareArxivAlignment({ files, pages, katex, id, version, pdfSha256 } = {}) {
  const parsed = parseLatexSource(files || [], { katex });
  if (!parsed?.supported) {
    const reason = parsed?.unsupported?.[0]?.reason || "no-main";
    return { ok: false, reason, alignment: null };
  }
  const aligned = alignSourceToBlocks({ units: parsed.units, pages: pages || [] });
  const alignment = {
    useSource: aligned.useSource === true,
    reason: aligned.reason || "",
    formulas: aligned.formulas || [],
    stats: aligned.stats || {},
    id: String(id || ""),
    version: version ? String(version) : "",
    pdfSha256: String(pdfSha256 || "")
  };
  if (!alignment.useSource) {
    return { ok: false, reason: alignment.reason || "alignment-below-85", alignment };
  }
  return { ok: true, reason: "", alignment };
}
