# 当前进度、运行状态、公式对齐

记录到 2026-09-23。需求仍以 `REQUIREMENTS.md` 为准。这里记录当前实现、运行状态、修复前的网页问题与尚未完成的验收。

## 2026-09-24 右栏作者区按行收人

文字层不再把作者区收成第一行的 4 列。后面每一行姓名各自成格，单位和邮箱只贴当前这一行。Attention 形状的 8 人因此进 [7,9]，4|3|1 才会折行。STRUCTURE 两次仍脏或仍缺人时，若作者区文本本身能收出干净的 7–9 人，用这份抽取，不把失败包渲染成成功。回退时脏的或明显缺人的 byline 格子改成一段文字，不再画成 4 格。这里不记 L1 通过。

## 2026-09-24 右栏作者包（dirty-4 不再当成功）

Attention 第 1 页若只抽出 4 个合并格（别人的姓名或邮箱写进 affiliation），整包是 `authors-dirty`，不渲染成成功。干净但页文本仍缺至少两人时，仍走一次完整性重抽；第二次仍缺人或仍脏则丢弃。`重译本页` 强制再抽一次 STRUCTURE，不复用内存里的旧 4 人格。抽出的人数进入 [7,9] 后，4|3|1 行折不变。这里不记 L1 通过。

## 2026-09-24 右栏版面对齐（right-pane-layout-parity）

Attention 第 1 页右栏作者区跟左栏行折对齐。人数仍在 [7,9]；8 人排成 **4|3|1**（7 人 4|3，9 人 4|3|2）。少于 7 人仍走 #58 的 `auto-fit` + `minmax(140px, 1fr)`，不改成 `repeat(4, 1fr)`。版心放不下四条 140px 轨道，硬用这个下限会把首行收成 3 列；满员行改成内容宽、居中、不换行，行内最多 4 格，邮箱不再为了撑满等分列折成两行。每格仍是 name → affiliation → email 短栈。题下距、作者区段距、作者到「摘要」的距收到已有的 8px / 2px；题上下用 `medium double` 细线，不是左栏像素描摹。DOM 序仍是 title → authors → abstract → footnotes → rest。未改左栏、Soft Graphite、#40 / #54 / #59、作者不译、公式墨迹。Anvil 的 L1–L5 仍要在本机左右栏看，这里不记通过。

## 2026-09-23 作者区不翻译（pdf-author-names-no-translate）

作者区整块保原文。`authors[i]` 的 name、affiliation、email、markers 都不进 `structureTranslateSlots`，回填也不写回这些字段。title、abstract、rest 仍译；`rest[{role:other}]` 仍可译。文字层作者行原来的 `skipTranslate` 不变。通读路径的作者行不进批次，合并时保原文。

## 2026-09-23 公式强可读（pdf-formula-strong-read）

#64 硬门不改（墨迹 / 正文 ≥ 1.0×）。行内目标带从 1.05～1.15 抬到 **1.25～1.35**（目标取带心 1.30）。名义 share 仍是 16/(16+2×4)，盒 **1.95em**（允许 ~1.9～2.2em）；墨迹进带后行顶收到 **1.85em**（~1.8～2.1em），不把白边裁进墨迹。独占公式仍列宽优先；短裁图的 floor 从 1.2× 抬到 **1.4×**。不动 `CROP_SCALE`、`transform: scale`、#62 pad、KaTeX、Soft Graphite、#40、#54、#59、脚注顺序、简单式 Unicode、作者四列。`footnote_sum` 仍 EXEMPT。

## 2026-09-23 右栏可读性（pdf-rightpane-footnote-simple-scale）

#63 之后补三件事，不改 Soft Graphite、#40、#54、#59、KaTeX 主路径、`CROP_SCALE`、#62 的 pad 表，也不新加 schema `role:"footnote"`。

- 脚注（`rest[role=other]`，含 `* Equal contribution`）画在摘要正文之后、其余 rest 之前。
- 简单关系 `N=6`、`h=8`、`P_drop=0.1`、`ε_ls=0.1` 写入句中 Unicode，不发 ⟦fN⟧，不进 pageRaster。`d_model`、`1/√d_k`、∑、矩阵、PE、MultiHead / Eq.3 仍是裁图；后三类保持 `formula-display`。
- 行内盒高按墨迹反推：`height = targetInk / inkShare`。名义 share = 16/(16+2×4) = 2/3，目标墨迹 1.10× 正文，盒 **1.65em**（约 1.55–1.8em）。旧 `1.22em` / `1.45em` 顶会把白边算进盒里，墨迹掉到约 0.6–0.9×。有像素时用实测 `inkShare`。独占公式仍列宽优先；默认盒下限仍是 `2em`。短裁图若这张的墨迹会低于 1.2×，只抬这一张的 floor。
- 库里旧译文若只多出已退役简单式的 ⟦fN⟧，读入时把这些占位换成源句里的 Unicode，中文留下。`blockSoftLead` 三句不改。真正对不上的公式或引用仍走原来的核对路径，不把永久英文回落写成目标。

