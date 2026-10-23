// Opening pdf/viewer.html with no ?src= must survive init() and still render
// a page after the local file input changes. The with-src suite never hits
// the synchronous tail of init(), so it missed the TDZ abort at that call.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const PREFIXES = ["oi-open-local-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(root, "tests/fixtures/sample-m1.pdf");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function serveRepo() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
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
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

function launchChrome(userDataDir, scratchDir) {
  const child = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-pipe",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1280,800",
    "--force-device-scale-factor=1",
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

  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const body = Buffer.from(`${JSON.stringify(payload)}\0`, "utf8");
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { done, reject, timer });
      this.writeStream.write(body);
    });
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

const PAGE_ERRORS = `(() => globalThis.__oiPageErrors || [])()`;
const PAINTED = `(() => {
  const canvas = document.querySelector("#pages .pdf-page canvas");
  if (!canvas || canvas.hidden) return null;
  if (!(canvas.width > 0) || !(canvas.height > 0)) return null;
  const pages = document.querySelectorAll("#pages .pdf-page").length;
  if (!(pages >= 1)) return null;
  return {
    pages,
    width: canvas.width,
    height: canvas.height,
    title: document.title
  };
})()`;

test("viewer without src renders a local PDF and raises no pageerror", { timeout: 120000 }, async (t) => {
  assert.equal(existsSync(fixture), true, "tests/fixtures/sample-m1.pdf is missing");
  const handle = { child: null, cdp: null, server: null, ownedDir: null, userDataDir: null };
  t.after(async () => {
    try {
      handle.cdp?.dispose();
    } finally {
      await cleanupChrome({
        t,
        child: handle.child,
        server: handle.server,
        ownedDir: handle.ownedDir,
        userDataDir: handle.userDataDir
      });
    }
  });

  handle.server = await serveRepo();
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-open-local-"));
  rememberOwnedTemp(handle.ownedDir);
  const userDataDir = join(handle.ownedDir, "profile");
  const scratchDir = join(handle.ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  handle.userDataDir = userDataDir;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      globalThis.__oiPageErrors = [];
      globalThis.__oiFileChanges = 0;
      globalThis.addEventListener("error", (event) => {
        __oiPageErrors.push(String(event?.message || event?.error || "error"));
      });
      document.addEventListener("change", (event) => {
        if (event.target && event.target.id === "file") globalThis.__oiFileChanges += 1;
      }, true);
      globalThis.chrome = {
        storage: {
          local: {
            get() { return Promise.resolve({}); },
            set() { return Promise.resolve(); }
          },
          session: {
            get() { return Promise.resolve({}); },
            set() { return Promise.resolve(); }
          },
          onChanged: { addListener() {} }
        },
        runtime: {
          getURL() { return new URL("./vendor/pdf.worker.min.mjs", location.href).href; },
          sendMessage(message) {
            const type = message && message.type;
            if (type === "OI_GET_SETTINGS") {
              return Promise.resolve({
                settings: {
                  pdfAutoTranslate: false,
                  batchSize: 8,
                  targetLang: "zh-CN",
                  pdfLayout: { mode: "" },
                  features: { pdf: true }
                }
              });
            }
            if (type === "OI_PDF_STRUCTURE") return Promise.resolve({ ok: false });
            if (type === "OI_ENSURE_GLMOCR") return Promise.resolve({ ok: true });
            return Promise.resolve({ ok: true });
          },
          onMessage: { addListener() {} }
        }
      };
    })();`
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 30000);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };

  const origin = `http://127.0.0.1:${handle.server.address().port}`;
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html` });
  // The empty-status sentence is the HTML default, so it is visible before
  // init() runs. data-tb-bound is written synchronously inside init(); the
  // next CDP turn is after init() returns or throws, and the file listener
  // is attached before either of those.
  const opened = Date.now();
  let shell = null;
  while (Date.now() - opened < 15000) {
    shell = await evaluate(`(() => {
      const bar = document.querySelector(".toolbar");
      if (!bar || bar.dataset.tbBound !== "1") return null;
      return {
        search: location.search,
        errors: globalThis.__oiPageErrors || []
      };
    })()`);
    if (shell) break;
    await sleep(50);
  }
  assert.ok(shell, "viewer init did not finish");
  assert.equal(shell.search.includes("src="), false);

  const { root: doc } = await send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await send("DOM.querySelector", { nodeId: doc.nodeId, selector: "#file" });
  assert.ok(nodeId, "file input is missing");
  await send("DOM.setFileInputFiles", { nodeId, files: [fixture] });
  // setFileInputFiles may deliver change itself. Dispatch only if the
  // product listener has not already consumed the File.
  const picked = await evaluate(`(() => {
    const input = document.getElementById("file");
    const file = input && input.files && input.files[0];
    if (file) input.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      changes: globalThis.__oiFileChanges || 0,
      cleared: input.files.length === 0
    };
  })()`);
  assert.ok(picked?.changes >= 1, "choosing a local PDF did not fire change on #file");
  assert.equal(picked.cleared, true, "file change listener did not run");

  const started = Date.now();
  let painted = null;
  let errors = shell.errors;
  while (Date.now() - started < 20000) {
    errors = await evaluate(PAGE_ERRORS);
    if (errors?.length) break;
    painted = await evaluate(PAINTED);
    if (painted) break;
    await sleep(100);
  }
  assert.deepEqual(errors, [], `pageerror: ${JSON.stringify(errors)}`);
  assert.ok(painted, "local PDF did not paint a page canvas");
  assert.ok(painted.pages >= 1);
  assert.ok(painted.width > 0 && painted.height > 0);
  assert.equal(painted.title.includes("sample-m1.pdf"), true);
});
