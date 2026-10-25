/**
 * Library side-panel width. Session value lives on --library-width.
 * No storage key (Q1=A). Mid band uses the source-column formula (Q3=A).
 */

import { splitLayout } from "./pdf-reader-flow.js";

export const LIBRARY_WIDTH_DEFAULT = 360;
export const LIBRARY_WIDTH_MIN = 320;
export const LIBRARY_WIDTH_MAX = 480;
export const LIBRARY_MID_MAX = 400;
export const LIBRARY_TRANSLATE_MIN = 618;
export const LIBRARY_WIDE_MIN = 1200;
export const LIBRARY_DOCK_MIN = 900;
export const LIBRARY_SPLIT = 8;
export const LIBRARY_SWITCH_FALLBACK_MS = 1500;
export const LIBRARY_CLICK_DEDUPE_MS = 300;
export const LIBRARY_SKELETON_MS = 300;

export function libraryBand(windowWidth) {
  const w = Number(windowWidth) || 0;
  if (w < LIBRARY_DOCK_MIN) return "sheet";
  if (w < LIBRARY_WIDE_MIN) return "mid";
  return "wide";
}

export function clampLibrarySessionWidth(value) {
  const n = Number(value);
  const raw = Number.isFinite(n) ? Math.round(n) : LIBRARY_WIDTH_DEFAULT;
  return Math.min(LIBRARY_WIDTH_MAX, Math.max(LIBRARY_WIDTH_MIN, raw));
}

/** Source column the reader would paint before the library takes a dock. */
export function librarySourceColumnWidth({
  workspaceWidth,
  splitRatio = 0.5,
  splitW = LIBRARY_SPLIT
} = {}) {
  const width = Number(workspaceWidth) || 0;
  if (width <= 0) return 0;
  return Math.round(splitLayout({
    width,
    ratio: splitRatio,
    splitW,
    sourceMin: LIBRARY_WIDTH_MIN,
    translateMin: LIBRARY_TRANSLATE_MIN
  }).source);
}

/**
 * Mid dock: max(320, min(source, 400)). If that leaves the translation
 * column under 618, use 320.
 */
export function libraryMidDisplayWidth({
  workspaceWidth,
  sourceWidth,
  splitW = LIBRARY_SPLIT
} = {}) {
  const workspace = Number(workspaceWidth) || 0;
  const source = Number(sourceWidth);
  const basis = Number.isFinite(source) && source > 0 ? source : LIBRARY_MID_MAX;
  let width = Math.max(LIBRARY_WIDTH_MIN, Math.min(basis, LIBRARY_MID_MAX));
  if (workspace > 0 && workspace - width - splitW < LIBRARY_TRANSLATE_MIN) width = LIBRARY_WIDTH_MIN;
  return Math.max(LIBRARY_WIDTH_MIN, Math.min(LIBRARY_MID_MAX, Math.round(width)));
}

/** Largest mid width that still leaves the translation column at least 618. */
export function libraryMidDragMax({ workspaceWidth, splitW = LIBRARY_SPLIT } = {}) {
  const workspace = Number(workspaceWidth) || 0;
  if (workspace <= 0) return LIBRARY_MID_MAX;
  const room = Math.floor(workspace - LIBRARY_TRANSLATE_MIN - splitW);
  return Math.max(LIBRARY_WIDTH_MIN, Math.min(LIBRARY_MID_MAX, room));
}

export function clampLibraryDrag({
  band = "wide",
  requested,
  workspaceWidth,
  splitW = LIBRARY_SPLIT
} = {}) {
  const raw = Number(requested);
  const next = Number.isFinite(raw) ? Math.round(raw) : LIBRARY_WIDTH_DEFAULT;
  if (band === "mid") {
    const max = libraryMidDragMax({ workspaceWidth, splitW });
    return Math.min(max, Math.max(LIBRARY_WIDTH_MIN, next));
  }
  return clampLibrarySessionWidth(next);
}

/**
 * Display width. A null session means the user has not dragged:
 * wide stays 360, mid uses the source-column formula.
 * A remembered session is clamped to the band and is not rewritten here.
 */
export function libraryDisplayWidth({
  windowWidth,
  workspaceWidth,
  sessionWidth = null,
  sourceWidth,
  splitRatio = 0.5,
  splitW = LIBRARY_SPLIT,
  layout = ""
} = {}) {
  const band = libraryBand(windowWidth);
  const dragged = sessionWidth != null && sessionWidth !== "";
  const session = dragged ? clampLibrarySessionWidth(sessionWidth) : LIBRARY_WIDTH_DEFAULT;
  if (band === "sheet") {
    return { band, width: 0, session, dragged, draggable: false, maxDrag: LIBRARY_WIDTH_MIN };
  }
  const workspace = Number(workspaceWidth) || Number(windowWidth) || 0;
  if (band === "wide") {
    let width = session;
    if (layout === "3") {
      const fit = Math.floor(workspace - (LIBRARY_WIDTH_MIN + splitW + LIBRARY_TRANSLATE_MIN + splitW));
      const limit = Math.min(LIBRARY_WIDTH_MAX, Math.max(LIBRARY_WIDTH_MIN, fit));
      width = Math.min(width, limit);
    }
    return {
      band,
      width: clampLibrarySessionWidth(width),
      session,
      dragged,
      draggable: true,
      maxDrag: LIBRARY_WIDTH_MAX
    };
  }
  const source = Number.isFinite(Number(sourceWidth)) && Number(sourceWidth) > 0
    ? Number(sourceWidth)
    : librarySourceColumnWidth({ workspaceWidth: workspace, splitRatio, splitW });
  const cap = libraryMidDragMax({ workspaceWidth: workspace, splitW });
  const width = dragged
    ? Math.min(session, cap)
    : Math.min(libraryMidDisplayWidth({ workspaceWidth: workspace, sourceWidth: source, splitW }), cap);
  return {
    band,
    width: Math.max(LIBRARY_WIDTH_MIN, Math.min(LIBRARY_MID_MAX, Math.round(width))),
    session,
    dragged,
    draggable: true,
    maxDrag: cap,
    source: Math.round(source)
  };
}

export function libraryClickFresh({
  lastHash = "",
  lastAt = 0,
  hash = "",
  at = 0,
  wait = LIBRARY_CLICK_DEDUPE_MS
} = {}) {
  if (!hash || !lastHash || lastHash !== hash) return true;
  return Number(at) - Number(lastAt) >= wait;
}

export function firstUnfinishedPage(pages, total) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const done = new Set();
  for (const page of pages || []) {
    const num = Math.floor(Number(page?.page) || 0);
    if (num > 0 && page?.done) done.add(num);
  }
  for (let i = 1; i <= n; i += 1) {
    if (!done.has(i)) return i;
  }
  return n > 0 ? n : 1;
}

/** Resolves "timeout" when work is still pending after ms. Does not cancel work. */
export function waitAtMost(promise, ms, timers = globalThis) {
  const limit = Number(ms) > 0 ? Number(ms) : LIBRARY_SWITCH_FALLBACK_MS;
  return new Promise((resolve) => {
    let settled = false;
    const timer = timers.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve("timeout");
    }, limit);
    Promise.resolve(promise).then(() => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      resolve("done");
    }, () => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      resolve("done");
    });
  });
}
