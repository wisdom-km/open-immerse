(() => {
  const FAB = globalThis.OIFab || {
    CORNER_DEFAULT: "bottom-right",
    STORAGE_KEY: "oi-fab-corner",
    SNAP_PX: 48,
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
    syncToggle(document.documentElement.classList.contains("oi-active"));
    syncFold(bar);
    syncCollapseLock(bar);
    syncFabSlot(bar);
    bindCornerSnap(bar);

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => syncFabSlot(bar)).observe(bar);
    }

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
    syncFold(bar);
    if (!persist) return;
    try {
      localStorage.setItem(FAB.STORAGE_KEY, next);
    } catch {
      /* private mode / quota */
    }
    send({ type: "OI_SAVE_SETTINGS", patch: { fabCorner: next } });
  }

  function bindCornerSnap(bar) {
    let startX = 0;
    let armed = false;
    bar.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      startX = ev.clientX;
      armed = true;
    });
    const finish = (ev) => {
      if (!armed) return;
      armed = false;
      if (Math.abs(ev.clientX - startX) < FAB.SNAP_PX) return;
      const next = FAB.snapCorner(ev.clientX, window.innerWidth);
      if (next !== bar.dataset.corner) applyCorner(bar, next);
    };
    bar.addEventListener("pointerup", finish);
    bar.addEventListener("pointercancel", () => {
      armed = false;
    });
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
    if (fold) fold.disabled = locked && !bar.classList.contains("oi-fab-collapsed");
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
    const slot = FAB.slotPx(bar.offsetHeight || 52);
    document.documentElement.style.setProperty("--oi-fab-slot", `${slot}px`);
  }

  function syncToggle(on) {
    const btn = document.querySelector('.oi-fab [data-act="toggle"]');
    if (!btn) return;
    btn.textContent = on ? "停止" : "翻译";
    btn.title = on ? "停止" : "翻译";
    btn.classList.toggle("on", on);
  }
})();
