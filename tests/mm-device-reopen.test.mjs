// Reopen of a paper that already has a text-layer cache and translations.
// The multimodal page discards that page's old rows and translates the new
// blocks. It does not rebind the old bids. Notes stay on their source anchor.
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
import { reconcilePage } from "../lib/mm-reconcile.js";
import { bindStructureRowBids } from "../lib/pdf-library.js";
import { applyBlockTranslations, isTranslatableBlock } from "../lib/pdf-blocks.js";
import { commitMultimodalPageData, pageNeedsMultimodalQueue } from "../lib/mm-page-invalidate.js";
import { createMmPageFlight } from "../lib/mm-page-queue.js";
import { awaitRenderTask } from "../lib/render-deadline.js";

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

function recordedBlocks(layout, extras = []) {
  const body = (layout.blocks || [])
    .filter((block) => block?.text && block.label !== "formula" && block.label !== "figure" && block.label !== "table")
    .map((block, index) => ({
      id: `mm-p${layout.page}-${index}`,
      bid: `b${layout.page}-mm-${index}`,
      label: block.label || "text",
      text: block.text,
      bbox: block.bbox
    }));
  return [...extras, ...body];
}

function freshBlocks(layout, recorded) {
  return reconcilePage(recorded, layout.blocks).blocks;
}

function paintReopen(layout, recorded, oldPairs, notes) {
  const fresh = freshBlocks(layout, recorded);
  const mmLayout = {
    mode: "mm-page",
    pagePipeline: "mp-1",
    page: layout.page,
    blocks: fresh
  };
  const otherPage = Number(layout.page) + 1;
  const committed = commitMultimodalPageData({
    pages: [
      { page: layout.page, pairs: oldPairs, layout: { ...layout, mode: "text-layer" } },
      { page: otherPage, pairs: [{ bid: "other", text: "Stored sentence for the next page.", translation: "另一页译文" }] }
    ],
    layoutRows: [
      { page: layout.page, mode: "text-layer", layout: { ...layout, mode: "text-layer", blocks: layout.blocks } },
      { page: otherPage, mode: "text-layer", layout: { mode: "text-layer", blocks: [{ bid: "keep-next", text: "next page" }] } }
    ],
    page: layout.page,
    layout: mmLayout,
    notes
  });
  const kept = committed.pages.find((item) => item.page === layout.page).pairs;
  const painted = applyBlockTranslations(fresh, kept).map((block) => {
    if (!isTranslatableBlock(block)) return block;
    if (/[\u4e00-\u9fff]/.test(block.translation || "")) return block;
    return { ...block, translation: "新译文" };
  });
  return { fresh, painted, committed, kept };
}

function assertSamePage(result) {
  const freshText = result.fresh.map((block) => fold(block.text));
  const paintedText = result.painted.map((block) => fold(block.text));
  assert.deepEqual(paintedText, freshText);
  const long = paintedText.filter((text) => text.length >= 24);
  assert.equal(new Set(long).size, long.length, "a sentence is painted once");
  for (const block of result.painted) {
    if (!isTranslatableBlock(block)) continue;
    assert.match(block.translation || "", /[\u4e00-\u9fff]/);
  }
  assert.equal(result.committed.rebuilding, "");
  const other = result.committed.pages.find((item) => item.page !== result.painted[0] && item.pairs?.[0]?.bid === "other");
  assert.equal(other.pairs[0].translation, "另一页译文");
  assert.equal(result.committed.layoutRows.some((row) => row.mode === "text-layer" && row.layout?.blocks?.[0]?.bid === "keep-next"), true);
}

test("a structure row that already has a bid is not moved onto a longer block", () => {
  const fragment = "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.";
  const paragraph = `${fragment} that include an encoder and a decoder.`;
  const row = {
    bid: "old-line",
    text: fragment,
    sourceText: fragment,
    translation: "主导的序列转换模型基于复杂的循环或卷积神经网络。"
  };
  const bound = bindStructureRowBids([row], [
    { id: "line", bid: "old-line", label: "text", text: fragment },
    { id: "mm", bid: "mm-abs", label: "text", text: paragraph }
  ]);
  assert.equal(bound[0].bid, "old-line");
  assert.equal(bound[0].translation, row.translation);
});

test("Attention reopen translates the new abstract instead of the old line", async () => {
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
  const recorded = [
    { id: "mm-title", bid: "b1-mm-title", label: "heading", text: "Attention Is All You Need" },
    { id: "mm-abs-h", bid: "b1-mm-abs-h", label: "heading", text: "Abstract" },
    { id: "mm-abstract", bid: "b1-mm-abstract", label: "text", text: joined, bbox: bodyLines[0].bbox }
  ];
  const notes = [{ id: "n1", page: 1, anchor: { page: 1, start: 12, end: 40 }, quote: "Attention" }];
  const oldPairs = [{
    bid: bodyLines[0].bid,
    id: bodyLines[0].id,
    text: bodyLines[0].text,
    sourceText: bodyLines[0].text,
    translation: "主导的序列转换模型基于复杂的循环或卷积神经网络。"
  }];
  assert.equal(pageNeedsMultimodalQueue({ configured: true, layout: { ...layout, mode: "text-layer" } }), true);
  assert.equal(pageNeedsMultimodalQueue({ configured: false, layout: { ...layout, mode: "text-layer" } }), false);
  const result = paintReopen(layout, recorded, oldPairs, notes);
  assertSamePage(result);
  const paragraph = result.painted.find((block) => fold(block.text).startsWith("The dominant sequence transduction"));
  assert.ok(paragraph);
  assert.equal(paragraph.translation, "新译文");
  assert.equal(result.kept.some((pair) => pair.bid === bodyLines[0].bid), false);
  assert.equal(result.committed.notes, notes);
  assert.deepEqual(result.committed.notes, [{ id: "n1", page: 1, anchor: { page: 1, start: 12, end: 40 }, quote: "Attention" }]);
  assert.equal(result.committed.layoutRows.some((row) => row.page === 1 && row.mode === "text-layer"), false);
});

