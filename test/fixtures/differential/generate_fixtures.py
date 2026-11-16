"""Seeded generator for the committed differential fixtures (JSON only).

Regenerate: python3 test/fixtures/differential/generate_fixtures.py
Deterministic (random.Random(seed)); the committed files are what the tests read.
Follow with `pnpm fix test/fixtures/differential/*.json` (prettier layout).
"""
import base64
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


HEAD = 'a' * 40
BLOB = 'b' * 40


def b64(raw):
    return base64.b64encode(raw).decode()


def jl(value):
    return json.dumps(value, ensure_ascii=rng_ascii[0]).encode()


rng_ascii = [True]


def reviewed_file(rng, i):
    name = rng.choice(['src/a.ts', 'src/b/c.ts', 'README.md', 'docs/x y.md', 'src/\u00e9.ts']) + str(i)
    intervals = rng.choice([[[1, 3]], [[1, 3], [5, 9]], [[1, 1]], [], [[2, 400]]])
    return {'path': name, 'blob': BLOB[:39] + str(i % 10), 'intervals': intervals}


def valid_complete(rng):
    return {'type': 'complete', 'status': 'review_completed', 'head': HEAD, 'outcome': 'completed',
            'reviewedFiles': [reviewed_file(rng, i) for i in range(rng.randint(1, 4))]}


def finding_event(rng, i):
    event = {'type': 'finding', 'id': rng.choice([i, str(i), None]), 'severity': rng.choice(['info', 'major', 'minor']),
             'fileName': 'src/a.ts', 'title': 't%d' % i, 'comment': 'c'}
    for key in rng.sample(['startLine', 'endLine'], rng.randint(0, 2)):
        event[key] = rng.choice([1, 5, 40, 1_000_000, 0, -3, 1_000_001, 2 ** 70, True, None, '7', 3.0])
    if rng.random() < 0.3:
        event['intervals'] = [[1, 2], [4, 4]]
    return event


def vendor_stream(rng):
    events = [{'type': 'review_context', 'baseCommit': 'c' * 40}]
    events += [finding_event(rng, i) for i in range(rng.randint(0, 3))]
    events.append(valid_complete(rng))
    return events


def mutate_stream(rng, events):
    """Return stream bytes with one structural fault injected."""
    lines = [jl(e) for e in events]
    kind = rng.randint(0, 17)
    pos = rng.randint(0, len(lines))
    faults = {
        0: b'{"type":"a","type":"b"}',
        1: b'{"type":"a","nested":{"k":1,"k":2}}',
        2: b'{"type":"a","v":NaN}',
        3: b'{"type":"a","v":Infinity}',
        4: b'{"type":"a","v":-Infinity}',
        5: b'{"type":"a","v":1e999}',
        6: b'{"type":"a","v":1.5,"w":1E2,"x":-0.0,"y":123456789012345678901234567890}',
        7: rng.choice([b'[1]', b'"x"', b'3', b'null', b'true']),
        8: rng.choice([b'{"a":', b'{', b'not json', b'{"a":1,}', b'{"a" 1}']),
        9: b'\xef\xbb\xbf' + jl(events[0]),
        10: b'{"type":"a","v":"\xff\xfe"}',
        11: '{"type":"u"}'.encode('utf-16'),
        12: b'{"type":"a","v":"\\ud800"}',
        13: b'{"type":"a","v":"\\ud83d\\ude00 \\u00e9"}',
        14: rng.choice([b'  ', b'\t', b'\r', b'\x0b', b'\x0c', b' \x0b\x0c ', b'\xa0']),
        15: '{"type":"a","v":"caf\u00e9 \U0001f600"}'.encode('utf-8'),
        16: b'{"type":"a","v":"\xed\xa0\x80"}',
        17: '{"type":"u"}'.encode('utf-16-be'),
    }
    lines.insert(pos, faults[kind])
    sep = rng.choice([b'\n', b'\n', b'\r\n', b'\n\n'])
    raw = sep.join(lines)
    if rng.random() < 0.5:
        raw += b'\n'
    return raw


def vendor_events_cases(rng):
    cases = []
    for _ in range(420):
        events = vendor_stream(rng)
        if rng.random() < 0.5:
            raw = b'\n'.join(jl(e) for e in events) + rng.choice([b'', b'\n', b'\n  \n'])
        else:
            raw = mutate_stream(rng, events)
        cases.append({'raw_b64': b64(raw)})
    cases += [{'raw_b64': b64(b'')}, {'raw_b64': b64(b'\n\n')}, {'raw_b64': b64(b'{}')}]
    return cases


