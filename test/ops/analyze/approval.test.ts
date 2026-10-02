// Analyze lane W4.3 — DIRECT OFFLINE evidence for the approval authority
// (ADR-0003 §4a–§6; A16 forged `approved: true`; the TOCTOU denial).
//
// What is pinned here, and why each one earns its place:
//   - a token authorizes ONE write, and the second attempt is refused with
//     the nonce already spent (single use, §5);
//   - the STATE re-check under the lock is what catches a commit landing
//     between admission and the write (the TOCTOU case, §7) — proven twice:
//     once over a scripted state reader, once over a REAL git repository, so
//     the proof does not rest on the fake's fidelity;
//   - a refusal NEVER burns the token: after every denial the ledger reports
//     zero spent nonces, which is what makes a retry-after-re-approval
//     possible and a denial non-destructive;
//   - the `needs-human` verdicts are specific enough to act on, because a
//     refusal a human cannot act on is a refusal that gets worked around;
//   - O-5: the mutation lock's record lands BESIDE the operator ledger and
//     NEVER inside the workspace under approval (the tamper vector the annex
//     left open);
//   - the lock is held THROUGH the write, proven by two concurrent
//     mutations of one workspace producing no interleaved critical sections;
//   - the deny-all default refuses a forged `approved: true` with an
//     untouched workspace, which is the state the shared registry adapter
//     (#238's file, not edited here) is in until the kernel wiring lands.
//
// NO credentials, no network, no ast-grep binary: the only subprocess is
// `git` against a temporary repository, used to prove the real state reader.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type {
  ApprovalState,
  ApprovalStateReader,
  ApprovalSubject,
  ExercisedScope,
  MutationLock,
  MutationLocks,
  VerifiedApproval,
} from '../../../src/ops/analyze/approval.js';
import {
  approvalInputDigest,
  canonicalWorkspace,
  DENY_ALL_APPROVALS,
  isExercisedScope,
  makeApprovalAuthority,
  makeFileNonceLedger,
  makeGitApprovalStateReader,
  makeInMemoryNonceLedger,
  makeLedgerBesideMutationLocks,
  makeProcessLocalMutationLocks,
  withApprovedMutation,
  withMutationLock,
} from '../../../src/ops/analyze/approval.js';
import {
  CLEAN_STATE,
  failingStateReader,
  fixedStateReader,
  grantingAuthority,
  noVerifiedApprovals,
  scriptedStateReader,
} from './approvalFixtures.js';

const OP = 'analyze.applyRemediation';
const WORKSPACE = '/ws';
const TARGETS = ['src/a.ts'] as const;

function subject(overrides: Partial<ApprovalSubject> = {}): ApprovalSubject {
  return {
    op: OP,
    workspace: WORKSPACE,
    targets: [...TARGETS],
    inputDigest: 'sha256:test',
    ...overrides,
  };
}

/** A write spy: records the call and reports what the op would have done. */
function writeSpy(log: string[] = []): { calls: number; run: () => Promise<string> } {
  const spy = {
    calls: 0,
    run: async (): Promise<string> => {
      spy.calls += 1;
      log.push('write');
      return 'written';
    },
  };
  return spy;
}