## 2026-09-23 右栏公式显示比例（pdf-formula-display-scale）

#62 放宽裁框白边之后，右栏独占公式相对中文正文和左栏原式仍然偏小。原因在显示侧，不在 pad 或 DPI。`displayCropColumnFraction` 是公式占整页的宽度，阅读器把它写成裁图的 `width: N%`，父级却已经是扣过左右 `PDF_PAPER_PAD_X`（0.085）的正文列，比例被用了两次。行内裁图把整张图的盒高钉在 `1.1em`，`object-fit: contain` 让墨迹在盒里再缩一截。本轮不改裁框 pad、墨迹收边、`CROP_SCALE`、KaTeX、Soft Graphite、镜像、滚轮、作者格或参考文献软状态。

独占公式的列宽是 `pageFraction / (1 - 2 × 0.085)`。纸比左页窄时再乘左页 CSS 宽 / 纸宽（`--oi-pdf-left-w` / `--oi-pdf-paper-w`），最后夹在列宽 100% 以内。宽优先：不再把整页比例套在已缩进的正文列上，列宽应明显大于合前约 48%。右栏同式的 CSS 高因此贴近左栏（约 0.9–1.1）。高的硬门是墨迹 / 正文 **≥ 1.6×**（可读带 1.6～2.0×）。修宽后自然到约 3×，只要 ≤ 5× 就算通过，不把旧的 2.5～3.5× 当失败。补偿后若仍低于 1.6×，才用 `min-height: 2em` 兜底（盒高 2em，扣纸白后墨迹约 ≥ 1.6×），不先把宽度拉满整列。

| | 之前 | 之后 |
| --- | --- | --- |
| 独占宽度 | `width = pageFraction × 100%`（相对已缩进的正文列） | `min(100%, max(pageFraction / 0.83 × 左页/纸宽, 够 2em 的宽))` |
| 独占盒高下限 | 无 | `min-height: 2em`（只在修宽后仍 < 1.6× 时垫高；`font-size: 15px`） |
| 行内裁图高 | `1.1em` | `1.22em` |
| 行内容器 | `max-height: 1.35em` | `max-height: 1.45em` |
| object-fit | `contain` | `contain` |

下文「公式裁框略松」的 pad 表不变：独占 0.0045 / 0.0030，行内 0.0020 / 0.0016，下标再加 0.0012 / 0.0016，夹在 0.0060 / 0.0050 以内。

期望 Anvil（这里不记通过），按规格 §6。高硬门是 ≥ 1.6×，不是 2.5～3.5×。

| Gate | 期望 |
| --- | --- |
| D0 | 不再把整页 fraction 套到正文列；宽明显大于合前约 48% 列宽 |
| D1 / D2 | `imgCss.h / bodyFs` ≥ 1.6（可读带 1.6～2.0，或修宽后自然更高且 ≤ 5×）；居中、无 card |
| I1 | 行内约 1.22em，盒高 ≤ ~1.45em，仍在句中 |
| S1 | 公式在纸壳上，无浮起芯片或阴影 |
| R1 | KaTeX 为 0；softmax 不含 Fig.2；Soft Graphite、#54、#59 不回退 |

无 Attention PDF 时 `node --test tests/*.test.mjs`：394 通过、0 失败、1 跳过。跳过的仍是仓库里没有该 PDF 时的大样本测试。

## 2026-09-23 公式裁框略松（pdf-formula-crop-relax）

#60 的字形边和纸白收边过紧，本机上公式裁图相对原式偏小。本轮只把 pad 和墨迹白边放回中间带。不改 Soft Graphite、镜像、滚轮、参考文献软状态文案、KaTeX、pageRaster 倍率、第 5 页矩阵句译文，也不改右栏公式节奏。Anvil 的 R1–R5 仍要在本机 Chrome 看 Attention，这里不记通过。

裁框仍从字形并集外加一圈窄边，再按内容停住（邻行、图、题注）。`contentAwareFormulaBbox` 的停靠不变，softmax 裁图仍不含 Fig.2 或题注。数字在 `lib/pdf-text-layer.js` 的 `FORMULA_CROP_PAD`：

