import test from "node:test";
import assert from "node:assert/strict";

import {
  collectSecretValues,
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

test("scrubDiagMessage masks header credentials that are not stored secrets", () => {
  const samples = [
    "{\"headers\":{\"Authorization\":\"Basic dXNlcjpwYXNz\"}}",
    "Authorization=Basic dXNlcjpwYXNz",
    "authorization:  Token abc.def.ghi",
    "\"x-api-key\": \"shortk1\"",
    "api-key: shortk2",
    "x-goog-api-key: AIzaShort",
    "DeepL-Auth-Key abc:fx",
    "Authorization: DeepL-Auth-Key abc:fx",
    "Authorization: Digest username=\"u\", response=\"RESP99\"",
    "Proxy-Authorization: Basic Zm9vOmJhcg==",
    "Cookie: sid=SID99xx"
  ];
  for (const sample of samples) {
    const msg = scrubDiagMessage(sample, []);
    assert.equal(msg.includes("dXNlcjpwYXNz"), false, sample);
    assert.equal(msg.includes("abc.def.ghi"), false, sample);
    assert.equal(msg.includes("shortk1"), false, sample);
    assert.equal(msg.includes("shortk2"), false, sample);
    assert.equal(msg.includes("AIzaShort"), false, sample);
    assert.equal(msg.includes("abc:fx"), false, sample);
    assert.equal(msg.includes("RESP99"), false, sample);
    assert.equal(msg.includes("Zm9vOmJhcg=="), false, sample);
    assert.equal(msg.includes("SID99xx"), false, sample);
  }
});

test("scrub clips raw text before url and header scans", () => {
  const marker = "TAILMARK99";
  const blob = `https://user:pw@example.com/a?token=${"x".repeat(3000)} ${marker}`;
  const msg = scrubDiagMessage(blob, []);
  assert.equal(msg.includes(marker), false);
  assert.equal(msg.includes("user:pw"), false);
});

test("scrubDiagUrl reduces ws, ftp, and scheme-relative userinfo", () => {
  assert.equal(scrubDiagUrl("ws://user:pw97@x.example/?token=WSTOK99"), "ws:");
  assert.equal(scrubDiagUrl("ftp://user:pw96@x.example/f"), "ftp:");
  const relative = scrubDiagMessage("see //user:pw98@x.example/a?token=PRTOK99 end", []);
  assert.equal(relative.includes("pw98"), false);
  assert.equal(relative.includes("PRTOK99"), false);
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

test("redactDiagEvent keeps a model id and drops secrets, urls, and paper text", () => {
  const secret = "sk-borrow-unit-key";
  const base = "https://api.moonshot.cn/v1";
  const event = redactDiagEvent({
    type: "translate.borrow",
    ctx: "sw",
    provider: "kimi",
    model: "kimi-k2",
    reason: "translate-unconfigured",
    ok: true,
    apiKey: secret,
    authorization: `Bearer ${secret}`,
    baseUrl: base,
    text: PAPER,
    translation: TRANS
  }, [secret]);
  assert.equal(event.provider, "kimi");
  assert.equal(event.model, "kimi-k2");
  assert.equal(event.reason, "translate-unconfigured");
  assert.equal(event.ok, true);
  const packed = JSON.stringify(event);
  assert.equal(packed.includes(secret), false);
  assert.equal(packed.includes("Authorization"), false);
  assert.equal(packed.includes("Bearer"), false);
  assert.equal(packed.includes(base), false);
  assert.equal(packed.includes(PAPER), false);
  assert.equal(packed.includes(TRANS), false);
  assert.equal("apiKey" in event, false);
  assert.equal("baseUrl" in event, false);
  assert.equal("text" in event, false);
  assert.equal("translation" in event, false);

  const asModel = redactDiagEvent({
    type: "translate.borrow",
    ctx: "sw",
    provider: "kimi",
    model: secret,
    reason: "translate-unconfigured"
  }, [secret]);
  assert.equal(asModel.model, undefined);
  assert.equal(JSON.stringify(asModel).includes(secret), false);

  assert.equal(redactDiagEvent({ type: "translate.borrow", model: "k".repeat(40) }, []).model, "k".repeat(40));
  assert.equal(redactDiagEvent({ type: "translate.borrow", model: "k".repeat(41) }, []).model, "k".repeat(40));
  assert.equal(redactDiagEvent({ type: "translate.borrow", model: "moonshotai/kimi-k2" }, []).model, "moonshotai/kimi-k2");
  assert.equal(redactDiagEvent({ type: "translate.borrow", model: "moonshotai/kimi-k2:free" }, []).model, "moonshotai/kimi-k2:free");
  const slashModel = `moonshotai/${"k".repeat(40)}`;
  assert.equal(redactDiagEvent({ type: "translate.borrow", model: slashModel }, []).model, slashModel.slice(0, 40));
  assert.equal(redactDiagEvent({ type: "translate.borrow", model: base }, []).model, undefined);
  assert.equal(redactDiagEvent({ type: "translate.borrow", model: "kimi k2" }, []).model, undefined);
  const longKey = `sk-${"a".repeat(45)}`;
  const clippedKey = redactDiagEvent({ type: "translate.borrow", model: longKey.slice(0, 40) }, [longKey]);
  assert.equal(clippedKey.model, undefined);
  assert.equal(JSON.stringify(clippedKey).includes(longKey.slice(0, 40)), false);
});

test("collectSecretValues includes formula.multimodal.apiKey and drops that key from a model field", () => {
  const secret = "sk-formula-model-leak";
  const secrets = collectSecretValues({
    formula: { multimodal: { apiKey: secret, model: "kimi-k2" } }
  });
  assert.equal(secrets.includes(secret), true);
  const event = redactDiagEvent({
    type: "translate.borrow",
    ctx: "sw",
    provider: "kimi",
    model: secret,
    reason: "translate-unconfigured"
  }, secrets);
  assert.equal(event.model, undefined);
  assert.equal(JSON.stringify(event).includes(secret), false);
  assert.equal(event.reason, "translate-unconfigured");
});

test("redactDiagEvent rejects a bad type and caps the message", () => {
  assert.equal(redactDiagEvent({ type: "Has Space", msg: "x" }), null);
  const event = redactDiagEvent({ type: "mm.error", msg: "测".repeat(500) }, []);
  assert.equal(event.msg.length, 300);
});
