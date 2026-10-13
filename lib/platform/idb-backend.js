/**
 * IndexedDB StorageBackend. IndexedDB objects stay inside this file.
 *
 * Ranges arrive as plain values and are turned into IDBKeyRange here.
 * versionchange closes the connection so a newer opener is not blocked.
 * requestPersist is optional for backends that have nowhere to ask.
 */

import { upgradeNotesDatabase } from "../notes-store.js";
import { indexedDatabaseExists, openIndexedDatabase } from "./idb-open.js";
import { assertPlainQuery, clone } from "./record-key.js";

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

function plainRange(query) {
  const hasFrom = query.from !== undefined;
  const hasTo = query.to !== undefined;
  if (query.equals !== undefined) return IDBKeyRange.only(query.equals);
  if (hasFrom && hasTo) {
    return IDBKeyRange.bound(query.from, query.to, query.fromExclusive === true, query.toExclusive === true);
  }
  if (hasFrom) return IDBKeyRange.lowerBound(query.from, query.fromExclusive === true);
  if (hasTo) return IDBKeyRange.upperBound(query.to, query.toExclusive === true);
  return null;
}

/**
 * Create missing stores. Version 1 of oi-annotations is still created by
 * upgradeNotesDatabase so the notes, docs, and meta stores stay the ones
 * the notes code already opens. This function only adds later stores.
 */
export function applySchema(db, schema, oldVersion) {
  const from = Number(oldVersion) || 0;
  if (schema?.preserveNotesUpgrade === true && from < 1) upgradeNotesDatabase(db, 0);
  for (const [name, spec] of Object.entries(schema?.stores || {})) {
    const since = spec.since || 1;
    if (since <= from || since > schema.version) continue;
    if (schema?.preserveNotesUpgrade === true && since < 2) continue;
    if (typeof db.objectStoreNames?.contains === "function" && db.objectStoreNames.contains(name)) continue;
    const options = { keyPath: spec.keyPath };
    if (spec.autoIncrement) options.autoIncrement = true;
    const store = db.createObjectStore(name, options);
    for (const [indexName, index] of Object.entries(spec.indexes || {})) {
      store.createIndex(indexName, index.keyPath, { unique: index.unique === true });
    }
  }
}

function readRows(source, query) {
  const range = plainRange(query);
  const direction = query.direction === "prev" ? "prev" : "next";
  const limit = query.limit > 0 ? query.limit : 0;
  return new Promise((resolve, reject) => {
    const rows = [];
    const request = source.openCursor(range, direction);
    request.onerror = () => reject(request.error || new Error("cursor failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || (limit && rows.length >= limit)) {
        resolve(rows);
        return;
      }
      rows.push(clone(cursor.value));
      cursor.continue();
    };
  });
}

function storedBlob(blob) {
  if (typeof Blob !== "undefined" && blob instanceof Blob) {
    return { blob, size: blob.size };
  }
  if (blob instanceof ArrayBuffer) {
    return { blob: new Blob([blob]), size: blob.byteLength };
  }
  if (ArrayBuffer.isView(blob)) {
    return { blob: new Blob([blob]), size: blob.byteLength };
  }
  const error = new Error("blob required");
  error.name = "DataError";
  throw error;
}

