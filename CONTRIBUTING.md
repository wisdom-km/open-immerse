# 贡献指南

感谢你来改进 Open Immerse。

## UI 设计

所有 UI 设计由 Loom 先调研同类产品再出规格，实现方不自行设计（Wisdom 定）。设置页规格是 [`docs/settings-spec.md`](docs/settings-spec.md)。

## 开发方式

本仓库是 **零构建** 的 Manifest V3 扩展：改完文件后，到 `chrome://extensions` 点「重新加载」即可。

建议目录约定：

- `lib/translate-skill.js`：全厂商共用的翻译 Skill（信达雅合同与默认系统提示词）。质量策略写在这里；`guardZhBusinessSense` / `guardZhTitleCalques` 只是安全网（主教融合、标题套话）。可选两步由顶层 `twoStepPolish`（默认 true，设置页主界面「先信后润」）控制：先信后达雅润色，是普通语际转换，不是文言文 / 《诗经》。自定义 `prompt` 非空则跳过第二步。网页与文档共用这一开关。两步时 SW 在终稿返回前先发 `OI_TRANSLATE_PROGRESS`（`phase: "draft"`），页面立刻插入草稿并把同一 toast 改成「润色中」，再用同一节点替换终稿。润色失败时保留草稿，只给短 toast「润色失败」。进度只用 toast，不改 FAB 文案、不遮罩页面。
- `lib/providers.js`：所有翻译引擎。新增引擎时加一个 adapter，并在 `DEFAULT_SETTINGS.providers` 里补默认配置。LLM adapter 走 `resolveTranslatorPrompt` + `translateWithSkill`，模型从 `ctx.settings.model` 读，不要写死厂商。聊天补全类 adapter 必须走同一条两步路径。可选「深度思考」由顶层 `deepThink`（默认 false）控制：仅 Ark / DeepSeek 在关时带 `thinking.type=disabled` 和 `reasoning_effort=minimal`；其他引擎省略字段、不得报错。网页 / PDF / 文档共用。不要改主翻译流式，也不要为思考模型单独改 Skill。
- `content/`：只负责 DOM 扫描与插入译文，不直接发外部请求。
- `background/`：统一调度 API、缓存、右键菜单、快捷键。
- `popup/` 与 `options/`：非密钥设置读写 `chrome.storage.sync`。所有密钥只存 `chrome.storage.local`，不进 sync（2026-10-13 12:19–12:23 Wisdom 定）。翻译密钥、PDF 云端密钥、多模态 / OCR 密钥都在 local；11:57 只把多模态 / OCR 放 local 的例外收成这一条。以后做 F10 云同步时，密钥是否跟账号同步由用户选择，沿用 11:57 预留的接口。翻译密钥和 PDF 云端密钥从 sync 迁过来，迁移、导入和回滚都要有测试。2026-10-13 17:29 Wisdom 定：导出拆成「文献库」和「设置」两个文件，都不含任何 API key；设置导出不带 key，导入设置也不写入 key。sync 里已有的 key 先迁到 local 再删掉。见 `docs/settings-spec.md` §2。已定，待设置页重设计 PR 实现；合入前这两处密钥仍在 sync。见 `docs/ui-phase2-plan.md`「设置页重设计」。笔记面板偏好（2026-10-13 11:55 定，12:00 确认）从 `localStorage` 改存 `chrome.storage.local`，和其他设置放在一起，不进 sync。旧值自动迁移，不能丢。后台和设置页都能读。实现已合入（#130，`4e0a705`）。键是 `reader.panelWidth`、`reader.notesWidth`、`reader.notesPaneSide`、`reader.notesPersistHintDismissed`（一个键，值是 docHash 到 true 的映射），见 `docs/ui-phase2-plan.md` 第 4 节和 `docs/settings-spec.md`。弹层是意图卡：主按钮「翻译此页」进行中变为「停止」（`OI_STOP` → `abort()`，保留译文），次按钮「恢复原文」（`OI_RESTORE`）。本页是否在译以 `OI_PING.inflight`（`html.oi-active`）为准，不要用全局 `enabled` 当本页状态。底部 **设置 · 学习 · 文档**；`features.pdf` 开时才出现 **PDF**。当前页像 PDF 且实验室开时展示「在沉浸译中打开（实验室）」。设置页现在仍是四组：引擎 / 阅读 / 功能 / 高级。已定改成 8 个一级页，页名见 [`docs/settings-spec.md`](docs/settings-spec.md)（`#translate`、`#mm`、`#web`、`#pdf`、`#notes`、`#labs`、`#data`、`#about`；验收 SET-01…SET-31，2026-10-13 12:19–12:23，2026-10-13 13:01 Wisdom 批准）。「多模态 · OCR」是一级页（`#mm`，常规组第 2 位，不进高级），不是一节。问 AI 不再单独设一页，也不单独配模型；`ask.model` 作废，旧链接 `#ai` 跳到 `#mm`。设置即时保存，去掉「保存设置」，密钥在离开输入框或按回车时提交。空输入不覆盖已存密钥；清除密钥只通过『移除』（可撤销）（SET-05、SET-07）。PDF 阅读开关关闭时不隐藏「多模态 · OCR」页，只在页顶加一行提示和「开启」链接。这些都还没实现，待设置页重设计 PR。阅读只留字号与两段间距，不要加回译文样式下拉或预览表。弹层、FAB、页面 chrome 不要进度条或百分比。
- 高精度 PDF：现行计划见 `docs/ui-phase2-plan.md`（路线图 v2），需求正本是 `pdf/high-precision/REQUIREMENTS.md`。公式目标是核对过的 KaTeX，判不出时显示原页裁图；图、表仍是原页裁图，正文走文字层。F1、F5、F8 等步骤需要改 `pdf/viewer.js`，按路线图分步做。
- `pdf/`：扩展自有 pdf.js 阅读器。打开本地/链接 PDF、左侧连续滚动（上一页/下一页仍可用）、缩放。顶栏顺序：`#docStatus`（已译 n / t 页或全文已译，与按钮同一水平中线、高 30）→ 打开 PDF（Secondary）→ 翻译（Primary）→ 重译本页（Secondary）→ 停止（Primary，只在 busy 时显示）→ 原文（Ghost，只切换 `data-view`，不中止会话、不清缓存）→ 上一页（Ghost）→ `#pager` → 下一页（Ghost）→ Aa（Ghost）。导出 MD/PDF 在「更多」菜单里，是菜单项，不是顶栏 Ghost 按钮。没有「当前页 / 全文」分段。打开即自动全文翻译；设置项 `pdfAutoTranslate` 默认开，关掉后要再点「翻译」。缩放（缩小 / % / 放大）左栏 `#zoomChip` 只缩放 PDF（`zoom` / `pdfZoomChipPos`）；右栏 `#mirrorZoomChip.zoom-gutter` 同款 FLOAT 芯片（默认右下+滚动条 gutter，可拖、6px 阈值、持久化 `pdfMirrorZoom` + `pdfMirrorZoomChipPos`），独立 `mirrorZoom` 0.5–5 步 0.25。不进顶栏、不贴中缝、不拐角吸附。镜像白纸 `#fff` + `--oi-mirror-ink: #1a1a1a`，不继承暗色 `--oi-text`。`#pages` / `#translateScroll` 负责各栏滚动。全高 `.split-handle`（12px 热区、`col-resize`，默认透明，hover 1px accent 轨，`.workspace.is-splitting` 时 2px accent）拖左右栏。页内进度「正在翻译 · k / m 段」，按页走 `OI_TRANSLATE_BATCH`，可停止，不整本一次送模型。没有版面的排队页收成一行 `.rf-q`。工具栏方案 B（对齐网页 FAB）：「停止」只在 busy 时显示；用户停止 / 批次结束 / 出错后立刻回「翻译」为主按钮，已译中文保留在 readout。停止中止后续页/段批次，不走 `clearPage`。已完成的页不要 `replaceChildren` 整栏重建。右侧默认**Markdown 通读**（`.pane-translate > .readout.md-readout`）：按阅读顺序抽出标题 + 正文（双栏先左后右），滤页眉/页脚/页码，译成目标语言后渲染成可滚动 Markdown 文档。不要复活 bbox 版式镜像（作者格重叠、arXiv 贯穿摘要）。块级：title / authors / heading / caption / paragraph / formula / figure。作者格合并成一行 byline。图、公式、表在右栏默认是原页裁图。公式可来自核对过的 LaTeX（KaTeX）渲染，判不出时显示原页裁图；其他手段必须与打开的 PDF 同一套内容。vendored `pdf/vendor/katex/`（KaTeX 0.18.7，woff2 only，约 542 KiB）仍留在仓库。KaTeX 用于第 0/2 级及 OCR 结果上屏（`throwOnError: true`、`trust: false`），当前第 0 级在内部旗标后默认关。左右栏默认各自滚动。无文字层不编造正文。空闲「点击翻译」；进行中无段时「正在翻译，请稍候…」。导出 MD/PDF 阅读序中文（含作者、题注与可粘贴 LaTeX），不做像素排版。不按块收藏、默认不展示原文摘录。设置页已经没有「左右栏换页跟随」；`pdfScroll.softPageFollow` 是废弃字段，仍在 `lib/storage.js` 里归一化，不迁到 `reader.follow`（见 `docs/owner-todo.md`）。已译页缓存在阅读器内；**原文**只切换 `data-view`，不中止会话、不清缓存。OCR 在 F9 做，至少接智谱和百度，再加其他识别率高的模型，具体名单在开工前调研后由 Wisdom 选定（2026-10-13 11:57）。公式用 LaTeX（KaTeX）渲染。不注入 Chrome PDF Viewer。
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

