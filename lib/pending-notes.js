/**
 * Notes typed while local storage is unavailable.
 * chrome.storage.session keeps them until the browser restarts.
 * Two tabs of the same paper do not share a bucket: the value is split by tab id.
 */

export function pendingNotesKey(docHash) {
  return `oi-notes-pending:${String(docHash || "")}`;
}

function emptyBag() {
  return { tabs: {} };
}

const flushTails = new Map();
const stageTails = new Map();

function navigatorLocks() {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== "function") return null;
  return locks;
}

function enqueueFlush(docHash, job) {
  const key = String(docHash || "");
  const prev = flushTails.get(key) || Promise.resolve();
  const run = prev.then(() => job(), () => job());
  const settled = run.then(() => {
    if (flushTails.get(key) === settled) flushTails.delete(key);
  }, () => {
    if (flushTails.get(key) === settled) flushTails.delete(key);
  });
  flushTails.set(key, settled);
  return run;
}

function withNotesLock(docHash, fn) {
  const locks = navigatorLocks();
  if (!locks) return Promise.resolve().then(fn);
  return locks.request(`oi-notes-pending:${String(docHash || "")}`, fn);
}

export function createPendingNotes({ storage, tabId, now } = {}) {
  const area = storage || memorySession();
  const tab = () => String(typeof tabId === "function" ? tabId() : (tabId || "tab"));
  const clock = typeof now === "function" ? now : () => Date.now();
  const counts = new Map();
  let liveHeld = "";
  let liveRelease = null;
  let liveGeneration = 0;

  function holdLive() {
    const id = tab();
    if (!id || liveHeld === id) return;
    const previousRelease = liveRelease;
    const generation = ++liveGeneration;
    liveHeld = id;
    liveRelease = null;
    if (typeof previousRelease === "function") previousRelease();
    const locks = navigatorLocks();
    if (!locks) return;
    try {
      void locks.request(`oi-notes-pending-live:${id}`, () => new Promise((resolve) => {
        if (generation !== liveGeneration) {
          resolve();
          return;
        }
        liveRelease = resolve;
      }));
    } catch {
      liveRelease = null;
    }
  }

  async function otherTabClosed(id) {
    if (id === tab()) return true;
    const locks = navigatorLocks();
    // Node tests have no Web Locks. A missing lock means the other tab is
    // already gone, which is what the closed-tab flush has to do.
    if (!locks) return true;
    let closed = true;
    await locks.request(`oi-notes-pending-live:${id}`, { ifAvailable: true }, (lock) => {
      closed = Boolean(lock);
    });
    return closed;
  }

  function remember(docHash, count) {
    counts.set(String(docHash || ""), count);
  }

  async function readBag(docHash) {
    const key = pendingNotesKey(docHash);
    const bag = await area.get(key);
    const value = bag && typeof bag === "object" ? bag : emptyBag();
    if (!value.tabs || typeof value.tabs !== "object") return emptyBag();
    return { tabs: { ...value.tabs } };
  }

  async function writeBag(docHash, value) {
    await area.set(pendingNotesKey(docHash), value);
  }

  holdLive();

  async function stageOne(hash, input) {
    const bag = await readBag(hash);
    const key = String(input?.id || input?.noteId || input?.tempId || `tmp-${clock().toString(36)}`);
    const rows = Array.isArray(bag.tabs[tab()]) ? bag.tabs[tab()].slice() : [];
    const stagedKey = (item) => String(item?.noteId || item?.tempId || "");
    const index = rows.findIndex((item) => stagedKey(item) === key);
    const previous = index >= 0 ? rows[index] : null;
    const created = input?.op === "create" || !input?.id || String(input.id).startsWith("tmp-") || previous?.op === "create";
    const row = {
      tempId: created ? key : undefined,
      noteId: created ? undefined : key,
      op: input?.op || previous?.op || (created ? "create" : "update"),
      body: String(input?.body || ""),
      anchor: input?.anchor ?? null,
      kind: input?.kind || previous?.kind || "note",
      author: input?.author || previous?.author || "me",
      page: input?.page,
      anchorState: input?.anchorState,
      updatedAt: Number(input?.updatedAt) || clock()
    };
    if (!row.tempId) delete row.tempId;
    if (!row.noteId) delete row.noteId;
    if (index >= 0) rows[index] = row;
    else rows.push(row);
    bag.tabs[tab()] = rows;
    remember(hash, rows.length);
    await writeBag(hash, bag);
    return {
      id: row.noteId || row.tempId,
      pending: true,
      updatedAt: row.updatedAt,
      body: row.body,
      kind: row.kind
    };
  }

  return {
    holdLive,
    async list(docHash) {
      const bag = await readBag(docHash);
      const rows = bag.tabs[tab()];
      const list = Array.isArray(rows) ? rows.map((item) => ({ ...item })) : [];
      remember(docHash, list.length);
      return list;
    },
    pendingNow(docHash) {
      return counts.get(String(docHash || "")) || 0;
    },
    hydrate(docHash) {
      return this.list(docHash).then((rows) => rows.length);
    },
    async stage(docHash, input) {
      holdLive();
      const hash = String(docHash || input?.docHash || "");
      const prev = stageTails.get(hash) || Promise.resolve();
      const run = prev.then(() => stageOne(hash, input), () => stageOne(hash, input));
      const settled = run.then(() => {
        if (stageTails.get(hash) === settled) stageTails.delete(hash);
      }, () => {
        if (stageTails.get(hash) === settled) stageTails.delete(hash);
      });
      stageTails.set(hash, settled);
      return run;
    },
    async count(docHash) {
      return (await this.list(docHash)).length;
    },
    async flush(docHash, put, options = {}) {
      // One open writes each staged note once. A second flush of the same
      // paper waits, and a new note uses its tempId so a repeated put updates
      // that row instead of inserting another. Another tab that is still open
      // keeps its own bucket.
      holdLive();
      const hash = String(docHash || "");
      return enqueueFlush(hash, () => withNotesLock(hash, async () => {
        const bag = await readBag(hash);
        const ids = options.allTabs ? Object.keys(bag.tabs || {}) : [tab()];
        let saved = 0;
        for (const id of ids) {
          if (options.allTabs && !(await otherTabClosed(id))) continue;
          const rows = (Array.isArray(bag.tabs?.[id]) ? bag.tabs[id] : [])
            .slice()
            .sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
          for (const row of rows) {
            await put({
              id: row.noteId || row.tempId,
              docHash: hash,
              kind: row.kind || "note",
              author: row.author || "me",
              body: row.body,
              anchor: row.anchor,
              anchorState: row.anchorState,
              page: row.page,
              updatedAt: row.updatedAt
            });
            saved += 1;
            const fresh = await readBag(hash);
            const kept = (fresh.tabs[id] || []).filter((item) => {
              if (row.noteId && item.noteId === row.noteId && item.updatedAt === row.updatedAt) return false;
              if (row.tempId && item.tempId === row.tempId && item.updatedAt === row.updatedAt) return false;
              return true;
            });
            if (kept.length) fresh.tabs[id] = kept;
            else delete fresh.tabs[id];
            await writeBag(hash, fresh);
          }
        }
        const after = await readBag(hash);
        remember(hash, Array.isArray(after.tabs[tab()]) ? after.tabs[tab()].length : 0);
        return saved;
      }));
    }
  };
}

export function bindPendingUnload(count, target = globalThis.window) {
  if (!target || typeof target.addEventListener !== "function") return () => {};
  const onBefore = (event) => {
    const pending = typeof count === "function" ? count() : count;
    if (!pending) return;
    event.preventDefault();
    event.returnValue = "";
  };
  target.addEventListener("beforeunload", onBefore);
  return () => target.removeEventListener("beforeunload", onBefore);
}

function memorySession() {
  const data = new Map();
  return {
    async get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async set(key, value) {
      data.set(key, value);
    }
  };
}

export function chromeSessionArea(chrome = globalThis.chrome) {
  const session = chrome?.storage?.session;
  if (!session || typeof session.get !== "function" || typeof session.set !== "function") return null;
  return {
    async get(key) {
      const bag = await session.get(key);
      return bag?.[key] ?? null;
    },
    async set(key, value) {
      await session.set({ [key]: value });
    }
  };
}
