/**
 * Ask AI panel. Mounts into #sideSlot beside notes.
 * One pane at a time is the viewer's job (onOpenChange).
 * Network and note writes are injected.
 */

import { ASK_CONFIRM_KEY, ASK_TIMEOUT_MS, ASK_WAIT_HINT_MS, askActionsUseIcons, askChipModel, askErrorModel, askPreviewLine, askRouteInputsChanged, askRouteToast, unconfiguredModel } from "../lib/ask-model.js";
import {
  beginTurn,
  buildAskMessages,
  citationPayload,
  clearTurns,
  claimNoteSave,
  createAskSession,
  finishNoteSave,
  nearbyBlocks,
  noteForTurn,
  noteInputFromTurn,
  retryTurn,
  settleTurn,
  stopTurn
} from "../lib/ask-session.js";

const SUGGESTIONS = Object.freeze([
  "这段在说什么？用大白话讲一遍",
  "这个公式每一项是什么意思？",
  "这里的结论有什么前提？"
]);

const ICONS = {
  copy: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"></rect><path d="M3.2 9.2V2.8h6.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"></path></svg>',
  doc: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.2 1.8h5.1L11 4.4v7.8H3.2V1.8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"></path><path d="M8.1 1.9v2.6H11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"></path></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.6 7.2 5.5 10.1 11.4 3.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
  arrow: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.4 7h8.2M7.6 3.6 11.2 7 7.6 10.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path></svg>'
};

function h(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children || []) if (child) node.append(child);
  return node;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderAskAnswer(source) {
  const raw = String(source || "");
  const katex = globalThis.katex;
  if (!katex?.renderToString) return escapeHtml(raw);
  const parts = [];
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let cursor = 0;
  let match = re.exec(raw);
  while (match) {
    parts.push(escapeHtml(raw.slice(cursor, match.index)));
    const tex = match[1] != null ? match[1] : match[2];
    const display = match[1] != null;
    try {
      parts.push(katex.renderToString(tex, { throwOnError: false, trust: false, displayMode: display }));
    } catch {
      parts.push(escapeHtml(match[0]));
    }
    cursor = match.index + match[0].length;
    match = re.exec(raw);
  }
  parts.push(escapeHtml(raw.slice(cursor)));
  return parts.join("");
}

function chipText(citation) {
  if (!citation) return "";
  const page = citation.page ? `第${citation.page}页` : "未分页";
  const bit = String(citation.text || citation.latex || "").replace(/\s+/g, " ").trim().slice(0, 12);
  return bit ? `引用 ${page} · ${bit}…` : `引用 ${page}`;
}

function sourceChipLabel(citation) {
  if (!citation) return "";
  const page = citation.page ? `原文第${citation.page}页` : "未分页";
  if (citation.kind === "formula") return `式 · ${page} ↗`;
  if (citation.section) return `§${citation.section} · ${page} ↗`;
  return `${page} ↗`;
}

