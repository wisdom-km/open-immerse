import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ANNOTATIONS_DB_VERSION,
  ANNOTATIONS_SCHEMA,
  LIBRARY_FORMAT,
  LIBRARY_PERSIST_HINT_KEY,
  LIBRARY_SCHEMA,
  LIBRARY_SETTINGS_KEYS,
  createLibraryStore
} from "../lib/library-store.js";
import { NOTES_FORMAT } from "../lib/notes-io.js";
import { NOTES_DB_NAME, NOTES_DB_VERSION, createNotesStore } from "../lib/notes-store.js";
import { NOTES_PERSIST_HINT_KEY } from "../lib/notes-prefs.js";
import { createIdbLibraryFactory } from "../lib/platform/idb-backend.js";
import { indexedDatabaseExists } from "../lib/platform/idb-open.js";
import { createMemoryKv } from "../lib/platform/kv.js";
import { createMemoryLibraryFactory } from "../lib/platform/memory-backend.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls += 1;
  const error = new Error("library store test must not send a network request");
  error.code = "live-fetch-blocked";
  throw error;
};

function memoryStore(extra = {}) {
  const kv = createMemoryKv();
  const library = createMemoryLibraryFactory();
  const store = createLibraryStore({
    platform: { target: "memory", kv, library },
    deviceId: "device-lib",
    now: () => 40,
    ...extra
  });
  return { store, kv, library };
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

async function resetDatabase(factory) {
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

async function withDb(fn) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(NOTES_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("open failed"));
  });
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

async function describeStore(storeName) {
  return withDb(async (db) => {
    const tx = db.transaction(storeName, "readonly");
    const done = waitTx(tx);
    const store = tx.objectStore(storeName);
    const info = {
      version: db.version,
      stores: [...db.objectStoreNames].sort(),
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement === true,
      indexes: [...store.indexNames].sort()
    };
    await done;
    return info;
  });
}

function noteBundle(body = "导入的笔记") {
  return {
    format: NOTES_FORMAT,
    schema: 1,
    docs: [{
      docHash: "doc-a",
      title: "题",
      notes: [{
        id: "n-import",
        schema: 1,
        docHash: "doc-a",
        kind: "note",
        author: "me",
        body,
        anchor: null,
        anchorState: { status: "lost", layoutRev: "", checkedAt: 0 },
        page: 1,
        createdAt: 1,
        updatedAt: 1,
        rev: 1,
        deviceId: "other"
      }]
    }],
    qa: []
  };
}

function secretKeys(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) secretKeys(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    if (/api[-_]?key|secret|password|authorization|token/i.test(key)) found.push(key);
    secretKeys(child, found);
  }
  return found;
}

