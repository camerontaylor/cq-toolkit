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
// operator approval ledger in the P1-trusted layer, keyed on the sha256 of
// the workspace's enclosing git worktree root ({@link makeLedgerBesideMutationLocks}).
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
// the remediation path: approved writes and rollback take the SAME workspace
// mutation lock. Rollback restores targets only when their post-apply
// fingerprint still matches, so an intervening approved write is not silently
// discarded. A concurrent writer OUTSIDE the lock is not made safe by this
// module: that is ADR §2.7's open residual (a post-mutation-hook hazard),
// recorded as such in the family NOTES.
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
import { messageOf } from '../../shared/messageOf.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GIT_HARDEN } from '../../shared/gitHarden.js';
import { realpathOrSelf } from '../../adapters/store/nonceLedger.js';
import { makeGitMutex } from '../../shared/gitMutex.js';
import { markdownFileName, sidecarFileName } from './renderAnalysisReport.js';

/**
 * The single-use nonce store (ADR-0003 §5's operator ledger) — DEFINED HERE,
 * owned by ops like the approval authority that consumes it: the file-backed
 * adapter imports this type to implement it (adapters → ops, ADR-0005:27) —
 * never the reverse, so the Phase 2 package split cannot form an
 * ops→adapters declaration edge through {@link ApprovalAuthorityConfig}
 * (PR #335 review, Codex P1). `consume` is a CHECK-AND-APPEND in one
 * critical section: `'spent'` means an earlier consume — this process, or a
 * previous run against the durable ledger — already spent the nonce.
 * Implementations MUST be linearizable across concurrent callers.
 */
export interface NonceLedger {
  consume(nonce: string): Promise<'consumed' | 'spent'>;
}

/** The workspace state an approval binds to (ADR-0003 §2 `state`, §4c step 1). */
export interface ApprovalState {
  /** The `realpath`'d workspace the approval was taken against. */
  readonly workspace: string;
  /** `git rev-parse HEAD` at read time. */
  readonly headSha: string;
  /** Strict Git cleanliness, with only the verified applyRemediation report pair exempted. */
  readonly treeClean: boolean;
  /**
   * INFORMATIONAL ONLY: the workspace-relative paths that made `treeClean`
   * false (at most a handful), so a refusal can name what to commit or stash.
   * Never compared by the drift check and never a basis for a grant; absent
   * when the tree is clean or the reader does not report them.
   */
  readonly dirtyPaths?: readonly string[];
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
  /**
   * Only applyRemediation's exact rendered pair, bound into inputDigest.
   * The real reader verifies the paths, bytes and scan-target separation
   * at BOTH state reads; this is never a caller-supplied glob/ignore rule.
   */
  readonly analysisReports?: {
    readonly fingerprint: string;
    readonly sidecarSha256: string;
    readonly markdownSha256: string;
    readonly scanTargets: readonly string[];
  };
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
 * What the KERNEL verifier hands this module: the nonce of a token it has
 * ALREADY verified, together with the `state` that token was SIGNED AGAINST
 * (ADR-0003 §2 — `state` is MANDATORY for a mutating op, and it is the
 * approver's view of the workspace, not this module's).
 *
 * The state is carried because dropping it would open a window the module
 * cannot see: the kernel's signature check and this op's admission are two
 * separate moments, and a workspace mutated BETWEEN them would otherwise
 * have the post-mutation state silently adopted as the baseline the
 * exercise then re-checks against. Carrying the signed state lets
 * {@link ApprovalAuthority.admit} compare "what the human approved" against
 * "what the workspace is now" itself, and refuse the gap.
 *
 * INTEGRATION CONTRACT for the kernel owner (#238's adapter): `state` MUST
 * be the `state` field of the VERIFIED claim — not a re-read at the moment
 * of the call, which would collapse the two moments back into one and
 * restore exactly the window this field exists to close. An adapter that
 * cannot supply it must return undefined (refusal), not a best guess.
 */
export interface VerifiedApproval {
  /** The verified token's nonce — the single-use identity. */
  readonly nonce: string;
  /** The state the SIGNED claim carries, per ADR-0003 §2. */
  readonly state: ApprovalState;
}

/** The run's VERIFIED approvals (the kernel verifier's output: ADR-0003 §4a's snapshot plus §4b steps 3–5). */
export interface VerifiedApprovals {
  /** The verified approval for this EXACT subject, or none. */
  verifiedFor(subject: ApprovalSubject): Promise<VerifiedApproval | undefined>;
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
 * and never inside the workspace, keyed on the sha256 of the workspace's
 * enclosing git worktree root — so two paths to one tree, and two nested
 * containment roots inside one tree, share one lock and one tree never gets
 * two. The primitive is the sweep lane's existing
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
      // NO `.lock` suffix here: makeGitMutex derives the on-disk artifact as
      // `${lockPath}.lock` (proper-lockfile's documented convention, same as
      // the guided `<repoRoot>/.cq/git-mutex.lock` default), so spelling the
      // extension at the call site produced `mutation-<key>.lock.lock` — two
      // artifacts for one lock, and an O-5 record whose name misdescribes it.
      const mutex = makeGitMutex({
        lockPath: join(trustedDir, `mutation-${key}`),
      });
      cache.set(key, mutex);
      return mutex;
    },
  };
}

