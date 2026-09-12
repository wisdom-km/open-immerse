(() => {
  const FAB = globalThis.OIFab || {
    CORNER_DEFAULT: "bottom-right",
    STORAGE_KEY: "oi-fab-corner",
    POS_STORAGE_KEY: "oi-fab-pos",
    SLOT_INSET: 20,
    SLOT_GAP: 12,
    SNAP_BOTTOM_PX: 20,
    DRAG_THRESHOLD_PX: 6,
    normalizeCorner(value) {
      return value === "bottom-left" ? "bottom-left" : "bottom-right";
    },
    slotPx(height) {
      return Math.max(72, Math.round((Number(height) || 0) + 20 + 12));
    },
    persistToastShowing(text) {
      return text === "翻译中" || text === "润色中";
    },
    collapseLocked({ active, persistToast } = {}) {
      return Boolean(active || persistToast);
    },
    foldGlyph(corner, collapsed) {
      const left = corner === "bottom-left";
      if (collapsed) return left ? "‹" : "›";
      return left ? "›" : "‹";
    },
    snapCorner(clientX, viewportWidth) {
      return clientX < viewportWidth / 2 ? "bottom-left" : "bottom-right";
    },
    exceedsDragThreshold(dx, dy, threshold = 6) {
      return Math.hypot(dx || 0, dy || 0) >= threshold;
    },
    isAllowedCorner(value) {
      return value === "bottom-left" || value === "bottom-right";
    },
    isDragHandle() {
      return true;
    },
    clampDragPosition({
      left,
      top,
      width,
      height,
      viewportWidth,
      viewportHeight,
      inset = 20
    } = {}) {
      const w = Math.max(0, Number(width) || 0);
      const h = Math.max(0, Number(height) || 0);
      const vw = Math.max(0, Number(viewportWidth) || 0);
      const vh = Math.max(0, Number(viewportHeight) || 0);
      const maxL = Math.max(inset, vw - w - inset);
      const maxT = Math.max(inset, vh - h - inset);
      return {
        left: Math.round(Math.min(Math.max(inset, Number(left) || inset), maxL)),
        top: Math.round(Math.min(Math.max(inset, Number(top) || inset), maxT))
      };
    },
    cornerToPos({
      corner,
      width,
      height,
      viewportWidth,
      viewportHeight,
      inset = 20
    } = {}) {
      const next = this.normalizeCorner(corner);
      const w = Math.max(0, Number(width) || 0);
      const h = Math.max(0, Number(height) || 0);
      const vw = Math.max(0, Number(viewportWidth) || 0);
      const vh = Math.max(0, Number(viewportHeight) || 0);
      return this.clampDragPosition({
        left: next === "bottom-left" ? inset : vw - w - inset,
        top: vh - h - inset,
        width: w,
        height: h,
        viewportWidth: vw,
        viewportHeight: vh,
        inset
      });
    },
    normalizePos(value) {
      if (!value || typeof value !== "object") return null;
      const left = Number(value.left);
      const top = Number(value.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
      return { left, top };
    },
    toastSlotFromBox({ top, height, viewportHeight, gap = 12 } = {}) {
      const vh = Number(viewportHeight);
      const t = Number(top);
      if (!Number.isFinite(vh) || !Number.isFinite(t)) {
        return Math.max(72, Math.round((Number(height) || 0) + 20 + 12));
      }
      return Math.max(20, Math.round(vh - t + (Number(gap) || 12)));
    },
    toastPlacementFromBox({ top, height, viewportHeight, gap = 12, inset = 20, minAbove = 64 } = {}) {
      const t = Number(top) || 0;
      const h = Number(height) || 0;
      if (t - inset >= minAbove) {
        return { slot: this.toastSlotFromBox({ top: t, height: h, viewportHeight, gap }), top: "auto" };
      }
      return { slot: "auto", top: `${Math.round(t + h + gap)}px` };
    },
    toastAlignFromBox({ left, width, viewportWidth, inset = 20 } = {}) {
      const vw = Number(viewportWidth) || 0;
      const w = Number(width) || 0;
      const l = Number(left) || 0;
      if (l + w / 2 < vw / 2) {
        return { side: "left", left: `${Math.max(inset, Math.round(l))}px`, right: "auto" };
      }
      return { side: "right", left: "auto", right: `${Math.max(inset, Math.round(vw - (l + w)))}px` };
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
      const nodes = this.collectFabs(host);
      for (const el of nodes) el.remove?.();
      return nodes.length;
    },
    reconcile(host, { hidden = false } = {}) {
      const nodes = this.collectFabs(host);
      let stale = 0;
      for (const el of nodes) {
        if (!this.isV1Shape(el)) stale += 1;
        el.remove?.();
      }
      return { action: hidden ? "hide" : "mount", removed: nodes.length, stale };
    }
  };

  initToolbar();

  async function send(payload) {
    try {
      if (!chrome.runtime?.id) return null;
      return await chrome.runtime.sendMessage(payload);
    } catch (err) {
      const msg = String(err && err.message || err);
      if (/Extension context invalidated|message port closed/i.test(msg)) return null;
      throw err;
    }
  }

  async function initToolbar() {
    const res = await send({ type: "OI_GET_SETTINGS" });
    if (!res) return;
    const { settings } = res;
    const features = settings.features || {};
    const hidden =
      features.fab === false || settings.showFab === false || features.webpage === false;
    // Reload leaves the previous content-script .oi-fab in the page (often the
    // pre-V1 翻译/原文/收藏/⋯ bar). Blind return would skip V1 and dead-bind.
    const plan = FAB.reconcile(document, { hidden });
    if (plan.action !== "mount") return;

    const bar = document.createElement("div");
    bar.className = "oi-fab";
    bar.dataset.oiFab = "v1";
    bar.innerHTML =
      '<button type="button" data-act="toggle" title="翻译">翻译</button>' +
      '<button type="button" data-act="restore" title="原文">原文</button>' +
      '<button type="button" data-act="fold" class="oi-fab-fold" title="收起" aria-label="收起">‹</button>';

    applyCorner(bar, readCorner(settings), { persist: false });
    document.documentElement.appendChild(bar);
    const savedPos = readPos(settings);
    if (savedPos) {
      applyFreePos(bar, savedPos, { persist: false });
    } else if (bar.offsetWidth) {
      applyFreePos(
        bar,
        FAB.cornerToPos({
          corner: readCorner(settings),
          width: bar.offsetWidth,
          height: bar.offsetHeight || 0,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          inset: FAB.SLOT_INSET
        }),
        { persist: true }
      );
    }
    syncToggle(document.documentElement.classList.contains("oi-active"));
    syncFold(bar);
    syncCollapseLock(bar);
    syncFabSlot(bar);
    bindFabDrag(bar);

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => syncFabSlot(bar)).observe(bar);
    }
    window.addEventListener("resize", () => {
      if (bar.classList.contains("oi-fab-free")) {
        applyFreePos(
          bar,
          { left: parseFloat(bar.style.left), top: parseFloat(bar.style.top) },
          { persist: false }
        );
      }
      syncFabSlot(bar);
    });

    window.addEventListener("oi-running", (ev) => {
      const on = Boolean(ev.detail);
      syncToggle(on);
      if (on) expand(bar);
      syncCollapseLock(bar);
      syncFabSlot(bar);
    });
    window.addEventListener("oi-status", () => {
      syncCollapseLock(bar);
    });

    bar.addEventListener("click", async (ev) => {
      if (bar.dataset.oiDragged === "1") {
        delete bar.dataset.oiDragged;
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "fold") {
        toggleFold(bar);
        return;
      }
      if (act === "toggle") {
        const on = !document.documentElement.classList.contains("oi-active");
        await send({ type: "OI_SAVE_SETTINGS", patch: { enabled: on } });
        window.dispatchEvent(new CustomEvent(on ? "oi-please-start" : "oi-please-restore"));
      }
      if (act === "restore") {
        await send({ type: "OI_SAVE_SETTINGS", patch: { enabled: false } });
        window.dispatchEvent(new CustomEvent("oi-please-restore"));
      }
    });
  }

  function readCorner(settings) {
    let stored = "";
    try {
      stored = localStorage.getItem(FAB.STORAGE_KEY) || "";
    } catch {
      stored = "";
    }
    return FAB.normalizeCorner(settings.fabCorner || stored || FAB.CORNER_DEFAULT);
  }

  function applyCorner(bar, corner, { persist = true } = {}) {
    const next = FAB.normalizeCorner(corner);
    bar.dataset.corner = next;
    document.documentElement.dataset.oiFabCorner = next;
    bar.classList.remove("oi-fab-free");
    bar.style.left = "";
    bar.style.top = "";
    bar.style.right = "";
    bar.style.bottom = "";
    syncFold(bar);
    if (!persist) return;
    try {
      localStorage.setItem(FAB.STORAGE_KEY, next);
      localStorage.removeItem(FAB.POS_STORAGE_KEY);
    } catch {
      /* private mode / quota */
    }
    send({ type: "OI_SAVE_SETTINGS", patch: { fabCorner: next, fabPos: null } });
  }

  function readPos(settings) {
    const fromSettings = FAB.normalizePos(settings?.fabPos);
    if (fromSettings) return fromSettings;
    try {
      const raw = localStorage.getItem(FAB.POS_STORAGE_KEY);
      return FAB.normalizePos(raw ? JSON.parse(raw) : null);
    } catch {
      return null;
    }
  }

  function persistPos(pos) {
    const payload = { left: pos.left, top: pos.top };
    try {
      localStorage.setItem(FAB.POS_STORAGE_KEY, JSON.stringify(payload));
      localStorage.removeItem(FAB.STORAGE_KEY);
    } catch {
      /* private mode / quota */
    }
    send({ type: "OI_SAVE_SETTINGS", patch: { fabPos: payload } });
  }

  function applyFreePos(bar, pos, { persist = true } = {}) {
    const next = FAB.clampDragPosition({
      left: pos?.left,
      top: pos?.top,
      width: bar.offsetWidth || 0,
      height: bar.offsetHeight || 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      inset: FAB.SLOT_INSET
    });
    bar.classList.add("oi-fab-free");
    bar.style.left = `${next.left}px`;
    bar.style.top = `${next.top}px`;
    bar.style.right = "auto";
    bar.style.bottom = "auto";
    const side = FAB.snapCorner(next.left + (bar.offsetWidth || 0) / 2, window.innerWidth);
    bar.dataset.corner = side;
    document.documentElement.dataset.oiFabCorner = side;
    syncFold(bar);
    if (persist) persistPos(next);
    return next;
  }

  function bindFabDrag(bar) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let grabX = 0;
    let grabY = 0;
    let armed = false;
    let dragging = false;
    const moveOpts = { capture: true, passive: false };

    const onMove = (ev) => {
      if (!armed || ev.pointerId !== pointerId) return;
      if (!dragging) {
        if (!FAB.exceedsDragThreshold(ev.clientX - startX, ev.clientY - startY, FAB.DRAG_THRESHOLD_PX)) {
          return;
        }
        dragging = true;
        bar.classList.add("oi-fab-dragging");
        try {
          bar.setPointerCapture(ev.pointerId);
        } catch {
          /* capture is optional */
        }
      }
      ev.preventDefault();
      followPointer(bar, ev.clientX, ev.clientY, grabX, grabY);
    };

    const finish = (ev) => {
      if (!armed || ev.pointerId !== pointerId) return;
      const wasDragging = dragging;
      armed = false;
      dragging = false;
      pointerId = null;
      window.removeEventListener("pointermove", onMove, moveOpts);
      window.removeEventListener("pointerup", finish, moveOpts);
      window.removeEventListener("pointercancel", finish, moveOpts);
      if (!wasDragging) return;
      bar.classList.remove("oi-fab-dragging");
      const rect = bar.getBoundingClientRect();
      applyFreePos(bar, { left: rect.left, top: rect.top });
      syncFabSlot(bar);
      bar.dataset.oiDragged = "1";
      setTimeout(() => {
        delete bar.dataset.oiDragged;
      }, 0);
    };

    bar.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      // §8: whole bar / collapsed chip; busy still allows drag.
      pointerId = ev.pointerId;
      armed = true;
      dragging = false;
      startX = ev.clientX;
      startY = ev.clientY;
      const rect = bar.getBoundingClientRect();
      grabX = ev.clientX - rect.left;
      grabY = ev.clientY - rect.top;
      window.addEventListener("pointermove", onMove, moveOpts);
      window.addEventListener("pointerup", finish, moveOpts);
      window.addEventListener("pointercancel", finish, moveOpts);
    });
  }

  function followPointer(bar, clientX, clientY, grabX, grabY) {
    const pos = FAB.clampDragPosition({
      left: clientX - grabX,
      top: clientY - grabY,
      width: bar.offsetWidth || 0,
      height: bar.offsetHeight || 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      inset: FAB.SLOT_INSET
    });
    bar.style.left = `${pos.left}px`;
    bar.style.top = `${pos.top}px`;
    bar.style.right = "auto";
    bar.style.bottom = "auto";
    syncFabSlot(bar);
  }

  function clearDragPosition(bar) {
    bar.classList.remove("oi-fab-dragging");
  }

  function toggleFold(bar) {
    if (bar.classList.contains("oi-fab-collapsed")) {
      expand(bar);
      return;
    }
    if (isLocked()) return;
    bar.classList.add("oi-fab-collapsed");
    syncFold(bar);
    syncFabSlot(bar);
  }

  function expand(bar) {
    bar.classList.remove("oi-fab-collapsed");
    syncFold(bar);
    syncFabSlot(bar);
  }

  function isLocked() {
    const toast = document.querySelector(".oi-toast.show");
    return FAB.collapseLocked({
      active: document.documentElement.classList.contains("oi-active"),
      persistToast: Boolean(toast && FAB.persistToastShowing(toast.textContent))
    });
  }

  function syncCollapseLock(bar) {
    const locked = isLocked();
    bar.classList.toggle("oi-fab-locked", locked);
    const fold = bar.querySelector('[data-act="fold"]');
    if (fold) {
      const block = locked && !bar.classList.contains("oi-fab-collapsed");
      fold.toggleAttribute("aria-disabled", block);
    }
  }

  function syncFold(bar) {
    const fold = bar.querySelector('[data-act="fold"]');
    if (!fold) return;
    const collapsed = bar.classList.contains("oi-fab-collapsed");
    fold.textContent = FAB.foldGlyph(bar.dataset.corner, collapsed);
    fold.title = collapsed ? "展开" : "收起";
    fold.setAttribute("aria-label", fold.title);
    syncCollapseLock(bar);
  }

  function syncFabSlot(bar) {
    const rect = bar.getBoundingClientRect();
    const place = FAB.toastPlacementFromBox({
      top: rect.top,
      height: rect.height || 52,
      viewportHeight: window.innerHeight,
      gap: FAB.SLOT_GAP,
      inset: FAB.SLOT_INSET
    });
    document.documentElement.style.setProperty(
      "--oi-fab-slot",
      place.slot === "auto" ? "auto" : `${place.slot}px`
    );
    document.documentElement.style.setProperty("--oi-fab-toast-top", place.top);
    const align = FAB.toastAlignFromBox({
      left: rect.left,
      width: rect.width,
      viewportWidth: window.innerWidth,
      inset: FAB.SLOT_INSET
    });
    document.documentElement.style.setProperty("--oi-fab-toast-left", align.left);
    document.documentElement.style.setProperty("--oi-fab-toast-right", align.right);
    if (rect.width) {
      const side = FAB.snapCorner(rect.left + rect.width / 2, window.innerWidth);
      if (bar.dataset.corner !== side) {
        bar.dataset.corner = side;
        document.documentElement.dataset.oiFabCorner = side;
        syncFold(bar);
      }
    }
  }

  function syncToggle(on) {
    const btn = document.querySelector('.oi-fab [data-act="toggle"]');
    if (!btn) return;
    btn.textContent = on ? "停止" : "翻译";
    btn.title = on ? "停止" : "翻译";
    btn.classList.toggle("on", on);
  }
})();
