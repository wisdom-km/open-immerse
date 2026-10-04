import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contentFingerprint, isCambridgePageStamp, labelPageFromRecord } from "../scripts/m1-pdf.mjs";

function pdfBytes({ title, idHex, lines = ["Hello"] }) {
  const showing = lines.map((line) => `(${line}) Tj 0 -14 Td`).join(" ");
  const stream = `BT /F1 9 Tf 72 160 Td ${showing} ET`;
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

const ATTENTION_FIXTURE = fileURLToPath(new URL("./fixtures/Attention_Is_All_You_Need.pdf", import.meta.url));
const ATTENTION_SHA256 = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
const CAMBRIDGE_STAMP = "Downloaded from https://www.cambridge.org/core. IP address: 203.0.113.4, on 01 Jan 2000 at 12:15:41, subject to the Cambridge Core terms of use, available at";
const STAMP_REPLACEMENT = Buffer.from("IP address: 10.255.255.1, on 01 Jan 2000 at 00:00:00");

function replaceIpMarker(bytes) {
  const stamped = Buffer.from(bytes);
  const marker = Buffer.from("IP address: ");
  const at = stamped.indexOf(marker);
  assert.ok(at > 0, "IP address marker was not found");
  const current = stamped.subarray(at, at + STAMP_REPLACEMENT.length);
  assert.equal(current.length, STAMP_REPLACEMENT.length);
  STAMP_REPLACEMENT.copy(stamped, at);
  return stamped;
}

function loadClassicXref(pdf) {
  const at = pdf.lastIndexOf("startxref");
  assert.ok(at > 0, "Attention fixture has no startxref");
  const prev = Number(/startxref\s+(\d+)/.exec(pdf.subarray(at, at + 40).toString("latin1"))[1]);
  assert.equal(pdf.subarray(prev, prev + 4).toString("latin1"), "xref", "Attention fixture has no classic xref table");
  let cursor = prev + 4;
  while (pdf[cursor] === 0x0a || pdf[cursor] === 0x0d || pdf[cursor] === 0x20) cursor += 1;
  const headerEnd = pdf.indexOf(0x0a, cursor);
  const [subStart, subCount] = pdf.subarray(cursor, headerEnd).toString("latin1").trim().split(/\s+/).map(Number);
  const entries = new Map();
  let row = headerEnd + 1;
  for (let index = 0; index < subCount; index += 1) {
    const line = pdf.subarray(row, row + 20).toString("latin1");
    if (line[17] === "n") entries.set(subStart + index, Number(line.slice(0, 10)));
    row += 20;
  }
  const trailerAt = pdf.lastIndexOf("trailer");
  const trailer = pdf.subarray(trailerAt, trailerAt + 400).toString("latin1");
  const root = Number(/\/Root\s+(\d+)\s+0\s+R/.exec(trailer)[1]);
  const size = Number(/\/Size\s+(\d+)/.exec(trailer)[1]);
  return { entries, prev, root, size };
}

function objectText(pdf, offset) {
  const text = pdf.subarray(offset, Math.min(pdf.length, offset + 8192)).toString("latin1");
  const end = text.indexOf("endobj");
  assert.ok(end > 0, "PDF object is missing endobj");
  return text.slice(0, end);
}

function firstPage(pdf, xref, id, depth = 0) {
  assert.ok(depth < 8, "page tree is too deep");
  const body = objectText(pdf, xref.entries.get(id));
  if (/\/Type\s*\/Page(?!s)/.test(body)) return { id, body };
  const kids = /\/Kids\s*\[([^\]]*)\]/.exec(body);
  assert.ok(kids, "page tree node has no kids");
  const child = Number(/(\d+)\s+0\s+R/.exec(kids[1])[1]);
  return firstPage(pdf, xref, child, depth + 1);
}

