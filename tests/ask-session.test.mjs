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
  sessionSnapshot,
  settleTurn,
  stopTurn
} from "../lib/ask-session.js";
import { askRequestBody, performAsk } from "../lib/ask-transport.js";
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

test("formula citation is text only and never attaches an image", () => {
  const image = "data:image/png;base64,QUJD";
  const cite = { kind: "formula", text: "E=mc^2", latex: "\\frac{a}{b}", image, page: 4 };
  for (const via of ["multimodal", "translation"]) {
    const seen = citationPayload(cite, via);
    assert.equal(seen.mode, "text");
    assert.equal(seen.image, null);
    assert.equal(seen.text, "E=mc^2");
    assert.match(seen.note, /不看图/);
    const messages = buildAskMessages({
      question: "这是什么？",
      citation: cite,
      nearby: [{ bid: "n", page: 4, text: "附近一句" }],
      history: [],
      payload: seen
    });
    const blob = JSON.stringify(messages);
    assert.equal(blob.includes("QUJD"), false);
    assert.equal(blob.includes("image_url"), false);
    assert.equal(blob.includes("inline_data"), false);
    assert.equal(blob.includes("\\frac"), false);
    assert.match(blob, /E=mc\^2/);
    assert.match(blob, /附近一句/);
    assert.equal(blob.includes("FULLPAGE"), false);
    for (const provider of ["openai", "gemini", "claude"]) {
      const body = JSON.stringify(askRequestBody({ provider, model: "gpt-4o" }, messages));
      assert.equal(body.includes("QUJD"), false, provider);
      assert.equal(body.includes("image_url"), false, provider);
      assert.equal(body.includes("inline_data"), false, provider);
    }
  }
});

