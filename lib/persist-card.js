/**
 * One persist refusal card for the library and for notes.
 * The stored flag is the library key already used by the store. T2b's
 * per-document map stays as it is; this card is the shared prompt.
 */

import { LIBRARY_PERSIST_HINT_KEY } from "./library-store.js";
import { PERSIST_CARD_BODY, PERSIST_CARD_TITLE } from "./storage-copy.js";

export const PERSIST_CARD_SESSION_KEY = "oiPersistCardHidden";

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
