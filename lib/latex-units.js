/** LaTeX unit splitter for arXiv e-print sources. Pure: KaTeX is injected. */

import { KATEX_RENDER_OPTIONS } from "./formula-katex.js";
import { PERMISSION_RE } from "./pdf-readout.js";

const SECTION_LEVEL = {
  section: 0,
  subsection: 1,
  subsubsection: 2,
  paragraph: 3
};

const MATH_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*",
  "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "flalign", "flalign*"
]);

export function findMainTex(files) {
  const mains = (files || []).filter((file) => hasMainMarkers(file?.text));
  if (mains.length !== 1) return null;
  return mains[0].path;
}

function hasMainMarkers(text) {
  const src = String(text || "");
  return /\\documentclass\b/.test(src) && /\\begin\{document\}/.test(src);
}

function emptyResult(reason) {
  return {
    main: null,
    macros: [],
    units: [],
    unsupported: [{ scope: "document", reason }],
    supported: false,
    stats: { display: 0, inline: 0, inlineBody: 0, inlineFloat: 0, headings: 0, macros: 0 }
  };
}

export function parseLatexSource(files, options = {}) {
  const list = files || [];
  const mains = list.filter((file) => hasMainMarkers(file?.text));
  if (!mains.length) {
    const plain = list.length > 0 && list.every((file) => !/\\documentclass\b/.test(String(file?.text || "")));
    return emptyResult(plain ? "plain-tex" : "no-main");
  }
  if (mains.length > 1) return emptyResult("multiple-main");
  const main = mains[0];
  const assembled = assemble(main, list);
  const extracted = extractMacros(assembled);
  const expanded = expandMacros(extracted.text, extracted.macros);
  const parsed = scanDocument(expanded, extracted.macros, options.katex);
  return {
    main: main.path,
    macros: extracted.macros,
    units: parsed.units,
    unsupported: parsed.unsupported,
    supported: true,
    stats: {
      display: parsed.display,
      inline: parsed.inline,
      inlineBody: parsed.inlineBody,
      inlineFloat: parsed.inlineFloat,
      headings: parsed.headings,
      macros: extracted.macros.length
    }
  };
}

export function prepareFormulaLatex(latex, display = false) {
  let src = String(latex || "")
    .replace(/\\label\{[^}]*\}/g, "")
    .replace(/\\nonumber/g, "")
    .replace(/\\tag\*?\{[^}]*\}/g, "")
    .trim();
  if (!display) return src;
  src = src
    .replace(/\\begin\{align\*?\}/g, "\\begin{aligned}")
    .replace(/\\end\{align\*?\}/g, "\\end{aligned}")
    .replace(/\\begin\{flalign\*?\}/g, "\\begin{aligned}")
    .replace(/\\end\{flalign\*?\}/g, "\\end{aligned}");
  if (!/\\begin\{/.test(src) && /\\\\|&/.test(src)) {
    src = `\\begin{aligned}${src}\\end{aligned}`;
  }
  return src;
}

