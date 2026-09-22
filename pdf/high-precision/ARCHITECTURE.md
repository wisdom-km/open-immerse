# 架构合同（blocks-1）

实现高精度 PDF 时通读本文。阶段步骤在 `EXECUTION.md`。产品基准是同目录的 `REQUIREMENTS.md`。本文与需求正本冲突时，改本文。

内容精准第一，排版第二。排版在不改内容的前提下尽量做到最高：阅读顺序、双栏不串、点击对回左栏、右栏不叠字、字号可读。

内容精准指两件事。译文跟抽出的原文一致，不增、不漏、不改主张，数字和变量名原样保留。公式、图、表跟用户打开的 PDF 是同一套内容。OCR 把 `i` 认成 `n`，或把 `n` 认成 `i`，都不得上屏，也不得送进翻译模型。

展示手段不锁死。第一版默认从 `pageRaster` 裁图，因为这条已经能保住笔画。内嵌图像原样取出、把原页矢量画进右栏，也可以。新手段先过同一条验收：右栏这一块与左栏同一区域的内容一致；过不了就用裁图。把识别结果渲染成 LaTeX、重画图内文字，不采用。正文能用文字层时就用文字层原句。

主场景是有文字层的数字论文 PDF。划区（哪一块是公式、图、表）在测试期走本机智谱 GLM-OCR，上线走 OCR API。两套只换适配器的地址和密钥，块协议相同。翻译从第一天就用插件已配置的大模型 API，上线同样只走这个 API。文字层字体判断是划区服务不可用时的兜底：拿不准就整段裁图，不把字母交给模型。兜底不是上线时的划区器。

## 1. 页面光栅 pageRaster

第一版用这一张图做右栏裁切，也把它交给划区模型。裁切是默认手段，不是唯一合法手段。换手段时仍以这张图（或左栏同一页）为验收参照。

- 用 pdf.js 把该页画到**离屏 canvas**，比例 `CROP_SCALE = 2`，与左栏缩放无关。
- 原点在画布左上，y 向下。`getViewport({ scale: CROP_SCALE })` 已经包含页面旋转。
- 块的 `bbox` 是相对这张图的 `[x0, y0, x1, y1]`，每个数在 0 到 1。
- 裁图把 bbox 乘上这张画布的像素宽高。左栏放大或缩小不改变右栏图片。
- 云端或本机划区收到的是这张 PNG，不是模型自己再渲的一页。这样返回的 0–1 框和裁图用的是同一张图。

左栏继续用现有 `renderView`：按 `zoom` 和 `devicePixelRatio` 画可见 canvas。可见 canvas 不作为裁图源。

常量放在 `lib/pdf-blocks.js`：

```js
export const PROTOCOL = "blocks-1";
export const CROP_SCALE = 2;
```

## 2. 运行时怎么拆

```text
pdf/viewer.js（扩展页）
  打开 PDF → 左栏立刻按现有逻辑渲染
  每页：pageRaster + 文字层 items + （可选）图像 XObject 框
  引擎产出 PageBlocks
  右栏按数组顺序画：译文段落，或 img
  可译文本 → OI_TRANSLATE_BATCH（只走 service worker）
  划区 HTTP 从 viewer.js 直接 fetch，不把整页 base64 塞进 runtime.sendMessage

lib/pdf-blocks.js          协议、校验、百分比矩形、占位符
lib/pdf-text-layer.js      数字 PDF 的文字层引擎（阶段 2 新建）
lib/pdf-layout-adapter.js  厂商 JSON → blocks-1（阶段 4 新建）
lib/pdf-layout-client.js   本机 / 云端请求（阶段 4 新建）

D:\pdf-layout-sidecar      扩展仓之外。只负责把本机 GLM-OCR 包成第 8 节的信封
```

`manifest.json` 的 `host_permissions` 已是 `<all_urls>`。不要为 `127.0.0.1` 再加权限。未填写的基址不要发请求。

## 3. 块协议

一页一个对象。`blocks` 的数组顺序就是阅读顺序。渲染器和翻译器都不要按 y 重排，否则双栏会串栏。

