/** Detect a user-installed CJK serif. SimSun does not count. No user-agent check. */

export const CJK_SERIF_CANDIDATES = Object.freeze([
  "Source Han Serif SC",
  "Source Han Serif CN",
  "思源宋体",
  "Source Han Serif SC VF",
  "Noto Serif CJK SC",
  "Noto Serif SC",
  "Songti SC"
]);

const BASES = ["monospace", "sans-serif", "serif"];
const TEST = "mmmmmmmmmmlliWWQ@ 永和体验国";
const PX = 64;
const EPS = 0.5;

const differs = (measured, baseline) => (
  Math.abs(measured.w - baseline.w) > EPS
  || Math.abs(measured.asc - baseline.asc) > EPS
  || Math.abs(measured.desc - baseline.desc) > EPS
);

/**
 * @param {(cssFont: string, text: string) => { w: number, asc: number, desc: number }} measure
 */
export function detectCjkSerif(measure) {
  const base = Object.fromEntries(BASES.map((family) => [family, measure(`${PX}px ${family}`, TEST)]));
  for (const family of CJK_SERIF_CANDIDATES) {
    for (const generic of BASES) {
      const measured = measure(`${PX}px "${family}", ${generic}`, TEST);
      if (differs(measured, base[generic])) return { serif: true, family };
    }
  }
  return { serif: false, family: null };
}

export function canvasMeasure() {
  const canvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(8, 8)
    : document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  return (font, text) => {
    ctx.font = font;
    const metrics = ctx.measureText(text);
    return {
      w: metrics.width,
      asc: metrics.actualBoundingBoxAscent || 0,
      desc: metrics.actualBoundingBoxDescent || 0
    };
  };
}
