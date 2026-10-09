// Vector charts and caption-below tables in the DPO fixture used to miss their
// visual block. The right pane then painted 「［图］」 and translated the ink inside.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { PDF_MIRROR_OPS, vectorRectsFromOperatorList } from "../lib/pdf-mirror.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { translatableBlocks } from "../lib/pdf-blocks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const attentionPath = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const ATTENTION_SHA = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
const PLACEHOLDER = "［图］";

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

function pdfItem(str, x, y, width = 80, height = 10) {
  return { str, transform: [1, 0, 0, 1, x, y], width, height, fontName: "Times-Roman" };
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

function prose(page) {
  return translatableBlocks(page.blocks).map((block) => block.text).join("\n");
}

test("a constructPath beside a caption becomes the figure and keeps its labels out of prose", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("Reward", 90, 560, 36, 9),
      pdfItem("0.5", 100, 500, 16, 8),
      pdfItem("DPO (Ours)", 180, 620, 60, 9),
      pdfItem("Figure 2: Policy comparison.", 72, 300, 220, 11),
      pdfItem("The experiment compares several policies on this dataset.", 72, 250, 320, 11)
    ],
    viewport: unitViewport(612, 792),
    images: {
      fnArray: [PDF_MIRROR_OPS.constructPath],
      argsArray: [[[19], [80, 350, 440, 270], [80, 350, 520, 620]]]
    },
    page: 7
  });
  const figure = page.blocks.find((block) => block.label === "figure");
  const caption = page.blocks.find((block) => block.label === "caption");
  assert.ok(figure);
  assert.equal(figure.text, undefined);
  assert.equal(caption.captionFor, figure.id);
  assert.ok(figure.bbox[3] <= caption.bbox[1] + 0.01, "figure sits above its caption");
  assert.ok(figure.bbox[3] - figure.bbox[1] > 0.15);
  const text = prose(page);
  assert.match(text, /Figure 2:/);
  assert.match(text, /experiment compares/);
  assert.equal(text.includes("Reward"), false);
  assert.equal(text.includes("DPO (Ours)"), false);
  assert.equal(text.includes("0.5"), false);
  assert.equal(text.includes(PLACEHOLDER), false);
});

test("a chart drawn under the caption is recovered downward", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("Fig. 1: Win rate.", 72, 700, 140, 11),
      pdfItem("Sampling temperature", 160, 520, 110, 9),
      pdfItem("The following section discusses the result.", 72, 300, 280, 11)
    ],
    viewport: unitViewport(612, 792),
    images: {
      fnArray: [PDF_MIRROR_OPS.constructPath],
      argsArray: [[[19], [80, 400, 400, 260], [80, 400, 480, 660]]]
    },
    page: 1
  });
  const figure = page.blocks.find((block) => block.label === "figure");
  const caption = page.blocks.find((block) => block.label === "caption");
  assert.ok(figure);
  assert.equal(caption.captionFor, figure.id);
  assert.ok(figure.bbox[1] >= caption.bbox[3] - 0.02, "figure sits under its caption");
  assert.equal(prose(page).includes("Sampling temperature"), false);
  assert.match(prose(page), /following section/);
});

test("a 图 caption recovers the same vector region", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("图 3：训练曲线。", 72, 300, 120, 11),
      pdfItem("步数", 120, 500, 24, 9)
    ],
    viewport: unitViewport(612, 792),
    images: {
      fnArray: [PDF_MIRROR_OPS.constructPath],
      argsArray: [[[19], [], [80, 350, 500, 640]]]
    },
    page: 1
  });
  const figure = page.blocks.find((block) => block.label === "figure");
  assert.ok(figure);
  assert.equal(page.blocks.find((block) => block.label === "caption").captionFor, figure.id);
  assert.equal(prose(page).includes("步数"), false);
});

test("vectorRectsFromOperatorList maps a transformed path into page space", () => {
  const rects = vectorRectsFromOperatorList(
    [PDF_MIRROR_OPS.save, PDF_MIRROR_OPS.transform, PDF_MIRROR_OPS.constructPath, PDF_MIRROR_OPS.restore],
    [[], [0.5, 0, 0, 0.5, 100, 200], [[19], [], [0, 0, 200, 100]], []],
    792
  );
  assert.equal(rects.length, 1);
  assert.ok(Math.abs(rects[0].rect.left - 100) < 1e-6);
  assert.ok(Math.abs(rects[0].rect.width - 100) < 1e-6);
  assert.ok(Math.abs(rects[0].rect.height - 50) < 1e-6);
  assert.ok(Math.abs(rects[0].rect.top - (792 - 250)) < 1e-6);
});

test("table cells above a narrow caption stay out of the body column", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("To further compare the performance of both policies.", 72, 263, 230, 11),
      pdfItem("DPO", 360, 266, 24, 10),
      pdfItem("0.36", 430, 266, 22, 10),
      pdfItem("PPO", 360, 248, 24, 10),
      pdfItem("0.26", 430, 248, 22, 10),
      pdfItem("Table 1: Win rates versus ground truth.", 340, 180, 200, 11)
    ],
    viewport: unitViewport(612, 792),
    page: 9
  });
  const table = page.blocks.find((block) => block.label === "table");
  const caption = page.blocks.find((block) => block.label === "caption");
  assert.ok(table);
  assert.equal(caption.captionFor, table.id);
  const text = prose(page);
  assert.match(text, /To further compare/);
  assert.match(text, /Table 1:/);
  assert.equal(text.includes("0.36"), false);
  assert.equal(text.includes("DPO"), false);
  assert.equal(text.includes(PLACEHOLDER), false);
});

