"""Differential oracle: run pure functions of apps/crq-python on JSON cases.

Test tooling only. Usage: python3 -I pythonOracle.py <apps/crq-python dir>
Reads {"op": str, "cases": [...]} on stdin and writes one result per case:
{"ok": true, "value": ...} or {"ok": false, "error": "<ExceptionType>"}.
No network, forge or filesystem access: only pure functions are exposed.
"""
import datetime as dt
import json
import sys

sys.path.insert(0, sys.argv[1])
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


OPS = {'parse_usage': parse_usage, 'next_slot': next_slot, 'starts_last_hour': starts_last_hour}


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
