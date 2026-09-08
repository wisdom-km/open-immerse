# Open Immerse

开源 Chrome **沉浸式双语翻译** 扩展。仓库：https://github.com/wisdom-km/open-immerse

## v0.2 能做什么

| 模块 | 现状 |
| --- | --- |
| 页面开关按钮 | 右下角浮动条：译 / 停 / 恢复原文 / 收藏 / 字幕 |
| 网页翻译 | 全文双语、悬停、划词、恢复原文、站点自动翻译规则 |
| 学习中心 | 收藏单词/短语/句子，保留链接与语境，简易隔离重现复习 |
| 视频字幕 | YouTube / X 读取已有字幕并叠加译文；无字幕视频需粘贴口播稿，本地 Whisper 尚未内置 |
| 文档翻译 | TXT/MD/HTML 直读双语、译文可改、导出 HTML；PDF/ePub/DOCX 请先粘贴正文 |

## 安装

```bash
git clone https://github.com/wisdom-km/open-immerse.git
```

Chrome 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。已装过的请 `git pull` 后点重新加载。

## 怎么用

1. 配置 API Key
2. 打开外文网页，点右下角 **译**
3. 点 **原** 可清掉译文
4. 选中文本 → 右键「收藏到学习中心」，或双击译文
5. YouTube 先打开视频自带字幕，再点 **幕**

## 引擎

Kimi、MiniMax、Grok、OpenRouter、OpenAI 兼容、DeepL、Gemini、Claude、Microsoft、Google Cloud、自定义 HTTP。

## 许可

MIT。与官方沉浸式翻译无隶属关系。
