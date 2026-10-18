# 设置页规格

> 本文是 `options/` 设置页重设计的实现规格，界面文字都用中文。完整设计稿（含调研和示意图）放在仓库外，作者是 Loom（设计负责人），路径 `/workspace/oi-qa/settings-redesign/`。本文就是实现依据。仓库路径：`docs/settings-spec.md`。2026-10-13 Wisdom 批准本稿（13:01）。
> 已定的决定（2026-10-13，Wisdom 全部按推荐批准）：
> - Q1：即时保存，去掉「保存设置」按钮；
> - Q2：所有密钥改存 `chrome.storage.local`；
> - Q3：`features.pdf` 关着时，「多模态 · OCR」页不隐藏，只在页顶给出提示；
> - Q4：多模态已配但调用失败时，问 AI 不自动改用翻译模型。
>
> 另外，2026-10-13 12:19 起不设「问 AI」设置页。
>
> 实现顺序：F3 PR3 已合入（#128，`6eb6486`），开关和公式占位卡照 FUI 规格先做完了。设置页重设计 PR 再换皮，并补 `#mm` 锚点。导入、导出和密钥迁移见 §2。

## 1 一级页与锚点（8 页 = 8 个深链）
| 顺序 | 分组 | 中文名 | 锚点 | 内容 |
|---|---|---|---|---|
| 1 | 常规 | 翻译 | `#translate` | 引擎、源语言 / 目标语言、当前引擎卡（密钥 / 模型 / 测试连接）、质量与用量（先信后润、深度思考、每批条数） |
| 2 | 常规 | 多模态 · OCR | `#mm` | A 回退顺序（只读）· B 多模态模型 · C OCR 服务 · D 三个公式开关 · E F5 预留。规则以 F3 公式界面规格 FUI-01…27 为准。这是一级页，在常规组第 2 位，紧跟翻译，不进高级 |
| 3 | 阅读 | 网页 | `#web` | 自动翻译（开关 + 站点列表）、翻译范围、本次翻译、跳过代码、译文字号比例 |
| 4 | 阅读 | PDF 阅读 | `#pdf` | 打开时自动翻译、正文译文间距、译文段间距、版面识别（原「PDF 划区」）、「恢复阅读偏好默认值」 |
| 5 | 阅读 | 笔记 | `#notes` | 笔记位置（左 / 右）、侧栏面板宽度（恢复 440）、三栏笔记宽度（恢复 360）。不做「默认布局」「新笔记默认类型」（Wisdom 2026-10-15 22:00） |
| 6 | 更多 | 功能与实验室 | `#labs` | 功能开关（网页翻译 / 学习中心 / 文档翻译 / 页面开关按钮），实验室（悬浮 / 划词 / YouTube / X / PDF 阅读） |
| 7 | 更多 | 数据与隐私 | `#data` | 密钥存放位置一览、同步密钥（F10 预留，置灰）、导出 / 导入（「文献库」和「设置」两个文件，都不含 API key，见 §2）。导入旧的设置文件时忽略里面的 key，并给出提示。文献库持久存储被拒绝时不阻止导入，全局只提示一次（界面可并进 NIM-04；关闭记在 `library.persistHintDismissed`，与笔记按篇的 `reader.notesPersistHintDismissed.<docHash>` 分开；阅读页只显示文献库卡，见 SET-33）；本页提供「再申请一次」。分组顺序：存储用量 → 文献库 · 导入 → 文献库 · 导出（这三组由 PR-4 的 `mountDataPanel` 提供，规格见 F4 界面规格 DATA-01…26）→ 设置 · 备份与恢复 → 密钥存在哪儿 → 同步密钥。迁移和导入在任一 Open Immerse 页面开着时继续，「完成」用中性色加 ✓（SET-32…SET-34） |
| 8 | 更多 | 关于 | `#about` | 版本、学习中心 / 文档翻译入口 |

- 没有「高级」页，也没有「问 AI」页。
- 旧锚点重定向：用 `history.replaceState` 替换地址，不留历史记录。

