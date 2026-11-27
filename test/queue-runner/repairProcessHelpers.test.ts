/**
 * Differential test for the pure `process()` helpers
 * (src/queue-runner/repairProcessHelpers.ts) against the PRODUCTION Python:
 * `failure_class_for_stop` (crq_repair.py:161-166), the inline `judge_required`
 * expression (crq_repair.py:670, extracted with `ast` by the emitter) and
 * `bounded.validate_revalidation` (crq_repair/bounded.py:34-61).
 *
 * Offline: replays apps/crq-python/fixtures/crq-process-helpers/cases.json.
 * The Python runs with `random.random` replaced by a counter and
 * `bounded.git` scripted; nothing real is read.
 */
import { describe, expect, it } from 'vitest';

import { JsonNumber } from '../../src/policy/crq/jsonValue.js';
import { PyError } from '../../src/queue-runner/pyErrors.js';
import {
  failureClassForStop,
  judgeRequired,
  validateRevalidation,
} from '../../src/queue-runner/repairProcessHelpers.js';
import { expectSameOutcome, loadFixture, type Recorded } from '../helpers/processHelpersOracle.js';

const fixture = loadFixture();

describe('process() helpers fixture', () => {
  it('has every section and the pinned default ref', () => {
    expect(fixture.schema).toBe('cq.crq-process-helpers-vector/v1');
    expect(fixture.default_ref).toBe('origin/main');
    for (const section of ['failure_class', 'judge_required', 'revalidation'] as const) {
      expect(fixture[section].length, section).toBeGreaterThan(10);
    }
  });
});

describe('failureClassForStop (crq_repair.py:161-166)', () => {
  for (const c of fixture.failure_class as Array<Recorded & { report: unknown }>) {
    it(c.name, () => {
      expectSameOutcome(() => failureClassForStop(c.report), c);
    });
  }
});

describe('judgeRequired (crq_repair.py:670)', () => {
  for (const c of fixture.judge_required as Array<
    Recorded & {
      result: unknown;
      job: unknown;
      repair: unknown;
      random: JsonNumber;
      draws: JsonNumber;
    }
  >) {
    it(c.name, () => {
      let draws = 0;
      const draw = Number(c.random.float ?? c.random.integer);
      expectSameOutcome(
        () =>
          judgeRequired({
            result: c.rung_result,
            job: c.job,
            repair: c.repair,
            random: () => {
              draws += 1;
              return draw;
            },
          }),
        c,
      );
      expect(draws, `${c.name}: random() draws`).toBe(Number(c.draws.integer));
    });
  }
});

describe('validateRevalidation (crq_repair/bounded.py:34-61)', () => {
  for (const c of fixture.revalidation as Array<
    Recorded & {
      old: unknown;
      source_sha: unknown;
      evidence: unknown;
      git: Record<string, string | { error: string }>;
      calls: string[];
    }
  >) {
    it(c.name, () => {
      const calls: string[] = [];
      const git = (...args: string[]): string => {
        const key = args.join(' ');
        calls.push(key);
        const value = c.git[key];
        if (value === undefined) throw new Error(`unscripted git call: ${key}`);
        if (typeof value !== 'string') {
          throw new PyError('RuntimeError', `git ${args[0]} failed: ${value.error}`);
        }
        return value;
      };
      expectSameOutcome(() => validateRevalidation(git, c.old, c.source_sha, c.evidence), c);
      expect(calls, `${c.name}: git reads`).toEqual(c.calls);
    });
  }
});
