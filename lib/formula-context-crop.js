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
 * The product frame is contextCropGeometry. pdf.js glyph boxes are font
 * metric boxes: a display bracket can leave ~38px of empty metric above the
 * ink at scale 4, and a descender can extend ~9px below the metric box.
 * seatInkBox measures ink on the rendered crop and seats the red edge in the
 * inter-line gap. The interior contains the ink and never shrinks into it.
 * Without a bitmap the fallback target still contains the glyph union.
 * The screen crop does not use this module. Display formulas keep the hi-res
 * tight crop.
 */

export const TARGET_BOX_COLOR = "#e10600";
export const TARGET_BOX_PX = 3;
/** White pixels between the ink and the stroke, when the gap allows. */
export const TARGET_BOX_GAP = 2;
/**
 * Pixels outside the metric box that can still be this formula's ink.
 * Descenders of about 9px at scale 4 fit. A dense row, or ink after a
 * 3-row blank, is the next line instead.
 */
export const INK_OUTSIDE_PX = 12;

/** Inline formula: an explicit inline flag, or a block hosted by a paragraph. */
export function formulaIsInline(block) {
  return block?.display === false || Boolean(block?.inlineOf);
}

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
  const inline = formulaIsInline(formula);
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
    // Horizontal room stays in the column. Vertical room does not: a
    // one-line paragraph box would erase the line above and below.
    box = [
      Math.min(needed[0], Math.max(box[0], column[0])),
      box[1],
      Math.max(needed[2], Math.min(box[2], column[2])),
      box[3]
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
  // Ink can sit INK_OUTSIDE_PX past the metric box, and the stroke needs
  // room beyond that. One extra pixel so rounding cannot clip the stroke.
  const strokeX = (TARGET_BOX_PX + 1) / (width * used);
  const slackY = (INK_OUTSIDE_PX + TARGET_BOX_PX + TARGET_BOX_GAP + 1) / (height * used);
  const needed = [
    target[0] - strokeX,
    Math.min(target[1], glyphs[1]) - slackY,
    target[2] + strokeX,
    Math.max(target[3], glyphs[3]) + slackY
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

function imageRaster(image) {
  const data = image?.data || image?.rgba;
  const width = image?.width | 0;
  const height = image?.height | 0;
  if (!data || !(width > 0) || !(height > 0)) return null;
  return { data, width, height };
}

function pixelRect(rect) {
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null;
  const x = Math.floor(Number(rect.x));
  const y = Math.floor(Number(rect.y));
  const x2 = Math.ceil(Number(rect.x) + Number(rect.w));
  const y2 = Math.ceil(Number(rect.y) + Number(rect.h));
  if (![x, y, x2, y2].every(Number.isFinite) || !(x2 > x) || !(y2 > y)) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

function darkPixel(data, width, x, y) {
  const index = (y * width + x) * 4;
  return data[index] < 96 && data[index + 1] < 96 && data[index + 2] < 96 && data[index + 3] > 180;
}

function pixelGlyphUnion(boxes, pad = 0) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const box of boxes) {
    x0 = Math.min(x0, box.x - pad);
    y0 = Math.min(y0, box.y - pad);
    x1 = Math.max(x1, box.x + box.w - 1 + pad);
    y1 = Math.max(y1, box.y + box.h - 1 + pad);
  }
  if (!(x1 >= x0) || !(y1 >= y0)) return null;
  return { x0, y0, x1, y1 };
}

function insideUnion(union, x, y) {
  return Boolean(union) && x >= union.x0 && x <= union.x1 && y >= union.y0 && y <= union.y1;
}

/**
 * Every dark component that touches a glyph box. One pdf.js item can hold
 * several of them: the hat and its base, or `[` and `0` inside `[0,`.
 * A neighbor line only grazes a tall box, so most of its pixels sit outside.
 */
function componentsTouchingGlyphs(raster, boxes) {
  const { data, width, height } = raster;
  const tight = pixelGlyphUnion(boxes, 0);
  const loose = pixelGlyphUnion(boxes, 1);
  if (!tight) return [];
  const seen = new Uint8Array(width * height);
  const stack = [];
  const components = [];
  for (const box of boxes) {
    const x0 = Math.max(0, box.x);
    const y0 = Math.max(0, box.y);
    const x1 = Math.min(width - 1, box.x + box.w - 1);
    const y1 = Math.min(height - 1, box.y + box.h - 1);
    if (x1 < x0 || y1 < y0) continue;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const seed = y * width + x;
        if (seen[seed] || !darkPixel(data, width, x, y)) continue;
        stack.length = 0;
        stack.push(x, y);
        const pixels = [];
        let inside = 0;
        let contained = true;
        while (stack.length) {
          const py = stack.pop();
          const px = stack.pop();
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const id = py * width + px;
          if (seen[id] || !darkPixel(data, width, px, py)) continue;
          seen[id] = 1;
          pixels.push(id);
          if (insideUnion(tight, px, py)) inside += 1;
          if (!insideUnion(loose, px, py)) contained = false;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              if (dx || dy) stack.push(px + dx, py + dy);
            }
          }
        }
        if (!pixels.length || inside < 1) continue;
        components.push({ pixels, inside, contained });
      }
    }
  }
  return components;
}