| | 横向 | 纵向 |
| --- | --- | --- |
| 独占 | 0.0045 | 0.0030 |
| 行内 | 0.0020 | 0.0016 |
| 下标 / 括号 / 根号再加 | 0.0012 | 0.0016 |

加完之后夹在 `FORMULA_PAD_LIMIT`（横 0.0060、纵 0.0050）以内。在 612×792、裁图倍率 2 下，横向上限约 7.3 CSS px，纵向上限约 7.9 CSS px，仍小于约 8。

纸白阈值 `FORMULA_PAPER_MIN` 仍是 246。墨迹外保留的白边，独占 6 像素，带上下标或括号时 7 像素；行内 4 像素，带保护时 5 像素。收紧不得越过上面的内容停靠框。没有像素或认不出墨迹时保持原框。过小的裁图（宽 < 24 或高 < 12 像素）仍不返回 data URL。

期望 Anvil：墨外白边约 3–5 CSS px；不切上下标或括号笔画；softmax 不含 Fig.2；KaTeX 仍为 0；Soft Graphite 与参考文献软状态不回退。

无 Attention PDF 时 `node --test tests/*.test.mjs`：393 通过、0 失败、1 跳过。跳过的仍是仓库里没有该 PDF 时的大样本测试。

## 2026-09-23 第 5 页矩阵句译文（pdf-page5-matrix-translate）

裁图仍是这句里的两张 pageRaster。不把 KaTeX 当主展示，也不改 `FORMULA_CROP_PAD` 或墨迹收边。文字层这句是 `Where the projections are parameter matrices ⟦f1⟧ and ⟦f2⟧.`。本轮要做的是：它不再长期停在历史 `source-uncertain` 或空 `pending` 上。

定位是句匹配 `/Where the projections are parameter matrices/`。旧 id `p5-s95wn2f` 可以变。当前文字层已经给出可信 `sourceId` 和正好两个 `⟦fN⟧` 时，阅读器套用逐页库记录会把这句写成 `supplemented` 中文「其中这些投影是参数矩阵 ⟦f1⟧ 和 ⟦f2⟧。」，占位符按原文个数和顺序保留。状态不是 `verified`。没有两个占位符时不编造中文，历史 uncertain 继续待核对。译文若丢掉占位符或引用，右栏退回原文并显示原有核对提示。参考文献的 `skipTranslate` 仍不送译。一次性迁移脚本对同一句使用同一段中文。

无 Attention PDF 时 `node --test tests/*.test.mjs`：392 通过、0 失败、1 跳过。跳过的仍是仓库里没有该 PDF 时的大样本测试。本机放上该 PDF 后，同一测试才跑文字层边界；不要把 PDF 加入 Git。

Anvil 仍要在本机 Chrome 看 Attention 第 5 页左右栏。下面的 M1–M5 这里不记通过。

| Gate | 期望 |
| --- | --- |
| M1 | 矩阵句右栏是中文，句内两张 pageRaster 裁图 |
| M2 | 右栏没有 `W_iQ` / `Rdmodel` / 十几像素碎图 |
| M3 | 这句不再长期显示「旧译文未沿用」，也不因它把整页标成待核对 |
| M4 | 公式主画面不是 KaTeX；没有 `:8765/v1/layout` 矢量主路径 |
| M5 | Soft Graphite、参考文献软状态文案、#60 裁框观感不回退 |

## 2026-09-23 公式裁框收紧（pdf-formula-crop-tighten）

主展示仍是打开的 PDF 的 pageRaster 裁图。本轮只收紧裁框，并修正「句内短式被升成居中大图」。不改右栏节奏 CSS，不把字形重绘改成主路径，不改 Soft Graphite、镜像、滚轮、作者 schema、打开 PDF 或参考文献软状态文案。Anvil 的 F1–F5 仍要在本机 Chrome 看 Attention，这里不记通过。

下面这张表是收紧当时的数字。现行旋钮见文首「公式裁框略松」。裁框从字形并集外加一圈窄边，再按内容停住（邻行、图、题注）。当时 `lib/pdf-text-layer.js` 的 `FORMULA_CROP_PAD`：

| | 横向 | 纵向 |
| --- | --- | --- |
| 独占 | 0.0024 | 0.0014 |
| 行内 | 0.0010 | 0.0008 |
| 下标 / 括号 / 根号再加 | 0.0012 | 0.0016 |

