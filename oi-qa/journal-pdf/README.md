# 期刊 PDF：M1 文字层泄漏扫描

M1 只修文字层。它是每篇 PDF 的兜底，也是以后按段落对照多模态输出的参照（漏句、数字对不上）。段落按栏自上而下，并带 bbox。附录 R 的多模态重建不在这里，本分支也不做跨栏分流信号。

仓库里没有 54 篇语料 PDF，也不要把 PDF 或密钥提交进来。扫描和打分都从本机目录读文件。

## 扫描全部 PDF，并给 20 篇样本打分

```bash
node oi-qa/journal-pdf/tools/leak_scan.mjs --corpus /path/to/pdfs --out /tmp/m1-leak.json
```

等价入口：

```bash
python3 oi-qa/journal-pdf/tools/leak_scan.py --corpus /path/to/pdfs --out /tmp/m1-leak.json
```

- `--corpus`：目录里每一个 `*.pdf` 都会扫。54 篇全库就是把这 54 个文件放进该目录。
- 文件名用样本里的名字，或至少以两位编号开头，例如 `08_10_1371_journal_pmed_1003346.pdf`。编号 `13` 会扫到但不会进入样本分（M0 的 scores.csv 没有这篇 Epidemics）。
- 正式数字来自产品路径：pdf.js `getTextContent` → `textLayerToBlocks` 的通读表面。`before` 是同一批文字项、未经 M1 过滤的对照，不是 M0 的 pdftotext / glm 分。
- `--max-pages N` 只扫前 N 页。默认全文。
- `--sample` 可换样本 JSON，默认 `oi-qa/journal-pdf/sample.json`（20 篇）。

样本合并线：泄漏总数 ≤ 20，且泄漏篇数 ≤ 5。v1 发布门仍是泄漏 = 0。报告里的 `sample.pass` 和 `sample.v1ReleaseGate` 按这个口径算。

噪声（页眉、DOI、卷期、页码仍留在正文里）单独计数，不进合并线。

glm 全文重评不在本工具里：不改评分 prompt，也不读取 API 密钥。
