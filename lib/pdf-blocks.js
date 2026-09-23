/** blocks-1 protocol, crop math, and block cleanup. No layout HTTP. */

import { cropCanvasToDataUrl } from "./pdf-mirror.js";
import { PDF_PAPER_PAD_X } from "./pdf-paper.js";

export const PROTOCOL = "blocks-1";
export const CROP_SCALE = 2;

export const LABELS = [
  "title",
  "heading",
  "text",
  "caption",
  "formula",
  "figure",
  "table",
  "header",
  "footer"
];

/** Engine ids. Wiring them to a service is a later phase; this module does not fetch. */
export const LAYOUT_MODES = [
  "text-layer", // 划区不可用时的兜底
  "local-ocr", // 测试期本机智谱 GLM-OCR
  "cloud-ocr" // 上线 OCR API
];

export const TEXT_LAYER_BAD_RATIO = 0.05;
export const TEXT_LAYER_PRINTABLE_RATIO = 0.6;

/** Placeholder token ⟦fN⟧. Fresh regex per call; the global one keeps lastIndex. */
export const PLACEHOLDER_RE = /⟦f(\d+)⟧/g;

export const OCR_PAGE_HINT =
  "本页文字层不可用，正文来自识别结果，可能有误差。公式、图、表仍是原页截图。";

/** Appended to both PDF translation requests. Webpage batches do not send this. */
export const PDF_PROMPT_ADDENDUM = [
  "The segment may contain tokens ⟦f1⟧ ⟦f2⟧ and so on. Copy every such token into the translation unchanged, with the same spelling, count, and order.",
  "Keep numbers, citation markers, and variable names exactly as written.",
  "Do not add, remove, or rewrite mathematical symbols. If a symbol appears outside a token, copy it unchanged.",
  "Faithfulness to the source outranks smoother wording."
].join("\n");

const TRANSLATABLE_LABELS = new Set(["title", "heading", "text", "caption"]);

const VISUAL_LABELS = new Set(["formula", "figure", "table"]);
const VISUAL_DROP_KEYS = ["latex", "content", "html", "md", "text"];
const VISUAL_ALT = { formula: "公式", figure: "图", table: "表" };

export function isVisualBlock(block) {
  return VISUAL_LABELS.has(block?.label);
}

/** Alt text is a kind name. Recognized formula letters never become the alt. */
export function visualAlt(label) {
  if (label === "figure" || label === "image") return "图";
  if (label === "table") return "表";
  return "公式";
}

export function isTranslatableBlock(block) {
  if (!block || block.skipTranslate === true) return false;
  if (!TRANSLATABLE_LABELS.has(block.label)) return false;
  return String(block.text || "").trim() !== "";
}

/** Natural-language blocks only. Formula, figure, and table stay out of the batch. */
export function translatableBlocks(blocks) {
  return (blocks || []).filter(isTranslatableBlock);
}

/** Write translations back by block id. Image fields on the source blocks stay put. */
export function applyBlockTranslations(blocks, results = []) {
  const byId = new Map();
  const ordered = [];
  for (const row of results || []) {
    const result = { translation: String(row?.translation || ""), status: row?.translationStatus || row?.status || "" };
    if (row?.id) byId.set(row.id, result);
    else ordered.push(result);
  }
  let cursor = 0;
  return (blocks || []).map((block) => {
    if (!isTranslatableBlock(block)) return { ...block };
    let result = { translation: "", status: "" };
    if (byId.has(block.id)) result = byId.get(block.id);
    else if (cursor < ordered.length) result = ordered[cursor++];
    return {
      ...block,
      translation: result.translation,
      ...(result.status ? { translationStatus: result.status } : {})
    };
  });
}

/** A translation with missing protected marks cannot safely place its formula crops. */
export function blockTranslationIntegrity(block = {}) {
  const translation = String(block.translation || "");
  if (!translation) return { valid: true, reason: "" };
  const sourceTokens = placeholderTokens(block.text).map((entry) => entry.token);
  const targetTokens = placeholderTokens(translation).map((entry) => entry.token);
  if (JSON.stringify(sourceTokens) !== JSON.stringify(targetTokens)) {
    return { valid: false, reason: "formula-placeholder-mismatch" };
  }
  const citations = (text) => [...String(text || "").matchAll(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g)]
    .map((match) => match[0].replace(/\s+/g, ""));
  if (JSON.stringify(citations(block.sourceText || block.text)) !== JSON.stringify(citations(translation)) ||
      /\[\s*(?:,\s*)*\]/.test(translation)) {
    return { valid: false, reason: "citation-mismatch" };
  }
  return { valid: true, reason: "" };
}

