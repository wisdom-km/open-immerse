import test from "node:test";
import assert from "node:assert/strict";
import { assignStableIds } from "../lib/label-schema.js";
import { prelabelElements } from "../lib/prelabel.js";

function glyph(char, bbox, extras = {}) {
  return {
    kind: "glyph",
    char,
    font: extras.font || "NimbusRomNo9L-Regu",
    bbox,
    baseline: extras.baseline ?? bbox[3],
    fontSize: extras.fontSize ?? (bbox[3] - bbox[1]),
    pathHash: ""
  };
}

function label(glyphs, width = 400) {
  const labelled = prelabelElements(assignStableIds(glyphs), width, 200);
  const byChar = new Map();
  for (const element of labelled.elements) {
    if (!byChar.has(element.char)) byChar.set(element.char, []);
    byChar.get(element.char).push(element);
  }
  return { labelled, byChar };
}

test("a body-font subscript joins its base as one formula unit", () => {
  const { byChar } = label([
    glyph("k", [40, 20, 48, 32], { baseline: 32, fontSize: 12 }),
    glyph("a", [48, 26, 54, 34], { baseline: 36, fontSize: 7 })
  ]);
  const base = byChar.get("k")[0];
  const script = byChar.get("a")[0];
  assert.equal(base.label, "formula");
  assert.equal(script.label, "formula");
  assert.equal(base.unitId, script.unitId);
  assert.equal(script.rule, "script-attached");
  assert.equal(base.rule, "script-base");
  assert.ok(script.confidence < 0.65);
  assert.ok(base.confidence < 0.65);
  assert.equal(script.confidence, 0.55);
  assert.equal(base.confidence, 0.55);
});

test("a raised numeral after a word is text, not a formula", () => {
  const { byChar } = label([
    glyph("study", [40, 40, 80, 52], { baseline: 52, fontSize: 12 }),
    glyph("17", [80, 34, 90, 42], { baseline: 44, fontSize: 6 }),
    glyph(".", [90, 40, 94, 52], { baseline: 52, fontSize: 12 })
  ]);
  const cite = byChar.get("17")[0];
  assert.equal(cite.label, "text");
  assert.equal(cite.rule, "citation-or-footnote");
  assert.equal(cite.unitId, null);
  assert.equal(byChar.get("study")[0].label, "text");
});

test("a footnote marker at the start of a note line is text", () => {
  const { byChar } = label([
    glyph("4", [36, 30, 42, 38], { baseline: 40, fontSize: 6 }),
    glyph(". To counteract this effect, we scale", [44, 36, 220, 48], { baseline: 48, fontSize: 12 })
  ]);
  const note = byChar.get("4")[0];
  assert.equal(note.label, "text");
  assert.equal(note.rule, "citation-or-footnote");
});

test("a superscript after a prose run is not pulled into a formula", () => {
  const { byChar } = label([
    glyph("Spatial and", [20, 40, 90, 52], { baseline: 52, fontSize: 12 }),
    glyph("6", [90, 34, 96, 42], { baseline: 44, fontSize: 6 }),
    glyph("College", [100, 40, 150, 52], { baseline: 52, fontSize: 12 })
  ]);
  assert.equal(byChar.get("6")[0].label, "text");
  assert.equal(byChar.get("Spatial and")[0].label, "text");
  assert.equal(byChar.get("College")[0].label, "text");
});

test("an exponent on a single letter stays with that letter", () => {
  const { byChar } = label([
    glyph("a", [80, 40, 88, 52], { baseline: 52, fontSize: 12 }),
    glyph("4", [88, 32, 94, 40], { baseline: 42, fontSize: 6 })
  ]);
  const base = byChar.get("a")[0];
  const exp = byChar.get("4")[0];
  assert.equal(exp.label, "formula");
  assert.equal(base.unitId, exp.unitId);
  assert.ok(exp.confidence <= 0.82);
});

