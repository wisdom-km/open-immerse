/**
 * Session-only resume mark for a translation interrupted by opening another paper.
 * chrome.storage.session only. Not sync, not the library export.
 */

export const LIBRARY_AUTO_PAUSED_KEY = "library.autoPaused";

function areaOf(storage) {
  if (!storage) return null;
  if (typeof storage.get === "function" && typeof storage.set === "function") return storage;
  const session = storage.session;
  if (session && typeof session.get === "function" && typeof session.set === "function") return session;
  return null;
}

export async function readLibraryAutoPaused(storage) {
  const area = areaOf(storage);
  if (!area) return {};
  const bag = await area.get(LIBRARY_AUTO_PAUSED_KEY);
  const value = bag?.[LIBRARY_AUTO_PAUSED_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

export async function writeLibraryAutoPaused(storage, docHash, record = {}) {
  const area = areaOf(storage);
  const hash = String(docHash || "");
  if (!area || !hash) throw new Error("session storage unavailable");
  const map = await readLibraryAutoPaused(area);
  const next = {
    docHash: hash,
    resumePage: Math.max(1, Math.floor(Number(record.resumePage) || 1)),
    phase: "auto-paused",
    at: Number(record.at) || Date.now()
  };
  map[hash] = next;
  await area.set({ [LIBRARY_AUTO_PAUSED_KEY]: map });
  return next;
}

export async function clearLibraryAutoPaused(storage, docHash) {
  const area = areaOf(storage);
  const hash = String(docHash || "");
  if (!area || !hash) return false;
  const map = await readLibraryAutoPaused(area);
  if (!Object.prototype.hasOwnProperty.call(map, hash)) return false;
  delete map[hash];
  await area.set({ [LIBRARY_AUTO_PAUSED_KEY]: map });
  return true;
}
