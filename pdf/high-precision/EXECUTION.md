# 执行阶段

一次只做一阶段。协议细节以 `ARCHITECTURE.md` 为准，这里不重复定义。每阶段结束运行：

```bash
node --test tests/*.test.mjs
```

工作目录是 `D:\open-immerse`。全部断言通过，并且该阶段的「完成时必须为真」都成立，才算做完。然后停手。

遗留引擎名叫 `legacy`：今天的 `extractReadoutBlocks` + KaTeX。在阶段 2 把它从阅读器默认路径换下来之前，它必须继续工作。

---

## 阶段 0 · 把规格改成裁图合同

**本阶段只改文档和那些「读文档句子」的测试。** 不改 `pdf/viewer.js` 的运行路径，不新建 `lib/pdf-blocks.js`。

### 步骤

1. 改写 `pdf/PDF-MD-READOUT.md`，使它和 `ARCHITECTURE.md` 描述的是同一条已发布目标。保留这些仍成立的句子，测试还在匹配它们：`PDF-MD-READOUT`、`本单权威规格`、阅读序、`Markdown`、`.readout`、`#40 closed`、`bbox`、Attention、`PDF-ENTRY-SECONDARY` 作废、不要回归网页 content/Options、`PDF-READOUT-MARKDOWN.md` 以本文为准。
2. 在该文里写明这些产品事实：内容精准第一，排版第二且尽量做好；译文跟抽出的原文一致；公式、图、表跟打开的 PDF 同一套内容，默认用 pageRaster 裁图，其他手段须过同一条验收；OCR 认错的字母（`i` 与 `n` 互认）不上屏；有文字层的正文用文字层原句；译文只出现在右栏；点击右栏用左栏高亮对齐；测试期划区是本机智谱 GLM-OCR，上线是 OCR API 加现有大模型 API。Issue #40 保持关闭。
3. 同步 `README.md`、`README.en.md` 的实验室 PDF 段，以及 `lib/features.js` 里 pdf 那条 hint。文案改为：文字层正文 + 原页内容精准展示（默认裁图）；公式画面不来自 LaTeX 渲染。中英文都改。
4. 更新 `tests/pdf-readout.test.mjs` 里匹配 README「保留公式/LaTeX」「preserve formulas/LaTeX」的正则，使它们匹配新文案。不要放宽到空断言。
5. `CONTRIBUTING.md` 里描述右栏公式的那句，改成裁图。若测试因此失败，只更新对应正则。

### 完成时必须为真

- `pdf/viewer.js` 仍包含 `renderFormulaNode`，且仍不包含 `cropCanvasToDataUrl`。
- `PDF-MD-READOUT.md` 写明右栏使用原页裁图，并仍包含上列必须留下的短语。
- `node --test tests/*.test.mjs` 通过。
- `features.pdf` 默认值仍是 `false`。

### 结束后停手

不要在这一阶段实现裁图。

---

## 阶段 1 · 协议、夹具、离屏裁图

**默认引擎保持 `legacy`。** 新能力由阅读器 `localStorage["oi-pdf-engine"]=fixture` 打开。

### 新建

- `lib/pdf-blocks.js`：`PROTOCOL`、`CROP_SCALE`、`LABELS`、`LAYOUT_MODES`（`text-layer` | `local-ocr` | `cloud-ocr`）、`rasterCropRect`、`bboxToPercentRect`、`normalizeIncomingBlock`（视觉块删除 `latex`/`content`/`html`/`md`/`text`）、`preparePageBlocks`（丢掉 `header`/`footer`，保留顺序）、`textLayerTrust`、占位符正则。三个模式这一阶段只是常量：`local-ocr` 注释为测试期本机智谱 GLM-OCR，`cloud-ocr` 注释为上线 OCR API，`text-layer` 注释为划区不可用时的兜底。不发网络请求。
- `tests/pdf-blocks.test.mjs`。
- `tests/fixtures/pdf-blocks/sample-page.json`：一页，含一个 `text`、一个独占 `formula`、一个带 `inlineOf` 的 `formula`、一个 `figure`、一个带 LaTeX 垃圾字段的 `formula`（用来证明会被删掉）。bbox 使用 `ARCHITECTURE.md` 第 4 节那组 CTM 换算结果作为 figure。

### 阅读器

