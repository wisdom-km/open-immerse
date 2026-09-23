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
  readoutPaperSize
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

test("right pane DOM contract is a paper stack, not a 42rem column", () => {
  const scroll = html.slice(html.indexOf('id="translateScroll"'), html.indexOf("mirrorZoomChip"));
  assert.match(scroll, /id="paperStack"[^>]*class="paper-stack"/);
  assert.equal(scroll.includes("readout-paper"), false);
  assert.ok(scroll.indexOf('id="paperStack"') < scroll.indexOf('id="emptyRead"'));
  assert.match(src, /className = "readout-paper"/);
  assert.match(src, /className = "readout-type"/);
  assert.match(src, /className = "readout md-readout"/);
  assert.match(src, /paper\.append\(type\)/);
  assert.match(src, /type\.append\(readout\)/);
  assert.match(src, /--oi-pdf-paper-w/);
  assert.match(src, /--oi-pdf-paper-h-base/);
  assert.match(src, /--oi-pdf-left-w/);
  assert.match(src, /ResizeObserver/);
  assert.match(src, /applyPaperMetrics\(\)/);
  const setZoom = src.slice(src.indexOf("async function setZoom"), src.indexOf("async function scheduleVisibleRenders"));
  assert.match(setZoom, /applyPaperMetrics\(\)/);
  const split = src.slice(src.indexOf("function applySplit"), src.indexOf("function initZoomChip"));
  assert.match(split, /applyPaperMetrics\(\)/);
  assert.match(css, /\.readout-paper\s*\{[^}]*background:\s*var\(--oi-paper\)/s);
  assert.match(css, /\.readout-paper\s*\{[^}]*color:\s*var\(--oi-paper-ink\)/s);
  assert.match(css, /\.readout-paper\s*\{[^}]*box-shadow:\s*var\(--oi-shadow-1\)/s);
  assert.match(css, /\.readout-paper\s*\{[^}]*width:\s*var\(--oi-pdf-paper-w\)/s);
  assert.match(css, /\.readout-paper\s*\{[^}]*min-height:\s*var\(--oi-pdf-paper-h-base\)/s);
  assert.match(css, /\.readout-paper\s*\{[^}]*overflow:\s*visible/s);
  assert.match(css, /\.paper-stack\s*\{[^}]*align-items:\s*center/s);
  assert.match(css, /\.paper-stack\s*\{[^}]*gap:\s*var\(--oi-pdf-paper-gap-y\)/s);
  assert.match(css, /\.paper-stack\s*\{[^}]*zoom:\s*var\(--oi-mirror-zoom/s);
  assert.match(css, /\.readout-type\s*\{[^}]*calc\(var\(--oi-pdf-paper-h-base\) \* 0\.075\)/);
  assert.match(css, /calc\(var\(--oi-pdf-paper-w\) \* 0\.085\)/);
  assert.match(css, /calc\(var\(--oi-pdf-paper-h-base\) \* 0\.08\)/);
  assert.match(css, /\.readout-paper \.readout\s*\{[^}]*max-width:\s*none/s);
  assert.match(css, /\.readout-type\s*\{[^}]*column-count:\s*1/s);
  assert.doesNotMatch(css, /\.readout \.oi-pdf-p\[data-role="authors"\]\s*\{[^}]*grid-template-columns/);
  assert.doesNotMatch(css, /\.readout-type\s*\{[^}]*column-count:\s*[2-9]/);
  assert.match(css, /\.oi-pdf-display-math\s*\{[^}]*text-align:\s*center/s);
  assert.match(css, /\.readout-paper \.oi-pdf-display-math,\s*\.readout-paper \.oi-pdf-figure\s*\{[^}]*position:\s*static/s);
  assert.match(css, /\.readout-paper \.oi-pdf-display-math,\s*\.readout-paper \.oi-pdf-figure\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.oi-pdf-display-math \.oi-pdf-math-crop\s*\{[^}]*max-width:\s*100%/s);
  assert.doesNotMatch(css, /max-width:\s*42rem/);
  assert.doesNotMatch(src, /letterFallback|612 \* scale|PDF_PAPER_FALLBACK_ASPECT/);
  assert.match(src, /#pages \.pdf-page\[data-page=/);
  const pageBox = src.slice(src.indexOf("function leftPageBox"), src.indexOf("function applyPaperMetrics"));
  assert.match(pageBox, /style\.width/);
  assert.match(pageBox, /aspectRatio/);
  assert.ok(pageBox.indexOf("style.width") < pageBox.indexOf("offsetWidth"));
  assert.doesNotMatch(pageBox, /canvas/);
  assert.match(html, /id="mirrorPages"[^>]*class="mirror-pages"[^>]*hidden/);
  assert.doesNotMatch(src, /\$\("mirrorPages"\)\.hidden = false/);
  assert.doesNotMatch(src, /appendMirrorPage|buildMirrorLayout/);
  assert.doesNotMatch(css, /--oi-paper:\s*#/);
  assert.doesNotMatch(css, /\.readout-paper\s*\{[^}]*[^-]height:\s*var\(--oi-pdf-paper-h-base\)/);
  assert.doesNotMatch(
    src.slice(src.indexOf("function ensurePaper"), src.indexOf("function renderStoredArticle")),
    /position:\s*["']absolute["']|dataset\.bbox/
  );
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
