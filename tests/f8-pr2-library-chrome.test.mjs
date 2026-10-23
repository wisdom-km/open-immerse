// Library side panel in headless Chrome. No external PDF fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const TMP_PREFIXES = ["oi-f8-pr2-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json"
};

function serveRepo(files) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (files.has(name)) {
      res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
      res.end(files.get(name));
      return;
    }
    const file = resolve(root, name);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(server));
  });
}

function launchChrome(userDataDir, scratchDir) {
  const child = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-pipe",
    "--force-device-scale-factor=1",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1680,1050",
    "--no-first-run",
    "--no-default-browser-check"
  ], {
    detached: true,
    env: { ...process.env, TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
  });
  child.stderr.on("data", () => {});
  child.stdio[3].on("error", () => {});
  child.stdio[4].on("error", () => {});
  return child;
}

class PipeCdp {
  constructor(writeStream, readStream) {
    this.writeStream = writeStream;
    this.readStream = readStream;
    this.buf = Buffer.alloc(0);
    this.next = 1;
    this.pending = new Map();
    readStream.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
  }

  drain() {
    let end = this.buf.indexOf(0);
    while (end >= 0) {
      const raw = this.buf.slice(0, end).toString("utf8");
      this.buf = this.buf.slice(end + 1);
      end = this.buf.indexOf(0);
      const message = JSON.parse(raw);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.done(message.result || {});
      }
    }
  }

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("cdp disposed"));
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const body = Buffer.from(`${JSON.stringify(payload)}\0`, "utf8");
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, { done, reject, timer });
      this.writeStream.write(body);
    });
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

const CHROME_STUB = `window.__oiBoot = "";
  window.addEventListener("error", (event) => { window.__oiBoot = String((event.error && event.error.stack) || event.message || "error"); });
  window.addEventListener("unhandledrejection", (event) => { window.__oiBoot = "reject " + String(event.reason && event.reason.stack || event.reason); });
  const bag = {};
  const storageArea = {
    get(key) {
      if (typeof key === "string") return Promise.resolve({ [key]: bag[key] });
      const out = {};
      for (const name of key || []) if (name in bag) out[name] = bag[name];
      return Promise.resolve(out);
    },
    set(entries) { Object.assign(bag, entries || {}); return Promise.resolve(); },
    remove(keys) { for (const key of keys || []) delete bag[key]; return Promise.resolve(); }
  };
  window.chrome = {
    runtime: { id: "oi-test", sendMessage() { return Promise.resolve({ ok: true, settings: { provider: "mymemory", pdfAutoTranslate: false, targetLang: "zh-CN" } }); }, onMessage: { addListener() {} }, getURL(path) { return path; } },
    storage: { local: storageArea, sync: storageArea, onChanged: { addListener() {} } },
    tabs: { getCurrent(cb) { if (cb) cb({ id: 1 }); } }
  };`;

