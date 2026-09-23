import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blockRenderPieces,
  blockTranslationIntegrity,
  isTranslatableBlock
} from "../lib/pdf-blocks.js";
import {
  LIBRARY_HOLD_PENDING,
  LIBRARY_HOLD_READY,
  PAGE_STATUS_BIBLIOGRAPHY,
  PAGE_STATUS_PENDING_REVIEW,
  PAGE_STATUS_UNSAVED,
  applySavedPairs,
  blockSoftLead,
  composeMatrixProjectionTranslation,
  isSkipOnlyPage,
  libraryHoldCopy,
  pageSoftStatus,
  repairMatrixProjectionPairs,
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
  assert.equal(restored[0].translation, "");
  const status = pageSoftStatus({ saved, restored, blocks: matrixBlocks });
  assert.equal(status.kind, "pending-review");
  assert.equal(status.copy, PAGE_STATUS_PENDING_REVIEW);
  assert.match(status.copy, /有待核对的段落/);
  assert.match(blockSoftLead(restored[0]), /旧译文未沿用/);
  assert.equal(libraryHoldCopy([saved]), LIBRARY_HOLD_PENDING);
  assert.match(libraryHoldCopy([saved]), /待核对段落不会自动重新翻译/);
  assert.equal(libraryHoldCopy([saved], { 5: matrixBlocks }), LIBRARY_HOLD_PENDING);
});

test("a trusted page-5 matrix sentence leaves source-uncertain and stores placeholder Chinese", () => {
  const text = "Where the projections are parameter matrices ⟦f1⟧ and ⟦f2⟧.";
  const blocks = [{
    id: "m",
    sourceId: "p5-new",
    label: "text",
    text,
    sourceText: "Where the projections are parameter matrices W_i^Q and W^O."
  }];
  const other = {
    id: "o",
    sourceId: "p5-other",
    label: "text",
    text: "In this work, we presented",
    sourceText: "In this work, we presented"
  };
  const saved = {
    page: 5,
    pairs: [
      {
        sourceId: "p5-s95wn2f",
        text: "Where the projections are parameter matrices",
        sourceText: "Where the projections are parameter matrices W_iQ Rdmodel",
        translation: "",
        status: "source-uncertain"
      },
      {
        sourceId: "p5-other",
        text: "In this work, we presented",
        sourceText: "In this work, we presented",
        translation: "",
        status: "source-uncertain"
      }
    ]
  };
  assert.equal(composeMatrixProjectionTranslation(text), "其中这些投影是参数矩阵 ⟦f1⟧ 和 ⟦f2⟧。");
  assert.equal(composeMatrixProjectionTranslation("Where the projections are parameter matrices"), "");
  assert.equal(libraryHoldCopy([{ page: 5, pairs: saved.pairs.slice(0, 1) }], { 5: blocks }), LIBRARY_HOLD_READY);
  assert.equal(saved.pairs[0].status, "source-uncertain");
  const restored = applySavedPairs(blocks, saved.pairs);
  assert.equal(restored[0].translationStatus, "supplemented");
  assert.equal(restored[0].translation, "其中这些投影是参数矩阵 ⟦f1⟧ 和 ⟦f2⟧。");
  assert.equal(blockTranslationIntegrity(restored[0]).valid, true);
  assert.equal(blockSoftLead(restored[0]), "");
  assert.equal(saved.pairs[0].status, "supplemented");
  assert.equal(saved.pairs[0].sourceId, "p5-new");
  assert.equal(saved.pairs[1].status, "source-uncertain");
  assert.equal(saved.pairs.some((pair) => pair.sourceId === "p5-s95wn2f"), false);
  const status = pageSoftStatus({ saved, restored, blocks: [...blocks, other] });
  assert.equal(status.kind, "pending-review");
  const onlyMatrix = {
    page: 5,
    pairs: saved.pairs.filter((pair) => pair.sourceId === "p5-new")
  };
  assert.equal(pageSoftStatus({
    saved: onlyMatrix,
    restored,
    blocks
  }).kind, "done");
  assert.equal(pageSoftStatus({
    saved: {
      page: 5,
      pairs: [{ sourceId: "p5-new", text, translation: "", status: "source-uncertain" }]
    },
    restored,
    blocks
  }).kind, "done");
  const formulas = [
    { id: "f1", label: "formula", imageUrl: "data:image/png;base64,aa" },
    { id: "f2", label: "formula", imageUrl: "data:image/png;base64,bb" }
  ];
  const host = {
    ...restored[0],
    placeholders: [
      { token: "⟦f1⟧", blockId: "f1" },
      { token: "⟦f2⟧", blockId: "f2" }
    ]
  };
  const pieces = blockRenderPieces(host, [host, ...formulas]);
  assert.deepEqual(pieces.map((piece) => piece.type), ["text", "image", "text", "image", "text"]);
  assert.equal(pieces[1].blockId, "f1");
  assert.equal(pieces[3].blockId, "f2");
  assert.doesNotMatch(pieces.map((piece) => piece.text || "").join(""), /W_iQ|Rdmodel/);
  assert.equal(isTranslatableBlock(blocks[0]), true);
  assert.equal(isTranslatableBlock(other), true);
  const pending = [{
    sourceId: "p5-new",
    text: "Where the projections are parameter matrices",
    translation: "",
    status: "pending"
  }];
  const fromPending = applySavedPairs(blocks, pending);
  assert.equal(fromPending[0].translationStatus, "supplemented");
  assert.match(fromPending[0].translation, /⟦f1⟧ 和 ⟦f2⟧/);
  const again = repairMatrixProjectionPairs(pending, blocks);
  assert.equal(again.changed, false);
  const withOther = applySavedPairs([other, blocks[0]], [
    { sourceId: "p5-other", text: other.text, sourceText: other.sourceText, translation: "", status: "source-uncertain" },
    { sourceId: "p5-s95wn2f", text: "Where the projections are parameter matrices", translation: "", status: "pending" }
  ]);
  assert.equal(withOther[0].translationStatus, "source-uncertain");
  assert.equal(withOther[0].translation, "");
  assert.equal(withOther[1].translationStatus, "supplemented");
});

