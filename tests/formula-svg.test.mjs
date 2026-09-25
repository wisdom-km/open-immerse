import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFormulaSvg,
  isBodyGlyphLeak,
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

test("a tall operator that covers a formula glyph is kept", () => {
  const tall = {
    width: 100,
    height: 80,
    elements: [glyph(11, [8, 8, 22, 70])]
  };
  const built = buildFormulaSvg(tall, {
    bbox: [0.08, 0.35, 0.4, 0.6],
    glyphBoxes: [[0.1, 0.4, 0.18, 0.52]],
    pageWidth: 100,
    pageHeight: 80,
    runs: [{
      box: [10, 32, 18, 42],
      font: "CMEX10",
      math: true,
      body: false,
      baseline: 42,
      str: "∑",
      member: true
    }]
  });
  assert.equal(built.elements.length, 1);
  assert.equal(built.elements[0].id, 11);
  assert.equal(built.elements[0].bodyLine, false);
});

test("a body glyph on the line above is dropped and marked", () => {
  const page = {
    width: 100,
    height: 80,
    elements: [
      glyph(1, [12, 28, 20, 40]),
      glyph(12, [10, 2, 18, 14])
    ]
  };
  const built = buildFormulaSvg(page, {
    bbox: [0.08, 0.3, 0.5, 0.6],
    glyphBoxes: [[0.12, 0.35, 0.2, 0.5]],
    pageWidth: 100,
    pageHeight: 80,
    runs: [
      {
        box: [12, 28, 20, 40],
        font: "CMMI10",
        math: true,
        body: false,
        baseline: 40,
        str: "x",
        member: true
      },
      {
        box: [8, 2, 40, 16],
        font: "CMR10",
        math: false,
        body: true,
        baseline: 14,
        str: "by",
        member: false
      }
    ]
  });
  assert.deepEqual(built.elements.map((element) => element.id), [1]);
  assert.equal(built.rejected.some((element) => element.id === 12 && element.reason === "body-line"), true);
});

test("a formula comma and a lone delimiter are kept", () => {
  const page = {
    width: 80,
    height: 40,
    elements: [glyph(21, [30, 16, 34, 22]), glyph(22, [50, 8, 58, 28])]
  };
  const built = buildFormulaSvg(page, {
    bbox: [0.2, 0.15, 0.8, 0.8],
    glyphBoxes: [[0.36, 0.35, 0.44, 0.6], [0.62, 0.2, 0.74, 0.75]],
    pageWidth: 80,
    pageHeight: 40,
    runs: [
      {
        box: [28, 14, 40, 24],
        font: "CMMI10",
        math: true,
        body: false,
        baseline: 22,
        str: "Q,",
        member: true
      },
      {
        box: [50, 10, 58, 26],
        font: "CMR10",
        math: false,
        body: true,
        baseline: 24,
        str: ")",
        member: true
      }
    ]
  });
  assert.deepEqual(built.elements.map((element) => element.id).sort((a, b) => a - b), [21, 22]);
});

test("selection refuses a glyph whose center of mass is the neighbor", () => {
  const chosen = selectFormulaElements(record, formula);
  assert.equal(chosen.elements.some((element) => element.id === 3), false);
});

test("a math glyph on the next line is not pulled in by column alignment", () => {
  const page = {
    width: 100,
    height: 120,
    elements: [
      glyph(1, [12, 40, 22, 52]),
      glyph(30, [12, 70, 22, 82])
    ]
  };
  const built = buildFormulaSvg(page, {
    bbox: [0.08, 0.3, 0.4, 0.5],
    glyphBoxes: [[0.12, 0.33, 0.22, 0.44]],
    pageWidth: 100,
    pageHeight: 120,
    runs: [
      {
        box: [12, 40, 22, 52],
        font: "CMMI10",
        math: true,
        body: false,
        baseline: 52,
        str: "x",
        member: true
      },
      {
        box: [12, 70, 22, 82],
        font: "CMMI10",
        math: true,
        body: false,
        baseline: 82,
        str: "y",
        member: false
      }
    ]
  });
  assert.deepEqual(built.elements.map((element) => element.id), [1]);
});

test("known neighbour leaks are body-line and a radical that touches the cluster stays", () => {
  const page = {
    width: 120,
    height: 100,
    elements: [
      glyph(1, [30, 40, 40, 52]),
      glyph(2, [18, 28, 34, 58]),
      glyph(3, [20, 8, 28, 20]),
      glyph(4, [70, 6, 80, 18]),
      glyph(5, [90, 8, 104, 20])
    ]
  };
  const built = buildFormulaSvg(page, {
    bbox: [0.15, 0.28, 0.6, 0.6],
    glyphBoxes: [[0.25, 0.4, 0.34, 0.52]],
    pageWidth: 120,
    pageHeight: 100,
    runs: [
      {
        box: [30, 40, 40, 52],
        font: "CMMI10",
        math: true,
        body: false,
        baseline: 52,
        str: "k",
        member: true
      },
      {
        box: [16, 30, 36, 56],
        font: "CMSY10",
        math: true,
        body: false,
        baseline: 52,
        str: "√",
        member: true
      },
      {
        box: [8, 4, 36, 18],
        font: "NimbusRomNo9L-Regu",
        math: false,
        body: true,
        baseline: 18,
        str: "by",
        member: false
      },
      {
        box: [60, 4, 90, 18],
        font: "NimbusRomNo9L-Regu",
        math: false,
        body: true,
        baseline: 16,
        str: "and",
        member: false
      },
      {
        box: [88, 4, 120, 18],
        font: "NimbusRomNo9L-Regu",
        math: false,
        body: true,
        baseline: 16,
        str: "ne",
        member: false
      }
    ]
  });
  assert.deepEqual(built.elements.map((element) => element.id).sort((a, b) => a - b), [1, 2]);
  for (const id of [3, 4, 5]) {
    const rejected = built.rejected.find((element) => element.id === id);
    assert.equal(rejected?.reason, "body-line");
    assert.equal(rejected?.bodyLine, true);
  }
  assert.equal(built.elements.filter((element) => element.bodyLine).length, 0);
  assert.equal(built.rejected.filter((element) => isBodyGlyphLeak(element)).length, 3);
  assert.equal(isBodyGlyphLeak({ provenance: "glyph", font: "NimbusRomNo9L-Regu", reason: "glyph-cluster", bodyLine: false }), true);
  assert.equal(isBodyGlyphLeak({ provenance: "glyph", font: "NimbusRomNo9L-Regu", reason: "formula-run", bodyLine: false }), false);
  assert.equal(isBodyGlyphLeak({ provenance: "glyph", font: "CMR10", reason: "formula-run", bodyLine: false }), false);
});
