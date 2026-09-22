import assert from "node:assert/strict";
import test from "node:test";
import { applySavedPairs, createLibraryWriteQueue, pairsFromResults, selectSavedTranslation, storedReadoutBlocks } from "../lib/pdf-library.js";

test("page writes stay ordered even after an earlier write fails", async () => {
  const enqueue = createLibraryWriteQueue();
  const events = [];
  let releaseFirst;
  const first = enqueue(async () => {
    events.push("first start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("first end");
    throw Error("write failed");
  });
  const second = enqueue(async () => { events.push("second"); });
  await Promise.resolve();
  assert.deepEqual(events, ["first start"]);
  releaseFirst();
  await assert.rejects(first, /write failed/);
  await second;
  assert.deepEqual(events, ["first start", "first end", "second"]);
});

test("stored readout keeps formula images and skips a broken page address", () => {
  const png = (width, height) => {
    const header = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(header);
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return `data:image/png;base64,${header.toString("base64")}`;
  };
  const blocks = storedReadoutBlocks([
    "# 注意力机制即一切",
    "",
    "正文一句。",
    "",
    `![公式](${png(30, 20)})`,
    "",
    `![公式](${png(13, 20)})`,
    "",
    "![公式](chrome-extension://aeokbdehdhpdoibdjdgffhaieibomlcn/pdf/viewer.html)"
  ].join("\n"));
  assert.equal(blocks[0].tag, "h1");
  assert.equal(blocks[1].text, "正文一句。");
  assert.equal(blocks[2].tag, "img");
  assert.equal(blocks[2].alt, "公式");
  assert.equal(blocks.filter((block) => block.tag === "img").length, 1);
  assert.equal(blocks.some((block) => String(block.src || "").includes("chrome-extension")), false);
});

test("saved pairs restore a sentence without translating again", () => {
  const pairs = pairsFromResults([{ original: "Attention", translation: "注意力" }]);
  const restored = applySavedPairs([{ id: "a", text: "Attention", translation: "" }], pairs);
  assert.equal(restored[0].translation, "注意力");
});

test("a saved pair is not reused when its source sentence changed", () => {
  const pair = pairsFromResults([{ id: "old", sourceId: "p2-s1", sourceText: "N = 6 identical layers",
    text: "⟦f1⟧ identical layers", translation: "⟦f1⟧ 个相同的层" }]);
  assert.equal(pair[0].sourceText, "N = 6 identical layers");
  const restored = applySavedPairs([{ id: "new", sourceId: "p2-s1",
    sourceText: "N = 8 identical layers", text: "⟦f1⟧ identical layers" }], pair);
  assert.equal(restored[0].translation, "");
  assert.equal(restored[0].translationStatus, "source-uncertain");
});

test("migrated page pairs win over legacy readout and preserve pending status", () => {
  const page = { page: 1, pairs: [
    { sourceId: "p1-a", text: "Abstract", translation: "摘要", status: "verified" },
    { sourceId: "p1-b", text: "Body", translation: "", status: "pending" }
  ] };
  const selected = selectSavedTranslation({ readout: "old whole-document content", pages: [page] }, 1);
  assert.equal(selected, page);
  assert.deepEqual(applySavedPairs([
    { id: "x", sourceId: "p1-a", text: "Abstract" },
    { id: "y", sourceId: "p1-b", text: "Body" }
  ], selected.pairs).map((item) => [item.translation, item.translationStatus]), [
    ["摘要", "verified"], ["", "pending"]
  ]);
  assert.deepEqual(selectSavedTranslation({ readout: "legacy", pages: [page] }, 2),
    { page: 2, pairs: [], migrated: true });
});

test("stored readout accepts Windows line endings and never shows a raw image URL", () => {
  const header = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(header);
  header.writeUInt32BE(80, 16);
  header.writeUInt32BE(24, 20);
  const png = `data:image/png;base64,${header.toString("base64")}`;
  const blocks = storedReadoutBlocks([
    "注意力机制即一切",
    "",
    "作者甲",
    "",
    "## 摘要",
    "",
    "# 1 引言",
    "",
    "同一句译文。",
    "",
    `# ![公式](${png})`,
    "",
    "# ![公式](chrome-extension://aeokbdehdhpdoibdjdgffhaieibomlcn/pdf/viewer.html)"
  ].join("\r\n"));
  assert.deepEqual(blocks.map(({ tag }) => tag), ["p", "p", "h2", "h1", "p", "img"]);
  assert.equal(blocks[5].src, png);
  assert.equal(blocks.some((block) => /data:image|chrome-extension:/.test(block.text || "")), false);
});
