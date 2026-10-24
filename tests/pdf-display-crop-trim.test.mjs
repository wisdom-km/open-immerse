// Display crops drop a body-text band above or below the formula.
// Superscripts, subscripts, fraction rules, and tall brackets stay.
// The font-size path is not involved.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { measureFormulaCrop, textLayerToBlocks, FORMULA_PAPER_MIN } from "../lib/pdf-text-layer.js";
import { attachFontRealNames } from "../lib/pdf-mirror.js";
import { CROP_SCALE } from "../lib/pdf-blocks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function paper(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  return { data, width, height };
}

function ink(image, x, y) {
  const index = (y * image.width + x) * 4;
  image.data[index] = 0;
  image.data[index + 1] = 0;
  image.data[index + 2] = 0;
  image.data[index + 3] = 255;
}

function fill(image, x0, x1, y0, y1) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) ink(image, x, y);
  }
}

function coversRow(crop, height, y) {
  const top = crop[1] * height;
  const bottom = crop[3] * height;
  return y + 0.5 >= top && y + 0.5 < bottom;
}

test("display crops drop a neighboring text line and keep formula ink", () => {
  const width = 480;
  const height = 1584;
  const image = paper(width, height);
  fill(image, 30, 400, 80, 91);
  for (let y = 100; y <= 148; y += 1) ink(image, 40, y);
  fill(image, 80, 96, 104, 111);
  fill(image, 50, 300, 120, 145);
  fill(image, 60, 220, 132, 134);
  fill(image, 200, 224, 152, 165);
  fill(image, 50, 300, 400, 451);
  fill(image, 30, 400, 462, 473);
  fill(image, 30, 400, 600, 611);
  fill(image, 40, 360, 624, 681);
  fill(image, 40, 360, 689, 751);

  const neighborMask = [20 / width, 78 / height, 420 / width, 94 / height];
  const bbox = [20 / width, 70 / height, 420 / width, 210 / height];
  // No formula glyph boxes, so the scan is the whole content box. The top
  // line drops only because the mask box owns it.
  const measured = measureFormulaCrop(bbox, image, {
    inline: false,
    maskBoxes: [neighborMask]
  });
  assert.ok(measured.bbox);
  assert.equal(coversRow(measured.bbox, height, 85), false, "neighbor line stays out");
  assert.equal(coversRow(measured.bbox, height, 100), true, "bracket tip stays");
  assert.equal(coversRow(measured.bbox, height, 108), true, "superscript stays");
  assert.equal(coversRow(measured.bbox, height, 133), true, "fraction bar stays");
  assert.equal(coversRow(measured.bbox, height, 158), true, "subscript stays");
  assert.equal(coversRow(measured.bbox, height, 148), true, "bracket foot stays");

  const reach = measureFormulaCrop(bbox, image, {
    inline: false,
    glyphBoxes: [[40 / width, 80 / height, 300 / width, 170 / height]],
    maskBoxes: [neighborMask]
  });
  assert.equal(coversRow(reach.bbox, height, 85), false, "a font box that only reaches the body line does not keep it");
  assert.equal(coversRow(reach.bbox, height, 133), true, "formula ink under that font box stays");

  // The em-box midpoint sits on the body line; the stroke is the baseline
  // run just under it. That midpoint must not keep the body line.
  const coarse = measureFormulaCrop(bbox, image, {
    inline: false,
    glyphBoxes: [[40 / width, 76 / height, 90 / width, 102 / height]],
    maskBoxes: [neighborMask]
  });
  assert.equal(coversRow(coarse.bbox, height, 85), false, "a coarse em box whose midpoint sits on the body line does not keep it");
  assert.equal(coversRow(coarse.bbox, height, 104), true, "formula ink under that em box stays");

  const prose = measureFormulaCrop(bbox, image, {
    inline: false,
    glyphBoxes: [
      [40 / width, 78 / height, 300 / width, 96 / height],
      [50 / width, 110 / height, 300 / width, 170 / height]
    ],
    maskBoxes: [neighborMask],
    bodyLines: [[20 / width, 78 / height, 420 / width, 94 / height]]
  });
  assert.equal(coversRow(prose.bbox, height, 85), false, "a body sentence on the edge line drops it even when a formula glyph is centered there");
  assert.equal(coversRow(prose.bbox, height, 133), true, "the formula under that sentence stays");

  const owned = measureFormulaCrop(bbox, image, {
    inline: false,
    glyphBoxes: [[40 / width, 78 / height, 300 / width, 96 / height]],
    maskBoxes: [neighborMask]
  });
  assert.equal(coversRow(owned.bbox, height, 85), true, "a formula glyph centered on the edge line keeps it");

  const inline = measureFormulaCrop(bbox, image, {
    inline: true,
    glyphBoxes: [[40 / width, 80 / height, 300 / width, 170 / height]]
  });
  assert.equal(coversRow(inline.bbox, height, 85), true, "inline crops keep the surrounding line");

  const lower = measureFormulaCrop(
    [20 / width, 390 / height, 420 / width, 490 / height],
    image,
    {
      inline: false,
      maskBoxes: [[20 / width, 460 / height, 420 / width, 476 / height]]
    }
  );
  assert.equal(coversRow(lower.bbox, height, 420), true, "formula above a caption stays");
  assert.equal(coversRow(lower.bbox, height, 468), false, "caption line below stays out");

  const lines = measureFormulaCrop(
    [20 / width, 590 / height, 420 / width, 770 / height],
    image,
    {
      inline: false,
      maskBoxes: [[20 / width, 598 / height, 420 / width, 614 / height]]
    }
  );
  assert.equal(coversRow(lines.bbox, height, 605), false, "text above a derivation stays out");
  assert.equal(coversRow(lines.bbox, height, 640), true, "first formula line stays");
  assert.equal(coversRow(lines.bbox, height, 720), true, "second formula line stays");
});

