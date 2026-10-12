import "./helpers/block-live-fetch.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { unpackSource } from "../lib/arxiv-src-unpack.js";
import { paxRecord, tarGz } from "./helpers/arxiv-pack.mjs";
import { SRC_V1, SRC_V1_SHA, SRC_V7, SRC_V7_SHA, loadSource } from "./helpers/arxiv-paper.mjs";

const gunzip = (bytes) => gunzipSync(bytes);

test("AX-05 synthetic tar, single file, pdf, traversal, and limits", async () => {
  const tar = await unpackSource(tarGz([
    { name: "main.tex", body: "\\documentclass{article}\n" },
    { name: "pic.png", body: "not-text" }
  ]), { gunzip });
  assert.equal(tar.kind, "tar");
  assert.deepEqual(tar.files.map((file) => file.path), ["main.tex"]);

  const single = await unpackSource(gzipSync(Buffer.from("plain tex body\n")), { gunzip });
  assert.equal(single.kind, "single");
  assert.equal(single.files[0].path, "source.tex");
  assert.match(single.files[0].text, /plain tex/);

  const pdf = await unpackSource(Buffer.from("%PDF-1.7\n"), { gunzip });
  assert.equal(pdf.kind, "pdf-only");
  assert.equal(pdf.files.length, 0);

  const escaped = await unpackSource(tarGz([
    { name: "../evil.tex", body: "nope" },
    { name: "/tmp/abs.tex", body: "nope" },
    { name: "ok.tex", body: "kept" }
  ]), { gunzip });
  assert.equal(escaped.kind, "tar");
  assert.deepEqual(escaped.files.map((file) => file.path), ["ok.tex"]);
  assert.equal(escaped.files.some((file) => file.path.includes("..")), false);
  assert.ok(escaped.skipped.some((row) => row.reason === "traversal"));
  assert.ok(escaped.skipped.some((row) => row.reason === "absolute"));

  const tooMany = await unpackSource(tarGz([
    { name: "a.tex", body: "a" },
    { name: "b.tex", body: "b" },
    { name: "c.tex", body: "c" }
  ]), { gunzip, maxFiles: 2 });
  assert.equal(tooMany.kind, "rejected");
  assert.equal(tooMany.reason, "max-files");
  assert.equal(tooMany.files.length, 0);

  const tooBig = await unpackSource(tarGz([
    { name: "big.tex", body: "0123456789abcdef" }
  ]), { gunzip, maxBytes: 8 });
  assert.equal(tooBig.kind, "rejected");
  assert.equal(tooBig.reason, "max-bytes");
});

test("AX-06 long names, pax headers, and Attention archives", async () => {
  const longName = `${"nested/".repeat(12)}very-long-name.tex`;
  const longBody = Buffer.from(`${longName}\0`);
  const packed = tarGz([
    { name: "././@LongLink", type: "L", body: longBody },
    { name: "short.tex", body: "long-name-body" },
    { name: "pax.hdr", type: "x", body: paxRecord("path", "from-pax.tex") },
    { name: "ignored.tex", body: "pax-body" },
    { name: "photo.jpg", body: "jpeg" }
  ]);
  const unpacked = await unpackSource(packed, { gunzip });
  assert.equal(unpacked.kind, "tar");
  assert.equal(unpacked.files.some((file) => file.path === longName && file.text === "long-name-body"), true);
  assert.equal(unpacked.files.some((file) => file.path === "from-pax.tex" && file.text === "pax-body"), true);
  assert.equal(unpacked.files.some((file) => file.path.endsWith(".jpg")), false);

  const v7 = await loadSource(SRC_V7, SRC_V7_SHA, "从 https://arxiv.org/src/1706.03762v7 下载到 tests/fixtures/arxiv-src/。");
  assert.equal(v7.kind, "tar");
  assert.equal(v7.regularFileCount, 23);
  const main = v7.files.find((file) => file.path === "ms.tex");
  assert.ok(main);
  assert.match(main.text, /\\documentclass/);
  assert.match(main.text, /\\begin\{document\}/);
  assert.equal(v7.files.every((file) => /\.(tex|ltx|sty|cls|bib|bbl|bst|def|fd|cfg|clo|ins|dtx|txt|md)$/i.test(file.path)), true);

  const v1 = await loadSource(SRC_V1, SRC_V1_SHA, "从 https://arxiv.org/src/1706.03762v1 下载到 tests/fixtures/arxiv-src/。");
  assert.equal(v1.kind, "tar");
  assert.equal(v1.regularFileCount, 21);
});
