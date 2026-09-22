import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";

import {
  PDF_COPY,
  DEFAULT_PDF_VIEW,
  articleNodeSpec,
  pageHasTranslation,
  pageTranslationComplete,
  segmentPageBlocks
} from "../lib/pdf-viewer.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import {
  collapseAuthorBlocks,
  extractReadoutBlocks,
  isArxivMarginItem,
  isArxivStampText,
  isPageChromeItem,
  isPageChromeText,
  looksLikeAuthorLine,
  looksLikeFormulaText,
  mergeReadoutTranslations,
  readoutBlocksToMarkdown,
  readoutFlowForPage,
  readoutHasBboxLayout,
  translatableReadoutUnits
} from "../lib/pdf-readout.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const src = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const spec = readFileSync(join(root, "pdf/PDF-MD-READOUT.md"), "utf8");
const popupHtml = readFileSync(join(root, "popup/popup.html"), "utf8");
const popupJs = readFileSync(join(root, "popup/popup.js"), "utf8");
const contrib = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const readmeEn = readFileSync(join(root, "README.en.md"), "utf8");

function pdfItem(str, x, y, width = 120, height = 10, extra = {}) {
  return { str, transform: [1, 0, 0, 1, x, y], width, height, ...extra };
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

function attentionItems() {
  const arxivSpine = [..."arXiv:1706.03762"].map((ch, index) => pdfItem(ch, 10, 720 - index * 12, 8, 9));
  return [
    pdfItem("Provided proper attribution is provided, this paper", 72, 770, 400, 8),
    ...arxivSpine,
    pdfItem("Attention Is All You Need", 96, 730, 420, 20),
    pdfItem("Ashish Vaswani", 72, 690, 90, 10),
    pdfItem("Noam Shazeer", 198, 690, 86, 10),
    pdfItem("Niki Parmar", 324, 690, 78, 10),
    pdfItem("Jakob Uszkoreit", 450, 690, 96, 10),
    pdfItem("Google Brain", 72, 676, 72, 9),
    pdfItem("Google Brain", 198, 676, 72, 9),
    pdfItem("Google Research", 324, 676, 88, 9),
    pdfItem("Google Research", 450, 676, 88, 9),
    pdfItem("avaswani@google.com", 72, 662, 100, 8),
    pdfItem("noam@google.com", 198, 662, 90, 8),
    pdfItem("nikip@google.com", 324, 662, 90, 8),
    pdfItem("usz@google.com", 450, 662, 80, 8),
    pdfItem("Abstract", 72, 548, 70, 12, { fontName: "Helvetica-Bold" }),
    pdfItem("The dominant sequence transduction models are based on", 72, 528, 230, 10),
    pdfItem("complex recurrent or convolutional neural networks.", 72, 514, 210, 10),
    pdfItem("We propose the Transformer, relying entirely on", 72, 480, 220, 10),
    pdfItem("attention mechanisms.", 72, 466, 120, 10),
    pdfItem("Experiments on two machine translation tasks show", 360, 528, 230, 10),
    pdfItem("these models to be superior in quality.", 360, 514, 180, 10),
    pdfItem("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023", 72, 18, 260, 8),
    pdfItem("1", 300, 12, 10, 8)
  ];
}

test("PDF-MD-READOUT spec locks reading-flow, not bbox mirror", () => {
  const draft = readFileSync(join(root, "pdf/PDF-READOUT-MARKDOWN.md"), "utf8");
  assert.match(spec, /PDF-MD-READOUT/);
  assert.match(spec, /本单权威规格/);
  assert.match(spec, /阅读序/);
  assert.match(spec, /Markdown/);
  assert.match(spec, /\.readout/);
  assert.match(spec, /#40 closed/);
  assert.match(spec, /bbox/);
  assert.match(spec, /Attention_Is_All_You_Need|Attention Is All You Need/);
  assert.match(spec, /PDF-ENTRY-SECONDARY.*本轨作废|本轨不做[\s\S]*PDF-ENTRY-SECONDARY/);
  assert.match(spec, /勿回归[\s\S]*网页 content\/Options|网页 content\/Options/);
  assert.match(spec, /PDF-READOUT-MARKDOWN\.md[\s\S]*以 \*\*本文\*\* 为准/);
  assert.match(spec, /右栏使用原页裁图/);
  assert.match(spec, /pageRaster/);
  assert.match(spec, /内容精准第一/);
  assert.match(spec, /排版第二/);
  assert.match(spec, /译文跟抽出的原文一致/);
  assert.match(spec, /同一套内容/);
  assert.match(spec, /同一条验收/);
  assert.match(spec, /不上屏/);
  assert.match(spec, /文字层原句/);
  assert.match(spec, /译文只出现在右栏/);
  assert.match(spec, /高亮对齐/);
  assert.match(spec, /智谱 GLM-OCR/);
  assert.match(spec, /OCR API/);
  assert.match(spec, /Issue #40 保持关闭/);
  assert.equal(existsSync(join(root, "pdf/PDF-MD-READOUT.md")), true);
  assert.equal(existsSync(join(root, "pdf/PDF-READOUT-MARKDOWN.md")), true);
  assert.match(draft, /草稿|指针/);
  assert.match(draft, /不是本单权威/);
  assert.match(draft, /PDF-MD-READOUT\.md/);
  assert.doesNotMatch(draft, /权威 · 右栏产品/);
  assert.equal(DEFAULT_PDF_VIEW, "readout");
  assert.match(src, /let viewMode = "readout"/);
  assert.match(src, /extractReadoutBlocks/);
  assert.match(src, /readoutFlowForPage/);
  assert.doesNotMatch(src, /buildMirrorLayout/);
  assert.doesNotMatch(src, /appendMirrorPage/);
  assert.doesNotMatch(src, /percentRectToTextStyle/);
  assert.doesNotMatch(src, /function appendMirrorPage/);
  assert.match(html, /id="readout"[^>]*class="readout md-readout"/);
  assert.match(html, /id="viewSeg"[^>]*hidden/);
  assert.match(html, /id="mirrorPages"[^>]*hidden/);
  assert.match(css, /\.pane-translate \.readout\.md-readout > \*\s*\{[^}]*position:\s*static/s);
  assert.match(css, /\.pane-translate \.readout \.oi-pdf-p\[data-role="authors"\]/);
  assert.equal(readoutHasBboxLayout({ style: { position: "static" }, classList: { contains: () => false }, dataset: {} }), false);
  assert.equal(readoutHasBboxLayout({ style: { position: "absolute" }, dataset: { bbox: "1,2,3,4" } }), true);
});

test("chrome filter drops page numbers, arXiv footers, and permission headers", () => {
  assert.equal(isPageChromeText("12"), true);
  assert.equal(isPageChromeText("— 3 —"), true);
  assert.equal(isPageChromeText("arXiv:1706.03762v7 [cs.CL] 2 Aug 2023"), true);
  assert.equal(isArxivStampText("a r X i v : 1 7 0 6 . 0 3 7 6 2"), true);
  assert.equal(isArxivMarginItem({ str: "a", x: 8, y: 400, height: 8 }, { width: 612, height: 792 }), true);
  assert.equal(isArxivMarginItem({ str: "The", x: 72, y: 500, height: 10 }, { width: 612, height: 792 }), false);
  assert.equal(isPageChromeText("Provided proper attribution is provided, this paper"), true);
  assert.equal(isPageChromeText("Attention Is All You Need"), false);
  assert.equal(isPageChromeText("The dominant sequence transduction models are based on"), false);
  assert.equal(
    isPageChromeItem({ str: "NIPS 2017", y: 780, height: 8, width: 80 }, { height: 792 }),
    true
  );
  assert.equal(
    isPageChromeItem({ str: "Attention Is All You Need", y: 730, height: 20, width: 420 }, { height: 792 }),
    false
  );
});

test("Attention-like page becomes title + byline + abstract flow, not author grid", () => {
  const blocks = extractReadoutBlocks(attentionItems(), { width: 612, height: 792 });
  const title = blocks.find((block) => block.role === "title");
  const authors = blocks.find((block) => block.role === "authors");
  const abstract = blocks.find((block) => block.role === "heading" && /abstract/i.test(block.text));
  const leftBody = blocks.find((block) => /Transformer/.test(block.text));
  const rightBody = blocks.find((block) => /machine translation/.test(block.text));
  assert.equal(title.text, "Attention Is All You Need");
  assert.ok(authors, "author cells collapse into one byline");
  assert.match(authors.text, /Ashish Vaswani/);
  assert.match(authors.text, /Noam Shazeer/);
  assert.equal(blocks.filter((block) => block.role === "authors").length, 1);
  assert.ok(!blocks.some((block) => /provided proper attribution/i.test(block.text)));
  assert.ok(!blocks.some((block) => /arXiv:1706/.test(block.text)));
  assert.ok(!blocks.some((block) => /arxiv/i.test(block.text)));
  assert.ok(!blocks.some((block) => block.text === "1"));
  assert.equal(abstract.role, "heading");
  assert.ok(leftBody);
  assert.ok(rightBody);
  assert.ok(blocks.indexOf(leftBody) < blocks.indexOf(rightBody));
  assert.ok(!blocks.some((block) => block.rect && block.role === "authors"));

  const md = readoutBlocksToMarkdown(
    mergeReadoutTranslations(blocks, [
      { translation: "注意力就是你所需要的一切", role: "title" },
      { translation: "阿希什·瓦萨瓦尼 · 诺姆·沙泽尔", role: "authors" },
      { translation: "摘要", role: "heading" },
      { translation: "主流序列转导模型基于循环或卷积网络。", role: "paragraph" },
      { translation: "我们提出完全依赖注意力的 Transformer。", role: "paragraph" },
      { translation: "机器翻译实验显示这些模型质量更好。", role: "paragraph" }
    ])
  );
  assert.match(md, /^# 注意力就是你所需要的一切/m);
  assert.match(md, /阿希什·瓦萨瓦尼/);
  assert.match(md, /^## 摘要/m);
  assert.doesNotMatch(md, /arXiv/);
  assert.doesNotMatch(md, /provided proper attribution/i);
});

test("formulas stay in reading order as page crops, not LaTeX", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("The attention function can be described as", 72, 680, 360, 10),
      pdfItem("Attention(Q, K, V) = softmax(QK^T / sqrt(d_k)) V", 96, 650, 420, 12, { fontName: "CMMI10" }),
      pdfItem("where the queries come from the previous layer.", 72, 620, 360, 10)
    ],
    viewport: unitViewport(612, 792),
    page: 1
  });
  const formula = page.blocks.find((block) => block.label === "formula" || block.role === "formula");
  assert.ok(formula);
  assert.equal(Object.hasOwn(formula, "latex"), false);
  assert.equal(Object.hasOwn(formula, "text"), false);
  assert.ok(Array.isArray(formula.bbox) && formula.bbox.length === 4);
  const units = page.blocks.filter((block) => block.text && block.label !== "formula" && block.label !== "figure");
  assert.equal(units.some((unit) => /softmax/.test(unit.text || "")), false);
  assert.equal(pageHasTranslation([{ role: "paragraph", translation: "注意力函数可以写成" }]), true);
  assert.equal(pageHasTranslation([{ role: "formula", translation: "$$x$$" }]), false);
  assert.equal(pageTranslationComplete([{ role: "formula", translation: "$$x$$" }, { role: "paragraph", translation: "" }]), false);
  assert.equal(looksLikeFormulaText("Attention(Q, K, V) = softmax(QK^T / sqrt(d_k)) V", "CMMI10"), true);
  assert.equal(looksLikeAuthorLine("Ashish Vaswani"), true);
  assert.equal(looksLikeAuthorLine("The dominant sequence transduction models are based on"), false);
});

test("viewer default right pane is Markdown readout without bbox wiring", () => {
  assert.match(html, /无法提取阅读文本/);
  assert.doesNotMatch(html, /无法镜像版式/);
  assert.equal(PDF_COPY.noTextLayerHint, "本页没有文字层，无法提取阅读文本。扫描件翻译将在后续版本支持。");
  assert.match(PDF_COPY.readoutHint, /Markdown/);
  assert.equal(articleNodeSpec({ translation: "阿希什·瓦萨瓦尼", role: "authors" }).tag, "p");
  const append = src.slice(src.indexOf("function appendReadoutNode"), src.indexOf("function renderFormulaNode"));
  assert.doesNotMatch(append, /percentRectToTextStyle|dataset\.bbox|mirror-box/);
  assert.match(src, /applyViewMode\(\)/);
  assert.match(src, /viewMode = "readout"/);
  assert.match(contrib, /右侧默认\*\*Markdown 通读\*\*|右侧默认 Markdown 通读|阅读顺序/);
  assert.match(contrib, /原页裁图/);
  assert.match(contrib, /画面不来自 LaTeX 渲染/);
  assert.match(readme, /Markdown 通读|阅读顺序/);
  assert.doesNotMatch(readme, /右栏默认按 bbox \*\*版式镜像\*\*/);
  assert.match(readme, /实验室功能：默认关闭|PDF 阅读（实验室）/);
  assert.match(readme, /设置 → 高级/);
  assert.match(readme, /OCR API/);
  assert.match(readme, /原页内容精准展示（默认裁图）/);
  assert.match(readme, /公式画面不来自 LaTeX 渲染/);
  assert.match(readme, /docs\/screenshots\/01-bilingual-page\.png/);
  assert.match(readme, /docs\/screenshots\/06-pdf-readout\.png/);
  assert.match(readme, /开启实验室 PDF 后/);
  assert.equal(existsSync(join(root, "docs/screenshots/01-bilingual-page.png")), true);
  assert.equal(existsSync(join(root, "docs/screenshots/03-options-engine.png")), true);
  assert.equal(existsSync(join(root, "docs/screenshots/05-popup.png")), true);
  assert.equal(existsSync(join(root, "docs/screenshots/06-pdf-readout.png")), true);
  assert.match(readme, /文字层原句/);
  assert.match(readme, /译文只在右栏|译文只出现在右栏/);
  assert.match(readmeEn, /Markdown reading-flow|reading order/i);
  assert.match(readmeEn, /off by default/i);
  assert.match(readmeEn, /Settings → Advanced/);
  assert.match(readmeEn, /OCR API/i);
  assert.match(readmeEn, /content-accurate original-page display \(crops by default\)/i);
  assert.match(readmeEn, /formula images do not come from LaTeX/i);
  assert.match(readmeEn, /after enabling lab PDF/i);
  assert.match(readmeEn, /text-layer body/i);
  assert.match(popupHtml, /id="openPdfPage"[^>]*>PDF</);
  assert.match(popupHtml, /id="openPdfPage"[^>]*\bhidden\b/);
  assert.match(popupJs, /page: "pdf"/);
  assert.match(popupJs, /featureOn\(settings,\s*"pdf"\)/);
  assert.match(popupJs, /\$\("openPdfPage"\)\.hidden = !pdfOn/);
});

test("vendored pdf.js Attention-style page yields readable MD, not bbox boxes", async () => {
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const data = buildPaperPdf();
  const doc = await getDocument({ data, verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const blocks = extractReadoutBlocks(await page.getTextContent(), {
      width: viewport.width,
      height: viewport.height
    });
    assert.ok(blocks.some((block) => /Attention Is All You Need/.test(block.text) && block.role === "title"));
    assert.ok(blocks.some((block) => /sequence transduction/.test(block.text)));
    const flow = readoutFlowForPage(
      { kind: "readout", blocks },
      blocks.map((block) => ({
        ...block,
        translation: block.role === "title" ? "注意力就是你所需要的一切" : `译:${block.text.slice(0, 12)}`
      }))
    );
    const md = readoutBlocksToMarkdown(flow);
    assert.match(md, /^# 注意力就是你所需要的一切/m);
    assert.doesNotMatch(md, /author-grid|bbox/i);
    assert.equal(segmentPageBlocks(await page.getTextContent()).length >= 2, true);
  } finally {
    await doc.destroy();
  }
});

test("collapseAuthorBlocks keeps title then a single byline", () => {
  const out = collapseAuthorBlocks([
    { text: "Attention Is All You Need", role: "title" },
    { text: "Ashish Vaswani", role: "paragraph" },
    { text: "Google Brain", role: "paragraph" },
    { text: "Abstract", role: "heading" }
  ]);
  assert.equal(out[0].role, "title");
  assert.equal(out[1].role, "authors");
  assert.match(out[1].text, /Ashish Vaswani/);
  assert.match(out[1].text, /Google Brain/);
  assert.equal(out[2].role, "heading");
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
