/**
 * Local diagnostic log. One service-worker writer, chrome.storage.local `diag.events`.
 * Fire-and-forget. Never throws. Never calls the network.
 */

import { resolveFeatures } from "./features.js";
import {
  DIAG_RAW_MAX,
  collectSecretValues,
  redactDiagEvent
} from "./diag-redact.js";
import { downloadBlob } from "./export.js";

export const DIAG_STORAGE_KEY = "diag.events";
export const DIAG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DIAG_BYTE_CAP = 2 * 1024 * 1024;
export const DIAG_DEBOUNCE_MS = 1000;
export const DIAG_CTX_CAP = 200;
export const DIAG_FUTURE_MS = 60_000;

export const DIAG_TEXT = Object.freeze({
  days: 7,
  include: "包含最近 7 天的运行记录、出错原因、版本和浏览器信息。",
  exclude: "已去掉 API 密钥、网址里的 token 和论文正文。不会自动上传，导出后由你决定发给谁。",
  empty: "最近 7 天没有记录",
  cleared: "已清空",
  packing: "正在打包…",
  exportLabel: "导出诊断包",
  unreadable: "暂时读不了日志，导出的包只含版本和环境信息。",
  serializeFailed: "没能导出：打包时出错。",
  downloadFailed: "没能导出：文件没保存下来，检查一下下载设置或磁盘空间。",
  retry: "再试一次",
  clearConfirm: "确定清空？",
  clear: "清空",
  cancel: "取消",
  clearTitle: "清空日志",
  clearNote: "删除本机保存的所有诊断记录。",
  exportTitle: "导出诊断包",
  group: "问题诊断"
});

export function diagByteLength(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(json).length;
  return json.length;
}

export function formatDiagSize(bytes) {
  const n = Math.max(0, Math.floor(Number(bytes) || 0));
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) {
    const kb = n / 1024;
    const text = kb >= 10 ? String(Math.round(kb)) : String(Math.round(kb * 10) / 10);
    return `${text} KB`;
  }
  const mb = n / (1024 * 1024);
  const text = mb >= 10 ? String(Math.round(mb)) : String(Math.round(mb * 10) / 10);
  return `${text} MB`;
}

export function diagRecordedLine(count, bytes) {
  return `已记录 ${count} 条 · 约 ${formatDiagSize(bytes)}`;
}

export function diagExportedLine(filename) {
  return `✓ 已导出 ${filename}`;
}

function eventJsonBytes(event) {
  return diagByteLength(event);
}

/**
 * Drop events older than 7 days, then drop the oldest until the JSON array is <= 2 MB.
 */
export function retainDiagEvents(events, now = Date.now(), { daysMs = DIAG_RETENTION_MS, cap = DIAG_BYTE_CAP, perCtx = DIAG_CTX_CAP } = {}) {
  const cutoff = now - daysMs;
  const future = now + DIAG_FUTURE_MS;
  const fresh = [];
  const byCtx = new Map();
  for (const event of events || []) {
    if (!event || typeof event !== "object") continue;
    const t = Number(event.t);
    if (!Number.isFinite(t) || t < cutoff || t > future) continue;
    const ctx = event.ctx || "content";
    const list = byCtx.get(ctx);
    if (list) list.push(event);
    else byCtx.set(ctx, [event]);
  }
  for (const list of byCtx.values()) {
    list.sort((a, b) => a.t - b.t);
    const kept = list.length > perCtx ? list.slice(list.length - perCtx) : list;
    fresh.push(...kept);
  }
  fresh.sort((a, b) => a.t - b.t);
  const sizes = fresh.map((event) => eventJsonBytes(event));
  let total = 2 + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, fresh.length - 1);
  while (fresh.length && total > cap) {
    const size = sizes.shift();
    fresh.shift();
    total -= size;
    if (fresh.length) total -= 1;
    else total = 2;
  }
  return fresh;
}

export function diagFilename(version, when = Date.now()) {
  const date = when instanceof Date ? when : new Date(when);
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const safe = String(version || "0").replace(/[^0-9A-Za-z._-]/g, "_");
  return `open-immerse-diagnostics-${safe}-${stamp}.json`;
}

