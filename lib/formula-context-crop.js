/**
 * Context window and the red target box for an inline formula.
 *
 * contextWindow, targetBoxPixels, and paintTargetBox match the F7W-2b script
 * (PR #166). That branch is still open. Follow-up there: import
 * contextWindow, targetBoxPixels, paintTargetBox, TARGET_BOX_COLOR,
 * TARGET_BOX_PX, and TARGET_BOX_GAP from this module and delete the local
 * copies. paintTargetBox(canvas, rect, thickness) stays valid; `gap` defaults
 * to 0. Do not change those signatures when the import lands.
 *
 * The product frame is contextCropGeometry. It pads outward from the glyph
 * union and never shrinks into hats, scripts, or numerators. The screen crop
 * does not use this module. Display formulas keep the hi-res tight crop.
 */

export const TARGET_BOX_COLOR = "#e10600";
export const TARGET_BOX_PX = 3;
/** White pixels between the glyph union and the stroke, when the gap allows. */
export const TARGET_BOX_GAP = 2;

function boxCopy(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const box = value.slice(0, 4).map((n) => Number(n));
  if (box.some((n) => !Number.isFinite(n))) return null;
  if (!(box[2] > box[0]) || !(box[3] > box[1])) return null;
  return box;
}

/**
 * Window around one formula. Inline formulas grow by about their own height
 * (at least one short text line, never a whole display). Display formulas
 * grow by one body line, not by the formula's height. Horizontal room is a
 * few words, then clamped to the paragraph column without cutting the target.
 *
 * @returns {{ bbox: number[], target: number[] } | null}
 */
export function contextWindow(formula) {
  const target = boxCopy(formula?.layoutBbox) || boxCopy(formula?.bbox);
  if (!target) return null;
  const column = boxCopy(formula?.paragraphBbox);
  const height = Math.max(0, target[3] - target[1]);
  const inline = formula?.display === false || Boolean(formula?.inlineOf);
  const line = inline ? Math.min(0.02, Math.max(height, 0.01)) : 0.014;
  const side = Math.min(0.12, Math.max(0.08, line * 5));
  let x0 = target[0] - side;
  let x1 = target[2] + side;
  let y0 = target[1] - line;
  let y1 = target[3] + line;
  if (column) {
    x0 = Math.max(x0, column[0]);
    x1 = Math.min(x1, column[2]);
  }
  x0 = Math.min(x0, target[0]);
  x1 = Math.max(x1, target[2]);
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(1, x1);
  y1 = Math.min(1, y1);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return {
    bbox: [x0, y0, x1, y1],
    target: [target[0], target[1], target[2], target[3]]
  };
}

/** Union of glyph boxes. Falls back to the layout box when no glyphs are stored. */
export function glyphUnion(formula) {
  const boxes = (Array.isArray(formula?.glyphBoxes) ? formula.glyphBoxes : [])
    .map((box) => boxCopy(box))
    .filter(Boolean);
  if (!boxes.length) return boxCopy(formula?.layoutBbox) || boxCopy(formula?.bbox);
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3]))
  ];
}

function overlapsAxis(glyphs, box, side) {
  if (side === "top" || side === "bottom") {
    return box[2] > glyphs[0] && box[0] < glyphs[2];
  }
  return box[3] > glyphs[1] && box[1] < glyphs[3];
}

/** Page-fraction gap to the nearest neighbor on one side. Infinity when none. */
function neighborRoom(glyphs, neighbors, side) {
  let best = Infinity;
  for (const box of neighbors) {
    if (!overlapsAxis(glyphs, box, side)) continue;
    let gap = Infinity;
    if (side === "left") gap = glyphs[0] - box[2];
    else if (side === "right") gap = box[0] - glyphs[2];
    else if (side === "top") gap = glyphs[1] - box[3];
    else gap = box[1] - glyphs[3];
    if (gap >= 0 && gap < best) best = gap;
  }
  return best;
}

function pageSpan(side, pageWidth, pageHeight) {
  return side === "left" || side === "right" ? pageWidth : pageHeight;
}

/**
 * Outward pad in page fractions. Never negative: a gap smaller than the
 * stroke collapses to zero and the stroke may touch the next line.
 */
function outwardPad(room, side, pageWidth, pageHeight, scale) {
  const span = pageSpan(side, pageWidth, pageHeight) * scale;
  if (!(span > 0)) return 0;
  if (!Number.isFinite(room) || room === Infinity) return TARGET_BOX_GAP / span;
  const roomPx = room * span;
  const gapPx = Math.min(TARGET_BOX_GAP, Math.max(0, roomPx - TARGET_BOX_PX));
  return gapPx / span;
}

