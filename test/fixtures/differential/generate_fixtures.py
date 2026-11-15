"""Seeded generator for the committed differential fixtures (JSON only).

Regenerate: python3 test/fixtures/differential/generate_fixtures.py
Deterministic (random.Random(seed)); the committed files are what the tests read.
Follow with `pnpm fix test/fixtures/differential/*.json` (prettier layout).
"""
import base64
import json
import random
import sys
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


sys.path.insert(0, str(HERE.parents[2] / 'apps' / 'crq-python'))
import review_ledger  # noqa: E402

POOL = ['src/a.ts', 'src/b/c.ts', 'README.md', 'docs/x y.md', 'src/é.ts', 'z.txt', 'src/\U0001f600.ts']
SUBJ_BASE, TARGET = 'c' * 40, 'd' * 40


def ranges(lines):
    out = []
    for n in sorted(set(lines)):
        if out and out[-1][1] == n - 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return out


def hexid(rng, n=40):
    return ''.join(rng.choice('0123456789abcdef') for _ in range(n))


def submitted_rows(spec):
    return [{'path': n, 'blob': spec['head_entries'][n], 'intervals': ranges(lines)}
            for n, lines in sorted(spec['changed'].items()) if lines and n in spec['head_entries']]


def base_world(rng):
    """One coherent subject: repo tables, item, meta, requested scope."""
    names = rng.sample(POOL, rng.randint(1, 4))
    blobs = {n: hexid(rng) for n in names}
    requested = []
    changed = {}
    for n in names:
        lines = rng.sample(range(1, 60), rng.randint(1, 14))
        requested.append({'path': n, 'blob': blobs[n], 'intervals': ranges(lines)})
        extra = rng.sample(range(1, 80), rng.randint(0, 6))
        changed[n] = sorted(set(rng.sample(lines, rng.randint(0, len(lines))) + extra))
    if rng.random() < 0.3:
        changed['gone.txt'] = [1, 2]
    if rng.random() < 0.2:
        changed['no-lines.txt'] = []
    rng.shuffle(requested)
    spec = {'head': HEAD, 'head_entries': dict(blobs), 'target_entries': dict(blobs), 'changed': changed,
            'paths': list(changed)}
    if rng.random() < 0.3:
        spec['target_entries'][rng.choice(POOL)] = hexid(rng)
    item = {'subject_id': 'subject', 'job_id': 'subject:0', 'attempt_id': 'subject:0:1', 'base': SUBJ_BASE, 'head': HEAD,
            'head_tree': 'e' * 40, 'target': TARGET, 'target_tree': 'f' * 40, 'construction_policy_digest': 'b' * 64,
            'scope_digest': review_ledger.digest(requested),
            'paths': [{'path': r['path'], 'blob': r['blob'], 'mode': '100644', 'disposition': 'included',
                       'reason': 'verified', 'baseline': {}} for r in requested],
            'scope': requested}
    meta = {'run_id': 'run-%d' % rng.randint(0, 99), 'head': HEAD, 'base': SUBJ_BASE}
    return {'repo': spec, 'item': item, 'meta': meta}


def completion_finding(rng, world, i):
    names = list(world['repo']['target_entries'])
    event = {'type': 'finding', 'severity': rng.choice(['info', 'major', None, 3]),
             'title': rng.choice(['t%d' % i, '', None, 'café']), 'comment': rng.choice(['c', '', None, 'x\U0001f600'])}
    if rng.random() < 0.6:
        event['id'] = rng.choice([i, str(i), None, 0, 2 ** 70, 1.5, True, [1], ''])
    where = rng.choice(['fileName', 'path', 'both', 'none'])
    pick = lambda: rng.choice(names + ['missing.ts', '../x', '', 5, None, ['a'], '/abs'])
    if where in ('fileName', 'both'):
        event['fileName'] = pick()
    if where in ('path', 'both'):
        event['path'] = pick()
    for key in rng.sample(['startLine', 'endLine'], rng.randint(0, 2)):
        event[key] = rng.choice([1, 5, 40, 0, -3, 1_000_001, 2 ** 70, True, None, '7', 3.0])
    if rng.random() < 0.25:
        event['intervals'] = [[1, 2], [4, 4]]
    if rng.random() < 0.3:
        event.pop('comment')
        event['body'] = rng.choice(['b', '', None])
    if rng.random() < 0.3:
        event['extra'] = rng.choice([1.5, -0.0, 1e2, {'k': [1, 2.5, 'ué']}, 2 ** 70, None, 'x\U0001f600'])
    return event


