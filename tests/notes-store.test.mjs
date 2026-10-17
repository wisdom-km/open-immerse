import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOTES_FORMAT } from "../lib/notes-io.js";
import {
  LIBRARY_COLLECTIONS,
  NOTES_DB_NAME,
  createNotesStore,
  NotesStoreError,
  recordedPersistDenied,
  upgradeNotesDatabase,
  wrapStoreError
} from "../lib/notes-store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const storeSrc = readFileSync(join(root, "lib/notes-store.js"), "utf8");
const manifest = readFileSync(join(root, "manifest.json"), "utf8");

function anchor(page = 1) {
  return { docHash: "doc-a", bid: "b1-p1-tabcdefg", bidV: 1, page, srcHead: "hello", srcHash: "abc" };
}

function make(extra = {}) {
  let n = 0;
  let t = 1000;
  const store = createNotesStore({
    memory: true,
    persist: false,
    deviceId: "device-a",
    now: () => t,
    createId: () => `n${++n}`,
    ...extra,
    nowFn: undefined
  });
  return {
    store,
    at(value) {
      t = value;
    }
  };
}

test("library interface is notes-only and does not auto-purge or ask for unlimited storage", () => {
  assert.equal(LIBRARY_COLLECTIONS.notes, NOTES_DB_NAME);
  assert.equal(LIBRARY_COLLECTIONS.papers, "reserved");
  assert.equal(LIBRARY_COLLECTIONS.layouts, "reserved");
  assert.equal(LIBRARY_COLLECTIONS.translations, "reserved");
  assert.equal(storeSrc.includes("purgeDeleted"), false);
  assert.equal(storeSrc.includes("unlimitedStorage"), false);
  assert.equal(manifest.includes("unlimitedStorage"), false);
});

test("notes are isolated by docHash, rev grows, and trash is kept until purge", async () => {
  const { store, at } = make();
  const seen = [];
  store.subscribe((event) => seen.push(event.type));
  const first = await store.put({ docHash: "doc-a", kind: "highlight", page: 4, anchor: anchor(4), body: "甲" });
  assert.equal(first.id, "n1");
  assert.equal(first.rev, 1);
  assert.equal(first.schema, 1);
  assert.equal(first.author, "me");
  assert.equal(first.deviceId, "device-a");
  at(1100);
  const second = await store.put({ id: first.id, body: "乙" });
  assert.equal(second.rev, 2);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.updatedAt, 1100);
  assert.equal(second.body, "乙");

  const other = await store.put({ docHash: "doc-b", kind: "note", page: 1, body: "别的论文" });
  const questions = await store.put({ docHash: "doc-a", kind: "question", page: 4, body: "为什么？" });
  assert.deepEqual((await store.list("doc-a")).map((note) => note.id), [first.id, questions.id]);
  assert.deepEqual((await store.list("doc-b")).map((note) => note.id), [other.id]);
  assert.deepEqual((await store.list("doc-a", { kinds: ["question"] })).map((note) => note.id), [questions.id]);

  at(1200);
  const trashed = await store.softDelete(first.id);
  assert.equal(trashed.rev, 3);
  assert.equal(trashed.deletedAt, 1200);
  assert.equal((await store.list("doc-a")).some((note) => note.id === first.id), false);
  assert.equal((await store.listTrash()).map((note) => note.id).includes(first.id), true);
  assert.equal((await store.listTrash("doc-b")).length, 0);
  at(1300);
  const still = await store.softDelete(first.id);
  assert.equal(still.rev, trashed.rev);
  assert.equal(still.deletedAt, trashed.deletedAt);
  const edited = await store.put({ id: first.id, body: "仍在回收站" });
  assert.equal(edited.deletedAt, 1200);
  assert.equal(edited.body, "仍在回收站");
  assert.equal((await store.list("doc-a", { includeDeleted: true })).some((note) => note.id === first.id), true);

  at(1400);
  const restored = await store.restore(first.id);
  assert.equal(restored.rev, edited.rev + 1);
  assert.equal(restored.deletedAt, undefined);
  assert.equal((await store.listTrash()).some((note) => note.id === first.id), false);
  assert.equal((await store.changes(2)).some((note) => note.id === first.id), true);

  await store.softDelete(first.id);
  assert.equal((await store.changes(0)).some((note) => note.id === first.id && note.deletedAt), true);
  const purged = await store.purge(first.id);
  assert.equal(purged.id, first.id);
  assert.equal(await store.get(first.id), null);
  assert.equal(await store.purge(first.id), null);
  assert.equal((await store.list("doc-a", { includeDeleted: true })).some((note) => note.id === first.id), false);
  assert.equal((await store.changes(0)).some((note) => note.id === first.id), false);
  await assert.rejects(() => store.restore(first.id), (error) => error.type === "not-found");
  await assert.rejects(() => store.softDelete("missing"), (error) => error.type === "not-found");

  const paper = await store.put({ docHash: "doc-a", kind: "paperNote", anchor: anchor(1), body: "整篇" });
  assert.equal(paper.anchor, null);
  const paired = await store.bulkPut([
    { docHash: "doc-a", kind: "note", page: 2, body: "一" },
    { docHash: "doc-a", kind: "note", page: 2, body: "二" }
  ]);
  assert.deepEqual(paired.map((note) => note.rev), [1, 1]);
  assert.deepEqual(seen.slice(0, 2), ["put", "put"]);
});

