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
  $("provider").value = settings.provider;
  $("sourceLang").value = settings.sourceLang;
  $("targetLang").value = settings.targetLang;

  $("enabled").addEventListener("change", async () => {
    const enabled = $("enabled").checked;
    await chrome.runtime.sendMessage({ type: "OI_SAVE_SETTINGS", patch: { enabled } });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: enabled ? "OI_START" : "OI_STOP" }).catch(() => {});
    }
  });

  for (const id of ["hoverEnabled", "provider", "sourceLang", "targetLang"]) {
    $(id).addEventListener("change", () =>
      chrome.runtime.sendMessage({
        type: "OI_SAVE_SETTINGS",
        patch: {
          hoverEnabled: $("hoverEnabled").checked,
          provider: $("provider").value,
          sourceLang: $("sourceLang").value,
          targetLang: $("targetLang").value
        }
      })
    );
  }

  $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
}

function fillSelect(select, items) {
  select.innerHTML = items.map((item) => `<option value="${item.value}">${escapeHtml(item.label)}</option>`).join("");
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&", "<": "<", ">": ">", '"': """, "'": "&#39;" }[c]));
}