def plain_events(rng, world, findings):
    item = world['item']
    files = []
    for row in rng.sample(item['scope'], rng.randint(1, len(item['scope']))):
        covered = [n for a, b in row['intervals'] for n in range(a, b + 1)]
        keep = rng.sample(covered, rng.randint(0, len(covered))) + rng.sample(range(1, 90), rng.randint(0, 4))
        files.append({'path': row['path'], 'blob': row['blob'], 'intervals': ranges(keep)})
    events = [{'type': 'review_context', 'baseCommit': SUBJ_BASE}]
    events += [completion_finding(rng, world, i) for i in range(findings)]
    events.append({'type': 'complete', 'status': 'review_completed', 'head': HEAD, 'outcome': 'completed',
                   'reviewedFiles': files})
    return events


def adapted_events(rng, world, findings):
    spec = world['repo']
    names = [r['path'] for r in submitted_rows(spec)] or ['none']
    listed = rng.sample(names, rng.randint(1, len(names)))
    events = [{'type': 'review_context', 'baseCommit': SUBJ_BASE}]
    events += [completion_finding(rng, world, i) for i in range(findings)]
    events.append({'type': 'complete', 'status': 'review_completed', 'outcome': 'completed', 'reviewedFiles': listed})
    return events


def proof_for(world):
    return {'cli_version': '0.9.2', 'format': 'coderabbit-agent-0.9.2', 'run_id': world['meta']['run_id'],
            'head': HEAD, 'base': SUBJ_BASE, 'attempt_id': world['item']['attempt_id'],
            'submitted_scope': submitted_rows(world['repo'])}


def finish(case, events):
    case['raw_b64'] = b64(b'\n'.join(jl(e) for e in events) + rng_nl(case))
    return case


def rng_nl(case):
    return b'\n'


def adapted_fault(rng, world, events, proof):
    """Inject one named fault into an adapted run; returns the stream's raw bytes override or None."""
    fault = rng.randint(0, 21)
    complete, context = events[-1], events[0]
    spec = world['repo']
    if fault == 0:
        proof['cli_version'] = rng.choice(['0.8.2', '9.9', None, 5, ''])
    elif fault == 1:
        proof['format'] = rng.choice(['coderabbit-agent-0.8.2', 'x', None])
    elif fault == 2:
        key = rng.choice(['run_id', 'head', 'base', 'attempt_id'])
        proof[key] = rng.choice(['nope', None, 5, [1]])
    elif fault == 3:
        proof.pop(rng.choice(['run_id', 'head', 'cli_version', 'submitted_scope']))
    elif fault == 4:
        world['meta'][rng.choice(['head', 'base'])] = rng.choice(['x' * 40, None])
    elif fault == 5:
        world['meta'].pop(rng.choice(['head', 'base', 'run_id']))
    elif fault == 6:
        rows = proof['submitted_scope']
        if rows:
            rng.choice([lambda: rows.pop(), lambda: rows.reverse(), lambda: rows[0].update(blob='0' * 40),
                        lambda: rows[0].update(intervals=[[1, 1]]), lambda: rows.append(dict(rows[0]))])()
        else:
            rows.append({'path': 'x', 'blob': 'y', 'intervals': []})
    elif fault == 7:
        events.insert(rng.randint(0, len(events) - 1), {'type': rng.choice(['error', 'action_required'])})
    elif fault == 8:
        complete['outcome'] = rng.choice(['skipped', None, 3])
    elif fault == 9:
        complete['status'] = rng.choice(['x', None])
    elif fault == 10:
        complete['type'] = rng.choice(['x', None])
    elif fault == 11:
        events.insert(1, dict(context))
    elif fault == 12:
        events.remove(context)
    elif fault == 13:
        context['baseCommit'] = rng.choice(['z' * 40, None, 5])
    elif fault == 14:
        complete['reviewedFiles'] = rng.choice([[], None, {}, 'a', 5, [None], [5], [['a']]])
    elif fault == 15:
        complete['reviewedFiles'] = complete['reviewedFiles'] + complete['reviewedFiles'][:1]
    elif fault == 16:
        complete['reviewedFiles'] = complete['reviewedFiles'] + ['unlisted.ts']
    elif fault == 17:
        spec['paths'] = [p for p in spec['paths'] if p not in complete['reviewedFiles']] or ['q']
    elif fault == 18:
        events.clear()
        events.append({'type': 'x'})
    elif fault == 19:
        spec['head_entries'].pop(rng.choice(list(spec['head_entries'])), None)
    elif fault == 20:
        proof['submitted_scope'] = rng.choice([None, 'x', [], {}])
    else:
        spec['changed'] = {n: [] for n in spec['changed']}


