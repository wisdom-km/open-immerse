/** Text-layer fallback: body sentences from the PDF text layer, formulas and figures as page crops. */

import { CROP_SCALE, PROTOCOL, preparePageBlocks, textLayerTrust } from "./pdf-blocks.js";
import {
  imageRectsFromUnitCtms,
  looksLikeCaption,
  looksLikeFormulaItem,
  walkImageCtms
} from "./pdf-mirror.js";
import { isPageChromeItem, looksLikeAuthorLine } from "./pdf-readout.js";
import { paragraphsFromLines, readingOrderLines } from "./pdf-viewer.js";

const FORMULA_WORD = /^(softmax|layernorm|attention|multihead|concat|ffn|head|where|sqrt|exp|log|sin|cos|tan|max|min)$/i;
const FORMULA_WORDS = new Set([
  "softmax",
  "LayerNorm",
  "Attention",
  "MultiHead",
  "Concat",
  "FFN",
  "head",
  "where",
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

function padBbox(bbox, padX, padY = padX) {
  if (!bbox) return null;
  return [
    clamp01(bbox[0] - padX),
    clamp01(bbox[1] - padY),
    clamp01(bbox[2] + padX),
    clamp01(bbox[3] + padY)
  ];
}

/**
 * Hairline around the glyph union. Script/delimiter runs may add scriptX/scriptY.
 * This is not a whole-line inflate: contentAwareFormulaBbox stops at neighboring
 * glyphs, captions, and figure/table regions.
 */
export const FORMULA_CROP_PAD = {
  displayX: 0.003,
  displayY: 0.0018,
  inlineX: 0.0014,
  inlineY: 0.0011,
  scriptX: 0.0012,
  scriptY: 0.0016
};

/** About 6 CSS px of paper margin at crop scale 2, shown near 1 image pixel per CSS pixel. */
const FORMULA_PAD_LIMIT = { x: 0.0049, y: 0.0038 };

const FORMULA_OBSTACLE_GAP = 0.0012;

/** Keep a small margin, then stop before the next glyph, caption, or figure. */
export function contentAwareFormulaBbox(glyphBox, pad, obstacles = []) {
  if (!glyphBox) return null;
  const padX = Math.max(0, Number(pad?.x) || 0);
  const padY = Math.max(0, Number(pad?.y) || 0);
  const [x0, y0, x1, y1] = glyphBox;
  let left = x0 - padX;
  let top = y0 - padY;
  let right = x1 + padX;
  let bottom = y1 + padY;
  for (const box of obstacles) {
    if (!Array.isArray(box) || box.length < 4) continue;
    const [a0, b0, a1, b1] = box;
    if (!(a1 > a0) || !(b1 > b0)) continue;
    const vBand = b0 < bottom && b1 > top;
    const hBand = a0 < right && a1 > left;
    if (vBand && a1 <= x0 + 1e-4) left = Math.max(left, Math.min(x0, a1 + FORMULA_OBSTACLE_GAP));
    if (vBand && a0 >= x1 - 1e-4) right = Math.min(right, Math.max(x1, a0 - FORMULA_OBSTACLE_GAP));
    if (hBand && b1 <= y0 + 1e-4) top = Math.max(top, Math.min(y0, b1 + FORMULA_OBSTACLE_GAP));
    if (hBand && b0 >= y1 - 1e-4) bottom = Math.min(bottom, Math.max(y1, b0 - FORMULA_OBSTACLE_GAP));
  }
  return [
    clamp01(Math.min(left, x0)),
    clamp01(Math.min(top, y0)),
    clamp01(Math.max(right, x1)),
    clamp01(Math.max(bottom, y1))
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

function isFormulaItem(item) {
  return item?.keepText !== true && looksLikeFormulaItem(item);
}

function foldScriptItems(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const used = new Set();
  const folded = [];
  for (let index = 0; index < sorted.length; index += 1) {
    if (used.has(index)) continue;
    const base = sorted[index];
    // pdf.js may place the final base letter in a larger punctuation run (", ..., x").
    if (!/(?:^|[\s,(])([A-Za-z\u0370-\u03FF])$/.test(base.str) || base.height < 8) {
      folded.push(base);
      continue;
    }
    const scripts = [];
    let edge = base.x + base.width;
    for (let next = index + 1; next < sorted.length; next += 1) {
      const item = sorted[next];
      if (item.x - edge > 1.5) break;
      if (used.has(next) || item.height >= base.height * 0.85 ||
          base.y - item.y < 0.5 || base.y - item.y > base.height * 0.5 ||
          !/^[A-Za-z0-9−+\-]+$/.test(item.str)) break;
      scripts.push(item);
      used.add(next);
      edge = item.x + item.width;
    }
    if (!scripts.length) {
      folded.push(base);
      continue;
    }
    const script = scripts.map((item) => item.str).join("");
    folded.push({
      ...base,
      str: `${base.str}_${script.length === 1 ? script : `{${script}}`}`,
      width: edge - base.x,
      keepText: true,
      sourceItems: [base, ...scripts]
    });
  }
  return folded;
}

function lineWithScripts(line) {
  const items = foldScriptItems(line.items || []);
  const state = { text: "", prev: null };
  items.forEach((item) => pushPiece(state, item.str, item));
  return {
    ...line,
    items,
    text: state.text.replace(/\s+/g, " ").trim(),
    math: items.some(isFormulaItem)
  };
}

function lineBaseline(group) {
  const bodyH = Math.max(8, ...group.map((item) => item.height || 0));
  const bodies = group.filter((item) => (item.height || 0) >= bodyH * 0.85);
  const source = bodies.length ? bodies : group;
  return {
    y: source[0].y,
    bodyH,
    left: Math.min(...group.map((item) => item.x))
  };
}

/** Scripts stay with their base. A new body line does not, even when the leading is close to a tall superscript. */
function staysOnLine(item, group) {
  const base = lineBaseline(group);
  const dy = Math.abs(item.y - base.y);
  const shorter = item.height > 0 && item.height < base.bodyH * 0.85;
  const overlaps = group.some((entry) =>
    item.x < entry.x + Math.max(entry.width, 1) + 2 &&
    item.x + Math.max(item.width, 1) > entry.x - 2);
  const atLeft = item.x <= base.left + 8;
  const below = base.y - item.y > base.bodyH * 0.55;
  if (shorter && overlaps && dy > 0.35 && dy < base.bodyH * 1.5 && !(atLeft && below)) return true;
  if (dy > Math.max(9.2, base.bodyH * 0.88)) return false;
  const first = group[0];
  const last = group.at(-1);
  const height = Math.max(8, first.height || 0, item.height || 0);
  const reset = item.x < first.x + 20 && last.x + last.width - item.x > 20;
  if (reset && (dy > height * 0.35 || last.hasEOL)) return false;
  return true;
}

function sourceOrderLines(items) {
  const lines = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const ordered = [...group].sort((a, b) => a.x - b.x || b.y - a.y);
    const left = Math.min(...ordered.map((item) => item.x));
    const right = Math.max(...ordered.map((item) => item.x + item.width));
    const state = { text: "", prev: null };
    ordered.forEach((item) => pushPiece(state, item.str, item));
    const base = lineBaseline(ordered);
    lines.push({
      text: state.text.replace(/\s+/g, " ").trim(),
      x: left,
      y: base.y,
      width: right - left,
      height: Math.max(...ordered.map((item) => item.height)),
      bold: ordered.some((item) => /bold|black|heavy|semibold/i.test(item.fontName)),
      fontName: ordered[0].fontName,
      math: ordered.some(isFormulaItem),
      items: ordered
    });
    group = [];
  };
  for (const item of items) {
    if (!item.str) continue;
    if (group.length && !staysOnLine(item, group)) flush();
    group.push(item);
  }
  flush();
  return lines.filter((line) => line.text);
}

function bibliographyFrom(lines) {
  const heading = lines.findIndex((line) => /^(references|bibliography)$/i.test(String(line.text || "").trim()));
  const citeIndexes = lines
    .map((line, index) => /^\[\d+\]/.test(String(line.text || "").trim()) ? index : -1)
    .filter((index) => index >= 0);
  if (heading < 0 && citeIndexes.length < 4) return lines;
  const start = heading >= 0 ? heading + 1 : citeIndexes[0];
  return lines.map((line, index) => (index >= start ? { ...line, bibliography: true } : line));
}

function displayFormulaGroups(lines, viewport) {
  const members = new Map();
  for (const anchor of lines) {
    const indentedEquation = anchor.x > viewport.width * 0.24 && anchor.width >= 70 &&
      anchor.width < viewport.width * 0.7 && /=/.test(anchor.text) && anchor.text.length < 140;
    if (members.has(anchor) || anchor.width < 24 ||
        (!lineShouldBeOneFormula(anchor.items) && !indentedEquation)) continue;
    const group = [anchor];
    const right = anchor.x + anchor.width;
    for (const line of lines) {
      if (line === anchor || members.has(line)) continue;
      if (Math.abs(line.y - anchor.y) > Math.max(12, anchor.height * 1.2)) continue;
      if (line.text.length > 12 || proseCarriesSentence(line.items)) continue;
      const middle = line.x + line.width / 2;
      const inside = middle >= anchor.x - 10 && middle <= right + 10;
      const prefix = Math.abs(line.y - anchor.y) < 2 && line.x < anchor.x &&
        anchor.x - (line.x + line.width) < 3;
      const equationNumber = /^\(\d+\)$/.test(line.text) && line.x - right < 120;
      if (inside || prefix || equationNumber) group.push(line);
    }
    group.forEach((line) => members.set(line, { anchor, group }));
  }
  return members;
}

function separateAuthorRows(lines, viewport) {
  const abstract = lines.find((line) => /^abstract$/i.test(line.text));
  const bodyHeight = [...lines].map((line) => line.height).sort((a, b) => a - b)[Math.floor(lines.length / 2)] || 10;
  const title = abstract && lines
    .filter((line) => line.y > abstract.y + 20 && line.height > bodyHeight * 1.3 &&
      line.text.split(/\s+/).length >= 3 && !/@/.test(line.text))
    .sort((a, b) => b.height - a.height)[0];
  if (!title || !abstract || title.y <= abstract.y || title.y - abstract.y > viewport.height * 0.36) {
    return { body: lines, authors: [] };
  }
  const selected = lines.filter((line) => line.y < title.y - 8 && line.y > abstract.y + 8);
  if (!selected.some((line) => /@/.test(line.text))) return { body: lines, authors: [] };
  const body = lines.filter((line) => line.y <= title.y + 8 && !selected.includes(line));
  const sorted = [...selected].sort((a, b) => b.y - a.y);
  const rows = [];
  for (const line of sorted) {
    const row = rows.find((entry) => Math.abs(entry.y - line.y) <= 4);
    if (row) row.lines.push(line);
    else rows.push({ y: line.y, lines: [line] });
  }
  const authors = rows.map((row) => {
    const sourceItems = row.lines.flatMap((line) => line.items || []).sort((a, b) => a.x - b.x);
    const state = { text: "", prev: null };
    sourceItems.forEach((item) => pushPiece(state, item.str, item));
    return {
      kind: "prose",
      role: "authors",
      text: state.text.replace(/\s+/g, " ").trim(),
      bbox: unionBbox(sourceItems.map((item) => itemBbox(item, viewport))),
      sourceItems,
      placeholders: []
    };
  }).filter((row) => row.text);
  return { body, authors };
}

function hasOrdinaryWord(text) {
  const words = String(text || "").match(/[A-Za-z]{4,}/g) || [];
  return words.some((word) => !FORMULA_WORDS.has(word));
}

/** Roman function names such as softmax stay inside the formula crop. A real sentence does not. */
export function proseCarriesSentence(items) {
  const text = (items || []).map((item) => String(item.str || "")).join(" ");
  if (/[\u4e00-\u9fff]{2,}/.test(text)) return true;
  const words = text.match(/[A-Za-z]+/g) || [];
  return words.some((word) => /^(and|or|the|with|for|from|into|over|than|that|this|are|was|were|not|but|also)$/i.test(word) ||
    (word.length >= 4 && !FORMULA_WORD.test(word)));
}

export function lineShouldBeOneFormula(items) {
  const list = items || [];
  const text = list.map((item) => item.str || "").join("");
  if (!list.some(isFormulaItem) && !/=/.test(text)) return false;
  const prose = list.filter((item) => !isFormulaItem(item));
  return !proseCarriesSentence(prose);
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

function centerInside(item, box, viewport) {
  const own = itemBbox(item, viewport);
  const x = (own[0] + own[2]) / 2;
  const y = (own[1] + own[3]) / 2;
  return x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

/** A caption anchors complete page crops; image XObjects and layout boxes are only candidates. */
function pageVisualDrafts(items, images, viewport) {
  const rows = sourceOrderLines(items).sort((a, b) => b.y - a.y);
  const imagesOnPage = figureDrafts(images, viewport);
  const usedImages = new Set();
  const visuals = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const figure = /^Fig(?:ure)?\.?\s*\d+\s*:/i.test(row.text);
    const table = /^Table\s*\d+\s*:/i.test(row.text);
    if (!figure && !table) continue;
    const caption = [row];
    let tail = index;
    while (tail + 1 < rows.length && caption.length < 4) {
      const next = rows[tail + 1];
      const gap = rows[tail].y - next.y;
      if (gap < 5 || gap > 13 || Math.abs(next.x - row.x) > 14) break;
      caption.push(next);
      tail += 1;
    }
    const capTop = Math.min(...caption.flatMap((line) => line.items.map((item) => itemBbox(item, viewport)[1])));
    const capBottom = Math.max(...caption.flatMap((line) => line.items.map((item) => itemBbox(item, viewport)[3])));
    if (figure) {
      const adjacent = imagesOnPage.filter((image, imageIndex) =>
        !usedImages.has(imageIndex) && image.bbox[3] <= capTop + 0.015 &&
        capTop - image.bbox[3] < 0.09 && image.bbox[1] < capTop - 0.015);
      if (!adjacent.length) {
        // Some appendix figures are vector-only. Repeated diagram labels above
        // a bottom caption provide a bounded source region without OCR text.
        const above = items.filter((item) => itemBbox(item, viewport)[3] < capTop - 0.01);
        const repeatedLabels = above.filter((item) => /<EOS>|<pad>/i.test(item.str)).length >= 2;
        if (!repeatedLabels || above.length < 20) continue;
        const box = padBbox(unionBbox(above.map((item) => itemBbox(item, viewport))), 0.006);
        if (box[3] - box[1] < 0.2) continue;
        visuals.push({ kind: "figure", bbox: box, sourceItems: above });
        continue;
      }
      adjacent.forEach((image) => usedImages.add(imagesOnPage.indexOf(image)));
      const imageBox = unionBbox(adjacent.map((image) => image.bbox));
      // Figure labels often use PDF text operators above and inside the raster pieces.
      const internal = items.filter((item) => {
        const box = itemBbox(item, viewport);
        const midX = (box[0] + box[2]) / 2;
        const midY = (box[1] + box[3]) / 2;
        return midY >= imageBox[1] - 0.035 && midY < capTop - 0.002 &&
          midX >= imageBox[0] - 0.09 && midX <= imageBox[2] + 0.09;
      });
      const bbox = padBbox(unionBbox([imageBox, ...internal.map((item) => itemBbox(item, viewport))]), 0.005);
      visuals.push({ kind: "figure", bbox, sourceItems: internal });
      continue;
    }
    // A table begins after its caption and ends at the first true paragraph gap.
    const below = rows.slice(tail + 1).filter((line) => line.y < caption.at(-1).y - 12);
    const first = below[0];
    if (!first || caption.at(-1).y - first.y > 55 || first.x <= row.x + 5) continue;
    const tableRows = [first];
    for (let next = 1; next < below.length; next += 1) {
      const gap = tableRows.at(-1).y - below[next].y;
      if (gap > 27 || gap < -3) break;
      tableRows.push(below[next]);
    }
    if (tableRows.length < 3) continue;
    const tableItems = tableRows.flatMap((line) => line.items || []);
    const tableBox = padBbox(unionBbox(tableItems.map((item) => itemBbox(item, viewport))), 0.008);
    tableBox[0] = clamp01(tableBox[0] - 0.01);
    tableBox[2] = clamp01(tableBox[2] + 0.01);
    tableBox[1] = Math.max(tableBox[1], capBottom + 0.003);
    if (!tableBox || tableBox[1] <= capBottom - 0.003) continue;
    visuals.push({ kind: "table", bbox: tableBox, sourceItems: tableItems });
  }
  imagesOnPage.forEach((image, index) => {
    if (usedImages.has(index)) return;
    visuals.push({ ...image, sourceItems: items.filter((item) => centerInside(item, image.bbox, viewport)) });
  });
  return visuals.sort((a, b) => a.bbox[1] - b.bbox[1]);
}

function desiredFormulaPad(items, inline) {
  const base = inline
    ? { x: FORMULA_CROP_PAD.inlineX, y: FORMULA_CROP_PAD.inlineY }
    : { x: FORMULA_CROP_PAD.displayX, y: FORMULA_CROP_PAD.displayY };
  const heights = items.map((item) => Number(item?.height) || 0).filter((height) => height > 0);
  const body = heights.length ? Math.max(...heights) : 10;
  const hasScript = items.some((item) => {
    const height = Number(item?.height) || 0;
    return height > 0 && height < body * 0.85;
  });
  const text = items.map((item) => item?.str || "").join("");
  const hasDelimiter = /[()[\]√∑∫]/.test(text);
  return {
    x: Math.min(FORMULA_PAD_LIMIT.x, base.x + (hasDelimiter ? FORMULA_CROP_PAD.scriptX : 0)),
    y: Math.min(FORMULA_PAD_LIMIT.y, base.y + ((hasScript || hasDelimiter) ? FORMULA_CROP_PAD.scriptY : 0))
  };
}

function formulaFontName(item) {
  return /CM(MI|SY|EX)|Math|Symbol|MTMI|MTSY|Euclid|STIX|CambriaMath/i.test(String(item?.fontName || ""));
}

/** Vector redraw only when every glyph is a formula font and the ink stays inside the text box. */
export function formulaGlyphsRedrawSafe(items) {
  const list = items || [];
  if (!list.length) return false;
  const text = list.map((item) => item?.str || "").join("");
  if (/[√∑∫∏()]/.test(text)) return false;
  return list.every(formulaFontName);
}

function formulaDraft(items, viewport, { inline = false, obstacles = [] } = {}) {
  const boxes = items.map((item) => itemBbox(item, viewport));
  const glyphBox = unionBbox(boxes);
  return {
    kind: "formula",
    bbox: contentAwareFormulaBbox(glyphBox, desiredFormulaPad(items, inline), obstacles),
    display: !inline,
    inlineOf: null,
    sourceItems: items,
    glyphBoxes: boxes,
    glyphRedraw: formulaGlyphsRedrawSafe(items)
  };
}

function obstacleBoxes(items, viewport, visuals, formulaItems) {
  const skip = new Set();
  for (const item of expandedItems(formulaItems)) {
    if (Number.isInteger(item?.sourceIndex)) skip.add(item.sourceIndex);
  }
  const boxes = [];
  for (const item of items || []) {
    if (skip.has(item.sourceIndex) || !String(item.str || "").trim()) continue;
    boxes.push(itemBbox(item, viewport));
  }
  for (const visual of visuals || []) {
    if (Array.isArray(visual?.bbox)) boxes.push(visual.bbox);
  }
  return boxes;
}

/** A short formula wrapped onto the left margin continues the paragraph. Centered equations stay display. */
function isMarginContinuation(line, viewport, prosePending) {
  if (!prosePending || !line) return false;
  const width = Math.max(1, Number(viewport?.width) || 1);
  if (line.x > width * 0.22) return false;
  if (/\(\d+\)\s*$/.test(String(line.text || ""))) return false;
  if ((line.width || 0) > width * 0.62) return false;
  return true;
}

function expandedItems(items) {
  return items.flatMap((item) => item.sourceItems ? expandedItems(item.sourceItems) : [item]);
}

function sourceTextOf(items) {
  const state = { text: "", prev: null };
  items.forEach((item) => pushPiece(state, item.str, item));
  return state.text.replace(/\s+/g, " ").trim();
}

function inlineFormulaSpans(items) {
  const spans = [];
  const used = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const text = String(items[index].str || "").trim();
    if (!/^=/.test(text) || text.length > 30) continue;
    let first = index - 1;
    while (first >= 0 && !String(items[first].str || "").trim()) first -= 1;
    if (first < 0 || !/^[A-Za-z\u0370-\u03FF](?:_\{?[A-Za-z0-9−+\-]+\}?)?$/.test(items[first].str)) continue;
    let last = index;
    if (text.includes("(")) {
      while (last + 1 < items.length && !String(items[last].str).includes(")")) last += 1;
      if (!String(items[last].str).includes(")")) continue;
    } else if (/\d/.test(text)) {
      if (items[last + 1]?.str === "." && /^\d+$/.test(items[last + 2]?.str || "")) last += 2;
      // A scientific-notation exponent is drawn above the baseline as separate
      // glyphs. Keep it with the base instead of leaving a dangling "−9".
      if (/^[−-]$/.test(items[last + 1]?.str || "") && /^\d+$/.test(items[last + 2]?.str || "") &&
          items[last + 1].y > items[last].y + 1 && items[last + 2].y > items[last].y + 1) last += 2;
    } else if (!/[0-9A-Za-z]/.test(text.replace(/^=/, ""))) {
      while (last + 1 < items.length && !String(items[last + 1].str).trim()) last += 1;
      const next = String(items[last + 1]?.str || "");
      if (/^P(?:_|$)/.test(next)) {
        let dot = first - 1;
        while (dot >= 0 && !String(items[dot].str || "").trim()) dot -= 1;
        let left = dot - 1;
        while (left >= 0 && !String(items[left].str || "").trim()) left -= 1;
        if (dot < 0 || left < 0 || items[dot].str !== "·" || !/^[A-Za-z]$/.test(items[left].str)) continue;
        first = left;
        last += 1;
        while (last + 1 < items.length && last - index < 20 &&
               !/^,\s*[A-Za-z]{3,}/.test(String(items[last + 1].str || ""))) last += 1;
      } else {
        // An unsupported operator needs vertical grouping. Do not crop a lone glyph.
        if (!/^\d/.test(next)) continue;
        last += 1;
      }
    }
    if (last - first > 16) continue;
    spans.push([first, last]);
    for (let part = first; part <= last; part += 1) used.add(part);
  }
  for (let index = 0; index < items.length; index += 1) {
    if (used.has(index) || !/^\($/.test(String(items[index].str || "").trim())) continue;
    let last = index + 1;
    while (last < items.length && !String(items[last].str || "").includes(")") && last - index < 16) last += 1;
    if (last >= items.length || last - index >= 16) continue;
    const expression = items.slice(index, last + 1).map((item) => item.str).join("");
    if (!/[A-Za-z]/.test(expression) || !/_|,\s*\.\.\.|[+=−]/.test(expression)) continue;
    spans.push([index, last]);
    for (let part = index; part <= last; part += 1) used.add(part);
  }
  for (let index = 0; index < items.length - 2; index += 1) {
    if (used.has(index) || items[index].str !== "√") continue;
    const numerator = items[index + 1];
    const denominator = items[index + 2];
    if (numerator?.str !== "1" || !/^d/.test(denominator?.str || "") ||
        numerator.y <= items[index].y + 1 || denominator.y >= items[index].y - 1) continue;
    const last = items[index + 3]?.str === "k" ? index + 3 : index + 2;
    spans.push([index, last]);
    for (let part = index; part <= last; part += 1) used.add(part);
  }
  for (let index = 0; index < items.length - 1; index += 1) {
    if (used.has(index)) continue;
    const base = items[index];
    if (/^P E_\{?pos(?:\+k)?\}?$/.test(base.str || "")) {
      spans.push([index, index]);
      used.add(index);
      continue;
    }
    if (base.str === "√" && /^d_?\{?model\}?/.test(items[index + 1]?.str || "")) {
      spans.push([index, index + 1]);
      used.add(index);
      used.add(index + 1);
      continue;
    }
    if (base.str !== "P E" || items[index + 1]?.str !== "pos" ||
        items[index + 1].height >= base.height * 0.85 ||
        items[index + 1].y >= base.y - 0.5) continue;
    let last = index + 1;
    if (items[last + 1]?.str === "+" && items[last + 2]?.str === "k") last += 2;
    spans.push([index, last]);
    for (let part = index; part <= last; part += 1) used.add(part);
  }
  return spans.sort((a, b) => a[0] - b[0]).filter(([first, last]) => {
    const width = items[last].x + items[last].width - items[first].x;
    return width >= 24 || (items[first].str === "√" && width >= 12);
  });
}

function isBodyProseItem(item, bodyH) {
  if ((item.height || 0) < bodyH * 0.85) return false;
  const text = String(item.str || "").trim();
  if (!text || FORMULA_WORD.test(text)) return false;
  if (/^(and|or|the|with|for|from|into|over|than|that|this|are|was|were|not|but)$/i.test(text)) return true;
  return /[A-Za-z]{4,}/.test(text);
}

/** A relation such as W ∈ R with real superscripts is one crop. Do not spell those glyphs into the sentence. */
function scriptedRelationSpans(items) {
  const heights = items.map((item) => item.height || 0).filter((height) => height >= 8);
  if (!heights.length) return [];
  const bodyH = Math.max(...heights);
  const bases = items.filter((item) => (item.height || 0) >= bodyH * 0.85);
  if (!bases.length) return [];
  const baseY = bases.reduce((sum, item) => sum + item.y, 0) / bases.length;
  const isScript = (item) => (item.height || 0) > 0 && item.height < bodyH * 0.85 &&
    Math.abs(item.y - baseY) > 0.4;
  if (!items.some((item) => /[∈⊆]/.test(item.str || "")) || !items.some(isScript)) return [];
  const spans = [];
  let start = -1;
  let sawRelation = false;
  const flush = (end) => {
    if (start < 0) return;
    if (sawRelation && end >= start) spans.push([start, end]);
    start = -1;
    sawRelation = false;
  };
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const text = String(item.str || "").trim();
    if (!text) continue;
    if (isBodyProseItem(item, bodyH) || text === "." || text === "。") {
      flush(index - 1);
      continue;
    }
    const mathToken = /^[A-Za-z\u0370-\u03FF](?:_\{?[A-Za-z0-9−+\-]+\}?)?$/.test(text);
    const atom = isScript(item) || /[∈⊆×∑∏√]/.test(text) || mathToken || /^[,;:()]$/.test(text);
    if (start < 0) {
      if (!(isScript(item) || /[∈⊆×]/.test(text) || mathToken)) continue;
      start = index;
    } else if (!atom) {
      flush(index - 1);
      continue;
    }
    if (/[∈⊆]/.test(text)) sawRelation = true;
  }
  flush(items.length - 1);
  return spans.filter(([first, last]) => items[last].x + items[last].width - items[first].x >= 24);
}

function formulaSpans(items) {
  const primary = inlineFormulaSpans(items);
  const used = new Set();
  primary.forEach(([first, last]) => {
    for (let index = first; index <= last; index += 1) used.add(index);
  });
  const extra = scriptedRelationSpans(items).filter(([first, last]) => {
    for (let index = first; index <= last; index += 1) if (used.has(index)) return false;
    return true;
  });
  return [...primary, ...extra].sort((a, b) => a[0] - b[0]);
}

function lineWithInlineFormulas(line, viewport, nextFormula, formulaByToken, context = {}) {
  const items = [...(line.items || [])].sort((a, b) => a.x - b.x);
  const spans = formulaSpans(items);
  const state = { text: "", prev: null };
  const sourceState = { text: "", prev: null };
  items.forEach((item) => pushPiece(sourceState, item.str, item));
  const proseItems = [];
  let index = 0;
  let spanIndex = 0;
  while (index < items.length) {
    const span = spans[spanIndex];
    if (span && index === span[0]) {
      const run = items.slice(span[0], span[1] + 1);
      const raw = expandedItems(run);
      const token = `⟦f${nextFormula()}⟧`;
      const formula = formulaDraft(raw, viewport, {
        inline: true,
        obstacles: obstacleBoxes(context.visible, viewport, context.visuals, raw)
      });
      const source = run[0].str === "√" && run[1]?.str === "1" ? "1/√d_k"
        : run[0].str.startsWith("P E_") ? run[0].str.replace(/^P E_/, "PE_")
        : run[0].str === "P E" ? `PE_{${run.slice(1).map((item) => item.str).join("")}}`
        : sourceTextOf(run);
      formulaByToken.set(token, { token, formula, source });
      if (state.text && /[A-Za-z0-9)]$/.test(state.text)) state.text += " ";
      pushPiece(state, token, run[0]);
      state.prev = run.at(-1);
      index = span[1] + 1;
      spanIndex += 1;
    } else {
      pushPiece(state, items[index].str, items[index]);
      proseItems.push(...expandedItems([items[index]]));
      index += 1;
    }
  }
  return {
    ...line,
    text: state.text.replace(/\s+/g, " ").trim(),
    sourceText: sourceState.text.replace(/\s+/g, " ").trim(),
    items: proseItems,
    math: false,
    fontName: proseItems[0]?.fontName || ""
  };
}

function proseDrafts(lines, allLines, viewport, formulaByToken) {
  return paragraphsFromLines(lines, allLines, { preserveLineHyphens: true }).flatMap((block) => {
    const entries = [...block.text.matchAll(/⟦f\d+⟧/g)]
      .map((match) => formulaByToken.get(match[0])).filter(Boolean);
    const sourceItems = block.sourceItems || [];
    const allItems = [...sourceItems, ...entries.flatMap((entry) => entry.formula.sourceItems)];
    const host = {
      kind: "prose",
      role: looksLikeCaption(block.text) ? "caption" : block.role,
      text: block.text,
      sourceText: block.text.replace(/⟦f\d+⟧/g, (token) => formulaByToken.get(token)?.source || token),
      bbox: unionBbox(allItems.map((item) => itemBbox(item, viewport))),
      placeholders: entries,
      sourceItems,
      allSourceItems: allItems,
      skipTranslate: lines.every((line) => line.bibliography) || undefined
    };
    entries.forEach((entry) => {
      entry.formula.inlineOf = host;
      entry.formula.display = false;
    });
    return [host, ...entries.map((entry) => entry.formula)];
  });
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

function nearestVisualId(blocks, index, label) {
  let best = null;
  let bestDist = Infinity;
  let bestBefore = false;
  blocks.forEach((block, i) => {
    if (block.label !== label) return;
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

function sourceIndexes(items) {
  return [...new Set(expandedItems(items || []).map((item) => item.sourceIndex)
    .filter(Number.isInteger))].sort((a, b) => a - b);
}

function stableSourceId(draft, page) {
  const indexes = sourceIndexes(draft.allSourceItems || draft.sourceItems);
  const seed = indexes.length ? indexes.join(",") : `${draft.kind}:${(draft.bbox || []).map((n) => n.toFixed(5)).join(",")}`;
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `p${page}-s${hash.toString(36)}`;
}

function auditSources(raw, excluded, drafts, blocks) {
  const owners = new Map();
  drafts.forEach((draft, draftIndex) => {
    const block = blocks[draftIndex];
    const owner = draft.kind === "prose" ? "body" : "visual";
    for (const index of sourceIndexes(draft.sourceItems)) {
      if (!owners.has(index)) owners.set(index, []);
      owners.get(index).push({ owner, blockId: block.id, sourceId: block.sourceId });
    }
  });
  const items = raw.map((item, index) => {
    if (!String(item.str || "").trim()) return { index, owner: "excluded", reason: "empty-or-spacing" };
    if (excluded.has(index)) return { index, owner: "excluded", reason: "page-chrome" };
    const claims = owners.get(index) || [];
    if (claims.length === 1) return { index, ...claims[0] };
    if (!claims.length) return { index, owner: "unresolved", reason: "no-source-block" };
    return { index, owner: "unresolved", reason: "duplicate-ownership", blockIds: claims.map((claim) => claim.blockId) };
  });
  return {
    items,
    missing: items.filter((item) => item.reason === "no-source-block").map((item) => item.index),
    duplicates: items.filter((item) => item.reason === "duplicate-ownership").map((item) => item.index)
  };
}

function toProtocol(drafts, pageNumber, trust) {
  const page = Number(pageNumber) || 1;
  drafts.forEach((draft, index) => {
    draft.id = `p${page}-b${index + 1}`;
    draft.sourceId = stableSourceId(draft, page);
  });
  const blocks = drafts.map((draft) => {
    if (draft.kind === "figure" || draft.kind === "table") {
      return { id: draft.id, sourceId: draft.sourceId, label: draft.kind, bbox: draft.bbox };
    }
    if (draft.kind === "formula") {
      const block = {
        id: draft.id,
        sourceId: draft.sourceId,
        label: "formula",
        bbox: draft.bbox,
        display: draft.display !== false && !draft.inlineOf
      };
      if (draft.inlineOf?.id) block.inlineOf = draft.inlineOf.id;
      if (draft.glyphRedraw && draft.glyphBoxes?.length) {
        block.glyphRedraw = true;
        block.glyphBoxes = draft.glyphBoxes;
      }
      return block;
    }
    const role = draft.role;
    let label = "text";
    if (role === "title") label = "title";
    else if (role === "heading") label = "heading";
    else if (role === "caption") label = "caption";
    const text = trust.trusted ? draft.text || "" : "";
    const block = { id: draft.id, sourceId: draft.sourceId, label, bbox: draft.bbox, text };
    if (trust.trusted) block.sourceText = draft.sourceText || draft.text || "";
    if (role === "authors") {
      block.label = "text";
      block.skipTranslate = true;
      block.presentation = "byline";
    }
    if (draft.skipTranslate) block.skipTranslate = true;
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
    const label = /^Table\s*\d+\s*:/i.test(block.text || "") ? "table" :
      /^Fig(?:ure)?\.?\s*\d+\s*:/i.test(block.text || "") ? "figure" : "";
    const visualId = label ? nearestVisualId(blocks, index, label) : null;
    if (visualId) block.captionFor = visualId;
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
  const normalized = raw.map((item, sourceIndex) => {
    const transform = Array.isArray(item?.transform) ? item.transform : [];
    return {
      ...item,
      str: String(item?.str || ""),
      x: Number.isFinite(Number(item?.x)) ? Number(item.x) : Number(transform[4]) || 0,
      y: Number.isFinite(Number(item?.y)) ? Number(item.y) : Number(transform[5]) || 0,
      width: Number(item?.width) || 0,
      height: Number(item?.height) || 0,
      fontName: String(item?.fontName || ""),
      sourceIndex
    };
  });
  const excluded = new Set(normalized.filter((item) =>
    isPageChromeItem(item, { width: view.width, height: view.height })).map((item) => item.sourceIndex));
  const notice = normalized.find((item) => /^Provided proper attribution is provided/i.test(item.str));
  if (notice && excluded.has(notice.sourceIndex)) {
    normalized.forEach((item) => {
      if (item.y <= notice.y && notice.y - item.y <= notice.height * 2.6 &&
          item.height >= notice.height * 0.8 && item.sourceIndex <= notice.sourceIndex + 4) {
        excluded.add(item.sourceIndex);
      }
    });
  }
  const visible = normalized.filter((item) => !excluded.has(item.sourceIndex) && String(item.str).trim());
  const visuals = pageVisualDrafts(visible, images, view);
  visuals.forEach((visual) => {
    visual.sourceItems = visible.filter((item) => centerInside(item, visual.bbox, view));
  });
  const readable = visible.filter((item) => !visuals.some((visual) => centerInside(item, visual.bbox, view)));
  const prepared = separateAuthorRows(readingOrderLines(readable), view);
  const rawLines = prepared.authors.length ? prepared.body : sourceOrderLines(readable);
  const displayGroups = displayFormulaGroups(rawLines, view);
  const lines = bibliographyFrom(rawLines.map(lineWithScripts));
  const drafts = [];
  let prose = [];
  let formulaSerial = 0;
  const formulaByToken = new Map();
  const nextFormula = () => {
    formulaSerial += 1;
    return formulaSerial;
  };
  const flushProse = () => {
    if (!prose.length) return;
    drafts.push(...proseDrafts(prose, lines, view, formulaByToken));
    prose = [];
  };
  const cropContext = { visible, visuals };
  const pushDisplay = (formulaItems) => {
    drafts.push(formulaDraft(formulaItems, view, {
      inline: false,
      obstacles: obstacleBoxes(visible, view, visuals, formulaItems)
    }));
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    // A numbered footnote can sit just one line-height below the final body
    // line. Its marker is smaller and near the page bottom; keep its source
    // sentence separate even when the generic paragraph gap does not fire.
    if (/^\d{1,2}(?:$|(?=[A-Z]))/.test(line.text) && line.y < view.height * 0.15 &&
        line.height < view.height * 0.012) flushProse();
    const continuation = isMarginContinuation(line, view, prose.length > 0);
    const parts = line.items || [];
    const formulaLine = parts.length > 0 && lineShouldBeOneFormula(parts);
    if (continuation && formulaLine) {
      const raw = expandedItems(parts);
      const token = `⟦f${nextFormula()}⟧`;
      const formula = formulaDraft(raw, view, {
        inline: true,
        obstacles: obstacleBoxes(visible, view, visuals, raw)
      });
      formulaByToken.set(token, { token, formula, source: line.text });
      prose.push({
        ...line,
        text: token,
        sourceText: line.text,
        items: [],
        math: false,
        fontName: ""
      });
      continue;
    }
    const grouped = displayGroups.get(rawLines[lineIndex]);
    if (grouped && !continuation) {
      if (grouped.anchor === rawLines[lineIndex]) {
        flushProse();
        pushDisplay(grouped.group.flatMap((part) => expandedItems(part.items || [])));
      }
      continue;
    }
    if (formulaLine && parts.length && !continuation) {
      flushProse();
      pushDisplay(expandedItems(parts));
      continue;
    }
    if (line.bibliography) {
      const freshEntry = /^\[\d+\]/.test(String(line.text || "").trim());
      if (freshEntry || !prose.length || !prose.at(-1).bibliography) flushProse();
      prose.push(lineWithInlineFormulas(line, view, nextFormula, formulaByToken, cropContext));
      continue;
    }
    prose.push(lineWithInlineFormulas(line, view, nextFormula, formulaByToken, cropContext));
  }
  flushProse();
  const titleAt = drafts.findIndex((draft) => draft.role === "title");
  if (titleAt >= 0 && prepared.authors.length) drafts.splice(titleAt + 1, 0, ...prepared.authors);
  const ordered = insertFigures(drafts, visuals);
  const blocks = toProtocol(ordered, pageNumber, trust);
  const kept = trust.trusted ? blocks : blocks.filter((block) => block.label === "figure");
  return preparePageBlocks({
    protocol: PROTOCOL,
    page: pageNumber,
    pixelWidth: Math.round((Number(view.width) || 0) * CROP_SCALE),
    pixelHeight: Math.round((Number(view.height) || 0) * CROP_SCALE),
    textSource: trust.trusted ? "text-layer" : "ocr",
    blocks: kept,
    sourceAudit: trust.trusted ? auditSources(normalized, excluded, ordered, blocks) : null
  });
}

export { looksLikeAuthorLine };
