# 根因：Attention 第 4–5 页显示的是旧公式译文

- 日期：2026-10-26
- 范围：只调查。不改产品代码。
- 对照：`origin/main` @ `bbd9f9f`（修复翻译失败重试那一笔）。公式切块文件与前一笔相同。
- 夹具：`tests/fixtures/Attention_Is_All_You_Need.pdf`，arXiv 1706.03762v7，sha256 `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`。PDF 被 gitignore，不进仓库。
- 诊断：Wisdom 真机 Chrome 155 / Windows，扩展 0.3.0，打开时刻 `t=1793023771937` 附近。

## 结论

屏幕上第 4–5 页的断句和裁图是打开时直接铺上的库内旧译文，不是这次打开重跑了公式链。当前 main 的文字层如果按 Attention v7 第 4 页重切，不会把 `√d_k`、`1/√d_k`、`q·k=Σ` 拆成把句子截断的独立正文块。`1/√d_k` 和求和式仍是行内裁图，要等 arXiv 源码或多模态接上才会换成 KaTeX。

`mode=local-ocr` 是划区引擎，不是公式链选了 OCR。arXiv 源码默认不下载。布局缓存和译文复用键都不含公式管线版本；公式决策缓存里的 `chainVersion` 管不到这次铺上的块和译文。

## 1. 为什么复用不看公式管线版本

### 证据

打开后的诊断（`page.state`，main 上 `diagStateForPage` 把 `layout` 记成 `translating`，把 `done` / `partial` / `skipped` / `empty` / `held` 都记成 `translated`）：

| t | page | code | mode |
| --- | --- | --- | --- |
| 1793023771688 | 1 | translating | text-layer |
| 1793023771901 | 1 | queued | local-ocr |
| 1793023771937–1941 | 1、2、4–15 | translated | local-ocr |
| 1793023803608 | 3 | queued | local-ocr |
| 1793023803613 | 3 | translating | local-ocr |
| 1793023827778 | 3 | translated | local-ocr |

第 1、2、4–15 页在同一毫秒变成 `translated`。这一拍里没有留出网络时间。第 3 页才是真的送译（约 24 秒）。窗口内没有 `mm.error`，也没有 arXiv 下载失败。成功的多模态调用和成功的源码下载本来就不写这条日志，所以「没有失败记录」不能单独证明后来没有静默请求；同一毫秒的 `translated` 足以证明当时画上的正文不是这次现译的。

三套缓存各看各的：

| 缓存 | 键里有什么 | 没有什么 |
| --- | --- | --- |
| 布局 `oi-pdf-layout:{hash}:{page}:{mode}:blocks-1:source-v3` | 文档哈希、页、划区引擎、协议、固定的 `source-v3`。另外 `layoutVersion` 是 `pdf-text-layer.js`、`pdf-layout-adapter.js`、`pdf-blocks.js`、`pdf-mirror.js` 四个文件的 SHA-256 前 16 位 | 公式链顺序、`CHAIN_VERSION`（仍是 `f3-1`）、各级 `version`（`align-1`、`mm-6`、`stub-0`、`plaintext-1`、`skip-0`、`raster-1`、`decision-1`） |
| 译文复用 | `sourceReuseHash`（规范化原文的 FNV）、`bid` / `sourceId`、目标语言、翻译提供方 | 公式管线版本。`sourceId` 和原文句子一致时，即使展示串里的 `⟦fN⟧` 变了也复用 |
| 公式决策 `oi-formula` | `unitKey:tier:tier.version:model:cropHash`。读出时要求记录上的 `chainVersion === f3-1` | 只存多模态和 OCR。arXiv、自研、矢量、裁图、占位不进这个库。页被标成已译之后，这条缓存根本不会被问到 |

`cacheableLayout` 落库时删掉 `formulaTier`、`latex`、`latexSource`、`verified`、`imageUrl`。就算某次链跑出了 KaTeX，下一回打开存盘里也没有。缺图时 `hydrateMissingVisualCrops` 会再裁，并可能再进 `scheduleFormulaBlock`；arXiv 开关关着、多模态开关关着时，链停在裁图。

