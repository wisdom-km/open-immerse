/**
 * Mountable #data panel.
 * The settings redesign mounts this into its own shell. This file does not
 * know about the options navigation. Callers pass the root element.
 * Colors come from CSS variables in data-panel.css.
 */

import { createLibraryChip } from "../lib/library-chip.js";
import { createLibraryStore } from "../lib/library-store.js";
import { createImportCoordinator } from "../lib/import-run.js";
import { downloadBlob } from "../lib/export.js";
import { formatApproxBytes, formatQuotaLabel, formatUsageLabel } from "../lib/usage-format.js";

export function readDataFocus(hash) {
  const text = String(hash || "");
  const match = text.match(/^#?data(?:\?([^#]*))?/);
  if (!match) return null;
  return new URLSearchParams(match[1] || "").get("focus");
}

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

function button(label, className, onClick) {
  const node = el("button", { type: "button", class: className, text: label });
  node.addEventListener("click", (event) => {
    event.preventDefault();
    onClick?.(event);
  });
  return node;
}

function stamp(ms) {
  const date = new Date(ms);
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}`;
}

function dayStamp(ms) {
  const date = new Date(ms);
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}`;
}

function chipView(view) {
  if (!view) return null;
  if (view.phase === "idle" || view.phase === "rejected" || view.phase === "report") {
    if (view.phase !== "rejected") return null;
  }
  return view;
}

function downloadErrors(coordinator, deps) {
  const rows = coordinator.errorsForExport();
  const filename = `open-immerse-migrate-errors-${dayStamp(typeof deps.now === "function" ? deps.now() : Date.now())}.json`;
  const text = JSON.stringify(rows);
  if (typeof deps.download === "function") return deps.download(filename, text, rows);
  return text;
}

function routeImportCommand(coordinator, deps, command) {
  if (!coordinator) return undefined;
  if (command === "pause") return coordinator.pause();
  if (command === "resume") return coordinator.resume();
  if (command === "allow") return coordinator.allow();
  if (command === "later") return coordinator.later();
  if (command === "abandon") return coordinator.abandon();
  if (command === "retry") return coordinator.retry();
  if (command === "export-errors") return downloadErrors(coordinator, deps);
  if (command === "reselect") return deps.openData?.({ focus: "import", picker: false });
  if (command === "backup") return deps.openData?.({ focus: "export" });
  if (command === "usage") return deps.openData?.({ focus: "usage" });
  return undefined;
}

export function bindImportChip(chip, deps = {}) {
  const coordinator = deps.coordinator || createImportCoordinator(deps);
  const stop = coordinator.subscribe((view) => {
    const next = chipView(view);
    chip.setImport(next && next.phase === "rejected" ? null : next);
  });
  coordinator.attach("reader");
  const pageTarget = deps.window || globalThis;
  function onPageHide() {
    void coordinator.detach("reader");
  }
  pageTarget.addEventListener?.("pagehide", onPageHide);
  pageTarget.addEventListener?.("beforeunload", onPageHide);
  const onBus = deps.bus?.listen?.((message) => {
    if (message?.type === "migration-continue") {
      chip.setMigration({ running: true, done: message.done || 0, total: message.total || 0 });
    }
  });
  return {
    coordinator,
    async close() {
      await coordinator.detach("reader");
    },
    destroy() {
      stop();
      pageTarget.removeEventListener?.("pagehide", onPageHide);
      pageTarget.removeEventListener?.("beforeunload", onPageHide);
      onBus?.();
      void coordinator.detach("reader");
      coordinator.destroy();
    },
    command(name) {
      return routeImportCommand(coordinator, deps, name);
    }
  };
}

export function attachImportReader(host, deps = {}) {
  let binding = null;
  const chip = createLibraryChip({
    host,
    timers: deps.timers,
    doneHoldMs: deps.doneHoldMs,
    fadeMs: deps.fadeMs,
    narrow: deps.narrow,
    reducedMotion: deps.reducedMotion,
    onImportCommand(command) {
      return routeImportCommand(binding?.coordinator, deps, command);
    }
  });
  binding = bindImportChip(chip, deps);
  return {
    ...binding,
    chip,
    destroy() {
      binding.destroy();
      chip.destroy();
    }
  };
}

