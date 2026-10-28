// Page n arrives after page n+1 already showed the continuation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { attachFontRealNames } from "../lib/pdf-mirror.js";
import { resolveBlockAnchor, stampLayoutBids } from "../lib/pdf-block-id.js";
import { joinPageBoundary } from "../lib/pdf-flow-join.js";
import { claimArrivedPageContinuation, priorPageNeedsText } from "../lib/pdf-late-page-join.js";

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

const TAIL_BID = "b1-p4-t031i7d0";
const HOST_ID = "p3-b9";
const SHORT_BID = "b1-p3-t1w3vhah";
const TAIL = "of the values, where the weight assigned to each value is computed by a compatibility function of the query with the corresponding key.";

function paintFields(blocks) {
  return (blocks || []).map((block) => ({
    id: block.id,
    bid: block.bid,
    text: block.text || "",
    flowHost: block.flowHost || "",
    aliases: [...(block.bidAliases || [])].sort()
  }));
}

test("a late page 3 claims the continuation page 4 already showed", async () => {
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/Attention_Is_All_You_Need.pdf"))),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  async function load(pageNumber) {
    const pdfPage = await doc.getPage(pageNumber);
    const content = await pdfPage.getTextContent();
    attachFontRealNames(content.items, pdfPage.commonObjs);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const ops = await pdfPage.getOperatorList();
    return stampLayoutBids(pageNumber, textLayerToBlocks({
      items: content.items,
      viewport,
      images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
      page: pageNumber
    }));
  }
  const page3 = await load(3);
  const page4 = await load(4);
  const hostBefore = page3.blocks.find((block) => block.id === HOST_ID);
  const tailBefore = page4.blocks.find((block) => block.bid === TAIL_BID);
  assert.equal(hostBefore.bid, SHORT_BID);
  assert.equal(tailBefore.text.includes(TAIL), true);
  assert.equal(hostBefore.text.includes(TAIL), false);

  const claimed = claimArrivedPageContinuation(page3.blocks, page4.blocks);
  assert.equal(claimed.repaintCurrent, true);
  assert.equal(claimed.repaintNext, true);
  const stampedCurrent = stampLayoutBids(3, { blocks: claimed.current }).blocks;
  const stampedNext = stampLayoutBids(4, { blocks: claimed.next }).blocks;
  const ordered = joinPageBoundary(page3.blocks.map((block) => ({ ...block })), page4.blocks.map((block) => ({ ...block })));
  const orderedCurrent = stampLayoutBids(3, { blocks: ordered.previous }).blocks;
  const orderedNext = stampLayoutBids(4, { blocks: ordered.next }).blocks;
  assert.deepEqual(paintFields(stampedCurrent), paintFields(orderedCurrent));
  assert.deepEqual(paintFields(stampedNext), paintFields(orderedNext));

  const host = stampedCurrent.find((block) => block.id === HOST_ID);
  const tail = stampedNext.find((block) => block.id === tailBefore.id);
  assert.match(host.text, /weighted sum of the values/);
  assert.equal((host.text.match(/of the values, where/g) || []).length, 1);
  assert.equal(tail.bid, TAIL_BID);
  assert.equal(tail.flowHost, HOST_ID);
  assert.ok(host.bidAliases.includes(TAIL_BID));
  assert.ok(host.bidAliases.includes(SHORT_BID) || host.bid === SHORT_BID);
  const pages = [
    { page: 3, blocks: stampedCurrent },
    { page: 4, blocks: stampedNext }
  ];
  const tailAnchor = resolveBlockAnchor({ bid: TAIL_BID, page: 4 }, pages);
  assert.equal(tailAnchor.status, "exact");
  assert.equal(tailAnchor.bid, TAIL_BID);
  assert.equal(tailAnchor.page, 4);
  const hostAnchor = resolveBlockAnchor({ bid: SHORT_BID, page: 3 }, pages);
  assert.equal(hostAnchor.page, 3);
  assert.ok(hostAnchor.status === "exact" || hostAnchor.status === "alias");
  assert.equal(hostAnchor.bid, host.bid);

  const again = claimArrivedPageContinuation(stampedCurrent, stampedNext);
  assert.equal(again, null);
  const refused = claimArrivedPageContinuation(page3.blocks, page4.blocks, {
    pairs: [{ bid: SHORT_BID, text: hostBefore.text, translation: "旧译" }]
  });
  assert.equal(refused, null);
  assert.equal(page4.blocks.find((block) => block.bid === TAIL_BID).flowHost, undefined);
  await doc.destroy();
});

test("page 4 still needs page 3 when its first sentence is only a tail", async () => {
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/Attention_Is_All_You_Need.pdf"))),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const pdfPage = await doc.getPage(4);
  const content = await pdfPage.getTextContent();
  attachFontRealNames(content.items, pdfPage.commonObjs);
  const viewport = pdfPage.getViewport({ scale: 1 });
  const ops = await pdfPage.getOperatorList();
  const page4 = stampLayoutBids(4, textLayerToBlocks({
    items: content.items,
    viewport,
    images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
    page: 4
  }));
  assert.equal(priorPageNeedsText(null, page4.blocks), true);
  assert.equal(priorPageNeedsText([], page4.blocks), true);
  assert.equal(priorPageNeedsText([{ text: "already read" }], page4.blocks), false);
  assert.equal(priorPageNeedsText(null, [{ id: "p4-b9", label: "text", text: "The encoder stacks layers." }]), false);
  await doc.destroy();
});
