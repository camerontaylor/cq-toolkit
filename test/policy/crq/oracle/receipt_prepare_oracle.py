"""Runs crq_review_receipt.prepare/refresh on temp artifacts and scripted gh answers."""
import json, os, sys, tempfile, types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'apps', 'crq-python'))
from pathlib import Path
import crq_review_receipt as rr
import pr_review_findings as prf


def run(sc):
    calls = []
    answers = list(sc.get('gh', []))

    def gh(argv, input_text=None):
        calls.append(list(argv))
        a = answers.pop(0) if answers else {'stdout': '', 'returncode': 0}
        return types.SimpleNamespace(returncode=a.get('returncode', 0), stdout=a.get('stdout', ''), stderr=a.get('stderr', ''))

    a = sc['args']
    with tempfile.TemporaryDirectory() as d:
        for name, text in sc.get('files', {}).items():
            Path(d, name).write_bytes(text.encode('utf-8', 'surrogateescape') if isinstance(text, str) else bytes(text['bytes']))
        try:
            if sc['fn'] == 'prepare':
                out = rr.prepare(prf, gh, a['repo'], a['pr'], a['meta'], Path(d) / 'review.ndjson', a['findings'], a['login'])
            else:
                out = rr.refresh(prf, a['repo'], a['pr'], a['meta'], gh=gh, login=a['login'])
            res = {'ok': out}
        except Exception as e:  # noqa: BLE001
            res = {'err': type(e).__name__, 'msg': str(e).replace(d, '<D>')}
        res['calls'] = calls
        return res


print(json.dumps([run(s) for s in json.load(sys.stdin)]))
