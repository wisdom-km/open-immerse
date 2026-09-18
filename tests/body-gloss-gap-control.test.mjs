import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BODY_GLOSS_GAP_DEFAULT,
  BODY_GLOSS_GAP_MAX,
  BODY_GLOSS_GAP_MIN,
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
const optionsJs = readFileSync(join(root, "options/options.js"), "utf8");

function loadBilingual() {
  const ctx = createContext({ globalThis: {} });
  runInContext(layoutSrc, ctx);
  return ctx.globalThis.OIBilingual;
}

test("BODY-GLOSS-GAP-CONTROL Options number inputs + storage hard gates", () => {
  assert.equal(DEFAULT_SETTINGS.bodyGlossGap, 0.35);
  assert.equal(BODY_GLOSS_GAP_DEFAULT, 0.35);
  assert.equal(BODY_GLOSS_GAP_MIN, 0.1);
  assert.equal(BODY_GLOSS_GAP_MAX, 0.7);
  assert.equal(normalizeBodyGlossGap(undefined), 0.35);
  assert.equal(normalizeBodyGlossGap("nope"), 0.35);
  assert.equal(DEFAULT_SETTINGS.bodyGlossStackGap, 0.25);
  assert.equal(BODY_GLOSS_STACK_GAP_DEFAULT, 0.25);
  assert.equal(BODY_GLOSS_STACK_GAP_MIN, 0);
  assert.equal(BODY_GLOSS_STACK_GAP_MAX, 2.5);
  assert.equal(normalizeBodyGlossStackGap(undefined), 0.25);
  assert.equal(normalizeBodyGlossStackGap("nope"), 0.25);
  assert.equal(normalizeBodyGlossStackGap(0), 0);
  assert.equal(normalizeBodyGlossStackGap(-1), 0);
  assert.equal(normalizeBodyGlossStackGap(2), 2);
  assert.equal(normalizeBodyGlossStackGap(2.5), 2.5);
  assert.equal(normalizeBodyGlossStackGap(3), 2.5);
  assert.match(optionsHtml, /正文译文间距/);
  assert.match(optionsHtml, /译文段间距/);
  assert.doesNotMatch(optionsHtml, /Body gloss gap|Between translations/);
  assert.match(optionsHtml, /id="bodyGlossGap"[^>]*type="number"/);
  assert.match(optionsHtml, /id="bodyGlossGap"[^>]*min="0.10"/);
  assert.match(optionsHtml, /id="bodyGlossGap"[^>]*max="0.70"/);
  assert.match(optionsHtml, /id="bodyGlossGap"[^>]*step="0.05"/);
  assert.match(optionsHtml, /id="bodyGlossStackGap"[^>]*type="number"/);
  assert.match(optionsHtml, /id="bodyGlossStackGap"[^>]*min="0"/);
  assert.match(optionsHtml, /id="bodyGlossStackGap"[^>]*max="2.5"/);
  assert.match(optionsHtml, /id="bodyGlossStackGap"[^>]*step="0.05"/);
  assert.doesNotMatch(optionsHtml, /type="range"/);
  assert.doesNotMatch(optionsHtml, /id="bodyGlossGapValue"/);
  assert.match(optionsHtml, /原文与其下段落译文的空隙（em）。不影响标题译文。/);
  assert.match(optionsHtml, /相邻两段正文译文之间的空隙（em，0–2\.5，默认 0\.25）。不含标题译文、侧栏。/);
  assert.match(optionsHtml, /id="fontScale"[\s\S]*id="bodyGlossGap"[\s\S]*id="bodyGlossStackGap"/);
  const later = optionsHtml.match(/<details class="later">[\s\S]*?<\/details>/)?.[0] || "";
  assert.doesNotMatch(later, /id="bodyGlossGap"/);
  assert.doesNotMatch(later, /id="bodyGlossStackGap"/);
  assert.match(optionsJs, /bodyGlossGap: normalizeBodyGlossGap/);
  assert.match(optionsJs, /bodyGlossStackGap: normalizeBodyGlossStackGap/);
  assert.match(js, /root\.style\.setProperty\("--oi-body-gloss-gap"/);
  assert.match(js, /root\.style\.setProperty\("--oi-body-gloss-stack-gap"/);
});

test("BODY-GLOSS-GAP-CONTROL CSS applies only to main-column paragraphs", () => {
  const bodyOnly =
    css.match(
      /\.oi-translation:not\(\.oi-inline\):not\(\.oi-after-heading\):not\(\.oi-side-rail\)\s*\{[^}]+\}/s
    )?.[0] || "";
  assert.match(bodyOnly, /--oi-body-gloss-gap/);
  assert.match(bodyOnly, /--oi-body-gloss-stack-gap/);
  assert.match(bodyOnly, /margin-top:\s*calc\(-0\.65em \+ \(var\(--oi-body-gloss-gap,\s*0\.35em\) - 0\.35em\)\)/);
  assert.match(bodyOnly, /margin-bottom:\s*calc\(var\(--oi-body-gloss-stack-gap,\s*0\.25\) \* 1em\)/);
  assert.match(bodyOnly, /display:\s*flow-root/);
  assert.match(
    css,
    /\.oi-translation:not\(\.oi-inline\):not\(\.oi-after-heading\):not\(\.oi-side-rail\) \+ :is\(p, blockquote, figure\)\s*\{[^}]*margin-top:\s*0/s
  );
  const heading = css.slice(
    css.indexOf(".oi-translation.oi-after-heading {"),
    css.indexOf(".oi-translation.oi-inline")
  );
  const rail = css.match(/\.oi-translation\.oi-side-rail\s*\{[^}]+\}/s)?.[0] || "";
  assert.equal(/--oi-body-gloss-gap/.test(heading), false);
  assert.equal(/--oi-body-gloss-stack-gap/.test(heading), false);
  assert.equal(/--oi-body-gloss-gap/.test(rail), false);
  assert.equal(/--oi-body-gloss-stack-gap/.test(rail), false);
  assert.match(heading, /margin:\s*0\.05em\s+0\s+0\.22em/);
  assert.match(rail, /margin:\s*0\.15em\s+0\s+0\.2em/);
});

