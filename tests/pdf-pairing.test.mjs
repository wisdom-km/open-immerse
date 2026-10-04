import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clearFadeScroll } from "../lib/pdf-reader-flow.js";
import { readReaderPrefs, writeReaderPrefs } from "../lib/pdf-reader-flow.js";
import {
  PAIR_ANCHOR,
  PAIR_BG_SPREAD,
  appliedSourceSide,
  blockAtAnchor,
  buildBlockPairs,
  createJumpLock,
  decodeSrcRects,
  encodeSrcRects,
  followReducer,
  isUnlockEvent,
  menuNext,
  moreMenuModel,
  nudgeScrollToPair,
  pageArrivalText,
  pairBoxStyle,
  pairClickKept,
  pairIdFor,
  rectFromNormalized,
  sharePair,
  sourceAnchorScroll,
  sourceFollowScroll,
  sourceHit,
  sourcePageLabel,
  splitKeyStep,
  splitPointerRatio,
  structureRolePairs,
  translationJumpScroll,
  visualPaneOrder
} from "../lib/pdf-pairing.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("pair ids and source rects round-trip in PDF points", () => {
  assert.equal(pairIdFor(4, "b12"), "p4:b12");
  assert.equal(pairIdFor(0, "b"), "");
  assert.equal(pairIdFor(2, ""), "");
  const page = { width: 612, height: 792 };
  const rect = rectFromNormalized([0.1, 0.2, 0.5, 0.4], page.width, page.height, 3);
  assert.ok(Math.abs(rect.x - 61.2) < 1e-9);
  assert.ok(Math.abs(rect.y - 158.4) < 1e-9);
  assert.ok(Math.abs(rect.w - 244.8) < 1e-9);
  assert.ok(Math.abs(rect.h - 158.4) < 1e-9);
  assert.equal(rect.p, 3);
  assert.equal(rectFromNormalized([0, 0, 0, 1], 612, 792, 1), null);
  assert.equal(rectFromNormalized(null, 612, 792, 1), null);
  const encoded = encodeSrcRects([rect, { p: 3, x: 1, y: 2, w: 3, h: 4 }]);
  assert.deepEqual(decodeSrcRects(encoded), [rect, { p: 3, x: 1, y: 2, w: 3, h: 4 }]);
  assert.deepEqual(decodeSrcRects("nope"), []);
  assert.deepEqual(decodeSrcRects(""), []);
  assert.deepEqual(decodeSrcRects([{ p: 1, x: 0, y: 0, w: 0, h: 4 }]), []);
});

