import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GLYPH_GAP_MARK } from "../lib/pdf-glyph-sanitize.js";
import {
  MM_PAGE_COVERAGE_MIN,
  MM_PAGE_SPIKE_HOSTS,
  MM_PAGE_TIMEOUT_MS,
  isCurrentMmPage,
  legacyPageShouldHold,
  mmPageCacheKey,
  mmPageCachePipeline,
  mmPageReason,
  mmPageScheduleOrder,
  pageTextCoverage,
  parsePageJson,
  runMmPage,
  scaleToMaxEdge
} from "../lib/mm-page.js";
import { reconcilePage } from "../lib/mm-reconcile.js";
import {
  applyParagraphSwap,
  planParagraphSwap,
  scrollCompensation,
  structureChange,
  swapShouldDefer
} from "../lib/mm-page-swap.js";
import {
  MM_FAILED_COPY,
  MM_FALLBACK_COPY,
  MM_REBUILDING_COPY,
  MM_RETRY_COPY,
  markContrastOk,
  markFit,
  markPresentation,
  mmPageStatusView,
  staleStatusVisible
} from "../lib/mm-page-ui.js";
import { notePageFormulaLatex, pageLatexForUnit, resetMmPages } from "../lib/formula-mm-ledger.js";
import { layoutCacheKey } from "../lib/pdf-layout-client.js";
import { parseLayoutCacheKey } from "../lib/pdf-layout-key.js";
import { noteMmPage, summarizeMmGapFill } from "../lib/diag-log.js";
import { redactDiagEvent } from "../lib/diag-redact.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");

