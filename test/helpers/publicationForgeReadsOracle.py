"""Differential oracle for the repair publication forge reads: `crq.pr_info`,
the `pr list` `c.gh_json` call of apps/crq-python/repair_tick.py, and the real
`repair_tick.recover_publication` that consumes both.

Test tooling only. Usage: python3 -I publicationForgeReadsOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A result is
{"ok": value, "calls": [call]} or {"error": "<class>", "message": "<str(exc)>",
"calls": [call]}; a call is {"argv", "cwd", "timeout"} for one subprocess.

The transport is fake: `subprocess.run` is replaced by a scripted function, one
entry per request ({"exit": n, "stdout": s, "stderr": s} | {"timeout": true} |
{"missing": true}); no forge, network or process is touched. Text mode is
reproduced (universal newlines on both pipes). Non-finite floats are written as
{"$float": "nan" | "inf" | "-inf"} so the result stays strict JSON.

Ops:
- "pr_info": `crq.pr_info(pr)`, the `--repo` from `crq.REPO`, optionally inside
  a `crq.forge_window(ForgeBudget(...))` (budget: {"requests", "seconds"}, a
  constant clock).
- "branch_prs": the `c.gh_json(['pr', 'list', ...])` call of `recover_publication`.
- "recover": the real `repair_tick.recover_publication`, with `c.git`,
  `c.is_ancestor` and `finalize_publication` recorded stubs and the forge calls
  real. The result is {"events": [...], "record": {...}}.
"""
import json
import math
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, sys.argv[1])
import crq  # noqa: E402
import repair_tick  # noqa: E402

CLONE = '/placeholder/clone'
REPO = 'camerontaylor/example'


def clean(value):
    if isinstance(value, float) and not math.isfinite(value):
        return {'$float': 'nan' if math.isnan(value) else ('inf' if value > 0 else '-inf')}
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def universal(text):
    return text.replace('\r\n', '\n').replace('\r', '\n')


class Transport:
    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def run(self, cmd, cwd=None, capture_output=False, text=False, env=None, input=None, timeout=None):
        assert capture_output and text, 'crq.run must capture text'
        self.calls.append({'argv': list(cmd), 'cwd': cwd, 'timeout': timeout})
        if not self.script:
            raise AssertionError('transport script exhausted')
        step = self.script.pop(0)
        if step.get('timeout'):
            raise subprocess.TimeoutExpired(cmd, timeout)
        if step.get('missing'):
            raise FileNotFoundError(2, 'No such file or directory', cmd[0])
        return subprocess.CompletedProcess(
            cmd, step['exit'], universal(step.get('stdout', '')), universal(step.get('stderr', ''))
        )


def budget_of(spec):
    if spec is None:
        return None
    return crq.ForgeBudget(requests=spec['requests'], seconds=spec['seconds'], clock=lambda: 100.0)


def forge(case, transport):
    crq.CLONE = Path(CLONE)
    crq.REPO = REPO
    subprocess.run = transport.run
    crq.subprocess.run = transport.run
    return crq.forge_window(budget_of(case.get('budget')))


def branch_args(branch):
    return ['pr', 'list', '--repo', crq.REPO, '--head', branch, '--state', 'all',
            '--json', 'number,url,state,headRefOid']


def recover(case):
    events = []
    ancestors = case.get('ancestors', {})

    def git(*args, **kwargs):
        if args[:2] == ('ls-remote', '--heads'):
            events.append(['ls-remote', args[-1]])
            return case.get('ls_remote', '')
        events.append(['git', *args])
        return ''

    def is_ancestor(a, b, **kwargs):
        events.append(['is_ancestor', a, b])
        return bool(ancestors.get(a + '>' + b))

    c = SimpleNamespace(git=git, is_ancestor=is_ancestor, pr_info=crq.pr_info,
                        gh_json=crq.gh_json, REPO=crq.REPO)
    repair_tick.finalize_publication = lambda *a, **k: events.append(['finalize'])
    record = dict(case.get('record', {}))
    repair_tick.recover_publication(c, {}, case['item'], {}, record, case['publication'])
    return {'events': events, 'record': record}


def run_case(case, transport):
    op = case['op']
    with forge(case, transport):
        if op == 'pr_info':
            return crq.pr_info(case['pr'])
        if op == 'branch_prs':
            return crq.gh_json(branch_args(case['branch']))
        if op == 'recover':
            return recover(case)
    raise ValueError(op)


results = []
for case in json.load(sys.stdin)['cases']:
    transport = Transport(case.get('script', []))
    try:
        results.append({'ok': clean(run_case(case, transport)), 'calls': transport.calls})
    except Exception as exc:  # the class is the contract
        results.append({'error': type(exc).__name__, 'message': str(exc), 'calls': transport.calls})
json.dump({'results': results}, sys.stdout)
