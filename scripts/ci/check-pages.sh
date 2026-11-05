#!/usr/bin/env bash
# Credential-free current-main site build; publication is a separate guarded step.
set -euo pipefail
python3 scripts/ci/woodpecker-publish.py render-pages
export SITE_DIR="$PWD/.woodpecker-out/site"
export SITE_EVIDENCE_DIR="$PWD/.woodpecker-out/site-evidence"
export SITE_VISUAL_PORT=48197
validators=.woodpecker-out/pages-source/scripts/ci
python3 "$validators/check-site-accessibility.py"
python3 "$validators/check-site-links.py"
# Profiles are private to this one sequential four-viewport run. Root Chromium
# inside an ordinary socket-free Docker job uses container isolation; no host
# sandbox, socket, extra capability or privilege is granted.
profile=$(mktemp -d)
trap 'rm -rf -- "$profile"' EXIT
export CHROME_PROFILE_DIR="$profile"
mkdir -p .woodpecker-out/browser-bin
sandbox=''
if [[ $(id -u) == 0 ]]; then sandbox=--no-sandbox; fi
# shellcheck disable=SC2016 # The wrapper expands its own environment and arguments.
printf '#!/usr/bin/env bash\nexec /usr/bin/chromium %s --user-data-dir="$CHROME_PROFILE_DIR" --no-first-run --no-default-browser-check --disable-background-networking "$@"\n' "$sandbox" > .woodpecker-out/browser-bin/chromium
chmod +x .woodpecker-out/browser-bin/chromium
PATH="$PWD/.woodpecker-out/browser-bin:$PATH" bash "$validators/check-site-responsive.sh"