加完之后夹在 `FORMULA_PAD_LIMIT`（横 0.0049、纵 0.0038）以内。在 612×792、裁图倍率 2 下，这个上限大约是 6 CSS px。

裁图时再按纸白收一圈：通道都 ≥ 246 视为纸白。墨迹外保留的白边，独占 4 像素，带上下标或括号时 5 像素；行内 2 像素，带保护时 3 像素。收紧不得越过上面的内容停靠框，所以 softmax 裁图不会把 Fig.2 或题注裁进来。没有像素或认不出墨迹时保持原框。过小的裁图（宽 < 24 或高 < 12 像素）仍不返回 data URL。

句内、与段落左缘对齐、又没有公式编号的短式留在句子里。带 `(n)` 的居中公式仍是独占。含 `model`、`warmup` 这类罗马字母片段、但没有 the/for/this 这类功能词的缩进公式行，仍是独占。

无 Attention PDF 时 `node --test tests/*.test.mjs`：389 通过、0 失败、1 跳过。仓库不收录该 PDF；本机临时放上后，同一边界测试通过。这不能代替 Anvil 的左右栏截图。

## 2026-09-23 公式呈现（本轮）

内容仍以打开的 PDF 笔画为准。本轮只改呈现：行内公式嵌进句子，独占公式按论文居中，裁框按字形并集收紧，不再用固定整行外扩去吃相邻行或图注。计划见 `FORMULA-ELEGANCE.md`。通读结构仍以 [`pdf/PDF-MD-FORMULA-LAYOUT.md`](../PDF-MD-FORMULA-LAYOUT.md) 为准（与 `open-immerse-specs/PDF-MD-FORMULA-LAYOUT.md` 同一份）。节奏数字以 [`FORMULA-RIGHT-PANE.md`](./FORMULA-RIGHT-PANE.md) §2–§5 为准：独占公式 `10px / 14px`，行内裁图现行 `1.22em`（盒高 ≤ `1.45em`；显示宽度补偿见文首），图到题注 `6px`、题注到正文 `12px`。主展示是原页裁图，不用 KaTeX。第 5 页矩阵句的中文译文不在本轮，见文首「矩阵句译文」。

## 2026-09-23 文字层主路径（上一轮）

数字论文默认走文字层和几何启发式，不依赖本机智谱 GLM-OCR，也不依赖 GPU sidecar。`pdfLayout.mode` 为空时 `resolveLayoutMode` 返回 `text-layer`。`local-ocr` 与 `cloud-ocr` 适配器仍在，只有显式选中 `local-ocr` 才会拉起本机划区。公式、图、表的画面仍是当前 PDF 的 pageRaster 裁图。视觉块上的 `latex` / `content` / `text` 会丢掉，右栏不把 OCR 字母当公式。

本轮对 Attention 文字层做了三件事：

- 同一基线上的上下标留在该行；换行不再按 x 把两行揉成一串。参考文献按 `[n]` 拆条，右栏碎片跟在同一行的左栏后面。第 10–12 页现在是 `[1]`–`[40]` 的递增条目，`skipTranslate`，不送去翻译。第 1 条保留 `arXiv preprint arXiv:1607.06450`。第 16 条读作 “In Advances in Neural Information Processing Systems, (NIPS), 2016.”。页眉那行 `arXiv:1706.03762v7` 戳记仍然剔除。
- 第 5 页矩阵参数不再拼成 `W_iQ`、`Rdmodel`。正文是文字层原句 `Where the projections are parameter matrices ⟦f1⟧ and ⟦f2⟧.`，两段数学各自是原页裁图（第一行三个 `W_i ∈ R^{…}`，第二行 `W^O ∈ R^{…}`）。
- 独占公式裁框在字形并集外留一圈窄边，现行比例见文首「公式裁框略松」。Attention 第 4 页 softmax、第 5 页 MultiHead / FFN、第 6 页两条 PE、第 7 页学习率都是整行裁图。过小的裁图（宽 < 24 或高 < 12 像素）不返回 data URL；失败时右栏写文字提示，不用阅读器地址当 `img src`。

旧库里若仍按旧 `sourceId` 记着这一段的 `source-uncertain`，右栏不再整块换成“请看左栏”，而是注明旧译文未沿用，并显示当前文字层原句和裁图。本轮没有调用翻译接口，矩阵句没有新的中文译文；中文见文首「矩阵句译文」。

