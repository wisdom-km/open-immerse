import test from "node:test";
import assert from "node:assert/strict";

import {
  GLYPH_MAP_VERSION,
  isDecorativeText,
  remainingLigatureHoles,
  sanitizeBlockText,
  sanitizePdfTextItem
} from "../lib/pdf-glyph-sanitize.js";
import { countLeaks, readingSurfaceText } from "../lib/pdf-leak-rules.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";

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

test("glyph map version is explicit", () => {
  assert.equal(GLYPH_MAP_VERSION, "m1-1");
});

test("invisible characters are stripped and ligature holes are filled", () => {
  assert.equal(sanitizePdfTextItem("hel\u200Blo\uFEFF"), "hello");
  assert.equal(sanitizePdfTextItem("exam\u00ADple"), "example");
  assert.equal(sanitizeBlockText("a speci c result"), "a specific result");
  assert.equal(sanitizeBlockText("The rst trial"), "The first trial");
  assert.equal(sanitizeBlockText("RST"), "RST");
  assert.deepEqual(remainingLigatureHoles("a specific result"), []);
  assert.deepEqual(remainingLigatureHoles("a speci c result"), ["speci c"]);
});

test("equals signs stay, including the paper-08 negative example", () => {
  assert.equal(sanitizePdfTextItem("a == b", "CMEX10"), "a == b");
  assert.equal(sanitizePdfTextItem("==", "Symbol"), "==");
  assert.equal(sanitizeBlockText("width == 4"), "width == 4");
});

test("thorn and quarter map only with a math font or operator context", () => {
  assert.equal(sanitizePdfTextItem("2þ3", "CMEX10"), "2+3");
  assert.equal(sanitizePdfTextItem("þetta"), "þetta");
  assert.equal(sanitizePdfTextItem("2þ3"), "2+3");
  assert.equal(sanitizePdfTextItem("¼ of patients"), "¼ of patients");
  assert.equal(sanitizePdfTextItem("2¼"), "2¼");
  assert.equal(sanitizePdfTextItem("¼=", "Times-Roman"), "==");
  assert.equal(sanitizePdfTextItem("x¼y", "CMEX10"), "x=y");
  assert.equal(sanitizePdfTextItem("¼", "Symbol"), "\u2026");
  assert.equal(sanitizePdfTextItem("å", "Symbol"), "\u03A3");
  assert.equal(sanitizePdfTextItem("å", "Times-Roman"), "å");
});

test("a CMEX item that is only r becomes summation", () => {
  assert.equal(sanitizePdfTextItem("r", "ABCDEF+CMEX10"), "\u2211");
  assert.equal(sanitizePdfTextItem("r", "CMMI10"), "r");
  assert.equal(sanitizePdfTextItem("rr", "CMEX10"), "rr");
  assert.equal(sanitizePdfTextItem("p\uFB03\uFB032", "CMEX10"), "\u221A2");
});

test("decorative rules are recognizable and removed", () => {
  assert.equal(isDecorativeText("a1111111111"), true);
  assert.equal(isDecorativeText("attention"), false);
  assert.equal(sanitizePdfTextItem("a1111111111"), "");
  assert.equal(sanitizeBlockText("see a1111111111 here"), "see  here");
});

test("product text-layer surface drops leaks and keeps the title and abstract", () => {
  const items = [
    { str: "Attention Is All You Need", x: 96, y: 730, width: 420, height: 20 },
    { str: "Abstract", x: 72, y: 548, width: 70, height: 14, fontName: "Helvetica-Bold" },
    { str: "A speci c result uses 2þ3.\u200B", x: 72, y: 520, width: 240, height: 11 },
    { str: "a1111111111", x: 36, y: 400, width: 80, height: 8 },
    { str: "OPEN ACCESS", x: 36, y: 380, width: 70, height: 8 },
    { str: "10.1371/journal.pmed.1003346", x: 36, y: 24, width: 180, height: 8 },
    { str: "r", x: 300, y: 500, width: 8, height: 10, fontName: "CMEX10" },
    { str: "1", x: 300, y: 12, width: 8, height: 8 }
  ];
  const page = textLayerToBlocks({
    items,
    viewport: unitViewport(612, 792),
    page: 1
  });
  const surface = readingSurfaceText(page);
  assert.match(surface, /Attention Is All You Need/);
  assert.match(surface, /Abstract/);
  assert.match(surface, /specific result uses 2\+3/);
  assert.equal(surface.includes("a111"), false);
  assert.equal(/open access/i.test(surface), false);
  assert.equal(surface.includes("10.1371"), false);
  assert.equal(countLeaks(surface).total, 0);
});
