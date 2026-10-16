import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { scheduleFormulaBlock } from "../lib/formula-schedule.js";
import {
  arxivFailSentence,
  chipModel,
  inlineSplicePlans,
  keptSourceId,
  normalizeArxivPrefs,
  prepareArxivAlignment,
  shownCounts,
  slotAssignments,
  sourceTotals,
  spliceInlinePieces,
  verifiedArxivFormula
} from "../lib/formula-arxiv-session.js";
import { copyLatexText, failedInlineKind, katexClickKept, mountArxivDisplay, plainWithInlineMath } from "../lib/formula-arxiv-pane.js";
import { loadAttentionPages, loadKatex, loadSource, SRC_V7, SRC_V7_SHA } from "./helpers/arxiv-paper.mjs";

function loadIsolated(file, stubs) {
  let source = readFileSync(fileURLToPath(file), "utf8");
  source = source.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_, names, spec) => {
    return `const { ${names.trim()} } = __stubs[${JSON.stringify(spec)}];`;
  });
  source = source.replace(/export\s+async\s+function\s+([A-Za-z0-9_]+)/g, "__exports.$1 = async function $1");
  source = source.replace(/export\s+function\s+([A-Za-z0-9_]+)/g, "__exports.$1 = function $1");
  source = source.replace(/export\s+const\s+([A-Za-z0-9_]+)\s*=/g, "__exports.$1 =");
  const context = vm.createContext(Object.create(null));
  const exported = Object.create(null);
  const run = vm.compileFunction(source, ["__exports", "__stubs"], { parsingContext: context });
  run.call(context, exported, stubs);
  assert.equal("process" in context, false);
  assert.equal("Buffer" in context, false);
  assert.equal("require" in context, false);
  return exported;
}

test("new arxiv modules evaluate with no process, Buffer, or require", () => {
  const session = loadIsolated(new URL("../lib/formula-arxiv-session.js", import.meta.url), {
    "./latex-units.js": {
      parseLatexSource() {
        return { supported: false, unsupported: [{ reason: "plain-tex" }] };
      }
    },
    "./source-align.js": {
      alignSourceToBlocks() {
        throw new Error("align should stay stubbed");
      }
    }
  });
  assert.equal(session.arxivFailSentence("offline"), "未用 arXiv 源码：离线");
  const prepared = session.prepareArxivAlignment({ files: [] });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.reason, "plain-tex");
});

test("pane helpers evaluate with no process and keep click slop", () => {
  const pane = loadIsolated(new URL("../lib/formula-arxiv-pane.js", import.meta.url), {
    "./formula-katex.js": {
      canRenderLatex() { return { pass: true, error: null }; },
      renderLatexInto(node, latex) { node.rendered = latex; }
    },
    "./formula-settings.js": {
      placeholderCopy() { return { aria: "公式 · 点击查看原公式", visible: [] }; }
    },
    "./pdf-pairing.js": { PAIR_CLICK_SLOP: 4 },
    "./formula-arxiv-session.js": {
      verifiedArxivFormula(block) {
        return block?.verified === true && block?.latexSource === "arxiv-src" && Boolean(block?.latex);
      }
    }
  });
  assert.equal(pane.copyLatexText("E=mc^2"), "E=mc^2");
  assert.equal(pane.copyLatexText("E=mc^2").includes("$$"), false);
  assert.equal(pane.katexClickKept(3, 0), true);
  assert.equal(pane.katexClickKept(4, 0), true);
  assert.equal(pane.katexClickKept(5, 0), false);
});

test("chip uses source totals and shortens when the column is narrow", () => {
  const formulas = [
    { kind: "display", zone: "body" },
    { kind: "display", zone: "body" },
    { kind: "inline", zone: "body" },
    { kind: "inline", zone: "body" },
    { kind: "inline", zone: "caption" }
  ];
  assert.deepEqual(sourceTotals(formulas), { display: 2, inline: 2 });
  const ready = chipModel({
    version: "v7",
    formulas,
    shown: { display: 2, inline: 1 },
    narrow: false,
    phase: "ready"
  });
  assert.equal(ready.text, "公式 · arXiv 源码 v7 · 独立 2/2 · 行内 1/2");
  assert.equal(ready.title, ready.text);
  const narrow = chipModel({
    version: "7",
    formulas,
    shown: { display: 2, inline: 1 },
    narrow: true,
    phase: "ready"
  });
  assert.equal(narrow.text, "公式 · 源码 2/2 · 1/2");
  assert.equal(narrow.title, "公式 · arXiv 源码 v7 · 独立 2/2 · 行内 1/2");
  assert.equal(chipModel({ phase: "loading" }).text, "正在取 arXiv 源码…");
  assert.equal(chipModel({ phase: "failed", reason: "cooldown" }).text, "未用 arXiv 源码：请稍后再试");
  assert.equal(chipModel({ phase: "failed", reason: "pdf-only" }).text, "未用 arXiv 源码：此编号无源码");
  assert.equal(chipModel({ phase: "failed", reason: "plain-tex" }).text, "未用 arXiv 源码：无法解析源码");
  assert.equal(chipModel({ phase: "failed", reason: "alignment-below-85" }).text, "未用 arXiv 源码：对齐不足");
  assert.equal(chipModel({ version: "v7", formulas: [], shown: { display: 0, inline: 0 }, phase: "ready" }).text, "公式 · arXiv 源码 v7 · 本文无公式");
  const skipped = chipModel({ phase: "skipped" });
  assert.equal(skipped.title, "公式 · 已不用源码 · 改回");
  assert.equal(skipped.restore, "改回");
  assert.equal(`${skipped.text} ${skipped.restore}`.replace(/\s+/g, " ").trim(), skipped.title);
  assert.equal(arxivFailSentence("http"), "未用 arXiv 源码：离线");
  const prefs = normalizeArxivPrefs({ arxivSourceSkip: ["1706.03762"], arxivSourceOn: ["1706.03762", "1706.03762"] });
  assert.equal(keptSourceId(prefs, "1706.03762"), true);
  assert.deepEqual(normalizeArxivPrefs({ skip: ["1706.03762"], on: [] }).on, []);
});

