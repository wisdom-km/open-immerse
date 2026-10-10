import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";
import { isTranslatableBlock } from "../lib/pdf-blocks.js";
import { applySavedPairs, pairsFromResults } from "../lib/pdf-library.js";
import { cacheableLayout, layoutCacheKey } from "../lib/pdf-layout-client.js";
import { buildBlockPairs, pairIdFor, sharePair } from "../lib/pdf-pairing.js";
import {
  BID_VERSION,
  assignBids,
  bidSeed,
  bidText,
  blockSrcHead,
  blockSrcHash,
  isBid,
  resolveBlockAnchor,
  setOcrBlockPairing,
  stampLayoutBids
} from "../lib/pdf-block-id.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const attentionPath = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const ATTENTION_SHA = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
const sample = JSON.parse(readFileSync(join(root, "tests/fixtures/pdf-blocks/glm-cloud-sample.json"), "utf8"));
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const viewerLibSrc = readFileSync(join(root, "lib/pdf-viewer.js"), "utf8");
const layoutSrc = readFileSync(join(root, "lib/pdf-layout-client.js"), "utf8");

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

function viewport() {
  return {
    width: 612,
    height: 792,
    convertToViewportRectangle(rect) {
      const [x1, y1, x2, y2] = rect;
      return [x1, 792 - y2, x2, 792 - y1];
    }
  };
}

function clsOf(bid) {
  return /^b1-p\d+-([tmg])/.exec(String(bid || ""))?.[1] || "";
}

function collisionBids(blocks) {
  return (blocks || []).map((block) => block.bid).filter((bid) => (
    /^b1-p[1-9]\d*-[tmg][0-9a-z]{7}-([2-9]|[1-9]\d+)$/.test(bid)
  ));
}

