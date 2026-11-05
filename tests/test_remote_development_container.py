"""Offline tracked-source container transfer and cleanup contracts."""
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


class RemoteDevelopmentContainerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="uddns-remote-adapter-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "home").mkdir()
        fixture_env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        fixture_env.update({"HOME": str(self.root / "home"), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
        self.repo = self.root / "checkout with spaces"
        (self.repo / "scripts").mkdir(parents=True)
        helper = Path(__file__).resolve().parents[1] / "scripts/check-development-container.sh"
        self.helper = self.repo / "scripts/check-development-container.sh"
        self.helper.write_bytes(helper.read_bytes())
        (self.repo / "source").mkdir()
        self.payloads = {"source/file.txt": "source", "-leading.txt": "dash", "space name.txt": "space", "line\nbreak.txt": "newline"}
        for name, content in self.payloads.items():
            (self.repo / name).write_text(content)
        (self.repo / "symbolic link").symlink_to("source/file.txt")
        os.link(self.repo / "source/file.txt", self.repo / "hard linked file.txt")
        (self.repo / ".gitignore").write_text(".env\nignored/\n")
        subprocess.run(["git", "init", "--quiet", str(self.repo)], check=True, env=fixture_env, timeout=10)
        subprocess.run(["git", "-C", str(self.repo), "add", "--", "."], check=True, env=fixture_env, timeout=10)
        (self.repo / ".env").write_text("fixture-secret")
        (self.repo / "untracked.txt").write_text("not transferred")
        (self.repo / "ignored").mkdir()
        (self.repo / "ignored/secret.txt").write_text("ignored fixture")
        self.log = self.root / "docker-log.jsonl"
        self.archive = self.root / "source.tar"
        self.engine = self.root / "mock-docker"
        self.engine.write_text(f"#!{sys.executable}\n" + '''import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ["DOCKER_TEST_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
if args[0] == "create":
    if os.environ.get("DOCKER_TEST_CREATE_EXIT"):
        sys.exit(int(os.environ["DOCKER_TEST_CREATE_EXIT"]))
    print("fixture-container")
elif args[0] == "cp":
    pathlib.Path(os.environ["DOCKER_TEST_ARCHIVE"]).write_bytes(sys.stdin.buffer.read())
    sys.exit(int(os.environ.get("DOCKER_TEST_COPY_EXIT", "0")))
elif args[0] == "start":
    sys.exit(int(os.environ.get("DOCKER_TEST_START_EXIT", "0")))
elif args[0] == "inspect":
    if os.environ.get("DOCKER_TEST_INSPECT_EXIT"):
        sys.exit(int(os.environ["DOCKER_TEST_INSPECT_EXIT"]))
    print(os.environ.get("DOCKER_TEST_COMMAND_EXIT", "0"))
elif args[0] == "rm":
    sys.exit(int(os.environ.get("DOCKER_TEST_REMOVE_EXIT", "0")))
''')
        self.engine.chmod(0o755)
        self.env = {**fixture_env, "CONTAINER_ENGINE": str(self.engine), "DOCKER_TEST_LOG": str(self.log), "DOCKER_TEST_ARCHIVE": str(self.archive)}

    def run_helper(self, image="fixture-image", **env):
        return subprocess.run(["bash", str(self.helper), image, "printf", "%s", "$HOME; a b"], env={**self.env, **env}, capture_output=True, text=True, timeout=10)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_archive_excludes_local_state_and_preserves_names_and_ownership(self):
        result = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        with tarfile.open(fileobj=io.BytesIO(self.archive.read_bytes())) as archive:
            names = {member.name for member in archive.getmembers()}
            self.assertNotIn("workspace/.git", names)
            self.assertNotIn("workspace/.env", names)
            self.assertNotIn("workspace/untracked.txt", names)
            self.assertNotIn("workspace/ignored/secret.txt", names)
            self.assertIn("workspace/source", names)
            self.assertTrue(archive.getmember("workspace/symbolic link").issym())
            self.assertEqual(archive.getmember("workspace/symbolic link").linkname, "source/file.txt")
            self.assertEqual(archive.extractfile("workspace/symbolic link").read(), b"source")
            self.assertEqual(archive.extractfile("workspace/hard linked file.txt").read(), b"source")
            for member in archive.getmembers():
                self.assertEqual((member.uid, member.gid), (10001, 10001))
            for name, content in self.payloads.items():
                self.assertEqual(archive.extractfile("workspace/" + name).read().decode(), content)
        calls = self.calls()
        self.assertEqual([call[0] for call in calls], ["create", "cp", "start", "inspect", "rm"])
        self.assertEqual(calls[0][-4:], ["fixture-image", "printf", "%s", "$HOME; a b"])
        self.assertEqual(calls[0][-5], "--")
        for option in ["--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "10001:10001"]:
            self.assertIn(option, calls[0])
        self.assertEqual(calls[-1], ["rm", "--force", "fixture-container"])

    def test_command_exit_status_is_preserved_and_container_removed(self):
        self.assertEqual(self.run_helper(DOCKER_TEST_COMMAND_EXIT="19").returncode, 19)
        self.assertEqual(self.calls()[-1], ["rm", "--force", "fixture-container"])

    def test_copy_failure_removes_container_without_starting(self):
        self.assertEqual(self.run_helper(DOCKER_TEST_COPY_EXIT="23").returncode, 23)
        self.assertEqual([call[0] for call in self.calls()], ["create", "cp", "rm"])

    def test_start_failure_removes_container(self):
        self.assertEqual(self.run_helper(DOCKER_TEST_START_EXIT="29").returncode, 29)
        self.assertEqual([call[0] for call in self.calls()], ["create", "cp", "start", "rm"])

    def test_inspect_failure_removes_container_and_preserves_error(self):
        self.assertEqual(self.run_helper(DOCKER_TEST_INSPECT_EXIT="31").returncode, 31)
        self.assertEqual(self.calls()[-1], ["rm", "--force", "fixture-container"])

    def test_cleanup_failure_preserves_the_command_error(self):
        self.assertEqual(self.run_helper(DOCKER_TEST_COMMAND_EXIT="19", DOCKER_TEST_REMOVE_EXIT="37").returncode, 19)

    def test_cleanup_failure_fails_a_successful_command(self):
        self.assertEqual(self.run_helper(DOCKER_TEST_REMOVE_EXIT="37").returncode, 1)

    def test_create_failure_does_not_transfer_or_start_source(self):
        self.assertEqual(self.run_helper(DOCKER_TEST_CREATE_EXIT="41").returncode, 41)
        self.assertEqual([call[0] for call in self.calls()], ["create"])

    def test_archive_failure_does_not_start_partial_source(self):
        (self.repo / "source/file.txt").unlink()
        self.assertNotEqual(self.run_helper().returncode, 0)
        self.assertEqual([call[0] for call in self.calls()], ["create", "cp", "rm"])

    def test_image_argument_cannot_override_container_options(self):
        self.assertEqual(self.run_helper(image="--privileged").returncode, 0)
        self.assertEqual(self.calls()[0][-5:], ["--", "--privileged", "printf", "%s", "$HOME; a b"])


if __name__ == "__main__":
    unittest.main()
