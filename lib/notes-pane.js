/**
 * Three-column notes layout (LAYOUT-THREE-PANE, Wisdom 2026-10-13 02:16).
 * Width keys stay in notes-prefs.js. This file is the geometry.
 * NOTES_TRANSLATE_MIN is the three-pane translation floor. Wisdom may still
 * change 618; keep that change on this constant.
 */

import { splitAriaModel, splitLayout } from "./pdf-reader-flow.js";
import {
  NOTES_PANE_WIDTH_DEFAULT,
  NOTES_PANE_WIDTH_MAX,
  NOTES_PANE_WIDTH_MIN,
  normalizeNotesPaneSide,
  normalizeNotesWidth
} from "./notes-prefs.js";

export const NOTES_TRANSLATE_MIN = 618;
export const NOTES_SOURCE_MIN = 320;
export const NOTES_PANE_GAP = 8;
export const NOTES_PANE_HYSTERESIS = 16;
export const NOTES_PANE_RESIZE_DEBOUNCE_MS = 150;
export const NOTES_DRAWER_DOCKED = 288;
export const NOTES_THREE_MIN_WINDOW = 1200;

export function notesThreeThreshold(notesWidth) {
  const width = normalizeNotesWidth(notesWidth);
  return NOTES_SOURCE_MIN + NOTES_PANE_GAP + NOTES_TRANSLATE_MIN + NOTES_PANE_GAP + width;
}

export function notesWorkspaceWidth({ windowWidth = 0, measured = null, drawerDocked = false } = {}) {
  const windowPx = Number(windowWidth) || 0;
  const seen = Number(measured);
  if (drawerDocked) {
    const reduced = Math.max(0, windowPx - NOTES_DRAWER_DOCKED);
    return Number.isFinite(seen) && seen > 0 ? Math.min(seen, reduced) : reduced;
  }
  if (Number.isFinite(seen) && seen > 0) return seen;
  return windowPx;
}

export function notesSideFromSource(sourceSide) {
  return sourceSide === "end" ? "start" : "end";
}

export function sourceSideFromNotes(notesSide) {
  return normalizeNotesPaneSide(notesSide) === "start" ? "end" : "start";
}

export function notesFitsThree({ windowWidth, workspaceWidth, notesWidth } = {}) {
  if (!((Number(windowWidth) || 0) >= NOTES_THREE_MIN_WINDOW)) return false;
  return (Number(workspaceWidth) || 0) >= notesThreeThreshold(notesWidth);
}

/**
 * `opening` uses the raw threshold. A later resize stays put until ±16px.
 * `pinned` is a mode the user picked while notes were open: mini stays in
 * the side slot, hidden stays in the translation + notes pair.
 */
export function notesChromeKind({
  windowWidth,
  workspaceWidth,
  notesWidth,
  latched = "",
  opening = false,
  pinned = ""
} = {}) {
  const width = Number(windowWidth) || 0;
  if (width < 900) return "sheet";
  if (pinned === "hidden") return width >= NOTES_THREE_MIN_WINDOW ? "pair" : "slot";
  if (pinned === "mini") return "slot";
  if (width < NOTES_THREE_MIN_WINDOW) return "slot";
  if (opening || (latched !== "three" && latched !== "slot")) {
    return notesFitsThree({ windowWidth: width, workspaceWidth, notesWidth }) ? "three" : "slot";
  }
  const threshold = notesThreeThreshold(notesWidth);
  const space = Number(workspaceWidth) || 0;
  if (latched === "three") {
    // Below the threshold the 320 / 618 floors cannot both hold. Leave at once.
    // The ±16px band still delays coming back up into three columns.
    const columns = threePaneColumns({ workspaceWidth: space, notesWidth, splitRatio: 0.5 });
    if (columns.source < NOTES_SOURCE_MIN || columns.translate < NOTES_TRANSLATE_MIN) return "slot";
    return space < threshold - NOTES_PANE_HYSTERESIS ? "slot" : "three";
  }
  return space >= threshold + NOTES_PANE_HYSTERESIS ? "three" : "slot";
}

export function threePaneColumns({ workspaceWidth, notesWidth, splitRatio = 0.5 } = {}) {
  const width = Number(workspaceWidth) || 0;
  const notes = normalizeNotesWidth(notesWidth);
  const rest = width - notes - 2 * NOTES_PANE_GAP;
  const layout = splitLayout({
    width: rest + NOTES_PANE_GAP,
    ratio: splitRatio == null ? 0.5 : splitRatio,
    splitW: NOTES_PANE_GAP,
    sourceMin: NOTES_SOURCE_MIN,
    translateMin: NOTES_TRANSLATE_MIN
  });
  return {
    notes,
    gap: NOTES_PANE_GAP,
    source: layout.source,
    translate: layout.translate,
    ratio: layout.ratio,
    rest
  };
}

