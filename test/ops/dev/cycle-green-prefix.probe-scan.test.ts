// Split provenance: test/ops/dev/cycle-green-prefix.test.ts was split by
// subject; this file holds the probe-scan tests (the probe checkout's inputs,
// the probes' faults and reserve consumption, and the selection binding that
// is re-read after probing). The shared scenario harness lives in
// cycle-green-prefix.helpers.ts.
// #536 (Giles D2/D2b): red final gates after verified fixes. dev.cycle probes
// the verified-fix chain newest to oldest in an isolated worktree and
// publishes a DRAFT from a NEW branch pinned to the newest commit passing ALL
// final gates; the author's branch, worktree and ledger stay at the addressed
// head. Real git (work repo + bare origin); every op leg, the probe checks,
// the install and the forge are scripted. No provider, network or credentials.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { bindCycleHarness } from './cycle-green-prefix.helpers.js';
import { stubScanner } from './fakes.js';
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
  test('absolute named test files under the author checkout are re-rooted into the probe checkout', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      testFiles: (root) => [
        join(root, 'test/a.test.ts'),
        join(root, '..fixtures/d.test.ts'),
        'test/b.test.ts',
        '/elsewhere/c.test.ts',
      ],
    });
    expect(r.result.status).toBe('needs-human');
    expect(r.probeSteps.map((step) => step.testFiles)).toEqual([
      [
        join(r.probeDir, 'test/a.test.ts'),
        join(r.probeDir, '..fixtures/d.test.ts'),
        'test/b.test.ts',
        '/elsewhere/c.test.ts',
      ],
    ]);
    expect(r.probeSteps[0]!.repoRoot).toBe(r.probeDir);
  });

  test('a probe fault stops the scan: no misattributed red, nothing published, worktree removed', async () => {
    const r = await run({ greens: [true, false], stop: 'budget', probeFault: 'host lock busy' });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.error).toContain(`probe of ${r.commits[0]!} faulted: host lock busy`);
      expect(r.result.error).toContain('nothing published');
    }
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
  });

  test('a reserve exhausted during the publication binding re-reads stops before the push', async () => {
    let probes = 0;
    let bound = false;
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      onProbe: () => {
        probes += 1;
      },
      authorHandler: (command, args) => {
        // The first author re-read after a probe ran: the binding step.
        if (!bound && command === 'git' && args[0] === 'symbolic-ref' && probes > 0) {
          bound = true;
          const now = Date.now();
          vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
        }
        return undefined;
      },
    });
    expect(bound).toBe(true);
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the reserve ran out during the publication binding');
    expect(r.pushes.filter((args) => args.includes('push'))).toEqual([]);
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
  });

  test('without a scanner bound to the probe root, the author scanner is never reused: no probe certifies', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      defaultProbeCheck: { scanSecrets: true },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('no secret scanner could be bound to the probe worktree');
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('the probe scanner is built from the PROBE root; a throw there releases the worktree and branch', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      defaultProbeCheck: {
        scanSecrets: true,
        scanSecretsFor: () => {
          throw new Error('candidate cq.json unreadable');
        },
      },
    });
    expect(r.probeRoots).toEqual([r.probeDir]);
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the probe phase threw — candidate cq.json unreadable');
    expectAuthorUntouched(r);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('without a publication scanner bound to the probe root, the author scanner is never reused: nothing published', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      // The harness still wires a stub author scanner; the probe factory
      // binds nothing, so the default probe leg must refuse before the push.
      defaultProbePublication: { probeScannerFor: () => undefined },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.error).toContain('no PR payload denylist scanner');
      expect(r.result.error).toContain(r.probeDir);
      expect(r.result.error).toContain('nothing published');
    }
    expect(r.pushes.filter((args) => args.includes('push'))).toEqual([]);
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('the probe publication scanner is built from the PROBE root; a throw there releases the worktree and branch', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      defaultProbePublication: {
        probeScannerFor: () => {
          throw new Error('candidate cq.json unreadable');
        },
      },
    });
    expect(r.publicationProbeRoots).toEqual([r.probeDir]);
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the probe phase threw — candidate cq.json unreadable');
    expectAuthorUntouched(r);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('a probe publication scanner that records its root receives the tmp path', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      defaultProbePublication: {
        probeScannerFor: () => stubScanner(),
      },
    });
    // The factory ran against the probe checkout, not the author's: the
    // default leg bound and ran past the scanner gate (the harness fakes the
    // push, so the real pushed-head rule stops it after binding).
    expect(r.publicationProbeRoots).toEqual([r.probeDir]);
    expect(r.publicationProbeRoots[0]).not.toBe(repo.root);
    expect(r.result.status).toBe('needs-human');
    if (r.result.status === 'needs-human') {
      expect(r.result.reason).toContain('dev.cycle (pr.open)');
      expect(r.result.reason).toContain('never pushed');
    }
    expect(r.pushes.filter((args) => args.includes('push'))).not.toEqual([]);
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
  });

  test('a thrown probe check releases the worktree and branch with attribution', async () => {
    const r = await run({ greens: [true, false], stop: 'budget', probeThrows: 'ledger corrupt' });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed')
      expect(r.result.error).toContain('the probe phase threw — ledger corrupt');
    expectAuthorUntouched(r);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });

  test('a green probe that overruns the reserve publishes nothing', async () => {
    const r = await run({ greens: [true, false], stop: 'budget', probeAdvanceMs: 60 * 60 * 1000 });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.error).toContain('the probes overran the reserve');
      expect(r.result.error).toContain('nothing published');
    }
    expect(r.pushes.filter((args) => args.includes('push'))).toEqual([]);
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
  });

  test('a reserve exhausted MID-scan stops after the probed candidates and publishes nothing', async () => {
    // The first (red) probe consumes the whole reserve; the next is never started.
    const r = await run({
      greens: [true, false, false],
      stop: 'budget',
      probeAdvanceMs: 60 * 60 * 1000,
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.error).toContain('the reserve no longer covers a');
      expect(r.result.error).toContain('after probing 1 of 2 candidate(s)');
      expect(r.result.error).toContain('nothing published');
    }
    expect(r.probeRoots).toHaveLength(1);
    expect(r.opens).toEqual([]);
    expectAuthorUntouched(r);
  });

  test('an author HEAD that moves during the probe unbinds the selection: nothing published', async () => {
    const r = await run({
      greens: [true, false],
      stop: 'budget',
      onProbe: () => {
        repo.git('commit', '-q', '--allow-empty', '-m', 'the author moved on');
      },
    });
    expect(r.result.status).toBe('failed');
    if (r.result.status === 'failed') {
      expect(r.result.error).toContain(`the selected commit ${r.commits[0]!} lost its binding`);
      expect(r.result.error).toContain('nothing published');
    }
    expect(r.pushes.filter((args) => args.includes('push'))).toEqual([]);
    expect(r.opens).toEqual([]);
    expect(repo.git('branch', '--list', r.pub).trim()).toBe('');
  });
});
