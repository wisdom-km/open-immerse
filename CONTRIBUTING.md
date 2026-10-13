# 贡献指南

感谢你来改进 Open Immerse。

## 开发方式

本仓库是 **零构建** 的 Manifest V3 扩展：改完文件后，到 `chrome://extensions` 点「重新加载」即可。

建议目录约定：

- `lib/translate-skill.js`：全厂商共用的翻译 Skill（信达雅合同与默认系统提示词）。质量策略写在这里；`guardZhBusinessSense` / `guardZhTitleCalques` 只是安全网（主教融合、标题套话）。可选两步由顶层 `twoStepPolish`（默认 true，设置页主界面「先信后润」）控制：先信后达雅润色，是普通语际转换，不是文言文 / 《诗经》。自定义 `prompt` 非空则跳过第二步。网页与文档共用这一开关。两步时 SW 在终稿返回前先发 `OI_TRANSLATE_PROGRESS`（`phase: "draft"`），页面立刻插入草稿并把同一 toast 改成「润色中」，再用同一节点替换终稿。润色失败时保留草稿，只给短 toast「润色失败」。进度只用 toast，不改 FAB 文案、不遮罩页面。
- `lib/providers.js`：所有翻译引擎。新增引擎时加一个 adapter，并在 `DEFAULT_SETTINGS.providers` 里补默认配置。LLM adapter 走 `resolveTranslatorPrompt` + `translateWithSkill`，模型从 `ctx.settings.model` 读，不要写死厂商。聊天补全类 adapter 必须走同一条两步路径。可选「深度思考」由顶层 `deepThink`（默认 false）控制：仅 Ark / DeepSeek 在关时带 `thinking.type=disabled` 和 `reasoning_effort=minimal`；其他引擎省略字段、不得报错。网页 / PDF / 文档共用。不要改主翻译流式，也不要为思考模型单独改 Skill。
- `content/`：只负责 DOM 扫描与插入译文，不直接发外部请求。
- `background/`：统一调度 API、缓存、右键菜单、快捷键。
- `popup/` 与 `options/`：只读写 `chrome.storage.sync`。例外（2026-10-13 Wisdom 定，F3 PR3）：多模态 / OCR 的 API key 存 `chrome.storage.local`，绝不进 sync。见 `pdf/high-precision/REQUIREMENTS.md` §2.6「开关」。弹层是意图卡：主按钮「翻译此页」进行中变为「停止」（`OI_STOP` → `abort()`，保留译文），次按钮「恢复原文」（`OI_RESTORE`）。本页是否在译以 `OI_PING.inflight`（`html.oi-active`）为准，不要用全局 `enabled` 当本页状态。底部 **设置 · 学习 · 文档**；`features.pdf` 开时才出现 **PDF**。当前页像 PDF 且实验室开时展示「在沉浸译中打开（实验室）」。设置页四组：引擎 / 阅读 / 功能 / 高级。阅读只留字号与两段间距，不要加回译文样式下拉或预览表。弹层、FAB、页面 chrome 不要进度条或百分比。
- 高精度 PDF：现行计划见 `docs/ui-phase2-plan.md`（路线图 v2），需求正本是 `pdf/high-precision/REQUIREMENTS.md`。公式目标是核对过的 KaTeX，判不出时显示原页裁图；图、表仍是原页裁图，正文走文字层。F1、F5、F8 等步骤需要改 `pdf/viewer.js`，按路线图分步做。
- `pdf/`：扩展自有 pdf.js 阅读器。打开本地/链接 PDF、左侧连续滚动（上一页/下一页仍可用）、缩放。顶栏顺序：`#docStatus`（已译 n / t 页或全文已译，与按钮同一水平中线、高 30）→ 打开 PDF（Secondary）→ 翻译（Primary）→ 重译本页（Secondary）→ 停止（Primary，只在 busy 时显示）→ 原文（Ghost，只切换 `data-view`，不中止会话、不清缓存）→ 上一页（Ghost）→ `#pager` → 下一页（Ghost）→ Aa（Ghost）。导出 MD/PDF 在「更多」菜单里，是菜单项，不是顶栏 Ghost 按钮。没有「当前页 / 全文」分段。打开即自动全文翻译；设置项 `pdfAutoTranslate` 默认开，关掉后要再点「翻译」。缩放（缩小 / % / 放大）左栏 `#zoomChip` 只缩放 PDF（`zoom` / `pdfZoomChipPos`）；右栏 `#mirrorZoomChip.zoom-gutter` 同款 FLOAT 芯片（默认右下+滚动条 gutter，可拖、6px 阈值、持久化 `pdfMirrorZoom` + `pdfMirrorZoomChipPos`），独立 `mirrorZoom` 0.5–5 步 0.25。不进顶栏、不贴中缝、不拐角吸附。镜像白纸 `#fff` + `--oi-mirror-ink: #1a1a1a`，不继承暗色 `--oi-text`。`#pages` / `#translateScroll` 负责各栏滚动。全高 `.split-handle`（12px 热区、`col-resize`，默认透明，hover 1px accent 轨，`.workspace.is-splitting` 时 2px accent）拖左右栏。页内进度「正在翻译 · k / m 段」，按页走 `OI_TRANSLATE_BATCH`，可停止，不整本一次送模型。没有版面的排队页收成一行 `.rf-q`。工具栏方案 B（对齐网页 FAB）：「停止」只在 busy 时显示；用户停止 / 批次结束 / 出错后立刻回「翻译」为主按钮，已译中文保留在 readout。停止中止后续页/段批次，不走 `clearPage`。已完成的页不要 `replaceChildren` 整栏重建。右侧默认**Markdown 通读**（`.pane-translate > .readout.md-readout`）：按阅读顺序抽出标题 + 正文（双栏先左后右），滤页眉/页脚/页码，译成目标语言后渲染成可滚动 Markdown 文档。不要复活 bbox 版式镜像（作者格重叠、arXiv 贯穿摘要）。块级：title / authors / heading / caption / paragraph / formula / figure。作者格合并成一行 byline。图、公式、表在右栏默认是原页裁图。公式可来自核对过的 LaTeX（KaTeX）渲染，判不出时显示原页裁图；其他手段必须与打开的 PDF 同一套内容。vendored `pdf/vendor/katex/`（KaTeX 0.18.7，woff2 only，约 542 KiB）仍留在仓库。KaTeX 用于第 0/2 级及 OCR 结果上屏（`throwOnError: true`、`trust: false`），当前第 0 级在内部旗标后默认关。左右栏默认各自滚动。无文字层不编造正文。空闲「点击翻译」；进行中无段时「正在翻译，请稍候…」。导出 MD/PDF 阅读序中文（含作者、题注与可粘贴 LaTeX），不做像素排版。不按块收藏、默认不展示原文摘录。设置页已经没有「左右栏换页跟随」；`pdfScroll.softPageFollow` 是废弃字段，仍在 `lib/storage.js` 里归一化，不迁到 `reader.follow`（见 `docs/owner-todo.md`）。已译页缓存在阅读器内；**原文**只切换 `data-view`，不中止会话、不清缓存。正文 OCR 只在没有可信文字层时用；公式 OCR API 见 F9。不注入 Chrome PDF Viewer。
- `content/content.js`：DOM 扫描与插入译文。FAB 左键方案 B：`idle` / `translating` / `translated`。「停止」只 `abort()` inflight，保留 `.oi-translation`，不走 `restore()`。译完必须清掉 `oi-active` / `running`，左键回到「翻译」。「原文」、弹层「恢复原文」、`OI_RESTORE` 才 `restore()`。`OI_STOP` 与 FAB「停止」只 `abort()`。不要用 `PAGE_EXTRA` 收裸 `a`。PAGE-SCOPE-FULL / PAGE-SCOPE-SIDEBAR-NAV：`article` 只收 main/article 主栏，H1 须在主栏，不捞页头 logo，整段侧栏仍跳过；`page` 另收侧栏可读段/标题（含 Getting started / Topics / TOC 等短链，不得因 `isTinyChrome` length<48 丢掉），并用约 1 条主 H1 启发式收下 `header`/`[role=banner]` 里的文章标题，禁止 `closest('header')` 一刀切。两端仍跳过顶栏导航、菜单、面包屑、页脚链接堆、cookie 条、code/`.oi-*`。与 `lib/page-scan.js` 保持一致。PDF 阅读器已取消「当前页/全文」分段，不要加回去。

