import test from "node:test";
import assert from "node:assert/strict";
import { NOTES_DB_NAME, createNotesStore } from "../lib/notes-store.js";

function installLazyIdb() {
  const names = new Set();
  const tables = new Map();
  let opens = 0;
  const table = (name) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const indexedDB = {
    databases() {
      return Promise.resolve([...names].map((name) => ({ name, version: 1 })));
    },
    open(name) {
      opens += 1;
      const request = {};
      const db = {
        createObjectStore(storeName) {
          table(storeName);
          return { createIndex() {} };
        },
        transaction() {
          const tx = {
            objectStore(storeName) {
              return {
                getAll() {
                  const req = { result: [...table(storeName).values()] };
                  queueMicrotask(() => req.onsuccess?.());
                  return req;
                },
                put(value) {
                  const key = value.id || value.docHash || value.key;
                  table(storeName).set(key, value);
                  const req = { result: key };
                  queueMicrotask(() => req.onsuccess?.());
                  return req;
                },
                delete(key) {
                  table(storeName).delete(key);
                  const req = {};
                  queueMicrotask(() => req.onsuccess?.());
                  return req;
                }
              };
            }
          };
          queueMicrotask(() => tx.oncomplete?.());
          return tx;
        }
      };
      queueMicrotask(() => {
        if (!names.has(name)) {
          request.result = db;
          request.onupgradeneeded?.({ oldVersion: 0 });
        }
        names.add(name);
        request.result = db;
        request.onsuccess?.();
      });
      return request;
    }
  };
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = indexedDB;
  return {
    opens: () => opens,
    names,
    restore() {
      if (previous === undefined) delete globalThis.indexedDB;
      else globalThis.indexedDB = previous;
    }
  };
}

test("listing notes does not create oi-annotations; the first put does", async () => {
  const fake = installLazyIdb();
  try {
    const store = createNotesStore({
      persist: false,
      deviceId: "device-a",
      now: () => 9,
      createId: () => "n1"
    });
    assert.deepEqual(await store.list("doc-a"), []);
    assert.equal(await store.get("missing"), null);
    assert.deepEqual(await store.listTrash(), []);
    assert.deepEqual(await store.changes(0), []);
    const exported = await store.exportAll();
    assert.equal(exported.docs.length, 0);
    assert.equal(fake.opens(), 0);
    assert.equal(fake.names.has(NOTES_DB_NAME), false);

    const saved = await store.put({ docHash: "doc-a", kind: "note", page: 4, body: "第一条" });
    assert.equal(saved.id, "n1");
    assert.equal(saved.body, "第一条");
    assert.equal(fake.names.has(NOTES_DB_NAME), true);
    assert.equal(fake.opens() > 0, true);

    const again = createNotesStore({
      persist: false,
      deviceId: "device-b",
      now: () => 10,
      createId: () => "other"
    });
    const notes = await again.list("doc-a");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, "n1");
    assert.equal(notes[0].body, "第一条");
    assert.equal(notes[0].page, 4);
    assert.equal(notes[0].docHash, "doc-a");
  } finally {
    fake.restore();
  }
});