test("the first write records navigator.storage.persist() once", async () => {
  const settings = {};
  let calls = 0;
  const { store } = make({
    persist: async () => {
      calls += 1;
      return true;
    },
    settings: {
      async set(patch) {
        Object.assign(settings, patch);
      }
    }
  });
  await store.put({ docHash: "doc-a", kind: "highlight", page: 1, anchor: anchor(1) });
  await store.put({ docHash: "doc-a", kind: "note", page: 1, body: "again" });
  assert.equal(calls, 1);
  assert.equal(settings.notesPersistGranted, true);
  assert.equal(settings.notesSchemaSeen, 1);
  assert.equal(store.persistRecord.notesPersistGranted, true);
});

test("a re-anchor put can skip persist(), and a recorded refusal is explicit", async () => {
  let calls = 0;
  const { store } = make({
    persist: async () => {
      calls += 1;
      return false;
    }
  });
  await store.put({ docHash: "doc-a", kind: "highlight", page: 1, anchor: anchor(1) }, { persist: false });
  assert.equal(calls, 0);
  assert.equal(store.persistRecord, null);
  await store.put({ docHash: "doc-a", kind: "note", page: 1, body: "用户写入" });
  assert.equal(calls, 1);
  assert.equal(store.persistRecord.notesPersistGranted, false);
  assert.equal(recordedPersistDenied(store.persistRecord, undefined), true);
  assert.equal(recordedPersistDenied(null, undefined), false);
  assert.equal(recordedPersistDenied(null, false), true);
  assert.equal(recordedPersistDenied(null, true), false);
  assert.equal(recordedPersistDenied({ notesPersistGranted: true }, false), false);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const anchorSrc = readFileSync(join(root, "lib/notes-anchor.js"), "utf8");
  assert.match(anchorSrc, /store\.put\(outcome\.note, \{ persist: false \}\)/);
  assert.match(viewer, /recordedPersistDenied/);
  assert.match(viewer, /chrome\?\.storage\?\.local/);
  assert.match(viewer, /get\.call\(local/);
  assert.equal(viewer.includes("navigator.storage.persist"), false);
});

test("a quota failure keeps the note in memory and throws a typed error", async () => {
  const tables = { notes: new Map(), docs: new Map(), meta: new Map() };
  const db = {
    transaction(names) {
      const open = new Set([].concat(names));
      return {
        objectStore(name) {
          if (!open.has(name)) throw new Error(`missing store ${name}`);
          return {
            getAll() {
              return Promise.resolve([...tables[name].values()]);
            },
            put(value) {
              if (name === "notes") {
                const error = new Error("quota");
                error.name = "QuotaExceededError";
                return Promise.reject(error);
              }
              const key = value.id || value.docHash || value.key;
              tables[name].set(key, value);
              return Promise.resolve(key);
            },
            delete(key) {
              tables[name].delete(key);
              return Promise.resolve();
            }
          };
        },
        done: Promise.resolve()
      };
    }
  };
  const store = createNotesStore({
    openDatabase: async () => db,
    persist: false,
    deviceId: "device-a",
    now: () => 5,
    createId: () => "kept"
  });
  await assert.rejects(
    () => store.put({ docHash: "doc-a", kind: "note", page: 3, body: "还在内存里" }),
    (error) => error.type === "quota" && /备份/.test(error.message)
  );
  const notes = await store.list("doc-a");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, "还在内存里");
  assert.equal(notes[0].id, "kept");
  const wrapped = wrapStoreError(Object.assign(new Error("x"), { name: "SecurityError" }));
  assert.equal(wrapped.type, "private");
});

