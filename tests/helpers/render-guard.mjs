// Parent-side abort for a renderer that might loop forever.
// The worker timer is the guard. A node:test timeout does not interrupt
// a synchronous loop on the same thread.
import { Worker } from "node:worker_threads";

const workerUrl = new URL("./markdown-render-worker.mjs", import.meta.url);

export function renderGuarded(sources, { totalMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { execArgv: [] });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`render exceeded ${totalMs}ms`));
    }, totalMs);
    worker.once("message", (msg) => finish(resolve, msg?.results || []));
    worker.once("error", (err) => finish(reject, err));
    worker.postMessage({ sources });
  });
}

/** A worker that loops until something calls terminate. */
export function openHangWorker() {
  const worker = new Worker(
    "const { parentPort } = require('node:worker_threads'); parentPort.once('message', () => { while (true) {} });",
    { eval: true, execArgv: [] }
  );
  worker.postMessage("go");
  return worker;
}

/** The production abort. The test keeps its own terminate in after/finally. */
export function abortWorker(worker, ms = 400) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setTimeout(() => {
      worker.terminate().then(() => resolve(performance.now() - started), reject);
    }, ms);
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
