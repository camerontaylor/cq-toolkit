import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findingIntervals,
  REVIEWER_FORMATS,
  terminalScope,
  vendorEvents,
} from '../../../src/policy/crq/backfillVendorOutput.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { pythonAvailable, runOracle, type OracleOutcome } from '../../helpers/pythonOracle.js';

/**
 * The real `backfill_history` functions (python3 oracle) and the TS port run on
 * the same committed fixtures (test/fixtures/differential, regenerate with
 * generate_fixtures.py) and must give the same value, or the same Python
 * exception class. Fixtures are parsed losslessly so 2**70 stays an int.
 */
const SAFE = 2n ** 53n;

function fixtureText(name: string): string {
  return readFileSync(new URL(`../../fixtures/differential/${name}.json`, import.meta.url), 'utf8');
}

/** The oracle's wire form: dicts keep key order, big ints become 'int:N'. */
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

/**
 * Documented divergence, inherited from the merged `ledgerScope`/`ledgerIntervals`:
 * Python's `review_ledger.scope` never type-checks `blob` (an int or null is
 * accepted, a list or dict raises TypeError as unhashable) and iterates and
 * unpacks intervals with `for start, end in rows` (a non-list container raises
 * TypeError, a length-1 or length-3 pair raises ValueError). TS refuses all of these with IntegrityError. Stricter is safe:
 * a non-string blob can never match a git blob id downstream.
 */
const strictScopeRows: Explain = (c, python, ts) => {
  if (ts.ok || ts.error !== 'IntegrityError') return false;
  if (python.ok ? false : !['TypeError', 'ValueError'].includes(python.error)) return false;
  const lines = Buffer.from(c.get('raw_b64') as string, 'base64')
    .toString('utf8')
    .trim()
    .split('\n');
  const done = JSON.parse(lines[lines.length - 1] as string) as { reviewedFiles?: unknown };
  if (!Array.isArray(done.reviewedFiles)) return false;
  return done.reviewedFiles.some((row: { blob?: unknown; intervals?: unknown }) => {
    if (typeof row.blob !== 'string') return true;
    return (
      !Array.isArray(row.intervals) ||
      row.intervals.some((pair) => !Array.isArray(pair) || pair.length !== 2)
    );
  });
};

const bytes = (c: JsonObject) => Buffer.from(c.get('raw_b64') as string, 'base64');

describe.skipIf(!pythonAvailable())('backfill vendor output: differential against Python', () => {
  it('vendor_events matches Python on value and exception class', () => {
    const r = compare('vendor_events', (c) => wire(vendorEvents(bytes(c))));
    expect(r.bad).toEqual([]);
    expect(r.total).toBeGreaterThan(400);
    expect(r.ok).toBeGreaterThan(200);
    for (const kind of ['IntegrityError', 'JSONDecodeError', 'UnicodeDecodeError'])
      expect(r.errors).toContain(kind);
  });

  it('finding_intervals matches Python', () => {
    const r = compare('finding_intervals', (c) =>
      findingIntervals(c.get('value') as JsonObject).map((pair) => [...pair]),
    );
    expect(r.bad).toEqual([]);
    expect(r.total).toBeGreaterThan(400);
  });

  it('terminal_scope matches Python on value and exception class', () => {
    const r = compare(
      'terminal_scope',
      (c) => wire(terminalScope(bytes(c), c.get('head') as string)),
      strictScopeRows,
    );
    expect(r.bad).toEqual([]);
    // The documented divergence must still occur, or this pin is stale.
    expect(r.explained).toBeGreaterThan(0);
    expect(r.total).toBeGreaterThan(400);
    expect(r.ok).toBeGreaterThan(150);
    expect(r.errors).toContain('IntegrityError');
  });
});

describe('backfill vendor output', () => {
  const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
  const empty = new JsonObject([]);

  it('pins the known reviewer formats', () => {
    expect([...REVIEWER_FORMATS]).toEqual([
      ['0.8.2', 'coderabbit-agent-0.8.2'],
      ['0.9.2', 'coderabbit-agent-0.9.2'],
    ]);
  });

  it('skips blank lines and refuses a duplicate key or a non-object line', () => {
    expect(vendorEvents(Buffer.from(' \n\t\r\n'))).toEqual([]);
    expect(() => vendorEvents(Buffer.from('{"a":1,"a":2}'))).toThrow('duplicate vendor JSON key');
    expect(() => vendorEvents(Buffer.from('[1]'))).toThrow('vendor event must be an object');
    expect(() => vendorEvents(Buffer.from('{"a":NaN}'))).toThrow('non-finite vendor number');
    expect(() => vendorEvents(Buffer.from('{"a":1e999}'))).toThrow('non-finite vendor number');
  });

  it('keeps a bad anchor from yielding a partial range', () => {
    const anchors = (text: string) => findingIntervals(parseJsonValue(text) as JsonObject);
    expect(anchors('{"startLine":3}')).toEqual([[3, 3]]);
    expect(anchors('{"startLine":5,"endLine":2}')).toEqual([[2, 5]]);
    expect(anchors('{"startLine":3,"endLine":0}')).toEqual([]);
    expect(anchors('{"intervals":[[1,2],[2,4]]}')).toEqual([[1, 4]]);
    expect(anchors('{"intervals":[[1,2],[4,3]]}')).toEqual([]);
    expect(anchors('{"intervals":[[true,2]]}')).toEqual([]);
    expect(findingIntervals(empty)).toEqual([]);
  });

  it('accepts only a terminal complete bound to the head', () => {
    const complete = {
      type: 'complete',
      status: 'review_completed',
      head: 'a'.repeat(40),
      reviewedFiles: [{ path: 'src/a.ts', blob: 'b'.repeat(40), intervals: [[1, 3]] }],
    };
    expect(terminalScope(line(complete), 'a'.repeat(40))).toHaveLength(1);
    expect(() => terminalScope(line(complete), 'c'.repeat(40))).toThrow('wrong/unknown');
    expect(() =>
      terminalScope(Buffer.concat([line(complete), line({ type: 'x' })]), 'a'.repeat(40)),
    ).toThrow('terminal non-skipped completion absent');
    expect(() =>
      terminalScope(Buffer.concat([line({ type: 'error' }), line(complete)]), 'a'.repeat(40)),
    ).toThrow('error or missing terminal evidence');
    const pathOnly = { ...complete, reviewedFiles: [{ path: 'src/a.ts', blob: 'b'.repeat(40) }] };
    expect(() => terminalScope(line(pathOnly), 'a'.repeat(40))).toThrow('path-only receipts');
  });
});
