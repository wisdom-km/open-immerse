#!/usr/bin/env bash
# Run each representative file in its own node --test process and print a count line.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
list="$root/scripts/ci/representative-tests.txt"

if [[ ! -f "$list" ]]; then
  echo "missing $list" >&2
  exit 1
fi

echo "node $(node --version)"

summary() {
  # spec reporter prefixes each summary line with U+2139, not '#'.
  awk -v key="$1" '$2 == key { value = $3 } END { print value }' "$2"
}

fail=0
while IFS= read -r file || [[ -n "${file:-}" ]]; do
  [[ -z "${file:-}" || "$file" =~ ^[[:space:]]*# ]] && continue
  echo "===== $file ====="
  log="$(mktemp)"
  set +e
  node --test --test-reporter=spec "$file" >"$log" 2>&1
  status=$?
  set -e
  cat "$log"
  pass="$(summary pass "$log")"
  failed="$(summary fail "$log")"
  skipped="$(summary skipped "$log")"
  duration="$(summary duration_ms "$log")"
  echo "RESULT $file pass=${pass:-0} fail=${failed:-0} skipped=${skipped:-0} duration_ms=${duration:-0} exit=$status"
  if [[ "$status" -ne 0 ]]; then
    fail=1
  fi
  rm -f "$log"
done <"$list"

exit "$fail"
