import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { handleArxivSourceMessage } from "../background/arxiv-source.js";
import { wrapLibraryError } from "../lib/library-store.js";
import { classifyVisionError, isTransportFailure } from "../lib/mm-client.js";
import { settleProbeResult } from "../lib/mm-probe.js";
import { fetchLocalEnvelope } from "../lib/pdf-layout-client.js";
import { resolveArxivSession } from "../lib/formula-arxiv-gate.js";
import {
  DIAG_BYTE_CAP,
  DIAG_CTX_CAP,
  DIAG_RETENTION_MS,
  DIAG_STORAGE_KEY,
  createDiagWriter,
  diagByteLength,
  diagLog,
  handleDiagMessage,
  installDiagWriter,
  noteTranslateFailure,
  noteViewerNetwork,
  resetDiagForTests,
  retainDiagEvents
} from "../lib/diag-log.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function memoryArea(seed = {}) {
  const bag = { ...seed };
  return {
    bag,
    async get(key) {
      if (typeof key === "string") return { [key]: bag[key] };
      return { ...bag };
    },
    async set(patch) {
      Object.assign(bag, patch);
    }
  };
}

function stored(area) {
  const events = area.bag[DIAG_STORAGE_KEY];
  return Array.isArray(events) ? events : [];
}

describe("diagnostic log", { concurrency: 1 }, () => {
test.beforeEach(() => {
  resetDiagForTests();
});

test.afterEach(() => {
  resetDiagForTests();
});

test("retention keeps an event exactly 7 days old and drops an older one", () => {
  const now = 1_700_000_000_000;
  const edge = now - DIAG_RETENTION_MS;
  const kept = retainDiagEvents([
    { t: edge, type: "mm.error", code: "edge" },
    { t: edge - 1, type: "mm.error", code: "old" }
  ], now);
  assert.deepEqual(kept.map((event) => event.code), ["edge"]);
});

test("retention drops the oldest event before the newest and stays within 2 MB", () => {
  const now = 1_700_000_000_000;
  const newest = { t: now, type: "mm.error", code: "new" };
  const middle = { t: now - 10, type: "mm.error", code: "mid" };
  const newestBytes = diagByteLength(newest);
  const middleBytes = diagByteLength(middle);
  const filler = { t: now - 20, type: "mm.error", code: "old", msg: "" };
  const extra = DIAG_BYTE_CAP - (2 + newestBytes + middleBytes + 2);
  filler.msg = "a".repeat(Math.max(0, extra - diagByteLength(filler) + 8));
  const events = [newest, filler, middle];
  const before = diagByteLength(JSON.stringify([filler, middle, newest].sort((a, b) => a.t - b.t)));
  assert.ok(before > DIAG_BYTE_CAP);
  const kept = retainDiagEvents(events, now, { cap: DIAG_BYTE_CAP });
  const times = kept.map((event) => event.t);
  assert.equal(times.includes(filler.t), false);
  assert.equal(times.includes(newest.t), true);
  assert.ok(diagByteLength(JSON.stringify(kept)) <= DIAG_BYTE_CAP);
});

test("overlapping flushes keep both events", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const area = memoryArea();
  const storage = {
    bag: area.bag,
    async get(key) {
      if (key === DIAG_STORAGE_KEY) {
        reads += 1;
        if (reads === 1) await gate;
      }
      return area.get(key);
    },
    set: (patch) => area.set(patch)
  };
  const writer = createDiagWriter({ storage, debounceMs: -1 });
  const now = Date.now();
  writer.log({ type: "mm.error", code: "a", t: now });
  const first = writer.flush();
  writer.log({ type: "ocr.error", code: "b", t: now + 1 });
  const second = writer.flush();
  release();
  await first;
  await second;
  const codes = stored(area).map((event) => event.code).sort();
  assert.deepEqual(codes, ["a", "b"]);
});

test("logging, export, and clear do not call the network", async () => {
  const hits = [];
  const previousFetch = globalThis.fetch;
  const previousXhr = globalThis.XMLHttpRequest;
  const previousNav = globalThis.navigator;
  globalThis.fetch = () => {
    hits.push("fetch");
    throw new Error("fetch");
  };
  globalThis.XMLHttpRequest = class {
    open() { hits.push("xhr"); }
    send() { hits.push("xhr"); }
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      sendBeacon() {
        hits.push("beacon");
        return true;
      },
      userAgent: "Mozilla/5.0 Chrome/120.0.0.0",
      language: "zh-CN"
    }
  });
  try {
    const storage = memoryArea();
    const writer = createDiagWriter({ storage, debounceMs: -1 });
    installDiagWriter(writer);
    diagLog("net.offline", { code: "offline" });
    await writer.flush();
    await writer.exportPackage({ extVersion: "1.0.0", browser: { brand: "Chrome", version: "120", platform: "Linux" }, locale: "zh-CN" });
    await writer.clear();
    assert.deepEqual(hits, []);
    assert.equal(stored(storage).length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.XMLHttpRequest = previousXhr;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNav });
  }
});

