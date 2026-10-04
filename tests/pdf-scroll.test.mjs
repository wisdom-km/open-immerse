import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SETTINGS } from "../lib/storage.js";
import { wheelPageDelta } from "../lib/pdf-viewer.js";
import { readReaderPrefs, writeReaderPrefs } from "../lib/pdf-reader-flow.js";
import { followReducer } from "../lib/pdf-pairing.js";
import {
  PANE_SYNC_BEHAVIOR,
  SYNC_OWNER_IDLE_MS,
  alignScrollTop,
  clampSyncIdle,
  createScrollSyncGate,
  createSyncOwner,
  createWheelFlipGuard,
  normalizePdfScroll,
  leftPaneScroll
} from "../lib/pdf-scroll.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const viewerCss = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const optionsHtml = readFileSync(join(root, "options/options.html"), "utf8");
const optionsJs = readFileSync(join(root, "options/options.js"), "utf8");
const storageSrc = readFileSync(join(root, "lib/storage.js"), "utf8");

test("reader.follow defaults on and legacy pdfScroll stays inert", () => {
  assert.equal(readReaderPrefs({}).follow, true);
  assert.equal(readReaderPrefs({ "reader.follow": "0" }).follow, false);
  const store = {};
  assert.equal(writeReaderPrefs(store, { follow: false }).follow, false);
  assert.equal(store["reader.follow"], "0");
  assert.equal(readReaderPrefs(store).follow, false);
  assert.equal(DEFAULT_SETTINGS.pdfScroll.softPageFollow, false);
  assert.deepEqual(normalizePdfScroll(null), { softPageFollow: false });
  assert.deepEqual(normalizePdfScroll({ softPageFollow: true, extra: 1 }), { softPageFollow: true });
  assert.deepEqual(
    normalizePdfScroll({ softPageFollow: true, ...{ softPageFollow: false } }),
    { softPageFollow: false }
  );
  assert.match(storageSrc, /normalizePdfScroll/);
  assert.match(storageSrc, /pdfScroll/);
  assert.match(storageSrc, /Deprecated/);
  assert.doesNotMatch(viewerSrc, /readSoftPageFollow|planPaneFollow|softPageFollow/);
});

test("wheel page delta ignores horizontal gestures, overflow, and a latched gesture", () => {
  assert.equal(wheelPageDelta({ deltaY: 40, atTop: true, atBottom: true, overflow: false }), 1);
  assert.equal(wheelPageDelta({ deltaY: -40, atTop: true, atBottom: true, overflow: false }), -1);
  assert.equal(wheelPageDelta({ deltaY: 40, atTop: false, atBottom: true, overflow: true }), 0);
  assert.equal(
    wheelPageDelta({ deltaX: 30, deltaY: 8, atBottom: true, overflow: false }),
    0
  );
  assert.equal(
    wheelPageDelta({ deltaX: 8, deltaY: 30, atBottom: true, overflow: false }),
    1
  );
  assert.equal(
    wheelPageDelta({ deltaX: 12, deltaY: 12, atBottom: true, overflow: false }),
    1
  );
  assert.equal(
    wheelPageDelta({ deltaY: 40, atBottom: true, overflow: false, gestureLatched: true }),
    0
  );
  assert.equal(wheelPageDelta({ deltaY: 0, deltaX: 0, atBottom: true, overflow: false }), 0);
});

test("one wheel gesture flips at most one page and the latch drops within 100ms", () => {
  const queued = [];
  const guard = createWheelFlipGuard({
    idleMs: 360,
    schedule(fn, ms) {
      assert.equal(ms, SYNC_OWNER_IDLE_MS);
      queued.push(fn);
      return queued.length;
    },
    cancel() {}
  });
  guard.beginGesture();
  assert.equal(guard.latched, false);
  const first = wheelPageDelta({
    deltaY: 24,
    atBottom: true,
    overflow: false,
    gestureLatched: guard.latched
  });
  assert.equal(first, 1);
  guard.consume();
  const second = wheelPageDelta({
    deltaY: 80,
    atBottom: true,
    overflow: false,
    gestureLatched: guard.latched
  });
  assert.equal(second, 0);
  queued.at(-1)();
  assert.equal(guard.latched, false);
  assert.equal(
    wheelPageDelta({ deltaY: 24, atBottom: true, overflow: false, gestureLatched: guard.latched }),
    1
  );
});

