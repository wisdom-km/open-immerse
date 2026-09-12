export const DOCUMENTS_COPY = {
  title: "文档翻译",
  lead: "TXT / Markdown / HTML 可直读。PDF / DOCX / EPUB 请粘贴正文。",
  pickFile: "选择文件",
  fileNote: "PDF / DOCX / EPUB 暂不解析排版，请粘贴正文",
  placeholder: "粘贴要翻译的正文，空行分段",
  start: "开始翻译",
  exportHtml: "导出 HTML",
  stop: "停止",
  emptyOut: "译文会出现在这里。",
  emptyTranslate: "请先粘贴或选择文件",
  done: "完成。可直接改译文后导出。",
  layoutUnsupported: "暂不解析排版，请粘贴正文。",
  segmentFail: "本段失败",
  retry: "重试",
  translating: "翻译中",
  polishing: "润色中",
  polishFail: "润色失败"
};

export function progressStatus(k, n) {
  return `正在翻译第 ${k} / ${n} 段`;
}

export function isPlainTextFile(name) {
  const lower = String(name || "").toLowerCase();
  return lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".html") || lower.endsWith(".htm");
}

export function splitSegments(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 1);
}
