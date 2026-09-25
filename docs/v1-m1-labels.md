# M1 标注：编号、预标注、复核

这一页给复核的人用。产品界面不在这里。

## 语料

30 篇公式比较密的开放获取论文，6 个领域各 5 篇。清单在 `corpus/manifest.json`。PDF 不进 git。

经济学/金融是第 6 个领域：Quantitative Economics 的期刊 PDF，加上量化金融预印本。Physical Review X、Wiley 和 IOP 的直接 PDF 在这台机器上返回了 403 或 HTML，这些位置用 arXiv 补上，清单里每篇都写了原因。没有 Word 导出的 PDF。

来源分三种：

- `publisher-typeset`：出版社排版，例如 Nature Communications、PLOS。
- `author-latex-journal`：期刊的正式版本，文件仍是作者 LaTeX，例如 JMLR、Forum of Mathematics Sigma、JHEP、Quantitative Economics。
- `author-latex-preprint`：arXiv 预印本。

下载并核对 SHA-256：

```
npm install
node scripts/corpus-fetch.mjs
```

`tests/fixtures/DDPM_2006.11239.pdf` 如果已经在磁盘上，并且哈希和清单里的 `2006.11239` 一致，就直接用它，不必再下一次。

## 元素编号

每一页的每个文字项、没有对上文字的笔画、矢量路径和图片都有一个 id。id 只由这几项决定：种类、完整字符串、字体名、量化到 0.01 的框、路径哈希、以及同一指纹在本页里的序号。

文字项的 `char` 是 pdf.js 给出的整段，不会从一段里按比例切出一个字母。路径的 `char` 和 `font` 必须是空的。把「i」写到根号的框上，id 会对不上，`verifyPageLabels` 会失败。

预标注：

```
node scripts/corpus-prelabel.mjs
```

输出在 `labels/prelabel/<论文>/<page-001.json>`。已经写过的页会跳过，要重做加 `--force`。

## 预标注规则

- 数学字体，或 NewTX、Fourier、TeX CM 这类补充字体：公式，置信度 0.96。
- 数学 Unicode：公式，0.90。
- 等宽字体：代码，0.90。
- 相对正文基线明显上移或下移，并且旁边是数学：公式，0.82。单独的弱上下标是 0.62，会进复核队列。
- 其余正文：文字，0.93。
- 靠近公式的细横线：公式（分数线），0.80。很大的路径和图片：其他。
- 行末、靠右、形如 `(12)` 的正文，并和公式同一行：公式编号，并进那个行间单元。
- 单元置信度是成员里的最低值。低于 0.65 记为 fallback，复核时优先看。

算法环境如果用的是正文字体，预标注仍标成文字。需要的话在复核里改成「其他」。

## 复核

```
node scripts/label-review.mjs
```

用 Chrome 打开它打印的 `http://127.0.0.1:4173/`。这是给 Windows 上复核用的本地页，不是读者界面。

- 颜色：公式按单元分色，正文灰，代码绿，其他橙。置信度低于 0.75 的是虚线。
- 点击选中。拖出方框多选。Shift 追加。
- `1` 公式，`2` 正文，`3` 代码，`4` 其他。
- `d` 行间，`i` 行内，`e` 切换公式编号。
- `m` 把选中的公式并成一个单元。`s` 把选中的成员拆成各自的单元。
- `j` / `k` 在低置信度元素之间跳。`n` / `p` 翻页。
- 左侧队列按低置信度元素多少排序。
- 改动大约 0.4 秒后写入 `labels/reviewed/`。可以导出、导入 JSON。导入会先做编号校验。
- 顶栏有已复核页数和预标注公式单元总数，用来估计要不要复到 1000 个单元以上。

接触图（左：页面轮廓，中：基线 SVG，右：差异。红色是页面有而 SVG 没有）：

```
node scripts/contact-sheet.mjs --paper 1706.03762 --page 4
```

复核页里的「接触图」链接会生成同一页。图片在 `labels/sheets/`，不提交。

## 自动检查

```
node scripts/baseline-checks.mjs
```

表写在 `docs/v1-m1-baseline.md`。基线选择器是 M0 的 `lib/formula-svg.js`，这里没有改它。

- A1：单元裁切矩形里的每一个像素。左边是 pdf.js 关闭字体、画出的轮廓（和录制看到的是同一层墨），右边是基线 SVG。左边有墨、r = 1 内 SVG 没有墨，就计缺笔。不再只在「保留下来的元素」里数。
- A2：进了公式 SVG、但标注不是公式的元素。看的是标注，不是选择器自己的字体判断。
- A3：和预标注单元的元素集合是否完全一致，另外给平均 Jaccard。
- A4：文本层公式块里，SVG 为空的比例。预标注置信度低于 0.65 的比例另列，那是复核队列，不是选择器的回退。

编号一致性：

```
node --test tests/label-pages.test.mjs
```

`tests/attention-boundaries.test.mjs` 是 main 上原有的失败，本里程碑不动它。
