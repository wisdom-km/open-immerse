/**
 * Screen gate for tier 0.
 * A formula is painted only when the PDF stamp and the source package
 * name the same version. A missing version is uncertain and stays off
 * the page. Equation numbers are compared after the parentheses are
 * removed, so a source "(1)" cannot land on PDF "(2)".
 */

export function canonicalArxivVersion(version) {
  const raw = String(version ?? "").trim().toLowerCase();
  if (!raw) return "";
  const match = raw.match(/^v?(\d+)$/);
  return match ? `v${match[1]}` : "";
}

export function versionScreenGate(pdfVersion, sourceVersion) {
  const pdf = canonicalArxivVersion(pdfVersion);
  const source = canonicalArxivVersion(sourceVersion);
  if (!pdf || !source) return { screen: false, reason: "version-uncertain" };
  if (pdf !== source) return { screen: false, reason: "version-mismatch" };
  return { screen: true, reason: null };
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
  return versionScreenGate(pdfVersion, alignment.version).screen;
}

/**
 * Second open reads the saved alignment and does not download or parse.
 * A version that is missing or different never calls prepare.
 */
export async function resolveArxivSession({
  id,
  pdfVersion,
  pdfSha256,
  readAlignment,
  download,
  prepare
} = {}) {
  const asked = versionScreenGate(pdfVersion, pdfVersion);
  if (!asked.screen) {
    return { ok: false, reason: asked.reason, downloaded: false, parsed: false, reused: false, alignment: null };
  }
  const version = canonicalArxivVersion(pdfVersion);
  let cached = null;
  if (typeof readAlignment === "function") {
    cached = await readAlignment({ id, version, pdfSha256 });
  }
  if (alignmentReusable(cached, { id, pdfVersion: version, pdfSha256 })) {
    return { ok: true, reason: "", downloaded: false, parsed: false, reused: true, alignment: cached };
  }
  if (typeof download !== "function") {
    return { ok: false, reason: "offline", downloaded: false, parsed: false, reused: false, alignment: null };
  }
  const packed = await download({ id, version, pdfSha256 });
  if (!packed || packed.ok === false) {
    return {
      ok: false,
      reason: packed?.reason || "offline",
      downloaded: true,
      parsed: false,
      reused: false,
      alignment: null
    };
  }
  const cross = versionScreenGate(version, packed.version || packed.sourceVersion || "");
  if (!cross.screen) {
    return { ok: false, reason: cross.reason, downloaded: true, parsed: false, reused: false, alignment: null };
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
  const saved = versionScreenGate(version, prepared.alignment?.version || "");
  if (!saved.screen) {
    return { ok: false, reason: saved.reason, downloaded: true, parsed: true, reused: false, alignment: null };
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