test("a short formula line under a fraction stays when it is not a neighbor glyph", () => {
  const width = 480;
  const height = 1584;
  const image = paper(width, height);
  fill(image, 50, 300, 100, 140);
  fill(image, 60, 200, 150, 162);
  const bbox = [20 / width, 90 / height, 420 / width, 175 / height];
  const kept = measureFormulaCrop(bbox, image, { inline: false });
  assert.ok(kept.bbox);
  assert.equal(coversRow(kept.bbox, height, 120), true, "fraction row stays");
  assert.equal(coversRow(kept.bbox, height, 156), true, "12px = x + y stays");
  assert.ok(kept.bbox[3] * height >= 161, `crop bottom ${kept.bbox[3] * height} cut the last line`);

  const owned = measureFormulaCrop(bbox, image, {
    inline: false,
    glyphBoxes: [[50 / width, 148 / height, 220 / width, 164 / height]],
    maskBoxes: [[50 / width, 148 / height, 220 / width, 164 / height]]
  });
  assert.equal(coversRow(owned.bbox, height, 156), true, "formula glyph on the short line keeps it");

  const foreign = measureFormulaCrop(bbox, image, {
    inline: false,
    maskBoxes: [[50 / width, 148 / height, 220 / width, 164 / height]]
  });
  assert.equal(coversRow(foreign.bbox, height, 120), true, "fraction stays when the last line is body text");
  assert.equal(coversRow(foreign.bbox, height, 156), false, "neighbor glyph on the short line drops it");
});

function rowEdge(image, x0, x1, y) {
  const { data, width } = image;
  let dark = 0;
  const row = y * width * 4;
  for (let x = x0; x < x1; x += 1) {
    const index = row + x * 4;
    if (data[index + 3] < 16) continue;
    if (data[index] >= FORMULA_PAPER_MIN && data[index + 1] >= FORMULA_PAPER_MIN && data[index + 2] >= FORMULA_PAPER_MIN) continue;
    dark += 1;
  }
  return dark;
}