def finding_interval_cases(rng):
    anchors = [1, 2, 7, 1_000_000, 1_000_001, 0, -1, 2 ** 70, True, False, None, '3', 3.0, [], {}]
    cases = []
    for _ in range(420):
        value = {'type': 'finding'}
        mode = rng.random()
        if mode < 0.45:
            for key in rng.sample(['startLine', 'endLine'], rng.randint(0, 2)):
                value[key] = rng.choice(anchors[:8] if rng.random() < 0.6 else anchors)
        else:
            def pair():
                kind = rng.random()
                if kind < 0.6:
                    a = rng.choice([1, 2, 5, 10, 999_999])
                    return [a, a + rng.choice([0, 0, 1, 5, 100])]
                return rng.choice([[1], [1, 2, 3], 'ab', [True, 2], [1.0, 2], [[1, 2]], [5, 2], [0, 3],
                                   [1, 1_000_001], [1, 2 ** 70], None, {'a': 1, 'b': 2}, [], 7, [None, 1]])
            if rng.random() < 0.8:
                value['intervals'] = [pair() for _ in range(rng.randint(0, 4))]
            else:
                value['intervals'] = rng.choice(['', 'ab', 'abc', {}, {'a': 1, 'b': 2}, 0, 5, True, False,
                                                 None, 1.5, [[]], [[1, 2], 'xy']])
            if rng.random() < 0.3:
                value['startLine'] = rng.choice(anchors)
        cases.append({'value': value})
    cases.append({'value': {}})
    cases.append({'value': {'intervals': [[1, 1_000_000]]}})
    return cases


def terminal_scope_cases(rng):
    cases = []
    for _ in range(420):
        events = [{'type': 'review_context', 'baseCommit': 'c' * 40}]
        events += [finding_event(rng, i) for i in range(rng.randint(0, 2))]
        complete = valid_complete(rng)
        head = HEAD
        roll = rng.random()
        if roll >= 0.5:
            fault = rng.randint(0, 17)
            files = complete['reviewedFiles']
            if fault == 0:
                complete['head'] = rng.choice(['d' * 40, None, 5, ''])
            elif fault == 1:
                head = 'e' * 40
            elif fault == 2:
                complete['status'] = rng.choice(['skipped', 'review_failed', None, 3])
            elif fault == 3:
                complete['type'] = rng.choice(['done', 'finding', None])
            elif fault == 4:
                complete['reviewedFiles'] = rng.choice([[], None, {}, 'x', 5, ['a.ts'], [None], [[]]])
            elif fault == 5:
                del files[0]['intervals']
            elif fault == 6:
                files[0]['extra'] = 1
            elif fault == 7:
                files[0]['path'] = rng.choice(['../x', '/abs/x', '', 'a\\b', 'a//b', '.', 'a/./b', 'a\u0000b', 5, None, 'a/..'])
            elif fault == 8:
                files.append(dict(files[0]))
            elif fault == 9:
                files[0]['intervals'] = rng.choice([[[0, 3]], [[3, 1]], [[1.0, 2]], 'x', None, [[1]], [[1, 2], [2, 3]],
                                                    [[True, 2]], [[1, 2 ** 70]], [[1, 1_000_001]], {}, [[1, 2], [1, 2]]])
            elif fault == 10:
                files[0]['blob'] = rng.choice([None, 5, '', ['x'], {'a': 1}, 1.5])
            elif fault == 11:
                events.insert(rng.randint(0, len(events)), {'type': rng.choice(['error', 'action_required'])})
            elif fault == 12:
                events.append({'type': 'finding', 'id': 1})
            elif fault == 13:
                events = []
                complete = None
            elif fault == 14:
                files[0]['intervals'] = [[1, 3.5]]
            elif fault == 15:
                files[0]['blob'] = 'x' * 3
                files.append({'path': files[0]['path'], 'blob': 'y', 'intervals': []})
            elif fault == 16:
                files[0]['path'] = 'src/\u00e9\U0001f600.ts'
            else:
                complete['head'] = 5
        if complete is not None:
            events.append(complete)
        sep = rng.choice([b'\n', b'\n', b'\r\n'])
        raw = sep.join(jl(e) for e in events) + rng.choice([b'', b'\n'])
        if roll >= 0.93:
            raw = mutate_stream(rng, events or [{'type': 'x'}])
        cases.append({'raw_b64': b64(raw), 'head': head})
    return cases


def write(name, cases):
    (HERE / name).write_text(json.dumps(cases, indent=1, ensure_ascii=True) + '\n')


write('parse_usage.json', parse_usage_cases(random.Random(1)))
write('next_slot.json', next_slot_cases(random.Random(2)))
write('starts_last_hour.json', starts_cases(random.Random(3)))
write('vendor_events.json', vendor_events_cases(random.Random(5)))
write('finding_intervals.json', finding_interval_cases(random.Random(6)))
write('terminal_scope.json', terminal_scope_cases(random.Random(7)))
