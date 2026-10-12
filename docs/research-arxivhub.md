# ArXivHub 备忘

备忘，待融合（Wisdom 2026-10-12）。顺序见路线图 v2（`docs/ui-phase2-plan.md`，2026-10-12 23:52）。

来源：[ArXivHub](https://github.com/Peaceful-World-X/ArXivHub)（MIT）。它是链接导航站，不是 PDF 阅读器。下面只记可借的做法和明确不抄的部分。层号和运行时 7 级顺序不改。文献库存储的落地顺序见路线图 v2 的 F4。

## 可借

- **编号和元数据。** 规范化 arXiv 编号，并用官方 arXiv API、DataCite API 取题名、作者、DOI 和 BibTeX。结果供运行时第 1 步（第零层 arXiv 源码）和文献库使用。这一步归路线图 v2 的 F2（arXiv P1–P4，纯 lib + background）。不把这一步改叫第一层，层号不动。
- **KaTeX 安全渲染。** 模型或看图返回的 LaTeX 先写进 `textContent`，再 auto-render。两种用法分开：回退链里判断「能不能渲染」（多模态、OCR、源码候选能否上屏）一律用 `throwOnError: true`，失败就退回原页裁图；问 AI 回答里的展示可以用 `throwOnError: false`。两种都用 `trust: false`。不替换第零层已确认的核对规则。
- **外部请求要扛得住。** 超时、缓存、在途请求去重、把限速退避记下来、滤掉占位文字。多模态适配器和 OCR 适配器都按这个做。
- **以后：「在…中打开」。** 选择工具条或文献库卡片上放一个菜单，收 5–8 个站点（alphaXiv、Semantic Scholar 等），并允许用户自定义 URL 模板。排在打磨池之后的「以后」，不进 F1–F9。
- **以后：引用次数。** 文献库卡片上显示引用次数。排在打磨池之后的「以后」，不进 F1–F9。

## 不抄

- 不抄第三方代理（`r.jina.ai`、microlink）。有隐私问题，也不稳定，和本地优先冲突。要数据就直接调官方 API。
- 不抄那张 100 多个站点的表，也不抄用户脚本那套界面。
- 许可证是 MIT。若复用它的代码，保留版权声明。
