#!/usr/bin/env python3
"""Generate or verify the credential-free Woodpecker discovery profile."""

import argparse
from pathlib import Path

VALIDATION_FILES = ('woodpecker.yml',)


def sync(root: Path, *, write: bool = False) -> None:
    """Keep only the explicit validation allowlist, byte-for-byte."""
    source = root / ".woodpecker"
    target = root / ".woodpecker-validation"
    if source.is_symlink() or target.is_symlink():
        raise ValueError("workflow directories must not be symlinks")
    expected = {name: (source / name) for name in VALIDATION_FILES}
    for path in expected.values():
        if path.is_symlink() or not path.is_file():
            raise ValueError("canonical validation workflow is missing or unsafe")
    if target.exists():
        if not target.is_dir():
            raise ValueError("validation profile must be a directory")
        if {path.name for path in target.iterdir()} - expected.keys():
            raise ValueError("validation profile contains unexpected files")
    elif write:
        target.mkdir()
    else:
        raise ValueError("validation profile is missing; regenerate with --write")
    for name, original in expected.items():
        destination = target / name
        if destination.is_symlink() or (destination.exists() and not destination.is_file()):
            raise ValueError("validation profile entry is unsafe")
        content = original.read_bytes()
        if b"from_secret" in content.lower():
            raise ValueError("validation workflow requests a credential")
        if write:
            destination.write_bytes(content)
        elif not destination.is_file() or destination.read_bytes() != content:
            raise ValueError("validation profile drift; regenerate with --write")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()
    try:
        sync(Path(__file__).resolve().parents[2], write=args.write)
    except ValueError as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
