import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";
import {
  DISPLAY_CROSSLINE_GAP,
  DISPLAY_INK_OUTSET,
  FORMULA_CROP_PAD,
  FORMULA_PAD_LIMIT,
  displayLineGapRatio,
  measureFormulaCrop,
  textLayerToBlocks
} from "../lib/pdf-text-layer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(root, "tests/fixtures/pdf-blocks/crossline-display.json"), "utf8"));

function unitViewport(width, height) {
  return {
    width,
    height,
    convertToViewportRectangle(rect) {
      const [x1, y1, x2, y2] = rect;
      return [x1, height - y2, x2, height - y1];
    }
  };
}

function pdfItem(str, x, y, width = 80, height = 10, extra = {}) {
  return { str, x, y, width, height, transform: [1, 0, 0, 1, x, y], ...extra };
}

function pageFrom(items, page = 1) {
  const { width, height } = fixture.viewport;
  return textLayerToBlocks({
    items,
    viewport: unitViewport(width, height),
    page
  });
}

function caseItems(name) {
  return fixture[name].items.map((item) => pdfItem(item.str, item.x, item.y, item.width, item.height, {
    fontName: item.fontName || ""
  }));
}

function displaysOf(page) {
  return page.blocks.filter((block) => block.label === "formula" && block.display === true);
}

function glyphUnion(items) {
  const { width, height } = fixture.viewport;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of items) {
    const x = item.x;
    const y = item.y;
    const boxTop = height - (y + item.height);
    const boxBottom = height - y;
    left = Math.min(left, x / width);
    right = Math.max(right, (x + item.width) / width);
    top = Math.min(top, boxTop / height);
    bottom = Math.max(bottom, boxBottom / height);
  }
  return [left, top, right, bottom];
}

function overlaps(a, b) {
  return Math.min(a[3], b[3]) > Math.max(a[1], b[1]) &&
    Math.min(a[2], b[2]) > Math.max(a[0], b[0]);
}

function assertOwned(page) {
  assert.deepEqual(page.sourceAudit.missing, []);
  assert.deepEqual(page.sourceAudit.duplicates, []);
}

test("cross-line display gap is locked to [0.8, 1.6) line heights", () => {
  assert.equal(DISPLAY_CROSSLINE_GAP.lo, 0.8);
  assert.equal(DISPLAY_CROSSLINE_GAP.hi, 1.6);
  const em = 10;
  const low = displayLineGapRatio({ y: 100, height: em }, { y: 100 - em * DISPLAY_CROSSLINE_GAP.lo, height: em });
  const high = displayLineGapRatio({ y: 100, height: em }, { y: 100 - em * DISPLAY_CROSSLINE_GAP.hi, height: em });
  assert.ok(Math.abs(low - 0.8) < 1e-12);
  assert.ok(Math.abs(high - 1.6) < 1e-12);
  assert.ok(low >= DISPLAY_CROSSLINE_GAP.lo);
  assert.ok(high >= DISPLAY_CROSSLINE_GAP.hi);
  assert.equal(FORMULA_CROP_PAD.displayX, 0.0045);
  assert.equal(FORMULA_CROP_PAD.displayY, 0.0030);
  assert.equal(FORMULA_PAD_LIMIT.x, 0.0060);
  assert.equal(FORMULA_PAD_LIMIT.y, 0.0050);
  assert.equal(DISPLAY_INK_OUTSET.x, 0.14);
  assert.equal(DISPLAY_INK_OUTSET.top, 0.10);
  assert.equal(DISPLAY_INK_OUTSET.bottom, 0.32);
});

function stackedPair(dy, { numberA = "", numberB = "", textB = null } = {}) {
  const y = 400;
  const em = 10;
  const items = [
    pdfItem("PE", 180, y, 16, em, { fontName: "CMMI10" }),
    pdfItem("(pos, 2i)", 198, y, 52, em, { fontName: "CMMI10" }),
    pdfItem("= sin(", 254, y, 36, em),
    pdfItem("pos/10000", 292, y, 70, em, { fontName: "CMMI10" }),
    pdfItem(")", 364, y, 6, em)
  ];
  if (numberA) items.push(pdfItem(numberA, 500, y, 18, em));
  const lower = textB || [
    pdfItem("PE", 180, y - dy, 16, em, { fontName: "CMMI10" }),
    pdfItem("(pos, 2i+1)", 198, y - dy, 64, em, { fontName: "CMMI10" }),
    pdfItem("= cos(", 266, y - dy, 36, em),
    pdfItem("pos/10000", 304, y - dy, 70, em, { fontName: "CMMI10" }),
    pdfItem(")", 376, y - dy, 6, em)
  ];
  items.push(...(Array.isArray(lower) ? lower : [lower]));
  if (numberB) items.push(pdfItem(numberB, 500, y - dy, 18, em));
  return items;
}

