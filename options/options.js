import { PROVIDER_LIST, getProvider } from "../lib/providers.js";
import { LANGUAGE_OPTIONS } from "../lib/languages.js";
import { FEATURES, resolveFeatures } from "../lib/features.js";

const $ = (id) => document.getElementById(id);
let cachedSettings = { providers: {} };

init();

async function init() {
  fillSelect($("provider"), PROVIDER_LIST.map((p) => ({ value: p.id, label: p.name })));
  fillSelect($("sourceLang"), LANGUAGE_OPTIONS.map((l) => ({ value: l.code, label: l.label })));
  fillSelect(
    $("targetLang"),
    LANGUAGE_OPTIONS.filter((l) => l.code !== "auto").map((l) => ({ value: l.code, label: l.label }))
  );

  const res = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  cachedSettings = res.settings || { providers: {} };
  const features = resolveFeatures(cachedSettings);
  $("provider").value = cachedSettings.provider;
  $("sourceLang").value = cachedSettings.sourceLang;
  $("targetLang").value = cachedSettings.targetLang;
  $("batchSize").value = cachedSettings.batchSize;
  $("translationStyle").value = cachedSettings.translationStyle;
  $("fontScale").value = cachedSettings.fontScale;
  $("skipCode").checked = cachedSettings.skipCode;
  $("siteRules").value = (cachedSettings.siteRules || []).map((r) => r.host).join("\n");
  $("featureList").innerHTML = FEATURES.map((feat) => {
    const on = features[feat.id] ? "checked" : "";
    return (
      '<label class="check"><input type="checkbox" data-feat="' +
      feat.id +
      '" ' +
      on +
      " /> " +
      escapeHtml(feat.label) +
      " - " +
      escapeHtml(feat.hint) +
      "</label>"
    );
  }).join("");
  renderProviderFields();
  $("provider").addEventListener("change", () => {
    harvestVisibleProvider();
    renderProviderFields();
  });
  $("save").addEventListener("click", () => persist());
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
  const root = $("providerFields");
  root.innerHTML = "";
  const provider = getProvider($("provider").value);
  const cfg = (cachedSettings.providers || {})[provider.id] || {};
  const card = document.createElement("div");
  card.className = "provider-card";
  const title = document.createElement("h3");
  title.textContent = provider.name;
  card.appendChild(title);
  if (!provider.fields.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "This engine does not need extra keys.";
    card.appendChild(empty);
  }
  provider.fields.forEach((field) => {
    const wrap = document.createElement("label");
    wrap.textContent = field.label;
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
    input.value = cfg[field.key] == null ? "" : cfg[field.key];
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
  const siteRules = $("siteRules")
    .value.split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((host) => ({ host: host.replace(/^www\./, ""), auto: true }));

  const patch = {
    provider: $("provider").value,
    sourceLang: $("sourceLang").value,
    targetLang: $("targetLang").value,
    batchSize: Number($("batchSize").value) || 8,
    translationStyle: $("translationStyle").value,
    fontScale: Number($("fontScale").value) || 0.95,
    skipCode: $("skipCode").checked,
    hoverEnabled: Boolean(features.hover),
    showFab: features.fab !== false,
    subtitleEnabled: Boolean(features.youtube || features.x),
    features: features,
    siteRules: siteRules,
    providers: cachedSettings.providers
  };

  await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: patch });
  $("status").textContent = "Saved";
  setTimeout(() => {
    $("status").textContent = "";
  }, 1600);
}

function fillSelect(select, items) {
  select.innerHTML = "";
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, """)
    .replace(/'/g, "&#39;");
}
