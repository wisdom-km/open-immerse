/**
 * Notes storage.
 *
 * Opens the notes collection in IndexedDB `oi-annotations` at version 1.
 * createLibraryStore() may raise that same database to version 2. This file
 * still requests version 1, and reopens without a version when the database
 * is already newer, so a rollback can keep reading and writing notes.
 * Callers stay on createNotesStore(). The indexedDB.open call lives in
 * lib/platform/idb-open.js.
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
import { onStorageAvailable, openIndexedDatabase, storageOpenInflight, storageOpenIsBlocked } from "./platform/idb-open.js";

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
  if (name === "BlockedError") {
    return new NotesStoreError("blocked", error.message || "数据库正被其他页面占用，这次没有打开。", { cause: error });
  }
  if (name === "QuotaExceededError") {
    return new NotesStoreError("quota", "笔记存储空间不够。可以先导出 JSON 备份。", { cause: error });
  }
  if (name === "InvalidStateError" || name === "UnknownError" || name === "SecurityError") {
    return new NotesStoreError("private", "当前环境写不了笔记库，笔记还留在这次打开的内存里。", { cause: error });
  }
  return new NotesStoreError("write", "笔记没有写入磁盘，这次打开的内存里还有。", { cause: error });
}

/**
 * True only when a previous write recorded an explicit refusal.
 * A missing key means persist() has not been requested yet.
 * Opening the panel must not call persist(); pass the in-memory record
 * from this session, or the chrome.storage.local value on a later open.
 */
export function recordedPersistDenied(record, stored) {
  const source = record && Object.prototype.hasOwnProperty.call(record, "notesPersistGranted")
    ? record.notesPersistGranted
    : stored;
  return source === false;
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

/** Connections already closed so a newer version of oi-annotations can finish opening. */
const versionChangeClosed = new WeakSet();

function closeNotesConnection(db) {
  if (!db || typeof db !== "object") return;
  versionChangeClosed.add(db);
  if (typeof db.close !== "function") return;
  try {
    db.close();
  } catch {
    /* already closed */
  }
}

/**
 * Another tab is upgrading oi-annotations. Close this connection so that
 * upgrade is not stuck on `blocked`, and tell the store to drop the handle.
 * The next read or write opens the database again.
 * Reason: a connection left open at the old version blocks the upgrade, then
 * fails the next transaction with InvalidStateError.
 */
/**
 * A version change already closed this connection. Opening again in the same
 * turn grabs v1 before the upgrade commits and blocks it, so a fresh
 * migration never finishes and the chip stays on 暂时存不了 after the holder
 * lets go. Wait until that open releases, then open.
 */
function notesUpgradeBusy() {
  return storageOpenIsBlocked(NOTES_DB_NAME) || storageOpenInflight(NOTES_DB_NAME);
}

function waitForNotesUpgrade() {
  // versionchange fires before the upgrade commits. Opening v1 again in
  // that window is a new holder, and a fresh migration never finishes.
  if (!notesUpgradeBusy()) {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      if (notesUpgradeBusy()) return;
      settled = true;
      stop();
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    const stop = onStorageAvailable(() => finish());
    const poll = setInterval(finish, 20);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      clearInterval(poll);
      resolve();
    }, 15000);
  });
}

function armNotesVersionChange(db, onClosed) {
  if (!db || typeof db !== "object") return;
  const previous = db.onversionchange;
  db.onversionchange = (event) => {
    if (typeof previous === "function") {
      try {
        previous.call(db, event);
      } catch {
        /* a listener must not keep this connection open */
      }
    }
    closeNotesConnection(db);
    if (typeof onClosed === "function") onClosed(db);
  };
}

/**
 * Open oi-annotations at NOTES_DB_VERSION.
 * This notes path does not create the v2 stores and does not raise the version.
 * If the database is already newer, openIndexedDatabase reopens it at that
 * version and this store keeps using only notes, docs, and meta.
 */
