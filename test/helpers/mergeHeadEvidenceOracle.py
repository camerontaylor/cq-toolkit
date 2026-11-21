"""Differential oracle for merge-tree repair credit: the real
`repair_tick.merge_head_evidence` and its location comparison
(`diff_changed_locations` / `change_undone`, apps/crq-python/repair_tick.py).

Test tooling only. Usage: python3 -I mergeHeadEvidenceOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is one of

  {"op": "evidence", "clone": "<dir>", "state": "<dir>", "published": str,
   "commits": [str], "path": str, "actual": str, "merge": str | null}
      `state` holds repair/inbox/<job>.json naming the anchor path; the case
      builds the record `merge_head_evidence` reads (one FIXED verdict).
  {"op": "undone", "published": "<patch text>", "head": "<patch text>"}
      `change_undone(diff_changed_locations(published), diff_changed_locations(head))`,
      each pair rendered as [str(line), text].

A result is {"ok": value} or {"error": "<exception class>", "message": "<str(exc)>"}.

Every call is the real function over a throwaway local repository: `crq.git`
and `crq.is_ancestor` with the case's clone as the explicit directory. No
network, forge or write.
"""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1])
import crq  # noqa: E402
import repair_tick  # noqa: E402


def run_case(case):
    if case['op'] == 'undone':
        pairs = repair_tick.change_undone(repair_tick.diff_changed_locations(case['published']),
                                          repair_tick.diff_changed_locations(case['head']))
        return [[str(line), text] for line, text in pairs]
    clone = Path(case['clone'])
    c = SimpleNamespace(
        STATE=Path(case['state']),
        git=lambda *args: crq.git(*args, cwd=clone),
        is_ancestor=lambda a, b: crq.is_ancestor(a, b, clone=clone))
    record = {'publication': {'head': case['published'], 'commits': case['commits']},
              'verdicts': [{'job': 'job1', 'verdict': 'FIXED'}]}
    return repair_tick.merge_head_evidence(c, record, case['actual'], merge=case['merge'])


results = []
for case in json.load(sys.stdin)['cases']:
    try:
        results.append({'ok': run_case(case)})
    except Exception as exc:  # the class is the contract
        results.append({'error': type(exc).__name__, 'message': str(exc)})
json.dump({'results': results}, sys.stdout)