`node --test tests/*.test.mjs`：336 通过、0 失败、1 跳过。跳过的是仓库里没有 Attention PDF 时的大样本测试。本机放上该 PDF 后，同一测试通过，且没有把它加入 Git。`features.pdf` 仍默认关闭。网页双语和 Options 间距没有改；Options 里 PDF 模式的空值文案改成「未设置（文字层）」，与默认路径一致。

**网页视觉验收仍未完成。** 本环境不能打开 `chrome-extension://…/pdf/viewer.html`。下面的清单留给 Anvil 在本机 Chrome 里核对。代码测试不能代替左右栏截图。

### Anvil 人工核对（Attention，左右栏）

阅读器：`chrome-extension://aeokbdehdhpdoibdjdgffhaieibomlcn/pdf/viewer.html`。扩展从本仓库加载，改完后在 `chrome://extensions` 重新加载，不要移除。确认设置里 PDF 划区模式为空或「文字层」，不要先开本机 GLM-OCR。

| 页 | 看什么 |
| --- | --- |
| 1 | 摘要是文字层正文；作者按行分开；没有把公式画成 KaTeX |
| 2 | `[13]`、`[7]`、`[5, 2, 35]` 还在句中；`h_t`、`h_{t−1}` 没有变成十几像素的碎图 |
| 3 | Encoder 全段在；`N = 6`、`d_model = 512` 的裁图盖住底数、等号和数字；图 1 是整张原页图 |
| 4 | 图 2 含左右子图和图内英文，英文没有送去翻译；softmax 裁图盖住 `softmax`、括号、等号、上标 `T` 和下标 `d_k`，左右留有空白 |
| 5 | MultiHead 与 FFN 各是整行裁图；矩阵句右栏是中文，句内两个占位和两张裁图，不出现 `W_iQ` 或 `dmodel` |
| 6 | 表 1 是整表裁图；两条位置编码盖住 `sin`/`cos` 和分母 |
| 7 | 学习率公式整行在；`10^{-9}` 的指数在裁图里，不挂在句末 |
| 8–9 | 表 2、表 3 整表，表内数字不进译文 |
| 10–12 | 参考文献按编号递增，一条一块；`[1]` 含 arXiv 号；`[16]`、`[29]` 的右栏碎片接在对应半句后面；这些条显示英文原文 |
| 全篇 | 没有裸 base64、没有 `chrome-extension://` 图片、没有宽或高只有十几像素的公式图；点右栏块，左栏滚到同一页并高亮同一框 |

若本地库里这份 PDF 已有逐页译文：第 1–4、6、8 页旧译文仍应按源块对上。第 5 页矩阵句在文字层有两个公式占位时使用 supplemented 中文，占位保留，不标成 verified。第 10–12 页参考文献仍不自动翻译。网络里不应为了划区去请求 `127.0.0.1:8765/v1/layout`。

### 仍未完成

| 位置 | 现状 | 还要做什么 |
| --- | --- | --- |
| Chrome 左右栏 | 只做了文字层、裁框和单元测试 | 按上表在指定 Chrome 里看截图；点选高亮和滚动要人工确认 |
| 第 5 页矩阵句译文 | 已写入 supplemented 中文，占位保留；不标 verified | Anvil 看左右栏。M1–M5 不在这里记通过 |
| 参考文献 | 英文条目顺序已校正，且不自动翻译 | 不需要逐条中文。若以后要译文，按现在的条目边界另做 |
| 行末连字符 | 如第 5 页 `transfor-mation` 仍保留断行连字符 | 不改主张。若阅读时觉得碍眼，再单独决定是否接合 |
| 旧库 73 条复用译文 | 只做过结构核对 | 仍要人工抽查数字、单位、引文 |
| 云端 OCR | 适配器保留，本轮不靠它过 Attention | 有密钥时再单测：公式图仍来自 pageRaster |

## 2026-09-23 逐页库迁移后的状态

用户已授权迁移 Attention 旧库，并且只补译确认缺失的段落。代码直接在 `D:\open-immerse` 修改；Attention 测试 PDF 不加入 Git。库内原 `readout.md` 保留，`library.sqlite` 已保存迁移前备份 `library.sqlite.before-attention-migration-2026-09-23`。一次性脚本 `scripts/migrate-attention-library.mjs` 先核对 `source.pdf` 的 SHA-256，再通过现有 8765 库接口写入 15 个逐页 JSON 与索引。

