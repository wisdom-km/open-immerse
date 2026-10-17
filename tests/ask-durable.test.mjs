// Shared ask/note state. No network. Each seed prints its number on failure.
import test from "node:test";
import assert from "node:assert/strict";
import {
  askScope,
  beginTurn,
  bindAskDoc,
  claimNoteSave,
  createAskSession,
  finishNoteSave,
  noteForTurn,
  noteInputFromTurn,
  planNoteSave,
  sessionInvariants,
  settleTurn
} from "../lib/ask-session.js";
import { NotesStoreError, createNotesStore } from "../lib/notes-store.js";

const ROUTE = {
  ok: true,
  via: "translation",
  provider: "openai",
  model: "gpt-4o-mini",
  url: "https://api.openai.com/v1/chat/completions",
  host: "api.openai.com"
};

const DOCS = ["bdfaa68d89", "92cb3a2b71"];

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

test("session ids differ on every load and keep the document scope", () => {
  const first = createAskSession({ docHash: "bdfaa68d89" });
  const second = createAskSession({ docHash: "bdfaa68d89" });
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.id, "ask-1");
  assert.equal(first.id.startsWith(`ask-${askScope("bdfaa68d89")}-`), true);
  assert.equal(second.id.startsWith(`ask-${askScope("bdfaa68d89")}-`), true);
  const open = createAskSession();
  bindAskDoc(open, "92cb3a2b71");
  assert.match(open.id, /92cb3a2b71/);
  const begun = beginTurn(open, { question: "问", route: ROUTE });
  const locked = open.id;
  bindAskDoc(open, "bdfaa68d89");
  assert.equal(open.id, locked);
  assert.equal(begun.turn.id.startsWith(`${locked}:`), true);
  const forced = createAskSession({ ids: () => "ask-1" });
  bindAskDoc(forced, "bdfaa68d89");
  assert.equal(forced.id, "ask-1");
});

test("planNoteSave ignores another document, a prefix, and a failed row", () => {
  const turn = { id: "ask-1:1", noteId: "", pendingDisk: false };
  const other = { id: "n-other", docHash: "doc-b", qa: { turnId: "ask-1:1" }, deletedAt: 0 };
  const prefix = { id: "n-prefix", docHash: "doc-a", qa: { turnId: "ask-1" }, deletedAt: 0 };
  const longer = { id: "n-long", docHash: "doc-a", qa: { turnId: "ask-1:10" }, deletedAt: 0 };
  const same = { id: "n-same", docHash: "doc-a", qa: { turnId: "ask-1:1" }, deletedAt: 0 };
  const durable = new Set(["n-other", "n-prefix", "n-long", "n-same"]);
  assert.equal(planNoteSave(turn, [other, prefix, longer], "doc-a", durable).action, "write");
  assert.equal(noteForTurn([other, prefix, longer, same], "ask-1:1", "doc-a").id, "n-same");
  assert.equal(noteForTurn([same], "ask-1:1", "doc-b"), null);
  assert.equal(planNoteSave(turn, [same], "doc-a", durable).action, "reuse");
  turn.pendingDisk = true;
  assert.equal(planNoteSave(turn, [same], "doc-a", durable).action, "write");
  turn.pendingDisk = false;
  assert.equal(planNoteSave(turn, [same], "doc-a", new Set()).action, "write");
});

