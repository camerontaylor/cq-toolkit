import { expect, test } from 'vitest';
import { makeSubprocessDevEffects, type CommandResult } from '../../../src/ops/dev/effects.js';
import { loadCurrentDeferredVendorDebt } from '../../../src/ops/dev/internal/deferredLedger.js';
import { assembleReadiness } from '../../../src/ops/dev/record.js';
import type { QueueReference } from '../../../src/ops/review/internal/queueProtocol.js';
import { adapterAborted, ancestryIdentityFixture } from './deferredLedgerHelpers.js';

for (const field of ['branch', 'head', 'base', 'dirty'] as const) {
  test(`a successful changed ${field} at deadline rejects before truncation`, async () => {
    const t = await ancestryIdentityFixture();
    let exhausted = false;
    t.seam.run = async (...call) => {
      const result = await t.f.effects.runCommand(...call);
      if (field === 'branch' && call[1].includes('symbolic-ref'))
        result.stdout = 'refs/heads/another-branch\n';
      if (field === 'head' && call[1].includes('rev-parse') && call[1].at(-1) === 'HEAD')
        result.stdout = 'a'.repeat(40) + '\n';
      if (field === 'base' && call[1].at(-1) === `${t.read.state.base}^{commit}`)
        result.stdout = 'b'.repeat(40) + '\n';
      // Exhaust ONLY at the final command: every component was successfully read, so the
      // mismatch cannot be hidden by an earlier pre-dispatch refusal.
      if (call[1].includes('ls-files')) {
        if (field === 'dirty') result.stdout = 'unexpected-untracked.ts\0';
        exhausted = true;
      }
      return result;
    };
    await expect(
      loadCurrentDeferredVendorDebt(
        t.effects,
        'main',
        t.read.state,
        t.before,
        t.client,
        undefined,
        { remainingMs: () => (exhausted ? 0 : 5_000) },
      ),
    ).rejects.toThrow('deferred invocation identity changed while settling authorized ancestry');
    expect(exhausted).toBe(true);
    await t.unchanged();
  });
}
for (const outcome of ['nonzero', 'spawn', 'untagged-kill', 'foreign-abort'] as const) {
  test(`an unrelated ${outcome} identity failure at deadline stays hard`, async () => {
    const t = await ancestryIdentityFixture();
    let exhausted = false;
    t.seam.run = async () => {
      exhausted = true;
      if (outcome === 'spawn') throw new Error('git spawn failed');
      if (outcome === 'nonzero')
        return { exitCode: 128, stdout: '', stderr: 'unrelated Git failure', timedOut: false };
      if (outcome === 'foreign-abort')
        return {
          ...adapterAborted(),
          interruption: { kind: 'abort', reason: new Error('another operation') },
        };
      return adapterAborted();
    };
    await expect(
      loadCurrentDeferredVendorDebt(
        t.effects,
        'main',
        t.read.state,
        t.before,
        t.client,
        undefined,
        { remainingMs: () => (exhausted ? 0 : 5_000) },
      ),
    ).rejects.toThrow('deferred invocation identity changed while settling authorized ancestry');
    await t.unchanged();
  });
}
for (const callerReason of [
  undefined,
  new Error('caller after timer'),
  { cancelled: 'caller after timer' },
]) {
  test(`the internal timer during identity read preserves ${callerReason === undefined ? 'own truncation' : typeof callerReason === 'object' && callerReason instanceof Error ? 'the caller Error' : 'the caller object'}`, async () => {
    const t = await ancestryIdentityFixture();
    const controller = new AbortController();
    let timerReason: unknown;
    let timerResult: CommandResult | undefined;
    let dispatched:
      | { args: readonly string[]; timeoutMs: number; signal?: AbortSignal }
      | undefined;
    t.seam.run = async (_command, args, options) => {
      dispatched = { args, ...options };
      const signal = options.signal;
      if (!signal) throw new Error('identity command has no invocation signal');
      // Use the REAL subprocess adapter. Its longer test-only child cap makes the invocation's
      // actual internal timer win deterministically; the seam's clamped input is asserted above.
      // No remainingMs flip or synthetic abort metadata supplies the positive evidence.
      const result = await makeSubprocessDevEffects(t.f.repo.root).runCommand(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { timeoutMs: 10_000, signal },
      );
      timerReason = signal.reason;
      timerResult = result;
      if (callerReason !== undefined) controller.abort(callerReason);
      return result;
    };
    const pending = loadCurrentDeferredVendorDebt(
      t.effects,
      'main',
      t.read.state,
      t.before,
      t.client,
      controller.signal,
      { remainingMs: () => 2_000 },
    );
    if (callerReason !== undefined) await expect(pending).rejects.toBe(callerReason);
    else {
      const debt = await pending;
      expect(debt?.reference.requestId).toBe(t.successor.reference.requestId);
      if (!debt) throw new Error('missing current enrollment');
      const readiness = assembleReadiness({
        branch: t.f.state.branch,
        target: 'main',
        identity: t.read.state,
        ledger: t.before,
        untracked: [],
        deferredVendorDebt: debt,
        nowIso: t.f.effects.nowIso(),
      });
      expect(readiness.ready).toBe(false);
      if (readiness.ready) throw new Error('unexpected readiness');
      expect(
        readiness.gaps.some((gap) => gap.detail.includes('authorized predecessor obligation')),
      ).toBe(true);
    }
    // These assertions live OUTSIDE readWorkState's fault-folding boundary: a swallowed assertion
    // in the adapter seam must never count as proof that the real internal timer fired.
    expect(dispatched?.args).toContain('symbolic-ref');
    expect(dispatched?.timeoutMs).toBeLessThanOrEqual(2_000);
    expect(dispatched?.signal?.aborted).toBe(true);
    expect(timerResult?.interruption?.kind).toBe('abort');
    expect(timerResult?.interruption?.reason).toBe(timerReason);
    expect(timerReason).toBeInstanceOf(Error);
    await t.unchanged();
  });
}
test('an already cancelled caller outranks an initially zero budget', async () => {
  const t = await ancestryIdentityFixture();
  const controller = new AbortController();
  const reason = { cancelled: 'before entry' };
  controller.abort(reason);
  await expect(
    loadCurrentDeferredVendorDebt(
      t.effects,
      'main',
      t.read.state,
      t.before,
      t.client,
      controller.signal,
      { remainingMs: () => 0 },
    ),
  ).rejects.toBe(reason);
  await t.unchanged();
});
for (const cancel of [false, true]) {
  test(`source queue options retain one lifetime and observer, cancelled=${String(cancel)}`, async () => {
    const t = await ancestryIdentityFixture();
    const controller = new AbortController();
    const reason = { cancelled: 'during report' };
    const actions: string[] = [];
    let sourceOptions: { signal?: AbortSignal; remainingMs?: () => number } | undefined;
    const observer = async () => {
      actions.push('observer');
    };
    const client = {
      ...t.client,
      status: async (
        ref: QueueReference,
        options?: { signal?: AbortSignal; remainingMs?: () => number },
      ) => {
        expect(options?.signal).toBeDefined();
        expect(options?.remainingMs?.()).toBeGreaterThan(0);
        if (sourceOptions) {
          expect(options?.signal).toBe(sourceOptions.signal);
          expect(options?.remainingMs).toBe(sourceOptions.remainingMs);
        } else sourceOptions = options;
        return t.client.status(ref);
      },
      report: async (
        ref: QueueReference,
        root: string,
        options?: {
          signal?: AbortSignal;
          remainingMs?: () => number;
          onEvidenceImported?: (evidence: { receiptId: string; path: string }) => Promise<void>;
        },
      ) => {
        expect(options?.signal).toBe(sourceOptions?.signal);
        expect(options?.remainingMs).toBe(sourceOptions?.remainingMs);
        expect(options?.onEvidenceImported).toBe(observer);
        const evidence = await t.client.report(ref, root);
        actions.push('import');
        if (cancel) controller.abort(reason);
        options?.signal?.throwIfAborted();
        await options?.onEvidenceImported?.({ receiptId: evidence.receiptId, path: root });
        actions.push('ack');
        return evidence;
      },
    };
    const pending = loadCurrentDeferredVendorDebt(
      t.effects,
      'main',
      t.read.state,
      t.before,
      client,
      controller.signal,
      { remainingMs: () => 5_000, onEvidenceImported: observer },
    );
    if (cancel) {
      await expect(pending).rejects.toBe(reason);
      expect(actions).toEqual(['import']);
      await t.unchanged();
    } else {
      expect((await pending)?.reference.requestId).toBe(t.successor.reference.requestId);
      expect(actions).toEqual(['import', 'observer', 'ack']);
    }
  });
}
