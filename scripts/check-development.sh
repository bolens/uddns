#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
# Default verification must never enable live-provider HTTP tests.
unset RUN_LIVE_TESTS
export VP_GIT_HOOKS=0
CI=true pnpm install --frozen-lockfile --ignore-scripts
pnpm run verify
python3 scripts/ci/check-site-accessibility.py
python3 scripts/ci/check-site-links.py
python3 -m unittest discover -s tests -p test_development_container.py
shellcheck scripts/check-development.sh
ruff check scripts/development-container.py tests/test_development_container.py
actionlint
zizmor --offline --min-severity medium --min-confidence medium .github
