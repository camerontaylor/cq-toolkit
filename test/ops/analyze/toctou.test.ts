// Split from test/ops/analyze/approval.test.ts (pure move; the shared preamble
// lives in withApprovedMutation.test.ts). Subject: the state-binding windows —
// the TOCTOU denial between admission and the write (scripted and REAL git),
// the kernel-to-admission window, and the dirty-workspace refusals.

import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type {
  ApprovalState,
  ApprovalStateReader,
  VerifiedApproval,
} from '../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeGitApprovalStateReader,
  makeProcessLocalMutationLocks,
  withApprovedMutation,
} from '../../../src/ops/analyze/approval.js';
import {
  CLEAN_STATE,
  failingStateReader,
  fixedStateReader,
  git,
  grantingAuthority,
  OP,
  realpathOf,
  realRepo,
  scriptedStateReader,
  subject,
  TARGETS,
  WORKSPACE,
  writeSpy,
} from './approvalFixtures.js';

describe('TOCTOU — the state moves between admission and the write', () => {
  test('a commit landing mid-flight denies the write and leaves the token UNSPENT', async () => {
    // Two reads: the admission read (clean, at HEAD A) and the exercise read
    // under the lock (HEAD B — the commit landed in between).
    const readState = scriptedStateReader([
      CLEAN_STATE,
      { ...CLEAN_STATE, headSha: 'head-after-the-commit' },
    ]);
    const fixture = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      readState,
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      spy.run,
    );
    expect(outcome.status).toBe('needs-human');
    const reason = outcome.status === 'needs-human' ? outcome.reason : '';
    expect(reason).toContain('approval state changed since approval');
    expect(reason).toContain('head-after-the-commit');
    expect(reason).toContain('UNSPENT');
    expect(spy.calls).toBe(0);
    // THE load-bearing assertion: a denied op must not burn the human's
    // approval. A refusal that consumed the token would force a re-approval
    // for a change nobody made.
    expect(fixture.ledger.spent()).toBe(0);
  });

  test('a dirty tree (an untracked file counts) denies the write, unspent', async () => {
    const readState = scriptedStateReader([CLEAN_STATE, { ...CLEAN_STATE, treeClean: false }]);
    const fixture = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      readState,
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
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain('dirty');
  });

  test('a workspace that was dirty at approval and is clean now is still refused', async () => {
    // The signed state is dirty while ADMISSION reads a clean tree: the
    // "clean again" direction of the drift, which the dirty-at-admission
    // check cannot catch. The approval is refused at the state comparison.
    const readState = scriptedStateReader([CLEAN_STATE]);
    const fixture = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      state: { ...CLEAN_STATE, treeClean: false },
      readState,
    });
    const outcome = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      writeSpy().run,
    );
    expect(outcome.status).toBe('needs-human');
    const reason = outcome.status === 'needs-human' ? outcome.reason : '';
    expect(reason).toContain('the tree is clean again');
    expect(readState.reads).toBe(1);
    expect(fixture.ledger.spent()).toBe(0);
  });

  test('TOCTOU over a REAL git repository: a commit between admission and the write denies it', async () => {
    const repo = realRepo();
    const reader = makeGitApprovalStateReader();
    // The commit lands in the window the ADR calls out: AFTER the op's own
    // admission read, BEFORE its exercise re-check, with no lock held by
    // anyone. Calling admit() separately and committing before
    // withApprovedMutation would only exercise a fresh, legitimate admission
    // against the moved HEAD — not the window.
    let reads = 0;
    const windowedReader: ApprovalStateReader = {
      read: async (workspace) => {
        const state = await reader.read(workspace);
        reads += 1;
        if (reads === 1) git(repo, ['commit', '--allow-empty', '-m', 'the window commit']);
        return state;
      },
    };
    const authority = makeApprovalAuthority({
      approvals: {
        // The kernel signs the state it observed: the REAL repo's state, not a
        // fabricated HEAD (a made-up sha is correctly refused at admission).
        verifiedFor: async (candidate) => ({
          nonce: 'nonce-real',
          state: await reader.read(candidate.workspace),
        }),
      },
      ledger: makeInMemoryNonceLedger(),
      locks: makeProcessLocalMutationLocks(),
      readState: windowedReader,
    });
    const bound = { op: OP, workspace: repo, targets: ['src/a.ts'], inputDigest: 'sha256:real' };
    let writes = 0;
    const outcome = await withApprovedMutation(authority, bound, async () => {
      writes += 1;
      return 'written';
    });
    expect(outcome.status).toBe('needs-human');
    const reason = outcome.status === 'needs-human' ? outcome.reason : '';
    expect(reason).toContain('HEAD');
    expect(reason).toContain('UNSPENT');
    expect(writes).toBe(0);
    // PROCESS-BACKED, like the other real-`git` suites in this repo (see
    // test/ops/analyze/registry.ts): `realRepo()` alone spawns six `git`
    // processes (init, two config, add, commit, realpath). Measured at
    // 8745ms on a loaded host — past vitest's 5000ms default before a single
    // assertion runs. The budget is for subprocess startup; NO assertion,
    // baseline or production timing is relaxed, and the same budget the
    // neighbouring real-git suites already use.
  }, 20_000);

  test('an unreadable state denies at admission and at exercise (never "unchanged")', async () => {
    const admitFixture = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      readState: failingStateReader,
    });
    const denied = await withApprovedMutation(
      admitFixture.authority,
      admitFixture.subjectOf(TARGETS),
      writeSpy().run,
    );
    expect(denied.status).toBe('needs-human');
    expect(denied.status === 'needs-human' ? denied.reason : '').toContain(
      'never treated as unchanged',
    );

    const ledger = makeInMemoryNonceLedger();
    // Swap in a reader that succeeds at admission and fails at exercise.
    let calls = 0;
    const flaky = {
      read: (): Promise<ApprovalState> => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(CLEAN_STATE)
          : Promise.reject(new Error('git status failed'));
      },
    };
    const flakyAuthority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'nonce-flaky',
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: flaky,
    });
    const outcome = await withApprovedMutation(flakyAuthority, subject(), writeSpy().run);
    expect(outcome.status).toBe('needs-human');
    // The refusal came from the RE-READ under the mutation lock, not from an
    // admission refusal: admission read once, exercise read again and failed.
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain(
      'could not be re-read',
    );
    expect(calls).toBe(2);
    expect(ledger.spent()).toBe(0);
  });

  test('an unreadable ledger denies the write and spends nothing', async () => {
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'nonce-ledger',
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger: {
        consume: () => Promise.reject(new Error('ledger is a directory')),
      },
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader(),
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(authority, subject(), spy.run);
    expect(outcome.status).toBe('needs-human');
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain('ledger');
    expect(spy.calls).toBe(0);
  });
});

