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

  const base = [
    formula("x", "x", [20, 100, 30, 110], "u3"),
    formula("eq", "=", [40, 100, 50, 110], "u3"),
    formula("dot", ".", [180, 100, 184, 110], "u3")
  ];
  const numerator = [
    formula("lp", "(", [60, 86, 66, 96], "u3"),
    formula("ell", "l", [68, 86, 74, 96], "u3"),
    formula("plus", "+", [78, 86, 86, 96], "u3"),
    formula("one", "1", [90, 86, 96, 96], "u3"),
    formula("rp", ")", [98, 86, 104, 96], "u3")
  ];
  const denominator = [formula("four", "4", [80, 112, 88, 122], "u3")];
  const tagged = formula("num", "(5)", [220, 100, 236, 110], "u3", { equationNumber: true });
  const fraction = run([entry("u3", [...base, ...numerator, ...denominator, tagged].map((element) => element.id))], pageOf(
    [...base, ...numerator, ...denominator, tagged],
    [{ id: "u3", type: "display", equationNumber: true, elementIds: [...base, ...numerator, ...denominator, tagged].map((element) => element.id) }]
  ));
  assert.equal(fraction.findings.some((item) => item.rule === "R9"), false);
});

test("R3 reports a line-end number in another unit or an inline unit, and only notes a display flag", () => {
  const body = ["a", "b"].map((id, index) => formula(id, id, [index * 14, 100, index * 14 + 10, 110], "u1"));
  const foreign = formula("num", "(2.8)", [80, 100, 110, 110], "u2");
  const elsewhere = run([entry("u1", body.map((element) => element.id))], pageOf([...body, foreign], [
    { id: "u1", type: "display", equationNumber: false, elementIds: body.map((element) => element.id) },
    { id: "u2", type: "display", equationNumber: true, elementIds: ["num"] }
  ]));
  assert.equal(elsewhere.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "(2.8)")), true);

  const call = [
    formula("y", "y", [0, 220, 8, 230], "u5"),
    formula("eq5", "=", [12, 220, 22, 230], "u5"),
    formula("f", "f", [40, 220, 48, 230], "u5")
  ];
  const arg = formula("arg", "(3)", [49, 220, 64, 230], "u6");
  const callReport = run([entry("u5", call.map((element) => element.id))], pageOf([...call, arg], [
    { id: "u5", type: "display", equationNumber: false, elementIds: call.map((element) => element.id) },
    { id: "u6", type: "inline", equationNumber: false, elementIds: ["arg"] }
  ]));
  assert.equal(callReport.findings.some((item) => item.rule === "R3"), false);

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

  const split = [
    glyph("eth2", "ð", [286, 260, 292, 270], { font: "TeX_CM_Maths_Symbols" }),
    glyph("three", "3", [297, 260, 304, 270], { font: "MinionPro-Regular" }),
    glyph("thorn2", "Þ", [305, 260, 312, 270], { font: "TeX_CM_Maths_Symbols" })
  ];
  const splitBody = body.map((element) => ({ ...element, id: `s${element.id}`, bbox: [element.bbox[0], 260, element.bbox[2], 270] }));
  const splitProse = prose.map((element) => ({ ...element, id: `s${element.id}`, bbox: [element.bbox[0], element.bbox[1] + 400, element.bbox[2], element.bbox[3] + 400] }));
  const splitLine = glyph("after", "approximate results follow in this column", [360, 260, 540, 270]);
  const straddling = run([entry("u1", splitBody.map((element) => element.id), { type: "inline" })], pageOf([...splitProse, ...splitBody, ...split, splitLine], [{
    id: "u1", type: "inline", equationNumber: false, elementIds: splitBody.map((element) => element.id)
  }]));
  assert.equal(straddling.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "3")), true);
  assert.equal(straddling.findings.some((item) => item.rule === "R6"), true);
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

  const cell = ["t", "2"].map((char, index) => formula(`c${index}`, char, [200 + index * 12, 260, 210 + index * 12, 270], "u6"));
  const neighbor = formula("nine", "9", [140, 260, 150, 270], "u7");
  const bridge = glyph("cell", "2 1/2", [160, 260, 190, 270]);
  const table = run([entry("u6", cell.map((element) => element.id))], pageOf([...cell, neighbor, bridge], [
    { id: "u6", type: "inline", equationNumber: false, elementIds: cell.map((element) => element.id) },
    { id: "u7", type: "inline", equationNumber: false, elementIds: ["nine"] }
  ]));
  assert.equal(table.findings.some((item) => item.rule === "R10"), false);

  const paren = formula("lp", "(", [40, 300, 46, 310], "u8");
  const host = ["a", "b"].map((char, index) => formula(`p${index}`, char, [20 + index * 16, 300, 32 + index * 16, 310], "u9"));
  const fences = run([entry("u9", host.map((element) => element.id))], pageOf([...host, paren], [
    { id: "u9", type: "display", equationNumber: false, elementIds: host.map((element) => element.id) },
    { id: "u8", type: "inline", equationNumber: false, elementIds: ["lp"] }
  ]));
  assert.equal(fences.findings.some((item) => item.rule === "R10"), false);
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