test("F4-02 upgrade adds library stores and leaves notes, docs, and meta records alone", async () => {
  assert.equal(NOTES_DB_VERSION, 1);
  assert.equal(ANNOTATIONS_DB_VERSION, 2);
  const factory = createIdbLibraryFactory();
  try {
    await resetDatabase(factory);
    let nextId = 0;
    const notes = createNotesStore({
      persist: false,
      deviceId: "device-seed",
      now: () => 5,
      createId: () => `n-${++nextId}`
    });
    assert.deepEqual(await notes.list("doc-a"), []);
    assert.equal((await indexedDB.databases()).some((row) => row.name === NOTES_DB_NAME), false);

    const saved = await notes.put({ docHash: "doc-a", kind: "note", page: 1, body: "留下不改" });
    await notes.softDelete(await notes.put({ docHash: "doc-a", kind: "highlight", page: 2, body: "回收站" }).then((note) => note.id));
    const before = {
      notes: await dump("notes"),
      docs: await dump("docs"),
      meta: await dump("meta"),
      info: await describeStore("notes")
    };
    assert.equal(before.info.version, 1);
    assert.deepEqual(before.info.stores, ["docs", "meta", "notes"]);

    const kv = createMemoryKv();
    const library = createLibraryStore({
      platform: { target: "memory", kv, library: factory },
      persist: false,
      deviceId: "device-lib",
      now: () => 9
    });
    assert.deepEqual(await library.listPapers(), []);
    assert.equal((await describeStore("notes")).version, 1);
    assert.deepEqual((await describeStore("notes")).stores, ["docs", "meta", "notes"]);

    const paper = await library.touchPaper("doc-a", { title: "Attention", pageCount: 15, origin: "native" });
    assert.equal(paper.schema, 2);
    assert.equal(paper.deviceId, "device-seed");
    const afterNotes = await describeStore("notes");
    assert.equal(afterNotes.version, 2);
    assert.deepEqual(afterNotes.indexes, ["byDoc", "byDocPage", "byUpdated"]);
    assert.deepEqual(afterNotes.keyPath, "id");
    assert.deepEqual(JSON.parse(JSON.stringify(await dump("notes"))), JSON.parse(JSON.stringify(before.notes)));
    assert.deepEqual(await dump("docs"), before.docs);
    assert.deepEqual(await dump("meta"), before.meta);

    const papers = await describeStore("papers");
    assert.deepEqual(papers.keyPath, "docHash");
    assert.deepEqual(papers.indexes, ["byArxiv", "byOpened", "byUpdated"]);
    const pages = await describeStore("pages");
    assert.deepEqual(pages.keyPath, ["docHash", "page"]);
    assert.deepEqual(pages.indexes, ["byDoc"]);
    const layouts = await describeStore("layouts");
    assert.deepEqual(layouts.keyPath, ["docHash", "page", "mode", "protocol"]);
    const groups = await describeStore("groups");
    assert.deepEqual(groups.indexes, ["byDoc", "byStartPage"]);
    const changes = await describeStore("changes");
    assert.equal(changes.autoIncrement, true);
    assert.deepEqual(changes.keyPath, "seq");
    assert.deepEqual((await describeStore("sources")).keyPath, "docHash");
    assert.deepEqual((await describeStore("notes")).stores, [
      "changes", "docs", "groups", "layouts", "meta", "notes", "pages", "papers", "sources"
    ]);

    const fresh = createNotesStore({ persist: false, deviceId: "other", now: () => 12, createId: () => "n-new" });
    const listed = await fresh.list("doc-a");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].body, "留下不改");
    assert.equal((await fresh.listTrash("doc-a"))[0].body, "回收站");
    const written = await fresh.put({ docHash: "doc-a", kind: "note", page: 4, body: "升级后仍能写" });
    assert.equal(written.body, "升级后仍能写");
    assert.equal((await dump("notes")).find((row) => row.id === saved.id).body, saved.body);
  } finally {
    await resetDatabase(factory);
  }
});

test("a library read does not create oi-annotations, and a refused persist uses its own key", async () => {
  const factory = createIdbLibraryFactory();
  try {
    await resetDatabase(factory);
    const kv = createMemoryKv();
    const library = createLibraryStore({
      platform: { target: "memory", kv, library: factory },
      deviceId: "device-lib",
      now: () => 3,
      persist: async () => false
    });
    assert.deepEqual(await library.listPapers(), []);
    assert.equal(await library.getPaper("missing"), null);
    assert.deepEqual(await library.getPages("missing"), []);
    assert.equal(await library.getSource("missing"), null);
    assert.deepEqual(await library.changes(0), { items: [], nextSeq: 0 });
    const exported = await library.exportLibrary();
    assert.equal(exported.papers.length, 0);
    assert.equal((await indexedDB.databases()).some((row) => row.name === NOTES_DB_NAME), false);
    assert.equal(await kv.get("local", LIBRARY_PERSIST_HINT_KEY), undefined);

    await library.touchPaper("doc-b", { title: "新建", pageCount: 1, origin: "import" });
    assert.equal((await indexedDB.databases()).some((row) => row.name === NOTES_DB_NAME), true);
    assert.equal((await describeStore("notes")).version, 2);
    assert.equal(await kv.get("local", LIBRARY_SETTINGS_KEYS.persistGranted), false);
    assert.equal(await kv.get("local", LIBRARY_SETTINGS_KEYS.schemaSeen), LIBRARY_SCHEMA);
    assert.equal(await kv.get("local", LIBRARY_SETTINGS_KEYS.backend), "idb");
    assert.equal(await kv.get("local", LIBRARY_PERSIST_HINT_KEY), undefined);
    assert.equal(await kv.get("local", "notesPersistGranted"), undefined);
    assert.equal(await kv.get("local", NOTES_PERSIST_HINT_KEY), undefined);
    assert.equal(LIBRARY_PERSIST_HINT_KEY, "library.persistHintDismissed");
  } finally {
    await resetDatabase(factory);
  }
});

