/**
 * A delete in another tab must not be undone by this tab's later page write.
 * The stop is per hash. A fresh open clears it and may create a new record.
 */

const stopped = new Set();
const openedAt = new Map();
let marks = null;

export function bindLibraryWriteMarks(next) {
  marks = next || null;
}

export function libraryWriteMarks() {
  return marks;
}

export function stopLibraryWrites(hash) {
  const id = String(hash || "");
  if (!id) return false;
  stopped.add(id);
  return true;
}

export function libraryWritesStopped(hash) {
  return stopped.has(String(hash || ""));
}

export function resetLibraryWriteStops() {
  stopped.clear();
}

/** This tab's open time for a hash. 0 means unknown, so the timestamp rule stays off. */
export function noteLibraryLoaded(hash, at) {
  const id = String(hash || "");
  const when = Number(at);
  if (!id || !Number.isFinite(when) || when <= 0) return false;
  openedAt.set(id, when);
  return true;
}

export function libraryLoadedAt(hash) {
  const when = openedAt.get(String(hash || ""));
  return Number.isFinite(when) && when > 0 ? when : 0;
}

/**
 * A stopped tab never writes. A tombstone is revived only when this write
 * is allowed to revive and the delete is not newer than this tab's open.
 */
export function libraryReviveAllowed({ existing = null, stopped = false, openedAt: opened = 0, revive = false } = {}) {
  if (revive !== true && (stopped || existing?.deletedAt)) return false;
  const deletedAt = Number(existing?.deletedAt) || 0;
  const loaded = Number(opened) || 0;
  if (revive === true && deletedAt && loaded && deletedAt > loaded) return false;
  return true;
}

export function applyLibraryDeleteNotice(hash) {
  const id = String(hash || "");
  if (!id) return false;
  stopLibraryWrites(id);
  const bound = marks;
  try {
    bound?.sourceSent?.delete?.(id);
  } catch {
    /* the set is best-effort */
  }
  try {
    bound?.originalStored?.delete?.(id);
  } catch {
    /* the set is best-effort */
  }
  try {
    bound?.dropDoc?.(id);
  } catch {
    /* dropping the in-memory doc must not break the delete */
  }
  return true;
}

export function noteLibraryDeleteEvent(event) {
  if (!event || event.collection !== "papers" || event.deleted !== true) return false;
  return applyLibraryDeleteNotice(event.docHash);
}
