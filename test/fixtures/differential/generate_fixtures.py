"""Seeded generator for the committed differential fixtures (JSON only).

Regenerate: python3 test/fixtures/differential/generate_fixtures.py
Deterministic (random.Random(seed)); the committed files are what the tests read.
Follow with `pnpm fix test/fixtures/differential/*.json` (prettier layout).
"""
import json
import random
from pathlib import Path

HERE = Path(__file__).parent
HOUR = 3_600_000_000
BASE = 1_794_000_000_000_000  # a fixed instant in November 2026, epoch microseconds


def parse_usage_cases(rng):
    values = [0, 1, 3, 10, -1, '3', 3.0, 2.5, True, False, None, 2 ** 70, 2 ** 53 + 1, [], {}]
    states = [None, 'available', 'exhausted', '', 5, False]
    cases = []

    def event(i):
        inc = {}
        if rng.random() < 0.85:
            inc['remaining'] = rng.choice(values)
        if rng.random() < 0.6:
            inc['limit'] = rng.choice(values)
        for key in ('rollingWindowMs', 'fullCapacityInMs'):
            if rng.random() < 0.5:
                inc[key] = rng.choice(values)
        if rng.random() < 0.5:
            inc['state'] = rng.choice(states)
        doc = {'includedReviews': inc if rng.random() < 0.93 else rng.choice([None, 4, 'x', []])}
        return json.dumps(doc)

    junk = ['', 'not json', '{', '[1,2]', 'null', '"s"', '7', '{"includedReviews": NaN}',
            '{"includedReviews": {"remaining": NaN}}',
            '{"includedReviews": {"remaining": 1, "remaining": 2}}',
            '{"includedReviews": {"remaining": 1e0}}',
            '{"includedReviews": {"remaining": -0}}',
            '{"includedReviews": {"remaining": 1, "limit": 1}}']
    seps = ['\n', '\r\n', '\r', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\x85', ' ', ' ']
    for _ in range(300):
        n = rng.randint(0, 4)
        lines = [event(i) if rng.random() < 0.7 else rng.choice(junk) for i in range(n)]
        stream = ''
        for line in lines:
            stream += line + rng.choice(seps)
        if rng.random() < 0.3:
            stream = stream.rstrip('\n')
        cases.append({'stream': stream})
    for line in junk:
        cases.append({'stream': line})
    for line in ['{"includedReviews": {"remaining": 0, "limit": 0}}',
                 '{"includedReviews": {"remaining": 0, "limit": 0}}\n{"includedReviews": {"remaining": 2}}']:
        cases.append({'stream': line})
    return cases


def next_slot_cases(rng):
    cases = []
    at = BASE
    wins = [None, 0, 1000, 60000, 3600000, 7200000, 1.5, 0.0004, 1e12]
    fulls = [None, 0, 5000, 600000, 3.7]
    for _ in range(400):
        usage = rng.choice([None, {}, {'remaining': rng.randint(0, 10)}, {
            'remaining': rng.randint(0, 10), 'limit': rng.randint(0, 12)}])
        if usage:
            if rng.random() < 0.7:
                usage['rollingWindowMs'] = rng.choice(wins)
            if rng.random() < 0.7:
                usage['fullCapacityInMs'] = rng.choice(fulls)
        window = (usage or {}).get('rollingWindowMs') or 3600000
        span = int(min(window, 7200000) * 1000) if isinstance(window, (int, float)) else HOUR
        starts = []
        for _ in range(rng.randint(0, 5)):
            roll = rng.random()
            if roll < 0.15:
                starts.append(at - int(window * 1000)) if window < 1e11 else starts.append(at)
            elif roll < 0.25:
                starts.append(at)
            elif roll < 0.3:
                starts.append(at + rng.randint(1, 1000))
            else:
                starts.append(at - rng.randint(0, 2 * span + 1))
        cases.append({'starts': starts, 'at': at, 'usage': usage})
    for extra in [
        {'starts': [None], 'at': at, 'usage': None},
        {'starts': [], 'at': at, 'usage': {'remaining': 0, 'limit': None}},
        {'starts': [at], 'at': at, 'usage': {'limit': None, 'remaining': 1}},
        {'starts': [at], 'at': at, 'usage': {'remaining': None}},
        {'starts': [at], 'at': at, 'usage': {'remaining': 0, 'fullCapacityInMs': '5'}},
        {'starts': [at], 'at': at, 'usage': {'rollingWindowMs': '5'}},
        {'starts': [at], 'at': at, 'usage': {'rollingWindowMs': True}},
        {'starts': [at], 'at': at, 'usage': {'remaining': True, 'limit': 3}},
        {'starts': [at], 'at': at, 'usage': {'remaining': 0, 'fullCapacityInMs': 2.0000005}},
        {'starts': [at], 'at': at, 'usage': {'rollingWindowMs': 0.0005}},
        {'starts': [at], 'at': at, 'usage': {'rollingWindowMs': 0.0015}},
        {'starts': [at], 'at': at, 'usage': {'rollingWindowMs': 0.0025}},
    ]:
        cases.append(extra)
    return cases


def starts_cases(rng):
    now = BASE
    iso_fmt = '%Y-%m-%dT%H:%M:%S'
    import datetime as dt
    epoch = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)

    def iso(micros, style):
        d = epoch + dt.timedelta(microseconds=micros)
        base = d.strftime(iso_fmt)
        return {0: base + 'Z', 1: base + '.000Z', 2: base + '.%06dZ' % d.microsecond,
                3: base, 4: base + 'ZZ', 5: base + '+00:00'}[style]

    cases = []
    for _ in range(300):
        starts = []
        for _ in range(rng.randint(0, 6)):
            offset = rng.choice([0, 1, -1, HOUR, HOUR - 1_000_000, HOUR + 1_000_000,
                                 rng.randint(-2 * HOUR, 2 * HOUR)])
            micros = now - offset
            if rng.random() < 0.7:
                micros -= micros % 1_000_000
            starts.append(iso(micros, rng.randint(0, 5)))
        if rng.random() < 0.15:
            starts.insert(rng.randint(0, len(starts)), rng.choice(
                ['', None, 'garbage', 5, '2026-13-45T99:99:99Z', '2026-2-3T4:5:6Z',
                 '0000-01-01T00:00:00Z', '9999-12-31T23:59:59Z', ' 2026-11-06T00:00:00Z']))
        cases.append({'starts': starts, 'now': now})
    cases.append({'starts': [], 'now': now})
    return cases


def write(name, cases):
    (HERE / name).write_text(json.dumps(cases, indent=1, ensure_ascii=True) + '\n')


write('parse_usage.json', parse_usage_cases(random.Random(1)))
write('next_slot.json', next_slot_cases(random.Random(2)))
write('starts_last_hour.json', starts_cases(random.Random(3)))
