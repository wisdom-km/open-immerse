/**
 * The one library store the reader uses.
 * Notes go through the panel's store. Other notes stores created inside
 * LibraryStore pass capture:false and are not registered here.
 *
 * Each tab has its own sender id. Dedupe is senderId plus seq.
 * A channel token that every tab starts at 1 made the other tab drop the
 * message as its own.
 */

import { createLibraryStore } from "./library-store.js";
import { sharedNotesStore } from "./notes-anchor.js";
import { mergeStoredPagePairs } from "./pdf-library.js";
import { clearFormulaDoc } from "./formula-cache-client.js";
import { noteLibraryDeleteEvent } from "./library-writes.js";

let store = null;
let channel = null;
let session = null;

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function noteEvent(name, result, args) {
  const docHash = result?.docHash
    || result?.note?.docHash
    || args?.[0]?.docHash
    || (Array.isArray(result) ? result[0]?.docHash : "")
    || "";
  return { collection: "notes", docHash: String(docHash || ""), type: name };
}

function bindNotes(notes, publish) {
  if (!notes || typeof notes.put !== "function") return;
  notes.__oiBoundPublish = publish;
  if (notes.__oiNotesBroadcast) return;
  notes.__oiNotesBroadcast = true;
  for (const name of ["put", "bulkPut", "softDelete", "restore", "purge", "import"]) {
    const original = notes[name];
    if (typeof original !== "function") continue;
    notes[name] = async (...args) => {
      const result = await original.apply(notes, args);
      try {
        notes.__oiBoundPublish?.(noteEvent(name, result, args));
      } catch {
        /* the write already landed */
      }
      return result;
    };
  }
}

export function createLibrarySession(options = {}) {
  const senderId = options.senderId || randomId();
  let seq = 0;
  const seen = new Set();
  const notes = options.notes || sharedNotesStore();
  let live = null;

  function post(message) {
    if (typeof options.post === "function") {
      options.post(message);
      return;
    }
    if (!live) return;
    try {
      live.postMessage(message);
    } catch {
      /* the writing tab already notified its own listeners */
    }
  }

  function publish(event) {
    if (!event) return;
    seq += 1;
    post({ ...event, senderId, seq });
  }

  bindNotes(notes, publish);

  const library = options.store || createLibraryStore({
    notes,
    deleteFormula(hash) {
      return clearFormulaDoc(hash);
    },
    mergePairs: (existing, incoming, blocks, lang, page) => mergeStoredPagePairs(existing, incoming, blocks, lang, page),
    onNotify(event) {
      noteLibraryDeleteEvent(event);
      publish(event);
    },
    ...(options.storeOptions || {})
  });

  function remember(data) {
    const key = `${data.senderId}:${data.seq}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 500) seen.delete(seen.values().next().value);
    return true;
  }

  async function accept(data) {
    if (!data || typeof data !== "object") return false;
    if (!data.senderId || data.senderId === senderId) return false;
    if (!Number.isFinite(Number(data.seq)) || !remember(data)) return false;
    if (data.collection === "notes") {
      const hash = String(data.docHash || "");
      if (hash && typeof notes.refreshDoc === "function") {
        await notes.refreshDoc(hash).catch(() => {});
      }
      return true;
    }
    if (!data.collection) return false;
    const event = {
      collection: data.collection,
      docHash: data.docHash,
      page: data.page,
      ...(data.deleted === true ? { deleted: true } : {})
    };
    noteLibraryDeleteEvent(event);
    library.notify(event, "remote");
    return true;
  }

  if (typeof options.receive === "function") options.receive(accept);
  else if (typeof BroadcastChannel === "function" && options.channel !== false) {
    try {
      live = new BroadcastChannel(options.channelName || "oi-library");
      live.onmessage = (message) => {
        void accept(message?.data);
      };
    } catch {
      live = null;
    }
  }

  return {
    store: library,
    notes,
    senderId,
    accept,
    publish,
    close() {
      try {
        live?.close();
      } catch {
        /* already closed */
      }
      live = null;
    }
  };
}

function libraryChannel() {
  if (channel) return channel;
  if (typeof BroadcastChannel !== "function") return null;
  try {
    channel = new BroadcastChannel("oi-library");
  } catch {
    channel = null;
  }
  return channel;
}

export function sharedLibraryStore() {
  if (!store) {
    session = createLibrarySession({
      channel: false,
      notes: sharedNotesStore(),
      post(message) {
        const port = libraryChannel();
        if (!port || !message) return;
        try {
          port.postMessage(message);
        } catch {
          /* the writing tab already notified its own listeners */
        }
      },
      receive(accept) {
        const port = libraryChannel();
        if (!port) return;
        port.onmessage = (message) => {
          void accept(message?.data);
        };
      }
    });
    store = session.store;
  }
  return store;
}

export function resetSharedLibraryStore() {
  try {
    session?.close();
    channel?.close();
  } catch {
    /* already closed */
  }
  channel = null;
  session = null;
  store = null;
}
