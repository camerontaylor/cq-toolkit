"""Signer hardening (#327 deferrals): post_final never raises, severity counts
keep all six levels, and the secret scan judges rename sides separately.
Isolated: every path, token mint and API call is patched; no network."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('crq_signer_under_test', ROOT / 'signer/crq-signer.py')
signer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signer)

IID = 'promo-0123456789'
BASE = 'a' * 40
BATCH = 'b' * 40


class SignerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name, value in {
            'STATE': self.root / 'state',
            'AUDIT_LOG': self.root / 'state/audit.log',
            'RESULTS': self.root / 'spool/results',
            'REQUESTS': self.root / 'spool/requests',
            'RUNTIME_CONFIG': self.root / 'runtime.json',
        }.items():
            patcher = mock.patch.object(signer, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        signer.REQUESTS.mkdir(parents=True)
        signer.RESULTS.mkdir(parents=True)

    def patch(self, name, value):
        patcher = mock.patch.object(signer, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    def audit_events(self):
        if not signer.AUDIT_LOG.exists():
            return []
        return [json.loads(line) for line in signer.AUDIT_LOG.read_text().splitlines()]


class PostFinalBestEffort(SignerTest):
    """Major #327 deferral: a runtime-config error must not escape post_final."""

    def setUp(self):
        super().setUp()
        self.api = mock.Mock(return_value={'id': 1})
        self.patch('api', self.api)
        self.patch('install_token', lambda repo: 'token')
        self.patch('newest_trusted_status', lambda token, repo, sha: None)

    def test_malformed_or_unreadable_runtime_config_is_a_failed_post(self):
        # None of these is Transient/RuntimeError/Fatal: each escaped before.
        cases = {
            'malformed JSON': (lambda p: p.write_text('{'), {'JSONDecodeError'}),
            'non-object config': (lambda p: p.write_text('["record_base"]'), {'AttributeError'}),
            'non-string record_base': (lambda p: p.write_text('{"record_base": 7}'),
                                       {'AttributeError', 'TypeError'}),
            'unreadable config': (lambda p: p.mkdir(), {'IsADirectoryError'}),
        }
        for case, (make, whys) in cases.items():
            with self.subTest(case=case):
                if signer.RUNTIME_CONFIG.is_dir():
                    signer.RUNTIME_CONFIG.rmdir()
                else:
                    signer.RUNTIME_CONFIG.unlink(missing_ok=True)
                make(signer.RUNTIME_CONFIG)
                self.assertIsNone(signer.post_final(IID, BATCH, 'error', f'review error main={BASE} crq#{IID}'))
                self.assertEqual(self.audit_events()[-1]['event'], 'post-failed')
                self.assertIn(self.audit_events()[-1]['why'], whys)
        self.api.assert_not_called()

    def test_an_unusable_state_dir_is_a_failed_post(self):
        self.root.joinpath('state-file').write_text('')
        self.patch('STATE', self.root / 'state-file')
        self.assertIsNone(signer.post_final(IID, BATCH, 'error', f'review error main={BASE} crq#{IID}'))
        self.api.assert_not_called()

    def test_orphan_recovery_closes_out_despite_a_malformed_config(self):
        signer.RUNTIME_CONFIG.write_text('{')
        req = {'v': 1, 'kind': 'promotion', 'item': IID, 'base_sha': BASE, 'batch_sha': BATCH,
               'requested_at': '2026-10-18T00:00:00Z'}
        signer.atomic_json(signer.STATE / 'claims' / f'{IID}.json',
                           {'request': req, 'request_sha256': 'c' * 64,
                            'validated_at': '2026-10-18T00:00:01Z'})
        signer.atomic_json(signer.RESULTS / f'{IID}.claimed', {'v': 1})
        (signer.REQUESTS / f'.{IID}.json.claiming').write_text('{}')

        signer.recover_orphans()  # previously raised and crash-looped the daemon

        result = json.loads((signer.RESULTS / f'{IID}.json').read_text())
        self.assertEqual((result['outcome'], result['posted_state']), ('interrupted', 'none'))
        self.assertFalse((signer.REQUESTS / f'.{IID}.json.claiming').exists())
        self.assertIn('orphan-recovered', [e['event'] for e in self.audit_events()])


