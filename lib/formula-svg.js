/**
 * Standalone formula SVG from a recorded page and an existing formula unit.
 * Membership comes from the current text-layer pipeline (glyph boxes).
 * Classifier changes are out of scope for M0.
 */

import { bboxOfOps, formatPathNumber, parseSvgPath } from "./svg-recorder.js";

/**
 * Ink tolerance against the left-pane FontFace crop.
 * Out-of-bounds uses the same radius: an SVG pixel counts only when the
 * crop has no ink (luma below referenceInkLuma) inside that radius.
 * Gate target for that count is 0.
 */
export const INK_AA_TOLERANCE = Object.freeze({
  referenceInkLuma: 160,
  svgCoverLuma: 210,
  radius: 1,
  // Gray SVG antialiasing below referenceInkLuma still counts in outOfBounds.
  // solid is the subset darker than this, used to separate a real mark from fringe.
  solidInkLuma: 96
});

const SAFE_PATH = /^[MLHVCSQTAZ0-9eE+.\-\s,]*$/;

function finiteBox(box) {
  return Array.isArray(box) && box.length >= 4 && box.every((value) => Number.isFinite(Number(value)));
}

export function pageBox(box, pageWidth, pageHeight) {
  if (!finiteBox(box)) return null;
  const width = Number(pageWidth) || 0;
  const height = Number(pageHeight) || 0;
  const x0 = Number(box[0]) * width;
  const y0 = Number(box[1]) * height;
  const x1 = Number(box[2]) * width;
  const y1 = Number(box[3]) * height;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

export function boxArea(box) {
  if (!box) return 0;
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

export function overlapArea(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

export function unionBox(boxes) {
  const list = (boxes || []).filter(Boolean);
  if (!list.length) return null;
  return [
    Math.min(...list.map((box) => box[0])),
    Math.min(...list.map((box) => box[1])),
    Math.max(...list.map((box) => box[2])),
    Math.max(...list.map((box) => box[3]))
  ];
}

export function expandBox(box, pad) {
  if (!box) return null;
  const amount = Number(pad) || 0;
  return [box[0] - amount, box[1] - amount, box[2] + amount, box[3] + amount];
}

function paintBox(element) {
  if (!element?.bbox) return null;
  const pad = element.op === "stroke" ? (Number(element.lineWidth) || 0) / 2 : 0;
  return expandBox(element.bbox, pad);
}

function bestOverlap(box, boxes) {
  let best = 0;
  for (const other of boxes || []) best = Math.max(best, overlapArea(box, other));
  return best;
}

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;"
  }[ch]));
}

function safePath(d) {
  const text = String(d || "");
  if (!SAFE_PATH.test(text)) return "";
  return text;
}

function safeColor(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : "";
}

/**
 * Text-item box in the same normalized viewport space as formula glyphBoxes.
 * Mirrors the private item box used by the text-layer pipeline.
 */
export function textItemNormBox(item, viewport) {
  const transform = Array.isArray(item?.transform) ? item.transform : [];
  const x = Number.isFinite(Number(item?.x)) ? Number(item.x) : Number(transform[4]) || 0;
  const y = Number.isFinite(Number(item?.y)) ? Number(item.y) : Number(transform[5]) || 0;
  const width = Number(item?.width) || 0;
  const height = Number(item?.height) || 0;
  const rect = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
  const vw = Math.max(1, Number(viewport.width) || 1);
  const vh = Math.max(1, Number(viewport.height) || 1);
  const x0 = Math.min(rect[0], rect[2]) / vw;
  const y0 = Math.min(rect[1], rect[3]) / vh;
  const x1 = Math.max(rect[0], rect[2]) / vw;
  const y1 = Math.max(rect[1], rect[3]) / vh;
  return [x0, y0, x1, y1];
}

export function foreignGlyphBoxes(formula, items, viewport) {
  const own = formula?.glyphBoxes || [];
  const foreign = [];
  for (const item of items || []) {
    if (!String(item?.str || "").trim()) continue;
    const box = textItemNormBox(item, viewport);
    const area = boxArea(box);
    if (!(area > 0)) continue;
    const owned = own.some((glyph) => overlapArea(box, glyph) / area > 0.5);
    if (!owned) foreign.push(box);
  }
  return foreign;
}

