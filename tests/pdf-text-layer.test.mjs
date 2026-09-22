import test from "node:test";
import assert from "node:assert/strict";
import { PDF_MIRROR_OPS } from "../lib/pdf-mirror.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
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

test("a prose line plus one CMMI item keeps the sentence and an inline crop", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("The value is ", 72, 700, 70, 10),
      pdfItem("n", 150, 700, 8, 10, { fontName: "CMMI10" }),
      pdfItem(" here.", 162, 700, 36, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 1
  });
  const sentence = page.blocks.find((block) => block.label === "text" && /⟦f1⟧/.test(block.text || ""));
  assert.ok(sentence);
  const formula = page.blocks.find((block) => block.inlineOf === sentence.id);
  assert.ok(formula);
  assert.equal(formula.label, "formula");
  assert.equal(Object.hasOwn(formula, "text"), false);
  assert.equal(Object.hasOwn(formula, "latex"), false);
  assert.equal(sentence.placeholders[0].token, "⟦f1⟧");
  assert.equal(sentence.placeholders[0].blockId, formula.id);
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