test("sync owner ignores the follower echo, promotes the other pane, and clears on release or idle", () => {
  assert.equal(clampSyncIdle(360), 100);
  assert.equal(clampSyncIdle(40), 40);
  const queued = [];
  const owner = createSyncOwner({
    idleMs: 360,
    schedule(fn, ms) {
      assert.ok(ms <= 100);
      queued.push(fn);
      return queued.length;
    },
    cancel() {}
  });
  owner.claim("pdf");
  assert.equal(owner.owner, "pdf");
  assert.equal(owner.ignores("readout"), true);
  assert.equal(owner.ignores("pdf"), false);
  const stale = queued[0];
  owner.release("readout");
  assert.equal(owner.owner, "pdf");
  owner.claim("readout");
  assert.equal(owner.owner, "readout");
  assert.equal(owner.ignores("pdf"), true);
  stale();
  assert.equal(owner.owner, "readout");
  owner.release("readout");
  assert.equal(owner.owner, null);
  owner.claim("click");
  queued.at(-1)();
  assert.equal(owner.owner, null);
});

test("block follow replaces page follow and still aligns with auto", () => {
  assert.equal(PANE_SYNC_BEHAVIOR, "auto");
  assert.equal(followReducer("on", { type: "userSourceScroll" }).state, "paused");
  assert.equal(followReducer("on", { type: "userSourceScroll" }).persist, null);
  assert.equal(followReducer("paused", { type: "resume" }).state, "on");
  assert.equal(followReducer("off", { type: "toggle" }).persist, "1");
  assert.equal(followReducer("on", { type: "toggle" }).persist, "0");
  const pane = {
    scrollTop: 40,
    getBoundingClientRect() {
      return { top: 100 };
    }
  };
  const node = {
    getBoundingClientRect() {
      return { top: 340 };
    }
  };
  assert.equal(alignScrollTop(pane, node), 280);
  assert.equal(alignScrollTop(pane, null), null);
});

test("same-frame scrollend still lets soft-follow align once", () => {
  const gate = createScrollSyncGate();
  let owner = "pdf";
  gate.begin();
  assert.equal(gate.noteEnd(), "defer");
  assert.equal(owner, "pdf");

  let followed = 0;
  try {
    assert.equal(PANE_SYNC_BEHAVIOR, "auto");
    const step = followReducer("on", { type: "userSourceScroll" });
    if (step.state === "paused" && step.persist == null && owner === "pdf") followed += 1;
    assert.equal(followReducer("paused", { type: "userSourceScroll" }).state, "paused");
    assert.equal(followReducer("off", { type: "userSourceScroll" }).state, "off");
  } finally {
    if (gate.finish() === "release") owner = null;
  }
  assert.equal(followed, 1);
  assert.equal(owner, null);

  const translationGate = createScrollSyncGate();
  let translationOwner = "readout";
  translationGate.begin();
  assert.equal(translationGate.noteEnd(), "defer");
  assert.equal(PANE_SYNC_BEHAVIOR, "auto");
  assert.equal(followReducer("on", { type: "clickJump" }).state, "on");
  if (translationGate.finish() === "release") translationOwner = null;
  assert.equal(translationOwner, null);

  const switched = createScrollSyncGate();
  let active = "pdf";
  let generation = 1;
  switched.begin();
  const scheduled = generation;
  switched.noteEnd();
  generation += 1;
  active = "readout";
  let crossed = 0;
  try {
    if (scheduled === generation && active === "pdf") crossed += 1;
  } finally {
    if (switched.finish() === "release" && active === "pdf") active = null;
  }
  assert.equal(crossed, 0);
  assert.equal(active, "readout");

  assert.equal(createScrollSyncGate().noteEnd(), "release");
});

