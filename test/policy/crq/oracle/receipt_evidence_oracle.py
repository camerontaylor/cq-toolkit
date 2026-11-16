"""Runs crq_review_receipt readers on scripted gh answers; JSON scenarios in, JSON out."""
import json, os, sys, types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'apps', 'crq-python'))
import crq_review_receipt as rr
import pr_review_findings as prf


def run(sc):
    calls = []
    answers = list(sc['gh'])

    def gh(argv, input_text=None):
        calls.append(list(argv))
        a = answers.pop(0) if answers else {'stdout': '', 'returncode': 0}
        return types.SimpleNamespace(returncode=a.get('returncode', 0), stdout=a.get('stdout', ''), stderr=a.get('stderr', ''))

    fn, a = sc['fn'], sc['args']
    try:
        if fn == 'reviews':
            out = rr.reviews(prf, gh, a['repo'], a['pr'])
        elif fn == 'prior':
            out = rr.prior_receipt(prf, gh, a['repo'], a['pr'], a['meta'], a['login'])
        elif fn == 'open_major':
            exp = None
            if a.get('rows') is not None:
                exp = rr.expected_inline_major(a['rows'], a['pr'], a['login'])
            out = rr.open_major(prf, gh, a['repo'], a['pr'], a['login'], exp)
        elif fn == 'expected':
            exp = rr.expected_inline_major(a['rows'], a['pr'], a['login'])
            out = sorted([list(k), v] for k, v in exp.items())
        elif fn == 'body_major':
            out = rr.body_major_at_head(a['rows'], a['pr'], a['head'], a['login'])
        elif fn == 'owned':
            out = rr.owned_receipt(a['row'], a['login'])
        elif fn == 'merge_base':
            out = rr.current_merge_base(prf, gh, a['repo'], a['base'], a['head'])
        else:
            raise SystemExit('bad fn')
        res = {'ok': out}
    except Exception as e:  # noqa: BLE001
        res = {'err': type(e).__name__, 'msg': str(e)}
    res['calls'] = calls
    return res


print(json.dumps([run(s) for s in json.load(sys.stdin)]))