test("import merges by revision, never deletes local notes, and keeps an unopened doc", async () => {
  const { store, at } = make();
  at(10);
  const local = await store.put({ id: "keep", docHash: "doc-a", kind: "note", page: 1, body: "留下" });
  const editable = await store.put({ id: "edit", docHash: "doc-a", kind: "note", page: 2, body: "旧" });
  await store.put({ id: "fresh", docHash: "doc-a", kind: "highlight", page: 2, body: "本地更新", anchor: anchor(2) });
  at(50);
  await store.put({ id: "fresh", body: "本地更新" });
  const base = await store.exportAll({ exportedAt: 50, appVersion: "0.3.0" });
  const newer = structuredClone(base);
  const edit = newer.docs[0].notes.find((note) => note.id === "edit");
  edit.body = "导入更新";
  edit.rev = editable.rev + 1;
  edit.updatedAt = 1;
  const same = newer.docs[0].notes.find((note) => note.id === "fresh");
  same.body = "时间较新";
  same.updatedAt = 80;
  newer.docs[0].notes = newer.docs[0].notes.filter((note) => note.id !== "keep");
  newer.docs.push({
    docHash: "doc-new",
    title: "还没打开",
    notes: [{
      id: "later",
      schema: 1,
      docHash: "doc-new",
      kind: "note",
      author: "me",
      body: "等 PDF 打开再锚定",
      anchor: null,
      anchorState: { status: "lost", layoutRev: "", checkedAt: 0 },
      page: 8,
      createdAt: 3,
      updatedAt: 3,
      rev: 2,
      deviceId: "other"
    }]
  });
  newer.qa = [{ id: "session-1", docHash: "doc-a", quote: "引用", turns: [{ role: "user", body: "问" }] }];
  const merged = await store.import(JSON.parse(JSON.stringify(newer)));
  assert.equal(merged.added, 1);
  assert.equal(merged.updated >= 1, true);
  assert.equal((await store.get("keep")).body, "留下");
  assert.equal((await store.get("edit")).body, "导入更新");
  assert.equal((await store.get("fresh")).body, "时间较新");
  assert.equal((await store.list("doc-new"))[0].body, "等 PDF 打开再锚定");
  assert.equal((await store.exportAll()).docs.find((doc) => doc.docHash === "doc-new").title, "还没打开");

  const older = structuredClone(newer);
  older.docs = [{
    docHash: "doc-a",
    notes: [{ ...edit, body: "更旧", rev: 1, updatedAt: 999 }]
  }];
  older.qa = [{ id: "session-2", quote: "另一场" }];
  const skipped = await store.import(older);
  assert.equal(skipped.skipped, 1);
  assert.equal((await store.get("edit")).body, "导入更新");
  const qa = (await store.exportAll()).qa.map((item) => item.id).sort();
  assert.deepEqual(qa, ["session-1", "session-2"]);

  const staleQa = structuredClone(older);
  staleQa.qa = [{ id: "session-1", rev: 0, quote: "不要盖掉" }];
  staleQa.docs = [];
  await store.import(staleQa);
  assert.equal((await store.exportAll()).qa.find((item) => item.id === "session-1").quote, "引用");

  await assert.rejects(
    () => store.import({ format: NOTES_FORMAT, schema: 2, docs: [] }),
    (error) => error.type === "schema" && /升级/.test(error.message)
  );
  assert.equal((await store.get("keep")).body, "留下");
  await assert.rejects(
    () => store.import({ format: NOTES_FORMAT, schema: 1, docs: [{ docHash: "doc-a", notes: [{ schema: 2, id: "x", kind: "note" }] }] }),
    (error) => error.type === "schema"
  );
  assert.equal((await store.get("keep")).id, local.id);
  await assert.rejects(
    () => store.import({ format: NOTES_FORMAT, schema: 1, docs: [] }, { mode: "replace" }),
    (error) => error.type === "invalid"
  );
});