test("durable ask saves keep doc identity across 500 seeds", async () => {
  let reloads = 0;
  let failures = 0;
  let retries = 0;
  let unloads = 0;
  let refusals = 0;
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = mulberry32(seed);
    const store = createNotesStore({ memory: true, persist: false });
    const volatile = new Map();
    const docOf = new Map();
    const seenSession = new Set();
    const seenTurn = new Set();
    const sessions = [];

    function open(docHash) {
      const session = createAskSession({ docHash });
      bindAskDoc(session, docHash);
      if (seenSession.has(session.id)) throw new Error(`session id reused ${session.id}`);
      if (!session.id.includes(askScope(docHash))) throw new Error(`session missing doc ${session.id}`);
      seenSession.add(session.id);
      session.doc = docHash;
      return session;
    }

    sessions.push(open(DOCS[0]), open(DOCS[1]), open(DOCS[0]));

    async function visible(docHash) {
      const rows = await store.list(docHash);
      const extra = [...volatile.values()].filter((note) => note.docHash === docHash && !rows.some((row) => row.id === note.id));
      return rows.concat(extra);
    }

    async function check() {
      const durableTurns = new Set();
      for (const note of store.notes.values()) {
        if (docOf.get(note.id) !== note.docHash) throw new Error(`docId changed ${note.id}`);
        if (durableTurns.has(note.qa?.turnId)) throw new Error(`dup durable turn ${note.qa?.turnId}`);
        durableTurns.add(note.qa?.turnId);
      }
      for (const session of sessions) {
        const problems = sessionInvariants(session, null);
        if (problems.length) throw new Error(problems.join(";"));
        for (const turn of session.turns) {
          if (seenTurn.has(turn.id) === false) throw new Error(`turn escaped the set ${turn.id}`);
          if (turn.noteId) {
            const note = await store.get(turn.noteId);
            if (!note) throw new Error(`check without disk ${turn.id}`);
            if (note.docHash !== session.doc) throw new Error(`check doc ${turn.id}`);
            if (note.qa?.turnId !== turn.id) throw new Error(`check turn ${turn.id}`);
            if (volatile.has(turn.noteId)) throw new Error(`check still volatile ${turn.id}`);
            if (turn.pendingDisk) throw new Error(`checked while pending ${turn.id}`);
          }
        }
      }
    }

    try {
      for (let step = 0; step < 24; step += 1) {
        const roll = random();
        const index = Math.floor(random() * sessions.length);
        const docHash = sessions[index].doc;
        let session = sessions[index];
        if (roll < 0.2) {
          const begun = beginTurn(session, {
            question: `问${seed}-${step}`,
            route: ROUTE,
            citation: { bid: "b1", page: 1, text: "引用" }
          });
          if (begun.ok) {
            if (seenTurn.has(begun.turn.id)) throw new Error(`turn id reused ${begun.turn.id}`);
            seenTurn.add(begun.turn.id);
            settleTurn(session, begun.generation, { ok: true, body: `答${seed}-${step}` });
          }
        } else if (roll < 0.38) {
          const turn = [...session.turns].reverse().find((item) => item.status === "done" && !item.noteId && !item.saving && !item.pendingDisk);
          if (turn) {
            const plan = planNoteSave(turn, await visible(docHash), docHash, new Set(store.notes.keys()));
            if (plan.action !== "write") throw new Error(`fresh save planned ${plan.action}`);
            const claim = claimNoteSave(session, turn.id);
            if (!claim.ok) throw new Error(`claim ${claim.reason}`);
            const input = noteInputFromTurn(turn, {
              docHash,
              anchor: { bid: "b1", page: 1, quote: "引用" },
              page: 1
            });
            const saved = await store.put(input);
            if (docOf.has(saved.id) && docOf.get(saved.id) !== saved.docHash) throw new Error("put moved doc");
            docOf.set(saved.id, saved.docHash);
            volatile.delete(saved.id);
            const done = finishNoteSave(session, turn.id, claim.ticket, { ok: true, noteId: saved.id });
            if (!done.ok || turn.pendingDisk || turn.noteId !== saved.id) throw new Error("save did not confirm");
          }
        } else if (roll < 0.52) {
          const turn = [...session.turns].reverse().find((item) => item.status === "done" && !item.noteId && !item.saving);
          if (turn) {
            failures += 1;
            const claim = claimNoteSave(session, turn.id);
            if (!claim.ok) throw new Error(`fail claim ${claim.reason}`);
            const input = noteInputFromTurn(turn, {
              docHash,
              anchor: { bid: "b1", page: 1, quote: "引用" },
              page: 1
            });
            volatile.set(input.id, input);
            turn.pendingDisk = true;
            const failed = finishNoteSave(session, turn.id, claim.ticket, { ok: false, reason: "failed" });
            if (failed.ok || turn.noteId || !turn.pendingDisk) throw new Error("failure confirmed");
            if (store.notes.has(input.id)) throw new Error("failed put reached disk");
            const plan = planNoteSave(turn, await visible(docHash), docHash, new Set(store.notes.keys()));
            if (plan.action !== "write") throw new Error(`failed row planned ${plan.action}`);
          }
        } else if (roll < 0.66) {
          const turn = [...session.turns].reverse().find((item) => item.pendingDisk && !item.noteId && !item.saving);
          if (turn) {
            retries += 1;
            const plan = planNoteSave(turn, await visible(docHash), docHash, new Set(store.notes.keys()));
            if (plan.action !== "write") throw new Error(`retry planned ${plan.action}`);
            const claim = claimNoteSave(session, turn.id);
            if (!claim.ok) throw new Error(`retry claim ${claim.reason}`);
            const input = noteInputFromTurn(turn, {
              docHash,
              anchor: { bid: "b1", page: 1, quote: "引用" },
              page: 1
            });
            const saved = await store.put(input);
            docOf.set(saved.id, saved.docHash);
            volatile.delete(saved.id);
            const done = finishNoteSave(session, turn.id, claim.ticket, { ok: true, noteId: saved.id });
            if (!done.ok || turn.pendingDisk) throw new Error("retry did not confirm");
          }
        } else if (roll < 0.78) {
          reloads += 1;
          const saving = session.turns.find((item) => item.saving);
          const fresh = open(docHash);
          if (saving) {
            unloads += 1;
            const before = store.notes.size;
            const late = finishNoteSave(fresh, saving.id, saving.saveTicket, { ok: true, noteId: "ghost" });
            if (late.ok || fresh.turns.some((item) => item.noteId)) throw new Error("reloaded tab accepted an in-flight save");
            if (store.notes.size !== before) throw new Error("reload wrote disk");
          }
          for (const [id, note] of [...volatile]) {
            if (note.docHash === docHash) volatile.delete(id);
          }
          sessions[index] = fresh;
          session = fresh;
        } else if (roll < 0.9) {
          const turn = [...session.turns].reverse().find((item) => item.status === "done" && !item.noteId && !item.saving);
          if (turn) {
            const claim = claimNoteSave(session, turn.id);
            if (claim.ok) {
              unloads += 1;
              const before = store.notes.size;
              const fresh = open(docHash);
              fresh.turns.push({ ...turn, noteId: "", saving: false, saveTicket: 0, pendingDisk: false });
              const late = finishNoteSave(fresh, turn.id, claim.ticket, { ok: true, noteId: "ghost" });
              if (late.ok || fresh.turns.some((item) => item.noteId === "ghost")) throw new Error("unloaded save landed");
              if (store.notes.size !== before) throw new Error("unload wrote disk");
              sessions[index] = fresh;
              session = fresh;
            }
          }
        } else {
          const note = [...store.notes.values()][0];
          if (note) {
            refusals += 1;
            const other = note.docHash === DOCS[0] ? DOCS[1] : DOCS[0];
            const before = note.docHash;
            const beforeBody = note.body;
            let refused = false;
            try {
              await store.put({ ...note, docHash: other, body: "搬走" });
            } catch (err) {
              if (!(err instanceof NotesStoreError) || err.type !== "doc") throw err;
              refused = true;
            }
            if (!refused) throw new Error("cross-doc put was accepted");
            const still = await store.get(note.id);
            if (still.docHash !== before || still.body !== beforeBody) throw new Error("cross-doc put changed the note");
            if ((await store.list(other)).some((item) => item.id === note.id)) throw new Error("note listed on the other doc");
          }
        }
        await check();
      }
    } catch (err) {
      throw new Error(`seed ${seed}: ${err.message}`);
    }
  }
  assert.ok(reloads > 0, "reload never ran");
  assert.ok(failures > 0, "failed save never ran");
  assert.ok(retries > 0, "retry never ran");
  assert.ok(unloads > 0, "mid-save unload never ran");
  assert.ok(refusals > 0, "cross-doc put never ran");
});
