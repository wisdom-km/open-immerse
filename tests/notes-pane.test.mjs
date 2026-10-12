// NTP geometry, hysteresis, and the two width keys. No browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readReaderPrefs } from "../lib/pdf-reader-flow.js";
import { f6RegionIds } from "../lib/pdf-source-mode.js";
import {
  NOTES_PANE_SIDE_DEFAULT,
  NOTES_PANE_SIDE_KEY,
  NOTES_PANE_WIDTH_DEFAULT,
  NOTES_PANE_WIDTH_MAX,
  NOTES_PANE_WIDTH_MIN,
  NOTES_WIDTH_KEY,
  normalizeNotesPaneSide,
  normalizeNotesWidth,
  normalizePanelWidth,
  readNotesUiPrefs,
  writeNotesUiPrefs
} from "../lib/notes-prefs.js";
import {
  NOTES_DRAWER_DOCKED,
  NOTES_PANE_HYSTERESIS,
  NOTES_PANE_RESIZE_DEBOUNCE_MS,
  NOTES_TRANSLATE_MIN,
  clampDraggedNotesWidth,
  notesChromeKind,
  notesCloseTitle,
  notesDomOrder,
  notesFitsThree,
  notesSideFromSource,
  notesSideMenuModel,
  notesSplitAria,
  notesSplitKeyStep,
  notesThreeThreshold,
  notesWorkspaceWidth,
  sourceSideFromNotes,
  threePaneColumns,
  threeSourceAria
} from "../lib/notes-pane.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("NTP prefs keep notesWidth apart from panelWidth and reader prefs", () => {
  assert.equal(NOTES_WIDTH_KEY, "reader.notesWidth");
  assert.equal(NOTES_PANE_SIDE_KEY, "reader.notesPaneSide");
  assert.equal(NOTES_PANE_WIDTH_DEFAULT, 360);
  assert.equal(NOTES_PANE_WIDTH_MIN, 320);
  assert.equal(NOTES_PANE_WIDTH_MAX, 480);
  assert.equal(NOTES_PANE_SIDE_DEFAULT, "end");
  assert.equal(NOTES_TRANSLATE_MIN, 618);
  assert.equal(normalizeNotesWidth(null), 360);
  assert.equal(normalizeNotesWidth(""), 360);
  assert.equal(normalizeNotesWidth("nope"), 360);
  assert.equal(normalizeNotesWidth(10), 320);
  assert.equal(normalizeNotesWidth(900), 480);
  assert.equal(normalizeNotesWidth(420.4), 420);
  assert.equal(normalizePanelWidth(null), 440);
  assert.equal(normalizeNotesPaneSide(null), "end");
  assert.equal(normalizeNotesPaneSide("start"), "start");
  assert.equal(normalizeNotesPaneSide("left"), "end");
  const storage = {};
  const written = writeNotesUiPrefs(storage, { notesWidth: 420, notesPaneSide: "start" });
  assert.equal(written.notesWidth, 420);
  assert.equal(written.notesPaneSide, "start");
  assert.equal(written.panelWidth, 440);
  assert.equal(storage["reader.notesWidth"], "420");
  assert.equal(storage["reader.notesPaneSide"], "start");
  assert.equal(readNotesUiPrefs(storage).notesWidth, 420);
  writeNotesUiPrefs(storage, { panelWidth: 500 });
  assert.equal(readNotesUiPrefs(storage).notesWidth, 420);
  assert.equal(readNotesUiPrefs(storage).panelWidth, 500);
  storage["reader.notesWidth"] = "";
  assert.equal(readNotesUiPrefs(storage).notesWidth, 360);
  const reader = readReaderPrefs(storage);
  assert.equal(Object.hasOwn(reader, "notesWidth"), false);
  assert.equal(Object.hasOwn(reader, "notesPaneSide"), false);
  assert.equal(Object.hasOwn(reader, "panelWidth"), false);
  const prefsSrc = readFileSync(join(root, "lib/notes-prefs.js"), "utf8");
  assert.equal(prefsSrc.includes("normalizePanelWidth(storageGet(storage, NOTES_WIDTH_KEY)"), false);
  assert.match(prefsSrc, /export function normalizeNotesWidth/);
});

