"""Native image receipt, signing identity and monotonic publication contracts."""
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "scripts/ci/woodpecker-verify-image.py")
bridge = importlib.util.module_from_spec(SPEC)
with patch.object(sys, "path", [str(Path(SPEC.origin).parent), *sys.path]):
    SPEC.loader.exec_module(bridge)
SHA, DIGEST, CONFIG = "a" * 40, "sha256:" + "b" * 64, "sha256:" + "c" * 64
TAG = "v1.2.9"


def alias(version, digest="sha256:" + "d" * 64):
    return {"Digest": digest, "Labels": {"org.opencontainers.image.version": version}}


class ReceiptFixture:
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.predicate = {"buildDefinition": {"buildType": "https://woodpecker-ci.org/ci",
            "externalParameters": {"repository": bridge.REPOSITORY, "tag": TAG, "commit": SHA},
            "resolvedDependencies": [{"uri": "git+https://github.com/" + bridge.REPOSITORY,
                                      "digest": {"gitCommit": SHA}}]},
            "runDetails": {"builder": {"id": "https://woodpecker.bolens.dev"},
                           "metadata": {"invocationId": "https://woodpecker.bolens.dev/repos/13/pipeline/12"}}}
        self.provenance = {"_type": "https://in-toto.io/Statement/v1", "predicateType": "https://slsa.dev/provenance/v1",
            "subject": [{"name": bridge.IMAGE, "digest": {"sha256": DIGEST[7:]}}], "predicate": self.predicate}
        (self.directory / "sbom.spdx.json").write_text(json.dumps({"spdxVersion": "SPDX-2.3", "packages": [{"name": "fixture"}]}))
        (self.directory / "woodpecker-provenance.json").write_text(json.dumps(self.provenance))
        self.record = {"repository": bridge.REPOSITORY, "commit": SHA, "tag": TAG,
            "image": bridge.IMAGE, "digest": DIGEST, "configDigest": CONFIG,
            "builder": self.predicate["runDetails"]["metadata"]["invocationId"]}
        self.write_manifest()

    def write_manifest(self):
        self.record["assets"] = {name: hashlib.sha256((self.directory / name).read_bytes()).hexdigest()
                                 for name in ["sbom.spdx.json", "woodpecker-provenance.json"]}
        (self.directory / "image-manifest.json").write_text(json.dumps(self.record))



