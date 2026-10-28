> 入库说明（2026-10-28）：这是 2026-10-27 15:14 Wisdom 批准的多模态优先工程方案，8 条推荐全部采纳。起草时的基线是 origin/main `449f3bf`（#186）。
>
> 2026-10-28 14:34 拆分 #189：整页替换不再作为 v1 的默认路径，旗标默认关，归 v2。本文留下当时的设计，供和 #189 对照。它不是 v2 现在的版面方案。现行版面见 [`docs/architecture-redesign.md`](../architecture-redesign.md) 第 11 节。复盘见 [`docs/postmortems/pr189-multimodal-swap.md`](../postmortems/pr189-multimodal-swap.md)。

# 多模态优先（multimodal-first）PDF 页面重建 · 工程方案

- 起草：2026-10-27 15:xx（Asia/Shanghai），基于 origin/main `449f3bf`（#186）。只写方案：不改代码、不建分支、不推送。
- 决策依据：Wisdom 2026-10-26 11:02 选方案 A（质量和版式优先，不计 token 和等待时间）；2026-10-05 定的公式兜底顺序；v1 发布前不扩范围。
- 标记说明：**[证据]** = 本次读代码或报告确认过；**[假设]** = 推断，开工前要核实。

## 1. 目标与非目标

**目标**
1. 所有 PDF 每一页先送多模态模型（整页截图加文字层提示），重建正文、阅读顺序、标题层级、公式、图表区域。
2. 补全文字层中无法恢复的缺字标记 `⟨⋯⟩`。M1 报告：54 篇里有 4 篇共 209 处（19:10、32:64、53:122，另一篇见报告）。
3. 文字层降为两种角色：(a) 兜底：多模态失败、超时或未配置时使用；(b) 逐段核对：补回漏掉的句子，标出数字不一致。
4. 每页首次渲染后缓存结果，带新的流水线版本戳；旧缓存不会冒充新结果。

**非目标（v1 不做）**
- 真流式输出，以及 viewer.js 整体重构（留给 v2）。
- 新增设置页面或模型选择界面；继续用现有多模态配置。
- 修改公式各级本身的算法；只改它们的接入点。
- 网页（非 PDF）翻译流程。

## 2. 现状（含文件和函数引用）

| 环节 | 位置 | 现状 [证据] |
|---|---|---|
| 页面版面入口 | `pdf/viewer.js` `ingestPageLayout()` ≈L13925 | 按 `pdfEngineMode()` 分流：legacy / fixture / local-ocr / cloud-ocr / text-layer；OCR 失败后按 `vendorLayoutReason` 回到 `ingestTextLayerLayout()` |
| OCR 引擎路径 | `ingestVendorLayout()` ≈L14059 | `getTextContent` → `renderPageRaster()` (L14362) → PNG → `layoutCacheKey` → 等待分区和迁移 → POST |
| 文字层分块 | `lib/pdf-text-layer.js` `textLayerToBlocks()` L4189（4302 行） | 得到 blocks-1 块，公式用占位符 `⟦fN⟧` |
| 缺字标记 | `lib/pdf-glyph-sanitize.js` `GLYPH_GAP_MARK="⟨⋯⟩"` L22 | 字形无法映射时写入此标记 |
| 块协议 | `lib/pdf-blocks.js` `PROTOCOL="blocks-1"`、`LAYOUT_MODES=[text-layer,local-ocr,cloud-ocr]`、`OCR_PAGE_HINT`、`textLayerTrust()`、`blockTranslationIntegrity()` | 没有 multimodal 版面模式 |
| 多模态客户端 | `lib/mm-client.js` `sendVision()` L592、`multimodalTarget()`、`classifyVisionError()`、`MAX_PNG_BYTES=10MB`；`lib/mm-caps.js` `arkImagePlan()`、Kimi 关思考 `applyThinkingOff` | 目前只有公式级在用 |
| 公式多模态级 | `lib/formula-tiers/multimodal.js` `runMultimodal()`、`mmConfigFingerprint()`；`lib/formula-tiers/index.js` `createDefaultTiers()`；`lib/formula-chain.js` | 按单个公式裁图调用 |
| 缓存键 | `lib/pdf-layout-client.js` `layoutCacheKey()` L41：`oi-pdf-layout:{hash}:{page}:{mode}:blocks-1:source-v3:{fp-1}`；另有算法文件哈希修订号 `LAYOUT_ALGORITHM_FILES` | 读写：viewer `readStoredLayout/writeStoredLayout`、`lib/pdf-layout-cache.js`（IDB，`lib/platform/idb-*.js`） |
| 版本戳 | `lib/formula-pipeline.js` `FORMULA_PIPELINE_VERSION="fp-1"`、`formulaCacheVerdict()`、`STALE_FORMULA_COPY` | #186 已实现旧公式提示 |
| 清缓存 | `lib/doc-translation-cache.js` `clearDocTranslationRecords()` | 按 `layoutCacheKeyPrefix` 删除 |
| 诊断 | `lib/diag-log.js`（7 天，2MB）；已有 `mm.error`、`mm.probe`、`ocr.error` | 没有页级多模态事件 |
| 并发 | `lib/net/fetch.js`：多模态共用账号通道，同时最多 3 个请求，429 重试 1 次 | 页级调用可以直接复用这个通道 |

