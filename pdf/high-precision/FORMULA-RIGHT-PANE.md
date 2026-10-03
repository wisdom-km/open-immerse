# PDF 右栏 · 公式节奏（FORMULA-RIGHT-PANE）

目标做法是运行时 1→2→3（REQUIREMENTS §2.6）。第一层的目标是按原字体、原位置重绘字符；做出来之前，`renderSharpVisualCrop` 的原页高清重渲染也算第一层，本质上是区域渲染。失败时静默退成 pageRaster 的 png，不加徽章（V1-B1，见 REQUIREMENTS §2.6 术语表），不算换层。换层只看框的把握。两个开关互相独立，都默认关闭。第二层开关（待实现）：用户可见，在 Aa 面板里，叫「用看图模型补全公式」。第二层上线之前界面上不显示这个开关；等 DPO 论文（arXiv 2305.18290v3）第 3–5 页 79 个公式的实验做完、产品方决定上线后才出现，出现时默认关闭。第三层占位开关：等上线门槛。分流：框的把握过阈值，用第一层。没过阈值、第二层开关开着、核对也通过，用 KaTeX。否则，第三层开关开着就是占位；关着就按现状显示。过宽公式的现状和目标见 §2。F3-S4 见 REQUIREMENTS §2.6 术语表。UI 以 Loom 规格为准。

**角色：** 在 PR#51 精准硬门之上的 **第二目标：贴原版节奏 / 更优雅**。  
**权威归属：** Loom。Cloud tip 跟本文 + [`PDF-MD-FORMULA-LAYOUT.md`](../../open-immerse-specs/PDF-MD-FORMULA-LAYOUT.md)。  
**验收：** 文字层仍在。这里不是过宽公式的尺寸硬门；尺寸硬门待定，见 §2。公式按运行时 1→2→3，换层只看框的把握。第一层的目标是按原字体、原位置重绘字符；做出来之前，`renderSharpVisualCrop` 的高清重渲染也算第一层。失败时静默退 png，不算换层（V1-B1，见 REQUIREMENTS §2.6 术语表）。两个开关互相独立，都默认关闭。第二层开关（待实现）：用户可见，在 Aa 面板里，叫「用看图模型补全公式」。第二层上线之前界面上不显示这个开关；等 DPO 论文（arXiv 2305.18290v3）第 3–5 页 79 个公式的实验做完、产品方决定上线后才出现，出现时默认关闭。分流：框的把握过阈值，用第一层。没过阈值、第二层开关开着、核对也通过，用 KaTeX。否则，第三层开关开着就是占位；关着就按现状显示。#40 镜像关。UI 以 Loom 规格为准。  
**fixture：** Attention Is All You Need · 对照原文栏 pdf.js。  
**软注靶子（Anvil）：** softmax 误带 Fig.2；邻行多裁；行内砸成卡片。

---

## 1. 决策摘要

| 项 | 锁定 |
| --- | --- |
| 独立公式 | **块级**；相对通读列 **水平居中**（对齐原版居中式）；与前后段有呼吸空隙 |
| 行内公式 | **基线嵌进句中**；简单关系（`N=6`、`h=8`、`P_drop=0.1`、`ε_ls=0.1`）写 Unicode，不发 ⟦fN⟧、不裁图；下标 / 根号 / ∑ / 矩阵 / PE 走一小段区域渲染，和第一层 `surface="redraw"` 同一种。只走第一层，不走第二层的大模型，见 REQUIREMENTS §2.6「行内公式」 |
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
| 水平 | `text-align: center`。现状（已上线）分主路径和回退路径。主路径没有墨迹下限，见 `pdf/viewer.js` 的 `matchedFormulaStyle`（约第 1449 行）：按原文栏这块框的高和宽来定。回退路径在主路径定不出尺寸时用 `displayFormulaWidthCss`（`lib/pdf-blocks.js` 约第 534 行）。这一支的宽度按 em 计算墨迹下限，取页宽占比和这条 em 下限里较大的一个，并且不把图缩到墨迹下限以下（同文件第 531–532 行注释："not shrunk below the ink floor"）。下限值来自 `displayFormulaMinEm`（`lib/pdf-formula-size.js` 第 121 行）和 `displayInkMinEm`（`lib/pdf-blocks.js` 第 482–487 行）。回退路径的宽度不夹到列宽，由 `tests/pdf-formula-size.test.mjs` 第 75–76 行锁定。裁图是 `max-width: none`（`pdf/viewer.css` 约第 473–477 行），超出部分在公式框内横向滚动。这是 #72 的实现。右栏纸面的横滚是 PR #90 做的，和公式框内的横滚（#72）是两件事。目标（待实现）：先等比缩小到列宽，但不低于硬门；到了硬门还放不下，就在框内横向滚动（F3-S4，见 REQUIREMENTS §2.6 术语表）。硬门的数值跟着 F3 尺寸规则走，待定，实现时与 F3 一起定。实现时要改 `tests/pdf-formula-size.test.mjs` 第 75–76 行。不要改成占位来躲过宽 |
| 宽度 | 目标稿（主路径和回退路径的现状见 FRP L40）。页宽占比不要直接写成正文列的 `%`。正文列已经扣过左右 `0.085`，宽度用 `pageFraction / (1 − 2×0.085)`，纸比左页窄时再乘左页宽 / 纸宽，最后夹在列宽内。宽应明显大于合前约 48% 列宽。列宽仍优先。量测墨迹硬门 ≥ **1.0×** `bodyFs`（专有 display 偏好 ≥ **1.4×**）。数值待定，以 FRP L40 为准。#63 的 ≥ **1.6×** 仍是修宽后的强期望（盒 `2em` × 约 0.8 share；自然到约 3× 且 ≤ **5×** 仍通过）。短裁图若实测 share 让墨迹低于 1.4×，只把这一张的 floor 抬到 `1.4 / inkShare`，不先把图拉满整列，也不动 #62 pad。已上线的主路径和回退路径见上一行，不把这一行的列宽夹取当成主路径或回退路径的现状 |
| 上下空隙 | `margin-block: 10px 14px`（@ 正文 15px ≈ **0.67em / 0.93em**）——对标 Attention 原文栏：公式上下约 **半行～一行** 呼吸，**小于** 段间距 14px 的 dual 叠加 |
| 与邻段 | 段 `margin-bottom` 与公式 `margin-top` **取大不叠盲加** |
| 裁框 | 只盖公式墨迹（含 softmax / 括号 / 等号 / 上下标）；**禁止**并入下方/旁侧 `figure`、`table`、题注 |

