# PDF 左右栏 · 滚轮 / 滚动体验（PDF-DUAL-SCROLL-WHEEL）

**来源：** 2026-09-23 Wisdom（四类全修）via Forge / Jone copy → Loom。  
**基线：** main tip `87d4beffff3dafd7eb835fe29443277e57b9ce08`（已含 #53 formula rhythm）。  
**摸底：** `pdf-scroll-survey-87d4beff`（基线审计，未入库）。  
**挂接：** [`PDF-MD-READOUT.md`](./PDF-MD-READOUT.md)；公式节奏 [`../pdf/high-precision/FORMULA-RIGHT-PANE.md`](../pdf/high-precision/FORMULA-RIGHT-PANE.md)（**本单不改**）。  
**fixture：** Attention Is All You Need。

**明确不做：** 网页双语、Soft Graphite、#40 镜像、公式裁切主路径 / FORMULA-RIGHT-PANE / #53。

---

## 0. 四类痛点 → 产品锁（权威）

> **Wisdom 覆盖（2026-09-23 批计划）：** 页级跟随 **默认关**。禁 smooth、删 360ms lock、单侧 driver、contain、§6 手感条目不变。

| # | 痛点 | 规格锁 |
| --- | --- | --- |
| 1 | 左右不同步 / 对不齐 | **页级弱跟能力保留、默认关**（Wisdom 2026-09-23 覆盖）；打开后：驱动栏换页 → 跟随栏对齐同页锚；**不做** scrollTop 比例 / bbox 像素同步 |
| 2 | 跟手慢、有延迟 | 跟随路径 **禁止** `behavior: "smooth"`；**删除或压缩** 固定 **360ms** `syncLock`（见 §3） |
| 3 | 滚一侧另一侧乱跳 | **单侧驱动**：同一手势内只有驱动栏原生滚；跟随栏只做一次瞬时对齐；禁止双向 `scrollIntoView` 对打 |
| 4 | 惯性过冲 / 边界弹 | 两侧保持 `overscroll-behavior: contain`；跟随不用 smooth 叠惯性；顶底停住、不串栏、不橡皮筋互推 |

对照代码现状（摸底）：左 `#pages` ↔ 右 `#translateScroll`；双向 `scrollIntoView({smooth})` + `syncLock` 360ms —— **本单要拆掉这条对打链**。

---

## 1. 滚动根与边界

| | 左 | 右 |
| --- | --- | --- |
| 容器 | `#pages.pages`（连续页栈，gap 16px） | `#translateScroll.pane-translate-scroll`（通读流） |
| overflow | `auto` | `auto` |
| 边界 | `overscroll-behavior: contain` | 同左 |
| 惯性 | **UA 原生**（触控板/鼠标同一规则） | 同左 |
| 目标手感 | 连续页栈跟手；有溢出时走原生滚，勿额外 JS 阻尼 | 通读原生滚；跟随时瞬时跳页锚，不二次 smooth |

左栏若「无纵向溢出」时的滚轮翻页（`wheelPageDelta` → `goPage`）：保留，但 `goPage` 的视口对齐用 **`behavior: "auto"`**，且 **同一 wheel 手势最多翻 1 页**。

---

## 2. 同步规则（页级 · 单侧驱动）

### 2.1 粒度

- **页级**：用视口中线（或等价）得到 `currentPage`；跟随栏滚到 `[data-page="n"]`（右）或对应 `.page` wrap（左）。  
- **不做** 段级连续比例跟随（通读高 ≠ 原页高）。  
- **块级**只留给 **click-sync**（点右栏块 → 左高亮 + `scrollIntoView`），见 §5。

### 2.2 驱动 / 跟随

```
指针/滚轮落在左 → driver=pdf（右仅在弱跟开启时跟随）
指针/滚轮落在右 → driver=readout（左仅在弱跟开启时跟随）
```

| 规则 | |
| --- | --- |
| **弱跟开关** | `pdfScroll.softPageFollow`：**默认关**（**Wisdom 2026-09-23 批计划覆盖**；覆盖本文此前「默认开」） |
| 默认关 | 两侧 **完全独立滚动**；换页不对侧跳；click-sync 仍可用（§5） |
| 驱动栏 | **只**原生滚动；不因跟随逻辑改自己的 scrollTop |
| 跟随栏（仅弱跟开） | 仅当 `driver.currentPage` **变化**时，瞬时对齐一次（`behavior: "auto"` / 写 `scrollTop`） |
| 同页内细滚 | 驱动栏在同页内上下挪 → **跟随栏不动** |
| 脱钩 | 用户开始滚原跟随栏 → 该栏立刻升为新 driver，取消未完成跟随 |
| 缝隙 | 中缝不改 scroll；不抢 wheel |

