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
    importJob: null,
    importFading: false,
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
  let doneTimer = 0;
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

  function importVisible() {
    const job = state.importJob;
    if (!job || job.later) return false;
    const phase = job.phase;
    if (phase === "resume" || phase === "incomplete" || phase === "error" || phase === "rejected") return true;
    if (job.holds === false) return false;
    return phase === "running" || phase === "scanning" || phase === "paused" || phase === "done";
  }

  function priority() {
    if (state.mode === "blocked") return "blocked";
    if (state.writeFailed) return "write-failed";
    if (importVisible()) {
      const phase = state.importJob.phase;
      if (phase === "error" || phase === "incomplete" || phase === "rejected") return "import";
      if (phase === "paused" || phase === "resume") return "import";
      return "import";
    }
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
    if (next !== "blocked" && next !== "recovered" && next !== "write-failed" && next !== "migration" && next !== "moving" && next !== "import") {
      applyMode("hidden");
      return;
    }
    if (next === "blocked") applyMode("blocked");
    else if (next === "write-failed") applyMode("write-failed");
    else if (next === "import") applyMode("import");
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
    if (state.mode === "import") return importText();
    return MOVE_CHIP_TEXT;
  }

  function importCount() {
    const job = state.importJob || {};
    const done = Number(job.done) || 0;
    const total = job.total == null || job.total === "" ? null : Number(job.total);
    return { done, total: Number.isFinite(total) ? total : null };
  }

  function importText() {
    const job = state.importJob || {};
    const { done, total } = importCount();
    const ratio = total == null ? `${done} 篇` : `${done}/${total}`;
    if (job.phase === "paused") return `已暂停 ${done}/${total || done}`;
    if (job.phase === "resume") return `导入待继续 ${done}/${total || done}`;
    if (job.phase === "incomplete") return `⚠ 导入没完成 ${done}/${total || done}`;
    if (job.phase === "error" || job.phase === "rejected") {
      const n = Number(job.failed) || (job.errors || []).length || 0;
      return `⚠ ${n} 篇没导入`;
    }
    if (job.phase === "done") {
      const n = Number.isFinite(job.importedPapers) ? job.importedPapers : ((Number(job.added) || 0) + (Number(job.updated) || 0));
      return `✓ 已导入 ${n} 篇`;
    }
    return total == null ? `正在导入 ${done} 篇` : `正在导入 ${ratio}`;
  }

  function chipLabel() {
    if (state.mode === "blocked") return BLOCKED_CHIP_LABEL;
    if (state.mode === "moving") return MOVE_CHIP_TITLE;
    if (state.mode === "migration") return `${chipText()}，点击查看详情`;
    if (state.mode === "import") {
      const text = importText();
      if (state.importJob?.phase === "done") return text;
      return `${text}，点击查看详情`;
    }
    return chipText();
  }

  async function runOpen(budget) {
    openCount += 1;
    const opener = options.openStorage;
    if (typeof opener !== "function") throw new Error("missing open");
    const limit = Number.isFinite(budget) ? budget : manualMs;
    const job = Promise.resolve().then(() => opener());
    let timer = 0;
    let timedOut = false;
    try {
      return await Promise.race([
        job,
        new Promise((_, reject) => {
          timer = timers.setTimeout(() => {
            timedOut = true;
            const error = new Error("retry wait");
            error.name = "BlockedError";
            error.cause = state.cause === "blocked" || state.cause === "timeout" ? state.cause : "timeout";
            reject(error);
          }, limit);
        })
      ]);
    } finally {
      if (timer) timers.clearTimeout(timer);
      // A fresh migration's reopen can outlast the 1s preempt budget.
      // The chip used to stay on 暂时存不了 after that open had already succeeded.
      if (timedOut) {
        job.then(() => {
          if (state.mode === "blocked") void recover();
        }, () => {});
      }
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

  function clearDoneTimer() {
    if (doneTimer) timers.clearTimeout(doneTimer);
    doneTimer = 0;
    state.importFading = false;
  }

  function armDoneFade() {
    clearDoneTimer();
    const hold = options.doneHoldMs ?? 3000;
    const fade = options.fadeMs ?? RECOVER_FADE_MS;
    doneTimer = timers.setTimeout(() => {
      doneTimer = 0;
      if (state.importJob?.phase !== "done") return;
      if (reduced()) {
        state.importJob = null;
        sync();
        return;
      }
      state.importFading = true;
      render();
      doneTimer = timers.setTimeout(() => {
        doneTimer = 0;
        state.importFading = false;
        if (state.importJob?.phase === "done") state.importJob = null;
        sync();
      }, fade);
    }, hold);
  }

  function importBucket(job) {
    if (!job) return "";
    const done = Number(job.done) || 0;
    const total = Number(job.total);
    const quarter = Number.isFinite(total) && total > 0 ? Math.floor((done / total) * 4) : 0;
    return `${job.phase}:${quarter}`;
  }

  function setImport(snapshot) {
    const prev = state.importJob;
    const prevKey = importBucket(prev);
    state.importJob = snapshot || null;
    if (!snapshot || snapshot.phase !== "done") clearDoneTimer();
    else if (!prev || prev.phase !== "done") armDoneFade();
    if (snapshot && prevKey !== importBucket(snapshot)) say(importText());
    if (state.mode !== "blocked") sync();
  }

  function command(name) {
    try {
      options.onImportCommand?.(name, state.importJob);
    } catch {
      /* the chip stays up; the panel reports the failure */
    }
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

  function namesOf(errors) {
    return (errors || []).map((item) => item.title || item.fileName || String(item.docHash || "").slice(0, 8)).filter(Boolean);
  }

  function renderImportPop(pop) {
    const job = state.importJob || {};
    const { done, total } = importCount();
    const rest = total == null ? 0 : Math.max(0, total - done);
    const folder = job.folder || "旧库";
    const link = (label, cmd) => {
      const button = el("button", { type: "button", class: "oi-lib-link", text: label });
      button.addEventListener("click", () => command(cmd));
      return button;
    };
    const primary = (label, cmd) => {
      const button = el("button", { type: "button", class: "oi-lib-primary", text: label });
      button.addEventListener("click", () => command(cmd));
      return button;
    };
    if (job.phase === "resume") {
      pop.append(el("h2", { id: "oiLibPopTitle", text: "导入待继续" }));
      pop.append(el("p", { class: "safe", text: `已导入的 ${done} 篇都在，可以照常读。` }));
      pop.append(el("p", { text: `浏览器重启后，需要你再允许一次读取「${folder}」文件夹，才能接着导入剩下的 ${rest} 篇。` }));
      const row = el("div", { class: "oi-lib-actions" });
      row.append(link("以后再说", "later"), primary("允许并继续", "allow"));
      pop.append(row);
      return;
    }
    if (job.phase === "incomplete") {
      pop.append(el("h2", { id: "oiLibPopTitle", text: "导入没完成" }));
      pop.append(el("p", { class: "safe", text: `已导入的 ${done} 篇都在，旧文件夹里的数据也没动。` }));
      pop.append(el("p", { text: `读不到上次的「${folder}」文件夹了（没有允许读取，或者文件夹被移动、改名）。重新选一次就能接着导入，已导入的会自动跳过。` }));
      const row = el("div", { class: "oi-lib-actions" });
      row.append(link("不再导入", "abandon"), primary("重新选择文件夹…", "reselect"));
      pop.append(row);
      return;
    }
    if (job.phase === "paused") {
      pop.append(el("h2", { id: "oiLibPopTitle", text: "已暂停导入" }));
      pop.append(el("p", { class: "safe", text: `已导入的 ${done} 篇都在，可以照常读。` }));
      pop.append(primary("继续", "resume"));
      pop.append(el("p", { class: "oi-lib-note", text: `暂停后，下次打开会从第 ${done + 1} 篇接着导入。` }));
      return;
    }
    if (job.phase === "error" || job.phase === "rejected") {
      const errors = job.errors || [];
      const n = Number(job.failed) || errors.length;
      pop.append(el("h2", { id: "oiLibPopTitle", text: `${n} 篇没导入` }));
      pop.append(el("p", { class: "safe", text: "旧数据都还在原处，没有删除，也没有丢。" }));
      const order = ["quota", "blocked", "corrupt"];
      for (const reason of order) {
        const group = errors.filter((item) => item.reason === reason);
        if (!group.length) continue;
        const copy = reason === "quota"
          ? { title: "空间不够", body: "浏览器给文献库的空间满了。清理一些论文的缓存或原 PDF 后再试。", action: "清理空间", cmd: "usage" }
          : reason === "blocked"
            ? { title: "浏览器不允许写入", body: "这个窗口不能保存文献库（例如隐私窗口，或浏览器设置禁止了网站数据）。继续用旧方式读取，不影响阅读。", action: "知道了", cmd: "ack-blocked" }
            : { title: "文件损坏", body: "这篇的旧数据读不出来，已跳过。原文件没动。", action: "导出出错明细", cmd: "export-errors" };
        const section = el("section", { class: "oi-lib-err-group" });
        const head = el("div", { class: "oi-lib-err-head" });
        head.append(el("h3", { text: copy.title }), el("span", { text: `${group.length} 篇` }));
        section.append(head, el("p", { text: copy.body }));
        const shown = namesOf(group).slice(0, 3);
        for (const name of shown) section.append(el("p", { class: "oi-lib-err-name", text: name }));
        if (group.length > 3) section.append(el("p", { class: "oi-lib-err-name", text: `还有 ${group.length - 3} 篇` }));
        section.append(primary(copy.action, copy.cmd));
        pop.append(section);
      }
      const row = el("div", { class: "oi-lib-actions" });
      row.append(link("导出备份", "backup"), primary("重试", "retry"));
      pop.append(row);
      return;
    }
    pop.append(el("h2", { id: "oiLibPopTitle", text: "正在导入" }));
    pop.append(el("p", { class: "safe", text: "旧数据都还在原处，不会删除。导入的时候可以照常阅读和翻译。" }));
    if (job.parentAdjusted) {
      pop.append(el("p", { text: "你选的是上一层，已自动改用里面的「files」文件夹。" }));
    }
    const pct = total ? Math.round((done / total) * 100) : 0;
    pop.append(el("p", { class: "oi-lib-count", text: `已导入 ${done} 篇 · 剩 ${rest} 篇` }), el("p", { text: `${pct}%` }));
    pop.append(primary("暂停", "pause"));
    pop.append(el("p", { class: "oi-lib-note", text: `暂停后，下次打开会从第 ${done + 1} 篇接着导入。` }));
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
    const job = state.importJob || {};
    const importWarn = mode === "import" && (job.phase === "error" || job.phase === "incomplete" || job.phase === "rejected");
    const importPaused = mode === "import" && (job.phase === "paused" || job.phase === "resume");
    const importDone = mode === "import" && job.phase === "done";
    const importRun = mode === "import" && (job.phase === "running" || job.phase === "scanning");
    const button = el("button", {
      type: "button",
      class: `oi-lib-chip${mode === "blocked" || mode === "write-failed" || importWarn ? " is-warn" : ""}${mode === "recovered" ? " is-recovered" : ""}${importDone ? " is-done" : ""}${importPaused ? " is-paused" : ""}${importRun ? " is-running" : ""}${mode === "moving" ? " is-moving" : ""}${reduced() ? " is-reduced" : ""}${state.importFading ? " is-fading" : ""}`,
      "aria-label": chipLabel(),
      title: mode === "moving" ? MOVE_CHIP_TITLE : null,
      "aria-disabled": mode === "moving" || importDone ? "true" : null,
      "aria-expanded": state.open ? "true" : "false",
      "aria-controls": state.open ? "oiLibPop" : null
    });
    const mark = mode === "recovered" || importDone
      ? "✓"
      : (mode === "blocked" || mode === "write-failed" || importWarn ? "⚠" : (importPaused ? "❚❚" : ""));
    const kids = [];
    if (importRun) kids.push(el("span", { class: `oi-lib-ring${reduced() ? " is-static" : ""}`, "aria-hidden": "true" }));
    kids.push(el("span", { class: "oi-lib-mark", "aria-hidden": "true", text: mark }));
    kids.push(el("span", { class: "oi-lib-label", text: chipText() }));
    button.append(...kids);
    if (mode === "moving" || importDone) {
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
    }     else if (mode === "migration") {
      pop.append(el("h2", { id: "oiLibPopTitle", text: "正在搬旧库" }));
    } else if (mode === "import") renderImportPop(pop);
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
    setImport,
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
      if (doneTimer) timers.clearTimeout(doneTimer);
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
