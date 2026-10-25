import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "fake-indexeddb/auto";

import { createLibraryChip } from "../lib/library-chip.js";
import { LIBRARY_FORMAT, LIBRARY_SCHEMA, LibraryStoreError, createLibraryStore, stripSecrets } from "../lib/library-store.js";
import { SESSION_LATER, SESSION_PAUSED, createImportBus, createMemoryLocks, createPresence } from "../lib/import-run.js";
import { NOTES_FORMAT } from "../lib/notes-io.js";
import { createMemoryKv } from "../lib/platform/kv.js";
import { createIdbLibraryFactory } from "../lib/platform/idb-backend.js";
import { createMemoryLibraryFactory } from "../lib/platform/memory-backend.js";
import { PERSIST_CARD_SESSION_KEY, createPersistCard, persistCardHiddenThisSession, readPersistCardState } from "../lib/persist-card.js";
import { downloadBlob } from "../lib/export.js";
import { saveLibraryPage, setLibraryUiHooks } from "../lib/pdf-library.js";
import { attachImportReader, bindImportChip, mountDataPanel, readDataFocus } from "../options/data-panel.js";

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";
const HASH_C = "cccccccccccccccc";

let storeSerial = 0;
function storeFor(kind, persist = false) {
  storeSerial += 1;
  const name = `oi-test-${kind}-${storeSerial}`;
  const kv = createMemoryKv();
  const library = kind === "idb" ? createIdbLibraryFactory() : createMemoryLibraryFactory();
  const store = createLibraryStore({
    platform: { kv, library },
    persist: async () => persist,
    now: () => 1_700_000_000_000,
    dbName: name
  });
  store.closeLibrary = () => {
    try { store._idbNotes?.currentDb?.close?.(); } catch { /* notes were not opened */ }
    return library.close?.(name);
  };
  return store;
}