迁移结果为 145 个可译源块：73 个明确配对并复用旧译文、34 个确认旧库缺失或残缺而补译、38 个源文或对应关系尚不能确认的块。第 1–4 页没有待核对译文块，摘要与第 3 页 Encoder 全段已补齐；第 2 页的 `[13]`、`[7]`、`[5, 2, 35]` 与第 3 页的 `N = 6`、`d_{model} = 512` 均在逐页记录中。第 5 页一段矩阵参数文字层顺序仍不可靠；另 37 块是第 10–12 页参考文献。这 38 块显示待核对提示，不送去自动翻译，也不冒充已译。完整列表在库内 `migration-audit.json`。

阅读器现在优先取逐页库记录，旧整篇 `readout.md` 不再覆盖它。已入库的 Attention 使用当前 PDF 的文字层重建右栏，按源块 ID 应用旧译文或补译；当前页切换时按页定位，公式、图、表从当前打开的 PDF 原页裁图。译文若丢失公式占位符或引用数字，右栏退回该源段原文并显示核对提示，不把裁图补贴到句末。第 5 页 `√d_{model}`、第 6 页两个 `PE` 下标和第 7 页 `10⁻⁹` 的指数跨度已补测试。新 PDF 的逐页保存按顺序执行，避免并发写入把完整页覆盖成早期批次的残页。

**网页视觉验收仍未完成。** Browser Use 对 `chrome-extension://.../pdf/viewer.html` 返回 URL 策略拒绝；本轮没有绕过限制，也没有得到迁移后的 Chrome 左右栏截图或网络请求记录。上述是代码、原 PDF 文字层、库接口与自动测试的结果，不能据此声称真实网页已完成对齐。下面各节保留前期调查和修复历史；其中“旧库 pages 为 0”等描述属于迁移前状态。

提交前在 `D:\open-immerse` 运行 `node --test tests/*.test.mjs`：334 通过、0 失败、0 跳过。本机拥有 Attention 测试 PDF；该 PDF 不纳入 Git，其他机器没有该文件时，对应的大样本边界测试会跳过。`git diff --check` 没有空白错误。

## 当前未解决问题与验证边界

| 位置 / 影响 | 当前处理 | 后续验收 |
| --- | --- | --- |
| 第 5 页矩阵参数段（句匹配 Where the projections…，id 可变） | 文字层为两个裁图占位；中文为 supplemented，占位保留 | Anvil 看左右栏，不在这里记通过 |
| 第 10–12 页 37 个参考文献源块有错序、粘连，旧译文无法可靠逐块配对 | 标为 `source-uncertain`，不自动重译 | 逐条校正文字层阅读序、引文编号和条目边界，再决定原文显示或逐条配对 |
| 73 个复用旧译文的“明确配对”只通过源块前缀、引用和公式占位符等结构核验；语义、所有数字仍需人工抽检 | 不把结构核验等同于全文语义验收；占位符或引用丢失时显示原文提示 | 在指定阅读器逐段比对原文与译文，重点抽检数值、单位、引文、跨页段 |
| 迁移后的 Chrome 扩展页没有可访问的工具验收记录 | 自动测试和库接口成功不代替网页结论；未能证明无新 `OI_TRANSLATE_BATCH` 请求 | 在本机 Chrome 重载扩展、完全退出再重开，打开相同 PDF，检查第 1–4、6、8 页左右栏及网络请求 |
| 本机库、模型权重和 `D:\pdf-layout-sidecar` 位于扩展仓外 | GitHub 只包含扩展代码、迁移脚本、文档及小型标注 JSON；不包含 SQLite、逐页译文数据、模型权重或测试 PDF | 其他机器复现前需单独配置本机服务和库，不能把 GitHub checkout 当成已迁移的本地库 |

以下各节为迁移前及阶段 0–5 的历史记录，出现的旧测试计数、`pages: 0`、未补译或未提交描述不代表上表的当前状态。

用户后续三张截图暴露的摘要、空引用、行内公式碎图与缺段问题，逐页证据和解决顺序见 `CONTENT-AUDIT-2026-09-23.md`。旧库确实缺摘要和第 3 页 Encoder 的中文正文；不能只靠重新裁图补齐，本轮没有发起翻译。用户已授权后续仅补译确认缺失的段落，其余旧译文不重译。

## 截图回归复盘（2026-09-23）

用户的第 1、2 页截图显示：右栏把整篇译文、`##` 标记和 `data:image/png;base64` 直接排成一个巨大段落，且第 2 页仍停在整篇开头。复现得到本地库 `readout.md` 有 467 个 CRLF 换行、0 个连续 LF；而 `storedReadoutBlocks` 原来只按 `/\n{2,}/` 切段，实际只得到一个长 2,063,458 字符的 `p` 块。上轮公式图写回这份库文件时把换行从 LF 改成了 CRLF；原文件备份 `readout.before-precision-fix.md` 有 233 个 LF 空行。这个格式回归是本轮改动引入的，旧测试只覆盖 LF，未检出。

