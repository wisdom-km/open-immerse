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

/**
 * Secret-like names, compared with case and separators removed.
 * A suffix match keeps `secretly` and `passwordHint` (they do not end with
 * the credential word) and keeps a bare `token`, `key`, `tokenLimit`, or `tokenizer`.
 */
const SECRET_SUFFIXES = [
  "clientsecret",
  "cloudapikey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "privatekey",
  "subscriptionkey",
  "password",
  "authorization",
  "bearer",
  "secrets",
  "secret"
];

function isSecretName(key) {
  const name = String(key || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (!name || name === "token" || name === "key" || name === "keys") return false;
  if (name === "oiproviderattention") return true;
  return SECRET_SUFFIXES.some((suffix) => name === suffix || name.endsWith(suffix));
}

function containsSecretValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(containsSecretValue);
  if (value && typeof value === "object") return Object.values(value).some(containsSecretValue);
  return false;
}

/** Drop key-like names at any depth. Non-secret siblings stay. */
export function stripSecretFields(value) {
  if (Array.isArray(value)) return value.map((item) => stripSecretFields(item));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretName(key)) continue;
    out[key] = stripSecretFields(child);
  }
  return out;
}

export function fileHadSecrets(settings) {
  if (Array.isArray(settings)) return settings.some(fileHadSecrets);
  if (!settings || typeof settings !== "object") return false;
  for (const [key, child] of Object.entries(settings)) {
    if (isSecretName(key)) {
      if (containsSecretValue(child)) return true;
      continue;
    }
    if (fileHadSecrets(child)) return true;
  }
  return false;
}

/**
 * Keys currently stored. A non-empty local bag wins. Otherwise the sync
 * copy is used, which is where 887ecd2 still keeps keys.
 */
export function mergeLiveSecrets(localSecrets, syncSettings) {
  const local = normalizeSecrets(localSecrets);
  const sync = syncSettings && typeof syncSettings === "object" ? syncSettings : {};
  const providers = {};
  const ids = new Set([...Object.keys(local.providers), ...Object.keys(sync.providers || {})]);
  for (const id of ids) {
    const fromLocal = String(local.providers[id] || "").trim();
    const fromSync = String(sync.providers?.[id]?.apiKey || "").trim();
    const key = fromLocal || fromSync;
    if (key) providers[id] = key;
  }
  const pdf = String(local.pdfCloudApiKey || "").trim() || String(sync.pdfLayout?.cloudApiKey || "").trim();
  return { providers, pdfCloudApiKey: pdf };
}

export async function readLiveSecrets(storage) {
  const localArea = storage?.local;
  const syncArea = storage?.sync;
  if (!localArea || typeof localArea.get !== "function" || !syncArea || typeof syncArea.get !== "function") {
    throw new Error("storage unavailable");
  }
  const [localBag, syncBag] = await Promise.all([
    localArea.get(SECRET_STORAGE_KEY),
    syncArea.get("settings")
  ]);
  return mergeLiveSecrets(localBag?.[SECRET_STORAGE_KEY], syncBag?.settings);
}

function dropEmptyKey(bag, field) {
  if (!bag || typeof bag !== "object") return;
  if (!Object.prototype.hasOwnProperty.call(bag, field)) return;
  if (String(bag[field] ?? "").trim()) return;
  delete bag[field];
}

/**
 * Drop blank key fields so a patch cannot overwrite a stored key with "".
 * A non-empty key is left in place. Explicit clears use the `clear` argument
 * of saveSettings, not an empty string.
 */
export function omitEmptySecretFields(settings) {
  const next = clone(settings);
  delete next.oiProviderAttention;
  if (next.providers && typeof next.providers === "object") {
    for (const cfg of Object.values(next.providers)) dropEmptyKey(cfg, "apiKey");
  }
  dropEmptyKey(next.pdfLayout, "cloudApiKey");
  dropEmptyKey(next.multimodal, "apiKey");
  dropEmptyKey(next.ocr, "apiKey");
  const formula = next.formulaSettings;
  if (formula && typeof formula === "object") {
    dropEmptyKey(formula.multimodal, "apiKey");
    dropEmptyKey(formula.ocr, "apiKey");
  }
  return next;
}

/**
 * Old backgrounds replace `pdfLayout` wholesale. If this patch includes a
 * layout and we already know the cloud key, keep that key on the object so
 * the replace does not drop it. Provider keys are omitted when blank; the
 * old merge keeps the previous provider key.
 */
export function sealSettingsPatch(patch, known = {}) {
  const next = omitEmptySecretFields(patch);
  const knownCloud = String(known.pdfCloudApiKey || "").trim();
  if (next.pdfLayout && typeof next.pdfLayout === "object" && knownCloud && !String(next.pdfLayout.cloudApiKey || "").trim()) {
    next.pdfLayout.cloudApiKey = knownCloud;
  }
  return next;
}

/** Settings import never writes keys. Export uses the same strip. */
export function settingsForExport(settings) {
  const next = stripSecretFields(blankSecrets(settings));
  delete next.oiProviderAttention;
  return next;
}

export function prepareSettingsImport(raw) {
  const settings = raw && typeof raw === "object" ? (raw.settings && typeof raw.settings === "object" ? raw.settings : raw) : {};
  const ignoredKeys = fileHadSecrets(settings);
  const next = stripSecretFields(settings);
  delete next.formulaSettings;
  delete next.oiProviderAttention;
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
