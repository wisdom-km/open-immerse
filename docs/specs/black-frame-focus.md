# 黑框修复 · 最小规格（BF）
Loom · 2026-10-28 00:15（UTC+8）｜代码依据 `feature/multimodal-first@9e1c8f4`（尚未合入 main 15f1824；`git archive` → /tmp/bf-9e1c8f4，只读）｜截图：`wisdom-2026-10-28.png`（Attention 并排，译文栏外的深色框）、`earlier-anvil.png`（DDPM，原文栏外的黑框）
**Wisdom 00:05 拍板：「这个黑框是 bug，它应该不显示。」** 范围只限黑框，不做其他打磨。

## 1. 决策摘要
1. 鼠标点击、拖动分隔条、正常阅读时，原文栏和译文栏**完全不显示边框**。
2. 只有键盘焦点（`:focus-visible`）才显示提示，并且要很轻：整栏容器用 **1px 内缩发丝线**，颜色用新 token `--oi-reader-focus-pane-soft`（映射到已有的 `--oi-reader-line-strong`），**不用**深色框，也不用 2px 的 `--oi-reader-focus`。
3. 按钮、链接、分隔条、标记段落等小控件继续用强焦点环：`--oi-reader-focus` 2px（现有规则不动）。
4. 不全局去掉 outline（不写 `*:focus{outline:none}`），只对点名的容器写 `:focus` / `:focus-visible` 规则。
5. pdf/ 下只用 `--oi-reader-*`（SET-41）；笔记栏同样只用 reader token。
6. **a11y 取舍（Wisdom 决定）**：整栏提示刻意做轻。1px 发丝线的面积远小于 2px 环，观感上低于常规焦点环；容器内的可聚焦项（按钮、标记段落、链接）都保留强焦点环，所以可以接受。算出来的颜色对比度仍 ≥3:1（见 §5）。

## 2. 用户路径
- **A 鼠标阅读**：点译文段落（R-c 对照跳转）→ 原文和译文两栏都没有框；按 `o`/`f` 等快捷键照常生效（焦点在 #readerFlow 内，但不可见）。
- **B 拖分隔条**：按下并拖动 `.split-handle` → 两栏和笔记栏都没有框；分隔条自身的 hover/拖动态维持现状。
- **C 键盘**：Tab 进入译文栏 → 内缩发丝线出现；继续 Tab 到按钮或标记段落 → 该项出现强焦点环，栏的发丝线消失（焦点已移走）；按 Esc 关闭浮层后，焦点回到原处，规则不变。

## 3. 根因与改动点（file:line @9e1c8f4）
| # | 来源 | 证据 | 为什么出框 | 改法 |
|---|---|---|---|---|
| R1 | 译文栏 `#readerFlow` 可聚焦 | viewer.html:271 `tabindex="0"`；viewer.css **没有** `#readerFlow`/`.reader-flow` 的 `:focus` 规则 → 落到 UA 默认的 `outline:auto`（Chrome 渲染成黑白双线框） | — | 加 `.reader-flow:focus{outline:none}` + `.reader-flow:focus-visible{outline:1px solid var(--oi-reader-focus-pane-soft);outline-offset:-1px}` |
| R2 | 点段落时用脚本聚焦 | viewer.js:6703-6706 `onFlowPointerDown` → `$("readerFlow").focus({preventScroll:true})` | Chrome 的启发式：上一次交互是键盘（读者常按 j/k/f/o 快捷键）时，脚本调用 `.focus()` 会让 `:focus-visible` 生效 → 每次点段落都出黑框，这就是 Wisdom 截图的情形 | 保留 focus（`o` 快捷键靠 activeElement 判断，viewer.js:1187），可以加 `focusVisible:false`（`focus({preventScroll:true, focusVisible:false})`），但这个选项 Chrome 不一定支持，不能指望它；真正的保证是 R1 的 `.reader-flow:focus{outline:none}`。代价是脚本聚焦后发丝线可能不出现，这符合 Wisdom 要求的「鼠标路径没有框」 |
| R3 | 原文栏 `#pages` 可被鼠标聚焦 | viewer.html:249 本身没有 tabindex；viewer.js:7639-7640 `if (pages.tabIndex < 0) pages.tabIndex = -1` 实际给它加上了 tabindex 属性，于是点击原文会聚焦 #pages。另外 `.oi-sb` 有 `:focus-within` 规则（viewer.css:603/621，只影响滚动条） | 同 R2 的启发式，加上 UA 默认 outline → 原文栏黑框（Anvil 截图） | 加 `#pages:focus{outline:none}` + `#pages:focus-visible{同 R1 的发丝线}`。tabindex 维持现状（键盘滚动原文要用），不新增 `.focus()` |
| R4 | 拖分隔条 | viewer.js:1885 / 1890 → startSplitDrag / startNotesSplitDrag 调用 `preventDefault`（:1914、:7984），分隔条本身不获焦；之前聚焦的 #readerFlow 或 #pages 保持焦点。拖动引起重绘时，UA 的 auto 环更显眼 | R1/R3 修好后自然消失 | 不改拖动逻辑；验收覆盖即可。分隔条 `:focus-visible::before/::after`（viewer.css:421-430）不动 |
| R5 | 笔记栏 | notes-panel.css:859-861 `.oi-notes :focus-visible{outline:var(--oi-reader-focus-width) solid var(--oi-reader-focus)}`，会命中笔记栏里任何可聚焦的容器（列表或滚动区如果可聚焦，就会出 2px 强环） | 拖笔记分隔条时，如果焦点在笔记滚动区，就出现强框 | 把规则收窄到控件：`.oi-notes :is(button,a,input,textarea,select,[role=menuitem],[role=button]):focus-visible` 保持强环；笔记栏整栏或滚动容器改用发丝线（同 R1） |
| R6 | 其他小块 | `.oi-pdf-math-scroll`（viewer.css:967，用 `--oi-paper-muted` 1px，**违反 SET-41**）、formula-arxiv-pane.js:232/262 `tabIndex=0` 的滚动容器 | 不是黑框来源，属于局部 | 不在本次范围；math-scroll 的 SET-41 违规另记一条 nit，不在此处修 |

