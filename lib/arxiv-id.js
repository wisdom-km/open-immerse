/** arXiv id from the PDF stamp and from arxiv.org URLs. No network. */

import { isArxivMarginItem } from "./pdf-readout.js";

const NEW_ID = String.raw`\d{4}\.\d{4,5}`;
const OLD_ID = String.raw`[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7}`;
const ID_RE = new RegExp(`^(${NEW_ID}|${OLD_ID})(v\\d+)?$`, "i");
const STAMP_RE = new RegExp(
  `arXiv:\\s*(${NEW_ID}|${OLD_ID})\\s*(v\\d+)?`,
  "i"
);

function clean(value) {
  return String(value || "")
    .trim()
    .replace(/^arxiv:\s*/i, "")
    .replace(/\s+/g, "");
}

function canonicalOld(id) {
  const slash = id.indexOf("/");
  if (slash < 0) return id;
  const archive = id.slice(0, slash).toLowerCase();
  const rest = id.slice(slash + 1);
  const dot = archive.indexOf(".");
  if (dot < 0) return `${archive}/${rest}`;
  return `${archive.slice(0, dot)}.${archive.slice(dot + 1).toUpperCase()}/${rest}`;
}

/**
 * Canonical id, version kept when present (`1706.03762v7`, `hep-th/9711200`).
 * @returns {string|null}
 */
export function normalizeArxivId(str) {
  const raw = clean(str).replace(/\.pdf$/i, "");
  const match = raw.match(ID_RE);
  if (!match) return null;
  const id = match[1].includes("/") ? canonicalOld(match[1]) : match[1];
  return `${id}${match[2] ? match[2].toLowerCase() : ""}`;
}

function splitId(canonical) {
  if (!canonical) return null;
  const match = canonical.match(/^(.*?)(v\d+)?$/i);
  if (!match) return null;
  const version = match[2] ? match[2].toLowerCase() : null;
  const id = version ? canonical.slice(0, -version.length) : canonical;
  if (!id) return null;
  return { id, version };
}

export function parseArxivUrl(url) {
  const text = String(url || "").trim();
  if (!text || !/arxiv\.org/i.test(text)) return null;
  let path = text;
  try {
    const parsed = new URL(text);
    if (!/^(?:www\.)?arxiv\.org$/i.test(parsed.hostname)) return null;
    path = decodeURIComponent(parsed.pathname || "");
  } catch {
    const inline = text.match(/arxiv\.org(\/[^?#\s]+)/i);
    if (!inline) return null;
    path = inline[1];
  }
  const located = path.match(/\/(?:pdf|abs|src|e-print|html)\/(.+)$/i);
  if (!located) return null;
  const canonical = normalizeArxivId(located[1].replace(/\.pdf$/i, ""));
  return splitId(canonical);
}

function itemText(item) {
  return String(item?.str ?? item?.text ?? "");
}

function itemPos(item) {
  const x = Number(item?.x ?? item?.transform?.[4]);
  const y = Number(item?.transform?.[5] ?? item?.y);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0
  };
}

export function findArxivStamp(page1Items, page) {
  const items = Array.isArray(page1Items) ? page1Items : [];
  const hits = items.filter((item) => isArxivMarginItem(item, page));
  if (!hits.length) return null;
  const ordered = hits.slice().sort((a, b) => {
    const pa = itemPos(a);
    const pb = itemPos(b);
    if (pa.x !== pb.x) return pa.x - pb.x;
    return pb.y - pa.y;
  });
  const raw = ordered.map((item) => itemText(item)).join("").replace(/\s+/g, " ").trim();
  const compact = ordered.map((item) => itemText(item)).join("");
  const match = compact.match(STAMP_RE) || raw.match(STAMP_RE);
  if (!match) return null;
  const canonical = normalizeArxivId(`${match[1]}${match[2] || ""}`);
  const parts = splitId(canonical);
  if (!parts) return null;
  return { ...parts, raw: raw || compact };
}

/**
 * Stamp wins over the URL. Bibliography ids are not margin stamps.
 * @returns {{id: string, version: string|null, source: "stamp"|"url"}|null}
 */
export function detectArxivId({ url, page1Items, page } = {}) {
  const stamp = findArxivStamp(page1Items, page);
  if (stamp) return { id: stamp.id, version: stamp.version, source: "stamp" };
  const fromUrl = parseArxivUrl(url);
  if (fromUrl) return { id: fromUrl.id, version: fromUrl.version, source: "url" };
  return null;
}
