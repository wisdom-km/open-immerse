const KEY = "oiLearning";

export async function listItems() {
  const data = await chrome.storage.local.get(KEY);
  return data[KEY]?.items || [];
}

export async function saveItem(input) {
  const items = await listItems();
  const now = Date.now();
  const item = {
    id: crypto.randomUUID(),
    type: input.type || detectType(input.original),
    original: String(input.original || "").trim(),
    translation: String(input.translation || "").trim(),
    context: String(input.context || "").trim(),
    url: input.url || "",
    title: input.title || "",
    createdAt: now,
    reps: 0,
    ease: 2.5,
    interval: 0,
    nextReview: now
  };
  if (!item.original) throw new Error("缺少原文");
  const exists = items.find((x) => x.original === item.original && x.translation === item.translation);
  if (exists) return exists;
  items.unshift(item);
  await chrome.storage.local.set({ [KEY]: { items } });
  return item;
}

export async function removeItem(id) {
  const items = (await listItems()).filter((x) => x.id !== id);
  await chrome.storage.local.set({ [KEY]: { items } });
}

export async function reviewItem(id, grade) {
  const items = await listItems();
  const item = items.find((x) => x.id === id);
  if (!item) return;
  const q = Math.max(0, Math.min(5, Number(grade)));
  item.ease = Math.max(1.3, item.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  if (q < 3) {
    item.reps = 0;
    item.interval = 1;
  } else {
    item.reps += 1;
    item.interval = item.reps === 1 ? 1 : item.reps === 2 ? 3 : Math.round(item.interval * item.ease);
  }
  item.nextReview = Date.now() + item.interval * 24 * 60 * 60 * 1000;
  await chrome.storage.local.set({ [KEY]: { items } });
  return item;
}

export function dueItems(items) {
  const now = Date.now();
  return items.filter((x) => x.nextReview <= now);
}

function detectType(text) {
  const t = String(text || "").trim();
  const words = t.split(/\s+/).length;
  if (words <= 2 && t.length <= 24) return "word";
  if (words <= 8 && t.length <= 80) return "phrase";
  return "sentence";
}
