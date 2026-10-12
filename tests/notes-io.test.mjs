import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOTES_FORMAT,
  NOTE_SCHEMA,
  exportMarkdown,
  mergeNotesBundle,
  mergeQa
} from "../lib/notes-io.js";
import { createNotesStore } from "../lib/notes-store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ioSrc = readFileSync(join(root, "lib/notes-io.js"), "utf8");

function note(id, extra = {}) {
  return {
    id,
    schema: 1,
    docHash: "bdfaa68d8984f0dc",
    kind: "note",
    author: "me",
    body: extra.body || "",
    anchor: extra.anchor || null,
    anchorState: { status: "exact", layoutRev: "source-v3:test", checkedAt: 1 },
    page: extra.page || 1,
    createdAt: extra.createdAt || 1,
    updatedAt: extra.updatedAt || 1,
    rev: extra.rev || 1,
    deviceId: "device-a",
    ...extra
  };
}

test("merge keeps the newer revision, then the newer timestamp, and never drops local notes", () => {
  const local = [
    note("a", { rev: 2, updatedAt: 10, body: "本地" }),
    note("b", { rev: 3, updatedAt: 10, body: "保留" }),
    note("c", { rev: 1, updatedAt: 50, body: "本地较新" })
  ];
  const bundle = {
    format: NOTES_FORMAT,
    schema: NOTE_SCHEMA,
    qa: [{ id: "q1", rev: 1, question: "问" }],
    docs: [{
      docHash: "bdfaa68d8984f0dc",
      title: "Attention",
      notes: [
        note("a", { rev: 4, updatedAt: 1, body: "版本新" }),
        note("c", { rev: 1, updatedAt: 40, body: "时间旧" }),
        note("d", { rev: 1, body: "新增", docHash: "bdfaa68d8984f0dc" }),
        { schema: 1, kind: "note", body: "没有 id" }
      ]
    }, {
      docHash: "unopened-hash",
      notes: [note("e", { docHash: "unopened-hash", body: "未打开的文档" })]
    }]
  };
  const plan = mergeNotesBundle(local, bundle, [{ id: "q0", quote: "原会话" }]);
  assert.equal(plan.added, 2);
  assert.equal(plan.updated, 1);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.rejected, 1);
  assert.equal(plan.writes.find((item) => item.id === "a").body, "版本新");
  assert.equal(plan.writes.some((item) => item.id === "b"), false);
  assert.equal(plan.writes.some((item) => item.id === "c"), false);
  assert.equal(plan.writes.find((item) => item.id === "e").docHash, "unopened-hash");
  assert.deepEqual(plan.qa.map((item) => item.id), ["q0", "q1"]);
  const kept = mergeQa(plan.qa, [{ id: "q1", rev: 0, question: "旧问" }, { id: "q2", question: "新会话" }]);
  assert.equal(kept.find((item) => item.id === "q1").question, "问");
  assert.equal(kept.some((item) => item.id === "q0"), true);
  assert.equal(kept.some((item) => item.id === "q2"), true);
  assert.throws(
    () => mergeNotesBundle(local, { format: NOTES_FORMAT, schema: 9, docs: [] }),
    (error) => error.type === "schema" && /升级/.test(error.message)
  );
  assert.equal(ioSrc.includes("unlimitedStorage"), false);
});

test("markdown export groups pages and quotes the source text", async () => {
  let seq = 0;
  let clock = 1;
  const store = createNotesStore({
    memory: true,
    persist: false,
    deviceId: "device-a",
    now: () => clock,
    createId: () => `md-${++seq}`
  });
  await store.put({
    docHash: "bdfaa68d8984f0dc",
    kind: "highlight",
    page: 4,
    anchor: {
      page: 4,
      bid: "b1-p4-t010gv1t",
      quoteSrc: { quote: "Attention is all you need", prefix: "", suffix: "" }
    }
  });
  clock = 2;
  await store.put({
    docHash: "bdfaa68d8984f0dc",
    kind: "note",
    page: 4,
    body: "这段要记住 $E=mc^2$",
    anchor: {
      page: 4,
      quoteSrc: { quote: "The encoder is composed of a stack", prefix: "", suffix: "" }
    }
  });
  clock = 3;
  await store.put({
    docHash: "bdfaa68d8984f0dc",
    kind: "question",
    page: 5,
    body: "还没回答",
    anchor: { page: 5, quoteSrc: { quote: "We propose a new simple network", prefix: "", suffix: "" } }
  });
  clock = 4;
  await store.put({ docHash: "bdfaa68d8984f0dc", kind: "paperNote", page: 0, body: "整篇备忘" });
  const titled = await store.exportAll({ exportedAt: 20, appVersion: "0.3.0" });
  titled.docs[0].title = "Attention Is All You Need";
  const markdown = exportMarkdown(titled);
  assert.match(markdown, /^# Attention Is All You Need · bdfaa68d/);
  assert.match(markdown, /## 论文笔记\n\n### 论文笔记\n\n整篇备忘/);
  assert.match(markdown, /## 原文第 4 页\n\n### 划线\n\n> Attention is all you need\n\n### 笔记\n\n> The encoder is composed of a stack\n\n这段要记住 \$E=mc\^2\$/);
  assert.match(markdown, /## 原文第 5 页\n\n### 问题\n\n> We propose a new simple network\n\n还没回答/);
  assert.equal(markdown.includes("回收站"), false);
  const trashed = await store.put({
    docHash: "bdfaa68d8984f0dc",
    kind: "note",
    page: 4,
    body: "不该导出",
    anchor: { quoteSrc: { quote: "gone quote", prefix: "", suffix: "" } }
  });
  await store.softDelete(trashed.id);
  const after = exportMarkdown(await store.exportAll({ exportedAt: 21, appVersion: "0.3.0" }));
  assert.equal(after.includes("不该导出"), false);
  assert.equal(after.includes("gone quote"), false);
});