test("文献库侧栏：开关、三种删除文案、网址变了、排序、窄屏和另一标签删除", { timeout: 180000 }, async (t) => {
  const server = await serveRepo(new Map());
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-f8-pr2-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const handle = { child: null, cdp: null };
  t.after(async () => {
    try {
      handle.cdp?.dispose();
    } finally {
      await cleanupChrome({ t, child: handle.child, server, ownedDir, userDataDir });
    }
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__oiBoot = "";
      window.addEventListener("error", (event) => { window.__oiBoot = String((event.error && event.error.stack) || event.message || "error"); });
      window.addEventListener("unhandledrejection", (event) => { window.__oiBoot = "reject " + String(event.reason && event.reason.stack || event.reason); });
      const bag = {};
      const storageArea = {
        get(key) {
          if (typeof key === "string") return Promise.resolve({ [key]: bag[key] });
          const out = {};
          for (const name of key || []) if (name in bag) out[name] = bag[name];
          return Promise.resolve(out);
        },
        set(entries) { Object.assign(bag, entries || {}); return Promise.resolve(); },
        remove(keys) { for (const key of keys || []) delete bag[key]; return Promise.resolve(); }
      };
      window.chrome = {
        runtime: { id: "oi-test", sendMessage() { return Promise.resolve({ ok: true, settings: { provider: "mymemory", pdfAutoTranslate: false, targetLang: "zh-CN" } }); }, onMessage: { addListener() {} }, getURL(path) { return path; } },
        storage: { local: storageArea, sync: storageArea, onChanged: { addListener() {} } },
        tabs: { getCurrent(cb) { if (cb) cb({ id: 1 }); } }
      };`
  }, sessionId);

  const evaluate = async (expression, id = sessionId) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, id);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(detail || JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  };
  const waitFor = async (expression, step, id = sessionId, timeoutMs = 20000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression, id);
      if (last) return last;
      await sleep(100);
    }
    const status = await evaluate(`document.getElementById("status")?.textContent || ""`, id).catch(() => "");
    const probe = await evaluate(`(() => {
      const panel = document.querySelector(".oi-library");
      return JSON.stringify({
        panel: Boolean(panel),
        hidden: panel ? panel.hidden : null,
        text: (panel?.textContent || "").slice(0, 180),
        slot: (document.getElementById("sideSlot")?.innerHTML || "").slice(0, 180),
        pressed: document.getElementById("libraryButton")?.getAttribute("aria-pressed") || "",
        boot: window.__oiBoot || "",
        queued: window.__oiLibraryBoot || ""
      });
    })()`, id).catch((error) => String(error));
    throw new Error(`${step} timed out. status=${status} last=${JSON.stringify(last)} probe=${probe}`);
  };

  await cdp.send("Page.navigate", { url: `${origin}/pdf/viewer.html` }, sessionId);
  const empty = JSON.parse(await waitFor(`(() => {
    const panel = document.querySelector(".oi-library");
    if (!panel || panel.hidden) return "";
    const copy = panel.textContent || "";
    if (!copy.includes("还没有论文")) return "";
    return JSON.stringify({
      pressed: document.getElementById("libraryButton")?.getAttribute("aria-pressed"),
      openPdf: panel.querySelector("[data-lib-empty-open]")?.textContent || "",
      href: panel.querySelector(".oi-lib-empty a")?.getAttribute("href") || "",
      soon: copy.includes("即将推出")
    });
  })()`, "空文献库", sessionId, 4000));
  assert.equal(empty.pressed, "true");
  assert.equal(empty.openPdf, "打开 PDF…");
  assert.equal(empty.href, "../options/options.html#data?focus=import");
  assert.equal(empty.soon, false);

  const toggled = JSON.parse(await evaluate(`(() => {
    const button = document.getElementById("libraryButton");
    const pages = document.getElementById("pages");
    const flow = document.getElementById("translateScroll");
    for (const el of [pages, flow]) {
      if (!el) continue;
      const filler = document.createElement("div");
      filler.style.height = "2400px";
      el.append(filler);
    }
    if (pages) pages.scrollTop = 40;
    if (flow) flow.scrollTop = 24;
    const beforePages = pages ? pages.scrollTop : -1;
    const beforeFlow = flow ? flow.scrollTop : -1;
    const pageMetrics = pages ? { h: pages.clientHeight, s: pages.scrollHeight, over: getComputedStyle(pages).overflowY } : null;
    button.click();
    const closed = document.querySelector(".oi-library")?.hidden === true;
    const focus = document.activeElement?.id || "";
    button.click();
    const opened = document.querySelector(".oi-library")?.hidden === false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
    const afterKey = document.querySelector(".oi-library")?.hidden === true;
    document.getElementById("menuLibrary").click();
    return JSON.stringify({
      closed,
      focus,
      opened,
      afterKey,
      menuOpen: document.querySelector(".oi-library")?.hidden === false,
      pages: pages ? pages.scrollTop : 0,
      flow: flow ? flow.scrollTop : 0,
      beforePages,
      beforeFlow,
      pageMetrics
    });
  })()`));
  assert.equal(toggled.closed, true);
  assert.equal(toggled.focus, "libraryButton");
  assert.equal(toggled.opened, true);
  assert.equal(toggled.afterKey, true);
  assert.equal(toggled.menuOpen, true);
  assert.equal(toggled.flow, toggled.beforeFlow);
  assert.equal(toggled.flow, 24);

  const seeded = JSON.parse(await evaluate(`(async () => {
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const store = sharedLibraryStore();
    const now = Date.now();
    const rows = [
      { docHash: "hash-none", title: "没有副本", sourceSize: 0, sourceUrl: "" },
      { docHash: "hash-url", title: "网上的", sourceSize: 2048, sourceUrl: "https://example.com/changed.pdf" },
      { docHash: "hash-local", title: "本地的", sourceSize: 4096, sourceUrl: "" }
    ];
    for (let n = 0; n < 5; n += 1) {
      rows.push({ docHash: "hash-extra-" + n, title: "补充 " + n, sourceSize: 1000 + n, sourceUrl: "" });
    }
    for (const row of rows) {
      await store.touchPaper(row.docHash, {
        title: row.title,
        pageCount: 2,
        opened: true,
        sourceSize: row.sourceSize,
        sourceUrl: row.sourceUrl || undefined,
        lastOpenedAt: now
      });
      await store.putPage(row.docHash, 1, { pairs: [{ text: "Hello", translation: "你好", targetLang: "zh-CN" }] });
      await store.putPage(row.docHash, 2, { pairs: [{ text: "World", translation: "世界", targetLang: "zh-CN" }] });
    }
    const panel = document.querySelector(".oi-library");
    const started = Date.now();
    while (Date.now() - started < 5000) {
      if ((panel.textContent || "").includes("没有副本") && (panel.textContent || "").includes("全文已译")) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    return JSON.stringify({
      copy: panel.textContent || "",
      search: panel.querySelector("input[type=search]") != null
    });
  })()`, sessionId));
  assert.match(seeded.copy, /没有副本/);
  assert.match(seeded.copy, /全文已译/);
  assert.match(seeded.copy, /约 /);
  assert.equal(seeded.search, true);
  assert.equal(seeded.copy.includes("PDF 阅读 ·"), false);

  const copies = JSON.parse(await evaluate(`(() => {
    const read = (hash) => {
      document.querySelector('[data-lib-row="' + hash + '"] .oi-lib-trash').click();
      const card = document.querySelector(".oi-lib-confirm")?.textContent || "";
      document.querySelector(".oi-lib-cancel").click();
      return card;
    };
    return JSON.stringify({
      none: read("hash-none"),
      url: read("hash-url"),
      local: read("hash-local")
    });
  })()`));
  assert.match(copies.none, /从文献库删除这篇？会删除：译文 2 页和版面缓存。再打开要重新翻译（会再次调用翻译服务）。不会删除：你电脑上的 PDF 文件。/);
  assert.equal(copies.none.includes("Open Immerse 保存的 PDF 副本"), false);
  assert.match(copies.url, /会删除：译文 2 页、版面缓存和 Open Immerse 保存的 PDF 副本。再打开要重新翻译（会再次调用翻译服务）。不会删除：你电脑上的 PDF 文件。/);
  assert.equal(copies.url.includes("下次打开要重新选一次 PDF 文件。"), false);
  assert.match(copies.local, /会删除：译文 2 页、版面缓存和 Open Immerse 保存的 PDF 副本。再打开要重新翻译（会再次调用翻译服务）。下次打开要重新选一次 PDF 文件。不会删除：你电脑上的 PDF 文件。/);

  const mismatch = JSON.parse(await evaluate(`(async () => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (String(url).includes("example.com/changed.pdf")) {
        return new Response(new Uint8Array([9, 9, 9, 9]), { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return original(input, init);
    };
    document.querySelector('[data-lib-row="hash-url"] .oi-lib-open').click();
    const started = Date.now();
    let hint = null;
    while (Date.now() - started < 5000) {
      hint = document.querySelector(".oi-lib-repick");
      if (hint) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    const muted = hint?.querySelector(".oi-lib-muted");
    const style = muted ? getComputedStyle(muted) : null;
    return JSON.stringify({
      first: hint?.querySelector("p")?.textContent || "",
      second: muted?.textContent || "",
      warn: hint?.querySelector(".oi-lib-warn")?.textContent || "",
      button: hint?.querySelector(".oi-lib-pick")?.textContent || "",
      fontSize: style?.fontSize || "",
      color: style?.color || ""
    });
  })()`));
  assert.equal(mismatch.first, "本机没有这篇的 PDF 副本，需要重新选一次文件。");
  assert.equal(mismatch.second, "网址上的 PDF 已经换了版本，和这篇的译文对不上。");
  assert.equal(mismatch.warn, "");
  assert.equal(mismatch.button, "选择文件…");
  assert.equal(mismatch.fontSize, "12px");

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 860,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId);
  await sleep(200);
  await evaluate(`window.dispatchEvent(new Event("resize"))`);
  await sleep(50);
  const narrow = JSON.parse(await evaluate(`(() => {
    const panel = document.querySelector(".oi-library");
    const back = panel?.querySelector(".oi-lib-back");
    const trash = panel?.querySelector(".oi-lib-trash");
    const open = panel?.querySelector(".oi-lib-open");
    return JSON.stringify({
      sheet: panel?.classList.contains("is-sheet") === true,
      back: back && back.hidden !== true ? back.textContent : "",
      trash: trash ? getComputedStyle(trash).whiteSpace : "",
      openH: open ? open.getBoundingClientRect().height : 0,
      label: trash?.getAttribute("aria-label") || "",
      width: window.innerWidth
    });
  })()`));
  assert.equal(narrow.sheet, true, JSON.stringify(narrow));
  assert.equal(narrow.back, "← 返回译文");
  assert.equal(narrow.trash, "nowrap");
  assert.ok(narrow.openH >= 28, JSON.stringify(narrow));
  assert.equal(narrow.label, "删除");

  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  await cdp.send("Page.navigate", { url: `${origin}/pdf/viewer.html#library?sort=size` }, sessionId);
  const sorted = JSON.parse(await waitFor(`(() => {
    if (!location.hash.includes("sort=size")) return "";
    if (document.querySelector(".oi-library")?.dataset.sort !== "size") return "";
    const names = [...document.querySelectorAll(".oi-lib-name")].map((node) => node.textContent);
    if (!names.includes("本地的")) return "";
    return JSON.stringify({ names, sort: document.querySelector(".oi-library")?.dataset.sort || "", hash: location.hash });
  })()`, "按大小排序"));
  assert.equal(sorted.names[0], "本地的", JSON.stringify(sorted));

  const { targetId: otherId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: otherSession } = await cdp.send("Target.attachToTarget", { targetId: otherId, flatten: true });
  await cdp.send("Page.enable", {}, otherSession);
  await cdp.send("Runtime.enable", {}, otherSession);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CHROME_STUB }, otherSession);
  await cdp.send("Page.navigate", { url: `${origin}/pdf/viewer.html#library` }, otherSession);
  await waitFor(`document.querySelector(".oi-library") ? "yes" : ""`, "另一标签打开文献库", otherSession, 15000);
  const otherCount = await evaluate(`(async () => {
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const { getPlatform } = await import("/lib/platform/index.js");
    const papers = await sharedLibraryStore().listPapers();
    const dbs = indexedDB.databases ? await indexedDB.databases() : [];
    return JSON.stringify({
      n: (papers || []).length,
      target: getPlatform().target,
      href: location.href,
      dbs: dbs.map((db) => db.name + "@" + db.version)
    });
  })()`, otherSession);
  const otherInfo = JSON.parse(otherCount);
  assert.equal(otherInfo.n > 0, true, JSON.stringify(otherInfo));
  await waitFor(`(() => {
    const names = [...document.querySelectorAll(".oi-lib-name")].map((node) => node.textContent);
    return names.includes("没有副本") ? "yes" : "";
  })()`, "另一标签看到文献", otherSession);
  await evaluate(`(async () => {
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const store = sharedLibraryStore();
    await store.deletePaperData("hash-none");
    return "deleted";
  })()`, otherSession);
  const gone = await waitFor(`(() => {
    const names = [...document.querySelectorAll(".oi-lib-name")].map((node) => node.textContent);
    return names.includes("没有副本") ? "" : "gone";
  })()`, "这一标签在一秒内去掉被删的行", sessionId, 5000);
  assert.equal(gone, "gone");

});

test("文献库三行只有一个 Tab 停留点，Enter 和 Delete 作用在焦点所在行", { timeout: 180000 }, async (t) => {
  const server = await serveRepo(new Map());
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-f8-pr2-keys-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const handle = { child: null, cdp: null };
  t.after(async () => {
    try {
      handle.cdp?.dispose();
    } finally {
      await cleanupChrome({ t, child: handle.child, server, ownedDir, userDataDir });
    }
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CHROME_STUB }, sessionId);
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(detail || JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  };
  const press = async (key, code, vk) => {
    const down = { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await cdp.send("Input.dispatchKeyEvent", down, sessionId);
    await cdp.send("Input.dispatchKeyEvent", { ...down, type: "keyUp" }, sessionId);
  };

  await cdp.send("Page.navigate", { url: `${origin}/pdf/viewer.html` }, sessionId);
  const ready = Date.now();
  let opened = false;
  while (Date.now() - ready < 20000) {
    opened = await evaluate(`document.querySelector(".oi-library")?.hidden === false`);
    if (opened) break;
    await sleep(50);
  }
  assert.equal(opened, true, await evaluate(`window.__oiBoot || "library did not open"`));

  await evaluate(`(async () => {
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const store = sharedLibraryStore();
    const rows = [
      { docHash: "hash-3", title: "第三篇" },
      { docHash: "hash-2", title: "第二篇" },
      { docHash: "hash-1", title: "第一篇" }
    ];
    for (const row of rows) {
      await store.touchPaper(row.docHash, { title: row.title, pageCount: 1, opened: true });
    }
    return rows.length;
  })()`);
  const listed = Date.now();
  let names = [];
  while (Date.now() - listed < 8000) {
    names = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll(".oi-lib-name")].map((node) => node.textContent))`));
    if (names.includes("第一篇") && names.includes("第三篇") && names.length === 3) break;
    await sleep(50);
  }
  assert.deepEqual(names, ["第一篇", "第二篇", "第三篇"]);

  const marked = JSON.parse(await evaluate(`(() => {
    const list = document.querySelector(".oi-lib-list");
    const nodes = [list, ...list.querySelectorAll("*")];
    const stops = nodes.filter((node) => node && !node.disabled && node.tabIndex >= 0);
    return JSON.stringify({
      stops: stops.length,
      role: list.getAttribute("role"),
      listTab: list.hasAttribute("tabindex"),
      options: list.querySelectorAll("[role='option']").length,
      listbox: document.querySelector("[role='listbox']") != null
    });
  })()`));
  assert.equal(marked.stops, 1, JSON.stringify(marked));
  assert.equal(marked.role, "group");
  assert.equal(marked.listTab, false);
  assert.equal(marked.options, 0);
  assert.equal(marked.listbox, false);

  await evaluate(`document.querySelector(".oi-lib-close").focus()`);
  const tabbed = [];
  for (let i = 0; i < 6; i += 1) {
    await press("Tab", "Tab", 9);
    const where = JSON.parse(await evaluate(`(() => {
      const el = document.activeElement;
      const list = document.querySelector(".oi-lib-list");
      return JSON.stringify({
        inList: Boolean(list && el && list.contains(el)),
        cls: el && el.className || "",
        hash: el && el.closest ? (el.closest("[data-lib-row]")?.getAttribute("data-lib-row") || "") : ""
      });
    })()`));
    if (!where.inList) break;
    tabbed.push(where);
  }
  assert.equal(tabbed.length, 1, JSON.stringify(tabbed));

  const openedHash = await evaluate(`(async () => {
    const button = document.querySelector('[data-lib-row="hash-3"] .oi-lib-open');
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const started = Date.now();
    while (Date.now() - started < 3000) {
      const hash = document.querySelector(".oi-lib-repick")?.closest("[data-lib-row]")?.getAttribute("data-lib-row") || "";
      if (hash) return hash;
      await new Promise((done) => setTimeout(done, 20));
    }
    return "";
  })()`);
  assert.equal(openedHash, "hash-3");

  const deleted = JSON.parse(await evaluate(`(() => {
    const button = document.querySelector('[data-lib-row="hash-3"] .oi-lib-open');
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    const row = document.querySelector(".oi-lib-confirm")?.closest("[data-lib-row]");
    return JSON.stringify({
      hash: row?.getAttribute("data-lib-row") || "",
      title: row?.querySelector(".oi-lib-name")?.textContent || ""
    });
  })()`));
  assert.equal(deleted.hash, "hash-3", JSON.stringify(deleted));
  assert.equal(deleted.title, "第三篇");

  const arrows = JSON.parse(await evaluate(`(async () => {
    document.querySelector(".oi-lib-cancel")?.click();
    const first = document.querySelector('[data-lib-row="hash-1"] .oi-lib-open');
    first.focus();
    const down = () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    down();
    down();
    const hash = document.activeElement?.closest?.("[data-lib-row]")?.getAttribute("data-lib-row") || "";
    document.querySelector(".oi-lib-repick")?.remove();
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const started = Date.now();
    let opened = "";
    while (Date.now() - started < 3000) {
      opened = document.querySelector(".oi-lib-repick")?.closest("[data-lib-row]")?.getAttribute("data-lib-row") || "";
      if (opened) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    return JSON.stringify({ hash, opened });
  })()`));
  assert.equal(arrows.hash, "hash-3", JSON.stringify(arrows));
  assert.equal(arrows.opened, "hash-3", JSON.stringify(arrows));

  const returned = JSON.parse(await evaluate(`(() => {
    document.querySelector(".oi-lib-close").click();
    const other = document.createElement("button");
    other.id = "otherFocus";
    document.body.append(other);
    other.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
    const opened = document.querySelector(".oi-library")?.hidden === false;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "l", bubbles: true }));
    const afterKey = document.activeElement?.id || "";
    document.getElementById("moreButton").click();
    document.getElementById("menuLibrary").click();
    const fromMenu = document.querySelector(".oi-library")?.hidden === false;
    document.querySelector(".oi-lib-close").click();
    return JSON.stringify({
      opened,
      afterKey,
      fromMenu,
      afterMenu: document.activeElement?.id || ""
    });
  })()`));
  assert.equal(returned.opened, true, JSON.stringify(returned));
  assert.equal(returned.afterKey, "libraryButton", JSON.stringify(returned));
  assert.equal(returned.fromMenu, true, JSON.stringify(returned));
  assert.equal(returned.afterMenu, "libraryButton", JSON.stringify(returned));
});
