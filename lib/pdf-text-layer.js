/** Text-layer fallback: body sentences from the PDF text layer, formulas and figures as page crops. */

import { CROP_SCALE, PROTOCOL, preparePageBlocks, textLayerTrust } from "./pdf-blocks.js";
import {
  imageRectsFromUnitCtms,
  looksLikeCaption,
  looksLikeFormulaItem,
  walkImageCtms
} from "./pdf-mirror.js";
import { collapseAuthorBlocks, isPageChromeItem, looksLikeAuthorLine } from "./pdf-readout.js";
import { paragraphsFromLines, readingOrderLines } from "./pdf-viewer.js";

const FORMULA_WORDS = new Set([
  "softmax",
  "LayerNorm",
  "Attention",
  "exp",
  "log",
  "sin",
  "cos",
  "tan",
  "max",
  "min"
]);

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function unionBbox(boxes) {
  const list = (boxes || []).filter((box) => Array.isArray(box) && box.length >= 4);
  if (!list.length) return null;
  return [
    Math.min(...list.map((box) => box[0])),
    Math.min(...list.map((box) => box[1])),
    Math.max(...list.map((box) => box[2])),
    Math.max(...list.map((box) => box[3]))
  ];
}

function padBbox(bbox, pad) {
  if (!bbox) return null;
  return [
    clamp01(bbox[0] - pad),
    clamp01(bbox[1] - pad),
    clamp01(bbox[2] + pad),
    clamp01(bbox[3] + pad)
  ];
}

