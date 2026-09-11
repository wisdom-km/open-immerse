# 沉浸译 / Open Immerse

开源 Chrome **网页双语翻译** 扩展。仓库：https://github.com/wisdom-km/open-immerse

V1 先做好网页双语。学习中心与文档翻译可用；YouTube / X 字幕代码保留，默认关闭，不出现在主界面。

## v0.3 能做什么

| 模块 | 现状 |
| --- | --- |
| 页面开关按钮 | 右下角：译 / 停 / 原 / 收藏。关掉翻译会**完整恢复原文** |
| 网页翻译 | 默认仅正文；顶栏导航与右侧元信息始终不译 |
| 学习中心 | 收藏单词/短语/句子；全部 / 今日待复习；导出 TXT/MD |
| 文档翻译 | TXT/MD/HTML 直读双语、译文可改、导出 HTML |

## 安装

```bash
git clone https://github.com/wisdom-km/open-immerse.git
```

Chrome 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。已装过的请 `git pull` 后点重新加载。

## 怎么用

1. 配置 API Key
2. 打开外文网页，点右下角 **译**
3. 点 **原**、关掉弹层「翻译当前页面」、或按 **Alt+T** 关闭，都会清掉译文并回到「译」
4. 选中文本 → 右键「收藏到学习中心」，或双击译文

建议回归页：https://claude.com/blog/what-1-000-small-business-owners-taught-us-about-ai

## 引擎

Kimi、MiniMax、Grok、OpenRouter、OpenAI 兼容、DeepL、Gemini、Claude、Microsoft、Google Cloud、自定义 HTTP。

## 许可

MIT。与官方沉浸式翻译无隶属关系。
