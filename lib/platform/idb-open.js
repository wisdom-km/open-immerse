/**
 * The only place that calls indexedDB.open for oi-annotations.
 *
 * notes-store.js and library-store.js both come through here. A requested
 * version that is older than the database on disk is a VersionError: reopen
 * with no version argument so the existing stores can still be read. Passing
 * null is not the same call — the factory treats any extra argument as a
 * requested version.
 *
 * onblocked means another connection is holding the old version and did not
 * close. The deadline starts when the request is made, not when onblocked
 * fires: a request queued behind an earlier open never receives onblocked.
 * Rejecting our promise does not cancel the browser request. IndexedDB runs
 * one open at a time for a database, so a second open waits behind that
 * pending upgrade and would hang. While one open is still unfinished, a later
 * open fails immediately and does not call indexedDB.open. A real onblocked,
 * or the deadline, is a BlockedError and stays pending until that open
 * releases it. A slow open that has not been blocked is only busy: that
 * error must not stick, or the page treats a healthy database as occupied
 * for the rest of the session.
 *
 * If the holder closes after the timeout, this request can still commit the
 * upgrade. That is idempotent. Closing that connection inside the success
 * callback, while other opens are queued, is the sequence that crashed the
 * renderer: each queued open then ran, and each late connection was closed
 * from the callback. A single timed-out open does not. Listeners are removed
 * and the one late connection is closed on a later turn. Clearing the pending
 * mark then tells this page, and other pages, that storage can be tried again.
 */

export const DEFAULT_BLOCKED_TIMEOUT_MS = 10000;

/**
 * An open that is still unfinished after this long is not joined by another
 * indexedDB.open. A later open fails immediately. Queueing behind that
 * request is what made translation sit out the 10s deadline, and it is the
 * queue that hung the #133 crash sequence: when the holder finally released,
 * every queued success ran and each late connection was closed from inside
 * the callback. Chrome did not return for minutes. The fast failure is a
 * BlockedError only after onblocked. Before that it is a BusyError, so a
 * slow success is not reported as storage occupied.
 */
export const OPEN_INHERIT_AFTER_MS = 300;

export const STORAGE_AVAILABLE_EVENT = "oi-storage-available";

// name -> { token, cause, since } of the open that is still unfinished.
const blockedPending = new Map();

// name -> { token, since, sawBlocked, inheritAfterMs } of the open that has
// called indexedDB.open and has not settled yet.
const inflightOpens = new Map();

const pageTarget = new EventTarget();

export function storagePageTarget() {
  return pageTarget;
}

export function onStorageAvailable(listener) {
  if (typeof listener !== "function") return () => {};
  const handler = (event) => listener(event?.detail || { type: STORAGE_AVAILABLE_EVENT });
  pageTarget.addEventListener(STORAGE_AVAILABLE_EVENT, handler);
  return () => pageTarget.removeEventListener(STORAGE_AVAILABLE_EVENT, handler);
}

function storageCause(value) {
  return value === "blocked" ? "blocked" : "timeout";
}

function blockedError(cause, since) {
  const error = new Error("这次没能打开本机存储。");
  error.name = "BlockedError";
  error.cause = storageCause(cause);
  if (Number.isFinite(since)) error.since = since;
  return error;
}

function busyError(since) {
  const error = new Error("本机存储还在打开，这次没有另开。");
  error.name = "BusyError";
  error.cause = { type: "busy" };
  if (Number.isFinite(since)) error.since = since;
  return error;
}

function inflightRefusal(running) {
  if (running?.sawBlocked) return blockedError("blocked", running.since);
  return busyError(running?.since);
}

function pendingOf(name) {
  return name ? blockedPending.get(name) || null : null;
}

function inheritedError(name) {
  const pending = pendingOf(name);
  return blockedError(pending?.cause, pending?.since);
}

function postStorageAvailable(detail) {
  if (typeof BroadcastChannel !== "function") return;
  let channel = null;
  try {
    channel = new BroadcastChannel("oi-library");
    channel.postMessage(detail);
  } catch {
    /* this page still hears the EventTarget */
  }
  setTimeout(() => {
    try {
      channel?.close();
    } catch {
      /* already closed */
    }
  }, 0);
}

function emitStorageAvailable(name) {
  const detail = { type: STORAGE_AVAILABLE_EVENT, name: name || "" };
  try {
    pageTarget.dispatchEvent(new CustomEvent(STORAGE_AVAILABLE_EVENT, { detail }));
  } catch {
    /* a listener must not keep the connection pending */
  }
  postStorageAvailable(detail);
}

function releasePending(name, token) {
  if (!name) return false;
  const pending = blockedPending.get(name);
  if (!pending || pending.token !== token) return false;
  blockedPending.delete(name);
  emitStorageAvailable(name);
  return true;
}

function factoryFrom(indexedDB) {
  const candidate = indexedDB || globalThis.indexedDB;
  if (!candidate || typeof candidate.open !== "function") return null;
  return candidate;
}

