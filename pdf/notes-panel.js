/**
 * T2b notes panel, reading-surface marks, and undo toast.
 * The view decisions live in lib/notes-view-model.js. This file only paints.
 *
 * mountNotesUi(api) is the only entry the reader calls.
 */

import { notesCloseTitle, notesSideMenuModel } from "../lib/notes-pane.js";
import { NotesStoreError } from "../lib/notes-io.js";
import {
  NOTE_FILTERS,
  NOTES_LOADING_DELAY_MS,
  NOTES_SAVE_DEBOUNCE_MS,
  NOTES_UNDO_MS,
  NOTES_XS,
  anchorPresentation,
  currentParagraphHint,
  emptyState,
  filterCounts,
  formatNoteStamp,
  importResultModel,
  isAnnotationNote,
  kindGlyph,
  kindLabel,
  lostSectionCopy,
  noteBodySavable,
  notesExportFilename,
  notesListModel,
  notesMenuModel,
  paperEmptyState,
  paperNotes,
  persistHintBanner,
  pinModel,
  quoteText,
  renderNoteMarkdown,
  replaceUndo,
  trashEmptyState,
  trashGroups,
  writeFailureBanner
} from "../lib/notes-view-model.js";

export function textRangeOffsets(root, range) {
  if (!root || !range) return { start: 0, end: 0 };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let start = null;
  let end = null;
  let node = walker.nextNode();
  while (node) {
    const len = node.textContent.length;
    if (node === range.startContainer) start = pos + range.startOffset;
    if (node === range.endContainer) end = pos + range.endOffset;
    pos += len;
    node = walker.nextNode();
  }
  if (start == null || end == null) {
    const text = root.textContent || "";
    const selected = range.toString();
    const at = selected ? text.indexOf(selected) : -1;
    if (at >= 0) return { start: at, end: at + selected.length };
    return { start: 0, end: text.length };
  }
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function h(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children || []) if (child) node.append(child);
  return node;
}

function modLabel() {
  const platform = navigator.platform || "";
  const apple = /Mac|iPhone|iPad/.test(platform) || /Mac OS/.test(navigator.userAgent || "");
  return apple ? "⌘Z" : "Ctrl+Z";
}

