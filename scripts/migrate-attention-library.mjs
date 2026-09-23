/** One-time, hash-locked migration of the Attention legacy readout into page pairs.
 *  Run without flags for an audit; --apply writes via the already-running library API.
 *  The legacy readout is never modified. The page-5 matrix sentence is supplemented
 *  when the text layer has two formula placeholders. Other uncertain pairs stay pending.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { isTranslatableBlock } from "../lib/pdf-blocks.js";
import { composeMatrixProjectionTranslation, storedReadoutBlocks } from "../lib/pdf-library.js";

const HASH = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
const LIBRARY_ROOT = "D:\\open-immerse-pdf-library";
const DOC_DIR = join(LIBRARY_ROOT, "files", HASH);
const SOURCE = join(DOC_DIR, "source.pdf");
const LEGACY = join(DOC_DIR, "readout.md");
const API = "http://127.0.0.1:8765/v1/library/page";

// Indexes refer to storedReadoutBlocks(readout.md), not Markdown line numbers.
// A mapping is accepted only for the exact source prefix and matching protected marks.
const reuse = [
  [1, "Attention Is All You Need", 0], [1, "Abstract", 8],
  [2, "1 Introduction", 9], [2, "Recurrent neural networks,", 10],
  [2, "Recurrent models typically", 11], [2, "Attention mechanisms have", 12],
  [2, "In this work we propose", 13], [2, "2 Background", 14],
  [2, "Self-attention, sometimes", 16], [2, "End-to-end memory networks", 17],
  [2, "To the best of our knowledge", 18], [2, "3 Model Architecture", 19],
  [3, "Figure 1:", 24], [3, "The Transformer follows", 25],
  [3, "3.1 Encoder and Decoder", 26], [3, "3.2 Attention", 31],
  [3, "An attention function can", 32],
  [4, "Figure 2:", 34], [4, "of the values,", 36],
  [4, "3.2.1 Scaled", 35], [4, "In practice, we compute", 39],
  [4, "3.2.2 Multi-Head", 44],
  [5, "output values.", 46], [5, "Multi-head attention allows", 47],
  [5, "3.2.3 Applications", 61], [5, "The Transformer uses", 62],
  [5, "• In \"encoder-decoder", 63], [5, "• The encoder contains", 64],
  [5, "• Similarly, self-attention", 65],
  [5, "In addition to attention", 66], [5, "3.4 Embeddings", 69],
  [6, "Table 1:", 72], [6, "3.5 Positional", 74],
  [6, "Since our model contains", 76], [6, "In this work, we use sine", 77],
  [6, "We also experimented", 81], [6, "4 Why Self-Attention", 82],
  [6, "One is the total", 85], [6, "The third is the path", 86],
  [7, "As side benefit", 91], [7, "5 Training", 92],
  [7, "This section describes", 93], [7, "5.1 Training Data", 94],
  [7, "We trained on the standard", 95], [7, "5.2 Hardware", 96],
  [7, "We trained our models on one", 97], [7, "5.3 Optimizer", 98],
  [7, "5.4 Regularization", 103], [7, "We employ three types", 104],
  [8, "Table 2:", 106], [8, "6.1 Machine Translation", 112],
  [8, "On the WMT 2014 English-to-German", 113],
  [8, "Table 2 summarizes", 120], [8, "6.2 Model Variations", 121],
  [9, "Table 3:", 124], [9, "development set, newstest2013", 126],
  [9, "In Table 3 rows (A)", 127], [9, "In Table 3 rows (B)", 128],
  [9, "6.3 English Constituency", 129],
  [9, "To evaluate if the Transformer", 130],
  [10, "Table 4:", 135], [10, "Our results in Table 4", 139],
  [10, "In contrast to RNN", 140], [10, "7 Conclusion", 141],
  [10, "In this work, we presented", 142],
  [10, "For translation tasks,", 143],
  [10, "We are excited about", 144],
  [10, "The code we used", 145],
  [10, "Acknowledgements", 146], [10, "References", 147],
  [13, "Figure 3:", 210], [14, "Figure 4:", 212], [15, "Figure 5:", 214]
];

// These full source blocks have no complete legacy Chinese counterpart.
// Existing complete legacy paragraphs are reused above without retranslation.
const supplements = [
  [1, "The dominant sequence transduction", () =>
    "主流序列转导模型基于复杂的循环神经网络或卷积神经网络，其中包含编码器和解码器。表现最好的模型还通过注意力机制连接编码器与解码器。我们提出一种新的简洁网络架构 Transformer，它完全基于注意力机制，不再使用循环结构和卷积。两个机器翻译任务的实验表明，这类模型质量更高，同时更易于并行化，所需训练时间也显著减少。在 WMT 2014 英译德任务中，我们的模型达到 28.4 BLEU，比包括集成模型在内的此前最佳结果高出超过 2 BLEU。在 WMT 2014 英译法任务中，我们的模型在 8 块 GPU 上训练 3.5 天，取得 41.8 BLEU，创下新的单模型最优成绩，而训练成本仅为文献中最佳模型的一小部分。我们还将 Transformer 应用于英语成分句法分析，证明它在训练数据充足和有限的情况下都能很好地泛化。"],
  [1, "∗Equal contribution.", () =>
    "∗ 同等贡献。作者排序是随机的。Jakob 提出用自注意力替代 RNN，并开始评估这一想法。Ashish 与 Illia 设计并实现了最初的 Transformer 模型，深度参与了这项工作的各个方面。Noam 提出了缩放点积注意力、多头注意力和无参数的位置表示，也是几乎参与每个细节的另一位作者。Niki 在最初的代码库和 tensor2tensor 中设计、实现、调试并评估了大量模型变体。Llion 还试验了新的模型变体，负责最初的代码库、高效推理及可视化。Lukasz 和 Aidan 花费许多时间设计并实现 tensor2tensor 的各个部分，以其取代早期代码库，大幅改进了结果并显著加快了研究进度。"],
  [1, "†Work performed", () => "† 工作完成时任职于 Google Brain。"],
  [1, "‡Work performed", () => "‡ 工作完成时任职于 Google Research。"],
  [2, "The goal of reducing sequential", (_block, old) =>
    `${old[15].text}位置取平均而降低有效分辨率；我们通过第 3.2 节所述的多头注意力抵消这一影响。`],
  [2, "Most competitive neural", (block, old) => {
    const [x, z, y] = block.placeholders.map((entry) => entry.token);
    if (!x || !z || !y) throw Error("model-architecture placeholders missing");
    const left = old[20].text.replace(/\[\s*,\s*,\s*\]/, "[5, 2, 35]")
      .replace(/\(x\s*,\s*\.\.\.\s*,\s*xn\)/, x)
      .replace(/映射为一个序列\s*$/, `映射为连续表示序列 ${z}。给定 z，解码器生成输出`);
    const right = old[22].text.replace(/\(y\s*,\s*\.\.\.\s*,\s*ym\)/, y);
    return `${left}${right}`;
  }],
  [3, "Encoder: The encoder", (block) => {
    const [n, d] = block.placeholders.map((entry) => entry.token);
    if (!n || !d) throw Error("encoder placeholders missing");
    return `编码器：编码器由 ${n} 个相同的层堆叠而成。每层有两个子层：第一个是多头自注意力机制，第二个是简单的逐位置全连接前馈网络。我们在每个子层周围采用残差连接 [11]，随后进行层归一化 [1]。也就是说，每个子层的输出为 LayerNorm(x + Sublayer(x))，其中 Sublayer(x) 是该子层实现的函数。为便于使用这些残差连接，模型中的所有子层以及嵌入层都输出维度为 ${d} 的表示。`;
  }],
  [3, "Decoder: The decoder", (block, old) => {
    const [n] = block.placeholders.map((entry) => entry.token);
    if (!n) throw Error("decoder placeholder missing");
    return `解码器：解码器同样由 ${n} 个相同的层堆叠而成。${old[28].text}`;
  }],
  [4, "We call our particular", () =>
    "我们将这种注意力称为“缩放点积注意力”（图 2）。输入包括维度为 d_k 的查询和键，以及维度为 d_v 的值。我们计算查询与所有键的点积，将每个点积除以 √d_k，再应用 softmax 函数，得到各个值的权重。"],
  [4, "4To illustrate why", (block) => {
    const [sum] = block.placeholders.map((entry) => entry.token);
    if (!sum) throw Error("footnote formula placeholder missing");
    return `4 为说明点积为何会变大，假设 q 和 k 的各分量是均值为 0、方差为 1 的独立随机变量。那么它们的点积 ${sum} 的均值为 0，方差为 d_k。`;
  }],
  [4, "The two most commonly", (block) => {
    const [scale] = block.placeholders.map((entry) => entry.token);
    if (!scale) throw Error("scaling factor placeholder missing");
    return `最常用的两种注意力函数是加性注意力 [2] 和点积（乘法）注意力。点积注意力与我们的算法相同，区别仅在于缩放因子 ${scale}。加性注意力使用单隐层前馈网络计算兼容性函数。两者的理论复杂度相近，但在实践中点积注意力更快、占用空间更少，因为它可以利用高度优化的矩阵乘法实现。`;
  }],
  [4, "While for small values", (block) => {
    const [scale] = block.placeholders.map((entry) => entry.token);
    if (!scale) throw Error("second scaling factor placeholder missing");
    return `当 d_k 较小时，两种机制表现相近；但当 d_k 较大时，未经缩放的点积注意力不如加性注意力 [3]。我们推测，d_k 较大时点积的数值会变大，使 softmax 函数进入梯度极小的区域⁴。为抵消这一影响，我们将点积乘以缩放因子 ${scale}。`;
  }],
  [4, "Instead of performing a single", () =>
    "我们发现，与其对维度为 d_{model} 的键、值和查询只执行一次注意力函数，不如分别使用 h 组不同的可学习线性投影，将查询、键和值映射到 d_k、d_k 和 d_v 维。随后，对这些投影后的查询、键和值并行执行注意力函数，得到 d_v 维的"],
  [5, "In this work we employ", (block) => {
    const [heads] = block.placeholders.map((entry) => entry.token);
    if (!heads) throw Error("attention-head placeholder missing");
    return `本文使用 ${heads} 个并行注意力层，即注意力头。每个头使用 d_k = d_v = d_{model}/h = 64。由于每个头的维度降低，总计算成本与使用完整维度的单头注意力相近。`;
  }],
  [5, "Where the projections are parameter matrices", (block) => {
    const translation = composeMatrixProjectionTranslation(block.text);
    if (!translation) throw Error("matrix projection placeholders missing");
    return translation;
  }],
  [5, "3.3 Position-wise", () => "3.3 逐位置前馈网络"],
  [5, "While the linear transformations", (block) => {
    const [dimension] = block.placeholders.map((entry) => entry.token);
    if (!dimension) throw Error("feed-forward dimension placeholder missing");
    return `虽然各个位置使用相同的线性变换，不同层使用的参数却不同。另一种描述方式是将其视为两个卷积核大小为 1 的卷积。输入和输出的维度为 ${dimension}，而内层的维度为`;
  }],
  [5, "Similarly to other sequence transduction", (block) => {
    const [scale] = block.placeholders.map((entry) => entry.token);
    if (!scale) throw Error("embedding scale placeholder missing");
    return `与其他序列转导模型类似，我们使用学习得到的嵌入将输入和输出 token 转换成维度为 d_{model} 的向量。我们还使用通常的可学习线性变换和 softmax 函数，将解码器输出转换为预测的下一个 token 的概率。在本模型中，两个嵌入层与 softmax 前的线性变换共享同一个权重矩阵，做法与 [30] 类似。在嵌入层中，我们将这些权重乘以 ${scale}。`;
  }],
  [6, "where pos is the position", (block) => {
    const [offset, position] = block.placeholders.map((entry) => entry.token);
    if (!offset || !position) throw Error("positional offset placeholders missing");
    return `其中 pos 表示位置，i 表示维度。位置编码的每个维度都对应一个正弦波，其波长构成从 2π 到 10000·2π 的等比数列。我们选择这个函数，是因为我们假设它能让模型更容易依据相对位置进行注意力计算：对于任意固定偏移 k，${offset} 都可以表示为 ${position} 的线性函数。`;
  }],
  [6, "In this section we compare", (block) => {
    const marks = block.placeholders.map((entry) => entry.token);
    if (marks.length !== 2) throw Error("self-attention sequence placeholders missing");
    return `本节将自注意力层与循环层、卷积层作比较。后两者通常用于把一个变长的符号表示序列 ${marks[0]} 映射为另一个等长序列 ${marks[1]}，其中 x_i、z_i ∈ R^d，例如典型序列转导编码器或解码器中的隐藏层。为说明为何采用自注意力，我们考虑三个理想条件。`;
  }],
  [6, "As noted in Table 1", () =>
    "如表 1 所示，自注意力层只需常数次顺序操作，就能连接所有位置；循环层则需要 O(n) 次顺序操作。在计算复杂度方面，当序列"],
  [7, "length n is smaller", () =>
    "长度 n 小于表示维度 d 时，自注意力层比循环层更快。这通常适用于最先进机器翻译模型中的句子表示，例如词片 [38] 和字节对 [31] 表示。对于涉及很长序列的任务，可以将自注意力限制在输入序列中以相应输出位置为中心、大小为 r 的邻域内，以改善计算性能。这会使最大路径长度增至 O(n/r)。我们计划在今后的工作中进一步研究这一方法。"],
  [7, "A single convolutional layer", (block) => {
    const [complexity] = block.placeholders.map((entry) => entry.token);
    if (!complexity) throw Error("convolution complexity placeholder missing");
    return `单个卷积层的卷积核宽度若为 k < n，就无法连接所有输入和输出位置对。要做到这一点，连续卷积核需要堆叠 O(n/k) 层；扩张卷积则需要 O(log_k(n)) 层 [18]，从而增加网络中任意两个位置之间的最长路径。卷积层通常比循环层更昂贵，成本高出 k 倍。不过，可分离卷积 [6] 可将复杂度显著降至 O${complexity}。即使 k = n，可分离卷积的复杂度也等于自注意力层与逐位置前馈层的组合，而这正是本模型采用的方法。`;
  }],
  [7, "We used the Adam optimizer", (block) => {
    const [betaOne, betaTwo, epsilon] = block.placeholders.map((entry) => entry.token);
    if (!betaOne || !betaTwo || !epsilon) throw Error("optimizer placeholders missing");
    return `我们使用 Adam 优化器 [20]，参数为 ${betaOne}、${betaTwo} 和 ${epsilon}。训练过程中，我们根据以下公式调整学习率：`;
  }],
  [7, "This corresponds to increasing", () =>
    "这意味着在最初的 warmup_steps 个训练步中，学习率线性增加；此后按步数平方根的倒数成比例下降。我们使用 warmup_steps = 4000。"],
  [8, "Residual Dropout", (block) => {
    const [drop] = block.placeholders.map((entry) => entry.token);
    if (!drop) throw Error("dropout placeholder missing");
    return `残差 Dropout：我们在每个子层的输出与子层输入相加、归一化之前，对其应用 dropout [33]。此外，编码器和解码器堆栈中的嵌入与位置编码相加时，也应用 dropout。基准模型使用的比率为 ${drop}。`;
  }],
  [8, "Label Smoothing", (block) => {
    const [smooth] = block.placeholders.map((entry) => entry.token);
    if (!smooth) throw Error("label smoothing placeholder missing");
    return `标签平滑：训练期间，我们使用取值为 ${smooth} 的标签平滑 [36]。这会损害困惑度指标，因为模型学会降低确信程度，但能提高准确率和 BLEU 分数。`;
  }],
  [8, "6 Results", () => "6 结果"],
  [8, "On the WMT 2014 English-to-French", (block) => {
    const [drop] = block.placeholders.map((entry) => entry.token);
    if (!drop) throw Error("French dropout placeholder missing");
    return `在 WMT 2014 英译法任务中，我们的大模型取得 41.0 BLEU，超过此前发表的所有单模型，训练成本却不到此前最优模型的四分之一。用于英译法的 Transformer（big）模型采用的 dropout 比率是 ${drop}，而不是 0.3。`;
  }],
  [8, "For the base models,", (block) => {
    const [penalty] = block.placeholders.map((entry) => entry.token);
    if (!penalty) throw Error("beam penalty placeholder missing");
    return `对于基准模型，我们把每隔 10 分钟保存的最后 5 个检查点取平均，得到一个模型。对于大模型，我们对最后 20 个检查点取平均。束搜索的束宽为 4，长度惩罚系数为 ${penalty} [38]。这些超参数是在开发集上试验后选定的。推理时，我们将最大输出长度设为输入长度加 50，但在可能时提前终止 [38]。`;
  }],
  [8, "To evaluate the importance", () =>
    "为评估 Transformer 各组件的重要性，我们以不同方式修改基准模型，并测量其在英译德任务上的性能变化，评估所用的是"],
  [8, "5We used values", () =>
    "5 对 K80、K40、M40 和 P100，我们分别使用 2.8、3.7、6.0 和 9.5 TFLOPS 的估计值。"],
  [9, "We trained a 4-layer", (block) => {
    const [model] = block.placeholders.map((entry) => entry.token);
    if (!model) throw Error("parsing model dimension placeholder missing");
    return `我们在 Penn Treebank [25] 的 Wall Street Journal（WSJ）部分训练了一个 4 层 Transformer，维度为 ${model}，训练句子约 4 万句。我们也进行了半监督训练，使用规模更大的高置信度语料和 BerkeleyParser 语料，合计约 1700 万句 [37]。仅使用 WSJ 时，词表大小为 1.6 万 token；半监督设置下则为 3.2 万 token。`;
  }],
  [9, "We performed only a small number", () =>
    "我们只进行了少量实验，在第 22 节开发集上选择 dropout（包括注意力和残差 dropout，见第 5.4 节）、学习率和束宽；其余参数与英译德基准翻译模型相同。推理时，我们"],
  [10, "increased the maximum output", (block) => {
    const [alpha] = block.placeholders.map((entry) => entry.token);
    if (!alpha) throw Error("parsing beam penalty placeholder missing");
    return `将最大输出长度增加到输入长度加 300。仅使用 WSJ 和使用半监督数据时，束宽都设为 21，${alpha}。`;
  }]
];

// The page-5 matrix sentence is supplemented above. Do not list that prefix here.
const uncertainSourcePrefixes = new Map();

function citations(text) {
  return [...String(text || "").matchAll(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g)]
    .map((match) => match[0].replace(/\s+/g, ""));
}

function protectedMismatch(block, translation) {
  const sourceCitations = citations(block.sourceText || block.text);
  const translatedCitations = citations(translation);
  if (JSON.stringify(sourceCitations) !== JSON.stringify(translatedCitations)) return "citation-mismatch";
  const sourceTokens = [...String(block.text || "").matchAll(/⟦f\d+⟧/g)].map((match) => match[0]);
  const translatedTokens = [...String(translation || "").matchAll(/⟦f\d+⟧/g)].map((match) => match[0]);
  if (JSON.stringify(sourceTokens) !== JSON.stringify(translatedTokens)) return "formula-placeholder-mismatch";
  if (/\[\s*(?:,\s*)*\]/.test(translation)) return "empty-citation";
  return "";
}

function findBlock(pages, page, prefix) {
  const matches = pages[page - 1].blocks.filter((block) => isTranslatableBlock(block) &&
    String(block.sourceText || block.text).startsWith(prefix));
  if (matches.length !== 1) throw Error(`expected one source block for p${page}: ${prefix}, got ${matches.length}`);
  return matches[0];
}

async function main() {
  const bytes = readFileSync(SOURCE);
  if (createHash("sha256").update(bytes).digest("hex") !== HASH) throw Error("source PDF hash mismatch");
  const old = storedReadoutBlocks(readFileSync(LEGACY, "utf8"));
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  const pages = [];
  try {
    for (let page = 1; page <= doc.numPages; page++) {
      const pdfPage = await doc.getPage(page);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const layout = textLayerToBlocks({ items: content.items, viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray }, page });
      if (layout.sourceAudit.missing.length || layout.sourceAudit.duplicates.length) {
        throw Error(`source ownership failed on page ${page}`);
      }
      pages.push(layout);
    }
  } finally {
    await doc.destroy();
  }
  const mapped = new Map();
  const rejected = [];
  for (const [page, prefix, index] of reuse) {
    const block = findBlock(pages, page, prefix);
    if (mapped.has(block.sourceId)) throw Error(`duplicate source map ${block.sourceId}`);
    const translation = String(old[index]?.text || "").trim();
    const reason = !translation ? "legacy-empty" : protectedMismatch(block, translation);
    if (reason) {
      rejected.push({ page, sourceId: block.sourceId, legacyIndex: index, reason });
      continue;
    }
    mapped.set(block.sourceId, { translation, status: "verified", legacyIndex: index });
  }
  for (const [page, prefix, compose] of supplements) {
    const block = findBlock(pages, page, prefix);
    if (mapped.has(block.sourceId)) throw Error(`supplement overlaps verified pair ${block.sourceId}`);
    const translation = String(compose(block, old)).trim();
    const reason = protectedMismatch(block, translation);
    if (reason) throw Error(`supplement p${page} ${prefix}: ${reason}`);
    mapped.set(block.sourceId, { translation, status: "supplemented" });
  }
  const pagePayloads = pages.map((layout) => ({
    hash: HASH,
    title: "Attention Is All You Need",
    pageCount: pages.length,
    page: layout.page,
    pairs: layout.blocks.filter(isTranslatableBlock).map((block) => {
      const hit = mapped.get(block.sourceId);
      const uncertain = (uncertainSourcePrefixes.get(layout.page) || []).some((prefix) =>
        String(block.sourceText || block.text).startsWith(prefix));
      return { id: block.id, sourceId: block.sourceId, text: block.text,
        sourceText: block.sourceText || block.text,
        translation: hit?.translation || "",
        status: hit?.status || (uncertain ? "source-uncertain" : "pending"),
        ...(hit?.legacyIndex != null ? { legacyIndex: hit.legacyIndex } : {}) };
    }),
    layout
  }));
  const audit = {
    hash: HASH,
    pages: pagePayloads.map((entry) => ({ page: entry.page,
      verified: entry.pairs.filter((pair) => pair.status === "verified").length,
      supplemented: entry.pairs.filter((pair) => pair.status === "supplemented").length,
      pending: entry.pairs.filter((pair) => pair.status === "pending").map((pair) => ({ sourceId: pair.sourceId, sourceText: pair.sourceText })),
      sourceUncertain: entry.pairs.filter((pair) => pair.status === "source-uncertain").map((pair) => ({ sourceId: pair.sourceId, sourceText: pair.sourceText })) })),
    rejected
  };
  console.log(JSON.stringify(audit, null, 2));
  if (!process.argv.includes("--apply")) return;
  if (!existsSync(join(LIBRARY_ROOT, "library.sqlite"))) throw Error("library index missing");
  const backup = join(LIBRARY_ROOT, "library.sqlite.before-attention-migration-2026-09-23");
  if (!existsSync(backup)) copyFileSync(join(LIBRARY_ROOT, "library.sqlite"), backup);
  for (const payload of pagePayloads) {
    const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload) });
    if (!res.ok) throw Error(`library save failed page ${payload.page}: HTTP ${res.status}`);
  }
  writeFileSync(join(DOC_DIR, "migration-audit.json"), JSON.stringify(audit, null, 2) + "\n");
}

await main();
