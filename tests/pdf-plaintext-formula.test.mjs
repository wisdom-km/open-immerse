import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { blockReadoutPlan, blockRenderPieces, blockTranslationIntegrity, displayCropWidthCss, displayInkMinEm, DISPLAY_CROP_MIN_HEIGHT_EM, DISPLAY_INK_PREFER } from "../lib/pdf-blocks.js";
import { applySavedPairs, blockSoftLead } from "../lib/pdf-library.js";
import { formatPlaintextRelation, plaintextRelationParts, plaintextRelationsIn } from "../lib/pdf-plaintext-formula.js";
import {
  FORMULA_INK_PAD_PX,
  inlineCropBoxEm,
  INLINE_INK_TARGET,
  isPlaintextFormulaSpan,
  measureFormulaCrop,
  nominalInlineInkShare,
  textLayerToBlocks
} from "../lib/pdf-text-layer.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function pdfItem(str, x, y, width = 120, height = 10, extra = {}) {
  return { str, transform: [1, 0, 0, 1, x, y], width, height, ...extra };
}

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

function pageFrom(items) {
  return textLayerToBlocks({ items, viewport: unitViewport(612, 792), page: 3 });
}

test("simple relations stay Unicode and do not allocate a formula crop", () => {
  assert.deepEqual(plaintextRelationParts("N=6"), { base: "N", sub: "", num: "6" });
  assert.deepEqual(plaintextRelationParts("P_{drop}=0.1"), { base: "P", sub: "drop", num: "0.1" });
  assert.equal(plaintextRelationParts("d_{model}=512"), null);
  assert.equal(plaintextRelationParts("d_k=64"), null);
  assert.equal(plaintextRelationParts("1/√d_k"), null);
  assert.equal(formatPlaintextRelation(plaintextRelationParts("h=8")), "h = 8");

  const page = pageFrom([
    pdfItem("The encoder is a stack of ", 72, 520, 150, 10),
    pdfItem("N", 224, 520, 10, 10, { fontName: "CMMI10" }),
    pdfItem("=", 238, 520, 8, 10),
    pdfItem("6", 250, 520, 8, 10),
    pdfItem(" layers with ", 262, 520, 70, 10),
    pdfItem("h", 334, 520, 8, 10, { fontName: "CMMI10" }),
    pdfItem("=", 346, 520, 8, 10),
    pdfItem("8", 358, 520, 8, 10),
    pdfItem(" heads.", 370, 520, 40, 10),
    pdfItem("Dropout is ", 72, 500, 60, 10),
    pdfItem("P", 134, 500, 9, 10, { fontName: "CMMI10" }),
    pdfItem("drop", 143, 496, 22, 7),
    pdfItem("=", 168, 500, 8, 10),
    pdfItem("0.1", 180, 500, 18, 10),
    pdfItem(" and ", 202, 500, 28, 10),
    pdfItem("ε", 232, 500, 8, 10, { fontName: "CMMI10" }),
    pdfItem("ls", 240, 496, 12, 7),
    pdfItem("=", 256, 500, 8, 10),
    pdfItem("0.1", 268, 500, 18, 10),
    pdfItem(".", 288, 500, 4, 10)
  ]);
  const formulas = page.blocks.filter((block) => block.label === "formula");
  assert.equal(formulas.length, 0);
  const text = page.blocks.map((block) => block.text || "").join(" ");
  assert.match(text, /N = 6/);
  assert.match(text, /h = 8/);
  assert.match(text, /P_drop = 0\.1/);
  assert.match(text, /ε_ls = 0\.1/);
  assert.doesNotMatch(text, /⟦f\d+⟧/);
  assert.equal(page.blocks.some((block) => block.placeholders?.length), false);
});