- 读 `oi-pdf-engine`。未设置或 `legacy` 时走今天的 `ingestReadoutLayout`。
- `fixture`：不请求网络。对当前打开的 PDF 第 1 页，用 sample-page 的块（页码改成 1），按 `CROP_SCALE` 做 pageRaster，视觉块变成 `img`。
- 右栏节点带 `data-page`、`data-block-id`、`data-label`。点击后左栏对应页 `scrollIntoView`，并画一个 `.mirror-source-mark`。
- `fixture` 路径不调用 `renderFormulaNode`。`legacy` 路径保持原调用。

实现裁图时调用 `cropCanvasToDataUrl`。阶段 1 的调用放在新模块或仅在 `fixture` 分支。`tests/pdf-mirror.test.mjs` 目前要求整个 `viewer.js` 都不出现 `cropCanvasToDataUrl`。因此这一阶段把裁图调用放在 `lib/pdf-blocks.js` 或 `lib/pdf-crop.js`，`viewer.js` 只调用新模块的函数名（例如 `cropBlockImage`）。不要在 `viewer.js` 写出被禁的三个名字：`cropCanvasToDataUrl`、`buildMirrorLayout`、`appendMirrorPage`。

### 完成时必须为真

- 垃圾字段测试：输入带 `latex` 的 formula，输出对象没有该键。
- `rasterCropRect([72/612, 312/792, 172/612, 392/792], 1224, 1584)` 的宽约为 `100/612*1224`，高约为 `80/792*1584`（允许四舍五入 ±1 像素）。
- `textLayerTrust` 的三个用例与 `ARCHITECTURE.md` 第 5 节一致。
- `legacy` 下现有公式测试仍通过，包括 `formulas stay in reading order as LaTeX`。
- 手动：实验室打开一份 PDF，控制台执行 `localStorage.setItem("oi-pdf-engine","fixture")` 后重载阅读器。右栏出现裁图；缩小左栏后该图清晰度不变；点击该图，左栏出现高亮。把这三句写入阶段记录（PR 说明或提交说明即可）。

### 结束后停手

不要接 GLM-OCR，不要改默认引擎。

---

## 阶段 2 · 数字 PDF 的正文用文字层，公式仍是裁图

这一阶段做出文字层兜底，让有文字层的论文在划区服务还没接上时已经能读。它不是上线时的划区器。上线划区是阶段 4 的本机智谱（测试）和 OCR API（上线）。`legacy` 仅当 `localStorage["oi-pdf-engine"]=legacy` 时保留。设置页仍不加引擎下拉。未设置 `oi-pdf-engine` 时，阅读器先走 `text-layer` 兜底；阶段 4 再改成先尝试 `local-ocr`。

### 新建 `lib/pdf-text-layer.js`

导出 `textLayerToBlocks({ items, viewport, images, page })`，返回 `ARCHITECTURE.md` 第 3 节的页对象。

- 坐标用第 4 节的 `convertToViewportRectangle`。
- 行内 / 独占公式按第 6 节。公式项判断调用 `looksLikeFormulaItem`。
- 页眉页脚调用 `isPageChromeItem`。
- 作者行调用 `collapseAuthorBlocks`，再标 `skipTranslate` 与 `presentation: "byline"`。
- 题注调用 `looksLikeCaption`。若本页有 figure 块，题注设 `captionFor` 为阅读序上最近的 figure。
- 图像框调用 `walkImageCtms` 与 `imageRectsFromUnitCtms`，再归一化。没有图像对象就不产出 figure，题注仍可译，右栏图位用现有「［图］」文案。
- 给 `linesToParagraphs` 的产物增加 `sourceItems`。保留 `text`、`role`、`kind`，让 `tests/pdf-readout.test.mjs` 里标题、作者、双栏顺序的断言继续成立。
- `textLayerTrust` 为 `garbled` 或 `empty` 时：`textSource` 为 `ocr`，正文 `text` 先留空（阶段 5 才填 OCR 句子），视觉块照常有 bbox。

### 阅读器

- `oi-pdf-engine` 未设置时走 `text-layer`。
- `ingest` 使用 `textLayerToBlocks`。视觉块用阶段 1 的裁图函数。
- 删除阅读器里对 `renderFormulaNode` 的调用。函数体和 `lib/pdf-latex.js` 可以留下，直到没有引用。
- 这一阶段允许 `viewer.js` 出现 `cropCanvasToDataUrl` 与 `walkImageCtms` 的调用（若裁图仍经由新模块，则不必出现这两个字符串）。仍然禁止 `buildMirrorLayout` 与 `appendMirrorPage`。
- 更新 `tests/pdf-readout.test.mjs` 的 `formulas stay in reading order as LaTeX`：独占公式块没有 `latex`，有 `bbox`，`label` 或 `role` 为 formula；其文本不进入可译单元。
- 更新 `tests/pdf-mirror.test.mjs` 里「viewer 必须含 `renderFormulaNode` / 不得含 `cropCanvasToDataUrl`」的断言，使它锁定新事实：默认路径产出裁图；不得建立 mirror page。KaTeX 文件存在性断言保留。

