/**
 * First-pass labels. Not the M2 classifier: font, Unicode, baseline
 * offset, and path shape, each with a confidence. A human review can
 * override any of them without changing element ids.
 */

import { hasMathUnicode, isMathFontName } from "./pdf-mirror.js";
import { unitIdFromMembers } from "./label-schema.js";

export const FALLBACK_CONFIDENCE = 0.65;

const EXTRA_MATH = /NewTX|Fourier-Math|TeX_CM|txsys|txsy\d*|txex|ntx(mi|sy|ex)|SFTT\d*|EuclidSymbol|MathTime|MTMI|MTSY|RMTMI|MTMIDDB|MTSYN/i;
const CODE_FACE = /CMTT|Courier|NimbusMon|Inconsolata|Consolas|DejaVu\s*Sans\s*Mono|Liberation\s*Mono|Roboto\s*Mono|LMMono|Latin\s*Modern\s*Mono|Menlo|Source\s*Code|LuxiMono|TeXGyreCursor|Courier\s*New|Mono(?!lith)/i;
const EQ_NUMBER = /^\(\d{1,3}[a-z]?\)$/;

export function isMathFace(font) {
  const name = String(font || "");
  if (!name) return false;
  return isMathFontName(name) || EXTRA_MATH.test(name);
}

export function isCodeFace(font) {
  const name = String(font || "");
  if (!name || isMathFace(name)) return false;
  return CODE_FACE.test(name);
}

