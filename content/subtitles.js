let subOn = false;
let lastLine = "";
let overlay;
let observer = null;

window.addEventListener("oi-toggle-subtitles", () => {
  if (!allowedHere()) return;
  subOn = !subOn;
  if (subOn) startSubtitles();
  else stopSubtitles();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "OI_FEATURES_CHANGED") applyFeatureState();
});

initSubtitles();

async function initSubtitles() {
  await applyFeatureState();
}

async function applyFeatureState() {
  if (!allowedHere()) {
    stopSubtitles();
    return;
  }
  const { settings } = await chrome.runtime.sendMessage({ type: "OI_GET_SETTINGS" });
  const on = moduleOn(settings);
  if (on) startSubtitles();
  else stopSubtitles();
}

function moduleOn(settings) {
  const f = settings.features || {};
  if (isYouTube()) return f.youtube === true || settings.subtitleEnabled === true;
  if (isX()) return f.x === true || settings.subtitleEnabled === true;
  return false;
}

function allowedHere() {
  return isYouTube() || isX();
}

function isYouTube() {
  return /youtube\.com|youtu\.be/.test(location.hostname);
}

function isX() {
  return /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname);
}

function startSubtitles() {
  subOn = true;
  observeCaptions();
  ensureOverlay();
  overlay.querySelector(".oi-cap-hint").textContent = isYouTube()
    ? "YouTube 字幕已开，请先打开视频自带字幕"
    : "X 字幕已开，仅当视频已有字幕时叠加译文";
}

function stopSubtitles() {
  subOn = false;
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (document.body) delete document.body.dataset.oiCap;
  hideOverlay();
}

function observeCaptions() {
  const root = document.body;
  if (!root || observer) return;
  root.dataset.oiCap = "1";
  observer = new MutationObserver(() => {
    if (!subOn) return;
    const line = readCaption();
    if (line && line !== lastLine) {
      lastLine = line;
      renderCaption(line);
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
}

function readCaption() {
  if (isYouTube()) {
    return [...document.querySelectorAll(".ytp-caption-segment")].map((n) => n.textContent).join(" ").trim();
  }
  const x = document.querySelector('[data-testid="videoPlayer"] [lang], [data-testid="videoComponent"] p');
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
