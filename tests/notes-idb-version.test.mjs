import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { IDBDatabase } from "fake-indexeddb";
import {
  NOTES_DB_NAME,
  NOTES_DB_VERSION,
  createNotesStore
} from "../lib/notes-store.js";

// This file must not reach the network. 8765 and any other URL fail here.
globalThis.fetch = () => {
  const error = new Error("F4 notes version test must not send a network request");
  error.code = "live-fetch-blocked";
  throw error;
};

const kept = {
  id: "n-keep",
  schema: 1,
  docHash: "doc-a",
  kind: "note",
  author: "me",
  anchor: null,
  anchorState: { status: "lost", layoutRev: "", checkedAt: 0 },
  page: 1,
  body: "留下不改",
  createdAt: 1,
  updatedAt: 1,
  rev: 1,
  deviceId: "device-seed"
};

const live = {
  id: "n-live",
  schema: 1,
  docHash: "doc-a",
  kind: "note",
  author: "me",
  anchor: null,
  anchorState: { status: "lost", layoutRev: "", checkedAt: 0 },
  page: 2,
  body: "原来的笔记",
  createdAt: 2,
  updatedAt: 2,
  rev: 1,
  deviceId: "device-seed"
};

const trashed = {
  id: "n-trash",
  schema: 1,
  docHash: "doc-a",
  kind: "highlight",
  author: "me",
  anchor: null,
  anchorState: { status: "lost", layoutRev: "", checkedAt: 0 },
  page: 3,
  body: "回收站",
  createdAt: 3,
  updatedAt: 4,
  rev: 2,
  deviceId: "device-seed",
  deletedAt: 4
};

const paper = { docHash: "doc-a", schema: 2, title: "只属于 v2" };

function notesStore(extra = {}) {
  let n = 0;
  return createNotesStore({
    persist: false,
    deviceId: "device-rollback",
    now: () => 50,
    createId: () => `n-new${++n}`,
    ...extra
  });
}

function waitRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("idb request failed"));
  });
}

function waitTx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("idb transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("idb transaction aborted"));
  });
}

function openVersion(version, onUpgrade) {
  return new Promise((resolve, reject) => {
    const request = version == null
      ? indexedDB.open(NOTES_DB_NAME)
      : indexedDB.open(NOTES_DB_NAME, version);
    request.onupgradeneeded = (event) => {
      if (onUpgrade) onUpgrade(request.result, request.transaction, event);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("open failed"));
  });
}

async function resetDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(NOTES_DB_NAME);
    const timer = setTimeout(() => {
      reject(new Error("deleteDatabase blocked; a connection stayed open across versionchange"));
    }, 1000);
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error || new Error("deleteDatabase failed"));
    };
  });
}

async function seedVersion2() {
  const db = await openVersion(2, (database) => {
    const notes = database.createObjectStore("notes", { keyPath: "id" });
    notes.createIndex("byDoc", "docHash", { unique: false });
    notes.createIndex("byDocPage", ["docHash", "page"], { unique: false });
    notes.createIndex("byUpdated", "updatedAt", { unique: false });
    database.createObjectStore("docs", { keyPath: "docHash" });
    database.createObjectStore("meta", { keyPath: "key" });
    database.createObjectStore("papers", { keyPath: "docHash" });
  });
  try {
    const tx = db.transaction(["notes", "docs", "meta", "papers"], "readwrite");
    const done = waitTx(tx);
    tx.objectStore("notes").put(kept);
    tx.objectStore("notes").put(live);
    tx.objectStore("notes").put(trashed);
    tx.objectStore("docs").put({ docHash: "doc-a", notesCount: 2, updatedAt: 2, title: "论文" });
    tx.objectStore("meta").put({ key: "schemaVersion", value: 1 });
    tx.objectStore("meta").put({ key: "deviceId", value: "device-seed" });
    tx.objectStore("papers").put(paper);
    await done;
  } finally {
    db.close();
  }
}