| 旧锚点 | 新锚点 |
|---|---|
| `#engine` | `#translate` |
| `#reading` | `#pdf` |
| `#features` | `#web` |
| `#advanced` | `#labs` |
| `#ai` | `#mm` |
| `#formula` | `#mm`（F3 PR3 现用的 tab 锚点，阅读页 Aa 链接也指向它） |
| 空或未知 | `#translate` |

- 带查询的深链：`#data?focus=usage|import|export`，先打开 `#data`，滚到对应组并落焦点，再用 `history.replaceState` 去掉 query（SET-36）。
- 跳到这些页的入口：
  - 阅读页 Aa 面板「公式设置…」→ `#mm`，焦点进入第一个空字段；
  - popup「去设置」→ `#translate`；
  - 问 AI 面板「去设置」→ `#mm`。

## 2 存储
| 内容 | 位置 | 键 |
|---|---|---|
| 普通设置（引擎、语言、开关、间距等） | `chrome.storage.sync` | 沿用 `lib/storage.js` 的 `settings` 对象（`DEFAULT_SETTINGS`） |
| 所有密钥：翻译引擎 `providers.*.apiKey`、PDF 云端 `pdfLayout.cloudApiKey`、多模态、OCR | `chrome.storage.local` | 从 `settings` 中移出。上线时做一次性迁移（sync → local，迁完后删除 sync 中的副本）。迁移、导入和回滚都要有测试。导出和导入见下面 |
| 公式开关 | `chrome.storage.local` 的 `formulaSettings` 记录（已合入 #128，`6eb6486`） | `formula.tier2.enabled`、`formula.ocr.enabled`、`formula.tier3.enabled`，默认都是 `false` |
| 文献库提示 | `chrome.storage.local` / `chrome.storage.session` | `library.persistHintDismissed`（全局，「不再提示」）；会话内 × 记在 session 的 `oiPersistCardHidden`。设置页不读写 |
| 同步密钥（F10 预留） | `chrome.storage.local` | `keys.syncOptIn`，本期恒为 `false`，只读 |
| 笔记面板偏好 | `chrome.storage.local` | `reader.panelWidth`（侧栏面板，默认 440，360–640）、`reader.notesWidth`（三栏笔记栏，默认 360，320–480）、`reader.notesPaneSide`（`start`/`end`，默认 `end`）、按篇的 `reader.notesPersistHintDismissed.<docHash>`（不带后缀的同名键是旧数据块，只在迁移时读；`lib/reader-notes-local.js`）。设置页只读写前 3 个。这些键从 `localStorage` 迁入（2026-10-13 11:55 定，12:00 确认，已合入 #130，`4e0a705`）。笔记筛选没有存储键：`pdf/notes-panel.js` 的 `state.filter` 只在内存里，默认 `"all"`，不写入 `chrome.storage.local`，也不进 `chrome.storage.sync` |
| 阅读页偏好 | `localStorage` | `reader.*`（不含上面 4 个笔记键：`reader.panelWidth`、`reader.notesWidth`、`reader.notesPaneSide`、`reader.notesPersistHintDismissed`（一个键，值是 docHash 到 true 的映射），这 4 个改存 `chrome.storage.local`）、`oi.reader.cjk`、`oi.rfSrcFold`。这些是就地设置；设置页只提供「恢复默认值」 |
| 作废 | — | `ask.model`（不再读写）。`ask.contextNearby` 固定为 2；`ask.confirmSend` 只在问 AI 面板首次发送确认框里修改 |

- **导出、导入和 sync 里的密钥（2026-10-13 17:29 Wisdom 定，放进设置页重设计范围；F4 界面 2026-10-13 补）。** 导出拆成「文献库」和「设置」两个文件，两个文件都不含任何 API key。设置导出不带 key；导入设置也不写入 key。导入旧的设置文件时忽略里面的 key，并给出提示。文献库持久存储被拒绝时不阻止导入，全局只提示一次；这条提示可以并进 NIM-04，不另开一行。关闭记在 `chrome.storage.local` 的 `library.persistHintDismissed`（全局一个键），和笔记按篇的 `reader.notesPersistHintDismissed.<docHash>` 分开；阅读页只显示文献库卡，笔记被拒也触发它，点过「不再提示」后两种都不再出现（Wisdom 2026-10-15 21:47，F4UI-27）。`#data` 页提供「再申请一次」。导入在任一 Open Immerse 页面开着时继续，全部关掉就暂停（DATA-06）。「完成」状态用中性色加 ✓。验收见 SET-32、SET-33、SET-34。现状：从「导入设置」导入后，`chrome.storage.sync` 里会存着非空的 `settings.providers.openai.apiKey`。main 上也是这样，是 Anvil 测 #128 时发现的。放在设置页重设计 PR 里修，和翻译、PDF 云端 key 从 sync 迁到 local 一起做。sync 里已有的 key（所有 `settings.providers.*.apiKey`、`pdfLayout.cloudApiKey`、多模态和 OCR 的 key）先迁到 local，再从 sync 删掉。迁移后再导入一次，不把 key 写回 sync。迁移可以重复跑。迁移、导入和回滚都要有测试。
- 设置页和阅读页通过 `chrome.storage.onChanged` 互相刷新，不需要刷新页面。

