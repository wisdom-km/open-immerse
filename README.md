# 沉浸译 / Open Immerse

**中文** · [English](README.en.md)

开源 Chrome **网页双语翻译** 扩展（Manifest V3）。

把外文网页、纯文本文档、带文字层的 PDF 译成对照阅读；密钥自己填，引擎自己换。仓库：https://github.com/wisdom-km/open-immerse

当前版本 **0.3.0**。V1 先做好网页双语。学习中心与文档翻译可用。PDF 阅读器能打开、能按页送译；右栏是阅读顺序的 Markdown 通读，不是 bbox 镜像。YouTube / X 字幕、悬浮翻译、划词卡片代码还在，**默认关闭，不出现在主界面**。

与官方「沉浸式翻译」无隶属关系。

---

## 能做什么

| 模块 | 现状 |
| --- | --- |
| 页面开关（FAB） | 右下角玻璃胶囊：翻译 / 停止、原文、‹ 收起。可拖动，位置写入设置。仅翻译中（含润色）显示「停止」；停止只中止 inflight，**保留已出译文**。「原文」才清译文。 |
| 网页翻译 | 默认 **仅正文**（`main` / `article` 主栏，不含侧栏、导航）。可切「全页面」（含侧栏短目录）。页头主 H1 尽量必译；顶栏导航链、面包屑、cookie 条、页脚链接堆仍跳过。 |
| 本次翻译额度 | `全部` 或 `仅标题+开头`（H1 + 第一段正文，开头段最多约 3 行 / 220 字）。「每批条数」只决定一次请求翻几段，不是本页总数。 |
| 学习中心 | 收藏单词 / 短语 / 句子；全部 / 今日待复习（简化 SM-2）；导出 Markdown / PDF / Word。 |
| 文档翻译 | TXT / MD / HTML 直读分段双语，译文可改，失败可重试，导出 HTML。 |
| PDF 阅读 | 扩展内 pdf.js 打开本地或链接 PDF。左栏连续滚动原页；右栏默认按阅读顺序抽出标题 + 正文，译成 **Markdown 通读**（双栏先左后右，滤页眉页脚页码）。公式尽量回收可复制 LaTeX + KaTeX；图可略或占位，不裁切原页当主路径。无文字层不编造正文。弹层底部 **PDF** 进入。 |
| 快捷键 | `Alt+T`：开译 / 恢复原文（关即清译文）。 |

建议回归页（主栏扫描、标题口径都按这类博客调过）：  
https://claude.com/blog/what-1-000-small-business-owners-taught-us-about-ai

---

## 安装

需要 Chrome 114+（或其它基于 Chromium、支持 MV3 module service worker 的浏览器）。

```bash
git clone https://github.com/wisdom-km/open-immerse.git
```

1. 打开 `chrome://extensions`
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」，选中仓库根目录（含 `manifest.json` 的那一层）

已装过的：`git pull` 后在扩展页点 **重新加载**。不要点「移除」再装——`chrome.storage.sync` 里的密钥会一起清掉。设置页可以先导出再导入。

本仓库 **零构建**：改 JS / CSS / HTML 后重新加载即可，没有打包步骤。

---

## 怎么用

### 1. 配引擎

工具栏图标 → **设置**，或右键扩展图标 → 选项。

1. 选默认引擎
2. 填 API Key / Base URL / 模型（视引擎而定）
3. 点「测试连接」
4. 保存设置

默认引擎是 **MyMemory（免费试用）**，不用 Key 就能跑通，质量与额度有限。正式阅读请换成 DeepL 或任意 LLM 通道。

密钥存在 `chrome.storage.sync`。导出设置会带上密钥，文件请自行保管。

### 2. 译网页

打开外文页，点右下角 **翻译**。

| 动作 | 效果 |
| --- | --- |
| 翻译 | 按当前范围与额度扫描节点，分批发给后台 |
| 停止 | 中止未完成请求，已插入的译文留下 |
| 原文 | 清掉本页全部 `.oi-translation`，回到「翻译」 |
| 关掉弹层「翻译此页」 | 等同原文（清译文） |
| `Alt+T` | 开译；再按一次恢复原文 |

弹层里还可以改：本页范围、本次额度、源/目标语言、本站自动。当前页是 PDF 时，弹层主按钮变成「在沉浸译中打开」。

译文样式（原文下方虚线 / 实线 / 边框 / 浅色虚线 / 左条卡片）和字号比例在设置里改。

### 3. 收藏与复习

- 选中文本 → 右键 **收藏**（会先译再入库）
- 双击已插入的译文也可收藏
- 学习中心：全部列表，或「今日待复习」三档（忘了 / 模糊 / 记住）

条目存在 `chrome.storage.local`（`oiLearning`），与设置同步存储分开。

### 4. 文档

弹层 → **文档**，或设置页顶部链接。粘贴或读入 TXT / MD / HTML，分段翻译，右侧可改译文，导出 `open-immerse-bilingual.html`。