没有「旧结果」这句文案。状态栏走的是「本页已翻译」。诊断词 `translated` 又把跳过、部分、空页折叠进去，所以日志看起来像刚译完。

### 推测

第 4–5 页能在同一毫秒被盖住，是因为库里的块原文和已存译文对得上（`libraryCoversLiveBlocks`），或者当时还没有装上块、只要有一条落地译文 `libraryPageRunState` 就返回 `done`。诊断里没有 `layoutVersion`，分不清是哪一种。截图上有裁图，说明当时右栏用的是带框的布局，不是纯译文字符串。

第 3 页没被盖住，所以进了队列。诊断看不出它的块为什么对不上。

### 建议的失效

不要只靠那四个文件的哈希。公式链顺序、识别策略、`CHAIN_VERSION` 都不在里面；顺序改了而 `f3-1` 不改，决策缓存也不会丢。

1. 增加一个手写的公式管线版本（例如 `formula-pipeline`），放进布局键和每条译文。顺序、行内切块策略、占位协议变了就加一档。
2. 打开时对不上的页不要标 `done`。标成待重算，状态写「这页译文来自旧的公式识别」。用户确认后再重切、重译。不要静默把旧裁图当成新结果。
3. `chainVersion` 继续只管公式决策行。它替代不了布局和译文。

## 2. 为什么是 local-ocr，而且没走 arXiv 源码

### 证据

划区引擎和公式第零层是两条线。

- 默认 `pdfLayout.mode` 是空字符串，`resolveLayoutMode` 得到 `text-layer`。诊断里先出现 `text-layer`，是因为 `adoptDoc` 在 `loadPdfLayout()` 之前就把第 1 页记成 `layout`，当时 `cachedPdfLayout` 还是空的。213 毫秒后变成 `local-ocr`，说明这台机器的设置或 `localStorage["oi-pdf-engine"]` 显式选了 `local-ocr`。认不出 arXiv 编号不会把引擎改成 `local-ocr`，认出了也不会把它改回文字层。
- 可信文字层上，`vendorLayoutToBlocks` 仍先跑 `textLayerToBlocks`，再用供应商的公式框补漏。`local-ocr` 不等于「公式走 OCR 级」。
- arXiv 编号认得出。`detectArxivId` 先看第 1 页页边戳，再看 `arxiv.org` 的 `/pdf|abs|src|e-print|html/` 网址。参考文献里的别的编号不会被当成这篇。Attention 戳是 `1706.03762v7`。
- 下载不自动开始。`startArxivSource` 只在「以后自动」、这篇在已启用列表、或用户点了芯片时跑。默认 `arxivEnabled` 是 false，相位停在 `offer`。公式链里 arXiv 级 `available()` 看的就是这个开关。多模态默认开关也是关的；配了 Kimi 密钥但没打开「用多模态模型补全公式」，链不会发图。
- 缓存布局能直接画时，`loadCurrentPageText` 在读第 1 页文字层之前返回。本地打开的文件名进 `sourceUrl`，不是 `arxiv.org` 网址。戳还没读到，网址也对不上，芯片不会出现，更不会下载。从 `arxiv.org/pdf/...` 打开时网址够用，仍然要等用户点一下或勾过自动。

### 推测

这次没有源码请求，是因为没点芯片、也没勾自动，而不只是编号没认出来。诊断不记录「已提供、未下载」。本机 `oi.arxivSourcePrefs` 和打开时的网址能把这一点钉死，这次包里没有。

## 3. 第 4 页重切：当前 main 还会不会把行内公式拆成断句

### 证据

在本机用上述夹具、当前 `textLayerToBlocks`（与 tip 的切块文件相同）跑第 4 页。sha256 与 `tests/fixtures/pdf-blocks/attention-boundaries.json` 一致。