```json
{
  "protocol": "blocks-1",
  "page": 3,
  "pixelWidth": 1224,
  "pixelHeight": 1584,
  "textSource": "text-layer",
  "blocks": [
    {
      "id": "p3-b1",
      "label": "title",
      "bbox": [0.12, 0.08, 0.88, 0.14],
      "text": "Attention Is All You Need"
    },
    {
      "id": "p3-b2",
      "label": "text",
      "bbox": [0.12, 0.16, 0.88, 0.20],
      "text": "Ashish Vaswani · Noam Shazeer",
      "skipTranslate": true,
      "presentation": "byline"
    },
    {
      "id": "p3-b3",
      "label": "text",
      "bbox": [0.12, 0.28, 0.88, 0.40],
      "text": "The attention function can be described as ⟦f1⟧ where queries come from the previous layer.",
      "placeholders": [{ "token": "⟦f1⟧", "blockId": "p3-b4" }]
    },
    {
      "id": "p3-b4",
      "label": "formula",
      "bbox": [0.42, 0.31, 0.58, 0.36],
      "inlineOf": "p3-b3"
    },
    {
      "id": "p3-b5",
      "label": "formula",
      "bbox": [0.18, 0.42, 0.82, 0.50]
    },
    {
      "id": "p3-b6",
      "label": "figure",
      "bbox": [0.15, 0.52, 0.85, 0.78]
    },
    {
      "id": "p3-b7",
      "label": "caption",
      "bbox": [0.15, 0.79, 0.85, 0.84],
      "text": "Figure 1: The Transformer architecture.",
      "captionFor": "p3-b6"
    },
    {
      "id": "p3-b8",
      "label": "table",
      "bbox": [0.12, 0.86, 0.88, 0.96]
    }
  ]
}
```

`label` 只允许：`title` | `heading` | `text` | `caption` | `formula` | `figure` | `table` | `header` | `footer`。

| 字段 | 规则 |
| --- | --- |
| `text` | 只有 `title` / `heading` / `text` / `caption` 可以有。内容是可译自然语言，行内公式处是占位符 |
| `skipTranslate` | 作者行、参考文献为 `true`。渲染仍显示原文，不进入翻译批次 |
| `presentation` | `"byline"` 时右栏节点使用现有作者行样式：`dataset.role = "authors"`，CSS 类仍是 `.oi-pdf-p` |
| `placeholders` | 本句里的 `⟦fN⟧` 与公式块 id 的对应。`N` 从 1 连续编号，页内唯一 |
| `inlineOf` | 行内公式指向所在句子。独占一行的公式没有此字段 |
| `captionFor` | 题注指向它说明的 `figure` 或 `table` |
| `textSource` | `"text-layer"` 或 `"ocr"`。写在页上，不写在块上 |

### 逐页来源和本地库

当前数字 PDF 路径给每个块增加 `sourceId`，它由同一 PDF 页的文字层项索引生成；块的阅读序 `id` 可以随分段调整，不能单独作为旧译文配对依据。正文块还保留 `sourceText`，行内公式所在位置用 `⟦fN⟧` 关联原页裁图。`sourceAudit.items` 对每个文字层片段记录正文、视觉对象或明确排除原因；`missing` 和 `duplicates` 必须为空。

本地库按 PDF 文件 SHA-256 查找。`GET /v1/library/document?hash=...` 读取逐页记录；`POST /v1/library/page` 保存页、`pairs`、版面和首次打开的原 PDF。SQLite 是索引，仓外 `files/{hash}/page-NNN.json` 保存逐页数据，`source.pdf` 与 `readout.md` 分别是原件和旧格式兼容文件。阅读器优先用逐页 `pairs`，只在没有逐页记录时回退旧整篇 `readout.md`；已入库文档不自动重新翻译。

每个 `pair` 至少包含源块 `sourceId`、送译文本 `text`、文字层原句 `sourceText`、`translation` 和状态。恢复时同时核对文件哈希、`sourceId` 与 `sourceText`；原句变化或公式占位符、引用编号不一致时，不展示不可信译文。批量翻译完成后，本地库写入按顺序执行，避免后到的早期批次覆盖同一页的完整记录。当前 Attention 的一次性迁移和剩余例外见 `STATUS.md`。

视觉块是 `formula`、`figure`、`table`。进入右栏之前，适配器从这三类对象上删除 `latex`、`content`、`html`、`md`、`text`。校验函数发现这些键，删键并继续，不把它们渲染出来。