class ImageBridgeTests(ReceiptFixture, unittest.TestCase):
    def test_hosted_pages_uses_trusted_workflow_flag_without_variables_api(self):
        release = {"draft": False, "target_commitish": SHA, "author": {"id": 123}}
        with patch.dict(os.environ, {"WOODPECKER_PUBLISHING_ENABLED": "true", "WOODPECKER_PUBLISHER_ID": "123"}, clear=True), patch.object(bridge, "context", return_value=(SHA, TAG)), patch.object(bridge, "verify_tag"), patch.object(bridge, "api", return_value=release) as api:
            self.assertEqual(bridge.pages_authorization(), (SHA, TAG))
            api.assert_called_once_with(f"repos/{bridge.REPOSITORY}/releases/tags/{TAG}")
        for value in ("", "false"):
            with patch.dict(os.environ, {"WOODPECKER_PUBLISHING_ENABLED": value}, clear=True), patch.object(bridge, "api") as api:
                with self.assertRaisesRegex(ValueError, "disabled"):
                    bridge.pages_authorization()
                api.assert_not_called()

    def test_hosted_pages_explicitly_builds_and_verifies_the_pushed_branch_commit(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        push = Mock(return_value=SHA)
        replies = [{"build_type": "legacy", "source": {"branch": "gh-pages", "path": "/"}},
                   {"status": "queued"}, {"commit": SHA, "status": "built", "error": {"message": None}}]
        with patch.object(bridge, "pages_module", return_value=SimpleNamespace(publish_pages=push)), patch.object(bridge, "api", side_effect=replies) as api:
            bridge.publish_pages()
            push.assert_called_once()
            self.assertEqual(api.call_args_list[1].args, (f"repos/{bridge.REPOSITORY}/pages/builds", "POST"))
            self.assertEqual(api.call_args_list[2].args, (f"repos/{bridge.REPOSITORY}/pages/builds/latest",))
        with patch.object(bridge, "pages_module", return_value=SimpleNamespace(publish_pages=push)), patch.object(bridge, "api", return_value={"build_type": "workflow"}):
            push.reset_mock()
            with self.assertRaisesRegex(ValueError, "branch source"):
                bridge.publish_pages()
            push.assert_not_called()
        replies[-1] = {"commit": "d" * 40, "status": "built"}
        with patch.object(bridge, "pages_module", return_value=SimpleNamespace(publish_pages=push)), patch.object(bridge, "api", side_effect=replies), patch("time.monotonic", side_effect=[0, 1, 601]), patch("time.sleep"), self.assertRaisesRegex(TimeoutError, "generated branch commit"):
            bridge.publish_pages()

    def test_exact_native_receipt(self):
        self.assertEqual(bridge.validate_assets(self.directory, SHA, TAG), (self.record, self.predicate))

    def test_source_digest_asset_and_extra_file_tampering_denied(self):
        for field, wrong in [("repository", "fork/other"), ("commit", "d" * 40), ("tag", "v1.2.8"),
                             ("digest", "bad"), ("configDigest", "bad"), ("builder", "https://other.example/run"),
                             ("builder", "https://woodpecker.bolens.dev/repos/14/pipeline/12")]:
            with self.subTest(field=field):
                original = self.record[field]
                self.record[field] = wrong
                self.write_manifest()
                with self.assertRaises(ValueError):
                    bridge.validate_assets(self.directory, SHA, TAG)
                self.record[field] = original
        self.write_manifest()
        (self.directory / "unexpected").touch()
        with self.assertRaises(ValueError):
            bridge.validate_assets(self.directory, SHA, TAG)
        (self.directory / "unexpected").unlink()
        (self.directory / "sbom.spdx.json").write_text("changed")
        with self.assertRaises(ValueError):
            bridge.validate_assets(self.directory, SHA, TAG)

    def test_semantically_wrong_provenance_denied_even_when_hash_is_updated(self):
        self.provenance["subject"][0]["digest"]["sha256"] = "e" * 64
        (self.directory / "woodpecker-provenance.json").write_text(json.dumps(self.provenance))
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "provenance"):
            bridge.validate_assets(self.directory, SHA, TAG)

    def test_draft_requires_approved_producer_and_exact_asset_set(self):
        release = {"draft": True, "target_commitish": SHA, "author": {"id": 42},
                   "assets": [{"name": name} for name in bridge.ASSETS]}
        with patch.dict(os.environ, {"WOODPECKER_PUBLISHER_ID": "42"}), patch.object(bridge, "api", return_value=release):
            self.assertEqual(bridge.owned_draft(SHA, TAG), release)
            release["author"]["id"] = 99
            with self.assertRaises(ValueError):
                bridge.owned_draft(SHA, TAG)
            release["author"]["id"] = 42
            release["assets"].append({"name": "unreviewed"})
            with self.assertRaises(ValueError):
                bridge.owned_draft(SHA, TAG)

    def test_bridge_context_requires_exact_tag_workflow_and_checkout(self):
        values = {"GITHUB_ACTOR_ID": "352757955", "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": bridge.REPOSITORY,
                  "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REF_TYPE": "tag",
                  "GITHUB_REF_NAME": TAG, "GITHUB_REF": "refs/tags/" + TAG,
                  "GITHUB_WORKFLOW_REF": f"{bridge.REPOSITORY}/.github/workflows/release.yml@refs/tags/{TAG}",
                  "GITHUB_SHA": SHA}
        with patch.dict(os.environ, values, clear=True), patch.object(bridge, "run", side_effect=[SHA, ""]), patch.object(Path, "read_text", return_value=json.dumps({"version": TAG[1:]})):
            self.assertEqual(bridge.context(), (SHA, TAG))
        for key, value in [("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_REF_TYPE", "branch"),
                           ("GITHUB_WORKFLOW_REF", "other/workflow"), ("GITHUB_REPOSITORY", "fork/other")]:
            with self.subTest(key=key), patch.dict(os.environ, {**values, key: value}, clear=True), self.assertRaises(ValueError):
                bridge.context()

    def test_moved_or_unsigned_tag_is_denied(self):
        for signed in [{"verification": {"verified": False}, "object": {"type": "commit", "sha": SHA}},
                       {"verification": {"verified": True}, "object": {"type": "commit", "sha": "d" * 40}}]:
            with patch.object(bridge, "api", side_effect=[{"object": {"type": "tag", "sha": "tag-object"}}, signed]), self.assertRaises(ValueError):
                bridge.verify_tag(SHA, TAG)

    def test_backport_advances_only_its_minor(self):
        self.assertEqual(bridge.alias_plan(TAG, "v1.3.0", alias("1.2.8"), alias("1.3.0"), DIGEST),
                         {"minor": True, "latest": False, "github_latest": False})

    def test_no_alias_downgrade_or_prerelease_promotion(self):
        self.assertEqual(bridge.alias_plan("v1.2.7", "v1.3.0", alias("1.2.9"), alias("1.3.0"), DIGEST),
                         {"minor": False, "latest": False, "github_latest": False})
        self.assertEqual(bridge.alias_plan("v1.4.0-rc.1", "v1.3.0", None, None, DIGEST),
                         {"minor": False, "latest": False, "github_latest": False})

    def test_forward_release_and_partial_publication_do_not_regress_registry_latest(self):
        self.assertEqual(bridge.alias_plan("v1.3.1", "v1.3.0", alias("1.3.0"), alias("1.3.0"), DIGEST),
                         {"minor": True, "latest": True, "github_latest": True})
        self.assertEqual(bridge.alias_plan("v1.3.1", "v1.3.0", alias("1.3.0"), alias("1.4.0"), DIGEST),
                         {"minor": True, "latest": False, "github_latest": True})

    def test_alias_same_version_conflict_or_unknown_version_is_not_overwritten(self):
        for minor in [alias("1.2.9"), {"Digest": DIGEST}, alias("1.3.0")]:
            with self.subTest(minor=minor), self.assertRaises(ValueError):
                bridge.alias_plan(TAG, "v1.3.0", minor, alias("1.3.0"), DIGEST)
        self.assertEqual(bridge.alias_plan(TAG, "v1.2.8", alias("1.2.9", DIGEST), alias("1.2.9", DIGEST), DIGEST),
                         {"minor": False, "latest": False, "github_latest": True})

    def test_registry_auth_or_network_failure_is_not_an_absent_alias(self):
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "unauthorized")), self.assertRaises(ValueError):
            bridge.inspect_alias("latest")

    def test_immutable_version_conflict_denies_registry_writes(self):
        (self.directory / "verified.json").write_text(json.dumps({**self.record, "release_id": 10}))
        with patch.object(bridge, "OUTPUT", self.directory), patch.object(bridge, "context", return_value=(SHA, TAG)), patch.object(bridge, "verify_tag"), patch.object(bridge, "owned_draft", return_value={"id": 10}), patch.object(bridge, "validate_assets", return_value=(self.record, self.predicate)), patch.object(bridge, "run", return_value="") as command, patch.object(bridge, "inspect_alias", return_value=alias("1.2.9")):
            with self.assertRaisesRegex(ValueError, "immutable version"):
                bridge.promote()
            self.assertFalse(any(call.args[:4] == ("docker", "buildx", "imagetools", "create") for call in command.call_args_list))


