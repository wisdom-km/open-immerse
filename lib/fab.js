(function (root) {
  const OIFab = {
    CORNER_DEFAULT: "bottom-right",
    STORAGE_KEY: "oi-fab-corner",
    POS_STORAGE_KEY: "oi-fab-pos",
    SLOT_INSET: 20,
    SLOT_GAP: 12,
    SNAP_BOTTOM_PX: 20,
    DRAG_THRESHOLD_PX: 6,
    ALLOWED_CORNERS: ["bottom-left", "bottom-right"],
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

    exceedsDragThreshold(dx, dy, threshold = OIFab.DRAG_THRESHOLD_PX) {
      const limit = Number(threshold);
      const t = Number.isFinite(limit) ? limit : OIFab.DRAG_THRESHOLD_PX;
      return Math.hypot(Number(dx) || 0, Number(dy) || 0) >= t;
    },

    isAllowedCorner(value) {
      return value === "bottom-left" || value === "bottom-right";
    },

    isDragHandle(_act, { collapsed = false } = {}) {
      return true;
    },

    clampDragPosition({
      left,
      top,
      width,
      height,
      viewportWidth,
      viewportHeight,
      inset = OIFab.SLOT_INSET
    } = {}) {
      const pad = Number(inset);
      const edge = Number.isFinite(pad) ? pad : OIFab.SLOT_INSET;
      const w = Math.max(0, Number(width) || 0);
      const h = Math.max(0, Number(height) || 0);
      const vw = Math.max(0, Number(viewportWidth) || 0);
      const vh = Math.max(0, Number(viewportHeight) || 0);
      const minL = edge;
      const minT = edge;
      const maxL = Math.max(minL, vw - w - edge);
      const maxT = Math.max(minT, vh - h - edge);
      const rawL = Number(left);
      const rawT = Number(top);
      return {
        left: Math.round(Math.min(Math.max(minL, Number.isFinite(rawL) ? rawL : minL), maxL)),
        top: Math.round(Math.min(Math.max(minT, Number.isFinite(rawT) ? rawT : minT), maxT))
      };
    },

    normalizePos(value) {
      if (!value || typeof value !== "object") return null;
      const left = Number(value.left);
      const top = Number(value.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      return { left, top };
    },

    toastSlotFromBox({
      top,
      height,
      viewportHeight,
      gap = OIFab.SLOT_GAP
    } = {}) {
      const vh = Number(viewportHeight);
      const t = Number(top);
      const g = Number(gap);
      const gapPx = Number.isFinite(g) ? g : OIFab.SLOT_GAP;
      if (!Number.isFinite(vh) || !Number.isFinite(t)) {
        return OIFab.slotPx(height);
      }
      return Math.max(OIFab.SLOT_INSET, Math.round(vh - t + gapPx));
    },

    toastPlacementFromBox({
      top,
      height,
      viewportHeight,
      gap = OIFab.SLOT_GAP,
      inset = OIFab.SLOT_INSET,
      minAbove = 64
    } = {}) {
      const vh = Number(viewportHeight) || 0;
      const t = Number(top) || 0;
      const h = Number(height) || 0;
      const g = Number(gap);
      const gapPx = Number.isFinite(g) ? g : OIFab.SLOT_GAP;
      const edge = Number.isFinite(Number(inset)) ? Number(inset) : OIFab.SLOT_INSET;
      if (t - edge >= minAbove) {
        return {
          slot: OIFab.toastSlotFromBox({ top: t, height: h, viewportHeight: vh, gap: gapPx }),
          top: "auto"
        };
      }
      return {
        slot: "auto",
        top: `${Math.round(t + h + gapPx)}px`
      };
    },

    toastAlignFromBox({
      left,
      width,
      viewportWidth,
      inset = OIFab.SLOT_INSET
    } = {}) {
      const vw = Number(viewportWidth) || 0;
      const w = Number(width) || 0;
      const l = Number(left) || 0;
      const edge = Number.isFinite(Number(inset)) ? Number(inset) : OIFab.SLOT_INSET;
      const side = l + w / 2 < vw / 2 ? "left" : "right";
      if (side === "left") {
        return {
          side,
          left: `${Math.max(edge, Math.round(l))}px`,
          right: "auto"
        };
      }
      return {
        side,
        left: "auto",
        right: `${Math.max(edge, Math.round(vw - (l + w)))}px`
      };
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