不支持版式还原的 Office / 扫描件；那些请走 PDF 阅读器或先转纯文本。

### 5. PDF

弹层底部 **PDF**，或当前标签已是 PDF 时点「在沉浸译中打开」。

- 左栏：pdf.js 连续滚动；缩放只作用于原页
- 顶栏：打开 PDF → `当前页 | 全文`（切换不自动开译）→ 翻译 / 停止 → 原文 → 导出 MD / PDF
- 全文按页 `OI_TRANSLATE_BATCH`，进度「翻译中 · k/n」，可停；停或译完主按钮立刻回「翻译」，已译中文保留
- **原文只清当前页**，不清其它已译页
- 右栏默认 Markdown 通读（阅读顺序的译文文档，不是 bbox 镜像）
- 右栏另有独立缩放芯片（0.5–5，步长 0.25），不进顶栏
- 中缝可拖，改左右栏宽度
- 导出 MD 含 `$...$` / `$$...$$`（能回收到 LaTeX 时）；否则 Unicode 或 `[公式]`
- **不做 OCR**，也不注入 Chrome 自带 PDF Viewer。没有文字层就没有可提取的阅读文本

---

## 引擎

所有请求由 **service worker** 发出。内容脚本不直接打外网。

| id | 名称 | 类型 | 默认 |
| --- | --- | --- | --- |
| `mymemory` | MyMemory（免费试用） | 机器翻译 | 可选 Email 提高额度 |
| `microsoft` | Microsoft Translator | 机器翻译 | Region 默认 `eastasia` |
| `deepl` | DeepL | 机器翻译 | Free / Pro 主机切换 |
| `google` | Google Cloud Translation | 机器翻译 | Cloud Translation v2 |
| `openai` | OpenAI / 兼容通道 | LLM | `https://api.openai.com/v1` · `gpt-4o-mini` |
| `kimi` | Kimi / 月之暗面 | LLM | 国内 `api.moonshot.cn` / 国际 `api.moonshot.ai` · `kimi-k2.5` |
| `minimax` | MiniMax | LLM | 国内 `api.minimax.cn` / 国际 `api.minimax.io` · `MiniMax-M2.5` |
| `grok` | xAI Grok | LLM | `https://api.x.ai/v1` · `grok-4-fast` |
| `openrouter` | OpenRouter | LLM | 可填 HTTP-Referer / X-Title |
| `gemini` | Google Gemini | LLM | `gemini-2.0-flash` |
| `claude` | Anthropic Claude | LLM | `claude-3-5-haiku-latest` |
| `azure` | Azure OpenAI | LLM | endpoint + deployment + apiVersion |
| `custom` | 自定义 HTTP | 任意 | URL / method / headers JSON / body 模板 / responsePath |

**Ollama 与其它本地 OpenAI 兼容服务**：没有单独厂商项。选 `openai`，把 Base URL 改成例如 `http://127.0.0.1:11434/v1`，模型填本地名即可。或用 `custom` 自己拼请求。

语言选项以 `lib/languages.js` 为准（自动检测 + 简繁中 + 英日韩及常见欧亚语）。机器翻译引擎会再映射到各家语言码。

### LLM 质量策略

所有 LLM adapter 走同一套 Skill：`lib/translate-skill.js`。

- 默认 **单次** 翻译，省 token
- 设置 → 高级 **先信后润**（`twoStepPolish`，默认关）：先忠实直译，页面先插入草稿并 toast「润色中」，再换成终稿。润色失败保留草稿，短 toast「润色失败」
- 这是普通语际转换（如英 → 现代汉语），**不是文言文**
- 引擎里填了自定义系统提示词 → 仍单次，跳过第二步
- 中文目标会追加 glossary hint，并在解析后跑两道安全网：`guardZhBusinessSense`（避免 “business owners” 融成「主教」）、`guardZhTitleCalques`（去掉标题空套话）

### 深度思考

设置 → 高级 **深度思考**（`deepThink`，默认关）。

仅当 Base URL / 模型像 **Ark（火山）或 DeepSeek** 时才会带 `thinking` / `reasoning_effort`：

- 关：`thinking.type=disabled`，并带 `reasoning_effort=minimal`
- 开：`thinking.type=enabled`

其它引擎不带这些字段，避免 400。网页、PDF、文档共用这两个开关。

---

## 权限与数据

`manifest.json` 申请了：

- `storage`：设置（sync）+ 学习条目（local）
- `activeTab` / `scripting`：当前页启停
- `contextMenus`：右键收藏
- `alarms`：预留
- `host_permissions: <all_urls>`：任意页注入内容脚本，并由后台代发各家翻译 API

内容脚本在 `document_idle` 注入：`lib/fab.js`、`lib/bilingual-layout.js`、`content/content.js`、`content/toolbar.js`、`content/subtitles.js`。