async function loadDocument(path) {
  const bytes = readFileSync(path);
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const pages = [];
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const view = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const layout = textLayerToBlocks({
        items: content.items,
        viewport: view,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      });
      const stamped = stampLayoutBids(number, { ...layout, kind: "blocks" });
      pages.push(stamped);
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

function bidsOf(pages) {
  return pages.map((page) => page.blocks.map((block) => block.bid));
}

function findBlock(pages, id) {
  for (const page of pages) {
    const block = page.blocks.find((item) => item.id === id);
    if (block) return { page: page.page, block };
  }
  return null;
}

test("pairIdFor keeps string ids and uses a block bid", () => {
  assert.equal(pairIdFor(4, "b12"), "p4:b12");
  assert.equal(pairIdFor(0, "b"), "");
  assert.equal(pairIdFor(2, ""), "");
  assert.equal(pairIdFor(4, { id: "p4-b13", bid: "b1-p4-t010gv1t" }), "b1-p4-t010gv1t");
  assert.equal(pairIdFor(4, { id: "p4-b13" }), "p4:p4-b13");
  assert.equal(BID_VERSION, 1);
});

test("same-page duplicate text gets base and base-2", () => {
  const block = { label: "text", text: "same sentence here", sourceText: "same sentence here", bbox: [0.1, 0.2, 0.8, 0.3] };
  const [first, second] = assignBids(3, [block, { ...block, id: "other" }]);
  assert.equal(isBid(first.bid), true);
  assert.equal(second.bid, `${first.bid}-2`);
  assert.equal(first.id, undefined);
  assert.equal(second.id, "other");
});

test("collision suffixes follow reading order when the array is shuffled", () => {
  const upper = {
    id: "upper",
    label: "text",
    sourceText: "Summary A",
    text: "Summary A",
    bbox: [0.18, 0.12, 0.46, 0.16]
  };
  const lower = {
    id: "lower",
    label: "text",
    sourceText: "Summary A",
    text: "Summary A",
    bbox: [0.18, 0.42, 0.46, 0.46]
  };
  const reading = assignBids(21, [upper, lower]);
  const shuffled = assignBids(21, [lower, upper]);
  const bidOf = (rows, id) => rows.find((row) => row.id === id).bid;
  assert.equal(bidOf(shuffled, "upper"), bidOf(reading, "upper"));
  assert.equal(bidOf(shuffled, "lower"), bidOf(reading, "lower"));
  assert.equal(/-[2-9]$/.test(bidOf(reading, "upper")), false);
  assert.match(bidOf(reading, "lower"), /-2$/);
  assert.deepEqual(shuffled.map((row) => row.id), ["lower", "upper"]);
  const bare = { id: "bare", label: "text", sourceText: "post", text: "post" };
  const other = { id: "other", label: "text", sourceText: "post", text: "post" };
  const passed = assignBids(21, [bare, other]);
  assert.match(passed[1].bid, /-2$/);
});

test("formula bid keeps the layout bbox after an ink trim", () => {
  const layout = [0.3514490784313726, 0.5792976515151516, 0.8325989470588235, 0.6269472626262627];
  const trimmed = [0.3562091503267974, 0.5839646464646465, 0.8284313725490197, 0.6205808080808081];
  const block = { id: "p4-b7", label: "formula", bbox: layout };
  assert.equal(assignBids(4, [block])[0].bid, "b1-p4-m0ihblz1");
  assert.equal(assignBids(4, [{ ...block, bbox: trimmed, layoutBbox: layout }])[0].bid, "b1-p4-m0ihblz1");
  assert.equal(assignBids(4, [{ ...block, bbox: trimmed }])[0].bid, "b1-p4-m021wtet");
  const crop = viewerSrc.slice(
    viewerSrc.indexOf("function imageForVisualBlock"),
    viewerSrc.indexOf("function cropFormulaImage")
  );
  assert.ok(crop.indexOf("layoutBbox") >= 0 && crop.indexOf("layoutBbox") < crop.indexOf("formulaInkBbox"));
});

test("bids ignore translation, order, sourceIndex, and text bbox; a letter changes them", () => {
  const block = {
    id: "p4-b13",
    label: "text",
    sourceText: "Instead of performing a single attention function",
    text: "Instead of performing a single attention function",
    bbox: [0.2, 0.5, 0.8, 0.6],
    translation: "旧译文",
    targetLang: "zh-CN",
    sourceIndex: 4
  };
  const [base] = assignBids(4, [block]);
  const shifted = assignBids(4, [
    { id: "p4-b1", label: "formula", bbox: [0.1, 0.1, 0.4, 0.16] },
    {
      ...block,
      id: "p4-b99",
      sourceIndex: 80,
      translation: "另一段译文",
      targetLang: "ja",
      bbox: block.bbox.map((value) => value + 0.002)
    }
  ]);
  assert.equal(shifted[1].bid, base.bid);
  assert.equal(shifted[1].id, "p4-b99");
  assert.notEqual(shifted[0].bid, base.bid);
  const edited = assignBids(4, [{ ...block, sourceText: "Instead of performing a single attension function" }]);
  assert.notEqual(edited[0].bid, base.bid);
  assert.equal(bidSeed({ ...block, label: "heading" }), bidSeed(block));
});

test("stored bid loses to the recomputed bid and is kept as an alias", () => {
  const block = {
    id: "p4-b13",
    label: "text",
    sourceText: "Instead of performing a single attention function",
    text: "Instead of performing a single attention function",
    bbox: [0.2, 0.5, 0.8, 0.6],
    bid: "b1-p4-toldone"
  };
  const layout = stampLayoutBids(4, { page: 4, blocks: [block] });
  assert.equal(layout.bidVersion, 1);
  assert.equal(layout.blocks[0].id, "p4-b13");
  assert.equal(layout.blocks[0].bid, assignBids(4, [block])[0].bid);
  assert.deepEqual(layout.blocks[0].bidAliases, ["b1-p4-toldone"]);
  const again = stampLayoutBids(4, JSON.parse(JSON.stringify(layout)));
  assert.equal(again.blocks[0].bid, layout.blocks[0].bid);
  assert.deepEqual(again.blocks[0].bidAliases, ["b1-p4-toldone"]);
});

test("applySavedPairs matches bid, then sourceId, then text", () => {
  const unit = {
    id: "p4-b13",
    sourceId: "p4-s11cng5c",
    bid: "b1-p4-t010gv1t",
    text: "Instead of performing a single attention function",
    sourceText: "Instead of performing a single attention function"
  };
  const byBid = applySavedPairs([unit], [
    { bid: "b1-p4-t010gv1t", sourceId: "other", text: unit.text, translation: "按 bid" },
    { sourceId: unit.sourceId, text: unit.text, translation: "按 source" }
  ]);
  assert.equal(byBid[0].translation, "按 bid");
  const legacy = applySavedPairs([unit], [{
    id: "p4-b13",
    sourceId: "p4-s11cng5c",
    text: unit.text,
    sourceText: unit.sourceText,
    translation: "旧译文"
  }]);
  assert.equal(legacy[0].translation, "旧译文");
  assert.equal(legacy[0].bid, unit.bid);
  const saved = pairsFromResults(legacy);
  assert.equal(saved[0].bid, unit.bid);
  assert.equal(saved[0].id, "p4-b13");
  const textOnly = applySavedPairs(
    [{ id: "a", text: "Attention", translation: "" }],
    pairsFromResults([{ original: "Attention", translation: "注意力" }])
  );
  assert.equal(textOnly[0].translation, "注意力");
});

test("layout cache key stays on source-v3 and the viewer stamps bids in one place", () => {
  assert.equal(
    layoutCacheKey({ hash: "abc", page: 4, mode: "text-layer" }),
    "oi-pdf-layout:abc:4:text-layer:blocks-1:source-v3"
  );
  assert.match(layoutSrc, /source-v3/);
  assert.equal(layoutSrc.includes("source-v2"), false);
  assert.match(viewerSrc, /stampLayoutBids\(page, layout\)/);
  assert.match(viewerSrc, /dataset\.bid/);
  assert.match(viewerLibSrc, /if \(item\.bid\) extra\.bid = item\.bid/);
  const setPage = viewerSrc.slice(viewerSrc.indexOf("function setPageLayout"), viewerSrc.indexOf("function appendReadoutNode"));
  assert.equal(setPage.includes("assignBids"), false);
});

test("OCR blocks get stable class bids and pair ids", () => {
  const once = stampLayoutBids(1, vendorLayoutToBlocks(sample, { viewport: viewport(), page: 1 }));
  const twice = stampLayoutBids(1, vendorLayoutToBlocks(sample, { viewport: viewport(), page: 1 }));
  assert.equal(once.textSource, "ocr");
  assert.deepEqual(once.blocks.map((block) => clsOf(block.bid)), ["t", "m", "g", "g"]);
  assert.deepEqual(once.blocks.map((block) => block.bid), twice.blocks.map((block) => block.bid));
  assert.equal(once.blocks.every((block) => isBid(block.bid)), true);
  const round = stampLayoutBids(1, JSON.parse(JSON.stringify(cacheableLayout(once))));
  assert.deepEqual(round.blocks.map((block) => block.bid), once.blocks.map((block) => block.bid));
  const built = buildBlockPairs({ page: 1, blocks: once.blocks, pageWidth: 612, pageHeight: 792 });
  assert.deepEqual(built.nodes.map((node) => node.pairId), once.blocks.map((block) => block.bid));
  const mutated = structuredClone(sample);
  mutated.layoutDetails[0].content = "vendor sentence that must be changed";
  const changed = stampLayoutBids(1, vendorLayoutToBlocks(mutated, { viewport: viewport(), page: 1 }));
  assert.notEqual(changed.blocks[0].bid, once.blocks[0].bid);
  assert.equal(changed.blocks[1].bid, once.blocks[1].bid);
  const textHit = resolveBlockAnchor({
    bid: "b1-p1-t0000000",
    page: 1,
    srcHead: blockSrcHead(once.blocks[0].text)
  }, [{ page: 1, blocks: once.blocks }]);
  assert.equal(textHit.status, "text");
  assert.equal(textHit.bid, once.blocks[0].bid);
  const quoted = once.blocks.map((block, index) => (
    index === 0 ? { ...block, translation: "厂商句子已经改写。" } : block
  ));
  const quoteHit = resolveBlockAnchor({
    bid: "b1-p1-t0000000",
    page: 1,
    quote: "已经改写"
  }, [{ page: 1, blocks: quoted }]);
  assert.equal(quoteHit.status, "quote");
  assert.equal(quoteHit.bid, once.blocks[0].bid);
  setOcrBlockPairing(false);
  try {
    assert.equal(pairIdFor(1, { bid: once.blocks[0].bid, label: "text" }), "");
    assert.equal(pairIdFor(1, { id: "p1-b1", bid: once.blocks[0].bid }), once.blocks[0].bid);
  } finally {
    setOcrBlockPairing(true);
  }
});

test("Attention and DPO text-layer bids match the locked reference", { timeout: 120000 }, async (t) => {
  assert.equal(existsSync(attentionPath), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  assert.equal(existsSync(dpoPath), true, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf is missing");
  const attentionBytes = readFileSync(attentionPath);
  assert.equal(createHash("sha256").update(attentionBytes).digest("hex"), ATTENTION_SHA);
  const attention = await loadDocument(attentionPath);
  const again = await loadDocument(attentionPath);
  assert.equal(attention.length, 15);
  assert.equal(attention.reduce((sum, page) => sum + page.blocks.length, 0), 195);
  assert.deepEqual(bidsOf(again), bidsOf(attention));
  const attentionBids = attention.flatMap((page) => page.blocks.map((block) => block.bid));
  assert.equal(attentionBids.length, 195);
  assert.equal(new Set(attentionBids).size, 195);
  assert.equal(attentionBids.every((bid) => isBid(bid)), true);
  assert.deepEqual(collisionBids(attention.flatMap((page) => page.blocks)), []);
  assert.equal(attention.every((page) => page.bidVersion === 1), true);
  const refs = {
    "p4-b13": "b1-p4-t010gv1t",
    "p5-b1": "b1-p5-t1gsw7yq",
    "p4-b12": "b1-p4-t1ejbcw1",
    "p4-b7": "b1-p4-m0ihblz1"
  };
  for (const [id, bid] of Object.entries(refs)) {
    const found = findBlock(attention, id);
    assert.equal(found?.block.bid, bid, id);
    assert.equal(found.block.id, id);
  }
  assert.match(findBlock(attention, "p4-b12").block.text || "", /3\.2\.2/);
  assert.equal(findBlock(attention, "p4-b7").block.label, "formula");

  const page4 = attention.find((page) => page.page === 4);
  const stored = cacheableLayout(page4);
  const stripped = {
    ...JSON.parse(JSON.stringify(stored)),
    blocks: JSON.parse(JSON.stringify(stored.blocks)).map((block) => {
      delete block.bid;
      delete block.bidAliases;
      return block;
    })
  };
  const fromOld = stampLayoutBids(4, stripped);
  assert.deepEqual(fromOld.blocks.map((block) => block.bid), page4.blocks.map((block) => block.bid));
  const round = stampLayoutBids(4, JSON.parse(JSON.stringify(cacheableLayout(page4))));
  assert.deepEqual(round.blocks.map((block) => block.bid), page4.blocks.map((block) => block.bid));

  for (const page of attention) {
    const size = { page: page.page, pageWidth: page.pageWidth || 612, pageHeight: page.pageHeight || 792 };
    const width = page.blocks.find((block) => block.bbox)?.bbox ? 612 : 612;
    const built = buildBlockPairs({
      page: page.page,
      blocks: page.blocks,
      pageWidth: width,
      pageHeight: size.pageHeight
    });
    for (const node of built.nodes) {
      const first = page.blocks.find((block) => node.blockIds?.includes(block.id) || node.memberBids?.includes(block.bid));
      assert.equal(node.pairId, first?.bid || node.memberBids?.[0] || "");
      assert.equal(isBid(node.pairId), true);
    }
  }

  const tail = findBlock(attention, "p4-b13").block;
  const head = findBlock(attention, "p5-b1").block;
  const shifted = assignBids(4, [
    { id: "pad", label: "formula", bbox: [0.1, 0.1, 0.2, 0.14] },
    { ...tail, id: "p4-b99", sourceIndex: 3, translation: "译文", bbox: tail.bbox.map((value) => value + 0.001) }
  ]);
  assert.equal(shifted[1].bid, tail.bid);
  const source = String(tail.sourceText || tail.text);
  const letter = assignBids(4, [{ ...tail, sourceText: `Q${source.slice(1)}` }]);
  assert.notEqual(letter[0].bid, tail.bid);

  const shared = sharePair(tail.bid, [
    { key: "tail", bid: tail.bid, rects: [{ p: 4, x: 72, y: 640, w: 400, h: 40 }] },
    { key: "head", bid: head.bid, rects: [{ p: 5, x: 72, y: 80, w: 400, h: 28 }] }
  ]);
  assert.equal(shared.every((node) => node.pairId === tail.bid), true);
  const firstRect = shared.find((node) => node.pairId === tail.bid)?.rects?.[0] || null;
  assert.equal(firstRect?.p, 4);
  const grouped = resolveBlockAnchor({ bid: head.bid }, [{
    page: 4,
    blocks: [{ bid: tail.bid, memberBids: shared[0].memberBids, page: 4 }]
  }]);
  assert.deepEqual(grouped, { status: "exact", bid: tail.bid, page: 4 });

  const pages = [
    { page: 4, blocks: page4.blocks },
    { page: 5, blocks: attention.find((page) => page.page === 5).blocks }
  ];
  assert.deepEqual(resolveBlockAnchor({ bid: tail.bid, page: 4 }, pages), {
    status: "exact",
    bid: tail.bid,
    page: 4
  });
  assert.deepEqual(resolveBlockAnchor({
    bid: "b1-p4-tmissing",
    page: 4,
    legacy: { pairId: "p4:p4-b13" }
  }, pages), { status: "alias", bid: tail.bid, page: 4 });
  assert.deepEqual(resolveBlockAnchor({
    page: 4,
    legacy: { sourceId: tail.sourceId }
  }, pages), { status: "alias", bid: tail.bid, page: 4 });
  const head64 = blockSrcHead(tail.sourceText || tail.text);
  assert.equal(head64.length <= 64, true);
  assert.equal(blockSrcHash(tail.sourceText || tail.text), blockSrcHash(tail.sourceText || tail.text));
  assert.deepEqual(resolveBlockAnchor({
    bid: "b1-p4-tmissing",
    page: 4,
    srcHead: head64
  }, pages), { status: "text", bid: tail.bid, page: 4 });
  const moved = [
    { page: 4, blocks: page4.blocks.filter((block) => block.id !== tail.id) },
    { page: 5, blocks: [...pages[1].blocks, { ...tail, page: 5 }] }
  ];
  assert.deepEqual(resolveBlockAnchor({
    bid: "b1-p4-tmissing",
    page: 4,
    srcHead: head64
  }, moved), { status: "text", bid: tail.bid, page: 5 });
  const quotedPages = pages.map((entry) => ({
    page: entry.page,
    blocks: entry.blocks.map((block) => (
      block.id === tail.id ? { ...block, translation: "这里是一段不会出现在别处的译文。" } : block
    ))
  }));
  assert.deepEqual(resolveBlockAnchor({
    bid: "b1-p4-tmissing",
    page: 4,
    srcHead: "zzzznotthesource",
    quote: "不会出现在别处"
  }, quotedPages), { status: "quote", bid: tail.bid, page: 4 });
  assert.deepEqual(resolveBlockAnchor({
    bid: "b1-p9-tmissing",
    page: 9,
    srcHead: "zzzznotthesource",
    quote: "完全没有"
  }, pages), { status: "lost", page: 9 });

  const units = page4.blocks.filter(isTranslatableBlock).map((block) => ({
    id: block.id,
    sourceId: block.sourceId,
    bid: block.bid,
    text: block.text,
    sourceText: block.sourceText || block.text
  }));
  const oldPairs = units.map((unit, index) => ({
    id: unit.id,
    sourceId: unit.sourceId,
    text: unit.text,
    sourceText: unit.sourceText,
    translation: `汉块${index} ${unit.text}`,
    status: "verified"
  }));
  const restored = applySavedPairs(units, oldPairs);
  assert.deepEqual(restored.map((unit) => unit.translation), oldPairs.map((pair) => pair.translation));
  assert.deepEqual(restored.map((unit) => unit.bid), units.map((unit) => unit.bid));
  const resaved = pairsFromResults(restored);
  assert.equal(resaved.every((pair) => pair.bid && units.some((unit) => unit.bid === pair.bid)), true);

  const dpo = await loadDocument(dpoPath);
  assert.equal(dpo.length, 27);
  const dpoBlocks = dpo.flatMap((page) => page.blocks);
  assert.equal(dpoBlocks.length, 400);
  const dpoBids = dpoBlocks.map((block) => block.bid);
  assert.equal(dpoBids.every((bid) => isBid(bid)), true);
  assert.equal(new Set(dpoBids).size, 400);
  assert.equal(findBlock(dpo, "p2-b8").block.bid, "b1-p2-t1hmmsbz");
  assert.equal(findBlock(dpo, "p3-b1").block.bid, "b1-p3-t1n7kik7");
  const byBase = new Map();
  for (const block of dpoBlocks) {
    const base = String(block.bid).replace(/-(?:[2-9]|[1-9]\d+)$/, "");
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(block);
  }
  const dupes = [...byBase.entries()].filter(([, blocks]) => blocks.length > 1)
    .map(([base, blocks]) => ({
      base,
      n: blocks.length,
      head: bidText(blocks[0].sourceText || blocks[0].text).slice(0, 40)
    }));
  assert.deepEqual(dupes, [
    { base: "b1-p18-t0xupwgh", n: 2, head: "whichcompletestheproof" },
    { base: "b1-p21-t0vpxjr3", n: 3, head: "post" },
    { base: "b1-p21-t1goer1q", n: 4, head: "summarya" },
    { base: "b1-p21-t1gef5cr", n: 4, head: "summaryb" },
    { base: "b1-p21-t0all1n6", n: 2, head: "firstprovideaonesentencecomparisonofthet" }
  ]);
  for (const [base, blocks] of byBase) {
    if (blocks.length < 2) continue;
    const head = bidText(blocks[0].sourceText || blocks[0].text);
    assert.equal(blocks.every((block) => bidText(block.sourceText || block.text) === head), true, base);
  }
  assert.equal(collisionBids(dpoBlocks).length, 10);
  assert.equal(bidText("⟦f1⟧ Attention").includes("f1"), false);
});
