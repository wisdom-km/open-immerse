import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDF_MIRROR_OPS } from "../lib/pdf-mirror.js";
import {
  FORMULA_CROP_PAD,
  FORMULA_INK_PAD_PX,
  FORMULA_PAD_LIMIT,
  FORMULA_PAPER_MIN,
  contentAwareFormulaBbox,
  formulaGlyphsRedrawSafe,
  textLayerToBlocks,
  trimFormulaBboxToInk
} from "../lib/pdf-text-layer.js";
import { isTranslatableBlock } from "../lib/pdf-blocks.js";
import { segmentPageBlocks } from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

test("a tiny math-font glyph stays in the trusted text instead of making a fragment crop", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("The value is ", 72, 700, 70, 10),
      pdfItem("n", 150, 700, 8, 10, { fontName: "CMMI10" }),
      pdfItem(" here.", 162, 700, 36, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 1
  });
  const sentence = page.blocks.find((block) => block.label === "text" && /The value is n here\./.test(block.text || ""));
  assert.ok(sentence);
  assert.equal(page.blocks.some((block) => block.label === "formula"), false);
});

test("body citations and a base with subscript stay in one source sentence", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("Recurrent networks [", 72, 603.5, 90),
      pdfItem("13", 162, 603.5, 10),
      pdfItem("] and gated recurrent [", 172, 603.5, 110),
      pdfItem("7", 282, 603.5, 5),
      pdfItem("] produce states ", 287, 603.5, 76),
      pdfItem("h", 363, 603.5, 6),
      pdfItem("t", 369, 602, 3, 7),
      pdfItem(" from ", 373, 603.5, 24),
      pdfItem("h", 397, 603.5, 6),
      pdfItem("t", 403, 602, 3, 7),
      pdfItem("−", 406, 602, 6, 7),
      pdfItem("1", 412, 602, 4, 7),
      pdfItem(".", 416, 603.5, 3)
    ],
    viewport: unitViewport(612, 792),
    page: 2
  });
  const text = page.blocks.filter((block) => block.label === "text").map((block) => block.text).join(" ");
  assert.match(text, /\[13\].*\[7\]/);
  assert.match(text, /h_t.*h_\{t−1\}/);
  assert.equal(page.blocks.some((block) => block.label === "formula"), false);
});

test("a fraction beside softmax is cropped with the full display equation", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("Attention(", 220, 311, 46),
      pdfItem("Q, K, V", 266, 311, 31),
      pdfItem(") = softmax(", 299, 311, 55),
      pdfItem("QK", 355, 318, 16),
      pdfItem("T", 372, 322, 5, 7),
      pdfItem("√", 358, 311, 8),
      pdfItem("d", 366, 304, 5),
      pdfItem("k", 371, 302, 4, 7),
      pdfItem(")V", 380, 311, 10),
      pdfItem("(1)", 493, 311, 12)
    ],
    viewport: unitViewport(612, 792),
    page: 4
  });
  const formulas = page.blocks.filter((block) => block.label === "formula");
  assert.equal(formulas.length, 1);
  assert.ok(formulas[0].bbox[0] <= 220 / 612 - FORMULA_CROP_PAD.displayX);
  assert.ok(formulas[0].bbox[2] >= 505 / 612 + FORMULA_CROP_PAD.displayX);
  const glyphTop = (792 - 329) / 792;
  assert.ok(formulas[0].bbox[1] <= glyphTop - FORMULA_CROP_PAD.displayY);
  assert.equal(Object.hasOwn(formulas[0], "text"), false);
  assert.equal(Object.hasOwn(formulas[0], "latex"), false);
  assert.equal(Object.hasOwn(formulas[0], "content"), false);
  assert.equal(formulas[0].display, true);
  assert.equal(formulas[0].formulaInkProtect, true);
  assert.equal(page.blocks.some((block) => /softmax/.test(block.text || "")), false);
});

