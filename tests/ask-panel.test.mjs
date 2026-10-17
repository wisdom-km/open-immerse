// F6a Ask panel states. linkedom only — the send hook is a fake provider.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { askTarget } from "../lib/ask-model.js";
import { BID_VERSION, blockSrcHash } from "../lib/pdf-block-id.js";
import { firstLineQuote, noteMatchesFilter } from "../lib/notes-view-model.js";
import { createNotesStore } from "../lib/notes-store.js";
import { mountAskUi } from "../pdf/ask-panel.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "pdf/ask-panel.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const toolbar = readFileSync(join(root, "lib/pdf-sel-toolbar.js"), "utf8");

const llm = {
  provider: "openai",
  providers: { openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", apiKey: "sk-translate" } }
};
const mm = {
  multimodal: { provider: "openai", apiKey: "sk-mm-secret", model: "gpt-4o", baseUrl: "https://api.openai.com/v1" }
};

function installDom() {
  const parsed = parseHTML(`<!doctype html><html><body>
    <button id="askButton" type="button">问 AI</button>
    <button id="notesButton" type="button">笔记</button>
    <div class="workspace" data-source-mode="side">
      <div id="sideSlot"></div>
      <div id="readerFlow" class="reader-flow">
        <div class="rf-block" data-bid="b3" data-src-page="4" data-label="text"><div class="rf-zh">我们怀疑当 d_k 较大时。</div></div>
      </div>
    </div>
  </body></html>`);
  globalThis.document = parsed.document;
  globalThis.window = parsed.window;
  globalThis.HTMLElement = parsed.window.HTMLElement;
  globalThis.Node = parsed.window.Node;
  globalThis.Event = parsed.window.Event;
  globalThis.KeyboardEvent = parsed.window.KeyboardEvent;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  let active = parsed.document.body;
  parsed.window.HTMLElement.prototype.focus = function focus() { active = this; };
  Object.defineProperty(parsed.document, "activeElement", {
    configurable: true,
    get() { return active; }
  });
  return parsed;
}

function harness(options = {}) {
  installDom();
  const sent = [];
  const notes = [];
  const toasts = [];
  const settingsOpens = [];
  const opens = [];
  let formula = options.formula === undefined ? mm : options.formula;
  let settings = options.settings || llm;
  let confirm = options.confirm !== false;
  let saveError = options.saveError === true;
  let saveGate = null;
  const ui = mountAskUi({
    chrome: options.chrome,
    hasDoc: () => true,
    width: () => options.width || 1440,
    flow: () => document.getElementById("readerFlow"),
    blocks: () => [
      { bid: "b2", page: 4, text: "输入由维度为 d_k 的查询和键组成。" },
      { bid: "b3", page: 4, text: "我们怀疑当 d_k 较大时。" },
      { bid: "b4", page: 4, text: "乘以 1/√d_k。" }
    ],
    currentCitation: () => (Object.prototype.hasOwnProperty.call(options, "currentCitation")
      ? options.currentCitation
      : { bid: "b3", page: 4, kind: "text", text: "我们怀疑当 d_k 较大时。" }),
    docHash: () => options.docHash || "doc-attn",
    readRoute: async () => {
      const target = askTarget(settings, formula);
      const apiKey = target?.via === "multimodal"
        ? String(formula?.multimodal?.apiKey || "")
        : String(settings?.providers?.[target?.provider]?.apiKey || "");
      return { settings, target, apiKey };
    },
    readConfirm: async () => confirm,
    writeConfirm: async (value) => { confirm = value !== false; },
    send: async (req) => {
      sent.push(req);
      if (options.send) return options.send(req);
      if (options.fail) return options.fail(req);
      return { ok: true, status: 200, body: options.answer || "点积要除以 $\\sqrt{d_k}$。" };
    },
    saveNote: async (input, saveOptions) => {
      if (options.backend) return options.backend.save(input, saveOptions);
      if (saveGate) await saveGate;
      if (saveOptions?.signal?.aborted) return null;
      if (saveError) throw new Error("disk");
      const id = input.id || `note-${notes.length + 1}`;
      const prior = notes.find((note) => note.id === id || (input.qa?.turnId && note.qa?.turnId === input.qa.turnId));
      if (prior) return prior;
      const note = { ...input, id };
      if (!note.author || !note.body || !note.qa?.turnId) throw new Error("partial");
      notes.push(note);
      return note;
    },
    listNotes: async () => (options.backend
      ? options.backend.list(options.docHash || "doc-attn")
      : notes.slice()),
    durableNoteIds: () => (options.backend ? options.backend.durableIds() : null),
    anchorFor: async (citation) => {
      if (!citation?.bid) return null;
      const quote = firstLineQuote(citation.text || "");
      return {
        anchor: {
          bid: citation.bid,
          bidV: BID_VERSION,
          page: Number(citation.page) || 0,
          srcHash: blockSrcHash(citation.text || ""),
          quote,
          offset: { start: 0, end: quote.length },
          quoteSrc: { quote, prefix: "", suffix: "" },
          srcRects: [[0, 0, 12, 8]]
        },
        anchorState: { status: "exact", layoutRev: "layout-1", checkedAt: 0 }
      };
    },
    revealNote: async (id) => ({ ok: true, id }),
    showSource: (citation) => { options.onSource?.(citation); },
    openSettings: (href) => settingsOpens.push(href),
    toast: (text) => toasts.push(text),
    writeText: async (text) => { options.copied = text; },
    onOpenChange: (open, meta) => opens.push({ open, meta }),
    actionWidth: options.actionWidth,
    schedule: options.schedule,
    cancel: options.cancel,
    waitMs: options.waitMs,
    timeoutMs: options.timeoutMs
  });
  return {
    ui,
    sent,
    notes,
    toasts,
    settingsOpens,
    opens,
    get confirm() { return confirm; },
    holdSave() {
      let release;
      saveGate = new Promise((done) => { release = done; });
      return () => {
        saveGate = null;
        release();
      };
    },
    set saveError(value) { saveError = value === true; },
    set formula(value) { formula = value; },
    set settings(value) { settings = value; },
    get settings() { return settings; }
  };
}

async function typeAndSend(ui, text) {
  await ui.open();
  const area = ui.root.querySelector("textarea");
  area.value = text;
  area.dispatchEvent(new Event("input"));
  ui.session.draft = text;
  return ui.submit({ confirmed: true });
}

test("F6UI core: unconfigured, one answer, copy, save stays, view notes leaves", async () => {
  const box = harness({ formula: { multimodal: { provider: "", apiKey: "" } }, settings: { provider: "mymemory", providers: {} } });
  await box.ui.open();
  assert.match(box.ui.root.textContent, /未配置模型/);
  assert.equal(box.ui.root.querySelector("textarea").disabled, true);
  box.ui.root.querySelector(".oi-ask-go").click();
  assert.match(box.settingsOpens.at(-1), /#mm$/);
  assert.equal(box.ui.root.textContent.includes("问整页"), false);

  box.formula = mm;
  box.settings = llm;
  await box.ui.refreshRoute();
  assert.match(box.ui.root.textContent, /边读边问/);
  assert.match(box.ui.root.textContent, /多模态 · gpt-4o/);
  assert.equal(box.ui.root.querySelector("select"), null);

  globalThis.katex = {
    renderToString(tex, opts) {
      assert.equal(opts.trust, false);
      assert.equal(opts.throwOnError, false);
      return `<span class="katex">${tex}</span>`;
    }
  };
  const done = await typeAndSend(box.ui, "为什么除以 √d_k？");
  assert.equal(done.turn.status, "done");
  assert.equal(box.sent.length, 1);
  assert.equal(box.sent[0].via, "multimodal");
  assert.match(JSON.stringify(box.sent[0].messages), /d_k 的查询和键/);
  assert.equal(JSON.stringify(box.sent[0].messages).includes("FULLPAGE"), false);
  assert.equal(JSON.stringify(box.ui.session).includes("sk-mm-secret"), false);
  const answer = box.ui.root.querySelector(".oi-ask-answer");
  assert.match(answer.innerHTML, /class="katex"/);
  assert.equal(answer.textContent.includes("$\\sqrt"), false);
  const actions = box.ui.root.querySelector(".oi-ask-actions");
  assert.deepEqual([...actions.querySelectorAll(".oi-ask-act-text")].map((node) => node.textContent), ["复制", "添加到笔记"]);
  assert.equal(actions.querySelector(".oi-ask-disclaimer"), null);
  assert.equal(actions.nextElementSibling?.className, "oi-ask-disclaimer");
  assert.equal(actions.nextElementSibling.textContent, "模型回答，可能有误");
  actions.querySelector("[data-ask-act='copy']").click();
  await Promise.resolve();
  assert.match(box.ui.session.turns[0].answer, /sqrt/);

  const openCount = box.opens.length;
  actions.querySelector("[data-ask-act='save']").click();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(box.ui.isOpen(), true);
  assert.equal(box.opens.length, openCount);
  assert.equal(box.notes[0].author, "ai");
  assert.equal(box.notes[0].qa.model, "gpt-4o");
  assert.equal(box.notes[0].kind, "note");
  assert.equal(box.notes[0].anchor.bid, "b3");
  assert.equal(box.notes[0].anchorState.status, "exact");
  assert.equal(noteMatchesFilter(box.notes[0], "ai"), true);
  const added = box.ui.root.querySelector("[data-ask-act='added']");
  assert.equal(added.getAttribute("aria-label"), "✓ 已添加");
  assert.equal(added.disabled, false);
  assert.equal(added.getAttribute("aria-disabled"), "true");
  assert.equal(document.activeElement?.getAttribute("data-ask-act"), "view");
  const view = box.ui.root.querySelector("[data-ask-act='view']");
  assert.equal(view.textContent.includes("查看笔记"), true);
  assert.equal(view.className.includes("is-view"), true);
  added.click();
  assert.equal(box.ui.isOpen(), true);
  view.click();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(box.ui.isOpen(), false);
  assert.equal(box.opens.at(-1).meta.handoff, true);
});

test("F6UI-14 multimodal 500 does not call the translation host", async () => {
  const box = harness({
    fail: async (req) => ({ ok: false, status: 500 })
  });
  await typeAndSend(box.ui, "会失败吗");
  assert.equal(box.sent.length, 1);
  assert.equal(box.sent[0].host, "api.openai.com");
  assert.equal(box.sent[0].model, "gpt-4o");
  const err = box.ui.root.querySelector(".oi-ask-err");
  assert.match(err.textContent, /多模态模型调用失败（500）/);
  assert.equal((err.textContent.match(/调用失败（500）/g) || []).length, 1);
  assert.equal((err.textContent.match(/500/g) || []).length, 1);
  assert.match(err.textContent, /重试/);
  assert.match(err.textContent, /去设置/);
  assert.equal(/改用翻译|回退/.test(err.textContent), false);
  assert.equal(box.ui.root.querySelector("textarea").value, "会失败吗");
  assert.match(box.ui.root.querySelector(".oi-ask-chip").textContent, /第4页|引用/);
  const body = JSON.stringify(box.sent[0].messages);
  err.querySelector("button").click();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(box.sent.length, 2);
  assert.equal(JSON.stringify(box.sent[1].messages), body);
  assert.equal(box.sent[1].via, "multimodal");
});

test("cited answer saves an anchored note that the AI filter can see", async () => {
  const box = harness();
  await typeAndSend(box.ui, "带引用存笔记");
  const saved = await box.ui.saveNote(box.ui.session.turns[0]);
  assert.equal(saved.ok, true);
  const note = box.notes[0];
  assert.equal(note.kind, "note");
  assert.equal(note.anchor.bid, "b3");
  assert.match(note.anchor.quote, /d_k/);
  assert.equal(note.anchorState.status, "exact");
  assert.equal(noteMatchesFilter(note, "ai"), true);
  const added = box.ui.root.querySelector("[data-ask-act='added']");
  const before = box.notes.length;
  added.click();
  assert.equal(box.notes.length, before);
  assert.equal(document.activeElement?.getAttribute("data-ask-act"), "view");
});

test("a route change clears the stale failure mark", async () => {
  const listeners = [];
  const chrome = { storage: { onChanged: { addListener(fn) { listeners.push(fn); } } } };
  const box = harness({
    chrome,
    fail: async () => ({ ok: false, status: 500 })
  });
  await typeAndSend(box.ui, "失败后换路由");
  assert.match(box.ui.root.querySelector(".oi-ask-model").textContent, /上次失败/);
  box.formula = { multimodal: { provider: "", apiKey: "" } };
  listeners[0]({ formulaSettings: { newValue: {} } }, "local");
  await new Promise((done) => setTimeout(done, 0));
  const chip = box.ui.root.querySelector(".oi-ask-model").textContent;
  assert.match(chip, /翻译模型/);
  assert.equal(chip.includes("上次失败"), false);
});

test("narrow sheet stacks above the page capsule and the back control stays one line", async () => {
  const box = harness({ width: 860 });
  await box.ui.open();
  const back = box.ui.root.querySelector("[data-ask='back']");
  assert.equal(back.hidden, false);
  assert.equal(back.classList.contains("oi-ask-back"), true);
  assert.equal(back.textContent, "← 返回译文");
  assert.match(css, /\.oi-ask-back\s*\{[^}]*width:\s*auto/);
  assert.match(css, /\.oi-ask-back\s*\{[^}]*white-space:\s*nowrap/);
  const sheet = css.slice(css.indexOf("@media (max-width: 899px)"));
  assert.match(sheet, /:not\(\[data-layout="3"\]\):not\(\[data-layout="pair"\]\)\s*>\s*#sideSlot/);
  assert.match(sheet, /z-index:\s*40/);
});

test("F6UI-10 custom engine is the unconfigured state", async () => {
  const box = harness({
    formula: {},
    settings: { provider: "custom", providers: { custom: { url: "https://example.test/translate" } } }
  });
  await box.ui.open();
  assert.match(box.ui.root.textContent, /未配置模型/);
  assert.match(box.ui.root.textContent, /自定义引擎/);
  assert.equal(box.ui.root.querySelector("textarea").disabled, true);
});

test("F6UI-13 storage change swaps the chip and leaves the in-flight request", async () => {
  let release;
  const gate = new Promise((done) => { release = done; });
  const listeners = [];
  const chrome = { storage: { onChanged: { addListener(fn) { listeners.push(fn); } } } };
  const box = harness({
    chrome,
    send: async (req) => {
      await gate;
      return { ok: true, status: 200, body: "晚到" };
    }
  });
  const pending = typeAndSend(box.ui, "飞行中");
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(box.sent[0].via, "multimodal");
  box.formula = { multimodal: { provider: "", apiKey: "" } };
  listeners[0]({ formulaSettings: { newValue: {} } }, "local");
  await new Promise((done) => setTimeout(done, 0));
  assert.match(box.toasts.join("\n"), /问 AI 改用翻译模型/);
  assert.equal(box.sent.length, 1);
  assert.equal(box.sent[0].model, "gpt-4o");
  release();
  await pending;
  assert.equal(box.ui.session.turns[0].route.via, "multimodal");
});

test("F6UI-33/34 action row is one nowrap line and collapses to icons under 280", () => {
  assert.match(css, /\.oi-ask-actions\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.oi-ask-actions\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(css, /\.oi-ask-actions\s*\{[^}]*gap:\s*4px/);
  assert.match(css, /\.oi-ask-actions\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.oi-ask-act\s*\{[^}]*height:\s*28px/);
  assert.match(css, /\.oi-ask-act\s*\{[^}]*padding:\s*0 10px/);
  assert.match(css, /\.oi-ask-act\s*\{[^}]*border-radius:\s*7px/);
  assert.match(css, /\.oi-ask-act\s*\{[^}]*font:\s*500 12px\/28px/);
  assert.match(css, /\.oi-ask-act\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.oi-ask button\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /\.oi-ask-act\.is-added\s*\{[^}]*width:\s*98px/);
  assert.match(css, /\.oi-ask-act\.is-added\s*\{[^}]*opacity:\s*1/);
  assert.match(css, /\.oi-ask-act\.is-added\s*\{[^}]*color:\s*var\(--oi-reader-mine\)/);
  assert.match(css, /\.oi-ask-act\.is-view\s*\{[^}]*color:\s*var\(--oi-reader-ai\)/);
  assert.match(css, /\.oi-ask-act\.is-added:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-reader-focus\)/);
  assert.equal(/\.oi-ask-act\.is-added:focus\s*\{[^}]*outline:\s*none/.test(css), false);
  assert.match(css, /@container oi-ask-bubble \(max-width:\s*279px\)/);
  assert.match(css, /\.oi-ask-disclaimer\s*\{[^}]*font-size:\s*11px/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.equal(css.includes("已写入本机笔记"), false);
  assert.equal(viewer.includes("问整页"), false);
  assert.match(toolbar, /label: "问 AI"/);
  assert.equal(toolbar.includes('label: "提问"'), false);
  const askHandler = viewer.slice(viewer.indexOf('id: "ask"'), viewer.indexOf('id: "highlight"'));
  assert.match(askHandler, /问 AI/);
  assert.match(askHandler, /enabled: \(\) => Boolean\(pdfDoc\)/);
});

test("F6UI-34 narrow row keeps accessible names", async () => {
  const box = harness();
  await typeAndSend(box.ui, "窄栏");
  const row = box.ui.root.querySelector(".oi-ask-actions");
  row.dataset.icons = "1";
  for (const button of row.querySelectorAll(".oi-ask-act")) {
    assert.ok(button.getAttribute("aria-label"));
    assert.equal(button.getAttribute("title"), button.getAttribute("aria-label"));
  }
  assert.match(css, /\.oi-ask-actions\[data-icons="1"\] \.oi-ask-act-text/);
  assert.match(css, /\.oi-ask-actions\[data-icons="1"\] \.oi-ask-act[\s\S]*width:\s*28px/);
});

test("stop keeps partial text and escape stops before close", async () => {
  let release;
  const gate = new Promise((done) => { release = done; });
  const box = harness({
    send: async (req) => {
      await gate;
      return { ok: true, status: 200, body: "不该落地" };
    }
  });
  const pending = typeAndSend(box.ui, "停");
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(box.ui.root.querySelector("[data-ask='stop']") != null, true);
  assert.equal(box.ui.consumeEscape(), true);
  assert.match(box.ui.root.textContent, /已停止/);
  assert.equal(box.ui.isOpen(), true);
  release();
  await pending;
  assert.equal(box.ui.session.turns[0].status, "stopped");
  assert.equal(box.ui.consumeEscape(), true);
  assert.equal(box.ui.isOpen(), false);
});

function declaredWidth(block, prop) {
  const hit = String(block || "").match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return hit ? hit[1].trim() : "";
}

test("save and added actions declare 98px, not 96px", () => {
  const added = css.match(/\.oi-ask-act\.is-added\s*\{([^}]*)\}/);
  const save = css.match(/\.oi-ask-act\.is-save\s*\{([^}]*)\}/);
  assert.ok(added && save);
  assert.equal(declaredWidth(added[1], "width"), "98px");
  assert.equal(declaredWidth(added[1], "min-width"), "98px");
  assert.equal(declaredWidth(save[1], "min-width"), "98px");
});

test("readRoute uses the multimodal key only on that route", async () => {
  const translateSettings = {
    provider: "openai",
    providers: { openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", apiKey: "sk-route-translate" } }
  };
  const translate = harness({
    formula: { multimodal: { provider: "", apiKey: "" } },
    settings: translateSettings
  });
  await translate.ui.open();
  translate.ui.session.draft = "翻译密钥";
  await translate.ui.submit({ confirmed: true });
  assert.equal(translate.sent[0].via, "translation");
  assert.equal(translate.sent[0].apiKey, "sk-route-translate");

  const multi = harness({
    formula: mm,
    settings: translateSettings
  });
  await multi.ui.open();
  multi.ui.session.draft = "多模态密钥";
  await multi.ui.submit({ confirmed: true });
  assert.equal(multi.sent[0].via, "multimodal");
  assert.equal(multi.sent[0].apiKey, "sk-mm-secret");
});

test("anchorFor keeps the viewer block-anchor fields and a first-line quote", async () => {
  const box = harness({
    currentCitation: { bid: "b3", page: 4, kind: "text", text: "第一行有锚\n第二行不进 quote" }
  });
  await typeAndSend(box.ui, "多行引用");
  await box.ui.saveNote(box.ui.session.turns[0]);
  const anchor = box.notes[0].anchor;
  assert.equal(anchor.quote, "第一行有锚");
  assert.equal(anchor.bidV, BID_VERSION);
  assert.equal(anchor.srcHash, blockSrcHash("第一行有锚\n第二行不进 quote"));
  assert.deepEqual(anchor.offset, { start: 0, end: anchor.quote.length });
  assert.equal(anchor.quoteSrc.quote, "第一行有锚");
  assert.equal(Array.isArray(anchor.srcRects) && anchor.srcRects.length > 0, true);
  assert.equal(noteMatchesFilter(box.notes[0], "ai"), true);
});

test("first send confirms once, then stays quiet", async () => {
  const box = harness();
  await box.ui.open();
  box.ui.session.draft = "确认一下";
  const held = await box.ui.submit();
  assert.equal(held.reason, "confirm");
  assert.equal(box.sent.length, 0);
  const quiet = box.ui.root.querySelector("[data-ask='quiet']");
  quiet.checked = true;
  box.ui.root.querySelector("[data-ask='confirm-send']").click();
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(box.sent.length, 1);
  assert.equal(box.confirm, false);
  box.ui.session.draft = "第二次";
  await box.ui.submit();
  assert.equal(box.sent.length, 2);
  assert.equal(box.ui.root.querySelector(".oi-ask-confirm"), null);
});

test("save failure toasts 没有写入笔记 and retry of the same turn does not duplicate", async () => {
  const box = harness({ saveError: true });
  await typeAndSend(box.ui, "先写好");
  await typeAndSend(box.ui, "写失败");
  const kept = box.ui.session.turns[0];
  const turn = box.ui.session.turns[1];
  const sibling = { status: kept.status, answer: kept.answer, noteId: kept.noteId, question: kept.question };
  const failedAnswer = turn.answer;
  const first = await box.ui.saveNote(turn);
  assert.equal(first.ok, false);
  assert.match(box.toasts.join("\n"), /没有写入笔记/);
  assert.equal(turn.noteId, "");
  assert.equal(turn.saving, false);
  assert.equal(turn.status, "done");
  assert.equal(box.notes.length, 0);
  assert.equal(kept.status, sibling.status);
  assert.equal(kept.answer, sibling.answer);
  assert.equal(kept.noteId, sibling.noteId);
  assert.equal(kept.question, sibling.question);
  assert.equal(kept.question, "先写好");
  box.saveError = false;
  const savedSibling = await box.ui.saveNote(kept);
  assert.equal(savedSibling.ok, true);
  assert.equal(box.notes.length, 1);
  assert.equal(box.notes[0].qa.turnId, kept.id);
  assert.equal(turn.noteId, "");
  assert.equal(turn.answer, failedAnswer);
  assert.equal(turn.status, "done");
  const saved = await box.ui.saveNote(turn);
  assert.equal(saved.ok, true);
  const again = await box.ui.saveNote(turn);
  assert.equal(again.reason, "exists");
  assert.equal(box.notes.length, 2);
  assert.equal(box.notes.filter((note) => note.qa.turnId === turn.id).length, 1);
  assert.equal(box.notes.filter((note) => note.qa.turnId === kept.id).length, 1);
  assert.equal(kept.noteId, savedSibling.noteId);
  assert.equal(kept.answer, sibling.answer);
  assert.equal(box.notes.find((note) => note.qa.turnId === turn.id).author, "ai");
  assert.ok(box.notes.find((note) => note.qa.turnId === turn.id).body);
});

test("pagehide during an in-flight request drops the late answer", async () => {
  let release;
  const gate = new Promise((done) => { release = done; });
  const box = harness({
    send: async () => {
      await gate;
      return { ok: true, status: 200, body: "不该落地" };
    }
  });
  const pending = typeAndSend(box.ui, "飞行中");
  await new Promise((done) => setTimeout(done, 0));
  assert.ok(box.ui.session.flight);
  assert.equal(box.ui.session.turns[0].status, "pending");
  const draft = box.ui.session.draft;
  try {
    window.dispatchEvent(new Event("pagehide"));
    assert.equal(box.ui.session.flight, null);
    assert.equal(box.ui.session.turns[0].status, "stopped");
  } finally {
    release();
  }
  const settled = await pending;
  assert.equal(settled.stale, true);
  assert.equal(box.ui.session.turns[0].status, "stopped");
  assert.notEqual(box.ui.session.turns[0].answer, "不该落地");
  assert.equal(box.ui.session.draft, draft);
  assert.equal(box.ui.session.draft, "飞行中");
});

test("pagehide before a note write lands leaves no note and a later save writes one", async () => {
  const box = harness();
  await typeAndSend(box.ui, "写入中");
  const turn = box.ui.session.turns[0];
  const release = box.holdSave();
  const pending = box.ui.saveNote(turn);
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(turn.saving, true);
  assert.equal(box.notes.length, 0);
  try {
    window.dispatchEvent(new Event("pagehide"));
    assert.equal(turn.saving, false);
  } finally {
    release();
  }
  const dropped = await pending;
  assert.equal(dropped.ok, false);
  assert.equal(box.notes.length, 0);
  assert.equal(turn.noteId, "");
  assert.equal(turn.saving, false);
  assert.equal(turn.status, "done");
  assert.ok(turn.answer);
  const saved = await box.ui.saveNote(turn);
  assert.equal(saved.ok, true);
  assert.equal(box.notes.length, 1);
  const note = box.notes[0];
  assert.equal(note.author, "ai");
  assert.equal(note.qa.turnId, turn.id);
  assert.equal(note.body, turn.answer);
  assert.ok(note.id);
  const again = await box.ui.saveNote(turn);
  assert.equal(again.reason, "exists");
  assert.equal(box.notes.length, 1);
});

test("no-anchor answer is a paper note and repeat saves do not multiply", async () => {
  const box = harness({ currentCitation: null });
  await box.ui.open();
  box.ui.session.citation = null;
  box.ui.session.draft = "没有锚点";
  await box.ui.submit({ confirmed: true });
  await box.ui.saveNote(box.ui.session.turns[0]);
  assert.equal(box.notes[0].kind, "paperNote");
  assert.equal(box.notes[0].anchor, null);
  assert.equal(box.ui.isOpen(), true);
});

test("a removed chip still anchors the note to the paragraph current at send", async () => {
  const box = harness();
  await box.ui.open();
  box.ui.session.citation = null;
  box.ui.session.draft = "去掉引用";
  await box.ui.submit({ confirmed: true });
  await box.ui.saveNote(box.ui.session.turns[0]);
  assert.equal(box.notes[0].kind, "note");
  assert.equal(box.notes[0].anchor.bid, "b3");
  assert.equal(box.ui.isOpen(), true);
});

test("cited sentence uses the ai outline class", async () => {
  const box = harness();
  await box.ui.askCitation({ bid: "b3", page: 4, kind: "text", text: "我们怀疑当 d_k 较大时。" }, { fresh: true });
  const block = document.querySelector("[data-bid='b3']");
  assert.equal(block.classList.contains("is-ask-cite"), true);
  assert.match(css, /\.rf-block\.is-ask-cite\s*\{[^}]*outline:\s*2px solid var\(--oi-reader-ai\)/);
});

test("preview line matches the request and suggestions do not send", async () => {
  const box = harness();
  await box.ui.askCitation({ bid: "b3", page: 4, kind: "formula", text: "E=mc^2", image: "data:image/png;base64,QUJD" }, { fresh: true });
  const preview = box.ui.root.querySelector("[data-ask='preview-line']").textContent;
  assert.match(preview, /附近 2 段/);
  assert.equal(preview.includes("历史"), false);
  assert.equal(preview.includes("裁图"), false);
  box.ui.root.querySelector(".oi-ask-suggest button").click();
  assert.equal(box.sent.length, 0);
  assert.match(box.ui.root.querySelector("textarea").value, /这段在说什么/);
  await box.ui.submit({ confirmed: true });
  const blob = JSON.stringify(box.sent[0].messages);
  assert.equal(blob.includes("QUJD"), false);
  assert.equal(blob.includes("image_url"), false);
  assert.equal(blob.includes("inline_data"), false);
  assert.match(blob, /E=mc\^2/);
  assert.equal(blob.includes("FULLPAGE"), false);
  const user = box.sent[0].messages.filter((item) => item.role === "user").pop().content;
  const sentNear = (user.split("附近段落：\n")[1] || "").split("\n\n问题：")[0];
  const sentCount = sentNear.split("\n\n").map((part) => part.trim()).filter(Boolean).length;
  assert.equal(sentCount, 2);
  assert.match(preview, new RegExp(`附近 ${sentCount} 段`));
  assert.equal(box.sent[0].messages.filter((item) => item.role === "assistant").length, 0);
  assert.match(box.ui.root.textContent, /不看图/);
  assert.equal(box.ui.root.textContent.includes("裁图"), false);
  const after = box.ui.root.querySelector("[data-ask='preview-line']").textContent;
  assert.equal(after.includes("裁图"), false);
  assert.match(after, /历史 1 轮/);
  assert.match(after, /附近 2 段/);
  box.ui.session.draft = "追问一句";
  await box.ui.submit({ confirmed: true });
  const second = box.sent[1].messages;
  const assistants = second.filter((item) => item.role === "assistant").length;
  assert.equal(assistants, 1);
  assert.match(after, new RegExp(`历史 ${assistants} 轮`));
  const user2 = second.filter((item) => item.role === "user").pop().content;
  assert.match(user2, /追问一句/);
  assert.match(user2, /E=mc\^2/);
  assert.match(user2, /输入由维度/);
  assert.match(user2, /乘以/);
});

function persistentNotes() {
  const store = createNotesStore({ memory: true, persist: false });
  const volatile = new Map();
  const backend = {
    writes: 0,
    fail: 0,
    async save(input) {
      backend.writes += 1;
      volatile.set(input.id, { ...input });
      if (backend.fail > 0) {
        backend.fail -= 1;
        const error = new Error("QuotaExceededError");
        error.name = "QuotaExceededError";
        throw error;
      }
      volatile.delete(input.id);
      return store.put(input);
    },
    async list(docHash) {
      const rows = await store.list(docHash);
      const extra = [...volatile.values()].filter((note) => note.docHash === docHash && !rows.some((row) => row.id === note.id));
      return rows.concat(extra);
    },
    durableIds() {
      return new Set(store.notes.keys());
    },
    reload() {
      volatile.clear();
    },
    store
  };
  return backend;
}

test("reload then ask and save keeps both notes", async () => {
  const backend = persistentNotes();
  const first = harness({ backend, docHash: "bdfaa68d89", answer: "回答甲" });
  await typeAndSend(first.ui, "第一问");
  const saved = await first.ui.saveNote(first.ui.session.turns[0]);
  assert.equal(saved.ok, true);
  assert.equal(backend.store.notes.size, 1);
  const firstId = first.ui.session.turns[0].id;
  backend.reload();
  const second = harness({ backend, docHash: "bdfaa68d89", answer: "回答乙" });
  await typeAndSend(second.ui, "第二问");
  const again = await second.ui.saveNote(second.ui.session.turns[0]);
  assert.equal(again.ok, true);
  assert.notEqual(second.ui.session.id, first.ui.session.id);
  assert.notEqual(second.ui.session.turns[0].id, firstId);
  assert.equal(backend.store.notes.size, 2);
  const notes = await backend.store.list("bdfaa68d89");
  assert.deepEqual(new Set(notes.map((note) => note.body)), new Set(["回答甲", "回答乙"]));
  assert.equal(new Set(notes.map((note) => note.id)).size, 2);
});

test("a save in another document keeps the first document's note", async () => {
  const backend = persistentNotes();
  const attention = harness({ backend, docHash: "bdfaa68d89", answer: "回答甲" });
  await typeAndSend(attention.ui, "Attention");
  await attention.ui.saveNote(attention.ui.session.turns[0]);
  const kept = [...backend.store.notes.values()][0];
  backend.reload();
  const dpo = harness({ backend, docHash: "92cb3a2b71", answer: "回答乙" });
  await typeAndSend(dpo.ui, "DPO");
  const saved = await dpo.ui.saveNote(dpo.ui.session.turns[0]);
  assert.equal(saved.ok, true);
  const attentionNotes = await backend.store.list("bdfaa68d89");
  const dpoNotes = await backend.store.list("92cb3a2b71");
  assert.equal(attentionNotes.length, 1);
  assert.equal(attentionNotes[0].id, kept.id);
  assert.equal(attentionNotes[0].body, "回答甲");
  assert.equal(attentionNotes[0].docHash, "bdfaa68d89");
  assert.equal(dpoNotes.length, 1);
  assert.equal(dpoNotes[0].body, "回答乙");
  assert.notEqual(dpoNotes[0].id, kept.id);
});

test("a failed save retries onto disk and survives a reload", async () => {
  const backend = persistentNotes();
  backend.fail = 1;
  const box = harness({ backend, docHash: "bdfaa68d89", answer: "回答甲" });
  await typeAndSend(box.ui, "会失败一次");
  const turn = box.ui.session.turns[0];
  const failed = await box.ui.saveNote(turn);
  assert.equal(failed.ok, false);
  assert.equal(turn.noteId, "");
  assert.equal(turn.pendingDisk, true);
  assert.equal(box.ui.root.querySelector(".is-added"), null);
  assert.match(box.ui.root.textContent, /添加到笔记/);
  assert.equal(backend.store.notes.size, 0);
  assert.equal((await backend.list("bdfaa68d89")).length, 1);
  const retried = await box.ui.saveNote(turn);
  assert.equal(retried.ok, true);
  assert.equal(backend.writes, 2);
  assert.equal(backend.store.notes.size, 1);
  assert.equal(turn.noteId, [...backend.store.notes.keys()][0]);
  assert.match(box.ui.root.textContent, /已添加/);
  backend.reload();
  assert.equal(backend.store.notes.size, 1);
  assert.equal([...backend.store.notes.values()][0].body, "回答甲");
  assert.equal((await backend.list("bdfaa68d89")).length, 1);
});

test("viewer ask entry no longer toasts 即将推出 for the ask button", () => {
  const bind = viewer.slice(viewer.indexOf("function bindViewChrome"), viewer.indexOf("function readerWidth"));
  assert.match(bind, /askUi\?\.toggle\(\)/);
  assert.equal(bind.includes('id === "askButton"'), false);
  const menu = viewer.slice(viewer.indexOf("function bindMoreMenu"), viewer.indexOf("function showToast"));
  assert.match(menu, /\$\("menuAsk"\)\?\.addEventListener[\s\S]*askUi\?\.toggle\(\)/);
  assert.match(viewer, /event\.key === "q"/);
  assert.match(viewer, /event\.key === "a"/);
});
