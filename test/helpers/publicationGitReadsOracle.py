"""Differential oracle for the repair publication Git reads: the `c.git`,
`c.is_ancestor` and `wt_git` calls of apps/crq-python/repair_tick.py `publish`
against throwaway local repositories.

Test tooling only. Usage: python3 -I publicationGitReadsOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is
{"op": "default_ref" | "is_ancestor" | "wt" | "rev_list", "clone": "<dir>",
 "wt": "<dir>", "args": [str]}. A result is {"ok": value} or
{"error": "<exception class>", "message": "<str(exc)>"}.

Every call is the real function: `crq.git` and `crq.is_ancestor` (the primary
clone is the explicit `cwd`/`clone` argument, as `c.CLONE` is a placeholder
here) and `crq_repair.git` (`wt_git`). `rev_list` adds the `.splitlines()` of
`publish`. No network, forge or write: the cases are read-only git calls.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import crq  # noqa: E402
from crq_repair import git as wt_git  # noqa: E402


def run_case(case):
    op = case['op']
    if op == 'default_ref':
        return crq.git('rev-parse', crq.DEFAULT_REF, cwd=Path(case['clone']))
    if op == 'is_ancestor':
        return crq.is_ancestor(*case['args'], clone=Path(case['clone']))
    if op == 'wt':
        return wt_git(Path(case['wt']), *case['args'])
    if op == 'rev_list':
        return wt_git(Path(case['wt']), *case['args']).splitlines()
    raise ValueError(op)


results = []
for case in json.load(sys.stdin)['cases']:
    try:
        results.append({'ok': run_case(case)})
    except Exception as exc:  # the class is the contract
        results.append({'error': type(exc).__name__, 'message': str(exc)})
json.dump({'results': results}, sys.stdout)