test("F6UI-21 a real formula crop is sent only on a multimodal route", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const cite = { kind: "formula", text: "E=mc^2", latex: "\\frac{a}{b}", image: png, page: 4 };
  const session = createAskSession({ ids: () => "crop" });
  const begun = beginTurn(session, {
    question: "这是什么？",
    route: routeOf(llm, mm),
    nearby: [{ bid: "n", page: 4, text: "附近一句" }],
    citation: cite
  });
  assert.equal(begun.turn.payload.mode, "image");
  assert.equal(begun.turn.payload.note, "");
  assert.equal(begun.turn.payload.image.mime, "image/png");
  assert.match(begun.turn.payload.image.base64, /^iVBORw0KGgo/);
  assert.equal(begun.turn.citation.image, undefined);
  assert.equal(cite.image, png);
  const stored = JSON.stringify(begun.turn.messages);
  assert.match(stored, /"type":"image"/);
  assert.match(stored, /iVBORw0KGgo/);
  assert.equal(stored.includes("image_url"), false);
  assert.equal(stored.includes("inline_data"), false);
  assert.equal(stored.includes("\\frac"), false);
  assert.equal(sessionInvariants(session).length, 0);
  const openai = JSON.stringify(askRequestBody({ provider: "openai", model: "gpt-4o" }, begun.turn.messages));
  assert.match(openai, /image_url/);
  assert.match(openai, /data:image\/png;base64,iVBORw0KGgo/);
  const gemini = JSON.stringify(askRequestBody({ provider: "gemini", model: "gemini" }, begun.turn.messages));
  assert.match(gemini, /inline_data/);
  assert.match(gemini, /iVBORw0KGgo/);
  const claude = JSON.stringify(askRequestBody({ provider: "claude", model: "claude" }, begun.turn.messages));
  assert.match(claude, /"media_type":"image\/png"/);
  assert.match(claude, /"type":"base64"/);
  assert.equal(JSON.stringify(begun.turn.messages).includes("image_url"), false);

  const text = beginTurn(createAskSession({ ids: () => "textcrop" }), {
    question: "文字模型",
    route: routeOf(llm, {}),
    nearby: [],
    citation: { ...cite }
  });
  assert.equal(text.turn.payload.mode, "text");
  assert.equal(text.turn.payload.image, null);
  assert.match(text.turn.payload.note, /不看图/);
  assert.equal(JSON.stringify(text.turn.messages).includes("iVBORw0KGgo"), false);

  const forced = beginTurn(createAskSession({ ids: () => "forcecrop" }), {
    question: "强制文字",
    route: routeOf(llm, mm),
    nearby: [],
    citation: { ...cite },
    forceText: true
  });
  assert.equal(forced.turn.payload.mode, "text");
  assert.match(forced.turn.payload.note, /公式改为文字发送/);
  assert.equal(JSON.stringify(forced.turn.messages).includes("iVBORw0KGgo"), false);

  const plain = citationPayload({ kind: "text", text: "句子", image: png }, "multimodal");
  assert.equal(plain.mode, "text");
  assert.equal(plain.image, null);
  const smuggled = sessionInvariants({
    generation: 1,
    turns: [{
      id: "x:1",
      payload: { mode: "image", image: { mime: "image/png", base64: "abc" } },
      citation: { kind: "text" },
      route: { via: "multimodal" },
      messages: []
    }],
    flight: null
  });
  assert.ok(smuggled.some((item) => item.includes("image")));
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
  assert.equal(input.id, `ask:${begun.turn.id}`);
  assert.equal(input.qa.model, "gpt-4o");
  assert.equal(input.body, "因为方差。\n第二行");
  assert.equal(JSON.stringify(input).includes("sk-mm-secret"), false);
  const reloaded = createAskSession({ ids: () => "reload-2" });
  reloaded.turns.push({ ...begun.turn, noteId: "", saving: false, saveTicket: 0 });
  const late = finishNoteSave(reloaded, begun.turn.id, claim.ticket, { ok: true, noteId: "ghost-reload" });
  assert.equal(late.ok, false);
  assert.equal(late.stale, true);
  assert.equal(reloaded.turns[0].noteId, "");
  if (late.ok) await store.put({ ...input, id: "ghost-reload" });
  assert.equal((await store.list("doc-attn")).some((note) => note.id === "ghost-reload"), false);
  const saved = await store.put(input);
  const notes = await store.list("doc-attn");
  assert.equal(notes.length, 1);
  const found = noteForTurn(notes, begun.turn.id);
  assert.equal(found.id, saved.id);
  assert.equal(found.body, input.body);
  assert.equal(found.author, "ai");
  assert.equal(found.qa.turnId, begun.turn.id);
  assert.equal(noteMatchesFilter(found, "ai"), true);
  await store.put({ ...input, body: input.body });
  assert.equal((await store.list("doc-attn")).length, 1);
  assert.equal(noteForTurn(await store.list("doc-attn"), begun.turn.id).id, saved.id);

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
  const nearOne = [{ bid: "b2", text: "只有一段" }];
  const prior = [{ status: "done", question: "上一问", answer: "上一答" }];
  const preview = askPreviewLine({
    citation: { page: 4, kind: "formula", image: "data:image/png;base64,QUJD", text: "E=mc^2" },
    host: "api.openai.com",
    nearby: nearOne,
    history: prior
  });
  const messages = buildAskMessages({
    question: "这句呢",
    citation: { page: 4, kind: "formula", text: "E=mc^2" },
    nearby: nearOne,
    history: prior,
    payload: { text: "E=mc^2" }
  });
  const user = messages.filter((item) => item.role === "user").pop().content;
  const sentNear = (user.split("附近段落：\n")[1] || "").split("\n\n问题：")[0];
  const sentCount = sentNear.split("\n\n").map((part) => part.trim()).filter(Boolean).length;
  const assistants = messages.filter((item) => item.role === "assistant").length;
  assert.equal(sentCount, 1);
  assert.equal(assistants, 1);
  assert.match(preview, new RegExp(`附近 ${sentCount} 段`));
  assert.match(preview, new RegExp(`历史 ${assistants} 轮`));
  assert.match(user, /E=mc\^2/);
  assert.match(user, /只有一段/);
  assert.match(messages.filter((item) => item.role === "assistant").pop().content, /上一答/);
  assert.equal(preview.includes("附近 2 段"), false);
  assert.equal(preview.includes("裁图"), false);
  assert.equal(preview.includes("QUJD"), false);
  assert.equal(askPreviewLine({}).includes("问整页"), false);
  assert.equal(askPreviewLine({}).includes("附近"), false);
  assert.equal(askPreviewLine({}).includes("历史"), false);
  const bare = { bid: "b3", page: 4, kind: "text", text: "" };
  const bareLine = askPreviewLine({
    citation: bare,
    nearby: [{ bid: "b2", text: "" }, { bid: "b4", text: "有字的附近段" }]
  });
  const bareMessages = buildAskMessages({
    question: "空引用",
    citation: bare,
    nearby: [{ bid: "b2", text: "" }, { bid: "b4", text: "有字的附近段" }],
    history: [],
    payload: citationPayload(bare, "translation")
  });
  const bareUser = bareMessages.filter((item) => item.role === "user").pop().content;
  assert.equal(bareUser.includes("引用（"), false);
  assert.equal(bareLine.includes("引用"), false);
  assert.match(bareUser, /有字的附近段/);
  assert.match(bareLine, /附近 1 段/);
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
    [{ via: "multimodal", status: 401 }, /多模态模型调用失败（401）/, true]
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
  const multi500 = askErrorModel({ via: "multimodal", status: 500 });
  assert.equal(multi500.text, "多模态模型调用失败（500）");
  assert.equal(multi500.text.includes(" · "), false);
  const timed = askErrorModel({ via: "multimodal", timeout: true, host: "api.openai.com" });
  assert.equal(timed.text, "多模态模型调用失败 · api.openai.com 60 秒没有回应");
  assert.equal(timed.text.includes("（错误）"), false);
});