## 3 保存
- 即时保存：开关、下拉、步进器一改就写存储，≤ 300 ms。页面上没有「保存设置」按钮。
- 文本框（站点列表、Base URL、自定义字段）：离开输入框（blur）时写入。
- 密钥不走上一条，见 §4。空输入不覆盖已存密钥（SET-05）。
- 写入失败：控件旁显示「没保存上 · 重试」，值回滚到上一次成功写入的值。

## 4 密钥控件（翻译、多模态、OCR、PDF 云端共用）
- **提交时机**：只在离开输入框或按回车时提交，输入过程中不写库。
- **去空白**：提交前先去掉首尾空白，粘贴的内容同样处理。
- **空输入**：去掉空白后为空串（包括全是空白）时，**不写库**，保留旧值，输入框恢复成旧值的掩码，不显示「已保存」。空输入不覆盖已存密钥。
- **非空**：写入 local，行下显示「已保存」1.2 s。不自动测试。
- **掩码**：显示前 3 位 + `••••` + 后 4 位。「显示」切换成明文，30 s 后或离开页面时自动回到掩码。
- **删除**：只能通过「移除密钥」。点击后立即清空，依赖这把密钥的公式开关从 DOM 中移除；toast「已移除 {厂商} 密钥 · 撤销」，5 s 内可撤销，撤销后密钥和开关状态都恢复。不弹确认框。清除密钥只通过「移除」（可撤销）（SET-05、SET-07）。
- **测试**：按钮「测试连通 / 测试连接」。
  - 测试中：按钮禁用，显示转圈 +「测试中…」。
  - 成功：显示「已连通 · HH:MM」。
  - 失败：按 401 / 403 / 404 / 429 / 超时 / 不能看图分别显示文案，常驻到下次测试；同时显示服务返回的摘要（≤ 80 字）。这六类文案不变。
  - **测试连通芯片**（Loom 定，Wisdom 2026-10-18 10:43 批准）。说明行在芯片下方，11–12px、muted，常驻到下次测试。不用悬停说明。芯片不换行；说明行可以折行，不挤压芯片。
    - 网络错误：芯片「无法连接 · HH:MM」，说明行「检查网络或服务地址后重新测试」。侧栏「需处理」。
    - 未识别的失败：芯片「测试失败 · HH:MM」，说明行是服务返回的原始摘要（≤ 80 字）。侧栏「需处理」。「暂不可用」只留给厂家下拉，不再用作这颗芯片。
    - 用户中止：不显示芯片，不加「需处理」，卡片回到这次测试开始前的状态。
    - 回答被长度截断：芯片「回答被截断 · HH:MM」，说明行「推理模型把输出额度用在了思考上，换个非推理模型再测」。侧栏「需处理」。不是「这个模型不能看图」。
  - **密钥一变就作废**（2026-10-18 Wisdom 定）：保存密钥（换一把、只改密钥、或换回原来那把）清掉这张卡的「已连通」，改显示中性灰芯片「待测试」（无时间、无说明行、不加「需处理」）。「移除密钥」不显示芯片，卡片回到未配置的样子。要再看到「已连通」，必须重新测试成功。换密钥之后才返回的旧测试结果作废，不能写回。
