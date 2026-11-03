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
import { makePlaybookDispatchOp } from '../../../../src/ops/analyze/playbooks/registry.js';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
} from '../../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../../src/adapters/store/nonceLedger.js';
import { FIXTURE, dispatchEvidence, harness, playbookOf } from './registry.helpers.js';
import type { Harness } from './registry.helpers.js';

// W4.3, second review — the RESTORE is a mutation too. The first version
// released the mutation lock when the engine call returned and then wrote
// the pre-apply bytes back after the verifier, so a concurrent approved
// dispatch of ANOTHER playbook could land in that window and have its edit
// silently overwritten by this one's rollback. These are the regressions for
// that lost update: the conflicting file is reported STRANDED and left alone.
describe('W4.3 the rollback is conditional and locked (no lost update)', () => {
  const CONCURRENT_EDIT = 'const x = fooBar;\nconst y = fooBar;\n// playbook B also ran\n';

  function harnessWhereVerifierLandsAConcurrentWrite(
    files: Record<string, string>,
    verifierExit: number | null,
  ): Harness {
    // The scripted runner answers the verifier command. Landing a second
    // playbook's edit THERE is the real interleaving: B's apply commits
    // while A is between its own write and its rollback. Installed through
    // the harness's runner seam, so it is the runner the dispatch op holds.
    let store: Harness['store'] | undefined;
    const h = harness(files, verifierExit, '', playbookOf(), () => {
      store?.backing.set('src/a.ts', CONCURRENT_EDIT);
    });
    store = h.store;
    return h;
  }

  test('a concurrent writer between the apply and the rollback is NOT clobbered: STRANDED, bytes intact', async () => {
    const h = harnessWhereVerifierLandsAConcurrentWrite(FIXTURE, 1);
    const result = await h.dispatch({
      playbookId: 'fix-foo-bar',
      dir: '/ws',
      targets: ['src/a.ts'],
    });
    // Still a failed dispatch — the verifier verdict is unchanged by what
    // happened to the file afterwards.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    const evidence = dispatchEvidence(result.error);
    // THE assertion: nothing was restored, because the file no longer holds
    // what THIS dispatch wrote.
    expect(evidence.restore.restored).toEqual([]);
    expect(evidence.restore.stranded).toHaveLength(1);
    expect(evidence.restore.stranded[0]?.file).toBe('src/a.ts');
    expect(evidence.restore.stranded[0]?.error).toContain('another writer changed this file');
    expect(evidence.restore.stranded[0]?.error).toContain('NOT restored');
    // B's edit survived — the lost update the first version of this restore
    // would have caused.
    expect(h.store.backing.get('src/a.ts')).toBe(CONCURRENT_EDIT);
    // And the prose does NOT claim the workspace is back at pre-dispatch.
    expect(result.error).toContain('STRANDED');
    expect(result.error).toContain('NOT at its pre-dispatch state');
  });

  test('POSITIVE CONTROL: with no concurrent writer the same path restores fully', async () => {
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

  test('the restore runs INSIDE the mutation lock, so two rollbacks cannot interleave', async () => {
    const h = harness(FIXTURE, 1);
    const events: string[] = [];
    const locks = makeProcessLocalMutationLocks();
    const inner = locks.forWorkspace('/ws');
    let held = 0;
    let maxHeld = 0;
    const instrumented = {
      forWorkspace: () => ({
        withLock: async <T>(fn: () => T | Promise<T>): Promise<T> =>
          inner.withLock(async () => {
            held += 1;
            maxHeld = Math.max(maxHeld, held);
            events.push(`lock:${held}`);
            try {
              return await fn();
            } finally {
              held -= 1;
              events.push(`unlock:${held + 1}`);
            }
          }),
      }),
    };
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (s) =>
          Promise.resolve({
            nonce: `nonce-${s.inputDigest.slice(0, 12)}`,
            state: { workspace: '/ws', headSha: 'head', treeClean: true },
          }),
      },
      ledger: makeInMemoryNonceLedger(),
      locks: instrumented,
      readState: {
        read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
      },
    });
    const dispatch = makePlaybookDispatchOp({
      playbooks: h.playbooks,
      quarantine: h.quarantine,
      run: h.run,
      storeFor: () => h.store,
      approval: authority,
    });
    await dispatch({ playbookId: 'fix-foo-bar', dir: '/ws', targets: ['src/a.ts'] });
    // TWO critical sections: the apply (exercise + engine) and the restore.
    // The first version had ONE — the restore ran outside the lock, which is
    // the whole bug.
    expect(events.filter((entry) => entry.startsWith('lock:'))).toHaveLength(2);
    expect(maxHeld).toBe(1);
  });
});
