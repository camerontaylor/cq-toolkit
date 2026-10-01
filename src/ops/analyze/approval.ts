// Analyze lane — the APPROVAL AUTHORITY (W4.3; ADR-0003 annex r1 §4b/§4c,
// §5, §6; resolves the O-5 / O-6 reconciliation rows and guards A16).
//
// THE DEFECT THIS MODULE EXISTS FOR. Until now the only thing standing
// between a plan and an on-disk remediation was a JSON boolean:
// `applyRemediation` read `input.approved === true` — a field ANY plan
// author, including an untrusted one composing plan JSON, writes
// themselves — and `playbookDispatch` self-satisfied that same boolean
// internally (playbooks/registry.ts, "approved: true ... satisfied
// INTERNALLY here"). Both are the A16 shape: an `approved: true` carrying
// no proof that a human looked at THIS op on THIS input in THIS workspace
// in THIS state. ADR-0003's answer is a signed, state-bound, SINGLE-USE
// approval capability, and this module owns the half of that contract the
// toolkit can own without the kernel seam:
//
//   §4b ADMISSION — "is there an approval for this exact subject in this
//                   run's snapshot?" Nothing is consumed. The grant minted
//                   here carries the state the approval was taken against.
//   §4c EXERCISE  — "under the workspace MUTATION LOCK, re-read the state,
//                   require it UNCHANGED, and check-and-append the nonce in
//                   ONE critical section." Only here is a token spent, and
//                   only here does a write follow. The lock is held THROUGH
//                   the write.
//
// The signature half (§4b steps 3–5: envelope, signer snapshot, `exp`/TTL,
// `inputsHash`) is the KERNEL verifier's: the run snapshots
// `CQ_APPROVAL_SIGNERS` and the operator ledger at `runPlan` start and
// admits jobs at the job gate. That wiring is NOT duplicated here, and the
// analyze ops registry adapter that would bind it belongs to #238 (out of
// this patch's scope). What this module consumes is the *verified* seam
// {@link VerifiedApprovals.nonceFor}: "the nonce of the token this run's
// verifier already accepted for this exact subject, or none". An authority
// built over the default {@link DENY_ALL_APPROVALS} therefore authorizes
// NOTHING — which is the fail-closed state the shared registry adapter is
// in until the kernel wiring lands: a plan-JSON `approved: true` reaches
// the mutation boundary and is refused `needs-human` over an untouched
// workspace (A16).
//
// O-5 (WHERE THE MUTATION LOCK RECORD LIVES — open in ADR-0003 §4c; the
// question the annex flagged and would not answer). RESOLVED HERE, by
// construction rather than by preference: the record lives BESIDE the
// operator approval ledger in the P1-trusted layer, keyed on
// `sha256(realpath(workspace))` ({@link makeLedgerBesideMutationLocks}).
// Both rejected candidates are excluded on evidence, not taste: an
// environment-derived location (`os.tmpdir()`, `$XDG_STATE_HOME`)
// reintroduces ADR §2.5's split-brain (contenders computing different
// "everybody agrees on this" records), and a record inside the workspace is
// tamper vector #26 — the very tree the approval is about. The default
// {@link makeProcessLocalMutationLocks} is honest about what it is: a
// process-local serialization with NO cross-process claim, for tests and
// single-process callers, never a substitute for the ledger-beside record.
//
// O-6 (DO NON-APPROVAL WRITERS TAKE THIS LOCK? — open in ADR-0003 §4c step
// 4, the closing rule the critic deferred to ADR §2.7). RESOLVED HERE for
// the remediation path, and only here: EVERY write these two ops perform is
// approval-required and holds the mutation lock, so the path contains no
// non-approval writer to co-schedule against — the closing rule is vacuous
// rather than unresolved. A concurrent writer OUTSIDE the lock is not made
// safe by this module: that is ADR §2.7's open residual (a
// post-mutation-hook hazard), recorded as such in the family NOTES. No
// non-approval writer was modified here to pretend otherwise.
//
// THE ORDERING INVARIANT. `exercise` re-reads the state INSIDE the lock and
// spends INSIDE the same lock hold, so check and spend are one critical
// section: two concurrent exercises of two grants cannot interleave
// read-then-spend, and a grant whose state moved between admission and
// exercise is refused with its nonce LEFT UNSPENT (§7's TOCTOU case — a
// refused op must not burn a human's approval).
//
// I/O discipline: the state reader spawns git through `execFile` with the
// ratchet lane's hardened argv and a scrubbed child env, because a state
// read a repo-local config redirect could answer wrongly is not a state
// read. Every seam is injectable, so the direct tests never spawn anything.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { GIT_HARDEN } from '../ratchet/git.js';
import { makeGitMutex } from '../sweep/gitMutex.js';

