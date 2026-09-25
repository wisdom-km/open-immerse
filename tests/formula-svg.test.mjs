import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFormulaSvg,
  countExtraInk,
  countMissingInk,
  countOutOfBoundsInk,
  diffStats,
  maskFromBoxes,
  selectFormulaElements,
  svgSecurityIssues
} from "../lib/formula-svg.js";

function glyph(id, bbox, provenance = "glyph") {
  const [x0, y0, x1, y1] = bbox;
  return {
    id,
    op: "fill",
    provenance,
    d: `M${x0} ${y0}L${x1} ${y0}L${x1} ${y1}L${x0} ${y1}Z`,
    bbox: bbox.slice(),
    fill: "#000000",
    stroke: null,
    lineWidth: 0,
    alpha: 1,
    fillRule: "nonzero",
    clips: []
  };
}

const record = {
  width: 100,
  height: 80,
  elements: [
    glyph(1, [10, 10, 18, 20]),
    glyph(2, [20, 12, 28, 20]),
    glyph(3, [10, 2, 16, 8]),
    {
      id: 4,
      op: "stroke",
      provenance: "path",
      d: "M12 24L40 24",
      bbox: [12, 24, 40, 24],
      fill: null,
      stroke: "#000000",
      lineWidth: 1,
      alpha: 1,
      fillRule: "nonzero",
      clips: []
    },
    {
      id: 5,
      op: "fill",
      provenance: "background",
      d: "M0 0L100 0L100 80L0 80Z",
      bbox: [0, 0, 100, 80],
      fill: "#ffffff",
      stroke: null,
      lineWidth: 0,
      alpha: 1,
      clips: []
    }
  ]
};

const formula = {
  bbox: [0.08, 0.1, 0.5, 0.4],
  glyphBoxes: [
    [0.1, 0.125, 0.18, 0.25],
    [0.2, 0.15, 0.28, 0.25]
  ],
  foreignBoxes: [[0.1, 0.025, 0.16, 0.1]],
  pageWidth: 100,
  pageHeight: 80
};

test("the builder keeps formula glyphs and the inner rule, not the neighbor", () => {
  const built = buildFormulaSvg(record, formula);
  assert.deepEqual(built.elements.map((element) => element.id), [1, 2, 4]);
  assert.equal(built.elements.every((element) => element.provenance === "glyph" || element.provenance === "path"), true);
  assert.ok(Math.abs(built.viewBox.x - 8) < 1e-6);
  assert.ok(Math.abs(built.viewBox.y - 8) < 1e-6);
  assert.ok(Math.abs(built.viewBox.width - 42) < 1e-6);
  assert.ok(Math.abs(built.viewBox.height - 24) < 1e-6);
  assert.equal(built.elementCount, 3);
  assert.ok(built.bytes > 50);
});

test("generated SVG has no script and no external reference", () => {
  const poisoned = {
    width: 20,
    height: 20,
    elements: [
      {
        id: 9,
        op: "fill",
        provenance: "glyph",
        d: "M0 0L4 0L4 4Z",
        bbox: [1, 1, 4, 4],
        fill: '"><script>alert(1)</script>',
        stroke: null,
        lineWidth: 0,
        alpha: 1,
        fillRule: "nonzero",
        clips: []
      },
      {
        id: 10,
        op: "fill",
        provenance: "glyph",
        d: 'M0 0L1 0"><script>alert(1)</script>',
        bbox: [1, 1, 4, 4],
        fill: "#000000",
        stroke: null,
        lineWidth: 0,
        alpha: 1,
        fillRule: "nonzero",
        clips: []
      }
    ]
  };
  const built = buildFormulaSvg(poisoned, {
    bbox: [0, 0, 1, 1],
    glyphBoxes: [[0, 0, 1, 1]],
    foreignBoxes: [],
    pageWidth: 20,
    pageHeight: 20
  });
  assert.deepEqual(svgSecurityIssues(built.svg), []);
  assert.equal(built.svg.includes("script"), false);
  assert.equal(built.svg.includes("alert"), false);
  assert.equal(built.svg.includes("href"), false);
  assert.equal(built.elements.length, 1);
  assert.match(built.svg, /fill="#000000"/);
});

test("a clip stays a local clipPath and still has no href", () => {
  const clipped = {
    width: 30,
    height: 30,
    elements: [{
      ...glyph(1, [2, 2, 8, 8]),
      clips: [{ d: "M0 0L20 0L20 20L0 20Z", rule: "nonzero", bbox: [0, 0, 20, 20] }]
    }]
  };
  const built = buildFormulaSvg(clipped, {
    bbox: [0, 0, 1, 1],
    glyphBoxes: [[0, 0, 0.5, 0.5]],
    pageWidth: 30,
    pageHeight: 30
  });
  assert.match(built.svg, /<clipPath id="c0"/);
  assert.match(built.svg, /clip-path="url\(#c0\)"/);
  assert.deepEqual(svgSecurityIssues(built.svg), []);
});