### 完成时必须为真

- 新测试覆盖：散文行加一个 CMMI 公式项 → 句子含 `⟦f1⟧`，另有 `inlineOf` 公式块。
- 纯公式行 → 一个没有 `text` 的 formula 块。
- 作者块 `skipTranslate === true`。
- arXiv 页脚不在输出里（沿用现有 Attention 样式夹具）。
- CTM 样例能变成第 4 节的 bbox。
- `node --test tests/*.test.mjs` 通过。
- 手动：Attention 第 1 页右栏公式是原页图，摘要句子是文字层原文。记录你看过的页码。

### 结束后停手

不要发 HTTP 划区请求。这是阶段边界，不是产品决策。测试期的本机智谱 GLM-OCR 和上线用的 OCR API 都在阶段 4，共用同一个适配器。

---

## 阶段 3 · 只翻译自然语言

### 改动

- 可译单元过滤按 `ARCHITECTURE.md` 第 9 节。实现放在 `lib/pdf-blocks.js` 的 `translatableBlocks`。
- `background/service-worker.js`：`OI_TRANSLATE_BATCH` 接受可选 `polish` 与 `promptAddendum`。不传 `polish` 时，`providerSettings.twoStepPolish` 仍等于 `settings.twoStepPolish === true`。传入 `polish: false` 时，这一次 `twoStepPolish` 为 false。
- 缓存键纳入这两个字段。
- PDF 新路径调用时只附加 `promptAddendum`（占位符、数字、变量名、公式符号都原样保留；保真优先于更顺的措辞）。不传 `polish`，因此仍跟随用户的 `twoStepPolish`。两次请求（草稿和润色）都带这段 addendum。网页 `content/content.js` 与 `documents/documents.js` 的调用不增加这两个字段。
- 译文填回后，占位符处插入公式 `img`。模型漏掉 token 时，按 `placeholders` 顺序把剩余公式图接在该段末尾。公式图的像素不因润色而改变。
- 导出：视觉块写成 `![公式](...)` 或「见图」。`collectReadoutExportNodes` 不再把公式导成 `$latex$`。更新 `tests/export-pdf.test.mjs` 里因此失败的断言。

### 完成时必须为真

- 测试：不带 `polish` 的批次仍跟随 `twoStepPolish: true` 的设置进入两步路径（沿用现有 skill 测试的断言方式，读 `service-worker.js` 源码或导出一个纯函数 `resolveBatchPolish(message, settings)` 来测）。
- 测试：显式 `polish: false` 时 `resolveBatchPolish` 返回 false。PDF 阅读器的调用点不传 `polish: false`。
- 测试：`promptAddendum` 同时要求保留 `⟦fN⟧`、数字、变量名，并写明保真优先于更顺的措辞。
- 测试：formula 块不在 `translatableBlocks` 结果中；含 `⟦f1⟧` 的 text 块在结果中，且字符串仍含该 token。
- 测试：作者块被过滤。
- 网页调用点的源码仍然没有 `promptAddendum`。
- `node --test tests/*.test.mjs` 通过。
- 手动：译 Attention 摘要一页。公式图在翻译前后是同一张 data URL。句子里的公式图还在。

### 结束后停手

不要加设置页，不要调用 OCR。翻译用的是插件里已经配置的大模型 API。

---

## 阶段 4 · 本机智谱 OCR 测试，同一适配器接上 OCR API

扩展内完成映射和两种请求。测试期划区是本机智谱 GLM-OCR。上线把 `pdfLayout.mode` 设为 `cloud-ocr`，翻译仍是现有大模型 API。右栏裁图函数在两种模式下是同一个。没有 GPU 时，用夹具把适配器测完，并在阶段说明里写「本机服务未联调」；不要把本机测试写成产品上可有可无。

### 扩展内

