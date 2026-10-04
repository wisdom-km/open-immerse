import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PDF_PAPER_GUTTER_X,
  pagesInTranslateScope,
  paperAvailWidth,
  paperCssPx,
  basePageBox,
  readoutPaperSize,
  paintedPaperWidth,
  paneHasHScroll,
  raisedStackWidth
} from "../lib/pdf-paper.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const src = readFileSync(join(root, "pdf/viewer.js"), "utf8");

test("paper width tracks the left page and clamps to the right pane", () => {
  assert.equal(PDF_PAPER_GUTTER_X, 16);
  assert.equal(paperAvailWidth(800), 768);
  assert.equal(paperAvailWidth(32), 0);
  assert.equal(paperAvailWidth(0), 0);
  const letter = readoutPaperSize({ leftWidth: 612, leftHeight: 792, availWidth: 768 });
  assert.equal(letter.width, 612);
  assert.equal(letter.heightBase, 792);
  const squeezed = readoutPaperSize({ leftWidth: 612, leftHeight: 792, availWidth: 368 });
  assert.equal(squeezed.width, 368);
  assert.ok(Math.abs(squeezed.heightBase - (368 * 792) / 612) < 0.001);
  const zoomed = readoutPaperSize({ leftWidth: 765, leftHeight: 990, availWidth: 900 });
  assert.equal(zoomed.width, 765);
  assert.equal(zoomed.heightBase, 990);
  const a4 = readoutPaperSize({ leftWidth: 595.28, leftHeight: 841.89, availWidth: 900 });
  assert.equal(a4.width, 595.28);
  assert.ok(Math.abs(a4.aspect - (595.28 / 841.89)) < 1e-9);
  assert.ok(Math.abs(a4.heightBase - 841.89) < 0.001);
  const landscape = readoutPaperSize({ leftWidth: 792, leftHeight: 612, availWidth: 700 });
  assert.equal(landscape.width, 700);
  assert.ok(Math.abs(landscape.heightBase - (700 * 612) / 792) < 0.001);
  assert.notEqual(landscape.aspect, letter.aspect);
  assert.deepEqual(readoutPaperSize({ availWidth: 400 }), { width: 0, heightBase: 0, aspect: 0 });
  assert.deepEqual(readoutPaperSize({}), { width: 0, heightBase: 0, aspect: 0 });
  assert.deepEqual(basePageBox({ width: 612, height: 792 }, 1), { width: 612, height: 792 });
  assert.deepEqual(basePageBox({ width: 765, height: 990 }, 1.25), { width: 612, height: 792 });
  assert.deepEqual(basePageBox({ width: 918, height: 1188 }, 1.5), { width: 612, height: 792 });
  assert.deepEqual(basePageBox({ width: 1224, height: 1584 }, 2), { width: 612, height: 792 });
  assert.deepEqual(basePageBox({ width: 612, height: 792 }, 0), { width: 612, height: 792 });
  assert.equal(basePageBox(null, 1), null);
  assert.equal(paperCssPx(612), "612px");
  assert.equal(paperCssPx(792.126), "792.13px");
  assert.equal(paperCssPx(0), "0px");
});

test("translate scope is one paper for the current page and one paper per page for the document", () => {
  const pages = [{ page: 1 }, { page: 2 }, { page: 3 }];
  assert.deepEqual(pagesInTranslateScope(pages, "all", 2), pages);
  assert.deepEqual(pagesInTranslateScope(pages, "page", 2), [{ page: 2 }]);
  assert.deepEqual(pagesInTranslateScope(pages, "page", 9), []);
});

