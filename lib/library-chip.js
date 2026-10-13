/**
 * Reader chip for one-paper migration, a failed page write, and a storage
 * open that did not finish. Whole-library pause and import stay out of this
 * surface. Nothing here reads an IndexedDB type.
 */

import { onStorageAvailable } from "./platform/idb-open.js";
import {
  BLOCKED_CAN,
  BLOCKED_CANNOT,
  BLOCKED_CHIP,
  BLOCKED_CHIP_LABEL,
  BLOCKED_SAFE_LINE,
  BLOCKED_TITLE,
  MOVE_CHIP_DELAY_MS,
  MOVE_CHIP_TEXT,
  MOVE_CHIP_TITLE,
  RECOVER_FADE_MS,
  RECOVER_HOLD_MS,
  RETRY_MIN_DISABLE_MS,
  STORAGE_MANUAL_RETRY_MS,
  STORAGE_POLL_MS,
  WRITE_FAIL_CHIP,
  WRITE_FAIL_SAFE,
  WRITE_FAIL_TITLE,
  autoRetryLabel,
  blockedGroupCopy,
  blockedReasonCopy,
  blockedRetryAdvice,
  formatClock,
  isStorageBlocked,
  quotaGroupCopy,
  storageFailureCause,
  storageFailureSince
} from "./storage-copy.js";

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children || []) if (child) node.append(child);
  return node;
}