describe('withApprovedMutation — admission, consumption at the mutation', () => {
  test('an approved subject writes ONCE and spends the nonce', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: TARGETS });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      spy.run,
    );
    expect(outcome.status).toBe('ok');
    expect(spy.calls).toBe(1);
    expect(fixture.ledger.spent()).toBe(1);
  });

  test('REPLAY: a second dispatch on the same approval is refused (nonce spent), with no write', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: TARGETS });
    const first = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      writeSpy().run,
    );
    expect(first.status).toBe('ok');
    const replayWrite = writeSpy();
    const replay = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      replayWrite.run,
    );
    expect(replay.status).toBe('needs-human');
    expect(replay.status === 'needs-human' ? replay.reason : '').toContain('already consumed');
    expect(replayWrite.calls).toBe(0);
    // The refusal cost the workspace nothing; the token was spent by the
    // FIRST write, which is why the message says "already consumed".
    expect(fixture.ledger.spent()).toBe(1);
  });

  test('a grant exercised twice THROWS rather than spending one decision twice', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: TARGETS });
    const admitted = await fixture.authority.admit(fixture.subjectOf(TARGETS));
    expect(admitted.granted).toBe(true);
    if (!admitted.granted) return;
    const first = await fixture.authority.exercise(admitted.grant, fixture.subjectOf(TARGETS));
    expect(first.granted).toBe(true);
    await expect(
      fixture.authority.exercise(admitted.grant, fixture.subjectOf(TARGETS)),
    ).rejects.toThrow(/already exercised/);
  });

  test('a DIFFERENT input digest is a different subject: refused even with a valid token', async () => {
    const fixture = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      inputDigest: 'sha256:granted',
    });
    // The run's verified approvals hold a token for 'sha256:granted' and
    // nothing for any other input: the inputs hash is part of the subject,
    // so re-using one human's approval for edited inputs is not possible.
    const drifted = writeSpy();
    const refused = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS).inputDigest === 'sha256:granted'
        ? subject({ inputDigest: 'sha256:other' })
        : fixture.subjectOf(TARGETS),
      drifted.run,
    );
    expect(refused.status).toBe('needs-human');
    expect(drifted.calls).toBe(0);
    expect(fixture.ledger.spent()).toBe(0);
  });

  test('a grant exercised against a different subject is refused at the exercise', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: TARGETS });
    const admitted = await fixture.authority.admit(fixture.subjectOf(TARGETS));
    expect(admitted.granted).toBe(true);
    if (!admitted.granted) return;
    // Same op, same workspace, same state — different inputs. The exercise
    // compares the FULL subject, so an approval cannot be slid onto a
    // different plan.
    const outcome = await fixture.authority.exercise(admitted.grant, {
      ...fixture.subjectOf(TARGETS),
      inputDigest: 'sha256:swapped',
    });
    expect(outcome.granted).toBe(false);
    expect(fixture.ledger.spent()).toBe(0);
  });
});

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
    const readState = scriptedStateReader([{ ...CLEAN_STATE, treeClean: false }, CLEAN_STATE]);
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

    const exerciseFixture = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      readState: scriptedStateReader([CLEAN_STATE, CLEAN_STATE]),
    });
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
      ledger: exerciseFixture.ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: flaky,
    });
    const outcome = await withApprovedMutation(flakyAuthority, subject(), writeSpy().run);
    expect(outcome.status).toBe('needs-human');
    expect(exerciseFixture.ledger.spent()).toBe(0);
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

describe('O-5 — where the mutation lock record lives', () => {
  test('the record lands BESIDE the ledger, and never inside the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-o5-'));
    const workspace = join(dir, 'worktree');
    const trusted = join(dir, 'state');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(trusted, { recursive: true });
    const locks = makeLedgerBesideMutationLocks(join(trusted, 'approvals.ndjson'));
    const lock: MutationLock = locks.forWorkspace(workspace);
    // Acquiring CREATES the artifact — that is the observation: where the
    // `.lock` directory appears IS the O-5 answer.
    return lock
      .withLock(async () => {
        const inWorkspace = readdirSync(workspace);
        const inTrusted = readdirSync(trusted);
        expect(inWorkspace).toEqual([]);
        const artifacts = inTrusted.filter((entry) => entry.startsWith('mutation-'));
        expect(artifacts).toHaveLength(1);
        // Keyed on the workspace, not on the ledger file: the artifact name
        // carries a sha256(worktree root) prefix, so two workspaces
        // sharing one ledger never share a lock.
        expect(artifacts[0]).toMatch(/^mutation-[0-9a-f]{32}\.lock$/);
        return artifacts[0] as string;
      })
      .then((artifact) => {
        // Released on exit, so a second acquire succeeds — the lock is not
        // a latch left behind.
        return lock.withLock(() => artifact);
      })
      .then((artifact) => {
        expect(artifact).toMatch(/^mutation-/);
      });
  });
});

