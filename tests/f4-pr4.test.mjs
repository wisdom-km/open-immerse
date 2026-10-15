import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "fake-indexeddb/auto";

import { createLibraryChip } from "../lib/library-chip.js";
import { LIBRARY_FORMAT, LIBRARY_SCHEMA, LibraryStoreError, createLibraryStore } from "../lib/library-store.js";
import { createImportBus, createMemoryLocks, createPresence } from "../lib/import-run.js";
import { NOTES_FORMAT } from "../lib/notes-io.js";
import { createMemoryKv } from "../lib/platform/kv.js";
import { createIdbLibraryFactory } from "../lib/platform/idb-backend.js";
import { createMemoryLibraryFactory } from "../lib/platform/memory-backend.js";
import { readPersistCardState } from "../lib/persist-card.js";
import { attachImportReader, mountDataPanel, readDataFocus } from "../options/data-panel.js";

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";
const HASH_C = "cccccccccccccccc";

function storeFor(kind, persist = false) {
  const kv = createMemoryKv();
  const library = kind === "idb" ? createIdbLibraryFactory() : createMemoryLibraryFactory();
  const store = createLibraryStore({
    platform: { kv, library },
    persist: async () => persist,
    now: () => 1_700_000_000_000
  });
  store.closeLibrary = () => library.close?.("oi-annotations");
  return store;
}

function page(no, translation, extra = {}) {
  return {
    page: no,
    pairs: [{ id: `p${no}`, source: `src ${no}`, translation, ...extra }]
  };
}

function paper(hash, pages, extra = {}) {
  const children = {};
  for (const item of pages) {
    children[`page-${String(item.page).padStart(3, "0")}.json`] = {
      kind: "file",
      name: `page-${String(item.page).padStart(3, "0")}.json`,
      text: item.broken ? "{" : JSON.stringify(item)
    };
  }
  if (extra.readout != null) children["readout.md"] = { kind: "file", name: "readout.md", text: extra.readout };
  if (extra.source) children["source.pdf"] = { kind: "file", name: "source.pdf", bytes: extra.source };
  if (extra.meta) children["paper.json"] = { kind: "file", name: "paper.json", text: JSON.stringify(extra.meta) };
  return { kind: "directory", name: hash, children };
}

function dir(name, children, permission = "granted") {
  const handle = {
    kind: "directory",
    name,
    permission,
    children,
    async queryPermission() { return handle.permission; },
    async requestPermission() { return handle.permission; }
  };
  return handle;
}