- **费用与隐私说明**：有外发的卡片底部常显，不弹窗。多模态卡的文案：「会把单个公式或图的裁图发给你选的服务；问 AI 时还会发送你的问题和引用的段落。按该服务的价格计费，不上传整页 PDF。密钥只存在本机（chrome.storage.local），不随浏览器同步。」

## 5 问 AI 用哪个模型（不设设置页）
1. 已配多模态（密钥非空，且厂商 / 模型能看图）→ 用多模态卡的厂商和模型。
2. 没配多模态，但翻译用的是大模型引擎 → 用翻译引擎的模型。
3. 两者都没有 → 问 AI 面板显示「未配置模型」，「去设置」跳到 `#mm`。
4. 多模态已配但调用失败 → 报错，并给出「去设置」，**不**改用翻译模型。

界面文案：
- 多模态卡标题下常显：「问 AI 也用这个模型；没配时用翻译的文字模型。」
- 翻译页的当前引擎卡（仅大模型引擎）加一句：「没配多模态模型时，问 AI 也用这个模型。」

## 6 状态
| 状态 | 表现 |
|---|---|
| 加载 | 读取设置超过 150 ms 才显示骨架（标题条 + 3 行），布局不跳 |
| 读取失败 | 页顶显示 warn 色提示「没能读取已保存的设置」+ [重试]。页面显示默认值，这时任何操作都不写存储 |
| 空（多模态没选厂商） | 模型、Base URL、测试都禁用；公式开关区显示「需先配置 · 去配置」 |
| 运行失败 | 公式开关下方显示「最近失败 · 原因 · HH:MM」。侧栏条目显示「需处理」，**只在出错时**出现，未配置时不显示 |
| 文献库导入没完成 | 「数据与隐私」侧栏条目显示「需处理」，`#data` 导入组显示 F4UI-25 的行（SET-11） |
| 文献库打不开（DBB） | 只影响 `#data` 前三组：用量「暂时读不了」，导入 / 导出禁用并说明「本机存储暂时打不开，稍后再试」；不出页顶错误行，不出角标（SET-37） |
| `features.pdf` 关 | `#mm` 页顶显示「PDF 阅读在实验室里还没开启 · 开启」，页面其他部分照常可配置 |

## 7 布局与窄窗口
- 左侧栏宽 220，内容区最大宽 720，内边距 24 / 32。
- 分组卡圆角 10；每行最小高 44，内边距 8 / 16；控件高 28；开关 38×22。
- 只用 `--oi-*` token。配色 A 见 §10：在 `options/options.css` 顶部用 `body.oi-settings` 作用域覆盖，不改 `ui/tokens.css`。
- 窗口宽 < 760：侧栏收成顶部 44 高的条（当前页下拉 + 搜索）。
- 窗口宽 < 520：行内控件换到标题下方，占满整行。
- 最小支持宽 420：不重叠、不裁切、不出现横向滚动条。
- 无障碍：可以用 Tab 走遍所有控件；导航支持 ↑ / ↓；开关带 `role=switch` 和 `aria-checked`。