describe('the mutation lock is held THROUGH the write', () => {
  test('two concurrent mutations of one workspace never interleave', async () => {
    const log: string[] = [];
    let depth = 0;
    let maxDepth = 0;
    // ONE process-local lock provider for the whole test. Building a fresh
    // `makeProcessLocalMutationLocks()` inside forWorkspace would hand each
    // caller its own chain map, so the two sections would not contend at all
    // and the exclusivity this test exists to prove would be measured against
    // a provider that never serialized anything.
    const provider = makeProcessLocalMutationLocks();
    const instrumented: MutationLocks = {
      forWorkspace: (workspace) => {
        const inner = provider.forWorkspace(workspace);
        return {
          withLock: async <T>(fn: () => T | Promise<T>): Promise<T> =>
            inner.withLock(async () => {
              depth += 1;
              maxDepth = Math.max(maxDepth, depth);
              try {
                return await fn();
              } finally {
                depth -= 1;
              }
            }),
        } satisfies MutationLock;
      },
    };
    const authority = makeApprovalAuthority({
      // One verified approval per distinct subject, so both writes are
      // authorized — the point of the test is the LOCK, not the approval.
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: `n-${candidate.inputDigest}`,
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger: makeInMemoryNonceLedger(),
      locks: instrumented,
      readState: fixedStateReader(),
    });
    const section = (label: string) => async (): Promise<string> => {
      log.push(`${label}:start`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      log.push(`${label}:end`);
      return label;
    };
    await Promise.all([
      withApprovedMutation(authority, subject({ inputDigest: 'sha256:a' }), section('a')),
      withApprovedMutation(authority, subject({ inputDigest: 'sha256:b' }), section('b')),
    ]);
    // maxDepth 1 is the O-6 statement for this path: every write's critical
    // section — re-check, consume, write — is exclusive per workspace.
    expect(maxDepth).toBe(1);
    // And the log is a strict serialization, never a-b-start/a-end overlap.
    const starts = log.filter((entry) => entry.endsWith(':start'));
    const ends = log.filter((entry) => entry.endsWith(':end'));
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(log[0]?.endsWith(':start')).toBe(true);
    expect(log[1]).toBe(`${String(log[0]?.split(':')[0])}:end`);
  });
});

describe('the durable operator ledger (ADR-0003 §5)', () => {
  test('a token spent in one run is refused in a LATER run against the same ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-ledger-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    // ADR-shaped nonces (32 lowercase hex), because the durable ledger now
    // validates every record against that shape. Using the fixture's
    // human-readable nonce here would make this test pass for the WRONG
    // reason — refused as MALFORMED rather than refused as SPENT — and it
    // would stop testing the replay case it exists for.
    const nonce = '9'.repeat(32);
    const verified = {
      verifiedFor: (candidate: ApprovalSubject) =>
        Promise.resolve({
          nonce,
          state: { ...CLEAN_STATE, workspace: candidate.workspace },
        }),
    };
    const firstRun = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      approvals: verified,
      ledger: makeFileNonceLedger(ledgerPath),
    });
    const first = await withApprovedMutation(
      firstRun.authority,
      firstRun.subjectOf(TARGETS),
      writeSpy().run,
    );
    expect(first.status).toBe('ok');
    expect(readFileSync(ledgerPath, 'utf8')).toBe(`${nonce}\n`);
    // A fresh process would look exactly like this: a NEW authority over the
    // same operator ledger, with no memory of the first run.
    const secondRun = grantingAuthority({
      op: OP,
      workspace: WORKSPACE,
      targets: TARGETS,
      approvals: verified,
      ledger: makeFileNonceLedger(ledgerPath),
    });
    const replayWrite = writeSpy();
    const replay = await withApprovedMutation(
      secondRun.authority,
      secondRun.subjectOf(TARGETS),
      replayWrite.run,
    );
    expect(replay.status).toBe('needs-human');
    // Refused as SPENT — the ADR §5 replay case — not as malformed.
    expect(replay.status === 'needs-human' ? replay.reason : '').toContain('already consumed');
    expect(replayWrite.calls).toBe(0);
  });
});

