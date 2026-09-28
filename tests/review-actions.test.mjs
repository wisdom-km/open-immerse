import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyEquationNumber,
  applyMerge,
  applySplit,
  confirmBlocked,
  formatQueueStatus,
  importRejection,
  inspectorModel,
  isRenderingCancelled,
  missingPdfBanner,
  planMerge,
  rebuildFormulaUnits,
  reviewActionsLocked,
  selectionForReviewUnit,
  selectionKey
} from "../lib/review-actions.js";
import { LABEL_SCHEMA, unitIdFromMembers, verifyPageLabels } from "../lib/label-schema.js";

test("a missing PDF locks confirm and names the file", () => {
  assert.equal(reviewActionsLocked(true), true);
  assert.equal(reviewActionsLocked(false), false);
  const banner = missingPdfBanner("crmath-64");
  assert.match(banner, /corpus\/pdfs\/crmath-64\.pdf/);
  assert.match(banner, /--import/);
  assert.match(banner, /不能复核/);
  const review = readFileSync(new URL("../tools/label-review/review.js", import.meta.url), "utf8");
  const confirm = review.slice(review.indexOf("async function confirmUnit"));
  assert.match(confirm, /reviewActionsLocked\(state\.pdfMissing\)/);
  assert.match(confirm, /confirmBlocked\(state\.notice, state\.selected\)/);
  const keys = review.slice(review.indexOf("window.addEventListener(\"keydown\""));
  assert.match(keys, /reviewActionsLocked\(state\.pdfMissing\) && !isNavigationKey\(key\)/);
  assert.match(review, /arrayBuffer\(\)/);
  assert.match(review, /data: bytes\.slice\(\)/);
  assert.equal(review.includes("getDocument({ url:"), false);
  assert.match(review, /missingPdfBanner\(/);
  assert.match(review, /pdfBytes\.delete\(paperId\)/);
  assert.match(review, /method: "HEAD"/);
  assert.match(review.slice(review.indexOf("async function showMissingPdf"), review.indexOf("async function loadPdfBytes")), /summary\.textContent = "还没有选中元素。"/);
  assert.match(review.slice(review.indexOf("async function showMissingPdf"), review.indexOf("async function loadPdfBytes")), /detail\.textContent = ""/);
  assert.match(review, /isRenderingCancelled\(error\)/);
  assert.match(review, /selectionForReviewUnit\(/);
  assert.equal(review.includes("slice(0, 8)"), false);
  assert.match(review, /inspectorModel\(/);
  assert.equal(isRenderingCancelled({ name: "RenderingCancelledException" }), true);
  assert.equal(isRenderingCancelled(new Error("Rendering cancelled, page 4")), true);
  assert.equal(isRenderingCancelled(new Error("missing-pdf")), false);
  const css = readFileSync(new URL("../tools/label-review/review.css", import.meta.url), "utf8");
  assert.ok(css.indexOf(".hit.uncertain") < css.indexOf("rect.hit.selected"));
  assert.match(css, /rect\.hit\.selected[\s\S]*stroke:\s*#b00000 !important/);
  assert.match(css, /#pdf-missing/);
  assert.match(css, /#inspector[\s\S]*min-height:\s*0/);
  assert.match(css, /#inspector[\s\S]*overflow-y:\s*auto/);
  const html = readFileSync(new URL("../tools/label-review/index.html", import.meta.url), "utf8");
  assert.match(html, /id="action-notice"/);
  assert.match(html, /id="detail"/);
});

function glyph(char, bbox, extra = {}) {
  return {
    kind: "glyph",
    char,
    font: extra.font || "CMR10",
    bbox,
    pathHash: "",
    label: extra.label || "text",
    confidence: extra.confidence ?? 0.93,
    rule: extra.rule || "body-font",
    unitId: extra.unitId || null,
    unitType: extra.unitType || null,
    equationNumber: extra.equationNumber === true,
    ...extra,
    char,
    bbox
  };
}

test("merge keeps one element from becoming a silent no-op failure", () => {
  const elements = [
    glyph("x", [0, 0, 8, 10], { label: "formula", unitId: "u1", unitType: "inline", id: "a" })
  ];
  const alone = planMerge(elements, ["a"]);
  assert.equal(alone.ok, false);
  assert.match(alone.message, /拖出方框/);
  assert.equal(confirmBlocked({ ok: false, selectionKey: selectionKey(["a"]) }, ["a"]), true);
  assert.equal(confirmBlocked({ ok: false, selectionKey: selectionKey(["a"]) }, ["a", "b"]), false);
  const same = planMerge([
    glyph("x", [0, 0, 8, 10], { label: "formula", unitId: "u1", unitType: "inline", id: "a" }),
    glyph("y", [10, 0, 18, 10], { label: "formula", unitId: "u1", unitType: "inline", id: "b" })
  ], ["a", "b"]);
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
  assert.match(same.message, /已经是同一个单元/);
});

test("merge turns text plus formula into one unit and leaves a remainder", () => {
  const elements = [
    glyph("Attention(", [0, 0, 40, 10], { id: "text" }),
    glyph("Q", [42, 0, 52, 10], { id: "q", label: "formula", unitId: "u-old", unitType: "display", confidence: 0.96, rule: "math-font" }),
    glyph("V", [54, 0, 64, 10], { id: "v", label: "formula", unitId: "u-old", unitType: "display", confidence: 0.96, rule: "math-font" }),
    glyph("(1)", [200, 0, 220, 10], { id: "num", label: "formula", unitId: "u-old", unitType: "display", confidence: 0.7, rule: "equation-number", equationNumber: true })
  ];
  const result = applyMerge(elements, ["text", "q", "v"]);
  assert.equal(result.ok, true);
  assert.equal(result.message, "已合并 3 个元素为 1 个单元；原单元剩余 1 个元素（(1)）");
  assert.equal(elements[0].label, "formula");
  assert.equal(elements[0].rule, "human");
  assert.equal(elements[0].confidence, 1);
  const merged = elements.filter((element) => element.unitId === elements[0].unitId);
  assert.deepEqual(merged.map((element) => element.id).sort(), ["q", "text", "v"]);
  assert.equal(merged[0].unitType, "display");
  assert.equal(merged[0].unitId, unitIdFromMembers(["text", "q", "v"]));
  const rest = elements.find((element) => element.id === "num");
  assert.equal(rest.unitId, unitIdFromMembers(["num"]));
  assert.equal(rest.equationNumber, true);
  assert.notEqual(rest.unitId, merged[0].unitId);
  const numbered = applyEquationNumber(elements, ["num"]);
  assert.equal(numbered.ok, true);
  assert.match(numbered.message, /已把 \(1\) 标成公式编号，并入旁边的单元/);
  assert.equal(elements.every((element) => element.unitId === elements[0].unitId), true);
  assert.equal(elements.find((element) => element.id === "num").equationNumber, true);
  assert.equal(elements.find((element) => element.id === "num").rule, "equation-number");
  assert.equal(elements.filter((element) => element.equationNumber).map((element) => element.id).join(), "num");
  const unit = numbered.units.find((entry) => entry.elementIds.includes("num"));
  assert.equal(unit.equationNumber, true);
  assert.equal(unit.type, "display");
  assert.equal(unit.id, unitIdFromMembers(unit.elementIds));
});

test("the page 4 attention equation merges the dragged glyphs and then takes (1)", () => {
  const page = JSON.parse(readFileSync(new URL("../labels/prelabel/1706.03762/page-004.json", import.meta.url), "utf8"));
  const number = page.elements.find((element) => element.char === "(1)" && element.rule === "equation-number");
  assert.equal(number.equationNumber, true);
  assert.equal(number.unitId, "ud1cbf2babd77");
  const dragged = page.elements.filter((element) => {
    const box = element.bbox;
    return box[0] < 420 && box[2] > 210 && box[1] < 495 && box[3] > 450;
  });
  assert.equal(dragged.length, 13);
  assert.equal(dragged.some((element) => element.char === "(1)"), false);
  assert.equal(dragged.some((element) => element.char === "V"), true);
  assert.equal(dragged.some((element) => element.char === ")"), true);
  const result = applyMerge(page.elements, dragged.map((element) => element.id));
  assert.equal(result.ok, true);
  assert.equal(result.message, "已合并 13 个元素为 1 个单元；原单元剩余 1 个元素（(1)）");
  const mergedId = dragged[0].unitId;
  assert.equal(dragged.every((element) => element.unitId === mergedId && element.label === "formula"), true);
  assert.equal(number.unitId === mergedId, false);
  assert.equal(number.equationNumber, true);
  const attached = applyEquationNumber(page.elements, [number.id]);
  assert.match(attached.message, /已把 \(1\) 标成公式编号/);
  assert.equal(number.equationNumber, true);
  assert.equal(number.rule, "equation-number");
  assert.equal(dragged.every((element) => element.unitId === number.unitId), true);
  assert.equal(dragged.some((element) => element.id !== number.id && element.equationNumber), false);
  page.units = attached.units;
  page.source = "reviewed";
  assert.deepEqual(verifyPageLabels(page), []);
  const unit = page.units.find((entry) => entry.id === number.unitId);
  assert.equal(unit.equationNumber, true);
  assert.equal(unit.type, "display");
  assert.equal(unit.elementIds.length, 14);
  assert.equal(unit.id, unitIdFromMembers(unit.elementIds));
});

test("the inspector lists every selected element and groups them by unit", () => {
  const rows = [];
  for (let index = 0; index < 13; index += 1) {
    rows.push({
      id: `e${index}`,
      char: index === 10 ? ")" : index === 11 ? "V" : `g${index}`,
      label: index < 2 ? "text" : "formula",
      unitId: index < 2 ? "" : "ud1cbf2babd77",
      equationNumber: false
    });
  }
  const model = inspectorModel(rows);
  assert.equal(model.count, 13);
  assert.equal(model.groups.length, 2);
  assert.equal(model.groups[1].unitId, "ud1cbf2babd77");
  const lines = model.groups.flatMap((group) => group.rows);
  assert.equal(lines.length, 13);
  assert.equal(lines.some((row) => row.char === "V" && row.unitId === "ud1cbf2babd77"), true);
  assert.equal(lines.some((row) => row.char === ")"), true);
  const page = { schema: LABEL_SCHEMA };
  assert.equal(page.schema, "open-immerse.labels/v1");
});

test("split of a non-formula selection fails visibly and blocks confirm", () => {
  const elements = [glyph("Attention(", [0, 0, 40, 10], { id: "text" })];
  const result = applySplit(elements, ["text"]);
  assert.equal(result.ok, false);
  assert.match(result.message, /没有可拆开/);
  const notice = { ok: false, selectionKey: selectionKey(["text"]) };
  assert.equal(confirmBlocked(notice, ["text"]), true);
});

test("import rejection is Chinese and does not echo the English id mismatch", () => {
  const message = importRejection(["element 0 id does not match char/font/bbox"]);
  assert.match(message, /^导入被拒绝：/);
  assert.match(message, /第 0 个元素/);
  assert.equal(message.includes("id does not match"), false);
  assert.match(message, /不要手改元素编号/);
});

function formulaRow(id, char, unitId, extra = {}) {
  return {
    id,
    kind: "glyph",
    char,
    font: "CMMI10",
    bbox: extra.bbox || [0, 0, 8, 10],
    pathHash: "",
    label: "formula",
    confidence: 0.96,
    rule: "math-font",
    unitId,
    unitType: extra.unitType || "inline",
    equationNumber: extra.equationNumber === true
  };
}

test("reopening an unchanged review unit selects its current members", () => {
  const ids = ["a", "b", "c"];
  const unitId = unitIdFromMembers(ids);
  const elements = ids.map((id, index) => formulaRow(id, id, unitId, { bbox: [index * 10, 0, index * 10 + 8, 10] }));
  const mapped = selectionForReviewUnit(elements, ids, unitId);
  assert.deepEqual(mapped.ids, ids);
  assert.deepEqual(mapped.unitIds, [unitId]);
  assert.equal(mapped.changed, false);
  assert.equal(mapped.spanned, false);
  const fresh = formatQueueStatus({
    reviewedCount: 0,
    reviewTotal: 1000,
    reviewed: false,
    changed: mapped.changed,
    unitIds: mapped.unitIds,
    elementCount: mapped.count
  });
  assert.equal(fresh.countLine, "队列已复核 0/1000");
  assert.equal(fresh.statusLine, "未复核");
  const saved = formatQueueStatus({
    reviewedCount: 1,
    reviewTotal: 1000,
    reviewed: true,
    changed: false,
    unitIds: mapped.unitIds,
    elementCount: mapped.count
  });
  assert.equal(saved.statusLine, `已复核 · 当前单元 ${unitId} · 3 个元素`);
});

test("reopening the merged page-4 equation selects all 14 current members", () => {
  const page = JSON.parse(readFileSync(new URL("../labels/prelabel/1706.03762/page-004.json", import.meta.url), "utf8"));
  const original = page.units.find((unit) => unit.id === "ud1cbf2babd77").elementIds.slice();
  assert.equal(original.length, 9);
  const number = page.elements.find((element) => element.char === "(1)" && element.rule === "equation-number");
  const dragged = page.elements.filter((element) => {
    const box = element.bbox;
    return box[0] < 420 && box[2] > 210 && box[1] < 495 && box[3] > 450;
  });
  assert.equal(dragged.length, 13);
  applyMerge(page.elements, dragged.map((element) => element.id));
  applyEquationNumber(page.elements, [number.id]);
  const mapped = selectionForReviewUnit(page.elements, original, "ud1cbf2babd77");
  assert.equal(mapped.count, 14);
  assert.equal(mapped.ids.length, 14);
  assert.equal(mapped.unitIds.length, 1);
  assert.notEqual(mapped.unitIds[0], "ud1cbf2babd77");
  assert.equal(mapped.equationNumber, true);
  assert.equal(mapped.spanned, false);
  assert.equal(original.every((id) => mapped.ids.includes(id)), true);
  const selected = page.elements.filter((element) => mapped.ids.includes(element.id));
  assert.equal(selected.some((element) => element.char === "Attention("), true);
  assert.equal(selected.some((element) => element.char === ") = softmax("), true);
  assert.equal(selected.every((element) => element.unitId === mapped.unitIds[0]), true);
  const status = formatQueueStatus({
    reviewedCount: 1,
    reviewTotal: 1000,
    reviewed: true,
    changed: mapped.changed,
    unitIds: mapped.unitIds,
    elementCount: mapped.count,
    equationNumber: mapped.equationNumber
  });
  assert.equal(status.countLine, "队列已复核 1/1000");
  assert.equal(status.statusLine, `已复核 · 当前单元 ${mapped.unitIds[0]} · 14 个元素（含公式编号）`);
});

test("reopening a split unit selects every piece and says so", () => {
  const ids = ["a", "b", "c", "d"];
  const unitId = unitIdFromMembers(ids);
  const elements = ids.map((id, index) => formulaRow(id, id, unitId, { bbox: [index * 12, 0, index * 12 + 8, 10] }));
  applySplit(elements, ids);
  const mapped = selectionForReviewUnit(elements, ids, unitId);
  assert.equal(mapped.spanned, true);
  assert.equal(mapped.changed, true);
  assert.equal(mapped.unitIds.length, 4);
  assert.deepEqual(mapped.ids, ids);
  const status = formatQueueStatus({
    reviewed: false,
    changed: mapped.changed,
    unitIds: mapped.unitIds,
    elementCount: mapped.count,
    spanned: mapped.spanned,
    reviewTotal: 1000,
    reviewedCount: 0
  });
  assert.match(status.statusLine, /^未复核 · 已改过，尚未确认/);
  assert.match(status.statusLine, /当前 4 个单元 · 4 个元素/);
  assert.match(status.statusLine, /原单元现在分成多个单元/);
});

test("reopening keeps a glyph that was relabeled to text and marks it", () => {
  const ids = ["a", "b", "c"];
  const unitId = unitIdFromMembers(ids);
  const elements = ids.map((id, index) => formulaRow(id, id, unitId, { bbox: [index * 12, 0, index * 12 + 8, 10] }));
  const text = elements.find((element) => element.id === "b");
  text.label = "text";
  text.rule = "human";
  text.confidence = 1;
  rebuildFormulaUnits(elements);
  const mapped = selectionForReviewUnit(elements, ids, unitId);
  assert.deepEqual(mapped.nonFormulaIds, ["b"]);
  assert.equal(mapped.ids.includes("b"), true);
  assert.equal(mapped.changed, true);
  assert.equal(elements.find((element) => element.id === "a").unitId, elements.find((element) => element.id === "c").unitId);
  assert.equal(mapped.unitIds.length, 1);
  const status = formatQueueStatus({
    reviewed: false,
    changed: true,
    unitIds: mapped.unitIds,
    elementCount: mapped.count,
    nonFormulaCount: mapped.nonFormulaIds.length,
    reviewTotal: 1000,
    reviewedCount: 0
  });
  assert.match(status.statusLine, /未复核 · 已改过，尚未确认/);
  assert.match(status.statusLine, /1 个已不是公式/);
});
