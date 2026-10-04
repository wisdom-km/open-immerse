# PDF 右栏 · 公式节奏（FORMULA-RIGHT-PANE）

目标做法按 REQUIREMENTS §2.6「运行时顺序」：第零层 arXiv 源码 → 多模态 → OCR API → 自研算法 → 矢量重绘 → 裁图 → 占位（2026-10-05 01:12 Wisdom 定；层号不改，第二层排在第一层之前）。第一层的目标是按原字体、原位置重绘字符；做出来之前，`renderSharpVisualCrop` 的原页高清重渲染也算第一层，本质上是区域渲染。失败时静默退成 pageRaster 的 png，不加徽章（V1-B1，见 REQUIREMENTS §2.6 术语表），不算换层。换层按 REQUIREMENTS §2.6「运行时顺序」的自动判据。多模态是公式主路径；第一层（自建识别和矢量重绘）按现状冻结，只作兜底，不再优化；练习集各层占比基线不再做（2026-10-05 00:48 Wisdom 定）。矢量重绘还没实现的部分做不做，待 Wisdom 确认。两个开关都是目标，待实现（代码里现在还没有这两个开关，不是「现在已经关着」）；目标是互相独立、都默认关闭。W-07 的「开关先只做一个」指第三层占位只做一个开关，独立公式和行内公式共用；第二层多模态开关是另一个。第二层开关（待实现）：用户可见，在 Aa 面板里，叫「用看图模型补全公式」。用户接上多模态 API 后显示，默认关闭，开关旁注明费用和隐私（2026-10-05 00:33 Wisdom 定）。DPO 论文（arXiv 2305.18290v3）第 3–5 页 79 个公式是多模态准确率的参考测试：不是合入或上线的门槛（2026-10-05 00:48 Wisdom 定，取代 2026-10-02「第二层在 DPO 测试前保持关闭」）；接上 API 后先跑一次，结果给 Wisdom 看（据 00:48 决定整理）。第三层占位开关（待实现）：占位门槛不按练习集基线定，练习集各层占比基线不再做；运行时每一级按自动判据往下退，具体门槛数字仍是初始值，待实测（2026-10-05 00:48 Wisdom 定）。占位要说明这里有个公式，点了原文栏直接跳到对应的公式（00:48 Wisdom 定，大意：有公式的地方放占位，点进去直接看到左侧对应公式）。这一个开关下两种文案：独立公式的占位写「这里有公式，点击查看原文第 N 页」、不写公式编号，这句文案是文档细化，待确认；行内公式的占位仍是「〔公式 · 原文第 N 页〕」。分流（2026-10-05 01:12 改）：用户接上了多模态 API、第二层开关开着、核对也通过，用 KaTeX；否则接上了 OCR API、OCR 开关开着、核对也通过，用 OCR 结果（OCR API 层；这一级的开关和核对是文档细化，待确认）；否则用自研算法（第一层，现有代码按现状冻结；这一级的判据是文档细化，待确认）；否则矢量重绘的把握分数过阈值，用矢量重绘（第一层，待实现；现有第一层代码按现状冻结；没实现的部分做不做，待 Wisdom 确认；做出来之前跳过这一步）；否则原页裁图清楚、没切到邻行，用裁图（第一层的高清重渲染或 png 裁图）；否则第三层开关开着就是占位，关着就按现状显示（原页裁图）。各步的自动判据见 REQUIREMENTS §2.6「运行时顺序」。过宽公式的现状见 §2。F3-S4 见 REQUIREMENTS §2.6 术语表。UI 以 Loom 规格为准。

