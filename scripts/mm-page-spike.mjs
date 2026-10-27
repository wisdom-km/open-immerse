/**
 * Day-1 page JSON spike. Keys stay in the environment and are never printed.
 * Ark is the default host. Moonshot is the backup.
 *
 *   MM_PAGE_ARK_API_KEY / MM_PAGE_ARK_MODEL / MM_PAGE_ARK_BASE_URL
 *   MM_PAGE_MOONSHOT_API_KEY / MM_PAGE_MOONSHOT_MODEL / MM_PAGE_MOONSHOT_BASE_URL
 *   MM_DPO_KIMI_API_KEY is the Moonshot key when the Moonshot var is empty.
 *   MM_PAGE_ATTENTION_PDF / MM_PAGE_LANCET_PDF point at local page-1 rasters
 *   already rendered to PNG. This script does not download papers.
 *
 * A missing key or a missing page PNG is "not executed", not a model verdict.
 * Writes counts only to /tmp/mm-page-spike.json. No key and no page text.
 */
import { readFile, writeFile } from "node:fs/promises";
import { MM_PAGE_SPIKE_HOSTS, runMmPage } from "../lib/mm-page.js";
import { multimodalTarget, sendVision } from "../lib/mm-client.js";

const outPath = "/tmp/mm-page-spike.json";

function host(name) {
  const preset = MM_PAGE_SPIKE_HOSTS[name];
  const upper = name === "ark" ? "ARK" : "MOONSHOT";
  const key = process.env[`MM_PAGE_${upper}_API_KEY`]
    || (name === "moonshot" ? process.env.MM_DPO_KIMI_API_KEY : "")
    || "";
  return {
    name,
    key: String(key || "").trim(),
    model: process.env[`MM_PAGE_${upper}_MODEL`] || preset.model,
    baseUrl: process.env[`MM_PAGE_${upper}_BASE_URL`] || preset.baseUrl
  };
}

async function png(path) {
  if (!path) return "";
  try {
    const bytes = await readFile(path);
    return Buffer.from(bytes).toString("base64");
  } catch {
    return "";
  }
}

function summarize(parsed) {
  const blocks = parsed?.page?.blocks || [];
  const labels = [...new Set(blocks.map((block) => block.label))].sort();
  const withBbox = blocks.filter((block) => Array.isArray(block.bbox)).length;
  const orders = blocks.map((block) => block.order);
  return {
    blocks: blocks.length,
    columns: parsed?.page?.columns || 0,
    labels,
    bbox: withBbox,
    orderContiguous: orders.every((order, index) => order === index + 1),
    formulaLatex: blocks.filter((block) => block.label === "formula" && block.latex).length
  };
}

async function probe(row, image, pageName) {
  if (!row.key) return { host: row.name, page: pageName, skipped: "no-key" };
  if (!image) return { host: row.name, page: pageName, skipped: "no-png" };
  const target = multimodalTarget({
    multimodal: { provider: "kimi", model: row.model, baseUrl: row.baseUrl, apiKey: "present" }
  });
  const started = Date.now();
  const result = await runMmPage({
    pngBase64: image,
    text: "",
    page: 1,
    columns: pageName === "lancet" ? 2 : 1,
    target,
    secret: row.key,
    sendVision,
    timeoutMs: 90_000
  });
  const summary = {
    host: row.name,
    page: pageName,
    model: row.model,
    baseHost: (() => { try { return new URL(row.baseUrl).host; } catch { return ""; } })(),
    ms: Date.now() - started,
    ok: result.ok === true,
    reason: result.ok ? "" : (result.reason || "http")
  };
  if (result.ok) Object.assign(summary, summarize(result));
  return summary;
}

const ark = host("ark");
const moonshot = host("moonshot");
const attentionPng = await png(process.env.MM_PAGE_ATTENTION_PNG || "");
const lancetPng = await png(process.env.MM_PAGE_LANCET_PNG || "");
const report = {
  at: new Date().toISOString(),
  arkConfigured: Boolean(ark.key),
  moonshotConfigured: Boolean(moonshot.key),
  attentionPng: Boolean(attentionPng),
  lancetPng: Boolean(lancetPng),
  hosts: []
};

if (!ark.key && !moonshot.key) {
  report.reliable = null;
  report.blocked = "no-key";
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reliable: null, blocked: "no-key", out: outPath }));
  process.exit(2);
}
if (!attentionPng || !lancetPng) {
  report.reliable = null;
  report.blocked = "no-png";
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reliable: null, blocked: "no-png", out: outPath }));
  process.exit(2);
}

for (const page of [["attention", attentionPng], ["lancet", lancetPng]]) {
  const first = await probe(ark, page[1], page[0]);
  report.hosts.push(first);
  if (first.ok !== true) report.hosts.push(await probe(moonshot, page[1], page[0]));
}
const byPage = new Map();
for (const row of report.hosts) {
  if (row.ok === true && row.orderContiguous === true && row.bbox > 0 && row.blocks > 0) byPage.set(row.page, true);
}
report.reliable = byPage.get("attention") === true && byPage.get("lancet") === true;
await writeFile(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  reliable: report.reliable,
  hosts: report.hosts.map((row) => ({
    host: row.host,
    page: row.page,
    ok: row.ok === true,
    reason: row.reason || row.skipped || "",
    blocks: row.blocks || 0
  }))
}));
process.exit(report.reliable ? 0 : 3);
