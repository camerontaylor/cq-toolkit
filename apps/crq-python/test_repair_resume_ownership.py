"""Resume candidate selection adopts only the job's own worktree. Offline.

`resume_worktree` restores the tree a resume state records, but only a tree the
job owns: directly under the resolved worktree root and named
`crq-repair-<item>-<job>` or that name plus `-A2` (the rule `recovery` and
`cleanup_harvested` apply). Fixtures are throwaway directories with a `.git`
file; nothing runs Git, a judge, a driver, a provider or the network, and
`process` is stopped at its first effect (`atomic` and `retain` are recorded).
"""
import importlib.util
import json
import shutil
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('repair_resume_ownership_under_test', ROOT / 'crq_repair.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

ITEM = 'pr1-merged'
JOB = 'crq-run1-F1'
BASE = f'crq-repair-{ITEM}-{JOB}'
A2 = BASE + '-A2'


class Stop(BaseException):
    pass


class ResumeOwnershipTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.wt_root = self.root / 'wt'
        self.wt_root.mkdir()

    def tree(self, relative, *, git=True):
        path = (self.wt_root / relative)
        path.mkdir(parents=True, exist_ok=True)
        if git:
            (path / '.git').write_text('gitdir: ../fake\n')
        return path

    def resume(self, recorded, wt):
        return service.resume_worktree({'worktree': str(recorded)}, wt, self.wt_root, ITEM, JOB)

    # --- legitimate controls -------------------------------------------------
    def test_owned_a2_is_adopted_from_the_base_tree(self):
        base, a2 = self.tree(BASE), self.tree(A2)
        self.assertEqual(self.resume(a2, base), a2.resolve())

    def test_owned_base_is_adopted_from_the_a2_tree(self):
        base, a2 = self.tree(BASE), self.tree(A2)
        self.assertEqual(self.resume(base, a2), base.resolve())

    def test_the_tree_in_hand_is_kept_when_it_is_the_recorded_tree(self):
        base = self.tree(BASE)
        self.assertEqual(self.resume(base, base), base)

    def test_owned_tree_named_through_a_link_that_resolves_to_it_is_adopted(self):
        base, a2 = self.tree(BASE), self.tree(A2)
        link = self.wt_root / 'alias'
        link.symlink_to(a2)
        self.assertEqual(self.resume(link, base), a2.resolve())

    # --- formerly adopted, now kept ------------------------------------------
    def assertKept(self, recorded, wt):
        self.assertEqual(self.resume(recorded, wt), wt)

    def test_foreign_job_and_item_are_not_adopted(self):
        base = self.tree(BASE)
        for name in (f'crq-repair-{ITEM}-crq-run1-F2', f'crq-repair-{ITEM}-crq-run1-F2-A2',
                     f'crq-repair-pr2-merged-{JOB}', f'crq-repair-pr2-merged-{JOB}-A2'):
            with self.subTest(name=name):
                self.assertKept(self.tree(name), base)

    def test_legacy_unrelated_and_over_suffixed_names_are_not_adopted(self):
        base = self.tree(BASE)
        for name in (f'crq-repair-{ITEM}', 'scratch', A2 + '-A2', BASE + '-A3', BASE + '-a2'):
            with self.subTest(name=name):
                self.assertKept(self.tree(name), base)

    def test_outside_nested_and_root_trees_are_not_adopted(self):
        base = self.tree(BASE)
        outside = self.root / 'elsewhere' / BASE
        outside.mkdir(parents=True)
        (outside / '.git').write_text('gitdir: ../fake\n')
        self.assertKept(outside, base)
        self.assertKept(self.tree('sub/' + BASE), base)
        (self.wt_root / '.git').write_text('gitdir: ../fake\n')
        self.assertKept(self.wt_root, base)

    def test_owned_name_that_resolves_elsewhere_is_not_adopted(self):
        base = self.tree(BASE)
        target = self.tree('real')
        link = self.wt_root / A2
        link.symlink_to(target)
        self.assertKept(link, base)

    def test_owned_but_missing_or_not_a_checkout_is_not_adopted(self):
        base = self.tree(BASE)
        self.assertKept(self.wt_root / A2, base)
        self.assertKept(self.tree(A2, git=False), base)

    def test_ownership_uses_the_resolved_worktree_root(self):
        base, a2 = self.tree(BASE), self.tree(A2)
        link_root = self.root / 'link-root'
        link_root.symlink_to(self.wt_root)
        self.assertEqual(service.resume_worktree({'worktree': str(a2)}, base, link_root, ITEM, JOB), a2.resolve())

    def test_falsy_recorded_worktree_keeps_the_tree_without_a_root_lookup(self):
        base = self.tree(BASE)
        for recorded in (None, '', 0, [], {}):
            with self.subTest(recorded=recorded):
                self.assertEqual(service.resume_worktree({'worktree': recorded}, base, 1, ITEM, JOB), base)

    # --- process: refusal and fallback ---------------------------------------
    def run_process(self, flags, recorded):
        directory = self.root / 'state/repair' / JOB
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True)
        (directory / 'progress.json').write_text(json.dumps({**flags, 'worktree': str(recorded)}))
        job = {'job': JOB, 'item': ITEM, 'repair_base': 'a' * 40, 'source_sha': 'c' * 40,
               'finding_sha256': 'd' * 64}
        config = {'repair': {'roles': {}}, 'worktree_root': str(self.wt_root)}
        effects = []

        def atomic(path, payload):
            effects.append((Path(path).name, payload))
            if Path(path).name == 'job.json':
                raise Stop()

        def retain(wt, base, directory):
            effects.append(('retain', str(wt)))
            raise Stop()

        base = self.wt_root / BASE
        with mock.patch.object(service, 'ROOT', self.root), mock.patch.object(service, 'atomic', atomic), \
                mock.patch.object(service, 'retain', retain):
            try:
                result = service.process(config, job, base)
            except Stop:
                result = None
        return result, effects

    def test_foreign_candidate_refuses_a_pending_stage_instead_of_judging_it(self):
        self.tree(BASE)
        for stage in ('pending_judge', 'pending_mechanical'):
            for name in (f'crq-repair-{ITEM}-crq-run1-F2', 'scratch', f'sub/{BASE}'):
                with self.subTest(stage=stage, name=name):
                    self.tree(name)
                    result, effects = self.run_process({stage: {'rung': 0}}, self.wt_root / name)
                    self.assertEqual(result['verdict'], 'FAILED')
                    kind = 'judge' if stage == 'pending_judge' else 'mechanical'
                    self.assertEqual(result['reason'], f'pending {kind} worktree unavailable; needs human')
                    self.assertNotIn(stage, result)
                    self.assertEqual([name for name, _ in effects], ['result.json'])

    def test_owned_a2_candidate_proceeds_past_the_refusal(self):
        self.tree(BASE)
        self.tree(A2)
        result, effects = self.run_process({'pending_judge': {'rung': 1}}, self.wt_root / A2)
        self.assertIsNone(result)
        self.assertEqual([name for name, _ in effects], ['job.json'])

    def test_dispatch_pending_with_a_foreign_tree_never_retains_it(self):
        self.tree(BASE)
        self.tree('scratch')
        result, effects = self.run_process({'dispatch_pending': {'rung': 'A0'}}, self.wt_root / 'scratch')
        self.assertEqual(result['reason'], 'worker interrupted with unknown outcome; needs human')
        self.assertEqual([name for name, _ in effects], ['result.json'])

    def test_dispatch_pending_with_the_owned_a2_tree_retains_it(self):
        self.tree(BASE)
        a2 = self.tree(A2)
        _, effects = self.run_process({'dispatch_pending': {'rung': 'A0'}}, a2)
        self.assertEqual(effects, [('retain', str(a2.resolve()))])


if __name__ == '__main__':
    unittest.main()
