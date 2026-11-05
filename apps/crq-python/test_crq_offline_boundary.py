"""Offline process boundary: captured launcher, private index, ambient env.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import os
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest import mock
from test_crq_fixtures import (
    OFFLINE_INDEXES,
    OFFLINE_REPOS,
    offline_git_boundary,
    offline_index_directory,
    setUpModule,
)

class OfflineBoundaryTest(unittest.TestCase):
    def test_process_capabilities_refused_before_captured_launcher(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td).resolve()
            OFFLINE_REPOS.add(repo)
            self.addCleanup(OFFLINE_REPOS.discard, repo)
            launcher = mock.Mock()
            boundary = offline_git_boundary(launcher, repo, [])
            callback = mock.Mock()
            forbidden = [{"preexec_fn": callback}, {"pass_fds": (3,)},
                         {"executable": "/bin/sh"}, {"shell": True},
                         {"user": 0}, {"group": 0}, {"extra_groups": []},
                         {"start_new_session": True}, {"process_group": 0},
                         {"umask": 0}, {"unknown_option": None},
                         {"close_fds": False}, {"stdout": 123},
                         {"text": "yes"}, {"env": {"X": object()}}]
            for options in forbidden:
                with self.subTest(option=next(iter(options))):
                    with self.assertRaises(AssertionError):
                        boundary(["git", "rev-parse", "HEAD"], cwd=repo, **options)
            launcher.assert_not_called()
            callback.assert_not_called()

    def test_ordinary_runner_shape_reaches_only_captured_launcher(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td).resolve()
            (repo / ".git").mkdir()
            OFFLINE_REPOS.add(repo)
            self.addCleanup(OFFLINE_REPOS.discard, repo)
            launcher = mock.Mock(return_value=mock.sentinel.child)
            boundary = offline_git_boundary(launcher, repo, [])
            child = boundary(["git", "rev-parse", "HEAD"], cwd=str(repo), env=None,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertIs(child, mock.sentinel.child)
            launcher.assert_called_once()
            argv = launcher.call_args.args[0]
            options = launcher.call_args.kwargs
            self.assertEqual(argv[0], "/usr/bin/git")
            self.assertEqual(argv[-2:], ["rev-parse", "HEAD"])
            self.assertEqual(set(options), {"cwd", "env", "close_fds", "stdin", "stdout", "stderr", "text"})
            self.assertEqual(options["cwd"], str(repo))
            self.assertIs(options["close_fds"], True)
            self.assertEqual(options["env"]["GIT_CONFIG_GLOBAL"], "/dev/null")

    def test_private_index_registration_controls_captured_launcher(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            repo = root / "repo"
            repo.mkdir()
            (repo / ".git").mkdir()
            OFFLINE_REPOS.add(repo)
            self.addCleanup(OFFLINE_REPOS.discard, repo)
            launcher = mock.Mock(return_value=mock.sentinel.child)
            boundary = offline_git_boundary(launcher, root, [])
            outside = root / "outside-index"
            outside.write_bytes(b"fixture")
            def denied(value):
                launcher.reset_mock()
                with self.assertRaises(AssertionError):
                    boundary(["git", "read-tree", "HEAD"], cwd=repo,
                             env={"GIT_INDEX_FILE": value})
                launcher.assert_not_called()
            denied(str(outside))
            denied("index")
            denied("")
            with offline_index_directory(repo, root) as directory:
                index = Path(directory) / "index"
                denied(str(index.parent / ".." / index.parent.name / "index"))
                for existing in (False, True):
                    if existing:
                        index.write_bytes(b"fixture")
                    launcher.reset_mock()
                    child = boundary(["git", "read-tree", "HEAD"], cwd=repo,
                                     env={"GIT_INDEX_FILE": str(index)})
                    self.assertIs(child, mock.sentinel.child)
                    launcher.assert_called_once()
                    self.assertEqual(launcher.call_args.kwargs["env"]["GIT_INDEX_FILE"], str(index))
                index.unlink()
                index.symlink_to(outside)
                denied(str(index))
                index.unlink()
                alias = root / "index-parent-alias"
                alias.symlink_to(index.parent, target_is_directory=True)
                denied(str(alias / "index"))
                alias.unlink()
                os.link(outside, index)
                denied(str(index))
                index.unlink()
                index.mkdir()
                denied(str(index))
                index.rmdir()
                lock = index.with_name("index.lock")
                lock.write_bytes(b"fixture")
                denied(str(index))
                lock.unlink()
                other = root / "other-repo"
                other.mkdir()
                (other / ".git").mkdir()
                OFFLINE_REPOS.add(other)
                try:
                    launcher.reset_mock()
                    with self.assertRaises(AssertionError):
                        boundary(["git", "read-tree", "HEAD"], cwd=other,
                                 env={"GIT_INDEX_FILE": str(index)})
                    launcher.assert_not_called()
                finally:
                    OFFLINE_REPOS.discard(other)
                saved_parent = root / "saved-index-parent"
                index.parent.rename(saved_parent)
                try:
                    index.parent.mkdir()
                    denied(str(index))  # Same name, different parent inode: refuse.
                    index.parent.rmdir()
                finally:
                    if index.parent.exists():
                        index.parent.rmdir()
                    saved_parent.rename(index.parent)
                # Exact registered parent is now missing; never recreate on launch.
                index.parent.rmdir()
                denied(str(index))
            self.assertNotIn(index, OFFLINE_INDEXES)
            denied(str(index))
            with self.assertRaisesRegex(RuntimeError, "fixture unwind"):
                with offline_index_directory(repo, root) as directory:
                    retired = Path(directory) / "index"
                    raise RuntimeError("fixture unwind")
            self.assertNotIn(retired, OFFLINE_INDEXES)
            self.assertFalse(retired.parent.exists())
            denied(str(retired))

    def test_default_index_and_ambient_env_are_confined(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td).resolve()
            OFFLINE_REPOS.add(repo)
            self.addCleanup(OFFLINE_REPOS.discard, repo)
            launcher = mock.Mock(return_value=mock.sentinel.child)
            boundary = offline_git_boundary(launcher, repo, [])
            def denied():
                launcher.reset_mock()
                with self.assertRaises(AssertionError):
                    boundary(["git", "add", "."], cwd=repo)
                launcher.assert_not_called()
            denied()  # Missing parent, not merely missing index.
            boundary(["git", "init", "-q"], cwd=repo)  # Captured MOCK only.
            (repo / ".git").mkdir()
            outside = repo / "outside-index"
            outside.write_bytes(b"fixture")
            with mock.patch.dict(os.environ, {"GIT_INDEX_FILE": str(outside)}):
                for options in ({}, {"env": None}, {"env": {}}):
                    launcher.reset_mock()
                    boundary(["git", "add", "."], cwd=repo, **options)
                    launcher.assert_called_once()
                    self.assertNotIn("GIT_INDEX_FILE", launcher.call_args.kwargs["env"])
            index = repo / ".git" / "index"
            index.symlink_to(outside)
            denied()
            index.unlink()
            os.link(outside, index)
            denied()
            index.unlink()
            (repo / ".git").rmdir()
            (repo / ".git").symlink_to(repo, target_is_directory=True)
            denied()
