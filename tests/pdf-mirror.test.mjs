import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";

import {
  PDF_MIRROR_COPY,
  PDF_MIRROR_OPS,
  appendOperatorImages,
  bboxCenterError,
  buildMirrorLayout,
  canvasCropSource,
  clampPercentRect,
  findUncoveredRegions,
  imageRectsFromUnitCtms,
  inferPageSize,
  formulaRenderPlan,
  shouldRenderFormulaCrop,
  readingOrderMirrorItems,
  recoverFormulaLatex,
  formulaExportMarkdown,
  isMathItem,
  wrapLatexMarkdown,
  looksLikeCaption,
  looksLikeFormulaItem,
  mergeMirrorTranslations,
  unicodeMathify,
  boxesHaveInkOverlap,
  fitMirrorTextHeight,
  isMarginMirrorBox,
  isMirrorTextRole,
  itemTransformMeta,
  looksLikeSectionHeading,
  relayoutMirrorPageBoxes,
  resolveVerticalMirrorCollisions,
  pageRectToPercent,
  pdfItemToPageRect,
  percentRectToStyle,
  percentRectToTextStyle,
  sortBoxesReadingOrder,
  toMirrorItem,
  translatableMirrorUnits,
  walkImageCtms
} from "../lib/pdf-mirror.js";
import { translatePageBlocks } from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const src = readFileSync(join(root, "pdf/viewer.js"), "utf8");

function pdfItem(str, x, y, width = 120, height = 10, extra = {}) {
  return { str, transform: [1, 0, 0, 1, x, y], width, height, ...extra };
}

test("coord helpers map PDF user space onto page percent CSS", () => {
  const rect = pdfItemToPageRect({ x: 72, y: 740, width: 200, height: 18 }, 792);
  assert.deepEqual(rect, { left: 72, top: 34, width: 200, height: 18 });
  const pct = pageRectToPercent(rect, 612, 792);
  assert.ok(Math.abs(pct.left - (72 / 612) * 100) < 1e-6);
  assert.ok(Math.abs(pct.top - (34 / 792) * 100) < 1e-6);
  assert.ok(Math.abs(pct.width - (200 / 612) * 100) < 1e-6);
  const style = percentRectToStyle({ left: 10.1234, top: 4.5, width: 80, height: 6 });
  assert.equal(style.left, "10.123%");
  assert.equal(style.top, "4.5%");
  assert.equal(style.width, "80%");
  assert.equal(style.height, "6%");
  const textStyle = percentRectToTextStyle({ left: 10.1234, top: 4.5, width: 80, height: 6 });
  assert.equal(textStyle.left, "10.123%");
  assert.equal(textStyle.top, "4.5%");
  assert.equal(textStyle.width, "80%");
  assert.equal(textStyle.minHeight, "6%");
  assert.equal(textStyle.height, "auto");
  assert.equal(isMirrorTextRole("title"), true);
  assert.equal(isMirrorTextRole("authors"), true);
  assert.equal(isMirrorTextRole("heading"), true);
  assert.equal(isMirrorTextRole("paragraph"), true);
  assert.equal(isMirrorTextRole("caption"), true);
  assert.equal(isMirrorTextRole("figure"), false);
  assert.equal(fitMirrorTextHeight({ scrollHeight: 28, minHeight: 12, fontSize: 16, lineHeight: 1.3, pad: 3 }), 31);
  assert.equal(fitMirrorTextHeight({ scrollHeight: 10, minHeight: 20, fontSize: 0, pad: 3 }), 23);
  assert.ok(fitMirrorTextHeight({ scrollHeight: 10, minHeight: 10, fontSize: 14, lineHeight: 1.3, pad: 3 }) >= 10);
  assert.deepEqual(clampPercentRect({ left: -4, top: 120, width: 50, height: 10 }), {
    left: 0,
    top: 100,
    width: 50,
    height: 0
  });
  assert.deepEqual(canvasCropSource({ left: 25, top: 50, width: 25, height: 10 }, 400, 800), {
    sx: 100,
    sy: 400,
    sw: 100,
    sh: 80
  });
  assert.deepEqual(inferPageSize([], { width: 612, height: 792 }), { width: 612, height: 792 });
});

