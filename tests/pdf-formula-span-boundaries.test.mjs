import test from "node:test";
import assert from "node:assert/strict";
import { sameLineFormulaSpans, textLayerToBlocks } from "../lib/pdf-text-layer.js";

const BODY = "NimbusRomNo9L-Regu";

function viewport() {
  return {
    width: 612,
    height: 792,
    convertToViewportRectangle(rect) {
      const [x1, y1, x2, y2] = rect;
      return [x1, 792 - y2, x2, 792 - y1];
    }
  };
}

let cursor = 0;
function glyph(str, font, extra = {}) {
  const height = extra.h || 10;
  const width = extra.w ?? Math.max(3, String(str).length * height * 0.5);
  const item = {
    str,
    x: cursor,
    y: 100 + (extra.dy || 0),
    width,
    height,
    fontName: "g_d0_f1",
    ...(font ? { fontRealName: font } : {})
  };
  cursor += width + (extra.gap ?? 0.4);
  return item;
}

function row(parts) {
  cursor = 72;
  return parts.map((part) => glyph(part[0], part[1], part[2] || {}));
}

function spanText(items) {
  return sameLineFormulaSpans(items).map(([start, end]) => items.slice(start, end + 1).map((item) => item.str).join(""));
}

const cmr = (str, extra) => [str, "CMR10", extra];
const cmmi = (str, extra) => [str, "CMMI10", extra];
const cmsy = (str, extra) => [str, "CMSY10", extra];
const sub = (str, extra = {}) => [str, "CMMI7", { h: 7, dy: -3, ...extra }];

test("a relation comma splits two formulas in every face, including ones outside the old allowlist", () => {
  const fonts = [
    ["Nimbus", BODY],
    ["empty", null],
    ["CMR", "CMR10"],
    ["CMMI", "CMMI10"],
    ["AdvOT", "AdvOT1ef757c0"],
    ["STIX Two Text", "STIXTwoText"],
    ["Minion", "MinionPro-Regular"]
  ];
  for (const [name, font] of fonts) {
    const items = row([
      ["with ", BODY],
      cmmi("β"),
      sub("1"),
      cmsy("="),
      cmr("0.9"),
      [",", font],
      cmmi("β"),
      sub("2"),
      cmsy("="),
      cmr("0.98"),
      [" and ", BODY],
      cmmi("ϵ"),
      cmsy("="),
      cmr("10"),
      ["−", "CMSY7", { h: 7, dy: 3 }],
      ["9", "CMR7", { h: 7, dy: 3 }]
    ]);
    const spans = spanText(items);
    assert.deepEqual(spans, ["β1=0.9", "β2=0.98", "ϵ=10−9"], name);
    const runs = sameLineFormulaSpans(items);
    for (const [start, end] of runs) {
      const width = items[end].x + items[end].width - items[start].x;
      assert.ok(width < 80, `${name} crop ${width}`);
    }
  }
});

test("commas inside brackets or a subscript stay in one formula", () => {
  const tuple = (font) => row([
    ["tuple ", BODY],
    cmr("("),
    cmmi("k"),
    sub("1"),
    [",", font],
    cmmi("..."),
    [",", font],
    cmmi("k"),
    sub("n"),
    cmr(")"),
    [" holds", BODY]
  ]);
  assert.deepEqual(spanText(tuple(null)), ["(k1,...,kn)"]);
  assert.deepEqual(spanText(tuple(BODY)), ["(k1,...,kn)"]);
  assert.deepEqual(spanText(row([
    ["values ", BODY],
    cmsy("{"),
    cmr("0.1"),
    [",", BODY],
    cmr("0.2"),
    [",", BODY],
    cmr("0.3"),
    cmsy("}"),
    [" were", BODY]
  ])), ["{0.1,0.2,0.3}"]);
  assert.deepEqual(spanText(row([
    ["entry ", BODY],
    cmmi("x"),
    sub("i"),
    [",", BODY, { h: 7, dy: -3 }],
    sub("j"),
    cmsy("="),
    cmr("0"),
    [" here", BODY]
  ])), ["xi,j=0"]);
  const call = spanText(row([
    ["the map ", BODY],
    cmmi("f"),
    cmr("("),
    cmmi("x"),
    [",", BODY],
    cmmi("y"),
    cmr(")"),
    [" is smooth", BODY]
  ]));
  assert.equal(call.length <= 1, true);
  assert.equal(call.some((text) => text === "x" || text === "y" || text === "(x"), false);
});

test("an unanchored math prefix stays on the formula", () => {
  assert.deepEqual(spanText(row([
    ["let ", BODY],
    cmmi("g"),
    cmr("("),
    ["x", BODY],
    cmr(")"),
    cmsy("="),
    cmmi("x"),
    [" hold", BODY]
  ])), ["g(x)=x"]);
  assert.deepEqual(spanText(row([
    ["so ", BODY],
    cmmi("gcd"),
    cmr("("),
    cmmi("a"),
    sub("n"),
    [",", BODY],
    cmmi("a"),
    sub("m"),
    cmr(")"),
    cmsy("="),
    cmr("1")
  ])), ["gcd(an,am)=1"]);
  assert.deepEqual(spanText(row([
    ["region ", BODY],
    cmr("1"),
    [".", BODY],
    cmr("37"),
    cmsy("<"),
    cmmi("|η|"),
    cmsy("<"),
    cmr("1"),
    [" GeV", BODY]
  ])), ["1.37<|η|<1"]);
});

