import test from "node:test";
import assert from "node:assert/strict";

import {
  GLYPH_GAP_MARK,
  GLYPH_MAP_VERSION,
  isDecorativeText,
  remainingLigatureHoles,
  sanitizeBlockText,
  sanitizePdfTextItem
} from "../lib/pdf-glyph-sanitize.js";
import { countNoise } from "../lib/pdf-leak-rules.js";
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
  assert.equal(GLYPH_MAP_VERSION, "m1-2");
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

test("APS pi font restores parentheses, plus, and equals from the PRL snippets", () => {
  const font = "CMCIJE+AdvP4C4E74";
  assert.equal(sanitizePdfTextItem("\u00F0t\u00DE", font), "(t)");
  assert.equal(sanitizePdfTextItem("\u00FE", font), "+");
  assert.equal(sanitizePdfTextItem("\u00BC", font), "=");
  assert.equal(sanitizeBlockText("redshift z \u00BC 0.09"), "redshift z = 0.09");
  assert.equal(sanitizeBlockText("multiply by (1 \u00FE z)"), "multiply by (1 + z)");
  assert.equal(sanitizeBlockText("\u03C1\u00F0t\u00DE"), "\u03C1(t)");
  assert.equal(sanitizePdfTextItem("\u00FEetta"), "\u00FEetta");
  assert.equal(countLeaks(sanitizeBlockText("\u03C1\u00F0t\u00DE \u00BC 1 \u00FE z")).total, 0);
});

test("Symbol private-use and CMEX delimiters remap; unknown runs are gap marks", () => {
  assert.equal(sanitizePdfTextItem("\uF074\uF071\uF064\uF072\uF073"), "\u03C4\u03B8\u03B4\u03C1\u03C3");
  assert.equal(sanitizePdfTextItem("\uF0B7"), "\u2022");
  assert.equal(sanitizePdfTextItem("\uF06C", "SymbolMT"), "\u03BB");
  assert.equal(sanitizePdfTextItem("\uF074", "Wingdings"), GLYPH_GAP_MARK);
  assert.equal(sanitizePdfTextItem("\uF8F1\uF8F2\uF8F3", "CMEX10"), "\u23A7\u23A8\u23A9");
  assert.equal(sanitizePdfTextItem("\uF8EB\uF8F6\uF8ED\uF8F8"), "\u239B\u239E\u239D\u23A0");
  assert.equal(sanitizePdfTextItem("\uFFFD\uFFFD"), GLYPH_GAP_MARK);
  assert.equal(sanitizePdfTextItem("\uE103\uE09D\uE104"), GLYPH_GAP_MARK);
  assert.equal(countLeaks(sanitizeBlockText("\uF074 \uF8F1 \uFFFD \uE103")).total, 0);
  assert.equal(sanitizeBlockText("\u00FEetta"), "\u00FEetta");
  assert.equal(sanitizeBlockText("Nal Kalchbrenner"), "Nal Kalchbrenner");
  const stored = readingSurfaceText({
    blocks: [{ label: "formula", sourceText: "\uF8EE" }]
  });
  assert.equal(countLeaks(stored).total, 0);
  assert.match(stored, /\u23A1/);
});

test("a ligature hole split by a newline is one word, and bare numbers are not page noise", () => {
  assert.equal(sanitizeBlockText("signi\ncant"), "significant");
  const surface = readingSurfaceText({
    blocks: [
      { label: "text", text: "a signi" },
      { label: "text", text: "cant result" }
    ]
  });
  assert.equal(surface, "a significant result");
  assert.equal(countLeaks(surface).total, 0);
  const noise = countNoise(["22", "99", "100", "19", "37", "\u2013 1 \u2013", "20-"].join("\n"));
  assert.deepEqual(noise.examples, ["\u2013 1 \u2013", "20-"]);
  assert.equal(noise.total, 2);
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