test("diagLog never throws and does not message itself from a service worker queue", async () => {
  assert.doesNotThrow(() => diagLog("mm.error", { code: "x", text: "paper9z" }));
  const runtime = {
    calls: 0,
    sendMessage() {
      runtime.calls += 1;
      return Promise.reject(new Error("loop"));
    }
  };
  globalThis.chrome = { runtime };
  assert.doesNotThrow(() => diagLog("mm.error", { code: "y" }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.calls, 1);
  delete globalThis.chrome;
});

test("translate, library, vision, layout, probe, and offline hooks record codes without paper text", async () => {
  const storage = memoryArea();
  const writer = createDiagWriter({ storage, debounceMs: -1 });
  installDiagWriter(writer);

  noteTranslateFailure(Object.assign(new Error("upstream failed"), { httpStatus: 429 }), { provider: "openai", count: 3 });
  const blocked = new Error("blocked");
  blocked.name = "BlockedError";
  wrapLibraryError(blocked);
  classifyVisionError({ status: 401, data: { error: { message: "paper9z" } } });
  isTransportFailure(Object.assign(new Error("down"), { code: "network" }));
  await assert.rejects(() => fetchLocalEnvelope({
    maxAttempts: 1,
    sleep: async () => {},
    fetchImpl: async () => {
      throw Object.assign(new Error("down"), { code: "network" });
    }
  }));
  settleProbeResult({}, { ok: false, code: "401", summary: "paper9z" }, { still: false });
  await resolveArxivSession({ id: "1706.03762" });
  noteViewerNetwork(false);

  await writer.flush();
  const events = stored(storage);
  const types = events.map((event) => event.type);
  assert.ok(types.includes("translate.error"));
  assert.ok(types.includes("library.error"));
  assert.ok(types.includes("mm.error"));
  assert.ok(types.includes("ocr.error"));
  assert.ok(types.includes("mm.probe"));
  assert.ok(types.includes("net.offline"));
  const packed = JSON.stringify(events);
  assert.equal(packed.includes("paper9z"), false);
  assert.equal(packed.includes("summary"), false);
  const translated = events.find((event) => event.type === "translate.error");
  assert.equal(translated.code, "429");
  assert.equal(translated.provider, "openai");
  assert.equal(translated.count, 3);
  assert.equal("text" in translated, false);
});

test("translate failures reach the log through the arxiv message bridge", async () => {
  const local = memoryArea();
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local, sync: memoryArea() } };
  try {
    await handleArxivSourceMessage({
      action: "diag-note",
      failure: { httpStatus: 503, message: "upstream" },
      fields: { provider: "openai", count: 4 }
    });
    const stats = await handleArxivSourceMessage({ action: "diag", message: { type: "OI_DIAG_STATS" } });
    assert.equal(stats.count, 1);
    const translated = stored(local).find((event) => event.type === "translate.error");
    assert.equal(translated.code, "503");
    assert.equal(translated.provider, "openai");
    assert.equal(translated.count, 4);
    assert.equal(translated.msg, undefined);
    assert.equal(JSON.stringify(stored(local)).includes("upstream"), false);
  } finally {
    globalThis.chrome = previous;
  }
});

test("a caller timestamp in the future is not stored", async () => {
  const now = Date.now();
  const kept = retainDiagEvents([
    { t: now + 365 * 864e5, type: "mm.error", code: "future" },
    { t: now, type: "mm.error", code: "now" }
  ], now);
  assert.deepEqual(kept.map((event) => event.code), ["now"]);
  const storage = memoryArea();
  const writer = createDiagWriter({ storage, debounceMs: -1, now: () => now });
  writer.log({ type: "mm.error", code: "stamped", t: now + 400 * 864e5 });
  await writer.flush();
  const saved = stored(storage)[0];
  assert.equal(saved.code, "stamped");
  assert.ok(saved.t <= now + 1000);
});

