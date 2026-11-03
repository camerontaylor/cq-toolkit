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
import { FIXTURE, RULE, harness, playbookOf } from './registry.helpers.js';

// Opus review (PR #258): the APPLY's lock fault is a result too, and the
// approval digest binds what the dispatch actually runs.
describe('the approved apply: lock faults and the digested subject', () => {
  function authorityOver(
    locks: MutationLocks,
    digests: string[] = [],
  ): ReturnType<typeof makeApprovalAuthority> {
    return makeApprovalAuthority({
      approvals: {
        verifiedFor: (s) => {
          digests.push(s.inputDigest);
          return Promise.resolve({
            nonce: `nonce-${s.inputDigest.slice(0, 12)}`,
            state: { workspace: '/ws', headSha: 'head', treeClean: true },
          });
        },
      },
      ledger: makeInMemoryNonceLedger(),
      locks,
      readState: {
        read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
      },
    });
  }

  function firstSectionFaults(mode: 'acquire' | 'release'): MutationLocks {
    const real = makeProcessLocalMutationLocks();
    return {
      forWorkspace: (workspace: string) => ({
        withLock: async <T>(fn: () => T | Promise<T>): Promise<T> => {
          if (mode === 'acquire') throw new Error('git-mutex: waiter budget exhausted');
          await real.forWorkspace(workspace).withLock(fn);
          throw new Error('git-mutex: release failed');
        },
      }),
    };
  }

  for (const [mode, fate] of [
    ['acquire', 'UNSPENT'],
    ['release', 'token is spent'],
  ] as const) {
    test(`a ${mode} fault on the apply returns failed (${fate}) instead of rejecting`, async () => {
      const h = harness(FIXTURE, 0);
      const dispatch = makePlaybookDispatchOp({
        playbooks: h.playbooks,
        quarantine: h.quarantine,
        run: h.run,
        storeFor: () => h.store,
        approval: authorityOver(firstSectionFaults(mode)),
      });
      const result = await dispatch({
        playbookId: 'fix-foo-bar',
        dir: '/ws',
        targets: ['src/a.ts'],
      });
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') return;
      expect(result.error).toContain('mutation lock faulted');
      expect(result.error).toContain(fate);
      expect(result.error).toContain('NO verifier or rollback ran');
      expect(h.run.verifierCalls).toHaveLength(0);
    });
  }

  test('the approval digest binds the resolved rule, not only the playbook id', async () => {
    const digests: string[] = [];
    for (const rule of [RULE, { ...RULE, id: 'a-different-rule' }]) {
      const h = harness(FIXTURE, 0, '', { ...playbookOf(), rule });
      await makePlaybookDispatchOp({
        playbooks: h.playbooks,
        quarantine: h.quarantine,
        run: h.run,
        storeFor: () => h.store,
        approval: authorityOver(makeProcessLocalMutationLocks(), digests),
      })({ playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] });
    }
    expect(digests).toHaveLength(2);
    expect(digests[0]).not.toBe(digests[1]);
  });
});
