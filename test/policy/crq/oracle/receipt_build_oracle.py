"""Runs build_review / added_ranges / load_findings / diff_hunks (receipt modes) live."""
import json, os, sys, tempfile, types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'apps', 'crq-python'))
from pathlib import Path
import pr_review_findings as prf


def run(sc):
    calls = []
    answers = list(sc.get('gh', []))

    def gh(argv, input_text=None):
        calls.append(list(argv))
        a = answers.pop(0) if answers else {'stdout': '', 'returncode': 0}
        return types.SimpleNamespace(returncode=a.get('returncode', 0), stdout=a.get('stdout', ''), stderr=a.get('stderr', ''))

    a = sc['args']
    try:
        if sc['fn'] == 'build':
            hunks = a['hunks']
            if hunks is not None:
                hunks = {k: [tuple(r) for r in v] for k, v in hunks.items()}
            out = prf.build_review(a['meta'], a['findings'], hunks)
        elif sc['fn'] == 'added':
            out = [list(r) for r in prf.added_ranges(a['patch'])]
        elif sc['fn'] == 'load':
            with tempfile.TemporaryDirectory() as d:
                p = Path(d) / 'review.ndjson'
                p.write_text(a['text'], encoding='utf-8')
                out = prf.load_findings(p, highest_severity=a['highest'])
        else:
            out = {k: [list(r) for r in v] for k, v in prf.diff_hunks(gh, 'o/r', a['base'], a['head'], changed_only=a['changed']).items()}
        res = {'ok': out}
    except Exception as e:  # noqa: BLE001
        res = {'err': type(e).__name__, 'msg': str(e)}
    res['calls'] = calls
    return res


print(json.dumps([run(s) for s in json.load(sys.stdin)], ensure_ascii=True))