export function summarizeSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  const flags = resolveFeatures(source);
  const features = {};
  for (const [key, value] of Object.entries(flags)) {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(key)) continue;
    features[key] = value === true;
  }
  const provider = String(source.provider || "");
  const providerIds = Object.keys(source.providers || {}).filter((id) => /^[A-Za-z0-9._-]{1,40}$/.test(id));
  return {
    provider: /^[A-Za-z0-9._-]{1,40}$/.test(provider) ? provider : "",
    providerIds,
    features
  };
}

export function readDiagEnvironment(nav = globalThis.navigator, manifestVersion = "") {
  const ua = nav?.userAgentData;
  let brand = "";
  let version = "";
  if (ua && Array.isArray(ua.brands)) {
    const primary = ua.brands.find((item) => item?.brand && !/not.?a.?brand/i.test(item.brand) && !/chromium/i.test(item.brand))
      || ua.brands[0];
    brand = String(primary?.brand || "");
    version = String(primary?.version || "");
  }
  if (!brand) {
    const agent = String(nav?.userAgent || "");
    const chrome = agent.match(/Chrome\/(\d+(?:\.\d+)*)/);
    const edge = agent.match(/Edg\/(\d+(?:\.\d+)*)/);
    const firefox = agent.match(/Firefox\/(\d+(?:\.\d+)*)/);
    if (edge) {
      brand = "Edge";
      version = edge[1];
    } else if (chrome) {
      brand = "Chrome";
      version = chrome[1];
    } else if (firefox) {
      brand = "Firefox";
      version = firefox[1];
    }
  }
  const fromManifest = manifestVersion || globalThis.chrome?.runtime?.getManifest?.()?.version || "";
  return {
    extVersion: String(fromManifest || ""),
    browser: {
      brand,
      version,
      platform: String(ua?.platform || nav?.platform || "")
    },
    locale: String(nav?.language || "")
  };
}

export function buildDiagPackage({ events = [], env = {}, now = Date.now(), settings = null, secrets = [], storageCode = "" } = {}) {
  const clock = Number(now) || Date.now();
  const readable = storageCode !== "storage-unreadable";
  const cleaned = readable
    ? retainDiagEvents((events || []).map((event) => redactDiagEvent(event, secrets, clock)).filter(Boolean), clock)
    : [];
  const environment = env.extVersion != null || env.browser ? env : readDiagEnvironment();
  const summary = settings ? summarizeSettings(settings) : summarizeSettings(env.settings || {});
  const code = !readable ? "storage-unreadable" : (cleaned.length ? "" : "no-records");
  return {
    ok: true,
    code,
    filename: diagFilename(environment.extVersion, clock),
    count: cleaned.length,
    bytes: diagByteLength(cleaned),
    package: {
      format: 1,
      exportedAt: new Date(clock).toISOString(),
      extVersion: String(environment.extVersion || ""),
      browser: environment.browser || { brand: "", version: "", platform: "" },
      locale: String(environment.locale || ""),
      settingsSummary: summary,
      events: cleaned
    }
  };
}

export function serializeDiagPackage(pkg) {
  try {
    const text = JSON.stringify(pkg, null, 2);
    if (typeof text !== "string" || !text) return { ok: false, code: "serialize-failed" };
    return { ok: true, text };
  } catch {
    return { ok: false, code: "serialize-failed" };
  }
}

export function anchorDownload(filename, text) {
  try {
    const blob = new Blob([text], { type: "application/json" });
    return downloadBlob(filename, blob) === true;
  } catch (err) {
    if (err?.name === "AbortError" || err?.code === "cancelled") return { cancelled: true };
    return false;
  }
}

export function describeDiagExportResult(result, view = {}) {
  const count = Math.max(0, Math.floor(Number(view.count) || 0));
  const bytes = Math.max(0, Math.floor(Number(view.bytes) || 0));
  if (result?.cancelled) {
    return {
      tone: "idle",
      failure: false,
      retry: false,
      text: count > 0 ? diagRecordedLine(count, bytes) : DIAG_TEXT.empty
    };
  }
  if (result?.code === "serialize-failed") {
    return { tone: "warn", failure: true, retry: true, text: DIAG_TEXT.serializeFailed };
  }
  if (result?.code === "download-failed") {
    return { tone: "warn", failure: true, retry: true, text: DIAG_TEXT.downloadFailed };
  }
  if (result?.code === "storage-unreadable") {
    return { tone: "warn", failure: false, retry: false, text: DIAG_TEXT.unreadable };
  }
  if (result?.code === "no-records" || !(Number(result?.count) > 0)) {
    return { tone: "idle", failure: false, retry: false, text: DIAG_TEXT.empty };
  }
  return { tone: "ok", failure: false, retry: false, text: diagExportedLine(result.filename || "") };
}