function inkBands(image, bbox) {
  const x0 = Math.max(0, Math.floor(bbox[0] * image.width));
  const x1 = Math.min(image.width, Math.ceil(bbox[2] * image.width));
  const y0 = Math.max(0, Math.floor(bbox[1] * image.height));
  const y1 = Math.min(image.height, Math.ceil(bbox[3] * image.height));
  const bands = [];
  let start = -1;
  let edge = 0;
  for (let y = y0; y <= y1; y += 1) {
    const dark = y < y1 ? rowEdge(image, x0, x1, y) : 0;
    if (dark > 0 && start < 0) {
      start = y;
      edge = dark;
    } else if (dark > 0) {
      edge = Math.max(edge, dark);
    }
    if ((dark === 0 || y === y1) && start >= 0) {
      bands.push({ a: start, b: y, h: y - start, edge });
      start = -1;
      edge = 0;
    }
  }
  return bands;
}

function cropOptions(block) {
  return {
    inline: false,
    protect: block.formulaInkProtect === true,
    maskBoxes: block.maskBoxes,
    glyphBoxes: block.glyphBoxes,
    bodyLines: block.bodyLines
  };
}

function assertDisplayTrim(image, block, proseBaselines) {
  const measured = measureFormulaCrop(block.bbox, image, cropOptions(block));
  const crop = measured.bbox;
  assert.ok(crop, block.id);
  const height = image.height;
  const top = crop[1] * height;
  const bottom = crop[3] * height;
  const bands = inkBands(image, block.bbox);
  for (const box of block.glyphBoxes || []) {
    // Baseline, not the em-box midpoint: the midpoint sits in the body
    // line above a formula while the stroke stays on the formula.
    const base = Number(box[3]) * height;
    const host = bands.find((band) => base >= band.a && base < band.b);
    if (!host) continue;
    const shed = (proseBaselines || []).some((y) => y >= host.a - 2 && y <= host.b + 2);
    if (shed) continue;
    assert.ok(
      base >= top - 1 && base < bottom + 1,
      `${block.id} cut a formula line at ${base.toFixed(1)} (ink ${host.a}-${host.b}, crop ${top.toFixed(1)}-${bottom.toFixed(1)})`
    );
  }
  return { id: block.id, top, bottom, bands: bands.length };
}

async function scanPages(pdfPath, pages, createCanvas) {
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const notes = [];
  try {
    for (const number of pages) {
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
      const width = Math.ceil(viewport.width * CROP_SCALE);
      const height = Math.ceil(viewport.height * CROP_SCALE);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await pdfPage.render({
        canvasContext: context,
        viewport: pdfPage.getViewport({ scale: CROP_SCALE })
      }).promise;
      const image = context.getImageData(0, 0, width, height);
      const proseBaselines = content.items.flatMap((item) => {
        const text = String(item.str || "");
        if (!/[A-Za-z]{4,}/.test(text)) return [];
        return [viewportBox(item, viewport)[3] * height];
      });
      for (const block of built.blocks) {
        if (block.label !== "formula" || block.display === false || !Array.isArray(block.bbox)) continue;
        notes.push(assertDisplayTrim(image, block, proseBaselines));
      }
    }
  } finally {
    await doc.destroy();
  }
  return notes;
}