test("a matrix translation that drops placeholders is not stored as reviewed", () => {
  const text = "Where the projections are parameter matrices ⟦f1⟧ and ⟦f2⟧.";
  const blocks = [{
    id: "m",
    sourceId: "p5-s95wn2f",
    label: "text",
    text,
    sourceText: "Where the projections are parameter matrices W and W."
  }];
  const bad = {
    ...blocks[0],
    translation: "其中这些投影是参数矩阵。",
    translationStatus: "verified",
    placeholders: [
      { token: "⟦f1⟧", blockId: "f1" },
      { token: "⟦f2⟧", blockId: "f2" }
    ]
  };
  assert.equal(blockTranslationIntegrity(bad).reason, "formula-placeholder-mismatch");
  assert.match(blockSoftLead(bad), /公式或引用与原文不符/);
  const fallen = blockRenderPieces(bad, [
    bad,
    { id: "f1", label: "formula" },
    { id: "f2", label: "formula" }
  ]);
  assert.equal(fallen.filter((piece) => piece.type === "image").length, 2);
  assert.match(fallen[0].text, /^Where the projections/);
  assert.doesNotMatch(fallen.map((piece) => piece.text || "").join(""), /其中这些投影是参数矩阵。/);
  const pairs = [{
    sourceId: "p5-s95wn2f",
    text,
    sourceText: blocks[0].sourceText,
    translation: "其中这些投影是参数矩阵。",
    status: "verified"
  }];
  const restored = applySavedPairs(blocks, pairs);
  assert.equal(restored[0].translationStatus, "supplemented");
  assert.equal(restored[0].translation, "其中这些投影是参数矩阵 ⟦f1⟧ 和 ⟦f2⟧。");
  assert.notEqual(pairs[0].status, "verified");
  assert.equal(blockTranslationIntegrity(restored[0]).valid, true);
});

test("bibliography skipTranslate stays skipped beside the matrix sentence", () => {
  const text = "Where the projections are parameter matrices ⟦f1⟧ and ⟦f2⟧.";
  const units = [
    ...refBlocks,
    {
      id: "m",
      sourceId: "p5-new",
      label: "text",
      text,
      sourceText: "Where the projections are parameter matrices W and W."
    }
  ];
  const pairs = [
    { sourceId: "p11-a", text: "[16] Kaiser and Bengio.", translation: "不应入库的中文", status: "source-uncertain" },
    { sourceId: "p11-b", text: "[17] Kaiser and Sutskever.", translation: "", status: "pending" },
    { sourceId: "p5-s95wn2f", text: "Where the projections are parameter matrices", translation: "", status: "source-uncertain" }
  ];
  const restored = applySavedPairs(units, pairs);
  assert.equal(restored[0].translationStatus, "skipped");
  assert.equal(restored[0].translation, "");
  assert.equal(restored[1].translationStatus, "skipped");
  assert.equal(restored[2].translationStatus, "supplemented");
  assert.match(restored[2].translation, /⟦f1⟧/);
  assert.equal(pairs.find((pair) => pair.sourceId === "p11-a").status, "source-uncertain");
  assert.equal(pairs.find((pair) => pair.sourceId === "p11-a").translation, "不应入库的中文");
  const status = pageSoftStatus({ saved: { page: 12, pairs }, restored, blocks: units });
  assert.equal(status.kind, "done");
  assert.equal(blockSoftLead({ ...refBlocks[0], translationStatus: "source-uncertain" }), "");
  const migration = readFileSync(join(root, "scripts/migrate-attention-library.mjs"), "utf8");
  assert.match(migration, /Where the projections are parameter matrices/);
  assert.match(migration, /composeMatrixProjectionTranslation/);
  assert.equal(migration.includes("uncertainSourcePrefixes.set"), false);
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
  assert.equal((viewer.match(/bindSavedPairs\(/g) || []).length, 4);
  const currentFn = viewer.slice(
    viewer.indexOf("async function translateCurrentPage"),
    viewer.indexOf("async function translateWholeDocument")
  );
  assert.match(currentFn, /bindSavedPairs\(/);
  const loadFn = viewer.slice(
    viewer.indexOf("async function loadCurrentPageText"),
    viewer.indexOf("function updatePager")
  );
  assert.equal((loadFn.match(/bindSavedPairs\(/g) || []).length, 2);
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