test("subscript dimensions, roots, and sums stay pageRaster crops", () => {
  const page = pageFrom([
    pdfItem("The width is ", 72, 520, 70, 10),
    pdfItem("d", 144, 520, 8, 10, { fontName: "CMMI10" }),
    pdfItem("model", 152, 516, 24, 7),
    pdfItem("=", 180, 520, 8, 10),
    pdfItem("512", 192, 520, 20, 10),
    pdfItem(" and ", 216, 520, 28, 10),
    pdfItem("√", 246, 520, 10, 12),
    pdfItem("1", 256, 528, 6, 7),
    pdfItem("d", 256, 512, 6, 7),
    pdfItem("k", 262, 510, 5, 6),
    pdfItem(" in the scaled product.", 272, 520, 110, 10)
  ]);
  const formulas = page.blocks.filter((block) => block.label === "formula");
  assert.ok(formulas.length >= 2);
  assert.equal(formulas.every((block) => block.display === false && block.inlineOf), true);
  const sentence = page.blocks.find((block) => /width is/.test(block.text || ""));
  assert.match(sentence.text, /⟦f\d+⟧/);
  assert.doesNotMatch(sentence.text, /d_model = 512/);
  assert.equal(isPlaintextFormulaSpan([
    { str: "√", x: 0, y: 10, width: 8, height: 12 },
    { str: "1", x: 8, y: 18, width: 4, height: 6 },
    { str: "d_k", x: 8, y: 4, width: 12, height: 6 }
  ]), false);
  const sum = pageFrom([
    pdfItem("∑", 200, 400, 14, 16, { fontName: "CMSY10" }),
    pdfItem("i", 216, 406, 6, 7),
    pdfItem("=", 226, 400, 8, 10),
    pdfItem("1", 238, 400, 8, 10),
    pdfItem("n", 250, 396, 6, 7)
  ]);
  const sumCrop = sum.blocks.filter((block) => block.label === "formula");
  assert.equal(sumCrop.length, 1);
  assert.equal(blockReadoutPlan(sumCrop[0]).role, "formula-display");
});

test("MultiHead, positional encoding, and equation 3 stay formula-display", () => {
  const multi = pageFrom([
    pdfItem("MultiHead(", 150, 420, 70, 11),
    pdfItem("Q, K, V", 222, 420, 40, 11, { fontName: "CMMI10" }),
    pdfItem(") = Concat(head", 264, 420, 90, 11),
    pdfItem("1", 356, 426, 6, 7),
    pdfItem(")W", 366, 420, 16, 11, { fontName: "CMMI10" }),
    pdfItem("O", 384, 428, 8, 7),
    pdfItem("(2)", 500, 420, 16, 10)
  ]);
  const multiCrops = multi.blocks.filter((block) => block.label === "formula");
  assert.equal(multiCrops.length, 1);
  assert.equal(multiCrops[0].display, true);
  assert.equal(multiCrops[0].inlineOf, undefined);
  assert.equal(blockReadoutPlan(multiCrops[0]).role, "formula-display");
  assert.equal(multi.blocks.some((block) => block.label === "text" && /MultiHead|Concat/.test(block.text || "")), false);

  const eq3 = pageFrom([
    pdfItem("where ", 108, 380, 36, 10),
    pdfItem("head", 146, 360, 28, 10),
    pdfItem("i", 176, 366, 6, 7),
    pdfItem("= Attention(", 186, 360, 78, 10),
    pdfItem("QW", 266, 360, 18, 10, { fontName: "CMMI10" }),
    pdfItem("Q", 286, 368, 8, 7),
    pdfItem(")", 300, 360, 6, 10),
    pdfItem("(3)", 500, 360, 18, 10)
  ]);
  const eq3Crops = eq3.blocks.filter((block) => block.label === "formula" && block.display === true);
  assert.equal(eq3Crops.length, 1);
  assert.equal(eq3Crops[0].inlineOf, undefined);
  assert.equal(blockReadoutPlan(eq3Crops[0]).role, "formula-display");
  assert.equal(eq3.blocks.some((block) => block.inlineOf), false);

  const pe = pageFrom([
    pdfItem("PE", 180, 300, 16, 10, { fontName: "CMMI10" }),
    pdfItem("(pos, 2i)", 198, 300, 48, 10, { fontName: "CMMI10" }),
    pdfItem("= sin(", 250, 300, 36, 10),
    pdfItem("pos", 288, 300, 20, 10, { fontName: "CMMI10" }),
    pdfItem("/10000", 310, 300, 40, 10),
    pdfItem(")", 352, 300, 6, 10),
    pdfItem("(4)", 500, 300, 16, 10)
  ]);
  const peCrops = pe.blocks.filter((block) => block.label === "formula");
  assert.equal(peCrops.length, 1);
  assert.equal(peCrops[0].display, true);
  assert.equal(blockReadoutPlan(peCrops[0]).role, "formula-display");
  assert.equal(pe.blocks.some((block) => /sin|10000/.test(block.text || "")), false);
});