## 8 验收索引（SET-01…41）
| ID | 要点 |
|---|---|
| SET-01 | 正好 8 个一级页、3 组，顺序 / 名称 / 锚点与 §1 一致；「多模态 · OCR」在常规组第 2 位；没有「高级」页 |
| SET-02 | 8 个锚点都能直接打开对应页；旧锚点 `#engine #reading #features #advanced #ai #formula` 按 §1 表重定向（`#formula → #mm`）；`#data?focus=usage\|import\|export` 滚到对应组并落焦点，再用 replaceState 去掉 query；Aa「公式设置…」（现链接 `options.html#formula`）打开 `#mm` 并聚焦第一个空字段（2026-10-15 改） |
| SET-03 | 旧设置项都能在新页面找到，值读写一致 |
| SET-04 | 即时保存 ≤ 300 ms，刷新后保持；页面上没有「保存设置」按钮 |
| SET-05 | 空输入不覆盖已存密钥。① 已存 `sk-test…3f9a`；② 清空后按 Tab → 存储不变，恢复掩码，不提示「已保存」；③ 输入 3 个空格后按回车 → 同 ②；④ 粘贴 `  sk-new123  ` 后按 Tab → 存入 `sk-new123`，提示「已保存」；⑤ 只有「移除密钥」能让存储变空；⑥ 只输入、不离开也不按回车 → 不写存储 |
| SET-06 | 掩码显示前 3 + 后 4；「显示」30 s 后自动恢复掩码 |
| SET-07 | 「移除密钥」立即清空，对应开关从 DOM 中移除；5 s 内撤销后全部恢复 |
| SET-08 | 所有密钥只在 local，sync 中没有。现状翻译引擎 `settings.providers.*.apiKey` 和 `pdfLayout.cloudApiKey` 仍在 sync（`lib/storage.js`）；多模态和 OCR 的密钥已在 local `formulaSettings` 里（`multimodal.apiKey`、`ocr.apiKey`）。sync 里已有的 key 先迁到 local，再从 sync 删掉；迁移可重复跑；迁移、导入和回滚都要有测试 |
| SET-09 | 有外发的卡片常显费用和隐私说明；打开开关时不弹确认框 |
| SET-10 | FUI-01…15 在新样式下回归通过 |
| SET-11 | 「需处理」只在出错时出现：密钥测试失败、最近运行失败、文献库「导入没完成」（F4UI-25，「数据与隐私」条目）。长期保存未开启、文献库暂时打不开（DBB）、只是未配置，都不出角标（2026-10-15 改）。保存密钥后的「待测试」和用户中止的测试也不出角标（2026-10-18） |
| SET-12 | Aa 面板与设置页之间开关同步 ≤ 500 ms，不用刷新 |
| SET-13 | 设置存储（sync / local）读取失败时显示页顶错误行和 [重试]，不写存储。文献库（IndexedDB）打不开是另一种状态，只影响 `#data` 的存储用量 / 导入 / 导出三组，按 DB-BLOCKED §4.3 文案，不触发这条错误行（见 SET-37）（2026-10-15 改） |
| SET-14 | 写入失败时控件回滚，并显示「没保存上 · 重试」 |
| SET-15 | 加载 < 150 ms 不显示骨架；≥ 150 ms 显示骨架，CLS ≤ 0.02 |
| SET-16 | 宽 759 时侧栏变成顶部条；宽 519 时控件换行；420 宽下不重叠、不裁切。`#data` 导入组的双按钮行（导入待继续 / 导入没完成）在 < 520 时按钮换到说明下方并排、各占 50%，说明不截断（同 DATA-17）（2026-10-15 改） |
| SET-17 | 可用键盘操作，focus 环可见；开关语义正确 |
| SET-18 | `#notes` 只有 3 行，读写 `chrome.storage.local`：笔记位置（`reader.notesPaneSide`，左 / 右，默认右 `end`）；侧栏面板宽度（`reader.panelWidth`，默认 440，360–640，按钮「恢复 440」）；三栏笔记宽度（`reader.notesWidth`，默认 360，320–480，按钮「恢复 360」）。点「恢复 440」后阅读页侧栏面板立即变 440，点「恢复 360」后三栏笔记栏立即变 360；值已是默认时按钮禁用。没有「默认布局」「新笔记默认类型」（Wisdom 2026-10-15 22:00）。阅读器和笔记面板代码不改 |
| SET-19 | 导出拆成「文献库」和「设置」两个文件，都不含任何 API key。设置导出不带 key；导入设置也不写入 key；导入旧设置文件时忽略里面的 key，并给出提示「文件里的 API 密钥已忽略，请在本机重新填写。」导入后 sync 中不存在任何密钥（所有 `settings.providers.*.apiKey`、`pdfLayout.cloudApiKey`、`formulaSettings` 的 `multimodal.apiKey` / `ocr.apiKey`）。现状会留下非空的 `settings.providers.openai.apiKey`（Anvil 测 #128 时复现），这只是已复现的例子。迁移后再导入一次，不把 key 写回 sync |
| SET-20 | `features.pdf` 关时，`#mm` 显示页顶提示，页面仍可配置 |
| SET-21 | 搜索「密钥」能命中 4 处密钥行，点击后跳过去并高亮 1.2 s |
| SET-22 | 同步开关置灰，`keys.syncOptIn` 恒为 `false` |
| SET-23 | 没有「问 AI」页；`#ai` 落到 `#mm` |
| SET-24 | 多模态卡在空 / 测试中 / 失败 / 已连通四种状态下，都常显「问 AI 也用这个模型；没配时用翻译的文字模型。」 |
| SET-25 | 多模态卡的隐私说明包含「问 AI 时还会发送你的问题和引用的段落」 |
| SET-26 | 已配多模态：问 AI 请求发往多模态的厂商和模型 |
| SET-27 | 没配多模态、翻译是大模型：问 AI 请求发往翻译模型；翻译卡显示对应提示 |
| SET-28 | 两者都没有：问 AI 面板显示「未配置模型」，「去设置」打开 `#mm` |
| SET-29 | 移除多模态密钥后，问 AI 立即改用翻译模型；撤销后又回到多模态 |
| SET-30 | 多模态失败时问 AI 报错，不改用翻译模型 |
| SET-31 | 不再读写 `ask.model`；设置页没有问 AI 专属控件 |
| SET-32 | 文献库迁移和导入不挡当前阅读。导入在任一 Open Immerse 页面开着时继续，全部关掉就暂停，下次打开接着做（DATA-06，Wisdom 2026-10-15 21:47）。设置导入是一次性写入，不算后台任务（2026-10-15 改） |
| SET-33 | `#data` 有「再申请一次」（DATA-03）。持久存储被拒时不阻止导入。键分开：文献库全局 `library.persistHintDismissed`；笔记按篇 `reader.notesPersistHintDismissed.<docHash>`（不带后缀的同名键只是 #130 前的旧数据块，迁移时读）。阅读页只显示文献库提示卡，笔记被拒也触发这张卡；点过「不再提示」后两种都不再出现（F4UI-16 / 27，Wisdom 2026-10-15 21:47）。设置页本身不画这张卡（2026-10-15 改） |
| SET-34 | 迁移或导入的「完成」用中性色加 ✓ |
| SET-35 | 打开 `options.html#formula` 落到 `#mm`，地址栏被替换；Aa「公式设置…」不论旧链接还是新链接都到 `#mm` |
| SET-36 | `#data?focus=export\|import\|usage` 从阅读页提示卡、F4 小标签和弹层打开时，滚到对应组并落焦点，query 被去掉；与 DATA-18 一致 |
| SET-37 | 文献库打不开（DBB）时，`#data` 存储用量显示「暂时读不了」，导入、导出按钮禁用并说明「本机存储暂时打不开，稍后再试」；设置 · 备份与恢复、密钥一览、同步三组照常；页顶不出现「没能读取已保存的设置」；恢复后 ≤ 1 s 复原 |
| SET-38 | 搜索「导入」「导出」「备份」分别命中 `#data` 的文献库导入、文献库导出、设置 · 备份与恢复，点击跳过去并高亮 1.2 s |
| SET-39 | 配色 A（§10）：设置页所有文字与其背景的对比度 ≥ 4.5（用脚本按计算后的颜色测：正文、行说明、muted、侧栏选中、链接、主按钮字、warn 标题、出错行内文字、chip），非文字图形（开关、进度条、输入框边框）≥ 3 |
| SET-40 | 设置页（含 `#data`、内嵌的公式面板）的计算样式里不出现旧暗色蓝黑底和浅红：`#12151c #181c26 #1e2430 #232a38 #171b24 #6b8cff #e8a0a0`；出错和失败一律用 `--oi-warn #8A4B0F`，完成用中性 ✓（次文字色） |
| SET-41 | 配色覆盖只在设置页生效：`ui/tokens.css` 无改动；popup、学习中心、文档翻译页截图与 main 一致；阅读器（`pdf/`）和笔记面板无改动（Wisdom 2026-10-15 22:00） |

