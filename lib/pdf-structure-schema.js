/** oi.pdf.structure.v1 — one title-page structure pack. Invalid packs are discarded. */

export const PDF_STRUCTURE_ID = "oi.pdf.structure.v1";
export const PDF_STRUCTURE_VERSION = 1;
export const STRUCTURE_INPUT_LIMIT = 12000;

const LIMIT = {
  title: 500,
  name: 300,
  affiliation: 300,
  email: 300,
  markers: 16,
  heading: 500,
  body: 20000,
  authors: 64,
  rest: 200,
  restText: 20000
};

const REST_ROLES = new Set(["heading", "paragraph", "caption", "other"]);
const MARKER_CHARS = /[*†‡⁎∗＊§¶‖※]/g;
const MARKER_ONLY = /^[*†‡⁎∗＊§¶‖※]+$/u;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** §11.2 author-fidelity hard lines, plus the row-completeness lines for Gate H. */
const AUTHOR_FIDELITY_RULES = [
  "authors[i] = 恰好一人；禁止把另一作者名写进 affiliation 或 name。",
  "* / † / ‡ 及脚注句 → rest[]（role: \"other\"），不得单独成 author。",
  "无人名字母或纯符号 name（如 *）不得成 author。",
  "串名 / 多邮箱脏格：丢弃该条；脏格 ≥2 → 整包 fallback。",
  "List every distinct person in the title-block author region. Do not stop after the first row or the first line.",
  "Multi-row and multi-column author blocks become one author object per person, in reading order.",
  "Never fold a later row's person into an earlier author's affiliation.",
  "Do not omit people because the first row already has three or four names.",
  "affiliation is the institution only. One email per person; never paste a column of addresses into the first author."
];

const AUTHOR_TRUNCATION_MIN = 2;
const ORG_WORD = /^(google|university|universität|universite|institute|institut|laboratory|laboratories|college|school|department|dept|faculty|hospital|academy|microsoft|openai|deepmind|facebook|stanford|berkeley|cambridge|oxford|corporation|company|inc|ltd|llc|gmbh|lab|labs|research|brain|science|sciences|engineering|technology|computer|national|center|centre|group|team)$/i;
const FUNCTION_WORD = /^(the|a|an|is|are|was|were|of|and|or|for|with|to|in|on|you|all|we|this|that|these|those|from|by|at|as|not|be|it|our|their|its|if|than|then)$/i;
const PARTICLE = /^(de|van|von|da|di|la|le|del|st|bin|al|der|den)$/i;

export const PDF_STRUCTURE_SYSTEM = [
  "Extract the title block of one academic paper page.",
  "Return one JSON object only, schema oi.pdf.structure.v1.",
  "Required keys: version (number 1), title (string), authors (array), abstract ({heading, body}).",
  "Each author is {name, affiliation, email, markers}. Use affiliation, never aff.",
  "markers is optional and only footnote symbols such as * † ‡, stuck to that one name.",
  "Optional keys: page (number), rest (array of {role, text}).",
  "role is heading, paragraph, caption, or other.",
  "每个作者一个对象；脚注符粘姓名；单位不含其他人名；孤立符号与脚注句进 rest role=other；禁止仅符号作者。",
  ...AUTHOR_FIDELITY_RULES,
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

function structureBlockLines(block) {
  const lines = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (!text || lines.includes(text)) return;
    lines.push(text);
  };
  push(block?.text || block?.sourceText);
  const cell = block?.authorCell;
  if (cell && typeof cell === "object") {
    push(cell.name);
    push(cell.affiliation);
    push(cell.email);
  }
  return lines;
}

export function pageTextForStructure(blocks, limit = STRUCTURE_INPUT_LIMIT) {
  const text = (Array.isArray(blocks) ? blocks : [])
    .flatMap((block) => structureBlockLines(block))
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
  return `page: ${Number(page) || 1}\n${AUTHOR_FIDELITY_RULES.join("\n")}\n\n${body}`;
}

export function structureCompletenessPrompt(pageText, page, missing) {
  const names = (missing || []).map((name) => String(name || "").trim()).filter(Boolean).slice(0, 24);
  return [
    structureUserPrompt(pageText, page),
    "",
    "The authors array is incomplete. It stopped early and left people out.",
    "Do not stop after the first row. Emit one author object per person, in reading order, including every later row.",
    "Do not put a later person's name into an earlier affiliation.",
    names.length ? `People still missing from authors[]: ${names.join("; ")}.` : ""
  ].filter(Boolean).join("\n");
}

export function authorNameHasLetter(value) {
  return /\p{L}/u.test(String(value || ""));
}

function coreName(value) {
  return String(value || "").replace(MARKER_CHARS, " ").replace(/\s+/g, " ").trim();
}

