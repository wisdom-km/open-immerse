import "./helpers/block-live-fetch.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHARSET_COMMANDS,
  charsetEqual,
  latexToCharset,
  pdfTextCharset
} from "../lib/formula-charset.js";
import { stripTrailingVisionPunct, verifyCandidate } from "../lib/formula-verify.js";
import { loadKatex } from "./helpers/arxiv-paper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requirements = readFileSync(join(root, "pdf/high-precision/REQUIREMENTS.md"), "utf8");

test("AX-21 mapping table, unknown commands, and NFKC", () => {
  const section = requirements.slice(
    requirements.indexOf("第二层核对"),
    requirements.indexOf("**第三层")
  );
  for (const [name, ch] of Object.entries(CHARSET_COMMANDS)) {
    assert.match(section, new RegExp(`\\\\${name}\\b`));
    const rendered = latexToCharset(`\\${name}`);
    assert.equal(rendered.unknownCommands.length, 0, name);
    assert.equal(charsetEqual(rendered, pdfTextCharset(ch)), true, `${name} → ${ch}`);
  }
  assert.equal(charsetEqual(latexToCharset("\\epsilon"), pdfTextCharset("ε")), true);
  assert.equal(charsetEqual(latexToCharset("\\phi"), pdfTextCharset("φ")), true);
  assert.equal(charsetEqual(latexToCharset("\\cdot"), pdfTextCharset("⋅")), true);
  assert.equal(charsetEqual(latexToCharset("a-b"), pdfTextCharset("a−b")), true);
  assert.equal(charsetEqual(latexToCharset("\\|"), pdfTextCharset("∥")), true);
  assert.equal(charsetEqual(latexToCharset("\\mathbb{R}"), pdfTextCharset("ℝ")), true);
  assert.equal(charsetEqual(latexToCharset("\\mathbb{R}"), pdfTextCharset("R")), true);
  assert.equal(charsetEqual(latexToCharset("\\frac{1}{2}"), pdfTextCharset("12")), true);
  assert.equal(charsetEqual(latexToCharset("p^*"), pdfTextCharset("p∗")), true);
  assert.equal(charsetEqual(latexToCharset("p^{*}"), pdfTextCharset("p∗")), true);
  assert.equal(charsetEqual(latexToCharset("\\{"), pdfTextCharset("[")), true);
  assert.equal(charsetEqual(latexToCharset("\\}"), pdfTextCharset("]")), true);
  assert.equal(charsetEqual(latexToCharset("a[b]"), pdfTextCharset("a{b}")), true);
  assert.equal(latexToCharset("\\frac{1}{2}").chars.has("f"), false);
  const unknown = latexToCharset("\\SI{1}{m}");
  assert.ok(unknown.unknownCommands.includes("\\SI"));
  assert.equal(charsetEqual(unknown, pdfTextCharset("1m")), false);
});

test("delimiter and order commands map onto the PDF text layer", () => {
  const cases = [
    ["\\mid", "|"],
    ["\\vert", "|"],
    ["\\lvert", "|"],
    ["\\rvert", "|"],
    ["\\Vert", "‖"],
    ["\\lVert", "‖"],
    ["\\rVert", "‖"],
    ["\\prec", "≺"],
    ["\\succ", "≻"],
    ["\\preceq", "≼"],
    ["\\succeq", "≽"]
  ];
  for (const [latex, ch] of cases) {
    const rendered = latexToCharset(latex);
    assert.deepEqual(rendered.unknownCommands, [], latex);
    assert.equal(charsetEqual(rendered, pdfTextCharset(ch)), true, `${latex} → ${ch}`);
  }
});

test("hat, tilde, bar, and prime match the pdf.js accent glyphs", () => {
  const cases = [
    ["\\hat{r}_\\theta", "rˆθ"],
    ["\\hat{r}_\\theta", "r\u0302θ"],
    ["\\tilde\\mu_t", "μ˜t"],
    ["\\tilde\\mu_t", "μ\u0303t"],
    ["\\hat x_0", "ˆx0"],
    ["\\bar{x}", "x¯"],
    ["\\overline{x}", "x¯"],
    ["x'", "x′"],
    ["x^{\\prime}", "x′"]
  ];
  for (const [latex, pdf] of cases) {
    const rendered = latexToCharset(latex);
    assert.deepEqual(rendered.unknownCommands, [], latex);
    assert.equal(charsetEqual(rendered, pdfTextCharset(pdf)), true, `${latex} vs ${pdf}`);
  }
});

test("trailing sentence punctuation is dropped only when the text layer lacks it", () => {
  const katex = loadKatex();
  const cases = [
    ["d_k.", "dk"],
    ["\\pi_\\theta,", "πθ"],
    ["\\hat{r}_\\theta", "rˆθ"],
    ["\\tilde\\mu_t", "μ˜t"],
    ["\\hat x_0", "ˆx0"]
  ];
  for (const [latex, pdf] of cases) {
    const verdict = verifyCandidate(latex, { pdfText: pdf, display: false }, katex);
    assert.equal(verdict.pass, true, `${latex} vs ${pdf} ${verdict.reason || ""} j=${verdict.checks.charset.jaccard}`);
    assert.equal(verdict.latex.endsWith(".") || verdict.latex.endsWith(","), false, latex);
  }
  assert.equal(stripTrailingVisionPunct("Z(x).", "Z(x)."), "Z(x).");
  const kept = verifyCandidate("Z(x).", { pdfText: "Z(x).", display: true }, katex);
  assert.equal(kept.pass, true, kept.reason || "");
  assert.equal(kept.latex, "Z(x).");
});

test("DPO eq(5) with \\mid verifies against the PDF text", () => {
  const katex = loadKatex();
  const latex = "r(x, y) = \\beta \\log \\frac{\\pi_r(y \\mid x)}{\\pi_{\\mathrm{ref}}(y \\mid x)} + \\beta \\log Z(x)";
  // The fraction rule is not a text-layer character, so the PDF side has no slash.
  const pdfText = "r(x,y)=βlogπr(y|x)πref(y|x)+βlogZ(x)";
  const verdict = verifyCandidate(latex, { pdfText, display: true }, katex);
  assert.deepEqual(verdict.checks.charset.missingCommands, []);
  assert.equal(verdict.checks.charset.jaccard, 1);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.pass, true);
});
