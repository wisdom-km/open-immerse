import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { ANNOTATIONS_SCHEMA, createLibraryStore } from "../lib/library-store.js";
import { NOTES_DB_NAME } from "../lib/notes-store.js";
import { createIdbLibraryFactory } from "../lib/platform/idb-backend.js";
import { createMemoryKv } from "../lib/platform/kv.js";
import { createMemoryLibraryFactory } from "../lib/platform/memory-backend.js";
import { createSqliteLikeFactory } from "./sqlite-like-backend.mjs";

globalThis.fetch = () => {
  const error = new Error("backend contract test must not send a network request");
  error.code = "live-fetch-blocked";
  throw error;
};

function plainQuery() {
  class HostRange {}
  return new HostRange();
}

async function resetIndexedDb(factory) {
  await factory?.close?.(NOTES_DB_NAME);
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(NOTES_DB_NAME);
    const timer = setTimeout(() => reject(new Error("deleteDatabase blocked")), 1000);
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

async function exerciseBackend(backend) {
  await backend.put("meta", { key: "deviceId", value: "device-a" });
  await assert.rejects(
    () => backend.tx(["meta"], "readwrite", async (work) => {
      await work.put("meta", { key: "deviceId", value: "replaced" });
      throw new Error("roll back");
    }),
    (error) => error.message === "roll back"
  );
  assert.equal((await backend.get("meta", "deviceId")).value, "device-a");

  await backend.put("papers", { docHash: "a", lastOpenedAt: 1, updatedAt: 1, rev: 1, schema: 2 });
  await backend.put("papers", { docHash: "b", lastOpenedAt: 3, updatedAt: 3, rev: 1, schema: 2 });
  await backend.put("papers", { docHash: "c", lastOpenedAt: 2, updatedAt: 2, rev: 1, schema: 2, arxiv: { key: "1706.03762v7" } });
  const opened = await backend.getAll("papers", { index: "byOpened", direction: "prev" });
  assert.deepEqual(opened.map((paper) => paper.docHash), ["b", "c", "a"]);
  const arxiv = await backend.getAll("papers", { index: "byArxiv", equals: "1706.03762v7" });
  assert.deepEqual(arxiv.map((paper) => paper.docHash), ["c"]);

  await backend.put("pages", { docHash: "a", page: 2, pairs: [{ text: "二" }], rev: 1, schema: 2 });
  await backend.put("pages", { docHash: "a", page: 1, pairs: [{ text: "一" }], rev: 1, schema: 2 });
  assert.equal((await backend.get("pages", ["a", 1])).pairs[0].text, "一");
  const ranged = await backend.getAll("pages", { from: ["a", 1], fromExclusive: true, to: ["a", 9] });
  assert.deepEqual(ranged.map((page) => page.page), [2]);

  const first = await backend.put("changes", {
    collection: "papers",
    docHash: "a",
    key: "a",
    rev: 1,
    op: "put",
    at: 1,
    deviceId: "device-a"
  });
  const second = await backend.put("changes", {
    collection: "papers",
    docHash: "b",
    key: "b",
    rev: 1,
    op: "put",
    at: 2,
    deviceId: "device-a"
  });
  assert.equal(first, 1);
  assert.equal(second, 2);
  const page = await backend.getAll("changes", { from: 0, fromExclusive: true, limit: 1 });
  assert.equal(page.length, 1);
  assert.equal(page[0].seq, 1);
  assert.equal(page[0].constructor, Object);

  await assert.rejects(
    () => backend.getAll("papers", plainQuery()),
    (error) => error.name === "DataError"
  );
  const estimate = await backend.estimate();
  assert.equal(typeof estimate, "object");
  assert.equal(Object.hasOwn(estimate, "quota"), true);
  assert.equal(Object.hasOwn(estimate, "usage"), true);
  assert.equal("objectStore" in estimate, false);
  if (typeof backend.requestPersist === "function") {
    assert.equal(typeof await backend.requestPersist(), "boolean");
  }
  await backend.delete("papers", "b");
  assert.equal(await backend.get("papers", "b"), null);
}

async function librarySnapshot(factory) {
  const store = createLibraryStore({
    platform: { target: factory.kind, kv: createMemoryKv(), library: factory },
    persist: false,
    deviceId: "device-contract",
    now: () => 80
  });
  await store.touchPaper("doc-a", { title: "Attention", pageCount: 2, origin: "native" });
  await store.putPage("doc-a", 1, {
    pairs: [{ sourceId: "s1", text: "hello", translation: "你好", groupId: "g1", bid: "b1", apiKey: "sk-should-not-stick" }]
  });
  await store.putSource("doc-a", new Blob(["%PDF"]));
  const paper = await store.getPaper("doc-a");
  const page = await store.getPage("doc-a", 1);
  const source = await store.getSource("doc-a");
  const changes = await store.changes(0);
  const exported = await store.exportLibrary({ exportedAt: 80, appVersion: "0.3.0" });
  return {
    paper,
    page,
    source: new TextDecoder().decode(await source.arrayBuffer()),
    changeCount: changes.items.length,
    exported
  };
}

test("memory, IndexedDB, and the SQLite stand-in follow one contract", async () => {
  const memory = createMemoryLibraryFactory();
  const sqlite = createSqliteLikeFactory();
  const idb = createIdbLibraryFactory();
  try {
    await exerciseBackend(await memory.open(NOTES_DB_NAME, ANNOTATIONS_SCHEMA));
    await exerciseBackend(await sqlite.open("oi-annotations-sqlite", ANNOTATIONS_SCHEMA));
    await exerciseBackend(await idb.open(NOTES_DB_NAME, ANNOTATIONS_SCHEMA));

    const sqliteBackend = await sqlite.open("oi-annotations-sqlite", ANNOTATIONS_SCHEMA);
    const sqliteBlobs = await sqlite.blobs("oi-annotations-sqlite", ANNOTATIONS_SCHEMA);
    await sqliteBlobs.put("doc-a", new Blob(["%PDF"]));
    assert.equal(await sqliteBackend.get("sources", "doc-a"), null);
    assert.equal(sqliteBackend.requestPersist, undefined);

    const idbBlobs = await idb.blobs(NOTES_DB_NAME, ANNOTATIONS_SCHEMA);
    await idbBlobs.put("doc-a", new Blob(["%PDF"]));
    const stored = await (await idb.open(NOTES_DB_NAME, ANNOTATIONS_SCHEMA)).get("sources", "doc-a");
    assert.equal(stored.docHash, "doc-a");
    assert.equal(stored.size, 4);

    await memory.close(NOTES_DB_NAME);
    await sqlite.close("oi-annotations-sqlite");
    await resetIndexedDb(idb);

    const memorySnapFactory = createMemoryLibraryFactory();
    const sqliteSnapFactory = createSqliteLikeFactory();
    const idbSnapFactory = createIdbLibraryFactory();
    const memorySnap = await librarySnapshot(memorySnapFactory);
    const sqliteSnap = await librarySnapshot(sqliteSnapFactory);
    const idbSnap = await librarySnapshot(idbSnapFactory);
    assert.deepEqual(sqliteSnap, memorySnap);
    assert.deepEqual(idbSnap, memorySnap);
    assert.equal(JSON.stringify(memorySnap).includes("sk-should-not-stick"), false);
    assert.equal(memorySnap.page.pairs[0].groupId, "g1");
    assert.equal(memorySnap.source, "%PDF");
    await resetIndexedDb(idbSnapFactory);
  } finally {
    await resetIndexedDb(idb);
  }
});