test("missing ink ignores a one pixel antialias shift and counts a real gap", () => {
  const width = 6;
  const height = 4;
  const reference = new Uint8ClampedArray(width * height * 4).fill(255);
  const svg = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (buffer, x, y) => {
    const index = (y * width + x) * 4;
    buffer[index] = buffer[index + 1] = buffer[index + 2] = 0;
  };
  paint(reference, 1, 1);
  paint(svg, 2, 1);
  paint(reference, 4, 2);
  const mask = maskFromBoxes(width, height, [[0, 0, 6, 4]]);
  const shifted = countMissingInk(reference, svg, width, height, mask);
  assert.equal(shifted.missing, 1);
  paint(svg, 4, 2);
  const covered = countMissingInk(reference, svg, width, height, mask);
  assert.equal(covered.missing, 0);
  const extra = countExtraInk(svg, width, height, maskFromBoxes(width, height, [[4, 2, 5, 3]]));
  assert.equal(extra.extra > 0, true);
});

test("outline diff reports max and mean luma", () => {
  const width = 2;
  const height = 1;
  const left = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  const right = new Uint8ClampedArray([0, 0, 0, 255, 205, 205, 205, 255]);
  const stats = diffStats(left, right, width, height);
  assert.equal(stats.max, 50);
  assert.equal(stats.mean, 25);
});

test("a rule that runs far past the formula box is not part of the unit", () => {
  const longRule = {
    width: 200,
    height: 40,
    elements: [{
      id: 7,
      op: "stroke",
      provenance: "path",
      d: "M10 20L180 20",
      bbox: [10, 20, 180, 20],
      fill: null,
      stroke: "#000000",
      lineWidth: 0.8,
      alpha: 1,
      fillRule: "nonzero",
      clips: []
    }]
  };
  const built = buildFormulaSvg(longRule, {
    bbox: [0.2, 0.2, 0.45, 0.8],
    glyphBoxes: [[0.25, 0.4, 0.4, 0.7]],
    foreignBoxes: [[0.7, 0.4, 0.9, 0.7]],
    pageWidth: 200,
    pageHeight: 40
  });
  assert.equal(built.elements.length, 0);
});

test("a rule that belongs to the formula keeps its painted length", () => {
  const rule = {
    width: 200,
    height: 40,
    elements: [{
      id: 8,
      op: "stroke",
      provenance: "path",
      d: "M50 20L88 20",
      bbox: [50, 20, 88, 20],
      fill: null,
      stroke: "#000000",
      lineWidth: 1,
      alpha: 1,
      fillRule: "nonzero",
      clips: []
    }]
  };
  const built = buildFormulaSvg(rule, {
    bbox: [0.2, 0.2, 0.45, 0.8],
    glyphBoxes: [[0.25, 0.4, 0.4, 0.7]],
    foreignBoxes: [],
    pageWidth: 200,
    pageHeight: 40
  });
  assert.equal(built.elements.length, 1);
  assert.equal(built.elements[0].bbox[0], 50);
  assert.equal(built.elements[0].bbox[2], 88);
});

test("a body glyph that only grazes the formula box stays out", () => {
  const grazed = {
    ...record,
    elements: record.elements.concat([glyph(6, [12, 0, 24, 9])])
  };
  const chosen = selectFormulaElements(grazed, formula);
  assert.equal(chosen.elements.some((element) => element.id === 6), false);
});

test("out of bounds counts svg ink with no reference ink nearby", () => {
  const width = 5;
  const height = 3;
  const reference = new Uint8ClampedArray(width * height * 4).fill(255);
  const svg = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (buffer, x, y) => {
    const index = (y * width + x) * 4;
    buffer[index] = buffer[index + 1] = buffer[index + 2] = 0;
  };
  paint(reference, 1, 1);
  paint(svg, 2, 1);
  paint(svg, 4, 1);
  const shifted = countOutOfBoundsInk(reference, svg, width, height);
  assert.equal(shifted.outOfBounds, 1);
  assert.equal(shifted.svgInk, 2);
});

test("selection refuses a glyph whose center of mass is the neighbor", () => {
  const chosen = selectFormulaElements(record, formula);
  assert.equal(chosen.elements.some((element) => element.id === 3), false);
});
