#!/usr/bin/env bash
# Portable equivalents of the pinned fleet source, Spec Kit and workflow gates.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd -- "$root"
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
fetch_tooling() {
    local revision=$1 target=$2
    git init --quiet "$target"
    git -C "$target" fetch --quiet --depth=1 https://github.com/bolens/.github.git "$revision"
    git -C "$target" checkout --quiet --detach FETCH_HEAD
    test "$(git -C "$target" rev-parse HEAD)" = "$revision"
}
python3 -m venv "$scratch/venv"
"$scratch/venv/bin/pip" install --disable-pip-version-check ruff==0.15.20 zizmor==1.29.0
export PATH="$scratch/venv/bin:$scratch:$PATH"
fetch_tooling 7603518f305fb76f7bb1b9979f2692521f633b82 "$scratch/source"
npm ci --ignore-scripts --no-audit --no-fund --prefix "$scratch/source/tools/source-lint"
python3 "$scratch/source/scripts/lint-source.py" "$root"
fetch_tooling 7159a187479e511a9420f8f4eec93246a43fea12 "$scratch/spec"
python3 "$scratch/spec/scripts/validate-spec-kit.py" --expected-version current "$root"
# Same version and checksum as the pinned reusable-actionlint workflow.
curl --fail --silent --show-error --location --retry 3 \
    --output "$scratch/actionlint.tar.gz" \
    https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz
printf '%s  %s\n' 8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 "$scratch/actionlint.tar.gz" | sha256sum --check --strict
tar -xzf "$scratch/actionlint.tar.gz" -C "$scratch" actionlint
actionlint
zizmor --offline --min-severity medium --min-confidence medium .github