`.oi-pdf-display-math` 的 `margin: 10px 0 14px` 已上线（`pdf/viewer.css` 约第 396–398 行）。下面 `img` 的 `max-width: 100%` 和 `min-height: 2em` 是目标稿，待实现；现状裁图是 `max-width: none`，见上表「水平」。

CSS 贴片：

```css
.oi-pdf-display-math {
  display: block;
  margin: 10px 0 14px;
  padding: 0;
  text-align: center;
  background: transparent;
  border: none;
  box-shadow: none;
  font-size: var(--oi-pdf-body-fs, 15px);
}
.oi-pdf-display-math img {
  max-width: 100%;
  height: auto;
  min-height: 2em;
  object-fit: contain;
  vertical-align: middle;
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
| 基线 | `vertical-align: baseline`（光学可 `-0.12em～0`） |
| 高度 | **墨迹**（不是裁图盒）≥ **1.0 ×** 右栏中文 `bodyFs`，强可读目标 **1.25～1.35 ×**（1.05～1.15 只作 parity 观测）。#62 行内白边（4–5px）在盒内，把盒钉在 `1.22em` 时墨迹只有约 0.6–0.9×。盒高 = `targetInk / inkShare`（名义墨迹 16px、行内 pad 4px → share 16/24 → 盒 **1.95em**，允许 ~1.9～2.2em）。墨迹进带后行顶收到 ~**1.8～2.1em**（名义 **1.85em**）。旧 `max-height: 1.45em` 会挡住这扇门，已撤 |
| 禁止 | `display:block` / 独立 `figure` / 整行 `img`；外包 padding≥6px 的白底「小卡片」 |
| 裁框 | 紧贴公式字形；**禁止**带上邻词、上一行 descender、下一行 ascender（反例 `oi-qa/pdf-lab-attention/p07-lr-formula.png`） |

```css
.oi-pdf-inline-math {
  display: inline-block;
  vertical-align: baseline;
  margin: 0 1px;
  padding: 0;
  line-height: 1;
}
.oi-pdf-inline-math img {
  display: block;
  height: var(--oi-pdf-inline-crop-em, 1.95em); /* 墨迹目标 ÷ inkShare，不是把 1.22 改成另一个常数 */
  width: auto;
  max-width: min(100%, 12em);
  object-fit: contain;
  border: none;
  box-shadow: none;
}
```

降级文案是目标状态，待实现：行内文字兜底「〔公式 · 原文第 N 页〕」。屏幕上现在仍是「（公式见左栏）」。紧裁加缩放仍超高时宁缺勿砸版。具体 UI 以 Loom 规格为准。

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
| 行内公式 | 量测墨迹 **1.25～1.35×** 正文（硬门 ≥ **1.0×**）；盒按 inkShare 反推，名义 **1.95em**（行顶 ~1.8～2.1em）；仍嵌在句中 |
| 通读列 | 保持 `PDF-RIGHT-PANE`：正文 **15px / 1.7**；公式块间距见 §2–§3，**不要**再给公式加 panel padding |
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

- [ ] 现在已上线的高清重渲染（`surface="redraw"`）和 pageRaster 的 png 裁图按 REQUIREMENTS §2.6 算第一层。失败时静默退 png。两个开关互相独立，都默认关闭。第二层开关（待实现，上线前界面上不显示）。框的把握过阈值，用第一层。没过阈值、第二层开关开着、核对也通过，用 KaTeX。否则，第三层开关开着就是占位；关着就按现状显示  
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
