// Split from test/ops/analyze/approval.test.ts (pure move; the shared preamble
// lives in withApprovedMutation.test.ts). Subject: A16 — a forged
// `approved: true`, and the deny-all default.

import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DENY_ALL_APPROVALS,
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
  withApprovedMutation,
} from '../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import {
  CLEAN_STATE,
  fixedStateReader,
  grantingAuthority,
  noVerifiedApprovals,
  OP,
  subject,
  TARGETS,
  WORKSPACE,
  writeSpy,
} from './approvalFixtures.js';

describe('A16 — a forged approved:true, and the deny-all default', () => {
  test('the deny-all authority refuses every mutation, naming the intent/proof gap', async () => {
    const spy = writeSpy();
    const outcome = await withApprovedMutation(DENY_ALL_APPROVALS, subject(), spy.run);
    expect(outcome.status).toBe('needs-human');
    const reason = outcome.status === 'needs-human' ? outcome.reason : '';
    expect(reason).toContain('DECLARED INTENT');
    expect(reason).toContain('Nothing was written');
    expect(spy.calls).toBe(0);
  });

  test('an approval the run never verified is refused even with a clean, matching state', async () => {
    const fixture = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      approvals: noVerifiedApprovals,
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      spy.run,
    );
    expect(outcome.status).toBe('needs-human');
    expect(spy.calls).toBe(0);
    expect(fixture.ledger.spent()).toBe(0);
  });

  test('an empty target set is refused: an approval binding nothing is not an approval', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: TARGETS });
    const outcome = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf([]),
      writeSpy().run,
    );
    expect(outcome.status).toBe('needs-human');
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain('no target files');
  });

  test('a trusted approval layer INSIDE the workspace is refused (tamper vector #26)', async () => {
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'nonce-inside',
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger: makeInMemoryNonceLedger(),
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader(),
      trustedLayerDir: '/ws/.cq',
    });
    const outcome = await withApprovedMutation(
      authority,
      subject({ workspace: '/ws' }),
      writeSpy().run,
    );
    expect(outcome.status).toBe('needs-human');
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain(
      'inside the workspace under approval',
    );
  });

  // The three cases below are the ones a REVERSED containment comparison
  // gets wrong, and they are pinned together because the first version of
  // this guard asked "is the workspace inside the trusted layer?" — which
  // refused the harmless layouts, allowed the attack, and still passed the
  // one test above.
  test('a trusted layer that CONTAINS the workspace is allowed (that is the normal layout)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cq-trust-'));
    const workspace = join(root, 'proj');
    mkdirSync(workspace, { recursive: true });
    // $HOME/state beside $HOME/proj: the ledger's layer is an ANCESTOR of
    // the workspace. Nothing under approval can reach it.
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'nonce-ancestor',
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger: makeInMemoryNonceLedger(),
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader({ ...CLEAN_STATE, workspace }),
      trustedLayerDir: root,
    });
    const outcome = await withApprovedMutation(authority, subject({ workspace }), writeSpy().run);
    expect(outcome.status).toBe('ok');
  });

  test('a trusted layer nested in the workspace is refused even through a SYMLINK and before it exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cq-trust-'));
    const real = join(root, 'real');
    const workspace = join(real, 'ws');
    mkdirSync(workspace, { recursive: true });
    // A symlinked path to the same tree, and a trusted layer that has NOT
    // been created yet (the common case: the ledger dir appears on first
    // write). Both must still resolve to the same containment answer.
    symlinkSync(real, join(root, 'link'));
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'nonce-symlink',
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger: makeInMemoryNonceLedger(),
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader({ ...CLEAN_STATE, workspace }),
      trustedLayerDir: join(root, 'link', 'ws', '.cq'),
    });
    const outcome = await withApprovedMutation(authority, subject({ workspace }), writeSpy().run);
    expect(outcome.status).toBe('needs-human');
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain(
      'inside the workspace under approval',
    );
  });

  test('a sibling with a shared PREFIX is not "inside" (no /ws vs /ws-cq confusion)', async () => {
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'nonce-sibling',
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger: makeInMemoryNonceLedger(),
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader(),
      trustedLayerDir: '/ws-cq',
    });
    const outcome = await withApprovedMutation(
      authority,
      subject({ workspace: '/ws' }),
      writeSpy().run,
    );
    expect(outcome.status).toBe('ok');
  });
});