function deadlineMs(blockedTimeoutMs) {
  return Number.isFinite(blockedTimeoutMs) ? blockedTimeoutMs : DEFAULT_BLOCKED_TIMEOUT_MS;
}

function openRequest(indexedDB, name, version, onUpgrade, blockedTimeoutMs, inheritAfterMs) {
  if (name && blockedPending.has(name)) return Promise.reject(inheritedError(name));
  const running = name ? inflightOpens.get(name) : null;
  if (running && Date.now() - running.since >= running.inheritAfterMs) {
    return Promise.reject(inflightRefusal(running));
  }
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      const error = new Error("indexedDB missing");
      error.name = "InvalidStateError";
      reject(error);
      return;
    }
    const request = version == null
      ? indexedDB.open(name)
      : indexedDB.open(name, version);
    const token = {};
    const since = Date.now();
    let sawBlocked = false;
    let settled = false;
    const limit = Number.isFinite(inheritAfterMs) ? inheritAfterMs : OPEN_INHERIT_AFTER_MS;
    if (name && !inflightOpens.has(name)) {
      inflightOpens.set(name, { token, since, sawBlocked: false, inheritAfterMs: limit });
    }
    const ownsInflight = Boolean(name && inflightOpens.get(name)?.token === token);
    const clearInflight = () => {
      if (ownsInflight && inflightOpens.get(name)?.token === token) inflightOpens.delete(name);
    };
    const remember = () => {
      if (!name) return;
      const current = blockedPending.get(name);
      if (current && current.token !== token) return;
      blockedPending.set(name, {
        token,
        cause: sawBlocked ? "blocked" : "timeout",
        since: current?.since || since
      });
    };
    const detach = () => {
      request.onupgradeneeded = null;
      request.onsuccess = null;
      request.onerror = null;
      request.onblocked = null;
    };
    const timer = setTimeout(() => {
      remember();
      const pending = pendingOf(name);
      settle(false, blockedError(pending?.cause || (sawBlocked ? "blocked" : "timeout"), pending?.since || since));
    }, deadlineMs(blockedTimeoutMs));
    const settle = (ok, value) => {
      if (settled) {
        detach();
        clearInflight();
        const db = ok ? value : null;
        // The timeout already rejected this request. Close the late connection
        // and only then tell the page storage is free, on a later turn.
        setTimeout(() => {
          if (db && typeof db.close === "function") {
            try {
              db.close();
            } catch {
              /* already closed */
            }
          }
          setTimeout(() => releasePending(name, token), 0);
        }, 0);
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInflight();
      if (ok) {
        releasePending(name, token);
        detach();
        resolve(value);
        return;
      }
      if (value?.name === "BlockedError") remember();
      else releasePending(name, token);
      reject(value);
    };
    request.onupgradeneeded = (event) => {
      if (typeof onUpgrade === "function") onUpgrade(request.result, event.oldVersion);
    };
    request.onblocked = () => {
      sawBlocked = true;
      const flight = name ? inflightOpens.get(name) : null;
      if (flight && flight.token === token) flight.sawBlocked = true;
      const current = name ? blockedPending.get(name) : null;
      // A holder that shows up after the deadline still changes the cause.
      // The next open then uses the blocked wording. A finished success
      // already cleared this token, and must not become pending again.
      if (settled && (!current || current.token !== token)) return;
      remember();
    };
    request.onsuccess = () => settle(true, request.result);
    request.onerror = (event) => {
      const error = request.error || new Error("indexedDB open failed");
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      settle(false, error);
    };
  });
}

/** True after a blocked or timed-out open, until that open releases it. */
export function storageOpenIsBlocked(name) {
  return Boolean(name && blockedPending.has(name));
}

/** True while an open has called indexedDB.open and has not settled. */
export function storageOpenInflight(name) {
  return Boolean(name && inflightOpens.has(name));
}

export function openIndexedDatabase({ name, version, onUpgrade, indexedDB, blockedTimeoutMs, inheritAfterMs } = {}) {
  const factory = factoryFrom(indexedDB);
  if (name && blockedPending.has(name)) return Promise.reject(inheritedError(name));
  const running = name ? inflightOpens.get(name) : null;
  if (running && Date.now() - running.since >= running.inheritAfterMs) {
    return Promise.reject(inflightRefusal(running));
  }
  return openRequest(factory, name, version, onUpgrade, blockedTimeoutMs, inheritAfterMs).catch((error) => {
    if (version == null || error?.name !== "VersionError") throw error;
    return openRequest(factory, name, null, onUpgrade, blockedTimeoutMs, inheritAfterMs);
  });
}

/**
 * True when this name is already on disk. databases() does not create one.
 * A missing databases() is reported as false so a read does not fall through
 * to open(), which would create the database.
 */
export async function indexedDatabaseExists(name, indexedDB) {
  const factory = factoryFrom(indexedDB);
  if (!factory || typeof factory.databases !== "function") return false;
  try {
    const rows = await factory.databases();
    return (rows || []).some((row) => row?.name === name);
  } catch {
    return false;
  }
}
