"""Differential oracle for the worker process boundary of `crq_repair.drain_items`:
runs the REAL forking coordinator with scripted `drain_item` bodies and reports what
each forked child put on its private pipe, which items were forked, the narration the
coordinator printed and the returned worker failures.

Test tooling only; Python 3.14 is the pinned oracle (the production minor).
Usage: python3.14 -I repairWorkerOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is
{"order": [item], "limit": n, "marker": bool (state/runner-disabled exists),
 "scenarios": {item: {"outcome": "rate-limit" | "runner-disabled", "crash": "exit9" | "signal" | "raise",
                      "gate": "refuse" (the runner marker appears between the parent's and the child's gate),
                      "waitFor": "<substring>" (block until the coordinator narrates it; bounded 20 s)}}}.
A result is {"failures": [item], "forked": [item in fork order], "bytes": {item: "<bytes the child wrote
on the private pipe, in order>"}, "narration": [coordinator narration, parent process only], "error": null | "<class>"}.
Every child ends on its own; nothing here signals a child except a scripted self-SIGKILL.
No network, no git, no queue state: an isolated temporary ROOT.
"""
import importlib.util
import json
import os
import signal
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

sys.path.insert(0, sys.argv[1])
SPEC = importlib.util.spec_from_file_location('crq_repair_script', Path(sys.argv[1]) / 'crq_repair.py')
repair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(repair)


def run_case(case):
    root = Path(tempfile.mkdtemp(prefix='repair-worker-oracle-'))
    (root / 'state').mkdir()
    if case.get('marker'):
        (root / 'state/runner-disabled').write_text('')
    log = root / 'log'
    log.mkdir()
    parent = os.getpid()
    order = case['order']
    scenarios = case.get('scenarios', {})
    forks = []
    narrated = root / 'narrated'
    real_fork, real_write, real_narrate = os.fork, os.write, repair.narrate
    state = {'child_item': None}

    def fork():
        pid = real_fork()
        if pid == 0:
            state['child_item'] = order[len(forks)]
        else:
            forks.append(order[len(forks)])
        return pid

    def write(fd, data):
        item = state['child_item']
        if item is not None and data in (b'a', b'x'):
            with open(log / item, 'ab') as handle:
                handle.write(data)
        return real_write(fd, data)

    def narrate(message):
        real_narrate(message)
        if os.getpid() == parent:
            with open(narrated, 'a') as handle:
                handle.write(message + '\n')

    def runner_disabled():
        item = state['child_item']
        if item is not None and scenarios.get(item, {}).get('gate') == 'refuse':
            return True
        return (root / 'state/runner-disabled').exists()

    def drain_item(config, item, ids):
        spec = scenarios.get(item, {})
        wait = spec.get('waitFor')
        deadline = time.monotonic() + 20
        while wait and time.monotonic() < deadline:
            if narrated.exists() and wait in narrated.read_text():
                break
            time.sleep(0.01)
        crash = spec.get('crash')
        if crash == 'exit9':
            os._exit(9)
        if crash == 'signal':
            os.kill(os.getpid(), signal.SIGKILL)
        if crash == 'raise':
            raise RuntimeError('scripted failure')
        return spec.get('outcome')

    config = {'repair': {'max_concurrent_items': case['limit']}}
    error = None
    failures = []
    with mock.patch.object(repair, 'ROOT', root), \
            mock.patch.object(repair.os, 'fork', fork), \
            mock.patch.object(repair.os, 'write', write), \
            mock.patch.object(repair, 'narrate', narrate), \
            mock.patch.object(repair, 'runner_disabled', runner_disabled), \
            mock.patch.object(repair, 'drain_item', drain_item), \
            mock.patch.object(repair, 'blocked', return_value=False), \
            mock.patch.object(repair, 'dispatch_paused', return_value=None):
        try:
            failures = repair.drain_items(config, {item: [] for item in order}, order)
        except Exception as exc:  # noqa: BLE001 - reported to the differential test
            error = type(exc).__name__
    return {
        'failures': failures,
        'forked': forks,
        'bytes': {p.name: p.read_bytes().decode() for p in sorted(log.iterdir())},
        'narration': narrated.read_text().splitlines() if narrated.exists() else [],
        'error': error,
    }


cases = json.load(sys.stdin)['cases']
json.dump({'results': [run_case(case) for case in cases]}, sys.stdout)