test("indented positional encoding equation stays one source crop", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("PE", 234, 456, 14),
      pdfItem("(", 248, 456, 4),
      pdfItem("pos, 2i", 252, 456, 34, 10, { fontName: "CMMI10" }),
      pdfItem(") = sin(", 286, 456, 36),
      pdfItem("pos", 322, 456, 17, 10, { fontName: "CMMI10" }),
      pdfItem("/10000", 339, 456, 35),
      pdfItem("2i/dmodel", 374, 456, 42, 10, { fontName: "CMMI10" }),
      pdfItem(")", 416, 456, 4),
      pdfItem("(4)", 492, 456, 13)
    ],
    viewport: unitViewport(612, 792),
    page: 6
  });
  const formulas = page.blocks.filter((block) => block.label === "formula");
  assert.equal(formulas.length, 1);
  assert.ok(formulas[0].bbox[0] <= 234 / 612);
  assert.ok(formulas[0].bbox[2] >= 505 / 612);
  assert.equal(page.blocks.some((block) => /sin|dmodel/.test(block.text || "")), false);
});

test("a display line of softmax plus math letters is one crop", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("softmax", 72, 500, 52, 10),
      pdfItem("(", 126, 500, 6, 10),
      pdfItem("Q", 134, 500, 10, 10, { fontName: "CMMI10" }),
      pdfItem(")", 146, 500, 6, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 1
  });
  const formula = page.blocks.filter((block) => block.label === "formula");
  assert.equal(formula.length, 1);
  assert.equal(formula[0].inlineOf, undefined);
  assert.equal(page.blocks.some((block) => /softmax/.test(block.text || "")), false);
});

test("a pure formula line is one formula block without text", () => {
  const page = textLayerToBlocks({
    items: [pdfItem("softmax(QK^T)", 96, 640, 180, 12, { fontName: "CMMI10" })],
    viewport: unitViewport(612, 792),
    page: 2
  });
  assert.equal(page.blocks.length, 1);
  assert.equal(page.blocks[0].label, "formula");
  assert.equal(Object.hasOwn(page.blocks[0], "text"), false);
  assert.equal(page.blocks[0].inlineOf, undefined);
  assert.ok(page.blocks[0].bbox[2] > page.blocks[0].bbox[0]);
});

test("author blocks are not translated", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("Attention Is All You Need", 96, 730, 420, 20),
      pdfItem("Ashish Vaswani", 72, 690, 90, 10),
      pdfItem("Noam Shazeer", 198, 690, 86, 10),
      pdfItem("Google Brain", 72, 676, 72, 9),
      pdfItem("avaswani@google.com", 72, 662, 100, 8),
      pdfItem("Abstract", 72, 548, 70, 12, { fontName: "Helvetica-Bold" }),
      pdfItem("The dominant sequence transduction models are based on", 72, 528, 230, 10),
      pdfItem("complex recurrent or convolutional neural networks.", 72, 514, 210, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 1
  });
  const authors = page.blocks.filter((block) => block.presentation === "byline");
  assert.equal(authors.length, 2);
  assert.equal(authors[0].skipTranslate, true);
  assert.equal(authors[0].text, "Ashish Vaswani");
  assert.equal(authors[0].authorCell.affiliation, "Google Brain");
  assert.equal(authors[0].authorCell.email, "avaswani@google.com");
  assert.equal(authors[1].authorCell.name, "Noam Shazeer");
  assert.equal(authors[1].authorCell.affiliation, undefined);
  assert.equal(authors.every((block) => block.label === "text"), true);
  assert.equal(authors.some((block) => block.flatAuthor), false);
});

test("a single full-width author band stays one flat byline", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("Attention Is All You Need", 96, 730, 420, 20),
      pdfItem("Ashish Vaswani Noam Shazeer", 72, 690, 400, 10),
      pdfItem("Google Brain Google Research", 72, 676, 400, 9),
      pdfItem("avaswani@google.com noam@google.com", 72, 662, 400, 8),
      pdfItem("Abstract", 72, 548, 70, 12, { fontName: "Helvetica-Bold" }),
      pdfItem("The dominant sequence transduction models are based on complex recurrent networks.", 72, 528, 420, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 1
  });
  const authors = page.blocks.filter((block) => block.presentation === "byline");
  assert.equal(authors.length, 1);
  assert.equal(authors[0].flatAuthor, true);
  assert.equal(authors[0].authorCell, undefined);
  assert.match(authors[0].text, /Ashish Vaswani/);
  assert.match(authors[0].text, /Noam Shazeer/);
});

