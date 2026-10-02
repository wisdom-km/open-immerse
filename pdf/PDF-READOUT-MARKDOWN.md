# PDF-READOUT-MARKDOWN（草稿 / 指针）

**本文不是本单权威。**

本轨产品与工程锁以同目录 **`PDF-MD-READOUT.md`** 为准。  
任何冲突（含入口是否隐藏、是否 bbox 镜像、是否改网页）一律以 `PDF-MD-READOUT.md` 为准。

定案摘要（详见权威文，勿在本文扩写需求）：

- 原文栏：现有 pdf.js 原文
- 右栏：Markdown `.readout` 通读。译文只在右栏。当前已发布的 `surface="redraw"` 按 `pdf/high-precision/REQUIREMENTS.md` §2.6 算第一层：原页区域高清重渲染，本质上是区域渲染（详见权威文）
- 不把译文贴进原文栏 bbox（#40 closed）
- **不**藏弹层 PDF 入口（`PDF-ENTRY-SECONDARY` 本轨作废）
- **不**回归网页 content / Options
