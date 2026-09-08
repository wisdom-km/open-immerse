# Open Immerse

开源的 Chrome **沉浸式双语网页翻译** 扩展。

官方「沉浸式翻译」已闭源。Open Immerse 从零实现同类核心体验：在原文段落下方插入译文，并用**可插拔适配器**接入市面上主流翻译 / LLM API。密钥只存在你自己的浏览器里，请求从本地直达服务商。

仓库：https://github.com/wisdom-km/open-immerse

## 功能（v0.1.1）

- 网页双语对照：识别段落 / 标题 / 列表，译文插在原文下方
- 鼠标悬停翻译
- 划词右键翻译
- 快捷键 `Alt+T` 开关当前页
- 动态页面 MutationObserver
- 跳过代码块、导航短文本
- 本地内存缓存
- 引擎市场：内置 + OpenAI 兼容 + 任意自定义 HTTP

## 支持的引擎

| 引擎 | 默认地址 | 默认模型 |
| --- | --- | --- |
| MyMemory | 免 Key 试用 | — |
| Microsoft Translator | Azure Translator | — |
| DeepL | api-free / api.deepl.com | — |
| Google Cloud Translation | translation.googleapis.com | — |
| OpenAI / 兼容通道 | `https://api.openai.com/v1` | `gpt-4o-mini` |
| **Kimi / 月之暗面** | `https://api.moonshot.cn/v1`（国际可改 `api.moonshot.ai`） | `kimi-k2.5` |
| **MiniMax** | `https://api.minimax.cn/v1`（国际可改 `api.minimax.io`） | `MiniMax-M2.5` |
| **xAI Grok** | `https://api.x.ai/v1` | `grok-4-fast` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| Google Gemini | generativelanguage.googleapis.com | `gemini-2.0-flash` |
| Anthropic Claude | api.anthropic.com | `claude-3-5-haiku-latest` |
| Azure OpenAI | 你的 Azure 终端 | deployment 名 |
| 自定义 HTTP | 任意 | JSON Path |

Kimi / MiniMax / Grok / OpenRouter 都走官方 OpenAI Chat Completions 协议，下拉框里是独立引擎，不用自己猜 Base URL。

## 安装（开发者模式）

1. 克隆仓库
   ```bash
   git clone https://github.com/wisdom-km/open-immerse.git
   ```
2. 打开 Chrome `chrome://extensions`
3. 打开「开发者模式」
4. 「加载已解压的扩展程序」，选中本仓库根目录
5. 点工具栏图标 →「配置 API Key」填写引擎，再打开「翻译当前页面」

已经装过旧版的，`git pull` 后在扩展页点「重新加载」。

## 配置示例

### Kimi

- 引擎：Kimi / 月之暗面
- Key：[platform.kimi.com](https://platform.kimi.com) 或 [platform.kimi.ai](https://platform.kimi.ai)
- 模型可改成 `kimi-k3`、`kimi-k2.5` 等

### MiniMax

- 引擎：MiniMax
- Key：[platform.minimaxi.com](https://platform.minimaxi.com) / [platform.minimax.io](https://platform.minimax.io)
- 模型可改成 `MiniMax-M3`、`MiniMax-M2.5-highspeed`

### Grok

- 引擎：xAI Grok
- Key：[console.x.ai](https://console.x.ai)
- 模型可改成 `grok-4-fast`、`grok-4.6`

### OpenRouter

- 引擎：OpenRouter
- Key：[openrouter.ai/keys](https://openrouter.ai/keys)
- 模型用 OpenRouter 的 `vendor/model` 格式，例如 `anthropic/claude-sonnet-4`、`google/gemini-2.0-flash-001`

### DeepSeek / Ollama

仍走「OpenAI / 兼容通道」：

- DeepSeek Base URL：`https://api.deepseek.com/v1`，模型 `deepseek-chat`
- Ollama Base URL：`http://127.0.0.1:11434/v1`

## 架构

```
popup / options  →  storage.sync
        ↓
background service worker  →  provider.translate()
        ↓
content script  →  扫描 DOM、插入 .oi-translation
```

- content script **不直接请求**外部 API，避免把 Key 暴露到页面世界。
- 新增引擎只改 `lib/providers.js`。

## 路线图

- [ ] 输入框翻译
- [ ] YouTube / 通用字幕双语
- [ ] PDF / EPUB
- [ ] 站点规则订阅
- [ ] Firefox / Safari
- [ ] 术语表与提示词专家
- [ ] Chrome Web Store 发布包

## 安全与合规

- 不收集用户数据，无远程配置服务器。
- 请使用各服务商**官方 API** 与你自己的 Key。
- 不要把 Key 提交进 Git。
- 网页内容会发送到你选择的翻译服务商，请自行判断隐私边界。

## 许可

MIT。欢迎 Issue / PR。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本项目与 immersive-translate 官方扩展无隶属关系。
