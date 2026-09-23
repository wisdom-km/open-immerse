import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";
import { CROP_SCALE, blockReadoutPlan, blockRenderPieces } from "../lib/pdf-blocks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const labels = JSON.parse(readFileSync(join(root, "tests/fixtures/pdf-blocks/attention-boundaries.json"), "utf8"));
GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

test("Attention text fragments have one source owner and complete visual boundaries", {
  skip: !existsSync(fixture) && "local Attention PDF fixture is absent"
}, async () => {
  const bytes = readFileSync(fixture);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), labels.sha256);
  const doc = await getDocument({
    data: new Uint8Array(bytes), verbosity: 0, isOffscreenCanvasSupported: false
  }).promise;
  const pages = new Map();
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const images = { fnArray: ops.fnArray, argsArray: ops.argsArray };
      const page = textLayerToBlocks({ items: content.items, viewport, images, page: number });
      pages.set(number, { page, content, viewport, images });
      assert.deepEqual(page.sourceAudit.missing, [], `page ${number} has unowned text items`);
      assert.deepEqual(page.sourceAudit.duplicates, [], `page ${number} has duplicate text ownership`);
      assert.equal(page.sourceAudit.items.length, content.items.length);
      assert.ok(page.blocks.every((block) => /^p\d+-s[0-9a-z]+$/.test(block.sourceId)));
      assert.ok(page.blocks.every((block) => !["formula", "figure", "table"].includes(block.label) ||
        (!Object.hasOwn(block, "text") && !Object.hasOwn(block, "content"))));
      for (const block of page.blocks.filter((entry) => entry.label === "formula")) {
        const pixelWidth = (block.bbox[2] - block.bbox[0]) * viewport.width * CROP_SCALE;
        const pixelHeight = (block.bbox[3] - block.bbox[1]) * viewport.height * CROP_SCALE;
        assert.ok(pixelWidth >= 24 && pixelHeight >= 12,
          `page ${number} has a tiny formula crop: ${pixelWidth}x${pixelHeight}`);
      }
    }
    for (const expected of labels.blocks) {
      const { page } = pages.get(expected.page);
      const matching = page.blocks.filter((block) => {
        if (block.label !== expected.label) return false;
        if (expected.sourceIncludes && !block.sourceText?.includes(expected.sourceIncludes)) return false;
        if (expected.inlineSourceIncludes) {
          const host = page.blocks.find((entry) => entry.id === block.inlineOf);
          if (!host?.sourceText?.includes(expected.inlineSourceIncludes)) return false;
        }
        return block.bbox.every((value, index) => Math.abs(value - expected.bbox[index]) < 0.012);
      });
      assert.equal(matching.length, 1, `${expected.name} must have one ${expected.label} boundary`);
    }
    const p2 = pages.get(2).page.blocks;
    assert.equal(p2.filter((block) => block.sourceText?.includes("hidden states h_t")).length, 1);
    assert.ok(p2.some((block) => block.sourceText?.includes("[5, 2, 35]")));
    assert.ok(p2.some((block) => block.sourceText?.includes("sequence-aligned")));
    const p3 = pages.get(3).page.blocks;
    const encoder = p3.filter((block) => block.sourceText?.startsWith("Encoder:"));
    assert.equal(encoder.length, 1);
    assert.match(encoder[0].sourceText, /d_\{model\} = 512/);
    assert.match(encoder[0].sourceText, /position-wise/);
    assert.equal(encoder[0].placeholders.length, 2);
    const matrix = pages.get(5).page.blocks.find((block) =>
      block.text?.startsWith("Where the projections are parameter matrices"));
    assert.match(matrix.text, /parameter matrices ⟦f\d+⟧ and ⟦f\d+⟧\./);
    assert.doesNotMatch(matrix.text, /W_iQ|dmodel|Rdmodel/);
    assert.ok(matrix.placeholders.length >= 2);
    const matrixCrops = matrix.placeholders.map((entry) =>
      pages.get(5).page.blocks.find((block) => block.id === entry.blockId));
    assert.equal(matrixCrops.every((block) => block?.label === "formula" && !("text" in block)), true);
    const p5view = pages.get(5).viewport;
    for (const crop of matrixCrops) {
      const height = (crop.bbox[3] - crop.bbox[1]) * p5view.height * CROP_SCALE;
      assert.ok(height >= 24, "matrix crop must cover scripts");
    }
    const embeddings = pages.get(5).page.blocks.find((block) =>
      block.sourceText?.startsWith("Similarly to other sequence transduction models"));
    assert.match(embeddings.sourceText, /multiply those weights by √d_\{model\}/);
    assert.equal(embeddings.placeholders.length, 1, "the square root and d_model share one inline crop");
    assert.match(embeddings.text, /multiply those weights by ⟦f\d+⟧\./);
    const positions = pages.get(6).page.blocks.find((block) =>
      block.sourceText?.startsWith("where pos is the position"));
    assert.match(positions.sourceText, /PE_\{pos\+k\}.*PE_\{pos\}/);
    assert.equal(positions.placeholders.length, 2, "both positional-encoding subscripts have crops");
    const optimizer = pages.get(7).page.blocks.find((block) =>
      block.sourceText?.startsWith("We used the Adam optimizer"));
    assert.match(optimizer.sourceText, /ϵ = 10−9/);
    assert.equal(optimizer.placeholders.length, 3);
    assert.doesNotMatch(optimizer.text, /⟦f\d+⟧−9/, "the exponent stays inside the inline crop");
    const p7 = pages.get(7);
    const inlineCrops = optimizer.placeholders.map((entry) =>
      p7.page.blocks.find((block) => block.id === entry.blockId));
    assert.equal(inlineCrops.every((block) => block?.inlineOf === optimizer.id && block.display === false), true);
    const centersIn = (bbox) => p7.content.items.filter((item) => {
      const text = String(item.str || "").trim();
      if (!text) return false;
      const x = item.transform[4] + (Number(item.width) || 0) / 2;
      const y = item.transform[5] + (Number(item.height) || 0) / 2;
      const rect = p7.viewport.convertToViewportRectangle([x, y, x, y]);
      const nx = rect[0] / p7.viewport.width;
      const ny = Math.min(rect[1], rect[3]) / p7.viewport.height;
      return nx >= bbox[0] && nx <= bbox[2] && ny >= bbox[1] && ny <= bbox[3];
    }).map((item) => item.str).join("");
    for (const crop of inlineCrops) {
      const width = (crop.bbox[2] - crop.bbox[0]) * p7.viewport.width;
      assert.ok(width < 80, `Adam inline crop stays in the sentence (${width.toFixed(1)}pt)`);
      assert.doesNotMatch(centersIn(crop.bbox), /rate over the course|according to the formula|lrate/);
    }
    const lrate = p7.page.blocks.find((block) =>
      block.label === "formula" && !block.inlineOf && centersIn(block.bbox).includes("lrate"));
    assert.ok(lrate);
    assert.doesNotMatch(centersIn(lrate.bbox), /Adam|according to the formula/);
    const pieces = blockRenderPieces(optimizer, p7.page.blocks);
    assert.equal(pieces.filter((piece) => piece.type === "image").length, 3);
    assert.equal(pieces.some((piece) => piece.blockId === lrate.id), false);
    assert.equal(blockReadoutPlan(lrate).className, "oi-pdf-display-math");
    assert.equal(blockReadoutPlan(inlineCrops[0]).className, "oi-pdf-inline-math");
    for (const number of [4, 5, 6, 7]) {
      const view = pages.get(number).viewport;
      const displays = pages.get(number).page.blocks.filter((block) =>
        block.label === "formula" && !block.inlineOf);
      assert.ok(displays.length >= 1, `page ${number} has a display formula`);
      for (const block of displays) {
        const width = (block.bbox[2] - block.bbox[0]) * view.width * CROP_SCALE;
        const height = (block.bbox[3] - block.bbox[1]) * view.height * CROP_SCALE;
        assert.ok(width >= 100 && height >= 30, `page ${number} display crop ${width}x${height}`);
        assert.equal("text" in block || "latex" in block || "content" in block, false);
      }
    }
    for (const number of [10, 11, 12]) {
      const refs = pages.get(number).page.blocks.filter((block) => /^\[\d+\]/.test(block.text || ""));
      const nums = refs.map((block) => Number(block.text.match(/^\[(\d+)\]/)[1]));
      assert.ok(nums.length >= 4, `page ${number} reference entries`);
      for (let index = 1; index < nums.length; index += 1) {
        assert.ok(nums[index] > nums[index - 1], `page ${number} reference order ${nums.join(",")}`);
      }
      assert.equal(refs.every((block) => block.skipTranslate === true), true);
      assert.equal(refs.some((block) => /Exploringthe|Conferenceon|NeuralInformation/.test(block.text || "")), false);
    }
    const firstRef = pages.get(10).page.blocks.find((block) => block.text?.startsWith("[1]"));
    assert.match(firstRef.text, /arXiv preprint arXiv:1607\.06450/);
    const sixteen = pages.get(11).page.blocks.find((block) => block.text?.startsWith("[16]"));
    assert.match(sixteen.text, /In Advances in Neural Information Processing Systems, \(NIPS\), 2016\./);
    for (const [number, tableNumber] of [[6, 1], [8, 2], [9, 3], [10, 4]]) {
      const blocks = pages.get(number).page.blocks;
      const caption = blocks.find((block) => block.label === "caption" &&
        new RegExp(`^Table ${tableNumber}:`).test(block.text || ""));
      assert.equal(caption?.captionFor, blocks.find((block) => block.label === "table")?.id);
    }
    const visualWords = [
      [4, /^(Scaled Dot-Product Attention|Multi-Head Attention)$/],
      [6, /^Recurrent$/],
      [8, /^GNMT \+ RL/],
      [9, /^positional embedding instead of sinusoids$/],
      [10, /^Parser$/],
      [14, /<EOS>|<pad>/],
      [15, /<EOS>|<pad>/]
    ];
    for (const [number, pattern] of visualWords) {
      const { page, content } = pages.get(number);
      const matches = page.sourceAudit.items.filter((owner) =>
        pattern.test(content.items[owner.index]?.str || "") && (number !== 4 || owner.index < 3));
      assert.ok(matches.length, `page ${number} has labeled visual text`);
      assert.ok(matches.every((owner) => owner.owner === "visual"), `page ${number} visual text leaked into prose`);
    }
    const overlapSize = (a, b) => ({
      w: Math.min(a[2], b[2]) - Math.max(a[0], b[0]),
      h: Math.min(a[3], b[3]) - Math.max(a[1], b[1])
    });
    for (const number of [4, 5, 6, 7]) {
      const blocks = pages.get(number).page.blocks;
      const formulas = blocks.filter((block) => block.label === "formula");
      for (const formula of formulas) {
        assert.equal(typeof formula.display, "boolean");
        assert.equal(formula.display, !formula.inlineOf);
        for (const other of blocks) {
          if (other === formula || !other.bbox) continue;
          if (formula.inlineOf && other.id === formula.inlineOf) continue;
          if (formula.inlineOf && other.label === "text") {
            const hit = overlapSize(formula.bbox, other.bbox);
            assert.ok(!(hit.w > 0.008 && hit.h > 0.004),
              `page ${number} inline ${formula.id} overlaps neighbor ${other.id}`);
            continue;
          }
          if (["figure", "caption", "table"].includes(other.label)) {
            const hit = overlapSize(formula.bbox, other.bbox);
            const area = Math.max(0, hit.w) * Math.max(0, hit.h);
            assert.ok(area < 1e-12, `page ${number} ${formula.id} meets ${other.label} ${other.id}`);
            continue;
          }
          if (!["formula", "text"].includes(other.label)) continue;
          const hit = overlapSize(formula.bbox, other.bbox);
          assert.ok(!(hit.w > 0.008 && hit.h > 0.004),
            `page ${number} ${formula.id} overlaps ${other.label} ${other.id}`);
        }
      }
    }
    const p4 = pages.get(4);
    const footnote = p4.page.blocks.filter((block) => block.sourceText?.includes("To illustrate why the dot products get large"));
    assert.equal(footnote.length, 1, "page 4 footnote appears once");
    assert.ok(footnote[0].sourceText.startsWith("4"), "footnote marker stays with the footnote");
    assert.ok(!p4.page.blocks.some((block) => block.sourceText?.startsWith("Instead of performing a single attention") &&
      block.sourceText.includes("To illustrate why")), "footnote does not merge into multi-head prose");
    const vendor = vendorLayoutToBlocks({ page: 4, layoutDetails: [
      { label: "figure", bbox_2d: [0.28, 0.11, 0.40, 0.29], content: "OCR text" },
      { label: "figure", bbox_2d: [0.56, 0.10, 0.77, 0.34], content: "OCR text" }
    ] }, { items: p4.content.items, viewport: p4.viewport, images: p4.images, page: 4 });
    const figures = vendor.blocks.filter((block) => block.label === "figure");
    assert.equal(figures.length, 1, "two partial layout candidates form one original-page Figure 2");
    assert.ok(figures[0].bbox[0] < 0.25 && figures[0].bbox[2] > 0.76);
    assert.equal(vendor.blocks.some((block) => /OCR text/.test(block.text || "")), false);
  } finally {
    await doc.destroy();
  }
});
