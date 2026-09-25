/** Vendor envelope → blocks-1. Formula and table letters are dropped before display. */

import { PROTOCOL, isVisualBlock, normalizeIncomingBlock, preparePageBlocks, textLayerTrust } from "./pdf-blocks.js";
import { looksLikeCaption, looksLikeFormulaItem } from "./pdf-mirror.js";
import { lineShouldBeOneFormula, textLayerToBlocks } from "./pdf-text-layer.js";
import { collapseAuthorBlocks, isPageChromeText, looksLikeAuthorLine } from "./pdf-readout.js";

const SECTION_HEADING = /^(abstract|introduction|related work|conclusion|appendix|references|bibliography|摘要|引言|结论|参考文献)$/i;
const REFERENCES_HEADING = /^(references|bibliography|参考文献)\b/i;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function asBbox(value) {
  const raw = value?.bbox_2d || value?.bbox || value;
  if (!Array.isArray(raw) || raw.length < 4) return null;
  let [x0, y0, x1, y1] = raw.map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  return [clamp01(x0), clamp01(y0), clamp01(x1), clamp01(y1)];
}

function detailsOf(envelope) {
  const src = envelope && typeof envelope === "object" ? envelope : {};
  return src.layoutDetails || src.layout_details || src.data?.layout_details || src.data?.layoutDetails || [];
}

function itemBox(item, viewport) {
  const transform = Array.isArray(item?.transform) ? item.transform : [];
  const x = Number.isFinite(Number(item?.x)) ? Number(item.x) : Number(transform[4]) || 0;
  const y = Number.isFinite(Number(item?.y)) ? Number(item.y) : Number(transform[5]) || 0;
  const width = Number(item?.width) || 0;
  const height = Number(item?.height) || 0;
  const rect = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
  const [x1, y1, x2, y2] = rect;
  const vw = Math.max(1, Number(viewport.width) || 1);
  const vh = Math.max(1, Number(viewport.height) || 1);
  return [
    clamp01(Math.min(x1, x2) / vw),
    clamp01(Math.min(y1, y2) / vh),
    clamp01(Math.max(x1, x2) / vw),
    clamp01(Math.max(y1, y2) / vh)
  ];
}

function centerInside(box, bbox) {
  if (!box || !bbox) return false;
  const x = (box[0] + box[2]) / 2;
  const y = (box[1] + box[3]) / 2;
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
}

function joinItems(items) {
  const sorted = [...items].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  let text = "";
  let prev = null;
  for (const item of sorted) {
    const piece = String(item.str || "");
    if (prev) {
      const gap = item.box[0] - prev.box[2];
      if (gap > 0.004 && !/\s$/.test(text) && !/^\s/.test(piece)) text += " ";
    }
    text += piece;
    prev = item;
  }
  return text.replace(/\s+/g, " ").trim();
}

function mappedLabel(label) {
  if (label === "image") return "figure";
  if (label === "formula" || label === "table" || label === "text") return label;
  return "";
}

function relabelText(blocks) {
  let seenTitle = false;
  let inRefs = false;
  const drafted = blocks.map((block) => {
    if (block.label !== "text") return { ...block, role: block.label };
    const text = String(block.text || "");
    let label = "text";
    let skipTranslate = false;
    if (isPageChromeText(text)) label = (block.bbox?.[1] || 0) > 0.85 ? "footer" : "header";
    else if (looksLikeCaption(text)) label = "caption";
    else if (REFERENCES_HEADING.test(text)) {
      label = "heading";
      skipTranslate = true;
      inRefs = true;
    } else if (SECTION_HEADING.test(text)) label = "heading";
    else if (!seenTitle && text && text.length < 160 && !/[.!?]$/.test(text) && !looksLikeAuthorLine(text)) {
      label = "title";
      seenTitle = true;
    } else if (inRefs) skipTranslate = true;
    return { ...block, label, role: label === "text" ? "paragraph" : label, text, skipTranslate };
  });
  return collapseAuthorBlocks(drafted).map((block) => {
    if (block.role === "authors") {
      return {
        ...block,
        label: "text",
        presentation: "byline",
        skipTranslate: true,
        role: undefined
      };
    }
    const next = { ...block };
    delete next.role;
    if (!next.skipTranslate) delete next.skipTranslate;
    return next;
  });
}

/**
 * @param {object} envelope vendor layout_parsing payload
 * @param {{ items?: array, viewport?: object, page?: number }} context
 */
