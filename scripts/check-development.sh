#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
# Default verification must never enable live-provider HTTP tests.
unset RUN_LIVE_TESTS
export VP_GIT_HOOKS=0
CI=true pnpm install --frozen-lockfile --ignore-scripts
expected_node=$(python3 -c 'import json; print(json.load(open("package.json"))["devEngines"]["runtime"]["version"])')
[[ $(./node_modules/.bin/node --version) == "v$expected_node" ]]
pnpm run verify
python3 scripts/ci/check-site-accessibility.py
python3 scripts/ci/check-site-links.py
python3 -m unittest discover -s tests -p test_ci_node_runtime.py
python3 -m unittest discover -s tests -p test_development_container.py
python3 -m unittest discover -s tests -p test_remote_development_container.py
shellcheck scripts/check-development.sh scripts/check-development-container.sh scripts/ci/check-fleet.sh scripts/ci/check-pages.sh scripts/ci/build-image-sbom.sh
ruff check scripts/ci/prepare-node-runtime.py tests/test_ci_node_runtime.py scripts/development-container.py scripts/ci/woodpecker-publish.py scripts/ci/woodpecker-verify-image.py scripts/ci/woodpecker_native_status.py tests/test_image_bridge.py tests/test_native_pipeline_status.py tests/test_publication_policy.py tests/test_development_container.py tests/test_remote_development_container.py
actionlint
zizmor --offline --min-severity medium --min-confidence medium .github

python3 -m unittest discover -s tests -p test_publication_policy.py
python3 -m unittest discover -s tests -p test_image_bridge.py
python3 -m unittest discover -s tests -p test_native_pipeline_status.py
