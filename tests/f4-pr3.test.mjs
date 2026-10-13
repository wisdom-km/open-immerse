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
  currentLayoutIfArrived,
  fetchLibraryDocument,
  flushPendingPages,
  mergeLibraryPairs,
  mergeStoredPagePairs,
  paperFullyInLibrary,
  preferArrivedLayout,
  saveLibraryPage,
  shouldProbeLocalService,
  translationWaitsForLibrary,
  withLibraryDocLock,
  resolveZoneForVendor,
  settleFreshZone,
  waitForFirstZone,
  whenZoneReadSettles
} from "../lib/pdf-library.js";
import { layoutCacheKey, storedLayoutCurrent } from "../lib/pdf-layout-client.js";
import { readLayoutCache, writeLayoutCache } from "../lib/pdf-layout-cache.js";
import { createLibraryChip } from "../lib/library-chip.js";
import { PERSIST_CARD_SESSION_KEY, createPersistCard, readPersistCardState } from "../lib/persist-card.js";
import { createLibrarySession } from "../lib/library-session.js";
import { NOTES_PERSIST_HINT_KEY } from "../lib/notes-prefs.js";
import { NOTES_HINT_DOC_PREFIX } from "../lib/reader-notes-local.js";
import { bindPendingUnload, createPendingNotes, pendingNotesKey } from "../lib/pending-notes.js";
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
      return String(node.textContent || "");
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
  stop();
  channel.close();
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
  assert.match(notesCss, /\.oi-store-banner[\s\S]*border-left:\s*3px solid var\(--oi-reader-warn\)/);
  assert.match(notesCss, /\.oi-store-banner[\s\S]*background:\s*var\(--oi-reader-warn-soft\)/);
  const chipRule = viewerCss.slice(viewerCss.indexOf(".toolbar button.oi-lib-chip {"), viewerCss.indexOf(".toolbar button.oi-lib-chip:hover"));
  assert.match(chipRule, /background:\s*var\(--oi-reader-well\)/);
  assert.doesNotMatch(chipRule, /box-shadow/);
  assert.doesNotMatch(chipRule, /(^|\n)\s*border\s*:/);
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
  assert.match(fn, /resolveZoneForVendor/);
  assert.ok(fn.indexOf("resolveZoneForVendor") < fn.indexOf("runVendorLayoutHttp"));
  assert.match(fn, /settleFreshZone/);
  assert.match(fn, /currentLayoutIfArrived/);
  const savedFn = viewer.slice(
    viewer.indexOf("async function savedTranslationFor"),
    viewer.indexOf("function savedPageStatus")
  );
  assert.match(savedFn, /waitForFirstZone/);
  assert.match(savedFn, /translationWaitsForLibrary\(zone\)/);
  assert.match(savedFn, /if \(!libraryProbe\) void ensureLibraryDocument\(\)/);
  assert.match(savedFn, /await ensureLibraryDocument\(\)/);
  assert.doesNotMatch(savedFn, /if \(!libraryDoc \|\| libraryDoc\.hash !== hash\) await ensureLibraryDocument\(\)/);

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

test("persist refusal shows the card, and the T2b key wins when it exists", async () => {
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
  data[LIBRARY_PERSIST_HINT_KEY] = true;
  assert.equal((await readPersistCardState(local, "doc-1")).show, false);
  data[`${NOTES_HINT_DOC_PREFIX}doc-1`] = false;
  assert.equal((await readPersistCardState(local, "doc-1")).dismissed, false);
  assert.equal((await readPersistCardState(local, "doc-1")).show, true);
  data[`${NOTES_HINT_DOC_PREFIX}doc-1`] = true;
  assert.equal((await readPersistCardState(local, "doc-1")).show, false);
  delete data[`${NOTES_HINT_DOC_PREFIX}doc-1`];
  data[NOTES_PERSIST_HINT_KEY] = JSON.stringify({ "doc-2": true });
  assert.equal((await readPersistCardState(local, "doc-1")).show, true);
  assert.equal((await readPersistCardState(local, "doc-2")).show, false);
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
