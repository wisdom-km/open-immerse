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
 * close. Wait, then fail with BlockedError so the caller can retry. A missing
 * timer would leave the open — and the caller's queue — pending forever.
 *
 * Timing out does not cancel the request. If the blocking connection closes
 * later, this open can still run the upgrade and commit it. A v2 upgrade
 * after BlockedError is idempotent: the next open sees the new version and
 * does not apply it again. The connection from that late success is closed
 * here, because the caller was already told this attempt failed.
 */

export const DEFAULT_BLOCKED_TIMEOUT_MS = 5000;

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

function openRequest(indexedDB, name, version, onUpgrade, blockedTimeoutMs) {
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
    let settled = false;
    let timer = null;
    const finish = (ok, value) => {
      if (settled) {
        // BlockedError already rejected this attempt. The upgrade can still
        // commit after the holder closes; that is harmless and idempotent.
        // Drop the connection, since the caller is not waiting on it.
        if (ok && value && typeof value.close === "function") {
          try {
            value.close();
          } catch {
            /* already closed */
          }
        }
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      if (ok) resolve(value);
      else reject(value);
    };
    request.onupgradeneeded = (event) => {
      if (typeof onUpgrade === "function") onUpgrade(request.result, event.oldVersion);
    };
    request.onblocked = () => {
      if (settled || timer) return;
      const limit = Number.isFinite(blockedTimeoutMs) ? blockedTimeoutMs : DEFAULT_BLOCKED_TIMEOUT_MS;
      timer = setTimeout(() => finish(false, blockedError()), limit);
    };
    request.onsuccess = () => finish(true, request.result);
    request.onerror = (event) => {
      const error = request.error || new Error("indexedDB open failed");
      if (error.name === "VersionError" && event && typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      finish(false, error);
    };
  });
}

export function openIndexedDatabase({ name, version, onUpgrade, indexedDB, blockedTimeoutMs } = {}) {
  const factory = factoryFrom(indexedDB);
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
