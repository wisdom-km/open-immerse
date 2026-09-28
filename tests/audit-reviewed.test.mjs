import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  auditReviewed,
  formulaProseWords,
  parseAuditArgs,
  renderMarkdown,
  selectAuditWindow,
  summarizeByQueueIndex
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
    equationNumber: extra.equationNumber === true
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

  const symbol = formula("svx", "SVX", [0, 100, 24, 110], "u4", { font: "MinionPro-It" });
  const ky = formula("ky", "Ky", [30, 100, 42, 110], "u4", { font: "AdvOTb65e897d.B" });
  const rise = formula("rise", "rise,", [48, 104, 70, 109], "u4", { font: "AdvTT7d4973e5.I" });
  const decay = formula("decay", "decay", [72, 104, 96, 109], "u4", { font: "AdvTT7d4973e5.I" });
  const qualifier = formula("ae", "-a.e. on", [0, 200, 40, 210], "u5");
  const et = formula("et", "et", [0, 300, 12, 310], "u6", { unitType: "inline" });
  const keptWords = run(
    [entry("u4", ["svx", "ky", "rise", "decay"]), entry("u5", ["ae"]), entry("u6", ["et"], { type: "inline" })],
    pageOf(
      [symbol, ky, rise, decay, qualifier, et],
      [
        { id: "u4", type: "display", equationNumber: false, elementIds: ["svx", "ky", "rise", "decay"] },
        { id: "u5", type: "display", equationNumber: false, elementIds: ["ae"] },
        { id: "u6", type: "inline", equationNumber: false, elementIds: ["et"] }
      ]
    )
  );
  assert.equal(keptWords.findings.some((item) => item.rule === "R1"), false);
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

  const neighbor = glyph("far", "(12)", [200, 107, 220, 117]);
  const neighborReport = run([entry("u1", body.map((element) => element.id))], pageOf([...body, neighbor], [{
    id: "u1", type: "display", equationNumber: false, elementIds: body.map((element) => element.id)
  }]));
  assert.equal(neighborReport.findings.some((item) => item.rule === "R3"), false);

  const raised = glyph("sup", "2", [200, 100, 206, 104]);
  const raisedReport = run([entry("u1", body.map((element) => element.id))], pageOf([...body, raised], [{
    id: "u1", type: "display", equationNumber: false, elementIds: body.map((element) => element.id)
  }]));
  assert.equal(raisedReport.findings.some((item) => item.rule === "R3"), false);

  const stub = [formula("stub", "x", [0, 100, 8, 110], "u8")];
  const margin = glyph("margin", "(43)", [16, 100, 32, 110]);
  const prose = glyph("sentence", "This sentence is ordinary prose", [120, 400, 280, 410]);
  const marginReport = run([entry("u8", ["stub"])], pageOf([...stub, margin, prose], [{
    id: "u8", type: "display", equationNumber: false, elementIds: ["stub"]
  }]));
  assert.equal(marginReport.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "(43)")), false);

  const middle = ["m1", "m2"].map((id, index) => formula(id, id, [index * 14, 160, index * 14 + 10, 170], "u9"));
  const middleNumber = formula("mid", "(57)", [200, 160, 224, 170], "u9");
  const aligned = run([entry("u9", [...middle, middleNumber].map((element) => element.id))], pageOf([...middle, middleNumber], [{
    id: "u9", type: "display", equationNumber: true, elementIds: [...middle, middleNumber].map((element) => element.id)
  }]));
  assert.equal(aligned.findings.some((item) => item.rule === "R3"), false);

  const upper = ["p", "q"].map((id, index) => formula(id, id, [index * 14, 100, index * 14 + 10, 110], "u1"));
  const bridge = glyph("bridge", "x", [40, 106, 50, 116]);
  const lower = formula("low", "y", [0, 128, 10, 138], "uLow");
  const bare = glyph("n56", "56", [188, 128, 204, 138]);
  const otherNumber = formula("other", "(2)", [200, 40, 220, 50], "uOther");
  const split = run([entry("u1", upper.map((element) => element.id))], pageOf(
    [...upper, bridge, lower, bare, otherNumber],
    [
      { id: "u1", type: "display", equationNumber: false, elementIds: upper.map((element) => element.id) },
      { id: "uLow", type: "inline", equationNumber: false, elementIds: ["low"] },
      { id: "uOther", type: "inline", equationNumber: true, elementIds: ["other"] }
    ]
  ));
  assert.equal(split.findings.some((item) => item.rule === "R3"), false);

  const open = glyph("po", "(", [180, 100, 186, 110]);
  const bareSame = glyph("n57", "57", [188, 100, 202, 110]);
  const close = glyph("pc", ")", [204, 100, 210, 110]);
  const sameLine = run([entry("u1", upper.map((element) => element.id))], pageOf([...upper, open, bareSame, close], [{
    id: "u1", type: "display", equationNumber: false, elementIds: upper.map((element) => element.id)
  }]));
  assert.equal(sameLine.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "57")), true);

  const leftBody = ["l1", "l2", "l3"].map((id, index) => formula(id, id, [20 + index * 16, 100, 32 + index * 16, 110], "uLeft"));
  const leftNumber = [
    formula("lpar", "(", [150, 100, 156, 110], "uLeft"),
    formula("l50", "50", [158, 100, 170, 110], "uLeft"),
    formula("rpar", ")", [172, 100, 178, 110], "uLeft")
  ];
  const rightBody = ["r1", "r2", "r3"].map((id, index) => formula(id, id, [340 + index * 16, 100, 352 + index * 16, 110], "uRight"));
  const rightNumber = [
    glyph("rp1", "(", [470, 100, 476, 110]),
    glyph("n57", "57", [478, 100, 490, 110]),
    glyph("rp2", ")", [492, 100, 498, 110])
  ];
  const columnProse = [];
  for (let index = 0; index < 8; index += 1) {
    columnProse.push(glyph(`left-prose-${index}`, "the left column continues with ordinary prose", [40, 20 + index * 24, 220, 30 + index * 24]));
    columnProse.push(glyph(`right-prose-${index}`, "the right column continues with ordinary prose", [320, 20 + index * 24, 520, 30 + index * 24]));
  }
  const twoColumn = run(
    [entry("uLeft", [...leftBody, ...leftNumber].map((element) => element.id))],
    pageOf([...columnProse, ...leftBody, ...leftNumber, ...rightBody, ...rightNumber], [
      { id: "uLeft", type: "display", equationNumber: true, elementIds: [...leftBody, ...leftNumber].map((element) => element.id) },
      { id: "uRight", type: "display", equationNumber: false, elementIds: rightBody.map((element) => element.id) }
    ])
  );
  assert.equal(twoColumn.findings.some((item) => item.rule === "R3"), false);

  const leftWithoutNumber = run(
    [entry("uLeft", leftBody.map((element) => element.id))],
    pageOf([...columnProse, ...leftBody, ...rightBody, ...rightNumber], [
      { id: "uLeft", type: "display", equationNumber: false, elementIds: leftBody.map((element) => element.id) },
      { id: "uRight", type: "display", equationNumber: false, elementIds: rightBody.map((element) => element.id) }
    ])
  );
  assert.equal(leftWithoutNumber.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "57")), false);

  const alreadyNumbered = run(
    [entry("uLeft", [...leftBody, ...leftNumber].map((element) => element.id))],
    pageOf([...leftBody, ...leftNumber, glyph("far57", "(57)", [360, 100, 384, 110])], [{
      id: "uLeft", type: "display", equationNumber: true, elementIds: [...leftBody, ...leftNumber].map((element) => element.id)
    }])
  );
  assert.equal(alreadyNumbered.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "(57)")), true);
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

  const glued = [
    glyph("donc", ") . D'où", [18, 100, 50, 110]),
    glyph("eq0", "= 0,", [18, 120, 40, 130]),
    glyph("adapt", "ADAPT(", [18, 140, 48, 150], { font: "AdvOTcb88df00" }),
    glyph("sec", "3.2.2", [18, 160, 40, 170])
  ];
  const hosts = glued.map((element, index) => formula(`h${index}`, "x", [0, 100 + index * 20, 16, 110 + index * 20], "u9", { unitType: "inline" }));
  const glueReport = run([entry("u9", hosts.map((element) => element.id), { type: "inline" })], pageOf([...hosts, ...glued], [{
    id: "u9", type: "inline", equationNumber: false, elementIds: hosts.map((element) => element.id)
  }]));
  assert.equal(glueReport.findings.some((item) => item.rule === "R5"), false);
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
  assert.equal(displayHit.findings.some((item) => item.rule === "R7"), false);

  const abbrev = formula("iid", "i.i.d", [0, 300, 24, 310], "u5", { unitType: "inline" });
  const abbrevDot = formula("iid-dot", ".", [24, 300, 28, 310], "u5", { unitType: "inline" });
  const abbrevReport = run([entry("u5", ["iid", "iid-dot"], { type: "inline" })], pageOf([abbrev, abbrevDot], [{
    id: "u5", type: "inline", equationNumber: false, elementIds: ["iid", "iid-dot"]
  }]));
  assert.equal(abbrevReport.findings.some((item) => item.rule === "R7"), false);

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

