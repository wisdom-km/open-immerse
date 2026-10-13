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
 * immediately and do not call indexedDB.open.
 *
 * If the holder closes after the timeout, this request can still commit the
 * upgrade. That is idempotent. Closing that connection inside the success
 * callback, while other opens are queued, is the sequence that crashed the
 * renderer: each queued open then ran, and each late connection was closed
 * from the callback. A single timed-out open does not. Listeners are removed
 * and the one late connection is closed on a later turn.
 */

export const DEFAULT_BLOCKED_TIMEOUT_MS = 5000;

// name -> token of the open request that is blocked and still unfinished.
const blockedPending = new Map();

function blockedError() {
  const error = new Error("数据库正被其他页面占用，这次没有打开。");
  error.name = "BlockedError";
  return error;
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
  if (name && blockedPending.has(name)) return Promise.reject(blockedError());
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
    let settled = false;
    const hold = () => {
      if (name) blockedPending.set(name, token);
    };
    const release = () => {
      if (name && blockedPending.get(name) === token) blockedPending.delete(name);
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
      hold();
      settle(false, blockedError());
    }, deadlineMs(blockedTimeoutMs));
    const settle = (ok, value) => {
      if (settled) {
        detach();
        release();
        if (ok) closeLater(value);
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (ok) {
        release();
        detach();
        resolve(value);
        return;
      }
      if (value?.name === "BlockedError") hold();
      else release();
      reject(value);
    };
    request.onupgradeneeded = (event) => {
      if (typeof onUpgrade === "function") onUpgrade(request.result, event.oldVersion);
    };
    request.onblocked = () => {
      hold();
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
  if (name && blockedPending.has(name)) return Promise.reject(blockedError());
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