/**
 * `sha256(lockDomain(workspace))`, hex-truncated to 32 — the O-5 lock key.
 * The domain is the enclosing git worktree root, NOT the supplied path:
 * containment roots nest (`/repo` with target `src/a.ts`, `/repo/src` with
 * target `a.ts` name one file), and keying on the supplied path would give
 * those two approvals two locks over the same bytes.
 */
function workspaceKey(workspace: string): string {
  return createHash('sha256').update(lockDomain(workspace)).digest('hex').slice(0, 32);
}

/**
 * The OUTERMOST ancestor-or-self of the canonical workspace holding a `.git`
 * entry (a directory, or the file a linked worktree or submodule carries).
 * Outermost, not nearest: a submodule or nested checkout is reachable both
 * through its own root and through the parent's, so the nearest `.git` would
 * give one physical file two lock domains. The outer root is the one domain
 * every path to those bytes shares; over-sharing only serializes, which is the
 * safe direction. A workspace outside any repository is its own domain.
 */
function lockDomain(workspace: string): string {
  const canonical = realpathOrSelf(workspace);
  let outermost = canonical;
  for (let dir = canonical; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) outermost = dir;
    if (dirname(dir) === dir) return outermost;
  }
}

/** Reads the workspace state an approval binds to. */
export interface ApprovalStateReader {
  read(workspace: string, subject?: ApprovalSubject): Promise<ApprovalState>;
}

/**
 * The real state reader: `realpath`, `git rev-parse HEAD`, and the STRICT
 * clean predicate — `git status --porcelain=v1 --untracked-files=all
 * --ignore-submodules=none` empty, so an UNTRACKED file counts as dirty and a
 * submodule cannot opt itself out — plus a refusal of any index entry flagged
 * assume-unchanged or skip-worktree, which that status would not inspect.
 * applyRemediation may supply a byte-verified exact report pair for the
 * narrow untracked-only exception below. Other subjects use the strict
 * predicate unchanged. Ignored files are out of scope, which ADR-0003 §4c
 * records as a stated residual (an ignored file can still influence a codemod that reads it).
 *
 * Every fault THROWS; the exercise catches it and refuses `needs-human`. An
 * unreadable state is never treated as "unchanged" — that inversion is
 * exactly how a TOCTOU becomes a bypass.
 */
