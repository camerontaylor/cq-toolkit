"""Run crq_review_identity / select_receipt_identity against scripted subprocess answers."""
import json
import os
import subprocess
import sys
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', 'apps', 'crq-python'))
import crq_review_identity as ident  # noqa: E402
import pr_review_findings as prf  # noqa: E402

NOW = 1_800_000_000.0
ERRORS = {'missing': FileNotFoundError('x'), 'other': OSError('x'), 'timeout': subprocess.TimeoutExpired('x', 1)}


def answer(a):
    if isinstance(a, str):
        raise ERRORS[a]
    return SimpleNamespace(returncode=a.get('returncode', 0), stdout=a.get('stdout', ''), stderr=a.get('stderr', ''))


def run_one(sc):
    calls = []
    answers = list(sc.get('procs', []))

    def fake_run(argv, **kw):
        env = kw.get('env')
        calls.append({'argv': list(argv), 'input': kw.get('input'), 'timeout': kw.get('timeout'),
                      'env': None if env is None else {k: v for k, v in sorted(env.items())}})
        a = answers.pop(0)
        if isinstance(a, str):
            raise ERRORS[a]
        return answer(a)

    out = {'calls': calls}
    with mock.patch.object(ident.subprocess, 'run', side_effect=fake_run), \
         mock.patch.object(ident.time, 'time', side_effect=lambda: sc.get('clock', NOW)), \
         mock.patch.dict(ident.os.environ, sc.get('env', {}), clear=True):
        try:
            if sc['fn'] == 'gh':
                gh = ident.authenticated_gh('o/r')
                results = []
                for step in sc.get('steps', []):
                    if 'clock' in step:
                        sc['clock'] = step['clock']
                    try:
                        r = gh(step['argv'], input_text=step.get('input'))
                        results.append({'rc': r.returncode, 'out': r.stdout, 'err': r.stderr})
                    except Exception as exc:  # noqa: BLE001
                        results.append({'err': type(exc).__name__, 'msg': str(exc)})
                out['ok'] = results
            else:
                meta = dict(sc['meta'])
                checkpoints = []
                if sc.get('checkpoint'):
                    meta['identity_checkpoint'] = lambda login, reason: checkpoints.append([login, reason])
                gh_calls = []
                app_gh = lambda argv, input_text=None: SimpleNamespace(returncode=0, stdout='app-login\n', stderr='')  # noqa: E731

                def host_gh(argv, input_text=None):
                    gh_calls.append(list(argv))
                    return SimpleNamespace(returncode=0, stdout=sc.get('host_login', 'host-login') + '\n', stderr='')

                if sc.get('app') == 'ok':
                    patcher = mock.patch.object(ident, 'authenticated_gh', return_value=app_gh)
                else:
                    patcher = mock.patch.object(ident, 'authenticated_gh',
                                                side_effect=ident.IdentityUnavailable(sc.get('app', 'helper-missing')))
                with patcher:
                    gh, login, nmeta = prf.select_receipt_identity('o/r', meta, host_gh, sc.get('login'), sc['injected'])
                nmeta = {k: v for k, v in nmeta.items() if k != 'identity_checkpoint'}
                out['ok'] = {'login': login, 'meta': nmeta, 'app': gh is app_gh, 'gh_calls': gh_calls,
                             'checkpoints': checkpoints}
        except Exception as exc:  # noqa: BLE001
            out['err'] = type(exc).__name__
            out['msg'] = str(exc)
    return out


print(json.dumps([run_one(s) for s in json.load(sys.stdin)]))
