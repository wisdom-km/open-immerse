/**
 * Folder and JSON import.
 * The loop holds the oi-library-migrate lock. It keeps going while any
 * Open Immerse page is still attached. The last page to close stops on a
 * paper boundary and writes meta.import. There is no offscreen document.
 * Directory handles are stored through LibraryStore.writeImportMeta.
 */

import { LIBRARY_FORMAT, LIBRARY_SCHEMA } from "./library-store.js";
import {
  listLegacyFolder,
  readLegacyPaper,
  reviveDirectory,
  snapshotDirectory
} from "./legacy-folder.js";

export const MIGRATE_LOCK = "oi-library-migrate";
export const SESSION_PAUSED = "libraryImportPaused";
export const SESSION_LATER = "libraryImportLater";

export function createMemoryLocks() {
  const tables = new Map();
  return {
    request(name, options, callback) {
      const opts = typeof options === "function" ? {} : (options || {});
      const fn = typeof options === "function" ? options : callback;
      let bucket = tables.get(name);
      if (!bucket) {
        bucket = { held: false, queue: [] };
        tables.set(name, bucket);
      }
      if (bucket.held) {
        if (opts.ifAvailable) return Promise.resolve().then(() => fn(null));
        return new Promise((resolve, reject) => {
          bucket.queue.push(() => {
            this.request(name, opts, fn).then(resolve, reject);
          });
        });
      }
      bucket.held = true;
      return Promise.resolve()
        .then(() => fn({ name }))
        .finally(() => {
          bucket.held = false;
          const next = bucket.queue.shift();
          if (next) next();
        });
    }
  };
}

export function createImportBus() {
  const listeners = new Set();
  return {
    post(message) {
      for (const fn of [...listeners]) {
        try {
          fn(message);
        } catch {
          /* one listener must not stop the others */
        }
      }
    },
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}

export function createPresence() {
  const ids = new Set();
  return {
    add(id) { ids.add(id); },
    delete(id) { ids.delete(id); },
    has(id) { return ids.has(id); },
    size() { return ids.size; }
  };
}

function browserBus() {
  if (typeof BroadcastChannel !== "function") return createImportBus();
  try {
    const channel = new BroadcastChannel("oi-library");
    const listeners = new Set();
    channel.onmessage = (event) => {
      for (const fn of [...listeners]) fn(event?.data || {});
    };
    return {
      post(message) {
        try {
          channel.postMessage(message);
        } catch {
          /* the channel can close with the page */
        }
      },
      listen(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }
    };
  } catch {
    return createImportBus();
  }
}

function browserLocks() {
  const locks = globalThis.navigator?.locks;
  if (locks && typeof locks.request === "function") return locks;
  return createMemoryLocks();
}

function memorySession() {
  const data = new Map();
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : (keys == null ? [] : [keys]);
      const out = {};
      for (const key of list) {
        if (data.has(key)) out[key] = data.get(key);
      }
      return out;
    },
    async set(patch) {
      for (const [key, value] of Object.entries(patch || {})) data.set(key, value);
    }
  };
}

function sessionApi(deps) {
  const session = deps.session;
  if (session && typeof session.get === "function" && typeof session.set === "function") return session;
  if (!deps._session) deps._session = memorySession();
  return deps._session;
}

async function sessionFlag(session, key) {
  try {
    const bag = await session.get([key]);
    return bag?.[key] === true;
  } catch {
    return false;
  }
}

async function setSessionFlag(session, key, value) {
  try {
    await session.set({ [key]: value === true });
  } catch {
    /* session storage is best-effort */
  }
}

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

function blankView() {
  return {
    phase: "idle",
    done: 0,
    total: null,
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    folder: "",
    holds: false,
    later: false,
    parentAdjusted: false,
    ignored: [],
    errors: [],
    reject: "",
    persisted: true
  };
}

function viewFromMeta(meta, extra = {}) {
  const doneDocs = Array.isArray(meta?.doneDocs) ? meta.doneDocs : [];
  const errors = Array.isArray(meta?.errors) ? meta.errors : [];
  return {
    phase: meta?.phase || "idle",
    done: doneDocs.length,
    total: Number.isFinite(meta?.total) ? meta.total : null,
    added: meta?.added || 0,
    updated: meta?.updated || 0,
    skipped: meta?.skipped || 0,
    failed: errors.length,
    importedPapers: (meta?.paperAdded || 0) + (meta?.paperUpdated || 0),
    folder: meta?.folderName || "旧库",
    holds: true,
    later: false,
    parentAdjusted: meta?.parentAdjusted === true,
    ignored: Array.isArray(meta?.ignored) ? meta.ignored.slice() : [],
    errors: errors.map((item) => ({ ...item })),
    reject: meta?.reject || "",
    persisted: extra.persisted !== false,
    ...extra
  };
}

