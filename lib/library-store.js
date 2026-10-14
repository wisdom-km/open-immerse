/**
 * Literature library on top of StorageBackend.
 *
 * The extension opens IndexedDB oi-annotations at version 2. The desktop app
 * will open SQLite through the same methods. This file does not open the
 * database itself and does not talk to the reader. The old local library
 * service is read by pdf-library.js; this store only receives the records.
 * PDF bytes go through BlobStore, not through paper records.
 *
 * The database is not created until the first library write. A read while
 * oi-annotations is still missing, or still at the notes-only version, does
 * not upgrade it.
 *
 * Note writes go through the notes store. Each call resolves options.notes or
 * currentNotesStore() again. That store stays registered after a version
 * upgrade closes its connection, and its own API opens the database again.
 * Deleting a paper's notes sends them to that store's recycle bin.
 */

import {
  NOTE_SCHEMA,
  NOTES_FORMAT,
  currentAppVersion
} from "./notes-io.js";
import { NOTES_DB_NAME, createNotesStore, currentNotesStore } from "./notes-store.js";
import { getPlatform } from "./platform/index.js";
import { clone } from "./platform/record-key.js";

export const LIBRARY_FORMAT = "open-immerse-library";
export const LIBRARY_SCHEMA = 2;
export const ANNOTATIONS_DB_VERSION = 2;

/**
 * Shown once for the whole profile when the library's persist request is
 * refused. This is not the notes panel key, which is per document:
 * reader.notesPersistHintDismissed.<docId>. Nothing in this PR draws the hint.
 */
export const LIBRARY_PERSIST_HINT_KEY = "library.persistHintDismissed";

export const LIBRARY_SETTINGS_KEYS = Object.freeze({
  persistGranted: "libraryPersistGranted",
  schemaSeen: "librarySchemaSeen",
  backend: "libraryBackend",
  persistHintDismissed: LIBRARY_PERSIST_HINT_KEY
});

const ORIGINS = new Set(["local-service", "native", "import"]);
const SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "api-key",
  "cloudapikey",
  "secret",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "password",
  "authorization",
  "privatekey",
  "private_key",
  "subscriptionkey",
  "subscription_key",
  "x-api-key"
]);

const PAPER_INDEX = {
  byOpened: { keyPath: "lastOpenedAt", unique: false },
  byUpdated: { keyPath: "updatedAt", unique: false },
  byArxiv: { keyPath: "arxiv.key", unique: false }
};

export const ANNOTATIONS_SCHEMA = Object.freeze({
  version: ANNOTATIONS_DB_VERSION,
  // Version 1 stores stay the ones upgradeNotesDatabase already creates.
  preserveNotesUpgrade: true,
  stores: Object.freeze({
    notes: Object.freeze({
      since: 1,
      keyPath: "id",
      indexes: Object.freeze({
        byDoc: { keyPath: "docHash", unique: false },
        byDocPage: { keyPath: ["docHash", "page"], unique: false },
        byUpdated: { keyPath: "updatedAt", unique: false }
      })
    }),
    docs: Object.freeze({ since: 1, keyPath: "docHash" }),
    meta: Object.freeze({ since: 1, keyPath: "key" }),
    papers: Object.freeze({ since: 2, keyPath: "docHash", indexes: Object.freeze(PAPER_INDEX) }),
    pages: Object.freeze({
      since: 2,
      keyPath: ["docHash", "page"],
      indexes: Object.freeze({ byDoc: { keyPath: "docHash", unique: false } })
    }),
    layouts: Object.freeze({
      since: 2,
      keyPath: ["docHash", "page", "mode", "protocol"],
      indexes: Object.freeze({ byDoc: { keyPath: "docHash", unique: false } })
    }),
    groups: Object.freeze({
      since: 2,
      keyPath: ["docHash", "groupId"],
      indexes: Object.freeze({
        byDoc: { keyPath: "docHash", unique: false },
        byStartPage: { keyPath: ["docHash", "startPage"], unique: false }
      })
    }),
    sources: Object.freeze({ since: 2, keyPath: "docHash" }),
    changes: Object.freeze({
      since: 2,
      keyPath: "seq",
      autoIncrement: true,
      indexes: Object.freeze({ byDoc: { keyPath: "docHash", unique: false } })
    })
  })
});

export class LibraryStoreError extends Error {
  constructor(type, message, extra) {
    super(message || String(type || "write"));
    this.name = "LibraryStoreError";
    this.type = type || "write";
    if (extra?.cause) this.cause = extra.cause;
    if (extra?.schema != null) this.schema = extra.schema;
  }
}

export function wrapLibraryError(error) {
  if (error instanceof LibraryStoreError) return error;
  if (error?.name === "NotesStoreError" && error.type) {
    return new LibraryStoreError(error.type, error.message, { cause: error, schema: error.schema });
  }
  const name = String(error?.name || "");
  if (name === "BlockedError") {
    return new LibraryStoreError("blocked", error.message || "这次没能打开本机存储。", { cause: error });
  }
  if (name === "QuotaExceededError") {
    return new LibraryStoreError("quota", "文献库存储空间不够。可以先导出 JSON 备份。", { cause: error });
  }
  if (name === "InvalidStateError" || name === "UnknownError" || name === "SecurityError") {
    return new LibraryStoreError("private", "当前环境写不了文献库。", { cause: error });
  }
  if (name === "DataError" || error instanceof TypeError) {
    return new LibraryStoreError("invalid", "文献库记录格式不对。", { cause: error });
  }
  return new LibraryStoreError("write", "文献库没有写入磁盘。", { cause: error });
}

export function stripSecrets(value) {
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item));
  if (!value || typeof value !== "object") return value;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value;
  if (typeof Uint8Array !== "undefined" && value instanceof Uint8Array) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(String(key).toLowerCase())) continue;
    out[key] = stripSecrets(child);
  }
  return out;
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function assertRecordSchema(record) {
  if (record?.schema == null || record.schema === "") return;
  const declared = Number(record.schema);
  if (!Number.isInteger(declared)) {
    throw new LibraryStoreError("schema", "文献格式版本无法识别。");
  }
  if (declared > LIBRARY_SCHEMA) {
    throw new LibraryStoreError(
      "schema",
      `这份文献来自更新的扩展（格式版本 ${declared}），请先升级扩展后再导入。`,
      { schema: declared }
    );
  }
}

