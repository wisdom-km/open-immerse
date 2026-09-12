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
  abortTranslateSession,
  applyDraftTranslations,
  blockLocation,
  clampZoom,
  collectArticlePages,
  createPageCache,
  createTranslateSession,
  extractPageItems,
  favoriteSegment,
  favoriteSegmentItem,
  isPdfViewerPage,
  looksLikePdfUrl,
  neighborPages,
  nextZoom,
  normalizePdfTranslateScope,
  pageBlocksCopy,
  pageCacheKey,
  pageFromViewport,
  pageHasTranslation,
  pageIndex,
  pageLabel,
  pagePath,
  pageTranslationComplete,
  progressDocumentStatus,
  progressStatus,
  readoutPlaceholder,
  readViewerSrc,
  readoutPageSelector,
  segmentPageBlocks,
  shouldApplyDraft,
  shouldOfferPdfOpen,
  shouldSyncReadout,
  textLayerCopy,
  translateDocumentPages,
  wheelPageDelta,
  translatePageBlocks,
  translationBlock,
  articleNodeSpec,
  viewerSearch,
  zoomLabel
} from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const src = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const libSrc = readFileSync(join(root, "lib/pdf-viewer.js"), "utf8");
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
  const toolbarHtml = html.slice(html.indexOf('class="toolbar"'), html.indexOf('class="workspace"'));
  assert.equal(toolbarHtml.includes('id="zoomOut"'), false);
  assert.equal(toolbarHtml.includes('id="zoomIn"'), false);
  assert.equal(toolbarHtml.includes('id="zoomLabel"'), false);
  assert.equal(toolbarHtml.includes("缩小"), false);
  assert.equal(toolbarHtml.includes("放大"), false);
  assert.match(
    html,
    /<div class="zoom-gutter" role="group" aria-label="缩放">\s*<button type="button" id="zoomOut" class="zoom-gutter-btn" disabled>缩小<\/button>\s*<p id="zoomLabel" class="zoom-gutter-label">100%<\/p>\s*<button type="button" id="zoomIn" class="zoom-gutter-btn" disabled>放大<\/button>\s*<\/div>/
  );
  const workspaceHtml = html.slice(html.indexOf('class="workspace"'), html.indexOf('viewer.js'));
  assert.ok(workspaceHtml.includes('id="zoomOut"') && workspaceHtml.includes('id="zoomLabel"') && workspaceHtml.includes('id="zoomIn"'));
  assert.equal(html.includes("split-gutter"), false);
  assert.equal(html.includes("zoom-stack"), false);
  assert.match(html, /class="split-handle"[^>]*role="separator"[^>]*aria-orientation="vertical"/);
  assert.ok(workspaceHtml.indexOf("split-handle") < workspaceHtml.indexOf("zoom-gutter"));
  assert.match(src, /from "\.\/vendor\/pdf\.min\.mjs"/);
  assert.match(src, /GlobalWorkerOptions\.workerSrc/);
  assert.match(src, /pdf\/vendor\/pdf\.worker\.min\.mjs/);
  assert.match(src, /getDocument/);
  assert.match(src, /translatePageBlocks/);
  assert.match(libSrc, /OI_TRANSLATE_BATCH/);
  assert.equal(existsSync(join(root, "pdf/vendor/pdf.min.mjs")), true);
  assert.equal(existsSync(join(root, "pdf/vendor/pdf.worker.min.mjs")), true);
  assert.match(readFileSync(join(root, "pdf/vendor/VERSION"), "utf8"), /pdfjs-dist 4\.10\.38/);
});

