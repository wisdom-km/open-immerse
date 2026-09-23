/** oi.pdf.structure.v1 — one title-page structure pack. Invalid packs are discarded. */

export const PDF_STRUCTURE_ID = "oi.pdf.structure.v1";
export const PDF_STRUCTURE_VERSION = 1;
export const STRUCTURE_INPUT_LIMIT = 12000;

const LIMIT = {
  title: 500,
  name: 300,
  affiliation: 300,
  email: 300,
  heading: 500,
  body: 20000,
  authors: 64,
  rest: 200,
  restText: 20000
};

const REST_ROLES = new Set(["heading", "paragraph", "caption", "other"]);

export const PDF_STRUCTURE_SYSTEM = [
  "Extract the title block of one academic paper page.",
  "Return one JSON object only, schema oi.pdf.structure.v1.",
  "Required keys: version (number 1), title (string), authors (array), abstract ({heading, body}).",
  "Each author is {name, affiliation, email}. Use affiliation, never aff.",
  "Optional keys: page (number), rest (array of {role, text}).",
  "role is heading, paragraph, caption, or other.",
  "Copy the page text. Do not translate. Do not emit HTML, Markdown, or code fences."
].join(" ");

const MARKUP_RE = /<\s*\/?\s*[a-z!][^>]*>|javascript\s*:|on[a-z]+\s*=/i;

function hasMarkup(value) {
  return MARKUP_RE.test(String(value || ""));
}

function fail(reason) {
  return { ok: false, reason };
}

function requiredString(value, max) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > max || hasMarkup(text)) return null;
  return text;
}

function optionalString(value, max) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > max || hasMarkup(text)) return null;
  return text;
}

export function pageTextForStructure(blocks, limit = STRUCTURE_INPUT_LIMIT) {
  const text = (Array.isArray(blocks) ? blocks : [])
    .map((block) => String(block?.text || block?.sourceText || "").trim())
    .filter(Boolean)
    .join("\n");
  const cap = Math.max(0, Number(limit) || 0);
  return text.length > cap ? text.slice(0, cap) : text;
}

/** Title page is usually page 1, or the page that contains an Abstract heading. */
export function isTitlePageCandidate(page, text) {
  const body = String(text || "");
  if (/\babstract\b/i.test(body) || /(^|\n)\s*摘要\s*(\n|$)/.test(body)) return true;
  return Number(page) === 1 && body.trim().length >= 80;
}

export function structureUserPrompt(pageText, page) {
  const body = String(pageText || "").slice(0, STRUCTURE_INPUT_LIMIT);
  return `page: ${Number(page) || 1}\n\n${body}`;
}

export function stripStructureFence(raw) {
  let text = String(raw || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  return text;
}

export function parsePdfStructureJson(raw) {
  const text = stripStructureFence(raw);
  if (!text) return fail("json");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return fail("json");
    try {
      value = JSON.parse(text.slice(start, end + 1));
    } catch {
      return fail("json");
    }
  }
  return validatePdfStructure(value);
}

export function validatePdfStructure(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("pack");
  if (input.version !== PDF_STRUCTURE_VERSION) return fail("version");
  const title = requiredString(input.title, LIMIT.title);
  if (!title) return fail("title");
  if (!Array.isArray(input.authors) || input.authors.length > LIMIT.authors) return fail("authors");
  const authors = [];
  for (const entry of input.authors) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.name == null || String(entry.name).trim() === "") continue;
    const name = requiredString(entry.name, LIMIT.name);
    if (!name) return fail("author-name");
    const affiliationSource = entry.affiliation != null ? entry.affiliation : entry.aff;
    const affiliation = optionalString(affiliationSource, LIMIT.affiliation);
    if (affiliation == null) return fail("affiliation");
    const email = optionalString(entry.email, LIMIT.email);
    if (email == null) return fail("email");
    const author = { name };
    if (affiliation) author.affiliation = affiliation;
    if (email) author.email = email;
    authors.push(author);
  }
  const abstract = input.abstract;
  if (!abstract || typeof abstract !== "object" || Array.isArray(abstract)) return fail("abstract");
  const heading = requiredString(abstract.heading, LIMIT.heading);
  if (!heading) return fail("abstract-heading");
  if (typeof abstract.body !== "string") return fail("abstract-body");
  const body = abstract.body.replace(/\s+/g, " ").trim();
  if (body.length > LIMIT.body || hasMarkup(body)) return fail("abstract-body");
  const structure = {
    version: PDF_STRUCTURE_VERSION,
    title,
    authors,
    abstract: { heading, body }
  };
  if (Number.isInteger(input.page) && input.page > 0) structure.page = input.page;
  if (input.rest == null) return { ok: true, structure };
  if (!Array.isArray(input.rest)) return { ok: true, structure };
  const rest = [];
  for (const entry of input.rest) {
    if (rest.length >= LIMIT.rest) break;
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.text !== "string") continue;
    const text = entry.text.replace(/\s+/g, " ").trim();
    if (!text || text.length > LIMIT.restText || hasMarkup(text)) continue;
    const role = REST_ROLES.has(entry.role) ? entry.role : "other";
    rest.push({ role, text });
  }
  if (rest.length) structure.rest = rest;
  return { ok: true, structure };
}