## 9 与 PR-4 `#data` 模块的衔接（2026-10-15）
- PR-4 先在现有 options 页加临时 tab「数据」（`data-nav="data"`），只放存储用量、文献库 · 导入、文献库 · 导出三组，代码在独立模块 `options/data-panel.js`，导出 `mountDataPanel(root)`；DOM 用 `.set-gh` + `.set-group > .set-row`，每组带 `data-focus`；颜色只用 `--oi-*`。
- 本 PR 把 `mountDataPanel` 挂进「数据与隐私」页的前三组位置，后面接设置 · 备份与恢复（从 engine tab 搬来）、密钥一览、同步；临时 tab 去掉；`#data` 不需要重定向；DATA-01…26 的测试原样保留并通过。
- 如果本 PR 先合入：由本 PR 建 `#data` 页和后三组，PR-4 只挂 `mountDataPanel`。
- 「需处理」角标读取 `mountDataPanel` 暴露的状态（导入没完成）。

## 10 配色 A 暖纸（Wisdom 2026-10-15 22:00 定）
色值取自 `pdf/reader-tokens.css` 的 warm 主题和 `--oi-reader-ai`。在 `options/options.css` 顶部加 `body.oi-settings { … }`（`options.html` 的 body 加 `class="oi-settings"`），**不改 `ui/tokens.css`**，阅读器和笔记面板不改。

