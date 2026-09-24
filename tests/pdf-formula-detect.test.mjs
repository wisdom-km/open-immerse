import test from "node:test";
import assert from "node:assert/strict";
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
import { sameLineFormulaSpans, textLayerToBlocks } from "../lib/pdf-text-layer.js";

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