export function makeGitApprovalStateReader(
  options: GitApprovalStateReaderOptions = {},
): ApprovalStateReader {
  const exempt = normalizeExemptPrefixes(options.exempt ?? []);
  return {
    read: async (workspace, subject) => {
      const root = realpathSync(workspace);
      const headSha = await git(root, ['rev-parse', 'HEAD']);
      // `--ignore-submodules=none` overrides a committed `ignore = all` in
      // .gitmodules, which would otherwise hide changed bytes inside a
      // submodule from the clean predicate.
      const status = await git(
        root,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
        true,
      );
      // INDEX FLAGS CAN HIDE BYTES FROM `git status`. An entry marked
      // `assume-unchanged` (also what `core.ignoreStat` sets on add) or
      // `skip-worktree` (sparse checkout, or set by hand) is never compared
      // against the working tree, so its file can be edited while the status
      // above stays empty — a "clean" state over bytes the approver never
      // saw. Such an entry makes the state UNREADABLE (a throw, so admission
      // and exercise both refuse with the token unspent), never clean.
      const hidden = indexHiddenEntries(await git(root, ['ls-files', '-v', '-z']));
      if (hidden.length > 0) {
        const named = hidden.slice(0, 5).map((file) => `'${file}'`);
        if (hidden.length > 5) named.push('…');
        throw new Error(
          `${String(hidden.length)} index entr${hidden.length === 1 ? 'y is' : 'ies are'} flagged assume-unchanged or skip-worktree (${named.join(', ')}) — git status does not compare such files against the working tree, so a clean status cannot prove their bytes are the approved ones; clear the flags (git update-index --no-assume-unchanged / --no-skip-worktree) and approve again`,
        );
      }
      const reports = verifiedAnalysisReportPaths(root, subject);
      // Porcelain paths are relative to the REPOSITORY top level, not to the
      // workspace (which may be a subdirectory of it).
      const repoRoot = await git(root, ['rev-parse', '--show-toplevel']);
      // EXACT REPORT EXCEPTION (promotion F3), with four guards:
      // (1) only this run's two fingerprint-derived paths, never patterns;
      // (2) exact SHA-256 bytes, bound into the approved input digest;
      // (3) lstat regular files whose realpaths equal the canonical paths
      // directly under the workspace, and no scan target or alias of either;
      // (4) exclude ONLY their untracked entries: tracked changes and every
      // unrelated file remain dirty. verifiedAnalysisReportPaths runs at
      // admission AND the exercise re-check. Markdown cannot affect the
      // explicit-target, inline-rule codemod; the sidecar's planning inputs
      // are digest-bound and cannot change between planning and the write.
      //
      // CALLER-NAMED EXEMPT PREFIXES (the attended authority's `.cq/` report
      // area, ops/analyze/attended.ts): a record whose path — and, for a
      // rename/copy, whose ORIGINAL path too — lies inside one of the
      // workspace-relative prefixes is ignored, tracked or untracked. An empty
      // list (every other caller) leaves the strict predicate unchanged.
      const records = status.split('\0');
      const dirtyPaths: string[] = [];
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index] as string;
        if (record === '') continue;
        const code = record.slice(0, 2);
        const path = record.slice(3);
        // `-z` porcelain carries a rename/copy's ORIGINAL path as the NEXT
        // record; it belongs to this entry and is judged with it.
        const original = code.includes('R') || code.includes('C') ? records[++index] : undefined;
        if (code === '??' && reports.has(resolve(repoRoot, path))) continue;
        const paths = original === undefined ? [path] : [path, original];
        if (exempt.length > 0 && paths.every((p) => isExemptPath(root, repoRoot, p, exempt))) {
          continue;
        }
        dirtyPaths.push(relative(root, resolve(repoRoot, path)) || path);
      }
      return dirtyPaths.length === 0
        ? { workspace: root, headSha, treeClean: true }
        : { workspace: root, headSha, treeClean: false, dirtyPaths: dirtyPaths.slice(0, 20) };
    },
  };
}

/** Options for {@link makeGitApprovalStateReader}. */
export interface GitApprovalStateReaderOptions {
  /**
   * Workspace-relative directory prefixes (e.g. `.cq/`) whose untracked or
   * modified entries do NOT make the tree dirty. Meant for a tool's own
   * report area that no approved write reads from or writes to; every other
   * path keeps the strict predicate. Absolute prefixes and prefixes that
   * escape the workspace are refused (a throw at construction).
   */
  readonly exempt?: readonly string[];
}

/** Validate and normalize exempt prefixes to workspace-relative POSIX directory forms. */
function normalizeExemptPrefixes(prefixes: readonly string[]): string[] {
  return prefixes.map((prefix) => {
    const trimmed = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
    if (
      trimmed === '' ||
      trimmed === '.' ||
      isAbsolute(trimmed) ||
      trimmed.split('/').some((part) => part === '..')
    ) {
      throw new Error(
        `approval state: exempt prefix '${prefix}' must be a non-empty workspace-relative directory that does not escape the workspace`,
      );
    }
    return trimmed;
  });
}

