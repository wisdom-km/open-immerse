// Short inline crops must sit on the body baseline after ink trim.
// Aa 14, DPR 1 and DPR 2. The PDF fixtures are gitignored.
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

const PREFIXES = ["oi-formula-baseline-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
const DPO_REL = "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf";
const DDPM_REL = "tests/fixtures/DDPM_2006.11239.pdf";
const DPO_SKIP = `${DPO_REL} is gitignored and is not committed. Fetch it with scripts/ci/fetch-fixtures.sh (arXiv 2305.18290v3).`;
const DDPM_SKIP = `${DDPM_REL} is gitignored and is not committed. scripts/ci/fetch-fixtures.sh leaves tests/fixtures/DDPM_2006.11239.pdf absent on purpose.`;

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
    "--window-size=1440,900",
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

  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const body = Buffer.from(`${JSON.stringify(payload)}\0`, "utf8");
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
      this.pending.set(id, { done, reject, timer });
      this.writeStream.write(body);
    });
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

const CHROME_STUB = `(() => {
  try { localStorage.setItem("reader.fontSize", "14"); } catch (error) {}
  globalThis.chrome = {
    storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } },
    runtime: {
      getURL() { return new URL("./vendor/pdf.worker.min.mjs", location.href).href; },
      sendMessage(message) {
        const type = message && message.type;
        if (type === "OI_GET_SETTINGS") {
          return Promise.resolve({ settings: { pdfAutoTranslate: false, batchSize: 8, targetLang: "zh-CN", provider: "mymemory", pdfLayout: { mode: "" }, features: { pdf: true } } });
        }
        if (type === "OI_PDF_STRUCTURE") return Promise.resolve({ ok: false });
        if (type === "OI_ENSURE_GLMOCR") return Promise.resolve({ ok: true });
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener() {} }
    }
  };
})();`;

function measureExpression(ids) {
  return `(() => {
    const ids = ${JSON.stringify(ids)};
    const paper = 246;
    const rows = [];
    for (const id of ids) {
      const span = document.querySelector(${JSON.stringify("#readerFlow .oi-pdf-inline-math.is-matched")} + "[data-block-id=\\"" + id + "\\"]");
      const img = span ? span.querySelector(":scope > img.oi-pdf-math-crop") : null;
      if (!span || !img || !img.complete || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) {
        rows.push({ id, pending: true });
        continue;
      }
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;overflow:hidden;vertical-align:baseline;font-size:0;line-height:0;padding:0;margin:0;border:0;";
      const parent = span.parentElement;
      const box = span.getBoundingClientRect();
      const samples = [];
      parent.insertBefore(probe, span);
      samples.push(probe.getBoundingClientRect().bottom);
      parent.insertBefore(probe, span.nextSibling);
      samples.push(probe.getBoundingClientRect().bottom);
      probe.remove();
      const mid = (box.top + box.bottom) / 2;
      samples.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
      const baseline = samples[0];
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let inkRow = -1;
      for (let y = canvas.height - 1; y >= 0; y -= 1) {
        const row = y * canvas.width * 4;
        let ink = false;
        for (let x = 0; x < canvas.width; x += 1) {
          const index = row + x * 4;
          if (data[index + 3] < 16) continue;
          if (data[index] >= paper && data[index + 1] >= paper && data[index + 2] >= paper) continue;
          ink = true;
          break;
        }
        if (ink) {
          inkRow = y;
          break;
        }
      }
      const imgBox = img.getBoundingClientRect();
      const imgStyle = getComputedStyle(img);
      const inkBottom = inkRow < 0 ? null : imgBox.top + ((inkRow + 1) / img.naturalHeight) * imgBox.height;
      rows.push({
        id,
        pending: false,
        delta: inkBottom == null ? null : inkBottom - baseline,
        display: imgStyle.display,
        baselineVar: span.style.getPropertyValue("--oi-reader-formula-baseline")
      });
    }
    const root = document.querySelector(".oi-reader") || document.documentElement;
    return {
      dpr: window.devicePixelRatio,
      font: getComputedStyle(root).getPropertyValue("--oi-reader-font-size").trim(),
      rows
    };
  })()`;
}

function selectIds(sources, picks) {
  const inline = (sources || []).filter((row) => row.inline);
  const chosen = [];
  const missing = [];
  for (const pick of picks) {
    const hits = inline.filter((row) => pick.test(String(row.sourceText || "")));
    if (!hits.length) missing.push(pick.name);
    for (const hit of hits) chosen.push({ ...hit, pick: pick.name });
  }
  return { chosen, missing, inline };
}

