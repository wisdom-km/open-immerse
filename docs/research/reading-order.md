# 学术 PDF 阅读顺序 / 段落衔接：文献与工程调研

日期：2026-10-28（北京时间）。本文从当天的调研稿入库，并按当天打开过的一手页面补了 PP-DocLayoutV2、PaddleOCR-VL 和 GLM-OCR。

标注：【已核实】= 入库时打开过一手来源；【记忆·待复核】= 来自已有知识，链接多半真实，数字或许可证在采用前要再打开；【推断】= 判断，不是出处里的句子。

产品决定不在本文重写。v1 按文字层原序，并加 15:05 的「通顺试接」；v2 在桌面做两档。见 [`docs/architecture-redesign.md`](../architecture-redesign.md) 第 11 节和 [`docs/ui-phase2-plan.md`](../ui-phase2-plan.md)「2026-10-28 决定」。

## 1. 结论先行

1. 学术界把「接得对不对」拆成块对之间的后继关系（pairwise relation）。PP-DocLayoutV2、Detect-Order-Construct、DLAFormer、ROOR 都是这一路。【已核实】
2. 「比翻译容易」只对了一部分。单个「A 后面是不是 B」是小分类，几何和类别就能做。难点是区域检测会错、N×N 关系要解成无环序列，以及跨栏、跨页的同一段续写需要文本线索。【推断】
3. PP-DocLayoutV2 = RT-DETR 检测 + 6 层 Transformer 指针网络。指针网络吃框和类别，输出 N×N 先后 logit，再用 win-accumulation 解出拓扑一致的顺序。官方版面分析页没有写文字进入这个指针网络。【已核实】
4. ROOR（EMNLP 2024）认为「阅读顺序是一条排列」这个假设本身有问题，应做成有向无环关系：一块可以有多个后继，页眉、图注可以不进主序列。脚注、图表、页眉因此不该插进主文流。【已核实】
5. 有 arXiv LaTeX 源，就能自动造「真值顺序 + 段落续接」标签。ReadingBank 用 Word XML 造过约 50 万页；页数是【记忆·待复核】。用 LaTeX 源做我们自己的真值，是【推断】。

## 2. 方法 / 工具