**角色：** 在 PR#51 精准硬门之上的 **第二目标：贴原版节奏 / 更优雅**。  
**权威归属：** Loom。Cloud tip 跟本文 + [`PDF-MD-FORMULA-LAYOUT.md`](../../open-immerse-specs/PDF-MD-FORMULA-LAYOUT.md)。  
**验收：** 文字层仍在。过宽公式的尺寸硬门已上线，见 §2。公式按 REQUIREMENTS §2.6「运行时顺序」（第零层 arXiv 源码 → 多模态 → OCR API → 自研算法 → 矢量重绘 → 裁图 → 占位；2026-10-05 01:12 Wisdom 定），每一步看自己的自动判据。第一层的目标是按原字体、原位置重绘字符；做出来之前，`renderSharpVisualCrop` 的高清重渲染也算第一层。失败时静默退 png，不算换层（V1-B1，见 REQUIREMENTS §2.6 术语表）。两个开关都是目标，待实现（代码里现在还没有这两个开关，不是「现在已经关着」）；目标是互相独立、都默认关闭。W-07 的「开关先只做一个」指第三层占位只做一个开关，独立公式和行内公式共用；第二层多模态开关是另一个。第二层开关（待实现）：用户可见，在 Aa 面板里，叫「用看图模型补全公式」。用户接上多模态 API 后显示，默认关闭，开关旁注明费用和隐私（2026-10-05 00:33 Wisdom 定）。DPO 论文（arXiv 2305.18290v3）第 3–5 页 79 个公式是多模态准确率的参考测试：不是合入或上线的门槛（2026-10-05 00:48 Wisdom 定，取代 2026-10-02「第二层在 DPO 测试前保持关闭」）；接上 API 后先跑一次，结果给 Wisdom 看（据 00:48 决定整理）。分流（2026-10-05 01:12 改）：用户接上了多模态 API、第二层开关开着、核对也通过，用 KaTeX；否则接上了 OCR API、OCR 开关开着、核对也通过，用 OCR 结果（OCR API 层；这一级的开关和核对是文档细化，待确认）；否则用自研算法（第一层，现有代码按现状冻结；这一级的判据是文档细化，待确认）；否则矢量重绘的把握分数过阈值，用矢量重绘（第一层，待实现；现有第一层代码按现状冻结；没实现的部分做不做，待 Wisdom 确认；做出来之前跳过这一步）；否则原页裁图清楚、没切到邻行，用裁图（第一层的高清重渲染或 png 裁图）；否则第三层开关开着就是占位，关着就按现状显示（原页裁图）。各步的自动判据见 REQUIREMENTS §2.6「运行时顺序」。#40 镜像关。UI 以 Loom 规格为准。  
**fixture：** Attention Is All You Need · 对照原文栏 pdf.js。  
**软注靶子（Anvil）：** softmax 误带 Fig.2；邻行多裁；行内砸成卡片。

---

## 1. 决策摘要

| 项 | 锁定 |
| --- | --- |
| 独立公式 | **块级**；相对通读列 **水平居中**（对齐原版居中式）；与前后段有呼吸空隙 |
| 行内公式 | **基线嵌进句中**；简单关系（`N=6`、`h=8`、`P_drop=0.1`、`ε_ls=0.1`）写 Unicode，不发 ⟦fN⟧、不裁图；下标 / 根号 / ∑ / 矩阵 / PE 走一小段区域渲染，和第一层 `surface="redraw"` 同一种。这是现在已上线的画面；目标做法里行内公式也按同一运行时顺序走（源码 → 多模态 → OCR API → 自研算法 → 矢量 → 裁图 → 占位；顺序 2026-10-05 01:12 Wisdom 定，行内跟同一顺序走是 2026-10-05 00:33 Wisdom 定），见 REQUIREMENTS §2.6「行内公式」 |
| 图 / 表 / 题注 | 原件裁切；题注与图/表、与邻近公式 **分区**，防吞 `Fig.n` |
| 密度 | 裁图墨迹尺度贴近原文栏同式；块间距参照原文栏行距，勿「卡片墙」 |
| 表面 | 无巨大卡片、无阴影重框、无把行内公式升成独立 section |

否决：softmax 裁框并进 Figure 2；行内 β₁ 整行白底打断段落；独立公式左贴且贴死邻段；为优雅改网页 Soft Graphite。

