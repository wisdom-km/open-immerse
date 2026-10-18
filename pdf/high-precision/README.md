# 高精度 PDF · 给编程助手的入口

> 阶段 0–5 已完成（历史）。现行开发按 `docs/ui-phase2-plan.md` 的路线图 v3（2026-10-18）；公式目标是核对过的 KaTeX，判不出时退回原页裁图（`REQUIREMENTS.md` §2.6）。

沉浸译实验室 PDF 的实现入口。需求正本是同目录的 `REQUIREMENTS.md`。`ARCHITECTURE.md` 写编码细节，`EXECUTION.md` 写阶段步骤。后两份与需求正本冲突时，先改后两份向需求正本对齐，再写代码。

目标规格是 `pdf/PDF-MD-READOUT.md`。当前已上线的公式画面是 `renderSharpVisualCrop` 的原页高清重渲染（`surface="redraw"`）或 pageRaster 的 png 裁图，按 `REQUIREMENTS.md` §2.6 算第一层。公式上屏目标是核对过的 KaTeX，判不出时显示原页裁图（2026-10-13 00:02，见 `REQUIREMENTS.md` §2.6）；按原字体、原位置重绘字符只是第一层矢量重绘的目标（兜底，做不做待定）。当前默认设置仍可走遗留通读路径；已保存逐页配对的 PDF 优先用文字层块和本地库译文，旧整篇 `readout.md` 只作兼容回退。当前进度见 `docs/ui-phase2-plan.md` 第 2 节和 `docs/owner-todo.md`；`STATUS.md` 是截至 2026-09-24 的历史记录，迁移前的故障证据见 `CONTENT-AUDIT-2026-09-23.md`。

## 一次只做一个阶段

打开 `EXECUTION.md`，做到指定阶段的「完成时必须为真」，跑完测试，停手。后一阶段的文件不要提前改。阶段 0–5 已经做完；用户点名阶段 N 时只做阶段 N，并先确认阶段 N-1 的完成条件已经成立。

每阶段末尾：

```bash
node --test tests/*.test.mjs
```

在仓库根目录下执行。失败就修本阶段，不要为了变绿去恢复 bbox 镜像。KaTeX 上屏按路线图 v3：F3、F5 已完成，F7 进行中。D0 已合入。

## 开工时贴给助手的话

把阶段标题和下面两句一起贴上：

```text
阅读仓库里的 pdf/high-precision/README.md 和 ARCHITECTURE.md。
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
| `STATUS.md` | 历史记录（截至 2026-09-24）。当前进度看 `docs/ui-phase2-plan.md` 第 2 节和 `docs/owner-todo.md` |
| `FORMULA-ELEGANCE.md` | 行内/独占公式、字形并集裁框、右栏节奏 |
| `CONTENT-AUDIT-2026-09-23.md` | Attention 迁移前故障证据及迁移后的剩余问题 |

## 仓库事实

- 扩展仓：本仓库，MIT，零构建。改完到 `chrome://extensions` 重新加载，不要移除扩展。
- 实验室开关：`lib/features.js` 的 `features.pdf` 默认 `false`。入口在设置 → 高级。
- 阅读器：`pdf/viewer.html`、`pdf/viewer.js`。原文栏 `#pages` 里的 pdf.js canvas。右栏 `#readout`。
- 翻译：阅读器发 `OI_TRANSLATE_BATCH`，`background/service-worker.js` 的 `translateBatch`。所有密钥只存 `chrome.storage.local`，不进 sync（2026-10-13 12:19–12:23 Wisdom 定，收窄 11:57）。翻译密钥和 PDF 云端密钥从 sync 迁到 local，迁移、导入和回滚都要有测试；设置页重设计已合（#137）。2026-10-13 17:29 Wisdom 定：导出拆成「文献库」和「设置」两个文件，都不含任何 API key；设置导出不带 key，导入设置也不写入 key。见 `docs/settings-spec.md` §2。密钥是否跟账号同步由用户选择，沿用 11:57 预留的接口，随 F11 执行（F10 并入 F11，2026-10-18）（见 REQUIREMENTS §2.6「开关」和 `docs/ui-phase2-plan.md`「设置页重设计」）。笔记面板偏好从 `localStorage` 改存 `chrome.storage.local`，和其他设置放在一起（2026-10-13 11:55 定，12:00 确认）；旧值自动迁移，已合入（#130，`4e0a705`），见 `docs/ui-phase2-plan.md` 第 4 节。
- 划区 sidecar 放在扩展仓外面（本机示例名 `pdf-layout-sidecar`）。它听 `127.0.0.1:8765`（`/v1/layout` 划区接口；同一端口上的 `/v1/library/*` 文献库接口由路线图 v2 的 F4 替换，划区不在 F4 范围）。`7860` 是 GLM-OCR 网页，不是这个接口。认字模型在 `127.0.0.1:5002`。版面模型在扩展仓外的模型目录（本机示例名 `pdf-layout-models`），仓库名 `PaddlePaddle/PP-DocLayoutV3_safetensors`。`id2label` 在模型加载后从权重配置读取，不写进扩展仓。权重、PyTorch、vLLM 不进本仓库。
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

`buildMirrorLayout`、`appendMirrorPage`、`percentRectToTextStyle` 继续留在镜像实验里。阅读器不要调用它们。Issue #40 关闭的是「译文贴进原文栏原文框」。右栏插入原页裁图、原文栏用已有的 `.mirror-source-mark` 高亮，是本目录的产品路径。

## 测试怎样锁着旧行为

`tests/pdf-readout.test.mjs` 和 `tests/pdf-mirror.test.mjs` 会读源码字符串和 README 句子。下表是改动许可。同一阶段里，行为和对应断言一起改。