test("DPO and DDPM display crops keep formula glyph rows", async (t) => {
  const papers = [
    ["DPO", "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf", [3, 17, 18]],
    ["DDPM", "tests/fixtures/DDPM_2006.11239.pdf", [2, 3]]
  ];
  const present = papers.filter(([, rel]) => existsSync(join(root, rel)));
  if (!present.length) {
    t.skip("DPO and DDPM fixtures are absent; the display-crop trim check did not run.");
    return;
  }
  let createCanvas;
  try {
    ({ createCanvas } = createRequire(import.meta.url)("@napi-rs/canvas"));
  } catch {
    t.skip("@napi-rs/canvas is not installed; the display-crop trim check did not run.");
    return;
  }
  const dropped = [];
  for (const [name, rel, pages] of present) {
    const notes = await scanPages(join(root, rel), pages, createCanvas);
    const leaks = notes.filter((note) => note.bands >= 2);
    assert.ok(notes.length >= 1, `${name} rendered display formulas`);
    dropped.push(`${name} pages ${pages.join(",")} formulas ${notes.length}`);
    assert.ok(leaks.length >= 1, `${name} had a multi-band display crop to judge`);
  }
  t.diagnostic(dropped.join("; "));
  assert.ok(dropped.length >= 1);
});

function viewportBox(item, viewport) {
  const transform = Array.isArray(item?.transform) ? item.transform : [];
  const x = Number.isFinite(Number(item?.x)) ? Number(item.x) : Number(transform[4]) || 0;
  const y = Number.isFinite(Number(item?.y)) ? Number(item.y) : Number(transform[5]) || 0;
  const width = Number(item.width) || 0;
  const height = Number(item.height) || 0;
  const rect = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
  const [x1, y1, x2, y2] = rect;
  const vw = Math.max(1, Number(viewport.width) || 1);
  const vh = Math.max(1, Number(viewport.height) || 1);
  return [
    Math.min(x1, x2) / vw,
    Math.min(y1, y2) / vh,
    Math.max(x1, x2) / vw,
    Math.max(y1, y2) / vh
  ];
}

test("DDPM page 2 equation 4 crop excludes the notation sentence", async (t) => {
  const pdfPath = join(root, "tests/fixtures/DDPM_2006.11239.pdf");
  if (!existsSync(pdfPath)) {
    t.skip("DDPM fixture PDF is absent; the equation 4 crop check did not run.");
    return;
  }
  let createCanvas;
  try {
    ({ createCanvas } = createRequire(import.meta.url)("@napi-rs/canvas"));
  } catch {
    t.skip("@napi-rs/canvas is not installed; the equation 4 crop check did not run.");
    return;
  }
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  try {
    const pdfPage = await doc.getPage(2);
    const content = await pdfPage.getTextContent();
    attachFontRealNames(content.items, pdfPage.commonObjs);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const ops = await pdfPage.getOperatorList();
    const built = textLayerToBlocks({
      items: content.items,
      viewport,
      images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
      page: 2
    });
    const block = built.blocks.find((entry) =>
      entry.label === "formula" && entry.display !== false &&
      /q\(xt\|x0\)/.test(entry.sourceText || "") && /\(4\)/.test(entry.sourceText || ""));
    assert.ok(block, "page 2 display formula (4)");
    const notation = content.items.find((item) => /^in closed form: using the notation$/.test(String(item.str || "").trim()));
    assert.ok(notation, "the sentence above equation 4 contains notation");
    const notationBox = viewportBox(notation, viewport);
    const notationMid = (notationBox[1] + notationBox[3]) / 2;
    const sameLine = content.items.filter((item) => {
      const box = viewportBox(item, viewport);
      const mid = (box[1] + box[3]) / 2;
      return Math.abs(mid - notationMid) < 0.008 && /[A-Za-z]{3,}/.test(String(item.str || ""));
    });
    assert.ok(sameLine.some((item) => /\busing\b|\bhave\b/.test(String(item.str || ""))), "notation shares a line with the sentence");
    const width = Math.ceil(viewport.width * CROP_SCALE);
    const height = Math.ceil(viewport.height * CROP_SCALE);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    await pdfPage.render({
      canvasContext: context,
      viewport: pdfPage.getViewport({ scale: CROP_SCALE })
    }).promise;
    const image = context.getImageData(0, 0, width, height);
    const crop = measureFormulaCrop(block.bbox, image, cropOptions(block)).bbox;
    assert.ok(crop);
    for (const item of sameLine) {
      const box = viewportBox(item, viewport);
      const mid = (box[1] + box[3]) / 2;
      assert.ok(crop[1] > mid, `${JSON.stringify(item.str)} at ${mid.toFixed(4)} is inside the crop top ${crop[1].toFixed(4)}`);
    }
    const formulaMid = (block.bbox[1] + block.bbox[3]) / 2;
    assert.ok(crop[1] <= formulaMid && crop[3] >= formulaMid, "equation 4 itself stays in the crop");
    let keptGlyphs = 0;
    for (const box of block.glyphBoxes || []) {
      const mid = (Number(box[1]) + Number(box[3])) / 2;
      if (mid < notationBox[3] + 0.004) continue;
      keptGlyphs += 1;
      assert.ok(crop[1] <= mid && crop[3] >= mid, `formula glyph at ${mid.toFixed(4)} was cut`);
    }
    assert.ok(keptGlyphs >= 1, "equation 4 has glyphs below the notation line");
  } finally {
    await doc.destroy();
  }
});

