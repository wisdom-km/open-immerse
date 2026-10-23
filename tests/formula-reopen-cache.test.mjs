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
import { FORMULA_INK_PAD_PX, measureFormulaCrop, textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { attachFontRealNames } from "../lib/pdf-mirror.js";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { cacheableLayout } from "../lib/pdf-layout-client.js";
import { createFormulaCache, createMemoryStore, tierRecordKey } from "../lib/formula-cache.js";
import { cropHashOf, unitKeyOf } from "../lib/formula-contract.js";
import { sha256Hex } from "../lib/sha256.js";
import { formulaUnitFromBlock, scheduleFormulaBlock } from "../lib/formula-schedule.js";
import { cropPngFor } from "../lib/formula-crop-png.js";
import { rasterCropRect, CROP_SCALE } from "../lib/pdf-blocks.js";
import { formulaDevicePixels, formulaDisplayCssSize } from "../lib/pdf-formula-raster.js";
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
    assert.doesNotMatch(body.slice(cropAt, cropAt + 200), /sharp:\s*false/, `${name} display`);
  }
  const hydrate = functionBody("hydrateMissingVisualCrops");
  assert.match(hydrate.slice(hydrate.indexOf("cropLayoutBlocks("), hydrate.indexOf("cropLayoutBlocks(") + 240), /sharp:\s*false/);
  const crop = functionBody("formulaModelDisplayCrop");
  const rememberAt = crop.indexOf("rememberFormulaModelCrop");
  const sharpAt = crop.indexOf("renderSharpVisualCrop");
  const pinnedAt = crop.indexOf("{ ...options, sharp: false }");
  assert.ok(pinnedAt >= 0 && rememberAt > pinnedAt && sharpAt > rememberAt);
  assert.match(functionBody("cropLayoutBlocks"), /formulaModelDisplayCrop\(/);
  assert.match(functionBody("restampArxivPage"), /formulaModelPng\(/);
  assert.equal(functionBody("refreshFormulaCropsForDisplay").includes("scheduleFormulaBlock"), false);
  assert.equal(MM_TIER_VERSION, "mm-4");
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
  assert.equal(offSends.count, 0, "multimodal off");

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
  assert.equal(MM_TIER_VERSION, "mm-4");
});

// Letter page at the page-raster scale. A second measure of the stored trim
// moves the pixel rect; the numbers come from that measurement, not literals.
const DRIFT_LAYOUT = [0.2075, 0.1975, 0.44, 0.23625];
const PAGE_PNG = { w: 80, h: 40 };
const SHARP_PNG = { 1: { w: 12, h: 8 }, 2: { w: 160, h: 80 } };

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function pngDataUrl(width, height) {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  bytes[16] = (width >>> 24) & 255;
  bytes[17] = (width >>> 16) & 255;
  bytes[18] = (width >>> 8) & 255;
  bytes[19] = width & 255;
  bytes[20] = (height >>> 24) & 255;
  bytes[21] = (height >>> 16) & 255;
  bytes[22] = (height >>> 8) & 255;
  bytes[23] = height & 255;
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function driftRaster() {
  const width = 612 * CROP_SCALE;
  const height = 792 * CROP_SCALE;
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  const left = Math.floor(DRIFT_LAYOUT[0] * width) + 4;
  const top = Math.floor(DRIFT_LAYOUT[1] * height) + 4;
  const right = Math.ceil(DRIFT_LAYOUT[2] * width) - 4;
  const bottom = Math.ceil(DRIFT_LAYOUT[3] * height) - 4;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 255;
    }
  }
  const image = { width, height, data };
  return {
    image,
    raster: {
      canvas: {
        width,
        height,
        getContext() {
          return { getImageData: () => image };
        }
      }
    }
  };
}

function loadImageForVisualBlock(source) {
  const body = ["formulaPagePixels", "formulaInkBbox", "imageForVisualBlock"]
    .map((name) => extractFunction(source, name))
    .join("\n");
  const factory = new Function(
    "measureFormulaCrop",
    "redrawFormulaGlyphs",
    "cropFormulaImage",
    `const formulaRasterPixels = new WeakMap();\n${body}\nreturn imageForVisualBlock;`
  );
  return factory(measureFormulaCrop, () => "", (canvas, block) => {
    const rect = rasterCropRect(block.bbox, canvas.width, canvas.height);
    block.cropRect = { sw: rect.sw, sh: rect.sh };
    return pngDataUrl(rect.sw, rect.sh);
  });
}

