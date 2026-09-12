(function (root) {
  const OIFab = {
    CORNER_DEFAULT: "bottom-right",
    STORAGE_KEY: "oi-fab-corner",
    SLOT_INSET: 20,
    SLOT_GAP: 12,
    SNAP_PX: 48,
    STATUS_TRANSLATING: "翻译中",
    STATUS_POLISHING: "润色中",

    normalizeCorner(value) {
      return value === "bottom-left" ? "bottom-left" : "bottom-right";
    },

    slotPx(height, inset = OIFab.SLOT_INSET, gap = OIFab.SLOT_GAP) {
      const h = Number(height);
      return Math.max(72, Math.round((Number.isFinite(h) ? h : 0) + inset + gap));
    },

    persistToastShowing(text) {
      return text === OIFab.STATUS_TRANSLATING || text === OIFab.STATUS_POLISHING;
    },

    collapseLocked({ active, persistToast } = {}) {
      return Boolean(active || persistToast);
    },

    foldGlyph(corner, collapsed) {
      const left = OIFab.normalizeCorner(corner) === "bottom-left";
      if (collapsed) return left ? "‹" : "›";
      return left ? "›" : "‹";
    },

    snapCorner(clientX, viewportWidth) {
      const mid = Number(viewportWidth) / 2;
      return Number(clientX) < mid ? "bottom-left" : "bottom-right";
    },

    isV1Shape(root) {
      if (!root || typeof root.querySelector !== "function") return false;
      if (!root.classList?.contains("oi-fab")) return false;
      const has = (act) => Boolean(root.querySelector(`[data-act="${act}"]`));
      if (!has("toggle") || !has("restore") || !has("fold")) return false;
      if (has("save") || has("more")) return false;
      if (root.querySelector(".oi-fab-menu")) return false;
      return true;
    },

    collectFabs(host) {
      if (!host || typeof host.querySelectorAll !== "function") return [];
      return [...host.querySelectorAll(".oi-fab")];
    },

    unmountAll(host) {
      const nodes = OIFab.collectFabs(host);
      for (const el of nodes) {
        if (typeof el.remove === "function") el.remove();
      }
      return nodes.length;
    },

    reconcile(host, { hidden = false } = {}) {
      const nodes = OIFab.collectFabs(host);
      let stale = 0;
      for (const el of nodes) {
        if (!OIFab.isV1Shape(el)) stale += 1;
        if (typeof el.remove === "function") el.remove();
      }
      if (hidden) return { action: "hide", removed: nodes.length, stale };
      return { action: "mount", removed: nodes.length, stale };
    }
  };

  root.OIFab = OIFab;
})(typeof globalThis !== "undefined" ? globalThis : this);