function newerWins(local, incoming) {
  const localRev = finite(local?.rev);
  const incomingRev = finite(incoming?.rev);
  if (incomingRev > localRev) return incoming;
  if (incomingRev < localRev) return local;
  if (finite(incoming?.updatedAt) > finite(local?.updatedAt)) return incoming;
  return local;
}

function copyArxiv(value) {
  if (!plain(value)) return undefined;
  const out = {};
  if (value.id) out.id = String(value.id);
  if (value.version != null && value.version !== "") out.version = String(value.version);
  if (value.key) out.key = String(value.key);
  return Object.keys(out).length ? out : undefined;
}

function copySync(value) {
  if (!plain(value)) return undefined;
  const clean = stripSecrets(clone(value));
  return Object.keys(clean).length ? clean : undefined;
}

function summary(paper) {
  const out = {
    docHash: paper.docHash,
    pageCount: finite(paper.pageCount),
    pagesTranslated: finite(paper.pagesTranslated),
    lastOpenedAt: finite(paper.lastOpenedAt),
    updatedAt: finite(paper.updatedAt),
    rev: finite(paper.rev)
  };
  if (paper.title) out.title = paper.title;
  if (paper.fileName) out.fileName = paper.fileName;
  if (paper.origin) out.origin = paper.origin;
  if (paper.deletedAt) out.deletedAt = paper.deletedAt;
  return out;
}

function schemaTooNew(schema, label) {
  throw new LibraryStoreError(
    "schema",
    `这份${label}来自更新的扩展（格式版本 ${schema}），请先升级扩展后再导入。`,
    { schema }
  );
}

function assertNoteSchemas(notes) {
  for (const note of notes || []) {
    const declared = Number(note?.schema);
    if (Number.isInteger(declared) && declared > NOTE_SCHEMA) schemaTooNew(declared, "笔记");
  }
}

function assertBundle(bundle) {
  if (!plain(bundle)) throw new LibraryStoreError("format", "这不是 Open Immerse 的文献库文件。");
  if (bundle.format === NOTES_FORMAT) {
    const schema = Number(bundle.schema);
    if (Number.isInteger(schema) && schema > NOTE_SCHEMA) schemaTooNew(schema, "笔记");
    for (const doc of Array.isArray(bundle.docs) ? bundle.docs : []) assertNoteSchemas(doc?.notes);
    return;
  }
  if (bundle.format !== LIBRARY_FORMAT) throw new LibraryStoreError("format", "这不是 Open Immerse 的文献库文件。");
  const schema = Number(bundle.schema);
  if (!Number.isInteger(schema)) throw new LibraryStoreError("schema", "文献库文件没有格式版本。");
  if (schema > LIBRARY_SCHEMA) schemaTooNew(schema, "文献库");
  for (const entry of Array.isArray(bundle.papers) ? bundle.papers : []) {
    if (entry?.paper) assertRecordSchema(entry.paper);
    for (const page of entry?.pages || []) assertRecordSchema(page);
    for (const group of entry?.groups || []) assertRecordSchema(group);
    assertNoteSchemas(entry?.notes);
  }
}

async function readAll(backend, collection, query) {
  try {
    return await backend.getAll(collection, query);
  } catch (error) {
    if (error?.name === "NotFoundError") return [];
    throw error;
  }
}

