# PDF 右栏 · 公式 / 图 / 表 排版（PDF-MD-FORMULA-LAYOUT）

**任务来源：** 2026-09-23 Wisdom via Jone copy → Loom 出规格 → Forge → Cloud。  
**挂接：** [`PDF-MD-READOUT.md`](./PDF-MD-READOUT.md)（通读产品权威）。节奏数字（空隙、行内高度、密度）若与 [`high-precision/FORMULA-RIGHT-PANE.md`](./high-precision/FORMULA-RIGHT-PANE.md) 冲突，以那份 §2–§5 为准。  
**fixture：** `/workspace/oi-qa/fixtures/pdf/Attention_Is_All_You_Need.pdf`  
**反例证图：** `oi-qa/pdf-lab-attention/p07-lr-formula.png`（行内整行糊裁 + 白底大块砸版）。

---

## 1. 决策摘要

| 项 | 锁定 |
| --- | --- |
| 产品路径 | 左 **pdf.js** + 右 **Markdown 通读**（非 bbox 镜像；非 BabelDOC 矢量回写整页） |
| 公式展示 | 当前已上线的第一层是 `renderSharpVisualCrop` 的高清重渲染（`surface="redraw"`）或 pageRaster 的 png 裁图，按 `pdf/high-precision/REQUIREMENTS.md` §2.6。高清重渲染本质上是区域渲染。目标是按原字体、原位置重绘字符。不得为「好看」编造 TeX |
| 独立公式块 | 相对右栏正文列 **水平居中**；宽度 ≤ 通读列宽；上下空隙见 §3 |
| 行内公式 | **句中基线对齐**；高度随正文字号；**禁止**整行大图砸版 |
| 图 / 表 | 保持原件裁切；题注用 Soft Graphite **既有 token**（muted），**不改**网页 Soft Graphite / `tokens.css` |
| 表面 | **无**卡片、阴影、厚边框；裁切白边受控（§5） |
| 本单范围 | 只动 PDF 右栏 readout 内公式/图/表呈现；**勿**回归网页 bilingual / Options |

**否决：** 把左右半句文字一起裁进公式图；`display:block` 大白块打断段落；公式外包 `card`/`shadow`/`≥2px` 实线框；为 PDF 另起一套配色；扫描件假装矢量化。

**与旧镜像文关系：** `PDF-READOUT-MIRROR` §4.2「KaTeX 默认、裁切兜底」**不适用于**本通读轨。通读轨以 **本文 + PDF-MD-READOUT** 为准。

---

## 2. 角色与 DOM（工程师契约）

```
.readout
  h1 / h2 / p.oi-pdf-p          ← 既有通读
  figure.oi-pdf-display-math    ← 独立公式块（块级）
    img.oi-pdf-math-crop | .katex
  p … span.oi-pdf-inline-math … ← 行内公式（行内）
    img.oi-pdf-math-crop | .katex
  figure.oi-pdf-figure          ← 图 / 表原件
    img.oi-pdf-asset-crop
    figcaption.oi-pdf-caption   ← 题注译文（可选）
```

| `role` | 判定启发（工程可再精） | 容器 |
| --- | --- | --- |
| `formula-display` | 独立成行 / 居中公式 / 编号式 `(1)`；或抽取标记为 display | `figure.oi-pdf-display-math` |
| `formula-inline` | 落在句中、前后有字 | `span.oi-pdf-inline-math` |
| `figure` / `table` | XObject / 大图区 / 表栅格 | `figure.oi-pdf-figure` |
| `caption` | 「Figure / Table / 图 / 表」题注 | `figcaption.oi-pdf-caption` |

数据槽建议：`{ role, cropUrl?, latex?, alt, page, bbox? }`。当前已上线的第一层是 `renderSharpVisualCrop` 的高清重渲染（`surface="redraw"`）或 pageRaster 的 png 裁图，按 `pdf/high-precision/REQUIREMENTS.md` §2.6。尺寸与对齐仍须满足 §3–§4。不确定结构时不编造 TeX。

---

## 3. 独立公式块（display）

### 3.1 对齐与宽度

