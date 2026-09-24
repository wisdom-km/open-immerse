import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CROP_SCALE } from "../lib/pdf-blocks.js";
import {
  FORMULA_CROP_MAX_EDGE,
  FORMULA_CROP_MAX_PIXELS,
  FORMULA_RASTER_SLACK,
  capFormulaRasterScale,
  createFormulaRasterCache,
  formulaDisplayCssSize,
  formulaInkMeasureOptions,
  formulaInkPadPx,
  formulaRasterCacheKey,
  formulaRasterPlan,
  formulaRegionWindow,
  scaleCovering
} from "../lib/pdf-formula-raster.js";
import { FORMULA_INK_PAD_PX, measureFormulaCrop } from "../lib/pdf-text-layer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");

const pageWidth = 612;
const pageHeight = 792;
const paperWidth = 591;
const paperHeight = paperWidth * (pageHeight / pageWidth);

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

test("scale covers CSS pixels times devicePixelRatio times slack", () => {
  assert.equal(FORMULA_RASTER_SLACK, 1.05);
  assert.equal(CROP_SCALE, 2);
  const pdfW = 120;
  const need = 100 * 2 * FORMULA_RASTER_SLACK;
  const scale = scaleCovering(pdfW, need);
  assert.ok(Math.round(pdfW * scale) >= Math.ceil(need));
  assert.ok(scale < need / pdfW + 0.02);

  const bbox = [0.26, 0.4, 0.74, 0.44];
  const size = formulaDisplayCssSize({
    block: { label: "formula", display: true, bbox, scriptShare: 0.8 },
    pageWidth,
    pageHeight,
    leftWidth: paperWidth,
    paperWidth,
    paperHeight
  });
  const aspect = (0.48 * pageWidth) / (0.04 * pageHeight);
  assert.ok(size.cssWidth > 580);
  assert.ok(Math.abs(size.cssWidth / size.cssHeight - aspect) < 1e-6);
  const atTwo = formulaRasterPlan({
    bbox,
    pageWidth,
    pageHeight,
    cssWidth: size.cssWidth,
    cssHeight: size.cssHeight,
    devicePixelRatio: 2
  });
  assert.equal(atTwo.scale % CROP_SCALE, 0);
  assert.ok(atTwo.pixelWidth / size.cssWidth >= 2);
  assert.ok(atTwo.pixelHeight / size.cssHeight >= 2);

  const zoomed = formulaDisplayCssSize({
    block: { label: "formula", display: true, bbox, scriptShare: 0.8 },
    pageWidth,
    pageHeight,
    leftWidth: paperWidth,
    paperWidth,
    paperHeight,
    mirrorZoom: 2
  });
  const sharp = formulaRasterPlan({
    bbox,
    pageWidth,
    pageHeight,
    cssWidth: zoomed.cssWidth,
    cssHeight: zoomed.cssHeight,
    devicePixelRatio: 2
  });
  assert.equal(sharp.reusePageRaster, false);
  assert.equal(sharp.capped, false);
  assert.ok(sharp.scale > CROP_SCALE);
  assert.equal(sharp.scale % CROP_SCALE, 0);
  assert.ok(sharp.pixelWidth / zoomed.cssWidth >= 2);
  assert.ok(sharp.pixelHeight / zoomed.cssHeight >= 2);
  assert.ok(Math.abs(zoomed.cssWidth - size.cssWidth * 2) < 1e-6);

  const atOne = formulaRasterPlan({
    bbox,
    pageWidth,
    pageHeight,
    cssWidth: size.cssWidth,
    cssHeight: size.cssHeight,
    devicePixelRatio: 1
  });
  assert.equal(atOne.scale % CROP_SCALE, 0);
  assert.ok(atOne.pixelWidth / size.cssWidth >= 1);

  const shortBox = [0.26, 0.4, 0.74, 0.41];
  const short = formulaDisplayCssSize({
    block: { label: "formula", display: true, bbox: shortBox, scriptShare: 0.8 },
    pageWidth,
    pageHeight,
    leftWidth: paperWidth,
    paperWidth,
    paperHeight
  });
  const shortPlan = formulaRasterPlan({
    bbox: shortBox,
    pageWidth,
    pageHeight,
    cssWidth: short.cssWidth,
    cssHeight: short.cssHeight,
    devicePixelRatio: 2
  });
  assert.equal(shortPlan.capped, true);
  assert.equal(shortPlan.scale % CROP_SCALE, 0);
  assert.ok(shortPlan.pixelWidth > 0);
  assert.ok(shortPlan.pixelHeight > 0);
});

test("missing display size and a bad devicePixelRatio stay on the page raster", () => {
  const bbox = [0.2, 0.2, 0.5, 0.3];
  const blank = formulaRasterPlan({
    bbox,
    pageWidth,
    pageHeight,
    cssWidth: 0,
    cssHeight: 40,
    devicePixelRatio: 2
  });
  assert.equal(blank.reusePageRaster, true);
  assert.equal(blank.scale, CROP_SCALE);
  const odd = formulaRasterPlan({
    bbox,
    pageWidth,
    pageHeight,
    cssWidth: 40,
    cssHeight: 20,
    devicePixelRatio: 0
  });
  assert.equal(odd.devicePixelRatio, 1);
});