test("library records round-trip reserved fields, changes, and imports", async () => {
  let now = 10;
  const { store, library } = memoryStore({
    persist: async () => true,
    now: () => now
  });
  const seen = [];
  store.subscribe((event) => seen.push(event.collection));
  const paper = await store.touchPaper("doc-a", {
    title: "Attention",
    fileName: "attention.pdf",
    pageCount: 2,
    origin: "native",
    arxiv: { id: "1706.03762", version: "7", key: "1706.03762v7" },
    apiKey: "sk-paper"
  });
  assert.equal(paper.rev, 1);
  assert.equal(paper.apiKey, undefined);
  now = 11;
  const page = await store.putPage("doc-a", 1, {
    pairs: [{
      sourceId: "s1",
      text: "hello",
      sourceText: "hello",
      translation: "你好",
      groupId: "g1",
      memberBids: ["b1"],
      groupRef: { groupId: "g1", startPage: 1 },
      bid: "b1",
      bidV: 1,
      origin: "mt",
      originRef: { arxivKey: "1706.03762v7" },
      apiKey: "sk-pair"
    }],
    skipped: false,
    layoutVersion: "source-v3:abc"
  });
  assert.equal(page.pairs[0].groupId, "g1");
  assert.equal(page.pairs[0].apiKey, undefined);
  assert.equal(page.pairs[0].groupRef.startPage, 1);
  now = 12;
  const group = await store.putGroup({
    docHash: "doc-a",
    groupId: "g1",
    startPage: 1,
    memberBids: [{ bid: "b1", page: 1 }],
    translation: "你好",
    apiKey: "sk-group"
  });
  assert.equal(group.apiKey, undefined);
  assert.equal((await store.getGroups("doc-a", { startPage: 1 }))[0].groupId, "g1");
  now = 13;
  await store.putLayout({
    docHash: "doc-a",
    page: 1,
    mode: "local",
    protocol: "source-v3",
    layoutRev: "source-v3:abc",
    layout: { blocks: [{ id: "b1" }], apiKey: "sk-layout" }
  });
  const layout = await store.getLayout("doc-a", 1, "local", "source-v3");
  assert.equal(layout.layout.apiKey, undefined);
  assert.equal(layout.layout.blocks[0].id, "b1");
  await store.putSource("doc-a", new Blob(["%PDF"]));
  assert.equal(new TextDecoder().decode(await (await store.getSource("doc-a")).arrayBuffer()), "%PDF");

  const listed = await store.listPapers({ sort: "opened" });
  assert.equal(listed[0].title, "Attention");
  const firstPage = await store.changes(0, { limit: 2 });
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.items[0].seq, 1);
  assert.equal(firstPage.nextSeq, 2);
  const rest = await store.changes(firstPage.nextSeq);
  assert.equal(rest.items[0].seq, 3);
  assert.equal(rest.items.every((item) => item.collection !== "layouts"), true);
  assert.equal(rest.items.every((item) => item.collection !== "sources"), true);
  assert.equal(JSON.stringify(await store.changes(0)).includes("sk-"), false);

  const exported = await store.exportLibrary({ exportedAt: 13, appVersion: "0.3.0" });
  assert.equal(exported.format, LIBRARY_FORMAT);
  assert.equal(exported.schema, LIBRARY_SCHEMA);
  assert.equal(exported.papers[0].layouts, undefined);
  assert.equal(exported.papers[0].source, undefined);
  assert.deepEqual(secretKeys(exported), []);
  assert.equal(JSON.stringify(exported).includes("sk-"), false);
  assert.equal(exported.papers[0].pages[0].pairs[0].memberBids[0], "b1");

  const withSource = await store.exportLibrary({
    exportedAt: 13,
    appVersion: "0.3.0",
    include: { sources: true, layouts: true }
  });
  assert.equal(withSource.papers[0].layouts[0].layout.blocks[0].id, "b1");
  assert.equal(typeof withSource.papers[0].source.base64, "string");

  const empty = createLibraryStore({
    platform: { target: "memory", kv: createMemoryKv(), library: createMemoryLibraryFactory() },
    persist: false,
    deviceId: "device-other",
    now: () => 20
  });
  const imported = await empty.importBundle(exported);
  assert.equal(imported.added >= 3, true);
  assert.equal(imported.errors.length, 0);
  const again = await empty.importBundle(exported);
  assert.equal(again.added, 0);
  assert.equal(again.updated, 0);
  const revived = await empty.getPage("doc-a", 1);
  assert.equal(revived.pairs[0].translation, "你好");
  assert.equal(revived.pairs[0].groupRef.groupId, "g1");
  assert.equal((await empty.getGroups("doc-a"))[0].translation, "你好");
  assert.deepEqual(secretKeys(await empty.exportLibrary({ exportedAt: 13, appVersion: "0.3.0" })), []);

  now = 30;
  await store.putPage("doc-a", 1, { pairs: [{ text: "本地更新", translation: "本地" }] });
  await store.putPage("doc-a", 2, { pairs: [{ text: "只在本地", translation: "留" }] });
  const stale = structuredClone(exported);
  stale.papers[0].pages[0].pairs = [{ text: "旧批次", translation: "不要盖" }];
  stale.papers[0].pages[0].rev = 1;
  stale.papers[0].pages[0].updatedAt = 1;
  const kept = await store.importBundle(stale);
  assert.equal(kept.skipped >= 1, true);
  assert.equal((await store.getPage("doc-a", 1)).pairs[0].translation, "本地");
  assert.equal((await store.getPage("doc-a", 2)).pairs[0].text, "只在本地");

  const newer = structuredClone(exported);
  newer.papers[0].pages[0].pairs = [{ text: "hello", translation: "更新", groupId: "g1" }];
  newer.papers[0].pages[0].rev = (await store.getPage("doc-a", 1)).rev;
  newer.papers[0].pages[0].updatedAt = 99;
  await store.importBundle(newer);
  assert.equal((await store.getPage("doc-a", 1)).pairs[0].translation, "更新");
  assert.equal((await store.getPage("doc-a", 2)).pairs[0].text, "只在本地");

  const remote = await store.changes(0);
  const other = createLibraryStore({
    platform: { target: "memory", kv: createMemoryKv(), library: createMemoryLibraryFactory() },
    persist: false,
    deviceId: "device-remote",
    now: () => 100
  });
  await other.putPage("doc-a", 9, { pairs: [{ text: "本地多出来的", translation: "留" }] });
  const applied = await other.applyRemote([
    remote.items.find((item) => item.collection === "pages" && item.key?.[1] === 1),
    { collection: "pages", key: ["doc-a", 9], rev: 1, op: "delete" }
  ]);
  assert.equal(applied.applied >= 1, true);
  assert.equal(applied.kept >= 1, true);
  assert.equal((await other.getPage("doc-a", 9)).pairs[0].text, "本地多出来的");
  const older = structuredClone(remote.items.find((item) => item.collection === "pages" && item.key?.[1] === 1));
  older.record.rev = 1;
  older.record.translation = "太旧";
  older.record.pairs = [{ text: "太旧", translation: "太旧" }];
  const keptRemote = await other.applyRemote([older]);
  assert.equal(keptRemote.kept, 1);
  assert.notEqual((await other.getPage("doc-a", 1)).pairs[0].translation, "太旧");

  const notes = await store.importBundle(noteBundle());
  assert.equal(notes.added, 1);
  const exportedNotes = await store.exportLibrary({ exportedAt: 40, appVersion: "0.3.0" });
  assert.equal(exportedNotes.papers.find((item) => item.paper.docHash === "doc-a").notes[0].body, "导入的笔记");
  await assert.rejects(
    () => store.importBundle({ format: LIBRARY_FORMAT, schema: 3, papers: [] }),
    (error) => error.type === "schema"
  );
  await assert.rejects(
    () => store.importBundle({ format: NOTES_FORMAT, schema: 2, docs: [] }),
    (error) => error.type === "schema"
  );
  assert.equal((await store.getPaper("doc-a")).title, "Attention");
  await assert.rejects(
    () => store.importBundle({ format: LIBRARY_FORMAT, schema: 2, papers: [] }, { mode: "replace" }),
    (error) => error.type === "invalid"
  );

  const usage = await store.usage();
  assert.equal(usage.persisted, true);
  assert.equal(usage.byDoc.get("doc-a") > 0, true);
  assert.equal(seen.includes("papers"), true);
  assert.equal(library.exists(ANNOTATIONS_SCHEMA.version ? "oi-annotations" : ""), true);
});