export function vendorLayoutToBlocks(envelope = {}, context = {}) {
  const viewport = context.viewport || {
    width: envelope.pixelWidth || 1,
    height: envelope.pixelHeight || 1,
    convertToViewportRectangle: (rect) => rect
  };
  const rawItems = Array.isArray(context.items) ? context.items : [];
  const trust = textLayerTrust(rawItems.map((item) => ({ str: item?.str || "" })));
  const located = rawItems.map((item) => ({ ...item, str: String(item?.str || ""), box: itemBox(item, viewport) }));
  const parsed = [];
  for (const detail of detailsOf(envelope)) {
    const label = mappedLabel(String(detail?.label || "").toLowerCase());
    const bbox = asBbox(detail);
    if (!label || !bbox) continue;
    parsed.push({ label, bbox, detail });
  }
  const visualBoxes = parsed.filter((item) => item.label !== "text").map((item) => item.bbox);
  const inVisualBox = (item) => visualBoxes.some((bbox) => centerInside(item.box, bbox));
  if (trust.trusted) {
    // Analyze the complete PDF first. Pre-filtering by partial vendor boxes loses
    // figure labels, table cells, and the ordinary-font half of an equation.
    const page = Number(context.page || envelope.page) || 1;
    const source = textLayerToBlocks({
      items: rawItems,
      viewport,
      images: context.images,
      page,
      styles: context.styles
    });
    const blocks = [...source.blocks];
    for (const [index, candidate] of parsed.entries()) {
      if (candidate.label !== "formula") continue;
      if (blocks.some((block) => block.label === "formula" && centerInside(block.bbox, candidate.bbox))) continue;
      const inside = located.filter((item) => centerInside(item.box, candidate.bbox));
      const sourceText = joinItems(inside);
      const plausible = lineShouldBeOneFormula(inside) ||
        /^(softmax|LayerNorm|Attention)\s*\(?[A-Za-z0-9, ]*\)?$/i.test(sourceText);
      if (!plausible || !inside.length) continue;
      const pure = blocks.find((block) =>
        ["text", "title", "heading"].includes(block.label) && centerInside(block.bbox, candidate.bbox) &&
        String(block.sourceText || block.text || "").trim() === sourceText);
      if (!pure) continue;
      blocks.splice(blocks.indexOf(pure), 1);
      const visual = normalizeIncomingBlock({
        id: `p${page}-v${index + 1}`,
        sourceId: pure.sourceId,
        label: "formula",
        bbox: candidate.bbox
      });
      blocks.push(visual);
      for (const item of source.sourceAudit?.items || []) {
        if (item.blockId !== pure.id) continue;
        item.owner = "visual";
        item.blockId = visual.id;
      }
    }
    blocks.sort((a, b) => (a.bbox?.[1] || 0) - (b.bbox?.[1] || 0));
    blocks.forEach((block, index) => {
      if (block.label !== "caption") return;
      const figureId = blocks.slice(0, index).reverse().find((item) => item.label === "figure")?.id;
      if (figureId) block.captionFor = figureId;
    });
    return preparePageBlocks({
      protocol: PROTOCOL,
      page,
      pixelWidth: Number(envelope.pixelWidth) || source.pixelWidth,
      pixelHeight: Number(envelope.pixelHeight) || source.pixelHeight,
      textSource: "text-layer",
      blocks,
      sourceAudit: source.sourceAudit
    });
  }
  const blocks = [];
  for (const item of parsed) {
    if (item.label === "text") {
      const inside = located.filter((entry) => centerInside(entry.box, item.bbox) && !inVisualBox(entry));
      const vendorText = String(item.detail?.content || "");
      if (trust.trusted && lineShouldBeOneFormula(inside)) {
        blocks.push(normalizeIncomingBlock({
          label: "formula",
          bbox: item.bbox,
          content: vendorText
        }));
        continue;
      }
      if (trust.trusted && inside.some((entry) => looksLikeFormulaItem(entry))) {
        const nested = textLayerToBlocks({ items: inside, viewport, page: context.page || envelope.page });
        blocks.push(...(nested.blocks || []));
        continue;
      }
      blocks.push({
        label: "text",
        bbox: item.bbox,
        text: trust.trusted ? joinItems(inside) : vendorText,
        vendorText
      });
      continue;
    }
    const detail = item.detail;
    blocks.push(normalizeIncomingBlock({
      label: item.label,
      bbox: item.bbox,
      content: detail?.content,
      html: detail?.html,
      latex: detail?.latex,
      md: detail?.md,
      text: detail?.content
    }));
  }
  const labeled = relabelText(blocks).map((block) => {
    const next = { ...block };
    delete next.vendorText;
    return next;
  });
  const kept = labeled.filter((block) => {
    if (isVisualBlock(block)) return true;
    if (trust.trusted) return Boolean(block.label);
    return String(block.text || "").trim() !== "";
  });
  const page = Number(context.page || envelope.page) || 1;
  return preparePageBlocks({
    protocol: PROTOCOL,
    page,
    pixelWidth: Number(envelope.pixelWidth) || 0,
    pixelHeight: Number(envelope.pixelHeight) || 0,
    textSource: trust.trusted ? "text-layer" : "ocr",
    blocks: kept
  });
}
