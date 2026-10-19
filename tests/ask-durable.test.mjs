// Shared ask/note state. No network. Each seed prints its number on failure.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { IDBObjectStore } from "fake-indexeddb";
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
import { NOTES_DB_NAME, NotesStoreError, createNotesStore } from "../lib/notes-store.js";

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

test("planNoteSave does not adopt a listed row from a disk id set", () => {
  const turn = { id: "ask-1:1", noteId: "", pendingDisk: false };
  const other = { id: "n-other", docHash: "doc-b", qa: { turnId: "ask-1:1" }, deletedAt: 0 };
  const prefix = { id: "n-prefix", docHash: "doc-a", qa: { turnId: "ask-1" }, deletedAt: 0 };
  const longer = { id: "n-long", docHash: "doc-a", qa: { turnId: "ask-1:10" }, deletedAt: 0 };
  const same = { id: "n-same", docHash: "doc-a", qa: { turnId: "ask-1:1" }, deletedAt: 0 };
  const durable = new Set(["n-other", "n-prefix", "n-long", "n-same"]);
  assert.equal(noteForTurn([other, prefix, longer, same], "ask-1:1", "doc-a").id, "n-same");
  assert.equal(noteForTurn([same], "ask-1:1", "doc-b"), null);
  assert.equal(planNoteSave(turn, [same], "doc-a", durable).action, "write");
  turn.pendingDisk = true;
  assert.equal(planNoteSave(turn, [same], "doc-a", durable).action, "write");
  turn.pendingDisk = false;
  turn.noteId = "n-same";
  assert.deepEqual(planNoteSave(turn), { action: "exists", noteId: "n-same" });
  assert.equal(planNoteSave.length, 1);
});

function openIdbStore() {
  return createNotesStore({ persist: false, capture: false, deviceId: "ask-seed" });
}

function diskRows(store) {
  const db = store.currentDb;
  if (!db) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction("notes", "readonly");
    const req = tx.objectStore("notes").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error("disk read failed"));
  });
}