export function mountAskUi(api = {}) {
  const slot = document.getElementById("sideSlot");
  const workspace = document.querySelector(".workspace");
  if (!slot || !workspace) return null;

  const root = h("aside", {
    class: "oi-ask",
    role: "complementary",
    "aria-label": "问 AI",
    hidden: true
  });
  slot.append(root);

  const session = createAskSession();
  const saveControllers = new Map();
  const state = {
    open: false,
    route: null,
    settings: null,
    apiKey: "",
    confirmOpen: false,
    previewOpen: false,
    modelPop: false,
    waitHint: false,
    failedRoute: false,
    timers: []
  };

  function configured() {
    return Boolean(state.route?.ok);
  }

  function later(fn, ms) {
    const schedule = api.schedule || ((run, delay) => setTimeout(run, delay));
    const id = schedule(fn, ms);
    state.timers.push(id);
    return id;
  }

  function clearTimers() {
    const cancel = api.cancel || ((id) => clearTimeout(id));
    for (const id of state.timers) cancel(id);
    state.timers = [];
    state.waitHint = false;
  }

  function syncChromeButtons() {
    const button = document.getElementById("askButton");
    const menu = document.getElementById("menuAsk");
    if (button) {
      button.setAttribute("aria-pressed", state.open ? "true" : "false");
      if (state.open) button.dataset.open = "true";
      else delete button.dataset.open;
    }
    if (menu) menu.setAttribute("aria-checked", state.open ? "true" : "false");
  }

  function seedCitation() {
    if (session.citation) return;
    const current = api.currentCitation?.() || null;
    if (!current) return;
    session.citation = { ...current };
    markCite(session.citation);
  }

  function open(focus = true) {
    if (api.hasDoc && !api.hasDoc()) return Promise.resolve(false);
    state.open = true;
    root.hidden = false;
    seedCitation();
    syncChromeButtons();
    api.onOpenChange?.(true);
    return refreshRoute({ toast: false }).then(() => {
      if (focus && state.open) root.querySelector(".oi-ask-input textarea")?.focus();
      return true;
    });
  }

  function close(options = {}) {
    const handoff = options.handoff === true;
    state.open = false;
    state.confirmOpen = false;
    state.modelPop = false;
    root.hidden = true;
    syncChromeButtons();
    clearCiteMark();
    api.onOpenChange?.(false, { handoff, focus: options.focus !== false });
    if (!handoff && options.focus !== false) document.getElementById("askButton")?.focus();
  }

  function toggle() {
    if (state.open) close();
    else open(true);
  }

  async function askCitation(citation, options = {}) {
    if (options.fresh) {
      if (session.flight) stopTurn(session, session.flight.generation, "");
      clearTimers();
      clearTurns(session);
    }
    session.citation = citation || null;
    if (!state.open) await open(false);
    markCite(session.citation);
    render();
    root.querySelector(".oi-ask-input textarea")?.focus();
  }

  async function refreshRoute({ toast = false } = {}) {
    const previous = state.route;
    if (api.readRoute) {
      let read = null;
      try { read = await api.readRoute(); } catch { read = null; }
      state.settings = read?.settings || state.settings;
      state.route = read?.target || state.route || { ok: false };
      if (read && Object.prototype.hasOwnProperty.call(read, "apiKey")) state.apiKey = read.apiKey || "";
      if ((previous?.via || "") !== (state.route?.via || "")) state.failedRoute = false;
      if (toast && state.open) {
        const text = askRouteToast(previous, state.route);
        if (text) api.toast?.(text);
      }
    }
    if (state.open) render();
  }

  function markCite(citation) {
    const flow = api.flow?.();
    if (!flow) return;
    flow.querySelectorAll(".is-ask-cite").forEach((el) => el.classList.remove("is-ask-cite"));
    const bid = citation?.bid || "";
    if (!bid) return;
    const node = flow.querySelector(`[data-bid="${cssEscape(bid)}"]`);
    if (node) node.classList.add("is-ask-cite");
  }

  function clearCiteMark() {
    api.flow?.()?.querySelectorAll(".is-ask-cite").forEach((el) => el.classList.remove("is-ask-cite"));
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(String(value));
    return String(value).replace(/"/g, "");
  }

  function nearbyNow() {
    const blocks = api.blocks?.() || [];
    const focus = session.citation?.bid || api.currentCitation?.()?.bid || "";
    return nearbyBlocks(blocks, focus);
  }

  function previewMessages() {
    const payload = citationPayload(session.citation, state.route?.via || "none");
    return buildAskMessages({
      question: session.draft || "",
      citation: session.citation,
      nearby: nearbyNow(),
      history: session.turns.filter((turn) => turn.status === "done"),
      payload
    });
  }

  function previewLineText() {
    return askPreviewLine({
      citation: session.citation,
      host: state.route?.host || "",
      nearby: nearbyNow(),
      history: session.turns
    });
  }

  function syncPlace() {
    const width = api.width?.() || window.innerWidth || 1200;
    root.dataset.place = width < 900 ? "sheet" : "side";
  }

  function actionButton(spec) {
    const button = h("button", {
      type: "button",
      class: `oi-ask-act is-${spec.id}${spec.view ? " is-view" : ""}${spec.added ? " is-added" : ""}`,
      "data-ask-act": spec.id,
      "aria-label": spec.aria,
      title: spec.aria
    });
    if (spec.inert) {
      button.setAttribute("aria-disabled", "true");
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    } else if (spec.disabled) {
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
    }
    const icon = h("span", { class: "oi-ask-act-icon", html: ICONS[spec.icon] || "" });
    const text = h("span", { class: "oi-ask-act-text", text: spec.label });
    if (spec.iconSide === "end") button.append(text, icon);
    else button.append(icon, text);
    if (!spec.disabled && spec.run) button.addEventListener("click", (event) => {
      event.preventDefault();
      spec.run();
    });
    return button;
  }

  function renderActions(turn) {
    const row = h("div", { class: "oi-ask-actions", role: "group", "aria-label": "回答操作" });
    row.append(actionButton({
      id: "copy",
      label: "复制",
      aria: "复制",
      icon: "copy",
      run: () => { void copyAnswer(turn); }
    }));
    if (turn.noteId) {
      row.append(actionButton({
        id: "added",
        label: "已添加",
        aria: "✓ 已添加",
        icon: "check",
        added: true,
        inert: true
      }));
      row.append(actionButton({
        id: "view",
        label: "查看笔记",
        aria: "查看笔记",
        icon: "arrow",
        iconSide: "end",
        view: true,
        run: () => { void viewNote(turn); }
      }));
    } else {
      row.append(actionButton({
        id: "save",
        label: "添加到笔记",
        aria: "添加到笔记",
        icon: "doc",
        run: () => { void saveNote(turn); }
      }));
    }
    return row;
  }

  function renderTurn(turn) {
    const wrap = h("div", { class: "oi-ask-turn", "data-turn": turn.id });
    if (turn.citation) {
      const card = h("div", { class: "oi-ask-cite-card" });
      const page = turn.citation.page ? `原文第 ${turn.citation.page} 页` : "未分页";
      const section = turn.citation.section ? ` · ${turn.citation.section}` : "";
      card.append(h("div", { class: "oi-ask-cite-meta", text: `引用 · ${page}${section}` }));
      if (turn.payload?.text) card.append(h("p", { class: "oi-ask-cite-body", text: turn.payload.text }));
      if (turn.payload?.note) card.append(h("p", { class: "oi-ask-cite-note", text: turn.payload.note }));
      wrap.append(card);
    }
    wrap.append(h("div", { class: "oi-ask-user", text: turn.question }));
    if (turn.status === "error" && turn.error) {
      const model = askErrorModel(turn.error);
      const bar = h("div", { class: "oi-ask-err", role: "alert" });
      bar.append(h("span", { text: model.text }));
      if (model.retry) bar.append(h("button", { type: "button", text: "重试" }));
      if (model.textRetry) bar.append(h("button", { type: "button", "data-ask-text-retry": "1", text: "改为文字重试" }));
      if (model.settings) bar.append(h("button", { type: "button", "data-ask-settings": "1", text: "去设置" }));
      bar.querySelector("button:not([data-ask-settings]):not([data-ask-text-retry])")?.addEventListener("click", () => { void retry(turn); });
      bar.querySelector("[data-ask-text-retry]")?.addEventListener("click", () => { void retry(turn, { forceText: true }); });
      bar.querySelector("[data-ask-settings]")?.addEventListener("click", () => api.openSettings?.(state.route?.href || "options/options.html#mm"));
      wrap.append(bar);
    }
    if (turn.status === "pending") {
      const bubble = h("div", { class: "oi-ask-bubble" });
      bubble.append(h("p", { class: "oi-ask-who", text: `✦ AI · ${turn.route?.model || ""}` }));
      const dots = h("p", { class: "oi-ask-dots", text: "…" });
      bubble.append(dots);
      if (state.waitHint) bubble.append(h("p", { class: "oi-ask-wait", text: `仍在等待 ${turn.route?.host || ""}…` }));
      wrap.append(bubble);
    } else if (turn.status === "done" || turn.status === "stopped") {
      const bubble = h("div", { class: "oi-ask-bubble" });
      bubble.append(h("p", { class: "oi-ask-who", text: `✦ AI · ${turn.route?.model || ""}` }));
      const answer = h("div", { class: "oi-ask-answer", html: renderAskAnswer(turn.answer) });
      bubble.append(answer);
      if (turn.citation) {
        const source = h("button", { type: "button", class: "oi-ask-source", text: sourceChipLabel(turn.citation) });
        source.addEventListener("click", () => api.showSource?.(turn.citation));
        bubble.append(source);
      }
      if (turn.status === "stopped") bubble.append(h("p", { class: "oi-ask-stopped", text: "已停止" }));
      if (turn.status === "done") {
        bubble.append(renderActions(turn));
        bubble.append(h("p", { class: "oi-ask-disclaimer", text: "模型回答，可能有误" }));
      }
      wrap.append(bubble);
    }
    return wrap;
  }

  function renderStream() {
    const stream = h("div", { class: "oi-ask-stream", tabindex: "0" });
    if (!session.turns.length && !configured()) {
      const copy = unconfiguredModel(state.settings, state.route);
      const empty = h("div", { class: "oi-ask-unconfigured" });
      empty.append(h("h2", { text: copy.title }), h("p", { text: copy.body }));
      const go = h("button", { type: "button", class: "oi-ask-go", text: "去设置" });
      go.addEventListener("click", () => api.openSettings?.(copy.settingsHref));
      const alt = h("button", { type: "button", class: "oi-ask-alt", text: "用翻译大模型 →" });
      alt.addEventListener("click", () => api.openSettings?.(copy.translateHref));
      empty.append(go, alt);
      stream.append(empty);
      return stream;
    }
    if (!session.turns.length) {
      const empty = h("div", { class: "oi-ask-empty" });
      empty.append(
        h("h2", { text: "边读边问" }),
        h("p", { text: "选中文字点「问 AI」，或直接输入。默认带上附近 2 段。" })
      );
      const row = h("div", { class: "oi-ask-suggest" });
      const hasParagraph = Boolean(session.citation || api.currentCitation?.());
      SUGGESTIONS.forEach((label, index) => {
        if (!hasParagraph && index > 0) return;
        const button = h("button", { type: "button", text: label });
        button.addEventListener("click", () => {
          session.draft = label;
          render();
          root.querySelector(".oi-ask-input textarea")?.focus();
        });
        row.append(button);
      });
      empty.append(row);
      stream.append(empty);
      return stream;
    }
    for (const turn of session.turns) stream.append(renderTurn(turn));
    return stream;
  }

  function render() {
    const draft = session.draft;
    const selectionStart = root.querySelector("textarea")?.selectionStart;
    root.replaceChildren();
    syncPlace();
    const sheet = root.dataset.place === "sheet";
    const head = h("header", { class: "oi-ask-head" });
    head.append(h("span", { class: "oi-ask-title", text: session.turns.length ? "对话" : "新对话" }));
    const chip = askChipModel(state.failedRoute ? { ...state.route, ok: true } : state.route);
    if (configured()) {
      const model = h("button", {
        type: "button",
        class: `oi-ask-model${state.failedRoute ? " is-warn" : ""}`,
        text: state.failedRoute ? `${chip.text} · 上次失败` : chip.text,
        "data-ask": "model"
      });
      model.addEventListener("click", () => {
        state.modelPop = !state.modelPop;
        render();
      });
      head.append(model);
    }
    head.append(h("span", { class: "oi-ask-head-gap" }));
    const newer = h("button", { type: "button", class: "oi-ask-icon", "data-ask": "new", "aria-label": "新对话", title: "新对话", text: "+" });
    newer.addEventListener("click", () => {
      if (session.flight) stopTurn(session, session.flight.generation, "");
      clearTimers();
      clearTurns(session);
      render();
    });
    const back = h("button", { type: "button", class: "oi-ask-icon oi-ask-back", "data-ask": "back", text: "← 返回译文", hidden: !sheet });
    back.addEventListener("click", () => close());
    const closer = h("button", { type: "button", class: "oi-ask-icon", "data-ask": "close", "aria-label": "关闭", title: "关闭", text: "×", hidden: sheet });
    closer.addEventListener("click", () => close());
    head.append(newer, back, closer);
    root.append(head);
    if (state.modelPop && configured()) {
      const pop = h("div", { class: "oi-ask-pop" });
      pop.append(h("p", { text: "问 AI 使用这个模型。这里不能改模型。" }));
      const link = h("button", { type: "button", text: "去设置" });
      link.addEventListener("click", () => api.openSettings?.("options/options.html#mm"));
      pop.append(link);
      root.append(pop);
    }
    root.append(renderStream());
    const form = h("form", { class: "oi-ask-compose" });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submit();
    });
    if (session.citation) {
      const chipRow = h("div", { class: "oi-ask-chip" });
      chipRow.append(h("span", { text: chipText(session.citation) }));
      const remove = h("button", { type: "button", "aria-label": "移除引用", text: "×" });
      remove.addEventListener("click", () => {
        session.citation = null;
        clearCiteMark();
        render();
      });
      chipRow.append(remove);
      form.append(chipRow);
    }
    const field = h("div", { class: "oi-ask-input" });
    const area = h("textarea", {
      rows: "2",
      placeholder: configured() ? "继续追问…" : "先配置模型",
      "aria-label": "问题"
    });
    if (!configured()) area.disabled = true;
    area.value = draft;
    area.addEventListener("input", () => {
      session.draft = area.value;
      syncCompose(area);
    });
    area.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    });
    const send = h("button", {
      type: session.flight ? "button" : "submit",
      class: "oi-ask-send",
      "data-ask": session.flight ? "stop" : "send",
      "aria-label": session.flight ? "停止" : "发送",
      text: session.flight ? "■" : "↑"
    });
    if (session.flight) send.addEventListener("click", (event) => {
      event.preventDefault();
      halt();
    });
    if (!session.flight && (!configured() || !draft.trim())) send.disabled = true;
    field.append(area, send);
    form.append(field);
    const line = h("p", { class: "oi-ask-sendline" });
    line.append(h("span", { "data-ask": "preview-line", text: previewLineText() }));
    const full = h("button", { type: "button", text: "看完整内容" });
    full.addEventListener("click", () => {
      state.previewOpen = !state.previewOpen;
      render();
    });
    line.append(document.createTextNode(" "), full);
    form.append(line);
    if (state.previewOpen) {
      const text = previewMessages().map((item) => {
        const body = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
        return `${item.role}: ${body}`;
      }).join("\n\n");
      form.append(h("pre", { class: "oi-ask-preview", text }));
    }
    root.append(form);
    if (state.confirmOpen) root.append(renderConfirm());
    if (selectionStart != null && document.activeElement === area) area.selectionStart = selectionStart;
    syncActionDensity();
  }

  function syncCompose(area) {
    const send = root.querySelector(".oi-ask-send");
    if (!send || session.flight) return;
    send.disabled = !configured() || !String(area?.value || "").trim();
    const line = root.querySelector("[data-ask='preview-line']");
    if (line) {
      line.textContent = previewLineText();
    }
  }

  function syncActionDensity() {
    root.querySelectorAll(".oi-ask-actions").forEach((row) => {
      const width = row.getBoundingClientRect?.().width || row.clientWidth || 0;
      if (askActionsUseIcons(width)) row.dataset.icons = "1";
      else delete row.dataset.icons;
    });
  }

  function renderConfirm() {
    const host = state.route?.host || "该服务";
    const model = state.route?.model || "";
    const dialog = h("div", { class: "oi-ask-confirm", role: "dialog", "aria-modal": "true", "aria-label": "确认发送" });
    const card = h("div", { class: "oi-ask-confirm-card" });
    card.append(
      h("h2", { text: "发送给模型？" }),
      h("p", { text: `将发给 ${host}（${model}）。内容是问题和引用段落。行内公式不会发送。` })
    );
    const quiet = h("input", { type: "checkbox", "data-ask": "quiet" });
    const label = h("label", {}, [quiet, document.createTextNode("以后不再提示")]);
    const actions = h("div", { class: "oi-ask-confirm-actions" });
    const cancel = h("button", { type: "button", text: "取消" });
    cancel.addEventListener("click", () => {
      state.confirmOpen = false;
      render();
    });
    const go = h("button", { type: "button", "data-ask": "confirm-send", text: "发送" });
    go.addEventListener("click", () => {
      const skip = Boolean(quiet.checked);
      state.confirmOpen = false;
      if (skip) void api.writeConfirm?.(false);
      void submit({ confirmed: true });
    });
    actions.append(cancel, go);
    card.append(label, actions);
    dialog.append(card);
    return dialog;
  }

  async function submit({ confirmed = false, forceText = false } = {}) {
    if (session.flight) return { ok: false, reason: "busy" };
    const question = String(session.draft || "");
    if (!question.trim()) return { ok: false, reason: "empty" };
    if (!configured()) return { ok: false, reason: "unconfigured" };
    if (!confirmed) {
      const show = api.readConfirm ? await api.readConfirm() : false;
      if (show) {
        state.confirmOpen = true;
        render();
        return { ok: false, reason: "confirm" };
      }
    }
    let citation = session.citation ? { ...session.citation } : null;
    if (citation) delete citation.image;
    const begun = beginTurn(session, {
      question,
      citation,
      nearby: nearbyNow(),
      route: state.route,
      forceText
    });
    if (!begun.ok) return begun;
    if (!begun.turn.citation) {
      const current = api.currentCitation?.() || null;
      if (current) begun.turn.askedParagraph = { ...current };
    }
    state.failedRoute = false;
    clearTimers();
    later(() => {
      if (session.flight?.generation === begun.generation) {
        state.waitHint = true;
        render();
      }
    }, api.waitMs ?? ASK_WAIT_HINT_MS);
    later(() => {
      if (session.flight?.generation === begun.generation) {
        stopTurn(session, begun.generation, "");
        const turn = session.turns.find((item) => item.id === begun.turn.id);
        if (turn && turn.status === "stopped" && !turn.answer) {
          turn.status = "error";
          turn.error = { via: begun.route.via, status: 0, host: begun.route.host, timeout: true, offline: false, visionRejected: false, fallback: false };
        }
        state.failedRoute = begun.route.via === "multimodal";
        render();
      }
    }, api.timeoutMs ?? ASK_TIMEOUT_MS);
    render();
    let result;
    try {
      result = await api.send?.({
        ...begun.route,
        messages: begun.messages,
        apiKey: state.apiKey,
        signal: begun.signal
      });
    } catch (err) {
      result = { ok: false, offline: true, status: 0, error: String(err?.message || err) };
    }
    clearTimers();
    const settled = settleTurn(session, begun.generation, result);
    if (settled.turn?.status === "done") session.draft = "";
    if (settled.turn?.status === "error" && begun.route.via === "multimodal") state.failedRoute = true;
    if (state.open) render();
    return settled;
  }

  async function retry(turn, { forceText = false } = {}) {
    if (forceText) {
      session.draft = turn.question;
      session.citation = turn.citation;
      return submit({ confirmed: true, forceText: true });
    }
    const again = retryTurn(session, turn.id);
    if (!again.ok) return again;
    state.failedRoute = false;
    render();
    let result;
    try {
      result = await api.send?.({
        ...again.route,
        messages: again.messages,
        apiKey: state.apiKey,
        signal: again.signal
      });
    } catch (err) {
      result = { ok: false, offline: true, status: 0, error: String(err?.message || err) };
    }
    const settled = settleTurn(session, again.generation, result);
    if (settled.turn?.status === "error" && again.route?.via === "multimodal") state.failedRoute = true;
    if (state.open) render();
    return settled;
  }

  function halt() {
    if (!session.flight) return false;
    const partial = "";
    stopTurn(session, session.flight.generation, partial);
    clearTimers();
    render();
    return true;
  }

  async function copyAnswer(turn) {
    const text = String(turn.answer || "");
    try {
      await api.writeText?.(text);
    } catch {
      api.writeTextFallback?.(text);
    }
    api.toast?.("已复制");
  }

  async function saveNote(turn) {
    if (turn.noteId) {
      root.querySelector(`[data-turn="${cssEscape(turn.id)}"] [data-ask-act="view"]`)?.focus();
      return { ok: false, reason: "exists", noteId: turn.noteId };
    }
    const listed = await api.listNotes?.() || [];
    const prior = noteForTurn(listed, turn.id);
    if (prior) {
      turn.noteId = prior.id;
      render();
      root.querySelector(`[data-turn="${cssEscape(turn.id)}"] [data-ask-act="view"]`)?.focus();
      return { ok: true, noteId: prior.id, reused: true };
    }
    const claim = claimNoteSave(session, turn.id);
    if (!claim.ok) {
      if (claim.noteId) root.querySelector(`[data-turn="${cssEscape(turn.id)}"] [data-ask-act="view"]`)?.focus();
      return claim;
    }
    const cite = turn.citation || turn.askedParagraph || null;
    const anchor = await api.anchorFor?.(cite) || null;
    const input = noteInputFromTurn(turn, { docHash: api.docHash?.() || "", anchor, page: cite?.page || 0 });
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    if (controller) saveControllers.set(turn.id, controller);
    try {
      const saved = await api.saveNote?.(input, { signal: controller?.signal });
      if (controller?.signal.aborted || turn.saveTicket !== claim.ticket) {
        return { ok: false, reason: "aborted", stale: turn.saveTicket !== claim.ticket };
      }
      const done = finishNoteSave(session, turn.id, claim.ticket, { ok: Boolean(saved?.id), noteId: saved?.id || "" });
      if (state.open) render();
      if (done.ok) root.querySelector(`[data-turn="${cssEscape(turn.id)}"] [data-ask-act="view"]`)?.focus();
      return done;
    } catch (err) {
      if (controller?.signal.aborted || turn.saveTicket !== claim.ticket) {
        return { ok: false, reason: "aborted" };
      }
      finishNoteSave(session, turn.id, claim.ticket, { ok: false, reason: "failed" });
      api.toast?.("没有写入笔记");
      if (state.open) render();
      return { ok: false, reason: String(err?.message || err) };
    } finally {
      if (controller && saveControllers.get(turn.id) === controller) saveControllers.delete(turn.id);
    }
  }

  async function viewNote(turn) {
    if (!turn.noteId) return { ok: false, reason: "missing" };
    const id = turn.noteId;
    close({ handoff: true, focus: false });
    return api.revealNote?.(id) || { ok: false, reason: "noreveal" };
  }

  function consumeEscape() {
    if (!state.open && !session.flight) return false;
    if (session.flight) {
      halt();
      return true;
    }
    if (state.confirmOpen) {
      state.confirmOpen = false;
      render();
      return true;
    }
    if (state.open) {
      close();
      return true;
    }
    return false;
  }

  function onStorage(changes, area) {
    if (!askRouteInputsChanged(changes, area)) return;
    const routeChange = Boolean(changes.formulaSettings || changes.settings || changes.oiSecrets);
    if (routeChange) void refreshRoute({ toast: state.open });
  }

  const chromeStorage = api.chrome?.storage || globalThis.chrome?.storage;
  chromeStorage?.onChanged?.addListener?.(onStorage);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.open) void refreshRoute({ toast: false });
  });
  window.addEventListener("pagehide", () => {
    const hadFlight = Boolean(session.flight);
    const hadSave = session.turns.some((turn) => turn.saving);
    if (session.flight) stopTurn(session, session.flight.generation, "");
    for (const controller of saveControllers.values()) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
    for (const turn of session.turns) {
      if (!turn.saving) continue;
      turn.saveTicket += 1;
      turn.saving = false;
    }
    if (hadFlight) clearTimers();
    if (state.open && (hadFlight || hadSave)) render();
  });
  window.addEventListener("resize", () => {
    if (state.open) {
      syncPlace();
      const sheet = (api.width?.() || window.innerWidth || 1200) < 900;
      const back = root.querySelector("[data-ask='back']");
      const closer = root.querySelector("[data-ask='close']");
      if (back) back.hidden = !sheet;
      if (closer) closer.hidden = sheet;
      syncActionDensity();
    }
  });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => syncActionDensity());
    observer.observe(root);
  }

  render();

  return {
    root,
    session,
    open,
    close,
    toggle,
    askCitation,
    isOpen: () => state.open,
    consumeEscape,
    refreshRoute,
    submit,
    saveNote,
    syncActionDensity,
    getState: () => state
  };
}
