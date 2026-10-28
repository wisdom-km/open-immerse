> 入库说明（2026-10-28，只收录规格，不实现这一页）：Wisdom 2026-10-25 11:58 已批「AI 模型」方案，同时把这一页推迟到 v2。v1 仍用「翻译」和「多模态 · OCR」。见 [`docs/ui-phase2-plan.md`](ui-phase2-plan.md)「2026-10-28 决定」和 [`docs/settings-spec.md`](settings-spec.md) §12。下文是 Loom 2026-10-25 的规格原文，依据行里的 main@e8a3a48 是起草时的代码，不是现在的 main。

# 「AI 模型」页规格（Loom · 2026-10-25）

> 基于 main@e8a3a48（只读副本 `/tmp/oi`）。父文档：仓外 AUDIT.md §11（这次没有一并入库）。
> 表面：browser-extension options 页，只做浅色（方案 A 暖纸）。只用设置页 `--oi-*` 和 AUDIT.md §10 定义的 `--set-*` token，**不用任何 `--oi-reader-*`**。
> 示意图都标「示意 MOCKUP · 非场测」。

## 1 决策摘要
**已批**（Wisdom 2026-10-25 11:58 原话：「批：「AI 模型」方案；PDF 升级时一次性改开并提示；v1 只做浅色」）
| # | 决定 |
|---|---|
| D1 | 新增一级页「AI 模型」，锚点 `#models`，放在侧栏「常规」组第 2 位，替换「多模态 · OCR」。 |
| D2 | 所有 AI 连接（翻译引擎、多模态、OCR、问 AI）都在这一页集中管理：供应商、密钥、模型、Base URL。页面分 4 组：用途 → 大模型连接 → 机器翻译 → OCR。 |
| D3 | 「翻译」页只管翻译行为：选用哪个模型、源/目标语言、先信后润、深度思考、每批条数。 |
| D4 | 公式回退顺序和 3 个公式开关挪到「PDF 阅读」页的「公式」组。 |
| D5 | 迁移版本 v8→v9：保留旧数据、可重复执行、写坏可回滚；同一次迁移里把 `features.pdf` 一次性改成开，并提示一次。 |
| D6 | v1 只做浅色。 |
| D7 | 密钥只存本机（`chrome.storage.local` 的 `oiSecrets`），不进 sync，不进导出文件。 |

**不采用**
- 页名「模型与密钥」：名字长；突出「密钥」容易让人紧张；而且 OCR 和机器翻译本来就不是「模型」，这个名字也不更准。
- 继续按能力分页（翻译页一套、多模态页一套）：同一把 key 要填两遍，这正是现在的问题。
- 弹窗编辑连接：改为在行内展开，和设置页其他地方一致，也不打断阅读。
- 选中的模型被删后自动换一个：会悄悄改变计费，改为报错，让用户自己选。

## 2 页面地图 / 用户路径
侧栏：常规（翻译、**AI 模型**）· 阅读（网页、PDF 阅读、笔记）· 更多（功能与实验室、数据与隐私、关于）。仍是 8 页。

旧锚点重定向（`replaceState`）：`#mm`、`#formula`、`#ai` → `#models`。另外 `#formula` 在 v1 改去 `#pdf?focus=formula`，因为阅读页 Aa 面板的「公式设置…」也要改链到这里。`#models?focus=add|<connId>|use` 会滚动到对应位置并落焦点，然后去掉 query（和 SET-36 一样）。

**路径 A：添加连接**
1. 打开 AI 模型页，在「大模型连接」组点「+ 添加连接」。
2. 行内出现供应商下拉：OpenAI / Gemini / DeepSeek / 豆包（方舟）/ Kimi / Grok / 通义 / Claude / Azure / OpenRouter / MiniMax / 自定义兼容端点。
3. 选好后展开表单：密钥 → Base URL（已预填）→ 模型（预设 + 可手填）。
4. 密钥框失焦或按回车就保存；之后会自动测试一次连接，也可以手动点「测试连接」。
5. 测试成功后，连接行显示「● 可用 · 10:42」。如果「用途」里还有能力没有指定模型，这一项会自动用上新连接（只在它原来是空的时候），并提示 toast「翻译已改用 方舟 · deepseek-v4.1-flash · 撤销」。
- 机器翻译组（DeepL / 微软 / Google / MyMemory）和 OCR 组（智谱 GLM-OCR / 百度）流程一样，只是表单字段不同（第 4 节）。

