// Device state from tip 6d3bd59 (diagnostics + icpt + block dumps).
// Attention open already has a library entry. Page 1 vision returns, then
// page 11 logs mm.page.start and never reaches sendVision. TXL/DPO reopen
// paints a cached mm layout beside older translations.
//
// Fixtures:
//   tests/fixtures/Attention_Is_All_You_Need.pdf
//   tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf
//   /tmp/oi-flow-corpus/1901.02860/paper.pdf (TXL)
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { blockHiddenByAlias, dedupeSwappedBlocks, reconcilePage } from "../lib/mm-reconcile.js";
import { bindStructureRowBids } from "../lib/pdf-library.js";
import { applyBlockTranslations } from "../lib/pdf-blocks.js";
import { createMmPageFlight } from "../lib/mm-page-queue.js";
import { awaitRenderTask } from "../lib/render-deadline.js";
import { layoutStandsInForEngine } from "../lib/pdf-layout-client.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const attentionPath = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const txlPath = "/tmp/oi-flow-corpus/1901.02860/paper.pdf";

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

async function pageLayout(pdfPath, pageNumber) {
  const bytes = readFileSync(pdfPath);
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  try {
    const pdfPage = await doc.getPage(pageNumber);
    const content = await pdfPage.getTextContent();
    const viewport = pdfPage.getViewport({ scale: 1 });
    const layout = textLayerToBlocks({ items: content.items, viewport, page: pageNumber });
    return stampLayoutBids(pageNumber, layout);
  } finally {
    await doc.destroy();
  }
}

function fold(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

test("Attention abstract translation follows the swapped paragraph, not the old line bid", async () => {
  assert.equal(existsSync(attentionPath), true, "Attention fixture PDF is missing");
  const layout = await pageLayout(attentionPath, 1);
  const blocks = layout.blocks.filter((block) => block.label !== "formula" && block.label !== "figure");
  const heading = blocks.find((block) => fold(block.text) === "Abstract");
  assert.ok(heading, "text layer has an Abstract heading");
  const headingAt = blocks.indexOf(heading);
  const bodyLines = [];
  for (let index = headingAt + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    const text = fold(block.text);
    if (!text) continue;
    if (/^(1\s+Introduction|\*Equal contribution|31st Conference)/.test(text)) break;
    if (block.label === "heading") break;
    bodyLines.push(block);
    if (bodyLines.length >= 8) break;
  }
  assert.ok(bodyLines.length >= 2, "abstract is more than one text-layer line");
  const joined = fold(bodyLines.map((block) => block.text).join(" "));
  // Recorded mm response: the model returns the abstract as one paragraph
  // with a new id. The text-layer lines stay in the page (column fragments).
  const mmAbstract = {
    id: "mm-abstract",
    bid: "b1-p1-mm-abstract",
    label: "text",
    text: joined,
    bbox: bodyLines[0].bbox
  };
  const recorded = {
    blocks: [
      { id: "mm-title", bid: "b1-p1-mm-title", label: "heading", text: "Attention Is All You Need" },
      { id: "mm-abs-h", bid: "b1-p1-mm-abs-h", label: "heading", text: "Abstract" },
      mmAbstract
    ]
  };
  const reconciled = reconcilePage(recorded.blocks, blocks).blocks;
  const paragraph = reconciled.find((block) => fold(block.text).startsWith("The dominant sequence transduction"));
  assert.ok(paragraph, "reconcile keeps the joined abstract");
  // The structure pass translated the joined abstract onto the first line's bid
  // while the page was still the text layer. That bid is still live on the fragment.
  const row = {
    id: "oi-structure:abstract.body",
    bid: bodyLines[0].bid,
    original: joined,
    text: joined,
    sourceText: joined,
    translation: "主导的序列转换模型基于复杂的循环或卷积神经网络。"
  };
  const bound = bindStructureRowBids([row], reconciled);
  const painted = applyBlockTranslations(reconciled, bound);
  const shown = painted.find((block) => block.id === paragraph.id || block.bid === paragraph.bid);
  assert.match(String(shown?.translation || ""), /序列转换/);
});

test("TXL right column stays when its bid was aliased onto the title", async () => {
  assert.equal(existsSync(txlPath), true, "TXL PDF is not in /tmp/oi-flow-corpus/1901.02860/paper.pdf");
  const layout = await pageLayout(txlPath, 1);
  const right = layout.blocks.find((block) => /LSTM/.test(block.text) && /Term Memory|Hochreiter/.test(block.text));
  assert.ok(right, "TXL page 1 has the right-column LSTM paragraph");
  const title = layout.blocks.find((block) => /Transformer-XL/.test(block.text));
  assert.ok(title);
  const host = { ...title, bidAliases: [right.bid] };
  const page = layout.blocks.map((block) => (block === title ? host : block));
  assert.equal(blockHiddenByAlias(right, page), false);
});

test("DPO reopen drops a short title that is contained in the full title", () => {
  // Tip O-dpo-p1: "Direct Preference Optimization:" and the full title both paint.
  const blocks = [
    { id: "p1-b1", bid: "b1-p1-t1998als", label: "text", text: "Direct Preference Optimization:" },
    { id: "b2", bid: "b1-p1-t099suy8", label: "text", text: "Direct Preference Optimization: Your Language Model is Secretly a Reward Model" },
    { id: "p1-b9", bid: "b1-p1-t12dg02j", label: "heading", text: "Abstract" },
    { id: "b5", bid: "b1-p1-t0fej8h0", label: "text", text: "While large-scale unsupervised language models (LMs) learn broad world knowledge and some reasoning skills." }
  ];
  const kept = dedupeSwappedBlocks(blocks);
  const titles = kept.filter((block) => /Direct Preference Optimization/.test(block.text));
  assert.equal(titles.length, 1);
  assert.match(titles[0].text, /Secretly a Reward Model/);
});

test("TXL text-layer library page still stands in when the engine is mm-page", async () => {
  assert.equal(existsSync(txlPath), true, "TXL PDF is not in /tmp/oi-flow-corpus/1901.02860/paper.pdf");
  const layout = await pageLayout(txlPath, 2);
  assert.ok(layout.blocks.length > 4, "TXL page 2 text layer has a column of blocks");
  const record = {
    page: 2,
    layout: { ...layout, mode: "text-layer", pagePipeline: "" },
    layoutVersion: layout.layoutVersion || ""
  };
  assert.equal(layoutStandsInForEngine(record, "mm-page"), true);
});

test("a page render that never settles does not hold the next vision call", async () => {
  // Diagnostics: mm.page.ok page 1 at 26.7s is followed by mm.page.start page 11.
  // No mm-end, no fallback, no HTTP until the next document at 326.9s.
  // Page 11 is current, so it is not dropped. Page 2 waits behind that render.
  const sent = [];
  const flight = createMmPageFlight({ concurrency: 1 });
  const raster = (page) => awaitRenderTask({
    promise: page === 11 ? new Promise(() => {}) : Promise.resolve("png"),
    cancel() {}
  }, { timeoutMs: 40 });
  const run = (page, role) => flight.run({ page, role, epoch: 1 }, async () => {
    try {
      await raster(page);
    } catch (err) {
      assert.equal(err.code, "timeout");
    }
    sent.push(page);
    return { ok: true };
  });
  const pending = Promise.all([run(11, "current"), run(2, "neighbor")]);
  const winner = await Promise.race([
    pending.then(() => "done"),
    new Promise((resolve) => setTimeout(() => resolve("stuck"), 800))
  ]);
  assert.equal(winner, "done");
  assert.deepEqual(sent, [11, 2]);
});
