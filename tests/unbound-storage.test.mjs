// chrome.storage methods throw TypeError: Illegal invocation unless `this` is the StorageArea.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cacheableLayout, layoutCacheKey } from "../lib/pdf-layout-client.js";
import { readLayoutCache, writeLayoutCache } from "../lib/pdf-layout-cache.js";
import { recordedPersistDenied } from "../lib/notes-store.js";
import {
  clampZoom,
  MIRROR_ZOOM_CHIP_POS_KEY,
  MIRROR_ZOOM_STORAGE_KEY,
  normalizeZoomChipPos,
  ZOOM_CHIP_STORAGE_KEY
} from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const layoutSrc = readFileSync(join(root, "lib/pdf-layout-cache.js"), "utf8");
const SECRET = "SECRET_LAYOUT_TEXT";
const KEYS = [ZOOM_CHIP_STORAGE_KEY, MIRROR_ZOOM_CHIP_POS_KEY, MIRROR_ZOOM_STORAGE_KEY, "notesPersistGranted"];

let turn = Promise.resolve();
function exclusive(fn) {
  const run = turn.then(fn, fn);
  turn = run.then(() => {}, () => {});
  return run;
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const prefix = source.slice(Math.max(0, start - 6), start);
  const from = prefix === "async " ? start - 6 : start;
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function loadViewerStorage(localStorage) {
  const names = [
    "warnViewerStorage",
    "readZoomChipPos",
    "persistZoomChipPos",
    "readMirrorZoomChipPos",
    "persistMirrorZoomChipPos",
    "readMirrorZoom",
    "persistMirrorZoom",
    "readStoredPersistDenied"
  ];
  const body = names.map((name) => extractFunction(viewerSrc, name)).join("\n");
  const factory = new Function(
    "ZOOM_CHIP_STORAGE_KEY",
    "MIRROR_ZOOM_CHIP_POS_KEY",
    "MIRROR_ZOOM_STORAGE_KEY",
    "normalizeZoomChipPos",
    "clampZoom",
    "recordedPersistDenied",
    "localStorage",
    `let zoomChipCustom = false;\nlet mirrorZoomChipCustom = false;\n${body}\nreturn { readZoomChipPos, persistZoomChipPos, readMirrorZoomChipPos, persistMirrorZoomChipPos, readMirrorZoom, persistMirrorZoom, readStoredPersistDenied };`
  );
  return factory(
    ZOOM_CHIP_STORAGE_KEY,
    MIRROR_ZOOM_CHIP_POS_KEY,
    MIRROR_ZOOM_STORAGE_KEY,
    normalizeZoomChipPos,
    clampZoom,
    recordedPersistDenied,
    localStorage
  );
}

function chromeLike(seed = {}) {
  const bag = { ...seed };
  const state = { failGet: 0, failSet: 0, undefinedGet: 0, malformedGet: 0, setCalls: 0, getCalls: 0 };
  const local = {
    get(key) {
      if (this !== local) throw new TypeError("Illegal invocation");
      state.getCalls += 1;
      if (state.failGet > 0) {
        state.failGet -= 1;
        const error = new Error("do-not-log-this-value");
        error.name = "QuotaExceededError";
        throw error;
      }
      if (state.undefinedGet > 0) {
        state.undefinedGet -= 1;
        return Promise.resolve(undefined);
      }
      if (state.malformedGet > 0) {
        state.malformedGet -= 1;
        return Promise.resolve("not-a-bag");
      }
      const names = key == null ? Object.keys(bag) : (Array.isArray(key) ? key : [key]);
      const out = {};
      for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(bag, name)) out[name] = bag[name];
      }
      return Promise.resolve(out);
    },
    set(values) {
      if (this !== local) throw new TypeError("Illegal invocation");
      state.setCalls += 1;
      if (state.failSet > 0) {
        state.failSet -= 1;
        const error = new Error("do-not-log-this-value");
        error.name = "QuotaExceededError";
        throw error;
      }
      Object.assign(bag, values || {});
      return Promise.resolve();
    },
    remove(keys) {
      if (this !== local) throw new TypeError("Illegal invocation");
      for (const name of [].concat(keys)) delete bag[name];
      return Promise.resolve();
    },
    clear() {
      if (this !== local) throw new TypeError("Illegal invocation");
      for (const name of Object.keys(bag)) delete bag[name];
      return Promise.resolve();
    }
  };
  return { local, bag, state };
}

function memoryWeb(seed = {}) {
  const data = { ...seed };
  const web = {
    data,
    fail: false,
    getItem(key) {
      if (web.failGet) {
        web.failGet = false;
        const error = new Error("do-not-log-this-value");
        error.name = "SecurityError";
        throw error;
      }
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      if (web.fail) {
        web.fail = false;
        const error = new Error("do-not-log-this-value");
        error.name = "QuotaExceededError";
        throw error;
      }
      data[key] = String(value);
    }
  };
  return web;
}