/** True when the repo-relative porcelain `path` lies inside one of the workspace-relative exempt prefixes. */
function isExemptPath(
  root: string,
  repoRoot: string,
  path: string,
  exempt: readonly string[],
): boolean {
  const absolute = resolve(repoRoot, path);
  return exempt.some((prefix) => {
    const base = resolve(root, prefix);
    return absolute === base || absolute.startsWith(base + sep);
  });
}

/** Verify the exact rendered pair before granting its narrow untracked exception. */
function verifiedAnalysisReportPaths(root: string, subject?: ApprovalSubject): Set<string> {
  const reports = subject?.analysisReports;
  if (reports === undefined) return new Set();
  if (subject?.op !== 'analyze.applyRemediation' || !/^[0-9a-f]{16}$/.test(reports.fingerprint)) {
    throw new Error('approval: invalid analysis report exception');
  }
  const pair = [
    [join(root, sidecarFileName(reports.fingerprint)), reports.sidecarSha256],
    [join(root, markdownFileName(reports.fingerprint)), reports.markdownSha256],
  ] as const;
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const [path, digest] of pair) {
    const stat = lstatSync(path);
    if (!stat.isFile() || realpathSync(path) !== path) {
      throw new Error(
        `approval: analysis report '${path}' must be a regular file at its exact canonical workspace path`,
      );
    }
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== digest) {
      throw new Error(`approval: analysis report '${path}' bytes changed since planning`);
    }
    paths.add(path);
    identities.add(`${String(stat.dev)}:${String(stat.ino)}`);
  }
  for (const target of [...subject.targets, ...reports.scanTargets]) {
    const targetReal = realpathSync(resolve(root, target));
    const targetStat = statSync(targetReal);
    // Hard links alias bytes without sharing a realpath; refuse them too.
    if (
      paths.has(targetReal) ||
      identities.has(`${String(targetStat.dev)}:${String(targetStat.ino)}`)
    ) {
      throw new Error(`approval: analysis report '${target}' cannot be a codemod target or alias`);
    }
  }
  return paths;
}

/**
 * The paths of `git ls-files -v -z` entries whose index flags exempt them
 * from the working-tree comparison: a LOWERCASE tag is assume-unchanged, and
 * `S`/`s` is skip-worktree. Each record is `<tag> <path>`, NUL-terminated.
 */
