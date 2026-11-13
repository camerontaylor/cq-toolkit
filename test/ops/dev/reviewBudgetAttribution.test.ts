import { afterEach, beforeEach, expect, test } from 'vitest';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import type { ManagedReviewSubmit } from '../../../src/ops/dev/managedReview.js';
import { stubScanner } from './fakes.js';
import { managedBlocked, managedRefused, managedTerminal } from './reviewTestKit.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';

/**
 * S2b-i: wall/cancellation attribution through the managed queue leg.
 *
 * The CLI path's #532/#534 rules map onto the managed leg as follows (the
 * queue wait replaces the CLI kill dimension — there is no process to kill,
 * only a receipt that arrives or a wait that refuses):
 *
 * - a completed TERMINAL receipt after the caller's wall expired is a budget
 *   stop: the (paid, in-hand) verdict records as a blocked cycle WITH its
 *   findings, carrying the budgetStopped envelope;
 * - an explicit blocked receipt verdict survives budget attribution like a
 *   CLI stream refusal: its own reason records, with no budget envelope;
 * - a cancelled submit (or an aborted wait) is the cancelled class, never a
 *   budget stop and never transient: nothing records, the deterministic
 *   request id lets a re-run rejoin the queue item;
 * - a wait refused by wall expiry without a receipt records nothing; its
 *   reason names the requestId rejoin.
 */

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
  {
    mode: 'terminal receipt with wall alive records terminal',
    submit: managedTerminal(),
    consumeWall: false,
    status: 'ok' as const,
    marked: false,
  },
  {
    mode: 'terminal receipt after wall expiry is a budget stop with findings kept',
    submit: managedTerminal(),
    consumeWall: true,
    status: 'needs-human' as const,
    marked: true,
  },
  {
    mode: 'blocked receipt after wall expiry keeps its own verdict',
    submit: managedBlocked('the queued review ended without a countable verdict'),
    consumeWall: true,
    status: 'needs-human' as const,
    marked: false,
  },
])('#532/managed: $mode', async ({ submit, consumeWall, status, marked }) => {
  let remaining = 1000;
  const wallConsumingSubmit: ManagedReviewSubmit = (async (input) => {
    // The queue wait consumed the whole wall; the receipt completed just
    // as it expired.
    if (consumeWall) remaining = 0;
    return submit(input);
  }) as ManagedReviewSubmit;
  const effects = repoEffects(repo);
  const result = await makeDevReview({
    effects,
    scanSecrets: stubScanner(),
    managedSubmit: wallConsumingSubmit,
    remainingWallMs: () => remaining,
  })({ repoRoot: repo.root });
  expect(result.status).toBe(status);
  if (marked) expect(result).toMatchObject({ report: { budgetStopped: true } });
  else expect(result).not.toMatchObject({ report: { budgetStopped: true } });
  const cycles = effects
    .openLedger('feature/x')
    .load()
    .records.filter((entry) => entry.kind === 'cycle');
  expect(cycles).toHaveLength(1);
  if (status === 'ok') expect(cycles[0]?.completion).toMatchObject({ kind: 'terminal' });
  else {
    expect(cycles[0]?.completion).toMatchObject({ kind: 'blocked' });
    if (marked) {
      expect(cycles[0]?.completion).toMatchObject({
        reason: expect.stringContaining('wall budget exhausted') as unknown,
      });
      expect(cycles[0]?.findings).toHaveLength(2);
    } else
      expect(cycles[0]?.completion).toMatchObject({
        reason: expect.stringContaining('without a countable verdict') as unknown,
      });
  }
  expect(effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(0);
});

test.each([
  {
    mode: 'parent cancellation with wall alive is cancelled, never a budget stop',
    wall: 1000,
    abortBeforeSubmit: true,
    submit: managedTerminal(),
    marked: false,
    recorded: false,
  },
  {
    mode: 'wall expiry without cancellation marks the completed receipt a budget stop',
    wall: 0,
    abortBeforeSubmit: false,
    submit: managedTerminal(),
    marked: true,
    recorded: true,
  },
  {
    mode: 'cancellation with wall expiry stays cancelled, never a budget stop',
    wall: 0,
    abortBeforeSubmit: true,
    submit: managedTerminal(),
    marked: false,
    recorded: false,
  },
])('#532/managed: $mode', async ({ wall, abortBeforeSubmit, submit, marked, recorded }) => {
  const controller = new AbortController();
  if (abortBeforeSubmit) controller.abort(new Error('parent cancelled review'));
  let submitted = false;
  const observingSubmit: ManagedReviewSubmit = (async (input) => {
    submitted = true;
    return submit(input);
  }) as ManagedReviewSubmit;
  const effects = repoEffects(repo);
  const result = await makeDevReview({
    effects,
    scanSecrets: stubScanner(),
    managedSubmit: observingSubmit,
    signal: controller.signal,
    remainingWallMs: () => wall,
  })({ repoRoot: repo.root });
  expect(result.status).toBe('needs-human');
  // Cancellation wins over the wall: an aborted run is the cancelled class
  // (mirroring the CLI path's `!signal?.aborted` guard), and the submit
  // leg never runs once the parent has cancelled.
  if (marked) expect(result).toMatchObject({ report: { budgetStopped: true } });
  else expect(result).not.toMatchObject({ report: { budgetStopped: true } });
  expect(result).not.toMatchObject({ report: { transient: true } });
  expect(submitted).toBe(!abortBeforeSubmit);
  const cycles = effects
    .openLedger('feature/x')
    .load()
    .records.filter((entry) => entry.kind === 'cycle');
  expect(cycles).toHaveLength(recorded ? 1 : 0);
  if (recorded) {
    expect(cycles[0]?.completion).toMatchObject({ kind: 'blocked' });
    expect(cycles[0]?.findings).toHaveLength(2);
  }
  expect(effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(0);
});

test.each([
  {
    mode: 'aborted wait without a receipt is cancelled, never transient',
    submit: (async () => ({
      status: 'refused',
      reason: 'review cancelled or wall budget exhausted while waiting for the queued review',
    })) as ManagedReviewSubmit,
    abortInSubmit: true,
  },
  {
    mode: 'explicit queue refusal without a verdict stays a plain refusal',
    submit: managedRefused('submit — the queue is full, retry the review'),
    abortInSubmit: false,
  },
])('#534/managed: $mode', async ({ submit, abortInSubmit }) => {
  const controller = new AbortController();
  const abortingSubmit: ManagedReviewSubmit = (async (input) => {
    if (abortInSubmit) controller.abort(new Error('review interrupted'));
    return submit(input);
  }) as ManagedReviewSubmit;
  const effects = repoEffects(repo);
  const result = await makeDevReview({
    effects,
    scanSecrets: stubScanner(),
    managedSubmit: abortingSubmit,
    signal: controller.signal,
    remainingWallMs: () => 1000,
  })({ repoRoot: repo.root });
  expect(result.status).toBe('needs-human');
  // The cancelled class never carries the budget-stop or the #509 network
  // class (mirroring the CLI path's guard): a re-run rejoins the same
  // queue item via the deterministic request id instead of retrying blind.
  expect(result).not.toMatchObject({ report: { budgetStopped: true } });
  expect(result).not.toMatchObject({ report: { transient: true } });
  const cycles = effects
    .openLedger('feature/x')
    .load()
    .records.filter((entry) => entry.kind === 'cycle');
  // Without a completed receipt there is no verdict to persist.
  expect(cycles).toHaveLength(0);
  expect(effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(0);
});

test.each(['queued', 'running', 'expired'] as const)(
  'bounded managed review without a completed receipt records nothing and names the rejoin when %s',
  async (mode) => {
    const controller = new AbortController();
    let submitted = false;
    const submit: ManagedReviewSubmit = (async (input) => {
      submitted = true;
      if (mode === 'queued') {
        // The cancel lands before the queue leg runs: the span's own guard
        // refuses before the submit dispatches.
        controller.abort(new Error('parent cancelled queued review'));
        input.signal?.throwIfAborted();
        throw new Error('unreachable');
      }
      if (mode === 'running') {
        // The cancel lands mid-wait: the wait refuses with no receipt.
        controller.abort(new Error('parent cancelled running review'));
        return {
          status: 'refused',
          reason: 'review cancelled or wall budget exhausted while waiting for the queued review',
        };
      }
      // The wall expired mid-wait with no receipt: the refusal names the
      // deterministic request id so the re-run rejoins the same queue item.
      return {
        status: 'refused',
        reason: `the queued review did not complete within the wall budget (still 'running') — re-run review.submit with requestId=dev-${input.base.slice(0, 8)}-${input.head.slice(0, 8)} to rejoin it`,
      };
    }) as ManagedReviewSubmit;
    const effects = repoEffects(repo);
    const result = await makeDevReview({
      effects,
      scanSecrets: stubScanner(),
      managedSubmit: submit,
      signal: controller.signal,
      remainingWallMs: () => (mode === 'expired' ? 0 : 1000),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    if (mode === 'expired')
      expect(result).toMatchObject({
        reason: expect.stringContaining('to rejoin it') as unknown,
      });
    else expect(result).toMatchObject({ reason: expect.stringContaining('cancel') as unknown });
    expect(result).not.toMatchObject({ report: { budgetStopped: true } });
    expect(result).not.toMatchObject({ report: { transient: true } });
    const cycles = effects
      .openLedger('feature/x')
      .load()
      .records.filter((entry) => entry.kind === 'cycle');
    // No receipt, no verdict: without a completed review nothing records —
    // the queue (not the CLI) is the only launch route, so no partial
    // stdout findings exist to persist either.
    expect(cycles).toHaveLength(0);
    expect(effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(0);
    expect(submitted).toBe(true);
  },
);
