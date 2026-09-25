import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewServer } from "../scripts/label-review.mjs";

test("thirty sequential PDF opens leave no pending request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-pdf-"));
  const payload = Buffer.alloc(256 * 1024, 7);
  payload.write("%PDF-1.4\n");
  writeFileSync(join(dir, "sample.pdf"), payload);
  const { server, pdfPending, maxPdfPending } = createReviewServer({ pdfDir: dir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/pdf/sample`;
  try {
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(url);
      assert.equal(response.ok, true);
      assert.equal(Number(response.headers.get("content-length")), payload.length);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(bytes.length, payload.length);
      const started = Date.now();
      while (pdfPending() !== 0) {
        if (Date.now() - started > 1000) assert.fail(`pending stuck at ${pdfPending()} after open ${index + 1}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(maxPdfPending(), 1);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), payload.length);
    const cancelled = await fetch(url);
    await cancelled.body.cancel();
    const started = Date.now();
    while (pdfPending() !== 0) {
      if (Date.now() - started > 1000) assert.fail(`pending stuck at ${pdfPending()} after cancel`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const icon = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    assert.equal(icon.status, 204);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
