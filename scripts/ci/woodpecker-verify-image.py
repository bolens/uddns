#!/usr/bin/env python3
"""Verify and sign an externally built uDDNS image through the retained GitHub identity."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlparse

from woodpecker_native_status import wait_for_native_success

REPOSITORY = "bolens/uddns"
IMAGE = f"ghcr.io/{REPOSITORY}"
OUTPUT = Path(".woodpecker-out/bridge")
ASSETS = {"image-manifest.json", "sbom.spdx.json", "woodpecker-provenance.json"}


def environment(auth=False):
    result = {key: value for key, value in os.environ.items()
              if not key.startswith(("GH_", "GITHUB_", "GIT_", "CI_NETRC_", "CURL_TRACE", "CURL_VERBOSE"))
              and key not in {"WOODPECKER_PUBLISH_LEASE", "SSH_ASKPASS"}}
    result.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_TERMINAL_PROMPT="0")
    if auth:
        result.update(GH_TOKEN=os.environ["GH_TOKEN"], GH_HOST="github.com", GH_PROMPT_DISABLED="1")
    return result


def run(*arguments, **kwargs):
    kwargs.setdefault("env", environment(auth=arguments[0] == "gh"))
    return subprocess.run(arguments, check=True, text=True, capture_output=True,
                          timeout=180, **kwargs).stdout.strip()


def api(path, method="GET", data=None):
    arguments = ["gh", "api", "--method", method, path]
    if data is not None:
        arguments += ["--input", "-"]
    raw = run(*arguments, input=json.dumps(data) if data is not None else None)
    return json.loads(raw) if raw else None


def context():
    if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
            or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REF_TYPE") != "tag"
            or os.environ.get("GITHUB_ACTOR_ID") != "352757955"
            or os.environ.get("GITHUB_REF") != "refs/tags/" + os.environ.get("GITHUB_REF_NAME", "")):
        raise ValueError("OIDC bridge requires an explicit canonical tag dispatch")
    tag, sha = os.environ["GITHUB_REF_NAME"], os.environ["GITHUB_SHA"]
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", tag) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("invalid bridge source identity")
    if os.environ.get("GITHUB_WORKFLOW_REF") != f"{REPOSITORY}/.github/workflows/release.yml@refs/tags/{tag}":
        raise ValueError("unexpected OIDC signer workflow")
    if run("git", "rev-parse", "HEAD") != sha or run("git", "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("bridge checkout differs from the immutable tag source")
    if tag != "v" + json.loads(Path("package.json").read_text())["version"]:
        raise ValueError("tag differs from package version")
    return sha, tag


def validate_assets(directory, sha, tag):
    record = json.loads((directory / "image-manifest.json").read_text())
    if (record.get("repository"), record.get("commit"), record.get("tag"), record.get("image")) != (REPOSITORY, sha, tag, IMAGE):
        raise ValueError("native image receipt differs from tagged source")
    builder = urlparse(record.get("builder", ""))
    if (builder.scheme != "https" or builder.netloc != "woodpecker.bolens.dev"
            or builder.username or builder.password or builder.query or builder.fragment
            or not re.fullmatch(r"/repos/13/pipeline/[1-9][0-9]*", builder.path)):
        raise ValueError("unexpected native builder")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", record.get("digest", "")) or not re.fullmatch(r"sha256:[0-9a-f]{64}", record.get("configDigest", "")):
        raise ValueError("invalid native image digest")
    expected = ASSETS - {"image-manifest.json"}
    if set(record.get("assets", {})) != expected or set(path.name for path in directory.iterdir()) != ASSETS:
        raise ValueError("native asset set differs from the release contract")
    for name, digest in record["assets"].items():
        file = directory / name
        if file.is_symlink() or not file.is_file() or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("unsafe native release asset")
        if hashlib.sha256(file.read_bytes()).hexdigest() != digest:
            raise ValueError("native release asset bytes differ from receipt")
    sbom = json.loads((directory / "sbom.spdx.json").read_text())
    if sbom.get("spdxVersion") != "SPDX-2.3" or not sbom.get("packages"):
        raise ValueError("missing native SPDX package inventory")
    provenance = json.loads((directory / "woodpecker-provenance.json").read_text())
    predicate = provenance.get("predicate", {})
    definition = predicate.get("buildDefinition", {})
    if (provenance.get("_type") != "https://in-toto.io/Statement/v1"
            or provenance.get("predicateType") != "https://slsa.dev/provenance/v1"
            or provenance.get("subject") != [{"name": IMAGE, "digest": {"sha256": record["digest"][7:]}}]
            or definition.get("buildType") != "https://woodpecker-ci.org/ci"
            or definition.get("externalParameters") != {"repository": REPOSITORY, "tag": tag, "commit": sha}
            or definition.get("resolvedDependencies") != [{"uri": "git+https://github.com/" + REPOSITORY, "digest": {"gitCommit": sha}}]
            or predicate.get("runDetails", {}).get("builder", {}).get("id") != "https://woodpecker.bolens.dev"
            or predicate.get("runDetails", {}).get("metadata", {}).get("invocationId") != record["builder"]):
        raise ValueError("native provenance source/subject/builder differs from receipt")
    return record, predicate


def verify_tag(sha, tag):
    ref = api(f"repos/{REPOSITORY}/git/ref/tags/{tag}")["object"]
    if ref["type"] != "tag":
        raise ValueError("bridge requires a signed annotated tag")
    signed = api(f"repos/{REPOSITORY}/git/tags/{ref['sha']}")
    if not signed["verification"]["verified"] or signed["object"].get("type") != "commit" or signed["object"].get("sha") != sha:
        raise ValueError("tag signature/source verification failed")
    if api(f"repos/{REPOSITORY}/compare/{sha}...main")["status"] not in {"ahead", "identical"}:
        raise ValueError("release source is not reachable from protected main")


def owned_draft(sha, tag):
    release = api(f"repos/{REPOSITORY}/releases/tags/{tag}")
    identity = os.environ.get("WOODPECKER_PUBLISHER_ID", "")
    if (not release["draft"] or release["target_commitish"] != sha
            or not re.fullmatch(r"[1-9][0-9]*", identity)
            or release.get("author", {}).get("id") != int(identity)
            or {asset["name"] for asset in release["assets"]} != ASSETS):
        raise ValueError("bridge requires an exact-source draft from the approved publisher")
    return release


def verify():
    sha, tag = context()
    verify_tag(sha, tag)
    release = owned_draft(sha, tag)
    OUTPUT.mkdir(parents=True)
    run("gh", "release", "download", tag, "--repo", REPOSITORY, "--dir", str(OUTPUT))
    record, predicate = validate_assets(OUTPUT, sha, tag)
    wait_for_native_success(api, REPOSITORY, sha, record["builder"], 13, ["woodpecker", "publishing"], "tag")
    run("docker", "pull", f"{IMAGE}@{record['digest']}")
    image = json.loads(run("docker", "image", "inspect", f"{IMAGE}@{record['digest']}"))[0]
    labels = image["Config"].get("Labels") or {}
    if (image["Id"] != record["configDigest"] or image["Os"] != "linux" or image["Architecture"] != "amd64" or image["Config"].get("User") != "node"
            or labels.get("org.opencontainers.image.revision") != sha
            or labels.get("org.opencontainers.image.source") != "https://github.com/" + REPOSITORY):
        raise ValueError("registry image differs from the native tested archive")
    # This bounded Docker lifecycle check is retained until the isolated native
    # runtime service is proven. It never starts the DNS updater or enables network.
    for fixture in ("uddns.multi.yaml", "uddns.failover.yaml"):
        run("docker", "run", "--rm", "--network=none", "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--cpus=2", "--memory=4g", "--memory-swap=4g",
            "--volume", str(Path("examples").resolve()) + ":/fixtures:ro",
            "--env", "UDDNS_CONFIG_FILE=/fixtures/" + fixture,
            f"{IMAGE}@{record['digest']}", "dist/cli.js", "check-config")
    (OUTPUT / "provenance-predicate.json").write_text(json.dumps(predicate) + "\n")
    (OUTPUT / "verified.json").write_text(json.dumps({**record, "release_id": release["id"]}) + "\n")
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write("digest=" + record["digest"] + "\n")


def stable_version(tag):
    return tuple(map(int, tag[1:].split("."))) if re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) else None


def inspect_alias(alias):
    result = subprocess.run(["skopeo", "inspect", f"docker://{IMAGE}:{alias}"], text=True,
                            capture_output=True, check=False, env=environment(), timeout=120)
    if result.returncode == 0:
        return json.loads(result.stdout)
    if "manifest unknown" in result.stderr.lower() or "name unknown" in result.stderr.lower():
        return None
    raise ValueError("could not establish registry alias state")


def alias_plan(tag, published_tag, minor, global_latest, digest):
    candidate = stable_version(tag)
    if candidate is None:
        return {"minor": False, "latest": False, "github_latest": False}
    published = stable_version(published_tag) if published_tag else None
    if published_tag and published is None:
        raise ValueError("published latest release has an unsupported version")
    versions = []
    for name, record in [("minor", minor), ("latest", global_latest)]:
        if record is None:
            versions.append(None)
            continue
        label = (record.get("Labels") or {}).get("org.opencontainers.image.version", "")
        version = stable_version("v" + label.removeprefix("v"))
        if version is None or (name == "minor" and version[:2] != candidate[:2]):
            raise ValueError("existing alias has an unknown or mismatched version; preserve it")
        if version == candidate and record.get("Digest") != digest:
            raise ValueError("existing alias has conflicting bytes for the same version")
        versions.append(version)
    minor_version, latest_version = versions
    return {"minor": minor_version is None or candidate > minor_version,
            "latest": (published is None or candidate > published)
                      and (latest_version is None or candidate > latest_version),
            "github_latest": published is None or candidate > published}


def promote():
    sha, tag = context()
    record = json.loads((OUTPUT / "verified.json").read_text())
    if (record["commit"], record["tag"]) != (sha, tag):
        raise ValueError("verified candidate belongs to another release")
    # Revalidate the live tag and owned draft after signing, before alias writes.
    verify_tag(sha, tag)
    release = owned_draft(sha, tag)
    if release["id"] != record["release_id"]:
        raise ValueError("native draft was replaced during signing")
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        run("gh", "release", "download", tag, "--repo", REPOSITORY, "--dir", directory)
        fresh, _ = validate_assets(Path(directory), sha, tag)
        if fresh != {key: value for key, value in record.items() if key != "release_id"}:
            raise ValueError("native draft bytes changed during signing")
    digest = record["digest"]
    run("cosign", "verify", "--certificate-identity", f"https://github.com/{REPOSITORY}/.github/workflows/release.yml@refs/tags/{tag}",
        "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", f"{IMAGE}@{digest}")
    run("gh", "attestation", "verify", f"oci://{IMAGE}@{digest}", "--repo", REPOSITORY,
        "--signer-workflow", REPOSITORY + "/.github/workflows/release.yml",
        "--source-digest", sha, "--source-ref", "refs/tags/" + tag)
    version = tag[1:]
    prior = inspect_alias(version)
    if prior is not None and prior["Digest"] != digest:
        raise ValueError("immutable version tag already refers to another image")
    try:
        current = api(f"repos/{REPOSITORY}/releases/latest")
        published_tag = current["tag_name"]
    except subprocess.CalledProcessError as error:
        if "HTTP 404" not in (error.stderr or ""):
            raise
        published_tag = None
    candidate = stable_version(tag)
    minor = version.rsplit(".", 1)[0] if candidate is not None else None
    plan = alias_plan(tag, published_tag, inspect_alias(minor) if minor else None,
                      inspect_alias("latest") if candidate is not None else None, digest)
    if prior is None:
        run("docker", "buildx", "imagetools", "create", "--prefer-index=false", "--tag", f"{IMAGE}:{version}", f"{IMAGE}@{digest}")
    for alias in ([minor] if plan["minor"] else []) + (["latest"] if plan["latest"] else []):
        run("docker", "buildx", "imagetools", "create", "--prefer-index=false", "--tag", f"{IMAGE}:{alias}", f"{IMAGE}@{digest}")
        if inspect_alias(alias)["Digest"] != digest:
            raise ValueError("promoted alias did not preserve the verified digest")
    if inspect_alias(version)["Digest"] != digest:
        raise ValueError("immutable version did not preserve the verified digest")
    api(f"repos/{REPOSITORY}/releases/{record['release_id']}", "PATCH", {
        "draft": False, "prerelease": candidate is None,
        "make_latest": "true" if plan["github_latest"] else "false"})



def pages_authorization():
    if os.environ.get("WOODPECKER_PUBLISHING_ENABLED") != "true":
        raise ValueError("native publication is disabled")
    sha, tag = context()
    verify_tag(sha, tag)
    release = api(f"repos/{REPOSITORY}/releases/tags/{tag}")
    identity = os.environ.get("WOODPECKER_PUBLISHER_ID", "")
    if (release.get("draft") or release.get("target_commitish") != sha
            or not re.fullmatch(r"[1-9][0-9]*", identity)
            or release.get("author", {}).get("id") != int(identity)):
        raise ValueError("Pages refresh requires the approved published native release")
    return sha, tag


def pages_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("hosted_pages", Path(__file__).with_name("woodpecker-publish.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def render_pages():
    sha, _ = pages_authorization()
    # Authentication is used only for authorization above; fetched source and
    # site render/validators run without tokens, leases or Git credentials.
    pages_module().render_pages(authorized_source=sha,
                                release_metadata=api(f"repos/{REPOSITORY}/releases/latest"))


def publish_pages():
    import time
    settings = api(f"repos/{REPOSITORY}/pages")
    if (settings.get("build_type") != "legacy"
            or settings.get("source") != {"branch": "gh-pages", "path": "/"}):
        raise ValueError("Pages must use the approved gh-pages branch source")
    commit = pages_module().publish_pages(authorize=pages_authorization,
                                         credentials=lambda: environment(auth=True), github_api=api)
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Pages push did not return an immutable branch commit")
    # Built-in-token pushes do not trigger Pages. Request its branch build
    # explicitly and prove the generated commit is the one actually built.
    requested = api(f"repos/{REPOSITORY}/pages/builds", "POST")
    if requested.get("status") not in {"queued", "building", "built"}:
        raise ValueError("Pages did not accept the explicit branch build")
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        build = api(f"repos/{REPOSITORY}/pages/builds/latest")
        if build.get("commit") == commit:
            if build.get("status") == "built" and not build.get("error", {}).get("message"):
                return
            if build.get("status") == "errored" or build.get("error", {}).get("message"):
                raise ValueError("the exact Pages branch commit failed to build")
        time.sleep(10)
    raise TimeoutError("Pages did not prove a successful build of the generated branch commit")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["verify", "promote", "render-pages", "publish-pages"])
    args = parser.parse_args()
    {"verify": verify, "promote": promote, "render-pages": render_pages, "publish-pages": publish_pages}[args.phase]()


if __name__ == "__main__":
    main()