function indexHiddenEntries(listing: string): string[] {
  const hidden: string[] = [];
  for (const record of listing.split('\0')) {
    if (record.length < 3) continue;
    const tag = record.charAt(0);
    if (tag === 'S' || tag !== tag.toUpperCase()) hidden.push(record.slice(2));
  }
  return hidden;
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

/**
 * One read-only git command over the hardened argv and a scrubbed env;
 * trimmed stdout by default. `raw` keeps the exact bytes — the `-z` porcelain
 * parse needs them, because the first record's leading status space is
 * significant (` M path`).
 */
async function git(cwd: string, args: string[], raw = false): Promise<string> {
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
        resolvePromise(raw ? stdout : stdout.trim());
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
        state = await readState.read(subject.workspace, subject);
      } catch (err) {
        return {
          granted: false,
          reason: `approval refused: the workspace state could not be read — ${messageOf(err)}; an unreadable state is never treated as unchanged, and nothing was written`,
        };
      }
      // The real reader has already verified any exact report exception.
      // A DIRTY TREE IS NOT AN APPROVABLE STATE — and this is the ACCEPTED
      // ADR's requirement, not a local tightening of it. ADR-0003 §4c step 1
      // requires the clean predicate to be EMPTY
      // (`git status --porcelain=v1 --untracked-files=all`), and §4c's
      // enumerated refusal reasons include `workspace dirty`; §7 lists "a
      // dirty tree from an untracked file" as a required `needs-human`
      // case. So a `treeClean: false` state must NOT reach a write, and the
      // observable contract — `needs-human`, `workspace dirty`, no write,
      // no spend — is exactly the ADR's.
      //
      // WHY IT IS CHECKED AT ADMISSION RATHER THAN ONLY AT THE EXERCISE:
      // the same refusal, detected earlier. The claim's `treeClean` is a
      // boolean, and comparing booleans cannot distinguish one dirty state
      // from another — an approval over a dirty tree would look unchanged
      // when the tree became a DIFFERENT dirty tree (same boolean, same
      // HEAD, different bytes). Refusing as soon as the state is known to
      // be dirty never mints a grant, so that comparison is never reached.
      // An earlier refusal is strictly safer than a later one and spends
      // nothing, so there is nothing for the ADR to permit here.
      if (!state.treeClean) {
        return {
          granted: false,
          reason:
            'approval refused: `workspace dirty` — the workspace is not clean (an untracked file counts as dirty, per ADR-0003 §4c step 1) — this module acts only on a strictly clean tree, and a dirty state is one the approval cannot be shown to describe; commit, stash or clean the workspace, then approve against that state' +
            dirtyPathsNote(state),
        };
      }
      let verified: VerifiedApproval | undefined;
      try {
        verified = await config.approvals.verifiedFor(subject);
      } catch (err) {
        return {
          granted: false,
          reason: denyReason(
            subject,
            `the verified-approval provider faulted (${messageOf(err)}) — a provider that cannot answer is treated as no approval`,
          ),
        };
      }
      if (verified === undefined || verified.nonce === '') {
        return {
          granted: false,
          reason: denyReason(
            subject,
            'no verified approval token was issued for this op on these exact inputs in this exact workspace state',
          ),
        };
      }
      // THE KERNEL-TO-ADMISSION WINDOW (ADR-0003 §4b → §4c). The kernel
      // verified the signature at some earlier moment; this is a later one.
      // If the workspace moved in between, adopting the new state as the
      // baseline would silently re-point a human's approval at bytes they
      // never saw — so the signed state is compared to the state read HERE,
      // and a difference refuses with the nonce UNSPENT.
      const signed = verified.state;
      if (signed === undefined || signed === null) {
        return {
          granted: false,
          reason:
            "approval refused: the verified approval carried no signed state — ADR-0003 §2 makes `state` mandatory for a mutating op, and without it this module cannot tell what the approver actually saw; the adapter must supply the claim's state, not a re-read",
        };
      }
      const gap = stateDrift(signed, state);
      if (gap !== null) {
        return {
          granted: false,
          reason: `approval state changed since approval: ${gap} — the workspace moved between the kernel's verification of this token and this op's admission, so the approval cannot be shown to cover the current state; nothing was written and the token is UNSPENT (re-approve against the current state)`,
        };
      }
      return {
        granted: true,
        grant: { subject, nonce: verified.nonce, state },
      };
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
        state = await readState.read(subject.workspace, subject);
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
          reason: `approval refused: the approval ledger could not be read or appended — ${messageOf(err)}; the ledger is fail-closed, so nothing was written. The token is UNSPENT only when the fault struck before any append bytes could reach disk and INDETERMINATE whenever an append may have changed the ledger (including a short write, sync or close fault) — inspect the ledger and re-approve rather than retry`,
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

/** The refusal suffix naming the dirty paths, when the reader reported them. */
function dirtyPathsNote(state: ApprovalState): string {
  const paths = state.dirtyPaths;
  if (paths === undefined || paths.length === 0) return '';
  return ` (dirty: ${paths.map((path) => `'${path}'`).join(', ')})`;
}

/** The op-facing result: the write happened under a spent approval, or it did not happen. */
export type ApprovedMutation<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'needs-human'; readonly reason: string };

/**
 * The verdict of {@link withApprovedMutation}'s optional `preflight`: the
 * caller's read-only check of the work it is ABOUT to request, or why it
 * refuses.
 *
 * WHY THIS EXISTS (the #258 owner ruling, option D). A caller whose real
 * pre-spend work happens inside the write — the playbook dispatch's engine
 * scan, whose faults (a malformed rule, an unreadable target, a collision, a
 * splice fault) were discovered only AFTER the nonce had been consumed —
 * burned a single-use approval on a dispatch that never wrote a byte. Passing
 * that check as `preflight` runs it INSIDE the mutation lock, after
 * admission, BEFORE {@link ApprovalAuthority.exercise} consumes the nonce, so
 * a refusal — or a throw — costs nothing: the token stays spendable and a
 * retry with the SAME token is possible once the check passes.
 *
 * THE CONTRACT, in both directions:
 *  - the preflight must be READ-ONLY (it runs under the workspace mutation
 *    lock, but before the approval is exercised — nothing it observes
 *    authorizes a byte);
 *  - it receives NO {@link ExercisedScope}, deliberately: a scope asserts
 *    that an approval was already consumed, which is FALSE at preflight
 *    time — it is minted for, and handed only to, the write callback.
 *
 * The exercise's state re-check still runs AFTER the preflight and
 * immediately before the spend, so the §7 TOCTOU guarantee is exactly where
 * it was: a workspace that moves between admission and the spend is refused
 * with the nonce unspent, preflight or no preflight.
 */