已把现有 `readout.md` 的换行恢复成 LF，先保存 CRLF 副本 `readout.before-line-ending-fix.md`；译文内容除换行外未变。解析器同时兼容 LF、CRLF 和 CR，识别误带 `#` 前缀的图片，拒绝把 `data:image` 或 `chrome-extension://` 当正文展示。通过正在运行的 8765 接口重新读取后，解析为 215 块（170 段文字、12 个标题、33 张可用图片），没有原始图片地址进入文字块。`node --test tests/*.test.mjs` 为 329 通过、0 失败。

仍未解决的结构问题：这份旧库只有整篇 `readout.md`，`pages` 为 0；阅读器遇到它就提前进入整篇渲染，正文没有页码或源块 ID，故第 2 页无法自动定位到对应译文，`当前页` 的显示也不会过滤旧库全文。旧库的摘要正文缺失，不能编造或重新翻译。需要用当前 PDF 的文字层块与原有译文做逐页配对迁移；配不上的段落应标为待核对。公式、图、表要保存原页 bbox 并在阅读时从同一 PDF 裁图。Browser Use 对指定 `chrome-extension://` 地址再次返回 URL 策略拦截，本轮网页视觉验收仍待用户在 Chrome 提供截图和请求记录。

## 2026-09-23 本轮修复与待验收项

本轮在原有未提交工作区上继续修改，没有提交或推送，也没有把 Attention 测试 PDF 加入 Git。数字 PDF 正文继续取文字层；行内 `h_t`、`h_{t−1}` 和 `[13]`、`[7]` 留在原句里。独立公式按整行合框，已经针对 Attention 第 4 页的 softmax、 第 5 页的多头注意力与 FFN、第 6 页的位置编码、第 7 页的学习率公式核过原页裁图。没有用 KaTeX 或 bbox 镜像作为公式画面。过小图片和失败的裁图不上屏，失败时给出文字提示，不把阅读器地址设成图片。

左栏原页 canvas 先显示，随后读取文字层并查询本地库；未入库的页面才进入划区和翻译。库查询出错时翻译入口停止，避免误把已译文件送去翻译。标题后的作者、机构和邮箱按原页行拆开。划区结果只借用图、表、公式框；可信文字层的正文不采用 OCR 改写。新 PDF 完成翻译时，把文件哈希、原文 PDF、每页 JSON 和译文写入本地库。

已入库的 Attention 仍使用原有译文，没有重新调用翻译。原库 `readout.md` 中 7 张独立公式图已从该 PDF 的原页重新裁为完整公式，旧文件备份为 `readout.before-precision-fix.md`。这是旧版按整篇 Markdown 保存的条目，库中目前没有逐页原文与译文配对记录，摘要正文也缺失；因此旧译文的所有段落与左页的逐段对齐尚不能据此认定已完成。新写入的条目保存逐页配对记录。

本轮 `node --test tests/*.test.mjs` 在新增位置编码测试后为 328 通过、0 失败；单元测试不能替代左右栏验收。本地库写入失败现在会在阅读器状态里显示。浏览器工具对 `chrome-extension://.../pdf/viewer.html` 返回访问策略拦截，本轮没有通过其他浏览器或静态网页绕过，也未能在 Chrome 阅读器里确认视觉对齐或网络请求。扩展重新加载与 Chrome 完全退出再打开尚未完成。三个服务端口检查均为已在监听，没有重启或杀掉进程。8765 正在运行的进程尚未载入本轮对仓外 sidecar 的保存逻辑修改，新逻辑只做了直接模块验证；它将在该进程以后正常启动时生效。

验收只看扩展阅读器网页：左栏是打开的 PDF，右栏是译文。导出的 Markdown、导出的 PDF，目前先不用来判断公式是否对上。

阅读器地址：

`chrome-extension://aeokbdehdhpdoibdjdgffhaieibomlcn/pdf/viewer.html`

手动查看只用本机 Google Chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe`。扩展从 `D:\open-immerse` 加载，改完代码后在 `chrome://extensions` 重新加载，不要移除。

## 进度

阶段 0 到阶段 5 的扩展代码已经写进仓库。GitHub `main` 上最近一次相关提交是 `0748147`（`feat: crop PDF formulas and wire local layout`）。这次提交之后，工作区里还有未提交的修改：文字层把「只有函数名加数学字母」的一行收成整行公式裁图，划区正文去掉落在公式、图、表框里的文字项，以及本文件和另外两份说明。`features.pdf` 仍默认关闭。网页翻译和 Options 间距没有改。

