/** Saved PDF readout. The viewer restores this instead of translating again. */

const LIBRARY_BASE = "http://127.0.0.1:8765";

/** Preserve page-save order, including when an earlier write fails. */
export function createLibraryWriteQueue() {
  let tail = Promise.resolve();
  return (write) => {
    const job = tail.then(write);
    tail = job.catch(() => {});
    return job;
  };
}

function readablePng(dataUrl) {
  try {
    const header = atob(String(dataUrl).split(",")[1].slice(0, 36));
    if (header.slice(1, 4) !== "PNG") return false;
    const value = (at) => (
      (header.charCodeAt(at) * 0x1000000) +
      (header.charCodeAt(at + 1) << 16) +
      (header.charCodeAt(at + 2) << 8) +
      header.charCodeAt(at + 3)
    );
    return value(16) >= 24 && value(20) >= 12;
  } catch {
    return false;
  }
}

export function storedReadoutBlocks(markdown) {
  const blocks = [];
  const recentParagraphs = new Map();
  const normalized = String(markdown || "").replace(/\r\n?/g, "\n");
  for (const part of normalized.split(/\n{2,}/)) {
    const chunk = part.trim();
    if (!chunk) continue;
    const visual = chunk.replace(/^#{1,2}[ \t]+(?=!\[)/, "");
    const image = visual.match(/^!\[([^\]]*)\]\((data:image\/png;base64,[A-Za-z0-9+/=]+)\)$/);
    if (image) {
      if (readablePng(image[2])) blocks.push({ tag: "img", alt: image[1] || "公式", src: image[2] });
      continue;
    }
    if (visual.startsWith("![") || /data:image\/|chrome-extension:\/\//.test(chunk)) continue;
    const heading = chunk.match(/^(#{1,2})[ \t]+([^\n]+)$/);
    if (heading && heading[2].length <= 100 && !/[。；;]/.test(heading[2])) {
      blocks.push({ tag: heading[1].length === 1 ? "h1" : "h2", text: heading[2].trim() });
      continue;
    }
    const text = chunk.replace(/^#+\s*/, "");
    const previous = recentParagraphs.get(text);
    if (text.length >= 80 && previous != null && blocks.length - previous < 30) continue;
    if (text.length >= 80) recentParagraphs.set(text, blocks.length);
    blocks.push({ tag: "p", text });
  }
  return blocks;
}

export function pairsFromResults(results) {
  return (results || []).map((item) => ({
    text: String(item?.text || item?.original || "").trim(),
    translation: String(item?.translation || "").trim(),
    ...(item?.sourceId ? { sourceId: String(item.sourceId) } : {}),
    ...(item?.sourceText ? { sourceText: String(item.sourceText) } : {}),
    ...(item?.id ? { id: String(item.id) } : {})
  })).filter((item) => item.text && item.translation);
}

export function applySavedPairs(units, pairs) {
  const bySourceId = new Map((pairs || []).filter((item) => item.sourceId)
    .map((item) => [String(item.sourceId), item]));
  const byText = new Map((pairs || []).filter((item) => item.text && !item.sourceId)
    .map((item) => [String(item.text).trim(), item]));
  return (units || []).map((unit) => {
    const hit = bySourceId.get(String(unit.sourceId || "")) || byText.get(String(unit.text || "").trim());
    if (hit?.sourceText && unit.sourceText &&
        String(hit.sourceText).replace(/\s+/g, " ").trim() !== String(unit.sourceText).replace(/\s+/g, " ").trim()) {
      return { ...unit, translation: "", translationStatus: "source-uncertain" };
    }
    return {
      ...unit,
      translation: String(hit?.translation || unit.translation || ""),
      ...(hit?.status ? { translationStatus: String(hit.status) } : {})
    };
  });
}

/** Page records supersede the legacy whole-document Markdown when both exist. */
export function selectSavedTranslation(document, page) {
  if (!document) return null;
  const pages = Array.isArray(document.pages) ? document.pages : [];
  if (pages.length) return pages.find((item) => item.page === page) || { page, pairs: [], migrated: true };
  return document.readout ? { readout: true } : null;
}

export async function fetchLibraryDocument(hash) {
  if (!hash || hash === "nohash") return null;
  for (const delay of [0, 400, 1000, 1800]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const res = await fetch(`${LIBRARY_BASE}/v1/library/document?hash=${encodeURIComponent(hash)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`library HTTP ${res.status}`);
      return res.json();
    } catch {
      // The Native Messaging host may have just launched port 8765.
    }
  }
  throw new Error("local PDF library unavailable");
}

export async function saveLibraryPage(payload) {
  const res = await fetch(`${LIBRARY_BASE}/v1/library/page`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`library HTTP ${res.status}`);
}