test("a numeric pi scale stays in the sentence and a pi expression stays inline", () => {
  const around = (parts) => spanText(row([["from ", BODY], ...parts, [" to the end", BODY]]));
  assert.deepEqual(around([cmr("10000"), cmsy("·"), cmr("2"), cmmi("π")]), []);
  assert.deepEqual(around([cmr("3"), cmsy("×"), cmr("2"), cmmi("π")]), []);
  assert.deepEqual(around([cmr("0.5"), cmmi("π")]), []);
  assert.deepEqual(around([cmr("2"), cmmi("π")]), []);
  assert.deepEqual(around([["2π", BODY]]), []);
  assert.deepEqual(around([cmr("2"), cmsy("·"), cmmi("π")]), ["2·π"]);
  assert.deepEqual(around([cmmi("π"), cmmi("/"), cmr("2")]), ["π/2"]);
  assert.deepEqual(around([cmsy("−"), cmr("2"), cmmi("π")]), ["−2π"]);
  assert.deepEqual(around([cmr("2"), cmmi("π"), cmmi("i")]), ["2πi"]);
});

test("a sum keeps a limit that sits well below the operator", () => {
  for (const dy of [-5, -9, -12]) {
    const items = row([
      ["we have ", BODY],
      cmmi("L"),
      cmsy("="),
      ["∑", "CMEX10", { h: 14, dy: -3 }],
      ["i", "CMMI7", { h: 7, dy }],
      cmmi("L"),
      sub("i"),
      cmmi("W"),
      sub("i"),
      [" for all", BODY]
    ]);
    assert.deepEqual(spanText(items), ["L=∑iLiWi"], `dy ${dy}`);
  }
});

function pageItems(lines) {
  const items = [];
  let y = 640;
  for (const line of lines) {
    cursor = line.x0 ?? 72;
    for (const part of line.parts) {
      const item = glyph(part[0], part[1], part[2] || {});
      item.y = y + ((part[2] || {}).dy || 0);
      items.push(item);
    }
    y -= line.lead ?? 14;
  }
  return items;
}

test("a full-size body line that mentions beta stays prose", () => {
  const page = textLayerToBlocks({
    items: pageItems([
      { parts: [cmmi("L"), cmsy("="), ["∑", "CMEX10", { h: 18, dy: -4, w: 12 }], ["i", "CMMI7", { h: 7, dy: -12 }], cmmi("W")] },
      {
        lead: 20,
        parts: [[
          "enterohepatic reabsorption of the drug is limited by bacterial ",
          BODY,
          { w: 280 }
        ], cmmi("β"), ["-glucuronidase in the gut lumen", BODY, { w: 180 }]]
      }
    ]),
    viewport: viewport(),
    page: 10
  });
  const prose = page.blocks.filter((block) => block.label === "text").map((block) => block.sourceText || block.text).join(" ");
  assert.match(prose, /enterohepatic reabsorption/);
  assert.match(prose, /β/);
  assert.match(prose, /gut lumen/);
  assert.equal(page.blocks.some((block) => block.label === "formula" && /enterohepatic|glucuronidase|lumen/.test(block.sourceText || block.text || "")), false);
  const formulas = page.blocks.filter((block) => block.label === "formula");
  assert.equal(formulas.length, 1);
  assert.equal(formulas[0].display, true);
});

test("an equation number on the right of a display stays in that display", () => {
  const page = textLayerToBlocks({
    items: pageItems([
      { parts: [["The update is written as the following display.", BODY, { w: 280 }]] },
      {
        x0: 180,
        lead: 18,
        parts: [
          cmmi("y"),
          cmsy("="),
          cmmi("a"),
          cmmi("x"),
          cmsy("+"),
          cmmi("b"),
          ["(2.4)", BODY, { w: 28, gap: 70, dy: -1 }]
        ]
      }
    ]),
    viewport: viewport(),
    page: 5
  });
  const display = page.blocks.filter((block) => block.label === "formula" && block.display === true);
  assert.equal(display.length, 1);
  assert.equal(page.blocks.some((block) => /\(2\.4\)/.test(block.text || block.sourceText || "") && block.label === "text"), false);
});

test("a sentence that merely cites equation (n) stays prose", () => {
  const cited = textLayerToBlocks({
    items: pageItems([
      { parts: [["The bound is tight as shown in (3).", BODY, { w: 240 }]] },
      { parts: [["Next paragraph starts here and continues with ordinary prose.", BODY, { w: 320 }]] }
    ]),
    viewport: viewport(),
    page: 3
  });
  assert.equal(cited.blocks.some((block) => block.label === "formula" && block.display === true), false);
  assert.match(cited.blocks.map((block) => block.text || "").join(" "), /as shown in \(3\)/);

  const named = textLayerToBlocks({
    items: pageItems([
      { parts: [["We use Eq. (3) for the update.", BODY, { w: 220 }]] },
      { parts: [["Next paragraph starts here and continues with ordinary prose.", BODY, { w: 320 }]] }
    ]),
    viewport: viewport(),
    page: 4
  });
  assert.equal(named.blocks.some((block) => block.label === "formula" && block.display === true), false);
});

