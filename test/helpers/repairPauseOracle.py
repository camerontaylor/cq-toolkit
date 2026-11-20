"""Differential oracle for the repair pause/cooldown/blackout seams: run apps/crq-python's
`crq_repair.py` `paused`, `rate_limit_pause`, `blocked`, `provider_cooldowns` and
`dispatch_paused` against an isolated temporary state directory.

Test tooling only. Usage: python3 -I repairPauseOracle.py <apps/crq-python dir>
Reads {"cases": [case]} on stdin and writes {"results": [result]}. A case is
{"op": "paused" | "rate_limit_pause" | "blocked" | "cooldowns" | "dispatch_paused",
 "files": {"<path under state/>": text | {"hex": "<bytes>"} | {"dir": true}},
 "mtimes": {"<path>": epoch seconds}, "clock": ["<ISO UTC>", ...], "env": {name: value},
 "args": {...}}. The clock steps once per read (the last value repeats); `utc()` and every
`datetime.now` inside `crq_repair.py` draw from it, so the order of reads is part of the contract.
A result is {"ok": value, "files": {path: text}} or {"error": "<exception class>"}.
No network, git, provider call or child process is used; the lock is the isolated tmp state/tick.lock.
"""
import datetime as real_dt
import importlib.util
import json
import os
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
        if isinstance(content, dict):
            path.write_bytes(bytes.fromhex(content['hex']))
        else:
            path.write_text(content)
    for rel, seconds in case.get('mtimes', {}).items():
        os.utime(state / rel, (seconds, seconds))


def snapshot(state):
    out = {}
    for path in sorted(state.rglob('*')):
        if path.is_file() and path.name != 'tick.lock':
            out[str(path.relative_to(state))] = path.read_bytes().decode('latin-1')
    return out


def run(case):
    args = case.get('args', {})
    op = case['op']
    if op == 'paused':
        now = parse_clock(args['now']) if 'now' in args else None
        return repair.paused(now)
    if op == 'blocked':
        return repair.blocked(args['repair'], parse_clock(args['now']))
    if op == 'rate_limit_pause':
        return repair.rate_limit_pause(args['report'], args['job'])
    if op == 'cooldowns':
        return repair.provider_cooldowns()
    if op == 'dispatch_paused':
        return repair.dispatch_paused(args['config'])
    raise SystemExit('unknown op ' + op)


def main():
    results = []
    for case in json.load(sys.stdin)['cases']:
        with tempfile.TemporaryDirectory(prefix='repair-pause-oracle-') as tmp:
            state = Path(tmp) / 'state'
            state.mkdir()
            repair.ROOT = Path(tmp)
            lay_out(state, case)
            clock = Clock(case.get('clock', ['2026-11-21T00:00:00Z']))
            install(clock)
            saved = dict(os.environ)
            os.environ.clear()
            os.environ.update(case.get('env', {}))
            try:
                results.append({'ok': run(case), 'files': snapshot(state)})
            except SystemExit:
                raise
            except BaseException as exc:  # noqa: BLE001 - the class name is the contract
                results.append({'error': type(exc).__name__})
            finally:
                os.environ.clear()
                os.environ.update(saved)
    json.dump({'results': results}, sys.stdout)


main()
