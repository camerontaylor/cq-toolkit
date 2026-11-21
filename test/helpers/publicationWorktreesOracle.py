"""Differential oracle for the repair publication local Git writes: the real
`crq.make_worktree`, `crq.remove_worktree`, `crq_repair.git` (the `wt_git` of
`repair_tick.publish`, used for `cherry-pick`) and `crq.git('update-ref', ...)`
against throwaway local repositories.

Test tooling only. Usage: python3 -I publicationWorktreesOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [[result]]}. A case is
{"clone": "<dir>", "wtRoot": "<dir>", "prefix": str, "steps": [step]}; a step is
one of
  {"op": "make", "name": str, "commit": str}
  {"op": "remove", "path": str, "branch": str}
  {"op": "cherry", "path": str, "commit": str}
  {"op": "update_ref", "ref": str, "commit": str}
A result is {"ok": true} or {"error": "<exception class>", "message": str(exc)}.
Every step runs in order, so a later step sees the state an earlier one left.

`crq.CLONE`, `crq.WT_ROOT` and `crq.WT_PREFIX` are the module placeholders the
real functions read at call time; they are pointed at the case's disposable
directories. No network, forge or existing worktree is touched.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import crq  # noqa: E402
from crq_repair import git as wt_git  # noqa: E402


def run_step(step):
    op = step['op']
    if op == 'make':
        crq.make_worktree(step['name'], step['commit'])
    elif op == 'remove':
        crq.remove_worktree(Path(step['path']), step['branch'])
    elif op == 'cherry':
        wt_git(Path(step['path']), 'cherry-pick', step['commit'])
    elif op == 'update_ref':
        crq.git('update-ref', step['ref'], step['commit'])
    else:
        raise ValueError(op)


results = []
for case in json.load(sys.stdin)['cases']:
    crq.CLONE = Path(case['clone'])
    crq.WT_ROOT = Path(case['wtRoot'])
    crq.WT_PREFIX = case['prefix']
    steps = []
    for step in case['steps']:
        try:
            run_step(step)
            steps.append({'ok': True})
        except Exception as exc:  # the class is the contract
            steps.append({'error': type(exc).__name__, 'message': str(exc)})
    results.append(steps)
json.dump({'results': results}, sys.stdout)