def ndjson(*severities):
    lines = [{'type': 'finding', 'severity': s, 'fileName': 'src/x.ts', 'title': f'{s} finding'}
             for s in severities]
    lines.append({'type': 'complete', 'status': 'review_completed'})
    return ''.join(json.dumps(line) + '\n' for line in lines)


class SeverityCounts(SignerTest):
    """#327 deferral: results carry all six counts; only blocking rows decide."""

    def run_item(self, review):
        state = {'clean': False}
        posts, closed = [], []
        req = {'v': 1, 'kind': 'promotion', 'item': IID, 'base_sha': BASE, 'batch_sha': BATCH,
               'requested_at': '2026-10-18T00:00:00Z'}
        path = signer.REQUESTS / f'{IID}.json'
        path.write_text(json.dumps(req))

        def run_cli(run_dir, wt, run_base):
            run_dir.mkdir(parents=True)
            (run_dir / 'review.ndjson').write_text(review)
            return signer.classify(run_dir / 'review.ndjson', 0)

        def record_run(base, run_base, batch, outcome, clean):
            state['clean'] = clean

        for name, value in {
            'read_request': lambda p, expect_item=None: (req, 'c' * 64),
            'covered': lambda base, batch, runs: state['clean'],
            'cooldown_active': lambda: None,
            'starts_last_hour': lambda: 0,
            'install_token': lambda repo: 'token',
            'newest_trusted_status': lambda token, repo, sha: None,
            'validate_request': lambda req, token: None,
            'post_final': lambda iid, sha, st, desc: posts.append(st) or {'state': st},
            'secret_scan': lambda base, batch, out: True,
            'prepare_worktree': lambda iid, base, batch: self.root / 'wt',
            'remove_worktree': lambda wt: None,
            'load_runs': lambda: [],
            'delta_from': lambda base, batch, runs: None,
            'record_start': lambda iid, base, batch: None,
            'run_cli': run_cli,
            'record_run': record_run,
            'subject_moved': lambda base, batch, token: False,
            'close_out': lambda *args, **kw: closed.append(kw),
        }.items():
            self.patch(name, value)
        signer.process_request(path)
        self.assertEqual(len(closed), 1)
        return posts, closed[0]

    def test_a_clean_run_keeps_the_non_blocking_counts(self):
        posts, out = self.run_item(ndjson('minor', 'trivial', 'trivial', 'info'))
        self.assertEqual(posts, ['pending', 'success'])
        self.assertEqual(out['findings'], [])
        self.assertEqual(out['severity_counts'],
                         {'critical': 0, 'major': 0, 'minor': 1, 'trivial': 2, 'info': 1, 'none': 0})

    def test_a_blocked_run_keeps_every_count_and_lists_only_blocking_rows(self):
        posts, out = self.run_item(ndjson('major', 'minor', 'none'))
        self.assertEqual(posts, ['pending', 'failure'])
        self.assertEqual(out['blocking'], {'critical': 0, 'major': 1})
        self.assertEqual([f['severity'] for f in out['findings']], ['major'])
        self.assertEqual(out['severity_counts'],
                         {'critical': 0, 'major': 1, 'minor': 1, 'trivial': 0, 'info': 0, 'none': 1})


PATTERNS = """rules:
  - id: env-any
    regex: '.'
    path: '\\.env$'
  - id: txt-marker
    regex: 'MARKER'
    path: '\\.txt$'
"""