test("a plan-endpoint 401 tells pay-as-you-go keys to use /api/v3", () => {
  const plan = "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions";
  const direct = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
  const session = createAskSession({ ids: () => "plan-401" });
  const begun = beginTurn(session, {
    question: "这句",
    route: {
      ok: true,
      via: "multimodal",
      provider: "doubao",
      model: "glm-5.3-flash",
      url: plan,
      host: "ark.cn-beijing.volces.com"
    }
  });
  settleTurn(session, begun.generation, { ok: false, status: 401 });
  assert.equal(begun.turn.error.url, plan);
  const model = askErrorModel(begun.turn.error);
  assert.match(model.text, /多模态模型调用失败（401）/);
  assert.match(model.text, /按量密钥/);
  assert.match(model.text, /https:\/\/ark\.cn-beijing\.volces\.com\/api\/v3/);
  assert.equal(model.text.includes("/api/plan"), false);

  const directModel = askErrorModel({ via: "multimodal", status: 401, url: direct });
  assert.match(directModel.text, /多模态模型调用失败（401）/);
  assert.equal(directModel.text.includes("按量"), false);
  const translate = askErrorModel({ via: "translation", status: 401, url: plan });
  assert.match(translate.text, /密钥无效（401）/);
  assert.match(translate.text, /\/api\/v3/);
  const plain = askErrorModel({ via: "translation", status: 401 });
  assert.equal(plain.text, "密钥无效或没有权限（401）");
  const other = askErrorModel({ via: "translation", status: 401, url: "https://api.openai.com/v1/chat/completions" });
  assert.equal(other.text.includes("按量"), false);
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

function openTab(seed, tab, step) {
  const session = createAskSession({ ids: () => `s${seed}t${tab}x${step}` });
  session.draft = `草稿${seed}-${tab}`;
  session.citation = { bid: "b3", page: 4, text: `引用${tab}` };
  session.route = {
    ok: true,
    via: "multimodal",
    provider: "openai",
    model: "gpt-4o",
    url: "https://api.openai.com/v1/chat/completions",
    host: "api.openai.com"
  };
  return session;
}

const OTHER_ROUTE = {
  via: "translation",
  provider: "deepseek",
  model: "deepseek-chat",
  url: "https://api.deepseek.com/v1/chat/completions",
  host: "api.deepseek.com"
};

function writeRoute(target, source) {
  target.ok = true;
  target.via = source.via;
  target.provider = source.provider;
  target.model = source.model;
  target.url = source.url;
  target.host = source.host;
}

test("in-flight request keeps its route snapshot when the live route url and host change", () => {
  const session = createAskSession({ ids: () => "flip" });
  const live = {
    ok: true,
    via: "multimodal",
    provider: "openai",
    model: "gpt-4o",
    url: "https://api.openai.com/v1/chat/completions",
    host: "api.openai.com"
  };
  session.route = live;
  const begun = beginTurn(session, {
    question: "飞行中",
    route: session.route,
    nearby: [{ bid: "b2", text: "附近" }]
  });
  assert.equal(begun.ok, true);
  const started = { via: begun.route.via, url: begun.route.url, host: begun.route.host };
  writeRoute(live, OTHER_ROUTE);
  assert.equal(session.flight.url, started.url);
  assert.equal(session.flight.host, started.host);
  assert.equal(session.flight.via, started.via);
  assert.equal(begun.turn.route.url, started.url);
  assert.equal(begun.turn.route.host, started.host);
  assert.notEqual(begun.turn.route.url, live.url);
  assert.notEqual(begun.turn.route.host, live.host);
  assert.notEqual(begun.turn.route, live);
  settleTurn(session, begun.generation, { ok: true, body: "答" });
  const next = beginTurn(session, { question: "下一轮", route: session.route, nearby: [] });
  assert.equal(next.ok, true);
  assert.equal(next.route.url, live.url);
  assert.equal(next.route.host, live.host);
  assert.equal(next.route.via, "translation");
  assert.equal(begun.turn.route.url, started.url);
  assert.equal(begun.turn.route.host, started.host);
});

test("session invariants reject an in-flight host change", () => {
  const session = createAskSession({ ids: () => "host" });
  beginTurn(session, {
    question: "主机",
    route: {
      ok: true,
      via: "multimodal",
      provider: "openai",
      model: "gpt-4o",
      url: "https://api.openai.com/v1/chat/completions",
      host: "api.openai.com"
    },
    nearby: []
  });
  const previous = sessionSnapshot(session);
  assert.deepEqual(sessionInvariants(session, previous), []);
  session.flight.host = "api.deepseek.com";
  assert.ok(sessionInvariants(session, previous).includes("inflight retargeted"));
});

test("adversarial interleaving keeps ask invariants across 500 seeds", () => {
  let crossRouteFlights = 0;
  let midSaveUnloads = 0;
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = mulberry32(seed);
    const store = [];
    const tabs = [0, 1, 2].map((tab) => openTab(seed, tab, 0));
    const previous = tabs.map((session) => sessionSnapshot(session));
    try {
      for (let step = 0; step < 24; step += 1) {
        const roll = random();
        const tab = Math.floor(random() * tabs.length);
        let session = tabs[tab];
        let replaced = false;
        if (roll < 0.16) {
          const question = roll < 0.02 ? "" : (roll < 0.04 ? `  \t` : `问${seed}-${tab}-${step} √ "<>"`);
          const begun = beginTurn(session, {
            question,
            route: session.route,
            nearby: nearbyBlocks(attention, "b3"),
            citation: { bid: "b3", page: 4, text: "引用", image: "data:image/png;base64,QUJD" }
          });
          if (begun.ok) {
            if (begun.route.url !== session.route.url || begun.route.host !== session.route.host || begun.route.via !== session.route.via) {
              throw new Error("next turn ignored the live route");
            }
            if (begun.turn.route === session.route) throw new Error("turn stored the live route object");
          }
        } else if (roll < 0.3 && session.flight) {
          settleTurn(session, session.flight.generation, { ok: true, body: `答${step}` });
        } else if (roll < 0.4 && session.flight) {
          const generation = session.flight.generation;
          stopTurn(session, generation, "部分");
          settleTurn(session, generation, { ok: true, body: "迟到的成功" });
        } else if (roll < 0.5 && session.flight) {
          const via = session.flight.via;
          const before = session.turns.length;
          settleTurn(session, session.flight.generation, { ok: false, status: 500 });
          if (via === "multimodal" && session.turns.length !== before) {
            throw new Error("multimodal failure allocated another turn");
          }
        } else if (roll < 0.62) {
          const inflight = session.flight
            ? session.turns.find((item) => item.id === session.flight.turnId)
            : null;
          const started = inflight ? {
            via: inflight.route.via,
            url: inflight.route.url,
            host: inflight.route.host
          } : null;
          const liveBefore = {
            via: session.route.via,
            url: session.route.url,
            host: session.route.host
          };
          const next = liveBefore.host === OTHER_ROUTE.host ? {
            via: "multimodal",
            provider: "openai",
            model: "gpt-4o",
            url: "https://api.openai.com/v1/chat/completions",
            host: "api.openai.com"
          } : OTHER_ROUTE;
          writeRoute(session.route, next);
          if (session.route.url !== next.url || session.route.host !== next.host || session.route.via !== next.via) {
            throw new Error("new route was not applied to the session");
          }
          if (next.url === liveBefore.url || next.host === liveBefore.host) {
            throw new Error("new route did not change url and host");
          }
          if (started) {
            if (session.flight.via !== started.via || session.flight.url !== started.url || session.flight.host !== started.host) {
              throw new Error("route flip retargeted the flight");
            }
            if (inflight.route.via !== started.via || inflight.route.url !== started.url || inflight.route.host !== started.host) {
              throw new Error("route flip retargeted the snapshotted turn");
            }
            if (inflight.route === session.route) throw new Error("turn stored the live route object");
            crossRouteFlights += 1;
          }
        } else if (roll < 0.76) {
          const saving = session.turns.find((item) => item.saving);
          if (saving) {
            const ticket = saving.saveTicket;
            if (noteForTurn(store, saving.id)) {
              finishNoteSave(session, saving.id, ticket, { ok: false, reason: "exists" });
            } else if (random() < 0.25) {
              finishNoteSave(session, saving.id, ticket, { ok: false, reason: "failed" });
            } else {
              const note = {
                id: `ask:${saving.id}`,
                qa: { turnId: saving.id },
                author: "ai",
                body: saving.answer || `答${step}`,
                deletedAt: 0
              };
              store.push(note);
              finishNoteSave(session, saving.id, ticket, { ok: true, noteId: note.id });
              finishNoteSave(session, saving.id, ticket, { ok: true, noteId: "nope" });
            }
          } else {
            const turn = session.turns.find((item) => item.status === "done" && !item.noteId && !item.saving);
            if (turn) claimNoteSave(session, turn.id);
          }
        } else if (roll < 0.9) {
          const saving = session.turns.find((item) => item.saving);
          if (saving) {
            midSaveUnloads += 1;
            const ticket = saving.saveTicket;
            const turnId = saving.id;
            const fresh = openTab(seed, tab, step + 1);
            fresh.turns.push({ ...saving, noteId: "", saving: false, saveTicket: 0 });
            const ghostId = `ghost-${seed}-${step}`;
            const late = finishNoteSave(fresh, turnId, ticket, { ok: true, noteId: ghostId });
            if (late.ok || fresh.turns.some((item) => item.noteId === ghostId)) {
              store.push({ id: ghostId, qa: { turnId }, author: "ai", body: "ghost", deletedAt: 0 });
              throw new Error("reloaded tab accepted an in-flight save");
            }
            if (store.some((note) => note.id === ghostId)) throw new Error("ghost note landed");
            if (!noteForTurn(store, turnId)) {
              const note = {
                id: `ask:${turnId}`,
                qa: { turnId },
                author: "ai",
                body: "完整",
                deletedAt: 0
              };
              store.push(note);
              finishNoteSave(session, turnId, ticket, { ok: true, noteId: note.id });
            }
            const copies = store.filter((note) => note.qa?.turnId === turnId);
            if (copies.length !== 1) throw new Error(`note copies ${copies.length} for ${turnId}`);
            if (!copies[0].id || !copies[0].author || !copies[0].body || !copies[0].qa.turnId) {
              throw new Error(`partial note ${turnId}`);
            }
            tabs[tab] = fresh;
            previous[tab] = null;
            replaced = true;
            session = fresh;
          } else if (session.flight) {
            const generation = session.flight.generation;
            const fresh = openTab(seed, tab, step + 1);
            const late = settleTurn(fresh, generation, { ok: true, body: "卸载后的回写" });
            if (!late.stale || fresh.turns.length) throw new Error("unloaded settle wrote a turn");
            tabs[tab] = fresh;
            previous[tab] = null;
            replaced = true;
            session = fresh;
          }
        } else {
          const errored = [...session.turns].reverse().find((item) => item.status === "error" || item.status === "stopped");
          if (errored && !session.flight && errored.status === "error") retryTurn(session, errored.id);
        }
        if (!replaced) tabs[tab] = session;
        for (let index = 0; index < tabs.length; index += 1) {
          const problems = sessionInvariants(tabs[index], previous[index]);
          if (problems.length) throw new Error(`tab ${index}: ${problems.join(";")}`);
          previous[index] = sessionSnapshot(tabs[index]);
          for (const turn of tabs[index].turns) {
            if (JSON.stringify(turn).includes("sk-")) throw new Error(`key on ${turn.id}`);
            if (turn.noteId) {
              const note = store.find((item) => item.qa.turnId === turn.id);
              if (note && note.id !== turn.noteId) throw new Error(`noteId mismatch ${turn.id}`);
            }
          }
        }
        const seen = new Set();
        for (const note of store) {
          if (!note.id || !note.author || !note.body || !note.qa?.turnId) throw new Error("partial note");
          if (seen.has(note.qa.turnId)) throw new Error(`dup note ${note.qa.turnId}`);
          seen.add(note.qa.turnId);
        }
      }
    } catch (err) {
      throw new Error(`seed ${seed}: ${err.message}`);
    }
  }
  assert.ok(crossRouteFlights > 0, "route flip never observed a live flight against a different route");
  assert.ok(midSaveUnloads > 0, "unload never landed while a note save was in progress");
});