test("Attention-like page 1 keeps title / author grid / abstract as separate boxes", () => {
  const items = [
    pdfItem("Provided proper attribution is provided, this paper", 72, 770, 400, 8),
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
    pdfItem("Llion Jones", 72, 640, 70, 10),
    pdfItem("Aidan N. Gomez", 198, 640, 90, 10),
    pdfItem("Lukasz Kaiser", 324, 640, 80, 10),
    pdfItem("Google Research", 72, 626, 88, 9),
    pdfItem("University of Toronto", 198, 626, 110, 9),
    pdfItem("Google Brain", 324, 626, 72, 9),
    pdfItem("llion@google.com", 72, 612, 90, 8),
    pdfItem("aidan@cs.toronto.edu", 198, 612, 110, 8),
    pdfItem("lukaszkaiser@google.com", 324, 612, 120, 8),
    pdfItem("Illia Polosukhin", 72, 590, 90, 10),
    pdfItem("illia.polosukhin@gmail.com", 72, 576, 140, 8),
    pdfItem("Abstract", 72, 548, 70, 12, { fontName: "Helvetica-Bold" }),
    pdfItem("The dominant sequence transduction models are based on", 72, 528, 460, 10),
    pdfItem("complex recurrent or convolutional neural networks.", 72, 514, 420, 10),
    pdfItem("Introduction", 72, 470, 90, 12, { fontName: "Helvetica-Bold" }),
    pdfItem("Recurrent neural networks have been the dominant", 72, 450, 220, 10),
    pdfItem("approach in sequence modeling for years.", 72, 436, 200, 10),
    pdfItem("Convolutional models are harder to parallelize", 330, 450, 220, 10),
    pdfItem("across the sequence length.", 330, 436, 160, 10)
  ];
  const layout = buildMirrorLayout({ items }, { width: 612, height: 792 });
  assert.equal(layout.kind, "mirror");
  assert.equal(layout.itemCount, items.length);
  const texts = layout.boxes.map((box) => box.text);
  const title = layout.boxes.find((box) => /Attention Is All You Need/.test(box.text));
  assert.ok(title);
  assert.equal(title.role, "title");
  assert.ok(title.rect.top < 80);
  assert.ok(title.rect.width > 300);

  const ashish = layout.boxes.find((box) => /Ashish Vaswani/.test(box.text));
  const noam = layout.boxes.find((box) => /Noam Shazeer/.test(box.text));
  const niki = layout.boxes.find((box) => /Niki Parmar/.test(box.text));
  const jakob = layout.boxes.find((box) => /Jakob Uszkoreit/.test(box.text));
  assert.ok(ashish && noam && niki && jakob);
  assert.equal(/Noam Shazeer/.test(ashish.text), false);
  assert.equal(/Ashish Vaswani/.test(noam.text), false);
  assert.equal(ashish.role, "authors");
  assert.equal(noam.role, "authors");
  assert.match(ashish.text, /Google Brain/);
  assert.match(ashish.text, /avaswani@google.com/);
  assert.ok(noam.rect.left - (ashish.rect.left + ashish.rect.width) > 10);
  assert.ok(Math.abs(ashish.rect.top - noam.rect.top) < 8);

  const authorBoxes = layout.boxes.filter((box) => /@/.test(box.text));
  assert.ok(authorBoxes.length >= 7);
  assert.ok(authorBoxes.every((box) => box.kind === "text"));

  const abstractHead = layout.boxes.find((box) => box.text === "Abstract");
  const abstractBody = layout.boxes.find((box) => /dominant sequence transduction/.test(box.text));
  assert.ok(abstractHead);
  assert.equal(abstractHead.role, "heading");
  assert.ok(abstractBody);
  assert.ok(abstractBody.rect.top > (ashish.rect.top + ashish.rect.height));
  assert.ok(abstractBody.rect.width > 360);
  assert.match(abstractBody.text, /neural networks/);

  const leftIntro = layout.boxes.find((box) => /Recurrent neural networks/.test(box.text));
  const rightIntro = layout.boxes.find((box) => /Convolutional models/.test(box.text));
  assert.ok(leftIntro && rightIntro);
  assert.ok(rightIntro.rect.left > leftIntro.rect.left + leftIntro.rect.width * 0.5);
  assert.equal(texts.some((text) => /Ashish Vaswani.*Noam Shazeer/.test(text)), false);

  const units = translatableMirrorUnits(layout);
  assert.ok(units.length >= 8);
  assert.ok(units.every((unit) => unit.rect && unit.pageWidth === 612));
  const merged = mergeMirrorTranslations(
    layout,
    units.map((unit) => ({
      original: unit.text,
      translation: unit.text === "Attention Is All You Need" ? "注意力就是你所需要的一切" : `译:${unit.text.slice(0, 12)}`,
      role: unit.role,
      rect: unit.rect
    }))
  );
  const zhTitle = merged.find((item) => item.role === "title");
  assert.equal(zhTitle.translation, "注意力就是你所需要的一切");
  assert.ok(zhTitle.rect.top < 80);
  const titleItem = pdfItemToPageRect({ x: 96, y: 730, width: 420, height: 20 }, 792);
  assert.equal(bboxCenterError(titleItem, title.rect, 612).within, true);
  const item = toMirrorItem(title, { page: 1, translation: "注意力就是你所需要的一切" });
  assert.equal(item.role, "title");
  assert.equal(item.kind, "text");
  assert.equal(item.page, 1);
  assert.ok(item.bbox.width > 300);
});