class RenameScan(SignerTest):
    """#327 deferral: rename sides are judged by their own path's policy."""

    def scan(self, diff):
        def git(*args, **kw):
            return PATTERNS if args[0] == 'show' else diff
        self.patch('git', git)
        self.patch('GITLEAKS', self.root / 'no-gitleaks')
        out = self.root / 'scan.json'
        signer.secret_scan(BASE, BATCH, out)
        return json.loads(out.read_text())['denylist_hits']

    def test_removed_lines_of_a_renamed_file_use_the_source_path(self):
        diff = '\n'.join([
            'diff --git a/secrets.env b/secrets.txt',
            'similarity index 50%',
            'rename from secrets.env',
            'rename to secrets.txt',
            '--- a/secrets.env',
            '+++ b/secrets.txt',
            '@@ -1 +1 @@',
            '-API_KEY=hunter2',
            '+MARKER',
        ])
        self.assertEqual(self.scan(diff), [
            {'rule': 'env-any', 'file': 'secrets.env', 'line': 8},
            {'rule': 'txt-marker', 'file': 'secrets.txt', 'line': 9},
        ])

    def test_added_and_deleted_files_keep_their_single_path(self):
        diff = '\n'.join([
            'diff --git a/new.env b/new.env',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/new.env',
            '@@ -0,0 +1 @@',
            '+A=1',
            'diff --git a/old.env b/old.env',
            'deleted file mode 100644',
            '--- a/old.env',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-B=2',
        ])
        self.assertEqual(self.scan(diff), [
            {'rule': 'env-any', 'file': 'new.env', 'line': 6},
            {'rule': 'env-any', 'file': 'old.env', 'line': 12},
        ])


if __name__ == '__main__':
    unittest.main()


class SpoolContractBehaviour(SignerTest):
    """signer/README.md: strict REQUEST and durable idempotency contract."""

    def request(self):
        return {'v': 1, 'kind': 'promotion', 'item': IID, 'base_sha': BASE,
                'batch_sha': BATCH, 'requested_at': '2026-10-18T00:00:00Z'}

    def test_valid_request_binds_the_exact_bytes_and_filename(self):
        import hashlib
        path = signer.REQUESTS / f'{IID}.json'
        raw = json.dumps(self.request()).encode()
        path.write_bytes(raw)
        request, digest = signer.read_request(path)
        self.assertEqual(request, self.request())
        self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
        renamed = path.with_name('promo-ffffffffff.json')
        path.rename(renamed)
        with self.assertRaises(signer.Reject):
            signer.read_request(renamed)

    def test_malformed_requests_never_reach_identity_or_paid_work(self):
        token = mock.Mock(side_effect=AssertionError('must not mint a token'))
        cli = mock.Mock(side_effect=AssertionError('must not start review'))
        self.patch('install_token', token)
        self.patch('run_cli', cli)
        cases = [dict(self.request(), v=True), dict(self.request(), extra='untrusted'),
                 dict(self.request(), base_sha='HEAD'), dict(self.request(), batch_sha=7),
                 dict(self.request(), requested_at='2026-02-30T00:00:00Z'),
                 dict(self.request(), kind='override'), [], None]
        path = signer.REQUESTS / f'{IID}.json'
        result_path = signer.RESULTS / f'{IID}.json'
        for request in cases:
            with self.subTest(request=request):
                result_path.unlink(missing_ok=True)
                path.write_text(json.dumps(request))
                signer.process_request(path)
                result = json.loads(result_path.read_text())
                self.assertEqual((result['outcome'], result['posted_state']), ('rejected', 'none'))
                self.assertFalse(path.exists())
        token.assert_not_called()
        cli.assert_not_called()

    def test_either_durable_marker_suppresses_replay_even_for_invalid_payload(self):
        token = mock.Mock(side_effect=AssertionError('replay reached token mint'))
        cli = mock.Mock(side_effect=AssertionError('replay reached CLI'))
        self.patch('install_token', token)
        self.patch('run_cli', cli)
        for suffix in ('json', 'claimed'):
            with self.subTest(marker=suffix):
                marker = signer.RESULTS / f'{IID}.{suffix}'
                marker.write_bytes(b'original durable evidence')
                path = signer.REQUESTS / f'{IID}.json'
                path.write_text('{invalid replay')
                signer.process_request(path)
                self.assertEqual(marker.read_bytes(), b'original durable evidence')
                self.assertFalse(path.exists())
                marker.unlink()
        token.assert_not_called()
        cli.assert_not_called()

    def test_symlinks_and_oversize_input_are_refused_without_reading_target(self):
        path = signer.REQUESTS / f'{IID}.json'
        target = self.root / 'private'
        target.write_text(json.dumps(self.request()))
        path.symlink_to(target)
        with self.assertRaises(signer.Reject):
            signer.read_request(path)
        self.assertEqual(json.loads(target.read_text()), self.request())
        path.unlink()
        path.write_bytes(b' ' * 4097)
        with self.assertRaises(signer.Reject):
            signer.read_request(path)

    def test_trusted_status_requires_all_identity_fields_and_newest_wins(self):
        self.patch('REVIEWER_BOT_LOGIN', 'fixture-reviewer[bot]')
        self.patch('REVIEWER_BOT_ID', 123456789)
        creator = {'login': 'fixture-reviewer[bot]', 'id': 123456789, 'type': 'Bot'}
        good = {'context': signer.STATUS_CONTEXT, 'state': 'failure', 'creator': creator}
        forged = [dict(good, creator=dict(creator, **change)) for change in
                  ({'id': 987654321}, {'login': 'lookalike[bot]'}, {'type': 'User'}, {'id': '123456789'})]
        old_success = dict(good, state='success')
        self.patch('commit_statuses', lambda *args: forged + [good, old_success])
        self.assertIs(signer.newest_trusted_status('unused', 'fixture/repo', BATCH), good)