纯函数测试：

```bash
node --test tests/*.test.mjs
```

顶栏几何（需要本机夹具 `tests/fixtures/Attention_Is_All_You_Need.pdf`，不要把 PDF 提交进仓库）：

```bash
node --test tests/pdf-topbar-geometry.test.mjs
```

## 顶栏新按钮

栏高 48，光学中线 y=24。底部分割线是 `box-shadow: inset 0 -1px 0 var(--oi-reader-line)`，不占布局。不要把 `border-bottom` 写回去，也不要把 `--oi-reader-topbar-h` 改成 49。

新控件上栏前过这 4 条。`tests/pdf-topbar-geometry.test.mjs` 会遍历 `.toolbar` 下所有可见控件，不维护 id 名单；塞进顶栏的按钮会自动被量到。

1. 归类型：`data-tb="icon"`（30×30 图标）、`data-tb="text"`（图标+文字或纯文字，高 30）或 `data-tb="status"`（状态槽，高 30）。相对顶栏的 top 是 9。
2. 盒子中线在 y=24 ± 0.5。DPR 1 下 left、top、width、height 都是整数。带文字的控件在挂载时、以及 `document.fonts` 的 `loadingdone` 时，把宽度向上取整。
3. 同一类型、同一字号、同一光学修正（例如页码 `.pager-ink` 的 `-1.5px`）的文字，alphabetic baseline 相差不超过 0.5px。
4. 焦点框（2px 线 + 2px offset）不被 `overflow` 裁切，并且完整落在视口里。

## 新增翻译引擎

1. 在 `providers` 对象中增加 `{ id, name, kind, fields, translate }`。
2. `translate(texts, ctx)` 必须返回与输入等长的 `string[]`。
3. 密钥从 `ctx.settings` 读取，不要写死。
4. 在 README 的引擎表里补一行。

## 合入流程

每个 PR 都按这个流程走，其他文件引用这一节：

1. Cloud 写代码。全量 `node --test tests/*.test.mjs` 0 失败、0 skipped。锁定的测试预期值一律不许改；确实要改，逐条列出原因，等批准。
2. Forge 先看 diff。
3. Anvil 在 Box 和真机上用 Attention 夹具实测。
4. Wisdom 用 widget 批准。
5. Jone squash 合入 main。不 force push。

## 派 Cloud 的固定模板

派 Cloud 时把验收写清楚，并带上这些限制：

- 尽量只改测试。
- 产品代码只允许加只读的完成信号，不许改行为。
- 任何产品代码改动都必须在报告里逐条说明原因。合入前由 Forge 先看 diff。
- Anvil 复测时专门核对是不是只加了标记。
- 锁定的测试预期值一律不许改。这包括块数、块 id、重复 id、旧译复用条数。确实要改，就逐条列出原因，等批准。

## Pull Request

- 一个 PR 只做一件事。
- 不要提交 API Key、`.env`、打包 zip。
- 说明测试过的页面与引擎。
