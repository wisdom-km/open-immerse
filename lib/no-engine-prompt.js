/** Shared copy for the unconfigured-engine prompt. UI strings stay here. */

export const NO_ENGINE_COPY = Object.freeze({
  title: "还没有可用的翻译引擎",
  body: "去设置里选一个引擎并填写 API Key，就能开始翻译。",
  primary: "去设置",
  dismiss: "关闭",
  engineUnset: "未设置",
  providerPlaceholder: "请选择引擎",
  providerHint: "选择引擎后填写 API Key。MyMemory 免费但质量有限，无需 Key。",
  settingsHash: "#translate?focus=provider"
});

export const NO_ENGINE_SETTINGS_PATH = `options/options.html${NO_ENGINE_COPY.settingsHash}`;

/** Existing settings focus ring: focus the control and flash it once for 1.2s. */
export function flashFocus(node, dwellMs = 1200) {
  if (!node) return false;
  node.scrollIntoView?.({ block: "center" });
  node.focus?.();
  node.classList.add("set-flash");
  setTimeout(() => node.classList.remove("set-flash"), dwellMs);
  return true;
}
