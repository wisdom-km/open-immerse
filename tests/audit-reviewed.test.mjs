import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  auditReviewed,
  formulaProseWords,
  renderMarkdown,
  selectAuditWindow
} from "../scripts/audit-reviewed.mjs";

function glyph(id, char, bbox, extra = {}) {
  return {
    id,
    kind: extra.kind || "glyph",
    char,
    font: extra.font || "CMR10",
    bbox,
    label: extra.label || "text",
    unitId: extra.unitId ?? null,
    unitType: extra.unitType ?? null,
    equationNumber: false
  };
}

function formula(id, char, bbox, unitId, extra = {}) {
  return glyph(id, char, bbox, { ...extra, label: "formula", unitId, unitType: extra.unitType || "display" });
}

function pageOf(elements, units, extra = {}) {
  return { schema: "open-immerse.labels/v1", page: extra.page || 2, elements, units, reviewedUnitIds: extra.reviewedUnitIds || [] };
}

function entry(unitId, elementIds, extra = {}) {
  return {
    paperId: extra.paperId || "paper",
    page: extra.page || 2,
    unitId,
    elementIds,
    type: extra.type || "display",
    equationNumber: false
  };
}

function run(queue, page, { confirmed = true, limit } = {}) {
  const keys = confirmed ? queue.map((unit) => `${unit.paperId}:${unit.page}:${unit.unitId}`) : [];
  return auditReviewed({
    queue,
    confirmedKeys: keys,
    limit,
    loadPage: () => page
  });
}

function rules(report) {
  return report.findings.map((item) => item.rule);
}

test("the default window stops at the last confirmed queue unit", () => {
  const queue = [0, 1, 2, 3].map((index) => entry(`u${index}`, [`e${index}`], { page: 1 }));
  const confirmed = new Set(["paper:1:u0", "paper:1:u2"]);
  assert.deepEqual(selectAuditWindow(queue, confirmed).map((item) => item.queueIndex), [1, 2, 3]);
  assert.deepEqual(selectAuditWindow(queue, confirmed).map((item) => item.confirmed), [true, false, true]);
  assert.equal(selectAuditWindow(queue, new Set()).length, 0);
  assert.deepEqual(selectAuditWindow(queue, confirmed, 1).map((item) => item.queueIndex), [1]);
});

test("R0 lists skipped units and ignores confirmed ones", () => {
  const elements = [formula("e1", "x", [0, 0, 10, 10], "u1")];
  const units = [{ id: "u1", type: "display", equationNumber: false, elementIds: ["e1"] }];
  const queue = [entry("u1", ["e1"])];
  const skipped = run(queue, pageOf(elements, units), { confirmed: false, limit: 1 });
  assert.equal(rules(skipped).includes("R0"), true);
  const kept = run(queue, pageOf(elements, units), { confirmed: true });
  assert.equal(rules(kept).includes("R0"), false);
});

test("R1 flags body-font prose inside a formula and keeps subscripts, operators, and italic products", () => {
  const prose = formula("prose", "∆) is not possible in practice", [0, 100, 80, 110], "u1");
  const host = formula("host", "x", [90, 100, 100, 110], "u1");
  const hit = run([entry("u1", ["prose", "host"])], pageOf([prose, host], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: ["prose", "host"]
  }]));
  assert.equal(hit.findings.some((item) => item.rule === "R1" && item.elements.some((element) => element.id === "prose")), true);
  assert.equal(formulaProseWords(prose, [prose, host]).includes("possible"), true);

  const sites = formula("sites", "sites", [0, 108, 20, 113], "u2", { font: "AdvOT1ef757c0" });
  const op = formula("op", "∏", [0, 100, 12, 112], "u2", { font: "AdvMacMthSyN" });
  const letter = formula("a", "a", [24, 100, 32, 110], "u2", { font: "CMR10" });
  const subPage = pageOf([sites, op, letter], [{ id: "u2", type: "display", equationNumber: false, elementIds: ["sites", "op", "a"] }]);
  const sub = run([entry("u2", ["sites", "op", "a"])], subPage);
  assert.equal(sub.findings.some((item) => item.rule === "R1" && item.elements.some((element) => element.id === "sites")), false);

  const traced = formula("tr", "Tr", [0, 100, 12, 110], "u3");
  const ia = formula("ia", "ia", [20, 100, 32, 110], "u3", { font: "AdvOT7d6df7ab.I" });
  const junk = formula("junk", "fflffl", [40, 100, 52, 110], "u3", { font: "AdvP4C4E46" });
  const clean = run([entry("u3", ["tr", "ia", "junk"])], pageOf([traced, ia, junk], [{
    id: "u3", type: "inline", equationNumber: false, elementIds: ["tr", "ia", "junk"]
  }]));
  assert.equal(clean.findings.some((item) => item.rule === "R1"), false);
});

