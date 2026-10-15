/**
 * Library groups on the data page.
 * PR-4 owns the real import/export flow and calls mountDataPanel(root).
 * This placeholder keeps that signature so either PR can land first.
 * DATA-01…26 are not on main yet; the groups, data-focus hooks, and
 * blocked copy below are the contract those tests select on.
 */

export const LIBRARY_PERSIST_KEY = "library.persistHintDismissed";

export const LIBRARY_IMPORT_POLICY = Object.freeze({
  blocksReading: false,
  pausesWhenAllPagesClosed: true,
  settingsImportIsBackground: false
});

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function row(doc, title, note) {
  const line = el(doc, "div", "set-row");
  const copy = el(doc, "div", "set-copy");
  copy.append(el(doc, "p", "set-title", title));
  if (note) copy.append(el(doc, "p", "set-note", note));
  const ctl = el(doc, "div", "set-ctl");
  line.append(copy, ctl);
  return { line, ctl, copy };
}

export function mountDataPanel(root) {
  const doc = root?.ownerDocument || document;
  const state = {
    blocked: false,
    importIncomplete: false,
    settled: false,
    usage: ""
  };

  function paint() {
    root.replaceChildren();
    const usageTitle = el(doc, "h3", "set-gh", "存储用量");
    const usage = el(doc, "div", "set-group");
    usage.setAttribute("data-focus", "usage");
    usage.tabIndex = -1;
    const size = row(doc, "文献库", state.blocked ? "暂时读不了" : (state.usage || "约 —"));
    const keep = row(doc, "长期保存", "未开启");
    const again = el(doc, "button", "btn-secondary", "再申请一次");
    again.type = "button";
    again.setAttribute("data-act", "persist-again");
    keep.ctl.append(again);
    if (state.settled) {
      const mark = el(doc, "span", "set-done", "✓");
      mark.setAttribute("data-state", "settled");
      size.ctl.append(mark, doc.createTextNode(" 完成"));
    }
    usage.append(size.line, keep.line);
    const importTitle = el(doc, "h3", "set-gh", "文献库 · 导入");
    const importGroup = el(doc, "div", "set-group");
    importGroup.setAttribute("data-focus", "import");
    importGroup.tabIndex = -1;
    const incoming = row(doc, "从旧库或导出文件导入", "只增不删。设置导入是一次性写入，不算后台任务。");
    const folder = el(doc, "button", "btn-secondary", "选择文件夹…");
    const file = el(doc, "button", "btn-secondary", "选择文件…");
    folder.type = "button";
    file.type = "button";
    incoming.ctl.classList.add("set-split");
    incoming.ctl.append(folder, file);
    if (state.importIncomplete) {
      const pending = el(doc, "p", "set-note", "导入没完成");
      pending.setAttribute("data-state", "import-incomplete");
      incoming.copy.append(pending);
    }
    if (state.blocked) {
      folder.disabled = true;
      file.disabled = true;
      incoming.copy.append(el(doc, "p", "set-note", "本机存储暂时打不开，稍后再试"));
    }
    importGroup.append(incoming.line);
    const exportTitle = el(doc, "h3", "set-gh", "文献库 · 导出");
    const exportGroup = el(doc, "div", "set-group");
    exportGroup.setAttribute("data-focus", "export");
    exportGroup.tabIndex = -1;
    const outgoing = row(doc, "导出文献库", "不含任何 API 密钥。");
    const exportBtn = el(doc, "button", "btn-secondary", "导出文献库");
    exportBtn.type = "button";
    if (state.blocked) {
      exportBtn.disabled = true;
      outgoing.copy.append(el(doc, "p", "set-note", "本机存储暂时打不开，稍后再试"));
    }
    outgoing.ctl.append(exportBtn);
    exportGroup.append(outgoing.line);
    root.append(usageTitle, usage, importTitle, importGroup, exportTitle, exportGroup);
    if (typeof root.dispatchEvent === "function" && typeof CustomEvent === "function") {
      root.dispatchEvent(new CustomEvent("oi-data-panel", { bubbles: true }));
    }
  }

  function applyStatus(patch = {}) {
    if (Object.prototype.hasOwnProperty.call(patch, "blocked")) state.blocked = patch.blocked === true;
    if (Object.prototype.hasOwnProperty.call(patch, "importIncomplete")) state.importIncomplete = patch.importIncomplete === true;
    if (Object.prototype.hasOwnProperty.call(patch, "settled")) state.settled = patch.settled === true;
    if (Object.prototype.hasOwnProperty.call(patch, "usage")) state.usage = String(patch.usage || "");
    paint();
    if (typeof root.dispatchEvent === "function" && typeof CustomEvent === "function") {
      root.dispatchEvent(new CustomEvent("oi-data-status", { bubbles: true, detail: { ...state } }));
    }
  }

  const api = {
    needsAttention() {
      return state.importIncomplete === true;
    },
    applyStatus,
    get policy() {
      return LIBRARY_IMPORT_POLICY;
    }
  };
  root.oiDataPanel = api;
  paint();
  return api;
}