test("a function name inside a display is not prose", () => {
  const page = textLayerToBlocks({
    items: pageItems([
      { lead: 24, parts: [["Then the identity is the display", BODY, { w: 180 }]] },
      {
        x0: 160,
        parts: [
          ["ppcm (", "Utopia-Regular", { w: 42, dy: 6 }],
          cmmi("a"),
          [" , ", "CMR10"],
          cmmi("b"),
          [") = ", "CMR10"],
          cmmi("c"),
          [" . (1)", "CMR10", { w: 28 }]
        ]
      }
    ]),
    viewport: viewport(),
    page: 5
  });
  const prose = page.blocks.filter((block) => block.label === "text").map((block) => block.sourceText || block.text).join("\n");
  assert.doesNotMatch(prose, /ppcm/);
  assert.equal(page.blocks.some((block) => block.label === "formula" && block.display === true), true);
});

test("a relation does not grow a box that ends in the middle of a number", () => {
  const items = row([
    cmmi("H"),
    cmr("= 0"),
    cmmi("."),
    ["139 for the NASDAQ index in the sample", BODY, { w: 180 }]
  ]);
  assert.deepEqual(spanText(items), []);
});

test("a relation stops before a citation bracket", () => {
  const items = row([
    cmmi("ϵ"),
    sub("ls"),
    cmr("= 0"),
    cmmi("."),
    cmr("1"),
    ["[", BODY],
    ["36", BODY],
    ["]. This", BODY, { w: 40 }]
  ]);
  const spans = spanText(items);
  assert.equal(spans.some((text) => text.includes("[")), false);
  assert.equal(spans.some((text) => /0\.1/.test(text)), true);
});

test("a superscript after a minus stays an exponent", () => {
  const page = textLayerToBlocks({
    items: pageItems([
      {
        parts: [["for any value above the line. Likewise the measure stays in the sentence", BODY, { w: 340 }]]
      },
      {
        lead: 12,
        parts: [
          ["S", BODY],
          ["d", BODY, { h: 7, dy: 4 }],
          ["−", BODY, { h: 7, dy: 4 }],
          ["1", BODY, { h: 7, dy: 4 }],
          [", an equivalent norm for the space follows at once from the definition", BODY, { w: 280 }]
        ]
      }
    ]),
    viewport: viewport(),
    page: 6
  });
  const prose = page.blocks.filter((block) => block.label === "text").map((block) => block.sourceText || block.text);
  assert.equal(prose.some((text) => text.trim() === "1"), false);
  assert.match(prose.join(" "), /d−1/);
});

test("a footnote paragraph does not merge into the body", () => {
  const body = glyph("The surface shape does not change, at least to a first approximation.", BODY, { w: 340 });
  body.y = 220;
  cursor = 72;
  const mark = glyph("2", BODY, { h: 6, w: 6 });
  mark.y = 180;
  cursor = 80;
  const note = glyph("Closing prices of every listed strike were recorded on that date.", BODY, { h: 8, w: 320 });
  note.y = 168;
  const page = textLayerToBlocks({ items: [body, mark, note], viewport: viewport(), page: 4 });
  const prose = page.blocks.filter((block) => block.label === "text").map((block) => block.sourceText || block.text);
  const sentence = prose.find((text) => /first approximation/.test(text));
  assert.ok(sentence);
  assert.doesNotMatch(sentence, /Closing prices/);
});

test("a hyphenated word stays on the sentence that contains it", () => {
  const page = textLayerToBlocks({
    items: pageItems([
      {
        parts: [
          ["U.S.O. solved the k", BODY, { w: 150 }],
          ["-dependent radial equation follows at once from the definition", BODY, { w: 280, dy: -10 }]
        ]
      }
    ]),
    viewport: viewport(),
    page: 10
  });
  const hit = page.blocks.filter((block) => block.label === "text" && /solved the k/.test(block.sourceText || block.text));
  assert.equal(hit.length, 1);
  assert.match(hit[0].sourceText || hit[0].text, /k-dependent/);
});

test("a radical ligature stays on the sentence that contains it", () => {
  const page = textLayerToBlocks({
    items: pageItems([
      {
        parts: [
          ["gauge links that are shorter by a factor of ", BODY, { w: 220 }],
          ["pffiffiffi2, and", BODY, { w: 52, dy: 6 }],
          [" each site has eight nearest neighbors in the lattice", BODY, { w: 240 }]
        ]
      }
    ]),
    viewport: viewport(),
    page: 4
  });
  const hit = page.blocks.filter((block) => block.label === "text" && /factor of/.test(block.sourceText || block.text));
  assert.equal(hit.length, 1);
  assert.match(hit[0].sourceText || hit[0].text, /and each site/);
});
