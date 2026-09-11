const ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}
