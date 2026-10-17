/**
 * Viewer-side store for oi-formula. Talks to the service worker.
 * A missing runtime or a failed write returns empty. It does not throw,
 * and it does not open IndexedDB from the page.
 */

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
      return res?.stored === true;
    },
    async deleteTier(key, decidedAt) {
      const res = await call({ action: "delete", bucket: "tier", key, decidedAt });
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