export function mountDataPanel(root, deps = {}) {
  if (!root) throw new Error("mountDataPanel needs a root element");
  const store = deps.store || createLibraryStore();
  const coordinator = deps.coordinator || createImportCoordinator({ ...deps, store });
  const reader = deps.chipHost ? attachImportReader(deps.chipHost, { ...deps, store }) : null;
  let view = coordinator.state();
  let usage = { loading: true, usage: null, quota: null, persisted: false };
  let migration = null;
  let sizes = { base: 0, sources: 0, trash: 0, hasSource: false, empty: true };
  let wantSource = false;
  let wantTrash = false;
  let packing = false;
  let packingPct = 0;
  let toastText = "";
  let toastTimer = 0;
  let showIgnored = false;
  let showErrors = false;
  let showMigrationErrors = false;
  const timers = deps.timers || globalThis;
  const now = () => (typeof deps.now === "function" ? deps.now() : Date.now());

  function width() {
    if (typeof deps.width === "function") return Number(deps.width()) || 0;
    return Number(root.clientWidth) || 800;
  }

  function narrow() {
    return width() > 0 && width() < 520;
  }

  function toast(text) {
    toastText = text;
    if (toastTimer) timers.clearTimeout(toastTimer);
    toastTimer = timers.setTimeout(() => {
      toastText = "";
      toastTimer = 0;
      render();
    }, deps.toastMs ?? 5000);
    render();
  }

  function focus(name) {
    const group = root.querySelector(`[data-focus-group="${name}"]`);
    const target = group?.querySelector("button, a, input, select, [tabindex]") || group;
    try {
      group?.scrollIntoView?.({ block: "start" });
    } catch {
      /* the host may not scroll */
    }
    target?.focus?.();
    return target || null;
  }

  async function loadUsage() {
    try {
      const result = typeof deps.usage === "function" ? await deps.usage() : await store.usage();
      const unavailable = !result || (result.usage == null && result.quota == null);
      usage = {
        loading: false,
        usage: result?.usage ?? null,
        quota: result?.quota ?? null,
        persisted: result?.persisted === true,
        unavailable
      };
    } catch {
      usage = { loading: false, usage: null, quota: null, persisted: false, unavailable: true };
    }
    render();
  }

  async function loadMigration() {
    try {
      migration = await store.migrationStatus();
    } catch {
      migration = null;
    }
    render();
  }

  async function loadSizes() {
    try {
      const papers = await store.listPapers();
      let sources = 0;
      let hasSource = false;
      for (const paper of papers) {
        const size = Number(paper.sourceSize) || 0;
        if (size > 0) {
          sources += size;
          hasSource = true;
        }
      }
      const plain = await store.exportLibrary({ include: { notes: true, trash: false, layouts: false, sources: false } });
      const withTrash = await store.exportLibrary({ include: { notes: true, trash: true, layouts: false, sources: false } });
      const notes = (plain.papers || []).some((item) => (item.notes || []).length > 0);
      sizes = {
        base: JSON.stringify(plain).length,
        sources,
        trash: Math.max(0, JSON.stringify(withTrash).length - JSON.stringify(plain).length),
        hasSource,
        empty: papers.length === 0 && !notes
      };
    } catch {
      sizes = { base: 0, sources: 0, trash: 0, hasSource: false, empty: true };
    }
    render();
  }

  function estimateNow() {
    if (sizes.empty) return 0;
    return sizes.base + (wantSource ? sizes.sources : 0) + (wantTrash ? sizes.trash : 0);
  }

  async function pickFolder() {
    const open = deps.showDirectoryPicker || globalThis.showDirectoryPicker;
    if (typeof open !== "function") return;
    let dir;
    try {
      dir = await open({ mode: "read" });
    } catch (error) {
      if (error?.name === "AbortError") return;
      throw error;
    }
    await coordinator.importFolder(dir);
    await loadSizes();
    await loadUsage();
  }

  async function readFile(file) {
    if (!file || file.isDirectory) return;
    const name = String(file.name || "");
    const json = /\.json$/i.test(name) || file.type === "application/json";
    if (!json) return;
    let bundle;
    try {
      const text = typeof file.text === "function" ? await file.text() : String(file.body || "");
      bundle = JSON.parse(text);
    } catch {
      view = { ...view, phase: "rejected", reject: "format", holds: true };
      render();
      return;
    }
    try {
      await coordinator.importBundle(bundle);
    } catch {
      /* the coordinator already published the refusal */
    }
    await loadSizes();
  }

  async function askPersist() {
    let granted = false;
    try {
      if (typeof deps.requestPersist === "function") granted = (await deps.requestPersist()) === true;
      else granted = (await store.retryPersist()) === true;
    } catch {
      granted = false;
    }
    usage = { ...usage, persisted: granted, loading: false };
    toast(granted ? "浏览器已同意长期保存" : "浏览器仍未同意");
  }

  async function continueMigration() {
    const status = migration || { doneDocs: [], pendingKnown: 0, errors: [] };
    const done = (status.doneDocs || []).length;
    const total = done + (Number(status.pendingKnown) || 0);
    deps.bus?.post?.({ type: "migration-continue", from: "data", done, total });
    await deps.onContinueMigration?.(status);
    render();
  }

  async function exportLibrary() {
    if (sizes.empty || packing) return;
    packing = true;
    packingPct = 0;
    render();
    try {
      const run = deps.exportLibrary || ((options) => store.exportLibrary(options));
      const bundle = await run({
        include: { notes: true, trash: wantTrash === true, layouts: false, sources: wantSource === true },
        exportedAt: now()
      });
      packingPct = 100;
      render();
      const filename = `open-immerse-library-${stamp(now())}.json`;
      const text = JSON.stringify(bundle);
      const bytes = new TextEncoder().encode(text);
      let saved = false;
      if (typeof deps.download === "function") {
        saved = (await deps.download(filename, text, bundle)) === true;
      } else {
        saved = downloadBlob(filename, new Blob([bytes], { type: "application/json" })) === true;
      }
      if (saved) toast(`已导出 · ${formatApproxBytes(bytes.length) || formatApproxBytes(text.length)}`);
    } catch (error) {
      toastText = "";
      packing = false;
      render();
      const fail = el("p", { class: "oi-data-danger", text: `没导出成功（${error?.message || "失败"}）· 重试` });
      root.querySelector('[data-focus-group="export"]')?.append(fail);
      return;
    }
    packing = false;
    render();
  }

  function row(title, body, control, extra) {
    const copy = el("div", { class: "set-copy" }, [
      el("h3", { text: title }),
      body ? el("p", { text: body }) : null
    ]);
    if (extra) copy.append(extra);
    const actions = el("div", { class: `set-actions${narrow() ? " is-block" : ""}` }, Array.isArray(control) ? control : [control]);
    return el("div", { class: "set-row" }, [copy, actions]);
  }

  function renderUsage(group) {
    const usageText = usage.loading && !usage.unavailable
      ? ""
      : (usage.unavailable ? "无法读取用量" : formatUsageLabel(usage.usage));
    const usageControl = usage.loading
      ? el("span", { class: "oi-data-skel", "aria-hidden": "true" })
      : el("span", { class: "set-value", text: usageText });
    group.append(row("文献库", "译文、笔记、原 PDF 和缓存。数字是浏览器的估算。", usageControl));
    const persistOn = usage.persisted === true;
    const persistBody = persistOn
      ? "浏览器不会自动清掉文献库。手动清除浏览数据时仍会删除。"
      : "未开启时，磁盘空间紧张浏览器可能清掉文献库。建议定期导出备份。";
    const persistControls = [
      el("span", { class: `oi-data-chip${persistOn ? " is-ok" : " is-warn"}`, text: persistOn ? "已开启" : "未开启" })
    ];
    if (!persistOn) persistControls.push(button("再申请一次", "btn-secondary", () => { void askPersist(); }));
    group.append(row("长期保存", persistBody, persistControls));
    if (!usage.unavailable && usage.quota != null) {
      group.append(row("可用空间", "浏览器分给本扩展的上限", el("span", { class: "set-value", text: formatQuotaLabel(usage.usage, usage.quota) })));
    }
    const errors = migration?.errors || [];
    const done = (migration?.doneDocs || []).length;
    const pending = Number(migration?.pendingKnown) || 0;
    const unfinished = migration && migration.finishedAt == null && (pending > 0 || done > 0);
    const broken = errors.length > 0;
    if (unfinished || broken) {
      const total = done + pending;
      const body = broken
        ? `${errors.length} 篇没搬过来，旧数据都还在原处。`
        : `还有 ${pending} 篇在旧服务里，打开阅读页时会在后台接着搬。`;
      const controls = [el("span", { class: "set-value", text: `${done} / ${total} 篇` })];
      if (broken) controls.push(button("查看", "btn-link", () => { showMigrationErrors = !showMigrationErrors; render(); }));
      else controls.push(button("现在继续", "btn-secondary", () => { void continueMigration(); }));
      const extra = showMigrationErrors ? el("div", { class: "oi-data-errors" }, errors.slice(0, 3).map((item) => el("p", { text: item.title || item.docHash || "" }))) : null;
      group.append(row("旧库迁移", body, controls, extra));
    }
  }

  function renderImport(group) {
    const phase = view.phase;
    const folder = view.folder || "旧库";
    const done = Number(view.done) || 0;
    const total = view.total == null ? null : Number(view.total);
    const count = total == null ? `${done} 篇` : `${done} / ${total} 篇`;
    const leave = `可以离开本页去阅读，导入会继续；关掉所有 Open Immerse 页面会暂停，下次打开接着导入。`;
    if ((phase === "running" || phase === "scanning") && view.source === "json") {
      group.append(row(
        "正在从导出文件导入",
        `已处理 ${count}。${leave}`,
        button("暂停", "btn-secondary", () => { void coordinator.pause(); })
      ));
      const pct = total ? Math.round((done / total) * 100) : 0;
      const fill = el("span", { "data-pct": String(pct) });
      if (fill.style) fill.style.width = `${pct}%`;
      group.append(el("div", { class: "oi-data-bar", role: "progressbar", "aria-valuenow": String(pct) }, [fill]));
      return;
    }
    if (phase === "running" || phase === "scanning") {
      const prefix = view.parentAdjusted ? "你选的是上一层，已自动改用里面的「files」文件夹。" : "";
      group.append(row(
        "正在从旧库文件夹导入",
        `${prefix}已处理 ${count}。${leave}`,
        button("暂停", "btn-secondary", () => { void coordinator.pause(); })
      ));
      const pct = total ? Math.round((done / total) * 100) : 0;
      const fill = el("span", { "data-pct": String(pct) });
      if (fill.style) fill.style.width = `${pct}%`;
      group.append(el("div", { class: "oi-data-bar", role: "progressbar", "aria-valuenow": String(pct) }, [fill]));
      return;
    }
    if (phase === "paused") {
      group.append(row("已暂停导入", `已导入的 ${done} 篇都在，可以照常读。`, button("继续", "btn-primary", () => { void coordinator.resume(); })));
      return;
    }
    if (phase === "resume") {
      const rest = total == null ? 0 : Math.max(0, total - done);
      group.append(el("h3", { text: "导入待继续" }));
      group.append(el("p", { class: "oi-data-safe", text: `已导入的 ${done} 篇都在，可以照常读。` }));
      group.append(el("p", { text: `浏览器重启后，需要你再允许一次读取「${folder}」文件夹，才能接着导入剩下的 ${rest} 篇。` }));
      group.append(el("div", { class: "set-actions" }, [
        button("以后再说", "btn-link", () => { void coordinator.later(); }),
        button("允许并继续", "btn-primary", () => { void coordinator.allow(); })
      ]));
      return;
    }
    if (phase === "incomplete" && view.source === "json") {
      const fileInput = el("input", { type: "file", accept: "application/json,.json", class: "oi-data-file" });
      fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        if (file) void readFile(file);
      });
      group.append(el("h3", { text: "导入没完成" }));
      group.append(el("p", { class: "oi-data-safe", text: `已导入的 ${done} 篇都在，可以照常读。` }));
      group.append(el("p", { text: "上次的导出文件没有导完。重新选一次这个文件就能接着导入，已经导入的会自动跳过。" }));
      group.append(el("div", { class: "set-actions" }, [
        button("不再导入", "btn-link", () => { void coordinator.abandon(); }),
        fileInput,
        button("重新选择文件…", "btn-primary", () => fileInput.click?.())
      ]));
      return;
    }
    if (phase === "incomplete") {
      group.append(el("h3", { text: "导入没完成" }));
      group.append(el("p", { class: "oi-data-safe", text: `已导入的 ${done} 篇都在，旧文件夹里的数据也没动。` }));
      group.append(el("p", { text: `读不到上次的「${folder}」文件夹了（没有允许读取，或者文件夹被移动、改名）。重新选一次就能接着导入，已导入的会自动跳过。` }));
      group.append(el("div", { class: "set-actions" }, [
        button("不再导入", "btn-link", () => { void coordinator.abandon(); }),
        button("重新选择文件夹…", "btn-primary", () => { void pickFolder(); })
      ]));
      return;
    }
    if (phase === "rejected") {
      if (view.reject === "empty") {
        group.append(el("h3", { class: "is-danger", text: "没有导入 · 空文件夹" }));
        group.append(el("p", { text: `选的「${folder}」是空的。请选旧版本机服务的 files/ 文件夹，里面是一个个论文文件夹。` }));
      } else if (view.reject === "schema") {
        group.append(el("h3", { class: "is-danger", text: "没有导入" }));
        group.append(el("p", { text: `文件来自更新版本的 Open Immerse（格式 ${view.schema}）。请先更新扩展。` }));
        return;
      } else if (view.reject === "format") {
        group.append(el("p", { class: "is-danger", text: "这不是 Open Immerse 导出的文件。" }));
        return;
      } else {
        group.append(el("h3", { class: "is-danger", text: "没有导入 · 不是旧库文件夹" }));
        group.append(el("p", { text: `「${folder}」里没找到旧库论文。旧库文件夹叫 files，里面每篇论文是一个以一长串字母和数字命名的文件夹。` }));
      }
      group.append(button("重新选择文件夹…", "btn-primary", () => { void pickFolder(); }));
      return;
    }
    if (phase === "report" || phase === "done" || phase === "error") {
      const added = view.added || 0;
      const updated = view.updated || 0;
      const skipped = view.skipped || 0;
      const failed = view.failed || 0;
      group.append(row("导入完成", `新增 ${added} · 更新 ${updated} · 跳过 ${skipped} · 失败 ${failed}`, failed > 0 ? button("查看失败", "btn-link", () => { showErrors = !showErrors; render(); }) : el("span")));
      if (!usage.persisted) {
        const warn = el("p", { class: "oi-data-warn", text: "浏览器没有同意长期保存，导入的内容可能被清掉。建议现在导出一份备份。" });
        warn.append(button("导出文献库", "btn-secondary", () => focus("export")));
        group.append(warn);
      }
      if ((view.ignored || []).length) {
        const k = view.ignored.length;
        const line = el("p", { text: `另有 ${k} 个文件或文件夹不是旧库论文，已忽略。` });
        line.append(button("查看忽略的", "btn-link", () => { showIgnored = !showIgnored; render(); }));
        group.append(line);
        if (showIgnored) {
          const names = view.ignored.slice(0, 20);
          const list = el("ul", { class: "oi-data-ignored" });
          for (const name of names) list.append(el("li", { text: name }));
          if (k > 20) list.append(el("li", { text: `还有 ${k - 20} 个` }));
          group.append(list);
        }
      }
      if (showErrors && (view.errors || []).length) {
        group.append(el("div", { class: "oi-data-errors" }, view.errors.map((item) => el("p", { text: `${item.title || item.docHash || "这篇"} · ${item.reason || ""}` }))));
      }
    }
    if (phase === "running" || phase === "resume" || phase === "incomplete" || phase === "paused" || phase === "rejected") return;
    group.append(row(
      "从旧库文件夹导入",
      "选择旧版本机服务的 files/ 文件夹。只新增和更新，不删除；同一篇以较新的版本为准。不用安装任何东西。",
      button("选择文件夹…", `btn-secondary${narrow() ? " is-block" : ""}`, () => { void pickFolder(); })
    ));
    const fileInput = el("input", { type: "file", accept: "application/json,.json", class: "oi-data-file" });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) void readFile(file);
    });
    group.append(row(
      "从导出文件导入",
      "Open Immerse 导出的文献库或笔记文件（.json）。",
      [button("选择文件…", "btn-secondary", () => fileInput.click?.()), fileInput]
    ));
    group.addEventListener("dragover", (event) => {
      event.preventDefault?.();
    });
    group.addEventListener("drop", (event) => {
      event.preventDefault?.();
      const transfer = event.dataTransfer;
      const item = transfer?.items?.[0];
      const entry = item?.webkitGetAsEntry?.();
      if (entry?.isDirectory) return;
      const file = transfer?.files?.[0];
      if (!file || file.isDirectory) return;
      void readFile(file);
    });
  }

  function renderExport(group) {
    group.append(row("译文和笔记", "每次都包含", el("span", { class: "oi-data-chip is-off", text: "始终包含" })));
    if (sizes.hasSource) {
      const box = el("input", { type: "checkbox" });
      box.checked = wantSource;
      box.addEventListener("change", () => {
        wantSource = box.checked === true;
        render();
      });
      group.append(row("原 PDF", "体积大，默认不带", [
        el("span", { class: "set-value", text: `+ 约 ${formatApproxBytes(sizes.sources)}` }),
        box
      ]));
    }
    const trashBox = el("input", { type: "checkbox" });
    trashBox.checked = wantTrash;
    trashBox.addEventListener("change", () => {
      wantTrash = trashBox.checked === true;
      render();
    });
    group.append(row("回收站里的笔记", "", [
      el("span", { class: "set-value", text: `+ 约 ${formatApproxBytes(sizes.trash)}` }),
      trashBox
    ]));
    const estimate = sizes.empty ? "预计 0 MB" : `预计约 ${formatApproxBytes(estimateNow())}`;
    const hint = sizes.empty
      ? "文献库是空的，打开并翻译一篇论文后才能导出。"
      : "版面缓存可以重算，不导出。API 密钥和设置不在这个文件里。";
    const exportButton = button(
      packing ? `正在打包… ${packingPct}%` : "导出文献库",
      `btn-primary${narrow() ? " is-block" : ""}`,
      () => { void exportLibrary(); }
    );
    if (sizes.empty || packing) exportButton.disabled = true;
    group.append(row(estimate, hint, exportButton));
  }

  function render() {
    if (!globalThis.document?.createElement) return;
    const scrolled = root.scrollTop;
    root.replaceChildren();
    root.classList.add("oi-data");
    root.classList.toggle("is-narrow", narrow());
    root.setAttribute("data-narrow", narrow() ? "1" : "0");
    root.append(el("p", { class: "oi-data-lead", text: "文献库、笔记和设置都只存在这台电脑上。API 密钥永远不导出。" }));
    const usageGroup = el("section", { class: "set-group", "data-focus-group": "usage" }, [el("h2", { text: "存储用量" })]);
    const importGroup = el("section", { class: "set-group", "data-focus-group": "import" }, [el("h2", { text: "文献库 · 导入" })]);
    const exportGroup = el("section", { class: "set-group", "data-focus-group": "export" }, [el("h2", { text: "文献库 · 导出" })]);
    renderUsage(usageGroup);
    renderImport(importGroup);
    renderExport(exportGroup);
    root.append(usageGroup, importGroup, exportGroup);
    if (toastText) root.append(el("p", { class: "oi-data-toast", role: "status", text: toastText }));
    root.scrollTop = scrolled;
  }

  const stop = coordinator.subscribe((next) => {
    view = next || coordinator.state();
    render();
  });
  coordinator.attach("data");
  const pageTarget = deps.window || globalThis;
  function onPageHide() {
    void coordinator.detach("data");
  }
  pageTarget.addEventListener?.("pagehide", onPageHide);
  pageTarget.addEventListener?.("beforeunload", onPageHide);
  render();
  void loadUsage();
  void loadMigration();
  void loadSizes();
  if (deps.focus) {
    focus(deps.focus);
    if (deps.history && typeof deps.history.replaceState === "function") {
      deps.history.replaceState(null, "", deps.hash || "#data");
    }
  }

  return {
    coordinator,
    reader,
    focus,
    state: () => coordinator.state(),
    async closeData() {
      await coordinator.detach("data");
    },
    async closeReader() {
      if (reader) await reader.close();
    },
    async closeAll() {
      await coordinator.detach("data");
      if (reader) await reader.close();
    },
    destroy() {
      stop();
      pageTarget.removeEventListener?.("pagehide", onPageHide);
      pageTarget.removeEventListener?.("beforeunload", onPageHide);
      if (toastTimer) timers.clearTimeout(toastTimer);
      coordinator.destroy();
      reader?.destroy?.();
    },
    reload() {
      return Promise.all([loadUsage(), loadMigration(), loadSizes()]);
    }
  };
}
