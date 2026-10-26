import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BATCH_RETRY_ATTEMPTS,
  batchBackoffMs,
  batchCanRetry,
  createTranslateSession,
  docStatusView,
  failureChipModel,
  retranslateButtonLabel,
  runningPageHint,
  translatePageBlocks,
  translatedPageTotal,
  unfinishedDocCopy
} from "../lib/pdf-viewer.js";
import { libraryProgressCopy } from "../lib/library-copy.js";
import { countPageOutcomes, pageCountsAsTranslated } from "../lib/library-record.js";
import { createDiagWriter, installDiagWriter, notePageStateEvent, resetDiagForTests, DIAG_STORAGE_KEY } from "../lib/diag-log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");

test("RT-01 RT-02 RT-13 split button, menu copy, and reader tokens", () => {
  assert.match(html, /id="retranslateSplit"/);
  assert.match(html, /id="retranslatePage"[^>]*class="btn-secondary"[^>]*disabled>重译本页</);
  assert.match(html, /id="retranslateMenuButton"/);
  assert.match(html, /只替换当前页/);
  assert.match(html, /从第 1 页起重新翻译所有页/);
  assert.match(viewer, /\$\("retranslatePage"\)\.addEventListener\("click", \(\) => \{[\s\S]*forceRetranslateCurrentPage\(\)/);
  assert.match(viewer, /function openRetranslateFromKeys/);
  assert.match(viewer, /function onRetranslateMenuKey/);
  assert.match(css, /\.retranslate-caret\s*\{[^}]*width:\s*24px/);
  assert.match(css, /border-left:\s*1px solid var\(--oi-reader-border\)/);
  assert.match(css, /\.retranslate-item\s*\{[^}]*min-height:\s*32px/);
  assert.match(css, /\.retranslate-item-note\s*\{[^}]*font-size:\s*12px/);
  assert.match(css, /\.retranslate-item:hover\s*\{[^}]*background:\s*var\(--oi-reader-hover\)/);
  assert.match(css, /white-space:\s*nowrap/);
  assert.match(tokens, /--oi-reader-border:\s*var\(--oi-reader-line\)/);
  const split = css.slice(css.indexOf(".retranslate-split {"), css.indexOf(".rf-ps-still"));
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(split), false);
});

test("RT-03 RT-05 RT-06 retranslate starts without confirm and leaves an NEP call site", () => {
  const docForce = viewer.slice(
    viewer.indexOf("async function forceRetranslateDocument"),
    viewer.indexOf("async function forceRetranslateCurrentPage")
  );
  assert.match(docForce, /forceAll: true/);
  assert.equal(docForce.includes("confirm("), false);
  assert.match(viewer, /function showNepPrompt\(\) \{\s*showNoEngineBanner\(\);/);
  assert.match(viewer, /function openNepSettings\(\) \{\s*runtimeSend\(\{ type: "OI_OPEN_TRANSLATE_SETTINGS" \}\)/);
  assert.match(viewer, /if \(blocker === "NO_ENGINE"\) \{\s*showNepPrompt\(\);/);
  assert.equal(viewer.includes("options/options.html#nep"), false);
  assert.match(html, /id="retranslateStop"/);
  assert.match(html, /title="停止重译"/);
  assert.equal(retranslateButtonLabel({ busy: true, scope: "document", n: 2, t: 9 }), "重译中 2/9");
  assert.equal(retranslateButtonLabel({ busy: true, scope: "page" }), "重译中…");
  assert.equal(docStatusView({ n: 2, t: 9, phase: "running", retranslate: true }).text, "重译中 · 2/9");
});

test("RT-07 RT-08 RT-09 RT-10 RT-12 failure chip, running copy, and partial is not 全文已译", () => {
  assert.equal(runningPageHint(), "排队中");
  assert.equal(docStatusView({ n: 3, t: 8, needsRetry: 2, phase: "running" }).text, "翻译中 · 3/8");
  assert.equal(/失败/.test(docStatusView({ n: 3, t: 8, needsRetry: 2, phase: "running" }).text), false);
  const done = docStatusView({ n: 8, t: 8, needsRetry: 0, phase: "idle" });
  assert.equal(done.text, "全文已译");
  const failed = docStatusView({ n: 6, t: 8, needsRetry: 2, phase: "idle" });
  assert.equal(failed.text, unfinishedDocCopy(6, 8, 2));
  assert.equal(failed.warnCount, 2);
  assert.equal(failureChipModel({ state: "failed" }).text, "这页没译完");
  assert.equal(failureChipModel({ state: "failed" }).retry, "重试本页");
  assert.equal(failureChipModel({ state: "partial", unfinished: 3 }).text, "有 3 段没译完");
  assert.equal(failureChipModel({ state: "failed", pending: true }).text, "重试中…");
  assert.match(failureChipModel({ state: "partial", unfinished: 1, still: true }).still, /仍然失败/);
  assert.equal(failureChipModel({ state: "partial", unfinished: 1, still: true }).settings, "去设置");
  assert.match(viewer, /function jumpToFirstFailedPage/);
  assert.match(css, /\.doc-fail-jump\s*\{[^}]*color:\s*var\(--oi-reader-warn\)/);
  assert.match(css, /\.rf-retry\s*,[\s\S]*color:\s*var\(--oi-reader-link\)/);
  const totals = translatedPageTotal([{ state: "done" }, { state: "partial" }, { state: "failed" }]);
  assert.equal(totals.n, 1);
  assert.equal(totals.needsRetry, 2);
  assert.notEqual(docStatusView({ n: totals.n, t: 3, needsRetry: totals.needsRetry, phase: "idle" }).text, "全文已译");
});

test("RT-04 RT-11 old translation stays up and library uses the same complete set", () => {
  assert.match(css, /\.rf-page\[data-replacing="1"\] \.rf-zh\s*\{[^}]*opacity:\s*0\.6/);
  assert.match(viewer, /slot\.dataset\.replacing = "1"/);
  assert.equal(pageCountsAsTranslated({ runState: "partial", pairs: [{ translation: "甲" }] }), false);
  assert.equal(pageCountsAsTranslated({ runState: "failed", pairs: [{ translation: "甲" }] }), false);
  assert.equal(pageCountsAsTranslated({ runState: "done" }), true);
  assert.equal(pageCountsAsTranslated({ pairs: [{ translation: "甲" }] }), true);
  const outcomes = countPageOutcomes([
    { page: 1, runState: "done", pairs: [{ translation: "甲" }] },
    { page: 2, runState: "partial", pairs: [{ translation: "乙" }] },
    { page: 3, runState: "failed" }
  ]);
  assert.equal(outcomes.translated, 1);
  assert.equal(outcomes.incomplete, 2);
  assert.equal(libraryProgressCopy(1, 3, { incomplete: 2 }), "已译 1/3 · 有页没译完");
  assert.equal(libraryProgressCopy(3, 3), "全文已译");
  assert.equal(libraryProgressCopy(1, 3, { translating: true }), "翻译中 1/3");
  assert.equal(translatedPageTotal([{ state: "partial" }]).n, outcomes.translated - 1 + 0);
});

test("DIAG① retries 429 and 5xx with Retry-After, then stops", async () => {
  assert.equal(batchCanRetry(null, { httpStatus: 429, error: "HTTP 429" }), true);
  assert.equal(batchCanRetry(null, { error: "HTTP 503" }), true);
  assert.equal(batchCanRetry({ code: "timeout" }, null), true);
  assert.equal(batchCanRetry(null, { error: "HTTP 400", httpStatus: 400 }), false);
  assert.equal(batchBackoffMs(0, { retryAfterMs: 1500, random: () => 0 }), 1500);
  assert.equal(batchBackoffMs(0, { retryAfterMs: 120000, random: () => 0 }), 60000);
  const waits = [];
  let calls = 0;
  const session = createTranslateSession();
  const recovered = await translatePageBlocks([{ bid: "a", original: "Hello there." }], {
    session,
    batchSize: 8,
    page: 2,
    sleep: async (ms) => { waits.push(ms); },
    random: () => 0,
    send: async () => {
      calls += 1;
      if (calls < 3) return { ok: false, error: "HTTP 429", httpStatus: 429, retryAfterMs: 25 };
      return { ok: true, translations: [{ bid: "a", translation: "你好。" }] };
    }
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 25]);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.results[0].translation, "你好。");
  assert.equal(recovered.results[0].failed, undefined);

  let exhausted = 0;
  const failed = await translatePageBlocks([{ bid: "b", original: "Hello there." }], {
    session: createTranslateSession(),
    page: 3,
    sleep: async () => {},
    random: () => 0,
    send: async () => {
      exhausted += 1;
      return { ok: false, error: "HTTP 503", httpStatus: 503 };
    }
  });
  assert.equal(exhausted, BATCH_RETRY_ATTEMPTS);
  assert.equal(failed.ok, false);
  assert.equal(failed.results[0].failed, true);
});

test("DIAG⑤ page.state keeps layout-null reason, mode, and itemCount", async () => {
  resetDiagForTests();
  const bag = {};
  const storage = {
    async get(key) {
      return typeof key === "string" ? { [key]: bag[key] } : { ...bag };
    },
    async set(patch) { Object.assign(bag, patch); }
  };
  const writer = createDiagWriter({ storage, debounceMs: -1 });
  installDiagWriter(writer);
  notePageStateEvent({
    page: 4,
    state: "empty-layout",
    reason: "layout-null:aborted",
    mode: "local-ocr",
    itemCount: 0,
    text: "Attention is all you need",
    apiKey: "sk-test-placeholder"
  });
  await writer.flush();
  const event = bag[DIAG_STORAGE_KEY][0];
  assert.equal(event.type, "page.state");
  assert.equal(event.code, "empty-layout");
  assert.equal(event.reason, "layout-null:aborted");
  assert.equal(event.mode, "local-ocr");
  assert.equal(event.itemCount, 0);
  assert.equal(JSON.stringify(event).includes("Attention"), false);
  assert.equal(JSON.stringify(event).includes("sk-test-placeholder"), false);
  resetDiagForTests();
});
