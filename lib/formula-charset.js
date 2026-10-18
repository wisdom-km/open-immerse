/**
 * REQUIREMENTS §2.6 second-layer character set.
 * Comparison is exact after NFKC and the variant classes in that section.
 * Commands outside the table fail the check and are counted.
 */

const GREEK = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ϵ",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  iota: "ι",
  kappa: "κ",
  theta: "θ",
  vartheta: "ϑ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "ϕ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω"
};

const SYMBOLS = {
  partial: "∂",
  nabla: "∇",
  infty: "∞",
  sum: "∑",
  prod: "∏",
  int: "∫",
  sqrt: "√",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  times: "×",
  cdot: "·",
  pm: "±",
  top: "⊤",
  approx: "≈",
  sim: "∼",
  equiv: "≡",
  propto: "∝",
  circ: "∘",
  ast: "∗",
  otimes: "⊗",
  rightarrow: "→",
  to: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  mapsto: "↦",
  in: "∈",
  subset: "⊂",
  forall: "∀",
  exists: "∃",
  cup: "∪",
  cap: "∩",
  langle: "⟨",
  rangle: "⟩",
  prime: "′",
  cdots: "⋯",
  ldots: "…",
  dots: "…",
  ell: "ℓ",
  mid: "|",
  vert: "|",
  lvert: "|",
  rvert: "|",
  Vert: "‖",
  lVert: "‖",
  rVert: "‖",
  prec: "≺",
  succ: "≻",
  preceq: "≼",
  succeq: "≽"
};

const LETTER_OPS = new Set(["log", "exp", "max", "min", "arg"]);

const FONT = new Set([
  "mathrm", "mathbf", "mathit", "mathcal", "mathbb", "mathfrak",
  "boldsymbol", "operatorname", "text", "mbox", "textrm", "textbf", "textit"
]);

const ACCENT = new Set(["hat", "bar", "tilde", "vec", "overline", "widehat", "widetilde"]);

const LAYOUT = new Set([
  "left", "right", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr",
  "Biggl", "Biggr", "big", "Big", "bigg", "Bigg",
  "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle",
  "limits", "nolimits", "nonumber", "notag", "label", "tag", "qquad", "quad",
  "hspace", "vspace", "kern", "hskip", "vskip", "begin", "end",
  "!", ",", ";", ":", " ", "/", "allowbreak", "nobreak"
]);

const VARIANTS = [
  ["-", "−", "–"],
  ["·", "⋅", "∙"],
  ["‖", "∥"],
  ["ϵ", "ε"],
  ["ϕ", "φ"],
  ["ϑ", "θ"],
  ["'", "′", "’", "ʼ"],
  ["*", "∗"]
];

const CANON = new Map();
for (const group of VARIANTS) {
  for (const ch of group) CANON.set(ch, group[0]);
}

const HOMOGLYPH = {
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M",
  Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X", ο: "o"
};

function canonChar(ch) {
  const nfkc = String(ch).normalize("NFKC");
  const out = [];
  for (const part of nfkc) {
    const homo = HOMOGLYPH[part] || part;
    out.push(CANON.get(homo) || homo);
  }
  return out;
}

function addChar(set, ch) {
  if (!ch || /\s/.test(ch)) return;
  for (const part of canonChar(ch)) {
    if (!part || /\s/.test(part)) continue;
    set.add(part);
  }
}

function addText(set, text) {
  for (const ch of String(text || "")) addChar(set, ch);
}

function readCs(src, i) {
  if (src[i] !== "\\") return null;
  const next = src[i + 1];
  if (!next) return null;
  if (/[a-zA-Z]/.test(next)) {
    let j = i + 2;
    while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
    return { name: src.slice(i + 1, j), end: j };
  }
  return { name: next, end: i + 2 };
}

function skipSpace(src, i) {
  let j = i;
  while (j < src.length && /\s/.test(src[j])) j++;
  return j;
}

function readGroup(src, i) {
  const start = skipSpace(src, i);
  if (src[start] !== "{") return null;
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src[j] === "\\") {
      j += 1;
      continue;
    }
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return { inner: src.slice(start + 1, j), end: j + 1 };
    }
  }
  return { inner: src.slice(start + 1), end: src.length };
}

function readOptional(src, i) {
  const start = skipSpace(src, i);
  if (src[start] !== "[") return null;
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src[j] === "\\") {
      j += 1;
      continue;
    }
    if (src[j] === "[") depth += 1;
    else if (src[j] === "]") {
      depth -= 1;
      if (depth === 0) return { inner: src.slice(start + 1, j), end: j + 1 };
    }
  }
  return null;
}

