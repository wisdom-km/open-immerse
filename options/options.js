import { PROVIDER_LIST, getProvider } from "../lib/providers.js";
import { LANGUAGE_OPTIONS } from "../lib/languages.js";
import { FEATURES, resolveFeatures } from "../lib/features.js";

function el(id) {
  return document.getElementById(id);
}

let cachedSettings = { providers: {} };

init();

async function init() {
  fillSelect(el("provider"), PROVIDER_LIST.map((p) => ({ value: p.id, label: p.name })));
  fillSelect(el("sourceLang"), LANGUAGE_OPTIONS.map((l) => ({ value: l.code, label: l.label })));
  fillSelect(
    el("targetLang"),
    LANGUAGE_OPTIONS.filter((l) => l.code !== "auto").map((l) => ({ value: l.code, label: l.label }))
  );

  const res = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  cachedSettings = res.settings || { providers: {} };
  const features = resolveFeatures(cachedSettings);
  el("provider").value = cachedSettings.provider || "mymemory";
  el("sourceLang").value = cachedSettings.sourceLang || "auto";
  el("targetLang").value = cachedSettings.targetLang || "zh-CN";
  el("batchSize").value = cachedSettings.batchSize || 8;
  el("translationStyle").value = cachedSettings.translationStyle || "under";
  el("fontScale").value = cachedSettings.fontScale || 0.95;
  el("skipCode").checked = Boolean(cachedSettings.skipCode);
  el("siteRules").value = (cachedSettings.siteRules || []).map((r) => r.host).join("\n");
  renderFeatures(features);
  renderProviderFields();
  el("provider").addEventListener("change", () => {
    harvestVisibleProvider();
    renderProviderFields();
  });
  el("save").addEventListener("click", () => persist());
}

function renderFeatures(features) {
  const box = el("featureList");
  box.textContent = "";
  FEATURES.forEach((feat) => {
    const label = document.createElement("label");
    label.className = "check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.feat = feat.id;
    input.checked = Boolean(features[feat.id]);
    label.appendChild(input);
    label.appendChild(document.createTextNode(" " + feat.label + " - " + feat.hint));
    box.appendChild(label);
  });
}

function harvestVisibleProvider() {
  const providers = Object.assign({}, cachedSettings.providers || {});
  document.querySelectorAll("[data-provider]").forEach((input) => {
    const id = input.dataset.provider;
    providers[id] = Object.assign({}, providers[id] || {});
    providers[id][input.dataset.key] = input.type === "checkbox" ? input.checked : input.value;
  });
  cachedSettings.providers = providers;
}

function renderProviderFields() {
  const root = el("providerFields");
  root.textContent = "";
  const provider = getProvider(el("provider").value);
  const cfg = (cachedSettings.providers || {})[provider.id] || {};
  const card = document.createElement("div");
  card.className = "provider-card";
  const title = document.createElement("h3");
  title.textContent = provider.name;
  card.appendChild(title);
  provider.fields.forEach((field) => {
    const wrap = document.createElement("label");
    wrap.appendChild(document.createTextNode(field.label));
    let input;
    if (field.type === "textarea") {
      input = document.createElement("textarea");
    } else if (field.type === "select") {
      input = document.createElement("select");
      (field.options || []).forEach((opt) => {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        input.appendChild(option);
      });
    } else {
      input = document.createElement("input");
      input.type = field.type || "text";
    }
    input.dataset.provider = provider.id;
    input.dataset.key = field.key;
    if (field.placeholder) input.placeholder = field.placeholder;
    input.value = cfg[field.key] == null ? "" : String(cfg[field.key]);
    wrap.appendChild(input);
    card.appendChild(wrap);
  });
  root.appendChild(card);
}

async function persist() {
  harvestVisibleProvider();
  const features = {};
  document.querySelectorAll("[data-feat]").forEach((input) => {
    features[input.dataset.feat] = input.checked;
  });
  const siteRules = el("siteRules")
    .value.split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((host) => ({ host: host.replace(/^www\./, ""), auto: true }));

  const patch = {
    provider: el("provider").value,
    sourceLang: el("sourceLang").value,
    targetLang: el("targetLang").value,
    batchSize: Number(el("batchSize").value) || 8,
    translationStyle: el("translationStyle").value,
    fontScale: Number(el("fontScale").value) || 0.95,
    skipCode: el("skipCode").checked,
    hoverEnabled: Boolean(features.hover),
    showFab: features.fab !== false,
    subtitleEnabled: Boolean(features.youtube || features.x),
    features: features,
    siteRules: siteRules,
    providers: cachedSettings.providers
  };

  await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: patch });
  el("status").textContent = "saved";
  setTimeout(() => {
    el("status").textContent = "";
  }, 1600);
}

function fillSelect(select, items) {
  select.textContent = "";
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  });
}