### 2.3 禁止对打

```
BAD:  左 scroll → smooth 右 scrollIntoView → 触发右 onScroll → smooth 左 scrollIntoView → …
GOOD: 左 scroll → page 变化 → 右 scrollTop/锚点 auto 一次；期间忽略右 scroll 的回传同步
```

---

### 2.4 Options 开关（可开可关 · 默认关）

| | 锁定 |
| --- | --- |
| 存储键 | `pdfScroll.softPageFollow`（boolean，**默认 `false`**） |
| DOM id | `#pdfSoftPageFollow`（`<input type="checkbox">`） |
| 可见性 | 仅当 **PDF 功能开**（`features.pdf` / 现有 PDF 实验室入口为真）时显示；与 `#pdfLayoutBox` 同级可见条件 |
| 位置 | Options → **功能** → PDF 区块内，放在「PDF 划区」(`#pdfLayoutBox`) **上方** 的「PDF 阅读」小组：先开关，再划区高级项 |
| 文案（label） | `左右栏换页跟随` |
| 说明（hint，muted） | `默认关闭。开启后，滚动换页时另一侧对齐到同一页；跟手瞬时对齐，不会拖尾。` |
| 开态实现 | **必须**走 §2.2–§3 同一套：单侧 driver + `auto` / 写 `scrollTop` + 无 360ms 长锁 + 无双向 smooth 对打。**禁止**开启后回潮旧 `smooth`+360ms 路径 |
| 关态 | 两侧完全独立；不注册栏间跟随（click-sync 除外） |
| 持久化 | 写入现有 settings / `chrome.storage.sync`（与其它 PDF 项同 blob）；导出/导入设置须带上该键 |

```html
<!-- Options · 功能 · PDF 阅读（features.pdf 开时显示） -->
<div id="pdfReadingBox" class="pdf-reading-box">
  <h3>PDF 阅读</h3>
  <label class="check">
    <input id="pdfSoftPageFollow" type="checkbox" />
    左右栏换页跟随
  </label>
  <p class="hint">默认关闭。开启后，滚动换页时另一侧对齐到同一页；跟手瞬时对齐，不会拖尾。</p>
</div>
<!-- 既有 #pdfLayoutBox 仍在下方 -->
```

## 3. 跟手：去掉拖尾（痛点 2）

> **开态同样适用：** `softPageFollow=true` 时栏间跟随也必须满足本节；不是「关掉才优化、打开用旧逻辑」。

| 现状 | 规格 |
| --- | --- |
| `scrollIntoView({ behavior: "smooth" })` 用于栏间同步 | 栏间同步 **一律 `auto`**（或直接算 `scrollTop`）；**用户手指/滚轮**仍走原生惯性 |
| `syncLock` 固定 **360ms** | **删除固定 360ms**。改为：`syncOwner = driver`，在驱动栏 `scroll`/`wheel` 活跃期内忽略跟随栏的同步回传；于驱动栏 **`scrollend`**（无则 idle **≤100ms**）清除 owner |
| rAF 合批 | 可保留 `onPdfScroll` / `onTranslateScroll` rAF 合批算页号；合批 **不得**再引入额外可感延迟 |

验收口径：快速连滚驱动栏时，跟随栏换页应对齐 **无明显「先停再滑」的 300ms+ 拖尾**。

---

## 4. 滚轮落点与嵌套（不抢、不弹）

| 落点 | 归属 |
| --- | --- |
| `#pdfPane` / `#pages` 内 | 只滚左；`driver=pdf` |
| `#translateScroll` 内（含公式裁图） | 只滚右；`driver=readout` |
| 中缝 | 不滚动；不 `preventDefault` 抢事件（拖分栏除外） |
| 顶栏 | 不绑翻页 |

嵌套：裁图 / 子层 **不得**自建 `overflow:auto` 抢滚；滚公式图 = 滚右通读根。  
两侧已有 `overscroll-behavior: contain` —— **保持**；验收时顶底不得把惯性传给外层壳或对侧栏。

触控板与鼠标：**同一套** driver/跟随规则；`|deltaX| > |deltaY|` 不触发左栏合成翻页。

