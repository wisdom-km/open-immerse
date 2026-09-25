import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contentFingerprint } from "../scripts/m1-pdf.mjs";

function pdfBytes({ title, idHex }) {
  const stream = "BT /F1 12 Tf 72 72 Td (Hello) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title (${title}) >>`
  ];
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  let cursor = Buffer.byteLength(chunks[0]);
  objects.forEach((body, index) => {
    offsets.push(cursor);
    const piece = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(piece);
    cursor += Buffer.byteLength(piece);
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  const startxref = cursor;
  chunks.push(xref);
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${startxref}\n%%EOF\n`);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("content fingerprint ignores Info and trailer ID", async () => {
  const first = pdfBytes({ title: "One", idHex: "00112233445566778899AABBCCDDEEFF" });
  const second = pdfBytes({ title: "Downloaded from Cambridge IP 1.2.3.4", idHex: "FFEEDDCCBBAA99887766554433221100" });
  assert.notEqual(sha256(first), sha256(second));
  const left = await contentFingerprint(first);
  const right = await contentFingerprint(second);
  assert.equal(left, right);
  assert.match(left, /^[a-f0-9]{64}$/);
});

test("Cambridge download stamp does not change the fms content fingerprint", async () => {
  const path = fileURLToPath(new URL("../corpus/pdfs/fms-2021-7.pdf", import.meta.url));
  if (!existsSync(path)) return;
  const original = readFileSync(path);
  const stamped = Buffer.from(original);
  const marker = Buffer.from("IP address: ");
  const at = stamped.indexOf(marker);
  assert.ok(at > 0);
  const replacement = Buffer.from("IP address: 10.255.255.1, on 01 Jan 2000 at 00:00:00");
  const current = stamped.subarray(at, at + replacement.length);
  assert.equal(current.length, replacement.length);
  replacement.copy(stamped, at);
  assert.notEqual(sha256(original), sha256(stamped));
  assert.equal(await contentFingerprint(original), await contentFingerprint(stamped));
});