test("viewer sync path has no smooth fight and no fixed 360ms lock", () => {
  assert.doesNotMatch(viewerSrc, /syncLock/);
  assert.doesNotMatch(viewerSrc, /behavior:\s*["']smooth["']/);
  assert.doesNotMatch(viewerSrc, /\b360\b/);
  assert.match(viewerSrc, /followReducer|sourceFollowScroll/);
  assert.match(viewerSrc, /PANE_SYNC_BEHAVIOR/);
  assert.match(viewerSrc, /scrollend/);
  assert.match(viewerSrc, /createScrollSyncGate/);
  assert.match(viewerSrc, /noteEnd\(\) === "defer"/);
  assert.match(viewerSrc, /pdfSyncGate\.begin\(\)/);
  assert.match(viewerSrc, /readoutSyncGate\.begin\(\)/);
  assert.match(viewerSrc, /takeDriver/);
  assert.match(viewerSrc, /followGeneration/);
  assert.match(viewerSrc, /wheelFlip\.latched/);
  assert.match(viewerSrc, /deltaX:\s*event\.deltaX/);
  assert.match(viewerSrc, /pane\.scrollTop = top/);
  const pdfWheel = viewerSrc.slice(viewerSrc.indexOf("function onPdfWheel"), viewerSrc.indexOf("function syncVisiblePage"));
  const readoutWheel = viewerSrc.slice(viewerSrc.indexOf("function onReadoutWheel"), viewerSrc.indexOf("function writeAnchorScroll"));
  assert.doesNotMatch(pdfWheel, /preventDefault/);
  assert.doesNotMatch(readoutWheel, /preventDefault/);
  const click = viewerSrc.slice(
    viewerSrc.indexOf("function onReadoutBlockClick"),
    viewerSrc.indexOf("function syncReadoutEmpty")
  );
  assert.match(click, /PANE_SYNC_BEHAVIOR|behavior:\s*"auto"/);
  assert.match(click, /takeDriver\("click"\)/);
  assert.match(click, /pair-box|is-pair-jump/);
  assert.doesNotMatch(click, /mirror-source-mark|paintSourceMark/);
  const goPage = viewerSrc.slice(viewerSrc.indexOf("async function goPage"), viewerSrc.indexOf("function setMirrorZoom"));
  assert.match(goPage, /behavior:\s*PANE_SYNC_BEHAVIOR/);
  assert.doesNotMatch(goPage, /planPaneFollow|syncReadoutToPage/);
  assert.doesNotMatch(goPage, /smooth/);
  const follow = viewerSrc.slice(
    viewerSrc.indexOf("function onTranslateScroll"),
    viewerSrc.indexOf("function runtimeSend")
  );
  assert.match(follow, /followSourceToCurrent/);
  assert.match(viewerSrc, /sourceFollowScroll/);
  assert.match(viewerSrc, /followReducer/);
  assert.doesNotMatch(follow, /scrollIntoView/);
  assert.doesNotMatch(follow, /planPaneFollow/);
  assert.match(viewerCss, /\.pages\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(viewerCss, /\.pages\s*\{[^}]*scroll-behavior:\s*auto/s);
  const pagesRule = viewerCss.match(/\.pages\s*\{[^}]*\}/s)?.[0] ?? "";
  const fallback = pagesRule.indexOf("align-items: center;");
  const safe = pagesRule.indexOf("align-items: safe center;");
  assert.ok(fallback >= 0 && safe > fallback);
  assert.match(viewerCss, /\.pane-translate-scroll\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(viewerCss, /\.pane-translate-scroll\s*\{[^}]*scroll-behavior:\s*auto/s);
});

test("options no longer expose page follow; pdf layout stays with the PDF feature", () => {
  const features = optionsHtml.match(/id="panel-features"[\s\S]*?<\/section>/)[0];
  const advanced = optionsHtml.match(/id="panel-advanced"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(features, /id="pdfSoftPageFollow"/);
  assert.doesNotMatch(features, /左右栏换页跟随/);
  assert.doesNotMatch(optionsHtml, /id="pdfSoftPageFollow"/);
  assert.doesNotMatch(optionsJs, /pdfSoftPageFollow/);
  assert.doesNotMatch(optionsJs, /readPdfScroll/);
  assert.match(features, /id="pdfLayoutBox"/);
  assert.match(features, /id="pdfLayoutBox"[^>]*hidden/);
  assert.doesNotMatch(advanced, /id="pdfLayoutBox"|id="pdfSoftPageFollow"/);
  assert.match(optionsJs, /box\.hidden = !on/);
  assert.match(optionsJs, /data-feat="pdf"/);
});

test("safe center makes the scrollable distance equal the overflow", () => {
  // Narrow pane at 100%: a 612px page in a 424px scrollport overflows 188px.
  // align-items: center could scroll only the right half (94px).
  const narrow = leftPaneScroll({ pageWidth: 612, clientWidth: 424 });
  assert.equal(narrow.overflow, 188);
  assert.equal(narrow.maxScrollLeft, 188);
  assert.equal(narrow.maxScrollLeft, narrow.overflow);
  assert.equal(narrow.centered, false);
  assert.equal(narrow.overflow / 2, 94);
  const fit = leftPaneScroll({ pageWidth: 612, clientWidth: 1000 });
  assert.deepEqual(fit, { overflow: 0, maxScrollLeft: 0, centered: true });
  const zoomed = leftPaneScroll({ pageWidth: Math.floor(612 * 1.25), clientWidth: 470 });
  assert.equal(zoomed.overflow, 765 - 470);
  assert.equal(zoomed.maxScrollLeft, zoomed.overflow);
  assert.deepEqual(leftPaneScroll({}), { overflow: 0, maxScrollLeft: 0, centered: false });
  assert.deepEqual(leftPaneScroll({ pageWidth: 100, clientWidth: 0 }), { overflow: 0, maxScrollLeft: 0, centered: false });
});
