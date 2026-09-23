import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIBRARY_HOLD_PENDING,
  LIBRARY_HOLD_READY,
  PAGE_STATUS_BIBLIOGRAPHY,
  PAGE_STATUS_PENDING_REVIEW,
  PAGE_STATUS_UNSAVED,
  applySavedPairs,
  blockSoftLead,
  isSkipOnlyPage,
  libraryHoldCopy,
  pageSoftStatus,
  selectSavedTranslation
} from "../lib/pdf-library.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");

const refBlocks = [
  { id: "r1", sourceId: "p11-a", label: "text", text: "[16] Kaiser and Bengio.", skipTranslate: true },
  { id: "r2", sourceId: "p11-b", label: "text", text: "[17] Kaiser and Sutskever.", skipTranslate: true }
];

const matrixBlocks = [
  {
    id: "m",
    sourceId: "p5-s95wn2f",
    label: "text",
    text: "Where the projections are parameter matrices"
  }
];

test("a library hole with empty pairs is not pending-review on a skip-only page", () => {
  const saved = { page: 11, pairs: [], migrated: true };
  const status = pageSoftStatus({ saved, restored: [], blocks: refBlocks });
  assert.equal(isSkipOnlyPage(refBlocks), true);
  assert.equal(status.kind, "bibliography");
  assert.equal(status.copy, PAGE_STATUS_BIBLIOGRAPHY);
  assert.equal(status.copy, "本页为参考文献，保留原文（不自动翻译）。");
  assert.equal(status.copy.includes("待核对"), false);
  const blind = pageSoftStatus({ saved });
  assert.notEqual(blind.kind, "pending-review");
  assert.equal(blind.copy, PAGE_STATUS_UNSAVED);
  assert.equal(blind.copy.includes("待核对"), false);
});

test("skipTranslate and historical reference pairs are not pending-review", () => {
  const saved = {
    page: 12,
    pairs: [
      { sourceId: "p11-a", text: "[16] Kaiser and Bengio.", translation: "", status: "source-uncertain" },
      { sourceId: "p11-b", text: "[17] Kaiser and Sutskever.", translation: "", status: "pending" }
    ]
  };
  const restored = applySavedPairs([
    { id: "r1", sourceId: "p11-a", text: "[16] Kaiser and Bengio.", sourceText: "[16] Kaiser and Bengio. old", skipTranslate: true }
  ], [{
    sourceId: "p11-a",
    text: "[16] Kaiser and Bengio.",
    sourceText: "[16] Kaiser and Bengio.",
    translation: "旧译文",
    status: "source-uncertain"
  }]);
  assert.equal(restored[0].translationStatus, "skipped");
  assert.equal(restored[0].translation, "");
  const status = pageSoftStatus({ saved, restored, blocks: refBlocks });
  assert.equal(status.kind, "bibliography");
  assert.equal(status.copy.includes("有待核对的段落"), false);
  assert.equal(blockSoftLead({ ...refBlocks[0], translationStatus: "source-uncertain" }), "");
  assert.equal(libraryHoldCopy([saved], { 12: refBlocks }).includes("待核对"), false);
  assert.equal(libraryHoldCopy([saved]), LIBRARY_HOLD_READY);
});

test("source-uncertain on a translatable block stays pending-review", () => {
  const saved = {
    page: 5,
    pairs: [{
      sourceId: "p5-s95wn2f",
      text: "Where the projections are parameter matrices",
      translation: "",
      status: "source-uncertain"
    }]
  };
  const restored = applySavedPairs(matrixBlocks, saved.pairs);
  assert.equal(restored[0].translationStatus, "source-uncertain");
  const status = pageSoftStatus({ saved, restored, blocks: matrixBlocks });
  assert.equal(status.kind, "pending-review");
  assert.equal(status.copy, PAGE_STATUS_PENDING_REVIEW);
  assert.match(status.copy, /有待核对的段落/);
  assert.match(blockSoftLead(restored[0]), /旧译文未沿用/);
  assert.equal(libraryHoldCopy([saved]), LIBRARY_HOLD_PENDING);
  assert.match(libraryHoldCopy([saved]), /待核对段落不会自动重新翻译/);
});

test("a citation integrity failure on a translatable block stays pending-review", () => {
  const blocks = [{ id: "b", sourceId: "p2-a", label: "text", text: "See [13] and [7]." }];
  const saved = {
    page: 2,
    pairs: [{ sourceId: "p2-a", text: "See [13] and [7].", translation: "见 [13]。", status: "verified" }]
  };
  assert.equal(pageSoftStatus({ saved, blocks }).kind, "pending-review");
});

test("mixed bibliography does not hide a verified body or a real uncertain block", () => {
  const blocks = [
    { id: "c", sourceId: "p10-c", label: "text", text: "In this work, we presented" },
    ...refBlocks
  ];
  const verified = {
    page: 10,
    pairs: [
      { sourceId: "p10-c", text: "In this work, we presented", translation: "在这项工作中，我们提出", status: "verified" },
      { sourceId: "p11-a", text: "[16] Kaiser and Bengio.", translation: "", status: "source-uncertain" }
    ]
  };
  assert.equal(pageSoftStatus({ saved: verified, blocks }).kind, "done");
  const uncertainBody = {
    page: 10,
    pairs: [
      { sourceId: "p10-c", text: "In this work, we presented", translation: "", status: "source-uncertain" },
      { sourceId: "p11-a", text: "[16] Kaiser and Bengio.", translation: "", status: "pending" }
    ]
  };
  assert.equal(pageSoftStatus({ saved: uncertainBody, blocks }).kind, "pending-review");
});

test("skip-only holes are not synthesized as bare migrated", () => {
  const doc = { readout: "legacy", pages: [{ page: 1, pairs: [{ text: "Abstract", translation: "摘要" }] }] };
  assert.deepEqual(selectSavedTranslation(doc, 11), { page: 11, pairs: [], migrated: true });
  assert.deepEqual(selectSavedTranslation(doc, 12, refBlocks), { page: 12, pairs: [], skipped: true });
  assert.equal(pageSoftStatus({ saved: selectSavedTranslation(doc, 12, refBlocks), blocks: refBlocks }).copy, PAGE_STATUS_BIBLIOGRAPHY);
});

test("viewer soft status no longer treats a bare migrated hole as pending-review", () => {
  const start = viewer.indexOf("function savedPageStatus");
  const fn = viewer.slice(start, viewer.indexOf("const STRUCTURE_TIMEOUT_MS", start));
  assert.match(fn, /pageSoftStatus\(/);
  assert.equal(fn.includes("saved?.migrated"), false);
  assert.equal(viewer.includes("待核对段落不会自动重新翻译"), false);
  assert.match(viewer, /libraryHoldCopy\(/);
  assert.match(viewer, /rememberSkipHole\(/);
  assert.match(viewer, /isSkipOnlyPage\(/);
  const whole = viewer.slice(viewer.indexOf("async function translateWholeDocument"));
  const current = viewer.slice(
    viewer.indexOf("async function translateCurrentPage"),
    viewer.indexOf("async function translateWholeDocument")
  );
  for (const fnSrc of [whole, current]) {
    const probe = fnSrc.slice(fnSrc.indexOf("} catch {"), fnSrc.indexOf("} catch {") + 80);
    assert.match(probe, /noteLibraryUnavailable\(\)/);
    assert.equal(probe.includes("return"), false);
  }
});
