import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BODY_GLOSS_STACK_GAP_DEFAULT,
  BODY_GLOSS_STACK_GAP_MAX,
  BODY_GLOSS_STACK_GAP_MIN,
  DEFAULT_SETTINGS,
  normalizeBodyGlossGap,
  normalizeBodyGlossStackGap
} from "../lib/storage.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "content/content.css"), "utf8");
const js = readFileSync(join(root, "content/content.js"), "utf8");
const layoutSrc = readFileSync(join(root, "lib/bilingual-layout.js"), "utf8");
const optionsHtml = readFileSync(join(root, "options/options.html"), "utf8");

function loadBilingual() {
  const ctx = createContext({ globalThis: {} });
  runInContext(layoutSrc, ctx);
  return ctx.globalThis.OIBilingual;
}

function glossEl(fs = 16) {
  return {
    ownerDocument: {
      documentElement: {
        style: { getPropertyValue() { return ""; } }
      },
      defaultView: {
        getComputedStyle() {
          return { fontSize: `${fs}px`, getPropertyValue() { return ""; } };
        }
      }
    },
    style: { getPropertyValue() { return ""; } },
    classList: {
      contains(name) {
        return name === "oi-translation";
      }
    }
  };
}

const bodyOnly =
  css.match(
    /\.oi-translation:not\(\.oi-inline\):not\(\.oi-after-heading\):not\(\.oi-side-rail\)\s*\{[^}]+\}/s
  )?.[0] || "";
const heading = css.slice(
  css.indexOf(".oi-translation.oi-after-heading {"),
  css.indexOf(".oi-translation.oi-inline")
);
const rail = css.match(/\.oi-translation\.oi-side-rail\s*\{[^}]+\}/s)?.[0] || "";

test("BODY-GLOSS-STACK-GAP-VISIBLE range 0–2.5 keeps 2 legal", () => {
  assert.equal(DEFAULT_SETTINGS.bodyGlossStackGap, 0.25);
  assert.equal(BODY_GLOSS_STACK_GAP_DEFAULT, 0.25);
  assert.equal(BODY_GLOSS_STACK_GAP_MIN, 0);
  assert.equal(BODY_GLOSS_STACK_GAP_MAX, 2.5);
  assert.equal(normalizeBodyGlossStackGap(2), 2);
  assert.equal(normalizeBodyGlossStackGap(2.5), 2.5);
  assert.equal(normalizeBodyGlossStackGap(1.2), 1.2);
  assert.equal(normalizeBodyGlossStackGap(9), 2.5);
  assert.notEqual(BODY_GLOSS_STACK_GAP_MAX, 1.2);
  assert.match(optionsHtml, /id="bodyGlossStackGap"[^>]*type="number"/);
  assert.match(optionsHtml, /id="bodyGlossStackGap"[^>]*min="0"/);
  assert.match(optionsHtml, /id="bodyGlossStackGap"[^>]*max="2.5"/);
  assert.match(optionsHtml, /id="bodyGlossStackGap"[^>]*step="0.05"/);
  assert.match(optionsHtml, /0–2\.5，默认 0\.25/);
  const OI = loadBilingual();
  assert.equal(OI.BODY_GLOSS_STACK_GAP_MAX_EM, 2.5);
  assert.equal(OI.normalizeBodyGlossStackGap(2), 2);
  assert.equal(OI.normalizeBodyGlossStackGap(3), 2.5);
});

test("BODY-GLOSS-STACK-GAP-VISIBLE CSS is body-only calc(var * 1em) + isolation", () => {
  assert.match(css, /BODY-GLOSS-STACK-GAP-VISIBLE/);
  assert.match(bodyOnly, /margin-bottom:\s*calc\(var\(--oi-body-gloss-stack-gap,\s*0\.25\) \* 1em\)/);
  assert.match(bodyOnly, /display:\s*inline-block/);
  assert.match(bodyOnly, /vertical-align:\s*top/);
  assert.equal(/--oi-body-gloss-stack-gap/.test(heading), false);
  assert.equal(/--oi-body-gloss-stack-gap/.test(rail), false);
  assert.match(heading, /margin:\s*0\.05em\s+0\s+0\.22em/);
  assert.match(rail, /margin:\s*0\.15em\s+0\s+0\.2em/);
  assert.match(js, /setProperty\("--oi-body-gloss-stack-gap", `\$\{Number\.isFinite\(stackGap\) \? stackGap : 0\.25\}`\)/);
  assert.doesNotMatch(js, /setProperty\("--oi-body-gloss-stack-gap", `\$\{[^}]+\}em`\)/);
});

