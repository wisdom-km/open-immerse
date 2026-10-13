/**
 * A new oiAuto / oiScene / oiBidMode / oiLang starts from an empty library.
 * The same scene keeps IndexedDB, so a reopen sees what the reader stored.
 * chrome.runtime.id makes the reader use IndexedDB; without this reset, one
 * profile would keep the first scene's paper for every later fixture.
 */
export function e2eLibrarySceneResetSource() {
  return `
  const oiSceneKey = ["oiAuto", "oiScene", "oiBidMode", "oiLang"].map((name) => params.get(name) || "").join("|");
  const oiScenePrev = sessionStorage.getItem("oiE2eScene");
  if (oiScenePrev !== oiSceneKey && indexedDB && typeof indexedDB.deleteDatabase === "function" && typeof indexedDB.open === "function") {
    sessionStorage.setItem("oiE2eScene", oiSceneKey);
    const oiOpen = indexedDB.open.bind(indexedDB);
    const oiReady = new Promise((resolve) => {
      const drop = indexedDB.deleteDatabase("oi-annotations");
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      drop.onsuccess = finish;
      drop.onerror = finish;
      setTimeout(finish, 3000);
    });
    indexedDB.open = function(name, version) {
      const stub = { result: null, error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      oiReady.then(() => {
        const req = version == null ? oiOpen(name) : oiOpen(name, version);
        for (const field of ["onsuccess", "onerror", "onblocked", "onupgradeneeded"]) {
          req[field] = (event) => {
            stub.result = req.result;
            stub.error = req.error;
            if (typeof stub[field] === "function") stub[field](event);
          };
        }
      });
      return stub;
    };
  } else {
    sessionStorage.setItem("oiE2eScene", oiSceneKey);
  }
`;
}

/**
 * Page-side reader for the e2e harness. The expression runs in the viewer
 * and reads IndexedDB through the same LibraryStore the reader writes.
 * It does not imitate the old 8765 POST.
 */
export function storedLibraryPagesSource() {
  return `async function oiStoredLibraryPages() {
  const { sharedLibraryStore } = await import("/lib/library-session.js");
  const store = sharedLibraryStore();
  const papers = await store.listPapers();
  const pages = [];
  for (const paper of papers || []) {
    const hash = paper && paper.docHash;
    if (!hash) continue;
    const rows = await store.getPages(hash);
    const layouts = typeof store.listLayouts === "function" ? await store.listLayouts(hash) : [];
    for (const row of rows || []) {
      const matches = (layouts || []).filter((item) => Number(item.page) === Number(row.page));
      matches.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
      const layout = matches[0] && matches[0].layout || null;
      pages.push({
        page: Number(row.page) || 0,
        pairs: Array.isArray(row.pairs) ? row.pairs : [],
        skipped: row.skipped === true,
        layout,
        layoutVersion: row.layoutVersion || (layout && layout.layoutVersion) || (matches[0] && matches[0].layoutRev) || ""
      });
    }
  }
  pages.sort((a, b) => a.page - b.page);
  return pages;
}`;
}