async function withDb(fn) {
  const db = await openVersion(null);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function dump(storeName) {
  return withDb(async (db) => {
    const tx = db.transaction(storeName, "readonly");
    const done = waitTx(tx);
    const rows = await waitRequest(tx.objectStore(storeName).getAll());
    await done;
    return rows;
  });
}

async function describeDb() {
  return withDb(async (db) => {
    const tx = db.transaction("notes", "readonly");
    const done = waitTx(tx);
    const indexNames = [...tx.objectStore("notes").indexNames].sort();
    await done;
    return {
      version: db.version,
      stores: [...db.objectStoreNames].sort(),
      indexNames
    };
  });
}

describe("F4 PR-1 notes code opens a newer oi-annotations", { concurrency: false }, () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  test("network guard rejects fetch without leaving the process", () => {
    assert.throws(
      () => globalThis.fetch("http://127.0.0.1:8765/v1/library/document?hash=abc"),
      (error) => error.code === "live-fetch-blocked"
    );
  });

  test("a first write still creates version 1 and only the notes, docs, and meta stores", async () => {
    assert.equal(NOTES_DB_VERSION, 1);
    const store = notesStore();
    assert.deepEqual(await store.list("doc-a"), []);
    const names = (await indexedDB.databases()).map((row) => row.name);
    assert.equal(names.includes(NOTES_DB_NAME), false);

    const saved = await store.put({ docHash: "doc-a", kind: "note", page: 1, body: "第一条" });
    assert.equal(saved.id, "n-new1");
    assert.equal(saved.body, "第一条");

    const info = await describeDb();
    assert.equal(info.version, 1);
    assert.deepEqual(info.stores, ["docs", "meta", "notes"]);
    assert.deepEqual(info.indexNames, ["byDoc", "byDocPage", "byUpdated"]);

    const fresh = notesStore({ createId: () => "other" });
    const notes = await fresh.list("doc-a");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, "n-new1");
    assert.equal(notes[0].body, "第一条");
  });

  test("F4-11 v1 notes code reads and writes a version 2 oi-annotations database", async () => {
    assert.equal(NOTES_DB_VERSION, 1);
    await seedVersion2();
    const paperBefore = await dump("papers");
    const keptBefore = (await dump("notes")).find((row) => row.id === "n-keep");

    const calls = [];
    const factory = globalThis.indexedDB;
    const originalOpen = factory.open;
    factory.open = function open(name, version) {
      calls.push({ name, args: arguments.length, version });
      return originalOpen.apply(this, arguments);
    };
    try {
      const store = notesStore();
      const listed = await store.list("doc-a");
      assert.deepEqual(listed.map((note) => note.id), ["n-keep", "n-live"]);
      assert.equal(listed[0].body, "留下不改");
      assert.equal(listed[1].body, "原来的笔记");
      const trash = await store.listTrash("doc-a");
      assert.deepEqual(trash.map((note) => note.id), ["n-trash"]);
      assert.equal(trash[0].deletedAt, 4);

      const saved = await store.put({
        docHash: "doc-a",
        kind: "note",
        page: 4,
        body: "回退后仍能写"
      });
      assert.equal(saved.id, "n-new1");
      assert.equal(saved.body, "回退后仍能写");
      const edited = await store.put({ id: "n-live", body: "改过" });
      assert.equal(edited.body, "改过");
      assert.equal(edited.rev, 2);
      assert.equal((await store.get("n-keep")).body, "留下不改");

      assert.deepEqual(calls.map((call) => [call.name, call.args, call.version]), [
        [NOTES_DB_NAME, 2, 1],
        [NOTES_DB_NAME, 1, undefined]
      ]);
    } finally {
      factory.open = originalOpen;
    }

    const again = notesStore({ createId: () => "other" });
    const notes = await again.list("doc-a");
    assert.deepEqual(notes.map((note) => [note.id, note.body]), [
      ["n-keep", "留下不改"],
      ["n-live", "改过"],
      ["n-new1", "回退后仍能写"]
    ]);
    assert.equal((await again.listTrash("doc-a"))[0].body, "回收站");

    assert.deepEqual(await dump("papers"), paperBefore);
    assert.deepEqual((await dump("notes")).find((row) => row.id === "n-keep"), keptBefore);
    const info = await describeDb();
    assert.equal(info.version, 2);
    assert.deepEqual(info.stores, ["docs", "meta", "notes", "papers"]);
    assert.deepEqual(info.indexNames, ["byDoc", "byDocPage", "byUpdated"]);
  });

  test("versionchange closes the notes connection so a newer open is not blocked", async () => {
    assert.equal(NOTES_DB_VERSION, 1);
    const store = notesStore();
    const first = await store.put({ docHash: "doc-a", kind: "note", page: 1, body: "升级前" });
    assert.equal(first.id, "n-new1");
    const before = await describeDb();
    assert.equal(before.version, 1);
    assert.deepEqual(before.stores, ["docs", "meta", "notes"]);

    const originalClose = IDBDatabase.prototype.close;
    const closed = [];
    IDBDatabase.prototype.close = function close() {
      const result = originalClose.call(this);
      closed.push({ closed: this._closed === true, version: this.version });
      return result;
    };
    try {
      const upgrade = await new Promise((resolve, reject) => {
        const request = indexedDB.open(NOTES_DB_NAME, 2);
        let blocked = 0;
        const timer = setTimeout(() => {
          reject(new Error(`versionchange did not close the connection (blocked=${blocked})`));
        }, 1000);
        request.onblocked = () => {
          blocked += 1;
        };
        request.onupgradeneeded = () => {
          request.result.createObjectStore("papers", { keyPath: "docHash" });
        };
        request.onsuccess = () => {
          clearTimeout(timer);
          resolve({ db: request.result, blocked });
        };
        request.onerror = () => {
          clearTimeout(timer);
          reject(request.error || new Error("upgrade failed"));
        };
      });
      try {
        assert.equal(upgrade.blocked, 0);
        assert.equal(upgrade.db.version, 2);
        assert.equal(closed.length, 1);
        assert.deepEqual(closed[0], { closed: true, version: 1 });
        const tx = upgrade.db.transaction("papers", "readwrite");
        const done = waitTx(tx);
        tx.objectStore("papers").put({ docHash: "doc-a", schema: 2, title: "升级时写入" });
        await done;
      } finally {
        upgrade.db.close();
      }
    } finally {
      IDBDatabase.prototype.close = originalClose;
    }

    const second = await store.put({ docHash: "doc-a", kind: "note", page: 3, body: "升级后仍能写" });
    assert.equal(second.id, "n-new2");
    assert.equal(second.body, "升级后仍能写");
    const fresh = notesStore({ createId: () => "unused" });
    const notes = await fresh.list("doc-a");
    assert.deepEqual(notes.map((note) => [note.id, note.body]), [
      ["n-new1", "升级前"],
      ["n-new2", "升级后仍能写"]
    ]);
    assert.deepEqual(await dump("papers"), [{ docHash: "doc-a", schema: 2, title: "升级时写入" }]);
    const info = await describeDb();
    assert.equal(info.version, 2);
    assert.deepEqual(info.stores, ["docs", "meta", "notes", "papers"]);
  });
});
