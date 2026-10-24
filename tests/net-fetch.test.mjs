import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
  TIMEOUT_MS,
  arxivNetFetch,
  createArxivSourceClient,
  createMemoryStore
} from "../background/arxiv-source.js";
import {
  createNet,
  fixtureTransport,
  getNativeFetch,
  redactHeaders,
  redactText
} from "../lib/net/fetch.js";
import { providers } from "../lib/providers.js";
import { createMemoryPlatform, setPlatform } from "../lib/platform/index.js";

test.afterEach(() => {
  setPlatform(null);
});

const SECRET = "sk-secret-should-not-leak-123456";
const PLAIN_KEY = "plain-key-should-not-leak-987654";

function llmCtx() {
  return {
    sourceLang: "en",
    targetLang: "zh-CN",
    settings: {
      apiKey: SECRET,
      baseUrl: "https://api.example.com/v1",
      model: "user-picked-model"
    }
  };
}

function okChat() {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: "1. 你好" } }] };
    }
  };
}

function advancingTime() {
  let t = 0;
  const waits = [];
  return {
    now: () => t,
    waits,
    sleep(ms) {
      waits.push(ms);
      t += ms;
      return Promise.resolve();
    }
  };
}

function deferredTime() {
  let t = 0;
  const pending = [];
  return {
    now: () => t,
    pending: () => pending.length,
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        const item = { at: t + ms, resolve };
        pending.push(item);
        signal?.addEventListener("abort", () => {
          const index = pending.indexOf(item);
          if (index >= 0) pending.splice(index, 1);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
    async advance(ms) {
      t += ms;
      for (;;) {
        const due = pending.filter((item) => item.at <= t);
        if (!due.length) break;
        for (const item of due) {
          const index = pending.indexOf(item);
          if (index >= 0) pending.splice(index, 1);
          item.resolve();
        }
        await Promise.resolve();
        await Promise.resolve();
      }
    }
  };
}

test("redaction masks keys, bearer tokens, and secret headers", () => {
  const url = redactText(
    `https://alice:${PLAIN_KEY}@example.test/v1?key=${PLAIN_KEY}&x-api-key=${PLAIN_KEY}&access_key=${PLAIN_KEY}&ok=1`
  );
  assert.equal(url.includes(PLAIN_KEY), false);
  assert.equal(url.includes("alice"), false);
  assert.match(url, /\/\/\*\*\*:\*\*\*@example\.test/);
  assert.match(url, /[?&]key=\*\*\*/);
  assert.match(url, /x-api-key=\*\*\*/);
  assert.match(url, /access_key=\*\*\*/);
  assert.match(url, /ok=1/);
  assert.equal(redactText(`note ${SECRET}`).includes(SECRET), false);
  const headers = redactHeaders({
    Authorization: `Bearer ${SECRET}`,
    "x-api-key": SECRET,
    "Ocp-Apim-Subscription-Key": SECRET,
    "Content-Type": "application/json",
    "X-Title": "Open Immerse"
  });
  assert.equal(headers.Authorization, "***");
  assert.equal(headers["x-api-key"], "***");
  assert.equal(headers["Ocp-Apim-Subscription-Key"], "***");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["X-Title"], "Open Immerse");
  assert.equal(JSON.stringify(headers).includes(SECRET), false);
});

test("logs drop secrets while the wire request keeps them", async () => {
  const seen = [];
  const logs = [];
  const net = createNet({
    log: (record) => logs.push(record),
    transport: async (url, init) => {
      seen.push({ url, authorization: init.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  const res = await net.fetch({
    url: `https://alice:${PLAIN_KEY}@example.test/call?api_key=${PLAIN_KEY}&x-api-key=${PLAIN_KEY}&access_key=${PLAIN_KEY}`,
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: "{}",
    purpose: "translate",
    timeoutMs: false,
    retry: false,
    dedupeKey: false
  });
  assert.equal(res.ok, true);
  assert.equal(seen[0].authorization, `Bearer ${SECRET}`);
  assert.equal(seen[0].url.includes(PLAIN_KEY), true);
  assert.equal(seen[0].url.includes("alice"), true);
  assert.equal(JSON.stringify(logs).includes(SECRET), false);
  assert.equal(JSON.stringify(logs).includes(PLAIN_KEY), false);
  assert.equal(logs[0].headers.Authorization, "***");
  assert.match(logs[0].url, /\/\/\*\*\*:\*\*\*@/);
  assert.match(logs[0].url, /api_key=\*\*\*/);
  assert.match(logs[0].url, /x-api-key=\*\*\*/);
  assert.match(logs[0].url, /access_key=\*\*\*/);
});

test("fixtureTransport rejects an unregistered URL without calling fetch", async () => {
  const prev = globalThis.fetch;
  let called = 0;
  globalThis.fetch = () => {
    called += 1;
    throw new Error("global fetch should not run");
  };
  try {
    const net = createNet({
      transport: fixtureTransport(new Map([
        ["https://example.test/ok", { ok: true, status: 200, data: { hi: 1 } }]
      ]))
    });
    const ok = await net.fetch({
      url: "https://example.test/ok",
      purpose: "probe",
      timeoutMs: false,
      retry: false
    });
    assert.equal(ok.data.hi, 1);
    await assert.rejects(
      () => net.fetch({
        url: `https://example.test/missing?key=${SECRET}`,
        purpose: "probe",
        timeoutMs: false,
        retry: false
      }),
      (err) => {
        assert.equal(err.code, "real-network-in-test");
        assert.match(err.message, /real network in test/);
        assert.equal(err.message.includes(SECRET), false);
        return true;
      }
    );
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = prev;
  }
});

test("purpose timeouts match the recorded defaults", async () => {
  async function timeoutFor(purpose) {
    const waits = [];
    const net = createNet({
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      transport: (_url, init) => new Promise((_resolve, reject) => {
        const fail = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener("abort", fail, { once: true });
      })
    });
    await assert.rejects(
      () => net.fetch({ url: "https://example.test/slow", purpose, retry: false }),
      (err) => err.code === "timeout"
    );
    return waits[0];
  }
  assert.equal(await timeoutFor("translate"), 60_000);
  assert.equal(await timeoutFor("multimodal"), 90_000);
  assert.equal(await timeoutFor("ocr"), 120_000);
  assert.equal(await timeoutFor("layout"), 30_000);
  assert.equal(await timeoutFor("arxiv"), 20_000);
  assert.equal(await timeoutFor("probe"), 1_200);
  assert.equal(await timeoutFor("local-service"), 1_200);
  assert.equal(await timeoutFor("asset"), 60_000);
});

test("omitted retry is one extra attempt for translate and two for probe", async () => {
  const time = advancingTime();
  let translateCalls = 0;
  const translate = createNet({
    clock: time.now,
    sleep: time.sleep,
    random: () => 0,
    transport: async () => {
      translateCalls += 1;
      if (translateCalls === 1) return { ok: false, status: 503 };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  const translated = await translate.fetch({
    url: "https://example.test/llm",
    method: "POST",
    body: "{}",
    purpose: "translate",
    timeoutMs: false,
    dedupeKey: false
  });
  assert.equal(translated.attempts, 2);
  assert.equal(translateCalls, 2);
  assert.deepEqual(time.waits, [200]);

  const probeTime = advancingTime();
  let probeCalls = 0;
  const probe = createNet({
    clock: probeTime.now,
    sleep: probeTime.sleep,
    random: () => 0,
    transport: async () => {
      probeCalls += 1;
      return { ok: false, status: 500 };
    }
  });
  const failed = await probe.fetch({
    url: "https://example.test/probe",
    purpose: "probe",
    timeoutMs: false
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.attempts, 3);
  assert.equal(probeCalls, 3);
  assert.deepEqual(probeTime.waits, [200, 400]);
});

test("Retry-After replaces backoff and is capped at 60s", async () => {
  const time = advancingTime();
  let calls = 0;
  const net = createNet({
    clock: time.now,
    sleep: time.sleep,
    random: () => 0,
    transport: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, headers: { "Retry-After": "3" } };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  const res = await net.fetch({
    url: "https://example.test/limited",
    purpose: "layout",
    provider: "layout",
    timeoutMs: false,
    retry: { max: 1, on: [429, 500], backoffMs: [200, 2000], honorRetryAfter: true }
  });
  assert.equal(res.ok, true);
  assert.deepEqual(time.waits, [3000]);

  const capped = advancingTime();
  let cappedCalls = 0;
  const cappedNet = createNet({
    clock: capped.now,
    sleep: capped.sleep,
    random: () => 0,
    transport: async () => {
      cappedCalls += 1;
      if (cappedCalls === 1) return { ok: false, status: 429, headers: { "retry-after": "120" } };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  await cappedNet.fetch({
    url: "https://example.test/capped",
    purpose: "layout",
    timeoutMs: false,
    retry: { max: 1, on: [429], backoffMs: [200, 2000], honorRetryAfter: true }
  });
  assert.deepEqual(capped.waits, [60_000]);
});

test("a caller abort and a normal 4xx are not retried", async () => {
  let aborted = 0;
  const controller = new AbortController();
  controller.abort();
  const net = createNet({
    random: () => 0,
    sleep: () => {
      throw new Error("should not wait");
    },
    transport: async () => {
      aborted += 1;
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
  });
  await assert.rejects(
    () => net.fetch({
      url: "https://example.test/abort",
      purpose: "probe",
      signal: controller.signal,
      timeoutMs: false,
      retry: { max: 4, on: [429, 500], backoffMs: [200, 2000], honorRetryAfter: true }
    }),
    (err) => err.name === "AbortError"
  );
  assert.equal(aborted, 1);

  let denied = 0;
  const once = createNet({
    transport: async () => {
      denied += 1;
      return { ok: false, status: 401 };
    }
  });
  const res = await once.fetch({
    url: "https://example.test/denied",
    purpose: "translate",
    method: "POST",
    timeoutMs: false
  });
  assert.equal(res.status, 401);
  assert.equal(denied, 1);
});

test("in-flight GET dedupe shares one request; POST does not unless asked", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const net = createNet({
    transport: async () => {
      const id = calls;
      calls += 1;
      await gate;
      return { ok: true, status: 200, json: async () => ({ id }) };
    }
  });
  const first = net.fetch({
    url: "https://example.test/page",
    method: "GET",
    purpose: "asset",
    timeoutMs: false,
    retry: false
  });
  const second = net.fetch({
    url: "https://example.test/page",
    method: "GET",
    purpose: "asset",
    timeoutMs: false,
    retry: false
  });
  const other = net.fetch({
    url: "https://example.test/page",
    method: "POST",
    body: "{}",
    purpose: "asset",
    timeoutMs: false,
    retry: false
  });
  const named = net.fetch({
    url: "https://example.test/page",
    method: "POST",
    body: "{}",
    purpose: "asset",
    timeoutMs: false,
    retry: false,
    dedupeKey: "same-post"
  });
  const namedAgain = net.fetch({
    url: "https://example.test/other",
    method: "POST",
    body: "different",
    purpose: "asset",
    timeoutMs: false,
    retry: false,
    dedupeKey: "same-post"
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  release();
  const [a, b, c, d, e] = await Promise.all([first, second, other, named, namedAgain]);
  assert.equal(a.data.id, b.data.id);
  assert.equal(d.data.id, e.data.id);
  assert.notEqual(c.data.id, a.data.id);
  assert.notEqual(d.data.id, c.data.id);
});

test("explicit cache returns the body once and expires", async () => {
  let now = 0;
  let calls = 0;
  const net = createNet({
    clock: () => now,
    transport: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ calls }) };
    }
  });
  const req = {
    url: "https://example.test/layout",
    purpose: "layout",
    timeoutMs: false,
    retry: false,
    dedupeKey: false,
    cache: { key: "layout:1", ttlMs: 500 }
  };
  const first = await net.fetch(req);
  const second = await net.fetch({ ...req, url: "https://example.test/other" });
  assert.equal(calls, 1);
  assert.equal(second.fromCache, true);
  assert.equal(second.attempts, 0);
  assert.deepEqual(second.data, first.data);
  now = 500;
  const third = await net.fetch(req);
  assert.equal(third.fromCache, false);
  assert.equal(calls, 2);

  let errors = 0;
  const failing = createNet({
    transport: async () => {
      errors += 1;
      return { ok: false, status: 502 };
    }
  });
  await failing.fetch({ ...req, cache: { key: "nope", ttlMs: 500 } });
  await failing.fetch({ ...req, cache: { key: "nope", ttlMs: 500 } });
  assert.equal(errors, 2);
});

test("a 429 queues the next request for that provider", async () => {
  const time = deferredTime();
  let calls = 0;
  const net = createNet({
    clock: time.now,
    sleep: time.sleep,
    random: () => 0,
    transport: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, headers: { "retry-after": "5" } };
      return { ok: true, status: 200, json: async () => ({ calls }) };
    }
  });
  const first = net.fetch({
    url: "https://example.test/a",
    purpose: "probe",
    provider: "demo",
    timeoutMs: false,
    retry: { max: 1, on: [429, 500], backoffMs: [200, 2000], honorRetryAfter: true }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  const second = net.fetch({
    url: "https://example.test/b",
    purpose: "probe",
    provider: "demo",
    timeoutMs: false,
    retry: { max: 1, on: [429, 500], backoffMs: [200, 2000], honorRetryAfter: true }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  await time.advance(5000);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(calls, 3);
});

test("provider calls keep one attempt, no timeout, and the same body", async () => {
  const waits = [];
  let calls = 0;
  const net = createNet({
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    transport: async (url, init) => {
      calls += 1;
      assert.equal(url, "https://api.example.com/v1/chat/completions");
      assert.equal(init.headers.Authorization, `Bearer ${SECRET}`);
      const body = JSON.parse(init.body);
      assert.equal(body.model, "user-picked-model");
      assert.equal(body.messages[1].content.includes("Hello"), true);
      return okChat();
    }
  });
  setPlatform(createMemoryPlatform({ net }));
  const [one, two] = await Promise.all([
    providers.openai.translate(["Hello"], llmCtx()),
    providers.openai.translate(["Hello"], llmCtx())
  ]);
  assert.deepEqual(one, ["你好"]);
  assert.deepEqual(two, ["你好"]);
  assert.equal(calls, 2);
  assert.deepEqual(waits, []);

  let failed = 0;
  setPlatform(createMemoryPlatform({
    net: createNet({
      transport: async () => {
        failed += 1;
        return { ok: false, status: 500, json: async () => ({}) };
      }
    })
  }));
  await assert.rejects(
    () => providers.openai.translate(["Hello"], llmCtx()),
    (err) => err.message === "OpenAI / 兼容通道 HTTP 500" && err.httpStatus === 500
  );
  assert.equal(failed, 1);
});

test("providers reach fetch only through lib/net", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = async () => {
    assert.match(new Error().stack, /[/\\]lib[/\\]net[/\\]fetch\.js/);
    return okChat();
  };
  try {
    const out = await providers.openai.translate(["Hello"], llmCtx());
    assert.deepEqual(out, ["你好"]);
  } finally {
    globalThis.fetch = prev;
  }
});

test("an unmocked provider call fails before the real fetch", async () => {
  const prev = globalThis.fetch;
  globalThis.fetch = getNativeFetch();
  try {
    await assert.rejects(
      () => providers.gemini.translate(["Hello"], {
        sourceLang: "en",
        targetLang: "zh-CN",
        settings: { apiKey: PLAIN_KEY, model: "gemini-2.0-flash" }
      }),
      (err) => {
        assert.equal(err.code, "real-network-in-test");
        assert.match(err.message, /real network in test/);
        assert.equal(err.message.includes(PLAIN_KEY), false);
        assert.match(err.message, /key=\*\*\*/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = prev;
  }
});

test("setPlatform swaps the transport used by providers", async () => {
  const prev = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    throw new Error("direct fetch");
  };
  setPlatform(createMemoryPlatform({
    net: createNet({
      transport: async () => {
        calls += 1;
        return okChat();
      }
    })
  }));
  try {
    const out = await providers.openai.translate(["Hello"], llmCtx());
    assert.deepEqual(out, ["你好"]);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = prev;
  }
});

test("currentNet fetch runs in a context that has no process", async () => {
  const sourceUrl = new URL("../lib/net/fetch.js", import.meta.url);
  const source = readFileSync(sourceUrl, "utf8")
    .replace(/^export const /gm, "const ")
    .replace(/^export async function /gm, "async function ")
    .replace(/^export function /gm, "function ");
  const script = `${source}\nglobalThis.__net = { createNet, currentNet, installNet };\n`;
  const calls = [];
  const sandbox = {
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    structuredClone,
    fetch(input, init) {
      calls.push({ input, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ delivered: true })
      };
    }
  };
  vm.createContext(sandbox);
  assert.equal(vm.runInContext("typeof process", sandbox), "undefined");
  assert.equal(vm.runInContext("typeof Buffer", sandbox), "undefined");
  assert.equal(vm.runInContext("typeof require", sandbox), "undefined");
  vm.runInContext(script, sandbox, { filename: sourceUrl.pathname });
  const target = "https://example.test/from-chrome?key=visible-on-wire";
  const result = await sandbox.__net.currentNet().fetch({
    url: target,
    method: "POST",
    purpose: "translate",
    timeoutMs: false,
    retry: false,
    cache: false,
    dedupeKey: false
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, target);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(result.ok, true);
  assert.equal(result.data.delivered, true);
});

test("arxiv production fetch keeps the 20s timeout and does not retry", async () => {
  let calls = 0;
  setPlatform(createMemoryPlatform({
    net: createNet({
      transport: () => {
        calls += 1;
        return new Promise(() => {});
      }
    })
  }));
  const clock = {
    t: 0,
    fireTimeout: null,
    sleep(ms) {
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
  const api = createArxivSourceClient({
    fetch: arxivNetFetch,
    now: () => clock.t,
    sleep: (ms) => clock.sleep(ms),
    store: createMemoryStore(),
    gunzip: () => new Uint8Array()
  });
  const pending = api.get({ id: "1", version: "v1", userTriggered: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  clock.fireTimeout();
  const failed = await pending;
  assert.equal(failed.reason, "timeout");
  assert.equal(calls, 1);
  assert.equal(TIMEOUT_MS, 20_000);
});

test("arxiv production fetch forwards status, signal, and bytes", async () => {
  let signal = null;
  setPlatform(createMemoryPlatform({
    net: createNet({
      transport: async (_url, init) => {
        signal = init.signal;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer
        };
      }
    })
  }));
  const controller = new AbortController();
  const res = await arxivNetFetch("https://arxiv.org/src/1706.03762v7", { signal: controller.signal });
  assert.equal(signal, controller.signal);
  assert.equal(res.status, 200);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [9, 8, 7]);

  setPlatform(createMemoryPlatform({
    net: createNet({
      transport: async () => ({ ok: false, status: 429 })
    })
  }));
  const blocked = await arxivNetFetch("https://arxiv.org/src/1");
  assert.equal(blocked.status, 429);
});

test("multimodal error logs redact the sent key and other purposes do not", async () => {
  const key = "AIzaSyD-plain-probe-key-0123456789";
  const padded = ` \n${key}\n `;
  async function capture(purpose, header) {
    const logs = [];
    const net = createNet({
      log: (row) => logs.push(row),
      random: () => 0,
      sleep: () => Promise.resolve(),
      transport() {
        throw new Error(`fetch failed ${key}`);
      }
    });
    await assert.rejects(() => net.fetch({
      url: "https://example.test/log",
      purpose,
      method: "POST",
      headers: { "x-goog-api-key": header },
      timeoutMs: false,
      retry: false
    }));
    return logs;
  }
  const multimodal = await capture("multimodal", padded);
  assert.equal(JSON.stringify(multimodal).includes(key), false);
  assert.match(multimodal[0].error, /fetch failed/);
  const probe = await capture("probe", padded);
  assert.equal(probe[0].error.includes(key), true);
  assert.equal(probe[0].headers["x-goog-api-key"], "***");
});

test("multimodal error logs redact a bare key carried by Authorization Bearer", async () => {
  const key = "AIzaSyD-bare-bearer-key-0123456789";
  const logs = [];
  const net = createNet({
    log: (row) => logs.push(row),
    random: () => 0,
    sleep: () => Promise.resolve(),
    transport() {
      throw new Error(`fetch failed ${key}`);
    }
  });
  await assert.rejects(() => net.fetch({
    url: "https://example.test/bearer",
    purpose: "multimodal",
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    timeoutMs: false,
    retry: false
  }));
  assert.equal(JSON.stringify(logs).includes(key), false);
  assert.match(logs[0].error, /fetch failed/);
  assert.equal(logs[0].headers.Authorization, "***");
});

test("a Bearer token with leading whitespace is still redacted in multimodal error logs", async () => {
  const key = "AIzaSyD-spaced-bearer-key-0123456789";
  const logs = [];
  const net = createNet({
    log: (row) => logs.push(row),
    random: () => 0,
    sleep: () => Promise.resolve(),
    transport() {
      throw new Error(`fetch failed ${key}`);
    }
  });
  await assert.rejects(() => net.fetch({
    url: "https://example.test/bearer-space",
    purpose: "multimodal",
    method: "POST",
    headers: { Authorization: `  Bearer ${key}` },
    timeoutMs: false,
    retry: false
  }));
  assert.equal(JSON.stringify(logs).includes(key), false);
  assert.match(logs[0].error, /fetch failed/);
});

test("error bodies stay unread unless the caller opts in", async () => {
  const body = JSON.stringify({ error: { message: "This model does not support image input" } });
  function transport() {
    return new Response(body, { status: 400, headers: { "content-type": "application/json" } });
  }
  const hidden = createNet({
    transport,
    random: () => 0,
    sleep: () => Promise.resolve()
  });
  const plain = await hidden.fetch({
    url: "https://example.test/hidden",
    purpose: "probe",
    timeoutMs: false,
    retry: false
  });
  assert.equal(plain.ok, false);
  assert.equal(plain.status, 400);
  assert.equal(plain.data, null);
  const shown = createNet({
    transport,
    random: () => 0,
    sleep: () => Promise.resolve()
  });
  const opted = await shown.fetch({
    url: "https://example.test/shown",
    purpose: "multimodal",
    timeoutMs: false,
    retry: false,
    errorBody: true
  });
  assert.equal(opted.ok, false);
  assert.equal(opted.data.error.message, "This model does not support image input");
});

test("abort releases the multimodal account slot immediately and does not double-release", async () => {
  const gates = [];
  let started = 0;
  const net = createNet({
    transport: () => new Promise((resolve) => {
      started += 1;
      gates.push(resolve);
    })
  });
  const headers = { Authorization: "Bearer slot-key" };
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const hanging = controllers.map((controller) => net.fetch({
    url: "https://example.test/mm-slot",
    method: "POST",
    purpose: "multimodal",
    headers,
    signal: controller.signal,
    timeoutMs: false,
    retry: false
  }));
  for (let i = 0; i < 20 && started < 3; i += 1) await Promise.resolve();
  assert.equal(started, 3);
  for (const controller of controllers) controller.abort();
  const settled = await Promise.allSettled(hanging);
  assert.deepEqual(settled.map((item) => item.status), ["rejected", "rejected", "rejected"]);
  for (const item of settled) assert.equal(item.reason.name, "AbortError");

  const follow = [0, 1, 2, 3].map(() => net.fetch({
    url: "https://example.test/mm-slot",
    method: "POST",
    purpose: "multimodal",
    headers,
    timeoutMs: false,
    retry: false
  }));
  for (let i = 0; i < 20 && started < 6; i += 1) await Promise.resolve();
  assert.equal(started, 6);
  gates[3]({ ok: true, status: 200, data: { ok: true } });
  for (let i = 0; i < 20 && started < 7; i += 1) await Promise.resolve();
  assert.equal(started, 7);
  for (let i = 0; i < started; i += 1) {
    if (i === 3) continue;
    gates[i]({ ok: true, status: 200, data: { ok: true } });
  }
  const followed = await Promise.all(follow);
  assert.equal(followed.length, 4);
  assert.equal(followed.every((item) => item.ok === true), true);
});

test("a retry removes the abort listener before the next attempt", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  let added = 0;
  let removed = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === "abort") added += 1;
    return add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") removed += 1;
    return remove(type, listener, options);
  };
  let calls = 0;
  const net = createNet({
    random: () => 0,
    sleep: () => Promise.resolve(),
    transport: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500, data: {} };
      return { ok: true, status: 200, data: { ok: true } };
    }
  });
  const res = await net.fetch({
    url: "https://example.test/retry-listener",
    method: "POST",
    purpose: "multimodal",
    headers: { Authorization: "Bearer listener-key" },
    signal,
    timeoutMs: false,
    retry: { max: 1, on: [500], backoffMs: [0, 0], honorRetryAfter: false }
  });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  assert.equal(added, 2);
  assert.equal(removed, 2);
  assert.equal(signal.aborted, false);
});