async function readOne(backend, collection, key) {
  try {
    return await backend.get(collection, key);
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

export class LibraryStore {
  constructor(options = {}) {
    this.options = options;
    this.backend = options.backend || null;
    this.blobs = options.blobs || null;
    this.deviceId = options.deviceId ? String(options.deviceId) : defaultId();
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.persisted = false;
    this.persisting = null;
    this.persistRecord = null;
    this.deviceReady = false;
  }

  schema() {
    return this.options.schema || ANNOTATIONS_SCHEMA;
  }

  platform() {
    return this.options.platform || getPlatform();
  }

  run(task) {
    const wrapped = async () => {
      try {
        return await task();
      } catch (error) {
        if (this.backend?.closed || error?.name === "InvalidStateError") {
          try {
            await this.backend?.close?.();
          } catch {
            /* already closed */
          }
          this.backend = null;
          this.blobs = null;
          this.deviceReady = false;
        }
        throw wrapLibraryError(error);
      }
    };
    const next = this.queue.then(wrapped, wrapped);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  subscribe(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  notify(event, source) {
    for (const cb of [...this.listeners]) {
      try {
        cb(event);
      } catch {
        /* a listener must not break the write */
      }
    }
    if (source === "remote") return;
    try {
      this.options.onNotify?.(event);
    } catch {
      /* a broadcast must not break the write */
    }
  }

  async databaseExists() {
    if (this.backend && !this.backend.closed) return true;
    const library = this.platform().library;
    if (!library || typeof library.exists !== "function") return false;
    return (await library.exists(NOTES_DB_NAME)) === true;
  }

  openFor(write) {
    if (this.openFlight) {
      return this.openFlight.then((backend) => this.afterSharedOpen(write, backend));
    }
    const flight = this.openForBody(write);
    const tracked = flight.finally(() => {
      if (this.openFlight === tracked) this.openFlight = null;
    });
    tracked.catch(() => {});
    this.openFlight = tracked;
    return flight;
  }

  async afterSharedOpen(write, backend) {
    if (!write) return backend;
    if (this.backend && !this.backend.closed) {
      const known = Number(this.backend.version);
      const schema = this.schema();
      if (!(known > 0) || known >= schema.version) {
        await this.prepareWrite();
        return this.backend;
      }
    }
    return this.openFor(true);
  }

  async openForBody(write) {
    const schema = this.schema();
    if (this.backend && !this.backend.closed) {
      const known = Number(this.backend.version);
      if (!write || !(known > 0) || known >= schema.version) {
        if (write) await this.prepareWrite();
        return this.backend;
      }
      try {
        await this.backend.close?.();
      } catch {
        /* the next open raises the version */
      }
      this.backend = null;
      this.blobs = null;
    }
    if (!write && !(await this.databaseExists())) return null;
    const library = this.platform().library;
    try {
      const openOptions = {
        upgrade: write === true,
        blockedTimeoutMs: this.options.blockedTimeoutMs
      };
      this.backend = await library.open(NOTES_DB_NAME, schema, openOptions);
      if (typeof library.blobs === "function") {
        this.blobs = await library.blobs(NOTES_DB_NAME, schema, openOptions);
      }
    } catch (error) {
      if (!write && (error?.name === "NotFoundError" || error?.name === "InvalidStateError")) return null;
      throw error;
    }
    if (write) await this.prepareWrite();
    return this.backend;
  }

  async prepareWrite() {
    if (!this.deviceReady) {
      await this.ensureDeviceId();
      this.deviceReady = true;
    }
    await this.ensurePersist();
  }

  async ensureDeviceId() {
    const row = await readOne(this.backend, "meta", "deviceId");
    if (row?.value) {
      this.deviceId = String(row.value);
      return;
    }
    await this.backend.put("meta", { key: "deviceId", value: this.deviceId });
  }

  async ensurePersist() {
    if (this.persisted || this.options.persist === false) return;
    if (!this.persisting) {
      this.persisting = (async () => {
        let granted = false;
        try {
          if (typeof this.options.persist === "function") granted = (await this.options.persist()) === true;
          else if (typeof this.backend?.requestPersist === "function") {
            granted = (await this.backend.requestPersist()) === true;
          }
        } catch {
          granted = false;
        }
        const patch = {
          [LIBRARY_SETTINGS_KEYS.persistGranted]: granted,
          [LIBRARY_SETTINGS_KEYS.schemaSeen]: LIBRARY_SCHEMA,
          [LIBRARY_SETTINGS_KEYS.backend]: this.backend?.kind || "memory"
        };
        await this.recordSettings(patch);
        this.persistRecord = patch;
        this.persisted = true;
      })();
    }
    await this.persisting;
  }

  async recordSettings(patch) {
    try {
      const kv = this.platform().kv;
      if (kv?.set) await kv.set("local", patch);
    } catch {
      /* the library write still stands; export is the backup */
    }
  }

  async requestPersist() {
    return this.run(async () => {
      await this.openFor(true);
      return this.persistRecord?.[LIBRARY_SETTINGS_KEYS.persistGranted] === true;
    });
  }

  buildPaper(existing, docHash, input) {
    assertRecordSchema(input);
    const now = this.now();
    const record = {
      docHash,
      schema: LIBRARY_SCHEMA,
      pageCount: input.pageCount == null ? finite(existing?.pageCount) : Math.max(0, Math.floor(finite(input.pageCount))),
      pagesTranslated: input.pagesTranslated == null
        ? finite(existing?.pagesTranslated)
        : Math.max(0, Math.floor(finite(input.pagesTranslated))),
      lastOpenedAt: now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      rev: existing ? finite(existing.rev) + 1 : 1,
      deviceId: this.deviceId
    };
    const title = input.title != null ? String(input.title) : existing?.title;
    const fileName = input.fileName != null ? String(input.fileName) : existing?.fileName;
    if (title) record.title = title;
    if (fileName) record.fileName = fileName;
    const origin = ORIGINS.has(input.origin) ? input.origin : existing?.origin;
    if (ORIGINS.has(origin)) record.origin = origin;
    const arxiv = input.arxiv === undefined ? copyArxiv(existing?.arxiv) : copyArxiv(input.arxiv);
    if (arxiv) record.arxiv = arxiv;
    if (input.readout != null) record.readout = String(input.readout);
    else if (existing?.readout != null) record.readout = String(existing.readout);
    if (input.qaCount != null) record.qaCount = Math.max(0, Math.floor(finite(input.qaCount)));
    else if (existing?.qaCount != null) record.qaCount = existing.qaCount;
    if (input.importedAt != null) record.importedAt = finite(input.importedAt);
    else if (existing?.importedAt) record.importedAt = existing.importedAt;
    const syncState = input.syncState === undefined ? copySync(existing?.syncState) : copySync(input.syncState);
    if (syncState) record.syncState = syncState;
    if (input.revive !== true && existing?.deletedAt) record.deletedAt = existing.deletedAt;
    return stripSecrets(record);
  }

  buildPage(existing, docHash, page, input) {
    assertRecordSchema(input);
    const now = this.now();
    const pairs = (Array.isArray(input.pairs) ? input.pairs : []).map((pair) => stripSecrets(clone(pair || {})));
    const record = {
      docHash,
      page,
      schema: LIBRARY_SCHEMA,
      pairs,
      rev: existing ? finite(existing.rev) + 1 : 1,
      updatedAt: now,
      deviceId: this.deviceId
    };
    if (input.skipped != null) record.skipped = input.skipped === true;
    else if (existing?.skipped != null) record.skipped = existing.skipped === true;
    if (input.migrated != null) record.migrated = input.migrated === true;
    else if (existing?.migrated != null) record.migrated = existing.migrated === true;
    if (input.layoutVersion != null) record.layoutVersion = String(input.layoutVersion);
    else if (existing?.layoutVersion != null) record.layoutVersion = String(existing.layoutVersion);
    const syncState = input.syncState === undefined ? copySync(existing?.syncState) : copySync(input.syncState);
    if (syncState) record.syncState = syncState;
    return record;
  }

  appendChange(work, { collection, docHash, key, rev, op, record }) {
    const entry = {
      collection,
      docHash: String(docHash || ""),
      key,
      rev: finite(rev),
      op,
      at: this.now(),
      deviceId: this.deviceId
    };
    if (op === "put" && record) entry.record = stripSecrets(clone(record));
    return work.put("changes", entry);
  }

  async listPapers(options = {}) {
    return this.run(async () => {
      const backend = await this.openFor(false);
      if (!backend) return [];
      const sort = options.sort === "updated" ? "byUpdated" : "byOpened";
      let rows = await readAll(backend, "papers", { index: sort, direction: "prev" });
      if (options.includeDeleted !== true) rows = rows.filter((paper) => !paper.deletedAt);
      if (options.limit > 0) rows = rows.slice(0, options.limit);
      return rows.map(summary);
    });
  }

  async getPaper(docHash) {
    return this.run(async () => {
      const backend = await this.openFor(false);
      if (!backend) return null;
      return readOne(backend, "papers", String(docHash || ""));
    });
  }

  async touchPaper(docHash, input = {}) {
    const hash = String(docHash || "");
    if (!hash) throw new LibraryStoreError("invalid", "论文缺少文档。");
    assertRecordSchema(input || {});
    return this.run(async () => {
      const backend = await this.openFor(true);
      let paper;
      await backend.tx(["papers", "changes"], "readwrite", async (work) => {
        const existing = await work.get("papers", hash);
        paper = this.buildPaper(existing, hash, input || {});
        await work.put("papers", paper);
        await this.appendChange(work, {
          collection: "papers",
          docHash: hash,
          key: hash,
          rev: paper.rev,
          op: "put",
          record: paper
        });
      });
      this.notify({ collection: "papers", docHash: hash });
      return clone(paper);
    });
  }

  async getPages(docHash) {
    return this.run(async () => {
      const backend = await this.openFor(false);
      if (!backend) return [];
      const rows = await readAll(backend, "pages", { index: "byDoc", equals: String(docHash || "") });
      return rows.sort((a, b) => finite(a.page) - finite(b.page));
    });
  }

  async getPage(docHash, page) {
    return this.run(async () => {
      const backend = await this.openFor(false);
      if (!backend) return null;
      return readOne(backend, "pages", [String(docHash || ""), Math.floor(finite(page))]);
    });
  }

  async putPage(docHash, page, input = {}) {
    const hash = String(docHash || "");
    const pageNo = Math.floor(finite(page));
    if (!hash || pageNo < 1) throw new LibraryStoreError("invalid", "页记录缺少文档或页码。");
    assertRecordSchema(input || {});
    return this.run(async () => {
      const backend = await this.openFor(true);
      let record;
      await backend.tx(["pages", "changes"], "readwrite", async (work) => {
        const existing = await work.get("pages", [hash, pageNo]);
        let next = input || {};
        if (existing && typeof this.options.mergePairs === "function") {
          const merged = this.options.mergePairs(existing.pairs, next.pairs, next.blocks, next.targetLang);
          if (Array.isArray(merged)) next = { ...next, pairs: merged };
        } else if (existing && next.rev != null && newerWins(existing, next) === existing) {
          next = { ...next, pairs: existing.pairs };
        }
        record = this.buildPage(existing, hash, pageNo, next);
        await work.put("pages", record);
        await this.appendChange(work, {
          collection: "pages",
          docHash: hash,
          key: [hash, pageNo],
          rev: record.rev,
          op: "put",
          record
        });
      });
      this.notify({ collection: "pages", docHash: hash, page: pageNo });
      return clone(record);
    });
  }

  async getLayout(docHash, page, mode, protocol) {
    return this.run(async () => {
      const backend = await this.openFor(false);
      if (!backend) return null;
      return readOne(backend, "layouts", [
        String(docHash || ""),
        Math.floor(finite(page)),
        String(mode || ""),
        String(protocol || "")
      ]);
    });
  }

  async putLayout(record) {
    const docHash = String(record?.docHash || "");
    const page = Math.floor(finite(record?.page));
    const mode = String(record?.mode || "");
    const protocol = String(record?.protocol || "");
    if (!docHash || page < 1 || !mode || !protocol) {
      throw new LibraryStoreError("invalid", "版面缓存缺少主键。");
    }
    return this.run(async () => {
      const backend = await this.openFor(true);
      const stored = {
        docHash,
        page,
        mode,
        protocol,
        layoutRev: record.layoutRev ? String(record.layoutRev) : "",
        layout: stripSecrets(clone(record.layout ?? null)),
        savedAt: this.now()
      };
      await backend.put("layouts", stored);
      this.notify({ collection: "layouts", docHash, page });
      return clone(stored);
    });
  }

  async getGroups(docHash, options = {}) {
    return this.run(async () => {
      const backend = await this.openFor(false);
      if (!backend) return [];
      const hash = String(docHash || "");
      if (options.startPage != null) {
        return readAll(backend, "groups", {
          index: "byStartPage",
          equals: [hash, Math.floor(finite(options.startPage))]
        });
      }
      return readAll(backend, "groups", { index: "byDoc", equals: hash });
    });
  }

  async putGroup(group) {
    const docHash = String(group?.docHash || "");
    const groupId = String(group?.groupId || "");
    if (!docHash || !groupId) throw new LibraryStoreError("invalid", "组缺少文档或组号。");
    assertRecordSchema(group);
    return this.run(async () => {
      const backend = await this.openFor(true);
      let record;
      await backend.tx(["groups", "changes"], "readwrite", async (work) => {
        const existing = await work.get("groups", [docHash, groupId]);
        record = stripSecrets({
          ...clone(group),
          docHash,
          groupId,
          schema: LIBRARY_SCHEMA,
          rev: existing ? finite(existing.rev) + 1 : 1,
          updatedAt: this.now(),
          deviceId: this.deviceId
        });
        await work.put("groups", record);
        await this.appendChange(work, {
          collection: "groups",
          docHash,
          key: [docHash, groupId],
          rev: record.rev,
          op: "put",
          record
        });
      });
      this.notify({ collection: "groups", docHash, page: record.startPage });
      return clone(record);
    });
  }

  async getSource(docHash) {
    return this.run(async () => {
      const backend = await this.openFor(false);
      if (!backend || !this.blobs) return null;
      try {
        return await this.blobs.get(String(docHash || ""));
      } catch (error) {
        if (error?.name === "NotFoundError") return null;
        throw error;
      }
    });
  }

  async putSource(docHash, blob) {
    const hash = String(docHash || "");
    if (!hash || blob == null) throw new LibraryStoreError("invalid", "原文缺少文档或文件。");
    return this.run(async () => {
      const backend = await this.openFor(true);
      if (!this.blobs) throw new LibraryStoreError("write", "当前后端没有原文存储。");
      await this.blobs.put(hash, blob);
      this.notify({ collection: "sources", docHash: hash });
      return backend;
    }).then(() => {});
  }

  async deletePaperData(docHash, options = {}) {
    const hash = String(docHash || "");
    if (!hash) throw new LibraryStoreError("invalid", "论文缺少文档。");
    const translations = options.translations !== false;
    const layouts = options.layouts !== false;
    const notes = options.notes === true;
    return this.run(async () => {
      // Resolve the panel on this call. An earlier write may already have
      // closed its connection; the store stays registered and reopens itself.
      const notesApi = notes ? this.notesWriter() : null;
      const backend = await this.openFor(true);
      const report = { docHash: hash, pages: 0, groups: 0, layouts: 0, notes: 0, sources: 0, arxiv: false, formula: false };
      if (notesApi) report.notes = await this.trashNotes(backend, hash, notesApi);
      const pages = translations ? await readAll(backend, "pages", { index: "byDoc", equals: hash }) : [];
      const groups = translations ? await readAll(backend, "groups", { index: "byDoc", equals: hash }) : [];
      const layoutRows = layouts ? await readAll(backend, "layouts", { index: "byDoc", equals: hash }) : [];
      const paper = await readOne(backend, "papers", hash);
      const names = ["papers", "changes"];
      if (translations) names.push("pages", "groups");
      if (layouts) names.push("layouts");
      await backend.tx(names, "readwrite", async (work) => {
        for (const page of pages) {
          await work.delete("pages", [hash, page.page]);
          await this.appendChange(work, { collection: "pages", docHash: hash, key: [hash, page.page], rev: finite(page.rev), op: "delete" });
          report.pages += 1;
        }
        for (const group of groups) {
          await work.delete("groups", [hash, group.groupId]);
          await this.appendChange(work, { collection: "groups", docHash: hash, key: [hash, group.groupId], rev: finite(group.rev), op: "delete" });
          report.groups += 1;
        }
        for (const layout of layoutRows) {
          await work.delete("layouts", [hash, layout.page, layout.mode, layout.protocol]);
          report.layouts += 1;
        }
        if (paper) {
          const tombstone = {
            ...paper,
            deletedAt: this.now(),
            updatedAt: this.now(),
            rev: finite(paper.rev) + 1,
            deviceId: this.deviceId
          };
          await work.put("papers", tombstone);
          await this.appendChange(work, {
            collection: "papers",
            docHash: hash,
            key: hash,
            rev: tombstone.rev,
            op: "delete",
            record: tombstone
          });
        }
      });
      if (options.arxiv === true && typeof this.options.deleteArxiv === "function") {
        await this.options.deleteArxiv(hash);
        report.arxiv = true;
      }
      if (options.formula === true && typeof this.options.deleteFormula === "function") {
        await this.options.deleteFormula(hash);
        report.formula = true;
      }
      this.notify({ collection: "papers", docHash: hash });
      return report;
    });
  }

  async usage() {
    return this.run(async () => {
      const backend = await this.openFor(false);
      const byDoc = new Map();
      if (!backend) return { quota: null, usage: null, persisted: false, byDoc };
      const estimate = typeof backend.estimate === "function"
        ? await backend.estimate()
        : { quota: null, usage: null };
      let persisted = false;
      if (typeof backend.persisted === "function") persisted = (await backend.persisted()) === true;
      const add = (docHash, record) => {
        if (!docHash) return;
        byDoc.set(docHash, (byDoc.get(docHash) || 0) + JSON.stringify(record).length);
      };
      for (const paper of await readAll(backend, "papers")) add(paper.docHash, paper);
      for (const page of await readAll(backend, "pages")) add(page.docHash, page);
      for (const group of await readAll(backend, "groups")) add(group.docHash, group);
      for (const layout of await readAll(backend, "layouts")) add(layout.docHash, layout);
      return {
        quota: estimate?.quota ?? null,
        usage: estimate?.usage ?? null,
        persisted,
        byDoc
      };
    });
  }

  async changes(sinceSeq = 0, options = {}) {
    return this.run(async () => {
      const since = finite(sinceSeq);
      const backend = await this.openFor(false);
      if (!backend) return { items: [], nextSeq: since };
      const query = { from: since, fromExclusive: true, direction: "next" };
      if (options.limit > 0) query.limit = Math.floor(options.limit);
      const items = await readAll(backend, "changes", query);
      const nextSeq = items.length ? finite(items[items.length - 1].seq) : since;
      return { items, nextSeq };
    });
  }

  async applyRemote(items) {
    return this.run(async () => {
      const backend = await this.openFor(true);
      const report = { applied: 0, skipped: 0, kept: 0 };
      for (const item of items || []) {
        if (!item || item.op === "delete" || !item.record || !item.collection) {
          report.kept += 1;
          continue;
        }
        assertRecordSchema(item.record);
        const local = await readOne(backend, item.collection, item.key);
        if (local && newerWins(local, item.record) === local) {
          report.kept += 1;
          continue;
        }
        if (!local && item.op !== "put") {
          report.skipped += 1;
          continue;
        }
        const record = stripSecrets(clone(item.record));
        await backend.put(item.collection, record);
        report.applied += 1;
        this.notify({
          collection: item.collection,
          docHash: record.docHash || item.docHash || "",
          page: record.page
        });
      }
      return report;
    });
  }

  async exportLibrary(options = {}) {
    return this.run(async () => {
      const include = {
        notes: options.include?.notes !== false,
        trash: options.include?.trash === true,
        layouts: options.include?.layouts === true,
        sources: options.include?.sources === true
      };
      const backend = await this.openFor(false);
      const wanted = Array.isArray(options.docHashes) ? new Set(options.docHashes.map(String)) : null;
      const papers = backend ? await readAll(backend, "papers") : [];
      const pages = backend ? await readAll(backend, "pages") : [];
      const groups = backend ? await readAll(backend, "groups") : [];
      const layouts = include.layouts && backend ? await readAll(backend, "layouts") : [];
      const notes = include.notes && backend ? await readAll(backend, "notes") : [];
      const qaRow = backend ? await readOne(backend, "meta", "qa") : null;
      const migrationRow = backend ? await readOne(backend, "meta", "migration") : null;
      const byHash = new Map();
      const slot = (docHash) => {
        const hash = String(docHash || "");
        if (!hash || (wanted && !wanted.has(hash))) return null;
        if (!byHash.has(hash)) {
          byHash.set(hash, { docHash: hash, pages: [], groups: [], notes: [] });
        }
        return byHash.get(hash);
      };
      for (const paper of papers) {
        const row = slot(paper.docHash);
        if (row) row.paper = stripSecrets(clone(paper));
      }
      for (const page of pages) {
        const row = slot(page.docHash);
        if (row) row.pages.push(stripSecrets(clone(page)));
      }
      for (const group of groups) {
        const row = slot(group.docHash);
        if (row) row.groups.push(stripSecrets(clone(group)));
      }
      for (const note of notes) {
        if (!include.trash && note.deletedAt) continue;
        const row = slot(note.docHash);
        if (row) row.notes.push(stripSecrets(clone(note)));
      }
      if (include.layouts) {
        for (const layout of layouts) {
          const row = slot(layout.docHash);
          if (!row) continue;
          if (!row.layouts) row.layouts = [];
          row.layouts.push(stripSecrets(clone(layout)));
        }
      }
      if (include.sources && this.blobs) {
        for (const hash of byHash.keys()) {
          const blob = await this.blobs.get(hash).catch(() => null);
          if (!blob) continue;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          byHash.get(hash).source = {
            docHash: hash,
            size: bytes.byteLength,
            base64: bytesToBase64(bytes)
          };
        }
      }
      const bundle = {
        format: LIBRARY_FORMAT,
        schema: LIBRARY_SCHEMA,
        exportedAt: options.exportedAt == null ? this.now() : finite(options.exportedAt),
        app: { version: options.appVersion || currentAppVersion() },
        papers: [...byHash.values()].sort((a, b) => a.docHash.localeCompare(b.docHash)).map((row) => {
          const out = {
            paper: row.paper || { docHash: row.docHash, schema: LIBRARY_SCHEMA },
            pages: row.pages.sort((a, b) => a.page - b.page),
            groups: row.groups,
            notes: include.notes ? row.notes : []
          };
          if (include.layouts) out.layouts = row.layouts || [];
          if (include.sources && row.source) out.source = row.source;
          return out;
        }),
        qa: Array.isArray(qaRow?.value) ? stripSecrets(clone(qaRow.value)) : [],
        migration: migrationRow?.value && typeof migrationRow.value === "object"
          ? stripSecrets(clone(migrationRow.value))
          : null
      };
      return stripSecrets(bundle);
    });
  }

  async importBundle(bundle, options = {}) {
    if (options.mode && options.mode !== "merge") {
      throw new LibraryStoreError("invalid", "导入只支持合并，不会删除本地文献。");
    }
    assertBundle(bundle);
    return this.run(async () => {
      const notesApi = this.notesWriter();
      const backend = await this.openFor(true);
      if (bundle.format === NOTES_FORMAT) return this.importNotes(backend, bundle, [], notesApi);
      return this.importLibrary(backend, bundle, notesApi);
    });
  }

  isIdbNotes(store) {
    return typeof store?.pushNotes === "function";
  }

  usesIdb() {
    if (this.backend?.kind) return this.backend.kind === "idb";
    return this.platform().library?.kind === "idb";
  }

  notesWriter() {
    const live = this.options.notes || currentNotesStore();
    if (live && (this.options.notes || this.usesIdb())) return live;
    if (this.usesIdb()) {
      if (!this._idbNotes) {
        this._idbNotes = createNotesStore({
          capture: false,
          persist: false,
          deviceId: this.deviceId,
          now: this.now
        });
      }
      return this._idbNotes;
    }
    if (!this._memoryNotes) {
      this._memoryNotes = createNotesStore({
        memory: true,
        capture: false,
        persist: false,
        deviceId: this.deviceId,
        now: this.now
      });
    }
    return this._memoryNotes;
  }

  async seedMemoryNotes(api, backend) {
    if (this.isIdbNotes(api) || typeof api.loadSnapshot !== "function") return;
    if (typeof api.noteCount === "function" && api.noteCount() > 0) return;
    const qaRow = await readOne(backend, "meta", "qa");
    const deviceRow = await readOne(backend, "meta", "deviceId");
    api.loadSnapshot({
      notes: await readAll(backend, "notes"),
      docs: await readAll(backend, "docs"),
      qa: Array.isArray(qaRow?.value) ? qaRow.value : [],
      deviceId: deviceRow?.value || this.deviceId
    });
  }

  async mirrorMemoryNotes(backend, api) {
    // Memory and the desktop SQLite backend do not share the notes database.
    // Each import or trash rewrites every note and doc. That full copy is a
    // known limitation of this path. IndexedDB writes through the notes store
    // and does not come through here.
    if (this.isIdbNotes(api) || !(api.notes instanceof Map)) return;
    const notes = [...api.notes.values()];
    const docs = [...api.docs.values()];
    await backend.tx(["notes", "docs", "meta"], "readwrite", async (work) => {
      for (const note of notes) await work.put("notes", stripSecrets(clone(note)));
      for (const doc of docs) await work.put("docs", clone(doc));
      await work.put("meta", { key: "qa", value: Array.isArray(api.qa) ? clone(api.qa) : [] });
    });
  }

  async trashNotes(backend, docHash, api) {
    if (!api) api = this.notesWriter();
    await this.seedMemoryNotes(api, backend);
    const rows = await api.list(docHash, { includeDeleted: true });
    let count = 0;
    for (const note of rows) {
      if (note.deletedAt) continue;
      await api.softDelete(note.id);
      count += 1;
    }
    await this.mirrorMemoryNotes(backend, api);
    return count;
  }

  async importLibrary(backend, bundle, notesApi) {
    const result = { added: 0, updated: 0, skipped: 0, rejected: 0, errors: [] };
    const localPapers = await readAll(backend, "papers");
    const localPages = await readAll(backend, "pages");
    const localGroups = await readAll(backend, "groups");
    const localLayouts = await readAll(backend, "layouts");
    const paperMap = new Map(localPapers.map((paper) => [paper.docHash, paper]));
    const pageMap = new Map(localPages.map((page) => [`${page.docHash}\t${page.page}`, page]));
    const groupMap = new Map(localGroups.map((group) => [`${group.docHash}\t${group.groupId}`, group]));
    const layoutMap = new Map(localLayouts.map((layout) => [`${layout.docHash}\t${layout.page}\t${layout.mode}\t${layout.protocol}`, layout]));
    const paperWrites = [];
    const pageWrites = [];
    const groupWrites = [];
    const layoutWrites = [];
    const sourceWrites = [];
    for (const entry of Array.isArray(bundle.papers) ? bundle.papers : []) {
      const paper = entry?.paper;
      const docHash = String(paper?.docHash || entry?.docHash || "");
      if (!docHash) {
        result.rejected += 1;
        result.errors.push("paper missing docHash");
        continue;
      }
      if (paper && Object.keys(paper).length) {
        try {
          assertRecordSchema(paper);
          const clean = stripSecrets({ ...clone(paper), docHash, schema: LIBRARY_SCHEMA });
          const local = paperMap.get(docHash);
          if (!local) {
            result.added += 1;
            paperWrites.push(clean);
            paperMap.set(docHash, clean);
          } else if (newerWins(local, clean) === clean && clean !== local) {
            result.updated += 1;
            paperWrites.push(clean);
            paperMap.set(docHash, clean);
          } else {
            result.skipped += 1;
          }
        } catch (error) {
          if (error instanceof LibraryStoreError && error.type === "schema") throw error;
          result.rejected += 1;
          result.errors.push(error?.message || "paper rejected");
        }
      }
      for (const page of Array.isArray(entry?.pages) ? entry.pages : []) {
        try {
          assertRecordSchema(page);
          const pageNo = Math.floor(finite(page?.page));
          if (pageNo < 1) {
            result.rejected += 1;
            result.errors.push(`${docHash} page rejected`);
            continue;
          }
          const clean = stripSecrets({ ...clone(page), docHash, page: pageNo, schema: LIBRARY_SCHEMA });
          const key = `${docHash}\t${pageNo}`;
          const local = pageMap.get(key);
          if (!local) {
            result.added += 1;
            pageWrites.push(clean);
            pageMap.set(key, clean);
          } else if (newerWins(local, clean) === clean && clean !== local) {
            result.updated += 1;
            pageWrites.push(clean);
            pageMap.set(key, clean);
          } else {
            result.skipped += 1;
          }
        } catch (error) {
          if (error instanceof LibraryStoreError && error.type === "schema") throw error;
          result.rejected += 1;
          result.errors.push(error?.message || "page rejected");
        }
      }
      for (const group of Array.isArray(entry?.groups) ? entry.groups : []) {
        try {
          assertRecordSchema(group);
          const groupId = String(group?.groupId || "");
          if (!groupId) {
            result.rejected += 1;
            result.errors.push(`${docHash} group rejected`);
            continue;
          }
          const clean = stripSecrets({ ...clone(group), docHash, groupId, schema: LIBRARY_SCHEMA });
          const key = `${docHash}\t${groupId}`;
          const local = groupMap.get(key);
          if (!local) {
            result.added += 1;
            groupWrites.push(clean);
          } else if (newerWins(local, clean) === clean && clean !== local) {
            result.updated += 1;
            groupWrites.push(clean);
          } else {
            result.skipped += 1;
          }
        } catch (error) {
          if (error instanceof LibraryStoreError && error.type === "schema") throw error;
          result.rejected += 1;
          result.errors.push(error?.message || "group rejected");
        }
      }
      for (const layout of Array.isArray(entry?.layouts) ? entry.layouts : []) {
        try {
          const page = Math.floor(finite(layout?.page));
          const mode = String(layout?.mode || "");
          const protocol = String(layout?.protocol || "");
          if (page < 1 || !mode || !protocol) {
            result.rejected += 1;
            result.errors.push(`${docHash} layout rejected`);
            continue;
          }
          const clean = stripSecrets({
            docHash,
            page,
            mode,
            protocol,
            layoutRev: layout.layoutRev ? String(layout.layoutRev) : "",
            layout: layout.layout ?? null,
            savedAt: finite(layout.savedAt)
          });
          const key = `${docHash}\t${page}\t${mode}\t${protocol}`;
          const local = layoutMap.get(key);
          if (!local) {
            result.added += 1;
            layoutWrites.push(clean);
            layoutMap.set(key, clean);
          } else if (finite(clean.savedAt) > finite(local.savedAt)) {
            result.updated += 1;
            layoutWrites.push(clean);
            layoutMap.set(key, clean);
          } else {
            result.skipped += 1;
          }
        } catch (error) {
          if (error instanceof LibraryStoreError && error.type === "schema") throw error;
          result.rejected += 1;
          result.errors.push(error?.message || "layout rejected");
        }
      }
      if (entry?.source && typeof entry.source.base64 === "string") {
        try {
          sourceWrites.push({ docHash, bytes: base64ToBytes(entry.source.base64) });
        } catch (error) {
          result.rejected += 1;
          result.errors.push(`${docHash} source rejected`);
        }
      }
    }
    await backend.tx(["papers", "pages", "groups", "layouts", "changes"], "readwrite", async (work) => {
      for (const paper of paperWrites) {
        await work.put("papers", paper);
        await this.appendChange(work, {
          collection: "papers",
          docHash: paper.docHash,
          key: paper.docHash,
          rev: paper.rev,
          op: "put",
          record: paper
        });
      }
      for (const page of pageWrites) {
        await work.put("pages", page);
        await this.appendChange(work, {
          collection: "pages",
          docHash: page.docHash,
          key: [page.docHash, page.page],
          rev: page.rev,
          op: "put",
          record: page
        });
      }
      for (const group of groupWrites) {
        await work.put("groups", group);
        await this.appendChange(work, {
          collection: "groups",
          docHash: group.docHash,
          key: [group.docHash, group.groupId],
          rev: group.rev,
          op: "put",
          record: group
        });
      }
      for (const layout of layoutWrites) await work.put("layouts", layout);
    });
    // The transaction above has committed papers, pages, groups, and layouts.
    // Sources and notes are written after it. A failure here leaves those
    // papers without their files or notes. Import merges, so running it
    // again finishes the rows that did not land.
    for (const source of sourceWrites) {
      if (!this.blobs) {
        result.rejected += 1;
        result.errors.push(`${source.docHash} source rejected`);
        continue;
      }
      const existing = await this.blobs.get(source.docHash).catch(() => null);
      if (existing) {
        result.skipped += 1;
        continue;
      }
      await this.blobs.put(source.docHash, new Blob([source.bytes]));
      result.added += 1;
    }
    const noteResult = await this.importNotes(backend, {
      format: NOTES_FORMAT,
      schema: 1,
      docs: (bundle.papers || []).flatMap((entry) => {
        const notes = Array.isArray(entry?.notes) ? entry.notes : [];
        if (!notes.length) return [];
        return [{
          docHash: entry?.paper?.docHash || entry?.docHash,
          title: entry?.paper?.title || "",
          notes
        }];
      }),
      qa: bundle.qa || []
    }, result.errors, notesApi);
    result.added += noteResult.added;
    result.updated += noteResult.updated;
    result.skipped += noteResult.skipped;
    result.rejected += noteResult.rejected;
    if (bundle.migration && typeof bundle.migration === "object" && !Array.isArray(bundle.migration)) {
      await backend.tx(["meta"], "readwrite", async (work) => {
        const row = await work.get("meta", "migration");
        const local = row?.value && typeof row.value === "object" ? row.value : {};
        const incoming = bundle.migration;
        const done = new Set([
          ...(Array.isArray(local.doneDocs) ? local.doneDocs : []),
          ...(Array.isArray(incoming.doneDocs) ? incoming.doneDocs : [])
        ]);
        await work.put("meta", {
          key: "migration",
          value: {
            ...incoming,
            ...local,
            step: local.step || incoming.step || "",
            errors: Array.isArray(local.errors)
              ? local.errors
              : (Array.isArray(incoming.errors) ? incoming.errors : []),
            doneDocs: [...done]
          }
        });
      });
    }
    this.notify({ collection: "papers", docHash: "" });
    return result;
  }

  async importNotes(backend, bundle, errors, api) {
    if (!api) api = this.notesWriter();
    await this.seedMemoryNotes(api, backend);
    const result = await api.import(stripSecrets(clone(bundle)));
    await this.mirrorMemoryNotes(backend, api);
    return {
      added: result.added,
      updated: result.updated,
      skipped: result.skipped,
      rejected: result.rejected,
      errors: errors || []
    };
  }

  async listLayouts(docHash) {
    return this.run(async () => {
      const backend = await this.openFor(false);
      if (!backend) return [];
      return readAll(backend, "layouts", { index: "byDoc", equals: String(docHash || "") });
    });
  }

  async retryOpen() {
    return this.run(async () => {
      if (this.backend && !this.backend.closed) {
        try {
          await this.backend.close?.();
        } catch {
          /* the next open replaces it */
        }
        this.backend = null;
        this.blobs = null;
      }
      const backend = await this.openFor(true);
      return Boolean(backend);
    });
  }

  async migrationStatus() {
    return this.run(async () => {
      const backend = await this.openFor(false);
      if (!backend) return { step: "", doneDocs: [], pendingKnown: 0, errors: [], finishedAt: null };
      const row = await readOne(backend, "meta", "migration");
      const value = row?.value && typeof row.value === "object" ? row.value : {};
      return {
        step: value.step || "",
        doneDocs: Array.isArray(value.doneDocs) ? value.doneDocs.slice() : [],
        pendingKnown: finite(value.pendingKnown),
        errors: Array.isArray(value.errors) ? value.errors.map((item) => ({ ...item })) : [],
        finishedAt: value.finishedAt ?? null
      };
    });
  }

  async appendMigrationError(backend, entry) {
    const reason = String(entry?.reason || entry?.type || "");
    if (!entry || reason === "blocked") return;
    try {
      await backend.tx(["meta"], "readwrite", async (work) => {
        const row = await work.get("meta", "migration");
        const value = row?.value && typeof row.value === "object"
          ? { ...row.value, errors: Array.isArray(row.value.errors) ? row.value.errors.slice() : [] }
          : { id: "f4", step: "lazy", startedAt: this.now(), doneDocs: [], layoutKeysMoved: 0, errors: [] };
        value.errors.push({
          docHash: String(entry.docHash || ""),
          title: entry.title ? String(entry.title) : "",
          reason,
          at: entry.at == null ? this.now() : finite(entry.at)
        });
        await work.put("meta", { key: "migration", value });
      });
    } catch {
      /* the typed error is still thrown to the caller */
    }
  }

  /**
   * One transaction for a paper that was read from the old library service.
   * A paper row already stored is the done mark. A blocked open is not an
   * error row: the next open tries again. Quota keeps earlier papers.
   */
  async putLegacyDocument(docHash, input = {}) {
    const hash = String(docHash || "");
    if (!hash) throw new LibraryStoreError("invalid", "论文缺少文档。");
    return this.run(async () => {
      let backend;
      try {
        backend = await this.openFor(true);
      } catch (error) {
        throw wrapLibraryError(error);
      }
      const pages = [];
      for (const page of input.pages || []) {
        const pageNo = Math.floor(finite(page?.page));
        if (!(pageNo >= 1) || (page?.pairs != null && !Array.isArray(page.pairs))) {
          await this.appendMigrationError(backend, {
            docHash: hash,
            title: input.paper?.title || "",
            reason: "corrupt",
            at: this.now()
          });
          throw new LibraryStoreError("corrupt", "这篇的旧数据读不出来，已跳过。");
        }
        pages.push({ ...page, page: pageNo });
      }
      try {
        let wrote = false;
        await backend.tx(["papers", "pages", "changes", "meta"], "readwrite", async (work) => {
          const existing = await work.get("papers", hash);
          if (existing && !existing.deletedAt) return;
          const paper = this.buildPaper(existing, hash, {
            ...(input.paper || {}),
            origin: "local-service",
            revive: true
          });
          await work.put("papers", paper);
          await this.appendChange(work, {
            collection: "papers",
            docHash: hash,
            key: hash,
            rev: paper.rev,
            op: "put",
            record: paper
          });
          for (const page of pages) {
            const prior = await work.get("pages", [hash, page.page]);
            let next = page;
            if (prior && typeof this.options.mergePairs === "function") {
              const merged = this.options.mergePairs(prior.pairs, page.pairs, page.blocks, page.targetLang);
              if (Array.isArray(merged)) next = { ...page, pairs: merged };
            } else if (prior && newerWins(prior, page) === prior && page.rev != null) {
              next = { ...page, pairs: prior.pairs };
            }
            const record = this.buildPage(prior, hash, page.page, next);
            await work.put("pages", record);
            await this.appendChange(work, {
              collection: "pages",
              docHash: hash,
              key: [hash, page.page],
              rev: record.rev,
              op: "put",
              record
            });
          }
          const row = await work.get("meta", "migration");
          const value = row?.value && typeof row.value === "object"
            ? { ...row.value, doneDocs: Array.isArray(row.value.doneDocs) ? row.value.doneDocs.slice() : [] }
            : { id: "f4", step: "lazy", startedAt: this.now(), doneDocs: [], layoutKeysMoved: 0, errors: [] };
          if (!value.doneDocs.includes(hash)) value.doneDocs.push(hash);
          value.step = "lazy";
          await work.put("meta", { key: "migration", value });
          wrote = true;
        });
        if (wrote) {
          for (const layout of input.layouts || []) {
            try {
              await backend.put("layouts", layout);
            } catch {
              /* a layout cache can be rebuilt; the translation stays */
            }
          }
        }
        this.notify({ collection: "papers", docHash: hash });
        return wrote;
      } catch (error) {
        const wrapped = wrapLibraryError(error);
        if (wrapped.type !== "blocked") {
          await this.appendMigrationError(backend, {
            docHash: hash,
            title: input.paper?.title || "",
            reason: wrapped.type,
            at: this.now()
          });
        }
        throw wrapped;
      }
    });
  }
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Groups of 3 bytes, small enough that one PDF is not one giant binary string.
const BASE64_GROUP = 24576;

function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const parts = [];
  for (let start = 0; start < view.length; start += BASE64_GROUP) {
    const slice = view.subarray(start, Math.min(start + BASE64_GROUP, view.length));
    let binary = "";
    for (let index = 0; index < slice.length; index += 1) binary += String.fromCharCode(slice[index]);
    parts.push(btoa(binary));
  }
  return parts.join("");
}

function base64ToBytes(text) {
  const clean = String(text || "");
  const step = (BASE64_GROUP / 3) * 4;
  const parts = [];
  let length = 0;
  for (let start = 0; start < clean.length; start += step) {
    const binary = atob(clean.slice(start, start + step));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    parts.push(bytes);
    length += bytes.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function createLibraryStore(options = {}) {
  return new LibraryStore(options);
}
