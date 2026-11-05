#!/usr/bin/env bash
# Credential-free current-main site build; publication is a separate guarded step.
set -euo pipefail
if [[ ${1:-} == --prepared ]]; then
    test -f .woodpecker-out/pages-manifest.json
elif [[ $# == 0 ]]; then
    python3 scripts/ci/woodpecker-publish.py render-pages
else
    echo 'usage: check-pages.sh [--prepared]' >&2
    exit 2
fi
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
browser=$(command -v google-chrome || command -v chromium || true)
[[ -n "$browser" ]] || { echo 'Chrome or Chromium is required' >&2; exit 1; }
export CHROME_EXECUTABLE="$browser"
sandbox=''
if [[ $(id -u) == 0 ]]; then sandbox=--no-sandbox; fi
# shellcheck disable=SC2016 # The wrapper expands its own environment and arguments.
printf '#!/usr/bin/env bash\nexec "$CHROME_EXECUTABLE" %s --user-data-dir="$CHROME_PROFILE_DIR" --no-first-run --no-default-browser-check --disable-background-networking "$@"\n' "$sandbox" > .woodpecker-out/browser-bin/google-chrome
chmod +x .woodpecker-out/browser-bin/google-chrome
PATH="$PWD/.woodpecker-out/browser-bin:$PATH" bash "$validators/check-site-responsive.sh"