test("scanned pages stay empty and do not invent a mirror", () => {
  const empty = buildMirrorLayout({ items: [] }, { width: 612, height: 792 });
  assert.equal(empty.kind, "empty");
  assert.deepEqual(empty.boxes, []);
  assert.deepEqual(empty.visuals, []);
  assert.deepEqual(empty.translatable, []);
  assert.equal(empty.itemCount, 0);
  assert.equal(PDF_MIRROR_COPY.scanned, "本页没有文字层，无法镜像版式。");
  assert.equal(PDF_MIRROR_COPY.caption, "版式镜像");
  assert.equal(PDF_MIRROR_COPY.viewMirror, "版式");
  assert.equal(PDF_MIRROR_COPY.viewReadout, "通读");
  assert.equal(PDF_MIRROR_COPY.figureFallback, "图（见左侧）");
  assert.equal(PDF_MIRROR_COPY.formulaFallback, "公式");
});

test("two-column boxes export left column then right", () => {
  const boxes = [
    { text: "Title", role: "title", rect: { left: 72, top: 40, width: 460, height: 20 } },
    { text: "Right top", role: "paragraph", rect: { left: 330, top: 200, width: 200, height: 40 } },
    { text: "Left top", role: "paragraph", rect: { left: 72, top: 210, width: 200, height: 40 } },
    { text: "Right bottom", role: "paragraph", rect: { left: 330, top: 400, width: 200, height: 40 } },
    { text: "Left bottom", role: "paragraph", rect: { left: 72, top: 410, width: 200, height: 40 } }
  ];
  assert.deepEqual(
    sortBoxesReadingOrder(boxes, 612).map((box) => box.text),
    ["Title", "Left top", "Left bottom", "Right top", "Right bottom"]
  );
});

