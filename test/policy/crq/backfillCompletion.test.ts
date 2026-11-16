import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adaptedTerminalScope,
  completionEvent,
  submittedScope,
  type BackfillRepo,
  type BackfillStore,
} from '../../../src/policy/crq/backfillCompletion.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { pythonAvailable, runOracle, type OracleOutcome } from '../../helpers/pythonOracle.js';

/**
 * The real `submitted_scope`, `adapted_terminal_scope` and `completion_event`
 * (python3 oracle, with fake repo and store seams) and the TS port run on the
 * same committed fixtures (test/fixtures/differential, regenerate with
 * generate_fixtures.py) and must give the same value or Python exception class.
 */
const SAFE = 2n ** 53n;

const fixtureText = (name: string): string =>
  readFileSync(new URL(`../../fixtures/differential/${name}.json`, import.meta.url), 'utf8');

function wire(value: JsonValue | readonly JsonValue[]): unknown {
  if (value instanceof JsonObject) return { $: value.entries.map(([k, v]) => [k, wire(v)]) };
  if (Array.isArray(value)) return value.map((v) => wire(v as JsonValue));
  if (value instanceof JsonNumber) {
    if (value.kind === 'float') return value.float;
    const n = value.integer as bigint;
    return n > SAFE || n < -SAFE ? `int:${n}` : Number(n);
  }
  return value;
}

function mine(run: () => unknown): OracleOutcome {
  try {
    return { ok: true, value: JSON.parse(JSON.stringify(run())) };
  } catch (error) {
    const named = (error as { pythonError?: unknown }).pythonError;
    return { ok: false, error: typeof named === 'string' ? named : `TS:${String(error)}` };
  }
}

type Explain = (c: JsonObject, python: OracleOutcome, ts: OracleOutcome) => boolean;

function compare(name: string, run: (c: JsonObject) => unknown, explain?: Explain) {
  const text = fixtureText(name);
  const cases = parseJsonValue(text) as JsonObject[];
  const theirs = runOracle(name, text);
  const bad: unknown[] = [];
  let ok = 0;
  let explained = 0;
  const errors = new Set<string>();
  cases.forEach((c, index) => {
    const m = mine(() => run(c));
    const p = theirs[index] as OracleOutcome;
    if (p.ok) ok += 1;
    else errors.add(p.error);
    if (JSON.stringify(m) === JSON.stringify(p)) return;
    if (explain?.(c, p, m)) explained += 1;
    else bad.push({ index, python: p, ts: m });
  });
  return { total: cases.length, ok, errors, bad: bad.slice(0, 5), explained };
}

/** The fake store: same `{sha256, location}` reference as the Python oracle's. */
const store: BackfillStore = {
  put(bytes) {
    const id = createHash('sha256').update(bytes).digest('hex');
    return new JsonObject([
      ['sha256', id],
      ['location', `/store/sha256/${id}`],
    ]);
  },
};

function table(value: JsonValue | undefined): Map<string, { blob: string }> {
  const out = new Map<string, { blob: string }>();
  for (const [name, blob] of (value as JsonObject).entries) out.set(name, { blob: blob as string });
  return out;
}

function fakeRepo(spec: JsonObject, calls: JsonObject[] = []): BackfillRepo {
  const field = (key: string) => spec.get(key) as JsonValue;
  return {
    entries: (rev) =>
      table(rev === field('head') ? field('head_entries') : field('target_entries')),
    changedIntervals: () => {
      const out = new Map<string, Set<number>>();
      for (const [name, lines] of (field('changed') as JsonObject).entries) {
        out.set(name, new Set((lines as JsonNumber[]).map((n) => Number(n.integer))));
      }
      return out;
    },
    changedPaths: () => field('paths') as string[],
    retain: (target, revs) => {
      // Python's retain sorts set(commits): a null or int among strings is a TypeError.
      if (revs.some((rev) => typeof rev !== 'string'))
        throw Object.assign(new Error('unorderable commits'), { pythonError: 'TypeError' });
      const ref = target.put(Buffer.from(`bundle:${[...new Set(revs)].sort().join(' ')}`));
      return new JsonObject([...(ref as JsonObject).entries, ['kind', 'git-bundle']]);
    },
    verifyReview: (event) => {
      calls.push(event);
    },
  };
}

