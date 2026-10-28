// v1: multimodal page swap is off. Empty mode, a stored mm-page mode, and a
// settings row the local-ocr migration already cleared all open as the text
// layer. No multimodal request, no mm cache, and the old library pairs stay.
// v2 tests live in tests/mm-*.test.mjs and tests/pdf-device-swap.test.mjs
// and call the swap with the flag forced on (?oiMmSwap=1 or mmPageSwap: true).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { resolveLayoutMode } from "../lib/pdf-layout-client.js";
import { migrateLocalOcrToMultimodal } from "../lib/formula-pipeline.js";
import { MM_PAGE_SWAP_DEFAULT, mmPageSwapEnabled } from "../lib/mm-page.js";
import { pageNeedsMultimodalQueue } from "../lib/mm-page-invalidate.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const papers = [
  ["Attention", join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf")],
  ["DPO", join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf")],
  ["TXL", "/tmp/oi-flow-corpus/1901.02860/paper.pdf"]
];

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

async function textLayerPage(pdfPath, pageNumber) {
  const bytes = readFileSync(pdfPath);
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  try {
    const pdfPage = await doc.getPage(pageNumber);
    const content = await pdfPage.getTextContent();
    const viewport = pdfPage.getViewport({ scale: 1 });
    return stampLayoutBids(pageNumber, textLayerToBlocks({ items: content.items, viewport, page: pageNumber }));
  } finally {
    await doc.destroy();
  }
}

test("v1 default is the text layer, including a migrated empty mode", () => {
  assert.equal(MM_PAGE_SWAP_DEFAULT, false);
  assert.equal(mmPageSwapEnabled(undefined), false);
  assert.equal(mmPageSwapEnabled({}), false);
  assert.equal(mmPageSwapEnabled({ pdfLayoutMmMigrated: "mp-1", pdfLayout: { mode: "" } }), false);
  assert.equal(mmPageSwapEnabled({ mmPageSwap: true }), true);
  assert.equal(resolveLayoutMode(null, ""), "text-layer");
  assert.equal(resolveLayoutMode({ mode: "" }, ""), "text-layer");
  assert.equal(resolveLayoutMode({ mode: "mm-page" }, ""), "text-layer");
  assert.equal(resolveLayoutMode({ mode: "mm-page" }, "mm-page"), "text-layer");
  assert.equal(resolveLayoutMode(null, "", { mmPageSwap: true }), "mm-page");
  const held = migrateLocalOcrToMultimodal({
    pdfLayout: { mode: "local-ocr", explicit: true }
  });
  assert.equal(held.reset, false);
  assert.equal(held.changed, false);
  assert.equal(held.settings.pdfLayout.mode, "local-ocr");
  assert.equal(resolveLayoutMode(held.settings.pdfLayout, ""), "local-ocr");
  const migrated = { mode: "" };
  assert.equal(resolveLayoutMode(migrated, ""), "text-layer");
  assert.equal(pageNeedsMultimodalQueue({ configured: false, layout: { mode: "text-layer", blocks: [{ text: "Abstract" }] } }), false);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const engine = viewer.slice(viewer.indexOf("function pdfEngineMode"), viewer.indexOf("function engineModeOf"));
  assert.match(engine, /mmPageSwap: mmPageSwapOn/);
  const ingest = viewer.slice(viewer.indexOf("async function ingestPageLayout"), viewer.indexOf("function pageHasSettledTranslation"));
  assert.match(ingest, /mode === MM_PAGE_MODE && mmPageSwapOn/);
  assert.equal(ingest.includes("readStoredLayout"), false);
  assert.equal(ingest.includes("writeStoredLayout"), false);
  assert.equal(ingest.includes("discardStalePageForMultimodal"), false);
  assert.match(viewer, /oiMmSwap/);
});

test("v1 reopen of Attention, TXL, and DPO keeps the text-layer blocks and the old pairs", async () => {
  const counts = {};
  for (const [name, path] of papers) {
    assert.equal(existsSync(path), true, `${name} fixture is missing`);
    for (const page of [1, 2]) {
      const layout = await textLayerPage(path, page);
      const notes = { anchor: `p${page}` };
      const pairs = (layout.blocks || []).filter((block) => block?.bid && block.text).slice(0, 4).map((block) => ({
        bid: block.bid,
        text: block.text,
        sourceText: block.text,
        translation: `旧译文 ${block.bid}`
      }));
      const mode = resolveLayoutMode({ mode: "mm-page", pagePipeline: "mp-1" }, "mm-page");
      assert.equal(mode, "text-layer");
      assert.equal(pageNeedsMultimodalQueue({ configured: mode === "mm-page", layout }), false);
      assert.ok(layout.blocks.length > 0, `${name} p${page} reopened empty`);
      assert.equal(pairs.length > 0, true, `${name} p${page} dropped its library pairs`);
      assert.equal(pairs[0].translation.startsWith("旧译文"), true);
      assert.equal(notes.anchor, `p${page}`);
      counts[`${name}-p${page}`] = layout.blocks.length;
    }
  }
  assert.deepEqual(counts, {
    "Attention-p1": 14,
    "Attention-p2": 15,
    "DPO-p1": 13,
    "DPO-p2": 7,
    "TXL-p1": 9,
    "TXL-p2": 15
  });
});
