# PDF 右栏 · 公式节奏（FORMULA-RIGHT-PANE）

**角色：** 在 PR#51 精准硬门之上的 **第二目标：贴原版节奏 / 更优雅**。  
**权威归属：** Loom。Cloud tip 跟本文 + [`PDF-MD-FORMULA-LAYOUT.md`](../../open-immerse-specs/PDF-MD-FORMULA-LAYOUT.md)。  
**硬门（不变）：** 文字层 + **原页笔画裁切**；**禁止** KaTeX / OCR-LaTeX 作主展示；#40 镜像关。  
**fixture：** Attention Is All You Need · 对照左栏 pdf.js。  
**软注靶子（Anvil）：** softmax 误带 Fig.2；邻行多裁；行内砸成卡片。

---

## 1. 决策摘要

| 项 | 锁定 |
| --- | --- |
| 独立公式 | **块级**；相对通读列 **水平居中**（对齐原版居中式）；与前后段有呼吸空隙 |
| 行内公式 | **基线嵌进句中**；高度随正文；勿卡片化、勿整行撑开 |
| 图 / 表 / 题注 | 原件裁切；题注与图/表、与邻近公式 **分区**，防吞 `Fig.n` |
| 密度 | 裁图墨迹尺度贴近左栏同式；块间距参照左栏行距，勿「卡片墙」 |
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
| 水平 | `text-align: center`；裁图 `max-width: 100%`；过宽等比缩小，墨迹高 ≥ **14px** |
| 宽度 | 页宽占比不要直接写成正文列的 `%`。正文列已经扣过左右 `0.085`，宽度用 `pageFraction / (1 − 2×0.085)`，纸比左页窄时再乘左页宽 / 纸宽，最后夹在列宽内。墨迹高 / 正文 ≥ **1.8×**（目标 **2.5～3.5×**，单行软顶 ≤ **5×**）。补偿后仍矮则 `min-height: 2.25em`，不先把图拉满整列 |
| 上下空隙 | `margin-block: 10px 14px`（@ 正文 15px ≈ **0.67em / 0.93em**）——对标 Attention 左栏：公式上下约 **半行～一行** 呼吸，**小于** 段间距 14px 的 dual 叠加 |
| 与邻段 | 段 `margin-bottom` 与公式 `margin-top` **取大不叠盲加** |
| 裁框 | 只盖公式墨迹（含 softmax / 括号 / 等号 / 上下标）；**禁止**并入下方/旁侧 `figure`、`table`、题注 |

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
  font-size: 15px;
}
.oi-pdf-display-math img {
  max-width: 100%;
  height: auto;
  min-height: 2.25em;
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
| 高度 | 墨迹 **1.20～1.25 ×** 正文字号（15px → **18～19px**）；盒高 ≤ **1.45em** |
| 禁止 | `display:block` / 独立 `figure` / 整行 `img`；外包 padding≥6px 的白底「小卡片」 |
| 裁框 | 紧贴公式字形；**禁止**带上邻词、上一行 descender、下一行 ascender（反例 `oi-qa/pdf-lab-attention/p07-lr-formula.png`） |

```css
.oi-pdf-inline-math {
  display: inline-block;
  vertical-align: baseline;
  margin: 0 1px;
  padding: 0;
  line-height: 1;
  max-height: 1.45em;
}
.oi-pdf-inline-math img {
  display: block;
  height: 1.22em;
  width: auto;
  max-width: min(100%, 12em);
  object-fit: contain;
  border: none;
  box-shadow: none;
}
```

降级：紧裁+缩放仍超高 → 段内「（公式见左栏）」点回左栏；**宁缺勿砸版**。

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

## 5. 密度（对照 Attention 左栏）

以左栏 **100% zoom** 同页同式为参照：

| | 目标 |
| --- | --- |
| 独立公式视觉高 | 约为左栏该式渲染高的 **0.9～1.1×**（通读列内）；勿放大成「海报块」 |
| 行内公式 | 墨迹约 **1.20～1.25×** 正文；盒高 ≤ **1.45em**；仍嵌在句中 |
| 通读列 | 保持 `PDF-RIGHT-PANE`：正文 **15px / 1.7**；公式块间距见 §2–§3，**不要**再给公式加 panel padding |
| 白边 | 裁切近白边 ≤ **6 CSS px**；略松保笔画，不松到邻行（精准优先） |
| 深色底 | 允许纸白底随原件；**禁止**再包一层 elevated/card；描边最多 `1px var(--oi-line)` |

---

## 6. 明确禁止

1. 巨大卡片 / `box-shadow` / ≥2px 实线重框包公式或图  
2. 把 **行内** 公式做成独立 section / 块级大图打断段落  
3. softmax（或任一公式）裁框 **吞入** Fig.n / 题注 / 邻段文字  
4. 邻行多裁（上一行脚、下一行头进框）  
5. KaTeX / OCR 认 LaTeX 作主展示（与 PR#51 冲突）  
6. 为 PDF 右栏改网页 Soft Graphite / bilingual gap  

---

## 7. 工程师验收（可截图对照）

样张：Attention；左栏对照；证图可落 `oi-qa/pdf-lab-attention/`。

### A. 独立公式

- [ ] p4 Attention(Q,K,V)=softmax… **居中**；上下有约 10–14px 级呼吸，非贴段  
- [ ] 裁图 **不含** Figure 2 任一子图、不含「Figure 2」题注（对照左栏同页）  
- [ ] 无 shadow / 厚框 / panel 底  

### B. 行内

- [ ] p7 β₁=0.9 类：**同段基线**嵌入；非整行白卡片（对照 `p07-lr-formula.png` 反例须明显改善）  
- [ ] 无邻词碎字、无上下行穿透  

### C. 图题注

- [ ] Figure 2：图裁切与题注分离；题注 muted；公式与图 bbox 不交  
- [ ] 图→题注约 6px；题注→正文约 12px  

### D. 回归

- [ ] 主展示仍为 **原页裁切**（KaTeX 计数可为 0）  
- [ ] 网页 Soft Graphite / Options / bilingual **无回归**  
- [ ] #40 镜像未回潮  

---

## 8. 与既有文关系

| 文 | 关系 |
| --- | --- |
| `pdf/high-precision/REQUIREMENTS.md` | 精准硬门 / blocks 协议 |
| `open-immerse-specs/PDF-MD-FORMULA-LAYOUT.md` | 通读轨公式总规；**节奏数字以本文 §2–§5 为准**（若冲突） |
| `PDF-MD-READOUT.md` / `PDF-RIGHT-PANE.md` | 通读产品与正文皮肤 |

**建议 tip：** `pdf-formula-right-pane-rhythm`（挂本文路径）。
