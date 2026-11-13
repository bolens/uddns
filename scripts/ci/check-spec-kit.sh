#!/usr/bin/env bash
# Verify the managed integration with the reviewed, immutable fleet validator.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
python3 -I - "$root" <<'PY'
import hashlib
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import urllib.request

URL = "https://raw.githubusercontent.com/bolens/.github/c161a6757130ea687def9eb1e81c6a4190488f07/scripts/validate-spec-kit.py"
SHA256 = "2adf34306ad78331f1a8a061527dfe0e8247ba6449ab257630e6b6a02b90772e"
MAX_BYTES = 65536


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("unexpected Spec Kit validator redirect")


def fetch_timeout(_signum, _frame):
    raise TimeoutError("Spec Kit validator download exceeded 60 seconds")


try:
    # Bound the entire download as well as each individual socket operation.
    signal.signal(signal.SIGALRM, fetch_timeout)
    signal.alarm(60)
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(URL, timeout=30) as response:
        if response.geturl() != URL:
            raise ValueError("unexpected Spec Kit validator redirect")
        payload = response.read(MAX_BYTES + 1)
    signal.alarm(0)
    if len(payload) > MAX_BYTES:
        raise ValueError("Spec Kit validator exceeds size limit")
    if hashlib.sha256(payload).hexdigest() != SHA256:
        raise ValueError("Spec Kit validator checksum mismatch")
    with tempfile.TemporaryDirectory(prefix="spec-kit-validation-") as scratch:
        validator = Path(scratch) / "validate-spec-kit.py"
        validator.write_bytes(payload)
        result = subprocess.run(
            [sys.executable, "-I", str(validator), "--expected-version", "current", sys.argv[1]],
            check=False,
            timeout=240,
        )
        sys.exit(result.returncode)
except (OSError, ValueError, TimeoutError, subprocess.TimeoutExpired) as error:
    print(f"Spec Kit validation failed: {error}", file=sys.stderr)
    sys.exit(1)
finally:
    signal.alarm(0)
PY
