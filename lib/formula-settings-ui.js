/**
 * Settings and Aa controls for the formula fallback chain.
 * DOM only. Storage and probe rules live in formula-settings.js.
 */

import { ASK_ALSO_LINE, ASK_PRIVACY } from "./ask-route.js";
import { bindSecretInput } from "./secret-field.js";
import {
  CUSTOM_BASE_URL_ERROR,
  EMPTY_KEY_HINT,
  FORMULA_ARK_BASE_NOTE,
  FORMULA_BASE_URL_NOTE,
  FORMULA_MM_EMPTY,
  FORMULA_OCR_NOTE,
  FORMULA_ORDER,
  FORMULA_PRIVACY_NOTE,
  FORMULA_SWITCH_COPY,
  FORMULA_SWITCH_KEYS,
  MULTIMODAL_PROVIDERS,
  MM_PRESET_GENERATION,
  OCR_PROVIDERS,
  clipProbeSummary,
  customBaseUrlError,
  formulaOrderText,
  isProvenVisionProvider,
  modelChoice,
  multimodalProvider,
  multimodalTestDisabled,
  normalizeFormulaSettings,
  ocrProvider,
  ocrSwitchState,
  ocrTestDisabled,
  probeChipText,
  probeChipTone,
  probeClock,
  probeExplanation,
  redactProbeText,
  tier2SwitchState,
  tierActive
} from "./formula-settings.js";

let hostDocument = null;

function el(tag, className, text) {
  const node = (hostDocument || document).createElement(tag);
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
  const text = probeChipText(probe);
  if (!text) return null;
  return el("span", probeChipTone(probe), text);
}

function visibleSummary(summary, key) {
  return clipProbeSummary(redactProbeText(summary, key));
}

function withHost(root, paint) {
  const previous = hostDocument;
  hostDocument = root?.ownerDocument || previous;
  try {
    return paint();
  } finally {
    hostDocument = previous;
  }
}

function failureLines(probe, key, which) {
  if (!probe || probe.ok || probe.code === "aborted" || probe.code === "pending") return [];
  const clock = probeClock(probe.at);
  const reason = el("p", "oi-set-fail", `最近失败 · ${probe.chip}${clock ? ` · ${clock}` : ""}`);
  const lines = [reason, el("p", "oi-set-fail-note", "失败的公式已改用后面的级别")];
  const summary = visibleSummary(probe.summary, key);
  if (summary) lines.push(el("p", "oi-set-fail-raw", summary));
  for (const line of lines) line.setAttribute("data-probe-fail", which);
  return lines;
}

function probeNote(card, probe, key) {
  const note = probeExplanation(probe, key);
  if (!note) return;
  const line = el("p", "oi-set-probe-summary", note);
  line.setAttribute("data-probe-summary", "1");
  card.append(line);
}