export type ApprovalPreflight =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

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
 *
 * THE OPTIONAL `preflight` (the #258 owner ruling, option D): a caller
 * callback — typically the read-only scan of the work the write would do —
 * that runs INSIDE the mutation lock, after admission, BEFORE `exercise`
 * consumes the nonce. So the scan and the mutation it gates share one lock
 * hold with no gap between them (no approved-writer TOCTOU between check and
 * spend), and a preflight that refuses — or THROWS — returns a
 * `needs-human` refusal with the token UNSPENT, never a burn and never a
 * rejection. The write callback then runs after the spend exactly as before;
 * restore-on-failure and every ordering guarantee are untouched.
 */
/**
 * The capability ADR-0003 §6 defines for NESTED mutations: an approval
 * already exercised, under a workspace mutation lock already held, valid only
 * until the write that received it settles.
 *
 * WHY IT EXISTS. When one approved mutation drives another — the playbook
 * dispatch applying a rule THROUGH the `analyze.astGrepCodemod` engine
 * primitive — the inner write must not exercise a SECOND approval. ADR-0003
 * §6 names this exact case and this exact answer: the inner op "writes under
 * the already-held lock and already-consumed nonce, without
 * re-exercising", and a grant exercised twice THROWS (§4c's at-most-once).
 * Without a scope there are only two wrong options: the inner op demands a
 * second token for a write one approval already covers, or it is given a
 * bypass flag that any future caller could set.
 *
 * THE PROPERTIES THAT MAKE IT SAFE, and the reason it is not a token:
 *  - branded: only this module can mint one, so plan JSON cannot carry it
 *    (it is not serializable, and a forged value fails {@link isExercisedScope});
 *  - it does NOT authorize anything by itself — it asserts only that some
 *    approval for THIS workspace was already consumed under the lock that is
 *    still held, which is why it exists only as an argument to the write
 *    callback of {@link withApprovedMutation};
 *  - it carries no nonce and no subject, so it cannot be replayed into a
 *    second write: the only code that accepts one is the callback that is
 *    already inside the critical section, and the lock is released when that
 *    callback settles.
 */
/**
 * The brand is a REAL runtime symbol, not a `declare const`.
 *
 * That distinction is the whole defect this replaced: `declare const
 * scopeBrand: unique symbol` type-checks and satisfies the compiler, but
 * emits NO binding, so every runtime use — minting the scope and testing the
 * brand — threw `ReferenceError: scopeBrand is not defined`. `tsc` reported
 * nothing, and every approved mutation in the family would have faulted at the
 * mint. A brand that authorizes a write MUST exist at runtime, because the
 * only thing standing between a forged object and a mutation is the runtime
 * check on it.
 */
const scopeBrand: unique symbol = Symbol('cq.approval.scopeBrand');

/**
 * LIVE SCOPES. Membership here — not the brand alone — is what makes a scope
 * usable, and it is what makes it SINGLE-SECTION: a scope is added when its
 * critical section opens and removed in a `finally` when that section settles.
 * So a scope retained by its recipient and used later, after the lock was
 * released, is REFUSED rather than honored — which a brand check alone cannot
 * do, since the brand outlives the section. Held in a WeakSet so a retained
 * reference cannot keep the entry alive.
 */
const liveScopes = new WeakSet<object>();

/** See {@link ExercisedScope}. Minted only inside an approved mutation's critical section. */
export interface ExercisedScope {
  readonly [scopeBrand]: true;
  /** The op whose approval was exercised — for refusal wording, never for authorization. */
  readonly op: string;
  /** The CANONICAL workspace whose mutation lock is currently held. */
  readonly workspace: string;
  /** The CANONICAL target files that approval covered — the containment bound. */
  readonly targets: readonly string[];
}

/** Mint a live scope for one critical section. Only {@link retireScope} closes it. */
function mintScope(op: string, workspace: string, targets: readonly string[]): ExercisedScope {
  const scope: ExercisedScope = {
    [scopeBrand]: true,
    op,
    workspace: canonicalWorkspace(workspace),
    targets: [...targets],
  };
  liveScopes.add(scope);
  return scope;
}

/** Close a scope when its section settles, in a `finally`. */
function retireScope(scope: ExercisedScope): void {
  liveScopes.delete(scope);
}

/**
 * True only for a scope this module minted AND whose critical section is
 * still open. A forged object fails the brand; a RETAINED scope fails
 * liveness. Both are refused by the same check, deliberately: the op's
 * response is identical either way, and distinguishing them in the message
 * would only tell an attacker which half of the guard they cleared.
 */
export function isExercisedScope(value: unknown): value is ExercisedScope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { [scopeBrand]?: unknown };
  return candidate[scopeBrand] === true && liveScopes.has(value);
}

