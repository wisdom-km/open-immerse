/**
 * Round-2 product crop: inline column window and red box, display 9pt pad,
 * the red-box prompt sentence, and the neighbour-letter safety net.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  TARGET_BOX_COLOR,
  TARGET_BOX_GAP,
  TARGET_BOX_PX,
  contextCropGeometry,
  contextWindow,
  paintTargetBox,
  seatInkBox,
  targetBoxPixels,
  targetGapPx
} from "../lib/formula-context-crop.js";
import { formulaRegionWindow } from "../lib/pdf-formula-raster.js";
import {
  DISPLAY_VISION_PAD_PT,
  VISION_CROP_SCALE,
  VISION_INK_PAD_PX,
  displayVisionSourceBbox,
  visionCropSpec
} from "../lib/formula-vision-crop.js";
import {
  CONTEXT_PROMPT_NOTE,
  FORMULA_CONTEXT_PROMPT,
  FORMULA_VISION_SYSTEM,
  formulaVisionPrompt
} from "../lib/formula-tiers/multimodal.js";
import { charsetJaccard, latexToCharset, pdfTextCharset } from "../lib/formula-charset.js";
import {
  applyNeighbourSafetyNet,
  neighbourEdgeLetters,
  stripNeighbourEdgeLetters,
  verifyCandidate
} from "../lib/formula-verify.js";
import { renderEquivalent } from "../lib/formula-render-equiv.js";
import { latexMatchesReference } from "../lib/mm-dpo-ab.js";
import { buildVisionRequest, multimodalTarget } from "../lib/mm-client.js";
import { normalizeFormulaSettings } from "../lib/formula-settings.js";
import { loadKatex } from "./helpers/arxiv-paper.mjs";

const katex = loadKatex();
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PAGE_W = 612;
const PAGE_H = 792;

function strokeCanvas(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  const canvas = {
    width,
    height,
    getContext() {
      return {
        fillStyle: "#000000",
        fillRect(x, y, w, h) {
          const match = /^#([0-9a-f]{6})$/i.exec(String(this.fillStyle));
          const r = match ? Number.parseInt(match[1].slice(0, 2), 16) : 0;
          const g = match ? Number.parseInt(match[1].slice(2, 4), 16) : 0;
          const b = match ? Number.parseInt(match[1].slice(4, 6), 16) : 0;
          const x0 = Math.max(0, Math.floor(x));
          const y0 = Math.max(0, Math.floor(y));
          const x1 = Math.min(width, Math.ceil(x + w));
          const y1 = Math.min(height, Math.ceil(y + h));
          for (let yy = y0; yy < y1; yy += 1) {
            for (let xx = x0; xx < x1; xx += 1) {
              const index = (yy * width + xx) * 4;
              data[index] = r;
              data[index + 1] = g;
              data[index + 2] = b;
              data[index + 3] = 255;
            }
          }
        }
      };
    }
  };
  return { canvas, data };
}

function pixel(data, width, x, y) {
  const index = (y * width + x) * 4;
  return [data[index], data[index + 1], data[index + 2]];
}

function isRed(rgb) {
  return rgb[0] === 255 && rgb[1] === 0 && rgb[2] === 0;
}

const inlineFormula = {
  display: false,
  inlineOf: "p4-b2",
  bbox: [0.42, 0.4, 0.47, 0.412],
  layoutBbox: [0.42, 0.4, 0.47, 0.412],
  glyphBoxes: [[0.42, 0.4, 0.47, 0.412]],
  paragraphBbox: [0.08, 0.2, 0.48, 0.8]
};

test("an inline window is the text line, clipped to the column, plus about one line", () => {
  const height = inlineFormula.bbox[3] - inlineFormula.bbox[1];
  const line = Math.min(0.02, Math.max(height, 0.015));
  const window = contextWindow(inlineFormula);
  const column = inlineFormula.paragraphBbox;
  assert.equal(window.bbox[0], column[0]);
  assert.equal(window.bbox[2], column[2]);
  assert.ok(window.bbox[0] <= window.target[0]);
  assert.ok(window.bbox[2] >= window.target[2]);
  assert.ok(Math.abs(window.target[1] - window.bbox[1] - line) < 1e-12);
  assert.ok(Math.abs(window.bbox[3] - window.target[3] - line) < 1e-12);
  assert.ok(line >= 0.015 && line <= 0.02);

  const bare = contextWindow({
    display: false,
    bbox: inlineFormula.bbox,
    layoutBbox: inlineFormula.layoutBbox
  });
  assert.ok(bare.bbox[0] > 0.2, "without a column the sides stay a few words");
  assert.ok(bare.bbox[2] < 0.7);

  const frame = contextCropGeometry(inlineFormula, {
    pageWidth: PAGE_W,
    pageHeight: PAGE_H,
    scale: VISION_CROP_SCALE
  });
  const stroke = (TARGET_BOX_PX + 1) / (PAGE_W * VISION_CROP_SCALE);
  assert.ok(frame.bbox[0] <= column[0] + 1e-9);
  assert.ok(frame.bbox[2] >= column[2] - 1e-9);
  assert.ok(frame.bbox[0] >= column[0] - stroke - 1e-9);
  assert.ok(frame.bbox[2] <= column[2] + stroke + 1e-9);
  assert.ok(inlineFormula.bbox[1] - frame.bbox[1] >= line - 1e-9);
  assert.ok(frame.bbox[3] - inlineFormula.bbox[3] >= line - 1e-9);

  const spec = visionCropSpec(inlineFormula, { pageWidth: PAGE_W, pageHeight: PAGE_H });
  assert.equal(spec.mode, "context");
  assert.equal(spec.scale, 4);
  assert.ok(spec.window.bbox[0] <= column[0] + 1e-9);
  assert.ok(spec.window.bbox[2] >= column[2] - 1e-9);
  assert.ok(spec.window.target[0] >= spec.window.bbox[0]);
  assert.ok(spec.window.target[2] <= spec.window.bbox[2]);
});

test("the red box stays outside the formula at DPR 1 and DPR 2", () => {
  const frames = [];
  for (const dpr of [1, 2]) {
    const scale = VISION_CROP_SCALE * dpr;
    const frame = contextCropGeometry(inlineFormula, {
      pageWidth: PAGE_W,
      pageHeight: PAGE_H,
      scale
    });
    const crop = formulaRegionWindow(frame.bbox, PAGE_W * scale, PAGE_H * scale);
    const rect = targetBoxPixels(frame.bbox, frame.target, PAGE_W, PAGE_H, scale);
    assert.ok(rect.x >= TARGET_BOX_PX, `dpr ${dpr} stroke leaves the bitmap`);
    assert.ok(rect.y >= TARGET_BOX_PX, `dpr ${dpr} stroke leaves the bitmap`);
    assert.ok(rect.x + rect.w + TARGET_BOX_PX <= crop.pixelWidth);
    assert.ok(rect.y + rect.h + TARGET_BOX_PX <= crop.pixelHeight);
    const { canvas, data } = strokeCanvas(crop.pixelWidth, crop.pixelHeight);
    assert.equal(paintTargetBox(canvas, rect, TARGET_BOX_PX), true);
    assert.equal(TARGET_BOX_COLOR, "#ff0000");
    const midX = rect.x + Math.floor(rect.w / 2);
    const midY = rect.y + Math.floor(rect.h / 2);
    assert.deepEqual(pixel(data, crop.pixelWidth, midX, midY), [255, 255, 255]);
    let above = 0;
    for (let step = 1; step <= 6; step += 1) {
      if (!isRed(pixel(data, crop.pixelWidth, midX, rect.y - step))) break;
      above += 1;
    }
    assert.equal(above, TARGET_BOX_PX, `dpr ${dpr} stroke thickness`);
    assert.equal(isRed(pixel(data, crop.pixelWidth, midX, rect.y + rect.h)), true);
    assert.equal(isRed(pixel(data, crop.pixelWidth, rect.x - 1, midY)), true);
    assert.equal(isRed(pixel(data, crop.pixelWidth, rect.x + rect.w, midY)), true);
    frames.push({ dpr, rect, width: crop.pixelWidth });
  }
  const [low, high] = frames;
  assert.ok(high.rect.w > low.rect.w, "DPR 2 raster is wider than DPR 1");
  assert.ok(high.width > low.width);
  assert.equal(low.dpr, 1);
  assert.equal(high.dpr, 2);
});

test("the stroke inner edge clears the ink bbox by the gap at DPR 1 and DPR 2", () => {
  for (const dpr of [1, 2]) {
    const scale = VISION_CROP_SCALE * dpr;
    const gap = targetGapPx(scale);
    assert.equal(gap, TARGET_BOX_GAP * dpr);
    const width = 120 * dpr;
    const height = 90 * dpr;
    const data = new Uint8ClampedArray(width * height * 4);
    data.fill(255);
    const dot = (x, y) => {
      const index = (y * width + x) * 4;
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 255;
    };
    const x0 = 28 * dpr;
    const y0 = 30 * dpr;
    const inkW = 18 * dpr;
    const inkH = 14 * dpr;
    for (let y = y0; y < y0 + inkH; y += 1) {
      for (let x = x0; x < x0 + inkW; x += 1) dot(x, y);
    }
    // Disconnected ≤ bar, five 4× pixels to the right of the metric ink.
    const tipX = x0 + inkW + 5 * dpr;
    for (let y = y0 + inkH - 3 * dpr; y < y0 + inkH; y += 1) {
      for (let x = tipX; x < tipX + 3 * dpr; x += 1) dot(x, y);
    }
    // Comma tail, four 4× pixels below the metric ink.
    const tailY = y0 + inkH + 4 * dpr;
    for (let y = tailY; y < tailY + 4 * dpr; y += 1) dot(x0 + 4 * dpr, y);
    const glyph = { x: x0, y: y0, w: inkW, h: inkH };
    const image = { data, width, height };
    const seated = seatInkBox(image, glyph, { glyphs: [glyph], scale });
    const owned = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        if (data[index] !== 0) continue;
        owned.push(index);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    assert.ok(maxX >= tipX, `dpr ${dpr} the detached bar is part of the ink bbox`);
    assert.ok(maxY >= tailY, `dpr ${dpr} the comma tail is part of the ink bbox`);
    assert.ok(seated.x + gap <= minX, `dpr ${dpr} left gap`);
    assert.ok(seated.y + gap <= minY, `dpr ${dpr} top gap`);
    assert.ok(maxX < seated.x + seated.w - gap, `dpr ${dpr} right gap`);
    assert.ok(maxY < seated.y + seated.h - gap, `dpr ${dpr} bottom gap`);
    const paint = {
      width,
      height,
      getContext() {
        return {
          fillStyle: TARGET_BOX_COLOR,
          fillRect(x, y, w, h) {
            const x0p = Math.max(0, Math.floor(x));
            const y0p = Math.max(0, Math.floor(y));
            const x1p = Math.min(width, Math.ceil(x + w));
            const y1p = Math.min(height, Math.ceil(y + h));
            for (let yy = y0p; yy < y1p; yy += 1) {
              for (let xx = x0p; xx < x1p; xx += 1) {
                const index = (yy * width + xx) * 4;
                data[index] = 255;
                data[index + 1] = 0;
                data[index + 2] = 0;
              }
            }
          }
        };
      }
    };
    assert.equal(paintTargetBox(paint, seated, TARGET_BOX_PX), true);
    for (const index of owned) {
      assert.equal(data[index], 0, `dpr ${dpr} stroke covers target ink`);
    }
    let thickness = 0;
    const midX = seated.x + Math.floor(seated.w / 2);
    for (let step = 1; step <= 8; step += 1) {
      const index = ((seated.y - step) * width + midX) * 4;
      if (data[index] !== 255 || data[index + 1] !== 0) break;
      thickness += 1;
    }
    assert.equal(thickness, TARGET_BOX_PX, `dpr ${dpr} stroke width`);
  }
});

test("a display crop keeps at least 9pt above and below and has no red-box window", () => {
  const block = {
    display: true,
    bbox: [0.2, 0.4, 0.8, 0.46],
    layoutBbox: [0.2, 0.4, 0.8, 0.46],
    paragraphBbox: [0.05, 0.1, 0.95, 0.9]
  };
  const source = displayVisionSourceBbox(block, PAGE_H);
  const pad = DISPLAY_VISION_PAD_PT / PAGE_H;
  assert.equal(DISPLAY_VISION_PAD_PT, 9);
  assert.equal(source[0], block.layoutBbox[0]);
  assert.equal(source[2], block.layoutBbox[2]);
  assert.ok(Math.abs(block.layoutBbox[1] - source[1] - pad) < 1e-12);
  assert.ok(Math.abs(source[3] - block.layoutBbox[3] - pad) < 1e-12);
  const spec = visionCropSpec(block, { pageWidth: PAGE_W, pageHeight: PAGE_H });
  assert.equal(spec.mode, "tight");
  assert.equal(spec.window, null);
  assert.equal(spec.scale, VISION_CROP_SCALE);
  assert.deepEqual(spec.sourceBbox, source);
  assert.equal(spec.pad.namedPx, VISION_INK_PAD_PX.display);
  assert.equal(spec.pad.namedPx, 18);
  assert.equal(spec.pad.padPx, 36);
  const words = contextWindow(block);
  assert.ok(words.bbox[0] > block.paragraphBbox[0] + 0.01);
});

test("only an inline context crop is told to read the red box", () => {
  assert.equal(
    CONTEXT_PROMPT_NOTE,
    "只输出红框里这个公式的 LaTeX。周围文字是上下文，不要输出红框外的公式。"
  );
  assert.equal(FORMULA_CONTEXT_PROMPT, CONTEXT_PROMPT_NOTE);
  const inline = formulaVisionPrompt({ display: false }, { meta: { mode: "context" } });
  assert.equal(inline.system, `${FORMULA_VISION_SYSTEM}\n${CONTEXT_PROMPT_NOTE}`);
  assert.equal(formulaVisionPrompt({ display: true }, { meta: { mode: "context" } }).system, FORMULA_VISION_SYSTEM);
  assert.equal(formulaVisionPrompt({ display: false }, { meta: { mode: "tight" } }).system, FORMULA_VISION_SYSTEM);
});

test("neighbour letters are peeled only when the stripped formula still renders", () => {
  const host = { bbox: [0.4, 0.4, 0.5, 0.42], layoutBbox: [0.4, 0.4, 0.5, 0.42] };
  const letters = neighbourEdgeLetters([
    { str: "If", bbox: [0.36, 0.4, 0.39, 0.42] },
    { str: "x", bbox: [0.44, 0.4, 0.46, 0.42] },
    { str: "eq", bbox: [0.51, 0.4, 0.54, 0.42] },
    { str: "cat", bbox: [0.7, 0.4, 0.74, 0.42] },
    { str: "to", bbox: [0.36, 0.5, 0.39, 0.52] },
    { str: "where", bbox: [0.3, 0.4, 0.35, 0.42] }
  ], host);
  assert.deepEqual(letters, ["If", "eq"]);
  assert.equal(stripNeighbourEdgeLetters("If x^2 eq", letters), "x^2");
  assert.equal(stripNeighbourEdgeLetters("If\\ x^2\\ eq", letters), "x^2");
  assert.equal(stripNeighbourEdgeLetters("\\mathrm{If} x_i \\text{eq}", letters), "x_i");
  assert.equal(stripNeighbourEdgeLetters("If x^2", ["eq"]), "If x^2");
  assert.equal(applyNeighbourSafetyNet("If x^2 eq", letters, false, katex, "x^2"), "x^2");
  assert.equal(applyNeighbourSafetyNet("aa x^", ["aa"], false, katex, "x"), "aa x^");
  assert.equal(applyNeighbourSafetyNet("aa \\notacommand", ["aa"], false, katex, "x"), "aa \\notacommand");
  const above = { str: "to", bbox: [0.36, 0.385, 0.39, 0.4] };
  const far = { str: "Or", bbox: [0.2, 0.4, 0.24, 0.42] };
  const beside = { str: "x", bbox: [0.52, 0.4, 0.545, 0.42] };
  assert.deepEqual(neighbourEdgeLetters([above, far], host), []);
  assert.deepEqual(neighbourEdgeLetters(
    [{ str: "If", bbox: [0.36, 0.4, 0.39, 0.42] }, beside],
    host,
    { formulaBoxes: [[0.51, 0.395, 0.56, 0.425]] }
  ), ["If"]);
  const kept = verifyCandidate("Q \\notacommand", {
    pdfText: "Q",
    display: false,
    neighbourLetters: ["Q"]
  }, katex);
  assert.equal(kept.latex, "Q \\notacommand");
  const peeled = verifyCandidate("If x^2 eq", {
    pdfText: "x^2",
    display: false,
    neighbourLetters: letters
  }, katex);
  assert.equal(peeled.latex, "x^2");
});

test("neighbour peeling does not delete letters that belong to the formula", () => {
  const sum = "\\sum_{i=1}^{n}+bcde + b x";
  const damaged = "\\sum_{i=1}^{n}+bcde + b";
  const pdf = "∑i=1n+bcdebx";
  const fullOverlap = charsetJaccard(latexToCharset(sum), pdfTextCharset(pdf));
  const damagedOverlap = charsetJaccard(latexToCharset(damaged), pdfTextCharset(pdf));
  assert.ok(damagedOverlap >= 0.9, `damaged overlap ${damagedOverlap}`);
  assert.ok(fullOverlap > damagedOverlap);
  const cases = [
    ["a + b", "a + b", ["a"], "a + b"],
    ["f(x) = a x", "f(x) = a x", ["a", "x"], "f(x) = a x"],
    [sum, pdf, ["x"], sum]
  ];
  for (const [latex, source, letters, kept] of cases) {
    const direct = applyNeighbourSafetyNet(latex, letters, false, katex, source);
    assert.equal(direct, kept);
    const checked = verifyCandidate(latex, {
      pdfText: source,
      display: false,
      neighbourLetters: letters
    }, katex);
    assert.equal(checked.latex, kept);
  }
  const shown = verifyCandidate(sum, {
    pdfText: pdf,
    display: false,
    neighbourLetters: ["x"]
  }, katex);
  assert.equal(shown.pass, true);
  assert.equal(shown.latex.includes("x"), true);
  assert.notEqual(shown.latex, damaged);
});

test("render equivalence is the acceptance metric", () => {
  assert.equal(renderEquivalent("x_i^2", "x^2_i", { katex }), true);
  assert.equal(renderEquivalent("\\mathrm{ext}", "\\text{ext}", { katex }), true);
  assert.equal(renderEquivalent("\\mathbf{x}", "\\boldsymbol{x}", { katex }), true);
  assert.equal(renderEquivalent("x", "y", { katex }), false);
  assert.equal(renderEquivalent("{u^*}^T", "u^{*T}", { katex }), true);
  assert.equal(renderEquivalent("\\notacommand", "x", { katex }), false);
  assert.equal(latexMatchesReference("x_i^2", "x^2_i", false, katex), true);
  assert.equal(latexMatchesReference("x ", "x", false, katex), true);
  assert.equal(latexMatchesReference("x", "y", false, katex), false);
  assert.equal(latexMatchesReference(null, "x", false, katex), null);
  assert.equal(latexMatchesReference("x", "", false, katex), null);
});

test("glm omits thinking, other vision calls keep temperature 0 and thinking off", () => {
  const glmTarget = multimodalTarget(normalizeFormulaSettings({
    multimodal: { provider: "doubao", model: "glm-5.3-flash", apiKey: "present" }
  }));
  const glm = buildVisionRequest(glmTarget, {
    system: FORMULA_VISION_SYSTEM,
    text: "行内公式",
    images: [{ mime: "image/png", base64: PNG }],
    secret: "sk-glm-test"
  });
  assert.equal(glm.json.model, "glm-5.3-flash");
  assert.equal(glm.json.temperature, 0);
  assert.equal(Object.hasOwn(glm.json, "thinking"), false);
  assert.equal(glm.json.reasoning_effort, "low");
  assert.equal(JSON.stringify(glm.json).includes("sk-glm-test"), false);
  assert.match(glm.json.messages.at(-1).content[1].image_url.url, /^data:image\/png;base64,/);

  const deepTarget = multimodalTarget(normalizeFormulaSettings({
    multimodal: { provider: "deepseek", model: "deepseek-v4.1-flash", apiKey: "present" }
  }));
  const deep = buildVisionRequest(deepTarget, {
    system: FORMULA_VISION_SYSTEM,
    text: "独立公式",
    images: [{ mime: "image/png", base64: PNG }],
    secret: "sk-ds-test"
  });
  assert.equal(deep.json.temperature, 0);
  assert.deepEqual(deep.json.thinking, { type: "disabled" });
  assert.equal(JSON.stringify(deep.json).includes("sk-ds-test"), false);
});
