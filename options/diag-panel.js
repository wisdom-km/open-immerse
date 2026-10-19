/**
 * About › 问题诊断. Export and clear go through the service-worker writer.
 * The file is a browser download (Blob + a[download]). A cancelled save dialog
 * cannot be observed, so a completed click is reported as exported.
 */

import {
  DIAG_TEXT,
  describeDiagExportResult,
  diagRecordedLine,
  performDiagExport
} from "../lib/diag-log.js";

export function bindDiagPanel(doc = globalThis.document, deps = {}) {
  const root = doc?.getElementById?.("diagGroup");
  const exportBtn = doc?.getElementById?.("diagExport");
  const status = doc?.getElementById?.("diagStatus");
  const statusText = doc?.getElementById?.("diagStatusText");
  const clearCtl = doc?.getElementById?.("diagClearCtl");
  if (!root || !exportBtn || !status || !statusText || !clearCtl) return;
  if (exportBtn.dataset.bound === "1") return;
  exportBtn.dataset.bound = "1";

  const request = deps.request || ((message) => globalThis.chrome.runtime.sendMessage(message));
  let view = { count: 0, bytes: 0, code: "no-records" };
  let cleared = false;
  let busy = "";
  let confirmTimer = 0;
  let onKey = null;

  function setStatus(text, tone) {
    statusText.textContent = text;
    status.classList.toggle("is-warn", tone === "warn");
    status.classList.toggle("set-done", tone === "ok" || text === DIAG_TEXT.cleared);
    const retry = status.querySelector("[data-diag-retry]");
    if (retry) retry.remove();
  }

  function paintCount() {
    if (cleared) {
      setStatus(DIAG_TEXT.cleared, "ok");
      return;
    }
    if (view.code === "storage-unreadable") {
      setStatus(DIAG_TEXT.unreadable, "warn");
      return;
    }
    setStatus(view.count > 0 ? diagRecordedLine(view.count, view.bytes) : DIAG_TEXT.empty, "idle");
  }

  function setBusy(next) {
    busy = next;
    exportBtn.disabled = next === "export" || next === "clear";
    const clearBtn = clearCtl.querySelector("button");
    if (clearBtn) clearBtn.disabled = next === "export" || next === "clear";
    for (const button of clearCtl.querySelectorAll("button")) button.disabled = next === "export" || next === "clear";
  }

  async function refresh() {
    try {
      const stats = await request({ type: "OI_DIAG_STATS" });
      if (!stats || stats.ok === false) return;
      view = {
        count: Math.max(0, Number(stats.count) || 0),
        bytes: Math.max(0, Number(stats.bytes) || 0),
        code: stats.code || ""
      };
      if (!cleared && !busy) paintCount();
    } catch {
      /* the idle copy stays until a real export result */
    }
  }

  function showFailure(text) {
    setStatus(text, "warn");
    const retry = doc.createElement("button");
    retry.type = "button";
    retry.className = "set-inline diag-retry";
    retry.dataset.diagRetry = "1";
    retry.textContent = DIAG_TEXT.retry;
    retry.addEventListener("click", () => { void runExport(); });
    status.append(retry);
  }

  async function runExport() {
    if (busy) return;
    restoreClear(false);
    cleared = false;
    setBusy("export");
    const locked = exportBtn.offsetWidth;
    if (locked) exportBtn.style.minWidth = `${locked}px`;
    exportBtn.textContent = DIAG_TEXT.packing;
    try {
      const result = await performDiagExport({ request, download: deps.download, now: deps.now, env: deps.env });
      if (Number.isFinite(Number(result?.count))) view.count = Number(result.count) || 0;
      const described = describeDiagExportResult(result, view);
      if (described.retry) showFailure(described.text);
      else setStatus(described.text, described.tone);
      if (result?.code === "no-records") view = { count: 0, bytes: 0, code: "no-records" };
    } finally {
      exportBtn.textContent = DIAG_TEXT.exportLabel;
      setBusy("");
      exportBtn.focus();
    }
  }

  function restoreClear(paint, focus) {
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = 0;
    }
    if (onKey) {
      doc.removeEventListener("keydown", onKey);
      onKey = null;
    }
    clearCtl.classList.remove("diag-confirm");
    clearCtl.textContent = "";
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "set-inline";
    button.id = "diagClear";
    button.textContent = DIAG_TEXT.clear;
    button.disabled = busy === "export" || busy === "clear";
    button.addEventListener("click", () => openConfirm());
    clearCtl.append(button);
    if (focus) button.focus();
    if (paint) paintCount();
  }

  function openConfirm() {
    if (busy) return;
    clearCtl.textContent = "";
    clearCtl.classList.add("diag-confirm");
    const label = doc.createElement("span");
    label.className = "diag-confirm-label";
    label.textContent = DIAG_TEXT.clearConfirm;
    const actions = doc.createElement("span");
    actions.className = "set-split diag-confirm-actions";
    const yes = doc.createElement("button");
    yes.type = "button";
    yes.className = "set-inline diag-warn";
    yes.id = "diagClearConfirm";
    yes.textContent = DIAG_TEXT.clear;
    const no = doc.createElement("button");
    no.type = "button";
    no.className = "set-inline";
    no.id = "diagClearCancel";
    no.textContent = DIAG_TEXT.cancel;
    yes.addEventListener("click", () => { void confirmClear(); });
    no.addEventListener("click", () => restoreClear(false, true));
    actions.append(yes, no);
    clearCtl.append(label, actions);
    onKey = (ev) => {
      if (ev.key === "Escape") restoreClear(false, true);
    };
    doc.addEventListener("keydown", onKey);
    confirmTimer = setTimeout(() => restoreClear(false, true), 5000);
  }

  async function confirmClear() {
    if (busy === "clear") return;
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = 0;
    }
    setBusy("clear");
    try {
      const res = await request({ type: "OI_DIAG_CLEAR" });
      if (!res || res.ok === false) return;
      view = { count: 0, bytes: 0, code: "no-records" };
      cleared = true;
      setStatus(DIAG_TEXT.cleared, "ok");
    } catch {
      /* leave the log in place; the confirm row still closes */
    } finally {
      setBusy("");
      restoreClear(false, true);
      if (cleared) setStatus(DIAG_TEXT.cleared, "ok");
    }
  }

  exportBtn.addEventListener("click", () => { void runExport(); });
  const clearBtn = clearCtl.querySelector("#diagClear");
  clearBtn?.addEventListener("click", () => openConfirm());
  void refresh();
}
