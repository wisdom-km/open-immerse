/**
 * Page layout cache. New writes go to the library layouts store.
 * An old oi-pdf-layout:* value is copied in when it is read, and left in place.
 */

import { cacheableLayout } from "./pdf-layout-client.js";

export function parseLayoutCacheKey(key) {
  const text = String(key || "");
  const prefix = "oi-pdf-layout:";
  const suffix = ":source-v3";
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  const parts = text.slice(prefix.length, -suffix.length).split(":");
  if (parts.length < 4) return null;
  const protocol = parts.pop();
  const mode = parts.pop();
  const page = Number(parts.pop());
  const docHash = parts.join(":");
  if (!docHash || !(page >= 1) || !mode || !protocol) return null;
  return { docHash, page, mode, protocol };
}

async function chromeGet(keys) {
  const get = globalThis.chrome?.storage?.local?.get;
  if (typeof get !== "function") return {};
  try {
    const bag = await get(keys);
    return bag && typeof bag === "object" ? bag : {};
  } catch {
    return {};
  }
}

async function storeFor(options) {
  if (options?.store) return options.store;
  const { sharedLibraryStore } = await import("./library-session.js");
  return sharedLibraryStore();
}

function layoutBody(record) {
  if (!record) return null;
  if (record.layout && typeof record.layout === "object") return record.layout;
  if (Array.isArray(record.blocks)) return record;
  return null;
}

export async function readLayoutCache(key, options = {}) {
  const parsed = parseLayoutCacheKey(key);
  const store = parsed ? await storeFor(options) : null;
  if (parsed && store) {
    try {
      const row = await store.getLayout(parsed.docHash, parsed.page, parsed.mode, parsed.protocol);
      const stored = layoutBody(row);
      if (stored) return stored;
    } catch {
      /* the old key is still a cache */
    }
  }
  const bag = await chromeGet(key);
  const legacy = bag?.[key] || null;
  if (!legacy || !parsed || !store) return legacy;
  const layoutRev = String(legacy.layoutVersion || "");
  try {
    const row = await store.getLayout(parsed.docHash, parsed.page, parsed.mode, parsed.protocol);
    if (row && layoutRev && row.layoutRev === layoutRev) return layoutBody(row) || legacy;
    await store.putLayout({
      ...parsed,
      layoutRev,
      layout: cacheableLayout(legacy)
    });
  } catch {
    /* failing to copy a cache does not hide the old value */
  }
  return legacy;
}

export async function readLayoutCaches(keys, options = {}) {
  const bag = {};
  const list = Array.isArray(keys) ? keys : [];
  await Promise.all(list.map(async (key) => {
    const value = await readLayoutCache(key, options);
    if (value) bag[key] = value;
  }));
  return bag;
}

export async function writeLayoutCache(key, page, options = {}) {
  const parsed = parseLayoutCacheKey(key);
  if (!parsed) return;
  const store = await storeFor(options);
  const layout = cacheableLayout(page);
  await store.putLayout({
    ...parsed,
    layoutRev: String(layout?.layoutVersion || page?.layoutVersion || ""),
    layout
  });
}