test("inline CSS box keeps the em height and does not squash a wide crop", () => {
  const wide = [0.1, 0.5, 0.7, 0.52];
  const size = formulaDisplayCssSize({
    block: { label: "formula", display: false, inlineOf: "p1", bbox: wide, inkShare: 16 / 24 },
    pageWidth,
    pageHeight,
    leftWidth: paperWidth,
    paperWidth,
    paperHeight,
    mirrorZoom: 1
  });
  assert.equal(size.inline, true);
  const aspect = (0.6 * pageWidth) / (0.02 * pageHeight);
  assert.ok(size.cssWidth > 12 * 15);
  assert.ok(Math.abs(size.cssWidth / size.cssHeight - aspect) < 1e-6);
  const zoomed = formulaDisplayCssSize({
    block: { label: "formula", display: false, inlineOf: "p1", bbox: wide },
    pageWidth,
    pageHeight,
    leftWidth: paperWidth,
    paperWidth,
    paperHeight,
    mirrorZoom: 2
  });
  assert.ok(Math.abs(zoomed.cssWidth - size.cssWidth * 2) < 1e-6);
  const narrow = formulaDisplayCssSize({
    block: { label: "formula", display: false, inlineOf: "p1", bbox: [0.4, 0.5, 0.46, 0.52] },
    pageWidth,
    pageHeight,
    leftWidth: paperWidth,
    paperWidth,
    paperHeight
  });
  assert.ok(narrow.cssWidth < 12 * 15);
  const plan = formulaRasterPlan({
    bbox: [0.4, 0.5, 0.46, 0.52],
    pageWidth,
    pageHeight,
    cssWidth: narrow.cssWidth,
    cssHeight: narrow.cssHeight,
    devicePixelRatio: 2
  });
  assert.equal(plan.reusePageRaster, false);
  assert.ok(plan.pixelWidth / narrow.cssWidth >= 2);
  assert.ok(plan.pixelHeight / narrow.cssHeight >= 2);
});

test("edge and pixel caps downgrade the scale and still return a finite crop", () => {
  assert.equal(FORMULA_CROP_MAX_EDGE, 4096);
  assert.equal(FORMULA_CROP_MAX_PIXELS, 4096 * 1024);
  assert.equal(capFormulaRasterScale(3, 40, 20), 3);
  assert.ok(capFormulaRasterScale(0, 40, 20) > 0);
  assert.ok(Number.isFinite(capFormulaRasterScale(Number.POSITIVE_INFINITY, 100, 80)));

  const capped = capFormulaRasterScale(20, 800, 800);
  const pw = Math.round(800 * capped);
  const ph = Math.round(800 * capped);
  assert.ok(capped < 20);
  assert.ok(pw <= FORMULA_CROP_MAX_EDGE);
  assert.ok(ph <= FORMULA_CROP_MAX_EDGE);
  assert.ok(pw * ph <= FORMULA_CROP_MAX_PIXELS);

  const blocked = formulaRasterPlan({
    bbox: [0, 0, 1, 1],
    pageWidth: 800,
    pageHeight: 800,
    cssWidth: 4000,
    cssHeight: 4000,
    devicePixelRatio: 3
  });
  assert.equal(blocked.reusePageRaster, true);
  assert.equal(blocked.capped, true);
  assert.equal(blocked.scale, CROP_SCALE);
  assert.ok(blocked.pixelWidth <= FORMULA_CROP_MAX_EDGE);
  assert.ok(blocked.pixelWidth * blocked.pixelHeight <= FORMULA_CROP_MAX_PIXELS);

  const stepped = formulaRasterPlan({
    bbox: [0, 0, 1, 1],
    pageWidth: 500,
    pageHeight: 250,
    cssWidth: 3000,
    cssHeight: 1500,
    devicePixelRatio: 2
  });
  assert.equal(stepped.reusePageRaster, false);
  assert.equal(stepped.capped, true);
  assert.ok(stepped.multiplier >= 2);
  assert.ok(stepped.multiplier < stepped.rawMultiplier);
  assert.equal(stepped.pixelWidth / stepped.pixelHeight, (500 * CROP_SCALE) / (250 * CROP_SCALE));
  assert.ok(stepped.pixelWidth <= FORMULA_CROP_MAX_EDGE);
  assert.ok(stepped.pixelHeight <= FORMULA_CROP_MAX_EDGE);
  assert.ok(stepped.pixelWidth * stepped.pixelHeight <= FORMULA_CROP_MAX_PIXELS);
});

test("region window is the bbox in viewport pixels", () => {
  const window = formulaRegionWindow([0.1, 0.2, 0.4, 0.5], 1000, 2000);
  assert.deepEqual(window, { offsetX: 100, offsetY: 400, pixelWidth: 300, pixelHeight: 600 });
});

