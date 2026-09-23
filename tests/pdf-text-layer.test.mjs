import test from "node:test";
import assert from "node:assert/strict";
import { PDF_MIRROR_OPS } from "../lib/pdf-mirror.js";
import {
  FORMULA_CROP_PAD,
  contentAwareFormulaBbox,
  formulaGlyphsRedrawSafe,
  textLayerToBlocks
} from "../lib/pdf-text-layer.js";
import { segmentPageBlocks } from "../lib/pdf-viewer.js";

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
  const authors = page.blocks.find((block) => block.presentation === "byline");
  assert.ok(authors);
  assert.equal(authors.skipTranslate, true);
  assert.match(authors.text, /Vaswani/);
  assert.equal(authors.label, "text");
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
