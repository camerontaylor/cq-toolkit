"""Real isolated inbox/event/repair adapter integration, no paid providers."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
import repair_tick
from crq_repair import atomic
from crq_repair.bounded import drain_job
import finding_delivery as delivery
import review_ledger as ledger
from crq_repair.triage import phase
from test_finding_delivery import FindingTest, AT
from test_review_ledger import rehash


class PhaseTest(FindingTest):
    def run_phase(self, report=None, dry=False, maximum=6):
        queue = {'items': []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True, scan_finding=lambda *_: True)
        judge = mock.Mock(return_value=report or {'stop': 'ok', 'verdict': 'valid', 'reason': 'source confirms',
                        'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'one'})
        result = phase(self.inbox, self.f.repo, self.t, judge, transport, AT, dry_run=dry, maximum=maximum)
        return result, queue, judge

    def legacy_escalation(self):
        self.inbox.triage(self.fid, self.f.repo, self.t, 'needs-human',
                          'crq-triage/judge', 'owner requirements ambiguous', AT)

    def test_missing_evidence_enters_fixer_queue_once(self):
        result, queue, _ = self.run_phase({'stop': 'ok', 'verdict': 'unsure', 'reason': 'missing source evidence'})
        self.assertEqual(result['delivered'], 1)
        self.assertEqual(len(queue['items']), 1)
        self.assertEqual(self.run_phase()[0]['delivered'], 0)

    def test_untyped_unsure_investigates_without_owner_escalation(self):
        result, queue, _ = self.run_phase({'stop': 'ok', 'verdict': 'unsure',
                                           'reason': 'Several implementation choices seem plausible'})
        self.assertEqual(result['delivered'], 1)
        event = next(e for e in self.out.retained() if e['payload'].get('action') == 'confirmed')
        self.assertEqual(event['payload']['evidence']['failure_class'], 'evidence')
        self.assertEqual(len(queue['items']), 1)

    def test_typed_context_scan_refusal_routes_only_safe_finding(self):
        result, queue, _ = self.run_phase({'stop': 'ok', 'verdict': 'unsure',
            'context_scan_refused': True, 'reason': 'scan rejected'})
        self.assertEqual(result['delivered'], 1)
        job_path = next((self.root / 'state/repair/inbox').glob('*.json'))
        self.assertNotIn('triage_context', ledger.loads(job_path.read_bytes()))
        event = next(e for e in self.out.retained() if e['payload'].get('action') == 'confirmed')
        self.assertEqual(event['payload']['evidence']['failure_class'], 'evidence')

    def test_refused_context_cannot_upload_rejected_finding_text(self):
        queue = {'items': []}
        calls = []
        def scan_diff(patch, *args, **kwargs):
            calls.append(patch)
            return (False, {})
        c = SimpleNamespace(ROOT=self.root, STATE=self.root / 'state', CONFIG={'repair': {}},
                            save_queue=lambda q: None, secret_scan=mock.Mock(return_value=(True, {})),
                            secret_scan_diff=scan_diff)
        runtime = SimpleNamespace(subjects=SimpleNamespace(projection=lambda *args: ('base', 'head')))
        transport = delivery.configured_repair_transport(c, self.f.repo, queue, runtime)
        judge = mock.Mock(return_value={'stop': 'ok', 'verdict': 'unsure',
                                        'context_scan_refused': True, 'reason': 'scan rejected'})
        result = phase(self.inbox, self.f.repo, self.t, judge, transport, AT)
        self.assertEqual(result['delivery_deferred'], 1)
        self.assertEqual(result['delivered'], 0)
        self.assertEqual(queue['items'], [])
        self.assertFalse(list((self.root / 'state/repair/inbox').glob('*.json')))
        self.assertEqual(len(calls), 1)
        self.assertIn('+Issue\n+Details', calls[0])

    def test_delivery_integrity_failure_does_not_block_other_confirmed_finding(self):
        self.add_pending_candidate()
        for fid in (self.fid, 'f' * 64):
            self.inbox.triage(fid, self.f.repo, self.t, 'confirmed', 'judge', 'verified', AT)
        queue = {'items': []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True,
                                              scan_finding=lambda *_: True)
        actual = self.inbox.deliver
        def deliver(fid, *args):
            if fid == self.fid:
                raise ValueError('instruction scanner refused')
            return actual(fid, *args)
        judge = mock.Mock()
        with mock.patch.object(self.inbox, 'deliver', side_effect=deliver):
            result = phase(self.inbox, self.f.repo, self.t, judge, transport, AT)
            repeated = phase(self.inbox, self.f.repo, self.t, judge, transport, AT)
        self.assertEqual((result['delivery_deferred'], result['delivered']), (1, 1))
        self.assertEqual((repeated['delivery_deferred'], repeated['delivered']), (1, 0))
        judge.assert_not_called()
        self.assertEqual(len(queue['items']), 1)

    def test_unbound_legacy_manifest_does_not_block_another_finding(self):
        from crq_repair.retain import retain
        self.inbox = delivery.Inbox(self.root / 'state/backfill/findings', self.out)
        self.inbox.ingest(self.value)
        queue = {'items': []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True,
                         scan_finding=lambda *_: True, scan_instructions=lambda *_: True)
        self.inbox.triage(self.fid, self.f.repo, self.t, 'confirmed', 'judge', 'valid', AT)
        first = self.inbox.deliver(self.fid, transport, AT)
        job_id = first['repair_task']
        retain(self.f.repo.root, self.t, self.root / 'state/repair' / job_id / 'final', include_clean=True)
        self.inbox.repair_outcome(self.fid, job_id, 'needs-retriage', 'legacy failure', AT)
        job_path = self.root / 'state/repair/inbox' / (job_id + '.json')
        old = ledger.loads(job_path.read_bytes()); old['repair_base'] = 'f' * 40
        ledger.atomic(job_path, ledger.canonical(old))
        self.inbox.triage(self.fid, self.f.repo, self.t, 'confirmed', 'judge', 'valid again', AT)
        self.add_pending_candidate()
        other_path = self.inbox.root / 'triage' / ('f' * 64 + '.json')
        other = ledger.loads(other_path.read_bytes()); other.pop('receipt', None)
        ledger.atomic(other_path, ledger.canonical(other))
        self.inbox.triage('f' * 64, self.f.repo, self.t, 'confirmed', 'judge', 'valid', AT)
        judge = mock.Mock()
        result = phase(self.inbox, self.f.repo, self.t, judge, transport, AT)
        repeated = phase(self.inbox, self.f.repo, self.t, judge, transport, AT)
        self.assertEqual((result['delivery_deferred'], result['delivered']), (1, 1))
        self.assertEqual((repeated['delivery_deferred'], repeated['delivered']), (1, 0))
        judge.assert_not_called()
        self.assertEqual(len(queue['items']), 2)

    def test_pin_ceiling_terminates_and_does_not_rejudge(self):
        queue = {'items': []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True, scan_finding=lambda *_: True,
                                              max_rounds_per_pin=1, scan_instructions=lambda *_: True)
        judge = mock.Mock(return_value={'stop': 'ok', 'verdict': 'valid', 'reason': 'verified',
                            'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'one'})
        phase(self.inbox, self.f.repo, self.t, judge, transport, AT)
        job = next((self.root / 'state/repair/inbox').glob('*.json')).stem
        self.inbox.repair_outcome(self.fid, job, 'needs-retriage', 'failed', AT, failure_class='exhausted')
        phase(self.inbox, self.f.repo, self.t, judge, transport, AT)
        row = ledger.loads((self.inbox.root / 'triage' / (self.fid + '.json')).read_bytes())
        self.assertEqual((row['status'], row['failure_class']), ('needs-human', 'exhausted'))
        judge.reset_mock()
        phase(self.inbox, self.f.repo, self.t, judge, transport, AT)
        judge.assert_not_called()
        self.assertEqual(len(queue['items']), 1)

    def test_legacy_missing_evidence_is_routed_once_with_history_intact(self):
        old = self.inbox.triage(self.fid, self.f.repo, self.t, 'needs-human',
                                'crq-triage/escalation/old', 'insufficient evidence', AT)
        result, queue, judge = self.run_phase()
        judge.assert_not_called()
        self.assertEqual(result['delivered'], 1)
        self.assertIn(old, self.out.retained())
        self.assertEqual(self.run_phase()[0]['delivered'], 0)

    def test_failed_investigation_anchor_keeps_bounded_judge_escalation(self):
        self.inbox.triage(self.fid, self.f.repo, self.t, 'needs-human',
                          'crq-triage/escalation/old', 'insufficient evidence', AT)
        self.t = self.f.commit({'a': b'changed\ntwo\n'})
        first, _, judge = self.run_phase()
        judge.assert_not_called()
        self.assertEqual(first['counts'], {'needs-human': 1})
        result, _, judge = self.run_phase({'stop': 'ok', 'verdict': 'valid', 'reason': 'verified',
            'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'changed'})
        judge.assert_called_once()
        self.assertEqual(result['delivered'], 1)
        self.assertEqual(self.run_phase()[0]['delivered'], 0)

    def add_pending_candidate(self):
        import copy
        path = self.inbox.root / 'triage' / (self.fid + '.json')
        row = copy.deepcopy(ledger.loads(path.read_bytes()))
        row['finding'].update(id='f' * 64, title='Second distinct finding', severity='minor')
        row.update(status='untriaged', previous_event_id=None, canonical_id='f' * 64)
        ledger.atomic(path.parent / ('f' * 64 + '.json'), ledger.canonical(row))

    def test_legacy_investigation_admission_consumes_maximum(self):
        self.inbox.triage(self.fid, self.f.repo, self.t, 'needs-human',
                          'crq-triage/judge', 'insufficient evidence', AT)
        self.add_pending_candidate()
        result, _, judge = self.run_phase(maximum=1)
        judge.assert_not_called()
        self.assertEqual(result['delivered'], 1)

    def test_fresh_investigation_judgments_are_counted_once(self):
        self.add_pending_candidate()
        result, _, judge = self.run_phase({'stop': 'ok', 'verdict': 'unsure',
                                         'reason': 'missing evidence'}, maximum=2)
        self.assertEqual(judge.call_count, 2)
        self.assertEqual(result['judged'], 2)
        self.assertEqual(result['delivered'], 2)

    def test_real_delivery_and_replay_are_idempotent(self):
        self.assertEqual(self.value['payload']['findings'][0]['severity'], 'major')
        result, queue, _ = self.run_phase()
        self.assertEqual(result['delivered'], 1)
        self.assertEqual(len(queue['items']), 1)
        job = next((self.root / 'state/repair/inbox').glob('*.json'))
        self.assertEqual(ledger.loads(job.read_bytes())['canonical_finding_id'], self.fid)
        self.assertEqual(self.run_phase()[0]['delivered'], 0)

    def use_minor_finding(self):
        finding = delivery.normalize('crq-runner-app', 'minor-run', {
            'severity': 'minor', 'path': 'a', 'blob': self.f.repo.entries(self.t)['a']['blob'],
            'intervals': [[1, 1]], 'title': 'Minor issue', 'body': 'Details'})
        self.value['payload']['findings'] = [finding]; rehash(self.value)
        self.fid = finding['id']
        self.out = ledger.Outbox(self.root / 'minor-outbox', self.f.store)
        self.inbox = delivery.Inbox(self.root / 'state/backfill/findings', self.out)
        self.inbox.ingest(self.value)

    def test_already_confirmed_minor_delivers_without_rejudgment(self):
        self.use_minor_finding()
        self.inbox.triage(self.fid, self.f.repo, self.t, 'confirmed', 'judge', 'valid', AT)
        result, queue, judge = self.run_phase(maximum=0)
        judge.assert_not_called()
        self.assertEqual(result['delivered'], 1)
        self.assertEqual(len(queue['items']), 1)
        job = next((self.root / 'state/repair/inbox').glob('*.json'))
        self.assertEqual(ledger.loads(job.read_bytes())['canonical_finding_id'], self.fid)
        self.f.repo.git('update-ref', 'refs/remotes/origin/main', self.t)
        config = {'clone': str(self.f.repo.root), 'repair': {'max_rounds_per_pin': 2}}
        self.assertEqual(drain_job(self.root, config, queue, job.stem)[0], 'run')
        self.assertEqual(self.run_phase(maximum=0)[0]['delivered'], 0)
        self.inbox.triage(self.fid, self.f.repo, self.t, 'dismissed', 'operator', 'invalid', AT)
        self.assertEqual(drain_job(self.root, config, queue, job.stem)[0], 'skip')

    def test_unconfirmed_minor_does_not_deliver(self):
        self.use_minor_finding()
        result, queue, judge = self.run_phase(maximum=0)
        judge.assert_not_called()
        self.assertEqual(result['delivered'], 0)
        self.assertEqual(queue['items'], [])

    def test_newly_confirmed_minor_delivers(self):
        self.use_minor_finding()
        result, queue, judge = self.run_phase()
        judge.assert_called_once()
        self.assertEqual(result['counts'], {'confirmed': 1})
        self.assertEqual(result['delivered'], 1)
        self.assertEqual(len(queue['items']), 1)

    def test_delivered_minor_can_use_existing_prepared_selector(self):
        import subprocess
        from crq_repair.bounded import identity, select_job
        self.use_minor_finding()
        _, queue, _ = self.run_phase()
        origin = next((self.root / 'state/repair/inbox').glob('*.json')).stem
        self.f.repo.git('update-ref', 'refs/remotes/origin/main', self.t)
        job = ledger.loads((self.root / 'state/repair/inbox' / (origin + '.json')).read_bytes())
        evidence = {'source_sha': self.t, 'finding_sha256': identity(job['finding']),
                    'source_blob_sha': self.f.repo.entries(self.t)['a']['blob'],
                    'verdict': 'still-valid', 'reviewer': 'fixture', 'reason': 'Verified pinned source'}
        config = {'clone': str(self.f.repo.root), 'repair': {'max_rounds_per_pin': 2}}
        c = SimpleNamespace(ROOT=self.root, STATE=self.root / 'state', CONFIG=config,
                            CLONE=self.f.repo.root, iso=lambda: AT,
                            run=lambda args, **kw: subprocess.run(args, **kw, capture_output=True, text=True, check=True),
                            secret_scan_diff=mock.Mock(return_value=(True, {})),
                            save_queue=lambda q: atomic(self.root / 'state/queue.json', q))
        with mock.patch.object(repair_tick, 'finding_inbox', return_value=self.inbox):
            prepared = repair_tick.prepare_current_job(c, queue, origin, self.t, evidence)
        self.assertEqual(select_job(self.root, config, prepared, self.t, evidence['finding_sha256'])['origin_job'], origin)
        self.assertEqual(drain_job(self.root, config, queue, prepared)[0], 'run')
        self.inbox.triage(self.fid, self.f.repo, self.t, 'dismissed', 'operator', 'invalid', AT)
        with self.assertRaisesRegex(ValueError, 'canonical'):
            select_job(self.root, config, prepared, self.t, evidence['finding_sha256'])


    def test_dry_run_preserves_every_byte_and_never_delivers(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*.json')}
        result, queue, _ = self.run_phase(dry=True)
        self.assertEqual(result['judged'], 1)
        self.assertEqual(queue['items'], [])
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*.json')})

    def test_provider_limit_leaves_finding_unjudged(self):
        result, _, _ = self.run_phase({'stop': 'rate-limit'})
        self.assertEqual(result['unjudged'], 1)
        self.assertEqual(result['counts'], {})

    def test_bad_quote_uses_verified_carried_anchor_for_investigation(self):
        result, queue, _ = self.run_phase({'stop': 'ok', 'verdict': 'valid', 'reason': 'asserted',
                                     'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'wrong'})
        self.assertEqual(result['counts'], {'confirmed': 1})
        event = next(e for e in self.out.retained() if e['payload'].get('action') == 'confirmed')
        self.assertEqual(event['payload']['evidence']['failure_class'], 'evidence')
        self.assertTrue(event['payload']['evidence']['anchor_verified'])
        self.assertEqual(len(queue['items']), 1)

    def test_escalates_once_with_pinned_extra_source_and_keeps_validation(self):
        self.legacy_escalation()
        second, _, judge = self.run_phase({'stop': 'ok', 'verdict': 'valid', 'reason': 'asserted',
                                          'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'wrong'})
        self.assertEqual(second['counts'], {'confirmed': 1})
        self.assertEqual(second['delivered'], 1)
        self.assertEqual(judge.call_args.args[1]['additional_sources'][0]['text'], 'one\ntwo\n')
        third, _, judge = self.run_phase()
        judge.assert_not_called()
        self.assertEqual(third['judged'], 0)
        events = [e for e in self.out.retained() if e['event_type'] == 'finding-event']
        self.assertEqual(len(events), 3)
        self.assertEqual(sum(e['payload']['actor'].startswith('crq-triage/escalation/') for e in events), 1)

    def test_escalation_can_confirm_and_deliver(self):
        self.legacy_escalation()
        result, queue, _ = self.run_phase()
        self.assertEqual(result['counts'], {'confirmed': 1})
        self.assertEqual(result['delivered'], 1)
        self.assertEqual(len(queue['items']), 1)

    def test_transient_escalation_failures_defer_until_service_recovers(self):
        self.legacy_escalation()
        for stop in ('configuration', 'budget', 'error', 'rate-limit'):
            with self.subTest(stop=stop):
                result, _, judge = self.run_phase({'stop': stop})
                self.assertEqual(result['counts'], {})
                self.assertEqual(judge.call_count, 1)
        result, _, judge = self.run_phase()
        self.assertEqual(result['counts'], {'confirmed': 1})
        judge.assert_called_once()

    def test_timed_out_escalation_remains_eligible(self):
        import subprocess
        self.legacy_escalation()
        judge = mock.Mock(side_effect=subprocess.TimeoutExpired('judge', 1))
        result = phase(self.inbox, self.f.repo, self.t, judge, mock.Mock(), AT)
        self.assertEqual(result['counts'], {})
        result, _, next_judge = self.run_phase()
        self.assertEqual(result['counts'], {'confirmed': 1})
        next_judge.assert_called_once()

    def test_outage_does_not_consume_other_escalation_rows(self):
        import copy
        self.legacy_escalation()
        path = self.inbox.root / 'triage' / (self.fid + '.json')
        row = copy.deepcopy(ledger.loads(path.read_bytes()))
        row['finding'].update(id='f' * 64, title='Another finding')
        row['canonical_id'] = 'f' * 64
        ledger.atomic(path.parent / ('f' * 64 + '.json'), ledger.canonical(row))
        result, _, judge = self.run_phase({'stop': 'configuration'})
        self.assertEqual(result['counts'], {})
        self.assertEqual(judge.call_count, 1)
        self.assertEqual(ledger.loads(path.read_bytes())['status'], 'needs-human')
        self.assertEqual(ledger.loads((path.parent / ('f' * 64 + '.json')).read_bytes())['status'], 'needs-human')

    def test_invalid_completed_output_is_terminal_and_later_rows_progress(self):
        import copy
        self.legacy_escalation()
        path = self.inbox.root / 'triage' / (self.fid + '.json')
        row = copy.deepcopy(ledger.loads(path.read_bytes()))
        row['finding'].update(id='f' * 64, title='Another finding', severity='minor')
        row.update(canonical_id='f' * 64, status='untriaged', previous_event_id=None)
        ledger.atomic(path.parent / ('f' * 64 + '.json'), ledger.canonical(row))
        judge = mock.Mock(side_effect=[{'stop': 'error', 'errorClass': 'output-invalid'},
                                      {'stop': 'ok', 'verdict': 'invalid', 'reason': 'not a defect'}])
        result = phase(self.inbox, self.f.repo, self.t, judge, mock.Mock(), AT)
        self.assertEqual(result['counts'], {'needs-human': 1, 'dismissed': 1})
        self.assertEqual(judge.call_count, 2)
        for _ in range(3):
            _, _, next_judge = self.run_phase({'stop': 'error', 'errorClass': 'output-invalid'})
            next_judge.assert_not_called()

    def test_escalation_reads_referenced_path_followed_by_period(self):
        from crq_repair.triage import context
        tip = self.f.commit({'docs/other.md': b'linked evidence\n'})
        row = ledger.loads((self.inbox.root / 'triage' / (self.fid + '.json')).read_bytes())
        row['_escalate'] = True
        row['finding']['body'] = 'See docs/other.md.'
        packed = context(self.f.repo, row, tip)
        self.assertIn('docs/other.md', [v['path'] for v in packed['additional_sources']])

    def test_escalation_includes_late_cited_source_with_line_numbers(self):
        from crq_repair.triage import source_excerpt
        content = 'prefix padding\n' * 1000 + 'important evidence\n'
        packed = source_excerpt(content, 'src/a.ts', 'See src/a.ts:1001')
        self.assertEqual(packed['text'], '')
        self.assertTrue(packed['truncated'])
        self.assertIn('important evidence', packed['regions'][0]['text'])
        self.assertEqual(packed['regions'][0]['start_line'], 981)
        self.assertLessEqual(sum(len(r['text']) for r in packed['regions']), 8000)

    def test_unique_exact_quote_recovers_wrong_line_number(self):
        result, queue, _ = self.run_phase({'stop': 'ok', 'verdict': 'valid',
            'reason': 'source confirms', 'current_path': 'a',
            'current_lines': [[999, 999]], 'quoted_text': 'two'})
        self.assertEqual(result['delivered'], 1)
        row = ledger.loads((self.inbox.root / 'triage' / (self.fid + '.json')).read_bytes())
        self.assertEqual(row['mapped_intervals'], [[2, 2]])

    def test_repeated_exact_quote_does_not_recover_wrong_line_number(self):
        self.t = self.f.commit({'a': b'one\none\ntwo\n'})
        result, queue, _ = self.run_phase({'stop': 'ok', 'verdict': 'valid',
            'reason': 'source confirms', 'current_path': 'a',
            'current_lines': [[999, 999]], 'quoted_text': 'one'})
        self.assertEqual(result['counts'], {'confirmed': 1})
        event = next(e for e in self.out.retained() if e['payload'].get('action') == 'confirmed')
        self.assertEqual(event['payload']['evidence']['failure_class'], 'evidence')
        self.assertEqual(len(queue['items']), 1)

    def test_zero_limit_leaves_unjudged(self):
        result, _, judge = self.run_phase(maximum=0)
        judge.assert_not_called()
        self.assertEqual(result['unjudged'], 1)

    def test_operator_supersedes_delivered_finding_before_dispatch(self):
        self.inbox = delivery.Inbox(self.root / 'state/backfill/findings', self.out)
        self.inbox.ingest(self.value)
        _, queue, _ = self.run_phase()
        item = queue['items'][0]
        record = next(iter(item['repair_runs'].values()))
        job_id = record['jobs'][0]
        self.f.repo.git('update-ref', 'refs/remotes/origin/main', self.t)
        config = {'clone': str(self.f.repo.root), 'repair': {'max_rounds_per_pin': 2}}
        self.assertEqual(drain_job(self.root, config, queue, job_id)[0], 'run')
        self.inbox.triage(self.fid, self.f.repo, self.t, 'superseded', 'operator',
                          'Historical requirement retired at this commit', AT, fixing_commit=self.t)
        status, _, reason = drain_job(self.root, config, queue, job_id)
        self.assertEqual(status, 'skip')
        self.assertIn('canonical', reason)
        self.assertEqual(record['state'], 'queued')  # Eligibility must honor the ledger itself.
        before = self.out.retained()
        self.inbox.repair_outcome(self.fid, job_id, 'needs-human', 'late result', AT)
        self.assertEqual(self.out.retained(), before)

    def test_delivered_pr_zero_job_is_consumed_and_harvested(self):
        self.inbox = delivery.Inbox(self.root / 'state/backfill/findings', self.out)
        self.inbox.ingest(self.value)
        _, queue, _ = self.run_phase()
        item = queue['items'][0]
        run = next(iter(item['repair_runs']))
        job_id = item['repair_runs'][run]['jobs'][0]
        self.f.repo.git('update-ref', 'refs/remotes/origin/main', self.t)
        config = {'clone': str(self.f.repo.root), 'repair': {'max_rounds_per_pin': 2}}
        status, job, reason = drain_job(self.root, config, queue, job_id)
        self.assertEqual((status, reason), ('run', ''))
        self.assertEqual(job['pr'], 0)
        path = Path(__file__).parent / 'crq_repair.py'
        spec = importlib.util.spec_from_file_location('triage_drain_test', path)
        service = importlib.util.module_from_spec(spec); spec.loader.exec_module(service)
        config['repair']['blackout'] = {'enabled': False}
        config['worktree_root'] = str(self.root / 'worktrees')
        result = {'job': job_id, 'item': item['id'], 'verdict': 'NOT-FIXED', 'reason': 'invalid', 'commits': [], 'judge': {'verdict': 'invalid'}}
        def process(*args):
            atomic(self.root / 'state/repair' / job_id / 'result.json', result)
            return result
        with mock.patch.object(service, 'ROOT', self.root), mock.patch.object(service, 'process', side_effect=process), mock.patch.object(service, 'dispatch_paused', return_value=None):
            service.process_item(config, [job])
        c = SimpleNamespace(STATE=self.root / 'state', CONFIG=config, iso=lambda: AT)
        with mock.patch.object(repair_tick, 'finding_inbox', return_value=self.inbox):
            messages = repair_tick.harvest(c, queue, item)
        row = ledger.loads((self.inbox.root / 'triage' / (self.fid + '.json')).read_bytes())
        self.assertEqual(row['status'], 'needs-retriage')
        self.assertTrue(messages)
        self.assertEqual(item['repair_runs'][run]['state'], 'done')
        self.assertEqual(item['state'], 'done')

    def test_exact_duplicate_is_mechanical_and_deleted_path_is_superseded(self):
        import copy
        row_path = self.inbox.root / 'triage' / (self.fid + '.json')
        row = ledger.loads(row_path.read_bytes())
        duplicate = copy.deepcopy(row)
        duplicate['finding']['id'] = 'f' * 64
        duplicate['canonical_id'] = 'f' * 64
        ledger.atomic(row_path.parent / ('f' * 64 + '.json'), ledger.canonical(duplicate))
        result, _, judge = self.run_phase(dry=True, maximum=0)
        self.assertEqual(result['counts'], {'duplicate': 1})
        judge.assert_not_called()
        tip = self.f.commit({'a': None})
        result = phase(self.inbox, self.f.repo, tip, judge, None, AT, dry_run=True, maximum=0)
        self.assertEqual(result['counts'], {'superseded': 2})

    def test_fixed_requires_commit_that_touches_path_and_is_ancestor(self):
        result, _, _ = self.run_phase({'stop': 'ok', 'verdict': 'fixed', 'reason': 'fixed', 'fixing_commit': '0' * 40})
        self.assertEqual(result['counts'], {'needs-human': 1})

    def test_fixing_commit_before_target_is_not_accepted(self):
        from crq_repair.triage import decision
        early = self.f.commit({'a': b'one\ntwo\nfixed\n'})
        target = self.f.commit({'b': b'unrelated\n'})
        tip = self.f.commit({'c': b'unrelated\n'})
        row = {'target': target, 'finding': {'path': 'a'}}
        for verdict in ('fixed', 'superseded'):
            action, _, _ = decision(self.f.repo, row, tip, {'verdict': verdict, 'reason': 'fixed before target', 'fixing_commit': early})
            self.assertEqual(action, 'needs-human')

    def test_renamed_path_is_not_mechanically_superseded(self):
        self.f.git('mv', 'a', 'renamed')
        self.f.git('commit', '-qm', 'rename')
        tip = self.f.git('rev-parse', 'HEAD')
        judge = mock.Mock()
        result = phase(self.inbox, self.f.repo, tip, judge, None, AT, dry_run=True, maximum=0)
        self.assertEqual(result['counts'], {})
        self.assertEqual(result['unjudged'], 1)

    def test_different_source_blob_or_body_is_not_exact_duplicate(self):
        import copy
        path = self.inbox.root / 'triage' / (self.fid + '.json')
        duplicate = copy.deepcopy(ledger.loads(path.read_bytes()))
        duplicate['finding']['id'] = 'f' * 64
        duplicate['finding']['blob'] = '0' * 40
        ledger.atomic(path.parent / ('f' * 64 + '.json'), ledger.canonical(duplicate))
        result, _, _ = self.run_phase(dry=True, maximum=0)
        self.assertEqual(result['counts'], {})
        self.assertEqual(result['unjudged'], 2)

    def test_delivery_contention_keeps_confirmed_retryable(self):
        report = {'stop': 'ok', 'verdict': 'valid', 'reason': 'valid',
                  'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'one'}
        result = phase(self.inbox, self.f.repo, self.t, lambda *_: report,
                       mock.Mock(side_effect=RuntimeError('tick busy')), AT)
        self.assertEqual(result['delivery_deferred'], 1)
        path = self.inbox.root / 'triage' / (self.fid + '.json')
        self.assertEqual(ledger.loads(path.read_bytes())['status'], 'confirmed')

    def test_judge_timeout_leaves_unjudged(self):
        import subprocess
        judge = mock.Mock(side_effect=subprocess.TimeoutExpired('judge', 1))
        result = phase(self.inbox, self.f.repo, self.t, judge, None, AT)
        self.assertEqual(result['stopped'], 'deferred')
        self.assertEqual(result['unjudged'], 1)

    def test_info_confirmed_finding_is_not_delivered(self):
        path = self.inbox.root / 'triage' / (self.fid + '.json')
        row = ledger.loads(path.read_bytes()); row['finding']['severity'] = 'info'
        ledger.atomic(path, ledger.canonical(row))
        result, queue, _ = self.run_phase()
        self.assertEqual(result['counts'], {'confirmed': 1})
        self.assertEqual(result['delivered'], 0)
        self.assertEqual(queue['items'], [])

    def test_merge_fix_commit_is_checked_against_first_parent(self):
        self.f.git('checkout', '-qb', 'fix')
        self.f.commit({'a': b'fixed\ntwo\n'})
        self.f.git('checkout', '--detach', self.t)
        self.f.commit({'b': b'unrelated\n'})
        self.f.git('merge', '--no-ff', 'fix', '-m', 'merge fix')
        tip = self.f.git('rev-parse', 'HEAD')
        result = phase(self.inbox, self.f.repo, tip,
                       lambda *_: {'stop': 'ok', 'verdict': 'fixed', 'reason': 'fixed by merge', 'fixing_commit': tip},
                       None, AT, dry_run=True)
        self.assertEqual(result['counts'], {'already-fixed': 1})

    def test_pathless_finding_is_needs_human_without_judge(self):
        path = self.inbox.root / 'triage' / (self.fid + '.json')
        row = ledger.loads(path.read_bytes()); row['finding']['path'] = None
        row['finding']['anchor_status'] = 'unverified'; row['finding']['intervals'] = []
        ledger.atomic(path, ledger.canonical(row))
        result, _, judge = self.run_phase(dry=True)
        judge.assert_not_called()
        self.assertEqual(result['counts'], {'needs-human': 1})

    def test_stale_confirmation_is_judged_again(self):
        self.inbox.triage(self.fid, self.f.repo, self.t, 'confirmed', 'test', 'valid', AT)
        tip = self.f.commit({'b': b'unrelated\n'})
        judge = mock.Mock(return_value={'stop': 'ok', 'verdict': 'invalid', 'reason': 'now invalid'})
        result = phase(self.inbox, self.f.repo, tip, judge, None, AT, dry_run=True)
        judge.assert_called_once()
        self.assertEqual(result['counts'], {'dismissed': 1})

    def test_fix_after_exact_rename_verifies_new_path(self):
        self.f.git('mv', 'a', 'renamed')
        self.f.git('commit', '-qm', 'rename')
        tip = self.f.commit({'renamed': b'fixed\ntwo\n'})
        result = phase(self.inbox, self.f.repo, tip,
                       lambda *_: {'stop': 'ok', 'verdict': 'fixed', 'reason': 'fixed renamed path', 'fixing_commit': tip},
                       None, AT, dry_run=True)
        self.assertEqual(result['counts'], {'already-fixed': 1})

    def test_context_scan_sees_unescaped_source_before_dispatch(self):
        path = Path(__file__).parent / 'crq_repair.py'
        spec = importlib.util.spec_from_file_location('triage_scan_test', path)
        service = importlib.util.module_from_spec(spec); spec.loader.exec_module(service)
        scanner = mock.Mock(return_value=(False, {}))
        c = SimpleNamespace(secret_scan_diff=scanner)
        canary = 'token=' + 'canary'
        context = {'finding': {'path': 'src/a.py', 'body': 'review'}, 'region': [{'text': canary + '\nsecond line'}]}
        self.assertFalse(service.triage_context_safe(c, context, self.root / 'scan.json'))
        submitted = scanner.call_args.args[0]
        self.assertIn('+' + canary + '\n+second line', submitted)
        self.assertIn('diff --git a/src/a.py b/src/a.py', submitted)

    def test_real_context_scanner_rejects_policy_key_marker_without_logging_content(self):
        import crq
        path = Path(__file__).parent / 'crq_repair.py'
        spec = importlib.util.spec_from_file_location('triage_real_scan_test', path)
        service = importlib.util.module_from_spec(spec); spec.loader.exec_module(service)
        policy = Path(__file__).resolve().parents[2] / 'policy/denylist/patterns.yml'
        marker = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'
        output = self.root / 'scan.json'
        context = {'finding': {'path': 'src/a.py', 'body': 'review'}, 'region': [{'text': marker}]}
        with mock.patch.object(crq, 'git', return_value=policy.read_text()), mock.patch.object(crq.shutil, 'which', return_value=None):
            self.assertFalse(service.triage_context_safe(crq, context, output))
            self.assertNotIn(marker, output.read_text())
            context['region'] = [{'text': 'ordinary source line'}]
            self.assertTrue(service.triage_context_safe(crq, context, output))

    def test_duplicate_with_different_severity_remains_independently_judgeable(self):
        import copy
        path = self.inbox.root / 'triage' / (self.fid + '.json')
        duplicate = copy.deepcopy(ledger.loads(path.read_bytes()))
        duplicate['finding']['id'] = '0' * 64
        duplicate['finding']['severity'] = 'info'
        ledger.atomic(path.parent / ('0' * 64 + '.json'), ledger.canonical(duplicate))
        result, _, _ = self.run_phase(dry=True, maximum=0)
        self.assertEqual(result['counts'], {})
        self.assertEqual(result['unjudged'], 2)

    def test_operator_disposition_during_judgment_is_not_overwritten(self):
        def judge(*_):
            self.inbox.triage(self.fid, self.f.repo, self.t, 'dismissed', 'operator', 'reviewed and dismissed', AT)
            return {'stop': 'ok', 'verdict': 'valid', 'reason': 'stale judgment',
                    'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'one'}
        transport = mock.Mock()
        result = phase(self.inbox, self.f.repo, self.t, judge, transport, AT)
        transport.assert_not_called()
        self.assertEqual(result['counts'], {})
        row = ledger.loads((self.inbox.root / 'triage' / (self.fid + '.json')).read_bytes())
        self.assertEqual(row['status'], 'dismissed')
        events = [e for e in self.out.retained() if e['event_type'] == 'finding-event']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['payload']['actor'], 'operator')

    def test_contract_context_uses_pinned_current_blob_with_explicit_bound(self):
        from crq_repair.triage import context, CONTRACT_PATH, CONTRACT_MAX_CHARS
        text = 'Promotion gate retired.\n' + 'x' * CONTRACT_MAX_CHARS
        tip = self.f.commit({CONTRACT_PATH: text.encode()})
        (self.f.root / CONTRACT_PATH).write_text('uncommitted replacement must not be read')
        row = ledger.loads((self.inbox.root / 'triage' / (self.fid + '.json')).read_bytes())
        packed = context(self.f.repo, row, tip)
        contract = packed['current_contract']
        self.assertEqual(contract['text'], text[:CONTRACT_MAX_CHARS])
        self.assertEqual(contract['status'], 'present')
        self.assertTrue(contract['truncated'])
        self.assertEqual(contract['total_chars'], len(text))
        self.assertEqual(contract['limit_chars'], CONTRACT_MAX_CHARS)
        self.assertEqual(contract['blob'], self.f.repo.entries(tip)[CONTRACT_PATH]['blob'])
        self.assertEqual(contract['tip'], tip)
        self.assertEqual(packed['original_region'], 'one')
        self.assertEqual(packed['region'][0], {'line': 1, 'text': 'one'})

    def test_missing_contract_is_explicit_without_losing_source_context(self):
        from crq_repair.triage import context
        row = ledger.loads((self.inbox.root / 'triage' / (self.fid + '.json')).read_bytes())
        packed = context(self.f.repo, row, self.t)
        self.assertEqual(packed['current_contract']['status'], 'absent')
        self.assertEqual(packed['current_contract']['text'], '')
        self.assertFalse(packed['current_contract']['truncated'])
        self.assertEqual(packed['region'][0]['text'], 'one')

    def test_triage_prompt_distinguishes_retired_recommendations_from_requirements(self):
        import json
        from crq_repair.drivers import cq
        config = {'repair': {'cq_bin': '/unused/cli.js', 'budget': {'wall_clock_min': 1}}}
        report = SimpleNamespace(returncode=0, stdout='{"stop":"ok","verdict":"unsure","reason":"test"}', stderr='')
        with mock.patch.object(cq, 'command', return_value=report):
            cq.judge(config, {'model': 'opencode-go/deepseek-v4.1-flash'},
                     {'triage_context': {'current_contract': {'text': 'Promotion retired'}}}, self.f.root, self.root)
        request = json.loads((self.root / 'judge-request.json').read_text())
        self.assertIn('Historical documents and review recommendations are not current requirements', request['prompt'])
        self.assertIn('not an exhaustive specification of ordinary code correctness', request['prompt'])
        self.assertIn('infer ordinary bugs from the supplied code and stable API/test semantics', request['prompt'])
        self.assertIn('do not require an explicit contract clause', request['prompt'])
        self.assertIn("A finding's assertions are allegations, not proof", request['prompt'])
        self.assertIn('existing intended behavior from proposals to add or enlarge requirements', request['prompt'])
        self.assertIn('explicitly accepted limitations and advisory or retired mechanisms', request['prompt'])
        self.assertIn('omitted list entry alone does not establish a current obligation', request['prompt'])
        self.assertIn('use supplied current evidence', request['prompt'])
        self.assertIn('return unsure rather than inventing an obligation', request['prompt'])
        self.assertNotIn('d11Authorization', request['prompt'])
        self.assertIn('explicitly retired', request['prompt'])
        self.assertIn('contract silence alone does not imply uncertainty', request['prompt'])
        self.assertIn('relevant source evidence is missing', request['prompt'])
        self.assertNotIn('is still required by the current contract', request['prompt'])
        self.assertIn('absent or truncated', request['prompt'])
        self.assertEqual(request['schema'], 'crq.triage/v1')

    def test_judge_adapter_preserves_structured_error_class(self):
        from crq_repair.drivers import cq
        config = {'repair': {'cq_bin': '/unused/cli.js', 'budget': {'wall_clock_min': 1}}}
        result = SimpleNamespace(returncode=0, stdout='{"stop":"error","errorClass":"output-invalid"}', stderr='')
        with mock.patch.object(cq, 'command', return_value=result):
            report = cq.judge(config, {'model': 'opencode-go/deepseek-v4.1-flash'},
                              {'triage_context': {}}, self.f.root, self.root)
        self.assertEqual(report['errorClass'], 'output-invalid')

    def test_bridge_accepts_contract_sized_triage_prompt_with_finite_isolated_cap(self):
        import json
        import subprocess
        dist = self.root / 'bridge-dist'
        (dist / 'driver/ai-sdk').mkdir(parents=True)
        (dist / 'harness').mkdir()
        (dist / 'package.json').write_text('{"type":"module"}')
        (dist / 'harness/config.js').write_text('export const defaultHarnessConfig={tools:{},promptBudget:{maxSystemPromptChars:20000,maxTools:6}};')
        (dist / 'driver/served-model.js').write_text('export const withServedModelAssertion=driver=>driver;')
        (dist / 'driver/ai-sdk/index.js').write_text("""