const pageCache = new Map();

function loadPaperPage(rel, pageNumber) {
  const key = `${rel}:${pageNumber}`;
  if (!pageCache.has(key)) pageCache.set(key, renderPaperPage(rel, pageNumber));
  return pageCache.get(key);
}

async function renderPaperPage(rel, pageNumber) {
  const pdfPath = join(root, rel);
  if (!existsSync(pdfPath)) return null;
  let createCanvas;
  try {
    ({ createCanvas } = createRequire(import.meta.url)("@napi-rs/canvas"));
  } catch {
    return null;
  }
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const pdfPage = await doc.getPage(pageNumber);
  const content = await pdfPage.getTextContent();
  attachFontRealNames(content.items, pdfPage.commonObjs);
  const viewport = pdfPage.getViewport({ scale: 1 });
  const ops = await pdfPage.getOperatorList();
  const built = textLayerToBlocks({
    items: content.items,
    viewport,
    images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
    page: pageNumber
  });
  const width = Math.ceil(viewport.width * CROP_SCALE);
  const height = Math.ceil(viewport.height * CROP_SCALE);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  await pdfPage.render({
    canvasContext: context,
    viewport: pdfPage.getViewport({ scale: CROP_SCALE })
  }).promise;
  const image = context.getImageData(0, 0, width, height);
  await doc.destroy();
  return { content, viewport, built, image, height };
}

function displayFormulas(built) {
  return built.blocks.filter((block) => block.label === "formula" && block.display !== false && Array.isArray(block.bbox));
}

/**
 * The sentence is located from raw text-layer items, not from the crop's
 * mask or glyph assignment. `side` is "above" when the sentence sits over
 * the formula and "below" when it sits under it.
 */