- `lib/pdf-layout-adapter.js`：`vendorLayoutToBlocks(envelope)`。映射表按 `ARCHITECTURE.md` 第 8 节。视觉块丢掉 `content`。`text` 块的 `content` 先放在临时字段 `vendorText`，不要直接写成 `text`。
- 可信文字层：块的框来自信封，`text` 用来自文字项、中心点落在 bbox 内的拼接。拼接为空则 `text` 为 `""`。然后用现有启发式把部分 `text` 改成 `title` / `heading` / `caption` / `header` / `footer`，并处理作者与参考文献的 `skipTranslate`。
- `lib/pdf-layout-client.js`：`fetchCloudEnvelope` 与 `fetchLocalEnvelope`。由 `viewer.js` 调用。失败时该页回退到 `textLayerToBlocks`，状态栏写「划区服务不可用，已使用文字层」。
- 设置 `pdfLayout` 按第 8 节，放在现有设置对象里。设置页只在 `features.pdf` 打开时显示这一组：模式下拉、本机基址、云端基址、云端密钥、一句「云端模式会上传每一页的渲染图」。不要新的顶层 feature id。
- 缓存按 `ARCHITECTURE.md` 第 10 节写入 `chrome.storage.local`。

### 夹具

- `tests/fixtures/pdf-blocks/glm-cloud-sample.json`：手写一份符合公开字段的信封，含 formula 的 `content: "n"`（用来证明不会上屏）。
- 测试：该公式块没有 `content`、没有 `latex`；`image` 变成 `figure`；`table` 没有 html。
- 测试：可信文字层夹具的句子来自 items，厂商 `content` 被忽略。

### sidecar

目录 `D:\pdf-layout-sidecar`，不要放进 `D:\open-immerse`。

- `POST /v1/layout` 接收第 8 节的请求体，返回厂商信封。
- 进程只监听 `127.0.0.1`。
- README 写明如何安装本机 GLM-OCR，以及本仓库不含权重。
- 第一次真实响应另存为扩展仓的 `tests/fixtures/pdf-blocks/glm-local-sample.json`，并让 `vendorLayoutToBlocks` 吃掉它。存之前删掉密钥和多余的 base64。

没有 GPU 时，本阶段仍可完成：云端夹具测试 + 客户端回退测试。sidecar 和本机夹具标成同一阶段里的后半；没有真实响应就不要宣称本机模式可用。

### 完成时必须为真

- 上述夹具测试通过。
- 夹具里公式 `content` 为 `n` 时，块上没有这个字符串，`img` 的 `alt` 也不是公式字母。
- `local-ocr` 与 `cloud-ocr` 都经过 `vendorLayoutToBlocks`。阅读器在模式为 `cloud-ocr` 且密钥为空时不发请求，并回退文字层，状态栏说明已回退。
- 未设置模式时先尝试 `local-ocr` 的本机基址，失败再落到 `text-layer`。
- `node --test tests/*.test.mjs` 通过。
- 有本机服务时：Attention 一页走 `local-ocr`，公式图与左栏同一笔画。有云端密钥时再对同一页走 `cloud-ocr`，公式 data URL 仍来自 pageRaster，与本地模式的裁图函数相同。密钥不要写入仓库。

### 结束后停手

不要做表格单元格翻译，不要把译文画回左栏。

---

## 阶段 5 · 扫描件和乱码文字层

### 改动

- `textSource === "ocr"` 时，正文 `text` 使用映射后保留的 `vendorText`。视觉块逻辑不变。
- 该页通读顶部使用 `ARCHITECTURE.md` 第 7 节的提示句。常量导出后由测试引用。
- 没有划区结果（服务不可用且文字层不可信）时，右栏只有这句提示，不编造正文。已有的图像 XObject 仍可裁图。

### 完成时必须为真

- 测试：一半字符为 U+FFFD 的 items → `textSource` 为 `ocr`，`text` 等于夹具里的 `vendorText`，formula 块仍无 `content`。
- 测试：空文字层 + 无信封 → 块列表为空，提示句常量非空。
- 测试：可信页即使信封带了另一句 `vendorText`，上屏 `text` 仍是文字层句子。
- `node --test tests/*.test.mjs` 通过。
- 手动：用一份扫描 PDF 或把引擎指到 `cloud-ocr` 看一页。提示句出现；图区仍是原页截图。没有扫描件就在说明里写「未做目视」，不要伪造。

---

## 阶段之外

这些不在本目录的执行范围内，用户另开任务再做：

- 表内文字翻译、图内英文重画、可复制 LaTeX、整页中文 PDF。
- 删除 `pdf/vendor/katex`。
- 论文术语表编辑器。
- 把译文写入 PDF 文字框。
- Chrome 网上应用店上架。
