/**
 * Translation and PDF cloud API keys live in chrome.storage.local.
 * Sync keeps the rest of `settings`. Empty commits do not erase a stored key.
 */

export const SECRET_STORAGE_KEY = "oiSecrets";

export function emptySecrets() {
  return { providers: {}, pdfCloudApiKey: "", seq: {}, applied: {}, pending: {} };
}

export function normalizeSecrets(raw) {
  const out = emptySecrets();
  const src = raw && typeof raw === "object" ? raw : {};
  const providers = src.providers && typeof src.providers === "object" ? src.providers : {};
  for (const [id, value] of Object.entries(providers)) {
    out.providers[String(id)] = String(value ?? "");
  }
  out.pdfCloudApiKey = String(src.pdfCloudApiKey ?? "");
  const seq = src.seq && typeof src.seq === "object" ? src.seq : {};
  for (const [id, value] of Object.entries(seq)) {
    const n = Number(value);
    if (id && Number.isFinite(n)) out.seq[String(id)] = n;
  }
  const applied = src.applied && typeof src.applied === "object" ? src.applied : {};
  for (const [id, value] of Object.entries(applied)) {
    const n = Number(value);
    if (id && Number.isFinite(n)) out.applied[String(id)] = n;
  }
  const pending = src.pending && typeof src.pending === "object" ? src.pending : {};
  for (const [id, value] of Object.entries(pending)) {
    if (!value || typeof value !== "object") continue;
    const n = Number(value.seq);
    if (!id || !Number.isFinite(n)) continue;
    out.pending[String(id)] = { seq: n, value: String(value.value ?? ""), sent: value.sent === true };
  }
  return out;
}

const SECRET_BAG_LOCK = "oi-secrets-bag";
let bagDepth = 0;
let bagIdleWaiters = [];

/** Serialize read-modify-write of the one `oiSecrets` bag. Never hold this across sendMessage. */
export function withSecretBagLock(run, options = {}) {
  const exec = async () => {
    bagDepth += 1;
    try {
      return await run();
    } finally {
      bagDepth -= 1;
      if (bagDepth === 0 && bagIdleWaiters.length) {
        const waiters = bagIdleWaiters;
        bagIdleWaiters = [];
        for (const waiter of waiters) Promise.resolve().then(waiter);
      }
    }
  };
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== "function") return exec();
  if (options.ifAvailable) {
    return locks.request(SECRET_BAG_LOCK, { ifAvailable: true }, (lock) => {
      if (!lock) return { skipped: true };
      return exec();
    });
  }
  return locks.request(SECRET_BAG_LOCK, () => exec());
}

export function runAfterSecretBagIdle(run) {
  if (bagDepth === 0) return Promise.resolve().then(run);
  return new Promise((resolve, reject) => {
    bagIdleWaiters.push(() => {
      Promise.resolve().then(run).then(resolve, reject);
    });
  });
}

export function captureEngineSlice(bag, id) {
  const secrets = normalizeSecrets(bag);
  const engine = String(id);
  const hasApplied = Object.prototype.hasOwnProperty.call(secrets.applied, engine);
  return {
    id: engine,
    key: String(secrets.providers[engine] || ""),
    seq: Number(secrets.seq[engine]) || 0,
    applied: hasApplied ? Number(secrets.applied[engine]) || 0 : null,
    pending: secrets.pending[engine]
      ? {
          seq: secrets.pending[engine].seq,
          value: String(secrets.pending[engine].value ?? ""),
          sent: secrets.pending[engine].sent === true
        }
      : null
  };
}

export function restoreEngineSlice(bag, slice) {
  const next = normalizeSecrets(bag);
  if (!slice || !slice.id) return next;
  const id = String(slice.id);
  next.providers[id] = String(slice.key || "");
  if (slice.seq) next.seq[id] = slice.seq;
  else delete next.seq[id];
  if (slice.applied == null) delete next.applied[id];
  else next.applied[id] = slice.applied;
  if (slice.pending) {
    next.pending[id] = {
      seq: slice.pending.seq,
      value: String(slice.pending.value ?? ""),
      sent: slice.pending.sent === true
    };
  }
  else delete next.pending[id];
  return next;
}

export function restoreOwnedWrites(current, writtenSlices, beforeSlices) {
  let next = normalizeSecrets(current);
  let changed = false;
  const writtenById = new Map((writtenSlices || []).map((slice) => [slice.id, slice]));
  for (const before of beforeSlices || []) {
    const written = writtenById.get(before.id);
    if (!written) continue;
    if (JSON.stringify(captureEngineSlice(next, before.id)) !== JSON.stringify(written)) continue;
    next = restoreEngineSlice(next, before);
    changed = true;
  }
  return { secrets: next, changed };
}

/**
 * Decide what a stored bag should do with the key currently sitting in sync.
 * An empty pending entry counts only after it was sent. A reserved removal
 * that never left the page is dropped. A confirmed local key that disagrees
 * with a non-empty sync value is written back, so a late stale sync write
 * cannot be the key translation reads.
 *
 * Interrupt points:
 * 1. Non-empty pending seq greater than applied: keep. Do not write the older
 *    key, and do not label it with the pending seq.
 * 2. Recorded sync seq equal or newer than applied: keep.
 * 3. A real write uses the applied seq, not the reservation seq.
 */
