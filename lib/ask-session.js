/**
 * One Ask-AI conversation.
 *
 * Invariants (checked by tests after every mutation):
 * 1. generation only increases. A settle whose generation is not the
 *    current flight is stale and must not write that turn.
 * 2. noteId is write-once. A later save ticket cannot replace it.
 * 3. The route (via, url, and host) and message body are snapshotted
 *    at send. A storage change does not retarget the in-flight request.
 * 4. Draft text and the citation chip are not cleared by a failed,
 *    stopped, or stale turn.
 * 5. Multimodal failure does not allocate a second request.
 * 6. Session ids are unique across loads, documents, and tabs. A new
 *    page does not start again at ask-1.
 * 7. A listed note is adopted only when its docHash and turnId match
 *    exactly and the id is already durable. ✓ means that record exists.
 * 8. A failed put leaves pendingDisk set and noteId empty, so the retry
 *    writes instead of adopting the in-memory row.
 */

import { ASK_CONTEXT_NEARBY } from "./ask-model.js";

export { ASK_CONTEXT_NEARBY };

let fallbackSeq = 0;

/** Alphanumeric doc scope. Empty hashes share one label and still get a nonce. */
export function askScope(docHash) {
  const raw = String(docHash || "").replace(/[^a-zA-Z0-9]/g, "");
  return (raw || "nodoc").slice(0, 32);
}

/**
 * Interrupt point: crypto.randomUUID is synchronous here. Two calls in the
 * same millisecond still differ. The counter fallback is only for a runtime
 * without crypto, and it still advances so a second load is not ask-1.
 */