test("BODY-GLOSS-STACK-GAP-VISIBLE does not change bodyGlossGap src→gloss", () => {
  assert.equal(normalizeBodyGlossGap(0.35), 0.35);
  assert.equal(DEFAULT_SETTINGS.bodyGlossGap, 0.35);
  assert.match(bodyOnly, /margin-top:\s*calc\(-0\.65em \+ \(var\(--oi-body-gloss-gap,\s*0\.35em\) - 0\.35em\)\)/);
  assert.match(bodyOnly, /padding-top:\s*max\(0\.05em,\s*calc\(var\(--oi-body-gloss-gap,\s*0\.35em\) \* 0\.4\)\)/);
});

test("BODY-GLOSS-STACK-GAP-VISIBLE Anvil note + 0.25/1/2 ratios", () => {
  // Anvil: g = isolated body gloss margin-bottom px (value × translation em).
  // Do not max() with the next source margin-top, and do not include the
  // intervening English paragraph height. Screenshots: /workspace/oi-qa/gloss-stack-gap/{0.25,1,2}.png
  assert.match(layoutSrc, /BODY-GLOSS-STACK-GAP-VISIBLE/);
  assert.match(layoutSrc, /Anvil: g = isolated body gloss margin-bottom px/);
  assert.match(layoutSrc, /g\(1\)\/g\(0\.25\) ∈ \[3,5\], g\(2\)\/g\(1\) ∈ \[1\.5,2\.5\]/);

  const OI = loadBilingual();
  const el = glossEl(16);
  const g025 = OI.opticalBodyGlossStackGapPx(el, 0.25);
  const g1 = OI.opticalBodyGlossStackGapPx(el, 1);
  const g2 = OI.opticalBodyGlossStackGapPx(el, 2);
  assert.equal(g025, 4);
  assert.equal(g1, 16);
  assert.equal(g2, 32);
  const r1 = g1 / g025;
  const r2 = g2 / g1;
  assert.ok(r1 >= 3 && r1 <= 5, `g(1)/g(0.25)=${r1}`);
  assert.ok(r2 >= 1.5 && r2 <= 2.5, `g(2)/g(1)=${r2}`);

  const hostTop = 1.5;
  assert.equal(OI.collapsedBodyGlossStackGapEm(0.25, hostTop), hostTop);
  assert.equal(OI.collapsedBodyGlossStackGapEm(1, hostTop), hostTop);
  assert.equal(OI.collapsedBodyGlossStackGapEm(0.25, hostTop), OI.collapsedBodyGlossStackGapEm(1, hostTop));
  const collapsedRatio = OI.collapsedBodyGlossStackGapEm(1, hostTop)
    / OI.collapsedBodyGlossStackGapEm(0.25, hostTop);
  assert.ok(collapsedRatio < 3, "collapsed sibling margins must not be the Anvil g");
});

test("BODY-GLOSS-STACK-GAP-VISIBLE isolation is body-only", () => {
  const OI = loadBilingual();
  const body = { classList: { contains: (n) => n === "oi-translation" } };
  const headingEl = { classList: { contains: (n) => n === "oi-translation" || n === "oi-after-heading" } };
  const railEl = { classList: { contains: (n) => n === "oi-translation" || n === "oi-side-rail" } };
  const inline = { classList: { contains: (n) => n === "oi-translation" || n === "oi-inline" } };
  assert.equal(OI.isBodyTranslation(body), true);
  assert.equal(OI.bodyStackGapDisplay(body), "inline-block");
  assert.equal(OI.bodyStackGapDisplay(headingEl), "block");
  assert.equal(OI.bodyStackGapDisplay(railEl), "block");
  assert.equal(OI.bodyStackGapDisplay(inline), "block");
  assert.equal(OI.isBodyTranslation(headingEl), false);
  assert.equal(OI.isBodyTranslation(railEl), false);
});
