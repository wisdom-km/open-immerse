# PDF 右栏镜像 · 排版保真（PDF-MIRROR-LAYOUT-FIDELITY）

**来源：** Wisdom via Jone copy / Forge（网页 A 已合 main；PDF B 跟进）
**叠在：** [`PDF-READOUT-MIRROR.md`](./PDF-READOUT-MIRROR.md) V3 + [`PDF-MIRROR-CJK-CLIP.md`](./PDF-MIRROR-CJK-CLIP.md)
**fixture：** `tests/fixtures/Attention_Is_All_You_Need.pdf`（副本 `oi-qa/fixtures/pdf/Attention_Is_All_You_Need.pdf`）
**拒收证图：** `oi-qa/pdf-b-fail/attention-right-garbled.png`（右栏叠字 + arXiv 串进摘要）

---

## 1. 决策锁

| 项 | 锁定 |
| --- | --- |
| 对照 | 右栏镜像页须与 **同页左栏原文** 几何同构（标题 / 作者格 / 摘要 / 正文栏 / 边栏 meta 各就各位） |
| 禁 | **乱码**、**叠字叠层**、**串栏**（含 arXiv 竖条横插摘要、双栏串读） |
| 范围 | **整篇 PDF**（Attention 全文页，非仅首页） |
| CJK | 不裁切 ∩ 不压字（CJK-CLIP）仍硬；本单强调 **栏位/阅读序** 保真 |
| 公式/图 | 仍跟 READOUT-MIRROR（LaTeX→KaTeX；图裁切） |

否决：右栏「看起来有中文」但作者格糊成一团；边栏 meta 当正文流；只验 p.1。

---

## 2. 保真规则（相对左栏）

以左栏 pdf.js 同页为真源：

| 区域 | 要求 |
| --- | --- |
| 页框 | 右 `.mirror-page` 与左页同宽高比；页边距带不被正文侵占 |
| 标题 | 水平大致居中/同左；译文可增高但 **下推** 作者区，不盖作者 |
| 作者格 | 多列网格：**每格** 姓名/机构/邮箱分行可读；格间墨迹 **不相交**；禁止整表叠成一团 |
| 摘要/正文 | 落在主栏 content box；**不得**与左页边栏 meta（arXiv 竖排等）墨迹相交 |
| 边栏 meta | 识别为 margin（`looksLikeArxivMeta` 等）→ 留在页边条，或 SKIP 不译进主栏；**禁止**横插摘要首行 |
| 双栏正文 | 阅读序左列→右列；块仍贴自身 bbox，禁止拉成单栏乱序 |
| 增高 | 中文换行可向下扩；扩后必须碰撞下推（CJK-CLIP），禁止 visible 溢出盖下一层 |

---

## 3. 验收（Attention 全文）

**打开：** fixture 上路径；右栏默认镜像；译全文或至少连续多页抽检。

### 3.1 首页（对照证图须翻绿）

- [ ] 标题「注意力…」清晰，不盖作者
- [ ] 作者格：每人姓名/机构/邮箱可读，**无**证图级叠字
- [ ] 摘要主栏完整；**无** `arXiv:1706…` 类竖条横穿摘要
- [ ] 与左栏红框区域同构（位置一眼可对）

### 3.2 全文（非仅 p.1）

- [ ] 抽检 ≥3 个内文页（含公式页、双栏或图页若有）：无大面积叠字/串栏
- [ ] 滚到末页再回首页：布局不崩、不重复叠层
- [ ] 左↔右页级滚动同步仍可用

### 3.3 回归

- [ ] CJK 不裁切；深墨可读；右 zoom chip 独立
- [ ] 公式 KaTeX/可复制合同不回退
- [ ] 网页正文间距 / Options 滑杆 **本单不碰**
- [ ] 不重开网页 / #36 侧栏配对

---

## 4. 工程提示

1. 边栏 meta 与主栏分轨：`reserveMarginMeta` / 阅读序在译前就固定 role。
2. 作者列优先 **列内流式合并** 再绝对定位，避免多绝对矮盒共 top。
3. 每页 `relayoutMirrorPageBoxes` 后断言：同页文本 ink 两两不相交；meta∩abstract = ∅。
4. QA：新截右栏首页对比 `pdf-b-fail/attention-right-garbled.png`；全文再存 `oi-qa/pdf-mirror-fidelity/`。

---

## 5. 不做

- 不改网页 SIDEBAR / BODY-GLOSS
- 不要求打印机级 1:1 像素
- 扫描件 OCR 镜像（仍无文本层则明确空态）