test("display rows merge inside the band and split at 1.6 line heights", () => {
  const em = 10;
  const insideOldCap = pageFrom(stackedPair(8));
  assert.equal(displaysOf(insideOldCap).length, 1, "0.8 em is inside the band even when the row is longer than 12 chars");
  assertOwned(insideOldCap);

  const aboveLegacyPx = pageFrom(stackedPair(13));
  assert.equal(displaysOf(aboveLegacyPx).length, 1, "13px is past the old 12px cap and still under 1.6 em");
  assertOwned(aboveLegacyPx);

  const atHi = pageFrom(stackedPair(em * DISPLAY_CROSSLINE_GAP.hi));
  assert.equal(displaysOf(atHi).length, 2, "a gap of 1.6 line heights does not merge");
  assertOwned(atHi);

  const past = pageFrom(stackedPair(22));
  assert.equal(displaysOf(past).length, 2);
});

test("F05 two centered PE rows are one display crop", () => {
  const page = pageFrom(caseItems("f05"), fixture.f05.page);
  const displays = displaysOf(page);
  assert.equal(displays.length, 1);
  assert.equal(displays[0].inlineOf, undefined);
  assert.equal(page.blocks.some((block) => /sin|cos|10000/.test(block.text || "")), false);
  assert.ok(page.blocks.some((block) => /positional encodings/.test(block.text || "")));
  assert.ok(page.blocks.some((block) => /where pos is the position/.test(block.text || "")));
  const glyphs = glyphUnion(fixture.f05.items.filter((item) => item.y === 440 || item.y === 426));
  assert.ok(displays[0].bbox[1] < glyphs[1], "top ink margin above the first PE row");
  assert.ok(displays[0].bbox[3] > glyphs[3], "bottom ink margin under the second PE row");
  assert.ok(displays[0].bbox[0] < glyphs[0], "left ink margin");
  assert.ok(displays[0].bbox[2] > glyphs[2], "right ink margin");
  const prose = page.blocks.find((block) => /where pos is the position/.test(block.text || ""));
  assert.equal(overlaps(displays[0].bbox, prose.bbox), false);
  assertOwned(page);
});

test("F02 MultiHead and where head_i share one display, with descender room", () => {
  const page = pageFrom(caseItems("f02"), fixture.f02.page);
  const displays = displaysOf(page);
  assert.equal(displays.length, 1);
  assert.equal(page.blocks.some((block) => /MultiHead|Concat|QW/.test(block.text || "")), false);
  assert.ok(page.blocks.some((block) => /following paragraph/.test(block.text || "")));
  const glyphs = glyphUnion(fixture.f02.items.filter((item) => item.y <= 448 && item.y >= 420 && item.x < 480));
  const { height } = fixture.viewport;
  const em = 11;
  const descender = (em * DISPLAY_INK_OUTSET.bottom) / height;
  assert.ok(displays[0].bbox[3] >= glyphs[3] + descender - 1e-6, "where-line descender stays inside the union");
  assert.ok(displays[0].bbox[0] <= glyphs[0] - (em * DISPLAY_INK_OUTSET.x) / fixture.viewport.width + 1e-6);
  assert.ok(displays[0].bbox[2] >= glyphs[2] + (em * DISPLAY_INK_OUTSET.x) / fixture.viewport.width - 1e-6);
  assert.ok(displays[0].bbox[1] <= glyphs[1] - (em * DISPLAY_INK_OUTSET.top) / height + 1e-6);
  const prose = page.blocks.find((block) => /following paragraph/.test(block.text || ""));
  assert.equal(overlaps(displays[0].bbox, prose.bbox), false);
  assertOwned(page);
});