test("NTP-02/03/04/05 width formula, threshold, and hysteresis", () => {
  assert.equal(notesThreeThreshold(360), 1314);
  assert.equal(notesThreeThreshold(320), 1274);
  assert.equal(notesThreeThreshold(480), 1434);
  assert.equal(notesFitsThree({ windowWidth: 1314, workspaceWidth: 1314, notesWidth: 360 }), true);
  assert.equal(notesFitsThree({ windowWidth: 1297, workspaceWidth: 1297, notesWidth: 360 }), false);
  assert.equal(notesFitsThree({ windowWidth: 1100, workspaceWidth: 1100, notesWidth: 360 }), false);
  assert.equal(notesChromeKind({ windowWidth: 1440, workspaceWidth: 1440, notesWidth: 360, opening: true }), "three");
  assert.equal(notesChromeKind({ windowWidth: 1314, workspaceWidth: 1314, notesWidth: 360, opening: true }), "three");
  assert.equal(notesChromeKind({ windowWidth: 1297, workspaceWidth: 1297, notesWidth: 360, opening: true }), "slot");
  assert.equal(notesChromeKind({ windowWidth: 1100, workspaceWidth: 1100, notesWidth: 360, opening: true }), "slot");
  assert.equal(notesChromeKind({ windowWidth: 600, workspaceWidth: 600, notesWidth: 360, opening: true }), "sheet");
  const down = notesChromeKind({
    windowWidth: 1297,
    workspaceWidth: 1297,
    notesWidth: 360,
    latched: "three"
  });
  assert.equal(down, "slot");
  assert.equal(notesChromeKind({
    windowWidth: 1300,
    workspaceWidth: 1300,
    notesWidth: 360,
    latched: "three"
  }), "three");
  assert.equal(notesChromeKind({
    windowWidth: 1329,
    workspaceWidth: 1329,
    notesWidth: 360,
    latched: "slot"
  }), "slot");
  assert.equal(notesChromeKind({
    windowWidth: 1330,
    workspaceWidth: 1330,
    notesWidth: 360,
    latched: "slot"
  }), "three");
  assert.equal(NOTES_PANE_HYSTERESIS, 16);
  assert.equal(NOTES_PANE_RESIZE_DEBOUNCE_MS, 150);
  const wide = threePaneColumns({ workspaceWidth: 1440, notesWidth: 360, splitRatio: 0.5 });
  assert.equal(wide.notes, 360);
  assert.equal(wide.source, 446);
  assert.equal(wide.translate, 618);
  assert.ok(wide.translate >= NOTES_TRANSLATE_MIN);
  const bigger = threePaneColumns({ workspaceWidth: 1680, notesWidth: 360, splitRatio: 0.5 });
  assert.equal(bigger.source, 652);
  assert.equal(bigger.translate, 652);
  const edge = threePaneColumns({ workspaceWidth: 1314, notesWidth: 360, splitRatio: 0.5 });
  assert.equal(edge.source, 320);
  assert.equal(edge.translate, 618);
});

test("NTP-06/09/11 side mapping, drag clamp, and drawer width", () => {
  assert.equal(notesSideFromSource("start"), "end");
  assert.equal(notesSideFromSource("end"), "start");
  assert.equal(sourceSideFromNotes("end"), "start");
  assert.equal(sourceSideFromNotes("start"), "end");
  assert.deepEqual(notesDomOrder({ layout: "3", notesSide: "end" }), ["source", "splitA", "translate", "splitB", "notes"]);
  assert.deepEqual(notesDomOrder({ layout: "3", notesSide: "start" }), ["notes", "splitB", "translate", "splitA", "source"]);
  assert.equal(clampDraggedNotesWidth({ workspaceWidth: 1440, requested: 100 }), 320);
  assert.equal(clampDraggedNotesWidth({ workspaceWidth: 1440, requested: 900 }), 480);
  assert.equal(clampDraggedNotesWidth({ workspaceWidth: 1314, requested: 400 }), 360);
  const squeezed = threePaneColumns({ workspaceWidth: 1314, notesWidth: 360, splitRatio: 0.5 });
  assert.ok(squeezed.source >= 320);
  assert.ok(squeezed.translate >= 618);
  assert.equal(notesWorkspaceWidth({ windowWidth: 1440, measured: 1440, drawerDocked: true }), 1440 - NOTES_DRAWER_DOCKED);
  assert.equal(NOTES_DRAWER_DOCKED, 288);
  assert.equal(notesChromeKind({
    windowWidth: 1440,
    workspaceWidth: 1152,
    notesWidth: 360,
    opening: true
  }), "slot");
  assert.equal(notesChromeKind({
    windowWidth: 1440,
    workspaceWidth: 1440,
    notesWidth: 360,
    latched: "slot"
  }), "three");
});

