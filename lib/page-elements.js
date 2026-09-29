/**
 * One labelled element per text item, plus vector paths and images that
 * are not the outline of those items.
 *
 * A recorder glyph is bound to a text item only when its center lies in
 * that item and most of its area overlaps it. It is not given a character
 * of its own. An unbound outline is stored with an empty char and an empty
 * font, so it cannot inherit a neighbour's letter.
 */

import { assignStableIds } from "./label-schema.js";
import { sha256Hex } from "./sha256.js";

function boxArea(box) {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function overlapArea(a, b) {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

function center(box) {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

export function textItemPageBox(item, viewport) {
  const transform = Array.isArray(item?.transform) ? item.transform : [];
  const x = Number.isFinite(Number(item?.x)) ? Number(item.x) : Number(transform[4]) || 0;
  const y = Number.isFinite(Number(item?.y)) ? Number(item.y) : Number(transform[5]) || 0;
  const width = Number(item?.width) || 0;
  const height = Number(item?.height) || 0;
  const rect = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
  return [
    Math.min(rect[0], rect[2]),
    Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]),
    Math.max(rect[1], rect[3])
  ];
}

export function textItemBaseline(item, viewport) {
  const transform = Array.isArray(item?.transform) ? item.transform : [];
  const x = Number(transform[4]) || 0;
  const y = Number(transform[5]) || 0;
  if (typeof viewport?.convertToViewportPoint === "function") {
    const point = viewport.convertToViewportPoint(x, y);
    return Number(point?.[1]) || 0;
  }
  return y;
}

export function pathHashOf(d) {
  const text = String(d || "");
  if (!text) return "";
  return sha256Hex(text).slice(0, 12);
}

/**
 * Bind a painted glyph box to at most one text item.
 * Returns the item index, or -1 when the paint stands alone.
 */
export function bindPaintToText(paintBox, textBoxes) {
  let best = -1;
  let bestScore = 0;
  let second = 0;
  const area = Math.max(boxArea(paintBox), 1e-6);
  const [cx, cy] = center(paintBox);
  textBoxes.forEach((box, index) => {
    const overlap = overlapArea(paintBox, box) / area;
    const inside = cx >= box[0] - 0.8 && cx <= box[2] + 0.8 && cy >= box[1] - 0.8 && cy <= box[3] + 0.8;
    if (!inside && overlap < 0.55) return;
    const score = overlap + (inside ? 0.2 : 0);
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = index;
    } else if (score > second) second = score;
  });
  if (best < 0 || bestScore < 0.55) return -1;
  if (second > 0 && bestScore - second < 0.08) return -1;
  return best;
}

/**
 * `glyphs` are text items: { char, font, bbox, baseline, fontSize }.
 * `paints` are recorder glyphs: { bbox, d }.
 * `paths` and `images` are recorder elements: { bbox, d }.
 */
export function assemblePageElements({ glyphs = [], paints = [], paths = [], images = [] } = {}) {
  const textBoxes = glyphs.map((glyph) => glyph.bbox);
  const elements = glyphs.map((glyph) => ({
    kind: "glyph",
    char: String(glyph.char ?? ""),
    font: String(glyph.font ?? ""),
    bbox: glyph.bbox,
    pathHash: "",
    baseline: glyph.baseline,
    fontSize: glyph.fontSize,
    source: "text"
  }));
  for (const paint of paints) {
    if (bindPaintToText(paint.bbox, textBoxes) >= 0) continue;
    elements.push({
      kind: "glyph",
      char: "",
      font: "",
      bbox: paint.bbox,
      pathHash: pathHashOf(paint.d),
      baseline: paint.bbox ? paint.bbox[3] : 0,
      fontSize: paint.bbox ? paint.bbox[3] - paint.bbox[1] : 0,
      source: "unbound-paint"
    });
  }
  for (const path of paths) {
    elements.push({
      kind: "path",
      char: "",
      font: "",
      bbox: path.bbox,
      pathHash: pathHashOf(path.d),
      source: "path"
    });
  }
  for (const image of images) {
    elements.push({
      kind: "image",
      char: "",
      font: "",
      bbox: image.bbox,
      pathHash: pathHashOf(image.d || ""),
      source: "image"
    });
  }
  return assignStableIds(elements);
}

/**
 * Map a painted recorder element onto a labelled element.
 * A conflict means two labels fit equally well; the caller must not guess
 * a character for that paint.
 */
export function matchPaintToLabel(paint, labels) {
  const box = paint?.bbox;
  if (!box) return { label: null, conflict: false };
  const want = paint.provenance === "glyph" || paint.kind === "glyph" ? "glyph" : paint.provenance === "image" ? "image" : "path";
  let best = null;
  let bestScore = 0;
  let second = 0;
  const area = Math.max(boxArea(box), 1e-6);
  const [cx, cy] = center(box);
  for (const label of labels) {
    if (!label?.bbox) continue;
    if (want === "glyph" && label.kind !== "glyph") continue;
    if (want === "path" && label.kind !== "path") continue;
    if (want === "image" && label.kind !== "image") continue;
    const overlap = overlapArea(box, label.bbox) / area;
    const inside = cx >= label.bbox[0] - 1 && cx <= label.bbox[2] + 1 && cy >= label.bbox[1] - 1 && cy <= label.bbox[3] + 1;
    if (want === "glyph" && !inside && overlap < 0.45) continue;
    if (want !== "glyph" && overlap < 0.45) continue;
    const score = overlap + (inside ? 0.15 : 0);
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = label;
    } else if (score > second) second = score;
  }
  if (!best || bestScore < 0.45) return { label: null, conflict: false };
  if (second > 0 && bestScore - second < 0.08) return { label: null, conflict: true };
  const insideBest = cx >= best.bbox[0] - 1.5 && cx <= best.bbox[2] + 1.5 && cy >= best.bbox[1] - 1.5 && cy <= best.bbox[3] + 1.5;
  if (want === "glyph" && !insideBest) return { label: null, conflict: true };
  return { label: best, conflict: false };
}
