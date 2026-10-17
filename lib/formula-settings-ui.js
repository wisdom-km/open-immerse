/**
 * Settings and Aa controls for the formula fallback chain.
 * DOM only. Storage and probe rules live in formula-settings.js.
 */

import { ASK_ALSO_LINE, ASK_PRIVACY } from "./ask-route.js";
import { bindSecretInput } from "./secret-field.js";
import {
  FORMULA_MM_EMPTY,
  FORMULA_OCR_NOTE,
  FORMULA_ORDER,
  FORMULA_PRIVACY_NOTE,
  FORMULA_SWITCH_COPY,
  FORMULA_SWITCH_KEYS,
  MULTIMODAL_PROVIDERS,
  OCR_PROVIDERS,
  formulaOrderText,
  modelChoice,
  multimodalProvider,
  multimodalTestDisabled,
  normalizeFormulaSettings,
  ocrProvider,
  ocrSwitchState,
  ocrTestDisabled,
  probeClock,
  tier2SwitchState,
  tierActive
} from "./formula-settings.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fieldLabel(text, control) {
  const label = el("label", "oi-set-field");
  label.append(el("span", "oi-set-field-name", text), control);
  return label;
}

function chip(probe) {
  if (!probe?.chip) return null;
  const node = el("span", probe.ok ? "oi-set-chip is-ok" : "oi-set-chip is-warn");
  const clock = probeClock(probe.at);
  node.textContent = clock ? `${probe.chip} · ${clock}` : probe.chip;
  return node;
}

function failureLines(probe) {
  if (!probe || probe.ok) return [];
  const clock = probeClock(probe.at);
  const reason = el("p", "oi-set-fail", `最近失败 · ${probe.chip}${clock ? ` · ${clock}` : ""}`);
  const lines = [reason, el("p", "oi-set-fail-note", "失败的公式已改用后面的级别")];
  if (probe.summary) lines.push(el("p", "oi-set-fail-raw", probe.summary));
  return lines;
}