function openNotesDatabase() {
  return openIndexedDatabase({
    name: NOTES_DB_NAME,
    version: NOTES_DB_VERSION,
    onUpgrade: (db, oldVersion) => upgradeNotesDatabase(db, oldVersion)
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

  /**
   * Replace one document's in-memory notes with the rows just read from disk.
   * A note written in another tab is already committed there. This tab's
   * listeners see the new list. Nothing here writes IndexedDB again.
   */
  replaceDocNotes(docHash, notes) {
    const hash = String(docHash || "");
    for (const [id, note] of [...this.notes]) {
      if (hash && note?.docHash === hash) this.notes.delete(id);
    }
    for (const note of notes || []) {
      if (!note?.id) continue;
      if (hash && note.docHash !== hash) continue;
      this.notes.set(note.id, clone(note));
    }
    if (hash) this.touchDoc(hash);
    this.notify({ type: "remote", docHash: hash });
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
    // Interrupt point: the id is already taken. A different docHash must not
    // move the stored note. Same-doc edits omit docHash or repeat it.
    const incomingDoc = input.docHash == null ? "" : String(input.docHash);
    if (existing && incomingDoc && incomingDoc !== existing.docHash) {
      throw new NotesStoreError("doc", "这条笔记属于另一篇文档。");
    }
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

  async put(input, options = {}) {
    if (options.persist !== false) await this.ensurePersist();
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
      rejected: planned.rejected,
      byDoc: planned.byDoc || []
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

/**
 * The notes store most recently registered for the shared database.
 * A library in the same tab uses this when the caller does not pass one,
 * so an import or a trash deletion updates the copy the panel already holds.
 * This does not require the connection to be open. A v2 upgrade closes it,
 * and the store's own list, import, and softDelete open it again.
 * A broken store is skipped. capture:false is a private store the library
 * owns and is not registered.
 */
let latestNotesStore = null;

export function currentNotesStore() {
  const store = latestNotesStore;
  if (!store || store.dbBroken || store.options?.openDatabase) return null;
  return store;
}

export class IdbNotesStore {
  constructor(options = {}) {
    this.options = options;
    this.memory = new MemoryNotesStore({ ...options, persist: false, settings: null });
    this.queue = Promise.resolve();
    this.dbPromise = null;
    this.needsUpgradeWait = false;
    this.currentDb = null;
    this.hydrated = false;
    this.diskMissing = false;
    this.dbBroken = null;
    this.persisted = false;
    this.persisting = null;
    if (options.capture !== false && !options.openDatabase) latestNotesStore = this;
  }

  run(task) {
    const next = this.queue.then(task, task);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  openConnection() {
    const open = this.options.openDatabase || openNotesDatabase;
    const pending = Promise.resolve().then(async () => {
      const db = await open();
      if (!db || versionChangeClosed.has(db)) return null;
      this.currentDb = db;
      armNotesVersionChange(db, () => {
        if (this.currentDb !== db) return;
        this.currentDb = null;
        if (this.dbPromise === pending) this.dbPromise = null;
        // The next open has to wait. Opening v1 in this turn blocks the upgrade.
        this.needsUpgradeWait = true;
        // The database is not broken. The next read or write opens it again.
        this.dbBroken = null;
      });
      return db;
    }).catch((error) => {
      if (this.dbPromise === pending) this.dbPromise = null;
      throw error;
    });
    return pending;
  }

  connectDatabase() {
    // A store that never held this database still fails fast when an upgrade
    // is blocked. Only the connection versionchange just closed has to wait,
    // or its next open(v1) lands while that upgrade is still committing.
    if (!this.needsUpgradeWait) return this.openConnection();
    let ticket;
    ticket = (async () => {
      await waitForNotesUpgrade();
      this.needsUpgradeWait = false;
      if (this.dbPromise !== ticket) return this.dbPromise;
      const opened = this.openConnection();
      this.dbPromise = opened;
      return opened;
    })();
    return ticket;
  }

  async database() {
    if (this.dbBroken) throw this.dbBroken;
    if (!this.dbPromise) this.dbPromise = this.connectDatabase();
    const db = await this.dbPromise;
    if (db) return db;
    // The connection closed for a version change before this call could use it.
    // Do not open v1 again until the upgrade that closed it has released.
    this.currentDb = null;
    this.dbBroken = null;
    this.dbPromise = null;
    this.needsUpgradeWait = true;
    this.dbPromise = this.connectDatabase();
    const retried = await this.dbPromise;
    if (retried) return retried;
    this.dbPromise = null;
    const error = new Error("indexedDB connection closed");
    error.name = "InvalidStateError";
    throw error;
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

  /**
   * Pull one document's notes from IndexedDB into this tab's memory.
   * loadFromDisk only fills an empty memory, so a tab that already listed
   * notes would otherwise keep its old snapshot.
   */
  async refreshDoc(docHash) {
    const hash = String(docHash || "");
    if (!hash) return;
    return this.run(async () => {
      if (!(await this.databaseExists())) return;
      const db = await this.database();
      const notes = await readAll(db, "notes");
      this.memory.replaceDocNotes(hash, notes.filter((note) => note?.docHash === hash));
      this.hydrated = true;
      this.diskMissing = false;
    });
  }

  async loadFromDisk() {
    if (this.dbBroken) return;
    let db = null;
    try {
      db = await this.database();
    } catch (error) {
      // A blocked upgrade is still sitting in IndexedDB. Do not remember it
      // as a broken database and do not pretend the disk was empty: the next
      // read tries again. list() on an already hydrated store does not open.
      if (error?.name === "BlockedError" || error?.type === "blocked") throw wrapStoreError(error);
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
      // A version change closed this connection mid-read. Do not stick
      // dbBroken: the next read opens the database again.
      if (db && versionChangeClosed.has(db)) {
        if (this.currentDb === db) this.currentDb = null;
        this.dbPromise = null;
        this.dbBroken = null;
        this.hydrated = false;
        throw wrapStoreError(error);
      }
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

  async put(input, options = {}) {
    return this.run(async () => {
      await this.hydrate();
      await this.openMissingDisk();
      if (options.persist !== false) await this.ensurePersist();
      const saved = await this.memory.put(input, { persist: false });
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
