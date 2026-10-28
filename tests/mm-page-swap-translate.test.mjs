/**
 * v2: multimodal page swap, flag forced on. The reader default is off.
 * Device failure on PR #189 @ 3efed2e.
 * Attention page 1 finished its vision, then the layout write never settled.
 * Pages 2, 11, and 12 stayed on「正在重建本页」and sent no further vision request.
 * The abstract matched a title-structure slot, so it was left out of the
 * post-swap batch. The multimodal page does not paint that shell, and the
 * new bid did not reuse the library row, so the paragraph stayed English.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { applyBlockTranslations } from "../lib/pdf-blocks.js";
import { applySavedPairs } from "../lib/pdf-library.js";
import { createMmPageFlight, detachAfterSwap } from "../lib/mm-page-queue.js";
import { translatePageBlocks, unitsAfterStructure, unitsNeedingTranslation } from "../lib/pdf-viewer.js";

const ABSTRACT = "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.";
const ATTRIBUTION = "Provided proper attribution is provided, Google hereby grants permission to reproduce the paper.";
const AUTHORS = "Ashish Vaswani Google Brain avaswani@google.com Noam Shazeer Google Brain noam@google.com";

function block(id, bid, label, text, extra = {}) {
  return { id, bid, label, text, sourceText: text, ...extra };
}

function unit(entry) {
  return {
    id: entry.id,
    bid: entry.bid,
    text: entry.text,
    sourceText: entry.sourceText || entry.text,
    original: entry.text,
    label: entry.label
  };
}

const structure = {
  title: "Attention Is All You Need",
  abstract: { heading: "Abstract", body: ABSTRACT },
  rest: [{ role: "paragraph", text: ATTRIBUTION }]
};

const record = {
  status: "ok",
  docId: "attention",
  page: 1,
  source: structure,
  structure,
  slotsDone: true
};

function pageLayout(page, blocks) {
  return { mode: "mm-page", kind: "blocks", page, blocks };
}

const page1 = pageLayout(1, [
  block("b1-p1-title", "b1-p1-title", "title", "Attention Is All You Need"),
  block("b1-p1-h", "b1-p1-t12dg02j", "heading", "Abstract"),
  block("b1-p1-abs", "b1-p1-t08yfuug", "text", ABSTRACT),
  block("b1-p1-auth", "b1-p1-t04mw7eo", "text", AUTHORS, { presentation: "byline" }),
  block("b1-p1-attr", "b1-p1-t03ojbhz", "text", ATTRIBUTION)
]);

const page2 = pageLayout(2, [
  block("b1-p2-a", "b1-p2-a", "text", "Self-attention relates every position in the sequence to every other position.")
]);

const page11 = pageLayout(11, [
  block("b1-p11-a", "b1-p11-a", "text", "The encoder is composed of a stack of identical layers.")
]);

const libraryPairs = [
  {
    bid: "old-title",
    text: "Attention Is All You Need",
    sourceText: "Attention Is All You Need",
    translation: "注意力就是你所需要的一切",
    targetLang: "zh-CN"
  },
  {
    bid: "old-abs",
    text: `${ABSTRACT} Extra clause from the previous text-layer cut.`,
    sourceText: `${ABSTRACT} Extra clause from the previous text-layer cut.`,
    translation: "主流的序列转换模型基于复杂的循环或卷积神经网络。",
    targetLang: "zh-CN"
  }
];

function pendingUnits(layout) {
  const units = layout.blocks.map(unit);
  const kept = unitsAfterStructure(layout, units, record, "attention");
  const filled = applySavedPairs(kept, libraryPairs, { targetLang: "zh-CN" });
  return unitsNeedingTranslation(filled, "zh-CN");
}

test("a swapped multimodal page translates structure-sized blocks onto the new bids, and the next pages start while storage is still writing", async () => {
  const sent = [];
  const painted = new Map();
  const visions = [];
  let persistResolved = false;
  let releasePersist = () => {};
  const persistGate = new Promise((resolve) => {
    releasePersist = () => {
      persistResolved = true;
      resolve();
    };
  });

  async function translateLayout(layout) {
    const pending = pendingUnits(layout);
    const translated = await translatePageBlocks(pending, {
      send: async (message) => {
        sent.push({
          page: layout.page,
          texts: message.texts.slice(),
          bids: (message.items || []).map((item) => item.bid)
        });
        return {
          ok: true,
          translations: message.texts.map((text) => `中文:${String(text).slice(0, 24)}`)
        };
      }
    });
    const blocks = applyBlockTranslations(layout.blocks, translated.results);
    painted.set(layout.page, blocks);
    return blocks;
  }

  function task(layout) {
    return detachAfterSwap(async () => {
      visions.push(layout.page);
      await translateLayout(layout);
      return true;
    }, () => persistGate);
  }

  const flight = createMmPageFlight();
  const first = flight.run({ page: 1, role: "current", epoch: 1 }, () => task(page1));
  const second = flight.run({ page: 2, role: "current", epoch: 1 }, () => task(page2));
  const later = flight.run({ page: 11, role: "current", epoch: 1 }, () => task(page11));

  const started = Date.now();
  while (!visions.includes(2) || !visions.includes(11)) {
    if (Date.now() - started > 2000) {
      throw new Error(`later pages never left the queue: ${visions.join(",")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(persistResolved, false);
  assert.deepEqual(visions, [1, 2, 11]);

  const abstractRequest = sent.find((batch) => batch.bids.includes("b1-p1-t08yfuug"));
  assert.ok(abstractRequest, "abstract was not dispatched");
  assert.equal(abstractRequest.texts.some((text) => text.startsWith("The dominant sequence")), true);
  assert.equal(abstractRequest.bids.includes("b1-p1-t04mw7eo"), true);
  assert.equal(abstractRequest.bids.includes("b1-p1-t03ojbhz"), true);

  const painted1 = painted.get(1);
  const abstract = painted1.find((entry) => entry.bid === "b1-p1-t08yfuug");
  const authors = painted1.find((entry) => entry.bid === "b1-p1-t04mw7eo");
  const attribution = painted1.find((entry) => entry.bid === "b1-p1-t03ojbhz");
  assert.match(abstract.translation, /^中文:The dominant sequence/);
  assert.match(authors.translation, /^中文:Ashish Vaswani/);
  assert.match(attribution.translation, /^中文:Provided proper/);
  assert.match(painted.get(2)[0].translation, /^中文:Self-attention relates/);
  assert.equal(painted.get(2)[0].bid, "b1-p2-a");

  const textLayer = { ...page1, mode: "text-layer" };
  const dropped = unitsAfterStructure(textLayer, textLayer.blocks.map(unit), record, "attention")
    .map((entry) => entry.bid);
  assert.equal(dropped.includes("b1-p1-t08yfuug"), false);
  assert.equal(dropped.includes("b1-p1-t04mw7eo"), true);

  releasePersist();
  await first;
  await second;
  await later;
  assert.equal(persistResolved, true);
  assert.equal(flight.active(), 0);
});
