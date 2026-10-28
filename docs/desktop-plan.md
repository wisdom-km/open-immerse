# 桌面版计划（F11）

2026-10-13 17:44 Wisdom 批准。6 个问题全部按推荐。2026-10-13 18:00 改了第 6 条的存储：按平台分开，桌面版直接用本机 SQLite。2026-10-13 18:26：F4 PR-2 的 `StorageBackend` 只用两边都能提供的能力。2026-10-18 Wisdom 定：原 F10 云同步不在插件上做，并入 F11。2026-10-19：公式 OCR API 层不在 v1，挪到 v2，见 `docs/ui-phase2-plan.md`「OCR 不进 v1」。2026-10-27：插件 v2 是全仓重构加桌面版（F11），不进 v1。真·正文内流式和「AI 模型」设置页也在 v2。见 `docs/ui-phase2-plan.md`「2026-10-27 决定」。基线当时是 main@`c9773c8`，进度现以 main@`449f3bf` 和该节为准。本文只记范围、接口和交给谁做，不含视觉设计。视觉到时交给 Loom。

## v2（2026-10-27）

插件 v2 含全仓重构和桌面版（F11），一起做，不进 v1。同批还有真·正文内流式（Kimi / Grok CLI 式；v1 不做假打字，也不做块淡入）和「AI 模型」设置页。打磨条目见 `docs/v2-polish-checklist.md`。

2026-10-28 15:02：阅读顺序的版面模型只在桌面应用上跑。浏览器扩展保持文字层抽出顺序，不重排，继续给小范围试用。桌面默认档与扩展相同；用户打开「智能版式」才跑本地 PP-DocLayoutV2。见 `docs/ui-phase2-plan.md`「2026-10-28 决定」和 `docs/architecture-redesign.md` 第 11 节。这次不改 F11 的安装包范围，也不把权重打进安装包。

## 已定

1. Electron 套壳。同一份前端代码，加平台适配层 `lib/platform/`。现在只在扩展里做不改行为的重构，F11 才建桌面外壳。
2. 签名先做 Mac。Windows 先发不签名的测试版。这一条由 F11-4 做。
3. 桌面版不做网页翻译。以后做 F11b：插件发送到桌面文献库。
4. 桌面版启动本机已装好的本地服务，不打包进安装包。
5. 插件保持免构建。只有桌面版用 esbuild。
6. 存储按平台分开（2026-10-13 18:00）。扩展用浏览器自带的 IndexedDB，不用 SQLite。桌面版文献库存成本机 SQLite。原 PDF 在桌面版存成文件。`StorageBackend` 和 `lib/platform` 的 library 要能在 IndexedDB 和 SQLite 上各做一份实现。`StorageBackend` 只用 IndexedDB 和 SQLite 都能提供的能力，不把 IndexedDB 专有行为漏出接口。细则在下面 F4 PR-2。

桌面版 v1 包含：PDF 阅读、翻译、笔记、文献库（首页）、多模态、arXiv 源码、问 AI、学习中心、文档翻译页，以及云同步（原 F10，含插件的云同步）。公式 OCR API 层不在 v1，挪到 v2（2026-10-19）：百度托管「文档解析（Unlimited-OCR）」，另加可选本机服务（只限 Mac 或独显，不打包进安装包）。约 3B 本地模型做公式 / 页面识别只是 v2 桌面的开放研究，不是本计划的交付。不包含网页翻译、字幕、划词工具条、右键菜单、Alt+T 和 popup。

桌面版密钥经 Electron `safeStorage` 放进系统钥匙串（Mac 是 Keychain，Windows 是 DPAPI）。第一次打开桌面版时重新输入，不从扩展搬密钥。云同步时密钥是否跟账号走仍由用户选择，默认关。这条随 F11 执行（F10 并入，2026-10-18）。密钥只存本机，导出不含 key。

## 路线图

F11 是 Windows / macOS 桌面版，在插件第一版之后。原 F10 云同步不在插件上做，并入本步：桌面端开发时一起做云同步，包括插件的云同步（2026-10-18 Wisdom 定）。F11b 排在 F11 之后：插件把论文或 PDF 发送到桌面文献库。适配层的小 PR 不占 F11 的位置，现在就插进框架间隙。

