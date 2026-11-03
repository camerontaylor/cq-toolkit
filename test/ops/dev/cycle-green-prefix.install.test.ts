// Split provenance: test/ops/dev/cycle-green-prefix.test.ts was split by
// subject; this file holds the dependency-install tests (when a probed
// candidate needs its own install, and what an install or dependency-input
// fault does). The shared scenario harness lives in
// cycle-green-prefix.helpers.ts.
// #536 (Giles D2/D2b): red final gates after verified fixes. dev.cycle probes
// the verified-fix chain newest to oldest in an isolated worktree and
// publishes a DRAFT from a NEW branch pinned to the newest commit passing ALL
// final gates; the author's branch, worktree and ledger stay at the addressed
// head. Real git (work repo + bare origin); every op leg, the probe checks,
// the install and the forge are scripted. No provider, network or credentials.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bindCycleHarness } from './cycle-green-prefix.helpers.js';
import { makeTestRepo, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await repo.cleanup();
});

const { run, expectAuthorUntouched } = bindCycleHarness(() => repo);

describe('dev.cycle red final gates: newest green verified-fix commit (#536)', () => {
  test('a candidate whose dependency inputs differ is reinstalled before its probe', async () => {
    // c0 green, c1 changes package.json (red), T red: probing c1 then c0
    // crosses the dependency change, so c0 gets its own install.
    const r = await run({ greens: [true, false, false], stop: 'budget', dependencyChangeAt: 1 });
    expect(r.result.status).toBe('needs-human');
    expect(r.installs).toEqual([r.probeDir, r.probeDir]);
    expect(r.probeRoots).toHaveLength(2);
  });

  test('a pnpm hook-only change (.pnpmfile.cjs) also reinstalls', async () => {
    const r = await run({
      greens: [true, false, false],
      stop: 'budget',
      dependencyChangeAt: 1,
      dependencyFile: '.pnpmfile.cjs',
    });
    expect(r.result.status).toBe('needs-human');
    expect(r.installs).toEqual([r.probeDir, r.probeDir]);
  });

  test.each([
    ['.npmrc', 'pnpmfile=tools/pnpm-hook.cjs\n', 'tools/pnpm-hook.cjs'],
    ['.npmrc', 'pnpmfile = "tools/pnpm hook.cjs"\n', 'tools/pnpm hook.cjs'],
    ['pnpm-workspace.yaml', 'pnpmfile: "tools/pnpm hook.cjs"\n', 'tools/pnpm hook.cjs'],
    ['pnpm-workspace.yaml', 'pnpmfile: ./tools/../tools/pnpm-hook.cjs\n', 'tools/pnpm-hook.cjs'],
    ['pnpm-workspace.yaml', "pnpmfile: 'tools/pnpm hook.cjs' # hook\n", 'tools/pnpm hook.cjs'],
    ['pnpm-workspace.yaml', '"pnpmfile": tools/pnpm-hook.cjs\n', 'tools/pnpm-hook.cjs'],
    ['pnpm-workspace.yaml', 'pnpmfile: >-\n  tools/pnpm-hook.cjs\n', 'tools/pnpm-hook.cjs'],
  ] as const)(
    'a content-only change to a custom pnpmfile (%s: %j) reinstalls',
    async (configFile, setting, hook) => {
      // The setting is committed before the chain; only the hook content changes.
      await repo.write(configFile, setting);
      await repo.write(hook, 'module.exports = {};\n');
      repo.git('add', configFile, hook);
      repo.git('commit', '-q', '-m', 'configure a pnpm hook');
      const r = await run({
        greens: [true, false, false],
        stop: 'budget',
        dependencyChangeAt: 1,
        dependencyFile: hook,
      });
      expect(r.result.status).toBe('needs-human');
      expect(r.installs).toEqual([r.probeDir, r.probeDir]);
    },
  );

  test('candidates with identical dependency inputs share one install', async () => {
    const r = await run({ greens: [true, false, false], stop: 'budget' });
    expect(r.result.status).toBe('needs-human');
    expect(r.installs).toEqual([r.probeDir]);
    expect(r.probeRoots).toHaveLength(2);
  });

  test('an install failure publishes nothing and removes the worktree', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      installDeps: async () => {
        throw new Error('offline store miss');
      },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('dependency install failed — offline store miss');
    expect(r.probeRoots).toEqual([]);
    expectAuthorUntouched(r);
  });

  test('a failed dependency-input comparison faults the probe instead of reusing the install', async () => {
    const r = await run({
      greens: [true, false, false],
      stop: 'budget',
      authorHandler: (command, args) =>
        command === 'git' && args.includes('diff') && args.includes('--name-only')
          ? { exitCode: 128, stdout: '', stderr: 'bad object', timedOut: false }
          : undefined,
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('dependency-input comparison failed: bad object');
    expect(r.probeRoots).toHaveLength(1);
    expectAuthorUntouched(r);
  });
});