test("formula-like items become LaTeX, not translation units or crop images", () => {
  assert.equal(looksLikeFormulaItem({ str: "E = mc^2", fontName: "CMMI10" }), true);
  assert.equal(looksLikeFormulaItem({ str: "Ashish Vaswani" }), false);
  assert.equal(looksLikeFormulaItem({ str: "avaswani@google.com" }), false);
  const layout = buildMirrorLayout(
    {
      items: [
        pdfItem("Attention Is All You Need", 72, 740, 400, 18),
        pdfItem("softmax(QK^T)", 220, 640, 90, 11, { fontName: "CMMI10" }),
        pdfItem("The Transformer uses this attention formula in every layer.", 72, 600, 400, 10)
      ]
    },
    { width: 612, height: 792 }
  );
  const formula = layout.boxes.find((box) => /softmax/.test(box.text));
  assert.ok(formula);
  assert.equal(formula.kind, "math");
  assert.equal(formula.role, "formula");
  assert.equal(isMathItem(formula), true);
  const plan = formulaRenderPlan(formula);
  assert.equal(plan.mode, "katex");
  assert.equal(plan.latex, "softmax(QK^{T})");
  assert.equal(plan.display, false);
  assert.equal(plan.text, "$softmax(QK^{T})$");
  assert.equal(shouldRenderFormulaCrop(formula), false);
  assert.equal(shouldRenderFormulaCrop({ kind: "math", text: "", render: { mode: "crop" } }), true);
  assert.equal(recoverFormulaLatex("softmax(QK^T)"), "softmax(QK^{T})");
  assert.equal(recoverFormulaLatex("E = mc²"), "E = mc^{2}");
  assert.equal(recoverFormulaLatex("softmax(QK^T)").includes("operatorname"), false);
  assert.equal(wrapLatexMarkdown("QK^{T}", false), "$QK^{T}$");
  assert.equal(wrapLatexMarkdown("QK^{T}", true), "$$QK^{T}$$");
  assert.equal(formulaExportMarkdown({ latex: "QK^{T}" }), "$QK^{T}$");
  assert.equal(formulaExportMarkdown({ latex: "QK^{T}", display: true }), "$$QK^{T}$$");
  assert.equal(formulaExportMarkdown({ sourceText: "QK^T" }), "QKᵀ");
  assert.equal(formulaExportMarkdown({}), "[公式]");
  assert.match(unicodeMathify("softmax(QK^T)"), /ᵀ/);
  assert.equal(looksLikeCaption("Figure 1: The Transformer."), true);
  assert.equal(looksLikeCaption("The dominant sequence"), false);
  assert.equal(
    translatableMirrorUnits(layout).some((unit) => /softmax/.test(unit.text)),
    false
  );
  assert.equal(
    layout.visuals.some((vis) => isMathItem(vis)),
    false
  );
  const item = toMirrorItem(formula, { page: 1, translation: plan.text });
  assert.equal(item.role, "formula");
  assert.equal(item.kind, "math");
  assert.equal(item.latex, "softmax(QK^{T})");
  const flow = readingOrderMirrorItems(layout, [
    { translation: "注意力就是你所需要的一切", role: "title" },
    { translation: "Transformer 在每一层使用该注意力公式。", role: "paragraph" }
  ]);
  assert.ok(flow.some((row) => row.role === "formula" && row.kind === "math" && row.latex === "softmax(QK^{T})"));
});

test("Attention interline formula stays between body lines as KaTeX LaTeX", () => {
  const layout = buildMirrorLayout(
    {
      items: [
        pdfItem("We propose the Transformer, based solely on attention.", 72, 680, 400, 10),
        pdfItem("Attention(Q, K, V) = softmax(QK^T / sqrt(d_k)) V", 96, 650, 420, 12, { fontName: "CMMI10" }),
        pdfItem("The encoder is composed of a stack of N = 6 identical layers.", 72, 620, 400, 10)
      ]
    },
    { width: 612, height: 792 }
  );
  const formula = layout.boxes.find((box) => isMathItem(box));
  const before = layout.boxes.find((box) => /We propose the Transformer/.test(box.text));
  const after = layout.boxes.find((box) => /encoder is composed/.test(box.text));
  assert.ok(formula && before && after);
  assert.equal(formula.role, "formula");
  assert.equal(formula.kind, "math");
  assert.match(formula.latex, /Attention\(Q, K, V\) = softmax\(QK\^\{T\} \/ sqrt\(d_\{k\}\)\) V/);
  assert.equal(formula.latex.includes("frac"), false);
  assert.equal(formula.latex.includes("operatorname"), false);
  assert.equal(shouldRenderFormulaCrop(formula), false);
  assert.ok(formula.rect.top > before.rect.top);
  assert.ok(after.rect.top > formula.rect.top);
  const flow = readingOrderMirrorItems(layout, [
    { translation: "我们提出仅基于注意力的 Transformer。", role: "paragraph" },
    { translation: "编码器由 N = 6 层相同层堆叠而成。", role: "paragraph" }
  ]);
  const names = flow.map((row) => row.role);
  assert.deepEqual(names, ["paragraph", "formula", "paragraph"]);
  assert.equal(flow[1].kind, "math");
  assert.match(flow[1].translation, /\$\$?Attention\(Q, K, V\) = softmax\(QK\^\{T\} \/ sqrt\(d_\{k\}\)\) V\$\$?/);
});

