# 贡献指南

感谢你来改进 Open Immerse。

## 开发方式

本仓库是 **零构建** 的 Manifest V3 扩展：改完文件后，到 `chrome://extensions` 点「重新加载」即可。

建议目录约定：

- `lib/translate-skill.js`：全厂商共用的翻译 Skill（信达雅合同与默认系统提示词）。质量策略写在这里；`guardZhBusinessSense` / `guardZhTitleCalques` 只是安全网（主教融合、标题套话）。可选两步由顶层 `twoStepPolish`（默认 false）控制：先信后达雅润色，是普通语际转换，不是文言文 / 《诗经》。自定义 `prompt` 非空则跳过第二步。网页与文档共用这一开关。两步时 SW 在终稿返回前先发 `OI_TRANSLATE_PROGRESS`（`phase: "draft"`），页面立刻插入草稿并把同一 toast 改成「润色中」，再用同一节点替换终稿。润色失败时保留草稿，只给短 toast「润色失败」。进度只用 toast，不改 FAB 文案、不遮罩页面。
- `lib/providers.js`：所有翻译引擎。新增引擎时加一个 adapter，并在 `DEFAULT_SETTINGS.providers` 里补默认配置。LLM adapter 走 `resolveTranslatorPrompt` + `translateWithSkill`，模型从 `ctx.settings.model` 读，不要写死厂商。聊天补全类 adapter 必须走同一条两步路径。
- `content/`：只负责 DOM 扫描与插入译文，不直接发外部请求。
- `background/`：统一调度 API、缓存、右键菜单、快捷键。
- `popup/` 与 `options/`：只读写 `chrome.storage.sync`。弹层「翻译当前页面」以当前页 `OI_PING`（`html.oi-active` / 是否已有译文）为准，不要用全局 `enabled` 当本页状态。当前页像 PDF 时弹层展示「在沉浸译中打开」。
- `pdf/`：扩展自有 pdf.js 阅读器（M1：打开本地/链接 PDF、翻页、缩放；整页翻译走 M2 的 `OI_TRANSLATE_BATCH`）。
- `content/content.js`：DOM 扫描与插入译文。关掉翻译必须 `restore()`（`OI_STOP` 也走 restore）。不要用 `PAGE_EXTRA` 收导航链接；顶栏和右侧元信息即使 scope=page 也硬跳过。

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
