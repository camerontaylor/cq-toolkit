import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import * as gitMutex from '../../../src/shared/gitMutex.js';
import { finding, fixture } from './addressWorker.helpers.js';

describe('review.address candidate isolation', () => {
  test('a provider error can reach rescue with paid attempt cost retained', async () => {
    const f = await fixture(
      async (input) => {
        if (input.outputSchema?.name === 'review.address.closure/v1')
          return { closed: true, reason: 'rescued candidate closed' };
        if (!input.prompt.startsWith('related-check feedback'))
          await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
        return { disposition: 'fixed', reason: 'edited candidate', evidence: [] };
      },
      '',
      {
        firstStopReason: 'error',
        rescueBase: 1,
        costUSD: 0.01,
      },
    );
    try {
      const fixed = await f.engine.fix(finding(), 1);
      expect(fixed.finding.status, fixed.reason).toBe('fixed');
      expect(f.attempts.map((a) => a.tier)).toEqual(['worker', 'rescue', 'rescue', 'reviewer']);
      expect(f.attempts.every((a) => a.costUSD === 0.01)).toBe(true);
      expect(f.attempts[0]?.failedAttempt?.sha).toBeTruthy();
      expect(f.attempts[1]?.reason).toMatch(/worker stopped: error/);
      expect(f.repo.git('show', '--format=', '--name-only', fixed.commit!).trim()).toBe('src/a.ts');
    } finally {
      await f.cleanup();
    }
  });

  test('uncommitted sibling bytes cannot make the assigned related check or closure pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let edits = 0,
      maximum = 0,
      running = 0;
    const f = await fixture(async (input) => {
      if (input.outputSchema?.name === 'review.address.closure/v1')
        return { closed: true, reason: 'candidate closure' };
      if (!input.prompt.startsWith('related-check feedback')) {
        running++;
        maximum = Math.max(maximum, running);
        const file = input.prompt.includes('Address only src/b.ts') ? 'src/b.ts' : 'src/a.ts';
        await writeFile(join(input.workspace!.path, file), 'GOOD\n');
        edits++;
        if (edits === 2) release();
        await gate;
        running--;
      }
      return { disposition: 'fixed', reason: 'claim', evidence: [] };
    }, `const fs = require('node:fs'); const a = fs.readFileSync('src/a.ts','utf8'); const b = fs.readFileSync('src/b.ts','utf8'); if(a.includes('GOOD') && !b.includes('GOOD')) { console.log('src/a.ts(1,1): error TS9999: sibling required'); process.exitCode=1; }`);
    try {
      const [a, b] = await Promise.all([
        f.engine.fix(finding(), 1),
        f.engine.fix(finding('src/b.ts'), 1),
      ]);
      expect(maximum).toBe(2);
      // If b commits first, a may pass over that verified parent. It may
      // never pass while b exists only in the shared worker tree.
      if (a.commit) expect(f.repo.git('show', `${a.commit}^:src/b.ts`)).toContain('GOOD');
      else expect(a.finding.status).toBe('deferred');
      expect(b.finding.status, b.reason).toBe('fixed');
      expect(f.repo.git('show', '--format=', '--name-only', b.commit!).trim()).toBe('src/b.ts');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['related', 'closure'] as const)(
    'a %s gate cannot borrow a held sibling edit',
    async (gateKind) => {
      let siblingEdited!: () => void, releaseSibling!: () => void;
      const edited = new Promise<void>((resolve) => {
        siblingEdited = resolve;
      });
      const held = new Promise<void>((resolve) => {
        releaseSibling = resolve;
      });
      let candidateEntries = 0;
      const f = await fixture(
        async (input) => {
          if (input.outputSchema?.name === 'review.address.closure/v1') {
            const b = await readFile(join(input.workspace!.path, 'src/b.ts'), 'utf8');
            return {
              closed: gateKind !== 'closure' || b.includes('GOOD'),
              reason: 'requires verified sibling bytes',
            };
          }
          if (!input.prompt.startsWith('related-check feedback')) {
            const isB = input.prompt.includes('Address only src/b.ts');
            await writeFile(join(input.workspace!.path, isB ? 'src/b.ts' : 'src/a.ts'), 'GOOD\n');
            if (isB) {
              siblingEdited();
              await held;
            } else await edited;
          }
          return { disposition: 'fixed', reason: 'claim', evidence: [] };
        },
        gateKind === 'related'
          ? `const fs=require('node:fs'); if(fs.readFileSync('src/a.ts','utf8').includes('GOOD') && !fs.readFileSync('src/b.ts','utf8').includes('GOOD')) {console.log('src/a.ts(1,1): error TS9999: requires sibling');process.exitCode=1;}`
          : 'process.exitCode=0;',
        {
          gitHook: async (args, run) => {
            const result = await run(args);
            if (
              args.includes('worktree') &&
              args.includes('add') &&
              args.some((arg) => /\/candidate-[^/]+$/.test(arg))
            ) {
              candidateEntries++;
              // A owns acceptance FIFO before B completes its edit invocation.
              // B acceptance queues behind A's immutable candidate gates.
              releaseSibling();
            }
            return result;
          },
        },
      );
      const b = f.engine.fix(finding('src/b.ts'), 1);
      try {
        const a = await f.engine.fix(finding(), 1);
        expect(a.commit).toBeUndefined();
        expect(a.finding.status).toBe('deferred');
        expect(candidateEntries).toBeGreaterThanOrEqual(1);
        expect(a.reason).toMatch(
          gateKind === 'closure' ? /assigned finding remains open/ : /candidate validation refused/,
        );
        expect(f.repo.git('show', 'HEAD:src/a.ts')).toBe('BAD\n');
        expect(await readFile(join(f.repo.root, 'src/b.ts'), 'utf8')).toBe('GOOD\n');
        releaseSibling();
        const fixedB = await b;
        expect(fixedB.finding.status, fixedB.reason).toBe('fixed');
        expect(f.repo.git('show', '--format=', '--name-only', fixedB.commit!).trim()).toBe(
          'src/b.ts',
        );
      } finally {
        releaseSibling();
        await b;
        await f.cleanup();
      }
    },
  );
  test('unit regression bypasses the remaining worker retry and reserves rescue', async () => {
    const f = await fixture(
      async (input) => {
        if (input.outputSchema?.name === 'review.address.closure/v1')
          return { closed: true, reason: 'verified rescue' };
        if (!input.prompt.startsWith('related-check feedback'))
          await writeFile(
            join(input.workspace!.path, 'src/a.ts'),
            input.modelSpec.model === 'rescue' ? 'GOOD SAFE\n' : 'GOOD REGRESSION\n',
          );
        return { disposition: 'fixed', reason: 'claim', evidence: [] };
      },
      `const fs=require('node:fs');if(fs.readFileSync('src/a.ts','utf8').includes('REGRESSION')){console.log('src/b.ts(1,1): error TS9999: new sibling failure');process.exitCode=1;}`,
      { workerAttempts: 2, rescueBase: 1 },
    );
    try {
      const fix = await f.engine.fix(finding(), 1);
      expect(fix.finding.status, fix.reason).toBe('fixed');
      expect(f.attempts.filter((a) => a.invocation === 'edit').map((a) => a.tier)).toEqual([
        'worker',
        'rescue',
      ]);
      expect(
        f.attempts.some(
          (a) => a.tier === 'worker' && a.failedAttempt?.branch?.startsWith('cq-address/'),
        ),
      ).toBe(true);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('GOOD SAFE\n');
    } finally {
      await f.cleanup();
    }
  });
  test.each(['budget', 'aborted'] as const)(
    'engine-observed driver %s stops this unit without rescue and retains paid usage/evidence',
    async (stopReason) => {
      const f = await fixture(undefined, '', {
        workerAttempts: 2,
        rescueBase: 1,
        firstStopReason: stopReason,
      });
      try {
        const fix = await f.engine.fix(finding(), 1);
        expect(fix.finding.status).toBe('deferred');
        expect(fix.reason).toBe(`worker stopped: ${stopReason}`);
        expect(f.calls()).toBe(1);
        expect(f.attempts[0]?.usage).toEqual({ input: 2, output: 1, cacheRead: 0, cacheWrite: 0 });
        expect(f.attempts[0]?.failedAttempt?.branch).toBeTruthy();
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BAD\n');
        const sibling = await f.engine.fix(finding('src/b.ts'), 1);
        expect(sibling.finding.status, sibling.reason).toBe('fixed');
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each([
    ['feedback', 'array index still off by one'],
    ['closure', 'array index still off by one'],
    ['feedback', 'budget calculation needs another correction'],
    ['closure', 'cancel button still uses the wrong handler'],
    ['edit', 'upload budget calculation needs correction'],
  ] as const)(
    'benign %s prose reaches rescue and does not stop siblings: %s',
    async (phase, reason) => {
      let rejectClosure = phase === 'closure';
      let rejectEdit = phase === 'edit';
      const f = await fixture(
        async (input) => {
          const file = input.prompt.includes('src/b.ts') ? 'src/b.ts' : 'src/a.ts';
          const firstWorker = input.modelSpec.model === 'worker' && file === 'src/a.ts';
          if (input.outputSchema?.name === 'review.address.closure/v1') {
            if (rejectClosure) {
              rejectClosure = false;
              return { closed: false, reason };
            }
            return { closed: true, reason: 'verified fix' };
          }
          if (rejectEdit && firstWorker) {
            rejectEdit = false;
            throw new Error(reason);
          }
          const feedback = input.prompt.startsWith('related-check feedback');
          if (!feedback) await writeFile(join(input.workspace!.path, file), 'GOOD\n');
          return {
            disposition: feedback && firstWorker && phase === 'feedback' ? 'deferred' : 'fixed',
            reason,
            evidence: [],
          };
        },
        '',
        { workerAttempts: 1, rescueBase: 1 },
      );
      try {
        const first = await f.engine.fix(finding(), 1);
        expect(first.finding.status, first.reason).toBe('fixed');
        // Benign prose is not a budget stop or a tamper event: the retained
        // failed attempt carries the neutral gate/outcome.
        expect(first.failedAttempts?.[0]).toMatchObject({ gate: 'none', outcome: 'unfixed' });
        expect(first.failedAttempts?.[0]?.reason).toContain(reason);
        expect(
          f.attempts
            .filter((a) => a.finding === 'src/a.ts' && a.invocation === 'edit')
            .map((a) => a.tier),
        ).toEqual(['worker', 'rescue']);
        const sibling = await f.engine.fix(finding('src/b.ts'), 1);
        expect(sibling.finding.status, sibling.reason).toBe('fixed');
        expect(sibling.commit).toBeTruthy();
      } finally {
        await f.cleanup();
      }
    },
  );

  test.each(['success', 'cancel', 'budget', 'unit'] as const)(
    'regression: queued candidate %s shares checkout lifetime and FIFO; cleanup stays serial',
    async (outcome) => {
      const parent = new AbortController();
      let wallRemaining = 20000;
      let held!: () => void, release!: () => void;
      const firstHeld = new Promise<void>((resolve) => {
        held = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let edits = 0,
        bothEdited!: () => void;
      const editsReady = new Promise<void>((r) => {
        bothEdited = r;
      });
      const spy = vi.spyOn(gitMutex, 'makeGitMutex');
      const f = await fixture(
        async (input) => {
          if (input.outputSchema?.name === 'review.address.closure/v1')
            return { closed: true, reason: 'candidate closure' };
          if (input.prompt.startsWith('related-check feedback')) {
            if (input.prompt.includes('src/a.ts')) {
              held();
              await gate;
            }
          } else {
            const file = input.prompt.includes('Address only src/b.ts') ? 'src/b.ts' : 'src/a.ts';
            await writeFile(join(input.workspace!.path, file), 'GOOD\n');
            if (++edits === 2) bothEdited();
            await editsReady;
            if (file === 'src/b.ts') await firstHeld;
          }
          return { disposition: 'fixed', reason: 'candidate fixed', evidence: [] };
        },
        '',
        { parentSignal: parent.signal, remainingWallMs: () => wallRemaining, unitWallMs: 5000 },
      );
      let first: ReturnType<typeof f.engine.fix> | undefined;
      let second: ReturnType<typeof f.engine.fix> | undefined;
      try {
        first = f.engine.fix(finding(), 1);
        second = f.engine.fix(finding('src/b.ts'), 1);
        await firstHeld;
        await vi.waitFor(() =>
          expect(
            f.attempts.find((row) => row.finding === 'src/b.ts' && row.invocation === 'edit')
              ?.usage,
          ).toBeDefined(),
        );
        // Its invocation has settled; drain its promise continuations to the queue.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(spy).not.toHaveBeenCalled();
        expect(f.attempts.filter((row) => row.finding === 'src/b.ts')).toHaveLength(1);
        if (outcome === 'cancel') parent.abort();
        if (outcome === 'budget') wallRemaining = 0;
        if (outcome === 'unit') {
          const expired = Date.now() + 6000;
          vi.spyOn(Date, 'now').mockReturnValue(expired);
        }
        const callsBeforeRelease = f.calls();
        release();
        const results = await Promise.all([first, second]);
        expect(spy).not.toHaveBeenCalled();
        expect(f.repo.git('diff', '--cached', '--name-only')).toBe('');
        expect(f.repo.git('diff', '--name-only', 'HEAD')).toBe('');
        expect(f.repo.git('worktree', 'list', '--porcelain')).not.toContain('candidate-');
        if (outcome === 'success') {
          expect(results.map((result) => result.finding.status)).toEqual(['fixed', 'fixed']);
          expect(f.repo.git('rev-parse', `${results[1]!.commit}^`).trim()).toBe(results[0]!.commit);
          expect(f.repo.git('show', '--format=', '--name-only', results[0]!.commit!).trim()).toBe(
            'src/a.ts',
          );
          expect(f.repo.git('show', '--format=', '--name-only', results[1]!.commit!).trim()).toBe(
            'src/b.ts',
          );
        } else {
          expect(results.every((result) => !result.commit)).toBe(true);
          expect(results.map((result) => result.reason).join('\n')).toMatch(
            outcome === 'cancel' ? /parent cancelled/ : /budget exhausted/,
          );
          expect(f.calls()).toBe(callsBeforeRelease);
          expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
          for (const file of ['src/a.ts', 'src/b.ts']) {
            expect(await readFile(join(f.repo.root, file), 'utf8')).toBe('BAD\n');
            expect(f.attempts.some((row) => row.finding === file && row.failedAttempt?.sha)).toBe(
              true,
            );
          }
        }
      } finally {
        release();
        await Promise.allSettled([first, second]);
        spy.mockRestore();
        vi.restoreAllMocks();
        await f.cleanup();
      }
    },
  );
  test('same-file overlap is refused while its original worker is active', async () => {
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const f = await fixture(async () => {
      entered();
      await pending;
      return {
        disposition: 'deferred',
        reason: 'needs scope',
        evidence: [{ path: 'src/a.ts', line: 1 }],
      };
    });
    try {
      const first = f.engine.fix(finding(), 1);
      await started;
      const second = await f.engine.fix({ ...finding(), id: 'second' }, 1);
      expect(second.reason).toContain('overlapping');
      release();
      expect((await first).finding.status).toBe('deferred');
      expect(f.calls()).toBe(1);
    } finally {
      release();
      await f.cleanup();
    }
  });
});