**路径 B：给某个能力指定模型**
- 在 AI 模型页的「用途」组，或在翻译页第 1 行，打开下拉，从已有连接里选。下拉只列出能用于这个能力的模型：
  - 翻译：所有 LLM、机器翻译、自定义 HTTP。
  - 问 AI：LLM，外加「跟随翻译」。
  - 多模态：带 `vision:true` 的 LLM 模型。
  - OCR：OCR 组。
- 选中即保存，状态行显示「已保存」1.5 秒。

**路径 C：删除一个正在用的连接**
1. 展开连接，点「移除连接」。
2. 行内确认：「方舟（豆包）正在用于：翻译、多模态。移除后这两项需要重新选择。」右侧两个按钮 [取消] [移除]，横排。
3. 移除后，「用途」里受影响的行进入出错状态（第 4.3 节）。toast 显示「已移除方舟（豆包） · 撤销」，5 秒内可撤销，撤销会恢复连接和密钥。
4. 5 秒后才真正删除 `oiSecrets.providers[connId]`。

## 3 Token 与组件表
**Token**：沿用 AUDIT.md §10，不新增色值。

| token | 值 |
|---|---|
| `--set-card-bg / -border / -radius / -shadow` | `var(--oi-panel)` / `1px solid var(--oi-line)` / 10px / none |
| `--set-gh-size`、`--set-gh-gap` | 12px / 500 / muted；上下间距 `24px 0 6px` |
| `--set-group-gap-bare` | 16px |
| `--set-row-min-h`、`--set-row-pad`、`--set-row-gap` | 44px、`8px 16px`、12px |
| `--set-ctl-h`、`--set-btn-gap`、`--set-label-gap` | 28px、8px、6px |
| 本页新增 `--set-expand-pad` | `4px 16px 12px`（展开区内边距）|
| 本页新增 `--set-field-gap` | 10px（展开区里字段之间的间距）|

颜色只用：`--oi-text`、`--oi-text-muted`、`--oi-text-2`、`--oi-line(-strong)`、`--oi-accent(-hover/-subtle)`、`--oi-on-accent`、`--oi-warn(-soft)`、`--oi-success`、`--oi-focus`、`--oi-input`。

**按钮通则**：同一行的按钮横排，`white-space:nowrap`，高度都是 `--set-ctl-h`，间距 `--set-btn-gap`，`flex:none`；会变字的按钮用 `min-width` 锁定为最长文案的实测宽度，避免跳宽。窄于 520px 时按 D5 把整组按钮移到标题下方，仍然一行。

