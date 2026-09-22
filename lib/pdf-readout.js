/** PDF right pane: reading-order Markdown, not bbox / pixel mirror. */

import { articleBlocksToMarkdown } from "./export.js";
import {
  formulaDisplayMode,
  formulaExportMarkdown,
  recoverFormulaLatex
} from "./pdf-latex.js";
import { inferPageSize, looksLikeCaption, looksLikeFormulaItem } from "./pdf-mirror.js";
import {
  articleNodeSpec,
  extractPageItems,
  normalizeBlockRole,
  segmentPageBlocks
} from "./pdf-viewer.js";

export const DEFAULT_PDF_VIEW = "readout";

export const PDF_READOUT_COPY = {
  caption: "通读",
  hint: "按阅读顺序提取标题与正文，译成 Markdown 通读。公式尽量用 LaTeX；图可略。",
  figurePlaceholder: "［图］",
  formulaFallback: "（公式见左栏）",
  noTextLayerHint: "本页没有文字层，无法提取阅读文本。扫描件翻译将在后续版本支持。"
};

const PAGE_NUM_RE = /^(?:[-–—]\s*)?\d{1,4}(?:\s*[-–—])?$/;
const ARXIV_RE = /^arXiv:\s*\d{4}\.\d+/i;
const PERMISSION_RE = /provided proper attribution|reproduce the tables and figures in this paper/i;
const ARXIV_GLYPH_RE = /^[arXiv:\d.[\]csCL /-]$/i;

export function isArxivStampText(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) return false;
  if (/arxiv:\d{4}\.\d+/i.test(compact)) return true;
  if (/^arxiv/i.test(compact) && compact.length < 48) return true;
  return false;
}

export function isArxivMarginItem(item, page = {}) {
  const text = String(item?.str || item?.text || "").trim();
  if (isArxivStampText(text)) return true;
  const w = Number(page.width) || 0;
  const x = Number(item?.x);
  if (!Number.isFinite(x) || w <= 0) return false;
  if (x > w * 0.09) return false;
  if (text.length <= 2 && ARXIV_GLYPH_RE.test(text)) return true;
  return false;
}

export function isPageChromeText(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (PAGE_NUM_RE.test(t)) return true;
  if (isArxivStampText(t) || ARXIV_RE.test(t)) return true;
  if (/^https?:\/\/arxiv\.org/i.test(t)) return true;
  if (PERMISSION_RE.test(t)) return true;
  if (/^preprint\b/i.test(t) && t.length < 48) return true;
  return false;
}

export function isPageChromeItem(item, page = {}) {
  const text = String(item?.str || item?.text || "").trim();
  if (isArxivMarginItem(item, page)) return true;
  const h = Number(page.height) || 0;
  // A reference marker or a subscript digit in the body is not the page number.
  if (PAGE_NUM_RE.test(text)) {
    const y = Number(item?.y);
    return h > 0 && Number.isFinite(y) && (y < h * 0.07 || y > h * 0.93);
  }
  if (isPageChromeText(text)) return true;
  if (!h) return false;
  const y = Number(item?.y);
  const height = Number(item?.height) || 0;
  if (!Number.isFinite(y)) return false;
  if (height >= 14) return false;
  if (text.length > 120) return false;
  const fromTop = h - y - height;
  const fromBottom = y;
  if (fromTop < h * 0.07 || fromBottom < h * 0.075) {
    if (/proceedings|conference|workshop|neurips|nips 20|icml|iclr|acl 20/i.test(text)) return true;
    if (fromTop < h * 0.05 && height <= 9 && text.length < 90) return true;
    if (fromBottom < h * 0.05 && text.length < 40) return true;
  }
  return false;
}