test("an affiliation superscript beside the next line of prose is text", () => {
  const { byChar } = label([
    glyph("Author details", [304.7, 339.3, 350.7, 346.8], { baseline: 346.8, fontSize: 7.5 }),
    glyph("1", [304.7, 347.5, 307.3, 352.8], { baseline: 352.8, fontSize: 5.3 }),
    glyph("MRC Integrative Epidemiology Unit at", [307.6, 348.3, 420.2, 355.8], { baseline: 355.8, fontSize: 7.5 })
  ]);
  const marker = byChar.get("1")[0];
  assert.equal(marker.label, "text");
  assert.equal(marker.rule, "citation-or-footnote");
  assert.equal(marker.unitId, null);
  assert.equal(byChar.get("MRC Integrative Epidemiology Unit at")[0].label, "text");
});

test("an exponent on a short math fragment stays a formula beside an operator", () => {
  const { byChar } = label([
    glyph("ia", [380.8, 433.4, 387.5, 442.4], { baseline: 442.4, fontSize: 9 }),
    glyph("4", [387.4, 432.4, 390.4, 438.6], { baseline: 438.6, fontSize: 6.3 }),
    glyph("Tr", [391, 433.4, 399.6, 442.4], { baseline: 442.4, fontSize: 9 })
  ]);
  const base = byChar.get("ia")[0];
  const exp = byChar.get("4")[0];
  assert.equal(exp.label, "formula");
  assert.notEqual(exp.rule, "citation-or-footnote");
  assert.equal(base.unitId, exp.unitId);
  assert.equal(byChar.get("Tr")[0].label, "text");
  assert.ok(exp.confidence <= 0.82);
});

test("a footnote marker after a bold heading is text", () => {
  const { byChar } = label([
    glyph("B.2", [117.8, 125.8, 137.9, 137.8], { baseline: 137.75, fontSize: 12, font: "CMBX12" }),
    glyph("On different time intervals", [151.3, 125.8, 307.4, 137.8], { baseline: 137.75, fontSize: 12, font: "CMBX12" }),
    glyph("16", [307.4, 125.4, 315.9, 133.4], { baseline: 133.41, fontSize: 8, font: "CMR8" })
  ]);
  const marker = byChar.get("16")[0];
  assert.equal(marker.label, "text");
  assert.equal(marker.rule, "citation-or-footnote");
});

test("a superscript minus-one inside a formula stays with the base", () => {
  const { byChar } = label([
    glyph("1.", [20, 80, 32, 92], { baseline: 92, fontSize: 12 }),
    glyph("S", [40, 40, 50, 52], { baseline: 52, fontSize: 12, font: "CMMI10" }),
    glyph("d", [50, 34, 56, 42], { baseline: 42, fontSize: 8, font: "CMMI10" }),
    glyph("−", [56, 34, 64, 42], { baseline: 42, fontSize: 8, font: "CMMI10" }),
    glyph("1", [64, 34, 70, 42], { baseline: 42, fontSize: 8 }),
    glyph(")", [72, 40, 78, 52], { baseline: 52, fontSize: 12, font: "CMMI10" }),
    glyph("together", [84, 40, 140, 52], { baseline: 52, fontSize: 12 })
  ]);
  const digit = byChar.get("1")[0];
  assert.equal(digit.label, "formula");
  assert.notEqual(digit.rule, "citation-or-footnote");
  assert.equal(digit.unitId, byChar.get("S")[0].unitId);
  assert.equal(byChar.get("together")[0].label, "text");
});

test("a word between two variables stays text and a distant footer does not join", () => {
  const { byChar } = label([
    glyph("K", [40, 40, 50, 52], { baseline: 52, fontSize: 12, font: "CMMI10" }),
    glyph("and", [54, 40, 74, 52], { baseline: 52, fontSize: 12 }),
    glyph("V", [78, 40, 88, 52], { baseline: 52, fontSize: 12, font: "CMMI10" }),
    glyph("April 12, 2019", [48, 180, 110, 190], { baseline: 190, fontSize: 8 })
  ]);
  assert.equal(byChar.get("and")[0].label, "text");
  assert.equal(byChar.get("April 12, 2019")[0].label, "text");
  assert.equal(byChar.get("April 12, 2019")[0].unitId, null);
  assert.notEqual(byChar.get("K")[0].unitId, byChar.get("V")[0].unitId);
});

