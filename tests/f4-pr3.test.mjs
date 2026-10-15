import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createLibraryStore, LIBRARY_FORMAT, LIBRARY_PERSIST_HINT_KEY, LIBRARY_SCHEMA } from "../lib/library-store.js";
import { NOTES_DB_NAME, createNotesStore } from "../lib/notes-store.js";
import { createIdbLibraryFactory } from "../lib/platform/idb-backend.js";
import {
  DEFAULT_BLOCKED_TIMEOUT_MS,
  STORAGE_AVAILABLE_EVENT,
  onStorageAvailable,
  OPEN_INHERIT_AFTER_MS,
  openIndexedDatabase,
  storageOpenIsBlocked,
  storagePageTarget
} from "../lib/platform/idb-open.js";
import { createMemoryKv } from "../lib/platform/kv.js";
import { createMemoryLibraryFactory } from "../lib/platform/memory-backend.js";
import {
  LIBRARY_PROBE_DELAYS_MS,
  LIBRARY_ZONE_HARD_MS,
  LIBRARY_ZONE_WAIT_MS,
  asLibraryDocument,
  beginLegacyLibraryFetch,
  beginZoneStoredRead,
  currentLayoutIfArrived,
  fetchLibraryDocument,
  libraryDocumentFromRecords,
  migratedLayoutMode,
  toLibraryRecords,
  flushPendingPages,
  mergeLibraryPairs,
  mergeStoredPagePairs,
  paperFullyInLibrary,
  preferArrivedLayout,
  recordedLayoutMode,
  saveLibraryPage,
  selectPageLayout,
  shouldProbeLocalService,
  translationWaitsForLibrary,
  withLibraryDocLock,
  resolveZoneForVendor,
  settleFreshZone,
  waitForFirstZone,
  waitForZoneMigration,
  whenZoneReadSettles
} from "../lib/pdf-library.js";
import { LAYOUT_RETRY_DELAYS_MS, cacheableLayout, createPrioritySerialLane, fetchLocalEnvelope, layoutCacheKey, layoutCurrentForEngine, layoutCurrentForLibrary, layoutReadyForZone, layoutRetrySplit, runLaneAttempts, stampSessionLayout, startDocumentLayoutRetry, storedLayoutCurrent } from "../lib/pdf-layout-client.js";
import { readLayoutCache, writeLayoutCache } from "../lib/pdf-layout-cache.js";
import { createLibraryChip } from "../lib/library-chip.js";
import { PERSIST_CARD_SESSION_KEY, createPersistCard, readPersistCardState } from "../lib/persist-card.js";
import { createLibrarySession } from "../lib/library-session.js";
import { NOTES_PERSIST_HINT_KEY } from "../lib/notes-prefs.js";
import { NOTES_HINT_DOC_PREFIX } from "../lib/reader-notes-local.js";
import { bindPendingUnload, createPendingNotes, pendingNotesKey } from "../lib/pending-notes.js";
import { createBackgroundSessions, createPageCache, createTranslateSession, translateDocumentPages, translationCacheWhile } from "../lib/pdf-viewer.js";
import { storedLibraryPagesSource } from "./helpers/library-observe.mjs";
import { mountNotesUi } from "../pdf/notes-panel.js";
import {
  BLOCKED_CAN,
  BLOCKED_CANNOT,
  BLOCKED_CHIP,
  BLOCKED_SAFE_LINE,
  MOVE_CHIP_DELAY_MS,
  MOVE_CHIP_TITLE,
  PERSIST_CARD_BODY,
  PERSIST_CARD_TITLE,
  RECOVER_FADE_MS,
  RECOVER_HOLD_MS,
  RETRY_MIN_DISABLE_MS,
  STORAGE_MANUAL_RETRY_MS,
  STORAGE_POLL_MS,
  WRITE_FAIL_CHIP,
  WRITE_FAIL_SAFE,
  autoRetryLabel,
  blockedReasonCopy,
  blockedRetryAdvice,
  storageOpenSeconds
} from "../lib/storage-copy.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls += 1;
  const error = new Error("F4 PR-3 test must not send a network request");
  error.code = "live-fetch-blocked";
  throw error;
};

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function memoryStore(extra = {}) {
  const kv = createMemoryKv();
  const library = extra.library || createMemoryLibraryFactory();
  const store = createLibraryStore({
    platform: { target: "memory", kv, library },
    deviceId: "device-pr3",
    now: () => 40,
    persist: false,
    ...extra
  });
  return { store, kv, library };
}

function legacyDoc(title = "旧库论文") {
  return {
    title,
    pageCount: 1,
    pages: [{
      page: 1,
      pairs: [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "你好", targetLang: "zh-CN" }]
    }]
  };
}

function okFetch(doc) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => doc
  });
}

function sleepNow() {
  return Promise.resolve();
}

function blockedError(cause = "blocked", since = 1_700_000_000_000) {
  const error = new Error("这次没能打开本机存储。");
  error.name = "BlockedError";
  error.cause = cause;
  error.since = since;
  return error;
}

function createTimers() {
  let now = 0;
  let seq = 1;
  const queue = [];
  return {
    setTimeout(fn, ms) {
      const id = seq++;
      queue.push({ id, at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      const index = queue.findIndex((item) => item.id === id);
      if (index >= 0) queue.splice(index, 1);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = queue
          .filter((item) => item.at <= now)
          .sort((a, b) => a.at - b.at || a.id - b.id);
        if (!due.length) break;
        const item = due[0];
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        item.fn();
      }
    }
  };
}

function installDom() {
  const listeners = new Map();
  function on(type, fn) {
    const list = listeners.get(type) || [];
    list.push(fn);
    listeners.set(type, list);
  }
  function off(type, fn) {
    listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn));
  }
  function tokensOf(compound) {
    const out = [];
    let index = 0;
    while (index < compound.length) {
      const ch = compound[index];
      if (ch === ".") {
        const match = compound.slice(index + 1).match(/^([A-Za-z0-9_-]+)/);
        out.push({ kind: "class", value: match[1] });
        index += 1 + match[1].length;
      } else if (ch === "#") {
        const match = compound.slice(index + 1).match(/^([A-Za-z0-9_-]+)/);
        out.push({ kind: "id", value: match[1] });
        index += 1 + match[1].length;
      } else if (ch === "[") {
        const end = compound.indexOf("]", index);
        const body = compound.slice(index + 1, end);
        const eq = body.indexOf("=");
        if (eq < 0) out.push({ kind: "attr", name: body, value: null });
        else {
          out.push({
            kind: "attr",
            name: body.slice(0, eq),
            value: body.slice(eq + 1).replace(/^['"]|['"]$/g, "")
          });
        }
        index = end + 1;
      } else {
        const match = compound.slice(index).match(/^([A-Za-z0-9-]+)/);
        out.push({ kind: "tag", value: match[1].toUpperCase() });
        index += match[1].length;
      }
    }
    return out;
  }
  function splitOutside(selector, space) {
    const parts = [];
    let buf = "";
    let depth = 0;
    for (const ch of selector) {
      if (ch === "[") depth += 1;
      else if (ch === "]") depth -= 1;
      const split = space ? /\s/.test(ch) : ch === ",";
      if (split && depth === 0) {
        if (buf.trim()) parts.push(buf.trim());
        buf = "";
      } else buf += ch;
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts;
  }
  function matchCompound(node, compound) {
    if (!node?.tagName) return false;
    return tokensOf(compound).every((token) => {
      if (token.kind === "class") return node.classList.contains(token.value);
      if (token.kind === "id") return node.attrs.id === token.value;
      if (token.kind === "tag") return node.tagName === token.value;
      if (token.value == null) return Object.prototype.hasOwnProperty.call(node.attrs, token.name);
      return node.attrs[token.name] === token.value;
    });
  }
  function matchSelector(node, selector) {
    return splitOutside(selector, false).some((part) => matchCompound(node, part));
  }
  function matchChain(node, chain) {
    if (!matchCompound(node, chain[chain.length - 1])) return false;
    if (chain.length === 1) return true;
    let parent = node.parent;
    const rest = chain.slice(0, -1);
    while (parent) {
      if (matchChain(parent, rest)) return true;
      parent = parent.parent;
    }
    return false;
  }
  function walk(node, visit) {
    for (const child of node.children || []) {
      visit(child);
      walk(child, visit);
    }
  }
  function queryAll(node, selector) {
    const found = [];
    for (const alt of splitOutside(selector, false)) {
      const chain = splitOutside(alt, true);
      walk(node, (child) => {
        if (matchChain(child, chain)) found.push(child);
      });
    }
    return found;
  }
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attrs: {},
      parent: null,
      disabled: false,
      hidden: false,
      value: "",
      textContent: "",
      className: "",
      style: {
        setProperty(name, value) { this[name] = value; },
        removeProperty(name) { delete this[name]; },
        getPropertyValue(name) { return this[name] || ""; }
      },
      clientWidth: 800,
      nodeType: 1,
      scrollTop: 0,
      files: null,
      listeners: new Map(),
      classList: null,
      dataset: null
    };
    node.classList = {
      contains(name) {
        return node.className.split(/\s+/).filter(Boolean).includes(name);
      },
      add(name) {
        if (!this.contains(name)) node.className = `${node.className} ${name}`.trim();
      },
      remove(name) {
        node.className = node.className.split(/\s+/).filter((item) => item && item !== name).join(" ");
      },
      toggle(name, force) {
        const has = this.contains(name);
        const next = force == null ? !has : Boolean(force);
        if (next) this.add(name);
        else this.remove(name);
        return next;
      }
    };
    node.dataset = new Proxy({}, {
      get(_target, key) {
        return node.attrs[`data-${String(key).replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`];
      },
      set(_target, key, value) {
        node.attrs[`data-${String(key).replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`] = String(value);
        return true;
      },
      deleteProperty(_target, key) {
        delete node.attrs[`data-${String(key).replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`];
        return true;
      }
    });
    node.setAttribute = (name, value) => {
      node.attrs[name] = String(value);
    };
    node.removeAttribute = (name) => {
      delete node.attrs[name];
    };
    node.getAttribute = (name) => (name in node.attrs ? node.attrs[name] : null);
    node.append = (...kids) => {
      for (const kid of kids) {
        if (!kid) continue;
        kid.parent = node;
        node.children.push(kid);
      }
    };
    node.replaceChildren = (...kids) => {
      for (const child of node.children) child.parent = null;
      node.children = [];
      node.append(...kids);
    };
    node.addEventListener = (type, fn) => {
      const list = node.listeners.get(type) || [];
      list.push(fn);
      node.listeners.set(type, list);
    };
    node.removeEventListener = (type, fn) => {
      node.listeners.set(type, (node.listeners.get(type) || []).filter((item) => item !== fn));
    };
    node.dispatchEvent = (event) => {
      for (const fn of node.listeners.get(event.type) || []) fn(event);
      return true;
    };
    node.focus = () => {
      node.focused = true;
    };
    node.closest = (selector) => {
      let current = node;
      while (current) {
        if (matchSelector(current, selector)) return current;
        current = current.parent;
      }
      return null;
    };
    node.querySelector = (selector) => queryAll(node, selector)[0] || null;
    node.querySelectorAll = (selector) => queryAll(node, selector);
    node.getBoundingClientRect = () => ({ top: 0, left: 0, width: 120, height: 24, right: 120, bottom: 24 });
    Object.defineProperty(node, "childNodes", {
      get() { return node.children; }
    });
    node.contains = (other) => {
      let current = other;
      while (current) {
        if (current === node) return true;
        current = current.parent;
      }
      return false;
    };
    return node;
  }
  const body = el("body");
  const document = {
    body,
    visibilityState: "visible",
    createElement: el,
    createElementNS: (_ns, tag) => el(tag),
    addEventListener: on,
    removeEventListener: off,
    getElementById(id) {
      return queryAll(body, `#${id}`)[0] || null;
    },
    querySelector(selector) {
      return queryAll(body, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return queryAll(body, selector);
    }
  };
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1200,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    removeEventListener() {},
    getSelection: () => ({ isCollapsed: true }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0)
  };
  if (globalThis.navigator && !globalThis.navigator.locks) {
    try { globalThis.navigator.locks = undefined; } catch { /* locks stays absent */ }
  }
  globalThis.CSS = { escape: (value) => String(value) };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  const slot = el("div");
  slot.attrs.id = "sideSlot";
  const workspace = el("div");
  workspace.className = "workspace";
  const notesButton = el("button");
  notesButton.attrs.id = "notesButton";
  body.append(slot, workspace, notesButton);
  return {
    document,
    body,
    slot,
    dispatch(type, event) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
    text(node) {
      if (!node) return "";
      if (node.children?.length) return node.children.map((child) => this.text(child)).join("");
      return String(node.textContent || node.innerHTML || "");
    },
    click(node) {
      node.dispatchEvent({ type: "click", preventDefault() {}, target: node, currentTarget: node });
    }
  };
}

const dom = installDom();

function findButton(host, label) {
  const nodes = host.querySelectorAll("button");
  return nodes.find((node) => {
    const text = dom.text(node);
    return text === label || text.startsWith(label);
  }) || null;
}

async function tick() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function quotaFactory() {
  const inner = createMemoryLibraryFactory();
  const fail = { on: false };
  return {
    fail,
    kind: "memory",
    exists: (name) => inner.exists(name),
    async open(name, schema, options) {
      const backend = await inner.open(name, schema, options);
      const tx = backend.tx.bind(backend);
      backend.tx = async (collections, mode, fn) => {
        const names = [].concat(collections || []);
        if (fail.on && mode === "readwrite" && names.includes("papers")) {
          const error = new Error("quota");
          error.name = "QuotaExceededError";
          throw error;
        }
        return tx(collections, mode, fn);
      };
      return backend;
    },
    blobs: (...args) => inner.blobs(...args),
    close: (...args) => inner.close(...args),
    reset: () => inner.reset()
  };
}

function oneShotLocks() {
  let busy = false;
  return {
    async request(_name, options, fn) {
      if (options?.ifAvailable && busy) return fn(null);
      busy = true;
      try {
        return await fn({ name: _name });
      } finally {
        busy = false;
      }
    }
  };
}

test("storage open constants follow the 10s timeout, 11s manual cap, and 5s fallback poll", () => {
  assert.equal(DEFAULT_BLOCKED_TIMEOUT_MS, 10000);
  assert.equal(STORAGE_MANUAL_RETRY_MS, 11000);
  assert.equal(STORAGE_POLL_MS, 5000);
  assert.equal(storageOpenSeconds(), 10);
  assert.equal(autoRetryLabel(), "每 5 秒自动再试");
  assert.equal(MOVE_CHIP_DELAY_MS, 800);
  assert.equal(RETRY_MIN_DISABLE_MS, 600);
  assert.equal(RECOVER_HOLD_MS, 2000);
  assert.equal(RECOVER_FADE_MS, 200);
  const timeout = blockedReasonCopy("timeout");
  assert.match(timeout.reason, /10 秒/);
  assert.doesNotMatch(timeout.reason, /5 秒/);
  assert.doesNotMatch(blockedRetryAdvice("timeout"), /页面|标签页/);
  assert.doesNotMatch(blockedRetryAdvice("blocked"), /电脑慢/);
  assert.match(blockedRetryAdvice("unknown"), /关掉其他 Open Immerse 页面/);
  assert.match(blockedRetryAdvice("unknown"), /重启浏览器/);
  for (const file of [
    "lib/storage-copy.js",
    "lib/library-chip.js",
    "lib/platform/idb-open.js",
    "pdf/notes-panel.js",
    "pdf/viewer.js"
  ]) {
    assert.equal(read(file).includes("被其他页面占用"), false, file);
  }
});

test("a slow open without onblocked is a timeout, and onblocked is blocked", async () => {
  const quiet = hangingFactory();
  const timed = await openIndexedDatabase({
    name: "oi-pr3-timeout",
    version: 2,
    indexedDB: quiet.factory,
    blockedTimeoutMs: 20
  }).then(() => null, (error) => error);
  assert.equal(timed.name, "BlockedError");
  assert.equal(timed.cause, "timeout");
  assert.equal(timed.message, "这次没能打开本机存储。");
  assert.equal(Number.isFinite(timed.since), true);
  quiet.req.result = { close() {} };
  quiet.req.onsuccess();

  const held = hangingFactory();
  const pending = openIndexedDatabase({
    name: "oi-pr3-blocked",
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 40
  });
  held.req.onblocked();
  const blocked = await pending.then(() => null, (error) => error);
  assert.equal(blocked.cause, "blocked");
  assert.equal(blocked.message, "这次没能打开本机存储。");
  held.req.result = { close() {} };
  held.req.onsuccess();
  // The late connection closes, then announces, on a later turn.
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a pending open is inherited without another indexedDB.open, then release emits oi-storage-available", async () => {
  let opens = 0;
  const held = hangingFactory(() => {
    opens += 1;
  });
  const heard = [];
  const stop = onStorageAvailable((detail) => heard.push(detail));
  const channel = new BroadcastChannel("oi-library");
  const remote = [];
  channel.onmessage = (event) => remote.push(event.data);
  try {
  const first = openIndexedDatabase({
    name: "oi-pr3-inherit",
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 20
  });
  const failed = await first.then(() => null, (error) => error);
  assert.equal(failed.cause, "timeout");
  const opensAfter = opens;
  const started = Date.now();
  const second = await openIndexedDatabase({
    name: "oi-pr3-inherit",
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 20
  }).then(() => null, (error) => error);
  assert.equal(opens, opensAfter);
  assert.ok(Date.now() - started < 200);
  assert.equal(second.cause, failed.cause);
  assert.equal(second.since, failed.since);
  assert.equal(second.message, "这次没能打开本机存储。");
  held.req.onblocked();
  const upgraded = await openIndexedDatabase({
    name: "oi-pr3-inherit",
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 20
  }).then(() => null, (error) => error);
  assert.equal(opens, opensAfter);
  assert.equal(upgraded.cause, "blocked");
  assert.equal(upgraded.since, failed.since);
  held.req.result = { close() {} };
  held.req.onsuccess();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(heard.length, 1);
  assert.equal(heard[0].type, STORAGE_AVAILABLE_EVENT);
  assert.equal(remote.length, 1);
  assert.equal(remote[0].type, "oi-storage-available");
  } finally {
    stop();
    channel.close();
  }
});

