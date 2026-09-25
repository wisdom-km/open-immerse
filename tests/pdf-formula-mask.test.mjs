import test from "node:test";
import assert from "node:assert/strict";
import {
  FORMULA_GLYPH_SCAN_PAD,
  blankFormulaMask,
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
});

test("formula paths outside the glyph box survive the neighbor mask", () => {
  const image = paper(200, 160);
  const glyph = [0.3, 0.4, 0.55, 0.62];
  const neighbor = [0.05, 0.02, 0.95, 0.16];
  const stroke = (x0, x1, y) => {
    for (let x = x0; x < x1; x += 1) ink(image, x, y);
  };
  stroke(40, 90, 12);
  stroke(40, 170, 120);
  stroke(50, 160, 40);
  stroke(90, 140, 136);
  const tilde = [[70, 108], [72, 106], [74, 108], [76, 106], [78, 108]];
  for (const [x, y] of tilde) ink(image, x, y);
  for (let y = 70; y < 90; y += 1) ink(image, 80, y);
  blankFormulaMask(image, { maskBoxes: [neighbor], glyphBoxes: [glyph] });
  const kept = (x0, x1, y) => {
    for (let x = x0; x < x1; x += 1) assert.equal(dark(image, x, y), true, `${x},${y}`);
  };
  kept(40, 170, 120);
  kept(50, 160, 40);
  kept(90, 140, 136);
  for (const [x, y] of tilde) assert.equal(dark(image, x, y), true, `tilde ${x},${y}`);
  assert.equal(dark(image, 80, 80), true);
  assert.equal(dark(image, 50, 12), false);
});

test("a radical tip that leaves its glyph box and enters a neighbor box stays", () => {
  const image = paper(40, 40);
  const glyph = [0.2, 0.2, 0.7, 0.55];
  const neighbor = [0.05, 0.5, 0.95, 0.95];
  for (let y = 12; y < 28; y += 1) ink(image, 16, y);
  for (let x = 4; x < 12; x += 1) ink(image, x, 34);
  blankFormulaMask(image, { maskBoxes: [neighbor], glyphBoxes: [glyph] });
  assert.equal(dark(image, 16, 14), true, "ink inside the glyph box stays");
  assert.equal(dark(image, 16, 26), true, "the connected tip inside the neighbor box stays");
  assert.equal(dark(image, 8, 34), false, "detached neighbor ink is still cleared");
});
