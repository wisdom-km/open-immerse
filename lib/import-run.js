/**
 * Folder and JSON import.
 * The loop holds the oi-library-migrate lock. It keeps going while any
 * Open Immerse page is still attached. The last page to close stops on a
 * paper boundary and writes meta.import. There is no offscreen document.
 * The checkpoint stored through LibraryStore.writeImportMeta is the paper
 * id list, the cursor, and the directory handle. File bytes stay in the
 * folder and are read from that handle one paper at a time.
 */

import { LIBRARY_FORMAT, LIBRARY_SCHEMA } from "./library-store.js";
import {
  listLegacyFolder,
  readLegacyPaper
} from "./legacy-folder.js";

export const MIGRATE_LOCK = "oi-library-migrate";
export const SESSION_PAUSED = "libraryImportPaused";
export const SESSION_LATER = "libraryImportLater";

function lockAbortError() {
  const error = new Error("The lock request was aborted");
  error.name = "AbortError";
  return error;
}

export function createMemoryLocks() {
  const tables = new Map();
  return {
    request(name, options, callback) {
      const opts = typeof options === "function" ? {} : (options || {});
      const fn = typeof options === "function" ? options : callback;
      if (opts.signal?.aborted) return Promise.reject(lockAbortError());
      let bucket = tables.get(name);
      if (!bucket) {
        bucket = { held: false, queue: [] };
        tables.set(name, bucket);
      }
      if (bucket.held) {
        if (opts.ifAvailable) return Promise.resolve().then(() => fn(null));
        return new Promise((resolve, reject) => {
          let queued = true;
          const entry = () => {
            if (!queued) return;
            queued = false;
            opts.signal?.removeEventListener("abort", onAbort);
            this.request(name, opts, fn).then(resolve, reject);
          };
          const onAbort = () => {
            if (!queued) return;
            queued = false;
            const index = bucket.queue.indexOf(entry);
            if (index >= 0) bucket.queue.splice(index, 1);
            reject(lockAbortError());
          };
          bucket.queue.push(entry);
          opts.signal?.addEventListener("abort", onAbort, { once: true });
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
      },
      close() {
        try { channel.close(); } catch { /* already closed */ }
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

function chromeSession() {
  const area = globalThis.chrome?.storage?.session;
  if (!area || typeof area.get !== "function" || typeof area.set !== "function") return null;
  return {
    get(keys) { return area.get(keys); },
    set(patch) { return area.set(patch); }
  };
}

function sessionApi(deps) {
  const session = deps.session;
  if (session && typeof session.get === "function" && typeof session.set === "function") return session;
  const persisted = chromeSession();
  if (persisted) return persisted;
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

function nextId(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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
    source: meta?.source === "json" ? "json" : "folder",
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

function paperIdsOf(meta) {
  if (Array.isArray(meta?.paperIds) && meta.paperIds.length) {
    return meta.paperIds.map((item) => String(item || "")).filter(Boolean);
  }
  return (meta?.papers || []).map((paper) => String(paper?.docHash || "")).filter(Boolean);
}

function checkpoint(meta, view, handle) {
  const doneDocs = (meta.doneDocs || []).slice();
  return {
    source: meta.source === "json" ? "json" : "folder",
    folderName: meta.folderName || view.folder || "旧库",
    phase: view.phase,
    doneDocs,
    failedDocs: (meta.failedDocs || []).slice(),
    paperIds: paperIdsOf(meta),
    cursor: doneDocs.length,
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
    directoryHandle: handle || null,
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
  let live = false;
  let stop = false;
  let disposed = false;
  let detached = false;
  let handoffAbort = null;
  let resumeBusy = false;
  let resumeQueued = false;
  let resumeWait = false;
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
    if (handle) {
      try {
        meta.permission = await queryPermission(handle);
      } catch {
        meta.permission = "denied";
      }
    }
    const saved = checkpoint(meta, { ...view, phase }, handle);
    saved.permission = meta.permission || saved.permission;
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

  function papersClearedEarly() {
    const pending = paperIdsOf(meta).filter((docHash) => !(meta?.doneDocs || []).includes(docHash) && !(meta?.failedDocs || []).includes(docHash));
    return pending.length > 0 && !(meta?.papers || []).length;
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

  function showLater() {
    emit(viewFromMeta(meta, {
      phase: "resume",
      holds: true,
      later: true,
      source: meta?.source === "json" ? "json" : "folder"
    }));
  }

  async function runLoop() {
    holding = true;
    try {
      if (detached || disposed) return;
      if (await sessionFlag(session, SESSION_LATER)) {
        showLater();
        return;
      }
      stop = false;
      while (!stop) {
        const queue = paperQueue();
        if (!queue.length) {
          if (papersClearedEarly()) {
            await finish("interrupted");
            return;
          }
          break;
        }
        if (await sessionFlag(session, SESSION_PAUSED) || await sessionFlag(session, SESSION_LATER)) {
          stop = true;
          break;
        }
        const paper = queue[0];
        if (typeof deps.beforePaper === "function") await deps.beforePaper(paper, viewFromMeta(meta));
        if (stop || await sessionFlag(session, SESSION_PAUSED) || await sessionFlag(session, SESSION_LATER)) break;
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
      if (await sessionFlag(session, SESSION_LATER) && !(await sessionFlag(session, SESSION_PAUSED))) {
        showLater();
        return;
      }
      if (stop || await sessionFlag(session, SESSION_PAUSED)) {
        const paused = await sessionFlag(session, SESSION_PAUSED);
        await finish(paused ? "paused" : "interrupted");
        return;
      }
      await finish((meta.errors || []).length ? "error" : "done");
    } finally {
      holding = false;
    }
  }

  async function withLock(task, waitForLock = false) {
    let ran = false;
    // A new import tries once. A handoff waits: the closing page stops
    // waiting after 2s while the current paper may still hold the lock.
    const options = waitForLock ? {} : { ifAvailable: true };
    if (waitForLock) {
      handoffAbort?.abort();
      handoffAbort = new AbortController();
      options.signal = handoffAbort.signal;
    }
    try {
      await locks.request(MIGRATE_LOCK, options, async (lock) => {
        if (!lock || disposed || detached) return;
        ran = true;
        await task();
      });
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
    }
    return ran;
  }

  function stillIdle() {
    return !holding && !live;
  }

  async function resumeFromMeta(waitForLock = false) {
    if (!store || !stillIdle() || detached || disposed) return;
    if (resumeBusy) {
      resumeQueued = true;
      if (waitForLock) resumeWait = true;
      return;
    }
    resumeBusy = true;
    try {
      if (!stillIdle()) return;
      const saved = await store.readImportMeta();
      if (!stillIdle()) return;
      if (!saved || saved.phase === "done" || saved.phase === "abandoned" || saved.phase === "idle") {
        if (saved?.phase === "done") emit(viewFromMeta(saved, { phase: "done", holds: true }), false);
        return;
      }
      const later = await sessionFlag(session, SESSION_LATER);
      const paused = await sessionFlag(session, SESSION_PAUSED);
      if (!stillIdle()) return;
      meta = {
        ...saved,
        papers: [],
        doneDocs: Array.isArray(saved.doneDocs) ? saved.doneDocs.slice() : [],
        failedDocs: Array.isArray(saved.failedDocs) ? saved.failedDocs.slice() : [],
        errors: Array.isArray(saved.errors) ? saved.errors.map((item) => ({ ...item })) : [],
        ignored: Array.isArray(saved.ignored) ? saved.ignored.slice() : []
      };
      if (!stillIdle()) return;
      if (saved.phase === "error") {
        emit(viewFromMeta(meta, { phase: "error", holds: true, later }));
        return;
      }
      if (saved.phase === "rejected") {
        emit(viewFromMeta(meta, { phase: "rejected", holds: true, later }));
        return;
      }
      if (paused) {
        emit(viewFromMeta(meta, { phase: "paused", holds: true, later }));
        return;
      }
      if (later) {
        const phase = saved.phase === "incomplete" || saved.phase === "error" || saved.phase === "rejected"
          ? saved.phase
          : "resume";
        emit(viewFromMeta(meta, { phase, holds: true, later: true, source: saved.source === "json" ? "json" : "folder" }));
        return;
      }
      if (saved.source === "json") {
        emit(viewFromMeta(meta, { phase: "incomplete", holds: true, later, source: "json" }));
        if (saved.phase !== "incomplete") await persistMeta("incomplete");
        return;
      }
      handle = saved.directoryHandle || null;
      let permission = "prompt";
      try {
        permission = handle ? await queryPermission(handle) : "denied";
      } catch {
        permission = "denied";
      }
      if (!stillIdle()) return;
      // The stored permission string is not enough. After a restart the live
      // handle usually answers "prompt", and a moved folder throws.
      if (!handle || saved.unavailable || permission === "denied") {
        meta.unavailable = !handle || saved.unavailable === true || permission === "denied";
        emit(viewFromMeta(meta, { phase: "incomplete", holds: true, later }));
        if (saved.phase !== "incomplete") await persistMeta("incomplete");
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
        if (!stillIdle()) return;
        meta.unavailable = true;
        emit(viewFromMeta(meta, { phase: "incomplete", holds: true }));
        await persistMeta("incomplete");
        return;
      }
      if (!stillIdle()) return;
      if (listed.kind === "unreadable") {
        meta.unavailable = true;
        emit(viewFromMeta(meta, { phase: "incomplete", holds: true }));
        await persistMeta("incomplete");
        return;
      }
      meta.papers = listed.papers;
      meta.folderName = listed.root?.name || saved.folderName || "旧库";
      meta.parentAdjusted = listed.parentAdjusted === true;
      if (!stillIdle() || detached || disposed) return;
      live = true;
      try {
        const got = await withLock(async () => {
          emit(viewFromMeta(meta, { phase: "running", holds: true }));
          await runLoop();
        }, waitForLock);
        if (!got && !holding && !detached && !disposed) {
          emit(viewFromMeta(meta, { phase: "running", holds: false }), false);
        }
      } finally {
        if (!holding) live = false;
      }
    } finally {
      resumeBusy = false;
      if (resumeQueued) {
        resumeQueued = false;
        const wait = resumeWait;
        resumeWait = false;
        if (stillIdle()) void resumeFromMeta(wait);
      }
    }
  }

  async function importFolderBody(dirHandle) {
    emit({
      phase: "running",
      done: 0,
      total: null,
      folder: dirHandle?.name || "旧库",
      source: "folder",
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
    const permission = await queryPermission(root);
    meta = {
      source: "folder",
      folderName: root?.name || listed.folder || "旧库",
      phase: "running",
      doneDocs: [],
      failedDocs: [],
      papers: listed.papers,
      paperIds: listed.papers.map((paper) => paper.docHash),
      cursor: 0,
      total: listed.papers.length,
      added: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      ignored: listed.ignored || [],
      parentAdjusted: listed.parentAdjusted === true,
      permission,
      unavailable: false
    };
    emit(viewFromMeta(meta, { phase: "running", holds: true, done: 0 }));
    await persistMeta("running");
    const got = await withLock(() => runLoop());
    if (!got && !holding) emit(viewFromMeta(meta, { phase: "running", holds: false }), false);
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

  async function pauseImport(options = {}) {
    const remote = options.remote === true;
    await setSessionFlag(session, SESSION_PAUSED, true);
    stop = true;
    if (!holding && !remote) bus.post({ type: "import-command", command: "pause", from: id });
    if (holding && meta) {
      emit(viewFromMeta(meta, { phase: "paused", holds: true }));
      await persistMeta("paused");
    } else if (!holding) {
      emit({ ...view, phase: "paused", holds: true });
    }
  }

  async function resumeImport(options = {}) {
    const remote = options.remote === true;
    await setSessionFlag(session, SESSION_PAUSED, false);
    await setSessionFlag(session, SESSION_LATER, false);
    stop = false;
    if (holding) {
      if (meta) emit(viewFromMeta(meta, { phase: "running", holds: true }));
      return;
    }
    if (!remote && !live) bus.post({ type: "import-command", command: "resume", from: id });
    if (!stillIdle()) return;
    if (!meta || !(meta.papers || []).length) {
      await resumeFromMeta();
      return;
    }
    live = true;
    try {
      const got = await withLock(() => runLoop());
      if (!got && !holding) emit(viewFromMeta(meta, { phase: "running", holds: false }), false);
    } finally {
      if (!holding) live = false;
    }
  }

  async function laterImport(options = {}) {
    const remote = options.remote === true;
    await setSessionFlag(session, SESSION_LATER, true);
    if (!remote) bus.post({ type: "import-command", command: "later", from: id });
    emit({ ...view, later: true, holds: true }, false);
  }

  async function runImportBundle(bundle) {
    const notesOnly = Boolean(bundle?.format && bundle.format !== LIBRARY_FORMAT);
    const papers = !notesOnly && Array.isArray(bundle?.papers) ? bundle.papers : null;
    meta = {
      source: "json",
      folderName: "",
      phase: "running",
      doneDocs: [],
      failedDocs: [],
      papers: [],
      paperIds: (papers || []).map((item) => String(item?.paper?.docHash || item?.docHash || "")).filter(Boolean),
      cursor: 0,
      total: papers ? papers.length : 1,
      added: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      ignored: [],
      parentAdjusted: false,
      permission: "granted",
      unavailable: false
    };
    handle = null;
    stop = false;
    holding = true;
    emit(viewFromMeta(meta, { phase: "running", holds: true, source: "json" }));
    await persistMeta("running");
    const merged = { added: 0, updated: 0, skipped: 0, rejected: 0, errors: [] };
    try {
      const slicing = Boolean(papers && papers.length);
      const steps = slicing ? papers : [bundle];
      for (const step of steps) {
        if (stop) {
          await finish(meta.source === "json" ? "incomplete" : "interrupted");
          return merged;
        }
        if (typeof deps.beforePaper === "function") await deps.beforePaper(step, viewFromMeta(meta));
        if (stop) {
          await finish("incomplete");
          return merged;
        }
        const slice = slicing ? { ...bundle, papers: [step] } : step;
        const result = await store.importBundle(slice);
        merged.added += result.added || 0;
        merged.updated += result.updated || 0;
        merged.skipped += result.skipped || 0;
        merged.rejected += result.rejected || 0;
        if (Array.isArray(result.errors)) merged.errors.push(...result.errors);
        meta.added = merged.added;
        meta.updated = merged.updated;
        meta.skipped = merged.skipped;
        const hash = String(step?.paper?.docHash || step?.docHash || "");
        if (hash) meta.doneDocs = [...new Set([...(meta.doneDocs || []), hash])];
        meta.cursor = (meta.doneDocs || []).length;
        emit(viewFromMeta(meta, { phase: "running", holds: true, source: "json" }));
        await persistMeta("running");
      }
    } catch (error) {
      holding = false;
      if (error?.type === "schema" || error?.type === "format") {
        try { await store?.clearImportMeta?.(); } catch { /* the refusal is enough */ }
        meta = null;
        emit({
          phase: "rejected",
          reject: error?.type === "schema" ? "schema" : "format",
          schema: error?.schema,
          holds: true,
          folder: "",
          source: "json"
        });
        throw error;
      }
      meta.errors = [...(meta.errors || []), {
        docHash: "",
        title: "",
        reason: error?.type === "quota" ? "quota" : "corrupt",
        at: Date.now()
      }];
      await finish("incomplete");
      throw error;
    }
    if (stop) {
      await finish("incomplete");
      return merged;
    }
    try { await store?.clearImportMeta?.(); } catch { /* the papers are already in */ }
    meta = null;
    handle = null;
    holding = false;
    emit({
      phase: "report",
      holds: true,
      source: "json",
      added: merged.added,
      updated: merged.updated,
      skipped: merged.skipped,
      failed: merged.rejected,
      errors: merged.errors.map((item) => (
        typeof item === "string" ? { docHash: "", title: item, reason: "corrupt", at: 0 } : item
      )),
      notesOnly,
      folder: "",
      done: merged.added + merged.updated + merged.skipped,
      total: papers ? papers.length : null
    });
    return merged;
  }

  async function allowImport() {
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
    await setSessionFlag(session, SESSION_PAUSED, false);
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
    if (!stillIdle() && !live) return false;
    meta.papers = listed.papers;
    meta.folderName = listed.root?.name || meta.folderName;
    stop = false;
    const got = await withLock(() => runLoop());
    if (!got && !holding) emit(viewFromMeta(meta, { phase: "running", holds: false }), false);
    return true;
  }

  unlisten = bus.listen((message) => {
    if (!message || message.from === id) return;
    if (message.type === "import-lock-free") {
      if (!stillIdle()) return;
      void resumeFromMeta(true);
      return;
    }
    if (message.type === "import-command") {
      if (message.command === "pause" && holding) void pauseImport({ remote: true });
      else if (message.command === "resume" && stillIdle()) void resumeImport({ remote: true });
      else if (message.command === "later") void laterImport({ remote: true });
      return;
    }
    if (message.type === "import-progress" && message.view) {
      if (!stillIdle()) return;
      const remote = message.view;
      const phase = remote.phase;
      const mirror = phase === "running" || phase === "scanning" || phase === "paused" || phase === "done"
        || phase === "resume" || phase === "incomplete" || phase === "error" || phase === "rejected";
      if (!mirror) return;
      emit({ ...remote, holds: true }, false);
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
      detached = false;
      void resumeFromMeta();
      return token;
    },
    async detach(role) {
      const token = `${id}:${role || "page"}`;
      if (!attached.has(token)) return;
      attached.delete(token);
      presence.delete(token);
      if (attached.size > 0) return;
      detached = true;
      stop = true;
      handoffAbort?.abort();
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
      if (!stillIdle()) return view;
      live = true;
      try {
        return await importFolderBody(dirHandle);
      } finally {
        if (!holding) live = false;
      }
    },
    async importBundle(bundle) {
      if (!stillIdle()) return { added: 0, updated: 0, skipped: 0, rejected: 0, errors: [] };
      live = true;
      try {
        return await runImportBundle(bundle);
      } finally {
        if (!holding) live = false;
      }
    },
    async pause(options) { return pauseImport(options); },
    async resume(options) { return resumeImport(options); },
    async allow() {
      if (!stillIdle()) return false;
      live = true;
      try {
        return await allowImport();
      } finally {
        if (!holding) live = false;
      }
    },
    async later(options) { return laterImport(options); },
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
      if (!meta || !stillIdle()) return;
      live = true;
      try {
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
        if (!got && !holding) emit(viewFromMeta(meta, { phase: "running", holds: false }), false);
      } finally {
        if (!holding) live = false;
      }
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
      disposed = true;
      stop = true;
      live = false;
      unlisten();
      for (const token of attached) presence.delete(token);
      attached.clear();
      bus.close?.();
    }
  };
}
