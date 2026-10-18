// F5 tier-0 invariants. Local fixtures only. arxiv.org is blocked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideFormula } from "../lib/formula-chain.js";
import { TIER_ORDER } from "../lib/formula-contract.js";
import { prepareFormulaLatex } from "../lib/latex-units.js";
import { scheduleFormulaBlock } from "../lib/formula-schedule.js";
import { formulaChainFlags } from "../lib/formula-settings.js";
import { copyLatexText } from "../lib/formula-arxiv-pane.js";
import {
  alignmentReusable,
  canonicalArxivVersion,
  equationLabelDigits,
  equationNumbersAgree,
  resolveArxivSession,
  versionScreenGate
} from "../lib/formula-arxiv-gate.js";
import { alignSourceToBlocks } from "../lib/source-align.js";
import {
  ATTENTION_PDF_SHA,
  SRC_V1,
  SRC_V1_SHA,
  SRC_V7,
  SRC_V7_SHA,
  loadAttentionPages,
  loadKatex,
  loadSource,
  parsePacked
} from "./helpers/arxiv-paper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const katex = loadKatex();

let arxivFetches = 0;
const previousFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input && input.url || input || "");
  if (/arxiv\.org/i.test(url)) {
    arxivFetches += 1;
    const error = new Error(`blocked ${url}`);
    error.code = "live-fetch-blocked";
    throw error;
  }
  if (typeof previousFetch === "function") return previousFetch(input, init);
  const error = new Error(`unexpected fetch ${url}`);
  error.code = "unexpected-fetch";
  throw error;
};

const paper = await loadAttentionPages();
const packedV7 = await loadSource(SRC_V7, SRC_V7_SHA, "把 1706.03762v7.tar.gz 放到 tests/fixtures/arxiv-src/。");
const packedV1 = await loadSource(SRC_V1, SRC_V1_SHA, "把 1706.03762v1.tar.gz 放到 tests/fixtures/arxiv-src/。");
const parsedV7 = await parsePacked(packedV7, katex);
const alignedV7 = alignSourceToBlocks({ units: parsedV7.units, pages: paper.pages });
alignedV7.version = "v7";
alignedV7.id = "1706.03762";
alignedV7.pdfSha256 = ATTENTION_PDF_SHA;
const parsedV1 = await parsePacked(packedV1, katex);
const alignedV1 = alignSourceToBlocks({ units: parsedV1.units, pages: paper.pages });
alignedV1.version = "v1";
alignedV1.id = "1706.03762";
alignedV1.pdfSha256 = ATTENTION_PDF_SHA;

function blockFor(row) {
  const id = String(row?.slotId || row?.bid || "");
  if (!id) return null;
  for (const page of paper.pages) {
    const found = (page.blocks || []).find((block) => String(block.id) === id);
    if (found) return found;
  }
  return null;
}

function unitFor(row) {
  return parsedV7.units.find((unit) => unit.id === row.unitId) || null;
}

async function screen(alignment, row, pdfVersion, extra = {}) {
  const block = blockFor(row);
  return decideFormula({
    docHash: ATTENTION_PDF_SHA,
    bid: row.bid || row.unitId,
    sourceUnitId: row.unitId,
    page: row.page || block?.page || 1,
    bbox: block?.bbox || [0, 0, 0.2, 0.05],
    display: row.kind === "display",
    pdfText: block?.text || "",
    equationNumber: block?.eqLabel || "",
    crop: { url: PNG }
  }, {
    katex,
    flags: { arxivEnabled: extra.arxivEnabled !== false },
    arxivId: "1706.03762",
    arxivVersion: alignment.version || "",
    pdfVersion,
    readAlignment: async () => alignment
  });
}

test("version numbers agree only when both sides name the same version", () => {
  assert.equal(canonicalArxivVersion("V7"), "v7");
  assert.equal(canonicalArxivVersion("7"), "v7");
  assert.equal(canonicalArxivVersion(""), "");
  assert.deepEqual(versionScreenGate("v7", "v7"), { screen: true, reason: null });
  assert.equal(versionScreenGate("v7", "v1").reason, "version-mismatch");
  assert.equal(versionScreenGate("v7", "").reason, "version-uncertain");
  assert.equal(versionScreenGate("", "v7").reason, "version-uncertain");
  assert.equal(equationNumbersAgree({ number: "1" }, { equationNumber: "(1)" }), true);
  assert.equal(equationNumbersAgree({ number: "1" }, { equationNumber: "(2)" }), false);
  assert.equal(equationNumbersAgree({ number: "" }, { equationNumber: "" }), true);
  assert.deepEqual(TIER_ORDER, ["arxiv", "multimodal", "ocr", "self", "vector", "crop", "placeholder"]);
});

