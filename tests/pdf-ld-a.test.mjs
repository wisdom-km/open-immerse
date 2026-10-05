import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planReaderFlow } from "../lib/pdf-reader-flow.js";
import {
  combinePageResults,
  createPageCache,
  createTranslateSession,
  docStatusView,
  libraryPageRunState,
  pageRunState,
  psEmptyCopy,
  psNoTextCopy,
  psRunning,
  psSkippedCopy,
  qQueued,
  translatedPageTotal,
  translateDocumentPages,
  translatePageBlocks
} from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");

test("LD-a copy, queued ranges, and toolbar totals", () => {
  assert.equal(psRunning(2, 9), "正在翻译 · 2 / 9 段");
  assert.equal(psRunning(0, 0), "正在翻译…");
  assert.equal(psRunning(3, 0).includes("0 / 0"), false);
  assert.equal(qQueued(7, 15), "第 7–15 页 · 排队翻译（9 页）");
  assert.equal(qQueued(4, 4), "第 4 页 · 排队翻译");
  assert.equal(psSkippedCopy(), "参考文献 · 保留原文");
  assert.equal(psEmptyCopy(), "本页没有可翻译的文字");
  assert.equal(psNoTextCopy(), "本页没有文字层");
  assert.equal(pageRunState([{ translation: "甲" }, { translation: "乙" }]), "done");
  assert.equal(pageRunState([{ translation: "", failed: true }]), "failed");
  assert.equal(pageRunState([{ translation: "甲", failed: true }, { translation: "" }]), "partial");
  assert.equal(pageRunState([{ translation: "" }]), "empty");
  const mixed = translatedPageTotal([
    { state: "done" },
    { state: "partial" },
    { state: "failed" },
    { state: "skipped" },
    { state: "empty" },
    { state: "queued" }
  ]);
  assert.equal(mixed.n, 4);
  assert.equal(mixed.needsRetry, 2);
  assert.equal(docStatusView({ n: 0, t: 15, phase: "opening" }).text, "正在读取 PDF…");
  assert.equal(docStatusView({ n: 4, t: 15, needsRetry: 1, phase: "running" }).text, "已译 4 / 15 页");
  assert.notEqual(docStatusView({ n: 15, t: 15, needsRetry: 1, phase: "idle" }).text, "全文已译");
  assert.notEqual(docStatusView({ n: 15, t: 15, needsRetry: 0, phase: "running" }).text, "全文已译");
  assert.equal(docStatusView({ n: 15, t: 15, needsRetry: 0, phase: "idle" }).text, "全文已译");
  const plan = planReaderFlow({
    pageCount: 4,
    pages: new Map([
      [1, { state: "done", hasLayout: true }],
      [2, { state: "queued", hasLayout: false }],
      [3, { state: "queued", hasLayout: false }],
      [4, { state: "skipped", hasLayout: true }]
    ])
  });
  assert.equal(plan.filter((item) => item.kind === "range").length, 1);
  assert.deepEqual(plan.find((item) => item.kind === "range"), { kind: "range", from: 2, to: 3, state: "queued" });
});

test("B2 onPageSkip reports cached, empty, and skip-only without a request", async () => {
  const cache = createPageCache();
  cache.set(1, 1, [{ original: "Hello", translation: "你好", role: "paragraph" }]);
  const skips = [];
  const sent = [];
  await translateDocumentPages({
    numPages: 3,
    docId: 1,
    cache,
    session: createTranslateSession(),
    getPageOriginals: async (page) => (page === 3 ? [{ original: "Body text" }] : []),
    pageSkipReason: (page) => (page === 2 ? "skip-only" : "empty"),
    send: async (message) => {
      sent.push(message.texts);
      return { ok: true, translations: (message.texts || []).map(() => "译") };
    },
    onPageSkip: (info) => skips.push(info)
  });
  assert.deepEqual(skips, [
    { page: 1, reason: "cached" },
    { page: 2, reason: "skip-only" }
  ]);
  assert.equal(sent.length, 1);
});

test("B3 a failed batch is marked and cannot light 全文已译", async () => {
  const partial = await translatePageBlocks(["Alpha sentence.", "Beta sentence."], {
    batchSize: 1,
    send: async (message) => {
      if (message.texts[0].startsWith("Beta")) return { ok: false, error: "batch failed" };
      return { ok: true, translations: ["甲"] };
    }
  });
  assert.equal(partial.results[0].failed, undefined);
  assert.equal(partial.results[1].failed, true);
  assert.equal(pageRunState(partial.results), "partial");
  const failed = await translatePageBlocks(["Gamma sentence."], {
    send: async () => ({ ok: false, error: "down" })
  });
  assert.equal(failed.results[0].failed, true);
  assert.equal(failed.results[0].translation, "");
  assert.equal(pageRunState(failed.results), "failed");
  const totals = translatedPageTotal([{ state: pageRunState(failed.results) }, { state: "done" }]);
  assert.equal(totals.n, 1);
  assert.equal(totals.needsRetry, 1);
  assert.notEqual(docStatusView({ n: totals.n, t: 2, needsRetry: totals.needsRetry, phase: "idle" }).text, "全文已译");
});

