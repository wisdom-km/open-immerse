import test from "node:test";
import assert from "node:assert/strict";
import {
  FORMULA_GLYPH_SCAN_PAD,
  NEIGHBOR_INK_EM,
  blankFormulaMask,
  dropDetachedFormulaInk,
  expandNeighborInkBox,
  formulaPixelMasked,
  measureFormulaCrop,
  textLayerToBlocks
} from "../lib/pdf-text-layer.js";

function paper(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  return { data, width, height };
}

function ink(image, x, y) {
  const index = (y * image.width + x) * 4;
  image.data[index] = 0;
  image.data[index + 1] = 0;
  image.data[index + 2] = 0;
  image.data[index + 3] = 255;
}

function dark(image, x, y) {
  const index = (y * image.width + x) * 4;
  return image.data[index] < 246;
}

test("neighbor glyphs inside the formula box are paper, and the radical bar stays", () => {
  assert.equal(FORMULA_GLYPH_SCAN_PAD.x, 0.003);
  assert.equal(FORMULA_GLYPH_SCAN_PAD.y, 0.002);
  const image = paper(200, 120);
  const glyph = [0.2, 0.45, 0.72, 0.72];
  const bbox = [0.12, 0.28, 0.8, 0.8];
  const neighbor = [0.22, 0.32, 0.68, 0.56];
  for (let x = 50; x < 130; x += 1) ink(image, x, 40);
  for (let x = 46; x < 140; x += 1) {
    ink(image, x, 56);
    ink(image, x, 57);
  }
  for (let y = 60; y < 80; y += 1) ink(image, 90, y);

  const open = measureFormulaCrop(bbox, image, {
    inline: true,
    glyphBoxes: [glyph],
    scanPad: { x: 0.08, y: 0.16 }
  });
  const masked = measureFormulaCrop(bbox, image, {
    inline: true,
    glyphBoxes: [glyph],
    maskBoxes: [neighbor],
    scanPad: { x: 0.08, y: 0.16 }
  });
  assert.ok(open.bbox[1] < 42 / 120, "unmasked ink still reaches the neighbor row");
  assert.ok(masked.bbox[1] > 50 / 120, "masked ink starts at the radical bar");
  assert.ok(masked.bbox[1] <= 56 / 120 + 0.02);
  assert.ok(masked.bbox[3] > 78 / 120);
  assert.ok(masked.bbox[0] < 50 / 200);
  assert.ok(masked.bbox[2] > 136 / 200);

  const painted = paper(200, 120);
  painted.data.set(image.data);
  blankFormulaMask(painted, { maskBoxes: [neighbor], glyphBoxes: [glyph] });
  assert.equal(dark(painted, 80, 40), false);
  assert.equal(dark(painted, 90, 56), true);
  assert.equal(formulaPixelMasked(90.5 / 200, 56.5 / 120, [neighbor], [glyph]), false);
  assert.equal(formulaPixelMasked(80.5 / 200, 40.5 / 120, [neighbor], [glyph]), true);
});

test("formula blocks keep neighbor boxes for the mask and still gate glyph redraw", () => {
  const viewport = {
    width: 612,
    height: 792,
    convertToViewportRectangle(rect) {
      const [x1, y1, x2, y2] = rect;
      return [x1, 792 - y2, x2, 792 - y1];
    }
  };
  const page = textLayerToBlocks({
    items: [
      { str: "and v", x: 100, y: 500, width: 40, height: 12, fontName: "Times" },
      { str: "√", x: 110, y: 486, width: 12, height: 18, fontName: "CMSY10" },
      { str: "d", x: 124, y: 486, width: 8, height: 10, fontName: "CMMI10" }
    ],
    viewport,
    page: 4
  });
  const formula = page.blocks.find((block) => block.label === "formula");
  assert.ok(formula);
  assert.equal(formula.glyphRedraw, undefined);
  assert.ok(formula.glyphBoxes?.length >= 1);
  assert.ok(formula.maskBoxes?.length >= 1);
  const tight = [0.1, 0.2, 0.2, 0.22];
  const grown = expandNeighborInkBox(tight, 792);
  assert.equal(NEIGHBOR_INK_EM, 0.25);
  assert.ok(grown[1] < tight[1] - 0.25 * 0.02);
  assert.ok(grown[3] > tight[3] + 0.25 * 0.02 + 1 / 792 - 1e-9);
  assert.deepEqual(expandNeighborInkBox([0, 0.1, 1, 0.4], 792).slice(1, 4), [0.1, 1, 0.4]);
});

test("detached neighbor ink is dropped and formula bars, scripts, and limits stay", () => {
  const image = paper(160, 120);
  const letter = [0.25, 0.45, 0.7, 0.8];
  const superscript = [0.55, 0.3, 0.68, 0.48];
  const subscript = [0.72, 0.78, 0.84, 0.92];
  const limit = [0.08, 0.18, 0.22, 0.4];
  const fill = (x0, x1, y0, y1) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) ink(image, x, y);
    }
  };
  fill(40, 90, 78, 92);
  fill(48, 78, 56, 64);
  fill(16, 20, 58, 62);
  fill(30, 52, 60, 63);
  fill(20, 140, 50, 53);
  fill(24, 130, 70, 73);
  fill(92, 100, 46, 52);
  fill(118, 128, 100, 108);
  fill(16, 28, 34, 42);
  fill(8, 18, 0, 4);
  dropDetachedFormulaInk(image, { glyphBoxes: [letter, superscript, limit, subscript] });
  assert.equal(dark(image, 60, 84), true);
  assert.equal(dark(image, 60, 58), false);
  assert.equal(dark(image, 17, 60), false);
  assert.equal(dark(image, 40, 61), false);
  assert.equal(dark(image, 12, 1), false);
  assert.equal(dark(image, 80, 51), true);
  assert.equal(dark(image, 80, 71), true);
  assert.equal(dark(image, 96, 48), true);
  assert.equal(dark(image, 122, 104), true);
  assert.equal(dark(image, 20, 38), true);
});