function inferCtx() {
  try {
    if (typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope) return "sw";
    const href = String(globalThis.location?.href || "");
    if (href.includes("/options/")) return "options";
    if (href.includes("/pdf/")) return "viewer";
  } catch {
    /* location can throw in a torn-down document */
  }
  return "content";
}

function stampEvent(type, fields) {
  const source = fields && typeof fields === "object" ? fields : {};
  return {
    ...source,
    type: String(type || source.type || ""),
    t: Date.now(),
    ctx: source.ctx || inferCtx()
  };
}

function clipRaw(value, max) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) : text;
}

let activeWriter = null;
let swWriter = null;
let boundStorage = null;
const earlyQueue = [];

export function installDiagWriter(writer) {
  activeWriter = writer || null;
  if (!activeWriter || !earlyQueue.length) return;
  const queued = earlyQueue.splice(0);
  for (const event of queued) {
    try { activeWriter.log(event); } catch { /* never throw */ }
  }
}

export function createDiagWriter({
  storage,
  sync,
  now = () => Date.now(),
  debounceMs = DIAG_DEBOUNCE_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id)
} = {}) {
  let buffer = [];
  let timer = null;
  let chain = Promise.resolve();

  function enqueue(job) {
    const run = chain.then(job, job);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readEvents() {
    const bag = await storage.get(DIAG_STORAGE_KEY);
    const events = bag?.[DIAG_STORAGE_KEY];
    return Array.isArray(events) ? events : [];
  }

  async function readSecrets() {
    const found = new Set();
    const take = (bag) => {
      for (const value of collectSecretValues(bag || {})) found.add(value);
    };
    try {
      take(await storage.get(null));
    } catch {
      /* local secrets stay empty; events can still be exported */
    }
    if (sync && typeof sync.get === "function") {
      try {
        take(await sync.get(null));
      } catch {
        /* legacy sync keys are skipped when sync cannot be read */
      }
    }
    return [...found];
  }

  async function readSettings() {
    if (!sync || typeof sync.get !== "function") return {};
    try {
      const bag = await sync.get("settings");
      return bag?.settings && typeof bag.settings === "object" ? bag.settings : {};
    } catch {
      return {};
    }
  }

  async function append(batch) {
    if (!batch.length) return;
    const secrets = await readSecrets();
    const clock = now();
    const stamped = batch.map((item) => redactDiagEvent(item, secrets, clock)).filter(Boolean);
    const current = await readEvents();
    const next = retainDiagEvents(current.concat(stamped), clock);
    await storage.set({ [DIAG_STORAGE_KEY]: next });
  }

  function flushSoon() {
    if (timer != null || debounceMs < 0) return;
    timer = schedule(() => {
      timer = null;
      const batch = buffer.splice(0);
      enqueue(() => append(batch)).catch(() => {});
    }, debounceMs);
  }

  return {
    log(event) {
      try {
        // Allow-list immediately so text/title/translation/note/answer never sit in the buffer.
        // The writer stamps time. Caller timestamps are ignored.
        // Raw text is clipped before any scrub regex runs.
        const clock = now();
        const safe = redactDiagEvent({ ...event, t: clock }, [], clock);
        if (!safe) return;
        const pending = { t: clock, type: safe.type };
        if (safe.ctx) pending.ctx = safe.ctx;
        if (event?.code != null) pending.code = clipRaw(event.code, 256);
        if (event?.msg != null) pending.msg = clipRaw(event.msg, DIAG_RAW_MAX);
        if (event?.provider != null) pending.provider = clipRaw(event.provider, 80);
        if (event?.page != null) pending.page = event.page;
        if (event?.count != null) pending.count = event.count;
        if (event?.ms != null) pending.ms = event.ms;
        if (event?.ver != null) pending.ver = clipRaw(event.ver, 80);
        if (typeof event?.ok === "boolean") pending.ok = event.ok;
        if (event?.reason != null) pending.reason = clipRaw(event.reason, 80);
        const ctx = pending.ctx || "content";
        let seen = 0;
        for (const item of buffer) if ((item.ctx || "content") === ctx) seen += 1;
        if (seen >= DIAG_CTX_CAP) {
          const idx = buffer.findIndex((item) => (item.ctx || "content") === ctx);
          if (idx >= 0) buffer.splice(idx, 1);
        }
        buffer.push(pending);
        flushSoon();
      } catch {
        /* diag is best-effort */
      }
    },
    flush() {
      if (timer != null) {
        cancel(timer);
        timer = null;
      }
      const batch = buffer.splice(0);
      return enqueue(() => append(batch));
    },
    clear() {
      if (timer != null) {
        cancel(timer);
        timer = null;
      }
      buffer = [];
      return enqueue(async () => {
        // Events logged after clear() was requested stay in the buffer for the next flush.
        await storage.set({ [DIAG_STORAGE_KEY]: [] });
      });
    },
    async stats() {
      try {
        await this.flush();
      } catch {
        /* a failed write still leaves the previous log readable */
      }
      try {
        const events = retainDiagEvents(await readEvents(), now());
        const bytes = diagByteLength(events);
        return {
          ok: true,
          count: events.length,
          bytes,
          code: events.length ? "" : "no-records"
        };
      } catch {
        return { ok: true, count: 0, bytes: 0, code: "storage-unreadable" };
      }
    },
    async exportPackage(env) {
      let storageCode = "";
      let events = [];
      let secrets = [];
      let settings = {};
      try {
        await this.flush();
      } catch {
        /* quota on set must not hide events storage.get can still return */
      }
      try {
        events = await readEvents();
        secrets = await readSecrets();
        settings = await readSettings();
      } catch {
        storageCode = "storage-unreadable";
        events = [];
      }
      const clock = now();
      return buildDiagPackage({
        events,
        secrets,
        settings,
        now: clock,
        storageCode,
        env: env || readDiagEnvironment()
      });
    },
    dispose() {
      if (timer != null) {
        cancel(timer);
        timer = null;
      }
      buffer = [];
    }
  };
}

export function installServiceWorkerDiag(deps = {}) {
  const storage = deps.storage || globalThis.chrome?.storage?.local;
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") return null;
  if (swWriter && boundStorage === storage && !deps.force) return swWriter;
  try { swWriter?.dispose?.(); } catch { /* ignore */ }
  boundStorage = storage;
  swWriter = createDiagWriter({
    storage,
    sync: deps.sync || globalThis.chrome?.storage?.sync,
    now: deps.now,
    debounceMs: deps.debounceMs
  });
  installDiagWriter(swWriter);
  return swWriter;
}

export function resetDiagForTests() {
  try { swWriter?.dispose?.(); } catch { /* ignore */ }
  swWriter = null;
  boundStorage = null;
  activeWriter = null;
  earlyQueue.length = 0;
}

function inServiceWorker() {
  return typeof ServiceWorkerGlobalScope !== "undefined" && globalThis instanceof ServiceWorkerGlobalScope;
}

export function diagLog(type, fields) {
  try {
    const event = stampEvent(type, fields);
    if (activeWriter) {
      activeWriter.log(event);
      return;
    }
    if (inServiceWorker()) {
      const writer = installServiceWorkerDiag();
      if (writer) {
        writer.log(event);
        return;
      }
      if (earlyQueue.length < DIAG_CTX_CAP) earlyQueue.push(event);
      return;
    }
    const runtime = globalThis.chrome?.runtime;
    if (!runtime || typeof runtime.sendMessage !== "function") return;
    Promise.resolve()
      .then(() => runtime.sendMessage({ type: "OI_DIAG_LOG", event }))
      .catch(() => {});
  } catch {
    /* never throw */
  }
}

export function noteTranslateFailure(err, fields = {}) {
  const status = Number(err?.httpStatus || err?.status);
  const code = Number.isFinite(status) && status > 0
    ? String(status)
    : String(err?.code || err?.name || "error");
  diagLog("translate.error", {
    ctx: "sw",
    provider: fields.provider || "",
    code,
    count: Number(fields.count) || 0
  });
}

export function noteViewerNetwork(online) {
  const up = online !== false;
  diagLog(up ? "net.online" : "net.offline", {
    ctx: "viewer",
    code: up ? "online" : "offline"
  });
}

export function allowDiagMessage(message, sender) {
  const type = String(message?.type || "");
  const mutate = type === "OI_DIAG_EXPORT" || type === "OI_DIAG_CLEAR" || type === "OI_DIAG_STATS";
  const write = type === "OI_DIAG_LOG";
  if (!mutate && !write) return true;
  if (!sender) return true;
  const runtimeId = String(globalThis.chrome?.runtime?.id || "");
  if (!runtimeId || sender.id !== runtimeId) return false;
  const url = String(sender.url || "");
  const extensionPage = url.startsWith(`chrome-extension://${runtimeId}/`);
  if (mutate) return extensionPage && url.includes("/options/");
  if (sender.tab && !extensionPage) return false;
  return extensionPage || (!sender.tab && !url);
}

export function ctxFromDiagSender(sender) {
  if (!sender) return "";
  const url = String(sender.url || "");
  if (url.includes("/options/")) return "options";
  if (url.includes("/pdf/")) return "viewer";
  if (sender.tab) return "content";
  return "sw";
}

export async function handleDiagMessage(message, deps = {}) {
  try {
    const sender = deps.sender || null;
    if (!allowDiagMessage(message, sender)) return { ok: false };
    const writer = deps.writer || installServiceWorkerDiag(deps);
    if (!writer) return { ok: false, code: "storage-unreadable" };
    if (message?.type === "OI_DIAG_LOG") {
      const event = { ...(message.event || {}) };
      delete event.t;
      const forced = ctxFromDiagSender(sender);
      if (forced) event.ctx = forced;
      writer.log(event);
      return { ok: true };
    }
    if (message?.type === "OI_DIAG_CLEAR") {
      await writer.clear();
      return { ok: true, count: 0, bytes: 0, code: "no-records" };
    }
    if (message?.type === "OI_DIAG_STATS") return writer.stats();
    if (message?.type === "OI_DIAG_EXPORT") return writer.exportPackage(deps.env || readDiagEnvironment());
    return { ok: false };
  } catch {
    return { ok: false, code: "storage-unreadable" };
  }
}

export async function performDiagExport(deps = {}) {
  const request = deps.request || ((message) => globalThis.chrome.runtime.sendMessage(message));
  const download = deps.download || ((filename, text) => anchorDownload(filename, text));
  const clock = deps.now || Date.now();
  let response = null;
  try {
    response = await request({ type: "OI_DIAG_EXPORT" });
  } catch {
    response = null;
  }
  if (!response || (response.ok === false && !response.package && response.code !== "serialize-failed")) {
    const env = deps.env || readDiagEnvironment();
    response = buildDiagPackage({ events: [], now: clock, storageCode: "storage-unreadable", env });
  }
  if (response.code === "serialize-failed" || !response.package) {
    return { ok: false, code: "serialize-failed", failure: true };
  }
  const serialized = serializeDiagPackage(response.package);
  if (!serialized.ok) return { ok: false, code: "serialize-failed", failure: true };
  let saved;
  try {
    saved = await download(response.filename, serialized.text);
  } catch (err) {
    if (err?.name === "AbortError" || err?.code === "cancelled") {
      return { ok: true, cancelled: true, code: response.code || "", filename: response.filename };
    }
    return { ok: false, code: "download-failed", failure: true };
  }
  if (saved && saved.cancelled) {
    return { ok: true, cancelled: true, code: response.code || "", filename: response.filename, count: response.count || 0 };
  }
  if (saved === false || (saved && saved.ok === false)) {
    return { ok: false, code: "download-failed", failure: true };
  }
  return {
    ok: true,
    failure: false,
    code: response.code || "",
    filename: response.filename,
    count: response.count || response.package.events?.length || 0,
    bytes: response.bytes || 0
  };
}