---

## 2. 独立公式（display）

```
段末 …
        ┌──────────────────┐
        │  原页公式裁切     │   ← 居中；无 card/shadow
        └──────────────────┘
下一段 …
```

| | 规格 |
| --- | --- |
| 容器 | 块级 `figure` / 等价；**仅**独占行公式（无 `inlineOf`） |
| 水平 | `text-align: center`。现状（已上线）分主路径和回退路径。主路径：`pdf/viewer.js` 的 `matchedFormulaStyle` 调用 `readerFormulaStyle`，再调用 `lib/pdf-formula-size.js` 的 `readerFormulaCssSize`。公式相对正文的缩放倍数默认 `DISPLAY_INK_PREFER` **1.4×**、最低 `DISPLAY_INK_HARD` **1.0×**。先缩到栏宽，到了最低倍数还放不下，才在公式框内横向滚动。`tests/pdf-formula-size.test.mjs` 锁定：比栏宽宽时从 1.4× 往下缩，缩放倍数仍高于 1.0× 时先留出取整余量。不要改成占位来躲过宽。回退路径：`matchedFormulaStyle` 定不出尺寸时，`mountDisplayMath` 用 `lib/pdf-blocks.js` 的 `displayFormulaWidthCss`。这一支不缩到栏宽，宽度取页宽占比和 em 墨迹下限里较大的一个。函数注释是 "not shrunk below the ink floor"。下限来自 `displayFormulaMinEm` 和 `displayInkMinEm`。裁图是 `max-width: none`（`.pane-translate .readout.md-readout .oi-pdf-display-math .oi-pdf-math-crop`），超出部分在公式框内横向滚动。右栏纸面的横滚是 PR #90 做的，和公式框内的横滚是两件事 |
| 宽度 | 已上线。主路径见上一行：公式相对正文的缩放倍数默认 **1.4×**、最低 **1.0×**。先缩到栏宽，到最低倍数还放不下才横滚。墨迹/正文 ≥ **1.6×** 仍是修宽后的强期望（盒 `2em` × 约 0.8 share；自然到约 3× 且 ≤ **5×** 仍通过）。回退路径不缩到栏宽。它的正文列已经扣过左右 `0.085`，宽度用 `pageFraction / (1 − 2×0.085)`，纸比左页窄时再乘左页宽 / 纸宽，再和 em 墨迹下限取较大的一个。短裁图若实测 share 让墨迹低于 1.4× 正文，只把这一张的 floor 抬到 `1.4 / inkShare`，不先把图拉满整列，也不动 #62 pad。页宽占比不要直接写成正文列的 `%` |
| 上下空隙 | 阅读页（`.reader-flow`）已上线：`margin: var(--oi-reader-display-margin)`，即 `0.875em 0 1.125em`。正文默认字号 16px，所以是 14px / 18px。`.reader-flow` 外才是 `10px 0 14px`。对标 Attention 原文栏：公式上下约半行到一行呼吸 |
| 与邻段 | 段 `margin-bottom` 与公式 `margin-top` **取大不叠盲加** |
| 裁框 | 只盖公式墨迹（含 softmax / 括号 / 等号 / 上下标）；**禁止**并入下方/旁侧 `figure`、`table`、题注 |

阅读页（`.reader-flow .oi-pdf-display-math`）的上下空隙已上线，用 `var(--oi-reader-display-margin)`。定义在 `pdf/reader-tokens.css`，值是 `0.875em 0 1.125em`。正文默认字号 16px，所以是 14px / 18px。阅读页会把 `--oi-pdf-body-fs` 设成这个字号。`margin: 10px 0 14px` 只在 `.reader-flow` 外生效，样式表回退字号仍是 15px。下面贴片里 `img` 的 `max-width: 100%`、`min-height: 2em`、`vertical-align: middle` 仍是目标稿，待实现。现状裁图 `.oi-pdf-display-math .oi-pdf-math-crop` 是 `display: block`、`height: auto`、`object-fit: contain`、无描边、无阴影。阅读列（`.pane-translate .readout.md-readout .oi-pdf-display-math .oi-pdf-math-crop`）是 `vertical-align: baseline`、`border-radius: 0`、`max-width: none`。见 §2「水平」。