test("parse rejects broken JSON, a truncated object, and clamps bbox", () => {
  assert.equal(parsePageJson("not json").reason, "parse");
  assert.equal(parsePageJson('{"v":"mp-1","blocks":[{"id":"b1"').reason, "parse");
  assert.equal(parsePageJson('{"blocks":[{"id":"b1","order":1},{"id":"b2","order":1}]}').reason, "parse");
  const parsed = parsePageJson(JSON.stringify({
    v: "mp-1",
    columns: 2,
    blocks: [
      { id: "b2", label: "text", bbox: [-0.2, 0.1, 1.4, 0.4], order: 2, text: "Second." },
      { id: "b1", label: "heading", bbox: [0, 0, 1, 0.1], order: 1, text: "Title" },
      { id: "b3", label: "formula", order: 3, latex: "E=mc^2", text: "secret" }
    ]
  }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.page.blocks.map((block) => block.order), [1, 2, 3]);
  assert.deepEqual(parsed.page.blocks[1].bbox, [0, 0.1, 1, 0.4]);
  assert.equal(parsed.page.blocks[2].text, "");
  assert.equal(parsed.page.blocks[2].latex, "E=mc^2");
  assert.equal(parsed.page.columns, 2);
});

test("coverage under 85 percent is a fallback reason, and the cache key ignores the model", () => {
  assert.equal(MM_PAGE_COVERAGE_MIN, 0.85);
  assert.equal(MM_PAGE_TIMEOUT_MS, 90_000);
  const layer = "a".repeat(100);
  const short = [{ text: "a".repeat(80) }];
  const enough = [{ text: "a".repeat(85) }];
  assert.ok(pageTextCoverage(short, layer) < 0.85);
  assert.ok(pageTextCoverage(enough, layer) >= 0.85);
  assert.equal(mmPageCachePipeline(), "mp-1+fp-1");
  const key = mmPageCacheKey({ hash: "abc", page: 4 });
  assert.equal(key, layoutCacheKey({ hash: "abc", page: 4, mode: "mm-page", pipeline: "mp-1+fp-1" }));
  assert.equal(parseLayoutCacheKey(key).pipeline, "mp-1+fp-1");
  assert.equal(parseLayoutCacheKey(key).mode, "mm-page");
  assert.equal(mmPageReason("empty-key"), "not-configured");
  assert.equal(mmPageReason("401"), "401");
  assert.equal(MM_PAGE_SPIKE_HOSTS.ark.baseUrl.includes("volces.com"), true);
  assert.equal(MM_PAGE_SPIKE_HOSTS.moonshot.baseUrl.includes("moonshot.cn"), true);
  assert.deepEqual(scaleToMaxEdge(4000, 2000), { width: 2000, height: 1000, scale: 0.5 });
  assert.deepEqual(mmPageScheduleOrder([5, 1, 3, 9], 3), [3, 1, 5, 9]);
});

test("runMmPage falls back on timeout, parse, coverage, and a missing configuration", async () => {
  const missing = await runMmPage({ configured: false, pngBase64: "abc", sendVision: async () => ({ ok: true, text: "{}" }) });
  assert.equal(missing.reason, "not-configured");
  const timeout = await runMmPage({
    pngBase64: "abc",
    text: "hello",
    timeoutMs: 20,
    sendVision: () => new Promise(() => {})
  });
  assert.equal(timeout.reason, "timeout");
  const parsed = await runMmPage({
    pngBase64: "abc",
    text: "Hello world.",
    sendVision: async () => ({ ok: true, text: "nope" })
  });
  assert.equal(parsed.reason, "parse");
  const thin = await runMmPage({
    pngBase64: "abc",
    text: "abcdefghijklmnopqrstuvwxyz",
    sendVision: async () => ({
      ok: true,
      text: JSON.stringify({ v: "mp-1", columns: 1, blocks: [{ id: "b1", label: "text", order: 1, text: "ab", bbox: [0, 0, 1, 1] }] })
    })
  });
  assert.equal(thin.reason, "coverage");
  let calls = 0;
  const repaired = await runMmPage({
    pngBase64: "abc",
    text: "Hello.",
    sendVision: async () => {
      calls += 1;
      if (calls === 1) return { ok: true, text: "still prose" };
      return {
        ok: true,
        text: JSON.stringify({ v: "mp-1", columns: 1, blocks: [{ id: "b1", label: "text", order: 1, text: "Hello.", bbox: [0, 0, 1, 0.2] }] })
      };
    }
  });
  assert.equal(calls, 2);
  assert.equal(repaired.ok, true);
});

test("reconcile fills gaps, restores a dropped sentence, and keeps text-layer numbers", () => {
  const text = [{
    id: "a1",
    bid: "bid-a",
    label: "text",
    bbox: [0.1, 0.1, 0.9, 0.3],
    text: `The value is 12 mg. A later sentence was dropped. See the gap ${GLYPH_GAP_MARK} note here.`
  }];
  const mm = [{
    id: "b1",
    label: "text",
    bbox: [0.1, 0.1, 0.9, 0.3],
    order: 1,
    text: "The value is 13 mg. See the gap extra note here."
  }, {
    id: "b2",
    label: "text",
    bbox: [0.1, 0.7, 0.9, 0.9],
    order: 2,
    text: "Invented by the model only."
  }];
  const { blocks, stats } = reconcilePage(mm, text);
  const body = blocks.find((block) => block.id === "a1");
  assert.equal(body.bid, "bid-a");
  assert.equal(body.text.includes("12 mg"), true);
  assert.equal(body.text.includes("A later sentence was dropped."), true);
  assert.equal(body.flags.includes("num-mismatch"), true);
  assert.equal(body.flags.includes("restored"), true);
  assert.equal(body.flag, "num-mismatch");
  assert.equal(stats.gapsFilled >= 1, true);
  assert.equal(blocks.some((block) => block.flag === "mm-only" || (block.flags || []).includes("mm-only")), true);
  const gapped = reconcilePage(
    [{ id: "m", label: "text", bbox: [0, 0, 1, 1], text: "alpha beta" }],
    [{ id: "t", label: "text", bbox: [0, 0, 1, 1], text: `alpha ${GLYPH_GAP_MARK} beta` }]
  );
  assert.equal(gapped.stats.gapsFilled, 1);
  assert.equal(gapped.blocks[0].flag || "", "");
  const held = legacyPageShouldHold(
    { mode: "text-layer", blocks: [{ id: "a", text: "Hi" }], formulaPipeline: "fp-1" },
    { hasTranslation: true }
  );
  assert.equal(held, true);
  assert.equal(legacyPageShouldHold({ mode: "mm-page", pagePipeline: "mp-1", blocks: [{ id: "a" }] }, { hasTranslation: true }), false);
  assert.equal(isCurrentMmPage({ mode: "mm-page", pagePipeline: "mp-1" }), true);
});

test("swap keeps identical nodes, pages a 30 percent structure change, and defers while busy", () => {
  const before = [
    { id: "a", label: "text", text: "Same sentence." },
    { id: "b", label: "text", text: "Old sentence." }
  ];
  const after = [
    { id: "a2", label: "text", text: "Same sentence." },
    { id: "b2", label: "text", text: "New sentence." }
  ];
  const plan = planParagraphSwap(before, after);
  assert.equal(plan.mode, "diff");
  assert.equal(plan.ops[0].op, "keep");
  assert.equal(plan.ops[0].id, "a");
  assert.equal(plan.ops[1].op, "replace");
  const grown = Array.from({ length: 10 }, (_, index) => ({ id: `n${index}`, label: "text", text: `Row ${index}` }));
  const shrunk = grown.slice(0, 6);
  assert.equal(structureChange(grown, shrunk), true);
  assert.equal(structureChange(grown, grown.slice(0, 7)), false);
  assert.equal(structureChange([{ id: "a", text: "A" }], [{ id: "a", text: "A" }], { columnsBefore: 1, columnsAfter: 2 }), true);
  assert.deepEqual(swapShouldDefer({ selecting: true, waitedMs: 100 }), { defer: true, viewportOnly: false });
  assert.deepEqual(swapShouldDefer({ scrolling: true, waitedMs: 2000 }), { defer: false, viewportOnly: true });
  assert.equal(scrollCompensation(10, 14), 4);
  const root = {
    nodes: [
      { dataset: { blockId: "a" }, textContent: "Same sentence.", style: {}, classList: new Set(), querySelector: () => null, getBoundingClientRect: () => ({ top: 20, bottom: 40, height: 20 }) },
      { dataset: { blockId: "b" }, textContent: "Old sentence.", style: {}, classList: new Set(), querySelector: () => null, getBoundingClientRect: () => ({ top: 40, bottom: 60, height: 20 }) }
    ],
    querySelectorAll() { return this.nodes; }
  };
  const applied = applyParagraphSwap(root, plan, { reducedMotion: true, anchor: root.nodes[0] });
  assert.equal(applied.kept, 1);
  assert.equal(root.nodes[0].textContent, "Same sentence.");
  assert.equal(root.nodes[1].textContent, "New sentence.");
});

test("status copy, marks, and contrast match the Loom spec", () => {
  assert.equal(mmPageStatusView({ phase: "rebuilding" }).text, MM_REBUILDING_COPY);
  assert.equal(mmPageStatusView({ phase: "rebuilding" }).text.includes("%"), false);
  assert.equal(mmPageStatusView({ phase: "fallback", reason: "timeout" }).text, MM_FALLBACK_COPY.timeout);
  assert.equal(mmPageStatusView({ phase: "fallback", reason: "coverage" }).text, "已改用文字层 · 识别不完整");
  assert.equal(mmPageStatusView({ phase: "fallback", reason: "parse" }).text, "已改用文字层 · 结果无法读取");
  assert.equal(mmPageStatusView({ phase: "fallback", reason: "not-configured", page: 1 }).text, "已改用文字层 · 未设置多模态");
  assert.equal(mmPageStatusView({ phase: "fallback", reason: "not-configured", page: 2 }), null);
  assert.equal(mmPageStatusView({ phase: "fallback", reason: "401", running: true }), null);
  assert.equal(mmPageStatusView({ phase: "fallback", reason: "401" }).text, MM_FAILED_COPY);
  assert.equal(mmPageStatusView({ phase: "fallback", reason: "401" }).retry, MM_RETRY_COPY);
  assert.equal(mmPageStatusView({ phase: "rebuilding", chip: true }), null);
  assert.equal(staleStatusVisible({ current: true, stale: true, inView: true }), false);
  assert.equal(staleStatusVisible({ current: true, stale: true, inView: false }), true);
  assert.equal(staleStatusVisible({ current: false, stale: true, inView: false }), false);
  const mark = markPresentation(["mm-only", "restored", "num-mismatch"], { nums: [{ text: "12", model: "13" }] });
  assert.equal(mark.data, "num");
  assert.equal(mark.aria, "本段数字识别不一致");
  assert.match(mark.tooltip, /^数字与原文识别不一致，已按 PDF 文字显示：12 \/ 模型：13/);
  assert.match(mark.tooltip, /本段有句子由 PDF 文字补回/);
  assert.equal(markFit(7), "dot");
  assert.equal(markFit(8), "bar");
  const contrast = markContrastOk();
  assert.equal(contrast.light.ok, true);
  assert.equal(contrast.white.ok, true);
  assert.equal(contrast.dark.ok, true);
  assert.ok(contrast.light.mm >= 3);
  assert.ok(contrast.white.mm >= 3);
  assert.ok(contrast.dark.mm >= 3);
  assert.match(viewer, /正在重建本页|mmPageStatusView/);
  assert.match(viewer, /function setPageLayout/);
  const setPage = viewer.slice(viewer.indexOf("function setPageLayout"), viewer.indexOf("function appendReadoutNode"));
  assert.equal(setPage.includes("planParagraphSwap"), false);
  assert.match(viewer, /planParagraphSwap/);
  assert.equal(css.includes("#9a3412"), false);
  assert.match(css, /--oi-reader-para-mark-w/);
  assert.match(tokens, /--oi-reader-para-mark-num:\s*var\(--oi-reader-warn\)/);
  assert.match(tokens, /--oi-reader-swap-ms:\s*150ms/);
  const event = redactDiagEvent({
    type: "mm.page.reconcile",
    page: 2,
    gapsIn: 4,
    gapsFilled: 3,
    text: "Attention is all you need",
    apiKey: "sk-secret-value"
  }, ["sk-secret-value"]);
  assert.equal(event.gapsIn, 4);
  assert.equal(event.text, undefined);
  assert.equal(JSON.stringify(event).includes("sk-secret-value"), false);
  assert.equal(JSON.stringify(event).includes("Attention"), false);
  assert.deepEqual(summarizeMmGapFill([event]), { gapsIn: 4, gapsFilled: 3, rate: 0.75 });
  noteMmPage("mm.page.start", { page: 1, text: "do not keep" });
});

test("page latex is a multimodal-tier candidate and does not require a second crop", () => {
  resetMmPages();
  notePageFormulaLatex(3, [{ id: "f", bbox: [0.2, 0.4, 0.8, 0.5], latex: "E=mc^2" }]);
  assert.equal(pageLatexForUnit({ bbox: [0.2, 0.4, 0.8, 0.5] }), "E=mc^2");
  assert.equal(pageLatexForUnit({ bbox: [0, 0, 0.05, 0.05] }), "");
  resetMmPages();
});