test("formula crop is only used when math text cannot be recovered", () => {
  const layout = buildMirrorLayout(
    {
      items: [
        pdfItem("Attention Is All You Need", 72, 740, 400, 18),
        pdfItem("\u0001\u0002\u0003\u0004\u0005", 220, 640, 90, 11, { fontName: "CMMI10" })
      ]
    },
    { width: 612, height: 792 }
  );
  const formula = layout.boxes.find((box) => isMathItem(box));
  assert.ok(formula);
  assert.equal(formula.kind, "math");
  assert.equal(formulaRenderPlan(formula).mode, "crop");
  assert.equal(shouldRenderFormulaCrop(formula), true);
  assert.ok(layout.visuals.some((vis) => isMathItem(vis)));
  assert.equal(formulaExportMarkdown({ sourceText: "" }), "[公式]");
});

test("vendored KaTeX renders recovered LaTeX and is wired into the viewer", () => {
  const katexDir = join(root, "pdf/vendor/katex");
  assert.equal(existsSync(join(katexDir, "katex.min.js")), true);
  assert.equal(existsSync(join(katexDir, "katex.min.css")), true);
  assert.equal(existsSync(join(katexDir, "fonts/KaTeX_Main-Regular.woff2")), true);
  const version = readFileSync(join(katexDir, "VERSION"), "utf8");
  assert.match(version, /katex 0\.18\.7/);
  assert.match(version, /total_kib\s+542/);
  const katex = createRequire(import.meta.url)("../pdf/vendor/katex/katex.min.js");
  const htmlMath = katex.renderToString(recoverFormulaLatex("softmax(QK^T)"), { throwOnError: false });
  assert.match(htmlMath, /katex/);
  assert.match(htmlMath, /softmax/);
  assert.match(html, /vendor\/katex\/katex\.min\.css/);
  assert.match(html, /vendor\/katex\/katex\.min\.js/);
  assert.match(src, /renderFormulaNode/);
  assert.match(src, /readingOrderMirrorItems/);
  assert.match(src, /dataset\.latex/);
  assert.match(src, /kind: \"math\"/);
});

test("uncovered interior regions and image CTMs become figure boxes", () => {
  const textRects = [
    { left: 72, top: 40, width: 460, height: 40 },
    { left: 72, top: 620, width: 460, height: 40 }
  ];
  const holes = findUncoveredRegions(textRects, 612, 792);
  assert.ok(holes.length >= 1);
  assert.ok(holes[0].width > 80);
  assert.ok(holes[0].height > 80);

  const fnArray = [
    PDF_MIRROR_OPS.save,
    PDF_MIRROR_OPS.transform,
    PDF_MIRROR_OPS.paintImageXObject,
    PDF_MIRROR_OPS.restore
  ];
  const argsArray = [[], [100, 0, 0, 80, 72, 400], ["img_p0_1"], []];
  const paints = walkImageCtms(fnArray, argsArray);
  assert.equal(paints.length, 1);
  assert.deepEqual(paints[0].ctm, [100, 0, 0, 80, 72, 400]);
  const images = imageRectsFromUnitCtms(paints, 792);
  assert.equal(images.length, 1);
  assert.ok(Math.abs(images[0].rect.left - 72) < 0.01);
  assert.ok(Math.abs(images[0].rect.width - 100) < 0.01);
  assert.ok(Math.abs(images[0].rect.height - 80) < 0.01);
  assert.ok(Math.abs(images[0].rect.top - (792 - 480)) < 0.01);
  const merged = appendOperatorImages([], images, 612, 792);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, "figure");

  const withCap = buildMirrorLayout(
    {
      items: [
        pdfItem("Attention Is All You Need", 72, 740, 400, 18),
        pdfItem("Figure 1: The Transformer architecture.", 72, 380, 280, 10),
        pdfItem("The rest of the paper discusses training details after the figure.", 72, 200, 400, 10)
      ]
    },
    { width: 612, height: 792 }
  );
  const caption = withCap.boxes.find((box) => /Figure 1/.test(box.text));
  assert.ok(caption);
  assert.equal(caption.role, "caption");
  assert.ok(withCap.visuals.some((vis) => vis.kind === "figure" && /Figure 1/.test(vis.caption || "")));
});

