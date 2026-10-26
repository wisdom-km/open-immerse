/**
 * Text-layer glyph cleanup for journal PDFs (M1).
 * Map version: m1-1.
 *
 * Runs before line grouping. Invisible characters and a small set of
 * well-known ToUnicode misses are rewritten. Equals signs are never
 * rewritten (a run of "=" is not a slash). Superscripts and line-end
 * hyphens are left alone; the rubric does not count those as leaks.
 *
 * Appendix R (layout routing / multimodal rebuild) is not decided here.
 */

import { stripFontSubsetPrefix } from "./pdf-mirror.js";

export const GLYPH_MAP_VERSION = "m1-1";

/** Format characters that are not ink on the page (rubric v3-R2). */
export const INVISIBLE_RE = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * PLOS-style rule glyphs and dotted box rules. The whole item, or a
 * whitespace-delimited run. A sentence that merely contains digits stays.
 */
const DECORATIVE_RUN_RE = /(?:^|\s)a1{4,}(?=\s|$)/gi;
const DOT_RULE_RE = /^(?:[.\u00B7\u2022\u2027\u2219\u25E6\u25AA\u00B0]){8,}$/;
const ONES_RULE_RE = /^1{8,}$/;

/** Radical bar extracted as p + fi/fl/ff ligatures or combining overlines. */
const RADICAL_RE = /p(?:\uFB00|\uFB01|\uFB02|\uFB03|\u0305|\u203E)+/gu;

/**
 * Adobe Symbol decoded as WinAnsi. Correct ToUnicode already emits the
 * symbol, so these Latin-1 characters only appear on the broken path.
 * ¼ in Symbol is an ellipsis, not an equals sign.
 */
const SYMBOL_WINANSI = {
  "\u00A1": "\u03A5",
  "\u00A2": "\u2032",
  "\u00A3": "\u2264",
  "\u00A5": "\u221E",
  "\u00B4": "\u00D7",
  "\u00B5": "\u221D",
  "\u00B6": "\u2202",
  "\u00B8": "\u00F7",
  "\u00B9": "\u2260",
  "\u00BA": "\u2261",
  "\u00BB": "\u2248",
  "\u00BC": "\u2026",
  "\u00BD": "|",
  "\u00BE": "\u2014",
  "\u00BF": "\u21B5",
  "\u00C4": "\u2297",
  "\u00C5": "\u2295",
  "\u00C6": "\u2205",
  "\u00C7": "\u2229",
  "\u00C8": "\u222A",
  "\u00C9": "\u2283",
  "\u00CA": "\u2287",
  "\u00CB": "\u2284",
  "\u00CC": "\u2282",
  "\u00CD": "\u2286",
  "\u00CE": "\u2208",
  "\u00CF": "\u2209",
  "\u00D0": "\u2220",
  "\u00D1": "\u2207",
  "\u00D5": "\u220F",
  "\u00D6": "\u221A",
  "\u00E5": "\u03A3",
  "\u00DE": "\u21D2",
  "\u00DF": "\u21D3",
  "\u00DB": "\u21D4",
  "\u00DC": "\u21D0",
  "\u00DD": "\u21D1",
  "~": "\u223C"
};

/**
 * fi/fl (and a few ff/ffi) ToUnicode holes that come out as a single space.
 * Longer keys first. All-caps tokens of 4 letters or fewer are left alone
 * so an acronym such as RST is not rewritten.
 */
const LIGATURE_HOLES = [
  ["speci cally", "specifically"],
  ["signi cantly", "significantly"],
  ["signi cance", "significance"],
  ["classi cation", "classification"],
  ["quanti cation", "quantification"],
  ["coef cients", "coefficients"],
  ["de nitions", "definitions"],
  ["identi fiers", "identifiers"],
  ["ef ciently", "efficiently"],
  ["in uenced", "influenced"],
  ["in uences", "influences"],
  ["re ection", "reflection"],
  ["re ected", "reflected"],
  ["di culty", "difficulty"],
  ["e ective", "effective"],
  ["signi cant", "significant"],
  ["speci ed", "specified"],
  ["identi ed", "identified"],
  ["identi es", "identifies"],
  ["con rmed", "confirmed"],
  ["coef cient", "coefficient"],
  ["ef ciency", "efficiency"],
  ["of cially", "officially"],
  ["su cient", "sufficient"],
  ["di cult", "difficult"],
  ["ef cient", "efficient"],
  ["in uence", "influence"],
  ["classi ed", "classified"],
  ["quanti ed", "quantified"],
  ["de nition", "definition"],
  ["identi er", "identifier"],
  ["scienti c", "scientific"],
  ["arti cial", "artificial"],
  ["pro les", "profiles"],
  ["bene ts", "benefits"],
  ["gures", "figures"],
  ["e ects", "effects"],
  ["con rms", "confirms"],
  ["de ned", "defined"],
  ["de nes", "defines"],
  ["re ects", "reflects"],
  ["speci c", "specific"],
  ["of cial", "official"],
  ["pro le", "profile"],
  ["bene t", "benefit"],
  ["con rm", "confirm"],
  ["de ne", "define"],
  ["re ect", "reflect"],
  ["e ect", "effect"],
  ["o set", "offset"],
  ["gure", "figure"],
  ["nal", "final"],
  ["rst", "first"]
];

const LIGATURE_RES = LIGATURE_HOLES.map(([broken, fixed]) => [
  new RegExp(`\\b${broken.replace(/ /g, "\\s")}\\b`, "gi"),
  fixed
]);