`header` 和 `footer` 在准备右栏数据时整块丢掉，规则复用 `isPageChromeItem` / `isPageChromeText`。适配器可以原样返回它们。

作者行：先 `collapseAuthorBlocks`，再标成 `label: "text"`、`skipTranslate: true`、`presentation: "byline"`。不要把人名送去翻译。

参考文献：某一页出现标题文本匹配 `/^(references|bibliography)$/i` 之后，该页随后的 `text` 块设 `skipTranslate: true`。用户从中间页打开时，只看得到本页标题，这是第一版的已知界限。

## 4. 坐标

文字项进协议之前，换成 `pageRaster` 的归一化坐标。使用 viewport，不要用 `transform[5] / pageHeight` 自己翻 y。文字项的 y 是基线，不是框顶。

```js
const viewport = page.getViewport({ scale: 1 });
const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
  item.x,
  item.y,
  item.x + item.width,
  item.y + item.height
]);
const bbox = [
  Math.min(x1, x2) / viewport.width,
  Math.min(y1, y2) / viewport.height,
  Math.max(x1, x2) / viewport.width,
  Math.max(y1, y2) / viewport.height
];
```

`imageRectsFromUnitCtms` 的 `rect` 已经是左上角、y 向下的 PDF 点。除以同一 viewport 的宽高即可。现有测试用的 CTM `[100, 0, 0, 80, 72, 400]`、页高 792，得到 `left = 72`、`top = 312`、`width = 100`、`height = 80`。页宽 612 时协议 bbox 为：

```text
[72/612, 312/792, 172/612, 392/792]
```

新的归一化函数用这组数做断言。

裁图像素：

```js
export function rasterCropRect(bbox, pixelWidth, pixelHeight) {
  const [x0, y0, x1, y1] = bbox;
  const sx = Math.round(x0 * pixelWidth);
  const sy = Math.round(y0 * pixelHeight);
  const sw = Math.max(1, Math.round((x1 - x0) * pixelWidth));
  const sh = Math.max(1, Math.round((y1 - y0) * pixelHeight));
  return { sx, sy, sw, sh };
}
```

交给现有裁图函数时，转成百分比：

```js
export function bboxToPercentRect(bbox) {
  const [x0, y0, x1, y1] = bbox;
  return { left: x0 * 100, top: y0 * 100, width: (x1 - x0) * 100, height: (y1 - y0) * 100 };
}
```

然后 `cropCanvasToDataUrl(pageRasterCanvas, bboxToPercentRect(bbox))`。

左栏高亮：`.pdf-page` 已是 `position: relative`。在该页节点内放一个 `.mirror-source-mark`，`left/top/width/height` 用 bbox 的百分比。同一时间只保留一个高亮。点击右栏带 `data-block-id` 的节点时，`scrollIntoView` 到 `[data-page]` 的那一页，再画这个标记。

## 5. 文字从哪来

页级判断，结果写入 `textSource`。

```js
export function textLayerTrust(items) {
  const text = (items || []).map((item) => item.str || "").join("");
  if (!text.trim()) return { trusted: false, reason: "empty" };
  const bad = (text.match(/[\uFFFD\uE000-\uF8FF]/g) || []).length;
  const printable = (text.match(/[\u0020-\u007E\u00A0-\u024F\u0370-\u03FF\u4E00-\u9FFF]/g) || []).length;
  if (bad / text.length > 0.05 || printable / text.length < 0.6) {
    return { trusted: false, reason: "garbled" };
  }
  return { trusted: true, reason: "text-layer" };
}
```

阈值做成命名常量，测试锁住这两组边界：全是英文句子 → `trusted`；空数组 → `empty`；一半是 U+FFFD → `garbled`。

| `textSource` | 正文 `text` | 公式 / 图 / 表 |
| --- | --- | --- |
| `text-layer` | 中心点落在块 bbox 内的文字项，按阅读序拼句。交集为空则 `text` 为 `""`，留空，不用 OCR 字母填 | 仍从 pageRaster 裁 |
| `ocr` | 使用信封里该文字块的 `content`，并在右栏显示误差提示 | 仍从 pageRaster 裁 |