async function assertSentenceOutside(t, { rel, page, formula, sentence, side }) {
  const loaded = await loadPaperPage(rel, page);
  if (!loaded) {
    t.skip("fixture PDF or @napi-rs/canvas is absent; the body-line crop check did not run.");
    return;
  }
  const hits = loaded.content.items.filter((item) => sentence.test(String(item.str || "")));
  assert.ok(hits.length >= 1, `page ${page} has ${sentence}`);
  let block = null;
  let bestDist = Infinity;
  let bestSpan = Infinity;
  for (const entry of displayFormulas(loaded.built)) {
    if (formula && !formula.test(entry.sourceText || "")) continue;
    for (const item of hits) {
      const base = viewportBox(item, loaded.viewport)[3];
      const dist = base < entry.bbox[1] ? entry.bbox[1] - base : base > entry.bbox[3] ? base - entry.bbox[3] : 0;
      const span = entry.bbox[3] - entry.bbox[1];
      if (dist < bestDist - 1e-6 || (Math.abs(dist - bestDist) <= 1e-6 && span < bestSpan)) {
        bestDist = dist;
        bestSpan = span;
        block = entry;
      }
    }
  }
  assert.ok(block && bestDist <= 0.02, `display formula near ${sentence}`);
  const near = hits.filter((item) => {
    const box = viewportBox(item, loaded.viewport);
    return box[3] > block.bbox[1] - 0.03 && box[1] < block.bbox[3] + 0.03;
  });
  assert.ok(near.length >= 1, "sentence items next to the formula");
  const crop = measureFormulaCrop(block.bbox, loaded.image, cropOptions(block)).bbox;
  assert.ok(crop, block.id);
  for (const item of near) {
    const base = viewportBox(item, loaded.viewport)[3];
    if (side === "above") {
      assert.ok(crop[1] > base, `${JSON.stringify(item.str)} baseline ${base.toFixed(4)} is inside the crop top ${crop[1].toFixed(4)}`);
    } else {
      assert.ok(crop[3] < base, `${JSON.stringify(item.str)} baseline ${base.toFixed(4)} is inside the crop bottom ${crop[3].toFixed(4)}`);
    }
  }
  // Any body sentence, not only the one this test names. The where-line
  // numerator sits ~22px above "partition", and a later test on the same
  // crop ("sides we obtain:") must not report that numerator as a cut row.
  const proseBases = loaded.content.items.flatMap((item) => {
    const words = String(item.str || "").match(/[A-Za-z]{4,}/g);
    if (!words) return [];
    return [viewportBox(item, loaded.viewport)[3]];
  });
  let kept = 0;
  for (const glyph of block.glyphBoxes || []) {
    const base = Number(glyph[3]);
    const onSentence = proseBases.some((y) => Math.abs(y - base) <= 0.016) && (
      side === "below" ? base >= crop[3] - 0.008 : base <= crop[1] + 0.008 || base >= crop[3] - 0.008
    );
    if (onSentence) continue;
    if (base < block.bbox[1] || base > block.bbox[3]) continue;
    kept += 1;
    assert.ok(crop[1] <= base && crop[3] >= base, `${block.id} cut a formula glyph at ${base.toFixed(4)}`);
  }
  assert.ok(kept >= 1, `${block.id} kept a formula glyph`);
}

const DPO = "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf";
const DDPM = "tests/fixtures/DDPM_2006.11239.pdf";

test("DPO equation (15) crop excludes \"Hence we have the optimal solution:\"", async (t) => {
  await assertSentenceOutside(t, {
    rel: DPO,
    page: 16,
    formula: /\(15\)/,
    sentence: /Hence we have the optimal solution:/,
    side: "above"
  });
});

test("DPO page 16 crop excludes \"re-organize the final objective\"", async (t) => {
  await assertSentenceOutside(t, {
    rel: DPO,
    page: 16,
    formula: /\(13\)/,
    sentence: /re-organize the final objective/,
    side: "above"
  });
});

test("DPO page 16 crop excludes \"Substituting Eq. 17 into Eq. 16 we obtain:\"", async (t) => {
  await assertSentenceOutside(t, {
    rel: DPO,
    page: 16,
    sentence: /Substituting Eq\. 17 into Eq\. 16 we obtain:/,
    side: "above"
  });
});

test("DPO page 16 crop excludes \"we're left with:\"", async (t) => {
  await assertSentenceOutside(t, {
    rel: DPO,
    page: 16,
    sentence: /left with:/,
    side: "above"
  });
});

test("DPO page 4 crop excludes \"where Z(x)\" and the partition sentence under the formula", async (t) => {
  await assertSentenceOutside(t, {
    rel: DPO,
    page: 4,
    formula: /where Z\(x\)/,
    sentence: /is the partition function/,
    side: "below"
  });
});

test("DPO page 18 crop excludes \"where Z(x)\" under the formula", async (t) => {
  await assertSentenceOutside(t, {
    rel: DPO,
    page: 18,
    formula: /where Z\(x\)/,
    sentence: /notice that|partition function|also depends/,
    side: "below"
  });
});

