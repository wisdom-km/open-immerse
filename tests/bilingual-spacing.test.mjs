import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "content/content.css"), "utf8");
const js = readFileSync(join(root, "content/content.js"), "utf8");
const layout = readFileSync(join(root, "lib/bilingual-layout.js"), "utf8");

const bodyBlock = css.slice(css.indexOf(".oi-translation {"), css.indexOf(".oi-translation.oi-after-heading"));
const headingBlock = css.slice(css.indexOf(".oi-translation.oi-after-heading"), css.indexOf(".oi-translation.oi-inline"));
const inlineBlock = css.slice(css.indexOf(".oi-translation.oi-inline"), css.indexOf("html[data-oi-style=\"line\"]"));

test("body translations match Loom section 3 margin", () => {
  assert.match(bodyBlock, /吃掉宿主段后 margin，光学间距约 0\.4em/);
  assert.match(bodyBlock, /margin:\s*-0\.65em\s+0\s+0\.4em/);
  assert.match(bodyBlock, /padding-top:\s*0\.15em/);
  assert.match(bodyBlock, /--oi-body-gloss-gap/);
  assert.match(
    bodyBlock,
    /\.oi-translation:not\(\.oi-inline\):not\(\.oi-after-heading\):not\(\.oi-side-rail\)\s*\{[^}]*margin-top:\s*calc\(-0\.65em \+ \(var\(--oi-body-gloss-gap,\s*0\.35em\) - 0\.35em\)\)/s
  );
  assert.match(
    bodyBlock,
    /\.oi-translation:not\(\.oi-inline\):not\(\.oi-after-heading\):not\(\.oi-side-rail\)\s*\{[^}]*padding-top:\s*max\(0\.05em,\s*calc\(var\(--oi-body-gloss-gap,\s*0\.35em\) \* 0\.4\)\)/s
  );
  assert.match(bodyBlock, /BODY-GLOSS-GAP-CONTROL/);
  assert.match(bodyBlock, /BODY-GLOSS-STACK-GAP/);
  assert.match(
    bodyBlock,
    /\.oi-translation:not\(\.oi-inline\):not\(\.oi-after-heading\):not\(\.oi-side-rail\)\s*\{[^}]*margin-bottom:\s*var\(--oi-body-gloss-stack-gap,\s*0\.25em\)/s
  );
  assert.equal(/margin:\s*0\.08em/.test(bodyBlock), false);
  assert.equal(/margin:\s*-0\.65em\s+0\s+0\.1em/.test(bodyBlock), false);
});

test("heading translations start from a small em margin, not a locked 0.7rem", () => {
  assert.match(headingBlock, /0\.7rem 只是旧初值，不锁死/);
  assert.match(headingBlock, /0\.12–0\.28em/);
  assert.match(headingBlock, /margin:\s*0\.05em\s+0\s+0\.22em/);
  assert.match(headingBlock, /padding-top:\s*0\.14em/);
  assert.equal(/--oi-body-gloss-gap/.test(headingBlock), false);
  assert.equal(/--oi-body-gloss-stack-gap/.test(headingBlock), false);
  assert.equal(/margin:\s*0\.7rem/.test(headingBlock), false);
  assert.equal(/margin:\s*-0\.45em/.test(headingBlock), false);
});

