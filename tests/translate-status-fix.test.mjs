import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  batchWritebackMismatch,
  layoutMissReasonFor,
  normalizePageSkipReason,
  pageNoText,
  retranslateStatusCopy,
  settleUnsentPage,
  translateDocumentPages,
  translateExceptionCode,
  translatedPageTotal,
  createTranslateSession
} from "../lib/pdf-viewer.js";
import {
  DIAG_STORAGE_KEY,
  createDiagWriter,
  diagStateForPage,
  installDiagWriter,
  notePageStateEvent,
  noteTranslateException,
  noteUserAction,
  resetDiagForTests
} from "../lib/diag-log.js";
import { redactDiagEvent } from "../lib/diag-redact.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const PLACEHOLDER_KEY = "sk-test-placeholder";

function memoryArea() {
  const bag = {};
  return {
    bag,
    async get(key) {
      if (typeof key === "string") return { [key]: bag[key] };
      return { ...bag };
    },
    async set(patch) {
      Object.assign(bag, patch);
    }
  };
}

test("null layout is queued or failed and is not counted as translated", () => {
  for (const reason of ["stopped", "stale", "aborted", "engine"]) {
    const settled = settleUnsentPage({ layout: null, reason });
    assert.equal(settled.state, "queued", reason);
    assert.equal(settled.noText, false, reason);
    assert.equal(settled.diagState, "empty-layout", reason);
    assert.equal(translatedPageTotal([{ state: settled.state }]).n, 0, reason);
  }
  for (const reason of ["offline", "empty-layout"]) {
    const settled = settleUnsentPage({ layout: null, reason });
    assert.equal(settled.state, "failed", reason);
    assert.equal(settled.noText, false, reason);
    assert.equal(translatedPageTotal([{ state: settled.state }]).n, 0, reason);
    assert.equal(translatedPageTotal([{ state: settled.state }]).needsRetry, reason === "offline" || reason === "empty-layout" ? 1 : 0);
  }
  assert.equal(layoutMissReasonFor({ stopped: true, aborted: true }), "aborted");
  assert.equal(layoutMissReasonFor({ engineChanged: true }), "stale");
  assert.equal(layoutMissReasonFor({ stale: true }), "stale");
  assert.equal(layoutMissReasonFor({ aborted: true }), "aborted");
  assert.equal(layoutMissReasonFor({ offline: true }), "epoch");
  assert.equal(layoutMissReasonFor({}), "empty");
  assert.equal(settleUnsentPage({ layout: null, reason: "stopped" }).diagReason, "layout-null:stopped");
});

test("noText is true only when a text layer was read and itemCount is 0", () => {
  assert.equal(pageNoText(null), false);
  assert.equal(pageNoText({ blocks: [] }), false);
  assert.equal(pageNoText({ itemCount: undefined, blocks: [] }), false);
  assert.equal(pageNoText({ itemCount: 3, blocks: [] }), false);
  assert.equal(pageNoText({ itemCount: 0, blocks: [] }), true);

  const scanned = settleUnsentPage({ layout: { itemCount: 0, blocks: [] } });
  assert.equal(scanned.state, "empty");
  assert.equal(scanned.noText, true);
  assert.equal(scanned.diagReason, "no-blocks");
  assert.equal(translatedPageTotal([{ state: scanned.state }]).n, 1);

  const prose = settleUnsentPage({ layout: { itemCount: 4, blocks: [] } });
  assert.equal(prose.state, "empty");
  assert.equal(prose.noText, false);
  assert.equal(prose.diagState, "translated");
  assert.equal(diagStateForPage("empty", { noText: false }), "translated");
  assert.equal(diagStateForPage("empty", { noText: true }), "empty-layout");
  assert.equal(diagStateForPage("running"), "translating");
  assert.equal(diagStateForPage("done"), "translated");
});

test("unavailable skip is not collapsed into an empty translated page", async () => {
  assert.equal(normalizePageSkipReason("unavailable"), "unavailable");
  assert.equal(normalizePageSkipReason("skip-only"), "skip-only");
  assert.equal(normalizePageSkipReason("cached"), "cached");
  assert.equal(normalizePageSkipReason("empty"), "empty");
  assert.equal(normalizePageSkipReason("other"), "empty");
  const skips = [];
  let sent = 0;
  await translateDocumentPages({
    numPages: 1,
    docId: 1,
    session: createTranslateSession(),
    getPageOriginals: async () => [],
    pageSkipReason: () => "unavailable",
    send: async () => {
      sent += 1;
      return { ok: true, translations: [] };
    },
    onPageSkip: (info) => skips.push(info)
  });
  assert.deepEqual(skips, [{ page: 1, reason: "unavailable" }]);
  assert.equal(sent, 0);
});