test("F4-08 keeps the old layout key and still judges it with storedLayoutCurrent", async () => {
  const { store } = memoryStore();
  const key = layoutCacheKey({ hash: "doc-layout", page: 2, mode: "text-layer" });
  const legacy = {
    blocks: [{ bid: "b", text: "kept" }],
    layoutVersion: "rev-1",
    protocol: "blocks-1",
    textSource: "text-layer"
  };
  const bag = new Map([[key, legacy]]);
  let removed = 0;
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const name of names) if (bag.has(name)) out[name] = bag.get(name);
          return out;
        },
        async set() {
          throw new Error("layout write must stay in the library store");
        },
        async remove() {
          removed += 1;
        }
      }
    }
  };
  let puts = 0;
  const original = store.putLayout.bind(store);
  store.putLayout = async (record) => {
    puts += 1;
    return original(record);
  };
  const first = await readLayoutCache(key, { store });
  assert.equal(first.blocks[0].bid, "b");
  assert.equal(puts, 1);
  assert.equal(bag.has(key), true);
  assert.equal(removed, 0);
  const row = await store.getLayout("doc-layout", 2, "text-layer", "blocks-1");
  assert.equal(row.layoutRev, "rev-1");
  puts = 0;
  const second = await readLayoutCache(key, { store });
  assert.equal(second.blocks[0].text, "kept");
  assert.equal(puts, 0);
  assert.equal(storedLayoutCurrent(second, "rev-1")?.blocks[0].bid, "b");
  assert.equal(storedLayoutCurrent({ layout: second, layoutVersion: "rev-1" }, "rev-1")?.blocks[0].bid, "b");
  assert.equal(storedLayoutCurrent(second, "other"), null);
  await store.putLayout({
    docHash: "doc-layout",
    page: 2,
    mode: "text-layer",
    protocol: "blocks-1",
    layoutRev: "rev-9",
    layout: { blocks: [{ bid: "new", text: "fresh" }], layoutVersion: "rev-9", protocol: "blocks-1" }
  });
  puts = 0;
  const kept = await readLayoutCache(key, { store });
  assert.equal(kept.blocks[0].bid, "new");
  assert.equal(puts, 0);
  assert.equal((await store.getLayout("doc-layout", 2, "text-layer", "blocks-1")).layoutRev, "rev-9");
  await writeLayoutCache(key, { ...legacy, layoutVersion: "rev-2" }, { store });
  assert.equal(bag.get(key).layoutVersion, "rev-1");
  const freshKey = layoutCacheKey({ hash: "doc-layout", page: 4, mode: "local-ocr" });
  const stale = { blocks: [{ bid: "old", text: "stale" }], protocol: "blocks-1", textSource: "text-layer" };
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  let readEntered = false;
  globalThis.chrome.storage.local.get = async (keys) => {
    const names = Array.isArray(keys) ? keys : [keys];
    if (names.includes(freshKey)) {
      readEntered = true;
      await gate;
      return { [freshKey]: stale };
    }
    const out = {};
    for (const name of names) if (bag.has(name)) out[name] = bag.get(name);
    return out;
  };
  const reading = readLayoutCache(freshKey, { store });
  while (!readEntered) await new Promise((resolve) => setTimeout(resolve, 1));
  await writeLayoutCache(freshKey, {
    blocks: [{ bid: "new", text: "fresh" }],
    layoutVersion: "rev-2",
    protocol: "blocks-1"
  }, { store });
  releaseRead();
  const during = await reading;
  assert.equal(during.blocks[0].bid, "new");
  assert.equal((await store.getLayout("doc-layout", 4, "local-ocr", "blocks-1")).layoutRev, "rev-2");
  const viewer = read("pdf/viewer.js");
  const readFn = viewer.slice(viewer.indexOf("async function readStoredLayout"), viewer.indexOf("async function writeStoredLayout"));
  const writeFn = viewer.slice(viewer.indexOf("async function writeStoredLayout"), viewer.indexOf("const vendorLayoutPending"));
  assert.match(readFn, /readLayoutCache/);
  assert.match(writeFn, /writeLayoutCache/);
  assert.doesNotMatch(writeFn, /chrome\.storage\.local\.set/);
});

test("F4-09 keeps an already migrated paper when the next one hits quota", async () => {
  const library = quotaFactory();
  const { store } = memoryStore({ library });
  await store.touchPaper("kept", { title: "已搬", pageCount: 1, origin: "native" });
  await store.putPage("kept", 1, {
    pairs: [{ bid: "k", text: "Stay", sourceText: "Stay", translation: "留下", targetLang: "zh-CN" }]
  });
  library.fail.on = true;
  const failed = [];
  const doc = await fetchLibraryDocument("new-doc", {
    store,
    fetch: okFetch(legacyDoc("新论文")),
    sleep: sleepNow,
    hooks: { onWriteFailed(error) { failed.push(error); } }
  });
  assert.equal(doc.title, "新论文");
  assert.equal(doc.pages[0].pairs[0].translation, "你好");
  assert.equal(failed[0].type, "quota");
  const kept = await fetchLibraryDocument("kept", {
    store,
    fetch: () => {
      throw new Error("kept paper must not be read from 8765");
    }
  });
  assert.equal(kept.sourcePath, "idb");
  assert.equal(kept.pages[0].pairs[0].translation, "留下");
  const status = await store.migrationStatus();
  assert.equal(status.errors.some((item) => item.reason === "quota" && item.docHash === "new-doc"), true);
  assert.equal(status.errors.some((item) => item.reason === "blocked"), false);
});

test("a down local service still translates, and a deleted paper is not imported again", async () => {
  const { store } = memoryStore();
  let calls = 0;
  await assert.rejects(
    fetchLibraryDocument("missing", {
      store,
      fetch: async () => {
        calls += 1;
        throw new Error("down");
      },
      sleep: sleepNow
    }),
    (error) => error.message === "local PDF library unavailable"
  );
  assert.equal(calls, LIBRARY_PROBE_DELAYS_MS.length);
  assert.deepEqual([...LIBRARY_PROBE_DELAYS_MS], [0, 400, 1000, 1800]);

  await store.touchPaper("gone", { title: "删过", pageCount: 1, origin: "native" });
  await store.putPage("gone", 1, {
    pairs: [{ bid: "g", text: "Gone", sourceText: "Gone", translation: "没了", targetLang: "zh-CN" }]
  });
  await store.deletePaperData("gone");
  let legacy = 0;
  const again = await fetchLibraryDocument("gone", {
    store,
    fetch: async () => {
      legacy += 1;
      return { ok: true, status: 200, json: async () => legacyDoc("不该回来") };
    },
    sleep: sleepNow
  });
  assert.equal(again, null);
  assert.equal(legacy, 0);
  await saveLibraryPage({
    hash: "gone",
    title: "重译",
    pageCount: 1,
    page: 1,
    pairs: [{ bid: "g", text: "Gone", sourceText: "Gone", translation: "回来", targetLang: "zh-CN" }],
    sourceBase64: "AAAA"
  }, { store });
  const revived = await fetchLibraryDocument("gone", {
    store,
    fetch: () => {
      throw new Error("revived paper is already in IDB");
    }
  });
  assert.equal(revived.pages[0].pairs[0].translation, "回来");
  assert.equal(revived.sourcePath, "idb");
  assert.equal(fetchCalls, 0);
});

test("F4-10 migrates one paper once, merges a later page, and does not rebroadcast a remote note", async () => {
  const { store } = memoryStore({
    mergePairs: (existing, incoming, blocks, lang) => mergeLibraryPairs(existing, incoming, blocks, lang)
  });
  let writes = 0;
  const original = store.putLegacyDocument.bind(store);
  store.putLegacyDocument = async (...args) => {
    writes += 1;
    return original(...args);
  };
  const fetchImpl = okFetch(legacyDoc("只搬一次"));
  const locks = oneShotLocks();
  const [first, second] = await Promise.all([
    fetchLibraryDocument("once", { store, fetch: fetchImpl, sleep: sleepNow, locks }),
    fetchLibraryDocument("once", { store, fetch: fetchImpl, sleep: sleepNow, locks })
  ]);
  assert.equal(writes, 1);
  assert.equal(first.pages[0].pairs[0].translation, "你好");
  assert.equal(second.pages[0].pairs[0].translation, "你好");
  const paper = await store.getPaper("once");
  assert.equal(paper.origin, "local-service");

  const skipped = await fetchLibraryDocument("skipped", {
    store,
    fetch: okFetch(legacyDoc("这页先读")),
    sleep: sleepNow,
    locks: { request: async (_name, _options, fn) => fn(null) }
  });
  assert.equal(skipped.title, "这页先读");
  assert.equal(skipped.hash, "skipped");
  assert.equal(skipped.pages[0].pairs[0].translation, "你好");
  assert.equal(await store.getPaper("skipped"), null);

  await store.putPage("once", 1, {
    pairs: [
      { bid: "a", text: "Hello", sourceText: "Hello", translation: "你好", targetLang: "zh-CN" },
      { bid: "b", text: "World", sourceText: "World", translation: "世界", targetLang: "zh-CN" }
    ],
    blocks: [
      { bid: "a", text: "Hello", sourceText: "Hello" },
      { bid: "b", text: "World", sourceText: "World" }
    ],
    targetLang: "zh-CN"
  });
  await Promise.all([
    store.putPage("once", 1, {
      pairs: [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "", targetLang: "zh-CN" }],
      blocks: [
        { bid: "a", text: "Hello", sourceText: "Hello" },
        { bid: "b", text: "World", sourceText: "World" }
      ],
      targetLang: "zh-CN"
    }),
    store.putPage("once", 1, {
      pairs: [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "早", targetLang: "zh-CN" }],
      blocks: [
        { bid: "a", text: "Hello", sourceText: "Hello" },
        { bid: "b", text: "World", sourceText: "World" }
      ],
      targetLang: "zh-CN"
    })
  ]);
  const merged = await store.getPage("once", 1);
  const byBid = Object.fromEntries(merged.pairs.map((pair) => [pair.bid, pair.translation]));
  assert.equal(byBid.a, "你好");
  assert.equal(byBid.b, "世界");

  const plain = memoryStore().store;
  await plain.touchPaper("rev", { title: "rev", pageCount: 1, origin: "native" });
  await plain.putPage("rev", 1, {
    pairs: [{ bid: "a", text: "Full", sourceText: "Full", translation: "完整", targetLang: "zh-CN" }]
  });
  const current = await plain.getPage("rev", 1);
  await plain.putPage("rev", 1, {
    rev: current.rev - 1,
    updatedAt: 1,
    pairs: [{ bid: "a", text: "Full", sourceText: "Full", translation: "旧批次", targetLang: "zh-CN" }]
  });
  assert.equal((await plain.getPage("rev", 1)).pairs[0].translation, "完整");

  let notes = 0;
  const broadcast = createLibraryStore({
    platform: { target: "memory", kv: createMemoryKv(), library: createMemoryLibraryFactory() },
    persist: false,
    onNotify() { notes += 1; }
  });
  broadcast.notify({ collection: "pages", docHash: "once", page: 1 }, "remote");
  assert.equal(notes, 0);
  broadcast.notify({ collection: "pages", docHash: "once", page: 1 });
  assert.equal(notes, 1);
});

test("F4-10 two connections: a held upgrade is a typed blocked error and is not stored as a migration error", async () => {
  const factory = createIdbLibraryFactory();
  let held = null;
  try {
    const notes = createNotesStore({
      persist: false,
      deviceId: "device-seed",
      now: () => 3,
      createId: () => "n-pr3"
    });
    await notes.put({ docHash: "doc-a", kind: "note", page: 1, body: "还在 v1" });
    held = await new Promise((resolve, reject) => {
      const request = indexedDB.open(NOTES_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("open failed"));
    });
    held.onversionchange = () => {};
    const store = createLibraryStore({
      platform: { target: "idb", kv: createMemoryKv(), library: factory },
      persist: false,
      deviceId: "device-lib",
      now: () => 4,
      blockedTimeoutMs: 30
    });
    const error = await store.putLegacyDocument("doc-a", {
      paper: { title: "升" },
      pages: [{ page: 1, pairs: [] }]
    }).then(() => null, (item) => item);
    assert.equal(error.type, "blocked");
    assert.equal(error.name, "LibraryStoreError");
    assert.equal(error.message, "这次没能打开本机存储。");
    assert.equal(error.cause?.name, "BlockedError");
    held.close();
    held = null;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const status = await store.migrationStatus();
    assert.equal(status.errors.some((item) => item.reason === "blocked"), false);
    await store.putLegacyDocument("bad", {
      paper: { title: "坏" },
      pages: [{ page: 0, pairs: [] }]
    }).then(() => {
      throw new Error("corrupt page should fail");
    }, (item) => item);
    const after = await store.migrationStatus();
    assert.equal(after.errors.some((item) => item.docHash === "bad" && item.reason === "corrupt"), true);
    assert.equal(after.errors.some((item) => item.reason === "blocked"), false);
  } finally {
    try { held?.close(); } catch { /* already closed */ }
    await factory.close?.(NOTES_DB_NAME);
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(NOTES_DB_NAME);
      const timer = setTimeout(() => reject(new Error("deleteDatabase blocked")), 1000);
      request.onsuccess = () => {
        clearTimeout(timer);
        resolve();
      };
      request.onerror = () => {
        clearTimeout(timer);
        reject(request.error || new Error("deleteDatabase failed"));
      };
    });
  }
});

test("F4-17 product files do not take a new library entry, and settled pairs still win", () => {
  const viewer = read("pdf/viewer.js");
  const library = read("lib/pdf-library.js");
  const store = read("lib/library-store.js");
  assert.equal(viewer.includes("createLibraryStore"), false);
  assert.equal(library.includes("createLibraryStore"), false);
  assert.equal(store.includes("indexedDB.open"), false);
  assert.equal(store.includes("127.0.0.1:8765"), false);
  assert.equal(store.includes("IDBKeyRange"), false);
  assert.equal(store.includes(LIBRARY_PERSIST_HINT_KEY) || store.includes("library.persistHintDismissed"), true);
  const kept = mergeLibraryPairs(
    [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "你好", targetLang: "zh-CN" }],
    [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "", targetLang: "zh-CN" }],
    [{ bid: "a", text: "Hello", sourceText: "Hello" }],
    "zh-CN"
  );
  assert.equal(kept[0].translation, "你好");
  assert.equal(storedLayoutCurrent({
    blocks: [{ bid: "b" }],
    layoutVersion: "same"
  }, "same")?.blocks.length, 1);
});

test("DBB chip: blocked copy, manual retry, fallback poll, and recovery", async () => {
  globalThis.BroadcastChannel = class {
    postMessage() {}
    close() {}
    set onmessage(_value) {}
  };
  const timers = createTimers();
  const host = dom.document.createElement("div");
  dom.body.append(host);
  let opens = 0;
  let fail = true;
  let notes = 0;
  const recovered = [];
  const chip = createLibraryChip({
    host,
    timers,
    pollMs: 100000,
    manualRetryMs: 80,
    recoverMs: 30,
    fadeMs: 10,
    minDisableMs: 15,
    openStorage: async () => {
      opens += 1;
      if (fail) throw blockedError("timeout", Date.parse("2026-10-13T08:05:00"));
      return true;
    },
    flushNotes: async () => {
      notes = 2;
      return 2;
    },
    flushPages: async () => 1,
    onRecovered(info) { recovered.push(info.notes); }
  });
  chip.block(blockedError("timeout", Date.parse("2026-10-13T08:05:00")));
  assert.equal(host.hidden, false);
  assert.match(dom.text(host), new RegExp(BLOCKED_CHIP));
  assert.match(dom.text(host), /暂时存不了。已经存好的译文和笔记都还在/);
  assert.equal(host.querySelector(".oi-lib-chip").getAttribute("aria-label").includes("已存好的内容没丢"), true);
  dom.click(host.querySelector(".oi-lib-chip"));
  const pop = host.querySelector("[role='dialog']");
  assert.ok(pop);
  assert.equal(pop.getAttribute("aria-modal"), null);
  assert.match(dom.text(pop), new RegExp(BLOCKED_SAFE_LINE));
  assert.match(dom.text(pop), /从 08:05 起/);
  assert.match(dom.text(pop), /10 秒/);
  assert.match(dom.text(pop), /现在可以：/);
  assert.match(dom.text(pop), new RegExp(BLOCKED_CAN));
  assert.match(dom.text(pop), new RegExp(BLOCKED_CANNOT));
  assert.match(dom.text(pop), /每 5 秒自动再试/);
  assert.doesNotMatch(dom.text(pop), /被其他页面占用|电脑慢/);
  const retry = findButton(pop, "重试");
  dom.click(retry);
  await tick();
  assert.equal(host.querySelector(".oi-lib-primary").disabled, true);
  assert.match(dom.text(host), /正在重试…/);
  timers.advance(20);
  await tick();
  assert.match(host.querySelector(".oi-lib-fail").textContent, /又试了一次，还是没打开（/);
  assert.doesNotMatch(host.querySelector(".oi-lib-fail").textContent, /可以重启浏览器/);
  dom.click(findButton(host, "重试"));
  await tick();
  timers.advance(20);
  await tick();
  dom.click(findButton(host, "重试"));
  await tick();
  timers.advance(20);
  await tick();
  assert.match(dom.text(host), /可以重启浏览器/);
  assert.doesNotMatch(dom.text(host), /页面|标签页/);
  const failLine = dom.text(host);
  assert.match(failLine, /又试了一次/);
  fail = false;
  const before = chip.opens();
  await chip.autoRetry();
  await tick();
  assert.ok(chip.opens() >= before);
  assert.equal(recovered[0], 2);
  assert.equal(notes, 2);
  assert.match(dom.text(host), /已恢复 · 存好 2 条笔记/);
  timers.advance(30);
  await tick();
  assert.match(dom.text(host), /已恢复/);
  timers.advance(10);
  await tick();
  assert.equal(host.hidden, true);
  chip.destroy();
});