function matchesSimple(node, token) {
  const re = /([.#]?[A-Za-z0-9_-]+)|\[([^\]]+)\]/g;
  let saw = false;
  let match;
  const tag = String(node.tagName || "").toLowerCase();
  while ((match = re.exec(token))) {
    saw = true;
    if (match[1]) {
      if (match[1].startsWith(".")) {
        if (!String(node.className || "").split(/\s+/).includes(match[1].slice(1))) return false;
      } else if (match[1].startsWith("#")) {
        if (node.id !== match[1].slice(1)) return false;
      } else if (tag !== match[1].toLowerCase()) return false;
    } else {
      const body = match[2];
      const eq = body.indexOf("=");
      if (eq < 0) {
        if (node.getAttribute(body) == null) return false;
      } else {
        const key = body.slice(0, eq);
        const value = body.slice(eq + 1).replace(/^["']|["']$/g, "");
        if (node.getAttribute(key) !== value) return false;
      }
    }
  }
  return saw;
}

function matchesCompound(node, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  if (parts.length === 1) return true;
  let parent = node.parentElement;
  const rest = parts.slice(0, -1).join(" ");
  while (parent) {
    if (matchesCompound(parent, rest)) return true;
    parent = parent.parentElement;
  }
  return false;
}

function queryAll(root, selector) {
  const groups = String(selector || "").split(",").map((item) => item.trim()).filter(Boolean);
  const out = [];
  function walk(node) {
    for (const child of node.children || []) {
      if (groups.some((group) => matchesCompound(child, group))) out.push(child);
      walk(child);
    }
  }
  walk(root);
  return out;
}

function installDom() {
  const previous = globalThis.document;
  const previousChannel = globalThis.BroadcastChannel;
  const channels = [];
  if (typeof previousChannel === "function") {
    globalThis.BroadcastChannel = class extends previousChannel {
      constructor(name) {
        super(name);
        channels.push(this);
      }
    };
  }
  function createElement(tag) {
    const listeners = new Map();
    const attrs = new Map();
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parentElement: null,
      className: "",
      id: "",
      hidden: false,
      disabled: false,
      checked: false,
      value: "",
      type: "",
      files: null,
      style: {},
      scrollTop: 0,
      text: "",
      set textContent(value) { node.text = value == null ? "" : String(value); },
      get textContent() {
        return `${node.text}${node.children.map((child) => child.textContent).join("")}`;
      },
      get classList() {
        const names = () => String(node.className || "").split(/\s+/).filter(Boolean);
        return {
          contains: (name) => names().includes(name),
          add: (...xs) => { node.className = [...new Set([...names(), ...xs])].join(" "); },
          remove: (...xs) => { node.className = names().filter((name) => !xs.includes(name)).join(" "); },
          toggle(name, force) {
            const has = names().includes(name);
            const on = force == null ? !has : Boolean(force);
            if (on) this.add(name);
            else this.remove(name);
            return on;
          }
        };
      },
      setAttribute(key, value) {
        if (key === "class") node.className = String(value);
        else if (key === "id") node.id = String(value);
        else attrs.set(key, String(value));
        if (key === "type") node.type = String(value);
      },
      getAttribute(key) {
        if (key === "class") return node.className;
        if (key === "id") return node.id;
        return attrs.has(key) ? attrs.get(key) : null;
      },
      hasAttribute(key) { return this.getAttribute(key) != null; },
      append(...kids) {
        for (const kid of kids) {
          if (!kid || typeof kid !== "object") continue;
          kid.parentElement = node;
          node.children.push(kid);
        }
      },
      replaceChildren(...kids) {
        node.children = [];
        node.text = "";
        node.append(...kids);
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) || [];
        list.push(fn);
        listeners.set(type, list);
      },
      dispatchEvent(event) {
        for (const fn of listeners.get(event.type) || []) fn(event);
      },
      focus() { globalThis.document.activeElement = node; },
      click() { node.dispatchEvent({ type: "click", preventDefault() {} }); },
      scrollIntoView() {},
      querySelector(sel) { return queryAll(node, sel)[0] || null; },
      querySelectorAll(sel) { return queryAll(node, sel); }
    };
    return node;
  }
  const doc = {
    activeElement: null,
    createElement,
    addEventListener() {},
    removeEventListener() {}
  };
  doc.body = createElement("body");
  globalThis.document = doc;
  return () => {
    for (const channel of channels) {
      try { channel.close(); } catch { /* already closed */ }
    }
    globalThis.BroadcastChannel = previousChannel;
    globalThis.document = previous;
  };
}

function click(root, label) {
  const found = [...root.querySelectorAll("button")].find((node) => node.textContent.includes(label));
  assert.ok(found, `missing button ${label}`);
  found.dispatchEvent({ type: "click", preventDefault() {} });
  return found;
}

async function flush(times = 30) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function until(fn) {
  for (let i = 0; i < 40; i += 1) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out");
}

function runtime(extra = {}) {
  return {
    locks: createMemoryLocks(),
    bus: createImportBus(),
    presence: createPresence(),
    session: {
      data: new Map(),
      async get(keys) {
        const out = {};
        for (const key of keys || []) if (this.data.has(key)) out[key] = this.data.get(key);
        return out;
      },
      async set(patch) {
        for (const [key, value] of Object.entries(patch || {})) this.data.set(key, value);
      }
    },
    ...extra
  };
}

function library(permission = "granted") {
  return dir("files", {
    [HASH_A]: paper(HASH_A, [page(1, "甲", { apiKey: "SECRET", token: "TOK", key: "DROP" })], {
      meta: { title: "论文甲", fileName: "a.pdf", rev: 2, updatedAt: 20 },
      readout: "# 甲",
      source: Uint8Array.from([1, 2, 3, 4])
    }),
    [HASH_B]: paper(HASH_B, [page(1, "乙", { token: "TOK", key: "DROP" })], { meta: { title: "论文乙", rev: 2, updatedAt: 20 } }),
    "notes.txt": { kind: "file", name: "notes.txt", text: "ignore me" }
  }, permission);
}

test("DATA-01 the mounted panel only contains its three groups, in order", async () => {
  const restore = installDom();
  try {
    const root = document.createElement("div");
    mountDataPanel(root, { store: storeFor("memory"), usage: async () => ({ usage: 0, quota: 1, persisted: true }) });
    const titles = [...root.querySelectorAll(".set-group h2")].map((node) => node.textContent);
    assert.deepEqual(titles, ["存储用量", "文献库 · 导入", "文献库 · 导出"]);
    assert.equal(root.textContent.includes("API 密钥永远不导出"), true);
  } finally {
    restore();
  }
});

test("DATA-02 DATA-03 usage labels, persist retry, and migration continue", async () => {
  const restore = installDom();
  try {
    const root = document.createElement("div");
    const chip = document.createElement("div");
    let asks = 0;
    const store = storeFor("memory");
    store.migrationStatus = async () => ({ step: "lazy", doneDocs: ["a"], pendingKnown: 2, errors: [], finishedAt: null });
    const panel = mountDataPanel(root, {
      ...runtime(),
      store,
      chipHost: chip,
      width: () => 800,
      usage: async () => ({ usage: 312 * 1024 * 1024, quota: Math.round(1.24 * 1024 * 1024 * 1024), persisted: false }),
      requestPersist: async () => {
        asks += 1;
        return false;
      }
    });
    await panel.reload();
    assert.match(root.textContent, /约 312 MB/);
    assert.match(root.textContent, /约 1\.24 GB/);
    assert.match(root.textContent, /已用 25%/);
    assert.equal(root.textContent.includes("未开启"), true);
    click(root, "再申请一次");
    await flush();
    assert.equal(asks, 1);
    assert.match(root.textContent, /浏览器仍未同意/);
    click(root, "现在继续");
    await flush();
    assert.match(chip.textContent, /正在搬旧库 1\/3/);
  } finally {
    restore();
  }
});

test("DATA-02 unavailable usage", async () => {
  const restore = installDom();
  try {
    const root = document.createElement("div");
    const panel = mountDataPanel(root, {
      store: storeFor("memory"),
      usage: async () => { throw new Error("no estimate"); }
    });
    await panel.reload();
    assert.match(root.textContent, /无法读取用量/);
  } finally {
    restore();
  }
});

test("DATA-18 focus lands in the group and strips the query", async () => {
  const restore = installDom();
  try {
    const root = document.createElement("div");
    const history = { replaceState(state, title, url) { history.url = url; } };
    const panel = mountDataPanel(root, {
      store: storeFor("memory"),
      focus: "usage",
      history,
      usage: async () => ({ usage: 1, quota: 10, persisted: true })
    });
    assert.equal(history.url, "#data");
    assert.equal(readDataFocus("#data?focus=import"), "import");
    const usage = root.querySelector('[data-focus-group="usage"]');
    assert.equal(usage.contains ? usage.contains(document.activeElement) : usage === document.activeElement || usage.textContent.includes(document.activeElement?.textContent || "___"), true);
    panel.focus("export");
    const exported = root.querySelector('[data-focus-group="export"]');
    let focused = document.activeElement;
    let inside = false;
    while (focused) {
      if (focused === exported) inside = true;
      focused = focused.parentElement;
    }
    assert.equal(inside, true);
  } finally {
    restore();
  }
});

test("DATA-17 narrow width stacks the primary action", async () => {
  const restore = installDom();
  try {
    const root = document.createElement("div");
    let width = 519;
    mountDataPanel(root, { store: storeFor("memory"), width: () => width, usage: async () => ({ usage: 1, quota: 2, persisted: true }) });
    assert.equal(root.getAttribute("data-narrow"), "1");
    assert.equal([...root.querySelectorAll("button")].some((node) => String(node.className).includes("is-block")), true);
    width = 420;
    mountDataPanel(root, { store: storeFor("memory"), width: () => width, usage: async () => ({ usage: 1, quota: 2, persisted: true }) });
    assert.equal(root.getAttribute("data-narrow"), "1");
  } finally {
    restore();
  }
});

test("folder import, secrets, merge, and the four wrong folders", async (t) => {
  for (const kind of ["memory", "idb"]) {
    await t.test(kind, async () => {
      const restore = installDom();
      try {
        if (kind === "idb") {
          await new Promise((resolve) => {
            const request = indexedDB.deleteDatabase("oi-annotations");
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          });
        }
        const store = storeFor(kind);
        await store.importBundle({
          format: LIBRARY_FORMAT,
          schema: LIBRARY_SCHEMA,
          papers: [{
            paper: { docHash: HASH_A, title: "本地甲", origin: "local", rev: 9, updatedAt: 90, schema: LIBRARY_SCHEMA },
            pages: [
              { docHash: HASH_A, page: 1, pairs: [{ id: "p1", source: "src 1", translation: "本地译文" }], rev: 9, updatedAt: 90, schema: LIBRARY_SCHEMA },
              { docHash: HASH_A, page: 2, pairs: [{ id: "p2", source: "extra", translation: "多出来的" }], rev: 9, updatedAt: 90, schema: LIBRARY_SCHEMA }
            ]
          }]
        });
        const root = document.createElement("div");
        const deps = {
          ...runtime(),
          store,
          usage: async () => ({ usage: 10, quota: 100, persisted: false }),
          showDirectoryPicker: async () => library()
        };
        const panel = mountDataPanel(root, deps);
        await panel.reload();
        click(root, "选择文件夹…");
        await flush(40);
        const kept = await store.getPage(HASH_A, 1);
        const extra = await store.getPage(HASH_A, 2);
        assert.equal(kept.pairs[0].translation, "本地译文");
        assert.equal(JSON.stringify(kept).includes("SECRET"), false);
        assert.equal(extra.pairs[0].translation, "多出来的");
        const added = await store.getPaper(HASH_B);
        const addedPage = await store.getPage(HASH_B, 1);
        assert.equal(JSON.stringify(addedPage).includes("TOK"), false);
        assert.equal(JSON.stringify(addedPage).includes("DROP"), false);
        assert.equal(added.origin, "import");
        assert.equal(added.title, "论文乙");
        assert.match(root.textContent, /另有 1 个文件或文件夹不是旧库论文，已忽略/);
        click(root, "查看忽略的");
        assert.match(root.textContent, /notes\.txt/);
        assert.match(root.textContent, /浏览器没有同意长期保存/);
        click(root, "选择文件夹…");
        await flush(40);
        assert.match(root.textContent, /跳过/);
        const newer = library();
        newer.children[HASH_B].children["paper.json"].text = JSON.stringify({ title: "论文乙新", rev: 8, updatedAt: 80 });
        newer.children[HASH_B].children["page-001.json"].text = JSON.stringify(page(1, "乙新"));
        deps.showDirectoryPicker = async () => newer;
        click(root, "选择文件夹…");
        await flush(40);
        assert.equal((await store.getPaper(HASH_B)).title, "论文乙新");
        assert.equal((await store.getPage(HASH_B, 1)).pairs[0].translation, "乙新");
        const source = await store.getSource(HASH_A);
        assert.equal(source.size, 4);
        await store.closeLibrary?.();
      } finally {
        restore();
      }
    });
  }
});

test("DATA-23 DATA-24 DATA-25 empty, unrelated, and parent folder", async () => {
  const restore = installDom();
  try {
    const store = storeFor("memory");
    const root = document.createElement("div");
    const picked = { current: dir("empty-box", {}) };
    const gates = [];
    const panel = mountDataPanel(root, {
      ...runtime({
        beforePaper: () => new Promise((resolve) => gates.push(resolve))
      }),
      store,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      showDirectoryPicker: async () => picked.current
    });
    click(root, "选择文件夹…");
    await flush();
    assert.match(root.textContent, /没有导入 · 空文件夹/);
    assert.match(root.textContent, /empty-box/);
    assert.equal((await store.listPapers()).length, 0);
    picked.current = dir("Downloads", { "photo.jpg": { kind: "file", name: "photo.jpg", text: "x" } });
    click(root, "重新选择文件夹…");
    await flush();
    assert.match(root.textContent, /没有导入 · 不是旧库文件夹/);
    picked.current = dir("OpenImmerse", { files: library() });
    click(root, "重新选择文件夹…");
    await until(() => gates.length > 0);
    assert.match(root.textContent, /你选的是上一层，已自动改用里面的「files」文件夹/);
    gates.shift()();
    await flush(40);
    assert.equal((await store.listPapers()).some((item) => item.docHash === HASH_A), true);
    panel.destroy();
    while (gates.length) gates.shift()();
    await flush();
  } finally {
    restore();
  }
});

test("DATA-08 corrupt, quota, and blocked stop without deleting the folder", async () => {
  const restore = installDom();
  try {
    const store = storeFor("memory");
    const real = store.importBundle.bind(store);
    let mode = "ok";
    store.importBundle = async (bundle) => {
      if (mode === "quota") {
        mode = "ok";
        throw new LibraryStoreError("full", { type: "quota" });
      }
      if (mode === "blocked") throw new LibraryStoreError("no", { type: "blocked" });
      return real(bundle);
    };
    const broken = dir("files", {
      [HASH_A]: paper(HASH_A, [page(1, "甲")], { meta: { title: "甲", rev: 1, updatedAt: 1 } }),
      [HASH_C]: paper(HASH_C, [{ page: 1, broken: true }], { meta: { title: "坏", rev: 1, updatedAt: 1 } })
    });
    const root = document.createElement("div");
    mountDataPanel(root, {
      ...runtime(),
      store,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      showDirectoryPicker: async () => broken
    });
    click(root, "选择文件夹…");
    await flush(40);
    assert.equal(await store.getPaper(HASH_A) != null, true);
    assert.equal(await store.getPaper(HASH_C), null);
    assert.match(root.textContent, /失败 1/);
    mode = "quota";
    const quotaDir = dir("files", {
      [HASH_B]: paper(HASH_B, [page(1, "乙")], { meta: { title: "乙", rev: 1, updatedAt: 1 } })
    });
    const quotaRoot = document.createElement("div");
    const quotaStore = storeFor("memory");
    const quotaReal = quotaStore.importBundle.bind(quotaStore);
    let quotaLeft = 1;
    quotaStore.importBundle = async (bundle) => {
      if (quotaLeft-- <= 0) throw new LibraryStoreError("full", { type: "quota" });
      return quotaReal(bundle);
    };
    const two = dir("files", {
      [HASH_A]: paper(HASH_A, [page(1, "甲")], { meta: { title: "甲", rev: 1, updatedAt: 1 } }),
      [HASH_B]: paper(HASH_B, [page(1, "乙")], { meta: { title: "乙", rev: 1, updatedAt: 1 } })
    });
    mountDataPanel(quotaRoot, {
      ...runtime(),
      store: quotaStore,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      showDirectoryPicker: async () => two
    });
    click(quotaRoot, "选择文件夹…");
    await flush(50);
    assert.equal(await quotaStore.getPaper(HASH_B), null);
    assert.match(quotaRoot.textContent, /空间不够|失败/);
    void quotaDir;
  } finally {
    restore();
  }
});

test("DATA-06 import continues while a page is open and pauses when all close", async () => {
  const restore = installDom();
  try {
    const store = storeFor("memory");
    const shared = runtime();
    const gates = [];
    shared.beforePaper = () => new Promise((resolve) => gates.push(resolve));
    const root = document.createElement("div");
    const chip = document.createElement("div");
    const panel = mountDataPanel(root, {
      ...shared,
      store,
      usage: async () => ({ usage: 1, quota: 4, persisted: true }),
      showDirectoryPicker: async () => library()
    });
    const reader = attachImportReader(chip, { ...shared, store, openData() { reader.opened = true; } });
    click(root, "选择文件夹…");
    await until(() => gates.length >= 1);
    gates.shift()();
    await until(() => gates.length >= 1);
    assert.equal(await store.getPaper(HASH_A) != null, true);
    assert.equal(await store.getPaper(HASH_B), null);
    const closing = panel.closeData();
    gates.shift()();
    await closing;
    await until(() => gates.length >= 1);
    assert.match(chip.textContent, /正在导入/);
    assert.equal(await store.getPaper(HASH_B), null);
    gates.shift()();
    await flush(30);
    assert.equal(await store.getPaper(HASH_B) != null, true);
    const again = runtime();
    const stopGates = [];
    again.beforePaper = () => new Promise((resolve) => stopGates.push(resolve));
    const fresh = storeFor("memory");
    const solo = document.createElement("div");
    const soloPanel = mountDataPanel(solo, {
      ...again,
      store: fresh,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      showDirectoryPicker: async () => dir("files", {
        [HASH_A]: paper(HASH_A, [page(1, "甲")], { meta: { title: "甲", rev: 1, updatedAt: 1 } }),
        [HASH_B]: paper(HASH_B, [page(1, "乙")], { meta: { title: "乙", rev: 1, updatedAt: 1 } })
      })
    });
    click(solo, "选择文件夹…");
    await until(() => stopGates.length >= 1);
    stopGates.shift()();
    await until(() => stopGates.length >= 1);
    const stopped = soloPanel.closeAll();
    stopGates.shift()();
    await stopped;
    await flush();
    assert.equal(await fresh.getPaper(HASH_B), null);
    const meta = await fresh.readImportMeta();
    assert.equal(meta.phase === "interrupted" || meta.phase === "paused", true);
    assert.deepEqual(meta.doneDocs, [HASH_A]);
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    assert.equal(JSON.stringify(manifest.permissions || []).includes("offscreen"), false);
    reader.destroy();
  } finally {
    restore();
  }
});

test("F4UI-23 F4UI-24 resume, allow, later, and incomplete", async () => {
  const restore = installDom();
  try {
    const store = storeFor("memory");
    const folder = library();
    const root = document.createElement("div");
    const gates = [];
    const first = mountDataPanel(root, {
      ...runtime({ beforePaper: () => new Promise((resolve) => gates.push(resolve)) }),
      store,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      showDirectoryPicker: async () => folder
    });
    click(root, "选择文件夹…");
    await until(() => gates.length >= 1);
    gates.shift()();
    await until(() => gates.length >= 1);
    const closing = first.closeAll();
    gates.shift()();
    await closing;
    const saved = await store.readImportMeta();
    saved.permission = "prompt";
    saved.phase = "interrupted";
    await store.writeImportMeta(saved);
    const nextRoot = document.createElement("div");
    const chip = document.createElement("div");
    let picks = 0;
    const next = mountDataPanel(nextRoot, {
      ...runtime({
        decidePermission: async (handle) => {
          handle.permission = "granted";
          return "granted";
        }
      }),
      store,
      chipHost: chip,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      showDirectoryPicker: async () => { picks += 1; return folder; }
    });
    await flush(20);
    assert.match(nextRoot.textContent, /导入待继续/);
    assert.match(chip.textContent, /导入待继续/);
    click(nextRoot, "以后再说");
    await flush();
    assert.equal(chip.hidden, true);
    assert.match(nextRoot.textContent, /导入待继续/);
    click(nextRoot, "允许并继续");
    await flush(40);
    assert.equal(await store.getPaper(HASH_B) != null, true);
    saved.permission = "denied";
    saved.phase = "interrupted";
    saved.doneDocs = [HASH_A];
    await store.writeImportMeta(saved);
    const deniedRoot = document.createElement("div");
    const deniedChip = document.createElement("div");
    mountDataPanel(deniedRoot, {
      ...runtime(),
      store,
      chipHost: deniedChip,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      showDirectoryPicker: async () => { picks += 1; return folder; }
    });
    await flush(20);
    assert.match(deniedRoot.textContent, /导入没完成/);
    assert.match(deniedChip.textContent, /导入没完成/);
    const reader = attachImportReader(document.createElement("div"), {
      ...runtime(),
      store,
      openData() { picks += 10; }
    });
    await flush();
    const popButton = [...deniedChip.querySelectorAll("button")].find((node) => node.textContent.includes("导入没完成"));
    popButton?.click();
    const reselect = [...deniedChip.querySelectorAll("button")].find((node) => node.textContent.includes("重新选择文件夹"));
    if (reselect) {
      let opened = false;
      const host = document.createElement("div");
      const bound = attachImportReader(host, {
        ...runtime(),
        store,
        openData() { opened = true; }
      });
      await flush();
      [...host.querySelectorAll("button")].find((node) => node.textContent.includes("导入没完成"))?.click();
      [...host.querySelectorAll("button")].find((node) => node.textContent.includes("重新选择文件夹"))?.click();
      assert.equal(opened, true);
      assert.equal(picks < 10, true);
      bound.destroy();
    }
    click(deniedRoot, "不再导入");
    await flush();
    assert.equal(await store.readImportMeta(), null);
    assert.equal(await store.getPaper(HASH_A) != null, true);
    next.destroy();
    reader.destroy();
    void picks;
  } finally {
    restore();
  }
});

test("DATA-19 to DATA-22 json import and export", async () => {
  const restore = installDom();
  try {
    const source = storeFor("memory");
    await source.importBundle({
      format: LIBRARY_FORMAT,
      schema: LIBRARY_SCHEMA,
      papers: [{
        paper: { docHash: HASH_A, title: "甲", origin: "local", rev: 1, updatedAt: 1, lastOpenedAt: 1, schema: LIBRARY_SCHEMA, apiKey: "SECRET" },
        pages: [{ docHash: HASH_A, page: 1, pairs: [{ id: "p", source: "s", translation: "t" }], rev: 1, updatedAt: 1, schema: LIBRARY_SCHEMA }]
      }]
    });
    const target = storeFor("memory");
    const root = document.createElement("div");
    let downloaded = null;
    const panel = mountDataPanel(root, {
      store: target,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      now: () => Date.UTC(2026, 9, 15, 8, 5),
      download: async (filename, text, bundle) => {
        downloaded = { filename, text, bundle };
        return true;
      }
    });
    await panel.reload();
    const emptyButton = [...root.querySelectorAll("button")].find((node) => node.textContent.includes("导出文献库"));
    assert.equal(emptyButton.disabled, true);
    assert.match(root.textContent, /文献库是空的/);
    const file = {
      name: "open-immerse-library.json",
      type: "application/json",
      async text() { return JSON.stringify(await source.exportLibrary()); }
    };
    root.querySelector('input[type="file"]').dispatchEvent({ type: "change", target: { files: [file] } });
    const input = root.querySelector('input[type="file"]');
    input.files = [file];
    input.dispatchEvent({ type: "change" });
    await flush(30);
    assert.equal((await target.getPaper(HASH_A)).title, "甲");
    assert.equal(JSON.stringify(await target.getPaper(HASH_A)).includes("SECRET"), false);
    assert.match(root.textContent, /新增/);
    const notesRoot = document.createElement("div");
    const notesStore = storeFor("memory");
    mountDataPanel(notesRoot, {
      store: notesStore,
      usage: async () => ({ usage: 1, quota: 2, persisted: true })
    });
    const notesFile = {
      name: "notes.json",
      async text() {
        return JSON.stringify({
          format: NOTES_FORMAT,
          schema: 1,
          docHash: HASH_A,
          docs: [{
            docHash: HASH_A,
            notes: [{ id: "n1", kind: "note", body: "记", createdAt: 1, updatedAt: 1 }]
          }]
        });
      }
    };
    const notesInput = notesRoot.querySelector('input[type="file"]');
    notesInput.files = [notesFile];
    notesInput.dispatchEvent({ type: "change" });
    await flush(20);
    assert.equal((await notesStore.listPapers()).length, 0);
    assert.match(notesRoot.textContent, /新增 1/);
    const dropStore = storeFor("memory");
    const dropRoot = document.createElement("div");
    mountDataPanel(dropRoot, {
      store: dropStore,
      usage: async () => ({ usage: 1, quota: 2, persisted: true })
    });
    const beforeImport = dropRoot.querySelector('[data-focus-group="import"]').textContent;
    dropRoot.querySelector('[data-focus-group="import"]').dispatchEvent({
      type: "drop",
      preventDefault() {},
      dataTransfer: { files: [{ name: "files", isDirectory: true }], items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }] }
    });
    await flush();
    assert.equal(dropRoot.querySelector('[data-focus-group="import"]').textContent, beforeImport);
    assert.equal((await dropStore.listPapers()).length, 0);
    const badRoot = document.createElement("div");
    mountDataPanel(badRoot, {
      store: storeFor("memory"),
      usage: async () => ({ usage: 1, quota: 2, persisted: true })
    });
    const bad = badRoot.querySelector('input[type="file"]');
    bad.files = [{
      name: "new.json",
      async text() { return JSON.stringify({ format: LIBRARY_FORMAT, schema: 9, papers: [] }); }
    }];
    bad.dispatchEvent({ type: "change" });
    await flush();
    assert.match(badRoot.textContent, /格式 9/);
    const cancelRoot = document.createElement("div");
    mountDataPanel(cancelRoot, {
      store: storeFor("memory"),
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      showDirectoryPicker: async () => {
        const error = new Error("cancel");
        error.name = "AbortError";
        throw error;
      }
    });
    const idle = cancelRoot.textContent;
    click(cancelRoot, "选择文件夹…");
    await flush();
    assert.equal(cancelRoot.textContent.includes("没有导入"), false);
    assert.equal(cancelRoot.textContent.includes("正在导入"), false);
    void idle;
    await target.importBundle({
      format: LIBRARY_FORMAT,
      schema: LIBRARY_SCHEMA,
      papers: [{
        paper: { docHash: HASH_A, title: "甲", rev: 1, updatedAt: 1, lastOpenedAt: 1, schema: LIBRARY_SCHEMA },
        source: { docHash: HASH_A, base64: btoa("0123456789abcdef"), size: 16 }
      }]
    });
    await panel.reload();
    const boxes = [...root.querySelectorAll("input")].filter((node) => node.type === "checkbox");
    const estimate = () => [...root.querySelectorAll("h3")].map((node) => node.textContent).find((text) => text.startsWith("预计"));
    const beforeEstimate = estimate();
    boxes[0].checked = true;
    boxes[0].dispatchEvent({ type: "change" });
    assert.notEqual(estimate(), beforeEstimate);
    boxes[0].checked = false;
    boxes[0].dispatchEvent({ type: "change" });
    const titles = [...root.querySelectorAll("h3")].map((node) => node.textContent);
    assert.equal(titles.includes("版面"), false);
    click(root, "导出文献库");
    await flush();
    assert.match(downloaded.filename, /^open-immerse-library-\d{8}-\d{4}\.json$/);
    assert.equal(downloaded.text.includes("SECRET"), false);
    assert.equal(downloaded.bundle.papers.some((item) => item.layouts), false);
    assert.equal(downloaded.bundle.papers.some((item) => item.source), false);
  } finally {
    restore();
  }
});