test("split layout is left/right by default and stacks below 900px", () => {
  assert.match(css, /\.pdf-page canvas\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.workspace\s*\{[^}]*position:\s*relative[^}]*grid-template-columns:\s*1fr 1fr/s);
  assert.match(css, /@media \(max-width:\s*899px\)\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /@media \(max-width:\s*899px\)[\s\S]*\.zoom-gutter\s*\{[^}]*flex-direction:\s*row/);
  const zoomGutterCss = css.slice(css.indexOf(".zoom-gutter {"), css.indexOf(".zoom-gutter-btn {"));
  assert.match(zoomGutterCss, /position:\s*absolute/);
  assert.match(zoomGutterCss, /top:\s*50%/);
  assert.match(zoomGutterCss, /left:\s*50%/);
  assert.match(zoomGutterCss, /transform:\s*translate\(-50%,\s*-50%\)/);
  assert.match(zoomGutterCss, /flex-direction:\s*column/);
  assert.match(zoomGutterCss, /backdrop-filter:\s*blur\(12px\)/);
  assert.match(zoomGutterCss, /-webkit-backdrop-filter:\s*blur\(12px\)/);
  assert.equal(zoomGutterCss.includes("var(--oi-split)"), false);
  assert.match(css, /\.zoom-gutter-btn\s*\{[^}]*min-height:\s*28px[^}]*height:\s*28px[^}]*font:\s*500 12px\/1 var\(--oi-font\)/s);
  assert.match(css, /\.zoom-gutter-label\s*\{[^}]*font:\s*500 12px\/1 var\(--oi-font\)[^}]*font-variant-numeric:\s*tabular-nums/s);
  assert.equal(css.includes(".split-gutter"), false);
  assert.equal(css.includes(".zoom-stack"), false);
  assert.match(css, /\.split-handle\s*\{[^}]*top:\s*0[^}]*bottom:\s*0[^}]*width:\s*8px[^}]*cursor:\s*col-resize[^}]*z-index:\s*1/s);
  assert.match(css, /\.zoom-gutter\s*\{[^}]*z-index:\s*2/s);
  assert.equal(/\.zoom-gutter\s*\{[^}]*cursor:\s*col-resize/s.test(css), false);
  assert.match(src, /bindSplitResize/);
  assert.match(src, /startSplitDrag/);
  assert.match(src, /applySplit/);
  const splitSrc = src.slice(src.indexOf("function bindSplitResize"), src.indexOf("function startSplitDrag"));
  assert.match(splitSrc, /stopPropagation/);
  assert.equal(splitSrc.includes("setZoom"), false);
  const dragSrc = src.slice(src.indexOf("function startSplitDrag"), src.indexOf("function applySplit"));
  assert.match(dragSrc, /midBand/);
  assert.match(dragSrc, /60/);
  assert.match(html, /class="workspace"/);
  assert.match(html, /class="pane-pdf"/);
  assert.match(html, /id="pdfPane"/);
  assert.match(html, /id="pages"/);
  assert.match(html, /class="pane-translate"/);
  assert.match(html, /点击翻译/);
  assert.match(html, /id="translatePage"[^>]*disabled>翻译</);
  assert.match(html, /id="stopTranslate"[^>]*class="btn-primary"[^>]*hidden[^>]*disabled>停止</);
  assert.match(html, /id="restoreOriginal"[^>]*class="btn-ghost"[^>]*disabled>原文</);
  assert.match(html, /id="readout"[^>]*class="readout"/);
  assert.match(html, /<p id="emptyRead" class="empty-read">点击翻译<\/p>/);
  assert.match(html, /<p id="pendingRead" class="empty-read" hidden>正在翻译，请稍候…<\/p>/);
  assert.match(src, /appendReadoutNode/);
  assert.match(src, /articleNodeSpec/);
  assert.match(libSrc, /oi-pdf-h1/);
  assert.match(libSrc, /oi-pdf-h2/);
  assert.match(libSrc, /oi-pdf-p/);
  assert.equal(libSrc.includes("oi-pdf-h\""), false);
  assert.match(src, /emptyRead/);
  assert.match(src, /pendingRead/);
  assert.match(src, /readoutPlaceholder/);
  assert.match(src, /syncReadoutEmpty/);
  assert.equal(src.includes("data-favorite-block"), false);
  assert.equal(src.includes("favoriteSegment"), false);
  assert.equal(src.includes("OI_SAVE_LEARNING"), false);
  assert.equal(html.includes("data-favorite-hook"), false);
  assert.equal(html.includes("收藏"), false);
  assert.equal(css.includes(".translate-block"), false);
  assert.equal(css.includes(".translate-article"), false);
  assert.equal(css.includes(".oi-pdf-h {"), false);
  assert.match(css, /\.pane-translate\s*\{[^}]*padding:\s*20px 24px 32px/s);
  assert.match(css, /\.pane-translate \.readout\s*\{[^}]*max-width:\s*42rem/s);
  assert.match(css, /\.oi-pdf-h1\s*\{[^}]*font:\s*650 22px\/1\.3 var\(--oi-font\)/s);
  assert.match(css, /\.oi-pdf-h2\s*\{[^}]*font:\s*650 18px\/1\.35 var\(--oi-font\)/s);
  assert.match(css, /\.oi-pdf-h1:first-child,\s*\.oi-pdf-h2:first-child\s*\{\s*margin-top:\s*0/s);
  assert.match(css, /\.oi-pdf-h1 \+ \.oi-pdf-h2\s*\{\s*margin-top:\s*16px/s);
  assert.match(css, /\.oi-pdf-p\s*\{[^}]*font:\s*400 15px\/1\.7 var\(--oi-font\)/s);
  assert.match(css, /\.oi-pdf-p:last-child\s*\{\s*margin-bottom:\s*0/s);
  assert.match(css, /\.pane-translate \.empty-read\s*\{[^}]*color:\s*var\(--oi-text-muted\)/s);
  assert.match(html, /本页没有文字层|扫描件翻译将在后续版本支持/);
});

test("M2 copy covers empty / loading / error / no text layer / progress", () => {
  assert.equal(PDF_COPY.empty, "还没有打开 PDF。");
  assert.equal(PDF_COPY.loading, "正在打开 PDF…");
  assert.equal(PDF_COPY.error, "无法打开这个 PDF。");
  assert.equal(PDF_COPY.fetchFail, "无法从此地址读取 PDF，请改用本地文件。");
  assert.equal(PDF_COPY.noTextLayer, "本页没有文字层。");
  assert.equal(PDF_COPY.noTextLayerHint, "扫描件翻译将在后续版本支持。");
  assert.equal(PDF_COPY.translateHint, "点击翻译");
  assert.equal(PDF_COPY.translatingWait, "正在翻译，请稍候…");
  assert.equal(readoutPlaceholder({ running: true, hasArticle: false }), "正在翻译，请稍候…");
  assert.equal(readoutPlaceholder({ running: true, hasArticle: true }), "");
  assert.equal(readoutPlaceholder({ running: false, hasArticle: false }), "点击翻译");
  assert.equal(PDF_COPY.translate, "翻译");
  assert.equal(PDF_COPY.stop, "停止");
  assert.equal(PDF_COPY.restore, "原文");
  assert.equal(PDF_COPY.favorite, undefined);
  assert.equal(PDF_COPY.translating, "翻译中");
  assert.equal(PDF_COPY.polishing, "润色中");
  assert.equal(PDF_COPY.polishFail, "润色失败");
  assert.equal(PDF_COPY.emptyPage, "本页没有可翻译的文字。");
  assert.equal(PDF_COPY.done, "本页已翻译。");
  assert.equal(PDF_COPY.doneDocument, "全文已翻译。");
  assert.equal(PDF_COPY.scopeLabel, "范围");
  assert.equal(PDF_COPY.scopePage, "当前页");
  assert.equal(PDF_COPY.scopeDocument, "全文");
  assert.equal(PDF_COPY.stopped, "已停止。");
  assert.equal(textLayerCopy(0), PDF_COPY.noTextLayer);
  assert.equal(textLayerCopy(3), "");
  assert.equal(pageBlocksCopy(0, 0), PDF_COPY.noTextLayer);
  assert.equal(pageBlocksCopy(0, 4), PDF_COPY.emptyPage);
  assert.equal(pageBlocksCopy(2, 8), "");
  assert.equal(progressStatus(2, 9), "正在翻译第 2 / 9 段");
  assert.equal(progressDocumentStatus(3, 12), "翻译中 · 3/12");
  assert.match(src, /PDF_COPY\.fetchFail/);
  assert.match(src, /textLayerCopy/);
  assert.match(src, /pageBlocksCopy/);
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
  assert.equal(src.includes("favoriteSegment"), false);
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

function pdfItem(str, x, y, width = 120, height = 10) {
  return { str, transform: [1, 0, 0, 1, x, y], width, height };
}

function blockTexts(blocks) {
  return blocks.map((block) => block.text);
}

test("segmentPageBlocks joins lines, dehyphenates, and keeps column order", () => {
  const single = segmentPageBlocks({
    items: [
      pdfItem("The dominant sequence transduction models are based on", 72, 700, 240),
      pdfItem("complex recurrent or convolutional neural networks.", 72, 686, 220)
    ]
  });
  assert.deepEqual(blockTexts(single), [
    "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks."
  ]);
  assert.equal(single[0].role, "paragraph");

  const hyphen = segmentPageBlocks({
    items: [pdfItem("transfor-", 72, 640, 80), pdfItem("mation is all you need.", 72, 626, 160)]
  });
  assert.deepEqual(blockTexts(hyphen), ["transformation is all you need."]);

  const paper = segmentPageBlocks({
    items: [
      pdfItem("Attention Is All You Need", 72, 760, 420, 18),
      pdfItem("Abstract", 72, 730, 70, 12),
      pdfItem("The dominant sequence transduction models are based on", 72, 700, 230),
      pdfItem("complex recurrent or convolutional neural networks.", 72, 686, 210),
      pdfItem("We propose the Transformer, relying entirely on", 72, 650, 220),
      pdfItem("attention mechanisms.", 72, 636, 120),
      pdfItem("Experiments on two machine translation tasks show", 360, 700, 230),
      pdfItem("these models to be superior in quality.", 360, 686, 180)
    ]
  });
  assert.ok(paper.some((block) => /Attention Is All You Need/.test(block.text) && block.role === "title"));
  assert.ok(paper.some((block) => /dominant sequence transduction/.test(block.text)));
  assert.ok(paper.some((block) => /Transformer/.test(block.text)));
  assert.ok(paper.some((block) => /machine translation tasks/.test(block.text)));
  const leftIdx = paper.findIndex((block) => /Transformer/.test(block.text));
  const rightIdx = paper.findIndex((block) => /machine translation/.test(block.text));
  assert.ok(leftIdx >= 0 && rightIdx >= 0 && leftIdx < rightIdx);
});

test("segmentPageBlocks marks headings and keeps title with body as article parts", () => {
  const paper = segmentPageBlocks({
    items: [
      pdfItem("Attention Is All You Need", 72, 760, 420, 18),
      pdfItem("Abstract", 72, 730, 70, 12),
      pdfItem("The dominant sequence transduction models are based on", 72, 700, 230),
      pdfItem("complex recurrent or convolutional neural networks.", 72, 686, 210)
    ]
  });
  const title = paper.find((block) => /Attention Is All You Need/.test(block.text));
  const abstract = paper.find((block) => block.text === "Abstract");
  const body = paper.find((block) => /dominant sequence transduction/.test(block.text));
  assert.equal(title.role, "title");
  assert.equal(abstract.role, "heading");
  assert.equal(body.role, "paragraph");
  assert.match(body.text, /neural networks/);
  assert.equal(/Attention Is All You Need/.test(body.text), false);
  assert.equal(articleNodeSpec({ translation: "注意力机制就够了", role: "title" }).tag, "h1");
  assert.equal(articleNodeSpec({ translation: "注意力机制就够了", role: "title" }).className, "oi-pdf-h1");
  assert.equal(articleNodeSpec({ translation: "摘要", role: "heading" }).tag, "h2");
  assert.equal(articleNodeSpec({ translation: "摘要", role: "heading" }).className, "oi-pdf-h2");
  assert.equal(articleNodeSpec({ translation: "我们提出一种新架构。", role: "paragraph" }).tag, "p");
  assert.equal(articleNodeSpec({ translation: "我们提出一种新架构。", role: "paragraph" }).className, "oi-pdf-p");
  assert.deepEqual(translationBlock({ original: "Hi", page: 1, role: "title" }).role, "title");

  const wrappedTitle = segmentPageBlocks({
    items: [
      pdfItem("Attention Is All", 72, 760, 200, 18),
      pdfItem("You Need", 72, 738, 90, 18),
      pdfItem("The first sentence of the abstract continues across", 72, 700, 240, 10),
      pdfItem("two wrapped body lines without becoming a heading.", 72, 686, 220, 10)
    ]
  });
  assert.equal(wrappedTitle[0].role, "title");
  assert.equal(wrappedTitle[0].text, "Attention Is All You Need");
  assert.equal(wrappedTitle[1].role, "paragraph");
  assert.match(wrappedTitle[1].text, /first sentence of the abstract/);
  assert.match(wrappedTitle[1].text, /without becoming a heading/);

  const shout = segmentPageBlocks({
    items: [
      { ...pdfItem("INTRODUCTION", 72, 720, 140, 11), fontName: "Helvetica-Bold" },
      pdfItem("The rest of this section expands the method in several long sentences that stay body copy.", 72, 690, 280, 10)
    ]
  });
  assert.equal(shout[0].role, "heading");
  assert.equal(shout[0].text, "INTRODUCTION");
  assert.equal(shout[1].role, "paragraph");

  const bodyOnly = segmentPageBlocks({
    items: [
      pdfItem("These models to be superior in quality after a short clause.", 72, 700, 260, 10),
      pdfItem("They continue in the next line without a title cue.", 72, 686, 220, 10)
    ]
  });
  assert.ok(bodyOnly.every((block) => block.role === "paragraph"));
});

test("page cache remembers a translated page and 原文 can drop it", () => {
  const cache = createPageCache();
  assert.equal(pageCacheKey(3, 2), "3::2");
  assert.equal(cache.has(1, 1), false);
  cache.set(1, 1, [{ original: "Hello", translation: "你好" }]);
  cache.set(1, 2, [{ original: "Page 2", translation: "第 2 页" }]);
  assert.equal(cache.has(1, 1), true);
  assert.equal(cache.get(1, 1)[0].translation, "你好");
  cache.clearPage(1, 1);
  assert.equal(cache.get(1, 1), null);
  assert.equal(cache.get(1, 2)[0].translation, "第 2 页");
  cache.clear();
  assert.equal(cache.has(1, 2), false);
  const restoreSrc = src.slice(src.indexOf("/** 原文: current page only"), src.indexOf("async function openFile"));
  assert.match(restoreSrc, /pageCache\.clearPage\(docId, pageNum\)/);
  assert.equal(restoreSrc.includes("pageCache.clear()"), false);
});

test("collectArticlePages keeps page order and skips untranslated pages", () => {
  const cache = createPageCache();
  cache.set(1, 1, [{ original: "A", translation: "甲", role: "paragraph" }]);
  cache.set(1, 2, [{ original: "B", translation: "", role: "paragraph" }]);
  cache.set(1, 3, [{ original: "C", translation: "丙", role: "heading" }]);
  const pages = collectArticlePages(cache, 1, 3);
  assert.deepEqual(pages.map((entry) => entry.page), [1, 3]);
  assert.equal(pageHasTranslation(cache.get(1, 1)), true);
  assert.equal(pageHasTranslation(cache.get(1, 2)), false);
  assert.equal(pageTranslationComplete([{ original: "A", translation: "甲" }]), true);
  assert.equal(pageTranslationComplete([{ original: "A", translation: "甲" }, { original: "B", translation: "" }]), false);
  assert.equal(pageTranslationComplete([]), false);
});

test("continuous scroll helpers pick the page in view and nearby canvases", () => {
  assert.equal(
    pageFromViewport(
      [
        { page: 1, top: 0, bottom: 800 },
        { page: 2, top: 816, bottom: 1616 }
      ],
      0,
      600
    ),
    1
  );
  assert.equal(
    pageFromViewport(
      [
        { page: 1, top: -700, bottom: 100 },
        { page: 2, top: 116, bottom: 916 }
      ],
      0,
      600
    ),
    2
  );
  assert.deepEqual(neighborPages(1, 5, 2), [1, 2, 3]);
  assert.deepEqual(neighborPages(5, 5, 2), [3, 4, 5]);
  assert.deepEqual(neighborPages(3, 5, 1), [2, 3, 4]);
  assert.equal(readoutPageSelector(4), '[data-page="4"]');
  assert.equal(shouldSyncReadout(40, 40, 80), false);
  assert.equal(shouldSyncReadout(200, 40, 80), true);
  assert.equal(normalizePdfTranslateScope("all"), "all");
  assert.equal(normalizePdfTranslateScope("document"), "all");
  assert.equal(normalizePdfTranslateScope(""), "page");
  assert.equal(wheelPageDelta({ deltaY: 40, atTop: true, atBottom: true, overflow: false }), 1);
  assert.equal(wheelPageDelta({ deltaY: -40, atTop: true, atBottom: true, overflow: false }), -1);
  assert.equal(wheelPageDelta({ deltaY: 40, atTop: false, atBottom: true, overflow: true }), 0);
});

test("viewer toolbar exposes 当前页/全文 and left pane is a continuous page stack", () => {
  const pick = html.indexOf('id="pick"');
  const scope = html.indexOf("scope-seg");
  const translate = html.indexOf('id="translatePage"');
  const stop = html.indexOf('id="stopTranslate"');
  const restore = html.indexOf('id="restoreOriginal"');
  const prev = html.indexOf('id="prev"');
  assert.ok(pick > 0 && pick < scope && scope < translate && translate < stop && stop < restore && restore < prev);
  assert.match(html, /class="scope-seg"[^>]*role="group"[^>]*aria-label="翻译范围"/);
  assert.match(html, /class="scope-seg-btn is-on"[^>]*data-scope="page"[^>]*>当前页</);
  assert.match(html, /class="scope-seg-btn"[^>]*data-scope="all"[^>]*>全文</);
  assert.equal(html.includes("pdfTranslateScope"), false);
  assert.equal(html.includes("scope-field"), false);
  assert.match(html, /id="prev"[^>]*>上一页</);
  assert.match(html, /id="next"[^>]*>下一页</);
  assert.match(css, /\.scope-seg\s*\{[^}]*display:\s*inline-flex[^}]*padding:\s*2px[^}]*border:\s*1px solid var\(--oi-line\)[^}]*border-radius:\s*8px[^}]*background:\s*var\(--oi-input, var\(--oi-bg\)\)/s);
  assert.match(css, /\.scope-seg-btn\s*\{[^}]*min-height:\s*32px[^}]*padding:\s*0 12px[^}]*background:\s*transparent[^}]*color:\s*var\(--oi-text-muted\)[^}]*font:\s*500 13px\/1\.2 var\(--oi-font\)/s);
  assert.match(css, /\.scope-seg-btn:hover\s*\{[^}]*color:\s*var\(--oi-text\)[^}]*color-mix\(in srgb, var\(--oi-line\) 35%/s);
  assert.match(css, /\.scope-seg-btn\.is-on\s*\{[^}]*color-mix\(in srgb, var\(--oi-accent\) 18%[^}]*font-weight:\s*600/s);
  assert.match(css, /\.scope-seg-btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-accent\)/s);
  assert.match(css, /\.scope-seg-btn:disabled\s*\{[^}]*opacity:\s*0\.45/s);
  assert.equal(css.includes(".scope-seg.btn-primary"), false);
  assert.match(src, /setScopeEnabled\(Boolean\(pdfDoc\) && !session\.running\)/);
  assert.match(css, /\.pages\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(css, /\.pdf-page\s*\{/);
  assert.match(src, /onPdfScroll/);
  assert.match(src, /onPdfWheel/);
  assert.match(src, /wheelPageDelta/);
  assert.match(src, /onScopeClick/);
  assert.match(src, /setTranslateScope/);
  const scopeClickSrc = src.slice(src.indexOf("function onScopeClick"), src.indexOf("function setTranslateScope"));
  assert.equal(scopeClickSrc.includes("startTranslate"), false);
  assert.match(src, /scrollIntoView/);
  assert.match(src, /syncReadoutToPage/);
  assert.match(src, /dataset\.page/);
  assert.match(src, /translateWholeDocument/);
  assert.match(src, /currentScope\(\) === "all"/);
  assert.equal(src.includes('id="page"'), false);
  assert.equal(html.includes('id="page"'), false);
  const goPageSrc = src.slice(src.indexOf("async function goPage"), src.indexOf("async function setZoom"));
  assert.match(goPageSrc, /scrollIntoView/);
  assert.equal(goPageSrc.includes("abortTranslateSession"), false);
  assert.match(src, /renderArticle\(\)/);
  assert.match(src, /collectArticlePages\(pageCache/);
});

test("translatePageBlocks sends OI_TRANSLATE_BATCH slices and honors stop", async () => {
  const sent = [];
  const session = createTranslateSession();
  const out = await translatePageBlocks(["One paragraph.", "Two paragraph.", "Three paragraph."], {
    session,
    batchSize: 2,
    requestIdFor: (i) => `pdf-${i}`,
    send: async (msg) => {
      sent.push(msg);
      return { ok: true, translations: msg.texts.map((text) => `译:${text}`) };
    }
  });
  assert.equal(out.ok, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "OI_TRANSLATE_BATCH");
  assert.deepEqual(sent[0].texts, ["One paragraph.", "Two paragraph."]);
  assert.equal(sent[0].requestId, "pdf-0");
  assert.equal(out.results[2].translation, "译:Three paragraph.");
  assert.equal(out.results[0].role, "paragraph");

  const headed = await translatePageBlocks(
    [
      { text: "Attention Is All You Need", role: "title" },
      { text: "The dominant sequence transduction models are based on attention.", role: "paragraph" }
    ],
    {
      send: async (msg) => ({ ok: true, translations: msg.texts.map((text) => `译:${text}`) })
    }
  );
  assert.equal(headed.results[0].role, "title");
  assert.equal(headed.results[1].role, "paragraph");
  assert.equal(headed.results[0].translation, "译:Attention Is All You Need");

  const paused = createTranslateSession();
  const partial = await translatePageBlocks(["A", "B", "C"], {
    session: paused,
    batchSize: 1,
    send: async (msg) => {
      if (msg.texts[0] === "B") abortTranslateSession(paused);
      return { ok: true, translations: msg.texts.map((text) => `译:${text}`) };
    }
  });
  assert.equal(partial.aborted, true);
  assert.equal(partial.results[0].translation, "译:A");
  assert.equal(partial.results[1].translation, "");
  assert.equal(partial.results[2].translation, "");
});

test("translateDocumentPages walks pages via OI_TRANSLATE_BATCH and honors stop", async () => {
  const cache = createPageCache();
  cache.set(9, 1, [{ original: "P1", translation: "一", role: "paragraph" }]);
  const sent = [];
  const session = createTranslateSession();
  const out = await translateDocumentPages({
    session,
    cache,
    docId: 9,
    numPages: 3,
    batchSize: 8,
    requestIdFor: (page, index) => `pdf-${page}-${index}`,
    getPageOriginals: async (page) => [`P${page}`],
    send: async (msg) => {
      sent.push(msg);
      if (msg.texts[0] === "P2") abortTranslateSession(session);
      return { ok: true, translations: msg.texts.map((text) => `译:${text}`) };
    }
  });
  assert.equal(out.aborted, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "OI_TRANSLATE_BATCH");
  assert.deepEqual(sent[0].texts, ["P2"]);
  assert.equal(sent[0].requestId, "pdf-2-0");
  assert.equal(cache.get(9, 1)[0].translation, "一");
  assert.equal(pageHasTranslation(cache.get(9, 2)), false);
  assert.equal(cache.has(9, 3), false);

  const full = createPageCache();
  const all = [];
  const done = await translateDocumentPages({
    cache: full,
    docId: 4,
    numPages: 2,
    batchSize: 8,
    getPageOriginals: async (page) => [`Page ${page} one.`, `Page ${page} two.`],
    send: async (msg) => {
      all.push(msg.texts.slice());
      return { ok: true, translations: msg.texts.map((text) => `译:${text}`) };
    }
  });
  assert.equal(done.aborted, false);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], ["Page 1 one.", "Page 1 two."]);
  assert.deepEqual(all[1], ["Page 2 one.", "Page 2 two."]);
  assert.equal(all.some((texts) => texts.includes("Page 1 one.") && texts.includes("Page 2 one.")), false);
  assert.equal(full.get(4, 2)[1].translation, "译:Page 2 two.");
});