| 组件 | 默认 | hover | active / 选中 | disabled | loading | empty | error | success |
|---|---|---|---|---|---|---|---|---|
| 连接行 `.aim-conn` (`.set-row` + `›`) | 状态点 + 名称 + 摘要 muted | 底 `--oi-accent-subtle` | 展开：`›` 转 90°，下面接展开区 | 不适用 | 状态点换成 `.oi-set-spin` 的设置页版 `.set-spin`（`--oi-line` / `--oi-text`） | 组里只剩「+ 添加连接」行 | 点 `--oi-warn` +「密钥无效」/「连不上」 | 点 `--oi-success` +「可用 · HH:MM」 |
| 用途下拉 `.aim-use select` | 「连接 · 模型」 | 边框 `--oi-line-strong` | focus 2px `--oi-focus` | 没有可选项时换成 empty 样式 | 选项加载中显示「读取中…」，disabled | 文字「还没有可用的模型」+ `.set-inline`「去添加 →」 | `aria-invalid`，边框 `--oi-warn`，下面一行 warn 说明 | 「已保存」1.5 秒 |
| 密钥行 `.set-key-row` | [input flex:1][显示][移除]，一行 | 按钮底 `--oi-accent-subtle` | 「显示」切成「隐藏」，`aria-pressed` | 没有密钥时「移除」disabled | 提交中输入框 readonly，旁边显示 spin | placeholder「粘贴 API 密钥」 | 「密钥无效」warn 文字，`aria-invalid` | 掩码 `sk-••••a801` +「已保存」 |
| 测试连接 `.btn-secondary` + 状态 | 「测试连接」 | 同 btn-secondary | — | 必填项没填 | 「测试中…」disabled + `aria-busy` | — | warn：错误类别 + 原因（≤80 字，规则同 `clipProbeSummary`） | 「✓ 可用 · 支持图片 · 10:42」 |
| 主按钮（确认移除）`.btn-primary` | `--oi-accent` 底 / `--oi-on-accent` 字 | `--oi-accent-hover` | — | opacity .5 | 「移除中…」 | — | — | — |
| 文字按钮 `.set-inline` | accent 色 | 下划线 | — | muted | — | — | — | — |
| 行内确认 `.aim-confirm` | warn-soft 底；一句说明 + [取消][移除]，一行 | — | — | — | — | — | — | — |

## 4 逐屏规格
### 4.1 AI 模型页 `#models`
```
示意 MOCKUP · 非场测
AI 模型                                                    22/600
连接和密钥只存这台电脑，不导出、不同步。                    .set-lead
用途                                                       .set-gh
┌───────────────────────────────────────────────────────┐
│ 翻译        网页、PDF、文档     [方舟 · deepseek-v4.1-flash ▾]│
│ 问 AI       阅读页提问         [跟随翻译                 ▾]│
│ 多模态      认不出的公式裁图    [方舟 · glm-5.3-flash     ▾]│
│ 公式 OCR    单个公式裁图        [未使用                   ▾]│
└───────────────────────────────────────────────────────┘
多模态和 OCR 只上传单个公式的裁图，按次计费；不上传整页 PDF。   .hint（常显，D4）
大模型连接
┌───────────────────────────────────────────────────────┐
│ ● 方舟（豆包）   deepseek-v4.1-flash 等 2 个 · 可用 10:42  › │
│ ▼ Kimi           kimi-k3 · 密钥无效                        │
│   API 密钥  [••••••3f2c                  ][显示][移除]       │
│   Base URL  [https://api.moonshot.cn/v1                  ]  │
│   模型      [kimi-k3            ▾]  [+ 添加模型]            │
│   [测试连接]  密钥无效（401）。请检查密钥是否复制完整。      │
│   移除连接                                    .set-inline  │
│ + 添加连接                                                  │
└───────────────────────────────────────────────────────┘
机器翻译
┌ ● MyMemory（免费）  无需密钥 · 可用 ─────────────────── › ┐
│ + 添加                                                    │
└───────────────────────────────────────────────────────┘
OCR
┌ + 添加 OCR 服务（智谱 GLM-OCR / 百度）                    ┐
└───────────────────────────────────────────────────────┘
```
- 「用途」每行的格式是：标题 13/500 + 说明 12 muted；下拉宽 260px，高 28px。
- 每种连接的表单字段，都来自 `lib/providers.js` 的 `fields` 和 `formula-settings.js` 的预设，**字段不增不减**：
  - LLM 兼容（openai / kimi / minimax / grok / openrouter / deepseek / doubao / qwen / custom-compatible）：apiKey、baseUrl、model（可加多个）、prompt（放进「高级」折叠里，标签「系统提示词」）。另有 openrouter 的 referer / appTitle、minimax / kimi 的 endpoint，也放进「高级」。
  - gemini / claude：apiKey、model、prompt。
  - azure：endpoint、apiKey、deployment、apiVersion、prompt。
  - 机器翻译：mymemory 只有 email；microsoft 有 apiKey、region、endpoint；deepl 有 apiKey、plan；google 有 apiKey。
  - 自定义 HTTP（`custom`）：url、method、headersJson、bodyTemplate、responsePath。归到「机器翻译」组，显示名「自定义 HTTP 接口」。
  - OCR：provider（zhipu / baidu）、apiKey。
