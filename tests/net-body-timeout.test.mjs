/**
 * Real Response streams against 127.0.0.1. Fake transports return plain
 * objects, so they never see the timeout abort the body after the headers.
 *
 * 不变量（每个种子、每一步）:
 * ① 超时把读 body 算进去。先到响应头、body 随后到，结果是 200，不是 AbortError。
 * ② body 一直不结束并超过超时，报 timeout（TimeoutError），不报 AbortError。
 * ③ 响应头已经到客户端、body 还在读时，调用方 abort 仍是 AbortError，并且不重试。
 * ④ timeoutMs:false 不武装计时器，延迟的 body 照常返回。
 * ⑤ 401 的错误正文留在失败结果里，能画进「最近失败」，并让「需处理」挂出来。
 * ⑥ 核对通过的多模态结果写进存储；同一页再开，请求数是 0。
 * ⑦ 状态码重试不读 body；读 body 失败（不是超时、不是调用方 abort）不重试；
 *    响应头已到、body 随后超时，也不再发第二次 POST。头还没到的超时仍按策略重试。
 *    GET 在途去重仍然只打一次。
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createFormulaCache, createMemoryStore } from "../lib/formula-cache.js";
import { classifyFormulaProbe, FORMULA_SWITCH_KEYS, formulaChainFlags, multimodalReady, normalizeFormulaSettings } from "../lib/formula-settings.js";
import { renderFormulaSwitchList } from "../lib/formula-settings-ui.js";
import { createMmLedger } from "../lib/formula-mm-ledger.js";
import { scheduleFormulaBlock } from "../lib/formula-schedule.js";
import { multimodalTarget, sendVision } from "../lib/mm-client.js";
import { createNet, getNativeFetch } from "../lib/net/fetch.js";
import { loadKatex } from "./helpers/arxiv-paper.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG}`;
const SECRET = "mm-body-key-do-not-store-778899";
const katex = loadKatex();
const MODES = ["success", "timeout", "abort", "plain", "denied"];

function nativeNet() {
  const impl = getNativeFetch();
  return createNet({
    transport(url, init) {
      return impl(url, init);
    }
  });
}

async function loopbackUp() {
  const server = http.createServer((req, res) => {
    res.end("ok");
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const response = await getNativeFetch()(`http://127.0.0.1:${server.address().port}/`);
    return response.status === 200;
  } catch {
    return false;
  } finally {
    server.close();
  }
}

const loopback = await loopbackUp();
if (!loopback) {
  throw new Error(
    "tests/net-body-timeout.test.mjs: cannot bind 127.0.0.1 (loopback is down). This file must run; it does not skip."
  );
}

function listen(handler) {
  const server = http.createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.writableEnded) res.end();
    });
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        }
      });
    });
  });
}

function consume(req) {
  return new Promise((resolve) => {
    req.on("error", () => resolve());
    req.on("end", () => resolve());
    req.resume();
  });
}

function split(res, status, text, delayMs) {
  const raw = Buffer.from(text);
  const mid = Math.max(1, Math.floor(raw.length / 2));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(raw.length)
  });
  res.write(raw.subarray(0, mid));
  setTimeout(() => {
    if (!res.writableEnded) res.end(raw.subarray(mid));
  }, delayMs);
}

function hold(req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.write("{");
  req.on("close", () => {
    if (!res.writableEnded) res.end();
  });
}

function fail(seed, detail) {
  const message = `net body failed seed=${seed} ${detail}`;
  console.error(message);
  assert.fail(message);
}

async function waitUntil(pred, seed, limit = 1000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > limit) fail(seed, "timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function chat(text) {
  return JSON.stringify({ choices: [{ message: { content: text } }] });
}

// Only the two formula-path cases call this. A fixed vendor cannot use this
// loopback address; custom may, and the mock does not care which vendor it is.
function localSettings(origin) {
  return normalizeFormulaSettings({
    [FORMULA_SWITCH_KEYS.tier2]: true,
    multimodal: {
      provider: "custom",
      apiKey: SECRET,
      model: "gpt-5.6-luna",
      baseUrl: `${origin}/v1`
    }
  });
}

function formulaBlock() {
  return {
    label: "formula",
    id: "f-body",
    bid: "b-body",
    bbox: [0.1, 0.2, 0.4, 0.3],
    text: "x",
    display: true
  };
}

function countingStore() {
  const inner = createMemoryStore();
  const writes = { tier: 0, decision: 0, tierKey: "", decisionKey: "" };
  return {
    writes,
    store: {
      kind: "memory",
      getTier: (key) => inner.getTier(key),
      putTier: async (key, record) => {
        const ok = await inner.putTier(key, record);
        if (ok) {
          writes.tier += 1;
          writes.tierKey = key;
        }
        return ok;
      },
      commitTier: async (key, record) => {
        const ok = await inner.commitTier(key, record);
        if (ok) {
          writes.tier += 1;
          writes.tierKey = key;
        }
        return ok;
      },
      deleteTier: (key, writeId) => inner.deleteTier(key, writeId),
      rollbackTier: (key, writeId, displaced) => inner.rollbackTier(key, writeId, displaced),
      getDecision: (key) => inner.getDecision(key),
      putDecision: async (key, record) => {
        const ok = await inner.putDecision(key, record);
        if (ok) {
          writes.decision += 1;
          writes.decisionKey = key;
        }
        return ok;
      },
      clearDoc: (doc) => inner.clearDoc(doc),
      clearAll: () => inner.clearAll()
    }
  };
}

class DomNode {
  constructor() {
    this.childNodes = [];
  }
  append(...nodes) {
    this.childNodes.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.childNodes = nodes;
  }
  get textContent() {
    return this.childNodes.map((node) => node.textContent || "").join("");
  }
  set textContent(value) {
    this.childNodes = [{ textContent: String(value ?? "") }];
  }
}

class DomEl extends DomNode {
  constructor(tag) {
    super();
    this.tagName = String(tag || "").toUpperCase();
    this.className = "";
    this.attrs = {};
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  addEventListener() {}
}

function installDocument() {
  const prev = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      return new DomEl(tag);
    },
    createTextNode(text) {
      return { textContent: String(text ?? "") };
    }
  };
  return () => {
    globalThis.document = prev;
  };
}

describe("real response body stays inside the timeout", { concurrency: 1 }, () => {
  test("headers then a later body succeed under an active timeout", async () => {
    let hits = 0;
    const server = await listen(async (req, res) => {
      hits += 1;
      await consume(req);
      split(res, 200, chat("x"), 50);
    });
    try {
      const net = nativeNet();
      const url = `${server.url}/v1/chat/completions`;
      const delayed = await net.fetch({
        url,
        method: "POST",
        json: { ping: 1 },
        purpose: "multimodal",
        cache: false,
        dedupeKey: false,
        retry: false,
        timeoutMs: 1000
      });
      assert.equal(delayed.status, 200);
      assert.equal(delayed.data.choices[0].message.content, "x");
      const omitted = await net.fetch({
        url,
        method: "POST",
        json: { ping: 1 },
        purpose: "multimodal",
        cache: false,
        dedupeKey: false,
        retry: false
      });
      assert.equal(omitted.status, 200);
      assert.equal(omitted.data.choices[0].message.content, "x");
      assert.equal(hits, 2);
    } finally {
      await server.close();
    }
  });

  test("a timeout after headers does not send a second POST", async () => {
    let hits = 0;
    const net = createNet({
      random: () => 0,
      transport(_url, init) {
        hits += 1;
        const signal = init?.signal;
        return {
          ok: true,
          status: 200,
          headers: { "content-type": "application/json" },
          json() {
            return new Promise((_resolve, reject) => {
              const fail = () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              };
              if (signal?.aborted) {
                fail();
                return;
              }
              signal?.addEventListener("abort", fail, { once: true });
            });
          }
        };
      }
    });
    await assert.rejects(
      () => net.fetch({
        url: "https://vendor.example/v1/chat/completions",
        method: "POST",
        json: { ping: 1 },
        purpose: "multimodal",
        cache: false,
        dedupeKey: false,
        timeoutMs: 40
      }),
      (err) => {
        assert.equal(err.code, "timeout");
        assert.equal(err.name, "TimeoutError");
        assert.equal(err.bodyRead, true);
        return true;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(hits, 1);
  });

  test("a body that outlasts the timeout reports timeout", async () => {
    let headers = false;
    const server = await listen(async (req, res) => {
      await consume(req);
      hold(req, res);
      headers = true;
    });
    try {
      const net = nativeNet();
      await assert.rejects(
        () => net.fetch({
          url: `${server.url}/v1/chat/completions`,
          method: "POST",
          json: { ping: 1 },
          purpose: "multimodal",
          cache: false,
          dedupeKey: false,
          retry: false,
          timeoutMs: 200
        }),
        (err) => {
          assert.equal(err.code, "timeout");
          assert.equal(err.name, "TimeoutError");
          assert.notEqual(err.name, "AbortError");
          return true;
        }
      );
      assert.equal(headers, true);
    } finally {
      await server.close();
    }
  });

  test("a caller abort during the body read, after headers arrive, is AbortError and is not retried", async () => {
    let hits = 0;
    let releaseHeaders;
    const headersInClient = new Promise((resolve) => {
      releaseHeaders = resolve;
    });
    const impl = getNativeFetch();
    const net = createNet({
      transport(url, init) {
        return impl(url, init).then((response) => {
          releaseHeaders();
          return response;
        });
      }
    });
    const server = await listen(async (req, res) => {
      hits += 1;
      await consume(req);
      hold(req, res);
    });
    try {
      const ctrl = new AbortController();
      const pending = net.fetch({
        url: `${server.url}/v1/chat/completions`,
        method: "POST",
        json: { ping: 1 },
        purpose: "multimodal",
        cache: false,
        dedupeKey: false,
        retry: { max: 4, on: [429, 500], backoffMs: [200, 2000], honorRetryAfter: true },
        timeoutMs: 5000,
        signal: ctrl.signal
      });
      await headersInClient;
      await new Promise((resolve) => setTimeout(resolve, 30));
      ctrl.abort();
      await assert.rejects(pending, (err) => {
        assert.equal(err.name, "AbortError");
        assert.notEqual(err.code, "timeout");
        return true;
      });
      assert.equal(ctrl.signal.aborted, true);
      assert.equal(hits, 1);
    } finally {
      await server.close();
    }
  });

  test("timeoutMs false still returns a delayed body", async () => {
    const server = await listen(async (req, res) => {
      await consume(req);
      split(res, 200, JSON.stringify({ ok: true, via: "plain" }), 50);
    });
    try {
      const net = nativeNet();
      const url = `${server.url}/v1/chat/completions`;
      for (const purpose of ["translate", "multimodal", "arxiv"]) {
        const result = await net.fetch({
          url,
          method: "POST",
          json: { ping: 1 },
          purpose,
          cache: false,
          dedupeKey: false,
          retry: false,
          timeoutMs: false
        });
        assert.equal(result.status, 200, purpose);
        assert.equal(result.data.via, "plain", purpose);
      }
    } finally {
      await server.close();
    }
  });

  test("a broken body is not retried", async () => {
    let hits = 0;
    const server = await listen(async (req, res) => {
      hits += 1;
      await consume(req);
      split(res, 200, "not-json", 15);
    });
    try {
      const net = nativeNet();
      await assert.rejects(
        () => net.fetch({
          url: `${server.url}/broken`,
          method: "POST",
          json: { ping: 1 },
          purpose: "probe",
          cache: false,
          dedupeKey: false,
          retry: { max: 3, on: [429, 500], backoffMs: [1, 2], honorRetryAfter: false },
          timeoutMs: 1000
        }),
        (err) => {
          assert.equal(err.bodyRead, true);
          assert.notEqual(err.code, "timeout");
          assert.notEqual(err.name, "AbortError");
          return true;
        }
      );
      assert.equal(hits, 1);
    } finally {
      await server.close();
    }
  });

  test("a successful body read clears the timeout timer", async () => {
    const server = await listen(async (req, res) => {
      await consume(req);
      split(res, 200, JSON.stringify({ ok: true }), 30);
    });
    try {
      const pending = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
      const before = pending();
      const net = nativeNet();
      const result = await net.fetch({
        url: `${server.url}/ok`,
        method: "POST",
        json: { ping: 1 },
        purpose: "probe",
        cache: false,
        dedupeKey: false,
        retry: false,
        timeoutMs: 60_000
      });
      assert.equal(result.status, 200);
      assert.equal(result.data.ok, true);
      assert.equal(pending(), before);
    } finally {
      await server.close();
    }
  });

  test("a retryable status is decided before the body is read", { timeout: 2500 }, async () => {
    let hits = 0;
    const server = await listen(async (req, res) => {
      hits += 1;
      await consume(req);
      if (hits === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.write("{\"error\":\"busy\"");
        return;
      }
      split(res, 200, JSON.stringify({ ok: true, hit: hits }), 15);
    });
    try {
      const net = nativeNet();
      const started = Date.now();
      const result = await net.fetch({
        url: `${server.url}/stuck`,
        method: "POST",
        json: { ping: 1 },
        purpose: "probe",
        cache: false,
        dedupeKey: false,
        errorBody: true,
        timeoutMs: 5000,
        retry: { max: 1, on: [503, 500], backoffMs: [10, 20], honorRetryAfter: false }
      });
      const elapsed = Date.now() - started;
      assert.equal(result.status, 200);
      assert.equal(result.data.ok, true);
      assert.equal(hits, 2);
      assert.equal(elapsed < 2000, true, `elapsed ${elapsed}`);
    } finally {
      await server.close();
    }
  });

  test("a retry still reads each non-retryable body", async () => {
    let hits = 0;
    const server = await listen(async (req, res) => {
      hits += 1;
      await consume(req);
      if (hits === 1) split(res, 503, JSON.stringify({ error: "busy" }), 20);
      else split(res, 200, JSON.stringify({ ok: true, hit: hits }), 20);
    });
    try {
      const net = nativeNet();
      const result = await net.fetch({
        url: `${server.url}/retry`,
        method: "POST",
        json: { ping: 1 },
        purpose: "probe",
        cache: false,
        dedupeKey: false,
        timeoutMs: 1000,
        retry: { max: 1, on: [503, 500], backoffMs: [20, 40], honorRetryAfter: false }
      });
      assert.equal(result.status, 200);
      assert.equal(result.attempts, 2);
      assert.equal(result.data.ok, true);
      assert.equal(hits, 2);
    } finally {
      await server.close();
    }
  });

  test("in-flight GET dedupe reads one body", async () => {
    let hits = 0;
    const server = await listen(async (req, res) => {
      hits += 1;
      await consume(req);
      split(res, 200, JSON.stringify({ n: hits }), 30);
    });
    try {
      const net = nativeNet();
      const url = `${server.url}/asset`;
      const req = {
        url,
        method: "GET",
        purpose: "asset",
        cache: false,
        retry: false,
        timeoutMs: 1000
      };
      const [a, b] = await Promise.all([net.fetch(req), net.fetch({ ...req })]);
      assert.equal(hits, 1);
      assert.equal(a.data.n, 1);
      assert.equal(b.data.n, 1);
      assert.equal(a.attempts, 1);
    } finally {
      await server.close();
    }
  });

  test("a fixed vendor aimed at loopback is not ready", () => {
    assert.equal(multimodalReady({
      multimodal: {
        provider: "openai",
        apiKey: SECRET,
        model: "gpt-5.6-luna",
        baseUrl: "http://127.0.0.1:9/v1"
      }
    }), false);
  });

  test("a 401 error body reaches 最近失败 and 需处理", async () => {
    const message = "Incorrect API key provided";
    let hits = 0;
    const server = await listen(async (req, res) => {
      hits += 1;
      await consume(req);
      split(res, 401, JSON.stringify({ error: { message } }), 40);
    });
    const restore = installDocument();
    try {
      const settings = localSettings(server.url);
      const target = multimodalTarget(settings);
      assert.equal(target.url.startsWith(server.url), true);
      const net = nativeNet();
      const counted = countingStore();
      const ledger = createMmLedger();
      const shown = await scheduleFormulaBlock(formulaBlock(), {
        ...formulaChainFlags(settings),
        docHash: "doc-401",
        settings,
        readSettings: () => settings,
        katex,
        cache: createFormulaCache(counted.store),
        net,
        model: settings.multimodal.model,
        mmLedger: ledger,
        withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
      });
      assert.equal(shown.latexSource, undefined);
      assert.equal(shown.formulaTier, "crop");
      const failure = ledger.stats().lastFailure;
      assert.equal(failure.code, "401");
      assert.match(failure.summary, /Incorrect API key/);
      assert.equal(failure.summary.includes(SECRET), false);
      assert.equal(counted.writes.tier, 0);
      assert.equal(counted.writes.decision, 0);

      const vision = await sendVision({
        target,
        system: "sys",
        text: "公式",
        images: [{ mime: "image/png", base64: PNG }],
        secret: SECRET,
        net
      });
      assert.equal(vision.ok, false);
      assert.equal(vision.error.code, "401");
      assert.equal(vision.error.status, 401);
      assert.match(vision.error.summary, /Incorrect API key/);
      assert.equal(vision.error.summary.includes("已中止"), false);
      assert.equal(vision.error.summary.includes(SECRET), false);

      const probe = classifyFormulaProbe({
        status: vision.error.status,
        code: vision.error.code,
        summary: vision.error.summary
      });
      assert.equal(probe.ok, false);
      assert.equal(probe.chip, "密钥无效 (401)");
      const painted = normalizeFormulaSettings({
        ...settings,
        multimodal: { ...settings.multimodal, probe }
      });
      const container = new DomEl("div");
      renderFormulaSwitchList(container, painted);
      assert.match(container.textContent, /最近失败 · 密钥无效 \(401\)/);
      assert.match(container.textContent, /Incorrect API key/);
      const badge = { hidden: true, textContent: "需处理" };
      const probeBad = [painted.multimodal.probe, painted.ocr.probe].some((item) => item && item.ok === false && item.chip);
      badge.hidden = !probeBad;
      assert.equal(badge.hidden, false);
      assert.equal(badge.textContent, "需处理");
      assert.equal(hits, 2);
    } finally {
      restore();
      await server.close();
    }
  });

  test("a verified multimodal response is stored and the next open sends nothing", async () => {
    let hits = 0;
    const server = await listen(async (req, res) => {
      hits += 1;
      await consume(req);
      split(res, 200, chat("x"), 40);
    });
    try {
      const settings = localSettings(server.url);
      const net = nativeNet();
      const counted = countingStore();
      const hooks = {
        ...formulaChainFlags(settings),
        docHash: "doc-stored",
        settings,
        readSettings: () => settings,
        katex,
        cache: createFormulaCache(counted.store),
        net,
        model: settings.multimodal.model,
        mmLedger: createMmLedger(),
        withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
      };
      const shown = await scheduleFormulaBlock(formulaBlock(), hooks);
      assert.equal(shown.latex, "x");
      assert.equal(shown.latexSource, "vlm");
      assert.equal(shown.verified, true);
      assert.equal(hits, 1);
      assert.equal(counted.writes.tier, 1);
      assert.equal(counted.writes.decision > 0, true);
      const stored = await counted.store.getTier(counted.writes.tierKey);
      assert.equal(stored.result.latex, "x");
      const again = await scheduleFormulaBlock(formulaBlock(), {
        ...hooks,
        mmLedger: createMmLedger()
      });
      assert.equal(again.latex, "x");
      assert.equal(again.latexSource, "vlm");
      assert.equal(hits, 1);
      assert.equal(counted.writes.tier, 1);
      const kept = await counted.store.getTier(counted.writes.tierKey);
      assert.equal(kept.result.latex, "x");
      const decision = await counted.store.getDecision(counted.writes.decisionKey);
      assert.equal(decision.decision.chosen.latex, "x");
    } finally {
      await server.close();
    }
  });

  test("500 seeds keep a body read inside the timeout", { timeout: 180_000 }, async () => {
    const opened = new Map();
    let hits = 0;
    const server = await listen(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const seed = Number(url.searchParams.get("seed"));
      const mode = url.searchParams.get("mode");
      hits += 1;
      await consume(req);
      if (mode === "timeout" || mode === "abort") {
        req.on("close", () => {
          if (!res.writableEnded) res.end();
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        const wake = opened.get(seed);
        if (wake) wake();
        return;
      }
      const delay = 8 + (seed % 17);
      const status = mode === "denied" ? 401 : 200;
      const text = mode === "denied"
        ? JSON.stringify({ error: { message: `Incorrect API key seed-${seed}` } })
        : JSON.stringify({ ok: true, n: seed, mode });
      split(res, status, text, delay);
    });
    try {
      const net = nativeNet();
      const seen = Object.fromEntries(MODES.map((mode) => [mode, 0]));
      for (let seed = 0; seed < 500; seed += 1) {
        const mode = MODES[seed % 5];
        const before = hits;
        const url = `${server.url}/v1/chat/completions?seed=${seed}&mode=${mode}`;
        const base = {
          url,
          method: "POST",
          json: { ping: seed },
          cache: false,
          dedupeKey: false,
          errorBody: true
        };
        if (mode === "abort") {
          let ready = false;
          opened.set(seed, () => {
            ready = true;
          });
          const ctrl = new AbortController();
          const pending = net.fetch({
            ...base,
            purpose: "multimodal",
            retry: false,
            timeoutMs: 2000,
            signal: ctrl.signal
          });
          await waitUntil(() => ready, seed);
          ctrl.abort();
          await assert.rejects(pending, (err) => {
            if (err?.name !== "AbortError" || err?.code === "timeout" || ctrl.signal.aborted !== true) {
              fail(seed, `abort ${err?.name} ${err?.code}`);
            }
            return true;
          });
        } else if (mode === "timeout") {
          await assert.rejects(
            () => net.fetch({
              ...base,
              purpose: "multimodal",
              retry: false,
              timeoutMs: 50
            }),
            (err) => {
              if (err?.code !== "timeout" || err?.name === "AbortError") fail(seed, `timeout ${err?.name} ${err?.code}`);
              return true;
            }
          );
        } else if (mode === "plain") {
          const result = await net.fetch({
            ...base,
            purpose: "translate",
            retry: false,
            timeoutMs: false
          });
          if (result.status !== 200 || result.data?.n !== seed || result.data?.mode !== "plain") {
            fail(seed, `plain status=${result.status} n=${result.data?.n}`);
          }
        } else if (mode === "denied") {
          const result = await net.fetch({
            ...base,
            purpose: "multimodal",
            retry: false,
            timeoutMs: 800
          });
          const text = result.data?.error?.message || "";
          if (result.status !== 401 || !text.includes(`seed-${seed}`)) fail(seed, `denied status=${result.status} body=${text}`);
        } else {
          const result = await net.fetch({
            ...base,
            purpose: "multimodal",
            retry: false,
            timeoutMs: 800
          });
          if (result.status !== 200 || result.data?.n !== seed || result.data?.mode !== "success") {
            fail(seed, `success status=${result.status} n=${result.data?.n} mode=${result.data?.mode}`);
          }
        }
        if (hits !== before + 1) fail(seed, `requests ${hits - before}`);
        seen[mode] += 1;
      }
      for (const mode of MODES) assert.equal(seen[mode], 100, mode);
    } finally {
      await server.close();
    }
  });
});