test("F12 posterior rows and the short middle fragment are one display", () => {
  const page = pageFrom(caseItems("f12"), fixture.f12.page);
  const displays = displaysOf(page);
  assert.equal(displays.length, 1, "Eq. (6) and Eq. (7) fragments must not float apart");
  assert.equal(page.blocks.filter((block) => block.label === "formula").length, 1);
  assert.equal(page.blocks.some((block) => /[μαβ√]/.test(block.text || "")), false);
  assert.ok(page.blocks.some((block) => /forward posterior/.test(block.text || "")));
  const lower = fixture.f12.items.filter((item) => item.y === 438 || item.y === 452);
  const glyphs = glyphUnion(lower);
  const { height } = fixture.viewport;
  assert.ok(displays[0].bbox[3] >= glyphs[3] + (10 * DISPLAY_INK_OUTSET.bottom) / height - 1e-6);
  assert.ok(displays[0].bbox[2] >= (500 + 16) / fixture.viewport.width, "equation number stays on the merged block");
  const prose = page.blocks.find((block) => /forward posterior/.test(block.text || ""));
  assert.equal(overlaps(displays[0].bbox, prose.bbox), false);
  assertOwned(page);
});

test("separate numbered equations and prose lines do not soft-merge", () => {
  const em = 10;
  const split = pageFrom(stackedPair(em * DISPLAY_CROSSLINE_GAP.hi, { numberA: "(3)", numberB: "(5)" }));
  assert.equal(displaysOf(split).length, 2);
  assertOwned(split);

  const y = 420;
  const proseGap = pageFrom([
    pdfItem("PE", 180, y, 16, em, { fontName: "CMMI10" }),
    pdfItem("(pos, 2i) = sin(pos)", 198, y, 150, em, { fontName: "CMMI10" }),
    pdfItem("(4)", 500, y, 18, em),
    pdfItem("This sentence stays in the paragraph.", 108, y - 13, 240, em),
    pdfItem("PE", 180, y - 36, 16, em, { fontName: "CMMI10" }),
    pdfItem("(pos, 2i+1) = cos(pos)", 198, y - 36, 160, em, { fontName: "CMMI10" }),
    pdfItem("(5)", 500, y - 36, 18, em)
  ]);
  assert.equal(displaysOf(proseGap).length, 2);
  const sentence = proseGap.blocks.find((block) => /stays in the paragraph/.test(block.text || ""));
  assert.ok(sentence);
  assert.equal(sentence.label, "text");
  assertOwned(proseGap);

  const closeProse = pageFrom([
    pdfItem("α", 200, 360, 12, em, { fontName: "CMMI10" }),
    pdfItem("= β + γ", 214, 360, 70, em, { fontName: "CMMI10" }),
    pdfItem("(8)", 500, 360, 18, em),
    pdfItem("See the following definition.", 108, 347, 180, em)
  ]);
  assert.equal(displaysOf(closeProse).length, 1);
  assert.ok(closeProse.blocks.some((block) => /following definition/.test(block.text || "")));
  assertOwned(closeProse);
});

test("equation number on the last row stays inside the merged display", () => {
  const em = 10;
  const y = 400;
  const page = pageFrom([
    pdfItem("PE(pos, 2i) = sin(pos/10000)", 180, y, 200, em, { fontName: "CMMI10" }),
    pdfItem("PE(pos, 2i+1) = cos(pos/10000)", 180, y - 13, 210, em, { fontName: "CMMI10" }),
    pdfItem("(5)", 500, y - 23, 18, em)
  ]);
  const displays = displaysOf(page);
  assert.equal(displays.length, 1);
  assert.ok(displays[0].bbox[2] >= 518 / fixture.viewport.width, "(5) is on the merged block, not the first row only");
  assert.equal(page.blocks.some((block) => /^\(5\)$/.test(block.text || "")), false);
  assertOwned(page);
});

