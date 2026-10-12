import "./helpers/block-live-fetch.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARXIV_DB,
  COOLDOWN_MS,
  MIN_GAP_MS,
  TIMEOUT_MS,
  createArxivSourceClient,
  createMemoryStore,
  handleArxivSourceMessage
} from "../background/arxiv-source.js";
import { tarGz } from "./helpers/arxiv-pack.mjs";
import { SRC_V7, SRC_V7_SHA, requireFile } from "./helpers/arxiv-paper.mjs";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");

function client(fetch, clock) {
  return createArxivSourceClient({
    fetch,
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store: createMemoryStore(),
    gunzip: (bytes) => gunzipSync(bytes)
  });
}

function makeClock() {
  const clock = {
    t: 0,
    sleeps: [],
    fireTimeout: null,
    sleep(ms) {
      clock.sleeps.push(ms);
      if (ms >= TIMEOUT_MS) {
        return new Promise((resolve) => {
          clock.fireTimeout = () => {
            clock.t += ms;
            resolve();
          };
        });
      }
      clock.t += ms;
      return Promise.resolve();
    }
  };
  return clock;
}

const gunzip = (bytes) => gunzipSync(bytes);

function okFetch(body, calls) {
  return async (url) => {
    calls.push(url);
    return {
      status: 200,
      arrayBuffer: async () => body
    };
  };
}