test("right pane DOM contract is a continuous reader flow, not a 42rem column", () => {
  const scroll = html.slice(html.indexOf('id="translateScroll"'), html.indexOf('id="emptyRead"'));
  assert.match(scroll, /id="readerFlow"[^>]*class="reader-flow"/);
  assert.equal(scroll.includes("readout-paper"), false);
  assert.equal(scroll.includes("paper-stack"), false);
  assert.ok(scroll.indexOf('id="readerFlow"') < html.indexOf('id="emptyRead"'));
  assert.match(src, /className = "rf-page readout md-readout"/);
  assert.doesNotMatch(src, /className = "readout-paper"/);
  assert.doesNotMatch(src, /className = "readout-type"/);
  assert.match(src, /--oi-pdf-left-w/);
  assert.match(src, /ResizeObserver/);
  assert.match(src, /applyPaperMetrics\(\)/);
  assert.match(src, /function leftBaseBox/);
  const metrics = src.slice(src.indexOf("function formulaPaneMetrics"), src.indexOf("async function renderSharpVisualCrop"));
  const heightFor = src.slice(src.indexOf("function paperHeightFor"), src.indexOf("function matchedFormulaStyle"));
  const apply = src.slice(src.indexOf("function applyPaperMetrics"), src.indexOf("function bindPaperMetrics"));
  assert.match(metrics, /leftBaseBox\(/);
  assert.match(heightFor, /leftBaseBox\(/);
  assert.match(apply, /leftBaseBox\(/);
  assert.match(apply, /refreshMatchedFormulas/);
  assert.doesNotMatch(apply, /leftPageBox\(/);
  assert.doesNotMatch(apply, /applyBodyFont/);
  const planKey = src.slice(src.indexOf("function formulaCropPlanKeyNow"), src.indexOf("function noteFormulaCropPlan"));
  assert.match(planKey, /zoom/);
  const setZoom = src.slice(src.indexOf("async function setZoom"), src.indexOf("async function scheduleVisibleRenders"));
  assert.match(setZoom, /applyPaperMetrics\(\)/);
  const split = src.slice(src.indexOf("function applySplit"), src.indexOf("function initZoomChip"));
  assert.match(split, /applyPaperMetrics\(\)/);
  assert.match(css, /\.reader-flow\s*\{[^}]*background:\s*var\(--oi-reader-paper\)/s);
  assert.match(css, /\.reader-flow\s*\{[^}]*color:\s*var\(--oi-reader-ink\)/s);
  assert.match(css, /\.reader-flow\s*\{[^}]*width:\s*var\(--rf-measure,\s*min\(var\(--oi-reader-measure\)/s);
  assert.match(css, /\.reader-flow \.readout\s*\{[^}]*overflow:\s*visible/s);
  assert.doesNotMatch(css, /\.paper-stack\s*\{[^}]*zoom:/s);
  assert.doesNotMatch(css, /\.paper-stack\s*\{[^}]*width:\s*calc\(100% \* var\(--oi-mirror-zoom/s);
  assert.match(css, /\.reader-flow \.readout\s*\{[^}]*max-width:\s*none/s);
  assert.doesNotMatch(css, /\.readout \.oi-pdf-p\[data-role="authors"\]\s*\{[^}]*grid-template-columns/);
  assert.match(css, /\.oi-pdf-display-math\s*\{[^}]*text-align:\s*center/s);
  assert.match(css, /\.reader-flow \.oi-pdf-display-math,\s*\.reader-flow \.oi-pdf-figure\s*\{[^}]*position:\s*static/s);
  assert.match(css, /\.reader-flow \.oi-pdf-display-math,\s*\.reader-flow \.oi-pdf-figure\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.oi-pdf-math-scroll\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.oi-pdf-math-scroll \.oi-pdf-math-crop\s*\{[^}]*max-width:\s*none/s);
  assert.doesNotMatch(css, /max-width:\s*42rem/);
  assert.doesNotMatch(src, /letterFallback|612 \* scale|PDF_PAPER_FALLBACK_ASPECT/);
  assert.match(src, /#pages \.pdf-page\[data-page=/);
  const pageBox = src.slice(src.indexOf("function leftPageBox"), src.indexOf("function paperHeightFor"));
  assert.match(pageBox, /style\.width/);
  assert.match(pageBox, /aspectRatio/);
  assert.ok(pageBox.indexOf("style.width") < pageBox.indexOf("offsetWidth"));
  assert.doesNotMatch(pageBox, /canvas/);
  assert.doesNotMatch(html, /id="mirrorPages"/);
  assert.doesNotMatch(html, /id="viewSeg"/);
  assert.doesNotMatch(src, /\$\("mirrorPages"\)\.hidden = false/);
  assert.doesNotMatch(src, /appendMirrorPage|buildMirrorLayout/);
  assert.doesNotMatch(css, /--oi-paper:\s*#/);
  const ensure = src.slice(src.indexOf("function ensurePaper"), src.indexOf("function renderStoredArticle"));
  assert.doesNotMatch(ensure, /position:\s*["']absolute["']|dataset\.bbox/);
  assert.match(ensure, /className = "rf-page readout md-readout"/);
  assert.match(ensure, /if \(!flow/);
  const cleared = src.slice(src.indexOf("function renderArticle"), src.indexOf("function stampReaderPage"));
  assert.match(cleared, /paintPageSlot/);
  assert.doesNotMatch(cleared, /stack\.replaceChildren\(\)|flow\.replaceChildren\(/);
  assert.doesNotMatch(cleared, /--oi-pdf-stack-w/);
  assert.match(css, /\.pane-translate-scroll\s*\{[^}]*overflow:\s*auto/s);
  assert.match(css, /\.pane-translate-scroll\s*\{[^}]*scroll-behavior:\s*auto/s);
  assert.doesNotMatch(src, /behavior:\s*["']smooth["']/);
  assert.match(src, /pagesInTranslateScope/);
  assert.match(src, /appendCropOrNotice/);
  assert.doesNotMatch(
    src.slice(src.indexOf("function appendFixtureReadout"), src.indexOf("function onReadoutBlockClick")),
    /katex\.render/
  );
});

test("right pane horizontal scrollbar matches the left page: only when the painted page exceeds the pane", () => {
  // Letter page, scrollport wide enough that 150% still fits and 200% does not.
  // Same client width for both panes. Right paper is the unzoomed page (not clamped).
  const unit = 612;
  const client = 1000;
  const zooms = [1, 1.25, 1.5, 2, 2.5];
  const right = zooms.map((zoom) => paneHasHScroll(paintedPaperWidth(unit, zoom), client));
  const left = zooms.map((zoom) => paneHasHScroll(Math.floor(unit * zoom), client));
  assert.deepEqual(right, [false, false, false, true, true]);
  assert.deepEqual(left, right);
  // Old .paper-stack width calc(100% * zoom) overflowed at the first step above 100%.
  const oldStack = zooms.map((zoom) => paneHasHScroll(client * zoom, client));
  assert.deepEqual(oldStack, [false, true, true, true, true]);
  assert.equal(paintedPaperWidth(612, 1.25) > 1000, false);
  assert.equal(paneHasHScroll(0, 1000), false);
  assert.equal(paneHasHScroll(100, 0), false);
  assert.equal(paneHasHScroll(100, 100), false);
  assert.equal(paneHasHScroll(102, 100), true);
  assert.equal(paintedPaperWidth(0, 1.25), 0);
  assert.equal(paintedPaperWidth(400, 0), 0);
  const narrow = 400;
  const clamped = Math.min(unit, narrow - 32);
  assert.equal(paneHasHScroll(paintedPaperWidth(clamped, 1), narrow), false);
  assert.equal(paneHasHScroll(Math.floor(unit * 1), narrow), true);
  assert.equal(paneHasHScroll(paintedPaperWidth(clamped, 1.25), narrow), true);
});

test("renderArticle saves and restores the right pane scrollLeft", () => {
  const render = src.slice(src.indexOf("function renderArticle"), src.indexOf("function stampReaderPage"));
  const saved = render.indexOf("const keepLeft = pane ? pane.scrollLeft : 0;");
  const restored = render.indexOf("if (pane) pane.scrollLeft = keepLeft;");
  assert.ok(saved >= 0 && restored > saved);
  assert.match(render, /captureFlowAnchor/);
  assert.match(render, /restoreFlowAnchor\(anchor\)/);
  assert.equal(render.includes("pane.scrollTop = keep"), false);
  assert.equal(render.includes("replaceChildren"), false);
  assert.ok(render.indexOf("captureFormulaScrolls") < restored);
});

test("appending a paper raises --oi-pdf-stack-w only when the new paper is wider", () => {
  assert.equal(raisedStackWidth(400, 612), 612);
  assert.equal(raisedStackWidth(612, 400), 612);
  assert.equal(raisedStackWidth(612, 612), 612);
  assert.equal(raisedStackWidth(0, 500), 500);
  assert.equal(raisedStackWidth(Number.NaN, 480), 480);
  assert.equal(raisedStackWidth(480, Number.NaN), 480);
  assert.equal(raisedStackWidth(undefined, -1), 0);
  assert.equal(paperCssPx(raisedStackWidth(612, 700.126)), "700.13px");
});