test("inline box height is ink divided by pad share, not a taller fixed em", () => {
  const share = nominalInlineInkShare();
  assert.equal(FORMULA_INK_PAD_PX.inline, 4);
  assert.ok(Math.abs(share - 16 / (16 + 8)) < 1e-12);
  const box = inlineCropBoxEm(share);
  const ink = box * share;
  assert.ok(ink >= 1.05 && ink <= 1.15, `ink ${ink}`);
  assert.ok(Math.abs(ink - INLINE_INK_TARGET) < 1e-9);
  assert.ok(box >= 1.55 && box <= 1.8, `box ${box}`);
  assert.ok(1.22 * share < 1, "the old 1.22em box leaves ink under the body");
  assert.notEqual(box, 1.22);
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.match(css, new RegExp(`--oi-pdf-inline-crop-em, ${box}em`));
  assert.match(viewer, /inlineCropBoxEm\(formula\?\.inkShare\)/);
  assert.match(viewer, /displayInkMinEm\(block\.inkShare\)/);
  assert.equal(displayInkMinEm(undefined), DISPLAY_CROP_MIN_HEIGHT_EM);
  const short = displayInkMinEm(0.5);
  assert.ok(short * 0.5 >= DISPLAY_INK_PREFER - 1e-9);
  assert.ok(short > DISPLAY_CROP_MIN_HEIGHT_EM);
  assert.match(displayCropWidthCss(0.48, 0.04, short), new RegExp(`${short}em`));
  assert.match(displayCropWidthCss(0.48, 0.04), /2em \* var\(--oi-pdf-paper-w, 0px\)/);

  const width = 80;
  const height = 40;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let y = 12; y < 28; y += 1) {
    for (let x = 10; x < 40; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  }
  const measured = measureFormulaCrop([0, 0, 1, 1], { data, width, height }, { inline: true });
  assert.ok(measured.inkShare > 0 && measured.inkShare < 1);
  const measuredBox = inlineCropBoxEm(measured.inkShare);
  assert.ok(measuredBox * measured.inkShare >= 1.05 - 1e-9);
  assert.ok(measuredBox * measured.inkShare <= 1.15 + 1e-9);
});

test("retired simple placeholders remap to Unicode instead of dumping English", () => {
  const library = readFileSync(join(root, "lib/pdf-library.js"), "utf8");
  assert.match(library, /（译文中的公式或引用与原文不符，以下为原文）/);
  assert.match(library, /（旧译文未沿用。以下为文字层原文）/);
  assert.match(library, /（译文待核对，以下为原文）/);

  const block = {
    text: "The encoder is a stack of N = 6 identical layers.",
    sourceText: "The encoder is a stack of N = 6 identical layers.",
    translation: "编码器由 ⟦f1⟧ 层相同的层堆叠而成。",
    translationStatus: "verified"
  };
  assert.equal(blockTranslationIntegrity(block).valid, true);
  assert.equal(blockSoftLead(block), "");
  const pieces = blockRenderPieces(block, []);
  const rendered = pieces.map((piece) => piece.text || "").join("");
  assert.match(rendered, /编码器由 N = 6/);
  assert.doesNotMatch(rendered, /identical layers/);
  assert.equal(pieces.some((piece) => piece.type === "image"), false);

  const restored = applySavedPairs([{
    id: "p3",
    sourceId: "p3-n",
    label: "text",
    text: block.text,
    sourceText: block.sourceText
  }], [{
    sourceId: "p3-n",
    text: block.text,
    translation: block.translation,
    status: "verified"
  }]);
  assert.match(restored[0].translation, /N = 6/);
  assert.doesNotMatch(restored[0].translation, /⟦f/);
  assert.deepEqual(plaintextRelationsIn(block.text), ["N = 6"]);

  const real = {
    text: "Where the projections are parameter matrices ⟦f1⟧ and ⟦f2⟧.",
    sourceText: "Where the projections are parameter matrices W and W.",
    translation: "其中这些投影是参数矩阵。",
    placeholders: [
      { token: "⟦f1⟧", blockId: "f1" },
      { token: "⟦f2⟧", blockId: "f2" }
    ]
  };
  assert.equal(blockTranslationIntegrity(real).reason, "formula-placeholder-mismatch");
  assert.match(blockSoftLead(real), /公式或引用与原文不符/);
  const fallen = blockRenderPieces(real, [real, { id: "f1", label: "formula" }, { id: "f2", label: "formula" }]);
  assert.match(fallen.map((piece) => piece.text || "").join(""), /^Where the projections/);
});
