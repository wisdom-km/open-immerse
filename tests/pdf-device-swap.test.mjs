/**
 * Text-layer reading order stays on for v1 (TXL columns, centered band,
 * continuation lines, footnotes after the title). The swap cases at the
 * bottom are v2 and call that path directly. The reader default is off.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeSwappedBlocks, reconcilePage } from "../lib/mm-reconcile.js";
import { swapNeedsRepaint } from "../lib/mm-page-swap.js";
import { joinPageBoundary, visibleFlowBlocks } from "../lib/pdf-flow-join.js";
import { blockCoveredByStructure } from "../lib/pdf-structure-render.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { orderLinesInColumns, paragraphsFromLines } from "../lib/pdf-viewer.js";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { attachFontRealNames } from "../lib/pdf-mirror.js";

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

function line(text, x, y, width = 220, height = 10, extra = {}) {
  return { text, x, y, width, height, items: [{ str: text, x, y, width, height }], ...extra };
}

test("a band subtitle is put back above the column, not after the footnote", () => {
  const ordered = orderLinesInColumns([
    line("Transformer-XL: Attentive Language Models", 40, 740, 500, 16),
    line("Abstract", 40, 640, 70, 12),
    line("Equal contribution note under the column.", 40, 80, 240, 9),
    line("Beyond a Fixed-Length Context", 160, 716, 250, 14, { band: true })
  ]);
  assert.deepEqual(ordered.map((entry) => entry.text), [
    "Transformer-XL: Attentive Language Models",
    "Beyond a Fixed-Length Context",
    "Abstract",
    "Equal contribution note under the column."
  ]);
});

test("a column's first six words stay in the sentence", () => {
  const blocks = paragraphsFromLines([
    line("Transformers have a potential of learning", 40, 520),
    line("longer-term dependency, but are limited by a fixed-length context in the setting of language modeling.", 40, 506, 240),
    line("Treebank (without finetuning). When trained", 40, 470),
    line("only on WikiText-103, Transformer-XL manages to generate reasonably coherent novel text articles.", 40, 456, 240),
    line("Term Memory (LSTM) networks (Hochreiter and", 320, 520),
    line("Schmidhuber, 1997), have been a standard solution to language modeling and obtained strong results.", 320, 506, 240),
    line("To address the aforementioned limitations of", 320, 470),
    line("fixed-length contexts, we propose a new architecture called Transformer-XL meaning extra long.", 320, 456, 240)
  ]);
  const text = blocks.map((block) => block.text).join("\n");
  assert.equal(blocks.some((block) => block.role === "heading"), false);
  assert.match(text, /learning longer-term dependency/);
  assert.match(text, /When trained only on WikiText-103/);
  assert.match(text, /Hochreiter and Schmidhuber/);
  assert.match(text, /limitations of fixed-length contexts/);
});

test("a lowercase title tail stays on the title", () => {
  const blocks = paragraphsFromLines([
    line("Trends in undiagnosed HIV prevalence in England and", 40, 700, 480, 18),
    line("implications for eliminating HIV transmission by 2030:", 40, 678, 480, 18),
    line("an evidence synthesis model", 40, 656, 260, 14),
    line("Background A target to eliminate HIV transmission in England by 2030 was set in early 2019.", 40, 520, 240, 10),
    line("A Bayesian synthesis of evidence from multiple surveillance datasets estimated the undiagnosed fraction.", 40, 506, 240, 10)
  ]);
  const title = blocks.find((block) => block.role === "title");
  assert.ok(title);
  assert.match(title.text, /England and implications for eliminating/);
  assert.match(title.text, /an evidence synthesis model/);
  assert.equal(blocks.filter((block) => /evidence synthesis model/.test(block.text)).length, 1);
});

test("Transformer-XL page 1 keeps the subtitle with the title and does not head the column", async (t) => {
  const path = "/tmp/oi-flow-corpus/1901.02860/paper.pdf";
  if (!existsSync(path)) {
    t.skip("TXL PDF is not in /tmp/oi-flow-corpus/1901.02860/paper.pdf");
    return;
  }
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  const pdfPage = await doc.getPage(1);
  const content = await pdfPage.getTextContent();
  attachFontRealNames(content.items, pdfPage.commonObjs);
  const viewport = pdfPage.getViewport({ scale: 1 });
  const ops = await pdfPage.getOperatorList();
  const built = textLayerToBlocks({
    items: content.items,
    viewport,
    images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
    page: 1
  });
  const rows = built.blocks.map((block) => ({
    label: block.label,
    text: String(block.text || "").replace(/\s+/g, " ")
  }));
  const titleAt = rows.findIndex((row) => /Transformer-XL: Attentive Language Models/.test(row.text));
  const abstractAt = rows.findIndex((row) => row.text === "Abstract");
  assert.ok(titleAt >= 0 && titleAt < abstractAt);
  assert.match(rows[titleAt].text, /Beyond a Fixed-Length Context/);
  for (const [fragment, rest] of [
    ["Transformers have a potential of learning", "longer-term dependency"],
    ["Treebank (without finetuning). When trained", "only on WikiText-103"],
    ["Term Memory (LSTM) networks (Hochreiter and", "Schmidhuber"],
    ["To address the aforementioned limitations of", "fixed-length contexts"]
  ]) {
    const hit = rows.find((row) => row.text.includes(fragment));
    assert.equal(hit?.label, "text", fragment);
    assert.match(hit.text, new RegExp(rest));
  }
  const note = rows.find((row) => /github\.com/.test(row.text));
  assert.equal(/Term Memory/.test(note?.text || ""), false);
  const page2 = await doc.getPage(2);
  const content2 = await page2.getTextContent();
  attachFontRealNames(content2.items, page2.commonObjs);
  const view2 = page2.getViewport({ scale: 1 });
  const ops2 = await page2.getOperatorList();
  const second = textLayerToBlocks({
    items: content2.items,
    viewport: view2,
    images: { fnArray: ops2.fnArray, argsArray: ops2.argsArray },
    page: 2
  });
  const joined = joinPageBoundary(built.blocks, second.blocks);
  assert.equal(joined.joined, true);
  assert.match(joined.previous.map((block) => block.text).join(" "), /deep self-attention network/);
  const shown = visibleFlowBlocks(joined.next).map((block) => block.text).join(" ");
  assert.equal(/deep self-attention network/.test(shown), false);
  await doc.destroy();
});

test("a second ingest does not emit a continuation the host already carries", () => {
  const tailText = "of the values, where the weight assigned to each value is computed by a compatibility function.";
  const first = joinPageBoundary(
    [{ id: "p3-b9", bid: "b1-p3-t1w3vhah", label: "text", text: "The output is computed as a weighted sum" }],
    [
      { id: "p4-b1", bid: "b1-p4-g07asgji", label: "figure", text: "" },
      { id: "p4-b3", bid: "b1-p4-t031i7d0", label: "text", text: tailText }
    ]
  );
  assert.equal(first.joined, true);
  assert.equal(first.next.find((block) => block.bid === "b1-p4-t031i7d0").flowHost, "p3-b9");
  const again = joinPageBoundary(first.previous, [
    { id: "p4-b1", bid: "b1-p4-g07asgji", label: "figure", text: "" },
    { id: "p4-b3", bid: "b1-p4-t031i7d0", label: "text", text: tailText }
  ]);
  assert.equal(again.joined, true);
  const tail = again.next.find((block) => block.bid === "b1-p4-t031i7d0");
  assert.equal(tail.flowHost, "p3-b9");
  assert.equal(tail.skipTranslate, true);
  assert.equal((again.previous[0].text.match(/of the values/g) || []).length, 1);
  assert.ok(again.previous[0].bidAliases.includes("b1-p4-t031i7d0"));
});

test("a cross-page tail is one block: the next page does not paint it", () => {
  const joined = joinPageBoundary(
    [{ id: "p1-b16", bid: "b1-p1-thost", label: "text", text: "We introduce the notion of recurrence into" }],
    [{ id: "p2-b1", bid: "b1-p2-ttail", label: "text", text: "deep self-attention network. In particular, instead of computing the hidden states from scratch." }]
  );
  assert.equal(joined.joined, true);
  assert.match(joined.previous[0].text, /deep self-attention network/);
  assert.equal(joined.previous[0].bidAliases.includes("b1-p2-ttail"), true);
  assert.equal(visibleFlowBlocks(joined.next).length, 0);
  assert.equal(joined.next[0].flowHost, "p1-b16");
});

test("a multimodal swap keeps one block per sentence and does not put footnotes first", () => {
  const text = [
    { id: "p1-b1", bid: "b-title", label: "title", bbox: [0.1, 0.08, 0.9, 0.12], text: "Attention Is All You Need" },
    { id: "p1-b10", bid: "b-abs", label: "heading", bbox: [0.1, 0.2, 0.4, 0.24], text: "Abstract" },
    { id: "p1-b11", bid: "b-body", label: "text", bbox: [0.1, 0.25, 0.9, 0.55], text: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks." },
    { id: "p1-b12", bid: "b-f1", label: "footnote", role: "footnote", bbox: [0.1, 0.8, 0.9, 0.84], text: "Equal contribution. Listing order is random." },
    { id: "p1-b13", bid: "b-f2", label: "footnote", role: "footnote", bbox: [0.1, 0.85, 0.9, 0.88], text: "Work performed while at Google Brain." },
    { id: "p1-b14", bid: "b-f3", label: "footnote", role: "footnote", bbox: [0.1, 0.9, 0.9, 0.94], text: "Work performed while at Google Research." }
  ];
  const mm = [
    { id: "f1", label: "footnote", bbox: [0.1, 0.8, 0.9, 0.84], order: 1, text: "Equal contribution. Listing order is random." },
    { id: "f2", label: "footnote", bbox: [0.1, 0.85, 0.9, 0.88], order: 2, text: "Work performed while at Google Brain." },
    { id: "f3", label: "footnote", bbox: [0.1, 0.9, 0.9, 0.94], order: 3, text: "Work performed while at Google Research." },
    { id: "b1", label: "text", bbox: [0.1, 0.02, 0.9, 0.05], order: 4, text: "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023" },
    { id: "b2", label: "title", bbox: [0.1, 0.08, 0.9, 0.12], order: 5, text: "Attention Is All You Need" },
    { id: "b6", label: "text", bbox: [0.1, 0.25, 0.9, 0.55], order: 6, text: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks." }
  ];
  const { blocks } = reconcilePage(mm, text);
  const texts = blocks.map((block) => block.text);
  for (const sentence of [
    "Attention Is All You Need",
    "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
    "Equal contribution. Listing order is random.",
    "Work performed while at Google Brain.",
    "Work performed while at Google Research."
  ]) {
    assert.equal(texts.filter((text) => text === sentence).length, 1, sentence);
  }
  const titleAt = blocks.findIndex((block) => block.label === "title");
  const noteAt = blocks.findIndex((block) => block.label === "footnote");
  assert.ok(titleAt >= 0 && noteAt > titleAt);
  const structure = {
    title: "Attention Is All You Need",
    abstract: { heading: "Abstract", body: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks." },
    rest: [{ role: "other", text: "Equal contribution. Listing order is random." }]
  };
  assert.equal(blockCoveredByStructure({ id: "p1-b1", label: "text", text: "Attention Is All You Need" }, structure), true);
  assert.equal(blockCoveredByStructure({ id: "x", label: "text", text: "This paragraph stays on the page after the shell." }, structure), false);
  const duped = dedupeSwappedBlocks([
    ...blocks,
    { id: "oi-structure:title", text: "Attention Is All You Need" },
    { id: "oi-structure:abstract.body", text: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks." },
    { id: "oi-structure:rest.0.text", text: "Equal contribution. Listing order is random." }
  ]);
  assert.equal(duped.some((block) => String(block.id).startsWith("oi-structure:")), false);
  assert.equal(swapNeedsRepaint({ mode: "diff", ops: [{ op: "keep", id: "b2" }] }, ["b2", "p1-b12"]), true);
  assert.equal(swapNeedsRepaint({ mode: "diff", ops: [{ op: "keep", id: "b2" }, { op: "replace", id: "b6", fromId: "p1-b11" }] }, ["b2", "p1-b11"]), false);
});

test("the viewer repaints a multimodal page instead of leaving the text layer up", () => {
  const viewer = readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "pdf/viewer.js"), "utf8");
  const swap = viewer.slice(viewer.indexOf("function replaceMmLayout"), viewer.indexOf("async function pdfByteHash"));
  assert.match(swap, /clearSlotPainted/);
  assert.match(swap, /swapNeedsRepaint/);
  assert.match(swap, /enqueueUncoveredPage/);
  assert.match(swap, /mmPhase === "rebuilding"/);
  const paint = viewer.slice(viewer.indexOf("function appendFixtureReadout"), viewer.indexOf("function paintBlockMark"));
  assert.match(paint, /MM_PAGE_MODE/);
  assert.match(paint, /block\.flowHost/);
  assert.match(paint, /aliasClaimed/);
});