- 「自定义兼容端点」必须填 Base URL；没填时提示「请填写 Base URL」（沿用 `CUSTOM_BASE_URL_ERROR`）。Base URL 下方常显 `FORMULA_BASE_URL_NOTE`。方舟显示 `FORMULA_ARK_BASE_NOTE`。
- 同一个供应商可以建多个连接（比如 Ark 的编码计划和按量付费各一个）。显示名默认是「供应商」，重复时自动加「· 2」，名称可以改。

**测试连接的状态**（每个连接一个状态行，`role=status aria-live=polite`）
| 状态 | 状态行文案 | 状态点 |
|---|---|---|
| 没测过 | 「还没测试」 | 空心 |
| 测试中 | 「测试中…」，按钮 disabled | spin |
| 成功 | 「可用 · 10:42」，多模态再加「· 支持图片」 | success |
| 401 / 403 | 「密钥无效。请检查是否复制完整。」；方舟编码计划地址返回 401 时，再接一句 `ARK_PLAN_PAYG_HINT` | warn |
| 404 / 模型不存在 | 「找不到模型 {model}。请换一个或手填。」 | warn |
| 网络 / 超时 | 「连不上 {host}。请检查网络或 Base URL。」 | warn |
| 不支持图片（被指定为多模态时） | 「这个模型不支持图片，不能用于多模态。」 | warn |
- 只要测试失败，侧栏「AI 模型」就显示「需处理」角标，规则和现在的 `set-badge` 一样。

### 4.2 翻译页 `#translate`
- 第 1 组：`模型 [方舟 · deepseek-v4.1-flash ▾]` → 源语言 → 目标语言。下拉用 `<optgroup>` 按连接分组，最后一个选项是「管理模型…」（选它会跳到 `#models`，下拉值不变）。
- 第 2 组「质量与用量」（先信后润、深度思考、每批条数）不变；「当前引擎不支持」的提示改成「当前模型不支持 · 换模型」。
- 删掉：引擎卡（`#providerFields`）、「只显示当前默认引擎…」那行说明、「测试连接」。

### 4.3 空 / 出错 / 加载（翻译、问 AI、多模态、OCR 四个选择器都一样）
| 状态 | 表现 |
|---|---|
| 加载中 | 下拉 disabled，文字「读取中…」，不超过 300ms 不显示 |
| 空（这个能力没有可用的连接） | 不显示下拉，改成：「还没有可用的模型 · 去添加 →」（跳到 `#models?focus=add`）。只有翻译为空时侧栏显示「需处理」；多模态和 OCR 为空时显示「未使用」，这是正常状态，不提醒 |
| 选中的模型或连接已被删除 | 下拉保留原值，显示「deepseek-v4.1-flash（已移除）」，`aria-invalid=true`，下面一行 warn 文字：「这个模型已从 AI 模型页移除，请重新选择。」不自动替换。翻译时直接报这个错，不静默回退 |
| 密钥无效 | 下拉右边显示 chip「密钥无效」（warn）+ `.set-inline`「去修复」（跳到 `#models?focus=<connId>`） |
| 问 AI 选了「跟随翻译」，但翻译本身出错 | 显示「跟随翻译（翻译模型不可用）」，warn |

### 4.4 PDF 阅读页新增「公式」组
- `h3.set-gh` 标题「公式」，内容依次是：回退顺序说明、tier2 / ocr / tier3 三个开关。文案沿用 `FORMULA_SWITCH_COPY`。
- 多模态或 OCR 没有指定模型时，对应开关 disabled，说明改成「先在 AI 模型页指定多模态模型 · 去指定」。

