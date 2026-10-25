/**
 * One-time notice after an upgrade flips features.pdf from false to true.
 * The flip time lives on settings.migrationNotes.pdfFlippedAt.
 * Dismissal lives in chrome.storage.local, not in settings.
 */

export const PDF_DEFAULT_NOTICE_KEY = "oi.notice.pdfDefaultOn";

export const PDF_DEFAULT_NOTICE_COPY =
  "PDF 阅读已默认开启。在浏览器里打开 PDF 会用沉浸译的双栏阅读器；不想用可以在这里关闭。";

export function pdfFlippedAt(settings) {
  const at = settings?.migrationNotes?.pdfFlippedAt;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

export function pdfDefaultNoticeSeen(record) {
  return Boolean(record && typeof record.seenAt === "number" && Number.isFinite(record.seenAt));
}

/** True only when the upgrade wrote pdfFlippedAt and nothing has dismissed it. */
export function pdfDefaultNoticeVisible(settings, seen) {
  return pdfFlippedAt(settings) != null && !pdfDefaultNoticeSeen(seen);
}

/**
 * 知道了, turning PDF off, and the first time either place shows the notice
 * all write the same local record. After that neither place shows it.
 */
export function dismissPdfDefaultNotice(reason, now = Date.now()) {
  if (reason !== "ack" && reason !== "off" && reason !== "seen") return null;
  const seenAt = typeof now === "function" ? now() : now;
  if (typeof seenAt !== "number" || !Number.isFinite(seenAt)) return null;
  return { seenAt };
}

export async function readPdfDefaultNoticeSeen(area) {
  if (!area || typeof area.get !== "function") return null;
  const bag = await area.get(PDF_DEFAULT_NOTICE_KEY);
  const value = bag?.[PDF_DEFAULT_NOTICE_KEY];
  return pdfDefaultNoticeSeen(value) ? { seenAt: value.seenAt } : null;
}

export async function writePdfDefaultNoticeSeen(area, record) {
  const next = pdfDefaultNoticeSeen(record) ? { seenAt: record.seenAt } : null;
  if (!next) return null;
  if (area && typeof area.set === "function") {
    await area.set({ [PDF_DEFAULT_NOTICE_KEY]: next });
  }
  return next;
}
