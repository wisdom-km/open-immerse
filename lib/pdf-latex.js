/** Recover copyable LaTeX from a PDF text-layer formula. No OCR, no invented TeX. */

const SUPER = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁺": "+",
  "⁻": "-",
  "ⁿ": "n",
  "ᵀ": "T",
  "ⁱ": "i"
};

const SUB = {
  "₀": "0",
  "₁": "1",
  "₂": "2",
  "₃": "3",
  "₄": "4",
  "₅": "5",
  "₆": "6",
  "₇": "7",
  "₈": "8",
  "₉": "9",
  "₊": "+",
  "₋": "-",
  "ₖ": "k",
  "ₙ": "n",
  "ᵢ": "i",
  "ⱼ": "j"
};

const SYMBOLS = [
  ["≤", "\\leq"],
  ["≥", "\\geq"],
  ["≠", "\\neq"],
  ["±", "\\pm"],
  ["×", "\\times"],
  ["÷", "\\div"],
  ["·", "\\cdot"],
  ["⋅", "\\cdot"],
  ["∈", "\\in"],
  ["∑", "\\sum"],
  ["∫", "\\int"],
  ["√", "\\sqrt"],
  ["∞", "\\infty"],
  ["→", "\\to"],
  ["←", "\\leftarrow"],
  ["↔", "\\leftrightarrow"],
  ["⇒", "\\Rightarrow"],
  ["∂", "\\partial"],
  ["∇", "\\nabla"],
  ["⊕", "\\oplus"],
  ["⊗", "\\otimes"],
  ["≈", "\\approx"],
  ["≡", "\\equiv"],
  ["∝", "\\propto"],
  ["ℓ", "\\ell"],
  ["α", "\\alpha"],
  ["β", "\\beta"],
  ["γ", "\\gamma"],
  ["δ", "\\delta"],
  ["ε", "\\varepsilon"],
  ["θ", "\\theta"],
  ["λ", "\\lambda"],
  ["μ", "\\mu"],
  ["π", "\\pi"],
  ["σ", "\\sigma"],
  ["φ", "\\phi"],
  ["ω", "\\omega"],
  ["Δ", "\\Delta"],
  ["Σ", "\\Sigma"],
  ["Φ", "\\Phi"],
  ["Ω", "\\Omega"]
];

export function unwrapLatex(text) {
  let s = String(text || "").trim();
  if (!s) return "";
  if (s.startsWith("$$") && s.endsWith("$$") && s.length >= 4) {
    return s.slice(2, -2).trim();
  }
  if (s.startsWith("$") && s.endsWith("$") && s.length >= 2 && !s.startsWith("$$")) {
    return s.slice(1, -1).trim();
  }
  return s;
}

export function wrapLatexMarkdown(latex, display = false) {
  const src = unwrapLatex(latex);
  if (!src) return "";
  return display ? `$$${src}$$` : `$${src}$`;
}

export function unicodeMathify(text) {
  return String(text || "")
    .replace(/\^2\b/g, "²")
    .replace(/\^3\b/g, "³")
    .replace(/\^T\b/g, "ᵀ")
    .trim();
}

/** A: $latex$ / $$latex$$. Else Unicode. Else [公式]. */
export function formulaExportMarkdown({ latex = "", display = false, sourceText = "" } = {}) {
  const src = unwrapLatex(latex);
  if (src) return wrapLatexMarkdown(src, display);
  const uni = unicodeMathify(sourceText);
  if (uni) return uni;
  return "[公式]";
}

export function formulaDisplayMode(box = {}, pageWidth = 0) {
  const text = String(box.text || box.sourceText || box.latex || "");
  const w = Number(box.rect?.width) || 0;
  const left = Number(box.rect?.left) || 0;
  const pw = Number(pageWidth || box.pageWidth);
  if (!Number.isFinite(pw) || pw <= 1) return /=/.test(text) && text.length > 28;
  if (w > pw * 0.45) return true;
  if (/=/.test(text) && w > pw * 0.22) return true;
  if (left > pw * 0.2 && left + w < pw * 0.8 && w > pw * 0.18) return true;
  return false;
}

/** Mechanical recover only. No \\frac / \\operatorname / \\mathrm invention. */
export function recoverFormulaLatex(text) {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 240 || looksLikeGarbageMath(raw)) return "";
  let s = unwrapLatex(raw);
  if (/\\[a-zA-Z]+/.test(s)) return s.replace(/\s+/g, " ").trim();
  s = foldUnicodeScripts(s);
  s = s.replace(/\^\{([^}]+)\}/g, "^{$1}");
  s = s.replace(/\^([A-Za-z0-9])/g, "^{$1}");
  s = s.replace(/_\{([^}]+)\}/g, "_{$1}");
  s = s.replace(/_([A-Za-z0-9])/g, "_{$1}");
  for (const [ch, tex] of SYMBOLS) s = s.split(ch).join(`${tex} `);
  return s.replace(/\s+/g, " ").trim();
}

function foldUnicodeScripts(text) {
  let s = String(text || "");
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿᵀⁱ]+/g, (run) => {
    const body = [...run].map((ch) => SUPER[ch] || ch).join("");
    return `^{${body}}`;
  });
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉₊₋ₖₙᵢⱼ]+/g, (run) => {
    const body = [...run].map((ch) => SUB[ch] || ch).join("");
    return `_{${body}}`;
  });
  return s;
}

function looksLikeGarbageMath(text) {
  const raw = String(text || "");
  const printable = (raw.match(/[\x20-\x7E\u00A0-\u03FF\u2070-\u209F\u2200-\u22FF]/g) || []).length;
  return printable / Math.max(raw.length, 1) < 0.5;
}
