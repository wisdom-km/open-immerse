// F5 tier-0 invariants. Local fixtures only. arxiv.org is blocked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideFormula } from "../lib/formula-chain.js";
import { TIER_ORDER } from "../lib/formula-contract.js";
import { parseLatexSource, prepareFormulaLatex, stripLatexColor } from "../lib/latex-units.js";
import { canRenderLatex, KATEX_RENDER_OPTIONS, MAX_FORMULA_LATEX_CHARS } from "../lib/formula-katex.js";
import { formulaArxivSourceEnabled } from "../lib/formula-flags.js";
import { scheduleFormulaBlock } from "../lib/formula-schedule.js";
import { formulaChainFlags } from "../lib/formula-settings.js";
import { copyLatexText } from "../lib/formula-arxiv-pane.js";
import {
  alignmentReusable,
  canonicalArxivVersion,
  equationLabelDigits,
  equationNumbersAgree,
  resolveArxivSession
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
  const ctx = {
    katex,
    flags: { arxivEnabled: extra.arxivEnabled !== false },
    arxivId: "1706.03762",
    arxivVersion: alignment.version || "",
    readAlignment: async () => alignment
  };
  if (extra.omitPdfVersion !== true) ctx.pdfVersion = pdfVersion;
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
  }, ctx);
}

test("version strings are cache keys and the tier order stays put", () => {
  assert.equal(canonicalArxivVersion("V7"), "v7");
  assert.equal(canonicalArxivVersion("7"), "v7");
  assert.equal(canonicalArxivVersion(""), "");
  assert.equal(equationNumbersAgree({ number: "1" }, { equationNumber: "(1)" }), true);
  assert.equal(equationNumbersAgree({ number: "1" }, { equationNumber: "(2)" }), false);
  assert.equal(equationNumbersAgree({ number: "" }, { equationNumber: "" }), true);
  assert.deepEqual(TIER_ORDER, ["arxiv", "multimodal", "ocr", "self", "vector", "crop", "placeholder"]);
  assert.equal(formulaArxivSourceEnabled(), false);
  const flagsSrc = readFileSync(join(root, "lib/formula-flags.js"), "utf8");
  assert.match(flagsSrc, /let arxivSourceEnabled = false/);
});

test("a missing version downloads the latest source and a different package is checked formula by formula", async () => {
  const displays = alignedV7.formulas.filter((row) => row.kind === "display" && row.pass === true);
  assert.equal(displays.length, 5);
  const sample = displays[0];
  const otherStamp = await screen(alignedV7, sample, "v1");
  assert.equal(otherStamp.chosen.tier, "arxiv");
  assert.notEqual(otherStamp.trace[0].reason, "version-mismatch");
  const missingPdf = await screen(alignedV7, sample, "");
  assert.equal(missingPdf.chosen.tier, "arxiv");
  assert.notEqual(missingPdf.trace[0].reason, "version-uncertain");

  let requested = null;
  const latest = await resolveArxivSession({
    id: "1706.03762",
    pdfVersion: "",
    pdfSha256: ATTENTION_PDF_SHA,
    readAlignment: async () => null,
    download: async (query) => {
      requested = query;
      return { ok: true, version: "v7", files: packedV7.files };
    },
    prepare: async ({ version }) => ({ ok: true, alignment: { ...alignedV7, version } })
  });
  assert.equal(latest.ok, true);
  assert.equal(latest.downloaded, true);
  assert.equal(latest.parsed, true);
  assert.equal(requested.version, "");
  assert.notEqual(latest.reason, "version-uncertain");

  const echoed = await resolveArxivSession({
    id: "1706.03762",
    pdfVersion: "v7",
    pdfSha256: ATTENTION_PDF_SHA,
    readAlignment: async () => null,
    download: async () => ({ ok: true, version: "v1", files: packedV7.files }),
    prepare: async () => ({ ok: true, alignment: { ...alignedV1, version: "v1" } })
  });
  assert.equal(echoed.ok, true);
  assert.equal(echoed.parsed, true);
  assert.equal(echoed.alignment.version, "v1");
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
  const rejected = await screen(shifted, shiftedRow, undefined, { omitPdfVersion: true });
  assert.equal(rejected.trace[0].reason, "number-mismatch");
  assert.notEqual(rejected.chosen.tier, "arxiv");
  const rejectedWithStamp = await screen(shifted, shiftedRow, "v7");
  assert.equal(rejectedWithStamp.trace[0].reason, "number-mismatch");
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
    download: async (query) => {
      downloads += 1;
      assert.equal(query.version, "v7");
      return { ok: true, version: query.version, files: packedV7.files };
    },
    prepare: async () => {
      parses += 1;
      return { ok: true, alignment: alignedV7 };
    }
  });
  assert.equal(drifted.ok, true);
  assert.equal(drifted.reused, false);
  assert.equal(drifted.parsed, true);
  assert.equal(downloads, 2);
  assert.equal(parses, 2);
  const latestAlignment = { ...alignedV7, version: "" };
  store.set(`1706.03762@:${ATTENTION_PDF_SHA}`, latestAlignment);
  const unknown = await resolveArxivSession({
    id: "1706.03762",
    pdfVersion: "",
    pdfSha256: ATTENTION_PDF_SHA,
    readAlignment,
    download: async () => {
      downloads += 1;
      return { ok: true, version: "", files: packedV7.files };
    },
    prepare: async () => {
      parses += 1;
      return { ok: true, alignment: latestAlignment };
    }
  });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.reused, true);
  assert.equal(unknown.downloaded, false);
  assert.equal(unknown.parsed, false);
  assert.equal(downloads, 2);
  assert.equal(parses, 2);
  const forced = await resolveArxivSession({
    id: "1706.03762",
    pdfVersion: "",
    pdfSha256: ATTENTION_PDF_SHA,
    download: async (query) => {
      downloads += 1;
      assert.equal(query.version, "");
      return { ok: true, files: packedV7.files };
    },
    prepare: async () => {
      parses += 1;
      return { ok: true, alignment: latestAlignment };
    }
  });
  assert.equal(forced.downloaded, true);
  assert.equal(downloads, 3);
  assert.equal(parses, 3);
});

