import test from "node:test";
import assert from "node:assert/strict";

import {
  DIAG_TEXT,
  buildDiagPackage,
  createDiagWriter,
  describeDiagExportResult,
  diagExportedLine,
  diagFilename,
  diagRecordedLine,
  performDiagExport,
  resetDiagForTests,
  serializeDiagPackage
} from "../lib/diag-log.js";

const SECRET = "mm-key-9z";
const URL_TOKEN = "sig9zz";
const PAPER = "paper9z";
const TITLE = "title9z";
const TRANS = "trans9z";
const NOTE = "note9z";
const ANS = "ans9z";

function memoryArea(seed = {}) {
  const bag = structuredClone(seed);
  return {
    bag,
    async get(key) {
      if (typeof key === "string") return { [key]: bag[key] };
      return structuredClone(bag);
    },
    async set(patch) {
      Object.assign(bag, structuredClone(patch));
    }
  };
}

const env = {
  extVersion: "1.2.3",
  browser: { brand: "Chrome", version: "120.0", platform: "Linux" },
  locale: "zh-CN"
};

function leakedUrl() {
  return `https://user:pw@papers.example/a;token=${URL_TOKEN}?page=3&sig=${URL_TOKEN}&X-Amz-Signature=${URL_TOKEN}&x_amz_token=${URL_TOKEN}&key=${SECRET}&code=c0de9z&access_key=ak9z99&otp=otp9z1&hmac=hm9z99#frag9z`;
}

async function exportLeak() {
  resetDiagForTests();
  const local = memoryArea({
    apiKey: SECRET,
    oiSecrets: { token: "qtok9z", providers: { openai: { apiKey: SECRET } } },
    mm: { apiKey: SECRET },
    ocr: { headersJson: SECRET }
  });
  const sync = memoryArea({
    settings: {
      provider: "openai",
      providers: {
        openai: { apiKey: SECRET, baseUrl: "https://api.example/v1", model: "gpt-test" }
      }
    }
  });
  const writer = createDiagWriter({ storage: local, sync, debounceMs: -1 });
  writer.log({
    type: "translate.error",
    ctx: "sw",
    code: "401",
    provider: "openai",
    count: 2,
    msg: `key was ${SECRET} at ${leakedUrl()} file:///tmp/paper.pdf blob:abcd chrome-extension://abc/x data:text/plain,hi Authorization: ${SECRET} x-api-key=${SECRET}`,
    text: PAPER,
    title: TITLE,
    translation: TRANS,
    note: NOTE,
    answer: ANS
  });
  const result = await writer.exportPackage(env);
  return JSON.stringify(result.package);
}

test.afterEach(() => {
  resetDiagForTests();
});

test("export json hides url query tokens that are not stored secrets", async () => {
  const packed = await exportLeak();
  assert.equal(packed.includes(URL_TOKEN), false);
  assert.equal(packed.includes("user:pw"), false);
  assert.equal(packed.includes("frag9z"), false);
  assert.equal(packed.includes("c0de9z"), false);
  assert.match(packed, /page=3/);
  assert.match(packed, /file:/);
  assert.equal(packed.includes("file:///"), false);
  assert.equal(packed.includes("blob:abcd"), false);
  assert.equal(packed.includes("chrome-extension://"), false);
  assert.equal(packed.includes("data:text"), false);
});

test("export hides keys stored as oiSecrets provider strings", async () => {
  const shortKey = "myLocalKey.2026";
  const dotted = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp";
  const legacy = "legacyKey.9z";
  resetDiagForTests();
  const local = memoryArea({
    oiSecrets: {
      providers: { openai: shortKey, custom: dotted },
      pdfCloudApiKey: "pdfkey.123"
    }
  });
  const sync = memoryArea({
    settings: {
      provider: "openai",
      providers: { openai: { apiKey: "" }, deepl: { apiKey: legacy } }
    }
  });
  const writer = createDiagWriter({ storage: local, sync, debounceMs: -1 });
  writer.log({
    type: "translate.error",
    ctx: "sw",
    code: "401",
    msg: `401 invalid api key ${shortKey}; zhipu ${dotted}; deepl ${legacy}`
  });
  const packed = JSON.stringify((await writer.exportPackage(env)).package);
  assert.equal(packed.includes(shortKey), false);
  assert.equal(packed.includes("AbCdEfGhIjKlMnOp"), false);
  assert.equal(packed.includes(dotted), false);
  assert.equal(packed.includes(legacy), false);
  assert.equal(packed.includes("pdfkey.123"), false);
});

test("export json hides short secret values that provider redaction keeps", async () => {
  const packed = await exportLeak();
  assert.equal(packed.includes(SECRET), false);
  assert.equal(packed.includes("qtok9z"), false);
  assert.equal(packed.includes("api.example"), false);
  assert.equal(packed.includes("gpt-test"), false);
});

test("export json drops unknown paper fields", async () => {
  const packed = await exportLeak();
  assert.equal(packed.includes(PAPER), false);
  assert.equal(packed.includes(TITLE), false);
  assert.equal(packed.includes(TRANS), false);
  assert.equal(packed.includes(NOTE), false);
  assert.equal(packed.includes(ANS), false);
});

test("a secret added after the event was logged is still masked at export", async () => {
  const local = memoryArea({});
  const writer = createDiagWriter({ storage: local, debounceMs: -1 });
  writer.log({ type: "mm.error", code: "401", msg: `leaked ${SECRET}` });
  await writer.flush();
  local.bag.apiKey = SECRET;
  const result = await writer.exportPackage(env);
  assert.equal(JSON.stringify(result.package).includes(SECRET), false);
});