/**
 * Canonical workspace identity for the containment checks: the `realpath`,
 * with a not-yet-existing path resolved through its longest existing
 * ancestor. Two spellings of one tree must compare EQUAL (a symlinked
 * checkout, `/var` versus `/private/var`), so a scope minted for one cannot be
 * silently spent against the other.
 */
export function canonicalWorkspace(path: string): string {
  return realpathOrSelf(path);
}

export async function withApprovedMutation<T>(
  authority: ApprovalAuthority,
  subject: ApprovalSubject,
  write: (scope: ExercisedScope) => Promise<T>,
  preflight?: () => ApprovalPreflight | Promise<ApprovalPreflight>,
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
  return lockedSection(
    locks,
    subject.workspace,
    async (scope): Promise<ApprovedMutation<T>> => {
      // THE PREFLIGHT, when the caller brought one: inside the lock, after
      // admission, BEFORE the exercise spends the nonce — so a refused or
      // faulting check leaves the token spendable (the #258 defect: a scan
      // fault after the spend burned a single-use approval on a no-write
      // dispatch). A throw is a REFUSAL here, not a rejection: the check
      // faulted before any byte moved and before any lock release, so there
      // is no write state to report and failing closed as needs-human is
      // strictly more informative to the caller than an exception.
      if (preflight !== undefined) {
        let verdict: ApprovalPreflight;
        try {
          verdict = await preflight();
        } catch (err) {
          return {
            status: 'needs-human',
            reason: `approval refused: the preflight faulted before the nonce was spent — ${messageOf(err)}; nothing was written and the token is UNSPENT (the preflight runs inside the mutation lock before exercise precisely so a faulting check cannot burn the approval)`,
          };
        }
        if (!verdict.ok) {
          return {
            status: 'needs-human',
            reason: `approval refused: the preflight refused before the nonce was spent — ${verdict.reason}; nothing was written and the token is UNSPENT (the preflight runs inside the mutation lock before exercise precisely so a refused check cannot burn the approval; a retry with the SAME token is possible once the check passes)`,
          };
        }
      }
      const exercised = await authority.exercise(admitted.grant, subject);
      if (!exercised.granted) return { status: 'needs-human', reason: exercised.reason };
      return { status: 'ok', value: await write(scope) };
    },
    { op: subject.op, targets: subject.targets },
  );
}

/**
 * Run `fn` inside the workspace mutation lock the AUTHORITY was built with —
 * the same lock, the same key, the same critical section the exercise runs
 * in. Exported because a mutation is not only the first write: a ROLLBACK is
 * a write too, and it has to be serialized against the other approved
 * writers of the same workspace exactly as the original apply was. A caller
 * that mutates outside this helper reintroduces the lost update this lock
 * exists to prevent.
 *
 * Unlike {@link withApprovedMutation} this does NOT admit, exercise or
 * consume: it is the same mutual exclusion, with no approval semantics of
 * its own — and so `fn` receives NO {@link ExercisedScope}. A scope asserts
 * that an approval was consumed; minting one here would let any caller
 * holding a bound authority hand it to a nested codemod and write without
 * spending a token. An authority with no bound locks refuses rather than
 * running unlocked.
 */