test("DBB chip treats a real blocked holder, a narrow sheet, and a migration return differently", async () => {
  const timers = createTimers();
  const host = dom.document.createElement("div");
  dom.body.append(host);
  let narrow = true;
  const chip = createLibraryChip({
    host,
    timers,
    narrow: () => narrow,
    pollMs: 1000,
    manualRetryMs: 1000,
    minDisableMs: 0,
    openStorage: async () => {
      throw blockedError("blocked");
    }
  });
  chip.block(blockedError("blocked", Date.parse("2026-10-13T09:10:00")));
  dom.click(host.querySelector(".oi-lib-chip"));
  assert.match(dom.text(host), /哪些功能受影响/);
  assert.doesNotMatch(dom.text(host), /现在可以/);
  dom.click(findButton(host, "哪些功能受影响"));
  assert.match(dom.text(host), /现在可以/);
  assert.match(dom.text(host), /暂时不行/);
  assert.match(dom.text(host), /关掉或刷新其他 Open Immerse 页面/);
  assert.doesNotMatch(dom.text(host), /电脑这会儿读写比较慢/);
  dom.dispatch("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(host.querySelector("[role='dialog']"), null);
  assert.equal(host.querySelector(".oi-lib-chip").focused, true);
  narrow = false;
  chip.setMigration({ running: true, done: 1, total: 4 });
  chip.block(blockedError("blocked"));
  assert.match(dom.text(host), new RegExp(BLOCKED_CHIP));
  chip.recover();
  await tick();
  assert.match(dom.text(host), /正在搬旧库 1\/4/);
  assert.doesNotMatch(dom.text(host), /已恢复/);
  chip.destroy();
});

test("DBB moving chip and write-failure chip", async () => {
  const timers = createTimers();
  const host = dom.document.createElement("div");
  dom.body.append(host);
  const chip = createLibraryChip({
    host,
    timers,
    moveDelayMs: 20,
    openStorage: async () => true
  });
  chip.startMove({ holds: true });
  assert.equal(host.querySelector(".oi-lib-chip"), null);
  timers.advance(20);
  assert.equal(host.hidden, false);
  assert.match(dom.text(host), /正在搬这篇…/);
  const button = host.querySelector(".oi-lib-chip");
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.equal(button.getAttribute("title"), MOVE_CHIP_TITLE);
  dom.click(button);
  assert.equal(host.querySelector("[role='dialog']"), null);
  chip.finishMove();
  assert.equal(host.hidden, true);
  chip.startMove({ holds: false });
  timers.advance(20);
  assert.equal(host.hidden, true);
  const quota = new Error("full");
  quota.type = "quota";
  chip.writeFailed(quota);
  assert.match(dom.text(host), new RegExp(WRITE_FAIL_CHIP));
  dom.click(host.querySelector(".oi-lib-chip"));
  assert.match(dom.text(host), new RegExp(WRITE_FAIL_SAFE));
  assert.match(dom.text(host), /空间不够/);
  chip.writeFailed(blockedError("blocked"));
  assert.match(dom.text(host), new RegExp(BLOCKED_CHIP));
  chip.destroy();
});

test("DBB reduced motion drops the fade, and a hidden page does not poll", async () => {
  const timers = createTimers();
  const host = dom.document.createElement("div");
  dom.body.append(host);
  let visible = false;
  const chip = createLibraryChip({
    host,
    timers,
    visible: () => visible,
    reducedMotion: () => true,
    pollMs: 25,
    recoverMs: 40,
    fadeMs: 80,
    openStorage: async () => true,
    flushNotes: async () => 0
  });
  chip.block(blockedError("timeout"));
  const before = chip.opens();
  timers.advance(25);
  await tick();
  assert.equal(chip.opens(), before);
  visible = true;
  timers.advance(25);
  await tick();
  assert.ok(chip.opens() > before);
  await tick();
  assert.match(dom.text(host), /已恢复/);
  timers.advance(40);
  await tick();
  assert.equal(host.hidden, true);
  chip.destroy();
});

test("DBB pending notes are split by tab, warn on unload, and flush in order", async () => {
  const a = createPendingNotes({ tabId: "tab-a", now: () => 10 });
  const b = createPendingNotes({ tabId: "tab-b", now: () => 11 });
  const storage = a;
  await a.stage("doc-1", { body: "甲", kind: "note", page: 1 });
  await b.stage("doc-1", { body: "乙", kind: "note", page: 1 });
  await a.stage("doc-2", { body: "丙", kind: "question", page: 2 });
  assert.equal(a.pendingNow("doc-1"), 1);
  assert.deepEqual((await a.list("doc-1")).map((row) => row.body), ["甲"]);
  assert.deepEqual((await b.list("doc-1")).map((row) => row.body), ["乙"]);
  assert.equal((await a.list("doc-2"))[0].kind, "question");
  const target = dom.document.createElement("div");
  let warned = false;
  target.addEventListener = (type, fn) => {
    target.handler = fn;
    target.type = type;
  };
  bindPendingUnload(() => storage.pendingNow("doc-1"), target);
  const event = { preventDefault() { warned = true; }, returnValue: undefined };
  target.handler(event);
  assert.equal(warned, true);
  assert.equal(event.returnValue, "");
  const saved = [];
  const count = await a.flush("doc-1", async (item) => {
    saved.push(item.body);
  });
  assert.equal(count, 1);
  assert.deepEqual(saved, ["甲"]);
  assert.equal(a.pendingNow("doc-1"), 0);
  const quiet = { preventDefault() { throw new Error("no pending"); }, returnValue: "x" };
  target.handler(quiet);
  assert.equal(quiet.returnValue, "x");
  assert.match(pendingNotesKey("doc-1"), /^oi-notes-pending:doc-1$/);
});

test("persist card is one shared prompt and uses the library dismiss key", () => {
  const host = dom.document.createElement("div");
  dom.body.append(host);
  const calls = [];
  const card = createPersistCard({
    host,
    onDismiss: () => calls.push("dismiss"),
    onHideSession: () => calls.push("session"),
    onExport: () => calls.push("export")
  });
  assert.equal(card.key, LIBRARY_PERSIST_HINT_KEY);
  assert.equal(card.key, "library.persistHintDismissed");
  assert.equal(PERSIST_CARD_SESSION_KEY, "oiPersistCardHidden");
  card.show();
  assert.equal(host.querySelector("[role='status']") != null, true);
  assert.match(dom.text(host), new RegExp(PERSIST_CARD_TITLE));
  assert.match(dom.text(host), new RegExp(PERSIST_CARD_BODY));
  dom.click(findButton(host, "导出备份"));
  dom.click(findButton(host, "不再提示"));
  assert.deepEqual(calls, ["export", "dismiss"]);
  assert.equal(card.isOpen(), false);
  card.show();
  dom.click(host.querySelector("[aria-label='关闭']"));
  assert.deepEqual(calls, ["export", "dismiss", "session"]);
  const viewer = read("pdf/viewer.js");
  assert.match(viewer, /sharedPersistCard:\s*true/);
  assert.doesNotMatch(viewer, /requestPersist\(\)/);
});

test("notes panel stages a blocked write, locks destructive actions, and skips the per-doc persist line", async () => {
  const staged = [];
  const deleted = [];
  let blockedHits = 0;
  const secret = new Error("SECRET-MESSAGE");
  secret.name = "BlockedError";
  secret.cause = "blocked";
  const ui = mountNotesUi({
    hasDoc: () => true,
    docHash: () => "doc-notes",
    docTitle: () => "笔记",
    list: async () => [{
      id: "n1",
      kind: "note",
      author: "me",
      body: "已有",
      page: 1,
      updatedAt: 20,
      anchor: { bid: "a" },
      anchorState: { status: "exact" }
    }],
    listTrash: async () => [],
    put: async () => {
      throw secret;
    },
    stageNote: async (input) => {
      staged.push(input.body);
      return { id: "tmp-1", pending: true, updatedAt: Date.parse("2026-10-13T10:15:00"), body: input.body, kind: input.kind };
    },
    onStorageBlocked() { blockedHits += 1; },
    sharedPersistCard: true,
    persistDenied: async () => true,
    softDelete: async (id) => { deleted.push(id); },
    currentParagraph: () => ({ bid: "a", page: 1, translation: "甲", preview: "甲" }),
    flow: () => null,
    pane: () => null,
    pointerFine: () => true,
    blockOrder: () => new Map(),
    readPrefs: () => ({}),
    subscribe: () => () => {}
  });
  assert.ok(ui);
  ui.open();
  await tick();
  await tick();
  ui.setStorageState({ blocked: true, cause: "blocked" });
  const tree = dom.text(dom.slot);
  assert.match(tree, /暂时存不了/);
  assert.match(tree, /关掉其他 Open Immerse 页面后会自动恢复/);
  assert.doesNotMatch(tree, /SECRET-MESSAGE/);
  assert.doesNotMatch(tree, /本文档不再提示/);
  const remove = findButton(dom.slot, "删除");
  assert.equal(remove.getAttribute("aria-disabled"), "true");
  assert.match(remove.title, /恢复后可用/);
  dom.click(remove);
  assert.deepEqual(deleted, []);
  const edit = findButton(dom.slot, "编辑");
  assert.equal(edit.getAttribute("aria-disabled"), null);
  dom.click(edit);
  const field = dom.slot.querySelector("textarea");
  field.value = "先写在本页";
  field.dispatchEvent({ type: "input" });
  field.dispatchEvent({
    type: "keydown",
    key: "Enter",
    ctrlKey: true,
    preventDefault() {},
    stopPropagation() {}
  });
  await tick();
  await tick();
  assert.deepEqual(staged, ["先写在本页"]);
  assert.match(dom.text(dom.slot), /还没存上 · 已暂存在本页/);
  assert.match(dom.text(dom.slot), /10:15/);
  assert.equal(blockedHits >= 1, true);
  const add = findButton(dom.slot, "＋ 给当前段写笔记");
  assert.equal(add.disabled, false);
  ui.setStorageState(null);
  assert.equal(dom.slot.querySelector(".oi-store-banner"), null);
});

test("notes panel shows the unread empty state and does not put the blocked message in a failure banner", async () => {
  const secret = new Error("SECRET-UNREAD");
  secret.name = "BlockedError";
  secret.cause = "timeout";
  const ui = mountNotesUi({
    hasDoc: () => true,
    docHash: () => "doc-empty",
    docTitle: () => "空",
    list: async () => {
      throw secret;
    },
    listTrash: async () => [],
    put: async () => ({}),
    sharedPersistCard: true,
    persistDenied: async () => false,
    flow: () => null,
    pane: () => null,
    pointerFine: () => true,
    blockOrder: () => new Map(),
    readPrefs: () => ({}),
    subscribe: () => () => {}
  });
  ui.open();
  await tick();
  await tick();
  const tree = dom.text(dom.slot);
  assert.match(tree, /笔记暂时读不出来，恢复后会自动显示/);
  assert.match(tree, /你仍然可以先写新笔记/);
  assert.doesNotMatch(tree, /SECRET-UNREAD/);
  assert.match(tree, /电脑这会儿读写比较慢|打开存储超过了|新写和修改的笔记先暂存在本页/);
});

test("a manual retry replaces the failure reason with the new error", async () => {
  globalThis.BroadcastChannel = class {
    postMessage() {}
    close() {}
    set onmessage(_value) {}
  };
  const timers = createTimers();
  const host = dom.document.createElement("div");
  dom.body.append(host);
  let cause = "timeout";
  const chip = createLibraryChip({
    host,
    timers,
    pollMs: 100000,
    manualRetryMs: 80,
    minDisableMs: 15,
    openStorage: async () => {
      throw blockedError(cause, Date.parse("2026-10-13T08:05:00"));
    }
  });
  chip.block(blockedError("timeout", Date.parse("2026-10-13T08:05:00")));
  dom.click(host.querySelector(".oi-lib-chip"));
  assert.match(dom.text(host.querySelector(".oi-lib-reason")), /电脑这会儿读写比较慢/);
  cause = "blocked";
  dom.click(findButton(host, "重试"));
  await tick();
  timers.advance(20);
  await tick();
  assert.match(dom.text(host.querySelector(".oi-lib-reason")), /另一个 Open Immerse 页面/);
  assert.doesNotMatch(dom.text(host.querySelector(".oi-lib-reason")), /电脑慢/);
});

test("reader warn contrast stays at least 4.5 on every theme, and dark uses #E2A86A", () => {
  const css = read("pdf/reader-tokens.css");
  assert.match(css, /--oi-reader-warn:\s*#8A4B0F/i);
  const dark = css.slice(css.indexOf('[data-reader-theme="dark"]'));
  assert.match(dark, /--oi-reader-warn:\s*#E2A86A/i);
  assert.match(dark, /--oi-reader-warn-soft:\s*rgba\(226,\s*168,\s*106,\s*0?\.14\)/i);
  assert.match(dark, /--oi-reader-paper:\s*#1C1D1F/i);
  assert.match(dark, /--oi-reader-surface:\s*#232427/i);
  assert.match(dark, /--oi-reader-ink-2:\s*#C8C4BA/i);
  assert.match(dark, /--oi-reader-panel-shadow:[^;]*rgba\(0,\s*0,\s*0,\s*(?:0)?\.6\)/);
  assert.match(dark, /--oi-reader-panel-shadow:[^;]*rgba\(0,\s*0,\s*0,\s*(?:0)?\.3\)/);
  const beforeDark = css.slice(0, css.indexOf('[data-reader-theme="dark"]'));
  assert.doesNotMatch(beforeDark, /#232427/i);
  assert.doesNotMatch(beforeDark, /rgba\(0,\s*0,\s*0,\s*(?:0)?\.6\)/);
  const themes = {
    warm: { paper: "#F6F3EC", surface: "#FCFAF6", well: "#ECE9E2", ink: "#22201C", ink2: "#4A463E", warn: "#8A4B0F" },
    white: { paper: "#FFFFFF", surface: "#FFFFFF", well: "#F1F1EF", ink: "#1F1F1F", ink2: "#454545", warn: "#8A4B0F" },
    sepia: { paper: "#ECE7DD", surface: "#F4F0E9", well: "#E2DCD0", ink: "#26221C", ink2: "#463F35", warn: "#8A4B0F" },
    green: { paper: "#E8EDE6", surface: "#F2F5F0", well: "#DDE3DA", ink: "#1E2420", ink2: "#3E4740", warn: "#8A4B0F" },
    dark: { paper: "#1C1D1F", surface: "#232427", well: "#2A2B2E", ink: "#E8E6E1", ink2: "#C8C4BA", muted: "#A8A49B", warn: "#E2A86A", focus: "#8FA8FF" }
  };
  const rows = [];
  for (const [name, theme] of Object.entries(themes)) {
    for (const ground of ["paper", "surface", "well"]) {
      const ratio = contrast(theme.warn, theme[ground]);
      rows.push([name, ground, ratio]);
      assert.ok(ratio >= 4.5, `${name} warn on ${ground} ${ratio.toFixed(2)}`);
      const inkRatio = contrast(theme.ink, theme[ground]);
      rows.push([name, `ink/${ground}`, inkRatio]);
      assert.ok(inkRatio >= 4.5, `${name} ink on ${ground} ${inkRatio.toFixed(2)}`);
      const ink2Ratio = contrast(theme.ink2, theme[ground]);
      rows.push([name, `ink2/${ground}`, ink2Ratio]);
      assert.ok(ink2Ratio >= 4.5, `${name} ink-2 on ${ground} ${ink2Ratio.toFixed(2)}`);
    }
  }
  const darkTheme = themes.dark;
  const softOn = {
    surface: composite([226, 168, 106, 0.14], darkTheme.surface),
    paper: composite([226, 168, 106, 0.14], darkTheme.paper),
    well: composite([226, 168, 106, 0.14], darkTheme.well)
  };
  const dks = [
    ["ink/paper", darkTheme.ink, darkTheme.paper],
    ["ink/surface", darkTheme.ink, darkTheme.surface],
    ["ink/well", darkTheme.ink, darkTheme.well],
    ["ink-2/paper", darkTheme.ink2, darkTheme.paper],
    ["ink-2/surface", darkTheme.ink2, darkTheme.surface],
    ["ink-2/well", darkTheme.ink2, darkTheme.well],
    ["muted/surface", darkTheme.muted, darkTheme.surface],
    ["muted/well", darkTheme.muted, darkTheme.well],
    ["warn/surface", darkTheme.warn, darkTheme.surface],
    ["warn/paper", darkTheme.warn, darkTheme.paper],
    ["warn/warn-soft on surface", darkTheme.warn, softOn.surface],
    ["warn/warn-soft on paper", darkTheme.warn, softOn.paper],
    ["warn/warn-soft on well", darkTheme.warn, softOn.well],
    ["ink/warn-soft on surface", darkTheme.ink, softOn.surface]
  ];
  for (const [name, foreground, background] of dks) {
    const ratio = contrast(foreground, background);
    assert.ok(ratio >= 4.5, `DKS ${name} ${ratio.toFixed(2)}`);
  }
  assert.ok(contrast(darkTheme.focus, darkTheme.surface) >= 3, "focus ring on surface");
  const lightSoft = composite([138, 75, 15, 0.08], "#F6F3EC");
  assert.ok(contrast("#8A4B0F", lightSoft) >= 4.5);
  assert.ok(rows.length >= 15);
  const viewerCss = read("pdf/viewer.css");
  const notesCss = read("pdf/notes-panel.css");
  for (const selector of [".aa-panel", ".oi-lib-pop", ".oi-persist-card", ".more-menu"]) {
    const rule = viewerCss.slice(viewerCss.indexOf(selector));
    assert.match(rule, /border:\s*(?:var\(--oi-reader-panel-border\)|1px solid var\(--oi-reader-line\))/);
    assert.match(rule, /box-shadow:\s*var\(--oi-reader-p(?:anel|opover)-shadow/);
    assert.match(rule, /background:\s*var\(--oi-reader-surface\)/);
  }
  assert.match(notesCss, /#sideSlot[\s\S]*background:\s*var\(--oi-reader-surface\)/);
  assert.match(notesCss, /\.oi-note-card\.is-paperNote[\s\S]*border:\s*1px solid var\(--oi-reader-line\)/);
  const darkCard = notesCss.slice(notesCss.indexOf('[data-reader-theme="dark"] .oi-note-card {'));
  assert.match(darkCard, /border:\s*1px solid var\(--oi-reader-line\)/);
  assert.match(darkCard, /border-radius:\s*8px/);
  const darkHover = notesCss.slice(notesCss.indexOf('[data-reader-theme="dark"] .oi-note-card:hover'));
  assert.match(darkHover, /border-radius:\s*8px/);
  assert.doesNotMatch(darkHover.slice(0, darkHover.indexOf("}")), /0 8px 8px 0/);
  assert.match(notesCss, /\n\.oi-note-card:hover \{\n  background: var\(--oi-reader-hover\);\n  border-radius: 0 8px 8px 0;\n\}/);
  assert.match(notesCss, /\[data-reader-theme="dark"\] \.workspace\[data-notes-open="true"\] > #sideSlot[\s\S]*border-inline-start:\s*1px solid var\(--oi-reader-line\)/);
  assert.match(notesCss, /\[data-notes-side="start"\] > #sideSlot[\s\S]*border-inline-end:\s*1px solid var\(--oi-reader-line\)/);
  const tokens = read("pdf/reader-tokens.css");
  const darkBlock = tokens.slice(tokens.indexOf('[data-reader-theme="dark"]'));
  assert.match(darkBlock, /--oi-reader-panel-shadow:\s*0 18px 40px -12px rgba\(0, 0, 0, 0\.6\), 0 2px 8px rgba\(0, 0, 0, 0\.3\)/);
  assert.match(darkBlock, /--oi-reader-popover-shadow:\s*var\(--oi-reader-panel-shadow\)/);
  assert.match(notesCss, /\.oi-store-banner[\s\S]*border-left:\s*3px solid var\(--oi-reader-warn\)/);
  assert.match(notesCss, /\.oi-store-banner[\s\S]*background:\s*var\(--oi-reader-warn-soft\)/);
  const chipRule = viewerCss.slice(viewerCss.indexOf(".toolbar button.oi-lib-chip {"), viewerCss.indexOf(".toolbar button.oi-lib-chip:hover"));
  assert.match(chipRule, /background:\s*var\(--oi-reader-well\)/);
  assert.doesNotMatch(chipRule, /box-shadow/);
  assert.doesNotMatch(chipRule, /(^|\n)\s*border\s*:/);
  const narrowChip = viewerCss.slice(viewerCss.indexOf("@media (max-width: 719px)"));
  assert.match(narrowChip, /\.toolbar button\.oi-lib-chip \{[^}]*min-width:\s*26px/);
});

test("a retranslated pair replaces a stored pair whose formula slots do not line up", async () => {
  const { store } = memoryStore({
    mergePairs: (existing, incoming, blocks, lang) => mergeStoredPagePairs(existing, incoming, blocks, lang)
  });
  const block = {
    bid: "b-mis",
    sourceId: "p18-s1",
    label: "text",
    text: "see ⟦f1⟧ and ⟦f2⟧",
    sourceText: "see ALPHA and BETA"
  };
  await saveLibraryPage({
    hash: "doc-slots",
    title: "槽",
    pageCount: 1,
    page: 1,
    pairs: [{
      bid: "b-mis",
      sourceId: "p18-s1",
      text: "see ⟦f9⟧ and BETA",
      sourceText: "see ALPHA and BETA",
      translation: "见⟦f9⟧和乙",
      targetLang: "zh-CN",
      provider: "mymemory"
    }]
  }, { store });
  await saveLibraryPage({
    hash: "doc-slots",
    page: 1,
    pairs: [{
      bid: "b-mis",
      text: block.text,
      sourceText: block.sourceText,
      translation: "见甲⟦f1⟧和乙⟦f2⟧",
      targetLang: "zh-CN",
      provider: "mymemory"
    }],
    blocks: [block],
    targetLang: "zh-CN"
  }, { store });
  const page = await store.getPage("doc-slots", 1);
  assert.equal(page.pairs[0].translation, "见甲⟦f1⟧和乙⟦f2⟧");
  assert.match(read("lib/library-session.js"), /mergeStoredPagePairs/);
});

test("a blocked page write is queued and a blocked flush puts the rest back", async () => {
  const { store } = memoryStore();
  let blocked = true;
  const original = store.putPage.bind(store);
  store.putPage = async (...args) => {
    if (blocked) throw blockedError("blocked");
    return original(...args);
  };
  await assert.rejects(
    saveLibraryPage({
      hash: "pend",
      title: "待存",
      pageCount: 1,
      page: 1,
      pairs: [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "你好", targetLang: "zh-CN" }]
    }, { store }),
    (error) => error.name === "BlockedError"
  );
  blocked = false;
  const saved = await flushPendingPages({ store });
  assert.equal(saved, 1);
  assert.equal((await store.getPage("pend", 1)).pairs[0].translation, "你好");
});

test("oiStoredLibraryPages throws when the library read fails", async () => {
  const source = storedLibraryPagesSource();
  assert.match(source, /async function oiStoredLibraryPages/);
  assert.doesNotMatch(source, /catch\s*\{/);
  const readPages = new Function(`${source}\nreturn oiStoredLibraryPages;`)();
  await assert.rejects(readPages());
});

test("zoning waits only for the IndexedDB read", { timeout: 15000 }, async () => {
  const version = "rev-zone";
  const retryMs = LIBRARY_PROBE_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  assert.equal(LIBRARY_ZONE_WAIT_MS, 300);
  assert.equal(retryMs, 3200);

  const emptyStore = {
    async getPaper() { return null; }
  };
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Promise(() => {});
  };
  let legacyDownMs = 0;
  try {
    const started = performance.now();
    const gate = await waitForFirstZone("zone-down", { store: emptyStore });
    legacyDownMs = performance.now() - started;
    assert.equal(gate.reason, "stored");
    assert.equal(gate.document, null);
    assert.equal(fetches, 0);
    assert.ok(legacyDownMs < 80, `8765 down delayed zoning by ${legacyDownMs}ms`);
    assert.ok(legacyDownMs < retryMs / 10, legacyDownMs);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const slowHash = "zone-slow";
  const slowStore = {
    async getPaper() {
      await new Promise((resolve) => setTimeout(resolve, LIBRARY_ZONE_WAIT_MS + 500));
      return { docHash: slowHash, title: "slow", pageCount: 1, origin: "native" };
    },
    async getPages() {
      return [{ page: 1, pairs: [], layoutVersion: version }];
    },
    async listLayouts() {
      return [{
        page: 1,
        savedAt: 5,
        layout: {
          blocks: [{ bid: "kept", text: "current" }],
          layoutVersion: version,
          protocol: "blocks-1"
        }
      }];
    }
  };
  const slowStarted = performance.now();
  const slowGate = await waitForFirstZone(slowHash, { store: slowStore });
  const slowIdbMs = performance.now() - slowStarted;
  assert.equal(slowGate.reason, "cap");
  assert.equal(slowGate.document, null);
  assert.ok(slowIdbMs >= LIBRARY_ZONE_WAIT_MS - 40, slowIdbMs);
  assert.ok(slowIdbMs < LIBRARY_ZONE_WAIT_MS + 180, `slow IDB delayed zoning by ${slowIdbMs}ms`);
  assert.equal(currentLayoutIfArrived({ hash: slowHash, page: 1, version }), null);
  let slowWrites = 0;
  const slowSettled = await settleFreshZone({
    hash: slowHash,
    page: 1,
    version,
    reason: slowGate.reason,
    write: async () => { slowWrites += 1; }
  });
  assert.equal(slowSettled.deferred, true);
  assert.equal(slowSettled.recomputed, false);
  assert.equal(slowWrites, 0);
  await whenZoneReadSettles(slowHash);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(slowWrites, 0);
  const arrived = currentLayoutIfArrived({ hash: slowHash, page: 1, version });
  assert.equal(arrived.blocks[0].bid, "kept");
  assert.equal(preferArrivedLayout({ blocks: [{ bid: "fresh" }], layoutVersion: version }, arrived).recomputed, false);

  const fastHash = "zone-fast";
  const fastStore = {
    async getPaper() {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { docHash: fastHash, title: "fast", pageCount: 1, origin: "native" };
    },
    async getPages() {
      return [{ page: 1, pairs: [], layoutVersion: version }];
    },
    async listLayouts() {
      return [{
        page: 1,
        savedAt: 1,
        layout: {
          blocks: [{ bid: "kept", text: "current" }],
          layoutVersion: version,
          protocol: "blocks-1"
        }
      }];
    }
  };
  const fastStarted = performance.now();
  const fastGate = await waitForFirstZone(fastHash, { store: fastStore });
  const fastIdbMs = performance.now() - fastStarted;
  assert.equal(fastGate.reason, "stored");
  assert.ok(fastIdbMs >= 60, fastIdbMs);
  assert.ok(fastIdbMs < LIBRARY_ZONE_WAIT_MS, fastIdbMs);
  assert.equal(storedLayoutCurrent(fastGate.document.pages[0], version).blocks[0].bid, "kept");

  const emptyHash = "zone-empty-slow";
  let emptyWrites = 0;
  const emptyGate = await waitForFirstZone(emptyHash, {
    store: {
      async getPaper() {
        await new Promise((resolve) => setTimeout(resolve, LIBRARY_ZONE_WAIT_MS + 80));
        return null;
      }
    }
  });
  assert.equal(emptyGate.reason, "cap");
  await settleFreshZone({
    hash: emptyHash,
    page: 1,
    version,
    reason: emptyGate.reason,
    write: async () => { emptyWrites += 1; }
  });
  assert.equal(emptyWrites, 0);
  await whenZoneReadSettles(emptyHash);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(emptyWrites, 1);

  const hangStarted = performance.now();
  const hangGate = await waitForFirstZone("zone-hang", {
    store: {
      getPaper() {
        return new Promise(() => {});
      }
    }
  });
  const blockedHangMs = performance.now() - hangStarted;
  assert.equal(hangGate.reason, "cap");
  assert.equal(hangGate.document, null);
  assert.ok(blockedHangMs >= LIBRARY_ZONE_WAIT_MS - 40, blockedHangMs);
  assert.ok(blockedHangMs < 1000, `blocked hang delayed zoning by ${blockedHangMs}ms`);

  const held = hangingFactory();
  const pendingOpen = openIndexedDatabase({
    name: NOTES_DB_NAME,
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 10000
  });
  let blockedKnownMs = 0;
  try {
    held.req.onblocked();
    assert.equal(storageOpenIsBlocked(NOTES_DB_NAME), true);
    let reads = 0;
    const knownStarted = performance.now();
    const known = await waitForFirstZone("zone-blocked", {
      store: {
        getPaper() {
          reads += 1;
          return new Promise(() => {});
        }
      },
      layoutRead() {
        reads += 1;
        return new Promise(() => {});
      }
    });
    blockedKnownMs = performance.now() - knownStarted;
    assert.equal(known.reason, "unavailable");
    assert.equal(known.document, null);
    assert.equal(reads, 0);
    assert.ok(blockedKnownMs < 50, `known blocked store delayed zoning by ${blockedKnownMs}ms`);
    const settled = await settleFreshZone({
      hash: "zone-blocked",
      page: 1,
      version,
      reason: known.reason,
      write: () => new Promise(() => {})
    });
    assert.equal(settled.deferred, true);
    assert.equal(settled.recomputed, false);
  } finally {
    held.req.result = { close() {} };
    held.req.onsuccess();
    await pendingOpen;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const viewer = read("pdf/viewer.js");
  const fn = viewer.slice(
    viewer.indexOf("async function ingestVendorLayout"),
    viewer.indexOf("async function ingestSkippedSourceLayout")
  );
  assert.doesNotMatch(fn, /await ensureLibraryDocument\(\)/);
  assert.match(fn, /void ensureLibraryDocument\(\)/);
  assert.match(fn, /waitForFirstZone/);
  assert.match(fn, /waitForZoneMigration/);
  assert.ok(fn.indexOf("waitForZoneMigration") < fn.indexOf("postVendorLayout"));
  assert.match(fn, /stampProducedEngine\(mapped, mode\)/);
  assert.match(fn, /settleFreshZone/);
  assert.match(fn, /currentLayoutIfArrived/);
  const savedFn = viewer.slice(
    viewer.indexOf("async function savedTranslationFor"),
    viewer.indexOf("function savedPageStatus")
  );
  assert.match(savedFn, /waitForFirstZone/);
  assert.match(savedFn, /translationWaitsForLibrary/);
  assert.match(savedFn, /if \(!libraryProbe\) void ensureLibraryDocument\(\)/);
  assert.match(savedFn, /waitForZoneMigration/);
  assert.doesNotMatch(savedFn, /await ensureLibraryDocument\(\)/);
  assert.doesNotMatch(savedFn, /await libraryProbe/);

  console.log(`[zone-delay] blockedKnown=${blockedKnownMs.toFixed(1)}ms blockedHang=${blockedHangMs.toFixed(1)}ms legacyDown=${legacyDownMs.toFixed(1)}ms slowIdb=${slowIdbMs.toFixed(1)}ms fastIdb=${fastIdbMs.toFixed(1)}ms`);
});

test("two tabs deliver a note once, deduped by sender id and seq", async () => {
  const ports = [];
  function connect() {
    const port = { accept: null };
    ports.push(port);
    return {
      post(message) {
        for (const other of ports) {
          if (other === port || typeof other.accept !== "function") continue;
          void other.accept(message);
        }
      },
      receive(accept) {
        port.accept = accept;
      }
    };
  }
  const left = connect();
  const right = connect();
  const notesA = createNotesStore({ persist: false, now: () => 11, createId: () => "note-a" });
  const notesB = createNotesStore({ persist: false, now: () => 12, createId: () => "note-b" });
  const sessionA = createLibrarySession({
    notes: notesA,
    channel: false,
    post: left.post,
    receive: left.receive
  });
  const sessionB = createLibrarySession({
    notes: notesB,
    channel: false,
    post: right.post,
    receive: right.receive
  });
  assert.notEqual(sessionA.senderId, sessionB.senderId);
  await notesA.put({ docHash: "doc-sync", kind: "note", author: "me", body: "from A", page: 1 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const seen = await notesB.list("doc-sync");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, "from A");
  let refreshes = 0;
  const original = notesB.refreshDoc.bind(notesB);
  notesB.refreshDoc = async (...args) => {
    refreshes += 1;
    return original(...args);
  };
  const echoed = { collection: "notes", docHash: "doc-sync", senderId: sessionA.senderId, seq: 1 };
  assert.equal(await sessionB.accept(echoed), false);
  assert.equal(await sessionA.accept(echoed), false);
  assert.equal(refreshes, 0);
  assert.equal((await notesB.list("doc-sync")).length, 1);
});

test("the library persist card uses only library.persistHintDismissed", async () => {
  const data = { libraryPersistGranted: false };
  const local = {
    async get(keys) {
      if (this !== local) throw new TypeError("Illegal invocation");
      const out = {};
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
      }
      return out;
    }
  };
  const shown = await readPersistCardState(local, "doc-1");
  assert.equal(shown.show, true);
  assert.equal(shown.dismissed, false);
  data[`${NOTES_HINT_DOC_PREFIX}doc-1`] = true;
  data[NOTES_PERSIST_HINT_KEY] = JSON.stringify({ "doc-1": true, "doc-2": true });
  const ignored = await readPersistCardState(local, "doc-1");
  assert.equal(ignored.show, true);
  assert.equal(ignored.dismissed, false);
  data[LIBRARY_PERSIST_HINT_KEY] = true;
  const dismissed = await readPersistCardState(local, "doc-2");
  assert.equal(dismissed.show, false);
  assert.equal(dismissed.dismissed, true);
  delete data[LIBRARY_PERSIST_HINT_KEY];
  data.libraryPersistGranted = true;
  assert.equal((await readPersistCardState(local, "doc-1")).show, false);
});

test("a note staged in a closed tab is written on the next open", async () => {
  const data = new Map();
  const storage = {
    async get(key) { return data.has(key) ? data.get(key) : null; },
    async set(key, value) { data.set(key, value); }
  };
  const closed = createPendingNotes({ storage, tabId: () => "tab-old" });
  await closed.stage("paper", { body: "关页前写的" });
  const reopened = createPendingNotes({ storage, tabId: () => "tab-new" });
  assert.equal((await reopened.list("paper")).length, 0);
  const store = createNotesStore({ memory: true, persist: false, now: () => 20, createId: () => "staged-1" });
  const saved = await reopened.flush("paper", (item) => store.put(item), { allTabs: true });
  assert.equal(saved, 1);
  assert.equal((await store.list("paper"))[0].body, "关页前写的");
  const bag = await storage.get(pendingNotesKey("paper"));
  assert.deepEqual(bag.tabs, {});
});

test("storage available recovers the chip within 1s even if a poll is in flight", async () => {
  const dom = installDom();
  const host = dom.document.createElement("div");
  dom.body.append(host);
  let released = false;
  const chip = createLibraryChip({
    host,
    pollMs: 60000,
    manualRetryMs: 11000,
    openStorage: () => (released ? Promise.resolve(true) : new Promise(() => {}))
  });
  chip.block(blockedError("blocked", Date.parse("2026-10-13T08:05:00")));
  void chip.autoRetry();
  await Promise.resolve();
  released = true;
  storagePageTarget().dispatchEvent(new CustomEvent(STORAGE_AVAILABLE_EVENT, {
    detail: { type: STORAGE_AVAILABLE_EVENT }
  }));
  const started = Date.now();
  while (chip.state.mode !== "recovered" && Date.now() - started < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(chip.state.mode, "recovered");
  assert.ok(Date.now() - started < 1000);
  chip.destroy();
});

test("a slow current layout does not request vendor zoning", async () => {
  const version = "rev-late";
  const hash = "zone-late-layout";
  let http = 0;
  const started = performance.now();
  const gate = await waitForFirstZone(hash, {
    store: {
      async getPaper() {
        await new Promise((resolve) => setTimeout(resolve, LIBRARY_ZONE_WAIT_MS + 250));
        return { docHash: hash, title: "late", pageCount: 1, origin: "native" };
      },
      async getPages() {
        return [{ page: 1, pairs: [], layoutVersion: version }];
      },
      async listLayouts() {
        return [{
          page: 1,
          savedAt: 9,
          layout: {
            blocks: [{ bid: "kept", text: "already" }],
            layoutVersion: version,
            protocol: "blocks-1"
          }
        }];
      }
    }
  });
  assert.equal(gate.reason, "cap");
  const ready = await resolveZoneForVendor(hash, gate);
  const layout = storedLayoutCurrent(ready.document?.pages?.[0], version);
  if (!layout) http += 1;
  assert.equal(http, 0);
  assert.equal(layout.blocks[0].bid, "kept");
  assert.ok(performance.now() - started >= LIBRARY_ZONE_WAIT_MS);
  assert.ok(performance.now() - started < 2000);
});

test("a quota failure does not mark the library store blocked", async () => {
  storagePageTarget().dispatchEvent(new CustomEvent(STORAGE_AVAILABLE_EVENT, {
    detail: { type: STORAGE_AVAILABLE_EVENT }
  }));
  const quota = await waitForFirstZone("zone-quota", {
    store: {
      async getPaper() {
        const error = new Error("quota");
        error.type = "quota";
        throw error;
      }
    }
  });
  assert.equal(quota.reason, "unavailable");
  let reads = 0;
  const next = await waitForFirstZone("zone-after-quota", {
    store: {
      async getPaper() {
        reads += 1;
        return null;
      }
    }
  });
  assert.equal(reads, 1);
  assert.equal(next.reason, "stored");
});

test("a deferred zone write swallows rejection", async () => {
  const caught = [];
  const onUnhandled = (error) => caught.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    await settleFreshZone({
      hash: "zone-unhandled-write",
      page: 1,
      version: "rev",
      reason: "cap",
      write: async () => {
        throw new Error("deferred-write");
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(caught.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a page save that created the paper does not block migration of the pages it skipped", async () => {
  const { store } = memoryStore({ now: () => 80 });
  await store.putLegacyDocument("doc-fill", {
    paper: { title: "先存的", pageCount: 2 },
    pages: [{
      page: 1,
      pairs: [{ bid: "a", text: "Keep", sourceText: "Keep", translation: "留下", targetLang: "zh-CN" }]
    }],
    layouts: [{
      docHash: "doc-fill",
      page: 1,
      mode: "unknown",
      protocol: "blocks-1",
      layoutRev: "rev-a",
      layout: { blocks: [{ bid: "kept" }], layoutVersion: "rev-a", protocol: "blocks-1" }
    }]
  });
  await store.putLegacyDocument("doc-fill", {
    paper: { title: "后来的迁移", pageCount: 2 },
    pages: [
      {
        page: 1,
        pairs: [{ bid: "a", text: "Keep", sourceText: "Keep", translation: "被盖掉", targetLang: "zh-CN" }]
      },
      {
        page: 2,
        pairs: [{ bid: "b", text: "New", sourceText: "New", translation: "补上", targetLang: "zh-CN" }]
      }
    ],
    layouts: [
      {
        docHash: "doc-fill",
        page: 1,
        mode: "unknown",
        protocol: "blocks-1",
        layoutRev: "rev-b",
        layout: { blocks: [{ bid: "replaced" }], layoutVersion: "rev-b", protocol: "blocks-1" }
      },
      {
        docHash: "doc-fill",
        page: 2,
        mode: "unknown",
        protocol: "blocks-1",
        layoutRev: "rev-b",
        layout: { blocks: [{ bid: "filled" }], layoutVersion: "rev-b", protocol: "blocks-1" }
      }
    ]
  });
  assert.equal((await store.getPaper("doc-fill")).title, "先存的");
  assert.equal((await store.getPage("doc-fill", 1)).pairs[0].translation, "留下");
  assert.equal((await store.getPage("doc-fill", 2)).pairs[0].translation, "补上");
  assert.equal((await store.getLayout("doc-fill", 1, "unknown", "blocks-1")).layout.blocks[0].bid, "kept");
  assert.equal((await store.getLayout("doc-fill", 2, "unknown", "blocks-1")).layout.blocks[0].bid, "filled");
});

test("migration fills pages when a page save already created the paper", async () => {
  const { store } = memoryStore();
  await saveLibraryPage({
    hash: "partial-doc",
    title: "先存的",
    pageCount: 2,
    page: 1,
    pairs: [{ bid: "a", text: "Keep", sourceText: "Keep", translation: "留下", targetLang: "zh-CN" }],
    layoutVersion: "rev-a",
    layout: { protocol: "blocks-1", layoutVersion: "rev-a", blocks: [{ bid: "kept" }] }
  }, { store });
  let gets = 0;
  const doc = await fetchLibraryDocument("partial-doc", {
    store,
    fetch: async () => {
      gets += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          title: "后来的迁移",
          pageCount: 2,
          pages: [
            {
              page: 1,
              pairs: [{ bid: "a", text: "Keep", sourceText: "Keep", translation: "被盖掉", targetLang: "zh-CN" }],
              layoutVersion: "rev-b",
              layout: { protocol: "blocks-1", layoutVersion: "rev-b", blocks: [{ bid: "replaced" }] }
            },
            {
              page: 2,
              pairs: [{ bid: "b", text: "New", sourceText: "New", translation: "补上", targetLang: "zh-CN" }],
              layoutVersion: "rev-b",
              layout: { protocol: "blocks-1", layoutVersion: "rev-b", blocks: [{ bid: "filled" }] }
            }
          ]
        })
      };
    },
    sleep: sleepNow
  });
  assert.equal(gets, 1);
  assert.equal(doc.pages.length, 2);
  assert.equal((await store.getPaper("partial-doc")).title, "先存的");
  assert.equal((await store.getPage("partial-doc", 1)).pairs[0].translation, "留下");
  assert.equal((await store.getPage("partial-doc", 2)).pairs[0].translation, "补上");
  assert.equal((await store.getLayout("partial-doc", 1, "unknown", "blocks-1")).layout.blocks[0].bid, "kept");
  assert.equal((await store.getLayout("partial-doc", 2, "unknown", "blocks-1")).layout.blocks[0].bid, "filled");
});

test("import keeps the migration record", async () => {
  const { store } = memoryStore({ now: () => 70 });
  await store.putLegacyDocument("doc-migrate", {
    paper: { title: "已迁移", pageCount: 1, origin: "local-service" },
    pages: [{
      page: 1,
      pairs: [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "你好", targetLang: "zh-CN" }]
    }]
  });
  const before = await store.migrationStatus();
  assert.equal(before.doneDocs.includes("doc-migrate"), true);
  const bundle = await store.exportLibrary({ exportedAt: 70, appVersion: "0.3.0" });
  assert.equal(bundle.migration.doneDocs.includes("doc-migrate"), true);
  const empty = memoryStore({ now: () => 71 });
  await empty.store.importBundle(bundle);
  const after = await empty.store.migrationStatus();
  assert.equal(after.doneDocs.includes("doc-migrate"), true);
  assert.equal((await empty.store.getPage("doc-migrate", 1)).pairs[0].translation, "你好");

  const local = memoryStore({ now: () => 72 });
  const first = {
    format: LIBRARY_FORMAT,
    schema: LIBRARY_SCHEMA,
    papers: [],
    migration: {
      step: "lazy",
      errors: [{ docHash: "doc-local", reason: "write" }],
      doneDocs: ["doc-local"]
    }
  };
  const second = {
    format: LIBRARY_FORMAT,
    schema: LIBRARY_SCHEMA,
    papers: [],
    migration: {
      step: "finished",
      errors: [{ docHash: "doc-b", reason: "incoming" }],
      doneDocs: ["doc-b"],
      finishedAt: 99
    }
  };
  await local.store.importBundle(first);
  await local.store.importBundle(second);
  const merged = await local.store.migrationStatus();
  assert.equal(merged.step, "lazy");
  assert.deepEqual(merged.errors, [{ docHash: "doc-local", reason: "write" }]);
  assert.equal(merged.doneDocs.includes("doc-local"), true);
  assert.equal(merged.doneDocs.includes("doc-b"), true);
});

test("F4-21 notes written before the library upgrade are still listed", async () => {
  const notes = createNotesStore({
    persist: false,
    deviceId: "device-f421",
    now: () => 8,
    createId: () => "note-f421"
  });
  await notes.put({ docHash: "doc-f421", kind: "note", page: 1, body: "升级前的笔记" });
  const store = createLibraryStore({
    platform: { target: "idb", kv: createMemoryKv(), library: createIdbLibraryFactory() },
    persist: false,
    deviceId: "device-f421-lib",
    now: () => 9
  });
  await store.putLegacyDocument("doc-f421", {
    paper: { title: "升级", pageCount: 1, origin: "native" },
    pages: [{ page: 1, pairs: [{ bid: "a", text: "A", sourceText: "A", translation: "甲", targetLang: "zh-CN" }] }]
  });
  assert.equal((await notes.list("doc-f421"))[0].body, "升级前的笔记");
  const version = "rev-f421";
  await store.putLayout({
    docHash: "doc-f421",
    page: 1,
    mode: "local",
    protocol: "blocks-1",
    layoutRev: version,
    layout: { blocks: [{ bid: "kept", text: "cached" }], layoutVersion: version, protocol: "blocks-1" }
  });
  const gate = await waitForFirstZone("doc-f421", { store });
  const layout = storedLayoutCurrent(gate.document?.pages?.[0], version);
  assert.equal(layout?.blocks?.[0]?.bid, "kept");
});

test("F4-22 two tabs upgrading one paper do not deadlock", async () => {
  let held = 0;
  let max = 0;
  const locks = {
    request(_name, options, fn) {
      if (options?.ifAvailable && held > 0) return fn(null);
      held += 1;
      max = Math.max(max, held);
      return Promise.resolve(fn({})).finally(() => {
        held -= 1;
      });
    }
  };
  const first = withLibraryDocLock("doc-22", async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return "first";
  }, locks);
  const second = withLibraryDocLock("doc-22", async () => "second", locks);
  const both = await Promise.all([first, second]);
  assert.equal(max, 1);
  assert.equal(both.includes("first"), true);
  assert.equal(both.some((item) => item && item.skipped === true), true);
});

test("a slow unblocked read zones within the hard cap and does not overwrite a late layout", { timeout: 20000 }, async () => {
  assert.equal(LIBRARY_ZONE_HARD_MS, 1500);
  const hash = "zone-hard-cap";
  const version = "rev-hard";
  const store = {
    async getPaper() {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return { docHash: hash, title: "hard", pageCount: 1, origin: "native" };
    },
    async getPages() {
      return [{ page: 1, pairs: [], layoutVersion: version }];
    },
    async listLayouts() {
      return [{
        page: 1,
        savedAt: 3,
        layout: {
          blocks: [{ bid: "kept", text: "late" }],
          layoutVersion: version,
          protocol: "blocks-1"
        }
      }];
    }
  };
  const started = performance.now();
  const gate = await waitForFirstZone(hash, { store });
  assert.equal(gate.reason, "cap");
  const ready = await resolveZoneForVendor(hash, gate);
  const elapsed = performance.now() - started;
  assert.equal(ready.reason, "cap");
  assert.equal(ready.document, null);
  assert.ok(elapsed >= LIBRARY_ZONE_HARD_MS - 80, `zoning returned early at ${elapsed}ms`);
  assert.ok(elapsed < LIBRARY_ZONE_HARD_MS + 500, `zoning waited ${elapsed}ms`);
  let writes = 0;
  const settled = await settleFreshZone({
    hash,
    page: 1,
    version,
    reason: ready.reason,
    write: async () => { writes += 1; }
  });
  assert.equal(settled.deferred, true);
  assert.equal(writes, 0);
  await whenZoneReadSettles(hash);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(writes, 0);
  assert.equal(currentLayoutIfArrived({ hash, page: 1, version }).blocks[0].bid, "kept");
});

test("a 2s indexedDB read still sees the in-flight migration before the zoning cap", { timeout: 8000 }, async () => {
  const hash = "zone-migrate-2s";
  const version = "rev-mig";
  const started = Date.now();
  let fetchedAt = 0;
  const store = {
    async getPaper() {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return null;
    },
    async getPages() { return []; },
    async listLayouts() { return []; }
  };
  const fetchImpl = async () => {
    fetchedAt = Date.now() - started;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        title: "legacy",
        pageCount: 1,
        pages: [{
          page: 1,
          layout: {
            blocks: [{ bid: "kept", text: "legacy" }],
            layoutVersion: version,
            protocol: "blocks-1"
          }
        }]
      })
    };
  };
  const probe = fetchLibraryDocument(hash, { store, fetch: fetchImpl, sleep: () => Promise.resolve() });
  const gate = await waitForFirstZone(hash, { store });
  assert.equal(gate.reason, "cap");
  const zone = await waitForZoneMigration(hash, gate, {
    page: 1,
    version,
    engine: "local-ocr",
    fetch: fetchImpl
  });
  const elapsed = Date.now() - started;
  assert.ok(fetchedAt > 0 && fetchedAt < LIBRARY_ZONE_HARD_MS + 200, `migration GET started at ${fetchedAt}ms`);
  assert.ok(elapsed < LIBRARY_ZONE_HARD_MS + 500, `zoning waited ${elapsed}ms`);
  assert.equal(zone.reason, "stored");
  assert.equal(zone.document.pages[0].layout.mode, "unknown");
  assert.equal(layoutCurrentForLibrary(zone.document.pages[0], version, "local-ocr").blocks[0].bid, "kept");
  let writes = 0;
  const settled = await settleFreshZone({
    hash,
    page: 1,
    version,
    reason: "cap",
    engine: "local-ocr",
    write: async () => { writes += 1; }
  });
  assert.equal(settled.recomputed, false);
  assert.equal(settled.layout.blocks[0].bid, "kept");
  await whenZoneReadSettles(hash);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(writes, 0);
  beginZoneStoredRead(hash, { store: { getPaper() { return new Promise(() => {}); } } });
  assert.equal(currentLayoutIfArrived({ hash, page: 1, version, engine: "local-ocr" }).blocks[0].bid, "kept");
  probe.catch(() => {});
});

test("a fast legacy GET does not hide the in-flight IndexedDB document on reopen", async () => {
  const hash = "zone-reopen-idb-wins";
  const version = "rev-reopen";
  const store = {
    async getPaper() {
      await new Promise((resolve) => setTimeout(resolve, 450));
      return { docHash: hash, title: "stored", pageCount: 1, origin: "native" };
    },
    async getPages() {
      return [{
        page: 1,
        pairs: [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "已译", targetLang: "zh-CN" }],
        layoutVersion: version
      }];
    },
    async listLayouts() {
      return [{
        page: 1,
        savedAt: 2,
        layout: {
          blocks: [{ bid: "kept", text: "Hello" }],
          layoutVersion: version,
          protocol: "blocks-1",
          mode: "local-ocr"
        }
      }];
    }
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      title: "fixture",
      pageCount: 1,
      pages: [{
        page: 1,
        pairs: [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "见⟦f99⟧", targetLang: "zh-CN" }],
        layout: { blocks: [{ bid: "fixture", text: "Hello" }], layoutVersion: version, protocol: "blocks-1" }
      }]
    })
  });
  const started = Date.now();
  const probe = fetchLibraryDocument(hash, { store, fetch: fetchImpl, sleep: () => Promise.resolve() });
  const gate = await waitForFirstZone(hash, { store });
  assert.equal(gate.reason, "cap");
  const zone = await waitForZoneMigration(hash, gate, {
    page: 1,
    version,
    engine: "local-ocr",
    fetch: fetchImpl
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < LIBRARY_ZONE_HARD_MS, `reopen waited out the cap at ${elapsed}ms`);
  assert.equal(zone.reason, "stored");
  assert.equal(zone.document.pages[0].pairs[0].translation, "已译");
  assert.equal(zone.document.pages[0].layout.blocks[0].bid, "kept");
  const doc = await probe;
  assert.equal(doc.pages[0].pairs[0].translation, "已译");
});

test("an empty indexedDB read still adopts the legacy row that arrived while it was pending", async () => {
  const hash = "zone-reopen-idb-empty";
  const version = "rev-empty";
  const store = {
    async getPaper() {
      await new Promise((resolve) => setTimeout(resolve, 450));
      return null;
    },
    async getPages() { return []; },
    async listLayouts() { return []; }
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      title: "legacy",
      pageCount: 1,
      pages: [{
        page: 1,
        layout: {
          blocks: [{ bid: "kept", text: "legacy" }],
          layoutVersion: version,
          protocol: "blocks-1"
        }
      }]
    })
  });
  const started = Date.now();
  const probe = fetchLibraryDocument(hash, { store, fetch: fetchImpl, sleep: () => Promise.resolve() });
  const gate = await waitForFirstZone(hash, { store });
  assert.equal(gate.reason, "cap");
  const zone = await waitForZoneMigration(hash, gate, {
    page: 1,
    version,
    engine: "local-ocr",
    fetch: fetchImpl
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1200, `empty read held zoning for ${elapsed}ms`);
  assert.equal(zone.reason, "stored");
  assert.equal(zone.document.pages[0].layout.blocks[0].bid, "kept");
  assert.equal(zone.document.pages[0].layout.mode, "unknown");
  const doc = await probe;
  assert.equal(doc.pages[0].layout.blocks[0].bid, "kept");
});

test("a vendor re-zone keeps the engine that produced it, and cacheableLayout does not drop that mode", () => {
  const produced = { blocks: [{ bid: "v" }], layoutVersion: "rev-mig", protocol: "blocks-1", textSource: "text-layer" };
  stampSessionLayout(produced, "local-ocr");
  assert.equal(produced.mode, "local-ocr");
  const stored = cacheableLayout(produced);
  assert.equal(stored.mode, "local-ocr");
  assert.equal(stored.textSource, "text-layer");
  assert.equal(recordedLayoutMode({ layout: stored }), "local-ocr");
  const mismatch = { mode: "cloud-ocr", blocks: [{ bid: "v" }], textSource: "text-layer", layoutVersion: "rev-mig" };
  stampSessionLayout(mismatch, "local-ocr");
  assert.equal(mismatch.mode, "local-ocr");
  assert.equal(recordedLayoutMode({ layout: cacheableLayout(mismatch) }), "local-ocr");
  const unknown = { mode: "unknown", blocks: [{ bid: "u" }] };
  stampSessionLayout(unknown, "local-ocr");
  assert.equal(unknown.mode, "unknown");
  const viewer = read("pdf/viewer.js");
  const ingest = viewer.slice(viewer.indexOf("async function ingestVendorLayout"), viewer.indexOf("async function ingestSkippedSourceLayout"));
  assert.ok(ingest.indexOf("stampProducedEngine(mapped, mode)") < ingest.indexOf("await settleFreshZone"));
});

test("a second open during a stuck indexedDB open does not queue behind it", async () => {
  assert.equal(OPEN_INHERIT_AFTER_MS, 300);
  let opens = 0;
  const held = hangingFactory(() => { opens += 1; });
  const first = openIndexedDatabase({
    name: "oi-pr3-inherit-slow",
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 10000,
    inheritAfterMs: 40
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const started = Date.now();
  const second = await openIndexedDatabase({
    name: "oi-pr3-inherit-slow",
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 10000
  }).then(() => null, (error) => error);
  assert.equal(opens, 1);
  assert.equal(second.name, "BusyError");
  assert.equal(second.cause?.type, "busy");
  assert.equal(storageOpenIsBlocked("oi-pr3-inherit-slow"), false);
  assert.ok(Date.now() - started < 50, `queued open waited ${Date.now() - started}ms`);
  held.req.onblocked();
  const blocked = await openIndexedDatabase({
    name: "oi-pr3-inherit-slow",
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 10000
  }).then(() => null, (error) => error);
  assert.equal(opens, 1);
  assert.equal(blocked.name, "BlockedError");
  assert.equal(blocked.cause, "blocked");
  held.req.result = { close() {} };
  held.req.onsuccess();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(storageOpenIsBlocked("oi-pr3-inherit-slow"), false);
});

test("a slow open is not blocked when a second open starts during it", async () => {
  let opens = 0;
  const fake = {
    open() {
      opens += 1;
      const req = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null
      };
      setTimeout(() => {
        req.result = { close() {}, objectStoreNames: { contains: () => true } };
        req.onsuccess?.({ target: req });
      }, 2000);
      return req;
    }
  };
  let events = 0;
  const stop = onStorageAvailable(() => { events += 1; });
  try {
    const started = Date.now();
    const first = openIndexedDatabase({
      name: "oi-pr3-slow-concurrent",
      indexedDB: fake,
      blockedTimeoutMs: 10000
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = await openIndexedDatabase({
      name: "oi-pr3-slow-concurrent",
      indexedDB: fake,
      blockedTimeoutMs: 10000
    }).then(() => null, (error) => error);
    assert.equal(opens, 1);
    assert.equal(second.name, "BusyError");
    assert.notEqual(second.name, "BlockedError");
    assert.equal(second.cause?.type, "busy");
    assert.ok(Date.now() - started < 1000, `second open waited ${Date.now() - started}ms`);
    assert.equal(storageOpenIsBlocked("oi-pr3-slow-concurrent"), false);
    const db = await first;
    assert.equal(typeof db.close, "function");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(storageOpenIsBlocked("oi-pr3-slow-concurrent"), false);
    assert.equal(events, 0);
  } finally {
    stop();
  }
});

test("concurrent library opens share the in-flight open", async () => {
  let opens = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const db = {
    version: 3,
    closed: false,
    close() {},
    async get() { return null; },
    async put() {}
  };
  const library = {
    async exists() { return true; },
    open() {
      opens += 1;
      return gate.then(() => db);
    }
  };
  const store = createLibraryStore({
    platform: { target: "memory", kv: createMemoryKv(), library },
    persist: false
  });
  const first = store.openFor(false);
  const second = store.openFor(true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(opens, 1);
  release();
  const [read, write] = await Promise.all([first, second]);
  assert.equal(read, db);
  assert.equal(write, db);
  assert.equal(opens, 1);
});

test("a timed-out open's late success closes and emits on a later turn", async () => {
  const held = hangingFactory();
  const heard = [];
  const stop = onStorageAvailable(() => heard.push("available"));
  const pending = openIndexedDatabase({
    name: "oi-pr3-late-success",
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 20
  });
  const failed = await pending.then(() => null, (error) => error);
  assert.equal(failed.name, "BlockedError");
  let closedSync = false;
  held.req.result = {
    close() { closedSync = true; heard.push("closed"); }
  };
  held.req.onsuccess();
  assert.equal(closedSync, false);
  assert.equal(heard.includes("available"), false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(heard.includes("closed"), true);
  assert.equal(heard.includes("available"), true);
  assert.ok(heard.indexOf("closed") < heard.indexOf("available"));
  stop();
});

test("a stuck indexedDB read does not hold translation until the 10s timeout", { timeout: 8000 }, async () => {
  const hash = "zone-translate-stuck";
  const version = "rev-tr";
  const store = {
    async getPaper() {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 8000);
        if (typeof timer.unref === "function") timer.unref();
      });
      return null;
    },
    async getPages() { return []; },
    async listLayouts() { return []; }
  };
  const body = {
    title: "legacy",
    pageCount: 1,
    pages: [{
      page: 1,
      pairs: [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "你好", targetLang: "zh-CN" }],
      layout: { blocks: [{ bid: "kept", text: "Hello" }], layoutVersion: version, protocol: "blocks-1" }
    }]
  };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => body });
  const started = Date.now();
  const probe = fetchLibraryDocument(hash, { store, fetch: fetchImpl, sleep: () => Promise.resolve() });
  const gate = await waitForFirstZone(hash, { store });
  assert.equal(gate.reason, "cap");
  assert.equal(translationWaitsForLibrary(gate), false);
  const zone = await waitForZoneMigration(hash, gate, {
    page: 1,
    version,
    engine: "local-ocr",
    fetch: fetchImpl
  });
  const doc = await probe;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < LIBRARY_ZONE_HARD_MS + 800, `translation probe waited ${elapsed}ms`);
  assert.equal(zone.reason, "stored");
  assert.equal(zone.document.pages[0].pairs[0].translation, "你好");
  assert.equal(doc.pages[0].pairs[0].translation, "你好");
  assert.equal(layoutCurrentForLibrary(doc.pages[0], version, "local-ocr").blocks[0].bid, "kept");
  let writes = 0;
  const settled = await settleFreshZone({
    hash,
    page: 1,
    version,
    reason: "cap",
    engine: "local-ocr",
    write: async () => { writes += 1; }
  });
  assert.equal(writes, 0);
  assert.equal(settled.recomputed, false);
  assert.equal(settled.layout.blocks[0].bid, "kept");
  const viewer = read("pdf/viewer.js");
  const savedFn = viewer.slice(
    viewer.indexOf("async function savedTranslationFor"),
    viewer.indexOf("function savedPageStatus")
  );
  assert.match(savedFn, /zone\?\.reason === "unavailable"/);
  assert.ok(savedFn.indexOf("unavailable") < savedFn.indexOf("waitForZoneMigration"));
  assert.match(savedFn, /librarySourceSent\.has\(hash\)/);
  assert.doesNotMatch(savedFn, /librarySourceSent\.clear\(\)/);
  assert.doesNotMatch(savedFn, /await ensureLibraryDocument\(\)/);
  assert.doesNotMatch(savedFn, /await libraryProbe/);
  const ensure = viewer.slice(
    viewer.indexOf("function ensureLibraryDocument"),
    viewer.indexOf("function savedTranslationForNav")
  );
  const fetchedAt = ensure.indexOf("await fetchLibraryDocument");
  const keepSession = ensure.lastIndexOf("libraryDoc.hash === hash");
  const assignDoc = ensure.lastIndexOf("libraryDoc = doc");
  assert.ok(fetchedAt > 0 && fetchedAt < keepSession && keepSession < assignDoc);
});

test("a corrected pair is merged with the live blocks even when the layout row is already current", async () => {
  const misaligned = {
    bid: "b-mis",
    sourceId: "p18-s1",
    label: "text",
    text: "see ⟦f1⟧ and ⟦f2⟧",
    sourceText: "see ALPHA and BETA"
  };
  const stalePair = {
    bid: misaligned.bid,
    sourceId: misaligned.sourceId,
    text: "see ⟦f9⟧ and BETA",
    sourceText: misaligned.sourceText,
    translation: "见⟦f9⟧和乙",
    targetLang: "zh-CN",
    provider: "mymemory"
  };
  const fresh = {
    bid: misaligned.bid,
    text: misaligned.text,
    sourceText: misaligned.sourceText,
    translation: "见甲⟦f1⟧和乙⟦f2⟧",
    targetLang: "zh-CN",
    provider: "mymemory"
  };
  let written = null;
  const store = {
    async getPaper() { return { docHash: "h-mis", pageCount: 1, origin: "native" }; },
    async touchPaper() {},
    async putPage(_hash, _page, input) {
      written = mergeStoredPagePairs([stalePair], input.pairs, input.blocks, input.targetLang);
    },
    async putLayout() { throw new Error("current layout must stay"); }
  };
  await saveLibraryPage({
    hash: "h-mis",
    page: 1,
    pageCount: 1,
    pairs: [fresh],
    blocks: [misaligned],
    targetLang: "zh-CN"
  }, { store });
  assert.equal(written[0].translation, fresh.translation);
  const kept = mergeStoredPagePairs([stalePair], [fresh], null, "zh-CN");
  assert.equal(kept[0].translation, stalePair.translation);
  const viewer = read("pdf/viewer.js");
  const remember = viewer.slice(viewer.indexOf("function rememberTranslation"), viewer.indexOf("function rememberSkipHole"));
  assert.ok(remember.indexOf("blocks?.length") < remember.indexOf("keepLayout ? { layout }"));
});

test("a library read that fails after the cap does not overwrite a current layout", async () => {
  const hash = "zone-read-failed";
  const version = "rev-keep";
  const store = {
    async getPaper() {
      await new Promise((resolve) => setTimeout(resolve, LIBRARY_ZONE_WAIT_MS + 80));
      throw new Error("open failed");
    }
  };
  const gate = await waitForFirstZone(hash, { store });
  assert.equal(gate.reason, "cap");
  let writes = 0;
  const settled = await settleFreshZone({
    hash,
    page: 1,
    version,
    reason: gate.reason,
    engine: "local-ocr",
    write: async () => { writes += 1; }
  });
  assert.equal(settled.deferred, true);
  assert.equal(writes, 0);
  await whenZoneReadSettles(hash);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(writes, 0);
  assert.equal(currentLayoutIfArrived({ hash, page: 1, version, engine: "local-ocr" }), null);
});

test("translation does not wait out a blocked library open", async () => {
  const held = hangingFactory();
  const pendingOpen = openIndexedDatabase({
    name: NOTES_DB_NAME,
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 10000
  });
  try {
    held.req.onblocked();
    const started = performance.now();
    const zone = await waitForFirstZone("zone-translate-blocked", {
      store: {
        getPaper() {
          return new Promise(() => {});
        }
      }
    });
    const elapsed = performance.now() - started;
    assert.equal(zone.reason, "unavailable");
    assert.ok(elapsed < 80, `blocked open delayed translation by ${elapsed}ms`);
    assert.equal(translationWaitsForLibrary(zone), false);
    assert.equal(translationWaitsForLibrary({ reason: "cap" }), false);
    assert.equal(translationWaitsForLibrary({ reason: "stored" }), true);
  } finally {
    held.req.result = { close() {} };
    held.req.onsuccess();
    await pendingOpen;
  }
});

test("a blocked upgrade does not hold the migrated translation for the 10s deadline", { timeout: 8000 }, async () => {
  const hash = "zone-block-upgrade";
  const version = "rev-block-mig";
  const held = hangingFactory();
  let puts = 0;
  let pendingOpen = null;
  const store = {
    async getPaper() { return null; },
    async getPages() { return []; },
    async listLayouts() { return []; },
    async putLegacyDocument() {
      puts += 1;
      pendingOpen = openIndexedDatabase({
        name: NOTES_DB_NAME,
        version: 2,
        indexedDB: held.factory,
        blockedTimeoutMs: 10000
      });
      held.req.onblocked();
      await new Promise(() => {});
    }
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      title: "legacy",
      pageCount: 1,
      pages: [{
        page: 1,
        pairs: [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "挡住也先译", targetLang: "zh-CN" }],
        layout: {
          blocks: [{ bid: "kept", text: "Hello" }],
          layoutVersion: version,
          protocol: "blocks-1"
        }
      }]
    })
  });
  const started = Date.now();
  try {
    const doc = await Promise.race([
      fetchLibraryDocument(hash, {
        store,
        fetch: fetchImpl,
        sleep: () => Promise.resolve(),
        locks: { request: async (_name, _options, fn) => fn({}) }
      }),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("blocked upgrade held the translation")), 3000);
      })
    ]);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `blocked upgrade held translation for ${elapsed}ms`);
    assert.equal(puts, 1);
    assert.equal(doc.pages[0].pairs[0].translation, "挡住也先译");
    const body = read("lib/pdf-library.js");
    const fn = body.slice(body.indexOf("async function fetchLibraryDocumentBody"), body.indexOf("export function fetchLibraryDocument"));
    assert.match(fn, /migrateUnlessBlocked/);
    assert.doesNotMatch(fn, /await migrateLegacyDocument/);
  } finally {
    if (held.req) {
      held.req.result = { close() {} };
      held.req.onsuccess();
    }
    if (pendingOpen) await pendingOpen.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("a blocked zone still adopts the migration GET inside the cap", async () => {
  const hash = "zone-unavailable-get";
  const version = "rev-unavail-get";
  const held = hangingFactory();
  const pendingOpen = openIndexedDatabase({
    name: NOTES_DB_NAME,
    version: 2,
    indexedDB: held.factory,
    blockedTimeoutMs: 10000
  });
  let calls = 0;
  try {
    held.req.onblocked();
    const started = Date.now();
    const zone = await waitForZoneMigration(hash, { reason: "unavailable", document: null, waitedMs: 0 }, {
      page: 1,
      version,
      engine: "local-ocr",
      fetch: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            title: "legacy",
            pageCount: 1,
            pages: [{
              page: 1,
              pairs: [{ bid: "a", text: "Hello", sourceText: "Hello", translation: "占用也用旧库", targetLang: "zh-CN" }],
              layout: {
                blocks: [{ bid: "kept", text: "Hello" }],
                layoutVersion: version,
                protocol: "blocks-1"
              }
            }]
          })
        };
      }
    });
    const elapsed = Date.now() - started;
    assert.equal(calls, 1);
    assert.ok(elapsed < LIBRARY_ZONE_HARD_MS, `blocked zone waited ${elapsed}ms for the GET`);
    assert.equal(zone.reason, "stored");
    assert.equal(zone.document.pages[0].pairs[0].translation, "占用也用旧库");
  } finally {
    held.req.result = { close() {} };
    held.req.onsuccess();
    await pendingOpen;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});