/** The workspace state an approval binds to (ADR-0003 §2 `state`, §4c step 1). */
export interface ApprovalState {
  /** The `realpath`'d workspace the approval was taken against. */
  readonly workspace: string;
  /** `git rev-parse HEAD` at read time. */
  readonly headSha: string;
  /** The STRICT clean predicate: `git status --porcelain=v1 --untracked-files=all` empty. */
  readonly treeClean: boolean;
}

/** The subject an approval must bind to: this op, these inputs, this workspace. */
export interface ApprovalSubject {
  /** The op name, e.g. `analyze.applyRemediation`. */
  readonly op: string;
  /** The containment root the mutation would land in. */
  readonly workspace: string;
  /** The files the mutation would touch, sorted and deduplicated by the caller. */
  readonly targets: readonly string[];
  /** A digest binding the op's exact inputs (the op-level stand-in for the kernel's `inputsHash`). */
  readonly inputDigest: string;
}

/**
 * The in-process capability (ADR-0003 §6): minted only by
 * {@link ApprovalAuthority.admit}, non-serializable by construction (it
 * never crosses a JSON boundary — a plan cannot carry one), and carrying
 * the state the approval was taken against so the exercise can re-check it.
 */
export interface ApprovalGrant {
  readonly subject: ApprovalSubject;
  /** The verified token's nonce — the single-use identity. */
  readonly nonce: string;
  /** The state read at ADMISSION; the exercise re-reads and compares. */
  readonly state: ApprovalState;
}

/** §4b's answer: a grant to carry to the mutation, or a specific refusal. */
export type ApprovalAdmission =
  | { readonly granted: true; readonly grant: ApprovalGrant }
  | { readonly granted: false; readonly reason: string };

/** §4c's answer: the nonce is spent, or a specific refusal (nothing is spent). */
export type ApprovalExercise =
  | { readonly granted: true; readonly consumed: { readonly nonce: string } }
  | { readonly granted: false; readonly reason: string };

/** The approval seam an op takes: admission at the gate, exercise at the mutation. */
export interface ApprovalAuthority {
  /**
   * §4b — is there an approval for this exact subject in this run's
   * snapshot? NEVER consumes: an op refused after this point (unknown
   * cluster, scan fault, collision, dry-run) leaves the token unspent.
   */
  admit(subject: ApprovalSubject): Promise<ApprovalAdmission>;
  /**
   * §4c — re-check the state and consume the nonce atomically. MUST be
   * called under the workspace mutation lock, and the lock MUST be held
   * through the following write; {@link withApprovedMutation} is the only
   * caller shape that does both, and a bare `exercise` elsewhere is a
   * caller bug this module cannot detect.
   */
  exercise(grant: ApprovalGrant, subject: ApprovalSubject): Promise<ApprovalExercise>;
}

/** The mutation lock guarding one workspace's mutations. */
export interface MutationLock {
  withLock<T>(fn: () => T | Promise<T>): Promise<T>;
}

/** The lock provider: workspace → the lock guarding that workspace's mutations. */
export interface MutationLocks {
  forWorkspace(workspace: string): MutationLock;
}

/**
 * The default authority: DENY EVERYTHING, with the reason a caller needs in
 * order to act. Every op factory in this family defaults to it, so the ops
 * as the (frozen, #238-owned) registry composes them today refuse every
 * write — `needs-human`, no I/O — until the kernel's verified-approval
 * seam is bound. That is the honest staging of W4.3, not a regression: the
 * alternative is the boolean this patch exists to remove.
 */
export const DENY_ALL_APPROVALS: ApprovalAuthority = {
  admit: (subject) =>
    Promise.resolve({
      granted: false as const,
      reason: denyReason(subject, 'no approval authority is bound to this op'),
    }),
  exercise: (_grant, subject) =>
    Promise.resolve({
      granted: false as const,
      reason: denyReason(subject, 'no approval authority is bound to this op'),
    }),
};