function centerOf(box) {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

function centerInBoxes(box, boxes, pad) {
  const [cx, cy] = centerOf(box);
  return (boxes || []).some((other) => cx >= other[0] - pad && cx <= other[2] + pad && cy >= other[1] - pad && cy <= other[3] + pad);
}

/**
 * Glyph ink has to sit on this unit's own glyph boxes and inside the
 * formula box. A body line that only grazes the box edge is not a member.
 * Vector rules stay at the length pdf.js painted; they are not stretched
 * or clipped to a tight pipeline box.
 */
export function selectFormulaElements(record, formula) {
  const pageWidth = Number(formula?.pageWidth) || Number(record?.width) || 0;
  const pageHeight = Number(formula?.pageHeight) || Number(record?.height) || 0;
  const glyphs = (formula?.glyphBoxes || []).map((box) => pageBox(box, pageWidth, pageHeight)).filter(Boolean);
  const foreign = (formula?.foreignBoxes || []).map((box) => pageBox(box, pageWidth, pageHeight)).filter(Boolean);
  let unit = pageBox(formula?.bbox, pageWidth, pageHeight);
  if (!unit || boxArea(unit) < 0.5) unit = unionBox(glyphs);
  const warnings = [];
  if (!unit || boxArea(unit) < 0.5 || !glyphs.length) {
    warnings.push("degenerate-formula-box");
    return { elements: [], viewBox: unit, warnings };
  }
  const grown = expandBox(unit, 2);
  const selected = [];
  const rejected = [];
  for (const element of record?.elements || []) {
    if (!element || element.provenance === "background" || element.synthetic) continue;
    if (element.provenance === "image" || element.op === "drawImage" || element.provenance === "text") {
      const box = paintBox(element);
      if (overlapArea(box, grown) > 0) {
        rejected.push({ id: element.id, provenance: element.provenance, reason: "non-vector", bbox: element.bbox });
      }
      continue;
    }
    const box = paintBox(element);
    const area = Math.max(boxArea(box), 1e-6);
    const onFormula = bestOverlap(box, glyphs);
    const onForeign = bestOverlap(box, foreign);
    const inside = overlapArea(box, grown) / area;
    if (element.provenance === "glyph") {
      const inUnit = overlapArea(box, unit) / area;
      const onFormulaRatio = onFormula / area;
      const onBand = centerInBoxes(box, glyphs, 0.8);
      const keep = inUnit >= 0.55 && onBand && onFormulaRatio >= 0.45 && onFormula >= onForeign;
      if (keep) selected.push({ ...element, reason: "glyph-membership" });
      else if (overlapArea(box, grown) > 0) {
        rejected.push({ id: element.id, provenance: element.provenance, reason: "outside-formula-glyphs", bbox: element.bbox });
      }
      continue;
    }
    const [cx, cy] = centerOf(box);
    const centerInUnit = cx >= unit[0] - 1 && cx <= unit[2] + 1 && cy >= unit[1] - 1 && cy <= unit[3] + 1;
    const mostlyInside = inside >= 0.65 && centerInUnit;
    const onInk = onFormula / area >= 0.45 && onFormula >= onForeign;
    const keep = (mostlyInside || onInk) && onForeign < Math.max(onFormula, area * 0.35);
    if (keep) selected.push({ ...element, reason: "path-inside-unit" });
    else if (overlapArea(box, grown) > 0) {
      rejected.push({ id: element.id, provenance: element.provenance, reason: "outside-unit", bbox: element.bbox });
    }
  }
  let view = unit.slice();
  const ink = unionBox(selected.map((element) => paintBox(element)));
  if (ink) {
    const limit = expandBox(unit, 8);
    view = [
      Math.max(limit[0], Math.min(unit[0], ink[0])),
      Math.max(limit[1], Math.min(unit[1], ink[1])),
      Math.min(limit[2], Math.max(unit[2], ink[2])),
      Math.min(limit[3], Math.max(unit[3], ink[3]))
    ];
  }
  return { elements: selected, viewBox: view, warnings, rejected };
}

/** Keep the part of a straight rule that actually crosses the formula box. */
export function clipStrokeToRect(element, rect) {
  if (!element || element.op !== "stroke" || !rect) return null;
  const ops = parseSvgPath(element.d);
  const moves = ops.filter((op) => op.t === "M" || op.t === "L");
  if (ops.some((op) => op.t === "C" || op.t === "Q") || moves.length < 2) return null;
  const segments = [];
  let cursor = null;
  for (const op of ops) {
    if (op.t === "M") cursor = op;
    else if (op.t === "L" && cursor) {
      const clipped = clipSegment(cursor.x, cursor.y, op.x, op.y, rect);
      if (clipped) segments.push(clipped);
      cursor = op;
    }
  }
  if (!segments.length) return null;
  const kept = segments.filter((segment) => Math.hypot(segment[2] - segment[0], segment[3] - segment[1]) >= 1.5);
  if (!kept.length) return null;
  const d = kept.map((segment) => `M${formatPathNumber(segment[0])} ${formatPathNumber(segment[1])}L${formatPathNumber(segment[2])} ${formatPathNumber(segment[3])}`).join("");
  const bbox = bboxOfOps(parseSvgPath(d));
  if (!bbox) return null;
  return { ...element, d, bbox };
}

function clipSegment(x0, y0, x1, y1, rect) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - rect[0], rect[2] - x0, y0 - rect[1], rect[3] - y0];
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  if (t1 < t0) return null;
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