export function decideKeyReconcile(bag, id, syncKey, syncSeq) {
  const secrets = normalizeSecrets(bag);
  const localKey = String(secrets.providers[id] || "");
  const sync = String(syncKey ?? "");
  const pending = secrets.pending[id];
  const applied = Object.prototype.hasOwnProperty.call(secrets.applied, id) ? Number(secrets.applied[id]) || 0 : 0;
  const seq = Math.max(applied, Number(secrets.seq[id]) || 0);
  const pendingUnsentClear = Boolean(pending) && String(pending.value ?? "") === "" && pending.sent !== true;
  const recorded = Number(syncSeq);
  const hasRecorded = Number.isFinite(recorded);
  if (!pendingUnsentClear && pending && sync === String(pending.value ?? "") && Number(pending.seq) >= applied) {
    return { action: "commit", value: sync, seq: Number(pending.seq) };
  }
  if (!pendingUnsentClear && pending && String(pending.value ?? "") === "" && sync) {
    return { action: "clearSync", seq: Number(pending.seq) || 0 };
  }
  if (!localKey && applied > 0 && sync) {
    return { action: "clearSync", seq };
  }
  if (localKey && sync && localKey !== sync && applied > 0) {
    if (pending && String(pending.value ?? "") !== "" && Number(pending.seq) > applied) return { action: "keep" };
    if (hasRecorded && !(applied > recorded)) return { action: "keep" };
    return { action: "writeSync", value: localKey, seq: applied };
  }
  if (pendingUnsentClear) return { action: "dropPending" };
  return { action: "keep" };
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
    if (!String(nextSecrets.providers[id] || "").trim() && !providerKeyRetired(nextSecrets, id)) {
      nextSecrets.providers[id] = syncKey;
    }
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
 * Real settings fields that share a word with a credential but are not keys.
 * Compared after separators are removed.
 */
const SECRET_ALLOW = new Set([
  "token",
  "key",
  "keys",
  "tokenlimit",
  "tokenizer",
  "passwordhint",
  "secretly",
  "maxtokens",
  "accesskey",
  "authorname",
  "secretmode",
  "clientid",
  "cookieconsent",
  "cookiename",
  "oauthscope",
  "oauthclientid",
  "compat"
]);

const SECRET_WORDS = new Set([
  "secret",
  "password",
  "passphrase",
  "credential",
  "bearer",
  "auth",
  "token",
  "authorization",
  "apikey",
  "jwt",
  "cookie",
  "csrf",
  "pat"
]);

const EXACT_SECRET_WORDS = new Set(["oauth"]);

const SECRET_SEQUENCES = [
  ["api", "key"],
  ["private", "key"],
  ["session", "token"],
  ["session", "key"],
  ["signing", "key"],
  ["access", "token"],
  ["subscription", "key"],
  ["encryption", "key"],
  ["master", "key"],
  ["session", "id"],
  ["service", "account", "key"],
  ["aws", "access", "key"]
];

const HOMOGLYPHS = new Map([
  ["\u0430", "a"], ["\u0410", "A"],
  ["\u0435", "e"], ["\u0415", "E"],
  ["\u043e", "o"], ["\u041e", "O"],
  ["\u0440", "p"], ["\u0420", "P"],
  ["\u0441", "c"], ["\u0421", "C"],
  ["\u0443", "y"], ["\u0423", "Y"],
  ["\u0445", "x"], ["\u0425", "X"],
  ["\u0456", "i"], ["\u0406", "I"],
  ["\u0455", "s"],
  ["\u043a", "k"], ["\u041a", "K"],
  ["\u043c", "m"], ["\u041c", "M"],
  ["\u0442", "t"], ["\u0422", "T"]
]);

function foldName(key) {
  const normalized = String(key || "").normalize("NFKC");
  let out = "";
  for (const ch of normalized) out += HOMOGLYPHS.get(ch) || ch;
  return out;
}

const SEQUENCE_WORDS = new Set(SECRET_SEQUENCES.flat());

function nameSegments(key) {
  const spaced = foldName(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2");
  return spaced
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (/^\d+$/.test(lower)) return "";
      if (lower.length > 3 && lower.endsWith("s")) {
        const singular = lower.slice(0, -1);
        if (SECRET_WORDS.has(singular) || SEQUENCE_WORDS.has(singular)) return singular;
      }
      return lower;
    })
    .filter(Boolean);
}

