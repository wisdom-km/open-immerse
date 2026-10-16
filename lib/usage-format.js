/**
 * Byte and percent labels for the data panel.
 * 1024-based, three significant figures. No color decisions here.
 */

export function formatApproxBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const text = value === 0 ? "0" : String(Number(value.toPrecision(3)));
  return `${text} ${units[index]}`;
}

export function formatUsageLabel(bytes) {
  const text = formatApproxBytes(bytes);
  return text ? `约 ${text}` : "";
}

export function formatUsedPercent(usage, quota) {
  const used = Number(usage);
  const cap = Number(quota);
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return "";
  const pct = (used / cap) * 100;
  if (pct < 1) return "< 1%";
  return `${Math.round(pct)}%`;
}

export function formatQuotaLabel(usage, quota) {
  const pct = formatUsedPercent(usage, quota);
  const cap = formatApproxBytes(quota);
  if (!pct || !cap) return "";
  return `已用 ${pct} · 约 ${cap}`;
}
