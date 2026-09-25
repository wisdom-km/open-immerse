/**
 * Headless Chrome harness for the M0 vector-formula spike.
 * Downloads the two arXiv PDFs when missing, checks SHA-256, and does not
 * write those PDFs into the repository.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(join(root, "tests/fixtures/m0-corpus.json"), "utf8"));
const pdfDir = "/tmp/m0-pdfs";
const artifactDir = "/opt/cursor/artifacts/m0";
const resultPath = "/tmp/m0-result.json";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml"
};

async function ensurePdfs() {
  mkdirSync(pdfDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  for (const doc of corpus.documents) {
    const file = join(pdfDir, `${doc.id}.pdf`);
    if (!existsSync(file)) {
      const response = await fetch(doc.url, { headers: { "user-agent": "OpenImmerseM0/1.0" } });
      if (!response.ok) throw new Error(`download ${doc.id} failed: ${response.status}`);
      writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (hash !== doc.sha256) throw new Error(`${doc.id} sha256 ${hash} != ${doc.sha256}`);
    console.log(`${doc.id} ${hash}`);
  }
}

function startServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/__result__") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        writeFileSync(resultPath, Buffer.concat(chunks));
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/__sheet__") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const name = String(body.name || "sheet.png").replace(/[^a-zA-Z0-9._-]/g, "_");
        const png = String(body.png || "").replace(/^data:image\/png;base64,/, "");
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(join(artifactDir, name), Buffer.from(png, "base64"));
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (url.pathname.startsWith("/__pdf__/")) {
      const name = url.pathname.slice("/__pdf__/".length);
      if (name.includes("/") || name.includes("..")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const file = join(pdfDir, name);
      if (!existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(readFileSync(file));
      return;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (rel.includes("..")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => {
      resolve({
        ws,
        on: (listener) => listeners.push(listener),
        send(method, params = {}) {
          const msgId = ++id;
          return new Promise((ok, fail) => {
            pending.set(msgId, { resolve: ok, reject: fail });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        }
      });
    });
    ws.addEventListener("error", () => reject(new Error("chrome websocket failed")));
  });
}

async function runChrome(port, url) {
  rmSync(resultPath, { force: true });
  const profile = `/tmp/m0-chrome-${process.pid}`;
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profile}`,
    "about:blank"
  ], { stdio: "ignore" });
  try {
    let version = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!version) throw new Error("chrome did not open a debugging port");
    const browser = await cdp(version.webSocketDebuggerUrl);
    const { targetId } = await browser.send("Target.createTarget", { url });
    let page = null;
    for (let attempt = 0; attempt < 40 && !page?.webSocketDebuggerUrl; attempt += 1) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      page = targets.find((target) => target.id === targetId);
      if (!page?.webSocketDebuggerUrl) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!page?.webSocketDebuggerUrl) throw new Error("no page target");
    const session = await cdp(page.webSocketDebuggerUrl);
    session.on((message) => {
      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
        if (text) console.log("page:", text);
      }
      if (message.method === "Runtime.exceptionThrown") {
        console.log("page exception:", message.params.exceptionDetails?.text, message.params.exceptionDetails?.exception?.description);
      }
    });
    await session.send("Runtime.enable");
    const deadline = Date.now() + 420000;
    while (Date.now() < deadline) {
      if (existsSync(resultPath)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!existsSync(resultPath)) throw new Error("harness timed out");
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } finally {
    chrome.kill("SIGKILL");
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still be releasing the profile */ }
  }
}

await ensurePdfs();
const server = await startServer();
const address = server.address();
const debug = process.argv.includes("--debug");
const watch = process.argv.includes("--watch");
const query = debug ? "?debug=1" : watch ? "?watch=1" : "";
const url = `http://127.0.0.1:${address.port}/scripts/m0-vector-harness.html${query}`;
console.log(url);
try {
  const result = await runChrome(9333, url);
  writeFileSync(join(artifactDir, "m0-result.json"), JSON.stringify(result, null, 2));
  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  } else {
    const gates = result.cases.filter((row) => String(row.gate || "").startsWith("G-") || ["p4-b6", "p4-b14", "p4-b19", "p3-b16"].includes(row.id));
    console.log(`cases ${result.cases.length} reported rows ${gates.length}`);
    for (const row of gates) {
      console.log(`${row.gate || "report"} ${row.label} ${row.id} z${row.zoom} missing ${row.missing}/${row.missingSolid} oob ${row.outOfBounds}/${row.outOfBoundsSolid} outlineOob ${row.outlineOutOfBounds}/${row.outlineOutOfBoundsSolid} svgOut ${row.svgVsOutlineMissing} body ${row.bodyGlyphs} rules ${JSON.stringify(row.rules)}`);
    }
    for (const page of result.pages) {
      console.log(`page ${page.label} p${page.page} record ${page.recordMs}ms build ${page.buildMs}ms svg ${page.svgBytes} unsupported ${JSON.stringify(page.unsupported)}`);
    }
  }
} finally {
  server.close();
}
