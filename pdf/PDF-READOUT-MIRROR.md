# PDF 右栏 · 版式全镜像（PDF-READOUT-MIRROR）

拍板：全镜像 V3，不要仅语义通读。样例：Attention Is All You Need / arXiv 1706.03762。

## 1 决策

- 按页镜像；块级归一化 bbox（近似）
- 公式：文本/LaTeX 渲染；否则页裁切切片+alt
- 图：内嵌裁切+题注；点击可同步左栏
- 默认镜像替换通读；通读可次级
- 导出读阅读序内容非像素排版

否决：仅通读无坐标；公式只「见左侧」无切片；扫描件假装镜像

## 2 IA

`.pane-translate > .mirror-pages > .mirror-page[data-page] > .mirror-item[data-role][data-bbox]`

可选 `.readout` 次级。当前页译填当前 mirror-page；全文按页追加。

## 4.1 BBox

坐标系 PDF 页归一化→CSS%；原子=合并 text run 块；精度中心偏差≤页宽 3% 或 12px；双栏阅读序；缩放等比重算；数据 `{page,role,bbox,sourceText,translation?,imageRef?}`

验收 Attention 首页标题/作者/摘要一眼同构

## 4.2 公式

A 从文字层回收 LaTeX（或 Unicode→LaTeX）写入 MirrorItem / 译文 / Markdown，KaTeX 渲染 `$...$` / `$$...$$` → B 无公式文本才页裁切 → C 占位「公式」；不做 OCR。导出 MD 必须可粘贴进支持 KaTeX/MathJax 的编辑器。

## 4.3 图

裁切+题注；失败灰底+「图（见左侧）」

## 4.4 同步

左右页级滚动同步；zoom chip 左栏

## 4.5 导出

默认镜像；导出 MD/PDF 阅读序；「原文」清当前页译文

## 4.6

只建已译页；>200 items 合并行；无文本层提示

## 5 文案

公式 / 图（见左侧）/ 版式|通读

## 6 总验收

Attention：4.1–4.5 + 无文本层 + 不回归译停导出缩放

## 7 里程碑

M3a 文本 bbox → M3b 图 → M3c 公式 → M3d 同步+导出

本 PR 优先 M3a 可演示（作者栏位置像）。

## 8 类型

`MirrorItem { id, page, role, bbox, sourceText, translation?, latex?, kind, imageUrl? }`

pdf.js `getTextContent` + viewport + page canvas crop（图；公式仅无 LaTeX 时）。

KaTeX 0.18.7 vendored：`pdf/vendor/katex/`（`katex.min.js` + `katex.min.css` + woff2 fonts，约 542 KiB）。
