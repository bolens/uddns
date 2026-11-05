"""The validation profile cannot drift or discover publisher files."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/ci/sync-woodpecker-validation.py"
SPEC = importlib.util.spec_from_file_location("validation_profile", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
PROFILE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROFILE)


class ValidationProfileTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        source = self.root / ".woodpecker"
        source.mkdir()
        for name in PROFILE.VALIDATION_FILES:
            (source / name).write_bytes(b"steps: []\n")
        (source / "publishing.yml").write_bytes(b"from_secret: credential\n")

    def test_generation_preserves_bytes_and_excludes_publishers(self):
        PROFILE.sync(self.root, write=True)
        PROFILE.sync(self.root)
        PROFILE.sync(self.root, write=True)
        target = self.root / ".woodpecker-validation"
        self.assertEqual({p.name for p in target.iterdir()}, set(PROFILE.VALIDATION_FILES))
        for path in target.iterdir():
            self.assertEqual(path.read_bytes(), (self.root / ".woodpecker" / path.name).read_bytes())

    def test_missing_drift_and_unexpected_entries_fail_closed(self):
        with self.assertRaises(ValueError):
            PROFILE.sync(self.root)
        PROFILE.sync(self.root, write=True)
        target = self.root / ".woodpecker-validation"
        (target / PROFILE.VALIDATION_FILES[0]).write_bytes(b"changed\n")
        with self.assertRaises(ValueError):
            PROFILE.sync(self.root)
        PROFILE.sync(self.root, write=True)
        (target / "publishing.yml").write_bytes(b"unexpected\n")
        for write in (False, True):
            with self.assertRaises(ValueError):
                PROFILE.sync(self.root, write=write)

    def test_symlink_entries_are_rejected_without_writes(self):
        PROFILE.sync(self.root, write=True)
        target = self.root / ".woodpecker-validation"
        entry = target / PROFILE.VALIDATION_FILES[0]
        entry.unlink()
        entry.symlink_to(self.root / ".woodpecker" / entry.name)
        for write in (False, True):
            with self.assertRaises(ValueError):
                PROFILE.sync(self.root, write=write)
        entry.unlink()
        source = self.root / ".woodpecker" / PROFILE.VALIDATION_FILES[0]
        source.unlink()
        source.symlink_to(self.root / ".woodpecker" / "publishing.yml")
        with self.assertRaises(ValueError):
            PROFILE.sync(self.root, write=True)


    def test_credential_request_and_directory_symlink_are_rejected(self):
        source = self.root / ".woodpecker" / PROFILE.VALIDATION_FILES[0]
        for content in (
            b"environment: {KEY: {from_secret: lease}}\n",
            b"environment: {KEY: {from_secret : lease}}\n",
            b'environment: {KEY: {"from_secret": lease}}\n',
        ):
            source.write_bytes(content)
            with self.assertRaises(ValueError):
                PROFILE.sync(self.root, write=True)
        source.write_bytes(b"steps: []\n")
        target = self.root / ".woodpecker-validation"
        target.rmdir()
        target.symlink_to(self.root / ".woodpecker", target_is_directory=True)
        with self.assertRaises(ValueError):
            PROFILE.sync(self.root, write=True)


if __name__ == "__main__":
    unittest.main()
