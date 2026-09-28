import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyEquationNumber,
  applyMerge,
  applySplit,
  attachExtensionPairs,
  bindExtensionPairUnits,
  confirmBlocked,
  dragSelectsElement,
  expandPairIds,
  extensionDelimiterPairs,
  EXTRA_SELECTION_HEADING,
  formatQueueStatus,
  importRejection,
  inspectorModel,
  isRenderingCancelled,
  isTaskRed,
  isWideProseText,
  missingPdfBanner,
  nextClickSelection,
  nextDragSelection,
  otherQueueMarks,
  overlayClass,
  pageRectFromPointer,
  pageUnitColor,
  PAIR_SPLIT_NOTICE,
  planEquationNumber,
  planMerge,
  rebuildFormulaUnits,
  reviewActionsLocked,
  reviewMarkBoxes,
  selectionAside,
  selectionForReviewUnit,
  selectionKey,
  zoomToFitWidth
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
  assert.match(review, /selectionAside\(/);
  assert.match(review, /EXTRA_SELECTION_HEADING/);
  assert.match(review, /dragSelectsElement\(/);
  assert.match(review, /zoomToFitWidth\(/);
  assert.equal(isRenderingCancelled({ name: "RenderingCancelledException" }), true);
  assert.equal(isRenderingCancelled(new Error("Rendering cancelled, page 4")), true);
  assert.equal(isRenderingCancelled(new Error("missing-pdf")), false);
  const css = readFileSync(new URL("../tools/label-review/review.css", import.meta.url), "utf8");
  assert.ok(css.indexOf(".hit.uncertain") < css.indexOf(".hit.current"));
  assert.match(css, /#overlay\.unit-mode \.hit\.current \{[^}]*stroke:\s*#b00000/);
  assert.match(css, /#overlay\.unit-mode \.hit\.picked[\s\S]*?stroke:\s*#c46b12/);
  assert.equal(css.includes("rect.hit.selected"), false);
  assert.match(review, /overlayClass\(/);
  assert.equal(review.includes("rect.hit.selected"), false);
  assert.equal(review.includes("#b00000"), false);
  assert.match(css, /#pdf-missing/);
  assert.match(css, /#inspector[\s\S]*min-height:\s*0/);
  assert.match(css, /#inspector[\s\S]*overflow-y:\s*auto/);
  const html = readFileSync(new URL("../tools/label-review/index.html", import.meta.url), "utf8");
  assert.match(html, /id="action-notice"/);
  assert.match(html, /id="detail"/);
  assert.match(html, /红色实心：当前要核对的单元。灰色细框：其他预标注，不用管。橙色虚线：你的选区。/);
  const docs = readFileSync(new URL("../docs/v1-m1-labels.md", import.meta.url), "utf8");
  assert.match(docs, /红色实心是当前要核对的单元，灰色细框是其他预标注，不用管，橙色虚线是你的选区/);
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

test("unit mode paints only the queue unit red", () => {
  const currentIds = ["eq-a", "eq-b"];
  const selectedIds = ["eq-b", "body-d"];
  const queuedIds = ["other-a"];
  const current = overlayClass({
    mode: "units",
    elementId: "eq-a",
    label: "formula",
    uncertain: true,
    currentIds,
    selectedIds,
    queuedIds
  });
  const overlap = overlayClass({
    mode: "units",
    elementId: "eq-b",
    label: "formula",
    currentIds,
    selectedIds,
    queuedIds
  });
  const picked = overlayClass({
    mode: "units",
    elementId: "body-d",
    label: "formula",
    currentIds,
    selectedIds,
    queuedIds
  });
  const queued = overlayClass({
    mode: "units",
    elementId: "other-a",
    label: "formula",
    currentIds,
    selectedIds,
    queuedIds
  });
  const neutral = overlayClass({
    mode: "units",
    elementId: "plain",
    label: "text",
    uncertain: true,
    currentIds,
    selectedIds,
    queuedIds
  });
  assert.equal(current, "hit formula current");
  assert.equal(overlap, "hit formula current");
  assert.equal(picked, "hit formula picked");
  assert.equal(queued, "hit formula queued");
  assert.equal(neutral, "hit text neutral");
  for (const className of [picked, queued, neutral]) {
    assert.equal(className.includes("current"), false);
  }
});

test("page mode keeps unit colours and never uses the task red", () => {
  const selected = overlayClass({
    mode: "pages",
    elementId: "eq-a",
    label: "formula",
    uncertain: true,
    currentIds: ["eq-a"],
    selectedIds: ["eq-a"]
  });
  const idle = overlayClass({
    mode: "pages",
    elementId: "body-d",
    label: "formula",
    currentIds: ["eq-a"],
    selectedIds: []
  });
  assert.equal(selected, "hit formula uncertain picked");
  assert.equal(selected.includes("current"), false);
  assert.equal(idle, "hit formula");
  const colors = Array.from({ length: 240 }, (_, index) => pageUnitColor(index));
  assert.equal(new Set(colors).size > 8, true);
  for (const color of colors) {
    assert.equal(isTaskRed(color), false);
    assert.notEqual(color, "#b00000");
  }
  assert.equal(isTaskRed("#b00000"), true);
  assert.equal(isTaskRed("hsl(0 70% 32%)"), true);
  assert.equal(isTaskRed("hsl(47 70% 32%)"), false);
});

test("page 4 equation is the only red mark and a second queue unit stays grey", () => {
  const page = JSON.parse(readFileSync(new URL("../labels/prelabel/1706.03762/page-004.json", import.meta.url), "utf8"));
  const reviewSet = JSON.parse(readFileSync(new URL("../labels/review-set.json", import.meta.url), "utf8"));
  const onPage = reviewSet.units.filter((unit) => unit.paperId === "1706.03762" && unit.page === 4);
  assert.equal(onPage.length, 1);
  assert.equal(onPage[0].unitId, "ud1cbf2babd77");
  const mapped = selectionForReviewUnit(page.elements, onPage[0].elementIds, onPage[0].unitId);
  assert.equal(mapped.count, 9);
  const marks = otherQueueMarks({
    units: reviewSet.units,
    paperId: "1706.03762",
    page: 4,
    elements: page.elements,
    currentReviewUnitId: "ud1cbf2babd77"
  });
  assert.deepEqual(marks, []);
  const body = page.elements.find((element) => element.label === "formula" && element.char === "d" && !mapped.ids.includes(element.id));
  assert.ok(body);
  const bodyClass = overlayClass({
    mode: "units",
    elementId: body.id,
    label: body.label,
    uncertain: Number(body.confidence) < 0.75,
    currentIds: mapped.ids,
    selectedIds: mapped.ids,
    queuedIds: []
  });
  assert.equal(bodyClass, "hit formula neutral");
  for (const element of page.elements) {
    const className = overlayClass({
      mode: "units",
      elementId: element.id,
      label: element.label,
      currentIds: mapped.ids,
      selectedIds: ["outside", ...mapped.ids],
      queuedIds: []
    });
    if (mapped.ids.includes(element.id)) assert.equal(className.endsWith("current"), true);
    else if (element.id === "outside") assert.fail("missing id");
    else assert.equal(className.includes("current"), false);
  }
  const dragged = overlayClass({
    mode: "units",
    elementId: body.id,
    label: "formula",
    currentIds: mapped.ids,
    selectedIds: [body.id, mapped.ids[0]],
    queuedIds: []
  });
  assert.equal(dragged, "hit formula picked");
  const stillCurrent = overlayClass({
    mode: "units",
    elementId: mapped.ids[0],
    label: "formula",
    currentIds: mapped.ids,
    selectedIds: [body.id, mapped.ids[0]],
    queuedIds: []
  });
  assert.equal(stillCurrent.endsWith("current"), true);

  const extra = formulaRow("zz", "z", "u-other");
  const elements = [extra, ...page.elements];
  const withSecond = otherQueueMarks({
    units: [
      onPage[0],
      { paperId: "1706.03762", page: 4, unitId: "u-other", elementIds: ["zz"] }
    ],
    paperId: "1706.03762",
    page: 4,
    elements,
    currentReviewUnitId: "ud1cbf2babd77"
  });
  assert.equal(withSecond.length, 1);
  assert.equal(withSecond[0].queueNumber, 2);
  assert.deepEqual(withSecond[0].elementIds, ["zz"]);
  assert.equal(overlayClass({
    mode: "units",
    elementId: "zz",
    label: "formula",
    currentIds: mapped.ids,
    selectedIds: mapped.ids,
    queuedIds: withSecond[0].elementIds
  }), "hit formula queued");
});

test("drag selection keeps covered symbols and drops grazed wide text", () => {
  const pcbi = JSON.parse(readFileSync(new URL("../labels/prelabel/pcbi-1004584/page-008.json", import.meta.url), "utf8"));
  const rect = [278, 524, 370, 542];
  const hits = pcbi.elements.filter((element) => dragSelectsElement(element.bbox, rect));
  const members = pcbi.elements.filter((element) => element.unitId === "u8e8ec589c717");
  assert.equal(members.every((element) => hits.some((hit) => hit.id === element.id)), true);
  assert.equal(hits.some((element) => element.char === "for each connection type"), false);
  assert.equal(hits.some((element) => element.char === "Description"), false);
  assert.equal(hits.some((element) => element.label === "other" && element.bbox[2] - element.bbox[0] > 200), false);
  const wide = pcbi.elements.find((element) => element.char === "for each connection type");
  const mid = (wide.bbox[0] + wide.bbox[2]) / 2;
  assert.equal(dragSelectsElement(wide.bbox, [mid - 8, wide.bbox[1], mid + 8, wide.bbox[3]]), false);
  const subscript = members.find((element) => element.char === "rise,");
  assert.equal(dragSelectsElement(subscript.bbox, rect), true);

  const bmc = JSON.parse(readFileSync(new URL("../labels/prelabel/bmc-12874-022-01542-8/page-002.json", import.meta.url), "utf8"));
  const inline = bmc.elements.filter((element) => element.unitId === "u0126a8e48b5d");
  const box = inline.reduce((acc, element) => [
    Math.min(acc[0], element.bbox[0]),
    Math.min(acc[1], element.bbox[1]),
    Math.max(acc[2], element.bbox[2]),
    Math.max(acc[3], element.bbox[3])
  ], [Infinity, Infinity, -Infinity, -Infinity]);
  const loose = [box[0] - 4, box[1] - 3, box[2] + 8, box[3] + 4];
  const bmcHits = bmc.elements.filter((element) => dragSelectsElement(element.bbox, loose));
  assert.equal(inline.every((element) => bmcHits.some((hit) => hit.id === element.id)), true);
  assert.equal(bmcHits.some((element) => element.char === ") and random effects ("), false);
  assert.equal(bmcHits.some((element) => String(element.char || "").includes("normally distrib")), false);
});

test("drag geometry matches at 100% and 400% zoom", () => {
  const subscript = [286.2, 531, 297.1, 536.4];
  const wide = [365.7, 527, 452.1, 535];
  const start = { x: 278, y: 524 };
  const end = { x: 370, y: 542 };
  const at1 = pageRectFromPointer(start, end, 1);
  const at4 = pageRectFromPointer({ x: start.x * 4, y: start.y * 4 }, { x: end.x * 4, y: end.y * 4 }, 4);
  assert.deepEqual(at4.map((value) => Math.round(value * 10) / 10), at1);
  assert.equal(dragSelectsElement(subscript, at1), dragSelectsElement(subscript, at4));
  assert.equal(dragSelectsElement(wide, at1), false);
  assert.equal(dragSelectsElement(wide, at4), false);
  assert.equal(zoomToFitWidth([{ bbox: [0, 0, 100, 12] }], 800), 4);
  assert.equal(zoomToFitWidth([{ bbox: [0, 0, 20, 8] }], 800), 4);
  assert.equal(zoomToFitWidth([{ bbox: [0, 0, 2000, 12] }], 800), 0.8);
});

test("alt-drag subtracts and ctrl-click toggles", () => {
  assert.deepEqual(nextDragSelection(["a", "b"], ["b", "c"], { alt: true }), ["a"]);
  assert.deepEqual(nextDragSelection(["a"], ["b"], { shift: true }).sort(), ["a", "b"]);
  assert.deepEqual(nextDragSelection(["a"], ["b"], {}), ["b"]);
  assert.deepEqual(nextClickSelection(["a", "b"], "b", { toggle: true }), ["a"]);
  assert.deepEqual(nextClickSelection(["a"], "b", { toggle: true }).sort(), ["a", "b"]);
  assert.deepEqual(nextClickSelection(["a"], "c", { shift: true }).sort(), ["a", "c"]);
  assert.deepEqual(nextClickSelection(["a", "b"], "c", {}), ["c"]);
});

test("merge refuses a wide prose run and still accepts a short symbol", () => {
  assert.equal(isWideProseText({ label: "text", char: "for each connection type" }), true);
  assert.equal(isWideProseText({ label: "text", char: ") and random effects (" }), true);
  assert.equal(isWideProseText({ label: "text", char: "G" }), false);
  assert.equal(isWideProseText({ label: "text", char: "d" }), false);
  assert.equal(isWideProseText({ label: "text", char: "(" }), false);
  assert.equal(isWideProseText({ label: "text", char: "Attention(" }), false);
  assert.equal(isWideProseText({ label: "text", char: ") = softmax(" }), false);
  const prose = glyph(") and random effects (", [360, 633, 455, 643], { id: "prose", label: "text" });
  const symbol = formulaRow("u", "u", "u-inline", { bbox: [423, 633, 429, 643] });
  const refused = planMerge([prose, symbol], ["prose", "u"]);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /and random effects/);
  assert.match(refused.message, /Ctrl/);
  assert.match(refused.message, /Alt/);
  assert.equal(prose.label, "text");
  assert.equal(confirmBlocked({ ok: false, selectionKey: selectionKey(["prose", "u"]) }, ["prose", "u"]), true);
  const short = glyph("G", [339, 527, 345, 535], { id: "g", label: "text" });
  const tau = formulaRow("tau", "τ", "u-tau", { bbox: [283, 527, 286, 535] });
  const merged = applyMerge([short, tau], ["g", "tau"]);
  assert.equal(merged.ok, true);
  assert.equal(short.label, "formula");
  assert.equal(short.unitId, tau.unitId);
});

test("merge accepts operator names such as max, Cov[ and i.i.d.", () => {
  const names = [
    "max", "min", "sup", "inf", "lim", "liminf", "limsup",
    "arg", "argmax", "argmin", "log", "ln", "lg", "exp",
    "sin", "cos", "tan", "cot", "sec", "csc",
    "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
    "det", "dim", "ker", "deg", "gcd", "lcm", "ppcm", "pgcd", "mod",
    "tr", "Tr", "diag", "rank", "sgn", "sign",
    "Pr", "Var", "Cov", "Corr", "var", "cov",
    "span", "Re", "Im", "erf", "Id",
    "s.t.", "i.i.d.", "a.e."
  ];
  for (const name of names) {
    assert.equal(isWideProseText({ label: "text", char: name }), false, name);
  }
  assert.equal(isWideProseText({ label: "text", char: "Cov[" }), false);
  assert.equal(isWideProseText({ label: "text", char: "max min" }), false);
  assert.equal(isWideProseText({ label: "text", char: "Indeed, Cov[" }), true);
  assert.equal(isWideProseText({ label: "text", char: ") and random effects (" }), true);
  const max = glyph("max", [40, 80, 62, 92], { id: "max", label: "text" });
  const sub = formulaRow("sub", "j", "u-display", { bbox: [44, 92, 50, 100], unitType: "display" });
  const merged = applyMerge([max, sub], ["max", "sub"]);
  assert.equal(merged.ok, true);
  assert.equal(max.label, "formula");
  assert.equal(max.unitId, sub.unitId);
  assert.equal(max.unitType, "display");
  const cov = glyph("Cov[", [10, 10, 28, 20], { id: "cov", label: "text" });
  const arg = formulaRow("arg", "X", "u-cov", { bbox: [28, 12, 36, 20], unitType: "inline" });
  const covMerged = applyMerge([cov, arg], ["cov", "arg"]);
  assert.equal(covMerged.ok, true);
  assert.equal(cov.label, "formula");
  assert.equal(cov.unitId, arg.unitId);
  const iid = glyph("i.i.d.", [70, 40, 92, 50], { id: "iid", label: "text" });
  const host = formulaRow("host", "X", "u-iid", { bbox: [94, 40, 104, 50], unitType: "inline" });
  const iidMerged = applyMerge([iid, host], ["iid", "host"]);
  assert.equal(iidMerged.ok, true);
  assert.equal(iid.label, "formula");
  assert.equal(iid.unitId, host.unitId);
});

test("split peels a selected subset into one inline unit", () => {
  const ids = ["rise", "sub", "decay", "dsub", "g"];
  const unitId = unitIdFromMembers(ids);
  const elements = ids.map((id, index) => formulaRow(id, id, unitId, {
    bbox: [index * 12, 0, index * 12 + 8, 10],
    unitType: "inline"
  }));
  const result = applySplit(elements, ["rise", "sub"]);
  assert.equal(result.ok, true);
  assert.match(result.message, /行内单元/);
  const rise = elements.find((element) => element.id === "rise");
  const sub = elements.find((element) => element.id === "sub");
  const decay = elements.find((element) => element.id === "decay");
  const rest = elements.find((element) => element.id === "g");
  assert.equal(rise.unitId, sub.unitId);
  assert.equal(rise.unitType, "inline");
  assert.equal(decay.unitId, rest.unitId);
  assert.notEqual(rise.unitId, decay.unitId);
  assert.equal(elements.filter((element) => element.unitId === decay.unitId).length, 3);
  const kept = elements.find((element) => element.id === "dsub");
  const aside = selectionAside([rise, sub, decay], [decay.id, rest.id, kept.id]);
  assert.equal(aside.extra.count, 2);
  assert.equal(aside.inside.count, 1);
  assert.equal(EXTRA_SELECTION_HEADING, "选区里还有这些（不属于当前单元）");
  const docs = readFileSync(new URL("../docs/v1-m1-labels.md", import.meta.url), "utf8");
  assert.match(docs, /每个符号单独是一个行内单元/);
  assert.match(docs, /按住 Alt 再拖/);
});

function srgbChannel(hex, offset) {
  const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => 0.2126 * srgbChannel(hex, 1) + 0.7152 * srgbChannel(hex, 3) + 0.0722 * srgbChannel(hex, 5);
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function cssBlock(css, selector) {
  const blocks = css.match(/[^{}]+\{[^}]*\}/g) || [];
  const block = blocks.find((entry) => entry.split("{")[0].split(",").some((part) => part.trim() === selector));
  assert.ok(block, selector);
  return block;
}

function cssHex(block, property) {
  const match = block.match(new RegExp(`${property}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, property);
  return match[1].toLowerCase();
}

test("queue items stay readable against their background", () => {
  const css = readFileSync(new URL("../tools/label-review/review.css", import.meta.url), "utf8");
  const review = readFileSync(new URL("../tools/label-review/review.js", import.meta.url), "utf8");
  const pairs = [
    ["#queue button", "color", "background"],
    ["#queue button.reviewed", "color", "background"],
    ["#queue button.current", "color", "background"]
  ];
  for (const [selector, foreground, background] of pairs) {
    const block = cssBlock(css, selector);
    const ratio = contrastRatio(cssHex(block, foreground), cssHex(block, background));
    assert.equal(ratio >= 4.5, true, `${selector} contrast ${ratio}`);
  }
  assert.match(review, /已看 · /);
  assert.match(review, /"reviewed"/);
});

test("merge keeps a trailing comma or period on a display equation", () => {
  for (const mark of [",", "."]) {
    assert.equal(isWideProseText({ label: "text", char: mark }), false);
    const formula = formulaRow("eq", "x^2", "u-display", { bbox: [80, 400, 200, 424], unitType: "display" });
    const punct = glyph(mark, [204, 410, 210, 422], { id: "punct", label: "text" });
    const merged = applyMerge([formula, punct], ["eq", "punct"]);
    assert.equal(merged.ok, true, mark);
    assert.equal(punct.label, "formula");
    assert.equal(punct.unitType, "display");
    assert.equal(punct.unitId, formula.unitId);
    assert.equal(merged.units.some((unit) => unit.type === "display" && unit.elementIds.includes("punct")), true);
  }
  for (const mark of ["0:", "0,"]) {
    assert.equal(isWideProseText({ label: "text", char: mark }), false, mark);
    const formula = formulaRow("eq2", "q", "u-cond", { bbox: [10, 40, 22, 52], unitType: "inline" });
    const glued = glyph(mark, [24, 40, 36, 52], { id: "glued", label: "text" });
    const merged = applyMerge([formula, glued], ["eq2", "glued"]);
    assert.equal(merged.ok, true, mark);
    assert.equal(glued.label, "formula");
    assert.equal(glued.unitId, formula.unitId);
  }
  const docs = readFileSync(new URL("../docs/v1-m1-labels.md", import.meta.url), "utf8");
  assert.match(docs, /行间公式同一行末尾的逗号或句号属于这个行间单元/);
  assert.match(docs, /行内公式后面的逗号或句号是句子的标点/);
});

test("extension glyphs pair with the ink below and ignore the box inside", () => {
  const brace = glyph("{(", [177.52, 155.66, 188.63, 164.83], {
    id: "brace",
    font: "Fourier-Math-Extension",
    label: "formula",
    unitId: "u-eq",
    unitType: "inline"
  });
  const ink = glyph("", [178.43, 164.53, 182.55, 191.91], {
    id: "ink",
    font: "",
    label: "text",
    source: "unbound-paint"
  });
  const tiny = glyph("", [177.65, 156.04, 181.39, 159.62], {
    id: "tiny",
    font: "",
    label: "formula",
    unitId: "u-eq",
    unitType: "inline",
    source: "unbound-paint"
  });
  const farther = glyph("", [185.3, 164.56, 188.17, 191.87], {
    id: "farther",
    font: "",
    label: "text",
    source: "unbound-paint"
  });
  const symbols = glyph("{(", [177.52, 155.66, 188.63, 164.83], {
    id: "symbols",
    font: "Fourier-Math-Symbols",
    label: "formula",
    unitId: "u-eq",
    unitType: "inline"
  });
  const paintedPath = {
    id: "path",
    kind: "path",
    char: "",
    font: "",
    bbox: [178.43, 164.53, 182.55, 191.91],
    pathHash: "abc",
    label: "other",
    source: "unbound-paint"
  };
  const pairs = extensionDelimiterPairs([brace, ink, tiny, farther, symbols, paintedPath]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].glyphId, "brace");
  assert.deepEqual(pairs[0].inkIds, ["ink", "farther"]);
  assert.equal(pairs[0].inkIds.includes("tiny"), false);
  assert.deepEqual(pairs[0].bbox.map((value) => Math.round(value * 100) / 100), [177.52, 155.66, 188.63, 191.91]);
  const ids = pairs.flatMap((pair) => [pair.glyphId, ...pair.inkIds]);
  assert.equal(new Set(ids).size, ids.length);
  const onlyParen = glyph(")", [194.79, 155.66, 199.31, 164.83], {
    id: "paren",
    font: "Fourier-Math-Extension",
    label: "formula",
    unitId: "u-eq",
    unitType: "inline"
  });
  const parenInk = glyph("", [195.25, 164.56, 198.12, 191.87], { id: "paren-ink", font: "", label: "text", source: "unbound-paint" });
  const parenExtra = glyph("", [196.4, 164.6, 198.9, 191.9], { id: "paren-extra", font: "", label: "text", source: "unbound-paint" });
  const oneSlot = extensionDelimiterPairs([onlyParen, parenInk, parenExtra]);
  assert.equal(oneSlot.length, 1);
  assert.equal(oneSlot[0].inkIds.length, 1);

  const cr = JSON.parse(readFileSync(new URL("../labels/prelabel/crmath-64/page-005.json", import.meta.url), "utf8"));
  const crPairs = extensionDelimiterPairs(cr.elements);
  const crInk = new Map(crPairs.map((pair) => [pair.glyphId, pair.inkIds]));
  assert.deepEqual(crInk.get("e25ce4faa62374675"), ["e0448a8642b781e0d", "eb833ef31c1d52903"]);
  assert.deepEqual(crInk.get("e907e3ababfca8a6a"), ["ef0af246d7975657b"]);
  assert.deepEqual(crInk.get("ee7a7487b33dd7257"), ["e99832899dc5cd27d"]);
  assert.deepEqual(crInk.get("ee4555cd760a81ff9"), ["e6e27d2e248a55194"]);
  assert.equal(crPairs.some((pair) => pair.inkIds.includes("eaae12e455d302d3f")), false);

  const arxiv = JSON.parse(readFileSync(new URL("../labels/prelabel/2006.11239/page-002.json", import.meta.url), "utf8"));
  const arxivInk = new Map(extensionDelimiterPairs(arxiv.elements).map((pair) => [pair.glyphId, pair.inkIds]));
  assert.deepEqual(arxivInk.get("ea5c3b6f6d0f752a8"), ["ee44bf55eb920979a"]);
  assert.deepEqual(arxivInk.get("eb17055b427a63e74"), ["e3bdf6e7fb9ba5755"]);
  assert.deepEqual(arxivInk.get("e34429737bb4d31b9"), ["e752b0bd9a00095b1"]);
  assert.deepEqual(arxivInk.get("ea35c268111d01425"), ["e8580da14d84458e9"]);
  assert.deepEqual(arxivInk.get("e5819031f18367c66"), ["eae5ad76e83bfffd0"]);
  const used = new Set();
  for (const pair of extensionDelimiterPairs(arxiv.elements)) {
    assert.equal(used.has(pair.glyphId), false);
    used.add(pair.glyphId);
    for (const inkId of pair.inkIds) {
      assert.equal(used.has(inkId), false);
      used.add(inkId);
    }
  }
});

test("a two-delimiter glyph keeps both inks in one box", () => {
  const cr = JSON.parse(readFileSync(new URL("../labels/prelabel/crmath-64/page-005.json", import.meta.url), "utf8"));
  const groups = extensionDelimiterPairs(cr.elements);
  const expected = [
    { char: "{(", x: 177.5, y: 155.7, inks: [[178.4, 164.5, 182.6, 191.9], [185.3, 164.6, 188.2, 191.9]] },
    { char: "{(", x: 249, y: 233, inks: [[249.7, 241.6, 253.8, 269], [256.6, 241.7, 259.4, 269]] },
    { char: "{(", x: 309, y: 276, inks: [[309.7, 284.9, 312.5, 295.8], [314.1, 284.9, 316.3, 295.9]] },
    { char: ")}", x: 365, y: 276, inks: [[365.6, 284.9, 367.8, 295.9], [369.4, 284.9, 372.2, 295.8]] }
  ];
  for (const spec of expected) {
    const glyph = cr.elements.find((element) => element.char === spec.char
      && /Extension/i.test(element.font || "")
      && Math.abs(element.bbox[0] - spec.x) < 1.5
      && Math.abs(element.bbox[1] - spec.y) < 1.5);
    const group = groups.find((pair) => pair.glyphId === glyph.id);
    assert.equal(group.inkIds.length, spec.inks.length, spec.char);
    const inkBoxes = group.inkIds.map((id) => cr.elements.find((element) => element.id === id).bbox);
    for (const ink of spec.inks) {
      assert.equal(inkBoxes.some((box) => ink.every((value, index) => Math.abs(box[index] - value) < 0.6)), true, `${spec.char} ${ink.join(",")}`);
    }
    const marks = reviewMarkBoxes(cr.elements.filter((element) => element.id === glyph.id || group.inkIds.includes(element.id)));
    assert.equal(marks.length, 1);
    assert.equal(marks[0].id, glyph.id);
    assert.equal(marks[0].bbox[1], Math.min(glyph.bbox[1], ...inkBoxes.map((box) => box[1])));
    assert.equal(marks[0].bbox[3], Math.max(glyph.bbox[3], ...inkBoxes.map((box) => box[3])));
    assert.deepEqual(expandPairIds(cr.elements, [group.inkIds[1]]).sort(), [glyph.id, ...group.inkIds].sort());
  }
  const sample = [
    glyph("{(", [177.52, 155.66, 188.63, 164.83], { id: "g", font: "Fourier-Math-Extension", label: "formula", unitId: "u", unitType: "inline" }),
    glyph("", [178.43, 164.53, 182.55, 191.91], { id: "brace-ink", font: "", label: "text", source: "unbound-paint" }),
    glyph("", [185.3, 164.56, 188.17, 191.87], { id: "paren-ink", font: "", label: "text", source: "unbound-paint" })
  ];
  const selected = expandPairIds(sample, ["paren-ink"]);
  assert.deepEqual(selected.sort(), ["brace-ink", "g", "paren-ink"]);
  applyMerge(sample, selected);
  assert.equal(sample.every((element) => element.label === "formula" && element.unitId === sample[0].unitId), true);
  assert.equal(sample.length, 3);
});

test("a delimiter pair is one box and one selection in every review action", () => {
  const elements = [
    glyph("{(", [177.52, 155.66, 188.63, 164.83], {
      id: "brace",
      font: "Fourier-Math-Extension",
      label: "formula",
      unitId: "u-eq",
      unitType: "display"
    }),
    glyph("", [178.43, 164.53, 182.55, 191.91], {
      id: "ink",
      font: "",
      label: "text",
      source: "unbound-paint"
    }),
    glyph("x", [210, 160, 220, 170], {
      id: "x",
      font: "CMMI10",
      label: "formula",
      unitId: "u-eq",
      unitType: "display"
    }),
    glyph("∑", [377.66, 610.67, 392.05, 620.63], {
      id: "sum",
      font: "CMEX10",
      label: "formula",
      unitId: "u-sum",
      unitType: "display"
    }),
    glyph("", [378.21, 620.63, 391.47, 634.58], {
      id: "sum-ink",
      font: "",
      label: "formula",
      unitId: "u-sum",
      unitType: "display",
      source: "unbound-paint"
    }),
    glyph("n", [360, 612, 368, 622], {
      id: "limit",
      font: "CMMI10",
      label: "formula",
      unitId: "u-sum",
      unitType: "display"
    })
  ];
  const marks = reviewMarkBoxes(elements);
  const braceMark = marks.find((mark) => mark.id === "brace");
  assert.equal(braceMark.paired, true);
  assert.equal(braceMark.inkId, "ink");
  assert.equal(marks.some((mark) => mark.id === "ink"), false);
  assert.deepEqual(braceMark.bbox.map((value) => Math.round(value * 100) / 100), [177.52, 155.66, 188.63, 191.91]);

  const inkHits = elements.filter((element) => dragSelectsElement(element.bbox, [178, 166, 183, 192])).map((element) => element.id);
  assert.equal(inkHits.includes("brace"), false);
  assert.deepEqual(expandPairIds(elements, inkHits).sort(), ["brace", "ink"]);
  assert.deepEqual(nextDragSelection(["x"], expandPairIds(elements, inkHits), { shift: true }).sort(), ["brace", "ink", "x"]);
  assert.deepEqual(nextDragSelection(["brace", "ink", "x"], expandPairIds(elements, ["ink"]), { alt: true }), ["x"]);
  assert.deepEqual(nextClickSelection([], expandPairIds(elements, ["brace"])).sort(), ["brace", "ink"]);
  assert.deepEqual(nextClickSelection(["brace", "ink", "x"], expandPairIds(elements, ["ink"]), { toggle: true }), ["x"]);

  const merged = applyMerge(elements, expandPairIds(elements, ["ink"]));
  assert.equal(merged.ok, true);
  const ink = elements.find((element) => element.id === "ink");
  const brace = elements.find((element) => element.id === "brace");
  assert.equal(ink.label, "formula");
  assert.equal(ink.unitId, brace.unitId);
  assert.equal(elements.length, 6);
  assert.notEqual(ink.id, brace.id);

  const sum = elements.find((element) => element.id === "sum");
  const sumInk = elements.find((element) => element.id === "sum-ink");
  const split = applySplit(elements, expandPairIds(elements, ["sum"]));
  assert.equal(split.ok, true);
  assert.equal(sum.unitId, sumInk.unitId);
  assert.equal(sum.unitType, "inline");
  assert.notEqual(sum.unitId, brace.unitId);
  const limit = elements.find((element) => element.id === "limit");
  assert.notEqual(limit.unitId, sum.unitId);
  const whole = [
    glyph("∑", [10, 10, 24, 20], { id: "whole-sum", font: "CMEX10", label: "formula", unitId: "u-whole", unitType: "display" }),
    glyph("", [11, 20, 23, 34], { id: "whole-ink", font: "", label: "formula", unitId: "u-whole", unitType: "display", source: "unbound-paint" }),
    glyph("k", [30, 12, 36, 20], { id: "whole-k", font: "CMMI10", label: "formula", unitId: "u-whole", unitType: "display" })
  ];
  const atomized = applySplit(whole, ["whole-sum", "whole-ink", "whole-k"]);
  assert.equal(atomized.ok, true);
  assert.equal(whole[0].unitId, whole[1].unitId);
  assert.notEqual(whole[0].unitId, whole[2].unitId);
  assert.equal(whole[0].unitType, "display");

  const numbered = [
    glyph("(", [20, 40, 28, 50], { id: "body", font: "CMR10", label: "formula", unitId: "u-num", unitType: "display" }),
    glyph("∑", [40, 30, 54, 40], { id: "op", font: "LMMathExtension10", label: "formula", unitId: "u-num", unitType: "display" }),
    glyph("", [42, 40, 52, 58], { id: "op-ink", font: "", label: "formula", unitId: "u-num", unitType: "display", source: "unbound-paint" })
  ];
  const eq = planEquationNumber(numbered, expandPairIds(numbered, ["op"]));
  assert.equal(eq.action, "toggle");
  assert.deepEqual(eq.ids.sort(), ["op", "op-ink"]);
  applyEquationNumber(numbered, eq.ids);
  assert.equal(numbered.find((element) => element.id === "op").equationNumber, true);
  assert.equal(numbered.find((element) => element.id === "op-ink").equationNumber, true);

  const looseInk = glyph("", [42, 40, 52, 58], { id: "loose", font: "", label: "text", source: "unbound-paint" });
  const op = glyph("∑", [40, 30, 54, 40], { id: "op2", font: "CMEX10", label: "formula", unitId: "u-op", unitType: "inline" });
  looseInk.label = "formula";
  looseInk.unitId = "tmp-loose";
  looseInk.unitType = "inline";
  looseInk.equationNumber = false;
  bindExtensionPairUnits([op, looseInk], ["loose"]);
  assert.equal(looseInk.unitId, "u-op");
  assert.equal(looseInk.unitType, "inline");

  const model = inspectorModel([brace, ink]);
  assert.equal(model.groups.flatMap((group) => group.rows).every((row) => row.paired), true);

  const review = readFileSync(new URL("../tools/label-review/review.js", import.meta.url), "utf8");
  assert.match(review, /reviewMarkBoxes\(/);
  assert.match(review, /expandPairIds\(/);
  assert.match(review, /selectionWithPairs\(/);
  assert.match(review, /bindExtensionPairUnits\(/);
  assert.match(review.slice(review.indexOf("function relabel"), review.indexOf("function setType")), /bindExtensionPairUnits\(/);
  assert.match(review.slice(review.indexOf("function setType"), review.indexOf("function merge")), /selectionWithPairs\(/);
  assert.match(review.slice(review.indexOf("async function confirmUnit")), /attachExtensionPairs\(/);
  assert.match(review, /成对/);
  const docs = readFileSync(new URL("../docs/v1-m1-labels.md", import.meta.url), "utf8");
  assert.match(docs, /复核工具现在把这一对画成一个框/);
});

test("confirm auto-includes the missing ink and keeps both elements", () => {
  const page = JSON.parse(readFileSync(new URL("../labels/prelabel/crmath-64/page-005.json", import.meta.url), "utf8"));
  page.reviewedUnitIds = ["ue00cad5ca361"];
  const glyphId = "e25ce4faa62374675";
  const inkId = "e0448a8642b781e0d";
  const before = page.elements.find((element) => element.id === inkId);
  const snapshot = {
    id: before.id,
    char: before.char,
    font: before.font,
    bbox: [...before.bbox],
    pathHash: before.pathHash
  };
  const members = page.elements.filter((element) => element.unitId === "ue00cad5ca361").map((element) => element.id);
  assert.equal(members.includes(inkId), false);
  const attached = attachExtensionPairs(page.elements, members);
  assert.equal(attached.changed, true);
  assert.equal(attached.blocked, false);
  const ink = page.elements.find((element) => element.id === inkId);
  const brace = page.elements.find((element) => element.id === glyphId);
  assert.equal(ink.label, "formula");
  assert.equal(ink.unitId, brace.unitId);
  assert.equal(ink.unitType, brace.unitType);
  assert.deepEqual({
    id: ink.id,
    char: ink.char,
    font: ink.font,
    bbox: ink.bbox,
    pathHash: ink.pathHash
  }, snapshot);
  assert.equal(page.elements.filter((element) => element.id === inkId).length, 1);
  assert.equal(page.elements.filter((element) => element.id === glyphId).length, 1);
  page.units = attached.units;
  assert.deepEqual(verifyPageLabels(page), []);
  assert.deepEqual(page.reviewedUnitIds, ["ue00cad5ca361"]);
  const again = attachExtensionPairs(page.elements, page.elements.filter((element) => element.unitId === brace.unitId).map((element) => element.id));
  assert.equal(again.changed, false);

  const orphan = [
    glyph("∑", [377.7, 610.7, 392.1, 620.6], { id: "sum", font: "CMEX10", label: "text" }),
    glyph("", [378.2, 620.6, 391.5, 634.6], { id: "paint", font: "", label: "text", source: "unbound-paint" })
  ];
  const refused = attachExtensionPairs(orphan, ["sum"]);
  assert.equal(refused.blocked, true);
  assert.equal(refused.message, PAIR_SPLIT_NOTICE);
  assert.equal(orphan[1].label, "text");
  assert.match(PAIR_SPLIT_NOTICE, /Enter/);
});