test("an unmatched caption placeholder is the clickable fallback, not a bare paragraph", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.match(viewer, /function orphanVisualNotice\(block, page\)/);
  assert.match(viewer, /visualCropNotice\(\{ label: table \? "table" : "figure" \}, page\)/);
  assert.match(viewer, /notice\.textContent = PDF_READOUT_COPY\.figurePlaceholder/);
  assert.match(viewer, /notice\?\.classList\?\.contains\("oi-pdf-asset-fallback"\)/);
});

async function loadPages(path, numbers) {
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(path)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const pages = new Map();
  try {
    for (const number of numbers) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const laid = textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      });
      laid.sourceStrings = content.items.map((item) => item?.str || "");
      pages.set(number, laid);
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

test("DPO chart and table pages keep a real visual and drop in-figure text", { timeout: 120000 }, async () => {
  assert.equal(existsSync(dpoPath), true, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf is missing");
  const pages = await loadPages(dpoPath, [7, 8, 9, 10, 22, 23, 25]);
  const absent = {
    7: ["KL(ref)", "Sampling temperature", "IMDb Sentiment", "DPO (Ours)"],
    8: ["Fine-tuning step", "Best of 128", "Anthropic-HH Dialogue"],
    9: ["Win rate vs. ground truth"],
    10: ["N respondents", "GPT-4 (S) win %"],
    22: ["when when when"],
    23: ["Best of 128", "Sampling temperature"],
    25: ["Civil Rights Movement", "J.B. Pritzker"]
  };
  const caption = {
    7: /Figure 2:/,
    8: /Figure 3:/,
    9: /Table 1:/,
    10: /Table 2:/,
    22: /Table 3:/,
    23: /Figure 4:/,
    25: /Table 7:/
  };
  for (const [number, page] of pages) {
    const text = prose(page);
    assert.equal(text.includes(PLACEHOLDER), false, `page ${number} still emits ${PLACEHOLDER}`);
    assert.equal(page.blocks.some((block) => block.text === PLACEHOLDER), false, `page ${number}`);
    assert.equal(page.sourceAudit.missing.length, 0, `page ${number} missing owners`);
    assert.equal(page.sourceAudit.duplicates.length, 0, `page ${number} duplicate owners`);
    const cap = page.blocks.find((block) => caption[number].test(block.text || ""));
    assert.ok(cap, `page ${number} caption`);
    const visual = page.blocks.find((block) => block.id === cap.captionFor);
    assert.ok(visual, `page ${number} visual`);
    assert.equal(visual.label, [7, 8, 23].includes(number) ? "figure" : "table");
    assert.ok(visual.bbox[2] - visual.bbox[0] > 0.2, `page ${number} visual width`);
    assert.ok(visual.bbox[3] - visual.bbox[1] > 0.04, `page ${number} visual height`);
    assert.equal(Object.hasOwn(visual, "text"), false);
    for (const sample of absent[number]) {
      assert.equal(text.includes(sample), false, `page ${number} leaked ${sample}`);
    }
    assert.match(text, caption[number]);
  }
  assert.match(prose(pages.get(25)), /^Table 8:/m);
  assert.match(prose(pages.get(10)), /We find that with both prompts/);
  assert.match(prose(pages.get(9)), /6\.3 Generalization to a new input distribution/);
});

test("Attention figures keep their locked regions", { timeout: 120000 }, async () => {
  assert.equal(existsSync(attentionPath), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  assert.equal(createHash("sha256").update(readFileSync(attentionPath)).digest("hex"), ATTENTION_SHA);
  const pages = await loadPages(attentionPath, [3, 4, 6, 13, 14, 15]);
  const expected = {
    3: [0.316, 0.086, 0.684, 0.503],
    4: [0.236, 0.082, 0.768, 0.342],
    13: [0.170, 0.071, 0.860, 0.368],
    14: [0.170, 0.115, 0.865, 0.733],
    15: [0.168, 0.133, 0.858, 0.751]
  };
  for (const [number, box] of Object.entries(expected)) {
    const page = pages.get(Number(number));
    const figure = page.blocks.find((block) => block.label === "figure");
    const caption = page.blocks.find((block) => block.label === "caption" && block.captionFor === figure?.id);
    assert.ok(figure, `attention page ${number} figure`);
    assert.ok(caption, `attention page ${number} caption`);
    box.forEach((value, index) => {
      assert.ok(Math.abs(figure.bbox[index] - value) < 0.002, `page ${number} bbox[${index}]`);
    });
    assert.equal(page.sourceAudit.duplicates.length, 0);
  }
  const page4 = pages.get(4);
  const titled = page4.sourceAudit.items.filter((owner) =>
    /^(Scaled Dot-Product Attention|Multi-Head Attention)$/.test(page4.sourceStrings[owner.index] || "") &&
    owner.index < 3);
  assert.ok(titled.length >= 2, "attention page 4 figure titles");
  assert.ok(titled.every((owner) => owner.owner === "visual"));
  assert.match(prose(page4), /Figure 2:/);
  const table = pages.get(6).blocks.find((block) => block.label === "table");
  const tableCaption = pages.get(6).blocks.find((block) => /^Table 1:/.test(block.text || ""));
  assert.equal(tableCaption.captionFor, table.id);
});
