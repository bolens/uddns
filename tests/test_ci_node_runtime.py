"""The CI-only loader adapter cannot modify ordinary host or conflicting paths."""

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'scripts/ci/prepare-node-runtime.py'
SPEC = importlib.util.spec_from_file_location('ci_node_runtime', MODULE)
assert SPEC is not None and SPEC.loader is not None
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


class CINodeRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        (self.root / '.dockerenv').touch()
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        self.library = self.root / 'nix/store/fixture-glibc/lib'
        self.library.mkdir(parents=True)
        self.linker = self.library / 'ld-linux-x86-64.so.2'
        self.linker.write_text('fixture executable, never invoked\n')
        self.linker.chmod(0o755)
        self.environment = {
            'CI': 'true', 'UDDNS_CI_NODE_BOOTSTRAP': 'true',
            'CI_WORKSPACE': str(self.workspace), 'UDDNS_CI_NODE_LINKER': str(self.linker),
            'UDDNS_CI_NODE_LIBRARY_PATH': str(self.library), 'LD_LIBRARY_PATH': '/untrusted',
            'PRESERVE_ME': 'existing-validation-environment',
        }
        self.destination = self.root / 'lib64/ld-linux-x86-64.so.2'

    def prepare(self, **kwargs):
        return RUNTIME.prepare(self.environment, root=self.root, workspace=self.workspace,
                               uid=kwargs.pop('uid', 0), system=kwargs.pop('system', 'Linux'),
                               machine=kwargs.pop('machine', 'x86_64'), **kwargs)

    def test_explicit_container_setup_is_idempotent_and_limits_library_search(self):
        child = self.prepare()
        self.assertTrue(self.destination.is_symlink())
        self.assertEqual(self.destination.resolve(), self.linker)
        inode = self.destination.lstat().st_ino
        self.assertEqual(self.prepare(), child)
        self.assertEqual(self.destination.lstat().st_ino, inode)
        self.assertEqual(child['LD_LIBRARY_PATH'], str(self.library))
        self.assertEqual(child['PRESERVE_ME'], self.environment['PRESERVE_ME'])
        self.assertEqual(self.environment['LD_LIBRARY_PATH'], '/untrusted')

    def test_host_wrong_platform_and_nonroot_are_denied_before_writes(self):
        for kwargs in [{'uid': 1000}, {'system': 'Darwin'}, {'machine': 'aarch64'}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.prepare(**kwargs)
        (self.root / '.dockerenv').unlink()
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.destination.parent.exists())

    def test_missing_false_optin_and_workspace_mismatch_are_denied(self):
        for key, value in [('UDDNS_CI_NODE_BOOTSTRAP', ''), ('UDDNS_CI_NODE_BOOTSTRAP', 'false'),
                           ('CI', 'false'), ('CI_WORKSPACE', ''), ('CI_WORKSPACE', '.'),
                           ('CI_WORKSPACE', 'workspace'), ('CI_WORKSPACE', str(self.root / 'other'))]:
            original = self.environment[key]
            self.environment[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.prepare()
            self.environment[key] = original
        self.environment.pop('CI_WORKSPACE')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.destination.parent.exists())

    def test_external_missing_nonexecutable_or_wrong_linker_are_denied(self):
        external = self.root / 'outside'
        external.write_text('untouched\n')
        external.chmod(0o755)
        for target in [external, self.linker.parent / 'missing', self.library]:
            self.environment['UDDNS_CI_NODE_LINKER'] = str(target)
            with self.subTest(target=target), self.assertRaises((ValueError, FileNotFoundError)):
                self.prepare()
        self.environment['UDDNS_CI_NODE_LINKER'] = str(self.linker)
        self.linker.chmod(0o644)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.destination.parent.exists())
        self.assertEqual(external.read_text(), 'untouched\n')

    def test_empty_external_or_non_directory_library_paths_are_denied(self):
        for value in ['', str(self.root), str(self.linker), str(self.library) + ':']:
            self.environment['UDDNS_CI_NODE_LIBRARY_PATH'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.prepare()
        self.assertFalse(self.destination.parent.exists())

    def test_conflicting_directory_file_and_dangling_link_are_preserved(self):
        self.destination.parent.mkdir()
        self.destination.write_text('existing loader\n')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.destination.read_text(), 'existing loader\n')
        self.destination.unlink()
        self.destination.symlink_to(self.root / 'absent')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.destination.readlink(), self.root / 'absent')
        self.destination.unlink()
        self.destination.parent.rmdir()
        self.destination.parent.symlink_to(self.library, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(self.destination.parent.readlink(), self.library)

    def test_loader_mount_is_refused(self):
        self.destination.parent.mkdir()
        with patch.object(RUNTIME.os.path, 'ismount', return_value=True), self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.destination.exists())

    def test_cli_executes_existing_gate_and_does_not_swallow_exec_failure(self):
        with patch.object(RUNTIME.sys, 'argv', ['prepare-node-runtime.py', '--', 'repo-check']), \
                patch.object(RUNTIME, 'prepare', return_value={'LD_LIBRARY_PATH': '/validated'}) as prepare, \
                patch.object(RUNTIME.os, 'execvpe', side_effect=OSError('fixture failure')) as execute:
            with self.assertRaises(OSError):
                RUNTIME.main()
        prepare.assert_called_once_with(RUNTIME.os.environ)
        execute.assert_called_once_with('repo-check', ['repo-check'], {'LD_LIBRARY_PATH': '/validated'})