test("two-step draft progress replaces in place and keeps heading role", async () => {
  const session = createTranslateSession();
  session.inflight = { requestId: "pdf-0", slice: ["Hello world."], sliceStart: 0 };
  const draft = applyDraftTranslations(
    session,
    { phase: "draft", requestId: "pdf-0", translations: ["你好世界。"] },
    [{ original: "Hello world.", translation: "", role: "title" }]
  );
  assert.equal(shouldApplyDraft(session, { phase: "draft", requestId: "pdf-0" }), true);
  assert.equal(shouldApplyDraft(session, { phase: "draft", requestId: "other" }), false);
  assert.equal(draft[0].translation, "你好世界。");
  assert.equal(draft[0].role, "title");
  assert.equal(articleNodeSpec(draft[0]).tag, "h1");
  assert.equal(articleNodeSpec({ translation: "摘要", role: "heading" }).tag, "h2");
  assert.match(src, /OI_TRANSLATE_PROGRESS/);
  assert.match(src, /applyDraftTranslations/);
  assert.match(src, /applyPageProgress/);
  assert.match(src, /PDF_COPY\.polishing/);
  assert.match(src, /PDF_COPY\.polishFail/);
  assert.match(src, /restoreOriginal/);
  assert.match(src, /abortTranslateSession/);
  assert.match(src, /createPageCache/);
  assert.match(src, /segmentPageBlocks/);
  assert.match(src, /getTextContent/);
  assert.match(src, /OI_GET_SETTINGS/);
  assert.match(src, /translateDocumentPages/);
  assert.match(src, /collectArticlePages/);
  assert.match(src, /renderArticle/);
});