export function askNonce() {
  const cryptoObj = globalThis.crypto;
  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID().replace(/-/g, "");
  }
  if (typeof cryptoObj?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  fallbackSeq += 1;
  return `t${Date.now().toString(36)}${fallbackSeq}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function askSessionId(docHash, nonce) {
  return `ask-${askScope(docHash)}-${nonce}`;
}

export function createAskSession(options = {}) {
  const docHash = String(options.docHash || "");
  const idLocked = typeof options.ids === "function";
  const nonce = options.nonce || (idLocked ? "" : askNonce());
  const ids = options.ids || (() => askSessionId(docHash, nonce));
  return {
    id: ids(),
    turns: [],
    draft: "",
    citation: null,
    generation: 0,
    flight: null,
    ids,
    docHash,
    nonce,
    idLocked
  };
}

/**
 * Interrupt point: a new PDF in this tab. The in-flight generation is
 * dropped first, so a late response cannot fill the cleared turns.
 * The next id belongs to docHash. Draft and history do not carry over.
 */
export function resetAskSession(session, docHash) {
  if (!session) return null;
  if (session.flight?.controller) {
    try { session.flight.controller.abort(); } catch { /* already aborted */ }
  }
  session.flight = null;
  session.turns = [];
  session.draft = "";
  session.citation = null;
  session.generation += 1;
  if (!session.idLocked) {
    session.nonce = askNonce();
    session.docHash = null;
    session.id = "";
    bindAskDoc(session, docHash || "");
  }
  return session;
}

/**
 * Interrupt point: before the first turn. A later document switch must not
 * rename ids that were already given out.
 */
export function bindAskDoc(session, docHash) {
  if (!session || session.idLocked) return session;
  if (session.turns.length || session.flight) return session;
  const hash = String(docHash || "");
  if (!session.nonce) session.nonce = askNonce();
  if (session.docHash === hash && session.id) return session;
  session.docHash = hash;
  session.id = askSessionId(hash, session.nonce);
  return session;
}

export function slimBlock(block) {
  return {
    bid: String(block?.bid || block?.id || ""),
    page: Number(block?.page) || 0,
    text: String(block?.text || "")
  };
}

/** The `count` closest neighbors, in document order. The focus block is the citation, not "nearby". */
export function nearbyBlocks(blocks, focusId, count = ASK_CONTEXT_NEARBY) {
  const list = Array.isArray(blocks) ? blocks.map(slimBlock) : [];
  const want = Math.max(0, Number(count) || 0);
  if (!list.length || want === 0) return [];
  let index = list.findIndex((block) => block.bid && block.bid === String(focusId || ""));
  if (index < 0) return list.slice(0, want);
  const picked = [];
  for (let dist = 1; dist < list.length && picked.length < want; dist += 1) {
    if (index - dist >= 0) picked.push(list[index - dist]);
    if (picked.length >= want) break;
    if (index + dist < list.length) picked.push(list[index + dist]);
  }
  return picked.sort((a, b) => list.findIndex((item) => item.bid === a.bid) - list.findIndex((item) => item.bid === b.bid));
}

/** F6a sends the citation text only. Formula crops stay out of the request until F6b. */
export function citationPayload(citation, _via, { forceText = false } = {}) {
  const formula = citation?.kind === "formula";
  const text = String(citation?.text || "");
  if (formula) {
    return {
      mode: "text",
      image: null,
      text,
      note: forceText ? "公式改为文字发送" : "当前模型不看图，公式按文字发送"
    };
  }
  return { mode: "text", image: null, text, note: "" };
}

export function snapshotRoute(route) {
  if (!route || route.ok === false) {
    return { ok: false, via: "none", provider: "", model: "", url: "", host: "", message: route?.message || "" };
  }
  return {
    ok: true,
    via: route.via === "multimodal" ? "multimodal" : "translation",
    provider: String(route.provider || ""),
    model: String(route.model || ""),
    url: String(route.url || ""),
    host: String(route.host || "")
  };
}

export function buildAskMessages({ question, citation, nearby, history, payload }) {
  const prior = (history || []).filter((turn) => turn && turn.status === "done" && turn.answer);
  const messages = [{
    role: "system",
    content: "你是论文阅读助手。只根据本次给出的引用和附近段落回答。不要假设自己看到了整页 PDF。"
  }];
  for (const turn of prior) {
    messages.push({ role: "user", content: String(turn.question || "") });
    messages.push({ role: "assistant", content: String(turn.answer || "") });
  }
  const page = citation?.page ? `原文第 ${citation.page} 页` : "未分页";
  const section = citation?.section ? ` · ${citation.section}` : "";
  const lines = [];
  if (payload?.text) lines.push(`引用（${page}${section}）：\n${payload.text}`);
  if (nearby?.length) lines.push(`附近段落：\n${nearby.map((block) => block.text).filter(Boolean).join("\n\n")}`);
  lines.push(`问题：\n${question}`);
  messages.push({ role: "user", content: lines.join("\n\n") });
  return messages;
}

function historyBefore(session, turnId) {
  const index = session.turns.findIndex((turn) => turn.id === turnId);
  const prior = index < 0 ? session.turns : session.turns.slice(0, index);
  return prior.filter((turn) => turn.status === "done");
}

/**
 * Interrupt point: this function is synchronous. The flight slot is claimed
 * before it returns, so a second caller sees `busy` and does not push a turn.
 */
export function beginTurn(session, input = {}) {
  if (!session) return { ok: false, reason: "missing" };
  if (session.flight) return { ok: false, reason: "busy", generation: session.generation };
  const question = String(input.question ?? "");
  if (!question.trim()) return { ok: false, reason: "empty" };
  const route = snapshotRoute(input.route);
  if (!route.ok) return { ok: false, reason: "unconfigured", route };
  const generation = session.generation + 1;
  session.generation = generation;
  const citation = input.citation ? { ...input.citation } : null;
  if (citation) delete citation.image;
  const payload = citationPayload(citation, route.via, { forceText: input.forceText === true });
  const nearby = Array.isArray(input.nearby) ? input.nearby.map(slimBlock) : [];
  const id = `${session.id}:${generation}`;
  const turn = {
    id,
    question,
    answer: "",
    status: "pending",
    citation,
    nearby,
    payload,
    route,
    noteId: "",
    saving: false,
    saveTicket: 0,
    error: null,
    messages: null
  };
  turn.messages = buildAskMessages({
    question,
    citation,
    nearby,
    history: historyBefore(session, id),
    payload
  });
  session.turns.push(turn);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  session.flight = {
    generation,
    turnId: id,
    via: route.via,
    host: route.host,
    url: route.url,
    controller
  };
  return {
    ok: true,
    generation,
    turn,
    messages: turn.messages,
    route,
    signal: controller ? controller.signal : null
  };
}

/**
 * Interrupt point: after the network returns. A stop, a newer turn, or a
 * disposed flight makes this a no-op.
 */
export function settleTurn(session, generation, result) {
  if (!session?.flight || session.flight.generation !== generation) {
    return { ok: false, stale: true };
  }
  const turn = session.turns.find((item) => item.id === session.flight.turnId) || null;
  session.flight = null;
  if (!turn || turn.status === "stopped") return { ok: false, stale: true, turn };
  if (result?.stopped) {
    turn.status = "stopped";
    turn.answer = String(result.body || "");
    turn.error = null;
    return { ok: true, stale: false, turn };
  }
  if (!result || result.ok === false) {
    turn.status = "error";
    turn.error = {
      via: turn.route?.via || "",
      status: Number(result?.status) || 0,
      host: turn.route?.host || "",
      timeout: result?.timeout === true,
      offline: result?.offline === true,
      visionRejected: result?.visionRejected === true,
      fallback: false
    };
    return { ok: true, stale: false, turn };
  }
  turn.status = "done";
  turn.answer = String(result.body || "");
  turn.error = null;
  return { ok: true, stale: false, turn };
}

/**
 * Interrupt point: abort the socket, then invalidate the generation so a
 * late response cannot fill the turn. Partial text already on the result
 * is kept by the caller via settle, or passed here as `partial`.
 */
export function stopTurn(session, generation, partial = "") {
  if (!session?.flight || session.flight.generation !== generation) {
    return { ok: false, stale: true };
  }
  const turn = session.turns.find((item) => item.id === session.flight.turnId) || null;
  try { session.flight.controller?.abort(); } catch { /* already aborted */ }
  session.flight = null;
  session.generation += 1;
  if (turn && turn.status === "pending") {
    turn.status = "stopped";
    turn.answer = String(partial || "");
  }
  return { ok: true, stale: false, turn };
}

export function retryTurn(session, turnId) {
  const turn = session?.turns?.find((item) => item.id === turnId) || null;
  if (!turn) return { ok: false, reason: "missing" };
  if (session.flight) return { ok: false, reason: "busy" };
  if (turn.status !== "error" && turn.status !== "stopped") return { ok: false, reason: "state" };
  const generation = session.generation + 1;
  session.generation = generation;
  turn.status = "pending";
  turn.error = null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  session.flight = {
    generation,
    turnId: turn.id,
    via: turn.route?.via || "",
    host: turn.route?.host || "",
    url: turn.route?.url || "",
    controller
  };
  return {
    ok: true,
    generation,
    turn,
    messages: turn.messages,
    route: turn.route,
    signal: controller ? controller.signal : null
  };
}

export function clearTurns(session) {
  if (!session) return { ok: false, reason: "missing" };
  if (session.flight) return { ok: false, reason: "busy" };
  session.turns = [];
  session.generation += 1;
  return { ok: true };
}

/**
 * Interrupt point: the ticket is claimed before the note put is awaited.
 * A second claim while saving is busy. After failure the flag drops so
 * retry can claim a new ticket. The old ticket cannot finish the new one.
 */
export function claimNoteSave(session, turnId) {
  const turn = session?.turns?.find((item) => item.id === turnId) || null;
  if (!turn || turn.status !== "done" || !String(turn.answer || "").trim()) {
    return { ok: false, reason: "missing" };
  }
  if (turn.noteId) return { ok: false, reason: "exists", noteId: turn.noteId };
  if (turn.saving) return { ok: false, reason: "busy" };
  turn.saving = true;
  turn.saveTicket += 1;
  return { ok: true, ticket: turn.saveTicket, turn };
}

/**
 * Interrupt point: the put already resolved or rejected. A stale ticket,
 * a missing turn, or an existing noteId does not overwrite the id.
 * A rejected put sets pendingDisk and leaves noteId empty.
 */
export function finishNoteSave(session, turnId, ticket, result) {
  const turn = session?.turns?.find((item) => item.id === turnId) || null;
  if (!turn) return { ok: false, stale: true, reason: "missing" };
  if (turn.saveTicket !== ticket) return { ok: false, stale: true, reason: "ticket", noteId: turn.noteId };
  turn.saving = false;
  if (turn.noteId) {
    turn.pendingDisk = false;
    return { ok: false, reason: "exists", noteId: turn.noteId };
  }
  if (result?.ok && result.noteId) {
    turn.noteId = String(result.noteId);
    turn.pendingDisk = false;
    return { ok: true, noteId: turn.noteId };
  }
  turn.pendingDisk = true;
  return { ok: false, reason: result?.reason || "failed" };
}

function anchorParts(value) {
  if (!value || typeof value !== "object") return { anchor: null, anchorState: null };
  const nested = value.anchor && typeof value.anchor === "object" ? value.anchor : null;
  if (nested && (nested.bid || nested.quote)) {
    return { anchor: nested, anchorState: value.anchorState || null };
  }
  if (value.bid || value.quote) return { anchor: value, anchorState: value.anchorState || null };
  return { anchor: null, anchorState: null };
}

export function noteInputFromTurn(turn, { docHash, anchor = null, page = 0 } = {}) {
  const model = turn?.route?.model || "";
  const sessionId = String(turn?.id || "").split(":")[0] || "";
  const placed = anchorParts(anchor);
  const anchored = Boolean(placed.anchor);
  return {
    docHash: String(docHash || ""),
    kind: anchored ? "note" : "paperNote",
    author: "ai",
    body: String(turn?.answer || ""),
    title: model ? `AI · ${model}` : "AI",
    page: Number(page || placed.anchor?.page || turn?.citation?.page) || 0,
    anchor: anchored ? placed.anchor : null,
    anchorState: anchored ? placed.anchorState : null,
    qa: {
      sessionId,
      turnId: String(turn?.id || ""),
      question: String(turn?.question || ""),
      answer: String(turn?.answer || ""),
      model
    },
    id: turn?.id ? `ask:${turn.id}` : ""
  };
}

/**
 * Exact turn, and exact document when docHash is passed. A prefix such as
 * ask-1 against ask-1:1 does not match. Omitting docHash keeps older callers
 * that only know the turn.
 */
export function noteForTurn(notes, turnId, docHash) {
  const id = String(turnId || "");
  if (!id) return null;
  const doc = docHash == null ? null : String(docHash);
  return (notes || []).find((note) => {
    if (!note || note.deletedAt) return false;
    if (note.qa?.turnId !== id) return false;
    if (doc != null && String(note.docHash || "") !== doc) return false;
    return true;
  }) || null;
}

/**
 * Interrupt point: the notes list is read before the put. A row is adopted
 * only when docHash and turnId match and `durableIds` already contains its
 * id. pendingDisk means the last put did not confirm, so the caller writes.
 */
export function planNoteSave(turn, notes, docHash, durableIds) {
  if (!turn) return { action: "missing" };
  if (turn.noteId) return { action: "exists", noteId: turn.noteId };
  if (!turn.pendingDisk) {
    const prior = noteForTurn(notes, turn.id, docHash);
    if (prior && durableIds && typeof durableIds.has === "function" && durableIds.has(prior.id)) {
      return { action: "reuse", noteId: prior.id };
    }
  }
  return { action: "write" };
}

export function sessionSnapshot(session) {
  return {
    generation: session?.generation ?? 0,
    draft: session?.draft ?? "",
    citation: session?.citation ? { ...session.citation } : null,
    flight: session?.flight ? {
      generation: session.flight.generation,
      via: session.flight.via,
      url: session.flight.url,
      host: session.flight.host
    } : null,
    turns: (session?.turns || []).map((turn) => ({
      id: turn.id,
      noteId: turn.noteId || "",
      status: turn.status,
      answer: turn.answer,
      via: turn.route?.via || "",
      messages: turn.messages
    }))
  };
}

export function sessionInvariants(session, previous) {
  const problems = [];
  if (!session) return ["missing session"];
  if (!Number.isInteger(session.generation) || session.generation < 0) problems.push("generation");
  const ids = new Set();
  let maxGen = 0;
  for (const turn of session.turns) {
    if (ids.has(turn.id)) problems.push(`dup ${turn.id}`);
    ids.add(turn.id);
    const gen = Number(String(turn.id).split(":").pop());
    if (Number.isFinite(gen)) maxGen = Math.max(maxGen, gen);
    if (turn.noteId && turn.saving) problems.push(`saving with note ${turn.id}`);
    if (turn.noteId && turn.pendingDisk) problems.push(`checked while pending ${turn.id}`);
    if (turn.error && turn.error.fallback !== false && turn.status === "error") problems.push(`fallback ${turn.id}`);
    if (turn.route && Object.prototype.hasOwnProperty.call(turn.route, "apiKey")) problems.push(`key on route ${turn.id}`);
    if (Object.prototype.hasOwnProperty.call(turn, "apiKey")) problems.push(`key on turn ${turn.id}`);
    if (turn.payload?.image || turn.payload?.mode === "image") problems.push(`image payload ${turn.id}`);
    const blob = JSON.stringify(turn.messages || "");
    if (blob.includes("image_url") || blob.includes("inline_data")) problems.push(`image message ${turn.id}`);
  }
  if (session.flight) {
    if (session.flight.generation !== session.generation) problems.push("flight generation drifted");
    if (session.flight.generation < maxGen) problems.push("flight behind turn");
  }
  if (!previous) return problems;
  if (session.generation < previous.generation) problems.push("generation decreased");
  if (session.draft !== previous.draft) problems.push("draft cleared");
  if (JSON.stringify(session.citation || null) !== JSON.stringify(previous.citation || null)) problems.push("citation cleared");
  const oldById = new Map((previous.turns || []).map((turn) => [turn.id, turn]));
  for (const turn of session.turns) {
    const old = oldById.get(turn.id);
    if (!old) continue;
    if (old.noteId && turn.noteId !== old.noteId) problems.push(`noteId replaced ${turn.id}`);
    if (old.via && turn.route?.via !== old.via) problems.push(`route changed ${turn.id}`);
    if (old.messages != null && JSON.stringify(turn.messages) !== JSON.stringify(old.messages)) {
      problems.push(`messages changed ${turn.id}`);
    }
    if (old.status === "stopped" && turn.answer !== old.answer) problems.push(`stale write ${turn.id}`);
    if (old.status === "done" && turn.answer !== old.answer) problems.push(`done answer replaced ${turn.id}`);
    if (old.status === "pending" && turn.status === "error" && old.via === "multimodal") {
      if (turn.route?.via !== "multimodal") problems.push(`multimodal retargeted ${turn.id}`);
      if (session.turns.length > previous.turns.length) problems.push("multimodal failure allocated another turn");
    }
  }
  if (previous.flight && session.flight && session.flight.generation === previous.flight.generation) {
    if (session.flight.via !== previous.flight.via
      || session.flight.url !== previous.flight.url
      || session.flight.host !== previous.flight.host) {
      problems.push("inflight retargeted");
    }
  }
  return problems;
}
