import { PROVIDER_LIST } from "../lib/providers.js";
import { LANGUAGE_OPTIONS } from "../lib/languages.js";
import { FEATURES, resolveFeatures } from "../lib/features.js";

const $ = (id) => document.getElementById(id);

init();

async function init() {
  fillSelect($("provider"), PROVIDER_LIST.map((p) => ({ value: p.id, label: p.name })));
  fillSelect($("sourceLang"), LANGUAGE_OPTIONS.map((l) => ({ value: l.code, label: l.label })));
  fillSelect($("targetLang"), LANGUAGE_OPTIONS.filter((l) => l.code !== "auto").map((l) => ({ value: l.code, label: l.label })));

  const { settings } = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  const features = resolveFeatures(settings);
  $("enabled").checked = Boolean(settings.enabled);
  $("provider").value = settings.provider;
  $("sourceLang").value = settings.sourceLang;
  $("targetLang").value = settings.targetLang;
  $("translateScope").value = settings.translateScope || "page";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = hostOf(tab?.url);
  const rule = (settings.siteRules || []).find((r) => host === r.host || host.endsWith("." + r.host));
  $("autoSite").checked = Boolean(rule?.auto);

  const box = $("featureList");
  box.textContent = "";
  FEATURES.forEach((feat) => {
    const label = document.createElement("label");
    label.className = "feat";
    const span = document.createElement("span");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = feat.label;
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = feat.hint;
    span.appendChild(name);
    span.appendChild(hint);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.feat = feat.id;
    input.checked = Boolean(features[feat.id]);
    label.appendChild(span);
    label.appendChild(input);
    box.appendChild(label);
  });

  $("enabled").addEventListener("change", async () => {
    const enabled = $("enabled").checked;
    await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled } });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: enabled ? "OI_START" : "OI_STOP" }).catch(() => {});
  });

  $("autoSite").addEventListener("change", async () => {
    if (!host) return;
    await chrome.runtime.sendMessage({ type: "OI_TOGGLE_SITE_RULE", host, rule: { auto: $("autoSite").checked } });
  });

  box.addEventListener("change", async (ev) => {
    const input = ev.target.closest("[data-feat]");
    if (!input) return;
    const next = { ...features, [input.dataset.feat]: input.checked };
    await chrome.runtime.sendMessage({
      type: "OI_SAVE_SETTINGS",
      patch: {
        features: next,
        hoverEnabled: next.hover,
        showFab: next.fab,
        subtitleEnabled: next.youtube || next.x
      }
    });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "OI_FEATURES_CHANGED" }).catch(() => {});
  });

  for (const id of ["provider", "sourceLang", "targetLang", "translateScope"]) {
    $(id).addEventListener("change", () =>
      chrome.runtime.sendMessage({
        type: "OI_SAVE_SETTINGS",
        patch: {
          provider: $("provider").value,
          sourceLang: $("sourceLang").value,
          targetLang: $("targetLang").value,
          translateScope: $("translateScope").value
        }
      })
    );
  }

  $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("openLearning").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "learning" }));
  $("openDocs").addEventListener("click", () => chrome.runtime.sendMessage({ type: "OI_OPEN_PAGE", page: "documents" }));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
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