## 4. Token 与组件
| Token（reader-tokens.css，浅色和深色都要定义） | 取值 | 用途 |
|---|---|---|
| `--oi-reader-focus-pane-soft` | `var(--oi-reader-line-strong)`（两套都只引用已有 token） | 整栏容器的键盘提示（1px，outline-offset:-1px，内缩以免被 overflow 裁掉） |
| `--oi-reader-focus` / `-width` / `-offset` | 现有值 2px / 2px | 小控件，不改 |
不新增 class。只写选择器：`.reader-flow`、`#pages`、`.oi-notes` 的滚动容器。

## 5. 逐状态 / 数值
| 状态 | 译文栏 | 原文栏 | 笔记栏 |
|---|---|---|---|
| 鼠标点击、拖动、阅读 | 无 outline | 无 outline | 无 outline（控件被点击时也不出环，依赖 :focus-visible） |
| 键盘 Tab 到容器 | 1px 内缩 `--oi-reader-focus-pane-soft` | 同 | 同 |
| 键盘 Tab 到小控件 | 2px `--oi-reader-focus`，offset 2px（现状） | 同 | 同 |
| forced-colors | 发丝线用 `Highlight`（沿用现有 forced-colors 段） | 同 | 同 |
发丝线 `line-strong` 对 paper 的对比度：warm 3.52、white 3.54、sepia 3.73、green 3.61、dark 5.19（数据见 pr189-0ff7a6d/LOOM.md）。数值 ≥3:1，但 1px 的观感很轻，符合「非常轻」。原文栏底色是 track 而不是 paper，实现时需要再量一次；即使低于 3:1，也按 §1-6 的 Wisdom 决定接受。

## 6. 验收清单
- [ ] BF-01 点译文段落（包括 R-c 对照跳转）：先按 j/k/f 键，再用鼠标点段落 → 译文栏和原文栏都没有任何框（Attention 并排，复现 Wisdom 截图的场景）
- [ ] BF-02 点原文页面、在原文里滚动和选字 → 原文栏没有框（复现 Anvil 截图的场景）
- [ ] BF-03 拖源分隔条和笔记分隔条（拖之前先按过键盘）→ 三栏都没有框
- [ ] BF-04 Tab 进入 #readerFlow / #pages → 只出现 1px 内缩的浅色发丝线，不是黑框，也不是 2px 蓝环；四边完整，不被滚动容器裁掉
- [ ] BF-05 Tab 到按钮、链接、分隔条、标记段落 → 仍是 2px `--oi-reader-focus` 强环（没有回退）
- [ ] BF-06 焦点在 #readerFlow 时（鼠标点过之后），`o` 展开原文、`f` 跟随等快捷键仍然生效；←/→ 在分隔条和笔记栏里的行为不变（viewer.js:1238）
- [ ] BF-07 Esc 关闭各类浮层后焦点回到原处，不出现黑框
- [ ] BF-08 warm/white/sepia/green/dark 五个主题下，发丝线可见但很轻；小控件焦点环对比度 ≥3:1（已有数据：5.06–7.40）
- [ ] BF-09 SET-41：新增和修改的 CSS 在 pdf/ 下只用 `--oi-reader-*`，没有 hex；没有全局 `*:focus{outline:none}`
- [ ] BF-10 改动只限 R1–R5 的选择器和 token，不涉及其他视觉

## 7. 落地对照（main 15f1824）

规格原文的行号来自 `feature/multimodal-first@9e1c8f4`。本分支从 `main`（15f1824）切出，同一行为的锚点如下。

| 规格锚点 | 本分支 |
|---|---|
| `viewer.html` `#readerFlow tabindex="0"` | 仍在，不改 |
| `onFlowPointerDown` → `readerFlow.focus({preventScroll:true})` | 保留 focus，并加上 `focusVisible:false` |
| `pages.tabIndex = -1` | 不改，不新增 `#pages.focus()` |
| `o` 快捷键看 `activeElement` 是否在 `.pane-translate` | 不改 |
| `←/→` 在 `.split-handle, .oi-notes` 上提前返回 | 不改 |
| `.oi-notes :focus-visible` 过宽 | 收窄到按钮、链接、输入、`menuitem`、`button` 角色 |
| 笔记正文链接自己的 2px `--oi-reader-link` 环 | 只在 `:focus-visible` 上，鼠标点击不画环 |
| 笔记卡片、分组标题 | 继续 2px `--oi-reader-focus`，避免退回 UA 黑框 |
| `.oi-pdf-math-scroll` 的 `--oi-paper-muted` | 不改 |

发丝线：`.reader-flow`、`#pages`、`.oi-notes`、`.oi-notes-scroll` 在 `:focus` 时 `outline: none`，在 `:focus-visible` 时为 `1px solid var(--oi-reader-focus-pane-soft)`、`outline-offset: -1px`。token 在浅色底和 `dark` 都定义为 `var(--oi-reader-line-strong)`。`forced-colors` 下发丝线用 `Highlight`。
