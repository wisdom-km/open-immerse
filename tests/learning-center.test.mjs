import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { currentItems, canExport, toTxt, toMarkdown } from "../lib/export.js";
import { LEARNING_COPY, typeLabel, itemMeta, emptyAllHtml } from "../lib/learning-ui.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const sample = {
  id: "a1",
  type: "word",
  original: "immerse",
  translation: "沉浸",
  title: "Example",
  url: "https://example.com",
  context: "Open Immerse",
  nextReview: Date.UTC(2026, 8, 11)
};

test("L1 copy: title 学习中心, tabs, txt+md export — no brand in header", () => {
  assert.equal(LEARNING_COPY.title, "学习中心");
  assert.equal(LEARNING_COPY.tabAll, "全部");
  assert.equal(LEARNING_COPY.tabReview, "今日待复习");
  const html = readFileSync(join(root, "learning/learning.html"), "utf8");
  assert.match(html, /<title>学习中心<\/title>/);
  assert.match(html, /<h1>学习中心<\/h1>/);
  assert.equal(/沉浸译/.test(html), false);
  assert.match(html, /data-tab="all"[^>]*>全部</);
  assert.match(html, /data-tab="review"[^>]*>今日待复习</);
  assert.match(html, /data-export="txt"/);
  assert.match(html, /data-export="md"/);
});

test("L2 list meta uses type · source · next review", () => {
  assert.equal(typeLabel("word"), "单词");
  assert.equal(typeLabel("phrase"), "短语");
  assert.equal(typeLabel("sentence"), "句子");
  const meta = itemMeta(sample);
  assert.match(meta, /单词/);
  assert.match(meta, /Example/);
  assert.match(meta, /下次复习/);
  assert.match(meta, / · /);
});

test("L2 delete copy is ghost then inline confirm", () => {
  assert.equal(LEARNING_COPY.delete, "删除");
  assert.equal(LEARNING_COPY.confirmDelete, "确认删除");
  assert.equal(LEARNING_COPY.cancel, "取消");
  const src = readFileSync(join(root, "learning/learning.js"), "utf8");
  assert.match(src, /showDeleteConfirm/);
  assert.match(src, /data-confirm-del/);
  assert.match(src, /data-cancel-del/);
  assert.match(src, /class="ghost"/);
});

test("L3 review empty copy and grades", () => {
  assert.equal(LEARNING_COPY.emptyReview, "今日没有到期。");
  assert.equal(LEARNING_COPY.forgot, "忘了");
  assert.equal(LEARNING_COPY.fuzzy, "模糊");
  assert.equal(LEARNING_COPY.remembered, "记住");
  const html = readFileSync(join(root, "learning/learning.html"), "utf8");
  assert.match(html, /今日没有到期。/);
  assert.match(html, /data-g="1">忘了</);
  assert.match(html, /data-g="3">模糊</);
  assert.match(html, /data-g="5">记住</);
  assert.equal(html.includes("没有到期项目"), false);
});

test("L4 empty-all copy is title plus 藏 hint", () => {
  assert.equal(LEARNING_COPY.emptyAll, "还没有收藏。");
  assert.equal(LEARNING_COPY.emptyAllHint, "在网页选中文本，点「藏」或双击译文");
  const markup = emptyAllHtml();
  assert.match(markup, /还没有收藏。/);
  assert.match(markup, /在网页选中文本，点「藏」或双击译文/);
});

test("L5 export refuses empty lists and writes when non-empty", () => {
  assert.equal(LEARNING_COPY.emptyExport, "当前列表是空的");
  assert.equal(canExport([]), false);
  assert.equal(canExport(null), false);
  assert.equal(canExport([sample]), true);
  assert.ok(toTxt([sample]).includes("immerse"));
  assert.ok(toMarkdown([sample]).includes("沉浸"));
  const src = readFileSync(join(root, "learning/learning.js"), "utf8");
  assert.match(src, /canExport\(list\)/);
  assert.match(src, /LEARNING_COPY\.emptyExport/);
});

test("currentItems splits 全部 vs 今日待复习", () => {
  const due = [{ id: "d" }];
  const all = [sample, due[0]];
  assert.deepEqual(currentItems("review", all, due), due);
  assert.deepEqual(currentItems("all", all, due), all);
});

test("learning CSS uses Loom oi tokens", () => {
  const css = readFileSync(join(root, "learning/learning.css"), "utf8");
  assert.match(css, /--oi-bg:\s*#0b0d12/);
  assert.match(css, /--oi-panel:\s*#141821/);
  assert.match(css, /--oi-card:\s*#171a21/);
  assert.match(css, /--oi-line:\s*#2a3142/);
  assert.match(css, /--oi-text:\s*#eef2f8/);
  assert.match(css, /--oi-text-muted:\s*#9aa6b8/);
  assert.match(css, /--oi-accent:\s*#4d7cff/);
});

test("extension root has no underscore files except _locales", () => {
  const names = readdirSync(root);
  const underscored = names.filter((name) => name.startsWith("_") && name !== "_locales");
  assert.deepEqual(underscored, []);
});