CSS 贴片：

```css
.oi-pdf-display-math {
  display: block;
  margin: 10px 0 14px; /* 仅 .reader-flow 外。阅读页用 var(--oi-reader-display-margin) */
  padding: 0;
  text-align: center;
  background: transparent;
  border: none;
  box-shadow: none;
  font-size: var(--oi-pdf-body-fs, 15px); /* 阅读页把变量设成默认 16px */
}
.oi-pdf-display-math img {
  max-width: 100%; /* 目标稿。现状是 max-width: none */
  height: auto;
  min-height: 2em; /* 目标稿。现状是 min-height: 0 */
  object-fit: contain;
  vertical-align: middle; /* 目标稿。现状是 vertical-align: baseline */
  border: none;
  box-shadow: none;
  border-radius: 0; /* 勿圆角卡片感；最多 2px */
}
```

---

## 3. 行内公式（inline）

| | 规格 |
| --- | --- |
| 容器 | `span` + `inline-block`；挂在宿主 `p` 内；**必须**有 `inlineOf` |
| 基线 | 回退路径是 `vertical-align: baseline`（光学可 `-0.12em～0`）。主路径是 `vertical-align: middle`（`viewer.css` 约第 698 行和第 709 行） |
| 高度 | 主路径裁图固定放大 k=1.35（`INLINE_CROP_K`）。`pdf/viewer.js` 的 `matchedFormulaStyle` 调用 `readerFormulaStyle`，再调用 `lib/pdf-formula-size.js` 的 `readerFormulaCssSize`。留在行内的裁图都用这个倍数。估算高度（bbox 高 × k）超过 2.2em（`INLINE_LINE_BOX_EM`）、裁图宽过栏，或下标低于 7px（`SCRIPT_INK_MIN_PX`）时，升级成独立公式。对不上左栏框的回退路径实际是 1.4em（`INLINE_BODY_HARD_MAX`）。`pdf/viewer.js` 把 `--oi-pdf-inline-crop-em` 和 `--oi-pdf-inline-line-em` 写成这个值 |
| 禁止 | `display:block` / 独立 `figure` / 整行 `img`；外包 padding≥6px 的白底「小卡片」。这里的 `display:block` 指留在行内的公式。按规则升级成独立公式的走独立公式路径，是 `display: block`，不算违反 |
| 裁框 | 紧贴公式字形；**禁止**带上邻词、上一行 descender、下一行 ascender（反例 `oi-qa/pdf-lab-attention/p07-lr-formula.png`） |

墨迹 ≥ 1.0× bodyFs（目标 1.25–1.35×、盒名义 1.95em）于 2026-10-04 测过、不采用，因为 16px 下 145 个行内公式的比值最小 0.62、中位 1.19，低于 1.0 的 19 个几乎都是盒高只有 1.1–1.9em、以小写高度的字形为主的单变量或短式，只放大不足部分会使撑行超过 2px 的从 8 个增加到 13 个，≥1.25× 要放大 74/121 并使这类撑行增加到 24 个，严格等于 1.0× 则要缩小 96/121，数字和做法见 [行内公式墨迹实测（2026-10-04）](./INLINE-INK-MEASURE-2026-10-04.md)。

```css
.oi-pdf-inline-math {
  display: inline-block;
  vertical-align: baseline; /* 回退路径。主路径是 middle */
  margin: 0 0.2em;
  padding: 0;
  line-height: 1;
  max-width: 100%; /* 回退路径。主路径是 none，超宽升级成块 */
}
.oi-pdf-inline-math img {
  display: block;
  height: var(--oi-pdf-inline-crop-em, 1.95em); /* 1.95em 只是 CSS 默认值。现行代码走不到，以代码为准 */
  width: auto;
  max-width: none;
  object-fit: contain;
  border: none;
  box-shadow: none;
}
```

