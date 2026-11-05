#!/usr/bin/env bash
# Build the runtime image and validate placeholder-only fixtures without network access.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
root=$(pwd)
image="uddns-runtime-check:check-$$"
if docker image inspect "$image" >/dev/null 2>&1; then
  echo "Refusing to replace existing test image: $image" >&2
  exit 1
fi
trap 'docker image rm "$image" >/dev/null 2>&1 || true' EXIT
docker build --tag "$image" .
for fixture in uddns.multi.yaml uddns.failover.yaml; do
  docker run --rm --network none --read-only \
    --volume "$root/examples:/fixtures:ro" \
    --env "UDDNS_CONFIG_FILE=/fixtures/$fixture" \
    "$image" dist/cli.js check-config
done
