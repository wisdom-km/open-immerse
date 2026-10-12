import test from "node:test";
import assert from "node:assert/strict";
import { alignSourceToBlocks } from "../lib/source-align.js";
import {
  SRC_V1,
  SRC_V1_SHA,
  SRC_V7,
  SRC_V7_SHA,
  loadAttentionPages,
  loadKatex,
  loadSource,
  parsePacked
} from "./helpers/arxiv-paper.mjs";

const katex = loadKatex();
const paper = await loadAttentionPages();
const v7 = await parsePacked(await loadSource(
  SRC_V7,
  SRC_V7_SHA,
  "从 https://arxiv.org/src/1706.03762v7 下载到 tests/fixtures/arxiv-src/。"
), katex);
const v1 = await parsePacked(await loadSource(
  SRC_V1,
  SRC_V1_SHA,
  "从 https://arxiv.org/src/1706.03762v1 下载到 tests/fixtures/arxiv-src/。"
), katex);
const alignedV7 = alignSourceToBlocks({ units: v7.units, pages: paper.pages });
const alignedV1 = alignSourceToBlocks({ units: v1.units, pages: paper.pages });

function bodyInlines(aligned) {
  return aligned.formulas.filter((formula) => formula.kind === "inline" && formula.zone === "body");
}

test("AX-16 v7 blocks and display formulas", () => {
  assert.equal(alignedV7.stats.translatableBlocks, 108);
  assert.ok(alignedV7.stats.blocksAt90 >= 104);
  const displays = alignedV7.formulas.filter((formula) => formula.kind === "display");
  assert.equal(displays.length, 5);
  assert.equal(displays.filter((formula) => formula.checks.position).length, 5);
  assert.equal(displays.filter((formula) => formula.checks.chars).length, 5);
  assert.equal(displays.filter((formula) => formula.number).length, 3);
  assert.equal(displays.filter((formula) => formula.checks.number).length, 5);
  assert.equal(alignedV7.useSource, true);
});

test("AX-17 v7 body inline formulas", () => {
  const rows = bodyInlines(alignedV7);
  assert.equal(rows.length, 87);
  assert.ok(rows.filter((formula) => formula.checks.position).length >= 85);
  assert.ok(rows.filter((formula) => formula.checks.chars).length >= 83);
});

test("AX-18 v1 against the v7 PDF", () => {
  const displays = alignedV1.formulas.filter((formula) => formula.kind === "display");
  const multi = displays.find((formula) => /MultiHead/.test(formula.latex));
  assert.ok(multi);
  assert.equal(multi.checks.chars, false);
  assert.equal(multi.pass, false);
  const extra = displays.filter((formula) => formula.checks.position === false);
  assert.ok(extra.length >= 1);
  assert.equal(extra.every((formula) => formula.pass === false), true);
  assert.ok(Math.abs(alignedV1.stats.wordRate - 0.898) <= 0.01, String(alignedV1.stats.wordRate));
  assert.equal(alignedV1.useSource, true);
});

test("AX-19 synthetic 50-page alignment stays under 64MB", () => {
  const units = [];
  const pages = [];
  for (let page = 1; page <= 50; page += 1) {
    const words = Array.from({ length: 80 }, (_, index) => `p${page}w${index}`);
    const text = words.join(" ");
    units.push({
      id: `u${page}`,
      kind: "paragraph",
      text,
      parts: [{ type: "text", text }]
    });
    pages.push({
      page,
      blocks: [{ id: `p${page}-b1`, label: "text", text }]
    });
  }
  const aligned = alignSourceToBlocks({ units, pages });
  assert.ok(aligned.stats.peakHeapDelta < 64 * 1024 * 1024);
  assert.equal(aligned.useSource, true);
});

test("AX-20 offline report names the three PDF-pipeline issues", () => {
  const issues = alignedV7.report.issues;
  assert.ok(issues.some((issue) => issue.kind === "heading-swallowed-by-figure" && issue.blockId === "p13-b1"));
  assert.ok(issues.some((issue) => issue.kind === "paragraph-labeled-caption" && issue.blockId === "p8-b10"));
  assert.ok(issues.some((issue) => issue.kind === "formula-swallowed-prose" && issue.blockId === "p7-b3"));
});
