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

test("AX-10 cache hit, clear, and text-only storage", async () => {
  const calls = [];
  const clock = makeClock();
  clock.t = 10000;
  const store = createMemoryStore();
  const api = createArxivSourceClient({
    fetch: okFetch(tarGz([
      { name: "note.tex", body: "alpha" },
      { name: "pic.png", body: "png" }
    ]), calls),
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store,
    gunzip
  });
  const first = await api.get({ id: "1706.03762", version: "v7", userTriggered: true });
  assert.equal(first.ok, true);
  assert.deepEqual(first.files, [{ path: "note.tex", text: "alpha" }]);
  const second = await api.get({ id: "1706.03762", version: "v7", userTriggered: true });
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1);
  await api.clear();
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
  assert.match(sw, /import\("\.\/arxiv-source\.js"\)/);
  assert.equal(sw.includes('from "./arxiv-source.js"'), false);
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