F11 拆成：

1. **F11-1 外壳**：Electron main 和 preload。打开一篇 PDF 能翻译。验收：Attention 和 DPO 在 Windows、Mac 上跑原有截图门槛。
2. **F11-2 数据**：桌面库目录用 SQLite；原 PDF 存成文件；能导入扩展导出的文献库包。密钥进系统钥匙串，首次启动重新输入。云同步（原 F10，含插件）在本步一起做。密钥规则：只存本机、导出不含 key、是否随账号同步由用户选。
3. **F11-3 本机服务**：主进程拉起、检活并在退出时关掉划区和 GLM-OCR。公式用的 Unlimited-OCR 本机适配器是 v2，不在这一步交付。划区 GLM-OCR 和公式 OCR 不是同一层。
4. **F11-4 打包、签名、公证、更新**：先做 Mac 签名公证；Windows 先发不签名的测试版（已定的第 2 条）。
5. **F11-5 构建开关**：esbuild 只打桌面版。可以和 F11-1 合在一个 PR。扩展继续免构建。

## 现在预留的平台适配层

目录：`lib/platform/`（零构建 ES module）。扩展保持免构建。

- **F4 PR-2**：平台骨架（`kv`、`library`）。文献库的 store 通过 `platform.library.open()` 拿到，不在 `library-store.js` 里直接 `indexedDB.open`。PDF 原文件走 `BlobStore`；桌面版原 PDF 落成文件。`StorageBackend` 只用 IndexedDB 和 SQLite 都能提供的能力，不把 IndexedDB 专有行为漏出接口：事务语义、索引范围和 persist 申请都藏在接口后面，不暴露 `IDBKeyRange`、`versionchange` 这类 IndexedDB 专有对象（persist 是可选能力）。再加一个共用的接口契约测试，IndexedDB 和 SQLite 两份实现都跑这份；这份测试以后要能跑一份 SQLite 实现（SQLite 假实现或 better-sqlite3 夹具）。
- **F4 PR-3**：版面缓存改读写 IndexedDB 的 `layouts`（经 `platform.library`）。过渡期旧的 `oi-pdf-layout:*` 只经 `kv` 双读。8765 的读取和探测走 `net.fetch`。多标签页广播走 `bus`。
- **F4 PR-5**（清理）：删掉过渡期经 `kv` 双读的 `oi-pdf-layout:*` 旧键。GLM-OCR 的启动走 `localServices`。
- **P-A** 统一网络层：`lib/net/fetch.js`，挂在 `platform.net`。超时、重试、缓存、去重；日志里遮住 key；测试里未 mock 的真实请求会失败。厂商请求和 arXiv 下载已改走它，超时和重试次数跟今天一样（厂商无超时、无重试；arXiv 仍是 20 秒，由原来的 `fetchOne` 负责）。划区、阅读器里几处直连，以及 8765 本地库读取留着，原因写在调用点。不改用户可见行为。必须在 F7 之前合入，F7/F9 直接用。
- **P-B** `secrets`：和设置页重设计一起做。扩展放 `chrome.storage.local`；桌面版放系统钥匙串。
- **P-C** `bus`。
- **P-D** 小接口：剪贴板、外链、通知等。
- **P-E** `localServices`。

P-A 到 P-E 都是另开的小 PR，不改现有行为，可以和 F4 并行。

每个 P-* 的验收：行为不变；全量 `node --test` 两遍通过；CDP e2e 不变；`lib` 和 `pdf` 里 `chrome.storage`、`chrome.runtime`、`chrome.tabs` 的命中数只减不增；除 `platform/chrome` 外不准出现 `chrome.*` 的检查先列白名单，逐个 PR 缩小。

## 交给 Loom

桌面版要 Loom 设计的 8 项，到时交给 Loom。这里只列任务名：

1. 首次启动
2. 打开 PDF 的入口
3. 文献库为首页
4. 本机服务状态
5. 更新
6. 扩展与桌面并存
7. 密钥管理
8. 外链与网页
