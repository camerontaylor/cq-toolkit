import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { followUpCommand, makeDevCycle } from '../../../src/ops/dev/cycle.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { PrOpenInput } from '../../../src/ops/pr/open.js';
import { cycleRecord, checkRecord } from './fakes.js';
import { DEV_LEDGER_VERSION as seedLedgerVersion } from '../../../src/ops/dev/record.js';
import { makeTestRepo, repoEffects, seed, type TestRepo } from './repo.js';
import {
  addressReport,
  bindCycleRepo,
  capFinding,
  cleanAddress,
  cleanReview,
  greenCheck,
  openFake,
  roundCapAddress,
  seedReadyLedger,
  stubM7Scanner,
} from './cycle.helpers.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
  bindCycleRepo(repo);
});
afterEach(async () => {
  await repo.cleanup();
});

const effects: () => DevEffects = () => repoEffects(repo);

describe('dev.cycle', () => {
  test('BEFORE (P1): a BLOCKED RE-REVIEW with a report propagates verbatim — NO push, NO PR', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    let pushCalls = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: async () => ({
        status: 'needs-human',
        reason:
          'review.address: re-review: review.run: not every configured reviewer completed a terminal cycle; report: /tmp/r.json',
        report: addressReport(state, [capFinding], []),
      }),
      open: openFake(opens),
      git: async (args) => {
        if (args.includes('push')) pushCalls++;
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('not every configured reviewer completed');
    expect(pushCalls).toBe(0);
    expect(opens).toEqual([]);
  });

  test('BEFORE (P1): an ADMISSION FAILURE with a report propagates verbatim — NO push, NO PR', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const opens: PrOpenInput[] = [];
    let pushCalls = 0;
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: async () => ({
        status: 'needs-human',
        reason:
          'review.address: engine bookkeeping changed; worker tree is dirty; report: /tmp/r.json',
        report: addressReport(state, [capFinding], []),
      }),
      open: openFake(opens),
      git: async (args) => {
        if (args.includes('push')) pushCalls++;
        return { code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('engine bookkeeping changed');
    expect(pushCalls).toBe(0);
    expect(opens).toEqual([]);
  });

  test('BEFORE (P2 7kNi): the injected driver factory reaches the address leg', async () => {
    // The address leg runs its fail-closed denylist scan BEFORE resolving
    // any driver role; CI's coverage runner has no gitleaks binary, so the
    // probe binds the SAME hermetic gitleaks fixture the e2e address tests
    // use (process-backed clean scanner, never a production override).
    const scanner = await stubM7Scanner();
    try {
      await runProbe();
    } finally {
      vi.unstubAllEnvs();
      await scanner();
    }

    async function runProbe(): Promise<void> {
      const state = await seed(repo);
      await seedReadyLedger(state);
      // The address leg reads cq.json and the LATEST findings record before
      // resolving any driver role; give the fixture a minimal config and a
      // seeded record at the CURRENT head so the leg gets past both to its
      // first factory resolve.
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'probe-check', args: [] } }],
          roles: {
            worker: { provider: 'fixture', model: 'probe-worker' },
            reviewer: { provider: 'fixture', model: 'probe-reviewer' },
          },
          budgets: { run: { maxTokens: 1000, wallMs: 20000 }, step: { wallMs: 5000 } },
          review: { reviewers: ['agent'], rounds: 1 },
        }),
      );
      await repo.write(
        '.cq/review/feature%2Fx/1.json',
        JSON.stringify({
          schemaVersion: 1,
          branch: state.branch,
          head: 'FRESH_HEAD',
          reviewed: { base: state.base, scope: 'full' },
          sources: [{ kind: 'agent', status: 'terminal' }],
          // One OPEN blocking finding: an empty record short-circuits to
          // admitCleanRecord BEFORE any worker resolves, which would never
          // reach the injected factory.
          findings: [
            {
              id: 'probe-f1',
              source: 'agent',
              file: 'src/a.ts',
              severity: 'major',
              text: 'probe: the factory must resolve the worker',
              status: 'open',
            },
          ],
        }),
      );
      repo.commitAll('probe config');
      repo.git('push', '-q', 'origin', 'feature/x');
      await seedReadyLedger(state);
      // The record must name the CURRENT head (the config commit moved it).
      const finalHead = repo.git('rev-parse', 'HEAD').trim();
      const recordText = await import('node:fs/promises').then((fs) =>
        fs.readFile(`${repo.root}/.cq/review/feature%2Fx/1.json`, 'utf8'),
      );
      await repo.write(
        '.cq/review/feature%2Fx/1.json',
        recordText.replace('FRESH_HEAD', finalHead),
      );
      // Probe: the injected factory is FORWARDED into the address leg's own
      // review construction (reviewDrivers wraps deps.drivers). The probe
      // factory RESOLVES with a driver whose run throws a marker; the re-review
      // inside the address leg therefore fails with 'agent review did not run:
      // <marker>' — the leg used the caller's wiring, not a real provider
      // factory. (Without forwarding, the default construction would resolve a
      // real provider and fail with a config error instead.)
      let resolveCalls = 0;
      const observingFactory: DriverFactory = {
        resolve: (request) => {
          resolveCalls++;
          void request;
          return {
            lane: 'ai-sdk' as const,
            modelSpec: { provider: 'probe', model: 'probe' },
            driver: {
              run: async () => {
                throw new Error('probe: the address leg ran the injected factory');
              },
            },
          };
        },
      };
      const op = makeDevCycle({
        effects: effects(),
        check: greenCheck(),
        review: cleanReview(state),
        open: openFake([]),
        drivers: observingFactory,
      });
      const result = await op({ repoRoot: repo.root });
      expect(result.status === 'failed' || result.status === 'needs-human').toBe(true);
      // The wiring observable: the injected factory's resolve() was CALLED by
      // the address leg's own review construction (reviewDrivers wraps the
      // forwarded factory). Without the forward, the leg would construct a
      // real provider factory and this probe would never resolve.
      expect(resolveCalls).toBeGreaterThan(0);
      // The leg's own re-review ran through the probe and failed honestly (the
      // marker lands in the blocked findings record's source reason, which
      // review.run summarizes); the composition surfaced that re-review
      // refusal verbatim instead of a provider-config error.
      expect(result.status === 'needs-human' && result.reason).toContain('re-review');
    }
  });

  test('BEFORE (P2 7kNl): the follow-up command carries the quoted repoRoot', () => {
    expect(followUpCommand(7, '/tmp/my repo')).toBe(
      `cq review.address --repoRoot='${'/tmp/my repo'}' --source=pr:7`,
    );
    expect(followUpCommand(7, '/plain/path')).toBe(
      "cq review.address --repoRoot='/plain/path' --source=pr:7",
    );
  });

  test('P2 v9bK7: the follow-up command carries a NON-DEFAULT target, quoted; the default is omitted', () => {
    expect(followUpCommand(7, '/repo', 'release')).toBe(
      "cq review.address --repoRoot='/repo' --target='release' --source=pr:7",
    );
    expect(followUpCommand(7, '/repo', "o'brien-queue")).toBe(
      "cq review.address --repoRoot='/repo' --target='o'\\''brien-queue' --source=pr:7",
    );
    // The default target changes nothing about the comparison: omit it.
    expect(followUpCommand(7, '/repo', 'main')).toBe(
      "cq review.address --repoRoot='/repo' --source=pr:7",
    );
    expect(followUpCommand(7, '/repo')).toBe("cq review.address --repoRoot='/repo' --source=pr:7");
  });

  test('P2 v9bK7 (e2e): a non-default --target flows into the published report and the cap reason', async () => {
    await seed(repo);
    repo.git('push', '-q', 'origin', 'origin/main:refs/heads/release');
    repo.git('fetch', '-q', 'origin');
    repo.git('push', '-q', 'origin', 'feature/x');
    // Records must be pinned to the RELEASE target (readiness refuses records
    // recorded for another target). The open leg captures the target it was
    // called with; the clean address leg ends ok, so the READY path runs.
    const opens: PrOpenInput[] = [];
    const state2 = await seed(repo, () => []);
    const at = { base: state2.base, head: state2.head, dirtySha256: state2.dirtySha256 };
    const records = [
      cycleRecord({ ...at, target: 'release' }),
      checkRecord({ ...at, target: 'release' }),
    ];
    repoEffects(repo)
      .openLedger(state2.branch)
      .save({ version: seedLedgerVersion, branch: state2.branch, records });
    const pushes: string[][] = [];
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state2),
      address: cleanAddress(state2),
      open: openFake(opens, 46),
      git: async (args) => {
        if (args.includes('push')) pushes.push([...args]);
        return { code: 0, stdout: `${state2.head}\trefs/heads/feature/x\n`, stderr: '' };
      },
    });
    const result = await op({ repoRoot: repo.root, target: 'release' });
    expect(result.status).toBe('ok');
    // The publication names the EXACT head readiness read, never the branch
    // ref: a branch moving between the read and the push uploads nothing else.
    expect(pushes).toEqual([
      ['-C', repo.root, 'push', 'origin', `${state2.head}:refs/heads/feature/x`],
    ]);
    if (result.status === 'ok') {
      expect(opens[0]?.target).toBe('release');
      expect(result.value.followUp).toBe(followUpCommand(46, repo.root, 'release'));
      expect(result.value.followUp).toContain("--target='release'");
    }
  });

  test('P2 v9bK8: the cap path PRESERVES a failed publication (never converted to needs-human)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: roundCapAddress(state),
      open: async () => ({
        status: 'failed',
        error: 'pr.open: the PR could not be opened — gh: 502',
      }),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root });
    // The same forge failure must produce the same status as on the clean
    // path: failed (exit 1), not needs-human (exit 3).
    expect(result.status).toBe('failed');
    if (result.status === 'failed')
      expect(result.error).toBe(
        'dev.cycle (pr.open): pr.open: the PR could not be opened — gh: 502',
      );
  });

  test('P2 v9bK8: the cap path PRESERVES an indeterminate publication (never erased)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: roundCapAddress(state),
      open: async () => ({
        status: 'indeterminate',
        detail: 'pr.open: the creation outcome is uncertain — the forge answered 529',
      }),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate')
      expect(result.detail).toContain('the creation outcome is uncertain');
  });

  test('P2 v9bK9: with an injected open and NO gh, the cap path performs NO production-gh body edit (the injected leg owns the forge)', async () => {
    const state = await seed(repo);
    await seedReadyLedger(state);
    // The production gh effects would run `gh` against input.repoRoot; the
    // fixture repo has no remote/gh config, so any production call would
    // fail loudly. Assert instead on the pure structural fact: the compose
    // never runs (no getPrBody possible), and the op still publishes the
    // draft reason.
    const op = makeDevCycle({
      effects: effects(),
      check: greenCheck(),
      review: cleanReview(state),
      address: roundCapAddress(state),
      open: openFake([]),
      git: async () => ({ code: 0, stdout: `${state.head}\trefs/heads/feature/x\n`, stderr: '' }),
      // NO gh injected: the injected open owns the forge.
    });
    const result = await op({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('NOT READY');
      expect(result.reason).toContain('draft PR #42');
      // No '(pr body)' fault: the composition never touched a forge.
      expect(result.reason).not.toContain('pr body');
      // The report IS present (the cap leg attaches its envelope), but with
      // no gh the compose never ran — the reason must NOT claim the attempt
      // log was published (the findingsComposed gate).
      expect(result.reason).not.toContain('and the attempt log');
    }
  });
});
