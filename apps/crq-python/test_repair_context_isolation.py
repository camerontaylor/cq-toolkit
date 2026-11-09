"""A broken finding's context must not stop later findings and delivery."""
from unittest import mock

import finding_delivery as delivery
import review_ledger as ledger
from crq_repair import triage
from test_finding_delivery import FindingTest, AT
from test_review_ledger import rehash


class ContextIsolationTest(FindingTest):
    def test_invalid_initial_output_continues_then_escalates_once(self):
        original = self.value['payload']['findings'][0]
        second = delivery.normalize('crq-runner-app', 'other-run', {
            'severity': 'major', 'path': 'a', 'blob': self.f.repo.entries(self.t)['a']['blob'],
            'intervals': [[1, 1]], 'title': 'Another issue', 'body': 'Different details'})
        self.value['payload']['findings'] = [original, second]
        rehash(self.value)
        out = ledger.Outbox(self.root / 'invalid-outbox', self.f.store)
        inbox = delivery.Inbox(self.root / 'invalid-inbox', out)
        inbox.ingest(self.value)
        broken, healthy = sorted((original['id'], second['id']))
        queue = {'items': []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True)
        invalid = {'stop': 'error', 'errorClass': 'output-invalid', 'model': 'fixture'}
        valid = {'stop': 'ok', 'verdict': 'valid', 'reason': 'source confirms',
                 'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'one'}
        judge = mock.Mock(side_effect=[invalid, valid])
        result = triage.phase(inbox, self.f.repo, self.t, judge, transport, AT)
        self.assertEqual((result['judged'], result['delivered'], result['stopped']), (2, 1, None))
        self.assertEqual(judge.call_args_list[0].args[0]['finding']['id'], broken)
        self.assertEqual(judge.call_args_list[1].args[0]['finding']['id'], healthy)
        row_path = inbox.root / 'triage' / (broken + '.json')
        self.assertEqual(ledger.loads(row_path.read_bytes())['status'], 'needs-human')
        again = mock.Mock(return_value=invalid)
        result = triage.phase(inbox, self.f.repo, self.t, again, transport, AT)
        self.assertEqual(result['judged'], 1)
        self.assertTrue(again.call_args.args[0]['_escalate'])
        final = mock.Mock()
        triage.phase(inbox, self.f.repo, self.t, final, transport, AT)
        final.assert_not_called()
        events = [v for v in out.retained() if v.get('event_type') == 'finding-event'
                  and v['payload']['finding_id'] == broken]
        self.assertEqual(len(events), 2)
        self.assertEqual(sum(e['payload']['actor'].startswith('crq-triage/escalation/') for e in events), 1)

    def test_transient_initial_error_stays_pending(self):
        judge = mock.Mock(return_value={'stop': 'error', 'errorClass': 'provider'})
        result = triage.phase(self.inbox, self.f.repo, self.t, judge, mock.Mock(), AT)
        self.assertEqual((result['stopped'], result['judged']), ('error', 0))
        row = ledger.loads((self.inbox.root / 'triage' / (self.fid + '.json')).read_bytes())
        self.assertEqual(row['status'], 'untriaged')

    def test_bad_context_leaves_row_retryable_and_delivers_later_finding(self):
        original = self.value['payload']['findings'][0]
        second = delivery.normalize('crq-runner-app', 'other-run', {
            'severity': 'major', 'path': 'a', 'blob': self.f.repo.entries(self.t)['a']['blob'],
            'intervals': [[1, 1]], 'title': 'Another issue', 'body': 'Different details'})
        self.value['payload']['findings'] = [original, second]
        rehash(self.value)
        out = ledger.Outbox(self.root / 'context-outbox', self.f.store)
        inbox = delivery.Inbox(self.root / 'context-inbox', out)
        inbox.ingest(self.value)
        rows = sorted((original['id'], second['id']))
        broken, healthy = rows
        real_context = triage.context
        def context(repo, row, tip):
            if row['finding']['id'] == broken:
                raise KeyError('missing blob')
            return real_context(repo, row, tip)
        queue = {'items': []}
        transport = delivery.repair_transport(self.root, queue, lambda q: None, lambda *_: True)
        report = {'stop': 'ok', 'verdict': 'valid', 'reason': 'source confirms',
                  'current_path': 'a', 'current_lines': [[1, 1]], 'quoted_text': 'one'}
        with mock.patch.object(triage, 'context', side_effect=context):
            result = triage.phase(inbox, self.f.repo, self.t, lambda *_: report, transport, AT, maximum=1)
        self.assertEqual(result['judged'], 1)
        self.assertEqual(result['unjudged'], 1)
        self.assertEqual(result['context_errors'][0]['finding_id'], broken)
        self.assertEqual(result['delivered'], 1)
        self.assertEqual(len(queue['items']), 1)
        states = {fid: ledger.loads((inbox.root / 'triage' / (fid + '.json')).read_bytes())['status']
                  for fid in rows}
        self.assertEqual(states[broken], 'untriaged')
        self.assertEqual(states[healthy], 'delivered')
