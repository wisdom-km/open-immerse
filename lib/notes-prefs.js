/**
 * Device-local notes UI settings.
 * Same localStorage reader.* pattern as readReaderPrefs / writeReaderPrefs.
 * Kept separate because those two functions' return shape is locked by
 * tests/pdf-reader-flow.test.mjs. Do not fold these keys into that object.
 * Not chrome.storage.sync (T2a: settings stay on this device).
 */

export const NOTES_PANEL_WIDTH_KEY = "reader.panelWidth";
export const NOTES_PERSIST_HINT_KEY = "reader.notesPersistHintDismissed";
export const NOTES_PANEL_WIDTH_DEFAULT = 440;
export const NOTES_PANEL_WIDTH_MIN = 360;
export const NOTES_PANEL_WIDTH_MAX = 640;

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
    notesPersistHintDismissed: clean
  };
}

export function writeNotesUiPrefs(storage, prefs = {}) {
  const prev = readNotesUiPrefs(storage);
  const panelWidth = prefs.panelWidth == null ? prev.panelWidth : normalizePanelWidth(prefs.panelWidth);
  const notesPersistHintDismissed = prefs.notesPersistHintDismissed == null
    ? prev.notesPersistHintDismissed
    : { ...prefs.notesPersistHintDismissed };
  storageSet(storage, NOTES_PANEL_WIDTH_KEY, String(panelWidth));
  storageSet(storage, NOTES_PERSIST_HINT_KEY, JSON.stringify(notesPersistHintDismissed));
  return { panelWidth, notesPersistHintDismissed };
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
    notesPersistHintDismissed: next
  };
}