test("BILINGUAL-SPACING §7 heading band is 0.12–0.28em and fails > 0.32em", () => {
  const OI = loadBilingual();
  assert.match(layoutSrc, /§7 target 0\.12–0\.28em/);
  assert.match(css, /§7 0\.12–0\.28em/);
  assert.equal(OI.HEADING_TARGET_MIN_EM, 0.12);
  assert.equal(OI.HEADING_TARGET_MAX_EM, 0.28);
  assert.equal(OI.HEADING_HARD_MAX_EM, 0.32);
  assert.equal(OI.HEADING_BODY_FONT_SLACK, 0.05);
  assert.ok(OI.needsGapClamp(OI.fontSizePx(32) * 0.33, OI.headingTightenPx(32)));
  assert.equal(OI.needsGapClamp(OI.headingTargetPx(32), OI.headingTightenPx(32)), false);
});

test("§8 heading gloss size stays body-token, orthogonal to the gap inputs", () => {
  assert.match(css, /BODY-HEADING-GLOSS-SIZE \/ BILINGUAL-SPACING §8/);
  assert.match(
    css,
    /\.oi-translation\.oi-after-heading:not\(\.oi-side-rail\)\s*\{[^}]*font-size:\s*var\(--oi-body-gloss-size/s
  );
  assert.match(layoutSrc, /shouldMatchBodyFont/);
  assert.match(layoutSrc, /applyHeadingBodyFontSize/);
  const OI = loadBilingual();
  assert.equal(OI.shouldMatchBodyFont({ classList: { contains: (n) => n === "oi-after-heading" } }, { tagName: "H2" }), true);
  assert.doesNotMatch(css, /openai\.com|apple\.com|developer\.apple|developer\.mozilla|react\.dev|anthropic\.com/i);
  assert.doesNotMatch(js, /openai\.com|apple\.com|developer\.mozilla|anthropic\.com/i);
  assert.doesNotMatch(layoutSrc, /openai\.com|apple\.com|developer\.mozilla|anthropic\.com/i);
});