function parseInto(src, set, unknown) {
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch) || ch === "{" || ch === "}" || ch === "^" || ch === "_" || ch === "&" || ch === "~") {
      i += 1;
      continue;
    }
    if (ch === "'") {
      addChar(set, "′");
      i += 1;
      continue;
    }
    if (ch !== "\\") {
      addChar(set, ch);
      i += 1;
      continue;
    }
    if (src.startsWith("\\\\", i)) {
      i += 2;
      continue;
    }
    const cs = readCs(src, i);
    if (!cs) {
      i += 1;
      continue;
    }
    i = cs.end;
    const name = cs.name;
    if (name === "frac" || name === "binom" || name === "tfrac" || name === "dfrac") {
      const a = readGroup(src, i);
      if (a) {
        parseInto(a.inner, set, unknown);
        i = a.end;
      }
      const b = readGroup(src, i);
      if (b) {
        parseInto(b.inner, set, unknown);
        i = b.end;
      }
      continue;
    }
    if (name === "sqrt") {
      addChar(set, "√");
      const opt = readOptional(src, i);
      if (opt) {
        parseInto(opt.inner, set, unknown);
        i = opt.end;
      }
      const body = readGroup(src, i);
      if (body) {
        parseInto(body.inner, set, unknown);
        i = body.end;
      }
      continue;
    }
    if (FONT.has(name) || ACCENT.has(name)) {
      const body = readGroup(src, i);
      if (body) {
        parseInto(body.inner, set, unknown);
        i = body.end;
      }
      continue;
    }
    if (name === "label" || name === "tag" || name === "hspace" || name === "vspace") {
      const opt = readOptional(src, i);
      if (opt) i = opt.end;
      const body = readGroup(src, i);
      if (body) i = body.end;
      continue;
    }
    if (name === "begin" || name === "end") {
      const body = readGroup(src, i);
      if (body) i = body.end;
      continue;
    }
    if (name === "_" || name === "^" || name === "{" || name === "}" || name === "~") continue;
    if (LAYOUT.has(name)) continue;
    if (GREEK[name]) {
      addChar(set, GREEK[name]);
      continue;
    }
    if (SYMBOLS[name]) {
      addChar(set, SYMBOLS[name]);
      continue;
    }
    if (name === "|") {
      addChar(set, "‖");
      continue;
    }
    if (name === "{" || name === "}") {
      addChar(set, name);
      continue;
    }
    if (LETTER_OPS.has(name)) {
      addText(set, name);
      continue;
    }
    unknown.push(`\\${name}`);
    const opt = readOptional(src, i);
    if (opt) i = opt.end;
    const body = readGroup(src, i);
    if (body) i = body.end;
  }
}

export function latexToCharset(latex) {
  const chars = new Set();
  const unknownCommands = [];
  parseInto(String(latex || ""), chars, unknownCommands);
  return { chars, unknownCommands };
}

export function pdfTextCharset(text) {
  const chars = new Set();
  addText(chars, text);
  return { chars, unknownCommands: [] };
}

function asResult(value) {
  if (value && value.chars instanceof Set) return value;
  if (value instanceof Set) return { chars: value, unknownCommands: [] };
  return pdfTextCharset(value);
}

export function charsetEqual(a, b) {
  const left = asResult(a);
  const right = asResult(b);
  if (left.unknownCommands?.length || right.unknownCommands?.length) return false;
  if (left.chars.size !== right.chars.size) return false;
  for (const ch of left.chars) {
    if (!right.chars.has(ch)) return false;
  }
  return true;
}

export function charsetJaccard(a, b) {
  const left = asResult(a);
  const right = asResult(b);
  if (left.unknownCommands?.length || right.unknownCommands?.length) return 0;
  // An empty side is not a match. Both empty used to return 1, so "\quad"
  // verified against a formula block that had lost its text.
  if (left.chars.size === 0 || right.chars.size === 0) return 0;
  let inter = 0;
  for (const ch of left.chars) if (right.chars.has(ch)) inter += 1;
  const union = left.chars.size + right.chars.size - inter;
  if (!union) return 0;
  return inter / union;
}

export const CHARSET_COMMANDS = Object.freeze({
  ...Object.fromEntries(Object.entries(GREEK).map(([name, ch]) => [name, ch])),
  ...SYMBOLS
});
