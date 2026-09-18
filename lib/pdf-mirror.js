/** PDF readout full layout mirror V3 — bbox pages, not continuous prose. */

import {
  formulaDisplayMode,
  formulaExportMarkdown,
  recoverFormulaLatex,
  unicodeMathify,
  unwrapLatex,
  wrapLatexMarkdown
} from "./pdf-latex.js";

export const PDF_MIRROR_COPY = {
  caption: "版式镜像",
  viewMirror: "版式",
  viewReadout: "通读",
  hint: "按原页位置排列译文。公式写入 LaTeX 并用 KaTeX 渲染；图为原页裁剪。导出 MD 含可粘贴 $...$ / $$...$$。",
  scanned: "本页没有文字层，无法镜像版式。",
  figureFallback: "图（见左侧）",
  formulaFallback: "公式"
};

/** §4.6: above this, merge text runs more aggressively. */
export const MIRROR_DENSE_ITEM_LIMIT = 200;

/** pdf.js 4.10 operator ids used to walk image paints. */
export const PDF_MIRROR_OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintImageMaskXObject: 80,
  paintImageXObject: 82,
  paintInlineImageXObject: 83,
  paintImageXObjectRepeat: 85
};

const IMAGE_OPS = new Set([
  PDF_MIRROR_OPS.paintImageMaskXObject,
  PDF_MIRROR_OPS.paintImageXObject,
  PDF_MIRROR_OPS.paintInlineImageXObject,
  PDF_MIRROR_OPS.paintImageXObjectRepeat
]);

export function inferPageSize(items, fallback = {}) {
  const list = Array.isArray(items) ? items : [];
  const widthHint = Number(fallback.width);
  const heightHint = Number(fallback.height);
  if (!list.length) {
    return {
      width: Number.isFinite(widthHint) && widthHint > 0 ? widthHint : 612,
      height: Number.isFinite(heightHint) && heightHint > 0 ? heightHint : 792
    };
  }
  const maxX = Math.max(...list.map((item) => Number(item.x) + Number(item.width || 0)));
  const maxY = Math.max(...list.map((item) => Number(item.y) + Number(item.height || 0)));
  const minY = Math.min(...list.map((item) => Number(item.y) || 0));
  return {
    width: Number.isFinite(widthHint) && widthHint > 0 ? widthHint : Math.max(1, maxX),
    height: Number.isFinite(heightHint) && heightHint > 0 ? heightHint : Math.max(1, maxY + Math.max(0, minY))
  };
}

/** PDF user space (origin bottom-left) → page CSS space (origin top-left). */
export function pdfItemToPageRect(item, pageHeight) {
  const x = Number(item?.x) || 0;
  const y = Number(item?.y) || 0;
  const width = Math.max(0, Number(item?.width) || 0);
  const height = Math.max(0, Number(item?.height) || 0);
  const ph = Math.max(0, Number(pageHeight) || 0);
  return { left: x, top: ph - y - height, width, height };
}

