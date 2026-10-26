/** In-flight translation HTTP aborts, keyed by request id. */

export function createTranslateAbortRegistry() {
  const controllers = new Map();
  return {
    begin(requestId) {
      const controller = new AbortController();
      const id = String(requestId || "");
      if (id) {
        const prev = controllers.get(id);
        if (prev && prev.signal?.aborted !== true) {
          try { prev.abort(); } catch { /* already aborted */ }
        }
        controllers.set(id, controller);
      }
      return controller;
    },
    abort(requestId) {
      const id = String(requestId || "");
      if (!id) {
        for (const controller of controllers.values()) {
          if (controller.signal?.aborted !== true) {
            try { controller.abort(); } catch { /* already aborted */ }
          }
        }
        controllers.clear();
        return;
      }
      const controller = controllers.get(id);
      if (!controller) return;
      if (controller.signal?.aborted !== true) {
        try { controller.abort(); } catch { /* already aborted */ }
      }
      controllers.delete(id);
    },
    finish(requestId) {
      controllers.delete(String(requestId || ""));
    },
    has(requestId) {
      return controllers.has(String(requestId || ""));
    }
  };
}

export const translateAbortRegistry = createTranslateAbortRegistry();
