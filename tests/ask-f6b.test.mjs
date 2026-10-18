// F6b invariants. No network: fetch is poisoned, and the model call is injected.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "fake-indexeddb/auto";
import { IDBObjectStore } from "fake-indexeddb";
import { parseHTML } from "linkedom";
import { askTarget } from "../lib/ask-model.js";
import { renderAskAnswer } from "../lib/ask-render.js";
import { buildAskMessages, resetAskSession } from "../lib/ask-session.js";
import { performAsk } from "../lib/ask-transport.js";
import { exportMarkdown } from "../lib/notes-io.js";
import { filterCounts, noteMatchesFilter } from "../lib/notes-view-model.js";
import { createNotesStore } from "../lib/notes-store.js";
import { mountAskUi } from "../pdf/ask-panel.js";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "sk-f6b-secret-value";

globalThis.fetch = () => {
  const error = new Error("F6b test must not send a network request");
  error.code = "live-fetch-blocked";
  throw error;
};

function loadKatex() {
  const katexPath = join(root, "pdf/vendor/katex/katex.min.js");
  const katexModule = new (require("module").Module)(katexPath);
  katexModule.filename = katexPath;
  katexModule.paths = require("module").Module._nodeModulePaths(dirname(katexPath));
  katexModule._compile(readFileSync(katexPath, "utf8"), katexPath);
  return katexModule.exports;
}

const katex = loadKatex();

function installDom() {
  const parsed = parseHTML(`<!doctype html><html><body>
    <button id="askButton" type="button">问 AI</button>
    <div class="workspace"><div id="sideSlot"></div>
      <div id="readerFlow"></div>
    </div>
  </body></html>`);
  globalThis.document = parsed.document;
  globalThis.window = parsed.window;
  globalThis.HTMLElement = parsed.window.HTMLElement;
  globalThis.Node = parsed.window.Node;
  globalThis.Event = parsed.window.Event;
  globalThis.KeyboardEvent = parsed.window.KeyboardEvent;
  globalThis.AbortController = parsed.window.AbortController || globalThis.AbortController;
  let active = parsed.document.body;
  parsed.window.HTMLElement.prototype.focus = function focus() { active = this; };
  Object.defineProperty(parsed.document, "activeElement", { configurable: true, get() { return active; } });
  return parsed;
}

function harness(options = {}) {
  installDom();
  const sent = [];
  const copied = [];
  const toasts = [];
  const opens = [];
  let docHash = options.docHash || "doc-attn";
  const ui = mountAskUi({
    hasDoc: () => true,
    width: () => 1440,
    flow: () => document.getElementById("readerFlow"),
    blocks: () => [
      { bid: "b2", page: 4, text: "输入由维度为 d_k 的查询和键组成。" },
      { bid: "b3", page: 4, text: "我们怀疑当 d_k 较大时。" },
      { bid: "b4", page: 4, text: "乘以 1/√d_k。" }
    ],
    currentCitation: () => ({ bid: "b3", page: 4, kind: "text", text: "我们怀疑当 d_k 较大时。" }),
    docHash: () => docHash,
    readRoute: async () => ({
      settings: { provider: "openai" },
      target: {
        ok: true,
        via: "translation",
        provider: "openai",
        model: "gpt-4o-mini",
        url: "https://api.openai.com/v1/chat/completions",
        host: "api.openai.com"
      },
      apiKey: KEY
    }),
    readConfirm: async () => false,
    send: async (req) => {
      sent.push(req);
      if (options.send) return options.send(req, sent.length);
      return { ok: true, status: 200, body: options.answer || "点积要除以 $\\sqrt{d_k}$。" };
    },
    saveNote: options.saveNote,
    listNotes: options.listNotes,
    anchorFor: async (citation) => {
      if (!citation?.bid) return null;
      return {
        anchor: { bid: citation.bid, page: citation.page || 0, quote: "我们怀疑" },
        anchorState: { status: "exact", layoutRev: "layout-1", checkedAt: 0 }
      };
    },
    revealNote: async (id) => ({ ok: true, id }),
    toast: (text) => toasts.push(text),
    writeText: async (text) => { copied.push(text); },
    onOpenChange: (open, meta) => opens.push({ open, meta })
  });
  return {
    ui,
    sent,
    copied,
    toasts,
    opens,
    setDoc(hash) { docHash = hash; }
  };
}

