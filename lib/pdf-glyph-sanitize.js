/**
 * Text-layer glyph cleanup for journal PDFs (M1).
 * Map version: m1-2.
 *
 * Runs before line grouping. Invisible characters and a small set of
 * well-known ToUnicode misses are rewritten. Equals signs are never
 * rewritten (a run of "=" is not a slash). Superscripts and line-end
 * hyphens are left alone; the rubric does not count those as leaks.
 *
 * Appendix R (layout routing / multimodal rebuild) is not decided here.
 */

import { stripFontSubsetPrefix } from "./pdf-mirror.js";

export const GLYPH_MAP_VERSION = "m1-2";

/**
 * One unrecoverable glyph run. A later multimodal pass can replace this
 * span; the letters are not guessed. Contiguous private-use or replacement
 * characters collapse to a single mark.
 */
export const GLYPH_GAP_MARK = "\u27E8\u22EF\u27E9";

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
 * Symbol font stored as U+F000 plus the Symbol byte (Word / JAMA ToUnicode).
 * Byte values follow the Adobe Symbol encoding. Dingbat fonts do not use this.
 */
const SYMBOL_FROM_BYTE = {
  0x22: "\u2200",
  0x24: "\u2203",
  0x27: "\u220B",
  0x2A: "\u2217",
  0x2D: "\u2212",
  0x40: "\u2245",
  0x41: "\u0391",
  0x42: "\u0392",
  0x43: "\u03A7",
  0x44: "\u0394",
  0x45: "\u0395",
  0x46: "\u03A6",
  0x47: "\u0393",
  0x48: "\u0397",
  0x49: "\u0399",
  0x4A: "\u03D1",
  0x4B: "\u039A",
  0x4C: "\u039B",
  0x4D: "\u039C",
  0x4E: "\u039D",
  0x4F: "\u039F",
  0x50: "\u03A0",
  0x51: "\u0398",
  0x52: "\u03A1",
  0x53: "\u03A3",
  0x54: "\u03A4",
  0x55: "\u03A5",
  0x56: "\u03C2",
  0x57: "\u03A9",
  0x58: "\u039E",
  0x59: "\u03A8",
  0x5A: "\u0396",
  0x5C: "\u2234",
  0x5E: "\u22A5",
  0x60: "\u00AF",
  0x61: "\u03B1",
  0x62: "\u03B2",
  0x63: "\u03C7",
  0x64: "\u03B4",
  0x65: "\u03B5",
  0x66: "\u03C6",
  0x67: "\u03B3",
  0x68: "\u03B7",
  0x69: "\u03B9",
  0x6A: "\u03D5",
  0x6B: "\u03BA",
  0x6C: "\u03BB",
  0x6D: "\u03BC",
  0x6E: "\u03BD",
  0x6F: "\u03BF",
  0x70: "\u03C0",
  0x71: "\u03B8",
  0x72: "\u03C1",
  0x73: "\u03C3",
  0x74: "\u03C4",
  0x75: "\u03C5",
  0x76: "\u03D6",
  0x77: "\u03C9",
  0x78: "\u03BE",
  0x79: "\u03C8",
  0x7A: "\u03B6",
  0x7E: "\u223C",
  0xA1: "\u03D2",
  0xA2: "\u2032",
  0xA3: "\u2264",
  0xA4: "\u2044",
  0xA5: "\u221E",
  0xA6: "\u0192",
  0xB0: "\u00B0",
  0xB1: "\u00B1",
  0xB2: "\u2033",
  0xB3: "\u2265",
  0xB4: "\u00D7",
  0xB5: "\u221D",
  0xB6: "\u2202",
  0xB7: "\u2022",
  0xB8: "\u00F7",
  0xB9: "\u2260",
  0xBA: "\u2261",
  0xBB: "\u2248",
  0xBC: "\u2026",
  0xC0: "\u2135",
  0xC4: "\u2297",
  0xC5: "\u2295",
  0xC6: "\u2205",
  0xC7: "\u2229",
  0xC8: "\u222A",
  0xC9: "\u2283",
  0xCA: "\u2287",
  0xCB: "\u2284",
  0xCC: "\u2282",
  0xCD: "\u2286",
  0xCE: "\u2208",
  0xCF: "\u2209",
  0xD0: "\u2220",
  0xD1: "\u2207",
  0xD5: "\u220F",
  0xD6: "\u221A",
  0xD7: "\u22C5",
  0xD9: "\u2227",
  0xDA: "\u2228",
  0xDB: "\u21D4",
  0xDC: "\u21D0",
  0xDD: "\u21D1",
  0xDE: "\u21D2",
  0xDF: "\u21D3",
  0xE1: "\u27E8",
  0xE5: "\u2211",
  0xF2: "\u222B"
};

