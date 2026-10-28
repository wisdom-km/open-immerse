#!/usr/bin/env bash
# Download the gitignored fixtures the representative tests open, then check sha256.
# Networking belongs in this script. The tests themselves must not fetch.
# A mismatched sha fails the run. This script does not try another version.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

ua="open-immerse-fixture-fetch/1.0 (+https://github.com/wisdom-km/open-immerse)"

# path|url|sha256
# Attention Is All You Need, arXiv 1706.03762v7, 15 pages.
# Direct Preference Optimization, arXiv 2305.18290v3.
# e-print URLs redirect to arxiv.org/src/<id>; the bytes are the versioned tarball.
# Transformer-XL, arXiv 1901.02860v3 (updated 2019-06-02). mm-swap-flag opens the
# absolute path below and asserts text-layer counts TXL-p1=9, TXL-p2=15.
fixtures=(
  "tests/fixtures/Attention_Is_All_You_Need.pdf|https://arxiv.org/pdf/1706.03762v7|bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697"
  "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf|https://arxiv.org/pdf/2305.18290v3|92cb3a2b71362acda98a789b03d88688fd33cf5fcf13f81d2b1de30ee7d3b67a"
  "tests/fixtures/arxiv-src/1706.03762v1.tar.gz|https://arxiv.org/e-print/1706.03762v1|377b47ecf3cd8638f7214184cc445cb378b37b5f0ddb42981b1ad288b3a1c03b"
  "tests/fixtures/arxiv-src/1706.03762v7.tar.gz|https://arxiv.org/e-print/1706.03762v7|2e7a7d9ee2520d22eb23dae0cb148e167be02a30d6cb3f11b1c67723194339c6"
  "/tmp/oi-flow-corpus/1901.02860/paper.pdf|https://arxiv.org/pdf/1901.02860v3|6aa192b22820267309e8e7c501c514a3a3055256d9c8691b106c7f53f9098671"
)

# tests/fixtures/DDPM_2006.11239.pdf is intentionally absent.
# No representative test opens that PDF, and its sha256 is not known here.
# corpus/pdfs, held-out labels, and tests/fixtures/prelabel-judgments.json are out of scope.

forbidden_re='^(corpus/pdfs/|tests/fixtures/prelabel-judgments\.json$|tests/fixtures/DDPM_2006\.11239\.pdf$)'

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

host_ok() {
  case "$1" in
    arxiv.org|export.arxiv.org) return 0 ;;
    *) return 1 ;;
  esac
}

now_ms() {
  echo $(( $(date +%s%N) / 1000000 ))
}

started="$(now_ms)"
downloaded=0
reused=0

for row in "${fixtures[@]}"; do
  IFS='|' read -r rel url expect <<<"$row"
  if [[ "$rel" =~ $forbidden_re ]]; then
    echo "fetch-fixtures: refused forbidden path $rel" >&2
    exit 1
  fi
  if [[ "$rel" == /* ]]; then
    dest="$rel"
  else
    dest="$root/$rel"
  fi
  mkdir -p "$(dirname "$dest")"
  item_started="$(now_ms)"
  if [[ -f "$dest" ]]; then
    actual="$(sha256_file "$dest")"
    if [[ "$actual" != "$expect" ]]; then
      echo "fetch-fixtures: sha256 mismatch for $rel" >&2
      echo "fetch-fixtures: expected $expect" >&2
      echo "fetch-fixtures: actual   $actual" >&2
      echo "fetch-fixtures: refusing to replace it with another version" >&2
      exit 1
    fi
    elapsed="$(( $(now_ms) - item_started ))"
    echo "fetch-fixtures: reuse $rel sha256=$actual verify_ms=$elapsed"
    reused=$((reused + 1))
    continue
  fi

  tmp="$dest.partial"
  rm -f "$tmp"
  # curl writes only the body. -w reports status and the final URL on stdout after the body,
  # so keep the body in the partial file and the status on a side channel.
  meta="$(mktemp)"
  set +e
  curl --proto =https --silent --show-error --fail --location --retry 3 --retry-delay 2 \
    --user-agent "$ua" \
    --output "$tmp" \
    --write-out "%{http_code} %{url_effective}\n" \
    "$url" >"$meta"
  curl_status=$?
  set -e
  if [[ "$curl_status" -ne 0 ]]; then
    rm -f "$tmp" "$meta"
    echo "fetch-fixtures: download failed for $rel ($url), curl status $curl_status" >&2
    exit 1
  fi
  read -r http_code final_url <"$meta"
  rm -f "$meta"
  final_host="${final_url#https://}"
  final_host="${final_host%%/*}"
  if ! host_ok "$final_host"; then
    rm -f "$tmp"
    echo "fetch-fixtures: $rel redirected to unexpected host $final_host" >&2
    exit 1
  fi
  actual="$(sha256_file "$tmp")"
  if [[ "$actual" != "$expect" ]]; then
    rm -f "$tmp"
    echo "fetch-fixtures: downloaded sha256 mismatch for $rel" >&2
    echo "fetch-fixtures: url $url" >&2
    echo "fetch-fixtures: final $final_url" >&2
    echo "fetch-fixtures: http $http_code" >&2
    echo "fetch-fixtures: expected $expect" >&2
    echo "fetch-fixtures: actual   $actual" >&2
    echo "fetch-fixtures: not keeping the file and not trying another version" >&2
    exit 1
  fi
  mv "$tmp" "$dest"
  elapsed="$(( $(now_ms) - item_started ))"
  bytes="$(wc -c <"$dest" | tr -d ' ')"
  echo "fetch-fixtures: download $rel http=$http_code bytes=$bytes sha256=$actual download_ms=$elapsed final=$final_url"
  downloaded=$((downloaded + 1))
done

total="$(( $(now_ms) - started ))"
echo "fetch-fixtures: summary downloaded=$downloaded reused=$reused elapsed_ms=$total"
