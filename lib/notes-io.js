/**
 * Pure note schema, migration, and export / import.
 * Callers persist through NotesStore. This file does not touch IndexedDB.
 *
 * Record schema and the export bundle schema are both 1.
 * A later schema is a migrations[n] step. Import runs the same steps.
 * A file newer than NOTE_SCHEMA is refused so an old extension cannot drop fields.
 */

export const NOTE_SCHEMA = 1;
export const NOTES_FORMAT = "open-immerse-notes";
export const NOTE_KINDS = Object.freeze(["highlight", "note", "question", "paperNote"]);
export const NOTE_AUTHORS = Object.freeze(["me", "ai"]);
export const ANCHOR_STATUSES = Object.freeze(["exact", "alias", "text", "quote", "lost", "block"]);

/** Reserved per-note AI Q&A fields. T2a stores them when present and never creates them. */
export const NOTE_QA_FIELDS = Object.freeze(["sessionId", "turnId", "question", "answer", "model"]);

const KIND_LABELS = {
  highlight: "划线",
  note: "笔记",
  question: "问题",
  paperNote: "论文笔记"
};

export class NotesStoreError extends Error {
  constructor(type, message, extra) {
    super(message || String(type || "write"));
    this.name = "NotesStoreError";
    this.type = type || "write";
    if (extra && typeof extra === "object") {
      if (extra.cause) this.cause = extra.cause;
      if (extra.schema != null) this.schema = extra.schema;
      if (extra.supported != null) this.supported = extra.supported;
    }
  }
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * v0 (or a partial record) → schema 1.
 * Does not invent a kind. Invalid author is left for the caller to reject.
 */
export function migrateTo1(record) {
  const note = plainObject(record) ? { ...record } : {};
  if (!note.author) note.author = "me";
  if (note.kind === "paperNote") note.anchor = null;
  if (!plainObject(note.anchorState)) {
    note.anchorState = {
      status: note.kind === "paperNote" || note.anchor ? "exact" : "lost",
      layoutRev: "",
      checkedAt: 0
    };
  } else {
    note.anchorState = { ...note.anchorState };
  }
  if (!Number.isFinite(Number(note.rev)) || Number(note.rev) < 1) note.rev = 1;
  else note.rev = Math.floor(Number(note.rev));
  if (!Number.isFinite(Number(note.page))) note.page = finite(note.anchor?.page);
  else note.page = Math.floor(Number(note.page));
  if (note.qa != null && !plainObject(note.qa)) delete note.qa;
  note.schema = 1;
  return note;
}

/** One pure function per record schema. Database upgrades call the same table. */
export const migrations = {
  1: migrateTo1
};

export function migrateNote(record) {
  if (!plainObject(record)) {
    throw new NotesStoreError("schema", "笔记记录无法迁移。");
  }
  const raw = record.schema == null || record.schema === "" ? 0 : Number(record.schema);
  if (!Number.isInteger(raw) || raw < 0) {
    throw new NotesStoreError("schema", "笔记格式版本无法识别。");
  }
  if (raw > NOTE_SCHEMA) {
    throw new NotesStoreError(
      "schema",
      `这份笔记来自更新的扩展（格式版本 ${raw}），请先升级扩展后再导入。`,
      { schema: raw, supported: NOTE_SCHEMA }
    );
  }
  let current = { ...record };
  for (let version = raw + 1; version <= NOTE_SCHEMA; version += 1) {
    const step = migrations[version];
    if (typeof step !== "function") {
      throw new NotesStoreError("schema", `缺少迁移到版本 ${version} 的步骤。`);
    }
    current = step(current);
    current.schema = version;
  }
  return current;
}

export function copyNoteQa(qa) {
  if (!plainObject(qa)) return undefined;
  const out = {};
  for (const key of NOTE_QA_FIELDS) {
    if (qa[key] == null || qa[key] === "") continue;
    out[key] = String(qa[key]);
  }
  return Object.keys(out).length ? out : undefined;
}

export function copyAnchorState(state, anchor, kind) {
  const status = state?.status;
  const fallback = kind === "paperNote" || anchor ? "exact" : "lost";
  const next = {
    status: ANCHOR_STATUSES.includes(status) ? status : fallback,
    layoutRev: state?.layoutRev ? String(state.layoutRev) : "",
    checkedAt: finite(state?.checkedAt)
  };
  if (state?.drift === true) next.drift = true;
  return next;
}

export function sanitizeNote(note) {
  const kind = note?.kind;
  const anchor = kind === "paperNote" ? null : (note?.anchor ?? null);
  const next = {
    id: String(note.id),
    schema: NOTE_SCHEMA,
    docHash: String(note.docHash),
    kind,
    author: NOTE_AUTHORS.includes(note.author) ? note.author : "me",
    anchor,
    anchorState: copyAnchorState(note.anchorState, anchor, kind),
    page: Math.max(0, Math.floor(finite(note.page) || finite(anchor?.page))),
    createdAt: finite(note.createdAt),
    updatedAt: finite(note.updatedAt),
    rev: Math.max(1, Math.floor(finite(note.rev) || 1)),
    deviceId: note.deviceId ? String(note.deviceId) : ""
  };
  if (note.body != null) next.body = String(note.body);
  if (note.title != null) next.title = String(note.title);
  if (finite(note.deletedAt) > 0) next.deletedAt = finite(note.deletedAt);
  const qa = copyNoteQa(note.qa);
  if (qa) next.qa = qa;
  if (!next.deviceId) delete next.deviceId;
  return next;
}

function jsonValue(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function preferNote(local, incoming) {
  const localRev = finite(local?.rev);
  const incomingRev = finite(incoming?.rev);
  if (incomingRev > localRev) return incoming;
  if (incomingRev < localRev) return local;
  if (finite(incoming?.updatedAt) > finite(local?.updatedAt)) return incoming;
  return local;
}

/**
 * Merge bundle-level AI Q&A sessions. Add or update only.
 * An id-less session is kept when its JSON is not already present.
 */
export function mergeQa(local = [], incoming = []) {
  const out = [];
  const byId = new Map();
  for (const item of local || []) {
    const copy = jsonValue(item);
    if (!plainObject(copy)) continue;
    out.push(copy);
    if (copy.id) byId.set(String(copy.id), out.length - 1);
  }
  for (const item of incoming || []) {
    const copy = jsonValue(item);
    if (!plainObject(copy)) continue;
    if (copy.id && byId.has(String(copy.id))) {
      const at = byId.get(String(copy.id));
      if (preferNote(out[at], copy) === copy) out[at] = copy;
      continue;
    }
    const key = JSON.stringify(copy);
    if (out.some((existing) => JSON.stringify(existing) === key)) continue;
    out.push(copy);
    if (copy.id) byId.set(String(copy.id), out.length - 1);
  }
  return out;
}

function schemaError(schema) {
  return new NotesStoreError(
    "schema",
    `这份笔记来自更新的扩展（格式版本 ${schema}），请先升级扩展后再导入。`,
    { schema, supported: NOTE_SCHEMA }
  );
}

/**
 * Plan a merge import. Does not delete local notes.
 * Throws NotesStoreError(type "schema") when the bundle or a note is newer.
 */
export function mergeNotesBundle(localNotes, bundle, localQa = []) {
  if (!plainObject(bundle) || bundle.format !== NOTES_FORMAT) {
    throw new NotesStoreError("format", "这不是 Open Immerse 的笔记文件。");
  }
  const bundleSchema = Number(bundle.schema);
  if (!Number.isInteger(bundleSchema)) {
    throw new NotesStoreError("schema", "笔记文件没有格式版本。");
  }
  if (bundleSchema > NOTE_SCHEMA) throw schemaError(bundleSchema);

  const docMeta = new Map();
  const byDoc = new Map();
  const incoming = [];
  let rejected = 0;
  const tally = (docHash, title = "") => {
    const key = String(docHash || "");
    if (!byDoc.has(key)) {
      byDoc.set(key, { docHash: key, title: title ? String(title) : "", added: 0, updated: 0, skipped: 0, rejected: 0 });
    }
    return byDoc.get(key);
  };
  const docs = Array.isArray(bundle.docs) ? bundle.docs : [];
  for (const doc of docs) {
    if (!plainObject(doc) || !doc.docHash) {
      const count = Array.isArray(doc?.notes) ? doc.notes.length : 0;
      rejected += count;
      if (count) tally("").rejected += count;
      continue;
    }
    const docHash = String(doc.docHash);
    const title = doc.title ? String(doc.title) : "";
    docMeta.set(docHash, {
      title,
      layoutRev: doc.layoutRev ? String(doc.layoutRev) : ""
    });
    for (const raw of Array.isArray(doc.notes) ? doc.notes : []) {
      let migrated;
      try {
        migrated = migrateNote(raw);
      } catch (error) {
        if (error instanceof NotesStoreError && error.type === "schema") throw error;
        rejected += 1;
        tally(docHash, title).rejected += 1;
        continue;
      }
      if (!migrated.docHash) migrated.docHash = docHash;
      if (!migrated.id || migrated.docHash !== docHash || !NOTE_KINDS.includes(migrated.kind)) {
        rejected += 1;
        tally(docHash, title).rejected += 1;
        continue;
      }
      if (migrated.author && !NOTE_AUTHORS.includes(migrated.author)) {
        rejected += 1;
        tally(docHash, title).rejected += 1;
        continue;
      }
      incoming.push(sanitizeNote(migrated));
    }
  }

  const localById = new Map((localNotes || []).map((note) => [note.id, note]));
  const writes = [];
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const note of incoming) {
    const local = localById.get(note.id);
    const row = tally(note.docHash, docMeta.get(note.docHash)?.title || "");
    if (!local) {
      added += 1;
      row.added += 1;
      writes.push(note);
      localById.set(note.id, note);
      continue;
    }
    if (preferNote(local, note) === local) {
      skipped += 1;
      row.skipped += 1;
      continue;
    }
    updated += 1;
    row.updated += 1;
    writes.push(note);
    localById.set(note.id, note);
  }

  return {
    added,
    updated,
    skipped,
    rejected,
    writes,
    docMeta,
    byDoc: [...byDoc.values()].filter((row) => row.docHash),
    qa: mergeQa(localQa, Array.isArray(bundle.qa) ? bundle.qa : [])
  };
}

export function currentAppVersion() {
  try {
    const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
    if (version) return String(version);
  } catch {
    /* opened outside the extension */
  }
  return "0.3.0";
}

function sortNotes(notes) {
  return [...notes].sort((a, b) => (
    finite(a.createdAt) - finite(b.createdAt) || String(a.id).localeCompare(String(b.id))
  ));
}

export function exportNotesBundle({ docs, qa, exportedAt, appVersion } = {}) {
  return {
    format: NOTES_FORMAT,
    schema: NOTE_SCHEMA,
    exportedAt: finite(exportedAt),
    app: { version: String(appVersion || currentAppVersion()) },
    qa: mergeQa([], qa || []),
    docs: (docs || []).map((doc) => {
      const out = {
        docHash: String(doc.docHash),
        notes: sortNotes(doc.notes || [])
      };
      if (doc.title) out.title = String(doc.title);
      if (doc.layoutRev) out.layoutRev = String(doc.layoutRev);
      return out;
    })
  };
}

function blockquote(text) {
  return String(text || "").split(/\n/).map((line) => `> ${line}`).join("\n");
}

function noteMarkdown(note) {
  const lines = [`### ${KIND_LABELS[note.kind] || note.kind}`];
  if (note.title) lines.push(String(note.title));
  const quote = note.anchor?.quoteSrc?.quote || "";
  if (quote) lines.push(blockquote(quote));
  if (note.body) lines.push(String(note.body));
  return lines.join("\n\n");
}

/**
 * Markdown export only. Grouped by page, with the source quote (N4).
 * `options.sectionName(page, doc)` adds 「 · 节名」 when a section source exists.
 * Without it the heading stays 「原文第 N 页」, which existing tests lock.
 */
export function exportMarkdown(bundle, options) {
  const sectionName = typeof options?.sectionName === "function" ? options.sectionName : null;
  const docs = Array.isArray(bundle?.docs) ? bundle.docs : [];
  const parts = [];
  for (const doc of docs) {
    const title = doc?.title || "未命名论文";
    const hash = String(doc?.docHash || "").slice(0, 8);
    parts.push(`# ${title} · ${hash}`);
    const groups = new Map();
    for (const note of doc?.notes || []) {
      if (note?.deletedAt) continue;
      const page = Number(note?.page) >= 1 ? Math.floor(Number(note.page)) : 0;
      if (!groups.has(page)) groups.set(page, []);
      groups.get(page).push(note);
    }
    for (const page of [...groups.keys()].sort((a, b) => a - b)) {
      const section = sectionName ? String(sectionName(page, doc) || "").trim() : "";
      const heading = page > 0
        ? (section ? `## 原文第 ${page} 页 · ${section}` : `## 原文第 ${page} 页`)
        : "## 论文笔记";
      parts.push(heading);
      for (const note of groups.get(page)) parts.push(noteMarkdown(note));
    }
  }
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}
