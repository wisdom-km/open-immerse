/**
 * A delete in another tab must not be undone by this tab's later page write.
 * The stop is per hash. A fresh open clears it and may create a new record.
 */

const stopped = new Set();
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