export async function withMutationLock<T>(
  authority: ApprovalAuthority,
  workspace: string,
  fn: () => Promise<T>,
): Promise<
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }
> {
  const locks = (authority as Partial<BoundAuthority>)[LOCKS];
  if (locks === undefined) {
    return {
      ok: false,
      reason:
        "approval refused: the authority exposes no mutation lock, so this workspace's mutations are not serialized; nothing was written",
    };
  }
  return { ok: true, value: await locks.forWorkspace(workspace).withLock(fn) };
}

/**
 * The approved critical section: the lock, plus a scope minted INSIDE it and
 * retired in a `finally` when it settles — so a scope cannot exist outside
 * the lock, and a recipient that retains it past the section holds one that
 * no longer passes {@link isExercisedScope}. Module-private: only
 * {@link withApprovedMutation}, which exercises before calling `fn`'s write,
 * may mint a scope.
 */
async function lockedSection<T>(
  locks: MutationLocks,
  workspace: string,
  fn: (scope: ExercisedScope) => Promise<T>,
  meta: { readonly op: string; readonly targets: readonly string[] },
): Promise<T> {
  return locks.forWorkspace(workspace).withLock(async () => {
    const scope = mintScope(meta.op, workspace, meta.targets);
    try {
      return await fn(scope);
    } finally {
      retireScope(scope);
    }
  });
}

/**
 * A STRONG fingerprint of a file's bytes (`sha256:…`), for compare-and-swap
 * guards on a mutation. The family's `contentDigest` is a 32-bit FNV-1a
 * coarse freshness marker; using it to decide "did anything change since I
 * wrote this?" would put a 1-in-4-billion guess on whether a concurrent
 * writer's edit gets clobbered, which is the wrong place for that trade.
 */
export function contentFingerprint(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A structural admission fault (no state read, no token lookup), or null when admissible. */
function preAdmissionFault(
  subject: ApprovalSubject,
  trustedLayerDir: string | undefined,
): string | null {
  if (subject.targets.length === 0) {
    return 'the mutation has no target files — there is nothing to approve, and an approval over an empty target set would bind nothing';
  }
  // ARGUMENT ORDER IS LOAD-BEARING: `isInside(parent, child)` asks whether
  // CHILD is nested in PARENT, so the question here is "is the trusted layer
  // nested in the workspace?", i.e. parent = the workspace. Passing them the
  // other way round silently answers the harmless question instead ("is the
  // workspace nested in the trusted layer?"), which refuses legitimate
  // layouts — a ledger under $HOME state with a workspace under $HOME — and
  // lets the actual tamper vector through.
  if (trustedLayerDir !== undefined && isInside(subject.workspace, trustedLayerDir)) {
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
    approvalInputDigest(a.analysisReports) === approvalInputDigest(b.analysisReports) &&
    a.targets.length === b.targets.length &&
    a.targets.every((target, index) => target === b.targets[index])
  );
}

/**
 * The first drift between the approved state and the current one, or null.
 *
 * Both states are strictly CLEAN by the time this runs — admission refuses
 * a dirty state outright, as ADR-0003 §4c step 1 requires — so the tree
 * comparison only ever sees clean→dirty, and that is the only direction it
 * has to name. The dirty→clean direction is unrepresentable rather than
 * unhandled: there is no grant to compare against, because a dirty state
 * never produced one.
 */
function stateDrift(approved: ApprovalState, current: ApprovalState): string | null {
  if (approved.workspace !== current.workspace) {
    return `workspace ${current.workspace} ≠ ${approved.workspace}`;
  }
  if (approved.headSha !== current.headSha) {
    return `HEAD ${current.headSha} ≠ ${approved.headSha}`;
  }
  if (approved.treeClean !== current.treeClean) {
    return current.treeClean
      ? 'the tree is clean again, but the approval was not taken over a clean tree'
      : 'the tree is dirty (an untracked file counts)';
  }
  return null;
}

/**
 * The op-level input digest binding an approval to the EXACT inputs of one
 * invocation: a sha256 over a canonical JSON rendering (keys sorted at every
 * level, `undefined` members dropped), so two structurally identical
 * invocations hash identically and ANY change to the digested value
 * changes the digest. Callers choose that value: the current op call
 * sites digest their operative inputs and do NOT include the `approved`
 * flag (it is checked separately, before admission). This is the analyze family's
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
