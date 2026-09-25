import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../lib/sha256.js";
import {
  LABEL_SCHEMA,
  assignStableIds,
  elementId,
  elementFingerprint,
  identityMatches,
  quantizeBox,
  unitIdFromMembers,
  verifyPageLabels
} from "../lib/label-schema.js";
import { prelabelElements } from "../lib/prelabel.js";
import { assemblePageElements, bindPaintToText, matchPaintToLabel } from "../lib/page-elements.js";
import {
  countMissingInkFullCrop,
  fallbackRate,
  neighbourContent,
  unitAccuracy
} from "../lib/label-checks.js";
import { countMissingInk } from "../lib/formula-svg.js";

test("sha256 matches the abc vector", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("ids follow char, font, and bbox, and a swapped character no longer matches", () => {
  const [radical, letter] = assignStableIds([
    { kind: "glyph", char: "√", font: "CMEX10", bbox: [10, 10, 28, 40], pathHash: "" },
    { kind: "glyph", char: "i", font: "CMMI10", bbox: [30, 20, 34, 32], pathHash: "" }
  ]);
  assert.equal(radical.id, elementId(elementFingerprint(radical), 0));
  assert.equal(letter.char, "i");
  assert.deepEqual(quantizeBox(letter.bbox), letter.bbox);
  assert.notEqual(radical.id, letter.id);
  const mislabeled = { ...radical, char: "i" };
  assert.equal(identityMatches(mislabeled), false);
  for (const element of [radical, letter]) {
    element.label = "text";
    element.unitId = null;
    element.unitType = null;
    element.equationNumber = false;
  }
  const page = pageOf([radical, letter], []);
  assert.deepEqual(verifyPageLabels(page), []);
  page.elements[0] = { ...mislabeled, label: "text", unitId: null, unitType: null, equationNumber: false };
  assert.ok(verifyPageLabels(page).some((issue) => issue.includes("id does not match")));
});

test("two paints with the same geometry get distinct ordinals", () => {
  const [first, second] = assignStableIds([
    { kind: "path", char: "", font: "", bbox: [1, 2, 3, 4], pathHash: "abc" },
    { kind: "path", char: "", font: "", bbox: [1, 2, 3, 4], pathHash: "abc" }
  ]);
  assert.equal(first.ordinal, 0);
  assert.equal(second.ordinal, 1);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(verifyPageLabels(pageOf([], [])), []);
});

test("a radical paint is not labelled with a nearby letter", () => {
  const letterBox = [30, 20, 34, 32];
  const radicalBox = [8, 4, 36, 48];
  assert.equal(bindPaintToText(radicalBox, [letterBox]), -1);
  const elements = assemblePageElements({
    glyphs: [{ char: "i", font: "CMMI10", bbox: letterBox, baseline: 32, fontSize: 12 }],
    paints: [{ bbox: radicalBox, d: "M8 4L36 4L20 48Z" }]
  });
  const unbound = elements.find((element) => element.source === "unbound-paint");
  assert.ok(unbound);
  assert.equal(unbound.char, "");
  assert.equal(unbound.font, "");
  assert.notDeepEqual(unbound.bbox, letterBox);
  const labelled = prelabelElements(elements, 200, 100);
  const page = pageOf(labelled.elements, labelled.units);
  assert.deepEqual(verifyPageLabels(page), []);
});

test("font, unicode, script offset, and a fraction bar form display and inline units", () => {
  const glyphs = [
    { kind: "glyph", char: "The", font: "NimbusRomNo9L-Regu", bbox: [10, 10, 40, 22], baseline: 22, fontSize: 12, pathHash: "" },
    { kind: "glyph", char: "x", font: "CMMI10", bbox: [44, 10, 52, 22], baseline: 22, fontSize: 12, pathHash: "" },
    { kind: "glyph", char: "i", font: "CMMI7", bbox: [52, 16, 56, 22], baseline: 26, fontSize: 6, pathHash: "" },
    { kind: "glyph", char: " code", font: "CMTT10", bbox: [70, 10, 110, 22], baseline: 22, fontSize: 12, pathHash: "" },
    { kind: "glyph", char: "α", font: "NimbusRomNo9L-Regu", bbox: [120, 10, 130, 22], baseline: 22, fontSize: 12, pathHash: "" },
    { kind: "glyph", char: "=", font: "CMR10", bbox: [40, 80, 52, 92], baseline: 92, fontSize: 12, pathHash: "" },
    { kind: "glyph", char: "y", font: "CMMI10", bbox: [56, 80, 66, 92], baseline: 92, fontSize: 12, pathHash: "" },
    { kind: "glyph", char: "(3)", font: "CMR10", bbox: [170, 80, 190, 92], baseline: 92, fontSize: 12, pathHash: "" }
  ];
  const paths = [
    { kind: "path", char: "", font: "", bbox: [40, 74, 70, 75.2], pathHash: "bar", source: "path" }
  ];
  const labelled = prelabelElements(assignStableIds([...glyphs, ...paths]), 220, 200);
  const byChar = new Map(labelled.elements.filter((element) => element.char).map((element) => [element.char, element]));
  assert.equal(byChar.get("The").label, "text");
  assert.equal(byChar.get("x").label, "formula");
  assert.equal(byChar.get("i").label, "formula");
  assert.equal(byChar.get("i").unitId, byChar.get("x").unitId);
  assert.equal(byChar.get(" code").label, "code");
  assert.equal(byChar.get("α").label, "formula");
  assert.equal(byChar.get("(3)").equationNumber, true);
  assert.equal(byChar.get("y").unitType, "display");
  const bar = labelled.elements.find((element) => element.kind === "path");
  assert.equal(bar.label, "formula");
  assert.equal(bar.char, "");
  const page = pageOf(labelled.elements, labelled.units);
  assert.deepEqual(verifyPageLabels(page), []);
  assert.ok(labelled.units.some((unit) => unit.type === "inline"));
  assert.ok(labelled.units.some((unit) => unit.type === "display" && unit.equationNumber));
});

test("full-crop missing ink counts a mark outside the kept-element mask", () => {
  const width = 4;
  const height = 2;
  const reference = new Uint8ClampedArray(width * height * 4);
  const svg = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < reference.length; i += 4) {
    reference[i] = reference[i + 1] = reference[i + 2] = 255;
    svg[i] = svg[i + 1] = svg[i + 2] = 255;
    reference[i + 3] = svg[i + 3] = 255;
  }
  reference[0] = reference[1] = reference[2] = 0;
  const mask = new Uint8Array(width * height);
  mask[width * height - 1] = 1;
  const masked = countMissingInk(reference, svg, width, height, mask);
  const full = countMissingInkFullCrop(reference, svg, width, height);
  assert.equal(masked.missing, 0);
  assert.equal(full.missing, 1);
  assert.equal(full.solid, 1);
});

