import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runLadder } from '../../../src/kernel/governor.js';
import { correlationInvocation } from '../../../src/driver/correlationInvocation.js';
import type { OpInvocation } from '../../../src/driver/types.js';
import { finding, fixture } from './addressWorker.helpers.js';

describe('M5b3 forward governed invocation correlation (addressWorker)', () => {
  const correlationCases = [
    { name: 'run id only', correlation: { workId: 'run:j9:1', runId: 'run' } },
    {
      name: 'work and parent',
      correlation: { workId: 'run:j9:1', runId: 'run', parentWorkId: 'paseo:agent-1' },
    },
    {
      name: 'explicit role',
      correlation: { workId: 'run:j9:1', runId: 'run', role: 'review.address' },
    },
  ] as const;
  test.each(correlationCases)(
    'table: $name does not silently inherit the outer job',
    async ({ correlation }) => {
      const seen: OpInvocation[] = [];
      const f = await fixture(async (input) => {
        seen.push(input);
        if (input.outputSchema?.name === 'review.address.closure/v1')
          return { closed: true, reason: 'candidate fixed' };
        await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
        return { disposition: 'fixed', reason: 'fixed', evidence: [] };
      });
      try {
        const outcome = await runLadder(
          () => f.engine.fix(finding(), 1),
          { wallClockMs: 20000 },
          {
            op: 'review.address',
            jobKey: 'outer-job',
            attempt: 1,
            correlation: { ...correlation },
          },
        );
        expect(outcome.outcome).toBe('completed');
        expect(seen.length).toBeGreaterThan(0);
        // The invocation carries the SHARED HELPER's result: the preserved
        // 'fixer' default applies when the minted correlation lacks a role
        // (M5b0 semantics, not a new role here).
        const expected = correlationInvocation({ ...correlation }).correlation;
        for (const invocation of seen) {
          expect(invocation.correlation).toEqual(expected);
        }
      } finally {
        await f.cleanup();
      }
    },
  );

  // M5b3 nominal evidence: the worker forwards the governed job's minted
  // correlation verbatim onto every driver invocation it builds.
  test('M5b3 nominal evidence', async () => {
    const seen: OpInvocation[] = [];
    const f = await fixture(async (input) => {
      seen.push(input);
      if (input.outputSchema?.name === 'review.address.closure/v1')
        return { closed: true, reason: 'candidate fixed' };
      await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
      return { disposition: 'fixed', reason: 'fixed', evidence: [] };
    });
    try {
      const correlation = { workId: 'run:jn:1', runId: 'run', role: 'review.address' } as const;
      const outcome = await runLadder(
        () => f.engine.fix(finding(), 1),
        { wallClockMs: 20000 },
        { op: 'review.address', jobKey: 'jn', attempt: 1, correlation: { ...correlation } },
      );
      expect(outcome.outcome).toBe('completed');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.map((invocation) => invocation.correlation)).toEqual(
        seen.map(() => ({ ...correlation })),
      );
    } finally {
      await f.cleanup();
    }
  });

  // M5b3 missing evidence: no governed context — no correlation is
  // invented; the un-governed worker behaves exactly as before.
  test('M5b3 missing evidence', async () => {
    const seen: OpInvocation[] = [];
    const f = await fixture(async (input) => {
      seen.push(input);
      if (input.outputSchema?.name === 'review.address.closure/v1')
        return { closed: true, reason: 'candidate fixed' };
      await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
      return { disposition: 'fixed', reason: 'fixed', evidence: [] };
    });
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.reason).toContain('fixed');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.map((invocation) => invocation.correlation)).toEqual(seen.map(() => undefined));
    } finally {
      await f.cleanup();
    }
  });

  // M5b3 failure evidence: a governed dispatch whose correlation carries a
  // role must NOT have that role replaced or defaulted — the helper
  // forwards the identity verbatim (the 'fixer' fallback stays the M5b0
  // fixReviewItem default, never a new role here).
  test('M5b3 failure evidence', async () => {
    const seen: OpInvocation[] = [];
    const f = await fixture(async (input) => {
      seen.push(input);
      if (input.outputSchema?.name === 'review.address.closure/v1')
        return { closed: true, reason: 'candidate fixed' };
      await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
      return { disposition: 'fixed', reason: 'fixed', evidence: [] };
    });
    try {
      const correlation = { workId: 'run:jf:1', runId: 'run', role: 'reviewer' } as const;
      const outcome = await runLadder(
        () => f.engine.fix(finding(), 1),
        { wallClockMs: 20000 },
        { op: 'review.address', jobKey: 'jf', attempt: 1, correlation: { ...correlation } },
      );
      expect(outcome.outcome).toBe('completed');
      expect(seen.length).toBeGreaterThan(0);
      for (const invocation of seen)
        expect(invocation.correlation).toEqual({ ...correlation, role: 'reviewer' });
    } finally {
      await f.cleanup();
    }
  });
});

describe('M5b3 feedback invocation correlation', () => {
  // The feedback leg (related-check confirm after a real candidate edit)
  // goes through the SAME invoke() site: the forwarded correlation rides
  // every invocation kind, not just the first edit dispatch.
  test('the feedback invocation carries the forwarded correlation', async () => {
    const seen: Array<{ kind: string; correlation?: unknown }> = [];
    const f = await fixture(async (input) => {
      const kind = input.prompt.startsWith('related-check feedback')
        ? 'feedback'
        : input.outputSchema?.name === 'review.address.closure/v1'
          ? 'closure'
          : 'edit';
      seen.push({ kind, correlation: input.correlation });
      if (input.outputSchema?.name === 'review.address.closure/v1')
        return { closed: true, reason: 'candidate fixed' };
      if (kind === 'edit') await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
      return { disposition: 'fixed', reason: 'fixed', evidence: [] };
    });
    try {
      const correlation = { workId: 'run:jfb:1', runId: 'run', role: 'review.address' } as const;
      const expected = correlationInvocation({ ...correlation }).correlation;
      const outcome = await runLadder(
        () => f.engine.fix(finding(), 1),
        { wallClockMs: 20000 },
        { op: 'review.address', jobKey: 'jfb', attempt: 1, correlation: { ...correlation } },
      );
      expect(outcome.outcome).toBe('completed');
      // The real worker path ran edit AND feedback through invoke().
      expect(seen.map((row) => row.kind)).toContain('feedback');
      for (const row of seen) expect(row.correlation).toEqual(expected);
    } finally {
      await f.cleanup();
    }
  });
});
