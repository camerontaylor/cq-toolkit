"""Differential oracle for `crq_repair.bounded.require_canonical_delivery`
(apps/crq-python/crq_repair/bounded.py:72), the ownership check `repair_tick.harvest`
runs in its `written_back=True` form.

Test tooling only. Usage: python3 -I repairCanonicalDeliveryOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is
{"root": "<dir>", "job_text": "<json text>", "written_back": bool,
 "retained": null | {"events_text": "<json text>"} | {"raise": "<class>"}}. Texts are decoded
here so an integer beyond 2**53 or a NaN token reaches both sides exactly. The production function runs against the files under `root`; the
declared `retained` stands in for `finding_inbox(c).publication.retained()`. A result is
{"ok": true} or {"error": "<class>", "message": "<str(exc)>"}.
"""
import json
import sys

sys.path.insert(0, sys.argv[1])
from crq_repair.bounded import require_canonical_delivery  # noqa: E402

RAISES = {'OSError': OSError, 'ValueError': ValueError, 'KeyError': KeyError,
          'TypeError': TypeError, 'RuntimeError': RuntimeError}
results = []
for case in json.load(sys.stdin)['cases']:
    declared = case['retained']
    if declared is None:
        retained = None
    elif 'raise' in declared:
        def retained(_cls=RAISES[declared['raise']]):
            raise _cls('boom')
    else:
        def retained(_events=json.loads(declared['events_text'])):
            return _events
    try:
        require_canonical_delivery(case['root'], json.loads(case['job_text']),
                                   written_back=case['written_back'], retained=retained)
        results.append({'ok': True})
    except Exception as exc:  # the class is the contract
        results.append({'error': type(exc).__name__, 'message': str(exc)})
json.dump({'results': results}, sys.stdout)