| 原文 | 当前块 | 句子 |
| --- | --- | --- |
| 3.2.1「divide each by √d_k」 | `p4-b5` 一段正文，`√d_k` 留在句内，没有公式块 | 完整，到 “weights on the values.” |
| 「scaling factor of 1/√d_k」 | 宿主 `p4-b8` 含 `⟦f1⟧`，公式 `p4-b9` `display:false`、`inlineOf:p4-b8` | 宿主句子完整。裁图源字符串是 `√1dk`，宿主 `sourceText` 仍是 `1/√d_k` |
| 「scale the dot products by 1/√d_k」 | 宿主 `p4-b10` / `p4-b11`，同样是行内 | 宿主句子完整 |
| 脚注 `q · k = Σ q_i k_i` | 宿主 `p4-b15` 含 `⟦f4⟧`，公式 `p4-b16` 行内 | 宿主句子完整。裁图源字符串被读成 `q · k = Pdi=1k qiki` |
| 式 (1) `Attention(Q,K,V)=…` | `p4-b7` 独立展示公式 | 这是展示公式，不是行内断句 |

`blockRenderPieces` 把裁图插在宿主句子中间，不是另起一段。`inlinePromotesToDisplay` 没有被阅读器调用，`.is-promoted` 没有人加上。行内裁图的外框是 `inline-block`。

所以：截图里那种「独立块把句子截断」对不上当前文字层的新鲜切块，是旧缓存的产物。当前 main 重切第 4 页不会再把这三处切成断句。重切之后，两处 `1/√d_k` 和求和式仍然是行内裁图，除非 arXiv 源码或多模态换成 KaTeX。式 (1) 仍是一整块展示公式，源字符串也是挤在一起的 `QK√dkT`。

### 推测

截图上的红框是标注，不是阅读器的红框目标（红框只进多模态请求的上下文图）。第 3 页那次真译用的是当时已经装上的块；如果那些块是旧布局，新译文仍会按旧块来。诊断没有第 3 页的块，不能从日志判断第 3 页重译后好不好看。

## 修复方案与范围

不在这一支改产品代码。建议的改动面：

1. `lib/pdf-layout-client.js`：布局版本把公式管线版本算进去，或单独一个字段。四个切块文件的哈希保持原意。
2. `lib/pdf-library.js`：`pairAcceptsSettings` / `libraryCoversLiveBlocks` 看到旧管线版本就不当作已覆盖。没有版本的旧行视为旧结果。
3. `pdf/viewer.js`：这种页不要在 `seedLibraryProgress` 里记成 `done`。状态写明旧结果，等确认再重切重译。
4. 诊断：`translated` 不要再覆盖「来自缓存」和「刚译完」。可选，不挡住上面三条。

公式识别本身（`sameLineFormulaSpans`、`radicalUnitFraction`）这次不用为了断句再改。裁图源字符串 `√1dk`、`Pdi=1k` 是另一件事，应走 arXiv 源码或重跑链，而不是再把它们拆出句子。

## 风险

- 版本一加，已译论文会整篇变回未译。重译走现有提供方，划区若仍是 `local-ocr` 会再探本机服务。
- 若静默重算，用户会看到译文先消失。若只加文案、不重算，坏裁图还在。
- 把 arXiv 改成认出编号就下载，和已经定下的「点了才下」冲突，也会把阅读的论文编号发给 arxiv.org。
- `cacheableLayout` 继续丢掉 LaTeX 的话，源码对齐成功也活不过下一次打开，除非打开时再跑链。
- 只抬 `CHAIN_VERSION` 清不掉布局和译文。只改四个切块文件的哈希，也清不掉「文件没变、但链的顺序变了」的旧块。

## 要 Wisdom 定的点