test("export leaves the recycle bin out and round-trips the notes that remain", async () => {
  const { store } = make();
  const live = await store.put({
    docHash: "doc-a",
    kind: "note",
    page: 4,
    title: "一则",
    body: "正文 $x$",
    anchor: anchor(4),
    qa: { question: "为什么？", answer: "", model: "reserved" }
  });
  const ai = await store.put({
    docHash: "doc-a",
    kind: "question",
    author: "ai",
    page: 5,
    body: "预留，T2a 不主动写"
  });
  assert.equal(ai.author, "ai");
  const dropped = await store.put({ docHash: "doc-a", kind: "highlight", page: 4, body: "回收站" });
  await store.softDelete(dropped.id);
  const bundle = await store.exportAll({ exportedAt: 77, appVersion: "0.3.0" });
  assert.equal(bundle.format, NOTES_FORMAT);
  assert.equal(bundle.schema, 1);
  assert.deepEqual(bundle.qa, []);
  assert.equal(bundle.docs[0].notes.some((note) => note.id === dropped.id), false);
  assert.equal(bundle.docs[0].notes.find((note) => note.id === live.id).qa.question, "为什么？");
  assert.equal(bundle.docs[0].notes.find((note) => note.id === live.id).qa.answer, undefined);
  const withTrash = await store.exportAll({ includeDeleted: true, exportedAt: 77, appVersion: "0.3.0" });
  assert.equal(withTrash.docs[0].notes.some((note) => note.id === dropped.id), true);

  const empty = createNotesStore({
    memory: true,
    persist: false,
    deviceId: "other",
    now: () => 9,
    createId: () => "nope"
  });
  const revived = JSON.parse(JSON.stringify(bundle));
  const result = await empty.import(revived);
  assert.equal(result.added, 2);
  assert.equal(result.updated, 0);
  const again = await empty.exportAll({ exportedAt: 77, appVersion: "0.3.0" });
  assert.deepEqual(again.docs, bundle.docs);
  assert.deepEqual(again.qa, bundle.qa);
  assert.equal(again.format, bundle.format);
  assert.equal(again.schema, bundle.schema);
});

test("database v1 creates the notes, docs, and meta stores", () => {
  const stores = {};
  const db = {
    createObjectStore(name, options) {
      const store = {
        keyPath: options.keyPath,
        indexes: {},
        createIndex(indexName, key, indexOptions) {
          this.indexes[indexName] = { key, unique: indexOptions.unique };
        }
      };
      stores[name] = store;
      return store;
    }
  };
  upgradeNotesDatabase(db, 0);
  assert.equal(stores.notes.keyPath, "id");
  assert.equal(stores.notes.indexes.byDoc.unique, false);
  assert.deepEqual(stores.notes.indexes.byDocPage.key, ["docHash", "page"]);
  assert.equal(stores.notes.indexes.byUpdated.unique, false);
  assert.equal(stores.docs.keyPath, "docHash");
  assert.equal(stores.meta.keyPath, "key");
  upgradeNotesDatabase(db, 1);
  assert.equal(Object.keys(stores).length, 3);
});

test("a save cannot move an existing note onto another document", async () => {
  const { store } = make();
  const original = await store.put({
    id: "ask:ask-1:1",
    docHash: "bdfaa68d89",
    kind: "note",
    author: "ai",
    body: "回答甲",
    qa: { turnId: "ask-1:1", question: "问", answer: "回答甲", model: "gpt-4o-mini" }
  });
  await assert.rejects(
    () => store.put({
      id: original.id,
      docHash: "92cb3a2b71",
      kind: "note",
      author: "ai",
      body: "回答乙",
      qa: { turnId: "ask-1:1", question: "问", answer: "回答乙", model: "gpt-4o-mini" }
    }),
    (err) => err instanceof NotesStoreError && err.type === "doc"
  );
  const still = await store.get(original.id);
  assert.equal(still.docHash, "bdfaa68d89");
  assert.equal(still.body, "回答甲");
  assert.equal((await store.list("bdfaa68d89")).length, 1);
  assert.equal((await store.list("92cb3a2b71")).length, 0);
  const edited = await store.put({ id: original.id, body: "回答甲改" });
  assert.equal(edited.docHash, "bdfaa68d89");
  assert.equal(edited.body, "回答甲改");
});