test("groups: figure caption, byline, title roles, inline, and unpaired", () => {
  const page = { page: 2, pageWidth: 612, pageHeight: 792 };
  const figure = { id: "fig", label: "figure", bbox: [0.1, 0.2, 0.6, 0.5] };
  const caption = { id: "cap", label: "caption", captionFor: "fig", bbox: [0.1, 0.5, 0.6, 0.56] };
  const paired = buildBlockPairs({ ...page, blocks: [figure, caption] });
  assert.equal(paired.nodes.length, 1);
  assert.equal(paired.nodes[0].rects.length, 2);
  assert.equal(paired.nodes[0].pairId, "p2:fig");
  const captionFirst = buildBlockPairs({ ...page, blocks: [caption, figure] });
  assert.equal(captionFirst.nodes[0].pairId, "p2:cap");
  assert.equal(captionFirst.nodes[0].rects.length, 2);

  const bylines = [0, 1, 2].map((n) => ({
    id: `a${n}`,
    label: "paragraph",
    presentation: "byline",
    bbox: [0.1, 0.1 + n * 0.02, 0.4, 0.12 + n * 0.02]
  }));
  const authors = buildBlockPairs({ ...page, blocks: bylines });
  assert.equal(authors.nodes.length, 1);
  assert.equal(authors.nodes[0].kind, "authors");
  assert.equal(authors.nodes[0].rects.length, 3);
  assert.equal(authors.nodes[0].pairId, "p2:a0");

  const para = { id: "p", label: "paragraph", bbox: [0.1, 0.4, 0.8, 0.5], text: "scaled dot product" };
  const inline = {
    id: "in",
    label: "formula",
    inlineOf: "p",
    bbox: [0.4, 0.42, 0.48, 0.46]
  };
  const withInline = buildBlockPairs({ ...page, blocks: [para, inline] });
  assert.equal(withInline.nodes[0].pairId, "p2:p");
  assert.equal(withInline.inlines.length, 1);
  assert.equal(withInline.inlines[0].pairId, "p2:p");
  assert.equal(withInline.inlines[0].part, "inline");
  assert.equal(withInline.inlines[0].rects.length, 1);
  assert.notEqual(withInline.inlines[0].rects[0].w, withInline.nodes[0].rects[0].w);

  const bare = buildBlockPairs({
    ...page,
    blocks: [{ id: "nobox", label: "paragraph", text: "stored" }]
  });
  assert.deepEqual(bare.nodes, []);
  assert.deepEqual(bare.inlines, []);

  const structure = {
    title: "Attention",
    authors: [{ name: "Ashish" }],
    abstract: { heading: "Abstract", body: "The dominant sequence transduction models are based on complex stuff." },
    rest: []
  };
  const blocks = [
    { id: "t", label: "title", bbox: [0.2, 0.08, 0.8, 0.12], text: "Attention" },
    { id: "au", label: "paragraph", presentation: "byline", bbox: [0.2, 0.14, 0.8, 0.18], text: "Ashish Vaswani" },
    { id: "h", label: "heading", bbox: [0.2, 0.2, 0.4, 0.23], text: "Abstract" },
    {
      id: "ab",
      label: "paragraph",
      bbox: [0.15, 0.24, 0.85, 0.4],
      text: "The dominant sequence transduction models are based on complex stuff."
    },
    { id: "miss", label: "paragraph", text: "no box abstract leftover" }
  ];
  const roles = structureRolePairs({ ...page, blocks, structure });
  const title = roles.find((role) => role.role === "title");
  const authorRole = roles.find((role) => role.role === "authors");
  const heading = roles.find((role) => role.role === "abstract_heading");
  const body = roles.find((role) => role.role === "abstract_body");
  assert.equal(title.pairId, "p2:t");
  assert.equal(title.rects.length, 1);
  assert.equal(authorRole.rects.length, 1);
  assert.equal(heading.pairId, "p2:h");
  assert.equal(body.pairId, "p2:ab");
  const empty = structureRolePairs({
    ...page,
    blocks: [{ id: "t2", label: "title", text: "Attention" }],
    structure
  });
  assert.equal(empty.find((role) => role.role === "title").pairId, "");

  const shared = sharePair("p9:first", [
    { key: "one", rects: [{ p: 9, x: 1, y: 2, w: 3, h: 4 }, { p: 9, x: 5, y: 6, w: 7, h: 8 }] },
    { key: "two", rects: [{ p: 9, x: 9, y: 1, w: 2, h: 3 }] }
  ]);
  assert.equal(shared.length, 2);
  assert.equal(shared.every((node) => node.pairId === "p9:first"), true);
  assert.equal(shared[0].rects.length, 2);
  assert.equal(shared[1].rects.length, 1);
});

test("blockAtAnchor crosses the line, skips gaps, and keeps the last block", () => {
  const entries = [
    { pairId: "a", top: 0, bottom: 40 },
    { pairId: "b", top: 80, bottom: 120 },
    { pairId: "c", top: 200, bottom: 240 }
  ];
  assert.equal(blockAtAnchor(entries, 20).pairId, "a");
  assert.equal(blockAtAnchor(entries, 40).pairId, "a");
  assert.equal(blockAtAnchor(entries, 60).pairId, "b");
  assert.equal(blockAtAnchor(entries, 400).pairId, "c");
  assert.equal(blockAtAnchor([], 10), null);
  assert.equal(blockAtAnchor([{ pairId: "z", top: 0, bottom: 0 }], 0), null);
});

