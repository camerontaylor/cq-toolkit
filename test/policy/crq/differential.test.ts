import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { startsLastHour, TickScheduleError } from '../../../src/policy/crq/tickSchedule.js';
import { nextSlot, parseUsage, UsageSlotsError } from '../../../src/policy/crq/usageSlots.js';
import { UtcInstant } from '../../../src/policy/crq/utc.js';
import { pythonAvailable, runOracle, type OracleOutcome } from '../../helpers/pythonOracle.js';

/**
 * Differential layer: the real Python function (apps/crq-python, python3
 * subprocess, pure functions only) and the TS port run on the same committed
 * fixtures (test/fixtures/differential, regenerate with generate_fixtures.py)
 * and must agree exactly. Skipped when python3 cannot import the crq modules.
 */
const fixture = (name: string): Record<string, unknown>[] =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/differential/${name}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>[];

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

/** The TS result in the oracle's wire form: ints beyond 2**53 cannot survive a number. */
function ts(fn: () => unknown): Outcome {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (error instanceof UsageSlotsError || error instanceof TickScheduleError) {
      return { ok: false, error: 'pythonError' in error ? String(error.pythonError) : 'Error' };
    }
    return { ok: false, error: 'Error' };
  }
}

function disagreements(name: string, run: (c: Case) => unknown) {
  const cases = fixture(name);
  const py: OracleOutcome[] = runOracle(name, cases);
  const out: Disagreement[] = [];
  cases.forEach((c, index) => {
    const mine = ts(() => run(c));
    const theirs = py[index] as OracleOutcome;
    // An error must agree on "errored"; when the TS error names the Python
    // exception type, that must match too ('Error' means TS does not say).
    const same =
      mine.ok && theirs.ok
        ? JSON.stringify(mine.value) === JSON.stringify(theirs.value)
        : !mine.ok && !theirs.ok && (mine.error === 'Error' || mine.error === theirs.error);
    if (!same) out.push({ index, python: theirs, ts: mine, case: c });
  });
  return { total: cases.length, out };
}

type Case = Record<string, unknown>;
type Disagreement = { index: number; python: OracleOutcome; ts: Outcome; case: Case };

/**
 * Real divergences the differential run found, each named by a predicate over
 * the case. The test requires every disagreement to be explained by one of
 * these AND every class to still occur, so a fix to the TS port (or a new,
 * unexplained divergence) fails loudly instead of being silently absorbed.
 */
const KNOWN: Record<string, Record<string, (d: Disagreement) => boolean>> = {
  parse_usage: {
    // Python ints are exact; the TS VendorUsage carries a JS number.
    'integers beyond 2**53 lose precision': (d) => JSON.stringify(d.python).includes('"int:'),
  },
};

function check(name: string, run: (c: Case) => unknown) {
  const { total, out } = disagreements(name, run);
  const classes = KNOWN[name] ?? {};
  const unexplained = out.filter((d) => !Object.values(classes).some((match) => match(d)));
  const pinned = Object.entries(classes).map(([label, match]) => [
    label,
    out.filter((d) => match(d)).length,
  ]);
  return { total, unexplained, pinned, disagreeing: out.length };
}

const python = pythonAvailable();

describe.skipIf(!python)('differential: Python oracle vs TS port', () => {
  it('parse_usage: only the documented divergence', () => {
    const r = check('parse_usage', (c) => parseUsage(c.stream as string));
    expect(r.total).toBeGreaterThan(300);
    expect(r.unexplained).toEqual([]);
    expect(r.pinned.every(([, n]) => (n as number) > 0)).toBe(true);
    expect(r.total - r.disagreeing).toBeGreaterThan(250);
  });

  it('next_slot: agrees exactly', () => {
    const r = check('next_slot', (c) => {
      const at = new UtcInstant(BigInt(c.at as number));
      const starts = (c.starts as (number | null)[]).map((s) =>
        s === null ? null : new UtcInstant(BigInt(s)),
      );
      const result = nextSlot(starts, at, c.usage as never);
      return result === null ? null : Number(result.epochMicros);
    });
    expect(r.total).toBeGreaterThan(400);
    expect(r.unexplained).toEqual([]);
    expect(r.disagreeing).toBe(0);
  });

  it('starts_last_hour agrees exactly', () => {
    const r = check('starts_last_hour', (c) =>
      startsLastHour({ starts: c.starts } as never, BigInt(c.now as number)),
    );
    expect(r.total).toBeGreaterThan(300);
    expect(r.unexplained).toEqual([]);
    expect(r.disagreeing).toBe(0);
  });
});