test("arXiv footer stays out of the text-layer page", () => {
  const spine = [..."arXiv:1706.03762"].map((ch, index) => pdfItem(ch, 10, 720 - index * 12, 8, 9));
  const page = textLayerToBlocks({
    items: [
      pdfItem("Provided proper attribution is provided, this paper", 72, 770, 400, 8),
      ...spine,
      pdfItem("Attention Is All You Need", 96, 730, 420, 20),
      pdfItem("The dominant sequence transduction models are based on complex recurrent networks.", 72, 640, 460, 10),
      pdfItem("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023", 72, 18, 260, 8)
    ],
    viewport: unitViewport(612, 792),
    page: 1
  });
  assert.equal(page.blocks.some((block) => /arXiv:1706/.test(block.text || "")), false);
  assert.equal(page.blocks.some((block) => /proper attribution/i.test(block.text || "")), false);
  assert.ok(page.blocks.some((block) => block.text === "Attention Is All You Need"));
});

test("image CTM sample becomes the architecture bbox", () => {
  const page = textLayerToBlocks({
    items: [pdfItem("Figure 1: The Transformer architecture.", 72, 300, 280, 10)],
    viewport: unitViewport(612, 792),
    images: {
      fnArray: [
        PDF_MIRROR_OPS.save,
        PDF_MIRROR_OPS.transform,
        PDF_MIRROR_OPS.paintImageXObject,
        PDF_MIRROR_OPS.restore
      ],
      argsArray: [[], [100, 0, 0, 80, 72, 400], ["img_p0_1"], []]
    },
    page: 1
  });
  const figure = page.blocks.find((block) => block.label === "figure");
  assert.ok(figure);
  const expected = [72 / 612, 312 / 792, 172 / 612, 392 / 792];
  figure.bbox.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) < 1e-9);
  });
  const caption = page.blocks.find((block) => block.label === "caption");
  assert.equal(caption.captionFor, figure.id);
});

test("an untrusted text layer keeps the image crop and drops invented prose", () => {
  const page = textLayerToBlocks({
    items: [{ str: "\uFFFD".repeat(24), transform: [1, 0, 0, 1, 72, 700], width: 120, height: 10 }],
    viewport: unitViewport(612, 792),
    images: {
      fnArray: [
        PDF_MIRROR_OPS.save,
        PDF_MIRROR_OPS.transform,
        PDF_MIRROR_OPS.paintImageXObject,
        PDF_MIRROR_OPS.restore
      ],
      argsArray: [[], [100, 0, 0, 80, 72, 400], ["img_p0_1"], []]
    },
    page: 1
  });
  assert.equal(page.textSource, "ocr");
  assert.equal(page.blocks.some((block) => block.label === "text" || block.label === "title" || block.label === "caption"), false);
  const figure = page.blocks.find((block) => block.label === "figure");
  assert.ok(figure);
  assert.equal(Object.hasOwn(figure, "text"), false);
});

