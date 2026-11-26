"""Differential oracle for `crq_repair.mechanical` (apps/crq-python/crq_repair.py:152),
the content gate `repair_tick.harvest` runs over a fixer's claimed commits.

Test tooling only. Usage: python3 -I repairMechanicalOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is
{"wt", "base", "commits", "job", "dir", "detector": {"code","stdout","stderr"}}.
The PRODUCTION `mechanical` runs; only the `node ... gates.hackDetector` process is
replaced by the declared triple (every `git` call is real). A result is
{"ok": {...record}, "calls": [diff, ...], "patch": <text|null>} or
{"error": class, "message": str(exc), "calls": [...], "patch": <text|null>}.
"""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1])
import crq_repair  # noqa: E402
from importlib import util  # noqa: E402

# `crq_repair.py` (the module) is shadowed by the `crq_repair/` package, so, as
# `repair_tick.harvest` does, load the file by path.
spec = util.spec_from_file_location('crq_repair_service', Path(sys.argv[1]) / 'crq_repair.py')
service = util.module_from_spec(spec)
spec.loader.exec_module(service)

real_command = crq_repair.command
results = []
for case in json.load(sys.stdin)['cases']:
    calls = []

    def fake(argv, cwd=None, env=None, timeout=1200, _case=case, _calls=calls):
        if argv[0] == 'node':
            _calls.append(argv[3][len('--diff='):])
            d = _case['detector']
            return SimpleNamespace(returncode=d['code'], stdout=d['stdout'], stderr=d['stderr'])
        return real_command(argv, cwd=cwd, env=env, timeout=timeout)

    crq_repair.command = fake
    out = {}
    try:
        out['ok'] = service.mechanical({'repair': {'cq_bin': 'cq.js'}}, Path(case['wt']), case['base'],
                                          case['commits'], case['job'], case['dir'])
    except Exception as exc:  # the class is the contract
        out['error'] = type(exc).__name__
        out['message'] = str(exc)
    patch = Path(case['dir']) / 'repair.patch'
    out['calls'] = calls
    out['patch'] = patch.read_text() if patch.exists() else None
    results.append(out)
json.dump({'results': results}, sys.stdout)
