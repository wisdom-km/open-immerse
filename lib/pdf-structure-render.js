/** Safe paper-shell for oi.pdf.structure.v1. Text only; no model HTML. */

import { authorNameHasLetter, structureTranslateSlots } from "./pdf-structure-schema.js";

const ABSTRACT_HEADING_RE = /^(abstract|摘要)$/i;
const EMAIL_RE = /^[^\s"'<>]+@[^\s"'<>]+\.[^\s"'<>]+$/;

function docOf(parent) {
  return parent?.ownerDocument || globalThis.document;
}

function element(doc, tag, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textElement(doc, tag, className, text, role) {
  const node = element(doc, tag, className);
  node.textContent = text == null ? "" : String(text);
  if (role) node.setAttribute("data-role", role);
  return node;
}

export function isSafeMailto(email) {
  return EMAIL_RE.test(String(email || ""));
}

function markerSuffix(name, markers) {
  const marks = String(markers || "").replace(/\s+/g, "");
  if (!marks) return "";
  const base = String(name || "");
  if (base.endsWith(marks)) return "";
  for (let size = marks.length - 1; size > 0; size -= 1) {
    if (base.endsWith(marks.slice(0, size))) return marks.slice(size);
  }
  return marks;
}

function authorNameText(author) {
  const name = String(author?.name || "").trim();
  return `${name}${markerSuffix(name, author?.markers)}`;
}

export function renderAuthorGrid(parent, authors) {
  const doc = docOf(parent);
  const wrap = element(doc, "div", "oi-pdf-authors");
  wrap.setAttribute("data-role", "authors");
  for (const author of authors || []) {
    const rawName = String(author?.name || "").trim();
    if (!authorNameHasLetter(rawName)) continue;
    const name = authorNameText(author);
    if (!name) continue;
    const cell = element(doc, "div", "oi-pdf-author-cell");
    cell.append(textElement(doc, "div", "oi-pdf-author-name", name));
    const affiliation = String(author?.affiliation || "").trim();
    if (affiliation) cell.append(textElement(doc, "div", "oi-pdf-author-aff", affiliation));
    const email = String(author?.email || "").trim();
    if (email) {
      const node = textElement(doc, isSafeMailto(email) ? "a" : "div", "oi-pdf-author-email", email);
      if (node.tagName === "A" || node.tag === "a") node.setAttribute("href", `mailto:${email}`);
      cell.append(node);
    }
    wrap.append(cell);
  }
  parent.append(wrap);
  return wrap;
}

function renderFootnotes(parent, rest) {
  const notes = (rest || []).filter((entry) => entry?.role === "other" && String(entry.text || "").trim());
  if (!notes.length) return null;
  const doc = docOf(parent);
  const wrap = element(doc, "div", "oi-pdf-footnotes");
  for (const entry of notes) wrap.append(textElement(doc, "p", "oi-pdf-footnote", entry.text));
  parent.append(wrap);
  return wrap;
}

function restNode(doc, entry) {
  if (entry?.role === "heading") return textElement(doc, "h2", "oi-pdf-h2", entry.text);
  if (entry?.role === "caption") return textElement(doc, "p", "oi-pdf-p", entry.text, "caption");
  return textElement(doc, "p", "oi-pdf-p", entry?.text || "");
}

/** Whitelist DOM for a validated pack. Caller must not pass an invalid pack. */
export function renderPdfStructure(structure, parent) {
  const doc = docOf(parent);
  parent.append(textElement(doc, "h1", "oi-pdf-h1", structure?.title || ""));
  renderAuthorGrid(parent, structure?.authors || []);
  renderFootnotes(parent, structure?.rest || []);
  parent.append(textElement(
    doc,
    "h2",
    "oi-pdf-h2 oi-pdf-abstract-heading",
    structure?.abstract?.heading || "",
    "abstract_heading"
  ));
  parent.append(textElement(doc, "p", "oi-pdf-p", structure?.abstract?.body || "", "abstract_body"));
  for (const entry of structure?.rest || []) {
    if (entry?.role === "other") continue;
    parent.append(restNode(doc, entry));
  }
  return parent;
}

/** F1: center Abstract / 摘要 by the fallback string match. */
export function decorateAbstractHeading(node, text) {
  if (!node || !ABSTRACT_HEADING_RE.test(String(text || "").trim())) return false;
  node.classList?.add("oi-pdf-abstract-heading");
  node.setAttribute("data-role", "abstract_heading");
  return true;
}

function norm(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function blockCoveredByStructure(block, structure) {
  if (!structure || !block) return false;
  if (block.label === "formula" || block.label === "figure" || block.label === "table" || block.label === "caption") {
    return false;
  }
  if (block.inlineOf) return false;
  if (block.label === "title" || block.presentation === "byline") return true;
  const text = norm(block.text || block.sourceText || "");
  if (!text) return false;
  if (block.label === "heading" && ABSTRACT_HEADING_RE.test(text)) return true;
  const body = norm(structure.abstract?.body);
  if (body && (body.includes(text) || (body.length >= 24 && text.includes(body.slice(0, 60))))) return true;
  return (structure.rest || []).some((entry) => {
    const rest = norm(entry?.text);
    return rest && (rest.includes(text) || (rest.length >= 24 && text.includes(rest.slice(0, 40))));
  });
}

export function blocksOutsideStructure(blocks, structure) {
  if (!structure) return blocks || [];
  return (blocks || []).filter((block) => !blockCoveredByStructure(block, structure));
}

export function structureSlotCount(structure) {
  return structureTranslateSlots(structure).length;
}