可信文字层上，厂商返回的句子只用来对框，不替换 `text`。文字项的中心若落在公式、图、表的框里，就不进入正文 `text`，因此 `softmax`、括号、等号即使是普通字体，只要在公式框内也不送去翻译。划区若把一整条公式标成正文，而这块里没有普通句子，这块改成公式裁图，函数名不送去翻译。无文字层和乱码都走 `ocr` 这一行，提示文案用同一句。

阶段 2 的文字层引擎在可信页上自己产出框和句子，此时还没有厂商 JSON。

## 6. 行内公式和独占公式

在**行**上判断，行来自现有分栏之后的 item 聚类。`looksLikeFormulaItem` 决定每个文字项是公式项还是散文项。

- 一行只有公式项：一个 `formula` 块，bbox 为这些项的并集，每边外扩 0.004（归一化，并夹在 0–1）。没有 `text`，没有 `inlineOf`。
- 一行同时有散文项和公式项，且散文里有普通句子（4 个字母以上的单词，或连续汉字）：一个 `text`（或标题/题注）块。公式项的连续段换成 `⟦fN⟧`，并各生成一个带 `inlineOf` 的 `formula` 块。散文项按现有空格规则拼进句子。
- 一行同时有散文项和公式项，但散文只剩 `softmax`、`Attention`、`LayerNorm`、`sqrt` 这类函数名和括号：整行一个 `formula` 块，bbox 覆盖整行。这些函数名不进翻译。
- 一行只有散文项：进入现有段落合并。纯公式行会截断段落，规则与今天 `linesToParagraphs` 遇到 formula 行就 flush 相同。

占位符形式固定为 `⟦f` + 十进制数字 + `⟧`。正则：`/⟦f(\d+)⟧/g`。

右栏画带占位符的句子时，按 token 切开，token 处插入对应公式的 `img`，其余是译文文本节点。独占公式是单独一块，块内只有 `img`。

拿不准时整行裁图，不把公式字母交给翻译。函数名名单是 `softmax`、`LayerNorm`、`Attention`、`MultiHead`、`Concat`、`sqrt`、`exp`、`log`、`sin`、`cos`、`tan`、`max`、`min`。名单外的普通单词说明这是句子，行内公式仍用 `⟦fN⟧`。

图的框：优先 `walkImageCtms` + `imageRectsFromUnitCtms`，滤掉宽或高小于页边 4% 的装饰图（`appendOperatorImages` 已有这个下限）。没有图像对象时，右栏在题注处保留现有「［图］」占位，不要编造 bbox。文字层引擎不产出 `table`。表要等划区信封给出 `label: "table"`。

`segmentPageBlocks` 今天在 `linesToParagraphs` 里丢掉了行上的 `items`。阶段 2 给产出的段落加上 `sourceItems`（该段各行 items 的平铺），旧字段 `text` / `role` / `kind` 保留。现有阅读序测试继续用 `text` 和 `role` 断言。

## 7. 右栏节点

`#readout` 仍是文档流，子节点 `position: static`。每个块一个元素：

| label | 节点 |
| --- | --- |
| `title` | `h1.oi-pdf-h1`，文本为译文，未译时为原文 |
| `heading` | `h2.oi-pdf-h2` |
| `text` / `caption` | `p.oi-pdf-p`。byline 另加 `data-role="authors"` |
| `formula` / `figure` / `table` | `p.oi-pdf-p` 内一个 `img`，`src` 为裁图 data URL，`alt` 为「公式」「图」「表」 |
| 行内公式 | 不单独成块显示，插在句子的 token 位置 |

属性：`data-page`、`data-block-id`、`data-label`。视觉块没有 `data-latex`。

未翻译时右栏先显示原文句子和裁图，左栏不必等翻译。点击「翻译」后只替换可译块的文本。`skipTranslate` 的块保持原文。

无文字层或乱码时，在该页通读顶部显示：

```text
本页文字层不可用，正文来自识别结果，可能有误差。公式、图、表仍是原页截图。
```

现有 `#noTextLayerHint` 的「无法提取阅读文本」留给遗留引擎。新引擎使用上面这一句，常量放在 `lib/pdf-blocks.js`，供测试引用。

## 8. 划区信封

扩展只接受两种输入：第 3 节的 `blocks-1`，或下面这个厂商信封。信封进 `vendorLayoutToBlocks` 之后才允许进右栏。