test("rotated pdf.js runs become tall margin strips, not wide horizontal bleed", () => {
  const meta = itemTransformMeta({
    str: "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023",
    width: 341.08,
    height: 20,
    transform: [0, 20, -20, 0, 32, 237]
  });
  assert.equal(meta.vertical, true);
  assert.ok(meta.width < 30);
  assert.ok(meta.height > 300);
  assert.ok(meta.x < 40);
  const layout = buildMirrorLayout(
    {
      items: [
        pdfItem("Attention Is All You Need", 211, 630, 188, 17),
        {
          str: "arXiv:1706.03762v7 [cs.CL] 2 Aug 2023",
          width: 341.08,
          height: 20,
          transform: [0, 20, -20, 0, 32, 237]
        },
        pdfItem("Abstract", 284, 409, 44, 12, { fontName: "Helvetica-Bold" }),
        pdfItem("The dominant sequence transduction models are based on complex recurrent networks.", 144, 381, 326, 10),
        pdfItem("We show that the Transformer generalizes well to other tasks.", 144, 239, 324, 10)
      ]
    },
    { width: 612, height: 792 }
  );
  const margin = layout.boxes.find((box) => /arXiv:1706/.test(box.text));
  const abstractHead = layout.boxes.find((box) => box.text === "Abstract");
  const abstractBody = layout.boxes.find((box) => /dominant sequence transduction/.test(box.text));
  assert.ok(margin);
  assert.equal(margin.role, "margin");
  assert.equal(margin.dir, "vertical");
  assert.ok(margin.rect.width < 40);
  assert.ok(margin.rect.height > 300);
  assert.ok(margin.rect.left < 40);
  assert.equal(/best models|Transformer generalizes/.test(margin.text), false);
  assert.ok(abstractHead);
  assert.equal(abstractHead.role, "heading");
  assert.ok(abstractBody);
  assert.equal(isMarginMirrorBox(margin, 612, 792), true);
  const bleed = boxesHaveInkOverlap(layout.boxes);
  assert.equal(
    bleed.some((hit) => /arXiv/.test(hit.a.text + hit.b.text) && /dominant|Abstract/.test(hit.a.text + hit.b.text)),
    false
  );
  const flow = readingOrderMirrorItems(
    layout,
    layout.translatable.map((unit) => ({ translation: unit.text, role: unit.role }))
  );
  const names = flow.map((row) => row.role);
  assert.ok(names.indexOf("title") < names.indexOf("heading"));
  assert.ok(names.indexOf("heading") < names.indexOf("paragraph"));
  assert.equal(flow[flow.length - 1].role, "margin");
});

test("author-row emails stay in separate grid cells", () => {
  const items = [
    pdfItem("Ashish Vaswani", 133, 549, 67, 10),
    pdfItem("Noam Shazeer", 239, 549, 62, 10),
    pdfItem("Niki Parmar", 339, 549, 58, 10),
    pdfItem("Jakob Uszkoreit", 424, 549, 73, 10),
    pdfItem("avaswani@google.com", 117, 527, 99, 10),
    pdfItem("noam@google.com", 231, 527, 78, 10),
    pdfItem("nikip@google.com", 324, 527, 84, 10),
    pdfItem("usz@google.com", 422, 527, 73, 10)
  ];
  const layout = buildMirrorLayout({ items }, { width: 612, height: 792 });
  const mails = layout.boxes.filter((box) => /@/.test(box.text));
  assert.ok(mails.length >= 4);
  assert.equal(mails.some((box) => /avaswani@google.com.*noam@google.com/.test(box.text)), false);
  const ashishMail = mails.find((box) => /avaswani@google.com/.test(box.text));
  const noamMail = mails.find((box) => /noam@google.com/.test(box.text));
  assert.ok(ashishMail && noamMail);
  assert.ok(noamMail.rect.left - (ashishMail.rect.left + ashishMail.rect.width) > 8);
  assert.ok(Math.abs(ashishMail.rect.top - noamMail.rect.top) < 8);
  assert.equal(looksLikeSectionHeading("Abstract"), true);
  assert.equal(looksLikeSectionHeading("Ashish Vaswani"), false);
});