| 锁 | 现状 | 哪一阶段可以动 |
| --- | --- | --- |
| `pdf/viewer.js` 含 `renderFormulaNode`、`dataset.latex` | 公式走 KaTeX | D0：随 F3 改（公式目标已改为核对过的 KaTeX，见 `REQUIREMENTS.md` §2.6；阶段 2 的「改为 pageRaster 裁图」是历史） |
| `pdf/viewer.js` 不含 `cropCanvasToDataUrl`、`walkImageCtms`、`buildMirrorLayout`、`appendMirrorPage` | 阅读器不裁图、不建镜像页 | 阶段 2 允许前两个。后两个一直禁止 |
| `extractReadoutBlocks` 的公式带 `latex` | 旧通读 | 阶段 2 起新路径不再展示 `latex`。旧函数可留到没有调用方 |
| README 中英文含「原页内容精准展示（默认裁图）」和「公式可来自核对过的 LaTeX（KaTeX）渲染，判不出时显示原页裁图」 | D0 已在 F3-PR2 改完，以 `REQUIREMENTS.md` 为准 | 再改这些句子时同步改 `tests/pdf-readout.test.mjs`，不要放宽成空断言 |
| AX-23：`lib/notes-*` 相对 main 不得改动 | viewer（`pdf/viewer.js`）的锁定已随 F3 PR2 解除。service worker 直接静态导入 `background/formula-cache.js`，不从 `background/arxiv-source.js` 再转一层 | Wisdom 2026-10-13 10:36 批准。`tests/arxiv-regression.test.mjs` 锁着笔记文件 |
| `features.pdf === false`、弹层 PDF 按钮默认隐藏 | `tests/v1-defaults.test.mjs`、`tests/popup-ia.test.mjs` | 始终保持 |

## 硬边界

内容精准第一，排版第二。排版在不改内容的前提下尽量做到最高。

- 译文跟送进模型的原文一致：不增主张、不漏句子、不改数字和变量名。公式、图、表跟用户打开的 PDF 是同一套内容。OCR 把 `i` 认成 `n`，或把 `n` 认成 `i`，这种字符串不上屏，也不进入翻译。
- 公式、图、表：当前已上线的公式画面是 `renderSharpVisualCrop` 的高清重渲染（`surface="redraw"`）或 pageRaster 的 png 裁图，按 `REQUIREMENTS.md` §2.6 算第一层。公式上屏目标是核对过的 KaTeX，判不出时显示原页裁图（2026-10-13 00:02，见 `REQUIREMENTS.md` §2.6）；按原字体、原位置重绘字符只是第一层矢量重绘的目标（兜底，做不做待定）。高清重渲染失败时静默退成 png，不加徽章（V1-B1，见 `REQUIREMENTS.md` §2.6 术语表），不算换层。换层按 `REQUIREMENTS.md` §2.6「运行时顺序」的自动判据。多模态是公式主路径；第一层（自建识别和矢量重绘）按现状冻结，只作兜底，不再优化；练习集各层占比基线不再做（2026-10-05 00:48 Wisdom 定）。矢量重绘还没实现的部分做不做，待 Wisdom 确认。开关见 REQUIREMENTS §2.6「开关」。分流（2026-10-05 01:12 改；2026-10-13 00:23 Wisdom 定调度与仲裁的关系，见 `REQUIREMENTS.md` §2.6「调度与仲裁的关系」）：没有可用的 arXiv 源码时，先进入「识别候选」阶段（第 2、3 步合并）：多模态（第二层开关开着）和 OCR API（OCR 开关开着）接了几家就跑几家，按「公式识别仲裁」1→4 判，采用的结果用 KaTeX 渲染（`throwOnError: true` 能渲染才算）；两家结果不一致且判不出时，直接显示原页裁图，不再往下交给自研算法和矢量重绘；只接了一家（只有多模态或只有 OCR）时按字符核对判，核对通过就用，核对不过时直接显示原页裁图，不交给自研算法或矢量重绘（2026-10-13 00:23 / 00:30 定，11:57 再次确认）；没有任何候选（两家都没接或开关都关着）时，用自研算法（第一层，现有代码按现状冻结；这一级的判据是文档细化，待确认）；否则矢量重绘的把握分数过阈值，用矢量重绘（第一层，待实现；没实现的部分做不做，待 Wisdom 确认；做出来之前跳过这一步）；否则原页裁图清楚、没切到邻行，用裁图（第一层的高清重渲染或 png 裁图）；否则第三层开关开着就是占位，关着就按现状显示（原页裁图）。各步的自动判据见 `REQUIREMENTS.md` §2.6「运行时顺序」。内嵌图原样取出也可以。换手段时，右栏结果仍须与打开的 PDF 同一套内容。重画图内英文，不采用。
- 有文字层的数字 PDF，正文用文字层里的原句。这是主场景。扫描件少，只在没有可信文字层时才用 OCR 的正文，并在右栏标明可能有误差。
- 划区测试用本机部署的智谱 GLM-OCR。`local-ocr` 与 `cloud-ocr` 从阶段 1 就写进引擎枚举。上线把模式切到 `cloud-ocr`，翻译继续走插件里已经配置的大模型 API。两套后端吐出同一份 `blocks-1`，右栏裁图代码不跟着改。
- 送进 `OI_TRANSLATE_BATCH` 的字符串只有标题、小节、正文、题注，以及行内占位符 `⟦fN⟧`。数字和变量名原样保留。翻译用现有大模型 API，质量开关保持用户设置，不为了省事改成更弱的单程。
- `features.pdf` 保持默认关闭。网页 `content/` 和 Options 间距不改。
- 本仓库不加入 PyTorch、模型权重、BabelDOC 源码。权重留在本机 sidecar。
