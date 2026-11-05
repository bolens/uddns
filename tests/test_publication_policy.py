"""Publication authorization and immutable-candidate denial cases, without network writes."""
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/ci/woodpecker-publish.py"
spec = importlib.util.spec_from_file_location("publisher", SOURCE)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
SHA = "a" * 40


class PublicationPolicyTests(unittest.TestCase):
    def setUp(self):
        self.env = {"CI_FORGE_TYPE": "github", "CI_FORGE_URL": "https://github.com",
                    "CI_REPO": publisher.REPOSITORY, "CI_COMMIT_SHA": SHA,
                    "CI_PIPELINE_NUMBER": "12", "CI_PIPELINE_URL": "https://ci.example/p/12"}
        if publisher.REPOSITORY == "bolens/audio-utils":
            self.env.update(CI_PIPELINE_EVENT="push", CI_COMMIT_BRANCH="main",
                            CI_COMMIT_REF="refs/heads/main")
        else:
            self.env.update(CI_PIPELINE_EVENT="tag", CI_COMMIT_TAG="v1.2.3",
                            CI_COMMIT_REF="refs/tags/v1.2.3")
        self.environment = patch.dict(os.environ, self.env, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.git = patch.object(publisher, "run", side_effect=lambda *a, **kw: SHA if a[1:] == ("rev-parse", "HEAD") else "")
        self.git.start()
        self.addCleanup(self.git.stop)

    def test_lease_is_redeemed_at_fixed_endpoint_and_cached_without_trace_env(self):
        reply = io.BytesIO(json.dumps({"token": "unit-test-token", "expires_at": "1970-01-01T01:23:20Z"}).encode())
        with patch.dict(os.environ, {"WOODPECKER_PUBLISH_LEASE": "unit-test-lease", "GH_DEBUG": "api", "GIT_TRACE": "1"}), patch.object(publisher, "_GITHUB_CREDENTIAL", None), patch("time.time", return_value=1000), patch("urllib.request.build_opener") as build:
            build.return_value.open.return_value = reply
            first = publisher.github_environment()
            second = publisher.github_environment()
            self.assertEqual(first["GH_TOKEN"], "unit-test-token")
            self.assertEqual(second["GH_HOST"], "github.com")
            self.assertFalse({"GH_DEBUG", "GIT_TRACE", "WOODPECKER_PUBLISH_LEASE"} & first.keys())
            build.return_value.open.assert_called_once()
            request = build.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, publisher.CREDENTIAL_ENDPOINT)
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.get_header("User-agent"), "woodpecker-publisher/1")
            body = json.loads(request.data)
            self.assertRegex(body.pop("request_id"), "^[0-9a-f]{32}$")
            self.assertEqual(body, {"lease": "unit-test-lease", "repository": publisher.REPOSITORY, "commit": SHA, "purpose": "github"})
            self.assertIsNone(build.call_args.args[0].redirect_request(None, None, 302, "", {}, "https://other.example"))

    def test_nearly_expired_token_refreshes_and_redemption_errors_are_redacted(self):
        reply = io.BytesIO(json.dumps({"token": "refreshed-test-token", "expires_at": 5000}).encode())
        with patch.dict(os.environ, {"WOODPECKER_PUBLISH_LEASE": "unit-test-lease"}), patch.object(publisher, "_GITHUB_CREDENTIAL", ("old-test-token", 1100)), patch("time.time", return_value=1000), patch("urllib.request.build_opener") as build:
            build.return_value.open.return_value = reply
            self.assertEqual(publisher.github_environment()["GH_TOKEN"], "refreshed-test-token")
            build.return_value.open.assert_called_once()
        with patch.dict(os.environ, {"WOODPECKER_PUBLISH_LEASE": "unit-test-lease"}), patch.object(publisher, "_GITHUB_CREDENTIAL", None), patch("urllib.request.build_opener") as build:
            build.return_value.open.side_effect = RuntimeError("unit-test-lease must not leak")
            with self.assertRaisesRegex(RuntimeError, "^publication credential redemption failed$"):
                publisher.github_environment()

    def test_local_subprocesses_do_not_inherit_credentials_or_trace_settings(self):
        self.git.stop()
        with patch.dict(os.environ, {"GH_TOKEN": "unit-test-token", "GITHUB_TOKEN": "other-test-token", "WOODPECKER_PUBLISH_LEASE": "unit-test-lease", "GIT_TRACE": "1", "GH_DEBUG": "api"}), patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")) as process:
            publisher.run("git", "status", "--porcelain")
            environment = process.call_args.kwargs["env"]
            self.assertFalse({"GH_TOKEN", "GITHUB_TOKEN", "WOODPECKER_PUBLISH_LEASE", "GIT_TRACE", "GH_DEBUG"} & environment.keys())
            self.assertEqual(environment["GIT_CONFIG_GLOBAL"], "/dev/null")

    def test_exact_native_context(self):
        self.assertEqual(publisher.context()[0], SHA)

    def test_wrong_forge_url_repository_and_event_denied_before_api(self):
        for key, value in [("CI_FORGE_TYPE", "gitea"), ("CI_FORGE_URL", "https://attacker.example"),
                           ("CI_REPO", "fork/other"), ("CI_PIPELINE_EVENT", "pull_request"),
                           ("CI_PIPELINE_EVENT", "manual"), ("CI_COMMIT_REF", "refs/heads/feature")]:
            with self.subTest(key=key, value=value), patch.dict(os.environ, {key: value}), patch.object(publisher, "api") as api:
                with self.assertRaises(ValueError):
                    publisher.guard()
                api.assert_not_called()

    def test_modified_or_wrong_checkout_denied(self):
        for answers in [["b" * 40], [SHA, " M package.json"]]:
            with self.subTest(answers=answers), patch.object(publisher, "run", side_effect=answers), self.assertRaises(ValueError):
                publisher.context()

    def test_disabled_and_unreadable_setting_deny_writes(self):
        for value in [{"value": "false"}, {}, subprocess.CalledProcessError(1, ["gh", "api"])]:
            with self.subTest(value=value):
                kwargs = {"side_effect": value} if isinstance(value, Exception) else {"return_value": value}
                with patch.object(publisher, "api", **kwargs), self.assertRaises(publisher.PublicationDisabled):
                    publisher.guard()

    def test_existing_immutable_image_denied(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(publisher, "OUTPUT", Path(directory)), patch.object(publisher, "guard", return_value=(SHA, "")), patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "{}", "")):
            with self.assertRaises(ValueError):
                publisher.prepare()
            self.assertFalse((Path(directory) / "kaniko.env").exists())

    def test_retry_of_existing_candidate_denied(self):
        replies = [subprocess.CompletedProcess([], 1, "", "manifest unknown"),
                   subprocess.CompletedProcess([], 0, "{}", "")]
        with tempfile.TemporaryDirectory() as directory, patch.object(publisher, "OUTPUT", Path(directory)), patch.object(publisher, "guard", return_value=(SHA, "")), patch.object(subprocess, "run", side_effect=replies) as probe:
            with self.assertRaises(ValueError):
                publisher.prepare()
            self.assertEqual(probe.call_count, 2)
            self.assertTrue(probe.call_args.args[0][-1].endswith(f":candidate-{SHA}-12"))
            self.assertFalse((Path(directory) / "kaniko.env").exists())

    def test_network_or_auth_failure_does_not_imply_image_absence(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(publisher, "OUTPUT", Path(directory)), patch.object(publisher, "guard", return_value=(SHA, "")), patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "unauthorized")):
            with self.assertRaises(ValueError):
                publisher.prepare()
            self.assertFalse((Path(directory) / "kaniko.env").exists())

    def test_build_tag_is_per_pipeline_candidate_without_alias(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(publisher, "OUTPUT", Path(directory)), patch.object(publisher, "guard", return_value=(SHA, "")), patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "manifest unknown")):
            publisher.prepare()
            self.assertEqual((Path(directory) / "kaniko.env").read_text().splitlines()[0], f"PLUGIN_TAGS=candidate-{SHA}-12")
            self.assertIn("org.opencontainers.image.revision=" + SHA, (Path(directory) / "kaniko.env").read_text())

    def test_manifest_rejects_foreign_revision(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(publisher, "OUTPUT", Path(directory)), patch.object(publisher, "guard", return_value=(SHA, "")), patch.object(publisher, "run", return_value='{"Digest":"sha256:' + "b" * 64 + '","Labels":{"org.opencontainers.image.revision":"foreign"}}'):
            (Path(directory) / "image.digest").write_text("sha256:" + "b" * 64)
            with self.assertRaises(ValueError):
                publisher.manifest()
            self.assertFalse((Path(directory) / "image-manifest.json").exists())


class PagesPublicationTests(unittest.TestCase):
    def test_site_tree_rejects_symlinks_and_git_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "index.html").write_text("public")
            (root / "link").symlink_to("index.html")
            with self.assertRaises(ValueError):
                publisher.site_files(root)
            (root / "link").unlink()
            (root / ".git").mkdir()
            (root / ".git/config").write_text("private")
            with self.assertRaises(ValueError):
                publisher.site_files(root)

    def test_main_push_is_accepted_for_pages_but_not_image_publication(self):
        environment = {"CI_FORGE_TYPE": "github", "CI_FORGE_URL": "https://github.com",
                       "CI_REPO": publisher.REPOSITORY, "CI_PIPELINE_EVENT": "push",
                       "CI_COMMIT_BRANCH": "main", "CI_COMMIT_REF": "refs/heads/main",
                       "CI_COMMIT_SHA": SHA}
        with patch.dict(os.environ, environment, clear=True), patch.object(publisher, "run", side_effect=[SHA, ""]):
            self.assertEqual(publisher.context("push"), (SHA, ""))
            with self.assertRaises(ValueError):
                publisher.context()

    def test_public_site_validation_resolves_canonical_tag_without_rest_or_credentials(self):
        from unittest.mock import MagicMock
        response = MagicMock()
        response.__enter__.return_value.geturl.return_value = "https://github.com/bolens/uddns/releases/tag/v1.2.3"
        with patch("urllib.request.urlopen", return_value=response) as request:
            self.assertEqual(publisher.public_release(), {"id": None, "tag_name": "v1.2.3"})
            outgoing = request.call_args.args[0]
            self.assertEqual(outgoing.method, "HEAD")
            self.assertEqual(outgoing.full_url, "https://github.com/bolens/uddns/releases/latest")
            self.assertNotIn("Authorization", outgoing.headers)
            response.__enter__.return_value.geturl.return_value = "https://other.example/releases/tag/v1.2.3"
            with self.assertRaisesRegex(ValueError, "not canonical"):
                publisher.public_release()

    def test_prepared_release_metadata_is_bound_to_source_and_has_no_bearer(self):
        release = {"id": 10, "tag_name": "v1.2.3"}
        with tempfile.TemporaryDirectory() as directory, patch.object(publisher, "OUTPUT", Path(directory)), patch.object(publisher, "guard", return_value=(SHA, "")), patch.object(publisher, "api", return_value=release) as api, patch.object(publisher, "public_release") as public:
            publisher.prepare_pages()
            api.assert_called_once_with(f"repos/{publisher.REPOSITORY}/releases/latest")
            self.assertEqual(publisher.pages_release(SHA), release)
            self.assertEqual(set(json.loads((Path(directory) / "pages-release.json").read_text())), {"repository", "commit", "release"})
            public.assert_not_called()
            with self.assertRaisesRegex(ValueError, "another source"):
                publisher.pages_release("d" * 40)

    def test_tag_only_public_validation_cannot_authorize_pages_push(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(publisher, "OUTPUT", Path(directory)), patch.object(publisher, "guard", return_value=(SHA, "")), patch.object(publisher, "api") as api:
            site = Path(directory) / "site"
            site.mkdir()
            (site / "index.html").write_text("public")
            record = {"repository": publisher.REPOSITORY, "commit": SHA, "release_id": None,
                      "pagesSourceSHA": SHA, "files": publisher.site_files(site), "release": "v1.2.3"}
            (Path(directory) / "pages-manifest.json").write_text(json.dumps(record))
            with self.assertRaisesRegex(ValueError, "identity changed"):
                publisher.publish_pages()
            api.assert_not_called()

    def test_pages_modified_after_render_cannot_push(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(publisher, "OUTPUT", Path(directory)), patch.object(publisher, "guard", return_value=(SHA, "")), patch.object(publisher, "api") as api:
            site = Path(directory) / "site"
            site.mkdir()
            (site / "index.html").write_text("original")
            record = {"repository": publisher.REPOSITORY, "commit": SHA,
                      "pagesSourceSHA": SHA, "files": publisher.site_files(site), "release_id": 10, "release": "v1.2.3"}
            (Path(directory) / "pages-manifest.json").write_text(json.dumps(record))
            (site / "index.html").write_text("changed")
            with self.assertRaises(ValueError):
                publisher.publish_pages()
            api.assert_not_called()

    def test_new_release_before_push_cannot_append_stale_metadata(self):
        replies = [{"sha": SHA}, {"id": 10, "tag_name": "v1.2.3"},
                   {"sha": SHA}, {"id": 11, "tag_name": "v1.2.4"}]
        with tempfile.TemporaryDirectory() as directory, patch.object(publisher, "OUTPUT", Path(directory)), patch.object(publisher, "guard", return_value=(SHA, "")), patch.object(publisher, "api", side_effect=replies), patch.object(publisher, "github_environment", return_value={"GH_TOKEN": "unit-test-token"}), patch.object(publisher, "run", return_value="existing-branch") as git:
            site = Path(directory) / "site"
            site.mkdir()
            (site / "index.html").write_text("public")
            record = {"repository": publisher.REPOSITORY, "commit": SHA,
                      "pagesSourceSHA": SHA, "files": publisher.site_files(site),
                      "release_id": 10, "release": "v1.2.3"}
            (Path(directory) / "pages-manifest.json").write_text(json.dumps(record))
            with self.assertRaisesRegex(ValueError, "release changed before push"):
                publisher.publish_pages()
            self.assertFalse(any(call.args[:2] == ("git", "push") for call in git.call_args_list))

    def test_pages_push_preserves_history_and_keeps_auth_out_of_argv(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(publisher, "OUTPUT", Path(directory)), patch.object(publisher, "guard", return_value=(SHA, "")), patch.object(publisher, "api", return_value={"id": 10, "tag_name": "v1.2.3", "sha": SHA}), patch.object(publisher, "github_environment", side_effect=[{"GH_TOKEN": "unit-test-token"}, {"GH_TOKEN": "refreshed-test-token"}]), patch.object(publisher, "run", return_value="existing-branch") as git:
            site = Path(directory) / "site"
            site.mkdir()
            (site / "index.html").write_text("public")
            (site / ".nojekyll").touch()
            record = {"repository": publisher.REPOSITORY, "commit": SHA,
                      "pagesSourceSHA": SHA, "files": publisher.site_files(site), "release_id": 10, "release": "v1.2.3"}
            (Path(directory) / "pages-manifest.json").write_text(json.dumps(record))
            publisher.publish_pages()
            commands = [call.args for call in git.call_args_list]
            self.assertTrue(any(command[:3] == ("git", "reset", "--soft") for command in commands))
            push = next(call for call in git.call_args_list if call.args[:2] == ("git", "push"))
            self.assertEqual(push.args[2:], (f"https://github.com/{publisher.REPOSITORY}.git", "HEAD:refs/heads/gh-pages"))
            self.assertFalse(any("unit-test-token" in str(command) or "--force" in command for command in commands))
            self.assertEqual(push.kwargs["env"]["GIT_CONFIG_VALUE_0"], "")
            import base64
            self.assertEqual(base64.b64decode(push.kwargs["env"]["GIT_CONFIG_VALUE_1"].split()[-1]).decode(), "x-access-token:refreshed-test-token")
            self.assertNotIn("GH_TOKEN", push.kwargs["env"])


if __name__ == "__main__":
    unittest.main()
