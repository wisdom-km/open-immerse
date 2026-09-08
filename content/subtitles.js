let subOn = false;
let lastLine = "";
let overlay;

window.addEventListener("oi-toggle-subtitles", () => {
  subOn = !subOn;
  if (subOn) startSubtitles();
  else hideOverlay();
});

initSubtitles();

async function initSubtitles() {
  const { settings } = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  const host = location.hostname;
  const isVideoSite = /youtube\.com|youtu\.be|x\.com|twitter\.com/.test(host);
  const rule = (settings.siteRules || []).find((r) => host.endsWith(r.host));
  if (settings.subtitleEnabled || rule?.subtitle || isVideoSite) {
    subOn = Boolean(settings.subtitleEnabled || rule?.subtitle);
    if (subOn || isVideoSite) observeCaptions();
  }
}

function startSubtitles() {
  subOn = true;
  observeCaptions();
  ensureOverlay();
  overlay.querySelector(".oi-cap-hint").textContent = "字幕已开。YouTube / X 请先打开原始字幕。";
}

function observeCaptions() {
  const root = document.body;
  if (!root || root.dataset.oiCap === "1") return;
  root.dataset.oiCap = "1";
  const obs = new MutationObserver(() => {
    if (!subOn && !/youtube|x\.com|twitter/.test(location.hostname)) return;
    const line = readCaption();
    if (line && line !== lastLine) {
      lastLine = line;
      renderCaption(line);
    }
  });
  obs.observe(root, { childList: true, subtree: true, characterData: true });
}

function readCaption() {
  const yt = [...document.querySelectorAll(".ytp-caption-segment")].map((n) => n.textContent).join(" ").trim();
  if (yt) return yt;
  const x = document.querySelector('[data-testid="videoPlayer"] [lang], [data-testid="videoComponent"] p, video + * .css-1jxf684');
  if (x && x.textContent && x.textContent.length < 180) return x.textContent.trim();
  return "";
}

async function renderCaption(original) {
  ensureOverlay();
  overlay.querySelector(".oi-cap-org").textContent = original;
  overlay.querySelector(".oi-cap-dst").textContent = "翻译中…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "OI_TRANSLATE_BATCH", texts: [original] });
    overlay.querySelector(".oi-cap-dst").textContent = res.translations?.[0] || "";
  } catch (err) {
    overlay.querySelector(".oi-cap-dst").textContent = String(err.message || err);
  }
}

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "oi-caption";
  overlay.innerHTML = `<div class="oi-cap-hint"></div><div class="oi-cap-org"></div><div class="oi-cap-dst"></div>`;
  document.documentElement.appendChild(overlay);
  return overlay;
}

function hideOverlay() {
  overlay?.remove();
  overlay = null;
  lastLine = "";
}
