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

export function createPendingNotes({ storage, tabId, now } = {}) {
  const area = storage || memorySession();
  const tab = () => String(typeof tabId === "function" ? tabId() : (tabId || "tab"));
  const clock = typeof now === "function" ? now : () => Date.now();
  const counts = new Map();

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

  return {
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
      const hash = String(docHash || input?.docHash || "");
      const bag = await readBag(hash);
      const id = String(input?.id || input?.noteId || input?.tempId || `tmp-${clock().toString(36)}`);
      const row = {
        tempId: input?.id ? undefined : id,
        noteId: input?.id ? String(input.id) : undefined,
        op: input?.op || (input?.id ? "update" : "create"),
        body: String(input?.body || ""),
        anchor: input?.anchor ?? null,
        kind: input?.kind || "note",
        author: input?.author || "me",
        page: input?.page,
        anchorState: input?.anchorState,
        updatedAt: Number(input?.updatedAt) || clock()
      };
      if (!row.tempId) delete row.tempId;
      if (!row.noteId) delete row.noteId;
      const rows = Array.isArray(bag.tabs[tab()]) ? bag.tabs[tab()].slice() : [];
      const index = rows.findIndex((item) => (item.noteId && item.noteId === row.noteId) || (item.tempId && item.tempId === row.tempId));
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
    },
    async count(docHash) {
      return (await this.list(docHash)).length;
    },
    async flush(docHash, put) {
      const rows = (await this.list(docHash)).sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
      let saved = 0;
      for (const row of rows) {
        await put({
          id: row.noteId,
          docHash,
          kind: row.kind || "note",
          author: row.author || "me",
          body: row.body,
          anchor: row.anchor,
          anchorState: row.anchorState,
          page: row.page,
          updatedAt: row.updatedAt
        });
        saved += 1;
        const bag = await readBag(docHash);
        const rest = (bag.tabs[tab()] || []).filter((item) => item !== row && item.updatedAt !== row.updatedAt);
        const kept = (bag.tabs[tab()] || []).filter((item) => {
          if (row.noteId && item.noteId === row.noteId && item.updatedAt === row.updatedAt) return false;
          if (row.tempId && item.tempId === row.tempId && item.updatedAt === row.updatedAt) return false;
          return true;
        });
        bag.tabs[tab()] = kept;
        if (!kept.length) delete bag.tabs[tab()];
        remember(docHash, kept.length);
        await writeBag(docHash, bag);
        void rest;
      }
      return saved;
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