test("R9 flags a unit whose glyphs are all marked as the equation number", () => {
  const body = ["P", "a", "=", "1"].map((char, index) => formula(`g${index}`, char, [index * 12, 100, index * 12 + 10, 110], "u1", { equationNumber: true }));
  const hit = run([entry("u1", body.map((element) => element.id))], pageOf(body, [{
    id: "u1", type: "display", equationNumber: true, elementIds: body.map((element) => element.id)
  }]));
  assert.equal(hit.findings.some((item) => item.rule === "R9" && item.suggestion.includes("按 e")), true);

  const kept = ["x", "y"].map((char, index) => formula(char, char, [index * 14, 100, index * 14 + 10, 110], "u2"));
  const number = [
    formula("lp", "(", [80, 100, 86, 110], "u2"),
    formula("n", "50", [88, 100, 100, 110], "u2", { equationNumber: true }),
    formula("rp", ")", [102, 100, 108, 110], "u2")
  ];
  const miss = run([entry("u2", [...kept, ...number].map((element) => element.id))], pageOf([...kept, ...number], [{
    id: "u2", type: "display", equationNumber: true, elementIds: [...kept, ...number].map((element) => element.id)
  }]));
  assert.equal(miss.findings.some((item) => item.rule === "R9"), false);
});

test("R3 reports a line-end number in another unit or an inline unit, and only notes a display flag", () => {
  const body = ["a", "b"].map((id, index) => formula(id, id, [index * 14, 100, index * 14 + 10, 110], "u1"));
  const foreign = formula("num", "(2.8)", [80, 100, 110, 110], "u2");
  const elsewhere = run([entry("u1", body.map((element) => element.id))], pageOf([...body, foreign], [
    { id: "u1", type: "display", equationNumber: false, elementIds: body.map((element) => element.id) },
    { id: "u2", type: "display", equationNumber: true, elementIds: ["num"] }
  ]));
  assert.equal(elsewhere.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "(2.8)")), true);

  const inlineBody = ["c", "d"].map((id, index) => formula(id, id, [index * 14, 140, index * 14 + 10, 150], "u3", { unitType: "inline" }));
  const inlineNumber = formula("n3", "(4)", [80, 140, 100, 150], "u3", { unitType: "inline" });
  const inline = run([entry("u3", [...inlineBody, inlineNumber].map((element) => element.id), { type: "inline" })], pageOf([...inlineBody, inlineNumber], [{
    id: "u3", type: "inline", equationNumber: false, elementIds: [...inlineBody, inlineNumber].map((element) => element.id)
  }]));
  assert.equal(inline.findings.some((item) => item.rule === "R3" && item.suggestion.includes("按 d")), true);

  const quiet = ["e", "f"].map((id, index) => formula(id, id, [index * 14, 180, index * 14 + 10, 190], "u4"));
  const quietNumber = formula("n4", "(9)", [80, 180, 100, 190], "u4");
  const noted = run([entry("u4", [...quiet, quietNumber].map((element) => element.id))], pageOf([...quiet, quietNumber], [{
    id: "u4", type: "display", equationNumber: false, elementIds: [...quiet, quietNumber].map((element) => element.id)
  }]));
  assert.equal(noted.findings.some((item) => item.rule === "R3"), false);
  assert.equal(noted.info.R3 >= 1, true);
});

