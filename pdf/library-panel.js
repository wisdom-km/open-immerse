/**
 * Library side panel. One pane at a time is the viewer's job.
 * Copy lives in lib/library-copy.js.
 */

import { countTranslated } from "../lib/library-record.js";
import { resolveLibraryOpen } from "../lib/pdf-library.js";
import { BLOCKED_TITLE, STORAGE_POLL_MS, blockedReasonCopy, isStorageBlocked } from "../lib/storage-copy.js";
import {
  LIBRARY_COPY,
  consumeLibrarySort,
  deleteWillCopy,
  libraryDeleteAllowed,
  libraryNoHitCopy,
  libraryPanelPhase,
  libraryProgressCopy,
  libraryRelativeTime,
  libraryRowTitle,
  librarySearchHit,
  librarySizeCopy,
  librarySourceIsLocalFile,
  libraryToastDeleted,
  sortLibraryRows
} from "../lib/library-copy.js";

function h(doc, tag, attrs, children) {
  const el = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "text") el.textContent = String(value);
    else if (key === "hidden") el.hidden = Boolean(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children || []) {
    if (child) el.append(child);
  }
  return el;
}

export function mountLibraryUi(api = {}) {
  const slot = api.slot || document.getElementById("sideSlot");
  const doc = slot?.ownerDocument || document;
  const win = doc.defaultView || globalThis;
  const timers = api.timers || win;
  if (!slot) {
    return {
      open() {},
      close() {},
      toggle() {},
      isOpen: () => false,
      consumeEscape: () => false,
      refresh() {}
    };
  }
  const root = h(doc, "aside", {
    class: "oi-library",
    role: "complementary",
    "aria-label": LIBRARY_COPY.title,
    "data-side-panel": "library",
    hidden: true
  });
  slot.append(root);

  let open = false;
  let trigger = null;
  let rows = [];
  let usage = null;
  let phase = "blank";
  let query = "";
  let pendingQuery = "";
  let searchTimer = 0;
  let sort = "";
  let sortConsumed = false;
  let confirmHash = "";
  let active = 0;
  let column = "row";
  let poll = 0;
  let loadGen = 0;
  let repick = null;
  let readingHash = "";

  function now() {
    return typeof api.now === "function" ? api.now() : Date.now();
  }

  function width() {
    if (typeof api.width === "function") return Number(api.width()) || 0;
    return Number(win.innerWidth) || 1200;
  }

  function narrow() {
    const w = width();
    if (w > 0) return w < 900;
    try {
      return win.matchMedia?.("(max-width: 899px)")?.matches === true;
    } catch {
      return false;
    }
  }

  function syncChrome(next, meta = {}) {
    root.hidden = !next;
    root.classList.toggle("is-open", next);
    root.classList.toggle("is-sheet", next && narrow());
    const button = doc.getElementById("libraryButton");
    if (button) {
      button.setAttribute("aria-pressed", next ? "true" : "false");
      if (next) button.setAttribute("data-open", "true");
      else button.removeAttribute("data-open");
    }
    api.onOpenChange?.(next, meta);
  }

  function visibleRows() {
    const filtered = rows.filter((row) => librarySearchHit(row, query));
    return sortLibraryRows(filtered, sort);
  }

  function focusTarget(selector) {
    const el = root.querySelector(selector);
    try {
      el?.focus?.();
    } catch {
      /* the host may not focus */
    }
    return el;
  }

  function moveFocusAfterDelete(index, list) {
    const next = list[index] || list[index - 1];
    if (next) {
      active = rows.findIndex((row) => row.docHash === next.docHash);
      if (active < 0) active = 0;
      render();
      focusTarget(`[data-lib-row="${next.docHash}"]`);
      return;
    }
    render();
    focusTarget("[data-lib-empty-open]");
  }

  async function refreshReading() {
    try {
      readingHash = String(await api.openHash?.() || "");
    } catch {
      readingHash = "";
    }
  }

  async function load(options = {}) {
    const gen = ++loadGen;
    const showBlank = options.keep !== true;
    if (showBlank) {
      phase = "blank";
      render();
    }
    try {
      if (typeof api.delay === "function") await api.delay();
      const store = await api.store();
      const papers = await store.listPapers();
      if (gen !== loadGen) return;
      const pagesOf = typeof store.getPages === "function" ? store.getPages.bind(store) : async () => [];
      const notesOf = api.listNotes || (async () => []);
      let nextUsage = null;
      try {
        nextUsage = await store.usage();
      } catch {
        nextUsage = null;
      }
      const built = [];
      for (const paper of papers || []) {
        const pages = await pagesOf(paper.docHash);
        if (gen !== loadGen) return;
        let notes = [];
        try {
          notes = await notesOf(paper.docHash) || [];
        } catch {
          notes = [];
        }
        const translated = countTranslated(pages);
        const bytes = nextUsage?.byDoc?.get?.(paper.docHash) || Number(paper.sourceSize) || 0;
        built.push({
          ...paper,
          translated,
          notes: notes.length,
          bytes,
          hasSource: Number(paper.sourceSize) > 0
        });
      }
      if (gen !== loadGen) return;
      rows = built;
      usage = nextUsage;
      phase = libraryPanelPhase({ count: rows.length });
      if (poll) {
        timers.clearInterval(poll);
        poll = 0;
      }
    } catch (error) {
      if (gen !== loadGen) return;
      if (!isStorageBlocked(error)) {
        phase = "blocked";
      } else phase = "blocked";
      root.dataset.blocked = "true";
      armPoll();
    }
    if (confirmHash && !rows.some((row) => row.docHash === confirmHash)) confirmHash = "";
    await refreshReading();
    if (gen === loadGen) render();
  }

  function armPoll() {
    if (poll) return;
    poll = timers.setInterval(() => {
      void load({ keep: true });
    }, api.pollMs || STORAGE_POLL_MS);
  }

  async function openRow(row) {
    if (!row) return;
    repick = null;
    let resolved;
    try {
      resolved = await resolveLibraryOpen(row.docHash, { store: await api.store(), fetch: undefined });
    } catch (error) {
      if (isStorageBlocked(error)) {
        phase = "blocked";
        render();
        return;
      }
      throw error;
    }
    if (resolved.status === "local") {
      await api.openBytes?.(resolved.bytes, libraryRowTitle(row).title);
      close(true);
      return;
    }
    if (resolved.status === "needs-network") {
      let again;
      try {
        again = await resolveLibraryOpen(row.docHash, {
          store: await api.store(),
          fetch: api.fetch || win.fetch.bind(win)
        });
      } catch {
        again = { status: "needs-file" };
      }
      if (again.status === "downloaded") {
        await api.openBytes?.(again.bytes, libraryRowTitle(row).title);
        close(true);
        return;
      }
      repick = { hash: row.docHash, title: libraryRowTitle(row).title, changed: again.status === "hash-mismatch" && again.via === "url", warn: false };
      render();
      return;
    }
    repick = {
      hash: row.docHash,
      title: libraryRowTitle(row).title,
      changed: resolved.status === "hash-mismatch" && resolved.via === "url",
      warn: resolved.status === "hash-mismatch" && resolved.via === "file"
    };
    render();
  }

  async function pickFile(file) {
    if (!repick || !file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const matched = await resolveLibraryOpen(repick.hash, {
      store: await api.store(),
      fileBytes: bytes
    });
    if (matched.status === "file") {
      await api.openBytes?.(matched.bytes, repick.title);
      repick = null;
      close(true);
      return;
    }
    repick = { ...repick, warn: true, changed: repick.changed };
    render();
  }

  async function commitDelete(row, withNotes) {
    if (!libraryDeleteAllowed(readingHash, row.docHash)) return;
    const store = await api.store();
    const report = await store.deletePaperData(row.docHash, {
      notes: withNotes === true,
      formula: true,
      readingHash
    });
    if (report?.refused === "reading") return;
    const list = visibleRows();
    const index = list.findIndex((item) => item.docHash === row.docHash);
    confirmHash = "";
    api.toast?.(libraryToastDeleted(libraryRowTitle(row).title));
    await load({ keep: true });
    moveFocusAfterDelete(index, list.filter((item) => item.docHash !== row.docHash));
  }

  function render() {
    const sheet = narrow();
    root.classList.toggle("is-sheet", open && sheet);
    const shown = phase === "list" ? visibleRows() : [];
    if (active >= shown.length) active = Math.max(0, shown.length - 1);
    const head = h(doc, "header", { class: "oi-lib-head" }, [
      h(doc, "button", {
        type: "button",
        class: "oi-lib-back",
        text: LIBRARY_COPY.back,
        hidden: !sheet
      }),
      h(doc, "h2", { text: LIBRARY_COPY.title }),
      h(doc, "button", {
        type: "button",
        class: "oi-lib-close",
        "aria-label": LIBRARY_COPY.close,
        text: "×"
      })
    ]);
    head.querySelector(".oi-lib-back")?.addEventListener("click", () => close(true));
    head.querySelector(".oi-lib-close")?.addEventListener("click", () => close(true));

    const search = h(doc, "div", { class: "oi-lib-search", hidden: rows.length < 8 });
    const input = h(doc, "input", {
      type: "search",
      "aria-label": LIBRARY_COPY.search,
      placeholder: LIBRARY_COPY.search,
      value: pendingQuery || query
    });
    input.addEventListener("input", () => {
      pendingQuery = input.value;
      if (searchTimer) timers.clearTimeout(searchTimer);
      searchTimer = timers.setTimeout(() => {
        query = pendingQuery;
        pendingQuery = "";
        searchTimer = 0;
        render();
      }, api.searchMs ?? 150);
    });
    search.append(input);

    const body = h(doc, "div", { class: "oi-lib-body" });
    if (phase === "blank") {
      body.append(h(doc, "div", { class: "oi-lib-blank", "aria-hidden": "true" }));
    } else if (phase === "blocked") {
      const reason = blockedReasonCopy("blocked");
      body.append(h(doc, "div", { class: "oi-lib-blocked" }, [
        h(doc, "p", { class: "oi-lib-blocked-title", text: BLOCKED_TITLE || LIBRARY_COPY.blockedTitle }),
        h(doc, "p", { text: reason.reason }),
        h(doc, "button", { type: "button", class: "btn-secondary oi-lib-retry", text: LIBRARY_COPY.retry })
      ]));
      body.querySelector(".oi-lib-retry")?.addEventListener("click", () => {
        void load();
      });
    } else if (phase === "empty") {
      body.append(h(doc, "div", { class: "oi-lib-empty" }, [
        h(doc, "p", { text: LIBRARY_COPY.empty }),
        h(doc, "button", {
          type: "button",
          class: "btn-primary",
          "data-lib-empty-open": "true",
          text: LIBRARY_COPY.openPdf
        }),
        h(doc, "a", { href: api.importHref || "../options/options.html#data?focus=import", text: LIBRARY_COPY.import })
      ]));
      body.querySelector("[data-lib-empty-open]")?.addEventListener("click", () => api.pickPdf?.());
    } else {
      const list = h(doc, "div", { class: "oi-lib-list", role: "listbox", tabindex: "0", "aria-label": LIBRARY_COPY.title });
      if (!shown.length && query) {
        list.append(h(doc, "div", { class: "oi-lib-miss" }, [
          h(doc, "p", { text: libraryNoHitCopy(query) }),
          h(doc, "button", { type: "button", class: "btn-secondary", text: LIBRARY_COPY.clearSearch })
        ]));
        list.querySelector("button")?.addEventListener("click", () => {
          query = "";
          pendingQuery = "";
          render();
        });
      }
      shown.forEach((row, index) => {
        const title = libraryRowTitle(row);
        const reading = readingHash && readingHash === row.docHash;
        const item = h(doc, "div", {
          class: "oi-lib-row",
          role: "option",
          "data-lib-row": row.docHash,
          tabindex: index === active && column === "row" ? "0" : "-1",
          "aria-selected": index === active ? "true" : "false"
        });
        const main = h(doc, "button", { type: "button", class: "oi-lib-open" }, [
          h(doc, "span", { class: "oi-lib-name", text: title.title }),
          h(doc, "span", { class: "oi-lib-meta", text: [libraryProgressCopy(row.translated, row.pageCount), libraryRelativeTime(row.lastOpenedAt, now()), librarySizeCopy(row.bytes)].filter(Boolean).join(" · ") })
        ]);
        if (reading) main.append(h(doc, "span", { class: "oi-lib-badge", text: LIBRARY_COPY.reading }));
        main.addEventListener("click", () => {
          active = index;
          void openRow(row);
        });
        const trash = h(doc, "button", {
          type: "button",
          class: "oi-lib-trash",
          "aria-label": LIBRARY_COPY.delete,
          title: reading ? LIBRARY_COPY.readingReason : LIBRARY_COPY.delete,
          text: "🗑",
          tabindex: index === active && column === "delete" ? "0" : "-1"
        });
        if (reading || !libraryDeleteAllowed(readingHash, row.docHash)) trash.disabled = true;
        trash.addEventListener("click", () => {
          if (trash.disabled) return;
          confirmHash = confirmHash === row.docHash ? "" : row.docHash;
          active = index;
          column = "delete";
          render();
          focusTarget(".oi-lib-cancel");
        });
        item.append(main, trash);
        if (confirmHash === row.docHash) {
          const notesBox = row.notes > 0
            ? h(doc, "label", { class: "oi-lib-notes" }, [
              h(doc, "input", { type: "checkbox", "data-lib-notes": "true" }),
              h(doc, "span", { text: "同时删除笔记" })
            ])
            : null;
          const card = h(doc, "div", { class: "oi-lib-confirm" }, [
            h(doc, "p", { text: deleteWillCopy({ pages: row.translated, hasSource: row.hasSource, localFile: librarySourceIsLocalFile(row) }) }),
            h(doc, "p", { text: LIBRARY_COPY.keepFile }),
            notesBox,
            h(doc, "div", { class: "oi-lib-confirm-actions" }, [
              h(doc, "button", { type: "button", class: "btn-secondary oi-lib-cancel", text: LIBRARY_COPY.cancel }),
              h(doc, "button", { type: "button", class: "btn-primary oi-lib-do-delete", text: LIBRARY_COPY.confirmDelete })
            ])
          ]);
          card.querySelector(".oi-lib-cancel")?.addEventListener("click", () => {
            confirmHash = "";
            render();
            focusTarget(`[data-lib-row="${row.docHash}"] .oi-lib-trash`);
          });
          card.querySelector(".oi-lib-do-delete")?.addEventListener("click", () => {
            const checked = card.querySelector("[data-lib-notes]")?.checked === true;
            void commitDelete(row, checked);
          });
          item.append(card);
        }
        if (repick && repick.hash === row.docHash) {
          const file = h(doc, "input", { type: "file", accept: "application/pdf,.pdf", hidden: true });
          const hint = h(doc, "div", { class: "oi-lib-repick" }, [
            h(doc, "p", { text: LIBRARY_COPY.repick }),
            repick.changed ? h(doc, "p", { class: "oi-lib-muted", text: LIBRARY_COPY.urlChanged }) : null,
            repick.warn ? h(doc, "p", { class: "oi-lib-warn", text: LIBRARY_COPY.fileMismatch }) : null,
            h(doc, "button", {
              type: "button",
              class: "btn-secondary oi-lib-pick",
              text: repick.warn ? LIBRARY_COPY.pickOther : LIBRARY_COPY.pickFile
            }),
            file
          ]);
          hint.querySelector(".oi-lib-pick")?.addEventListener("click", () => file.click());
          let readingFile = false;
          file.addEventListener("change", () => {
            if (readingFile) return;
            const chosen = file.files?.[0];
            readingFile = true;
            try {
              file.value = "";
            } catch {
              /* a host that cannot reset the input still accepts the chosen file */
            }
            readingFile = false;
            if (chosen) void pickFile(chosen);
          });
          item.append(hint);
        }
        list.append(item);
      });
      list.addEventListener("keydown", onListKey);
      body.append(list);
    }

    const total = usage?.byDoc
      ? [...usage.byDoc.values()].reduce((sum, n) => sum + (Number(n) || 0), 0)
      : rows.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
    const foot = h(doc, "footer", {
      class: "oi-lib-foot",
      text: `${librarySizeCopy(total) || "约 0 B"} · ${rows.length} 篇`
    });
    root.replaceChildren(head, search, body, foot);
    if (confirmHash) focusTarget(".oi-lib-cancel");
  }

  function onListKey(event) {
    const list = visibleRows();
    if (!list.length) return;
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      active = key === "ArrowDown" ? Math.min(list.length - 1, active + 1) : Math.max(0, active - 1);
      column = "row";
      render();
      focusTarget(`[data-lib-row="${list[active].docHash}"]`);
      return;
    }
    if (key === "ArrowRight" || key === "ArrowLeft") {
      event.preventDefault();
      column = key === "ArrowRight" ? "delete" : "row";
      render();
      const hash = list[active]?.docHash;
      focusTarget(column === "delete" ? `[data-lib-row="${hash}"] .oi-lib-trash` : `[data-lib-row="${hash}"]`);
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      if (column === "delete") {
        const row = list[active];
        if (row && libraryDeleteAllowed(readingHash, row.docHash)) {
          confirmHash = row.docHash;
          render();
          focusTarget(".oi-lib-cancel");
        }
        return;
      }
      void openRow(list[active]);
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      const row = list[active];
      if (!row || !libraryDeleteAllowed(readingHash, row.docHash)) return;
      event.preventDefault();
      confirmHash = row.docHash;
      render();
      focusTarget(".oi-lib-cancel");
    }
  }

  function applySortFromHash() {
    if (sortConsumed) return true;
    const read = consumeLibrarySort(api.hash?.() ?? win.location?.hash, false);
    if (!read.consumed) return false;
    sortConsumed = true;
    if (read.sort) sort = read.sort;
    root.dataset.sort = sort || "recent";
    return true;
  }

  function openPanel(meta = {}) {
    trigger = meta.trigger || doc.activeElement || doc.getElementById("libraryButton");
    if (!applySortFromHash()) {
      win.requestAnimationFrame?.(() => {
        if (applySortFromHash() && open) render();
      });
    }
    open = true;
    root.dataset.sort = sort || "recent";
    syncChrome(true, meta);
    void load();
  }

  function close(focusButton = true, meta = {}) {
    if (!open && !root.classList.contains("is-open")) return;
    open = false;
    confirmHash = "";
    syncChrome(false, meta);
    if (focusButton && meta.handoff !== true && meta.focus !== false) {
      const preferred = meta.trigger || trigger;
      const back = preferred && preferred.isConnected !== false ? preferred : doc.getElementById("libraryButton");
      try {
        back?.focus?.();
      } catch {
        /* ignore */
      }
    }
  }

  win.addEventListener?.("resize", () => {
    if (open) render();
  });
  win.addEventListener?.("hashchange", () => {
    if (sortConsumed) return;
    const read = consumeLibrarySort(api.hash?.() ?? win.location?.hash, false);
    if (!read.consumed) return;
    sortConsumed = true;
    if (read.sort) sort = read.sort;
    root.dataset.sort = sort || "recent";
    if (open) render();
    else openPanel({ reason: "hash" });
  });

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (confirmHash) {
      event.preventDefault();
      event.stopPropagation();
      const hash = confirmHash;
      confirmHash = "";
      render();
      focusTarget(`[data-lib-row="${hash}"] .oi-lib-trash`);
    }
  });

  return {
    root,
    open: openPanel,
    close,
    toggle(meta) {
      if (open) close(true, meta);
      else openPanel(meta);
    },
    isOpen: () => open,
    consumeEscape() {
      if (!open) return false;
      if (confirmHash) {
        const hash = confirmHash;
        confirmHash = "";
        render();
        focusTarget(`[data-lib-row="${hash}"] .oi-lib-trash`);
        return true;
      }
      close(true);
      return true;
    },
    refresh() {
      if (open) void load({ keep: true });
    },
    setReadingHash(hash) {
      readingHash = String(hash || "");
      if (open) render();
    }
  };
}
