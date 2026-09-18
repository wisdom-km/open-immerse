# PDF 右栏 · Markdown 通读（PDF-MD-READOUT）

拍板：右栏是阅读顺序的译文文档，不是像素 / bbox 镜像。样例：Attention Is All You Need / arXiv 1706.03762。

几何镜像（`PDF-READOUT-MIRROR`、PR#40 未合并路径）废弃，不要复活作者格重叠或 arXiv 贯穿摘要。

**不**做 ENTRY-SECONDARY hide：弹层底部 **PDF** 入口保持可见，供打开本阅读器。网页双语仍是主产品。

## 1 决策

- 左栏：pdf.js 原页，视觉不变
- 右栏：按阅读序抽出标题 + 正文 → 译成目标语言 → 渲染成可滚动 Markdown 文档（Obsidian / vibe-reading / PDFRead）
- 双栏论文：先左栏后右栏
- 页眉 / 页脚 / 页码尽量滤掉
- 图：跳过、链接或占位，不裁切原页当主路径
- 公式：能回收则 LaTeX / KaTeX；否则留源文本或「公式」占位，不以切图为主
- 无文字层不编造正文
- PDF 走弹层底部入口或「在沉浸译中打开」——不要藏掉该入口

否决：bbox 就位、作者网格墨水挤压、把页眉页码译进正文、隐藏弹层 PDF 入口。

## 2 IA

`.pane-translate > .readout.md-readout > (h1.title | p.authors | h2 | p | .oi-pdf-math)`

无「版式 | 通读」主切换。当前页译填当前文流；全文按页追加。导出读同一阅读序。

## 3 抽取

文字层 `getTextContent` → 滤页眉页脚页码 → 行聚合 / 断词拼接 → 阅读序块：

`ReadoutBlock { page, role, text, translation?, latex?, kind, display? }`

`role`：title / authors / heading / paragraph / caption / formula / figure

作者格合并成一条 byline，不按单元格绝对定位。

## 4 渲染

- title → `#` / `h1.oi-pdf-h1`
- heading → `##` / `h2.oi-pdf-h2`
- authors → 一行淡色 byline
- body / caption → 段落
- formula → `$latex$` / `$$latex$$`，能渲染则 KaTeX
- figure → 可省略或「［图］」

禁止 `position:absolute` + 页百分比 bbox 排译文。

## 5 文案

点击翻译 / 正在翻译，请稍候… / 本页没有文字层，无法提取阅读文本。

## 6 验收

Attention 首页：右栏先见译后标题，再作者行，再摘要与正文；不重叠、不把页眉译进标题。左栏仍是原 PDF。弹层底部仍有 **PDF**。
