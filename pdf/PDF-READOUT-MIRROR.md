# PDF 右栏 · 版式全镜像（PDF-READOUT-MIRROR）

**来源：** Wisdom 截图（Attention 类论文）— 右栏跟原文版式；公式与图原生显示。
**拍板：** 目标锁定 **全镜像 V3**，**不要**只做语义通读增强。
**样例 PDF（锁一本）：** *Attention Is All You Need*（`tests/fixtures/Attention_Is_All_You_Need.pdf` / arXiv 1706.03762）。
**失败对照：** 右栏乱码叠墨（作者互盖、arXiv 横切入摘要、栏序打乱）不得复现。
**保真硬门槛：** `PDF-MIRROR-LAYOUT-FIDELITY.md`。
**可读性 + 右栏缩放：** `PDF-MIRROR-READABILITY-ZOOM.md`。
**CJK：** `PDF-MIRROR-CJK-CLIP.md`（不裁切 **且** 不压字；仅解裁切未解叠字 → 拒收）。

---

## 1. 决策摘要

| 项 | 锁定（V3） |
| --- | --- |
| 对齐粒度 | **按页镜像**：右栏每页一块译页画布，块级按 PDF **归一化 bbox** 摆放（近似坐标） |
| 公式 | **优先 LaTeX + KaTeX**；裁切图仅兜底；再失败才「公式」 |
| 图 | **内嵌裁切图** + 题注译文；点击可同步左栏 |
| 与通读 | **替换**右栏主体验为镜像页流；通读可留次级 |
| 导出 | MD 公式以 `$...$` / `$$...$$` 写入**阅读序**；PDF 导出可读序中文，不要求像素同版 |

否决：仅通读无坐标；公式默认只裁切且无 LaTeX/KaTeX；扫描件假装镜像。

---

## 2. 信息架构

```
.pane-translate
  .mirror-pages
    .mirror-page[data-page="n"]
      .mirror-item[data-role][data-bbox]
  （可选）通读模式 .readout
```

左栏仍 pdf.js continuous；右栏按页堆叠镜像页（全文模式多页依次挂）。

---

## 4. 全镜像 V3 · 可实现验收

### 4.1 BBox 粒度

| | 要求 |
| --- | --- |
| 坐标系 | PDF 页归一化 → CSS%（`left/top/width/height`） |
| 原子单元 | text run 合并后的块：标题、作者格、段落、公式、图、题注、页边各一块 |
| 精度 | 块中心偏差 ≤ 页宽 3% 或 ≤ 12 CSS px；**可读（不裁∩不叠）> 贴死英源盒** |
| 双栏 | 检测双栏后阅读序（左列上→下，再右列）；各块仍用自身 bbox |
| 竖排页边 | transform 近 90° 必须落成瘦高竖条，不得把沿字向 `width` 当成横宽切进摘要 |
| 缩放 | 左栏 zoom 只缩放 PDF；右栏独立 `--oi-mirror-zoom` |
| 数据 | `{ page, role, bbox, sourceText, translation?, latex?, imageRef? }` |

**验收 4.1：** Attention **全文**（15 页）标题 / 作者栅 / 摘要 / 双栏 / 公式 / 图一眼同构，无叠墨、无串栏。

#### 4.1.1 CJK 不裁切 **且** 不压字（硬门槛）

| | 锁定 |
| --- | --- |
| 不裁切 | 译文可增高 bbox；文本块禁止 `overflow:hidden` 裁字形 |
| 不压字 | 增高后须 **下推** 后续块；相邻文本墨迹矩形 **不得相交**（作者格、摘要↔边栏 meta、脚注） |
| 图 / crop | 仍可 `overflow:hidden` |
| 优先级 | **可读（不裁∩不叠）> 贴死英源盒** |

禁止靠缩小字号躲裁切。仅解裁切、未解叠字 → 产品拒收。

### 4.2 公式（LaTeX 优先）

- **A（默认）**：文字层回收 LaTeX → `latex` / `data-latex` → bbox 内 KaTeX。`role=formula` `kind=math`
- **B（仅兜底）**：无可靠 LaTeX 才页裁切
- **C**：占位「公式」
- 不编造错误 TeX。导出 MD：`$latex$` / `$$latex$$`，否则 Unicode / `[公式]`

### 4.3 图

裁切 + 题注；失败灰底 +「图（见左侧）」；点击同步左栏。

### 4.4 滚动同步

左右页级滚动同步。右栏 FLOAT zoom chip 独立。镜像白纸 + `--oi-mirror-ink: #1a1a1a`。

### 4.5 导出

默认镜像；导出 MD/PDF **阅读序**（含作者、题注、可粘贴 LaTeX），不做像素排版。「原文」清当前页。

### 4.6

只建已译页；>200 items 可合并行；无文本层提示，不编造 bbox。

---

## 5. 文案

公式 / 图（见左侧）/ 版式 | 通读

---

## 6. 总验收清单（合前 · Attention 全文）

- [ ] 全文每页空间关系接近左栏（§4.1）
- [ ] 标题/作者不裁切，作者/摘要/脚注/页边 **无叠字**（§4.1.1）
- [ ] 公式页 KaTeX 优先；可复制 LaTeX；裁切仅兜底（§4.2）
- [ ] 图页：裁切图 + 题注（§4.3）
- [ ] 左右页级滚动同步（§4.4）
- [ ] 导出 MD/PDF 基于阅读序（§4.5）
- [ ] 无文本层不崩溃
- [ ] 不回归：顶栏译/停/范围/导出/缩放 chip
- [ ] 不重开网页 / #36

---

## 7. 里程碑

M3a 文本 bbox → M3b 图 → M3c 公式 LaTeX/KaTeX → M3d 同步+导出

M3c 已在树内（KaTeX 0.18.7 vendored）。本 PR 补 M3a 保真：旋转页边 AABB、作者栅切格、CJK 长高后下推。

---

## 8. 类型

`MirrorItem { id, page, role, bbox, sourceText, translation?, latex?, kind, imageUrl? }`

`role` 含 `title | authors | heading | paragraph | caption | formula | figure | margin`。

pdf.js `getTextContent` + viewport + operator 裁切。KaTeX 0.18.7：`pdf/vendor/katex/`（约 542 KiB）。
