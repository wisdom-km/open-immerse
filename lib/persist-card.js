/**
 * One persist refusal card for the library and for notes.
 * The stored flag is the library key already used by the store. T2b's
 * per-document map stays as it is; this card is the shared prompt.
 */

import { LIBRARY_PERSIST_HINT_KEY } from "./library-store.js";
import { NOTES_HINT_DOC_PREFIX } from "./reader-notes-local.js";
import { NOTES_PERSIST_HINT_KEY } from "./notes-prefs.js";
import { recordedPersistDenied } from "./notes-store.js";
import { PERSIST_CARD_BODY, PERSIST_CARD_TITLE } from "./storage-copy.js";

export const PERSIST_CARD_SESSION_KEY = "oiPersistCardHidden";

function hintFlags(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value || "{}");
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const clean = {};
  for (const [key, flag] of Object.entries(parsed)) {
    if (flag) clean[String(key)] = true;
  }
  return clean;
}

/**
 * Whether the shared persist card should open.
 * The T2b key wins when it exists: reader.notesPersistHintDismissed.<hash>,
 * or the legacy map under reader.notesPersistHintDismissed. The library key
 * is used only when neither T2b key is stored. Closing one does not write
 * the other.
 * local.get is called on the area object. A detached get throws in Chrome.
 */
export async function readPersistCardState(local, docHash) {
  if (!local || typeof local.get !== "function") return { show: false, dismissed: false };
  const hash = String(docHash || "");
  const docKey = `${NOTES_HINT_DOC_PREFIX}${hash}`;
  const keys = [LIBRARY_PERSIST_HINT_KEY, NOTES_PERSIST_HINT_KEY, "libraryPersistGranted", "notesPersistGranted"];
  if (hash) keys.push(docKey);
  const bag = await local.get(keys);
  const source = bag && typeof bag === "object" ? bag : {};
  const docExists = Boolean(hash) && Object.prototype.hasOwnProperty.call(source, docKey);
  const blobExists = Object.prototype.hasOwnProperty.call(source, NOTES_PERSIST_HINT_KEY);
  let dismissed = false;
  if (docExists) dismissed = source[docKey] === true;
  else if (blobExists) dismissed = hintFlags(source[NOTES_PERSIST_HINT_KEY])[hash] === true;
  else dismissed = source[LIBRARY_PERSIST_HINT_KEY] === true;
  const libraryDenied = source.libraryPersistGranted === false;
  const notesDenied = recordedPersistDenied(null, source.notesPersistGranted);
  return {
    show: !dismissed && (libraryDenied || notesDenied),
    dismissed
  };
}

export function createPersistCard(options = {}) {
  const host = options.host;
  let open = false;
  let node = null;

  function render() {
    if (!host) return;
    host.replaceChildren();
    node = null;
    if (!open) return;
    node = document.createElement("aside");
    node.className = "oi-persist-card";
    node.setAttribute("role", "status");
    const title = document.createElement("h2");
    title.textContent = PERSIST_CARD_TITLE;
    const body = document.createElement("p");
    body.textContent = PERSIST_CARD_BODY;
    const row = document.createElement("div");
    row.className = "oi-persist-actions";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "oi-persist-link";
    dismiss.textContent = "不再提示";
    dismiss.addEventListener("click", () => {
      open = false;
      render();
      options.onDismiss?.();
    });
    const backup = document.createElement("button");
    backup.type = "button";
    backup.className = "oi-persist-primary";
    backup.textContent = "导出备份";
    backup.addEventListener("click", () => options.onExport?.());
    const close = document.createElement("button");
    close.type = "button";
    close.className = "oi-persist-close";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    close.addEventListener("click", () => {
      open = false;
      render();
      options.onHideSession?.();
    });
    row.append(dismiss, backup);
    node.append(title, body, row, close);
    host.append(node);
  }

  return {
    key: LIBRARY_PERSIST_HINT_KEY,
    show() {
      if (open) return;
      open = true;
      render();
    },
    hide() {
      open = false;
      render();
    },
    isOpen: () => open,
    title: PERSIST_CARD_TITLE,
    body: PERSIST_CARD_BODY
  };
}
