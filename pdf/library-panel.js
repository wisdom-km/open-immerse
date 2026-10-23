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
  libraryFooterCopy,
  libraryHeaderCount,
  libraryNoHitCopy,
  libraryNotesDeleteCopy,
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

const SVG_NS = "http://www.w3.org/2000/svg";

function trashIcon(doc) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M6.1 1.8h3.8l.45.9H13v1.3H3V2.7h2.65l.45-.9zM4.15 5.1h7.7l-.55 8.05a1 1 0 0 1-1 .85H5.7a1 1 0 0 1-1-.85L4.15 5.1z");
  svg.append(path);
  return svg;
}

function deleteLabel(title) {
  return `${LIBRARY_COPY.delete}《${title}》`;
}

function cssEscape(value) {
  const text = String(value ?? "");
  const esc = globalThis.CSS?.escape;
  if (typeof esc === "function") return esc(text);
  return text.replace(/(["\\])/g, "\\$1");
}

function rowSelector(hash) {
  return `[data-lib-row="${cssEscape(hash)}"]`;
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
  let searchTimer = 0;
  let sort = "";
  let sortConsumed = false;
  let confirmHash = "";
  let deleteFailed = false;
  let deleting = false;
  let active = 0;
  let column = "row";
  let poll = 0;
  let loadGen = 0;
  let repick = null;
  let readingHash = "";
  let shell = null;
  let openingHash = "";
  let downloadingHash = "";
  let openError = "";

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

  function focusRowControl(hash, kind) {
    if (kind === "delete") {
      const trash = root.querySelector(`${rowSelector(hash)} .oi-lib-trash`);
      if (trash && trash.disabled !== true) {
        try {
          trash.focus?.();
        } catch {
          /* the host may not focus */
        }
        return trash;
      }
    }
    return focusTarget(`${rowSelector(hash)} .oi-lib-open`);
  }

  function focusAfterClose(preferred) {
    const button = doc.getElementById("libraryButton");
    const node = preferred && preferred.nodeType === 1 ? preferred : null;
    let hidden = false;
    try {
      hidden = node?.hidden === true || Boolean(node?.closest?.("[hidden]"));
    } catch {
      hidden = false;
    }
    const usable = node && node !== doc.body && node !== doc.documentElement && !hidden;
    const back = usable ? node : button;
    try {
      back?.focus?.();
    } catch {
      /* ignore */
    }
  }

  function fetchWithin(url, ms, onTimeout) {
    const fetchImpl = typeof api.fetch === "function" ? api.fetch : win.fetch.bind(win);
    const limit = Number(ms) > 0 ? Number(ms) : 20000;
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        if (typeof onTimeout === "function") onTimeout();
        reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
      }, limit);
    });
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const pending = Promise.resolve().then(() => fetchImpl(url, ctl ? { signal: ctl.signal } : undefined));
    return Promise.race([pending, timeout]).then((value) => {
      timers.clearTimeout(timer);
      return value;
    }, (error) => {
      timers.clearTimeout(timer);
      try {
        ctl?.abort();
      } catch {
        /* the download already failed */
      }
      throw error;
    });
  }

  async function revealBytes(bytes, title, hash) {
    try {
      await api.openBytes?.(bytes, title);
      return true;
    } catch {
      openError = hash;
      return false;
    }
  }

  function moveFocusAfterDelete(index, list) {
    const next = list[index] || list[index - 1];
    if (next) {
      active = rows.findIndex((row) => row.docHash === next.docHash);
      if (active < 0) active = 0;
      render();
      focusRowControl(next.docHash, "row");
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

  function stopPoll() {
    if (!poll) return;
    timers.clearInterval(poll);
    poll = 0;
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
      delete root.dataset.blocked;
      stopPoll();
    } catch (error) {
      if (gen !== loadGen) return;
      if (isStorageBlocked(error)) {
        phase = "blocked";
        root.dataset.blocked = "true";
        armPoll();
      } else {
        delete root.dataset.blocked;
        phase = rows.length ? "list" : "empty";
      }
    }
    if (confirmHash && !rows.some((row) => row.docHash === confirmHash)) confirmHash = "";
    await refreshReading();
    if (gen === loadGen) render();
  }

  function armPoll() {
    if (!open || poll) return;
    poll = timers.setInterval(() => {
      void load({ keep: true });
    }, api.pollMs || STORAGE_POLL_MS);
  }

  async function openRow(row) {
    if (!row || openingHash) return;
    if (readingHash && readingHash === row.docHash) {
      close(true);
      return;
    }
    const hash = row.docHash;
    const title = libraryRowTitle(row).title;
    openingHash = hash;
    openError = "";
    repick = null;
    try {
      const store = await api.store();
      const resolved = await resolveLibraryOpen(hash, { store, fetch: undefined });
      if (resolved.status === "local") {
        if (!(await revealBytes(resolved.bytes, title, hash))) return;
        close(true);
        return;
      }
      if (resolved.status === "needs-network") {
        downloadingHash = hash;
        render();
        let timedOut = false;
        const again = await resolveLibraryOpen(hash, {
          store: await api.store(),
          fetch: (url) => fetchWithin(url, api.downloadTimeoutMs ?? 20000, () => {
            timedOut = true;
          })
        }).catch(() => ({ status: "needs-file" }));
        downloadingHash = "";
        if (again.status === "downloaded") {
          if (!(await revealBytes(again.bytes, title, hash))) return;
          close(true);
          return;
        }
        if (timedOut) {
          openError = hash;
          return;
        }
        repick = {
          hash,
          title,
          changed: again.status === "hash-mismatch" && again.via === "url",
          warn: false
        };
        return;
      }
      repick = {
        hash,
        title,
        changed: resolved.status === "hash-mismatch" && resolved.via === "url",
        warn: resolved.status === "hash-mismatch" && resolved.via === "file"
      };
    } catch (error) {
      if (isStorageBlocked(error)) {
        phase = "blocked";
        root.dataset.blocked = "true";
        armPoll();
        return;
      }
      openError = hash;
    } finally {
      openingHash = "";
      downloadingHash = "";
      if (open) render();
    }
  }

  async function pickFile(file) {
    if (!repick || !file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const matched = await resolveLibraryOpen(repick.hash, {
      store: await api.store(),
      fileBytes: bytes
    });
    if (matched.status === "file") {
      const hash = repick.hash;
      const title = repick.title;
      if (!(await revealBytes(matched.bytes, title, hash))) {
        render();
        return;
      }
      repick = null;
      close(true);
      return;
    }
    repick = { ...repick, warn: true, changed: repick.changed };
    render();
  }

  async function commitDelete(row, withNotes) {
    if (deleting) return;
    if (!libraryDeleteAllowed(readingHash, row.docHash)) return;
    deleting = true;
    deleteFailed = false;
    render();
    try {
      const store = await api.store();
      const report = await store.deletePaperData(row.docHash, {
        notes: withNotes === true,
        formula: true,
        readingHash
      });
      if (report?.refused === "reading") {
        deleting = false;
        render();
        return;
      }
      const list = visibleRows();
      const index = list.findIndex((item) => item.docHash === row.docHash);
      confirmHash = "";
      deleting = false;
      api.toast?.(libraryToastDeleted(libraryRowTitle(row).title));
      await load({ keep: true });
      moveFocusAfterDelete(index, list.filter((item) => item.docHash !== row.docHash));
    } catch {
      deleting = false;
      deleteFailed = true;
      render();
      focusTarget(`${rowSelector(row.docHash)} .oi-lib-do-delete`);
    }
  }

  function ensureShell() {
    if (shell) return shell;
    const head = h(doc, "header", { class: "oi-lib-head" });
    const back = h(doc, "button", { type: "button", class: "oi-lib-back", text: LIBRARY_COPY.back });
    const titleBox = h(doc, "div", { class: "oi-lib-title" }, [
      h(doc, "h2", { text: LIBRARY_COPY.title }),
      h(doc, "span", { class: "oi-lib-count" })
    ]);
    const openPdf = h(doc, "button", { type: "button", class: "btn-secondary oi-lib-open-pdf" });
    const closeBtn = h(doc, "button", {
      type: "button",
      class: "oi-lib-close",
      "aria-label": LIBRARY_COPY.close,
      text: "×"
    });
    head.append(back, titleBox, h(doc, "span", { class: "oi-lib-spacer" }), openPdf, closeBtn);
    back.addEventListener("click", () => close(true));
    closeBtn.addEventListener("click", () => close(true));
    openPdf.addEventListener("click", () => api.pickPdf?.());

    const search = h(doc, "div", { class: "oi-lib-search" });
    const input = h(doc, "input", {
      type: "search",
      "aria-label": LIBRARY_COPY.search,
      placeholder: LIBRARY_COPY.search
    });
    input.addEventListener("input", () => {
      if (searchTimer) timers.clearTimeout(searchTimer);
      searchTimer = timers.setTimeout(() => {
        query = input.value;
        searchTimer = 0;
        render();
      }, api.searchMs ?? 150);
    });
    search.append(input);

    const body = h(doc, "div", { class: "oi-lib-body" });
    const foot = h(doc, "footer", { class: "oi-lib-foot" }, [
      h(doc, "span", { class: "oi-lib-foot-copy" }),
      h(doc, "a", {
        class: "oi-lib-storage",
        href: api.storageHref || "../options/options.html#data",
        text: LIBRARY_COPY.storageLink
      })
    ]);
    root.replaceChildren(head, search, body, foot);
    shell = { head, back, count: titleBox.querySelector(".oi-lib-count"), openPdf, search, input, body, foot, footCopy: foot.querySelector(".oi-lib-foot-copy") };
    return shell;
  }

  function heldListFocus() {
    const el = doc.activeElement;
    if (!el || el === shell?.input || !root.contains(el)) return null;
    const row = typeof el.closest === "function" ? el.closest("[data-lib-row]") : null;
    if (!row) return null;
    const hash = row.getAttribute("data-lib-row") || "";
    if (el.classList?.contains("oi-lib-trash")) return { hash, kind: "delete" };
    if (el.classList?.contains("oi-lib-cancel") || el.closest?.(".oi-lib-confirm")) return { hash, kind: "confirm" };
    return { hash, kind: "row" };
  }

  function render() {
    const nodes = ensureShell();
    const sheet = narrow();
    root.classList.toggle("is-sheet", open && sheet);
    const shown = phase === "list" ? visibleRows() : [];
    if (active >= shown.length) active = Math.max(0, shown.length - 1);
    const keep = heldListFocus();

    nodes.back.hidden = !sheet;
    nodes.count.textContent = libraryHeaderCount(rows.length);
    nodes.count.hidden = rows.length === 0;
    const showHeaderOpen = phase === "list";
    nodes.openPdf.hidden = !showHeaderOpen;
    if (sheet) {
      nodes.openPdf.textContent = "＋";
      nodes.openPdf.setAttribute("aria-label", LIBRARY_COPY.openPdf);
      nodes.openPdf.classList.add("is-icon");
    } else {
      nodes.openPdf.textContent = LIBRARY_COPY.openPdfHeader;
      nodes.openPdf.removeAttribute("aria-label");
      nodes.openPdf.classList.remove("is-icon");
    }
    nodes.search.hidden = rows.length < 8 || phase !== "list";
    if (doc.activeElement !== nodes.input && nodes.input.value !== query) nodes.input.value = query;

    const body = nodes.body;
    body.replaceChildren();
    if (phase === "blank") {
      body.append(h(doc, "div", { class: "oi-lib-blank", "aria-hidden": "true" }));
    } else if (phase === "blocked") {
      const reason = blockedReasonCopy("blocked");
      body.append(h(doc, "div", { class: "oi-lib-blocked" }, [
        h(doc, "p", { class: "oi-lib-blocked-title", text: BLOCKED_TITLE || LIBRARY_COPY.blockedTitle }),
        h(doc, "p", { text: reason.reason }),
        h(doc, "p", { class: "oi-lib-muted", text: "已经存好的译文和笔记都还在，没有丢。每 5 秒会自动重试一次。" }),
        h(doc, "button", { type: "button", class: "btn-secondary oi-lib-retry", text: LIBRARY_COPY.retry })
      ]));
      body.querySelector(".oi-lib-retry")?.addEventListener("click", () => {
        void load();
      });
    } else if (phase === "empty") {
      body.append(h(doc, "div", { class: "oi-lib-empty" }, [
        h(doc, "p", { class: "oi-lib-empty-title", text: LIBRARY_COPY.empty }),
        h(doc, "p", { class: "oi-lib-muted oi-lib-empty-body", text: LIBRARY_COPY.emptyBody }),
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
      const list = h(doc, "div", { class: "oi-lib-list", role: "group", "aria-label": LIBRARY_COPY.title });
      if (!shown.length && query) {
        list.append(h(doc, "div", { class: "oi-lib-miss" }, [
          h(doc, "p", { text: libraryNoHitCopy(query) }),
          h(doc, "p", { class: "oi-lib-muted", text: LIBRARY_COPY.searchHint }),
          h(doc, "button", { type: "button", class: "btn-secondary", text: LIBRARY_COPY.clearSearch })
        ]));
        list.querySelector("button")?.addEventListener("click", () => {
          query = "";
          render();
        });
      }
      shown.forEach((row, index) => {
        const title = libraryRowTitle(row);
        const reading = readingHash && readingHash === row.docHash;
        const item = h(doc, "div", {
          class: confirmHash === row.docHash ? "oi-lib-row is-confirm" : "oi-lib-row",
          "data-lib-row": row.docHash
        });
        const label = deleteLabel(title.title);
        const main = h(doc, "button", {
          type: "button",
          class: "oi-lib-open",
          tabindex: index === active && column === "row" ? "0" : "-1",
          disabled: openingHash === row.docHash
        }, [
          h(doc, "span", { class: "oi-lib-titleline" }, [
            h(doc, "span", { class: "oi-lib-name", title: title.title, text: title.title }),
            reading ? h(doc, "span", { class: "oi-chip", text: LIBRARY_COPY.reading }) : null
          ]),
          h(doc, "span", { class: "oi-lib-meta", text: [libraryProgressCopy(row.translated, row.pageCount), libraryRelativeTime(row.lastOpenedAt, now()), librarySizeCopy(row.bytes)].filter(Boolean).join(" · ") })
        ]);
        main.addEventListener("click", () => {
          active = index;
          void openRow(row);
        });
        const trash = h(doc, "button", {
          type: "button",
          class: "oi-lib-trash",
          "aria-label": label,
          title: reading ? LIBRARY_COPY.readingReason : label,
          tabindex: index === active && column === "delete" ? "0" : "-1"
        });
        trash.append(trashIcon(doc));
        if (reading || !libraryDeleteAllowed(readingHash, row.docHash)) trash.disabled = true;
        trash.addEventListener("click", () => {
          if (trash.disabled) return;
          confirmHash = confirmHash === row.docHash ? "" : row.docHash;
          deleteFailed = false;
          active = index;
          column = "delete";
          render();
          focusTarget(".oi-lib-cancel");
        });
        item.append(main, trash);
        if (downloadingHash === row.docHash) {
          item.setAttribute("aria-busy", "true");
          item.append(h(doc, "p", { class: "oi-lib-muted oi-lib-opening", text: LIBRARY_COPY.downloading }));
        }
        if (openError === row.docHash) {
          item.append(h(doc, "p", { class: "oi-lib-warn oi-lib-open-error", text: LIBRARY_COPY.openFailed }));
        }
        if (confirmHash === row.docHash) {
          const notesBox = row.notes > 0
            ? h(doc, "label", { class: "oi-lib-notes" }, [
              h(doc, "input", { type: "checkbox", "data-lib-notes": "true" }),
              h(doc, "span", { text: libraryNotesDeleteCopy(row.notes) })
            ])
            : null;
          const card = h(doc, "div", { class: "oi-lib-confirm" }, [
            h(doc, "p", { class: "oi-lib-confirm-title", text: LIBRARY_COPY.confirmTitle }),
            h(doc, "p", { text: deleteWillCopy({ pages: row.translated, hasSource: row.hasSource, localFile: librarySourceIsLocalFile(row) }) }),
            h(doc, "p", { text: LIBRARY_COPY.keepFile }),
            notesBox,
            h(doc, "div", { class: "oi-lib-confirm-actions" }, [
              h(doc, "button", { type: "button", class: "btn-secondary oi-lib-cancel", text: LIBRARY_COPY.cancel }),
              h(doc, "button", { type: "button", class: "btn-danger oi-lib-do-delete", text: LIBRARY_COPY.confirmDelete })
            ])
          ]);
          const cancel = card.querySelector(".oi-lib-cancel");
          const commit = card.querySelector(".oi-lib-do-delete");
          if (deleting) {
            if (cancel) cancel.disabled = true;
            if (commit) commit.disabled = true;
          }
          if (deleteFailed) card.append(h(doc, "p", { class: "oi-lib-warn", text: LIBRARY_COPY.deleteFailed }));
          cancel?.addEventListener("click", () => {
            confirmHash = "";
            deleteFailed = false;
            render();
            focusRowControl(row.docHash, "delete");
          });
          commit?.addEventListener("click", () => {
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
    nodes.footCopy.textContent = libraryFooterCopy(rows.length, total);
    nodes.foot.hidden = phase !== "list";

    if (keep && doc.activeElement !== nodes.input) {
      if (keep.kind === "delete") focusRowControl(keep.hash, "delete");
      else if (keep.kind === "confirm") focusTarget(".oi-lib-cancel");
      else focusRowControl(keep.hash, "row");
    }
  }

  function onListKey(event) {
    const list = visibleRows();
    if (!list.length) return;
    if (event.target?.closest?.(".oi-lib-confirm, .oi-lib-repick, .oi-lib-miss")) return;
    const key = event.key;
    const host = event.target?.closest?.("[data-lib-row]");
    const hash = host?.getAttribute?.("data-lib-row") || "";
    const index = hash ? list.findIndex((row) => row.docHash === hash) : -1;
    const focused = index >= 0 ? { index, row: list[index] } : null;
    if (focused) active = focused.index;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      active = key === "ArrowDown" ? Math.min(list.length - 1, active + 1) : Math.max(0, active - 1);
      column = "row";
      render();
      focusRowControl(list[active].docHash, "row");
      return;
    }
    if (key === "ArrowRight" || key === "ArrowLeft") {
      event.preventDefault();
      const row = list[active];
      if (!row) return;
      const toDelete = key === "ArrowRight";
      if (toDelete && !libraryDeleteAllowed(readingHash, row.docHash)) {
        column = "row";
        render();
        focusRowControl(row.docHash, "row");
        return;
      }
      column = toDelete ? "delete" : "row";
      render();
      focusRowControl(row.docHash, column);
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      const row = focused?.row || list[active];
      if (!row) return;
      const onTrash = Boolean(event.target?.closest?.(".oi-lib-trash"));
      if (onTrash || column === "delete") {
        if (!libraryDeleteAllowed(readingHash, row.docHash)) return;
        confirmHash = row.docHash;
        deleteFailed = false;
        active = focused ? focused.index : active;
        column = "delete";
        render();
        focusTarget(".oi-lib-cancel");
        return;
      }
      active = focused ? focused.index : active;
      void openRow(row);
      return;
    }
    if (key === "Delete" || key === "Backspace") {
      const row = focused?.row || list[active];
      if (!row || !libraryDeleteAllowed(readingHash, row.docHash)) return;
      event.preventDefault();
      confirmHash = row.docHash;
      deleteFailed = false;
      active = focused ? focused.index : active;
      column = "delete";
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
    deleteFailed = false;
    deleting = false;
    stopPoll();
    delete root.dataset.blocked;
    syncChrome(false, meta);
    if (focusButton && meta.handoff !== true && meta.focus !== false) {
      const preferred = meta.trigger || trigger;
      focusAfterClose(preferred && preferred.isConnected !== false ? preferred : null);
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
      deleteFailed = false;
      render();
      focusRowControl(hash, "delete");
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
        deleteFailed = false;
        render();
        focusRowControl(hash, "delete");
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
