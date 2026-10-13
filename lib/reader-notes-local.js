/**
 * Device-local notes panel preferences.
 * First load copies a legacy localStorage key into chrome.storage.local when
 * that key is missing there, and drops the legacy copy either way. Later reads
 * and writes use chrome.storage.local. Other reader.* keys stay in localStorage.
 * chrome.storage.onChanged keeps each page's copy aligned. Each dismissed
 * document is its own local key, so two pages can record a dismissal at the
 * same time without rewriting one shared JSON value. Opening the reader does
 * not scan the whole local area: that area also holds layout cache and notes.
 * The old reader.notesPersistHintDismissed blob is read with the other three
 * keys. A document key is read when that document is opened, and further
 * document keys are read only when a caller names them.
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

// One key per document. Distinct keys do not collide when two pages set them
// together. The unsuffixed NOTES_PERSIST_HINT_KEY remains the legacy blob.
export const NOTES_HINT_DOC_PREFIX = `${NOTES_PERSIST_HINT_KEY}.`;

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

function hintDocKey(docId) {
  return `${NOTES_HINT_DOC_PREFIX}${docId}`;
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
  let legacyHint;
  const perDocFlags = {};
  const pending = [];
  const buffered = [];
  let writeChain = Promise.resolve();

  function publishHint() {
    if (!bag) return;
    const flags = { ...hintFlags(legacyHint), ...perDocFlags };
    if (Object.keys(flags).length === 0) delete bag[NOTES_PERSIST_HINT_KEY];
    else bag[NOTES_PERSIST_HINT_KEY] = JSON.stringify(flags);
  }

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
    const items = {};
    for (const docId of Object.keys(hintFlags(incoming))) {
      perDocFlags[docId] = true;
      items[hintDocKey(docId)] = true;
    }
    publishHint();
    if (Object.keys(items).length) enqueue(() => area.set(items));
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
    let hintTouched = false;
    for (const key of NOTES_LOCAL_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
      const change = changes[key];
      if (key === NOTES_PERSIST_HINT_KEY) {
        legacyHint = change && Object.prototype.hasOwnProperty.call(change, "newValue") ? change.newValue : undefined;
        hintTouched = true;
        continue;
      }
      if (!change || !Object.prototype.hasOwnProperty.call(change, "newValue")) {
        delete bag[key];
        continue;
      }
      bag[key] = change.newValue;
    }
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(NOTES_HINT_DOC_PREFIX)) continue;
      const docId = key.slice(NOTES_HINT_DOC_PREFIX.length);
      if (!docId) continue;
      if (change && Object.prototype.hasOwnProperty.call(change, "newValue") && change.newValue) perDocFlags[docId] = true;
      else delete perDocFlags[docId];
      hintTouched = true;
    }
    if (hintTouched) publishHint();
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
          legacyHint = bag[NOTES_PERSIST_HINT_KEY];
          // The four keys above already include the legacy hint blob. Do not
          // area.get(null) here: chrome.storage.local also stores layout cache
          // and notes, and that scan grows with them. The open document's key
          // is loaded later, by name.
          for (const changes of buffered.splice(0)) applyChanges(changes);
          publishHint();
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

  async function loadDocHint(docId) {
    const id = String(docId || "");
    if (!id) return read();
    await prime();
    if (!area || !bag || mode !== "local") return read();
    const key = hintDocKey(id);
    try {
      // One named key. Callers that need several documents pass each id.
      // There is no prefix query, and get(null) would copy the rest of local.
      const raw = await area.get([key]);
      if (raw && Object.prototype.hasOwnProperty.call(raw, key)) {
        if (raw[key]) perDocFlags[id] = true;
        else delete perDocFlags[id];
      }
    } catch {
      // This document's key failed to load. Keep the legacy blob and stay
      // on the local area.
    }
    publishHint();
    return read();
  }

  return {
    prime,
    read,
    write,
    loadDocHint,
    settled: () => writeChain
  };
}