test("CJK-grown boxes push later siblings instead of stacking ink", () => {
  const grown = [
    { role: "title", text: "注意力即一切所需", left: 72, top: 40, width: 460, height: 36, originTop: 40 },
    { role: "authors", text: "Alice", left: 80, top: 68, width: 90, height: 28, originTop: 68 },
    { role: "authors", text: "Bob", left: 220, top: 68, width: 90, height: 28, originTop: 68 },
    { role: "heading", text: "摘要", left: 260, top: 92, width: 60, height: 16, originTop: 92 },
    { role: "paragraph", text: "正文", left: 80, top: 108, width: 400, height: 40, originTop: 108 }
  ];
  const pushed = resolveVerticalMirrorCollisions(grown, { gap: 4 });
  const title = pushed.find((box) => box.role === "title");
  const alice = pushed.find((box) => box.text === "Alice");
  const bob = pushed.find((box) => box.text === "Bob");
  const heading = pushed.find((box) => box.role === "heading");
  assert.ok(alice.top >= title.top + title.height + 3);
  assert.ok(Math.abs(alice.top - bob.top) < 1);
  assert.ok(heading.top >= alice.top + alice.height + 3);
  const page = relayoutMirrorPageBoxes(grown, { pageWidth: 612, pageHeight: 200, gap: 4 });
  assert.equal(boxesHaveInkOverlap(page.boxes).length, 0);
  assert.ok(page.pageHeight >= 200);
});

test("translatePageBlocks keeps bbox fields for the mirror layer", async () => {
  const rect = { left: 96, top: 34, width: 420, height: 20 };
  const out = await translatePageBlocks(
    [{ text: "Attention Is All You Need", role: "title", kind: "text", rect, pageWidth: 612, pageHeight: 792 }],
    {
      send: async (msg) => ({ ok: true, translations: msg.texts.map(() => "注意力就是你所需要的一切") })
    }
  );
  assert.equal(out.results[0].translation, "注意力就是你所需要的一切");
  assert.deepEqual(out.results[0].rect, rect);
  assert.equal(out.results[0].pageWidth, 612);
  assert.equal(out.results[0].role, "title");
});

