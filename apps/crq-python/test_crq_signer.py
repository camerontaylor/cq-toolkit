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