function ownsFormulaInk(component) {
  // A descender or a bracket tip hangs out of the metric box. A neighbor
  // line that only overlaps a tall box does not: most of it is outside.
  return component.inside * 2 >= component.pixels.length;
}

function paintMask(raster, components) {
  const { width } = raster;
  const mask = new Uint8Array(raster.width * raster.height);
  let top = Infinity;
  let bottom = -1;
  let left = Infinity;
  let right = -1;
  let any = false;
  for (const component of components) {
    if (!ownsFormulaInk(component)) continue;
    any = true;
    for (const id of component.pixels) {
      mask[id] = 1;
      const x = id % width;
      const y = (id / width) | 0;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (!any) return null;
  return { mask, top, bottom, left, right };
}

function formulaInkMask(raster, boxes) {
  return paintMask(raster, componentsTouchingGlyphs(raster, boxes));
}

function neighborInkRow(raster, mask, x0, x1, from, to, dir) {
  const { data, width, height } = raster;
  const left = Math.max(0, x0);
  const right = Math.min(width - 1, x1);
  if (right < left) return null;
  for (let y = from; dir > 0 ? y <= to : y >= to; y += dir) {
    if (y < 0 || y >= height) break;
    for (let x = left; x <= right; x += 1) {
      if (darkPixel(data, width, x, y) && !mask[y * width + x]) return y;
    }
  }
  return null;
}

function gapPad(room, thickness, gap) {
  if (!Number.isFinite(room)) return gap;
  return Math.min(gap, Math.max(0, room - thickness));
}

/**
 * Ink extent of one formula on the rendered crop.
 * `top` / `bottom` are inclusive ink rows. Neighbors are row indexes, or null.
 */
export function measureFormulaInk(image, glyphRect, glyphs) {
  const raster = imageRaster(image);
  const glyph = pixelRect(glyphRect);
  if (!raster || !glyph) return null;
  const boxes = (Array.isArray(glyphs) && glyphs.length ? glyphs : [glyphRect])
    .map((box) => pixelRect(box))
    .filter(Boolean);
  const ink = formulaInkMask(raster, boxes.length ? boxes : [glyph]);
  if (!ink) {
    return {
      top: glyph.y,
      bottom: glyph.y + glyph.h - 1,
      neighborAbove: null,
      neighborBelow: null,
      glyph
    };
  }
  const x0 = glyph.x;
  const x1 = glyph.x + glyph.w - 1;
  return {
    top: ink.top,
    bottom: ink.bottom,
    inkLeft: ink.left,
    inkRight: ink.right,
    neighborAbove: neighborInkRow(raster, ink.mask, x0, x1, ink.top - 1, 0, -1),
    neighborBelow: neighborInkRow(raster, ink.mask, x0, x1, ink.bottom + 1, raster.height - 1, 1),
    glyph,
    mask: ink.mask
  };
}

/**
 * Ink that lives entirely inside the glyph boxes (±1px, so it cannot be a
 * neighbor line). Each of those pixels must sit at least `margin` px inside
 * `rect`. This does not use the seated mask, so a box that drops a hat or a
 * bracket still counts.
 */
export function containedGlyphInkShortfall(image, glyphs, rect, margin = 2) {
  const raster = imageRaster(image);
  const interior = pixelRect(rect);
  const boxes = (glyphs || []).map((box) => pixelRect(box)).filter(Boolean);
  if (!raster || !interior || !boxes.length) return 0;
  const pad = margin > 0 ? margin : 0;
  const x0 = interior.x + pad;
  const y0 = interior.y + pad;
  const x1 = interior.x + interior.w - pad;
  const y1 = interior.y + interior.h - pad;
  const { width } = raster;
  let short = 0;
  for (const component of componentsTouchingGlyphs(raster, boxes)) {
    if (!component.contained) continue;
    for (const id of component.pixels) {
      const x = id % width;
      const y = (id / width) | 0;
      if (x < x0 || x >= x1 || y < y0 || y >= y1) short += 1;
    }
  }
  return short;
}

/** Formula-ink pixels of `glyphs` that fall outside `rect`. */
export function formulaInkOutsideCount(image, glyphs, rect) {
  const raster = imageRaster(image);
  const interior = pixelRect(rect);
  if (!raster || !interior) return 0;
  const boxes = (glyphs || []).map((box) => pixelRect(box)).filter(Boolean);
  const ink = formulaInkMask(raster, boxes);
  if (!ink) return 0;
  const { width } = raster;
  let outside = 0;
  for (let id = 0; id < ink.mask.length; id += 1) {
    if (!ink.mask[id]) continue;
    const x = id % width;
    const y = (id / width) | 0;
    if (x < interior.x || x >= interior.x + interior.w || y < interior.y || y >= interior.y + interior.h) {
      outside += 1;
    }
  }
  return outside;
}

/** Union of glyph boxes in crop pixels. Empty when none map onto the crop. */
export function glyphRectPixels(crop, glyphBoxes, pageWidth, pageHeight, scale) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const box of glyphBoxes || []) {
    const px = targetBoxPixels(crop, box, pageWidth, pageHeight, scale);
    if (!px) continue;
    x0 = Math.min(x0, px.x);
    y0 = Math.min(y0, px.y);
    x1 = Math.max(x1, px.x + px.w);
    y1 = Math.max(y1, px.y + px.h);
  }
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Red-box interior in crop pixels. The interior contains the formula ink.
 * When the gap to the next line fits the stroke plus TARGET_BOX_GAP, the
 * edge sits TARGET_BOX_GAP into that gap. A tighter gap shrinks the white
 * pad, down to zero, and never crosses into the ink. With no bitmap the
 * interior is the metric box plus the white gap.
 */
export function seatInkBox(image, glyphRect, {
  thickness = TARGET_BOX_PX,
  gap = TARGET_BOX_GAP,
  glyphs = null
} = {}) {
  const glyph = pixelRect(glyphRect);
  if (!glyph) return null;
  const stroke = thickness > 0 ? thickness : TARGET_BOX_PX;
  const white = gap > 0 ? gap : 0;
  const measured = measureFormulaInk(image, glyph, glyphs);
  if (!measured) {
    return {
      x: glyph.x - white,
      y: glyph.y - white,
      w: glyph.w + 2 * white,
      h: glyph.h + 2 * white
    };
  }
  const aboveRoom = measured.neighborAbove == null
    ? Infinity
    : measured.top - measured.neighborAbove - 1;
  const belowRoom = measured.neighborBelow == null
    ? Infinity
    : measured.neighborBelow - measured.bottom - 1;
  const padTop = gapPad(aboveRoom, stroke, white);
  const padBottom = gapPad(belowRoom, stroke, white);
  const top = measured.top - padTop;
  const bottom = measured.bottom + 1 + padBottom;
  // The metric box misses the side of ≤, T, and ellipsis dots. The red box
  // takes that ink, then the same white gap used above and below.
  const inkLeft = Number.isFinite(measured.inkLeft) ? measured.inkLeft : glyph.x;
  const inkRight = Number.isFinite(measured.inkRight) ? measured.inkRight : glyph.x + glyph.w - 1;
  const left = Math.min(glyph.x, inkLeft) - white;
  const right = Math.max(glyph.x + glyph.w, inkRight + 1) + white;
  if (!(right > left) || !(bottom > top)) {
    return { x: glyph.x, y: glyph.y, w: glyph.w, h: glyph.h };
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
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
