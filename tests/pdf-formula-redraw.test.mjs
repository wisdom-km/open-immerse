import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redrawFormulaGlyphs } from "../lib/pdf-formula-redraw.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("redraw falls back when there is no canvas", () => {
  assert.equal(redrawFormulaGlyphs(null, [[0.1, 0.2, 0.3, 0.4]], [0.1, 0.2, 0.4, 0.5]), "");
  assert.equal(redrawFormulaGlyphs({ getContext() { return {}; } }, [], [0, 0, 1, 1]), "");
});

test("redraw copies formula glyphs and falls back when drawing throws", () => {
  const draws = [];
  const out = {
    width: 0,
    height: 0,
    getContext() {
      return {
        fillRect() {},
        drawImage(...args) { draws.push(args); }
      };
    },
    toDataURL() { return "data:image/png;base64,AAAA"; }
  };
  const canvas = {
    width: 1000,
    height: 1000,
    ownerDocument: { createElement() { return out; } },
    getContext() { return {}; }
  };
  const url = redrawFormulaGlyphs(canvas, [[0.2, 0.3, 0.28, 0.34]], [0.2, 0.3, 0.4, 0.36]);
  assert.equal(url, "data:image/png;base64,AAAA");
  assert.equal(draws.length, 1);
  out.getContext = () => ({
    fillRect() {},
    drawImage() { throw new Error("clip"); }
  });
  assert.equal(redrawFormulaGlyphs(canvas, [[0.2, 0.3, 0.28, 0.34]], [0.2, 0.3, 0.4, 0.36]), "");
});

test("viewer keeps the page raster crop when glyph redraw is unavailable", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const blocks = readFileSync(join(root, "lib/pdf-blocks.js"), "utf8");
  assert.match(viewer, /redrawFormulaGlyphs/);
  assert.match(viewer, /if \(drawn\) return drawn/);
  assert.match(viewer, /return cropBlockImage/);
  assert.match(viewer, /oi-pdf-inline-math/);
  assert.match(viewer, /oi-pdf-math-crop/);
  assert.match(viewer, /oi-pdf-caption/);
  assert.match(blocks, /oi-pdf-display-math/);
  assert.match(blocks, /oi-pdf-figure/);
  assert.match(blocks, /oi-pdf-asset-crop/);
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  assert.match(css, /\.oi-pdf-inline-math\s*\{[^}]*display:\s*inline-block/s);
  assert.match(css, /\.oi-pdf-inline-math\s*\{[^}]*max-height:\s*1\.35em/s);
  assert.match(css, /\.oi-pdf-inline-math \.oi-pdf-math-crop\s*\{[^}]*height:\s*1\.15em/s);
  assert.match(css, /\.oi-pdf-inline-math \.oi-pdf-math-crop\s*\{[^}]*box-shadow:\s*none/s);
  assert.match(css, /\.oi-pdf-display-math\s*\{[^}]*margin:\s*12px 0 16px/s);
  assert.match(css, /\.oi-pdf-display-math\s*\{[^}]*box-shadow:\s*none/s);
  assert.match(css, /\.oi-pdf-figure\s*\{[^}]*box-shadow:\s*none/s);
  assert.doesNotMatch(css, /\.oi-pdf-display-math\s*\{[^}]*box-shadow:\s*var\(--oi-shadow/s);
  assert.doesNotMatch(css, /oi-formula-inline/);
});