export function createLibraryChip(options = {}) {
  const host = options.host;
  const timers = options.timers || globalThis;
  const delay = options.moveDelayMs ?? MOVE_CHIP_DELAY_MS;
  const pollMs = options.pollMs ?? STORAGE_POLL_MS;
  const manualMs = options.manualRetryMs ?? STORAGE_MANUAL_RETRY_MS;
  const recoverMs = options.recoverMs ?? RECOVER_HOLD_MS;
  const fadeMs = options.fadeMs ?? RECOVER_FADE_MS;
  const minDisable = options.minDisableMs ?? RETRY_MIN_DISABLE_MS;
  const state = {
    mode: "hidden",
    cause: "unknown",
    since: null,
    moving: false,
    moveShown: false,
    holdsMove: true,
    writeFailed: false,
    writeCause: "",
    hideBlockedGroup: false,
    migration: null,
    retrying: false,
    manualFails: 0,
    lastFailAt: null,
    open: false,
    narrowOpen: false,
    recoveredNotes: 0,
    announce: "",
    announced: ""
  };
  let moveTimer = 0;
  let pollTimer = 0;
  let recoverTimer = 0;
  let openCount = 0;
  let opening = false;
  let attempt = 0;
  let blockedEpisode = 0;
  let settledEpisode = -1;
  let recoverInflight = null;
  let stopAvailable = () => {};
  let stopChannel = () => {};
  let rootButton = null;

  function visible() {
    if (typeof options.visible === "function") return options.visible() !== false;
    if (typeof document === "undefined") return true;
    return document.visibilityState !== "hidden";
  }

  function narrow() {
    if (typeof options.narrow === "function") return options.narrow() === true;
    if (typeof window === "undefined") return false;
    return Number(window.innerWidth) > 0 && window.innerWidth < 720;
  }

  function reduced() {
    if (typeof options.reducedMotion === "function") return options.reducedMotion() === true;
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  }

  function say(text) {
    if (!text || text === state.announced) return;
    state.announce = text;
    state.announced = text;
  }

  function priority() {
    if (state.mode === "blocked") return "blocked";
    if (state.writeFailed) return "write-failed";
    if (state.migration && (state.migration.running || state.migration.paused)) return "migration";
    if (state.moving && state.moveShown && state.holdsMove) return "moving";
    if (state.mode === "recovered") return "recovered";
    return "hidden";
  }

  function applyMode(next) {
    const prev = state.mode;
    state.mode = next;
    if (next === "blocked" && prev !== "blocked") say("暂时存不了。已经存好的译文和笔记都还在。");
    if (next === "recovered" && prev !== "recovered") {
      say(state.recoveredNotes > 0 ? `已恢复，存好 ${state.recoveredNotes} 条笔记` : "已恢复");
    }
    if (next === "hidden") state.open = false;
    render();
  }

  function sync() {
    const next = priority();
    if (next !== "blocked" && next !== "recovered" && next !== "write-failed" && next !== "migration" && next !== "moving") {
      applyMode("hidden");
      return;
    }
    if (next === "blocked") applyMode("blocked");
    else if (next === "write-failed") applyMode("write-failed");
    else if (next === "migration") applyMode("migration");
    else if (next === "moving") applyMode("moving");
    else applyMode("recovered");
  }

  function chipText() {
    if (state.mode === "blocked") return BLOCKED_CHIP;
    if (state.mode === "write-failed") return WRITE_FAIL_CHIP;
    if (state.mode === "recovered") {
      return state.recoveredNotes > 0 ? `已恢复 · 存好 ${state.recoveredNotes} 条笔记` : "已恢复";
    }
    if (state.mode === "migration" && state.migration) {
      const done = Number(state.migration.done) || 0;
      const total = Number(state.migration.total) || 0;
      return `正在搬旧库 ${done}/${total}`;
    }
    return MOVE_CHIP_TEXT;
  }

  function chipLabel() {
    if (state.mode === "blocked") return BLOCKED_CHIP_LABEL;
    if (state.mode === "moving") return MOVE_CHIP_TITLE;
    if (state.mode === "migration") return `${chipText()}，点击查看详情`;
    return chipText();
  }

  async function runOpen(budget) {
    openCount += 1;
    const opener = options.openStorage;
    if (typeof opener !== "function") throw new Error("missing open");
    const limit = Number.isFinite(budget) ? budget : manualMs;
    let timer = 0;
    try {
      return await Promise.race([
        Promise.resolve().then(() => opener()),
        new Promise((_, reject) => {
          timer = timers.setTimeout(() => {
            const error = new Error("retry wait");
            error.name = "BlockedError";
            error.cause = state.cause === "blocked" || state.cause === "timeout" ? state.cause : "timeout";
            reject(error);
          }, limit);
        })
      ]);
    } finally {
      if (timer) timers.clearTimeout(timer);
    }
  }

  async function retry() {
    // A poll already has an open in flight. Starting another from the button
    // raced that one and could time out after the first had recovered.
    if (state.retrying || opening) return;
    state.retrying = true;
    state.open = true;
    render();
    const started = Date.now();
    let failed = null;
    try {
      await runOpen();
    } catch (error) {
      failed = error;
    }
    const elapsed = Date.now() - started;
    if (failed && elapsed < minDisable) {
      await new Promise((resolve) => timers.setTimeout(resolve, minDisable - elapsed));
    }
    state.retrying = false;
    if (!failed) {
      await recover();
      return;
    }
    state.cause = storageFailureCause(failed);
    const since = storageFailureSince(failed);
    if (since) state.since = since;
    state.manualFails += 1;
    state.lastFailAt = Date.now();
    render();
  }

  async function autoRetry(opts = {}) {
    if (state.mode !== "blocked" || state.retrying || !visible()) return;
    // A poll can be inside the 11s manual wait when storage frees.
    // Ignoring the available signal until that wait ends left the chip
    // on “暂时存不了” for about 15s. The signal starts a new attempt.
    if (opening && !opts.preempt) return;
    const token = ++attempt;
    opening = true;
    try {
      await runOpen(opts.preempt ? Math.min(1000, manualMs) : undefined);
      // A preempted attempt that still succeeds is the open we wanted.
      // Waiting on the newer attempt left the chip blocked after storage
      // had already come back. A failure stays quiet.
      if (state.mode !== "blocked") return;
      await recover();
    } catch {
      /* a quiet retry does not change the failure line */
    } finally {
      if (token === attempt) opening = false;
    }
  }

  function armPoll() {
    if (pollTimer) timers.clearTimeout(pollTimer);
    pollTimer = 0;
    if (state.mode !== "blocked") return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = 0;
      if (state.mode !== "blocked") return;
      if (visible()) void autoRetry();
      armPoll();
    }, pollMs);
  }

  async function recover(extra = {}) {
    // A preempted open and the open that replaced it can both succeed while
    // this is still awaiting the flush. One blocked episode announces once.
    if (settledEpisode === blockedEpisode) return;
    if (recoverInflight) return recoverInflight;
    const episode = blockedEpisode;
    recoverInflight = (async () => {
      try {
        await finishRecover(extra, episode);
      } finally {
        recoverInflight = null;
      }
    })();
    return recoverInflight;
  }

  async function finishRecover(extra, episode) {
    if (typeof options.flushNotes === "function") {
      try {
        const count = await options.flushNotes();
        if (Number.isFinite(count)) state.recoveredNotes = count;
      } catch (error) {
        if (isStorageBlocked(error)) {
          block(error);
          return;
        }
        state.writeFailed = true;
      }
    }
    if (typeof options.flushPages === "function") {
      try {
        await options.flushPages();
      } catch (error) {
        if (isStorageBlocked(error)) {
          block(error);
          return;
        }
      }
    }
    if (episode !== blockedEpisode) return;
    if (extra.notes > 0) state.recoveredNotes = extra.notes;
    if (typeof options.onRecovered === "function") {
      try {
        options.onRecovered({ notes: state.recoveredNotes });
      } catch {
        /* the chip still leaves the blocked state */
      }
    }
    if (episode !== blockedEpisode) return;
    state.manualFails = 0;
    state.lastFailAt = null;
    if (state.migration && (state.migration.running || state.migration.paused)) {
      state.mode = "hidden";
      settledEpisode = episode;
      sync();
      return;
    }
    state.mode = "recovered";
    settledEpisode = episode;
    say(state.recoveredNotes > 0 ? `已恢复，存好 ${state.recoveredNotes} 条笔记` : "已恢复");
    render();
    if (recoverTimer) timers.clearTimeout(recoverTimer);
    const fade = reduced() ? 0 : fadeMs;
    recoverTimer = timers.setTimeout(() => {
      state.mode = "hidden";
      state.recoveredNotes = 0;
      state.open = false;
      sync();
    }, recoverMs + fade);
  }

  function block(error) {
    blockedEpisode += 1;
    state.cause = storageFailureCause(error);
    state.since = storageFailureSince(error);
    state.writeFailed = false;
    state.mode = "blocked";
    say("暂时存不了。已经存好的译文和笔记都还在。");
    render();
    armPoll();
  }

  function writeFailed(error) {
    if (isStorageBlocked(error)) {
      block(error);
      return;
    }
    state.writeCause = error?.type === "blocked" ? "blocked" : "quota";
    state.writeFailed = true;
    if (state.mode !== "blocked") sync();
  }

  function startMove({ holds = true } = {}) {
    state.moving = true;
    state.holdsMove = holds !== false;
    state.moveShown = false;
    if (moveTimer) timers.clearTimeout(moveTimer);
    moveTimer = timers.setTimeout(() => {
      moveTimer = 0;
      if (!state.moving) return;
      state.moveShown = true;
      sync();
    }, delay);
  }

  function finishMove() {
    state.moving = false;
    state.moveShown = false;
    if (moveTimer) timers.clearTimeout(moveTimer);
    moveTimer = 0;
    sync();
  }

  function setMigration(snapshot) {
    state.migration = snapshot || null;
    if (state.mode !== "blocked") sync();
  }

  function closePop() {
    state.open = false;
    render();
    rootButton?.focus?.();
  }

  function renderBlockedPop(pop) {
    const copy = blockedReasonCopy(state.cause);
    pop.append(el("h2", { id: "oiLibPopTitle", text: BLOCKED_TITLE }));
    if (state.since) pop.append(el("p", { class: "oi-lib-since", text: `从 ${formatClock(state.since)} 起` }));
    pop.append(el("p", { class: "safe", text: BLOCKED_SAFE_LINE }));
    pop.append(el("p", { class: "oi-lib-reason", text: copy.reason }));
    if (copy.hint) pop.append(el("p", { class: "oi-lib-hint", text: copy.hint }));
    const groups = el("div", { class: "oi-lib-ability" });
    if (narrow() && !state.narrowOpen) {
      const link = el("button", { type: "button", class: "oi-lib-fold", text: "哪些功能受影响" });
      link.addEventListener("click", () => {
        state.narrowOpen = true;
        render();
      });
      groups.append(link);
    } else {
      groups.append(
        el("p", { class: "oi-lib-can", text: `现在可以：${BLOCKED_CAN}` }),
        el("p", { class: "oi-lib-cannot", text: `暂时不行：${BLOCKED_CANNOT}` })
      );
    }
    pop.append(groups);
    if (state.lastFailAt && !state.retrying) {
      const line = el("p", {
        class: "oi-lib-fail",
        text: `又试了一次，还是没打开（${formatClock(state.lastFailAt)}）。`
      });
      if (state.manualFails >= 3) {
        line.textContent = `${line.textContent}${blockedRetryAdvice(state.cause)}`;
      }
      pop.append(line);
    }
    const row = el("div", { class: "oi-lib-retry-row" });
    row.append(el("span", { class: "oi-lib-poll", text: autoRetryLabel() }));
    const button = el("button", {
      type: "button",
      class: "oi-lib-primary",
      text: state.retrying ? "正在重试…" : "重试",
      "aria-busy": state.retrying ? "true" : "false"
    });
    if (state.retrying) button.disabled = true;
    button.addEventListener("click", () => {
      void retry();
    });
    row.append(button);
    pop.append(row);
  }

  function renderWritePop(pop) {
    pop.append(el("h2", { id: "oiLibPopTitle", text: WRITE_FAIL_TITLE }));
    pop.append(el("p", { class: "safe", text: WRITE_FAIL_SAFE }));
    if (state.writeCause !== "blocked") {
      const copy = quotaGroupCopy();
      pop.append(el("section", { class: "oi-lib-err-group" }, [
        el("h3", { text: copy.title }),
        el("p", { text: copy.body })
      ]));
    }
    if (state.writeCause === "blocked" && !state.hideBlockedGroup) {
      const copy = blockedGroupCopy();
      const section = el("section", { class: "oi-lib-err-group" }, [
        el("h3", { text: copy.title }),
        el("p", { text: copy.body })
      ]);
      const ack = el("button", { type: "button", class: "oi-lib-primary", text: "知道了" });
      ack.addEventListener("click", () => {
        state.hideBlockedGroup = true;
        state.writeFailed = false;
        state.open = false;
        sync();
      });
      section.append(ack);
      pop.append(section);
    }
  }

  function render() {
    if (!host) return;
    host.replaceChildren();
    const mode = state.mode;
    if (mode === "hidden") {
      host.hidden = true;
      rootButton = null;
      return;
    }
    host.hidden = false;
    const button = el("button", {
      type: "button",
      class: `oi-lib-chip${mode === "blocked" || mode === "write-failed" ? " is-warn" : ""}${mode === "recovered" ? " is-recovered" : ""}${mode === "moving" ? " is-moving" : ""}`,
      "aria-label": chipLabel(),
      title: mode === "moving" ? MOVE_CHIP_TITLE : null,
      "aria-disabled": mode === "moving" ? "true" : null,
      "aria-expanded": state.open ? "true" : "false",
      "aria-controls": state.open ? "oiLibPop" : null
    });
    button.append(
      el("span", { class: "oi-lib-mark", "aria-hidden": "true", text: mode === "recovered" ? "✓" : (mode === "blocked" || mode === "write-failed" ? "⚠" : "") }),
      el("span", { class: "oi-lib-label", text: chipText() })
    );
    if (mode === "moving") {
      button.addEventListener("click", (event) => event.preventDefault());
    } else {
      button.addEventListener("click", () => {
        state.open = !state.open;
        render();
        if (!state.open) button.focus?.();
      });
    }
    host.append(button);
    rootButton = button;
    if (state.announce) {
      host.append(el("span", { class: "oi-lib-live sr-only", "aria-live": "polite", text: state.announce }));
      state.announce = "";
    }
    if (!state.open || mode === "moving") return;
    const pop = el("div", {
      id: "oiLibPop",
      class: `oi-lib-pop${narrow() ? " is-sheet" : ""}${mode === "blocked" ? " is-blocked" : ""}`,
      role: "dialog",
      "aria-labelledby": "oiLibPopTitle"
    });
    if (mode === "blocked") renderBlockedPop(pop);
    else if (mode === "write-failed") renderWritePop(pop);
    else if (mode === "recovered") {
      pop.append(el("h2", { id: "oiLibPopTitle", text: "已恢复" }));
      pop.append(el("p", { class: "safe", text: state.recoveredNotes > 0 ? `存好 ${state.recoveredNotes} 条笔记` : BLOCKED_SAFE_LINE }));
    } else if (mode === "migration") {
      pop.append(el("h2", { id: "oiLibPopTitle", text: "正在搬旧库" }));
    }
    host.append(pop);
  }

  function onKey(event) {
    if (event.key !== "Escape" || !state.open) return;
    event.preventDefault();
    closePop();
  }

  function onVisibility() {
    if (state.mode === "blocked" && visible()) void autoRetry();
  }

  function onAvailable() {
    if (state.mode === "blocked") void autoRetry({ preempt: true });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);
  }
  stopAvailable = onStorageAvailable(onAvailable);
  if (typeof BroadcastChannel === "function") {
    try {
      const channel = new BroadcastChannel("oi-library");
      channel.onmessage = (message) => {
        if (message?.data?.type === "oi-storage-available") onAvailable();
      };
      stopChannel = () => {
        try {
          channel.close();
        } catch {
          /* already closed */
        }
      };
    } catch {
      stopChannel = () => {};
    }
  }

  return {
    block,
    writeFailed,
    startMove,
    finishMove,
    setMigration,
    recover,
    closePop,
    autoRetry,
    retry,
    state,
    opens: () => openCount,
    destroy() {
      if (moveTimer) timers.clearTimeout(moveTimer);
      if (pollTimer) timers.clearTimeout(pollTimer);
      if (recoverTimer) timers.clearTimeout(recoverTimer);
      stopAvailable();
      stopChannel();
      if (typeof document !== "undefined") {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("visibilitychange", onVisibility);
      }
    },
    text: chipText
  };
}
