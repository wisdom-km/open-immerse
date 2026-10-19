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
import "./helpers/load-markdown-it.mjs";
import { renderGuarded } from "./helpers/render-guard.mjs";
import { askTarget } from "../lib/ask-model.js";
import { ASK_KATEX_OPTIONS, ASK_MATH_MAX_FORMULAS, ASK_MATH_MAX_TEX, renderAskAnswer, texIsDisplayable } from "../lib/ask-render.js";
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
  assert.equal(userSourceAngles(node.innerHTML).includes("<"), false);
  assert.match(node.innerHTML, /class="katex"/);
  assert.match(node.innerHTML, /sqrt/);
  assert.equal(node.textContent.includes("$\\sqrt"), false);

  const hostile = "公式 $\\href{javascript:alert(1)}{x}$ 结束";
  node.innerHTML = renderAskAnswer(hostile, katex);
  assert.equal(node.querySelector("script, a, iframe, img"), null);
  assert.equal(node.innerHTML.includes("class=\"katex\""), false);
  assert.equal(/<\s*script\b|<\s*a\b|onerror\s*=/i.test(node.innerHTML), false);
  assert.equal(userSourceAngles(node.innerHTML).includes("<"), false);
  assert.match(node.textContent, /\\href\{javascript:alert\(1\)\}/);
  assert.match(node.textContent, /\$/);

  for (const command of ["\\url{javascript:alert(1)}", "\\htmlClass{x}{y}", "\\htmlId{i}{y}", "\\htmlStyle{color:red}{y}", "\\htmlData{a=1}{y}"]) {
    const html = renderAskAnswer(`$${command}$`, katex);
    assert.equal(html.includes("class=\"katex\""), false, command);
    assert.equal(/<\s*(?:script|a|img|iframe)\b|onerror\s*=/i.test(html), false, command);
    assert.equal(userSourceAngles(html).includes("<"), false, command);
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
  const plain = renderAskAnswer("行内 $a+b$ 结束", broken);
  assert.equal(plain.includes("class=\"katex\""), false);
  assert.match(plain, /\$a\+b\$/);
  assert.equal(/<\s*(?:script|a|img)\b/.test(plain), false);
  assert.equal(userSourceAngles(plain).includes("<"), false);
  assert.equal(userSourceAngles(blocked).includes("<"), false);
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
  for (const name of ["pdf/ask-panel.js", "lib/ask-session.js", "lib/ask-transport.js", "lib/ask-render.js", "lib/markdown-render.js"]) {
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
  const session = readFileSync(join(root, "lib/ask-session.js"), "utf8");
  assert.equal(panel.includes("durableNoteIds"), false);
  assert.equal(panel.includes("reused"), false);
  assert.equal(viewer.includes("durableNoteIds"), false);
  assert.equal(session.includes("durableIds"), false);
  assert.equal(session.includes('action: "reuse"'), false);
  assert.equal(session.includes("durableNoteIds"), false);
});

function userSourceAngles(html) {
  const page = parseHTML(`<!doctype html><body><div id="o">${html}</div></body>`);
  const node = page.document.getElementById("o");
  for (const el of node.querySelectorAll(".katex-display, .katex")) el.remove();
  return node.innerHTML.replace(/<\/?(?:p|br|hr|strong|em|s|del|code|pre|ul|ol|li|blockquote|h[1-6]|table|thead|tbody|tr|th|td|a|input)\b[^>]*>/gi, "");
}

