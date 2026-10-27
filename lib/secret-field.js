/**
 * Password key field. The value is the real key. The browser draws the dots.
 * Focus does not clear or rewrite it. A trailing × clears the field immediately.
 * Auto-save cards write that empty value in the same turn. Button cards wait
 * for their existing save button. A blank blur still keeps the stored key,
 * which is the save rule these cards already had.
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
    if (!filled) {
      clearBtn?.remove();
      clearBtn = null;
      return;
    }
    if (clearBtn?.isConnected) return;
    clearBtn = input.ownerDocument.createElement("button");
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
    controlOf(input)?.append(clearBtn);
  }

  function showError(message) {
    if (!root) return;
    if (!errorNode) {
      errorNode = input.ownerDocument.createElement("p");
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

  input?.addEventListener?.("focus", () => {
    const end = String(input.value || "").length;
    try {
      input.setSelectionRange?.(end, end);
    } catch {
      /* a password field may refuse a selection range */
    }
  });
  input?.addEventListener?.("input", () => {
    if (String(input.value || "") !== "") pendingClear = false;
    hideError();
    syncClear();
  });
  input?.addEventListener?.("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault?.();
    input.blur?.();
  });

  function stop() {
    cancel(savedTimer);
  }

  globalThis.addEventListener?.("pagehide", stop);

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

function hostField(input) {
  if (!input) return null;
  const doc = input.ownerDocument || document;
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