/** Split a verified sentence into text and original-page formula crops. */
export function blockRenderPieces(block, blocks = []) {
  const byId = new Map((blocks || []).map((item) => [item.id, item]));
  const placeholders = block?.placeholders || [];
  const known = new Map(placeholders.map((entry) => [entry.token, entry.blockId]));
  const source = String((blockTranslationIntegrity(block).valid ? block?.translation : "") || block?.text || "");
  const pieces = [];
  source.split(/(⟦f\d+⟧)/).forEach((part) => {
    const blockId = known.get(part);
    if (!blockId) {
      if (part) pieces.push({ type: "text", text: part });
      return;
    }
    const formula = byId.get(blockId);
    pieces.push({
      type: "image",
      blockId,
      alt: "公式",
      src: formula?.imageUrl || ""
    });
  });
  return pieces;
}

export function visualBlockMarkdown({ alt = "公式", src = "" } = {}) {
  const label = String(alt || "公式").trim() || "公式";
  const href = String(src || "").trim();
  return href ? `![${label}](${href})` : "见图";
}

export function rasterCropRect(bbox, pixelWidth, pixelHeight) {
  const [x0, y0, x1, y1] = bbox;
  const sx = Math.round(x0 * pixelWidth);
  const sy = Math.round(y0 * pixelHeight);
  const sw = Math.max(1, Math.round((x1 - x0) * pixelWidth));
  const sh = Math.max(1, Math.round((y1 - y0) * pixelHeight));
  return { sx, sy, sw, sh };
}

export function bboxToPercentRect(bbox) {
  const [x0, y0, x1, y1] = bbox;
  return { left: x0 * 100, top: y0 * 100, width: (x1 - x0) * 100, height: (y1 - y0) * 100 };
}

/** Crop a pageRaster canvas. Viewer calls this name so it does not name the mirror crop helper. */
export function cropBlockImage(canvas, bbox) {
  if (!canvas || !Array.isArray(bbox)) return "";
  const rect = rasterCropRect(bbox, canvas.width, canvas.height);
  if (rect.sw < 24 || rect.sh < 12) return "";
  return cropCanvasToDataUrl(canvas, bboxToPercentRect(bbox));
}

export function textLayerTrust(items) {
  const text = (items || []).map((item) => item.str || "").join("");
  if (!text.trim()) return { trusted: false, reason: "empty" };
  const bad = (text.match(/[\uFFFD\uE000-\uF8FF]/g) || []).length;
  const printable = (text.match(/[\u0020-\u007E\u00A0-\u024F\u0370-\u03FF\u4E00-\u9FFF]/g) || []).length;
  if (bad / text.length > TEXT_LAYER_BAD_RATIO || printable / text.length < TEXT_LAYER_PRINTABLE_RATIO) {
    return { trusted: false, reason: "garbled" };
  }
  return { trusted: true, reason: "text-layer" };
}

export function placeholderTokens(text) {
  return [...String(text || "").matchAll(/⟦f(\d+)⟧/g)].map((hit) => ({
    token: hit[0],
    n: Number(hit[1])
  }));
}

/** Visual blocks must not carry recognized letters onto the page or into translation. */
export function normalizeIncomingBlock(block) {
  if (!block || typeof block !== "object") return block;
  const next = { ...block };
  if (!isVisualBlock(next)) return next;
  for (const key of VISUAL_DROP_KEYS) delete next[key];
  return next;
}

/** Drop page chrome. Keep the remaining array order (reading order). */
export function preparePageBlocks(page = {}) {
  const blocks = [];
  for (const block of page.blocks || []) {
    const next = normalizeIncomingBlock(block);
    if (!next || next.label === "header" || next.label === "footer") continue;
    blocks.push(next);
  }
  return {
    ...page,
    protocol: page.protocol || PROTOCOL,
    blocks
  };
}

/**
 * Display-crop width as a fraction of the page (bbox x1 − x0).
 * This is not a percent of the padded readout column. Applying it there
 * shrinks the formula a second time; use displayContentColumnFraction.
 */
export function displayCropColumnFraction(block = {}) {
  if (block.label !== "formula" || block.inlineOf || block.display === false) return null;
  if (!Array.isArray(block.bbox) || block.bbox.length < 4) return null;
  const fraction = Number(block.bbox[2]) - Number(block.bbox[0]);
  if (!(fraction > 0)) return null;
  return Math.min(1, fraction);
}

/** Share of the paper width left after PDF_PAPER_PAD_X on both sides. */
export function contentColumnShare(padX = PDF_PAPER_PAD_X) {
  const pad = Number(padX);
  if (!Number.isFinite(pad) || !(pad > 0)) return 1;
  const share = 1 - 2 * pad;
  if (!(share > 0) || share > 1) return 1;
  return share;
}

