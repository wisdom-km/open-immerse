// The hash can be known before that document's hint key has been read.
// Opening the panel in that gap must not paint a hint that was already dismissed.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const TMP_PREFIXES = ["oi-notes-hint-gap-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/pdf/reader-tokens.css">
<link rel="stylesheet" href="/pdf/notes-panel.css">
</head>
<body class="oi-reader-app">
  <div class="workspace" data-source-mode="side">
    <div id="sideSlot" style="width:400px;height:560px;display:flex"></div>
  </div>
  <div class="reader-flow" id="flow"></div>
  <script type="module">
    import { mountNotesUi } from "/pdf/notes-panel.js";
    import { createNotesPrefsSession, NOTES_HINT_DOC_PREFIX } from "/lib/reader-notes-local.js";
    import { persistHintDismissed } from "/lib/notes-prefs.js";
    const hash = "doc-gap";
    const hintKey = NOTES_HINT_DOC_PREFIX + hash;
    let releaseGet = () => {};
    const gate = new Promise((done) => { releaseGet = done; });
    const area = {
      data: {
        "reader.notesPersistHintDismissed": JSON.stringify({ seed: true }),
        [hintKey]: true
      },
      async get(keys) {
        const out = {};
        const list = keys == null ? Object.keys(this.data) : [].concat(keys);
        for (const key of list) {
          if (Object.prototype.hasOwnProperty.call(this.data, key)) out[key] = this.data[key];
        }
        return out;
      },
      async set(items) { Object.assign(this.data, items); }
    };
    const session = createNotesPrefsSession({
      webStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
      localArea: area
    });
    try {
      await session.prime();
      let perDocGets = 0;
      const rawGet = area.get.bind(area);
      area.get = async (keys) => {
        const list = keys == null ? [] : [].concat(keys);
        if (list.some((key) => String(key).startsWith(NOTES_HINT_DOC_PREFIX))) {
          perDocGets += 1;
          await gate;
        }
        return rawGet(keys);
      };
      const saw = { banner: false };
      const watch = new MutationObserver(() => {
        if (document.querySelector(".oi-notes-banner-line")) saw.banner = true;
      });
      watch.observe(document.body, { childList: true, subtree: true });
      const readerLoad = session.loadDocHint(hash);
      let hideDismissed = false;
      const ui = mountNotesUi({
        hasDoc: () => true,
        docHash: () => hash,
        list: async () => [],
        listTrash: async () => [],
        readPrefs: () => session.read(),
        persistDenied: async () => true,
        persistDismissed: (id) => hideDismissed ? false : persistHintDismissed(session.read(), id),
        loadDocHint: (id) => session.loadDocHint(id),
        put: async (note) => note,
        subscribe: () => () => {},
        onOpenChange: () => {},
        flow: () => document.getElementById("flow"),
        pane: () => document.getElementById("flow"),
        pointerFine: () => true,
        blockOrder: () => new Map(),
        currentParagraph: () => null
      });
      ui.open(false);
      await new Promise((done) => setTimeout(done, 250));
      const during = {
        phase: "during",
        banner: Boolean(document.querySelector(".oi-notes-banner-line")) || saw.banner,
        gets: perDocGets,
        dismissed: persistHintDismissed(session.read(), hash)
      };
      window.__during = during;
      window.__release = () => releaseGet();
      await readerLoad;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      window.__after = {
        phase: "after",
        banner: Boolean(document.querySelector(".oi-notes-banner-line")) || saw.banner,
        gets: perDocGets,
        dismissed: persistHintDismissed(session.read(), hash)
      };
      const waitBanner = (present) => new Promise((done) => {
        const started = Date.now();
        const tick = () => {
          const shown = Boolean(document.querySelector(".oi-notes-banner-line"));
          if (shown === present || Date.now() - started > 2000) done(shown);
          else requestAnimationFrame(tick);
        };
        tick();
      });
      hideDismissed = true;
      ui.refresh();
      const shown = await waitBanner(true);
      hideDismissed = false;
      ui.refresh();
      const stillShown = await waitBanner(false);
      window.__cleared = { shown, stillShown };
    } catch (error) {
      window.__during = { phase: "error", message: String(error && error.stack || error) };
      window.__after = window.__during;
    }
  </script>
</body>
</html>`;

function serveRepo() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/hint-gap.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = resolve(root, rel);
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
    "--window-size=1280,800",
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
    while (this.buf.length) {
      const end = this.buf.indexOf(0);
      if (end < 0) return;
      const text = this.buf.subarray(0, end).toString("utf8");
      this.buf = this.buf.subarray(end + 1);
      if (!text) continue;
      const message = JSON.parse(text);
      if (message.id && this.pending.has(message.id)) {
        const { done, reject, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else done(message.result);
      }
    }
  }

  dispose() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
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

test("a dismissed persist hint stays hidden while its key is still loading", { timeout: 60000 }, async (t) => {
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-notes-hint-gap-"));
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
  await cdp.send("Page.navigate", { url: `${origin}/hint-gap.html` }, sessionId);

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

  const waitFor = async (expression, label) => {
    const started = Date.now();
    let last = "";
    while (Date.now() - started < 8000) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(40);
    }
    throw new Error(`${label} timed out: ${last}`);
  };

  const during = JSON.parse(await waitFor(
    `window.__during ? JSON.stringify(window.__during) : ""`,
    "gap sample"
  ));
  assert.equal(during.phase, "during", during.message || JSON.stringify(during));
  assert.equal(during.banner, false, JSON.stringify(during));
  assert.equal(during.dismissed, false);
  assert.equal(during.gets, 1);

  await evaluate(`window.__release()`);
  const after = JSON.parse(await waitFor(
    `window.__after ? JSON.stringify(window.__after) : ""`,
    "hint read"
  ));
  assert.equal(after.phase, "after", after.message || JSON.stringify(after));
  assert.equal(after.dismissed, true);
  assert.equal(after.banner, false, JSON.stringify(after));
  assert.equal(after.gets, 1);

  const cleared = JSON.parse(await waitFor(
    `window.__cleared ? JSON.stringify(window.__cleared) : ""`,
    "banner repaint"
  ));
  assert.equal(cleared.shown, true, JSON.stringify(cleared));
  assert.equal(cleared.stillShown, false, JSON.stringify(cleared));
});