test("R2 flags a display unit across two baselines and ignores fractions, subscripts, and tall braces", () => {
  const line = (y, ids, unitId) => ids.map((id, index) => formula(id, id, [index * 14, y, index * 14 + 10, y + 10], unitId));
  const split = [...line(100, ["a", "b", "c"], "u1"), ...line(140, ["d", "e", "f"], "u1")];
  const hit = run([entry("u1", split.map((element) => element.id))], pageOf(split, [{
    id: "u1", type: "display", equationNumber: false, elementIds: split.map((element) => element.id)
  }]));
  assert.equal(rules(hit).includes("R2"), true);

  const num = line(100, ["n1", "n2", "n3"], "u2");
  const den = line(128, ["d1", "d2", "d3"], "u2");
  const bar = glyph("bar", "", [0, 118, 40, 118.4], { kind: "path", label: "other", unitId: "u2", unitType: "display" });
  const fraction = [...num, bar, ...den];
  const fractionReport = run([entry("u2", fraction.map((element) => element.id))], pageOf(fraction, [{
    id: "u2", type: "display", equationNumber: false, elementIds: fraction.map((element) => element.id)
  }]));
  assert.equal(rules(fractionReport).includes("R2"), false);

  const base = line(100, ["p", "q", "r"], "u3");
  const sub = formula("sub", "i", [2, 108, 8, 114], "u3");
  const lowered = [...base, sub];
  const loweredReport = run([entry("u3", lowered.map((element) => element.id))], pageOf(lowered, [{
    id: "u3", type: "display", equationNumber: false, elementIds: lowered.map((element) => element.id)
  }]));
  assert.equal(rules(loweredReport).includes("R2"), false);

  const upper = line(100, ["u", "v", "w"], "u4");
  const brace = formula("brace", "{", [40, 100, 46, 150], "u4", { font: "CMEX10" });
  const lower = line(140, ["x", "y", "z"], "u4");
  const braced = [...upper, brace, ...lower];
  const bracedReport = run([entry("u4", braced.map((element) => element.id))], pageOf(braced, [{
    id: "u4", type: "display", equationNumber: false, elementIds: braced.map((element) => element.id)
  }]));
  assert.equal(rules(bracedReport).includes("R2"), false);

  const lonely = [...line(100, ["m1", "m2", "m3"], "u5"), formula("one", "t", [0, 140, 8, 150], "u5")];
  const lonelyReport = run([entry("u5", lonely.map((element) => element.id))], pageOf(lonely, [{
    id: "u5", type: "display", equationNumber: false, elementIds: lonely.map((element) => element.id)
  }]));
  assert.equal(rules(lonelyReport).includes("R2"), false);
});

