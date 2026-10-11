# vendored pdf.js 补丁

版本：pdf.js 4.10.38，文件在 `pdf/vendor/pdf.min.mjs` 和 `pdf/vendor/pdf.worker.min.mjs`。pdf.js 不需要定期升级。

## PR #116：后台不送帧时 `page.render()` 不结束

这处补丁要等 [#116](https://github.com/wisdom-km/open-immerse/pull/116) 合入后才会出现在 main 上。合入前，main 上的 `pdf.min.mjs` 还没有这处修改。

PR #116 修改了 vendored 的 `pdf.min.mjs`，在 `PDFPageProxy.render` 里把 `useRequestAnimationFrame` 固定为 `false`。切片之间改用 0ms `setTimeout`。取消时清掉对应句柄。

原因：浏览器不送帧时（后台标签页、高负载），`page.render()` 的 promise 不会结束，打开 PDF 和翻页都会卡住。

如果以后升级 pdf.js，必须重新打上这处补丁，并跑 `tests/pdf-mini-blank.test.mjs` 里「rAF 永远不出帧时 page.render() 仍能结束」那条测试。
