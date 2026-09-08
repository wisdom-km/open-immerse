# Open Immerse

开源的 Chrome **沉浸式双语网页翻译** 扩展。

官方「沉浸式翻译」已闭源。Open Immerse 从零实现同类核心体验：在原文段落下方插入译文，并用**可插拔适配器**接入市面上主流翻译 / LLM API。密钥只存在你自己的浏览器里，请求从本地直达服务商。

仓库：https://github.com/wisdom-km/open-immerse

## 功能（v0.1）

- 网页双语对照：识别段落 / 标题 / 列表，译文插在原文下方
- 鼠标悬停翻译
- 划词右键翻译
- 快捷键 `Alt+T` 开关当前页
- 动态页面 MutationObserver
- 跳过代码块、导航短文本
- 本地内存缓存
- 引擎市场：内置 + OpenAI 兼容 + 任意自定义 HTTP

## 支持的引擎

| 引擎 | 说明 |
| --- | --- |
| MyMemory | 免 Key 试用（额度有限） |
| Microsoft Translator | Azure 翻译订阅 |
| DeepL | Free / Pro |
| Google Cloud Translation | 官方 v2 |
| OpenAI 兼容 | OpenAI、DeepSeek、通义、Moonshot、Groq、SiliconFlow、OpenRouter、Ollama、LM Studio、xAI Grok… 只需改 Base URL |
| Google Gemini | 官方 generateContent |
| Anthropic Claude | Messages API |
| Azure OpenAI | deployment + api-key |
| 百度翻译 | APP ID + Secret |
| 自定义 HTTP | URL / Header / Body 模板 / JSON Path |

「接入所有主流 API」靠两层实现：常用引擎写死适配器；其余全部走 OpenAI 兼容通道或自定义 HTTP 模板。

## 安装（开发者模式）

1. 克隆仓库
   ```bash
   git clone https://github.com/wisdom-km/open-immerse.git
   ```
2. 打开 Chrome `chrome://extensions`
3. 打开「开发者模式」
4. 「加载已解压的扩展程序」，选中本仓库根目录
5. 点工具栏图标 →「配置 API Key」填写引擎，再打开「翻译当前页面」

Firefox / Edge 的 Chromium 内核同样可加载，后续再补 Firefox 专用 manifest。

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

## 配置示例

DeepSeek（走 OpenAI 兼容）：

- 引擎：OpenAI 兼容
- Base URL：`https://api.deepseek.com/v1`
- Model：`deepseek-chat`
- API Key：你的 DeepSeek Key

Ollama 本地：

- Base URL：`http://127.0.0.1:11434/v1`
- Model：`qwen2.5`
- API Key：可空

自定义服务：

```
URL: https://api.example.com/translate
Body: {"q":{{textsJson}},"target":"{{targetLang}}"}
Path: data.translations
```

## 路线图

- [ ] 输入框翻译
- [ ] YouTube / 通用字幕双语
- [ ] PDF / EPUB
- [ ] 站点规则订阅
- [ ] Firefox / Safari
- [ ] 术语表与提示词专家
- [ ] Chrome Web Store 发布包

完整商业产品的文件翻译、站点深度适配需要更长时间。本仓库先把**可运行、可扩展、可审计**的骨架放出来。

## 安全与合规

- 不收集用户数据，无远程配置服务器。
- 请使用各服务商**官方 API** 与你自己的 Key。
- 不要把 Key 提交进 Git。
- 网页内容会发送到你选择的翻译服务商，请自行判断隐私边界。

## 许可

MIT。欢迎 Issue / PR。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

本项目与 immersive-translate 官方扩展无隶属关系。
