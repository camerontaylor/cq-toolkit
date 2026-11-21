"""Differential oracle for the repair publication remote read: the
`c.git('ls-remote', '--heads', 'origin', 'refs/heads/' + branch)` of
apps/crq-python/repair_tick.py `recover_publication`, and the
`remote.split()[0] if remote else None` line that reads it.

Test tooling only. Usage: python3 -I publicationRemoteReadsOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is
{"op": "ls_remote" | "remote_head", "clone": "<dir>", "branch": "<name>"}. A result
is {"ok": value} or {"error": "<exception class>", "message": "<str(exc)>"}.

The call is the real `crq.git` (the primary clone is the explicit `cwd`, as
`c.CLONE` is a placeholder here), so subprocess text mode, strip and the
RuntimeError text are Python's own. `origin` is a throwaway LOCAL bare
repository named in the clone's config by the test: no network, no forge, no
credential and no write (`ls-remote` only lists).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import crq  # noqa: E402


def ls_remote(case):
    return crq.git('ls-remote', '--heads', 'origin', 'refs/heads/' + case['branch'],
                   cwd=Path(case['clone']))


def run_case(case):
    op = case['op']
    if op == 'ls_remote':
        return ls_remote(case)
    if op == 'remote_head':
        remote = ls_remote(case)
        return remote.split()[0] if remote else None
    raise ValueError(op)


results = []
for case in json.load(sys.stdin)['cases']:
    try:
        results.append({'ok': run_case(case)})
    except Exception as exc:  # the class is the contract
        results.append({'error': type(exc).__name__, 'message': str(exc)})
json.dump({'results': results}, sys.stdout)