/** Large delimiters CMEX / MathTime store in the Apple Symbol private-use block. */
const APPLE_SYMBOL_DELIM = {
  "\uF8EB": "\u239B",
  "\uF8EC": "\u239C",
  "\uF8ED": "\u239D",
  "\uF8EE": "\u23A1",
  "\uF8EF": "\u23A2",
  "\uF8F0": "\u23A3",
  "\uF8F1": "\u23A7",
  "\uF8F2": "\u23A8",
  "\uF8F3": "\u23A9",
  "\uF8F4": "\u23AA",
  "\uF8F6": "\u239E",
  "\uF8F7": "\u239F",
  "\uF8F8": "\u23A0",
  "\uF8F9": "\u23A4",
  "\uF8FA": "\u23A5",
  "\uF8FB": "\u23A6",
  "\uF8FC": "\u23AB",
  "\uF8FD": "\u23AC",
  "\uF8FE": "\u23AD"
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

/** APS / AIP pi font. Glyph names say thorn and onequarter; the ink is parentheses and equals. */
export function isApsPiFont(name) {
  const font = stripFontSubsetPrefix(name);
  return /AdvP\d|MathematicalPi/i.test(font);
}

function isDingbatFont(name) {
  const font = stripFontSubsetPrefix(name);
  return /wingding|webding|dingbat|zapfding/i.test(font);
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

function operatorNeighbor(text, index) {
  const prev = charAt(text, index - 1);
  const next = charAt(text, index + 1);
  if (LATIN_LETTER.test(prev) || LATIN_LETTER.test(next)) return false;
  return OPERATOR_NEIGHBOR.test(prev) || OPERATOR_NEIGHBOR.test(next);
}

function gluedLetter(text, index) {
  return LATIN_LETTER.test(charAt(text, index - 1)) || LATIN_LETTER.test(charAt(text, index + 1));
}

function skipNeighbor(text, index, dir) {
  let cursor = index + dir;
  while (cursor >= 0 && cursor < text.length && /\s/.test(text[cursor])) cursor += dir;
  return charAt(text, cursor);
}

/**
 * þ→+ when a digit or operator is the neighbor, skipping spaces.
 * A letter glued on either side stays (þetta). ¼→= in the operator slot:
 * "z ¼ 0.09" and "¼=", never "2¼" or "¼ of".
 */
function replaceBrokenEqChars(text) {
  const plus = text.replace(/þ/g, (ch, index) => {
    if (gluedLetter(text, index)) return ch;
    const prev = charAt(text, index - 1);
    const next = charAt(text, index + 1);
    if (PLUS_NEIGHBOR.test(prev) || PLUS_NEIGHBOR.test(next)) return "+";
    const prevFar = skipNeighbor(text, index, -1);
    const nextFar = skipNeighbor(text, index, 1);
    if (PLUS_NEIGHBOR.test(prevFar) || PLUS_NEIGHBOR.test(nextFar)) return "+";
    return ch;
  });
  return plus.replace(/¼/g, (ch, index, whole) => quarterIsEquals(whole, index) ? "=" : ch);
}

function quarterIsEquals(text, index) {
  const prev = charAt(text, index - 1);
  const next = charAt(text, index + 1);
  if (/\d/.test(prev) || /\d/.test(next)) return false;
  if (/^\s+[A-Za-z]{2,}/.test(text.slice(index + 1))) return false;
  if (operatorNeighbor(text, index)) return true;
  const prevFar = skipNeighbor(text, index, -1);
  const nextFar = skipNeighbor(text, index, 1);
  if (!prevFar && !nextFar) return false;
  if (/\d/.test(nextFar) || OPERATOR_NEIGHBOR.test(prevFar) || OPERATOR_NEIGHBOR.test(nextFar)) return true;
  return LATIN_LETTER.test(prevFar) && (/\d/.test(nextFar) || LATIN_LETTER.test(nextFar));
}

/** APS pi: þ is plus, ð…Þ is a parenthesis pair, ¼ is equals. */
function mapApsPi(text) {
  return text.replace(/þ/g, "+").replace(/Þ/g, ")").replace(/ð/g, "(").replace(/¼/g, "=");
}

function mapSymbolPrivateUse(text, fontName, keepDelimiters = false) {
  if (isDingbatFont(fontName)) return text;
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0xF020 && code <= 0xF0FF && SYMBOL_FROM_BYTE[code - 0xF000]) {
      out += SYMBOL_FROM_BYTE[code - 0xF000];
      continue;
    }
    if (!keepDelimiters && APPLE_SYMBOL_DELIM[ch]) {
      out += APPLE_SYMBOL_DELIM[ch];
      continue;
    }
    out += ch;
  }
  return out;
}

