/**
 * In-memory StorageBackend and BlobStore.
 *
 * The same methods run against IndexedDB in the extension and, later, SQLite
 * on the desktop. Nothing here is an IndexedDB type.
 */

import {
  assertPlainQuery,
  canonicalKey,
  clone,
  compareKeys,
  inRange,
  keyMissing,
  valueAt
} from "./record-key.js";

function missingStore(name) {
  const error = new Error(`missing store ${name}`);
  error.name = "NotFoundError";
  throw error;
}

export function createMemoryBackend(schema, options = {}) {
  const tables = new Map();
  const seqs = new Map();
  for (const name of Object.keys(schema?.stores || {})) {
    tables.set(name, new Map());
    seqs.set(name, 0);
  }

  function table(name) {
    const rows = tables.get(name);
    if (!rows) missingStore(name);
    return rows;
  }

  function storeKey(spec, record) {
    const key = valueAt(record, spec.keyPath);
    if (!keyMissing(key)) return key;
    return undefined;
  }

  function rowsOf(draft, name) {
    return draft ? draft.get(name) : table(name);
  }

  function session(draft, mode, seqDraft) {
    const writable = mode === "readwrite";
    return {
      async get(collection, key) {
        const row = rowsOf(draft, collection).get(canonicalKey(key));
        return row ? clone(row) : null;
      },
      async getAll(collection, query) {
        return collect(rowsOf(draft, collection), schema.stores[collection], query);
      },
      async put(collection, record) {
        if (!writable) {
          const error = new Error("readonly");
          error.name = "ReadOnlyError";
          throw error;
        }
        const spec = schema.stores[collection];
        if (!spec) missingStore(collection);
        const copy = clone(record);
        let key = storeKey(spec, copy);
        if (keyMissing(key)) {
          if (!spec.autoIncrement) {
            const error = new Error(`missing key for ${collection}`);
            error.name = "DataError";
            throw error;
          }
          const next = (seqDraft.get(collection) || 0) + 1;
          seqDraft.set(collection, next);
          const keyName = spec.keyPath;
          copy[keyName] = next;
          key = next;
        }
        rowsOf(draft, collection).set(canonicalKey(key), copy);
        return key;
      },
      async delete(collection, key) {
        if (!writable) {
          const error = new Error("readonly");
          error.name = "ReadOnlyError";
          throw error;
        }
        rowsOf(draft, collection).delete(canonicalKey(key));
      }
    };
  }

  function collect(rows, spec, rawQuery) {
    const query = assertPlainQuery(rawQuery);
    const indexPath = query.index ? spec?.indexes?.[query.index]?.keyPath : spec?.keyPath;
    if (query.index && !indexPath) {
      const error = new Error(`missing index ${query.index}`);
      error.name = "NotFoundError";
      throw error;
    }
    const matched = [];
    for (const record of rows.values()) {
      const key = valueAt(record, indexPath);
      if (query.index && keyMissing(key)) continue;
      if (!inRange(key, query)) continue;
      matched.push({ key, record });
    }
    matched.sort((a, b) => compareKeys(a.key, b.key));
    if (query.direction === "prev") matched.reverse();
    const limited = query.limit > 0 ? matched.slice(0, query.limit) : matched;
    return limited.map((item) => clone(item.record));
  }

  return {
    kind: "memory",
    version: Number(schema?.version) || 0,
    closed: false,
    async get(collection, key) {
      return session(null, "readonly", seqs).get(collection, key);
    },
    async getAll(collection, query) {
      return session(null, "readonly", seqs).getAll(collection, query);
    },
    async put(collection, record) {
      return this.tx([collection], "readwrite", (work) => work.put(collection, record));
    },
    async delete(collection, key) {
      return this.tx([collection], "readwrite", (work) => work.delete(collection, key));
    },
    async tx(collections, mode, fn) {
      const names = [].concat(collections || []);
      const draft = new Map();
      const seqDraft = new Map(seqs);
      for (const name of names) draft.set(name, new Map(table(name)));
      try {
        const result = await fn(session(draft, mode === "readonly" ? "readonly" : "readwrite", seqDraft));
        if (mode !== "readonly") {
          for (const [name, rows] of draft) tables.set(name, rows);
          for (const [name, value] of seqDraft) seqs.set(name, value);
        }
        return result;
      } catch (error) {
        throw error;
      }
    },
    async estimate() {
      let usage = 0;
      for (const rows of tables.values()) {
        for (const record of rows.values()) usage += JSON.stringify(record).length;
      }
      return { quota: null, usage };
    },
    async requestPersist() {
      if (typeof options.persist === "function") return (await options.persist()) === true;
      return true;
    },
    async persisted() {
      return this.requestPersist();
    },
    close() {
      this.closed = true;
    }
  };
}

export function createMemoryBlobStore() {
  const files = new Map();
  return {
    async put(key, blob) {
      const bytes = await bytesOf(blob);
      files.set(String(key), { bytes, size: bytes.byteLength });
    },
    async get(key) {
      const row = files.get(String(key));
      if (!row) return null;
      return new Blob([row.bytes]);
    },
    async delete(key) {
      files.delete(String(key));
    },
    async usage() {
      let total = 0;
      for (const row of files.values()) total += row.size;
      return total;
    }
  };
}

async function bytesOf(blob) {
  if (blob instanceof Uint8Array) return blob.slice();
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob);
  if (ArrayBuffer.isView(blob)) {
    return new Uint8Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  }
  if (blob && typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  const error = new Error("blob required");
  error.name = "DataError";
  throw error;
}

export function createMemoryLibraryFactory(options = {}) {
  const databases = new Map();

  function entry(name, schema, upgrade) {
    const existing = databases.get(name);
    if (existing) return existing;
    if (upgrade === false) {
      const error = new Error("database missing");
      error.name = "NotFoundError";
      throw error;
    }
    const created = {
      backend: createMemoryBackend(schema, options),
      blobs: createMemoryBlobStore()
    };
    databases.set(name, created);
    return created;
  }

  return {
    kind: "memory",
    exists(name) {
      return databases.has(name);
    },
    async open(name, schema, openOptions = {}) {
      return entry(name, schema, openOptions.upgrade).backend;
    },
    async blobs(name, schema, openOptions = {}) {
      return entry(name, schema, openOptions.upgrade).blobs;
    },
    async close(name) {
      const existing = databases.get(name);
      if (!existing) return;
      existing.backend.close();
      databases.delete(name);
    },
    reset() {
      databases.clear();
    }
  };
}