function checkpoint(meta, view) {
  return {
    folderName: meta.folderName || view.folder || "旧库",
    phase: view.phase,
    doneDocs: (meta.doneDocs || []).slice(),
    failedDocs: (meta.failedDocs || []).slice(),
    total: meta.total ?? view.total,
    added: view.added || 0,
    updated: view.updated || 0,
    skipped: view.skipped || 0,
    paperAdded: meta.paperAdded || 0,
    paperUpdated: meta.paperUpdated || 0,
    errors: (view.errors || meta.errors || []).map((item) => ({
      docHash: String(item.docHash || ""),
      title: item.title ? String(item.title) : "",
      reason: String(item.reason || ""),
      at: item.at || 0
    })),
    ignored: Array.isArray(meta.ignored) ? meta.ignored.slice() : [],
    parentAdjusted: meta.parentAdjusted === true,
    permission: meta.permission || "prompt",
    unavailable: meta.unavailable === true,
    tree: meta.tree || null,
    reject: view.reject || "",
    updatedAt: Date.now()
  };
}

export function createImportCoordinator(deps = {}) {
  const store = deps.store;
  const locks = deps.locks || browserLocks();
  const bus = deps.bus || browserBus();
  const presence = deps.presence || createPresence();
  const id = deps.id || nextId("import");
  const session = sessionApi(deps);
  const listeners = new Set();
  let view = blankView();
  let meta = null;
  let handle = null;
  let holding = false;
  let stop = false;
  let attached = new Set();
  let unlisten = () => {};

  function emit(next, broadcast = true) {
    view = { ...blankView(), ...next };
    for (const fn of listeners) {
      try {
        fn(view);
      } catch {
        /* a panel must not stop the import */
      }
    }
    if (!broadcast) return;
    bus.post({
      type: "import-progress",
      from: id,
      view: { ...view, holds: false }
    });
  }

  async function queryPermission(dir) {
    if (typeof deps.queryPermission === "function") return deps.queryPermission(dir);
    if (dir && typeof dir.queryPermission === "function") {
      try {
        return await dir.queryPermission({ mode: "read" });
      } catch {
        return "denied";
      }
    }
    return dir?.permission || "prompt";
  }

  async function requestPermission(dir) {
    if (typeof deps.decidePermission === "function") return deps.decidePermission(dir);
    if (dir && typeof dir.requestPermission === "function") {
      try {
        return await dir.requestPermission({ mode: "read" });
      } catch {
        return "denied";
      }
    }
    return "denied";
  }

  async function persistMeta(phase) {
    if (!meta || !store) return;
    meta.phase = phase;
    meta.permission = await queryPermission(handle);
    const saved = checkpoint(meta, { ...view, phase });
    saved.permission = meta.permission;
    saved.tree = meta.tree || null;
    saved.unavailable = meta.unavailable === true;
    try {
      await store.writeImportMeta(saved);
    } catch {
      /* the papers already committed stay; the next open retries */
    }
  }

  function paperQueue() {
    const done = new Set(meta?.doneDocs || []);
    const failed = new Set(meta?.failedDocs || []);
    return (meta?.papers || []).filter((paper) => !done.has(paper.docHash) && !failed.has(paper.docHash));
  }

  async function importOne(paper) {
    const now = typeof deps.now === "function" ? deps.now() : Date.now();
    const prior = await store.getPaper(paper.docHash);
    const built = await readLegacyPaper(paper.handle, paper.docHash, now);
    if (built.error) {
      const error = { ...built.error, at: now };
      meta.errors = (meta.errors || []).filter((item) => item.docHash !== paper.docHash);
      meta.errors.push(error);
      meta.failedDocs = [...new Set([...(meta.failedDocs || []), paper.docHash])];
      return;
    }
    let result;
    try {
      result = await store.importBundle({
        format: LIBRARY_FORMAT,
        schema: LIBRARY_SCHEMA,
        papers: [built.entry]
      });
    } catch (error) {
      const reason = error?.type === "quota" ? "quota" : (error?.type === "blocked" || error?.type === "private" ? "blocked" : "corrupt");
      meta.errors = (meta.errors || []).filter((item) => item.docHash !== paper.docHash);
      meta.errors.push({
        docHash: paper.docHash,
        title: built.entry?.paper?.title || "",
        reason,
        at: now
      });
      if (reason !== "quota") meta.failedDocs = [...new Set([...(meta.failedDocs || []), paper.docHash])];
      if (reason === "quota" || reason === "blocked") {
        const stopError = new Error(reason);
        stopError.reason = reason;
        throw stopError;
      }
      return;
    }
    meta.added = (meta.added || 0) + (result.added || 0);
    meta.updated = (meta.updated || 0) + (result.updated || 0);
    meta.skipped = (meta.skipped || 0) + (result.skipped || 0);
    meta.failed = (meta.errors || []).length + (result.rejected || 0);
    if (!prior) meta.paperAdded = (meta.paperAdded || 0) + 1;
    else if ((result.updated || 0) > 0) meta.paperUpdated = (meta.paperUpdated || 0) + 1;
    else meta.paperSkipped = (meta.paperSkipped || 0) + 1;
    meta.doneDocs = [...new Set([...(meta.doneDocs || []), paper.docHash])];
    meta.failedDocs = (meta.failedDocs || []).filter((hash) => hash !== paper.docHash);
    meta.errors = (meta.errors || []).filter((item) => item.docHash !== paper.docHash);
  }

  async function finish(phase) {
    emit(viewFromMeta(meta, { phase, holds: true, folder: meta.folderName }));
    await persistMeta(phase);
    holding = false;
  }

  async function runLoop() {
    stop = false;
    holding = true;
    while (!stop) {
      const queue = paperQueue();
      if (!queue.length) break;
      const paper = queue[0];
      if (typeof deps.beforePaper === "function") await deps.beforePaper(paper, viewFromMeta(meta));
      if (stop) break;
      try {
        await importOne(paper);
      } catch {
        await finish("error");
        return;
      }
      emit(viewFromMeta(meta, {
        phase: "running",
        holds: true,
        folder: meta.folderName,
        parentAdjusted: meta.parentAdjusted === true
      }));
      await persistMeta("running");
    }
    if (stop) {
      const paused = await sessionFlag(session, SESSION_PAUSED);
      await finish(paused ? "paused" : "interrupted");
      return;
    }
    await finish((meta.errors || []).length ? "error" : "done");
  }

  async function withLock(task) {
    let ran = false;
    await locks.request(MIGRATE_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      ran = true;
      await task();
    });
    return ran;
  }

  async function resumeFromMeta() {
    if (!store) return;
    const saved = await store.readImportMeta();
    if (!saved || saved.phase === "done" || saved.phase === "abandoned" || saved.phase === "idle") {
      if (saved?.phase === "done") emit(viewFromMeta(saved, { phase: "done", holds: true }), false);
      return;
    }
    meta = {
      ...saved,
      papers: [],
      doneDocs: Array.isArray(saved.doneDocs) ? saved.doneDocs.slice() : [],
      failedDocs: Array.isArray(saved.failedDocs) ? saved.failedDocs.slice() : [],
      errors: Array.isArray(saved.errors) ? saved.errors.map((item) => ({ ...item })) : [],
      ignored: Array.isArray(saved.ignored) ? saved.ignored.slice() : []
    };
    const later = await sessionFlag(session, SESSION_LATER);
    const paused = await sessionFlag(session, SESSION_PAUSED);
    if (saved.phase === "error") {
      emit(viewFromMeta(meta, { phase: "error", holds: true, later }));
      return;
    }
    if (saved.phase === "rejected") {
      emit(viewFromMeta(meta, { phase: "rejected", holds: true, later }));
      return;
    }
    if (paused && saved.phase === "paused") {
      emit(viewFromMeta(meta, { phase: "paused", holds: true, later }));
      return;
    }
    handle = saved.tree ? reviveDirectory(saved.tree, saved.permission || "prompt") : null;
    if (handle) handle.permission = saved.permission || handle.permission;
    let permission = "prompt";
    try {
      permission = handle ? await queryPermission(handle) : "denied";
    } catch {
      permission = "denied";
    }
    if (!handle || saved.unavailable || permission === "denied" || saved.phase === "incomplete") {
      meta.unavailable = !handle || saved.unavailable === true || permission === "denied";
      emit(viewFromMeta(meta, { phase: "incomplete", holds: true, later }));
      if (saved.phase !== "incomplete") await persistMeta("incomplete");
      return;
    }
    if (permission === "prompt") {
      emit(viewFromMeta(meta, { phase: "resume", holds: true, later }));
      return;
    }
    if (permission !== "granted") {
      emit(viewFromMeta(meta, { phase: "resume", holds: true, later }));
      return;
    }
    let listed;
    try {
      listed = await listLegacyFolder(handle);
    } catch {
      meta.unavailable = true;
      emit(viewFromMeta(meta, { phase: "incomplete", holds: true }));
      await persistMeta("incomplete");
      return;
    }
    if (listed.kind === "unreadable") {
      meta.unavailable = true;
      emit(viewFromMeta(meta, { phase: "incomplete", holds: true }));
      await persistMeta("incomplete");
      return;
    }
    meta.papers = listed.papers;
    meta.folderName = listed.root?.name || saved.folderName || "旧库";
    const got = await withLock(async () => {
      emit(viewFromMeta(meta, { phase: "running", holds: true }));
      await runLoop();
    });
    if (!got) emit(viewFromMeta(meta, { phase: "running", holds: false }), false);
  }

  async function startListed(listed, sourceHandle) {
    if (listed.kind === "empty" || listed.kind === "unrelated" || listed.kind === "unreadable") {
      const folder = listed.folder || sourceHandle?.name || "旧库";
      emit({
        phase: "rejected",
        reject: listed.kind === "empty" ? "empty" : (listed.kind === "unreadable" ? "unreadable" : "unrelated"),
        folder,
        holds: true,
        done: 0,
        total: 0
      });
      return view;
    }
    const root = listed.root || sourceHandle;
    handle = root;
    const tree = await snapshotDirectory(root);
    const permission = await queryPermission(root);
    meta = {
      folderName: root?.name || listed.folder || "旧库",
      phase: "running",
      doneDocs: [],
      failedDocs: [],
      papers: listed.papers,
      total: listed.papers.length,
      added: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      ignored: listed.ignored || [],
      parentAdjusted: listed.parentAdjusted === true,
      permission,
      unavailable: false,
      tree
    };
    emit(viewFromMeta(meta, { phase: "running", holds: true, done: 0 }));
    const got = await withLock(() => runLoop());
    if (!got) emit(viewFromMeta(meta, { phase: "running", holds: false }), false);
    return {
      added: meta.added || 0,
      updated: meta.updated || 0,
      skipped: meta.skipped || 0,
      failed: (meta.errors || []).length,
      ignored: meta.ignored || [],
      kind: listed.kind,
      folder: meta.folderName
    };
  }

  unlisten = bus.listen((message) => {
    if (!message || message.from === id) return;
    if (message.type === "import-lock-free") {
      void resumeFromMeta();
      return;
    }
    if (message.type === "import-progress" && message.view) {
      if (holding) return;
      const remote = message.view;
      const show = remote.phase === "resume" || remote.phase === "incomplete" || remote.phase === "error" || remote.phase === "rejected";
      emit({ ...remote, holds: show }, false);
    }
    if (message.type === "migration-continue") deps.onMigrationContinue?.(message);
  });

  return {
    id,
    state: () => view,
    subscribe(fn) {
      listeners.add(fn);
      fn(view);
      return () => listeners.delete(fn);
    },
    attach(role) {
      const token = `${id}:${role || "page"}`;
      if (attached.has(token)) return token;
      attached.add(token);
      presence.add(token);
      void resumeFromMeta();
      return token;
    },
    async detach(role) {
      const token = `${id}:${role || "page"}`;
      attached.delete(token);
      presence.delete(token);
      if (attached.size > 0) return;
      stop = true;
      if (holding) {
        const started = Date.now();
        while (holding && Date.now() - started < 2000) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } else if (meta && (view.phase === "running" || view.phase === "scanning")) {
        await persistMeta("interrupted");
      }
      bus.post({ type: "import-lock-free", from: id });
    },
    async importFolder(dirHandle) {
      emit({
        phase: "running",
        done: 0,
        total: null,
        folder: dirHandle?.name || "旧库",
        holds: true,
        added: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        ignored: [],
        parentAdjusted: false,
        reject: ""
      });
      const listed = await listLegacyFolder(dirHandle);
      return startListed(listed, dirHandle);
    },
    async importBundle(bundle) {
      try {
        const result = await store.importBundle(bundle);
        const notesOnly = bundle?.format && bundle.format !== LIBRARY_FORMAT;
        emit({
          phase: "report",
          holds: true,
          added: result.added || 0,
          updated: result.updated || 0,
          skipped: result.skipped || 0,
          failed: result.rejected || 0,
          errors: Array.isArray(result.errors) ? result.errors.map((item) => (
            typeof item === "string" ? { docHash: "", title: item, reason: "corrupt", at: 0 } : item
          )) : [],
          notesOnly: notesOnly === true,
          folder: "",
          done: 0,
          total: null
        });
        return result;
      } catch (error) {
        const schema = error?.schema;
        emit({
          phase: "rejected",
          reject: error?.type === "schema" ? "schema" : "format",
          schema,
          holds: true,
          folder: ""
        });
        throw error;
      }
    },
    async pause() {
      await setSessionFlag(session, SESSION_PAUSED, true);
      stop = true;
      if (meta) {
        emit(viewFromMeta(meta, { phase: "paused", holds: true }));
        await persistMeta("paused");
      } else {
        emit({ ...view, phase: "paused", holds: true });
      }
    },
    async resume() {
      await setSessionFlag(session, SESSION_PAUSED, false);
      await setSessionFlag(session, SESSION_LATER, false);
      if (!meta) {
        await resumeFromMeta();
        return;
      }
      stop = false;
      const got = await withLock(() => runLoop());
      if (!got) emit(viewFromMeta(meta, { phase: "running", holds: false }), false);
    },
    async allow() {
      const result = await requestPermission(handle);
      if (result !== "granted") {
        if (meta) {
          meta.permission = result || "denied";
          emit(viewFromMeta(meta, { phase: "incomplete", holds: true }));
          await persistMeta("incomplete");
        }
        return false;
      }
      if (handle) handle.permission = "granted";
      if (meta) meta.permission = "granted";
      await setSessionFlag(session, SESSION_LATER, false);
      let listed = null;
      try {
        listed = handle ? await listLegacyFolder(handle) : null;
      } catch {
        listed = null;
      }
      if (!listed || listed.kind === "unreadable") {
        if (meta) {
          meta.unavailable = true;
          emit(viewFromMeta(meta, { phase: "incomplete", holds: true }));
          await persistMeta("incomplete");
        }
        return false;
      }
      meta.papers = listed.papers;
      stop = false;
      const got = await withLock(() => runLoop());
      if (!got) emit(viewFromMeta(meta, { phase: "running", holds: false }), false);
      return true;
    },
    async later() {
      await setSessionFlag(session, SESSION_LATER, true);
      emit({ ...view, later: true, holds: true });
    },
    async abandon() {
      await store?.clearImportMeta?.();
      meta = null;
      handle = null;
      stop = true;
      await setSessionFlag(session, SESSION_PAUSED, false);
      await setSessionFlag(session, SESSION_LATER, false);
      emit(blankView());
    },
    async retry() {
      if (!meta) return;
      const retryable = new Set(["quota", "corrupt"]);
      const back = (meta.errors || []).filter((item) => retryable.has(item.reason)).map((item) => item.docHash);
      meta.failedDocs = (meta.failedDocs || []).filter((hash) => !back.includes(hash));
      meta.errors = (meta.errors || []).filter((item) => !retryable.has(item.reason));
      stop = false;
      if (handle && (!meta.papers || !meta.papers.length)) {
        try {
          const listed = await listLegacyFolder(handle);
          meta.papers = listed.papers;
        } catch {
          meta.unavailable = true;
          emit(viewFromMeta(meta, { phase: "incomplete", holds: true }));
          return;
        }
      }
      const got = await withLock(() => runLoop());
      if (!got) emit(viewFromMeta(meta, { phase: "running", holds: false }), false);
    },
    errorsForExport() {
      return (view.errors || meta?.errors || []).map((item) => ({
        docHash: String(item.docHash || ""),
        title: item.title ? String(item.title) : "",
        reason: String(item.reason || ""),
        at: item.at || 0
      }));
    },
    destroy() {
      stop = true;
      unlisten();
      for (const token of attached) presence.delete(token);
      attached.clear();
    }
  };
}
