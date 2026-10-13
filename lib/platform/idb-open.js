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
 * pending upgrade and would hang. While it is still blocked, later opens fail
 * immediately and do not call indexedDB.open. Those later errors inherit the
 * pending request's cause.
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

export const STORAGE_AVAILABLE_EVENT = "oi-storage-available";

// name -> { token, cause, since } of the open that is still unfinished.
const blockedPending = new Map();

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

function openRequest(indexedDB, name, version, onUpgrade, blockedTimeoutMs) {
  if (name && blockedPending.has(name)) return Promise.reject(inheritedError(name));
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
    const closeLater = (db) => {
      if (!db || typeof db.close !== "function") return;
      // Leave the success turn before close. Chrome has crashed when a
      // blocked open's connection is closed inside onsuccess while another
      // open is still queued behind it.
      try {
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            /* already closed */
          }
        };
      } catch {
        /* the connection may already be closing */
      }
      setTimeout(() => {
        try {
          db.close();
        } catch {
          /* already closed */
        }
      }, 0);
    };
    const timer = setTimeout(() => {
      remember();
      const pending = pendingOf(name);
      settle(false, blockedError(pending?.cause || (sawBlocked ? "blocked" : "timeout"), pending?.since || since));
    }, deadlineMs(blockedTimeoutMs));
    const settle = (ok, value) => {
      if (settled) {
        detach();
        releasePending(name, token);
        if (ok) closeLater(value);
        return;
      }
      settled = true;
      clearTimeout(timer);
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

export function openIndexedDatabase({ name, version, onUpgrade, indexedDB, blockedTimeoutMs } = {}) {
  const factory = factoryFrom(indexedDB);
  if (name && blockedPending.has(name)) return Promise.reject(inheritedError(name));
  return openRequest(factory, name, version, onUpgrade, blockedTimeoutMs).catch((error) => {
    if (version == null || error?.name !== "VersionError") throw error;
    return openRequest(factory, name, null, onUpgrade, blockedTimeoutMs);
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