async function openAndMeasure(session, spec, dpr) {
  const { send, evaluate, origin } = session;
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: dpr,
    mobile: false
  });
  const src = `${origin}/${spec.rel}`;
  await send("Page.navigate", {
    url: `${origin}/pdf/viewer.html?oiAuto=formula-baseline&oiDpr=${dpr}&src=${encodeURIComponent(src)}`
  });
  const opened = Date.now();
  let pager = "";
  while (Date.now() - opened < 90000) {
    pager = await evaluate(`document.getElementById("sourcePageLabel")?.textContent || ""`);
    if (/\/\s*\d+/.test(String(pager || ""))) break;
    await sleep(200);
  }
  assert.match(String(pager || ""), /\/\s*\d+/, `${spec.name} did not open`);
  let openedBlocks = 0;
  const openBy = Date.now() + 120000;
  while (Date.now() < openBy) {
    openedBlocks = await evaluate(`globalThis.__oiOpenPage ? globalThis.__oiOpenPage(${spec.page}) : 0`);
    if (openedBlocks > 0) break;
    await sleep(200);
  }
  assert.ok(openedBlocks > 0, `${spec.name} page ${spec.page} did not open`);
  const sources = await evaluate(`globalThis.__oiFormulaSources ? globalThis.__oiFormulaSources(${spec.page}) : []`);
  const { chosen, missing, inline } = selectIds(sources, spec.picks);
  assert.deepEqual(missing, [], `${spec.name} missing ${missing.join(", ")}; inline ${inline.map((row) => row.sourceText).slice(0, 24).join(" | ")}`);
  const ids = chosen.map((row) => row.id);
  let measured = null;
  const measureBy = Date.now() + 90000;
  while (Date.now() < measureBy) {
    measured = await evaluate(measureExpression(ids));
    if (measured?.rows?.length === ids.length && measured.rows.every((row) => row.pending === false && row.delta != null)) break;
    await sleep(250);
  }
  assert.ok(measured?.rows?.every((row) => row.pending === false && row.delta != null), `${spec.name} dpr ${dpr} crops did not paint ${JSON.stringify(measured)}`);
  assert.ok(Math.abs(Number(measured.dpr) - dpr) < 0.05, `${spec.name} devicePixelRatio ${measured.dpr}`);
  assert.equal(measured.font, "14px", `${spec.name} Aa`);
  const byId = new Map(chosen.map((row) => [row.id, row]));
  const failures = [];
  for (const row of measured.rows) {
    const meta = byId.get(row.id);
    const label = `${spec.name} dpr ${dpr} ${meta?.pick || ""} ${row.id} ${JSON.stringify(meta?.sourceText || "")}`;
    const brief = `${label} delta ${Number(row.delta).toFixed(2)} align ${row.baselineVar} depth ${meta?.baselineDepthPt}`;
    if (row.display !== "block") failures.push(`${label} display ${row.display}`);
    if (!(Math.abs(row.delta) <= 1.5)) failures.push(brief);
  }
  assert.deepEqual(failures, [], failures.join("\n"));
  return measured.rows.map((row) => ({
    id: row.id,
    pick: byId.get(row.id)?.pick,
    text: byId.get(row.id)?.sourceText,
    delta: Math.round(row.delta * 100) / 100
  }));
}

async function withReader(t, run) {
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-formula-baseline-"));
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
      await cleanupChrome({
        t,
        child: handle.child,
        server,
        ownedDir,
        userDataDir
      });
    }
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: CHROME_STUB });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  return run({ send, evaluate, origin });
}

test("DPO page 4 π∗ and r∗ ink sits on the body baseline", { timeout: 360000 }, async (t) => {
  if (!existsSync(join(root, DPO_REL))) {
    t.skip(DPO_SKIP);
    return;
  }
  const spec = {
    name: "DPO",
    rel: DPO_REL,
    page: 4,
    picks: [
      { name: "π∗", test: (text) => text.replace(/\s+/g, "") === "π∗" },
      { name: "r∗", test: (text) => text.replace(/\s+/g, "") === "r∗" },
      { name: "r∗(x,y)", test: (text) => /^r∗\([^)]*\)$/.test(text.replace(/\s+/g, "")) }
    ]
  };
  const found = [];
  await withReader(t, async (session) => {
    for (const dpr of [1, 2]) found.push({ dpr, rows: await openAndMeasure(session, spec, dpr) });
  });
  console.log(JSON.stringify(found));
});

test("DDPM page 8 T = 1000 ink sits on the body baseline", { timeout: 360000 }, async (t) => {
  if (!existsSync(join(root, DDPM_REL))) {
    t.skip(DDPM_SKIP);
    return;
  }
  const spec = {
    name: "DDPM",
    rel: DDPM_REL,
    page: 8,
    picks: [
      { name: "T = 1000", test: (text) => /T\s*=\s*1000/.test(text) }
    ]
  };
  const found = [];
  await withReader(t, async (session) => {
    for (const dpr of [1, 2]) found.push({ dpr, rows: await openAndMeasure(session, spec, dpr) });
  });
  console.log(JSON.stringify(found));
});