test("the 8765 preflight runs only when the paper is not fully stored", () => {
  assert.equal(paperFullyInLibrary({ pageCount: 2, pages: [{ page: 1 }, { page: 2 }] }), true);
  assert.equal(paperFullyInLibrary({ pageCount: 2, hash: "partial", pages: [{ page: 1 }] }), false);
  assert.equal(paperFullyInLibrary({ hash: "only-hash", pages: [] }), false);
  assert.equal(paperFullyInLibrary(null), false);
  assert.equal(shouldProbeLocalService({ layoutMode: "pdfjs", document: null }), false);
  assert.equal(shouldProbeLocalService({
    layoutMode: "local-ocr",
    document: { pageCount: 1, pages: [{ page: 1 }] },
    zoneReason: "stored"
  }), false);
  assert.equal(shouldProbeLocalService({
    layoutMode: "local-ocr",
    document: { pageCount: 2, hash: "partial", pages: [{ page: 1 }] },
    zoneReason: "stored"
  }), true);
  assert.equal(shouldProbeLocalService({ layoutMode: "local-ocr", document: null, zoneReason: "cap" }), false);
  assert.equal(shouldProbeLocalService({ layoutMode: "local-ocr", document: null, zoneReason: "unavailable" }), true);
  const viewer = read("pdf/viewer.js");
  const pre = viewer.slice(
    viewer.indexOf("async function translatePreflight"),
    viewer.indexOf("async function readAutoTranslateEnabled")
  );
  assert.match(pre, /paperFullyInLibrary/);
  assert.match(pre, /shouldProbeLocalService/);
  assert.match(pre, /resolveZoneForVendor/);
  assert.doesNotMatch(pre, /servedFromLibrary/);
  assert.doesNotMatch(pre, /libraryDoc\.pages\?\.length \|\| libraryDoc\.hash/);
  const ensure = viewer.slice(
    viewer.indexOf("function ensureLibraryDocument"),
    viewer.indexOf("function savedTranslationForNav")
  );
  assert.doesNotMatch(ensure, /flushStagedNotes/);
  const adopt = viewer.slice(viewer.indexOf("void resolveNotesDocHash"), viewer.indexOf("await buildPages"));
  assert.match(adopt, /flushStagedNotes/);
});