test("indented formula wraps stay inline and keep every glyph", () => {
  const page = pageFrom([
    pdfItem("The dimensionality of the inner layer is fixed at", 150, 500, 250, 10),
    pdfItem("α", 150, 486, 10, 10, { fontName: "CMMI10" }),
    pdfItem("= β + γ", 162, 486, 48, 10, { fontName: "CMMI10" }),
    pdfItem("δ", 150, 472, 10, 10, { fontName: "CMMI10" }),
    pdfItem("= ε", 162, 472, 24, 10, { fontName: "CMMI10" })
  ]);
  assert.equal(displaysOf(page).length, 0);
  const text = page.blocks.filter((block) => block.label === "text").map((block) => block.text).join(" ");
  assert.match(text, /dimensionality of the inner layer/);
  assertOwned(page);
});

test("inline formulas on successive prose rows are not cross-line merged", () => {
  const page = pageFrom([
    pdfItem("The width is ", 72, 500, 70, 10),
    pdfItem("d", 144, 500, 8, 10, { fontName: "CMMI10" }),
    pdfItem("model", 152, 496, 28, 7),
    pdfItem(" and the stack uses ", 184, 500, 96, 10),
    pdfItem("√", 282, 500, 10, 12, { fontName: "CMSY10" }),
    pdfItem("d", 294, 500, 8, 10, { fontName: "CMMI10" }),
    pdfItem(" in the encoder.", 304, 500, 80, 10),
    pdfItem("A second sentence has ", 72, 486, 118, 10),
    pdfItem("∑", 192, 486, 12, 14, { fontName: "CMSY10" }),
    pdfItem(" over the heads.", 206, 486, 90, 10)
  ]);
  assert.equal(displaysOf(page).length, 0);
  const text = page.blocks.filter((block) => block.label === "text").map((block) => block.text).join(" ");
  assert.match(text, /width is/);
  assert.match(text, /second sentence/);
  const inline = page.blocks.filter((block) => block.label === "formula");
  assert.ok(inline.length >= 1);
  assert.equal(inline.every((block) => block.display === false && block.inlineOf), true);
  assertOwned(page);
});

test("merged display crops keep descender and side-bearing ink inside the pad", () => {
  const page = pageFrom(caseItems("f05"), fixture.f05.page);
  const formula = displaysOf(page)[0];
  const { width, height } = fixture.viewport;
  const em = 10;
  const side = (em * DISPLAY_INK_OUTSET.x) / width;
  const below = (em * DISPLAY_INK_OUTSET.bottom) / height;
  const glyphs = glyphUnion(fixture.f05.items.filter((item) => item.y === 440 || item.y === 426));
  assert.ok(formula.bbox[0] <= glyphs[0] - side + 1e-6);
  assert.ok(formula.bbox[2] >= glyphs[2] + side - 1e-6);
  assert.ok(formula.bbox[3] >= glyphs[3] + below - 1e-6);
  assert.ok(formula.bbox[1] <= glyphs[1] - (em * DISPLAY_INK_OUTSET.top) / height + 1e-6);

  const rasterW = 400;
  const rasterH = 400;
  const data = new Uint8ClampedArray(rasterW * rasterH * 4);
  data.fill(255);
  const paint = (nx, ny) => {
    const x = Math.round(nx * (rasterW - 1));
    const y = Math.round(ny * (rasterH - 1));
    const index = (y * rasterW + x) * 4;
    data[index] = 0;
    data[index + 1] = 0;
    data[index + 2] = 0;
    data[index + 3] = 255;
    return [x, y];
  };
  const descender = paint(glyphs[0] + 0.02, glyphs[3] + below * 0.8);
  const bearing = paint(glyphs[0] - side * 0.7, (glyphs[1] + glyphs[3]) / 2);
  const measured = measureFormulaCrop(formula.bbox, { data, width: rasterW, height: rasterH }, {
    inline: false,
    protect: true
  });
  const covers = (px, py) => {
    const nx = px / rasterW;
    const ny = py / rasterH;
    return nx >= measured.bbox[0] - 1e-6 && nx <= measured.bbox[2] + 1e-6 &&
      ny >= measured.bbox[1] - 1e-6 && ny <= measured.bbox[3] + 1e-6;
  };
  assert.equal(covers(descender[0], descender[1]), true);
  assert.equal(covers(bearing[0], bearing[1]), true);
  assert.ok(measured.bbox[0] >= formula.bbox[0] - 1 / rasterW - 1e-9);
  assert.ok(measured.bbox[3] <= formula.bbox[3] + 1 / rasterH + 1e-9);
});
