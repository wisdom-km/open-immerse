/**
 * Right-pane tier-0 formula DOM.
 * Rendering goes through lib/formula-katex.js. This module does not build an
 * HTML string, and it does not touch process / Buffer / require.
 */

import { canRenderLatex, renderLatexInto } from "./formula-katex.js";
import { placeholderCopy } from "./formula-settings.js";
import { PAIR_CLICK_SLOP } from "./pdf-pairing.js";
import { verifiedArxivFormula } from "./formula-arxiv-session.js";

export function katexClickKept(dx, dy) {
  const distance = Math.hypot(Number(dx) || 0, Number(dy) || 0);
  return distance <= PAIR_CLICK_SLOP;
}

/** Verified source latex, without display wrappers. */
export function copyLatexText(latex) {
  return String(latex ?? "");
}

export function plainWithInlineMath(root) {
  let out = "";
  const walk = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      out += node.textContent || "";
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    const cls = node.classList;
    if (cls?.contains?.("oi-pdf-inline-math") && cls.contains("is-katex") && node.dataset?.latex) {
      out += `$${node.dataset.latex}$`;
      return;
    }
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length; i += 1) walk(kids[i]);
  };
  walk(root);
  return out;
}

function docOf(parent) {
  return parent?.ownerDocument || globalThis.document;
}

function stampCommon(node, block, page, inline) {
  const shown = { ...block, page: page ?? block?.page };
  const copy = placeholderCopy(shown, { inline, kind: "formula" });
  const hasBbox = Array.isArray(block?.bbox) && block.bbox.length >= 4;
  node.dataset.oiTier = "arxiv";
  node.dataset.oiBbox = hasBbox ? "1" : "0";
  node.dataset.latex = String(block.latex || "");
  node.dataset.kind = "formula";
  if (block?.id) node.dataset.blockId = String(block.id);
  const known = Number(shown.page) >= 1;
  if (known) node.dataset.page = String(Math.floor(Number(shown.page)));
  node.setAttribute("aria-label", copy.aria);
  node.title = copy.aria;
  return copy;
}

function presentLatex(latex, display) {
  const raw = String(latex ?? "");
  if (!display || !raw.includes("&") || /\\begin\{align/.test(raw)) return raw;
  return `\\begin{aligned}${raw}\\end{aligned}`;
}

function nodeColor(node) {
  const view = node?.ownerDocument?.defaultView;
  let computed = "";
  try {
    computed = view?.getComputedStyle?.(node)?.color || "";
  } catch {
    computed = "";
  }
  return String(computed || node?.style?.color || "");
}

function isKatexErrorColor(color) {
  const raw = String(color || "").replace(/\s+/g, "").toLowerCase();
  return raw.includes("#e10091") || raw === "rgb(225,0,145)" || raw === "rgba(225,0,145,1)";
}

function hostPaintsError(host) {
  const stack = [host];
  while (stack.length) {
    const node = stack.pop();
    if (!node || (node.nodeType != null && node.nodeType !== 1)) continue;
    if (node.classList?.contains?.("katex-error")) return true;
    if (isKatexErrorColor(nodeColor(node))) return true;
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length; i += 1) stack.push(kids[i]);
  }
  return false;
}

function paintLatex(host, latex, display, katex) {
  const shown = presentLatex(latex, display);
  const check = canRenderLatex(shown, display, katex);
  if (!check.pass) {
    const error = new Error(check.error || "katex-error");
    error.code = "katex-error";
    throw error;
  }
  renderLatexInto(host, shown, display, katex);
  if (hostPaintsError(host)) {
    const error = new Error("katex-error");
    error.code = "katex-error";
    throw error;
  }
}

/** A failed inline source formula keeps a crop when one exists, otherwise a placeholder. */
export function failedInlineKind(formula) {
  if (formula?.formulaTier === "placeholder") return "placeholder";
  const url = String(formula?.imageUrl || "");
  if (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url)) return "crop";
  return "placeholder";
}

export function bindFormulaActivate(node, jump) {
  if (!node || typeof jump !== "function") return;
  let down = null;
  node.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    if (event.target?.closest?.(".oi-latex-copy")) return;
    down = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
  });
  node.addEventListener("click", (event) => {
    if (event.target?.closest?.(".oi-latex-copy")) return;
    event.preventDefault();
    event.stopPropagation();
    if (down) {
      const kept = katexClickKept((Number(event.clientX) || 0) - down.x, (Number(event.clientY) || 0) - down.y);
      down = null;
      if (!kept) return;
    }
    jump(node);
  });
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target?.closest?.(".oi-latex-copy")) return;
    event.preventDefault();
    event.stopPropagation();
    jump(node);
  });
}

