/**
 * Platform skeleton for the extension and, later, the desktop app.
 *
 * kv and library came first. net is the swap point for HTTP: the extension
 * uses global fetch, the desktop app will pass a main-process transport.
 * The extension library is IndexedDB. The desktop library will be SQLite.
 * Both are reached through library.open(). Callers do not import indexedDB.
 */

import { installNet, currentNet } from "../net/fetch.js";
import { createChromeKv, createMemoryKv } from "./kv.js";
import { createIdbLibraryFactory } from "./idb-backend.js";
import { createMemoryLibraryFactory } from "./memory-backend.js";
import { createPlatformNet } from "./net.js";

let current = null;

function netOf(options) {
  const net = options.net || (options.transport ? createPlatformNet(options) : currentNet());
  installNet(net);
  return net;
}

export function createChromePlatform(chrome = globalThis.chrome, options = {}) {
  return {
    target: "chrome-ext",
    kv: createChromeKv(chrome),
    library: createIdbLibraryFactory(),
    net: netOf(options)
  };
}

export function createMemoryPlatform(options = {}) {
  return {
    target: "memory",
    kv: options.kv || createMemoryKv(),
    library: options.library || createMemoryLibraryFactory(options),
    net: netOf(options)
  };
}

function detectPlatform() {
  const chrome = globalThis.chrome;
  if (chrome?.runtime?.id && chrome?.storage) return createChromePlatform(chrome);
  return createMemoryPlatform();
}

export function setPlatform(platform) {
  current = platform || null;
  installNet(platform?.net || null);
}

export function getPlatform() {
  if (!current) current = detectPlatform();
  return current;
}

export { createPlatformNet } from "./net.js";
