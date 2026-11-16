"""Differential oracle: run pure functions of apps/crq-python on JSON cases.

Test tooling only. Usage: python3 -I pythonOracle.py <apps/crq-python dir>
Reads {"op": str, "cases": [...]} on stdin and writes one result per case:
{"ok": true, "value": ...} or {"ok": false, "error": "<ExceptionType>"}.
No network, forge or filesystem access: only pure functions are exposed.
"""
import base64
import datetime as dt
import hashlib
import json
import sys

sys.path.insert(0, sys.argv[1])
import backfill_history  # noqa: E402
import backfill_runtime  # noqa: E402
import crq  # noqa: E402
import usage_slots  # noqa: E402

EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
MICRO = dt.timedelta(microseconds=1)
SAFE = 2 ** 53


def inst(micros):
    return None if micros is None else EPOCH + dt.timedelta(microseconds=micros)


def wire(value):
    """JSON-safe form; ints beyond 2**53 become exact decimal strings 'int:N'."""
    if isinstance(value, bool) or value is None or isinstance(value, (str, float)):
        return value
    if isinstance(value, int):
        return value if abs(value) <= SAFE else 'int:%d' % value
    if isinstance(value, dt.datetime):
        return (value - EPOCH) // MICRO
    if isinstance(value, list):
        return [wire(v) for v in value]
    if isinstance(value, dict):
        return {k: wire(v) for k, v in value.items()}
    raise TypeError(type(value).__name__)


def parse_usage(case):
    return usage_slots.parse_usage(case['stream'])


def next_slot(case):
    return usage_slots.next_slot([inst(s) for s in case['starts']], inst(case['at']), case['usage'])


def starts_last_hour(case):
    crq.now = lambda: inst(case['now'])
    return crq.starts_last_hour({'starts': case['starts']})


def ordered(value):
    """Dicts as {"$": [[key, value], ...]} so key order survives JSON object semantics."""
    if isinstance(value, dict):
        return {'$': [[k, ordered(v)] for k, v in value.items()]}
    if isinstance(value, list):
        return [ordered(v) for v in value]
    return value


def vendor_events(case):
    return ordered(backfill_history.vendor_events(base64.b64decode(case['raw_b64'])))


def finding_intervals(case):
    return backfill_history.finding_intervals(case['value'])


def terminal_scope(case):
    return ordered(backfill_history.terminal_scope(base64.b64decode(case['raw_b64']), case['head']))


class FakeStore:
    """Content store seam: the reference is the real `{"sha256", "location"}` shape."""

    def put(self, data):
        ident = hashlib.sha256(data).hexdigest()
        return {'sha256': ident, 'location': '/store/sha256/' + ident}


class FakeRepo:
    """Repository seam built from a case's `repo` table (no git, no filesystem)."""

    def __init__(self, spec):
        self.spec = spec

    def entries(self, rev):
        table = self.spec['head_entries'] if rev == self.spec.get('head') else self.spec['target_entries']
        return {name: {'blob': blob} for name, blob in table.items()}

    def changed_intervals(self, base, head):
        return {name: set(lines) for name, lines in self.spec['changed'].items()}

    def git(self, *args):
        assert args[:2] == ('diff', '--name-only')
        return b''.join(name.encode('utf-8') + b'\0' for name in self.spec['paths'])

    def retain(self, store, commits):
        return {**store.put(b'bundle:' + ' '.join(sorted(set(commits))).encode()), 'kind': 'git-bundle'}

    def verify_review(self, value):
        return {}


def submitted_scope(case):
    return ordered(backfill_history.submitted_scope(FakeRepo(case['repo']), case['base'], case['head']))


def adapted_terminal_scope(case):
    return ordered(backfill_history.adapted_terminal_scope(
        FakeRepo(case['repo']), base64.b64decode(case['raw_b64']), case['item'], case['meta'], case['proof']))


def completion_event(case):
    return ordered(backfill_runtime.completion_event(
        FakeRepo(case['repo']), FakeStore(), case['item'], base64.b64decode(case['raw_b64']),
        case['exit_code'], case['meta'], case['ended_at'], case['submission']))


OPS = {'submitted_scope': submitted_scope, 'adapted_terminal_scope': adapted_terminal_scope, 'completion_event': completion_event, 'vendor_events': vendor_events, 'finding_intervals': finding_intervals, 'terminal_scope': terminal_scope, 'parse_usage': parse_usage, 'next_slot': next_slot, 'starts_last_hour': starts_last_hour}


def main():
    request = json.loads(sys.stdin.read())
    fn = OPS[request['op']]
    out = []
    for case in request['cases']:
        try:
            out.append({'ok': True, 'value': wire(fn(case))})
        except Exception as error:  # noqa: BLE001 - the type name is the datum
            out.append({'ok': False, 'error': type(error).__name__})
    sys.stdout.write(json.dumps(out, ensure_ascii=True))


main()