test("deletePaperData removes only the asked collections and keeps other papers", async () => {
  const { store } = memoryStore({ persist: false });
  let arxiv = 0;
  const hooked = createLibraryStore({
    platform: store.platform(),
    persist: false,
    deviceId: "device-lib",
    now: () => 7,
    deleteArxiv: async () => {
      arxiv += 1;
    }
  });
  await hooked.touchPaper("doc-a", { title: "A", pageCount: 1, origin: "native" });
  await hooked.touchPaper("doc-b", { title: "B", pageCount: 1, origin: "native" });
  await hooked.putPage("doc-a", 1, { pairs: [{ text: "甲", translation: "甲" }] });
  await hooked.putLayout({ docHash: "doc-a", page: 1, mode: "local", protocol: "v", layoutRev: "v", layout: { ok: true } });
  await hooked.putSource("doc-a", new Blob(["pdf-a"]));
  await hooked.putGroup({ docHash: "doc-a", groupId: "g", startPage: 1, memberBids: [] });
  const report = await hooked.deletePaperData("doc-a", { arxiv: true });
  assert.equal(report.pages, 1);
  assert.equal(report.layouts, 1);
  assert.equal(report.groups, 1);
  assert.equal(report.notes, 0);
  assert.equal(report.sources, 0);
  assert.equal(report.arxiv, true);
  assert.equal(arxiv, 1);
  assert.equal(await hooked.getPage("doc-a", 1), null);
  assert.equal(await hooked.getLayout("doc-a", 1, "local", "v"), null);
  assert.equal((await hooked.getSource("doc-a")) instanceof Blob, true);
  assert.equal((await hooked.listPapers()).map((item) => item.docHash).includes("doc-a"), false);
  assert.equal((await hooked.listPapers({ includeDeleted: true })).some((item) => item.docHash === "doc-a"), true);
  assert.equal((await hooked.getPaper("doc-b")).title, "B");
});