test("clicking a source formula and a placeholder call the same jump", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.match(viewer, /function jumpFormulaFromUi\(button\)/);
  assert.match(viewer, /onJump: jumpFormulaFromUi/);
  const placeholder = viewer.slice(viewer.indexOf("function mountFormulaPlaceholder"));
  assert.match(placeholder.slice(0, 1800), /jumpFormulaFromUi\(button\)/);
  assert.equal(viewer.includes("innerHTML"), false);
});

test("viewer keeps the tier-0 wiring that the screen depends on", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const start = viewer.slice(
    viewer.indexOf("async function startArxivSource"),
    viewer.indexOf("async function ensureMissingLayouts")
  );
  assert.match(start, /pdfVersion:\s*found\.version\s*\|\|\s*""/);
  assert.match(start, /version:\s*found\.version\s*\|\|\s*""/);
  assert.match(start, /readAlignment:\s*\(query\)\s*=>\s*readCachedArxivAlignment\(query\)/);
  assert.match(start, /if\s*\(\s*!resolved\.reused\s*\)\s*\{[\s\S]*?action:\s*"save-alignment"/);
  const flagAt = start.indexOf("setFormulaArxivSourceEnabled(true)");
  const first = start.indexOf("rememberArxivAlignment(resolved.alignment)");
  const second = start.indexOf("rememberArxivAlignment(resolved.alignment)", first + 1);
  assert.equal((start.match(/rememberArxivAlignment\(resolved\.alignment\)/g) || []).length, 2);
  assert.ok(first >= 0 && first < flagAt && flagAt < second);
  assert.doesNotMatch(start.slice(0, start.indexOf("resolveArxivSession")), /!found\.version|version-uncertain/);
  assert.match(viewer, /arxivVersion:\s*arxiv\?\.version\s*\|\|\s*""/);
  assert.match(viewer, /arxivVersion:\s*arxivIdentity\?\.version\s*\|\|\s*""/);
  const offer = viewer.slice(viewer.indexOf("function syncArxivOffer"), viewer.indexOf("function bindArxivChip"));
  assert.doesNotMatch(offer, /!found\.version|version-uncertain/);
});

