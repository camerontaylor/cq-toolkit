// Split provenance: test/ops/dev/cycle-green-prefix.test.ts was split by
// subject; this file holds the red-final-verdict passthrough tests (the red
// final check's own result is returned verbatim, and non-red statuses pass
// through untouched). The shared scenario harness lives in
// cycle-green-prefix.helpers.ts.
// #536 (Giles D2/D2b): red final gates after verified fixes. dev.cycle probes
// the verified-fix chain newest to oldest in an isolated worktree and
// publishes a DRAFT from a NEW branch pinned to the newest commit passing ALL
// final gates; the author's branch, worktree and ledger stay at the addressed
// head. Real git (work repo + bare origin); every op leg, the probe checks,
// the install and the forge are scripted. No provider, network or credentials.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  test('a later uncommitted red check cannot replace full-scope green evidence', async () => {
    const r = await run({
      greens: [true, false],
      finalRecordPassed: true,
      laterUncommittedRed: true,
    });
    expect(r.result.status).toBe('failed');
    expect(r.probeRoots).toEqual([]);
    expect(r.opens).toEqual([]);
  });

  test('a git fault before any probe resource returns the red result with the fault named', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      authorHandler: (command, args) => {
        if (command === 'git' && args.includes('rev-list')) throw new Error('git spawn failed');
        return undefined;
      },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.error).toMatch(/^dev\.cycle \(dev\.check \(final\)\): /);
      expect(r.result.error).toContain(
        'the green-prefix fallback faulted before probing: git spawn failed',
      );
    }
    expect(r.probeRoots).toEqual([]);
  });

  test.each([
    [
      'a dirty author tree',
      { beforeFinal: () => writeFileSync(join(repo.root, 'stray.txt'), 'x') },
      'dev.cycle (dev.check (final)): dev.check: 1 gate(s) red (format:check) — record k002-final is in the branch dev-record',
    ],
    [
      'an author ledger whose last check is not red at T',
      { finalRecordPassed: true },
      'dev.cycle (dev.check (final)): dev.check: the final gate failed',
    ],
  ] as const)('%s keeps the red final result verbatim', async (_label, extra, error) => {
    const r = await run({ greens: [true, false], stop: 'budget', ...extra });
    // The original verdict, exactly (a future outer wrapper may add a report).
    expect(r.result).toMatchObject({ status: 'failed', error });
    expect(r.installs).toEqual([]);
    expect(r.probeRoots).toEqual([]);
  });

  test('a final check that is not a red verdict (budget-exhausted) is returned as-is', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      finalCheckStatus: 'budget-exhausted',
    });
    expect(r.result.status).toBe('budget-exhausted');
    expect(r.installs).toEqual([]);
  });

  test.each([
    ['no installDeps hook', { installDeps: null }],
    ['push opted out', { push: false }],
    ['an injected open leg owns the forge (no gh, no openIn)', { injectedOpenOwnsForge: true }],
  ] as const)('%s: the red final result is returned verbatim', async (_label, extra) => {
    const r = await run({ greens: [true, false], stop: 'budget', ...extra });
    // Status and error identity; a future outer wrapper may add a report.
    expect(r.result).toMatchObject({
      status: 'failed',
      error:
        'dev.cycle (dev.check (final)): dev.check: 1 gate(s) red (format:check) — record k002-final is in the branch dev-record',
    });
    expect(r.probeRoots).toEqual([]);
    expect(r.installs).toEqual([]);
  });
});
