# 公式呈现：行内 / 独占，以及裁框

本轮只改进右栏怎么放公式。笔画仍来自当前打开的 PDF。不把 KaTeX、OCR 字母或 OCR LaTeX 当成公式画面。不嵌入 BabelDOC / pdf2zh。第 5 页矩阵句的中文译文不在本轮。

可借鉴的只有想法：公式保持原页字形，版面节奏靠近论文；裁图可以略松，但只为了下标和括号。

## 行内和独占

| 种类 | 怎么认 | 右栏 |
| --- | --- | --- |
| 独占 | 居中或缩进的整行公式，或带 `(n)` 的公式行。块上 `display: true`，没有 `inlineOf` | `figure.oi-pdf-display-math`，内嵌 `img.oi-pdf-math-crop`，居中，无卡片、无阴影、无厚框 |
| 行内 | 句子里的关系式。块上 `display: false`，`inlineOf` 指向宿主句 | 同一段里的 `span.oi-pdf-inline-math` > `img.oi-pdf-math-crop`，基线对齐，禁止整行糊裁 |

左缘、又短、又没有公式编号的折行（例如句末换行后的 `d_ff = 2048`）继续留在这一句里，不升成居中大图。页面上单独出现、前面没有正文的公式行仍是独占。

## 裁框

裁框从公式字形（text item）的并集开始，再加一圈很窄的边。有下标、括号或根号时，纵向可以再松一点（`FORMULA_CROP_PAD.scriptY`）。然后按内容停住：

- 相邻行的字形
- 图、表区域
- 图注，例如 `Figure 2:`

停住以后不再外扩。不要用固定的「整行加 0.01 页高」去盖住上一行正文或 Fig.2。子公式彼此也是障碍，两行显示公式不能互相吃进上下标。

过小的裁图（宽 < 24 或高 < 12 像素）仍不返回 data URL。失败时右栏写文字提示。

## 可选的字形重绘

`pdf.js` 文字项若都是公式字体，且不含 `√ ( ) ∑ ∫` 这类会伸出文字盒的符号，可以试着把这些字形从 pageRaster 上按原位置贴到一张画布。这仍是打开的那一页的像素。任何失败（没有 canvas、绘制抛错、字形不安全）都退回上面的裁框。Attention 里的子集字体名不是 CM 字体名，因此这篇论文走裁框。

## 右栏节奏

DOM 与间距以 [`pdf/PDF-MD-FORMULA-LAYOUT.md`](../PDF-MD-FORMULA-LAYOUT.md) 为准。正文段距约 `0.7em`；紧挨公式或图的段落下边距不与块上边距再叠一层。

- 独占公式：`margin: 12px 0 16px`，图 `max-width: 100%`、`height: auto`，水平居中。白边目标约 6 CSS px 以内，不为了留白去盖邻行。
- 行内公式：`max-height: 1.35em`，裁图高 `1.15em`（15px 正文上大约 15–19px 墨迹），左右 `margin: 0 1px`。裁切失败时在段内写「（公式见左栏）」。
- 图 / 表：`figure.oi-pdf-figure` + `img.oi-pdf-asset-crop`，题注 `figcaption.oi-pdf-caption`（13px、`var(--oi-text-muted)`）。只使用已有 Soft Graphite token，不改 `ui/tokens.css`。

## 本轮不改

- 默认路径仍是文字层。`:layout` OCR 不是必经路径。
- 视觉块上的 `latex` / `content` / `text` 继续丢掉。
- 第 5 页矩阵句可以仍是英文原文加裁图。
- 不改像素镜像路径，不把 Attention PDF 放进 Git。
