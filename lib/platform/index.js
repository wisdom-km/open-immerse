/**
 * Platform skeleton for the extension and, later, the desktop app.
 *
 * This step only exposes kv and library. The extension library is IndexedDB.
 * The desktop library will be SQLite. Both are reached through library.open().
 * Callers do not import indexedDB themselves.
 */

import { createChromeKv, createMemoryKv } from "./kv.js";
import { createIdbLibraryFactory } from "./idb-backend.js";
import { createMemoryLibraryFactory } from "./memory-backend.js";

let current = null;

export function createChromePlatform(chrome = globalThis.chrome) {
  return {
    target: "chrome-ext",
    kv: createChromeKv(chrome),
    library: createIdbLibraryFactory()
  };
}

export function createMemoryPlatform(options = {}) {
  return {
    target: "memory",
    kv: options.kv || createMemoryKv(),
    library: options.library || createMemoryLibraryFactory(options)
  };
}

function detectPlatform() {
  const chrome = globalThis.chrome;
  if (chrome?.runtime?.id && chrome?.storage) return createChromePlatform(chrome);
  return createMemoryPlatform();
}

export function setPlatform(platform) {
  current = platform || null;
}

export function getPlatform() {
  if (!current) current = detectPlatform();
  return current;
}