function hasSequence(parts, sequence) {
  for (let i = 0; i <= parts.length - sequence.length; i += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (parts[i + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function allowListed(flat) {
  if (SECRET_ALLOW.has(flat)) return true;
  const stem = flat.replace(/\d+$/, "");
  if (stem === flat || !SECRET_ALLOW.has(stem)) return false;
  if (SECRET_WORDS.has(stem) || EXACT_SECRET_WORDS.has(stem)) return false;
  return true;
}

function exactSecret(flat) {
  if (EXACT_SECRET_WORDS.has(flat)) return true;
  if (flat.length > 3 && flat.endsWith("s") && EXACT_SECRET_WORDS.has(flat.slice(0, -1))) return true;
  return false;
}

/** Whole word, a plural, or an apiKey substring. A name merely ending in "pat" is kept. */
function flatSecret(flat) {
  if (SECRET_WORDS.has(flat)) return true;
  if (flat.length > 3 && flat.endsWith("s") && SECRET_WORDS.has(flat.slice(0, -1))) return true;
  return flat.includes("apikey");
}

function providerKeyRetired(secrets, id) {
  const pending = secrets.pending?.[id];
  if (pending && pending.sent === true && String(pending.value ?? "") === "") return true;
  const applied = secrets.applied || {};
  return Object.prototype.hasOwnProperty.call(applied, id)
    && (Number(applied[id]) || 0) > 0
    && !String(secrets.providers?.[id] || "").trim();
}

function isSecretName(key) {
  const folded = foldName(key);
  const flat = folded.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  if (!flat) return false;
  if (flat === "oiproviderattention") return true;
  if (allowListed(flat)) return false;
  if (exactSecret(flat)) return true;
  if (flatSecret(flat)) return true;
  const parts = nameSegments(folded);
  if (parts.some((part) => SECRET_WORDS.has(part))) return true;
  if (SECRET_SEQUENCES.some((sequence) => hasSequence(parts, sequence))) return true;
  const collapsed = parts.join("");
  if (collapsed && (SECRET_WORDS.has(collapsed) || exactSecret(collapsed))) return true;
  return false;
}

function pruneEmptyObjects(value) {
  if (Array.isArray(value)) return value.map((item) => pruneEmptyObjects(item));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const next = pruneEmptyObjects(child);
    if (next && typeof next === "object" && !Array.isArray(next) && Object.keys(next).length === 0) continue;
    out[key] = next;
  }
  return out;
}

function hasImportValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some((item) => hasImportValue(item));
  if (typeof value === "object") return Object.values(value).some((item) => hasImportValue(item));
  return true;
}

/** True when an imported file still has something to write after keys are removed. */
export function settingsImportHasChanges(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  const rest = { ...settings };
  delete rest.settingsVersion;
  return hasImportValue(rest);
}

function providerSeq(secrets, id) {
  return Number(secrets?.seq?.[id]) || 0;
}

function appliedProviderSeq(secrets, id) {
  if (secrets?.applied && Object.prototype.hasOwnProperty.call(secrets.applied, id)) return Number(secrets.applied[id]) || 0;
  return providerSeq(secrets, id);
}

function acceptsKeySeq(stored, keySeq, id) {
  if (!keySeq || typeof keySeq !== "object" || !Object.prototype.hasOwnProperty.call(keySeq, id)) return true;
  const incoming = Number(keySeq[id]);
  if (!Number.isFinite(incoming)) return true;
  if (!(incoming > appliedProviderSeq(stored, id))) return false;
  const pending = stored?.pending?.[id];
  if (pending && Number(pending.seq) > incoming) return false;
  return true;
}

function noteAcceptedSeq(next, id, keySeq) {
  if (!keySeq || !Object.prototype.hasOwnProperty.call(keySeq, id) || !Number.isFinite(Number(keySeq[id]))) return;
  const incoming = Number(keySeq[id]);
  next.seq[id] = Math.max(providerSeq(next, id), incoming);
  next.applied[id] = incoming;
  if (next.pending[id] && Number(next.pending[id].seq) <= incoming) delete next.pending[id];
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
  const next = pruneEmptyObjects(stripSecretFields(settings));
  delete next.formulaSettings;
  delete next.oiProviderAttention;
  return { settings: next, ignoredKeys };
}

/**
 * Merge a settings patch into the local secret bag.
 * A blank apiKey in the patch does not erase the stored key.
 * Pass clearProviders / clearPdfCloud to remove a key on purpose.
 */
export function applySecretPatch(previous, patch, clear = {}, keySeq = {}) {
  const next = normalizeSecrets(previous);
  const providers = patch?.providers;
  if (providers && typeof providers === "object") {
    for (const [id, cfg] of Object.entries(providers)) {
      if (!cfg || typeof cfg !== "object" || !Object.prototype.hasOwnProperty.call(cfg, "apiKey")) continue;
      if (!acceptsKeySeq(next, keySeq, id)) continue;
      next.providers[id] = commitSecret(next.providers[id] || "", cfg.apiKey).value;
      noteAcceptedSeq(next, id, keySeq);
    }
  }
  if (patch?.pdfLayout && Object.prototype.hasOwnProperty.call(patch.pdfLayout, "cloudApiKey")) {
    next.pdfCloudApiKey = commitSecret(next.pdfCloudApiKey, patch.pdfLayout.cloudApiKey).value;
  }
  for (const id of clear.providers || []) {
    if (!acceptsKeySeq(next, keySeq, id)) continue;
    next.providers[id] = "";
    noteAcceptedSeq(next, id, keySeq);
  }
  if (clear.pdfCloud) next.pdfCloudApiKey = "";
  return next;
}
