/**
 * Session-only resume mark for a translation interrupted by opening another paper.
 * chrome.storage.session only. Not sync, not the library export.
 *
 * mode "document" is the whole paper. mode "from-page" continues from anchorPage.
 * resumePage is the first unfinished page inside that range.
 */

import { LIBRARY_SWITCH_FALLBACK_MS, waitAtMost } from "./library-layout.js";

export const LIBRARY_AUTO_PAUSED_KEY = "library.autoPaused";

export function libraryTranslateMode(mode) {
  return mode === "from-page" ? "from-page" : "document";
}

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

function normalizeAutoPause(hash, record = {}) {
  const mode = libraryTranslateMode(record.mode);
  const resumePage = Math.max(1, Math.floor(Number(record.resumePage) || 1));
  const anchorPage = mode === "from-page"
    ? Math.max(1, Math.floor(Number(record.anchorPage) || resumePage))
    : 1;
  return {
    docHash: hash,
    resumePage,
    mode,
    anchorPage,
    phase: "auto-paused",
    at: Number(record.at) || Date.now()
  };
}

/**
 * Where a return to an auto-paused paper starts.
 * Already-translated pages are left out of sendPages. The mode is not rewritten.
 */
export function libraryResumePlan(record = {}, options = {}) {
  const saved = normalizeAutoPause(String(record.docHash || ""), record);
  const total = Math.max(0, Math.floor(Number(options.pageCount) || 0));
  const translated = new Set(
    (options.translatedPages || [])
      .map((page) => Math.floor(Number(page) || 0))
      .filter((page) => page > 0)
  );
  let startPage = saved.mode === "from-page"
    ? Math.max(saved.anchorPage, saved.resumePage)
    : saved.resumePage;
  if (total > 0) startPage = Math.min(startPage, total);
  const last = total > 0 ? total : startPage;
  const sendPages = [];
  for (let page = startPage; page <= last; page += 1) {
    if (!translated.has(page)) sendPages.push(page);
  }
  return {
    mode: saved.mode,
    startPage,
    anchorPage: saved.anchorPage,
    sendPages
  };
}

export async function writeLibraryAutoPaused(storage, docHash, record = {}) {
  const area = areaOf(storage);
  const hash = String(docHash || "");
  if (!area || !hash) throw new Error("session storage unavailable");
  const map = await readLibraryAutoPaused(area);
  const next = normalizeAutoPause(hash, record);
  map[hash] = next;
  await area.set({ [LIBRARY_AUTO_PAUSED_KEY]: map });
  return next;
}

/** The session write shares the switch fallback. A timeout still lets the open continue. */
export async function settleLibraryAutoPause(storage, docHash, record = {}, ms = LIBRARY_SWITCH_FALLBACK_MS, timers) {
  const writing = writeLibraryAutoPaused(storage, docHash, record).then(
    (saved) => ({ status: "done", record: saved }),
    () => ({ status: "failed", record: null })
  );
  const gate = await waitAtMost(writing, ms, timers);
  if (gate === "timeout") return { status: "timeout", record: null };
  return writing;
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
