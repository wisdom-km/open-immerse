# 贡献指南

感谢你来改进 Open Immerse。

## 开发方式

本仓库是 **零构建** 的 Manifest V3 扩展：改完文件后，到 `chrome://extensions` 点「重新加载」即可。

建议目录约定：

- `lib/translate-skill.js`：全厂商共用的翻译 Skill（信达雅合同与默认系统提示词）。质量策略写在这里；`guardZhBusinessSense` / `guardZhTitleCalques` 只是安全网（主教融合、标题套话）。可选两步由顶层 `twoStepPolish`（默认 false）控制：先信后达雅润色，是普通语际转换，不是文言文 / 《诗经》。自定义 `prompt` 非空则跳过第二步。网页与文档共用这一开关。两步时 SW 在终稿返回前先发 `OI_TRANSLATE_PROGRESS`（`phase: "draft"`），页面立刻插入草稿并把同一 toast 改成「润色中」，再用同一节点替换终稿。润色失败时保留草稿，只给短 toast「润色失败」。进度只用 toast，不改 FAB 文案、不遮罩页面。
- `lib/providers.js`：所有翻译引擎。新增引擎时加一个 adapter，并在 `DEFAULT_SETTINGS.providers` 里补默认配置。LLM adapter 走 `resolveTranslatorPrompt` + `translateWithSkill`，模型从 `ctx.settings.model` 读，不要写死厂商。聊天补全类 adapter 必须走同一条两步路径。可选「深度思考」由顶层 `deepThink`（默认 false）控制：仅 Ark / DeepSeek 在关时带 `thinking.type=disabled` 和 `reasoning_effort=minimal`；其他引擎省略字段、不得报错。网页 / PDF / 文档共用。不要改主翻译流式，也不要为思考模型单独改 Skill。
- `content/`：只负责 DOM 扫描与插入译文，不直接发外部请求。
- `background/`：统一调度 API、缓存、右键菜单、快捷键。
- `popup/` 与 `options/`：只读写 `chrome.storage.sync`。弹层「翻译当前页面」以当前页 `OI_PING`（`html.oi-active` / 是否已有译文）为准，不要用全局 `enabled` 当本页状态。当前页像 PDF 时弹层展示「在沉浸译中打开」。
- `pdf/`：扩展自有 pdf.js 阅读器。打开本地/链接 PDF、左侧连续滚动（上一页/下一页仍可用）、缩放。顶栏顺序：打开 PDF（Secondary）→ `当前页 | 全文` 分段（`.scope-seg`，默认当前页，非 Primary，切换不自动开译）→ 翻译/停止（Primary）→ 原文（Ghost）→ 翻页。缩放（缩小 / % / 放大）是 `.pane-pdf` 内右下角绝对定位的 `.zoom-gutter` 横排 pill（`right/bottom: 12px`，轻玻璃、无重阴影），不进顶栏、不占中缝；`#pages` 负责滚动。全高 `.split-handle`（12px 热区、`col-resize`，默认透明，hover 1px accent 轨，`.workspace.is-splitting` 时 2px accent）拖左右栏。全文进度 `翻译中 · k/n`，按页走 `OI_TRANSLATE_BATCH`，可停止，不整本一次送模型。工具栏方案 B（对齐网页 FAB）：「停止」只在 busy 时显示；用户停止 / 批次结束 / 出错后立刻回「翻译」为主按钮，已译中文保留在 readout。停止中止后续页/段批次，不走 `clearPage`。`.scope-seg` 仅非 busy 时可点。右侧累计已译页的连续中文（`.pane-translate .readout > h1.oi-pdf-h1 / h2.oi-pdf-h2 / p.oi-pdf-p`，节点带 `data-page`）。空闲且无译文时 `.empty-read`「点击翻译」；翻译进行中且还没有段落时改显示「正在翻译，请稍候…」，首段到达后换成 h1/h2/p。不按块收藏、默认不展示原文摘录。左侧滚动时若该页已译，右侧弱同步到对应段落。已译页缓存在阅读器内；**原文只清空当前页**（`clearPage`），不清全文。不做 OCR、也不注入 Chrome PDF Viewer。
- `content/content.js`：DOM 扫描与插入译文。FAB 左键方案 B：`idle` / `translating` / `translated`。「停止」只 `abort()` inflight，保留 `.oi-translation`，不走 `restore()`。译完必须清掉 `oi-active` / `running`，左键回到「翻译」。「原文」、弹层关掉「翻译此页」、`OI_STOP` / `OI_RESTORE` 才 `restore()`。不要用 `PAGE_EXTRA` 收导航链接；顶栏和右侧元信息即使 scope=page 也硬跳过。

纯函数测试：

```bash
node --test tests/*.test.mjs
```

## 新增翻译引擎

1. 在 `providers` 对象中增加 `{ id, name, kind, fields, translate }`。
2. `translate(texts, ctx)` 必须返回与输入等长的 `string[]`。
3. 密钥从 `ctx.settings` 读取，不要写死。
4. 在 README 的引擎表里补一行。

## Pull Request

- 一个 PR 只做一件事。
- 不要提交 API Key、`.env`、打包 zip。
- 说明测试过的页面与引擎。
