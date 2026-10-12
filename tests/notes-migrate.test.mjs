import test from "node:test";
import assert from "node:assert/strict";
import { NOTES_FORMAT, migrateNote, migrations } from "../lib/notes-io.js";
import { createNotesStore } from "../lib/notes-store.js";

test("schema v1 migration fills defaults and does not mutate the input", () => {
  const raw = { id: "old", kind: "note", body: "旧记录", docHash: "doc-a" };
  const next = migrations[1](raw);
  assert.equal(raw.schema, undefined);
  assert.equal(next.schema, 1);
  assert.equal(next.author, "me");
  assert.equal(next.rev, 1);
  assert.equal(next.anchorState.status, "lost");
  assert.equal(next.body, "旧记录");
  const paper = migrations[1]({ kind: "paperNote", anchor: { bid: "b" }, author: "ai" });
  assert.equal(paper.anchor, null);
  assert.equal(paper.author, "ai");
  assert.equal(migrateNote({ schema: 1, id: "ready", rev: 4 }).rev, 4);
  assert.equal(migrateNote(raw).schema, 1);
});

test("a newer schema is refused and the same migration runs on import", async () => {
  assert.throws(
    () => migrateNote({ schema: 2, id: "future" }),
    (error) => error.type === "schema" && error.schema === 2 && /升级/.test(error.message)
  );
  const store = createNotesStore({
    memory: true,
    persist: false,
    deviceId: "device-a",
    now: () => 10,
    createId: () => "local"
  });
  await store.put({ id: "local", docHash: "doc-a", kind: "note", page: 1, body: "还在" });
  const imported = await store.import({
    format: NOTES_FORMAT,
    schema: 1,
    docs: [{
      docHash: "doc-a",
      notes: [{ id: "from-v0", kind: "highlight", body: "迁移进来", docHash: "doc-a", page: 2 }]
    }]
  });
  assert.equal(imported.added, 1);
  const note = await store.get("from-v0");
  assert.equal(note.schema, 1);
  assert.equal(note.author, "me");
  assert.equal(note.body, "迁移进来");
  await assert.rejects(
    () => store.import({
      format: NOTES_FORMAT,
      schema: 1,
      docs: [{ docHash: "doc-a", notes: [{ schema: 2, id: "nope", kind: "note", docHash: "doc-a" }] }]
    }),
    (error) => error.type === "schema"
  );
  assert.equal((await store.get("local")).body, "还在");
  assert.equal((await store.get("from-v0")).body, "迁移进来");
});
