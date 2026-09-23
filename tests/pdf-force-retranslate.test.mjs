import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_COPY,
  blocksForForceRetranslate,
  forceRetranslateOutcome,
  pdfToolbarActionState
} from "../lib/pdf-viewer.js";
import { replaceLibraryPagePairs, selectSavedTranslation } from "../lib/pdf-library.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");

test("重译本页 status copy matches the Loom lock", () => {
  assert.equal(PDF_COPY.retranslateRunning, "正在重译本页译文…");
  assert.equal(PDF_COPY.retranslateDone, "本页译文已更新");
  assert.equal(PDF_COPY.retranslateFailed, "本页重译失败，仍显示原译文");
});

test("重译本页 is a Soft Graphite secondary button beside 翻译", () => {
  const translate = html.indexOf('id="translatePage"');
  const again = html.indexOf('id="retranslatePage"');
  const stop = html.indexOf('id="stopTranslate"');
  assert.ok(translate > 0 && translate < again && again < stop);
  assert.match(html, /id="retranslatePage"[^>]*class="btn-secondary"[^>]*disabled>重译本页</);
  assert.equal(html.includes('id="retranslatePage" class="btn-primary"'), false);
  const rule = css.slice(css.indexOf("#retranslatePage.btn-secondary {"), css.indexOf(".btn-ghost {"));
  assert.match(rule, /background:\s*transparent/);
  assert.match(rule, /border:\s*1px solid var\(--oi-line\)/);
  assert.match(rule, /color:\s*var\(--oi-text-muted\)/);
  assert.match(rule, /background:\s*var\(--oi-accent-subtle\)/);
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(rule), false);
});

test("force retranslate includes uncertain and already translated blocks, not bibliography", () => {
  const blocks = [
    {
      id: "a",
      label: "text",
      text: "Attention is all you need.",
      translation: "旧译文",
      translationStatus: "source-uncertain"
    },
    { id: "b", label: "text", text: "The encoder is composed of a stack.", translation: "编码器由堆栈组成。" },
    { id: "c", label: "text", text: "[16] Kaiser and Bengio.", skipTranslate: true },
    { id: "d", label: "formula", text: "E = mc^2" }
  ];
  assert.deepEqual(blocksForForceRetranslate(blocks).map((block) => block.id), ["a", "b"]);
});

test("force outcome commits only a complete page and never a cut translation", () => {
  assert.equal(forceRetranslateOutcome({ aborted: true, results: [{ translation: "甲" }] }), "aborted");
  assert.equal(
    forceRetranslateOutcome({ results: [{ translation: "甲" }, { translation: "乙" }] }),
    "success"
  );
  assert.equal(
    forceRetranslateOutcome({ results: [{ translation: "甲" }, { translation: "" }] }),
    "failed"
  );
  assert.equal(forceRetranslateOutcome({ results: [] }), "failed");
  assert.equal(forceRetranslateOutcome({ results: [], structureLanded: true }), "success");
});

test("successful retranslate overwrites that page's pairs only", () => {
  const doc = {
    pages: [
      { page: 8, pairs: [{ sourceId: "p8", text: "Attention", translation: "旧" }], migrated: true, skipped: true },
      { page: 9, pairs: [{ text: "Other", translation: "其他" }] }
    ]
  };
  const pairs = [{ sourceId: "p8", text: "Attention", translation: "注意力" }];
  assert.equal(replaceLibraryPagePairs(doc, 8, pairs), true);
  assert.equal(doc.pages[0].pairs[0].translation, "注意力");
  assert.equal("migrated" in doc.pages[0], false);
  assert.equal("skipped" in doc.pages[0], false);
  assert.equal(doc.pages[1].pairs[0].translation, "其他");
  assert.equal(replaceLibraryPagePairs(doc, 3, [{ text: "New", translation: "新" }]), true);
  assert.equal(selectSavedTranslation(doc, 3).pairs[0].translation, "新");
  assert.equal(selectSavedTranslation(doc, 8).pairs[0].translation, "注意力");
  const readout = { readout: "legacy", pages: [] };
  assert.equal(replaceLibraryPagePairs(readout, 1, pairs), false);
  assert.equal(readout.pages.length, 0);
  assert.equal(replaceLibraryPagePairs(null, 1, pairs), false);
});

