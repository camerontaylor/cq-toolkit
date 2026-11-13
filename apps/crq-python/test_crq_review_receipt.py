"""Whole-PR receipt contracts, replay and App transport, with offline fixtures."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import crq
import crq_review_identity as identity
import crq_review_receipt as receipt
import pr_review_findings as prf
from test_pr_review_findings import BASE, HEAD, META, REPO, ANCHORED, FakeGh, write_ndjson

COMPLETE = {'type': 'complete', 'status': 'review_completed'}


class ReceiptGh(FakeGh):
    def __init__(self, pages=None, threads=None, merge_base=BASE, head=HEAD, base=BASE, **kw):
        super().__init__(**kw)
        self.merge_base, self.head, self.base = merge_base, head, base
        self.pages = pages if pages is not None else [[]]
        self.threads = list(threads or [{'nodes': [], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}])

    def __call__(self, argv, *, input_text=None):
        if '--slurp' in argv:
            self.calls.append((argv, input_text))
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.pages), stderr='')
        if 'graphql' in argv:
            self.calls.append((argv, input_text))
            data = {'data': {'repository': {'pullRequest': {'reviewThreads': self.threads.pop(0)}}}}
            return SimpleNamespace(returncode=0, stdout=json.dumps(data), stderr='')
        if '.merge_base_commit.sha' in argv:
            return SimpleNamespace(returncode=0, stdout=self.merge_base + "\n", stderr='')
        result = super().__call__(argv, input_text=input_text)
        if argv[-1].endswith('head: .head.sha}'):
            result.stdout = json.dumps({'state': self.state, 'merged': self.merged, 'base': self.base, 'head': self.head})
        return result


def thread(severity='major', resolved=False, own=True):
    body = f'**crq finding F1 [{severity}]** bug\n'
    if own:
        body += '<!-- crq-review-thread run=old head=' + 'c' * 40 + ' finding=' + 'd' * 64 + ' -->'
    return {'id': 'thread1', 'isResolved': resolved,
            'comments': {'nodes': [{'body': body, 'author': {'login': 'cq-review'}}]}}


class ReceiptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.meta = {**META, 'crq_receipt': True}
        (self.root / 'meta.json').write_text(json.dumps({**META, 'range_policy': 'full-range-once-v1'}))
        (self.root / 'exit.json').write_text(json.dumps({'exit': 0}))

    def deliver(self, events=None, gh=None, meta=None):
        return prf.deliver(REPO, 7, meta or self.meta,
            write_ndjson(self.root, [*(events or []), COMPLETE]), gh=gh or ReceiptGh(), login='cq-review[bot]')

    def test_clean_major_minor_and_range_marker(self):
        for events, verdict in [([], 'PASS'), ([ANCHORED], 'ITERATE'),
                                ([{**ANCHORED, 'severity': 'minor'}], 'PASS')]:
            with self.subTest(verdict=verdict, events=events):
                gh = ReceiptGh()
                self.assertEqual(self.deliver(events, gh)['state'], 'created')
                body = gh.posts()[0]['body']
                self.assertTrue(body.startswith(prf.marker(META['run_id']) + '\n' + receipt.PREFIX))
                self.assertIn(f'via crq): {verdict} for `{HEAD}`', body)
                self.assertIn(f'{BASE}..{HEAD}', body)
                self.assertIn('<!-- crq-local-findings head=', body)
                if not events:
                    self.assertIn('0 findings', body)
                else:
                    self.assertIn('<!-- crq-review-thread ', gh.posts()[0]['comments'][0]['body'])

    def test_duplicate_findings_keep_highest_severity_in_receipt_thread(self):
        gh = ReceiptGh()
        self.deliver([{**ANCHORED, 'severity': 'minor'}, ANCHORED], gh)
        self.assertEqual(len(gh.posts()[0]['comments']), 1)
        self.assertIn('[major]', gh.posts()[0]['comments'][0]['body'])
        self.assertIn('ITERATE for', gh.posts()[0]['body'])

    def test_all_blocking_aliases_survive_duplicate_minor_and_keep_iterate(self):
        for severity in ('blocker', 'fatal', 'critical', 'major'):
            for events in ([{**ANCHORED, 'severity': 'minor'}, {**ANCHORED, 'severity': severity}],
                           [{**ANCHORED, 'severity': severity}, {**ANCHORED, 'severity': 'minor'}]):
                with self.subTest(severity=severity, events=events):
                    gh = ReceiptGh()
                    self.deliver(events, gh)
                    self.assertIn('ITERATE for', gh.posts()[0]['body'])
                    self.assertIn(f'[{severity}]', gh.posts()[0]['comments'][0]['body'])

    def test_foreign_legacy_marker_cannot_suppress_or_invalidate_delivery(self):
        for suffix in (f'{BASE}..{HEAD}', 'wrong-range'):
            foreign = {'id': 123, 'user': {'login': 'unrelated'},
                       'body': prf.marker(META['run_id']) + '\n' + suffix}
            gh = ReceiptGh(pages=[[foreign]])
            self.assertEqual(self.deliver(gh=gh)['state'], 'created')
        trusted = {**foreign, 'user': {'login': 'cq-review[bot]'},
                   'body': prf.marker(META['run_id']) + f'\n{BASE}..{HEAD}'}
        gh = ReceiptGh(pages=[[trusted]])
        self.assertEqual(self.deliver(gh=gh)['state'], 'existing')
        self.assertEqual(gh.posts(), [])

    def test_trusted_unattested_host_thread_survives_app_recovery_but_foreign_copy_does_not(self):
        for association, expected in [('OWNER', 'ITERATE'), ('NONE', 'PASS')]:
            root = thread()
            root['comments']['nodes'][0].update(author={'login': 'queue-host'}, pullRequestReview={
                'body': 'Unattested: App identity unavailable; posted with the host account.',
                'author': {'login': 'queue-host'}, 'authorAssociation': association})
            gh = ReceiptGh(threads=[{'nodes': [root], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}])
            self.deliver(gh=gh)
            self.assertIn(expected + ' for', gh.posts()[0]['body'])

    def test_foreign_marked_threads_cannot_hold_pass(self):
        for legacy in (False, True):
            root = thread()
            root['comments']['nodes'][0]['author']['login'] = 'unrelated'
            if legacy:
                root['comments']['nodes'][0]['pullRequestReview'] = {
                    'body': '<!-- crq-findings run=old -->\n### crq findings (CodeRabbit CLI, local run old)',
                    'author': {'login': 'unrelated'}}
            gh = ReceiptGh(threads=[{'nodes': [root], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}])
            self.deliver(gh=gh)
            self.assertIn('PASS for', gh.posts()[0]['body'])

    def test_minor_threads_do_not_hold_pass_even_if_their_prose_mentions_major(self):
        minor = thread(severity='minor')
        minor['comments']['nodes'][0]['body'] = minor['comments']['nodes'][0]['body'].replace('bug', 'mentions [major]')
        gh = ReceiptGh(threads=[{'nodes': [minor], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}])
        self.deliver(gh=gh)
        self.assertIn('PASS for', gh.posts()[0]['body'])

    def test_failed_partial_and_timeout_emit_no_verdict(self):
        for exit_code, events in [(124, [COMPLETE]), (1, [COMPLETE]), (0, [{**COMPLETE, 'partial': True}]),
                                  (0, [{'type': 'complete', 'status': 'partial'}]),
                                  (0, [{'type': 'error', 'message': 'failed'}, COMPLETE])]:
            (self.root / 'exit.json').write_text(json.dumps({'exit': exit_code}))
            gh = ReceiptGh()
            path = write_ndjson(self.root, events)
            result = prf.deliver(REPO, 7, self.meta, path, gh=gh, login='cq-review[bot]')
            self.assertEqual(result['state'], 'skipped-no-verdict')
            self.assertEqual(gh.posts(), [])

    def test_plain_text_merge_base_is_validated_and_mismatched_range_never_passes(self):
        gh = ReceiptGh(merge_base='e' * 40)
        self.deliver(gh=gh)
        self.assertIn('ITERATE for', gh.posts()[0]['body'])
        for invalid in ('null', '', json.dumps(BASE)):
            gh = ReceiptGh(merge_base=invalid)
            with self.assertRaisesRegex(RuntimeError, 'invalid current PR merge base'):
                self.deliver(gh=gh)
            self.assertEqual(gh.posts(), [])

    def test_delta_scope_cannot_pass(self):
        (self.root / 'meta.json').write_text(json.dumps({**META, 'range_policy': 'delta-only'}))
        gh = ReceiptGh()
        self.deliver(gh=gh)
        self.assertIn('ITERATE for', gh.posts()[0]['body'])

    def test_old_major_blocks_pass_but_author_resolution_allows_pass(self):
        for resolved, verdict in [(False, 'ITERATE'), (True, 'PASS')]:
            gh = ReceiptGh(threads=[{'nodes': [thread(resolved=resolved)],
                'pageInfo': {'hasNextPage': False, 'endCursor': None}}])
            self.deliver(gh=gh)
            self.assertIn(verdict + ' for', gh.posts()[0]['body'])
            self.assertFalse(any('resolveReviewThread' in str(argv) for argv, _ in gh.calls))

    def test_foreign_threads_not_claimed_and_pagination_is_exhausted(self):
        gh = ReceiptGh(threads=[{'nodes': [thread(own=False)],
                    'pageInfo': {'hasNextPage': True, 'endCursor': 'next'}},
                {'nodes': [thread()], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}])
        self.deliver(gh=gh)
        self.assertIn('ITERATE for', gh.posts()[0]['body'])
        self.assertTrue(any('cursor=next' in argv for argv, _ in gh.calls))

    def test_crash_after_post_replay_returns_existing_without_post_or_thread_effect(self):
        first = ReceiptGh()
        self.deliver(gh=first)
        row = {'id': 77, 'html_url': 'url', 'user': {'login': 'cq-review[bot]'}, 'body': first.posts()[0]['body']}
        gh = ReceiptGh(pages=[[], [row]])
        result = self.deliver(gh=gh)
        self.assertEqual(result['state'], 'existing')
        self.assertEqual(gh.posts(), [])
        self.assertFalse(any('graphql' in argv for argv, _ in gh.calls))
        changed = {**self.meta, 'base': 'd' * 40}
        with self.assertRaisesRegex(ValueError, 'changed CRQ receipt binding'):
            self.deliver(gh=ReceiptGh(pages=[[row]]), meta=changed)

    def test_new_head_is_not_suppressed_by_older_receipt(self):
        old = {**self.meta, 'head': 'c' * 40, 'run_id': 'old'}
        row = {'id': 6, 'user': {'login': 'cq-review[bot]'},
               'body': prf.marker('old') + '\n' + receipt.binding_marker(receipt.binding(old, 7))}
        gh = ReceiptGh(pages=[[row]])
        self.assertEqual(self.deliver(gh=gh)['state'], 'created')
        self.assertEqual(len(gh.posts()), 1)

    def test_changed_artifact_binding_and_truncated_review_data_refused(self):
        (self.root / 'meta.json').write_text(json.dumps({**META, 'base': 'c' * 40}))
        with self.assertRaisesRegex(ValueError, 'artifact binding'):
            self.deliver()
        with self.assertRaisesRegex(RuntimeError, 'pagination'):
            self.deliver(gh=ReceiptGh(pages={'nodes': []}))

    def test_unattested_fallback_visible_but_ambiguous_app_post_never_falls_back(self):
        gh = ReceiptGh()
        path = write_ndjson(self.root, [COMPLETE])
        with mock.patch.object(prf, '_gh', gh), \
             mock.patch.object(identity, 'authenticated_gh', side_effect=identity.IdentityUnavailable('helper-missing')):
            result = prf.deliver(REPO, 7, self.meta, path)
        self.assertEqual(result['state'], 'created')
        self.assertIn('Unattested:', gh.posts()[0]['body'])
        failing = ReceiptGh(post=[(1, '', 'HTTP 502')])
        with mock.patch.object(identity, 'authenticated_gh', return_value=failing), \
             mock.patch.object(prf, '_gh') as owner:
            with self.assertRaisesRegex(RuntimeError, '502'):
                prf.deliver(REPO, 7, self.meta, path)
            owner.assert_not_called()


class CleanDebtTest(unittest.TestCase):
    def test_clean_delivery_never_clears_findings_debt_and_does_not_replay(self):
        item = {'id': 'pr7', 'kind': 'open', 'pr': 7, 'state': 'done',
                'pr_review_pending': True, 'pr_review_request': {'run_id': 'older-findings'},
                'clean_review_pending': True, 'clean_review_request': {**META, 'pr': 7, 'ndjson': '/runs/r/review.ndjson'}}
        with mock.patch.object(prf, 'deliver', return_value={'state': 'created'}) as deliver:
            crq.deliver_pending_clean_reviews({'items': [item]})
            crq.deliver_pending_clean_reviews({'items': [item]})
        deliver.assert_called_once()
        self.assertTrue(item['pr_review_pending'])
        self.assertEqual(item['pr_review_request'], {'run_id': 'older-findings'})
        self.assertFalse(item['clean_review_pending'])

    def test_clean_transport_failures_settle_at_attempt_cap(self):
        item = {'id': 'pr7', 'kind': 'open', 'clean_review_pending': True,
                'clean_review_request': {**META, 'pr': 7, 'ndjson': '/runs/r/review.ndjson'}}
        with mock.patch.object(prf, 'deliver', side_effect=RuntimeError('offline')) as deliver:
            for _ in range(crq.PR_REVIEW_MAX_ATTEMPTS + 1):
                crq.deliver_pending_clean_reviews({'items': [item]})
        self.assertEqual(deliver.call_count, crq.PR_REVIEW_MAX_ATTEMPTS)
        self.assertFalse(item['clean_review_pending'])


class RefreshTest(unittest.TestCase):
    setUp = ReceiptTest.setUp
    deliver = ReceiptTest.deliver

    def original(self):
        gh = ReceiptGh(threads=[{'nodes': [thread()], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}])
        self.deliver(gh=gh)
        return {'id': 77, 'html_url': 'old-url', 'user': {'login': 'cq-review[bot]'},
                'body': gh.posts()[0]['body'], 'submitted_at': '2026-01-01T00:00:01Z'}

    def test_author_resolution_refreshes_pass_without_scan_and_replay_never_posts_again(self):
        original = self.original()
        gh = ReceiptGh(pages=[[original]])
        with mock.patch.object(crq, 'classify', side_effect=AssertionError('must not rescan')):
            result = receipt.refresh(prf, REPO, 7, self.meta, gh=gh, login='cq-review[bot]')
        self.assertEqual(result['state'], 'created')
        body = gh.posts()[0]['body']
        self.assertTrue(body.startswith(f"<!-- crq-verdict-refresh head={HEAD} scan-run={META['run_id']} -->\n"))
        self.assertNotIn('<!-- crq-findings', body)
        self.assertIn('PASS for', body)
        self.assertIn('old-url', body)
        refreshed = {'id': 78, 'html_url': 'new-url', 'user': {'login': 'cq-review[bot]'},
                     'body': body, 'submitted_at': '2026-01-01T00:00:02Z'}
        replay = ReceiptGh(pages=[[refreshed, original]])
        self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=replay, login='cq-review[bot]')['state'], 'existing')
        self.assertEqual(replay.posts(), [])

    def test_refresh_revalidates_current_range_and_head_before_posting(self):
        original = self.original()
        for kwargs, expected in [({'base': 'd' * 40, 'merge_base': 'e' * 40}, 'skipped-range'),
                                 ({'head': 'f' * 40}, 'skipped-head'),
                                 ({'state': 'closed'}, 'skipped-head')]:
            with self.subTest(kwargs=kwargs):
                gh = ReceiptGh(pages=[[original]], **kwargs)
                self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=gh,
                                                login='cq-review[bot]')['state'], expected)
                self.assertEqual(gh.posts(), [])
        gh = ReceiptGh(pages=[[original]], base='d' * 40)  # base drift with the same merge base is safe
        self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=gh,
                                        login='cq-review[bot]')['state'], 'created')

    def test_prior_pass_does_not_suppress_new_scan_or_its_refresh(self):
        original = self.original()
        first = ReceiptGh(pages=[[original]])
        self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=first,
                                        login='cq-review[bot]')['state'], 'created')
        old_pass = {'id': 77, 'user': {'login': 'cq-review[bot]'}, 'body': first.posts()[0]['body'],
                    'submitted_at': '2026-01-01T00:00:01Z'}
        moved_base = 'e' * 40
        self.meta = {**self.meta, 'run_id': 'new-scan', 'base': moved_base}
        (self.root / 'meta.json').write_text(json.dumps({**self.meta, 'range_policy': 'full-range-once-v1'}))
        fresh = ReceiptGh(pages=[[old_pass]], base=moved_base, merge_base=moved_base, threads=[{'nodes': [thread()],
                             'pageInfo': {'hasNextPage': False, 'endCursor': None}}])
        self.assertEqual(self.deliver(gh=fresh)['state'], 'created')
        iterate = {'id': 78, 'user': {'login': 'cq-review[bot]'}, 'body': fresh.posts()[0]['body'],
                   'submitted_at': '2026-01-01T00:00:02Z'}
        self.assertIn('ITERATE for', iterate['body'])
        gh = ReceiptGh(pages=[[iterate, old_pass]], base=moved_base, merge_base=moved_base)  # unordered API history
        self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=gh,
                                        login='cq-review[bot]')['state'], 'created')
        body = gh.posts()[0]['body']
        self.assertIn(f'head={HEAD} scan-run=new-scan -->', body)
        refreshed = {'id': 79, 'user': {'login': 'cq-review[bot]'}, 'body': body,
                     'submitted_at': '2026-01-01T00:00:03Z'}
        replay = ReceiptGh(pages=[[old_pass, refreshed, iterate]], base=moved_base, merge_base=moved_base)
        self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=replay,
                                        login='cq-review[bot]')['state'], 'existing')
        self.assertEqual(replay.posts(), [])
        # A distinct completed clean scan can publish its own PASS at the same head.
        clean = ReceiptGh(pages=[[old_pass]], base=moved_base, merge_base=moved_base)
        self.assertEqual(self.deliver(gh=clean)['state'], 'created')
        self.assertIn('PASS for', clean.posts()[0]['body'])

    def test_earlier_new_body_major_holds_later_clean_scan_and_every_refresh_at_head(self):
        rejected = ReceiptGh(post=[(1, '', 'HTTP 422 anchor rejected'), (0, '{"id":77}', '')])
        self.deliver([ANCHORED], rejected)
        body = rejected.posts()[1]['body']
        self.assertIn('body-major=1', body)
        earlier = {'id': 77, 'body': body, 'user': {'login': 'cq-review[bot]'},
                   'submitted_at': '2026-01-01T00:00:01Z'}
        moved_base = 'e' * 40
        self.meta = {**self.meta, 'run_id': 'new-clean', 'base': moved_base}
        (self.root / 'meta.json').write_text(json.dumps({**self.meta, 'range_policy': 'full-range-once-v1'}))
        for scope in ('whole-pr-success', 'narrow-success'):
            with self.subTest(scope=scope):
                earlier['body'] = body.replace('whole-pr-success', scope)
                clean = ReceiptGh(pages=[[earlier]], base=moved_base, merge_base=moved_base)
                self.assertEqual(self.deliver(gh=clean)['state'], 'created')
                latest = {'id': 78, 'body': clean.posts()[0]['body'], 'user': {'login': 'cq-review[bot]'},
                          'submitted_at': '2026-01-01T00:00:02Z'}
                self.assertIn('ITERATE for', latest['body'])
                # The new scan itself is complete/clean: only the earlier receipt blocks it.
                self.assertIn('whole-pr-success -->', latest['body'])
                for pages in ([[latest], [earlier]], [[earlier, latest]]):
                    refresh = ReceiptGh(pages=pages, base=moved_base, merge_base=moved_base)
                    self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=refresh,
                                                    login='cq-review[bot]')['state'], 'body-major')
                    self.assertEqual(refresh.posts(), [])
        # That debt is head-scoped: a genuinely new head can receive PASS.
        new_head = 'f' * 40
        self.meta = {**self.meta, 'run_id': 'new-head', 'head': new_head}
        (self.root / 'meta.json').write_text(json.dumps({**self.meta, 'range_policy': 'full-range-once-v1'}))
        new = ReceiptGh(pages=[[earlier]], base=moved_base, merge_base=moved_base, head=new_head)
        self.deliver(gh=new)
        self.assertIn('PASS for', new.posts()[0]['body'])

    def test_earlier_unattested_host_body_major_holds_after_app_identity_recovers(self):
        original = self.original()
        body = original['body'].replace('whole-pr-success -->', 'whole-pr-success body-major=1 -->')
        body = body.replace(f'for `{HEAD}`**', f'for `{HEAD}`**\nUnattested: App identity unavailable; posted with the host account.')
        earlier = {**original, 'body': body, 'user': {'login': 'crq-host'}, 'author_association': 'OWNER'}
        self.meta = {**self.meta, 'run_id': 'app-recovered'}
        (self.root / 'meta.json').write_text(json.dumps({**self.meta, 'range_policy': 'full-range-once-v1'}))
        gh = ReceiptGh(pages=[[earlier]])
        self.deliver(gh=gh)
        self.assertIn('ITERATE for', gh.posts()[0]['body'])
        refresh = ReceiptGh(pages=[[earlier]])
        self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=refresh,
                                        login='cq-review[bot]')['state'], 'body-major')
        self.assertEqual(refresh.posts(), [])

    def test_legacy_body_major_and_foreign_receipts_do_not_create_new_head_debt(self):
        original = self.original()
        legacy = {**original, 'body': 'Legacy major body finding; no post-change CRQ receipt binding.'}
        fake = {**original, 'user': {'login': 'unrelated-reviewer'},
                'body': original['body'].replace('whole-pr-success -->', 'whole-pr-success body-major=1 -->')}
        for earlier in (legacy, fake):
            with self.subTest(earlier=earlier):
                clean = ReceiptGh(pages=[[earlier]])
                self.deliver(gh=clean)
                self.assertIn('PASS for', clean.posts()[0]['body'])
                self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta,
                    gh=ReceiptGh(pages=[[original, earlier]]), login='cq-review[bot]')['state'], 'created')

    def test_unresolved_major_and_incomplete_scope_do_not_refresh(self):
        original = self.original()
        gh = ReceiptGh(pages=[[original]], threads=[{'nodes': [thread()], 'pageInfo': {'hasNextPage': False, 'endCursor': None}}])
        self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=gh, login='cq-review[bot]')['state'], 'pending-threads')
        self.assertEqual(gh.posts(), [])
        original['body'] = original['body'].replace('whole-pr-success', 'narrow-scan')
        gh = ReceiptGh(pages=[[original]])
        self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=gh, login='cq-review[bot]')['state'], 'no-whole-pr-proof')
        self.assertEqual(gh.posts(), [])

    def test_more_than_fifty_findings_all_get_one_thread_and_no_body_downgrade(self):
        findings = [{**ANCHORED, 'title': f'Finding {n}'} for n in range(55)]
        gh = ReceiptGh()
        self.deliver(findings, gh)
        self.assertEqual(len(gh.posts()[0]['comments']), 55)
        rejected = ReceiptGh(post=[(1, '', 'HTTP 422 anchor rejected'), (0, '{"id":78}', '')])
        result = self.deliver(findings, rejected)
        self.assertTrue(result['body_major'])
        self.assertEqual(len(rejected.posts()), 2)
        self.assertEqual(len(rejected.posts()[0]['comments']), 55)
        body = rejected.posts()[1]['body']
        self.assertEqual(len(rejected.posts()[1]['comments']), 0)
        self.assertIn('ITERATE for', body)
        self.assertIn('body-major=1', body)
        row = {'id': 78, 'body': body, 'user': {'login': 'cq-review[bot]'}, 'submitted_at': '2026-01-01T00:00:01Z'}
        gh = ReceiptGh(pages=[[row]])
        self.assertEqual(receipt.refresh(prf, REPO, 7, self.meta, gh=gh, login='cq-review[bot]')['state'], 'body-major')
        self.assertEqual(gh.posts(), [])

    def test_deleted_or_binary_only_pr_falls_back_with_body_major_and_no_refresh(self):
        gh = ReceiptGh()
        with mock.patch.object(prf, 'diff_hunks', return_value={}):
            result = self.deliver([ANCHORED], gh)
        self.assertTrue(result['body_major'])
        self.assertEqual(gh.posts()[0]['comments'], [])
        self.assertIn('ITERATE for', gh.posts()[0]['body'])
        self.assertIn('Check the bound', gh.posts()[0]['body'])

    def test_unanchored_findings_use_real_changed_line_with_honest_location(self):
        gh = ReceiptGh()
        self.deliver([{**ANCHORED, 'fileName': 'missing.py', 'startLine': 900, 'endLine': 901}], gh)
        comment = gh.posts()[0]['comments'][0]
        self.assertEqual((comment['path'], comment['line']), ('src/a.py', 2))
        self.assertIn('not the finding', comment['body'])
        self.assertIn('missing.py', comment['body'])
        self.assertIn('900', comment['body'])


class RefreshDeliveryTest(unittest.TestCase):
    def test_existing_successful_scan_refresh_uses_own_debt_without_scheduling(self):
        item = {'id': 'pr7', 'kind': 'open', 'state': 'done',
                'pr_review': {'state': 'created', 'verdict': 'ITERATE', 'whole_pr_scan': True},
                'pr_review_request': {**META, 'pr': 7, 'posting_identity': 'cq-review[bot]'}}
        with mock.patch.object(receipt, 'refresh', return_value={'state': 'created'}) as refresh, \
             mock.patch.object(crq, 'classify', side_effect=AssertionError('no scan')):
            self.assertEqual(len(crq.deliver_pending_review_refreshes({'items': [item]})), 1)
            crq.deliver_pending_review_refreshes({'items': [item]})
        refresh.assert_called_once()
        self.assertEqual(item['pr_review_refresh']['head'], HEAD)
        self.assertNotIn('run', item)
        self.assertNotIn('pr_review_pending', item)

    def test_new_scan_at_same_head_is_not_settled_by_older_refresh(self):
        item = {'id': 'pr7', 'kind': 'open', 'state': 'done',
                'pr_review': {'state': 'created', 'verdict': 'ITERATE', 'whole_pr_scan': True},
                'pr_review_request': {**META, 'pr': 7, 'posting_identity': 'cq-review[bot]'},
                'pr_review_refresh': {'head': HEAD, 'scan_run': 'older-scan', 'state': 'created'}}
        with mock.patch.object(receipt, 'refresh', return_value={'state': 'created'}) as refresh:
            for _ in range(2):
                crq.deliver_pending_review_refreshes({'items': [item]})
        refresh.assert_called_once()
        self.assertEqual(item['pr_review_refresh']['scan_run'], META['run_id'])

    def test_closed_or_superseded_refresh_requests_settle_and_stop_polling(self):
        for state in ('skipped-head', 'skipped-range', 'body-major'):
            item = {'id': 'pr7', 'kind': 'open', 'state': 'done',
                    'pr_review': {'state': 'created', 'verdict': 'ITERATE', 'whole_pr_scan': True},
                    'pr_review_request': {**META, 'pr': 7, 'posting_identity': 'cq-review[bot]'}}
            with mock.patch.object(receipt, 'refresh', return_value={'state': state}) as refresh:
                for _ in range(3):
                    crq.deliver_pending_review_refreshes({'items': [item]})
            refresh.assert_called_once()
            self.assertEqual(item['pr_review_refresh']['state'], state)

    def test_findings_and_clean_refreshes_settle_and_exhaust_errors_independently(self):
        for failure in (False, True):
            item = {'id': 'pr7', 'kind': 'open', 'state': 'done'}
            for prefix in ('pr_review', 'clean_review'):
                item[prefix] = {'state': 'created', 'verdict': 'ITERATE', 'whole_pr_scan': True}
                item[prefix + '_request'] = {**META, 'run_id': prefix, 'pr': 7, 'posting_identity': 'cq-review[bot]'}
            with mock.patch.object(receipt, 'refresh', **({'side_effect': RuntimeError('offline')} if failure
                                   else {'return_value': {'state': 'skipped-head'}})) as refresh:
                for _ in range(crq.PR_REVIEW_MAX_ATTEMPTS + 2):
                    crq.deliver_pending_review_refreshes({'items': [item]})
            expected = crq.PR_REVIEW_MAX_ATTEMPTS if failure else 1
            self.assertEqual(refresh.call_count, 2 * expected)
            for prefix in ('pr_review', 'clean_review'):
                self.assertEqual(item[prefix + '_refresh']['state'], 'abandoned' if failure else 'skipped-head')
                self.assertEqual(item[prefix + '_refresh']['attempts'], expected if failure else 0)

    def test_422_delivery_keeps_findings_debt_for_retry_without_cleaning_it(self):
        item = {'id': 'pr7', 'kind': 'open', 'pr_review_pending': True,
                'pr_review_request': {**META, 'pr': 7, 'ndjson': '/runs/r/review.ndjson'}}
        with mock.patch.object(prf, 'deliver', side_effect=RuntimeError('HTTP 422 rejected anchor')):
            self.assertIsNone(crq._deliver_pr_review(item))
        self.assertTrue(item['pr_review_pending'])
        self.assertIn('422', item['pr_review_error'])
        with mock.patch.object(receipt, 'refresh') as refresh:
            crq.deliver_pending_review_refreshes({'items': [item]})
        refresh.assert_not_called()
