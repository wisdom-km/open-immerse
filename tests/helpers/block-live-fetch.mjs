/** Fail arxiv-* tests that reach global fetch. Injected fakes never call this. */

let violations = 0;

function blockedFetch(input) {
  violations += 1;
  const target = typeof input === "string" ? input : input?.url || "";
  const error = new Error(`AX-22 blocked a fetch that was not injected${target ? `: ${target}` : ""}`);
  error.code = "live-fetch-blocked";
  throw error;
}

globalThis.fetch = blockedFetch;

export function liveFetchViolations() {
  return violations;
}

export function probeBlockedFetch() {
  const before = violations;
  let blocked = false;
  try {
    globalThis.fetch("https://arxiv.org/src/0000.00000");
  } catch (err) {
    blocked = err?.code === "live-fetch-blocked";
  }
  violations = before;
  return blocked;
}

process.on("beforeExit", () => {
  if (violations > 0) {
    console.error(`AX-22: ${violations} non-injected fetch call(s)`);
    process.exitCode = 1;
  }
});