export function plainLatexText(src) {
  let text = String(src || "");
  text = text.replace(/\\(?:cite|citep|citet|citealp|citeauthor|citeyear)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, " ");
  text = text.replace(/\\[`'^"~=.]\{?\\?([A-Za-z])\}?/g, "$1");
  text = text.replace(/\\c\{([A-Za-z])\}/g, "$1");
  text = text.replace(/\\L\b/g, "L").replace(/\\l\b/g, "l");
  text = text.replace(/\\oe\b/g, "oe").replace(/\\ae\b/g, "ae").replace(/\\aa\b/g, "a").replace(/\\o\b/g, "o");
  text = text.replace(/\\(?:emph|textbf|textit|texttt|textrm|textsc|text)\{([^{}]*)\}/g, "$1");
  text = text.replace(/\\(?:label|ref|eqref|pageref|url|href|includegraphics)\*?(?:\[[^\]]*\])?\{[^}]*\}/g, " ");
  text = text.replace(/\\([&%_#$])/g, "$1");
  text = text.replace(/~/g, " ");
  text = text.replace(/\\\\/g, " ");
  text = text.replace(/\\[a-zA-Z@]+\*?/g, " ");
  text = text.replace(/[{}]/g, " ");
  return text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

function stripComments(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      out += ch;
      if (i + 1 < src.length) out += src[++i];
      continue;
    }
    if (ch === "%") {
      while (i + 1 < src.length && src[i + 1] !== "\n") i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function fileByName(files, name) {
  const wanted = String(name || "").trim().replace(/^\.\//, "");
  const names = wanted.endsWith(".tex") ? [wanted] : [wanted, `${wanted}.tex`];
  return files.find((file) => {
    const base = String(file.path || "").replace(/^.*\//, "");
    return names.includes(file.path) || names.includes(base);
  });
}

function assemble(main, files) {
  const seen = new Set();
  const expand = (text) => stripComments(text).replace(/\\(?:input|include|subfile)\{([^}]+)\}/g, (_full, name) => {
    const file = fileByName(files, name);
    if (!file || seen.has(file.path)) return "";
    seen.add(file.path);
    return `\n${expand(file.text)}\n`;
  });
  seen.add(main.path);
  return expand(main.text);
}

function readCs(src, i) {
  if (src[i] !== "\\") return null;
  const next = src[i + 1];
  if (!next) return null;
  if (/[a-zA-Z@]/.test(next)) {
    let j = i + 2;
    while (j < src.length && /[a-zA-Z@]/.test(src[j])) j += 1;
    return { name: src.slice(i + 1, j), end: j };
  }
  return { name: next, end: i + 2 };
}

function skipSpace(src, i) {
  let j = i;
  while (j < src.length && /[ \t\r\n]/.test(src[j])) j += 1;
  return j;
}

function readDelimited(src, i, open, close) {
  const start = skipSpace(src, i);
  if (src[start] !== open) return null;
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src[j] === "\\") {
      j += 1;
      continue;
    }
    if (src[j] === open) depth += 1;
    else if (src[j] === close) {
      depth -= 1;
      if (depth === 0) return { inner: src.slice(start + 1, j), end: j + 1 };
    }
  }
  return { inner: src.slice(start + 1), end: src.length };
}

function readBrace(src, i) {
  return readDelimited(src, i, "{", "}");
}

function readBracket(src, i) {
  return readDelimited(src, i, "[", "]");
}

function extractMacros(text) {
  const macros = [];
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\\") {
      out += text[i];
      continue;
    }
    const cs = readCs(text, i);
    if (!cs || !["newcommand", "renewcommand", "def", "DeclareMathOperator"].includes(cs.name)) {
      out += text[i];
      continue;
    }
    const parsed = parseDef(text, i, cs);
    if (!parsed) {
      out += text[i];
      continue;
    }
    if (!parsed.macro.name.includes("@")) macros.push(parsed.macro);
    i = parsed.end - 1;
  }
  return { text: out, macros };
}

function parseDef(text, i, cs) {
  let j = cs.end;
  if (text[j] === "*") j += 1;
  j = skipSpace(text, j);
  let name = "";
  if (text[j] === "{") {
    const group = readBrace(text, j);
    if (!group) return null;
    name = group.inner.trim().replace(/^\\/, "");
    j = group.end;
  } else {
    const token = readCs(text, j);
    if (!token) return null;
    name = token.name;
    j = token.end;
  }
  let argc = 0;
  let optional = null;
  if (cs.name === "def") {
    while (text[j] === "#") {
      argc += 1;
      j += 2;
    }
  } else if (cs.name !== "DeclareMathOperator") {
    j = skipSpace(text, j);
    if (text[j] === "[") {
      const count = readBracket(text, j);
      if (!count) return null;
      argc = Number(count.inner.trim()) || 0;
      j = skipSpace(text, count.end);
      if (text[j] === "[") {
        const fallback = readBracket(text, j);
        if (!fallback) return null;
        optional = fallback.inner;
        j = fallback.end;
      }
    }
  }
  j = skipSpace(text, j);
  const body = readBrace(text, j);
  if (!body) return null;
  const macroBody = cs.name === "DeclareMathOperator" ? `\\operatorname{${body.inner}}` : body.inner;
  return { end: body.end, macro: { name, argc, optional, body: macroBody } };
}

function expandMacros(text, macros) {
  const byName = new Map(macros.map((macro) => [macro.name, macro]));
  const rec = (src, depth) => {
    if (depth > 12 || !src) return src || "";
    let out = "";
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== "\\") {
        out += src[i];
        continue;
      }
      const cs = readCs(src, i);
      const macro = cs && byName.get(cs.name);
      if (!macro) {
        if (!cs) {
          out += src[i];
          continue;
        }
        out += src.slice(i, cs.end);
        i = cs.end - 1;
        continue;
      }
      let j = cs.end;
      const args = [];
      let left = macro.argc || 0;
      if (macro.optional != null) {
        j = skipSpace(src, j);
        if (src[j] === "[") {
          const opt = readBracket(src, j);
          args.push(opt ? opt.inner : "");
          j = opt ? opt.end : j + 1;
        } else args.push(macro.optional);
        left -= 1;
      }
      while (left > 0) {
        j = skipSpace(src, j);
        if (src[j] === "{") {
          const group = readBrace(src, j);
          args.push(group ? group.inner : "");
          j = group ? group.end : j + 1;
        } else if (src[j] === "\\") {
          const token = readCs(src, j);
          args.push(token ? src.slice(j, token.end) : src[j]);
          j = token ? token.end : j + 1;
        } else {
          args.push(src[j] || "");
          j += 1;
        }
        left -= 1;
      }
      const replaced = macro.body.replace(/#(\d)/g, (_m, n) => args[Number(n) - 1] ?? "");
      out += rec(replaced, depth + 1);
      i = j - 1;
    }
    return out;
  };
  return rec(text, 0);
}

function scanDocument(text, macros, katex) {
  const begin = text.search(/\\begin\{document\}/);
  const preamble = begin >= 0 ? text.slice(0, begin) : "";
  const body = begin >= 0 ? text.slice(begin) : text;
  const state = createState(katex);
  takePreamble(preamble, state);
  scan(body, state);
  state.flush();
  return state.summary();
}

function createState(katex) {
  const units = [];
  const unsupported = [];
  let parts = [];
  let envs = [];
  let inItem = false;
  let bib = false;
  let figureNo = 0;
  let tableNo = 0;
  let eqNo = 0;
  const sec = [0, 0, 0];
  let serial = 0;
  const nextId = (prefix) => {
    serial += 1;
    return `${prefix}${serial}`;
  };
  const zone = () => {
    if (envs.includes("tabular") || envs.includes("verbatim") || envs.includes("lstlisting")) return "skip";
    if (bib || envs.includes("thebibliography")) return "bib";
    return "body";
  };
  const appendText = (chunk) => {
    if (!chunk || zone() === "skip") return;
    const pieces = String(chunk).split(/\n[ \t]*\n/);
    pieces.forEach((piece, index) => {
      if (index > 0) flush();
      if (!piece) return;
      const last = parts[parts.length - 1];
      if (last?.type === "text") last.text += piece;
      else parts.push({ type: "text", text: piece });
    });
  };
  const addInline = (latex, where) => {
    if (zone() === "skip" || zone() === "bib") return;
    const cleaned = String(latex || "").trim();
    if (!cleaned) return;
    const id = nextId("i");
    const render = renderMath(cleaned, false, katex);
    const part = { type: "inline", id, latex: cleaned, zone: where, katexOk: render.ok };
    parts.push(part);
    if (render.ok === false) unsupported.push({ scope: "formula", id, reason: "katex" });
  };
  const addDisplay = (latex, starred) => {
    if (zone() === "skip") return;
    flush();
    const cleaned = String(latex || "").trim();
    if (!cleaned) return;
    const number = displayNumber(cleaned, starred);
    const id = nextId("d");
    const render = renderMath(cleaned, true, katex);
    units.push({
      id,
      kind: "display",
      latex: cleaned,
      katexLatex: prepareFormulaLatex(cleaned, true),
      number,
      katexOk: render.ok
    });
    if (render.ok === false) unsupported.push({ scope: "formula", id, reason: "katex" });
  };
  const displayNumber = (latex, starred) => {
    const tag = latex.match(/\\tag\*?\{([^}]*)\}/);
    if (tag) return tag[1].replace(/[()]/g, "").trim();
    if (starred || /\\nonumber/.test(latex)) return null;
    const lines = latex.split(/\\\\/).filter((line) => line.trim());
    const numbered = (lines.length ? lines : [latex]).filter((line) => !/\\nonumber/.test(line));
    if (!numbered.length) return null;
    eqNo += 1;
    const first = String(eqNo);
    for (let extra = 1; extra < numbered.length; extra += 1) eqNo += 1;
    return first;
  };
  const flush = () => {
    if (zone() === "skip") {
      parts = [];
      return;
    }
    const meaningful = parts.some((part) => part.type === "inline" || plainLatexText(part.text || ""));
    if (!meaningful) {
      parts = [];
      return;
    }
    const text = parts.map((part) => (part.type === "text" ? part.text : " ")).join("");
    const plain = plainLatexText(text);
    if (PERMISSION_RE.test(plain)) {
      parts = [];
      return;
    }
    let kind = "paragraph";
    if (zone() === "bib") kind = "bibliography";
    else if (inItem) kind = "item";
    const kept = parts.map((part) => (part.type === "text" ? { type: "text", text: part.text } : { ...part }));
    units.push({ id: nextId(kind[0]), kind, zone: zone(), parts: kept, text: plain });
    parts = [];
  };
  const takeFragment = (src, where) => {
    const saved = parts;
    const savedItem = inItem;
    parts = [];
    inItem = false;
    scan(src, api, where);
    const fragment = parts.slice();
    parts = saved;
    inItem = savedItem;
    return fragment;
  };
  const api = {
    appendText,
    addInline,
    addDisplay,
    flush,
    takeFragment,
    envs: () => envs,
    pushEnv(name) { envs.push(name); },
    popEnv() { return envs.pop(); },
    zone,
    setItem(value) { inItem = value; },
    item() { return inItem; },
    setBib(value) { bib = value; },
    nextFigure() { figureNo += 1; return figureNo; },
    nextTable() { tableNo += 1; return tableNo; },
    figureNo: () => figureNo,
    tableNo: () => tableNo,
    bump(level) {
      if (level === 0) {
        sec[0] += 1;
        sec[1] = 0;
        sec[2] = 0;
        return String(sec[0]);
      }
      if (level === 1) {
        sec[1] += 1;
        sec[2] = 0;
        return `${sec[0]}.${sec[1]}`;
      }
      if (level === 2) {
        sec[2] += 1;
        return `${sec[0]}.${sec[1]}.${sec[2]}`;
      }
      return "";
    },
    addUnit(unit) { units.push({ id: nextId(unit.kind[0] || "u"), ...unit }); },
    unsupported,
    katex
  };
  return {
    flush,
    summary() {
      const inlines = [];
      for (const unit of units) {
        for (const part of unit.parts || []) {
          if (part.type === "inline") inlines.push(part);
        }
      }
      const headings = units.filter((unit) => unit.kind === "heading" && unit.section);
      return {
        units,
        unsupported,
        display: units.filter((unit) => unit.kind === "display").length,
        inline: inlines.length,
        inlineBody: inlines.filter((part) => part.zone === "body").length,
        inlineFloat: inlines.filter((part) => part.zone === "caption" || part.zone === "footnote").length,
        headings: headings.length
      };
    },
    addUnit: api.addUnit,
    api
  };
}

function renderMath(latex, display, katex) {
  if (!katex?.renderToString) return { ok: null };
  try {
    katex.renderToString(prepareFormulaLatex(latex, display), {
      ...KATEX_RENDER_OPTIONS,
      displayMode: display
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function takePreamble(preamble, state) {
  const title = readCommandBrace(preamble, "title");
  if (title) state.addUnit({ kind: "title", text: plainLatexText(title), section: false });
  const author = readCommandBrace(preamble, "author");
  if (!author) return;
  const thanks = [];
  const stripped = author.replace(/\\(?:thanks|footnote)\{/g, (match, offset) => {
    const group = readBrace(author, offset + match.length - 1);
    if (group) thanks.push(group.inner);
    return match;
  });
  // The replace above does not remove thanks bodies. Do it with a scanner.
  const cleaned = dropCommand(author, ["thanks", "footnote"]);
  for (const note of thanks) {
    const parts = scanFragment(note, state.api, "footnote");
    const text = plainLatexText(note);
    if (text) state.addUnit({ kind: "footnote", zone: "footnote", text, parts });
  }
  const people = cleaned.split(/\\(?:AND|And|and)\b/);
  for (const person of people) {
    const name = plainLatexText(person.split(/\\\\/)[0] || "");
    if (name) state.addUnit({ kind: "author", text: name, zone: "author" });
  }
}

function readCommandBrace(src, name) {
  const re = new RegExp(`\\\\${name}\\s*\\{`);
  const match = re.exec(src);
  if (!match) return "";
  const group = readBrace(src, match.index + match[0].length - 1);
  return group ? group.inner : "";
}

function dropCommand(src, names) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "\\") {
      out += src[i];
      continue;
    }
    const cs = readCs(src, i);
    if (!cs || !names.includes(cs.name)) {
      out += src[i];
      continue;
    }
    let j = skipSpace(src, cs.end);
    const group = readBrace(src, j);
    i = (group ? group.end : cs.end) - 1;
  }
  return out;
}

function scanFragment(src, api, where) {
  const saved = [];
  const local = {
    ...api,
    appendText(chunk) {
      if (!chunk) return;
      const last = saved[saved.length - 1];
      if (last?.type === "text") last.text += chunk;
      else saved.push({ type: "text", text: chunk });
    },
    addInline(latex) {
      const cleaned = String(latex || "").trim();
      if (!cleaned) return;
      const id = `f${saved.length + 1}`;
      saved.push({ type: "inline", id, latex: cleaned, zone: where, katexOk: renderMath(cleaned, false, null).ok });
    }
  };
  // Re-scan with the real api's inline recorder by a dedicated walker.
  walkFragment(src, (kind, value) => {
    if (kind === "text") local.appendText(value);
    if (kind === "inline") {
      const cleaned = String(value || "").trim();
      if (!cleaned) return;
      const render = renderMath(cleaned, false, api.katex);
      const id = `fn${saved.length + 1}`;
      saved.push({ type: "inline", id, latex: cleaned, zone: where, katexOk: render.ok });
      if (render.ok === false) api.unsupported.push({ scope: "formula", id, reason: "katex" });
    }
  });
  return saved.filter((part) => part.type === "inline" || plainLatexText(part.text || ""));
}

function walkFragment(src, emit) {
  let i = 0;
  while (i < src.length) {
    if (src[i] === "$") {
      if (src[i + 1] === "$") {
        const end = src.indexOf("$$", i + 2);
        const inner = src.slice(i + 2, end < 0 ? src.length : end);
        emit("inline", inner);
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      const end = findDollar(src, i + 1);
      emit("inline", src.slice(i + 1, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src.startsWith("\\(", i)) {
      const end = src.indexOf("\\)", i + 2);
      emit("inline", src.slice(i + 2, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src[i] === "\\") {
      const cs = readCs(src, i);
      if (!cs) {
        emit("text", src[i]);
        i += 1;
        continue;
      }
      if (cs.name === "begin") {
        const group = readBrace(src, cs.end);
        const env = group?.inner || "";
        if (MATH_ENVS.has(env)) {
          const close = src.indexOf(`\\end{${env}}`, group.end);
          emit("inline", src.slice(group.end, close < 0 ? src.length : close));
          i = close < 0 ? src.length : close + `\\end{${env}}`.length;
          continue;
        }
      }
      emit("text", src.slice(i, cs.end));
      i = cs.end;
      continue;
    }
    let j = i;
    while (j < src.length && src[j] !== "$" && src[j] !== "\\") j += 1;
    emit("text", src.slice(i, j));
    i = j;
  }
}

function findDollar(src, i) {
  for (let j = i; j < src.length; j++) {
    if (src[j] === "\\") {
      j += 1;
      continue;
    }
    if (src[j] === "$") return j;
  }
  return -1;
}

function scan(text, state) {
  const api = state.api || state;
  let i = 0;
  const src = text;
  while (i < src.length) {
    if (src[i] === "$") {
      if (src[i + 1] === "$") {
        const end = src.indexOf("$$", i + 2);
        const inner = src.slice(i + 2, end < 0 ? src.length : end);
        if (api.zone() !== "skip") api.addDisplay(inner, true);
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      const end = findDollar(src, i + 1);
      const inner = src.slice(i + 1, end < 0 ? src.length : end);
      api.addInline(inner, "body");
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src.startsWith("\\(", i)) {
      const end = src.indexOf("\\)", i + 2);
      api.addInline(src.slice(i + 2, end < 0 ? src.length : end), "body");
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith("\\[", i)) {
      const end = src.indexOf("\\]", i + 2);
      if (api.zone() !== "skip") api.addDisplay(src.slice(i + 2, end < 0 ? src.length : end), true);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src[i] === "\\") {
      const cs = readCs(src, i);
      if (!cs) {
        i += 1;
        continue;
      }
      i = handleCommand(src, cs, api);
      continue;
    }
    let j = i;
    while (j < src.length && src[j] !== "\\" && src[j] !== "$") j += 1;
    api.appendText(src.slice(i, j));
    i = j;
  }
}

function handleCommand(src, cs, api) {
  let j = cs.end;
  const name = cs.name;
  if (name === "begin") {
    const group = readBrace(src, j);
    const env = group?.inner?.trim() || "";
    j = group ? group.end : j;
    if (MATH_ENVS.has(env)) {
      const closer = `\\end{${env}}`;
      const end = src.indexOf(closer, j);
      const inner = src.slice(j, end < 0 ? src.length : end);
      if (api.zone() !== "skip") api.addDisplay(inner, env.endsWith("*"));
      return end < 0 ? src.length : end + closer.length;
    }
    if (env === "figure" || env === "figure*") api.nextFigure();
    if (env === "table" || env === "table*") api.nextTable();
    if (env === "thebibliography") {
      api.flush();
      api.setBib(true);
    }
    if (env === "abstract") {
      api.flush();
      api.addUnit({ kind: "heading", text: "Abstract", title: "Abstract", number: "", section: false });
    }
    if (env === "itemize" || env === "enumerate") api.flush();
    api.pushEnv(env);
    return j;
  }
  if (name === "end") {
    const group = readBrace(src, j);
    const env = group?.inner?.trim() || "";
    j = group ? group.end : j;
    if (env === "itemize" || env === "enumerate" || env === "abstract" || env === "thebibliography") api.flush();
    if (env === "thebibliography") api.setBib(false);
    if ((env === "itemize" || env === "enumerate") && api.item()) api.setItem(false);
    api.popEnv();
    return j;
  }
  if (SECTION_LEVEL[name] != null) {
    if (src[j] === "*") j += 1;
    const group = readBrace(src, j);
    const title = plainLatexText(group?.inner || "");
    j = group ? group.end : j;
    api.flush();
    const level = SECTION_LEVEL[name];
    const starred = src[cs.end] === "*";
    const countable = name !== "paragraph" || (!/:\s*$/.test(title) && !/^acknowledg/i.test(title));
    const number = !starred && level < 3 && countable ? api.bump(level) : "";
    if (countable && title) {
      api.addUnit({
        kind: "heading",
        text: number ? `${number} ${title}` : title,
        title,
        number,
        level: name,
        section: true
      });
    } else if (title && name === "paragraph") {
      api.appendText(`${title} `);
    }
    return j;
  }
  if (name === "caption") {
    const group = readBrace(src, j);
    j = group ? group.end : j;
    api.flush();
    const float = floatContext(api);
    const parts = scanFragment(group?.inner || "", api, "caption");
    const body = plainLatexText(group?.inner || "");
    const prefix = float ? `${float.label} ${float.number}: ` : "";
    api.addUnit({
      kind: "caption",
      text: `${prefix}${body}`.trim(),
      parts,
      zone: "caption",
      floatKind: float?.kind || "",
      floatNumber: float?.number || 0
    });
    return j;
  }
  if (name === "footnote" || name === "thanks" || name === "blfootnote") {
    const group = readBrace(src, j);
    j = group ? group.end : j;
    const parts = scanFragment(group?.inner || "", api, "footnote");
    const text = plainLatexText(group?.inner || "");
    if (text || parts.some((part) => part.type === "inline")) {
      api.addUnit({ kind: "footnote", text, parts, zone: "footnote" });
    }
    return j;
  }
  if (name === "item") {
    api.flush();
    api.setItem(true);
    if (src[j] === "[") {
      const opt = readBracket(src, j);
      if (opt) j = opt.end;
    }
    return j;
  }
  if (name === "bibitem") {
    api.flush();
    api.setBib(true);
    if (src[j] === "[") {
      const opt = readBracket(src, j);
      if (opt) j = opt.end;
    }
    const group = readBrace(src, j);
    if (group) j = group.end;
    return j;
  }
  if (name === "cite" || name === "citep" || name === "citet" || name === "citealp" || name === "citeauthor") {
    if (src[j] === "[") {
      const opt = readBracket(src, j);
      if (opt) j = opt.end;
      if (src[skipSpace(src, j)] === "[") {
        const opt2 = readBracket(src, skipSpace(src, j));
        if (opt2) j = opt2.end;
      }
    }
    const group = readBrace(src, j);
    return group ? group.end : j;
  }
  if (name === "includegraphics" || name === "bibliography" || name === "bibliographystyle") {
    if (src[skipSpace(src, j)] === "[") {
      const opt = readBracket(src, j);
      if (opt) j = opt.end;
    }
    const group = readBrace(src, j);
    return group ? group.end : j;
  }
  if (name === "label" || name === "ref" || name === "eqref" || name === "url" || name === "href") {
    const group = readBrace(src, j);
    return group ? group.end : j;
  }
  if (name === "\\" || name === "newline") {
    api.appendText(" ");
    return j;
  }
  if ("&%_#$".includes(name) || name === "{" || name === "}") {
    api.appendText(name === "&" ? "&" : name);
    return j;
  }
  if (["vspace", "hspace", "setlength", "addtolength", "setcounter", "addtocounter", "hypersetup"].includes(name)) {
    if (src[skipSpace(src, j)] === "[") {
      const opt = readBracket(src, j);
      if (opt) j = opt.end;
    }
    const group = readBrace(src, j);
    return group ? group.end : j;
  }
  return j;
}

function floatContext(api) {
  const envs = api.envs();
  for (let index = envs.length - 1; index >= 0; index -= 1) {
    const env = envs[index];
    if (env === "figure" || env === "figure*") return { kind: "figure", label: "Figure", number: api.figureNo() };
    if (env === "table" || env === "table*") return { kind: "table", label: "Table", number: api.tableNo() };
  }
  return null;
}

function createScanEntry(text, api) {
  scan(text, api);
}