test("sourceHit picks the smallest containing rect and includes edges", () => {
  const rects = [
    { id: "page", x: 0, y: 0, w: 100, h: 100 },
    { id: "line", x: 10, y: 10, w: 20, h: 8 },
    { id: "other", x: 40, y: 40, w: 10, h: 10 }
  ];
  assert.equal(sourceHit(rects, { x: 12, y: 12 }).id, "line");
  assert.equal(sourceHit(rects, { x: 10, y: 10 }).id, "line");
  assert.equal(sourceHit(rects, { x: 30, y: 18 }).id, "line");
  assert.equal(sourceHit(rects, { x: 50, y: 50 }).id, "other");
  assert.equal(sourceHit(rects, { x: 200, y: 200 }), null);
  assert.equal(sourceHit(rects, { x: -1, y: 0 }), null);
});

test("followReducer covers on, off, paused, and unavailable", () => {
  const events = ["toggle", "userSourceScroll", "resume", "clickJump", "capsuleJump", "sourceModeChange"];
  const table = {
    on: {
      toggle: ["off", "0"],
      userSourceScroll: ["paused", null],
      resume: ["on", null],
      clickJump: ["on", null],
      capsuleJump: ["on", null],
      sourceModeChange: ["on", null]
    },
    off: {
      toggle: ["on", "1"],
      userSourceScroll: ["off", null],
      resume: ["off", null],
      clickJump: ["off", null],
      capsuleJump: ["off", null],
      sourceModeChange: ["off", null]
    },
    paused: {
      toggle: ["on", null],
      userSourceScroll: ["paused", null],
      resume: ["on", null],
      clickJump: ["on", null],
      capsuleJump: ["on", null],
      sourceModeChange: ["on", null]
    },
    unavailable: {
      toggle: ["unavailable", null],
      userSourceScroll: ["unavailable", null],
      resume: ["unavailable", null],
      clickJump: ["unavailable", null],
      capsuleJump: ["unavailable", null],
      sourceModeChange: ["unavailable", null]
    }
  };
  for (const state of Object.keys(table)) {
    for (const type of events) {
      const [next, persist] = table[state][type];
      assert.deepEqual(followReducer(state, { type }), { state: next, persist }, `${state}+${type}`);
    }
  }
  assert.deepEqual(followReducer("on", { type: "sourceAvailable", available: false }), {
    state: "unavailable",
    persist: null
  });
  assert.deepEqual(followReducer("unavailable", { type: "sourceAvailable", available: true, stored: "0" }), {
    state: "off",
    persist: null
  });
  assert.deepEqual(followReducer("unavailable", { type: "sourceAvailable", available: true }), {
    state: "on",
    persist: null
  });
  assert.deepEqual(followReducer("paused", { type: "sourceAvailable", available: true }), {
    state: "paused",
    persist: null
  });
  const persisted = [];
  for (const state of Object.keys(table)) {
    for (const type of [...events, "sourceAvailable"]) {
      const event = type === "sourceAvailable" ? { type, available: false } : { type };
      const result = followReducer(state, event);
      if (result.persist != null) persisted.push(`${state}+${type}`);
      assert.notEqual(result.persist, "paused");
    }
  }
  assert.deepEqual(persisted.sort(), ["off+toggle", "on+toggle"]);
});

test("jump lock uses an injected clock and unlocks on reader input", () => {
  let now = 1000;
  const lock = createJumpLock({ now: () => now, holdMs: 1500 });
  assert.equal(lock.locked, false);
  lock.lock();
  assert.equal(lock.until, 2500);
  assert.equal(lock.locked, true);
  now = 2499;
  assert.equal(lock.locked, true);
  now = 2500;
  assert.equal(lock.locked, false);
  lock.lock(10);
  assert.equal(lock.until, 1510);
  lock.unlock();
  assert.equal(lock.locked, false);
  assert.equal(isUnlockEvent({ type: "wheel" }), true);
  assert.equal(isUnlockEvent({ type: "touchstart" }), true);
  assert.equal(isUnlockEvent({ type: "pointerdown", onScrollSurface: true }), true);
  assert.equal(isUnlockEvent({ type: "pointerdown", onScrollSurface: false }), false);
  for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", " ", "Home", "End", "j", "k"]) {
    assert.equal(isUnlockEvent({ type: "keydown", key }), true, key);
  }
  assert.equal(isUnlockEvent({ type: "keydown", key: "f" }), false);
  assert.equal(isUnlockEvent({ type: "click" }), false);
  assert.equal(pairClickKept({ dx: 3, dy: 2, collapsed: true }), true);
  assert.equal(pairClickKept({ dx: 5, dy: 0, collapsed: true }), false);
  assert.equal(pairClickKept({ dx: 0, dy: 0, collapsed: false }), false);
  assert.equal(pairClickKept({ dx: 0, dy: 0, blocked: true }), false);
});