test("R3 flags a right-hand equation number outside the display unit", () => {
  const body = ["a", "b", "c"].map((id, index) => formula(id, id, [index * 14, 100, index * 14 + 10, 110], "u1"));
  const number = glyph("n", "(12)", [200, 100, 220, 110]);
  const hit = run([entry("u1", body.map((element) => element.id))], pageOf([...body, number], [{
    id: "u1", type: "display", equationNumber: false, elementIds: body.map((element) => element.id)
  }]));
  assert.equal(hit.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "(12)")), true);

  const keptNumber = formula("n2", "(2.5)", [200, 100, 224, 110], "u2");
  const keptBody = ["d", "e"].map((id, index) => formula(id, id, [index * 14, 100, index * 14 + 10, 110], "u2"));
  const kept = [...keptBody, keptNumber];
  const miss = run([entry("u2", kept.map((element) => element.id))], pageOf(kept, [{
    id: "u2", type: "display", equationNumber: true, elementIds: kept.map((element) => element.id)
  }]));
  assert.equal(rules(miss).includes("R3"), false);

  const buried = formula("n3", "(49a)", [20, 100, 40, 110], "u3");
  const after = formula("z", "z", [80, 100, 90, 110], "u3");
  const notRight = [buried, after];
  const notRightReport = run([entry("u3", notRight.map((element) => element.id))], pageOf(notRight, [{
    id: "u3", type: "display", equationNumber: false, elementIds: notRight.map((element) => element.id)
  }]));
  assert.equal(rules(notRightReport).includes("R3"), false);
});

test("R4 flags body-font measures and page-1 author marks", () => {
  const measure = [glyph("n", "50", [0, 0, 16, 10], { label: "formula", unitId: "u1", unitType: "inline" }), glyph("u", "μm", [16, 0, 32, 10], { label: "formula", unitId: "u1", unitType: "inline" })];
  const hit = run([entry("u1", ["n", "u"], { type: "inline" })], pageOf(measure, [{
    id: "u1", type: "inline", equationNumber: false, elementIds: ["n", "u"]
  }]));
  assert.equal(rules(hit).includes("R4"), true);

  const author = [
    glyph("name", "Qi", [0, 0, 16, 10], { label: "formula", unitId: "u2", unitType: "inline" }),
    glyph("mark", "1", [16, 4, 20, 8], { label: "formula", unitId: "u2", unitType: "inline" })
  ];
  const authorHit = run([entry("u2", ["name", "mark"], { page: 1, type: "inline" })], pageOf(author, [{
    id: "u2", type: "inline", equationNumber: false, elementIds: ["name", "mark"]
  }], { page: 1 }));
  assert.equal(rules(authorHit).includes("R4"), true);

  const math = [formula("x", "x", [0, 0, 8, 10], "u3", { font: "AdvOT7d6df7ab.I", unitType: "inline" }), formula("y", "=", [10, 0, 18, 10], "u3", { unitType: "inline" })];
  const miss = run([entry("u3", ["x", "y"], { type: "inline" })], pageOf(math, [{
    id: "u3", type: "inline", equationNumber: false, elementIds: ["x", "y"]
  }]));
  assert.equal(rules(miss).includes("R4"), false);

  const later = run([entry("u2", ["name", "mark"], { page: 3, type: "inline" })], pageOf(author, [{
    id: "u2", type: "inline", equationNumber: false, elementIds: ["name", "mark"]
  }], { page: 3 }));
  assert.equal(rules(later).includes("R4"), false);
});

