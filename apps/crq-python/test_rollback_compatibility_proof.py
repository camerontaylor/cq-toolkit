"""Offline proof on exact prior modules, private copied inputs; never run live."""
import json
from pathlib import Path
import unittest
import admission_history
import review_ledger as ledger

class RollbackProof(unittest.TestCase):
    def test_prior_queue_reader_preserves_current_author_state(self):
        path = Path('/home/ctaylor/scratch/crq-rollback-proof-20261109/queue.json')
        before = path.read_bytes()
        original = json.loads(before)
        loaded, _ = admission_history.load(path)
        self.assertIn('author_requests', original)
        self.assertEqual(loaded['author_requests'], original['author_requests'])
        self.assertEqual(loaded['items'], original['items'])
        self.assertEqual(path.read_bytes(), before)

    def test_prior_rejects_new_needs_retriage_event(self):
        payload = {'finding_id': 'a'*64, 'review_id': 'b'*64, 'previous_event_id': None,
                   'action': 'needs-human', 'evidence': {'reason': 'fixture'}, 'actor': 'proof'}
        event = ledger.event('finding-event', 'proof', '2026-11-09T00:00:00Z', payload)
        ledger.validate(event)
        payload['action'] = 'needs-retriage'
        with self.assertRaises(ledger.IntegrityError):
            ledger.event('finding-event', 'proof', '2026-11-09T00:00:00Z', payload)
