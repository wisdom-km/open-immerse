# PDF 右栏 · Markdown 通读流（PDF-MD-READOUT）

**定案（2026-09-19 Wisdom via Forge / Anvil）：**  
本单权威规格。Cloud：`bc-203b188b`。

| | |
| --- | --- |
| 左栏 | **现有** pdf.js PDF 渲染（不改网页） |
| 右栏 | **标题 + 正文抽取 → 翻译 → Markdown 通读**（连续滚动） |
| 图 | **不**像素 / bbox 复刻；可用题注文字或「（见图·左栏）」占位 |
| 停 | 像素镜像主路径（**#40 closed**）；禁再开 bbox 镜像 tip |
| 网页 | **仍主路径**；本单 **勿回归** 网页 content/Options |
| 藏入口 | **本轨不做**（`bc-e7891fdc` 已 cancel；`PDF-ENTRY-SECONDARY` 本轨作废） |

**fixture：** `/workspace/oi-qa/fixtures/pdf/Attention_Is_All_You_Need.pdf`  
**旧文：** `PDF-RIGHT-PANE.md` = 通读 CSS 贴片 only，**不够**当本单权威。  
**同义旧稿：** `PDF-READOUT-MARKDOWN.md` → 以 **本文** 为准。

---

## 1. 产品锁

```
┌─────────────┬──────────────────────────────┐
│ 左 pdf.js   │ 右 .readout 通读流            │
│ 原文页      │ MD/HTML：h1/h2 + 译后段落     │
│             │ 连续 overflow:auto 滚动       │
└─────────────┴──────────────────────────────┘
```

- 右栏是 **阅读器**，不是版式复印机。  
- 顶栏范围若已有：当前页 / 全文 —— 全文=多页抽取接成一条流。  
- 导出 MD = 右栏通读语义序（若产品已有导出按钮则对齐本流）。

否决：`.mirror-page` 绝对定位贴作者格；右栏嵌 PDF 裁切图当「镜像」；顺手改网页 bilingual gap。

---

## 2. 抽取 → 译 → 挂载

| 步骤 | 要求 |
| --- | --- |
| 抽 | 文本层；主标题→`#`/`h1`，小节→`##`/`h2`，正文→自然段；阅读序（双栏先左后右） |
| 滤 | 跳过重复页眉页脚、纯页码；arXiv 边栏竖条 **不进** 主通读 |
| 图 | 不贴图像素；可选一段题注译或占位 |
| 公式 | 通读内 `$`/`$$` 或「（公式见左栏）」；不要求 bbox |
| 译 | 现有 provider batch；按段；当前页 vs 全文跟 scope |
| 挂 | 右栏 `.readout`（或等价）连续块；**不要**默认 mirror DOM |

排版：可复用 `PDF-RIGHT-PANE` 的 `.oi-pdf-h1/.h2/.p` 数字作通读皮肤。

---

## 3. 验收（Attention）

- [ ] 左：pdf.js 原文清晰  
- [ ] 右：中文标题+正文 **连续可滚**，非叠字作者格、非 arXiv 串文  
- [ ] 图：右栏无像素复刻要求；左栏仍可见图  
- [ ] 全文 scope 或多页：通读流接得上  
- [ ] 对照旧镜像 FAIL 图更干净（`oi-qa/pdf-b-fail/attention-right-garbled.png`）  
- [ ] **无**网页 Options / content 间距回归  

---

## 4. 工程边界

| 做 | 不做 |
| --- | --- |
| extract→translate→readout | bbox mirror / #40 |
| 通读 CSS | 藏 Popup PDF 入口（本轨 cancel） |
| Attention 验收 | 网页侧栏/gloss gap |

停用 mirror 主路径 feature-flag 即可；勿删网页代码。
