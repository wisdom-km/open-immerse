/**
 * Reopen must hit the multimodal cache. Cold start used to crop before
 * stampLayoutBids, so the row was stored under a temporary id. Reopen
 * hydrated the stamped layout with sharp:false and paid again.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { attachFontRealNames } from "../lib/pdf-mirror.js";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { cacheableLayout } from "../lib/pdf-layout-client.js";
import { createFormulaCache, createMemoryStore, tierRecordKey } from "../lib/formula-cache.js";
import { cropHashOf, unitKeyOf } from "../lib/formula-contract.js";
import { formulaUnitFromBlock, scheduleFormulaBlock } from "../lib/formula-schedule.js";
import { FORMULA_SWITCH_KEYS, formulaChainFlags, normalizeFormulaSettings } from "../lib/formula-settings.js";
import { MM_TIER_VERSION, mmConfigFingerprint } from "../lib/formula-tiers/multimodal.js";
import { loadKatex } from "./helpers/arxiv-paper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const katex = loadKatex();
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG}`;
const SECRET = "sk-reopen-cache-not-a-real-key";

function functionBody(name) {
  const start = viewerSrc.indexOf(`async function ${name}`);
  assert.ok(start >= 0, name);
  const next = viewerSrc.indexOf("\nasync function ", start + 10);
  assert.ok(next > start, name);
  return viewerSrc.slice(start, next);
}

function settingsFor(enabled) {
  return normalizeFormulaSettings({
    [FORMULA_SWITCH_KEYS.tier2]: enabled,
    multimodal: { provider: "openai", apiKey: SECRET, model: "gpt-5.6-luna" }
  });
}

function modelName(settings) {
  return `${settings.multimodal.model}#${mmConfigFingerprint(settings)}`;
}

function identity(block, docHash, page) {
  const unit = formulaUnitFromBlock({ ...block, imageUrl: PNG_URL }, {
    docHash,
    page,
    cropPixels: PNG
  });
  return { unitId: unit.bid, unitKey: unitKeyOf(unit), cropHash: cropHashOf(unit) };
}

async function loadFormulaBlocks(pdfPath) {
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const pages = [];
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      attachFontRealNames(content.items, pdfPage.commonObjs);
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const built = textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      });
      const formulas = (built.blocks || []).filter((block) => block.label === "formula");
      if (formulas.length) pages.push({ page: number, blocks: formulas });
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

function scheduleHooks(settings, cache, sends, docHash) {
  const flags = formulaChainFlags(settings);
  return {
    ...flags,
    docHash,
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: settings.multimodal.model,
    sendVision: async () => {
      sends.count += 1;
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" }),
    cropPngFor: async (block) => ({
      mime: "image/png",
      base64: PNG,
      w: 1,
      h: 1,
      hash: "reopen"
    })
  };
}

async function schedulePages(pages, hooks) {
  const shown = [];
  for (const entry of pages) {
    const stamped = stampLayoutBids(entry.page, { blocks: entry.blocks.map((block) => ({ ...block })) });
    const blocks = [];
    for (const block of stamped.blocks) {
      blocks.push(await scheduleFormulaBlock(block, { ...hooks, page: entry.page }));
    }
    shown.push({ page: entry.page, blocks });
  }
  return shown;
}

function reopenPages(shown) {
  return shown.map((entry) => {
    const stored = cacheableLayout({
      page: entry.page,
      blocks: entry.blocks,
      layoutVersion: "source-v3:5285c7689aa0b873"
    });
    const stamped = stampLayoutBids(entry.page, stored);
    return { page: entry.page, blocks: stamped.blocks.map((block) => ({ ...block })) };
  });
}

test("viewer stamps before it crops, and the model crop stays sharp:false", () => {
  for (const name of ["ingestVendorLayout", "ingestTextLayerLayout", "ingestFixtureLayout"]) {
    const body = functionBody(name);
    const stampAt = body.indexOf("stampLayoutBids(");
    const cropAt = body.indexOf("cropLayoutBlocks(");
    assert.ok(stampAt >= 0 && cropAt > stampAt, name);
    assert.match(body.slice(cropAt, cropAt + 240), /sharp:\s*false/, name);
  }
  const hydrate = functionBody("hydrateMissingVisualCrops");
  assert.match(hydrate, /sharp:\s*false/);
  const crop = functionBody("cropLayoutBlocks");
  assert.match(crop, /sharp:\s*false/);
  assert.match(functionBody("restampArxivPage"), /formulaModelPng\(/);
  assert.equal(MM_TIER_VERSION, "mm-2");
});

test("a cold start and a reopen share unitId and cropHash and send once", async () => {
  const papers = [
    ["dpo", join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf")],
    ["attention", join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf")]
  ];
  const settings = settingsFor(true);
  const store = createMemoryStore();
  const cache = createFormulaCache(store);
  const sends = { count: 0 };
  const hooks = scheduleHooks(settings, cache, sends, "doc-reopen");
  let saved = null;
  for (const [name, path] of papers) {
    const pages = await loadFormulaBlocks(path);
    assert.ok(pages.length > 0, name);
    const raw = pages[0].blocks[0];
    const unstamped = identity(raw, "doc-reopen", pages[0].page);
    assert.match(raw.id, /^p\d+-b\d+$/);
    assert.equal(unstamped.unitId, raw.id);
    const before = sends.count;
    const shown = await schedulePages(pages, hooks);
    const cold = sends.count;
    assert.ok(cold > before, name);
    for (const entry of shown) {
      for (const block of entry.blocks) {
        const row = identity(block, "doc-reopen", entry.page);
        assert.match(row.unitId, /^b1-p/, row.unitId);
        assert.notEqual(row.unitId, block.id);
        assert.notEqual(row.unitKey, unstamped.unitKey);
      }
    }
    await schedulePages(reopenPages(shown), hooks);
    assert.equal(sends.count, cold, `${name} first reopen`);
    await schedulePages(reopenPages(shown), hooks);
    assert.equal(sends.count, cold, `${name} second reopen`);
    await schedulePages([shown[0]], hooks);
    assert.equal(sends.count, cold, `${name} page turn`);
    saved = shown;
  }
  const beforeTab = sends.count;
  const otherTab = createFormulaCache(store);
  await schedulePages([saved[0]], scheduleHooks(settings, otherTab, sends, "doc-reopen"));
  assert.equal(sends.count, beforeTab, "new tab");

  const offSends = { count: 0 };
  const offPages = await loadFormulaBlocks(papers[0][1]);
  await schedulePages(offPages.slice(0, 1), scheduleHooks(settingsFor(false), createFormulaCache(createMemoryStore()), offSends, "doc-off"));
  assert.equal(offSends.count, 0, "auto-translate off");

  const vendorPage = vendorLayoutToBlocks({
    page: 3,
    layoutDetails: [{ label: "formula", bbox_2d: [0.15, 0.42, 0.55, 0.50], content: "ignored" }]
  }, {
    page: 3,
    viewport: {
      width: 612,
      height: 792,
      convertToViewportRectangle(rect) {
        const [x1, y1, x2, y2] = rect;
        return [x1, 792 - y2, x2, 792 - y1];
      }
    },
    items: [
      { str: "Attention", x: 120, y: 430, width: 70, height: 12 },
      { str: "(Q, K, V)", x: 192, y: 430, width: 70, height: 12 }
    ]
  });
  const vendorFormula = vendorPage.blocks.find((block) => block.label === "formula");
  assert.ok(vendorFormula);
  const vendorBefore = identity(vendorFormula, "doc-vendor", 3);
  assert.notEqual(vendorBefore.unitId, "");
  const vendorSends = { count: 0 };
  const vendorHooks = scheduleHooks(settings, createFormulaCache(createMemoryStore()), vendorSends, "doc-vendor");
  const vendorShown = await schedulePages([{ page: 3, blocks: [vendorFormula] }], vendorHooks);
  const vendorCold = vendorSends.count;
  assert.equal(vendorCold, 1);
  const vendorId = identity(vendorShown[0].blocks[0], "doc-vendor", 3);
  assert.match(vendorId.unitId, /^b1-p3-m/);
  assert.notEqual(vendorId.unitId, vendorBefore.unitId);
  await schedulePages(reopenPages(vendorShown), vendorHooks);
  assert.equal(vendorSends.count, vendorCold, "vendor reopen");

  const tempKey = tierRecordKey({
    docHash: "doc-reopen",
    bid: "p3-b12",
    bbox: [0.1, 0.2, 0.3, 0.4],
    crop: { pixels: PNG }
  }, { id: "multimodal", version: MM_TIER_VERSION }, modelName(settings));
  const live = identity(saved[0].blocks[0], "doc-reopen", saved[0].page);
  assert.equal(tempKey.includes(":p3-b12:"), true);
  assert.equal(tempKey.includes(live.unitId), false);
  assert.equal(MM_TIER_VERSION, "mm-2");
});
