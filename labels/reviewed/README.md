# 已复核的标注

`node scripts/label-review.mjs` 把改过的页写到这里：

```
labels/reviewed/<论文 id>/page-001.json
```

文件和预标注用同一个 schema（`open-immerse.labels/v1`）。多出来的 `reviewedUnitIds` 是复核集里已经按「看过，下一个」确认过的单元 id。整页 JSON 可以改标签、合并或拆开单元。

这些文件可以提交。图片接触图在 `labels/sheets/`，检查缓存在 `labels/checks/`，这两处仍不进 git。

复核集本身在 `labels/review-set.json`，由 `node scripts/review-set.mjs` 从预标注生成，种子固定。