test("a scripted membership line is cropped instead of spelling formula letters", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("Where the projections are parameter matrices", 107.5, 578.7, 176.2, 10),
      pdfItem("W", 285.9, 578.7, 9.4, 10),
      pdfItem("i", 295.3, 575.9, 2.8, 7),
      pdfItem("Q", 296.7, 583.5, 6.3, 7),
      pdfItem("∈", 306.2, 578.7, 6.6, 10),
      pdfItem("R", 315.6, 578.7, 7.2, 10),
      pdfItem("d", 322.8, 582.3, 4.2, 7),
      pdfItem("model", 327, 581.3, 12.4, 5),
      pdfItem("×", 339.9, 582.3, 6.2, 7),
      pdfItem("d", 346.2, 582.3, 4.2, 7),
      pdfItem("k", 350.3, 581.3, 3.8, 5),
      pdfItem("and", 108, 566.5, 14.4, 10),
      pdfItem("W", 124.9, 566.5, 9.4, 10),
      pdfItem("O", 135.7, 570.1, 6.1, 7),
      pdfItem("∈", 145.2, 566.5, 6.6, 10),
      pdfItem("R", 154.6, 566.5, 7.2, 10),
      pdfItem(".", 163, 566.5, 2.5, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 5
  });
  const sentence = page.blocks.find((block) => /Where the projections/.test(block.text || ""));
  assert.ok(sentence);
  assert.match(sentence.text, /parameter matrices ⟦f\d+⟧ and ⟦f\d+⟧\./);
  assert.doesNotMatch(sentence.text, /W_iQ|dmodel|Rdmodel/);
  assert.equal(sentence.placeholders.length, 2);
  assert.equal(sentence.skipTranslate, undefined);
  assert.equal(isTranslatableBlock(sentence), true);
  const crops = sentence.placeholders.map((entry) => page.blocks.find((block) => block.id === entry.blockId));
  assert.equal(crops.every((block) => block?.label === "formula" && !Object.hasOwn(block, "text")), true);
  const superscriptTop = (792 - (583.5 + 7)) / 792;
  assert.ok(crops[0].bbox[1] <= superscriptTop - FORMULA_CROP_PAD.inlineY + 0.002);
  assert.ok(crops[0].bbox[0] <= 285.9 / 612);
  assert.ok(crops[0].bbox[2] >= (350.3 + 3.8) / 612);
  assert.equal(crops.every((block) => block.display === false && block.inlineOf === sentence.id), true);
  const proseTop = (792 - (578.7 + 10)) / 792;
  const proseBottom = (792 - 578.7) / 792;
  const proseBox = [107.5 / 612, proseTop, (107.5 + 176.2) / 612, proseBottom];
  const hitW = Math.min(crops[1].bbox[2], proseBox[2]) - Math.max(crops[1].bbox[0], proseBox[0]);
  const hitH = Math.min(crops[1].bbox[3], proseBox[3]) - Math.max(crops[1].bbox[1], proseBox[1]);
  assert.ok(!(hitW > 0.01 && hitH > 0.003), `second crop swallowed the line above (${hitW}, ${hitH})`);
  assert.ok(crops[1].bbox[0] > 110 / 612, "the second crop must not swallow the line above");
});

test("reference entries keep column order and stay out of translation", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("References", 108, 400, 70, 12, { fontName: "Helvetica-Bold" }),
      pdfItem("[16]", 108, 339.5, 18, 10),
      pdfItem("Kaiser and Bengio. Can active memory replace attention? In", 129.6, 339.5, 280, 10),
      pdfItem("Advances in Neural", 426.9, 339.5, 70, 10),
      pdfItem("Information Processing Systems, (NIPS)", 129.4, 328.6, 160, 10),
      pdfItem(", 2016.", 290, 328.6, 36, 10),
      pdfItem("[17]", 108, 308.8, 18, 10),
      pdfItem("Kaiser and Sutskever. Neural GPUs learn algorithms. In", 129.6, 308.8, 260, 10),
      pdfItem("International Conference", 404.2, 308.8, 90, 10),
      pdfItem("on Learning Representations (ICLR), 2016.", 129.6, 297.9, 180, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 11
  });
  const refs = page.blocks.filter((block) => /^\[\d+\]/.test(block.text || ""));
  assert.deepEqual(refs.map((block) => block.text.slice(0, 4)), ["[16]", "[17]"]);
  assert.match(refs[0].text, /In Advances in Neural Information Processing Systems, \(NIPS\), 2016\./);
  assert.doesNotMatch(refs[0].text, /Information Processing Systems, \(NIPS\)Kaiser/);
  assert.match(refs[1].text, /In International Conference on Learning Representations/);
  assert.equal(refs.every((block) => block.skipTranslate === true), true);
  assert.equal(page.blocks.some((block) => /softmax|W_iQ/.test(block.text || "")), false);
});

test("content-aware pad stops at a figure and the next line", () => {
  const glyph = [0.35, 0.58, 0.8, 0.61];
  const figure = [0.2, 0.08, 0.78, 0.575];
  const nextLine = [0.17, 0.612, 0.84, 0.635];
  const prose = [0.17, 0.585, 0.34, 0.608];
  const box = contentAwareFormulaBbox(glyph, { x: 0.02, y: 0.02 }, [figure, nextLine, prose]);
  assert.ok(box[1] >= figure[3], "crop top stays below the figure");
  assert.ok(box[3] <= nextLine[1], "crop bottom stays above the next line");
  assert.ok(box[0] >= prose[2], "crop left stays clear of same-line prose");
  assert.ok(box[0] <= glyph[0] && box[2] >= glyph[2] && box[1] <= glyph[1] && box[3] >= glyph[3]);
});