test("neighbour content follows the label, not the font heuristic", () => {
  const [body] = assignStableIds([
    { kind: "glyph", char: "y", font: "CMMI10", bbox: [0, 0, 6, 10], pathHash: "" }
  ]);
  body.label = "text";
  body.unitId = null;
  body.unitType = null;
  body.equationNumber = false;
  const hits = neighbourContent([body.id], new Map([[body.id, body]]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].problem, "neighbour");
  assert.equal(hits[0].char, "y");
  assert.deepEqual(hits[0].bbox, body.bbox);
  const ambiguous = matchPaintToLabel(
    { provenance: "glyph", bbox: [0, 0, 6, 10] },
    [body, { ...body, id: "other", char: "z" }]
  );
  assert.equal(ambiguous.label, null);
  assert.equal(ambiguous.conflict, true);
  const aligned = matchPaintToLabel({ provenance: "glyph", bbox: [1, 1, 5, 9] }, [body]);
  assert.equal(aligned.conflict, false);
  assert.equal(aligned.label.char, "y");
  assert.ok(aligned.label.bbox[0] <= 1 && aligned.label.bbox[2] >= 5);
});

test("unit accuracy is exact set equality and fallback uses confidence", () => {
  const truth = [
    { id: "u1", elementIds: ["a", "b"] },
    { id: "u2", elementIds: ["c"] }
  ];
  const score = unitAccuracy(truth, [["a", "b"], ["c", "d"]]);
  assert.equal(score.correct, 1);
  assert.equal(score.total, 2);
  const stolen = unitAccuracy(
    [{ id: "u1", elementIds: ["z"] }, { id: "u2", elementIds: ["a", "b"] }],
    [["a", "b"]]
  );
  assert.equal(stolen.correct, 1);
  assert.ok(stolen.meanJaccard > 0.4);
  const rate = fallbackRate([
    { id: "u1", confidence: 0.9, fallback: false },
    { id: "u2", confidence: 0.4, fallback: true }
  ], { emptyIds: ["u1"] });
  assert.equal(rate.fallback, 2);
  assert.equal(rate.total, 2);
});

function pageOf(elements, units) {
  return {
    schema: LABEL_SCHEMA,
    paperId: "fixture",
    page: 1,
    pageWidth: 200,
    pageHeight: 100,
    source: "prelabel",
    elements,
    units
  };
}