test("R9 accepts a short equation number on its own row under a wrapped display", () => {
  const upper = ["a", "b", "c", "d"].map((char, index) => formula(`u${index}`, char, [40 + index * 16, 100, 52 + index * 16, 110], "u1"));
  const lower = ["e", "f", "g"].map((char, index) => formula(`l${index}`, char, [40 + index * 16, 160, 52 + index * 16, 170], "u1"));
  const number = formula("n9", "(9)", [400, 128, 416, 138], "u1", { equationNumber: true });
  const next = formula("n10", "(10)", [400, 160, 420, 170], "u2", { equationNumber: true });
  const report = run([entry("u1", [...upper, ...lower, number].map((element) => element.id))], pageOf(
    [...upper, ...lower, number, next],
    [
      { id: "u1", type: "display", equationNumber: true, elementIds: [...upper, ...lower, number].map((element) => element.id) },
      { id: "u2", type: "display", equationNumber: true, elementIds: ["n10"] }
    ]
  ));
  assert.equal(report.findings.some((item) => item.rule === "R9"), false);
});

test("R3 does not treat a display number as inline when the line above is close", () => {
  const inline = formula("alpha", "α", [40, 96, 50, 106], "uInline", { unitType: "inline" });
  const body = ["q", "x"].map((char, index) => formula(`d${index}`, char, [40 + index * 16, 112, 52 + index * 16, 122], "uDisplay"));
  const number = formula("n4", "(4)", [400, 112, 416, 122], "uDisplay", { equationNumber: true });
  const report = run(
    [entry("uMix", [inline.id, ...body.map((element) => element.id), number.id])],
    pageOf([inline, ...body, number], [
      { id: "uInline", type: "inline", equationNumber: false, elementIds: [inline.id] },
      { id: "uDisplay", type: "display", equationNumber: true, elementIds: [...body.map((element) => element.id), number.id] }
    ])
  );
  assert.equal(report.findings.some((item) => item.rule === "R3"), false);
});

test("R10 ignores under-braces whose boxes only clip the row above", () => {
  const above = ["p", "a", "q"].map((char, index) => formula(`a${index}`, char, [40 + index * 18, 100, 52 + index * 18, 110], "uAbove"));
  const below = ["x", "y", "z"].map((char, index) => formula(`b${index}`, char, [40 + index * 18, 140, 52 + index * 18, 150], "uBelow"));
  const brace = formula("brace", "{(", [70, 108, 82, 118], "uBelow");
  const report = run([entry("uBelow", [...below, brace].map((element) => element.id))], pageOf(
    [...above, ...below, brace],
    [
      { id: "uAbove", type: "display", equationNumber: false, elementIds: above.map((element) => element.id) },
      { id: "uBelow", type: "display", equationNumber: false, elementIds: [...below, brace].map((element) => element.id) }
    ]
  ));
  assert.equal(report.findings.some((item) => item.rule === "R10"), false);
});

test("R1 keeps a smaller roman subscript attached to a formula glyph", () => {
  const base = formula("E", "E", [40, 100, 52, 112], "u1", { font: "LMMathItalic10-Regular" });
  const sub = formula("cm", "cm", [52, 106, 66, 114], "u1", { font: "LMRoman8-Regular" });
  const report = run([entry("u1", ["E", "cm"])], pageOf([base, sub], [{
    id: "u1", type: "display", equationNumber: false, elementIds: ["E", "cm"]
  }]));
  assert.equal(report.findings.some((item) => item.rule === "R1"), false);
  assert.deepEqual(formulaProseWords(sub, [base, sub]), []);
});

test("R6 ignores connectives around a display row that ends in an equation number", () => {
  const body = ["μ", "t"].map((char, index) => formula(`m${index}`, char, [80 + index * 16, 100, 92 + index * 16, 110], "u1"));
  const where = glyph("where", "where", [20, 100, 52, 110]);
  const and = glyph("and", "and", [140, 100, 160, 110]);
  const rest = formula("beta", "β", [180, 100, 192, 110], "u2");
  const number = formula("n7", "(7)", [400, 100, 416, 110], "u2", { equationNumber: true });
  const report = run([entry("u1", body.map((element) => element.id))], pageOf(
    [...body, where, and, rest, number],
    [
      { id: "u1", type: "display", equationNumber: false, elementIds: body.map((element) => element.id) },
      { id: "u2", type: "display", equationNumber: true, elementIds: ["beta", "n7"] }
    ]
  ));
  assert.equal(report.findings.some((item) => item.rule === "R6"), false);
  assert.equal(report.findings.some((item) => item.rule === "R10"), false);

  const sentenceLeft = glyph("left", "the value", [20, 160, 70, 170]);
  const sentenceRight = glyph("right", "grows later", [140, 160, 200, 170]);
  const inline = formula("x", "x", [90, 160, 100, 170], "u3");
  const real = run([entry("u3", ["x"])], pageOf([sentenceLeft, inline, sentenceRight], [{
    id: "u3", type: "display", equationNumber: false, elementIds: ["x"]
  }]));
  assert.equal(real.findings.some((item) => item.rule === "R6" && item.suggestion.includes("按 i")), true);
});