## 3. 设计

### 3.1 页级流程
```
ingestPageLayout(n)
 ├─ 读缓存 key(mode="mm-page", pipeline="mp-1")，命中且版本相符 → 直接显示
 ├─ 并行：A = textLayerToBlocks()（总是跑，<1s）   B = renderPageRaster() → PNG
 ├─ 已配置多模态 → sendVision(page PNG + 文字层提示) ──┐
 │    失败/超时/未配置 → 显示 A（fallback: reason）    │
 ├─ 解析 → mmBlocks → reconcile(mmBlocks, A) → 最终 blocks-1
 ├─ 公式/图衔接（3.5）→ setPageLayout → 翻译
 └─ writeStoredLayout（只缓存成功重建的页）
```
- 新的引擎模式 `mm-page` 成为默认，加入 `LAYOUT_MODES`；local-ocr 和 cloud-ocr 保持为手动可选项。
- 先显示 A 再替换成 B 会造成版面跳动，属于界面问题，需要 Loom 定（见 §4）。推荐方案：多模态未返回前，先用 A 翻译并显示；B 到达后只替换差异段落。[假设：现有 `setPageLayout(reanchor)` 能支持局部替换]

### 3.2 请求与输出格式
- 输入：整页 PNG（`arkImagePlan` 控制尺寸，长边约 2000px，≤10MB），加上文字层文本作为“参考，可能有缺字 ⟨⋯⟩”提示，加上页码和栏数提示。
- 模型：Kimi，经 Ark（volces，包月可随便测）或 Moonshot，关思考。
- 输出：严格 JSON（失败一次后用纯文本重试一次）：
```json
{"v":"mp-1","columns":2,"blocks":[
 {"id":"b1","label":"heading|text|caption|formula|figure|table|footnote|header",
  "bbox":[x0,y0,x1,y1],"order":1,"text":"…正文，行内公式用 $…$","latex":"仅 formula","conf":0.0}
]}
```
- bbox 用页面归一化坐标，并在 0–1 之间裁剪；不给 bbox 的块用文字层匹配补上。
- 校验：JSON 合法；阅读顺序连续；文本覆盖率要不低于文字层字数的 85%，否则判为多模态失败，走兜底。[假设阈值，需在 Box 上标定]

### 3.3 与文字层逐段核对
按 bbox 重叠加文本相似度做段落对齐，然后逐段执行：
1. **补缺字**：A 中 `⟨⋯⟩` 两侧上下文在 B 中能定位 → 用 B 的字符替换，记入 `filled`。
2. **漏句**：A 段中某个句子在 B 中找不到（归一化后编辑距离 >0.3）→ 把 A 句插回 B，块上标 `flag:"restored"`。
3. **数字核对**：抽取两边的数字、单位、引用号 `[n]`；多集或不同 → 以文字层为准（文字层数字可信），块上标 `flag:"num-mismatch"`，诊断中记录两边值。文字层该处带 `⟨⋯⟩` 时以 B 为准。
4. **多出内容**：B 有 A 没有的段落，若位于图内文字或页眉页脚 → 保留标签；否则标 `flag:"mm-only"`（可能是模型编造），照常显示。
5. 公式占位符 `⟦fN⟧` 的规则保持不变，`blockTranslationIntegrity()` 继续生效。