test("operators, brackets, and numerals on the same line join a math run", () => {
  const { labelled, byChar } = label([
    glyph("(", [20, 40, 26, 52], { baseline: 52, fontSize: 12 }),
    glyph("ν", [26, 40, 34, 52], { baseline: 52, fontSize: 12 }),
    glyph("=", [36, 40, 46, 52], { baseline: 52, fontSize: 12 }),
    glyph("0.01", [48, 40, 72, 52], { baseline: 52, fontSize: 12 }),
    glyph(")", [72, 40, 78, 52], { baseline: 52, fontSize: 12 })
  ]);
  const ids = ["(", "ν", "=", "0.01", ")"].map((char) => byChar.get(char)[0].unitId);
  assert.equal(new Set(ids).size, 1);
  assert.equal(labelled.units.length, 1);
  assert.equal(byChar.get("0.01")[0].rule, "math-run");
  assert.equal(byChar.get("0.01")[0].confidence, 0.5);
  assert.ok(labelled.units[0].confidence < 0.65);
  assert.equal(labelled.units[0].fallback, true);
});

test("formulas on different lines are not merged", () => {
  const { byChar } = label([
    glyph("x", [40, 40, 52, 52], { baseline: 52, fontSize: 12, font: "CMMI10" }),
    glyph("+", [54, 40, 64, 52], { baseline: 52, fontSize: 12, font: "CMR10" }),
    glyph("y", [40, 70, 52, 82], { baseline: 82, fontSize: 12, font: "CMMI10" }),
    glyph("z", [54, 70, 64, 82], { baseline: 82, fontSize: 12, font: "CMMI10" })
  ]);
  assert.equal(byChar.get("x")[0].unitId, byChar.get("+")[0].unitId);
  assert.notEqual(byChar.get("x")[0].unitId, byChar.get("y")[0].unitId);
});

test("a footnote yin-yang and a table-note letter are text", () => {
  const { byChar } = label([
    glyph("☯", [40, 40, 48, 48], { baseline: 48, fontSize: 8, font: "CMMI10" }),
    glyph("a", [36, 160, 44, 170], { baseline: 170, fontSize: 9 }),
    glyph("Significant at the 5 percent level", [48, 160, 220, 172], { baseline: 172, fontSize: 10 })
  ]);
  assert.equal(byChar.get("☯")[0].label, "text");
  assert.equal(byChar.get("☯")[0].unitId, null);
  assert.equal(byChar.get("a")[0].label, "text");
  assert.equal(byChar.get("a")[0].rule, "table-note");
  assert.equal(byChar.get("a")[0].unitId, null);
});

test("a subscript a on k stays a formula", () => {
  const { byChar } = label([
    glyph("k", [40, 40, 48, 52], { baseline: 52, fontSize: 12, font: "CMMI10" }),
    glyph("a", [48, 46, 54, 54], { baseline: 56, fontSize: 7, font: "CMMI7" })
  ]);
  assert.equal(byChar.get("a")[0].label, "formula");
  assert.equal(byChar.get("k")[0].unitId, byChar.get("a")[0].unitId);
});

test("table rules and illustration paths are not formulas", () => {
  const glyphs = [
    glyph("x", [40, 40, 52, 52], { baseline: 52, fontSize: 12, font: "CMMI10" })
  ];
  const labelled = prelabelElements(assignStableIds([
    ...glyphs,
    { kind: "path", char: "", font: "", bbox: [20, 90, 300, 91.2], pathHash: "rule" },
    { kind: "path", char: "", font: "", bbox: [30, 100, 48, 118], pathHash: "fig" }
  ]), 400, 220);
  const paths = labelled.elements.filter((element) => element.kind === "path");
  assert.equal(paths[0].label, "other");
  assert.equal(paths[0].rule, "rule-line");
  assert.equal(paths[1].label, "other");
  assert.equal(paths[1].rule, "path");
  assert.equal(paths.every((path) => path.unitId == null), true);
});

test("an inline unit with 60 members is flagged below 0.65", () => {
  const glyphs = [];
  for (let index = 0; index < 60; index += 1) {
    glyphs.push(glyph("x", [10 + index * 6, 40, 14 + index * 6, 52], { baseline: 52, fontSize: 12, font: "CMMI10" }));
  }
  const labelled = prelabelElements(assignStableIds(glyphs), 2000, 200);
  assert.equal(labelled.units.length, 1);
  assert.equal(labelled.units[0].type, "inline");
  assert.ok(labelled.units[0].confidence <= 0.55);
  assert.equal(labelled.units[0].fallback, true);
});
