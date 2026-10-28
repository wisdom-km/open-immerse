# v2 打磨清单

v1 不做以下各项。2026-10-27 Wisdom 定：v1 不带打磨池。2026-10-28 的进度见 [`docs/ui-phase2-plan.md`](ui-phase2-plan.md)「2026-10-28 决定」：main 到 `e8a6467`（#190）；v1 还剩 #189 的拆分、文献库行与顶栏 13/15 对齐、密钥框聚焦即空、终回归，以及批准后发版。

来源：`docs/owner-todo.md` 第七节、第九节，以及 2026-10-28 同步的决策记录。不进 v1。

## 原清单（2026-10-27）

- [ ] 设置页视觉审计余项（AUDIT.md / SETTINGS-POLISH-2）
- [ ] 弹窗布局余项（popup-layout SPEC）
- [ ] 译文出现动效（translate-appear-motion；v1 不做淡入，也不做假打字）
- [ ] F7-PR5 DPO 79 公式参考测试（arXiv 2305.18290v3 第 3–5 页；需预算，仍是参考不是门槛）
- [ ] F8 删除 8 秒撤销；G5 作者、目录 `getOutline`、元数据题名
- [ ] 公式占位 ×4/3 评估
- [ ] L-1 首次库命中慢；M13 测试缺口
- [ ] AI 模型设置页（规格已入库 [`docs/ai-models-spec.md`](ai-models-spec.md)；v1 不新增这一页。Wisdom 2026-10-25）
- [ ] 正文内流式（Kimi / Grok CLI 式真流式；另见 `docs/ui-phase2-plan.md`「2026-10-27 决定」和「翻译等待 · 正文内流式」）

## 2026-10-28 补进清单的打磨项

决策记录只给了名字和编号。改法以对应的仓外规格为准，本文不补画面。

- [ ] KEY-15 密钥框边框颜色
- [ ] 密钥框聚焦时，× 往左移
- [ ] 「点击翻译」相关条目（记录里没有拆条，不在这里展开）
- [ ] Loom 对 #189 的挑刺（记录里写作 Loom #189 nits，条目录在仓外）
- [ ] #190 余项：BF-05 分隔条的默认焦点环；深色主题未查；键盘聚焦后再点击，出现一条很淡的 1px 线（记录里的 F2）
- [ ] #153 的 F-01、F-02、F-03
- [ ] #163 的 N1–N3；J2 字色 1.08；雅黑未加粗
- [ ] #171：邻接字形拒绝，p7（T 与 t）；R2 把推理 token 收到最少；R3 表格误检
- [ ] #180：RT-09；0 段时的复制
- [ ] #114 遗留：`DISPLAY_INK_PREFER=1.4`、公式滚动的端到端、过时的公式文档、「表见原文」闪一下、多余的 ˆ

#190（`e8a6467`）已合入黑框修复。上表是合入之后仍记下的余项，不是「黑框还没修」。规格在 [`docs/specs/black-frame-focus.md`](specs/black-frame-focus.md)。

## 旗标打开时已知、还没收敛

整页多模态替换默认关（Wisdom 2026-10-28 14:34）。下面三条是 [#189](https://github.com/wisdom-km/open-immerse/pull/189) 最后一轮真机 `0007dbb` 上仍失败的项，对照 main `e8a6467`。旗标保持关闭时不进 v1 默认路径。重新打开之前先处理。过程在 [`docs/postmortems/pr189-multimodal-swap.md`](postmortems/pr189-multimodal-swap.md)。

- [ ] 摘要回声仍是英文。Attention 第 1 页摘要正文 `b1-p1-t08yfuug`、版权声明、会议行在 tip 上是英文；main 上摘要是中文。该轮多模态 11 次里 10 次成功，翻译 26 次里 25 次成功
- [ ] 重建条第 10–15 页。第 1–9 页在 274 秒内清掉，第 10–15 页到 300 秒仍显示「正在重建本页」。上一 tip `ff99b28` 曾在 203.7 秒清完 15 页
- [ ] 回退之后重开是空白。Attention 第 2、6 页 0 块，也没有文字层。DPO 第 2 页重开 0 块。笔记正文没有丢，锚点对不上

## v2 功能（不只是打磨）

这些和打磨项一起排在 v1 之后。做法分别有文档，不在本清单里重写。

- [ ] 译文版面镜像（Wisdom 2026-10-27 17:47 放入 v2；17:54、17:57 定稿）。见 [`docs/v2-layout-mirror.md`](v2-layout-mirror.md)
- [ ] 方案 2：本机 PP-DocLayoutV2 检测版面，LLM 只排序。见 [`docs/architecture-redesign.md`](architecture-redesign.md) 第 11 节
- [ ] 阅读器按第 11 节重构存储：稳定块号、按页作废、版面 / 块号 / 译文一处真相、回退状态重开结果确定。验收包括旧库重开等于新打开、回退页不空白、旗标关时多模态请求数为 0
- [ ] 全仓重构进 `core/`（写作域、听觉化、平台分层）。见 [`docs/architecture-redesign.md`](architecture-redesign.md) v1.1。预留目录是以后的代码 PR
- [ ] 桌面版（F11）和公式 OCR 层。见 `docs/ui-phase2-plan.md`「2026-10-27 决定」和 [`docs/desktop-plan.md`](desktop-plan.md)

2026-10-27 清单里把「全仓重构、桌面版、公式 OCR」写在逐条打勾之外。2026-10-28 起上表逐条列出，避免只留在路线图正文里。
