"""Differential oracle for the repair-drain effect bindings of `fileRepairUnit`: run
apps/crq-python's `crq_repair.py` seams against an isolated temporary ROOT.

Test tooling only; Python 3.14 is the pinned oracle (the production minor).
Usage: python3.14 -I repairUnitOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is
{"op": "worker_limit" | "dispatch_paused" | "blocked" | "fetch_clone" | "inbox_order" |
 "inbox_item" | "read_queue" | "read_backlog" | "pending" | "unreadable_result" |
 "mark_stale", "files": {"<path under state/>": text | {"dir": true}},
 "mtimes": {"<path>": epoch seconds}, "clone": "repo" | "none", "clock": ["<ISO UTC>"],
 "env": {name: value}, "holdLock": bool (fetch_clone: another description holds tick.lock),
 "args": {...}}.
`inbox_item`, `read_queue` and `read_backlog` are the inline reads of `crq_repair.drain` and
`hold_backfill_groups`, copied here statement for statement because Python has no function
for them. `inbox_item` reports a non-string or unreadable item as null (the drain skips both);
`read_queue`/`read_backlog` report an OSError/ValueError as {"unreadable": true}.
A result is {"ok": value, "files": {path: text}} or {"error": "<exception class>"}.
No network: the only git is a local bare origin created inside the temporary ROOT.
"""
import datetime as real_dt
import fcntl
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path

sys.path.insert(0, sys.argv[1])
SPEC = importlib.util.spec_from_file_location('crq_repair_script', Path(sys.argv[1]) / 'crq_repair.py')
repair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(repair)


def parse_clock(text):
    return real_dt.datetime.fromisoformat(text.replace('Z', '+00:00'))


class Clock:
    def __init__(self, values):
        self.values = [parse_clock(v) for v in values]
        self.reads = 0

    def now(self):
        value = self.values[min(self.reads, len(self.values) - 1)]
        self.reads += 1
        return value


def install(clock):
    class FakeDatetime(real_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return clock.now()

    repair.dt = types.SimpleNamespace(
        datetime=FakeDatetime, timedelta=real_dt.timedelta, timezone=real_dt.timezone)
    repair.utc = lambda: clock.now().strftime('%Y-%m-%dT%H:%M:%SZ')


def lay_out(state, case):
    for rel, content in case.get('files', {}).items():
        path = state / rel
        if isinstance(content, dict) and content.get('dir'):
            path.mkdir(parents=True, exist_ok=True)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    for rel, seconds in case.get('mtimes', {}).items():
        os.utime(state / rel, (seconds, seconds))


def snapshot(state):
    out = {}
    for path in sorted(state.rglob('*')):
        if path.is_file() and path.name != 'tick.lock':
            out[str(path.relative_to(state))] = path.read_bytes().decode('latin-1')
    return out


def make_clone(tmp, kind):
    clone = Path(tmp) / 'clone'
    if kind == 'none':
        return str(clone)
    origin = Path(tmp) / 'origin.git'
    git = ['git', '-c', 'init.defaultBranch=main']
    subprocess.run(git + ['init', '--bare', '--quiet', str(origin)], check=True)
    subprocess.run(git + ['clone', '--quiet', str(origin), str(clone)], check=True,
                   stderr=subprocess.DEVNULL)
    return str(clone)


def run(case, tmp):
    args = case.get('args', {})
    op = case['op']
    state = Path(tmp) / 'state'
    if op == 'worker_limit':
        return repair.worker_limit(args['config'])
    if op == 'dispatch_paused':
        return repair.dispatch_paused(args['config'])
    if op == 'blocked':
        return repair.blocked(args['repair'], parse_clock(args['now']))
    if op == 'fetch_clone':
        config = dict(args['config'])
        config['clone'] = make_clone(tmp, case.get('clone', 'repo'))
        if case.get('holdLock'):
            # A second open file description conflicts with fetch_clone's flock, as the tick's would.
            with (state / 'tick.lock').open('w') as held:
                fcntl.flock(held, fcntl.LOCK_EX)
                return repair.fetch_clone(config)
        return repair.fetch_clone(config)
    if op == 'inbox_order':
        return repair.drain_order(repair.ROOT)
    if op == 'inbox_item':
        try:
            job = json.loads((state / 'repair/inbox' / (args['job'] + '.json')).read_text())
            item = job.get('item')
            return item if isinstance(item, str) else None  # drain groups only str items
        except (OSError, ValueError, AttributeError):
            return None
    if op == 'read_queue':
        queue_path = state / 'queue.json'
        try:
            return json.loads(queue_path.read_text()) if queue_path.exists() else {'items': []}
        except (OSError, ValueError):
            return {'unreadable': True}
    if op == 'read_backlog':
        try:
            return json.loads((state / 'repair/fix-pr-backlog.json').read_text())
        except (OSError, ValueError):
            return {'unreadable': True}
    if op == 'pending':
        return repair.pending(args['job'])
    if op == 'unreadable_result':
        return repair.unreadable_result(args['job'])
    if op == 'mark_stale':
        return repair.mark_stale(args['jobObject'], args['reason'])
    raise SystemExit('unknown op ' + op)


def main():
    results = []
    for case in json.load(sys.stdin)['cases']:
        with tempfile.TemporaryDirectory(prefix='repair-unit-oracle-') as tmp:
            state = Path(tmp) / 'state'
            state.mkdir()
            repair.ROOT = Path(tmp)
            lay_out(state, case)
            install(Clock(case.get('clock', ['2026-11-21T00:00:00Z'])))
            saved = dict(os.environ)
            os.environ.clear()
            os.environ.update(case.get('env', {}))
            try:
                results.append({'ok': run(case, tmp), 'files': snapshot(state)})
            except SystemExit:
                raise
            except BaseException as exc:  # noqa: BLE001 - the class name is the contract
                results.append({'error': type(exc).__name__})
            finally:
                os.environ.clear()
                os.environ.update(saved)
    json.dump({'results': results}, sys.stdout)


main()