test("a version mismatch or an uncertain version does not screen and falls back to the crop", async () => {
  const displays = alignedV7.formulas.filter((row) => row.kind === "display" && row.pass === true);
  assert.equal(displays.length, 5);
  const sample = displays[0];
  const mismatched = await screen(alignedV1, sample, "v7");
  assert.equal(mismatched.trace[0].tier, "arxiv");
  assert.equal(mismatched.trace[0].reason, "version-mismatch");
  assert.notEqual(mismatched.chosen.tier, "arxiv");
  assert.equal(mismatched.trace.map((item) => item.tier).includes("crop"), true);

  const uncertain = await screen({ ...alignedV7, version: "" }, sample, "v7");
  assert.equal(uncertain.trace[0].reason, "version-uncertain");
  assert.notEqual(uncertain.chosen.tier, "arxiv");

  const missingPdf = await screen(alignedV7, sample, "");
  assert.equal(missingPdf.trace[0].reason, "version-uncertain");
  assert.notEqual(missingPdf.chosen.tier, "arxiv");

  const shown = await scheduleFormulaBlock({
    label: "formula",
    id: sample.slotId || sample.bid,
    bid: sample.bid,
    sourceUnitId: sample.unitId,
    display: true,
    eqLabel: blockFor(sample)?.eqLabel || `(${sample.number})`,
    bbox: [0.1, 0.2, 0.4, 0.25],
    text: "x"
  }, {
    arxivEnabled: true,
    arxivId: "1706.03762",
    arxivVersion: "v1",
    pdfVersion: "v7",
    katex,
    docHash: ATTENTION_PDF_SHA,
    readAlignment: async () => alignedV1,
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG, surface: "png" })
  });
  assert.notEqual(shown.formulaTier, "arxiv");
  assert.equal(shown.verified, undefined);
  assert.equal(shown.latex, undefined);
  assert.equal(shown.imageUrl, PNG);
});

test("Attention v7 equation numbers stay on their PDF labels and a shifted number stays off", async () => {
  const displays = alignedV7.formulas.filter((row) => row.kind === "display" && row.pass === true);
  assert.equal(displays.length, 5);
  for (const row of displays) {
    const block = blockFor(row);
    assert.ok(block, row.unitId);
    assert.equal(equationLabelDigits(block.eqLabel), equationLabelDigits(row.number), row.unitId);
    const decision = await screen(alignedV7, row, "v7");
    assert.equal(decision.chosen.tier, "arxiv", row.unitId);
    assert.equal(decision.chosen.latex, row.latex);
    const unit = unitFor(row);
    assert.ok(unit);
    assert.equal(copyLatexText(decision.chosen.latex), prepareFormulaLatex(unit.latex, false));
    assert.equal(copyLatexText(decision.chosen.latex).includes("$$"), false);
    assert.equal(/\\tag|\\label/.test(copyLatexText(decision.chosen.latex)), false);
  }
  const shiftedRow = { ...displays[0], number: "99", checks: { ...displays[0].checks, number: true } };
  const shifted = {
    ...alignedV7,
    formulas: alignedV7.formulas.map((row) => (row.unitId === shiftedRow.unitId ? shiftedRow : row))
  };
  const rejected = await screen(shifted, shiftedRow, "v7");
  assert.equal(rejected.trace[0].reason, "number-mismatch");
  assert.notEqual(rejected.chosen.tier, "arxiv");
});

test("untrusted KaTeX commands are not painted and the crop stays on the block", async () => {
  const attacks = [
    "\\href{https://evil.test}{y}",
    "\\url{https://evil.test}",
    "\\htmlClass{a}{x}",
    "\\htmlId{a}{x}",
    "\\htmlStyle{color:red}{x}",
    "\\htmlData{a=b}{x}"
  ];
  const host = alignedV7.formulas.find((row) => row.kind === "display" && row.pass === true);
  for (const latex of attacks) {
    const alignment = {
      ...alignedV7,
      formulas: [{
        ...host,
        latex,
        checks: { position: true, chars: true, number: true, render: true },
        pass: true
      }]
    };
    const decision = await screen(alignment, alignment.formulas[0], "v7");
    assert.equal(decision.trace[0].reason, "katex-error", latex);
    assert.notEqual(decision.chosen.tier, "arxiv", latex);
    assert.equal(decision.chosen.render, "image");
    const shown = await scheduleFormulaBlock({
      label: "formula",
      id: host.slotId || host.unitId,
      sourceUnitId: host.unitId,
      display: true,
      eqLabel: blockFor(host)?.eqLabel || "(1)",
      bbox: [0.1, 0.2, 0.4, 0.25],
      text: "y"
    }, {
      arxivEnabled: true,
      pdfVersion: "v7",
      katex,
      docHash: ATTENTION_PDF_SHA,
      readAlignment: async () => alignment,
      withRasterCrop: async (item) => ({ ...item, imageUrl: PNG, surface: "png" })
    });
    assert.notEqual(shown.formulaTier, "arxiv", latex);
    assert.equal(shown.imageUrl, PNG);
    assert.equal(shown.formulaReason, "katex-error", latex);
    assert.equal(shown.latexSource, undefined);
  }
});