test("splice keeps a group only when every formula passes and none owns a slot", () => {
  const pass = (extra) => ({ pass: true, latex: "x", kind: "inline", zone: "body", ...extra });
  const formulas = [
    pass({ unitId: "a", place: { blockId: "p", start: 2, end: 5, index: 0 } }),
    pass({ unitId: "b", slotId: "f1", place: { blockId: "p", start: 8, end: 14, index: 0 } }),
    pass({ unitId: "c", place: { blockId: "q", start: 0, end: 3, index: 0 } }),
    { ...pass({ unitId: "d", place: { blockId: "q", start: 0, end: 3, index: 1 } }), pass: false }
  ];
  const plans = inlineSplicePlans(formulas);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].blockId, "p");
  assert.deepEqual(spliceInlinePieces("abXXX rest ⟦f1⟧ tail", plans), [
    { type: "text", text: "ab" },
    { type: "math", latex: "x", unitId: "a", page: null, number: "" },
    { type: "text", text: " rest ⟦f1⟧ tail" }
  ]);
  assert.equal(spliceInlinePieces("⟦f1⟧", [{ blockId: "p", start: 0, end: 5, formulas: [{ latex: "x", unitId: "a" }] }]), null);
  const slots = slotAssignments([
    pass({ unitId: "s", slotId: "f9", kind: "display" }),
    pass({ unitId: "t", slotId: "f9", kind: "display" })
  ]);
  assert.equal(slots.size, 0);
});

test("a formula is not tier 0 unless latex, source, and verified are all present", () => {
  const ok = { formulaTier: "arxiv", latex: "E=mc^2", latexSource: "arxiv-src", verified: true };
  assert.equal(verifiedArxivFormula(ok), true);
  assert.equal(verifiedArxivFormula({ ...ok, verified: false }), false);
  assert.equal(verifiedArxivFormula({ ...ok, latexSource: "ocr" }), false);
  assert.equal(verifiedArxivFormula({ ...ok, latex: "" }), false);
  assert.equal(verifiedArxivFormula({ ...ok, formulaTier: "crop" }), false);
});

test("schedule stamps tier 0 and leaves the crop image in place", async () => {
  const block = {
    label: "formula",
    id: "p4-b5",
    bid: "hashed",
    sourceUnitId: "u1",
    display: true,
    eqLabel: "(1)",
    bbox: [0.1, 0.2, 0.5, 0.3],
    text: "x"
  };
  const alignment = {
    useSource: true,
    stats: { wordRate: 0.97 },
    formulas: [{
      unitId: "u1",
      kind: "display",
      zone: "body",
      latex: "E=mc^2",
      number: "1",
      bid: "p4-b5",
      pass: true,
      checks: { position: true, chars: true, number: true, render: true }
    }]
  };
  const shown = await scheduleFormulaBlock(block, {
    arxivEnabled: true,
    arxivId: "1706.03762",
    readAlignment: async () => alignment,
    withRasterCrop: async (item) => ({ ...item, imageUrl: "data:image/png;base64,abc", surface: "png" })
  });
  assert.equal(shown.formulaTier, "arxiv");
  assert.equal(shown.latex, "E=mc^2");
  assert.equal(shown.latexSource, "arxiv-src");
  assert.equal(shown.verified, true);
  assert.equal(shown.imageUrl, "data:image/png;base64,abc");
  assert.equal(block.latex, undefined);

  const missed = await scheduleFormulaBlock({ ...block, sourceUnitId: "" }, {
    arxivEnabled: true,
    readAlignment: async () => alignment,
    withRasterCrop: async (item) => ({ ...item, imageUrl: "data:image/png;base64,abc", surface: "png" })
  });
  assert.equal(missed.formulaTier, "crop");
  assert.equal(missed.latex, undefined);
  assert.equal(missed.verified, undefined);
});