function bindCopyKeys(node, latex, hooks) {
  node.addEventListener("keydown", (event) => {
    if (event.key !== "c" && event.key !== "C") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    hooks.onCopy?.(latex, node.querySelector?.(".oi-latex-copy") || null);
  });
  node.addEventListener("contextmenu", (event) => {
    if (event.target?.closest?.(".oi-latex-copy")) return;
    event.preventDefault();
    hooks.onMenu?.(latex, event, node);
  });
}

function copyButton(doc, latex, hooks) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "oi-latex-copy";
  button.textContent = "复制 LaTeX";
  button.tabIndex = -1;
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    hooks.onCopy?.(latex, button);
  });
  return button;
}

export function markFormulaOverflow(scroll) {
  if (!scroll) return false;
  // Inline subscript ink can be ~2px wider than the box. Treating that as
  // overflow turns on overflow-x and drops the baseline to the bottom edge.
  if (scroll.classList?.contains("oi-pdf-inline-math")) {
    scroll.classList.remove("is-overflowing");
    return false;
  }
  const over = scroll.scrollWidth > scroll.clientWidth + 1;
  scroll.classList.toggle("is-overflowing", over);
  return over;
}

export function mountArxivDisplay(parent, block, page, hooks = {}) {
  if (!verifiedArxivFormula(block) || !parent) return "skip";
  const doc = docOf(parent);
  if (!doc?.createElement) return "skip";
  const host = doc.createElement("span");
  host.className = "oi-katex";
  try {
    paintLatex(host, block.latex, true, hooks.katex);
  } catch {
    return "katex-error";
  }
  const row = doc.createElement("div");
  row.className = "oi-pdf-math-row is-katex is-enter";
  stampCommon(row, block, page, false);
  const reserve = doc.createElement("span");
  reserve.className = "oi-formula-reserve";
  reserve.dataset.oiReserve = "f8";
  reserve.setAttribute("aria-hidden", "true");
  const scroll = doc.createElement("div");
  scroll.className = "oi-pdf-math-scroll";
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "button");
  stampCommon(scroll, block, page, false);
  scroll.append(host);
  const num = doc.createElement("span");
  num.className = "oi-pdf-eq-num";
  num.textContent = String(block.eqLabel || "");
  row.append(reserve, scroll, num, copyButton(doc, block.latex, hooks));
  bindFormulaActivate(scroll, (node) => hooks.onJump?.(node));
  bindCopyKeys(scroll, block.latex, hooks);
  parent.append(row);
  const view = doc.defaultView;
  const mark = () => markFormulaOverflow(scroll);
  if (view?.requestAnimationFrame) view.requestAnimationFrame(mark);
  else mark();
  return "ok";
}

export function mountArxivInline(parent, block, page, hooks = {}) {
  if (!verifiedArxivFormula(block) || !parent) return "skip";
  const doc = docOf(parent);
  if (!doc?.createElement) return "skip";
  const host = doc.createElement("span");
  host.className = "oi-katex";
  try {
    paintLatex(host, block.latex, false, hooks.katex);
  } catch {
    return "katex-error";
  }
  parent.classList.add("oi-pdf-inline-math", "is-katex", "is-enter");
  parent.tabIndex = 0;
  parent.setAttribute("role", "button");
  stampCommon(parent, block, page, true);
  parent.append(host);
  bindFormulaActivate(parent, (node) => hooks.onJump?.(node));
  bindCopyKeys(parent, block.latex, hooks);
  const view = doc.defaultView;
  const mark = () => markFormulaOverflow(parent);
  if (view?.requestAnimationFrame) view.requestAnimationFrame(mark);
  else mark();
  return "ok";
}

export async function flashCopiedLatex(button, latex, writeText) {
  const text = copyLatexText(latex);
  let ok = false;
  try {
    ok = (await writeText?.(text)) !== false && typeof writeText === "function";
  } catch {
    ok = false;
  }
  if (!ok || !button) return ok;
  button.textContent = "已复制 LaTeX";
  button.classList.add("is-copied");
  const timer = button.ownerDocument?.defaultView?.setTimeout || setTimeout;
  timer(() => {
    if (!button.isConnected && button.ownerDocument == null) return;
    button.textContent = "复制 LaTeX";
    button.classList.remove("is-copied");
  }, 1200);
  return true;
}