test("R6 flags an inline unit that owns a line-end number even when words share the baseline", () => {
  const body = ["a", "b", "c"].map((id, index) => formula(id, id, [20 + index * 14, 100, 30 + index * 14, 110], "u1", { unitType: "inline" }));
  const number = [
    formula("lp", "(", [80, 100, 86, 110], "u1", { unitType: "inline" }),
    formula("n", "2", [88, 100, 96, 110], "u1", { unitType: "inline" }),
    formula("rp", ")", [98, 100, 104, 110], "u1", { unitType: "inline" })
  ];
  const prose = glyph("words", "where all", [120, 100, 180, 110]);
  const hit = run([entry("u1", [...body, ...number].map((element) => element.id), { type: "inline" })], pageOf([...body, ...number, prose], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: [...body, ...number].map((element) => element.id)
  }]));
  assert.equal(hit.findings.some((item) => item.rule === "R6" && item.suggestion.includes("按 d")), true);
});

test("R3 keeps a gutter number with the left column when the other column shares the baseline", () => {
  const body = ["a", "b", "c"].map((id, index) => formula(id, id, [40 + index * 14, 200, 50 + index * 14, 210], "u1", { unitType: "inline" }));
  const number = [
    glyph("eth", "ð", [230, 200, 236, 210], { font: "TeX_CM_Maths_Symbols" }),
    glyph("two", "2", [238, 200, 246, 210], { font: "MinionPro-Regular" }),
    glyph("thorn", "Þ", [248, 200, 254, 210], { font: "TeX_CM_Maths_Symbols" })
  ];
  const prose = [];
  for (let index = 0; index < 8; index += 1) {
    prose.push(glyph(`lp${index}`, "left column sentence about the method", [40, 20 + index * 22, 200, 30 + index * 22]));
    prose.push(glyph(`rp${index}`, "right column sentence about the method", [300, 20 + index * 22, 500, 30 + index * 22]));
  }
  prose.push(glyph("share", "solution could be obtained by going", [300, 200, 520, 210]));
  const far = glyph("far", "(99)", [470, 200, 498, 210]);
  const hit = run([entry("u1", body.map((element) => element.id), { type: "inline" })], pageOf([...prose, ...body, ...number, far], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: body.map((element) => element.id)
  }]));
  assert.equal(hit.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "2")), true);
  assert.equal(hit.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "(99)")), false);
  assert.equal(hit.findings.some((item) => item.rule === "R6" && item.suggestion.includes("按 d")), true);
});