/** The denial wording, naming the workspace, the op, and that nothing was written. */
function denyReason(subject: ApprovalSubject, why: string): string {
  return (
    `approval refused: ${why} — an 'approved: true' flag in plan JSON is a DECLARED INTENT, ` +
    `never a proof: writing to '${subject.workspace}' needs a signed approval token (ADR-0003) ` +
    `issued for op '${subject.op}' on these exact inputs in this exact workspace state. ` +
    `Nothing was written.`
  );
}

/**
 * The run's VERIFIED approvals (the kernel verifier's output: ADR-0003 §4a's
 * snapshot plus §4b steps 3–5). Returning a nonce asserts that a token has
 * ALREADY verified against this EXACT subject — signature, kid, TTL and
 * `inputsHash` are upstream and are not re-implemented here.
 */
export interface VerifiedApprovals {
  nonceFor(subject: ApprovalSubject): Promise<string | undefined>;
}

/**
 * The single-use nonce store (ADR-0003 §5's operator ledger). `consume` is a
 * CHECK-AND-APPEND in one critical section: `'spent'` means an earlier
 * consume — this process, or a previous run against the durable ledger —
 * already spent the nonce. Implementations MUST be linearizable across
 * concurrent callers.
 */
export interface NonceLedger {
  consume(nonce: string): Promise<'consumed' | 'spent'>;
}

/** A ledger that can also answer the "left UNSPENT" question the tests assert. */
export interface InspectableNonceLedger extends NonceLedger {
  /** How many nonces are spent. */
  spent(): number;
  /** True when this nonce is spent (read-only; never consumes). */
  isSpent(nonce: string): boolean;
}

/**
 * The process-local ledger. HONEST SCOPE, stated because it is the easiest
 * thing here to overclaim: it makes a token single-use for the lifetime of
 * one process and NO LONGER. A fresh process is exactly ADR §5's "same
 * host, fresh `--journal-dir`" case, which the DURABLE ledger is required
 * to block. Use {@link makeFileNonceLedger} wherever the ledger path is
 * known.
 */
export function makeInMemoryNonceLedger(): InspectableNonceLedger {
  const spent = new Set<string>();
  return {
    consume: async (nonce) => {
      if (spent.has(nonce)) return 'spent';
      spent.add(nonce);
      return 'consumed';
    },
    spent: () => spent.size,
    isSpent: (nonce) => spent.has(nonce),
  };
}

/**
 * The DURABLE operator ledger (ADR-0003 §5): an append-only NDJSON file in
 * the P1-trusted layer, one nonce per line, re-read on every consume so a
 * nonce spent by an earlier run — or by a concurrent process — is refused.
 * Synchronous by design: the append IS the durability point, and a buffered
 * append would make ADR §4c's crash analysis ("a crash between step 2 and
 * step 3 burns the token — safe") untrue.
 *
 * Concurrency, stated because it is a real precondition: the
 * read-then-append is not atomic on its own, so this ledger is correct only
 * when `consume` runs inside the mutation lock for the same workspace —
 * which is exactly where {@link ApprovalAuthority.exercise} calls it. A
 * caller who lifts the ledger out of the lock reopens a replay window.
 */
export function makeFileNonceLedger(path: string): InspectableNonceLedger {
  const known = new Set<string>();
  const absorb = (): void => {
    // Fresh read every time: the in-process set is a CACHE of a file another
    // process may have appended since. A missing file is an empty ledger
    // (nothing spent yet); an unreadable one throws and the exercise fails
    // closed, which is the fail-closed direction ADR §4c wants.
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const nonce = line.trim();
      if (nonce !== '') known.add(nonce);
    }
  };
  return {
    consume: async (nonce) => {
      absorb();
      if (known.has(nonce)) return 'spent';
      appendFileSync(path, `${nonce}\n`, { encoding: 'utf8' });
      known.add(nonce);
      return 'consumed';
    },
    spent: () => {
      absorb();
      return known.size;
    },
    isSpent: (nonce) => {
      absorb();
      return known.has(nonce);
    },
  };
}

/**
 * PROCESS-LOCAL locks (honest scope: one process, no cross-process claim).
 * Serializes on a promise chain per workspace key, so two ops mutating one
 * workspace in one process cannot interleave their exercise-then-write
 * critical sections. It is NOT a lock file, makes no durability claim, and
 * is deliberately not a second implementation of ADR §2.5's cross-process
 * plan lock — that primitive is W2.4's, and duplicating it here is the
 * "duplicate lock subsystem" the plan forbids. Real multi-process callers
 * use {@link makeLedgerBesideMutationLocks}.
 */