/**
 * Documented divergence, inherited from the merged `ledgerScope`/`ledgerIntervals`
 * (see backfillVendorOutput.test.ts): Python never type-checks a scope row's
 * `blob` and unpacks intervals with `for start, end in rows`, so a non-string
 * blob or a malformed pair raises TypeError/ValueError there; TS refuses all of
 * these with IntegrityError. Stricter is safe: it cannot match a git blob id.
 */
const strictScopeRows: Explain = (c, python, ts) => {
  if (ts.ok || ts.error !== 'IntegrityError') return false;
  if (python.ok || !['TypeError', 'ValueError'].includes(python.error)) return false;
  const rows = ((c.get('item') as JsonObject).get('scope') ?? []) as JsonObject[];
  return rows.some((row) => {
    const intervals = row.get('intervals');
    return (
      typeof row.get('blob') !== 'string' ||
      !Array.isArray(intervals) ||
      intervals.some((pair) => !Array.isArray(pair) || pair.length !== 2)
    );
  });
};

const bytes = (c: JsonObject) => Buffer.from(c.get('raw_b64') as string, 'base64');
const sub = (c: JsonObject, key: string) => c.get(key) as JsonObject;

describe.skipIf(!pythonAvailable())('backfill completion: differential against Python', () => {
  it('submitted_scope matches Python', () => {
    const r = compare('submitted_scope', (c) =>
      wire(
        submittedScope(fakeRepo(sub(c, 'repo')), c.get('base') as string, c.get('head') as string),
      ),
    );
    expect(r.bad).toEqual([]);
    expect(r.total).toBeGreaterThan(200);
    expect(r.ok).toBe(r.total);
  });

  it('adapted_terminal_scope matches Python on value and exception class', () => {
    const r = compare('adapted_terminal_scope', (c) =>
      wire(
        adaptedTerminalScope(
          fakeRepo(sub(c, 'repo')),
          bytes(c),
          sub(c, 'item'),
          sub(c, 'meta'),
          sub(c, 'proof'),
        ),
      ),
    );
    expect(r.bad).toEqual([]);
    expect(r.total).toBeGreaterThan(400);
    expect(r.ok).toBeGreaterThan(150);
    for (const kind of ['IntegrityError', 'KeyError']) expect(r.errors).toContain(kind);
  });

  it('completion_event matches Python on value and exception class', () => {
    const r = compare(
      'completion_event',
      (c) =>
        wire(
          completionEvent(
            fakeRepo(sub(c, 'repo')),
            store,
            sub(c, 'item'),
            bytes(c),
            c.get('exit_code') as JsonValue,
            sub(c, 'meta'),
            c.get('ended_at') as string,
            c.get('submission') as JsonObject | null,
          ),
        ),
      strictScopeRows,
    );
    expect(r.bad).toEqual([]);
    expect(r.explained).toBeGreaterThan(0);
    expect(r.total).toBeGreaterThan(450);
    expect(r.ok).toBeGreaterThan(100);
    expect(r.errors).toContain('IntegrityError');
  });
});