1. Cloud 写代码。全量 `node --test tests/*.test.mjs` 0 失败、0 skipped。锁定的测试预期值一律不许改；确实要改，逐条列出原因，等批准。AX-23（Wisdom 2026-10-13 10:36 批准）：只放开 viewer（`pdf/viewer.js`）。`lib/notes-*` 相对 main 继续锁定，不得改动，`tests/arxiv-regression.test.mjs` 锁着这条。service worker 直接静态导入 `background/formula-cache.js`。
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
- 每一项 Cloud 任务都必须满足下一节「交付前刁钻自测」。
- 涉及共享状态的任务必须满足「共享状态：不变量优先」。
- Cloud 交付时必须附刁钻场景覆盖清单，缺一类即 FAIL。

## 交付前刁钻自测

Wisdom 2026-10-16 批准。交付前按下面六类自测。

1. **并发。** 跨标签页、跨引擎、跨数据项交错写入。写入只改自己负责的那一项，不整份覆盖别人的数据。
2. **页面生命周期。** 刷新或关闭时锁真正释放。操作做到一半页面被关，重开后能把状态对回来。
3. **新旧版本兼容。** 旧版后台配新版页面。新旧数据混在一起。
4. **失败与回滚。** 只回滚自己那一项。界面有提示，不静默丢数据。
5. **边界输入。** 大小写变体、前缀和后缀、空值、超长内容、特殊字符。
6. **交付要求。** 每一类先写测试，先失败再修到通过。PR 说明列出覆盖了哪几类，不适用的写明原因。合并主线的提交只解决冲突，新逻辑放单独提交。

