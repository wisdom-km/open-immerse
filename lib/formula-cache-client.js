/**
 * Viewer-side store for oi-formula. Talks to the service worker.
 * A missing runtime or a failed write returns empty. It does not throw,
 * and it does not open IndexedDB from the page.
 */

const formulaCleaners = new Set();

/** In-process caches (tests, a viewer memory store) clear with the library delete. */
export function registerFormulaCleaner(fn) {
  if (typeof fn !== "function") return () => {};
  formulaCleaners.add(fn);
  return () => formulaCleaners.delete(fn);
}

export async function clearFormulaDoc(docHash) {
  const hash = String(docHash || "");
  const jobs = [];
  for (const fn of formulaCleaners) jobs.push(Promise.resolve().then(() => fn(hash)));
  const runtime = globalThis.chrome?.runtime;
  if (runtime && typeof runtime.sendMessage === "function") {
    jobs.push(createMessageFormulaStore((message) => runtime.sendMessage(message)).clearDoc(hash));
  }
  await Promise.all(jobs);
}

export function createMessageFormulaStore(send) {
  async function call(message) {
    if (typeof send !== "function") return null;
    try {
      const res = await send({ type: "OI_FORMULA_CACHE", ...message });
      if (!res || res.ok === false) return null;
      return res;
    } catch {
      return null;
    }
  }
  return {
    kind: "runtime",
    async getTier(key) {
      const res = await call({ action: "get", key });
      return res ? (res.value ?? null) : null;
    },
    async putTier(key, record) {
      const res = await call({ action: "put", key, value: record });
      return res?.stored === true;
    },
    async commitTier(key, record) {
      const res = await call({ action: "commit", bucket: "tier", key, value: record });
      if (res?.displaced && record && typeof record === "object") record.displacedTier = res.displaced;
      return res?.stored === true;
    },
    async rollbackTier(key, writeId, displaced) {
      const res = await call({ action: "rollback", bucket: "tier", key, writeId, displaced });
      return res?.rolled === true;
    },
    async deleteTier(key, writeId) {
      const res = await call({ action: "delete", bucket: "tier", key, writeId });
      return res?.deleted === true;
    },
    async getDecision(key) {
      const res = await call({ action: "get", bucket: "decision", key });
      return res ? (res.value ?? null) : null;
    },
    async putDecision(key, record) {
      const res = await call({ action: "put", bucket: "decision", key, value: record });
      return res?.stored === true;
    },
    async clearDoc(docHash) {
      await call({ action: "clearDoc", docHash });
    },
    async clearAll() {
      await call({ action: "clearAll" });
    }
  };
}
