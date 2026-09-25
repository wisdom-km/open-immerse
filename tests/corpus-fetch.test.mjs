import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHALLENGE_NOTE, classifyPayload, fetchCorpus, formatSummary } from "../scripts/corpus-fetch.mjs";

const FINGERPRINT = "a".repeat(64);
const OTHER = "b".repeat(64);

function manifest(documents) {
  const dir = mkdtempSync(join(tmpdir(), "corpus-fetch-"));
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ documents }));
  return { dir, path, pdfs: join(dir, "pdfs") };
}

function doc(id, url) {
  return { id, url, contentFingerprint: FINGERPRINT };
}

test("HTML client challenges are classified without treating them as PDFs", () => {
  const html = Buffer.from("<!DOCTYPE html><html><title>Client Challenge</title>idp.nature.com</html>");
  assert.equal(classifyPayload(html, "text/html"), "blocked-by-challenge");
  assert.equal(classifyPayload(Buffer.from("%PDF-1.7\n"), "application/pdf"), "pdf");
  assert.equal(classifyPayload(Buffer.from("nope")), "not-pdf");
});

test("a stub server challenge is reported and the next paper still runs", async () => {
  const server = createServer((request, response) => {
    if (request.url.endsWith("/wall")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><title>Client Challenge</title><p>idp.springer.com</p></html>");
      return;
    }
    response.writeHead(200, { "content-type": "application/pdf" });
    response.end(Buffer.from("%PDF-1.4\nok"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const { dir, path, pdfs } = manifest([
    doc("walled", `http://127.0.0.1:${port}/wall`),
    doc("fine", `http://127.0.0.1:${port}/fine`)
  ]);
  try {
    const outcome = await fetchCorpus({
      manifest: path,
      dir: pdfs,
      pause: async () => {},
      fingerprint: async () => FINGERPRINT
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.results[0].status, "blocked-by-challenge");
    assert.equal(outcome.results[0].note, CHALLENGE_NOTE);
    assert.equal(outcome.results[1].status, "ok");
    assert.equal(readFileSync(join(pdfs, "fine.pdf")).subarray(0, 5).toString(), "%PDF-");
    assert.match(formatSummary(outcome.results), /blocked-by-challenge/);
    assert.equal(dir.length > 0, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("transient network errors are retried and then recorded", async () => {
  let calls = 0;
  const { path, pdfs } = manifest([doc("flaky", "http://publisher.example/paper.pdf")]);
  const outcome = await fetchCorpus({
    manifest: path,
    dir: pdfs,
    pause: async () => {},
    fingerprint: async () => FINGERPRINT,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("fetch failed");
      return new Response(Buffer.from("%PDF-1.4\nok"), {
        status: 200,
        headers: { "content-type": "application/pdf" }
      });
    }
  });
  assert.equal(calls, 3);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results[0].status, "ok");
});

test("a fingerprint mismatch does not abort the rest of the corpus", async () => {
  const { path, pdfs } = manifest([
    doc("bad", "http://publisher.example/bad.pdf"),
    doc("good", "http://publisher.example/good.pdf")
  ]);
  const outcome = await fetchCorpus({
    manifest: path,
    dir: pdfs,
    pause: async () => {},
    fingerprint: async (bytes) => (bytes.includes("bad") ? OTHER : FINGERPRINT),
    fetchImpl: async (url) => new Response(Buffer.from(url.endsWith("bad.pdf") ? "%PDF-1.4\nbad" : "%PDF-1.4\ngood"), {
      status: 200,
      headers: { "content-type": "application/pdf" }
    })
  });
  assert.deepEqual(outcome.results.map((row) => row.status), ["hash-mismatch", "ok"]);
  assert.equal(outcome.ok, false);
});

test("--import copies a verified local PDF and rejects a challenge page", async () => {
  const { dir, path, pdfs } = manifest([
    doc("local-ok", "http://publisher.example/nope.pdf"),
    doc("local-wall", "http://publisher.example/nope2.pdf"),
    doc("not-here", "http://publisher.example/nope3.pdf")
  ]);
  const incoming = join(dir, "incoming");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(incoming);
  writeFileSync(join(incoming, "local-ok.pdf"), Buffer.from("%PDF-1.4\nlocal"));
  writeFileSync(join(incoming, "local-wall.pdf"), Buffer.from("<html>Client Challenge idp.nature.com</html>"));
  let fetched = 0;
  const outcome = await fetchCorpus({
    manifest: path,
    dir: pdfs,
    importDir: incoming,
    pause: async () => {},
    fingerprint: async () => FINGERPRINT,
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("should not download");
    }
  });
  assert.equal(fetched, 0);
  assert.equal(outcome.results[0].status, "ok");
  assert.equal(readFileSync(join(pdfs, "local-ok.pdf")).toString().includes("local"), true);
  assert.equal(outcome.results[1].status, "blocked-by-challenge");
  assert.equal(outcome.results[1].note, CHALLENGE_NOTE);
  assert.match(CHALLENGE_NOTE, /手动保存/);
  assert.match(CHALLENGE_NOTE, /--import/);
  assert.equal(outcome.results[2].status, "skipped");
  assert.match(outcome.results[2].note, /未下载/);
  assert.equal(outcome.ok, false);
});

test("--import stays successful when every provided file verifies", async () => {
  const { dir, path, pdfs } = manifest([
    doc("local-ok", "http://publisher.example/nope.pdf"),
    doc("not-here", "http://publisher.example/nope3.pdf")
  ]);
  const incoming = join(dir, "incoming");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(incoming);
  writeFileSync(join(incoming, "local-ok.pdf"), Buffer.from("%PDF-1.4\nlocal"));
  const outcome = await fetchCorpus({
    manifest: path,
    dir: pdfs,
    importDir: incoming,
    pause: async () => {},
    fingerprint: async () => FINGERPRINT,
    fetchImpl: async () => {
      throw new Error("should not download");
    }
  });
  assert.deepEqual(outcome.results.map((row) => row.status), ["ok", "skipped"]);
  assert.equal(outcome.ok, true);
});

test("--import fails when a provided file does not match the fingerprint", async () => {
  const { dir, path, pdfs } = manifest([
    doc("local-ok", "http://publisher.example/nope.pdf"),
    doc("local-bad", "http://publisher.example/nope2.pdf"),
    doc("not-here", "http://publisher.example/nope3.pdf")
  ]);
  const incoming = join(dir, "incoming");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(incoming);
  writeFileSync(join(incoming, "local-ok.pdf"), Buffer.from("%PDF-1.4\nlocal"));
  writeFileSync(join(incoming, "local-bad.pdf"), Buffer.from("%PDF-1.4\nbad"));
  const outcome = await fetchCorpus({
    manifest: path,
    dir: pdfs,
    importDir: incoming,
    pause: async () => {},
    fingerprint: async (bytes) => (Buffer.from(bytes).includes("bad") ? OTHER : FINGERPRINT),
    fetchImpl: async () => {
      throw new Error("should not download");
    }
  });
  assert.deepEqual(outcome.results.map((row) => row.status), ["ok", "hash-mismatch", "skipped"]);
  assert.equal(existsSync(join(pdfs, "local-bad.pdf")), false);
  assert.equal(outcome.ok, false);
});