test('realpath fixture setup works without an external realpath executable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cq-realpath-native-'));
  const alias = join(dir, 'alias');
  symlinkSync(dir, alias);
  vi.stubEnv('PATH', '');
  try {
    expect(realpathOf(alias)).toBe(realpathSync(dir));
  } finally {
    vi.unstubAllEnvs();
  }
});

// The second security review's two state-binding findings. Both are about
// the WINDOW between moments rather than about any single check: the
// kernel's signature check and the op's admission are two different
// instants, and "clean" is a boolean, not a description of the bytes.
describe('the kernel-to-admission window (a signed state is required, and compared)', () => {
  test('a workspace mutated between the kernel check and admission is refused, token UNSPENT', async () => {
    // The signed claim describes HEAD A. By the time this op admits, the
    // workspace is at HEAD B. The first version of this module adopted B as
    // its baseline and the exercise happily re-checked B against B.
    const readState = scriptedStateReader([{ ...CLEAN_STATE, headSha: 'head-B' }]);
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'nonce-window',
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState,
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(authority, subject(), spy.run);
    expect(outcome.status).toBe('needs-human');
    const reason = outcome.status === 'needs-human' ? outcome.reason : '';
    expect(reason).toContain('changed since approval');
    expect(reason).toContain('head-B');
    expect(reason).toContain('between the kernel');
    expect(reason).toContain('UNSPENT');
    expect(spy.calls).toBe(0);
    // The whole point: the token is still spendable after a re-approval
    // against the state the workspace is actually in.
    expect(ledger.spent()).toBe(0);
  });

  test('a verified approval with NO signed state is refused (fail-closed, no best guess)', async () => {
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      // An adapter that cannot supply the claim's state must refuse, not
      // re-read at call time — a re-read collapses the two moments and
      // reopens the window the field exists to close.
      approvals: {
        verifiedFor: () =>
          Promise.resolve({ nonce: 'nonce-stateless' } as unknown as VerifiedApproval),
      },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader(),
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(authority, subject(), spy.run);
    expect(outcome.status).toBe('needs-human');
    const reason = outcome.status === 'needs-human' ? outcome.reason : '';
    expect(reason).toContain('carried no signed state');
    expect(reason).toContain('mandatory');
    expect(spy.calls).toBe(0);
    expect(ledger.spent()).toBe(0);
  });

  test('a matching signed state is admitted (the happy path still works)', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: TARGETS });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      spy.run,
    );
    expect(outcome.status).toBe('ok');
    expect(spy.calls).toBe(1);
  });
});