`1.95em` 是上面 `height` 的 CSS 默认值。现行阅读器走不到它：主路径的高度来自 `--oi-formula-h`，由 `readerFormulaCssSize` 按 k=1.35 算出；回退路径在 `pdf/viewer.js` 里把 `--oi-pdf-inline-crop-em` 写成 `1.4em`（`INLINE_BODY_HARD_MAX`）。尺寸以 `lib/pdf-formula-size.js` 和 `pdf/viewer.js` 为准。

现状要分主路径和回退路径。主路径（实测约 83% 留在行内）在 `viewer.css` 约第 692–701 行：`max-width: none`，`overflow: visible`，`vertical-align: middle`。高度超过 `--oi-reader-inline-line-max`（2.2em）时，上下 margin 为负，各承担超出量的一半。估算高度（bbox 高 × k）超过 2.2em（`INLINE_LINE_BOX_EM`）、裁图宽过栏，或下标低于 `SCRIPT_INK_MIN_PX`（7px）时，`readerFormulaCssSize` 把它升级成独立块。回退路径的容器最宽 `max-width: 100%`，左右 `margin: 0 0.2em`，`vertical-align: baseline`，超宽在框内横滚。裁图 `max-width: none`。降级文案是目标状态，待实现：行内文字兜底「〔公式 · 原文第 N 页〕」。屏幕上现在仍是「（公式见左栏）」。紧裁加缩放仍超高时宁缺勿砸版。具体 UI 以 Loom 规格为准。

---

## 4. 图 / 表 / 题注 · 与公式的间距（防吞 Fig.n）

### 4.1 分块硬规则

| 规则 | |
| --- | --- |
| 公式 bbox ∩ figure/table bbox | **面积交必须为 0**（归一化页坐标） |
| 公式 bbox ∩ caption 带 | 交为 0；题注行（`Figure n` / `Fig. n` / `表 n`）不得进公式裁图 |
| 阅读序 | `figure` → `caption`（`captionFor`）→ 后续正文/公式；**不得**把题注像素糊进上一公式 |
| Soft 靶 | Attention **p4**：softmax / Attention(Q,K,V)=… **不得**含 Figure 2 任一侧子图或「Figure 2: …」字样 |

### 4.2 排版空隙

| 关系 | 空隙 |
| --- | --- |
| 图/表裁图 → 题注 | `6px`（紧） |
| 题注 → 下一段正文 | `12px` |
| 图/表块 → 其后独立公式 | ≥ `14px`（避免「图底贴公式」） |
| 独立公式 → 其后图/表 | ≥ `14px` |
| 题注样式 | `13px / 1.45` · `var(--oi-text-muted)`；无框无影 |

```css
.oi-pdf-figure { display: block; margin: 16px 0 12px; text-align: center; border: none; box-shadow: none; }
.oi-pdf-figure img { max-width: 100%; height: auto; }
.oi-pdf-caption { margin: 6px 0 0; font: 400 13px/1.45 var(--oi-font); color: var(--oi-text-muted); }
```

---

## 5. 密度（对照 Attention 原文栏）

以原文栏 **100% zoom** 同页同式为参照：

