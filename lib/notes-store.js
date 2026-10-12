/**
 * Library storage.
 *
 * T2a opens one collection: notes, in IndexedDB `oi-annotations`.
 * Papers, layouts, and translations are the same kind of collection
 * (keyed by docHash, with rev / deviceId, export / import, changes, subscribe)
 * and still live in lib/pdf-library.js. A later step adds them behind this
 * factory. CloudNotesStore implements the same notes methods; callers stay
 * on createNotesStore() and never call indexedDB themselves.
 *
 * Deleted notes stay in the recycle bin until purge(id). Nothing is purged by age.
 */

import {
  NOTE_AUTHORS,
  NOTE_KINDS,
  NOTE_SCHEMA,
  NotesStoreError,
  copyAnchorState,
  copyNoteQa,
  currentAppVersion,
  exportNotesBundle,
  mergeNotesBundle
} from "./notes-io.js";

export {
  NOTE_AUTHORS,
  NOTE_KINDS,
  NOTE_SCHEMA,
  NotesStoreError,
  migrations,
  migrateNote
} from "./notes-io.js";

export const NOTES_DB_NAME = "oi-annotations";
export const NOTES_DB_VERSION = 1;

/** Which library collections this interface is shaped for. Only notes is open. */
export const LIBRARY_COLLECTIONS = Object.freeze({
  papers: "reserved",
  layouts: "reserved",
  translations: "reserved",
  notes: NOTES_DB_NAME
});

const DB_STEPS = [
  function upgradeTo1(db) {
    const notes = db.createObjectStore("notes", { keyPath: "id" });
    notes.createIndex("byDoc", "docHash", { unique: false });
    notes.createIndex("byDocPage", ["docHash", "page"], { unique: false });
    notes.createIndex("byUpdated", "updatedAt", { unique: false });
    db.createObjectStore("docs", { keyPath: "docHash" });
    db.createObjectStore("meta", { keyPath: "key" });
  }
];

/**
 * IndexedDB upgrade, one version at a time.
 * Record migrations for a future database version use migrations[n] from notes-io.js.
 */
export function upgradeNotesDatabase(db, oldVersion) {
  const from = Number(oldVersion) || 0;
  for (let version = from; version < NOTES_DB_VERSION; version += 1) {
    const step = DB_STEPS[version];
    if (typeof step === "function") step(db);
  }
}

export function wrapStoreError(error) {
  if (error instanceof NotesStoreError) return error;
  const name = String(error?.name || "");
  if (name === "QuotaExceededError") {
    return new NotesStoreError("quota", "笔记存储空间不够。可以先导出 JSON 备份。", { cause: error });
  }
  if (name === "InvalidStateError" || name === "UnknownError" || name === "SecurityError") {
    return new NotesStoreError("private", "当前环境写不了笔记库，笔记还留在这次打开的内存里。", { cause: error });
  }
  return new NotesStoreError("write", "笔记没有写入磁盘，这次打开的内存里还有。", { cause: error });
}

export async function requestBrowserPersist() {
  const storage = globalThis.navigator?.storage;
  if (!storage) return false;
  try {
    if (typeof storage.persist === "function") return (await storage.persist()) === true;
    if (typeof storage.persisted === "function") return (await storage.persisted()) === true;
  } catch {
    return false;
  }
  return false;
}

async function recordNotesSettings(patch, settings) {
  try {
    if (settings?.set) {
      await settings.set(patch);
      return;
    }
    const local = globalThis.chrome?.storage?.local;
    if (typeof local?.set === "function") await local.set(patch);
  } catch {
    /* the note write still stands; export is the backup */
  }
}

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function byCreated(a, b) {
  return (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id));
}

function promisify(request) {
  if (!request) return Promise.resolve(undefined);
  if (typeof request.then === "function") return request;
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexedDB request failed"));
  });
}

function transactionDone(tx) {
  if (!tx) return Promise.resolve();
  if (tx.done && typeof tx.done.then === "function") return tx.done;
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("indexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("indexedDB transaction aborted"));
  });
}