export function makeProcessLocalMutationLocks(): MutationLocks {
  const chains = new Map<string, Promise<unknown>>();
  return {
    forWorkspace: (workspace) => ({
      withLock: async <T>(fn: () => T | Promise<T>): Promise<T> => {
        const key = workspaceKey(workspace);
        const previous = chains.get(key) ?? Promise.resolve();
        // The chain link is created SYNCHRONOUSLY, so a second caller
        // arriving before the first section settles queues behind it rather
        // than opening a parallel section. A previous section's FAULT still
        // runs the next one (the branch below), because a failed mutation
        // must not wedge the workspace for the rest of the process.
        const run = previous.then(
          () => fn(),
          () => fn(),
        );
        chains.set(
          key,
          run.then(
            () => undefined,
            () => undefined,
          ),
        );
        return run;
      },
    }),
  };
}

/**
 * The O-5 RESOLUTION: one cross-process mutation lock per workspace whose
 * RECORD lives beside the operator approval ledger in the P1-trusted layer
 * and never inside the workspace, keyed on
 * `sha256(realpath(workspace))` — so two paths to one tree share one lock
 * and one tree never gets two. The primitive is the sweep lane's existing
 * git mutex (the same proper-lockfile discipline the ledger store and the
 * worktree safety code use), NOT a new lock subsystem.
 */
export function makeLedgerBesideMutationLocks(ledgerPath: string): MutationLocks {
  const trustedDir = realpathOrSelf(dirname(ledgerPath));
  const cache = new Map<string, MutationLock>();
  return {
    forWorkspace: (workspace) => {
      const key = workspaceKey(workspace);
      const existing = cache.get(key);
      if (existing !== undefined) return existing;
      const mutex = makeGitMutex({ lockPath: join(trustedDir, `mutation-${key}.lock`) });
      cache.set(key, mutex);
      return mutex;
    },
  };
}

/** `sha256(realpath(workspace))`, hex-truncated to 32 — the O-5 lock key. */
function workspaceKey(workspace: string): string {
  return createHash('sha256').update(realpathOrSelf(workspace)).digest('hex').slice(0, 32);
}

/** `realpath` when the path exists, else the path itself (the read fails closed downstream). */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Reads the workspace state an approval binds to. */
export interface ApprovalStateReader {
  read(workspace: string): Promise<ApprovalState>;
}

/**
 * The real state reader: `realpath`, `git rev-parse HEAD`, and the STRICT
 * clean predicate — `git status --porcelain=v1 --untracked-files=all` empty,
 * so an UNTRACKED file counts as dirty. Ignored files are out of scope,
 * which ADR-0003 §4c records as a stated residual (an ignored file can
 * still influence a codemod that reads it).
 *
 * Every fault THROWS; the exercise catches it and refuses `needs-human`. An
 * unreadable state is never treated as "unchanged" — that inversion is
 * exactly how a TOCTOU becomes a bypass.
 */
export function makeGitApprovalStateReader(): ApprovalStateReader {
  return {
    read: async (workspace) => {
      const root = realpathSync(workspace);
      const headSha = await git(root, ['rev-parse', 'HEAD']);
      const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
      return { workspace: root, headSha, treeClean: status === '' };
    },
  };
}

/** Env redirections that could answer a state read from a different repository. */
const SCRUBBED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_NAMESPACE',
  'GIT_REPLACE_REF_BASE',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
];

/** One read-only git command over the hardened argv and a scrubbed env; trimmed stdout. */
async function git(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_NO_REPLACE_OBJECTS'] = '1';
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      [...GIT_HARDEN, '-C', cwd, ...args],
      { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (err, stdout) => {
        if (err !== null) {
          rejectPromise(
            new Error(`approval state: git ${args.join(' ')} failed in '${cwd}' — ${err.message}`),
          );
          return;
        }
        resolvePromise(stdout.trim());
      },
    );
  });
}

/** The seams {@link makeApprovalAuthority} composes; every one is injectable. */
export interface ApprovalAuthorityConfig {
  /** The run's verified approvals (the kernel's §4a/§4b output). */
  approvals: VerifiedApprovals;
  /** The single-use nonce store (§5). */
  ledger: NonceLedger;
  /** The mutation locks (O-5's record location, O-6's critical section). */
  locks: MutationLocks;
  /** Defaults to the real git reader. */
  readState?: ApprovalStateReader;
  /**
   * When set, the P1-trusted layer's directory. A trusted layer INSIDE the
   * workspace under approval is refused (tamper vector #26: the subject
   * would be able to edit the record that spends its own approval).
   */
  trustedLayerDir?: string;
}

