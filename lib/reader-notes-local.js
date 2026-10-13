/**
 * Device-local notes panel preferences.
 * First load copies a legacy localStorage key into chrome.storage.local when
 * that key is missing there, and drops the legacy copy either way. Later reads
 * and writes use chrome.storage.local. Other reader.* keys stay in localStorage.
 * chrome.storage.onChanged keeps each page's copy aligned. The dismissed-hint
 * record is merged from storage on write so one page cannot drop another's.
 * These keys are never written through the browser sync area.
 * lib/notes-prefs.js stays a synchronous bag: its return shape and the source
 * check that it does not name the local area are locked by tests.
 * This file is not under lib/notes-*: AX-23 locks that prefix against origin/main.
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
  const stale = [];
  for (const key of NOTES_LOCAL_KEYS) {
    const legacy = webStorageItem(webStorage, key);
    if (legacy == null) continue;
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      stale.push(key);
      continue;
    }
    copied[key] = legacy;
  }
  if (Object.keys(copied).length) await localArea.set(copied);
  for (const key of [...Object.keys(copied), ...stale]) removeWebStorageItem(webStorage, key);
  return { ...current, ...copied };
}

function hintFlags(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value || "{}");
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const clean = {};
  for (const [key, flag] of Object.entries(parsed)) {
    if (flag) clean[String(key)] = true;
  }
  return clean;
}

function unionHints(stored, incoming) {
  return { ...hintFlags(stored), ...hintFlags(incoming) };
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

export function createNotesPrefsSession({ webStorage, localArea: explicitArea, onChanged: explicitOnChanged } = {}) {
  const legacy = webStorage === undefined ? safeWebStorage() : webStorage;
  const areaExplicit = explicitArea !== undefined;
  const onChangedExplicit = explicitOnChanged !== undefined;
  let mode = "web";
  let bag = null;
  let area = null;
  let primePromise = null;
  let migrating = false;
  let unsubscribe = () => {};
  const pending = [];
  const buffered = [];
  let writeChain = Promise.resolve();

  function enqueue(task) {
    writeChain = writeChain.then(task).catch((err) => {
      console.error("Open Immerse: notes prefs local write failed", err);
    });
  }

  function remember(items) {
    const snapshot = { ...items };
    enqueue(() => area.set(snapshot));
  }

  function rememberHint(incoming) {
    enqueue(async () => {
      const fresh = bagFromArea(await area.get([NOTES_PERSIST_HINT_KEY]));
      const encoded = JSON.stringify(unionHints(fresh[NOTES_PERSIST_HINT_KEY], incoming));
      if (bag) bag[NOTES_PERSIST_HINT_KEY] = encoded;
      if (fresh[NOTES_PERSIST_HINT_KEY] !== encoded) {
        await area.set({ [NOTES_PERSIST_HINT_KEY]: encoded });
      }
    });
  }

  function writeLocal(patch) {
    const before = { ...bag };
    const next = writeNotesUiPrefs(bag, patch);
    const changed = changedKeys(before, bag);
    if (Object.prototype.hasOwnProperty.call(changed, NOTES_PERSIST_HINT_KEY)) {
      const incoming = changed[NOTES_PERSIST_HINT_KEY];
      const rest = { ...changed };
      delete rest[NOTES_PERSIST_HINT_KEY];
      if (Object.keys(rest).length) remember(rest);
      rememberHint(incoming);
    } else if (Object.keys(changed).length) {
      remember(changed);
    }
    return next;
  }

  function applyChanges(changes) {
    if (!changes || typeof changes !== "object") return;
    if (!bag) {
      buffered.push(changes);
      return;
    }
    for (const key of NOTES_LOCAL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
      const change = changes[key];
      if (!change || !Object.prototype.hasOwnProperty.call(change, "newValue")) {
        delete bag[key];
        continue;
      }
      bag[key] = change.newValue;
    }
  }

  function watch(onChanged) {
    if (!onChanged || typeof onChanged.addListener !== "function") return;
    const listener = (changes, areaName) => {
      if (areaName !== "local") return;
      applyChanges(changes);
    };
    onChanged.addListener(listener);
    unsubscribe = () => {
      if (typeof onChanged.removeListener === "function") onChanged.removeListener(listener);
    };
  }

  function resolveOnChanged() {
    if (onChangedExplicit) return explicitOnChanged || null;
    if (areaExplicit) return null;
    try {
      return globalThis.chrome?.storage?.onChanged || null;
    } catch {
      return null;
    }
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
        area = notesLocalArea(areaExplicit ? explicitArea : undefined);
        if (!area) return read();
        watch(resolveOnChanged());
        migrating = true;
        try {
          const stored = await migrateNotesPrefsFromLocalStorage(legacy, area);
          bag = bagFromArea(stored);
          for (const changes of buffered.splice(0)) applyChanges(changes);
          mode = "local";
          const queued = pending.splice(0);
          for (const patch of queued) writeLocal(patch);
          await writeChain;
          return read();
        } catch (err) {
          console.error("Open Immerse: notes prefs migration failed", err);
          unsubscribe();
          unsubscribe = () => {};
          mode = "web";
          bag = null;
          area = null;
          pending.length = 0;
          buffered.length = 0;
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