test("viewer wires per-page mirror stacks without touching toolbar / zoom / split", () => {
  assert.match(src, /buildMirrorLayout/);
  assert.match(src, /appendMirrorPage/);
  assert.match(src, /applyViewMode/);
  assert.match(src, /onViewSegClick/);
  assert.match(src, /shouldRenderFormulaCrop/);
  assert.match(src, /cropCanvasToDataUrl/);
  assert.match(src, /walkImageCtms/);
  assert.match(src, /highlightSourcePage/);
  assert.match(src, /onTranslateScroll/);
  assert.match(src, /formulaRenderPlan/);
  assert.match(src, /renderFormulaNode/);
  assert.match(src, /mirror-item/);
  assert.match(html, /id="mirrorPages"[^>]*class="mirror-pages"/);
  assert.match(html, /id="readout"[^>]*class="readout"/);
  assert.equal(html.includes('class="readout mirror-pages"'), false);
  const workspaceHtml = html.slice(html.indexOf('class="pane-translate"'), html.indexOf("split-handle"));
  assert.ok(workspaceHtml.indexOf('id="viewSeg"') < workspaceHtml.indexOf('id="mirrorPages"'));
  assert.ok(workspaceHtml.indexOf('id="mirrorPages"') < workspaceHtml.indexOf('id="readout"'));
  const toolbar = html.slice(html.indexOf('class="toolbar"'), html.indexOf('class="workspace"'));
  assert.equal(toolbar.includes("通读"), false);
  assert.equal(toolbar.includes("版式"), false);
  assert.equal(toolbar.includes("版式镜像"), false);
  assert.match(src, /图（见左侧）|figureFallback/);
  assert.match(html, /id="translatePage"/);
  assert.match(html, /id="stopTranslate"/);
  assert.match(html, /id="exportMd"/);
  assert.match(html, /id="exportPdf"/);
  assert.match(html, /id="zoomChip"/);
  assert.match(html, /id="mirrorZoomChip"/);
  assert.match(html, /class="split-handle"/);
  assert.match(css, /\.zoom-gutter\s*\{/);
  assert.match(css, /\.split-handle\s*\{/);
  assert.match(css, /\.view-seg\s*\{/);
  assert.match(html, /<p id="emptyRead" class="empty-read">点击翻译<\/p>/);
});

test("Attention fixture mirrors all pages without overlap or column bleed", async () => {
  const fixture = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
  assert.equal(existsSync(fixture), true);
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const data = new Uint8Array(readFileSync(fixture));
  const doc = await getDocument({ data, verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  try {
    assert.equal(doc.numPages, 15);
    const pageSummaries = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const layout = buildMirrorLayout(await page.getTextContent(), {
        width: viewport.width,
        height: viewport.height
      });
      assert.equal(layout.kind, "mirror");
      const overlaps = boxesHaveInkOverlap(layout.boxes, 40);
      assert.equal(overlaps.length, 0, `page ${n} overlaps: ${JSON.stringify(overlaps.map((hit) => [hit.a.text.slice(0, 40), hit.b.text.slice(0, 40)]))}`);
      pageSummaries.push({ n, boxes: layout.boxes, layout });
    }
    const page1 = pageSummaries[0].layout;
    const title = page1.boxes.find((box) => /Attention Is All You Need/.test(box.text));
    const abstractHead = page1.boxes.find((box) => box.text === "Abstract");
    const abstractBody = page1.boxes.find((box) => /dominant sequence transduction/.test(box.text));
    const margin = page1.boxes.find((box) => /arXiv:1706/.test(box.text));
    const ashish = page1.boxes.find((box) => /Ashish Vaswani/.test(box.text));
    const noam = page1.boxes.find((box) => /Noam Shazeer/.test(box.text));
    assert.ok(title && abstractHead && abstractBody && margin && ashish && noam);
    assert.equal(title.role, "title");
    assert.equal(abstractHead.role, "heading");
    assert.equal(margin.role, "margin");
    assert.ok(margin.rect.width < 36);
    assert.ok(margin.rect.left < 40);
    assert.equal(/dominant sequence|Abstract/.test(margin.text), false);
    assert.equal(/Ashish Vaswani/.test(noam.text), false);
    assert.ok(noam.rect.left - (ashish.rect.left + ashish.rect.width) > 8);
    const mails = page1.boxes.filter((box) => /@/.test(box.text));
    assert.ok(mails.length >= 4);
    assert.equal(mails.some((box) => (box.text.match(/@/g) || []).length > 1), false);
    const flow = readingOrderMirrorItems(
      page1,
      page1.translatable.map((unit) => ({ translation: unit.text, role: unit.role }))
    );
    const roles = flow.map((row) => row.role);
    assert.ok(roles.indexOf("title") < roles.indexOf("heading"));
    assert.ok(roles.lastIndexOf("heading") < roles.findIndex((role, i) => role === "paragraph" && /dominant/.test(flow[i].original || flow[i].translation || "")));
    assert.equal(flow[flow.length - 1].role, "margin");
    assert.match(readFileSync(join(root, "pdf/PDF-MIRROR-LAYOUT-FIDELITY.md"), "utf8"), /禁止叠墨/);
    assert.match(readFileSync(join(root, "pdf/viewer.js"), "utf8"), /relayoutMirrorPageBoxes/);
    assert.match(readFileSync(join(root, "pdf/viewer.css"), "utf8"), /writing-mode:\s*vertical-rl/);
  } finally {
    await doc.destroy();
  }
});

test("vendored pdf.js yields positioned title + body boxes", async () => {
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const data = buildPaperPdf();
  const doc = await getDocument({ data, verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const layout = buildMirrorLayout(await page.getTextContent(), {
      width: viewport.width,
      height: viewport.height
    });
    assert.equal(layout.kind, "mirror");
    const title = layout.boxes.find((box) => /Attention Is All You Need/.test(box.text));
    const body = layout.boxes.find((box) => /sequence transduction/.test(box.text));
    assert.ok(title?.rect);
    assert.ok(body?.rect);
    assert.ok(title.rect.top < body.rect.top);
    assert.equal(title.role, "title");
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