test("F4-16 library writes do not call fetch", async () => {
  const before = fetchCalls;
  const { store } = memoryStore({ persist: false });
  await store.touchPaper("doc-a", { title: "离线", pageCount: 1 });
  await store.putPage("doc-a", 1, { pairs: [{ text: "a", translation: "b" }] });
  await store.exportLibrary();
  assert.equal(fetchCalls, before);
  assert.throws(
    () => globalThis.fetch("http://127.0.0.1:8765/v1/library/document?hash=abc"),
    (error) => error.code === "live-fetch-blocked"
  );
});

test("a quota failure is typed and does not pretend the page was stored", async () => {
  const { store, library } = memoryStore({ persist: false });
  const backend = await library.open("oi-annotations", ANNOTATIONS_SCHEMA);
  const originalTx = backend.tx.bind(backend);
  backend.tx = async (collections, mode, fn) => {
    if ([].concat(collections).includes("pages")) {
      const error = new Error("quota");
      error.name = "QuotaExceededError";
      throw error;
    }
    return originalTx(collections, mode, fn);
  };
  const guarded = createLibraryStore({
    backend,
    blobs: await library.blobs("oi-annotations", ANNOTATIONS_SCHEMA),
    platform: store.platform(),
    persist: false,
    deviceId: "device-lib",
    now: () => 4
  });
  await assert.rejects(
    () => guarded.putPage("doc-a", 1, { pairs: [{ text: "甲", translation: "乙" }] }),
    (error) => error.type === "quota" && /备份/.test(error.message)
  );
  assert.equal(await guarded.getPage("doc-a", 1), null);
});

test("product files do not leak an IndexedDB range type into the shared interface", () => {
  const read = (path) => readFileSync(join(root, path), "utf8");
  assert.equal(read("lib/library-store.js").includes("IDBKeyRange"), false);
  assert.equal(read("lib/platform/memory-backend.js").includes("IDBKeyRange"), false);
  assert.equal(read("lib/platform/record-key.js").includes("IDBKeyRange"), false);
  assert.equal(read("lib/platform/index.js").includes("IDBKeyRange"), false);
  assert.equal(read("lib/platform/idb-backend.js").includes("IDBKeyRange"), true);
  assert.equal(read("lib/platform/idb-backend.js").includes("Array.from"), false);
  assert.equal(read("pdf/viewer.js").includes("createLibraryStore"), false);
  assert.equal(read("lib/pdf-library.js").includes("createLibraryStore"), false);
});

