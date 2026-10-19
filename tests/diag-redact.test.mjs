import test from "node:test";
import assert from "node:assert/strict";

import {
  redactDiagEvent,
  scrubDiagMessage,
  scrubDiagUrl
} from "../lib/diag-redact.js";

const SECRET = "mm-key-9z";
const URL_TOKEN = "sig9zz";
const PAPER = "paper9z";
const TITLE = "title9z";
const TRANS = "trans9z";
const NOTE = "note9z";
const ANS = "ans9z";

test("scrubDiagUrl keeps an http page and drops credentials, fragments, and sensitive query keys", () => {
  const raw = `https://user:pw@papers.example/a;token=${URL_TOKEN}?page=3&sig=${URL_TOKEN}&X-Amz-Signature=${URL_TOKEN}&x_amz_token=${URL_TOKEN}&key=${SECRET}&code=c0de9z&access_key=ak9z99&otp=otp9z1&hmac=hm9z99#frag9z`;
  const clean = scrubDiagUrl(raw);
  assert.match(clean, /^https:\/\/papers\.example\/a\?/);
  assert.match(clean, /page=3/);
  assert.equal(clean.includes("user:pw"), false);
  assert.equal(clean.includes("frag9z"), false);
  assert.equal(clean.includes(URL_TOKEN), false);
  assert.equal(clean.includes(SECRET), false);
  assert.equal(clean.includes("c0de9z"), false);
  assert.equal(clean.includes("ak9z99"), false);
  assert.equal(clean.includes("otp9z1"), false);
  assert.equal(clean.includes("hm9z99"), false);
});

test("scrubDiagUrl reduces non-http urls to the scheme", () => {
  assert.equal(scrubDiagUrl("file:///tmp/paper.pdf"), "file:");
  assert.equal(scrubDiagUrl("blob:abcd"), "blob:");
  assert.equal(scrubDiagUrl("chrome-extension://abc/x"), "chrome-extension:");
  assert.equal(scrubDiagUrl("data:text/plain,hi"), "data:");
});

test("scrubDiagMessage removes short url tokens that provider redaction keeps", () => {
  const msg = scrubDiagMessage(`see https://papers.example/a?sig=${URL_TOKEN} page`, []);
  assert.equal(msg.includes(URL_TOKEN), false);
  assert.match(msg, /papers\.example/);
});

test("scrubDiagMessage removes short secret values that provider redaction keeps", () => {
  const msg = scrubDiagMessage(`key was ${SECRET} and Authorization: ${SECRET} x-api-key=${SECRET}`, [SECRET]);
  assert.equal(msg.includes(SECRET), false);
  assert.match(msg, /\*\*\*/);
});

test("redactDiagEvent drops paper text fields", () => {
  const event = redactDiagEvent({
    t: 10,
    type: "translate.error",
    ctx: "sw",
    code: "401",
    msg: "failed",
    provider: "openai",
    count: 2,
    text: PAPER,
    title: TITLE,
    translation: TRANS,
    note: NOTE,
    answer: ANS,
    raw: "extra9z"
  }, []);
  const packed = JSON.stringify(event);
  assert.equal(event.type, "translate.error");
  assert.equal(event.ctx, "sw");
  assert.equal(event.code, "401");
  assert.equal(event.msg, "failed");
  assert.equal(event.provider, "openai");
  assert.equal(event.count, 2);
  assert.equal(packed.includes(PAPER), false);
  assert.equal(packed.includes(TITLE), false);
  assert.equal(packed.includes(TRANS), false);
  assert.equal(packed.includes(NOTE), false);
  assert.equal(packed.includes(ANS), false);
  assert.equal(packed.includes("extra9z"), false);
  assert.equal("text" in event, false);
  assert.equal("title" in event, false);
  assert.equal("translation" in event, false);
  assert.equal("note" in event, false);
  assert.equal("answer" in event, false);
});

test("redactDiagEvent rejects a bad type and caps the message", () => {
  assert.equal(redactDiagEvent({ type: "Has Space", msg: "x" }), null);
  const event = redactDiagEvent({ type: "mm.error", msg: "测".repeat(500) }, []);
  assert.equal(event.msg.length, 300);
});
