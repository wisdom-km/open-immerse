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
  assert.match(viewer, /redrawFormulaGlyphs/);
  assert.match(viewer, /if \(drawn\) return drawn/);
  assert.match(viewer, /return cropBlockImage/);
  assert.match(viewer, /oi-formula-inline/);
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  assert.match(css, /img\.oi-formula-inline\s*\{[^}]*display:\s*inline-block/s);
  assert.match(css, /img\.oi-formula-inline\s*\{[^}]*box-shadow:\s*none/s);
  assert.match(css, /\[data-role="formula"\]\s*\{[^}]*box-shadow:\s*none/s);
  assert.match(css, /\[data-role="formula"\] img\s*\{[^}]*max-height:\s*3em/s);
  assert.doesNotMatch(css, /\[data-role="formula"\]\s*\{[^}]*margin:\s*16px 0/s);
});
