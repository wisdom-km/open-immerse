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
    }
  };

  root.OIFab = OIFab;
})(typeof globalThis !== "undefined" ? globalThis : this);
