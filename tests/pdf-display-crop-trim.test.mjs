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

  const owned = measureFormulaCrop(bbox, image, {
    inline: false,
    glyphBoxes: [[40 / width, 80 / height, 300 / width, 170 / height]],
    maskBoxes: [neighborMask]
  });
  assert.equal(coversRow(owned.bbox, height, 85), true, "a formula glyph on the edge line keeps it");

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

function bandOverlap(band, boxes, height) {
  let best = 0;
  for (const box of boxes || []) {
    if (!Array.isArray(box) || box.length < 4) continue;
    const y0 = Number(box[1]) * height;
    const y1 = Number(box[3]) * height;
    best = Math.max(best, Math.min(band.b, y1) - Math.max(band.a, y0));
  }
  return Math.max(0, best);
}

function assertDisplayTrim(image, block) {
  const measured = measureFormulaCrop(block.bbox, image, {
    inline: false,
    protect: block.formulaInkProtect === true,
    maskBoxes: block.maskBoxes,
    glyphBoxes: block.glyphBoxes
  });
  const crop = measured.bbox;
  assert.ok(crop, block.id);
  const height = image.height;
  const top = crop[1] * height;
  const bottom = crop[3] * height;
  const bands = inkBands(image, block.bbox);
  let shed = 0;
  for (const band of bands) {
    if (bandOverlap(band, block.glyphBoxes, height) <= 0) continue;
    for (const box of block.glyphBoxes || []) {
      const y0 = Math.max(band.a, Number(box[1]) * height);
      const y1 = Math.min(band.b, Number(box[3]) * height);
      if (y1 - y0 < 1) continue;
      const mid = (y0 + y1) / 2;
      assert.ok(
        mid >= top - 1 && mid < bottom + 1,
        `${block.id} cut a formula glyph row ${y0.toFixed(1)}-${y1.toFixed(1)} (crop ${top.toFixed(1)}-${bottom.toFixed(1)})`
      );
    }
  }
  if (bands.length >= 2) {
    const edges = [
      [bands[0], bands[1].a - bands[0].b, "above", (band) => top >= band.b - 1],
      [bands[bands.length - 1], bands[bands.length - 1].a - bands[bands.length - 2].b, "below", (band) => bottom <= band.a + 1]
    ];
    for (const [band, gap, side, outside] of edges) {
      const glyph = bandOverlap(band, block.glyphBoxes, height);
      const mask = bandOverlap(band, block.maskBoxes, height);
      if (gap < 4 || glyph > 0 || mask < band.h * 0.5) continue;
      assert.ok(outside(band), `${block.id} still includes the neighbor line ${side} (${band.a}-${band.b})`);
      shed += 1;
    }
  }
  return { id: block.id, top, bottom, bands: bands.length, shed };
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
      for (const block of built.blocks) {
        if (block.label !== "formula" || block.display === false || !Array.isArray(block.bbox)) continue;
        notes.push(assertDisplayTrim(image, block));
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
    const shed = notes.reduce((sum, note) => sum + note.shed, 0);
    assert.ok(notes.length >= 1, `${name} rendered display formulas`);
    dropped.push(`${name} pages ${pages.join(",")} formulas ${notes.length}, neighbor lines shed ${shed}`);
    assert.ok(leaks.length >= 1, `${name} had a multi-band display crop to judge`);
  }
  t.diagnostic(dropped.join("; "));
  assert.ok(dropped.length >= 1);
});