// D1 (delta review): the scope brand is a RUNTIME symbol. `declare const
// ... : unique symbol` type-checked, emitted no binding, and threw
// `ReferenceError` at the mint — so every approved mutation would have
// faulted, and `tsc` said nothing. These pin that the brand and the live
// lifetime are real at runtime, not merely in the type system.
describe('the ExercisedScope capability is a real runtime capability', () => {
  test('a scope minted inside an approved mutation is LIVE and branded', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: ['src/a.ts'] });
    let seen: unknown;
    const outcome = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(['src/a.ts']),
      async (scope) => {
        seen = scope;
        // Liveness at the moment of use — this is the check that a
        // `declare const` brand would have made unreachable.
        expect(isExercisedScope(scope)).toBe(true);
        return 'written';
      },
    );
    expect(outcome.status).toBe('ok');
    // ...and NOT live once the section has settled and the lock released.
    expect(isExercisedScope(seen)).toBe(false);
  });

  test('a RETAINED scope is refused after its section ends — the brand outlives it, liveness does not', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: ['src/a.ts'] });
    let retained: unknown;
    await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(['src/a.ts']),
      async (scope) => {
        retained = scope;
        return 'written';
      },
    );
    // The brand still says "real scope"; only liveness has expired. A
    // brand-only check would happily honor this stale capability forever.
    expect(isExercisedScope(retained)).toBe(false);
  });

  test('a scope is RETIRED even when the write throws, so a failed section leaks no capability', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: ['src/a.ts'] });
    let captured: unknown;
    // The fault PROPAGATES out of withApprovedMutation (the lock is released
    // on the way out), so the assertion is on the promise, not on an awaited
    // result: awaiting first would throw here and never reach the retirement
    // check that is the actual subject of the test.
    await expect(
      withApprovedMutation(fixture.authority, fixture.subjectOf(['src/a.ts']), async (scope) => {
        captured = scope;
        throw new Error('the write faulted');
      }),
    ).rejects.toThrow('the write faulted');
    // ... and the scope captured on the way out is already dead.
    expect(isExercisedScope(captured)).toBe(false);
  });

  test('each section mints its OWN scope; a scope is never reused across sections', async () => {
    const minted: unknown[] = [];
    for (const attempt of [1, 2]) {
      // A DISTINCT subject per section, and therefore a distinct token. The
      // fixture's nonce is derived from the subject by design (ADR §5: one
      // token binds one op+inputs, and re-presenting it is the replay case),
      // so re-using one subject here would have the second section refused as
      // SPENT — the test would pass on the wrong count.
      const fixture = grantingAuthority({
        op: OP,
        workspace: WORKSPACE,
        targets: ['src/a.ts'],
        inputDigest: `sha256:section-${String(attempt)}`,
      });
      await withApprovedMutation(
        fixture.authority,
        fixture.subjectOf(['src/a.ts']),
        async (scope) => {
          minted.push(scope);
          return 'written';
        },
      );
    }
    expect(minted).toHaveLength(2);
    expect(minted[0]).not.toBe(minted[1]);
    for (const scope of minted) expect(isExercisedScope(scope)).toBe(false);
  });

  test('a scope carries the CANONICAL workspace and the approved targets it bounds', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: ['src/a.ts'] });
    let captured: ExercisedScope | undefined;
    await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(['src/a.ts']),
      async (scope) => {
        captured = scope;
        return 'written';
      },
    );
    // Captured before retirement, so these assert the mint's CONTENT.
    expect(captured?.op).toBe(OP);
    expect(captured?.targets).toEqual(['src/a.ts']);
    expect(captured?.workspace).toBe(canonicalWorkspace(WORKSPACE));
  });
});

