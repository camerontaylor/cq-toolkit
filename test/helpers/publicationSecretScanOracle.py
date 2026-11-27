"""Differential oracle for the repair publication secret scan: the real
`crq.secret_scan` (apps/crq-python/crq.py), called by `repair_tick.publish`
over the final rebased publication, against throwaway local repositories.

Test tooling only. Usage: python3 -I publicationSecretScanOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is
{"clone": "<dir>", "base": str, "head": str, "out": "<report path>", "path": "<PATH>"}.
A result is {"ok": bool, "report": "<report file text, or null if none>"} or
{"error": "<exception class>", "message": "<str(exc)>", "report": ...}.

`crq.CLONE` is the primary clone the case names (the module's placeholder is
replaced per case), and `PATH` is the case's, so `shutil.which("gitleaks")`
finds exactly the fake binary the case installs, or none. No network, forge or
real secret: the repositories are synthetic and the only writes are the report
file and the fixtures the test itself made.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import crq  # noqa: E402


def report_text(out):
    try:
        return Path(out).read_text()
    except FileNotFoundError:
        return None


results = []
for case in json.load(sys.stdin)['cases']:
    crq.CLONE = Path(case['clone'])
    os.environ['PATH'] = case['path']
    out = case['out']
    try:
        ok, _ = crq.secret_scan(case['base'], case['head'], Path(out))
        results.append({'ok': ok, 'report': report_text(out)})
    except Exception as exc:  # the class is the contract
        results.append({'error': type(exc).__name__, 'message': str(exc), 'report': report_text(out)})
json.dump({'results': results}, sys.stdout)