function keyField(value, onCommit, onRemove, placeholder, disabled, slot) {
  const row = el("div", "oi-set-key");
  row.setAttribute("data-key-row", "1");
  if (slot) row.setAttribute("data-key-slot", slot);
  const input = el("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("data-secret", "1");
  input.setAttribute("aria-label", "API 密钥");
  input.placeholder = placeholder || "粘贴密钥";
  input.disabled = disabled === true;
  let current = value || "";
  const bound = bindSecretInput(input, { getValue: () => current });
  input.addEventListener("blur", () => {
    const result = bound.commit();
    if (result.ignored) return;
    current = result.value;
    onCommit?.(result.value);
    bound.showSaved();
  });
  const toggle = el("button", "oi-set-text-btn", "显示");
  toggle.type = "button";
  toggle.setAttribute("aria-pressed", "false");
  toggle.addEventListener("click", () => {
    const shown = toggle.getAttribute("aria-pressed") === "true";
    toggle.setAttribute("aria-pressed", shown ? "false" : "true");
    toggle.textContent = shown ? "显示" : "隐藏";
    bound.reveal(!shown);
  });
  const remove = el("button", "oi-set-text-btn", "移除密钥");
  remove.type = "button";
  remove.addEventListener("click", () => onRemove?.());
  const saved = el("span", "oi-set-saved");
  saved.setAttribute("data-secret-saved", "1");
  row.append(input, toggle, remove, saved);
  bound.paint();
  return row;
}

function hiddenSwitchRow(state, onConfigure) {
  const row = el("div", "oi-set-switch-row is-muted");
  const dash = el("span", "oi-set-dash", "—");
  dash.setAttribute("aria-hidden", "true");
  const copy = el("div", "oi-set-switch-copy");
  const title = el("p", "oi-set-switch-title", state.message);
  copy.append(title);
  if (state.configure) {
    const link = el("button", "oi-set-link", "去配置");
    link.type = "button";
    link.addEventListener("click", () => onConfigure?.(state.target));
    title.append(document.createTextNode(" · "), link);
  }
  row.append(dash, copy);
  return row;
}

function liveSwitch(key, title, note, checked, onToggle, extra = []) {
  const row = el("div", "oi-set-switch-row");
  const input = el("input", "oi-set-switch");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.checked = checked === true;
  input.setAttribute("data-formula-switch", key);
  input.setAttribute("aria-label", title);
  input.addEventListener("change", () => onToggle?.(key, input.checked));
  const copy = el("div", "oi-set-switch-copy");
  copy.append(el("p", "oi-set-switch-title", title));
  if (note) copy.append(el("p", "oi-set-switch-note", note));
  for (const node of extra) copy.append(node);
  row.append(input, copy);
  return row;
}

export function renderFormulaSwitchList(container, settings, handlers = {}) {
  const stored = normalizeFormulaSettings(settings);
  container.replaceChildren();
  const tier2 = tier2SwitchState(stored);
  if (!tier2.visible) container.append(hiddenSwitchRow(tier2, handlers.onConfigure));
  else {
    const extra = [el("p", "oi-set-notice", FORMULA_PRIVACY_NOTE), ...failureLines(stored.multimodal.probe)];
    container.append(liveSwitch(
      FORMULA_SWITCH_KEYS.tier2,
      FORMULA_SWITCH_COPY.tier2.title,
      FORMULA_SWITCH_COPY.tier2.note,
      stored[FORMULA_SWITCH_KEYS.tier2],
      handlers.onToggle,
      extra
    ));
  }
  const ocr = ocrSwitchState(stored);
  if (!ocr.visible) container.append(hiddenSwitchRow(ocr, handlers.onConfigure));
  else {
    container.append(liveSwitch(
      FORMULA_SWITCH_KEYS.ocr,
      FORMULA_SWITCH_COPY.ocr.title,
      FORMULA_SWITCH_COPY.ocr.note,
      stored[FORMULA_SWITCH_KEYS.ocr],
      handlers.onToggle,
      failureLines(stored.ocr.probe)
    ));
  }
  container.append(liveSwitch(
    FORMULA_SWITCH_KEYS.tier3,
    FORMULA_SWITCH_COPY.tier3.title,
    FORMULA_SWITCH_COPY.tier3.note,
    stored[FORMULA_SWITCH_KEYS.tier3],
    handlers.onToggle
  ));
}

function orderBar(settings) {
  const bar = el("div", "oi-set-order");
  bar.setAttribute("role", "list");
  bar.setAttribute("aria-label", formulaOrderText());
  FORMULA_ORDER.forEach((item, index) => {
    const lit = tierActive(item.id, settings);
    const pill = el("span", lit ? "oi-set-tier is-on" : "oi-set-tier is-off", `${["①", "②", "③", "④", "⑤", "⑥", "⑦"][index]} ${item.label}`);
    pill.setAttribute("role", "listitem");
    bar.append(pill);
  });
  return bar;
}

function providerSelect(list, value, onChange) {
  const select = el("select");
  const empty = el("option", "", "选择厂家");
  empty.value = "";
  select.append(empty);
  for (const provider of list) {
    const option = el("option");
    option.value = provider.id;
    option.textContent = provider.vision === false && provider.unavailable
      ? provider.unavailable
      : provider.label;
    option.disabled = provider.vision === false || provider.disabled === true;
    select.append(option);
  }
  select.value = value || "";
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function testButton(kind, disabled, busy, onTest) {
  const row = el("div", "oi-set-test");
  const button = el("button", "btn-secondary oi-set-test-btn", busy ? "测试中…" : "测试连通");
  button.type = "button";
  button.disabled = disabled || busy;
  button.setAttribute("data-formula-action", kind);
  if (busy) {
    button.setAttribute("data-busy", "1");
    button.prepend(el("span", "oi-set-spin"));
  }
  button.addEventListener("click", () => {
    if (button.disabled) return;
    onTest?.(kind);
  });
  row.append(button);
  return row;
}

export function renderFormulaPanel(root, settings, handlers = {}) {
  const stored = normalizeFormulaSettings(settings);
  const mm = stored.multimodal;
  const provider = multimodalProvider(mm.provider);
  const choice = modelChoice(stored);
  const busy = handlers.busy || "";
  root.replaceChildren();

  root.append(orderBar(stored));

  const mmCard = el("section", "oi-set-card");
  mmCard.setAttribute("data-formula-card", "mm");
  const mmHead = el("div", "oi-set-card-head");
  mmHead.append(el("h3", "oi-set-card-title", "多模态"));
  const mmChip = chip(mm.probe);
  if (mmChip) mmHead.append(mmChip);
  mmCard.append(mmHead);
  mmCard.append(el("p", "oi-set-ask", ASK_ALSO_LINE));
  const mmProviderSelect = providerSelect(MULTIMODAL_PROVIDERS, mm.provider, (value) => {
    handlers.onMultimodal?.({
      provider: value,
      model: "",
      customModel: value === "custom",
      baseUrl: value === "custom" ? mm.baseUrl : ""
    });
  });
  mmProviderSelect.disabled = false;
  mmCard.append(fieldLabel("厂家", mmProviderSelect));
  const mmKey = keyField(
    mm.apiKey,
    (value) => handlers.onMultimodal?.({ apiKey: value }),
    () => handlers.onRemove?.("multimodal"),
    provider ? `粘贴 ${provider.label} 密钥` : "先选厂商",
    !provider,
    "mm"
  );
  mmCard.append(fieldLabel("API 密钥", mmKey));

  const modelsDisabled = !provider;
  if (provider?.baseUrlRequired) {
    const modelInput = el("input");
    modelInput.type = "text";
    modelInput.value = mm.model;
    modelInput.disabled = modelsDisabled;
    modelInput.spellcheck = false;
    modelInput.addEventListener("input", () => handlers.onMultimodal?.({ model: modelInput.value }, { live: true }));
    modelInput.addEventListener("change", () => handlers.onMultimodal?.({ model: modelInput.value }, { live: false }));
    mmCard.append(fieldLabel("模型", modelInput));
  } else {
    const modelSelect = el("select");
    const blank = el("option", "", "选择模型");
    blank.value = "";
    modelSelect.append(blank);
    for (const name of provider?.models || []) {
      const option = el("option", "", name);
      option.value = name;
      modelSelect.append(option);
    }
    const custom = el("option", "", "自定义…");
    custom.value = "__custom";
    modelSelect.append(custom);
    modelSelect.disabled = modelsDisabled;
    modelSelect.value = modelsDisabled ? "" : choice.select;
    modelSelect.addEventListener("change", () => {
      if (modelSelect.value === "__custom") handlers.onMultimodal?.({ customModel: true, model: choice.custom || "" });
      else handlers.onMultimodal?.({ customModel: false, model: modelSelect.value });
    });
    mmCard.append(fieldLabel("模型", modelSelect));
    if (!modelsDisabled && choice.select === "__custom") {
      const customInput = el("input");
      customInput.type = "text";
      customInput.value = choice.custom;
      customInput.spellcheck = false;
      customInput.addEventListener("input", () => handlers.onMultimodal?.({ customModel: true, model: customInput.value }, { live: true }));
      customInput.addEventListener("change", () => handlers.onMultimodal?.({ customModel: true, model: customInput.value }, { live: false }));
      mmCard.append(fieldLabel("自定义模型", customInput));
    }
  }

  const base = el("input");
  base.type = "text";
  base.value = mm.baseUrl;
  base.disabled = !provider;
  base.spellcheck = false;
  base.placeholder = provider?.baseUrlRequired ? "必填" : (provider?.baseUrl || "");
  base.addEventListener("input", () => handlers.onMultimodal?.({ baseUrl: base.value }, { live: true }));
  base.addEventListener("change", () => handlers.onMultimodal?.({ baseUrl: base.value }, { live: false }));
  const baseLabel = fieldLabel("Base URL", base);
  if (provider?.baseUrlRequired) baseLabel.append(el("span", "oi-set-required", "必填"));
  mmCard.append(baseLabel);
  mmCard.append(testButton("mm", multimodalTestDisabled(stored), busy === "mm", handlers.onTest));
  if (!tier2SwitchState(stored).visible) mmCard.append(el("p", "oi-set-empty", FORMULA_MM_EMPTY));
  mmCard.append(el("p", "oi-set-notice", ASK_PRIVACY));
  root.append(mmCard);

  const ocrCard = el("section", "oi-set-card");
  ocrCard.setAttribute("data-formula-card", "ocr");
  const ocrHead = el("div", "oi-set-card-head");
  ocrHead.append(el("h3", "oi-set-card-title", "OCR"));
  const ocrChip = chip(stored.ocr.probe);
  if (ocrChip) ocrHead.append(ocrChip);
  ocrCard.append(ocrHead);
  const ocrSelect = providerSelect(OCR_PROVIDERS, stored.ocr.provider, (value) => handlers.onOcr?.({ provider: value }));
  ocrCard.append(fieldLabel("服务商", ocrSelect));
  const ocrSpec = ocrProvider(stored.ocr.provider);
  const ocrKey = keyField(
    stored.ocr.apiKey,
    (value) => handlers.onOcr?.({ apiKey: value }),
    () => handlers.onRemove?.("ocr"),
    ocrSpec ? `粘贴 ${ocrSpec.label} 密钥` : "先选厂商",
    !ocrSpec,
    "ocr"
  );
  ocrCard.append(fieldLabel("API 密钥", ocrKey));
  ocrCard.append(testButton("ocr", ocrTestDisabled(stored), busy === "ocr", handlers.onTest));
  for (const line of failureLines(stored.ocr.probe)) ocrCard.append(line);
  ocrCard.append(el("p", "oi-set-note", FORMULA_OCR_NOTE));
  root.append(ocrCard);

  const switches = el("section", "oi-set-card");
  switches.setAttribute("data-formula-card", "switches");
  switches.append(el("h3", "oi-set-card-title", "公式回退"));
  const list = el("div", "oi-set-switches");
  renderFormulaSwitchList(list, stored, handlers);
  switches.append(list);
  root.append(switches);
}

export function focusFormulaCard(root, target) {
  const card = root?.querySelector?.(`[data-formula-card="${target === "ocr" ? "ocr" : "mm"}"]`);
  if (!card) return;
  card.scrollIntoView?.({ block: "center" });
  const fields = [...card.querySelectorAll("input, select")];
  const empty = fields.find((field) => !field.disabled && !String(field.value || "").trim());
  (empty || fields[0])?.focus?.();
}