### 3.4 兜底与超时
- 单页超时 90s（含 1 次重试，复用 fetch 的 429 重试）。不在乎等待，但不能卡死。[假设值]
- 失败原因用 `classifyVisionError` 的错误码，加上 `parse`、`coverage`、`timeout`、`not-configured`；任一失败都回到 `ingestTextLayerLayout(n,{fallback:{source:"text-layer",reason}})`，与现有 OCR 兜底同一路径。
- 兜底的页不写多模态缓存；下次打开或手动“重译此页”时再试。

### 3.5 公式和图的衔接
- 公式兜底顺序不变：arXiv 源 → 多模态 → OCR API → 自建算法 → 矢量重绘 → 裁图 → 占位符（点击跳到原文）。
- 页级 B 给出的 `latex` 作为“多模态级”的候选，写入 `formula-mm-ledger`，免得再单独裁图调用。arXiv 级仍排第一。B 的 latex 渲染失败（`formula-katex`/`formula-verify`）时，再走单公式多模态和后续各级。
- 图和表：用 B 的 bbox 经 `cropLayoutBlocks()` 裁图；图内文字不翻译。

### 3.6 缓存与版本戳
- 新常量 `PAGE_PIPELINE_VERSION="mp-1"`（放在 `lib/formula-pipeline.js` 或新建 `lib/mm-page.js`）。
- 缓存键：`layoutCacheKey({hash,page,mode:"mm-page",pipeline:"mp-1+fp-1"})`；记录中写入 `mmConfigFingerprint`（模型和服务商）。换模型不会自动失效（推荐，见 Q3）。
- 旧的 text-layer 或 fp-1 缓存：已译页继续可见，但显示“这页来自旧版识别”提示（复用 #186 的 `formulaCacheVerdict` 模式）；不主动批量重跑。
- `clearDocTranslationRecords` 要覆盖新键，用前缀即可，[假设] 不用改。

### 3.7 诊断事件（`diagLog`，不记录原文和密钥）
`mm.page.start{page}`、`mm.page.ok{page,ms,blocks,cols}`、`mm.page.fallback{page,reason}`、`mm.page.reconcile{page,gapsIn,gapsFilled,restored,numMismatch,mmOnly}`、`mm.page.cache{page,hit}`。导出包按文档汇总 `⟨⋯⟩` 补全率。

### 3.8 并发和限流
- 复用 `lib/net/fetch.js` 账号通道（3 个同时）。页级优先级：可见页 > 前后 2 页 > 其余，复用 rush 队列 `rushCutInLive`。
- 页级请求和单公式请求共用通道；页级优先，公式级在同页 B 返回后才发。
- 停止或换文档时用现有 epoch 和 `abortInflightLayouts()` 中止请求。

## 4. 需要 Loom 出规格的界面点（尽量少）
1. 页面状态行：“正在用多模态重建本页 / 已改用文字层（原因）”。可能只改文案，复用 `syncRushStatusLine`。
2. 段落标记：`num-mismatch` 和 `restored` 的显示方式（小角标加悬停提示原文和模型值？）。`mm-only` 是否显示。
3. A 换成 B 时的替换动效和滚动锚定（避免跳动）。
4. 旧版识别提示，复用 #186 的样式；是否加“用多模态重建此页”的入口。
其余不改界面。

## 5. 任务拆分与估时（∥ = 可以并行）
| # | 任务 | 文件 | 估时 | 依赖 |
|---|---|---|---|---|
| T1 | 页级请求模块：提示词、JSON 解析、校验、错误码 | 新建 `lib/mm-page.js`，用 `mm-client`/`mm-caps` | 1.5d | — ∥ |
| T2 | 核对器：对齐、补缺字、漏句、数字（纯函数加单测） | 新建 `lib/mm-reconcile.js` | 2d | — ∥ |
| T3 | 接入 viewer：`mm-page` 模式、`ingestPageLayout` 分支、兜底、epoch 中止 | `pdf/viewer.js`、`pdf-blocks.js` | 2d | T1 |
| T4 | 缓存和版本戳 mp-1，旧缓存判定 | `pdf-layout-client.js`、`formula-pipeline.js` | 1d | — ∥ |
| T5 | 公式衔接：页级 latex 进 ledger 和多模态级 | `formula-tiers/multimodal.js`、`formula-mm-ledger.js` | 1d | T1 |
| T6 | 诊断事件和导出汇总 | `diag-log.js` | 0.5d | T1/T2 ∥ |
| T7 | 优先级和并发 | viewer rush 队列、`net/fetch.js` | 0.5d | T3 |
| T8 | 界面点实现（按 Loom 规格） | viewer、CSS | 1d | Loom 规格 |
| T9 | 评测脚本：54 篇语料，统计补全率、漏句、数字，与 M1 对比 | `oi-qa/multimodal-first/` | 1.5d | T1、T2 ∥ |
| T10 | QA 全量测试（每个 tip 一次）加真机 | — | 1d | 全部 |
合计约 12 人日；并行后关键路径约 7–8 天。