test("BODY-HEADING-GLOSS-SIZE / §8 heading gloss uses rem token, not heading 1em", () => {
  assert.match(bodyBlock, /font-size:\s*calc\(1em \* var\(--oi-font-scale,\s*0\.95\)\)/);
  assert.match(bodyBlock, /font-weight:\s*400/);
  const headingFont = css.match(/\.oi-translation\.oi-after-heading:not\(\.oi-side-rail\)\s*\{[^}]+\}/s)?.[0] || "";
  assert.match(
    headingFont,
    /font-size:\s*var\(--oi-body-gloss-size,\s*calc\(1rem \* var\(--oi-font-scale,\s*0\.95\)\)\)/
  );
  assert.match(headingFont, /font-weight:\s*400/);
  assert.equal(/font-size:[^;]*1em/.test(headingFont), false);
  assert.match(headingBlock, /BODY-HEADING-GLOSS-SIZE/);
  assert.match(headingBlock, /BILINGUAL-SPACING §8/);
  assert.equal(/\.oi-translation\.oi-side-rail\s*\{[^}]*font-size:/s.test(css), false);
  assert.match(js, /--oi-body-font-size/);
  assert.match(js, /--oi-body-gloss-size/);
  assert.match(js, /readArticleBodyFontSize/);
  assert.match(layout, /HEADING_BODY_FONT_SLACK:\s*0\.05/);
  assert.match(layout, /withinHeadingBodyFontBand/);
  assert.match(layout, /--oi-body-gloss-size/);
  assert.match(layout, /applyHeadingBodyFontSize/);
  assert.match(layout, /resolveBodyTranslationFontSize/);
  assert.match(layout, /shouldMatchBodyFont/);
  assert.match(layout, /layoutTranslation[\s\S]*applyHeadingBodyFontSize/);
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
  assert.match(css, /html\[data-oi-style="card"\]\s+\.oi-translation:not\(\.oi-inline\)/);
  assert.match(css, /html\[data-oi-style="box"\]\s+\.oi-translation:not\(\.oi-inline\)/);
  assert.equal(/html\[data-oi-style="card"\][^{]*:not\(\.oi-after-heading\)/.test(css), false);
});

test("layoutTranslation measures heading gaps in source em and clamps > 0.32em", () => {
  assert.match(layout, /HEADING_MARGIN_TOP_EM:\s*0\.05/);
  assert.match(layout, /HEADING_PAD_TOP_EM:\s*0\.14/);
  assert.match(layout, /HEADING_TARGET_MIN_EM:\s*0\.12/);
  assert.match(layout, /HEADING_TARGET_MAX_EM:\s*0\.28/);
  assert.match(layout, /HEADING_HARD_MAX_EM:\s*0\.32/);
  assert.match(layout, /HEADING_HARD_MAX_PX:\s*10/);
  assert.match(layout, /BODY_GLOSS_GAP_DEFAULT_EM:\s*0\.35/);
  assert.match(layout, /BODY_GLOSS_STACK_GAP_DEFAULT_EM:\s*0\.25/);
  assert.match(layout, /--oi-body-gloss-gap/);
  assert.match(layout, /--oi-body-gloss-stack-gap/);
  assert.match(layout, /normalizeBodyGlossGap/);
  assert.match(layout, /normalizeBodyGlossStackGap/);
  assert.match(layout, /bodyMarginCalc/);
  assert.match(layout, /clampOversizedGap/);
  assert.match(layout, /applyGapPull/);
  assert.match(layout, /shouldClampOpticalGap/);
  assert.match(layout, /elementFontSize/);
  assert.match(layout, /headingGapLimitPx/);
  assert.match(layout, /layoutTranslation[\s\S]*clampOversizedGap/);
  assert.match(layout, /calc\(\$\{OIBilingual\.HEADING_PAD_TOP_EM\}em \+ /);
  assert.match(layout, /calc\(\$\{OIBilingual\.HEADING_MARGIN_TOP_EM\}em - \$\{pull\}px\)/);
  assert.equal(/0\.7rem/.test(layout), false);
  assert.match(js, /requestAnimationFrame/);
  assert.match(js, /--oi-body-gloss-gap/);
  assert.match(js, /--oi-body-gloss-stack-gap/);
  assert.match(js, /normalizeBodyGlossGap/);
  assert.match(js, /normalizeBodyGlossStackGap/);
  assert.doesNotMatch(css, /openai\.com|apple\.com|developer\.mozilla|react\.dev|anthropic\.com/i);
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