function idbFactory() {
  const indexedDB = globalThis.indexedDB;
  if (!indexedDB || typeof indexedDB.open !== "function") return null;
  return indexedDB;
}

/**
 * Names of existing databases, or null when the browser cannot list them.
 * indexedDB.open creates a missing database, so a read must not call it.
 * databases() does not create one. Chrome exposes it; a browser without it
 * is treated as "do not open" on the read path.
 */
export async function listNotesDatabases() {
  const indexedDB = idbFactory();
  if (!indexedDB || typeof indexedDB.databases !== "function") return null;
  const rows = await indexedDB.databases();
  return (rows || []).map((row) => String(row?.name || "")).filter(Boolean);
}

function openNotesDatabase() {
  return new Promise((resolve, reject) => {
    const indexedDB = idbFactory();
    if (!indexedDB) {
      const error = new Error("indexedDB missing");
      error.name = "InvalidStateError";
      reject(error);
      return;
    }
    const request = indexedDB.open(NOTES_DB_NAME, NOTES_DB_VERSION);
    request.onupgradeneeded = (event) => {
      upgradeNotesDatabase(request.result, event.oldVersion);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexedDB open failed"));
  });
}

export function indexedDbAvailable() {
  return idbFactory() !== null;
}

export class MemoryNotesStore {
  constructor(options = {}) {
    this.options = options;
    this.notes = new Map();
    this.docs = new Map();
    this.qa = [];
    this.listeners = new Set();
    this.deviceId = options.deviceId || defaultId();
    this.lastExportAt = 0;
    this.persistRecord = null;
    this.persisted = false;
    this.persisting = null;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.createId = typeof options.createId === "function" ? options.createId : defaultId;
  }

  noteCount() {
    return this.notes.size;
  }

  setDeviceId(id) {
    if (id) this.deviceId = String(id);
  }

  keep(note) {
    if (!note?.id) return;
    this.notes.set(note.id, clone(note));
    this.touchDoc(note.docHash);
  }

  loadSnapshot({ notes, docs, qa, deviceId, lastExportAt } = {}) {
    this.notes = new Map();
    for (const note of notes || []) {
      if (note?.id) this.notes.set(note.id, clone(note));
    }
    this.docs = new Map();
    for (const doc of docs || []) {
      if (doc?.docHash) this.docs.set(doc.docHash, clone(doc));
    }
    this.qa = Array.isArray(qa) ? clone(qa) : [];
    if (deviceId) this.deviceId = String(deviceId);
    if (lastExportAt) this.lastExportAt = Number(lastExportAt) || 0;
  }

  metaRows() {
    const rows = [
      { key: "schemaVersion", value: NOTE_SCHEMA },
      { key: "deviceId", value: this.deviceId },
      { key: "qa", value: clone(this.qa) }
    ];
    if (this.lastExportAt) rows.push({ key: "lastExportAt", value: this.lastExportAt });
    return rows;
  }

  async ensurePersist() {
    if (this.persisted || this.options.persist === false) return;
    if (!this.persisting) {
      this.persisting = (async () => {
        let granted = false;
        try {
          if (typeof this.options.persist === "function") granted = (await this.options.persist()) === true;
          else granted = await requestBrowserPersist();
        } catch {
          granted = false;
        }
        const patch = { notesPersistGranted: granted, notesSchemaSeen: NOTE_SCHEMA };
        await recordNotesSettings(patch, this.options.settings);
        this.persistRecord = patch;
        this.persisted = true;
      })();
    }
    await this.persisting;
  }

  subscribe(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  notify(event) {
    for (const cb of [...this.listeners]) {
      try {
        cb(event);
      } catch {
        /* a listener must not break the write */
      }
    }
  }

  touchDoc(docHash, extra = {}) {
    const prev = this.docs.get(docHash) || { docHash };
    const notesCount = [...this.notes.values()].filter((note) => note.docHash === docHash && !note.deletedAt).length;
    const layoutRev = extra.layoutRev || prev.layoutRev || "";
    const title = extra.title || prev.title || "";
    const doc = { docHash, notesCount, updatedAt: this.now() };
    if (title) doc.title = title;
    if (layoutRev) doc.layoutRev = layoutRev;
    this.docs.set(docHash, doc);
    return doc;
  }

  writePut(input) {
    if (!input || typeof input !== "object") throw new NotesStoreError("invalid", "笔记格式不对。");
    const declared = input.schema == null ? NOTE_SCHEMA : Number(input.schema);
    if (Number.isInteger(declared) && declared > NOTE_SCHEMA) {
      throw new NotesStoreError(
        "schema",
        `这份笔记来自更新的扩展（格式版本 ${declared}），请先升级扩展后再导入。`,
        { schema: declared, supported: NOTE_SCHEMA }
      );
    }
    const id = input.id ? String(input.id) : this.createId();
    const existing = this.notes.get(id) || null;
    const kind = input.kind || existing?.kind;
    if (!NOTE_KINDS.includes(kind)) throw new NotesStoreError("invalid", "笔记种类不对。");
    const docHash = String(input.docHash || existing?.docHash || "");
    if (!docHash) throw new NotesStoreError("invalid", "笔记缺少文档。");
    const author = input.author || existing?.author || "me";
    if (!NOTE_AUTHORS.includes(author)) throw new NotesStoreError("invalid", "笔记作者不对。");
    const now = this.now();
    const anchor = kind === "paperNote"
      ? null
      : (input.anchor === undefined ? (existing?.anchor ?? null) : (input.anchor ? clone(input.anchor) : null));
    const page = input.page == null
      ? (existing?.page ?? anchor?.page ?? 0)
      : Math.max(0, Math.floor(Number(input.page) || 0));
    const note = {
      id,
      schema: NOTE_SCHEMA,
      docHash,
      kind,
      author,
      anchor,
      anchorState: copyAnchorState(input.anchorState || existing?.anchorState, anchor, kind),
      page,
      createdAt: existing?.createdAt || (Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : now),
      updatedAt: now,
      rev: existing ? existing.rev + 1 : 1,
      deviceId: this.deviceId
    };
    if (input.body != null) note.body = String(input.body);
    else if (existing?.body != null) note.body = existing.body;
    if (input.title != null) note.title = String(input.title);
    else if (existing?.title != null) note.title = existing.title;
    const qa = input.qa === undefined ? existing?.qa : copyNoteQa(input.qa);
    if (qa) note.qa = qa;
    if (existing?.deletedAt) note.deletedAt = existing.deletedAt;
    this.notes.set(id, note);
    this.touchDoc(docHash);
    return note;
  }

  async put(input) {
    await this.ensurePersist();
    const note = this.writePut(input);
    const copy = clone(note);
    this.notify({ type: "put", note: copy });
    return copy;
  }

  async bulkPut(notes) {
    const saved = [];
    for (const note of notes || []) saved.push(await this.put(note));
    return saved;
  }

  async get(id) {
    const note = this.notes.get(String(id || ""));
    return note ? clone(note) : null;
  }

  async list(docHash, options = {}) {
    const kinds = Array.isArray(options.kinds) ? new Set(options.kinds) : null;
    const includeDeleted = options.includeDeleted === true;
    return [...this.notes.values()].filter((note) => {
      if (note.docHash !== docHash) return false;
      if (!includeDeleted && note.deletedAt) return false;
      if (kinds && !kinds.has(note.kind)) return false;
      return true;
    }).sort(byCreated).map(clone);
  }

  async listTrash(docHash) {
    return [...this.notes.values()].filter((note) => {
      if (!note.deletedAt) return false;
      if (docHash && note.docHash !== docHash) return false;
      return true;
    }).sort((a, b) => b.deletedAt - a.deletedAt || String(a.id).localeCompare(String(b.id))).map(clone);
  }

  async softDelete(id) {
    const existing = this.notes.get(String(id || ""));
    if (!existing) throw new NotesStoreError("not-found", "没有这条笔记。");
    if (existing.deletedAt) return clone(existing);
    await this.ensurePersist();
    const now = this.now();
    const note = { ...existing, deletedAt: now, updatedAt: now, rev: existing.rev + 1 };
    this.notes.set(note.id, note);
    this.touchDoc(note.docHash);
    const copy = clone(note);
    this.notify({ type: "softDelete", note: copy });
    return copy;
  }

  async restore(id) {
    const existing = this.notes.get(String(id || ""));
    if (!existing) throw new NotesStoreError("not-found", "没有这条笔记。");
    if (!existing.deletedAt) return clone(existing);
    await this.ensurePersist();
    const now = this.now();
    const note = { ...existing, updatedAt: now, rev: existing.rev + 1 };
    delete note.deletedAt;
    this.notes.set(note.id, note);
    this.touchDoc(note.docHash);
    const copy = clone(note);
    this.notify({ type: "restore", note: copy });
    return copy;
  }

  async purge(id) {
    const key = String(id || "");
    const existing = this.notes.get(key);
    if (!existing) return null;
    await this.ensurePersist();
    this.notes.delete(key);
    this.touchDoc(existing.docHash);
    const copy = clone(existing);
    this.notify({ type: "purge", id: key, note: copy });
    return copy;
  }

  async changes(sinceRev = 0) {
    const since = Number(sinceRev) || 0;
    return [...this.notes.values()]
      .filter((note) => note.rev > since)
      .sort((a, b) => a.rev - b.rev || String(a.id).localeCompare(String(b.id)))
      .map(clone);
  }

  async exportDoc(docHash, options = {}) {
    const notes = await this.list(docHash, { includeDeleted: options.includeDeleted === true });
    const bundle = this.bundle([{ docHash, ...(this.docs.get(docHash) || {}), notes }], options);
    this.lastExportAt = bundle.exportedAt;
    return bundle;
  }

  async exportAll(options = {}) {
    const includeDeleted = options.includeDeleted === true;
    const byDoc = new Map();
    for (const note of this.notes.values()) {
      if (!includeDeleted && note.deletedAt) continue;
      if (!byDoc.has(note.docHash)) byDoc.set(note.docHash, []);
      byDoc.get(note.docHash).push(clone(note));
    }
    const docs = [...byDoc.keys()].sort().map((docHash) => ({
      docHash,
      ...(this.docs.get(docHash) || {}),
      notes: byDoc.get(docHash)
    }));
    const bundle = this.bundle(docs, options);
    this.lastExportAt = bundle.exportedAt;
    return bundle;
  }

  bundle(docs, options = {}) {
    return exportNotesBundle({
      docs,
      qa: this.qa,
      exportedAt: options.exportedAt == null ? this.now() : options.exportedAt,
      appVersion: options.appVersion || currentAppVersion()
    });
  }

  async import(bundle, options = {}) {
    const mode = options.mode || "merge";
    if (mode !== "merge") {
      throw new NotesStoreError("invalid", "导入只支持合并，不会删除本地笔记。");
    }
    const planned = mergeNotesBundle([...this.notes.values()], bundle, this.qa);
    await this.ensurePersist();
    for (const note of planned.writes) this.notes.set(note.id, clone(note));
    this.qa = planned.qa;
    const touched = new Set();
    for (const [docHash, meta] of planned.docMeta) {
      this.touchDoc(docHash, { title: meta.title, layoutRev: meta.layoutRev });
      touched.add(docHash);
    }
    for (const note of planned.writes) {
      if (touched.has(note.docHash)) continue;
      this.touchDoc(note.docHash);
      touched.add(note.docHash);
    }
    const result = {
      added: planned.added,
      updated: planned.updated,
      skipped: planned.skipped,
      rejected: planned.rejected
    };
    this.notify({ type: "import", ...result });
    return result;
  }
}

async function readAll(db, name) {
  const tx = db.transaction(name, "readonly");
  const done = transactionDone(tx);
  const rows = await promisify(tx.objectStore(name).getAll());
  await done;
  return rows || [];
}

async function writeSnapshot(db, { notes = [], docs = [], meta = [], deleteIds = [] } = {}) {
  const tx = db.transaction(["notes", "docs", "meta"], "readwrite");
  const done = transactionDone(tx);
  const noteStore = tx.objectStore("notes");
  const docStore = tx.objectStore("docs");
  const metaStore = tx.objectStore("meta");
  for (const id of deleteIds) await promisify(noteStore.delete(id));
  for (const note of notes) await promisify(noteStore.put(clone(note)));
  for (const doc of docs) await promisify(docStore.put(clone(doc)));
  for (const row of meta) await promisify(metaStore.put(clone(row)));
  await done;
}

export class IdbNotesStore {
  constructor(options = {}) {
    this.options = options;
    this.memory = new MemoryNotesStore({ ...options, persist: false, settings: null });
    this.queue = Promise.resolve();
    this.dbPromise = null;
    this.hydrated = false;
    this.diskMissing = false;
    this.dbBroken = null;
    this.persisted = false;
    this.persisting = null;
  }

  run(task) {
    const next = this.queue.then(task, task);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async database() {
    if (this.dbBroken) throw this.dbBroken;
    if (!this.dbPromise) {
      const open = this.options.openDatabase || openNotesDatabase;
      this.dbPromise = Promise.resolve().then(() => open()).catch((error) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }

  async databaseExists() {
    if (this.options.openDatabase) return true;
    let names = null;
    try {
      names = this.options.listDatabases
        ? await this.options.listDatabases()
        : await listNotesDatabases();
    } catch {
      return false;
    }
    if (names == null) return false;
    return names.includes(NOTES_DB_NAME);
  }

  /**
   * Read path. A missing oi-annotations database stays missing:
   * list / get / listTrash / changes do not call indexedDB.open.
   */
  async hydrate() {
    if (this.hydrated) return;
    if (!(await this.databaseExists())) {
      this.hydrated = true;
      this.diskMissing = true;
      return;
    }
    await this.loadFromDisk();
  }

  /** First write. Opens (and therefore creates) the database. */
  async openMissingDisk() {
    if (!this.diskMissing) return;
    await this.loadFromDisk();
  }

  async loadFromDisk() {
    if (this.dbBroken) return;
    let db = null;
    try {
      db = await this.database();
    } catch (error) {
      this.hydrated = true;
      this.diskMissing = false;
      this.dbBroken = wrapStoreError(error);
      return;
    }
    try {
      const [notes, docs, meta] = await Promise.all([
        readAll(db, "notes"),
        readAll(db, "docs"),
        readAll(db, "meta")
      ]);
      if (this.memory.noteCount() === 0) {
        const row = (key) => meta.find((item) => item?.key === key)?.value;
        this.memory.loadSnapshot({
          notes,
          docs,
          qa: row("qa") || [],
          deviceId: row("deviceId") || "",
          lastExportAt: row("lastExportAt") || 0
        });
      }
      this.hydrated = true;
      this.diskMissing = false;
    } catch (error) {
      this.hydrated = true;
      this.diskMissing = false;
      this.dbBroken = wrapStoreError(error);
    }
  }

  async ensurePersist() {
    if (this.persisted || this.options.persist === false) return;
    if (!this.persisting) {
      this.persisting = (async () => {
        let granted = false;
        try {
          if (typeof this.options.persist === "function") granted = (await this.options.persist()) === true;
          else granted = await requestBrowserPersist();
        } catch {
          granted = false;
        }
        const patch = { notesPersistGranted: granted, notesSchemaSeen: NOTE_SCHEMA };
        await recordNotesSettings(patch, this.options.settings);
        this.memory.persistRecord = patch;
        this.persisted = true;
      })();
    }
    await this.persisting;
  }

  async mirror(write) {
    if (this.dbBroken) throw this.dbBroken;
    let db;
    try {
      db = await this.database();
    } catch (error) {
      this.dbBroken = wrapStoreError(error);
      throw this.dbBroken;
    }
    try {
      await write(db);
    } catch (error) {
      throw wrapStoreError(error);
    }
  }

  async pushNotes(notes, deleteIds = []) {
    const docs = [];
    const seen = new Set();
    for (const note of notes) {
      if (!note || seen.has(note.docHash)) continue;
      seen.add(note.docHash);
      const doc = this.memory.docs.get(note.docHash);
      if (doc) docs.push(doc);
    }
    for (const id of deleteIds) {
      const cached = this.memory.docs.get(id.docHash || "");
      if (cached && !seen.has(cached.docHash)) {
        docs.push(cached);
        seen.add(cached.docHash);
      }
    }
    await this.mirror((db) => writeSnapshot(db, {
      notes,
      docs,
      meta: this.memory.metaRows(),
      deleteIds: deleteIds.map((item) => item.id || item)
    }));
  }

  subscribe(cb) {
    return this.memory.subscribe(cb);
  }

  async get(id) {
    return this.run(async () => {
      await this.hydrate();
      return this.memory.get(id);
    });
  }

  async list(docHash, options) {
    return this.run(async () => {
      await this.hydrate();
      return this.memory.list(docHash, options);
    });
  }

  async listTrash(docHash) {
    return this.run(async () => {
      await this.hydrate();
      return this.memory.listTrash(docHash);
    });
  }

  async changes(sinceRev) {
    return this.run(async () => {
      await this.hydrate();
      return this.memory.changes(sinceRev);
    });
  }

  async put(input) {
    return this.run(async () => {
      await this.hydrate();
      await this.openMissingDisk();
      await this.ensurePersist();
      const saved = await this.memory.put(input);
      await this.pushNotes([saved]);
      return this.memory.get(saved.id);
    });
  }

  async bulkPut(notes) {
    return this.run(async () => {
      await this.hydrate();
      await this.openMissingDisk();
      await this.ensurePersist();
      const saved = [];
      for (const note of notes || []) saved.push(await this.memory.put(note));
      await this.pushNotes(saved);
      return saved;
    });
  }

  async softDelete(id) {
    return this.run(async () => {
      await this.hydrate();
      const saved = await this.memory.softDelete(id);
      await this.openMissingDisk();
      await this.ensurePersist();
      await this.pushNotes([saved]);
      return saved;
    });
  }

  async restore(id) {
    return this.run(async () => {
      await this.hydrate();
      const saved = await this.memory.restore(id);
      await this.openMissingDisk();
      await this.ensurePersist();
      await this.pushNotes([saved]);
      return saved;
    });
  }

  async purge(id) {
    return this.run(async () => {
      await this.hydrate();
      const existing = await this.memory.get(id);
      if (!existing) return null;
      const saved = await this.memory.purge(id);
      await this.openMissingDisk();
      await this.ensurePersist();
      try {
        await this.mirror((db) => writeSnapshot(db, {
          docs: this.memory.docs.get(saved.docHash) ? [this.memory.docs.get(saved.docHash)] : [],
          meta: this.memory.metaRows(),
          deleteIds: [saved.id]
        }));
      } catch (error) {
        this.memory.keep(saved);
        throw error;
      }
      return saved;
    });
  }

  async exportDoc(docHash, options) {
    return this.run(async () => {
      await this.hydrate();
      const bundle = await this.memory.exportDoc(docHash, options);
      if (!this.diskMissing) {
        try {
          await this.mirror((db) => writeSnapshot(db, { meta: this.memory.metaRows() }));
        } catch {
          /* the file itself is the backup */
        }
      }
      return bundle;
    });
  }

  async exportAll(options) {
    return this.run(async () => {
      await this.hydrate();
      const bundle = await this.memory.exportAll(options);
      if (!this.diskMissing) {
        try {
          await this.mirror((db) => writeSnapshot(db, { meta: this.memory.metaRows() }));
        } catch {
          /* the file itself is the backup */
        }
      }
      return bundle;
    });
  }

  async import(bundle, options) {
    return this.run(async () => {
      await this.hydrate();
      const result = await this.memory.import(bundle, options);
      await this.openMissingDisk();
      await this.ensurePersist();
      const notes = [...this.memory.notes.values()];
      await this.pushNotes(notes);
      return result;
    });
  }
}

export function createNotesStore(options = {}) {
  if (options.memory === true || options.openDatabase || !indexedDbAvailable()) {
    if (options.openDatabase) return new IdbNotesStore(options);
    return new MemoryNotesStore(options);
  }
  return new IdbNotesStore(options);
}
