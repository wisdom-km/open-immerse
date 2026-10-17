// F6a Ask AI routing, session, and adversarial shared-state tests.
// No network. fetch is poisoned for the whole file.
import test from "node:test";
import assert from "node:assert/strict";
import { ASK_EMPTY } from "../lib/ask-route.js";
import {
  ASK_CONTEXT_NEARBY,
  askActionsUseIcons,
  askChipModel,
  askErrorModel,
  askPreviewLine,
  askRouteInputsChanged,
  askRouteToast,
  askTarget,
  unconfiguredModel
} from "../lib/ask-model.js";
import {
  beginTurn,
  buildAskMessages,
  citationPayload,
  claimNoteSave,
  clearTurns,
  createAskSession,
  finishNoteSave,
  nearbyBlocks,
  noteForTurn,
  noteInputFromTurn,
  retryTurn,
  sessionInvariants,
  settleTurn,
  stopTurn
} from "../lib/ask-session.js";
import { performAsk } from "../lib/ask-transport.js";
import { createNotesStore } from "../lib/notes-store.js";
import { noteMatchesFilter } from "../lib/notes-view-model.js";

const networkHits = [];
globalThis.fetch = async (url) => {
  networkHits.push(String(url));
  throw new Error("ask tests must not use the network");
};

const llm = {
  provider: "openai",
  providers: { openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", apiKey: "sk-translate" } }
};
const mm = {
  multimodal: { provider: "openai", apiKey: "sk-mm-secret", model: "gpt-4o", baseUrl: "https://api.openai.com/v1" }
};

const attention = [
  { bid: "full", page: 4, text: "FULLPAGE should never be attached" },
  { bid: "b1", page: 4, text: "我们将这种注意力称为「缩放点积注意力」。" },
  { bid: "b2", page: 4, text: "输入由维度为 d_k 的查询和键组成。" },
  { bid: "b3", page: 4, text: "我们怀疑当 d_k 较大时，点积会把 softmax 推到梯度极小的区域。" },
  { bid: "b4", page: 4, text: "为抵消这一影响，我们把点积乘以 1/√d_k。" },
  { bid: "b5", page: 4, text: "最常用的两种注意力函数是加性注意力和点积注意力。" }
];

function routeOf(settings, formula) {
  return askTarget(settings, formula);
}

test("SET-26…30 resolve the host and never fall back", async () => {
  const multi = routeOf(llm, mm);
  assert.equal(multi.via, "multimodal");
  assert.equal(multi.model, "gpt-4o");
  assert.equal(multi.host, "api.openai.com");
  assert.equal(askChipModel(multi).text, "多模态 · gpt-4o");
  assert.equal(JSON.stringify(multi).includes("sk-mm-secret"), false);

  const translate = routeOf(llm, { multimodal: { provider: "", apiKey: "" } });
  assert.equal(translate.via, "translation");
  assert.equal(translate.model, "gpt-4o-mini");
  assert.equal(askChipModel(translate).text, "翻译模型 · gpt-4o-mini");

  const myMemory = routeOf({ provider: "mymemory", providers: {} }, {});
  assert.equal(myMemory.ok, false);
  assert.equal(myMemory.message, ASK_EMPTY);
  assert.match(myMemory.href, /#mm$/);
  assert.match(unconfiguredModel({ provider: "mymemory" }, myMemory).body, /机器翻译/);

  const custom = routeOf({ provider: "custom", providers: { custom: { url: "https://example.test/translate" } } }, {});
  assert.equal(custom.ok, false);
  assert.match(unconfiguredModel({ provider: "custom" }, custom).body, /自定义引擎/);

  const calls = [];
  const failed = await performAsk({
    target: multi,
    messages: [{ role: "user", content: "q" }],
    apiKey: "sk-mm-secret",
    fetchImpl: async (url) => {
      calls.push(String(url));
      return { ok: false, status: 500, async json() { return { error: "nope" }; } };
    }
  });
  assert.deepEqual(calls, [multi.url]);
  assert.equal(failed.ok, false);
  assert.equal(failed.via, "multimodal");
  assert.equal(calls.some((url) => url.includes("gpt-4o-mini")), false);
  const model = askErrorModel({ via: "multimodal", status: 500, host: multi.host });
  assert.match(model.text, /多模态模型调用失败/);
  assert.equal(model.settings, true);
  assert.equal(model.fallback, false);

  const removed = routeOf(llm, { ...mm, multimodal: { ...mm.multimodal, apiKey: "" } });
  assert.equal(removed.via, "translation");
  assert.equal(askRouteToast(multi, removed), "问 AI 改用翻译模型");
  const restored = routeOf(llm, mm);
  assert.equal(restored.via, "multimodal");
  assert.equal(askRouteToast(removed, restored), "问 AI 改用多模态模型");
  assert.equal(askRouteInputsChanged({ formulaSettings: { newValue: {} } }, "local"), true);
  assert.equal(askRouteInputsChanged({ unrelated: {} }, "local"), false);
  assert.equal(networkHits.length, 0);
});

test("A5 Attention fixture builds nearby context and a fake answer without fetch", async () => {
  assert.equal(ASK_CONTEXT_NEARBY, 2);
  const near = nearbyBlocks(attention, "b3", 2);
  assert.deepEqual(near.map((block) => block.bid), ["b2", "b4"]);
  const session = createAskSession({ ids: () => "attn" });
  const route = routeOf(llm, mm);
  const begun = beginTurn(session, {
    question: "为什么除以 √d_k，而不是 d_k?",
    citation: { bid: "b3", page: 4, kind: "text", text: attention[3].text, section: "3.2.1" },
    nearby: near,
    route
  });
  assert.equal(begun.ok, true);
  const blob = JSON.stringify(begun.messages);
  assert.match(blob, /d_k 的查询和键/);
  assert.match(blob, /1\/√d_k/);
  assert.equal(blob.includes("FULLPAGE"), false);
  assert.match(blob, /为什么除以/);
  const settled = settleTurn(session, begun.generation, {
    ok: true,
    body: "点积的方差是 d_k，所以要除以 $\\sqrt{d_k}$。"
  });
  assert.equal(settled.turn.status, "done");
  assert.match(settled.turn.answer, /\\sqrt\{d_k\}/);
  assert.equal(networkHits.length, 0);
  assert.equal(session.flight, null);
});

test("A3 the third turn still carries the first turn", () => {
  const session = createAskSession({ ids: () => "multi" });
  const route = routeOf(llm, {});
  const first = beginTurn(session, { question: "第一问：方差是什么？", route, nearby: [], citation: null });
  settleTurn(session, first.generation, { ok: true, body: "方差是 d_k。" });
  const second = beginTurn(session, { question: "第二问：那标准差呢？", route, nearby: [] });
  settleTurn(session, second.generation, { ok: true, body: "标准差是 √d_k。" });
  const third = beginTurn(session, { question: "第三问：所以为什么要除？", route, nearby: [] });
  const blob = JSON.stringify(third.messages);
  assert.match(blob, /第一问：方差是什么？/);
  assert.match(blob, /方差是 d_k。/);
  assert.match(blob, /第三问/);
  assert.equal(third.messages.filter((item) => item.role === "user").length, 3);
});

test("formula image stays on the multimodal request and text is used for translation", () => {
  const image = "data:image/png;base64,QUJD";
  const seen = citationPayload({ kind: "formula", text: "E=mc^2", image, page: 4 }, "multimodal");
  assert.equal(seen.mode, "image");
  assert.equal(seen.text, "");
  const messages = buildAskMessages({
    question: "这是什么？",
    citation: { kind: "formula", page: 4, image },
    nearby: [{ bid: "n", page: 4, text: "附近一句" }],
    history: [],
    payload: seen
  });
  const blob = JSON.stringify(messages);
  assert.match(blob, /QUJD/);
  assert.equal(blob.includes("E=mc^2"), false);
  assert.match(blob, /附近一句/);
  assert.equal(blob.includes("FULLPAGE"), false);

  const text = citationPayload({ kind: "formula", text: "E=mc^2", image }, "translation");
  assert.equal(text.mode, "text");
  assert.match(text.note, /不看图/);
  assert.equal(text.image, null);
});

test("interrupt: a second begin is busy and a late settle cannot overwrite a stop", () => {
  const session = createAskSession({ ids: () => "race" });
  const route = routeOf(llm, mm);
  const begun = beginTurn(session, { question: "还在飞", route, nearby: [] });
  const second = beginTurn(session, { question: "插队", route, nearby: [] });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "busy");
  assert.equal(session.turns.length, 1);
  const generation = begun.generation;
  const stopped = stopTurn(session, generation, "半句");
  assert.equal(stopped.turn.status, "stopped");
  assert.equal(stopped.turn.answer, "半句");
  const late = settleTurn(session, generation, { ok: true, body: "不该出现" });
  assert.equal(late.stale, true);
  assert.equal(stopped.turn.answer, "半句");
  assert.equal(stopped.turn.status, "stopped");
  assert.equal(session.draft, "");
  session.draft = "草稿还在";
  session.citation = { bid: "b3", page: 4, text: "引用还在" };
  const failed = beginTurn(session, { question: "再问", route, nearby: [], citation: session.citation });
  settleTurn(session, failed.generation, { ok: false, status: 500 });
  assert.equal(session.draft, "草稿还在");
  assert.equal(session.citation.text, "引用还在");
  assert.equal(sessionInvariants(session).length, 0);
});

test("interrupt: stale save ticket cannot replace noteId, and a failed save can retry", () => {
  const session = createAskSession({ ids: () => "save" });
  const route = routeOf(llm, {});
  const begun = beginTurn(session, { question: "存一下", route, nearby: [] });
  settleTurn(session, begun.generation, { ok: true, body: "答案 $x$" });
  const claim = claimNoteSave(session, begun.turn.id);
  assert.equal(claim.ok, true);
  const busy = claimNoteSave(session, begun.turn.id);
  assert.equal(busy.reason, "busy");
  const failed = finishNoteSave(session, begun.turn.id, claim.ticket, { ok: false, reason: "failed" });
  assert.equal(failed.ok, false);
  assert.equal(begun.turn.saving, false);
  const again = claimNoteSave(session, begun.turn.id);
  const stale = finishNoteSave(session, begun.turn.id, claim.ticket, { ok: true, noteId: "old" });
  assert.equal(stale.stale, true);
  const done = finishNoteSave(session, begun.turn.id, again.ticket, { ok: true, noteId: "note-1" });
  assert.equal(done.noteId, "note-1");
  const replaced = finishNoteSave(session, begun.turn.id, again.ticket, { ok: true, noteId: "note-2" });
  assert.equal(replaced.reason, "exists");
  assert.equal(begun.turn.noteId, "note-1");
});

test("reload mid-save keeps the stored note and does not write a second copy", async () => {
  const store = createNotesStore({ memory: true });
  const session = createAskSession({ ids: () => "reload" });
  const route = routeOf(llm, mm);
  const begun = beginTurn(session, {
    question: "为什么？ <script>",
    citation: { bid: "b3", page: 4, text: "引用" },
    nearby: [],
    route
  });
  settleTurn(session, begun.generation, { ok: true, body: "因为方差。\n第二行" });
  const claim = claimNoteSave(session, begun.turn.id);
  const input = noteInputFromTurn(begun.turn, {
    docHash: "doc-attn",
    anchor: { bid: "b3", page: 4, quote: "引用" },
    page: 4
  });
  assert.equal(input.author, "ai");
  assert.equal(input.kind, "note");
  assert.equal(input.qa.model, "gpt-4o");
  assert.equal(JSON.stringify(input).includes("sk-mm-secret"), false);
  const saved = await store.put(input);
  const unloaded = createAskSession({ ids: () => "reload-2" });
  const notes = await store.list("doc-attn");
  const found = noteForTurn(notes, begun.turn.id);
  assert.equal(found.id, saved.id);
  assert.equal(noteMatchesFilter(found, "ai"), true);
  const late = finishNoteSave(unloaded, begun.turn.id, claim.ticket, { ok: true, noteId: "other" });
  assert.equal(late.stale, true);
  assert.equal((await store.list("doc-attn")).length, 1);

  const paper = noteInputFromTurn({ ...begun.turn, id: "reload:free", answer: "自由" }, { docHash: "doc-attn" });
  assert.equal(paper.kind, "paperNote");
  assert.equal(paper.anchor, null);
  await store.put(paper);
  assert.equal((await store.list("doc-attn")).filter((note) => note.qa?.turnId === "reload:free").length, 1);
});

test("boundary inputs stay intact and empty questions do not send", () => {
  const session = createAskSession({ ids: () => "edge" });
  const route = routeOf(llm, {});
  assert.equal(beginTurn(session, { question: "   ", route }).reason, "empty");
  assert.equal(beginTurn(session, { question: "", route }).reason, "empty");
  const weird = "  √d_k\t<script>\n\"引号\"  ";
  const begun = beginTurn(session, { question: weird, route, nearby: [], citation: null });
  assert.match(JSON.stringify(begun.messages), /√d_k/);
  assert.match(JSON.stringify(begun.messages), /<script>/);
  const huge = "超".repeat(8000);
  settleTurn(session, begun.generation, { ok: true, body: "ok" });
  const long = beginTurn(session, { question: huge, route, nearby: [] });
  assert.equal(long.turn.question, huge);
  assert.equal(clearTurns(session).reason, "busy");
  assert.equal(session.turns.length, 2);
  settleTurn(session, long.generation, { ok: true, body: "ok" });
  assert.equal(askActionsUseIcons(279), true);
  assert.equal(askActionsUseIcons(280), false);
  assert.equal(askActionsUseIcons(0), false);
  assert.match(askPreviewLine({ citation: { page: 4 }, host: "api.openai.com", images: 1 }), /附近 2 段/);
  assert.match(askPreviewLine({ citation: { page: 4 }, host: "api.openai.com", images: 1 }), /1 张裁图/);
  assert.equal(askPreviewLine({}).includes("问整页"), false);
  clearTurns(session);
  assert.equal(session.turns.length, 0);
});

test("retry resends the snapshotted body even after the route changes", () => {
  const session = createAskSession({ ids: () => "retry" });
  const multi = routeOf(llm, mm);
  const begun = beginTurn(session, { question: "同一句", route: multi, nearby: [{ bid: "b2", text: "附近" }] });
  const messages = begun.messages;
  settleTurn(session, begun.generation, { ok: false, status: 500 });
  const translate = routeOf(llm, {});
  assert.equal(translate.via, "translation");
  const again = retryTurn(session, begun.turn.id);
  assert.equal(again.route.via, "multimodal");
  assert.equal(again.route.host, "api.openai.com");
  assert.deepEqual(again.messages, messages);
  assert.equal(again.route.url.includes("gpt-4o-mini"), false);
});

test("error copy covers 401, 429, timeout, and offline without a fallback button", () => {
  const rows = [
    [{ via: "translation", status: 401 }, /密钥无效或没有权限（401）/, true],
    [{ via: "translation", status: 429 }, /429/, false],
    [{ via: "translation", timeout: true, host: "api.openai.com" }, /60 秒没有回应/, false],
    [{ via: "translation", offline: true }, /网络断开/, false],
    [{ via: "multimodal", status: 401 }, /多模态模型调用失败/, true]
  ];
  for (const [input, pattern, settings] of rows) {
    const model = askErrorModel(input);
    assert.match(model.text, pattern);
    assert.equal(model.fallback, false);
    assert.equal(model.settings, settings);
    assert.equal(model.text.includes("改用翻译"), false);
  }
  const vision = askErrorModel({ via: "multimodal", visionRejected: true });
  assert.match(vision.text, /改为文字/);
  assert.equal(vision.fallback, false);
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("adversarial interleaving keeps ask invariants across 500 seeds", () => {
  const routes = [routeOf(llm, mm), routeOf(llm, {})];
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = mulberry32(seed);
    const store = [];
    let session = createAskSession({ ids: () => `s${seed}` });
    let flips = 0;
    try {
      for (let step = 0; step < 24; step += 1) {
        const roll = random();
        const route = routes[flips % 2];
        if (roll < 0.18) {
          const question = roll < 0.02 ? "" : (roll < 0.04 ? `  \t` : `问${seed}-${step} √ "<>"`);
          beginTurn(session, { question, route, nearby: nearbyBlocks(attention, "b3"), citation: { bid: "b3", page: 4, text: "引用" } });
        } else if (roll < 0.34 && session.flight) {
          settleTurn(session, session.flight.generation, { ok: true, body: `答${step}` });
        } else if (roll < 0.46 && session.flight) {
          const generation = session.flight.generation;
          stopTurn(session, generation, "部分");
          settleTurn(session, generation, { ok: true, body: "迟到的成功" });
        } else if (roll < 0.58 && session.flight) {
          settleTurn(session, session.flight.generation, { ok: false, status: 500 });
        } else if (roll < 0.68) {
          flips += 1;
          const flightVia = session.flight?.via || "";
          if (flightVia) assert.equal(session.flight.via, flightVia);
        } else if (roll < 0.8) {
          const turn = session.turns.find((item) => item.status === "done" && !item.noteId && !item.saving);
          if (turn) {
            const claim = claimNoteSave(session, turn.id);
            if (claim.ok) {
              if (noteForTurn(store, turn.id)) {
                finishNoteSave(session, turn.id, claim.ticket, { ok: false, reason: "exists" });
              } else if (random() < 0.2) {
                finishNoteSave(session, turn.id, claim.ticket, { ok: false, reason: "failed" });
              } else {
                const note = { id: `n-${seed}-${step}`, qa: { turnId: turn.id }, author: "ai", deletedAt: 0 };
                store.push(note);
                finishNoteSave(session, turn.id, claim.ticket, { ok: true, noteId: note.id });
                finishNoteSave(session, turn.id, claim.ticket, { ok: true, noteId: "nope" });
              }
            }
          }
        } else if (roll < 0.9 && session.flight) {
          const generation = session.flight.generation;
          session = createAskSession({ ids: () => `s${seed}b` });
          settleTurn(session, generation, { ok: true, body: "卸载后的回写" });
        } else {
          const errored = [...session.turns].reverse().find((item) => item.status === "error");
          if (errored && !session.flight) retryTurn(session, errored.id);
        }
        const problems = sessionInvariants(session);
        if (problems.length) throw new Error(problems.join(";"));
        const seen = new Set();
        for (const note of store) {
          if (seen.has(note.qa.turnId)) throw new Error(`dup note ${note.qa.turnId}`);
          seen.add(note.qa.turnId);
        }
        for (const turn of session.turns) {
          if (turn.noteId && seen.has(turn.id)) assert.equal(store.find((note) => note.qa.turnId === turn.id).id, turn.noteId);
          assert.equal(JSON.stringify(turn).includes("sk-"), false);
        }
      }
    } catch (err) {
      throw new Error(`seed ${seed}: ${err.message}`);
    }
  }
});
