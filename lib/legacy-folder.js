/**
 * Read an old local-service files/ directory.
 * A paper is a long alphanumeric folder that holds page-NNN.json, source.pdf,
 * or readout.md. The caller passes a directory handle. This file does not
 * touch IndexedDB. importBundle applies the records.
 */

import { LIBRARY_SCHEMA, stripSecrets } from "./library-store.js";
import { toLibraryRecords } from "./pdf-library.js";

const PAPER_NAME = /^[A-Za-z0-9]{16,}$/;
const PAGE_FILE = /^page-(\d+)\.json$/i;

export function isLegacyPaperName(name) {
  return PAPER_NAME.test(String(name || ""));
}

function isDirectory(handle) {
  if (!handle || typeof handle !== "object") return false;
  if (handle.kind === "file") return false;
  if (handle.kind === "directory") return true;
  if (handle.children && typeof handle.children === "object") return true;
  if (typeof handle.entries === "function") return true;
  if (typeof handle.getDirectoryHandle === "function") return true;
  return false;
}

export async function listEntries(handle) {
  if (!handle || handle.unavailable === true) {
    const error = new Error("folder unavailable");
    error.name = "NotFoundError";
    throw error;
  }
  if (handle.children && typeof handle.children === "object" && !Array.isArray(handle.children)) {
    return Object.entries(handle.children).map(([name, child]) => ({
      name,
      handle: child && typeof child === "object" ? { name, ...child, name: child.name || name } : { name, kind: "file" }
    }));
  }
  if (typeof handle.entries !== "function") return [];
  const produced = handle.entries();
  const pairs = [];
  if (Array.isArray(produced)) {
    for (const pair of produced) pairs.push(pair);
  } else if (produced && typeof produced[Symbol.asyncIterator] === "function") {
    for await (const pair of produced) pairs.push(pair);
  } else if (produced && typeof produced[Symbol.iterator] === "function") {
    for (const pair of produced) pairs.push(pair);
  }
  return pairs.map((pair) => ({
    name: pair[0],
    handle: pair[1] && pair[1].name ? pair[1] : { ...(pair[1] || {}), name: pair[0] }
  }));
}

async function readText(handle) {
  if (handle == null) return "";
  if (typeof handle.text === "string") return handle.text;
  if (typeof handle.text === "function") return handle.text();
  if (typeof handle.getFile === "function") {
    const file = await handle.getFile();
    if (typeof file.text === "function") return file.text();
    if (typeof file.text === "string") return file.text;
  }
  const bytes = await readBytes(handle);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

async function readBytes(handle) {
  if (!handle) return null;
  if (handle.bytes instanceof Uint8Array) return handle.bytes;
  if (Array.isArray(handle.bytes)) return Uint8Array.from(handle.bytes);
  if (typeof handle.getFile === "function") {
    const file = await handle.getFile();
    if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
    if (file.bytes instanceof Uint8Array) return file.bytes;
  }
  if (typeof handle.arrayBuffer === "function") return new Uint8Array(await handle.arrayBuffer());
  return null;
}

async function isPaperDir(entry) {
  if (!isLegacyPaperName(entry.name) || !isDirectory(entry.handle)) return false;
  let inner = [];
  try {
    inner = await listEntries(entry.handle);
  } catch {
    return false;
  }
  return inner.some((item) => PAGE_FILE.test(item.name) || item.name === "source.pdf" || item.name === "readout.md");
}

async function scan(dirHandle) {
  const entries = await listEntries(dirHandle);
  const papers = [];
  const ignored = [];
  for (const entry of entries) {
    if (await isPaperDir(entry)) papers.push({ docHash: entry.name, handle: entry.handle, name: entry.name });
    else ignored.push(entry.name);
  }
  return { entries, papers, ignored };
}

/**
 * Classify the directory the user picked.
 * kind: empty | unrelated | parent | partial | library
 */
export async function listLegacyFolder(handle) {
  const folder = String(handle?.name || "旧库");
  let scanned;
  try {
    scanned = await scan(handle);
  } catch (error) {
    if (error?.name === "NotFoundError") {
      return { kind: "unreadable", folder, papers: [], ignored: [], root: handle, parentAdjusted: false };
    }
    throw error;
  }
  if (scanned.entries.length === 0) {
    return { kind: "empty", folder, papers: [], ignored: [], root: handle, parentAdjusted: false };
  }
  if (scanned.papers.length >= 1) {
    return {
      kind: scanned.ignored.length ? "partial" : "library",
      folder,
      papers: scanned.papers,
      ignored: scanned.ignored,
      root: handle,
      parentAdjusted: false
    };
  }
  const filesDirs = [];
  for (const entry of scanned.entries) {
    if (entry.name === "files" && isDirectory(entry.handle)) filesDirs.push(entry);
  }
  if (filesDirs.length === 1) {
    const nested = await scan(filesDirs[0].handle);
    if (nested.papers.length >= 1) {
      return {
        kind: "parent",
        folder,
        papers: nested.papers,
        ignored: nested.ignored,
        root: filesDirs[0].handle,
        parentAdjusted: true
      };
    }
  }
  return { kind: "unrelated", folder, papers: [], ignored: [], root: handle, parentAdjusted: false };
}

function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let binary = "";
  const group = 8192;
  for (let start = 0; start < view.length; start += group) {
    const slice = view.subarray(start, Math.min(start + group, view.length));
    let chunk = "";
    for (let index = 0; index < slice.length; index += 1) chunk += String.fromCharCode(slice[index]);
    binary += chunk;
  }
  return btoa(binary);
}

