import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "content/content.css"), "utf8");
const js = readFileSync(join(root, "content/content.js"), "utf8");

const bodyBlock = css.slice(css.indexOf(".oi-translation {"), css.indexOf(".oi-translation.oi-after-heading"));
const headingBlock = css.slice(css.indexOf(".oi-translation.oi-after-heading"), css.indexOf(".oi-translation.oi-inline"));
const inlineBlock = css.slice(css.indexOf(".oi-translation.oi-inline"), css.indexOf("html[data-oi-style=\"line\"]"));

test("body translations match Loom section 3 margin", () => {
  assert.match(bodyBlock, /吃掉宿主段后 margin，光学间距约 0\.4em/);
  assert.match(bodyBlock, /margin:\s*-0\.65em\s+0\s+0\.4em/);
  assert.match(bodyBlock, /padding-top:\s*0\.15em/);
  assert.equal(/margin:\s*0\.08em/.test(bodyBlock), false);
  assert.equal(/margin:\s*-0\.65em\s+0\s+0\.1em/.test(bodyBlock), false);
});

test("heading translations use 0.45em padding-top to clear descenders", () => {
  assert.match(headingBlock, /padding-top:\s*0\.45em/);
  assert.match(headingBlock, /margin:\s*0\.7rem\s+0\s+0\.45rem/);
  assert.equal(/padding-top:\s*0\.15em/.test(headingBlock), false);
  assert.equal(/padding-top:\s*0\.2rem/.test(headingBlock), false);
});

test("inline translations stay on the same line with a small left gap", () => {
  assert.match(inlineBlock, /display:\s*inline/);
  assert.match(inlineBlock, /margin:\s*0\s+0\s+0\s+0\.4em/);
});

test("side-rail translations keep body underline but not the body pull-up margin", () => {
  assert.match(css, /\.oi-side-rail-host\s*\{[^}]*flex-wrap:\s*wrap\s*!important/s);
  assert.match(css, /\.oi-side-rail-host\s*\{[^}]*flex-direction:\s*column\s*!important/s);
  assert.match(css, /\.oi-translation\.oi-side-rail\s*\{[^}]*display:\s*block/s);
  assert.match(css, /\.oi-translation\.oi-side-rail\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.oi-translation\.oi-side-rail\s*\{[^}]*min-width:\s*100%/s);
  assert.match(css, /\.oi-translation\.oi-side-rail\s*\{[^}]*flex-basis:\s*100%/s);
  assert.match(css, /\.oi-translation\.oi-side-rail\s*\{[^}]*margin:\s*0\.15em\s+0\s+0\.2em/s);
  assert.equal(/\.oi-translation\.oi-side-rail\s*\{[^}]*oi-inline/s.test(css), false);
});

test("block body translations keep the default under border-bottom", () => {
  assert.match(bodyBlock, /border-bottom:\s*1px\s+dashed/);
  assert.match(css, /html\[data-oi-style="line"\]\s+\.oi-translation\s*\{[^}]*border-bottom-style:\s*solid/s);
  assert.match(css, /html\[data-oi-style="dim"\]\s+\.oi-translation\s*\{[^}]*border-bottom-style:\s*dotted/s);
});

test("card and box styles keep existing padding and frame", () => {
  assert.match(css, /html\[data-oi-style="card"\][\s\S]*padding:\s*0\.4em\s+0\.65em/);
  assert.match(css, /html\[data-oi-style="box"\][\s\S]*padding:\s*0\.4em\s+0\.65em/);
  assert.match(css, /html\[data-oi-style="card"\][\s\S]*border-left-width:\s*3px/);
  assert.equal(/:not\(\.oi-after-heading\)/.test(css), false);
});

test("content.js still marks H1–H3 as oi-after-heading afterend", () => {
  assert.match(js, /\^H\[1-3\]\$/);
  assert.match(js, /oi-translation oi-after-heading/);
  assert.match(js, /insertAdjacentElement\("afterend"/);
});

test("block translations drop fit-content and stay inside the source column", () => {
  assert.match(css, /\.oi-translation:not\(\.oi-inline\)\s*\{[^}]*box-sizing:\s*border-box/s);
  assert.match(css, /\.oi-translation:not\(\.oi-inline\)\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.oi-translation:not\(\.oi-inline\)\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.oi-translation:not\(\.oi-inline\)\s*\{[^}]*flex-basis:\s*100%/s);
  assert.match(css, /\.oi-translation:not\(\.oi-inline\)\s*\{[^}]*flex-grow:\s*1/s);
  assert.match(css, /\.oi-translation:not\(\.oi-inline\)\s*\{[^}]*flex-shrink:\s*0/s);
  assert.match(css, /\.oi-translation:not\(\.oi-inline\)\s*\{[^}]*align-self:\s*stretch/s);
  assert.match(css, /\.oi-bilingual-stack\s*\{[^}]*flex-direction:\s*column/s);
  assert.equal(/width:\s*fit-content/.test(css), false);
  assert.match(bodyBlock, /overflow-wrap:\s*break-word/);
  assert.match(js, /layoutMountedTranslation/);
  assert.match(js, /breakFlexRow/);
  assert.match(js, /OIBilingual\?\.layoutTranslation/);
  assert.match(js, /bindHost/);
  assert.match(js, /requestAnimationFrame/);
  assert.match(js, /dedupeTranslations/);
});