test("R9 flags an extra marked glyph beside a real equation number", () => {
  const body = ["a", "b"].map((char, index) => formula(`b${index}`, char, [40 + index * 16, 100, 52 + index * 16, 110], "u1"));
  const number = formula("n", "(3)", [400, 100, 416, 110], "u1", { equationNumber: true });
  const extra = formula("L", "L", [380, 100, 392, 110], "u1", { equationNumber: true });
  const marked = run([entry("u1", [...body, extra, number].map((element) => element.id))], pageOf([...body, extra, number], [{
    id: "u1", type: "display", equationNumber: true, elementIds: [...body, extra, number].map((element) => element.id)
  }]));
  assert.equal(marked.findings.some((item) => item.rule === "R9" && item.elements.some((element) => element.id === "L")), true);
  assert.equal(marked.findings.some((item) => item.rule === "R9" && item.elements.some((element) => element.id === "n")), false);

  const head = formula("E", "E", [20, 140, 32, 150], "u2", { equationNumber: true });
  const rest = ["x", "y"].map((char, index) => formula(`e${index}`, char, [40 + index * 16, 140, 52 + index * 16, 150], "u2"));
  const headNumber = formula("n2", "(4)", [400, 140, 416, 150], "u2", { equationNumber: true });
  const initial = run([entry("u2", [head, ...rest, headNumber].map((element) => element.id))], pageOf([head, ...rest, headNumber], [{
    id: "u2", type: "display", equationNumber: true, elementIds: [head, ...rest, headNumber].map((element) => element.id)
  }]));
  assert.equal(initial.findings.some((item) => item.rule === "R9" && item.elements.some((element) => element.id === "E")), true);

  const big = [
    formula("open", "(", [30, 180, 38, 210], "u3", { equationNumber: true }),
    formula("close", ")", [200, 180, 208, 210], "u3", { equationNumber: true })
  ];
  const line = ["f", "s"].map((char, index) => formula(`g${index}`, char, [50 + index * 16, 188, 62 + index * 16, 198], "u3"));
  const sup = formula("sup", "2", [78, 184, 84, 190], "u3", { equationNumber: true });
  const real = formula("n110", "(1.10)", [400, 188, 428, 198], "u3", { equationNumber: true });
  const parens = run([entry("u3", [...big, ...line, sup, real].map((element) => element.id))], pageOf([...big, ...line, sup, real], [{
    id: "u3", type: "display", equationNumber: true, elementIds: [...big, ...line, sup, real].map((element) => element.id)
  }]));
  const stray = parens.findings.filter((item) => item.rule === "R9").flatMap((item) => item.elements.map((element) => element.id));
  assert.equal(stray.includes("open") && stray.includes("close") && stray.includes("sup"), true);
  assert.equal(stray.includes("n110"), false);
});

test("R3 flags an equation number moved into its own unit or into the previous row", () => {
  const body = ["a", "b", "c"].map((char, index) => formula(`a${index}`, char, [40 + index * 16, 100, 52 + index * 16, 110], "u1"));
  const alone = formula("n8", "(8)", [400, 100, 420, 110], "uNum", { equationNumber: true });
  const split = run([entry("u1", [...body, alone].map((element) => element.id))], pageOf([...body, alone], [
    { id: "u1", type: "display", equationNumber: false, elementIds: body.map((element) => element.id) },
    { id: "uNum", type: "display", equationNumber: true, elementIds: ["n8"] }
  ]));
  assert.equal(split.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "(8)")), true);

  const previous = ["p", "q"].map((char, index) => formula(`p${index}`, char, [40 + index * 16, 60, 52 + index * 16, 70], "uPrev"));
  const current = ["r", "s"].map((char, index) => formula(`c${index}`, char, [40 + index * 16, 100, 52 + index * 16, 110], "uCur"));
  const moved = formula("n9", "(9)", [400, 100, 420, 110], "uPrev", { equationNumber: true });
  const relocated = run([entry("uPrev", [...previous, ...current, moved].map((element) => element.id))], pageOf([...previous, ...current, moved], [
    { id: "uPrev", type: "display", equationNumber: true, elementIds: [...previous, moved].map((element) => element.id) },
    { id: "uCur", type: "display", equationNumber: false, elementIds: current.map((element) => element.id) }
  ]));
  assert.equal(relocated.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "(9)")), true);
});

test("R10 flags one row split into two display units, including a binomial parenthesis pair", () => {
  const left = ["p", "="].map((char, index) => formula(`L${index}`, char, [40 + index * 16, 100, 52 + index * 16, 110], "uLeft"));
  const right = ["q", "x"].map((char, index) => formula(`R${index}`, char, [120 + index * 16, 100, 132 + index * 16, 110], "uRight"));
  const number = formula("n1", "(1)", [400, 100, 416, 110], "uRight", { equationNumber: true });
  const row = run([entry("uLeft", [...left, ...right, number].map((element) => element.id))], pageOf([...left, ...right, number], [
    { id: "uLeft", type: "display", equationNumber: false, elementIds: left.map((element) => element.id) },
    { id: "uRight", type: "display", equationNumber: true, elementIds: [...right, number].map((element) => element.id) }
  ]));
  assert.equal(row.findings.some((item) => item.rule === "R10"), true);

  const contents = ["n", "k"].map((char, index) => formula(`c${index}`, char, [40 + index * 14, 200, 50 + index * 14, 210], "uBody", { unitType: "inline" }));
  const pair = [
    formula("lp", "(", [28, 196, 36, 214], "uPar", { unitType: "inline" }),
    formula("rp", ")", [70, 196, 78, 214], "uPar", { unitType: "inline" })
  ];
  const binomial = run([entry("uBody", [...contents, ...pair].map((element) => element.id), { type: "inline" })], pageOf([...contents, ...pair], [
    { id: "uBody", type: "inline", equationNumber: false, elementIds: contents.map((element) => element.id) },
    { id: "uPar", type: "inline", equationNumber: false, elementIds: pair.map((element) => element.id) }
  ]));
  assert.equal(binomial.findings.some((item) => item.rule === "R10" && item.elements.some((element) => element.char === "(")), true);
});