test("AX-07 gap, single flight, and same-id dedupe", async () => {
  const calls = [];
  const clock = makeClock();
  const body = tarGz([{ name: "a.tex", body: "hello" }]);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let pending = 0;
  const api = createArxivSourceClient({
    fetch: async (url) => {
      calls.push({ url, t: clock.t });
      pending += 1;
      await gate;
      pending -= 1;
      return { status: 200, arrayBuffer: async () => body };
    },
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store: createMemoryStore(),
    gunzip
  });
  const first = api.get({ id: "1706.03762", version: "v7", userTriggered: true });
  const again = api.get({ id: "1706.03762", version: "v7", userTriggered: true });
  const other = api.get({ id: "1706.03762", version: "v1", userTriggered: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.equal(pending, 1);
  assert.equal(api.status().inFlight, 1);
  release();
  const [a, b, c] = await Promise.all([first, again, other]);
  assert.equal(a, b);
  assert.equal(a.ok, true);
  assert.equal(c.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].t - calls[0].t >= MIN_GAP_MS);
});

test("AX-08 timeout fails the id for the rest of the session", async () => {
  const calls = [];
  const clock = makeClock();
  const api = client(async (url) => {
    calls.push(url);
    return new Promise(() => {});
  }, clock);
  const pending = api.get({ id: "1", version: "v1", userTriggered: true });
  await new Promise((resolve) => setImmediate(resolve));
  clock.fireTimeout();
  const failed = await pending;
  assert.equal(failed.reason, "timeout");
  assert.ok(clock.sleeps.includes(TIMEOUT_MS));
  const retry = await api.get({ id: "1", version: "v1", userTriggered: true });
  assert.equal(retry.reason, "session-failed");
  assert.equal(calls.length, 1);
});

test("AX-09 cooldown blocks every id for 24h", async () => {
  const calls = [];
  const clock = makeClock();
  const api = client(async (url) => {
    calls.push(url);
    return { status: calls.length === 1 ? 429 : 200, arrayBuffer: async () => tarGz([{ name: "a.tex", body: "x" }]) };
  }, clock);
  const blocked = await api.get({ id: "aaa", version: "v1", userTriggered: true });
  assert.equal(blocked.reason, "cooldown");
  const other = await api.get({ id: "bbb", version: "v1", userTriggered: true });
  assert.equal(other.reason, "cooldown");
  assert.equal(calls.length, 1);
  clock.t += COOLDOWN_MS;
  const again = await api.get({ id: "bbb", version: "v1", userTriggered: true });
  assert.equal(again.ok, true);
  assert.equal(calls.length, 2);
});

test("AX-10 cache hit, clear, and cached figures", async () => {
  const calls = [];
  const clock = makeClock();
  clock.t = 10000;
  const store = createMemoryStore();
  const api = createArxivSourceClient({
    fetch: okFetch(tarGz([
      { name: "note.tex", body: "alpha" },
      { name: "pic.png", body: PNG }
    ]), calls),
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store,
    gunzip
  });
  const first = await api.get({ id: "1706.03762", version: "v7", userTriggered: true });
  assert.equal(first.ok, true);
  assert.deepEqual(first.files, [{ path: "note.tex", text: "alpha" }]);
  assert.deepEqual(first.assets, [{ path: "pic.png", mime: "image/png", size: PNG.length }]);
  const picture = await api.readAsset({ id: "1706.03762", version: "v7", path: "pic.png" });
  assert.equal(picture.ok, true);
  assert.equal(picture.bytes instanceof Blob, true);
  assert.deepEqual([...new Uint8Array(await picture.bytes.arrayBuffer())], [...PNG]);
  const second = await api.get({ id: "1706.03762", version: "v7", userTriggered: true });
  assert.equal(second.cached, true);
  assert.deepEqual(second.assets, first.assets);
  assert.equal(calls.length, 1);
  await api.clear();
  const gone = await api.readAsset({ id: "1706.03762", version: "v7", path: "pic.png" });
  assert.equal(gone.ok, false);
  const third = await api.get({ id: "1706.03762", version: "v7", userTriggered: true });
  assert.equal(third.cached, false);
  assert.equal(calls.length, 2);
  assert.equal(api.status().database, ARXIV_DB);
});

test("AX-11 a message without userTriggered does not fetch", async () => {
  const calls = [];
  const api = client(okFetch(tarGz([{ name: "a.tex", body: "x" }]), calls), makeClock());
  const quiet = await handleArxivSourceMessage({ type: "OI_ARXIV_SOURCE", id: "1706.03762" }, api);
  assert.equal(quiet.reason, "not-triggered");
  assert.equal(calls.length, 0);
  assert.match(sw, /case "OI_ARXIV_SOURCE":/);
  assert.match(sw, /import \{ handleArxivSourceMessage \} from "\.\/arxiv-source\.js";/);
  assert.match(sw, /return handleArxivSourceMessage\(message\);/);
  assert.equal(/\bimport\s*\(/.test(sw), false);
});

test("cooldown still blocks after the client is rebuilt on the same store", async () => {
  const calls = [];
  const clock = makeClock();
  const store = createMemoryStore();
  const first = createArxivSourceClient({
    fetch: async () => {
      calls.push(clock.t);
      return { status: 429, arrayBuffer: async () => new ArrayBuffer(0) };
    },
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store,
    gunzip
  });
  const blocked = await first.get({ id: "1706.03762", userTriggered: true });
  assert.equal(blocked.reason, "cooldown");
  const saved = await store.get("meta:politeness");
  assert.equal(saved.cooldownUntil, clock.t + COOLDOWN_MS);
  assert.equal(saved.lastStart, clock.t);
  const second = createArxivSourceClient({
    fetch: async () => {
      calls.push("rebuilt");
      return { status: 200, arrayBuffer: async () => tarGz([{ name: "a.tex", body: "x" }]) };
    },
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store,
    gunzip
  });
  const reported = await handleArxivSourceMessage({ action: "status" }, second);
  assert.equal(reported.coolingDown, true);
  assert.equal(reported.cooldownUntil, saved.cooldownUntil);
  const again = await second.get({ id: "9999.00001", userTriggered: true });
  assert.equal(again.reason, "cooldown");
  assert.deepEqual(calls, [0]);
  assert.equal(second.status().coolingDown, true);
  assert.equal(second.status().cooldownUntil, saved.cooldownUntil);
});

test("a rebuilt client reads a cached figure, and asset returns one path", async () => {
  const calls = [];
  const clock = makeClock();
  const store = createMemoryStore();
  const first = createArxivSourceClient({
    fetch: okFetch(tarGz([
      { name: "note.tex", body: "alpha" },
      { name: "pic.png", body: PNG },
      { name: "fig.pdf", body: "%PDF" },
      { name: "mystery.bin", body: "zzz" }
    ]), calls),
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store,
    gunzip
  });
  const saved = await first.get({ id: "1706.03762", version: "v7", userTriggered: true });
  assert.deepEqual(saved.assets, [
    { path: "pic.png", mime: "image/png", size: PNG.length },
    { path: "fig.pdf", mime: "application/pdf", size: 4 }
  ]);
  assert.equal(saved.assets.every((asset) => !("bytes" in asset)), true);
  assert.deepEqual(saved.skipped, [{ path: "mystery.bin", reason: "unsupported" }]);
  const second = createArxivSourceClient({
    fetch: async () => {
      calls.push("rebuilt");
      return { status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
    },
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store,
    gunzip
  });
  const again = await second.get({ id: "1706.03762", version: "v7", userTriggered: true });
  assert.equal(again.cached, true);
  assert.deepEqual(again.files, [{ path: "note.tex", text: "alpha" }]);
  assert.deepEqual(again.assets, saved.assets);
  const one = await handleArxivSourceMessage({
    action: "asset",
    id: "1706.03762",
    version: "v7",
    path: "pic.png"
  }, second);
  assert.equal(one.ok, true);
  assert.equal(one.mime, "image/png");
  assert.equal(one.encoding, "base64");
  const round = JSON.parse(JSON.stringify(one));
  assert.deepEqual([...Buffer.from(round.data, "base64")], [...PNG]);
  const internal = await second.readAsset({ id: "1706.03762", version: "v7", path: "pic.png" });
  assert.equal(internal.bytes instanceof Blob, true);
  const missing = await handleArxivSourceMessage({
    action: "asset",
    id: "1706.03762",
    version: "v7",
    path: "other.png"
  }, second);
  assert.equal(missing.reason, "missing");
  assert.deepEqual(calls, ["https://arxiv.org/src/1706.03762v7"]);
});

test("get message lists skipped figures and unsupported files", async () => {
  const calls = [];
  const clock = makeClock();
  const api = createArxivSourceClient({
    fetch: okFetch(tarGz([
      { name: "keep.png", body: PNG },
      { name: "big.png", body: Buffer.concat([Buffer.from(PNG), Buffer.from("x")]) },
      { name: "mystery.bin", body: "z" }
    ]), calls),
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store: createMemoryStore(),
    gunzip,
    maxAssetBytes: PNG.length
  });
  const listed = await handleArxivSourceMessage({
    id: "1",
    version: "v1",
    userTriggered: true
  }, api);
  const round = JSON.parse(JSON.stringify(listed));
  assert.deepEqual(round.skipped, [
    { path: "big.png", reason: "asset-budget" },
    { path: "mystery.bin", reason: "unsupported" }
  ]);
  assert.deepEqual(round.assets, [{ path: "keep.png", mime: "image/png", size: PNG.length }]);
});

test("asset message JSON restores Figures/ModalNet-21.png", async () => {
  const packed = requireFile(SRC_V7, SRC_V7_SHA, "从 https://arxiv.org/src/1706.03762v7 下载到 tests/fixtures/arxiv-src/。");
  const calls = [];
  const clock = makeClock();
  const api = createArxivSourceClient({
    fetch: async (url) => {
      calls.push(url);
      return { status: 200, arrayBuffer: async () => packed };
    },
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store: createMemoryStore(),
    gunzip
  });
  const listed = await api.get({ id: "1706.03762", version: "v7", userTriggered: true });
  assert.equal(listed.assets.some((asset) => asset.path === "Figures/ModalNet-21.png"), true);
  assert.equal(listed.assets.every((asset) => !("bytes" in asset)), true);
  const message = await handleArxivSourceMessage({
    action: "asset",
    id: "1706.03762",
    version: "v7",
    path: "Figures/ModalNet-21.png"
  }, api);
  const round = JSON.parse(JSON.stringify(message));
  const raw = Buffer.from(round.data, "base64");
  assert.equal(round.path, "Figures/ModalNet-21.png");
  assert.equal(round.encoding, "base64");
  assert.equal(raw.length, 159152);
  assert.deepEqual([...raw.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const stored = await api.readAsset({ id: "1706.03762", version: "v7", path: "Figures/ModalNet-21.png" });
  assert.equal(stored.bytes instanceof Blob, true);
  assert.equal(calls.length, 1);
});

test("AX-12 a PDF response is cached and not fetched again", async () => {
  const calls = [];
  const clock = makeClock();
  const api = client(async (url) => {
    calls.push(url);
    return { status: 200, arrayBuffer: async () => Buffer.from("%PDF-1.7\n") };
  }, clock);
  const first = await api.get({ id: "9999.99999", version: "v1", userTriggered: true });
  assert.equal(first.reason, "pdf-only");
  const second = await api.get({ id: "9999.99999", version: "v1", userTriggered: true });
  assert.equal(second.reason, "pdf-only");
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1);
});
