"""Offline contract tests for the Q1/Q3 receipt seam."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import review_receipt as receipt


class ReceiptTest(unittest.TestCase):
    def test_merged_remediation_complete_and_incomplete(self):
        from types import SimpleNamespace
        import repair_tick
        finding = {"type": "finding", "severity": "major", "comment": "fix"}
        normalized = {"severity": "major", "body": "fix"}
        doc = dict(source={"repo": "o/r", "target_selector": "promoted-main"},
                   capture={"target": "a" * 40}, findings=[finding], counted=True,
                   classification={"counted": True, "outcome": "completed"},
                   outcome="terminal-with-findings")
        with tempfile.TemporaryDirectory() as td:
            rid = receipt.write_receipt(Path(td) / "receipts", doc)
            record = dict(state="published", receipt_id=rid, jobs=["j"],
                          verdicts=[dict(job="j", verdict="FIXED", finding=normalized)],
                          receipt_findings=[receipt.digest(finding)],
                          repair_findings=[receipt.digest(normalized)], fix_pr={"number": 9},
                          publication={"head": "b" * 40, "target": "a" * 40})
            item = dict(kind=receipt.KIND, subject=doc["source"], capture=doc["capture"],
                        receipt_id=rid, repair_runs={"run": record})
            info = dict(number=9, state="MERGED", baseRefName="main", headRefOid="b" * 40,
                        mergeCommit={"oid": "c" * 40})
            c = SimpleNamespace(STATE=Path(td), pr_info=lambda _: info,
                                git=lambda *args: "d" * 40, is_ancestor=lambda *args: True)
            repair_tick.reconcile_current_fix(c, item)
            self.assertTrue(receipt.remediation_fixed(item, doc, rid))
            c.pr_info = lambda _: self.fail("historical merged PR was fetched again")
            repair_tick.reconcile_current_fix(c, item)
            self.assertTrue(receipt.remediation_fixed(item, doc, rid))
            c.pr_info = lambda _: info
            complete = copy.deepcopy(item)
            for field, value in (("receipt_id", "0" * 64), ("subject", {}), ("capture", {})):
                changed = copy.deepcopy(complete)
                changed[field] = value
                self.assertFalse(receipt.remediation_fixed(changed, doc, changed["receipt_id"]))
            for field, value in (("state", "OPEN"), ("baseRefName", "other"), ("headRefOid", "e" * 40)):
                record.pop("merged_fix", None)
                record.pop("not_fixed", None)
                old = info[field]
                info[field] = value
                repair_tick.reconcile_current_fix(c, item)
                self.assertNotIn("remediation", item)
                info[field] = old
            (Path(td) / "receipts" / (rid + ".json")).unlink()
            repair_tick.reconcile_current_fix(c, item)
            self.assertNotIn("remediation", item)
            receipt.write_receipt(Path(td) / "receipts", doc)
            record.pop("not_fixed", None)
            record["verdicts"][0]["verdict"] = "NOT-FIXED"
            repair_tick.reconcile_current_fix(c, item)
            self.assertNotIn("remediation", item)
            record["verdicts"][0]["verdict"] = "FIXED"
            c.is_ancestor = lambda *args: False
            repair_tick.reconcile_current_fix(c, item)
            self.assertNotIn("remediation", item)

    def test_partial_repairs_terminal_negatives_and_item_isolation(self):
        from types import SimpleNamespace
        from unittest import mock
        import repair_tick
        with tempfile.TemporaryDirectory() as td:
            doc = dict(source={"target_selector": "promoted-main"}, capture={"target": "a" * 40},
                       findings=[{"comment": "one"}, {"comment": "two"}], counted=True,
                       classification={"counted": True, "outcome": "completed"}, outcome="terminal-with-findings")
            rid = receipt.write_receipt(Path(td) / "receipts", doc)
            record = dict(state="published", receipt_id=rid, jobs=["one", "two"],
                          verdicts=[dict(job=n, verdict="FIXED", finding={"body": n}) for n in ('one', 'two')],
                          receipt_findings=sorted(receipt.digest(f) for f in doc['findings']),
                          repair_findings=sorted(receipt.digest({"body": n}) for n in ('one', 'two')),
                          fix_pr={"number": 9}, publication={"head": "b" * 40, "target": "a" * 40})
            item = dict(kind=receipt.KIND, state='done', receipt_id=rid, subject=doc['source'],
                        capture=doc['capture'], repair_runs={'r': record})
            info = dict(number=9, state="MERGED", baseRefName="main", headRefOid="b" * 40,
                        mergeCommit={"oid": "c" * 40})
            c = SimpleNamespace(STATE=Path(td), pr_info=mock.Mock(return_value=info),
                                git=mock.Mock(return_value="d" * 40), is_ancestor=lambda *args: True)
            original = copy.deepcopy(item)
            for verdicts in (record['verdicts'][:1], [record['verdicts'][0],
                            {**record['verdicts'][1], 'verdict': 'NOT-FIXED'}]):
                changed = copy.deepcopy(original)
                changed['repair_runs']['r']['verdicts'] = verdicts
                repair_tick.reconcile_fix_prs(c, {'items': [changed]})
                self.assertNotIn('remediation', changed)
            c.pr_info.assert_not_called()
            for observation in ({**info, 'state': 'CLOSED'}, {**info, 'headRefOid': 'e' * 40}):
                changed = copy.deepcopy(original)
                c.pr_info = mock.Mock(return_value=observation)
                repair_tick.reconcile_fix_prs(c, {'items': [changed]})
                self.assertIn('not_fixed', changed['repair_runs']['r'])
                repair_tick.reconcile_fix_prs(c, {'items': [changed]})
                c.pr_info.assert_called_once()
                self.assertNotIn('remediation', changed)
            changed = copy.deepcopy(original)
            c.pr_info = mock.Mock(return_value={**info, 'baseRefName': 'other'})
            repair_tick.reconcile_fix_prs(c, {'items': [changed]})
            repair_tick.reconcile_fix_prs(c, {'items': [changed]})
            c.pr_info.assert_called_once()
            self.assertNotIn('remediation', changed)
            broken = copy.deepcopy(original)
            broken['subject'] = {}
            c.pr_info = mock.Mock(return_value=info)
            good = copy.deepcopy(original)
            repair_tick.reconcile_fix_prs(c, {'items': [broken, good]})
            self.assertIn('repair_error', broken)
            self.assertTrue(receipt.remediation_fixed(good, doc, rid))
            c.git.side_effect = RuntimeError('git unavailable')
            repair_tick.reconcile_fix_prs(c, {'items': [good]})
            self.assertNotIn('remediation', good)
            self.assertIn('repair_error', good)
            c.pr_info.side_effect = RuntimeError('forge budget exhausted')
            promotion = {'kind': 'promotion', 'repair_runs': {'r': {'fix_pr': {'number': 9}}}}
            stats = repair_tick.reconcile_fix_prs(c, {'items': [promotion, copy.deepcopy(original)]})
            self.assertNotIn('fix_merged', promotion['repair_runs']['r'])
            # The receipt lane reports its own skips: one receipt item and one
            # promotion run examined, both deferred, neither starved.
            self.assertEqual(2, stats['examined'])
            self.assertEqual(0, stats['starved'])
            self.assertEqual(2, stats['deferred'])
            no_repairs = {**original, 'repair_runs': {}}
            with mock.patch.object(Path, 'read_bytes', side_effect=AssertionError('unnecessary receipt read')):
                repair_tick.reconcile_fix_prs(c, {'items': [no_repairs]})
            self.assertNotIn('repair_error', no_repairs)
            failed = {**original, 'state': 'repair_failed', 'last_error': 'old repair error',
                      'repair_runs': {'r': {'state': 'failed'}}}
            repair_tick.harvest(c, {}, failed)
            self.assertEqual(failed['state'], 'done')
            self.assertIsNone(failed['last_error'])
            self.assertEqual(failed['repair_outcome'], 'failed')

    def test_binding_idempotence_and_conflict(self):
        q = {"items": []}
        args = dict(repo="owner/repo", pr=42, merge_sha="a" * 40, request_id="r1", at="now")
        first = receipt.enroll(q, **args)
        again = receipt.enroll(q, **{**args, "request_id": "r2"})
        self.assertFalse(again["created"])
        self.assertIs(first["item"], again["item"])
        before = copy.deepcopy(q)
        with self.assertRaises(ValueError):
            receipt.enroll(q, **{**args, "merge_sha": "b" * 40})
        self.assertEqual(q, before)
        self.assertEqual(receipt.status(q, "r2")["state"], "pending")

    def test_large_finding_restart_complete_bytes_and_tamper(self):
        with tempfile.TemporaryDirectory() as td:
            doc = {"version": 1, "findings": [{"comment": "é" * 15000}], "paths": ["a"]}
            identity = receipt.write_receipt(td, doc)
            self.assertEqual(identity, receipt.write_receipt(td, doc))
            manifest = receipt.read_receipt(td, identity)
            cursor = manifest["cursor"]
            data = b""
            while cursor:
                page = receipt.read_receipt(Path(td), identity, cursor)
                self.assertLess(len(json.dumps(page).encode()), 8192)
                chunk = base64.b64decode(page["data"])
                self.assertEqual(hashlib.sha256(chunk).hexdigest(), page["chunk_sha256"])
                data += chunk
                cursor = page["next_cursor"]
            self.assertEqual(json.loads(data), doc)
            self.assertEqual(hashlib.sha256(data).hexdigest(), identity)
            with self.assertRaises(ValueError):
                receipt.read_receipt(td, identity, "b" * 64 + ":0")
            (Path(td) / (identity + ".json")).write_text("tampered")
            with self.assertRaises(ValueError):
                receipt.read_receipt(td, identity)

    def test_noncounted_reuse_never_confers_review_credit(self):
        capture = dict(target='a' * 40, tree='b' * 40, paths=[], scope_digest=receipt.digest([]),
                       policy=receipt.POLICY, projection='current-affected-files/full-file-addition-projection',
                       reviewer='coderabbit-review-agent-committed-v1', reviewer_version='fixture')
        capture['equivalence'] = receipt.current_equivalence(capture)
        for outcome in ('no-current-code', 'unsupported'):
            doc = dict(version=1, capture=capture, counted=False, outcome=outcome,
                       classification=None, independent_acceptance=False)
            self.assertTrue(receipt.reusable_noncounted_terminal(doc, capture))
            self.assertFalse(receipt.reusable_current(doc, capture))
            for changes in (dict(counted=True), dict(classification={'counted': True}),
                            dict(independent_acceptance=True), dict(outcome='unknown'),
                            dict(version=0), dict(capture={})):
                self.assertFalse(receipt.reusable_noncounted_terminal(dict(doc, **changes), capture))
            self.assertFalse(receipt.reusable_noncounted_terminal(doc, dict(capture, tree='f' * 40)))

    def test_current_equivalence_never_upgrades_legacy_or_changes_target(self):
        capture = dict(target="a" * 40, tree="b" * 40, paths=[], scope_digest=receipt.digest([]),
                       policy=receipt.POLICY, projection="current-affected-files/full-file-addition-projection",
                       reviewer="coderabbit-review-agent-committed-v1", reviewer_version="0.8.2")
        capture["equivalence"] = receipt.current_equivalence(capture)
        doc = dict(version=1, capture=capture, counted=True, outcome="terminal-clean",
                   classification=dict(counted=True, outcome="completed"))
        self.assertTrue(receipt.reusable_current(doc, capture))
        timestamp = dict(capture, captured_at="later", base="c" * 40, head="d" * 40)
        self.assertEqual(receipt.current_equivalence(timestamp), capture["equivalence"])
        for field, value in (("target", "f" * 40), ("tree", "f" * 40), ("reviewer_version", "next")):
            self.assertFalse(receipt.reusable_current(doc, dict(capture, **{field: value})))
        self.assertFalse(receipt.reusable_current(dict(doc, capture={"equivalence": capture["equivalence"]}), capture))
        self.assertFalse(receipt.reusable_current(dict(doc, classification=dict(counted=False, outcome="skipped")), capture))
        self.assertFalse(receipt.reusable_current(dict(doc, outcome="no-current-code"), capture))
        self.assertFalse(receipt.reusable_current(dict(doc, capture=dict(capture, paths=["forged"])), capture))
