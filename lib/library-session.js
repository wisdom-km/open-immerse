/**
 * The one library store the reader uses.
 * Notes go through the panel's store. Other notes stores created inside
 * LibraryStore pass capture:false and are not registered here.
 */

import { createLibraryStore } from "./library-store.js";
import { sharedNotesStore } from "./notes-anchor.js";
import { mergeStoredPagePairs } from "./pdf-library.js";

let store = null;
let channel = null;
let channelToken = 0;

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

function publish(event) {
  const live = libraryChannel();
  if (!live || !event) return;
  try {
    live.postMessage({ ...event, channelToken });
  } catch {
    /* the writing tab already notified its own listeners */
  }
}

export function sharedLibraryStore() {
  if (!store) {
    channelToken += 1;
    const token = channelToken;
    store = createLibraryStore({
      notes: sharedNotesStore(),
      mergePairs: (existing, incoming, blocks, lang) => mergeStoredPagePairs(existing, incoming, blocks, lang),
      onNotify(event) {
        publish({ ...event, channelToken: token });
      }
    });
    const live = libraryChannel();
    if (live) {
      live.onmessage = (message) => {
        const data = message?.data;
        if (!data || data.channelToken === token) return;
        if (!data.collection) return;
        store.notify({
          collection: data.collection,
          docHash: data.docHash,
          page: data.page
        }, "remote");
      };
    }
  }
  return store;
}

export function resetSharedLibraryStore() {
  try {
    channel?.close();
  } catch {
    /* already closed */
  }
  channel = null;
  store = null;
}
