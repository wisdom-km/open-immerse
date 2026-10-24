/**
 * Inline context crop: the red box contains the formula ink, the stroke stays
 * inside the bitmap, and a short span is a formula only with a real script
 * or accent. Lone Greek letters stay in the sentence.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";

import { attachFontRealNames } from "../lib/pdf-mirror.js";
import {
  INK_OUTSIDE_PX,
  TARGET_BOX_GAP,
  TARGET_BOX_PX,
  contextCropGeometry,
  contextWindow,
  containedGlyphInkShortfall,
  formulaInkOutsideCount,
  glyphRectPixels,
  paintTargetBox,
  seatInkBox,
  targetBoxPixels
} from "../lib/formula-context-crop.js";
import { formulaRegionWindow } from "../lib/pdf-formula-raster.js";
import { cropHashOf } from "../lib/formula-contract.js";
import { FORMULA_RUN_MIN_WIDTH, sameLineFormulaSpans, shortFormulaRunExempt, textLayerToBlocks } from "../lib/pdf-text-layer.js";
import {
  FORMULA_CONTEXT_PROMPT,
  FORMULA_VISION_SYSTEM,
  MM_TIER_VERSION,
  formulaVisionPrompt
} from "../lib/formula-tiers/multimodal.js";
import { tierRecordKey } from "../lib/formula-cache.js";
import { visionCropSpec } from "../lib/formula-vision-crop.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const probes = JSON.parse(readFileSync(join(root, "tests/fixtures/formula-context-probes.json"), "utf8"));
const PAGE_W = probes.page.width;
const PAGE_H = probes.page.height;
const SCALE = 4;

function glyph(str, x, extra = {}) {
  return {
    str,
    x,
    y: extra.y ?? 100,
    width: extra.width ?? Math.max(4, String(str).length * 5),
    height: extra.height ?? 10,
    fontName: extra.fontName || "",
    fontRealName: extra.font || "CMR10"
  };
}

function frameOf(formula) {
  return contextCropGeometry(formula, { pageWidth: PAGE_W, pageHeight: PAGE_H, scale: SCALE });
}

function assertGlyphsInside(formula) {
  const frame = frameOf(formula);
  assert.ok(frame, formula.text || formula.id);
  for (const glyphBox of formula.glyphBoxes) {
    assert.ok(glyphBox[0] >= frame.target[0] - 1e-9, `${formula.text} left`);
    assert.ok(glyphBox[1] >= frame.target[1] - 1e-9, `${formula.text} top`);
    assert.ok(glyphBox[2] <= frame.target[2] + 1e-9, `${formula.text} right`);
    assert.ok(glyphBox[3] <= frame.target[3] + 1e-9, `${formula.text} bottom`);
  }
  const rect = targetBoxPixels(frame.bbox, frame.target, PAGE_W, PAGE_H, SCALE);
  const crop = formulaRegionWindow(frame.bbox, PAGE_W * SCALE, PAGE_H * SCALE);
  assert.ok(rect.x - TARGET_BOX_PX >= 0, `${formula.text} stroke left`);
  assert.ok(rect.y - TARGET_BOX_PX >= 0, `${formula.text} stroke top`);
  assert.ok(rect.x + rect.w + TARGET_BOX_PX <= crop.pixelWidth, `${formula.text} stroke right`);
  assert.ok(rect.y + rect.h + TARGET_BOX_PX <= crop.pixelHeight, `${formula.text} stroke bottom`);
  for (const glyphBox of formula.glyphBoxes) {
    const painted = targetBoxPixels(frame.bbox, glyphBox, PAGE_W, PAGE_H, SCALE);
    assert.ok(painted.x >= rect.x, `${formula.text} glyph x`);
    assert.ok(painted.y >= rect.y, `${formula.text} glyph y`);
    assert.ok(painted.x + painted.w <= rect.x + rect.w, `${formula.text} glyph right`);
    assert.ok(painted.y + painted.h <= rect.y + rect.h, `${formula.text} glyph bottom`);
  }
  return { frame, rect, crop };
}

test("DPO short probes keep every glyph inside the red box and the stroke inside the crop", () => {
  const names = ["pi-theta", "pi-sft", "r-hat-theta", "r-phi"];
  assert.deepEqual(names.map((name) => probes.probes[name].text), ["πθ", "πSFT", "rˆθ", "rϕ"]);
  // y_w and y_l are Latin subscripts. They stay in the sentence, and the
  // boxes below are only geometry samples.
  assert.deepEqual([probes.probes["y-w"].text, probes.probes["y-l"].text], ["yw", "yl"]);
  for (const name of ["y-w", "y-l"]) assertGlyphsInside(probes.probes[name]);
  for (const name of names) {
    const formula = probes.probes[name];
    assert.equal(formula.display, false);
    const spec = visionCropSpec(formula, { pageWidth: PAGE_W, pageHeight: PAGE_H, scale: SCALE });
    assert.equal(spec.mode, "context");
    assertGlyphsInside(formula);
  }
});

test("a multi-line display formula stays on the tight crop", () => {
  const display = probes.display;
  assert.equal(display.display, true);
  assert.ok(display.glyphBoxes.length > 20);
  const tops = display.glyphBoxes.map((box) => box[1]);
  const bottoms = display.glyphBoxes.map((box) => box[3]);
  assert.ok(Math.max(...bottoms) - Math.min(...tops) > 0.04);
  assert.equal(visionCropSpec(display, { pageWidth: PAGE_W, pageHeight: PAGE_H, scale: SCALE }).mode, "tight");
});

test("a hat above the layout box stays inside the red box when the next line is close", () => {
  const body = [0.4, 0.5, 0.43, 0.516];
  const hat = [0.408, 0.488, 0.422, 0.502];
  const neighbor = [0.2, 0.47, 0.7, 0.486];
  const formula = {
    display: false,
    text: "rˆθ",
    bbox: body,
    layoutBbox: body,
    glyphBoxes: [body, [0.4, 0.508, 0.412, 0.522], hat],
    maskBoxes: [neighbor],
    paragraphBbox: [0.12, 0.2, 0.88, 0.9]
  };
  const frame = frameOf(formula);
  assert.ok(frame.target[1] <= hat[1] + 1e-9);
  assert.ok(frame.target[3] >= 0.522 - 1e-9);
  assert.ok(frame.bbox[0] >= formula.paragraphBbox[0] - 1e-6 || frame.bbox[0] <= hat[0]);
  const rect = targetBoxPixels(frame.bbox, frame.target, PAGE_W, PAGE_H, SCALE);
  const crop = formulaRegionWindow(frame.bbox, PAGE_W * SCALE, PAGE_H * SCALE);
  assert.ok(rect.y - TARGET_BOX_PX >= 0);
  assert.ok(rect.y + rect.h + TARGET_BOX_PX <= crop.pixelHeight);
});

test("a one-line paragraph does not remove the line above or below", () => {
  const glyphs = [0.4, 0.5, 0.42, 0.514];
  const formula = {
    display: false,
    bbox: glyphs,
    layoutBbox: glyphs,
    glyphBoxes: [glyphs],
    paragraphBbox: [0.12, 0.498, 0.88, 0.516]
  };
  const frame = frameOf(formula);
  assert.ok(glyphs[1] - frame.bbox[1] >= 0.01 - 1e-9, "line above");
  assert.ok(frame.bbox[3] - glyphs[3] >= 0.01 - 1e-9, "line below");
  const belowPx = (frame.bbox[3] - glyphs[3]) * PAGE_H * SCALE;
  assert.ok(belowPx >= INK_OUTSIDE_PX + TARGET_BOX_PX, "descender slack");
  assert.ok(frame.bbox[0] >= formula.paragraphBbox[0] - (TARGET_BOX_PX + 2) / (PAGE_W * SCALE));
  assert.ok(frame.bbox[2] <= formula.paragraphBbox[2] + (TARGET_BOX_PX + 2) / (PAGE_W * SCALE));
});

test("the stroke may cross the column by the margin it needs, and no further", () => {
  const glyphs = [0.2, 0.4, 0.22, 0.414];
  const formula = {
    display: false,
    bbox: glyphs,
    layoutBbox: glyphs,
    glyphBoxes: [glyphs],
    paragraphBbox: glyphs.slice()
  };
  const frame = frameOf(formula);
  const strokeX = (TARGET_BOX_PX + 1) / (PAGE_W * SCALE);
  assert.ok(frame.bbox[0] <= glyphs[0] - strokeX + 1e-8);
  assert.ok(frame.bbox[0] > glyphs[0] - 0.02);
  assert.ok(frame.target[0] <= glyphs[0]);
  assert.ok(frame.target[2] >= glyphs[2]);
});

function blankImage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let index = 3; index < data.length; index += 4) data[index] = 255;
  return {
    data,
    width,
    height,
    dot(x, y) {
      const index = (y * width + x) * 4;
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  };
}

test("a descender 9px below the metric box stays inside and the next line stays outside", () => {
  const image = blankImage(80, 90);
  const glyph = { x: 20, y: 20, w: 30, h: 20 };
  for (let y = 30; y <= 39; y += 1) {
    image.dot(30, y);
    image.dot(31, y);
  }
  for (let y = 40; y <= 48; y += 1) {
    image.dot(30, y);
    image.dot(31, y);
  }
  for (let x = glyph.x; x < glyph.x + glyph.w; x += 1) image.dot(x, 56);
  const seated = seatInkBox(image, glyph);
  assert.ok(seated.y <= 30 && seated.y + seated.h > 48, "descender ink is inside");
  assert.ok(56 >= seated.y + seated.h, "neighbor is outside the interior");
  const shrunk = seated.y + seated.h - 3;
  assert.ok(48 >= shrunk, "a 3px shrink into the descender drops ink");
  assert.ok(seated.y - TARGET_BOX_PX >= 0);
  assert.ok(seated.y + seated.h + TARGET_BOX_PX <= image.height);
});

test("an empty metric margin above a bracket is not the red edge", () => {
  const image = blankImage(80, 80);
  const glyph = { x: 10, y: 10, w: 40, h: 50 };
  for (let y = 48; y <= 59; y += 1) {
    image.dot(12, y);
    image.dot(13, y);
  }
  for (let x = glyph.x; x < glyph.x + glyph.w; x += 1) image.dot(x, 4);
  const seated = seatInkBox(image, glyph);
  assert.ok(seated.y > 40, `top ${seated.y} sat on the metric box`);
  assert.ok(seated.y <= 48);
  assert.ok(4 < seated.y, "the line above is outside");
  assert.ok(seated.y + seated.h > 59, "bracket ink is inside");
});

test("the inter-line gap limits the pad, so a full gap and a 4px stroke both miss the next line", () => {
  const image = blankImage(80, 70);
  const glyph = { x: 10, y: 10, w: 40, h: 20 };
  for (let y = 20; y <= 29; y += 1) image.dot(20, y);
  for (let x = glyph.x; x < glyph.x + glyph.w; x += 1) image.dot(x, 35);
  const seated = seatInkBox(image, glyph);
  const inkBottom = 30;
  const neighbor = 35;
  const room = neighbor - inkBottom;
  const pad = Math.min(TARGET_BOX_GAP, Math.max(0, room - TARGET_BOX_PX));
  assert.equal(pad, 1);
  assert.equal(seated.y + seated.h, inkBottom + pad);
  assert.ok(seated.y + seated.h > inkBottom && seated.y + seated.h < neighbor);
  assert.ok(neighbor >= seated.y + seated.h + TARGET_BOX_PX);
  assert.ok(29 < seated.y + seated.h);
});

test("contextWindow still clamps words to the column without cutting the target", () => {
  const target = [0.4, 0.42, 0.46, 0.44];
  const column = [0.3, 0.1, 0.5, 0.9];
  const window = contextWindow({
    display: false,
    bbox: target,
    layoutBbox: target,
    paragraphBbox: column
  });
  assert.ok(window.bbox[0] >= column[0] - 1e-9);
  assert.ok(window.bbox[2] <= column[2] + 1e-9);
  assert.ok(window.bbox[0] <= target[0]);
  assert.ok(window.bbox[2] >= target[2]);
});

test("the red stroke sits outside the glyphs", () => {
  const formula = probes.probes["pi-theta"];
  const { frame, rect, crop } = assertGlyphsInside(formula);
  const canvas = {
    width: crop.pixelWidth,
    height: crop.pixelHeight,
    getContext() {
      return this.ctx;
    },
    ctx: {
      fillStyle: "",
      fillRect(x, y, w, h) {
        const red = this.fillStyle === "#ff0000";
        for (let py = Math.floor(y); py < y + h; py += 1) {
          for (let px = Math.floor(x); px < x + w; px += 1) {
            if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) {
              canvas.clipped += 1;
              continue;
            }
            canvas.pixels[(py * canvas.width + px) * 4] = red ? 1 : 0;
          }
        }
      }
    },
    pixels: new Uint8ClampedArray(crop.pixelWidth * crop.pixelHeight * 4),
    clipped: 0
  };
  canvas.pixels.fill(255);
  assert.equal(paintTargetBox(canvas, rect, TARGET_BOX_PX), true);
  assert.equal(canvas.clipped, 0);
  const glyph = targetBoxPixels(frame.bbox, formula.glyphBoxes[0], PAGE_W, PAGE_H, SCALE);
  let redInside = 0;
  for (let y = glyph.y; y < glyph.y + glyph.h; y += 1) {
    for (let x = glyph.x; x < glyph.x + glyph.w; x += 1) {
      if (canvas.pixels[(y * canvas.width + x) * 4] === 1) redInside += 1;
    }
  }
  assert.equal(redInside, 0);
  assert.equal(canvas.pixels[((rect.y - 2) * canvas.width + (rect.x + 2)) * 4], 1);
});

test("Greek subscripts, accents, and superscripts are short formulas; Latin subscripts are not", () => {
  assert.equal(FORMULA_RUN_MIN_WIDTH, 12);
  const prose = (str, x, width) => glyph(str, x, { width, font: "NimbusRomNo9L-Regu" });
  const piTheta = [
    prose("where ", 0, 36),
    glyph("π", 40, { width: 6, font: "CMSY10" }),
    glyph("θ", 46, { y: 97, width: 4, height: 7, font: "CMMI7" }),
    prose(" is", 54, 16)
  ];
  assert.deepEqual(sameLineFormulaSpans(piTheta), [[1, 2]]);
  const yw = [
    prose("prefer ", 0, 40),
    glyph("y", 42, { width: 5, font: "CMMI10" }),
    glyph("w", 47, { y: 96, width: 5, height: 7, font: "CMMI7" }),
    prose(" over", 56, 24)
  ];
  assert.deepEqual(sameLineFormulaSpans(yw), []);
  const betaT = [
    prose("step ", 0, 28),
    glyph("β", 30, { width: 6, font: "CMMI10" }),
    glyph("t", 36, { y: 96, width: 4, height: 7, font: "CMMI7" }),
    prose(" then", 44, 24)
  ];
  assert.deepEqual(sameLineFormulaSpans(betaT), []);
  const raised = [
    prose("policy ", 0, 36),
    glyph("π", 40, { width: 5, font: "CMSY10" }),
    glyph("SFT", 45, { y: 104, width: 6, height: 6, font: "NimbusRomNo9L-Regu" }),
    prose(" is", 54, 14)
  ];
  assert.deepEqual(sameLineFormulaSpans(raised), [[1, 2]]);
  const prime = [
    prose("draw ", 0, 28),
    glyph("x", 30, { width: 5, font: "CMMI10" }),
    glyph("′", 35, { y: 104, width: 3, height: 6, font: "CMR7" }),
    glyph("t", 38, { y: 96, width: 4, height: 7, font: "CMMI7" }),
    prose(" at", 46, 12)
  ];
  assert.deepEqual(sameLineFormulaSpans(prime), [[1, 3]]);
  const piSft = [
    prose("model ", 0, 36),
    glyph("π", 40, { width: 6, font: "CMSY10" }),
    glyph("SFT", 46, { y: 96, width: 11, height: 7, font: "NimbusRomNo9L-Regu" }),
    prose(". The", 60, 24)
  ];
  assert.deepEqual(sameLineFormulaSpans(piSft), [[1, 2]]);
  const hat = [
    prose("where ", 0, 36),
    glyph("r", 40, { width: 5, font: "CMMI10" }),
    glyph("ˆ", 44, { width: 5, font: "CMR10" }),
    glyph("θ", 49, { y: 96, width: 4, height: 7, font: "CMMI7" }),
    prose(" rates", 56, 30)
  ];
  assert.deepEqual(sameLineFormulaSpans(hat), [[1, 3]]);
  const phi = [
    prose("reward ", 0, 40),
    glyph("r", 42, { width: 5, font: "CMMI10" }),
    glyph("ϕ", 47, { y: 96, width: 4, height: 7, font: "CMMI7" }),
    prose(" then", 54, 24)
  ];
  assert.deepEqual(sameLineFormulaSpans(phi), [[1, 2]]);
  const plain = [
    prose("The value is ", 0, 70),
    glyph("n", 72, { width: 8, font: "CMMI10" }),
    prose(" here.", 82, 30)
  ];
  assert.deepEqual(sameLineFormulaSpans(plain), []);
  const call = [
    prose("where ", 0, 36),
    glyph("Z", 40, { width: 6, font: "CMMI10" }),
    glyph("(", 46, { width: 4, font: "CMR10" }),
    glyph("x", 50, { width: 5, font: "CMMI10" }),
    glyph(")", 55, { width: 4, font: "CMR10" }),
    prose(" is", 62, 14)
  ];
  assert.deepEqual(sameLineFormulaSpans(call), []);
  const lonePi = [
    prose("The ", 0, 24),
    glyph("π", 28, { width: 16, font: "CMSY10" }),
    prose(" decay", 48, 30)
  ];
  assert.deepEqual(sameLineFormulaSpans(lonePi), []);
  const twoPi = [
    prose("from ", 0, 28),
    glyph("2", 30, { width: 8, font: "CMR10" }),
    glyph("π", 38, { width: 10, font: "CMMI10" }),
    prose(" to", 52, 16)
  ];
  assert.deepEqual(sameLineFormulaSpans(twoPi), []);
  const fragment = [
    prose("let ", 0, 20),
    glyph("π", 24, { width: 8, font: "CMSY10" }),
    glyph("(", 32, { width: 4, font: "CMR10" }),
    prose("decay", 40, 30)
  ];
  assert.deepEqual(sameLineFormulaSpans(fragment), []);
  const wideCall = [
    prose("see ", 0, 20),
    glyph("f", 24, { width: 8, font: "CMSY10" }),
    glyph("(", 32, { width: 4, font: "CMR10" }),
    glyph("x", 36, { width: 8, font: "CMMI10" }),
    glyph(")", 44, { width: 4, font: "CMR10" }),
    prose(" maps", 52, 24)
  ];
  assert.deepEqual(sameLineFormulaSpans(wideCall), [[1, 4]]);
  const word = [prose("Attention", 0, 50)];
  assert.equal(shortFormulaRunExempt(word, 0, 0, { bodyH: 10, baseY: 100 }), false);
  const cite = [glyph("[12]", 0, { width: 8, font: "CMR10" })];
  assert.equal(shortFormulaRunExempt(cite, 0, 0, { bodyH: 10, baseY: 100 }), false);
});

test("only an inline context crop appends the strict prompt", () => {
  const inline = formulaVisionPrompt(
    { display: false },
    { meta: { mode: "context" } }
  );
  assert.equal(inline.system, `${FORMULA_VISION_SYSTEM}\n${FORMULA_CONTEXT_PROMPT}`);
  assert.match(inline.system, /只输出红框里这个公式的 LaTeX/);
  assert.match(inline.system, /不要输出红框外的公式/);
  assert.equal(formulaVisionPrompt({ display: true }, { meta: { mode: "context" } }).system, FORMULA_VISION_SYSTEM);
  assert.equal(
    formulaVisionPrompt({ inlineOf: "p1-b2" }, { meta: { mode: "context" } }).system,
    `${FORMULA_VISION_SYSTEM}\n${FORMULA_CONTEXT_PROMPT}`
  );
  assert.equal(formulaVisionPrompt({ display: false }, { meta: { mode: "tight" } }).system, FORMULA_VISION_SYSTEM);
  assert.equal(MM_TIER_VERSION, "mm-5");
});

test("ink past the metric box stays inside the red box", () => {
  // The glyph box ends at x=26. Connected ink continues to x=32, and most of
  // that ink is still inside the box, so it belongs to the formula. Left and
  // right edges have to follow the ink. A box built only from the glyph union
  // leaves those pixels outside.
  const image = blankImage(48, 36);
  const glyph = { x: 10, y: 8, w: 16, h: 16 };
  for (let y = 12; y <= 20; y += 1) {
    for (let x = 12; x <= 32; x += 1) image.dot(x, y);
  }
  const seated = seatInkBox(image, glyph);
  assert.equal(formulaInkOutsideCount(image, [glyph], seated), 0);
  assert.ok(seated.x + seated.w >= 35, JSON.stringify(seated));
});

test("an accent disconnected from its base stays inside the red box", () => {
  // The accent box overlaps the base, so the dark mass of the letter is the
  // largest component and a largest-component rule drops the hat. The hat is
  // its own component, fully inside the glyph box, and must sit at least two
  // pixels inside the red box. This count does not use the seated mask.
  const image = blankImage(40, 40);
  const glyph = { x: 8, y: 4, w: 20, h: 28 };
  for (let y = 16; y <= 28; y += 1) {
    for (let x = 10; x <= 24; x += 1) image.dot(x, y);
  }
  for (let x = 14; x <= 20; x += 1) image.dot(x, 8);
  const seated = seatInkBox(image, glyph);
  assert.equal(containedGlyphInkShortfall(image, [glyph], seated, 2), 0);
  assert.ok(seated.y <= 6, JSON.stringify(seated));
});

test("a wide descender row stays inside the red box", () => {
  const image = blankImage(90, 90);
  const glyph = { x: 10, y: 10, w: 50, h: 20 };
  for (let y = 16; y <= 29; y += 1) {
    for (let x = 14; x <= 40; x += 1) image.dot(x, y);
  }
  for (let y = 30; y <= 38; y += 1) {
    for (let x = 16; x <= 40; x += 1) image.dot(x, y);
  }
  for (let x = glyph.x; x < glyph.x + glyph.w; x += 1) image.dot(x, 50);
  const seated = seatInkBox(image, glyph);
  assert.ok(seated.y + seated.h > 38, `bottom ${seated.y + seated.h} cut the descender`);
  assert.ok(50 >= seated.y + seated.h, "neighbor stays outside");
  assert.equal(formulaInkOutsideCount(image, [glyph], seated), 0);
});

function sliceRaster(image, originX, originY, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const src = ((originY + y) * image.width + originX) * 4;
    data.set(image.data.subarray(src, src + width * 4), y * width * 4);
  }
  return { data, width, height };
}

test("rendered DPO, Attention, and DDPM inline crops keep formula ink inside the red box", { timeout: 1800000 }, async (t) => {
  // Independent of the mask the box is seated on. A dark component that lies
  // wholly inside this block's glyph boxes (one pixel of slack, so a neighbour
  // line cannot qualify) must sit inside the red box. The box keeps a 2px
  // white gap when the next line leaves room for the stroke; a tighter gap
  // shrinks that pad instead of crossing the neighbour.
  const papers = [
    ["DPO", join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf")],
    ["Attention", join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf")],
    ["DDPM", join(root, "tests/fixtures/DDPM_2006.11239.pdf")]
  ];
  const missing = papers.filter(([, path]) => !existsSync(path));
  if (missing.length) {
    const listed = missing.map(([name, path]) => `${name} (${path.slice(root.length + 1)})`).join(", ");
    t.skip(`missing ${listed}; gitignored arXiv PDFs are not in the repo (DDPM is tests/fixtures/DDPM_2006.11239.pdf). Supply that file locally. The rendered ink check did not run`);
    return;
  }
  let createCanvas;
  try {
    ({ createCanvas } = createRequire(import.meta.url)("@napi-rs/canvas"));
  } catch {
    t.skip("@napi-rs/canvas is not installed; the rendered ink check did not run");
    return;
  }
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const failures = [];
  for (const [paperName, pdfPath] of papers) {
    const doc = await getDocument({
      data: new Uint8Array(readFileSync(pdfPath)),
      verbosity: 0,
      isOffscreenCanvasSupported: false
    }).promise;
    try {
      for (let number = 1; number <= doc.numPages; number += 1) {
        const pdfPage = await doc.getPage(number);
        const content = await pdfPage.getTextContent();
        const ops = await pdfPage.getOperatorList();
        attachFontRealNames(content.items, pdfPage.commonObjs);
        const viewport = pdfPage.getViewport({ scale: 1 });
        const built = textLayerToBlocks({
          items: content.items,
          viewport,
          images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
          page: number
        });
        const canvas = createCanvas(Math.ceil(viewport.width * SCALE), Math.ceil(viewport.height * SCALE));
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({
          canvasContext: context,
          viewport: pdfPage.getViewport({ scale: SCALE })
        }).promise;
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        for (const block of built.blocks) {
          if (block.label !== "formula" || block.display !== false) continue;
          const frame = contextCropGeometry(block, {
            pageWidth: viewport.width,
            pageHeight: viewport.height,
            scale: SCALE
          });
          if (!frame?.bbox) continue;
          const window = formulaRegionWindow(frame.bbox, canvas.width, canvas.height);
          const slice = sliceRaster(image, window.offsetX, window.offsetY, window.pixelWidth, window.pixelHeight);
          const glyphRect = glyphRectPixels(frame.bbox, block.glyphBoxes, viewport.width, viewport.height, SCALE);
          const glyphs = (block.glyphBoxes || [])
            .map((box) => targetBoxPixels(frame.bbox, box, viewport.width, viewport.height, SCALE))
            .filter(Boolean);
          if (!glyphRect || !glyphs.length) continue;
          const seated = seatInkBox(slice, glyphRect, { glyphs });
          const outside = containedGlyphInkShortfall(slice, glyphs, seated, 0);
          if (outside) {
            failures.push(`${paperName} p${number} ${outside}px ${block.sourceText?.slice(0, 40)}`);
          }
        }
      }
    } finally {
      await doc.destroy();
    }
  }
  assert.deepEqual(failures, []);
});

test("the tier key is mm-5 and the crop hash is the png that was sent", () => {
  const first = { docHash: "doc", bid: "b1", crop: { pixels: "data:image/png;base64,AAAA" } };
  const second = { docHash: "doc", bid: "b1", crop: { pixels: "data:image/png;base64,BBBB" } };
  const key = tierRecordKey(first, { id: "multimodal", version: MM_TIER_VERSION }, "kimi-k3");
  const other = tierRecordKey(second, { id: "multimodal", version: MM_TIER_VERSION }, "kimi-k3");
  assert.notEqual(cropHashOf(first), cropHashOf(second));
  assert.notEqual(key, other);
  assert.match(key, /:mm-5:/);
  assert.match(key, new RegExp(`${cropHashOf(first)}$`));
  assert.doesNotMatch(key, /:mm-3:/);
});