function itemBbox(item, viewport) {
  const x = Number(item.x) || 0;
  const y = Number(item.y) || 0;
  const width = Number(item.width) || 0;
  const height = Number(item.height) || 0;
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

function hasOrdinaryWord(text) {
  const words = String(text || "").match(/[A-Za-z]{4,}/g) || [];
  return words.some((word) => !FORMULA_WORDS.has(word));
}

function pushPiece(state, piece, item) {
  if (state.prev) {
    const gap = item.x - (state.prev.x + state.prev.width);
    const spaceWidth = Math.max(state.prev.height || 0, item.height || 0, 8) * 0.22;
    if (gap > spaceWidth && piece && !/\s$/.test(state.text) && !/^\s/.test(piece)) state.text += " ";
  }
  state.text += piece;
  state.prev = item;
}

function figureDrafts(images, viewport) {
  const width = Math.max(1, Number(viewport.width) || 1);
  const height = Math.max(1, Number(viewport.height) || 1);
  let rects = [];
  if (images?.fnArray) {
    rects = imageRectsFromUnitCtms(walkImageCtms(images.fnArray, images.argsArray || []), height);
  } else if (Array.isArray(images) && images[0]?.ctm) {
    rects = imageRectsFromUnitCtms(images, height);
  }
  return rects
    .filter((item) => {
      const rect = item?.rect;
      if (!rect) return false;
      if (rect.width < width * 0.04 && rect.height < height * 0.04) return false;
      return true;
    })
    .map((item) => ({
      kind: "figure",
      bbox: [
        item.rect.left / width,
        item.rect.top / height,
        (item.rect.left + item.rect.width) / width,
        (item.rect.top + item.rect.height) / height
      ]
    }));
}

function formulaDraft(items, viewport, host) {
  const boxes = items.map((item) => itemBbox(item, viewport));
  return {
    kind: "formula",
    bbox: host ? unionBbox(boxes) : padBbox(unionBbox(boxes), 0.004),
    inlineOf: host || null
  };
}

function mixedDraft(line, viewport, nextFormula) {
  const items = [...(line.items || [])].sort((a, b) => a.x - b.x);
  const state = { text: "", prev: null };
  const placeholders = [];
  let host = null;
  const ensureHost = () => {
    if (host) return host;
    host = { kind: "prose", role: "paragraph", text: "", bbox: null, placeholders: [], sourceItems: [] };
    return host;
  };
  let index = 0;
  while (index < items.length) {
    if (!looksLikeFormulaItem(items[index])) {
      const prose = [];
      while (index < items.length && !looksLikeFormulaItem(items[index])) {
        prose.push(items[index]);
        index += 1;
      }
      prose.forEach((item) => pushPiece(state, item.str, item));
      ensureHost().sourceItems.push(...prose);
      continue;
    }
    const run = [];
    while (index < items.length && looksLikeFormulaItem(items[index])) {
      run.push(items[index]);
      index += 1;
    }
    const token = `⟦f${nextFormula()}⟧`;
    const formula = formulaDraft(run, viewport, ensureHost());
    pushPiece(state, token, run[0]);
    placeholders.push({ token, formula });
  }
  host = ensureHost();
  host.text = state.text.replace(/\s+/g, " ").trim();
  host.placeholders = placeholders;
  host.bbox = unionBbox(host.sourceItems.map((item) => itemBbox(item, viewport)));
  if (looksLikeCaption(host.text)) host.role = "caption";
  return [host, ...placeholders.map((entry) => entry.formula)];
}

function proseDrafts(lines, allLines, viewport) {
  return paragraphsFromLines(lines, allLines).map((block) => ({
    kind: "prose",
    role: looksLikeCaption(block.text) ? "caption" : block.role,
    text: block.text,
    bbox: unionBbox((block.sourceItems || []).map((item) => itemBbox(item, viewport))),
    placeholders: [],
    sourceItems: block.sourceItems || []
  }));
}

function insertFigures(drafts, figures) {
  const ordered = drafts.slice();
  const pending = figures.slice().sort((a, b) => a.bbox[1] - b.bbox[1]);
  for (const figure of pending) {
    const at = ordered.findIndex((draft) => draft.bbox && draft.bbox[1] > figure.bbox[1]);
    if (at < 0) ordered.push(figure);
    else ordered.splice(at, 0, figure);
  }
  return ordered;
}

function nearestFigureId(blocks, index) {
  let best = null;
  let bestDist = Infinity;
  let bestBefore = false;
  blocks.forEach((block, i) => {
    if (block.label !== "figure") return;
    const dist = Math.abs(i - index);
    const before = i < index;
    if (dist < bestDist || (dist === bestDist && before && !bestBefore)) {
      bestDist = dist;
      best = block.id;
      bestBefore = before;
    }
  });
  return best;
}

function toProtocol(drafts, pageNumber, trust) {
  const page = Number(pageNumber) || 1;
  drafts.forEach((draft, index) => {
    draft.id = `p${page}-b${index + 1}`;
  });
  const blocks = drafts.map((draft) => {
    if (draft.kind === "figure") return { id: draft.id, label: "figure", bbox: draft.bbox };
    if (draft.kind === "formula") {
      const block = { id: draft.id, label: "formula", bbox: draft.bbox };
      if (draft.inlineOf?.id) block.inlineOf = draft.inlineOf.id;
      return block;
    }
    const role = draft.role;
    let label = "text";
    if (role === "title") label = "title";
    else if (role === "heading") label = "heading";
    else if (role === "caption") label = "caption";
    const text = trust.trusted ? draft.text || "" : "";
    const block = { id: draft.id, label, bbox: draft.bbox, text };
    if (role === "authors") {
      block.label = "text";
      block.skipTranslate = true;
      block.presentation = "byline";
    }
    if (draft.placeholders?.length && trust.trusted) {
      block.placeholders = draft.placeholders.map((entry) => ({
        token: entry.token,
        blockId: entry.formula.id
      }));
    }
    return block;
  });
  blocks.forEach((block, index) => {
    if (block.label !== "caption") return;
    const figureId = nearestFigureId(blocks, index);
    if (figureId) block.captionFor = figureId;
  });
  return blocks;
}

/**
 * Page object for one digital PDF page.
 * `images` is `{ fnArray, argsArray }` from pdf.js getOperatorList, or CTM entries.
 */
export function textLayerToBlocks({ items, viewport, images, page } = {}) {
  const view = viewport || { width: 1, height: 1, convertToViewportRectangle: (rect) => rect };
  const pageNumber = Number(page) || 1;
  const raw = Array.isArray(items) ? items : [];
  const trust = textLayerTrust(raw.map((item) => ({ str: item?.str || item?.text || "" })));
  const normalized = raw.map((item) => {
    const transform = Array.isArray(item?.transform) ? item.transform : [];
    return {
      ...item,
      str: String(item?.str || ""),
      x: Number.isFinite(Number(item?.x)) ? Number(item.x) : Number(transform[4]) || 0,
      y: Number.isFinite(Number(item?.y)) ? Number(item.y) : Number(transform[5]) || 0,
      width: Number(item?.width) || 0,
      height: Number(item?.height) || 0,
      fontName: String(item?.fontName || "")
    };
  });
  const visible = normalized.filter((item) => !isPageChromeItem(item, { width: view.width, height: view.height }));
  const lines = readingOrderLines(visible);
  const drafts = [];
  let prose = [];
  let formulaSerial = 0;
  const nextFormula = () => {
    formulaSerial += 1;
    return formulaSerial;
  };
  const flushProse = () => {
    if (!prose.length) return;
    drafts.push(...proseDrafts(prose, lines, view));
    prose = [];
  };
  for (const line of lines) {
    const parts = line.items || [];
    const formulaItems = parts.filter((item) => looksLikeFormulaItem(item));
    const proseItems = parts.filter((item) => !looksLikeFormulaItem(item));
    const formulaLine = proseItems.length === 0 || (formulaItems.length > 0 && proseItems.length === 0);
    if (formulaLine && parts.length) {
      flushProse();
      drafts.push(formulaDraft(parts, view, null));
      continue;
    }
    if (formulaItems.length && proseItems.length) {
      if (hasOrdinaryWord(line.text) && proseItems.length === 0) {
        flushProse();
        drafts.push(formulaDraft(parts, view, null));
        continue;
      }
      flushProse();
      drafts.push(...mixedDraft(line, view, nextFormula));
      continue;
    }
    prose.push(line);
  }
  flushProse();
  const titleAt = drafts.findIndex((draft) => draft.role === "title");
  const authorBoxes = [];
  if (titleAt >= 0) {
    drafts.forEach((draft, index) => {
      if (index > titleAt && looksLikeAuthorLine(draft.text)) authorBoxes.push(draft.bbox);
    });
  }
  const withAuthors = collapseAuthorBlocks(drafts).map((draft) => {
    if (draft.role !== "authors") return draft;
    return {
      ...draft,
      kind: "prose",
      bbox: unionBbox(authorBoxes),
      placeholders: draft.placeholders || []
    };
  });
  const figures = figureDrafts(images, view);
  const ordered = insertFigures(withAuthors, figures);
  const blocks = toProtocol(ordered, pageNumber, trust);
  const kept = trust.trusted ? blocks : blocks.filter((block) => block.label === "figure");
  return preparePageBlocks({
    protocol: PROTOCOL,
    page: pageNumber,
    pixelWidth: Math.round((Number(view.width) || 0) * CROP_SCALE),
    pixelHeight: Math.round((Number(view.height) || 0) * CROP_SCALE),
    textSource: trust.trusted ? "text-layer" : "ocr",
    blocks: kept
  });
}

export { looksLikeAuthorLine };
