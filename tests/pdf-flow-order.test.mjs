import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { alignBodyFlow, latexParagraphs } from "../lib/pdf-flow-gate.js";
import { bodyFlow, continuesBlock, dehyphenJoin, joinFlowBlocks, joinPageBoundary } from "../lib/pdf-flow-join.js";
import { insertBlockByPosition, readingOrderOff, reconcilePage } from "../lib/mm-reconcile.js";
import { parsePageJson } from "../lib/mm-page.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { xyCutOrder } from "../lib/pdf-xy-cut.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");

function line(text, x, y, width = 200, height = 10) {
  return { text, x, y, width, height, items: [{ str: text, x, y, width, height, sourceIndex: 0 }] };
}

function unitViewport(width, height) {
  return {
    width,
    height,
    convertToViewportRectangle(rect) {
      const [x1, y1, x2, y2] = rect;
      return [x1, height - y2, x2, height - y1];
    }
  };
}

function pdfItem(str, x, y, width, height) {
  return { str, x, y, width, height, transform: [1, 0, 0, 1, x, y] };
}

test("a fragment above the title stays owned by the page", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("Equal contribution", 72, 742, 110, 8),
      pdfItem("Attention Is All You Need", 96, 730, 420, 20),
      pdfItem("Ashish Vaswani", 72, 690, 120, 10),
      pdfItem("avaswani@google.com", 72, 662, 140, 8),
      pdfItem("Abstract", 72, 548, 70, 12),
      pdfItem("The dominant sequence transduction models are based on complex recurrent networks.", 72, 528, 420, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 1
  });
  assert.deepEqual(page.sourceAudit.missing, []);
  assert.match(page.blocks.map((block) => block.text || "").join("\n"), /Equal contribution/);
});

test("xy-cut reads the left column before the right, and parks a narrow aside after the body", () => {
  const lines = [
    line("Left top sentence about attention models.", 40, 700, 220),
    line("Left bottom sentence continues the point.", 40, 680, 220),
    line("Right top sentence about recurrence.", 300, 700, 180),
    line("Right bottom sentence ends the column.", 300, 680, 180),
    line("Research in context box.", 540, 690, 60)
  ];
  const ordered = xyCutOrder(lines, { width: 650, height: 800 });
  const texts = ordered.map((entry) => entry.text);
  assert.ok(texts.indexOf(lines[0].text) < texts.indexOf(lines[2].text));
  assert.ok(texts.indexOf(lines[1].text) < texts.indexOf(lines[2].text));
  assert.equal(ordered.at(-1).region, "aside");
  assert.equal(ordered.at(-1).text, "Research in context box.");
});

test("xy-cut reads three columns from left to right", () => {
  const lines = [
    line("Left column sentence one here.", 40, 700, 140),
    line("Left column sentence two here.", 40, 680, 140),
    line("Middle column sentence one here.", 230, 700, 140),
    line("Middle column sentence two here.", 230, 680, 140),
    line("Right column sentence one here.", 420, 700, 140),
    line("Right column sentence two here.", 420, 680, 140)
  ];
  const texts = xyCutOrder(lines).map((entry) => entry.text);
  assert.ok(texts.indexOf(lines[1].text) < texts.indexOf(lines[2].text));
  assert.ok(texts.indexOf(lines[3].text) < texts.indexOf(lines[4].text));
  assert.ok(texts.every((text) => texts.filter((entry) => entry === text).length === 1));
});

test("a short capitalized line that continues in lowercase is not a heading, and author leftovers stay owned", () => {
  const joined = joinFlowBlocks([
    { id: "a", label: "text", text: "We introduce recurrence into our" },
    { id: "b", label: "text", text: "deep self-attention network." },
    { id: "c", label: "heading", text: "2 Related Work" },
    { id: "d", label: "text", text: "Prior work studied man-" },
    { id: "e", label: "text", text: "ually shorter segments." }
  ]);
  assert.equal(joined[0].text, "We introduce recurrence into our deep self-attention network.");
  assert.equal(joined[1].skipTranslate, true);
  assert.equal(joined[1].flowHost, "a");
  assert.equal(joined[3].text, "Prior work studied manually shorter segments.");
  assert.equal(dehyphenJoin("man-", "ually"), "manually");
  assert.equal(continuesBlock(joined[2], joined[3]), false);
  assert.equal(continuesBlock(
    { label: "text", text: "state of the", bbox: [0.12, 0.63, 0.49, 0.66] },
    { label: "text", text: "the notion of covariate shift continues here.", bbox: [0.51, 0.55, 0.88, 0.59] }
  ), false);
  const boundary = joinPageBoundary(
    [{ id: "p1", label: "text", text: "segments of man-" }],
    [{ id: "p2", label: "text", text: "ually fixed length." }]
  );
  assert.equal(boundary.joined, true);
  assert.equal(boundary.previous[0].text, "segments of manually fixed length.");
  assert.equal(boundary.next[0].flowHost, "p1");
  const aside = bodyFlow([
    { id: "b", label: "text", text: "Body sentence here today." },
    { id: "s", label: "aside", text: "Published online." },
    { id: "t", label: "text", text: "tail", flowHost: "b" }
  ]);
  assert.deepEqual(aside.map((block) => block.id), ["b"]);
});