| | 目标 |
| --- | --- |
| 独立公式视觉高 | 约为原文栏该式渲染高的 **0.9～1.1×**（通读列内）；勿放大成「海报块」 |
| 行内公式 | 主路径裁图固定放大 k=1.35，估算高度（bbox 高 × k）超过 2.2em、宽过栏或下标低于 7px 时升级成独立公式；主路径 `max-width: none`、`vertical-align: middle`。回退路径实际 1.4em，`max-width: 100%`，超宽在框内横滚，`vertical-align: baseline`。仍嵌在句中。旧目标「墨迹 ≥ 1.0× 正文、目标 1.25–1.35×、盒名义 1.95em」于 2026-10-04 测过、不采用 |
| 通读列 | 正文 **16px**，行高 **1.9**（`--oi-reader-font-size`、`--oi-reader-line-height`）；公式块间距见 §2–§3，**不要**再给公式加 panel padding |
| 白边 | 裁切近白边 ≤ **6 CSS px**；略松保笔画，不松到邻行（精准优先） |
| 深色底 | 允许纸白底随原件；**禁止**再包一层 elevated/card；描边最多 `1px var(--oi-line)` |

---

## 6. 明确禁止

1. 巨大卡片 / `box-shadow` / ≥2px 实线重框包公式或图  
2. 把 **行内** 公式做成独立 section / 块级大图打断段落  
3. softmax（或任一公式）裁框 **吞入** Fig.n / 题注 / 邻段文字  
4. 邻行多裁（上一行脚、下一行头进框）  
5. 把 OCR LaTeX，或未开启、未核对的第二层输出，当作主展示。第二层出了结果，主展示就是 KaTeX，一律带小记号（REQUIREMENTS §2.6）  
6. 为 PDF 右栏改网页 Soft Graphite / bilingual gap  

---

## 7. 工程师验收（可截图对照）

样张：Attention；原文栏对照；证图可落 `oi-qa/pdf-lab-attention/`。

### A. 独立公式

- [ ] p4 Attention(Q,K,V)=softmax… **居中**；上下有约 10–14px 级呼吸，非贴段  
- [ ] 裁图 **不含** Figure 2 任一子图、不含「Figure 2」题注（对照原文栏同页）  
- [ ] 无 shadow / 厚框 / panel 底  

### B. 行内

- [ ] p7 β₁=0.9 类：**同段基线**嵌入；非整行白卡片（对照 `p07-lr-formula.png` 反例须明显改善）  
- [ ] 无邻词碎字、无上下行穿透  

### C. 图题注

- [ ] Figure 2：图裁切与题注分离；题注 muted；公式与图 bbox 不交  
- [ ] 图→题注约 6px；题注→正文约 12px  

### D. 回归

- [ ] 现在已上线的高清重渲染（`surface="redraw"`）和 pageRaster 的 png 裁图按 REQUIREMENTS §2.6 算第一层。失败时静默退 png。两个开关都是目标，待实现（代码里现在还没有这两个开关，不是「现在已经关着」）；目标是互相独立、都默认关闭。W-07 的「开关先只做一个」指第三层占位只做一个开关，独立公式和行内公式共用；第二层多模态开关是另一个。第二层开关（待实现；接上多模态 API 后显示，默认关闭，旁边注明费用和隐私）。按 REQUIREMENTS §2.6「运行时顺序」：用户接上了多模态 API、第二层开关开着、核对也通过，用 KaTeX；否则接上了 OCR API、OCR 开关开着、核对也通过，用 OCR 结果（OCR API 层；这一级的开关和核对是文档细化，待确认）；否则用自研算法（第一层，现有代码按现状冻结；这一级的判据是文档细化，待确认）；否则矢量重绘把握分数过阈值，用矢量重绘；否则原页裁图清楚、没切到邻行，用裁图；否则第三层开关开着就是占位，关着就按现状显示  
- [ ] 网页 Soft Graphite / Options / bilingual **无回归**  
- [ ] #40 镜像未回潮  

---

## 8. 与既有文关系

| 文 | 关系 |
| --- | --- |
| `pdf/high-precision/REQUIREMENTS.md` | 精准硬门 / blocks 协议 |
| `open-immerse-specs/PDF-MD-FORMULA-LAYOUT.md` | 通读轨公式总规；**节奏数字以本文 §2–§5 为准**（若冲突） |
| `PDF-MD-READOUT.md` | 通读产品 |

**建议 tip：** `pdf-formula-right-pane-rhythm`（挂本文路径）。
