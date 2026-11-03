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
// applyRemediation.lockFaultTokenFate.test.ts and
// applyRemediation.helpers.ts.
import { describe, expect, test } from 'vitest';
import { makeInMemoryNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
} from '../../../src/ops/analyze/approval.js';
import { makeApplyRemediation } from '../../../src/ops/analyze/applyRemediation.js';
import {
  FIXTURE_FILES,
  approvedAuthority,
  approvedStore,
  baseInput,
  codemodRunner,
  makeOp,
} from './applyRemediation.helpers.js';

// W4.3 — the op-level approval boundary. These are the A16/TOCTOU proofs
// AT THE OP: the denial is a `needs-human` from `applyRemediation` itself,
// and the store's write map is the witness that no byte changed.
describe('W4.3 approval at the mutation boundary (applyRemediation)', () => {
  test('A16: a forged approved:true with the shipped deny-all default is refused and writes NOTHING', async () => {
    const store = approvedStore();
    // No authority bound — exactly how the (frozen, #238-owned) registry
    // adapter composes this op today.
    const result = await makeApplyRemediation(
      () => store,
      codemodRunner(FIXTURE_FILES),
    )(baseInput());
    expect(result.status).toBe('needs-human');
    const reason = result.status === 'needs-human' ? result.reason : '';
    expect(reason).toContain('DECLARED INTENT');
    expect(reason).toContain('Nothing was written');
    // The witness: the plan said approved, the op scanned and planned, and
    // the workspace is still byte-identical.
    expect(store.written.size).toBe(0);
  });

  test('a dry run needs no approval token: it writes nothing, so there is nothing to approve', async () => {
    const store = approvedStore();
    const result = await makeApplyRemediation(
      () => store,
      codemodRunner(FIXTURE_FILES),
    )({
      ...baseInput(),
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    expect(store.written.size).toBe(0);
  });

  test('TOCTOU: a commit landing between admission and the write is refused, with the token UNSPENT', async () => {
    const store = approvedStore();
    // Two state reads: the admission read, then the exercise read under the
    // mutation lock — HEAD moved in between.
    let reads = 0;
    const { authority, ledger } = approvedAuthority({
      read: () => {
        reads += 1;
        return Promise.resolve({
          workspace: '/ws',
          headSha: reads === 1 ? 'head-at-approval' : 'head-after-the-commit',
          treeClean: true,
        });
      },
    });
    const result = await makeOp(store, codemodRunner(FIXTURE_FILES), authority)(baseInput());
    expect(result.status).toBe('needs-human');
    const reason = result.status === 'needs-human' ? result.reason : '';
    expect(reads).toBe(2);
    expect(reason).toContain('approval state changed since approval');
    expect(reason).toContain('issued against a different workspace state');
    expect(reason).not.toContain("between the kernel's verification");
    expect(reason).toContain('UNSPENT');
    expect(reason).toContain('fully planned and NOTHING was written');
    expect(store.written.size).toBe(0);
    // The refusal did not burn the human's approval: a re-approval against
    // the current state can still apply this exact plan.
    expect(ledger.spent()).toBe(0);
  });

  test('REPLAY: a second apply of the same approved inputs is refused (nonce spent), writing nothing', async () => {
    const store = approvedStore();
    const { authority, ledger } = approvedAuthority();
    const first = await makeOp(store, codemodRunner(FIXTURE_FILES), authority)(baseInput());
    expect(first.status).toBe('ok');
    expect(ledger.spent()).toBe(1);
    // The replay runs against a workspace back at the APPROVED state (the
    // state the token was issued against — e.g. after a rollback), with a
    // non-empty plan. That isolates the refusal under test: it is the
    // spent token, not a stale sidecar and not an empty plan, and it is
    // exactly ADR-0003 §5's replay case.
    const replayStore = approvedStore();
    const second = await makeOp(replayStore, codemodRunner(FIXTURE_FILES), authority)(baseInput());
    expect(second.status).toBe('needs-human');
    expect(second.status === 'needs-human' ? second.reason : '').toContain('already consumed');
    expect(replayStore.written.size).toBe(0);
  });

  test('an approval that never verified is refused even though approved:true is present', async () => {
    const store = approvedStore();
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      // A16 at the seam: the run's snapshot holds no token for this subject.
      approvals: { verifiedFor: () => Promise.resolve(undefined) },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: {
        read: () => Promise.resolve({ workspace: '/ws', headSha: 'head', treeClean: true }),
      },
    });
    const result = await makeOp(store, codemodRunner(FIXTURE_FILES), authority)(baseInput());
    expect(result.status).toBe('needs-human');
    expect(store.written.size).toBe(0);
    expect(ledger.spent()).toBe(0);
  });

  test('an empty plan (nothing matched) is an honest ok that consumes no approval', async () => {
    const store = approvedStore();
    const { authority, ledger } = approvedAuthority();
    const result = await makeOp(store, codemodRunner({}), authority)(baseInput());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.plannedEdits).toBe(0);
    }
    // There was no write, so no human decision was spent on one.
    expect(ledger.spent()).toBe(0);
    expect(store.written.size).toBe(0);
  });
});
