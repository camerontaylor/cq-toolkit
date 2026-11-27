"""Differential oracle for the repair publication claimed-range verification:
the real `crq_repair.verify` (apps/crq-python/crq_repair/__init__.py), called by
`repair_tick.publish` and `harvest`, against throwaway local repositories.

Test tooling only. Usage: python3 -I publicationVerifyOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is
{"wt": "<dir>", "base": str, "commits": [str], "job": str}. A result is
{"ok": "<HEAD verify returned>"} or {"error": "<exception class>", "message": "<str(exc)>"}.

No network, forge or write: `verify` runs read-only git calls in the worktree.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from crq_repair import verify  # noqa: E402

results = []
for case in json.load(sys.stdin)['cases']:
    try:
        results.append({'ok': verify(Path(case['wt']), case['base'], case['commits'], case['job'])})
    except Exception as exc:  # the class is the contract
        results.append({'error': type(exc).__name__, 'message': str(exc)})
json.dump({'results': results}, sys.stdout)
