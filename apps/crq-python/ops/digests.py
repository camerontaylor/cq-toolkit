"""Shared deploy artifact digests (crq-efficiency plan slice 4).

One implementation for the three hash helpers every deploy wrapper and the
deploy controller previously duplicated (as ``_sha256``/``digest``/``tree``/
``deps``). Ported from the F4-fixed ac13 wrapper structure
(``deploy-ac13-f4fix2.py``) and the controller's ``_sha256``.

Two tree algorithms, deliberately different:

* ``tree_digest`` — plain recursive hash of regular files (relative path +
  file digest, sorted) for ``dist``: a build output tree with no symlinks
  and no nondeterministic artifacts.
* ``deps_digest`` — symlink-aware entry hash for ``node_modules``: every
  entry contributes its kind and identity (``L<link target>``, ``F<digest>``,
  ``D``) rather than its transitive content, excluding the cache/state files
  that change without any dependency change (``.vite``, ``.vite-temp``,
  ``.modules.yaml``, ``.pnpm-workspace-state-v1.json``).

One function for both would be wrong: an equal deps digest means "the same
dependency graph", not "the same bytes"; an equal dist digest means "the
same bytes".
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

# Nondeterministic dependency entry names, excluded from deps_digest. A
# top-level directory with one of these names is excluded whole; a file with
# one of these names is excluded wherever it appears (package-local metadata
# like .modules.yaml sits inside its package directory).
DEPS_EXCLUDED_DIRS = frozenset({".vite", ".vite-temp"})
DEPS_EXCLUDED_FILES = frozenset({".modules.yaml", ".pnpm-workspace-state-v1.json"})
NUL_SEP = b"\x00"


def file_digest(path: Path) -> str:
    """sha256 hex digest of one file's bytes."""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tree_digest(root: Path) -> str:
    """Plain recursive hash of a regular-file tree (dist).

    Every regular file contributes ``<relative path>\\0<sha256>\\n`` under one
    running sha256, entries sorted by relative path so the digest is order-
    independent. Finding 8: every entry is inspected for kind FIRST: a
    symlink (to a file, a directory or a dangling target) or a special file
    refuses, wherever it appears; only then does a regular file contribute.
    Nothing in the tree is silently skipped, so a link to external
    executable content cannot leave the digest unchanged. An absent root
    refuses.
    """
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError("tree digest root must be an existing real directory: "
                         + str(root))
    digest = hashlib.sha256()
    paths = sorted(root.rglob("*"),
                   key=lambda p: str(p.relative_to(root)))
    for path in paths:
        relative = path.relative_to(root)
        if path.is_symlink():
            raise ValueError("unexpected symlink in dist tree: "
                             + str(relative))
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError("unexpected special entry in dist tree: "
                             + str(relative))
        digest.update(str(relative).encode() + NUL_SEP
                      + file_digest(path).encode() + b"\n")
    return digest.hexdigest()


def deps_digest(root: Path) -> str:
    """Symlink-aware dependency-tree hash (node_modules).

    Entries walk in relative-path order; each contributes
    ``<relative path>\\0<kind payload>\\n`` under one running sha256 where the
    payload is ``L`` plus the link target for a symlink, ``F`` plus the file
    sha256 for a regular file, ``D`` for a directory. Excluded: anything under
    a top-level ``.vite``/``.vite-temp`` directory and any ``.modules.yaml``/
    ``.pnpm-workspace-state-v1.json`` file. Other special entries refuse.
    """
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError("deps digest root must be an existing real directory: "
                         + str(root))
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda p: str(p.relative_to(root))):
        relative = path.relative_to(root)
        parts = relative.parts
        if parts[0] in DEPS_EXCLUDED_DIRS or parts[-1] in DEPS_EXCLUDED_FILES:
            continue
        if path.is_symlink():
            payload = b"L" + os.readlink(path).encode()
        elif path.is_file():
            payload = b"F" + file_digest(path).encode()
        elif path.is_dir():
            payload = b"D"
        else:
            raise ValueError("unexpected dependency entry (special file): "
                             + str(relative))
        digest.update(str(relative).encode() + b"\0" + payload + b"\n")
    return digest.hexdigest()