test("source follow target and translation jump land on the spec lines", () => {
  assert.equal(sourceFollowScroll({
    rectTop: 100,
    rectBottom: 180,
    scrollTop: 40,
    clientHeight: 400,
    scrollHeight: 2000
  }), null);
  const moved = sourceFollowScroll({
    rectTop: 900,
    rectBottom: 980,
    scrollTop: 40,
    clientHeight: 400,
    scrollHeight: 2000
  });
  assert.equal(moved, sourceAnchorScroll({ rectTop: 900, clientHeight: 400, scrollHeight: 2000 }));
  assert.equal(moved, 900 - PAIR_ANCHOR * 400);
  assert.equal(sourceAnchorScroll({ rectTop: 10, clientHeight: 400, scrollHeight: 2000 }), 0);
  assert.equal(sourceAnchorScroll({ rectTop: 5000, clientHeight: 400, scrollHeight: 2000 }), 1600);

  const pane = 800;
  const shortTop = 2000;
  const short = translationJumpScroll({
    blockTopInContent: shortTop,
    blockHeight: 100,
    paneHeight: pane,
    scrollHeight: 6000
  });
  assert.equal(short, shortTop - PAIR_ANCHOR * pane);
  const tallHeight = pane - 48 + 30;
  const tall = translationJumpScroll({
    blockTopInContent: shortTop,
    blockHeight: tallHeight,
    paneHeight: pane,
    scrollHeight: 6000
  });
  assert.equal(tall, shortTop - 8);
  const direct = clearFadeScroll({
    wantTop: shortTop,
    paneHeight: pane,
    blockHeight: tallHeight + 12,
    blockTopInPane: shortTop
  });
  assert.equal(tall, direct);
  assert.equal(PAIR_BG_SPREAD, 12);
  const spreadHeight = 516;
  const spread = translationJumpScroll({
    blockTopInContent: shortTop,
    blockHeight: spreadHeight,
    paneHeight: pane,
    scrollHeight: 6000
  });
  const onAnchor = shortTop - PAIR_ANCHOR * pane;
  const withOutset = shortTop - (pane - 40 - (spreadHeight + 12));
  assert.notEqual(spread, onAnchor);
  assert.equal(spread, withOutset);

  const entries = [
    { pairId: "a", top: 0, bottom: 50 },
    { pairId: "b", top: 80, bottom: 140 }
  ];
  const proposed = 70;
  const nudged = nudgeScrollToPair({
    proposed,
    entries,
    anchorOffset: 20,
    targetId: "b"
  });
  assert.equal(Math.abs(nudged - proposed) <= 1, true);
  assert.equal(blockAtAnchor(entries, nudged + 20).pairId, "b");
});

test("reader.follow defaults on and source side defaults to start", () => {
  const fresh = readReaderPrefs({});
  assert.equal(fresh.follow, true);
  assert.equal(fresh.sourceSide, "start");
  const store = {};
  writeReaderPrefs(store, { follow: false, sourceSide: "end" });
  assert.equal(store["reader.follow"], "0");
  assert.equal(store["reader.sourceSide"], "end");
  assert.equal(readReaderPrefs(store).follow, false);
  assert.equal(readReaderPrefs(store).sourceSide, "end");
  assert.equal(readReaderPrefs({ "reader.follow": "1" }).follow, true);
  assert.equal(appliedSourceSide(1440, "end"), "end");
  assert.equal(appliedSourceSide(899, "end"), "start");
  assert.deepEqual(visualPaneOrder("start"), ["source", "split", "translation"]);
  assert.deepEqual(visualPaneOrder("end"), ["translation", "split", "source"]);
  assert.equal(sourcePageLabel(3, 15), "第 3/15 页");
  assert.equal(pageArrivalText(4), "已到第 4 页");
});