test("R5 flags a touching symbol and two formula units split by an operator", () => {
  const eq = [formula("a", "ϕ", [0, 100, 10, 110], "u1", { font: "AdvMacMthSyN", unitType: "inline" }), formula("b", "(", [10, 100, 16, 110], "u1", { unitType: "inline" })];
  const loose = glyph("x", "x", [17, 100, 24, 110], { font: "AdvOT7d6df7ab.I" });
  const hit = run([entry("u1", ["a", "b"], { type: "inline" })], pageOf([...eq, loose], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: ["a", "b"]
  }]));
  assert.equal(hit.findings.some((item) => item.rule === "R5" && item.elements.some((element) => element.id === "x")), true);

  const prose = glyph("where", "where", [40, 100, 70, 110]);
  const proseReport = run([entry("u1", ["a", "b"], { type: "inline" })], pageOf([...eq, prose], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: ["a", "b"]
  }]));
  assert.equal(proseReport.findings.some((item) => item.rule === "R5" && item.elements.some((element) => element.char === "where")), false);

  const left = formula("L", "H", [0, 200, 12, 210], "u2", { unitType: "inline" });
  const right = formula("R", "vac", [28, 200, 48, 210], "u3", { font: "AdvOT7d6df7ab.I", unitType: "inline" });
  const between = glyph("eq", "=", [16, 200, 24, 210]);
  const pair = run(
    [entry("u2", ["L"], { type: "inline" }), entry("u3", ["R"], { type: "inline" })],
    pageOf([left, between, right], [
      { id: "u2", type: "inline", equationNumber: false, elementIds: ["L"] },
      { id: "u3", type: "inline", equationNumber: false, elementIds: ["R"] }
    ])
  );
  assert.equal(pair.findings.some((item) => item.rule === "R5" && item.suggestion.includes("两个公式")), true);

  const word = glyph("and", "and", [16, 200, 32, 210]);
  const apart = run(
    [entry("u2", ["L"], { type: "inline" }), entry("u3", ["R"], { type: "inline" })],
    pageOf([left, word, right], [
      { id: "u2", type: "inline", equationNumber: false, elementIds: ["L"] },
      { id: "u3", type: "inline", equationNumber: false, elementIds: ["R"] }
    ])
  );
  assert.equal(apart.findings.some((item) => item.rule === "R5" && item.suggestion.includes("两个公式")), false);
});

test("R6 flags an inline formula alone on a line and a display formula inside a sentence", () => {
  const alone = ["a", "b", "c"].map((id, index) => formula(id, "x", [index * 12, 100, index * 12 + 8, 110], "u1", { unitType: "inline" }));
  const hit = run([entry("u1", alone.map((element) => element.id), { type: "inline" })], pageOf(alone, [{
    id: "u1", type: "inline", equationNumber: false, elementIds: alone.map((element) => element.id)
  }]));
  assert.equal(hit.findings.some((item) => item.rule === "R6" && item.suggestion.includes("行间")), true);

  const withText = [...alone, glyph("sent", "where", [40, 100, 70, 110])];
  const miss = run([entry("u1", alone.map((element) => element.id), { type: "inline" })], pageOf(withText, [{
    id: "u1", type: "inline", equationNumber: false, elementIds: alone.map((element) => element.id)
  }]));
  assert.equal(miss.findings.some((item) => item.rule === "R6" && item.suggestion.includes("独占")), false);

  const middle = formula("m", "x", [40, 200, 48, 210], "u2", { unitType: "display" });
  const sentence = [glyph("left", "For", [0, 200, 20, 210]), middle, glyph("right", "holds", [60, 200, 90, 210])];
  const displayHit = run([entry("u2", ["m"])], pageOf(sentence, [{
    id: "u2", type: "display", equationNumber: false, elementIds: ["m"]
  }]));
  assert.equal(displayHit.findings.some((item) => item.rule === "R6" && item.suggestion.includes("行内")), true);

  const start = [glyph("only", "For", [0, 300, 20, 310]), formula("d", "x", [24, 300, 40, 310], "u3")];
  const oneSide = run([entry("u3", ["d"])], pageOf(start, [{
    id: "u3", type: "display", equationNumber: false, elementIds: ["d"]
  }]));
  assert.equal(oneSide.findings.some((item) => item.rule === "R6"), false);
});

