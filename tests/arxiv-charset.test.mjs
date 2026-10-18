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
import { verifyCandidate } from "../lib/formula-verify.js";
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