| | 规格 |
| --- | --- |
| 水平 | **居中**于 `.readout` 内容列（Attention 类论文行间式默认居中） |
| 宽度上限 | 主路径已上线：公式相对正文的缩放倍数默认 1.4×、最低 1.0×。先缩到栏宽，到最低倍数还放不下才横滚。回退路径不夹到列宽。见下一行 |
| 过宽 | 现状（已上线）分主路径和回退路径。主路径：`pdf/viewer.js` 的 `matchedFormulaStyle` 调用 `readerFormulaStyle`，再调用 `lib/pdf-formula-size.js` 的 `readerFormulaCssSize`。公式相对正文的缩放倍数默认 `DISPLAY_INK_PREFER` **1.4×**、最低 `DISPLAY_INK_HARD` **1.0×**。先缩到栏宽，到了最低倍数还放不下，才在公式框内横向滚动（F3-S4，见 `pdf/high-precision/REQUIREMENTS.md` §2.6 术语表）。`tests/pdf-formula-size.test.mjs` 锁定。不要改成占位来躲过宽。回退路径：`matchedFormulaStyle` 定不出尺寸时，`mountDisplayMath` 用 `lib/pdf-blocks.js` 的 `displayFormulaWidthCss`。这一支不缩到栏宽，宽度取页宽占比和 em 墨迹下限里较大的一个。函数注释是 "not shrunk below the ink floor"。下限来自 `displayFormulaMinEm` 和 `displayInkMinEm`。裁图是 `max-width: none`（`.pane-translate .readout.md-readout .oi-pdf-display-math .oi-pdf-math-crop`），超出部分在公式框内横向滚动。右栏纸面的横滚是 PR #90 做的，和公式框内的横滚是两件事 |
| 垂直空隙 | 阅读页（`.reader-flow`）已上线：`margin: var(--oi-reader-display-margin)`，即 `0.875em 0 1.125em`。正文默认字号 16px，所以是 14px / 18px。`.reader-flow` 外，`.oi-pdf-display-math` 才是 `margin: 10px 0 14px`。参考 Attention 原页：公式上下约一行呼吸 |
| 与邻段 | 上一 `p` 的 `margin-bottom` 与本块上边距 **取大不叠加盲加**（实现可用相邻选择器消重，避免「段尾 14px + 公式上 12px」过空） |

### 3.2 线框（ASCII）

```
| 正文段落 … …
|
|          ┌─────────────────┐     ← 无阴影；无厚框
|          │  (公式裁切/KaTeX) │     ← 墨迹紧裁；白边 ≤ §5
|          └─────────────────┘
|               （居中）
|
| 下一段正文 …
```

### 3.3 Token / CSS（目标稿，待实现）

下面整段 CSS 是目标稿，待实现。`display: inline-block`、`vertical-align: middle`、`border-radius: 2px`、`max-width: 100%` 都还没上线。

现状（已上线）：`.oi-pdf-display-math` 是 `display: block`、`text-align: center`、无描边、无阴影。阅读页 margin 是 `var(--oi-reader-display-margin)`；`.reader-flow` 外是 `margin: 10px 0 14px`。裁图 `.oi-pdf-display-math .oi-pdf-math-crop` 是 `display: block`、`height: auto`、`object-fit: contain`、无描边、无阴影。阅读列（`.pane-translate .readout.md-readout .oi-pdf-display-math .oi-pdf-math-crop`）是 `vertical-align: baseline`、`border-radius: 0`、`max-width: none`、`max-height: 2.5em`、`min-height: 0`。

```css
/* 目标稿，待实现。已上线的值写在贴片前面。 */
.oi-pdf-display-math {
  display: block;
  margin: var(--oi-reader-display-margin); /* 阅读页。页外是 10px 0 14px */
  padding: 0;
  text-align: center;
  background: transparent;
  border: none;
  box-shadow: none;
}
.oi-pdf-display-math .oi-pdf-math-crop,
.oi-pdf-display-math .katex-display {
  display: inline-block; /* 目标稿。现状是 display: block */
  max-width: 100%; /* 目标稿。现状是 max-width: none，见 §3.1 过宽行 */
  height: auto;
  vertical-align: middle; /* 目标稿。现状是 vertical-align: baseline */
  border-radius: 2px; /* 目标稿。现状是 border-radius: 0 */
  /* 禁止 box-shadow；禁止 ≥2px 实线描边 */
}
```

若白纸裁切在深色底上过跳：允许 **1px** `outline` / `border: 1px solid var(--oi-line)`，**禁止**做成 panel/card。

---

## 4. 行内公式（inline）— 本单主痛点

**目标句：**「We used the Adam optimizer with $\beta_1 = 0.9$, …」在右栏仍是 **同一自然段**，公式嵌在句中。