test("no-records and storage-unreadable still export version and environment only", () => {
  const empty = buildDiagPackage({ events: [], now: Date.UTC(2026, 9, 19, 6, 5, 4), env, settings: { provider: "openai", providers: { openai: { apiKey: SECRET } } } });
  assert.equal(empty.ok, true);
  assert.equal(empty.code, "no-records");
  assert.equal(empty.package.events.length, 0);
  assert.equal(empty.package.format, 1);
  assert.equal(empty.package.extVersion, "1.2.3");
  assert.equal(empty.package.browser.brand, "Chrome");
  assert.equal(empty.package.locale, "zh-CN");
  assert.equal(empty.package.settingsSummary.provider, "openai");
  assert.equal(empty.package.code, undefined);
  assert.equal(JSON.stringify(empty.package).includes(SECRET), false);
  assert.equal(JSON.stringify(empty.package).includes("no-records"), false);

  const unread = buildDiagPackage({
    events: [{ t: 1, type: "mm.error", msg: SECRET, text: PAPER }],
    storageCode: "storage-unreadable",
    now: Date.UTC(2026, 9, 19, 6, 5, 4),
    env
  });
  assert.equal(unread.ok, true);
  assert.equal(unread.code, "storage-unreadable");
  assert.equal(unread.package.events.length, 0);
  assert.equal(unread.package.extVersion, "1.2.3");
  assert.equal(JSON.stringify(unread.package).includes(SECRET), false);
  assert.equal(JSON.stringify(unread.package).includes("storage-unreadable"), false);
});

test("filename uses the local stamp and the manifest version", () => {
  const when = new Date(2026, 9, 19, 3, 4, 5);
  assert.equal(diagFilename("1.2.3", when), "open-immerse-diagnostics-1.2.3-20261019-030405.json");
  assert.equal(diagFilename("1.2.3 beta", when), "open-immerse-diagnostics-1.2.3_beta-20261019-030405.json");
});

test("only serialize and download failures ask the user to retry", () => {
  const serialize = describeDiagExportResult({ ok: false, code: "serialize-failed" }, { count: 2, bytes: 40 });
  assert.equal(serialize.failure, true);
  assert.equal(serialize.retry, true);
  assert.equal(serialize.text, "没能导出：打包时出错。");

  const download = describeDiagExportResult({ ok: false, code: "download-failed" }, { count: 2, bytes: 40 });
  assert.equal(download.failure, true);
  assert.equal(download.retry, true);
  assert.equal(download.text, "没能导出：文件没保存下来，检查一下下载设置或磁盘空间。");

  const unread = describeDiagExportResult({ ok: true, code: "storage-unreadable", filename: "a.json" }, { count: 0, bytes: 0 });
  assert.equal(unread.failure, false);
  assert.equal(unread.retry, false);
  assert.equal(unread.tone, "warn");
  assert.equal(unread.text, "暂时读不了日志，导出的包只含版本和环境信息。");

  const none = describeDiagExportResult({ ok: true, code: "no-records", count: 0, filename: "a.json" }, { count: 0, bytes: 0 });
  assert.equal(none.failure, false);
  assert.equal(none.retry, false);
  assert.equal(none.tone, "ok");
  assert.equal(none.text, diagExportedLine("a.json"));

  const saved = describeDiagExportResult({ ok: true, code: "", count: 2, filename: "pack.json" }, { count: 2, bytes: 40 });
  assert.equal(saved.failure, false);
  assert.equal(saved.text, diagExportedLine("pack.json"));
});

test("performDiagExport downloads an environment package when storage cannot be read", async () => {
  const saved = [];
  const result = await performDiagExport({
    now: Date.UTC(2026, 9, 19, 6, 5, 4),
    env,
    request: async () => { throw new Error("storage"); },
    download: async (filename, text) => {
      saved.push({ filename, text });
      return true;
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.failure, false);
  assert.equal(result.code, "storage-unreadable");
  assert.equal(saved.length, 1);
  const json = JSON.parse(saved[0].text);
  assert.equal(json.extVersion, "1.2.3");
  assert.deepEqual(json.events, []);
  assert.match(saved[0].filename, /^open-immerse-diagnostics-1\.2\.3-\d{8}-\d{6}\.json$/);
});

test("performDiagExport reports download and serialize failures", async () => {
  const request = async () => buildDiagPackage({ events: [{ t: 1, type: "mm.error", code: "x" }], now: 1, env });
  const missed = await performDiagExport({
    request,
    download: async () => false
  });
  assert.equal(missed.ok, false);
  assert.equal(missed.code, "download-failed");
  assert.equal(missed.failure, true);
  assert.equal(describeDiagExportResult(missed, { count: 1, bytes: 8 }).text, "没能导出：文件没保存下来，检查一下下载设置或磁盘空间。");

  const thrown = await performDiagExport({
    request,
    download: async () => { throw Object.assign(new Error("cancel"), { name: "AbortError" }); }
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.cancelled, undefined);
  assert.equal(thrown.code, "download-failed");
  assert.equal(thrown.failure, true);
  assert.equal(describeDiagExportResult(thrown, { count: 1, bytes: 8 }).retry, true);

  const loop = {};
  loop.self = loop;
  assert.equal(serializeDiagPackage(loop).code, "serialize-failed");
  const packed = await performDiagExport({
    request: async () => ({ ok: false, code: "serialize-failed" }),
    download: async () => true
  });
  assert.equal(packed.code, "serialize-failed");
  assert.equal(packed.failure, true);
});
