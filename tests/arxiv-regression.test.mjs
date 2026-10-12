import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("AX-23 viewer and notes files are untouched versus origin/main", () => {
  const names = execFileSync("git", ["diff", "--name-only", "origin/main"], {
    encoding: "utf8"
  }).split("\n").filter(Boolean);
  const forbidden = names.filter((name) =>
    name === "pdf/viewer.js" ||
    name === "pdf/viewer.html" ||
    name === "pdf/viewer.css" ||
    name.startsWith("lib/notes-")
  );
  assert.deepEqual(forbidden, []);
});
