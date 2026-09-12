import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";

import {
  DEFAULT_ZOOM,
  PDF_COPY,
  ZOOM_MIN,
  blockLocation,
  clampZoom,
  favoriteSegment,
  favoriteSegmentItem,
  isPdfViewerPage,
  looksLikePdfUrl,
  nextZoom,
  pageIndex,
  pageLabel,
  pagePath,
  readViewerSrc,
  shouldOfferPdfOpen,
  textLayerCopy,
  translationBlock,
  viewerSearch,
  zoomLabel
} from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const src = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const popupHtml = readFileSync(join(root, "popup/popup.html"), "utf8");
const popupJs = readFileSync(join(root, "popup/popup.js"), "utf8");
const popupCss = readFileSync(join(root, "popup/popup.css"), "utf8");
const manifest = readFileSync(join(root, "manifest.json"), "utf8");
const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");

test("M1 viewer is an extension-owned pdf.js page, not Chrome PDF injection", () => {
  assert.match(html, /<title>PDF 阅读<\/title>/);
  assert.match(html, /<h1>PDF 阅读<\/h1>/);
  assert.match(html, /class="mark"/);
  assert.match(html, /ui\/tokens\.css/);
  assert.match(html, /id="file"[^>]*accept="application\/pdf,\.pdf"/);
  assert.match(html, /id="pick"[^>]*>打开 PDF</);
  assert.match(html, /id="prev"[^>]*>上一页</);
  assert.match(html, /id="next"[^>]*>下一页</);
  assert.match(html, /id="zoomOut"/);
  assert.match(html, /id="zoomIn"/);
  assert.match(src, /from "\.\/vendor\/pdf\.min\.mjs"/);
  assert.match(src, /GlobalWorkerOptions\.workerSrc/);
  assert.match(src, /pdf\/vendor\/pdf\.worker\.min\.mjs/);
  assert.match(src, /getDocument/);
  assert.equal(src.includes("OI_TRANSLATE_BATCH"), false);
  assert.equal(existsSync(join(root, "pdf/vendor/pdf.min.mjs")), true);
  assert.equal(existsSync(join(root, "pdf/vendor/pdf.worker.min.mjs")), true);
  assert.match(readFileSync(join(root, "pdf/vendor/VERSION"), "utf8"), /pdfjs-dist 4\.10\.38/);
});

