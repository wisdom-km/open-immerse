import test from "node:test";
import assert from "node:assert/strict";
import { CJK_SERIF_CANDIDATES, detectCjkSerif } from "../lib/pdf-reader-cjk.js";

const SAME = { w: 100, asc: 40, desc: 10 };

function measureOf(present) {
  return (cssFont) => {
    const hit = present.find((family) => cssFont.includes(`"${family}"`));
    if (!hit) return SAME;
    return { w: SAME.w + 8, asc: SAME.asc, desc: SAME.desc };
  };
}

test("cjk serif detection ignores SimSun and treats a serif-generic match as present", () => {
  assert.equal(detectCjkSerif(() => SAME).serif, false);
  assert.equal(detectCjkSerif(measureOf(["SimSun"])).serif, false);
  const songti = detectCjkSerif(measureOf(["Songti SC"]));
  assert.equal(songti.serif, true);
  assert.equal(songti.family, "Songti SC");
  const noto = detectCjkSerif((cssFont) => {
    if (cssFont.includes('"Noto Serif CJK SC"') && cssFont.endsWith("serif")) return SAME;
    if (cssFont.includes('"Noto Serif CJK SC"')) return { w: SAME.w + 4, asc: SAME.asc, desc: SAME.desc };
    return SAME;
  });
  assert.equal(noto.serif, true);
  assert.equal(noto.family, "Noto Serif CJK SC");
  assert.equal(CJK_SERIF_CANDIDATES.includes("SimSun"), false);
  assert.equal(CJK_SERIF_CANDIDATES.includes("STSong"), false);
});
