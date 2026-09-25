import test from "node:test";
import assert from "node:assert/strict";
import { formulaDevicePixels, formulaEdgeWindow } from "../lib/pdf-formula-raster.js";
import {
  FORMULA_GLYPH_DESCENT_EM,
  FORMULA_GLYPH_SCAN_PAD,
  blankFormulaMask,
  formulaPixelMasked,
  glyphBodyBox,
  measureFormulaCrop,
  nextLineLetterTop,
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

test("radical tip, relation bar, and comma tail sit in the glyph body and the next line stays out", () => {
  const viewport = {
    width: 612,
    height: 792,
    convertToViewportRectangle(rect) {
      const [x1, y1, x2, y2] = rect;
      return [x1, 792 - y2, x2, 792 - y1];
    }
  };
  const radical = { str: "√", x: 100, y: 400, width: 12, height: 10, descent: -0.3, ascent: 0.8 };
  const leq = { str: "≤", x: 120, y: 400, width: 10, height: 10 };
  const comma = { str: ",", x: 140, y: 400, width: 4, height: 10, descent: -0.22, ascent: 0.7 };
  const next = { str: "and", x: 90, y: 392, width: 24, height: 10, ascent: 0.75, sourceIndex: 9 };
  for (const item of [radical, leq, comma]) {
    const body = glyphBodyBox(item, viewport);
    const font = itemBboxLike(item, viewport);
    assert.ok(body[3] > font[3], `${item.str} body extends below the font box`);
    const em = item.height / viewport.height;
    const descent = item.descent == null ? FORMULA_GLYPH_DESCENT_EM : Math.abs(item.descent);
    assert.ok(body[3] >= font[3] + descent * em - 1e-6, `${item.str} descent is inside the body`);
  }
  const bodies = [radical, leq, comma].map((item) => glyphBodyBox(item, viewport));
  const unionBottom = Math.max(...bodies.map((box) => box[3]));
  const cap = nextLineLetterTop([radical, leq, comma], [next], viewport);
  assert.ok(cap != null && cap < unionBottom, "next line letter top cuts the scan");
  assert.ok(cap > nextLineLetterTop([radical], [next], viewport) - 1 || cap <= glyphBodyBox(next, viewport)[1] + 0.02);
  const image = paper(612, 792);
  const fontBottom = Math.max(...[radical, leq, comma].map((item) => itemBboxLike(item, viewport)[3]));
  const tipY = Math.round((fontBottom + cap) / 2 * 792);
  const barY = tipY;
  const commaY = tipY;
  const letterY = Math.ceil(cap * 792);
  ink(image, 106, tipY);
  ink(image, 124, barY);
  ink(image, 142, commaY);
  ink(image, 100, letterY);
  const bbox = [0.1, 0.4, 0.4, 0.7];
  const measured = measureFormulaCrop(bbox, image, {
    glyphBoxes: bodies,
    scanBottomCap: cap
  });
  assert.ok(measured.bbox[3] > tipY / 792, "radical tip stays");
  assert.ok(measured.bbox[3] > barY / 792, "≤ bar stays");
  assert.ok(measured.bbox[3] > commaY / 792, "comma tail stays");
  assert.ok(measured.bbox[3] <= cap + 1 / 792, "next line letter top stays out");
  assert.equal(FORMULA_GLYPH_SCAN_PAD.y, 0.002);
});

function itemBboxLike(item, viewport) {
  const rect = viewport.convertToViewportRectangle([
    item.x, item.y, item.x + item.width, item.y + item.height
  ]);
  return [
    Math.min(rect[0], rect[2]) / viewport.width,
    Math.min(rect[1], rect[3]) / viewport.height,
    Math.max(rect[0], rect[2]) / viewport.width,
    Math.max(rect[1], rect[3]) / viewport.height
  ];
}
