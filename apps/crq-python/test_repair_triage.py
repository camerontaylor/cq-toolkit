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


class PhaseTest(FindingTest):
    def run_phase(self, report=None, dry=False, maximum=6):
        queue = {'items': []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True)
        judge = mock.Mock(return_value=report or {'stop': 'ok', 'verdict': 'valid', 'reason': 'source confirms',
                        'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'one'})
        result = phase(self.inbox, self.f.repo, self.t, judge, transport, AT, dry_run=dry, maximum=maximum)
        return result, queue, judge

    def test_real_delivery_and_replay_are_idempotent(self):
        result, queue, _ = self.run_phase()
        self.assertEqual(result['delivered'], 1)
        self.assertEqual(len(queue['items']), 1)
        job = next((self.root / 'state/repair/inbox').glob('*.json'))
        self.assertEqual(ledger.loads(job.read_bytes())['canonical_finding_id'], self.fid)
        self.assertEqual(self.run_phase()[0]['delivered'], 0)

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

    def test_bad_quote_cannot_confirm(self):
        result, _, _ = self.run_phase({'stop': 'ok', 'verdict': 'valid', 'reason': 'asserted',
                                     'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'wrong'})
        self.assertEqual(result['counts'], {'needs-human': 1})

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
        c = SimpleNamespace(STATE=self.root / 'state', iso=lambda: AT)
        with mock.patch.object(repair_tick, 'finding_inbox', return_value=self.inbox):
            messages = repair_tick.harvest(c, queue, item)
        row = ledger.loads((self.inbox.root / 'triage' / (self.fid + '.json')).read_bytes())
        self.assertEqual(row['status'], 'dismissed')
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
        self.assertIn('explicitly retired', request['prompt'])
        self.assertIn('contract silence alone does not imply uncertainty', request['prompt'])
        self.assertIn('relevant source evidence is missing', request['prompt'])
        self.assertNotIn('is still required by the current contract', request['prompt'])
        self.assertIn('absent or truncated', request['prompt'])
        self.assertEqual(request['schema'], 'crq.triage/v1')

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