翻译结果在 service worker 内存里缓存最多 2000 条（重启扩展即丢）。缓存 key 含引擎、语言、是否两步、是否思考，避免串味。

---

## 目录

```
open-immerse/
├── manifest.json              # MV3，版本 0.3.0
├── background/service-worker.js
├── content/                   # DOM 扫描、插入译文、字幕桩
├── popup/                     # 工具栏弹层
├── options/                   # 设置页
├── learning/                  # 学习中心页
├── documents/                 # 文档翻译页
├── pdf/                       # 自有阅读器 + 设计笔记
│   ├── viewer.html|js|css
│   └── vendor/                # pdf.js 4.10.38 · KaTeX 0.18.7
├── lib/
│   ├── providers.js           # 全部引擎 adapter
│   ├── translate-skill.js     # 共用 Skill / 两步提示词
│   ├── storage.js             # 默认设置与迁移（settingsVersion = 7）
│   ├── page-scan.js           # 节点收集（与 content.js 保持一致）
│   ├── site-presets.js        # 站点预设（目前 claude.com）
│   ├── bilingual-layout.js    # 双语排版
│   ├── pdf-readout.js         # PDF 右栏 Markdown 通读
│   ├── pdf-mirror.js          # 旧 bbox 镜像（不再作为右栏默认）
│   ├── pdf-viewer.js          # 阅读器逻辑（供 viewer 与测试）
│   ├── pdf-latex.js           # 文字层回收 LaTeX
│   ├── learning.js            # 收藏与间隔复习
│   ├── export.js              # MD / 简易 PDF / docx
│   ├── translate-limit.js     # 标题+开头额度
│   └── features.js            # 功能开关
├── ui/tokens.css
├── tests/*.test.mjs
├── _locales/zh_CN|en
├── README.md                  # 中文
├── README.en.md               # English
└── CONTRIBUTING.md
```

数据流：

```
页面 / PDF / 文档
    → chrome.runtime.sendMessage({ type: "OI_TRANSLATE_BATCH" })
        → service worker：缓存命中或 providers[id].translate()
            → （可选）OI_TRANSLATE_PROGRESS phase=draft
        ← translations[]
    → 插入 .oi-translation 或 PDF 通读块
```

内容脚本 **不** `fetch` 翻译 API。新增引擎只改 `lib/providers.js` 与 `DEFAULT_SETTINGS.providers`。

---

## 开发

```bash
# 纯函数测试（Node 18+，零依赖）
node --test tests/*.test.mjs
```

约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。要点：

- 一个 PR 一件事；不要提交 Key、`.env`、zip
- `content/` 只动 DOM；网络与缓存只在 `background/`
- 弹层「翻译此页」以当前页 `OI_PING`（是否已有译文 / `html.oi-active`）为准，不要用全局 `enabled` 冒充本页状态
- PDF 范围（当前页 / 全文）不要和网页扫描逻辑混改
- 网页扫描：`article` 只收主栏；`page` 另收侧栏可读段，并用启发式收 header 里的文章 H1，禁止 `closest('header')` 一刀切

### 新增引擎

1. 在 `providers` 里加 `{ id, name, kind, fields, translate }`
2. `translate(texts, ctx)` 必须返回与输入等长的 `string[]`
3. 密钥只从 `ctx.settings` 读
4. LLM 走 `resolveTranslatorPrompt` + `translateWithSkill`，模型从 `ctx.settings.model` 读
5. 在 `DEFAULT_SETTINGS.providers` 和本文引擎表各补一行

---

## 现状与边界（0.3）

已经能日常用的：网页主栏双语、站点自动规则、学习复习、纯文本文档。

明确没做、不保证、或尚未修好：

| 项 | 说明 |
| --- | --- |
| **PDF 通读（实验）** | 右栏已改为阅读顺序 Markdown 通读，不再走 bbox 镜像。扫描件无文字层仍空白；回归仍以网页双语为准 |
| Chrome 网上应用店 | 目前只支持加载已解压目录 |
| OCR | 扫描版 PDF 无文字层则右侧空白 |
| DOCX / 复杂排版文档 | 文档页只吃纯文本类文件 |
| 悬浮 / 划词 / 字幕 | `features.js` 里 `group: "later"`，默认关 |
| 独立 Ollama 项 | 用 OpenAI 兼容通道 |
| 译文缓存持久化 | 仅 SW 内存 |
| 密钥隔离 | 与其它设置一起 sync；导出 JSON 含明文 Key |
| 全站像素级还原 | 网页是「段下落下」对照，不是重排整个 CSS 布局 |

---

## 许可

MIT © 2026 wisdom-km

第三方：

- [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38（Apache-2.0），见 `pdf/vendor/`
- [KaTeX](https://github.com/KaTeX/KaTeX) 0.18.7（MIT），见 `pdf/vendor/katex/`