export function unionRects(rects) {
  const list = (rects || []).filter((rect) => rect && Number.isFinite(Number(rect.left)));
  if (!list.length) return { left: 0, top: 0, width: 0, height: 0 };
  const left = Math.min(...list.map((rect) => Number(rect.left)));
  const top = Math.min(...list.map((rect) => Number(rect.top)));
  const right = Math.max(...list.map((rect) => Number(rect.left) + Number(rect.width || 0)));
  const bottom = Math.max(...list.map((rect) => Number(rect.top) + Number(rect.height || 0)));
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function inflateRect(rect, pad = 0) {
  const p = Math.max(0, Number(pad) || 0);
  return {
    left: Number(rect?.left || 0) - p,
    top: Number(rect?.top || 0) - p,
    width: Math.max(0, Number(rect?.width || 0) + p * 2),
    height: Math.max(0, Number(rect?.height || 0) + p * 2)
  };
}

export function pageRectToPercent(rect, pageWidth, pageHeight) {
  const pw = Math.max(1, Number(pageWidth) || 1);
  const ph = Math.max(1, Number(pageHeight) || 1);
  return {
    left: (Number(rect?.left) || 0) / pw * 100,
    top: (Number(rect?.top) || 0) / ph * 100,
    width: (Number(rect?.width) || 0) / pw * 100,
    height: (Number(rect?.height) || 0) / ph * 100
  };
}

export function clampPercentRect(rect = {}) {
  const left = clampNum(rect.left, 0, 100);
  const top = clampNum(rect.top, 0, 100);
  const width = clampNum(rect.width, 0, Math.max(0, 100 - left));
  const height = clampNum(rect.height, 0, Math.max(0, 100 - top));
  return { left, top, width, height };
}

export function percentRectToStyle(rect) {
  const r = clampPercentRect(rect);
  return {
    left: `${roundCss(r.left)}%`,
    top: `${roundCss(r.top)}%`,
    width: `${roundCss(r.width)}%`,
    height: `${roundCss(r.height)}%`
  };
}

const MIRROR_TEXT_ROLES = new Set(["title", "authors", "heading", "caption", "paragraph", "body"]);

/** Text (not crop) mirror boxes — CJK must not be clipped by dead-height + overflow:hidden. */
export function isMirrorTextRole(role) {
  return MIRROR_TEXT_ROLES.has(String(role || ""));
}

/**
 * Strategy C: pin top/left/width; min-height keeps the PDF bbox; height:auto grows after CJK wrap.
 * Crops keep percentRectToStyle (fixed height + overflow:hidden).
 */
export function percentRectToTextStyle(rect) {
  const base = percentRectToStyle(rect);
  return {
    left: base.left,
    top: base.top,
    width: base.width,
    minHeight: base.height,
    height: "auto"
  };
}

/** Strategy A+B: used height ≥ content, and ≥ source box, plus 2–4px pad. Never shrink. */
export function fitMirrorTextHeight({ scrollHeight, minHeight, fontSize, lineHeight, pad = 3 } = {}) {
  const content = Math.max(0, Number(scrollHeight) || 0);
  const src = Math.max(0, Number(minHeight) || 0);
  const fs = Math.max(0, Number(fontSize) || 0);
  const lh = Math.max(1.25, Number(lineHeight) || 1.3);
  const metric = fs > 0 ? fs * lh : 0;
  const extra = Math.min(4, Math.max(2, Number(pad) || 3));
  return Math.ceil(Math.max(content, src, metric) + extra);
}

/** After CJK height growth, later siblings must be pushed — stale `top` paints overlapping ink. */
export const MIRROR_COLLISION_GAP = 4;

export function mirrorBoxGeom(box = {}) {
  const rect = box.rect && typeof box.rect === "object" ? box.rect : box;
  return {
    left: Number(rect?.left) || 0,
    top: Number(rect?.top) || 0,
    width: Math.max(0, Number(rect?.width) || 0),
    height: Math.max(0, Number(rect?.height) || 0)
  };
}

export function boxesOverlapX(a, b, slop = 1) {
  const ga = mirrorBoxGeom(a);
  const gb = mirrorBoxGeom(b);
  const left = Math.max(ga.left, gb.left);
  const right = Math.min(ga.left + ga.width, gb.left + gb.width);
  return right - left > slop;
}

export function boxesOverlapY(a, b, slop = 1) {
  const ga = mirrorBoxGeom(a);
  const gb = mirrorBoxGeom(b);
  const top = Math.max(ga.top, gb.top);
  const bottom = Math.min(ga.top + ga.height, gb.top + gb.height);
  return bottom - top > slop;
}

export function looksLikeArxivMeta(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/arxiv\s*:/i.test(t)) return true;
  return /\[\s*(cs|stat|math|eess|q-bio|q-fin|econ|astro-ph|hep|nucl|gr-qc|quant-ph|nlin|cond-mat)\./i.test(t);
}

export function looksLikeMarginMeta(box, pageWidth, pageHeight) {
  const g = mirrorBoxGeom(box);
  const pw = Math.max(1, Number(pageWidth) || 1);
  const ph = Math.max(1, Number(pageHeight) || 1);
  if (looksLikeArxivMeta(box.text || box.translation)) return g.left < pw * 0.32;
  const leftStrip = g.left < pw * 0.12 && g.width < pw * 0.18;
  const tall = g.height > ph * 0.18 || g.height > Math.max(24, g.width * 2.2);
  return leftStrip && tall;
}

function cloneLayoutBox(box, index) {
  const g = mirrorBoxGeom(box);
  return {
    ...box,
    index: Number.isFinite(Number(box.index)) ? Number(box.index) : index,
    left: g.left,
    top: g.top,
    width: g.width,
    height: g.height,
    originTop: Number.isFinite(Number(box.originTop)) ? Number(box.originTop) : g.top,
    role: box.role || "",
    text: String(box.text || box.translation || "")
  };
}

function normInkText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function boxArea(box) {
  const g = mirrorBoxGeom(box);
  return Math.max(0, g.width) * Math.max(0, g.height);
}

function inkOverlapRatio(a, b) {
  const ga = mirrorBoxGeom(a);
  const gb = mirrorBoxGeom(b);
  const left = Math.max(ga.left, gb.left);
  const top = Math.max(ga.top, gb.top);
  const right = Math.min(ga.left + ga.width, gb.left + gb.width);
  const bottom = Math.min(ga.top + ga.height, gb.top + gb.height);
  const inter = Math.max(0, right - left) * Math.max(0, bottom - top);
  const denom = Math.min(boxArea(a), boxArea(b));
  return denom <= 0 ? 0 : inter / denom;
}

/** Drop ghost / double-painted boxes: same (or contained) text at nearly the same place. */
export function dedupeMirrorInkBoxes(boxes = []) {
  const list = (boxes || []).map((box, index) => cloneLayoutBox(box, index));
  const kept = [];
  const dropped = [];
  for (const box of list) {
    const text = normInkText(box.text);
    const hit = text
      ? kept.find((other) => {
          const t2 = normInkText(other.text);
          if (!t2) return false;
          const same = text === t2;
          const contained =
            text.length >= 16 && t2.length >= 16 && (text.includes(t2) || t2.includes(text));
          if (!same && !contained) return false;
          const near = Math.abs(box.top - other.top) < 14 && Math.abs(box.left - other.left) < 18;
          return near || inkOverlapRatio(box, other) > 0.22;
        })
      : null;
    if (hit) {
      if (boxArea(box) > boxArea(hit)) {
        const idx = kept.indexOf(hit);
        kept[idx] = box;
        dropped.push(hit);
      } else {
        dropped.push(box);
      }
      continue;
    }
    kept.push(box);
  }
  return { boxes: kept, dropped };
}

/**
 * Sweep top→bottom. If A overlaps B in X and A.bottom > B.top, push B down
 * by the overlap plus a small gap. Same-row cells (no X overlap) stay put.
 */
export function resolveVerticalMirrorCollisions(boxes = [], { gap = MIRROR_COLLISION_GAP } = {}) {
  const list = (boxes || []).map((box, index) => cloneLayoutBox(box, index));
  const pad = Math.max(0, Number(gap) || MIRROR_COLLISION_GAP);
  list.sort((a, b) => a.top - b.top || a.left - b.left || a.index - b.index);
  for (let i = 0; i < list.length; i++) {
    let push = 0;
    for (let j = 0; j < i; j++) {
      if (!boxesOverlapX(list[j], list[i])) continue;
      const need = list[j].top + list[j].height + pad - list[i].top;
      if (need > push) push = need;
    }
    if (push > 0.5) list[i].top += push;
  }
  return list;
}

/** Keep author grid rows aligned after per-column pushes. */
export function alignAuthorRows(boxes = [], { gap = MIRROR_COLLISION_GAP, band = 10 } = {}) {
  const list = (boxes || []).map((box, index) => cloneLayoutBox(box, index));
  const authors = list.filter((box) => box.role === "authors");
  if (authors.length < 2) return list;
  const origin = (box) => (Number.isFinite(Number(box.originTop)) ? Number(box.originTop) : box.top);
  authors.sort((a, b) => origin(a) - origin(b) || a.left - b.left);
  const rows = [];
  for (const box of authors) {
    const row = rows.find((group) => Math.abs(origin(group[0]) - origin(box)) <= band);
    if (row) row.push(box);
    else rows.push([box]);
  }
  rows.sort((a, b) => origin(a[0]) - origin(b[0]));
  let prevBottom = Number.NEGATIVE_INFINITY;
  const pad = Math.max(0, Number(gap) || MIRROR_COLLISION_GAP);
  for (const row of rows) {
    const natural = Math.max(...row.map((box) => box.top));
    const top = Number.isFinite(prevBottom) ? Math.max(prevBottom + pad, natural) : natural;
    for (const box of row) box.top = top;
    prevBottom = Math.max(...row.map((box) => box.top + box.height));
  }
  return list;
}

/** Sidebar arXiv strip stays left; body/abstract keep a horizontal gutter. */
export function reserveMarginMeta(boxes = [], pageWidth, pageHeight, { gap = 6 } = {}) {
  const pw = Math.max(1, Number(pageWidth) || 1);
  const ph = Math.max(1, Number(pageHeight) || 1);
  const list = (boxes || []).map((box, index) => cloneLayoutBox(box, index));
  const metas = list.filter((box) => looksLikeMarginMeta(box, pw, ph));
  if (!metas.length) return list;
  const pad = Math.max(4, Number(gap) || 6);
  const colRight = Math.max(
    pw * 0.1,
    ...metas.map((box) => box.left + box.width)
  );
  const reserved = Math.min(pw * 0.18, Math.max(colRight, pw * 0.1));
  for (const box of list) {
    if (metas.includes(box)) {
      box.left = Math.min(box.left, pw * 0.02);
      box.width = Math.max(box.width, reserved - box.left);
      continue;
    }
    if (box.role === "title") continue;
    const right = box.left + box.width;
    if (box.left < reserved + pad && right > reserved && boxesOverlapY(box, { left: 0, top: 0, width: reserved, height: ph })) {
      box.left = reserved + pad;
      box.width = Math.max(28, right - box.left);
    }
  }
  return list;
}

export function resolveHorizontalMirrorCollisions(boxes = [], { gap = 6, pageWidth = 0 } = {}) {
  const list = (boxes || []).map((box, index) => cloneLayoutBox(box, index));
  const pad = Math.max(4, Number(gap) || 6);
  const pw = Math.max(0, Number(pageWidth) || 0);
  list.sort((a, b) => a.left - b.left || a.top - b.top || a.index - b.index);
  for (let i = 0; i < list.length; i++) {
    let minLeft = list[i].left;
    for (let j = 0; j < i; j++) {
      if (!boxesOverlapY(list[j], list[i])) continue;
      const need = list[j].left + list[j].width + pad;
      if (need > list[i].left + 0.5) minLeft = Math.max(minLeft, need);
    }
    if (minLeft > list[i].left + 0.5) {
      const right = list[i].left + list[i].width;
      list[i].left = minLeft;
      list[i].width = Math.max(28, right - minLeft);
      if (pw && list[i].left + list[i].width > pw) {
        list[i].width = Math.max(28, pw - list[i].left);
      }
    }
  }
  return list;
}

/**
 * Post CJK-fit relayout: dedupe ghosts, keep sidebar/abstract apart,
 * push later boxes down, align author rows. Slight looseness OK; stacked ink not OK.
 */
export function relayoutMirrorPageBoxes(boxes = [], { pageWidth = 0, pageHeight = 0, gap = MIRROR_COLLISION_GAP } = {}) {
  const raw = (boxes || []).map((box, index) => cloneLayoutBox(box, index));
  const pw = Math.max(1, Number(pageWidth) || inferWidth(raw.map((box) => ({ rect: box }))));
  const ph = Math.max(1, Number(pageHeight) || 1);
  const { boxes: unique, dropped } = dedupeMirrorInkBoxes(raw);
  let list = reserveMarginMeta(unique, pw, ph, { gap: Math.max(gap, 6) });
  list = resolveVerticalMirrorCollisions(list, { gap });
  list = alignAuthorRows(list, { gap });
  list = resolveVerticalMirrorCollisions(list, { gap });
  list = resolveHorizontalMirrorCollisions(list, { gap: Math.max(gap, 6), pageWidth: pw });
  const bottom = Math.max(ph, ...list.map((box) => box.top + box.height), 0);
  return {
    boxes: list,
    dropped,
    pageWidth: pw,
    pageHeight: bottom + 4
  };
}

function looksLikeAffiliationText(text) {
  return /\b(google|university|universit[aá]|institute|research|brain|lab|department|dept\.?|inc\.?|ltd\.?|corp|college|school of)\b/i.test(
    String(text || "")
  );
}

function startsWithPersonName(text) {
  const head = String(text || "").trim().split(/[\n@]/)[0].trim();
  if (!head) return false;
  const lead = head.split(/\s+/).slice(0, 2).join(" ");
  if (looksLikeAffiliationText(lead)) return false;
  return /^[A-Z\u00c0-\u024f][A-Za-z.`'\-]+(?:\s+[A-Z\u00c0-\u024f.][A-Za-z.`'\-]*){1,3}\b/.test(head);
}

function isAuthorFieldContinuation(prev, next) {
  const t = String(next?.text || "").trim();
  if (!t) return false;
  if (startsWithPersonName(t)) return false;
  if (/@/.test(t) || looksLikeAffiliationText(t)) return true;
  return t.length <= 48 && !startsWithPersonName(prev?.text);
}

/** Merge name / affiliation / email in one column; do not swallow the next author row. */
export function mergeStackedAuthorCells(boxes = [], pageWidth = 0) {
  const authors = [];
  const others = [];
  for (const box of boxes || []) {
    if (box?.role === "authors") authors.push(box);
    else others.push(box);
  }
  if (authors.length < 2) return boxes || [];
  const columns = [];
  for (const box of sortByTopLeft(authors)) {
    const col = columns.find(
      (group) =>
        xOverlapRatio(
          { x: Number(group[0].rect?.left) || 0, width: Number(group[0].rect?.width) || 0 },
          { x: Number(box.rect?.left) || 0, width: Number(box.rect?.width) || 0 }
        ) >= 0.45
    );
    if (col) col.push(box);
    else columns.push([box]);
  }
  const mergedAuthors = [];
  for (const col of columns) {
    col.sort((a, b) => (Number(a.rect?.top) || 0) - (Number(b.rect?.top) || 0));
    let group = [];
    const flush = () => {
      if (!group.length) return;
      if (group.length === 1) mergedAuthors.push(group[0]);
      else {
        mergedAuthors.push({
          ...group[0],
          text: group
            .map((box) => String(box.text || "").trim())
            .filter(Boolean)
            .join("\n"),
          rect: unionRects(group.map((box) => box.rect))
        });
      }
      group = [];
    };
    for (const box of col) {
      if (!group.length) {
        group.push(box);
        continue;
      }
      const last = group[group.length - 1];
      if (!isAuthorFieldContinuation(last, box)) {
        flush();
      }
      group.push(box);
    }
    flush();
  }
  return sortBoxesReadingOrder([...others, ...mergedAuthors], pageWidth);
}

export function mergeLeftMarginStrips(boxes = [], pageWidth, pageHeight) {
  const pw = Math.max(1, Number(pageWidth) || 1);
  const ph = Math.max(1, Number(pageHeight) || 1);
  const margin = [];
  const rest = [];
  for (const box of boxes || []) {
    if (box?.role === "authors" || box?.role === "title" || box?.role === "heading") {
      rest.push(box);
      continue;
    }
    if (looksLikeMarginMeta({ ...box, ...box.rect, text: box.text }, pw, ph) || looksLikeArxivMeta(box.text)) {
      margin.push(box);
    } else {
      rest.push(box);
    }
  }
  if (margin.length < 2 && !margin.some((box) => looksLikeArxivMeta(box.text))) return boxes || [];
  if (!margin.length) return boxes || [];
  const ordered = sortByTopLeft(margin);
  const merged = {
    ...ordered[0],
    text: ordered
      .map((box) => String(box.text || "").trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    rect: unionRects(ordered.map((box) => box.rect))
  };
  return sortBoxesReadingOrder([...rest, merged], pw);
}

/** Map a page-space percent box onto a rendered canvas (zoom/DPR already baked into pixels). */
export function canvasCropSource(percentRect, canvasWidth, canvasHeight) {
  const r = clampPercentRect(percentRect);
  const cw = Math.max(0, Number(canvasWidth) || 0);
  const ch = Math.max(0, Number(canvasHeight) || 0);
  return {
    sx: (r.left / 100) * cw,
    sy: (r.top / 100) * ch,
    sw: (r.width / 100) * cw,
    sh: (r.height / 100) * ch
  };
}

export function cropCanvasToDataUrl(canvas, percentRect) {
  if (!canvas || typeof canvas.getContext !== "function") return "";
  const src = canvasCropSource(percentRect, canvas.width, canvas.height);
  if (src.sw < 1 || src.sh < 1) return "";
  try {
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(src.sw));
    out.height = Math.max(1, Math.round(src.sh));
    const ctx = out.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(canvas, src.sx, src.sy, src.sw, src.sh, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  } catch {
    return "";
  }
}

export function looksLikeFormulaItem(item = {}) {
  const font = String(item.fontName || item.font || "");
  if (/CM(MI|SY|EX)|Math|Symbol|MTMI|MTSY|Euclid|STIX|Asana|KaTeX|CambriaMath/i.test(font)) return true;
  const str = String(item.str || item.text || "").trim();
  if (!str || str.length > 48) return false;
  if (/@|https?:|www\./i.test(str)) return false;
  if (/[A-Za-z]{4,}/.test(str) && !/[=∑∫√]/.test(str) && !/\b(softmax|Attention|LayerNorm|exp|log|sin|cos|tan|max|min)\b/.test(str)) {
    return false;
  }
  const symbols = (str.match(/[+\-*=<>≤≥≠±×÷∈∑∫√∞^_{}\\]/g) || []).length;
  const letters = (str.match(/[A-Za-z\u4e00-\u9fff]/g) || []).length;
  return symbols >= 1 && symbols >= letters && /[+\-*=<>≤≥≠±×÷∈∑∫√^_]/.test(str);
}

export function normalizeMirrorItem(item) {
  if (!item || typeof item !== "object") {
    return { str: "", x: 0, y: 0, width: 0, height: 0, bold: false, fontName: "" };
  }
  const transform = Array.isArray(item.transform) ? item.transform : [];
  return {
    str: String(item.str || ""),
    x: Number.isFinite(Number(item.x)) ? Number(item.x) : Number(transform[4]) || 0,
    y: Number.isFinite(Number(item.y)) ? Number(item.y) : Number(transform[5]) || 0,
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    bold: item.bold === true || /bold|black|heavy|semibold/i.test(String(item.fontName || "")),
    fontName: String(item.fontName || "")
  };
}

export function extractMirrorItems(textContent) {
  const raw = Array.isArray(textContent) ? textContent : textContent?.items || [];
  return raw.map(normalizeMirrorItem).filter((item) => item.str);
}

/**
 * Spatial boxes for the right pane. Author-grid cells stay separate;
 * wrapped body lines still merge. Empty when there is no text layer.
 */
export function buildMirrorLayout(input, pageSize = {}) {
  const items = Array.isArray(input) ? input.map(normalizeMirrorItem).filter((item) => item.str) : extractMirrorItems(input);
  const { width: pageWidth, height: pageHeight } = inferPageSize(items, pageSize);
  if (!items.length) {
    return { kind: "empty", pageWidth, pageHeight, boxes: [], visuals: [], translatable: [], itemCount: 0 };
  }
  const lines = clusterMirrorLines(items, { dense: items.length > MIRROR_DENSE_ITEM_LIMIT });
  const boxes = mergeLeftMarginStrips(
    mergeStackedAuthorCells(markAuthorBoxes(linesToMirrorBoxes(lines, pageWidth, pageHeight), pageWidth), pageWidth),
    pageWidth,
    pageHeight
  );
  boxes.forEach((box) => {
    if (!isMathItem(box)) return;
    box.render = formulaRenderPlan(box, pageWidth);
    box.latex = box.render.latex || "";
    box.kind = "math";
    box.role = "formula";
  });
  const textRects = boxes.map((box) => box.rect);
  const formulaVisuals = boxes
    .filter((box) => isMathItem(box) && shouldRenderFormulaCrop(box))
    .map((box) => ({
      kind: "math",
      role: "formula",
      rect: inflateRect(box.rect, 2),
      sourceText: box.text,
      latex: box.latex || "",
      render: box.render || formulaRenderPlan(box)
    }));
  const figureVisuals = findUncoveredRegions(textRects, pageWidth, pageHeight).map((rect) => ({
    kind: "figure",
    rect
  }));
  const visuals = attachFigureCaptions(
    boxes,
    mergeVisuals(formulaVisuals, figureVisuals, pageWidth, pageHeight),
    pageWidth
  );
  return {
    kind: "mirror",
    pageWidth,
    pageHeight,
    boxes,
    visuals,
    translatable: boxes.filter((box) => box.kind === "text" && box.text),
    itemCount: items.length
  };
}

export function translatableMirrorUnits(layout) {
  return (layout?.translatable || layout?.boxes || [])
    .filter((box) => !isMathItem(box) && String(box.text || box.original || "").trim())
    .map((box) => ({
      text: box.text || box.original,
      original: box.text || box.original,
      role: box.role || "paragraph",
      kind: "text",
      rect: box.rect,
      pageWidth: layout.pageWidth,
      pageHeight: layout.pageHeight
    }));
}

export function mergeMirrorTranslations(layout, results = []) {
  const units = translatableMirrorUnits(layout);
  return units.map((unit, index) => {
    const hit = results[index] || {};
    return {
      ...unit,
      original: hit.original || unit.original,
      translation: String(hit.translation || "").trim(),
      role: hit.role || unit.role
    };
  });
}

export function sortBoxesReadingOrder(boxes, pageWidth = 0) {
  const list = [...(boxes || [])];
  const pw = Math.max(1, Number(pageWidth) || inferWidth(list));
  const splitX = detectBoxColumnSplit(list, pw);
  if (splitX == null) return sortByTopLeft(list);
  const out = [];
  let left = [];
  let right = [];
  const flush = () => {
    out.push(...sortByTopLeft(left), ...sortByTopLeft(right));
    left = [];
    right = [];
  };
  for (const box of sortByTopLeft(list)) {
    const width = Number(box.rect?.width) || 0;
    const leftEdge = Number(box.rect?.left) || 0;
    const full = width > pw * 0.58 && leftEdge < splitX && leftEdge + width > splitX;
    if (full) {
      flush();
      out.push(box);
    } else if (leftEdge + width / 2 < splitX) left.push(box);
    else right.push(box);
  }
  flush();
  return out;
}

export function bboxCenterError(expected, actual, pageWidth) {
  const ex = (Number(expected?.left) || 0) + (Number(expected?.width) || 0) / 2;
  const ey = (Number(expected?.top) || 0) + (Number(expected?.height) || 0) / 2;
  const ax = (Number(actual?.left) || 0) + (Number(actual?.width) || 0) / 2;
  const ay = (Number(actual?.top) || 0) + (Number(actual?.height) || 0) / 2;
  const dx = Math.abs(ax - ex);
  const dy = Math.abs(ay - ey);
  const pw = Math.max(1, Number(pageWidth) || 1);
  return {
    dx,
    dy,
    within: dx <= Math.max(12, pw * 0.03) && dy <= Math.max(12, pw * 0.03)
  };
}

export function toMirrorItem(box, { page, translation, imageUrl } = {}) {
  const rect = box?.rect || box?.bbox || { left: 0, top: 0, width: 0, height: 0 };
  const latex = String(box?.latex || "").trim();
  return {
    id: `${page || 0}:${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}`,
    page: page == null ? "" : page,
    role: box?.role || "paragraph",
    bbox: rect,
    sourceText: String(box?.text || box?.sourceText || box?.original || "").trim(),
    translation: String(translation || box?.translation || "").trim(),
    latex,
    kind: box?.kind || (box?.role === "formula" ? "math" : "text"),
    imageUrl: imageUrl || box?.imageUrl || box?.imageRef || "",
    imageRef: imageUrl || box?.imageRef || box?.imageUrl || ""
  };
}

export function looksLikeCaption(text) {
  return /^(fig(?:ure)?\.?|table|scheme|图|表)\s*[\d.]/i.test(String(text || "").trim());
}

export function looksLikeAuthorCell(box, pageWidth) {
  if (!box || isMathItem(box)) return false;
  if (box.role === "title" || box.role === "heading" || box.role === "caption") return false;
  const pw = Math.max(1, Number(pageWidth) || 1);
  if ((Number(box.rect?.width) || 0) > pw * 0.4) return false;
  const text = String(box.text || "").trim();
  if (!text || text.length > 96) return false;
  if (/@/.test(text)) return true;
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 6 && /^[A-Z][A-Za-z.`'\-]+/.test(text) && !/[.!?]$/.test(text);
}

export function markAuthorBoxes(boxes, pageWidth) {
  return (boxes || []).map((box) =>
    looksLikeAuthorCell(box, pageWidth) ? { ...box, role: "authors" } : box
  );
}

export function attachFigureCaptions(boxes, visuals, pageWidth) {
  const list = Array.isArray(visuals) ? visuals : [];
  for (const vis of list) {
    if (vis.kind !== "figure") continue;
    const cap = (boxes || []).find((box) => captionFitsFigure(box, vis, pageWidth));
    if (!cap) continue;
    cap.role = "caption";
    vis.caption = cap.text;
  }
  return list;
}

export function isMathItem(box) {
  return box?.kind === "math" || box?.kind === "formula" || box?.role === "formula";
}

/** A: recovered LaTeX → KaTeX. B: crop. C: 「公式」. Never OCR or invent TeX. */
export function formulaRenderPlan(box = {}, pageWidth = 0) {
  const text = String(box.text || box.str || box.sourceText || "").trim();
  const latex = String(box.latex || "").trim() || recoverFormulaLatex(text);
  if (latex) {
    const display = box.display === true || formulaDisplayMode(box, pageWidth || box.pageWidth);
    return {
      mode: "katex",
      latex,
      display,
      text: wrapLatexMarkdown(latex, display),
      alt: text
    };
  }
  return { mode: "crop", latex: "", display: false, text: "", alt: PDF_MIRROR_COPY.formulaFallback };
}

/** Page-crop only when no recoverable math text. */
export function shouldRenderFormulaCrop(vis) {
  if (!isMathItem(vis)) return false;
  const plan = vis.render || formulaRenderPlan(vis);
  return plan.mode !== "katex" || !plan.latex;
}

export function readingOrderMirrorItems(layout, translations = []) {
  if (!layout || layout.kind === "empty") {
    return (translations || []).filter((item) => String(item?.translation || "").trim());
  }
  const texts = mergeMirrorTranslations(layout, translations).filter((item) => item.translation);
  const formulas = (layout.boxes || [])
    .filter((box) => isMathItem(box))
    .map((box) => {
      const plan = box.render || formulaRenderPlan(box);
      if (plan.mode !== "katex" || !plan.latex) {
        return {
          original: box.text,
          translation: formulaExportMarkdown({ sourceText: box.text }),
          latex: "",
          display: false,
          role: "formula",
          kind: "math",
          rect: box.rect,
          pageWidth: layout.pageWidth,
          pageHeight: layout.pageHeight
        };
      }
      return {
        original: box.text,
        translation: plan.text,
        latex: plan.latex,
        display: plan.display,
        role: "formula",
        kind: "math",
        rect: box.rect,
        pageWidth: layout.pageWidth,
        pageHeight: layout.pageHeight
      };
    })
    .filter(Boolean);
  return sortBoxesReadingOrder([...texts, ...formulas], layout.pageWidth);
}

export {
  formulaDisplayMode,
  formulaExportMarkdown,
  recoverFormulaLatex,
  unicodeMathify,
  unwrapLatex,
  wrapLatexMarkdown
};

function captionFitsFigure(box, vis, pageWidth) {
  if (!looksLikeCaption(box?.text)) return false;
  const gap = Number(box.rect?.top) - (Number(vis.rect?.top) + Number(vis.rect?.height));
  if (gap < -12 || gap > Math.max(40, (Number(vis.rect?.height) || 0) * 0.4)) return false;
  const overlap = xOverlapRatio(
    { x: Number(box.rect?.left) || 0, width: Number(box.rect?.width) || 0 },
    { x: Number(vis.rect?.left) || 0, width: Number(vis.rect?.width) || 0 }
  );
  return overlap > 0.15 || (Number(box.rect?.width) || 0) > (Number(pageWidth) || 1) * 0.45;
}

export function bboxAttr(rect) {
  const r = rect || {};
  return [r.left, r.top, r.width, r.height].map((n) => Math.round((Number(n) || 0) * 10) / 10).join(",");
}

export function findUncoveredRegions(textRects, pageWidth, pageHeight, options = {}) {
  const pw = Math.max(1, Number(pageWidth) || 1);
  const ph = Math.max(1, Number(pageHeight) || 1);
  const list = Array.isArray(textRects) ? textRects : [];
  if (!list.length) return [];
  const bands = mergeYBands(list);
  const minW = (Number(options.minWidthRatio) || 0.12) * pw;
  const minH = (Number(options.minHeightRatio) || 0.08) * ph;
  const regions = [];
  for (let i = 0; i < bands.length - 1; i++) {
    const gapTop = bands[i].top + bands[i].height;
    const gapBottom = bands[i + 1].top;
    const height = gapBottom - gapTop;
    if (height < minH) continue;
    const left = Math.min(bands[i].left, bands[i + 1].left);
    const right = Math.max(bands[i].left + bands[i].width, bands[i + 1].left + bands[i + 1].width);
    const width = right - left;
    if (width < minW) continue;
    regions.push({ left, top: gapTop, width, height });
  }
  return regions;
}

export function imageRectsFromUnitCtms(entries, pageHeight) {
  const ph = Math.max(1, Number(pageHeight) || 1);
  return (entries || [])
    .map((entry) => {
      const ctm = entry.ctm || entry;
      const corners = unitSquareCorners(ctm);
      const xs = corners.map((pt) => pt[0]);
      const ys = corners.map((pt) => pt[1]);
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const bottom = Math.min(...ys);
      const topPdf = Math.max(...ys);
      return {
        kind: "figure",
        objId: entry.objId,
        rect: {
          left,
          top: ph - topPdf,
          width: Math.max(0, right - left),
          height: Math.max(0, topPdf - bottom)
        }
      };
    })
    .filter((item) => item.rect.width >= 12 && item.rect.height >= 12);
}

export function walkImageCtms(fnArray = [], argsArray = [], ops = PDF_MIRROR_OPS) {
  const identity = [1, 0, 0, 1, 0, 0];
  let ctm = identity.slice();
  const stack = [];
  const out = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] || [];
    if (fn === ops.save) stack.push(ctm.slice());
    else if (fn === ops.restore) ctm = stack.pop() || identity.slice();
    else if (fn === ops.transform && args.length >= 6) ctm = multiplyCtm(ctm, args);
    else if (IMAGE_OPS.has(fn)) out.push({ ctm: ctm.slice(), objId: args[0], op: fn });
  }
  return out;
}

export function appendOperatorImages(visuals, opRects, pageWidth, pageHeight) {
  const existing = Array.isArray(visuals) ? visuals.slice() : [];
  for (const item of opRects || []) {
    if (!item?.rect) continue;
    if (item.rect.width < pageWidth * 0.04 && item.rect.height < pageHeight * 0.04) continue;
    if (existing.some((vis) => overlapRatio(vis.rect, item.rect) > 0.45)) continue;
    existing.push({ kind: item.kind || "figure", rect: item.rect, objId: item.objId });
  }
  return existing;
}

function clusterMirrorLines(items, options = {}) {
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
    splitLineByGaps(bucket, options).forEach((part) => {
      const line = finalizeMirrorLine(part);
      if (line.text) lines.push(line);
    });
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
  return lines;
}

function splitLineByGaps(items, options = {}) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  if (sorted.length < 2) return [sorted];
  const parts = [];
  let start = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].width);
    const em = Math.max(sorted[i - 1].height || 0, sorted[i].height || 0, 8);
    const cut = options.dense ? Math.max(22, em * 2.4) : Math.max(14, em * 1.55);
    // Author grids leave ~1.5–3em gutters; dense pages keep more runs on one line.
    if (gap > cut) {
      parts.push(sorted.slice(start, i));
      start = i;
    }
  }
  parts.push(sorted.slice(start));
  return parts.filter((part) => part.length);
}

function finalizeMirrorLine(items) {
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
    formula: sorted.some((item) => looksLikeFormulaItem(item)),
    items: sorted
  };
}

function linesToMirrorBoxes(lines, pageWidth, pageHeight) {
  if (!lines.length) return [];
  const stats = mirrorLineStats(lines, pageWidth);
  const remaining = lines.map((line, index) => ({ line, index }));
  const groups = [];
  while (remaining.length) {
    const seed = remaining.shift();
    const group = [seed.line];
    const seedKind = seed.line.formula ? "formula" : "text";
    for (let i = 0; i < remaining.length; ) {
      const cand = remaining[i].line;
      const candKind = cand.formula ? "formula" : "text";
      const last = group[group.length - 1];
      if (candKind !== seedKind || !canMergeLines(last, cand, stats)) {
        i += 1;
        continue;
      }
      group.push(cand);
      remaining.splice(i, 1);
    }
    const role = headingRole(group[0], group[1] || null, stats);
    const text = joinHyphenated(group.map((line) => line.text));
    if (text.length <= 1 && seedKind !== "formula") continue;
    const left = Math.min(...group.map((line) => line.x));
    const bottom = Math.min(...group.map((line) => line.y));
    const topPdf = Math.max(...group.map((line) => line.y + (line.height || 0)));
    const width = Math.max(...group.map((line) => line.x + line.width)) - left;
    groups.push({
      text,
      role: seedKind === "formula" ? "formula" : role,
      kind: seedKind === "formula" ? "math" : "text",
      rect: inflateRect(
        {
          left,
          top: pageHeight - topPdf,
          width,
          height: Math.max(1, topPdf - bottom)
        },
        seedKind === "formula" ? 1 : 0
      )
    });
  }
  return sortBoxesReadingOrder(groups, pageWidth);
}

function canMergeLines(a, b, stats) {
  if (!a || !b) return false;
  const overlap = xOverlapRatio(a, b);
  if (overlap < 0.45) return false;
  const gap = a.y - b.y;
  const pageWidth = Math.max(1, Number(stats.pageWidth) || 1);
  const narrow = Math.max(a.width, b.width) < pageWidth * 0.42;
  if (gap > stats.medianLead * (narrow ? 1.18 : 1.55)) return false;
  if (narrow && /@/.test(a.text) && !/@/.test(b.text)) return false;
  if (Math.abs((a.height || 0) - (b.height || 0)) > Math.max(1, stats.medianH * 0.35)) return false;
  const widthRatio = Math.min(a.width, b.width) / Math.max(a.width, b.width, 1);
  if (widthRatio < 0.5) return false;
  return true;
}

function xOverlapRatio(a, b) {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const overlap = Math.max(0, right - left);
  const denom = Math.min(a.width, b.width, 1);
  return overlap / Math.max(denom, 1);
}

function mirrorLineStats(lines, pageWidth = 0) {
  const heights = lines.map((line) => line.height).filter((h) => h > 0);
  const medianH = typicalHeight(heights);
  const leadings = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const lead = lines[i].y - lines[i + 1].y;
    if (lead > 0) leadings.push(lead);
  }
  leadings.sort((a, b) => a - b);
  const medianLead = leadings[Math.floor(leadings.length / 2)] || medianH * 1.2;
  const maxH = Math.max(0, ...heights);
  return { medianH, medianLead, maxH, pageWidth };
}

function headingRole(line, next, stats) {
  if (!isHeadingLine(line, next, stats)) return "paragraph";
  return isPageTitleLine(line, stats) ? "title" : "heading";
}

function isPageTitleLine(line, stats) {
  const words = line.text.split(/\s+/).filter(Boolean);
  const titleLike = words.length <= 14 && !/[.!?]$/.test(line.text);
  if (!titleLike) return false;
  const veryLarge = line.height > stats.medianH * 1.55;
  const largest = stats.maxH > 0 && line.height >= stats.maxH * 0.95 && line.height > stats.medianH * 1.35;
  return veryLarge || largest;
}

function isHeadingLine(line, next, stats) {
  if (!line?.text) return false;
  if (/[A-Za-z]-$/.test(line.text)) return false;
  if (/^[a-z]/.test(line.text)) return false;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(line.text)) return false;
  const endsSentence = /[.!?]$/.test(line.text);
  if (endsSentence && line.text.length > 40) return false;
  const words = line.text.split(/\s+/).filter(Boolean);
  const short = words.length <= 12 && line.text.length <= 72 && !endsSentence;
  const larger = line.height > stats.medianH * 1.28;
  const allCaps = looksAllCaps(line.text);
  const cue = larger || line.bold || allCaps;
  if (cue && short) return true;
  if (cue && !endsSentence && words.length <= 14) return true;
  const nextIsLongBody =
    next && next.text.length >= 40 && !looksAllCaps(next.text) && next.height <= stats.medianH * 1.15;
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

function sortByTopLeft(boxes) {
  return [...(boxes || [])].sort((a, b) => {
    const ay = Number(a.rect?.top) || 0;
    const by = Number(b.rect?.top) || 0;
    const band = Math.max(6, Math.max(a.rect?.height || 0, b.rect?.height || 0) * 0.6);
    if (Math.abs(ay - by) > band) return ay - by;
    return (Number(a.rect?.left) || 0) - (Number(b.rect?.left) || 0);
  });
}

function inferWidth(boxes) {
  if (!boxes?.length) return 1;
  return Math.max(1, ...boxes.map((box) => (Number(box.rect?.left) || 0) + (Number(box.rect?.width) || 0)));
}

function detectBoxColumnSplit(boxes, pageWidth) {
  const body = (boxes || []).filter((box) => (Number(box.rect?.width) || 0) < pageWidth * 0.55);
  if (body.length < 4) return null;
  const mids = body.map((box) => (Number(box.rect?.left) || 0) + (Number(box.rect?.width) || 0) / 2).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < mids.length; i++) {
    gaps.push({ gap: mids[i] - mids[i - 1], splitX: (mids[i] + mids[i - 1]) / 2 });
  }
  gaps.sort((a, b) => b.gap - a.gap);
  const top = gaps[0];
  const second = gaps[1]?.gap || 0;
  if (!top || top.gap < pageWidth * 0.08) return null;
  if (second && top.gap < second * 1.6) return null;
  const rel = top.splitX / pageWidth;
  return rel > 0.28 && rel < 0.72 ? top.splitX : null;
}

function mergeYBands(rects) {
  const sorted = [...rects].sort((a, b) => a.top - b.top);
  const bands = [];
  for (const rect of sorted) {
    const last = bands[bands.length - 1];
    if (last && rect.top <= last.top + last.height + 8) {
      const right = Math.max(last.left + last.width, rect.left + rect.width);
      const bottom = Math.max(last.top + last.height, rect.top + rect.height);
      last.left = Math.min(last.left, rect.left);
      last.width = right - last.left;
      last.height = bottom - last.top;
    } else {
      bands.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
  }
  return bands;
}

function mergeVisuals(formulas, figures, pageWidth, pageHeight) {
  const out = formulas.slice();
  for (const figure of figures) {
    if (out.some((vis) => overlapRatio(vis.rect, figure.rect) > 0.4)) continue;
    if (figure.rect.width < pageWidth * 0.08 || figure.rect.height < pageHeight * 0.06) continue;
    out.push(figure);
  }
  return out;
}

function overlapRatio(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  const w = Math.max(0, right - left);
  const h = Math.max(0, bottom - top);
  const inter = w * h;
  const denom = Math.min(a.width * a.height, b.width * b.height, 1);
  return inter / Math.max(denom, 1);
}

function unitSquareCorners(ctm) {
  const m = Array.isArray(ctm) ? ctm : [1, 0, 0, 1, 0, 0];
  const map = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  return [map(0, 0), map(1, 0), map(1, 1), map(0, 1)];
}

function multiplyCtm(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

function median(values) {
  const list = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!list.length) return 0;
  return list[Math.floor(list.length / 2)];
}

function clampNum(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function roundCss(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