function pdfString(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// Append one text showing to page 1. The Attention file's page resources
// already include the standard /arXivStAmP font, so pdf.js can extract it.
function appendPageText(pdf, text) {
  const xref = loadClassicXref(pdf);
  const catalog = objectText(pdf, xref.entries.get(xref.root));
  const pagesId = Number(/\/Pages\s+(\d+)\s+0\s+R/.exec(catalog)[1]);
  const page = firstPage(pdf, xref, pagesId);
  const listed = /\/Contents\s*\[([^\]]*)\]/.exec(page.body);
  const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(page.body);
  const contents = listed
    ? [...listed[1].matchAll(/(\d+)\s+0\s+R/g)].map((match) => Number(match[1]))
    : [Number(single[1])];
  const streamId = xref.size;
  const showing = Buffer.from(`BT\n/arXivStAmP 8 Tf\n36 18 Td\n(${pdfString(text)}) Tj\nET\n`, "latin1");
  const streamObject = Buffer.concat([
    Buffer.from(`${streamId} 0 obj\n<< /Length ${showing.length} >>\nstream\n`, "latin1"),
    showing,
    Buffer.from("endstream\nendobj\n", "latin1")
  ]);
  const rewritten = page.body.replace(
    /\/Contents\s+(?:\[[^\]]*\]|\d+\s+0\s+R)/,
    `/Contents [ ${[...contents, streamId].map((id) => `${id} 0 R`).join(" ")} ]`
  );
  const pageObject = Buffer.from(`${rewritten}endobj\n`, "latin1");
  const streamAt = pdf.length;
  const pageAt = streamAt + streamObject.length;
  const xrefAt = pageAt + pageObject.length;
  const subsection = (id, offset) => `${id} 1\n${String(offset).padStart(10, "0")} 00000 n \n`;
  const xrefTable = Buffer.from(
    `xref\n${subsection(page.id, pageAt)}${subsection(streamId, streamAt)}` +
    `trailer\n<< /Size ${streamId + 1} /Prev ${xref.prev} /Root ${xref.root} 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`,
    "latin1"
  );
  return Buffer.concat([pdf, streamObject, pageObject, xrefTable]);
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

test("Cambridge page stamps that differ only by the clock hash the same", async () => {
  const early = "Downloaded from https://www.cambridge.org/core. IP address: 203.0.113.4, on 01 Jan 2000 at 12:15:41, subject to the Cambridge Core terms of use, available at";
  const later = early.replace("12:15:41", "12:15:44");
  assert.equal(isCambridgePageStamp(early), true);
  assert.equal(isCambridgePageStamp("Downloaded from the archive yesterday"), false);
  const first = pdfBytes({ title: "A", idHex: "00112233445566778899AABBCCDDEEFF", lines: [early, "x = 1"] });
  const second = pdfBytes({ title: "B", idHex: "FFEEDDCCBBAA99887766554433221100", lines: [later, "x = 1"] });
  const changed = pdfBytes({ title: "C", idHex: "00112233445566778899AABBCCDDEEFF", lines: [later, "x = 2"] });
  assert.equal(await contentFingerprint(first), await contentFingerprint(second));
  assert.notEqual(await contentFingerprint(first), await contentFingerprint(changed));
});

test("a Cambridge download stamp does not change the Attention content fingerprint", async (t) => {
  assert.equal(existsSync(ATTENTION_FIXTURE), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  const original = readFileSync(ATTENTION_FIXTURE);
  assert.equal(sha256(original), ATTENTION_SHA256, "tests/fixtures/Attention_Is_All_You_Need.pdf sha256");
  const baseline = await contentFingerprint(original);
  const stamped = replaceIpMarker(appendPageText(original, CAMBRIDGE_STAMP));
  assert.notEqual(sha256(original), sha256(stamped));
  assert.equal(await contentFingerprint(stamped), baseline);
  const changed = appendPageText(original, "x = 2");
  assert.notEqual(await contentFingerprint(changed), baseline);

  const fmsPath = fileURLToPath(new URL("../corpus/pdfs/fms-2021-7.pdf", import.meta.url));
  if (!existsSync(fmsPath)) {
    t.diagnostic("corpus/pdfs/fms-2021-7.pdf is missing; the Attention fixture covered the stamp check");
    return;
  }
  const fms = readFileSync(fmsPath);
  const fmsStamped = replaceIpMarker(fms);
  assert.notEqual(sha256(fms), sha256(fmsStamped));
  assert.equal(await contentFingerprint(fms), await contentFingerprint(fmsStamped));
});

test("pre-label drops a Cambridge download line and keeps the other glyphs", () => {
  const stamp = "Downloaded from https://www.cambridge.org/core. IP address: 203.0.113.4, on 01 Jan 2000 at 12:15:41, subject to the Cambridge Core terms of use, available at";
  const viewport = {
    width: 400,
    height: 600,
    convertToViewportRectangle: (box) => box,
    convertToViewportPoint: (x, y) => [x, y]
  };
  const item = (str, x, y) => ({
    str,
    fontName: "Times-Roman",
    width: 80,
    height: 10,
    transform: [1, 0, 0, 1, x, y]
  });
  const page = labelPageFromRecord({
    paperId: "fms-2021-7",
    pageNumber: 1,
    viewport,
    text: { items: [item(stamp, 40, 20), item("x = 1", 40, 100), item("Downloaded from the archive yesterday", 40, 140)] },
    record: { elements: [] }
  });
  const chars = page.elements.map((element) => element.char);
  assert.equal(chars.includes(stamp), false);
  assert.equal(chars.includes("x = 1"), true);
  assert.equal(chars.includes("Downloaded from the archive yesterday"), true);
});