test("split pointer ratio mirrors arrows and menuNext skips separators", () => {
  const rect = { x: 0, width: 1008, end: 1008 };
  const splitW = 8;
  const low = splitPointerRatio({ clientX: 200, rect, splitW, side: "start" });
  const high = splitPointerRatio({ clientX: 700, rect, splitW, side: "start" });
  assert.ok(high > low);
  const towardOrigin = splitPointerRatio({ clientX: 200, rect, splitW, side: "end" });
  const towardEnd = splitPointerRatio({ clientX: 700, rect, splitW, side: "end" });
  assert.ok(towardOrigin > towardEnd);
  assert.deepEqual(splitKeyStep({ key: "ArrowLeft", side: "start" }), { delta: -16 });
  assert.deepEqual(splitKeyStep({ key: "ArrowRight", shift: true, side: "start" }), { delta: 64 });
  assert.deepEqual(splitKeyStep({ key: "ArrowLeft", side: "end" }), { delta: 16 });
  assert.deepEqual(splitKeyStep({ key: "ArrowRight", side: "end" }), { delta: -16 });
  assert.deepEqual(splitKeyStep({ key: "Home" }), { to: "min" });
  assert.deepEqual(splitKeyStep({ key: "End" }), { to: "max" });
  assert.deepEqual(splitKeyStep({ key: "Enter" }), { to: "reset" });

  const items = [
    { id: "swap" },
    { separator: true },
    { id: "md", disabled: true },
    { id: "pdf" }
  ];
  assert.equal(menuNext(items, 0, "ArrowDown"), 3);
  assert.equal(menuNext(items, 3, "ArrowUp"), 0);
  assert.equal(menuNext(items, 3, "ArrowDown"), 3);
  assert.equal(menuNext(items, 0, "Home"), 0);
  assert.equal(menuNext(items, 0, "End"), 3);
  assert.equal(moreMenuModel(1440).map((item) => item.id).join(","), "swap,sep,exportMd,exportPdf");
  assert.equal(moreMenuModel(899).some((item) => item.id === "swap"), false);
  const box = pairBoxStyle({ p: 1, x: 61.2, y: 79.2, w: 122.4, h: 39.6 }, 612, 792, 5);
  assert.equal(box.x, "calc(10% - 5px)");
  assert.equal(box.y, "calc(10% - 5px)");
  assert.equal(box.w, "calc(20% + 10px)");
  assert.equal(box.h, "calc(5% + 10px)");
});

test("pairing module and its names avoid physical side words", () => {
  const source = readFileSync(join(root, "lib/pdf-pairing.js"), "utf8");
  assert.doesNotMatch(source, /\b(left|right)\b/);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const names = [
    "pairNodeFromEvent", "pairControlBlocked", "onFlowPointerDown", "onFlowPointerUp",
    "jumpTranslationToSource", "revealSourcePage", "scrollSourceToRect", "rectInSource",
    "writeTranslationJump", "refreshPairCurrent", "followSourceToCurrent", "paintPairChrome",
    "drawPairBoxes", "applyFollow", "toggleFollow", "noteUserSourceInput", "syncFollowControls",
    "onSourceClick", "stampFlowPairs", "applySourceSide", "reorderPanes", "toggleSourceSide",
    "bindMoreMenu", "onMenuKey", "onSplitKey", "applySplit", "noteSourcePage",
    "syncToolbarFromCapsule",
    "onSourceContentTouchStart", "onSourceContentTouchMove", "onSourceContentTouchEnd",
    "revealClickedSource"
  ];
  for (const name of names) {
    const body = functionBody(viewer, name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(body, /\b(left|right)\b/, name);
  }
});

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(name);
}
