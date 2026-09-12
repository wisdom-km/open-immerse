export const FEATURES = [
  { id: "webpage", label: "网页翻译", hint: "全文双语对照、恢复原文、站点自动规则", group: "v1" },
  { id: "hover", label: "悬浮翻译", hint: "后续完善，默认关闭", group: "later" },
  { id: "selection", label: "划词翻译", hint: "后续完善；可先保持关闭", group: "later" },
  { id: "learning", label: "学习中心", hint: "收藏单词/句子与复习", group: "v1" },
  { id: "documents", label: "文档翻译", hint: "TXT/MD/HTML 双语与导出", group: "v1" },
  { id: "fab", label: "页面开关按钮", hint: "右下角玻璃胶囊：翻译 / 原文 / 收起", group: "v1" },
  { id: "youtube", label: "YouTube 字幕", hint: "后续功能，默认关闭", group: "later" },
  { id: "x", label: "X 字幕", hint: "后续功能，默认关闭", group: "later" }
];

export const DEFAULT_FEATURES = {
  webpage: true,
  hover: false,
  selection: false,
  youtube: false,
  x: false,
  learning: true,
  documents: true,
  fab: true
};

export function v1Features() {
  return FEATURES.filter((feat) => feat.group !== "later");
}

export function laterFeatures() {
  return FEATURES.filter((feat) => feat.group === "later");
}

export function resolveFeatures(settings = {}) {
  const merged = { ...DEFAULT_FEATURES, ...(settings.features || {}) };
  if (settings.hoverEnabled) merged.hover = true;
  if (settings.showFab === false) merged.fab = false;
  return merged;
}

export function featureOn(settings, id) {
  return Boolean(resolveFeatures(settings)[id]);
}