test("two concurrent flushes write a staged note once", async () => {
  const pending = createPendingNotes({ tabId: "tab-once", now: () => 30 });
  const staged = await pending.stage("doc-once", { body: "只写一次" });
  const store = createNotesStore({ memory: true, persist: false, now: () => 31, createId: () => "should-not-use" });
  let puts = 0;
  const put = async (item) => {
    puts += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return store.put(item);
  };
  const [left, right] = await Promise.all([
    pending.flush("doc-once", put),
    pending.flush("doc-once", put)
  ]);
  assert.equal(left + right, 1);
  const listed = await store.list("doc-once");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, staged.id);
  assert.equal(listed[0].body, "只写一次");
  assert.equal(puts, 1);
});

test("a live tab's staged notes are not flushed by another tab", async () => {
  const restore = installFakeLocks();
  try {
    const data = new Map();
    const storage = {
      async get(key) { return data.has(key) ? data.get(key) : null; },
      async set(key, value) { data.set(key, value); }
    };
    const live = createPendingNotes({ storage, tabId: () => "tab-live" });
    const other = createPendingNotes({ storage, tabId: () => "tab-other" });
    await live.stage("doc-live", { body: "还开着" });
    await other.stage("doc-live", { body: "这页的" });
    const store = createNotesStore({ memory: true, persist: false, now: () => 40, createId: () => "live-note" });
    const saved = await other.flush("doc-live", (item) => store.put(item), { allTabs: true });
    assert.equal(saved, 1);
    assert.equal((await store.list("doc-live")).map((row) => row.body).join(","), "这页的");
    assert.deepEqual((await live.list("doc-live")).map((row) => row.body), ["还开着"]);
  } finally {
    restore();
  }
});