### 4.5 PDF 默认开的一次性提示
- **在哪里显示**：
  1. 设置页 `#pdf` 第一行「PDF 阅读」开关的正下方，一条 `.set-banner`（中性色，不用 warn）；
  2. 升级后第一次打开 PDF 时，阅读器顶部显示一次提示。阅读器在 `pdf/` 里，按自己的规范只用 `--oi-reader-*`，**本页不定它的样式**，文案和这里相同。
- **文案**：「PDF 阅读已默认开启。在浏览器里打开 PDF 会用沉浸译的双栏阅读器；不想用可以在这里关闭。」右侧按钮 [知道了]；设置页里再加 `.set-inline`「关闭 PDF 阅读」。
- **阅读器用单独的文案**（2026-10-25 修订，PR #173 走查 F-02：阅读器里没有可以「在这里」关闭的入口）：「PDF 阅读已默认开启。不想用可以在 设置 › PDF 阅读 里关闭。」其中「设置 › PDF 阅读」是链接，打开 `options/options.html#pdf`。
- **什么时候不再显示**：点「知道了」；或者在任意一处关闭 PDF；或者在任意一处看过一次（满足任一条件）。完成后写 `chrome.storage.local` 的 `oi.notice.pdfDefaultOn = {seenAt}`，之后两处都不再显示。
- 只对**本次迁移被改成开**的用户显示，新安装不显示（`settings.migrationNotes.pdfFlippedAt` 有值才显示）。

## 5 迁移规格（v8 → v9）
### 5.1 现在的存储（代码里实际找到的）
| 位置 | key | 内容 |
|---|---|---|
| sync | `settings.provider` | 当前翻译引擎 id（默认 mymemory） |
| sync | `settings.providers[id].*` | 13 家的非密钥字段：baseUrl、model、prompt、email、region、endpoint、plan、referer、appTitle、deployment、apiVersion、url、method、headersJson、bodyTemplate、responsePath（`apiKey` 在 sync 里被清空，`settings-secrets.js:200–264`） |
| local | `oiSecrets.providers[id]` | 13 家翻译引擎的密钥；另有 `seq / applied / pending` 写入锁 |
| local | `oiSecrets.pdfCloudApiKey`；sync `settings.pdfLayout.*` | PDF 版面识别。**不在本次迁移范围** |
| local | `formulaSettings.multimodal.{provider, apiKey, model, customModel, baseUrl, probe, presetGeneration}` | 多模态（provider 可以是 openai / gemini / deepseek / doubao / kimi / grok / qwen / custom） |
| local | `formulaSettings.ocr.{provider, apiKey, probe}` | OCR（zhipu / baidu） |
| local | `formulaSettings["formula.tier2.enabled" / "formula.ocr.enabled" / "formula.tier3.enabled"]` | 公式开关 |
| sync | `settings.features.pdf` | PDF 总开关（旧默认值 false） |
| sync | `settings.settingsVersion` | 现在是 8 |
| local | `ask.confirmSend` | 问 AI 发送确认，不变 |

### 5.2 新结构
```
sync settings.ai = {
  conns: { <connId>: { vendor, kind: "llm"|"mt"|"http"|"ocr", name, fields: {...非密钥字段}, models: [..] } },
  use:   { translate: {conn, model}|null, ask: "follow-translate"|{conn, model},
           multimodal: {conn, model}|null, ocr: {conn}|null }
}
local oiSecrets.providers[<connId>] = "<key>"     // 键名空间不变；connId 和旧 id 一样时零搬迁
local formulaSettings.{multimodal,ocr}.probe      // 改为按 connId 存在 oiSecrets 之外的 local aiProbe[<connId>]
```