describe('approvalInputDigest', () => {
  test('is stable across key order and sensitive to every input change', () => {
    expect(approvalInputDigest({ a: 1, b: [2, { d: 4, c: 3 }] })).toBe(
      approvalInputDigest({ b: [2, { c: 3, d: 4 }], a: 1 }),
    );
    expect(approvalInputDigest({ approved: true })).not.toBe(
      approvalInputDigest({ approved: false }),
    );
    expect(approvalInputDigest({ a: 1 })).not.toBe(approvalInputDigest({ a: 2 }));
    expect(approvalInputDigest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

/** A temporary git repository with one commit, for the real-state TOCTOU proof. */
function realRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cq-approval-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'approval@example.invalid']);
  git(dir, ['config', 'user.name', 'approval test']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.ts'), 'const x = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'the approved state']);
  return realpathOf(dir);
}

/** macOS temp dirs are symlinked (/var → /private/var); the reader realpaths, so bind the real one. */
function realpathOf(dir: string): string {
  return execFileSync('realpath', [dir], { encoding: 'utf8' }).trim();
}

/** Run `git` in `cwd`, failing loudly: a silently-unset git would fake the proof. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

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

describe('the operator ledger is durable before it reports a spend (ADR-0003 §4c step 2)', () => {
  test('the nonce is on disk, and the directory entry exists, when consume resolves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-durable-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const ledger = makeFileNonceLedger(ledgerPath);
    // Synchronous consumption is the observable half of the claim: by the
    // time the promise settles the bytes must be readable from the file, not
    // queued in a buffer. (The fdatasync/dir-fsync that make it survive a
    // POWER loss are not observable from a test process, and are not claimed
    // to be beyond the journal's own F_FULLFSYNC residual.)
    const nonce = 'e'.repeat(32);
    return ledger.consume(nonce).then((outcome) => {
      expect(outcome).toBe('consumed');
      expect(existsSync(ledgerPath)).toBe(true);
      expect(readFileSync(ledgerPath, 'utf8')).toBe(`${nonce}\n`);
      return ledger.consume(nonce);
    });
  });

  test('a SHORT write is looped to completion: the synced record is the whole nonce', async () => {
    // The reported edge: `fs.writeSync` returns a byte COUNT and may write
    // less than asked. A single unchecked call would fdatasync a truncated
    // line, report 'consumed', and leave the full nonce absent — so the
    // very same token would replay cleanly, which is the one outcome this
    // ledger exists to prevent.
    const dir = mkdtempSync(join(tmpdir(), 'cq-short-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const calls: number[] = [];
    const ledger = makeFileNonceLedger(ledgerPath, {
      // A writer that dribbles out five bytes at a time.
      write: (handle, buffer, offset, length) => {
        const count = Math.min(5, length);
        calls.push(count);
        return writeSync(handle, buffer, offset, count);
      },
    });
    const outcome = await ledger.consume('f'.repeat(32));
    expect(outcome).toBe('consumed');
    // It really did take several writes, and the file holds the WHOLE
    // record — not a prefix that would parse as a different nonce.
    expect(calls.length).toBeGreaterThan(1);
    expect(readFileSync(ledgerPath, 'utf8')).toBe(`${'f'.repeat(32)}\n`);
    // And the full nonce is genuinely spent, so the replay is refused.
    const replay = await ledger.consume('f'.repeat(32));
    expect(replay).toBe('spent');
  });

  test('a TORN partial record fails closed on the same instance AND a fresh one', async () => {
    // The corruption path. A short write that lands SOME bytes leaves a
    // partial record; because the next append is O_APPEND, the following
    // record would fuse onto it into a line matching NEITHER nonce, and a
    // fresh instance absorbing that merged line would not see the real nonce
    // as spent.
    const dir = mkdtempSync(join(tmpdir(), 'cq-torn-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const nonce = 'a'.repeat(32);
    // The writer lays down six bytes ONCE, honouring the offset and length
    // it is handed, and then makes no progress. (Writing six bytes on EVERY
    // call and returning 6 would be a different, broken fixture: writeAll
    // would keep looping while the writer re-wrote the same six bytes, and
    // the failure it eventually reported would be the over-report guard
    // rather than the no-progress one.)
    let calls = 0;
    const torn = makeFileNonceLedger(ledgerPath, {
      write: (handle, buffer, offset, length) => {
        calls += 1;
        if (calls > 1) return 0;
        const count = Math.min(6, length);
        writeSync(handle, buffer, offset, count);
        return count;
      },
    });
    // The consume itself FAILS: a partial record is never reported as a
    // consumption, which is the whole point.
    await expect(torn.consume(nonce)).rejects.toThrow(/made no progress/);
    // Exactly six bytes landed, and they are a PREFIX of the real nonce.
    expect(readFileSync(ledgerPath, 'utf8')).toBe(nonce.slice(0, 6));

    // The SAME instance refuses again, and so does a FRESH one (a new
    // process, a resumed run) — neither is allowed to read the torn bytes as
    // history. A malformed record fails the read closed, which is the guard
    // that fires first here: the partial bytes are not a valid nonce shape.
    await expect(torn.consume(nonce)).rejects.toThrow(/malformed/);
    const fresh = makeFileNonceLedger(ledgerPath);
    await expect(fresh.consume(nonce)).rejects.toThrow(/malformed/);
    // Neither refusal appended anything: the file is exactly as torn as it
    // was, so no record was fused and nothing was lost.
    expect(readFileSync(ledgerPath, 'utf8')).toBe(nonce.slice(0, 6));
  });

  test('a record that lost only its NEWLINE is refused by the torn-tail guard', async () => {
    // The realistic tear: every byte of the record landed, but the
    // terminating newline did not (the classic partial-write boundary, and
    // the case the append guard exists for). Here the record IS a
    // well-formed nonce, so the read succeeds and the TORN-TAIL guard is the
    // thing that must refuse — a distinct path from the malformed one.
    const dir = mkdtempSync(join(tmpdir(), 'cq-torn-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const other = 'b'.repeat(32);
    const nonce = 'c'.repeat(32);
    // 32 valid hex bytes, no newline.
    writeFileSync(ledgerPath, other);
    const ledger = makeFileNonceLedger(ledgerPath);
    // The SAME instance: the tail guard refuses the append.
    await expect(ledger.consume(nonce)).rejects.toThrow(/unterminated record/);
    // And a FRESH instance, which reads the unterminated record as a spent
    // nonce but still must not append onto it.
    const fresh = makeFileNonceLedger(ledgerPath);
    await expect(fresh.consume(nonce)).rejects.toThrow(/unterminated record/);
    // Nothing was appended by either refusal.
    expect(readFileSync(ledgerPath, 'utf8')).toBe(other);
  });

  test('a MALFORMED record fails the ledger closed (history is never read wrong)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-malformed-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    // A well-formed record followed by one that is not a nonce shape: the
    // fused-line outcome, or any external corruption. Reading it as history
    // would silently mark a nonce spent that was never spent (or vice
    // versa), so the whole read fails instead.
    writeFileSync(ledgerPath, `${'b'.repeat(32)}\nnot-a-nonce\n`);
    const ledger = makeFileNonceLedger(ledgerPath);
    await expect(ledger.consume('c'.repeat(32))).rejects.toThrow(/malformed/);
    // The well-formed record before it is not enough to make the read
    // succeed: one bad record invalidates the file's trustworthiness.
  });

  test('a well-formed ledger still works end to end (positive control for the validation)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-ok-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const first = makeFileNonceLedger(ledgerPath);
    const nonce = 'd'.repeat(32);
    expect(await first.consume(nonce)).toBe('consumed');
    // A fresh instance sees it spent — which is the whole point of the
    // ledger, and must survive the validation added above.
    const second = makeFileNonceLedger(ledgerPath);
    expect(await second.consume(nonce)).toBe('spent');
  });

  test('a write that cannot progress is REFUSED before any consumption is claimed', async () => {
    // Fail closed: a zero-byte write leaves an incomplete record, so the
    // ledger must throw and the op must refuse with the nonce UNSPENT —
    // never report 'consumed' for a record that is not on disk.
    const dir = mkdtempSync(join(tmpdir(), 'cq-short-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const ledger = makeFileNonceLedger(ledgerPath, {
      write: () => 0,
    });
    await expect(ledger.consume('0'.repeat(32))).rejects.toThrow(/made no progress/);
  });

  test('an over-reporting writer is refused too (it is not honouring the contract)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-short-'));
    const ledgerPath = join(dir, 'approvals.ndjson');
    const ledger = makeFileNonceLedger(ledgerPath, {
      write: (handle, buffer) => {
        writeSync(handle, buffer, 0, buffer.length);
        return buffer.length + 10;
      },
    });
    await expect(ledger.consume('1'.repeat(32))).rejects.toThrow(/not honouring/);
  });

  test('a short-write ledger still makes the op refuse rather than write (end to end, fail-closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-short-'));
    const ledger = makeFileNonceLedger(join(dir, 'approvals.ndjson'), { write: () => 0 });
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: '2'.repeat(32),
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader(),
    });
    const spy = writeSpy();
    const result = await withApprovedMutation(authority, subject(), spy.run);
    expect(result.status).toBe('needs-human');
    const reason = result.status === 'needs-human' ? result.reason : '';
    expect(reason).toContain('ledger');
    expect(reason).toContain('UNSPENT');
    expect(spy.calls).toBe(0);
  });
});

// Opus review (PR #258).
describe('lock-only sections, provider faults and nested lock domains', () => {
  test('withMutationLock hands its callback NO scope — a lock is not a spent approval', async () => {
    const { authority } = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: TARGETS });
    const held = await withMutationLock(authority, WORKSPACE, async (...args: unknown[]) =>
      args.some((arg) => isExercisedScope(arg)),
    );
    expect(held).toEqual({ ok: true, value: false });
  });

  test('a faulting verified-approval provider is a needs-human refusal, not a rejection', async () => {
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      approvals: { verifiedFor: () => Promise.reject(new Error('token snapshot unreadable')) },
      ledger,
      locks: makeProcessLocalMutationLocks(),
      readState: fixedStateReader(),
    });
    const spy = writeSpy();
    const outcome = await withApprovedMutation(authority, subject(), spy.run);
    expect(outcome.status).toBe('needs-human');
    expect(outcome.status === 'needs-human' ? outcome.reason : '').toContain(
      'token snapshot unreadable',
    );
    expect(spy.calls).toBe(0);
    expect(ledger.spent()).toBe(0);
  });

  test('nested containment roots inside one worktree share ONE mutation lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cq-domain-'));
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    const other = join(dir, 'other');
    mkdirSync(join(other, '.git'), { recursive: true });
    const locks = makeLedgerBesideMutationLocks(join(dir, 'state', 'approvals.ndjson'));
    expect(locks.forWorkspace(join(repo, 'src'))).toBe(locks.forWorkspace(repo));
    expect(locks.forWorkspace(other)).not.toBe(locks.forWorkspace(repo));
  });
});
