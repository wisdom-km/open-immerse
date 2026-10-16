/** Per-engine "needs attention" flag. Values are only `true`. Never a key. */

export const PROVIDER_ATTENTION_KEY = "oiProviderAttention";

export function normalizeAttention(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, value] of Object.entries(raw)) {
    if (value === true && String(id)) out[String(id)] = true;
  }
  return out;
}

export async function readProviderAttention(area) {
  if (!area || typeof area.get !== "function") return {};
  const bag = await area.get(PROVIDER_ATTENTION_KEY);
  return normalizeAttention(bag?.[PROVIDER_ATTENTION_KEY]);
}

export async function writeProviderAttention(area, flags) {
  if (!area || typeof area.set !== "function") return;
  await area.set({ [PROVIDER_ATTENTION_KEY]: normalizeAttention(flags) });
}

export async function markProviderAttention(area, providerId) {
  const id = String(providerId || "");
  if (!id) return;
  const flags = await readProviderAttention(area);
  flags[id] = true;
  await writeProviderAttention(area, flags);
}

export async function clearProviderAttention(area, providerId) {
  const id = String(providerId || "");
  if (!id) return;
  const flags = await readProviderAttention(area);
  if (!flags[id]) return;
  delete flags[id];
  await writeProviderAttention(area, flags);
}