test("TXL page 2 reopen has the fresh block list, not an empty cache", async (t) => {
  if (!existsSync(txlPath)) {
    t.skip("TXL PDF is not in /tmp/oi-flow-corpus/1901.02860/paper.pdf");
    return;
  }
  const layout = await pageLayout(txlPath, 2);
  assert.ok(layout.blocks.length > 4, "TXL page 2 text layer has a column of blocks");
  const recorded = recordedBlocks(layout);
  const notes = [{ id: "txl-note", page: 2, anchor: { page: 2, start: 0, end: 8 } }];
  const oldPairs = layout.blocks.slice(0, 4).map((block) => ({
    bid: block.bid,
    text: block.text,
    sourceText: block.text,
    translation: "旧译文"
  }));
  const emptyCache = { ...layout, blocks: [], mode: "text-layer" };
  assert.equal(pageNeedsMultimodalQueue({ configured: true, layout: emptyCache }), true);
  const result = paintReopen(layout, recorded, oldPairs, notes);
  assert.ok(result.fresh.length > 4);
  assertSamePage(result);
  assert.equal(result.committed.notes, notes);
});

test("DPO reopen paints each page once, matching a fresh open", async () => {
  assert.equal(existsSync(dpoPath), true, "DPO fixture PDF is missing");
  for (const pageNumber of [1, 2]) {
    const layout = await pageLayout(dpoPath, pageNumber);
    const fullTitle = layout.blocks.find((block) => /Secretly a Reward Model/.test(block.text));
    const recorded = recordedBlocks(layout, pageNumber === 1 && fullTitle ? [] : []);
    const short = {
      bid: "old-short-title",
      text: "Direct Preference Optimization:",
      sourceText: "Direct Preference Optimization:",
      translation: "直接偏好优化："
    };
    const oldPairs = [short, ...layout.blocks.slice(0, 6).map((block) => ({
      bid: block.bid,
      text: block.text,
      sourceText: block.text,
      translation: "旧译文"
    }))];
    const notes = [{ id: `dpo-${pageNumber}`, page: pageNumber, anchor: { page: pageNumber, start: 1, end: 4 } }];
    const result = paintReopen(layout, recorded, oldPairs, notes);
    assertSamePage(result);
    assert.equal(result.committed.notes, notes);
    assert.equal(result.kept.some((pair) => pair.bid === "old-short-title"), false);
    if (fullTitle) {
      const titles = result.painted.filter((block) => /Direct Preference Optimization:/.test(block.text));
      const freshTitles = result.fresh.filter((block) => /Direct Preference Optimization:/.test(block.text));
      assert.deepEqual(titles.map((block) => fold(block.text)), freshTitles.map((block) => fold(block.text)));
    }
  }
});

test("a render promise that fulfills with a pending thenable still releases the next page", async () => {
  const hung = { then() {} };
  let cancelled = 0;
  const err = await awaitRenderTask({
    promise: Promise.resolve(hung),
    cancel() { cancelled += 1; }
  }, { timeoutMs: 30 }).then(() => null, (error) => error);
  assert.equal(err?.code, "timeout");
  assert.equal(cancelled, 1);
  const sent = [];
  const flight = createMmPageFlight({ concurrency: 1 });
  const raster = (page) => awaitRenderTask({
    promise: page === 11 ? new Promise(() => {}) : Promise.resolve("png"),
    cancel() {}
  }, { timeoutMs: 40 });
  const run = (page, role) => flight.run({ page, role, epoch: 1 }, async () => {
    try {
      await raster(page);
    } catch (error) {
      assert.equal(error.code, "timeout");
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

test("viewer commits a multimodal page before paint and does not warm a cache hit", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const ingest = viewer.slice(viewer.indexOf("async function ingestMmPageLayout"), viewer.indexOf("async function warmMmNeighbors"));
  const hit = ingest.slice(0, ingest.indexOf("const stored = getPageLayout"));
  assert.equal(hit.includes("warmMmNeighbors"), false);
  assert.match(hit, /discardStalePageForMultimodal\(n, cached\)/);
  assert.match(hit, /enqueueUncoveredPage\(n\)/);
  assert.match(ingest, /!mmPageConfigured\(formulaViewerSettings\) && legacyPageShouldHold/);
  const swap = viewer.slice(viewer.indexOf("function replaceMmLayout"), viewer.indexOf("async function pdfByteHash"));
  assert.match(swap, /discardStalePageForMultimodal\(n, layout\)/);
  assert.match(swap, /reanchor: false/);
  assert.equal(swap.includes("prev.translation"), false);
  assert.match(viewer, /pageNeedsMultimodalQueue\(/);
  assert.equal(viewer.includes("layoutStandsInForEngine"), false);
});
