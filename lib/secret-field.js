/**
 * Shared key field: commit on blur or Enter, ignore a blank draft,
 * show the mask (first 3 + bullets + last 4) until "显示".
 */

import { commitSecret, maskSecret } from "./settings-secrets.js";

export function bindSecretInput(input, { getValue, schedule, clear, revealMs } = {}) {
  const later = schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel = clear || ((id) => clearTimeout(id));
  const limit = revealMs || 30000;
  let revealed = false;
  let masked = false;
  let timer = 0;
  let savedTimer = 0;

  function real() {
    return String(getValue?.() || "");
  }

  function mark(flag) {
    masked = flag;
    if (input?.dataset) input.dataset.masked = flag ? "1" : "0";
  }

  function paint() {
    const value = real();
    if (!input) return;
    if (revealed && value) {
      mark(false);
      input.value = value;
      return;
    }
    revealed = false;
    if (!value) {
      mark(false);
      input.value = "";
      return;
    }
    mark(true);
    input.value = maskSecret(value);
  }

  function hideSaved() {
    const note = input?.parentElement?.querySelector?.("[data-secret-saved]");
    if (note) note.textContent = "";
  }

  function showSaved() {
    const note = input?.parentElement?.querySelector?.("[data-secret-saved]");
    if (!note) return;
    note.textContent = "已保存";
    cancel(savedTimer);
    savedTimer = later(() => {
      note.textContent = "";
    }, 1200);
  }

  function commit() {
    if (!input) return { ignored: true, empty: true, value: real() };
    const raw = input.value;
    const prev = real();
    if (masked && raw === maskSecret(prev)) {
      paint();
      return { ignored: true, empty: false, value: prev };
    }
    const result = commitSecret(prev, raw);
    if (result.empty) {
      revealed = false;
      cancel(timer);
      hideSaved();
      paint();
      return { ignored: true, empty: true, value: result.value };
    }
    revealed = false;
    cancel(timer);
    paint();
    return { ignored: false, empty: false, value: result.value, changed: result.changed, showSaved };
  }

  input?.addEventListener?.("focus", () => {
    if (masked) {
      mark(false);
      input.value = "";
    }
  });
  input?.addEventListener?.("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault?.();
    input.blur?.();
  });

  function reveal(on) {
    cancel(timer);
    revealed = on === true && Boolean(real());
    paint();
    if (revealed) {
      timer = later(() => {
        revealed = false;
        paint();
      }, limit);
    }
  }

  function stop() {
    cancel(timer);
    cancel(savedTimer);
    revealed = false;
    if (input && !masked) input.value = "";
    paint();
  }

  globalThis.addEventListener?.("pagehide", stop);

  return { paint, commit, reveal, stop, showSaved, hideSaved };
}
