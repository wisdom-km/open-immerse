import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { createOwnedTemp, installOwnedTmpGuard, leakedOwnedDirs } from "./helpers/owned-tmp.mjs";

const PREFIX = "oi-tmp-guard-";
installOwnedTmpGuard([PREFIX]);

test("owned temp names are removed and pre-existing names are not blamed", (t) => {
  const dir = createOwnedTemp(t, PREFIX);
  const name = basename(dir);
  assert.equal(existsSync(dir), true);
  assert.deepEqual(leakedOwnedDirs(new Set([name]), [PREFIX]), []);
  assert.deepEqual(leakedOwnedDirs(new Set(), [PREFIX]), [dir]);
  assert.deepEqual(leakedOwnedDirs(new Set(), ["other-prefix-"]), []);
});