/** The lock provider an authority was built with, reachable for the write-through lock. */
const LOCKS = Symbol('cq.approval.locks');

/** An authority plus the lock provider {@link withApprovedMutation} needs. */
type BoundAuthority = ApprovalAuthority & { [LOCKS]: MutationLocks };

/**
 * Build the authority: §4b admission, §4c exercise — the latter's two steps
 * in one critical section, under the mutation lock the same authority hands
 * to {@link withApprovedMutation}.
 *
 * Admission mints a grant carrying the state read AT ADMISSION: the human
 * approved THAT state, and the exercise's whole job is to prove the
 * workspace still is it. A state read that faults at admission refuses; a
 * state read that faults at exercise refuses too, with the nonce UNSPENT.
 *
 * AT-MOST-ONCE, both senses (ADR-0003 §6): a second `exercise` of one grant
 * THROWS (a silent second success would spend one human decision twice),
 * and a grant whose exercise was REFUSED is retired as well — a caller that
 * retries the same grant after a refusal gets the throw, not a retry.
 */
export function makeApprovalAuthority(config: ApprovalAuthorityConfig): ApprovalAuthority {
  const readState = config.readState ?? makeGitApprovalStateReader();
  const locks = config.locks;
  const exercised = new WeakSet<object>();
  const authority: BoundAuthority = {
    [LOCKS]: locks,
    admit: async (subject) => {
      const inadmissible = preAdmissionFault(subject, config.trustedLayerDir);
      if (inadmissible !== null) {
        return {
          granted: false,
          reason: `approval refused: ${inadmissible}; nothing was written and no token was spent`,
        };
      }
      let state: ApprovalState;
      try {
        state = await readState.read(subject.workspace);
      } catch (err) {
        return {
          granted: false,
          reason: `approval refused: the workspace state could not be read — ${messageOf(err)}; an unreadable state is never treated as unchanged, and nothing was written`,
        };
      }
      const nonce = await config.approvals.nonceFor(subject);
      if (nonce === undefined || nonce === '') {
        return {
          granted: false,
          reason: denyReason(
            subject,
            'no verified approval token was issued for this op on these exact inputs in this exact workspace state',
          ),
        };
      }
      return { granted: true, grant: { subject, nonce, state } };
    },
    exercise: async (grant, subject) => {
      if (exercised.has(grant)) {
        throw new Error(
          `approval: the grant for '${subject.op}' was already exercised — a grant is single-use (ADR-0003 §6); re-admit instead of re-exercising`,
        );
      }
      if (!sameSubject(grant.subject, subject)) {
        return {
          granted: false,
          reason: `approval refused: the granted subject (op '${grant.subject.op}', digest '${grant.subject.inputDigest}') is not the subject being written (op '${subject.op}', digest '${subject.inputDigest}') — a grant covers exactly the inputs it was issued for, and nothing was written`,
        };
      }
      // Retired on ATTEMPT, not on success: after this point the grant is
      // spent as a capability whether or not the nonce was.
      exercised.add(grant);
      let state: ApprovalState;
      try {
        state = await readState.read(subject.workspace);
      } catch (err) {
        return {
          granted: false,
          reason: `approval state changed since approval: the workspace state could not be re-read under the mutation lock — ${messageOf(err)}; nothing was written and the token is UNSPENT`,
        };
      }
      const drift = stateDrift(grant.state, state);
      if (drift !== null) {
        return {
          granted: false,
          reason: `approval state changed since approval: ${drift} — the approval was issued against a different workspace state, so the write is refused; nothing was written and the token is UNSPENT`,
        };
      }
      let outcome: 'consumed' | 'spent';
      try {
        outcome = await config.ledger.consume(grant.nonce);
      } catch (err) {
        return {
          granted: false,
          reason: `approval refused: the approval ledger could not be read or appended — ${messageOf(err)}; the ledger is fail-closed, so nothing was written and the token is UNSPENT`,
        };
      }
      if (outcome === 'spent') {
        return {
          granted: false,
          reason:
            'approval refused: this approval token was already consumed (nonce spent) — a token grants one write and a replay is refused; nothing was written',
        };
      }
      return { granted: true, consumed: { nonce: grant.nonce } };
    },
  };
  return authority;
}