function boxArea(box) {
  if (!box) return 0;
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

function unionBox(boxes) {
  const list = (boxes || []).filter((box) => box && box.length >= 4);
  if (!list.length) return null;
  return [
    Math.min(...list.map((box) => box[0])),
    Math.min(...list.map((box) => box[1])),
    Math.max(...list.map((box) => box[2])),
    Math.max(...list.map((box) => box[3]))
  ];
}

function expandBox(box, pad) {
  return [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
}

function overlapArea(a, b) {
  if (!a || !b) return 0;
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

function heightOf(element) {
  return Math.max(1, element.bbox[3] - element.bbox[1]);
}

function clusterLines(glyphs) {
  const sorted = [...glyphs].sort((a, b) => a.baseline - b.baseline || a.bbox[0] - b.bbox[0]);
  const lines = [];
  for (const glyph of sorted) {
    const height = Number(glyph.fontSize) || heightOf(glyph);
    const line = lines.find((entry) => Math.abs(entry.baseline - glyph.baseline) <= Math.max(2.5, height * 0.45));
    if (!line) {
      lines.push({ baseline: glyph.baseline, glyphs: [glyph] });
      continue;
    }
    line.glyphs.push(glyph);
    const weight = line.glyphs.length;
    line.baseline = (line.baseline * (weight - 1) + glyph.baseline) / weight;
  }
  for (const line of lines) line.glyphs.sort((a, b) => a.bbox[0] - b.bbox[0]);
  return lines;
}

function bodyBaseline(line) {
  const heights = line.glyphs.map((glyph) => Number(glyph.fontSize) || heightOf(glyph)).sort((a, b) => a - b);
  const bodyHeight = heights[Math.floor(heights.length * 0.75)] || heights[heights.length - 1] || 10;
  const body = line.glyphs.filter((glyph) => (Number(glyph.fontSize) || heightOf(glyph)) >= bodyHeight * 0.82);
  const sample = body.length ? body : line.glyphs;
  const baselines = sample.map((glyph) => glyph.baseline).sort((a, b) => a - b);
  return {
    baseline: baselines[Math.floor(baselines.length / 2)] || line.baseline,
    height: bodyHeight
  };
}

function isScript(glyph, lineInfo) {
  const height = Number(glyph.fontSize) || heightOf(glyph);
  const shift = Math.abs(glyph.baseline - lineInfo.baseline);
  return height <= lineInfo.height * 0.78 && shift >= lineInfo.height * 0.12;
}

function neighborMath(line, index) {
  const glyph = line.glyphs[index];
  for (const otherIndex of [index - 1, index + 1]) {
    const other = line.glyphs[otherIndex];
    if (!other) continue;
    const gap = otherIndex < index ? glyph.bbox[0] - other.bbox[2] : other.bbox[0] - glyph.bbox[2];
    if (gap > Math.max(heightOf(glyph), heightOf(other)) * 1.6) continue;
    if (other._math) return true;
  }
  return false;
}

function labelGlyph(glyph, line, index, lineInfo) {
  const font = glyph.font || "";
  const text = String(glyph.char || "");
  const trimmed = text.trim();
  if (isMathFace(font)) return { label: "formula", confidence: 0.96, rule: "math-font" };
  if (trimmed && hasMathUnicode(trimmed)) return { label: "formula", confidence: 0.9, rule: "math-unicode" };
  if (isCodeFace(font)) return { label: "code", confidence: 0.9, rule: "code-font" };
  const script = isScript(glyph, lineInfo);
  if (script && neighborMath(line, index)) return { label: "formula", confidence: 0.82, rule: "script-offset" };
  if (script && trimmed && trimmed.length <= 3) return { label: "formula", confidence: 0.62, rule: "script-offset-weak" };
  if (EQ_NUMBER.test(trimmed)) return { label: "text", confidence: 0.7, rule: "eq-number-candidate" };
  if (trimmed.length <= 2 && /[=+\-*/<>]/.test(trimmed) && neighborMath(line, index)) {
    return { label: "formula", confidence: 0.74, rule: "operator-between-math" };
  }
  return { label: "text", confidence: trimmed ? 0.93 : 0.8, rule: "body-font" };
}

function labelPath(element, formulaBoxes, pageWidth, pageHeight) {
  const area = boxArea(element.bbox);
  const pageArea = Math.max(1, pageWidth * pageHeight);
  if (area > pageArea * 0.02) return { label: "other", confidence: 0.88, rule: "large-path" };
  const width = element.bbox[2] - element.bbox[0];
  const height = element.bbox[3] - element.bbox[1];
  const thinBar = height <= 2.4 && width >= 8;
  let near = 0;
  for (const box of formulaBoxes) {
    const share = overlapArea(element.bbox, expandBox(box, 8)) / Math.max(area, 1);
    if (share > near) near = share;
  }
  if (thinBar && near > 0) return { label: "formula", confidence: 0.8, rule: "fraction-bar" };
  if (near >= 0.35) return { label: "formula", confidence: 0.72, rule: "path-near-formula" };
  return { label: "other", confidence: 0.55, rule: "path" };
}

function findParent(parent, index) {
  let cursor = index;
  while (parent[cursor] !== cursor) {
    parent[cursor] = parent[parent[cursor]];
    cursor = parent[cursor];
  }
  return cursor;
}

function sameCluster(a, b, pageWidth) {
  const gapX = Math.max(0, Math.max(a.bbox[0], b.bbox[0]) - Math.min(a.bbox[2], b.bbox[2]));
  const gapY = Math.max(0, Math.max(a.bbox[1], b.bbox[1]) - Math.min(a.bbox[3], b.bbox[3]));
  const height = Math.max(heightOf(a), heightOf(b));
  if (a.equationNumber || b.equationNumber) {
    return gapY <= Math.max(8, height * 1.2) && gapX < pageWidth * 0.55;
  }
  if (gapY > Math.max(6, height * 0.85)) return false;
  if (gapX > pageWidth * 0.08 && gapY < height * 0.5) return false;
  return gapX <= Math.max(14, height * 1.25) && gapY <= height * 0.8;
}

function attachEquationNumbers(elements, pageWidth) {
  const formulas = elements.filter((element) => element.label === "formula");
  for (const element of elements) {
    if (element.rule !== "eq-number-candidate") continue;
    if (element.bbox[0] < pageWidth * 0.72) continue;
    const midY = (element.bbox[1] + element.bbox[3]) / 2;
    const height = heightOf(element);
    const near = formulas.some((formula) => Math.abs(((formula.bbox[1] + formula.bbox[3]) / 2) - midY) <= Math.max(8, height * 1.4));
    if (!near) continue;
    element.label = "formula";
    element.confidence = Math.min(element.confidence, 0.74);
    element.equationNumber = true;
    element.rule = "equation-number";
  }
}

function buildUnits(elements, pageWidth) {
  const formulas = elements.filter((element) => element.label === "formula");
  const parent = formulas.map((_, index) => index);
  for (let i = 0; i < formulas.length; i += 1) {
    for (let j = i + 1; j < formulas.length; j += 1) {
      if (!sameCluster(formulas[i], formulas[j], pageWidth)) continue;
      const left = findParent(parent, i);
      const right = findParent(parent, j);
      if (left !== right) parent[right] = left;
    }
  }
  const groups = new Map();
  formulas.forEach((element, index) => {
    const root = findParent(parent, index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(element);
  });
  const text = elements.filter((element) => element.label === "text" || element.label === "code");
  const units = [];
  for (const members of groups.values()) {
    const box = unionBox(members.map((member) => member.bbox));
    const width = box[2] - box[0];
    const midY = (box[1] + box[3]) / 2;
    const band = Math.max(8, (box[3] - box[1]) * 0.65);
    let prose = 0;
    for (const item of text) {
      const itemMid = (item.bbox[1] + item.bbox[3]) / 2;
      if (Math.abs(itemMid - midY) > band) continue;
      const gapX = Math.max(0, Math.max(box[0], item.bbox[0]) - Math.min(box[2], item.bbox[2]));
      if (gapX > pageWidth * 0.08) continue;
      prose += String(item.char || "").trim().length;
    }
    const center = (box[0] + box[2]) / 2;
    const centered = Math.abs(center - pageWidth / 2) < pageWidth * 0.12 && box[0] > pageWidth * 0.1;
    const equationNumber = members.some((member) => member.equationNumber === true);
    const display = equationNumber || (width > pageWidth * 0.32 && prose < 8) || (centered && prose < 16 && width > pageWidth * 0.16);
    const type = display ? "display" : "inline";
    const confidence = members.reduce((min, member) => Math.min(min, Number(member.confidence) || 0), 1);
    const id = unitIdFromMembers(members.map((member) => member.id));
    for (const member of members) {
      member.unitId = id;
      member.unitType = type;
      member.equationNumber = member.equationNumber === true;
    }
    units.push({
      id,
      type,
      equationNumber,
      elementIds: members.map((member) => member.id),
      confidence: Math.round(confidence * 1000) / 1000,
      fallback: confidence < FALLBACK_CONFIDENCE
    });
  }
  units.sort((a, b) => a.elementIds[0].localeCompare(b.elementIds[0]));
  return units;
}

/**
 * Label elements that already have stable ids. Glyphs need `baseline`.
 * `fontSize` is optional and defaults to the box height.
 */
export function prelabelElements(elements, pageWidth, pageHeight) {
  const width = Number(pageWidth) || 1;
  const height = Number(pageHeight) || 1;
  const glyphs = elements.filter((element) => element.kind === "glyph");
  for (const glyph of glyphs) glyph._math = isMathFace(glyph.font) || hasMathUnicode(String(glyph.char || "").trim());
  const lines = clusterLines(glyphs.map((glyph) => ({
    ...glyph,
    baseline: Number.isFinite(Number(glyph.baseline)) ? Number(glyph.baseline) : glyph.bbox[3]
  })));
  const byId = new Map(glyphs.map((glyph) => [glyph.id, glyph]));
  for (const line of lines) {
    const info = bodyBaseline(line);
    line.glyphs.forEach((stub, index) => {
      const glyph = byId.get(stub.id);
      const decision = labelGlyph(glyph, line, index, info);
      glyph.label = decision.label;
      glyph.confidence = decision.confidence;
      glyph.rule = decision.rule;
      glyph.equationNumber = false;
      glyph.unitId = null;
      glyph.unitType = null;
    });
  }
  attachEquationNumbers(elements, width);
  const formulaBoxes = elements.filter((element) => element.label === "formula").map((element) => element.bbox);
  for (const element of elements) {
    if (element.kind === "glyph") continue;
    if (element.kind === "image") {
      element.label = "other";
      element.confidence = 0.9;
      element.rule = "image";
      element.equationNumber = false;
      element.unitId = null;
      element.unitType = null;
      continue;
    }
    const decision = labelPath(element, formulaBoxes, width, height);
    element.label = decision.label;
    element.confidence = decision.confidence;
    element.rule = decision.rule;
    element.equationNumber = false;
    element.unitId = null;
    element.unitType = null;
  }
  const units = buildUnits(elements, width);
  for (const element of elements) {
    delete element._math;
    if (element.label !== "formula") {
      element.unitId = null;
      element.unitType = null;
      element.equationNumber = false;
    }
    element.confidence = Math.round((Number(element.confidence) || 0) * 1000) / 1000;
  }
  return { elements, units };
}
