/**
 * Plain record keys and index ranges.
 *
 * Both IndexedDB and SQLite can store these values. Callers pass strings,
 * numbers, and arrays. Host range objects stay inside the IndexedDB backend.
 */

export function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function valueAt(record, path) {
  if (Array.isArray(path)) return path.map((part) => valueAt(record, part));
  if (typeof path !== "string" || !path) return undefined;
  let current = record;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

export function keyMissing(key) {
  if (key == null) return true;
  if (Array.isArray(key)) return key.some((part) => part == null);
  return false;
}

/** IndexedDB's type order for the values this library actually stores. */
function keyType(value) {
  if (typeof value === "number" && Number.isFinite(value)) return 1;
  if (typeof value === "string") return 3;
  if (Array.isArray(value)) return 5;
  return 9;
}

export function compareKeys(a, b) {
  if (a === b) return 0;
  const ta = keyType(a);
  const tb = keyType(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (ta === 1 || ta === 3) return a < b ? -1 : a > b ? 1 : 0;
  if (ta !== 5) return String(a) < String(b) ? -1 : 1;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = compareKeys(a[index], b[index]);
    if (diff) return diff;
  }
  return a.length - b.length;
}

export function canonicalKey(key) {
  return JSON.stringify(key);
}

/**
 * Reject host objects. Bounds are plain values or arrays.
 */
export function assertPlainQuery(query) {
  if (query == null) return {};
  if (typeof query !== "object" || Array.isArray(query) || query.constructor !== Object) {
    const error = new TypeError("storage query must be a plain object");
    error.name = "DataError";
    throw error;
  }
  for (const bound of ["equals", "from", "to"]) {
    const value = query[bound];
    if (value == null || Array.isArray(value) || typeof value !== "object") continue;
    if (value.constructor !== Object) {
      const error = new TypeError("storage range bounds must be plain values");
      error.name = "DataError";
      throw error;
    }
  }
  return query;
}

export function inRange(key, query) {
  if (keyMissing(key)) return false;
  if (query.equals !== undefined) return compareKeys(key, query.equals) === 0;
  if (query.from !== undefined) {
    const diff = compareKeys(key, query.from);
    if (query.fromExclusive ? diff <= 0 : diff < 0) return false;
  }
  if (query.to !== undefined) {
    const diff = compareKeys(key, query.to);
    if (query.toExclusive ? diff >= 0 : diff > 0) return false;
  }
  return true;
}