test("a hairline font-box overlap does not pad into the next line", () => {
  const glyph = [0.4, 0.7, 0.48, 0.742];
  const next = [0.16, 0.74, 0.55, 0.756];
  const box = contentAwareFormulaBbox(glyph, { x: 0.02, y: 0.02 }, [next]);
  assert.ok(box[3] <= glyph[3] + 1e-6);
  assert.ok(box[3] < (next[1] + next[3]) / 2);
  assert.ok(box[0] <= glyph[0] && box[2] >= glyph[2] && box[1] <= glyph[1]);
});

test("relaxed softmax pad still stops before Fig.2", () => {
  const glyph = [0.36, 0.60, 0.82, 0.645];
  const figure = [0.18, 0.08, 0.80, 0.597];
  const caption = [0.18, 0.568, 0.70, 0.594];
  const nextLine = [0.16, 0.652, 0.86, 0.678];
  const pad = {
    x: Math.min(FORMULA_PAD_LIMIT.x, FORMULA_CROP_PAD.displayX + FORMULA_CROP_PAD.scriptX),
    y: Math.min(FORMULA_PAD_LIMIT.y, FORMULA_CROP_PAD.displayY + FORMULA_CROP_PAD.scriptY)
  };
  assert.ok(glyph[1] - pad.y < figure[3], "unstopped pad would enter Fig.2");
  const box = contentAwareFormulaBbox(glyph, pad, [figure, caption, nextLine]);
  const overlaps = (a, b) => Math.min(a[3], b[3]) > Math.max(a[1], b[1]) &&
    Math.min(a[2], b[2]) > Math.max(a[0], b[0]);
  assert.equal(overlaps(box, figure), false);
  assert.equal(overlaps(box, caption), false);
  assert.ok(box[3] <= nextLine[1] + 1e-9);
  assert.ok(box[0] <= glyph[0] && box[2] >= glyph[2] && box[1] <= glyph[1] && box[3] >= glyph[3]);

  const width = 1000;
  const height = 1000;
  const image = paperRaster(width, height, (x, y) => {
    const nx = x / width;
    const ny = y / height;
    if (ny < figure[3] && ny >= figure[1] && nx >= figure[0] && nx < figure[2]) return [0, 0, 0, 255];
    if (nx >= 0.40 && nx <= 0.78 && ny >= 0.61 && ny <= 0.63) return [0, 0, 0, 255];
    return null;
  });
  const trimmed = trimFormulaBboxToInk(box, image, { inline: false, protect: true });
  assert.equal(overlaps(trimmed, figure), false);
  assert.equal(overlaps(trimmed, caption), false);
  assert.ok(trimmed[1] >= box[1] - 1e-9 && trimmed[3] <= box[3] + 1e-9);
  assert.ok(trimmed[0] >= box[0] - 1e-9 && trimmed[2] <= box[2] + 1e-9);
  const inkTop = 610;
  const trimmedTop = Math.round(trimmed[1] * height);
  assert.equal(inkTop - trimmedTop, FORMULA_INK_PAD_PX.displayProtect);
});

test("a display formula does not swallow the figure caption above it", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("Figure 2: (left) Scaled Dot-Product Attention.", 72, 440, 320, 9),
      pdfItem("Attention(", 220, 420, 52, 10),
      pdfItem("Q, K, V", 274, 420, 36, 10, { fontName: "CMMI10" }),
      pdfItem(") = softmax(", 312, 420, 64, 10),
      pdfItem("QK", 378, 424, 14, 8, { fontName: "CMMI10" }),
      pdfItem("T", 392, 430, 6, 7),
      pdfItem("(1)", 500, 420, 16, 10)
    ],
    viewport: unitViewport(612, 792),
    images: {
      fnArray: [
        PDF_MIRROR_OPS.save,
        PDF_MIRROR_OPS.transform,
        PDF_MIRROR_OPS.paintImageXObject,
        PDF_MIRROR_OPS.restore
      ],
      argsArray: [[], [220, 0, 0, 80, 140, 460], ["img_p4"], []]
    },
    page: 4
  });
  const figure = page.blocks.find((block) => block.label === "figure");
  const formula = page.blocks.find((block) => block.label === "formula" && block.display === true);
  const caption = page.blocks.find((block) => block.label === "caption");
  assert.ok(figure);
  assert.ok(formula);
  assert.ok(caption);
  assert.match(caption.text, /Figure 2:/);
  const overlap = (a, b) => Math.min(a[3], b[3]) > Math.max(a[1], b[1]) && Math.min(a[2], b[2]) > Math.max(a[0], b[0]);
  assert.equal(overlap(formula.bbox, figure.bbox), false);
  assert.equal(overlap(formula.bbox, caption.bbox), false);
  assert.equal(Object.hasOwn(formula, "text"), false);
  assert.equal(Object.hasOwn(formula, "latex"), false);
});