/**
 * Hard floor for display height / right-pane body font-size: ≥ 1.6×.
 * Readable band is 1.6–2.0×. A natural ~3× after the width fix still passes
 * when it stays ≤ 5×. The old 2.5–3.5× band is not a fail gate.
 * The crop box is taller than the ink (#62 keeps a paper margin), so the
 * CSS min-height sits above the floor: 2em × ~0.8 ink share ≈ 1.6.
 * It only grows a crop that is still under the floor. It does not stretch
 * every formula up to the column.
 */
export const DISPLAY_INK_FLOOR = 1.6;
export const DISPLAY_CROP_MIN_HEIGHT_EM = 2;

/**
 * Width of a display crop as a fraction of the padded readout column.
 * pageFraction / (1 − 2×pad) undoes the second shrink. When the left page
 * is wider than the paper, scale toward it. Never above the column (1).
 */
export function displayContentColumnFraction(pageFraction, options = {}) {
  const fraction = Number(pageFraction);
  if (!(fraction > 0) || !Number.isFinite(fraction)) return null;
  let width = fraction / contentColumnShare(options.padX ?? PDF_PAPER_PAD_X);
  const left = Number(options.leftWidth);
  const paper = Number(options.paperWidth);
  if (paper > 0 && left > paper) width *= left / paper;
  if (!(width > 0) || !Number.isFinite(width)) return null;
  return Math.min(1, width);
}

function cssNumber(value) {
  const n = Math.round(Number(value) * 10000) / 10000;
  return String(n);
}

/**
 * CSS width for one display crop.
 * A′ percent of the content column, times left page / paper when the paper
 * is narrower, clamped to the column. If that box would still sit under the
 * 1.6× floor, grow only enough for min-height — not straight to 100%.
 */
export function displayCropWidthCss(pageFraction, bboxHeightFraction) {
  const fraction = Number(pageFraction);
  if (!(fraction > 0) || !Number.isFinite(fraction)) return "";
  const pct = cssNumber((fraction / contentColumnShare()) * 100);
  const boosted = `calc(var(--oi-pdf-left-w, var(--oi-pdf-paper-w, 1px)) / var(--oi-pdf-paper-w, 1px) * ${pct}%)`;
  const height = Number(bboxHeightFraction);
  if (!(height > 0) || !Number.isFinite(height)) return `min(100%, ${boosted})`;
  const floor = `calc(${cssNumber(DISPLAY_CROP_MIN_HEIGHT_EM)}em * var(--oi-pdf-paper-w, 0px) * ${cssNumber(fraction)} / (var(--oi-pdf-paper-h-base, 1px) * ${cssNumber(height)}))`;
  return `min(100%, max(${boosted}, ${floor}))`;
}

/** Right-pane plan for one blocks-1 item. Images are crops; no LaTeX render. */
export function blockReadoutPlan(block = {}) {
  const label = block.label;
  if (label === "title") return { tag: "h1", className: "oi-pdf-h1", text: block.text || "" };
  if (label === "heading") return { tag: "h2", className: "oi-pdf-h2", text: block.text || "" };
  if (label === "formula") {
    const display = block.display !== false && !block.inlineOf;
    return display
      ? {
          tag: "figure",
          className: "oi-pdf-display-math",
          image: true,
          imageClass: "oi-pdf-math-crop",
          role: "formula-display",
          alt: VISUAL_ALT.formula,
          src: block.imageUrl || ""
        }
      : {
          tag: "span",
          className: "oi-pdf-inline-math",
          image: true,
          imageClass: "oi-pdf-math-crop",
          role: "formula-inline",
          alt: VISUAL_ALT.formula,
          src: block.imageUrl || ""
        };
  }
  if (label === "figure" || label === "table") {
    return {
      tag: "figure",
      className: "oi-pdf-figure",
      image: true,
      imageClass: "oi-pdf-asset-crop",
      alt: VISUAL_ALT[label] || "",
      src: block.imageUrl || ""
    };
  }
  if (label === "caption") {
    return {
      tag: "figcaption",
      className: "oi-pdf-caption",
      text: block.text || "",
      role: "caption"
    };
  }
  if (isVisualBlock(block)) {
    return {
      tag: "p",
      className: "oi-pdf-p",
      image: true,
      alt: VISUAL_ALT[label] || "",
      src: block.imageUrl || ""
    };
  }
  return {
    tag: "p",
    className: "oi-pdf-p",
    text: block.text || "",
    role: block.presentation === "byline" ? "authors" : ""
  };
}
