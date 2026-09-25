import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMatrix,
  bboxOfOps,
  createRecordingContext,
  multiplyMatrix,
  parseSvgPath,
  transformOps
} from "../lib/svg-recorder.js";

test("pdf.js glyph path strings parse into separate commands", () => {
  const ops = parseSvgPath("M0 0L10 0Q12 4 10 8C10 8 4 9 0 8Z");
  assert.deepEqual(ops.map((op) => op.t), ["M", "L", "Q", "C", "Z"]);
  assert.equal(ops[2].x1, 12);
  assert.equal(ops[3].x, 0);
  assert.equal(ops[3].y, 8);
});

test("negative coordinates stay attached to their command", () => {
  const ops = parseSvgPath("M-1.5 -2L3 4Z");
  assert.equal(ops[0].x, -1.5);
  assert.equal(ops[0].y, -2);
  assert.equal(ops[1].x, 3);
});

test("each fill is its own element in canvas space", () => {
  const ctx = createRecordingContext(200, 100);
  ctx.fillStyle = "#000000";
  ctx.fillRect(1, 2, 3, 4);
  ctx.transform(1, 0, 0, -1, 0, 100);
  ctx.fillRect(10, 10, 20, 5);
  assert.equal(ctx.elements.length, 2);
  assert.deepEqual(ctx.elements[0].bbox, [1, 2, 4, 6]);
  assert.equal(ctx.elements[0].provenance, "path");
  const flipped = ctx.elements[1].bbox;
  assert.ok(Math.abs(flipped[0] - 10) < 1e-9);
  assert.ok(Math.abs(flipped[1] - 85) < 1e-9);
  assert.ok(Math.abs(flipped[2] - 30) < 1e-9);
  assert.ok(Math.abs(flipped[3] - 90) < 1e-9);
});

test("glyph outlines from Path2D keep provenance and the current transform", () => {
  const ctx = createRecordingContext(50, 50);
  ctx.translate(5, 7);
  ctx.scale(2, 2);
  const path = new Path2D("M0 0L4 0L4 3Z");
  ctx.fill(path);
  assert.equal(ctx.elements.length, 1);
  assert.equal(ctx.elements[0].provenance, "glyph");
  assert.deepEqual(ctx.elements[0].bbox.map((n) => Math.round(n)), [5, 7, 13, 13]);
  assert.match(ctx.elements[0].d, /^M5 7L13 7L13 13Z$/);
});

test("save and restore put the transform back and do not restore the path", () => {
  const ctx = createRecordingContext(20, 20);
  ctx.save();
  ctx.translate(4, 0);
  ctx.moveTo(0, 0);
  ctx.restore();
  ctx.lineTo(1, 0);
  ctx.fill();
  assert.equal(ctx.elements.length, 1);
  assert.match(ctx.elements[0].d, /^M4 0L1 0/);
});

test("a scale after the path thickens the stroke and does not stretch it", () => {
  const ctx = createRecordingContext(80, 40);
  ctx.lineWidth = 0.4;
  ctx.moveTo(10, 20);
  ctx.lineTo(30, 20);
  ctx.save();
  ctx.scale(2.5, 2.5);
  ctx.stroke();
  ctx.restore();
  const rule = ctx.elements[0];
  assert.ok(Math.abs(rule.bbox[0] - 10) < 1e-6);
  assert.ok(Math.abs(rule.bbox[2] - 30) < 1e-6);
  assert.ok(Math.abs(rule.lineWidth - 1) < 1e-6);
});

test("unsupported calls are counted and not thrown", () => {
  const ctx = createRecordingContext(10, 10);
  ctx.ellipse(0, 0, 1, 1, 0, 0, 0);
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillText("∑", 0, 0);
  const counts = ctx.unsupportedCounts();
  assert.equal(counts.ellipse, 1);
  assert.equal(counts.clearRect, 1);
  assert.equal(counts.fillText, 1);
  assert.equal(ctx.elements.some((element) => element.op === "fillText"), true);
});

test("a full-canvas white fill is background, not formula ink", () => {
  const ctx = createRecordingContext(30, 40);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 30, 40);
  ctx.fillStyle = "#000000";
  ctx.fillRect(2, 2, 4, 4);
  assert.equal(ctx.elements[0].provenance, "background");
  assert.equal(ctx.elements[1].provenance, "path");
});

test("matrix multiply matches a y-flip viewport", () => {
  const viewport = multiplyMatrix([1, 0, 0, 1, 0, 0], [2, 0, 0, -2, 0, 20]);
  assert.deepEqual(applyMatrix(viewport, 3, 4), [6, 12]);
  const box = bboxOfOps(transformOps(parseSvgPath("M0 0L1 0L1 1Z"), viewport));
  assert.deepEqual(box, [0, 18, 2, 20]);
});