function useChrome(area) {
  const previous = globalThis.chrome;
  globalThis.chrome = area ? { storage: { local: area.local } } : undefined;
  return () => {
    globalThis.chrome = previous;
  };
}

function captureWarn() {
  const seen = [];
  const original = console.warn;
  console.warn = (message) => {
    seen.push(String(message));
  };
  return {
    seen,
    restore() {
      console.warn = original;
    }
  };
}

function assertRedacted(message) {
  assert.match(message, /^[\w ]+ storage failed \(\w+\)$/);
  assert.equal(message.includes("do-not-log-this-value"), false);
  assert.equal(message.includes(SECRET), false);
  for (const key of KEYS) assert.equal(message.includes(key), false, message);
}

function legacyLayout(bid, text, rev) {
  return {
    blocks: [{ bid, text }],
    layoutVersion: rev,
    protocol: "blocks-1",
    textSource: "text-layer",
    mode: "text-layer"
  };
}

function layoutStore() {
  const rows = new Map();
  const id = (docHash, page, mode, protocol) => `${docHash}\0${page}\0${mode}\0${protocol}`;
  const store = {
    rows,
    fail: false,
    async getLayout(docHash, page, mode, protocol) {
      return rows.get(id(docHash, page, mode, protocol)) || null;
    },
    async putLayout(record) {
      if (store.fail) {
        store.fail = false;
        const error = new Error("do-not-log-this-value");
        error.name = "QuotaExceededError";
        throw error;
      }
      rows.set(id(record.docHash, record.page, record.mode, record.protocol), {
        docHash: record.docHash,
        page: record.page,
        mode: record.mode,
        protocol: record.protocol,
        layoutRev: record.layoutRev,
        layout: record.layout
      });
    }
  };
  return store;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("unbound chrome.storage", { concurrency: 1 }, () => {
  test("detached chrome.storage get and set throw Illegal invocation", () => exclusive(async () => {
    const area = chromeLike({ [ZOOM_CHIP_STORAGE_KEY]: { left: 1, top: 2 } });
    const detachedGet = area.local.get;
    const detachedSet = area.local.set;
    await assert.rejects(Promise.resolve().then(() => detachedGet(ZOOM_CHIP_STORAGE_KEY)), /Illegal invocation/);
    await assert.rejects(Promise.resolve().then(() => detachedSet({ [ZOOM_CHIP_STORAGE_KEY]: { left: 3, top: 4 } })), /Illegal invocation/);
    assert.deepEqual(area.bag[ZOOM_CHIP_STORAGE_KEY], { left: 1, top: 2 });
    assert.match(layoutSrc, /get\.call\(local,/);
    assert.match(viewerSrc, /get\.call\(local,/);
    assert.match(viewerSrc, /set\.call\(local,/);
    assert.equal(viewerSrc.includes("const get = globalThis.chrome?.storage?.local?.get;\n    if (typeof get === \"function\") {\n      const bag = await get("), false);
  }));

  test("layout cache reads a stored legacy layout through a bound get", () => exclusive(async () => {
    const key = layoutCacheKey({ hash: "attention", page: 3, mode: "text-layer" });
    const legacy = legacyLayout("p3", SECRET, "rev-1");
    const area = chromeLike({ [key]: legacy });
    const store = layoutStore();
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const detached = area.local.get;
      await assert.rejects(Promise.resolve().then(() => detached(key)), /Illegal invocation/);
      const read = await readLayoutCache(key, { store });
      assert.equal(read.blocks[0].bid, "p3");
      assert.equal(read.blocks[0].text, SECRET);
      assert.equal(area.state.getCalls > 0, true);
      assert.equal(area.state.setCalls, 0);
      assert.equal(area.bag[key], legacy);
      const row = await store.getLayout("attention", 3, "text-layer", key.split(":").at(-2));
      assert.equal(row.layoutRev, "rev-1");
      assert.equal(row.layout.blocks[0].bid, "p3");
      assert.equal(warnings.seen.length, 0);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("layout cache storage throw logs the error name and keeps the fallback", () => exclusive(async () => {
    const key = layoutCacheKey({ hash: "attention", page: 4, mode: "text-layer" });
    const legacy = legacyLayout("p4", SECRET, "rev-4");
    const area = chromeLike({ [key]: legacy });
    area.state.failGet = 1;
    const store = layoutStore();
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const read = await readLayoutCache(key, { store });
      assert.equal(read, null);
      assert.equal(store.rows.size, 0);
      assert.equal(area.bag[key], legacy);
      assert.equal(warnings.seen.length, 1);
      assert.match(warnings.seen[0], /QuotaExceededError/);
      assertRedacted(warnings.seen[0]);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("layout cache undefined result falls back without writing the library", () => exclusive(async () => {
    const key = layoutCacheKey({ hash: "attention", page: 5, mode: "text-layer" });
    const area = chromeLike({ [key]: legacyLayout("p5", SECRET, "rev-5") });
    area.state.undefinedGet = 1;
    const store = layoutStore();
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      assert.equal(await readLayoutCache(key, { store }), null);
      assert.equal(store.rows.size, 0);
      assert.equal(warnings.seen.length, 0);
      assert.equal(area.bag[key].blocks[0].bid, "p5");
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("layout cache malformed result falls back without writing the library", () => exclusive(async () => {
    const key = layoutCacheKey({ hash: "attention", page: 6, mode: "text-layer" });
    const area = chromeLike({ [key]: legacyLayout("p6", SECRET, "rev-6") });
    area.state.malformedGet = 1;
    const store = layoutStore();
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      assert.equal(await readLayoutCache(key, { store }), null);
      assert.equal(store.rows.size, 0);
      assert.equal(area.state.setCalls, 0);
      assert.equal(warnings.seen.length, 0);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("layout cache without chrome does not warn and does not write", () => exclusive(async () => {
    const key = layoutCacheKey({ hash: "attention", page: 7, mode: "text-layer" });
    const store = layoutStore();
    const restore = useChrome(null);
    const warnings = captureWarn();
    try {
      assert.equal(await readLayoutCache(key, { store }), null);
      assert.equal(store.rows.size, 0);
      assert.equal(warnings.seen.length, 0);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("layout cache copy failure leaves the chrome key and still returns the legacy value", () => exclusive(async () => {
    const key = layoutCacheKey({ hash: "attention", page: 8, mode: "text-layer" });
    const legacy = legacyLayout("p8", SECRET, "rev-8");
    const planted = JSON.stringify(legacy);
    const area = chromeLike({ [key]: legacy });
    const store = layoutStore();
    store.fail = true;
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const read = await readLayoutCache(key, { store });
      assert.equal(read.blocks[0].bid, "p8");
      assert.equal(store.rows.size, 0);
      assert.equal(JSON.stringify(area.bag[key]), planted);
      assert.equal(area.state.setCalls, 0);
      assert.equal(warnings.seen.length, 0);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("layout cache two realms leave the chrome key unchanged", () => exclusive(async () => {
    const key = layoutCacheKey({ hash: "attention", page: 9, mode: "text-layer" });
    const legacy = legacyLayout("legacy", SECRET, "rev-legacy");
    const planted = JSON.stringify(legacy);
    const area = chromeLike({ [key]: legacy });
    const store = layoutStore();
    const restore = useChrome(area);
    const warnings = captureWarn();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const original = area.local.get;
    area.local.get = async function get(keys) {
      entered += 1;
      if (entered <= 2) await gate;
      return original.call(this, keys);
    };
    try {
      const tabA = await import(pathToFileURL(join(root, "lib/pdf-layout-cache.js")).href + "?realm=a");
      const tabB = await import(pathToFileURL(join(root, "lib/pdf-layout-cache.js")).href + "?realm=b");
      const left = tabA.readLayoutCache(key, { store });
      const right = tabB.readLayoutCache(key, { store });
      const started = Date.now();
      while (entered < 2 && Date.now() - started < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.equal(entered, 2);
      assert.equal(JSON.stringify(area.bag[key]), planted);
      const fresh = legacyLayout("fresh", "new text", "rev-fresh");
      await tabB.writeLayoutCache(key, fresh, { store });
      release();
      const [fromA, fromB] = await Promise.all([left, right]);
      const bids = new Set([fromA?.blocks?.[0]?.bid, fromB?.blocks?.[0]?.bid, (await store.getLayout("attention", 9, "text-layer", key.split(":").at(-2)))?.layout?.blocks?.[0]?.bid]);
      for (const bid of bids) assert.ok(bid === "legacy" || bid === "fresh", String(bid));
      assert.equal(JSON.stringify(area.bag[key]), planted);
      assert.equal(area.state.setCalls, 0);
      for (const message of warnings.seen) assertRedacted(message);
    } finally {
      release();
      warnings.restore();
      restore();
    }
  }));

  test("zoom chip position is read and written with a bound storage area", () => exclusive(async () => {
    const area = chromeLike();
    const web = memoryWeb();
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const api = loadViewerStorage(web);
      const detached = area.local.get;
      await assert.rejects(Promise.resolve().then(() => detached(ZOOM_CHIP_STORAGE_KEY)), /Illegal invocation/);
      assert.equal(await api.readZoomChipPos(), null);
      api.persistZoomChipPos({ left: 12.5, top: 40 });
      assert.deepEqual(area.bag[ZOOM_CHIP_STORAGE_KEY], { left: 12.5, top: 40 });
      assert.equal(web.data[ZOOM_CHIP_STORAGE_KEY], JSON.stringify({ left: 12.5, top: 40 }));
      delete web.data[ZOOM_CHIP_STORAGE_KEY];
      assert.deepEqual(await api.readZoomChipPos(), { left: 12.5, top: 40 });
      assert.equal(warnings.seen.length, 0);
      const calls = area.state.setCalls;
      api.persistZoomChipPos({ left: "nope", top: 1 });
      assert.equal(area.state.setCalls, calls);
      assert.deepEqual(area.bag[ZOOM_CHIP_STORAGE_KEY], { left: 12.5, top: 40 });
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("zoom chip storage throw logs the error name and falls back", () => exclusive(async () => {
    const area = chromeLike({ [ZOOM_CHIP_STORAGE_KEY]: { left: 3, top: 4 } });
    const web = memoryWeb({ [ZOOM_CHIP_STORAGE_KEY]: JSON.stringify({ left: 8, top: 9 }) });
    area.state.failGet = 1;
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const api = loadViewerStorage(web);
      assert.deepEqual(await api.readZoomChipPos(), { left: 8, top: 9 });
      assert.equal(warnings.seen.length, 1);
      assert.match(warnings.seen[0], /QuotaExceededError/);
      assertRedacted(warnings.seen[0]);
      assert.deepEqual(area.bag[ZOOM_CHIP_STORAGE_KEY], { left: 3, top: 4 });
      area.state.failSet = 1;
      api.persistZoomChipPos({ left: 20, top: 21 });
      assert.deepEqual(area.bag[ZOOM_CHIP_STORAGE_KEY], { left: 3, top: 4 });
      assert.equal(web.data[ZOOM_CHIP_STORAGE_KEY], JSON.stringify({ left: 20, top: 21 }));
      assert.match(warnings.seen[1], /QuotaExceededError/);
      assertRedacted(warnings.seen[1]);
      web.fail = true;
      api.persistZoomChipPos({ left: 30, top: 31 });
      assert.deepEqual(area.bag[ZOOM_CHIP_STORAGE_KEY], { left: 30, top: 31 });
      assert.equal(web.data[ZOOM_CHIP_STORAGE_KEY], JSON.stringify({ left: 20, top: 21 }));
      assertRedacted(warnings.seen[2]);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("zoom chip undefined or malformed chrome value falls back to localStorage", () => exclusive(async () => {
    const area = chromeLike({ [ZOOM_CHIP_STORAGE_KEY]: { left: "x", top: 1 } });
    const web = memoryWeb({ [ZOOM_CHIP_STORAGE_KEY]: JSON.stringify({ left: 6, top: 7 }) });
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const api = loadViewerStorage(web);
      const before = JSON.stringify(area.bag);
      assert.deepEqual(await api.readZoomChipPos(), { left: 6, top: 7 });
      area.state.undefinedGet = 1;
      assert.deepEqual(await api.readZoomChipPos(), { left: 6, top: 7 });
      area.state.malformedGet = 1;
      assert.deepEqual(await api.readZoomChipPos(), { left: 6, top: 7 });
      assert.equal(JSON.stringify(area.bag), before);
      assert.equal(warnings.seen.length, 0);
      web.failGet = true;
      assert.equal(await api.readZoomChipPos(), null);
      assert.match(warnings.seen[0], /SecurityError/);
      assertRedacted(warnings.seen[0]);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("zoom chip unload after localStorage write leaves chrome unchanged", () => exclusive(async () => {
    const area = chromeLike({ [ZOOM_CHIP_STORAGE_KEY]: { left: 1, top: 2 } });
    const web = memoryWeb();
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const api = loadViewerStorage(web);
      const sets = area.state.setCalls;
      assert.throws(() => api.persistZoomChipPos({ left: 9, top: 11 }, () => {
        throw new Error("unload");
      }), /unload/);
      assert.equal(area.state.setCalls, sets);
      assert.deepEqual(area.bag[ZOOM_CHIP_STORAGE_KEY], { left: 1, top: 2 });
      assert.equal(web.data[ZOOM_CHIP_STORAGE_KEY], JSON.stringify({ left: 9, top: 11 }));
      assert.deepEqual(await api.readZoomChipPos(), { left: 1, top: 2 });
      delete area.bag[ZOOM_CHIP_STORAGE_KEY];
      assert.deepEqual(await api.readZoomChipPos(), { left: 9, top: 11 });
      assert.equal(warnings.seen.length, 0);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("mirror zoom chip position is read and written with a bound storage area", () => exclusive(async () => {
    const area = chromeLike();
    const web = memoryWeb();
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const api = loadViewerStorage(web);
      api.persistMirrorZoomChipPos({ left: 15, top: 25 });
      assert.deepEqual(area.bag[MIRROR_ZOOM_CHIP_POS_KEY], { left: 15, top: 25 });
      assert.equal(Object.prototype.hasOwnProperty.call(area.bag, ZOOM_CHIP_STORAGE_KEY), false);
      delete web.data[MIRROR_ZOOM_CHIP_POS_KEY];
      assert.deepEqual(await api.readMirrorZoomChipPos(), { left: 15, top: 25 });
      area.state.failGet = 1;
      web.data[MIRROR_ZOOM_CHIP_POS_KEY] = JSON.stringify({ left: 2, top: 3 });
      assert.deepEqual(await api.readMirrorZoomChipPos(), { left: 2, top: 3 });
      assertRedacted(warnings.seen[0]);
      area.state.failSet = 1;
      api.persistMirrorZoomChipPos({ left: 4, top: 5 });
      assert.deepEqual(area.bag[MIRROR_ZOOM_CHIP_POS_KEY], { left: 15, top: 25 });
      assert.equal(web.data[MIRROR_ZOOM_CHIP_POS_KEY], JSON.stringify({ left: 4, top: 5 }));
      assert.throws(() => api.persistMirrorZoomChipPos({ left: 6, top: 7 }, () => {
        throw new Error("unload");
      }), /unload/);
      assert.deepEqual(area.bag[MIRROR_ZOOM_CHIP_POS_KEY], { left: 15, top: 25 });
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("mirror zoom is read and written with a bound storage area", () => exclusive(async () => {
    const area = chromeLike();
    const web = memoryWeb();
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const api = loadViewerStorage(web);
      assert.equal(await api.readMirrorZoom(), null);
      api.persistMirrorZoom(1.24);
      assert.equal(area.bag[MIRROR_ZOOM_STORAGE_KEY], clampZoom(1.24));
      assert.equal(web.data[MIRROR_ZOOM_STORAGE_KEY], String(clampZoom(1.24)));
      assert.equal(Object.prototype.hasOwnProperty.call(area.bag, ZOOM_CHIP_STORAGE_KEY), false);
      delete web.data[MIRROR_ZOOM_STORAGE_KEY];
      assert.equal(await api.readMirrorZoom(), clampZoom(1.24));
      area.bag[MIRROR_ZOOM_STORAGE_KEY] = "nope";
      web.data[MIRROR_ZOOM_STORAGE_KEY] = "1.5";
      assert.equal(await api.readMirrorZoom(), clampZoom("nope"));
      area.state.undefinedGet = 1;
      assert.equal(await api.readMirrorZoom(), clampZoom("1.5"));
      area.state.failGet = 1;
      assert.equal(await api.readMirrorZoom(), clampZoom("1.5"));
      assertRedacted(warnings.seen[0]);
      const kept = area.bag[MIRROR_ZOOM_STORAGE_KEY];
      area.state.failSet = 1;
      api.persistMirrorZoom(2);
      assert.equal(area.bag[MIRROR_ZOOM_STORAGE_KEY], kept);
      assert.equal(web.data[MIRROR_ZOOM_STORAGE_KEY], String(clampZoom(2)));
      assert.throws(() => api.persistMirrorZoom(3, () => {
        throw new Error("unload");
      }), /unload/);
      assert.equal(area.bag[MIRROR_ZOOM_STORAGE_KEY], kept);
      assert.equal(web.data[MIRROR_ZOOM_STORAGE_KEY], String(clampZoom(3)));
      web.data[MIRROR_ZOOM_STORAGE_KEY] = "";
      delete area.bag[MIRROR_ZOOM_STORAGE_KEY];
      assert.equal(await api.readMirrorZoom(), null);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("notes persist flag is read with a bound storage area", () => exclusive(async () => {
    const area = chromeLike();
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const api = loadViewerStorage(memoryWeb());
      const detached = area.local.get;
      await assert.rejects(Promise.resolve().then(() => detached("notesPersistGranted")), /Illegal invocation/);
      assert.equal(await api.readStoredPersistDenied(), false);
      area.bag.notesPersistGranted = false;
      assert.equal(await api.readStoredPersistDenied(), true);
      area.bag.notesPersistGranted = true;
      assert.equal(await api.readStoredPersistDenied(), false);
      area.state.undefinedGet = 1;
      assert.equal(await api.readStoredPersistDenied(), false);
      area.state.malformedGet = 1;
      assert.equal(await api.readStoredPersistDenied(), false);
      area.state.failGet = 1;
      assert.equal(await api.readStoredPersistDenied(), false);
      assert.equal(area.state.setCalls, 0);
      assert.match(warnings.seen[0], /QuotaExceededError/);
      assertRedacted(warnings.seen[0]);
      assert.equal(area.bag.notesPersistGranted, true);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("notes persist without chrome returns false and does not warn", () => exclusive(async () => {
    const restore = useChrome(null);
    const warnings = captureWarn();
    try {
      const api = loadViewerStorage(memoryWeb());
      assert.equal(await api.readStoredPersistDenied(), false);
      assert.equal(warnings.seen.length, 0);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("two tabs writing zoom keys do not clobber each other's keys", () => exclusive(async () => {
    const area = chromeLike();
    const web = memoryWeb();
    const restore = useChrome(area);
    const warnings = captureWarn();
    try {
      const tabA = loadViewerStorage(web);
      const tabB = loadViewerStorage(web);
      tabA.persistZoomChipPos({ left: 10, top: 11 });
      tabB.persistMirrorZoomChipPos({ left: 12, top: 13 });
      tabA.persistMirrorZoom(1.5);
      tabB.persistZoomChipPos({ left: 14, top: 15 });
      assert.deepEqual(area.bag[ZOOM_CHIP_STORAGE_KEY], { left: 14, top: 15 });
      assert.deepEqual(area.bag[MIRROR_ZOOM_CHIP_POS_KEY], { left: 12, top: 13 });
      assert.equal(area.bag[MIRROR_ZOOM_STORAGE_KEY], clampZoom(1.5));
      assert.deepEqual(await tabB.readZoomChipPos(), { left: 14, top: 15 });
      assert.deepEqual(await tabA.readMirrorZoomChipPos(), { left: 12, top: 13 });
      assert.equal(await tabB.readMirrorZoom(), clampZoom(1.5));
      assert.equal(warnings.seen.length, 0);
    } finally {
      warnings.restore();
      restore();
    }
  }));

  test("zoom shared-state random interleave keeps invariants", { timeout: 60000 }, () => exclusive(async () => {
    const seeds = 500;
    const warnings = captureWarn();
    const previous = globalThis.chrome;
    try {
      for (let seed = 1; seed <= seeds; seed += 1) {
        const rng = mulberry32(seed);
        const area = chromeLike();
        const web = memoryWeb();
        globalThis.chrome = { storage: { local: area.local } };
        const tabA = loadViewerStorage(web);
        const tabB = loadViewerStorage(web);
        const oracle = { chrome: {}, local: {} };
        let readZoomFromLocal = false;
        const tabs = [tabA, tabB];
        const kinds = ["zoom", "chip", "mirror"];
        const fail = (step, message) => {
          throw new Error(`seed ${seed} step ${step}: ${message}`);
        };
        const check = async (step) => {
          const names = Object.keys(area.bag);
          for (const name of names) {
            if (!KEYS.includes(name) || name === "notesPersistGranted") fail(step, `unexpected chrome key ${name}`);
          }
          assertChrome(ZOOM_CHIP_STORAGE_KEY, oracle.chrome.zoom, step);
          assertChrome(MIRROR_ZOOM_CHIP_POS_KEY, oracle.chrome.chip, step);
          assertChrome(MIRROR_ZOOM_STORAGE_KEY, oracle.chrome.mirror, step);
          assertLocal(ZOOM_CHIP_STORAGE_KEY, oracle.local.zoom, true, step);
          assertLocal(MIRROR_ZOOM_CHIP_POS_KEY, oracle.local.chip, true, step);
          assertLocal(MIRROR_ZOOM_STORAGE_KEY, oracle.local.mirror, false, step);
          const before = JSON.stringify({ bag: area.bag, data: web.data });
          const zoom = await tabA.readZoomChipPos();
          const chip = await tabB.readMirrorZoomChipPos();
          const mirror = await tabA.readMirrorZoom();
          if (JSON.stringify({ bag: area.bag, data: web.data }) !== before) fail(step, "read wrote shared state");
          const zoomChrome = readZoomFromLocal ? undefined : oracle.chrome.zoom;
          if (JSON.stringify(zoom) !== JSON.stringify(expectChip(zoomChrome, oracle.local.zoom))) {
            fail(step, "zoom read diverged");
          }
          if (JSON.stringify(chip) !== JSON.stringify(expectChip(oracle.chrome.chip, oracle.local.chip))) {
            fail(step, "mirror chip read diverged");
          }
          if (mirror !== expectMirror(oracle.chrome.mirror, oracle.local.mirror)) fail(step, "mirror zoom read diverged");
          for (const message of warnings.seen) assertRedacted(message);
        };
        function assertChrome(key, expected, step) {
          const has = Object.prototype.hasOwnProperty.call(area.bag, key);
          if (expected === undefined) {
            if (has) fail(step, `chrome ${key} present`);
            return;
          }
          if (JSON.stringify(area.bag[key]) !== JSON.stringify(expected)) fail(step, `chrome ${key} diverged`);
        }
        function assertLocal(key, expected, json, step) {
          const has = Object.prototype.hasOwnProperty.call(web.data, key);
          if (expected === undefined) {
            if (has) fail(step, `local ${key} present`);
            return;
          }
          const want = json ? JSON.stringify(expected) : String(expected);
          if (web.data[key] !== want) fail(step, `local ${key} diverged`);
        }
        const steps = 24;
        for (let step = 0; step < steps; step += 1) {
          warnings.seen.length = 0;
          const tab = tabs[Math.floor(rng() * tabs.length)];
          const kind = kinds[Math.floor(rng() * kinds.length)];
          const mode = Math.floor(rng() * 7);
          const point = { left: Math.floor(rng() * 400), top: Math.floor(rng() * 300) };
          const scale = rng() * 6;
          readZoomFromLocal = false;
          try {
            if (kind === "zoom" && mode === 0) {
              const payload = normalizeZoomChipPos(point);
              tab.persistZoomChipPos(point);
              if (payload) {
                oracle.local.zoom = payload;
                oracle.chrome.zoom = payload;
              }
            } else if (kind === "zoom" && mode === 1) {
              area.state.failSet = 1;
              const payload = normalizeZoomChipPos(point);
              tab.persistZoomChipPos(point);
              if (payload) oracle.local.zoom = payload;
            } else if (kind === "zoom" && mode === 2) {
              const payload = normalizeZoomChipPos(point);
              try {
                tab.persistZoomChipPos(point, () => {
                  throw new Error("unload");
                });
                fail(step, "unload did not interrupt");
              } catch (err) {
                if (!/unload/.test(err.message)) fail(step, err.message);
              }
              if (payload) oracle.local.zoom = payload;
            } else if (kind === "zoom" && mode === 3) {
              web.fail = true;
              const payload = normalizeZoomChipPos(point);
              tab.persistZoomChipPos(point);
              if (payload) oracle.chrome.zoom = payload;
            } else if (kind === "chip" && mode === 0) {
              const payload = normalizeZoomChipPos(point);
              tab.persistMirrorZoomChipPos(point);
              if (payload) {
                oracle.local.chip = payload;
                oracle.chrome.chip = payload;
              }
            } else if (kind === "chip" && mode === 1) {
              area.state.failSet = 1;
              const payload = normalizeZoomChipPos(point);
              tab.persistMirrorZoomChipPos(point);
              if (payload) oracle.local.chip = payload;
            } else if (kind === "chip" && mode === 2) {
              const payload = normalizeZoomChipPos(point);
              try {
                tab.persistMirrorZoomChipPos(point, () => {
                  throw new Error("unload");
                });
                fail(step, "unload did not interrupt");
              } catch (err) {
                if (!/unload/.test(err.message)) fail(step, err.message);
              }
              if (payload) oracle.local.chip = payload;
            } else if (kind === "chip" && mode === 3) {
              web.fail = true;
              const payload = normalizeZoomChipPos(point);
              tab.persistMirrorZoomChipPos(point);
              if (payload) oracle.chrome.chip = payload;
            } else if (kind === "mirror" && mode === 0) {
              tab.persistMirrorZoom(scale);
              const next = clampZoom(scale);
              oracle.local.mirror = next;
              oracle.chrome.mirror = next;
            } else if (kind === "mirror" && mode === 1) {
              area.state.failSet = 1;
              tab.persistMirrorZoom(scale);
              oracle.local.mirror = clampZoom(scale);
            } else if (kind === "mirror" && mode === 2) {
              try {
                tab.persistMirrorZoom(scale, () => {
                  throw new Error("unload");
                });
                fail(step, "unload did not interrupt");
              } catch (err) {
                if (!/unload/.test(err.message)) fail(step, err.message);
              }
              oracle.local.mirror = clampZoom(scale);
            } else if (kind === "mirror" && mode === 3) {
              web.fail = true;
              tab.persistMirrorZoom(scale);
              oracle.chrome.mirror = clampZoom(scale);
            } else if (mode === 4) {
              area.state.failGet = 1;
              readZoomFromLocal = true;
            } else if (mode === 5) {
              area.state.undefinedGet = 1;
              readZoomFromLocal = true;
            } else if (mode === 6) {
              area.state.malformedGet = 1;
              readZoomFromLocal = true;
            }
            if (kind === "zoom" && mode > 3) tab.persistZoomChipPos({ left: "bad", top: 1 });
          } catch (err) {
            if (!String(err.message).startsWith(`seed ${seed}`)) fail(step, err.message);
            throw err;
          }
          await check(step);
        }
      }
    } finally {
      warnings.restore();
      globalThis.chrome = previous;
    }
  }));

  test("layout cache shared-state random interleave keeps invariants", { timeout: 60000 }, () => exclusive(async () => {
    const key = layoutCacheKey({ hash: "attention-interleave", page: 2, mode: "text-layer" });
    const protocol = key.split(":").at(-2);
    const legacy = legacyLayout("legacy", SECRET, "rev-legacy");
    const planted = JSON.stringify(legacy);
    const tabA = await import(pathToFileURL(join(root, "lib/pdf-layout-cache.js")).href + "?realm=layout-a");
    const tabB = await import(pathToFileURL(join(root, "lib/pdf-layout-cache.js")).href + "?realm=layout-b");
    const warnings = captureWarn();
    const previous = globalThis.chrome;
    try {
      for (let seed = 1; seed <= 500; seed += 1) {
        const rng = mulberry32(seed + 17);
        const area = chromeLike({ [key]: legacy });
        const store = layoutStore();
        globalThis.chrome = { storage: { local: area.local } };
        let row = null;
        const fail = (step, message) => {
          throw new Error(`seed ${seed} step ${step}: ${message}`);
        };
        const check = (step) => {
          if (JSON.stringify(area.bag[key]) !== planted) fail(step, "chrome layout key changed");
          if (Object.keys(area.bag).some((name) => name !== key)) fail(step, "extra chrome key");
          if (area.state.setCalls !== 0) fail(step, "chrome set was called");
          const stored = store.rows.get(`attention-interleave\0${2}\0text-layer\0${protocol}`) || null;
          if (JSON.stringify(stored) !== JSON.stringify(row)) fail(step, "library row diverged");
          if (stored) {
            const bid = stored.layout?.blocks?.[0]?.bid;
            const text = stored.layout?.blocks?.[0]?.text;
            const pair = `${bid}:${text}`;
            if (pair !== `legacy:${SECRET}` && !/^tab-[ab]:text-/.test(pair)) fail(step, "torn layout");
          }
          for (const message of warnings.seen) assertRedacted(message);
        };
        for (let step = 0; step < 16; step += 1) {
          warnings.seen.length = 0;
          const tab = rng() < 0.5 ? tabA : tabB;
          const mode = Math.floor(rng() * 6);
          const tag = rng() < 0.5 ? "a" : "b";
          if (mode === 0) {
            const value = await tab.readLayoutCache(key, { store });
            if (!row) {
              row = {
                docHash: "attention-interleave",
                page: 2,
                mode: "text-layer",
                protocol,
                layoutRev: "rev-legacy",
                layout: cacheableLayout(legacy)
              };
              if (value?.blocks?.[0]?.bid !== "legacy") fail(step, "legacy read missed");
            } else if (value?.blocks?.[0]?.bid !== row.layout.blocks[0].bid) {
              fail(step, "stored read diverged");
            }
          } else if (mode === 1) {
            const page = legacyLayout(`tab-${tag}`, `text-${tag}`, `rev-${tag}-${step}`);
            await tab.writeLayoutCache(key, page, { store });
            row = {
              docHash: "attention-interleave",
              page: 2,
              mode: "text-layer",
              protocol,
              layoutRev: String(page.layoutVersion),
              layout: cacheableLayout(page)
            };
          } else if (mode === 2 && !row) {
            area.state.failGet = 1;
            const value = await tab.readLayoutCache(key, { store });
            if (value !== null) fail(step, "throwing read returned a layout");
            if (warnings.seen.length !== 1) fail(step, "missing redacted warning");
          } else if (mode === 3 && !row) {
            area.state.undefinedGet = 1;
            const value = await tab.readLayoutCache(key, { store });
            if (value !== null) fail(step, "undefined read returned a layout");
            if (warnings.seen.length !== 0) fail(step, "undefined read warned");
          } else if (mode === 4 && !row) {
            area.state.malformedGet = 1;
            const value = await tab.readLayoutCache(key, { store });
            if (value !== null) fail(step, "malformed read returned a layout");
          } else if (mode === 5 && !row) {
            store.fail = true;
            const value = await tab.readLayoutCache(key, { store });
            if (value?.blocks?.[0]?.bid !== "legacy") fail(step, "interrupted copy hid the legacy value");
            if (store.rows.size !== 0) fail(step, "failed copy left a partial row");
          } else {
            const value = await tab.readLayoutCache(key, { store });
            if (!row) {
              row = {
                docHash: "attention-interleave",
                page: 2,
                mode: "text-layer",
                protocol,
                layoutRev: "rev-legacy",
                layout: cacheableLayout(legacy)
              };
              if (value?.blocks?.[0]?.bid !== "legacy") fail(step, "fallback read missed");
            }
          }
          check(step);
        }
      }
    } finally {
      warnings.restore();
      globalThis.chrome = previous;
    }
  }));
});

function expectChip(chromeVal, localVal) {
  const fromChrome = normalizeZoomChipPos(chromeVal);
  if (fromChrome) return fromChrome;
  if (localVal) return normalizeZoomChipPos(localVal);
  return null;
}

function expectMirror(chromeVal, localVal) {
  if (chromeVal != null && chromeVal !== "") return clampZoom(chromeVal);
  if (localVal == null || localVal === "") return null;
  return clampZoom(localVal);
}