### 5.3 映射（每个旧字段都有去处）
| 旧 | 新 | 规则 |
|---|---|---|
| `settings.providers[id]`（13 家，**每一家都迁**，不只当前选中的） | `ai.conns[id]`：`vendor=id`，`kind` 按 providers.js 的 kind（machine→mt、llm→llm、custom→http），`fields` 原样复制，`models=[fields.model]`（有值时） | connId 就用旧 id，所以 `oiSecrets.providers[id]` 不用动 |
| `settings.provider` | `ai.use.translate = {conn: provider, model: conns[provider].fields.model ?? 预设默认}` | |
| `formulaSettings.multimodal` | 先找已有连接：vendor 映射后相同（doubao 对应 openai 兼容并且 baseUrl 是 ark 的那个连接；kimi 对应 kimi；grok 对应 grok；gemini 对应 gemini；openai 对应 openai），**baseUrl 相同（去掉末尾 /，小写）**，**密钥逐字节相同**。三条都满足就把 model 加进它的 `models`；否则新建 `mm-<provider>` 连接，密钥写到 `oiSecrets.providers["mm-<provider>"]` | 不会覆盖已有的密钥 |
| `multimodal.customModel / presetGeneration` | 放进连接的 `fields`，原样保留 | |
| `multimodal.probe` | `aiProbe[connId]` | |
| `formulaSettings.ocr` | provider 非空时新建 `ocr-<provider>`（kind=ocr），密钥写到 `oiSecrets.providers["ocr-<provider>"]`；`use.ocr` 指向它 | provider 为空时不建 |
| 问 AI | `ai.use.ask = "follow-translate"` | 保持现在的行为 |
| 三个公式开关 | 不变 | |
| `features.pdf` | 一律改成 `true`；如果原值是 false，写 `settings.migrationNotes.pdfFlippedAt = now` | 已批（D5） |

### 5.4 执行规则
- 入口：`lib/storage.js` 的 `migrateSettings` 新增 `version < 9` 分支。密钥部分和 `migrateSyncSecrets` 一样，在 `SECRET_BAG_LOCK` 锁里执行。
- 顺序：
  1. 读三处数据（sync settings、local oiSecrets、local formulaSettings），在内存里算出新结构；
  2. 先写 local：新增的 `oiSecrets.providers[mm-*/ocr-*]` 和 `aiProbe`；
  3. 读回 local，逐字节核对密钥；
  4. 写 sync `settings.ai`，同时写 `settingsVersion: 9`；
  5. 再读回核对一次。
- **可重复执行**：`settingsVersion >= 9` 就跳过；即使强制重跑，`ai` 已存在时也只补缺失的部分，结果和第一次完全相同；connId 是确定性的，不用随机 id。
- **保留旧数据**：`settings.providers`、`settings.provider`、`formulaSettings.multimodal/ocr`（包括其中的 apiKey）在 v9 一个都不删。v9 代码**只读新结构**，旧结构不再写。v10 迁移确认 `ai` 完整后，才清理 `formulaSettings.*.apiKey`（另起 PR）。
- **回滚**：第 2–5 步任何一步出错，就删掉本次新增的 `oiSecrets` 键（只删 `mm-* / ocr-*`，而且只删本次写入的那些），不写版本号；本次运行回退到读旧结构（v9 代码保留旧读取路径作为 fallback）；在诊断日志里记 `migration.v9.failed` + 出错的步骤，不记任何密钥或 URL query。下次启动再试，最多 3 次，失败次数记在 local `oi.migration.v9.attempts`。
- **降级**：如果用户装回 v8，旧字段都在，可以照常使用。
- **导出设置**：`ai.conns.*.fields` 可以导出；密钥永远不导出（D3 / SET 已有规则）。导入 v8 格式的文件时，先按 5.3 转换再合并。

