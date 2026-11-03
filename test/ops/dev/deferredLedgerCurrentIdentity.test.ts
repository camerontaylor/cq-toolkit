import { expect, test } from 'vitest';
import { makeSubprocessDevEffects, type CommandResult } from '../../../src/ops/dev/effects.js';
import {
  loadCurrentDeferredVendorDebt,
  prepareDeferredVendorReview,
} from '../../../src/ops/dev/internal/deferredLedger.js';
import type { DeferredQueueClient } from '../../../src/ops/review/internal/queueProtocol.js';
import {
  fixture,
  adapterAborted,
  adapterTimedOut,
  currentIdentityFixture,
} from './deferredLedgerHelpers.js';

test('current identity commands share the queue lifetime and remaining budget without ancestors', async () => {
  const t = await currentIdentityFixture();
  const calls: Parameters<typeof t.f.effects.runCommand>[] = [];
  let queueSignal: AbortSignal | undefined;
  const effects = {
    ...t.f.effects,
    runCommand: async (...call: Parameters<typeof t.f.effects.runCommand>) => {
      if (call[0] === 'git') calls.push(call);
      return t.f.effects.runCommand(...call);
    },
  };
  const client: DeferredQueueClient = {
    ...t.f.client,
    status: async (reference, options) => {
      queueSignal = options?.signal;
      return t.f.client.status(reference, options);
    },
  };
  const debt = await loadCurrentDeferredVendorDebt(
    effects,
    'main',
    t.f.state,
    t.before,
    client,
    undefined,
    { remainingMs: () => 5_000 },
  );
  expect(debt?.reference).toEqual(t.f.debt.reference);
  expect(queueSignal).toBeDefined();
  expect(calls.length).toBeGreaterThanOrEqual(6);
  for (const call of calls) {
    expect(call[2].signal).toBe(queueSignal);
    expect(call[2].timeoutMs).toBeLessThanOrEqual(5_000);
  }
  await t.unchanged();
});
for (const outcome of ['budget', 'timeout', 'caller-error', 'caller-object'] as const) {
  test(`current identity ${outcome} is hard with no ancestors and preserves the reason`, async () => {
    const t = await currentIdentityFixture();
    const controller = new AbortController();
    const reason =
      outcome === 'caller-object'
        ? { cancelled: 'current identity' }
        : new Error('current identity cancelled');
    let exhausted = false;
    let interrupted = false;
    const effects = {
      ...t.f.effects,
      runCommand: async (...call: Parameters<typeof t.f.effects.runCommand>) => {
        if (call[0] === 'git' && call[1].includes('symbolic-ref') && outcome !== 'budget') {
          interrupted = true;
          if (outcome === 'timeout') {
            exhausted = true;
            return adapterTimedOut();
          }
          controller.abort(reason);
          return adapterAborted();
        }
        const result = await t.f.effects.runCommand(...call);
        if (call[0] === 'git' && call[1].includes('ls-files')) {
          exhausted = true;
          interrupted = true;
        }
        return result;
      },
    };
    const pending = loadCurrentDeferredVendorDebt(
      effects,
      'main',
      t.f.state,
      t.before,
      t.f.client,
      controller.signal,
      { remainingMs: () => (exhausted ? 0 : 5_000) },
    );
    if (outcome.startsWith('caller')) await expect(pending).rejects.toBe(reason);
    else await expect(pending).rejects.toThrow('queue delivery unknown: deadline exhausted');
    expect(interrupted).toBe(true);
    await t.unchanged();
  });
}
test('the real internal timer interrupts current identity work as a hard deadline without ancestors', async () => {
  const t = await currentIdentityFixture();
  let dispatched: Parameters<typeof t.f.effects.runCommand>[2] | undefined;
  let timerResult: CommandResult | undefined;
  let timerReason: unknown;
  const effects = {
    ...t.f.effects,
    runCommand: async (...call: Parameters<typeof t.f.effects.runCommand>) => {
      if (call[0] !== 'git' || !call[1].includes('symbolic-ref'))
        return t.f.effects.runCommand(...call);
      dispatched = call[2];
      // The parent has no signal. Refuse the fixture dispatch instead of starting an orphan.
      if (!call[2].signal) return adapterAborted();
      timerResult = await makeSubprocessDevEffects(t.f.repo.root).runCommand(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { timeoutMs: 10_000, signal: call[2].signal },
      );
      timerReason = call[2].signal.reason;
      return timerResult;
    },
  };
  const caught: unknown = await loadCurrentDeferredVendorDebt(
    effects,
    'main',
    t.f.state,
    t.before,
    t.f.client,
    undefined,
    { remainingMs: () => 2_000 },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  // All proof assertions stay outside readWorkState's error folding.
  expect(timerReason).toBeInstanceOf(Error);
  expect(caught).toBe(timerReason);
  expect(dispatched?.signal?.aborted).toBe(true);
  expect(dispatched?.timeoutMs).toBeLessThanOrEqual(2_000);
  expect(timerResult?.interruption?.kind).toBe('abort');
  expect(timerResult?.interruption?.reason).toBe(timerReason);
  await t.unchanged();
});
test('preparation persistence uses its existing lifetime for every identity command', async () => {
  const f = await fixture();
  f.effects.openLedger(f.state.branch).save({
    ...f.ledger,
    records: f.ledger.records.filter((record) => record.kind !== 'vendor-debt'),
  });
  const calls: Parameters<typeof f.effects.runCommand>[] = [];
  const effects = {
    ...f.effects,
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      if (call[0] === 'git') calls.push(call);
      return f.effects.runCommand(...call);
    },
  };
  const debt = await prepareDeferredVendorReview(effects, 'main', f.state, f.client, undefined, {
    remainingMs: () => 5_000,
  });
  expect(debt).toBeDefined();
  expect(calls.length).toBeGreaterThanOrEqual(12);
  const signal = calls[0]?.[2].signal;
  expect(signal).toBeDefined();
  for (const call of calls) {
    expect(call[2].signal).toBe(signal);
    expect(call[2].timeoutMs).toBeLessThanOrEqual(5_000);
  }
});
