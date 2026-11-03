// Analyze lane G2 — test evidence for the sidecar contract: the four
// acceptance behaviors (missing sidecar → clear error; missing approval →
// needs-human refusal; overlapping planned edits → the whole apply blocked;
// dry-run shows the diffs and writes nothing), the stale-sidecar detection
// (analysis-time digests vs current bytes), the unknown-cluster fault, the
// empty-plan honesty, and the PINNED order of operations (staleness is
// checked before approval; approval before any scan). The sidecar under
// test is the real render op's output format; the runner and store are
// injected fakes — no ast-grep binary, no real fs.
//
// Split provenance: test/ops/analyze/applyRemediation.test.ts was split into
// six subject test files in this directory and a shared fixture module:
// applyRemediation.sidecarContract.test.ts,
// applyRemediation.collidingClusterIds.test.ts,
// applyRemediation.storeRelativePaths.test.ts,
// applyRemediation.applyAcceptance.test.ts,
// applyRemediation.approvalBoundary.test.ts and
// applyRemediation.helpers.ts.
import { describe, expect, test } from 'vitest';
import type { MutationLocks } from '../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
} from '../../../src/ops/analyze/approval.js';
import {
  FIXTURE_FILES,
  approvedStore,
  baseInput,
  codemodRunner,
  makeOp,
} from './applyRemediation.helpers.js';

// A lock fault's report must not assert a fact it cannot know. The exercise
// happens INSIDE the mutation lock, so an ACQUIRE fault has not spent the
// token while a RELEASE/COMPROMISE fault has. The first version of the
// handler said "already EXERCISED, so the token is spent" for every fault,
// which is false for the acquire case.
describe('W4.3 a lock fault reports the token fate the phase allows', () => {
  test('release failure preserves an already-spent exercise denial without claiming UNSPENT', async () => {
    const store = approvedStore();
    const ledger = makeInMemoryNonceLedger();
    const nonce = '7'.repeat(32);
    await ledger.consume(nonce);
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: () =>
          Promise.resolve({
            nonce,
            state: { workspace: '/ws', headSha: 'head', treeClean: true },
          }),
      },
      ledger,
      locks: {
        forWorkspace: () => ({
          withLock: async <T>(fn: () => T | Promise<T>): Promise<T> => {
            await fn();
            throw new Error('release failed after denial');
          },
        }),
      },
      readState: {
        read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
      },
    });
    const result = await makeOp(store, codemodRunner(FIXTURE_FILES), authority)(baseInput());
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain('release failed after denial');
    expect(result.error).toContain('nonce spent');
    expect(result.error).not.toContain('UNSPENT');
    expect(result.error).not.toContain('was NOT exercised');
    expect(store.written.size).toBe(0);
    expect(ledger.isSpent(nonce)).toBe(true);
  });

  /** Locks that fault on the FIRST acquire — before the exercise ever runs. */
  function acquireFaultLocks(): { locks: MutationLocks; attempted: () => number } {
    let attempted = 0;
    return {
      attempted: () => attempted,
      locks: {
        forWorkspace: () => ({
          withLock: async <T>(): Promise<T> => {
            attempted += 1;
            throw new Error(
              "git-mutex: could not acquire '/state/mutation-abc.lock' — still held after the waiter budget",
            );
          },
        }),
      },
    };
  }

  test('an ACQUIRE fault reports the token UNSPENT, and nothing was written', async () => {
    const store = approvedStore();
    const { locks, attempted } = acquireFaultLocks();
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: () =>
          Promise.resolve({
            nonce: '9'.repeat(32),
            state: { workspace: '/ws', headSha: 'head', treeClean: true },
          }),
      },
      ledger,
      locks,
      readState: {
        read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
      },
    });
    const result = await makeOp(store, codemodRunner(FIXTURE_FILES), authority)(baseInput());
    expect(attempted()).toBe(1);
    // A RESULT, not an escaping exception.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    const error = result.error;
    expect(error).toContain('mutation lock faulted');
    // THE ASSERTION THAT MATTERS: the nonce was never spent, because the
    // exercise runs inside the lock and the lock was never acquired.
    expect(error).toContain('was NOT exercised');
    expect(error).toContain('UNSPENT');
    expect(error).not.toContain('the approval WAS exercised');
    // And the ledger agrees: nothing was spent, so the same token is
    // re-approvable once the lock is healthy.
    expect(ledger.spent()).toBe(0);
    expect(store.written.size).toBe(0);
  });

  test('a fault AFTER the write reports the token SPENT (the same handler, the other phase)', async () => {
    const store = approvedStore();
    let taken = 0;
    const real = makeProcessLocalMutationLocks();
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: () =>
          Promise.resolve({
            nonce: '8'.repeat(32),
            state: { workspace: '/ws', headSha: 'head', treeClean: true },
          }),
      },
      ledger,
      locks: {
        forWorkspace: (workspace: string) => {
          const inner = real.forWorkspace(workspace);
          return {
            withLock: async <T>(fn: () => T | Promise<T>): Promise<T> => {
              taken += 1;
              // First section (the approved write) completes and then the
              // primitive reports the artifact compromised — the token IS
              // spent by then. The section's result is discarded on purpose:
              // a compromised section proves nothing.
              await inner.withLock(fn);
              throw new Error('git-mutex: lock was compromised while held');
            },
          };
        },
      },
      readState: {
        read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
      },
    });
    const result = await makeOp(store, codemodRunner(FIXTURE_FILES), authority)(baseInput());
    expect(taken).toBe(1);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    // The opposite claim, correctly: spent, because the write was entered.
    expect(result.error).toContain('the approval WAS exercised');
    expect(result.error).toContain('token is spent');
    expect(result.error).not.toContain('was NOT exercised');
    expect(ledger.spent()).toBe(1);
  });
});