function scanPast(source, from, openCh, closeCh) {
  let depth = 0;
  let quote = "";
  let escape = false;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractAny(source, name) {
  const asyncAt = source.indexOf(`async function ${name}(`);
  const syncAt = source.indexOf(`function ${name}(`);
  const start = asyncAt >= 0 && (syncAt < 0 || asyncAt <= syncAt) ? asyncAt : syncAt;
  assert.ok(start >= 0, name);
  const paramsAt = source.indexOf("(", start);
  const paramsEnd = scanPast(source, paramsAt, "(", ")");
  assert.ok(paramsEnd > paramsAt, name);
  const bodyAt = source.indexOf("{", paramsEnd);
  const bodyEnd = scanPast(source, bodyAt, "{", "}");
  assert.ok(bodyEnd > bodyAt, name);
  return source.slice(start, bodyEnd + 1);
}

function pngSize(dataUrl) {
  const base64 = String(dataUrl).split(",")[1] || "";
  const buf = Buffer.from(base64, "base64");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function loadFormulaCropRuntime(source, stubs) {
  const body = [
    "modelPngPayloadUrl",
    "formulaModelCropId",
    "rememberFormulaModelCrop",
    "formulaModelPng",
    "formulaModelDisplayCrop"
  ].map((name) => extractAny(source, name)).join("\n");
  const factory = new Function(
    "cropPngFor",
    "withRasterCrop",
    "renderSharpVisualCrop",
    `let docId = 1;\nconst formulaModelCrops = new Map();\n${body}\nreturn { formulaModelPng, formulaModelDisplayCrop, formulaModelCrops, setDocId(n) { docId = n; } };`
  );
  return factory(cropPngFor, stubs.withRasterCrop, stubs.renderSharpVisualCrop);
}

function watchStore(inner, keys) {
  return {
    ...inner,
    async commitTier(key, record) {
      keys.push(String(key));
      return inner.commitTier(key, record);
    }
  };
}

test("a 1px ink trim round trip sends once", async () => {
  const source = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const { image, raster } = driftRaster();
  const pad = FORMULA_INK_PAD_PX.display;
  const once = measureFormulaCrop(DRIFT_LAYOUT, image).bbox;
  const twice = measureFormulaCrop(once, image).bbox;
  const onceRect = rasterCropRect(once, image.width, image.height);
  const twiceRect = rasterCropRect(twice, image.width, image.height);
  assert.notEqual(
    `${onceRect.sw}x${onceRect.sh}`,
    `${twiceRect.sw}x${twiceRect.sh}`,
    `ink trim round trip did not move a pixel at ${image.width}×${image.height}, CROP_SCALE=${CROP_SCALE}, pad=${pad}`
  );

  const trim = loadImageForVisualBlock(source);
  const cold = stampLayoutBids(3, {
    blocks: [{
      id: "p3-b12",
      label: "formula",
      bbox: DRIFT_LAYOUT.slice(),
      display: true,
      sourceText: "E=mc^2"
    }]
  }).blocks[0];
  trim(raster, cold);
  assert.deepEqual([cold.cropRect.sw, cold.cropRect.sh], [onceRect.sw, onceRect.sh], "crop pixels");
  cold.imageUrl = pngDataUrl(cold.cropRect.sw, cold.cropRect.sh);
  const sends = { count: 0 };
  const settings = settingsFor(true);
  const hooks = {
    ...scheduleHooks(settings, createFormulaCache(createMemoryStore()), sends, "doc-pixel"),
    withRasterCrop: async (item) => item,
    cropPngFor
  };
  await scheduleFormulaBlock(cold, { ...hooks, page: 3 });
  assert.equal(sends.count, 1, "cold");

  const stored = cacheableLayout({
    page: 3,
    blocks: [cold],
    layoutVersion: "source-v3:5285c7689aa0b873"
  }).blocks[0];
  const reopen = stampLayoutBids(3, { blocks: [{ ...stored }] }).blocks[0];
  trim(raster, reopen);
  assert.deepEqual([reopen.cropRect.sw, reopen.cropRect.sh], [onceRect.sw, onceRect.sh], "crop pixels");
  assert.notDeepEqual([reopen.cropRect.sw, reopen.cropRect.sh], [twiceRect.sw, twiceRect.sh], "crop pixels");
  assert.equal(reopen.bid, cold.bid, "unit id");
  reopen.imageUrl = pngDataUrl(reopen.cropRect.sw, reopen.cropRect.sh);
  await scheduleFormulaBlock(reopen, { ...hooks, page: 3 });
  const reopenHash = cropHashOf({ crop: { pixels: (await cropPngFor(reopen)).base64 } });
  const coldHash = cropHashOf({ crop: { pixels: (await cropPngFor(cold)).base64 } });
  assert.equal(reopenHash, coldHash, "crop hash");
  assert.equal(sends.count, 1, "reopen sends");
});

test("cold start display ratio stays on the sharp redraw", async () => {
  const source = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const bbox = [0.2, 0.4, 0.8, 0.43];
  const css = formulaDisplayCssSize({
    block: { label: "formula", bbox },
    pageWidth: 612,
    pageHeight: 792,
    readerFontPx: 16,
    sourceBodyPt: 10,
    columnPx: 320
  });
  assert.ok(css?.cssHeight > 0, "css");
  const plan = formulaDevicePixels({
    cssWidth: css.cssWidth,
    cssHeight: css.cssHeight,
    pdfWidth: css.pdfWidth,
    pdfHeight: css.pdfHeight,
    mirrorZoom: 1,
    devicePixelRatio: 2
  });
  const sharpRatio = plan.pixelHeight / css.cssHeight;
  const pageRatio = (css.pdfHeight * CROP_SCALE) / css.cssHeight;
  assert.ok(Math.abs(sharpRatio - pageRatio) > 0.2, `sharp ${sharpRatio} page ${pageRatio}`);
  const pageW = Math.max(1, Math.round(css.pdfWidth * CROP_SCALE));
  const pageH = Math.max(1, Math.round(css.pdfHeight * CROP_SCALE));
  const runtime = loadFormulaCropRuntime(source, {
    withRasterCrop: async (_raster, _page, item) => ({
      ...item,
      imageUrl: pngDataUrl(pageW, pageH),
      surface: "png"
    }),
    renderSharpVisualCrop: async () => pngDataUrl(plan.pixelWidth, plan.pixelHeight)
  });
  const shown = await runtime.formulaModelDisplayCrop(null, null, {
    id: "p1-b1",
    bid: "b1-p1-mdisplay",
    label: "formula",
    bbox,
    display: true
  }, 1, {});
  const shownRatio = pngSize(shown.imageUrl).h / css.cssHeight;
  assert.equal(Number(shownRatio.toFixed(3)), Number(sharpRatio.toFixed(3)), "cold start display ratio");
  assert.equal(shown.surface, "redraw", "display redraw");
  assert.equal(functionBody("refreshFormulaCropsForDisplay").includes("scheduleFormulaBlock"), false);
});

test("bytes sent to the model hash to the cache cropHash at DPR1 and DPR2", async () => {
  const source = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const settings = settingsFor(true);
  const sentByDpr = {};
  for (const dpr of [1, 2]) {
    const pagePng = pngDataUrl(PAGE_PNG.w, PAGE_PNG.h);
    const sharpPng = pngDataUrl(SHARP_PNG[dpr].w, SHARP_PNG[dpr].h);
    const runtime = loadFormulaCropRuntime(source, {
      withRasterCrop: async (_raster, _page, item) => ({ ...item, imageUrl: pagePng, surface: "png" }),
      renderSharpVisualCrop: async () => sharpPng
    });
    const keys = [];
    const sends = { count: 0 };
    const images = [];
    const cache = createFormulaCache(watchStore(createMemoryStore(), keys));
    const block = stampLayoutBids(3, {
      blocks: [{
        id: "p3-b12",
        label: "formula",
        bbox: [0.2, 0.4, 0.8, 0.43],
        display: true,
        sourceText: "E=mc^2"
      }]
    }).blocks[0];
    const hooks = {
      ...scheduleHooks(settings, cache, sends, `doc-dpr-${dpr}`),
      withRasterCrop: (item) => runtime.formulaModelDisplayCrop(null, null, item, 3, {}),
      cropPngFor: (item, cropHooks) => runtime.formulaModelPng(3, item, cropHooks),
      sendVision: async (req) => {
        sends.count += 1;
        images.push(req.images[0].base64);
        return { ok: true, text: "x" };
      }
    };
    const shown = await scheduleFormulaBlock(block, { ...hooks, page: 3 });
    assert.equal(shown.imageUrl, sharpPng, "display redraw");
    assert.equal(shown.surface, "redraw", "display redraw");
    assert.equal(sends.count, 1, "cold");
    const sent = images[0];
    const sentHash = sha256Hex(sent).slice(0, 12);
    const keyHash = keys[0]?.split(":").at(-1);
    assert.equal(sentHash, keyHash, "cropHash");
    assert.equal(sentHash, sha256Hex(pagePng.split(",")[1]).slice(0, 12), "sent hash");
    const size = pngSize(`data:image/png;base64,${sent}`);
    assert.deepEqual([size.w, size.h], [PAGE_PNG.w, PAGE_PNG.h], "sent pixels");
    assert.ok(size.w > 14 && size.h > 14, "short side");
    sentByDpr[dpr] = { sentHash, runtime, hooks, shown, sends };
    runtime.formulaModelCrops.clear();
    runtime.setDocId(2);
    const stored = cacheableLayout({
      page: 3,
      blocks: [shown],
      layoutVersion: "source-v3:5285c7689aa0b873"
    }).blocks[0];
    const reopened = stampLayoutBids(3, { blocks: [{ ...stored }] }).blocks[0];
    await scheduleFormulaBlock(reopened, {
      ...hooks,
      page: 3,
      withRasterCrop: (item) => runtime.formulaModelDisplayCrop(null, null, item, 3, { sharp: false })
    });
    assert.equal(sends.count, 1, "reopen sends");
  }
  assert.equal(sentByDpr[1].sentHash, sentByDpr[2].sentHash, "dpr");
});
