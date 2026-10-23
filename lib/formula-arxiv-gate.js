/**
 * Tier-0 session gate. Decision A (Wisdom 2026-10-04, restated 2026-10-19):
 * a missing PDF version downloads the latest source; each formula is checked
 * on its own. A version string is only a cache key, not a reason to drop
 * the paper. Equation numbers are compared after the parentheses are
 * removed, so a source "(1)" cannot land on PDF "(2)".
 */

import { diagLog } from "./diag-log.js";

export function canonicalArxivVersion(version) {
  const raw = String(version ?? "").trim().toLowerCase();
  if (!raw) return "";
  const match = raw.match(/^v?(\d+)$/);
  return match ? `v${match[1]}` : "";
}

export function equationLabelDigits(value) {
  return String(value ?? "").replace(/[()（）]/g, "").trim();
}

/** Both empty agrees. One side numbered and the other not does not. */
export function equationNumbersAgree(row, unit) {
  const source = equationLabelDigits(row?.number);
  const pdf = equationLabelDigits(unit?.equationNumber);
  if (!source && !pdf) return true;
  if (!source || !pdf) return false;
  return source === pdf;
}

export function alignmentReusable(alignment, { id, pdfVersion, pdfSha256 } = {}) {
  if (!alignment || alignment.useSource !== true) return false;
  if (id && alignment.id && String(alignment.id) !== String(id)) return false;
  if (pdfSha256 && alignment.pdfSha256 && String(alignment.pdfSha256) !== String(pdfSha256)) return false;
  return canonicalArxivVersion(pdfVersion) === canonicalArxivVersion(alignment.version);
}

/**
 * Second open reads the saved alignment and does not download or parse.
 * An empty version asks for the latest package (`version: ""`). The download
 * reply's version field is the request echoed by background/arxiv-source.js,
 * not a version read out of the tarball, so it is not compared here.
 * A package whose text differs from this PDF is still aligned; each formula
 * is accepted or refused on its own checks.
 */
export async function resolveArxivSession({
  id,
  pdfVersion,
  pdfSha256,
  readAlignment,
  download,
  prepare
} = {}) {
  const version = canonicalArxivVersion(pdfVersion);
  let cached = null;
  if (typeof readAlignment === "function") {
    cached = await readAlignment({ id, version, pdfSha256 });
  }
  if (alignmentReusable(cached, { id, pdfVersion: version, pdfSha256 })) {
    return { ok: true, reason: "", downloaded: false, parsed: false, reused: true, alignment: cached };
  }
  if (typeof download !== "function") {
    diagLog("net.offline", { ctx: "viewer", code: "offline" });
    return { ok: false, reason: "offline", downloaded: false, parsed: false, reused: false, alignment: null };
  }
  const packed = await download({ id, version, pdfSha256 });
  if (!packed || packed.ok === false) {
    const reason = packed?.reason || "offline";
    if (reason === "offline") diagLog("net.offline", { ctx: "viewer", code: "offline" });
    return {
      ok: false,
      reason,
      downloaded: true,
      parsed: false,
      reused: false,
      alignment: null
    };
  }
  if (typeof prepare !== "function") {
    return { ok: false, reason: "no-main", downloaded: true, parsed: false, reused: false, alignment: null };
  }
  const prepared = await prepare({
    files: packed.files || [],
    id,
    version,
    pdfSha256
  });
  if (!prepared?.ok) {
    return {
      ok: false,
      reason: prepared?.reason || "no-main",
      downloaded: true,
      parsed: true,
      reused: false,
      alignment: prepared?.alignment || null
    };
  }
  return {
    ok: true,
    reason: "",
    downloaded: true,
    parsed: true,
    reused: false,
    alignment: prepared.alignment
  };
}