export async function readLegacyPaper(handle, docHash, now = Date.now()) {
  const hash = String(docHash || handle?.name || "");
  let entries = [];
  try {
    entries = await listEntries(handle);
  } catch {
    return { error: { docHash: hash, title: "", reason: "corrupt", at: now } };
  }
  const pages = [];
  let readout = "";
  let title = "";
  let fileName = "";
  let pageCount = 0;
  let rev = null;
  let updatedAt = null;
  let source = null;
  for (const entry of entries) {
    const pageMatch = PAGE_FILE.exec(entry.name);
    if (pageMatch) {
      let parsed;
      try {
        parsed = JSON.parse(await readText(entry.handle));
      } catch {
        return { error: { docHash: hash, title, reason: "corrupt", at: now } };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: { docHash: hash, title, reason: "corrupt", at: now } };
      }
      parsed = stripSecrets(parsed);
      if (parsed.pairs != null && !Array.isArray(parsed.pairs)) {
        return { error: { docHash: hash, title, reason: "corrupt", at: now } };
      }
      const pageNo = Math.floor(Number(pageMatch[1]));
      if (!(pageNo >= 1)) return { error: { docHash: hash, title, reason: "corrupt", at: now } };
      pages.push({
        page: pageNo,
        pairs: Array.isArray(parsed.pairs) ? parsed.pairs : [],
        skipped: parsed.skipped === true,
        migrated: parsed.migrated === true,
        layout: parsed.layout,
        layoutVersion: parsed.layoutVersion,
        rev: parsed.rev,
        updatedAt: parsed.updatedAt
      });
      continue;
    }
    if (entry.name === "readout.md") {
      try {
        readout = await readText(entry.handle);
      } catch {
        return { error: { docHash: hash, title, reason: "corrupt", at: now } };
      }
      continue;
    }
    if (entry.name === "source.pdf") {
      try {
        source = await readBytes(entry.handle);
      } catch {
        return { error: { docHash: hash, title, reason: "corrupt", at: now } };
      }
      if (!fileName) fileName = "source.pdf";
      continue;
    }
    if (entry.name === "paper.json" || entry.name === "meta.json") {
      let meta;
      try {
        meta = JSON.parse(await readText(entry.handle));
      } catch {
        return { error: { docHash: hash, title, reason: "corrupt", at: now } };
      }
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
        return { error: { docHash: hash, title, reason: "corrupt", at: now } };
      }
      meta = stripSecrets(meta);
      if (meta.title) title = String(meta.title);
      if (meta.fileName) fileName = String(meta.fileName);
      if (meta.pageCount != null) pageCount = Number(meta.pageCount) || 0;
      if (meta.rev != null) rev = meta.rev;
      if (meta.updatedAt != null) updatedAt = meta.updatedAt;
    }
  }
  const records = toLibraryRecords({
    title,
    fileName,
    pageCount: pageCount || pages.length,
    readout,
    pages
  }, hash);
  // A missing timestamp is 0. Stamping "now" would make an equal-rev local
  // row look older and get overwritten by a folder that is not newer.
  const stamp = updatedAt == null || updatedAt === "" ? 0 : Number(updatedAt);
  const when = Number.isFinite(stamp) ? stamp : 0;
  const paperRev = rev == null ? 1 : rev;
  const entry = {
    paper: {
      ...records.paper,
      docHash: hash,
      schema: LIBRARY_SCHEMA,
      origin: "import",
      rev: paperRev,
      updatedAt: when,
      importedAt: now,
      openedAt: when,
      lastOpenedAt: when
    },
    pages: records.pages.map((page) => ({
      ...page,
      docHash: hash,
      schema: LIBRARY_SCHEMA,
      rev: page.rev == null ? paperRev : page.rev,
      updatedAt: page.updatedAt == null || page.updatedAt === "" ? when : (Number(page.updatedAt) || 0)
    })),
    layouts: (records.layouts || []).map((layout) => ({
      ...layout,
      docHash: hash,
      savedAt: when
    }))
  };
  if (source && source.byteLength) {
    entry.source = { docHash: hash, base64: bytesToBase64(source), size: source.byteLength };
  }
  return { entry };
}