function markPrivateUse(text, keepDelimiters = false) {
  return String(text || "").replace(/[\uFFFD\uE000-\uF8FF]+/g, (run) => {
    if (!keepDelimiters) return GLYPH_GAP_MARK;
    let out = "";
    let pending = "";
    const flush = () => {
      if (!pending) return;
      out += GLYPH_GAP_MARK;
      pending = "";
    };
    for (const ch of run) {
      if (APPLE_SYMBOL_DELIM[ch]) {
        flush();
        out += ch;
      } else pending += ch;
    }
    flush();
    return out;
  });
}

/** Reading-surface form of a stored CMEX delimiter. Block text keeps the private-use code. */
export function mapAppleDelimiters(text) {
  let out = "";
  for (const ch of String(text || "")) out += APPLE_SYMBOL_DELIM[ch] || ch;
  return out;
}

/** Thorn still left after the font maps. Letter-glued words stay; the rest is a gap. */
function markLooseThorn(text) {
  return String(text || "").replace(/[þÞ]/g, (ch, index, whole) => (
    gluedLetter(whole, index) ? ch : GLYPH_GAP_MARK
  ));
}

function closePiParens(text) {
  return String(text || "").replace(/ð([A-Za-z0-9]{1,16})Þ/g, "($1)");
}

function applyFontMap(text, fontName, keepDelimiters = false) {
  const trimmed = text.trim();
  const symbols = mapSymbolPrivateUse(text, fontName, keepDelimiters);
  if (isLargeOperatorFont(fontName) && trimmed === "r") {
    return symbols.replace("r", "\u2211");
  }
  if (isApsPiFont(fontName)) return mapApsPi(symbols);
  if (isAdobeSymbolFont(fontName)) {
    return mapByTable(symbols, SYMBOL_WINANSI).replace(/þ/g, "+");
  }
  if (isPublisherMathFont(fontName)) {
    return symbols.replace(/þ/g, "+").replace(/Þ/g, "+").replace(/¼/g, "=");
  }
  return replaceBrokenEqChars(symbols);
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

export function sanitizePdfTextItem(str, fontName = "", keepDelimiters = false) {
  const invisible = stripInvisible(str);
  const plain = stripDecorativeRuns(invisible);
  if (!plain) return "";
  const mapped = applyFontMap(plain, fontName, keepDelimiters);
  const radical = repairRadical(mapped);
  const letters = isPublisherMathFont(fontName) || isAdobeSymbolFont(fontName) ||
    isLargeOperatorFont(fontName) || isApsPiFont(fontName)
    ? radical
    : repairLigatureHoles(radical);
  return markPrivateUse(letters, keepDelimiters);
}

/**
 * Joined block text. Font-specific maps already ran per item.
 * What remains is neighbor context, a ð…Þ pair, and unrecoverable runs.
 */
export function sanitizeBlockText(str, keepDelimiters = false) {
  const invisible = stripInvisible(str);
  const plain = stripDecorativeRuns(invisible);
  if (!plain.trim()) return "";
  const symbols = mapSymbolPrivateUse(plain, "", keepDelimiters);
  const eqs = closePiParens(replaceBrokenEqChars(symbols));
  return markLooseThorn(markPrivateUse(repairLigatureHoles(repairRadical(eqs)), keepDelimiters));
}
