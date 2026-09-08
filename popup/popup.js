import { PROVIDER_LIST, LANGUAGE_OPTIONS } from "../lib/providers.js";

const $ = (id) => document.getElementById(id);

init();

async function init() {
  fillSelect($("provider"), PROVIDER_LIST.map((p) => ({ value: p.id, label: p.name })));
  fillSelect($("sourceLang"), LANGUAGE_OPTIONS.map((l) => ({ value: l.code, label: l.label })));
  fillSelect($("targetLang"), LANGUAGE_OPTIONS.filter((l) => l.code !== "auto").map((l) => ({ value: l.code, label: l.label })));

  const { settings } = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  $("enabled").checked = Boolean(settings.enabled);
  $("hoverEnabled").checked = Boolean(settings.hoverEnabled);
  $("showFab").checked = settings.showFab !== false;
  $("provider").value = settings.provider;
  $("sourceLang").value = settings.sourceLang;
  $("targetLang").value = settings.targetLang;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = hostOf(tab?.url);
  const rule = (settings.siteRules || []).find((r) => host === r.host || host.endsWith("." + r.host));
  $("autoSite").checked = Boolean(rule?.auto);

  $("enabled").addEventListener("change", async () => {
    const enabled = $("enabled").checked;
    await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled } });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: enabled ? "OI_START" : "OI_STOP" }).catch(() => {});
  });

  $("autoSite").addEventListener("change", async () => {
    if (!host) return;
    await chrome.runtime.sendMessage({
      type: "OI_TOGGLE_SITE_RULE",
      host,
      rule: { auto: $("autoSite").checked }
    });
  });

  for (const id of ["hoverEnabled", "showFab", "provider", "sourceLang", "targetLang"]) {
    $(id).addEventListener("change", () =>
      chrome.runtime.sendMessage({
        type: "OI_SAVE_SETTINGS",
        patch: {
          hoverEnabled: $("hoverEnabled").checked,
          showFab: $("showFab").checked,
          provider: $("provider").value,
          sourceLang: $("sourceLang").value,
          targetLang: $("targetLang").value
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
  select.innerHTML = items.map((item) => `<option value="${item.value}">${escapeHtml(item.label)}</option>`).join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&", "<": "<", ">": ">", '"': """, "'": "&#39;" }[c]));
}