这条来自 [#137](https://github.com/wisdom-km/open-immerse/pull/137)：跨引擎写 `oiSecrets` 时整袋覆盖；旧后台在页面重载后仍把飞行中的保存写回去。

## 五层审查

Wisdom 2026-10-16 批准。从便宜到贵，按这五层审。

1. **契约与回归。** 全量套件必须全绿。锁住的测试字节级不变。
2. **对抗自测。** 见「交付前刁钻自测」。每类先红再绿。
3. **差分审查。** 只看本 PR 真正改的内容。合并提交只解决冲突。
4. **属性/混沌抽检。** 对存储、锁、序号等共享状态，用任意交错顺序或小规模随机交错重复跑几十次，专抓测试绿但真机红的竞态。可用 `node --test` 加模拟双页或双引擎，不强制新框架。如需再考虑 fast-check，不在这里引入依赖。
5. **真机冒烟。** 最后由 Anvil 在真机上用最短路径验证用户真能碰到的场景。

### 共享状态：不变量优先

Wisdom 2026-10-17。共享状态在「交付前刁钻自测」和五层审查里按这三条。

1. **先写不变量，再写代码。** 涉及共享状态的 PR，PR 说明里先列不变量（如 sync 与本机最终一致、已确认序号只增不减、删除不会复活），每条写成断言，放进随机测试每一步都检查。
2. **改到哪里，就攻击到哪里。** 新增或修改的每个函数都列出「这里可能被打断的点」，每个点至少加一个刁钻测试；不能只复测旧洞。
3. **随机测试事件覆盖全组合。** 多标签页 × 新旧后台 × 保存中途卸载 × 失败与重试；至少 500 个种子，失败时输出种子。

## Pull Request

- 一个 PR 只做一件事。
- 不要提交 API Key、`.env`、打包 zip。
- 说明测试过的页面与引擎。
