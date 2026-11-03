// runPlan journal serializability: BigInt, NaN, silently-lossy and
// value-less ok results are honest per-job failures that never poison the
// journal. Split from the pre-split test/kernel/runner.test.ts; the
// describe wrapper (and its tmp-dir hooks) is reproduced so every test's
// full title path stays byte-identical.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runPlan } from '../../src/kernel/runner.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { match } from '../helpers/matchers.js';

import type { OpResult, Plan } from '../../src/kernel/types.js';
import { entry, jobFinishes, jobInputSchema, makeFake, viewWith } from './runner.helpers.js';
describe('runPlan — execution semantics', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a non-serializable op result is an honest per-job failure (run and journal survive)', async () => {
    // OpResultSchema's value is z.unknown(), so a BigInt result passes the
    // shape check but cannot survive JSON.stringify at the journal append —
    // it must come back as THIS job's failure, not kill the run at the emit.
    const { op } = makeFake();
    const registry = viewWith(
      entry('bigint', jobInputSchema, async () => ({ status: 'ok', value: 1n })),
      entry('fake', jobInputSchema, op),
    );
    const plan: Plan = {
      id: 'plan-bigint',
      jobs: [
        { id: 'j1', op: 'bigint', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false, journalDir: dir }, // exercises the append path
      registry,
    );
    expect(report.jobs.find((row) => row.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/non-serializable/),
    });
    expect(report.jobs.find((row) => row.jobId === 'j2')?.result).toEqual({
      status: 'ok',
      value: 'j2',
    });
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 1,
      failed: 1,
      'budget-exhausted': 0,
    });
    // The journaled failure line is valid: the file still reads cleanly.
    const events = await openRunLog(dir).read(report.runId);
    expect(jobFinishes(events).find((event) => event.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
    });
  });

  test('a NaN-carrying op result is non-serializable too (NaN would journal as null)', async () => {
    // JSON.stringify silently rewrites NaN/Infinity to null — the journal
    // would then disagree with the value the run produced, and replay would
    // consume the falsified form. The serializability probe rejects
    // non-finite numbers, so this is an honest per-job failure.
    const { op } = makeFake();
    const registry = viewWith(
      entry('nan', jobInputSchema, async () => ({ status: 'ok', value: { score: NaN } })),
      entry('fake', jobInputSchema, op),
    );
    const plan: Plan = {
      id: 'plan-nan',
      jobs: [
        { id: 'j1', op: 'nan', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false, journalDir: dir },
      registry,
    );
    expect(report.jobs.find((row) => row.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/non-serializable.*non-finite/s),
    });
    expect(report.counts.done).toBe(1); // j2 unaffected — the run continues
    const events = await openRunLog(dir).read(report.runId);
    expect(jobFinishes(events).find((event) => event.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
    });
  });

  test('silently-lossy op results are rejected: Map, Date, function member, undefined array hole, symbol key, hidden toJSON, hidden member', async () => {
    // Each of these stringifies WITHOUT throwing but the journal line would
    // disagree with the value the op returned (Map → {}, Date → ISO string,
    // function members vanish, undefined array elements → null).
    const { op } = makeFake();
    const registry = viewWith(
      entry('map-op', jobInputSchema, async () => ({ status: 'ok', value: new Map([['a', 1]]) })),
      entry('date-op', jobInputSchema, async () => ({ status: 'ok', value: new Date(0) })),
      entry('fn-op', jobInputSchema, async () => ({
        status: 'ok',
        value: { compute: () => 1 },
      })),
      entry('hole-op', jobInputSchema, async () => {
        const holey: unknown[] = [1];
        holey[2] = 3; // index 1 left undefined — stringify would null it
        return { status: 'ok', value: holey } as { status: 'ok'; value: unknown };
      }),
      entry('symbol-op', jobInputSchema, async () => ({
        status: 'ok',
        value: { x: 1, [Symbol('hidden')]: 2 } as unknown,
      })),
      entry('tojson-op', jobInputSchema, async () => {
        const hooked = { x: 1 };
        Object.defineProperty(hooked, 'toJSON', {
          value: () => ({ x: 2 }),
          enumerable: false,
        });
        return { status: 'ok', value: hooked } as { status: 'ok'; value: unknown };
      }),
      entry('hidden-op', jobInputSchema, async () => {
        const withHidden = { x: 1 };
        Object.defineProperty(withHidden, 'secret', { value: 3, enumerable: false });
        return { status: 'ok', value: withHidden } as { status: 'ok'; value: unknown };
      }),
      entry('arr-tojson-op', jobInputSchema, async () => {
        const hooked = [1];
        Object.defineProperty(hooked, 'toJSON', { value: () => ({ x: 2 }), enumerable: false });
        return { status: 'ok', value: hooked } as { status: 'ok'; value: unknown };
      }),
      entry('arr-extra-op', jobInputSchema, async () => {
        const withExtra = [1];
        (withExtra as unknown as { extra: string }).extra = 'gone';
        return { status: 'ok', value: withExtra } as { status: 'ok'; value: unknown };
      }),
      entry('arr-hugeindex-op', jobInputSchema, async () => {
        // "4294967295" is NOT an array index (indices end at 2^32-2): it
        // is a plain property length never counts and stringify drops
        // (PR #114 review, CodeRabbit Major + Codex P2).
        const withHuge = [1];
        (withHuge as unknown as Record<string, string>)['4294967295'] = 'dropped';
        return { status: 'ok', value: withHuge } as { status: 'ok'; value: unknown };
      }),
      entry('fake', jobInputSchema, op),
    );
    const plan: Plan = {
      id: 'plan-lossy',
      jobs: [
        { id: 'm', op: 'map-op', input: { jobId: 'm' } },
        { id: 'd', op: 'date-op', input: { jobId: 'd' } },
        { id: 'f', op: 'fn-op', input: { jobId: 'f' } },
        { id: 'h', op: 'hole-op', input: { jobId: 'h' } },
        { id: 's', op: 'symbol-op', input: { jobId: 's' } },
        { id: 't', op: 'tojson-op', input: { jobId: 't' } },
        { id: 'n', op: 'hidden-op', input: { jobId: 'n' } },
        { id: 'at', op: 'arr-tojson-op', input: { jobId: 'at' } },
        { id: 'ax', op: 'arr-extra-op', input: { jobId: 'ax' } },
        { id: 'ah', op: 'arr-hugeindex-op', input: { jobId: 'ah' } },
        { id: 'ok1', op: 'fake', input: { jobId: 'ok1' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 5, stopOnError: false, journalDir: dir },
      registry,
    );
    const failureOf = (id: string): string => {
      const result = report.jobs.find((row) => row.jobId === id)?.result;
      if (result?.status !== 'failed') throw new Error(`Expected failed job ${id}`);
      return result.error;
    };
    expect(failureOf('m')).toMatch(/non-serializable.*non-plain object of type 'Map'/);
    expect(failureOf('d')).toMatch(/non-serializable.*non-plain object of type 'Date'/);
    expect(failureOf('f')).toMatch(/non-serializable.*non-JSON value of type 'function'/);
    expect(failureOf('h')).toMatch(/non-serializable.*undefined array element/);
    // The hidden-key family (PR #31 review, Codex P1 + review-debt #76):
    // stringify DROPS the symbol key, INVOKES the hidden toJSON (the
    // journal would reconstruct x:2 while the walk accepted x:1), and
    // never sees the non-enumerable member.
    expect(failureOf('s')).toMatch(/non-serializable.*symbol-keyed own member/s);
    expect(failureOf('t')).toMatch(/non-serializable.*non-enumerable own 'toJSON'/s);
    expect(failureOf('n')).toMatch(/non-serializable.*non-enumerable own member 'secret'/s);
    expect(failureOf('at')).toMatch(/non-serializable.*own 'toJSON' on an array/s);
    expect(failureOf('ax')).toMatch(/non-serializable.*non-index own member 'extra' on an array/s);
    expect(failureOf('ah')).toMatch(
      /non-serializable.*non-index own member '4294967295' on an array/s,
    );
    expect(report.counts.failed).toBe(10);
    expect(report.counts.done).toBe(1); // the run continues
  });

  test("an ok result whose value is undefined is rejected — the journal requires ok's value", async () => {
    // The frozen ok variant carries a REQUIRED value: a journaled
    // {status:'ok'} without one fails JournalEventSchema on read. Undefined
    // is therefore lossy here (not absent data) and must be an honest
    // per-job failure — never a journal line that cannot be replayed.
    const { op } = makeFake();
    const registry = viewWith(
      entry(
        'absent',
        jobInputSchema,
        async () =>
          ({
            status: 'ok',
            value: undefined,
          }) as OpResult<unknown>,
      ),
      entry('fake', jobInputSchema, op),
    );
    const plan: Plan = {
      id: 'plan-absent-value',
      jobs: [
        { id: 'j1', op: 'absent', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false, journalDir: dir },
      registry,
    );
    expect(report.jobs.find((row) => row.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/non-serializable.*without a 'value'/),
    });
    expect(report.counts.done).toBe(1); // j2 unaffected — the run continues
    // Every journaled line still reads back cleanly.
    const events = await openRunLog(dir).read(report.runId);
    expect(jobFinishes(events).find((event) => event.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
    });
  });
});
