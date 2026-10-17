// F6a Ask panel states. linkedom only — the send hook is a fake provider.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { askTarget } from "../lib/ask-model.js";
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
  let confirm = options.confirm === true;
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
    docHash: () => "doc-attn",
    readRoute: async () => ({ settings, target: askTarget(settings, formula), apiKey: formula?.multimodal?.apiKey || "sk-translate" }),
    readConfirm: async () => confirm,
    writeConfirm: async (value) => { confirm = value !== false; },
    send: async (req) => {
      sent.push(req);
      if (options.send) return options.send(req);
      if (options.fail) return options.fail(req);
      return { ok: true, status: 200, body: options.answer || "点积要除以 $\\sqrt{d_k}$。" };
    },
    saveNote: async (input) => {
      if (options.saveError) throw new Error("disk");
      const note = { id: `note-${notes.length + 1}`, ...input };
      notes.push(note);
      return note;
    },
    listNotes: async () => notes.slice(),
    anchorFor: async (citation) => citation?.bid ? { bid: citation.bid, page: citation.page, quote: citation.text } : null,
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
  assert.equal(box.notes[0].anchor.bid, "b3");
  const added = box.ui.root.querySelector("[data-ask-act='added']");
  assert.equal(added.getAttribute("aria-label"), "✓ 已添加");
  assert.equal(added.disabled, true);
  assert.equal(added.getAttribute("aria-disabled"), "true");
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
  assert.match(err.textContent, /多模态模型调用失败/);
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
  assert.match(css, /\.oi-ask-act\.is-added\s*\{[^}]*width:\s*96px/);
  assert.match(css, /\.oi-ask-act\.is-added\s*\{[^}]*color:\s*var\(--oi-reader-mine\)/);
  assert.match(css, /\.oi-ask-act\.is-view\s*\{[^}]*color:\s*var\(--oi-reader-ai\)/);
  assert.match(css, /\.oi-ask-act:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-reader-focus\)/);
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

test("first send confirms once, then stays quiet", async () => {
  const box = harness({ confirm: true });
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

test("save failure rolls back only that turn and a second save does not duplicate", async () => {
  const box = harness({ saveError: true });
  await typeAndSend(box.ui, "写失败");
  const turn = box.ui.session.turns[0];
  const first = await box.ui.saveNote(turn);
  assert.equal(first.ok, false);
  assert.equal(turn.noteId, "");
  assert.equal(turn.saving, false);
  assert.equal(box.notes.length, 0);
  box.ui.root.querySelector("[data-ask-act='save']");
  const restored = harness();
  await typeAndSend(restored.ui, "写成功");
  await restored.ui.saveNote(restored.ui.session.turns[0]);
  const again = await restored.ui.saveNote(restored.ui.session.turns[0]);
  assert.equal(again.reason, "exists");
  assert.equal(restored.notes.length, 1);
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
  assert.match(box.ui.root.querySelector("[data-ask='preview-line']").textContent, /附近 2 段/);
  assert.match(box.ui.root.querySelector("[data-ask='preview-line']").textContent, /裁图/);
  box.ui.root.querySelector(".oi-ask-suggest button").click();
  assert.equal(box.sent.length, 0);
  assert.match(box.ui.root.querySelector("textarea").value, /这段在说什么/);
  await box.ui.submit({ confirmed: true });
  const blob = JSON.stringify(box.sent[0].messages);
  assert.match(blob, /QUJD/);
  assert.equal(blob.includes("FULLPAGE"), false);
  assert.match(box.ui.root.textContent, /不看图|裁图/);
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
