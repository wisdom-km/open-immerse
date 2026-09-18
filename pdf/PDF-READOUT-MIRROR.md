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

### 4.1.1 CJK 不裁切

文本镜像框禁止用死高 bbox + `overflow:hidden` 裁 CJK。`.mirror-box` 文本 `overflow: visible`；`.mirror-page` 优先 `overflow: visible`；图/公式裁切 `.mirror-visual` 可 hidden。标题 `line-height` ≥ 1.25（宜 1.3）；高度随 CJK 折行长高（`height:auto` / scrollHeight / `max(srcH, fs×lh)+pad`）。长高后做同页垂直碰撞推开，禁止叠墨；作者栅分行、摘要与左侧 arXiv 条水平分开、页脚贡献说明只渲染一层。禁止靠缩小字号躲裁切。详见 `PDF-MIRROR-CJK-CLIP.md`。

## 4.2 公式

- **A（默认）**：从 PDF 文字/符号 run 回收 LaTeX → `MirrorItem.latex` → bbox 内 **KaTeX**；保留可复制源 `data-latex`。`role=formula`，`kind=math`。
- **B（仅兜底）**：无可靠 LaTeX 才页裁切，不是成功默认路径。
- **C**：占位「公式」。
- 不编造错误 TeX；宁可残缺 LaTeX 或走 B，也不幻觉公式。
- 导出 MD：A 为 `$latex$` / `$$latex$$`；否则 Unicode / `[公式]`。
- Attention 行间公式为样例。不 OCR。

## 4.3 图

裁切+题注；失败灰底+「图（见左侧）」

## 4.4 同步

左右页级滚动同步。左栏 zoom chip 缩放 PDF；右栏同款 FLOAT 芯片**独立**缩放镜像页 / 通读（`--oi-mirror-zoom`，键 `pdfMirrorZoom` + `pdfMirrorZoomChipPos`）。镜像页白底必须用深色墨水（`--oi-mirror-ink: #1a1a1a`），不得继承暗色 chrome 的浅色 `--oi-text`。详见 `PDF-MIRROR-READABILITY-ZOOM.md`。

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

`MirrorItem { id, page, role, bbox, sourceText, translation?, latex?, kind, imageUrl? }`（公式：`role=formula` `kind=math`）

pdf.js `getTextContent` + viewport + page canvas crop（图；公式仅无 LaTeX 时）。

KaTeX 0.18.7 vendored：`pdf/vendor/katex/`（`katex.min.js` + `katex.min.css` + woff2 fonts，约 542 KiB）。
