/**
 * Device-local notes UI settings.
 * Same localStorage reader.* pattern as readReaderPrefs / writeReaderPrefs.
 * Kept separate because those two functions' return shape is locked by
 * tests/pdf-reader-flow.test.mjs. Do not fold these keys into that object.
 * Not chrome.storage.sync (T2a: settings stay on this device).
 */

export const NOTES_PANEL_WIDTH_KEY = "reader.panelWidth";
export const NOTES_PERSIST_HINT_KEY = "reader.notesPersistHintDismissed";
export const NOTES_WIDTH_KEY = "reader.notesWidth";
export const NOTES_PANE_SIDE_KEY = "reader.notesPaneSide";
export const NOTES_PANEL_WIDTH_DEFAULT = 440;
export const NOTES_PANEL_WIDTH_MIN = 360;
export const NOTES_PANEL_WIDTH_MAX = 640;
export const NOTES_PANE_WIDTH_DEFAULT = 360;
export const NOTES_PANE_WIDTH_MIN = 320;
export const NOTES_PANE_WIDTH_MAX = 480;
export const NOTES_PANE_SIDE_DEFAULT = "end";

function storageGet(storage, key) {
  if (!storage) return null;
  if (typeof storage.getItem === "function") return storage.getItem(key);
  if (Object.prototype.hasOwnProperty.call(storage, key)) return storage[key];
  return null;
}

function storageSet(storage, key, value) {
  if (!storage) return;
  if (typeof storage.setItem === "function") storage.setItem(key, value);
  else storage[key] = value;
}

export function normalizePanelWidth(value) {
  // A missing or cleared key is the default 440. Number(null) and Number("")
  // are 0, which would otherwise clamp to the 360 floor. That floor is not
  // reader.miniWidth (the source mini window, also default 360).
  if (value == null || value === "") return NOTES_PANEL_WIDTH_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return NOTES_PANEL_WIDTH_DEFAULT;
  return Math.min(NOTES_PANEL_WIDTH_MAX, Math.max(NOTES_PANEL_WIDTH_MIN, Math.round(n)));
}

export function normalizeNotesWidth(value) {
  // Three-pane column. Missing or illegal is 360. The floor is 320, not the
  // side-slot floor inside normalizePanelWidth.
  if (value == null || value === "") return NOTES_PANE_WIDTH_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return NOTES_PANE_WIDTH_DEFAULT;
  return Math.min(NOTES_PANE_WIDTH_MAX, Math.max(NOTES_PANE_WIDTH_MIN, Math.round(n)));
}

export function normalizeNotesPaneSide(value) {
  return value === "start" ? "start" : NOTES_PANE_SIDE_DEFAULT;
}

export function readNotesUiPrefs(storage) {
  let dismissed = {};
  try {
    const parsed = JSON.parse(storageGet(storage, NOTES_PERSIST_HINT_KEY) || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) dismissed = parsed;
  } catch {
    dismissed = {};
  }
  const clean = {};
  for (const [key, value] of Object.entries(dismissed)) {
    if (value) clean[String(key)] = true;
  }
  return {
    panelWidth: normalizePanelWidth(storageGet(storage, NOTES_PANEL_WIDTH_KEY)),
    notesWidth: normalizeNotesWidth(storageGet(storage, NOTES_WIDTH_KEY)),
    notesPaneSide: normalizeNotesPaneSide(storageGet(storage, NOTES_PANE_SIDE_KEY)),
    notesPersistHintDismissed: clean
  };
}

function sameHint(a, b) {
  const left = a && typeof a === "object" ? a : {};
  const right = b && typeof b === "object" ? b : {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (Boolean(left[key]) !== Boolean(right[key])) return false;
  }
  return true;
}

export function writeNotesUiPrefs(storage, prefs = {}) {
  const prev = readNotesUiPrefs(storage);
  const next = {
    panelWidth: prev.panelWidth,
    notesWidth: prev.notesWidth,
    notesPaneSide: prev.notesPaneSide,
    notesPersistHintDismissed: prev.notesPersistHintDismissed
  };
  if (prefs.panelWidth != null) {
    next.panelWidth = normalizePanelWidth(prefs.panelWidth);
    if (next.panelWidth !== prev.panelWidth) storageSet(storage, NOTES_PANEL_WIDTH_KEY, String(next.panelWidth));
  }
  if (prefs.notesWidth != null) {
    next.notesWidth = normalizeNotesWidth(prefs.notesWidth);
    if (next.notesWidth !== prev.notesWidth) storageSet(storage, NOTES_WIDTH_KEY, String(next.notesWidth));
  }
  if (prefs.notesPaneSide != null) {
    next.notesPaneSide = normalizeNotesPaneSide(prefs.notesPaneSide);
    if (next.notesPaneSide !== prev.notesPaneSide) storageSet(storage, NOTES_PANE_SIDE_KEY, next.notesPaneSide);
  }
  if (prefs.notesPersistHintDismissed != null) {
    next.notesPersistHintDismissed = { ...prefs.notesPersistHintDismissed };
    if (!sameHint(next.notesPersistHintDismissed, prev.notesPersistHintDismissed)) {
      storageSet(storage, NOTES_PERSIST_HINT_KEY, JSON.stringify(next.notesPersistHintDismissed));
    }
  }
  return next;
}

export function persistHintDismissed(prefs, docHash) {
  if (!docHash) return false;
  return Boolean(prefs?.notesPersistHintDismissed?.[String(docHash)]);
}

export function dismissPersistHint(prefs, docHash) {
  const next = { ...(prefs?.notesPersistHintDismissed || {}) };
  if (docHash) next[String(docHash)] = true;
  return {
    panelWidth: normalizePanelWidth(prefs?.panelWidth),
    notesWidth: normalizeNotesWidth(prefs?.notesWidth),
    notesPaneSide: normalizeNotesPaneSide(prefs?.notesPaneSide),
    notesPersistHintDismissed: next
  };
}
