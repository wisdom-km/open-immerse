import { PROVIDER_LIST, getProvider } from "../lib/providers.js";
import { LANGUAGE_OPTIONS } from "../lib/languages.js";
import { FEATURES, resolveFeatures } from "../lib/features.js";

const $ = (id) => document.getElementById(id);
let cachedSettings = { providers: {} };

init();

async function init() {
  fillSelect($("provider"), PROVIDER_LIST.map((p) => ({ value: p.id, label: p.name })));
  fillSelect($("sourceLang"), LANGUAGE_OPTIONS.map((l) => ({ value: l.code, label: l.label })));
  fillSelect($("targetLang"), LANGUAGE_OPTIONS.filter((l) => l.code !== "auto").map((l) => ({ value: l.code, label: l.label })));

  const { settings } = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  cachedSettings = settings;
  const features = resolveFeatures(settings);
  $("provider").value = settings.provider;
  $("sourceLang").value = settings.sourceLang;
  $("targetLang").value = settings.targetLang;
  $("batchSize").value = settings.batchSize;
  $("translationStyle").value = settings.translationStyle;
  $("fontScale").value = settings.fontScale;
  $("skipCode").checked = settings.skipCode;
  $("siteRules").value = (settings.siteRules || []).map((r) => r.host).join("\n");
  $("featureList").innerHTML = FEATURES.map((feat) => `
    <label class="check">
      <input type="checkbox" data-feat="${feat.id}" ${features[feat.id] ? "checked" : ""} />
      ${escapeHtml(feat.label)} — ${escapeHtml(feat.hint)}
    </label>
  `).join("");
  renderProviderFields();
  $("provider").addEventListener("change", () => {
    harvestVisibleProvider();
    renderProviderFields();
  });
  $("save").addEventListener("click", () => persist());
}

function harvestVisibleProvider() {
  const providers = { ...(cachedSettings.providers || {}) };
  for (const input of document.querySelectorAll("[data-provider]")) {
    const id = input.dataset.provider;
    providers[id] = { ...(providers[id] || {}) };
    providers[id][input.dataset.key] = input.type === "checkbox" ? input.checked : input.value;
  }
  cachedSettings.providers = providers;
}

function renderProviderFields() {
  const root = $("providerFields");
  root.innerHTML = "";
  const id = $("provider").value;
  const provider = getProvider(id);
  const cfg = cachedSettings.providers?.[provider.id] || {};
  const card = document.createElement("div");
  card.className = "provider-card";
  card.innerHTML = `<h3>${escapeHtml(provider.name)}</h3>`;
  if (!provider.fields.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "这家引擎不需要额外密钥。";
    card.appendChild(empty);
  }
  for (const field of provider.fields) {
    const wrap = document.createElement("label");
    wrap.textContent = field.label;
    let input;
    if (field.type === "textarea") input = document.createElement("textarea");
    else if (field.type === "select") {
      input = document.createElement("select");
      input.innerHTML = (field.options || []).map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("");
    } else {
      input = document.createElement("input");
      input.type = field.type || "text";
    }
    input.dataset.provider = provider.id;
    input.dataset.key = field.key;
    if (field.placeholder) input.placeholder = field.placeholder;
    input.value = cfg[field.key] ?? "";
    wrap.appendChild(input);
    card.appendChild(wrap);
  }
  root.appendChild(card);
}

async function persist() {
  harvestVisibleProvider();
  const features = {};
  for (const input of document.querySelectorAll("[data-feat]")) {
    features[input.dataset.feat] = input.checked;
  }
  const siteRules = $("siteRules").value.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((host) => ({
    host: host.replace(/^www\./, ""),
    auto: true
  }));
  await chrome.runtime.sendMessage({
    type: "OI_SAVE_SETTINGS",
    patch: {
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
      features,
      siteRules,
      providers: cachedSettings.providers
    }
  });
  $("status").textContent = "已保存";
  setTimeout(() => ($("status").textContent = ""), 1600);
}

function fillSelect(select, items) {
  select.innerHTML = items.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "\u0026amp;")
    .replaceAll("<", "\u0026lt;")
    .replaceAll(">", "\u0026gt;")
    .replaceAll('"', "\u0026quot;")
    .replaceAll("'", "\u0026#39;");
}
