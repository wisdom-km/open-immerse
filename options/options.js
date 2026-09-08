import { PROVIDER_LIST, LANGUAGE_OPTIONS } from "../lib/providers.js";

const $ = (id) => document.getElementById(id);

init();

async function init() {
  fillSelect($("provider"), PROVIDER_LIST.map((p) => ({ value: p.id, label: p.name })));
  fillSelect($("sourceLang"), LANGUAGE_OPTIONS.map((l) => ({ value: l.code, label: l.label })));
  fillSelect($("targetLang"), LANGUAGE_OPTIONS.filter((l) => l.code !== "auto").map((l) => ({ value: l.code, label: l.label })));

  const { settings } = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  $("provider").value = settings.provider;
  $("sourceLang").value = settings.sourceLang;
  $("targetLang").value = settings.targetLang;
  $("batchSize").value = settings.batchSize;
  $("translationStyle").value = settings.translationStyle;
  $("fontScale").value = settings.fontScale;
  $("skipCode").checked = settings.skipCode;
  $("hoverEnabled").checked = settings.hoverEnabled;
  renderProviderFields(settings);
  $("save").addEventListener("click", () => persist());
}

function renderProviderFields(settings) {
  const root = $("providerFields");
  root.innerHTML = "";
  for (const provider of PROVIDER_LIST) {
    const card = document.createElement("div");
    card.className = "provider-card";
    const cfg = settings.providers?.[provider.id] || {};
    card.innerHTML = `<h3>${escapeHtml(provider.name)}</h3>`;
    for (const field of provider.fields) {
      const wrap = document.createElement("label");
      wrap.textContent = field.label;
      let input;
      if (field.type === "textarea") input = document.createElement("textarea");
      else if (field.type === "select") {
        input = document.createElement("select");
        input.innerHTML = (field.options || []).map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join("");
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
}

async function persist() {
  const providers = {};
  for (const input of document.querySelectorAll("[data-provider]")) {
    const id = input.dataset.provider;
    providers[id] = providers[id] || {};
    providers[id][input.dataset.key] = input.type === "checkbox" ? input.checked : input.value;
  }
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
      hoverEnabled: $("hoverEnabled").checked,
      providers
    }
  });
  $("status").textContent = "已保存";
  setTimeout(() => ($("status").textContent = ""), 1600);
}

function fillSelect(select, items) {
  select.innerHTML = items.map((item) => `<option value="${item.value}">${escapeHtml(item.label)}</option>`).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