test("unmatched text is inserted by position, and one model block can cover two text blocks", () => {
  const placed = [];
  insertBlockByPosition(placed, { id: "top", bbox: [0.1, 0.1, 0.4, 0.2], text: "top" });
  insertBlockByPosition(placed, { id: "low", bbox: [0.1, 0.7, 0.4, 0.8], text: "low" });
  insertBlockByPosition(placed, { id: "mid", bbox: [0.1, 0.4, 0.4, 0.5], text: "mid" });
  assert.deepEqual(placed.map((block) => block.id), ["top", "mid", "low"]);
  const { blocks } = reconcilePage(
    [
      { id: "m", label: "text", bbox: [0.1, 0.1, 0.9, 0.3], order: 1, text: "Alpha sentence is complete." },
      { id: "z", label: "text", bbox: [0.1, 0.75, 0.9, 0.9], order: 2, text: "Closing sentence is last." }
    ],
    [
      { id: "t1", label: "text", bbox: [0.1, 0.1, 0.9, 0.3], text: "Alpha sentence is complete." },
      { id: "t2", label: "text", bbox: [0.1, 0.4, 0.9, 0.55], text: "Beta sentence sits in the middle of the page." }
    ]
  );
  assert.deepEqual(blocks.map((block) => block.id), ["t1", "t2", "z"]);
  assert.equal(blocks[1].flag, "restored");
  const covered = reconcilePage(
    [{ id: "m", label: "text", bbox: [0.1, 0.2, 0.9, 0.7], order: 1, text: "Alpha sentence. Beta sentence." }],
    [
      { id: "t1", label: "text", bbox: [0.1, 0.2, 0.9, 0.4], text: "Alpha sentence." },
      { id: "t2", label: "text", bbox: [0.1, 0.45, 0.9, 0.65], text: "Beta sentence." }
    ]
  );
  assert.equal(covered.blocks.length, 1);
  assert.equal(covered.blocks[0].text.includes("Alpha sentence."), true);
  assert.equal(covered.blocks[0].text.includes("Beta sentence."), true);
  const off = readingOrderOff(
    [
      { id: "d" }, { id: "c" }, { id: "b" }, { id: "a" }
    ],
    [
      { id: "a", text: "a" }, { id: "b", text: "b" }, { id: "c", text: "c" }, { id: "d", text: "d" }
    ]
  );
  assert.equal(off, true);
  const parsed = parsePageJson(JSON.stringify({
    v: "mp-1",
    columns: 2,
    blocks: [{
      id: "b1",
      label: "aside",
      bbox: [0.8, 0.1, 1, 0.4],
      order: 1,
      continues: true,
      text: "A side note."
    }]
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.page.blocks[0].label, "aside");
  assert.equal(parsed.page.blocks[0].continues, true);
});

test("latex alignment requires a forward body order and counts a mid-sentence break", () => {
  const source = String.raw`
    \begin{document}
    Transformers learn longer context when the segment carries its state forward across the boundary.

    The next paragraph starts a new claim about relative position and does not continue the first.
    \end{document}`;
  const paragraphs = latexParagraphs(source);
  const good = alignBodyFlow(paragraphs, [
    { label: "text", text: "Transformers learn longer context when the segment carries its state forward across the boundary." },
    { label: "text", text: "The next paragraph starts a new claim about relative position and does not continue the first." }
  ]);
  assert.equal(good.coverage, 1);
  assert.equal(good.inversions, 0);
  assert.equal(good.breaks, 0);
  const swapped = alignBodyFlow(paragraphs, [
    { label: "text", text: "The next paragraph starts a new claim about relative position and does not continue the first." },
    { label: "text", text: "Transformers learn longer context when the segment carries its state forward across the boundary." }
  ]);
  assert.equal(swapped.inversions > 0, true);
  const broken = alignBodyFlow(paragraphs, [
    { label: "text", text: "Transformers learn longer context when the segment" },
    { label: "text", text: "carries its state forward across the boundary." }
  ]);
  assert.equal(broken.breaks, 1);
  assert.equal(broken.breakExamples[0].kind, "real");
  const swappedExample = swapped.inversionExamples.find((entry) => entry.kind === "real");
  assert.ok(swappedExample);
  const withLater = alignBodyFlow([
    ...paragraphs,
    "Quantum chromodynamics predicts a totally different set of particle masses and couplings in this unrelated section."
  ], [
    { label: "text", text: "Transformers learn longer context when the segment carries its state forward across the boundary." },
    { label: "text", text: "The next paragraph starts a new claim about relative position and does not continue the first." }
  ]);
  assert.equal(withLater.total, 2);
  assert.equal(withLater.coverage, 1);
  const force = viewer.slice(viewer.indexOf("async function forceRetranslateCurrentPage"), viewer.indexOf("async function forceRetranslateCurrentPage") + 1600);
  assert.match(force, /MM_PAGE_MODE && mmPageConfigured\(formulaViewerSettings\)/);
  assert.ok(force.includes("const sourceLayout = getPageLayout(page)"));
});
