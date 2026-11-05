#!/usr/bin/env bash
# Validate tracked source when the Docker daemon cannot see this checkout path.
set -euo pipefail
if (( $# < 2 )); then
  echo "usage: $0 IMAGE COMMAND [ARG ...]" >&2
  exit 2
fi
image_ref=$1
shift
engine=${CONTAINER_ENGINE:-docker}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
validation_container=$("$engine" create --network=none --cap-drop=ALL \
  --security-opt=no-new-privileges --user 10001:10001 --workdir /workspace \
  -- "$image_ref" "$@")
# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  local status=$?
  if ! "$engine" rm --force "$validation_container" >/dev/null; then
    if (( status == 0 )); then status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT
# Include parent ownership and tracked files, excluding Git credentials and local state.
git ls-files -z | python3 -c '
import os
import sys

data = sys.stdin.buffer.read()
directories = {"."}
for raw in data.split(b"\0"):
    parent = os.path.dirname(os.fsdecode(raw))
    while parent:
        directories.add(parent)
        parent = os.path.dirname(parent)
sys.stdout.buffer.write(b"\0".join(os.fsencode(p) for p in sorted(directories)) + b"\0" + data)
' |
  tar --create --file=- --no-recursion --null --verbatim-files-from \
    --owner=10001 --group=10001 --transform='flags=rh;s,^,workspace/,' --files-from=- |
  "$engine" cp --archive - "$validation_container:/"
"$engine" start --attach "$validation_container"
command_status=$("$engine" inspect --format '{{.State.ExitCode}}' "$validation_container")
exit "$command_status"
