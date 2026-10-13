/**
 * Device-local notes panel preferences.
 * First load copies a legacy localStorage key into chrome.storage.local when
 * that key is missing there, then removes the legacy copy. Later reads and
 * writes use chrome.storage.local. Other reader.* keys stay in localStorage.
 * These keys are never written through the browser sync area.
 * lib/notes-prefs.js stays a synchronous bag: its return shape and the source
 * check that it does not name the local area are locked by tests.
 * The notes filter is not a stored key. pdf/notes-panel.js keeps it in memory
 * as state.filter, default "all".
 */

import {
  NOTES_PANEL_WIDTH_KEY,
  NOTES_PANE_SIDE_KEY,
  NOTES_PERSIST_HINT_KEY,
  NOTES_WIDTH_KEY,
  readNotesUiPrefs,
  writeNotesUiPrefs
} from "./notes-prefs.js";

export const NOTES_LOCAL_KEYS = Object.freeze([
  NOTES_PANEL_WIDTH_KEY,
  NOTES_WIDTH_KEY,
  NOTES_PANE_SIDE_KEY,
  NOTES_PERSIST_HINT_KEY
]);

function webStorageItem(storage, key) {
  if (!storage) return null;
  if (typeof storage.getItem === "function") return storage.getItem(key);
  if (Object.prototype.hasOwnProperty.call(storage, key)) return storage[key];
  return null;
}

function removeWebStorageItem(storage, key) {
  if (!storage) return;
  if (typeof storage.removeItem === "function") storage.removeItem(key);
  else delete storage[key];
}

function bagFromArea(raw) {
  const bag = {};
  if (!raw || typeof raw !== "object") return bag;
  for (const key of NOTES_LOCAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) bag[key] = raw[key];
  }
  return bag;
}

export function notesLocalArea(explicit) {
  if (explicit !== undefined) return explicit || null;
  try {
    const area = globalThis.chrome?.storage?.local;
    if (area && typeof area.get === "function" && typeof area.set === "function") return area;
  } catch {
    return null;
  }
  return null;
}

export async function migrateNotesPrefsFromLocalStorage(webStorage, localArea) {
  const current = bagFromArea(await localArea.get(NOTES_LOCAL_KEYS));
  const copied = {};
  for (const key of NOTES_LOCAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(current, key)) continue;
    const legacy = webStorageItem(webStorage, key);
    if (legacy == null) continue;
    copied[key] = legacy;
  }
  if (Object.keys(copied).length) await localArea.set(copied);
  for (const key of Object.keys(copied)) removeWebStorageItem(webStorage, key);
  return { ...current, ...copied };
}

function changedKeys(before, after) {
  const changed = {};
  for (const key of NOTES_LOCAL_KEYS) {
    const had = Object.prototype.hasOwnProperty.call(before, key);
    const has = Object.prototype.hasOwnProperty.call(after, key);
    if (has && (!had || after[key] !== before[key])) changed[key] = after[key];
  }
  return changed;
}

function safeWebStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function createNotesPrefsSession({ webStorage, localArea } = {}) {
  const legacy = webStorage === undefined ? safeWebStorage() : webStorage;
  let mode = "web";
  let bag = null;
  let area = null;
  let primePromise = null;
  let migrating = false;
  const pending = [];
  let writeChain = Promise.resolve();

  function remember(items) {
    const snapshot = { ...items };
    writeChain = writeChain.then(() => area.set(snapshot)).catch((err) => {
      console.error("Open Immerse: notes prefs local write failed", err);
    });
  }

  function writeLocal(patch) {
    const before = { ...bag };
    const next = writeNotesUiPrefs(bag, patch);
    const changed = changedKeys(before, bag);
    if (Object.keys(changed).length) remember(changed);
    return next;
  }

  function read() {
    if (mode === "local" && bag) return readNotesUiPrefs(bag);
    return readNotesUiPrefs(legacy);
  }

  function write(patch) {
    if (mode === "local" && bag && area) return writeLocal(patch);
    const next = writeNotesUiPrefs(legacy, patch);
    if (migrating) pending.push(patch);
    return next;
  }

  function prime() {
    if (!primePromise) {
      primePromise = (async () => {
        area = notesLocalArea(localArea);
        if (!area) return read();
        migrating = true;
        try {
          const stored = await migrateNotesPrefsFromLocalStorage(legacy, area);
          bag = bagFromArea(stored);
          mode = "local";
          const queued = pending.splice(0);
          for (const patch of queued) writeLocal(patch);
          await writeChain;
          return read();
        } catch (err) {
          console.error("Open Immerse: notes prefs migration failed", err);
          mode = "web";
          bag = null;
          area = null;
          pending.length = 0;
          return read();
        } finally {
          migrating = false;
        }
      })();
    }
    return primePromise;
  }

  return {
    prime,
    read,
    write,
    settled: () => writeChain
  };
}