test("B1 B4 and the scope segment are gone from the reader", () => {
  const restoreSrc = viewer.slice(viewer.indexOf("/** 原文: view toggle only"), viewer.indexOf("async function openFile"));
  assert.match(restoreSrc, /dataset\.view/);
  assert.doesNotMatch(restoreSrc, /abortTranslateSession|pageCache\.clearPage|pageCache\.clear\(/);
  const flowSrc = viewer.slice(viewer.indexOf("function finalizeReaderFlow"), viewer.indexOf("function settlePairChrome"));
  assert.doesNotMatch(flowSrc, /replaceChildren/);
  assert.match(flowSrc, /orderFlowChildren/);
  assert.equal(viewer.includes("function currentScope"), false);
  assert.equal(viewer.includes("function onScopeClick"), false);
  assert.equal(viewer.includes("function setTranslateScope"), false);
  assert.equal(viewer.includes("function setScopeEnabled"), false);
  assert.equal(viewer.includes("setScopeEnabled("), false);
  assert.match(viewer, /onPageSkip/);
  assert.match(viewer, /capsulePage\(\)/);
  assert.doesNotMatch(viewer, /makeUntranslated|untranslatedLabel|rf-untranslated|rf-translate-progress/);
  assert.doesNotMatch(html, /scope-seg|>当前页</);
  assert.match(html, /id="docStatus"/);
  assert.match(css, /\.rf-page\[hidden\]/);
  assert.match(css, /\.rf-q/);
  assert.match(css, /\.doc-status\s*\{[^}]*height:\s*var\(--oi-reader-topbar-btn-h\)/s);
  assert.match(viewer, /参考文献 · 保留原文|psSkippedCopy\(\)/);
});

test("title structure batch failure is not done and cannot light 全文已译", async () => {
  const title = await translatePageBlocks(
    ["Attention Is All You Need", "Abstract", "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks."],
    { send: async () => ({ ok: false, error: "500" }) }
  );
  assert.equal(title.results.every((row) => row.failed === true), true);
  const body = await translatePageBlocks(
    ["We propose a new simple network architecture, the Transformer."],
    { send: async (message) => ({ ok: true, translations: (message.texts || []).map((text) => `译:${text}`) }) }
  );
  const merged = combinePageResults(title.results, body.results, true);
  const state = pageRunState(merged);
  assert.equal(state, "partial");
  const totals = translatedPageTotal([{ state }]);
  assert.equal(totals.needsRetry, 1);
  assert.notEqual(docStatusView({ n: totals.n, t: 1, needsRetry: totals.needsRetry, phase: "idle" }).text, "全文已译");
  const titleFn = viewer.slice(viewer.indexOf("async function translateTitleStructure"), viewer.indexOf("function structureLanded"));
  assert.match(titleFn, /record\.failed/);
  assert.match(titleFn, /outcome\?\.error|row\?\.failed/);
  assert.match(viewer, /combinePageResults\(/);
});

test("body batch failure is not done and cannot light 全文已译", async () => {
  const title = await translatePageBlocks(
    ["Attention Is All You Need", "Abstract", "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks."],
    { send: async (message) => ({ ok: true, translations: (message.texts || []).map((text) => `译:${text}`) }) }
  );
  const body = await translatePageBlocks(
    ["We propose a new simple network architecture, the Transformer."],
    { send: async () => ({ ok: false, error: "500" }) }
  );
  assert.equal(body.results[0].failed, true);
  const merged = combinePageResults(title.results, body.results, false);
  const state = pageRunState(merged);
  assert.equal(state, "partial");
  const totals = translatedPageTotal([{ state }]);
  assert.equal(totals.needsRetry, 1);
  assert.notEqual(docStatusView({ n: totals.n, t: 1, needsRetry: totals.needsRetry, phase: "idle" }).text, "全文已译");
});

test("library pages without a stored translation stay queued", () => {
  assert.equal(libraryPageRunState({ pairs: [{ translation: "你好", role: "paragraph" }] }), "done");
  assert.equal(libraryPageRunState({ pairs: [], cached: [{ translation: "甲", role: "paragraph" }] }), "done");
  assert.equal(libraryPageRunState({ pairs: [{ translation: "", role: "paragraph" }] }), "queued");
  assert.equal(libraryPageRunState({ pairs: [], skipped: true }), "skipped");
  assert.equal(libraryPageRunState({ pairs: [], empty: true }), "empty");
  const totals = translatedPageTotal([
    { state: libraryPageRunState({ pairs: [{ translation: "甲", role: "paragraph" }] }) },
    { state: libraryPageRunState({ pairs: [] }) },
    { state: libraryPageRunState({ pairs: [] }) }
  ]);
  assert.equal(totals.n, 1);
  assert.notEqual(docStatusView({ n: totals.n, t: 3, needsRetry: totals.needsRetry, phase: "idle" }).text, "全文已译");
  const whole = viewer.slice(viewer.indexOf("function adoptLibraryPages"), viewer.indexOf("async function translateWholeDocument"));
  assert.match(whole, /libraryPageRunState\(/);
  assert.equal(whole.includes('skipped ? "skipped" : "done"'), false);
  const caller = viewer.slice(viewer.indexOf("if (libraryDoc?.pages?.length)"), viewer.indexOf("if (libraryArticle)"));
  assert.match(caller, /adoptLibraryPages\(\)/);
});