test("NTP-12/18/19 aria, keyboard, pins, and menu copy", () => {
  const aria = notesSplitAria({ notesWidth: 360, workspaceWidth: 1440 });
  assert.equal(aria.valuenow, 360);
  assert.equal(aria.valuemin, 320);
  assert.equal(aria.valuemax, 480);
  assert.equal(aria.valuetext, "笔记栏 360 像素");
  assert.equal(aria.bubble, "笔记栏 360px");
  assert.equal(aria.label, "调整笔记栏宽度");
  const narrow = notesSplitAria({ notesWidth: 360, workspaceWidth: 1314 });
  assert.equal(narrow.valuemax, 360);
  const source = threeSourceAria({ workspaceWidth: 1440, notesWidth: 360, splitRatio: 0.5 });
  assert.match(source.valuetext, /^原文栏 \d+%$/);
  assert.match(source.bubble, /^原文栏 \d+%$/);
  assert.equal(notesSplitKeyStep({ key: "Enter" }).to, "reset");
  assert.equal(notesSplitKeyStep({ key: "ArrowLeft", notesSide: "end" }).delta, 16);
  assert.equal(notesSplitKeyStep({ key: "ArrowRight", shift: true, notesSide: "end" }).delta, -64);
  assert.equal(notesSplitKeyStep({ key: "ArrowRight", notesSide: "start" }).delta, 16);
  assert.equal(notesSplitKeyStep({ key: "Home" }).to, "min");
  assert.equal(notesSplitKeyStep({ key: "End" }).to, "max");
  assert.equal(notesChromeKind({
    windowWidth: 1440,
    workspaceWidth: 1440,
    notesWidth: 360,
    pinned: "mini"
  }), "slot");
  assert.equal(notesChromeKind({
    windowWidth: 1440,
    workspaceWidth: 1440,
    notesWidth: 360,
    pinned: "hidden"
  }), "pair");
  assert.equal(notesChromeKind({
    windowWidth: 1100,
    workspaceWidth: 1100,
    notesWidth: 360,
    pinned: "hidden"
  }), "slot");
  const menu = notesSideMenuModel("end");
  assert.equal(menu.heading, "笔记位置");
  assert.equal(menu.shortcut, "⇧M");
  assert.equal(menu.items[0].label, "笔记在右侧");
  assert.equal(menu.items[0].checked, true);
  assert.equal(menu.items[1].label, "笔记在左侧");
  assert.equal(notesSideMenuModel("start").items[1].checked, true);
  assert.equal(notesCloseTitle("3"), "关闭笔记（Esc）");
  assert.equal(notesCloseTitle(""), "关闭笔记，回到原文（Esc）");
  assert.deepEqual(
    f6RegionIds({ notesLayout: "3", side: "start" }),
    ["toolbar", "source", "translation", "notes"]
  );
  assert.deepEqual(
    f6RegionIds({ notesLayout: "3", side: "end" }),
    ["toolbar", "notes", "translation", "source"]
  );
  assert.deepEqual(
    f6RegionIds({ notesLayout: "pair", notesSide: "start" }),
    ["toolbar", "notes", "translation"]
  );
  assert.deepEqual(f6RegionIds({ mode: "side", side: "start" }), ["toolbar", "source", "translation"]);
});

test("NTP viewer wiring stays beside the locked source-mode and import lines", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const panel = readFileSync(join(root, "pdf/notes-panel.js"), "utf8");
  const css = readFileSync(join(root, "pdf/notes-panel.css"), "utf8");
  const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
  assert.match(viewer, /NOTES_TRANSLATE_MIN|threePaneColumns/);
  assert.match(viewer, /notesTempUpgrade = stored/);
  assert.match(viewer, /chooseNotesSourceMode/);
  assert.match(viewer, /dataset\.layout === "3"/);
  assert.match(viewer, /event\.key === "M" \|\| event\.key === "m"/);
  assert.match(viewer, /NOTES_PANE_RESIZE_DEBOUNCE_MS/);
  assert.match(viewer, /persistSlotPanelWidth/);
  assert.match(css, /data-layout="3"/);
  assert.match(css, /visibility:\s*visible/);
  assert.match(tokens, /--oi-notes-pane-min:\s*320px/);
  assert.match(tokens, /--oi-notes-pane-max:\s*480px/);
  assert.match(tokens, /--oi-notes-pane-default:\s*360px/);
  assert.match(tokens, /--oi-notes-pane-w:\s*var\(--notes-width, 360px\)/);
  assert.match(panel, /notesSideMenuModel/);
  assert.match(readFileSync(join(root, "lib/notes-pane.js"), "utf8"), /笔记位置/);
  const menuAt = panel.indexOf("导入 JSON…");
  assert.match(panel.slice(menuAt, menuAt + 80), /root\.querySelector\("\.oi-notes-file"\)\?\.click\(\)/);
  assert.equal(panel.includes("标为已回答"), false);
});