| token | 值 | 来源 |
|---|---|---|
| `color-scheme` | `light` | — |
| `--oi-bg` | `#F6F3EC` | warm-paper |
| `--oi-bg-elevated`（侧栏） | `#ECE9E2` | warm-well |
| `--oi-panel`（分组） | `#FCFAF6` | warm-surface |
| `--oi-card`（次级按钮底） | `#F6F3EC` | warm-paper |
| `--oi-input` | `#FFFFFF` | warm-thumb |
| `--oi-line` / `--oi-line-strong` | `#E4DED2` / `#8A806C` | warm-line / line-strong |
| `--oi-text` / `--oi-text-muted` | `#22201C` / `#655F54` | warm-ink / muted |
| `--oi-text-2`（新增，行说明） | `#4A463E` | warm-ink-2 |
| `--oi-accent` / `--oi-accent-hover` | `#2A6670` / `#22555E` | reader-ai（hover 加深 15%） |
| `--oi-accent-subtle`（选中底） | `rgba(34,32,28,.07)` | warm-hover 加深 |
| `--oi-focus` | `#2F55D4` | reader-focus |
| `--oi-danger` | `var(--oi-warn)` | 出错不用浅红 |
| `--oi-success` | `var(--oi-text-2)` | 完成用中性 ✓ |
| `--oi-warn`（新增） / `--oi-warn-soft`（新增） | `#8A4B0F` / `rgba(138,75,15,.08)` | reader-warn |
| `--oi-primary`（新增，主按钮底） / `--oi-on-accent`（新增，主按钮字） | `#22201C` / `#F7F3EA` | warm-ink / tooltip-fg |

- 另把 `options.css` 写死的 4 处颜色（`.provider-test-status.is-ok/.is-err`、主按钮 `#fff`、`.oi-set-chip.is-ok #2E6B3F`）改用上面的 token。`#formulaSettingsRoot` 保持 `data-reader-theme="warm"`。合计约 25 行，无结构改动。
- 对比度（脚本算，半透明底先与分组色混合）：正文 15.60、行说明 9.01、muted / 页底 5.71、muted / 侧栏 5.22、侧栏选中 11.76、链接 6.23、主按钮字 14.68、warn / 出错行底 5.79、行说明 / 出错行底 8.02、chip 8.03。最低 5.22（SET-39）。

## 11 变更记录
- **2026-10-15 22:00（Wisdom 定）**：设置页配色用 A 暖纸（§10，SET-39…41）；`#notes` 只放 3 项（笔记位置、侧栏宽度恢复 440、三栏宽度恢复 360），不做「默认布局」「新笔记默认类型」（SET-18）；阅读器和笔记面板都不改，只改设置界面。
- **2026-10-15（Loom，按 IMPACT-2026-10-15.md）**：以仓库 `docs/settings-spec.md`（e4f464d，SET-01…34）为基线同步；改 SET-02（`#formula → #mm`、`#data?focus=`）、SET-08、SET-11、SET-13、SET-16、SET-18、SET-19、SET-32、SET-33；新增 SET-35…38；公式开关键名为 `formulaSettings` 里的 `formula.tier2/ocr/tier3.enabled`，笔记面板按篇提示键为 `reader.notesPersistHintDismissed.<docHash>`；新增 §9 与 PR-4 衔接。依据 Wisdom 2026-10-15 21:47（F4 Q4 / Q5）。
