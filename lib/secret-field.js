/**
 * Password key field. The value is the real key. The browser draws the dots.
 * Focus does not clear or rewrite it. A trailing × clears the field immediately.
 * Deleting a saved key down to empty and blurring clears it the same way.
 * Whitespace that never removes the saved key is ignored.
 * Auto-save cards write that empty value in the same turn. Button cards wait
 * for their existing save button.
 */

const MASK_CHARS = /[•*]/;

export function secretDraftError(value) {
  const raw = String(value ?? "");
  if (MASK_CHARS.test(raw)) return "密钥不能包含掩码符号";
  const trimmed = raw.trim();
  if (trimmed && /\s/.test(trimmed)) return "密钥不能包含空格";
  return "";
}

export function bindSecretInput(input, { getValue, schedule, clear, onClear } = {}) {
  const later = schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel = clear || ((id) => clearTimeout(id));
  let savedTimer = 0;
  let pendingClear = false;
  let errorNode = null;
  let clearBtn = null;
  const root = hostField(input);

  function stored() {
    return String(getValue?.() || "");
  }

  function syncClear() {
    if (!input || !root) return;
    const filled = String(input.value || "") !== "";
    const control = controlOf(input);
    if (!filled) {
      clearBtn?.remove();
      clearBtn = null;
      return;
    }
    const existing = control?.querySelector?.("[aria-label='清空密钥']") || null;
    if (existing) {
      clearBtn = existing;
      return;
    }
    if (clearBtn && (clearBtn.isConnected || clearBtn.parentNode || clearBtn.parentElement)) return;
    const doc = ownerDoc(input);
    if (!doc?.createElement) return;
    clearBtn = doc.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "oi-key-clear";
    clearBtn.setAttribute("aria-label", "清空密钥");
    clearBtn.textContent = "×";
    clearBtn.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
    });
    clearBtn.addEventListener("click", () => {
      clearField();
    });
    control?.append(clearBtn);
  }

  function showError(message) {
    if (!root) return;
    if (!errorNode) {
      const doc = ownerDoc(input);
      if (!doc?.createElement) return;
      errorNode = doc.createElement("p");
      errorNode.className = "oi-key-error";
      errorNode.setAttribute("role", "alert");
      root.append(errorNode);
    }
    errorNode.textContent = message;
    errorNode.hidden = false;
    input.setAttribute("aria-invalid", "true");
  }

  function hideError() {
    if (errorNode) errorNode.textContent = "";
    if (errorNode) errorNode.hidden = true;
    input?.removeAttribute?.("aria-invalid");
  }

  function paint() {
    if (!input) return;
    const value = stored();
    if (pendingClear && value) return;
    if (pendingClear && !value) pendingClear = false;
    const active = input.ownerDocument?.activeElement === input;
    if (active && input.value !== value && !pendingClear) return;
    input.value = value;
    syncClear();
  }

  function clearField() {
    if (!input) return;
    input.value = "";
    pendingClear = true;
    hideError();
    syncClear();
    input.focus?.();
    onClear?.();
  }

  function commit() {
    if (!input) return { ignored: true, empty: true, value: stored() };
    const raw = String(input.value ?? "");
    const error = secretDraftError(raw);
    if (error) {
      showError(error);
      return { ignored: true, invalid: true, empty: false, error, value: raw };
    }
    hideError();
    const trimmed = raw.trim();
    if (!trimmed) {
      if (pendingClear) {
        input.value = "";
        syncClear();
        return { ignored: true, empty: true, pendingClear: true, value: "" };
      }
      // Deleting a saved key all the way to empty is a clear. Whitespace that
      // never removes that key is not.
      if (raw === "" && stored()) {
        pendingClear = true;
        input.value = "";
        hideSaved();
        syncClear();
        const writesNow = typeof onClear === "function";
        onClear?.();
        return {
          ignored: writesNow,
          empty: true,
          pendingClear: true,
          value: "",
          changed: true
        };
      }
      pendingClear = false;
      hideSaved();
      input.value = stored();
      syncClear();
      return { ignored: true, empty: true, value: stored() };
    }
    pendingClear = false;
    const prev = stored();
    input.value = trimmed;
    syncClear();
    return { ignored: false, empty: false, value: trimmed, changed: trimmed !== prev, showSaved };
  }

  function hideSaved() {
    const note = root?.parentElement?.querySelector?.("[data-secret-saved]") || input?.parentElement?.querySelector?.("[data-secret-saved]");
    if (note) note.textContent = "";
  }

  function showSaved() {
    const note = root?.parentElement?.querySelector?.("[data-secret-saved]") || input?.parentElement?.querySelector?.("[data-secret-saved]");
    if (!note) return;
    note.textContent = "已保存";
    cancel(savedTimer);
    savedTimer = later(() => {
      note.textContent = "";
    }, 1200);
  }

  function placeCaretAtEnd(ev) {
    const end = String(input.value || "").length;
    try {
      const start = input.selectionStart;
      const finish = input.selectionEnd;
      const selecting = ev && start != null && finish != null && start !== finish;
      if (selecting) return;
      input.setSelectionRange?.(end, end);
    } catch {
      /* a password field may refuse a selection range */
    }
  }
  input?.addEventListener?.("focus", () => placeCaretAtEnd());
  input?.addEventListener?.("mouseup", placeCaretAtEnd);
  input?.addEventListener?.("click", placeCaretAtEnd);
  input?.addEventListener?.("input", () => {
    if (String(input.value || "").trim() !== "") pendingClear = false;
    hideError();
    syncClear();
  });
  input?.addEventListener?.("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault?.();
    input.blur?.();
  });

  const page = input?.ownerDocument?.defaultView || globalThis;
  let teardown = null;
  function stop() {
    cancel(savedTimer);
    page.removeEventListener?.("pagehide", stop);
    teardown?.disconnect?.();
    teardown = null;
  }

  page.addEventListener?.("pagehide", stop);
  const Observer = page.MutationObserver;
  if (Observer && root) {
    let seen = Boolean(root.isConnected);
    teardown = new Observer(() => {
      if (root.isConnected) {
        seen = true;
        return;
      }
      if (seen) stop();
    });
    input.ownerDocument && teardown.observe(input.ownerDocument, { childList: true, subtree: true });
  }

  if (input) {
    input.type = "password";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    if (input.dataset) delete input.dataset.masked;
  }
  paint();

  return { paint, commit, clearField, stop, showSaved, hideSaved, root };
}

function controlOf(input) {
  return input?.parentElement?.classList?.contains("oi-key-control")
    ? input.parentElement
    : input?.parentElement;
}

function ownerDoc(node) {
  const owned = node?.ownerDocument;
  if (owned?.createElement) return owned;
  if (typeof document !== "undefined" && document?.createElement) return document;
  return null;
}

function hostField(input) {
  if (!input) return null;
  const doc = ownerDoc(input);
  if (!doc) return input.parentElement || null;
  const existing = input.parentElement?.classList?.contains("oi-key-control")
    ? input.parentElement.parentElement
    : (input.parentElement?.classList?.contains("oi-key-field") ? input.parentElement : null);
  if (existing?.classList?.contains("oi-key-field")) return existing;
  const wrap = doc.createElement("div");
  wrap.className = "oi-key-field";
  const control = doc.createElement("div");
  control.className = "oi-key-control";
  const slot = input.getAttribute?.("data-key-slot");
  if (slot && !wrap.getAttribute("data-key-slot")) wrap.setAttribute("data-key-slot", slot);
  const parent = input.parentNode;
  if (parent) parent.insertBefore(wrap, input);
  control.append(input);
  wrap.append(control);
  return wrap;
}