test("a preempted open that succeeds is kept, and a manual retry does not open twice", async () => {
  const dom = installDom();
  const host = dom.document.createElement("div");
  dom.body.append(host);
  const gates = [];
  const chip = createLibraryChip({
    host,
    pollMs: 60000,
    manualRetryMs: 11000,
    openStorage: () => new Promise((resolve) => { gates.push(resolve); })
  });
  chip.block(blockedError("blocked", Date.parse("2026-10-13T08:05:00")));
  void chip.autoRetry();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(chip.opens(), 1);
  storagePageTarget().dispatchEvent(new CustomEvent(STORAGE_AVAILABLE_EVENT, {
    detail: { type: STORAGE_AVAILABLE_EVENT }
  }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(chip.opens(), 2);
  gates[0](true);
  const started = Date.now();
  while (chip.state.mode !== "recovered" && Date.now() - started < 500) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(chip.state.mode, "recovered");
  assert.equal(chip.opens(), 2);
  chip.destroy();

  const hostB = dom.document.createElement("div");
  dom.body.append(hostB);
  const polling = createLibraryChip({
    host: hostB,
    pollMs: 60000,
    manualRetryMs: 11000,
    openStorage: () => new Promise(() => {})
  });
  polling.block(blockedError("blocked"));
  void polling.autoRetry();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(polling.opens(), 1);
  await polling.retry();
  assert.equal(polling.opens(), 1);
  polling.destroy();
});

test("both a preempted open and the new open recover and announce once", async () => {
  const dom = installDom();
  const host = dom.document.createElement("div");
  dom.body.append(host);
  const announcements = [];
  const append = host.append.bind(host);
  host.append = (...kids) => {
    append(...kids);
    for (const kid of kids) {
      if (kid?.classList?.contains("oi-lib-live")) announcements.push(kid.textContent);
    }
  };
  const gates = [];
  let recoveries = 0;
  let flushes = 0;
  const chip = createLibraryChip({
    host,
    pollMs: 60000,
    manualRetryMs: 11000,
    flushNotes: async () => {
      flushes += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return 1;
    },
    onRecovered() {
      recoveries += 1;
    },
    openStorage: () => new Promise((resolve) => { gates.push(resolve); })
  });
  chip.block(blockedError("blocked"));
  void chip.autoRetry();
  await Promise.resolve();
  await Promise.resolve();
  storagePageTarget().dispatchEvent(new CustomEvent(STORAGE_AVAILABLE_EVENT, {
    detail: { type: STORAGE_AVAILABLE_EVENT }
  }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(chip.opens(), 2);
  gates[0](true);
  gates[1](true);
  const started = Date.now();
  while (chip.state.mode !== "recovered" && Date.now() - started < 500) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(chip.state.mode, "recovered");
  assert.equal(recoveries, 1);
  assert.equal(flushes, 1);
  assert.deepEqual(announcements.filter((text) => text.includes("已恢复")), ["已恢复，存好 1 条笔记"]);
  chip.destroy();
});

test("an open that outlasts the preempt budget still recovers the chip", async () => {
  const dom = installDom();
  const host = dom.document.createElement("div");
  dom.body.append(host);
  const timers = createTimers();
  let release;
  const chip = createLibraryChip({
    host,
    timers,
    pollMs: 60000,
    manualRetryMs: 40,
    openStorage: () => new Promise((resolve) => { release = resolve; })
  });
  chip.block(blockedError("blocked"));
  void chip.autoRetry({ preempt: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(chip.opens(), 1);
  timers.advance(40);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(chip.state.mode, "blocked");
  release(true);
  const started = Date.now();
  while (chip.state.mode !== "recovered" && Date.now() - started < 500) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(chip.state.mode, "recovered");
  assert.match(dom.text(host), /已恢复/);
  chip.destroy();
});

test("a second save replaces the staged create for that note", async () => {
  const pending = createPendingNotes({ tabId: "tab-replace", now: () => 70 });
  const first = await pending.stage("doc-replace", { body: "新建", op: "create", page: 1 });
  await pending.stage("doc-replace", { id: first.id, body: "新建改", op: "create", page: 1 });
  const rows = await pending.list("doc-replace");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].op, "create");
  assert.equal(rows[0].body, "新建改");
  assert.equal(rows[0].tempId || rows[0].noteId, first.id);
});

test("one blocked save stages one note and keeps the seed card", async () => {
  const view = installDom();
  const pending = createPendingNotes({ tabId: "tab-one", now: () => 80 });
  const secret = new Error("blocked");
  secret.name = "BlockedError";
  let listed = 0;
  const ui = mountNotesUi({
    hasDoc: () => true,
    docHash: () => "doc-one",
    docTitle: () => "笔记",
    list: async () => {
      listed += 1;
      if (listed > 1) return [];
      return [{
        id: "seed",
        kind: "note",
        author: "me",
        body: "种子",
        page: 1,
        updatedAt: 1,
        anchor: { bid: "b" },
        anchorState: { status: "exact" }
      }];
    },
    listTrash: async () => [],
    put: async () => { throw secret; },
    stageNote: (input) => pending.stage("doc-one", input),
    sharedPersistCard: true,
    persistDenied: async () => false,
    currentParagraph: () => ({ bid: "b", page: 1, translation: "甲", preview: "甲" }),
    anchorForParagraph: (current) => ({
      anchor: { bid: current.bid, page: current.page, quote: current.preview || "" },
      anchorState: { status: "exact" },
      page: current.page
    }),
    flow: () => null,
    pane: () => null,
    pointerFine: () => true,
    blockOrder: () => new Map([["b", 0]]),
    readPrefs: () => ({}),
    subscribe: () => () => {}
  });
  ui.open();
  await tick();
  await tick();
  const panel = view.slot.querySelector(".oi-notes");
  assert.match(view.text(panel), /种子/);
  view.click(findButton(panel, "＋ 给当前段写笔记"));
  assert.ok(panel.querySelector("[data-note-id='seed']"));
  let field = panel.querySelector("textarea");
  assert.ok(field);
  field.value = "新建";
  field.dispatchEvent({ type: "input" });
  field.dispatchEvent({
    type: "keydown",
    key: "Enter",
    ctrlKey: true,
    preventDefault() {},
    stopPropagation() {}
  });
  field.dispatchEvent({
    type: "keydown",
    key: "Enter",
    ctrlKey: true,
    preventDefault() {},
    stopPropagation() {}
  });
  await tick();
  await tick();
  const first = await pending.list("doc-one");
  assert.equal(first.length, 1);
  assert.equal(first[0].op, "create");
  assert.equal(first[0].body, "新建");
  assert.ok(panel.querySelector("[data-note-id='seed']"));
  field = panel.querySelector("textarea");
  field.value = "新建改";
  field.dispatchEvent({ type: "input" });
  field.dispatchEvent({
    type: "keydown",
    key: "Enter",
    ctrlKey: true,
    preventDefault() {},
    stopPropagation() {}
  });
  await tick();
  await tick();
  const second = await pending.list("doc-one");
  assert.equal(second.length, 1);
  assert.equal(second[0].body, "新建改");
  assert.equal(second[0].tempId || second[0].noteId, first[0].tempId || first[0].noteId);
  await ui.refresh();
  assert.ok(panel.querySelector("[data-note-id='seed']"));
  assert.match(view.text(panel), /种子/);
});

test("a migrated layout whose revision sits on the row is current, and a late zone does not replace it", async () => {
  const version = "source-v3:migrated";
  const doc = libraryDocumentFromRecords(
    { docHash: "doc-mig", title: "迁", pageCount: 1 },
    [{ docHash: "doc-mig", page: 1, pairs: [{ text: "a", translation: "甲" }] }],
    [{
      docHash: "doc-mig",
      page: 1,
      mode: "text-layer",
      protocol: "blocks-1",
      layoutRev: version,
      layout: { blocks: [{ bid: "kept", text: "cached" }], protocol: "blocks-1" }
    }]
  );
  assert.equal(doc.pages[0].layout.layoutVersion, version);
  assert.equal(layoutReadyForZone(doc.pages[0], version).blocks[0].bid, "kept");
  assert.equal(storedLayoutCurrent(doc.pages[0], version).blocks[0].bid, "kept");
  assert.equal(layoutReadyForZone({
    layout: { blocks: [{ bid: "old", text: "stale" }], protocol: "blocks-1" },
    layoutRev: "source-v3:other"
  }, version), null);
  assert.equal(layoutReadyForZone({
    layout: { blocks: [{ bid: "plain", text: "blocks" }], protocol: "blocks-1" }
  }, version), null);
  assert.equal(layoutReadyForZone({
    layout: { blocks: [{ bid: "inner-old", text: "stale" }], layoutVersion: "source-v3:other", protocol: "blocks-1" },
    layoutRev: version
  }, version), null);
  assert.equal(layoutReadyForZone({
    layout: {
      blocks: [{ bid: "fall", text: "stand-in" }],
      layoutVersion: version,
      fallback: { source: "text-layer", reason: "network" }
    }
  }, version), null);

  const modeLess = toLibraryRecords({
    hash: "doc-mode",
    pages: [{ page: 1, pairs: [], layout: { blocks: [{ bid: "bare" }], protocol: "blocks-1" } }]
  }, "doc-mode");
  assert.equal(modeLess.layouts[0].mode, "unknown");
  const bareDoc = libraryDocumentFromRecords(
    { docHash: "doc-mode", title: "无模式", pageCount: 1 },
    [{ page: 1, pairs: [] }],
    [{
      ...modeLess.layouts[0],
      layoutRev: version,
      layout: { ...modeLess.layouts[0].layout, layoutVersion: version }
    }]
  );
  assert.equal(bareDoc.pages[0].layout.mode, "unknown");
  assert.equal(layoutCurrentForEngine(bareDoc.pages[0], version, "local-ocr").blocks[0].bid, "bare");
  assert.equal(layoutCurrentForLibrary(bareDoc.pages[0], version, "local-ocr").blocks[0].bid, "bare");
  assert.equal(layoutCurrentForLibrary(bareDoc.pages[0], version, "cloud-ocr").blocks[0].bid, "bare");
  assert.equal(migratedLayoutMode({ textSource: "text-layer" }, { blocks: [] }), "unknown");
  assert.equal(migratedLayoutMode({ source: "local-ocr" }), "local-ocr");
  assert.equal(migratedLayoutMode({ mode: "local-ocr" }), "local-ocr");
  assert.equal(toLibraryRecords({
    pages: [{ page: 1, layout: { blocks: [{ bid: "ocr" }], mode: "cloud-ocr" } }]
  }, "doc-cloud").layouts[0].mode, "cloud-ocr");

  const kept = doc.pages[0].layout;
  let writes = 0;
  const settled = await settleFreshZone({
    hash: "doc-late",
    page: 1,
    version,
    reason: "stored",
    engine: "text-layer",
    cachedRead: () => kept,
    write: async () => { writes += 1; }
  });
  assert.equal(writes, 0);
  assert.equal(settled.recomputed, false);
  assert.equal(settled.layout.blocks[0].bid, "kept");
  let switched = 0;
  const rezoned = await settleFreshZone({
    hash: "doc-switch",
    page: 1,
    version,
    reason: "stored",
    engine: "local-ocr",
    cachedRead: () => kept,
    write: async () => { switched += 1; }
  });
  assert.equal(switched, 1);
  assert.equal(rezoned.recomputed, true);
  assert.equal(rezoned.layout, null);
});

test("a text-layer row is not current for local-ocr, and switching engines zones again", async () => {
  const version = "rev-current";
  const { store } = memoryStore();
  await store.putLayout({
    docHash: "d",
    page: 1,
    mode: "text-layer",
    protocol: "blocks-1",
    layoutRev: version,
    layout: { blocks: [{ bid: "text-layer-block" }], layoutVersion: version, protocol: "blocks-1" }
  });
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: { blocks: [{ bid: "legacy-local-ocr" }], layoutVersion: version } };
        }
      }
    }
  };
  const key = layoutCacheKey({ hash: "d", page: 1, mode: "local-ocr" });
  const got = await readLayoutCache(key, { store });
  assert.equal(got.blocks[0].bid, "legacy-local-ocr");
  assert.equal(layoutCurrentForEngine(got, version, "local-ocr").blocks[0].bid, "legacy-local-ocr");
  assert.notEqual(got.blocks[0].bid, "text-layer-block");
  const textOnly = {
    mode: "text-layer",
    layoutRev: version,
    layout: { blocks: [{ bid: "text-layer-block" }], layoutVersion: version, mode: "text-layer" }
  };
  assert.equal(layoutCurrentForEngine(textOnly, version, "local-ocr"), null);
  assert.equal(layoutCurrentForEngine(textOnly, version, "text-layer").blocks[0].bid, "text-layer-block");
  assert.equal(layoutCurrentForEngine({
    mode: "unknown",
    layout: { blocks: [{ bid: "bare" }], layoutVersion: version, mode: "unknown" }
  }, version, "local-ocr").blocks[0].bid, "bare");
  assert.equal(layoutCurrentForLibrary({
    mode: "unknown",
    layout: { blocks: [{ bid: "bare" }], layoutVersion: version, mode: "unknown" }
  }, version, "cloud-ocr").blocks[0].bid, "bare");
  assert.equal(layoutReadyForZone({
    layout: { blocks: [{ bid: "x" }], layoutVersion: "rev-old" },
    layoutRev: version
  }, version), null);
  const viewer = read("pdf/viewer.js");
  const ingest = viewer.slice(viewer.indexOf("async function ingestVendorLayout"), viewer.indexOf("async function ingestSkippedSourceLayout"));
  assert.match(ingest, /layoutCurrentForEngine\(zone\.cached, version, mode\)/);
  assert.match(ingest, /layoutCurrentForLibrary\(libraryEntry\(n\), version, mode\)/);
  assert.match(viewer, /if \(!layoutServesLibrary\(view, engine\)\) continue/);
  assert.match(viewer, /function stampProducedEngine/);
  assert.match(viewer, /if \(recomputed\) stampProducedEngine\(layout\)/);
  assert.match(viewer, /if \(!fallback\) stampTextLayerEngine\(layout\)/);
  assert.doesNotMatch(viewer.slice(viewer.indexOf("async function ingestTextLayerLayout"), viewer.indexOf("async function renderPageRaster")), /stampProducedEngine\(layout\)/);
  assert.match(viewer, /engineModeOf\(rawLayout\)/);
  assert.match(viewer, /engineModeOf\(raw\)/);
});

