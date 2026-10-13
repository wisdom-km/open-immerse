/**
 * Stand-in for a future SQLite backend.
 *
 * Rows live in tables. Original PDF bytes live in a separate file map, not in
 * the sources table. There is no IndexedDB type and no requestPersist: the
 * desktop app does not ask the browser to persist storage. The contract test
 * runs this double beside the IndexedDB backend.
 */

import {
  assertPlainQuery,
  canonicalKey,
  clone,
  compareKeys,
  inRange,
  keyMissing,
  valueAt
} from "../lib/platform/record-key.js";

function missingStore(name) {
  const error = new Error(`missing store ${name}`);
  error.name = "NotFoundError";
  throw error;
}

export function createSqliteLikeBackend(schema) {
  const tables = new Map();
  const sequences = new Map();
  for (const name of Object.keys(schema?.stores || {})) {
    tables.set(name, new Map());
    sequences.set(name, 0);
  }

  function rows(name) {
    const table = tables.get(name);
    if (!table) missingStore(name);
    return table;
  }

  function select(table, spec, rawQuery) {
    const query = assertPlainQuery(rawQuery);
    const path = query.index ? spec?.indexes?.[query.index]?.keyPath : spec?.keyPath;
    if (query.index && !path) {
      const error = new Error(`missing index ${query.index}`);
      error.name = "NotFoundError";
      throw error;
    }
    const matched = [];
    for (const record of table.values()) {
      const key = valueAt(record, path);
      if (query.index && keyMissing(key)) continue;
      if (!inRange(key, query)) continue;
      matched.push({ key, record });
    }
    matched.sort((left, right) => compareKeys(left.key, right.key));
    if (query.direction === "prev") matched.reverse();
    const limited = query.limit > 0 ? matched.slice(0, query.limit) : matched;
    return limited.map((item) => clone(item.record));
  }

  function session(drafts, sequencesDraft, mode) {
    const writable = mode === "readwrite";
    return {
      async get(collection, key) {
        const record = drafts.get(collection).get(canonicalKey(key));
        return record ? clone(record) : null;
      },
      async getAll(collection, query) {
        return select(drafts.get(collection), schema.stores[collection], query);
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
        let key = valueAt(copy, spec.keyPath);
        if (keyMissing(key)) {
          if (!spec.autoIncrement || typeof spec.keyPath !== "string") {
            const error = new Error(`missing key for ${collection}`);
            error.name = "DataError";
            throw error;
          }
          const next = (sequencesDraft.get(collection) || 0) + 1;
          sequencesDraft.set(collection, next);
          copy[spec.keyPath] = next;
          key = next;
        }
        drafts.get(collection).set(canonicalKey(key), copy);
        return key;
      },
      async delete(collection, key) {
        if (!writable) {
          const error = new Error("readonly");
          error.name = "ReadOnlyError";
          throw error;
        }
        drafts.get(collection).delete(canonicalKey(key));
      }
    };
  }

  async function transaction(collections, mode, fn) {
    const drafts = new Map();
    const sequencesDraft = new Map(sequences);
    for (const name of [].concat(collections || [])) {
      drafts.set(name, new Map(rows(name)));
    }
    const result = await fn(session(drafts, sequencesDraft, mode === "readonly" ? "readonly" : "readwrite"));
    if (mode !== "readonly") {
      for (const [name, table] of drafts) tables.set(name, table);
      for (const [name, value] of sequencesDraft) sequences.set(name, value);
    }
    return result;
  }

  return {
    kind: "sqlite",
    version: Number(schema?.version) || 0,
    closed: false,
    get: (collection, key) => transaction([collection], "readonly", (work) => work.get(collection, key)),
    getAll: (collection, query) => transaction([collection], "readonly", (work) => work.getAll(collection, query)),
    put: (collection, record) => transaction([collection], "readwrite", (work) => work.put(collection, record)),
    delete: (collection, key) => transaction([collection], "readwrite", (work) => work.delete(collection, key)),
    tx: transaction,
    async estimate() {
      let usage = 0;
      for (const table of tables.values()) {
        for (const record of table.values()) usage += JSON.stringify(record).length;
      }
      return { quota: null, usage };
    },
    close() {
      this.closed = true;
    }
  };
}

export function createSqliteLikeBlobStore() {
  const files = new Map();
  return {
    async put(key, blob) {
      const bytes = blob instanceof Uint8Array
        ? blob.slice()
        : new Uint8Array(await blob.arrayBuffer());
      files.set(String(key), bytes);
    },
    async get(key) {
      const bytes = files.get(String(key));
      return bytes ? new Blob([bytes]) : null;
    },
    async delete(key) {
      files.delete(String(key));
    },
    async usage() {
      let total = 0;
      for (const bytes of files.values()) total += bytes.byteLength;
      return total;
    }
  };
}

export function createSqliteLikeFactory() {
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
      backend: createSqliteLikeBackend(schema),
      blobs: createSqliteLikeBlobStore()
    };
    databases.set(name, created);
    return created;
  }

  return {
    kind: "sqlite",
    exists(name) {
      return databases.has(name);
    },
    async open(name, schema, options = {}) {
      return entry(name, schema, options.upgrade).backend;
    },
    async blobs(name, schema, options = {}) {
      return entry(name, schema, options.upgrade).blobs;
    },
    async close(name) {
      const existing = databases.get(name);
      if (!existing) return;
      existing.backend.close();
      databases.delete(name);
    }
  };
}
