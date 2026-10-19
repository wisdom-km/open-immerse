// Side-effect import. Compiles the vendored markdown-it UMD onto globalThis.
// The viewer loads the same file with a classic script. Tests must not fetch it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const file = join(root, "pdf/vendor/markdown-it/markdown-it.min.js");
const mod = new (require("module").Module)(file);
mod.filename = file;
mod.paths = require("module").Module._nodeModulePaths(dirname(file));
mod._compile(readFileSync(file, "utf8"), file);
const factory = mod.exports;
if (typeof factory !== "function") {
  throw new Error("vendored markdown-it did not export a function");
}
globalThis.markdownit = factory;