function letterCount(value) {
  return (String(value || "").match(/\p{L}/gu) || []).length;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Another author's name as a whole token, not a slice of a longer word. */
function containsOtherName(haystack, otherName) {
  const core = coreName(otherName);
  if (letterCount(core) < 2) return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(core)}(?![\\p{L}\\p{N}])`, "iu");
  return pattern.test(String(haystack || ""));
}

function uniqueEmails(value) {
  const found = String(value || "").match(new RegExp(EMAIL_RE.source, "g")) || [];
  return [...new Set(found.map((item) => item.toLowerCase()))];
}

function hasMultipleEmails(value) {
  if (uniqueEmails(value).length >= 2) return true;
  return (String(value || "").match(/@/g) || []).length >= 2;
}

function nameKey(value) {
  return coreName(value).toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

function cleanToken(token) {
  return String(token || "").replace(/^[*†‡⁎∗＊§¶‖※,;:]+|[*†‡⁎∗＊§¶‖※,;:]+$/gu, "");
}

function isInitial(token) {
  return /^\p{Lu}\.$/u.test(token);
}

function isSubstantial(token) {
  return /^\p{Lu}\p{L}/u.test(token);
}

function isNameToken(token) {
  return isSubstantial(token) || isInitial(token) || PARTICLE.test(token);
}

function peopleFromRun(tokens) {
  const people = [];
  let index = 0;
  while (index < tokens.length) {
    const a = tokens[index];
    const b = tokens[index + 1];
    const c = tokens[index + 2];
    if (isInitial(a) && b && isSubstantial(b)) {
      people.push(`${a} ${b}`);
      index += 2;
      continue;
    }
    if (b && isInitial(b) && c && isSubstantial(c) && isSubstantial(a)) {
      people.push(`${a} ${b} ${c}`);
      index += 3;
      continue;
    }
    if (b && PARTICLE.test(b) && c && isSubstantial(c) && isSubstantial(a)) {
      people.push(`${a} ${b} ${c}`);
      index += 3;
      continue;
    }
    if (b && isSubstantial(a) && isSubstantial(b)) {
      people.push(`${a} ${b}`);
      index += 2;
      continue;
    }
    index += 1;
  }
  return people;
}

function personNamesInLine(line) {
  const raw = String(line || "").replace(/\s+/g, " ").trim();
  if (!raw || /^[*†‡⁎∗＊§¶‖※]+\s*\p{Ll}/u.test(raw)) return [];
  const people = [];
  let run = [];
  let skipName = false;
  const flush = () => {
    if (run.length) people.push(...peopleFromRun(run));
    run = [];
  };
  for (const token of raw.split(/\s+/)) {
    if (token.includes("@")) {
      flush();
      skipName = false;
      continue;
    }
    const core = cleanToken(token);
    if (!core || ORG_WORD.test(core) || FUNCTION_WORD.test(core) || !isNameToken(core)) {
      flush();
      skipName = /^(of|for|at)$/i.test(core);
      continue;
    }
    if (skipName) {
      skipName = false;
      continue;
    }
    run.push(core);
  }
  flush();
  return people;
}

function authorRegionLines(pageText) {
  const lines = [];
  for (const line of String(pageText || "").split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:abstract\b|摘要)/i.test(trimmed)) break;
    const words = trimmed.split(/\s+/);
    const lower = words.filter((word) => /^\p{Ll}/u.test(word)).length;
    if (words.length >= 12 && lower >= 4) break;
    lines.push(trimmed);
  }
  return lines;
}

function authorCoversName(authors, candidate) {
  const want = nameKey(candidate);
  if (!want) return true;
  return (authors || []).some((author) => nameKey(author?.name) === want);
}

/** Person names visible in the title block but absent from a clean authors[]. */
export function missingTitleAuthors(authors, pageText) {
  const seen = new Set();
  const missing = [];
  for (const line of authorRegionLines(pageText)) {
    for (const name of personNamesInLine(line)) {
      const key = nameKey(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!authorCoversName(authors, name)) missing.push(name);
    }
  }
  return missing;
}

export function structureAuthorsLookTruncated(authors, pageText) {
  return missingTitleAuthors(authors, pageText).length >= AUTHOR_TRUNCATION_MIN;
}

/**
 * One STRUCTURE call, then a single completeness retry when the pack is clean
 * but the title-page text still shows at least two omitted people.
 * A second truncated pack is discarded. Attention surnames are not hardcoded.
 */
export async function resolveTitleStructure(pageText, page, request) {
  const ask = async (user) => {
    let res;
    try {
      res = await request({ system: PDF_STRUCTURE_SYSTEM, user });
    } catch {
      return fail("request");
    }
    return parsePdfStructureJson(res?.ok ? res.raw : "");
  };
  const first = await ask(structureUserPrompt(pageText, page));
  if (!first.ok) return first;
  const missing = missingTitleAuthors(first.structure.authors, pageText);
  if (missing.length < AUTHOR_TRUNCATION_MIN) return first;
  const second = await ask(structureCompletenessPrompt(pageText, page, missing));
  if (!second.ok) return fail("authors-truncated");
  if (structureAuthorsLookTruncated(second.structure.authors, pageText)) return fail("authors-truncated");
  return second;
}

function footnoteMarkers(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") return null;
  if (hasMarkup(value)) return null;
  const text = value.replace(/\s+/g, "");
  if (!text || text.length > LIMIT.markers || !MARKER_ONLY.test(text)) return "";
  return text;
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
  const prepared = [];
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
    const markers = footnoteMarkers(entry.markers);
    if (markers == null) return fail("markers");
    prepared.push({ name, affiliation, email, markers });
  }
  const dirty = dirtyAuthorIndexes(prepared);
  if (dirty.size >= 2) return fail("authors-dirty");
  const authors = [];
  prepared.forEach((entry, index) => {
    if (dirty.has(index)) return;
    const author = { name: entry.name };
    if (entry.affiliation) author.affiliation = entry.affiliation;
    if (entry.email) author.email = entry.email;
    if (entry.markers) author.markers = entry.markers;
    authors.push(author);
  });
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
  const rest = collectRest(input);
  if (rest.length) structure.rest = rest;
  return { ok: true, structure };
}

function dirtyAuthorIndexes(prepared) {
  const dirty = new Set();
  prepared.forEach((author, index) => {
    if (!authorNameHasLetter(author.name)) dirty.add(index);
    if (hasMultipleEmails(author.email) || hasMultipleEmails(author.name) || hasMultipleEmails(author.affiliation)) {
      dirty.add(index);
    }
  });
  prepared.forEach((author, index) => {
    const blob = `${author.name}\n${author.affiliation}`;
    prepared.forEach((other, otherIndex) => {
      if (index === otherIndex || !authorNameHasLetter(other.name)) return;
      if (coreName(author.name).toLowerCase() === coreName(other.name).toLowerCase()) return;
      const nameHit = containsOtherName(author.name, other.name) || containsOtherName(author.affiliation, other.name);
      const foreign = uniqueEmails(other.email).filter((mail) => mail !== String(author.email || "").trim().toLowerCase());
      const mailHit = foreign.some((mail) => blob.toLowerCase().includes(mail));
      if (nameHit || mailHit) dirty.add(index);
    });
  });
  return dirty;
}

function footnoteLine(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  const marker = typeof entry.marker === "string" ? entry.marker.replace(/\s+/g, "") : "";
  const text = typeof entry.text === "string" ? entry.text.replace(/\s+/g, " ").trim() : "";
  if ((marker && hasMarkup(marker)) || (text && hasMarkup(text))) return "";
  const symbol = marker && marker.length <= LIMIT.markers && MARKER_ONLY.test(marker) ? marker : "";
  if (!text) return symbol;
  if (!symbol || text.startsWith(symbol)) return text.length > LIMIT.restText ? "" : text;
  const combined = `${symbol} ${text}`.trim();
  return combined.length > LIMIT.restText ? "" : combined;
}

function pushRest(rest, seen, role, text) {
  if (rest.length >= LIMIT.rest) return;
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > LIMIT.restText || hasMarkup(clean)) return;
  const key = `${role}\n${clean}`;
  if (seen.has(key)) return;
  seen.add(key);
  rest.push({ role, text: clean });
}

/** Legacy footnotes[] become rest[{role:"other"}]. Invalid rest is ignored. */
function collectRest(input) {
  const rest = [];
  const seen = new Set();
  if (Array.isArray(input.footnotes)) {
    for (const entry of input.footnotes) pushRest(rest, seen, "other", footnoteLine(entry));
  }
  if (Array.isArray(input.rest)) {
    for (const entry of input.rest) {
      if (!entry || typeof entry !== "object" || typeof entry.text !== "string") continue;
      const role = REST_ROLES.has(entry.role) ? entry.role : "other";
      pushRest(rest, seen, role, entry.text);
    }
  }
  return rest;
}

function slot(path, text) {
  const value = String(text || "").trim();
  if (!value) return null;
  return { path, text: value };
}

/** Translatable strings in refill order. Email and markers stay on the source pack. */
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
    if (!author || path[2] === "email" || path[2] === "markers") return;
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

/** Refill string fields. Shape, roles, emails, and markers stay put. */
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