test("a mode-less legacy 8765 layout stays current for every engine, as on main", () => {
  const version = "rev-current";
  const legacy = {
    hash: "d",
    pageCount: 1,
    pages: [{
      page: 1,
      pairs: [],
      layout: { blocks: [{ bid: "tl" }], layoutVersion: version, protocol: "blocks-1" }
    }]
  };
  const rec = toLibraryRecords(legacy, "d");
  assert.deepEqual(rec.layouts.map((row) => row.mode), ["unknown"]);
  const doc = libraryDocumentFromRecords(
    { docHash: "d", pageCount: 1 },
    rec.pages.map((page) => ({ ...page, docHash: "d" })),
    rec.layouts
  );
  const page = doc.pages[0];
  assert.equal(page.layout.mode, "unknown");
  for (const engine of ["local-ocr", "text-layer", "cloud-ocr"]) {
    assert.equal(layoutCurrentForLibrary(page, version, engine).blocks[0].bid, "tl", engine);
    assert.equal(layoutCurrentForEngine(page, version, engine).blocks[0].bid, "tl", engine);
  }
  const textRow = libraryDocumentFromRecords(
    { docHash: "e", pageCount: 1 },
    [{ docHash: "e", page: 1, pairs: [] }],
    [{
      docHash: "e",
      page: 1,
      mode: "text-layer",
      protocol: "blocks-1",
      layoutRev: version,
      layout: { blocks: [{ bid: "x" }] }
    }]
  );
  assert.equal(layoutCurrentForLibrary(textRow.pages[0], version, "local-ocr"), null);
  assert.equal(layoutCurrentForLibrary(textRow.pages[0], version, "text-layer").blocks[0].bid, "x");
  const mixed = [
    {
      page: 1,
      mode: "text-layer",
      savedAt: 50,
      protocol: "blocks-1",
      layoutRev: version,
      layout: { blocks: [{ bid: "text-layer-block" }], layoutVersion: version }
    },
    {
      page: 1,
      mode: "local-ocr",
      savedAt: 10,
      protocol: "blocks-1",
      layoutRev: version,
      layout: { blocks: [{ bid: "local-ocr-block" }], layoutVersion: version }
    }
  ];
  assert.equal(selectPageLayout(mixed, 1, "local-ocr").blocks[0].bid, "local-ocr-block");
  assert.equal(selectPageLayout(mixed, 1, "text-layer").blocks[0].bid, "text-layer-block");
  const bare = layoutCurrentForLibrary({
    layout: { blocks: [{ bid: "bare" }], layoutVersion: version }
  }, version, "local-ocr");
  assert.equal(bare.blocks[0].bid, "bare");
  assert.equal(layoutCurrentForEngine({
    blocks: [{ bid: "cache" }],
    layoutVersion: version
  }, version, "local-ocr").blocks[0].bid, "cache");
});

test("a produced engine tag is stored, and a mode-less save stays unknown", async () => {
  const { store } = memoryStore();
  const version = "rev-current";
  await saveLibraryPage({
    hash: "tag",
    title: "标",
    pageCount: 2,
    page: 1,
    mode: "text-layer",
    layoutVersion: version,
    layout: { blocks: [{ bid: "text" }], layoutVersion: version, protocol: "blocks-1" }
  }, { store });
  await saveLibraryPage({
    hash: "tag",
    page: 2,
    layoutVersion: version,
    layout: { blocks: [{ bid: "old" }], layoutVersion: version, protocol: "blocks-1" }
  }, { store });
  assert.equal((await store.getLayout("tag", 1, "text-layer", "blocks-1")).mode, "text-layer");
  assert.equal((await store.getLayout("tag", 2, "unknown", "blocks-1")).mode, "unknown");
  assert.equal(recordedLayoutMode({ mode: "local-ocr", layout: { mode: "unknown" } }), "local-ocr");
  assert.equal(recordedLayoutMode({ layout: { mode: "unknown" } }), "unknown");
  assert.equal(recordedLayoutMode({ layout: { blocks: [] } }), "unknown");
  const doc = libraryDocumentFromRecords(
    { docHash: "tag", pageCount: 2 },
    [{ page: 1, pairs: [] }, { page: 2, pairs: [] }],
    [
      { page: 1, mode: "text-layer", protocol: "blocks-1", layoutRev: version, savedAt: 2, layout: { blocks: [{ bid: "text" }], layoutVersion: version } },
      { page: 2, mode: "unknown", protocol: "blocks-1", layoutRev: version, savedAt: 1, layout: { blocks: [{ bid: "old" }], layoutVersion: version } }
    ],
    "local-ocr"
  );
  assert.equal(layoutCurrentForLibrary(doc.pages[0], version, "local-ocr"), null);
  assert.equal(layoutCurrentForLibrary(doc.pages[1], version, "local-ocr").blocks[0].bid, "old");
});

test("selectPageLayout prefers an unknown or mode-less row over a newer explicit mismatch", () => {
  const version = "rev-current";
  const rows = [
    {
      page: 1,
      mode: "text-layer",
      savedAt: 50,
      protocol: "blocks-1",
      layoutRev: version,
      layout: { blocks: [{ bid: "text" }], layoutVersion: version, mode: "text-layer" }
    },
    {
      page: 1,
      mode: "unknown",
      savedAt: 10,
      protocol: "blocks-1",
      layoutRev: version,
      layout: { blocks: [{ bid: "old" }], layoutVersion: version }
    }
  ];
  const picked = selectPageLayout(rows, 1, "local-ocr");
  assert.equal(picked.blocks[0].bid, "old");
  assert.equal(picked.mode, "unknown");
  const modeless = [
    {
      page: 1,
      mode: "cloud-ocr",
      savedAt: 80,
      protocol: "blocks-1",
      layout: { blocks: [{ bid: "cloud" }], mode: "cloud-ocr" }
    },
    {
      page: 1,
      mode: "",
      savedAt: 5,
      protocol: "blocks-1",
      layout: { blocks: [{ bid: "bare" }] }
    }
  ];
  assert.equal(selectPageLayout(modeless, 1, "local-ocr").blocks[0].bid, "bare");
  const exact = [
    {
      page: 1,
      mode: "local-ocr",
      savedAt: 1,
      protocol: "blocks-1",
      layout: { blocks: [{ bid: "ocr" }], mode: "local-ocr" }
    },
    {
      page: 1,
      mode: "unknown",
      savedAt: 99,
      protocol: "blocks-1",
      layout: { blocks: [{ bid: "old" }] }
    }
  ];
  assert.equal(selectPageLayout(exact, 1, "local-ocr").blocks[0].bid, "ocr");
});

test("stampSessionLayout leaves unknown alone and tags text-layer stand-ins as text-layer", () => {
  const unknown = { mode: "unknown", blocks: [{ bid: "old" }] };
  stampSessionLayout(unknown, "local-ocr");
  assert.equal(unknown.mode, "unknown");
  const quick = { blocks: [{ bid: "q" }] };
  stampSessionLayout(quick, "text-layer");
  assert.equal(quick.mode, "text-layer");
  const emptyKey = { blocks: [{ bid: "e" }] };
  stampSessionLayout(emptyKey, "text-layer");
  assert.equal(emptyKey.mode, "text-layer");
  const vendor = { blocks: [{ bid: "v" }] };
  stampSessionLayout(vendor, "cloud-ocr");
  assert.equal(vendor.mode, "cloud-ocr");
  const fallback = { fallback: { source: "text-layer", reason: "http-502" }, blocks: [] };
  stampSessionLayout(fallback, "local-ocr");
  assert.equal(fallback.mode, undefined);
});

