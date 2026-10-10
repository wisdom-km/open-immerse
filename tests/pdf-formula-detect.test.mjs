import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "url";
import {
  attachFontRealNames,
  fontNameForFormula,
  hasMathUnicode,
  isMathFontName,
  looksLikeFormulaItem,
  stripFontSubsetPrefix
} from "../lib/pdf-mirror.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { CROP_SCALE, blockRenderPieces } from "../lib/pdf-blocks.js";
import { measureFormulaCrop, sameLineFormulaSpans, textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function unitViewport(width, height) {
  return {
    width,
    height,
    convertToViewportRectangle(rect) {
      const [x1, y1, x2, y2] = rect;
      return [x1, height - y2, x2, height - y1];
    }
  };
}

test("math font names use the real face and ignore pdf.js ids", () => {
  assert.equal(stripFontSubsetPrefix("LICAEO+CMMI10"), "CMMI10");
  assert.equal(stripFontSubsetPrefix("QDTWCG+MSBM10"), "MSBM10");
  assert.equal(isMathFontName("g_d0_f3"), false);
  assert.equal(isMathFontName("LICAEO+CMMI10"), true);
  assert.equal(isMathFontName("QDTWCG+MSBM10"), true);
  assert.equal(looksLikeFormulaItem({ fontName: "g_d0_f3", str: "n" }), false);
  assert.equal(looksLikeFormulaItem({
    fontName: "g_d0_f3",
    fontRealName: "LICAEO+CMMI10",
    str: "x"
  }), true);
  assert.equal(looksLikeFormulaItem({
    fontName: "g_d1_f42",
    fontRealName: "QDTWCG+MSBM10",
    str: "R"
  }), true);
  for (const name of [
    "CMMI10", "CMSY10", "CMEX10", "CMBSY10", "CMMIB10", "CMBX10",
    "MSAM10", "MSBM10", "rsfs10", "eufm10",
    "LatinModernMath", "STIX Two Math", "Cambria Math", "CambriaMath", "Symbol"
  ]) {
    assert.equal(isMathFontName(name), true, name);
  }
  for (const name of ["CMR10", "NimbusRomNo9L-Regu", "Times-Roman", "STIX Two Text", "g_d0_f1"]) {
    assert.equal(isMathFontName(name), false, name);
  }
  assert.equal(fontNameForFormula({ fontName: "g_d0_f3", fontRealName: "LICAEO+CMMI10" }), "CMMI10");
  assert.equal(fontNameForFormula({ fontName: "CMMI10" }), "CMMI10");
  assert.equal(fontNameForFormula({ fontName: "g_d0_f3" }), "");
});

test("unready commonObjs leave font names unset", () => {
  const missing = [{ fontName: "g_d0_f3", str: "x" }];
  attachFontRealNames(missing, {
    has() { return false; },
    get() { throw new Error("not ready"); }
  });
  assert.equal(missing[0].fontRealName, undefined);
  const thrown = [{ fontName: "g_d0_f3", str: "x" }];
  attachFontRealNames(thrown, {
    has() { return true; },
    get() { throw new Error("not ready"); }
  });
  assert.equal(thrown[0].fontRealName, undefined);
  const ready = [{ fontName: "g_d0_f3", str: "x" }];
  attachFontRealNames(ready, {
    has(id) { return id === "g_d0_f3"; },
    get() { return { name: "LICAEO+CMMI10" }; }
  });
  assert.equal(ready[0].fontRealName, "CMMI10");
});

test("math unicode classes mark operators and letters, not prose", () => {
  for (const text of ["θ", "∈", "→", "∑", "√", "\u{1D4A9}"]) {
    assert.equal(hasMathUnicode(text), true, text);
  }
  for (const text of ["the", "Attention", "where", "Nimbus", "53"]) {
    assert.equal(hasMathUnicode(text), false, text);
  }
});

test("subscripts and superscripts join the adjacent formula and stop at prose", () => {
  const line = [
    { str: "p", x: 10, y: 100, width: 6, height: 10, fontName: "g_d0_f3", fontRealName: "CMMI10" },
    { str: "θ", x: 16, y: 97, width: 5, height: 7, fontName: "g_d0_f4", fontRealName: "CMMI7" },
    { str: "(", x: 22, y: 100, width: 4, height: 10, fontRealName: "CMR10" },
    { str: "x", x: 27, y: 100, width: 6, height: 10, fontRealName: "CMBX10" },
    { str: "0", x: 33, y: 96, width: 4, height: 7, fontRealName: "CMR7" },
    { str: ")", x: 38, y: 100, width: 4, height: 10, fontRealName: "CMR10" },
    { str: ", where", x: 46, y: 100, width: 36, height: 10, fontRealName: "NimbusRomNo9L-Regu" },
    { str: "x", x: 90, y: 100, width: 6, height: 10, fontRealName: "CMBX10" },
    { str: "t", x: 96, y: 96, width: 4, height: 7, fontRealName: "CMMI7" },
    { str: " are", x: 110, y: 100, width: 24, height: 10, fontRealName: "NimbusRomNo9L-Regu" }
  ];
  assert.deepEqual(sameLineFormulaSpans(line), [[0, 5]]);
  const lone = [
    { str: "The value is ", x: 0, y: 0, width: 70, height: 10, fontRealName: "NimbusRomNo9L-Regu" },
    { str: "n", x: 72, y: 0, width: 8, height: 10, fontName: "g_d0_f3", fontRealName: "CMMI10" },
    { str: " here.", x: 82, y: 0, width: 30, height: 10, fontRealName: "NimbusRomNo9L-Regu" }
  ];
  assert.deepEqual(sameLineFormulaSpans(lone), []);
});

test("DDPM page 2 inline formulas are whole units when real font names are present", () => {
  const fixture = JSON.parse(readFileSync(join(root, "tests/fixtures/pdf-blocks/ddpm-p2-inline.json"), "utf8"));
  const viewport = unitViewport(fixture.viewport.width, fixture.viewport.height);
  const bare = textLayerToBlocks({
    items: fixture.items.map(({ fontRealName, ...item }) => item),
    viewport,
    page: 2
  });
  const bareHost = bare.blocks.find((block) => /latent variable models of the form/.test(block.text || ""));
  assert.match(bareHost.text, /pθ|p ⟦f/);

  const page = textLayerToBlocks({ items: fixture.items, viewport, page: 2 });
  const host = page.blocks.find((block) => /latent variable models of the form/.test(block.text || ""));
  assert.ok(host);
  assert.match(host.text, /form ⟦f\d+⟧, where ⟦f\d+⟧ are latents/);
  assert.match(host.text, /dimensionality as the data ⟦f\d+⟧/);
  assert.doesNotMatch(host.text, /pθ/);
  assert.match(host.text, /Diffusion models/);
  assert.match(host.text, /joint distribution/);
  assert.equal(page.blocks.some((block) => /pθ/.test(block.text || "")), false);

  const token = host.text.match(/form (⟦f\d+⟧)/)[1];
  const blockId = host.placeholders.find((entry) => entry.token === token).blockId;
  const inline = page.blocks.find((block) => block.id === blockId);
  const width = fixture.viewport.width;
  assert.equal(inline.label, "formula");
  assert.equal(inline.display, false);
  assert.ok((inline.bbox[2] - inline.bbox[0]) * width > 80, "p_θ(…) stays one inline unit");

  const displays = page.blocks.filter((block) => block.label === "formula" && block.display !== false);
  const equation = displays.filter((block) => {
    const left = block.bbox[0] * width;
    const right = block.bbox[2] * width;
    return left < 140 && right > 480 && right - left > 350;
  });
  assert.equal(equation.length, 1);
});

test("a script-sized ref stays inside the inline fraction and prose still ends it", () => {
  const line = [
    { str: "r", x: 10, y: 100, width: 6, height: 10, fontRealName: "CMR10" },
    { str: "(", x: 16, y: 100, width: 4, height: 10, fontRealName: "CMR10" },
    { str: "x, y", x: 20, y: 100, width: 16, height: 10, fontRealName: "CMR10" },
    { str: ") =", x: 36, y: 100, width: 12, height: 10, fontRealName: "CMR10" },
    { str: "β", x: 50, y: 100, width: 8, height: 10, fontRealName: "CMR10" },
    { str: "log", x: 60, y: 100, width: 16, height: 10, fontRealName: "CMR10" },
    { str: "π", x: 78, y: 104, width: 7, height: 7, fontRealName: "CMMI7" },
    { str: "π", x: 80, y: 96, width: 7, height: 7, fontRealName: "CMMI7" },
    { str: "ref", x: 84, y: 94, width: 12, height: 5, fontRealName: "CMR10" },
    { str: "(", x: 86, y: 104, width: 4, height: 7, fontRealName: "CMR7" },
    { str: "(", x: 88, y: 96, width: 4, height: 7, fontRealName: "CMR7" },
    { str: "y", x: 92, y: 104, width: 5, height: 7, fontRealName: "CMR7" },
    { str: "|", x: 95, y: 104, width: 3, height: 7, fontRealName: "CMR7" },
    { str: "x", x: 98, y: 104, width: 5, height: 7, fontRealName: "CMR7" },
    { str: ")", x: 103, y: 104, width: 4, height: 7, fontRealName: "CMR7" },
    { str: " for some model", x: 130, y: 100, width: 80, height: 10, fontRealName: "NimbusRomNo9L-Regu" }
  ];
  const spans = sameLineFormulaSpans(line);
  assert.equal(spans.length, 1);
  const text = line.slice(spans[0][0], spans[0][1] + 1).map((item) => item.str).join("");
  assert.match(text, /ref/);
  assert.match(text, /y\|x/);
  assert.doesNotMatch(text, /for some model/);
  const withTail = line.map((item) => ({ ...item }));
  const refAt = withTail.findIndex((item) => item.str === "ref");
  withTail.splice(refAt + 1, 0,
    { str: "θ", x: 90, y: 98, width: 5, height: 5, fontRealName: "CMR7" },
    { str: "r", x: 95, y: 90, width: 4, height: 5, fontRealName: "CMR7" }
  );
  for (const item of withTail) {
    if (item.str === "(" || item.str === "y" || item.str === "|" || item.str === "x" || item.str === ")") {
      if (item.x < 120) item.x += 16;
    }
  }
  const tailed = sameLineFormulaSpans(withTail);
  assert.equal(tailed.length, 1);
  const tailedText = withTail.slice(tailed[0][0], tailed[0][1] + 1).map((item) => item.str).join("");
  assert.match(tailedText, /refθr/);
  assert.match(tailedText, /y\|x/);
  assert.doesNotMatch(tailedText, /for some model/);
  const bodySized = [
    { str: "−", x: 0, y: 100, width: 8, height: 10, fontRealName: "CMR10" },
    { str: "β", x: 10, y: 100, width: 8, height: 10, fontRealName: "CMR10" },
    { str: "log", x: 20, y: 100, width: 16, height: 10, fontRealName: "CMR10" },
    { str: "π", x: 40, y: 96, width: 8, height: 10, fontRealName: "CMMI10" },
    { str: "π", x: 42, y: 106, width: 8, height: 10, fontRealName: "CMMI10" },
    { str: "ref", x: 48, y: 92, width: 12, height: 7, fontRealName: "CMR7" },
    { str: "θ", x: 52, y: 108, width: 6, height: 7, fontRealName: "CMR7" },
    { str: "(", x: 58, y: 106, width: 4, height: 10, fontRealName: "CMR10" },
    { str: "(", x: 60, y: 96, width: 4, height: 10, fontRealName: "CMR10" },
    { str: "y", x: 66, y: 106, width: 6, height: 10, fontRealName: "CMR10" },
    { str: "y", x: 68, y: 96, width: 6, height: 10, fontRealName: "CMR10" },
    { str: "|", x: 76, y: 106, width: 3, height: 10, fontRealName: "CMR10" },
    { str: "|", x: 78, y: 96, width: 3, height: 10, fontRealName: "CMR10" },
    { str: "x", x: 84, y: 106, width: 6, height: 10, fontRealName: "CMR10" },
    { str: "x", x: 86, y: 96, width: 6, height: 10, fontRealName: "CMR10" },
    { str: ")", x: 94, y: 106, width: 4, height: 10, fontRealName: "CMR10" },
    { str: ")", x: 96, y: 96, width: 4, height: 10, fontRealName: "CMR10" }
  ];
  const bodySpans = sameLineFormulaSpans(bodySized);
  assert.equal(bodySpans.length, 1);
  const bodyText = bodySized.slice(bodySpans[0][0], bodySpans[0][1] + 1).map((item) => item.str).join("");
  assert.match(bodyText, /refθ/);
  assert.match(bodyText, /yy\|\|xx/);
  assert.equal(bodySpans[0][1], bodySized.length - 1);
  const prose = [
    { str: "=", x: 0, y: 100, width: 8, height: 10, fontRealName: "CMR10" },
    { str: "β", x: 10, y: 100, width: 8, height: 10, fontRealName: "CMR10" },
    { str: "reference", x: 20, y: 100, width: 40, height: 10, fontRealName: "NimbusRomNo9L-Regu" }
  ];
  const stopped = sameLineFormulaSpans(prose);
  const stoppedText = stopped.length ? prose.slice(stopped[0][0], stopped[0][1] + 1).map((item) => item.str).join("") : "";
  assert.doesNotMatch(stoppedText, /reference/);
});

test("DPO reward formula on pages 18 and 19 is one inline unit", async () => {
  const pdfPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
  assert.equal(readFileSync(pdfPath).byteLength > 1000, true);
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const fragment = /ref['′]?\(\(yy|\(yy\|/;
  const bySuffix = new Map();
  try {
    for (const number of [5, 18, 19]) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const built = stampLayoutBids(number, textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      }));
      for (const block of built.blocks) {
        const suffix = String(block.bid || "").split("-").pop();
        bySuffix.set(`${number}:${suffix}`, { block, blocks: built.blocks });
      }
    }
  } finally {
    await doc.destroy();
  }
  const host = (page, suffix) => {
    const found = bySuffix.get(`${page}:${suffix}`);
    assert.ok(found, `${page} ${suffix}`);
    const pieces = blockRenderPieces(found.block, found.blocks);
    const shown = pieces.filter((piece) => piece.type === "text").map((piece) => piece.text).join("");
    return { text: String(found.block.text || ""), shown };
  };
  for (const [page, suffix] of [[18, "t1ip4wvs"], [18, "t06ip39c"], [19, "t1v9ih0t"]]) {
    const row = host(page, suffix);
    assert.match(row.text, /for some model/, row.text);
    assert.match(row.text, /⟦f\d+⟧/, row.text);
    assert.doesNotMatch(row.text, fragment, row.text);
    assert.doesNotMatch(row.shown, fragment, row.shown);
    assert.equal(/^ref['′]?$/.test(row.shown.trim()), false, row.shown);
  }
  const page5 = host(5, "t1am9nkw");
  assert.match(page5.text, /DPO outline/);
  assert.match(page5.text, /π_\{ref\}/);
  assert.match(page5.text, /Appendix B/);
  assert.doesNotMatch(page5.text, fragment);
  assert.doesNotMatch(page5.shown, fragment);
});

test("DPO display crops cover every glyph and leave no formula fragment", async () => {
  const pdfPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
  const { createCanvas } = createRequire(import.meta.url)("@napi-rs/canvas");
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const orphan = /(?:^|\n)\s*ref['′*∗]?\s*(?:\n|$)|\(yy\||yy\|\||\(y\|x\)\/\(y\|x\)|公式见左栏|ref['′*∗θr]{0,4}\(\(/;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const watched = new Map();
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const built = stampLayoutBids(number, textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      }));
      const scale = 2;
      const width = Math.ceil(viewport.width * scale);
      const height = Math.ceil(viewport.height * scale);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await pdfPage.render({ canvasContext: context, viewport: pdfPage.getViewport({ scale }) }).promise;
      const image = context.getImageData(0, 0, width, height);
      for (const block of built.blocks) {
        const suffix = String(block.bid || "").split("-").pop();
        if (["t053qgiy", "t0hivfc4", "t1xmh68y", "t060sodo", "m0rrcjic", "m1ubksbr", "m0payg9u"].includes(suffix)) {
          watched.set(`${number}:${suffix}`, block);
        }
        if (number === 5 && block.label === "formula" && block.display !== false) {
          watched.set("5:display", block);
        }
        const shown = blockRenderPieces(block, built.blocks)
          .filter((piece) => piece.type === "text")
          .map((piece) => piece.text)
          .join("");
        const text = `${block.text || ""}\n${shown}`;
        assert.equal(orphan.test(text), false, `${block.bid} ${text.slice(0, 180)}`);
        if (block.label !== "formula" || !Array.isArray(block.bbox)) continue;
        const sw = (block.bbox[2] - block.bbox[0]) * viewport.width * CROP_SCALE;
        const sh = (block.bbox[3] - block.bbox[1]) * viewport.height * CROP_SCALE;
        assert.ok(sw >= 24 && sh >= 12, `${block.bid} crop ${sw.toFixed(1)}×${sh.toFixed(1)}`);
        if (block.display === false) continue;
        const measured = measureFormulaCrop(block.bbox, image, {
          inline: false,
          protect: block.formulaInkProtect === true,
          maskBoxes: block.maskBoxes,
          glyphBoxes: block.glyphBoxes
        });
        const crop = measured.bbox || block.bbox;
        for (const glyph of block.glyphBoxes || []) {
          const dx = Math.max(0, crop[0] - glyph[0], glyph[2] - crop[2]);
          const dy = Math.max(0, crop[1] - glyph[1], glyph[3] - crop[3]);
          assert.ok(Math.max(dx, dy) <= 0.004, `${block.bid} crop misses a glyph by ${Math.max(dx, dy)}`);
        }
      }
    }
  } finally {
    await doc.destroy();
  }
  for (const suffix of ["t053qgiy", "t0hivfc4", "t1xmh68y"]) {
    const block = [...watched.values()].find((item) => String(item.bid).endsWith(suffix));
    assert.ok(block, suffix);
    assert.doesNotMatch(String(block.text || ""), /refθ?\(\(|yy\|\|/);
  }
  const sft = watched.get("3:t060sodo");
  assert.ok(sft);
  assert.match(sft.text, /^SFT:/);
  const wide = watched.get("18:m0rrcjic");
  const chain = watched.get("19:m1ubksbr");
  assert.equal(wide?.display, true);
  assert.equal(chain?.display, true);
  assert.ok(wide.bbox[2] >= 0.8, `p18 derivation right ${wide.bbox[2]}`);
  assert.ok(chain.bbox[2] >= 0.8, `p19 derivation right ${chain.bbox[2]}`);
  assert.equal(watched.has("5:m0payg9u"), false);
  const gradient = watched.get("5:display");
  assert.ok(gradient);
  assert.ok(gradient.bbox[2] >= 0.75, `p5 gradient right ${gradient.bbox[2]}`);
});
