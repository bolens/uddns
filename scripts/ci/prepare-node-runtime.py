#!/usr/bin/env python3
"""Bootstrap the pinned managed Node runtime only in an explicit disposable CI container."""

import argparse
import os
import platform
import sys
from pathlib import Path


def prepare(environment, *, root=Path('/'), workspace=None, uid=None, system=None, machine=None):
    """Return the child environment; root/workspace overrides are fixture seams, never CLI options."""
    workspace = workspace or Path(__file__).resolve().parents[2]
    uid = os.geteuid() if uid is None else uid
    system = platform.system() if system is None else system
    machine = platform.machine() if machine is None else machine
    if (environment.get('UDDNS_CI_NODE_BOOTSTRAP') != 'true' or environment.get('CI') != 'true'
            or uid != 0 or system != 'Linux' or machine != 'x86_64'
            or not (root / '.dockerenv').is_file()):
        raise ValueError('managed Node bootstrap requires the explicit Linux amd64 CI container')
    declared_workspace = environment.get('CI_WORKSPACE')
    if (not isinstance(declared_workspace, str) or not declared_workspace
            or not Path(declared_workspace).is_absolute()
            or Path(declared_workspace).resolve() != workspace.resolve()):
        raise ValueError('managed Node bootstrap workspace mismatch')
    store = root / 'nix/store'
    if store.is_symlink() or not store.is_dir():
        raise ValueError('Nix store is missing or indirect')

    def nix_path(value, *, directory):
        path = Path(value)
        if not path.is_absolute():
            raise ValueError('runtime path must be absolute')
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(store.resolve()) or resolved == store.resolve():
            raise ValueError('runtime path must remain inside the Nix store')
        if directory:
            if not resolved.is_dir():
                raise ValueError('runtime library path is not a directory')
        elif not resolved.is_file() or not os.access(resolved, os.X_OK):
            raise ValueError('runtime linker is not executable')
        return resolved

    linker = nix_path(environment.get('UDDNS_CI_NODE_LINKER', ''), directory=False)
    if linker.name != 'ld-linux-x86-64.so.2':
        raise ValueError('unexpected managed Node ELF interpreter')
    libraries = environment.get('UDDNS_CI_NODE_LIBRARY_PATH', '').split(':')
    if not libraries or any(not value for value in libraries):
        raise ValueError('runtime library closure is missing')
    libraries = [nix_path(value, directory=True) for value in libraries]
    parent = root / 'lib64'
    if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
        raise ValueError('refuse an indirect or conflicting loader directory')
    if parent.exists() and (os.path.ismount(parent) or parent.stat().st_dev != root.stat().st_dev):
        raise ValueError('refuse a separate loader filesystem')
    destination = parent / linker.name
    if destination.exists() or destination.is_symlink():
        if (not destination.is_symlink() or not destination.exists()
                or destination.resolve(strict=True) != linker):
            raise ValueError('refuse to replace an existing ELF interpreter')
    else:
        parent.mkdir(mode=0o755, exist_ok=True)
        destination.symlink_to(linker)
    child = dict(environment)
    child['LD_LIBRARY_PATH'] = ':'.join(str(path) for path in libraries)
    return child


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(sys.argv[1:])
    command = args.command
    if command and command[0] == '--':
        command = command[1:]
    if not command:
        parser.error('a validation command is required')
    child = prepare(os.environ)
    os.execvpe(command[0], command, child)


if __name__ == '__main__':
    main()