test("R3 reads a ð number Þ inside an inline unit", () => {
  const body = ["a", "b"].map((id, index) => formula(id, id, [40 + index * 14, 100, 50 + index * 14, 110], "u1", { unitType: "inline" }));
  const number = [
    formula("eth", "ð", [200, 100, 206, 110], "u1", { font: "TeX_CM_Maths_Symbols", unitType: "inline" }),
    formula("n", "17", [208, 100, 222, 110], "u1", { font: "MinionPro-Regular", unitType: "inline" }),
    formula("thorn", "Þ", [224, 100, 230, 110], "u1", { font: "TeX_CM_Maths_Symbols", unitType: "inline" })
  ];
  const hit = run([entry("u1", [...body, ...number].map((element) => element.id), { type: "inline" })], pageOf([...body, ...number], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: [...body, ...number].map((element) => element.id)
  }]));
  assert.equal(hit.findings.some((item) => item.rule === "R3" && item.suggestion.includes("按 d")), true);
  assert.equal(hit.findings.some((item) => item.rule === "R6" && item.suggestion.includes("按 d")), true);

  const tall = formula("tall", "(", [20, 90, 28, 120], "u9", { font: "AdvP4C4E74", unitType: "inline" });
  const letter = formula("a", "a", [32, 100, 42, 110], "u9", { unitType: "inline" });
  const beside = [
    formula("eth2", "ð", [180, 100, 186, 110], "u9", { font: "AdvP4C4E74", unitType: "inline" }),
    formula("n35", "35", [188, 100, 200, 110], "u9", { unitType: "inline" }),
    formula("thorn2", "Þ", [202, 100, 208, 110], "u9", { font: "AdvP4C4E74", unitType: "inline" })
  ];
  const withTall = run([entry("u9", [tall, letter, ...beside].map((element) => element.id), { type: "inline" })], pageOf([tall, letter, ...beside], [{
    id: "u9", type: "inline", equationNumber: false, elementIds: [tall, letter, ...beside].map((element) => element.id)
  }]));
  assert.equal(withTall.findings.some((item) => item.rule === "R6" && item.suggestion.includes("按 d")), true);
});

