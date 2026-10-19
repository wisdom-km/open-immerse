// Renders Ask Markdown off the parent thread. A synchronous hang stays here
// so the parent can terminate the worker. node:test's timeout cannot.
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

let ready = null;
function loadRenderer() {
  if (ready) return ready;
  ready = (async () => {
    await import("./load-markdown-it.mjs");
    const katexPath = join(root, "pdf/vendor/katex/katex.min.js");
    const katexModule = new (require("module").Module)(katexPath);
    katexModule.filename = katexPath;
    katexModule.paths = require("module").Module._nodeModulePaths(dirname(katexPath));
    katexModule._compile(readFileSync(katexPath, "utf8"), katexPath);
    globalThis.katex = katexModule.exports;
    const { renderAskAnswer } = await import("../../lib/ask-render.js");
    return renderAskAnswer;
  })();
  return ready;
}

parentPort.on("message", async (msg) => {
  if (msg?.hang) {
    while (true) { /* parent must terminate */ }
  }
  const renderAskAnswer = await loadRenderer();
  const sources = Array.isArray(msg?.sources) ? msg.sources : [];
  const results = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const started = performance.now();
    try {
      const html = renderAskAnswer(source, globalThis.katex);
      results.push({ index, html, ms: performance.now() - started });
    } catch (err) {
      results.push({ index, error: String(err?.message || err), ms: performance.now() - started });
    }
  }
  parentPort.postMessage({ ok: true, results });
});