test("ink pad in PDF units matches across raster scales", () => {
  const base = formulaInkMeasureOptions(CROP_SCALE, { inline: false });
  const hi = formulaInkMeasureOptions(4, { inline: false, protect: false });
  const inlineHi = formulaInkMeasureOptions(5.5, { inline: true, protect: true });
  assert.equal(base.padPx, FORMULA_INK_PAD_PX.display);
  assert.equal(base.minSpanX, 24);
  assert.equal(base.minSpanY, 12);
  assert.equal(hi.padPx, formulaInkPadPx(FORMULA_INK_PAD_PX.display, 4));
  assert.ok(Math.abs(hi.padPx / 4 - base.padPx / CROP_SCALE) < 1e-12);
  assert.ok(Math.abs(hi.minSpanX / 4 - 24 / CROP_SCALE) < 1e-12);
  assert.ok(Math.abs(inlineHi.padPx / 5.5 - FORMULA_INK_PAD_PX.inlineProtect / CROP_SCALE) < 1e-12);
  assert.equal(formulaInkPadPx(FORMULA_INK_PAD_PX.inline, CROP_SCALE), FORMULA_INK_PAD_PX.inline);
});

test("scaled ink pad keeps the same crop box within one base pixel", () => {
  const bbox = [0.1, 0.1, 0.9, 0.9];
  const ink = [0.4, 0.35, 0.7, 0.55];
  const paint = (x, y, width, height) => {
    const nx = x / width;
    const ny = y / height;
    if (nx >= ink[0] && nx < ink[2] && ny >= ink[1] && ny < ink[3]) return [0, 0, 0, 255];
    return null;
  };
  const low = paper(200, 100, paint);
  const high = paper(400, 200, paint);
  const at2 = measureFormulaCrop(bbox, low, { inline: false });
  const at4 = measureFormulaCrop(bbox, high, formulaInkMeasureOptions(4, { inline: false }));
  assert.ok(at2.bbox && at4.bbox);
  for (let i = 0; i < 4; i += 1) {
    const px2 = at2.bbox[i] * low.width;
    const px4 = at4.bbox[i] * high.width / 2;
    assert.ok(Math.abs(px2 - px4) <= 1, `edge ${i}: ${px2} vs ${px4}`);
  }
  const untouched = measureFormulaCrop(bbox, low);
  assert.deepEqual(untouched.bbox, at2.bbox);
});

test("formula raster cache keeps one render per page formula and drops the oldest", () => {
  const cache = createFormulaRasterCache(2);
  const key = formulaRasterCacheKey({
    docId: 3,
    page: 4,
    bbox: [0.1, 0.2, 0.3, 0.4],
    scale: 3.5,
    devicePixelRatio: 2
  });
  assert.equal(cache.get(key), "");
  cache.set(key, "data:image/png;base64,aa");
  cache.set("b", "data:image/png;base64,bb");
  cache.set("c", "data:image/png;base64,cc");
  assert.equal(cache.get(key), "");
  assert.equal(cache.get("c"), "data:image/png;base64,cc");
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("viewer sharpens formula crops with a viewport offset and leaves the page raster scale", () => {
  assert.match(viewerSrc, /scale: CROP_SCALE/);
  assert.match(viewerSrc, /formulaRasterPlan/);
  assert.match(viewerSrc, /rasterWidth: raster\?\.pixelWidth/);
  assert.match(viewerSrc, /offsetX: -originX \* full\.width/);
  assert.match(viewerSrc, /offsetY: -originY \* full\.height/);
  assert.match(viewerSrc, /displayFormulaWidthCss\(pageFraction/);
  assert.match(viewerSrc, /inlinePaintBox\(formula\?\.inkShare/);
  assert.doesNotMatch(viewerSrc, /cropCanvasToDataUrl/);
  const imageFn = viewerSrc.slice(viewerSrc.indexOf("function imageForVisualBlock"));
  const drawnAt = imageFn.indexOf("if (drawn) return drawn");
  const trimAt = imageFn.indexOf("formulaInkBbox");
  const cropAt = imageFn.indexOf("return cropBlockImage");
  assert.ok(drawnAt >= 0 && trimAt > drawnAt && cropAt > trimAt);
});

test("mirror zoom and device pixel ratio replan formula crops", () => {
  assert.match(viewerSrc, /function refreshFormulaCropsForDisplay/);
  assert.match(viewerSrc, /function watchFormulaRasterRatio/);
  assert.match(viewerSrc, /layout\.formulaPlanKey/);
  const setMirror = viewerSrc.slice(
    viewerSrc.indexOf("function setMirrorZoom"),
    viewerSrc.indexOf("function applyMirrorZoom")
  );
  assert.match(setMirror, /refreshFormulaCropsForDisplay\(\)/);
  const refresh = viewerSrc.slice(
    viewerSrc.indexOf("async function refreshFormulaCropsForDisplay"),
    viewerSrc.indexOf("function setMirrorZoom")
  );
  assert.match(refresh, /renderSharpFormulaCrop/);
  assert.match(refresh, /formulaCropPlanKeyNow/);
  assert.doesNotMatch(refresh, /FORMULA_CROP_PAD|displayInkMinEm|inlineCropBoxEm/);
});