```json
{
  "vendor": "glm-ocr",
  "page": 3,
  "pixelWidth": 1224,
  "pixelHeight": 1584,
  "layoutDetails": [
    { "label": "text", "bbox_2d": [0.1, 0.1, 0.5, 0.3], "content": "..." },
    { "label": "formula", "bbox_2d": [0.2, 0.4, 0.8, 0.48], "content": "E = mc^2" },
    { "label": "image", "bbox_2d": [0.1, 0.5, 0.9, 0.8] },
    { "label": "table", "bbox_2d": [0.1, 0.82, 0.9, 0.95], "content": "<table>...</table>" }
  ]
}
```

这是智谱 `layout_parsing` 公开字段的子集：`label` ∈ `image | text | formula | table`，`bbox_2d` 为 0–1 的四元组。映射：

| 厂商 label | blocks-1 |
| --- | --- |
| `image` | `figure` |
| `formula` | `formula`，丢弃 `content` |
| `table` | `table`，丢弃 `content` |
| `text` | `text`。标题、题注、页眉改由插件用现有启发式重标，不指望接口返回 `title` / `caption` |

云端文档没有写明 `bbox_2d` 的原点。适配器默认原点左上。阶段 4 用一页已知公式的夹具核对：裁出来的图和左栏同一区域重合。若上下颠倒，只在适配器里翻 y，协议本身不变。

本机 GLM-OCR 的原始字段以第一次成功响应为准，存成 `tests/fixtures/pdf-blocks/` 里的 JSON。在那份夹具进仓库之前，本机模式不算完成。不要凭记忆发明本地字段名。

请求从 `pdf/viewer.js` 发出：

- 云端：`POST {cloudBaseUrl}`，默认 `https://open.bigmodel.cn/api/paas/v4/layout_parsing`，体为 `{ "model": "glm-ocr", "file": "data:image/png;base64,..." }`。只上传该页 PNG。忽略响应里的截图 URL 和 Markdown 全文。
- 本机：`POST {localBaseUrl}/v1/layout`，体为 `{ "protocol": "blocks-1", "page", "imageBase64", "pixelWidth", "pixelHeight" }`。sidecar 返回厂商信封，扩展再映射。

单页 PNG 在 scale 2 下通常远小于接口的 10MB 单图上限。不要把整份 PDF 的 base64 交给 service worker。

设置放在 `chrome.storage.sync` 的 `pdfLayout`，与翻译引擎密钥分开：

```json
{
  "mode": "text-layer",
  "localBaseUrl": "http://127.0.0.1:8765",
  "cloudBaseUrl": "https://open.bigmodel.cn/api/paas/v4/layout_parsing",
  "cloudModel": "glm-ocr",
  "cloudApiKey": ""
}
```

`mode` 三值从阶段 1 的常量里就存在：

| mode | 何时用 | 正文从哪来 | 公式 / 图 / 表 |
| --- | --- | --- | --- |
| `local-ocr` | 测试期默认划区。本机智谱 GLM-OCR | 可信文字层用原句；不可信才用 OCR 正文 | pageRaster 裁图 |
| `cloud-ocr` | 小规模试 API，以及上线。智谱 GLM-OCR HTTP API | 同上 | 同上。忽略 API 返回的公式字母 |
| `text-layer` | 划区服务没开时的兜底 | 文字层原句 | 字体判断出的框仍裁 pageRaster；拿不准整行裁图 |

没有填写 `pdfLayout` 时，阅读器按 `local-ocr` 尝试本机基址；连不上就落到 `text-layer`，状态栏写明已回退。上线配置把 `mode` 固定为 `cloud-ocr`，翻译提供方仍是现有的大模型 API。云端模式会把每一页的渲染图发到 `cloudBaseUrl`，设置项旁写明这一点。

开发覆盖：阅读器页面的 `localStorage["oi-pdf-engine"]` 可取 `legacy` | `fixture` | `text-layer` | `local-ocr` | `cloud-ocr`。有值时盖过 `pdfLayout.mode`。设置页上的这三个模式在阶段 4 出现；阶段 1 只把常量放进 `lib/pdf-blocks.js`。

## 9. 翻译