test("Stop during a background fill sends no further translation requests", async () => {
  const fills = createBackgroundSessions();
  const sent = [];
  const done = [];
  const tracked = fills.track(createTranslateSession());
  const job = translateDocumentPages({
    session: tracked.session,
    preserveSession: true,
    numPages: 3,
    docId: 1,
    batchSize: 1,
    cache: translationCacheWhile(createPageCache(), () => tracked.current()),
    includePage: () => tracked.current(),
    getPageOriginals: async (page) => [{ bid: `p${page}`, original: `page ${page} sentence.` }],
    send: async (msg) => {
      sent.push(msg.texts[0]);
      if (sent.length === 1) fills.abortAll();
      return { ok: true, translations: msg.texts.map((text) => `译:${text}`) };
    },
    onPageDone: ({ page }) => {
      if (!tracked.current()) return;
      done.push(page);
    },
    onPageError: ({ page }) => {
      if (!tracked.current()) return;
      done.push(page);
    }
  });
  await job;
  assert.deepEqual(sent, ["page 1 sentence."]);
  assert.deepEqual(done, []);
  const viewer = read("pdf/viewer.js");
  const stop = viewer.slice(viewer.indexOf("function stopTranslateWork"), viewer.indexOf("function resumePendingRetranslate"));
  assert.match(stop, /abortBackgroundFills\(\)/);
  const begin = viewer.slice(viewer.indexOf("function beginViewerSession"), viewer.indexOf("function isCurrentWork"));
  assert.match(begin, /abortBackgroundFills\(\)/);
  const force = viewer.slice(viewer.indexOf("async function forceRetranslateCurrentPage"), viewer.indexOf("function titleStructureFailed"));
  assert.match(force, /abortBackgroundFills\(\)/);
  const adopt = viewer.slice(viewer.indexOf("async function adoptDoc"), viewer.indexOf("async function adoptDoc") + 800);
  assert.match(adopt, /librarySourceSent\.clear\(\)/);
  assert.match(adopt, /abortBackgroundFills\(\)/);
  const close = viewer.slice(viewer.indexOf("function abortInflightLayouts"), viewer.indexOf("function postVendorLayout"));
  assert.match(close, /abortBackgroundFills\(\)/);
  assert.match(viewer, /window\.addEventListener\("pagehide", closeViewerWork\)/);
  assert.match(viewer, /function closeViewerWork\(\)/);
  assert.match(viewer.slice(viewer.indexOf("function closeViewerWork"), viewer.indexOf("function postVendorLayout")), /layoutClosed = true/);
  assert.match(viewer, /function layoutAttemptLive\(epoch\)/);
  assert.match(viewer, /return !layoutClosed && epoch === layoutEpoch && !layoutAbort\.signal\.aborted/);
});

test("Stop cancels a queued vendor layout POST before it is sent or written", async () => {
  const lane = createPrioritySerialLane();
  const sent = [];
  const writes = [];
  let epoch = 0;
  let controller = new AbortController();
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const abortError = () => {
    const error = new Error("layout aborted");
    error.name = "AbortError";
    error.code = "aborted";
    return error;
  };
  const post = (page) => {
    const ticket = epoch;
    const signal = controller.signal;
    return runLaneAttempts(lane, page, async () => {
      if (ticket !== epoch || signal.aborted) throw abortError();
      sent.push(page);
      if (page === 1) await hold;
      if (ticket !== epoch || signal.aborted) throw abortError();
      writes.push({ page, mode: "local-ocr" });
      return { page };
    }, {
      abortError,
      shouldStop: () => ticket !== epoch || signal.aborted
    });
  };
  const first = post(1);
  const waitForSent = Date.now();
  while (!sent.includes(1) && Date.now() - waitForSent < 500) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const second = post(2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, [1]);
  assert.deepEqual(writes, []);
  epoch += 1;
  controller.abort();
  controller = new AbortController();
  lane.reset();
  release();
  const secondResult = await second.catch((error) => error);
  await first.catch(() => {});
  assert.equal(secondResult?.name, "AbortError");
  assert.deepEqual(sent, [1]);
  assert.deepEqual(writes, []);
  const again = await post(2);
  assert.equal(again.page, 2);
  assert.deepEqual(writes, [{ page: 2, mode: "local-ocr" }]);
  const viewer = read("pdf/viewer.js");
  const stop = viewer.slice(viewer.indexOf("function stopTranslateWork"), viewer.indexOf("function resumePendingRetranslate"));
  assert.match(stop, /cancelQueuedVendorLayouts\(\)/);
  assert.doesNotMatch(stop, /layoutClosed = true/);
  const cancel = viewer.slice(viewer.indexOf("function cancelQueuedVendorLayouts"), viewer.indexOf("function abortInflightLayouts"));
  assert.match(cancel, /layoutEpoch \+= 1/);
  assert.match(cancel, /layoutAbort\.abort\(\)/);
  assert.match(cancel, /vendorLayoutLane\.reset\(\)/);
  assert.doesNotMatch(cancel, /layoutClosed = true/);
  const postSource = viewer.slice(viewer.indexOf("function postVendorLayout"), viewer.indexOf("async function ingestVendorLayout"));
  assert.match(postSource, /function postVendorLayout\(page, run, epoch\)/);
  assert.doesNotMatch(postSource, /epoch = layoutEpoch/);
  assert.match(postSource, /docPhase === "stopped" \|\| !layoutAttemptLive\(epoch\)/);
  const ingest = viewer.slice(viewer.indexOf("async function ingestVendorLayout"), viewer.indexOf("async function ingestSkippedSourceLayout"));
  assert.match(ingest, /docPhase === "stopped" \|\| !layoutAttemptLive\(epoch\) \|\| isStale\(\)/);
  assert.match(ingest, /postVendorLayout\(n,/);
  assert.ok(ingest.indexOf('if (docPhase === "stopped" || !layoutAttemptLive(epoch) || isStale())') < ingest.indexOf("postVendorLayout(n,"));
  assert.match(ingest, /if \(!layoutAttemptLive\(epoch\)\) return Promise\.resolve\(\)/);
  assert.match(ingest, /if \(recomputed && !layoutAttemptLive\(epoch\)\) return null/);
  const retry = viewer.slice(viewer.indexOf("async function retryPendingVendorLayouts"), viewer.indexOf("async function ingestPageLayout"));
  assert.match(retry, /docPhase === "stopped" \|\| !Number\.isFinite\(epoch\)/);
  assert.doesNotMatch(retry, /: layoutEpoch/);
  assert.ok(retry.indexOf("layoutAttemptLive(epoch)") < retry.indexOf("await layoutVersionNow()"));
  assert.match(viewer, /const layoutScheduled = layoutEpoch/);
  assert.match(viewer, /!layoutAttemptLive\(layoutScheduled\)/);
  assert.match(viewer, /retryPendingVendorLayouts\(staleWork, \{ \.\.\.options, epoch: layoutScheduled \}\)/);
  const zone = viewer.slice(viewer.indexOf("async function zoneForRetranslate"), viewer.indexOf("async function forceRetranslateCurrentPage"));
  assert.match(zone, /const epoch = layoutEpoch/);
  assert.match(zone, /ingestVendorLayout\(page, mode,/);
  const force = viewer.slice(viewer.indexOf("async function forceRetranslateCurrentPage"), viewer.indexOf("function titleStructureFailed"));
  assert.match(force, /zoneForRetranslate\(targetPage, work\)/);
  assert.doesNotMatch(force, /layoutClosed = true/);
  const notes = read("lib/notes-store.js");
  assert.match(notes, /storageOpenInflight\(NOTES_DB_NAME\)/);
  assert.match(notes, /await waitForNotesUpgrade\(\)/);
});

test("retranslating a page during its fill-in translates it once", async () => {
  const fills = createBackgroundSessions();
  const cache = createPageCache();
  const applied = [];
  const fillSent = [];
  const tracked = fills.track(createTranslateSession());
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const fill = translateDocumentPages({
    session: tracked.session,
    preserveSession: true,
    numPages: 1,
    docId: 7,
    batchSize: 1,
    cache: translationCacheWhile(cache, () => tracked.current()),
    includePage: () => tracked.current(),
    getPageOriginals: async () => [
      { bid: "a", original: "Alpha sentence." },
      { bid: "b", original: "Beta sentence." }
    ],
    send: async (msg) => {
      fillSent.push(msg.texts[0]);
      if (msg.texts[0].startsWith("Alpha")) {
        release();
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      if (!tracked.current()) return { ok: false, translations: [] };
      return { ok: true, translations: msg.texts.map((text) => `fill:${text}`) };
    },
    onPageDone: ({ results }) => {
      if (!tracked.current()) return;
      applied.push(results.map((row) => row.translation).join("|"));
    },
    onPageError: () => {
      if (!tracked.current()) return;
      applied.push("fill-error");
    }
  });
  await hold;
  fills.abortAll();
  const again = await translateDocumentPages({
    session: createTranslateSession(),
    numPages: 1,
    docId: 7,
    batchSize: 8,
    cache,
    getPageOriginals: async () => [
      { bid: "a", original: "Alpha sentence." },
      { bid: "b", original: "Beta sentence." }
    ],
    send: async (msg) => ({ ok: true, translations: msg.texts.map((text) => `译:${text}`) }),
    onPageDone: ({ results }) => {
      applied.push(results.map((row) => row.translation).join("|"));
    }
  });
  await fill;
  assert.deepEqual(fillSent, ["Alpha sentence."]);
  assert.equal(applied.length, 1);
  assert.equal(applied[0], "译:Alpha sentence.|译:Beta sentence.");
  assert.equal(cache.get(7, 1).map((row) => row.translation).join("|"), applied[0]);
  assert.equal(again.aborted, false);
});

test("retranslating page 2 does not wait on other stale layouts", async () => {
  const layoutMs = 40;
  const { blocking, background } = layoutRetrySplit(6, 2);
  assert.deepEqual(blocking, [2]);
  assert.deepEqual(background, [1, 3, 4, 5, 6]);
  const lane = createPrioritySerialLane();
  const order = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const started = performance.now();
  await Promise.all(blocking.map((page) => lane.run(page, async () => {
    order.push(page);
    await sleep(layoutMs);
  }, { priority: true })));
  const rest = Promise.all(background.map((page) => lane.run(page, async () => {
    order.push(page);
    await sleep(layoutMs);
  })));
  await sleep(30);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < layoutMs + 150, `page 2 retranslate waited ${elapsed}ms`);
  assert.ok(elapsed < background.length * layoutMs, elapsed);
  await rest;
  assert.equal(order[0], 2);
  const queued = createPrioritySerialLane();
  const jumped = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queued.run(1, async () => {
    jumped.push(1);
    await gate;
  });
  const later = queued.run(3, async () => { jumped.push(3); });
  const current = queued.run(2, async () => { jumped.push(2); }, { priority: true });
  release();
  await Promise.all([first, later, current]);
  assert.deepEqual(jumped, [1, 2, 3]);
  const viewer = read("pdf/viewer.js");
  const job = viewer.slice(viewer.indexOf("async function translateWholeDocument"), viewer.indexOf("function snapshotForceReadout"));
  assert.match(job, /startDocumentLayoutRetry\(/);
  assert.match(job, /await layoutPass\.blocking/);
  assert.match(job, /void layoutPass\.background/);
  assert.match(job, /backgroundSessions\.track\(createTranslateSession\(\)\)/);
  assert.match(job, /needs\.includes\(page\) && fillAlive\(\)/);
  assert.match(job, /onPageDone\(payload\)/);
  assert.match(job, /!isCurrentWork\(work, gen, translatingDoc\)/);
  assert.equal(job.includes("void retryPendingVendorLayouts"), false);
  const lanePost = viewer.slice(viewer.indexOf("function postVendorLayout"), viewer.indexOf("async function ingestVendorLayout"));
  assert.match(lanePost, /runLaneAttempts\(/);
  assert.match(lanePost, /maxAttempts: 1/);
});

test("retranslating page 2 with several stale layouts finishes with the page on screen", async () => {
  const layoutMs = 40;
  const session = { running: true };
  const posts = [];
  const filled = [];
  const lane = createPrioritySerialLane();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pass = startDocumentLayoutRetry({
    total: 6,
    viewing: 2,
    isStale: () => false,
    retryLayouts: async ({ onlyPage = 0, skipPage = 0 } = {}) => {
      const pages = [];
      for (let page = 1; page <= 6; page += 1) {
        if (onlyPage && page !== onlyPage) continue;
        if (skipPage && page === skipPage) continue;
        pages.push(page);
      }
      const upgraded = [];
      for (const page of pages) {
        await lane.run(page, async () => {
          posts.push(page);
          await sleep(layoutMs);
        }, { priority: page === 2 });
        upgraded.push(page);
      }
      return upgraded;
    },
    adoptUpgraded: async (pages) => {
      filled.push(...pages);
    }
  });
  const started = performance.now();
  await pass.blocking;
  session.running = false;
  const blockedMs = performance.now() - started;
  assert.ok(blockedMs < layoutMs + 150, `page 2 waited ${blockedMs}ms`);
  assert.equal(session.running, false);
  assert.deepEqual(posts, [2]);
  assert.deepEqual(filled, [2]);
  const retranslateStarted = performance.now();
  await sleep(30);
  const retranslateMs = performance.now() - retranslateStarted;
  assert.ok(retranslateMs < layoutMs + 80, `retranslate waited ${retranslateMs}ms`);
  assert.ok(posts.length < 6, `background finished before retranslate ${posts}`);
  await pass.background;
  assert.deepEqual(filled.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

test("a background layout retry does not hold the lane through its backoff", async () => {
  const lane = createPrioritySerialLane();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const background = runLaneAttempts(lane, 1, async (attempt) => {
    order.push(`bg-${attempt}`);
    if (attempt === 0) {
      await gate;
      const error = new Error("down");
      error.status = 503;
      throw error;
    }
    return "bg-ok";
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = performance.now();
  const foreground = runLaneAttempts(lane, 2, async () => {
    order.push("fg");
    return "fg-ok";
  }, { priority: true });
  release();
  assert.equal(await foreground, "fg-ok");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < LAYOUT_RETRY_DELAYS_MS[0], `on-screen page waited ${elapsed}ms`);
  assert.deepEqual(order.slice(0, 2), ["bg-0", "fg"]);
  assert.equal(await background, "bg-ok");
});

test("an update stays an update when the note id used to look temporary", async () => {
  const pending = createPendingNotes({ tabId: "tab-id", now: () => 40 });
  const id = crypto.randomUUID();
  await pending.stage("doc-id", { id, body: "已保存", op: "update", page: 1 });
  const rows = await pending.list("doc-id");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].op, "update");
  assert.equal(rows[0].noteId, id);
  assert.equal(rows[0].tempId, undefined);
  await pending.stage("doc-tmp", { id: "tmp-old", body: "旧", op: "update" });
  const legacy = await pending.list("doc-tmp");
  assert.equal(legacy[0].op, "update");
  assert.equal(legacy[0].noteId, "tmp-old");
  const notes = read("pdf/notes-panel.js");
  const keyFn = notes.slice(notes.indexOf("function editorKey"), notes.indexOf("async function commitEditor"));
  assert.match(keyFn, /crypto\.randomUUID\(\)/);
  assert.doesNotMatch(keyFn, /tmp-/);
});

test("a stopped layout port surfaces the zoning failure before the retry budget ends", async () => {
  let noticed = 0;
  const sleeps = [];
  await assert.rejects(
    () => fetchLocalEnvelope({
      page: 1,
      imageBase64: "abc",
      fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
      sleep: async (ms) => { sleeps.push(ms); },
      onNetworkFailure() { noticed += 1; }
    }),
    /Failed to fetch/
  );
  assert.equal(noticed, 1);
  assert.equal(sleeps.length, LAYOUT_RETRY_DELAYS_MS.length);
  const viewer = read("pdf/viewer.js");
  assert.match(viewer, /const notify = \(\) => \{[\s\S]*layoutNotice = LAYOUT_FALLBACK_STATUS/);
  assert.match(viewer, /function clearLayoutFallbackStatus\(\)/);
  assert.match(viewer, /textContent === LAYOUT_FALLBACK_STATUS/);
  assert.match(viewer, /const stale = Boolean\(entry && hasStored && version && !layoutCurrentForLibrary\(entry, version, mode\)\)/);
  const retranslate = viewer.slice(
    viewer.indexOf("async function forceRetranslateCurrentPage"),
    viewer.indexOf("function titleStructureFailed")
  );
  const rememberAt = retranslate.indexOf("rememberTranslation(");
  const doneAt = retranslate.indexOf("PDF_COPY.retranslateDone");
  assert.ok(rememberAt > 0 && doneAt > rememberAt);
});

function installFakeLocks() {
  const held = new Set();
  const waiters = new Map();
  const previous = globalThis.navigator;
  function pump(name) {
    const queue = waiters.get(name);
    if (!queue?.length || held.has(name)) return;
    grant(name, queue.shift());
    if (!queue.length) waiters.delete(name);
  }
  function grant(name, job) {
    if (job.options?.ifAvailable && held.has(name)) {
      Promise.resolve().then(() => job.callback(null)).then(job.resolve, job.reject);
      return;
    }
    if (held.has(name)) {
      const queue = waiters.get(name) || [];
      queue.push(job);
      waiters.set(name, queue);
      return;
    }
    held.add(name);
    let settled;
    try {
      settled = job.callback({});
    } catch (error) {
      held.delete(name);
      job.reject(error);
      pump(name);
      return;
    }
    Promise.resolve(settled).then((value) => {
      held.delete(name);
      job.resolve(value);
      pump(name);
    }, (error) => {
      held.delete(name);
      job.reject(error);
      pump(name);
    });
  }
  const locks = {
    request(name, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      return new Promise((resolve, reject) => {
        grant(name, { options: options || {}, callback, resolve, reject });
      });
    }
  };
  const base = previous && typeof previous === "object" ? previous : {};
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "locks") return locks;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: proxy
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  };
}

function hangingFactory(onOpen) {
  const box = { req: null, factory: null };
  box.factory = {
    open() {
      const request = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null
      };
      box.req = request;
      onOpen?.(request);
      return request;
    }
  };
  return box;
}

function hexChannels(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((ch) => ch + ch).join("") : value;
  return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16));
}

function channel(value) {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const [r, g, b] = hexChannels(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const left = luminance(a);
  const right = luminance(b);
  const [hi, lo] = left >= right ? [left, right] : [right, left];
  return (hi + 0.05) / (lo + 0.05);
}

function composite(rgba, background) {
  const [r, g, b, alpha] = rgba;
  const base = hexChannels(background);
  const mixed = base.map((item, index) => Math.round(item * (1 - alpha) + [r, g, b][index] * alpha));
  return `#${mixed.map((item) => item.toString(16).padStart(2, "0")).join("")}`;
}
