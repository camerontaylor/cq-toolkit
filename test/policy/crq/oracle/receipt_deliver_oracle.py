"""Runs pr_review_findings.deliver (receipt mode) live, with canned prior_receipt/prepare."""
import json, os, sys, types
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'apps', 'crq-python'))
import pr_review_findings as prf
import crq_review_receipt as rcpt


def dump(v):
    return json.dumps(v, sort_keys=True, separators=(',', ':'))


def run(sc):
    calls = []
    answers = list(sc.get('gh', []))

    def gh(argv, input_text=None):
        calls.append(list(argv) + ([input_text] if input_text is not None else []))
        a = answers.pop(0) if answers else {'stdout': '', 'returncode': 0}
        return types.SimpleNamespace(returncode=a.get('returncode', 0), stdout=a.get('stdout', ''), stderr=a.get('stderr', ''))

    def fail(spec):
        raise {'ValueError': ValueError, 'RuntimeError': RuntimeError}[spec['raise']](spec['msg'])

    def prior(prf_, gh_, repo, pr, meta, login):
        calls.append(['prior', repo, str(pr), login, dump(meta)])
        spec = sc.get('prior')
        if spec and 'raise' in spec:
            fail(spec)
        return spec

    def prepare(prf_, gh_, repo, pr, meta, ndjson, findings, login):
        calls.append(['prepare', repo, str(pr), login, dump(meta), dump(findings)])
        spec = sc.get('prepare')
        if spec is None:
            return None
        if 'raise' in spec:
            fail(spec)
        return {**meta, **spec}

    prf.load_findings = lambda p, highest_severity=False: sc['findings']
    rcpt.prior_receipt = prior
    rcpt.prepare = prepare
    try:
        out = prf.deliver(sc.get('repo', 'o/r'), sc.get('pr', 5), sc['meta'], 'unused.ndjson', gh, sc.get('login'))
        res = {'ok': out, 'order': list(out)}
    except Exception as e:  # noqa: BLE001
        res = {'err': type(e).__name__, 'msg': str(e)}
    res['calls'] = calls
    return res


print(json.dumps([run(s) for s in json.load(sys.stdin)], ensure_ascii=True))
