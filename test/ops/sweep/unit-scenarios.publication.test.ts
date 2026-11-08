// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { makeSweepUnitOp } from '../../../src/ops/sweep/unit.js';
import { bindingsOf, makeWorld, runUnit, UNIT } from './unit-scenarios.helpers.js';

describe('sweep unit in-process scenarios', () => {
  test('failed publication pushes the scanned SHA even if its branch moves during scanning', async () => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const underlying = world.gitFactory();
    let branchTip = '';
    let branchRef = '';
    let pushedSha = '';
    const retargetedSha = 'e'.repeat(40);
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        stagePathAllowlist: { patterns: ['^src/'] },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'error',
          }),
        },
        scanPrompt: async (text) => {
          if (text.startsWith('Failed-attempt commit ')) branchTip = retargetedSha;
        },
        git: async (args) => {
          const updateRefIndex = args.indexOf('update-ref');
          if (updateRefIndex !== -1) {
            branchRef = String(args[updateRefIndex + 1]);
            branchTip = String(args[updateRefIndex + 2]);
          }
          const pushIndex = args.indexOf('push');
          if (pushIndex !== -1) {
            const refspec = String(args[pushIndex + 2]);
            const source = refspec.split(':')[0];
            pushedSha = source?.startsWith('refs/heads/') ? branchTip : String(source);
          }
          return underlying(args);
        },
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const failedAttempt = result.value.tasks?.[0]?.failedAttempt;
      expect(failedAttempt).toBeDefined();
      expect(branchTip).toBe(retargetedSha);
      expect(pushedSha).toBe(failedAttempt?.sha);
      expect(pushedSha).not.toBe(retargetedSha);
      expect(
        world.gitCalls.some(
          (args) => args.includes('push') && args.at(-1) === `${failedAttempt?.sha}:${branchRef}`,
        ),
      ).toBe(true);
      expect(result.value.tasks?.[0]?.failedAttemptPublished).toBe(true);
      // The push is also recorded on the ROUND, so a later attempt cannot
      // erase the ref from the report.
      expect(result.value.tasks?.[0]?.rounds?.[0]?.published).toBe(true);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('a unit without a failed-attempt upload capability never publishes one', async () => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const scanPrompt = vi.fn(async (_text: string) => {});
    try {
      const local = bindingsOf(world, {
        taskLoop: { pushFailed: true },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'error',
          }),
        },
        scanPrompt,
      });
      // The upload capability is its own explicit opt-in (bindingsFromDispatch
      // grants it only from `taskLoop.pushFailed`): absent it, a failed
      // attempt is neither scanned nor pushed, whatever the push binding says.
      delete local.pushBranch;
      delete local.publishFailedAttempts;
      const result = await makeSweepUnitOp(local)(UNIT);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') expect(result.value.tasks?.[0]?.failedAttempt).toBeDefined();
      expect(
        scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
      ).toBe(false);
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
      expect(world.pushCalls).toEqual([]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('an early worker stop cannot publish a failed attempt that adds a suppression', async () => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const underlying = world.gitFactory();
    const scanPrompt = vi.fn(async (_text: string) => {});
    const suppressionPatch = [
      'diff --git a/src/a.js b/src/a.js',
      'index 1111111..2222222 100644',
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1 +1,2 @@',
      ' safe',
      '+// @ts-nocheck',
      '',
    ].join('\n');
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        stagePathAllowlist: { patterns: ['^src/'] },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'error',
          }),
        },
        scanPrompt,
        git: async (args) =>
          args.includes('--binary') && args.includes('--full-index')
            ? { code: 0, stdout: suppressionPatch, stderr: '' }
            : underlying(args),
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        const task = result.value.tasks?.[0];
        expect(task?.failedAttempt).toBeDefined();
        expect(task?.failedAttemptPublished).not.toBe(true);
        // A positive tamper finding is THIS task's refusal: the unit keeps
        // running (and its verified commits stay publishable), so no
        // unit-wide indeterminate state is recorded.
        expect(result.value.indeterminate).toBeUndefined();
        expect(task?.outcome).toBe('escalated-to-human');
        expect(task?.reason).toContain('tamper gate refused publication');
        expect(JSON.stringify(result.value)).toContain('tamper gate refused publication');
      }
      expect(
        scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
      ).toBe(false);
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test.each(['tamper diff read error', 'indeterminate tamper diff'] as const)(
    'failed-attempt publication retains local evidence and refuses a %s',
    async (fault) => {
      const world = await makeWorld([{ failing: true }, { failing: true }]);
      const underlying = world.gitFactory();
      const scanPrompt = vi.fn(async (_text: string) => {});
      try {
        const result = await runUnit(world, {
          taskLoop: { pushFailed: true },
          stagePathAllowlist: { patterns: ['^src/'] },
          driver: {
            run: async () => ({
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'error',
            }),
          },
          scanPrompt,
          git: async (args) => {
            if (
              args.includes('diff') &&
              args.includes('--binary') &&
              args.includes('--full-index')
            ) {
              if (fault === 'tamper diff read error') throw new Error('synthetic diff read error');
              return { code: 0, stdout: 'synthetic malformed diff', stderr: '' };
            }
            return underlying(args);
          },
        });
        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
          const failedAttempt = result.value.tasks?.[0]?.failedAttempt;
          expect(failedAttempt).toBeDefined();
          expect(result.value.tasks?.[0]?.failedAttemptPublished).not.toBe(true);
          expect(result.value.indeterminate).toContain('failed-attempt publication refused');
          expect(
            world.gitCalls.some(
              (args) =>
                args.includes('update-ref') &&
                args.includes(`refs/heads/${failedAttempt?.branch}`) &&
                args.includes(failedAttempt?.sha ?? ''),
            ),
          ).toBe(true);
          if (fault === 'tamper diff read error')
            expect(result.value.indeterminate).toContain('synthetic diff read error');
          else
            expect(result.value.indeterminate).toContain(
              'tamper scan could not complete: indeterminate',
            );
        }
        expect(
          scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
        ).toBe(false);
        expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
      } finally {
        await rm(world.root, { recursive: true, force: true });
      }
    },
  );

  test('parent cancellation during failed-attempt scan blocks off-machine publication', async () => {
    const world = await makeWorld([
      { failing: true, message: 'baseline' },
      { failing: true, message: 'related failure' },
    ]);
    const cancelled = { value: false };
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        cancelled: () => cancelled.value,
        scanPrompt: async (text) => {
          if (text.startsWith('Failed-attempt commit ')) cancelled.value = true;
        },
      });
      expect(result.status).toBe('ok');
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});