function slot(path, text) {
  const value = String(text || "").trim();
  if (!value) return null;
  return { path, text: value };
}

/** Translatable strings in refill order. Email stays on the source pack. */
export function structureTranslateSlots(structure) {
  if (!structure) return [];
  const slots = [];
  const push = (path, text) => {
    const item = slot(path, text);
    if (item) slots.push(item);
  };
  push(["title"], structure.title);
  (structure.authors || []).forEach((author, index) => {
    push(["authors", index, "name"], author?.name);
    push(["authors", index, "affiliation"], author?.affiliation);
  });
  push(["abstract", "heading"], structure.abstract?.heading);
  push(["abstract", "body"], structure.abstract?.body);
  (structure.rest || []).forEach((entry, index) => {
    push(["rest", index, "text"], entry?.text);
  });
  return slots;
}

function cloneStructure(structure) {
  return {
    version: PDF_STRUCTURE_VERSION,
    ...(Number.isInteger(structure.page) ? { page: structure.page } : {}),
    title: structure.title,
    authors: (structure.authors || []).map((author) => ({ ...author })),
    abstract: { ...structure.abstract },
    ...(structure.rest ? { rest: structure.rest.map((entry) => ({ ...entry })) } : {})
  };
}

function writeSlot(structure, path, value) {
  const text = String(value || "").trim();
  if (!text) return;
  if (path[0] === "title") structure.title = text;
  else if (path[0] === "authors") {
    const author = structure.authors[path[1]];
    if (!author || path[2] === "email") return;
    if (path[2] === "name" || path[2] === "affiliation") author[path[2]] = text;
  } else if (path[0] === "abstract" && structure.abstract &&
      (path[1] === "heading" || path[1] === "body")) {
    structure.abstract[path[1]] = text;
  } else if (path[0] === "rest") {
    const entry = structure.rest?.[path[1]];
    if (entry && path[2] === "text") entry.text = text;
  }
}

export function valueAtStructurePath(structure, path) {
  if (!structure || !path?.length) return "";
  if (path[0] === "title") return structure.title || "";
  if (path[0] === "authors") return structure.authors?.[path[1]]?.[path[2]] || "";
  if (path[0] === "abstract") return structure.abstract?.[path[1]] || "";
  if (path[0] === "rest") return structure.rest?.[path[1]]?.[path[2]] || "";
  return "";
}

/** Refill string fields. Shape, roles, and emails stay put. */
export function applyStructureTranslations(structure, slots, translations) {
  const next = cloneStructure(structure);
  (slots || []).forEach((item, index) => {
    writeSlot(next, item.path, translations?.[index]);
  });
  return next;
}

export function structureTranslationRows(source, translated) {
  return structureTranslateSlots(source).map((item) => ({
    id: `oi-structure:${item.path.join(".")}`,
    original: item.text,
    text: item.text,
    translation: String(valueAtStructurePath(translated, item.path) || ""),
    role: item.path[0] === "title" ? "title" : item.path[1] === "heading" || item.path[2] === "heading" ? "heading" : "paragraph"
  }));
}