test("vendored pdf.js segments a multi-paragraph paper-style page", async () => {
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const data = buildPaperPdf();
  const doc = await getDocument({ data, verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const items = extractPageItems(content);
    assert.ok(items.length > 4);
    const blocks = segmentPageBlocks(content);
    assert.ok(blocks.some((block) => /Attention Is All You Need/.test(block.text)));
    assert.ok(blocks.some((block) => /sequence transduction/.test(block.text)));
    assert.ok(blocks.some((block) => block.role === "title" || block.role === "heading"));
    assert.ok(blocks.some((block) => block.role === "paragraph"));
    assert.ok(blocks.length >= 2);
  } finally {
    await doc.destroy();
  }
});

function buildPaperPdf() {
  const lines = [
    { text: "Attention Is All You Need", x: 72, y: 740, size: 18 },
    { text: "Abstract", x: 72, y: 710, size: 12 },
    { text: "The dominant sequence transduction models are based on", x: 72, y: 680, size: 10 },
    { text: "complex recurrent or convolutional neural networks.", x: 72, y: 666, size: 10 },
    { text: "We propose a new simple network architecture.", x: 72, y: 640, size: 10 },
    { text: "Experiments on two machine translation tasks show", x: 360, y: 680, size: 10 },
    { text: "these models to be superior in quality.", x: 360, y: 666, size: 10 }
  ];
  const ops = ["BT"];
  lines.forEach((line) => {
    ops.push(`/F1 ${line.size} Tf`);
    ops.push(`1 0 0 1 ${line.x} ${line.y} Tm`);
    ops.push(`(${line.text}) Tj`);
  });
  ops.push("ET");
  const stream = ops.join("\n");
  const rebuilt = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ];
  const encoder = new TextEncoder();
  const header = "%PDF-1.4\n";
  const chunks = [header];
  const offsets = [0];
  let pos = header.length;
  rebuilt.forEach((body, i) => {
    const obj = `${i + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(pos);
    chunks.push(obj);
    pos += encoder.encode(obj).length;
  });
  let xref = `xref\n0 ${rebuilt.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= rebuilt.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  chunks.push(xref, `trailer\n<< /Size ${rebuilt.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`);
  return encoder.encode(chunks.join(""));
}