test("touchPaper, putPage, and putGroup read the previous rev inside the write", async () => {
  const { library } = memoryStore({ persist: false });
  const backend = await library.open("oi-annotations", ANNOTATIONS_SCHEMA);
  const events = [];
  const originalTx = backend.tx.bind(backend);
  backend.tx = (collections, mode, fn) => {
    const names = [].concat(collections);
    const watched = names.some((name) => name === "papers" || name === "pages" || name === "groups");
    if (watched) events.push(`tx:${names.filter((name) => name !== "changes").join("+")}`);
    return originalTx(collections, mode, (work) => fn({
      get(collection, key) {
        if (watched) events.push(`get:${collection}`);
        return work.get(collection, key);
      },
      getAll: (...args) => work.getAll(...args),
      put(collection, record) {
        if (watched && collection !== "changes") events.push(`put:${collection}`);
        return work.put(collection, record);
      },
      delete: (...args) => work.delete(...args)
    }));
  };
  const store = createLibraryStore({
    backend,
    blobs: await library.blobs("oi-annotations", ANNOTATIONS_SCHEMA),
    platform: { target: "memory", kv: createMemoryKv(), library },
    persist: false,
    deviceId: "device-lib",
    now: () => 4
  });
  await store.touchPaper("doc-a", { title: "A", pageCount: 1, origin: "native" });
  await store.putPage("doc-a", 1, { pairs: [{ text: "甲", translation: "乙" }] });
  await store.putGroup({ docHash: "doc-a", groupId: "g", startPage: 1, memberBids: [] });
  assert.deepEqual(events, [
    "tx:papers", "get:papers", "put:papers",
    "tx:pages", "get:pages", "put:pages",
    "tx:groups", "get:groups", "put:groups"
  ]);
  assert.equal((await store.getPaper("doc-a")).rev, 1);
  await store.touchPaper("doc-a", { title: "A2" });
  assert.equal((await store.getPaper("doc-a")).rev, 2);
});

const BASE64_PROBE = 40000;

test("import keeps layouts and sources that export produced", async () => {
  const { store } = memoryStore({ persist: false, now: () => 15 });
  await store.touchPaper("doc-a", { title: "Attention", pageCount: 1, origin: "native" });
  await store.putLayout({
    docHash: "doc-a",
    page: 1,
    mode: "local",
    protocol: "source-v3",
    layoutRev: "source-v3:abc",
    layout: { blocks: [{ id: "b1" }], apiKey: "sk-layout" }
  });
  const bytes = new Uint8Array(BASE64_PROBE);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  await store.putSource("doc-a", new Blob([bytes], { type: "application/pdf" }));
  const exported = await store.exportLibrary({
    exportedAt: 15,
    appVersion: "0.3.0",
    include: { layouts: true, sources: true, notes: false }
  });
  assert.equal(exported.papers[0].layouts[0].layout.apiKey, undefined);
  assert.equal(exported.papers[0].source.base64.length > bytes.length, true);
  const empty = createLibraryStore({
    platform: { target: "memory", kv: createMemoryKv(), library: createMemoryLibraryFactory() },
    persist: false,
    deviceId: "device-other",
    now: () => 16
  });
  const imported = await empty.importBundle(exported);
  assert.equal(imported.errors.length, 0);
  const layout = await empty.getLayout("doc-a", 1, "local", "source-v3");
  assert.equal(layout.layout.blocks[0].id, "b1");
  assert.equal(layout.layout.apiKey, undefined);
  const source = new Uint8Array(await (await empty.getSource("doc-a")).arrayBuffer());
  assert.deepEqual(source, bytes);
  const again = await empty.importBundle(exported);
  assert.equal(again.added, 0);
});