test("content spam cannot evict a service-worker error", async () => {
  const storage = memoryArea();
  const writer = createDiagWriter({ storage, debounceMs: -1 });
  writer.log({ type: "translate.error", ctx: "sw", code: "REAL" });
  await writer.flush();
  const msg = "lorem ipsum dolor sit ".repeat(20);
  for (let i = 0; i < 6000; i += 1) writer.log({ type: "content.spam", ctx: "content", msg });
  await writer.flush();
  const events = stored(storage);
  assert.ok(events.some((event) => event.code === "REAL"));
  assert.ok(events.filter((event) => event.ctx === "content").length <= DIAG_CTX_CAP);
});

test("content-script senders cannot export or forge a service-worker event", async () => {
  const storage = memoryArea();
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: { id: "extid" }, storage: { local: storage, sync: memoryArea() } };
  const writer = createDiagWriter({ storage, debounceMs: -1 });
  const content = { id: "extid", tab: { id: 1 }, url: "https://example.com/paper" };
  const viewer = { id: "extid", tab: { id: 2 }, url: "chrome-extension://extid/pdf/viewer.html" };
  const options = { id: "extid", tab: { id: 3 }, url: "chrome-extension://extid/options/options.html" };
  try {
    const denied = await handleDiagMessage(
      { type: "OI_DIAG_LOG", event: { type: "translate.error", ctx: "sw", msg: "spoofed paper", t: Date.now() + 864e5 } },
      { writer, sender: content }
    );
    assert.equal(denied.ok, false);
    const logged = await handleDiagMessage(
      { type: "OI_DIAG_LOG", event: { type: "mm.error", ctx: "sw", code: "401" } },
      { writer, sender: viewer }
    );
    assert.equal(logged.ok, true);
    await writer.flush();
    assert.equal(stored(storage)[0].ctx, "viewer");
    assert.equal(stored(storage)[0].code, "401");
    const cleared = await handleDiagMessage({ type: "OI_DIAG_CLEAR" }, { writer, sender: viewer });
    assert.equal(cleared.ok, false);
    const exported = await handleDiagMessage({ type: "OI_DIAG_EXPORT" }, { writer, sender: content });
    assert.equal(exported.ok, false);
    const allowed = await handleDiagMessage({ type: "OI_DIAG_STATS" }, { writer, sender: options });
    assert.equal(allowed.ok, true);
    const spoofed = await handleArxivSourceMessage({
      action: "diag-note",
      sender: content,
      failure: { message: "spoofed by page", code: "999" },
      fields: { provider: "openai", count: 5 }
    });
    assert.equal(spoofed.ok, false);
    assert.equal(JSON.stringify(stored(storage)).includes("spoofed"), false);
  } finally {
    globalThis.chrome = previous;
  }
});

test("a failed write during export still returns events that can be read", async () => {
  const now = Date.now();
  const storage = memoryArea({
    [DIAG_STORAGE_KEY]: [{ t: now, type: "mm.error", ctx: "sw", code: "kept" }]
  });
  storage.set = async () => {
    throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
  };
  const writer = createDiagWriter({ storage, sync: memoryArea(), debounceMs: -1 });
  writer.log({ type: "mm.error", code: "new" });
  const result = await writer.exportPackage({
    extVersion: "1.0.0",
    browser: { brand: "Chrome", version: "1", platform: "Linux" },
    locale: "zh-CN"
  });
  assert.notEqual(result.code, "storage-unreadable");
  assert.ok(result.package.events.some((event) => event.code === "kept"));
});

test("service worker reaches the diagnostic log without a dynamic import", () => {
  const src = readFileSync(join(root, "background/service-worker.js"), "utf8");
  assert.match(src, /reportTranslateFailure\(err/);
  assert.match(src, /import \{ handleArxivSourceMessage \} from "\.\/arxiv-source\.js";/);
  assert.match(src, /action: "diag"/);
  assert.match(src, /action: "diag-note"/);
  assert.equal(/\bimport\s*\(/.test(src), false);
  assert.equal(/^import\s+.*diag-log/m.test(src), false);
  assert.equal(/^await /m.test(src), false);
  const bridge = readFileSync(join(root, "background/arxiv-source.js"), "utf8");
  assert.match(bridge, /handleDiagMessage/);
  assert.match(bridge, /noteTranslateFailure/);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const prepare = viewer.slice(viewer.indexOf("const prepareLibraryPage"), viewer.indexOf("preparePage: prepareLibraryPage"));
  const adopt = viewer.slice(viewer.indexOf("async function adoptLibraryPages"), viewer.indexOf("const prepareLibraryPage"));
  assert.equal(prepare.includes("diagLog"), false);
  assert.equal(adopt.includes("diagLog"), false);
  assert.equal(viewer.includes("watchDiagNetwork"), true);
});
});