test("DDPM equation (3) crop excludes the variational-bound sentence", async (t) => {
  await assertSentenceOutside(t, {
    rel: DDPM,
    page: 2,
    formula: /\(3\)/,
    sentence: /variational bound on negative log/,
    side: "above"
  });
});

test("DDPM equation (11) crop excludes \"we may choose the parameterization\"", async (t) => {
  await assertSentenceOutside(t, {
    rel: DDPM,
    page: 4,
    formula: /\(11\)/,
    sentence: /we may choose the parameterization/,
    side: "above"
  });
});

test("DDPM equation (12) crop excludes \"Eq. (10) simplifies to:\"", async (t) => {
  await assertSentenceOutside(t, {
    rel: DDPM,
    page: 4,
    formula: /\(12\)/,
    sentence: /simplifies to:/,
    side: "above"
  });
});

test("DDPM crop excludes \"where εθ is a function approximator\" above \"to compute\"", async (t) => {
  await assertSentenceOutside(t, {
    rel: DDPM,
    page: 4,
    formula: /to compute/,
    sentence: /function approximator intended to p/,
    side: "above"
  });
});

test("DPO page 18 crop excludes \"sides we obtain:\"", async (t) => {
  await assertSentenceOutside(t, {
    rel: DPO,
    page: 18,
    formula: /where Z\(x\)/,
    sentence: /sides we obtain:/,
    side: "above"
  });
});

test("DDPM equation (13) crop drops the previous equation's tag and keeps the cases", async (t) => {
  const loaded = await loadPaperPage(DDPM, 4);
  if (!loaded) {
    t.skip("fixture PDF or @napi-rs/canvas is absent; the body-line crop check did not run.");
    return;
  }
  const block = displayFormulas(loaded.built).find((entry) => /if x = 1/.test(entry.sourceText || ""));
  assert.ok(block, "cases formula");
  const crop = measureFormulaCrop(block.bbox, loaded.image, cropOptions(block)).bbox;
  const tag = loaded.content.items.find((item) => String(item.str || "").includes("(13)"));
  assert.ok(tag, "equation tag (13)");
  const tagBase = viewportBox(tag, loaded.viewport)[3];
  const kept = loaded.content.items.filter((item) => {
    if (!/^if$/.test(String(item.str || "").trim())) return false;
    const base = viewportBox(item, loaded.viewport)[3];
    return base > tagBase && base < tagBase + 0.05;
  });
  assert.ok(kept.length >= 2, "both case rows");
  assert.ok(crop[1] > tagBase, `(13) baseline ${tagBase.toFixed(4)} is inside the crop top ${crop[1].toFixed(4)}`);
  for (const item of kept) {
    const base = viewportBox(item, loaded.viewport)[3];
    assert.ok(crop[1] <= base && crop[3] >= base, `${JSON.stringify(item.str)} baseline ${base.toFixed(4)} was cut`);
  }
});

test("DPO underbrace label \"using Thm. 1\" stays inside the crop", async (t) => {
  const loaded = await loadPaperPage(DPO, 6);
  if (!loaded) {
    t.skip("fixture PDF or @napi-rs/canvas is absent; the body-line crop check did not run.");
    return;
  }
  const block = displayFormulas(loaded.built).find((entry) => /using Thm/.test(entry.sourceText || ""));
  assert.ok(block, "underbrace formula");
  const crop = measureFormulaCrop(block.bbox, loaded.image, cropOptions(block)).bbox;
  const label = loaded.content.items.find((item) => /using Thm/.test(String(item.str || "")));
  assert.ok(label, "underbrace label");
  const base = viewportBox(label, loaded.viewport)[3];
  assert.ok(crop[1] <= base && crop[3] >= base, `underbrace label baseline ${base.toFixed(4)} was cut`);
});

