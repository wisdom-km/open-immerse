# PDF 右栏 · 版式保真（PDF-MIRROR-LAYOUT-FIDELITY）

Hard gate. Companion to `PDF-READOUT-MIRROR.md` §4.1.

样例：Attention Is All You Need / arXiv 1706.03762（`tests/fixtures/Attention_Is_All_You_Need.pdf`）。
失败对照：右栏乱码叠墨（作者互盖、arXiv 横切入摘要、栏序打乱）。

## Locked rules

1. **按页 bbox 镜像左栏**。右栏块的位置、栏结构、阅读序跟踪原页，而不是通读流重排。
2. **禁止叠墨**。标题 / 作者栅 / 摘要 / 正文 / 脚注不得互相盖住。CJK 长高后推开后行，不缩字号。
3. **禁止串栏**。旋转页边（transform 近 90°）必须落成瘦高竖条，不得把 `width`（沿字向前进）当成横宽切进摘要。
4. **作者栅可读**。同一行姓名 / 单位 / 邮箱按间隙切格，不得合成一行互叠。
5. **验收全文**，不是只验收第 1 页。15 页的标题、作者、公式、图、双栏都要各就各位。
6. 公式仍优先 KaTeX / LaTeX；导出仍是阅读序，不是像素排版。
7. 不重开网页 / #36 侧栏配对。

## Geometry

- pdf.js `transform` → 轴对齐 user-space AABB。竖排：`dir=vertical`，CSS `writing-mode: vertical-rl`。
- 竖排 run 不与横排行聚类、不与正文合并。
- 双栏阅读序忽略页边条。
- 栅格行：邮箱 / 短单元格间隙 ≥ 0.8em 即切，不因 dense 页并成一行。

## Acceptance

- Attention 全文每一页：同源文本框无大面积重叠
- 第 1 页：标题、作者格分列、Abstract 为 heading、arXiv 条在左缘且不进入摘要文本
- 阅读序：标题 → 作者 → 摘要 → 正文 / 脚注；页边条不插入摘要中间
- CJK 不裁切（见 `PDF-MIRROR-CJK-CLIP.md`）且不叠墨
- `node --test` 通过
