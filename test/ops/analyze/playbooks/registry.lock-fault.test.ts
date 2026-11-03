// Analyze lane G3 — test evidence for the playbook registry + dispatch:
// the acceptance flow end to end over INJECTED runners and stores (no
// ast-grep binary, no real fs). Pinned here: register refuses duplicates;
// an unknown id fails naming the population; a QUARANTINED playbook is
// refused before anything runs (needs-human — lifting is explicit); a
// verifier PASS verifies; a verifier FAIL writes the quarantine record and
// the dispatch honestly reports remediation-applied-but-verifier-failed;
// an INDETERMINATE verifier is honest indeterminate, quarantines NOTHING,
// and still returns the trace record; the engine's own faults (collision,
// containment) fail closed without touching the ledger.
//
// Split provenance: test/ops/analyze/playbooks/registry.test.ts was split into
// registry.register.test.ts, registry.dispatch.test.ts,
// registry.dispatch-faults.test.ts, registry.withDispatch.test.ts,
// registry.holds.test.ts, registry.hold-identity.test.ts,
// registry.quarantine-list.test.ts, registry.rollback.test.ts,
// registry.lock-fault.test.ts and registry.approved-apply.test.ts; shared
// fixtures live in registry.helpers.ts.
import { describe, expect, test } from 'vitest';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
} from '../../../../src/ops/analyze/approval.js';
import type { MutationLocks } from '../../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../../src/adapters/store/nonceLedger.js';
import { makePlaybookDispatchOp } from '../../../../src/ops/analyze/playbooks/registry.js';
import { FIXTURE, dispatchEvidence, harness } from './registry.helpers.js';

// A LOCK FAULT IS A RESULT, NOT AN EXCEPTION. The mutation lock is a real
// filesystem primitive and it throws in three ordinary ways — the waiter
// budget is exhausted, the release fails, or the artifact is compromised
// while held. Before this, any of those rejected straight out of the op
// with no OpResult and, worse, no evidence: the applied edits were already
// on disk and the caller learned nothing about them.
describe('a lock fault during the rollback is reported, never thrown', () => {
  /**
   * Locks that fault the way the real git mutex can — at acquire, or after
   * the section ran — but ONLY ON THE SECOND SECTION.
   *
   * That "second only" is the point: the dispatch takes the mutation lock
   * TWICE, once for the approved apply and once for the rollback. A fixture
   * that faults on every acquisition fails the FIRST one, so the verifier
   * never runs and the test asserts nothing about the rollback it claims to
   * cover. The first section must therefore succeed, and every test below
   * asserts the verifier ran, which is what proves the rollback was reached
   * at all.
   */
  function faultingLocks(mode: 'acquire' | 'release'): {
    locks: MutationLocks;
    sections: () => number;
  } {
    const real = makeProcessLocalMutationLocks();
    let taken = 0;
    return {
      sections: () => taken,
      locks: {
        forWorkspace: (workspace: string) => {
          const inner = real.forWorkspace(workspace);
          return {
            withLock: async <T>(fn: () => T | Promise<T>): Promise<T> => {
              taken += 1;
              if (taken === 1) return inner.withLock(fn);
              if (mode === 'acquire') {
                throw new Error(
                  "git-mutex: could not acquire '/state/mutation-abc.lock' — still held after the waiter budget",
                );
              }
              // The compromise-after-the-fact case: the section RAN (and its
              // result is discarded, because a compromised section proves
              // nothing), then the primitive reported the fault.
              await inner.withLock(fn);
              throw new Error('git-mutex: lock was compromised while held');
            },
          };
        },
      },
    };
  }

  test('a lock fault at ACQUIRE strands every applied file and still returns failed', async () => {
    const h = harness(FIXTURE, 1);
    const { locks, sections } = faultingLocks('acquire');
    const dispatch = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: h.run,
      storeFor: () => h.store,
      approval: makeApprovalAuthority({
        approvals: {
          verifiedFor: (s) =>
            Promise.resolve({
              nonce: `nonce-${s.inputDigest.slice(0, 12)}`,
              state: { workspace: '/ws', headSha: 'head', treeClean: true },
            }),
        },
        ledger: makeInMemoryNonceLedger(),
        locks,
        readState: {
          read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
        },
      }),
    });
    const result = await dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    // PROOF THE ROLLBACK WAS REACHED: the apply took the first section
    // (healthy), the verifier really ran, and only the SECOND section — the
    // rollback's — faulted. A fixture that faulted section one would fail
    // here and never get this far.
    expect(sections()).toBe(2);
    expect(h.run.verifierCalls).toHaveLength(1);
    // No throw escaped: the op produced a result.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    const evidence = dispatchEvidence(result.error);
    // NOTHING is claimed as restored, and the reason names the lock fault.
    expect(evidence.restore.restored).toEqual([]);
    expect(evidence.restore.stranded).toHaveLength(1);
    expect(evidence.restore.stranded[0]?.file).toBe('src/a.ts');
    expect(evidence.restore.stranded[0]?.error).toContain('mutation lock faulted');
    expect(evidence.restore.stranded[0]?.error).toContain('waiter budget');
    // The playbook is still quarantined — the verdict did not change.
    expect(evidence.quarantined).toBe(true);
  });

  test('a lock fault AFTER the section ran claims nothing as restored (exclusivity is unproven)', async () => {
    const h = harness(FIXTURE, 1);
    const { locks, sections } = faultingLocks('release');
    const dispatch = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: h.run,
      storeFor: () => h.store,
      approval: makeApprovalAuthority({
        approvals: {
          verifiedFor: (s) =>
            Promise.resolve({
              nonce: `nonce-${s.inputDigest.slice(0, 12)}`,
              state: { workspace: '/ws', headSha: 'head', treeClean: true },
            }),
        },
        ledger: makeInMemoryNonceLedger(),
        locks,
        readState: {
          read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
        },
      }),
    });
    const result = await dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    // Same proof: the apply's section was healthy, the verifier ran, and the
    // rollback's section is the one that faulted.
    expect(sections()).toBe(2);
    expect(h.run.verifierCalls).toHaveLength(1);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    const evidence = dispatchEvidence(result.error);
    // The restore body DID run, but a compromised section proves no
    // exclusivity, so the bytes must not be reported as a clean rollback.
    expect(evidence.restore.restored).toEqual([]);
    expect(evidence.restore.stranded[0]?.error).toContain('compromised');
    expect(result.error).not.toContain('rolled back to their pre-dispatch bytes');
  });

  test('POSITIVE CONTROL: with healthy locks the same path still restores fully', async () => {
    const h = harness(FIXTURE, 1);
    const before = h.store.backing.get('src/a.ts');
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    const evidence = dispatchEvidence(result.error);
    expect(evidence.restore.restored).toEqual(['src/a.ts']);
    expect(evidence.restore.stranded).toEqual([]);
    expect(h.store.backing.get('src/a.ts')).toBe(before);
  });
});