async function emptyNotesDb() {
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("oi-annotations");
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function ask(ui, text) {
  await ui.open();
  ui.session.draft = text;
  return ui.submit({ confirmed: true });
}

test("A1 KaTeX does not execute HTML and a failed formula stays plain text", () => {
  const page = parseHTML("<!doctype html><html><body><div id='out'></div></body></html>");
  const node = page.document.getElementById("out");
  const prose = "见 <script>alert(1)</script> 与 $\\sqrt{d_k}$。";
  node.innerHTML = renderAskAnswer(prose, katex);
  assert.equal(node.querySelector("script"), null);
  assert.equal(node.querySelector("a"), null);
  assert.equal(node.innerHTML.includes("<script"), false);
  assert.equal(node.innerHTML.includes("javascript:"), false);
  assert.match(node.innerHTML, /class="katex"/);
  assert.match(node.innerHTML, /sqrt/);
  assert.equal(node.textContent.includes("$\\sqrt"), false);

  const hostile = "公式 $\\href{javascript:alert(1)}{x}$ 结束";
  node.innerHTML = renderAskAnswer(hostile, katex);
  assert.equal(node.querySelector("script, a, iframe, img"), null);
  assert.equal(node.innerHTML.includes("class=\"katex\""), false);
  assert.equal(/<\s*script\b|<\s*a\b|onerror\s*=/i.test(node.innerHTML), false);
  assert.match(node.textContent, /\\href\{javascript:alert\(1\)\}/);
  assert.match(node.textContent, /\$/);

  for (const command of ["\\url{javascript:alert(1)}", "\\htmlClass{x}{y}", "\\htmlId{i}{y}", "\\htmlStyle{color:red}{y}", "\\htmlData{a=1}{y}"]) {
    const html = renderAskAnswer(`$${command}$`, katex);
    assert.equal(html.includes("class=\"katex\""), false, command);
    assert.equal(html.includes("<"), false, command);
    assert.match(html, /\$/, command);
  }

  const evil = {
    renderToString() {
      return "<span class=\"katex\"><img src=x onerror=\"alert(1)\"><script>alert(1)</script></span>";
    }
  };
  const blocked = renderAskAnswer("$$E=mc^2$$", evil);
  assert.equal(blocked.includes("<script"), false);
  assert.equal(blocked.includes("onerror"), false);
  assert.match(blocked, /\$\$E=mc\^2\$\$/);

  const broken = {
    renderToString() {
      throw new Error("parse");
    }
  };
  assert.equal(renderAskAnswer("行内 $a+b$ 结束", broken).includes("<"), false);
});

test("A2 copy writes the model text, not the rendered HTML", async () => {
  globalThis.katex = katex;
  const box = harness({ answer: "保留 $\\href{javascript:alert(1)}{x}$ 与 $\\sqrt{d_k}$。" });
  const done = await ask(box.ui, "怎么复制");
  const answer = box.ui.root.querySelector(".oi-ask-answer");
  assert.equal(answer.querySelector("script, a, img"), null);
  assert.equal(/<\s*script\b|<\s*a\b|onerror\s*=/i.test(answer.innerHTML), false);
  answer.parentElement.querySelector("[data-ask-act='copy']").click();
  await Promise.resolve();
  assert.equal(box.copied.length, 1);
  assert.equal(box.copied[0], done.turn.answer);
  assert.match(box.copied[0], /\\href\{javascript:alert\(1\)\}/);
  assert.match(box.copied[0], /\$/);
  assert.equal(box.copied[0].includes("<span"), false);
  assert.equal(box.copied[0].includes(KEY), false);
});

test("A3 the third turn sees only this document's current session", async () => {
  globalThis.katex = { renderToString: () => "<span class=\"katex\">x</span>" };
  const answers = ["第一轮答案 TOKEN-A", "第二轮答案 TOKEN-B", "第三轮答案 TOKEN-C"];
  const box = harness({
    send: (_req, n) => ({ ok: true, status: 200, body: answers[n - 1] })
  });
  await ask(box.ui, "第一问");
  await ask(box.ui, "第二问");
  await ask(box.ui, "第三问");
  assert.equal(box.ui.root.querySelectorAll(".oi-ask-turn").length, 3);
  const third = box.sent[2].messages;
  const blob = JSON.stringify(third);
  assert.match(blob, /第一问/);
  assert.match(blob, /TOKEN-A/);
  assert.match(blob, /第二问/);
  assert.match(blob, /TOKEN-B/);
  assert.match(blob, /第三问/);
  assert.equal(third.filter((item) => item.role === "assistant").length, 2);
  assert.equal(blob.includes("FULLPAGE"), false);
  assert.equal(blob.includes(KEY), false);

  const other = harness({ docHash: "doc-other", answer: "另一篇" });
  await ask(other.ui, "别的文献");
  const otherBlob = JSON.stringify(other.sent[0].messages);
  assert.equal(otherBlob.includes("TOKEN-A"), false);
  assert.equal(otherBlob.includes("第一问"), false);
  assert.match(otherBlob, /别的文献/);

  const before = box.ui.session.id;
  box.ui.onDocumentReset();
  assert.notEqual(box.ui.session.id, before);
  assert.equal(box.ui.session.turns.length, 0);
  assert.equal(box.ui.session.draft, "");
  await ask(box.ui, "新文献的问题");
  const after = JSON.stringify(box.sent.at(-1).messages);
  assert.equal(after.includes("TOKEN-A"), false);
  assert.match(after, /新文献的问题/);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.match(viewer, /askUi\?\.onDocumentReset\(\)/);
  const session = box.ui.session;
  resetAskSession(session, "doc-next");
  const built = buildAskMessages({ question: "只这一轮", history: session.turns, nearby: [], citation: null, payload: { text: "" } });
  assert.equal(JSON.stringify(built).includes("TOKEN-A"), false);
});

test("A4 and A5 a custom engine is not a fallback, and the key stays out of notes, export, and logs", async () => {
  const custom = askTarget(
    { provider: "custom", providers: { custom: { apiKey: KEY, model: "local-model" } } },
    { multimodal: { provider: "", apiKey: "" } }
  );
  assert.equal(custom.ok, false);
  assert.equal(custom.via, "none");

  let captured = null;
  const result = await performAsk({
    target: {
      ok: true,
      via: "translation",
      provider: "openai",
      model: "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
      host: "api.openai.com"
    },
    messages: buildAskMessages({ question: "密钥在哪", history: [], nearby: [], payload: { text: "引用" } }),
    apiKey: KEY,
    fetchImpl: async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, async json() { return { choices: [{ message: { content: "不含密钥" } }] }; } };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(String(captured.body).includes(KEY), false);
  assert.match(captured.headers.Authorization, new RegExp(KEY));
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const askSend = viewer.slice(viewer.indexOf("async function sendAsk"), viewer.indexOf("function openAskSettings"));
  assert.match(askSend, /cache:\s*false/);
  assert.equal(/console\./.test(askSend), false);
  for (const name of ["pdf/ask-panel.js", "lib/ask-session.js", "lib/ask-transport.js", "lib/ask-render.js"]) {
    const src = readFileSync(join(root, name), "utf8");
    assert.equal(src.includes(KEY), false, name);
    assert.equal(/console\.(log|debug|info|warn)\s*\(/.test(src), false, name);
  }
});

test("saving a note keeps the answer, shows 查看笔记, and the AI filter can see it", async () => {
  globalThis.katex = katex;
  await emptyNotesDb();
  const store = createNotesStore({ persist: false, capture: false, deviceId: "f6b" });
  const box = harness({
    answer: "存下来的 $\\sqrt{d_k}$。",
    saveNote: (input, options) => store.put(input, options),
    listNotes: () => store.list("doc-attn")
  });
  const done = await ask(box.ui, "存为笔记");
  const turn = done.turn;
  const saved = await box.ui.saveNote(turn);
  assert.equal(saved.ok, true);
  assert.equal(box.ui.isOpen(), true);
  assert.equal(box.opens.at(-1).open, true);
  assert.match(box.ui.root.textContent, /查看笔记/);
  assert.equal(box.ui.root.textContent.includes("问整页"), false);
  const note = (await store.list("doc-attn"))[0];
  assert.equal(note.author, "ai");
  assert.equal(note.kind, "note");
  assert.equal(note.qa.answer, turn.answer);
  assert.equal(note.qa.question, "存为笔记");
  assert.equal(note.body, turn.answer);
  assert.equal(JSON.stringify(note).includes(KEY), false);
  assert.equal(noteMatchesFilter(note, "ai"), true);
  assert.equal(filterCounts([note]).ai, 1);
  const again = await box.ui.saveNote(turn);
  assert.equal(again.reason, "exists");
  assert.equal((await store.list("doc-attn")).length, 1);
  const bundle = await store.exportAll();
  const md = exportMarkdown(bundle);
  assert.equal(JSON.stringify(bundle).includes(KEY), false);
  assert.equal(md.includes(KEY), false);
  assert.match(md, /sqrt|√|d_k/);
  try { store.currentDb?.close(); } catch { /* closed */ }
  await emptyNotesDb();
});

test("a real IndexedDB put failure keeps the answer and a retry writes one note", async () => {
  globalThis.katex = katex;
  await emptyNotesDb();
  const store = createNotesStore({ persist: false, capture: false, deviceId: "f6b-fail" });
  const original = IDBObjectStore.prototype.put;
  let fail = 0;
  let pendingWhenPutStarted = null;
  IDBObjectStore.prototype.put = function put(value, key) {
    if (fail > 0 && this.name === "notes") {
      fail -= 1;
      const error = new Error("injected put failure");
      error.name = "UnknownError";
      throw error;
    }
    return original.call(this, value, key);
  };
  const realPut = store.put.bind(store);
  store.put = async (input, options) => {
    pendingWhenPutStarted = box.ui.session.turns[0]?.pendingDisk === true;
    return realPut(input, options);
  };
  const box = harness({
    answer: "失败后还在的答案",
    saveNote: (input, options) => store.put(input, options),
    listNotes: () => store.list("doc-attn")
  });
  try {
    const done = await ask(box.ui, "会失败一次");
    const turn = done.turn;
    fail = 1;
    const failed = await box.ui.saveNote(turn);
    assert.equal(failed.ok, false);
    assert.equal(pendingWhenPutStarted, true);
    assert.equal(turn.noteId, "");
    assert.equal(turn.pendingDisk, true);
    assert.equal(turn.answer, "失败后还在的答案");
    assert.equal(box.ui.root.querySelector(".is-added"), null);
    assert.match(box.ui.root.textContent, /添加到笔记/);
    assert.match(box.toasts.at(-1), /没有写入笔记/);
    assert.equal(store.memory.notes.has(`ask:${turn.id}`), true);
    const db = store.currentDb;
    const disk = await new Promise((resolve, reject) => {
      const tx = db.transaction("notes", "readonly");
      const req = tx.objectStore("notes").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    assert.equal(disk.some((note) => note.id === `ask:${turn.id}`), false);
    const retried = await box.ui.saveNote(turn);
    assert.equal(retried.ok, true);
    assert.match(box.ui.root.textContent, /已添加/);
    assert.match(box.ui.root.textContent, /查看笔记/);
    assert.equal(box.ui.isOpen(), true);
    const rows = await store.list("doc-attn");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "失败后还在的答案");
    assert.equal(noteMatchesFilter(rows[0], "ai"), true);
    const duplicate = await box.ui.saveNote(turn);
    assert.equal(duplicate.reason, "exists");
    assert.equal((await store.list("doc-attn")).length, 1);
  } finally {
    IDBObjectStore.prototype.put = original;
    try { store.currentDb?.close(); } catch { /* closed */ }
    await emptyNotesDb();
  }
});

test("a document conflict has its own message and does not drop the answer", async () => {
  globalThis.katex = katex;
  await emptyNotesDb();
  const store = createNotesStore({ persist: false, capture: false, deviceId: "f6b-doc" });
  const box = harness({
    answer: "冲突后答案还在",
    saveNote: (input, options) => store.put(input, options),
    listNotes: () => store.list("doc-attn")
  });
  const done = await ask(box.ui, "撞 id");
  const turn = done.turn;
  await store.put({
    id: `ask:${turn.id}`,
    docHash: "doc-other",
    kind: "note",
    author: "ai",
    body: "另一篇里的笔记",
    qa: { sessionId: "other", turnId: "other-turn", question: "别的", answer: "另一篇里的笔记", model: "m" }
  });
  const failed = await box.ui.saveNote(turn);
  assert.equal(failed.ok, false);
  assert.equal(turn.answer, "冲突后答案还在");
  assert.equal(turn.noteId, "");
  assert.equal(box.ui.root.querySelector(".is-added"), null);
  assert.equal(box.toasts.at(-1), "这条笔记属于另一篇文档。");
  assert.equal(box.toasts.at(-1).includes("没有写入笔记"), false);
  const again = await box.ui.saveNote(turn);
  assert.equal(again.ok, false);
  assert.equal(box.toasts.at(-1), "这条笔记属于另一篇文档。");
  const other = await store.list("doc-other");
  const here = await store.list("doc-attn");
  assert.equal(other.length, 1);
  assert.equal(other[0].body, "另一篇里的笔记");
  assert.equal(here.length, 0);
  assert.equal(other.length, 1);
  try { store.currentDb?.close(); } catch { /* closed */ }
  await emptyNotesDb();
});

test("the panel no longer adopts notes through durableNoteIds", () => {
  const panel = readFileSync(join(root, "pdf/ask-panel.js"), "utf8");
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.equal(panel.includes("durableNoteIds"), false);
  assert.equal(panel.includes("reused"), false);
  assert.equal(viewer.includes("durableNoteIds"), false);
});
