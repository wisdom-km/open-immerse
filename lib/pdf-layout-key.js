/** Layout cache key. No layout client, so settings and the service worker can parse keys. */

export function parseLayoutCacheKey(key) {
  const text = String(key || "");
  const prefix = "oi-pdf-layout:";
  const marker = ":source-v3";
  if (!text.startsWith(prefix)) return null;
  const sourceAt = text.lastIndexOf(marker);
  if (sourceAt < 0) return null;
  const tail = text.slice(sourceAt + marker.length);
  if (tail && !/^:[A-Za-z0-9._+-]+$/.test(tail)) return null;
  const pipeline = tail.startsWith(":") ? tail.slice(1) : "";
  const parts = text.slice(prefix.length, sourceAt).split(":");
  if (parts.length < 4) return null;
  const protocol = parts.pop();
  const mode = parts.pop();
  const page = Number(parts.pop());
  const docHash = parts.join(":");
  if (!docHash || !(page >= 1) || !mode || !protocol) return null;
  return { docHash, page, mode, protocol, pipeline };
}