/** Largest notes width that still leaves 320 + 618 and both gaps. */
export function notesWidthLimit(workspaceWidth) {
  const width = Number(workspaceWidth) || 0;
  const fit = Math.floor(width - (NOTES_SOURCE_MIN + NOTES_PANE_GAP + NOTES_TRANSLATE_MIN + NOTES_PANE_GAP));
  if (fit < NOTES_PANE_WIDTH_MIN) return NOTES_PANE_WIDTH_MIN;
  return Math.min(NOTES_PANE_WIDTH_MAX, fit);
}

export function clampDraggedNotesWidth({ workspaceWidth, requested } = {}) {
  const limit = notesWidthLimit(workspaceWidth);
  const raw = Number(requested);
  const next = Number.isFinite(raw) ? Math.round(raw) : NOTES_PANE_WIDTH_DEFAULT;
  return Math.min(limit, Math.max(NOTES_PANE_WIDTH_MIN, next));
}

export function notesSplitAria({ notesWidth, workspaceWidth } = {}) {
  const now = clampDraggedNotesWidth({ workspaceWidth, requested: normalizeNotesWidth(notesWidth) });
  const max = notesWidthLimit(workspaceWidth);
  return {
    valuenow: now,
    valuemin: NOTES_PANE_WIDTH_MIN,
    valuemax: max,
    valuetext: `笔记栏 ${now} 像素`,
    bubble: `笔记栏 ${now}px`,
    label: "调整笔记栏宽度"
  };
}

export function threeSourceAria({ workspaceWidth, notesWidth, splitRatio } = {}) {
  const columns = threePaneColumns({ workspaceWidth, notesWidth, splitRatio });
  return splitAriaModel({
    width: columns.rest + NOTES_PANE_GAP,
    ratio: columns.ratio,
    splitW: NOTES_PANE_GAP,
    sourceMin: NOTES_SOURCE_MIN,
    translateMin: NOTES_TRANSLATE_MIN
  });
}

/** Toward the translation pane, the notes column grows. */
export function notesSplitKeyStep({ key, shift = false, notesSide = "end" } = {}) {
  const step = shift ? 64 : 16;
  const side = normalizeNotesPaneSide(notesSide);
  if (key === "Home") return { to: "min" };
  if (key === "End") return { to: "max" };
  if (key === "Enter") return { to: "reset" };
  if (key === "ArrowLeft") return { delta: side === "end" ? step : -step };
  if (key === "ArrowRight") return { delta: side === "end" ? -step : step };
  return null;
}

export function notesDomOrder({ layout = "", notesSide = "end", sourceSide = "start" } = {}) {
  const notes = normalizeNotesPaneSide(notesSide);
  if (layout === "3") {
    return notes === "start"
      ? ["notes", "splitB", "translate", "splitA", "source"]
      : ["source", "splitA", "translate", "splitB", "notes"];
  }
  if (layout === "pair") {
    return notes === "start"
      ? ["notes", "splitB", "translate", "source", "splitA"]
      : ["translate", "splitB", "notes", "source", "splitA"];
  }
  const main = sourceSide === "end"
    ? ["translate", "splitA", "source"]
    : ["source", "splitA", "translate"];
  return [...main, "splitB", "notes"];
}

export function reorderWorkspacePanes(workspace, order) {
  if (!workspace) return;
  const map = {
    source: workspace.querySelector("#pdfPane"),
    splitA: workspace.querySelector('.split-handle[data-split="source"]'),
    translate: workspace.querySelector(".pane-translate"),
    splitB: workspace.querySelector('.split-handle[data-split="notes"]'),
    notes: workspace.querySelector("#sideSlot")
  };
  const pages = workspace.querySelector("#pages");
  const translateScroll = workspace.querySelector("#translateScroll");
  const list = workspace.querySelector(".oi-notes-scroll");
  const saved = {
    pages: pages?.scrollTop || 0,
    translate: translateScroll?.scrollTop || 0,
    list: list?.scrollTop || 0
  };
  for (const name of order || []) {
    const node = map[name];
    if (node && node.parentElement === workspace) workspace.append(node);
  }
  if (pages) pages.scrollTop = saved.pages;
  if (translateScroll) translateScroll.scrollTop = saved.translate;
  if (list) list.scrollTop = saved.list;
}

export function applyNotesSplitAria(handle, model) {
  if (!handle || !model) return;
  handle.setAttribute("aria-valuemin", String(model.valuemin));
  handle.setAttribute("aria-valuemax", String(model.valuemax));
  handle.setAttribute("aria-valuenow", String(model.valuenow));
  handle.setAttribute("aria-valuetext", model.valuetext);
  handle.setAttribute("aria-label", model.label);
  const bubble = handle.querySelector(".split-bubble");
  if (bubble) bubble.textContent = model.bubble;
}

export function notesSideMenuModel(side) {
  const current = normalizeNotesPaneSide(side);
  return {
    heading: "笔记位置",
    shortcut: "⇧M",
    items: [
      { side: "end", label: "笔记在右侧", checked: current === "end" },
      { side: "start", label: "笔记在左侧", checked: current === "start" }
    ]
  };
}

export function notesCloseTitle(layout) {
  return layout === "3" ? "关闭笔记（Esc）" : "关闭笔记，回到原文（Esc）";
}
