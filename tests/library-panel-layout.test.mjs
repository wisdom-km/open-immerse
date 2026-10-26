// LIB-01…25 width, tokens, and footer. Q1/Q3 = A.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIBRARY_MID_MAX,
  LIBRARY_SWITCH_FALLBACK_MS,
  LIBRARY_TRANSLATE_MIN,
  LIBRARY_WIDTH_DEFAULT,
  LIBRARY_WIDTH_MAX,
  LIBRARY_WIDTH_MIN,
  clampLibraryDrag,
  clampLibrarySessionWidth,
  libraryBand,
  libraryClickFresh,
  libraryDisplayWidth,
  libraryMidDisplayWidth,
  libraryMidDragMax,
  librarySourceColumnWidth
} from "../lib/library-layout.js";
import { LIBRARY_COPY, libraryNoHitCopy, libraryPausedCopy } from "../lib/library-copy.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

function frame(windowWidth, sessionWidth, layout) {
  const sourceWidth = librarySourceColumnWidth({ workspaceWidth: windowWidth, splitRatio: 0.5 });
  return libraryDisplayWidth({
    windowWidth,
    workspaceWidth: windowWidth,
    sessionWidth,
    sourceWidth,
    splitRatio: 0.5,
    layout
  });
}

function lin(channel) {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrast(hexA, hexB) {
  const lum = (hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const hi = Math.max(lum(hexA), lum(hexB));
  const lo = Math.min(lum(hexA), lum(hexB));
  return (hi + 0.05) / (lo + 0.05);
}

test("LIB-02/03/04/07 default 360, drag 320–480, mid formula keeps translate ≥ 618", () => {
  assert.equal(LIBRARY_WIDTH_DEFAULT, 360);
  assert.equal(LIBRARY_WIDTH_MIN, 320);
  assert.equal(LIBRARY_WIDTH_MAX, 480);
  assert.equal(clampLibrarySessionWidth(200), 320);
  assert.equal(clampLibrarySessionWidth(360), 360);
  assert.equal(clampLibrarySessionWidth(900), 480);
  assert.equal(libraryBand(1440), "wide");
  assert.equal(libraryBand(1200), "wide");
  assert.equal(libraryBand(1199), "mid");
  assert.equal(libraryBand(900), "mid");
  assert.equal(libraryBand(899), "sheet");

  const wide = frame(1440, null, "3");
  assert.equal(wide.band, "wide");
  assert.equal(wide.width, 360);
  assert.equal(wide.dragged, false);
  assert.equal(frame(1440, 320, "3").width, 320);
  assert.equal(frame(1440, 400, "3").width, 400);
  assert.equal(frame(1440, 480, "3").width, 480);
  assert.equal(clampLibraryDrag({ band: "wide", requested: 100, workspaceWidth: 1440 }), 320);
  assert.equal(clampLibraryDrag({ band: "wide", requested: 999, workspaceWidth: 1440 }), 480);

  for (const windowWidth of [1024, 1180]) {
    const shown = frame(windowWidth, null, "");
    assert.equal(shown.band, "mid");
    assert.ok(shown.width >= 320 && shown.width <= LIBRARY_MID_MAX, JSON.stringify(shown));
    assert.ok(windowWidth - shown.width - 8 >= LIBRARY_TRANSLATE_MIN, JSON.stringify(shown));
  }
  assert.equal(frame(1024, null, "").width, 398);
  assert.equal(frame(1180, null, "").width, 400);
  assert.equal(libraryMidDisplayWidth({
    workspaceWidth: 1024,
    sourceWidth: librarySourceColumnWidth({ workspaceWidth: 1024 })
  }), 398);

  const shrunk = frame(1024, 480, "");
  assert.equal(shrunk.session, 480);
  assert.equal(shrunk.width, libraryMidDragMax({ workspaceWidth: 1024 }));
  assert.ok(shrunk.width <= 400);
  assert.ok(1024 - shrunk.width - 8 >= LIBRARY_TRANSLATE_MIN);
  assert.equal(frame(1440, 480, "3").width, 480);
});

test("LIB-05/08 sheet has no dock width and a repeated click inside 300ms is one click", () => {
  const sheet = frame(860, 480, "");
  assert.equal(sheet.band, "sheet");
  assert.equal(sheet.width, 0);
  assert.equal(sheet.draggable, false);
  assert.equal(libraryClickFresh({ lastHash: "a", lastAt: 1000, hash: "a", at: 1299 }), false);
  assert.equal(libraryClickFresh({ lastHash: "a", lastAt: 1000, hash: "a", at: 1300 }), true);
  assert.equal(libraryClickFresh({ lastHash: "a", lastAt: 1000, hash: "b", at: 1000 }), true);
  assert.equal(LIBRARY_SWITCH_FALLBACK_MS, 1500);
});

test("LIB-09/10/23/24 tokens, footer link, and no --oi-font in the library panel", () => {
  const css = read("pdf/library-panel.css");
  const tokens = read("pdf/reader-tokens.css");
  assert.match(tokens, /--oi-reader-library-w:\s*clamp\(320px,\s*var\(--library-width,\s*360px\),\s*480px\)/);
  assert.match(tokens, /--oi-reader-library-min:\s*320px/);
  assert.match(tokens, /--oi-reader-library-max:\s*480px/);
  assert.match(tokens, /--oi-reader-library-pad-x:\s*12px/);
  assert.match(tokens, /--oi-reader-library-row-h:\s*56px/);
  assert.match(css, /\.oi-library\s*\{[^}]*flex:\s*1\s+1\s+auto;[^}]*width:\s*100%/s);
  assert.match(css, /\.oi-lib-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(css, /\.oi-lib-meta,\s*\n\.oi-lib-muted,\s*\n\.oi-lib-foot\s*\{[^}]*font-size:\s*12px/s);
  assert.match(css, /\.oi-lib-storage\s*\{[^}]*font:\s*500\s+12px\/1\.45[^}]*color:\s*var\(--oi-reader-link\)/s);
  assert.match(css, /\.oi-lib-storage:hover\s*\{[^}]*var\(--oi-reader-link-hover\)[^}]*text-underline-offset:\s*2px/s);
  assert.match(css, /\.oi-lib-foot-copy\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.oi-lib-nohit\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /\.oi-lib-skel-title\s*\{\s*width:\s*60%/);
  assert.match(css, /\.oi-lib-skel-meta\s*\{\s*width:\s*40%;\s*height:\s*10px/);
  assert.doesNotMatch(css, /--oi-font/);
  assert.doesNotMatch(css, /--set-/);
  assert.doesNotMatch(css, /--library-width/);
  assert.equal(LIBRARY_COPY.storageLink, "存储与备份 →");
  assert.equal(LIBRARY_COPY.empty, "还没有论文");
  assert.equal(libraryNoHitCopy("zzz"), "没有找到「zzz」");
  assert.equal(libraryPausedCopy(1, 4), "已暂停 · 25%");
  const pairs = [
    ["#0B4A8C", "#F6F3EC"],
    ["#0B4A8C", "#FFFFFF"],
    ["#0B4A8C", "#F4F0E9"],
    ["#0B4A8C", "#F2F5F0"],
    ["#0B4A8C", "#E8EDE6"],
    ["#B7CFFF", "#1C1D1F"],
    ["#B7CFFF", "#232427"]
  ];
  for (const [ink, paper] of pairs) {
    assert.ok(contrast(ink, paper) >= 4.5, `${ink} on ${paper} = ${contrast(ink, paper)}`);
  }
  const green = read("pdf/reader-tokens.css");
  assert.match(green, /--oi-reader-green-paper:\s*#E8EDE6/);
  assert.doesNotMatch(green.slice(green.indexOf('data-reader-theme="sepia"'), green.indexOf('data-reader-theme="green"')), /--oi-reader-link:/);
  assert.doesNotMatch(green.slice(green.indexOf('data-reader-theme="green"'), green.indexOf('data-reader-theme="dark"')), /--oi-reader-link:/);
});

test("an open library is a breakpoint column or a sheet, never the 8px split", () => {
  assert.equal(clampLibrarySessionWidth(8), LIBRARY_WIDTH_MIN);
  assert.equal(clampLibrarySessionWidth(0), LIBRARY_WIDTH_MIN);
  assert.ok(frame(1440, 8, "").width >= LIBRARY_WIDTH_MIN);
  assert.ok(frame(1440, 8, "3").width >= LIBRARY_WIDTH_MIN);
  assert.ok(frame(1024, 8, "").width >= LIBRARY_WIDTH_MIN);
  assert.equal(frame(860, 8, "").band, "sheet");
  assert.equal(frame(860, 8, "").width, 0);

  const css = read("pdf/library-panel.css");
  const mediaAt = css.indexOf("@media (max-width: 899px)");
  assert.ok(mediaAt > 0);
  assert.match(css, /minmax\(var\(--oi-reader-library-min\),\s*var\(--oi-reader-library-col,\s*var\(--oi-reader-library-w\)\)\)/);
  assert.match(css, /minmax\(var\(--oi-reader-library-min\),\s*var\(--oi-notes-pane-w,\s*var\(--oi-reader-library-w\)\)\)/);
  assert.ok(css.indexOf(".oi-library.is-open.is-sheet") < mediaAt);
  assert.match(
    css,
    /\.workspace\[data-library-open="true"\]:not\(\[data-layout="3"\]\):not\(\[data-layout="pair"\]\):not\(\[data-library-band="sheet"\]\)\s*\{[^}]*grid-template-areas:\s*"translate splitB library"/
  );

  const viewer = read("pdf/viewer.js");
  const openFn = viewer.slice(viewer.indexOf("function onLibraryOpenChange"), viewer.indexOf("function installLibraryUi"));
  assert.ok(openFn.indexOf("syncNotesChrome") < openFn.indexOf("slot.hidden = false"));
  assert.match(openFn, /frame\.width >= LIBRARY_WIDTH_MIN/);
  const paint = viewer.slice(viewer.indexOf("function paintLibraryFrame"), viewer.indexOf("function applyLibraryColumnDrag"));
  assert.match(paint, /Math\.max\(LIBRARY_WIDTH_MIN/);
  assert.doesNotMatch(css, /grid-template-columns:[^;]*var\(--oi-reader-split-w\)\s+var\(--oi-reader-library-col,/);
});

test("LIB-25 library drag does not write notes width keys", () => {
  const viewer = read("pdf/viewer.js");
  const persistNotes = viewer.slice(viewer.indexOf("function persistNotesColumnWidth"), viewer.indexOf("function librarySplitDragOn"));
  const persistSlot = viewer.slice(viewer.indexOf("function persistSlotPanelWidth"), viewer.indexOf("function setNotesSplitVisible"));
  assert.match(persistNotes, /libraryOpen === "true"\) return/);
  assert.match(persistSlot, /libraryOpen === "true"\) return/);
  assert.match(viewer, /function resetNotesSplit[\s\S]*?librarySessionWidth = LIBRARY_WIDTH_DEFAULT/);
  assert.doesNotMatch(viewer.slice(viewer.indexOf("function applyLibraryColumnDrag"), viewer.indexOf("function libraryNotesColumn")), /writeNotesPanelPrefs|reader\.panelWidth|reader\.notesWidth/);
  assert.match(read("lib/notes-pane.js"), /NOTES_THREE_MIN_WINDOW = 1200/);
  assert.match(read("lib/notes-pane.js"), /NOTES_TRANSLATE_MIN = 618/);
});