test("重译本页 bypasses library early-returns; 翻译 still short-circuits", () => {
  const current = viewer.slice(
    viewer.indexOf("async function translateCurrentPage"),
    viewer.indexOf("async function translateWholeDocument")
  );
  assert.match(current, /saved\?\.pairs\?\.length/);
  assert.match(current, /savedTranslationFor\(/);
  assert.equal(current.includes("retranslateRunning"), false);
  assert.equal(current.includes("forceRetranslateCurrentPage"), false);

  const forceStart = viewer.indexOf("function unitsForForceRetranslate");
  const force = viewer.slice(forceStart, viewer.indexOf("\nfunction withStructureRows", forceStart));
  assert.equal(force.includes("savedTranslationFor"), false);
  assert.equal(force.includes("saved?.pairs"), false);
  assert.equal(force.includes("libraryDoc?.pages"), false);
  assert.match(force, /isSkipOnlyPage\(/);
  assert.match(force, /blocksForForceRetranslate\(/);
  assert.match(force, /async function forceRetranslateCurrentPage/);
  assert.match(force, /ensureTitleStructure\(targetPage, sourceLayout, \{ force: true \}\)/);
  const refresh = force.indexOf("ensureTitleStructure(targetPage, sourceLayout, { force: true })");
  const reread = force.indexOf("liveOriginals", refresh);
  const blocksCall = force.indexOf("translatePageBlocks", refresh);
  assert.ok(refresh > 0 && reread > refresh && blocksCall > reread);
  assert.match(viewer, /options\.force/);
  assert.match(viewer, /structureAuthorsLookTruncated/);
  assert.match(force, /PDF_COPY\.retranslateRunning/);
  assert.match(force, /PDF_COPY\.retranslateDone/);
  assert.match(force, /PDF_COPY\.retranslateFailed/);
  assert.match(force, /restoreForceReadout\(/);
  const remember = force.indexOf("rememberTranslation(");
  const replace = force.indexOf("replaceLibraryPagePairs(");
  const done = force.indexOf("PDF_COPY.retranslateDone");
  assert.ok(remember > 0 && replace > remember && done > replace);
  assert.match(viewer, /\$\("retranslatePage"\)\.addEventListener\("click", \(\) => forceRetranslateCurrentPage\(\)\)/);
  assert.match(viewer, /\$\("translatePage"\)\.addEventListener\("click", \(\) => startTranslate\(\)\)/);
  assert.match(viewer, /canRetranslate: pageOriginals\.length > 0/);
  assert.match(viewer, /\$\("retranslatePage"\)\.disabled = ui\.retranslateDisabled/);
  assert.match(viewer, /if \(forceReadoutHold\) return;/);
});

test("重译本页 stays disabled while busy and on a page with nothing to translate", () => {
  const busy = pdfToolbarActionState({ busy: true, hasDoc: true, canTranslate: true, canRetranslate: true });
  assert.equal(busy.retranslateDisabled, true);
  assert.equal(busy.translateHidden, true);
  const wholeDocScope = pdfToolbarActionState({ busy: false, hasDoc: true, canTranslate: true, canRetranslate: false });
  assert.equal(wholeDocScope.translateDisabled, false);
  assert.equal(wholeDocScope.retranslateDisabled, true);
  const ready = pdfToolbarActionState({ busy: false, hasDoc: true, canTranslate: true, canRetranslate: true });
  assert.equal(ready.translateDisabled, false);
  assert.equal(ready.retranslateDisabled, false);
});
