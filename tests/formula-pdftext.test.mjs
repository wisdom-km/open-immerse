/**
 * Device regression: a formula unit must carry the text-layer source.
 * The chain is the one the reader uses: text layer → toProtocol →
 * normalizeIncomingBlock → vendorLayoutToBlocks → formulaUnitFromBlock.
 * Tests inject pdfText by hand everywhere else, so this file is what
 * would have failed on a6878e0.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";
import { translatableBlocks } from "../lib/pdf-blocks.js";
import { formulaUnitFromBlock, scheduleFormulaBlock } from "../lib/formula-schedule.js";
import { verifyCandidate } from "../lib/formula-verify.js";
import { loadKatex } from "./helpers/arxiv-paper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const katex = loadKatex();

test("DPO eq(5) keeps its text-layer source through to the formula unit", async () => {
  assert.equal(readFileSync(dpoPath).byteLength > 1000, true);
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(dpoPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const number = 4;
  const pdfPage = await doc.getPage(number);
  const content = await pdfPage.getTextContent();
  const viewport = pdfPage.getViewport({ scale: 1 });
  const layer = textLayerToBlocks({
    items: content.items,
    viewport,
    page: number
  });
  const adapted = vendorLayoutToBlocks({
    pixelWidth: viewport.width,
    pixelHeight: viewport.height,
    layoutDetails: []
  }, { items: content.items, viewport, page: number });
  const fromLayer = layer.blocks.find((block) => block.eqLabel === "(5)");
  const formula = adapted.blocks.find((block) => block.eqLabel === "(5)");
  assert.ok(fromLayer, "text layer did not emit eq (5)");
  assert.ok(formula, "adapter dropped eq (5)");
  assert.equal(Object.hasOwn(formula, "text"), false);
  assert.equal(translatableBlocks([formula]).length, 0);
  assert.equal(formula.sourceText, fromLayer.sourceText);
  const unit = formulaUnitFromBlock(formula, { docHash: "dpo", page: number });
  assert.match(unit.pdfText, /r\(x, y\) = βlog/);
  assert.match(unit.pdfText, /\(5\)/);
  const shown = await scheduleFormulaBlock(formula, {
    withRasterCrop: async (item) => ({ ...item, imageUrl: "data:image/png;base64,aa", surface: "png" }),
    docHash: "dpo",
    page: number,
    katex
  });
  assert.equal(shown.latexSource, undefined);
  assert.equal(shown.verified, undefined);
  assert.equal(shown.formulaTier, "crop");
});

test("an empty answer or an empty source does not verify", () => {
  const empty = { pdfText: "", display: true, glyphs: [] };
  for (const latex of ["\\quad", "{}", "\\,", "\\qquad", "\\displaystyle"]) {
    const verdict = verifyCandidate(latex, empty, katex);
    assert.equal(verdict.pass, false, latex);
    assert.equal(verdict.reason, "charset-mismatch", latex);
    assert.notEqual(verdict.checks.charset.jaccard, 1, latex);
  }
  const spacingAgainstText = verifyCandidate("\\quad", { pdfText: "x", display: true, glyphs: [] }, katex);
  assert.equal(spacingAgainstText.pass, false);
  assert.equal(spacingAgainstText.reason, "charset-mismatch");
  const missingSource = verifyCandidate("x", empty, katex);
  assert.equal(missingSource.pass, false);
  assert.equal(missingSource.reason, "uncheckable-glyph");
  const phantom = verifyCandidate("\\phantom{x}", empty, katex);
  assert.equal(phantom.pass, false);
  assert.equal(phantom.reason, "unknown-command");
});