export class AiSdkDriver {
  constructor(options={}) { this.cap=options.harnessConfig?.promptBudget.maxSystemPromptChars??20000; }
  async run(request) {
    if(request.prompt.length>this.cap) throw Error('prompt budget exceeded');
    if(request.toolPolicy.mode!=='none'||request.sandboxPolicy.level!=='read-only') throw Error('authority changed');
    if(request.prompt==='invalid') return {stopReason:'error',errorClass:'output-invalid',error:'bad output'};
    return {stopReason:'complete',structuredOutput:{verdict:'unsure',reason:JSON.stringify({cap:this.cap,budget:request.budget,schema:request.outputSchema.name})}};
  }
}
""")
        bridge = Path(__file__).parent / 'crq_repair/judge-cq.mjs'
        request_path = self.root / 'bridge-request.json'
        budget = {'maxContextTokens': 200000, 'maxOutputTokens': 1000, 'wallClockMs': 60000}
        def invoke(schema, length):
            request = {'cq_bin': str(dist / 'cli.js'), 'schema': schema, 'prompt': 'x' * length,
                       'modelSpec': {'provider': 'unused', 'model': 'offline'}, 'budget': budget}
            request_path.write_text(json.dumps(request))
            return subprocess.run(['node', str(bridge), str(request_path)], capture_output=True, text=True, timeout=20)
        triage = invoke('crq.triage/v1', 24000)
        self.assertEqual(triage.returncode, 0, triage.stderr)
        detail = json.loads(json.loads(triage.stdout)['reason'])
        self.assertEqual(detail['cap'], 128000)
        self.assertEqual(detail['budget'], budget)
        self.assertEqual(detail['schema'], 'crq.triage/v1')
        ordinary = invoke('crq.judge/v1', 100)
        self.assertEqual(ordinary.returncode, 0, ordinary.stderr)
        self.assertEqual(json.loads(json.loads(ordinary.stdout)['reason'])['cap'], 20000)
        self.assertNotEqual(invoke('crq.triage/v1', 128001).returncode, 0)
        request = {'cq_bin': str(dist / 'cli.js'), 'schema': 'crq.triage/v1', 'prompt': 'invalid',
                   'modelSpec': {'provider': 'unused', 'model': 'offline'}, 'budget': budget}
        request_path.write_text(json.dumps(request))
        invalid = subprocess.run(['node', str(bridge), str(request_path)], capture_output=True, text=True, timeout=20)
        self.assertEqual(json.loads(invalid.stdout)['errorClass'], 'output-invalid')
