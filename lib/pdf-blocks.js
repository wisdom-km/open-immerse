/** blocks-1 protocol, crop math, and block cleanup. No layout HTTP. */

import { cropCanvasToDataUrl } from "./pdf-mirror.js";

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
    const translation = String(row?.translation || "");
    if (row?.id) byId.set(row.id, translation);
    else ordered.push(translation);
  }
  let cursor = 0;
  return (blocks || []).map((block) => {
    if (!isTranslatableBlock(block)) return { ...block };
    let translation = "";
    if (byId.has(block.id)) translation = byId.get(block.id);
    else if (cursor < ordered.length) translation = ordered[cursor++];
    return { ...block, translation };
  });
}

/**
 * Split a translated sentence into text and formula images.
 * Missing tokens are appended, in placeholder order, so a polish pass cannot drop a figure.
 */
export function blockRenderPieces(block, blocks = []) {
  const byId = new Map((blocks || []).map((item) => [item.id, item]));
  const placeholders = block?.placeholders || [];
  const known = new Map(placeholders.map((entry) => [entry.token, entry.blockId]));
  const source = String(block?.translation || block?.text || "");
  const pieces = [];
  const used = new Set();
  source.split(/(⟦f\d+⟧)/).forEach((part) => {
    const blockId = known.get(part);
    if (!blockId) {
      if (part) pieces.push({ type: "text", text: part });
      return;
    }
    used.add(part);
    const formula = byId.get(blockId);
    pieces.push({
      type: "image",
      blockId,
      alt: "公式",
      src: formula?.imageUrl || ""
    });
  });
  placeholders.forEach((entry) => {
    if (used.has(entry.token)) return;
    const formula = byId.get(entry.blockId);
    pieces.push({
      type: "image",
      blockId: entry.blockId,
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

/** Right-pane plan for one blocks-1 item. Images are crops; no LaTeX render. */
export function blockReadoutPlan(block = {}) {
  const label = block.label;
  if (label === "title") return { tag: "h1", className: "oi-pdf-h1", text: block.text || "" };
  if (label === "heading") return { tag: "h2", className: "oi-pdf-h2", text: block.text || "" };
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
