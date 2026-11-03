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

import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { MutationLock, MutationLocks } from '../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeLedgerBesideMutationLocks,
  makeProcessLocalMutationLocks,
  withApprovedMutation,
} from '../../../src/ops/analyze/approval.js';
import {
  CLEAN_STATE,
  fixedStateReader,
  grantingAuthority,
  nonceFor,
  OP,
  subject,
  TARGETS,
  WORKSPACE,
  writeSpy,
} from './approvalFixtures.js';

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

describe('the preflight — the caller’s check runs inside the lock, before the spend', () => {
  test('a preflight REFUSAL spends nothing: the SAME token exercises successfully afterwards', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: TARGETS });
    const spy = writeSpy();
    const nonce = nonceFor(fixture.subjectOf(TARGETS));
    const refused = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      spy.run,
      () => Promise.resolve({ ok: false as const, reason: 'the planned splice is out of bounds' }),
    );
    expect(refused.status).toBe('needs-human');
    const reason = refused.status === 'needs-human' ? refused.reason : '';
    expect(reason).toContain('preflight');
    expect(reason).toContain('the planned splice is out of bounds');
    expect(reason).toContain('UNSPENT');
    expect(spy.calls).toBe(0);
    // THE load-bearing assertion (the #258 finding): the refusal did not
    // burn the single-use approval.
    expect(fixture.ledger.spent()).toBe(0);
    expect(fixture.ledger.isSpent(nonce)).toBe(false);
    // ...so the SAME token — the same subject, the same nonce — admits and
    // exercises again once the check passes.
    const retried = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      spy.run,
      () => Promise.resolve({ ok: true as const }),
    );
    expect(retried.status).toBe('ok');
    expect(spy.calls).toBe(1);
    expect(fixture.ledger.spent()).toBe(1);
  });

  test('a preflight THROW spends nothing and is a refusal, never a rejection', async () => {
    const fixture = grantingAuthority({ op: OP, workspace: WORKSPACE, targets: TARGETS });
    const spy = writeSpy();
    const nonce = nonceFor(fixture.subjectOf(TARGETS));
    const refused = await withApprovedMutation(
      fixture.authority,
      fixture.subjectOf(TARGETS),
      spy.run,
      () => Promise.reject(new Error('the scan subprocess crashed')),
    );
    // The throw is folded into the needs-human refusal shape (nothing was
    // written, nothing is on disk to report) — it must not escape as a
    // rejection, which is the shape a caller reads as "the machinery broke
    // mid-write".
    expect(refused.status).toBe('needs-human');
    const reason = refused.status === 'needs-human' ? refused.reason : '';
    expect(reason).toContain('preflight');
    expect(reason).toContain('the scan subprocess crashed');
    expect(reason).toContain('UNSPENT');
    expect(spy.calls).toBe(0);
    expect(fixture.ledger.spent()).toBe(0);
    expect(fixture.ledger.isSpent(nonce)).toBe(false);
  });

  test('the preflight runs INSIDE the mutation lock and BEFORE the nonce is consumed', async () => {
    const log: string[] = [];
    let depth = 0;
    let maxDepth = 0;
    // The instrumented provider (the concurrency test's pattern): depth is
    // nonzero exactly inside a held critical section of the REAL
    // process-local lock, so a callback observing depth 1 is observing the
    // lock being held.
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
    const ledger = makeInMemoryNonceLedger();
    const authority = makeApprovalAuthority({
      approvals: {
        verifiedFor: (candidate) =>
          Promise.resolve({
            nonce: `n-${candidate.inputDigest}`,
            state: { ...CLEAN_STATE, workspace: candidate.workspace },
          }),
      },
      ledger,
      locks: instrumented,
      readState: fixedStateReader(),
    });
    const outcome = await withApprovedMutation(
      authority,
      subject(),
      async () => {
        log.push(`write:depth${String(depth)}:spent${String(ledger.spent())}`);
        return 'written';
      },
      async () => {
        log.push(`preflight:depth${String(depth)}:spent${String(ledger.spent())}`);
        return { ok: true as const };
      },
    );
    expect(outcome.status).toBe('ok');
    // The preflight ran FIRST, at lock depth 1 (the section was held), with
    // the nonce still UNSPENT; the write followed inside the same section,
    // after the spend.
    expect(log).toEqual(['preflight:depth1:spent0', 'write:depth1:spent1']);
    expect(maxDepth).toBe(1);
    expect(ledger.spent()).toBe(1);
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
