"""Root ledger capability: real Git objects, local remote, mocked token API."""
import importlib.util
from importlib.machinery import SourceFileLoader
import hashlib
import io
import resource
import struct
import zlib
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import review_ledger as ledger

spec = importlib.util.spec_from_file_location("ledger_signer_test", Path(__file__).parent / "signer/crq-signer.py")
signer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signer)
loader = SourceFileLoader("ledger_spool_test", str(Path(__file__).parent / "signer/spool-shell"))
spool = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(spool)


class LedgerSignerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"; self.repo.mkdir()
        self.remote = self.root / "remote.git"
        self.original_run = subprocess.run
        self.original_run(["git", "init", "--bare", "-q", str(self.remote)], check=True, capture_output=True)
        self.git("init", "-q"); self.git("config", "user.name", "fixture"); self.git("config", "user.email", "fixture@localhost")
        tree = self.git("mktree", input=b"")
        self.base = self.git("commit-tree", tree, "-m", "Genesis")
        self.git("push", str(self.remote), self.base + ":" + signer.LEDGER_REF)
        self.git("checkout", "--detach", self.base)

    def git(self, *args, input=None):
        return self.original_run(["git", *args], cwd=self.repo, input=input, check=True, capture_output=True).stdout.decode().strip()

    def candidate(self, *, name=None, mode=None, raw=None, reason="fixture"):
        value = ledger.event("job-state", "fixture", "2026-10-31T00:00:00Z", {
            "family": "fixture", "subject_id": "fixture", "job_id": "fixture:0",
            "generation": 0, "attempt": 1, "state": "pending", "failures": 0,
            "next_eligible_at": None, "reason": reason})
        name = name or ledger.record_path(value)
        self.record_name = name
        p = self.repo / name; p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(raw if raw is not None else ledger.canonical(value))
        if mode:
            p.unlink(); p.symlink_to("/etc/passwd")
        self.git("add", "-A"); self.git("commit", "-qm", "Append")
        head = self.git("rev-parse", "HEAD")
        transport = ledger.GitLedger(self.repo, push_commit=mock.Mock())
        transport.push(self.base, head)
        return head, transport.push_commit.call_args.args[2]

    def run_publication(self, head, bundle):
        def offline_git(args, **kwargs):
            self.assertNotIn("secret-fixture-token", " ".join(args))
            if args[0] != "/usr/bin/git":
                raise AssertionError("unexpected executable")
            if "push" in args:
                self.assertEqual(args[-1], head + ":refs/heads/cq/review-ledger")
                self.assertFalse(any(arg.startswith("--force") or arg.startswith("+") for arg in args))
            args = [str(self.remote) if value == "https://github.com/" + signer.REPO + ".git" else value for value in args]
            return self.original_run(args, **kwargs)
        with mock.patch.object(signer, "install_token", return_value="secret-fixture-token") as mint, \
             mock.patch.object(signer, "api") as api, \
             mock.patch.object(signer.subprocess, "run", side_effect=offline_git):
            try:
                signer.publish_ledger_commit(self.base, head, bundle)
            finally:
                mint.assert_called_once_with(signer.REPO, ledger_write=True)
                api.assert_called_once_with("DELETE", "installation/token", token="secret-fixture-token")

    def test_exact_commit_ff_push_and_response_loss_replay(self):
        head, bundle = self.candidate()
        self.run_publication(head, bundle)
        self.assertEqual(self.git("ls-remote", str(self.remote), signer.LEDGER_REF).split()[0], head)
        self.run_publication(head, bundle)
        self.assertEqual(len(self.git("ls-remote", str(self.remote)).splitlines()), 1)
        newer, newer_bundle = self.candidate(name="records/2026/10/" + "b" * 64 + ".json")
        with self.assertRaisesRegex(ValueError, "base moved"):
            self.run_publication(newer, newer_bundle)
        self.assertEqual(self.git("ls-remote", str(self.remote), signer.LEDGER_REF).split()[0], head)

    def test_bundle_cannot_substitute_another_commit(self):
        head, bundle = self.candidate()
        with self.assertRaisesRegex(ValueError, "exact ledger commit"):
            self.run_publication("f" * 40, bundle)
        self.assertEqual(self.git("ls-remote", str(self.remote), signer.LEDGER_REF).split()[0], self.base)

    def test_modification_wrong_path_symlink_and_non_ff_are_refused(self):
        for name, mode in (("main.txt", None), (None, "symlink")):
            with self.subTest(name=name, mode=mode):
                self.git("checkout", "--detach", self.base)
                head, bundle = self.candidate(name=name, mode=mode)
                with self.assertRaises(ValueError):
                    self.run_publication(head, bundle)
                self.assertEqual(self.git("ls-remote", str(self.remote), signer.LEDGER_REF).split()[0], self.base)
        self.git("checkout", "--detach", self.base)
        head, bundle = self.candidate()
        self.run_publication(head, bundle)
        (self.repo / self.record_name).write_text("changed\n")
        self.git("commit", "-am", "Modify existing record")
        changed = self.git("rev-parse", "HEAD")
        transport = ledger.GitLedger(self.repo, push_commit=mock.Mock())
        transport.push(head, changed)
        self.base = head
        with self.assertRaises(ValueError):
            self.run_publication(changed, transport.push_commit.call_args.args[2])

    def test_malformed_record_and_source_conflict_cannot_poison_ledger(self):
        head, bundle = self.candidate(raw=b"{}\n")
        with self.assertRaises(ValueError):
            self.run_publication(head, bundle)
        self.assertEqual(self.git("ls-remote", str(self.remote), signer.LEDGER_REF).split()[0], self.base)
        self.git("checkout", "--detach", self.base)
        head, bundle = self.candidate()
        self.run_publication(head, bundle)
        self.base = head
        conflict, body = self.candidate(reason="conflicting source evidence")
        with self.assertRaisesRegex(ValueError, "source evidence conflict"):
            self.run_publication(conflict, body)
        self.assertEqual(self.git("ls-remote", str(self.remote), signer.LEDGER_REF).split()[0], head)

    def test_compressed_object_abuse_has_kernel_resource_bounds_before_unpack(self):
        unit = (Path(__file__).parent / "signer/crq-ledger-publish@.service").read_text()
        for bound in ("MemoryMax=256M", "MemorySwapMax=0", "LimitAS=512M", "LimitFSIZE=64M",
                      "TemporaryFileSystem=/tmp:rw,nodev,nosuid,size=128M", "RuntimeMaxSec=330"):
            self.assertIn(bound, unit)
        # A tiny pack declares a multi-GiB blob. Run the real parser with an
        # address-space ceiling already applied, not after trusting its header.
        size = 4 * 1024**3
        encoded = bytearray()
        while size:
            encoded.append((size & 127) | (128 if size >> 7 else 0)); size >>= 7
        delta = b"\x01" + bytes(encoded) + b"\x90\x01"
        base_object = b"\x31" + zlib.compress(b"x")
        base_id = hashlib.sha1(b"blob 1\0x").digest()
        delta_object = bytes([(7 << 4) | len(delta)]) + base_id + zlib.compress(delta)
        pack = b"PACK" + struct.pack(">II", 2, 2) + base_object + delta_object
        pack += hashlib.sha1(pack).digest()
        def limit():
            resource.setrlimit(resource.RLIMIT_AS, (64 * 1024**2, 64 * 1024**2))
        result = self.original_run(["git", "index-pack", "--stdin"], cwd=self.repo, input=pack,
                                   capture_output=True, timeout=10, preexec_fn=limit)
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr.decode(), r"(?i)(out of memory|cannot allocate memory)")
        self.assertEqual(self.git("ls-remote", str(self.remote), signer.LEDGER_REF).split()[0], self.base)

    def test_write_token_endpoint_is_pinned_and_minimal(self):
        def endpoint(method, path, **kwargs):
            if method == "GET":
                return [{"id": signer.REVIEWER_INSTALLATION_ID, "account": {"login": signer.OWNER_LOGIN}}]
            self.assertEqual(kwargs["body"], {"repositories": ["cq-toolkit"], "permissions": {"contents": "write"}})
            return {"token": "fixture"}
        with mock.patch.object(signer, "app_jwt", return_value="jwt"), mock.patch.object(signer, "api", side_effect=endpoint):
            self.assertEqual(signer.install_token(signer.REPO, ledger_write=True), "fixture")
            with self.assertRaises(signer.Fatal):
                signer.install_token("other/repo", ledger_write=True)

    def test_entrypoint_rejects_nonroot_and_oversized_frame_without_mint(self):
        for uid, frame in ((1000, b"{}\n"), (0, b'{"base":"a","head":"b","bytes":67108865}\n')):
            with mock.patch.object(signer.os, "geteuid", return_value=uid), \
                 mock.patch.object(signer.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(frame))), \
                 mock.patch.object(signer.sys, "stdout", io.StringIO()) as output, \
                 mock.patch.object(signer, "install_token") as mint:
                self.assertEqual(signer.ledger_publish_entry(), 2)
                mint.assert_not_called()
                self.assertNotIn("token", output.getvalue())

    def test_promotion_and_ledger_credentials_have_disjoint_commands(self):
        for argv, command in ((["spool-shell"], "ledger-publish " + "a" * 40 + " " + "b" * 40),
                              (["spool-shell", "ledger-only"], "put promo-0123456789")):
            with mock.patch.object(spool.sys, "argv", argv), \
                 mock.patch.dict(spool.os.environ, {"SSH_ORIGINAL_COMMAND": command}), \
                 mock.patch.object(spool.socket, "socket") as connect:
                with self.assertRaisesRegex(ValueError, "outside transport capability"):
                    spool.main()
                connect.assert_not_called()