## 6. 验收标准
**Box 测试（自动）**
- 单测：T1 解析和校验（含坏 JSON、截断、bbox 越界）；T2 核对器（构造 `⟨⋯⟩`、漏句、数字不一致用例）；缓存版本判定；兜底的各个原因码。
- 语料（M1 的 54 篇）：
  - `⟨⋯⟩` 补全率 ≥95%（209 处中 ≥199 处），剩余的必须带标记或兜底说明；
  - leaks 维持 0（不劣于 c19f60a），noise 不高于 140；
  - 漏句：译前正文和文字层逐句对比，未恢复的漏句 = 0；
  - 数字核对：随机抽 200 处数字，不一致的未标记 = 0；
  - 兜底页比例和原因分布写进报告。
**真机（Chrome，Kimi via Ark）**
- Attention（1706.03762）：阅读顺序、公式 (1)–(3)、表格裁图正确。
- Lancet 双栏：分栏顺序正确，无跨栏串句，图注归属正确。
- 生物 08、27、35：27 原有 leak 36，要求缺字和漏句为 0；08 和 35 不回归。
- 断网和清空密钥：每页都兜底到文字层且有原因提示；第二次打开命中缓存（诊断里 `hit:true`）。
- 停止和换文档：没有残留请求。

## 7. 风险清单
| 风险 | 影响 | 缓解 |
|---|---|---|
| 模型编造或改写内容 | 忠实度 | 文字层核对，数字以文字层为准，mm-only 标记 |
| 漏段或截断（输出 token 上限） | 漏句 | 覆盖率门槛，漏句回填；`clampMaxTokens` |
| bbox 不准 | 图和公式裁错 | 用文字层坐标校正；用文字层 bbox 优先 |
| 整页等待长（几十秒） | 体验 | 先显示文字层结果；Wisdom 已接受 |
| viewer.js 15.7k 行，改动面大 | 回归 | 新逻辑放新模块；viewer 只加分支 |
| Ark 包月限流或 Moonshot 计费 | 失败率 | 共用通道 3 并发，失败即兜底 |
| 缓存键变化导致已译文档重跑 | 成本 | 旧缓存继续显示，加提示，不批量重跑 |
| 与 v2 重构冲突 | 返工 | 模块化，接口用 blocks-1 |

## 8. 需要 Wisdom 决策的问题（每条附推荐）
1. **多模态返回前先显示文字层结果，返回后再替换？** 推荐：是（否则首屏空白几十秒）。替换方式由 Loom 定。
2. **数字不一致时以哪边为准？** 推荐：以文字层为准并标记；文字层该处有 `⟨⋯⟩` 时以多模态为准。
3. **换模型或服务商后缓存是否失效？** 推荐：不自动失效，只记录指纹；用“重译此页”手动刷新。
4. **mm-only 段落（只有模型输出）是否显示？** 推荐：显示，加轻标记；图内文字不翻译。
5. **已有 fp-1 或 text-layer 缓存的文档是否自动用多模态重跑？** 推荐：不自动，显示旧版提示。
6. **local-ocr 和 cloud-ocr 是否保留为可选项？** 推荐：保留但不默认，v2 再清理。
7. **验收阈值（补全率 95%、覆盖率 85%、超时 90s）** 推荐：按此执行，T9 首轮评测后再定一次。
8. **默认服务商用 Ark 还是 Moonshot？** 推荐：Ark（包月，可随便测），Moonshot 作为备选配置。

## 9. 证据与假设汇总
- 证据：§2 表格全部来自 `origin/main 449f3bf` 源码；209 处 `⟨⋯⟩` 来自 `/workspace/oi-qa/journal-pdf/m1-c19f60a/LEAK-REPORT.md`；通道 3 并发来自 `lib/net/fetch.js` 注释。
- 假设：Kimi 能稳定输出整页 JSON 和 bbox（T1 首日要用 Attention 和 Lancet 验证）；`setPageLayout` 支持局部替换；超时、覆盖率、相似度阈值；估时。
