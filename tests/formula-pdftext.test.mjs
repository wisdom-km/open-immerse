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
import { attachFontRealNames } from "../lib/pdf-mirror.js";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";
import { translatableBlocks } from "../lib/pdf-blocks.js";
import { resolveBlockAnchor } from "../lib/pdf-block-id.js";
import { pageTextForStructure } from "../lib/pdf-structure-schema.js";
import { reanchorNote } from "../lib/notes-anchor.js";
import { blocksForNotes } from "../lib/note-page-blocks.js";
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

// Offline samples of the correct formulas. Eq(7) is the DeepSeek loss from
// review 10 (four \\mid, square brackets). The period is part of eq(1) and eq(5).
const CORRECT = {
  "(1)": String.raw`p^{*}(y_{1}\succ y_{2}\mid x)=\frac{\exp(r^{*}(x,y_{1}))}{\exp(r^{*}(x,y_{1}))+\exp(r^{*}(x,y_{2}))}.`,
  "(5)": String.raw`r(x,y)=\beta\log\frac{\pi_{r}(y\mid x)}{\pi_{\mathrm{ref}}(y\mid x)}+\beta\log Z(x).`,
  "(7)": String.raw`\mathcal{L}_{\mathrm{DPO}}(\pi_{\theta};\pi_{\mathrm{ref}})=-\mathbb{E}_{(x,y_{w},y_{l})\sim\mathcal{D}}\left[\log\sigma\left(\beta\log\frac{\pi_{\theta}(y_{w}\mid x)}{\pi_{\mathrm{ref}}(y_{w}\mid x)}-\beta\log\frac{\pi_{\theta}(y_{l}\mid x)}{\pi_{\mathrm{ref}}(y_{l}\mid x)}\right)\right]`
};

const JUNK = [
  "\\quad", "{}", "\\,", "\\qquad", "\\displaystyle", "\\hspace{1em}",
  "\\text{}", "~", "\\;", "\\!", "\\mathrm{}", "\\left.\\right.", "\\hfill", " ", "x"
];

let dpoUnitsPromise;
function dpoFormulaUnits() {
  if (!dpoUnitsPromise) dpoUnitsPromise = loadDpoFormulaUnits();
  return dpoUnitsPromise;
}

async function loadDpoFormulaUnits() {
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(dpoPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const units = [];
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      attachFontRealNames(content.items, pdfPage.commonObjs);
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const built = textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      });
      for (const block of built.blocks) {
        if (block.label !== "formula") continue;
        units.push(formulaUnitFromBlock(block, { docHash: "dpo", page: number }));
      }
    }
  } finally {
    await doc.destroy();
  }
  return units;
}

test("DPO eq(1), eq(5), and eq(7) verify from the real text layer", async () => {
  const units = await dpoFormulaUnits();
  const picked = {};
  for (const unit of units) {
    if (CORRECT[unit.equationNumber] && !picked[unit.equationNumber]) picked[unit.equationNumber] = unit;
  }
  for (const label of ["(1)", "(5)", "(7)"]) {
    const unit = picked[label];
    assert.ok(unit, `missing ${label}`);
    assert.equal(unit.pdfText.length > 0, true, label);
    const verdict = verifyCandidate(CORRECT[label], unit, katex);
    assert.equal(verdict.pass, true, `${label} j=${verdict.checks.charset.jaccard} ${verdict.reason || ""}`);
    assert.ok(verdict.checks.charset.jaccard >= 0.9, `${label} j=${verdict.checks.charset.jaccard}`);
  }
});

test("junk answers pass none of the real DPO formula units", async () => {
  const units = await dpoFormulaUnits();
  assert.ok(units.length >= 100, units.length);
  let passed = 0;
  for (const unit of units) {
    for (const latex of JUNK) {
      if (verifyCandidate(latex, unit, katex).pass) passed += 1;
    }
  }
  assert.equal(passed, 0);
});

test("a vendor formula box keeps the text block it replaces", () => {
  const viewport = {
    width: 612,
    height: 792,
    convertToViewportRectangle(rect) {
      const [x1, y1, x2, y2] = rect;
      return [x1, 792 - y2, x2, 792 - y1];
    }
  };
  const items = [
    { str: "Attention", x: 120, y: 430, width: 70, height: 12 },
    { str: "(Q, K, V)", x: 192, y: 430, width: 70, height: 12 }
  ];
  const page = vendorLayoutToBlocks({
    page: 1,
    layoutDetails: [{ label: "formula", bbox_2d: [0.15, 0.42, 0.55, 0.50], content: "ignored" }]
  }, { viewport, page: 1, items });
  const formula = page.blocks.find((block) => block.label === "formula");
  assert.ok(formula);
  assert.equal(formula.sourceText, "Attention(Q, K, V)");
  assert.equal(Object.hasOwn(formula, "text"), false);
  assert.equal(page.blocks.some((block) => block.label === "text" && /Attention/.test(block.text || "")), false);
});

test("formula sourceText stays out of structure text and note readiness", () => {
  const text = pageTextForStructure([
    { label: "title", text: "Direct Preference Optimization" },
    { label: "formula", sourceText: "256 × 256" }
  ]);
  assert.match(text, /Direct Preference Optimization/);
  assert.equal(text.includes("256"), false);
  const note = {
    id: "n1",
    page: 4,
    anchor: { bid: "b1-p4-tmissing", page: 4, quote: "hello" },
    anchorState: { status: "quote", layoutRev: "old" }
  };
  const live = [{ label: "formula", bid: "b1-p4-m0000001", sourceText: "r(x, y) = beta", bbox: [0, 0, 1, 1] }];
  const pages = [{ page: 4, blocks: blocksForNotes(live) }];
  assert.equal(live[0].sourceText, "r(x, y) = beta");
  assert.equal(pages[0].blocks[0].sourceText, undefined);
  const out = reanchorNote(note, pages, { layoutRev: "new", checkedAt: 1 });
  assert.equal(out.pendingLayout, undefined);
  assert.equal(out.note.anchorState.status, "lost");
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.match(viewer, /blocksForNotes\(applyBlockTranslations\(/);
  const anchor = resolveBlockAnchor(
    { srcHead: "rxybeta", page: 4 },
    [{ page: 4, blocks: live }]
  );
  assert.equal(anchor.status, "lost");
});
