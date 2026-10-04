# 行内公式墨迹实测（2026-10-04）

这条只适用于行内公式，裁图路径是 `.oi-pdf-inline-math`。独立公式之前测到的墨迹与正文字号之比是 0.70–0.98，那是另一回事。这篇不改独立公式的规则。

产品负责人 Wisdom 于 2026-10-04 批准：行内公式以现行代码为准。文档里的「墨迹 ≥ 1.0× bodyFs、目标 1.25–1.35×、盒名义 1.95em」测过、不采用。bodyFs 是右栏正文字号。

## 方法

在 main@55a3dc3 上用 headless Chrome 打开阅读页，视口 1440×900，对 Attention Is All You Need 和 DPO（arXiv 2305.18290v3）的全部页面、全部 145 个行内公式量墨迹高度与正文字号之比；正文是英文原文，不翻译；字号取 14px、16px、20px。

撑行指公式把所在行撑得高出正文行盒的像素。

## 现行代码

主路径能对上左栏框时，`pdf/viewer.js` 的 `matchedFormulaStyle` 调用 `readerFormulaStyle`，再调用 `lib/pdf-formula-size.js` 的 `readerFormulaCssSize`。留在行内的裁图固定放大 k=1.35（`INLINE_CROP_K`）。升级看的是估算高度，不是像素墨迹。`pdf/viewer.js` 约第 1982 行用左栏 bbox 算出 `inkPt`（高度占页高的分数乘页高，单位 pt）。`inlineCropRaises` 再乘上正文字号相对源正文的倍数和 k。估算高度（bbox 高 × k）超过 2.2em（`INLINE_LINE_BOX_EM`），或裁图宽大于栏宽加 0.5px，或下标低于 7px（`SCRIPT_INK_MIN_PX`）时，升级成独立公式。主路径里留在行内的样式在 `viewer.css` 约第 692–701 行：`max-width: none`，`overflow: visible`，`vertical-align: middle`。高度超过 `--oi-reader-inline-line-max`（2.2em）时，上下 margin 为负，各承担超出量的一半。回退路径的容器是 `max-width: 100%`，`vertical-align: baseline`，超宽在框内横滚。

对不上左栏框时走回退。`pdf/viewer.js` 第 1706–1707 行把 `--oi-pdf-inline-crop-em` 和 `--oi-pdf-inline-line-em` 都写成 `INLINE_BODY_HARD_MAX`，也就是 1.4em。这两个变量的 CSS 缺省不一样：`--oi-pdf-inline-crop-em` 缺省是 1.95em（`viewer.css` 约第 675 行），`--oi-pdf-inline-line-em` 缺省是 1.85em（约第 664 行和第 676 行）。主路径的高度来自 `--oi-formula-h`，回退路径把两个变量都写成 1.4em，阅读器走不到这两个缺省。尺寸以代码为准。

`lib/pdf-text-layer.js` 里仍有 `INLINE_INK_TARGET`（1.30）和 `inlineCropBoxEm`，按墨迹占比反推盒高，名义盒约 1.95em。阅读器的裁图尺寸来自 `readerFormulaCssSize`。`inlineCropBoxEm` 留给测试和旧的盒高计算。

## 比值

三档都量了全部 145 个。16px 的比值最小 0.62，p10 是 0.88，中位 1.19，p90 是 2.03，最大 3.50。14px 的中位是 1.21，20px 的中位是 1.24。20px 档有 1 个超出版心（DPO p18-b19，宽 588px，版心 576px）。

## 路径

| 去向 | 个数 | 占比 |
| --- | --- | --- |
| 主路径，留在行内 | 121 | 83% |
| 升级成独立块 | 24 | 17% |
| 回退 | 0 | 0 |

裁切 0 个，横向滚动 0 个。

## 低于 1.0 的公式

145 个里有 19 个（13%）低于 1.0。几乎都是单变量或短式：π_ref 有 11 个，其余是 −∞、花体 D 加等号、y_1…y_K（2 个）、1e-6（2 个）、warmup_steps、k = n。这些式子盒高只有 1.1–1.9em，以小写高度的字形为主，和整行正文字号比会偏低。按 x-height 比其实更大。比值 0.75 的 π_ref，墨迹是 12px；16px 正文的小写 x 只有 8px。

## 按旧目标改会更差

比较对象是主路径那 121 个。做法是注入 CSS 变量 `--oi-formula-h` 做实际渲染，结果和事先的计算一致。

| 方案 | 16px 上的结果 |
| --- | --- |
| 只放大不足 1.0× 的 | 撑行超过 2px 的从 8 个增加到 13 个 |
| 放到至少 1.25× | 要放大 74/121（61%）。撑行超过 2px 的增加到 24 个，其中 6 个超过 2.2em，会升级成块，或压到上下行 |
| 严格等于 1.0× | 要缩小 96/121，整体变差 |

## 相邻行碎片

约 43%（63/145）是 16px 档按启发式判据数出来的，判的是裁图有没有混进相邻行的碎片。14px 档是 42.1%，20px 档是 45.5%。现有 8 个撑行里 5 个带碎片。只放大到 ≥ 1.0× 时新增的 5 个全带碎片。放到 ≥ 1.25× 时新增的 16 个里 8 个带碎片。超过 2.2em 的 6 个里 5 个带碎片。Attention 第 5 页的 −∞，去掉碎片是 0.62，带碎片是 1.38。

## 14px 档的小下标

14px 档有 37 个公式，每个公式的下标墨迹中位数低于 7px。按最小值计是 55 个。这 37 个里，主路径 30 个，已经升级成块的 7 个。代码按 bbox 估计下标，估得偏大。没有因此升级的，是主路径那 30 个。

## 局限

只测了两篇论文，DPO 占 77%。没有上真机。没有中文译文。

## 证据

证据不在本仓库。原文在 Anvil 机器上的 `/workspace/oi-qa/inline-ink-55a3dc3/summary.md`。