describe('backfill completion', () => {
  const cases = parseJsonValue(
    readFileSync(
      new URL('../../fixtures/differential/completion_event.json', import.meta.url),
      'utf8',
    ),
  ) as JsonObject[];
  const first = cases.find(
    (c) => !c.has('submission') || c.get('submission') === null,
  ) as JsonObject;

  const run = (c: JsonObject, calls: JsonObject[] = [], writes: string[] = []) =>
    completionEvent(
      fakeRepo(sub(c, 'repo'), calls),
      {
        put: (data) => {
          writes.push(Buffer.from(data).toString('utf8').slice(0, 7));
          return store.put(data);
        },
      },
      sub(c, 'item'),
      bytes(c),
      c.get('exit_code') as JsonValue,
      sub(c, 'meta'),
      c.get('ended_at') as string,
      c.get('submission') as JsonObject | null,
    );

  it('verifies the finished review exactly once and stores raw, meta, then the bundle', () => {
    const ok = cases.find((c) => {
      try {
        run(c);
        return c.get('submission') === null;
      } catch {
        return false;
      }
    }) as JsonObject;
    const calls: JsonObject[] = [];
    const writes: string[] = [];
    const event = run(ok, calls, writes);
    expect(calls).toEqual([event]);
    expect(writes[0]).not.toBe('bundle:');
    expect(writes.indexOf('bundle:')).toBeGreaterThan(1);
    expect(event.get('event_type')).toBe('review');
  });

  it('refuses a head the terminal evidence does not name', () => {
    const bad = new JsonObject(
      sub(first, 'item').entries.map(([k, v]) => [k, k === 'head' ? 'f'.repeat(40) : v]),
    );
    const c = new JsonObject(first.entries.map(([k, v]) => [k, k === 'item' ? bad : v]));
    expect(() => run(c)).toThrow();
  });

  it('submittedScope orders paths by code point and drops empty or absent rows', () => {
    const repo = fakeRepo(
      parseJsonValue(
        JSON.stringify({
          head: 'h',
          head_entries: { b: 'bb', a: 'aa', '😀': 'ee' },
          target_entries: {},
          changed: { b: [3, 1, 2], '😀': [5], a: [], gone: [1] },
        }),
      ) as JsonObject,
    );
    expect(wire(submittedScope(repo, 'base', 'h') as unknown as JsonValue)).toEqual([
      {
        $: [
          ['path', 'b'],
          ['blob', 'bb'],
          ['intervals', [[1, 3]]],
        ],
      },
      {
        $: [
          ['path', '😀'],
          ['blob', 'ee'],
          ['intervals', [[5, 5]]],
        ],
      },
    ]);
  });

  it('adaptedTerminalScope refuses an unknown reviewer format', () => {
    const c = parseJsonValue(
      readFileSync(
        new URL('../../fixtures/differential/adapted_terminal_scope.json', import.meta.url),
        'utf8',
      ),
    ) as JsonObject[];
    const results = c.map((x) => {
      try {
        return adaptedTerminalScope(
          fakeRepo(sub(x, 'repo')),
          bytes(x),
          sub(x, 'item'),
          sub(x, 'meta'),
          sub(x, 'proof'),
        );
      } catch (error) {
        return error;
      }
    });
    expect(results.some((r) => Array.isArray(r))).toBe(true);
    expect(results.some((r) => r instanceof Error)).toBe(true);
  });

  it('defaults a missing finding severity to info but refuses an explicit null', () => {
    const plain = cases.filter((c) => c.get('submission') === null);
    const withFinding = (c: JsonObject, extra: object) => {
      const lines = bytes(c).toString('utf8').trimEnd().split('\n');
      const last = lines.pop() as string;
      const raw = [
        ...lines,
        JSON.stringify({ type: 'finding', id: 'f1', title: 't', comment: 'c', ...extra }),
        last,
      ];
      return new JsonObject(
        c.entries.map(([k, v]) => [
          k,
          k === 'raw_b64' ? Buffer.from(`${raw.join('\n')}\n`).toString('base64') : v,
        ]),
      );
    };
    const severities = (c: JsonObject) =>
      (run(c).get('payload') as JsonObject).get('findings') as JsonObject[];
    let seen = 0;
    for (const c of plain) {
      let missing: JsonObject[];
      try {
        missing = severities(withFinding(c, {}));
      } catch {
        continue;
      }
      expect(missing.at(-1)?.get('severity')).toBe('info');
      expect(() => severities(withFinding(c, { severity: null }))).toThrow(
        'event does not match one schema variant',
      );
      seen += 1;
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('adaptedTerminalScope names an unknown reviewer version even without a format', () => {
    const c = parseJsonValue(
      readFileSync(
        new URL('../../fixtures/differential/adapted_terminal_scope.json', import.meta.url),
        'utf8',
      ),
    ) as JsonObject[];
    const x = c[0] as JsonObject;
    const proof = new JsonObject([['cli_version', '9.9.9']]);
    expect(() =>
      adaptedTerminalScope(
        fakeRepo(sub(x, 'repo')),
        bytes(x),
        sub(x, 'item'),
        sub(x, 'meta'),
        proof,
      ),
    ).toThrow('unknown reviewer version/output format');
  });
});