describe('a dirty workspace is not an approvable state (the clean BOOLEAN is not enough)', () => {
  test('a DIRTY tree at admission is refused outright, unspent', async () => {
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'nonce-dirty',
            state: { ...CLEAN_STATE, workspace: candidate.workspace, treeClean: false },
          }),
      },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: {
        read: () => Promise.resolve({ ...CLEAN_STATE, treeClean: false }),
      },
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(authority, subject(), spy.run);
    expect(outcome.status).toBe('needs-human');
    const reason = outcome.status === 'needs-human' ? outcome.reason : '';
    // The ADR's own enumerated reason token (bf5f540 adr-0003 §4c), quoted
    // verbatim so the refusal is traceable to the clause requiring it.
    expect(reason).toContain('workspace dirty');
    expect(reason).toContain('ADR-0003 §4c step 1');
    // Untracked files count as dirty, which is the case §7 names.
    expect(reason).toContain('an untracked file counts as dirty');
    expect(spy.calls).toBe(0);
    expect(ledger.spent()).toBe(0);
  });

  test('a CLEAN signed state with a dirty workspace is refused the same way (the state moved, and the ADR forbids the write)', async () => {
    // The complementary case to the one above: the token describes a clean
    // tree, and the workspace is dirty by the time this op admits. This is
    // also the ADR's "state changed" direction, and it must refuse BEFORE
    // any grant is minted.
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'nonce-clean-then-dirty',
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: {
        read: () => Promise.resolve({ ...CLEAN_STATE, treeClean: false }),
      },
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(authority, subject(), spy.run);
    expect(outcome.status).toBe('needs-human');
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain('workspace dirty');
    expect(spy.calls).toBe(0);
    expect(ledger.spent()).toBe(0);
  });

  test('the real git reader reports an UNTRACKED file as dirty (the predicate the ADR specifies)', async () => {
    // The predicate is asserted against real `git status`, not only against
    // the fake reader: an untracked file must make `treeClean` false, since
    // that is the exact case ADR §7 requires refusing.
    const repo = realRepo();
    const reader = makeGitApprovalStateReader();
    const before = await reader.read(repo);
    expect(before.treeClean).toBe(true);
    writeFileSync(join(repo, 'src', 'untracked.ts'), 'export const u = 1;\n');
    const after = await reader.read(repo);
    expect(after.treeClean).toBe(false);
    // ...and the whole op refuses on that state.
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: 'nonce-untracked',
            state: { ...before, workspace: candidate.workspace },
          }),
      },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: reader,
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(authority, subject({ workspace: repo }), spy.run);
    expect(outcome.status).toBe('needs-human');
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain('workspace dirty');
    expect(spy.calls).toBe(0);
    expect(ledger.spent()).toBe(0);
    // PROCESS-BACKED (see the sibling TOCTOU test above): `realRepo()` plus
    // three real `git status` reads exceed vitest's 5000ms default on a
    // loaded host before any assertion runs. Startup budget only; no
    // assertion or baseline is relaxed.
  }, 20_000);

  test('TOCTOU: an untracked file appearing between admission and the write is refused, unspent', async () => {
    // The specific hole: same HEAD, still "dirty" on both sides of the
    // exercise, but a DIFFERENT dirty state than the one approved.
    const readState = scriptedStateReader([CLEAN_STATE, { ...CLEAN_STATE, treeClean: false }]);
    const fixture = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      readState,
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      spy.run,
    );
    expect(outcome.status).toBe('needs-human');
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain(
      'the tree is dirty (an untracked file counts)',
    );
    expect(spy.calls).toBe(0);
    expect(fixture.ledger.spent()).toBe(0);
  });
});
