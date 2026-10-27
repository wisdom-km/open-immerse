/**
 * Copy and mark model for the four multimodal page touchpoints.
 * Colors stay in reader tokens. This module does not invent a palette.
 */

export const MM_REBUILDING_COPY = "正在重建本页";
export const MM_FAILED_COPY = "重建失败，已用文字层";
export const MM_RETRY_COPY = "重译本页";

export const MM_FALLBACK_COPY = Object.freeze({
  timeout: "已改用文字层 · 超时",
  "not-configured": "已改用文字层 · 未设置多模态",
  coverage: "已改用文字层 · 识别不完整",
  parse: "已改用文字层 · 结果无法读取"
});

export const MARK_PRIORITY = Object.freeze(["num-mismatch", "restored", "mm-only"]);

const MARK_DATA = Object.freeze({
  "num-mismatch": "num",
  restored: "restored",
  "mm-only": "mm"
});

const MARK_ARIA = Object.freeze({
  "num-mismatch": "本段数字识别不一致",
  restored: "本段有补回的句子",
  "mm-only": "本段仅来自图像识别"
});

export function markFit(spacePx) {
  return Number(spacePx) < 8 ? "dot" : "bar";
}

export function markTip(flag, detail) {
  if (flag === "num-mismatch") {
    const pairs = detail?.nums || [];
    const shown = pairs.map((pair) => `${pair.text || ""} / 模型：${pair.model || ""}`).join("；");
    return `数字与原文识别不一致，已按 PDF 文字显示：${shown}`;
  }
  if (flag === "restored") return "本段有句子由 PDF 文字补回";
  if (flag === "mm-only") return "这段只在图像识别中出现，PDF 文字里没有";
  return "";
}

export function markPresentation(flags, detail) {
  const present = MARK_PRIORITY.filter((flag) => (flags || []).includes(flag));
  if (!present.length) return null;
  const tips = present.map((flag) => markTip(flag, detail)).filter(Boolean);
  return {
    data: MARK_DATA[present[0]],
    flag: present[0],
    flags: present,
    tooltip: tips.join("\n"),
    aria: MARK_ARIA[present[0]] || ""
  };
}

/**
 * Page slot status. The failure chip wins over “正在重建本页”.
 * “重建失败” contains 失败 and stays hidden while the page is still running.
 * The unconfigured line is one per document, on page 1.
 */
export function mmPageStatusView({
  phase = "",
  reason = "",
  running = false,
  page = 1,
  noticeUsed = false,
  chip = false
} = {}) {
  if (chip) return null;
  if (phase === "rebuilding") {
    return { kind: "mm-rebuilding", text: MM_REBUILDING_COPY, tone: "muted", retry: "" };
  }
  if (phase !== "fallback") return null;
  if (reason === "not-configured") {
    if (Number(page) !== 1 || noticeUsed) return null;
    return {
      kind: "mm-fallback",
      text: MM_FALLBACK_COPY["not-configured"],
      tone: "muted",
      retry: "",
      notice: true
    };
  }
  if (MM_FALLBACK_COPY[reason]) {
    return { kind: "mm-fallback", text: MM_FALLBACK_COPY[reason], tone: "muted", retry: "" };
  }
  if (reason === "aborted" || !reason) return null;
  if (running) return null;
  return { kind: "mm-failed", text: MM_FAILED_COPY, tone: "muted", retry: MM_RETRY_COPY };
}

/** #status shows the stale sentence only for the current page, and only while its .rf-ps is off screen. */
export function staleStatusVisible({ current = false, inView = false, stale = false } = {}) {
  return stale === true && current === true && inView !== true;
}

/**
 * Light and dark mark colors against paper. Values are the resolved tokens
 * (warm light is the default light theme; dark is data-reader-theme=dark).
 * line-strong clears 3:1 on both, so the dashed mm-only bar keeps it.
 */
export const MARK_CONTRAST_SAMPLES = Object.freeze({
  light: Object.freeze({
    paper: "#F6F3EC",
    num: "#8A4B0F",
    restored: "#655F54",
    mm: "#8A806C"
  }),
  white: Object.freeze({
    paper: "#FFFFFF",
    num: "#8A4B0F",
    restored: "#655F54",
    mm: "#8A806C"
  }),
  dark: Object.freeze({
    paper: "#1C1D1F",
    num: "#E2A86A",
    restored: "#A8A49B",
    mm: "#8A8F98"
  })
});

function channel(hex) {
  const h = String(hex || "").replace("#", "");
  const n = Number.parseInt(h, 16);
  const raw = (shift) => ((n >> shift) & 255) / 255;
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(raw(16)) + 0.7152 * lin(raw(8)) + 0.0722 * lin(raw(0));
}

export function contrastRatio(foreground, background) {
  const fg = channel(foreground);
  const bg = channel(background);
  const hi = Math.max(fg, bg);
  const lo = Math.min(fg, bg);
  return (hi + 0.05) / (lo + 0.05);
}

export function markContrastOk(samples = MARK_CONTRAST_SAMPLES, minimum = 3) {
  const out = {};
  for (const [theme, row] of Object.entries(samples)) {
    out[theme] = {
      num: contrastRatio(row.num, row.paper),
      restored: contrastRatio(row.restored, row.paper),
      mm: contrastRatio(row.mm, row.paper)
    };
    out[theme].ok = out[theme].num >= minimum && out[theme].restored >= minimum && out[theme].mm >= minimum;
  }
  return out;
}
