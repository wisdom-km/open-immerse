# 高精度 PDF · 给编程助手的入口

沉浸译实验室 PDF 的实现入口。需求正本是同目录的 `REQUIREMENTS.md`。`ARCHITECTURE.md` 写编码细节，`EXECUTION.md` 写阶段步骤。后两份与需求正本冲突时，先改后两份向需求正本对齐，再写代码。

目标规格是 `pdf/PDF-MD-READOUT.md`：右栏使用原页裁图，公式画面不来自 LaTeX 渲染。当前默认设置仍可走遗留通读路径；已保存逐页配对的 PDF 优先用文字层块和本地库译文，旧整篇 `readout.md` 只作兼容回退。最新实现和未完成验收见 `STATUS.md`，迁移前的故障证据见 `CONTENT-AUDIT-2026-09-23.md`。

## 一次只做一个阶段

打开 `EXECUTION.md`，做到指定阶段的「完成时必须为真」，跑完测试，停手。后一阶段的文件不要提前改。默认从阶段 0 开始；用户点名阶段 N 时只做阶段 N，并先确认阶段 N-1 的完成条件已经成立。

每阶段末尾：

```bash
node --test tests/*.test.mjs
```

在 `D:\open-immerse` 下执行。失败就修本阶段，不要为了变绿去恢复 KaTeX 展示或 bbox 镜像。

## 开工时贴给助手的话

把阶段标题和下面两句一起贴上：

```text
阅读 D:\open-immerse\pdf\high-precision\README.md 和 ARCHITECTURE.md。
只执行 EXECUTION.md 里的「阶段 N」。完成条件全部成立后再停。不要开始下一阶段。
网页翻译、Options 间距、features.pdf 默认关闭，都保持现状。
```

## 本目录怎么读

| 文件 | 何时读 |
| --- | --- |
| `README.md` | 每次开工 |
| `REQUIREMENTS.md` | 核对产品要求时。需求只改这一份，不要写进另外两份 |
| `ARCHITECTURE.md` | 每次开工。协议、坐标、裁图、翻译、适配器都在这里 |
| `EXECUTION.md` | 只读当前阶段。后一阶段当成还不存在 |
| `STATUS.md` | 当前进度、本机运行状态、未解决问题与网页验收边界 |
| `CONTENT-AUDIT-2026-09-23.md` | Attention 迁移前故障证据及迁移后的剩余问题 |

## 仓库事实

- 扩展仓：`D:\open-immerse`，MIT，零构建。改完到 `chrome://extensions` 重新加载，不要移除扩展。
- 实验室开关：`lib/features.js` 的 `features.pdf` 默认 `false`。入口在设置 → 高级。
- 阅读器：`pdf/viewer.html`、`pdf/viewer.js`。左栏 `#pages` 里的 pdf.js canvas。右栏 `#readout`。
- 翻译：阅读器发 `OI_TRANSLATE_BATCH`，`background/service-worker.js` 的 `translateBatch`。密钥在 `chrome.storage.sync`。
- 划区 sidecar 放在扩展仓外面，目录 `D:\pdf-layout-sidecar`。它听 `127.0.0.1:8765`。`7860` 是 GLM-OCR 网页，不是这个接口。认字模型在 `127.0.0.1:5002`。版面模型在 `D:\pdf-layout-models`，仓库名 `PaddlePaddle/PP-DocLayoutV3_safetensors`。`id2label` 在模型加载后从权重配置读取，不写进扩展仓。权重、PyTorch、vLLM 不进本仓库。
- `tests/fixtures/Attention_Is_All_You_Need.pdf` 若在本地，不要 `git add`。手标样例只用小 JSON。

## 已经写好、直接调用的函数

新代码调用这些函数，不要另写一套栏切分、公式字体判断或图像 CTM：

