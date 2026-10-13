/**
 * KvStore for settings and small preferences.
 *
 * Keys never go in here. chrome.storage.local also holds layout-cache keys,
 * so this adapter does not call get(null) when getKeys is missing.
 */

function areaOf(chrome, area) {
  const storage = chrome?.storage?.[area];
  if (!storage) {
    const error = new Error(`chrome.storage.${area} missing`);
    error.name = "InvalidStateError";
    throw error;
  }
  return storage;
}

export function createMemoryKv() {
  const areas = { local: new Map(), sync: new Map() };
  const listeners = new Set();

  function bucket(area) {
    if (!areas[area]) {
      const error = new Error(`unknown kv area ${area}`);
      error.name = "DataError";
      throw error;
    }
    return areas[area];
  }

  return {
    async get(area, key) {
      return bucket(area).has(key) ? bucket(area).get(key) : undefined;
    },
    async getMany(area, keys) {
      const source = bucket(area);
      const out = {};
      for (const key of keys || []) {
        if (source.has(key)) out[key] = source.get(key);
      }
      return out;
    },
    async set(area, entries) {
      const source = bucket(area);
      const changes = {};
      for (const [key, value] of Object.entries(entries || {})) {
        changes[key] = { oldValue: source.get(key), newValue: value };
        source.set(key, value);
      }
      for (const cb of [...listeners]) cb(changes, area);
    },
    async remove(area, keys) {
      const source = bucket(area);
      const changes = {};
      for (const key of keys || []) {
        if (!source.has(key)) continue;
        changes[key] = { oldValue: source.get(key) };
        source.delete(key);
      }
      for (const cb of [...listeners]) cb(changes, area);
    },
    async keys(area, prefix) {
      const names = [...bucket(area).keys()];
      if (!prefix) return names;
      return names.filter((key) => String(key).startsWith(prefix));
    },
    watch(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };
}

export function createChromeKv(chrome = globalThis.chrome) {
  return {
    async get(area, key) {
      const bag = await areaOf(chrome, area).get(key);
      return bag?.[key];
    },
    async getMany(area, keys) {
      return areaOf(chrome, area).get(keys || []);
    },
    async set(area, entries) {
      await areaOf(chrome, area).set(entries || {});
    },
    async remove(area, keys) {
      await areaOf(chrome, area).remove(keys || []);
    },
    async keys(area, prefix) {
      const storage = areaOf(chrome, area);
      if (typeof storage.getKeys !== "function") return [];
      const names = await storage.getKeys();
      const list = Array.isArray(names) ? names.map(String) : [];
      if (!prefix) return list;
      return list.filter((key) => key.startsWith(prefix));
    },
    watch(cb) {
      const onChanged = chrome?.storage?.onChanged;
      if (!onChanged || typeof onChanged.addListener !== "function") return () => {};
      const listener = (changes, areaName) => cb(changes, areaName);
      onChanged.addListener(listener);
      return () => onChanged.removeListener(listener);
    }
  };
}