1. 旧页是打开就重切重译，还是先标「旧结果」、等点击再重算？
2. 没有管线版本的旧行，是全部作废，还是只作废块原文对不上当前文字层的页？第 4 页这次对得上「句子完整」的新鲜切块，对不上截图里的断句；作废范围取决于库里的 `layoutVersion` 是否仍等于当前四个文件的哈希。
3. arXiv 源码维持点选 / 「以后自动」，还是对认得出的编号自动下载？后者要改原先的隐私决定。
4. 这台机器的 `local-ocr` 要不要改回默认文字层？arXiv 论文本身不该因此改引擎。可信文字层时供应商路径已经会用文字层切块。
5. 行内裁图（`1/√d_k`、求和式）和式 (1) 的源字符串质量，要不要跟缓存失效同一笔做，还是缓存先清、公式质量另开。

## 复现测试

`tests/formula-stale-cache-repro.test.mjs` 锁住当前行为，不修产品代码：

- 布局键、四个切块文件、`sourceReuseHash`、`tierCacheKey` 都不带公式管线版本。`f3-1` 的公式决策行仍然能读出。
- 原文句子相同就复用译文，哪怕展示串里的 `⟦fN⟧` 变了，记录上写了旧管线字段也一样。
- `cacheableLayout` 丢掉 LaTeX。裁图、arXiv、自研、矢量、占位不进公式决策库。
- 空的划区模式是文字层；显式 `local-ocr` 保持。本地文件名认不出编号，页边戳认得出 `1706.03762v7`。默认偏好不自动下载。配了 Kimi 密钥但开关关着，多模态级不可用。
- `done` 记成诊断里的 `translated`。状态文案是「本页已翻译。」
- 夹具在时，当前文字层重切第 4 页：三处句子保持完整，`1/√d_k` 和求和式是行内裁图。夹具不在仓库里，这一条跳过，CI 仍绿。

## 这次怎么改（feature/formula-stale-cache-fix）

上面是调查结论。这一支按 2026-10-26 的决定改产品代码。`tests/formula-stale-cache-repro.test.mjs` 锁的是旧行为，没有原样挑进来。

1. 不自动重算。块对不上当前文字层的页记成 `stale-formula`，状态栏和页内按钮都是「这页译文来自旧的公式识别」。点状态、页内按钮或「重译本页」才先重切文字层，再走原来的重译。全文「翻译」会跳过这些页，不会把它们标成已译。
2. 手写管线版本 `fp-1` 写进布局键（`source-v3:fp-1`）和每条译文。只作废对不上的页。库里的布局槽位仍是文档 / 页 / 模式 / 协议，键对不上不会把整篇重新划区。`chainVersion` 仍是 `f3-1`，只管公式决策行。版本变了但块还对得上的页盖上新戳，不整篇作废。
3. arXiv 源码仍是点选或「以后自动」，不自动下载。
4. 默认划区是文字层。没有 `oi-pdf-engine-explicit=1` 的 `localStorage["oi-pdf-engine"]` 会删掉。设置里的 `pdfLayout.mode=local-ocr` 做一次迁移（`pdfLayoutModeMigrated=fp-1`）：没有云端密钥、也没有 `pdfLayout.explicit` 的，改回空模式（文字层），设置页模式下方显示「已改回默认文字层，可在此重新选择本地 OCR」。显式选过本地 OCR 的，或配了云端密钥的，保留。之后在设置里再选本地 OCR 会写上 `explicit`。
5. 行内裁图的源字符串质量这次不做。`cacheableLayout` 仍丢掉 LaTeX。

另外按 Loom「清空本文档译文」做了 CDC-01…06。入口只有阅读器 ▾ 重译菜单最下方：分隔线加危险色「清空本文档译文…」。确认在菜单里，默认焦点是取消。翻译中先停再清。成功 toast「已清空本文档译文」3 秒，文献库行显示「未翻译」，不自动开译。失败 toast「清空失败，请重试」，内存里的旧译文还在。

#185（`feature/retranslate-menu-fix`）在重做这个菜单的锚点。清空是单独的 `bindClearDocTranslation` 加上菜单末尾一项。那支先合之后，用普通新提交或合并 main 再变基，不要 force push。