test("a wrapped left-margin equation stays inline in the sentence", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("The dimensionality of input and output is ", 72, 500, 210, 10),
      pdfItem("d_{model}", 284, 500, 48, 10, { fontName: "CMMI10" }),
      pdfItem(" = 512, and the inner-layer has dimensionality", 334, 500, 180, 10),
      pdfItem("d_{ff}", 72, 486, 24, 10, { fontName: "CMMI10" }),
      pdfItem("= 2048.", 100, 486, 48, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 5
  });
  assert.equal(page.blocks.some((block) => block.label === "formula" && block.display === true), false);
  const sentence = page.blocks.find((block) => /dimensionality of input/.test(block.text || ""));
  assert.ok(sentence);
  assert.match(sentence.text, /⟦f\d+⟧/);
  const inline = page.blocks.filter((block) => block.label === "formula");
  assert.ok(inline.length >= 1);
  assert.equal(inline.every((block) => block.display === false && block.inlineOf === sentence.id), true);
});

test("formula redraw is limited to formula fonts without extending operators", () => {
  assert.equal(formulaGlyphsRedrawSafe([
    { str: "W", fontName: "CMMI10" },
    { str: "i", fontName: "CMMI7" }
  ]), true);
  assert.equal(formulaGlyphsRedrawSafe([{ str: "√", fontName: "CMSY10" }]), false);
  assert.equal(formulaGlyphsRedrawSafe([{ str: "softmax(", fontName: "CMR10" }]), false);
  assert.equal(formulaGlyphsRedrawSafe([{ str: "n", fontName: "Times" }]), false);
});

test("an indented sentence that contains an equals sign stays inline", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("The width of each layer is ", 160, 520, 140, 10),
      pdfItem("d", 302, 520, 8, 10, { fontName: "CMMI10" }),
      pdfItem("model", 310, 517, 24, 7),
      pdfItem("=", 338, 520, 8, 10),
      pdfItem("512", 348, 520, 18, 10),
      pdfItem(" for this encoder.", 368, 520, 90, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 3
  });
  assert.equal(page.blocks.some((block) => block.label === "formula" && block.display === true), false);
  const sentence = page.blocks.find((block) => /width of each layer/.test(block.text || ""));
  assert.ok(sentence);
  assert.match(sentence.text, /⟦f\d+⟧/);
  assert.match(sentence.text, /for this encoder/);
  const inline = page.blocks.filter((block) => block.label === "formula");
  assert.equal(inline.length, 1);
  assert.equal(inline[0].display, false);
  assert.equal(inline[0].inlineOf, sentence.id);
});

test("a short equation wrapped at the paragraph indent stays inline", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("The dimensionality of the inner layer is fixed at", 150, 500, 250, 10),
      pdfItem("d_{ff}", 150, 486, 28, 10, { fontName: "CMMI10" }),
      pdfItem("= 2048.", 182, 486, 48, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 5
  });
  assert.equal(page.blocks.some((block) => block.label === "formula" && block.display === true), false);
  const sentence = page.blocks.find((block) => /dimensionality of the inner layer/.test(block.text || ""));
  assert.ok(sentence);
  assert.match(sentence.text, /⟦f\d+⟧/);
  const inline = page.blocks.filter((block) => block.label === "formula");
  assert.ok(inline.length >= 1);
  assert.equal(inline.every((block) => block.display === false && block.inlineOf === sentence.id), true);
});

