import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SETTINGS } from "../lib/storage.js";
import { wheelPageDelta } from "../lib/pdf-viewer.js";
import {
  PANE_SYNC_BEHAVIOR,
  SYNC_OWNER_IDLE_MS,
  alignScrollTop,
  clampSyncIdle,
  createScrollSyncGate,
  createSyncOwner,
  createWheelFlipGuard,
  normalizePdfScroll,
  planPaneFollow,
  readSoftPageFollow
} from "../lib/pdf-scroll.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const viewerCss = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const optionsHtml = readFileSync(join(root, "options/options.html"), "utf8");
const optionsJs = readFileSync(join(root, "options/options.js"), "utf8");
const storageSrc = readFileSync(join(root, "lib/storage.js"), "utf8");

test("pdfScroll.softPageFollow defaults false and only boolean true turns it on", () => {
  assert.equal(DEFAULT_SETTINGS.pdfScroll.softPageFollow, false);
  assert.equal(readSoftPageFollow(undefined), false);
  assert.equal(readSoftPageFollow({}), false);
  assert.equal(readSoftPageFollow({ pdfScroll: {} }), false);
  assert.equal(readSoftPageFollow({ pdfScroll: { softPageFollow: false } }), false);
  assert.equal(readSoftPageFollow({ pdfScroll: { softPageFollow: "true" } }), false);
  assert.equal(readSoftPageFollow({ pdfScroll: { softPageFollow: 1 } }), false);
  assert.equal(readSoftPageFollow({ pdfScroll: { softPageFollow: true } }), true);
  assert.deepEqual(normalizePdfScroll(null), { softPageFollow: false });
  assert.deepEqual(normalizePdfScroll({ softPageFollow: true, extra: 1 }), { softPageFollow: true });
  assert.deepEqual(
    normalizePdfScroll({ softPageFollow: true, ...{ softPageFollow: false } }),
    { softPageFollow: false }
  );
  assert.match(storageSrc, /normalizePdfScroll/);
  assert.match(storageSrc, /pdfScroll/);
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

test("page follow stays off by default and, when on, aligns only the driver's new page with auto", () => {
  assert.equal(PANE_SYNC_BEHAVIOR, "auto");
  assert.deepEqual(
    planPaneFollow({ softPageFollow: false, owner: "pdf", driver: "pdf", fromPage: 1, toPage: 4 }),
    { align: false, behavior: "auto" }
  );
  assert.equal(
    planPaneFollow({ softPageFollow: true, owner: "pdf", driver: "pdf", fromPage: 2, toPage: 2 }).align,
    false
  );
  assert.deepEqual(
    planPaneFollow({ softPageFollow: true, owner: "pdf", driver: "pdf", fromPage: 2, toPage: 3 }),
    { align: true, behavior: "auto" }
  );
  assert.equal(
    planPaneFollow({ softPageFollow: true, owner: "pdf", driver: "readout", fromPage: 2, toPage: 5 }).align,
    false
  );
  assert.equal(
    planPaneFollow({ softPageFollow: true, owner: "readout", driver: "readout", fromPage: 1, toPage: 2 }).align,
    true
  );
  assert.equal(
    planPaneFollow({ softPageFollow: true, owner: "click", driver: "pdf", fromPage: 1, toPage: 2 }).align,
    false
  );
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
    const plan = planPaneFollow({
      softPageFollow: true,
      owner,
      driver: "pdf",
      fromPage: 1,
      toPage: 2
    });
    assert.equal(plan.behavior, "auto");
    if (plan.align && owner === "pdf") followed += 1;
    assert.equal(
      planPaneFollow({
        softPageFollow: true,
        owner,
        driver: "pdf",
        fromPage: 2,
        toPage: 2
      }).align,
      false
    );
    assert.equal(
      planPaneFollow({
        softPageFollow: false,
        owner,
        driver: "pdf",
        fromPage: 1,
        toPage: 4
      }).align,
      false
    );
  } finally {
    if (gate.finish() === "release") owner = null;
  }
  assert.equal(followed, 1);
  assert.equal(owner, null);

  const right = createScrollSyncGate();
  let rightOwner = "readout";
  right.begin();
  assert.equal(right.noteEnd(), "defer");
  const rightPlan = planPaneFollow({
    softPageFollow: true,
    owner: rightOwner,
    driver: "readout",
    fromPage: 1,
    toPage: 8
  });
  assert.equal(rightPlan.align, true);
  assert.equal(rightPlan.behavior, "auto");
  if (right.finish() === "release") rightOwner = null;
  assert.equal(rightOwner, null);

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
  assert.match(viewerSrc, /planPaneFollow/);
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
    viewerSrc.indexOf("function paintSourceMark")
  );
  assert.match(click, /behavior:\s*PANE_SYNC_BEHAVIOR/);
  assert.match(click, /takeDriver\("click"\)/);
  assert.match(click, /mirror-source-mark|paintSourceMark/);
  const goPage = viewerSrc.slice(viewerSrc.indexOf("async function goPage"), viewerSrc.indexOf("function setMirrorZoom"));
  assert.match(goPage, /behavior:\s*PANE_SYNC_BEHAVIOR/);
  assert.match(goPage, /planPaneFollow/);
  assert.doesNotMatch(goPage, /smooth/);
  const follow = viewerSrc.slice(
    viewerSrc.indexOf("function onTranslateScroll"),
    viewerSrc.indexOf("function runtimeSend")
  );
  assert.match(follow, /driver:\s*"readout"/);
  assert.match(follow, /plan\.behavior !== PANE_SYNC_BEHAVIOR/);
  assert.doesNotMatch(follow, /scrollIntoView/);
  assert.match(viewerCss, /\.pages\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(viewerCss, /\.pages\s*\{[^}]*scroll-behavior:\s*auto/s);
  assert.match(viewerCss, /\.pane-translate-scroll\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(viewerCss, /\.pane-translate-scroll\s*\{[^}]*scroll-behavior:\s*auto/s);
});

test("options expose pdf soft follow above layout, default off, only with the PDF feature", () => {
  const features = optionsHtml.match(/id="panel-features"[\s\S]*?<\/section>/)[0];
  const advanced = optionsHtml.match(/id="panel-advanced"[\s\S]*?<\/section>/)[0];
  assert.match(features, /id="pdfReadingBox"/);
  assert.match(features, /id="pdfReadingBox"[\s\S]*id="pdfLayoutBox"/);
  assert.match(features, /id="pdfSoftPageFollow"/);
  assert.match(features, /左右栏换页跟随/);
  assert.match(
    features,
    /默认关闭。开启后，滚动换页时另一侧对齐到同一页；跟手瞬时对齐，不会拖尾。/
  );
  assert.equal(features.includes('id="pdfSoftPageFollow" type="checkbox" checked'), false);
  assert.match(features, /id="pdfReadingBox"[^>]*hidden/);
  assert.match(features, /id="pdfLayoutBox"[^>]*hidden/);
  assert.doesNotMatch(advanced, /id="pdfLayoutBox"|id="pdfSoftPageFollow"|id="pdfReadingBox"/);
  assert.match(optionsJs, /el\("pdfSoftPageFollow"\)\?\.checked === true/);
  assert.match(optionsJs, /pdfScroll: readPdfScroll\(\)/);
  assert.match(optionsJs, /input\.checked = value\?\.softPageFollow === true/);
  assert.match(optionsJs, /reading\.hidden = !on/);
  assert.match(optionsJs, /box\.hidden = !on/);
  assert.match(optionsJs, /data-feat="pdf"/);
});