test("overlong latex falls back and a repeated check does not render twice", async () => {
  const host = alignedV7.formulas.find((row) => row.kind === "display" && row.pass === true);
  const latex = "x".repeat(MAX_FORMULA_LATEX_CHARS + 1);
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
  assert.equal(decision.trace[0].reason, "latex-too-long");
  assert.notEqual(decision.chosen.tier, "arxiv");
  assert.equal(decision.chosen.render, "image");
  const shown = await scheduleFormulaBlock({
    label: "formula",
    id: host.slotId || host.unitId,
    sourceUnitId: host.unitId,
    display: true,
    eqLabel: blockFor(host)?.eqLabel || "(1)",
    bbox: [0.1, 0.2, 0.4, 0.25],
    text: "x"
  }, {
    arxivEnabled: true,
    pdfVersion: "v7",
    katex,
    docHash: ATTENTION_PDF_SHA,
    readAlignment: async () => alignment,
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG, surface: "png" })
  });
  assert.equal(shown.formulaReason, "latex-too-long");
  assert.equal(shown.imageUrl, PNG);
  assert.equal(shown.latex, undefined);
  let renders = 0;
  const spy = {
    renderToString(src, options) {
      renders += 1;
      return katex.renderToString(src, options);
    }
  };
  const once = "y+z+1";
  assert.equal(canRenderLatex(once, false, spy).pass, true);
  assert.equal(canRenderLatex(once, false, spy).pass, true);
  assert.equal(renders, 1);
  assert.equal(stripLatexColor("\\color{red}{E=mc^2}"), "{E=mc^2}");
  assert.equal(stripLatexColor("\\color[rgb]{1,0,0}x"), "x");
  assert.match(copyLatexText("\\color{red}{E=mc^2}"), /\\color/);
  const colored = {
    ...alignedV7,
    formulas: [{
      ...host,
      latex: "\\color{red}{E=mc^2}",
      checks: { position: true, chars: true, number: true, render: true },
      pass: true
    }]
  };
  const painted = await screen(colored, colored.formulas[0], "v7");
  assert.equal(painted.chosen.tier, "arxiv");
  assert.equal(painted.trace[0].status, "ok");
});

test("color commands keep their text and alignment refuses an overlong formula", () => {
  const cases = [
    ["\\color{red}{E=mc^2}", "{E=mc^2}", "E=mc2"],
    ["\\textcolor{red}{x}", "x", "x"],
    ["\\colorbox{yellow}{x}", "x", "x"],
    ["\\fcolorbox{blue}{yellow}{x}", "x", "x"],
    ["\\textcolor{red}{a{b}c}", "a{b}c", "abc"],
    ["\\textcolor[rgb]{1,0,0}{\\colorbox{yellow}{q}}", "q", "q"]
  ];
  for (const [src, stripped, visible] of cases) {
    const shown = stripLatexColor(prepareFormulaLatex(src, false));
    assert.equal(shown, stripped, src);
    assert.equal(copyLatexText(src), prepareFormulaLatex(src, false), src);
    assert.match(copyLatexText(src), /\\(?:color|textcolor|colorbox|fcolorbox)/, src);
    const html = katex.renderToString(shown, { ...KATEX_RENDER_OPTIONS, displayMode: false });
    assert.equal(/background(?:-color)?\s*:/i.test(html), false, src);
    assert.equal(/border(?:-color|-width|-style)?\s*:/i.test(html), false, src);
    assert.equal(/(?:^|[^-\w])color\s*:/i.test(html), false, src);
    assert.equal(html.includes("boxed"), false, src);
    assert.equal(html.replace(/<[^>]+>/g, ""), visible, src);
  }
  assert.equal(stripLatexColor("\\textcolor{red} hello"), "\\textcolor{red} hello");
  assert.equal(stripLatexColor("\\textcolor"), "\\textcolor");
  assert.equal(stripLatexColor("\\fcolorbox{a}{b"), "\\fcolorbox{a}{b");
  assert.equal(stripLatexColor("\\colorbox{y}{a{b}"), "\\colorbox{y}{a{b}");
  const huge = "z".repeat(MAX_FORMULA_LATEX_CHARS + 1);
  let calls = 0;
  const spy = {
    renderToString(src, options) {
      calls += 1;
      return katex.renderToString(src, options);
    }
  };
  const parsed = parseLatexSource([{
    path: "m.tex",
    text: `\\documentclass{article}\\begin{document}$${huge}$\\end{document}`
  }], { katex: spy });
  const inlines = (parsed.units || []).flatMap((unit) => (unit.parts || []).filter((part) => part.type === "inline"));
  assert.equal(inlines.length, 1);
  assert.equal(inlines[0].katexOk, false);
  assert.equal(calls, 0);
  const fitted = parseLatexSource([{
    path: "m.tex",
    text: "\\documentclass{article}\\begin{document}$x$\\end{document}"
  }], { katex: spy });
  const short = (fitted.units || []).flatMap((unit) => (unit.parts || []).filter((part) => part.type === "inline"));
  assert.equal(short[0].katexOk, true);
  assert.equal(calls, 1);
});

test("these invariants did not fetch arxiv.org", () => {
  assert.equal(arxivFetches, 0);
});