/** The op-facing result: the write happened under a spent approval, or it did not happen. */
export type ApprovedMutation<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'needs-human'; readonly reason: string };

/**
 * The mutation seam an op calls INSTEAD of writing: admit (nothing spent),
 * then — under the workspace mutation lock — exercise (state re-check plus
 * the atomic nonce spend) and the write, with the lock held THROUGH the
 * write (ADR-0003 §4c). The lock is released on every exit, and a `write`
 * that throws releases it too and rethrows, so a lock fault is never
 * mistaken for an approval refusal and a refusal is never mistaken for a
 * write.
 *
 * This is the ONLY caller shape that can produce a write: there is no path
 * from a plan JSON `approved: true` to a byte on disk that does not pass a
 * check-and-spend under the lock first.
 */
export async function withApprovedMutation<T>(
  authority: ApprovalAuthority,
  subject: ApprovalSubject,
  write: () => Promise<T>,
): Promise<ApprovedMutation<T>> {
  const admitted = await authority.admit(subject);
  if (!admitted.granted) return { status: 'needs-human', reason: admitted.reason };
  const locks = (authority as Partial<BoundAuthority>)[LOCKS];
  if (locks === undefined) {
    return {
      status: 'needs-human',
      reason:
        'approval refused: the authority exposes no mutation lock, so the state re-check could not be atomic with the write; nothing was written and the token is UNSPENT',
    };
  }
  return locks.forWorkspace(subject.workspace).withLock(async () => {
    const exercised = await authority.exercise(admitted.grant, subject);
    if (!exercised.granted) return { status: 'needs-human', reason: exercised.reason };
    return { status: 'ok', value: await write() };
  });
}

/** A structural admission fault (no state read, no token lookup), or null when admissible. */
function preAdmissionFault(
  subject: ApprovalSubject,
  trustedLayerDir: string | undefined,
): string | null {
  if (subject.targets.length === 0) {
    return 'the mutation has no target files — there is nothing to approve, and an approval over an empty target set would bind nothing';
  }
  if (trustedLayerDir !== undefined && isInside(trustedLayerDir, subject.workspace)) {
    return `the trusted approval layer '${trustedLayerDir}' is inside the workspace under approval ('${subject.workspace}') — the subject would be able to edit the record that spends its own approval`;
  }
  return null;
}

/** True when `child` is `parent` or resolves strictly inside it. */
function isInside(parent: string, child: string): boolean {
  const realParent = realpathOrSelf(parent);
  const realChild = realpathOrSelf(child);
  const prefix = realParent.endsWith(sep) ? realParent : realParent + sep;
  return realChild === realParent || realChild.startsWith(prefix);
}

/** The exact-subject comparison: op, workspace, targets and the input digest. */
function sameSubject(a: ApprovalSubject, b: ApprovalSubject): boolean {
  return (
    a.op === b.op &&
    a.workspace === b.workspace &&
    a.inputDigest === b.inputDigest &&
    a.targets.length === b.targets.length &&
    a.targets.every((target, index) => target === b.targets[index])
  );
}

/** The first drift between the approved state and the current one, or null. */
function stateDrift(approved: ApprovalState, current: ApprovalState): string | null {
  if (approved.workspace !== current.workspace) {
    return `workspace ${current.workspace} ≠ ${approved.workspace}`;
  }
  if (approved.headSha !== current.headSha) {
    return `HEAD ${current.headSha} ≠ ${approved.headSha}`;
  }
  if (approved.treeClean !== current.treeClean) {
    return current.treeClean
      ? 'the tree is clean again, but it was dirty at approval'
      : 'the tree is dirty (an untracked file counts)';
  }
  return null;
}

/**
 * The op-level input digest binding an approval to the EXACT inputs of one
 * invocation: a sha256 over a canonical JSON rendering (keys sorted at every
 * level, `undefined` members dropped), so two structurally identical
 * invocations hash identically and ANY input change — including
 * `approved` itself — changes the digest. This is the analyze family's
 * stand-in for the kernel's manifest `inputsHash`; when the kernel
 * verifier is bound (S's wiring) the manifest hash is authoritative and
 * this one is redundant, never weaker.
 */
export function approvalInputDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/** Canonical JSON: object keys sorted at every depth, `undefined` members dropped. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
    .join(',')}}`;
}

/** Error message of an unknown throwable, for refusal reasons. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