test("the tier-0 flag stays off with the F3 switches, and those switches do not erase a screened formula", async () => {
  const flags = formulaChainFlags({}, {});
  assert.equal(flags.arxivEnabled, false);
  assert.equal(flags.multimodalEnabled, false);
  assert.equal(flags.ocrEnabled, false);
  assert.equal(flags.placeholderEnabled, false);
  const row = alignedV7.formulas.find((item) => item.kind === "display" && item.pass === true);
  const off = await screen(alignedV7, row, "v7", { arxivEnabled: false });
  assert.equal(off.trace[0].tier, "arxiv");
  assert.equal(off.trace[0].status, "skip");
  assert.notEqual(off.chosen.tier, "arxiv");
  const block = {
    label: "formula",
    id: row.slotId || row.unitId,
    sourceUnitId: row.unitId,
    display: true,
    eqLabel: blockFor(row)?.eqLabel || "(1)",
    bbox: [0.1, 0.2, 0.4, 0.25],
    text: "x"
  };
  const hidden = await scheduleFormulaBlock(block, {
    arxivEnabled: false,
    pdfVersion: "v7",
    katex,
    docHash: ATTENTION_PDF_SHA,
    readAlignment: async () => alignedV7,
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG, surface: "png" })
  });
  assert.notEqual(hidden.formulaTier, "arxiv");
  assert.equal(hidden.imageUrl, PNG);
  const kept = await scheduleFormulaBlock(block, {
    arxivEnabled: true,
    multimodalEnabled: false,
    ocrEnabled: false,
    placeholderEnabled: false,
    pdfVersion: "v7",
    katex,
    docHash: ATTENTION_PDF_SHA,
    readAlignment: async () => alignedV7,
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG, surface: "png" })
  });
  assert.equal(kept.formulaTier, "arxiv");
  assert.equal(kept.latexSource, "arxiv-src");
  assert.equal(kept.verified, true);
  assert.equal(kept.imageUrl, PNG);
  assert.equal(copyLatexText(kept.latex), prepareFormulaLatex(unitFor(row).latex, false));
});

test("reopening a screened paper does not download or parse again", async () => {
  const store = new Map();
  let downloads = 0;
  let parses = 0;
  const download = async () => {
    downloads += 1;
    return { ok: true, version: "v7", files: packedV7.files };
  };
  const prepare = async () => {
    parses += 1;
    return { ok: true, alignment: alignedV7 };
  };
  const readAlignment = async ({ id, version, pdfSha256 }) => store.get(`${id}@${version}:${pdfSha256}`) || null;
  const first = await resolveArxivSession({
    id: "1706.03762",
    pdfVersion: "v7",
    pdfSha256: ATTENTION_PDF_SHA,
    readAlignment,
    download,
    prepare
  });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(downloads, 1);
  assert.equal(parses, 1);
  store.set(`1706.03762@v7:${ATTENTION_PDF_SHA}`, first.alignment);
  const second = await resolveArxivSession({
    id: "1706.03762",
    pdfVersion: "V7",
    pdfSha256: ATTENTION_PDF_SHA,
    readAlignment,
    download,
    prepare
  });
  assert.equal(second.reused, true);
  assert.equal(downloads, 1);
  assert.equal(parses, 1);
  assert.equal(alignmentReusable(second.alignment, {
    id: "1706.03762",
    pdfVersion: "7",
    pdfSha256: ATTENTION_PDF_SHA
  }), true);
  const drifted = await resolveArxivSession({
    id: "1706.03762",
    pdfVersion: "v7",
    pdfSha256: ATTENTION_PDF_SHA,
    readAlignment: async () => ({ ...alignedV1, version: "v1" }),
    download: async () => {
      downloads += 1;
      return { ok: true, version: "v1", files: [] };
    },
    prepare: async () => {
      parses += 1;
      return { ok: true, alignment: alignedV1 };
    }
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.reason, "version-mismatch");
  assert.equal(drifted.parsed, false);
  const unknown = await resolveArxivSession({
    id: "1706.03762",
    pdfVersion: "",
    pdfSha256: ATTENTION_PDF_SHA,
    readAlignment,
    download: async () => {
      downloads += 1;
      return { ok: true, version: "v7", files: [] };
    },
    prepare
  });
  assert.equal(unknown.reason, "version-uncertain");
  assert.equal(unknown.downloaded, false);
  assert.equal(unknown.parsed, false);
  assert.equal(downloads, 2);
  assert.equal(parses, 1);
});

test("clicking a source formula and a placeholder call the same jump", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.match(viewer, /function jumpFormulaFromUi\(button\)/);
  assert.match(viewer, /onJump: jumpFormulaFromUi/);
  const placeholder = viewer.slice(viewer.indexOf("function mountFormulaPlaceholder"));
  assert.match(placeholder.slice(0, 1800), /jumpFormulaFromUi\(button\)/);
  assert.equal(viewer.includes("innerHTML"), false);
});

test("these invariants did not fetch arxiv.org", () => {
  assert.equal(arxivFetches, 0);
});