## 6 验收清单
- [ ] AIM-01 侧栏常规组依次是「翻译」「AI 模型」；没有「多模态 · OCR」；仍是 8 页
- [ ] AIM-02 `#mm`、`#ai` 重定向到 `#models`，`#formula` 重定向到 `#pdf?focus=formula`，都不留历史记录
- [ ] AIM-03 `#models?focus=add|<connId>|use` 能滚动到对应位置并落焦点，之后去掉 query
- [ ] AIM-04 页面依次是 4 组：用途 → 大模型连接 → 机器翻译 → OCR；组标题是 `.set-gh`，卡片无阴影，样式全部来自 `--set-*`
- [ ] AIM-05 本页（options 页）CSS 里没有 `--oi-reader-*`，新增规则里没有 hex；SET-41 仍然通过
- [ ] AIM-06 添加连接：12 个供应商可选，表单字段和 providers.js / formula 预设一致，不多不少
- [ ] AIM-07 自定义兼容端点：Base URL 必填，没填时报错文案正确
- [ ] AIM-08 密钥行是一行：input + 显示 + 移除，三者都是 28px 高、`nowrap`，520–1280 宽都不换行
- [ ] AIM-09 密钥失焦或回车就保存；显示 / 隐藏用 `aria-pressed`；没有密钥时「移除」disabled
- [ ] AIM-10 测试连接 7 种状态的文案和颜色与 §4.1 一致；状态行有 `aria-live`；测试中按钮不跳宽
- [ ] AIM-11 测试失败时侧栏「AI 模型」显示「需处理」，修好后角标消失
- [ ] AIM-12 用途下拉只列出适用的模型（多模态只列 vision；OCR 只列 OCR 组；问 AI 有「跟随翻译」）
- [ ] AIM-13 新加的第一个可用连接会自动填到空着的用途里，并有可撤销的 toast；已经指定过的用途不会被改
- [ ] AIM-14 移除正在用的连接：行内确认列出受影响的能力；5 秒内撤销能完全恢复（包括密钥）；5 秒后才删密钥
- [ ] AIM-15 移除后，受影响的选择器显示「（已移除）」+ warn + `aria-invalid`；翻译时报错，不静默回退
- [ ] AIM-16 空状态：翻译没有可用模型时显示「去添加 →」，侧栏显示「需处理」；多模态 / OCR 为空时只显示「未使用」，不提醒
- [ ] AIM-17 密钥无效时，选择器旁边显示 chip「密钥无效」+「去修复」，跳到对应连接并展开
- [ ] AIM-18 翻译页没有引擎卡和测试连接；第 1 组是 模型 / 源语言 / 目标语言；「管理模型…」能跳转
- [ ] AIM-19 公式 3 个开关出现在 `#pdf` 的「公式」组，文案不变；没有指定模型时开关 disabled，并带跳转链接
- [ ] AIM-20 PDF 提示只对被迁移改成开的用户显示；设置页和阅读器只要有一处看过，或者在任意一处关掉 PDF，就都不再显示
- [ ] AIM-21 sync 存储里没有任何密钥字段（扫描 `settings` 整个对象）；导出文件里也没有
- [ ] AIM-22 页面只有浅色，`color-scheme: light`
- [ ] MIG-01 v8 数据 → v9：13 家翻译密钥、多模态密钥、OCR 密钥，迁移后都能按新路径取到，逐字节相等
- [ ] MIG-02 迁移跑 2 次（包括强制重跑），存储深比较相等
- [ ] MIG-03 多模态和翻译 vendor、baseUrl、key 都相同时合并成 1 个连接；key 或 baseUrl 不同时拆成 2 个；已有密钥不被覆盖
- [ ] MIG-04 在第 2、3、4、5 步分别注入错误：版本仍是 8，旧字段完好，`oiSecrets` 里没有本次新增的残留键，诊断日志里没有密钥
- [ ] MIG-05 迁移后旧字段（`settings.providers / provider`、`formulaSettings.multimodal / ocr`）还在，值不变
- [ ] MIG-06 `features.pdf` 原来是 false：迁移后是 true，并写了 `pdfFlippedAt`；原来是 true：不写；新安装：不写，也不提示
- [ ] MIG-07 迁移后用户不用做任何操作：翻译、问 AI、多模态、OCR 各跑一次 e2e 冒烟都通过
- [ ] MIG-08 导入 v8 格式的设置文件，会转换后再合并，不丢字段
- [ ] MIG-09 装回 v8 后仍能用旧字段翻译（降级冒烟）
- [ ] MIG-10 连续 3 次失败后不再自动重试，`attempts` 计数正确

## 7 需拍板
无。三项已批：页名和结构、PDF 一次性改开并提示、只做浅色。剩下的都是执行层面的细节，已在本规格里定好。