export function buildFormulaSvg(record, formula) {
  const selection = selectFormulaElements(record, formula);
  const view = selection.viewBox || [0, 0, 0, 0];
  const x = view[0];
  const y = view[1];
  const w = Math.max(0, view[2] - view[0]);
  const h = Math.max(0, view[3] - view[1]);
  const clips = new Map();
  const body = [];
  const listed = [];
  for (const element of selection.elements) {
    const d = safePath(element.d);
    if (!d) {
      selection.warnings.push(`dropped-unsafe-path:${element.id}`);
      continue;
    }
    const fill = element.op === "fill" ? (safeColor(element.fill) || "#000000") : "none";
    const stroke = element.op === "stroke" ? (safeColor(element.stroke) || "#000000") : "none";
    if (element.op === "fill" && !safeColor(element.fill)) selection.warnings.push(`fill-fallback:${element.id}`);
    const attrs = [
      `d="${escapeAttr(d)}"`,
      `fill="${fill}"`,
      `stroke="${stroke}"`,
      `data-provenance="${element.provenance === "glyph" ? "glyph" : "path"}"`,
      `data-id="${element.id}"`
    ];
    if (element.op === "stroke") {
      attrs.push(`stroke-width="${formatPathNumber(element.lineWidth || 1)}"`);
      if (element.lineCap && element.lineCap !== "butt") attrs.push(`stroke-linecap="${escapeAttr(element.lineCap)}"`);
      if (element.lineJoin && element.lineJoin !== "miter") attrs.push(`stroke-linejoin="${escapeAttr(element.lineJoin)}"`);
      if (element.miterLimit && element.miterLimit !== 10) attrs.push(`stroke-miterlimit="${formatPathNumber(element.miterLimit)}"`);
      if (element.dash?.length) attrs.push(`stroke-dasharray="${element.dash.map(formatPathNumber).join(" ")}"`);
    }
    if (element.fillRule === "evenodd") attrs.push(`fill-rule="evenodd"`);
    if (Number.isFinite(element.alpha) && element.alpha < 0.999) attrs.push(`opacity="${formatPathNumber(element.alpha)}"`);
    let clipAttr = "";
    if (element.clips?.length) {
      const key = element.clips.map((clip) => `${clip.rule}:${clip.d}`).join("|");
      if (!clips.has(key)) clips.set(key, element.clips);
      const index = [...clips.keys()].indexOf(key);
      clipAttr = ` clip-path="url(#c${index})"`;
    }
    body.push(`<path ${attrs.join(" ")}${clipAttr}/>`);
    listed.push({
      id: element.id,
      op: element.op,
      provenance: element.provenance,
      reason: element.reason,
      lineWidth: element.op === "stroke" ? Number(element.lineWidth) || 0 : 0,
      bbox: element.bbox.map((value) => Math.round(value * 1000) / 1000)
    });
  }
  const defs = [];
  let clipIndex = 0;
  for (const clipList of clips.values()) {
    const paths = clipList.map((clip) => {
      const d = safePath(clip.d);
      const rule = clip.rule === "evenodd" ? ` clip-rule="evenodd"` : "";
      return `<path d="${escapeAttr(d)}"${rule}/>`;
    }).join("");
    defs.push(`<clipPath id="c${clipIndex}" clipPathUnits="userSpaceOnUse">${paths}</clipPath>`);
    clipIndex += 1;
  }
  // clip-path indexes were assigned by Map insertion order, matching defs.
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${formatPathNumber(x)} ${formatPathNumber(y)} ${formatPathNumber(w)} ${formatPathNumber(h)}" width="${formatPathNumber(w)}" height="${formatPathNumber(h)}">`,
    defs.length ? `<defs>${defs.join("")}</defs>` : "",
    body.join(""),
    "</svg>"
  ].join("");
  return {
    svg,
    viewBox: { x, y, width: w, height: h },
    elements: listed,
    bytes: new TextEncoder().encode(svg).length,
    elementCount: listed.length,
    domElementCount: listed.length + clipIndex,
    warnings: selection.warnings,
    rejected: selection.rejected || []
  };
}

export function lumaOf(data, index) {
  return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
}

function inRadius(data, width, height, x, y, radius, lumaMax) {
  const x0 = Math.max(0, x - radius);
  const y0 = Math.max(0, y - radius);
  const x1 = Math.min(width - 1, x + radius);
  const y1 = Math.min(height - 1, y + radius);
  for (let yy = y0; yy <= y1; yy += 1) {
    for (let xx = x0; xx <= x1; xx += 1) {
      if (lumaOf(data, (yy * width + xx) * 4) < lumaMax) return true;
    }
  }
  return false;
}