def submitted_scope_cases(rng):
    cases = []
    for _ in range(220):
        world = base_world(rng)
        spec = world['repo']
        if rng.random() < 0.3:
            spec['changed'][rng.choice(POOL)] = rng.sample(range(1, 50), rng.randint(0, 5))
        cases.append({'repo': spec, 'base': SUBJ_BASE, 'head': HEAD})
    return cases


def adapted_cases(rng):
    cases = []
    for _ in range(440):
        world = base_world(rng)
        events = adapted_events(rng, world, rng.randint(0, 2))
        proof = proof_for(world)
        if rng.random() >= 0.45:
            adapted_fault(rng, world, events, proof)
        case = {'repo': world['repo'], 'item': world['item'], 'meta': world['meta'], 'proof': proof}
        cases.append(finish(case, events))
    return cases


def completion_cases(rng):
    cases = []
    for _ in range(460):
        world = base_world(rng)
        adapted = rng.random() < 0.4
        events = (adapted_events if adapted else plain_events)(rng, world, rng.randint(0, 3))
        proof = proof_for(world) if adapted else None
        case = {'repo': world['repo'], 'item': world['item'], 'meta': world['meta'], 'exit_code': 0,
                'ended_at': '2026-11-15T00:00:00Z', 'submission': proof}
        if rng.random() >= 0.5:
            fault = rng.randint(0, 13)
            item, scope = world['item'], world['item']['scope']
            if fault == 0:
                case['exit_code'] = rng.choice([1, None, 'x', 2 ** 70, 0.0, False, [0]])
            elif fault == 1:
                case['ended_at'] = rng.choice(['bad', '', None, '2026-11-15', '2026-11-15T00:00:00.5Z'])
            elif fault == 2:
                item.pop(rng.choice(['subject_id', 'job_id', 'target', 'scope', 'paths', 'scope_digest', 'head_tree',
                                     'construction_policy_digest']))
            elif fault == 3:
                scope.append(dict(scope[0]))
            elif fault == 4:
                scope[0]['intervals'] = rng.choice([[[3, 1]], [[1, 2], [2, 3]], 'x', None, [[1]], [[1, 1_000_001]]])
            elif fault == 5:
                world['meta'].pop('run_id')
            elif fault == 6:
                world['meta']['extra'] = rng.choice([1.5, 2 ** 70, {'k': 1.0}, None, 'ué\U0001f600'])
            elif fault == 7:
                world['repo']['target_entries'] = {}
            elif fault == 8:
                item['target'] = rng.choice([5, None, 'g' * 40])
            elif fault == 9:
                item['paths'] = []
            elif fault == 10 and adapted:
                adapted_fault(rng, world, events, proof)
            elif fault == 11 and not adapted:
                events[-1]['head'] = rng.choice(['x' * 40, None])
            elif fault == 12:
                world['meta']['run_id'] = rng.choice([5, None, 'a:b', 'r' * 300, 'ué'])
            else:
                world['item']['scope'] = scope[::-1]
        cases.append(finish(case, events))
    return cases


def write(name, cases):
    (HERE / name).write_text(json.dumps(cases, indent=1, ensure_ascii=True) + '\n')


write('parse_usage.json', parse_usage_cases(random.Random(1)))
write('next_slot.json', next_slot_cases(random.Random(2)))
write('starts_last_hour.json', starts_cases(random.Random(3)))
write('vendor_events.json', vendor_events_cases(random.Random(5)))
write('finding_intervals.json', finding_interval_cases(random.Random(6)))
write('terminal_scope.json', terminal_scope_cases(random.Random(7)))
write('submitted_scope.json', submitted_scope_cases(random.Random(8)))
write('adapted_terminal_scope.json', adapted_cases(random.Random(9)))
write('completion_event.json', completion_cases(random.Random(10)))
