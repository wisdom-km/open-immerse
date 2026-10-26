/**
 * Reader drawer: 目录 / 说明 / 最近.
 * The root is a div. Docked it is complementary. Floating and the narrow
 * sheet are modal dialogs, and the rest of the page is inert while they are.
 */

import { recentMeta } from "../lib/drawer-info.js";
import { LIBRARY_COPY, libraryRowTitle } from "../lib/library-copy.js";
import { BLOCKED_TITLE, blockedReasonCopy, isStorageBlocked } from "../lib/storage-copy.js";

const TABS = [
  { id: "toc", label: "目录" },
  { id: "info", label: "说明" },
  { id: "recent", label: "最近" }
];
const TAB_KEY = "oi.drawer.tab";

function h(doc, tag, attrs, children) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "text") node.textContent = String(value);
    else if (key === "class") node.className = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children || []) {
    if (child) node.append(child);
  }
  return node;
}

export function mountDrawerUi(api = {}) {
  const slot = api.slot || (typeof document !== "undefined" ? document.getElementById("drawerSlot") : null);
  const doc = slot?.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!slot || !doc) {
    return {
      open() {},
      close() {},
      toggle() {},
      isOpen: () => false,
      isModal: () => false,
      isDocked: () => false,
      consumeEscape: () => false,
      refresh() {},
      setTab() {},
      setToc() {},
      setCurrent() {},
      setMode() {}
    };
  }
  const win = doc.defaultView || globalThis;
  const timers = api.timers || win;
  const backdrop = api.backdrop || doc.getElementById("drawerBackdrop");
  const root = h(doc, "div", {
    class: "oi-drawer",
    role: "complementary",
    "aria-label": "目录与说明"
  });
  slot.replaceChildren(root);

  let open = false;
  let tab = readTab();
  let mode = "float";
  let trigger = null;
  let toc = { source: "", entries: [], partial: "", loading: false };
  let current = -1;
  let activeToc = -1;
  let activeRecent = 0;
  let infoState = { phase: "blank", model: null };
  let recentState = { phase: "blank", rows: [] };
  let infoGen = 0;
  let recentGen = 0;
  let infoStale = false;
  let recentStale = false;
  const scrollTops = { toc: 0, info: 0, recent: 0 };
  const rowFlags = new Map();
  let tocSignature = "";
  let refreshTimer = 0;

  function sessionGet(key) {
    try {
      if (api.session?.getItem) return api.session.getItem(key);
      return win.sessionStorage?.getItem(key);
    } catch {
      return null;
    }
  }

  function sessionSet(key, value) {
    try {
      if (api.session?.setItem) api.session.setItem(key, value);
      else win.sessionStorage?.setItem(key, value);
    } catch {
      /* session storage is optional */
    }
  }

  function readTab() {
    const value = sessionGet(TAB_KEY);
    return value === "info" || value === "recent" ? value : "toc";
  }

  function width() {
    if (typeof api.width === "function") return Number(api.width()) || 0;
    return Number(win.innerWidth) || 1200;
  }

  function shown(node) {
    if (!node || node.nodeType !== 1 || node.hidden) return false;
    const view = doc.defaultView;
    let current = node;
    while (current && current.nodeType === 1) {
      if (current.hidden) return false;
      try {
        const style = view?.getComputedStyle?.(current);
        const display = style?.display;
        const visibility = style?.visibility;
        if (display === "none" || visibility === "hidden" || visibility === "collapse") return false;
      } catch {
        /* a host without layout still honors the hidden attribute */
      }
      current = current.parentElement;
    }
    return true;
  }

  function returnTarget() {
    const button = doc.getElementById("tocButton");
    if (shown(button)) return button;
    const more = doc.getElementById("moreButton");
    if (shown(more)) return more;
    return button;
  }

  function focus(node) {
    try {
      node?.focus?.();
    } catch {
      /* the host may not focus */
    }
  }

  function syncChrome() {
    const modal = open && mode !== "dock";
    slot.hidden = !open;
    slot.classList.toggle("is-open", open);
    slot.classList.toggle("is-sheet", open && mode === "sheet");
    slot.classList.toggle("is-float", open && mode === "float");
    root.classList.toggle("is-sheet", open && mode === "sheet");
    root.classList.toggle("is-narrow-type", width() > 0 && width() < 340);
    if (mode === "dock") {
      root.setAttribute("role", "complementary");
      root.removeAttribute("aria-modal");
    } else {
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
    }
    if (backdrop) backdrop.hidden = !(open && mode === "float");
    // While the drawer is modal the source column stays inert, so its wheel
    // does not scroll. That is the modal barrier, recorded as a leftover.
    setModalBarrier(open && mode !== "dock");
    const button = doc.getElementById("tocButton");
    if (button) {
      button.setAttribute("aria-pressed", open ? "true" : "false");
      if (!button.getAttribute("aria-controls")) button.setAttribute("aria-controls", slot.id || "drawerSlot");
      if (open) button.setAttribute("data-open", "true");
      else button.removeAttribute("data-open");
    }
    return modal;
  }

  function setModalBarrier(modal) {
    const body = doc.body;
    if (!body) return;
    const keep = new Set();
    for (let node = slot; node && node !== body; node = node.parentElement) keep.add(node);
    if (backdrop) keep.add(backdrop);
    for (const child of body.children) {
      if (!keep.has(child)) {
        child.inert = modal;
        continue;
      }
      child.inert = false;
      if (child !== slot && typeof child.contains === "function" && child.contains(slot)) {
        for (const grand of child.children) {
          const holdsDrawer = grand === slot || grand === backdrop || (typeof grand.contains === "function" && grand.contains(slot));
          const side = grand.id === "sideSlot";
          grand.inert = modal && !holdsDrawer && !side;
        }
      }
    }
  }

  function rememberScroll() {
    const scroller = root.querySelector(".oi-drawer-scroll");
    if (scroller) scrollTops[tab] = Number(scroller.scrollTop) || 0;
  }

  function restoreScroll() {
    const scroller = root.querySelector(".oi-drawer-scroll");
    if (scroller) scroller.scrollTop = scrollTops[tab] || 0;
  }

  function focusEntry() {
    if (tab === "toc") {
      const currentBtn = root.querySelector('.oi-toc-item[aria-current="location"]');
      const any = currentBtn || root.querySelector(".oi-toc-item");
      if (any) {
        focus(any);
        return;
      }
    }
    if (tab === "recent") {
      const row = root.querySelector(".oi-recent-row:not([disabled])");
      if (row) {
        focus(row);
        return;
      }
    }
    focus(root.querySelector('[role="tab"][aria-selected="true"]'));
  }

  function blockedBlock() {
    const reason = blockedReasonCopy("blocked");
    const box = h(doc, "div", { class: "oi-drawer-blocked" }, [
      h(doc, "p", { class: "oi-drawer-blocked-title", text: BLOCKED_TITLE || LIBRARY_COPY.blockedTitle }),
      h(doc, "p", { text: reason.reason }),
      h(doc, "button", { type: "button", class: "btn-secondary oi-drawer-retry", text: LIBRARY_COPY.retry })
    ]);
    box.querySelector(".oi-drawer-retry")?.addEventListener("click", () => {
      if (tab === "info") void loadInfo(true);
      if (tab === "recent") void loadRecent(true);
    });
    return box;
  }

  function skeleton() {
    const box = h(doc, "div", { class: "oi-drawer-skel", "aria-hidden": "true" });
    for (let n = 0; n < 6; n += 1) box.append(h(doc, "span"));
    return box;
  }

  function paintToc(panel) {
    panel.dataset.tocSource = toc.source || "";
    if (toc.loading && !(toc.entries || []).length) {
      panel.append(skeleton());
      return;
    }
    const entries = toc.entries || [];
    if (!entries.length) {
      panel.append(h(doc, "div", { class: "oi-drawer-empty" }, [
        h(doc, "p", { class: "oi-drawer-empty-title", text: "这篇没有可用的目录" }),
        h(doc, "p", { class: "oi-drawer-muted", text: "在原文里滚动阅读即可。" })
      ]));
      return;
    }
    const numbered = entries.some((entry) => String(entry.num || "").trim());
    root.classList.toggle("is-unnumbered", !numbered);
    const list = h(doc, "div", { class: "oi-toc-list", role: "group", "aria-label": "目录" });
    const focusIndex = activeToc >= 0 ? activeToc : current;
    entries.forEach((entry, index) => {
      const title = displayTitle(entry);
      const button = h(doc, "button", {
        type: "button",
        class: "oi-toc-item",
        "data-level": String(entry.level || 1),
        "data-toc-index": String(index),
        "data-page": entry.page ? String(entry.page) : "",
        tabindex: index === (focusIndex >= 0 ? focusIndex : 0) ? "0" : "-1"
      });
      if (index === current) button.setAttribute("aria-current", "location");
      if (numbered) button.append(h(doc, "span", { class: "oi-toc-num", text: entry.num || "" }));
      const titleNode = h(doc, "span", {
        class: entry.translated ? "oi-toc-title" : "oi-toc-title is-original",
        text: title
      });
      button.append(titleNode);
      button.append(h(doc, "span", { class: "oi-toc-page", text: entry.page ? `p.${entry.page}` : "" }));
      button.addEventListener("click", () => {
        activeToc = index;
        api.onJump?.(entry);
      });
      list.append(button);
    });
    panel.append(list);
    if (toc.source === "headings" && toc.partial) {
      panel.append(h(doc, "p", { class: "oi-drawer-partial", text: toc.partial }));
    }
  }

  function displayTitle(entry) {
    const title = String(entry?.title || "");
    const num = String(entry?.num || "");
    if (!entry?.translated && num && title.startsWith(num)) {
      return title.slice(num.length).replace(/^[\s.、:：]+/, "").trim() || title;
    }
    return title;
  }

  function paintInfo(panel) {
    if (infoState.phase === "blank") {
      panel.append(skeleton());
      return;
    }
    if (infoState.phase === "blocked") {
      panel.append(blockedBlock());
      return;
    }
    const model = infoState.model;
    if (!model) {
      panel.append(skeleton());
      return;
    }
    const progress = h(doc, "section", { class: "oi-info-block" }, [
      h(doc, "h3", { text: "翻译" }),
      h(doc, "p", { class: "oi-info-progress", text: model.progress })
    ]);
    const formula = h(doc, "section", { class: "oi-info-block" }, [
      h(doc, "h3", { text: `公式来源 · 已排版的 ${model.laidOut} 页` })
    ]);
    for (const row of model.formulaRows || []) {
      formula.append(h(doc, "p", { class: "oi-info-row", "data-tier": row.key }, [
        h(doc, "span", { text: row.label }),
        h(doc, "span", { text: String(row.count) })
      ]));
    }
    if (model.note) formula.append(h(doc, "p", { class: "oi-info-note", text: model.note }));
    const storage = h(doc, "section", { class: "oi-info-block" }, [
      h(doc, "h3", { text: "本机保存" })
    ]);
    for (const row of model.storage || []) {
      storage.append(h(doc, "p", { class: "oi-info-store", "data-store": row.key, text: row.text }));
    }
    panel.append(progress, formula, storage);
  }

  function paintRecent(panel) {
    if (recentState.phase === "blank") {
      panel.append(skeleton());
      return;
    }
    if (recentState.phase === "blocked") {
      panel.append(blockedBlock());
      return;
    }
    const rows = recentState.rows || [];
    if (!rows.length) {
      panel.append(h(doc, "div", { class: "oi-drawer-empty" }, [
        h(doc, "p", { class: "oi-drawer-empty-title", text: "还没有其他论文" })
      ]));
      return;
    }
    const list = h(doc, "div", { class: "oi-recent-list", role: "group", "aria-label": "最近" });
    rows.forEach((row, index) => {
      const flag = rowFlags.get(row.docHash);
      const title = libraryRowTitle(row).title;
      const button = h(doc, "button", {
        type: "button",
        class: "oi-recent-row",
        "data-recent": row.docHash,
        tabindex: index === activeRecent ? "0" : "-1",
        title
      });
      if (flag?.kind === "downloading") {
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
      }
      button.append(h(doc, "span", { class: "oi-recent-title", text: title }));
      const meta = flag?.kind === "downloading"
        ? LIBRARY_COPY.downloading
        : flag?.kind === "failed"
          ? "没能打开 PDF，稍后再试一次。"
          : recentMeta(row, api.now?.() || Date.now());
      const metaClass = flag?.kind === "failed" ? "oi-recent-meta is-warn" : "oi-recent-meta";
      button.append(h(doc, "span", { class: metaClass, text: meta }));
      button.addEventListener("click", () => {
        if (button.disabled) return;
        activeRecent = index;
        void openRecent(row);
      });
      list.append(button);
    });
    panel.append(list);
  }

  async function openRecent(row) {
    if (!row || rowFlags.get(row.docHash)?.kind === "downloading") return;
    const result = await api.openPaper?.(row.docHash, {
      from: "drawer",
      title: libraryRowTitle(row).title,
      onStatus(status) {
        if (status?.status === "downloading") setRowFlag(row.docHash, "downloading");
      }
    });
    if (!result) return;
    if (result.status === "opened" || result.status === "current") {
      rowFlags.delete(row.docHash);
      return;
    }
    if (result.status === "needs-file") {
      if (width() < 900) close(true, { focus: false });
      api.showRepick?.(result);
      return;
    }
    if (result.status === "failed" || result.status === "blocked" || result.status === "missing") {
      setRowFlag(row.docHash, "failed");
      const hash = row.docHash;
      timers.setTimeout(() => {
        if (rowFlags.get(hash)?.kind === "failed") {
          rowFlags.delete(hash);
          if (open && tab === "recent") render();
        }
      }, 4000);
    }
  }

  function setRowFlag(hash, kind) {
    rowFlags.set(hash, { kind });
    if (open && tab === "recent") render();
  }

  async function loadInfo(force) {
    if (!force && infoState.phase === "ready") return;
    const gen = ++infoGen;
    if (infoState.phase === "blank") {
      infoState = { phase: "blank", model: infoState.model };
      if (open && tab === "info") render();
    }
    try {
      const model = await api.info?.();
      if (gen !== infoGen) return;
      infoState = { phase: "ready", model: model || null };
    } catch (error) {
      if (gen !== infoGen) return;
      infoState = { phase: isStorageBlocked(error) ? "blocked" : "ready", model: null };
    }
    if (open && tab === "info") render();
  }

  async function loadRecent(force) {
    if (!force && recentState.phase === "ready") return;
    const gen = ++recentGen;
    if (recentState.phase === "blank") {
      recentState = { phase: "blank", rows: recentState.rows };
      if (open && tab === "recent") render();
    }
    try {
      const rows = await api.recent?.();
      if (gen !== recentGen) return;
      recentState = { phase: "ready", rows: rows || [] };
    } catch (error) {
      if (gen !== recentGen) return;
      recentState = { phase: isStorageBlocked(error) ? "blocked" : "ready", rows: [] };
    }
    if (open && tab === "recent") render();
  }

  function render({ keepScroll = false } = {}) {
    if (!keepScroll) rememberScroll();
    const narrow = width() < 900;
    const head = h(doc, "header", { class: "oi-drawer-head" });
    if (narrow) {
      const back = h(doc, "button", { type: "button", class: "oi-drawer-back", text: LIBRARY_COPY.back });
      back.addEventListener("click", () => close(true));
      head.append(back);
    }
    const tabs = h(doc, "div", { class: "view-seg oi-drawer-tabs", role: "tablist", "aria-label": "目录与说明" });
    for (const item of TABS) {
      const button = h(doc, "button", {
        type: "button",
        class: "view-seg-btn oi-drawer-tab",
        role: "tab",
        id: `oiDrawerTab-${item.id}`,
        "aria-controls": `oiDrawerPanel-${item.id}`,
        "aria-selected": item.id === tab ? "true" : "false",
        tabindex: item.id === tab ? "0" : "-1",
        text: item.label
      });
      button.addEventListener("click", () => selectTab(item.id, false));
      tabs.append(button);
    }
    const closeBtn = h(doc, "button", {
      type: "button",
      class: "oi-drawer-close",
      "aria-label": "关闭目录",
      title: "关闭",
      text: "×"
    });
    closeBtn.addEventListener("click", () => close(true));
    head.append(tabs, h(doc, "span", { class: "oi-drawer-spacer" }), closeBtn);
    const panel = h(doc, "div", {
      class: "oi-drawer-scroll",
      role: "tabpanel",
      id: `oiDrawerPanel-${tab}`,
      "aria-labelledby": `oiDrawerTab-${tab}`
    });
    if (tab === "toc") paintToc(panel);
    else if (tab === "info") paintInfo(panel);
    else paintRecent(panel);
    const foot = tab === "recent"
      ? h(doc, "footer", { class: "oi-drawer-foot" }, [
        h(doc, "button", { type: "button", class: "btn-secondary oi-drawer-library", text: "打开文献库" })
      ])
      : null;
    foot?.querySelector("button")?.addEventListener("click", () => api.openLibrary?.());
    root.replaceChildren(head, panel, ...(foot ? [foot] : []));
    syncChrome();
    restoreScroll();
  }

  function selectTab(next, fromKey) {
    if (!TABS.some((item) => item.id === next) || next === tab) {
      if (fromKey) focus(root.querySelector(`[role="tab"][aria-selected="true"]`));
      return;
    }
    rememberScroll();
    tab = next;
    sessionSet(TAB_KEY, tab);
    render({ keepScroll: true });
    if (tab === "info") {
      void loadInfo(infoStale);
      infoStale = false;
    }
    if (tab === "recent") {
      void loadRecent(recentStale);
      recentStale = false;
    }
    if (fromKey) focus(root.querySelector(`[role="tab"][aria-selected="true"]`));
  }

  function moveTab(key) {
    const index = TABS.findIndex((item) => item.id === tab);
    if (key === "Home") selectTab(TABS[0].id, true);
    else if (key === "End") selectTab(TABS[TABS.length - 1].id, true);
    else if (key === "ArrowRight") selectTab(TABS[Math.min(TABS.length - 1, index + 1)].id, true);
    else if (key === "ArrowLeft") selectTab(TABS[Math.max(0, index - 1)].id, true);
  }

  function moveList(event, selector, kind) {
    const buttons = [...root.querySelectorAll(selector)];
    if (!buttons.length) return;
    const active = buttons.findIndex((button) => button === doc.activeElement || button.contains(doc.activeElement));
    let index = active >= 0 ? active : 0;
    if (event.key === "ArrowDown") index = Math.min(buttons.length - 1, index + 1);
    else if (event.key === "ArrowUp") index = Math.max(0, index - 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = buttons.length - 1;
    else return;
    event.preventDefault();
    if (kind === "toc") activeToc = index;
    else activeRecent = index;
    buttons.forEach((button, at) => {
      button.tabIndex = at === index ? 0 : -1;
    });
    focus(buttons[index]);
  }

  function onKey(event) {
    if (event.key === "Tab" && open && mode !== "dock") {
      const items = [...root.querySelectorAll("button, a, input, select, textarea")].filter((node) => {
        if (node.disabled || node.hidden) return false;
        const attr = node.getAttribute("tabindex");
        return attr == null || Number(attr) >= 0;
      });
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = doc.activeElement;
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        focus(last);
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        focus(first);
      }
      return;
    }
    if (event.target?.closest?.('[role="tablist"]') && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      moveTab(event.key);
      return;
    }
    if (tab === "toc" && event.target?.closest?.(".oi-toc-list")) {
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        moveList(event, ".oi-toc-item", "toc");
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        const button = event.target.closest?.(".oi-toc-item");
        if (!button) return;
        event.preventDefault();
        button.click();
      }
    }
    if (tab === "recent" && event.target?.closest?.(".oi-recent-list")) {
      if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        moveList(event, ".oi-recent-row", "recent");
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        const button = event.target.closest?.(".oi-recent-row");
        if (!button || button.disabled) return;
        event.preventDefault();
        button.click();
      }
    }
  }

  function readCurrent() {
    if (typeof api.currentIndex !== "function") return;
    const index = Number(api.currentIndex());
    if (!Number.isInteger(index)) return;
    current = index;
    activeToc = index;
  }

  function openPanel(meta = {}) {
    if (open) return;
    open = true;
    trigger = meta.trigger || null;
    tab = readTab();
    if (typeof api.mode === "function") {
      const next = api.mode();
      if (next === "dock" || next === "float" || next === "sheet") mode = next;
    }
    readCurrent();
    syncChrome();
    render({ keepScroll: true });
    api.onOpenChange?.(true, meta);
    if (tab === "info") {
      void loadInfo(infoStale);
      infoStale = false;
    }
    if (tab === "recent") {
      void loadRecent(true);
      recentStale = false;
    }
    if (meta.focus !== false) focusEntry();
  }

  function close(focusButton = true, meta = {}) {
    if (!open) return false;
    rememberScroll();
    open = false;
    syncChrome();
    api.onOpenChange?.(false, meta);
    const restore = focusButton && meta.focus !== false;
    const preferred = meta.trigger || trigger;
    if (restore) focus(shown(preferred) ? preferred : returnTarget());
    return true;
  }

  root.addEventListener("keydown", onKey);
  doc.addEventListener("focusin", (event) => {
    if (!open || mode === "dock") return;
    const target = event.target;
    if (root.contains(target)) return;
    if (target?.closest?.("#sideSlot, .oi-library, .oi-notes, .oi-ask")) return;
    const landing = root.querySelector('.oi-toc-item[aria-current="location"], .oi-toc-item, [role="tab"][aria-selected="true"]');
    focus(landing || root);
  });
  backdrop?.addEventListener("click", () => {
    if (open && mode === "float") close(true);
  });
  win.addEventListener?.("resize", () => {
    if (!open) return;
    root.classList.toggle("is-narrow-type", width() > 0 && width() < 340);
    const wasNarrow = root.classList.contains("is-sheet");
    const nowNarrow = width() < 900 && mode !== "dock";
    if (wasNarrow !== (mode === "sheet") || nowNarrow) render();
  });

  return {
    root,
    slot,
    open: openPanel,
    close,
    toggle(meta) {
      if (open) close(true, meta);
      else openPanel(meta);
    },
    isOpen: () => open,
    isModal: () => open && mode !== "dock",
    isDocked: () => open && mode === "dock",
    consumeEscape() {
      if (!open) return false;
      close(true);
      return true;
    },
    refresh() {
      timers.clearTimeout(refreshTimer);
      refreshTimer = timers.setTimeout(() => {
        refreshTimer = 0;
        if (!open) {
          infoStale = true;
          recentStale = true;
          return;
        }
        infoStale = false;
        recentStale = false;
        if (tab === "info" || infoState.phase !== "blank") void loadInfo(true);
        if (tab === "recent" || recentState.phase !== "blank") void loadRecent(true);
      }, 160);
    },
    setTab(next) {
      selectTab(next, false);
    },
    setToc(next) {
      const incoming = next || { source: "", entries: [], partial: "", loading: false };
      const signature = `${incoming.source}|${incoming.partial}|${incoming.loading}|${(incoming.entries || []).map((entry) => [
        entry.level, entry.num, entry.page, entry.title, entry.translated ? 1 : 0
      ].join(":")).join("\n")}`;
      toc = incoming;
      if (signature === tocSignature) return;
      tocSignature = signature;
      if (open && tab === "toc") render();
    },
    setCurrent(index) {
      const next = Number.isInteger(index) ? index : -1;
      if (next === current) return;
      current = next;
      if (!open || tab !== "toc") return;
      const buttons = [...root.querySelectorAll(".oi-toc-item")];
      if (!buttons.length) return;
      buttons.forEach((button, at) => {
        if (at === current) button.setAttribute("aria-current", "location");
        else button.removeAttribute("aria-current");
      });
      const node = buttons[current];
      if (!node) return;
      const active = doc.activeElement;
      if (active && root.contains(active) && active.closest?.(".oi-toc-list")) return;
      try {
        node.scrollIntoView?.({ block: "nearest" });
      } catch {
        /* scroll is best-effort */
      }
    },
    setMode(next) {
      const resolved = next === "dock" || next === "sheet" ? next : "float";
      if (resolved === mode) {
        syncChrome();
        return;
      }
      mode = resolved;
      if (open) {
        syncChrome();
        const narrowHead = Boolean(root.querySelector(".oi-drawer-back"));
        if ((mode === "sheet") !== narrowHead) render();
      } else syncChrome();
    },
    scrollTop(which = tab) {
      if (which === tab) rememberScroll();
      return scrollTops[which] || 0;
    },
    tab: () => tab
  };
}
