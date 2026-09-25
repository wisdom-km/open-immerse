/**
 * Ground-truth ids for one PDF page.
 *
 * An element id is a pure function of kind, char, font, quantized bbox,
 * path hash, and the ordinal of that fingerprint on the page. Char, font,
 * and bbox are stored on the same object the id was computed from, so a
 * label cannot name one character and point at another element's box.
 * Paths keep an empty char and an empty font. A glyph's char is the whole
 * text item, never a slice of a longer string.
 */

import { sha256Hex } from "./sha256.js";

export const LABEL_SCHEMA = "open-immerse.labels/v1";
export const LABELS = Object.freeze(["formula", "text", "code", "other"]);
export const UNIT_TYPES = Object.freeze(["display", "inline"]);
export const KINDS = Object.freeze(["glyph", "path", "image"]);

const FIELD_SEP = "\u001f";

export function quantizeCoord(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const rounded = Math.round(number * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function quantizeBox(box) {
  if (!Array.isArray(box) || box.length < 4) return [0, 0, 0, 0];
  return [0, 1, 2, 3].map((index) => quantizeCoord(box[index]));
}

export function sameBox(a, b) {
  const left = quantizeBox(a);
  const right = quantizeBox(b);
  return left.every((value, index) => value === right[index]);
}

export function elementFingerprint(element) {
  const box = quantizeBox(element?.bbox);
  return [
    element?.kind || "",
    String(element?.char ?? ""),
    String(element?.font ?? ""),
    box.join(","),
    String(element?.pathHash ?? "")
  ].join(FIELD_SEP);
}

export function elementId(fingerprint, ordinal) {
  return `e${sha256Hex(`${fingerprint}${FIELD_SEP}${ordinal}`).slice(0, 16)}`;
}

export function unitIdFromMembers(elementIds) {
  const sorted = [...elementIds].map(String).sort();
  return `u${sha256Hex(sorted.join(",")).slice(0, 12)}`;
}

/**
 * Assign stable ids in the given order. Equal fingerprints get ordinals
 * 0, 1, 2… in that same order. The returned bbox is the quantized one.
 */
export function assignStableIds(elements) {
  const counts = new Map();
  return (elements || []).map((element) => {
    const next = {
      kind: element.kind,
      char: String(element.char ?? ""),
      font: String(element.font ?? ""),
      bbox: quantizeBox(element.bbox),
      pathHash: String(element.pathHash ?? "")
    };
    const fingerprint = elementFingerprint(next);
    const ordinal = counts.get(fingerprint) || 0;
    counts.set(fingerprint, ordinal + 1);
    return {
      ...element,
      ...next,
      ordinal,
      id: elementId(fingerprint, ordinal)
    };
  });
}

export function identityMatches(element) {
  if (!element || typeof element.id !== "string") return false;
  const ordinal = Number(element.ordinal);
  if (!Number.isInteger(ordinal) || ordinal < 0) return false;
  return element.id === elementId(elementFingerprint(element), ordinal);
}

function push(issues, message) {
  issues.push(message);
}

/**
 * Check one page label file. Issues are human-readable. An empty list
 * means char, font, bbox, and id describe the same element.
 */
export function verifyPageLabels(page) {
  const issues = [];
  if (!page || page.schema !== LABEL_SCHEMA) push(issues, "schema");
  if (!Number.isInteger(page?.page) || page.page < 1) push(issues, "page");
  const elements = Array.isArray(page?.elements) ? page.elements : null;
  const units = Array.isArray(page?.units) ? page.units : null;
  if (!elements) push(issues, "elements");
  if (!units) push(issues, "units");
  if (!elements || !units) return issues;
  const byFingerprint = new Map();
  const byId = new Map();
  elements.forEach((element, index) => {
    const where = `element ${index}`;
    if (!KINDS.includes(element?.kind)) push(issues, `${where} kind`);
    if (!LABELS.includes(element?.label)) push(issues, `${where} label`);
    if (!identityMatches(element)) push(issues, `${where} id does not match char/font/bbox`);
    if (element.kind === "path" || element.kind === "image") {
      if (element.char !== "" || element.font !== "") push(issues, `${where} path carries a character`);
    }
    if (byId.has(element.id)) push(issues, `${where} duplicate id ${element.id}`);
    byId.set(element.id, element);
    const fingerprint = elementFingerprint(element);
    if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, []);
    byFingerprint.get(fingerprint).push(element.ordinal);
    if (element.label === "formula") {
      if (typeof element.unitId !== "string" || !element.unitId) push(issues, `${where} formula without unit`);
      if (!UNIT_TYPES.includes(element.unitType)) push(issues, `${where} unit type`);
      if (typeof element.equationNumber !== "boolean") push(issues, `${where} equation number flag`);
    } else if (element.unitId) {
      push(issues, `${where} non-formula has unit ${element.unitId}`);
    }
  });
  for (const [fingerprint, ordinals] of byFingerprint) {
    const sorted = [...ordinals].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i] !== i) {
        push(issues, `ordinal gap for ${fingerprint.slice(0, 24)}`);
        break;
      }
    }
  }
  const seenUnits = new Set();
  for (const unit of units) {
    if (!unit || typeof unit.id !== "string") {
      push(issues, "unit id");
      continue;
    }
    if (seenUnits.has(unit.id)) push(issues, `duplicate unit ${unit.id}`);
    seenUnits.add(unit.id);
    if (!UNIT_TYPES.includes(unit.type)) push(issues, `unit ${unit.id} type`);
    if (typeof unit.equationNumber !== "boolean") push(issues, `unit ${unit.id} equation flag`);
    const members = Array.isArray(unit.elementIds) ? unit.elementIds : [];
    if (!members.length) push(issues, `unit ${unit.id} empty`);
    if (unit.id !== unitIdFromMembers(members)) push(issues, `unit ${unit.id} id drift`);
    for (const id of members) {
      const element = byId.get(id);
      if (!element) push(issues, `unit ${unit.id} missing ${id}`);
      else if (element.unitId !== unit.id || element.label !== "formula") {
        push(issues, `unit ${unit.id} member ${id} mismatch`);
      }
    }
  }
  for (const element of elements) {
    if (element.label === "formula" && !seenUnits.has(element.unitId)) {
      push(issues, `formula ${element.id} unit ${element.unitId} missing`);
    }
  }
  return issues;
}