function contrastRatio(foreground, background) {
  const channel = (hex, offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const lighter = Math.max(lum(foreground), lum(background));
  const darker = Math.min(lum(foreground), lum(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function assertNoActiveHtml(node) {
  assert.equal(node.querySelector("script, a, img, iframe, link, object, embed, form"), null);
  for (const el of [node, ...node.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      assert.equal(/^on/i.test(attr.name), false, attr.name);
      assert.equal(/javascript\s*:/i.test(attr.value), false, attr.value);
      assert.equal(attr.name.toLowerCase() === "href", false, attr.value);
    }
  }
}

test("markdown subset renders and refuses raw HTML, links, and images", () => {
  const page = parseHTML("<!doctype html><html><body><div id='out'></div></body></html>");
  const node = page.document.getElementById("out");
  const source = [
    "第一段 **粗体** 与 $E=mc^2$。",
    "",
    "同一段换行",
    "还在这一段",
    "",
    "- 列表 `行内 $不是公式$`",
    "- <img src=x onerror=\"alert(1)\">",
    "",
    "1. 有序",
    "2. 第二项",
    "",
    "[x](javascript:alert(1))",
    "",
    "![](javascript:alert(1))",
    "",
    "```",
    "const price = $5;",
    "<img src=x onerror=\"alert(1)\">",
    "```",
    "",
    "````",
    "```",
    "$nested$",
    "<img src=x onerror=\"alert(1)\">",
    "```",
    "````",
    "",
    "**见 $x$**",
    "",
    "*不是斜体* # 不是标题"
  ].join("\n");
  node.innerHTML = renderAskAnswer(source, katex);
  assertNoActiveHtml(node);
  assert.equal(node.querySelector("strong").textContent, "粗体");
  assert.equal(node.querySelectorAll("ul li").length, 2);
  assert.equal(node.querySelectorAll("ol li").length, 2);
  assert.equal(node.querySelector("code").textContent, "行内 $不是公式$");
  assert.equal(node.querySelector("em").textContent, "不是斜体");
  assert.equal(node.querySelector("h1, h2, h3"), null);
  const pres = [...node.querySelectorAll("pre")];
  assert.equal(pres.length, 2);
  assert.match(pres[0].textContent, /\$5/);
  assert.match(pres[0].textContent, /onerror/);
  assert.equal(pres[0].querySelector(".katex"), null);
  assert.match(pres[1].textContent, /\$nested\$/);
  assert.match(pres[1].textContent, /```/);
  assert.equal(pres[1].querySelector(".katex, img"), null);
  assert.ok(node.querySelectorAll("p").length >= 3);
  assert.ok([...node.querySelectorAll("p")].some((para) => para.innerHTML.includes("<br>")));
  const katexNodes = [...node.querySelectorAll(".katex")];
  assert.equal(katexNodes.length, 2);
  assert.equal(node.querySelectorAll("strong").length, 2);
  assert.equal(node.querySelectorAll("strong")[1].querySelector(".katex") != null, true);
  assert.match(node.textContent, /# 不是标题/);
  assert.match(node.textContent, /\[x\]\(javascript:alert\(1\)\)/);
  assert.match(node.textContent, /!\[\]\(javascript:alert\(1\)\)/);
});

test("M1 trust:false blocks \\href when the command prefilter is skipped", () => {
  assert.equal(ASK_KATEX_OPTIONS.trust, false);
  const html = katex.renderToString("\\href{https://example.com}{x}", {
    ...ASK_KATEX_OPTIONS,
    displayMode: false
  });
  assert.equal(/<\s*a\b/i.test(html), false);
  assert.equal(html.includes("https://example.com"), false);
  assert.match(html, new RegExp(ASK_KATEX_OPTIONS.errorColor, "i"));
});

test("M2 the command prefilter stops \\href before KaTeX runs", () => {
  for (const command of ["\\href{https://example.com}{x}", "\\url{https://example.com}", "\\htmlClass{x}{y}", "\\htmlId{i}{y}", "\\htmlStyle{color:red}{y}", "\\htmlData{a=1}{y}"]) {
    assert.equal(texIsDisplayable(command), false, command);
  }
  assert.equal(texIsDisplayable("\\scriptstyle x"), true);
  const calls = [];
  const engine = {
    renderToString(tex) {
      calls.push(tex);
      return `<span class="katex">${tex}</span>`;
    }
  };
  const html = renderAskAnswer("前文 $\\href{https://example.com}{x}$ 后文", engine);
  assert.deepEqual(calls, []);
  assert.equal(html.includes("class=\"katex\""), false);
  assert.match(html, /\\href\{https:\/\/example.com\}\{x\}/);
  const shown = renderAskAnswer("$\\scriptstyle x$", engine);
  assert.deepEqual(calls, ["\\scriptstyle x"]);
  assert.match(shown, /class="katex"/);
});

test("formulas past the count or length cap stay escaped text", () => {
  assert.ok(ASK_MATH_MAX_FORMULAS <= 80);
  assert.ok(ASK_MATH_MAX_TEX < 20000);
  const calls = [];
  const engine = {
    renderToString(tex) {
      calls.push(tex);
      return `<span class="katex">${tex}</span>`;
    }
  };
  const many = Array.from({ length: ASK_MATH_MAX_FORMULAS + 1 }, (_, index) => `$x_{${index}}$`).join(" ");
  const html = renderAskAnswer(many, engine);
  assert.equal(calls.length, ASK_MATH_MAX_FORMULAS);
  assert.match(html, new RegExp(`\\$x_\\{${ASK_MATH_MAX_FORMULAS}\\}\\$`));
  assert.equal((html.match(/class="katex"/g) || []).length, ASK_MATH_MAX_FORMULAS);
  const huge = `$${ "a".repeat(50000) }$ 然后 $z$`;
  const started = Date.now();
  const big = renderAskAnswer(huge, engine);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `huge formula took ${elapsed}ms`);
  assert.equal(calls.length, ASK_MATH_MAX_FORMULAS + 1);
  assert.equal(calls.at(-1), "z");
  assert.match(big, /\$a{100,}\$/);
  assert.match(big, /class="katex"/);
});

const PAYLOAD = "<img src=x onerror=alert(1)>";

test("inline code escapes an img onerror payload", () => {
  const html = renderAskAnswer("`" + PAYLOAD + "`", katex);
  assert.equal(html.includes("<img"), false);
  assert.match(html, /<code>&lt;img src=x onerror=alert\(1\)&gt;<\/code>/);
  assert.equal(userSourceAngles(html).includes("<"), false);
});

test("a rejected formula escapes an img onerror payload", () => {
  const html = renderAskAnswer("$" + PAYLOAD + "\\href{https://example.com}{x}$", katex);
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("class=\"katex\""), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /\\href\{https:\/\/example.com\}/);
  assert.equal(userSourceAngles(html).includes("<"), false);
});

test("an over-limit formula escapes an img onerror payload", () => {
  const html = renderAskAnswer("$" + "a".repeat(ASK_MATH_MAX_TEX) + PAYLOAD + "$", katex);
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("class=\"katex\""), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(userSourceAngles(html).includes("<"), false);
});

test("the panel renders the answer instead of writing turn.answer as HTML", async () => {
  const box = harness({ answer: PAYLOAD });
  await ask(box.ui, "原文标签");
  const answer = box.ui.root.querySelector(".oi-ask-answer");
  assert.equal(answer.querySelector("img, script"), null);
  assert.equal(answer.innerHTML.includes("<img"), false);
  assert.match(answer.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(answer.textContent.includes(PAYLOAD), true);
});

test("a formula keeps backticks and the letters inside them", () => {
  const html = renderAskAnswer("$a `b` c$", katex);
  const page = parseHTML(`<!doctype html><body><div id="o">${html}</div></body>`);
  const text = page.document.getElementById("o").textContent;
  assert.match(html, /class="katex"/);
  assert.match(text, /b/);
  assert.equal(text.includes("\uE000"), false);
  assert.equal(html.includes("\uE000"), false);
  assert.equal(html.includes("\uE010"), false);
  assert.equal(/\$a\s+0\s+c\$/.test(text), false);
});

test("an ordered list keeps its start number", () => {
  const html = renderAskAnswer("3. 三\n4. 四").replace(/>\s+</g, "><");
  assert.match(html, /<ol start="3"><li>三<\/li><li>四<\/li><\/ol>/);
  const one = renderAskAnswer("1. 一\n2. 二").replace(/>\s+</g, "><");
  assert.match(one, /<ol><li>一<\/li><li>二<\/li><\/ol>/);
});

test("private-use characters stay literal and the renderer always advances", { timeout: 10000 }, async () => {
  // node:test's timeout does not interrupt a synchronous loop. The worker
  // terminate (totalMs) is what stops a hang.
  for (const name of ["lib/ask-render.js", "lib/markdown-render.js"]) {
    const source = readFileSync(join(root, name), "utf8");
    assert.equal(source.includes("\\uE000"), false, name);
    assert.equal(source.includes("\\uE001"), false, name);
    assert.equal(source.includes("\\uE010"), false, name);
    assert.equal(source.includes("\\uE011"), false, name);
  }
  const marks = ["\uE000", "\uE001", "\uE010", "\uE011"];
  const cases = [
    ...marks,
    ...marks.map((mark) => mark + mark),
    "\uE0000\uE001",
    "\uE0100\uE011",
    "\uE000\uE011",
    "\uE010\uE001",
    "\uE000`code \uE001` $x$",
    "- \uE000 一项\n- `\uE010`",
    "$\uE000$",
    "$$\uE010$$",
    "```\n\uE000 $not$\n```"
  ];
  const results = await renderGuarded(cases, { totalMs: 4000 });
  assert.equal(results.length, cases.length);
  for (const result of results) {
    const sample = cases[result.index];
    assert.equal(result.error, undefined, JSON.stringify(sample));
    assert.ok(result.ms < 50, `${JSON.stringify(sample)} took ${result.ms}ms`);
    const page = parseHTML(`<!doctype html><body><div id="o">${result.html}</div></body>`);
    const text = page.document.getElementById("o").textContent;
    for (const mark of marks) {
      if (sample.includes(mark)) assert.equal(text.includes(mark), true, JSON.stringify(sample));
    }
    assert.equal(userSourceAngles(result.html).includes("<"), false, JSON.stringify(sample));
  }
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("random answers stay bounded and do not emit raw user markup", { timeout: 30000 }, async () => {
  const alphabet = ["\uE000", "\uE001", "\uE010", "\uE011", "`", "$", "*", "<", ">", "a", "\n", " ", "3. ", "- ", "**", PAYLOAD];
  const sources = [];
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = mulberry32(seed);
    const length = 1 + Math.floor(random() * 40);
    let source = "";
    for (let index = 0; index < length; index += 1) source += alphabet[Math.floor(random() * alphabet.length)];
    sources.push(source);
  }
  const results = await renderGuarded(sources, { totalMs: 20000 });
  assert.equal(results.length, sources.length);
  for (const result of results) {
    const seed = result.index + 1;
    const source = sources[result.index];
    if (result.error) throw new Error(`seed ${seed} threw ${result.error} on ${JSON.stringify(source)}`);
    if (result.ms > 100) throw new Error(`seed ${seed} took ${result.ms.toFixed(1)}ms on ${JSON.stringify(source)}`);
    const left = userSourceAngles(result.html);
    if (left.includes("<")) throw new Error(`seed ${seed} raw < in ${JSON.stringify(left.slice(0, 180))} from ${JSON.stringify(source)}`);
    if (/<\s*(?:script|img|iframe)\b/i.test(result.html)) {
      throw new Error(`seed ${seed} active html from ${JSON.stringify(source)}`);
    }
  }
});

test("dark theme raises the AI and mine colors", () => {
  const css = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
  const start = css.indexOf('.oi-reader-app[data-reader-theme="dark"]');
  const end = css.indexOf(".oi-reader-app[data-reader-fs-band", start);
  const dark = css.slice(start, end);
  const light = css.slice(end);
  assert.match(dark, /--oi-reader-ai:\s*#6FB3BC/i);
  assert.match(dark, /--oi-reader-ai-soft:\s*rgba\(111,\s*179,\s*188,\s*0?\.16\)/);
  assert.match(dark, /--oi-reader-mine:\s*#B98CC6/i);
  assert.match(light, /--oi-reader-ai:\s*#2A6670/i);
  assert.match(light, /--oi-reader-ai-soft:\s*rgba\(42,\s*102,\s*112,\s*0?\.08\)/);
  assert.match(light, /--oi-reader-mine:\s*#7A4A86/i);
  assert.equal(light.includes("#6FB3BC"), false);
  assert.equal(light.includes("#B98CC6"), false);
  assert.ok(contrastRatio("#6FB3BC", "#232427") >= 4.5);
  assert.ok(contrastRatio("#B98CC6", "#232427") >= 4.5);
});
