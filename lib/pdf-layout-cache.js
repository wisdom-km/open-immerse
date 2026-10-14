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
  const body = record.layout && typeof record.layout === "object"
    ? record.layout
    : (Array.isArray(record.blocks) ? record : null);
  if (!body) return null;
  const own = String(body.layoutVersion || body.layoutRev || "");
  const rev = own ? "" : String(record.layoutRev || "");
  const mode = !body.mode && record.mode ? record.mode : "";
  if (!rev && !mode) return body;
  const next = { ...body };
  if (rev) {
    next.layoutVersion = rev;
    next.layoutRev = rev;
  }
  if (mode) next.mode = mode;
  return next;
}

function slotId(parsed) {
  return `${parsed.docHash}\0${parsed.page}\0${parsed.mode}\0${parsed.protocol}`;
}

const layoutSlots = new Map();

/**
 * One read-modify-write at a time for a layout key.
 * A slow copy of the old chrome key must not land after a layout this page
 * just saved, or the next open treats that page as stale and zones it again.
 */
function withLayoutSlot(id, fn) {
  const previous = layoutSlots.get(id) || Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(() => {}, () => {});
  layoutSlots.set(id, settled);
  settled.then(() => {
    if (layoutSlots.get(id) === settled) layoutSlots.delete(id);
  });
  return run;
}

async function copyLegacyLayout(parsed, legacy, store) {
  const layoutRev = String(legacy.layoutVersion || "");
  return withLayoutSlot(slotId(parsed), async () => {
    const row = await store.getLayout(parsed.docHash, parsed.page, parsed.mode, parsed.protocol);
    const stored = layoutBody(row);
    // The old key fills an empty slot only. A layout written while that key
    // was being read is the one the next open should see.
    if (stored) return stored;
    if (row && layoutRev && row.layoutRev === layoutRev) return legacy;
    await store.putLayout({
      ...parsed,
      layoutRev,
      layout: cacheableLayout(legacy)
    });
    return legacy;
  });
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
  try {
    return await copyLegacyLayout(parsed, legacy, store);
  } catch {
    /* failing to copy a cache does not hide the old value */
  }
  return legacy;
}

export async function readLayoutCaches(keys, options = {}) {
  const bag = {};
  const list = Array.isArray(keys) ? keys : [];
  for (const key of list) {
    const value = await readLayoutCache(key, options);
    if (value) bag[key] = value;
  }
  return bag;
}

export async function writeLayoutCache(key, page, options = {}) {
  const parsed = parseLayoutCacheKey(key);
  if (!parsed) return;
  const store = await storeFor(options);
  const layout = cacheableLayout(page);
  const layoutRev = String(layout?.layoutVersion || page?.layoutVersion || "");
  await withLayoutSlot(slotId(parsed), () => store.putLayout({
    ...parsed,
    layoutRev,
    layout
  }));
}