class AppSignatureBehaviour(SignerTest):
    """Local ephemeral keys only; prove the App JWT signature binds its bytes."""

    def test_signature_verifies_only_for_the_original_header_and_claims(self):
        import base64
        import subprocess
        key = self.root / 'fixture.pem'
        metadata = self.root / 'fixture-app.json'
        public = self.root / 'fixture.pub'
        signature = self.root / 'signature.bin'
        self.patch('PEM', key)
        self.patch('APP_META', metadata)
        metadata.write_text(json.dumps({'id': signer.REVIEWER_APP_ID,
                                        'slug': 'cq-promotion-reviewer', 'client_id': 'fixture-client'}))
        subprocess.run([signer.OPENSSL, 'genpkey', '-algorithm', 'RSA', '-pkeyopt',
                        'rsa_keygen_bits:2048', '-out', str(key)], check=True, capture_output=True)
        subprocess.run([signer.OPENSSL, 'pkey', '-in', str(key), '-pubout', '-out', str(public)],
                       check=True, capture_output=True)
        header, claims, sig = signer.app_jwt().split('.')
        decode = lambda part: base64.urlsafe_b64decode(part + '=' * (-len(part) % 4))
        self.assertEqual(json.loads(decode(header)), {'alg': 'RS256', 'typ': 'JWT'})
        self.assertEqual(json.loads(decode(claims))['iss'], 'fixture-client')
        signature.write_bytes(decode(sig))
        verify = [signer.OPENSSL, 'dgst', '-sha256', '-verify', str(public), '-signature', str(signature)]
        original = f'{header}.{claims}'.encode()
        self.assertEqual(subprocess.run(verify, input=original, capture_output=True).returncode, 0)
        self.assertNotEqual(subprocess.run(verify, input=original + b'x', capture_output=True).returncode, 0)

    def test_forged_app_metadata_is_refused_before_signing(self):
        key = self.root / 'fixture.pem'
        key.write_text('deliberately not a key')
        metadata = self.root / 'fixture-app.json'
        metadata.write_text(json.dumps({'id': -1, 'slug': 'cq-promotion-reviewer',
                                        'client_id': 'untrusted'}))
        self.patch('PEM', key)
        self.patch('APP_META', metadata)
        run = mock.Mock(side_effect=AssertionError('must refuse before signing'))
        self.patch('run', run)
        with self.assertRaises(signer.Fatal):
            signer.app_jwt()
        run.assert_not_called()
