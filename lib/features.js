export const FEATURES = [
  { id: "webpage", label: "网页翻译", hint: "全文双语对照、恢复原文、站点自动规则" },
  { id: "hover", label: "悬浮翻译", hint: "鼠标停在段落上时翻译" },
  { id: "selection", label: "划词翻译", hint: "选中文本后右键翻译" },
  { id: "youtube", label: "YouTube 字幕", hint: "只在 YouTube 读已有字幕并叠加译文" },
  { id: "x", label: "X 字幕", hint: "只在 X / Twitter 视频上叠加译文" },
  { id: "learning", label: "学习中心", hint: "收藏单词/句子与复习" },
  { id: "documents", label: "文档翻译", hint: "TXT/MD/HTML 双语与导出" },
  { id: "fab", label: "页面开关按钮", hint: "右下角浮动工具条" }
];

export const DEFAULT_FEATURES = {
  webpage: true,
  hover: false,
  selection: true,
  youtube: false,
  x: false,
  learning: true,
  documents: true,
  fab: true
};

export function resolveFeatures(settings = {}) {
  const merged = { ...DEFAULT_FEATURES, ...(settings.features || {}) };
  if (settings.hoverEnabled) merged.hover = true;
  if (settings.showFab === false) merged.fab = false;
  if (settings.subtitleEnabled) {
    merged.youtube = true;
    merged.x = true;
  }
  return merged;
}

export function featureOn(settings, id) {
  return Boolean(resolveFeatures(settings)[id]);
}
