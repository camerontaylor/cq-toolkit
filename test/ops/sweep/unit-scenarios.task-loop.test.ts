// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { UNIT, makeWorld, runUnit } from './unit-scenarios.helpers.js';

describe('optional per-task loop', () => {
  test.each([false, true])(
    'propose-only retains a plain local attempt despite pushFailed=%s',
    async (pushFailed) => {
      const world = await makeWorld([{ failing: true }, { failing: false }]);
      const original = world.driverFactory();
      let invocations = 0;
      try {
        const result = await runUnit(world, {
          taskLoop: { pushFailed },
          proposeOnly: true,
          driver: {
            run: async (...args) => {
              invocations++;
              return original.run(...args);
            },
          },
        });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        const task = result.value.tasks?.[0];
        expect(task?.outcome).toBe('escalated-to-human');
        expect(task?.reason).toContain('propose-only worker produced');
        expect(task?.failedAttempt?.branch).toMatch(/^cq\/unit\/failed\//);
        expect(task?.rounds).toEqual([
          expect.objectContaining({
            gate: 'path-policy',
            outcome: 'escalated-to-human',
            failedAttempt: task?.failedAttempt,
          }),
        ]);
        expect(task?.failedAttemptPublished).not.toBe(true);
        expect(task?.commits).toEqual([]);
        // The early path gate refuses before the related check runs on the
        // worker's staged tree: one invocation, no related probe.
        expect(invocations).toBe(1);
        expect(world.checks).toHaveLength(1);
        expect(world.gitCalls.some((args) => args.includes('restore'))).toBe(true);
        expect(
          world.gitCalls.some((args) => args.includes('push') || args.includes('commit')),
        ).toBe(false);
        expect(world.pushCalls).toEqual([]);
      } finally {
        await rm(world.root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ['clean', undefined],
    ['moved-ref', 'no longer matches its recorded ordinal'],
    ['merge-parent', 'invalid parentage'],
    ['wrong-object', 'invalid parentage'],
    ['oversize-patch', undefined],
    ['oversize-file', undefined],
    ['binary-file', undefined],
    ['replacement-character', undefined],
    ['scoped-secret', 'worker upload refused'],
  ] as const)(
    'rescue feedback preserves provenance and omits unreadable %s evidence',
    async (fault, refusal) => {
      const world = await makeWorld([{ failing: true }, { failing: false }]);
      const underlying = world.gitFactory();
      const parent = 'a'.repeat(40);
      let recordedSha = '';
      let restores = 0;
      const prompts: string[] = [];
      const feedbackContents: Array<ReadonlyArray<{ text: string; path?: string }>> = [];
      const patch = 'diff --git a/src/a.js b/src/a.js\n-old value\n+rejected value\n';
      try {
        const result = await runUnit(world, {
          taskLoop: {},
          taskEscalation: {
            next: (_task, progress) =>
              progress.workerUsed === 0
                ? { tier: 'worker', attempt: 1, reason: 'initial task' }
                : progress.rescueUsed === 0
                  ? { tier: 'rescue', attempt: 1, reason: 'retry rejected edit' }
                  : { tier: 'human', attempt: 1, reason: 'rescue exhausted' },
            verified: () => {},
          },
          git: async (args) => {
            if (args.includes('restore')) restores++;
            if (args.includes('update-ref'))
              recordedSha = String(args[args.indexOf('update-ref') + 2]);
            if (args.includes('rev-parse') && args.some((arg) => arg.startsWith('refs/heads/')))
              return {
                code: 0,
                stdout: fault === 'moved-ref' ? 'e'.repeat(40) : recordedSha,
                stderr: '',
              };
            if (args.includes('rev-list') && args.includes('--parents'))
              return {
                code: 0,
                stdout: `${fault === 'wrong-object' ? 'e'.repeat(40) : recordedSha} ${parent}${fault === 'merge-parent' ? ` ${'d'.repeat(40)}` : ''}`,
                stderr: '',
              };
            if (args.includes('--name-status') && !args.includes('--cached'))
              return {
                code: 0,
                stdout: 'M\0src/a.js\0D\0src/deleted.js\0A\0src/new.js\0',
                stderr: '',
              };
            if (fault === 'oversize-file' && args.includes('cat-file') && args.includes('-s'))
              return { code: 0, stdout: String(4 * 1024 * 1024 + 1), stderr: '' };
            if (args.includes('show') && !args.includes('-s')) {
              const object = String(args.at(-1));
              return {
                code: 0,
                stdout:
                  fault === 'binary-file'
                    ? 'binary\0content'
                    : fault === 'replacement-character'
                      ? 'bad\uFFFDtext'
                      : object.startsWith(parent)
                        ? 'old value'
                        : 'rejected value',
                stderr: '',
              };
            }
            if (args.includes('--binary'))
              return {
                code: 0,
                stdout: fault === 'oversize-patch' ? 'x'.repeat(32 * 1024 * 1024 + 1) : patch,
                stderr: '',
              };
            return underlying(args);
          },
          scanPrompt: async (text, contents) => {
            if (!text.includes('Prior failed-attempt patch')) return;
            feedbackContents.push(contents ?? []);
            if (
              fault === 'scoped-secret' &&
              contents?.some(({ path }) => path === 'src/deleted.js')
            )
              throw new Error('path-scoped rule rejects deleted preimage');
          },
          driver: {
            run: async (invocation) => {
              prompts.push(invocation.prompt);
              if (prompts.length === 1)
                return {
                  stopReason: 'error',
                  denials: [],
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                };
              expect(restores).toBeGreaterThan(0);
              return {
                stopReason: 'complete',
                denials: [],
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                structuredOutput: {
                  outcome: 'code-bug',
                  summary: 'repair source',
                  confidence: 0.9,
                },
              };
            },
          },
        });
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        const task = result.value.tasks?.[0];
        expect(task?.rounds?.[0]?.failedAttempt?.sha).toBe(recordedSha);
        if (refusal === undefined) {
          expect(task?.outcome).toBe('fixed');
          expect(task?.commits).toHaveLength(1);
          expect(prompts).toHaveLength(3);
          if (fault === 'clean') {
            expect(prompts[1]).toContain(patch.trim());
            expect(feedbackContents).toHaveLength(2);
          } else {
            expect(prompts[1]).not.toContain('Prior failed-attempt patch');
            expect(feedbackContents).toEqual([]);
          }
          for (const contents of feedbackContents)
            expect(contents).toEqual([
              { path: 'src/a.js', text: 'old value' },
              { path: 'src/a.js', text: 'rejected value' },
              { path: 'src/deleted.js', text: 'old value' },
              { path: 'src/new.js', text: 'rejected value' },
            ]);
        } else {
          expect(task?.rounds?.[1]?.reason).toContain(refusal);
          expect(task?.outcome).toBe('escalated-to-human');
          expect(task?.commits).toEqual([]);
          expect(prompts).toHaveLength(1);
          expect(world.checks).toHaveLength(1);
          expect(world.pushCalls).toEqual([]);
        }
      } finally {
        await rm(world.root, { recursive: true, force: true });
      }
    },
  );

  test('an unchanged failed attempt has no commit, ref, or publishable artifact', async () => {
    const world = await makeWorld([{ failing: true }]);
    const underlying = world.gitFactory();
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        git: async (args) =>
          args.includes('--cached') && args.includes('--name-only')
            ? { code: 0, stdout: '', stderr: '' }
            : underlying(args),
        driver: {
          run: async () => ({
            stopReason: 'error',
            denials: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }),
        },
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const task = result.value.tasks?.[0];
      expect(task?.outcome).toBe('unfixed');
      expect(task?.failedAttempt).toBeUndefined();
      expect(task?.rounds?.[0]?.failedAttempt).toBeUndefined();
      expect(
        world.gitCalls.some((args) => args.includes('commit-tree') || args.includes('update-ref')),
      ).toBe(false);
      expect(world.pushCalls).toEqual([]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      gate: 'tamper',
      pkg: 'alpha',
      diff: 'diff --git a/suite.test.js b/suite.test.js\n+++ b/suite.test.js\n@@ -0,0 +1 @@\n+test.skip("bad", () => {});\n',
    },
    { gate: 'commit', pkg: 'alpha)invalid', diff: undefined },
  ] as const)('records the $gate failed-attempt gate', async ({ gate, pkg, diff }) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const underlying = world.gitFactory();
    try {
      const result = await runUnit(
        world,
        {
          taskLoop: {},
          driver: {
            run: async () => ({
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
              structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
            }),
          },
          git: async (args) =>
            diff !== undefined &&
            args.includes('diff') &&
            args.includes('--cached') &&
            !args.includes('--name-status')
              ? { code: 0, stdout: diff, stderr: '' }
              : underlying(args),
        },
        { ...UNIT, package: pkg },
      );
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.tasks?.[0]?.rounds?.[0]).toMatchObject({ gate });
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('binary failed-attempt content stays local and never reaches the scanner', async () => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const underlying = world.gitFactory();
    const scanPrompt = vi.fn(async (_text: string) => {});
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
            structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
          }),
        },
        scanPrompt,
        git: async (args) =>
          args.includes('show') && args.some((arg) => arg.includes(':src/a.js'))
            ? { code: 0, stdout: 'binary\0content', stderr: '' }
            : underlying(args),
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.indeterminate).toContain('failed-attempt publication refused');
      expect(
        scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
      ).toBe(false);
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('failed-attempt scan refuses file content over its cap before scanning or pushing', async () => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const underlying = world.gitFactory();
    const scanPrompt = vi.fn(async (_text: string) => {});
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
            structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
          }),
        },
        scanPrompt,
        git: async (args) =>
          args.includes('cat-file') && args.includes('-s') && args.at(-1)?.endsWith(':src/a.js')
            ? { code: 0, stdout: String(4 * 1024 * 1024 + 1), stderr: '' }
            : underlying(args),
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.indeterminate).toContain('failed-attempt publication refused');
      expect(
        scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
      ).toBe(false);
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test.each([
    {
      refusal: 'unsupported rename record',
      expectedReason: 'invalid or unsupported path record',
      scanDiff: 'R100\0src/old.js\0src/new.js\0',
    },
    {
      refusal: 'truncated path record',
      expectedReason: 'invalid or unsupported path record',
      scanDiff: 'M\0',
    },
    {
      refusal: 'path traversal',
      expectedReason: 'path outside the repository',
      scanDiff: 'M\0../outside.js\0',
    },
    {
      refusal: 'invalid object size',
      expectedReason: 'cannot determine failed-attempt size',
      scanDiff: 'M\0src/a.js\0',
    },
    {
      refusal: 'aggregate content cap',
      expectedReason: 'contents exceed the total scan cap',
      scanDiff: Array.from({ length: 5 }, (_, i) => `M\0src/file-${i}.js\0`).join(''),
    },
  ])('keeps failed-attempt publication local on $refusal', async ({ expectedReason, scanDiff }) => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    const underlying = world.gitFactory();
    const scanPrompt = vi.fn(async (_text: string) => {});
    try {
      const result = await runUnit(world, {
        taskLoop: { pushFailed: true },
        driver: {
          run: async () => ({
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
            structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
          }),
        },
        scanPrompt,
        git: async (args) => {
          if (args.includes('diff') && args.includes('--name-status') && !args.includes('--cached'))
            return { code: 0, stdout: scanDiff, stderr: '' };
          if (args.includes('cat-file') && args.includes('-s'))
            return {
              code: 0,
              stdout: expectedReason.includes('determine failed-attempt size')
                ? 'invalid-size'
                : String(4 * 1024 * 1024),
              stderr: '',
            };
          return underlying(args);
        },
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(JSON.stringify(result.value)).toContain('failed-attempt publication refused');
        expect(JSON.stringify(result.value)).toContain(expectedReason);
      }
      expect(
        scanPrompt.mock.calls.some(([text]) => text.startsWith('Failed-attempt commit ')),
      ).toBe(false);
      expect(world.gitCalls.some((args) => args.includes('push'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('cleanup and publish failures retain task evidence as indeterminate unit reports', async () => {
    for (const fault of ['cleanup', 'publish']) {
      const world = await makeWorld([{ failing: true }, { failing: false }]);
      const underlying = world.gitFactory();
      try {
        const result = await runUnit(world, {
          taskLoop: {},
          git: async (args) =>
            args.includes('restore') && fault === 'cleanup'
              ? { code: 1, stdout: '', stderr: 'restore fault' }
              : underlying(args),
          driver:
            fault === 'cleanup'
              ? world.driverFactory()
              : {
                  run: async (invocation) => {
                    expect(invocation.toolPolicy.allow).not.toContain('run');
                    return {
                      stopReason: 'complete',
                      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                      denials: [],
                      structuredOutput: {
                        outcome: 'code-bug',
                        summary: 'repair source',
                        confidence: 0.9,
                      },
                    };
                  },
                },
          pushBranch: async () => {
            throw new Error('offline push fault');
          },
        });
        expect(result.status).toBe('ok');
        if (result.status === 'ok') {
          expect(result.value.tasks).toHaveLength(1);
          expect(result.value.indeterminate).toContain(
            fault === 'cleanup' ? 'failed-task evidence recording failed' : 'publish failed',
          );
          expect(result.value.committed).toBe(fault === 'publish');
        }
      } finally {
        await rm(world.root, { recursive: true, force: true });
      }
    }
  });
  test('absolute runner paths become checkout-relative task files', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const runCheck = world.runCheckFactory();
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        runCheck: async (command) => {
          const output = await runCheck(command);
          return {
            ...output,
            stdout: output.stdout.replaceAll('suite.test.js', `${command.cwd}/suite.test.js`),
          };
        },
        deriveTasks: (baseline) => {
          expect(baseline.failures[0]?.file).toBe('suite.test.js');
          return [];
        },
      });
      expect(result.status).toBe('ok');
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
  test('stateless related feedback precedes detached broader gate and a verified task commit', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const prompts: string[] = [];
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        driver: {
          run: async (invocation) => {
            prompts.push(invocation.prompt);
            expect(invocation.sessionRef).toBeUndefined();
            return {
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
              structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
            };
          },
        },
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.tasks?.[0]?.outcome).toBe('fixed');
        expect(result.value.tasks?.[0]?.attempts).toHaveLength(2);
        expect(result.value.tasks?.[0]?.commits).toHaveLength(1);
      }
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Related check:');
      expect(world.checks.some((path) => path.includes('.cq-sweep-final-'))).toBe(true);
      expect(world.gitCalls.find((args) => args.includes('commit'))?.at(-1)).toContain(
        'Outcome: code-bug',
      );
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
  test('protectTests sends test edits to human and commits nothing', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const underlying = world.gitFactory();
    try {
      const result = await runUnit(world, {
        taskLoop: { protectTests: true },
        git: async (args) =>
          args.includes('--name-status')
            ? { code: 0, stdout: 'M\0suite.test.js\0', stderr: '' }
            : underlying(args),
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.tasks?.[0]?.outcome).toBe('escalated-to-human');
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});
