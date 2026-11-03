import { afterEach, beforeEach, expect, test } from 'vitest';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { stubScanner } from './fakes.js';
import { ran, reviewer } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});
// ---------------------------------------------------------------------------
// Late-thread hardening: exact-byte identity hashing, binary blob scanning,
// and the post-run drift refusal.
// ---------------------------------------------------------------------------

test.each([
  ['error', { type: 'error', message: 'auth_required' }, 'error event'],
  ['action', { type: 'action_required', status: 'awaiting_confirmation' }, 'requested action'],
  ['skipped', { type: 'complete', status: 'review_skipped' }, 'review_skipped'],
  [
    'no-fresh',
    {
      type: 'complete',
      status: 'review_completed',
      message: 'No fresh detailed file review was performed in this run.',
    },
    'no-fresh/skipped notice',
  ],
  ['clean', { type: 'heartbeat', status: 'reviewing' }, 'wall budget exhausted'],
] as const)(
  '#532: killed deadline reviewer preserves %s stream refusal before budget attribution',
  async (mode, event, reason) => {
    let remaining = 1000;
    const effects = repoEffects(
      repo,
      reviewer(() => {
        remaining = 0;
        return ran(null, JSON.stringify(event), { timedOut: true });
      }),
    );
    const result = await makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      remainingWallMs: () => remaining,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(result).toMatchObject({ reason: expect.stringContaining(reason) as unknown });
    if (mode === 'clean') expect(result).toMatchObject({ report: { budgetStopped: true } });
    else expect(result).not.toMatchObject({ report: { budgetStopped: true } });
    const cycles = effects
      .openLedger('feature/x')
      .load()
      .records.filter((entry) => entry.kind === 'cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.completion).toMatchObject({
      kind: 'blocked',
      reason: expect.stringContaining(reason) as unknown,
    });
  },
);

test.each([
  ['parent cancellation', 'terminal', true, 1000, false],
  ['parent cancellation', 'killed', true, 1000, false],
  ['wall expiry', 'terminal', false, 0, true],
  ['wall expiry', 'killed', false, 0, true],
  ['cancellation and wall expiry', 'terminal', true, 0, true],
  ['cancellation and wall expiry', 'killed', true, 0, true],
] as const)(
  '#532: %s with a %s CLI uses one wall sample for budget attribution',
  async (_mode, cli, cancel, wall, marked) => {
    const controller = new AbortController();
    let dispatched = false;
    let completionSamples = 0;
    let completionRecorded = false;
    const effects = repoEffects(
      repo,
      reviewer(() => {
        dispatched = true;
        if (cancel) controller.abort(new Error('parent cancelled reviewer'));
        return cli === 'terminal'
          ? ran(0)
          : ran(null, JSON.stringify({ type: 'heartbeat', status: 'reviewing' }), {
              timedOut: true,
            });
      }),
    );
    const writeReviewLog = effects.writeReviewLog;
    effects.writeReviewLog = async (...args) => {
      completionRecorded = true;
      return writeReviewLog(...args);
    };
    const result = await makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      signal: controller.signal,
      remainingWallMs: () => {
        if (!dispatched) return 1000;
        // Transient classification after the log keeps its independent wall read.
        if (completionRecorded) return wall;
        completionSamples++;
        // A later sample would disagree: attribution and completion must share one.
        return completionSamples === 1 ? wall : wall === 0 ? 1000 : 0;
      },
    })({ repoRoot: repo.root });
    expect(completionSamples).toBe(1);
    expect(result.status).toBe('needs-human');
    if (marked) expect(result).toMatchObject({ report: { budgetStopped: true } });
    else expect(result).not.toMatchObject({ report: { budgetStopped: true } });
    const cycles = effects
      .openLedger('feature/x')
      .load()
      .records.filter((entry) => entry.kind === 'cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.completion).toMatchObject({ kind: 'blocked' });
  },
);

test.each([
  ['wall deadline abort', 0, true, false, true],
  ['parent abort before deadline', 1000, true, false, false],
  ['null exit without interruption', 0, false, false, false],
  ['explicit refusal before wall deadline abort', 0, true, true, false],
] as const)(
  '#534: %s attributes budget stops only to an interrupted reviewer without a refusal',
  async (_mode, wall, interrupted, refused, marked) => {
    const controller = new AbortController();
    let remaining = 1000;
    const effects = repoEffects(
      repo,
      reviewer(() => {
        remaining = wall;
        if (interrupted) controller.abort(new Error('review interrupted'));
        return ran(
          null,
          JSON.stringify(
            refused
              ? { type: 'error', message: 'auth_required' }
              : { type: 'heartbeat', status: 'reviewing' },
          ),
          {
            timedOut: false,
            ...(interrupted
              ? { interruption: { kind: 'abort' as const, reason: controller.signal.reason } }
              : {}),
          },
        );
      }),
    );
    const result = await makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      signal: controller.signal,
      remainingWallMs: () => remaining,
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (marked) expect(result).toMatchObject({ report: { budgetStopped: true } });
    else expect(result).not.toMatchObject({ report: { budgetStopped: true } });
    const cycles = effects
      .openLedger('feature/x')
      .load()
      .records.filter((entry) => entry.kind === 'cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.completion).toMatchObject({ kind: 'blocked' });
    if (refused)
      expect(cycles[0]?.completion).toMatchObject({
        reason: expect.stringContaining('error event') as unknown,
      });
  },
);

test.each(['queued', 'running', 'expired'] as const)(
  'bounded review persists blocked evidence when %s without a completed review',
  async (mode) => {
    const repo = await makeTestRepo();
    try {
      const controller = new AbortController();
      let remaining = 1000;
      const effects = repoEffects(
        repo,
        reviewer(() => {
          if (mode === 'running') controller.abort(new Error('parent cancelled running reviewer'));
          if (mode === 'expired') remaining = 0;
          return ran(0);
        }),
      );
      if (mode === 'queued') {
        // The Q4 reuse check acquires the host lock FIRST; a queued cancel
        // must land in the vendor span's own guard so the pre-existing
        // blocked-evidence persistence (#534) is what the assertions below
        // verify. Pass the reuse acquisition through uncancelled.
        let locks = 0;
        effects.withHostLock = async (fn, signal) => {
          locks += 1;
          if (locks === 1) return fn();
          expect(signal).toBe(controller.signal);
          controller.abort(new Error('parent cancelled queued review'));
          signal!.throwIfAborted();
          throw new Error('unreachable');
        };
      }
      const run = effects.runCommand;
      effects.runCommand = async (command, args, opts) => {
        if (command === 'coderabbit') {
          expect(opts.timeoutMs).toBe(1000);
          expect(opts.signal).toBe(controller.signal);
        }
        return run(command, args, opts);
      };
      const result = await makeDevReview({
        effects,
        scanSecrets: stubScanner(),
        signal: controller.signal,
        remainingWallMs: () => remaining,
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      const cycles = effects
        .openLedger('feature/x')
        .load()
        .records.filter((entry) => entry.kind === 'cycle');
      expect(cycles).toHaveLength(1);
      expect(cycles[0]?.completion).toMatchObject({ kind: 'blocked' });
      expect(effects.logs.join(' ')).toMatch(mode === 'queued' ? /cancel/ : /stdout/);
      expect(cycles[0]?.findings).toHaveLength(mode === 'queued' ? 0 : 2);
      expect(effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(
        mode === 'queued' ? 0 : 1,
      );
    } finally {
      await repo.cleanup();
    }
  },
);