test("R2 flags a display unit that covers two formula rows", () => {
  const upper = ["a", "=", "b"].map((char, index) => formula(`u${index}`, char, [40 + index * 16, 100, 52 + index * 16, 110], "u1"));
  const number = formula("n4", "(4)", [400, 116, 416, 126], "u1", { equationNumber: true });
  const lower = ["c", "=", "d"].map((char, index) => formula(`l${index}`, char, [40 + index * 16, 132, 52 + index * 16, 142], "u1"));
  const report = run([entry("u1", [...upper, number, ...lower].map((element) => element.id))], pageOf([...upper, number, ...lower], [{
    id: "u1", type: "display", equationNumber: true, elementIds: [...upper, number, ...lower].map((element) => element.id)
  }]));
  assert.equal(report.findings.some((item) => item.rule === "R2"), true);
  assert.equal(report.findings.some((item) => item.rule === "R9"), false);
});

function reviewedPage(paperId, page) {
  const file = new URL(`../labels/reviewed/${paperId}/page-${String(page).padStart(3, "0")}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8"));
}

let reviewUnits;
function queueFor(paperId, page) {
  if (!reviewUnits) {
    reviewUnits = JSON.parse(readFileSync(new URL("../labels/review-set.json", import.meta.url), "utf8")).units;
  }
  return reviewUnits.filter((unit) => unit.paperId === paperId && unit.page === page);
}

function auditReal(paperId, page, mutate) {
  const queue = queueFor(paperId, page);
  const data = structuredClone(reviewedPage(paperId, page));
  if (mutate) mutate(data);
  return run(queue, data);
}

test("an operator continuation or a cross-row bracket is one display unit", () => {
  const upper = ["D", "=", "F"].map((char, index) => formula(`u${index}`, char, [40 + index * 16, 100, 52 + index * 16, 110], "uWrap"));
  const number = formula("n18", "(18)", [400, 116, 424, 126], "uWrap", { equationNumber: true });
  const lower = ["+", "E", "G"].map((char, index) => formula(`l${index}`, char, [40 + index * 16, 132, 52 + index * 16, 142], "uWrap"));
  const wrapped = run([entry("uWrap", [...upper, number, ...lower].map((element) => element.id))], pageOf([...upper, number, ...lower], [{
    id: "uWrap", type: "display", equationNumber: true, elementIds: [...upper, number, ...lower].map((element) => element.id)
  }]));
  assert.equal(wrapped.findings.some((item) => item.rule === "R2"), false);

  const open = formula("brOpen", "[", [28, 200, 36, 210], "uBr", { font: "AdvP4C4E46" });
  const openChar = formula("brOpenCtl", "\u0014", [28, 200, 36, 210], "uBr", { font: "AdvP4C4E46" });
  const row1 = ["S", "x"].map((char, index) => formula(`s${index}`, char, [48 + index * 16, 200, 60 + index * 16, 210], "uBr"));
  const close = formula("brClose", "]", [220, 232, 228, 242], "uBr", { font: "AdvP4C4E46" });
  const closeChar = formula("brCloseCtl", "\u0015", [220, 232, 228, 242], "uBr", { font: "AdvP4C4E46" });
  const row2 = ["+", "y"].map((char, index) => formula(`t${index}`, char, [48 + index * 16, 232, 60 + index * 16, 242], "uBr"));
  const bracketed = [...row1, open, openChar, ...row2, close, closeChar];
  const brackets = run([entry("uBr", bracketed.map((element) => element.id))], pageOf(bracketed, [{
    id: "uBr", type: "display", equationNumber: false, elementIds: bracketed.map((element) => element.id)
  }]));
  assert.equal(brackets.findings.some((item) => item.rule === "R2"), false);

  const splitLower = lower.map((element) => ({ ...element, unitId: "uLow" }));
  const splitNumber = { ...number, unitId: "uLow" };
  const split = run([entry("uWrap", [...upper, splitNumber, ...splitLower].map((element) => element.id))], pageOf([...upper, splitNumber, ...splitLower], [
    { id: "uWrap", type: "display", equationNumber: false, elementIds: upper.map((element) => element.id) },
    { id: "uLow", type: "display", equationNumber: true, elementIds: [splitNumber, ...splitLower].map((element) => element.id) }
  ]));
  assert.equal(split.findings.some((item) => item.rule === "R2" && item.suggestion.includes("按 m")), true);
});

test("R3 reports the lone (9) once it is moved out and marked text", () => {
  const report = auditReal("2006.11239", 3, (data) => {
    const number = data.elements.find((element) => element.id === "e3231d3473f28eb2c");
    number.label = "text";
    number.unitId = null;
    number.unitType = null;
    number.equationNumber = false;
    const unit = data.units.find((item) => item.id === "u5888f399cf15");
    unit.elementIds = unit.elementIds.filter((id) => id !== number.id);
  });
  assert.equal(report.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "(9)")), true);
});

test("R2 reports two rows that each carry an equation number", () => {
  const report = auditReal("2006.11239", 3, (data) => {
    const upper = data.units.find((unit) => unit.id === "u5888f399cf15");
    const lower = data.units.find((unit) => unit.id === "ue0869dd97863");
    const ids = lower.elementIds.slice();
    upper.elementIds.push(...ids);
    for (const id of ids) data.elements.find((element) => element.id === id).unitId = upper.id;
    data.units = data.units.filter((unit) => unit.id !== lower.id);
  });
  assert.equal(report.findings.some((item) => item.rule === "R2" && item.suggestion.includes("各自带编号")), true);
});

test("R3 reports equation (18) once it is split into its own unit", () => {
  const report = auditReal("s41598-021-85174-w", 9, (data) => {
    const id = "e1b0851f558035348";
    const unit = data.units.find((item) => item.id === "u064572585535");
    unit.elementIds = unit.elementIds.filter((item) => item !== id);
    const number = data.elements.find((element) => element.id === id);
    number.unitId = "uNum18";
    data.units.push({ id: "uNum18", type: "display", equationNumber: true, elementIds: [id] });
  });
  assert.equal(report.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "(18)")), true);
});

test("the wrapped (18) unit is valid, and merging the next inline formula is not", () => {
  const clean = auditReal("s41598-021-85174-w", 9);
  assert.equal(clean.findings.some((item) => item.rule === "R2"), false);
  const report = auditReal("s41598-021-85174-w", 9, (data) => {
    const unit = data.units.find((item) => item.id === "u064572585535");
    const inline = data.units.find((item) => item.id === "ue5d393902418");
    for (const id of inline.elementIds) {
      const element = data.elements.find((item) => item.id === id);
      element.unitId = unit.id;
      element.unitType = "display";
      unit.elementIds.push(id);
    }
    data.units = data.units.filter((item) => item.id !== inline.id);
  });
  assert.equal(report.findings.some((item) => item.rule === "R2" && item.suggestion.includes("正文")), true);
});

test("splitting the wrapped (18) formula per row is reported", () => {
  const report = auditReal("s41598-021-85174-w", 9, (data) => {
    const unit = data.units.find((item) => item.id === "u064572585535");
    const byId = new Map(data.elements.map((element) => [element.id, element]));
    const moving = unit.elementIds.filter((id) => {
      const element = byId.get(id);
      return element?.bbox && (element.bbox[1] + element.bbox[3]) / 2 >= 332;
    });
    unit.elementIds = unit.elementIds.filter((id) => !moving.includes(id));
    for (const id of moving) byId.get(id).unitId = "uLower18";
    data.units.push({ id: "uLower18", type: "display", equationNumber: true, elementIds: moving });
  });
  assert.equal(report.findings.some((item) => item.rule === "R2" && item.suggestion.includes("折行")), true);
});

test("a full line drop is not the same row, and sentences beside a display are not R10", () => {
  const dropped = auditReal("2006.11239", 3, (data) => {
    const unit = data.units.find((item) => item.id === "u186b97b94c49");
    const ids = new Set(unit.elementIds);
    for (const element of data.elements) {
      if (!ids.has(element.id) || !element.bbox) continue;
      element.bbox = [element.bbox[0], element.bbox[1] + 14, element.bbox[2], element.bbox[3] + 14];
    }
  });
  assert.equal(dropped.findings.some((item) => item.rule === "R10"), false);

  const sentences = auditReal("2006.11239", 3, (data) => {
    data.elements.find((element) => element.id === "e8b313bb50956da3c").char = "the previous value";
    data.elements.find((element) => element.id === "ee2a0d492acc1ed24").char = "grows later today";
  });
  assert.equal(sentences.findings.some((item) => item.rule === "R10"), false);
});

test("the saved bracket wrap passes, and splitting it per row is reported", () => {
  const saved = auditReal("s41467-020-19530-1", 2);
  assert.equal(saved.findings.some((item) => item.rule === "R2"), false);
  const split = auditReal("s41467-020-19530-1", 2, (data) => {
    const unit = data.units.find((item) => item.id === "ue194e03da9a8");
    const byId = new Map(data.elements.map((element) => [element.id, element]));
    const moving = unit.elementIds.filter((id) => {
      const element = byId.get(id);
      return element?.bbox && (element.bbox[1] + element.bbox[3]) / 2 >= 524;
    });
    unit.elementIds = unit.elementIds.filter((id) => !moving.includes(id));
    for (const id of moving) byId.get(id).unitId = "uLower4";
    data.units.push({ id: "uLower4", type: "display", equationNumber: true, elementIds: moving });
  });
  assert.equal(split.findings.some((item) => item.rule === "R2" && item.queueUnitId === "ude716a502627" && item.suggestion.includes("按 m")), true);
});

function moveByMidY(data, unitId, nextId, nextType, accept) {
  const unit = data.units.find((item) => item.id === unitId);
  const byId = new Map(data.elements.map((element) => [element.id, element]));
  const moving = unit.elementIds.filter((id) => {
    const element = byId.get(id);
    return element?.bbox && accept((element.bbox[1] + element.bbox[3]) / 2);
  });
  unit.elementIds = unit.elementIds.filter((id) => !moving.includes(id));
  for (const id of moving) {
    const element = byId.get(id);
    element.unitId = nextId;
    element.unitType = nextType;
  }
  data.units.push({ id: nextId, type: nextType, equationNumber: false, elementIds: moving });
  return moving;
}

test("the saved (2.24a) wrap passes, and splitting it is reported", () => {
  const saved = auditReal("jhep04-2021-102", 12);
  assert.equal(saved.findings.some((item) => item.queueUnitId === "u46b41d385d16"), false);
  assert.equal(saved.findings.some((item) => item.elements.some((element) => element.char === "(2.24b)" || element.char === "(2.24c)")), false);

  const split = auditReal("jhep04-2021-102", 12, (data) => {
    moveByMidY(data, "u5f6dd0b28c6c", "uTimes", "display", (y) => y >= 638);
  });
  assert.equal(split.findings.some((item) => item.rule === "R2" && item.queueUnitId === "u46b41d385d16" && item.suggestion.includes("按 m")), true);

  const loneLhs = auditReal("jhep04-2021-102", 12, (data) => {
    moveByMidY(data, "u5f6dd0b28c6c", "uLhs", "inline", (y) => y < 610);
  });
  assert.equal(loneLhs.findings.some((item) => item.rule === "R2" && item.queueUnitId === "u46b41d385d16" && item.currentUnitId.includes("uLhs") && item.suggestion.includes("按 m")), true);

  const textNumber = auditReal("jhep04-2021-102", 12, (data) => {
    const unit = data.units.find((item) => item.id === "u5f6dd0b28c6c");
    const number = data.elements.find((element) => element.id === "e8b03c85ecd4e8d5d");
    number.label = "text";
    number.unitId = null;
    number.unitType = null;
    number.equationNumber = false;
    unit.elementIds = unit.elementIds.filter((id) => id !== number.id);
  });
  assert.equal(textNumber.findings.some((item) => item.rule === "R3" && item.queueUnitId === "u46b41d385d16" && item.elements.some((element) => element.char === "(2.24a)")), true);
});

test("merging a left-hand side into a non-adjacent equation is reported", () => {
  const report = auditReal("jhep04-2021-102", 12, (data) => {
    const source = data.units.find((unit) => unit.id === "u5f6dd0b28c6c");
    const target = data.units.find((unit) => unit.id === "u9aa5453fe661");
    const byId = new Map(data.elements.map((element) => [element.id, element]));
    const moving = source.elementIds.filter((id) => {
      const element = byId.get(id);
      return element?.bbox && (element.bbox[1] + element.bbox[3]) / 2 < 610;
    });
    source.elementIds = source.elementIds.filter((id) => !moving.includes(id));
    for (const id of moving) {
      const element = byId.get(id);
      element.unitId = target.id;
      element.unitType = "display";
      target.elementIds.push(id);
    }
  });
  assert.equal(report.findings.some((item) => item.rule === "R2" && item.queueUnitId === "u46b41d385d16" && item.currentUnitId === "u9aa5453fe661" && item.suggestion.includes("中间隔着")), true);
});

function moveSplitNumber(data, mode) {
  const ids = ["ed05eb80be2e3b36b", "ebd200e46005effa3", "e7346bab338c7080c"];
  const unit = data.units.find((item) => item.id === "ue194e03da9a8");
  unit.elementIds = unit.elementIds.filter((id) => !ids.includes(id));
  for (const id of ids) {
    const element = data.elements.find((item) => item.id === id);
    if (mode === "text") {
      element.label = "text";
      element.unitId = null;
      element.unitType = null;
      element.equationNumber = false;
    } else {
      element.unitId = "uNum4";
      element.unitType = "display";
    }
  }
  if (mode === "unit") data.units.push({ id: "uNum4", type: "display", equationNumber: true, elementIds: ids });
}

test("moving a ð4Þ equation number out of its display unit is R3", () => {
  for (const mode of ["text", "unit"]) {
    const report = auditReal("s41467-020-19530-1", 2, (data) => moveSplitNumber(data, mode));
    assert.equal(report.findings.some((item) => item.rule === "R3" && item.elements.some((element) => element.char === "4")), true, mode);
  }
});

function merge224Rows(data) {
  const host = data.units.find((unit) => unit.id === "u5f6dd0b28c6c");
  const byId = new Map(data.elements.map((element) => [element.id, element]));
  for (const id of ["u9aa5453fe661", "u6640d511349b"]) {
    const unit = data.units.find((item) => item.id === id);
    for (const elementId of unit.elementIds) {
      const element = byId.get(elementId);
      element.unitId = host.id;
      element.unitType = "display";
      host.elementIds.push(elementId);
    }
  }
  data.units = data.units.filter((unit) => unit.id !== "u9aa5453fe661" && unit.id !== "u6640d511349b");
}

function insertNarrow(data, bbox) {
  data.elements.push({
    id: "eNarrow",
    kind: "glyph",
    char: "≡",
    font: "LMMathSymbols10-Regular",
    bbox,
    label: "formula",
    unitId: "uNarrow",
    unitType: "inline",
    equationNumber: false
  });
  data.units.push({ id: "uNarrow", type: "inline", equationNumber: false, elementIds: ["eNarrow"] });
}

function skippedMiddle(report) {
  return report.findings.some((item) => item.rule === "R2" && item.suggestion.includes("中间隔着") && item.elements.some((element) => element.char === "≡"));
}

test("N24 a lone ≡ between two merged rows is skipped over", () => {
  const report = auditReal("jhep04-2021-102", 12, (data) => {
    merge224Rows(data);
    // (2.24b) ends near y=686 and (2.24c) starts near y=690. 8pt wide, inside both rows.
    insertNarrow(data, [200, 684, 208, 692]);
  });
  assert.equal(skippedMiddle(report), true);
  assert.equal(report.findings.some((item) => item.rule === "R2" && item.queueUnitId === "u46b41d385d16" && item.currentUnitId === "u5f6dd0b28c6c"), true);
});

test("N25 a narrow mark in the equation-number column is not between the rows", () => {
  const report = auditReal("jhep04-2021-102", 12, (data) => {
    merge224Rows(data);
    insertNarrow(data, [490, 684, 498, 692]);
  });
  assert.equal(skippedMiddle(report), false);
});

test("N26 a narrow mark outside one row span is not skipped over", () => {
  const straddling = auditReal("jhep04-2021-102", 12, (data) => {
    merge224Rows(data);
    insertNarrow(data, [154, 684, 163, 692]);
  });
  assert.equal(skippedMiddle(straddling), false);

  const oneSide = auditReal("jhep04-2021-102", 12, (data) => {
    merge224Rows(data);
    insertNarrow(data, [400, 684, 408, 692]);
  });
  assert.equal(skippedMiddle(oneSide), false);
});

function offsetBlocks(dy) {
  const height = 10;
  const upper = ["a", "b", "c"].map((char, index) => formula(`u${index}`, char, [40 + index * 16, 100, 52 + index * 16, 100 + height], "u1"));
  const lower = ["d", "e", "f"].map((char, index) => formula(`l${index}`, char, [40 + index * 16, 100 + dy, 52 + index * 16, 100 + height + dy], "u2"));
  return { upper, lower, height };
}

test("N2b a 20% offset is still the same row", () => {
  const { upper, lower } = offsetBlocks(2);
  const report = run([entry("u1", upper.map((element) => element.id))], pageOf([...upper, ...lower], [
    { id: "u1", type: "display", equationNumber: false, elementIds: upper.map((element) => element.id) },
    { id: "u2", type: "display", equationNumber: false, elementIds: lower.map((element) => element.id) }
  ]));
  assert.equal(report.findings.some((item) => item.rule === "R10"), true);
});

test("N2c two blocks offset by 41% of the glyph height are reported", () => {
  const dy = 4.1;
  const upper = ["a", "b", "c"].map((char, index) => formula(`u${index}`, char, [40 + index * 16, 100, 52 + index * 16, 110], "u1"));
  const lower = ["d", "e", "f"].map((char, index) => formula(`l${index}`, char, [40 + index * 16, 100 + dy, 52 + index * 16, 110 + dy], "u1"));
  const report = run([entry("u1", [...upper, ...lower].map((element) => element.id))], pageOf([...upper, ...lower], [{
    id: "u1", type: "display", equationNumber: false, elementIds: [...upper, ...lower].map((element) => element.id)
  }]));
  assert.equal(report.findings.some((item) => item.rule === "R2"), true);

  const { upper: left, lower: right } = offsetBlocks(dy);
  const apart = run([entry("u1", left.map((element) => element.id))], pageOf([...left, ...right], [
    { id: "u1", type: "display", equationNumber: false, elementIds: left.map((element) => element.id) },
    { id: "u2", type: "display", equationNumber: false, elementIds: right.map((element) => element.id) }
  ]));
  assert.equal(apart.findings.some((item) => item.rule === "R10"), false);
});

function r11Of(elements, units, unitId = "uBody") {
  const ids = elements.filter((element) => element.unitId === unitId).map((element) => element.id);
  const report = run([entry(unitId, ids.length ? ids : [elements[0].id])], pageOf(elements, units));
  return report.findings.filter((item) => item.rule === "R11");
}

test("R11 flags a text subscript and a superscript in either direction", () => {
  const base = formula("eX", "x", [40, 100, 50, 110], "uBody");
  const sub = glyph("eI", "i", [52, 104, 58, 111], { label: "text" });
  const subscript = r11Of([base, sub], [
    { id: "uBody", type: "display", equationNumber: false, elementIds: ["eX"] }
  ]);
  assert.equal(subscript.length, 1);
  assert.match(subscript[0].suggestion, /疑似上下标被拆开/);
  assert.match(subscript[0].suggestion, /主体 `eX`/);
  assert.match(subscript[0].suggestion, /上下标 `eI`/);
  assert.match(subscript[0].suggestion, /中心偏移 0\.250 主体字高（右块更低）/);
  assert.match(subscript[0].suggestion, /水平间隙 0\.200 主体字高/);
  assert.equal(subscript[0].elements.map((element) => element.id).join(","), "eX,eI");

  const sup = glyph("eStar", "∗", [52, 96, 58, 102], { label: "text" });
  const superscript = r11Of([base, sup], [
    { id: "uBody", type: "display", equationNumber: false, elementIds: ["eX"] }
  ]);
  assert.equal(superscript.length, 1);
  assert.match(superscript[0].suggestion, /中心偏移 -0\.600 主体字高（右块更高）/);
  assert.match(superscript[0].suggestion, /水平间隙 0\.200 主体字高/);
});

test("N55 uses the body height when the left glyph is the superscript", () => {
  const sup = glyph("eStar", "∗", [40, 96, 46, 102], { label: "text" });
  const body = formula("eX", "x", [48, 100, 58, 110], "uBody");
  const hits = r11Of([sup, body], [
    { id: "uBody", type: "display", equationNumber: false, elementIds: ["eX"] }
  ]);
  assert.equal(hits.length, 1);
  assert.match(hits[0].suggestion, /主体 `eX`/);
  assert.match(hits[0].suggestion, /中心偏移 0\.600 主体字高（右块更低）/);
  assert.match(hits[0].suggestion, /水平间隙 0\.200 主体字高/);
});

test("N53 a block on another line does not hide the same-line script", () => {
  const base = formula("eX", "x", [40, 100, 50, 110], "uBody");
  const blocker = glyph("eBlock", "M", [50.4, 140, 56, 150], { label: "text" });
  const script = glyph("eI", "i", [52, 104, 58, 111], { label: "text" });
  const hits = r11Of([base, blocker, script], [
    { id: "uBody", type: "display", equationNumber: false, elementIds: ["eX"] }
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].elements.map((element) => element.id).sort().join(","), "eI,eX");
  assert.match(hits[0].suggestion, /上下标 `eI`/);
});

test("R11 ignores a full-height period at 0.353 and an English word", () => {
  const base = formula("eX", "x", [40, 100, 50, 110], "uBody");
  const period = glyph("eDot", ".", [53, 103.53, 58, 113.53], { label: "text" });
  const periodHits = r11Of([base, period], [
    { id: "uBody", type: "display", equationNumber: false, elementIds: ["eX"] }
  ]);
  assert.equal(periodHits.length, 0);

  const word = glyph("eWhere", "where", [50, 100, 90, 110], { label: "text" });
  const short = formula("eT", "t", [40, 96, 48, 102], "uBody");
  const wordHits = r11Of([short, word], [
    { id: "uBody", type: "display", equationNumber: false, elementIds: ["eT"] }
  ]);
  assert.equal(wordHits.length, 0);

  const clause = glyph("eClause", "):=", [50, 100, 80, 110], { label: "text" });
  const clauseHits = r11Of([short, clause], [
    { id: "uBody", type: "display", equationNumber: false, elementIds: ["eT"] }
  ]);
  assert.equal(clauseHits.length, 0);
});

test("N59 and N60 name a line-start ≡ left of the span, with reading-order ranges", () => {
  const upper = [
    formula("eA", "A", [40, 100, 50, 110], "uMerge"),
    formula("eB", "B", [56, 100, 66, 110], "uMerge"),
    formula("eN1", "(1)", [200, 100, 224, 110], "uMerge", { equationNumber: true })
  ];
  const equiv = formula("eEq", "≡", [20, 130, 28, 140], "uMerge", { font: "LMMathSymbols10-Regular" });
  const lower = [
    formula("eC", "C", [40, 130, 50, 140], "uMerge"),
    formula("eD", "D", [56, 130, 66, 140], "uMerge"),
    formula("eN2", "(2)", [200, 130, 224, 140], "uMerge", { equationNumber: true })
  ];
  const elements = [...upper, equiv, ...lower];
  const report = run([entry("uMerge", elements.map((element) => element.id))], pageOf(elements, [{
    id: "uMerge", type: "display", equationNumber: true, elementIds: elements.map((element) => element.id)
  }]));
  const hit = report.findings.find((item) => item.rule === "R2" && item.suggestion.includes("在跨度左侧"));
  assert.ok(hit);
  const expected = "行首 ≡（`eEq`）在跨度左侧。并入前，左边这一行单独占一行（元素 `eA`–`eN1`）。并入后，它并进紧接着的带编号单元 `uMerge`（元素 `eA`–`eN2`）。两行之间隔着的是别的单元，不是这个 ≡ 所在的单元。把多并进去的那一行按 s 拆出去。";
  assert.equal(hit.suggestion, expected);
  assert.equal(hit.suggestion.includes("中间隔着单元 `uMerge`"), false);
  assert.equal(hit.elements.some((element) => element.id === "eEq"), true);

  // eA sits slightly lower, so its top edge is below eB. Sorting by top edge
  // would start the range at eB. Reading order still starts at the left glyph.
  const dropped = formula("eA", "A", [40, 104, 50, 114], "uMerge");
  const n60 = [dropped, ...upper.slice(1), equiv, ...lower];
  const droppedReport = run([entry("uMerge", n60.map((element) => element.id))], pageOf(n60, [{
    id: "uMerge", type: "display", equationNumber: true, elementIds: n60.map((element) => element.id)
  }]));
  const n60Hit = droppedReport.findings.find((item) => item.rule === "R2" && item.suggestion.includes("在跨度左侧"));
  assert.ok(n60Hit);
  assert.equal(n60Hit.suggestion, expected);
});