function eventTarget() {
  const map = new Map();
  return {
    addEventListener(type, fn) {
      const list = map.get(type) || [];
      list.push(fn);
      map.set(type, list);
    },
    removeEventListener(type, fn) {
      map.set(type, (map.get(type) || []).filter((item) => item !== fn));
    },
    dispatch(type) {
      for (const fn of [...(map.get(type) || [])]) fn({ type });
    }
  };
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

async function until(fn, turns = 80) {
  for (let i = 0; i < turns; i += 1) {
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

function secretLayout(token = "⟦f1⟧") {
  return {
    protocol: "blocks-1",
    layoutVersion: "v1",
    apiKey: "SECRET",
    api_key: "SECRET",
    "api-key": "SECRET",
    client_secret: "SECRET",
    clientSecret: "SECRET",
    secretKey: "DROP",
    "access-token": "DROP",
    idToken: "DROP",
    bearer: "DROP",
    auth: { token: "TOK" },
    blocks: [{
      id: "b1",
      key: "keep-me",
      placeholders: [{ token, blockId: "f1" }]
    }]
  };
}

function library(permission = "granted") {
  return dir("files", {
    [HASH_A]: paper(HASH_A, [{
      page: 1,
      pairs: [{ id: "p1", source: "src 1", translation: "甲", apiKey: "SECRET" }],
      layoutVersion: "v1",
      layout: secretLayout()
    }], {
      meta: { title: "论文甲", fileName: "a.pdf", rev: 2, updatedAt: 20, client_secret: "SECRET" },
      readout: "# 甲",
      source: Uint8Array.from([1, 2, 3, 4])
    }),
    [HASH_B]: paper(HASH_B, [{
      page: 1,
      pairs: [{ id: "p1", source: "src 1", translation: "乙" }],
      layoutVersion: "v1",
      layout: secretLayout("⟦f1⟧")
    }], { meta: { title: "论文乙", rev: 2, updatedAt: 20, arxiv: { key: "1706.03762" } } }),
    "notes.txt": { kind: "file", name: "notes.txt", text: "ignore me" }
  }, permission);
}

test("DATA-01 the mounted panel only contains its three groups, in order", async () => {
  const restore = installDom();
  try {
    const root = document.createElement("div");
    mountDataPanel(root, { store: storeFor("memory"), usage: async () => ({ usage: 0, quota: 1, persisted: true }) });
    const titles = [...root.querySelectorAll("h3.set-gh")].map((node) => node.textContent);
    assert.deepEqual(titles, ["存储用量", "文献库 · 导入", "文献库 · 导出"]);
    assert.equal(root.querySelector(".set-group > h2, .set-group > h3"), null);
    assert.equal(root.querySelector('[data-focus-group="usage"]').getAttribute("aria-labelledby"), "dataUsageHeading");
    assert.equal(root.querySelector('[data-focus-group="import"]').getAttribute("aria-labelledby"), "dataImportHeading");
    assert.equal(root.querySelector('[data-focus-group="export"]').getAttribute("aria-labelledby"), "dataExportHeading");
    assert.equal(root.textContent.includes("API 密钥永远不导出"), false);
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
    click(root, "申请长期保存");
    await flush();
    assert.equal(asks, 1);
    assert.equal(root.querySelector("[data-persist-state]").getAttribute("data-persist-state"), "denied");
    assert.match(root.textContent, /再试一次/);
    assert.match(root.textContent, /导出文献库/);
    assert.match(root.textContent, /空间紧张时仍可能清掉文献库/);
    assert.equal(root.querySelector(".oi-data-toast"), null);
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
        const layouts = await store.listLayouts(HASH_B);
        const layoutText = JSON.stringify(layouts);
        assert.match(layoutText, /⟦f1⟧/);
        assert.match(layoutText, /keep-me/);
        assert.equal(layoutText.includes("TOK"), false);
        assert.equal(layoutText.includes("DROP"), false);
        assert.equal(layoutText.includes("SECRET"), false);
        assert.equal(JSON.stringify(addedPage).includes("TOK"), false);
        assert.equal(JSON.stringify(addedPage).includes("DROP"), false);
        assert.equal(JSON.stringify(addedPage).includes("SECRET"), false);
        assert.equal(added.origin, "import");
        assert.equal(added.title, "论文乙");
        const meta = await store.readImportMeta();
        const { directoryHandle, ...rest } = meta;
        assert.equal(rest.tree, undefined);
        assert.equal(JSON.stringify(rest).includes("SECRET"), false);
        assert.equal(JSON.stringify(rest).includes("⟦f1⟧"), false);
        assert.ok(directoryHandle);
        assert.equal(rest.paperIds.includes(HASH_B), true);
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
  for (const kind of ["memory", "idb"]) {
  const restore = installDom();
  try {
    const store = storeFor(kind);
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
    await store.closeLibrary?.();
  } finally {
    restore();
  }
  }
});

test("DATA-08 corrupt, quota, and blocked stop without deleting the folder", async () => {
  for (const kind of ["memory", "idb"]) {
  const restore = installDom();
  try {
    const store = storeFor(kind);
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
    const quotaStore = storeFor(kind);
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
    await store.closeLibrary?.();
    await quotaStore.closeLibrary?.();
  } finally {
    restore();
  }
  }
});

test("DATA-06 import continues while a page is open and pauses when all close", async () => {
  for (const kind of ["memory", "idb"]) {
  const restore = installDom();
  try {
    const store = storeFor(kind);
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
    const fresh = storeFor(kind);
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
    await store.closeLibrary?.();
    await fresh.closeLibrary?.();
  } finally {
    restore();
  }
  }
});

test("F4UI-23 F4UI-24 resume, allow, later, and incomplete", async () => {
  for (const kind of ["memory", "idb"]) {
  const restore = installDom();
  try {
    const store = storeFor(kind);
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
    saved.directoryHandle.permission = "prompt";
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
    saved.directoryHandle.permission = "denied";
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
    saved.directoryHandle.unavailable = true;
    saved.directoryHandle.permission = "granted";
    saved.phase = "interrupted";
    await store.writeImportMeta(saved);
    const movedRoot = document.createElement("div");
    mountDataPanel(movedRoot, {
      ...runtime(),
      store,
      usage: async () => ({ usage: 1, quota: 2, persisted: true })
    });
    await flush(20);
    assert.match(movedRoot.textContent, /导入没完成/);
    next.destroy();
    reader.destroy();
    await store.closeLibrary?.();
    void picks;
  } finally {
    restore();
  }
  }
});

test("DATA-19 to DATA-22 json import and export", async () => {
  for (const kind of ["memory", "idb"]) {
  const restore = installDom();
  try {
    const source = storeFor(kind);
    await source.importBundle({
      format: LIBRARY_FORMAT,
      schema: LIBRARY_SCHEMA,
      papers: [{
        paper: { docHash: HASH_A, title: "甲", origin: "local", rev: 1, updatedAt: 1, lastOpenedAt: 1, schema: LIBRARY_SCHEMA, apiKey: "SECRET" },
        pages: [{ docHash: HASH_A, page: 1, pairs: [{ id: "p", source: "s", translation: "t" }], rev: 1, updatedAt: 1, schema: LIBRARY_SCHEMA }]
      }]
    });
    const target = storeFor(kind);
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
    const notesStore = storeFor(kind);
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
    const dropStore = storeFor(kind);
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
    const badStore = storeFor(kind);
    mountDataPanel(badRoot, {
      store: badStore,
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
    const cancelStore = storeFor(kind);
    mountDataPanel(cancelRoot, {
      store: cancelStore,
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
    await source.closeLibrary?.();
    await target.closeLibrary?.();
    await notesStore.closeLibrary?.();
    await dropStore.closeLibrary?.();
    await badStore.closeLibrary?.();
    await cancelStore.closeLibrary?.();
  } finally {
    restore();
  }
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
    const chip = createLibraryChip({ host, timers, moveDelayMs: 800, doneHoldMs: 3000, fadeMs: 200 });
    chip.setImport({ phase: "running", done: 0, total: 4, holds: true });
    assert.match(host.textContent, /正在导入 0\/4/);
    assert.equal(queue.length, 0);
    chip.startMove();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].ms, 800);
    chip.finishMove();
    assert.equal(queue.length, 0);
    chip.setImport({ phase: "incomplete", done: 1, total: 2, holds: true, source: "json" });
    [...host.querySelectorAll("button")][0].click();
    assert.match(host.textContent, /上次的导出文件没有导完/);
    assert.match(host.textContent, /重新选择文件…/);
    assert.equal(host.textContent.includes("重新选择文件夹"), false);
    assert.equal(host.textContent.includes("读不到上次的"), false);
    chip.setImport({ phase: "incomplete", done: 1, total: 2, holds: true, source: "folder", folder: "files" });
    assert.match(host.textContent, /重新选择文件夹…/);
    chip.closePop();
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

test("credential fields are stripped and formula placeholders stay", () => {
  const cleaned = stripSecrets({
    placeholders: [{ token: "⟦f1⟧", blockId: "f" }],
    arxiv: { key: "1706.03762" },
    token: "bare-kept",
    key: "bare-key",
    client_secret: "LEAK",
    clientSecret: "LEAK",
    secretKey: "LEAK",
    "access-token": "LEAK",
    idToken: "LEAK",
    bearer: "LEAK",
    api_key: "LEAK",
    "api-key": "LEAK",
    auth: { token: "LEAK" }
  });
  assert.equal(cleaned.placeholders[0].token, "⟦f1⟧");
  assert.equal(cleaned.arxiv.key, "1706.03762");
  assert.equal(cleaned.token, "bare-kept");
  assert.equal(cleaned.key, "bare-key");
  assert.equal(JSON.stringify(cleaned).includes("LEAK"), false);
});

test("import meta keeps the directory handle and drops raw secret text", async () => {
  for (const kind of ["memory", "idb"]) {
    const store = storeFor(kind);
    try {
      await store.writeImportMeta({
        phase: "interrupted",
        source: "folder",
        folderName: "files",
        paperIds: [HASH_A],
        doneDocs: [],
        total: 1,
        tree: { text: "LEAK-RAW-SECRET", bytes: [1, 2, 3, 4] },
        papers: [{ docHash: HASH_A, bytes: [9, 9, 9] }],
        note: "LEAK-RAW-SECRET",
        errors: [{ docHash: HASH_A, title: "t", reason: "corrupt", at: 1, body: "LEAK-RAW-SECRET" }],
        directoryHandle: dir("files", {})
      });
      const saved = await store.readImportMeta();
      const { directoryHandle, ...rest } = saved;
      assert.equal(JSON.stringify(rest).includes("LEAK-RAW-SECRET"), false);
      assert.equal(rest.tree, undefined);
      assert.equal(rest.papers, undefined);
      assert.equal(rest.note, undefined);
      assert.equal(directoryHandle.name, "files");
      assert.deepEqual(rest.paperIds, [HASH_A]);
    } finally {
      await store.closeLibrary?.();
    }
  }
});

test("a folder file without a timestamp does not overwrite the same rev", async () => {
  for (const kind of ["memory", "idb"]) {
    const restore = installDom();
    try {
      const store = storeFor(kind);
      await store.importBundle({
        format: LIBRARY_FORMAT,
        schema: LIBRARY_SCHEMA,
        papers: [{
          paper: { docHash: HASH_C, title: "本地", origin: "import", rev: 2, updatedAt: 40, lastOpenedAt: 40, schema: LIBRARY_SCHEMA },
          pages: [{ docHash: HASH_C, page: 1, pairs: [{ id: "p", source: "s", translation: "本地译文" }], rev: 2, updatedAt: 40, schema: LIBRARY_SCHEMA }]
        }]
      });
      const root = document.createElement("div");
      const panel = mountDataPanel(root, {
        ...runtime(),
        store,
        usage: async () => ({ usage: 1, quota: 2, persisted: true }),
        showDirectoryPicker: async () => dir("files", {
          [HASH_C]: paper(HASH_C, [page(1, "文件夹译文")], { meta: { title: "文件夹标题", rev: 2 } })
        })
      });
      click(root, "选择文件夹…");
      await flush(50);
      const kept = await store.getPaper(HASH_C);
      assert.equal(kept.title, "本地");
      assert.equal(kept.updatedAt, 40);
      assert.equal((await store.getPage(HASH_C, 1)).pairs[0].translation, "本地译文");
      const freshRoot = document.createElement("div");
      mountDataPanel(freshRoot, {
        ...runtime(),
        store,
        usage: async () => ({ usage: 1, quota: 2, persisted: true }),
        showDirectoryPicker: async () => dir("files", {
          [HASH_A]: paper(HASH_A, [page(1, "新")], { meta: { title: "无时间", rev: 1 } })
        })
      });
      click(freshRoot, "选择文件夹…");
      await flush(50);
      const fresh = await store.getPaper(HASH_A);
      assert.equal(fresh.title, "无时间");
      assert.equal(fresh.updatedAt, 0);
      assert.equal(fresh.lastOpenedAt, 0);
      assert.equal((await store.listPapers()).some((item) => item.docHash === HASH_A), true);
      panel.destroy();
      await store.closeLibrary?.();
    } finally {
      restore();
    }
  }
});

test("DATA-06 pagehide on one page lets the other page take the import", async () => {
  const viewer = readFileSync(new URL("../pdf/viewer.js", import.meta.url), "utf8");
  const closeFn = viewer.slice(viewer.indexOf("function closeViewerWork"), viewer.indexOf("function abortError"));
  assert.match(closeFn, /importBinding\?\.close/);
  const options = readFileSync(new URL("../options/options.js", import.meta.url), "utf8");
  assert.match(options, /pagehide[\s\S]{0,120}closeData/);
  for (const kind of ["memory", "idb"]) {
    const restore = installDom();
    try {
      const store = storeFor(kind);
      const shared = runtime();
      const gates = [];
      const beforePaper = () => new Promise((resolve) => gates.push(resolve));
      const { modA, modB } = await coordinatorPair(`pagehide-${kind}`);
      const dataCoordinator = modA.createImportCoordinator({ ...shared, store, beforePaper });
      const readerCoordinator = modB.createImportCoordinator({ ...shared, store, beforePaper });
      assert.notEqual(dataCoordinator.id, readerCoordinator.id);
      const dataWindow = eventTarget();
      const readerWindow = eventTarget();
      const root = document.createElement("div");
      const chip = document.createElement("div");
      const panel = mountDataPanel(root, {
        ...shared,
        store,
        coordinator: dataCoordinator,
        window: dataWindow,
        usage: async () => ({ usage: 1, quota: 4, persisted: true }),
        showDirectoryPicker: async () => library()
      });
      const reader = attachImportReader(chip, {
        ...shared,
        store,
        coordinator: readerCoordinator,
        window: readerWindow
      });
      click(root, "选择文件夹…");
      await until(() => gates.length >= 1);
      gates.shift()();
      await until(() => gates.length >= 1);
      dataWindow.dispatch("pagehide");
      gates.shift()();
      await until(() => gates.length >= 1);
      assert.match(chip.textContent, /正在导入/);
      assert.equal(await store.getPaper(HASH_B), null);
      gates.shift()();
      await flush(40);
      assert.equal(await store.getPaper(HASH_B) != null, true);
      readerWindow.dispatch("pagehide");
      await flush(10);
      panel.destroy();
      reader.destroy();
      await store.closeLibrary?.();
    } finally {
      restore();
    }
  }
});

test("an interrupted json import writes progress without the file body", async () => {
  for (const kind of ["memory", "idb"]) {
    const restore = installDom();
    try {
      const store = storeFor(kind);
      const dataWindow = eventTarget();
      const gates = [];
      const root = document.createElement("div");
      mountDataPanel(root, {
        ...runtime({ beforePaper: () => new Promise((resolve) => gates.push(resolve)) }),
        store,
        window: dataWindow,
        usage: async () => ({ usage: 1, quota: 2, persisted: true })
      });
      const bundle = {
        format: LIBRARY_FORMAT,
        schema: LIBRARY_SCHEMA,
        papers: [HASH_A, HASH_B].map((hash) => ({
          paper: {
            docHash: hash,
            title: "甲",
            rev: 1,
            updatedAt: 1,
            lastOpenedAt: 1,
            schema: LIBRARY_SCHEMA,
            client_secret: "LEAK-CLIENT"
          },
          pages: [{
            docHash: hash,
            page: 1,
            pairs: [{ id: "p", source: "s", translation: "t", "access-token": "LEAK-ACCESS" }],
            rev: 1,
            updatedAt: 1,
            schema: LIBRARY_SCHEMA
          }]
        }))
      };
      const input = root.querySelector('input[type="file"]');
      input.files = [{ name: "library.json", async text() { return JSON.stringify(bundle); } }];
      input.dispatchEvent({ type: "change" });
      await until(() => gates.length >= 1);
      gates.shift()();
      await until(() => gates.length >= 1, 400);
      dataWindow.dispatch("pagehide");
      gates.shift()();
      await flush(40);
      const meta = await store.readImportMeta();
      const { directoryHandle, ...rest } = meta;
      assert.equal(rest.phase, "incomplete");
      assert.equal(rest.source, "json");
      assert.deepEqual(rest.doneDocs, [HASH_A]);
      assert.equal(JSON.stringify(rest).includes("LEAK-CLIENT"), false);
      assert.equal(JSON.stringify(rest).includes("LEAK-ACCESS"), false);
      assert.equal(rest.tree, undefined);
      assert.equal(directoryHandle, undefined);
      assert.equal((await store.getPaper(HASH_A)).title, "甲");
      assert.equal(JSON.stringify(await store.getPaper(HASH_A)).includes("LEAK-CLIENT"), false);
      assert.equal(JSON.stringify(await store.getPage(HASH_A, 1)).includes("LEAK-ACCESS"), false);
      assert.equal(await store.getPaper(HASH_B), null);
      assert.match(root.textContent, /导入没完成/);
      assert.match(root.textContent, /重新选择文件/);
      await store.closeLibrary?.();
    } finally {
      restore();
    }
  }
});

test("a few hundred papers keep each checkpoint bounded", { timeout: 180000 }, async () => {
  for (const kind of ["memory", "idb"]) {
    const restore = installDom();
    try {
      const count = 200;
      const secret = "LEAK-RAW-SECRET";
      const payload = new Uint8Array(4096);
      payload[0] = 7;
      const children = {};
      const second = `p${String(1).padStart(15, "0")}`;
      for (let index = 0; index < count; index += 1) {
        const hash = `p${String(index).padStart(15, "0")}`;
        children[hash] = paper(hash, [{
          page: 1,
          pairs: [{ id: "p1", source: "s", translation: "old", client_secret: secret }],
          layoutVersion: "v1",
          layout: secretLayout()
        }], {
          meta: { title: `t${index}`, rev: 1, updatedAt: 5 },
          readout: secret,
          source: payload
        });
      }
      const store = storeFor(kind);
      const sizes = [];
      const original = store.writeImportMeta.bind(store);
      store.writeImportMeta = async (value) => {
        assert.equal(Object.prototype.hasOwnProperty.call(value, "tree"), false);
        assert.equal(value.papers, undefined);
        const plain = { ...value };
        delete plain.directoryHandle;
        const text = JSON.stringify(plain);
        sizes.push(text.length);
        assert.equal(text.includes(secret), false);
        assert.ok(text.length < 48000, `checkpoint is ${text.length} bytes`);
        return original(value);
      };
      const root = document.createElement("div");
      let passed = 0;
      const panel = mountDataPanel(root, {
        ...runtime({
          beforePaper(paperItem) {
            passed += 1;
            if (paperItem.docHash === second) {
              const file = paperItem.handle.children["page-001.json"];
              const parsed = JSON.parse(file.text);
              parsed.pairs[0].translation = "from-handle";
              file.text = JSON.stringify(parsed);
            }
          }
        }),
        store,
        usage: async () => ({ usage: 1, quota: 80, persisted: true }),
        showDirectoryPicker: async () => dir("files", children)
      });
      click(root, "选择文件夹…");
      const started = Date.now();
      let imported = 0;
      while (imported < count) {
        if (Date.now() - started > 90000) throw new Error(`imported ${imported} of ${count}`);
        imported = (await store.listPapers()).length;
        if (imported < count) await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.equal(passed, count);
      assert.equal((await store.getPage(second, 1)).pairs[0].translation, "from-handle");
      assert.equal(JSON.stringify(await store.getPage(second, 1)).includes(secret), false);
      assert.ok(sizes.length >= count, `writes ${sizes.length}`);
      for (let index = 1; index < sizes.length; index += 1) {
        const grew = sizes[index] - sizes[index - 1];
        assert.ok(grew < 800, `checkpoint grew by ${grew}`);
      }
      const meta = await store.readImportMeta();
      const { directoryHandle, ...rest } = meta;
      assert.equal(JSON.stringify(rest).includes(secret), false);
      assert.equal(rest.tree, undefined);
      assert.equal(rest.paperIds.length, count);
      assert.equal(directoryHandle.name, "files");
      assert.match(JSON.stringify(await store.listLayouts(second)), /⟦f1⟧/);
      panel.destroy();
      await store.closeLibrary?.();
    } finally {
      restore();
    }
  }
});

async function coordinatorPair(tag) {
  const stamp = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [modA, modB] = await Promise.all([
    import(`../lib/import-run.js?${stamp}-a`),
    import(`../lib/import-run.js?${stamp}-b`)
  ]);
  assert.notEqual(modA.createImportCoordinator, modB.createImportCoordinator);
  return { modA, modB };
}

function documentLocks() {
  const core = watchedLocks();
  return {
    waiting: () => core.waiting(),
    open() {
      let dead = false;
      const abandoners = new Set();
      return {
        request(name, options, callback) {
          if (dead) {
            const error = new Error("The document was destroyed");
            error.name = "AbortError";
            return Promise.reject(error);
          }
          let abandon = () => {};
          const abandoned = new Promise((resolve) => { abandon = resolve; });
          abandoners.add(abandon);
          return core.request(name, options, (lock) => {
            if (!lock || dead) return callback(lock);
            // Document destruction settles the browser lock while the page's
            // callback never runs again. Promise.race does that here.
            return Promise.race([
              Promise.resolve().then(() => callback(lock)),
              abandoned
            ]);
          }).finally(() => abandoners.delete(abandon));
        },
        destroy() {
          if (dead) return;
          dead = true;
          for (const abandon of abandoners) abandon();
          abandoners.clear();
        }
      };
    }
  };
}

function watchedLocks() {
  const locks = createMemoryLocks();
  let waiting = 0;
  return {
    waiting: () => waiting,
    request(name, options, callback) {
      const opts = typeof options === "function" ? {} : (options || {});
      const blocks = typeof options !== "function" && opts.ifAvailable !== true;
      if (!blocks) return locks.request(name, options, callback);
      waiting += 1;
      return locks.request(name, options, callback).finally(() => {
        waiting -= 1;
      });
    }
  };
}

function onePaperDir() {
  return dir("files", {
    [HASH_A]: paper(HASH_A, [page(1, "甲")], { meta: { title: "论文甲", rev: 1, updatedAt: 1 } })
  });
}

test("DATA-06 the reader waits out a paper that still holds the shared lock", { timeout: 20000 }, async () => {
  const restore = installDom();
  const gates = [];
  let data = null;
  let reader = null;
  let store = null;
  let spy = null;
  try {
    store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("slow-lock");
    const locks = watchedLocks();
    const beforePaper = () => new Promise((resolve) => gates.push(resolve));
    data = modA.createImportCoordinator({ store, locks, beforePaper });
    reader = modB.createImportCoordinator({ store, locks, beforePaper });
    assert.notEqual(modA.createImportCoordinator, modB.createImportCoordinator);
    assert.notEqual(data.id, reader.id);
    data.attach("data");
    reader.attach("reader");
    await flush(20);
    const heard = [];
    spy = new BroadcastChannel("oi-library");
    spy.onmessage = (event) => {
      if (event?.data?.type === "import-lock-free") heard.push(Date.now());
    };
    const job = data.importFolder(library());
    await until(() => gates.length >= 1);
    const started = Date.now();
    const detaching = data.detach("data");
    await until(() => heard.length >= 1, 80);
    assert.ok(Date.now() - started < 500, `lock-free arrived after ${Date.now() - started}ms`);
    await detaching;
    const waited = Date.now() - started;
    assert.ok(waited >= 1900, `detach returned in ${waited}ms`);
    await until(() => locks.waiting() >= 1, 200);
    assert.equal(gates.length, 1);
    assert.equal(await store.getPaper(HASH_A), null);
    assert.equal(await store.getPaper(HASH_B), null);
    gates.shift()();
    await until(() => gates.length >= 1, 200);
    gates.shift()();
    await until(() => gates.length >= 1, 200);
    gates.shift()();
    await flush(40);
    assert.notEqual(await store.getPaper(HASH_A), null);
    assert.notEqual(await store.getPaper(HASH_B), null);
    await job;
  } finally {
    while (gates.length) gates.shift()();
    spy?.close();
    data?.destroy();
    reader?.destroy();
    await store?.closeLibrary?.();
    restore();
  }
});

test("a detached reader does not import after the shared lock is granted", { timeout: 20000 }, async () => {
  const restore = installDom();
  let data = null;
  let reader = null;
  let store = null;
  let releaseHold = null;
  try {
    store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("detach-wait");
    const locks = watchedLocks();
    let calls = 0;
    const beforePaper = () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { releaseHold = resolve; });
    };
    data = modA.createImportCoordinator({ store, locks, beforePaper });
    reader = modB.createImportCoordinator({ store, locks, beforePaper });
    data.attach("data");
    reader.attach("reader");
    await flush(20);
    const job = data.importFolder(library());
    await until(() => calls === 1 && releaseHold);
    await data.detach("data");
    await until(() => locks.waiting() >= 1, 200);
    assert.equal(calls, 1);
    await reader.detach("reader");
    releaseHold();
    releaseHold = null;
    await flush(40);
    assert.equal(calls, 1);
    assert.equal(await store.getPaper(HASH_A), null);
    assert.equal(await store.getPaper(HASH_B), null);
    await job;
  } finally {
    releaseHold?.();
    data?.destroy();
    reader?.destroy();
    await store?.closeLibrary?.();
    restore();
  }
});

test("以后再说 after the reader queues does not take over the import", { timeout: 20000 }, async () => {
  const restore = installDom();
  let data = null;
  let reader = null;
  let store = null;
  let releaseHold = null;
  try {
    store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("later-wait");
    const locks = watchedLocks();
    let calls = 0;
    const beforePaper = () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { releaseHold = resolve; });
    };
    data = modA.createImportCoordinator({ store, locks, beforePaper });
    reader = modB.createImportCoordinator({ store, locks, beforePaper });
    data.attach("data");
    reader.attach("reader");
    await flush(20);
    const job = data.importFolder(library());
    await until(() => calls === 1 && releaseHold);
    await data.detach("data");
    await until(() => locks.waiting() >= 1, 200);
    await reader.later();
    assert.equal(reader.state().later, true);
    releaseHold();
    releaseHold = null;
    await flush(40);
    assert.equal(calls, 1);
    assert.equal(reader.state().later, true);
    assert.notEqual(reader.state().phase, "done");
    assert.equal(await store.getPaper(HASH_A), null);
    assert.equal(await store.getPaper(HASH_B), null);
    await job;
  } finally {
    releaseHold?.();
    data?.destroy();
    reader?.destroy();
    await store?.closeLibrary?.();
    restore();
  }
});

test("a destroyed page hands the import to the reader that already queued", { timeout: 20000 }, async () => {
  const restore = installDom();
  let data = null;
  let reader = null;
  let store = null;
  let page = null;
  try {
    store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("destroyed-page");
    const locks = documentLocks();
    page = locks.open();
    const readerPage = locks.open();
    let calls = 0;
    let lockFree = 0;
    let dead = false;
    const raw = createImportBus();
    const bus = {
      post(message) {
        if (message?.type === "import-lock-free") lockFree += 1;
        if (dead) return;
        raw.post(message);
      },
      listen: (fn) => raw.listen(fn),
      close() { raw.close?.(); }
    };
    data = modA.createImportCoordinator({
      store,
      bus,
      locks: page,
      beforePaper() {
        calls += 1;
        return new Promise(() => {});
      }
    });
    reader = modB.createImportCoordinator({ store, bus, locks: readerPage });
    data.attach("data");
    reader.attach("reader");
    await flush(20);
    const job = data.importFolder(library());
    await until(() => calls === 1 && locks.waiting() >= 1, 200);
    assert.equal(await store.getPaper(HASH_A), null);
    assert.equal(await store.getPaper(HASH_B), null);
    dead = true;
    page.destroy();
    let handed = false;
    for (let turn = 0; turn < 400 && !handed; turn += 1) {
      handed = Boolean(await store.getPaper(HASH_A)) && Boolean(await store.getPaper(HASH_B));
      if (!handed) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(handed, true);
    assert.equal(calls, 1);
    assert.equal(lockFree, 0);
    assert.notEqual(await store.getPaper(HASH_A), null);
    assert.notEqual(await store.getPaper(HASH_B), null);
    void job;
  } finally {
    page?.destroy();
    data?.destroy();
    reader?.destroy();
    await store?.closeLibrary?.();
    restore();
  }
});

test("DATA-06 two module instances hand the import across BroadcastChannel", async () => {
  const restore = installDom();
  try {
    const store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("handoff");
    const gates = [];
    const beforePaper = () => new Promise((resolve) => gates.push(resolve));
    const data = modA.createImportCoordinator({ store, beforePaper });
    const reader = modB.createImportCoordinator({ store, beforePaper });
    assert.notEqual(data.id, reader.id);
    assert.notEqual(data.id, "import-1");
    assert.notEqual(reader.id, "import-1");
    data.attach("data");
    reader.attach("reader");
    await flush(20);
    const job = data.importFolder(library());
    await until(() => gates.length >= 1);
    gates.shift()();
    await until(() => gates.length >= 1);
    const closing = data.detach("data");
    gates.shift()();
    await closing;
    await until(() => gates.length >= 1, 120);
    assert.equal(await store.getPaper(HASH_B), null);
    gates.shift()();
    await flush(40);
    assert.notEqual(await store.getPaper(HASH_B), null);
    await job;
    data.destroy();
    reader.destroy();
    await store.closeLibrary?.();
  } finally {
    restore();
  }
});

test("a running import ignores lock-free instead of clearing its paper list", async () => {
  const restore = installDom();
  let releaseWrite = null;
  let releaseRelist = null;
  try {
    const store = storeFor("memory");
    const children = {
      [HASH_A]: paper(HASH_A, [page(1, "甲")], { meta: { title: "甲", rev: 1, updatedAt: 1 } }),
      [HASH_B]: paper(HASH_B, [page(1, "乙")], { meta: { title: "乙", rev: 1, updatedAt: 1 } })
    };
    let listings = 0;
    const handle = {
      kind: "directory",
      name: "files",
      permission: "granted",
      async queryPermission() { return "granted"; },
      async requestPermission() { return "granted"; },
      entries() {
        listings += 1;
        const pairs = Object.entries(children).map(([name, child]) => [name, child]);
        if (listings === 1) return pairs;
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) => { releaseRelist = resolve; });
            for (const pair of pairs) yield pair;
          }
        };
      }
    };
    let writes = 0;
    const original = store.writeImportMeta.bind(store);
    store.writeImportMeta = async (value) => {
      const result = await original(value);
      writes += 1;
      if (writes === 2) await new Promise((resolve) => { releaseWrite = resolve; });
      return result;
    };
    const { modA, modB } = await coordinatorPair("race");
    const locks = createMemoryLocks();
    const reader = modA.createImportCoordinator({ store, locks });
    const other = modB.createImportCoordinator({ store, locks });
    assert.notEqual(reader.id, other.id);
    other.attach("data");
    reader.attach("reader");
    await flush(20);
    const job = reader.importFolder(handle);
    await until(() => typeof releaseWrite === "function");
    await other.detach("data");
    await flush(30);
    assert.equal(listings, 1);
    releaseWrite();
    releaseWrite = null;
    await job;
    assert.notEqual(await store.getPaper(HASH_B), null);
    const saved = await store.readImportMeta();
    assert.equal(saved == null || saved.phase !== "interrupted", true);
    reader.destroy();
    other.destroy();
    await store.closeLibrary?.();
  } finally {
    releaseWrite?.();
    releaseRelist?.();
    restore();
  }
});

test("F4UI-26 the reader chip shows import progress from another page", async () => {
  const restore = installDom();
  try {
    const store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("chip");
    let release = null;
    const locks = createMemoryLocks();
    const data = modA.createImportCoordinator({
      store,
      locks,
      beforePaper: () => new Promise((resolve) => { release = resolve; })
    });
    const reader = modB.createImportCoordinator({ store, locks });
    assert.notEqual(data.id, reader.id);
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
    const host = document.createElement("div");
    const chip = createLibraryChip({ host, timers, moveDelayMs: 800, doneHoldMs: 30000, fadeMs: 200 });
    const binding = bindImportChip(chip, { coordinator: reader, store });
    await flush(20);
    const startedAt = Date.now();
    const job = data.importFolder(onePaperDir());
    await until(() => /正在导入 0\/1|正在导入 0 篇/.test(host.textContent));
    assert.ok(Date.now() - startedAt < 300, `chip waited ${Date.now() - startedAt}ms`);
    assert.equal(queue.length, 0);
    release();
    await job;
    await until(() => host.textContent.includes("✓ 已导入 1 篇"));
    binding.destroy();
    data.destroy();
    chip.destroy();
    await store.closeLibrary?.();
  } finally {
    restore();
  }
});

function grantMarkedLocks() {
  const inner = createMemoryLocks();
  let readerGranted = false;
  return {
    readerGranted: () => readerGranted,
    request(name, options, callback) {
      const opts = typeof options === "function" ? {} : (options || {});
      const waits = typeof options !== "function" && opts.ifAvailable !== true;
      return inner.request(name, options, (lock) => {
        if (waits && lock) readerGranted = true;
        return callback(lock);
      });
    }
  };
}

test("a queued reader keeps mirroring progress, pause, and done", { timeout: 20000 }, async () => {
  const restore = installDom();
  const gates = [];
  let data = null;
  let reader = null;
  let store = null;
  try {
    store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("mirror-wait");
    const locks = grantMarkedLocks();
    const beforePaper = () => new Promise((resolve) => gates.push(resolve));
    data = modA.createImportCoordinator({ store, locks, beforePaper });
    reader = modB.createImportCoordinator({ store, locks });
    let mid = false;
    let paused = false;
    let doneWhileQueued = false;
    reader.subscribe((view) => {
      if (locks.readerGranted()) return;
      if (view.phase === "running" && view.done === 1) mid = true;
      if (view.phase === "paused") paused = true;
      if (view.phase === "done") doneWhileQueued = true;
    });
    const host = document.createElement("div");
    const chip = createLibraryChip({ host, moveDelayMs: 800, doneHoldMs: 30000, fadeMs: 200 });
    const binding = bindImportChip(chip, { coordinator: reader, store });
    data.attach("data");
    await flush(10);
    const job = data.importFolder(library());
    await until(() => gates.length >= 1 && /正在导入 0\/2/.test(host.textContent));
    assert.equal(locks.readerGranted(), false);
    gates.shift()();
    await until(() => mid && /正在导入 1\/2/.test(host.textContent));
    assert.equal(locks.readerGranted(), false);
    await data.pause();
    await until(() => paused && /已暂停 1\/2/.test(host.textContent));
    assert.equal(locks.readerGranted(), false);
    gates.shift()();
    await job;
    binding.destroy();
    data.destroy();
    reader.destroy();
    chip.destroy();
    await store.closeLibrary?.();

    const store2 = storeFor("memory");
    store = store2;
    const pair = await coordinatorPair("mirror-done");
    const locks2 = grantMarkedLocks();
    const bus2 = createImportBus();
    const gates2 = [];
    data = pair.modA.createImportCoordinator({
      store: store2,
      locks: locks2,
      bus: bus2,
      beforePaper: () => new Promise((resolve) => gates2.push(resolve))
    });
    reader = pair.modB.createImportCoordinator({ store: store2, locks: locks2, bus: bus2 });
    doneWhileQueued = false;
    reader.subscribe((view) => {
      if (locks2.readerGranted()) return;
      if (view.phase === "done") doneWhileQueued = true;
    });
    const host2 = document.createElement("div");
    const chip2 = createLibraryChip({ host: host2, moveDelayMs: 800, doneHoldMs: 30000, fadeMs: 200 });
    const binding2 = bindImportChip(chip2, { coordinator: reader, store: store2 });
    data.attach("data");
    const job2 = data.importFolder(library());
    await until(() => gates2.length >= 1);
    gates2.shift()();
    await until(() => gates2.length >= 1);
    gates2.shift()();
    await until(() => doneWhileQueued && /✓ 已导入/.test(host2.textContent), 200);
    assert.equal(doneWhileQueued, true);
    await job2;
    binding2.destroy();
    data.destroy();
    reader.destroy();
    chip2.destroy();
    await store2.closeLibrary?.();
    store = null;
  } finally {
    while (gates.length) gates.shift()();
    data?.destroy();
    reader?.destroy();
    await store?.closeLibrary?.();
    restore();
  }
});

test("closing a queued reader does not rewrite the holder's checkpoint", { timeout: 20000 }, async () => {
  const restore = installDom();
  let data = null;
  let reader = null;
  let store = null;
  let release = null;
  try {
    store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("stale-meta");
    const locks = watchedLocks();
    let n = 0;
    data = modA.createImportCoordinator({
      store,
      locks,
      beforePaper() {
        n += 1;
        if (n >= 2) return new Promise((resolve) => { release = resolve; });
      }
    });
    reader = modB.createImportCoordinator({ store, locks });
    data.attach("data");
    reader.attach("reader");
    const job = data.importFolder(library());
    await until(() => n >= 2 && locks.waiting() >= 1, 200);
    assert.notEqual(await store.getPaper(HASH_A), null);
    assert.equal(await store.getPaper(HASH_B), null);
    const before = await store.readImportMeta();
    assert.deepEqual(before.doneDocs, [HASH_A]);
    await reader.detach("reader");
    const after = await store.readImportMeta();
    assert.equal(after.phase, "running");
    assert.deepEqual(after.doneDocs, [HASH_A]);
    release();
    release = null;
    await job;
    assert.notEqual(await store.getPaper(HASH_B), null);
  } finally {
    release?.();
    data?.destroy();
    reader?.destroy();
    await store?.closeLibrary?.();
    restore();
  }
});

test("detach during the post-grant later check does not import", { timeout: 20000 }, async () => {
  const restore = installDom();
  let data = null;
  let reader = null;
  let store = null;
  let releaseHold = null;
  let releaseLater = null;
  try {
    store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("later-gap");
    const locks = watchedLocks();
    let arm = false;
    let laterAfter = 0;
    const session = {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [];
        if (arm && list.includes(SESSION_LATER)) {
          laterAfter += 1;
          if (laterAfter === 2) await new Promise((resolve) => { releaseLater = resolve; });
        }
        return {};
      },
      async set() {}
    };
    let calls = 0;
    data = modA.createImportCoordinator({
      store,
      locks,
      beforePaper() {
        calls += 1;
        return new Promise((resolve) => { releaseHold = resolve; });
      }
    });
    reader = modB.createImportCoordinator({ store, locks, session });
    data.attach("data");
    reader.attach("reader");
    const job = data.importFolder(library());
    await until(() => calls === 1 && locks.waiting() >= 1, 200);
    arm = true;
    const closingHolder = data.detach("data");
    releaseHold();
    releaseHold = null;
    await closingHolder;
    await until(() => typeof releaseLater === "function", 200);
    const closingReader = reader.detach("reader");
    releaseLater();
    releaseLater = null;
    await closingReader;
    await flush(40);
    assert.equal(calls, 1);
    assert.equal(await store.getPaper(HASH_A), null);
    assert.equal(await store.getPaper(HASH_B), null);
    void job;
  } finally {
    releaseHold?.();
    releaseLater?.();
    data?.destroy();
    reader?.destroy();
    await store?.closeLibrary?.();
    restore();
  }
});

test("a reader that attaches mid-paper queues a blocking request", { timeout: 20000 }, async () => {
  const restore = installDom();
  let data = null;
  let reader = null;
  let store = null;
  let page = null;
  try {
    store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("attach-mid");
    const locks = documentLocks();
    page = locks.open();
    const readerPage = locks.open();
    let calls = 0;
    data = modA.createImportCoordinator({
      store,
      locks: page,
      beforePaper() {
        calls += 1;
        return new Promise(() => {});
      }
    });
    reader = modB.createImportCoordinator({ store, locks: readerPage });
    data.attach("data");
    const job = data.importFolder(library());
    await until(() => calls === 1);
    reader.attach("reader");
    await until(() => locks.waiting() >= 1, 200);
    assert.equal(calls, 1);
    assert.equal(await store.getPaper(HASH_A), null);
    page.destroy();
    let handed = false;
    for (let turn = 0; turn < 400 && !handed; turn += 1) {
      handed = Boolean(await store.getPaper(HASH_A)) && Boolean(await store.getPaper(HASH_B));
      if (!handed) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(handed, true);
    assert.equal(calls, 1);
    void job;
  } finally {
    page?.destroy();
    data?.destroy();
    reader?.destroy();
    await store?.closeLibrary?.();
    restore();
  }
});

test("pause and 以后再说 survive in chrome.storage.session", async () => {
  const restore = installDom();
  const previous = globalThis.chrome;
  const bag = new Map();
  globalThis.chrome = {
    storage: {
      session: {
        get(keys) {
          const out = {};
          const list = Array.isArray(keys) ? keys : (keys == null ? [...bag.keys()] : [keys]);
          for (const key of list) if (bag.has(key)) out[key] = bag.get(key);
          return Promise.resolve(out);
        },
        set(patch) {
          for (const [key, value] of Object.entries(patch || {})) bag.set(key, value);
          return Promise.resolve();
        }
      }
    }
  };
  try {
    const store = storeFor("memory");
    const { modA, modB } = await coordinatorPair("session");
    const gates = [];
    const holder = modA.createImportCoordinator({
      store,
      beforePaper: () => new Promise((resolve) => gates.push(resolve))
    });
    const other = modB.createImportCoordinator({ store });
    assert.notEqual(holder.id, other.id);
    const job = holder.importFolder(library());
    await until(() => gates.length >= 1);
    await other.pause();
    gates.shift()();
    await job;
    assert.equal(bag.get(SESSION_PAUSED), true);
    assert.equal(await store.getPaper(HASH_B), null);
    const reloaded = modB.createImportCoordinator({ store });
    reloaded.attach("reader");
    await flush(30);
    assert.equal(reloaded.state().phase, "paused");
    assert.equal(await store.getPaper(HASH_B), null);
    holder.destroy();
    other.destroy();
    reloaded.destroy();
    bag.clear();
    await store.writeImportMeta({
      phase: "interrupted",
      source: "folder",
      folderName: "files",
      paperIds: [HASH_A, HASH_B],
      doneDocs: [HASH_A],
      total: 2,
      permission: "granted",
      directoryHandle: library("granted")
    });
    const first = modA.createImportCoordinator({ store });
    await first.later();
    assert.equal(bag.get(SESSION_LATER), true);
    const again = [];
    const second = modB.createImportCoordinator({
      store,
      beforePaper: () => new Promise((resolve) => again.push(resolve))
    });
    second.attach("reader");
    await flush(30);
    assert.equal(second.state().later, true);
    assert.notEqual(second.state().phase, "running");
    assert.equal(again.length, 0);
    assert.equal(await store.getPaper(HASH_B), null);
    first.destroy();
    second.destroy();
    await store.closeLibrary?.();
  } finally {
    globalThis.chrome = previous;
    restore();
  }
});

test("a refused persist grant shows the library card on load and after a page save", async () => {
  const restore = installDom();
  const previous = globalThis.chrome;
  const bag = new Map([["libraryPersistGranted", false]]);
  globalThis.chrome = {
    storage: {
      local: {
        get(keys) {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) if (bag.has(key)) out[key] = bag.get(key);
          return Promise.resolve(out);
        },
        set(patch) {
          for (const [key, value] of Object.entries(patch || {})) bag.set(key, value);
          return Promise.resolve();
        }
      },
      session: {
        get(keys) {
          if (this !== globalThis.chrome.storage.session) throw new TypeError("Illegal invocation");
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (bag.has(key)) out[key] = bag.get(key);
          return Promise.resolve(out);
        },
        set(patch) {
          if (this !== globalThis.chrome.storage.session) throw new TypeError("Illegal invocation");
          for (const [key, value] of Object.entries(patch || {})) bag.set(key, value);
          return Promise.resolve();
        }
      }
    }
  };
  const host = document.createElement("div");
  const card = createPersistCard({ host });
  async function showIfRefused() {
    if (card.isOpen()) return;
    if (await persistCardHiddenThisSession(globalThis.chrome.storage.session)) return;
    const decision = await readPersistCardState(globalThis.chrome.storage.local);
    if (decision.show) card.show();
  }
  try {
    assert.equal((await readPersistCardState(globalThis.chrome.storage.local)).show, true);
    assert.equal(card.isOpen(), false);
    await showIfRefused();
    assert.equal(card.isOpen(), true);
    assert.match(host.textContent, /文献库和笔记可能会被浏览器清掉/);
    card.hide();
    assert.equal(card.isOpen(), false);
    const store = storeFor("memory");
    let saved = 0;
    setLibraryUiHooks({
      onLibraryPageSaved() {
        saved += 1;
        return showIfRefused();
      }
    });
    await saveLibraryPage({
      hash: HASH_A,
      title: "论文甲",
      page: 1,
      pageCount: 1,
      pairs: [{ id: "p", source: "s", translation: "甲" }],
      targetLang: "zh-CN"
    }, { store });
    assert.equal(saved, 1);
    assert.equal(card.isOpen(), true);
    card.hide();
    bag.set(PERSIST_CARD_SESSION_KEY, true);
    await showIfRefused();
    assert.equal(card.isOpen(), false);
    const area = globalThis.chrome.storage.session;
    assert.throws(() => area.get.call(undefined, PERSIST_CARD_SESSION_KEY), /Illegal invocation/);
    await store.closeLibrary?.();
    const viewer = readFileSync(new URL("../pdf/viewer.js", import.meta.url), "utf8");
    const hiddenFn = viewer.slice(viewer.indexOf("async function persistHiddenThisSession"), viewer.indexOf("function flushStagedNotes"));
    assert.match(hiddenFn, /persistCardHiddenThisSession\(globalThis\.chrome\?\.storage\?\.session\)/);
    assert.equal(/\.get\(/.test(hiddenFn), false);
    const install = viewer.slice(viewer.indexOf("function installLibraryChrome"), viewer.indexOf("function installNotesUi"));
    assert.match(install, /onLibraryPageSaved\(\) \{\s*void maybeShowPersistCard\(\)/);
    assert.match(install, /void maybeShowPersistCard\(\);\n\}/);
    const adopt = viewer.slice(viewer.indexOf("async function adoptDoc"), viewer.indexOf("function shortTitle"));
    assert.match(adopt, /setHasDoc\(true\);\n\s*void maybeShowPersistCard\(\)/);
    const layoutFn = viewer.slice(viewer.indexOf("function persistPageLayout"), viewer.indexOf("function persistPagePairs"));
    const pairsFn = viewer.slice(viewer.indexOf("function persistPagePairs"), viewer.indexOf("function bindSavedPairs"));
    assert.match(layoutFn, /await saveLibraryPage\(savedPayload\);\n\s*void maybeShowPersistCard\(\)/);
    assert.match(pairsFn, /await saveLibraryPage\(savedPayload\);\n\s*void maybeShowPersistCard\(\)/);
    const remember = viewer.slice(viewer.indexOf("function rememberTranslation"), viewer.indexOf("function rememberSkipHole"));
    const early = remember.indexOf("return Promise.resolve()");
    assert.ok(early > 0 && remember.lastIndexOf("maybeShowPersistCard", early) > 0);
    assert.match(remember, /hash === "nohash"\) \{\n\s*void maybeShowPersistCard\(\)/);
    const retranslate = viewer.slice(
      viewer.indexOf("async function forceRetranslateCurrentPage"),
      viewer.indexOf("function titleStructureFailed")
    );
    const rememberAt = retranslate.indexOf("await rememberTranslation(");
    const finallyAt = retranslate.indexOf("finally {", rememberAt);
    assert.ok(finallyAt > rememberAt);
    assert.match(retranslate.slice(finallyAt, finallyAt + 160), /maybeShowPersistCard/);
  } finally {
    setLibraryUiHooks({});
    globalThis.chrome = previous;
    restore();
  }
});

test("library export downloads the file and stays quiet when the download is refused", async () => {
  const restore = installDom();
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const blobs = [];
  URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return "blob:library-export";
  };
  URL.revokeObjectURL = () => {};
  try {
    const store = storeFor("memory");
    await store.importBundle({
      format: LIBRARY_FORMAT,
      schema: LIBRARY_SCHEMA,
      papers: [{
        paper: { docHash: HASH_A, title: "甲", origin: "local", rev: 1, updatedAt: 1, lastOpenedAt: 1, schema: LIBRARY_SCHEMA, apiKey: "SECRET" },
        pages: [{ docHash: HASH_A, page: 1, pairs: [{ id: "p", source: "s", translation: "t" }], rev: 1, updatedAt: 1, schema: LIBRARY_SCHEMA }]
      }]
    });
    const root = document.createElement("div");
    const anchors = [];
    const orig = document.createElement.bind(document);
    document.createElement = (tag) => {
      const node = orig(tag);
      if (String(tag).toLowerCase() === "a") anchors.push(node);
      return node;
    };
    const panel = mountDataPanel(root, {
      store,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      now: () => Date.UTC(2026, 9, 15, 8, 5)
    });
    await panel.reload();
    click(root, "导出文献库");
    await flush(20);
    assert.equal(anchors.length, 1);
    assert.match(anchors[0].download, /^open-immerse-library-\d{8}-\d{4}\.json$/);
    assert.equal(anchors[0].href, "blob:library-export");
    assert.equal(blobs.length, 1);
    const text = await blobs[0].text();
    assert.equal(text.includes("SECRET"), false);
    assert.equal(JSON.parse(text).papers[0].paper.title, "甲");
    assert.match(root.textContent, /已导出/);
    const options = readFileSync(new URL("../options/options.js", import.meta.url), "utf8");
    assert.match(options, /download\(filename, text\) \{\n\s*return downloadBlob\(filename, new Blob\(\[text\]/);
    const refused = document.createElement("div");
    const quiet = mountDataPanel(refused, {
      store,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      download: async () => false
    });
    await quiet.reload();
    click(refused, "导出文献库");
    await flush(20);
    assert.equal(refused.textContent.includes("已导出"), false);
    const silent = document.createElement("div");
    const missing = mountDataPanel(silent, {
      store,
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      download: async () => undefined
    });
    await missing.reload();
    click(silent, "导出文献库");
    await flush(20);
    assert.equal(silent.textContent.includes("已导出"), false);
    panel.destroy();
    quiet.destroy();
    missing.destroy();
    await store.closeLibrary?.();
  } finally {
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    restore();
  }
});