test("an indented numbered equation with a roman identifier stays display", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("We varied the learning rate according to the formula.", 108, 200, 280, 10),
      pdfItem("lrate", 180, 165, 28, 10, { fontName: "CMMI10" }),
      pdfItem("=", 212, 165, 8, 10),
      pdfItem("d", 224, 165, 8, 10, { fontName: "CMMI10" }),
      pdfItem("model", 232, 160, 24, 7),
      pdfItem("min(step", 260, 165, 40, 10),
      pdfItem("num", 302, 165, 18, 10),
      pdfItem(")", 360, 165, 6, 10),
      pdfItem("(3)", 493, 165, 16, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 7
  });
  const display = page.blocks.filter((block) => block.label === "formula" && block.display === true);
  assert.equal(display.length, 1);
  assert.equal(display[0].inlineOf, undefined);
  assert.equal(page.blocks.some((block) => /lrate|model|step/.test(block.text || "")), false);
  assert.ok(page.blocks.some((block) => /learning rate according/.test(block.text || "")));
});

test("a centered numbered equation after a sentence stays display", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("The learning rate follows the formula.", 72, 520, 220, 10),
      pdfItem("lrate", 230, 490, 30, 10, { fontName: "CMMI10" }),
      pdfItem("=", 264, 490, 10, 10),
      pdfItem("min", 278, 490, 18, 10),
      pdfItem("(5)", 500, 490, 18, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 7
  });
  const display = page.blocks.filter((block) => block.label === "formula" && block.display === true);
  assert.equal(display.length, 1);
  assert.equal(display[0].inlineOf, undefined);
  assert.ok(page.blocks.some((block) => /learning rate follows/.test(block.text || "")));
  assert.equal(page.blocks.some((block) => /lrate|min/.test(block.text || "")), false);
});

function paperRaster(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = paint(x, y);
      if (!pixel) continue;
      const index = (y * width + x) * 4;
      data[index] = pixel[0];
      data[index + 1] = pixel[1];
      data[index + 2] = pixel[2];
      data[index + 3] = pixel.length > 3 ? pixel[3] : 255;
    }
  }
  return { data, width, height };
}

test("relaxed formula pads sit in the crop-relax band and stay under about 8 CSS px", () => {
  assert.equal(FORMULA_CROP_PAD.displayX, 0.0045);
  assert.equal(FORMULA_CROP_PAD.displayY, 0.0030);
  assert.equal(FORMULA_CROP_PAD.inlineX, 0.0020);
  assert.equal(FORMULA_CROP_PAD.inlineY, 0.0016);
  assert.equal(FORMULA_CROP_PAD.scriptX, 0.0012);
  assert.equal(FORMULA_CROP_PAD.scriptY, 0.0016);
  assert.equal(FORMULA_PAD_LIMIT.x, 0.0060);
  assert.equal(FORMULA_PAD_LIMIT.y, 0.0050);
  assert.equal(FORMULA_INK_PAD_PX.display, 6);
  assert.equal(FORMULA_INK_PAD_PX.displayProtect, 7);
  assert.equal(FORMULA_INK_PAD_PX.inline, 4);
  assert.equal(FORMULA_INK_PAD_PX.inlineProtect, 5);
  assert.equal(FORMULA_PAPER_MIN, 246);
  const cssX = FORMULA_PAD_LIMIT.x * 612 * 2;
  const cssY = FORMULA_PAD_LIMIT.y * 792 * 2;
  assert.ok(cssX > 6 && cssX < 8, `pad limit x ${cssX.toFixed(2)}`);
  assert.ok(cssY > 6 && cssY < 8, `pad limit y ${cssY.toFixed(2)}`);
  assert.ok(FORMULA_CROP_PAD.displayX < 0.008 && FORMULA_CROP_PAD.displayY < 0.01);
  assert.ok(FORMULA_CROP_PAD.inlineX < FORMULA_CROP_PAD.displayX);
  assert.ok(FORMULA_CROP_PAD.inlineY < FORMULA_CROP_PAD.displayY);
  assert.ok(FORMULA_CROP_PAD.displayX + FORMULA_CROP_PAD.scriptX <= FORMULA_PAD_LIMIT.x + 1e-9);
  assert.ok(FORMULA_CROP_PAD.displayY + FORMULA_CROP_PAD.scriptY <= FORMULA_PAD_LIMIT.y + 1e-9);
  assert.ok(FORMULA_INK_PAD_PX.inline < FORMULA_INK_PAD_PX.display);
  assert.ok(FORMULA_INK_PAD_PX.inlineProtect <= FORMULA_INK_PAD_PX.displayProtect);
  assert.ok(FORMULA_INK_PAD_PX.displayProtect < 8);
});

