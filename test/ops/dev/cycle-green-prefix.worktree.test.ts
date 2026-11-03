// Split provenance: test/ops/dev/cycle-green-prefix.test.ts was split by
// subject; this file holds the probe-worktree lifecycle tests (setup that
// fails part-way or eats the reserve, and release failures that are reported
// rather than retried). The shared scenario harness lives in
// cycle-green-prefix.helpers.ts.
// #536 (Giles D2/D2b): red final gates after verified fixes. dev.cycle probes
// the verified-fix chain newest to oldest in an isolated worktree and
// publishes a DRAFT from a NEW branch pinned to the newest commit passing ALL
// final gates; the author's branch, worktree and ledger stay at the addressed
// head. Real git (work repo + bare origin); every op leg, the probe checks,
// the install and the forge are scripted. No provider, network or credentials.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
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

const { run } = bindCycleHarness(() => repo);

describe('dev.cycle red final gates: newest green verified-fix commit (#536)', () => {
  test('a worktree git materialized before its add failed is still released', async () => {
    let materialized: string | undefined;
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      authorHandler: (command, args) => {
        if (command !== 'git' || !args.includes('worktree') || !args.includes('add'))
          return undefined;
        // Simulate an interrupted add: git registers and checks out, then fails.
        const at = args.indexOf('add');
        materialized = args[at + 1]!;
        repo.git('worktree', 'add', '-q', materialized, args[at + 2]!);
        return { exitCode: 1, stdout: '', stderr: 'interrupted checkout', timedOut: false };
      },
    });
    expect(materialized).toBeDefined();
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the probe worktree could not be created');
    expect(existsSync(materialized!)).toBe(false);
    expect(repo.git('worktree', 'list', '--porcelain')).not.toContain(materialized!);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('a worktree setup that consumes the reserve leaves no room for the install: nothing published', async () => {
    let advanced = false;
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      authorHandler: (command, args) => {
        if (!advanced && command === 'git' && args.includes('worktree') && args.includes('add')) {
          advanced = true;
          const now = Date.now();
          vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
        }
        return undefined;
      },
    });
    expect(advanced).toBe(true);
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('worktree setup the reserve no longer covers an install');
    expect(r.installs).toEqual([]);
    expect(r.probeRoots).toEqual([]);
    expect(repo.git('worktree', 'list', '--porcelain')).not.toContain(r.probePrefix);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test.each([
    ['no publication', undefined, 'failed'],
    ['a published draft', true, 'needs-human'],
    ['a failed pr.open', false, 'failed'],
  ] as const)(
    'a failed worktree release is reported on %s, never retried',
    async (_label, green, status) => {
      let removals = 0;
      const r = await run({
        greens: [green ?? false, false],
        stop: 'budget',
        ...(green === false
          ? {
              openInResult: async () => ({
                status: 'failed' as const,
                error: 'pr.open: create failed',
              }),
            }
          : {}),
        ...(green === false ? { greens: [true, false] } : {}),
        authorHandler: (command, args) => {
          if (command !== 'git' || !args.includes('worktree') || !args.includes('remove'))
            return undefined;
          removals += 1;
          return { exitCode: 1, stdout: '', stderr: 'worktree busy', timedOut: false };
        },
      });
      expect(r.result.status).toBe(status);
      // Exactly one release attempt: a failure is reported, never retried.
      expect(removals).toBe(1);
      const text =
        r.result.status === 'failed'
          ? r.result.error
          : r.result.status === 'needs-human'
            ? r.result.reason
            : '';
      expect(text).toContain(`probe cleanup: worktree remove ${r.probeDir} failed: worktree busy`);
    },
  );
});