| | 规格 |
| --- | --- |
| 显示 | `inline-block`（或等价行内）；**禁止**把行内公式做成块级 `figure` / 整行 `img` |
| 基线 | `vertical-align: baseline` 只对回退路径成立（光学可微调 `-0.12em ~ 0`）。主路径是 `vertical-align: middle`。禁止顶对齐大块 |
| 高度 | 量测墨迹 **1.25～1.35 ×** 正文字号（硬门 ≥ **1.0×**）。盒高 = 目标墨迹 / inkShare（名义 **1.95em**，允许 ~1.9～2.2em；墨迹进带后行顶 ~1.8～2.1em）。旧盒 `1.22em`、行顶 `1.45em` 已撤：白边在盒内，不能只把 1.22 改成另一个数。（注，2026-10-04：行内墨迹 ≥ 1.0×、目标 1.25–1.35×、盒名义 1.95em 已测过、不采用，现行是固定 k=1.35，见 [INLINE-INK-MEASURE-2026-10-04.md](./high-precision/INLINE-INK-MEASURE-2026-10-04.md) 和 [FRP](./high-precision/FORMULA-RIGHT-PANE.md)。） |
| 缩放 | 裁切原图若过高 → **先紧裁再等比缩小** 落入上列；不得用放大白边撑开行距 |
| 水平 | 左右内边距 ≤ **2px**（CSS）；与邻字间距跟正文，勿额外 `margin-inline: 8px+` |
| 禁止 | 裁进邻词（反例里的 `n`）、上一行 descender、下一行 ascender；禁止「半句上、大白块、半句下」三截版 |

下面按 `viewer.css` 的现行值写。主路径和回退路径分开。

```css
/* 回退路径。容器约 L637–649，裁图约 L672–685。阅读页约 L662 把 overflow-y 改成 visible，并设高度为 --oi-pdf-inline-line-em（缺省 1.85em）。 */
.oi-pdf-inline-math {
  display: inline-block;
  vertical-align: baseline;
  margin: 0 0.2em;
  padding: 0;
  line-height: 1;
  white-space: nowrap;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  background: transparent;
  box-shadow: none;
}
.oi-pdf-inline-math .oi-pdf-math-crop {
  display: block;
  height: var(--oi-pdf-inline-crop-em, 1.95em); /* 1.95em 只是 CSS 默认值。现行代码走不到，以代码为准 */
  width: auto;
  max-width: none;
  object-fit: contain;
  object-position: left center;
  border: none;
  box-shadow: none;
  border-radius: 0;
  background: transparent;
}

/* 主路径，留在行内。容器约 L692–701，裁图约 L702–710。左右 margin 仍是上面的 0.2em。底色、圆角、描边沿用回退裁图：透明底、border-radius: 0、无描边。 */
.oi-pdf-inline-math.is-matched {
  display: inline-block;
  height: auto;
  max-height: none;
  max-width: none;
  overflow: visible;
  vertical-align: middle;
  margin-top: calc(min(0px, var(--oi-reader-inline-line-max) - var(--oi-formula-h)) / 2);
  margin-bottom: calc(min(0px, var(--oi-reader-inline-line-max) - var(--oi-formula-h)) / 2);
}
.oi-pdf-inline-math.is-matched .oi-pdf-math-crop {
  display: inline-block;
  height: var(--oi-formula-h);
  width: auto;
  max-height: none;
  max-width: none;
  margin-top: 0;
  vertical-align: middle;
}
```

**降级（仅当裁切失败）：** 行内文字兜底是目标状态，待实现：「〔公式 · 原文第 N 页〕」。屏幕上现在仍是「（公式见左栏）」。**不要**塞一整行糊图。行内高度改按墨迹 / inkShare，不再以 1.45em 当硬顶。（注，2026-10-04：行内墨迹 ≥ 1.0×、目标 1.25–1.35×、盒名义 1.95em 已测过、不采用，现行是固定 k=1.35，见 [INLINE-INK-MEASURE-2026-10-04.md](./high-precision/INLINE-INK-MEASURE-2026-10-04.md) 和 [FRP](./high-precision/FORMULA-RIGHT-PANE.md)。）行内这一小段是第一层的区域渲染，嵌在句中。

---

## 5. 裁切质量（准 > 紧，但禁糊邻）

Jone FYI：**内容精准优先，裁图宁可略松** — 松在 **公式墨迹**，不松到邻行邻词。