---

## 5. 与 click-sync / 高亮 / 公式节奏

| 能力 | 关系 |
| --- | --- |
| 点右栏块 → 左 `scrollIntoView` + `.mirror-source-mark`（或等价高亮） | **保留**；视为短暂 `driver=click`，用 `auto`，结束后不残留 360ms 锁去吞掉用户下一次滚轮 |
| 左滚换页 → 右通读页锚 | 本单页级跟随（§2）；**不是** #40 |
| FORMULA-RIGHT-PANE / #53 | **不改**裁切、居中、行内基线、防吞 Fig.n；滚动中裁图不重裁、不抖高（既有） |

---

## 6. Anvil 验收清单（Attention · 鼠标 + 触控板各测）

样张：Attention；左右已译；含公式页（约 p4–p7）。摸底可对照。

验收分两档：**A 默认关（必过）** / **B 打开弱跟（`#pdfSoftPageFollow` 勾选后必过）**。**C/D 在开态与关态都要过**（开态不得回潮 smooth+360ms）。回归 E 两档都过。

### A. 默认关 · 独立（痛点 1 默认态 + 3）

- [ ] `pdfScroll.softPageFollow` 默认 **false** / 关  
- [ ] 只滚左 ≥3 页：右 `scrollTop` **不变**；无自动跳页锚  
- [ ] 只滚右 ≥3 页：左页码 / 左 `scrollTop` **不变**；无对侧乱跳  
- [ ] 中缝悬停滚：两侧都不跟飞  

### B. 打开弱跟 · 页级对齐（痛点 1 开态）

- [ ] Options 在 PDF 功能开时可见 `#pdfSoftPageFollow`，label「左右栏换页跟随」，默认未勾选
- [ ] 勾选并保存后 `pdfScroll.softPageFollow === true`

打开弱跟后：

- [ ] 左滚到下一页中线：右通读落到对应 `[data-page]` 段顶（±1 行可；不许隔页）  
- [ ] 右滚到另一页段：左视口落到同页  
- [ ] 同页内只微挪驱动栏：跟随栏 **不**来回跳  
- [ ] 跟随对齐路径为 `behavior:"auto"`（或写 `scrollTop`），**无** smooth  

### C. 跟手（痛点 2 · 两档都过）

- [ ] 栏间同步路径 **无** `behavior:"smooth"`（**开态跟随路径同样无 smooth**，禁止回潮）  
- [ ] **无**固定 360ms `syncLock`；owner 在 `scrollend` / ≤100ms idle 释放  
- [ ] 触控板快速连滚驱动栏：对侧（若弱跟开）换页无「先顿再滑」的 300ms+ 拖尾；弱跟关时对侧根本不动  

### D. 单向不乱跳 + 边界（痛点 3–4 · 两档都过）

- [ ] 弱跟关：连滚一侧，对侧零跳变（痛点 3 主场）  
- [ ] 弱跟开：连滚一侧，对侧只跟页、无左右振荡 / 双 `scrollIntoView` 对打  
- [ ] 滚到一半改滚对侧：新侧立刻成 driver，旧跟随取消  
- [ ] 右甩到顶/底：停住；左不被惯性带走  
- [ ] 左甩到顶/底：停住；不串外层壳；有溢出时不连翻多页  
- [ ] 鼠标滚轮与触控板均测  

### E. 回归（硬不做）

- [ ] 公式节奏（#53 / FORMULA-RIGHT-PANE）无回归  
- [ ] click-sync 高亮仍可用（与弱跟开关无关）  
- [ ] 网页双语 / Soft Graphite / #40 未动  

---

## 7. 给 Forge / Cloud

| 做 | 不做 |
| --- | --- |
| 默认独立滚动；Options `#pdfSoftPageFollow` 可开可关（**默认关**）；开态同一套 driver/`auto`/无对打 | scrollTop 比例同步、#40、开态回潮 smooth+360ms |
| 删/压 360ms lock → scrollend/短 idle owner | 自研双栏弹簧物理 |
| 保持 overscroll contain；Attention 过 §6 两档 | 改公式主路径、网页 Soft Graphite、双语 |

**建议 tip：** `pdf-dual-scroll-wheel`（基线 `87d4beff…`；挂本文）。  
**权威路径：** `/workspace/open-immerse-specs/PDF-DUAL-SCROLL-WHEEL.md`