export function looksLikeAuthorLine(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 200) return false;
  if (/^(abstract|introduction|conclusion|references|acknowledgements?|related work)$/i.test(t)) {
    return false;
  }
  if (/@/.test(t)) return true;
  if (/^(google|university|openai|deepmind|microsoft|facebook|meta|stanford|mit|berkeley|research)\b/i.test(t)) {
    return true;
  }
  if (/[.!?]/.test(t) && t.length > 40) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const nameLike = words.filter((w) => /^[A-Z][A-Za-z.`'\-]*$/.test(w) || /^[A-Z]\.$/.test(w)).length;
  if (nameLike >= 2 && nameLike >= words.length * 0.7 && words.length <= 24) return true;
  return words.length <= 6 && /^[A-Z]/.test(t) && !/[.!?]$/.test(t);
}

export function looksLikeFormulaText(text, fontName = "") {
  const str = String(text || "").trim();
  if (!str || str.length > 200) return false;
  if (looksLikeFormulaItem({ str, fontName })) return true;
  if (/\b(softmax|LayerNorm)\b/.test(str) && /=/.test(str)) return true;
  return /^[A-Za-z][A-Za-z0-9]*\s*\(.*\)\s*=/.test(str) && str.length < 160;
}

export function uniqueKeepOrder(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export function collapseAuthorBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const titleIdx = list.findIndex((block) => normalizeBlockRole(block?.role) === "title");
  if (titleIdx < 0) return list;
  const authors = [];
  const kept = [];
  list.forEach((block, index) => {
    if (index > titleIdx && isAuthorish(block)) {
      authors.push(block.text || block.original);
      return;
    }
    kept.push(block);
  });
  if (!authors.length) return list;
  const insertAt = kept.findIndex((block) => normalizeBlockRole(block?.role) === "title") + 1;
  kept.splice(insertAt, 0, {
    text: uniqueKeepOrder(authors).join(" · "),
    role: "authors",
    kind: "text"
  });
  return kept;
}

function isAuthorish(block) {
  const role = normalizeBlockRole(block?.role);
  if (role === "title" || role === "heading" || role === "formula" || role === "caption" || role === "figure") {
    return false;
  }
  if (role === "authors") return true;
  return looksLikeAuthorLine(block?.text || block?.original);
}

export function enrichReadoutBlock(block) {
  const text = String(block?.text || block?.original || "").trim();
  if (!text) return null;
  if (looksLikeFormulaText(text, block?.fontName)) {
    const latex = String(block.latex || "").trim() || recoverFormulaLatex(text);
    const display = block.display === true || formulaDisplayMode({ text, latex }, block.pageWidth);
    return {
      ...block,
      text,
      role: "formula",
      kind: "math",
      latex,
      display
    };
  }
  if (looksLikeCaption(text)) {
    return { ...block, text, role: "caption", kind: "text" };
  }
  return {
    ...block,
    text,
    role: normalizeBlockRole(block.role),
    kind: block.kind || "text"
  };
}

export function extractReadoutBlocks(input, pageSize = {}) {
  const raw = Array.isArray(input) ? input : input?.items || [];
  const items = extractPageItems({ items: raw }).map((item) => ({
    ...item,
    text: item.str,
    fontName: String(item.fontName || "")
  }));
  const size = inferPageSize(items, pageSize);
  const visible = items.filter((item) => !isPageChromeItem(item, size));
  const segmented = segmentPageBlocks(visible).filter((block) => !isArxivStampText(block.text));
  return collapseAuthorBlocks(segmented.map(enrichReadoutBlock).filter(Boolean));
}

export function translatableReadoutUnits(blocks) {
  return (blocks || [])
    .map((block) => {
      const role = normalizeBlockRole(block.role);
      const text = String(block.text || block.original || "").trim();
      return { ...block, text, original: text, role };
    })
    .filter((block) => block.text && block.role !== "formula" && block.role !== "figure");
}

export function mergeReadoutTranslations(sourceBlocks, results = []) {
  const source = sourceBlocks || [];
  const list = results || [];
  if (list.length && list.length === source.length && list.some((row) => row.role === "formula" || row.latex)) {
    return list;
  }
  let i = 0;
  return source.map((block) => {
    const role = normalizeBlockRole(block.role);
    if (role === "formula") {
      const latex = String(block.latex || "").trim() || recoverFormulaLatex(block.text);
      const display = block.display === true || formulaDisplayMode({ text: block.text, latex }, block.pageWidth);
      return {
        ...block,
        original: block.text,
        role: "formula",
        kind: "math",
        latex,
        display,
        translation: formulaExportMarkdown({ latex, display, sourceText: block.text })
      };
    }
    if (role === "figure") {
      return {
        ...block,
        original: block.text,
        role: "figure",
        translation: String(block.text || "").trim() || PDF_READOUT_COPY.figurePlaceholder
      };
    }
    const hit = list[i] || {};
    i += 1;
    return {
      ...block,
      original: hit.original || block.text,
      translation: String(hit.translation || "").trim(),
      role: hit.role || role
    };
  });
}

export function readoutFlowForPage(layout, cached) {
  if (layout?.kind === "readout" && layout.blocks?.length) {
    return mergeReadoutTranslations(layout.blocks, cached || []);
  }
  return (cached || []).filter((item) => item?.translation || item?.latex);
}

export function readoutBlocksToMarkdown(blocks) {
  return articleBlocksToMarkdown(
    (blocks || [])
      .map((block) => {
        const role = normalizeBlockRole(block.role);
        const spec = articleNodeSpec({
          ...block,
          translation: block.translation || block.text
        });
        const text =
          role === "formula"
            ? formulaExportMarkdown({
                latex: block.latex,
                display: block.display,
                sourceText: block.text || block.original
              })
            : spec.text;
        return { tag: spec.tag, text };
      })
      .filter((node) => node.text)
  );
}

export function readoutHasBboxLayout(node) {
  if (!node) return false;
  const style = node.style || {};
  const pos = String(style.position || "");
  if (pos === "absolute" || pos === "fixed") return true;
  if (node.classList?.contains?.("mirror-box") || node.classList?.contains?.("mirror-item")) return true;
  if (node.dataset?.bbox) return true;
  return false;
}
