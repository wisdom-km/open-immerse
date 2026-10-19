import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { copyLatexText, mountArxivDisplay, mountArxivInline } from "../lib/formula-arxiv-pane.js";
import { arxivFailSentence } from "../lib/formula-arxiv-session.js";
import { bindStructureRowBids, pairsVerifiedForLibrary } from "../lib/pdf-library.js";
import { libraryPageRunState } from "../lib/pdf-viewer.js";
import { resolveOutboundProvider } from "../lib/providers.js";
import { createNet, installNet } from "../lib/net/fetch.js";
import { loadKatex } from "./helpers/arxiv-paper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const workerSrc = readFileSync(join(root, "background/service-worker.js"), "utf8");
const popupSrc = readFileSync(join(root, "popup/popup.js"), "utf8");

function paintAttrs(rootNode) {
  const found = [];
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop();
    if (!node || node.nodeType !== 1) continue;
    const css = node.getAttribute?.("style") || "";
    if (css) found.push(css);
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length; i += 1) stack.push(kids[i]);
  }
  return found.join(";");
}

test("display mount strips color commands before KaTeX and the pane has no paint styles", () => {
  const katex = loadKatex();
  const seen = [];
  const engine = {
    render(latex, node, options) {
      seen.push(String(latex));
      return katex.render(latex, node, options);
    },
    renderToString(latex, options) {
      return katex.renderToString(latex, options);
    }
  };
  const parsed = parseHTML("<!doctype html><html><body></body></html>");
  const doc = parsed.document;
  Object.defineProperty(doc, "compatMode", { value: "CSS1Compat" });
  const previous = globalThis.document;
  globalThis.document = doc;
  const samples = [
    ["\\color{red}{x+y}", "{x+y}"],
    ["\\textcolor{blue}{z}", "z"],
    ["\\colorbox{yellow}{a}", "a"],
    ["\\fcolorbox{blue}{yellow}{b}", "b"],
    ["\\textcolor{red}{\\frac{a}{b}}", "\\frac{a}{b}"]
  ];
  let fracHost = null;
  try {
    for (const [latex, stripped] of samples) {
      const block = {
        formulaTier: "arxiv",
        latex,
        latexSource: "arxiv-src",
        verified: true,
        eqLabel: "(1)"
      };
      const displayParent = doc.createElement("div");
      assert.equal(mountArxivDisplay(displayParent, block, 1, { katex: engine }), "ok", latex);
      const inlineParent = doc.createElement("span");
      assert.equal(mountArxivInline(inlineParent, block, 1, { katex: engine }), "ok", latex);
      assert.equal(copyLatexText(latex).includes("color"), true, latex);
      assert.match(displayParent.querySelector("[data-latex]").dataset.latex, /color/, latex);
      assert.match(inlineParent.dataset.latex, /color/, latex);
      const shown = seen.slice(-2);
      assert.deepEqual(shown, [stripped, stripped], latex);
      for (const host of [displayParent, inlineParent]) {
        const css = paintAttrs(host);
        assert.equal(/(?:^|;)\s*color\s*:\s*[^;]+/i.test(css), false, `${latex} -> ${css}`);
        assert.equal(/background(?:-color)?\s*:\s*[^;]+/i.test(css), false, css);
        assert.equal(/border-color\s*:/i.test(css), false, css);
      }
      if (latex.includes("frac")) fracHost = displayParent;
    }
    assert.match(paintAttrs(fracHost), /border-bottom-width/);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("arXiv fail copy says 离线 only when the session is offline", () => {
  assert.equal(arxivFailSentence("offline"), "未用 arXiv 源码：离线");
  assert.equal(arxivFailSentence("timeout"), "未用 arXiv 源码：超时");
  assert.equal(arxivFailSentence("http"), "未用 arXiv 源码：下载失败");
  assert.equal(arxivFailSentence("error"), "未用 arXiv 源码：下载失败");
  assert.equal(arxivFailSentence("unpack"), "未用 arXiv 源码：无法解析源码");
  assert.equal(arxivFailSentence("session-failed"), "未用 arXiv 源码：请稍后再试");
  assert.equal(arxivFailSentence(""), "未用 arXiv 源码：未能取得源码");
});

test("page done rebuilds the slot and a view change recounts the chip", () => {
  const start = viewerSrc.indexOf("onPageDone({ page, results }) {");
  const body = viewerSrc.slice(start, viewerSrc.indexOf("onPageError({ page, results }) {", start));
  assert.match(body, /clearSlotPainted\(page\)/);
  assert.equal(body.includes("dataset.painted"), false);
  const viewStart = viewerSrc.indexOf("function setReaderView");
  const viewBody = viewerSrc.slice(viewStart, viewerSrc.indexOf("function cycleReaderView", viewStart));
  assert.match(viewBody, /paintArxivChip\(\)/);
  const ready = viewerSrc.indexOf("arxivPhase = \"ready\"");
  const readyBody = viewerSrc.slice(ready, viewerSrc.indexOf("async function ensureMissingLayouts", ready));
  assert.match(readyBody, /clearSlotPainted\(n\)/);
  assert.match(readyBody, /renderArticle\(\)/);
});

test("structure title and Abstract keep their live bids so reopen stays done", () => {
  const blocks = [
    {
      id: "title-1",
      bid: "bid-title",
      label: "title",
      text: "Attention Is All You Need",
      sourceText: "Attention Is All You Need"
    },
    {
      id: "abs-1",
      bid: "bid-abstract",
      label: "heading",
      text: "Abstract",
      sourceText: "Abstract"
    }
  ];
  const rows = [
    {
      id: "oi-structure:title",
      original: "Attention Is All You Need",
      text: "Attention Is All You Need",
      translation: "注意力就是你所需要的一切",
      role: "title"
    },
    {
      id: "oi-structure:abstract.heading",
      original: "Abstract",
      text: "Abstract",
      translation: "摘要",
      role: "heading"
    }
  ];
  const dropped = pairsVerifiedForLibrary(rows, blocks, { targetLang: "zh-CN" });
  assert.equal(dropped.length, 0);
  assert.equal(libraryPageRunState({ pairs: dropped, blocks, targetLang: "zh-CN" }), "queued");
  const bound = bindStructureRowBids(rows, blocks);
  assert.equal(bound[0].bid, "bid-title");
  assert.equal(bound[0].id, "title-1");
  assert.equal(bound[1].bid, "bid-abstract");
  const verified = pairsVerifiedForLibrary(bound, blocks, { targetLang: "zh-CN" });
  assert.equal(verified.length, 2);
  assert.equal(libraryPageRunState({ pairs: verified, blocks, targetLang: "zh-CN" }), "done");
  const ambiguous = bindStructureRowBids(rows.slice(1), [
    { id: "a", bid: "b1", label: "heading", text: "Abstract" },
    { id: "c", bid: "b2", label: "heading", text: "Abstract" }
  ]);
  assert.equal(ambiguous[0].bid, undefined);
  assert.equal(pairsVerifiedForLibrary(ambiguous, [
    { id: "a", bid: "b1", label: "heading", text: "Abstract" },
    { id: "c", bid: "b2", label: "heading", text: "Abstract" }
  ], { targetLang: "zh-CN" }).length, 0);
  const fn = viewerSrc.slice(viewerSrc.indexOf("function withStructureRows"), viewerSrc.indexOf("function pageResultsFromTranslation"));
  assert.match(fn, /bindStructureRowBids\(/);
});

test("unconfigured outbound is MyMemory and a configured engine stays put", () => {
  const empty = resolveOutboundProvider({
    provider: "openai",
    providers: { openai: { apiKey: "" }, mymemory: { email: "" } }
  });
  assert.equal(empty.providerId, "mymemory");
  assert.equal(empty.fallback, true);
  assert.match(empty.notice, /免费/);
  assert.match(empty.notice, /MyMemory/);
  assert.equal(empty.notice.includes("sk-"), false);
  assert.equal(/[A-Za-z0-9._%+-]+@/.test(empty.notice), false);

  const none = resolveOutboundProvider({});
  assert.equal(none.providerId, "mymemory");
  assert.equal(none.fallback, true);
  assert.match(none.notice, /未配置翻译服务/);

  const kept = resolveOutboundProvider({
    provider: "openai",
    providers: { openai: { apiKey: "sk-test-key" } }
  });
  assert.equal(kept.providerId, "openai");
  assert.equal(kept.fallback, false);
  assert.equal(kept.notice, "");

  const selectedFree = resolveOutboundProvider({ provider: "mymemory", providers: { mymemory: {} } });
  assert.equal(selectedFree.fallback, false);
  assert.match(selectedFree.notice, /免费的 MyMemory/);
  assert.match(viewerSrc, /resolveOutboundProvider\(settings\)/);
  assert.match(viewerSrc, /outbound\.fallback/);
  assert.match(workerSrc, /resolveOutboundProvider\(settings\)/);
  assert.match(workerSrc, /options\.providerId = outbound\.providerId/);
  assert.match(popupSrc, /resolveOutboundProvider\(settings\)/);
  assert.match(popupSrc, /引擎：\$\{shortName\}（免费）/);
});

test("translateBatch sends an unconfigured engine to MyMemory and does not call the network", async () => {
  const urls = [];
  installNet(createNet({
    transport(url) {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: {},
        data: { responseData: { translatedText: "你好" } }
      };
    }
  }));
  globalThis.chrome = {
    storage: {
      sync: {
        async get() {
          return {
            settings: {
              provider: "openai",
              sourceLang: "en",
              targetLang: "zh-CN",
              batchSize: 8,
              providers: { openai: { apiKey: "" }, mymemory: { email: "" } }
            }
          };
        },
        async set() {}
      },
      local: {
        async get() { return {}; },
        async set() {}
      }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
      getURL: (path) => path
    },
    contextMenus: {
      onClicked: { addListener() {} },
      async removeAll() {},
      create() {}
    },
    commands: { onCommand: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() {}, async create() {} }
  };
  try {
    const sw = await import(`../background/service-worker.js?f5mymemory=${Date.now()}`);
    const opts = {};
    const out = await sw.translateBatch(["Hello"], opts);
    assert.equal(out[0], "你好");
    assert.equal(opts.providerId, "mymemory");
    assert.equal(opts.outboundFallback, true);
    assert.equal(opts.providerCalled, true);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/api\.mymemory\.translated\.net\/get\?/);
    assert.equal(urls[0].includes("api.openai.com"), false);
    assert.equal(urls[0].includes("de="), false);
  } finally {
    installNet(null);
  }
});
