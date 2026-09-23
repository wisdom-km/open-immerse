# PDF 右栏 · 公式 / 图 / 表 排版（PDF-MD-FORMULA-LAYOUT）

**任务来源：** 2026-09-23 Wisdom via Jone copy → Loom 出规格 → Forge → Cloud。  
**挂接：** [`PDF-MD-READOUT.md`](./PDF-MD-READOUT.md)（通读产品权威）；通读皮肤数字仍见 [`PDF-RIGHT-PANE.md`](./PDF-RIGHT-PANE.md)。节奏数字（空隙、行内高度、密度）若与 `pdf/high-precision/FORMULA-RIGHT-PANE.md` 冲突，以那份 §2–§5 为准。  
**fixture：** `/workspace/oi-qa/fixtures/pdf/Attention_Is_All_You_Need.pdf`  
**反例证图：** `oi-qa/pdf-lab-attention/p07-lr-formula.png`（行内整行糊裁 + 白底大块砸版）。

---

## 1. 决策摘要

| 项 | 锁定 |
| --- | --- |
| 产品路径 | 左 **pdf.js** + 右 **Markdown 通读**（非 bbox 镜像；非 BabelDOC 矢量回写整页） |
| 公式展示 | **原件为准** → 默认 **页渲染裁切**（保准）；可靠 LaTeX + KaTeX 为可选增强，**不得**为「好看」编造 TeX |
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

数据槽建议：`{ role, cropUrl?, latex?, alt, page, bbox? }`。有可靠 `latex` 时可渲染 KaTeX，**仍须**满足 §3–§4 尺寸与对齐；不确定结构 → **只走裁切**，禁止幻觉 TeX。

---

## 3. 独立公式块（display）

### 3.1 对齐与宽度

| | 规格 |
| --- | --- |
| 水平 | **居中**于 `.readout` 内容列（Attention 类论文行间式默认居中） |
| 宽度上限 | `max-width: 100%`（列宽即 `PDF-RIGHT-PANE` 的 `.readout`，约 `42rem`） |
| 过宽 | **等比缩小**至列宽；勿横向撑破通读；缩小后墨迹高度仍 ≥ **14px**（否则改「（公式见左栏）」+ 聚焦左栏） |
| 垂直空隙 | `margin-block: 12px 16px`（约 **0.8em / 1.05em** @ 15px 正文）；参考 Attention 原页：公式上下约一行呼吸，**不要**叠成两段正文间距 |
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

### 3.3 Token / CSS（可落地）

```css
.oi-pdf-display-math {
  display: block;
  margin: 12px 0 16px;
  padding: 0;
  text-align: center;
  background: transparent;
  border: none;
  box-shadow: none;
}
.oi-pdf-display-math .oi-pdf-math-crop,
.oi-pdf-display-math .katex-display {
  display: inline-block;
  max-width: 100%;
  height: auto;
  vertical-align: middle;
  border-radius: 2px; /* 可选；勿 >4px */
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
| 基线 | `vertical-align: baseline`；数学字形可光学微调 `-0.12em ~ 0`，禁止顶对齐大块 |
| 高度 | 墨迹目标高度 **1.0～1.25 ×** 正文字号（15px → **15～19px**）；盒高不超过行盒 **~1.35em** |
| 缩放 | 裁切原图若过高 → **先紧裁再等比缩小** 落入上列；不得用放大白边撑开行距 |
| 水平 | 左右内边距 ≤ **2px**（CSS）；与邻字间距跟正文，勿额外 `margin-inline: 8px+` |
| 禁止 | 裁进邻词（反例里的 `n`）、上一行 descender、下一行 ascender；禁止「半句上、大白块、半句下」三截版 |

```css
.oi-pdf-inline-math {
  display: inline-block;
  vertical-align: baseline;
  margin: 0 1px;
  padding: 0;
  line-height: 1;
  max-height: 1.35em;
}
.oi-pdf-inline-math .oi-pdf-math-crop {
  display: block;
  height: 1.15em;      /* 光学：随 15px 正文 */
  width: auto;
  max-width: 100%;
  object-fit: contain;
  object-position: left center;
  border: none;
  box-shadow: none;
  border-radius: 1px;
  background: #fff;    /* 纸色随原件；勿再外包深色 card */
}
```

**降级（仅当紧裁+缩放仍无法 ≤1.35em 或裁切失败）：** 段内插入「（公式见左栏）」链接/按钮，点击聚焦左栏对应页区；**不要**塞一整行糊图。

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
| 有可靠 `latex` | 行内 `$...$`；独立 `$$...$$` |
| 仅裁切 | `![公式](asset…)` 或「[公式]」；图 `![题注](…)` |
| 降级占位 | `（公式见左栏）` |

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