`node --test tests/*.test.mjs` 在这些未提交修改之后为 323 通过、0 失败。测试绿不代表网页左右栏已经对齐。

## 运行状态

三个地址各管一件事：

| 地址 | 状态 |
| --- | --- |
| `http://127.0.0.1:7860/` | GLM-OCR 的 Gradio 网页。给人看结果，没有阅读器要的划区接口。不要填进扩展的本机基址。 |
| `http://127.0.0.1:5002/v1/chat/completions` | 本机 GLM-OCR 认字。只回文字，不回版面框。权重在 `C:\Users\19612\.cache\huggingface\hub\models--zai-org--GLM-OCR`，约 2.5 GB。5002 按这个路径读，没有搬到 D 盘。 |
| `http://127.0.0.1:8765/v1/layout` | 扩展的划区口，进程是 `D:\pdf-layout-sidecar\server.mjs`。这个目录在扩展仓外面。 |

版面模型已下载到 D 盘，没有进 C 盘缓存：

`D:\pdf-layout-models\huggingface\hub\models--PaddlePaddle--PP-DocLayoutV3_safetensors`

约 127 MB。划区配置里的 `model_dir` 指向这份快照。`id2label` 不在已安装的 `LayoutConfig` 上，sidecar 在加载前补上这个属性，再从模型配置读取类别名。队列长度写成 `region_maxsize: 800`，否则这份 SDK 会把空长度传给队列。版面后处理需要 OpenCV，已装进 `G:\BaseWare\Anaconda\envs\glm-ocr` 的 `opencv-python-headless` 5.0.0.93。

用 Attention 第 3 页跑过一次版面检测。结果是 1 个图、1 个图题、4 段正文、2 个小节标题，没有公式类别。所以本机模型目前没有把这条论文里的公式划成公式框。

打开 PDF 时，阅读器先通知本机程序 `com.open_immerse.glmocr`。5002、7860、8765 里没在听的会被拉起，已经开着的不动。左栏先出来。若这份 PDF 已经在本地库里，右栏直接显示存好的译文，不再请求翻译。库在 `D:\open-immerse-pdf-library`：`library.sqlite` 是索引，`files\{哈希}\` 放译文、原文 PDF 和以后每一页的识别结果。这一步要在 `chrome://extensions` 重新加载扩展后才生效。本机程序登记在当前用户的 Chrome Native Messaging 里，只允许扩展 `aeokbdehdhpdoibdjdgffhaieibomlcn` 调用。

## 上轮网页问题（修复前记录）

最近一次看的是阅读器第 2/15 页，状态「本页已翻译」。左栏 Introduction 里是完整的 \(h_t\)、\(h_{t-1}\) 和引用编号。右栏同一句的下标丢了或贴错，作者、单位和邮箱挤成一行。右栏因此变长，和左栏不是同一段对着同一段。

原因是一条公式按字体拆开了：

- 数学字体的字母、下标被裁成十几像素的小图。
- `softmax`、括号、等号，以及底数这类普通字体，留在句子里送去翻译。句子里就剩下 `h`、`dk`、`dmodel`。
- 同一句被拆成「残句 + 小图 + 残句」，右栏重复，盖不住左栏那一整条公式。
- 有的公式图没有裁成功，地址变成阅读器页面自己，右栏那一块是空的。

图和表如果是 PDF 里的整块对象，右栏可以裁出整张原图。公式没有走到这一步。

## 本轮针对的网页验收项

下面的代码路径已按此清单修改，实际左右栏仍需在指定 Chrome 阅读器里复核。

1. 单独成行的公式，整行裁成一张图。框要盖住 `softmax`、括号、等号和下标。这一行不翻译。
2. 句子里的 \(h_t\) 不再把下标裁走。底数和下标留在同一句里，或者合成一张行内小图插回原位。
3. 十几个像素的碎图不上屏。裁图失败时，不要用阅读器地址代替公式图。
4. 同一句只出现一次。作者和邮箱按原文分行，右栏才跟得上左栏。
5. 打开 PDF 时先画出左栏和文字层右栏，划区放在后面。状态不要停在「正在打开 PDF…」。划区失败就写明已使用文字层。

正文仍用文字层原句。公式、图、表的画面只来自原页裁图。OCR 把 `i` 认成 `n`，或把 `n` 认成 `i`，不上屏，也不送进翻译。
