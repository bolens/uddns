#!/usr/bin/env bash
set -euo pipefail

browser="$(command -v google-chrome || command -v chromium || true)"
[[ -n "$browser" ]] || { echo "responsive check requires Chrome or Chromium" >&2; exit 1; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
site_dir="${SITE_DIR:-$root/site}"
evidence_dir="${SITE_EVIDENCE_DIR:-$(mktemp -d)}"
port="${SITE_VISUAL_PORT:-4175}"
server_pid=""
cleanup() { [[ -z "$server_pid" ]] || kill "$server_pid" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$evidence_dir"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$site_dir" >"$evidence_dir/server.log" 2>&1 &
server_pid="$!"
for _ in {1..20}; do curl -fsS "http://127.0.0.1:$port/" >/dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "http://127.0.0.1:$port/" >/dev/null

for viewport in 1440x1000 900x1000 390x844 320x800; do
  output="$evidence_dir/$viewport.png"
  "$browser" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --force-prefers-reduced-motion --window-size="${viewport/x/,}" --screenshot="$output" \
    "http://127.0.0.1:$port/" >/dev/null 2>&1
  dimensions="$(python3 -c 'import struct, sys; print("%dx%d" % struct.unpack(">II", open(sys.argv[1], "rb").read(24)[16:24]))' "$output")"
  [[ "$dimensions" == "$viewport" ]] || { echo "$viewport capture has dimensions $dimensions" >&2; exit 1; }
done
echo "ok: responsive captures in $evidence_dir"
