/**
 * F7W-1. The model PNG is a vision-only tight crop at scale 4 with a larger pad.
 * Screen crops stay on CROP_SCALE and FORMULA_INK_PAD_PX. No paragraph arm.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CROP_SCALE, rasterCropRect } from "../lib/pdf-blocks.js";
import { createFormulaCache, createMemoryStore, tierRecordKey } from "../lib/formula-cache.js";
import { cropHashOf, unitKeyOf } from "../lib/formula-contract.js";
import { scheduleFormulaBlock } from "../lib/formula-schedule.js";
import { FORMULA_SWITCH_KEYS, formulaChainFlags, normalizeFormulaSettings } from "../lib/formula-settings.js";
import {
  FORMULA_VISION_SYSTEM,
  MM_TIER_VERSION,
  formulaVisionText,
  mmConfigFingerprint
} from "../lib/formula-tiers/multimodal.js";
import { createDefaultTiers } from "../lib/formula-tiers/index.js";
import {
  formulaInkMeasureOptions,
  formulaInkPadPx,
  formulaRasterPlan,
  formulaRegionWindow
} from "../lib/pdf-formula-raster.js";
import {
  FORMULA_INK_PAD_PX,
  boxesInCrop,
  measureFormulaCrop
} from "../lib/pdf-text-layer.js";
import { sha256Hex } from "../lib/sha256.js";
import {
  VISION_CROP_SCALE,
  VISION_INK_PAD_PX,
  measureVisionRegion,
  visionCropFor,
  visionCropSpec,
  visionPadFor,
  visionRasterPlan
} from "../lib/formula-vision-crop.js";
import { loadKatex } from "./helpers/arxiv-paper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const katex = loadKatex();
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SECRET = "sk-vision-crop-test-not-a-real-key";

function paper(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = paint(x, y, width, height);
      if (!pixel) continue;
      const index = (y * width + x) * 4;
      data[index] = pixel[0];
      data[index + 1] = pixel[1];
      data[index + 2] = pixel[2];
      data[index + 3] = pixel.length > 3 ? pixel[3] : 255;
    }
  }
  return { data, width, height };
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

function pngBase64(dataUrl) {
  return String(dataUrl).split(",")[1] || "";
}

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

function settingsFor() {
  return normalizeFormulaSettings({
    [FORMULA_SWITCH_KEYS.tier2]: true,
    multimodal: { provider: "openai", apiKey: SECRET, model: "gpt-5.6-luna" }
  });
}

function inkAt(image, box) {
  const [x0, y0, x1, y1] = box;
  return (x, y) => {
    const nx = x / image.width;
    const ny = y / image.height;
    if (nx >= x0 && nx < x1 && ny >= y0 && ny < y1) return [0, 0, 0, 255];
    return null;
  };
}

test("vision scale is 4 and the pad is larger in the screen pixel unit", () => {
  assert.equal(CROP_SCALE, 2);
  assert.equal(VISION_CROP_SCALE, 4);
  assert.equal(FORMULA_INK_PAD_PX.inline, 4);
  assert.equal(FORMULA_INK_PAD_PX.inlineProtect, 5);
  assert.equal(FORMULA_INK_PAD_PX.display, 6);
  assert.equal(FORMULA_INK_PAD_PX.displayProtect, 7);
  assert.equal(VISION_INK_PAD_PX.inline, 10);
  assert.equal(VISION_INK_PAD_PX.inlineProtect, 11);
  assert.equal(VISION_INK_PAD_PX.display, 18);
  assert.equal(VISION_INK_PAD_PX.displayProtect, 19);
  assert.ok(VISION_INK_PAD_PX.inline > FORMULA_INK_PAD_PX.inline);
  assert.ok(VISION_INK_PAD_PX.display > FORMULA_INK_PAD_PX.display);
  assert.ok(VISION_INK_PAD_PX.inline >= 8 && VISION_INK_PAD_PX.inline <= 12);
  assert.ok(VISION_INK_PAD_PX.inlineProtect >= 8 && VISION_INK_PAD_PX.inlineProtect <= 12);
  assert.equal(VISION_INK_PAD_PX.display, 9 * CROP_SCALE);
  assert.equal(VISION_INK_PAD_PX.displayProtect, 9 * CROP_SCALE + 1);

  const display = visionPadFor({ display: true }, VISION_CROP_SCALE);
  const inline = visionPadFor({ display: false, inlineOf: "p" }, VISION_CROP_SCALE);
  const protect = visionPadFor({ display: true, formulaInkProtect: true }, VISION_CROP_SCALE);
  assert.equal(display.namedPx, 18);
  assert.equal(display.padPx, formulaInkPadPx(18, 4, CROP_SCALE));
  assert.equal(display.padPx, 36);
  assert.equal(inline.namedPx, 10);
  assert.equal(inline.padPx, 20);
  assert.equal(protect.namedPx, 19);
  assert.ok(display.padPx > formulaInkMeasureOptions(4, { inline: false }).padPx);
  assert.equal(formulaInkMeasureOptions(4, { inline: false }).padPx, formulaInkPadPx(FORMULA_INK_PAD_PX.display, 4));
  assert.equal(formulaInkPadPx(FORMULA_INK_PAD_PX.inline, CROP_SCALE), FORMULA_INK_PAD_PX.inline);
});

test("a normal formula renders at scale 4 and a huge one steps down", () => {
  const bbox = [0.2, 0.4, 0.8, 0.5];
  const plan = visionRasterPlan({ bbox, pageWidth: 612, pageHeight: 792 });
  const screen = formulaRegionWindow(bbox, 612 * CROP_SCALE, 792 * CROP_SCALE);
  assert.equal(plan.scale, VISION_CROP_SCALE);
  assert.equal(plan.capped, false);
  assert.equal(plan.requestedScale, 4);
  assert.equal(plan.pixelWidth, Math.round((bbox[2] - bbox[0]) * 612 * VISION_CROP_SCALE));
  assert.ok(Math.abs(plan.pixelWidth - screen.pixelWidth * 2) <= 1);
  assert.ok(Math.abs(plan.pixelHeight - screen.pixelHeight * 2) <= 1);

  const huge = visionRasterPlan({ bbox: [0, 0, 1, 1], pageWidth: 2000, pageHeight: 2000, scale: 4 });
  assert.equal(huge.capped, true);
  assert.ok(huge.scale < 4);
  assert.ok(huge.pixelWidth <= 4096);
  assert.ok(huge.pixelHeight <= 4096);

  const screenPlan = formulaRasterPlan({
    bbox,
    pageWidth: 612,
    pageHeight: 792,
    rasterWidth: 612 * CROP_SCALE,
    rasterHeight: 792 * CROP_SCALE,
    cssWidth: 80,
    cssHeight: 16,
    devicePixelRatio: 1
  });
  assert.equal(screenPlan.scale, CROP_SCALE);
  assert.equal(screenPlan.reusePageRaster, true);
});

test("vision ink pad is wider than the screen pad and still masks the next line", () => {
  const ink = [0.4, 0.35, 0.7, 0.55];
  const neighbor = [0.25, 0.62, 0.75, 0.7];
  const paint = (width, height) => paper(width, height, (x, y) => {
    const nx = x / width;
    const ny = y / height;
    if (nx >= ink[0] && nx < ink[2] && ny >= ink[1] && ny < ink[3]) return [0, 0, 0, 255];
    if (nx >= neighbor[0] && nx < neighbor[2] && ny >= neighbor[1] && ny < neighbor[3]) return [0, 0, 0, 255];
    return null;
  });
  const low = paint(200, 100);
  const high = paint(400, 200);
  const block = {
    label: "formula",
    display: true,
    bbox: [0, 0, 1, 1],
    layoutBbox: [0, 0, 1, 1],
    maskBoxes: [neighbor]
  };
  const screen = measureFormulaCrop(block.bbox, low, { inline: false, maskBoxes: block.maskBoxes });
  const vision = measureVisionRegion(block, high, { scale: VISION_CROP_SCALE, sourceBbox: block.layoutBbox });
  assert.ok(screen.bbox && vision?.pageBbox);
  const screenPx = rasterCropRect(screen.bbox, low.width, low.height);
  const visionPx = rasterCropRect(vision.relativeBbox, high.width, high.height);
  const screenPadAtVision = formulaInkPadPx(FORMULA_INK_PAD_PX.display, VISION_CROP_SCALE);
  const extra = vision.padPx - screenPadAtVision;
  assert.equal(vision.padPx, 36);
  assert.ok(extra > 0);
  assert.ok(visionPx.sw > screenPx.sw * 2, `width ${visionPx.sw} vs ${screenPx.sw * 2}`);
  assert.ok(visionPx.sh > screenPx.sh * 2, `height ${visionPx.sh} vs ${screenPx.sh * 2}`);
  assert.ok(Math.abs((visionPx.sw - screenPx.sw * 2) - extra * 2) <= 2);
  assert.ok(screen.bbox[3] <= neighbor[1], "screen crop still includes the neighbor line");
  assert.ok(vision.pageBbox[3] <= neighbor[1], "vision crop still includes the neighbor line");

  const plain = paper(200, 100, (x, y, w, h) => {
    const nx = x / w;
    const ny = y / h;
    if (nx >= ink[0] && nx < ink[2] && ny >= ink[1] && ny < ink[3]) return [0, 0, 0, 255];
    return null;
  });
  const screenDefault = measureFormulaCrop([0, 0, 1, 1], plain);
  const screenNamed = measureFormulaCrop([0, 0, 1, 1], plain, {
    inline: false,
    padPx: FORMULA_INK_PAD_PX.display
  });
  assert.deepEqual(screenDefault.bbox, screenNamed.bbox);
  const screenRepeat = measureFormulaCrop([0, 0, 1, 1], plain);
  assert.deepEqual(screenRepeat.bbox, screenDefault.bbox);

  const crop = rasterCropRect(vision.pageBbox, high.width, high.height);
  const sliced = {
    width: crop.sw,
    height: crop.sh,
    data: new Uint8ClampedArray(crop.sw * crop.sh * 4)
  };
  for (let y = 0; y < crop.sh; y += 1) {
    for (let x = 0; x < crop.sw; x += 1) {
      const src = ((crop.sy + y) * high.width + (crop.sx + x)) * 4;
      const dst = (y * crop.sw + x) * 4;
      sliced.data[dst] = high.data[src];
      sliced.data[dst + 1] = high.data[src + 1];
      sliced.data[dst + 2] = high.data[src + 2];
      sliced.data[dst + 3] = high.data[src + 3];
    }
  }
  const inkX = Math.floor(((ink[0] + ink[2]) / 2) * high.width) - crop.sx;
  const inkY = Math.floor(((ink[1] + ink[3]) / 2) * high.height) - crop.sy;
  assert.ok(inkX >= 0 && inkY >= 0 && inkX < sliced.width && inkY < sliced.height);
  const inkAt = (inkY * sliced.width + inkX) * 4;
  assert.equal(sliced.data[inkAt], 0, "formula ink survives the crop");
  // This neighbor is mask-owned and has no formula glyph, so the display
  // trim removes it. The input is fixed; a crop that still meets the line fails.
  const mapped = boxesInCrop(block.maskBoxes, vision.pageBbox);
  assert.equal(mapped.length, 0);
  assert.equal(sliced.data[inkAt], 0);
});

test("visionCropFor asks for a tight scale-4 crop and ignores paragraph mode", async () => {
  const seen = [];
  const block = { label: "formula", display: true, bbox: [0.1, 0.2, 0.4, 0.3] };
  const png = await visionCropFor(block, {
    mode: "paragraph",
    paragraph: { text: "the surrounding sentence" },
    renderVisionCrop: async (_block, spec) => {
      seen.push(spec);
      return pngDataUrl(32 + spec.pad.namedPx, 16);
    }
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mode, "tight");
  assert.equal(seen[0].paragraph, null);
  assert.equal(seen[0].scale, VISION_CROP_SCALE);
  assert.equal(seen[0].pad.namedPx, VISION_INK_PAD_PX.display);
  assert.equal(png.meta.kind, "vision");
  assert.equal(png.meta.scale, 4);
  assert.equal(png.meta.pad, 18);
  assert.equal(png.w, 32 + 18);
  assert.equal(png.hash, sha256Hex(png.base64).slice(0, 12));

  const inlineBare = visionCropSpec({ display: false, inlineOf: "t" });
  assert.equal(inlineBare.mode, "tight");
  assert.equal(inlineBare.pad.namedPx, VISION_INK_PAD_PX.inline);
  assert.equal(inlineBare.paragraph, null);
  const inline = visionCropSpec({
    display: false,
    inlineOf: "t",
    bbox: [0.4, 0.4, 0.48, 0.42],
    paragraphBbox: [0.12, 0.2, 0.48, 0.8]
  });
  assert.equal(inline.mode, "context");
  assert.equal(inline.scale, VISION_CROP_SCALE);
  assert.equal(inline.paragraph, null);
  assert.ok(inline.window.bbox[0] >= 0.12 - 1e-9);
  assert.ok(inline.window.target[2] <= inline.window.bbox[2]);

  const pageArm = visionCropSpec(block, { mode: "page", scale: 6 });
  assert.equal(pageArm.mode, "tight");
  assert.equal(pageArm.paragraph, null);
  assert.equal(pageArm.scale, 6);
});

test("a different pad or scale changes the crop hash, and a repeat does not", async () => {
  const block = { label: "formula", display: true, bbox: [0.1, 0.2, 0.5, 0.3] };
  const render = async (_block, spec) => pngDataUrl(20 + spec.pad.namedPx, 8 + spec.scale);
  const first = await visionCropFor(block, { renderVisionCrop: render });
  const again = await visionCropFor(block, { renderVisionCrop: render });
  const wider = await visionCropFor(block, { pad: 16, renderVisionCrop: render });
  const taller = await visionCropFor(block, { scale: 6, renderVisionCrop: render });
  assert.equal(cropHashOf({ crop: { pixels: first.base64 } }), first.hash);
  assert.equal(again.hash, first.hash);
  assert.notEqual(wider.hash, first.hash);
  assert.notEqual(taller.hash, first.hash);
  const model = "gpt-5.6-luna";
  const unitKey = "doc:b1";
  const live = tierRecordKey(
    { docHash: "doc", bid: "b1", crop: { pixels: first.base64 } },
    { id: "multimodal", version: MM_TIER_VERSION },
    model
  );
  const retired = tierRecordKey(
    { docHash: "doc", bid: "b1", crop: { pixels: first.base64 } },
    { id: "multimodal", version: "mm-2" },
    model
  );
  assert.equal(live, `${unitKey}:multimodal:mm-6:${model}:${first.hash}`);
  assert.notEqual(live, retired);
  assert.match(live, /:mm-6:/);
  assert.doesNotMatch(live, /:mm-3:/);
  assert.doesNotMatch(live, /:mm-2:/);
});

test("a stale vision render is dropped and a miss falls back to the page raster", async () => {
  let stale = false;
  const dropped = await visionCropFor({ label: "formula", display: true }, {
    isStale: () => stale,
    renderVisionCrop: async () => {
      stale = true;
      return pngDataUrl(40, 20);
    }
  });
  assert.equal(dropped, null);
  const fallback = await visionCropFor({ label: "formula", imageUrl: `data:image/png;base64,${PNG}` }, {
    renderVisionCrop: async () => ""
  });
  assert.equal(fallback.base64, PNG);
  assert.equal(fallback.meta.kind, "page-raster");
  assert.equal(fallback.meta.scale, CROP_SCALE);
  assert.equal(fallback.meta.mode, "tight");
});

test("schedule sends the vision crop and leaves the screen image in place", async () => {
  const settings = settingsFor();
  const display = pngDataUrl(12, 8);
  const vision = pngDataUrl(80, 40);
  const seen = [];
  let fetches = 0;
  const shown = await scheduleFormulaBlock({
    label: "formula",
    id: "f1",
    bid: "b-vision",
    bbox: [0.2, 0.4, 0.6, 0.46],
    layoutBbox: [0.18, 0.38, 0.62, 0.5],
    display: true,
    text: "x"
  }, {
    ...formulaChainFlags(settings),
    docHash: "doc-vision",
    settings,
    readSettings: () => settings,
    katex,
    model: settings.multimodal.model,
    withRasterCrop: async (item) => ({ ...item, imageUrl: display, surface: "redraw" }),
    renderVisionCrop: async (_block, spec) => {
      assert.equal(spec.scale, 4);
      assert.equal(spec.mode, "tight");
      assert.equal(spec.paragraph, null);
      assert.equal(spec.pad.namedPx, VISION_INK_PAD_PX.display);
      return vision;
    },
    sendVision: async (req) => {
      seen.push(req.images[0].base64);
      assert.equal(req.system, FORMULA_VISION_SYSTEM);
      assert.equal(req.text, formulaVisionText({ display: true }));
      return { ok: true, text: "x" };
    },
    net: {
      async fetch() {
        fetches += 1;
        const err = new Error("real-network-in-test");
        err.code = "real-network-in-test";
        throw err;
      }
    }
  });
  assert.equal(fetches, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], pngBase64(vision));
  assert.notEqual(seen[0], pngBase64(display));
  assert.equal(shown.imageUrl, display);
  assert.equal(shown.surface, "redraw");
  assert.equal(shown.latex, "x");
  assert.equal(shown.latexSource, "vlm");
  assert.equal(FORMULA_VISION_SYSTEM.includes("段落"), false);
});

test("an mm-2 row is not adopted for the same pixels", async () => {
  assert.equal(MM_TIER_VERSION, "mm-6");
  const settings = settingsFor();
  const cache = createFormulaCache(createMemoryStore());
  const named = `${settings.multimodal.model}#${mmConfigFingerprint(settings)}`;
  const unit = {
    docHash: "doc-old-mm",
    bid: "old-vision",
    bbox: [0.1, 0.2, 0.4, 0.3],
    crop: { pixels: PNG }
  };
  const oldKey = tierRecordKey(unit, { id: "multimodal", version: "mm-2" }, named);
  const liveKey = tierRecordKey(unit, { id: "multimodal", version: MM_TIER_VERSION }, named);
  assert.notEqual(oldKey, liveKey);
  assert.equal(await cache.writeTier(oldKey, {
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: "\\quad",
    confidence: 1,
    checks: {},
    reason: null,
    meta: { version: "mm-2", latexSource: "vlm" }
  }, {
    docHash: unit.docHash,
    unitKey: unitKeyOf(unit),
    cropHash: cropHashOf(unit),
    model: named
  }), true);
  let sends = 0;
  const display = pngDataUrl(12, 8);
  const shown = await scheduleFormulaBlock({
    label: "formula",
    id: "old-vision",
    bid: "old-vision",
    bbox: unit.bbox,
    display: true,
    text: "x"
  }, {
    ...formulaChainFlags(settings),
    docHash: unit.docHash,
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: settings.multimodal.model,
    withRasterCrop: async (item) => ({ ...item, imageUrl: display, surface: "redraw" }),
    renderVisionCrop: async () => `data:image/png;base64,${PNG}`,
    sendVision: async (req) => {
      sends += 1;
      assert.equal(req.images[0].base64, PNG);
      return { ok: true, text: "x" };
    },
    net: {
      async fetch() {
        throw Object.assign(new Error("real-network-in-test"), { code: "real-network-in-test" });
      }
    }
  });
  assert.equal(sends, 1);
  assert.equal(shown.latex, "x");
  assert.equal(shown.imageUrl, display);
  assert.equal(await cache.store.getTier(oldKey) != null, true);
  const live = await cache.store.getTier(liveKey);
  assert.equal(live.result.meta.version, "mm-6");
  assert.equal(live.result.latex, "x");
});

test("screen redraw, page raster, and the 7-level chain stay on their old path", () => {
  const viewer = read("pdf/viewer.js");
  const sharp = sliceBetween(viewer, "async function renderSharpVisualCrop", "async function renderSharpFormulaCrop");
  assert.equal(sharp.includes("VISION_CROP_SCALE"), false);
  assert.equal(sharp.includes("measureVisionRegion"), false);
  assert.equal(sharp.includes("visionPadFor"), false);
  assert.match(sharp, /formulaRefRasterPlan/);
  const imageFn = sliceBetween(viewer, "function imageForVisualBlock", "function cropFormulaImage");
  assert.equal(imageFn.includes("vision"), false);
  assert.match(imageFn, /formulaInkBbox/);
  const raster = sliceBetween(viewer, "async function renderPageRaster", "async function ingestFixtureLayout");
  assert.match(raster, /scale: CROP_SCALE/);
  assert.equal(raster.includes("VISION_CROP_SCALE"), false);
  const vision = sliceBetween(viewer, "async function renderVisionFormulaCrop", "function rasterRegionInk");
  assert.match(vision, /VISION_CROP_SCALE/);
  assert.match(vision, /measureVisionRegion/);
  assert.match(vision, /paintFormulaMask/);
  assert.equal(vision.includes("devicePixelRatio"), false);
  assert.equal(vision.includes("raster.canvas"), false);
  assert.match(vision, /void raster/);
  const display = sliceBetween(viewer, "async function formulaModelDisplayCrop", "async function cropLayoutBlocks");
  const pinned = display.indexOf("{ ...options, sharp: false }");
  const remember = display.indexOf("rememberFormulaModelCrop");
  const sharpCall = display.indexOf("renderSharpVisualCrop");
  assert.ok(pinned >= 0 && remember > pinned && sharpCall > remember);
  assert.equal(display.includes("renderVisionFormulaCrop"), false);
  const crop = sliceBetween(viewer, "async function cropLayoutBlocks", "function readFormulaCropImage");
  assert.match(crop, /renderVisionCrop: \(block, spec\) => renderVisionFormulaCrop\(page, raster, block, pageNumber, spec\)/);
  assert.match(crop, /formulaModelDisplayCrop\(/);
  assert.equal(viewer.includes("oi-vlm-mark"), false);
  assert.equal(viewer.includes("oi-mm-chip"), false);
  assert.equal(viewer.trimEnd().endsWith("init();"), true);

  const library = read("lib/pdf-library.js").split("\n");
  const diagAt = library.findIndex((line) => /import \{ diagLog \} from "\.\/diag-log\.js"/.test(line));
  assert.ok(diagAt >= 0);
  assert.match(library[diagAt], /import \{ diagLog \} from "\.\/diag-log\.js"/);
  assert.match(library[diagAt + 1], /import \{ libraryLoadedAt, libraryReviveAllowed, libraryWritesStopped \} from "\.\/library-writes\.js"/);

  const chain = read("lib/formula-chain.js");
  assert.match(chain, /Order: arxiv, multimodal, ocr, self, vector, crop, placeholder/);
  const tiers = createDefaultTiers();
  assert.deepEqual(Object.keys(tiers), ["arxiv", "multimodal", "ocr", "self", "vector", "crop", "placeholder"]);
  assert.equal(tiers.multimodal.version, "mm-6");
});