| 名称 | 做法 | 输入 | 许可证 | 报告精度 | 成熟度 | 和本仓库的关系 |
| --- | --- | --- | --- | --- | --- | --- |
| **LayoutReader / ReadingBank**（Wang et al., EMNLP 2021）[论文](https://arxiv.org/abs/2108.11591) · [代码](https://github.com/microsoft/unilm/tree/master/layoutreader) | 基于 LayoutLM 的 seq2seq，把乱序词加坐标解码成阅读顺序。ReadingBank 用 DOCX 的 XML 顺序自动标注。 | 文本层词 + bbox（可只用布局） | 代码 MIT（unilm 仓库）【记忆·待复核】；数据集许可【记忆·待复核】 | 页级 BLEU ≈0.98【记忆·待复核】 | 研究原型。社区有 HF 移植（如 hantian/layoutreader）。MinerU 早期用过【记忆·待复核】 | 词级、数百 MB 量级。v1 浏览器扩展不跑它 |
| **XY-cut 及变体**（Nagy & Seth 1984；递归 XY-cut；XY-Cut++ [arXiv:2504.10258](https://arxiv.org/abs/2504.10258) 编号【记忆·待复核】） | 在投影空白处递归横竖切，按切分树得到顺序。变体处理跨栏，或先遮住标题和图。 | 框（文本层或检测） | 算法，无模型许可 | 规整双栏上很高；跨栏图和不规则版式容易错【推断】 | 很成熟。MinerU、PaddleX 的后处理用过【记忆·待复核】 | 纯本地、无模型。15:02 的失败回退是文字层原序，不是 XY-cut |
| **ROOR**（Zhang et al., EMNLP 2024）[论文](https://doi.org/10.18653/v1/2024.emnlp-main.540) · [数据](https://github.com/chongzhangFDU/ROOR-Datasets) | 阅读顺序是块对的有向无环关系，做成关系抽取。199 页、10,662 段、10,967 对。 | 段 + bbox（可加文本或图像） | 见仓库【记忆·待复核】 | 见论文 | 基准加基线，偏表单类 VrD | 定义可借。数据集不是学术论文 |
| **Detect-Order-Construct**（Wang et al. 2024）[arXiv:2401.11874](https://arxiv.org/abs/2401.11874) | 检测，再预测两两关系得到阅读顺序，再建成章节树。附 Comp-HRDoc。 | 页面图像（可加文本行） | 见论文 / 微软【记忆·待复核】 | 其基准上优于启发式【记忆·待复核，未抄表】 | 研究级 | 服务端思路 |
| **DLAFormer**（Wang, Hu, Huo 2024）[arXiv:2405.11757](https://arxiv.org/abs/2405.11757) | 一个 DETR 式模型把区域检测、角色分类、阅读顺序收成关系预测。 | 图像 | 未见公开权重【记忆·待复核】 | DocLayNet、Comp-HRDoc 上优于多阶段【记忆·待复核，未抄表】 | 研究级 | 不进 v1 |
| **PP-DocLayoutV2** [HF](https://huggingface.co/PaddlePaddle/PP-DocLayoutV2) · [版面分析](https://www.paddleocr.ai/latest/version3.x/module_usage/layout_analysis.html) · [arXiv:2510.14528](https://arxiv.org/abs/2510.14528) | RT-DETR-L（PP-DocLayout_plus-L）检出区域和类别，再接 6 层 Transformer 指针网络。绝对二维位置编码加类别标签做嵌入，关系头给出 N×N logit，win-accumulation 解码。类别覆盖正文、标题、摘要、参考文献、公式、图表、页眉页脚、脚注等，文档列了 25 类。 | 页面图像。指针网络的输入是框和类别 | HF 模型卡 `license: apache-2.0`【已核实】。PaddleOCR 仓库 [LICENSE](https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE) 是 Apache-2.0【已核实】 | 版面检测 mAP(0.5) = 81.4。表头写明这只是检测精度，数据集是自建的 1000 张（中英文论文、杂志、报纸、研报、PPT、试卷、课本等）。存储 203.8 MB（约 204MB）。同一页没有阅读顺序准确率，也没有 Lancet / NEJM 这类医学期刊的数字【已核实】。OmniDocBench 上的阅读顺序编辑距离具体数【记忆·待复核】 | 生产级。PaddleOCR 版面分析页把 `transformers` 和 `onnxruntime` 列为引擎；HF 上有 `PaddlePaddle/PP-DocLayoutV2`【已核实】。同一页的快速开始示例写成 PP-DocLayoutV3，速度表里 V2 和 V3 都有。不要把「模块只支持 V2」或「81.4 也是 V3 的 mAP」写成事实 | v2 可选「智能版式」用的就是 V2，跑在桌面，不进浏览器。见第 11 节 |
| **PaddleOCR-VL** [流程文档](https://www.paddleocr.ai/latest/version3.x/pipeline_usage/PaddleOCR-VL.html) · [HF](https://huggingface.co/PaddlePaddle/PaddleOCR-VL) | 两阶段：版面分析给出区域和顺序并裁子图，VLM 按块识别，再按这个顺序合并。文档写明：以 v1 为例，版面分析模型是 PP-DocLayoutV2，VLM 是 PaddleOCR-VL-0.9B。0.9B 是 VLM 组件，不是整条流程的另一个名字。 | 页面图像 | 见 PaddleOCR 仓库 Apache-2.0【已核实】。权重条款若另有 NOTICE，【记忆·待复核】 | HF 模型卡称 OmniDocBench 的 overall / text / formula / tables / reading order 为 SOTA。图里的具体数这次没有抄【记忆·待复核】 | 生产级 | 说明 V2 已被一条生产流程拿去排顺序。我们不接这条 VLM |
| **GLM-OCR**（智谱）[仓库](https://github.com/zai-org/GLM-OCR) · [layout-parsing](https://docs.z.ai/api-reference/tools/layout-parsing) | 0.9B 多模态 OCR（CogViT + 连接器 + GLM-0.5B 解码器）。README：版面分析用 PP-DocLayout-V3，再并行识别。没有另给一个 GLM 自己的顺序模型。云端 `POST /paas/v4/layout_parsing`，模型 `glm-ocr`，返回 Markdown 和 `layout_details`（label、归一化 bbox）。 | 图像或 PDF（云端 URL / base64；PDF ≤50MB、最多 30 页，以该 API 页为准）【已核实】 | 仓库代码 Apache-2.0；GLM-OCR 模型 MIT；管线里的 PP-DocLayoutV3 仍是 Apache-2.0。三句都在 README 的 License 节【已核实】 | README 写 OmniDocBench V1.5 总分 94.62、排名第 1【已核实，是自报，本次未对照榜单】 | 开源 SDK + 云 API。2026-03-12 的技术报告 [arXiv:2603.10910](https://arxiv.org/abs/2603.10910) | 不进 v1。v2 智能版式选定的是本地 PP-DocLayoutV2，不是这条云 API，也不是 V3 |
| **MinerU** [GitHub](https://github.com/opendatalab/MinerU) | 管线：版面检测 + OCR 或文本层 + 阅读顺序。早期是 LayoutReader + XY-cut，2.5 起改为 VLM 出顺序【记忆·待复核】。 | PDF（文本层 + 图像） | AGPL-3.0；近期许可变更【记忆·待复核】 | OmniDocBench 发布方同团队，名次靠前【记忆·待复核，未抄表】 | 生产级 | 服务端。AGPL 对闭源有影响，采用前要再读许可证 |
| **Docling**（IBM）[GitHub](https://github.com/docling-project/docling) · [技术报告](https://arxiv.org/abs/2408.09869) | DocLayNet 上的版面模型 + TableFormer。阅读顺序是规则模型（docling-ibm-models 的 reading_order）。 | PDF 文本层 + 图像 | MIT【记忆·待复核】 | 见技术报告 | 生产级 | 服务端 Python |
| **Marker** [GitHub](https://github.com/datalab-to/marker) | 基于 Surya 的版面和顺序，加启发式，可选 LLM 修补。 | PDF | 代码 GPL-3.0；权重有商用收入限制【记忆·待复核】 | 自报基准【记忆·待复核】 | 生产级 | 服务端 |
| **Surya** [GitHub](https://github.com/datalab-to/surya) | OCR、版面、阅读顺序。曾有独立 order 模型，后并入 layout【记忆·待复核】。 | 图像 | GPL-3.0 + 权重限制【记忆·待复核】 | 自报【记忆·待复核】 | 活跃 | 服务端 |
| **Nougat**（Meta 2023）[arXiv:2308.13418](https://arxiv.org/abs/2308.13418) · [代码](https://github.com/facebookresearch/nougat) | 图像直接出 Markdown，顺序在解码里。训练数据是 arXiv LaTeX 源对齐 PDF。 | 页面图像 | 代码 MIT，权重 CC-BY-NC【记忆·待复核】 | arXiv 上 BLEU 高，会幻觉和重复【记忆·待复核】 | 停更【记忆·待复核】 | 不跑这个模型。它「用 arXiv 源造监督」的做法，评测可以借 |
| **GROBID** [GitHub](https://github.com/kermitt2/grobid) | CRF / 深度序列标注，把 PDF 文本层 token 分成标题、摘要、正文、脚注、参考文献，输出 TEI，顺带拼段落。 | PDF 文本层（pdfalto） | Apache-2.0【记忆·待复核】 | 学术论文元数据和正文结构的长期基准【记忆·待复核】 | 很成熟 | 可作服务端 baseline，不进浏览器 |
| **LayoutLMv3** [arXiv:2204.08387](https://arxiv.org/abs/2204.08387) · **DocLLM** [arXiv:2401.00908](https://arxiv.org/abs/2401.00908) | 文本 + 布局（+ 图像）的通用文档模型。DocLLM 用空间注意力扩 LLM。都不是专用阅读顺序模型。 | 文本层 + bbox（+ 图像） | LayoutLMv3 权重 CC-BY-NC-SA【记忆·待复核】；DocLLM 未开放权重【记忆·待复核】 | 下游任务 | 研究 | 不进本地 |
| **OmniDocBench**（CVPR 2025）[arXiv:2412.07626](https://arxiv.org/abs/2412.07626) · [GitHub](https://github.com/opendatalab/OmniDocBench) | 文档解析基准，含阅读顺序指标（按块顺序的归一化编辑距离）。 | — | 见仓库【记忆·待复核】 | 具体数【记忆·待复核】 | 常用评测集 | 我们的评测要另做医学期刊和 3 栏以上，见第 11 节。不把这里的分数当成 Lancet 的分数 |

段落跨栏、跨页续接：没有找到一个公认的独立 text-continuation 基准。做法散在 GROBID 的序列标注、Docling / MinerU 的规则合并（上块末尾没有句号，下块首字母小写或没有缩进，就合并），以及 Detect-Order-Construct 里「文本行属于哪一块」的关系。句子边界（pySBD、NLTK punkt）可以当语言线索。【记忆·待复核，入库时没有逐个打开这些库】

## 3. 和 15:02、15:05 决定的关系

**可行性【推断】**：把「接不接」做成两两判断是可行的。一块后面的候选很少（下一栏顶、下一页顶、同栏下一块，大约 3–5 个）。线索是几何、类别、上块末字符、下块首字符、字号和字体、连字符、以及拼接起来的困惑度。要防的是检测框错了，以及图、表、脚注、页眉页脚插进主文流。

**15:02 和 15:05 已经定下来的，不再是推断**（全文在架构第 11 节）：

1. v1 浏览器扩展按 PDF 文字层抽出的顺序翻译，不重排。
2. **15:05。** v1 在这个顺序上加轻量「通顺试接」，带去朋友试用，不只留给 v2。每一块只试三个几何候选：同栏下一块、下一栏栏顶、下一页页顶。短上下文拼在一起，留下读起来通顺的那一接。短标题、公式、数字行只按几何。这不是整页重排，也不跑版面模型。打分模型、窗口长度、阈值，15:05 没有定。Kimi 不在 v1。实现另开 PR。
3. v2 的版面模型跑在桌面应用，不跑在浏览器。浏览器继续给小范围试用，并带第 2 条。
4. 默认档与 v1 相同（文字层原序加「通顺试接」）。可选档叫「智能版式」，用户自己打开，面向多栏（例如 Lancet、NEJM）。
5. 本地 PP-DocLayoutV2 吃页面渲染，给出区域、类别和顺序。文字仍来自 PDF 文字层，映射进这些区域，不用 OCR 文字替换文字层。
6. 页眉、页脚、页码、图、图注、脚注移出主文流。
7. 「智能版式」的续接用第 2 条的同一组候选，再核对字体、标点、大小写、连字符。Kimi 只在打平时从这 2–3 个候选里选一个，不重排整页。短标题、公式、数字行两档都只按几何。
8. 失败就回到文字层顺序。这一页不能是空白。
9. 稳定块号来自版面，存在 `core/`，按页作废。

调研稿里的另外几条没有被 15:02 / 15:05 采纳：浏览器里跑 ONNX、用 XY-cut 当断网回退、用逻辑回归或 GBDT 做续接分类器、让 LLM 重排整页。22:03 禁止的是 kimi-k3 整页排序；15:02 只允许 Kimi 在 v2 做 2–3 个候选的平局。上面「可行性」里的困惑度只是推断，15:05 没有把它定成打分办法。

**评测【推断，15:02 把它收成门槛】**：百度公布的 81.4 是版面检测 mAP，不是阅读顺序，材料里也没有医学期刊。3 栏及以上必须用我们自己的评测，不能用 81.4 代替。集合：8–10 篇有 LaTeX 源的 arXiv 论文做真值，再加上手标的 Lancet 等；按单栏、双栏、3 栏及以上分层；要包含跨栏图和跨页续写。指标可以沿 OmniDocBench 的块序列归一化编辑距离，另加 Kendall τ、续接对的 precision / recall / F1（同栏、跨栏、跨页、跨图表分开）、段落级完全正确率，以及翻译后有没有被错切或错拼（人工抽检）。这些指标怎么算，评测还没做，本文不填数字。

## 4. 证据和推断

- 已核实（2026-10-28 打开）：PP-DocLayoutV2 的结构、6 层指针网络、N×N、win-accumulation、只把框和类别送进指针网络、检测 mAP(0.5) 81.4、模型 203.8 MB、表内没有阅读顺序和医学期刊；HF 模型卡 apache-2.0，且 PaddleOCR 能用 transformers 引擎加载版面模型；PaddleOCR-VL v1 的版面分析是 PP-DocLayoutV2；GLM-OCR README 的 0.9B、代码 Apache-2.0、模型 MIT、版面用 PP-DocLayout-V3；[layout-parsing](https://docs.z.ai/api-reference/tools/layout-parsing) 是云端 API。ROOR 的定义和规模、Detect-Order-Construct 与 DLAFormer 的关系预测范式，沿用调研稿里已打开的摘要，论文表内的具体分数没有在入库时再抄。
- 记忆·待复核：LayoutReader 的 BLEU、ReadingBank 的 50 万页、XY-Cut++ 的编号、MinerU / Marker / Surya / GROBID / Docling / Nougat 的许可证最新文本、各家 OmniDocBench 表内数字、DLAFormer 有没有公开权重。
- 推断：两两续接是否够用、检测错误会怎样传播、arXiv 源能不能自动变成我们的真值。评测要做，数字还没有。
