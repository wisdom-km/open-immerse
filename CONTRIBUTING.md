# 贡献指南

感谢你来改进 Open Immerse。

## 开发方式

本仓库是 **零构建** 的 Manifest V3 扩展：改完文件后，到 `chrome://extensions` 点「重新加载」即可。

建议目录约定：

- `lib/providers.js`：所有翻译引擎。新增引擎时加一个 adapter，并在 `DEFAULT_SETTINGS.providers` 里补默认配置。
- `content/`：只负责 DOM 扫描与插入译文，不直接发外部请求。
- `background/`：统一调度 API、缓存、右键菜单、快捷键。
- `popup/` 与 `options/`：只读写 `chrome.storage.sync`。弹层「翻译当前页面」以当前页 `OI_PING`（`html.oi-active` / 是否已有译文）为准，不要用全局 `enabled` 当本页状态。
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