test("retranslate menu has page and document actions and document starts without confirm", () => {
  assert.match(html, /id="retranslateMenu"/);
  assert.match(html, /id="retranslatePageItem"[\s\S]*重译本页/);
  assert.match(html, /id="retranslateDocument"[\s\S]*重译全文/);
  assert.match(html, /只替换当前页/);
  assert.match(html, /从第 1 页起重新翻译所有页/);
  assert.match(html, /id="translateMenuRetranslateDoc"[^>]*>重译全文</);
  assert.match(html, /id="retranslatePage"[^>]*class="btn-secondary"[^>]*disabled>重译本页</);
  const docForce = viewer.slice(
    viewer.indexOf("async function forceRetranslateDocument"),
    viewer.indexOf("async function forceRetranslateCurrentPage")
  );
  assert.match(docForce, /forceAll: true/);
  assert.equal(docForce.includes("confirm("), false);
  assert.equal(docForce.includes("askConfirm"), false);
  assert.equal(retranslateStatusCopy({ scope: "document", phase: "running", n: 1, t: 4 }), "重译中 · 1/4");
  assert.equal(retranslateStatusCopy({ scope: "document", phase: "done" }), "全文已译");
  assert.equal(retranslateStatusCopy({ scope: "document", phase: "failed", n: 2, t: 4, failed: 1 }), "已译 2/4 页 · 1 页没译完");
  assert.equal(retranslateStatusCopy({ scope: "page", phase: "failed" }), "本页重译失败，仍显示原译文");
  const skip = viewer.slice(viewer.indexOf("pageSkipReason:"), viewer.indexOf("onPageSkip"));
  assert.match(skip, /unavailable/);
  assert.match(viewer, /settleUnsentPage\(/);
  assert.match(viewer, /pageNoText\(/);
  assert.match(viewer, /layout-null:empty/);
  assert.equal(viewer.includes("!blocks.length && !(Number(layout?.itemCount) > 0)"), false);
});

test("diagnostic events keep state, action, and exception codes, not text or keys", async () => {
  resetDiagForTests();
  const storage = memoryArea();
  const writer = createDiagWriter({ storage, debounceMs: -1 });
  installDiagWriter(writer);
  notePageStateEvent({
    page: 2,
    state: "empty-layout",
    reason: "stale",
    text: "Attention is all you need",
    translation: "注意力就是你所需要的一切",
    apiKey: PLACEHOLDER_KEY
  });
  noteUserAction("translate-page", { page: 2, text: "原文", apiKey: PLACEHOLDER_KEY });
  noteUserAction("retranslate-page", { page: 2 });
  noteUserAction("retranslate-doc", { page: 1 });
  noteUserAction("stop");
  noteUserAction("switch-engine", { provider: "openai", apiKey: PLACEHOLDER_KEY });
  noteTranslateException("401", { page: 2, reason: "http", text: "原文", translation: "译文" });
  noteTranslateException("timeout", { page: 3 });
  noteTranslateException("empty-layout", { page: 4, reason: "aborted" });
  noteTranslateException("writeback-mismatch", { page: 5, count: 2 });
  noteTranslateException(PLACEHOLDER_KEY, { page: 6 });
  await writer.flush();
  const events = storage.bag[DIAG_STORAGE_KEY];
  const blob = JSON.stringify(events);
  assert.equal(blob.includes("Attention"), false);
  assert.equal(blob.includes("注意力"), false);
  assert.equal(blob.includes("原文"), false);
  assert.equal(blob.includes("译文"), false);
  assert.equal(blob.includes(PLACEHOLDER_KEY), false);
  assert.equal(blob.includes("apiKey"), false);
  const codes = events.map((event) => `${event.type}:${event.code}`);
  assert.ok(codes.includes("page.state:empty-layout"));
  assert.ok(codes.includes("user.action:translate-page"));
  assert.ok(codes.includes("user.action:retranslate-page"));
  assert.ok(codes.includes("user.action:retranslate-doc"));
  assert.ok(codes.includes("user.action:stop"));
  assert.ok(codes.includes("user.action:switch-engine"));
  assert.ok(codes.includes("translate.exception:401"));
  assert.ok(codes.includes("translate.exception:timeout"));
  assert.ok(codes.includes("translate.exception:empty-layout"));
  assert.ok(codes.includes("translate.exception:writeback-mismatch"));
  const scrubbed = redactDiagEvent({
    type: "translate.exception",
    code: "401",
    msg: `bearer ${PLACEHOLDER_KEY}`,
    text: "paper body",
    translation: "译文",
    apiKey: PLACEHOLDER_KEY
  }, [PLACEHOLDER_KEY]);
  assert.equal(JSON.stringify(scrubbed).includes(PLACEHOLDER_KEY), false);
  assert.equal(scrubbed.text, undefined);
  assert.equal(scrubbed.translation, undefined);
  assert.equal(scrubbed.apiKey, undefined);
  resetDiagForTests();
});

test("request failures, timeouts, and writeback mismatches become exception codes", () => {
  assert.equal(translateExceptionCode({ httpStatus: 429 }), "429");
  assert.equal(translateExceptionCode(null, { error: "500" }), "500");
  assert.equal(translateExceptionCode({ code: "timeout" }), "timeout");
  assert.equal(translateExceptionCode({ name: "TimeoutError", message: "structure timeout" }), "timeout");
  assert.equal(translateExceptionCode({ message: "Attention is all you need" }), "error");
  assert.equal(batchWritebackMismatch({ ok: true, translations: [{ bid: "a", translation: "甲" }] }, [{ bid: "a" }, { bid: "b" }]), true);
  assert.equal(batchWritebackMismatch({ ok: true, translations: ["甲", "乙"] }, [{ bid: "" }, { bid: "" }]), false);
  assert.equal(batchWritebackMismatch({ ok: false, error: "500", translations: [] }, [{ bid: "a" }]), false);
  const fn = viewer.slice(viewer.indexOf("function rasterRegionInk"), viewer.indexOf("function redrawKeepsInk"));
  assert.match(fn, /getContext\("2d", \{ willReadFrequently: true \}\)/);
  assert.equal(viewer.includes(PLACEHOLDER_KEY), false);
  assert.equal(readFileSync(join(root, "lib/pdf-viewer.js"), "utf8").includes(PLACEHOLDER_KEY), false);
});