| 门闩 | 通过条件 |
| --- | --- |
| 保准 | 公式笔画完整；上下标不被裁切门闸切掉 |
| 禁糊邻 | bbox / 掩膜 **不得**包含可辨识邻字；允许 1～2px 抗锯齿晕 |
| 白边 | 裁切结果四边近白边 **≤ 6 CSS px**（@ 通读 100% 等效）；再松只为保准墨迹 |
| 分辨率 | ≥ **2×** 目标显示像素（Retina）；模糊放大 = FAIL |
| 掩膜 | 鼓励：墨迹连通域 / 公式 bbox 收紧，而非整行 text-line bbox |
| alt | `alt` = 源碎片或「公式」；有 `latex` 则 `data-latex` |

**反例（必须修掉）：** `p07-lr-formula.png` — 白底矩形含邻字碎片、打断「Ada…ing」、行距被砸开。

---

## 6. 图 / 表 + 题注

| | 规格 |
| --- | --- |
| 图 / 表 | **原件裁切**嵌入通读流；`max-width: 100%; height: auto` |
| 对齐 | 默认 **居中**（单栏论文图）；若原图明显通栏左齐可左齐，同一文档内一致 |
| 空隙 | `margin-block: 16px 8px`（图→题注紧）；题注下再 `12px` 接正文 |
| 题注 | `.oi-pdf-caption`：`font: 400 13px/1.45`；`color: var(--oi-text-muted)`；居中或与图同齐 |
| 表面 | 与公式相同：**无** card / shadow / 厚框；白边规则同 §5 |
| Soft Graphite | **只消费**已有 `--oi-text` / `--oi-text-muted` / `--oi-line`；**本单禁止**改 `ui/tokens.css` 与网页 Soft Graphite |

```css
.oi-pdf-figure {
  display: block;
  margin: 16px 0 12px;
  padding: 0;
  text-align: center;
  border: none;
  box-shadow: none;
  background: transparent;
}
.oi-pdf-figure .oi-pdf-asset-crop {
  max-width: 100%;
  height: auto;
  border-radius: 2px;
}
.oi-pdf-caption {
  margin: 6px 0 0;
  font: 400 13px/1.45 var(--oi-font);
  color: var(--oi-text-muted);
}
```

---

## 7. 导出 MD（与呈现一致、不强求矢量）

| 情况 | 导出 |
| --- | --- |
| 当前已发布 | 图片，或一行「见图」（`lib/pdf-blocks.js` 的 `visualBlockMarkdown`）。不是屏幕上的「（公式见左栏）」 |
| 目标状态，待实现 | 独立公式「（公式 (n) 见原文第 N 页）」；图「（图 n 见原文第 N 页）」。见 `pdf/high-precision/REQUIREMENTS.md` §2.6 |
| 有可靠 `latex` | 不在当前导出里写未经核对的 TeX。核对通过的第二层见 REQUIREMENTS §2.6 |

导出是阅读序语义，**不是**版面引擎。

---

## 8. 验收清单（Attention · 可勾选）

### 行内（主）

- [ ] Optimizer / $\beta_1=0.9$ 类句：公式在 **同一 `p` 内**，基线对齐，无整行白块砸版  
- [ ] 裁切 **无**邻词、无上下行碎字（对照 `p07-lr-formula.png` 须明显不同）  
- [ ] 行内公式显示高度约 **15～19px**，不撑开异常行距  

### 独立块

- [ ] 行间公式相对通读列 **居中**；`max-width` 不撑破  
- [ ] 上下空隙约 **12/16px** 量级，像论文而非卡片墙  
- [ ] 无 shadow、无厚框、无 panel 底  

### 图 / 表

- [ ] 原件清晰；题注 muted 13px；不改网页 Soft Graphite  

### 回归

- [ ] 通读标题/段落层级仍符合 `PDF-MD-READOUT`  
- [ ] **无**网页 Options / content 间距回归  
- [ ] 不引入 BabelDOC / AGPL 矢量回写依赖  

---

## 9. 给 Forge / Cloud 的边界

| 做 | 不做 |
| --- | --- |
| readout 内 display/inline 公式布局 + 裁切质量 | bbox 镜像回潮、#40 类 tip |
| 图/表原件 + 题注 token | 改 Soft Graphite / 网页 gloss |
| Attention 真机/截图验收 | 为好看默认幻觉 KaTeX |

**建议 tip 标题：** `pdf-md-formula-layout`（挂 `PDF-MD-FORMULA-LAYOUT.md`）。

---

## 10. 需要拍板（默认已选，冲突再问 Wisdom）

1. **独立块对齐：** 默认 **居中**（已锁）。若要一律左齐，再说一声。  
2. **KaTeX：** 可选增强；与裁切并存时以 **准** 为准（裁切可作对照源）。  
3. **白纸跳色：** 允许 1px `--oi-line`；不做反色油墨（防失真）。