test("ink trim drops paper-white margin and keeps a gray subscript", () => {
  const width = 200;
  const height = 100;
  const bbox = [0.1, 0.2, 0.9, 0.8];
  const image = paperRaster(width, height, (x, y) => {
    if (y === 10) return [0, 0, 0, 255];
    if (x >= 40 && x <= 70 && y >= 35 && y <= 50) return [0, 0, 0, 255];
    if (x === 72 && y === 48) return [180, 180, 180, 255];
    if (x === 30 && y === 40) return [0, 0, 0, 0];
    return null;
  });
  const display = trimFormulaBboxToInk(bbox, image, { inline: false });
  const inline = trimFormulaBboxToInk(bbox, image, { inline: true });
  const protect = trimFormulaBboxToInk(bbox, image, { inline: false, protect: true });
  assert.deepEqual(display.map((value) => Number(value.toFixed(4))), [0.17, 0.29, 0.395, 0.57]);
  assert.deepEqual(inline.map((value) => Number(value.toFixed(4))), [0.18, 0.31, 0.385, 0.55]);
  assert.ok(protect[0] < display[0] && protect[2] > display[2]);
  assert.ok(display[1] > 0.2, "caption row above the box stays out");
  assert.ok(display[0] >= bbox[0] && display[2] <= bbox[2]);
  assert.ok(display[1] >= bbox[1] && display[3] <= bbox[3]);
  assert.ok(inline[2] - inline[0] < display[2] - display[0]);
});

test("ink trim fails closed when the raster has no ink", () => {
  const bbox = [0.2, 0.3, 0.6, 0.5];
  const blank = paperRaster(40, 40, () => null);
  assert.deepEqual(trimFormulaBboxToInk(bbox, blank), bbox);
  assert.deepEqual(trimFormulaBboxToInk(bbox, null), bbox);
  assert.equal(trimFormulaBboxToInk(null, blank), null);
});

test("ink trim keeps a readable crop when the ink itself is tiny", () => {
  const image = paperRaster(80, 40, (x, y) => (x === 40 && y === 20 ? [0, 0, 0, 255] : null));
  const box = trimFormulaBboxToInk([0, 0, 1, 1], image, { inline: false });
  const width = Math.round((box[2] - box[0]) * 80);
  const height = Math.round((box[3] - box[1]) * 40);
  assert.ok(width >= 24 && height >= 12, `${width}x${height}`);
  assert.ok(box[0] >= 0 && box[2] <= 1 && box[1] >= 0 && box[3] <= 1);
});

test("viewer trims formula ink and still falls back to the page raster crop", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const fn = viewer.slice(viewer.indexOf("function imageForVisualBlock"));
  const drawnAt = fn.indexOf("if (drawn) return drawn");
  const trimAt = fn.indexOf("formulaInkBbox");
  const cropAt = fn.indexOf("return cropBlockImage");
  assert.ok(drawnAt >= 0 && trimAt > drawnAt && cropAt > trimAt);
  assert.match(viewer, /trimFormulaBboxToInk/);
  assert.equal((viewer.match(/renderFormulaNode\s*\(/g) || []).length, 1);
});

test("paragraphs keep sourceItems without dropping text or role", () => {
  const blocks = segmentPageBlocks([
    pdfItem("Attention Is All You Need", 96, 730, 420, 20),
    pdfItem("The dominant sequence transduction models are based on complex recurrent networks.", 72, 680, 460, 10)
  ]);
  assert.equal(blocks[0].text, "Attention Is All You Need");
  assert.ok(Array.isArray(blocks[0].sourceItems));
  assert.ok(blocks[0].sourceItems.length >= 1);
  assert.equal(blocks.some((block) => block.role === "paragraph" || block.role === "title"), true);
});