| 函数 | 文件 | 用途 |
| --- | --- | --- |
| `looksLikeFormulaItem` | `lib/pdf-mirror.js` | 数学字体 / 符号稠密度 |
| `isPageChromeItem` / `isPageChromeText` | `lib/pdf-readout.js` | 页码、arXiv 边栏、许可行 |
| `looksLikeCaption` / `looksLikeAuthorLine` | `lib/pdf-mirror.js` / `lib/pdf-readout.js` | 题注、作者行 |
| `collapseAuthorBlocks` | `lib/pdf-readout.js` | 作者并成一行 |
| `segmentPageBlocks` | `lib/pdf-viewer.js` | 双栏阅读序、段落、标题。它现在丢掉坐标，阶段 2 给段落带上 `sourceItems` |
| `walkImageCtms` / `imageRectsFromUnitCtms` | `lib/pdf-mirror.js` | 图像 XObject 的框。`rect.top` 已是左上角、y 向下，单位是 PDF 点 |
| `cropCanvasToDataUrl` / `canvasCropSource` | `lib/pdf-mirror.js` | 按百分比矩形裁 canvas。百分比是 `{left,top,width,height}`，0–100，原点左上 |
| `articleNodeSpec` | `lib/pdf-viewer.js` | 标题 `h1`、小节 `h2`、其余 `p` |

`buildMirrorLayout`、`appendMirrorPage`、`percentRectToTextStyle` 继续留在镜像实验里。阅读器不要调用它们。Issue #40 关闭的是「译文贴进左栏原文框」。右栏插入原页裁图、左栏用已有的 `.mirror-source-mark` 高亮，是本目录的产品路径。

## 测试怎样锁着旧行为

`tests/pdf-readout.test.mjs` 和 `tests/pdf-mirror.test.mjs` 会读源码字符串和 README 句子。下表是改动许可。同一阶段里，行为和对应断言一起改。

| 锁 | 现状 | 哪一阶段可以动 |
| --- | --- | --- |
| `pdf/viewer.js` 含 `renderFormulaNode`、`dataset.latex` | 公式走 KaTeX | 阶段 2：改为 pageRaster 裁图，并改这两份测试 |
| `pdf/viewer.js` 不含 `cropCanvasToDataUrl`、`walkImageCtms`、`buildMirrorLayout`、`appendMirrorPage` | 阅读器不裁图、不建镜像页 | 阶段 2 允许前两个。后两个一直禁止 |
| `extractReadoutBlocks` 的公式带 `latex` | 旧通读 | 阶段 2 起新路径不再展示 `latex`。旧函数可留到没有调用方 |
| README 中英文含「原页内容精准展示（默认裁图）」「formula images do not come from LaTeX」 | 文案锁 | 改这些句子时同步改 `tests/pdf-readout.test.mjs`，不要放宽成空断言 |
| `features.pdf === false`、弹层 PDF 按钮默认隐藏 | `tests/v1-defaults.test.mjs`、`tests/popup-ia.test.mjs` | 始终保持 |

## 硬边界

内容精准第一，排版第二。排版在不改内容的前提下尽量做到最高。

- 译文跟送进模型的原文一致：不增主张、不漏句子、不改数字和变量名。公式、图、表跟用户打开的 PDF 是同一套内容。OCR 把 `i` 认成 `n`，或把 `n` 认成 `i`，这种字符串不上屏，也不进入翻译。
- 公式、图、表的默认做法是 `pageRaster` 裁切。内嵌图原样取出、原页矢量原样搬移也可以。换手段时，右栏结果仍须与打开的 PDF 同一套内容；做不到就退回裁图。认成 LaTeX 再渲染、重画图内英文，不采用。
- 有文字层的数字 PDF，正文用文字层里的原句。这是主场景。扫描件少，只在没有可信文字层时才用 OCR 的正文，并在右栏标明可能有误差。
- 划区测试用本机部署的智谱 GLM-OCR。`local-ocr` 与 `cloud-ocr` 从阶段 1 就写进引擎枚举。上线把模式切到 `cloud-ocr`，翻译继续走插件里已经配置的大模型 API。两套后端吐出同一份 `blocks-1`，右栏裁图代码不跟着改。
- 送进 `OI_TRANSLATE_BATCH` 的字符串只有标题、小节、正文、题注，以及行内占位符 `⟦fN⟧`。数字和变量名原样保留。翻译用现有大模型 API，质量开关保持用户设置，不为了省事改成更弱的单程。
- `features.pdf` 保持默认关闭。网页 `content/` 和 Options 间距不改。
- 本仓库不加入 PyTorch、模型权重、BabelDOC 源码。权重留在本机 sidecar。