async function wipeNotesDb() {
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(NOTES_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

test("durable ask saves keep doc identity across 500 seeds", async () => {
  const originalPut = IDBObjectStore.prototype.put;
  let notePutFailures = 0;
  IDBObjectStore.prototype.put = function put(value, key) {
    if (notePutFailures > 0 && this.name === "notes") {
      notePutFailures -= 1;
      const error = new Error("injected put failure");
      error.name = "UnknownError";
      throw error;
    }
    return originalPut.call(this, value, key);
  };
  let reloads = 0;
  let failures = 0;
  let retries = 0;
  let unloads = 0;
  let refusals = 0;
  try {
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = mulberry32(seed);
    let store = openIdbStore();
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

    async function check() {
      const disk = await diskRows(store);
      const durableTurns = new Set();
      for (const note of disk) {
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
            const note = disk.find((item) => item.id === turn.noteId);
            if (!note) throw new Error(`check without disk ${turn.id}`);
            if (note.docHash !== session.doc) throw new Error(`check doc ${turn.id}`);
            if (note.qa?.turnId !== turn.id) throw new Error(`check turn ${turn.id}`);
            if (turn.pendingDisk) throw new Error(`checked while pending ${turn.id}`);
          } else if (turn.pendingDisk && disk.some((item) => item.id === `ask:${turn.id}`)) {
            throw new Error(`pending row reached disk ${turn.id}`);
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
            const plan = planNoteSave(turn);
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
            const done = finishNoteSave(session, turn.id, claim.ticket, { ok: true, noteId: saved.id });
            if (!done.ok || turn.pendingDisk || turn.noteId !== saved.id) throw new Error("save did not confirm");
            if (!(await diskRows(store)).some((note) => note.id === saved.id)) throw new Error("save missed disk");
          }
        } else if (roll < 0.52) {
          const turn = [...session.turns].reverse().find((item) => item.status === "done" && !item.noteId && !item.saving);
          if (turn) {
            failures += 1;
            const kept = turn.answer;
            const claim = claimNoteSave(session, turn.id);
            if (!claim.ok) throw new Error(`fail claim ${claim.reason}`);
            const input = noteInputFromTurn(turn, {
              docHash,
              anchor: { bid: "b1", page: 1, quote: "引用" },
              page: 1
            });
            notePutFailures = 1;
            let threw = false;
            try {
              await store.put(input);
            } catch (err) {
              if (!(err instanceof NotesStoreError) || err.type === "doc") throw err;
              threw = true;
            }
            if (!threw) throw new Error("put did not fail");
            if ((await diskRows(store)).some((note) => note.id === input.id)) throw new Error("failed put reached disk");
            if (!store.memory.notes.has(input.id)) throw new Error("failed put dropped the memory row");
            const failed = finishNoteSave(session, turn.id, claim.ticket, { ok: false, reason: "failed" });
            if (failed.ok || turn.noteId || !turn.pendingDisk) throw new Error("failure confirmed");
            if (turn.answer !== kept) throw new Error("failure dropped the answer");
            const plan = planNoteSave(turn);
            if (plan.action !== "write") throw new Error(`failed row planned ${plan.action}`);
          }
        } else if (roll < 0.66) {
          const turn = [...session.turns].reverse().find((item) => item.pendingDisk && !item.noteId && !item.saving);
          if (turn) {
            retries += 1;
            const plan = planNoteSave(turn);
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
            const done = finishNoteSave(session, turn.id, claim.ticket, { ok: true, noteId: saved.id });
            if (!done.ok || turn.pendingDisk) throw new Error("retry did not confirm");
            const copies = (await diskRows(store)).filter((note) => note.qa?.turnId === turn.id);
            if (copies.length !== 1) throw new Error(`retry duplicated ${copies.length}`);
          }
        } else if (roll < 0.78) {
          reloads += 1;
          const saving = session.turns.find((item) => item.saving);
          const fresh = open(docHash);
          if (saving) {
            unloads += 1;
            const before = (await diskRows(store)).length;
            const late = finishNoteSave(fresh, saving.id, saving.saveTicket, { ok: true, noteId: "ghost" });
            if (late.ok || fresh.turns.some((item) => item.noteId)) throw new Error("reloaded tab accepted an in-flight save");
            if ((await diskRows(store)).length !== before) throw new Error("reload wrote disk");
          }
          const durable = (await diskRows(store)).filter((note) => note.docHash === docHash);
          store.memory.replaceDocNotes(docHash, durable);
          sessions[index] = fresh;
          session = fresh;
        } else if (roll < 0.9) {
          const turn = [...session.turns].reverse().find((item) => item.status === "done" && !item.noteId && !item.saving);
          if (turn) {
            const claim = claimNoteSave(session, turn.id);
            if (claim.ok) {
              unloads += 1;
              const before = (await diskRows(store)).length;
              const fresh = open(docHash);
              fresh.turns.push({ ...turn, noteId: "", saving: false, saveTicket: 0, pendingDisk: false });
              const late = finishNoteSave(fresh, turn.id, claim.ticket, { ok: true, noteId: "ghost" });
              if (late.ok || fresh.turns.some((item) => item.noteId === "ghost")) throw new Error("unloaded save landed");
              if ((await diskRows(store)).length !== before) throw new Error("unload wrote disk");
              sessions[index] = fresh;
              session = fresh;
            }
          }
        } else {
          const note = [...store.memory.notes.values()][0];
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
    } finally {
      try { store.currentDb?.close(); } catch { /* already closed */ }
      await wipeNotesDb();
    }
  }
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.ok(reloads > 0, "reload never ran");
  assert.ok(failures > 0, "failed save never ran");
  assert.ok(retries > 0, "retry never ran");
  assert.ok(unloads > 0, "mid-save unload never ran");
  assert.ok(refusals > 0, "cross-doc put never ran");
});
