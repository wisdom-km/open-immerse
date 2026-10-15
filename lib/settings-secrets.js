/**
 * Translation and PDF cloud API keys live in chrome.storage.local.
 * Sync keeps the rest of `settings`. Empty commits do not erase a stored key.
 */

export const SECRET_STORAGE_KEY = "oiSecrets";

export function emptySecrets() {
  return { providers: {}, pdfCloudApiKey: "" };
}

export function normalizeSecrets(raw) {
  const out = emptySecrets();
  const src = raw && typeof raw === "object" ? raw : {};
  const providers = src.providers && typeof src.providers === "object" ? src.providers : {};
  for (const [id, value] of Object.entries(providers)) {
    out.providers[String(id)] = String(value ?? "");
  }
  out.pdfCloudApiKey = String(src.pdfCloudApiKey ?? "");
  return out;
}

export function maskSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length < 8) return "••••";
  return `${text.slice(0, 3)}••••${text.slice(-4)}`;
}

/** Blank or whitespace keeps the previous key. A non-empty value is trimmed. */
export function commitSecret(previous, draft) {
  const next = String(draft ?? "").trim();
  const prev = String(previous ?? "");
  if (!next) return { value: prev, changed: false, empty: true };
  return { value: next, changed: next !== prev, empty: false };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

export function migrateSyncSecrets(settings, secrets) {
  const nextSettings = clone(settings);
  const nextSecrets = normalizeSecrets(secrets);
  let changed = false;
  const providers = nextSettings.providers && typeof nextSettings.providers === "object" ? nextSettings.providers : {};
  nextSettings.providers = providers;
  for (const [id, cfg] of Object.entries(providers)) {
    if (!cfg || typeof cfg !== "object") continue;
    const syncKey = String(cfg.apiKey ?? "").trim();
    if (!syncKey) {
      if (cfg.apiKey) {
        cfg.apiKey = "";
        changed = true;
      }
      continue;
    }
    if (!String(nextSecrets.providers[id] || "").trim()) nextSecrets.providers[id] = syncKey;
    cfg.apiKey = "";
    changed = true;
  }
  if (!nextSettings.pdfLayout || typeof nextSettings.pdfLayout !== "object") {
    nextSettings.pdfLayout = {};
  }
  const cloud = String(nextSettings.pdfLayout.cloudApiKey ?? "").trim();
  if (cloud) {
    if (!String(nextSecrets.pdfCloudApiKey || "").trim()) nextSecrets.pdfCloudApiKey = cloud;
    nextSettings.pdfLayout.cloudApiKey = "";
    changed = true;
  } else if (nextSettings.pdfLayout.cloudApiKey) {
    nextSettings.pdfLayout.cloudApiKey = "";
    changed = true;
  }
  return { settings: nextSettings, secrets: nextSecrets, changed };
}

/** Put local keys back onto a settings object and clear the local bag. */
export function rollbackSyncSecrets(settings, secrets) {
  const nextSettings = clone(settings);
  const bag = normalizeSecrets(secrets);
  nextSettings.providers = nextSettings.providers && typeof nextSettings.providers === "object" ? nextSettings.providers : {};
  for (const [id, key] of Object.entries(bag.providers)) {
    if (!String(key || "").trim()) continue;
    nextSettings.providers[id] = { ...(nextSettings.providers[id] || {}), apiKey: key };
  }
  nextSettings.pdfLayout = { ...(nextSettings.pdfLayout || {}), cloudApiKey: String(bag.pdfCloudApiKey || "") };
  return { settings: nextSettings, secrets: emptySecrets() };
}

export function attachSecrets(settings, secrets) {
  const next = clone(settings);
  const bag = normalizeSecrets(secrets);
  for (const [id, cfg] of Object.entries(next.providers || {})) {
    if (!cfg || typeof cfg !== "object") continue;
    const local = String(bag.providers[id] || "");
    if (local) cfg.apiKey = local;
    else cfg.apiKey = String(cfg.apiKey || "");
  }
  if (!next.pdfLayout || typeof next.pdfLayout !== "object") next.pdfLayout = {};
  const localCloud = String(bag.pdfCloudApiKey || "");
  next.pdfLayout.cloudApiKey = localCloud || String(next.pdfLayout.cloudApiKey || "");
  return next;
}

export function blankSecrets(settings) {
  const next = clone(settings);
  for (const cfg of Object.values(next.providers || {})) {
    if (cfg && typeof cfg === "object") cfg.apiKey = "";
  }
  if (next.pdfLayout && typeof next.pdfLayout === "object") next.pdfLayout.cloudApiKey = "";
  if (next.multimodal && typeof next.multimodal === "object") next.multimodal.apiKey = "";
  if (next.ocr && typeof next.ocr === "object") next.ocr.apiKey = "";
  const formula = next.formulaSettings;
  if (formula && typeof formula === "object") {
    if (formula.multimodal && typeof formula.multimodal === "object") formula.multimodal.apiKey = "";
    if (formula.ocr && typeof formula.ocr === "object") formula.ocr.apiKey = "";
  }
  return next;
}

export function fileHadSecrets(settings) {
  if (!settings || typeof settings !== "object") return false;
  for (const cfg of Object.values(settings.providers || {})) {
    if (cfg && typeof cfg === "object" && String(cfg.apiKey || "").trim()) return true;
  }
  if (String(settings.pdfLayout?.cloudApiKey || "").trim()) return true;
  if (String(settings.multimodal?.apiKey || "").trim()) return true;
  if (String(settings.ocr?.apiKey || "").trim()) return true;
  const formula = settings.formulaSettings;
  if (formula && typeof formula === "object") {
    if (String(formula.multimodal?.apiKey || "").trim()) return true;
    if (String(formula.ocr?.apiKey || "").trim()) return true;
  }
  return false;
}

/** Settings import never writes keys. Export uses the same strip. */
export function settingsForExport(settings) {
  return blankSecrets(settings);
}

export function prepareSettingsImport(raw) {
  const settings = raw && typeof raw === "object" ? (raw.settings && typeof raw.settings === "object" ? raw.settings : raw) : {};
  const ignoredKeys = fileHadSecrets(settings);
  const next = blankSecrets(settings);
  delete next.formulaSettings;
  return { settings: next, ignoredKeys };
}

/**
 * Merge a settings patch into the local secret bag.
 * A blank apiKey in the patch does not erase the stored key.
 * Pass clearProviders / clearPdfCloud to remove a key on purpose.
 */
export function applySecretPatch(previous, patch, clear = {}) {
  const next = normalizeSecrets(previous);
  const providers = patch?.providers;
  if (providers && typeof providers === "object") {
    for (const [id, cfg] of Object.entries(providers)) {
      if (!cfg || typeof cfg !== "object" || !Object.prototype.hasOwnProperty.call(cfg, "apiKey")) continue;
      next.providers[id] = commitSecret(next.providers[id] || "", cfg.apiKey).value;
    }
  }
  if (patch?.pdfLayout && Object.prototype.hasOwnProperty.call(patch.pdfLayout, "cloudApiKey")) {
    next.pdfCloudApiKey = commitSecret(next.pdfCloudApiKey, patch.pdfLayout.cloudApiKey).value;
  }
  for (const id of clear.providers || []) next.providers[id] = "";
  if (clear.pdfCloud) next.pdfCloudApiKey = "";
  return next;
}