export function mountNotesUi(api) {
  const slot = document.getElementById("sideSlot");
  const workspace = document.querySelector(".workspace");
  if (!slot || !workspace) return null;

  const root = h("aside", {
    class: "oi-notes",
    role: "complementary",
    "aria-label": "笔记"
  });
  slot.append(root);

  const state = {
    open: false,
    segment: "notes",
    filter: "all",
    view: "list",
    loading: false,
    showSkeleton: false,
    notes: [],
    trash: [],
    docHash: "",
    editor: null,
    linkedId: "",
    undo: null,
    banners: [],
    failedIds: new Set(),
    menuOpen: false,
    chipFocus: "all",
    cardFocus: "",
    lostOpen: true
  };

  let loadTicket = 0;
  let saveTimer = 0;
  let undoTimer = 0;
  let undoLeft = NOTES_UNDO_MS;
  let undoStamp = 0;
  let undoPaused = false;
  let subscribed = false;
  let fileInput = null;

  function counts() {
    return filterCounts(state.notes);
  }

  function papers() {
    return paperNotes(state.notes);
  }

  function syncChrome() {
    const button = document.getElementById("notesButton");
    const menu = document.getElementById("menuNotes");
    if (button) {
      button.setAttribute("aria-pressed", state.open ? "true" : "false");
      if (state.open) button.dataset.open = "true";
      else delete button.dataset.open;
    }
    if (menu) {
      const text = [...menu.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
      if (text) text.nodeValue = state.open ? "✓ 笔记" : "笔记";
    }
    workspace.dataset.notesOpen = state.open ? "true" : "false";
    if (state.open) {
      slot.hidden = false;
      slot.dataset.open = "true";
      slot.setAttribute("aria-hidden", "false");
    } else {
      slot.hidden = true;
      delete slot.dataset.open;
      slot.setAttribute("aria-hidden", "true");
    }
    syncPlace();
    api.onOpenChange?.(state.open);
  }

  function syncPlace() {
    const width = window.innerWidth || 0;
    const mode = workspace.dataset.sourceMode || "side";
    const place = width < 900 ? "sheet" : (width < 1200 ? "mid" : "side");
    workspace.dataset.notesPlace = place;
    const prefs = api.readPrefs?.() || { panelWidth: 440 };
    if (mode === "mini" || mode === "hidden") {
      workspace.style.setProperty("--oi-notes-panel-w", `${prefs.panelWidth}px`);
    } else workspace.style.removeProperty("--oi-notes-panel-w");
    const layout = workspace.dataset.layout || "";
    const paneWidth = Number(prefs.notesWidth);
    const panelWidth = layout === "3" || layout === "pair"
      ? (Number.isFinite(paneWidth) && paneWidth > 0 ? paneWidth : slot.clientWidth || 0)
      : (slot.clientWidth || 0);
    root.classList.toggle("slim", panelWidth > 0 && panelWidth < 480);
    root.classList.toggle("xs", panelWidth > 0 && panelWidth < NOTES_XS);
    root.dataset.place = place;
    const trash = root.querySelector(".oi-notes-trash");
    if (trash) applyTrashLabel(trash, panelWidth);
  }

  function applyTrashLabel(trash, width) {
    const n = state.trash.length;
    const narrow = width > 0 && width < NOTES_XS;
    if (narrow && n > 0) {
      trash.setAttribute("aria-label", `回收站，${n} 条`);
      trash.title = `回收站 · ${n} 条，可恢复`;
    } else if (n > 0) {
      trash.setAttribute("aria-label", `回收站，${n} 条`);
      trash.removeAttribute("title");
    } else {
      trash.setAttribute("aria-label", "回收站");
      trash.removeAttribute("title");
    }
  }

  function open(focus = true) {
    if (!api.hasDoc?.()) return;
    state.open = true;
    syncChrome();
    ensureSubscribed();
    void reload({ quiet: state.notes.length > 0 && state.docHash === api.docHash?.() });
    render();
    if (focus) root.querySelector("[data-notes-segment]")?.focus();
  }

  function close(focusButton = true) {
    void closeEditor({ save: true });
    state.menuOpen = false;
    state.view = "list";
    state.open = false;
    syncChrome();
    clearGhost();
    if (focusButton) document.getElementById("notesButton")?.focus();
  }

  function toggle() {
    if (state.open) close(true);
    else open(true);
  }

  function ensureSubscribed() {
    if (subscribed || !api.subscribe) return;
    subscribed = true;
    let frame = 0;
    api.subscribe(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (state.undo && !state.trash.some((note) => note.id === state.undo.id) && !state.notes.some((note) => note.id === state.undo.id)) {
          /* still in one of the lists, or purged */
        }
        void reload({ quiet: true }).then(() => {
          if (!state.undo) return;
          const id = state.undo.id;
          const alive = state.trash.some((note) => note.id === id) || state.notes.some((note) => note.id === id);
          if (!alive) {
            state.undo = null;
            clearTimeout(undoTimer);
            render();
          }
        });
      });
    });
  }

  async function reload({ quiet = false } = {}) {
    const hash = api.docHash?.() || "";
    const ticket = ++loadTicket;
    let timer = 0;
    if (!quiet) {
      state.loading = true;
      state.showSkeleton = false;
      timer = setTimeout(() => {
        if (ticket !== loadTicket) return;
        state.showSkeleton = true;
        render();
      }, NOTES_LOADING_DELAY_MS);
    }
    try {
      if (!hash) {
        state.notes = [];
        state.trash = [];
        state.docHash = "";
        state.loading = false;
        state.showSkeleton = false;
      } else {
        const [notes, trash] = await Promise.all([
          api.list(hash),
          api.listTrash(hash)
        ]);
        if (ticket !== loadTicket) return;
        state.docHash = hash;
        state.notes = notes || [];
        state.trash = trash || [];
        state.loading = false;
        state.showSkeleton = false;
      }
    } catch (error) {
      if (ticket !== loadTicket) return;
      state.loading = false;
      state.showSkeleton = false;
      rememberFailure(error);
    } finally {
      clearTimeout(timer);
    }
    if (ticket !== loadTicket) return;
    render();
    paint();
    // Reopen shows a refusal that was already recorded. This does not call persist().
    void maybePersistHint();
  }

  function rememberFailure(error) {
    const message = error instanceof NotesStoreError ? error.message : (error?.message || "");
    state.banners = state.banners.filter((banner) => banner.id !== "write");
    const banner = writeFailureBanner(Math.max(1, state.failedIds.size), message);
    state.banners.push({ id: "write", tone: "warn", title: banner.title, body: banner.body, retry: true });
  }

  async function maybePersistHint() {
    if (!state.docHash || !api.persistDenied) return;
    if (api.persistDismissed?.(state.docHash)) {
      state.banners = state.banners.filter((banner) => banner.id !== "persist");
      return;
    }
    const denied = await api.persistDenied();
    if (!denied || state.docHash !== api.docHash?.()) return;
    if (state.banners.some((banner) => banner.id === "persist")) return;
    const copy = persistHintBanner();
    state.banners.push({ id: "persist", tone: "neutral", line: copy.line, persist: true });
    render();
  }

  function dismissPersist() {
    api.dismissPersist?.(state.docHash);
    state.banners = state.banners.filter((banner) => banner.id !== "persist");
    render();
  }

  async function putNote(input) {
    try {
      const saved = await api.put(input);
      if (saved?.id) state.failedIds.delete(saved.id);
      state.banners = state.banners.filter((banner) => banner.id !== "write");
      void maybePersistHint();
      return saved;
    } catch (error) {
      if (input?.id) state.failedIds.add(input.id);
      rememberFailure(error);
      render();
      throw error;
    }
  }

  function editorStatusText(editor) {
    if (!editor) return "";
    if (editor.status === "error") return "没存上 · 重试";
    if (editor.status === "saving") return "保存中…";
    if (editor.status === "saved") return "已保存";
    return "空笔记不会保存";
  }

  async function commitEditor(editor, { closeAfter = false } = {}) {
    if (!editor) return null;
    if (!noteBodySavable(editor.body)) {
      editor.status = "empty";
      return null;
    }
    editor.status = "saving";
    paintEditorStatus();
    const kind = editor.wasHighlight ? "note" : editor.kind;
    try {
      const saved = await putNote({
        id: editor.isNew ? undefined : editor.id,
        docHash: state.docHash || api.docHash?.(),
        kind,
        author: "me",
        body: editor.body,
        anchor: editor.anchor,
        anchorState: editor.anchorState,
        page: editor.page
      });
      editor.id = saved.id;
      editor.isNew = false;
      editor.wasHighlight = false;
      editor.kind = saved.kind;
      editor.status = "saved";
      state.linkedId = saved.id;
      if (closeAfter) {
        state.editor = null;
        render();
      } else paintEditorStatus();
      return saved;
    } catch {
      editor.status = "error";
      paintEditorStatus();
      return null;
    }
  }

  function scheduleSave() {
    const editor = state.editor;
    if (!editor) return;
    clearTimeout(saveTimer);
    if (!noteBodySavable(editor.body)) {
      editor.status = "empty";
      paintEditorStatus();
      return;
    }
    editor.status = "saving";
    paintEditorStatus();
    saveTimer = setTimeout(() => {
      if (state.editor === editor) void commitEditor(editor);
    }, NOTES_SAVE_DEBOUNCE_MS);
  }

  async function closeEditor({ save = true } = {}) {
    const editor = state.editor;
    clearTimeout(saveTimer);
    if (!editor) return;
    if (save && noteBodySavable(editor.body)) await commitEditor(editor);
    if (state.editor === editor) state.editor = null;
  }

  function openEditor(draft) {
    state.segment = draft.kind === "paperNote" ? "paper" : "notes";
    state.view = "list";
    state.editor = {
      id: draft.id || "",
      kind: draft.kind || "note",
      body: draft.body || "",
      anchor: draft.anchor === undefined ? null : draft.anchor,
      anchorState: draft.anchorState || { status: "exact", layoutRev: "", checkedAt: 0 },
      page: draft.page || 0,
      quote: draft.quote || "",
      isNew: draft.isNew !== false && !draft.id,
      wasHighlight: draft.wasHighlight === true,
      status: noteBodySavable(draft.body) ? "saved" : "empty",
      preview: false,
      pairId: draft.pairId || ""
    };
    if (!state.open) open(false);
    else render();
    const field = root.querySelector(".oi-note-editor textarea");
    field?.focus();
  }

  function composeCurrent() {
    const current = api.currentParagraph?.();
    if (!current) return false;
    const built = api.anchorForParagraph?.(current);
    if (!built) return false;
    openEditor({
      kind: "note",
      isNew: true,
      quote: current.preview || "",
      pairId: current.pairId || "",
      ...built
    });
    return true;
  }

  async function fromSelection(payload) {
    if (!payload?.anchor && payload?.kind !== "paperNote") return null;
    if (payload.kind === "highlight") {
      const saved = await putNote({
        docHash: state.docHash || api.docHash?.(),
        kind: "highlight",
        author: "me",
        body: "",
        anchor: payload.anchor,
        anchorState: payload.anchorState,
        page: payload.page
      });
      state.linkedId = saved.id;
      if (state.open) {
        await reload({ quiet: true });
        reveal(saved.id);
      } else paint();
      return saved;
    }
    openEditor({
      kind: payload.kind === "question" ? "question" : "note",
      isNew: true,
      quote: payload.anchor?.quote || "",
      anchor: payload.anchor,
      anchorState: payload.anchorState,
      page: payload.page,
      pairId: payload.pairId || ""
    });
    return null;
  }

  function composePaper() {
    openEditor({
      kind: "paperNote",
      isNew: true,
      anchor: null,
      anchorState: { status: "exact", layoutRev: "", checkedAt: Date.now() },
      page: 0,
      quote: ""
    });
  }

  function editNote(note) {
    if (note.kind === "highlight") {
      openEditor({
        id: note.id,
        kind: "note",
        body: note.body || "",
        anchor: note.anchor,
        anchorState: note.anchorState,
        page: note.page,
        quote: quoteText(note),
        isNew: false,
        wasHighlight: true
      });
      return;
    }
    openEditor({
      id: note.id,
      kind: note.kind,
      body: note.body || "",
      anchor: note.anchor,
      anchorState: note.anchorState,
      page: note.page,
      quote: quoteText(note),
      isNew: false
    });
  }

  async function changeKind(note, kind) {
    await putNote({
      id: note.id,
      docHash: note.docHash,
      kind,
      author: note.author || "me",
      body: note.body || "",
      anchor: note.anchor,
      anchorState: note.anchorState,
      page: note.page
    });
    await reload({ quiet: true });
  }

  async function deleteNote(note) {
    const saved = await api.softDelete(note.id);
    state.undo = replaceUndo(null, saved || note, Date.now());
    undoLeft = NOTES_UNDO_MS;
    undoStamp = performance.now();
    undoPaused = false;
    if (state.editor?.id === note.id) state.editor = null;
    armUndoTimer();
    await reload({ quiet: true });
  }

  function armUndoTimer() {
    clearTimeout(undoTimer);
    if (!state.undo || undoPaused) return;
    undoTimer = setTimeout(() => {
      state.undo = null;
      render();
    }, Math.max(0, undoLeft));
  }

  async function undo() {
    if (!state.undo?.id) return false;
    const id = state.undo.id;
    state.undo = null;
    clearTimeout(undoTimer);
    try {
      await api.restore(id);
    } catch {
      /* already purged */
    }
    await reload({ quiet: true });
    reveal(id);
    return true;
  }

  function pauseUndo() {
    if (!state.undo || undoPaused) return;
    undoPaused = true;
    undoLeft = Math.max(0, undoLeft - (performance.now() - undoStamp));
    clearTimeout(undoTimer);
    const bar = root.querySelector(".oi-note-undo-bar");
    if (bar) {
      const width = getComputedStyle(bar).width;
      bar.style.transition = "none";
      bar.style.width = width;
    }
  }

  function resumeUndo() {
    if (!state.undo || !undoPaused) return;
    undoPaused = false;
    undoStamp = performance.now();
    const bar = root.querySelector(".oi-note-undo-bar");
    if (bar) {
      bar.style.transition = `width linear ${Math.max(0, undoLeft)}ms`;
      bar.style.width = "0%";
    }
    armUndoTimer();
  }

  async function purgeNote(id, focusAfter) {
    await api.purge(id);
    if (state.undo?.id === id) {
      state.undo = null;
      clearTimeout(undoTimer);
    }
    await reload({ quiet: true });
    const next = root.querySelector(`[data-restore="${CSS.escape(focusAfter || "")}"]`)
      || root.querySelector("[data-restore]")
      || root.querySelector("[data-notes-back]");
    next?.focus();
  }

  async function restoreNote(id) {
    await api.restore(id);
    await reload({ quiet: true });
    reveal(id);
  }

  function reveal(id) {
    state.linkedId = id;
    const card = root.querySelector(`[data-note-id="${cssEscape(id)}"]`);
    card?.scrollIntoView({ block: "nearest" });
    render();
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
    return String(value).replace(/"/g, "\\'");
  }

  async function retryFailed() {
    if (state.editor?.status === "error") {
      await commitEditor(state.editor);
      return;
    }
    const ids = [...state.failedIds];
    for (const id of ids) {
      const note = state.notes.find((item) => item.id === id) || state.trash.find((item) => item.id === id);
      if (!note) continue;
      try {
        await putNote(note);
      } catch {
        /* banner already shown */
      }
    }
  }

  async function exportNotes(kind) {
    try {
      const hash = state.docHash || api.docHash?.();
      const bundle = await api.exportDoc(hash);
      const title = api.docTitle?.() || "笔记";
      if (kind === "md") {
        const markdown = api.exportMarkdown(bundle);
        api.download(notesExportFilename(title, "md"), new Blob([markdown], { type: "text/markdown" }));
      } else {
        api.download(notesExportFilename(title, "json"), new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
      }
      state.menuOpen = false;
      render();
    } catch (error) {
      state.banners = state.banners.filter((banner) => banner.id !== "export");
      state.banners.push({
        id: "export",
        tone: "warn",
        title: "导出失败",
        body: error?.message || "",
        retryExport: kind
      });
      state.menuOpen = false;
      render();
    }
  }

  async function importFile(file) {
    state.banners = state.banners.filter((banner) => banner.id !== "import");
    state.banners.unshift({ id: "import", tone: "loading", title: `正在导入 ${file.name}…`, body: "" });
    render();
    let bundle = null;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      bundle = null;
    }
    if (!bundle || typeof bundle !== "object") {
      const model = importResultModel({ error: { type: "format" } });
      state.banners = state.banners.filter((banner) => banner.id !== "import");
      state.banners.unshift({ id: "import", tone: "warn", lines: model.lines });
      render();
      return;
    }
    try {
      const result = await api.importBundle(bundle);
      const model = importResultModel({
        currentDocHash: state.docHash || api.docHash?.() || "",
        byDoc: result?.byDoc || [],
        rejected: result?.rejected || 0
      });
      state.banners = state.banners.filter((banner) => banner.id !== "import");
      state.banners.unshift({ id: "import", tone: model.tone === "ok" ? "ok" : "warn", lines: model.lines });
      await reload({ quiet: true });
    } catch (error) {
      const model = importResultModel({
        error: {
          type: error?.type || "format",
          schema: error?.schema,
          message: error?.message
        }
      });
      state.banners = state.banners.filter((banner) => banner.id !== "import");
      state.banners.unshift({ id: "import", tone: "warn", lines: model.lines });
      render();
    }
  }

  function paintEditorStatus() {
    const node = root.querySelector("[data-editor-status]");
    const editor = state.editor;
    if (!node || !editor) return;
    node.textContent = editorStatusText(editor);
    node.classList.toggle("is-error", editor.status === "error");
    root.querySelector(".oi-note-editor")?.classList.toggle("is-error", editor.status === "error");
  }

  function render() {
    const scroll = root.querySelector(".oi-notes-scroll");
    const scrollTop = scroll?.scrollTop || 0;
    const nodes = [renderHead(), renderBody(), renderUndo()];
    if (fileInput) nodes.push(fileInput);
    root.replaceChildren(...nodes);
    const nextScroll = root.querySelector(".oi-notes-scroll");
    if (nextScroll) nextScroll.scrollTop = scrollTop;
    hydrateMath(root);
    const bar = root.querySelector(".oi-note-undo-bar");
    if (bar && state.undo && !undoPaused) {
      bar.style.transition = "none";
      bar.style.width = "100%";
      requestAnimationFrame(() => {
        bar.style.transition = `width linear ${NOTES_UNDO_MS}ms`;
        bar.style.width = "0%";
      });
    }
    syncPlace();
  }

  function renderHead() {
    const annotationCount = state.loading && !state.notes.length ? "–" : String(counts().all);
    const paperCount = state.loading && !state.notes.length ? "–" : String(papers().length);
    const trashCount = state.trash.length;
    const head = h("header", { class: "oi-notes-head" });
    if (state.view === "trash") {
      head.append(
        h("button", {
          type: "button",
          class: "oi-notes-back",
          "data-notes-back": "true",
          text: `← 回收站 · ${trashCount}`
        }),
        h("span", { class: "oi-notes-head-gap" }),
        closeButton()
      );
      head.querySelector("[data-notes-back]").addEventListener("click", () => {
        state.view = "list";
        render();
      });
      head.querySelector("[data-notes-close]").addEventListener("click", () => close(true));
      return head;
    }
    if (root.dataset.place === "sheet" || (window.innerWidth || 0) < 900) {
      const back = h("button", { type: "button", class: "oi-notes-back", text: "← 译文" });
      back.addEventListener("click", () => close(true));
      head.append(back);
    }
    const seg = h("div", { class: "view-seg", role: "tablist", "aria-label": "笔记分段" });
    seg.append(segmentButton("notes", `批注 ${annotationCount}`), segmentButton("paper", `论文笔记 ${paperCount}`));
    const reserve = h("span", { class: "oi-notes-reserve", "aria-hidden": "true" });
    const trash = h("button", {
      type: "button",
      class: "oi-notes-icon oi-notes-trash tbtn",
      "aria-label": "回收站"
    });
    trash.append(iconTrash(), h("span", { class: "tbtn-label", text: "回收站" }));
    if (trashCount) trash.append(h("span", { class: "oi-notes-trash-n", text: String(trashCount) }));
    trash.addEventListener("click", () => {
      state.view = "trash";
      state.menuOpen = false;
      render();
    });
    const rule = h("span", { class: "oi-notes-rule", "aria-hidden": "true" });
    const more = h("button", {
      type: "button",
      class: "oi-notes-icon oi-notes-more",
      "aria-label": "导入导出",
      "aria-haspopup": "menu",
      "aria-expanded": state.menuOpen ? "true" : "false",
      text: "⋯"
    });
    more.addEventListener("click", () => {
      state.menuOpen = !state.menuOpen;
      render();
      if (state.menuOpen) {
        root.querySelector(".oi-notes-menu [role='menuitemradio'], .oi-notes-menu [role='menuitem']")?.focus();
      }
    });
    head.append(seg, reserve, trash, rule, more, closeButton());
    if (state.menuOpen) head.append(renderMenu());
    head.querySelector("[data-notes-close]").addEventListener("click", () => close(true));
    return head;
  }

  function segmentButton(id, label) {
    const button = h("button", {
      type: "button",
      class: "view-seg-btn",
      role: "tab",
      "data-notes-segment": id,
      "aria-selected": state.segment === id ? "true" : "false",
      text: label
    });
    button.addEventListener("click", () => {
      state.segment = id;
      state.view = "list";
      render();
    });
    return button;
  }

  function closeButton() {
    const button = h("button", {
      type: "button",
      class: "oi-notes-icon",
      "data-notes-close": "true",
      "aria-label": "关闭笔记",
      title: notesCloseTitle(workspace.dataset.layout),
      text: "×"
    });
    return button;
  }

  function syncLayoutChrome() {
    const close = root.querySelector("[data-notes-close]");
    if (close) close.title = notesCloseTitle(workspace.dataset.layout);
    const side = (api.readPrefs?.() || {}).notesPaneSide === "start" ? "start" : "end";
    for (const item of root.querySelectorAll("[data-notes-side]")) {
      const on = item.dataset.notesSide === side;
      item.setAttribute("aria-checked", on ? "true" : "false");
      const label = item.querySelector("[data-notes-side-label]");
      const name = item.dataset.notesSide === "start" ? "笔记在左侧" : "笔记在右侧";
      if (label) label.textContent = on ? `✓ ${name}` : name;
    }
    syncPlace();
  }

  function renderMenu() {
    const menu = h("div", { class: "oi-notes-menu more-menu", role: "menu", "aria-label": "导入导出" });
    if (typeof api.setNotesPaneSide === "function") {
      const place = notesSideMenuModel((api.readPrefs?.() || {}).notesPaneSide);
      menu.append(menuHeading(place.heading));
      for (const item of place.items) menu.append(sideMenuItem(item, place.shortcut));
      menu.append(h("div", { class: "oi-notes-menu-rule", role: "separator" }));
    }
    const copy = notesMenuModel();
    menu.append(
      menuHeading(copy.exportHeading),
      menuItem("导出 Markdown", () => exportNotes("md"), ".md"),
      menuItem("导出备份 JSON", () => exportNotes("json"), ".json"),
      menuHeading(copy.importHeading),
      menuItem("导入 JSON…", () => root.querySelector(".oi-notes-file")?.click(), ".json")
    );
    return menu;
  }

  function sideMenuItem(item, shortcut) {
    const button = h("button", {
      type: "button",
      class: "more-item",
      role: "menuitemradio",
      "data-notes-side": item.side,
      "aria-checked": item.checked ? "true" : "false"
    });
    button.append(h("span", { "data-notes-side-label": item.side, text: item.checked ? `✓ ${item.label}` : item.label }));
    button.append(h("span", { class: "r", text: shortcut }));
    button.addEventListener("click", () => {
      state.menuOpen = false;
      api.setNotesPaneSide?.(item.side);
      render();
    });
    return button;
  }

  function menuHeading(text) {
    return h("p", { class: "mh", text });
  }

  function menuItem(label, run, suffix) {
    const button = h("button", { type: "button", class: "more-item", role: "menuitem" });
    button.append(h("span", { text: label }));
    if (suffix) button.append(h("span", { class: "r", text: suffix }));
    button.addEventListener("click", () => run());
    return button;
  }

  function renderBody() {
    const body = h("div", { class: "oi-notes-scroll" });
    for (const banner of state.banners) body.append(renderBanner(banner));
    if (state.view === "trash") {
      body.append(renderTrash());
      return body;
    }
    if (state.segment === "paper") {
      body.append(renderPaper());
      return body;
    }
    const listed = notesListModel(filteredAnnotations(), { blockOrder: api.blockOrder?.() });
    body.append(renderFilters(), renderAddRow());
    if (!state.showSkeleton && listed.lost.length) body.append(renderLostLine(listed.lost.length));
    body.append(renderAnnotationList(listed));
    return body;
  }

  function filteredAnnotations() {
    return state.notes.filter((note) => filterCounts([note])[state.filter] > 0);
  }

  function renderBanner(banner) {
    if (banner.persist) return renderPersistLine(banner);
    const node = h("div", {
      class: `oi-notes-banner is-${banner.tone || "neutral"}`,
      role: "status"
    });
    const text = h("div", { class: "oi-notes-banner-text" });
    if (banner.lines) banner.lines.forEach((line) => text.append(h("p", { text: line })));
    else {
      if (banner.title) text.append(h("p", { class: "oi-notes-banner-title", text: banner.title }));
      if (banner.body) text.append(h("p", { text: banner.body }));
    }
    const actions = h("div", { class: "oi-notes-banner-actions" });
    if (banner.retry) actions.append(smallButton("重试", () => retryFailed()));
    if (banner.retry || banner.retryExport) {
      actions.append(smallButton("导出备份 JSON", () => exportNotes("json")));
    }
    if (banner.id === "import" || banner.id === "export" || banner.id === "write") {
      actions.append(smallButton("关闭", () => {
        state.banners = state.banners.filter((item) => item !== banner);
        render();
      }));
    }
    node.append(text, actions);
    return node;
  }

  function renderPersistLine(banner) {
    const copy = persistHintBanner();
    const line = banner.line || copy.line;
    const node = h("div", {
      class: "oi-notes-banner-line",
      role: "status",
      title: line
    });
    const dismiss = h("button", {
      type: "button",
      class: "oi-notes-banner-x",
      "aria-label": "本文档不再提示",
      title: "本文档不再提示",
      text: "×"
    });
    dismiss.addEventListener("click", () => dismissPersist());
    const backup = h("button", {
      type: "button",
      class: "oi-notes-banner-btn",
      text: copy.exportLabel
    });
    backup.addEventListener("click", () => exportNotes("json"));
    node.append(h("span", { class: "oi-notes-banner-line-text", text: line }), backup, dismiss);
    return node;
  }

  function smallButton(label, run) {
    const button = h("button", { type: "button", class: "oi-notes-text-btn", text: label });
    button.addEventListener("click", () => run());
    return button;
  }

  function renderFilters() {
    const row = h("div", {
      class: "oi-notes-chips",
      role: "tablist",
      "aria-label": "笔记筛选"
    });
    const tally = counts();
    for (const filter of NOTE_FILTERS) {
      const selected = state.filter === filter.id;
      const count = state.loading && !state.notes.length ? "–" : String(tally[filter.id]);
      const button = h("button", {
        type: "button",
        class: `oi-notes-chip${Number(tally[filter.id]) === 0 ? " is-zero" : ""}`,
        role: "tab",
        "data-notes-filter": filter.id,
        "aria-selected": selected ? "true" : "false",
        tabindex: selected ? "0" : "-1",
        text: `${filter.label} ${count}`
      });
      button.addEventListener("click", () => {
        state.filter = filter.id;
        state.chipFocus = filter.id;
        render();
      });
      row.append(button);
    }
    row.addEventListener("keydown", onChipKey);
    return row;
  }

  function onChipKey(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const buttons = [...root.querySelectorAll("[data-notes-filter]")];
    const index = buttons.findIndex((button) => button.dataset.notesFilter === state.filter);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = buttons[(index + step + buttons.length) % buttons.length];
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    state.filter = next.dataset.notesFilter;
    state.chipFocus = state.filter;
    render();
    root.querySelector(`[data-notes-filter="${state.filter}"]`)?.focus();
  }

  function renderAddRow() {
    const current = api.currentParagraph?.();
    const hint = currentParagraphHint(current);
    const row = h("div", { class: "oi-notes-add-row addrow2" });
    const button = h("button", {
      type: "button",
      class: "oi-notes-add addb",
      disabled: current ? false : true
    });
    button.append(h("span", { text: "＋ 给当前段写笔记" }), h("kbd", { text: "n" }));
    button.addEventListener("click", () => composeCurrent());
    row.append(button, h("p", { class: "hint2", text: hint, title: hint }));
    return row;
  }

  function renderLostLine(count) {
    const copy = lostSectionCopy(count);
    const line = h("button", { type: "button", class: "lostline" });
    line.append(
      h("span", { class: "lostline-n", text: copy.line }),
      h("span", { class: "lostline-jump", text: copy.jump })
    );
    line.addEventListener("click", () => {
      const sec = root.querySelector(".lostsec");
      const scroller = root.querySelector(".oi-notes-scroll");
      if (!sec || !scroller) return;
      const top = sec.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, top);
    });
    return line;
  }

  function renderAnnotationList(listed) {
    const list = h("div", { class: "oi-notes-list", role: "list" });
    if (state.showSkeleton) {
      list.append(h("p", { class: "oi-notes-loading", text: "正在读取本机笔记…" }));
      for (let i = 0; i < 3; i += 1) list.append(h("div", { class: "oi-notes-skeleton", "aria-hidden": "true" }));
      return list;
    }
    const model = listed || notesListModel(filteredAnnotations(), { blockOrder: api.blockOrder?.() });
    const total = counts().all;
    if (!model.groups.length && !model.lost.length && !(state.editor?.isNew && state.editor.kind !== "paperNote")) {
      const copy = emptyState(state.filter, { total });
      list.append(renderEmpty(copy, () => {
        state.filter = "all";
        render();
      }));
      return list;
    }
    const groups = model.groups;
    if (state.editor?.isNew && state.editor.kind !== "paperNote" && !groups.some((group) => group.page === (state.editor.page || 0))) {
      const page = state.editor.page || 0;
      groups.push({
        page,
        heading: page >= 1 ? `原文第 ${page} 页` : "未分页",
        notes: []
      });
      groups.sort((a, b) => a.page - b.page);
    }
    const currentPage = api.currentParagraph?.()?.page || 0;
    for (const group of groups) {
      list.append(renderGroup(group, group.page === currentPage));
    }
    if (model.lost.length) list.append(renderLostSection(model.lost));
    list.addEventListener("keydown", onCardKey);
    return list;
  }

  function renderLostSection(notes) {
    const copy = lostSectionCopy(notes.length);
    const section = h("section", {
      class: "lostsec",
      "data-open": state.lostOpen ? "true" : "false"
    });
    const toggle = h("button", {
      type: "button",
      class: "lostsec-toggle",
      text: state.lostOpen ? copy.collapse : copy.expand
    });
    toggle.addEventListener("click", () => {
      state.lostOpen = !state.lostOpen;
      render();
    });
    const head = h("div", { class: "lostsec-head" });
    head.append(iconLost(), h("span", { class: "lostsec-title", text: copy.title }), toggle);
    section.append(head);
    if (!state.lostOpen) return section;
    section.append(h("p", { class: "lostsec-hint", text: copy.hint }));
    for (const note of notes) {
      if (state.editor && !state.editor.isNew && state.editor.id === note.id) {
        section.append(renderEditor(state.editor));
      } else {
        section.append(renderCard(note, { inLost: true }));
      }
    }
    return section;
  }

  function renderGroup(group, current) {
    const section = h("section", {
      class: `oi-notes-group${current ? " is-current" : ""}`,
      "data-notes-page": String(group.page)
    });
    const head = h("div", { class: "oi-notes-group-head" });
    const title = h("span", { class: "oi-notes-group-title", text: group.heading, title: group.heading });
    const jump = h("button", { type: "button", class: "oi-notes-jump", text: "跳到此页 ↗" });
    jump.addEventListener("click", () => api.jumpPage?.(group.page));
    head.append(title, jump);
    head.tabIndex = 0;
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        api.jumpPage?.(group.page);
      }
    });
    section.append(head);
    const shown = new Set();
    for (const note of group.notes) {
      if (state.editor && !state.editor.isNew && state.editor.id === note.id) {
        section.append(renderEditor(state.editor));
        shown.add(note.id);
        continue;
      }
      if (state.editor?.isNew && sameSpot(state.editor, note) && !shown.has("draft")) {
        section.append(renderEditor(state.editor));
        shown.add("draft");
      }
      section.append(renderCard(note));
    }
    if (state.editor?.isNew && state.editor.kind !== "paperNote" && !shown.has("draft") && editorInGroup(state.editor, group)) {
      section.append(renderEditor(state.editor));
    }
    return section;
  }

  function sameSpot(editor, note) {
    return editor.page === note.page && editor.anchor?.bid && editor.anchor.bid === note.anchor?.bid;
  }

  function editorInGroup(editor, group) {
    return (editor.page || 0) === group.page;
  }

  function renderPaper() {
    const wrap = h("div", { class: "oi-notes-list" });
    const add = h("button", { type: "button", class: "oi-notes-add", text: "＋ 写论文笔记" });
    add.addEventListener("click", () => composePaper());
    wrap.append(add);
    if (state.editor?.kind === "paperNote") wrap.append(renderEditor(state.editor));
    const rows = papers().filter((note) => note.id !== state.editor?.id);
    if (!rows.length && state.editor?.kind !== "paperNote") wrap.append(renderEmpty(paperEmptyState()));
    for (const note of rows) wrap.append(renderCard(note));
    wrap.addEventListener("keydown", onCardKey);
    return wrap;
  }

  function renderTrash() {
    const wrap = h("div", { class: "oi-notes-list" });
    wrap.append(h("div", {
      class: "oi-notes-banner is-neutral",
      role: "status",
      text: ""
    }));
    const banner = wrap.querySelector(".oi-notes-banner");
    banner.append(h("p", { text: "删除的笔记先放在这里，可以恢复。「彻底删除」点了立即生效，不能撤销。不会自动清理。" }));
    if (!state.trash.length) {
      wrap.append(renderEmpty(trashEmptyState()));
      return wrap;
    }
    for (const group of trashGroups(state.trash)) {
      const section = h("section", { class: "oi-notes-group" });
      section.append(h("div", { class: "oi-notes-group-head" }, [
        h("span", { class: "oi-notes-group-title", text: group.heading })
      ]));
      for (const note of group.notes) section.append(renderTrashCard(note));
      wrap.append(section);
    }
    return wrap;
  }

  function renderEmpty(copy, onAction) {
    const node = h("div", { class: "oi-notes-empty", "data-empty": copy.title });
    node.append(
      h("div", { class: "oi-notes-empty-icon", "aria-hidden": "true", text: "□" }),
      h("p", { class: "oi-notes-empty-title", text: copy.title }),
      h("p", { class: "oi-notes-empty-body", text: copy.body })
    );
    if (copy.action && onAction) node.append(smallButton(copy.action, onAction));
    return node;
  }

  function renderCard(note, { inLost = false } = {}) {
    const pres = anchorPresentation(note);
    const linked = state.linkedId === note.id;
    const classes = ["oi-note-card", "card", `is-${note.kind}`, `is-${pres.kind}`];
    if (linked) classes.push("is-linked", "linked");
    if (pres.kind === "lost") classes.push("lost");
    if (note.kind === "highlight") classes.push("hl", "compact");
    const card = h("article", {
      class: classes.join(" "),
      "data-note-id": note.id,
      "data-kind": note.kind,
      tabindex: "-1",
      role: "listitem"
    });
    const label = h("div", { class: "oi-note-label" });
    label.append(
      h("span", { class: "oi-note-glyph", "aria-hidden": "true", text: kindGlyph(note.kind) }),
      h("span", { text: kindLabel(note.kind) })
    );
    if (note.kind === "question" && pres.kind !== "lost") label.append(h("span", { class: "oi-note-quiet", text: "· 待回答" }));
    if (pres.label) {
      const tag = h("span", {
        class: `oi-note-tag is-${pres.kind}`,
        text: pres.label,
        title: inLost ? null : pres.hint
      });
      label.append(tag);
    }
    if (inLost) {
      const page = Number(note.page);
      const pageLabel = Number.isFinite(page) && page >= 1 ? `原文第 ${Math.floor(page)} 页` : "未分页";
      label.append(h("span", { class: "oi-note-page", text: pageLabel }));
    } else {
      const stamp = formatNoteStamp(note.updatedAt);
      if (stamp) label.append(h("time", { class: "oi-note-time", text: stamp }));
    }
    card.append(label);
    const quote = quoteText(note);
    if (quote && note.kind !== "paperNote") card.append(h("blockquote", { class: "oi-note-quote", text: `「${quote}」` }));
    if (note.body) {
      const body = h("div", { class: "oi-note-body", html: renderNoteMarkdown(note.body) });
      card.append(body);
    }
    const actions = h("div", { class: `oi-note-actions${inLost ? " is-visible" : ""}` });
    if (note.kind === "highlight" && !inLost) {
      actions.classList.add("is-hl-row");
      const add = h("button", { type: "button", class: "ghostadd", text: "＋ 加笔记" });
      add.addEventListener("click", () => editNote(note));
      actions.append(add);
    }
    if (inLost) {
      actions.append(smallButton(`跳到第 ${note.page || "?"} 页 ↗`, () => api.jumpPage?.(note.page)));
      actions.append(smallButton("编辑", () => editNote(note)));
      actions.append(smallButton("删除", () => deleteNote(note)));
    } else if (note.kind === "highlight") {
      actions.append(smallButton("删除", () => deleteNote(note)));
    } else {
      actions.append(smallButton("编辑", () => editNote(note)));
      if (note.kind === "note") actions.append(smallButton("改成问题", () => changeKind(note, "question")));
      if (note.kind === "question") actions.append(smallButton("改成笔记", () => changeKind(note, "note")));
      actions.append(smallButton("删除", () => deleteNote(note)));
    }
    card.append(actions);
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      if (pres.kind === "lost" || note.kind === "paperNote") return;
      state.linkedId = note.id;
      api.jumpAnchor?.(note);
      render();
      paint();
    });
    return card;
  }

  function renderTrashCard(note) {
    const card = h("article", { class: "oi-note-card is-trash", "data-note-id": note.id });
    const label = h("div", { class: "oi-note-label" });
    label.append(
      h("span", { class: "oi-note-glyph", text: kindGlyph(note.kind) }),
      h("span", { text: kindLabel(note.kind) }),
      h("time", { class: "oi-note-time is-visible", text: `删除于 ${formatNoteStamp(note.deletedAt)}` })
    );
    card.append(label);
    const quote = quoteText(note);
    if (quote) card.append(h("blockquote", { class: "oi-note-quote", text: `「${quote}」` }));
    const actions = h("div", { class: "oi-note-actions is-visible" });
    const restore = smallButton("恢复", () => restoreNote(note.id));
    restore.setAttribute("data-restore", note.id);
    const purge = smallButton("彻底删除", () => {
      const next = card.nextElementSibling?.querySelector?.("[data-restore]")?.getAttribute("data-restore")
        || card.parentElement?.nextElementSibling?.querySelector?.("[data-restore]")?.getAttribute("data-restore")
        || "";
      purgeNote(note.id, next);
    });
    purge.classList.add("is-warn");
    actions.append(restore, purge);
    card.append(actions);
    return card;
  }

  function renderEditor(editor) {
    const form = h("form", {
      class: `oi-note-editor${editor.status === "error" ? " is-error" : ""}`,
      "data-note-id": editor.id || "draft"
    });
    form.addEventListener("submit", (event) => event.preventDefault());
    if (editor.quote) form.append(h("blockquote", { class: "oi-note-quote", text: `「${editor.quote}」` }));
    if (editor.preview) {
      form.append(h("div", { class: "oi-note-body", html: renderNoteMarkdown(editor.body || "") }));
    } else {
      const field = h("textarea", {
        class: "oi-note-field",
        "aria-label": "笔记正文",
        placeholder: "写点什么…（支持 Markdown、$公式$）"
      });
      field.value = editor.body || "";
      field.addEventListener("input", () => {
        editor.body = field.value;
        scheduleSave();
      });
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void commitEditor(editor, { closeAfter: true });
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void closeEditor({ save: true }).then(() => render());
        }
      });
      form.append(field);
    }
    const bar = h("div", { class: "oi-note-editor-bar" });
    if (!editor.wasHighlight && editor.kind !== "paperNote" && editor.kind !== "highlight") {
      bar.append(kindSwitch(editor));
    }
    const preview = smallButton(editor.preview ? "编辑" : "预览", () => {
      editor.preview = !editor.preview;
      render();
      if (!editor.preview) root.querySelector(".oi-note-field")?.focus();
    });
    const hint = h("span", { class: "oi-note-hint", text: "空笔记不会保存" });
    const status = h("button", {
      type: "button",
      class: `oi-note-save-state${editor.status === "error" ? " is-error" : ""}`,
      "data-editor-status": "true",
      text: editorStatusText(editor)
    });
    status.addEventListener("click", () => {
      if (editor.status === "error") void commitEditor(editor);
    });
    bar.append(preview, hint, status);
    form.append(bar);
    return form;
  }

  function kindSwitch(editor) {
    const wrap = h("div", { class: "oi-note-kinds", role: "group", "aria-label": "种类" });
    for (const kind of ["note", "question"]) {
      const button = h("button", {
        type: "button",
        class: editor.kind === kind ? "is-on" : "",
        text: kindLabel(kind),
        "aria-pressed": editor.kind === kind ? "true" : "false"
      });
      button.addEventListener("click", () => {
        editor.kind = kind;
        if (!editor.isNew && noteBodySavable(editor.body)) void commitEditor(editor);
        render();
      });
      wrap.append(button);
    }
    return wrap;
  }

  function renderUndo() {
    if (!state.undo) return h("div", { class: "oi-note-undo", hidden: true });
    const toast = h("div", { class: "oi-note-undo", role: "status" });
    toast.append(
      h("span", { text: "已删除 1 条笔记" }),
      smallButton(`撤销 ${modLabel()}`, () => undo()),
      h("span", { class: "oi-note-undo-bar" })
    );
    toast.addEventListener("mouseenter", pauseUndo);
    toast.addEventListener("mouseleave", resumeUndo);
    toast.addEventListener("focusin", pauseUndo);
    toast.addEventListener("focusout", resumeUndo);
    return toast;
  }

  function onCardKey(event) {
    const cards = [...root.querySelectorAll(".oi-note-card")];
    if (!cards.length) return;
    const current = document.activeElement?.closest?.(".oi-note-card");
    const index = Math.max(0, cards.indexOf(current));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = cards[(index + step + cards.length) % cards.length];
      next?.focus();
      return;
    }
    if (!current) return;
    const id = current.dataset.noteId;
    const note = state.notes.find((item) => item.id === id);
    if (!note) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (anchorPresentation(note).kind !== "lost" && note.kind !== "paperNote") {
        state.linkedId = note.id;
        api.jumpAnchor?.(note);
        render();
        paint();
      }
    } else if (event.key === "e" || event.key === "E") {
      event.preventDefault();
      event.stopPropagation();
      editNote(note);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      void deleteNote(note);
    }
  }

  function paint() {
    const flow = api.flow?.();
    if (!flow) return;
    clearMarks(flow);
    const byBid = new Map();
    for (const note of state.notes) {
      if (!isAnnotationNote(note) || anchorPresentation(note).kind === "lost") continue;
      const bid = note.anchor?.bid || "";
      if (!bid) continue;
      if (!byBid.has(bid)) byBid.set(bid, []);
      byBid.get(bid).push(note);
    }
    const inline = pinsInline(flow);
    for (const block of flow.querySelectorAll(".rf-block[data-bid]")) {
      const rows = byBid.get(block.dataset.bid);
      if (!rows?.length) continue;
      paintBlockMarks(block, rows);
      paintPin(block, rows, inline);
    }
  }

  function clearMarks(flow) {
    flow.querySelectorAll(".oi-note-ghost").forEach((node) => node.remove());
    flow.querySelectorAll(".has-note-pin").forEach((node) => node.classList.remove("has-note-pin"));
    flow.querySelectorAll(".oi-note-mark").forEach((mark) => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      mark.remove();
      parent?.normalize?.();
    });
    flow.querySelectorAll(".oi-note-pin").forEach((pin) => pin.remove());
  }

  function paintBlockMarks(block, notes) {
    const zh = block.querySelector(".rf-zh") || block;
    const text = zh.textContent || "";
    const ranges = [];
    for (const note of notes) {
      const quote = note.anchor?.quote || "";
      let start = Number(note.anchor?.offset?.start);
      let end = Number(note.anchor?.offset?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || text.slice(start, end) !== quote) {
        if (!quote) continue;
        start = text.indexOf(quote);
        if (start < 0) continue;
        end = start + quote.length;
      }
      if (!(end > start)) continue;
      ranges.push({ start, end, note });
    }
    ranges.sort((a, b) => b.start - a.start);
    for (const range of ranges) wrapRange(zh, range.start, range.end, range.note);
  }

  function wrapRange(rootEl, start, end, note) {
    const parts = [];
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let node = walker.nextNode();
    while (node) {
      const len = node.textContent.length;
      const from = Math.max(start, pos);
      const to = Math.min(end, pos + len);
      if (to > from) parts.push({ node, from: from - pos, to: to - pos });
      pos += len;
      node = walker.nextNode();
    }
    for (const part of parts.reverse()) {
      let text = part.node;
      if (part.to < text.textContent.length) text.splitText(part.to);
      if (part.from > 0) text = text.splitText(part.from);
      const span = document.createElement("span");
      span.className = "oi-note-mark hl";
      const pres = anchorPresentation(note);
      if (pres.kind === "approx") span.classList.add("is-approx");
      if (note.id === state.linkedId) span.classList.add("is-linked", "linked");
      span.dataset.noteId = note.id;
      text.parentNode.insertBefore(span, text);
      span.append(text);
    }
  }

  function paintPin(block, notes, inline) {
    const model = pinModel(notes);
    if (!model) return;
    const first = notes.slice().sort((a, b) => (Number(a.anchor?.offset?.start) || 0) - (Number(b.anchor?.offset?.start) || 0))[0];
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = `oi-note-pin${model.approx ? " is-approx" : ""}${inline ? " is-inline" : ""}`;
    pin.dataset.noteId = first?.id || model.noteId;
    pin.textContent = model.label;
    pin.setAttribute("aria-label", model.count ? `${model.count} 条笔记` : "笔记");
    pin.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAt(pin.dataset.noteId);
    });
    if (inline) {
      const zh = block.querySelector(".rf-zh") || block;
      zh.append(pin);
    } else {
      block.classList.add("has-note-pin");
      block.append(pin);
    }
  }

  function pinsInline(flow) {
    const pane = api.pane?.() || flow.parentElement;
    if (!pane) return false;
    const gap = pane.getBoundingClientRect().right - flow.getBoundingClientRect().right;
    return gap < 40;
  }

  function openAt(id) {
    const note = state.notes.find((item) => item.id === id);
    if (!state.open) open(false);
    state.segment = "notes";
    state.view = "list";
    state.filter = "all";
    state.linkedId = id || "";
    render();
    paint();
    const card = root.querySelector(`[data-note-id="${cssEscape(id)}"]`);
    card?.scrollIntoView({ block: "nearest" });
    if (note) api.jumpAnchor?.(note);
  }

  function clearGhost() {
    document.querySelectorAll(".oi-note-ghost").forEach((node) => node.remove());
  }

  function syncGhost(block) {
    clearGhost();
    if (state.open || !block || !api.pointerFine?.()) return;
    if (!block.classList.contains("is-pair-current")) return;
    const flow = api.flow?.();
    const inline = flow ? pinsInline(flow) : false;
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = `oi-note-ghost${inline ? " is-inline" : ""}`;
    pin.textContent = "＋";
    pin.setAttribute("aria-label", "给这段写笔记 · n");
    const tip = document.createElement("span");
    tip.className = "oi-note-tip";
    tip.textContent = "给这段写笔记 · n";
    pin.append(tip);
    pin.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      composeCurrent();
    });
    if (inline) (block.querySelector(".rf-zh") || block).append(pin);
    else {
      block.classList.add("has-note-pin");
      block.append(pin);
    }
  }

  function hydrateMath(scope) {
    const katex = globalThis.katex;
    if (!katex?.render) return;
    scope.querySelectorAll(".oi-note-math").forEach((node) => {
      try {
        katex.render(node.getAttribute("data-tex") || "", node, {
          throwOnError: false,
          displayMode: node.getAttribute("data-display") === "1"
        });
      } catch {
        /* keep the escaped source */
      }
    });
  }

  function iconLost() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "lostsec-icon");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 14 14");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M7 1.8 12.2 12H1.8L7 1.8z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.2");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }

  function iconTrash() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3.5 4.5h9M6 4.5V3.2h4V4.5M5 6.2v6M8 6.2v6M11 6.2v6M4.2 4.5l.6 8.2h6.4l.6-8.2");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.2");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
    return svg;
  }

  function consumeEscape() {
    if (state.editor) {
      void closeEditor({ save: true }).then(() => render());
      return true;
    }
    if (state.menuOpen) {
      state.menuOpen = false;
      render();
      root.querySelector(".oi-notes-more")?.focus();
      return true;
    }
    if (state.view === "trash") {
      state.view = "list";
      render();
      return true;
    }
    if (state.open) {
      close(true);
      return true;
    }
    return false;
  }

  fileInput = h("input", {
    class: "oi-notes-file",
    type: "file",
    accept: "application/json,.json",
    tabindex: "-1",
    "aria-hidden": "true"
  });
  fileInput.addEventListener("change", () => {
    const picked = fileInput.files?.[0];
    fileInput.value = "";
    if (picked) void importFile(picked);
  });
  root.append(fileInput);

  document.addEventListener("pointerdown", (event) => {
    if (state.menuOpen && !event.target.closest?.(".oi-notes-menu, .oi-notes-more")) {
      state.menuOpen = false;
      render();
    }
    if (state.editor && !event.target.closest?.(".oi-note-editor")) {
      void closeEditor({ save: true }).then(() => render());
    }
  });

  const flow = () => api.flow?.();
  flow()?.addEventListener("pointermove", (event) => {
    if (state.open) {
      clearGhost();
      return;
    }
    const block = event.target?.closest?.(".rf-block");
    if (!block || !block.classList.contains("is-pair-current")) {
      clearGhost();
      return;
    }
    if (block.querySelector(".oi-note-ghost")) return;
    syncGhost(block);
  });
  flow()?.addEventListener("pointerleave", () => clearGhost());
  let markPress = null;
  flow()?.addEventListener("pointerdown", (event) => {
    const mark = event.target?.closest?.(".oi-note-mark, .oi-note-pin");
    markPress = mark ? { x: event.clientX, y: event.clientY, id: mark.dataset.noteId } : null;
  });
  flow()?.addEventListener("pointerup", (event) => {
    if (!markPress) return;
    const dx = event.clientX - markPress.x;
    const dy = event.clientY - markPress.y;
    const id = markPress.id;
    markPress = null;
    if (Math.hypot(dx, dy) >= 4) return;
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed) return;
    openAt(id);
  });

  window.addEventListener("resize", () => {
    if (state.open) syncPlace();
    paint();
  });
  const observer = new MutationObserver(() => {
    if (state.open) syncPlace();
  });
  observer.observe(workspace, { attributes: true, attributeFilter: ["data-source-mode", "data-source-side", "data-layout"] });

  syncChrome();

  return {
    toggle,
    open,
    close,
    syncLayoutChrome,
    isOpen: () => state.open,
    consumeEscape,
    undo,
    paint,
    refresh: () => reload({ quiet: true }),
    onDocumentReset() {
      state.docHash = "";
      state.notes = [];
      state.trash = [];
      state.editor = null;
      state.banners = [];
      state.loading = true;
      state.showSkeleton = false;
      state.failedIds.clear();
      render();
      paint();
    },
    onDocument(hash) {
      state.docHash = hash || "";
      void reload({ quiet: false });
    },
    fromSelection,
    composeCurrent,
    composePaper,
    openAt
  };
}