/**
 * Pixels of `reference` that are ink inside `mask` and are not covered by
 * `svg` within the AA radius. mask is a Uint8Array, 1 = test this pixel.
 */
export function countMissingInk(reference, svg, width, height, mask, tolerance = INK_AA_TOLERANCE) {
  const refInk = tolerance.referenceInkLuma;
  const cover = tolerance.svgCoverLuma;
  const radius = tolerance.radius;
  const solidMax = tolerance.solidInkLuma ?? 96;
  let missing = 0;
  let solid = 0;
  let referenceInk = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (mask && !mask[pixel]) continue;
      const luma = lumaOf(reference, pixel * 4);
      if (luma >= refInk) continue;
      referenceInk += 1;
      if (!inRadius(svg, width, height, x, y, radius, cover)) {
        missing += 1;
        if (luma < solidMax) solid += 1;
      }
    }
  }
  return { missing, solid, referenceInk };
}

/**
 * SVG ink the left-pane crop does not have within the AA radius.
 * This is the gate for extra ink. Element bboxes are not the allowed region.
 */
export function countOutOfBoundsInk(reference, svg, width, height, tolerance = INK_AA_TOLERANCE) {
  const ink = tolerance.referenceInkLuma;
  const radius = tolerance.radius;
  const solidMax = tolerance.solidInkLuma ?? 96;
  let outOfBounds = 0;
  let solid = 0;
  let svgInk = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const luma = lumaOf(svg, pixel * 4);
      if (luma >= ink) continue;
      svgInk += 1;
      if (!inRadius(reference, width, height, x, y, radius, ink)) {
        outOfBounds += 1;
        if (luma < solidMax) solid += 1;
      }
    }
  }
  return { outOfBounds, solid, svgInk };
}

/** SVG ink pixels outside `allowed` (1 = inside the formula geometry). */
export function countExtraInk(svg, width, height, allowed, tolerance = INK_AA_TOLERANCE) {
  const ink = tolerance.referenceInkLuma;
  const radius = tolerance.radius;
  let extra = 0;
  let svgInk = 0;
  for (let y = 0; y < height; y += 1) {
    for (let xx = 0; xx < width; xx += 1) {
      const pixel = y * width + xx;
      if (lumaOf(svg, pixel * 4) >= ink) continue;
      svgInk += 1;
      if (allowed && allowed[pixel]) continue;
      if (allowed && inRadiusMask(allowed, width, height, xx, y, radius)) continue;
      extra += 1;
    }
  }
  return { extra, svgInk };
}

function inRadiusMask(mask, width, height, x, y, radius) {
  const x0 = Math.max(0, x - radius);
  const y0 = Math.max(0, y - radius);
  const x1 = Math.min(width - 1, x + radius);
  const y1 = Math.min(height - 1, y + radius);
  for (let yy = y0; yy <= y1; yy += 1) {
    for (let xx = x0; xx <= x1; xx += 1) {
      if (mask[yy * width + xx]) return true;
    }
  }
  return false;
}

export function diffStats(left, right, width, height, mask) {
  let count = 0;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < width * height; i += 1) {
    if (mask && !mask[i]) continue;
    const delta = Math.abs(lumaOf(left, i * 4) - lumaOf(right, i * 4));
    count += 1;
    sum += delta;
    if (delta > max) max = delta;
  }
  return { max, mean: count ? sum / count : 0, count };
}

export function maskFromBoxes(width, height, includeBoxes, excludeBoxes = []) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const cy = y + 0.5;
    for (let x = 0; x < width; x += 1) {
      const cx = x + 0.5;
      if (!includeBoxes.some((box) => containsPoint(box, cx, cy))) continue;
      if (excludeBoxes.some((box) => containsPoint(box, cx, cy))) continue;
      mask[y * width + x] = 1;
    }
  }
  return mask;
}

function containsPoint(box, x, y) {
  return box && x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
}

export function svgSecurityIssues(svg) {
  const text = String(svg || "");
  const issues = [];
  if (/<script/i.test(text)) issues.push("script");
  if (/\bhref\s*=/i.test(text)) issues.push("href");
  if (/xlink:/i.test(text)) issues.push("xlink");
  if (/javascript:/i.test(text)) issues.push("javascript");
  const withoutNamespace = text.replace('xmlns="http://www.w3.org/2000/svg"', "");
  if (/https?:\/\//i.test(withoutNamespace)) issues.push("external-url");
  if (/<!ENTITY/i.test(text)) issues.push("entity");
  if (/on[a-z]+\s*=/i.test(text)) issues.push("event-handler");
  return issues;
}