export function createIdbLibraryFactory() {
  const connections = new Map();

  async function obtain(name, schema, upgrade, blockedTimeoutMs) {
    const cached = connections.get(name);
    if (cached && !cached.closed) {
      const current = Number(cached.db.version) || 0;
      if (upgrade === false || current >= schema.version) return cached;
      cached.closed = true;
      connections.delete(name);
      try {
        cached.db.close();
      } catch {
        /* already closed */
      }
    }
    const db = await openIndexedDatabase({
      name,
      version: upgrade === false ? null : schema.version,
      blockedTimeoutMs,
      onUpgrade(database, oldVersion) {
        applySchema(database, schema, oldVersion);
      }
    });
    const conn = { db, closed: false };
    const previous = db.onversionchange;
    db.onversionchange = (event) => {
      if (typeof previous === "function") {
        try {
          previous.call(db, event);
        } catch {
          /* a listener must not keep this connection open */
        }
      }
      conn.closed = true;
      if (connections.get(name) === conn) connections.delete(name);
      try {
        db.close();
      } catch {
        /* already closed */
      }
    };
    connections.set(name, conn);
    return conn;
  }

  function backendFor(conn, schema) {
    function live() {
      if (conn.closed) {
        const error = new Error("indexedDB connection closed");
        error.name = "InvalidStateError";
        throw error;
      }
      return conn.db;
    }

    function session(tx) {
      return {
        get(collection, key) {
          return promisify(tx.objectStore(collection).get(key)).then((row) => (row == null ? null : clone(row)));
        },
        getAll(collection, rawQuery) {
          const query = assertPlainQuery(rawQuery);
          const store = tx.objectStore(collection);
          const source = query.index ? store.index(query.index) : store;
          return readRows(source, query);
        },
        put(collection, record) {
          const copy = clone(record);
          const spec = schema?.stores?.[collection];
          if (spec?.autoIncrement && typeof spec.keyPath === "string" && copy?.[spec.keyPath] == null) {
            delete copy[spec.keyPath];
          }
          return promisify(tx.objectStore(collection).put(copy));
        },
        delete(collection, key) {
          return promisify(tx.objectStore(collection).delete(key));
        }
      };
    }

    return {
      kind: "idb",
      get version() {
        return Number(conn.db.version) || 0;
      },
      get closed() {
        return conn.closed;
      },
      async get(collection, key) {
        return this.tx([collection], "readonly", (work) => work.get(collection, key));
      },
      async getAll(collection, query) {
        return this.tx([collection], "readonly", (work) => work.getAll(collection, query));
      },
      async put(collection, record) {
        return this.tx([collection], "readwrite", (work) => work.put(collection, record));
      },
      async delete(collection, key) {
        return this.tx([collection], "readwrite", (work) => work.delete(collection, key));
      },
      /**
       * The tx callback must not await anything outside the backend.
       * IndexedDB commits when the callback waits on any other promise.
       */
      async tx(collections, mode, fn) {
        const db = live();
        const tx = db.transaction([].concat(collections || []), mode === "readonly" ? "readonly" : "readwrite");
        const done = transactionDone(tx);
        done.catch(() => {});
        try {
          const result = await fn(session(tx));
          await done;
          return result;
        } catch (error) {
          try {
            tx.abort();
          } catch {
            /* completed or already aborted */
          }
          throw error;
        }
      },
      async estimate() {
        const storage = globalThis.navigator?.storage;
        if (!storage || typeof storage.estimate !== "function") return { quota: null, usage: null };
        try {
          const result = await storage.estimate();
          return {
            quota: Number.isFinite(result?.quota) ? result.quota : null,
            usage: Number.isFinite(result?.usage) ? result.usage : null
          };
        } catch {
          return { quota: null, usage: null };
        }
      },
      async requestPersist() {
        const storage = globalThis.navigator?.storage;
        if (!storage) return false;
        try {
          if (typeof storage.persist === "function") return (await storage.persist()) === true;
          if (typeof storage.persisted === "function") return (await storage.persisted()) === true;
        } catch {
          return false;
        }
        return false;
      },
      async persisted() {
        const storage = globalThis.navigator?.storage;
        if (!storage || typeof storage.persisted !== "function") return false;
        try {
          return (await storage.persisted()) === true;
        } catch {
          return false;
        }
      },
      close() {
        conn.closed = true;
        if (connections.get(conn.db.name) === conn) connections.delete(conn.db.name);
        try {
          conn.db.close();
        } catch {
          /* already closed */
        }
      }
    };
  }

  function blobStoreFor(conn, schema) {
    const backend = backendFor(conn, schema);
    return {
      async put(key, blob) {
        const stored = storedBlob(blob);
        await backend.put("sources", {
          docHash: String(key),
          size: stored.size,
          savedAt: Date.now(),
          blob: stored.blob
        });
      },
      async get(key) {
        const row = await backend.get("sources", String(key));
        const blob = row?.blob;
        if (!blob) return null;
        if (typeof Blob !== "undefined" && blob instanceof Blob) return blob;
        if (blob instanceof ArrayBuffer) return new Blob([blob]);
        if (ArrayBuffer.isView(blob)) return new Blob([blob]);
        return null;
      },
      async delete(key) {
        await backend.delete("sources", String(key));
      },
      async usage() {
        const rows = await backend.getAll("sources");
        return rows.reduce((total, row) => total + (Number(row?.size) || 0), 0);
      }
    };
  }

  return {
    kind: "idb",
    exists(name) {
      return indexedDatabaseExists(name);
    },
    async open(name, schema, openOptions = {}) {
      const conn = await obtain(name, schema, openOptions.upgrade, openOptions.blockedTimeoutMs);
      return backendFor(conn, schema);
    },
    async blobs(name, schema, openOptions = {}) {
      const conn = await obtain(name, schema, openOptions.upgrade, openOptions.blockedTimeoutMs);
      return blobStoreFor(conn, schema);
    },
    async close(name) {
      const conn = connections.get(name);
      if (!conn) return;
      conn.closed = true;
      connections.delete(name);
      try {
        conn.db.close();
      } catch {
        /* already closed */
      }
    }
  };
}
