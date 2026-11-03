// Split provenance: test/ops/dev/cycle-green-prefix.test.ts was split by
// subject; this file holds the candidate-selection and admission tests (which
// verified-fix commit is published, and which runs are refused before any
// probe). The shared scenario harness lives in
// cycle-green-prefix.helpers.ts.
// #536 (Giles D2/D2b): red final gates after verified fixes. dev.cycle probes
// the verified-fix chain newest to oldest in an isolated worktree and
// publishes a DRAFT from a NEW branch pinned to the newest commit passing ALL
// final gates; the author's branch, worktree and ledger stay at the addressed
// head. Real git (work repo + bare origin); every op leg, the probe checks,
// the install and the forge are scripted. No provider, network or credentials.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { bindCycleHarness, expectNoDispatchUsage } from './cycle-green-prefix.helpers.js';
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
  test.each([
    ['green-red-green: the NEWEST green wins', [true, false, true, false], 2, 1],
    ['red-green-red: scans past a red candidate', [false, true, false, false], 1, 2],
  ] as const)('%s', async (_label, greens, selectedIndex, probes) => {
    const r = await run({ greens: [...greens], stop: 'budget' });
    const G = r.commits[selectedIndex]!;
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human') {
      expect(r.result.reason).toContain(`draft PR #77 published from '${r.pub}' at ${G}`);
      expect(r.result.reason).toContain(`red at the addressed head ${r.T} (format:check)`);
      expect(r.result.reason).toContain(
        `dropping ${String(greens.length - 1 - selectedIndex)} fix(es)`,
      );
    }
    expectNoDispatchUsage(r);
    expect(r.probeRoots).toHaveLength(probes);
    expect(r.probeRoots.every((root) => root === r.probeDir)).toBe(true);
    expect(r.probeDir.startsWith(join(r.probeParent, r.probePrefix))).toBe(true);
    expect(r.installs).toEqual([r.probeDir]);
    // The pinned push sends G's object to the NEW publication branch only.
    expect(r.pushes.filter((args) => args.includes('push'))).toEqual([
      ['-C', repo.root, 'push', 'origin', `${G}:refs/heads/${r.pub}`],
    ]);
    // pr.open ran inside the probe worktree, on the publication branch at G.
    expect(r.opens).toHaveLength(1);
    expect(r.opens[0]!.root).toBe(r.probeDir);
    expect(r.opens[0]!.input).toMatchObject({
      repoRoot: r.probeDir,
      draft: true,
      draftWhenNotReady: true,
    });
    const section = r.bodies.at(-1)!;
    expect(section).toContain(`PUBLISHED AT \`${G}\``);
    expect(section).toContain('NOT re-reviewed at the published commit');
    // Giles D2c: the author's ledger is referenced, never bound.
    expect(section).toContain('unbound deferred debt from the abandoned tip; not acknowledged');
    expect(section).toMatch(/feature_x\.json|feature%2Fx\.json|\.cq\/dev\//);
    expect(section).toMatch(/sha256 `[0-9a-f]{64}`/);
    for (const dropped of r.commits.slice(selectedIndex + 1))
      expect(section).toContain(`\`${dropped}\``);
    expectAuthorUntouched(r);
    // The published branch stays (it is on the forge now); the worktree is gone.
    expect(repo.git('rev-parse', `refs/heads/${r.pub}`).trim()).toBe(G);
  });

  test('every candidate red: the red result verbatim plus per-probe attribution, nothing published', async () => {
    const r = await run({ greens: [false, false, false], stop: 'rereview-blocked' });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.error).toMatch(
        /^dev\.cycle \(dev\.check \(final\)\): dev\.check: 1 gate\(s\) red \(format:check\)/,
      );
      expect(r.result.error).toContain('no candidate passed all final gates (2 probed)');
      expect(r.result.error).toContain(`${r.commits[1]!} red`);
      expect(r.result.error).toContain(`${r.commits[0]!} red`);
      expect(r.result.error).toContain('nothing published');
    }
    expectNoDispatchUsage(r);
    expect(r.pushes.filter((args) => args.includes('push'))).toEqual([]);
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('the clean-address path with red final gates publishes too (D2b)', async () => {
    const r = await run({ greens: [true, false] });
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human')
      expect(r.result.reason).toContain(`at ${r.commits[0]!}, the newest verified-fix commit`);
    expectNoDispatchUsage(r);
    expect(r.bodies.at(-1)).toContain('## Findings after red final gates');
    expectAuthorUntouched(r);
  });

  test('a reserve that cannot cover one probe publishes nothing and says why', async () => {
    const r = await run({ greens: [true, false], stop: 'budget', finalCheckMs: 9 * 60 * 1000 });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('cannot cover a worktree setup and one');
    expect(r.installs).toEqual([]);
    expect(r.probeRoots).toEqual([]);
    expect(r.opens).toEqual([]);
  });

  test('an admitted head that is not this run’s green opening check publishes nothing', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      reviewHead: 'b'.repeat(40),
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain("is not this run's green opening check");
    expect(r.probeRoots).toEqual([]);
    expect(r.opens).toEqual([]);
  });

  test('a first round re-reviewed at the fixed head (rounds[0].record replaced) still publishes', async () => {
    const r = await run({
      greens: [true, false],
      tamper: (report) => {
        // review.address replaces a round's record with its re-review.
        report.rounds[0]!.record.head = report.verifiedHead!;
      },
    });
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human')
      expect(r.result.reason).toContain(`at ${r.commits[0]!}, the newest verified-fix commit`);
  });

  test('a first fix not dispatched at the admitted head publishes nothing', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      tamper: (report) => {
        report.fixes[0]!.observedHead = 'c'.repeat(40);
      },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the first verified fix was dispatched at');
    expect(r.probeRoots).toEqual([]);
  });

  test('recorded fix commits that are not the linear history publish nothing (no commit-presence shortcut)', async () => {
    const r = await run({
      greens: [true, false, false],
      stop: 'budget',
      tamper: (report) => {
        report.fixes.splice(1, 1);
      },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('are not the linear history');
    expect(r.probeRoots).toEqual([]);
  });

  test('a single verified fix (the red head itself) has no earlier candidate: attributed, nothing probed', async () => {
    const r = await run({ greens: [false], stop: 'budget' });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('no verified-fix commit precedes the addressed head');
    expect(r.installs).toEqual([]);
  });
});
