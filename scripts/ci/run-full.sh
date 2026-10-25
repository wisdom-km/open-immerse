#!/usr/bin/env bash
# Full suite: every tests/*.test.mjs file. tests/net/ is outside this glob.
# Headless Chrome is started by the tests that need it. This script does not
# set an API key. A test that needs one skips when the variable is missing.
#
# --test-timeout is the file ceiling (60 min). A test that sets its own
# timeout keeps that shorter limit. An async hang fails there, and
# --test-force-exit returns even if a timer is still referenced.
# A hang that never returns to the event loop is outside that timer.
# tests/mm-probe.test.mjs runs the 500-seed case in short-lived processes
# and kills a stuck batch itself.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

echo "node $(node --version)"
if [[ -n "${CHROME_BIN:-}" && -x "${CHROME_BIN}" ]]; then
  echo "chrome bin ${CHROME_BIN}"
  "${CHROME_BIN}" --version || true
elif command -v google-chrome >/dev/null 2>&1; then
  echo "chrome $(google-chrome --version)"
fi

node --test \
  --test-timeout=3600000 \
  --test-force-exit \
  --test-reporter=spec \
  tests/*.test.mjs