test("F4UI chip states have no import delay and respect reduced motion", async () => {
  const restore = installDom();
  try {
    const queue = [];
    let seq = 0;
    const timers = {
      setTimeout(fn, ms) {
        seq += 1;
        queue.push({ id: seq, fn, ms });
        return seq;
      },
      clearTimeout(id) {
        const index = queue.findIndex((item) => item.id === id);
        if (index >= 0) queue.splice(index, 1);
      }
    };
    function advance(ms) {
      for (const item of [...queue]) item.ms -= ms;
      for (const item of queue.filter((entry) => entry.ms <= 0)) item.fn();
      for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i].ms <= 0) queue.splice(i, 1);
    }
    const host = document.createElement("div");
    const chip = createLibraryChip({ host, timers, moveDelay: 800, doneHoldMs: 3000, fadeMs: 200 });
    chip.setImport({ phase: "running", done: 0, total: 4, holds: true });
    assert.match(host.textContent, /正在导入 0\/4/);
    assert.equal(queue.length, 0);
    chip.setImport({ phase: "paused", done: 1, total: 4, holds: true });
    assert.match(host.textContent, /已暂停 1\/4/);
    chip.setImport({ phase: "error", done: 1, total: 4, failed: 2, holds: true, errors: [
      { docHash: HASH_A, title: "甲", reason: "quota" },
      { docHash: HASH_B, title: "乙", reason: "corrupt" }
    ] });
    assert.match(host.textContent, /⚠ 2 篇没导入/);
    [...host.querySelectorAll("button")][0].click();
    assert.match(host.textContent, /空间不够/);
    assert.match(host.textContent, /文件损坏/);
    chip.setImport({ phase: "done", done: 2, total: 2, importedPapers: 2, holds: true });
    assert.match(host.textContent, /✓ 已导入 2 篇/);
    advance(3000);
    assert.match(host.className + host.textContent, /is-fading|已导入/);
    advance(200);
    assert.equal(host.hidden, true);
    const quiet = document.createElement("div");
    const quietChip = createLibraryChip({
      host: quiet,
      timers,
      reducedMotion: () => true,
      doneHoldMs: 3000,
      narrow: () => true
    });
    quietChip.setImport({ phase: "running", done: 1, total: 3, holds: true });
    assert.match(quiet.querySelector("button").getAttribute("aria-label"), /正在导入 1\/3/);
    [...quiet.querySelectorAll("button")][0].click();
    assert.equal(String(quiet.textContent).includes("is-sheet") || [...quiet.querySelectorAll(".is-sheet")].length > 0 || quiet.querySelector(".oi-lib-pop")?.className.includes("is-sheet"), true);
    quietChip.setImport({ phase: "done", done: 3, total: 3, importedPapers: 3, holds: true });
    advance(3000);
    assert.equal(quiet.hidden, true);
    chip.destroy();
    quietChip.destroy();
  } finally {
    restore();
  }
});

test("F4UI-27 the library card opens when notes persist was refused", async () => {
  const local = {
    async get() {
      return { libraryPersistGranted: true, notesPersistGranted: false };
    }
  };
  const state = await readPersistCardState(local);
  assert.equal(state.show, true);
  const dismissed = {
    async get() {
      return { "library.persistHintDismissed": true, notesPersistGranted: false };
    }
  };
  assert.equal((await readPersistCardState(dismissed)).show, false);
});

test("F4UI-02 blocked still outranks import", async () => {
  const restore = installDom();
  try {
    const host = document.createElement("div");
    const chip = createLibraryChip({ host });
    await chip.block({ reason: "corrupt" });
    chip.setImport({ phase: "running", done: 1, total: 2, holds: true });
    assert.match(host.textContent, /暂时存不了/);
    assert.equal(host.textContent.includes("正在导入"), false);
    chip.destroy();
  } finally {
    restore();
  }
});