function keyField(value, onCommit, onRemove, placeholder, disabled, slot, markSaved) {
  const row = el("div", "oi-set-key");
  row.setAttribute("data-key-row", "1");
  if (slot) row.setAttribute("data-key-slot", slot);
  const input = el("input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("data-secret", "1");
  input.setAttribute("aria-label", "API 密钥");
  input.placeholder = placeholder || "粘贴密钥";
  input.disabled = disabled === true;
  let current = value || "";
  const bound = bindSecretInput(input, {
    getValue: () => current,
    onClear: () => onRemove?.()
  });
  input.addEventListener("blur", () => {
    const result = bound.commit();
    if (result.ignored || result.invalid) return;
    current = result.value;
    bound.paint();
    onCommit?.(result.value);
    bound.showSaved();
  });
  const saved = el("span", "oi-set-saved");
  saved.setAttribute("data-secret-saved", "1");
  row.append(bound.root, saved);
  bound.paint();
  if (markSaved) bound.showSaved();
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
  return withHost(container, () => renderFormulaSwitchListNow(container, settings, handlers));
}

function renderFormulaSwitchListNow(container, settings, handlers = {}) {
  const stored = normalizeFormulaSettings(settings);
  container.replaceChildren();
  const tier2 = tier2SwitchState(stored);
  if (!tier2.visible) {
    container.append(hiddenSwitchRow(tier2, handlers.onConfigure));
    for (const line of failureLines(stored.multimodal.probe, stored.multimodal.apiKey, "multimodal")) container.append(line);
  } else {
    const extra = [el("p", "oi-set-notice", FORMULA_PRIVACY_NOTE), ...failureLines(stored.multimodal.probe, stored.multimodal.apiKey, "multimodal")];
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
      failureLines(stored.ocr.probe, stored.ocr.apiKey, "ocr")
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

function listedOptions(select) {
  const fromDom = typeof select?.querySelectorAll === "function" ? [...select.querySelectorAll("option")] : [];
  if (fromDom.length) return fromDom;
  return (select?.childNodes || []).filter((node) => node?.tagName === "OPTION");
}

/** Script selectOption can land on a disabled row. `allow` decides which ids commit. */
export function commitProviderSelect(select, fallback = "", allow = isProvenVisionProvider) {
  const chosen = listedOptions(select).find((option) => option.value === select.value);
  const fallbackValue = allow(fallback) ? fallback : "";
  if (!chosen || chosen.disabled === true || (chosen.value && !allow(chosen.value))) {
    if (select) select.value = fallbackValue;
    return { ok: false, value: "" };
  }
  return { ok: true, value: chosen.value };
}

function providerSelect(list, value, onChange, allow = isProvenVisionProvider) {
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
  const safe = allow(value) ? value : "";
  select.value = safe;
  select.addEventListener("change", () => {
    const picked = commitProviderSelect(select, safe, allow);
    if (!picked.ok) return;
    onChange(picked.value);
  });
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
  return withHost(root, () => renderFormulaPanelNow(root, settings, handlers));
}

function renderFormulaPanelNow(root, settings, handlers = {}) {
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
  probeNote(mmCard, mm.probe, mm.apiKey);
  mmCard.append(el("p", "oi-set-ask", ASK_ALSO_LINE));
  const mmProviderSelect = providerSelect(MULTIMODAL_PROVIDERS, mm.provider, (value) => {
    const spec = multimodalProvider(value);
    // The panel is painted from the live card, so mm.model can be a keystroke
    // that has not been committed. Picking 自定义 must not write that keystroke.
    // The committed card already has the saved model. A preset vendor picks its first model.
    const patch = {
      provider: value,
      customModel: value === "custom",
      baseUrl: value === "custom" ? mm.baseUrl : "",
      presetGeneration: MM_PRESET_GENERATION
    };
    // A preset vendor takes its first model. Custom keeps its own committed
    // model when it is reselected. Coming from another provider starts empty,
    // so that provider's model is not stored on the custom card.
    if (value !== "custom") patch.model = spec?.models?.[0] || "";
    else if (mm.provider !== "custom") patch.model = "";
    handlers.onMultimodal?.(patch);
  });
  mmProviderSelect.disabled = false;
  mmCard.append(fieldLabel("厂家", mmProviderSelect));
  const mmKey = keyField(
    mm.apiKey,
    (value) => handlers.onMultimodal?.({ apiKey: value }),
    () => handlers.onRemove?.("multimodal"),
    provider ? `粘贴 ${provider.label} 密钥` : "先选厂商",
    !provider,
    "mm",
    handlers.savedSlot === "mm"
  );
  mmCard.append(fieldLabel("API 密钥", mmKey));
  if (provider && !String(mm.apiKey || "").trim()) {
    const hint = el("p", "oi-set-note", EMPTY_KEY_HINT);
    hint.setAttribute("data-key-hint", "mm");
    mmCard.append(hint);
  }

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
      if (modelSelect.value === "__custom") {
        handlers.onMultimodal?.({
          customModel: true,
          model: choice.custom || "",
          presetGeneration: MM_PRESET_GENERATION
        });
      } else {
        handlers.onMultimodal?.({
          customModel: false,
          model: modelSelect.value,
          presetGeneration: MM_PRESET_GENERATION
        });
      }
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
  base.setAttribute("data-base-url", "1");
  const urlError = customBaseUrlError(stored);
  if (urlError) base.setAttribute("aria-invalid", "true");
  const baseLabel = fieldLabel("Base URL", base);
  if (provider?.baseUrlRequired) baseLabel.append(el("span", "oi-set-required", "必填"));
  if (urlError) {
    const note = el("p", "oi-set-error", urlError);
    note.setAttribute("data-base-url-error", "1");
    baseLabel.append(note);
  }
  const showUrlError = (empty) => {
    base.setAttribute("aria-invalid", empty ? "true" : "false");
    let note = typeof baseLabel.querySelector === "function"
      ? baseLabel.querySelector("[data-base-url-error]")
      : null;
    if (!note && baseLabel.childNodes) {
      note = [...baseLabel.childNodes].find((node) => node?.attrs?.["data-base-url-error"] || node?.getAttribute?.("data-base-url-error")) || null;
    }
    if (empty) {
      if (!note) {
        note = el("p", "oi-set-error", CUSTOM_BASE_URL_ERROR);
        note.setAttribute("data-base-url-error", "1");
        baseLabel.append(note);
      }
    } else if (note?.remove) {
      note.remove();
    }
  };
  base.addEventListener("input", () => {
    if (provider?.baseUrlRequired) showUrlError(!base.value.trim());
    handlers.onMultimodal?.({ baseUrl: base.value }, { live: true });
  });
  base.addEventListener("change", () => handlers.onMultimodal?.({ baseUrl: base.value }, { live: false }));
  mmCard.append(baseLabel);
  mmCard.append(el("p", "oi-set-note", FORMULA_BASE_URL_NOTE));
  if (provider?.id === "doubao") mmCard.append(el("p", "oi-set-note", FORMULA_ARK_BASE_NOTE));
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
  probeNote(ocrCard, stored.ocr.probe, stored.ocr.apiKey);
  const ocrSelect = providerSelect(OCR_PROVIDERS, stored.ocr.provider, (value) => handlers.onOcr?.({ provider: value }), (id) => {
    const spec = ocrProvider(id);
    return Boolean(spec && spec.vision === true && spec.disabled !== true);
  });
  ocrCard.append(fieldLabel("服务商", ocrSelect));
  const ocrSpec = ocrProvider(stored.ocr.provider);
  const ocrKey = keyField(
    stored.ocr.apiKey,
    (value) => handlers.onOcr?.({ apiKey: value }),
    () => handlers.onRemove?.("ocr"),
    ocrSpec ? `粘贴 ${ocrSpec.label} 密钥` : "先选厂商",
    !ocrSpec,
    "ocr",
    handlers.savedSlot === "ocr"
  );
  ocrCard.append(fieldLabel("API 密钥", ocrKey));
  if (ocrSpec && !String(stored.ocr.apiKey || "").trim()) {
    const hint = el("p", "oi-set-note", EMPTY_KEY_HINT);
    hint.setAttribute("data-key-hint", "ocr");
    ocrCard.append(hint);
  }
  ocrCard.append(testButton("ocr", ocrTestDisabled(stored), busy === "ocr", handlers.onTest));
  for (const line of failureLines(stored.ocr.probe, stored.ocr.apiKey, "ocr")) ocrCard.append(line);
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