const OPERATOR_NEIGHBOR = /[=+\-*/^<>≤≥≠]/;
const PLUS_NEIGHBOR = /[0-9=+\-*/^_<>()[\]]/;
const LATIN_LETTER = /[A-Za-z\u00C0-\u024F]/;

export function isDecorativeText(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) return false;
  if (/^a1{4,}$/i.test(compact)) return true;
  if (ONES_RULE_RE.test(compact)) return true;
  if (DOT_RULE_RE.test(compact)) return true;
  return false;
}

export function isAdobeSymbolFont(name) {
  const font = stripFontSubsetPrefix(name);
  return /^(?:Symbol|SymbolMT|StandardSymL)$/i.test(font);
}

export function isPublisherMathFont(name) {
  const font = stripFontSubsetPrefix(name);
  if (!font || isAdobeSymbolFont(font)) return false;
  return /CMEX|CMSY|CMMI|MSAM|MSBM|MathematicalPi|Euclid|MTMI|MTSY|MTExtra/i.test(font);
}

export function isLargeOperatorFont(name) {
  const font = stripFontSubsetPrefix(name);
  return /CMEX|MSAM|MSBM/i.test(font);
}

function stripInvisible(text) {
  INVISIBLE_RE.lastIndex = 0;
  return String(text ?? "").replace(INVISIBLE_RE, "");
}

function stripDecorativeRuns(text) {
  const stripped = String(text || "").replace(DECORATIVE_RUN_RE, " ");
  const compact = stripped.replace(/\s+/g, "");
  if (!compact) return "";
  if (ONES_RULE_RE.test(compact) || DOT_RULE_RE.test(compact)) return "";
  return stripped;
}

function mapByTable(text, table) {
  let out = "";
  for (const ch of text) out += table[ch] || ch;
  return out;
}

function charAt(text, index) {
  if (index < 0 || index >= text.length) return "";
  return text[index];
}

function plusNeighbor(text, index) {
  const prev = charAt(text, index - 1);
  const next = charAt(text, index + 1);
  if (LATIN_LETTER.test(prev) || LATIN_LETTER.test(next)) return false;
  return PLUS_NEIGHBOR.test(prev) || PLUS_NEIGHBOR.test(next);
}

function operatorNeighbor(text, index) {
  const prev = charAt(text, index - 1);
  const next = charAt(text, index + 1);
  if (LATIN_LETTER.test(prev) || LATIN_LETTER.test(next)) return false;
  return OPERATOR_NEIGHBOR.test(prev) || OPERATOR_NEIGHBOR.test(next);
}

/** þ→+ beside digits or operators. ¼→= only beside an operator, never in "2¼". */
function replaceBrokenEqChars(text) {
  return text.replace(/[þÞ¼]/g, (ch, index) => {
    if (ch === "¼") return operatorNeighbor(text, index) ? "=" : ch;
    return plusNeighbor(text, index) ? "+" : ch;
  });
}

function applyFontMap(text, fontName) {
  const trimmed = text.trim();
  if (isLargeOperatorFont(fontName) && trimmed === "r") {
    return text.replace("r", "\u2211");
  }
  if (isAdobeSymbolFont(fontName)) {
    return mapByTable(text, SYMBOL_WINANSI).replace(/þ/g, "+");
  }
  if (isPublisherMathFont(fontName)) {
    return text.replace(/þ/g, "+").replace(/Þ/g, "+").replace(/¼/g, "=");
  }
  return replaceBrokenEqChars(text);
}

function applyCase(sample, fixed) {
  const letters = sample.replace(/[^A-Za-z]/g, "");
  if (letters && letters.length <= 4 && letters === letters.toUpperCase()) return sample;
  if (letters && letters === letters.toUpperCase()) return fixed.toUpperCase();
  if (/[A-Z]/.test(sample[0] || "")) return fixed[0].toUpperCase() + fixed.slice(1);
  return fixed;
}

export function repairLigatureHoles(text) {
  let out = String(text || "");
  for (const [re, fixed] of LIGATURE_RES) {
    out = out.replace(re, (match) => applyCase(match, fixed));
  }
  return out;
}

export function remainingLigatureHoles(text) {
  const found = [];
  const value = String(text || "");
  for (const [broken] of LIGATURE_HOLES) {
    const re = new RegExp(`\\b${broken.replace(/ /g, "\\s")}\\b`, "gi");
    for (const match of value.matchAll(re)) {
      const letters = match[0].replace(/[^A-Za-z]/g, "");
      if (letters && letters.length <= 4 && letters === letters.toUpperCase()) continue;
      found.push(match[0]);
    }
  }
  return found;
}

function repairRadical(text) {
  RADICAL_RE.lastIndex = 0;
  return String(text || "").replace(RADICAL_RE, "\u221A");
}

export function sanitizePdfTextItem(str, fontName = "") {
  const invisible = stripInvisible(str);
  const plain = stripDecorativeRuns(invisible);
  if (!plain) return "";
  const mapped = applyFontMap(plain, fontName);
  const radical = repairRadical(mapped);
  if (isPublisherMathFont(fontName) || isAdobeSymbolFont(fontName) || isLargeOperatorFont(fontName)) {
    return radical;
  }
  return repairLigatureHoles(radical);
}

/** Joined block text. No font, so single-letter operator maps stay off. */
export function sanitizeBlockText(str) {
  const invisible = stripInvisible(str);
  const plain = stripDecorativeRuns(invisible);
  if (!plain.trim()) return "";
  return repairLigatureHoles(repairRadical(replaceBrokenEqChars(plain)));
}
