// Notes panel prefs: one-time move from localStorage to chrome.storage.local.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOTES_LOCAL_KEYS,
  createNotesPrefsSession
} from "../lib/reader-notes-local.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function memoryWeb(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
    data
  };
}

function memoryArea(initial = {}) {
  const data = { ...initial };
  const calls = [];
  return {
    data,
    calls,
    async get(keys) {
      calls.push(["get", keys]);
      const out = {};
      const list = keys == null ? Object.keys(data) : [].concat(keys);
      for (const key of list) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
      }
      return out;
    },
    async set(items) {
      calls.push(["set", { ...items }]);
      Object.assign(data, items);
    },
    async remove(keys) {
      calls.push(["remove", keys]);
      for (const key of [].concat(keys)) delete data[key];
    }
  };
}

test("the notes filter has no storage key", () => {
  const panel = readFileSync(join(root, "pdf/notes-panel.js"), "utf8");
  assert.match(panel, /filter:\s*"all"/);
  assert.equal(panel.includes("localStorage"), false);
  assert.equal(panel.includes("chrome.storage"), false);
  assert.deepEqual([...NOTES_LOCAL_KEYS], [
    "reader.panelWidth",
    "reader.notesWidth",
    "reader.notesPaneSide",
    "reader.notesPersistHintDismissed"
  ]);
});

test("first load copies legacy notes prefs into chrome.storage.local and drops them from localStorage", async () => {
  const web = memoryWeb({
    "reader.panelWidth": "500",
    "reader.notesWidth": "400",
    "reader.notesPaneSide": "start",
    "reader.notesPersistHintDismissed": JSON.stringify({ "doc-a": true }),
    "reader.fontSize": "18",
    "reader.follow": "0"
  });
  const local = memoryArea();
  const session = createNotesPrefsSession({ webStorage: web, localArea: local });
  const prefs = await session.prime();
  assert.equal(prefs.panelWidth, 500);
  assert.equal(prefs.notesWidth, 400);
  assert.equal(prefs.notesPaneSide, "start");
  assert.equal(prefs.notesPersistHintDismissed["doc-a"], true);
  for (const key of NOTES_LOCAL_KEYS) assert.equal(web.getItem(key), null, key);
  assert.equal(local.data["reader.panelWidth"], "500");
  assert.equal(local.data["reader.notesWidth"], "400");
  assert.equal(local.data["reader.notesPaneSide"], "start");
  assert.equal(JSON.parse(local.data["reader.notesPersistHintDismissed"])["doc-a"], true);
  assert.equal(web.getItem("reader.fontSize"), "18");
  assert.equal(web.getItem("reader.follow"), "0");
  assert.equal(Object.hasOwn(local.data, "reader.fontSize"), false);
  assert.equal(Object.hasOwn(local.data, "reader.follow"), false);
  assert.equal(session.read().panelWidth, 500);
});

test("values already in chrome.storage.local win over stale localStorage", async () => {
  const local = memoryArea({
    "reader.panelWidth": "510",
    "reader.notesPaneSide": "start"
  });
  const web = memoryWeb({
    "reader.panelWidth": "360",
    "reader.notesPaneSide": "end",
    "reader.notesWidth": "400",
    "reader.fontSize": "19"
  });
  const session = createNotesPrefsSession({ webStorage: web, localArea: local });
  const prefs = await session.prime();
  assert.equal(prefs.panelWidth, 510);
  assert.equal(prefs.notesPaneSide, "start");
  assert.equal(prefs.notesWidth, 400);
  assert.equal(local.data["reader.panelWidth"], "510");
  assert.equal(local.data["reader.notesPaneSide"], "start");
  assert.equal(local.data["reader.notesWidth"], "400");
  assert.equal(web.getItem("reader.panelWidth"), "360");
  assert.equal(web.getItem("reader.notesPaneSide"), "end");
  assert.equal(web.getItem("reader.notesWidth"), null);
  assert.equal(web.getItem("reader.fontSize"), "19");
  assert.equal(Object.hasOwn(local.data, "reader.fontSize"), false);
  assert.equal(session.read().panelWidth, 510);
  assert.equal(session.read().notesPaneSide, "start");
});

test("notes prefs persist across a reload from chrome.storage.local", async () => {
  const local = memoryArea();
  const firstWeb = memoryWeb({
    "reader.notesWidth": "420",
    "reader.notesPersistHintDismissed": JSON.stringify({ "doc-a": true })
  });
  const first = createNotesPrefsSession({ webStorage: firstWeb, localArea: local });
  await first.prime();
  first.write({ panelWidth: 520, notesPaneSide: "start" });
  await first.settled();
  assert.equal(firstWeb.getItem("reader.panelWidth"), null);
  assert.equal(firstWeb.getItem("reader.notesPaneSide"), null);
  assert.equal(firstWeb.getItem("reader.notesWidth"), null);

  const second = createNotesPrefsSession({ webStorage: memoryWeb(), localArea: local });
  const prefs = await second.prime();
  assert.equal(prefs.panelWidth, 520);
  assert.equal(prefs.notesWidth, 420);
  assert.equal(prefs.notesPaneSide, "start");
  assert.equal(prefs.notesPersistHintDismissed["doc-a"], true);
  assert.equal(second.read().panelWidth, 520);
  assert.equal(Object.hasOwn(second.read(), "fontSize"), false);
});

test("notes prefs stay out of chrome.storage.sync", async () => {
  const local = memoryArea();
  const sync = memoryArea();
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local, sync } };
  try {
    const web = memoryWeb({ "reader.panelWidth": "480", "reader.notesWidth": "400" });
    const session = createNotesPrefsSession({ webStorage: web });
    await session.prime();
    session.write({ notesPaneSide: "start", notesPersistHintDismissed: { "doc-b": true } });
    await session.settled();
    assert.deepEqual(sync.calls, []);
    assert.deepEqual(sync.data, {});
    for (const key of NOTES_LOCAL_KEYS) assert.equal(Object.hasOwn(sync.data, key), false);
    assert.equal(local.data["reader.panelWidth"], "480");
    assert.equal(local.data["reader.notesWidth"], "400");
    assert.equal(local.data["reader.notesPaneSide"], "start");
    assert.equal(JSON.parse(local.data["reader.notesPersistHintDismissed"])["doc-b"], true);
    const src = readFileSync(join(root, "lib/reader-notes-local.js"), "utf8");
    assert.equal(src.includes(".sync.set"), false);
    assert.equal(src.includes("storage.sync"), false);
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});