test("a KaTeX failure stays off the page and a success path does not assign innerHTML", () => {
  const el = (tag) => {
    const node = {
      tag,
      className: "",
      classList: {
        add(...names) { names.forEach((name) => node.classList.set.add(name)); },
        contains(name) { return node.classList.set.has(name); },
        toggle(name, on) {
          if (on) node.classList.set.add(name);
          else node.classList.set.delete(name);
          return on;
        },
        set: new Set()
      },
      dataset: {},
      style: {},
      childNodes: [],
      textContent: "",
      tabIndex: 0,
      isConnected: false,
      setAttribute() {},
      addEventListener() {},
      querySelector() { return null; },
      append(...kids) {
        for (const kid of kids) {
          node.childNodes.push(kid);
          kid.isConnected = true;
        }
      },
      ownerDocument: null
    };
    Object.defineProperty(node, "innerHTML", {
      set() { throw new Error("innerHTML"); },
      get() { return ""; }
    });
    return node;
  };
  const doc = {
    createElement(tag) {
      const node = el(tag);
      node.ownerDocument = doc;
      return node;
    },
    defaultView: null
  };
  const parent = el("div");
  parent.ownerDocument = doc;
  const katex = {
    renderToString(latex) {
      if (String(latex).includes("\\bad")) throw new Error("bad latex");
      return "<span>ok</span>";
    },
    render(latex, node) {
      const child = doc.createElement("span");
      child.textContent = String(latex);
      node.append(child);
    }
  };
  const broken = {
    formulaTier: "arxiv",
    latex: "\\bad",
    latexSource: "arxiv-src",
    verified: true,
    eqLabel: "(1)"
  };
  const textOf = (node) => `${node?.textContent || ""}${(node?.childNodes || []).map(textOf).join("")}`;
  assert.equal(mountArxivDisplay(parent, broken, 1, { katex }), "katex-error");
  assert.equal(parent.childNodes.length, 0);
  assert.equal(textOf(parent).includes("#e10091"), false);
  const shown = mountArxivDisplay(parent, { ...broken, latex: "E=mc^2" }, 1, { katex });
  assert.equal(shown, "ok");
  const painted = textOf(parent);
  assert.equal(painted.includes("E=mc^2"), true);
  assert.equal(painted.includes("$$"), false);
  assert.equal(painted.includes("#e10091"), false);

  const colored = el("div");
  colored.ownerDocument = doc;
  const colorKatex = {
    renderToString() { return "<span>ok</span>"; },
    render(_latex, node) {
      const child = doc.createElement("span");
      child.style.color = "rgb(225, 0, 145)";
      child.textContent = "x";
      node.append(child);
    }
  };
  assert.equal(mountArxivDisplay(colored, { ...broken, latex: "x" }, 1, { katex: colorKatex }), "katex-error");
  assert.equal(colored.childNodes.length, 0);
  assert.equal(failedInlineKind({ formulaTier: "placeholder", imageUrl: "data:image/png;base64,abc" }), "placeholder");
  assert.equal(failedInlineKind({ formulaTier: "arxiv", imageUrl: "data:image/png;base64,abc" }), "crop");
  assert.equal(failedInlineKind({ formulaTier: "arxiv", latex: "x" }), "placeholder");
});

test("copying a paragraph writes inline source latex between dollar signs", () => {
  const frag = {
    nodeType: 1,
    childNodes: [
      { nodeType: 3, textContent: "模型 " },
      {
        nodeType: 1,
        classList: { contains: (name) => name === "oi-pdf-inline-math" || name === "is-katex" },
        dataset: { latex: "d_{model}" },
        childNodes: []
      },
      { nodeType: 3, textContent: " 为 512" }
    ]
  };
  assert.equal(plainWithInlineMath(frag), "模型 $d_{model}$ 为 512");
  assert.equal(copyLatexText("d_{model}"), "d_{model}");
  assert.equal(katexClickKept(0, 4), true);
  assert.equal(katexClickKept(0, 4.1), false);
});

test("Attention v7 placement counts", async () => {
  const katex = loadKatex();
  const paper = await loadAttentionPages();
  const packed = await loadSource(SRC_V7, SRC_V7_SHA, "把 1706.03762v7.tar.gz 放到 tests/fixtures/arxiv-src/。");
  const prepared = prepareArxivAlignment({
    files: packed.files,
    pages: paper.pages,
    katex,
    id: "1706.03762",
    version: "v7"
  });
  assert.equal(prepared.ok, true);
  const totals = sourceTotals(prepared.alignment.formulas);
  const shown = shownCounts(prepared.alignment.formulas);
  assert.equal(totals.display, 5);
  assert.equal(totals.inline, 87);
  assert.equal(shown.display, 5, `display on screen ${shown.display}`);
  assert.ok(shown.inline > 0, `inline on screen ${shown.inline}`);
  console.log(`Attention placement display ${shown.display}/${totals.display} inline ${shown.inline}/${totals.inline}`);
});