class NativeFinalizerTests(ReceiptFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        source = Path(__file__).resolve().parents[1] / "scripts/ci/woodpecker-publish.py"
        specification = importlib.util.spec_from_file_location("native_publisher", source)
        self.native = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(self.native)
        self.local = self.directory
        self.release = {"draft": False, "id": 10, "target_commitish": SHA,
                        "author": {"id": 42}, "assets": [{"name": name} for name in bridge.ASSETS]}
        self.api_calls, self.commands = [], []
        self.first_tag = True
        self.missing_release = False

    def command(self, *arguments, **kwargs):
        import shutil
        self.commands.append(arguments)
        if arguments[:3] == ("gh", "release", "download"):
            destination = Path(arguments[arguments.index("--dir") + 1])
            names = [arguments[arguments.index("--pattern") + 1]] if "--pattern" in arguments else bridge.ASSETS
            for name in names:
                shutil.copyfile(self.local / name, destination / name)
            return ""
        if arguments[:2] == ("skopeo", "inspect"):
            return json.dumps({"Digest": DIGEST})
        return ""

    def host(self, path, method="GET", data=None):
        self.api_calls.append((path, method, data))
        if path.endswith("WOODPECKER_PUBLISHER_ID"):
            return {"value": "42"}
        if path.endswith("/releases/generate-notes"):
            return {"body": "Prepared fixture release"}
        if method == "POST" and path.endswith("/releases"):
            return {**self.release, "draft": True, "assets": []}
        if "/dispatches" in path:
            return None
        if path.endswith("/releases/10"):
            return {**self.release, "draft": False}
        if "/releases/tags/" in path:
            if self.first_tag:
                self.first_tag = False
                if self.missing_release:
                    raise subprocess.CalledProcessError(1, ["gh"], stderr="HTTP 404 Not Found")
                return self.release
            return {**self.release, "draft": False}
        raise AssertionError("unexpected fake host path")

    def finalize(self):
        with patch.object(self.native, "OUTPUT", self.local), patch.object(self.native, "guard", return_value=(SHA, TAG)), patch.object(self.native, "github_environment", return_value={}), patch.object(self.native, "api", side_effect=self.host), patch.object(self.native, "run", side_effect=self.command):
            self.native.finalize_release()

    def write_archive(self):
        import io
        import tarfile
        config = json.dumps({"os": "linux", "architecture": "amd64", "config": {"User": "node", "Labels": {
            "org.opencontainers.image.revision": SHA, "org.opencontainers.image.version": TAG[1:],
            "org.opencontainers.image.source": "https://github.com/" + bridge.REPOSITORY}}}).encode()
        name = "sha256:" + hashlib.sha256(config).hexdigest()
        manifest = json.dumps([{"Config": name, "RepoTags": [f"{bridge.IMAGE}:candidate-{SHA}-12"]}]).encode()
        with tarfile.open(self.local / "image.tar", "w") as archive:
            for filename, payload in [(name, config), ("manifest.json", manifest)]:
                member = tarfile.TarInfo(filename)
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
        return name

    def test_archive_config_is_bound_to_pipeline_source_version_platform_and_content(self):
        config = self.write_archive()
        with patch.object(self.native, "OUTPUT", self.local), patch.dict(os.environ, {"CI_PIPELINE_NUMBER": "12"}):
            self.assertEqual(self.native.archive_config(SHA, TAG), config)
            with self.assertRaises(ValueError):
                self.native.archive_config("e" * 40, TAG)
            with self.assertRaises(ValueError):
                self.native.archive_config(SHA, "v1.2.8")
            with patch.dict(os.environ, {"CI_PIPELINE_NUMBER": "13"}), self.assertRaises(ValueError):
                self.native.archive_config(SHA, TAG)

    def test_registry_config_mismatch_does_not_replace_native_receipt(self):
        self.write_archive()
        (self.local / "image.digest").write_text(DIGEST)
        before = (self.local / "image-manifest.json").read_bytes()
        image = {"Digest": DIGEST, "Labels": {"org.opencontainers.image.revision": SHA,
                 "org.opencontainers.image.source": "https://github.com/" + bridge.REPOSITORY}}
        with patch.object(self.native, "OUTPUT", self.local), patch.object(self.native, "guard", return_value=(SHA, TAG)), patch.object(self.native, "run", side_effect=[json.dumps(image), json.dumps({"config": {"digest": "sha256:" + "e" * 64}})]), patch.dict(os.environ, {"CI_PIPELINE_NUMBER": "12"}), self.assertRaisesRegex(ValueError, "config differs"):
            self.native.manifest()
        self.assertEqual((self.local / "image-manifest.json").read_bytes(), before)

    def test_completed_owned_release_is_verified_without_writes(self):
        self.finalize()
        self.assertFalse(any(method != "GET" for _, method, _ in self.api_calls))
        self.assertFalse(any(command[:3] == ("gh", "release", "upload") for command in self.commands))

    def test_foreign_author_is_denied_without_mutation(self):
        self.release["author"]["id"] = 99
        with self.assertRaises(ValueError):
            self.finalize()
        self.assertFalse(any(method != "GET" for _, method, _ in self.api_calls))

    def test_partial_owned_draft_only_uploads_missing_matching_assets(self):
        self.release["draft"] = True
        self.release["assets"] = [{"name": "image-manifest.json"}]
        self.finalize()
        uploads = [Path(command[-1]).name for command in self.commands if command[:3] == ("gh", "release", "upload")]
        self.assertEqual(set(uploads), {"sbom.spdx.json", "woodpecker-provenance.json"})
        self.assertFalse(any("--clobber" in command for command in self.commands))
        dispatch = next(data for path, method, data in self.api_calls if method == "POST" and path.endswith("/dispatches"))
        self.assertEqual(dispatch, {"ref": TAG, "inputs": {"woodpecker_bridge": "true"}})

    def test_new_release_starts_as_draft_and_never_selects_latest_implicitly(self):
        self.missing_release = True
        self.finalize()
        creation = next(data for path, method, data in self.api_calls if method == "POST" and path.endswith("/releases"))
        self.assertEqual((creation["draft"], creation["make_latest"], creation["target_commitish"]), (True, "false", SHA))


if __name__ == "__main__":
    unittest.main()