function fitWindow(window, needed, column) {
  let box = [
    Math.min(window[0], needed[0]),
    Math.min(window[1], needed[1]),
    Math.max(window[2], needed[2]),
    Math.max(window[3], needed[3])
  ];
  if (column) {
    box = [
      Math.min(needed[0], Math.max(box[0], column[0])),
      Math.min(needed[1], Math.max(box[1], column[1])),
      Math.max(needed[2], Math.min(box[2], column[2])),
      Math.max(needed[3], Math.min(box[3], column[3]))
    ];
  }
  return [
    Math.max(0, Math.min(box[0], needed[0])),
    Math.max(0, Math.min(box[1], needed[1])),
    Math.min(1, Math.max(box[2], needed[2])),
    Math.min(1, Math.max(box[3], needed[3]))
  ];
}

/**
 * Crop window and the red-box interior for one formula.
 * `target` contains every glyph and only grows outward. `bbox` contains the
 * 3px stroke. The extra context stays inside the column; the stroke may
 * cross the column by the minimum needed to stay on the bitmap.
 *
 * @returns {{ bbox: number[], target: number[], glyphs: number[] } | null}
 */
export function contextCropGeometry(formula, {
  pageWidth = 612,
  pageHeight = 792,
  scale = 4
} = {}) {
  const glyphs = glyphUnion(formula);
  if (!glyphs) return null;
  const width = Number(pageWidth) > 0 ? Number(pageWidth) : 612;
  const height = Number(pageHeight) > 0 ? Number(pageHeight) : 792;
  const used = Number(scale) > 0 ? Number(scale) : 4;
  const neighbors = (Array.isArray(formula?.maskBoxes) ? formula.maskBoxes : [])
    .map((box) => boxCopy(box))
    .filter(Boolean);
  const pads = {};
  for (const side of ["left", "right", "top", "bottom"]) {
    pads[side] = outwardPad(neighborRoom(glyphs, neighbors, side), side, width, height, used);
  }
  const target = [
    glyphs[0] - pads.left,
    glyphs[1] - pads.top,
    glyphs[2] + pads.right,
    glyphs[3] + pads.bottom
  ];
  // One extra pixel so rounding the crop origin cannot clip the 3px stroke.
  const strokeX = (TARGET_BOX_PX + 1) / (width * used);
  const strokeY = (TARGET_BOX_PX + 1) / (height * used);
  const needed = [
    target[0] - strokeX,
    target[1] - strokeY,
    target[2] + strokeX,
    target[3] + strokeY
  ];
  const seeded = contextWindow({
    ...formula,
    layoutBbox: glyphs,
    bbox: glyphs
  });
  const base = seeded?.bbox || target;
  const column = boxCopy(formula?.paragraphBbox);
  const bbox = fitWindow(base, needed, column);
  if (!(bbox[2] > bbox[0]) || !(bbox[3] > bbox[1])) return null;
  return {
    bbox,
    target,
    glyphs: glyphs.slice()
  };
}

/** Page-fraction box → integer pixels on a crop whose origin is `crop`. */
export function targetBoxPixels(crop, target, pageWidth, pageHeight, scale) {
  const fullW = pageWidth * scale;
  const fullH = pageHeight * scale;
  if (!(fullW > 0) || !(fullH > 0) || !Array.isArray(crop) || !Array.isArray(target)) return null;
  const x = Math.round((target[0] - crop[0]) * fullW);
  const y = Math.round((target[1] - crop[1]) * fullH);
  const x2 = Math.round((target[2] - crop[0]) * fullW);
  const y2 = Math.round((target[3] - crop[1]) * fullH);
  const w = x2 - x;
  const h = y2 - y;
  if (!(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

/** Stroke outside `rect` so the glyphs inside stay unpainted. `gap` is extra white pixels. */
export function paintTargetBox(canvas, rect, thickness = TARGET_BOX_PX, gap = 0) {
  if (!canvas || !rect || !(rect.w > 0) || !(rect.h > 0)) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.fillRect !== "function") return false;
  const t = thickness > 0 ? thickness : TARGET_BOX_PX;
  const g = gap > 0 ? gap : 0;
  const { x, y, w, h } = rect;
  ctx.fillStyle = TARGET_BOX_COLOR;
  ctx.fillRect(x - t - g, y - t - g, w + 2 * (t + g), t);
  ctx.fillRect(x - t - g, y + h + g, w + 2 * (t + g), t);
  ctx.fillRect(x - t - g, y - g, t, h + 2 * g);
  ctx.fillRect(x + w + g, y - g, t, h + 2 * g);
  return true;
}
