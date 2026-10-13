/**
 * IndexedDB oi-formula. Opened only when a multimodal or OCR result is stored.
 * A read, a clear, or a crop/self record does not create the database.
 */

import {
  FORMULA_BYTE_LIMIT,
  FORMULA_DB,
  FORMULA_DOC_LIMIT,
  evictionKeys,
  isCacheableFormulaRecord,
  stripFormulaImageUrl
} from "../lib/formula-cache.js";

export { FORMULA_DB };

const DB_VERSION = 1;
const STORE_NAMES = ["tierResults", "decisions"];

function factoryOf(explicit) {
  const factory = explicit || globalThis.indexedDB;
  if (!factory || typeof factory.open !== "function") return null;
  return factory;
}

async function databaseExists(factory, name) {
  if (!factory || typeof factory.databases !== "function") return false;
  try {
    const rows = await factory.databases();
    return (rows || []).some((row) => row && row.name === name);
  } catch {
    return false;
  }
}

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(FORMULA_DB, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("tierResults")) {
        db.createObjectStore("tierResults").createIndex("docHash", "docHash", { unique: false });
      }
      if (!db.objectStoreNames.contains("decisions")) {
        db.createObjectStore("decisions").createIndex("docHash", "docHash", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexedDB open failed"));
  });
}

function requestOf(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = fn(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || tx.error || new Error("indexedDB request failed"));
  });
}

function prepareRecord(key, record) {
  const next = { ...record, key: record?.key || key };
  if (next.result) next.result = stripFormulaImageUrl(next.result);
  next.bytes = JSON.stringify({ ...next, bytes: 0 }).length;
  return next;
}

export function createIdbFormulaStore({
  indexedDB: explicit,
  docLimit = FORMULA_DOC_LIMIT,
  byteLimit = FORMULA_BYTE_LIMIT
} = {}) {
  const factory = () => factoryOf(explicit);

  async function openExisting() {
    const idb = factory();
    if (!idb || !(await databaseExists(idb, FORMULA_DB))) return null;
    return openDatabase(idb);
  }

  async function openCreating() {
    const idb = factory();
    if (!idb) {
      const error = new Error("indexedDB missing");
      error.reason = "indexedDB missing";
      throw error;
    }
    return openDatabase(idb);
  }

  async function rowsOf(db, storeName) {
    const values = await requestOf(db, storeName, "readonly", (store) => store.getAll());
    return values || [];
  }

  async function evict(db, docHash) {
    const records = [];
    for (const name of STORE_NAMES) records.push(...await rowsOf(db, name));
    const keys = new Set(evictionKeys(records, { docHash, docLimit, byteLimit }));
    if (!keys.size) return;
    for (const name of STORE_NAMES) {
      const rows = records.filter((row) => keys.has(row.key));
      for (const row of rows) {
        if (!row?.key) continue;
        await requestOf(db, name, "readwrite", (store) => store.delete(row.key));
      }
    }
  }

  async function put(storeName, key, record) {
    if (!isCacheableFormulaRecord(record)) return false;
    const db = await openCreating();
    try {
      const stored = prepareRecord(key, record);
      await requestOf(db, storeName, "readwrite", (store) => store.put(stored, key));
      await evict(db, stored.docHash || "");
      return true;
    } finally {
      db.close();
    }
  }

  return {
    kind: "idb",
    async getTier(key) {
      const db = await openExisting();
      if (!db) return null;
      try {
        const value = await requestOf(db, "tierResults", "readonly", (store) => store.get(key));
        return value ?? null;
      } finally {
        db.close();
      }
    },
    async getDecision(key) {
      const db = await openExisting();
      if (!db) return null;
      try {
        const value = await requestOf(db, "decisions", "readonly", (store) => store.get(key));
        return value ?? null;
      } finally {
        db.close();
      }
    },
    putTier(key, record) {
      return put("tierResults", key, record);
    },
    putDecision(key, record) {
      return put("decisions", key, record);
    },
    async clearDoc(docHash) {
      const db = await openExisting();
      if (!db) return;
      try {
        for (const name of STORE_NAMES) {
          const rows = await requestOf(db, name, "readonly", (store) => store.index("docHash").getAll(docHash));
          for (const row of rows || []) {
            if (row?.key) await requestOf(db, name, "readwrite", (store) => store.delete(row.key));
          }
        }
      } finally {
        db.close();
      }
    },
    async clearAll() {
      const db = await openExisting();
      if (!db) return;
      try {
        for (const name of STORE_NAMES) {
          const keys = (await rowsOf(db, name)).map((row) => row?.key).filter(Boolean);
          for (const key of keys) {
            await requestOf(db, name, "readwrite", (store) => store.delete(key));
          }
        }
      } finally {
        db.close();
      }
    }
  };
}

let shared = null;

export function sharedFormulaStore() {
  if (!shared) shared = createIdbFormulaStore();
  return shared;
}

export async function handleFormulaCacheMessage(message = {}, store = sharedFormulaStore()) {
  const action = message.action;
  try {
    if (action === "get") {
      const value = message.bucket === "decision"
        ? await store.getDecision(message.key)
        : await store.getTier(message.key);
      return { ok: true, value: value ?? null };
    }
    if (action === "put") {
      const stored = message.bucket === "decision"
        ? await store.putDecision(message.key, message.value)
        : await store.putTier(message.key, message.value);
      return { ok: true, stored: stored === true };
    }
    if (action === "clearDoc") {
      await store.clearDoc(message.docHash);
      return { ok: true };
    }
    if (action === "clearAll") {
      await store.clearAll();
      return { ok: true };
    }
    return { ok: false, error: "unknown action" };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