test("split layout is left/right by default and stacks below 900px", () => {
  assert.match(css, /#page\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.workspace\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s);
  assert.match(css, /@media \(max-width:\s*899px\)\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(html, /class="workspace"/);
  assert.match(html, /class="pane-pdf"/);
  assert.match(html, /class="pane-translate"/);
  assert.match(html, /点击翻译/);
  assert.match(html, /id="translatePage"[^>]*disabled>翻译</);
  assert.match(html, /id="blocks"[^>]*data-favorite-hook="per-block"/);
  assert.match(html, /id="emptyTranslate"/);
  assert.match(src, /appendTranslationBlock/);
  assert.match(src, /data-favorite-block/);
  assert.match(src, /favoriteSegmentItem/);
  assert.match(html, /本页没有文字层|扫描件翻译将在后续版本支持/);
});

test("M2 stub copy is present for empty / loading / error / no text layer", () => {
  assert.equal(PDF_COPY.empty, "还没有打开 PDF。");
  assert.equal(PDF_COPY.loading, "正在打开 PDF…");
  assert.equal(PDF_COPY.error, "无法打开这个 PDF。");
  assert.equal(PDF_COPY.fetchFail, "无法从此地址读取 PDF，请改用本地文件。");
  assert.equal(PDF_COPY.noTextLayer, "本页没有文字层。");
  assert.equal(PDF_COPY.noTextLayerHint, "扫描件翻译将在后续版本支持。");
  assert.equal(PDF_COPY.translateHint, "点击翻译");
  assert.equal(PDF_COPY.favorite, "收藏本段");
  assert.equal(textLayerCopy(0), PDF_COPY.noTextLayer);
  assert.equal(textLayerCopy(3), "");
  assert.match(src, /PDF_COPY\.fetchFail/);
  assert.match(src, /textLayerCopy/);
  assert.match(html, /还没有打开 PDF。/);
});

test("zoom has a minimum floor and page helpers stay in range", () => {
  assert.equal(ZOOM_MIN, 0.5);
  assert.equal(clampZoom(0.1), 0.5);
  assert.equal(clampZoom(9), 3);
  assert.equal(clampZoom("nope"), DEFAULT_ZOOM);
  assert.equal(nextZoom(0.5, -1), 0.5);
  assert.equal(nextZoom(1, 1), 1.25);
  assert.equal(zoomLabel(1), "100%");
  assert.equal(pageIndex(1, 4, -1), 1);
  assert.equal(pageIndex(4, 4, 1), 4);
  assert.equal(pageIndex(2, 4, 1), 3);
  assert.equal(pageLabel(2, 9), "2 / 9");
});

test("looksLikePdfUrl and popup entry only for PDF tabs", () => {
  assert.equal(looksLikePdfUrl("https://cdn.example.com/paper.pdf"), true);
  assert.equal(looksLikePdfUrl("https://cdn.example.com/paper.pdf?dl=1"), true);
  assert.equal(looksLikePdfUrl("file:///Users/me/Doc.pdf"), true);
  assert.equal(looksLikePdfUrl("https://example.com/file?filename=notes.pdf"), true);
  assert.equal(looksLikePdfUrl("data:application/pdf;base64,AAA"), true);
  assert.equal(looksLikePdfUrl("https://example.com/article"), false);
  assert.equal(looksLikePdfUrl(""), false);
  assert.equal(isPdfViewerPage("chrome-extension://abc/pdf/viewer.html?src=x"), true);
  assert.equal(shouldOfferPdfOpen("https://x.com/a.pdf"), true);
  assert.equal(shouldOfferPdfOpen("chrome-extension://abc/pdf/viewer.html"), false);
  assert.equal(readViewerSrc("?src=https%3A%2F%2Fx.com%2Fa.pdf"), "https://x.com/a.pdf");
  assert.equal(viewerSearch("https://x.com/a.pdf"), "?src=https%3A%2F%2Fx.com%2Fa.pdf");
  assert.match(popupHtml, /id="pdfEntry" hidden/);
  assert.match(popupHtml, /id="openPdf"[^>]*>在沉浸译中打开</);
  assert.match(popupHtml, /id="openPdfPage">PDF</);
  assert.match(popupJs, /shouldOfferPdfOpen/);
  assert.match(popupJs, /page: "pdf"/);
  assert.match(popupJs, /src: pdfTab \? tab\.url/);
  assert.match(popupCss, /\.btn-primary[^}]*background:\s*var\(--oi-accent\)/);
});

test("favoriteSegment is the M1 plumbing hook into OI_SAVE_LEARNING", async () => {
  const item = favoriteSegmentItem({
    original: "Hello",
    translation: "你好",
    url: "https://x.com/a.pdf",
    filename: "paper.pdf",
    page: 2
  });
  assert.equal(item.original, "Hello");
  assert.equal(item.translation, "你好");
  assert.equal(item.title, "PDF · paper.pdf · p.2");
  assert.equal(item.context, "PDF · paper.pdf · p.2");
  assert.equal(blockLocation({ filename: "a.pdf", page: 3 }), "PDF · a.pdf · p.3");
  assert.equal(blockLocation({ filename: "notes.pdf", page: 1 }), "PDF · notes.pdf · p.1");
  assert.notEqual(item.context, "paper.pdf p.2");
  assert.equal(translationBlock({ original: "Hi", page: 1 }).original, "Hi");
  const sent = [];
  const result = await favoriteSegment(item, async (msg) => {
    sent.push(msg);
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(sent[0].type, "OI_SAVE_LEARNING");
  assert.equal(sent[0].item.original, "Hello");
  assert.equal(sent[0].item.context, "PDF · paper.pdf · p.2");
  const empty = await favoriteSegment({ original: "" }, async () => ({ ok: true }));
  assert.equal(empty.ok, false);
  assert.match(src, /favoriteSegment/);
});

test("vendored pdf.js opens the two-page M1 fixture", async () => {
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const data = new Uint8Array(readFileSync(join(root, "tests/fixtures/sample-m1.pdf")));
  assert.equal(String.fromCharCode(...data.slice(0, 5)), "%PDF-");
  const doc = await getDocument({ data, verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  try {
    assert.equal(doc.numPages, 2);
    const page = await doc.getPage(1);
    const text = await page.getTextContent();
    assert.match(text.items.map((item) => item.str).join(" "), /Open Immerse PDF M1 page 1/);
  } finally {
    await doc.destroy();
  }
});

test("manifest exposes viewer assets and SW opens viewer with src", () => {
  assert.match(manifest, /"web_accessible_resources"/);
  assert.match(manifest, /pdf\/viewer\.html/);
  assert.match(manifest, /pdf\/vendor\/\*/);
  assert.equal(pagePath("pdf"), "pdf/viewer.html");
  assert.match(sw, /pdf\/viewer\.html/);
  assert.match(sw, /message\.page === "pdf"/);
  assert.match(sw, /encodeURIComponent\(message\.src\)/);
});