test("a live notes store stays current across a v2 open, import, and trash", async () => {
  const factory = createIdbLibraryFactory();
  try {
    await resetDatabase(factory);
    let now = 6;
    let nextId = 0;
    const notes = createNotesStore({
      persist: false,
      deviceId: "device-seed",
      now: () => now,
      createId: () => `n-live-${++nextId}`
    });
    const first = await notes.put({ docHash: "doc-a", kind: "note", page: 1, body: "升级前" });
    const library = createLibraryStore({
      platform: { target: "idb", kv: createMemoryKv(), library: factory },
      notes,
      persist: false,
      deviceId: "device-lib",
      now: () => now
    });
    const [paper, during] = await Promise.all([
      library.touchPaper("doc-a", { title: "Attention", pageCount: 1, origin: "native" }),
      notes.put({ docHash: "doc-a", kind: "highlight", page: 2, body: "同时写" })
    ]);
    assert.equal(paper.schema, LIBRARY_SCHEMA);
    assert.equal(during.body, "同时写");
    assert.equal((await describeStore("notes")).version, 2);
    const imported = await library.importBundle(noteBundle("面板能看见"));
    assert.equal(imported.added >= 1, true);
    assert.equal((await notes.list("doc-a")).some((note) => note.body === "面板能看见"), true);
    now = 9;
    const report = await library.deletePaperData("doc-a", { notes: true });
    assert.equal(report.notes, 3);
    assert.equal((await notes.list("doc-a")).length, 0);
    const trash = await notes.listTrash("doc-a");
    assert.deepEqual(trash.map((note) => note.body).sort(), ["升级前", "同时写", "面板能看见"]);
    assert.equal(trash.every((note) => note.deletedAt), true);
    const fresh = createNotesStore({ persist: false, deviceId: "other", now: () => 11, createId: () => "n-other" });
    assert.equal((await fresh.list("doc-a")).length, 0);
    assert.equal((await fresh.listTrash("doc-a")).length, 3);
    assert.equal((await fresh.get(first.id)).deletedAt > 0, true);
    const disk = await dump("notes");
    assert.equal(disk.length, 3);
    assert.equal(disk.every((note) => note.deletedAt), true);
  } finally {
    await resetDatabase(factory);
  }
});

test("a blocked upgrade times out with a typed error and can be retried", async () => {
  const factory = createIdbLibraryFactory();
  try {
    await resetDatabase(factory);
    const notes = createNotesStore({
      persist: false,
      deviceId: "device-seed",
      now: () => 3,
      createId: () => "n-block"
    });
    await notes.put({ docHash: "doc-a", kind: "note", page: 1, body: "还在 v1" });
    const held = await new Promise((resolve, reject) => {
      const request = indexedDB.open(NOTES_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("open failed"));
    });
    held.onversionchange = () => {};
    const library = createLibraryStore({
      platform: { target: "idb", kv: createMemoryKv(), library: factory },
      persist: false,
      deviceId: "device-lib",
      now: () => 4,
      blockedTimeoutMs: 40
    });
    try {
      const result = await Promise.race([
        library.touchPaper("doc-a", { title: "升", pageCount: 1 }).then(() => "opened", (error) => error),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 1000))
      ]);
      assert.notEqual(result, "hung");
      assert.equal(result.type, "blocked");
      assert.equal(result.name, "LibraryStoreError");
      const rows = await indexedDB.databases();
      assert.equal(rows.find((row) => row.name === NOTES_DB_NAME)?.version, 1);
    } finally {
      held.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    const paper = await library.touchPaper("doc-a", { title: "升", pageCount: 1, origin: "native" });
    assert.equal(paper.title, "升");
    assert.equal((await describeStore("notes")).version, 2);
    assert.equal((await notes.list("doc-a"))[0].body, "还在 v1");
  } finally {
    await resetDatabase(factory);
  }
});

test("a browser without databases() does not create or upgrade on a library read", async () => {
  const factory = createIdbLibraryFactory();
  try {
    await resetDatabase(factory);
    const notes = createNotesStore({
      persist: false,
      deviceId: "device-seed",
      now: () => 2,
      createId: () => "n-nodb"
    });
    await notes.put({ docHash: "doc-a", kind: "note", page: 1, body: "v1" });
    assert.equal(await indexedDatabaseExists(NOTES_DB_NAME), true);
    const original = indexedDB.databases;
    indexedDB.databases = undefined;
    try {
      assert.equal(await indexedDatabaseExists(NOTES_DB_NAME), false);
      const library = createLibraryStore({
        platform: { target: "idb", kv: createMemoryKv(), library: factory },
        persist: false,
        deviceId: "device-lib",
        now: () => 2
      });
      assert.deepEqual(await library.listPapers(), []);
      assert.equal(await library.getPaper("doc-a"), null);
      assert.equal((await describeStore("notes")).version, 1);
      assert.deepEqual((await describeStore("notes")).stores, ["docs", "meta", "notes"]);
    } finally {
      indexedDB.databases = original;
    }
  } finally {
    await resetDatabase(factory);
  }
});
