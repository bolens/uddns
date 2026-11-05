#!/usr/bin/env python3
"""Prepare exact-source GHCR candidates; production activation requires the server broker."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess

REPOSITORY = "bolens/uddns"
IMAGE = f"ghcr.io/{REPOSITORY}"
OUTPUT = Path(".woodpecker-out")


class PublicationDisabled(Exception):
    """The owning host has not enabled the new publication owner."""


def sanitized_environment():
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("GH_", "GITHUB_", "GIT_", "CI_NETRC_", "CURL_TRACE", "CURL_VERBOSE"))
                   and key not in {"SSH_ASKPASS", "WOODPECKER_PUBLISH_LEASE"}}
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
                       GIT_TERMINAL_PROMPT="0")
    return environment


def run(*args, **kwargs):
    kwargs.setdefault("env", sanitized_environment())
    return subprocess.run(args, check=True, text=True, capture_output=True,
                          timeout=120, **kwargs).stdout.strip()


_GITHUB_CREDENTIAL = None
CREDENTIAL_ENDPOINT = "https://woodpecker.bolens.dev/publisher/credentials"


def github_environment():
    """Redeem a queued lease at execution time; keep the short-lived token in memory."""
    import datetime
    import math
    import secrets
    import time
    import urllib.request
    global _GITHUB_CREDENTIAL
    if _GITHUB_CREDENTIAL is None or _GITHUB_CREDENTIAL[1] - time.time() < 120:
        lease = os.environ.get("WOODPECKER_PUBLISH_LEASE", "")
        sha = os.environ.get("CI_COMMIT_SHA", "")
        if not lease or not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise ValueError("missing publication lease or source identity")
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        request = urllib.request.Request(CREDENTIAL_ENDPOINT,
            data=json.dumps({"lease": lease, "repository": REPOSITORY,
                             "commit": sha, "purpose": "github",
                             "request_id": secrets.token_hex(16)}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
                record = json.load(response)
            token = record["token"]
            expires = record["expires_at"]
            if isinstance(expires, (int, float)):
                expiry = float(expires)
            else:
                parsed = datetime.datetime.fromisoformat(expires.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    raise ValueError("broker expiry requires a timezone")
                expiry = parsed.timestamp()
            if (not isinstance(token, str) or not token
                    or any(ord(character) < 33 or ord(character) > 126 for character in token)
                    or not math.isfinite(expiry) or expiry - time.time() < 120):
                raise ValueError("invalid broker credential")
        except Exception:
            # Never expose HTTP response bodies, request objects, lease or token.
            raise RuntimeError("publication credential redemption failed") from None
        _GITHUB_CREDENTIAL = (token, expiry)
    environment = sanitized_environment()
    environment.update(GH_TOKEN=_GITHUB_CREDENTIAL[0], GH_HOST="github.com",
                       GH_PROMPT_DISABLED="1", GH_NO_UPDATE_NOTIFIER="1",
                       GIT_TERMINAL_PROMPT="0")
    return environment


def api(path, method="GET", data=None):
    args = ["gh", "api", "--method", method, path]
    if data is not None:
        args += ["--input", "-"]
    raw = run(*args, input=json.dumps(data) if data is not None else None,
              env=github_environment())
    return json.loads(raw) if raw else None


def context(expected_event=None):
    expected = {"CI_FORGE_TYPE": "github", "CI_FORGE_URL": "https://github.com",
                "CI_REPO": REPOSITORY}
    for key, value in expected.items():
        if os.environ.get(key) != value:
            raise ValueError(f"publication denied: unexpected {key}")
    event = os.environ.get("CI_PIPELINE_EVENT")
    tag = os.environ.get("CI_COMMIT_TAG", "")
    if expected_event == "push" or REPOSITORY == "bolens/audio-utils":
        if (event != "push" or os.environ.get("CI_COMMIT_BRANCH") != "main"
                or os.environ.get("CI_COMMIT_REF") != "refs/heads/main" or tag):
            raise ValueError("publication denied: expected canonical main push")
    elif event != "tag" or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", tag):
        raise ValueError("publication denied: expected immutable release tag")
    elif os.environ.get("CI_COMMIT_REF") != f"refs/tags/{tag}":
        raise ValueError("publication denied: mismatched tag ref")
    sha = os.environ.get("CI_COMMIT_SHA", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or run("git", "rev-parse", "HEAD") != sha:
        raise ValueError("publication denied: checkout differs from event")
    if run("git", "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("publication denied: tracked source was modified")
    return sha, tag


def guard(expected_event=None):
    sha, tag = context(expected_event)
    try:
        setting = api(f"repos/{REPOSITORY}/actions/variables/WOODPECKER_PUBLISHING")
    except subprocess.CalledProcessError:
        raise PublicationDisabled("Woodpecker publication setting unavailable; no writes") from None
    if setting.get("value") != "true":
        raise PublicationDisabled("Woodpecker publication disabled; no writes")
    if tag:
        ref = api(f"repos/{REPOSITORY}/git/ref/tags/{tag}")["object"]
        if ref["type"] != "tag":
            raise ValueError("release requires an annotated signed tag")
        signed = api(f"repos/{REPOSITORY}/git/tags/{ref['sha']}")
        if not signed.get("verification", {}).get("verified"):
            raise ValueError("release tag signature was not verified")
        if signed["object"].get("type") != "commit" or signed["object"].get("sha") != sha:
            raise ValueError("release tag target differs from event source")
        if api(f"repos/{REPOSITORY}/compare/{sha}...main")["status"] not in {"ahead", "identical"}:
            raise ValueError("release source is not reachable from canonical main")
        version = json.loads(Path("package.json").read_text())["version"]
        if tag != f"v{version}":
            raise ValueError("release tag differs from package.json version")
    elif api(f"repos/{REPOSITORY}/commits/main")["sha"] != sha:
        raise ValueError("superseded main candidate")
    return sha, tag


def prepare():
    sha, tag = guard()
    OUTPUT.mkdir(exist_ok=True)
    version = tag[1:] if tag else f"sha-{sha}"
    number = os.environ.get("CI_PIPELINE_NUMBER", "")
    if not re.fullmatch(r"[1-9][0-9]*", number):
        raise ValueError("invalid pipeline identity")
    candidate = f"candidate-{sha}-{number}"
    # Neither final identity nor a retry of this candidate may overwrite tags.
    # Serialized publication ownership is still required: registry tag APIs do
    # not provide an atomic compare-and-set between this check and a later push.
    for existing in (version, candidate):
        probe = subprocess.run(["skopeo", "inspect", f"docker://{IMAGE}:{existing}"],
                               text=True, capture_output=True, check=False, timeout=120,
                               env=sanitized_environment())
        if probe.returncode == 0:
            raise ValueError("immutable image tag already exists; inspect before recovery")
        if "manifest unknown" not in probe.stderr.lower() and "name unknown" not in probe.stderr.lower():
            raise ValueError("could not establish absence of immutable candidate")
    extra = ("--digest-file=.woodpecker-out/image.digest --tar-path=.woodpecker-out/image.tar "
             f"--label=org.opencontainers.image.source=https://github.com/{REPOSITORY} "
             f"--label=org.opencontainers.image.revision={sha} "
             f"--label=org.opencontainers.image.version={version}")
    (OUTPUT / "kaniko.env").write_text(f"PLUGIN_TAGS={candidate}\nPLUGIN_EXTRA_OPTS={extra}\n")


def archive_config(sha, tag):
    import hashlib
    import tarfile
    with tarfile.open(OUTPUT / "image.tar") as archive:
        images = json.load(archive.extractfile("manifest.json"))
        if len(images) != 1:
            raise ValueError("candidate archive must contain exactly one image")
        config_name = images[0]["Config"]
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", config_name):
            raise ValueError("unexpected Kaniko archive config identity")
        config_bytes = archive.extractfile(config_name).read()
        if "sha256:" + hashlib.sha256(config_bytes).hexdigest() != config_name:
            raise ValueError("candidate archive config digest mismatch")
        config = json.loads(config_bytes)
        labels = config.get("config", {}).get("Labels") or {}
        if (labels.get("org.opencontainers.image.revision") != sha
                or labels.get("org.opencontainers.image.source") != "https://github.com/" + REPOSITORY
                or labels.get("org.opencontainers.image.version") != tag[1:]
                or config.get("os") != "linux" or config.get("architecture") != "amd64" or config.get("config", {}).get("User") != "node"):
            raise ValueError("candidate archive differs from the canonical source/platform")
        number = os.environ.get("CI_PIPELINE_NUMBER", "")
        if not re.fullmatch(r"[1-9][0-9]*", number) or images[0].get("RepoTags") != [f"{IMAGE}:candidate-{sha}-{number}"]:
            raise ValueError("candidate archive belongs to another pipeline")
        return config_name


def manifest():
    sha, tag = guard()
    digest = (OUTPUT / "image.digest").read_text().strip()
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("invalid candidate digest")
    image = json.loads(run("skopeo", "inspect", f"docker://{IMAGE}@{digest}"))
    labels = image.get("Labels") or {}
    if (image.get("Digest") != digest or labels.get("org.opencontainers.image.revision") != sha
            or labels.get("org.opencontainers.image.source") != f"https://github.com/{REPOSITORY}"):
        raise ValueError("published candidate identity mismatch")
    config_digest = archive_config(sha, tag)
    remote = json.loads(run("skopeo", "inspect", "--raw", f"docker://{IMAGE}@{digest}"))
    if remote.get("config", {}).get("digest") != config_digest:
        raise ValueError("registry image config differs from the scanned archive")
    record = {"repository": REPOSITORY, "commit": sha, "tag": tag,
              "image": IMAGE, "digest": digest, "configDigest": config_digest,
              "builder": os.environ["CI_PIPELINE_URL"], "status": "candidate-only"}
    import hashlib
    sbom = OUTPUT / "sbom.spdx.json"
    if not sbom.is_file() or sbom.is_symlink():
        raise ValueError("native image SPDX inventory is missing")
    document = json.loads(sbom.read_text())
    if document.get("spdxVersion") != "SPDX-2.3" or not document.get("packages"):
        raise ValueError("native SPDX package inventory is invalid")
    provenance = {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [{"name": IMAGE, "digest": {"sha256": digest[7:]}}],
        "predicateType": "https://slsa.dev/provenance/v1",
        "predicate": {
            "buildDefinition": {"buildType": "https://woodpecker-ci.org/ci",
                "externalParameters": {"repository": REPOSITORY, "tag": tag, "commit": sha},
                "resolvedDependencies": [{"uri": "git+https://github.com/" + REPOSITORY,
                                          "digest": {"gitCommit": sha}}]},
            "runDetails": {"builder": {"id": "https://woodpecker.bolens.dev"},
                           "metadata": {"invocationId": record["builder"]}}}}
    (OUTPUT / "woodpecker-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    record["assets"] = {name: hashlib.sha256((OUTPUT / name).read_bytes()).hexdigest()
                        for name in ["sbom.spdx.json", "woodpecker-provenance.json"]}
    (OUTPUT / "image-manifest.json").write_text(json.dumps(record, indent=2) + "\n")
    # The authenticated native publisher hands its receipt to the existing OIDC identity;
    # no version/minor/latest alias is changed in this build step.
    return record


def validate_release_directory(directory, sha, tag):
    import importlib.util
    specification = importlib.util.spec_from_file_location(
        "image_bridge", Path(__file__).with_name("woodpecker-verify-image.py"))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module.validate_assets(directory, sha, tag)[0]


def finalize_release():
    import hashlib
    import shutil
    import tempfile
    sha, tag = guard()
    names = {"image-manifest.json", "sbom.spdx.json", "woodpecker-provenance.json"}
    with tempfile.TemporaryDirectory() as temporary:
        local = Path(temporary) / "local"
        local.mkdir()
        for name in names:
            source = OUTPUT / name
            if source.is_symlink() or not source.is_file():
                raise ValueError("native release requires regular candidate files")
            shutil.copyfile(source, local / name)
        local_record = validate_release_directory(local, sha, tag)
        try:
            release = api(f"repos/{REPOSITORY}/releases/tags/{tag}")
        except subprocess.CalledProcessError as error:
            if "HTTP 404" not in (error.stderr or ""):
                raise
            notes = api(f"repos/{REPOSITORY}/releases/generate-notes", "POST", {
                "tag_name": tag, "target_commitish": sha})
            release = api(f"repos/{REPOSITORY}/releases", "POST", {
                "tag_name": tag, "target_commitish": sha, "name": tag,
                "body": notes["body"], "draft": True, "prerelease": "-" in tag, "make_latest": "false"})
        identity = api(f"repos/{REPOSITORY}/actions/variables/WOODPECKER_PUBLISHER_ID")["value"]
        if (not re.fullmatch(r"[1-9][0-9]*", identity)
                or release.get("author", {}).get("id") != int(identity)
                or release["target_commitish"] != sha):
            raise ValueError("release is not owned by the approved publisher/source")
        present = {asset["name"] for asset in release["assets"]}
        if present - names:
            raise ValueError("existing release has unexpected assets; no writes")
        original = Path(temporary) / "original"
        original.mkdir()
        record = local_record
        if "image-manifest.json" in present:
            run("gh", "release", "download", tag, "--repo", REPOSITORY,
                "--pattern", "image-manifest.json", "--dir", str(original), env=github_environment())
            record = json.loads((original / "image-manifest.json").read_text())
            if (record.get("repository"), record.get("commit"), record.get("tag")) != (REPOSITORY, sha, tag):
                raise ValueError("existing native receipt belongs to another release")
        elif present:
            raise ValueError("partial draft has assets but no original receipt; recover it before retrying")
        else:
            shutil.copyfile(local / "image-manifest.json", original / "image-manifest.json")
        if set(record.get("assets", {})) != names - {"image-manifest.json"}:
            raise ValueError("existing native receipt has an unexpected asset set")
        for name in sorted(names - {"image-manifest.json"}):
            if name in present:
                run("gh", "release", "download", tag, "--repo", REPOSITORY,
                    "--pattern", name, "--dir", str(original), env=github_environment())
            else:
                if not release["draft"] or hashlib.sha256((local / name).read_bytes()).hexdigest() != record["assets"][name]:
                    raise ValueError("recover original missing asset bytes; never replace a published version")
                shutil.copyfile(local / name, original / name)
        validate_release_directory(original, sha, tag)
        if release["draft"]:
            # Receipt goes first. A retry verifies prior bytes and only fills missing
            # matching files; upload never uses --clobber.
            for name in ["image-manifest.json", "sbom.spdx.json", "woodpecker-provenance.json"]:
                if name not in present:
                    run("gh", "release", "upload", tag, "--repo", REPOSITORY,
                        str(original / name), env=github_environment())
            api(f"repos/{REPOSITORY}/actions/workflows/release.yml/dispatches", "POST", {
                "ref": tag, "inputs": {"woodpecker_bridge": "true"}})
            (OUTPUT / "handoff.json").write_text(json.dumps({**record,
                "status": "pending-signature-runtime-and-promotion"}, indent=2) + "\n")
            return
        published = api(f"repos/{REPOSITORY}/releases/tags/{tag}")
        if published["draft"] or published["target_commitish"] != sha:
            raise ValueError("release finalization did not preserve the native source")
        downloaded = Path(temporary) / "published"
        downloaded.mkdir()
        run("gh", "release", "download", tag, "--repo", REPOSITORY,
            "--dir", str(downloaded), env=github_environment())
        published_record = validate_release_directory(downloaded, sha, tag)
        if published_record != record:
            raise ValueError("published receipt changed during finalization")
        version = json.loads(run("skopeo", "inspect", f"docker://{IMAGE}:{tag[1:]}"))
        if version["Digest"] != record["digest"]:
            raise ValueError("published version does not refer to the verified native digest")


def site_files(directory):
    import hashlib
    result = {}
    for item in sorted(directory.rglob("*")):
        relative = item.relative_to(directory)
        if item.is_symlink() or ".git" in relative.parts:
            raise ValueError("unsafe generated Pages path")
        if item.is_dir():
            continue
        if not item.is_file():
            raise ValueError("generated Pages path is not a regular file")
        result[relative.as_posix()] = hashlib.sha256(item.read_bytes()).hexdigest()
    if "index.html" not in result:
        raise ValueError("generated Pages index missing")
    return result


def pages_event():
    # A release tag deploys after finalization; a site change deploys from main.
    return "push" if os.environ.get("CI_PIPELINE_EVENT") == "push" else None


def prepare_pages():
    sha, _ = guard("push")
    release = {key: value for key, value in api(f"repos/{REPOSITORY}/releases/latest").items()
               if key in {"id", "tag_name", "draft", "prerelease"}}
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / "pages-release.json").write_text(json.dumps({
        "repository": REPOSITORY, "commit": sha, "release": release}, indent=2) + "\n")


def public_release():
    """Credential-free local validation; these tag-only bytes cannot authorize push."""
    import time
    import urllib.error
    import urllib.parse
    import urllib.request
    request = urllib.request.Request(f"https://github.com/{REPOSITORY}/releases/latest", method="HEAD",
        headers={"User-Agent": "Woodpecker-CI-public-site-validation", "Cache-Control": "no-cache"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                target = urllib.parse.urlparse(response.geturl())
            prefix = f"/{REPOSITORY}/releases/tag/"
            if (target.scheme != "https" or target.netloc != "github.com" or target.query or target.fragment
                    or not target.path.startswith(prefix)):
                raise ValueError("latest release redirect is not canonical")
            tag = urllib.parse.unquote(target.path[len(prefix):])
            if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
                raise ValueError("latest release redirect is not stable")
            return {"id": None, "tag_name": tag}
        except urllib.error.HTTPError as error:
            if error.code not in {403, 429, 500, 502, 503, 504} or attempt == 2:
                raise
        except urllib.error.URLError:
            if attempt == 2:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError("public stable release could not be resolved")


def pages_release(sha, release_metadata=None):
    if release_metadata is not None:
        return release_metadata
    metadata = OUTPUT / "pages-release.json"
    if metadata.exists():
        record = json.loads(metadata.read_text())
        if record.get("repository") != REPOSITORY or record.get("commit") != sha:
            raise ValueError("approved Pages release metadata belongs to another source")
        return record["release"]
    return public_release()


def render_pages(authorized_source=None, release_metadata=None):
    import io
    import shutil
    import tarfile
    import tempfile
    # No publication lease or token is used by the site build. A release may
    # finish after main advances, so build current protected-main site sources
    # independently of the tagged application source and record both SHAs.
    sha = authorized_source if authorized_source is not None else context(pages_event())[0]
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("GIT_", "GH_", "GITHUB_"))
                   and key != "WOODPECKER_PUBLISH_LEASE"}
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
                       GIT_TERMINAL_PROMPT="0")
    OUTPUT.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        run("git", "init", "--quiet", temporary, env=environment)
        run("git", "fetch", "--quiet", "--depth=1", f"https://github.com/{REPOSITORY}.git",
            "refs/heads/main", cwd=temporary, env=environment)
        pages_sha = run("git", "rev-parse", "FETCH_HEAD", cwd=temporary, env=environment)
        if not re.fullmatch(r"[0-9a-f]{40}", pages_sha):
            raise ValueError("invalid canonical Pages source")
        archive = subprocess.run(["git", "archive", pages_sha, "site",
                                  "scripts/ci/check-site-accessibility.py",
                                  "scripts/ci/check-site-links.py",
                                  "scripts/ci/check-site-responsive.sh"],
                                 cwd=temporary, env=environment, capture_output=True,
                                 check=True, timeout=120).stdout
    sources = OUTPUT / "pages-source"
    sources.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
        tree.extractall(sources, filter="data")
    release = pages_release(sha, release_metadata)
    tag = release["tag_name"]
    if release.get("draft") or release.get("prerelease") or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        raise ValueError("Pages requires an existing stable published release")
    source = sources / "site"
    site_files(source)
    destination = OUTPUT / "site"
    shutil.copytree(source, destination)
    index = destination / "index.html"
    index.write_text(index.read_text().replace("__LATEST_RELEASE__", tag))
    if any(b"__LATEST_RELEASE__" in f.read_bytes() for f in destination.rglob("*") if f.is_file()):
        raise ValueError("unrendered release placeholder")
    (destination / ".nojekyll").touch()
    record = {"repository": REPOSITORY, "commit": sha, "pagesSourceSHA": pages_sha,
              "release": tag, "release_id": release["id"], "files": site_files(destination)}
    (OUTPUT / "pages-manifest.json").write_text(json.dumps(record, indent=2) + "\n")


def publish_pages(authorize=None, credentials=None, github_api=None):
    import base64
    import shutil
    import tempfile
    authorize = authorize or (lambda: guard(pages_event()))
    credentials = credentials or github_environment
    github_api = github_api or api
    sha, _ = authorize()
    source = OUTPUT / "site"
    record = json.loads((OUTPUT / "pages-manifest.json").read_text())
    if (type(record.get("release_id")) is not int or record["release_id"] <= 0
            or record["repository"] != REPOSITORY or record["commit"] != sha
            or record["files"] != site_files(source)):
        raise ValueError("Pages candidate identity changed after validation")
    if github_api(f"repos/{REPOSITORY}/commits/main")["sha"] != record["pagesSourceSHA"]:
        raise ValueError("Pages source has been superseded on protected main")
    release = github_api(f"repos/{REPOSITORY}/releases/latest")
    if release["id"] != record["release_id"] or release["tag_name"] != record["release"]:
        raise ValueError("Pages candidate has been superseded by a release")
    def git_environment():
        token = credentials()["GH_TOKEN"]
        # Auth never enters argv, remote URLs, source or persistent config.
        result = sanitized_environment()
        result.update(GIT_CONFIG_COUNT="2", GIT_CONFIG_KEY_0="credential.helper",
                      GIT_CONFIG_VALUE_0="", GIT_CONFIG_KEY_1="http.https://github.com/.extraheader",
                      GIT_CONFIG_VALUE_1="AUTHORIZATION: basic " + base64.b64encode(f"x-access-token:{token}".encode()).decode())
        return result
    environment = git_environment()
    remote = f"https://github.com/{REPOSITORY}.git"
    with tempfile.TemporaryDirectory() as temporary:
        destination = Path(temporary) / "site"
        shutil.copytree(source, destination)
        run("git", "init", "-b", "gh-pages", str(destination), env=environment)
        if run("git", "ls-remote", remote, "refs/heads/gh-pages", env=environment):
            run("git", "fetch", "--depth=1", remote, "gh-pages", cwd=destination, env=environment)
            run("git", "reset", "--soft", "FETCH_HEAD", cwd=destination, env=environment)
        run("git", "add", "--all", cwd=destination, env=environment)
        run("git", "-c", "user.name=Woodpecker Pages bot", "-c",
            "user.email=woodpecker@users.noreply.github.com", "commit", "--allow-empty",
            "-m", f"docs(pages): deploy {sha}", cwd=destination, env=environment)
        authorize()
        if github_api(f"repos/{REPOSITORY}/commits/main")["sha"] != record["pagesSourceSHA"]:
            raise ValueError("Pages source changed before push")
        latest = github_api(f"repos/{REPOSITORY}/releases/latest")
        if latest["id"] != record["release_id"] or latest["tag_name"] != record["release"]:
            raise ValueError("Pages release changed before push")
        run("git", "push", remote, "HEAD:refs/heads/gh-pages", cwd=destination, env=git_environment())
        return run("git", "rev-parse", "HEAD", cwd=destination, env=sanitized_environment())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["guard", "prepare", "manifest", "render-pages", "prepare-pages", "publish-pages", "finalize-release"])
    args = parser.parse_args()
    {"guard": guard, "prepare": prepare, "manifest": manifest,
     "render-pages": render_pages, "prepare-pages": prepare_pages, "publish-pages": publish_pages,
     "finalize-release": finalize_release}[args.phase]()


if __name__ == "__main__":
    try:
        main()
    except PublicationDisabled as disabled:
        print(disabled)
        raise SystemExit(78) from None
