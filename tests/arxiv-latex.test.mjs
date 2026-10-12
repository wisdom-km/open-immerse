import test from "node:test";
import assert from "node:assert/strict";
import { PERMISSION_RE } from "../lib/pdf-readout.js";
import { parseLatexSource } from "../lib/latex-units.js";
import {
  SRC_V7,
  SRC_V7_SHA,
  loadKatex,
  loadSource,
  parsePacked
} from "./helpers/arxiv-paper.mjs";

const katex = loadKatex();
const packed = await loadSource(
  SRC_V7,
  SRC_V7_SHA,
  "从 https://arxiv.org/src/1706.03762v7 下载到 tests/fixtures/arxiv-src/。"
);
const parsed = await parsePacked(packed, katex);

test("AX-13 Attention v7 unit counts and KaTeX", () => {
  assert.equal(parsed.supported, true);
  assert.equal(parsed.main, "ms.tex");
  assert.deepEqual(parsed.stats, {
    display: 5,
    inline: 98,
    inlineBody: 87,
    inlineFloat: 11,
    headings: 25,
    macros: 16
  });
  const displays = parsed.units.filter((unit) => unit.kind === "display");
  const inlines = [];
  for (const unit of parsed.units) {
    for (const part of unit.parts || []) {
      if (part.type === "inline") inlines.push(part);
    }
  }
  assert.equal(displays.length, 5);
  assert.equal(inlines.length, 98);
  assert.equal(displays.every((unit) => unit.katexOk === true), true);
  assert.equal(inlines.every((part) => part.katexOk === true), true);
  assert.equal(parsed.unsupported.length, 0);
});

test("AX-14 commented inputs, preamble macros, and the permission notice", () => {
  const blob = parsed.units.map((unit) => `${unit.text || ""}\n${unit.latex || ""}`).join("\n");
  const side = packed.files.find((file) => /parameter_attention/.test(file.path));
  const trick = packed.files.find((file) => /sqrt_d_trick/.test(file.path));
  assert.ok(side && trick);
  assert.equal(blob.includes("parameter_attention"), false);
  assert.equal(blob.includes(side.text.slice(0, 80)), false);
  assert.equal(parsed.units.some((unit) => unit.kind === "display" && /newcommand/.test(unit.latex || "")), false);
  assert.equal(parsed.units.some((unit) => PERMISSION_RE.test(unit.text || "")), false);
  assert.match(packed.files.find((file) => file.path === "ms.tex").text, /Provided proper attribution/i);
});

test("AX-15 plain TeX, missing main, and an unsupported command", () => {
  const plain = parseLatexSource([{ path: "hep.tex", text: "Plain text $$x$$ \\bye\n" }]);
  assert.equal(plain.supported, false);
  assert.equal(plain.unsupported[0].reason, "plain-tex");
  const noMain = parseLatexSource([
    { path: "a.tex", text: "\\documentclass{article}\n" },
    { path: "b.tex", text: "no document" }
  ]);
  assert.equal(noMain.supported, false);
  assert.equal(noMain.unsupported[0].reason, "no-main");
  const odd = parseLatexSource([
    {
      path: "m.tex",
      text: "\\documentclass{article}\\begin{document} $\\SI{1}{m}$ \\end{document}\n"
    }
  ], { katex });
  assert.equal(odd.supported, true);
  assert.equal(odd.unsupported.length, 1);
  assert.equal(odd.unsupported[0].reason, "katex");
});
