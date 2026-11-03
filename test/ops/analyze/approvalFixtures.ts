// Analyze lane W4.3 — the shared TEST authority fixture. Direct tests
// need a REAL `ApprovalAuthority` (the same code the ops call), not a stub
// that returns "granted": the load-bearing behavior under test is the
// state re-check, the single-use nonce and the mutation lock, and a stub
// would assert nothing about them. Only the two seams the offline suite
// cannot reach honestly are replaced — the workspace state reader (a fake
// `git status` answer, so no repository is needed) and the run's VERIFIED
// approvals (the kernel verifier's §4a/§4b output, which this patch
// deliberately does not implement).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InspectableNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import type {
  ApprovalAuthority,
  ApprovalState,
  ApprovalStateReader,
  ApprovalSubject,
  MutationLocks,
  VerifiedApprovals,
} from '../../../src/ops/analyze/approval.js';
import { makeInMemoryNonceLedger } from '../../../src/adapters/store/nonceLedger.js';
import {
  makeApprovalAuthority,
  makeProcessLocalMutationLocks,
} from '../../../src/ops/analyze/approval.js';

/** The state a test workspace claims until a test says otherwise. */
export const CLEAN_STATE: ApprovalState = {
  workspace: '/ws',
  headSha: 'head-at-approval',
  treeClean: true,
};

/** A state reader that answers a scripted sequence, one read per call. */
export function scriptedStateReader(states: readonly ApprovalState[]): ApprovalStateReader & {
  reads: number;
} {
  let index = 0;
  const reader = {
    reads: 0,
    read: (workspace: string): Promise<ApprovalState> => {
      reader.reads += 1;
      const next = states[Math.min(index, states.length - 1)] ?? CLEAN_STATE;
      index += 1;
      // A scripted state still binds the workspace it was asked about, so
      // a test that only cares about HEAD/treeClean does not have to repeat
      // the path in every fixture row.
      return Promise.resolve(next.workspace === '' ? { ...next, workspace } : next);
    },
  };
  return reader;
}

/** A state reader that always answers one fixed state. */
export function fixedStateReader(state: ApprovalState = CLEAN_STATE): ApprovalStateReader {
  return { read: () => Promise.resolve(state) };
}

/** A state reader whose read ALWAYS throws — the unreadable-state case. */
export const failingStateReader: ApprovalStateReader = {
  read: () => Promise.reject(new Error("git rev-parse HEAD failed in '/ws'")),
};

/**
 * The verified-approval seam: every subject gets a nonce derived from the
 * subject, carrying the state the "signed" claim was taken against. The
 * state is REQUIRED by the interface because a token without one cannot be
 * shown to cover anything (ADR-0003 §2) — a test that wants to model a
 * state the token does not describe must script the state reader, not drop
 * the field.
 */
export function alwaysVerifiedApprovals(state: ApprovalState = CLEAN_STATE): VerifiedApprovals {
  return {
    verifiedFor: (subject) =>
      Promise.resolve({
        nonce: nonceFor(subject),
        state: { ...state, workspace: subject.workspace },
      }),
  };
}

/** NO verified approvals: the A16 shape — nothing in the run's snapshot. */
export const noVerifiedApprovals: VerifiedApprovals = {
  verifiedFor: () => Promise.resolve(undefined),
};

/** The nonce a verified approval for `subject` carries (stable per subject). */
export function nonceFor(subject: ApprovalSubject): string {
  return `nonce-${subject.op}-${subject.inputDigest.slice(0, 12)}`;
}

/** What a test harness needs to inspect about the authority it composed. */
export interface ApprovalFixture {
  authority: ApprovalAuthority;
  ledger: InspectableNonceLedger;
  locks: MutationLocks;
  /** The subject the fixture's approvals match: the op, the workspace, the targets. */
  subjectOf: (targets: readonly string[]) => ApprovalSubject;
}

/** Options for {@link grantingAuthority}. */
export interface ApprovalFixtureOptions {
  op: string;
  workspace: string;
  /** The targets the fixture authorizes (an authorization binds its exact subject). */
  targets: readonly string[];
  /** The input digest the fixture authorizes; defaults to the test's `inputs` digest. */
  inputDigest?: string;
  state?: ApprovalState;
  readState?: ApprovalStateReader;
  approvals?: VerifiedApprovals;
  ledger?: InspectableNonceLedger;
  locks?: MutationLocks;
}

/**
 * A real authority that authorizes exactly one subject shape, composed the
 * way production composes it (a real ledger, a real lock provider, the real
 * `makeApprovalAuthority`), with only the state reader and the kernel's
 * verified-approval seam substituted.
 */
export function grantingAuthority(options: ApprovalFixtureOptions): ApprovalFixture {
  const state = options.state ?? { ...CLEAN_STATE, workspace: options.workspace };
  const subjectOf = (targets: readonly string[]): ApprovalSubject => ({
    op: options.op,
    workspace: options.workspace,
    targets: [...targets].sort(),
    inputDigest: options.inputDigest ?? 'sha256:test',
  });
  const ledger = options.ledger ?? makeInMemoryNonceLedger();
  const locks = options.locks ?? makeProcessLocalMutationLocks();
  const authority = makeApprovalAuthority({
    approvals:
      options.approvals ??
      ({
        verifiedFor: (candidate) =>
          Promise.resolve(
            candidate.op === options.op &&
              candidate.workspace === options.workspace &&
              candidate.inputDigest === (options.inputDigest ?? 'sha256:test')
              ? { nonce: nonceFor(candidate), state }
              : undefined,
          ),
      } satisfies VerifiedApprovals),
    ledger,
    locks,
    readState: options.readState ?? fixedStateReader(state),
  });
  return { authority, ledger, locks, subjectOf };
}

export const OP = 'analyze.applyRemediation';
export const WORKSPACE = '/ws';
export const TARGETS = ['src/a.ts'] as const;

export function subject(overrides: Partial<ApprovalSubject> = {}): ApprovalSubject {
  return {
    op: OP,
    workspace: WORKSPACE,
    targets: [...TARGETS],
    inputDigest: 'sha256:test',
    ...overrides,
  };
}

/** A write spy: records the call and reports what the op would have done. */
export function writeSpy(log: string[] = []): { calls: number; run: () => Promise<string> } {
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

/** A temporary git repository with one commit, for the real-state TOCTOU proof. */
export function realRepo(): string {
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
export function realpathOf(dir: string): string {
  return realpathSync(dir);
}

/** Run `git` in `cwd`, failing loudly: a silently-unset git would fake the proof. */
export function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
}