test("R7 flags an inline trailing comma and a display comma left outside", () => {
  const body = formula("x", "x", [0, 100, 10, 110], "u1", { unitType: "inline" });
  const comma = formula("c", ",", [12, 100, 16, 110], "u1", { unitType: "inline" });
  const hit = run([entry("u1", ["x", "c"], { type: "inline" })], pageOf([body, comma], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: ["x", "c"]
  }]));
  assert.equal(hit.findings.some((item) => item.rule === "R7" && item.elements.some((element) => element.char === ",")), true);

  const glued = formula("g", "0,", [12, 100, 24, 110], "u2", { unitType: "inline" });
  const miss = run([entry("u2", ["x", "g"], { type: "inline" })], pageOf([
    formula("x2", "x", [0, 100, 10, 110], "u2", { unitType: "inline" }),
    glued
  ], [{ id: "u2", type: "inline", equationNumber: false, elementIds: ["x2", "g"] }]));
  assert.equal(rules(miss).includes("R7"), false);

  const display = formula("y", "y", [0, 200, 20, 210], "u3");
  const outside = glyph("dot", ".", [22, 200, 26, 210]);
  const displayHit = run([entry("u3", ["y"])], pageOf([display, outside], [{
    id: "u3", type: "display", equationNumber: false, elementIds: ["y"]
  }]));
  assert.equal(displayHit.findings.some((item) => item.rule === "R7" && item.suggestion.includes("行间")), true);

  const inside = formula("dot2", ".", [22, 200, 26, 210], "u4");
  const kept = run([entry("u4", ["y2", "dot2"])], pageOf([
    formula("y2", "y", [0, 200, 20, 210], "u4"),
    inside
  ], [{ id: "u4", type: "display", equationNumber: false, elementIds: ["y2", "dot2"] }]));
  assert.equal(rules(kept).includes("R7"), false);
});

test("R8 flags a formula without a unit and a unit id that points nowhere", () => {
  const orphan = glyph("lone", "x", [0, 0, 10, 10], { label: "formula" });
  const real = formula("ok", "y", [20, 0, 30, 10], "u1");
  const hit = run([entry("u1", ["ok", "lone"])], pageOf([orphan, real], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: ["ok", "missing"]
  }]));
  assert.equal(hit.findings.filter((item) => item.rule === "R8").length >= 2, true);

  const sound = run([entry("u1", ["ok"])], pageOf([real], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: ["ok"]
  }]));
  assert.equal(rules(sound).includes("R8"), false);
});

test("the markdown report names the queue index, unit ids, and element", () => {
  const prose = formula("prose", "is not possible", [0, 0, 40, 10], "u1", { unitType: "inline" });
  const report = run([entry("u1", ["prose"], { type: "inline" })], pageOf([prose], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: ["prose"]
  }]));
  const markdown = renderMarkdown(report);
  assert.match(markdown, /队列 1/);
  assert.match(markdown, /u1/);
  assert.match(markdown, /prose/);
  assert.match(markdown, /is not possible/);
  assert.equal(report.findings[0].severity <= report.findings.at(-1).severity, true);
});

test("auditing prelabel pages as the reviewed draft does not throw", () => {
  const reviewSet = JSON.parse(readFileSync(new URL("../labels/review-set.json", import.meta.url), "utf8"));
  const queue = reviewSet.units.slice(0, 20);
  const cache = new Map();
  const report = auditReviewed({
    queue,
    confirmedKeys: queue.map((unit) => `${unit.paperId}:${unit.page}:${unit.unitId}`),
    limit: 20,
    loadPage(paperId, page) {
      const key = `${paperId}:${page}`;
      if (!cache.has(key)) {
        const file = new URL(`../labels/prelabel/${paperId}/page-${String(page).padStart(3, "0")}.json`, import.meta.url);
        cache.set(key, JSON.parse(readFileSync(file, "utf8")));
      }
      return cache.get(key);
    }
  });
  assert.equal(report.window.size, 20);
  assert.equal(Array.isArray(report.findings), true);
  for (const item of report.findings) {
    assert.equal(typeof item.queueIndex, "number");
    assert.equal(typeof item.rule, "string");
    assert.equal(typeof item.suggestion, "string");
    assert.equal(Array.isArray(item.elements), true);
  }
  const docs = readFileSync(new URL("../docs/v1-m1-labels.md", import.meta.url), "utf8");
  assert.match(docs, /## 复核审计/);
  assert.match(docs, /node scripts\/audit-reviewed\.mjs/);
});