test("R10 flags a second formula on a prose-free line and ignores a line with words", () => {
  const left = ["A", "="].map((char, index) => formula(`L${index}`, char, [20 + index * 16, 100, 32 + index * 16, 110], "u1"));
  const right = ["B", "="].map((char, index) => formula(`R${index}`, char, [60 + index * 16, 100, 72 + index * 16, 110], "u2"));
  const hit = run([entry("u1", left.map((element) => element.id))], pageOf([...left, ...right], [
    { id: "u1", type: "display", equationNumber: false, elementIds: left.map((element) => element.id) },
    { id: "u2", type: "display", equationNumber: false, elementIds: right.map((element) => element.id) }
  ]));
  assert.equal(hit.findings.some((item) => item.rule === "R10" && item.suggestion.includes("按 m")), true);

  const word = glyph("and", "and", [70, 140, 90, 150]);
  const apartLeft = left.map((element) => ({ ...element, id: `w${element.id}`, bbox: [element.bbox[0], 140, element.bbox[2], 150] }));
  const apartRight = right.map((element) => ({ ...element, id: `w${element.id}`, unitId: "u4", bbox: [element.bbox[0], 140, element.bbox[2], 150] }));
  const miss = run([entry("u3", apartLeft.map((element) => element.id))], pageOf([...apartLeft, word, ...apartRight], [
    { id: "u3", type: "display", equationNumber: false, elementIds: apartLeft.map((element) => element.id) },
    { id: "u4", type: "display", equationNumber: false, elementIds: apartRight.map((element) => element.id) }
  ]));
  assert.equal(miss.findings.some((item) => item.rule === "R10"), false);

  const half = ["W", "="].map((char, index) => formula(`h${index}`, char, [20 + index * 16, 220, 32 + index * 16, 230], "u4"));
  const otherHalf = ["W", "x"].map((char, index) => formula(`o${index}`, char, [140 + index * 16, 220, 152 + index * 16, 230], "u5"));
  const wide = run([entry("u4", half.map((element) => element.id))], pageOf([...half, ...otherHalf], [
    { id: "u4", type: "display", equationNumber: false, elementIds: half.map((element) => element.id) },
    { id: "u5", type: "inline", equationNumber: false, elementIds: otherHalf.map((element) => element.id) }
  ]));
  assert.equal(wide.findings.some((item) => item.rule === "R10" && item.suggestion.includes("按 m")), true);
});

test("audit args print to stdout unless --out is set", () => {
  assert.equal(parseAuditArgs([]).out, null);
  assert.equal(parseAuditArgs(["--out", "reports/audit.md"]).out, "reports/audit.md");
  assert.equal(parseAuditArgs(["--limit", "4"]).limit, 4);
});

test("the markdown report names the queue index, unit ids, and element", () => {
  const prose = formula("prose", "is not possible", [0, 0, 40, 10], "u1", { unitType: "inline" });
  const report = run([entry("u1", ["prose"], { type: "inline" })], pageOf([prose], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: ["prose"]
  }]));
  const markdown = renderMarkdown(report);
  assert.match(markdown, /### #1 /);
  assert.match(markdown, /## 按序号汇总/);
  assert.match(markdown, /- #1：/);
  assert.match(markdown, /u1/);
  assert.match(markdown, /prose/);
  assert.match(markdown, /is not possible/);
  assert.equal(report.findings[0].severity <= report.findings.at(-1).severity, true);
});

test("the index summary lists each #N once, ahead of later numbers", () => {
  const findings = [
    { queueIndex: 4, rule: "R1", suggestion: "删掉正文" },
    { queueIndex: 2, rule: "R5", suggestion: "并进公式" },
    { queueIndex: 2, rule: "R7", suggestion: "收进逗号" }
  ];
  assert.deepEqual(summarizeByQueueIndex(findings), [
    "- #2：R5 并进公式；R7 收进逗号",
    "- #4：R1 删掉正文"
  ]);
  const markdown = renderMarkdown({
    window: { from: 2, to: 4, size: 2, confirmed: 1, skipped: 1 },
    counts: {},
    findings: [
      { ...findings[0], paperId: "a", page: 1, queueUnitId: "u4", currentUnitId: "u4", elements: [] },
      { ...findings[1], paperId: "b", page: 3, queueUnitId: "u2", currentUnitId: "u2", elements: [] },
      { ...findings[2], paperId: "b", page: 3, queueUnitId: "u2", currentUnitId: "u2", elements: [] }
    ]
  });
  assert.match(markdown, /### #4 R1 · a 第 1 页/);
  const summary = markdown.slice(markdown.indexOf("## 按序号汇总"), markdown.indexOf("## 发现"));
  assert.ok(summary.indexOf("#2") < summary.indexOf("#4"));
  assert.match(summary, /- #2：R5 并进公式；R7 收进逗号/);
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
  assert.match(docs, /按序号汇总/);
  assert.match(docs, /跳到 #/);
  assert.match(docs, /## 复核完成状态/);
  assert.match(docs, /860eadb/);
  assert.match(docs, /#1/);
});