可译块：`title`、`heading`、`text`、`caption`，且 `skipTranslate` 不为真，且 `text` 非空。视觉块不进入 `texts` 数组。

占位符原样送进模型。PDF 批次在系统提示末尾追加这一段（网页批次不加）：

```text
The segment may contain tokens ⟦f1⟧ ⟦f2⟧ and so on. Copy every such token into the translation unchanged, with the same spelling, count, and order.
Keep numbers, citation markers, and variable names exactly as written.
Do not add, remove, or rewrite mathematical symbols. If a symbol appears outside a token, copy it unchanged.
Faithfulness to the source outranks smoother wording.
```

两步润色都要看到这段话。PDF 批次不把 `polish` 设为 `false`。用户设置里的 `twoStepPolish` 继续生效。润色若吞掉 `⟦fN⟧` 或改了数字，先加强这段提示，不要把产品改成更弱的单程。

`OI_TRANSLATE_BATCH` 增加可选字段，缺省时行为与今天完全一致：

| 字段 | 缺省 | PDF 新路径传入 |
| --- | --- | --- |
| `polish` | 不传，沿用设置里的 `twoStepPolish` | 不传。调试时才允许显式 `false` |
| `promptAddendum` | 无 | 上面的保真说明。两步的两次请求都附上 |

缓存键要把 `polish` 和 `promptAddendum` 算进去，避免网页译文和 PDF 译文串缓存。术语表第一版就是这段 addendum，外加数字和变量名原样保留。不要改 `ZH_GLOSSARY_HINT`（那是网页「企业主」提示）。设置页里的论文词表编辑器不在本阶段。

翻译完成后，用块 id 把译文填回原块。模型若弄丢占位符，该句右栏在丢失的 token 位置仍插入公式图，公式图序列按 `placeholders` 的顺序挂到句末。画面不能因此少一张图。

范围、停止、按页进度沿用阅读器现有的「当前页 / 全文」和 `abort`。默认范围仍是当前页。

## 10. 缓存

阶段 1–3：沿用阅读器内存里的 `layoutCache` / `pageCache`，键为 `docId + page + engine + PROTOCOL`。关闭阅读器即丢。

阶段 4 起：划区结果按 PDF 字节的 SHA-256（`crypto.subtle`）、页码、`mode`、`PROTOCOL` 放在 `chrome.storage.local`。只存 JSON，不存 PNG。裁图每次从 pageRaster 现切。`storage.sync` 只放设置和密钥。

## 11. 导出

`collectReadoutExportNodes` 遇到视觉块时输出 Markdown 图片或一行「见图」，内容来自 `img.alt` 与 data URL。公式块不再走 `formulaExportMarkdown`。正文里的 `⟦fN⟧` 在 Markdown 中换成对应图片。

`lib/pdf-latex.js` 和 `pdf/vendor/katex/` 在阶段 0–5 保留文件。新路径不调用 `recoverFormulaLatex` 和 `renderFormulaNode`。

## 12. 验收时看什么

自动：

- 视觉块的对象上没有 `latex` / `content` / `html`。
- `rasterCropRect` 与第 4 节的 CTM 样例一致。
- 可信文字层的句子等于文字项拼接，而不是厂商 `content`。
- 乱码页 `textSource === "ocr"`。
- 行内句含 `⟦f1⟧`，对应公式块 `inlineOf` 指向该句。
- `polish` 缺省时，网页批次仍读 `settings.twoStepPolish`。
- `features.pdf` 默认 false。

目视只看扩展阅读器网页：左栏原文、右栏译文并排。不要用导出的 Markdown 或 PDF 判断公式是否对上。当前这一条还没有通过，记录在 `STATUS.md`。

- 右栏公式与左栏同一内容；缩小左栏后公式仍然清楚。
- 架构图内英文没有被换成中文。
- 表的内容与原表一致，格子没有被译乱。
- 抽查译文：数字、变量名、否定和限定与抽出的原文一致。
- 点击右栏句子或图，左栏滚到该页并出现 `.mirror-source-mark`。阅读顺序顺着，双栏不串。
- 切到云端模式后，公式块仍然是原 PDF 的内容，不是 API 返回的字母。

译文不设 BLEU 门槛。内容是否被改写，用上面的抽查判断。排版问题单独记，不靠改公式或改主张来修。
