import "./helpers/block-live-fetch.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function changedNames() {
  const bases = ["origin/main", "main"];
  for (const base of bases) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { stdio: "ignore" });
    } catch {
      continue;
    }
    try {
      return execFileSync("git", ["diff", "--name-only", base], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
    } catch {
      continue;
    }
  }
  return [];
}

// viewer 锁定随 F3-PR2 解除（Wisdom 2026-10-13）。
// lib/notes-* 继续锁定。只放开 lib/notes-store.js（Wisdom 2026-10-13 17:59，F4 PR-1）。
// lib/notes-view-model.js 在 F6b 后续放开（Wisdom 2026-10-19）：L3 空态文案、
// L4 无锚点 AI 回答进 AI 筛选、笔记正文改走共享 Markdown 渲染器。其余 lib/notes-* 仍锁定。
test("AX-23 notes files are untouched versus origin/main", () => {
  const names = changedNames();
  const allowed = new Set(["lib/notes-store.js", "lib/notes-view-model.js"]);
  const forbidden = names.filter((name) => name.startsWith("lib/notes-") && !allowed.has(name));
  assert.deepEqual(forbidden, []);
});
