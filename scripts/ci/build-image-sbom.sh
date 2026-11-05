#!/usr/bin/env bash
# Scan the exact Kaniko archive without registry credentials or a Docker socket.
set -euo pipefail
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
curl --fail --silent --show-error --location --retry 3 \
    --output "$scratch/syft.tar.gz" \
    https://github.com/anchore/syft/releases/download/v1.56.0/syft_1.56.0_linux_amd64.tar.gz
printf '%s  %s\n' 1c2493cfcf52d3367d6cb25780d9190c111c2219c34c820574c43e8bae15c528 "$scratch/syft.tar.gz" | sha256sum --check --strict
tar -xzf "$scratch/syft.tar.gz" -C "$scratch" syft
"$scratch/syft" scan docker-archive:.woodpecker-out/image.tar \
    --quiet --output spdx-json=.woodpecker-out/sbom.spdx.json
