// Dev lane (strategy §3, migration Phase 1 lane 1) — the branch dev-record:
// the AUTHOR-tier evidence store every dev.* command reads and appends.
//
// THE TWO TIERS (strategy §2.4, load-bearing for every consumer): everything
// in this store is author evidence — produced on the implementor's machine
// by the implementor's own commands (dev.check, dev.review,
// dev.disposition). It is a CLAIM. It is useful to the implementor and to
// orchestrator triage, and pr.open posts it where the next reader looks, but
// it is never verification: verification uses only facts an
// owner-credential session cannot write (required CI at the exact head, the
// reviewer bots' PR review). The assembled readiness record carries the
// caveat verbatim so no consumer can mistake the tier.
//
// FORMAT: one JSON file per branch, `.cq/dev/<branch>.json` inside the repo
// root (gitignored — author evidence lives in the worktree, never in the
// PR). `serializeDevLedger` emits keys in schema order, 2-space indent, one
// trailing newline; records keep append order (chronology IS the semantics —
// unlike the novel-error ledger there is no canonical content sort). Parse is
// STRICT: wrong version, unknown record kind, a non-object record, a
// disposition action outside the three-word verb set, or an empty `why`
// throws — a hand-edited record is a format error, never silently
// normalized.
//
// BRANCH PATH SAFETY: git refname rules already forbid the dangerous path
// spellings per segment (`..`, leading `.`, trailing `.lock`, spaces, `~^:?*[\`),
// so `<branch>` is a safe multi-segment name under `.cq/dev/`; the store
// re-validates anyway (defense in depth) and refuses a branch that could
// escape. A DETACHED head has no branch name — the ops report that as a
// needs-human class fault, never a guessed file name.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { makeGitMutex } from '../sweep/gitMutex.js';

/** The persisted record format version — the only one parseDevLedger accepts. */
export const DEV_LEDGER_VERSION = 1;

/**
 * Built-in defaults (strategy §5, first cut): the policy file
 * `policy/dev-protocol.json` lands in the protected batch with exactly the
 * consumers that will read it there; until then the built-in values are
 * authoritative here and are NOT copied into any policy file.
 */

/** The default intended PR target — the documented queue flow's branch. */
export const DEFAULT_DEV_TARGET = 'merge-queue';

/** The severities a disposition must close before dev.ready reports ready. */
export const DEFAULT_BLOCKING_SEVERITIES: readonly string[] = ['critical', 'major'];

/** The reviewer timeout for one CLI review cycle (strategy §5 reviewerTimeoutMin). */
export const DEFAULT_REVIEWER_TIMEOUT_MS = 25 * 60 * 1000;

/** A finding as the review cycle recorded it — the severity is the CLI's word, verbatim. */
export interface DevFinding {
  /** `<cycleId>#f<N>` — unique within the branch's ledger, stable once written. */
  id: string;
  /** The reviewer's severity word, preserved verbatim (never remapped on write). */
  severity: string;
  /** The file the finding names, when the reviewer reported one. */
  fileName?: string;
  /** The finding's comment (or its first suggestion), when reported. */
  excerpt?: string;
}

/** Whether one review cycle completed, or was blocked — and why. */
export type DevReviewCompletion = { kind: 'terminal' } | { kind: 'blocked'; reason: string };

/** One review cycle: the reviewer run's identity, completion, and findings. */
export interface DevCycleRecord {
  kind: 'cycle';
  /** `c<NNN>-<head8>` — the NNN is the 1-based cycle count in this ledger when written. */
  cycleId: string;
  /** The reviewer the cycle ran (the reviewer-choice flag's verbatim value). */
  reviewer: string;
  /** Which diff scope the cycle reviewed. */
  scope: 'full' | 'uncommitted';
  /** The pinned immutable base the review ran against. */
  base: string;
  /** The reviewed HEAD sha. */
  head: string;
  /** sha256 of `git diff --binary --full-index HEAD` — the dirty-diff identity. */
  dirtySha256: string;
  completion: DevReviewCompletion;
  findings: DevFinding[];
  /** Where the raw stream log was saved — OUTSIDE the repository (protocol §3). */
  logPath: string;
  /** Untracked non-ignored files present at cycle time (outside the review scope). */
  untracked: string[];
  /** ISO-8601 timestamp. */
  at: string;
}

/** One gate row of a dev.check run. */
export interface DevCheckGate {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  /** The command's exit code, when a command ran (skipped gates have none). */
  exitCode?: number;
  /** Wall-clock duration of the gate's command; skipped gates report 0. */
  durationMs: number;
  /** One-line evidence summary (the failing gates' narrated output tail). */
  evidence: string;
}

/** The host load stamp every local timing cites (focused-checks contract §5). */
export interface DevLoadStamp {
  /** Host uptime in seconds, sampled with the load average. */
  uptimeSeconds: number;
  /** The 1-minute load average, sampled with the uptime. */
  load1: number;
  /** ISO-8601 sample time. */
  at: string;
}

/** One dev.check run: the gates that ran over the diff and their verdicts. */
export interface DevCheckRecord {
  kind: 'check';
  /** `k<NNN>-<head8>` — the NNN is the 1-based check count in this ledger when written. */
  checkId: string;
  /** The intended PR target the identity was pinned against. */
  target: string;
  base: string;
  head: string;
  dirtySha256: string;
  /** The explicit `a..b` range, when the run was scoped to one. */
  range?: string;
  /** true only when every gate that ran is green. */
  passed: boolean;
  gates: DevCheckGate[];
  loadStamp: DevLoadStamp;
  at: string;
}

/** One disposition: the author's recorded adjudication of one finding. */
export interface DevDispositionRecord {
  kind: 'disposition';
  findingId: string;
  action: 'fixed' | 'rejected' | 'deferred';
  /** The concrete reason or fix note — never empty. */
  why: string;
  /** The HEAD the disposition was recorded at. */
  head: string;
  at: string;
}

/** The ledger's record union — discriminated on `kind`. */
export type DevRecord = DevCycleRecord | DevCheckRecord | DevDispositionRecord;

/** The persisted dev-record file. Version 1 — the only version parse accepts. */
export interface DevLedgerFile {
  version: typeof DEV_LEDGER_VERSION;
  branch: string;
  records: DevRecord[];
}

/**
 * The three-part diff identity every record carries: the pinned immutable
 * base, the HEAD, and the dirty-diff sha256. Two records describe the same
 * state exactly when all three match.
 */
export interface DevIdentity {
  base: string;
  head: string;
  dirtySha256: string;
}

// --- Zod mirrors (parse boundary; key order is the serialize order) --------

const DevFindingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.string().min(1),
    fileName: z.string().min(1).exactOptional(),
    excerpt: z.string().min(1).exactOptional(),
  })
  .strict();

const DevCompletionSchema = z.union([
  z.object({ kind: z.literal('terminal') }).strict(),
  z.object({ kind: z.literal('blocked'), reason: z.string().min(1) }).strict(),
]);

const DevCycleRecordSchema = z
  .object({
    kind: z.literal('cycle'),
    cycleId: z.string().min(1),
    reviewer: z.string().min(1),
    scope: z.enum(['full', 'uncommitted']),
    base: z.string().min(1),
    head: z.string().min(1),
    dirtySha256: z.string().min(1),
    completion: DevCompletionSchema,
    findings: z.array(DevFindingSchema),
    logPath: z.string().min(1),
    untracked: z.array(z.string().min(1)),
    at: z.string().min(1),
  })
  .strict();

const DevCheckGateSchema = z
  .object({
    name: z.string().min(1),
    status: z.enum(['pass', 'fail', 'skipped']),
    exitCode: z.number().int().exactOptional(),
    durationMs: z.number().int().min(0),
    evidence: z.string(),
  })
  .strict();

const DevLoadStampSchema = z
  .object({
    uptimeSeconds: z.number(),
    load1: z.number(),
    at: z.string().min(1),
  })
  .strict();

const DevCheckRecordSchema = z
  .object({
    kind: z.literal('check'),
    checkId: z.string().min(1),
    target: z.string().min(1),
    base: z.string().min(1),
    head: z.string().min(1),
    dirtySha256: z.string().min(1),
    range: z.string().min(1).exactOptional(),
    passed: z.boolean(),
    gates: z.array(DevCheckGateSchema),
    loadStamp: DevLoadStampSchema,
    at: z.string().min(1),
  })
  .strict();

const DevDispositionRecordSchema = z
  .object({
    kind: z.literal('disposition'),
    findingId: z.string().min(1),
    action: z.enum(['fixed', 'rejected', 'deferred']),
    // Whitespace-only is empty for the record's purposes: a disposition
    // without a reason is not evidence.
    why: z
      .string()
      .min(1)
      .refine((why) => why.trim() !== '', { message: 'why must not be blank' }),
    head: z.string().min(1),
    at: z.string().min(1),
  })
  .strict();

const DevRecordSchema = z.discriminatedUnion('kind', [
  DevCycleRecordSchema,
  DevCheckRecordSchema,
  DevDispositionRecordSchema,
]);

const DevLedgerFileSchema: z.ZodType<DevLedgerFile> = z
  .object({
    version: z.literal(DEV_LEDGER_VERSION),
    branch: z.string().min(1),
    records: z.array(DevRecordSchema),
  })
  .strict();

/** The record id of a cycle/check record (dispositions have none). */
function recordIdOf(record: DevRecord): string | null {
  if (record.kind === 'cycle') return record.cycleId;
  if (record.kind === 'check') return record.checkId;
  return null;
}

/**
 * Serialize deterministically: keys in schema order, 2-space indent, exactly
 * one trailing newline; records keep append order. The write side guards
 * only what its own output could not parse back — a duplicate record id
 * (cycleId/checkId) — and otherwise trusts the caller: parseDevLedger is the
 * strict entry for anything read back.
 */
export function serializeDevLedger(file: DevLedgerFile): string {
  const ids = new Set<string>();
  for (const record of file.records) {
    const id = recordIdOf(record);
    if (id !== null) {
      if (ids.has(id)) {
        throw new Error(
          `dev-record: duplicate record id '${id}' — the store never collapses records`,
        );
      }
      ids.add(id);
    }
  }
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Parse and validate dev-record text; throws on any schema violation. Unlike
 * the novel-error ledger there is no canonical sort — append order is the
 * format — but duplicate record ids still throw (a hand-merged file is a
 * format error, never silently accepted).
 */
export function parseDevLedger(text: string): DevLedgerFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `dev-record: not valid JSON — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = DevLedgerFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`dev-record: schema violation — ${issues}`);
  }
  const ids = new Set<string>();
  for (const record of parsed.data.records) {
    const id = recordIdOf(record);
    if (id !== null) {
      if (ids.has(id)) throw new Error(`dev-record: duplicate record id '${id}'`);
      ids.add(id);
    }
  }
  return parsed.data;
}

// --- Branch-path safety -----------------------------------------------------

/**
 * A git refname segment (git check-ref-format rules, enforced here
 * fail-closed): no leading '.', no trailing '.lock', no '..' anywhere, and
 * none of the characters git forbids in a refname. A branch name is joined
 * into a path under `.cq/dev/`, so every segment must be path-safe.
 */
export function branchPathFault(branch: string): string | null {
  if (branch === '' || branch.startsWith('/') || branch.endsWith('/')) {
    return `branch '${branch}' must be a non-empty relative refname`;
  }
  for (const segment of branch.split('/')) {
    if (
      segment === '' ||
      segment.startsWith('.') ||
      segment.endsWith('.lock') ||
      segment.includes('..') ||
      /[\s~^:?*[\]\\]/.test(segment)
    ) {
      return `branch '${branch}' is not a path-safe refname (segment '${segment}')`;
    }
  }
  return null;
}

/** The ledger's path inside the repo root: `.cq/dev/<branch>.json`. */
export function devLedgerPath(repoRoot: string, branch: string): string {
  const fault = branchPathFault(branch);
  if (fault !== null) throw new Error(`dev-record: ${fault}`);
  return resolve(repoRoot, '.cq', 'dev', `${branch}.json`);
}

// --- Library-level input boundary ------------------------------------------

/**
 * The repoRoot boundary every dev-side op checks BEFORE any effect call
 * (the assemblePrs inputFaultOf pattern): a schema-bypassing SDK caller
 * gets a `failed` result, never a process spawn against an undefined
 * working directory.
 */
export function repoRootFault(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') {
    return 'repoRoot must be a non-empty string';
  }
  if (/[\p{Cc}]/u.test(value)) {
    return 'repoRoot must not contain control characters — the subprocess effects run with it as the working directory';
  }
  return null;
}

// --- The store --------------------------------------------------------------

/** The read/write/lock surface the dev ops use; `mutate` serializes RMW spans. */
export interface DevLedgerStore {
  /** Load the branch's ledger; a missing file is the empty ledger. */
  load(): DevLedgerFile;
  /** Publish a new ledger state atomically. */
  save(file: DevLedgerFile): void;
  /** Run `fn` (load → fold → save) under the branch's on-disk mutex. */
  mutate<T>(fn: (ledger: DevLedgerFile) => { ledger: DevLedgerFile; value: T }): Promise<T>;
}

/**
 * The shipped fs store over `.cq/dev/<branch>.json` (the ledger family's
 * pathLedgerStore pattern, kept simpler because the branch's ledger is
 * worktree-local tool state, not committed evidence):
 *   - Load reads through the file's REAL path after containment
 *     re-verification; a missing file is the empty ledger.
 *   - Save is an atomic publish (unique 'wx' temp, rename over the target)
 *     preserving an existing file's mode; a crash can never leave a torn
 *     ledger at the path.
 *   - Mutate wraps the read-modify-write span in a repo-rooted
 *     `.cq/dev/<branch>.lock` git-mutex, so concurrent dev commands on one
 *     branch — in this process or another — serialize instead of dropping
 *     each other's appends.
 */
export function pathDevLedgerStore(repoRoot: string, branch: string): DevLedgerStore {
  const rootReal = realpathSync(resolve(repoRoot));
  const targetAbs = devLedgerPath(rootReal, branch);
  const branchFile = `${branch}.json`;

  const containedOrThrow = (candidate: string, verb: string): void => {
    const rel = relative(rootReal, candidate);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(
        `dev-record: ledger for '${branch}' does not resolve inside root '${rootReal}' — refusing to ${verb} it`,
      );
    }
  };

  const loadExisting = (): DevLedgerFile | null => {
    let realFile: string;
    try {
      realFile = realpathSync(targetAbs);
    } catch {
      return null; // genuinely absent — the empty-ledger case
    }
    containedOrThrow(realFile, 'read');
    return parseDevLedger(readFileSync(realFile, 'utf8'));
  };

  const publish = (file: DevLedgerFile): void => {
    mkdirSync(dirname(targetAbs), { recursive: true });
    const realParent = realpathSync(dirname(targetAbs));
    containedOrThrow(join(realParent, branchFile), 'write');
    publishAtomic(targetAbs, serializeDevLedger(file));
  };

  const mutex = makeGitMutex({
    lockPath: join(rootReal, '.cq', 'dev', `${branch}.lock`),
  });

  return {
    load: () => loadExisting() ?? { version: DEV_LEDGER_VERSION, branch, records: [] },
    save: publish,
    mutate: async (fn) =>
      mutex.withLock(() => {
        const ledger = loadExisting() ?? { version: DEV_LEDGER_VERSION, branch, records: [] };
        const next = fn(ledger);
        publish(next.ledger);
        return next.value;
      }),
  };
}

// --- Readiness assembly (the dev.ready / pr.open shared core) ---------------

/** The caveat carried verbatim on every readiness record (strategy §2.4). */
export const AUTHOR_EVIDENCE_CAVEAT =
  "Author readiness evidence: produced in the worktree by the implementor's own commands " +
  '(dev.check, dev.review, dev.disposition). This is a claim, not verification — verification ' +
  "is green required CI at the exact PR head plus the reviewer bots' PR review.";

/** The assembled readiness record pr.open renders into the PR body. */
export interface DevReadinessRecord {
  ready: true;
  evidenceClass: 'author';
  caveat: string;
  branch: string;
  target: string;
  base: string;
  head: string;
  dirtySha256: string;
  /** The terminal review cycle the readiness rests on. */
  cycleId: string;
  /** The green check run the readiness rests on. */
  checkId: string;
  at: string;
}

/** One missing precondition, named for the implementor. */
export interface ReadinessGap {
  /** The gap class (stable identifier a machine consumer can switch on). */
  field: string;
  /** The human detail naming the stale identity or open findings. */
  detail: string;
}

/** Input of {@link assembleReadiness} — everything except judgement. */
export interface AssembleReadinessInput {
  branch: string;
  target: string;
  identity: DevIdentity;
  ledger: DevLedgerFile;
  /** Untracked non-ignored files at assembly time (review evidence excludes them). */
  untracked: readonly string[];
  /** Severities a disposition must close; defaults to {@link DEFAULT_BLOCKING_SEVERITIES}. */
  blockingSeverities?: readonly string[];
  /** ISO-8601 timestamp for the assembled record. */
  nowIso: string;
}

/**
 * The dev.ready / pr.open shared core: assemble the author-tier readiness
 * record from the ledger, or name every gap. The requirements (strategy §3,
 * dev.ready row):
 *   - ≥ 1 TERMINAL review cycle at the CURRENT identity (base, head and
 *     dirty-diff sha256 all three — any mismatch is a stale identity; a
 *     blocked cycle never counts);
 *   - zero OPEN blocking findings on that cycle (a blocking-severity finding
 *     with no fixed/rejected disposition is open; a deferred disposition
 *     does NOT close one — deferral is a recorded decision for a later task,
 *     not a claim the finding is answered);
 *   - a GREEN dev.check at the current identity;
 *   - no untracked non-ignored files (their content is outside every
 *     recorded review scope and outside the dirty-diff hash).
 */
export function assembleReadiness(
  input: AssembleReadinessInput,
): { ready: true; record: DevReadinessRecord } | { ready: false; gaps: ReadinessGap[] } {
  const gaps: ReadinessGap[] = [];
  const { identity, ledger } = input;

  // Only a FULL-scope terminal cycle satisfies readiness: an
  // uncommitted-scope cycle never covered the committed part of the
  // intended PR diff, so calling it evidence for the whole diff would
  // fabricate readiness.
  const terminalCycles = ledger.records.filter(
    (record): record is DevCycleRecord =>
      record.kind === 'cycle' && record.scope === 'full' && record.completion.kind === 'terminal',
  );
  const cycle = terminalCycles[terminalCycles.length - 1];
  if (cycle === undefined) {
    gaps.push({
      field: 'terminal-review-cycle',
      detail:
        'no terminal full-scope review cycle recorded — run dev.review without --uncommitted (a blocked or uncommitted-scope cycle does not count)',
    });
  } else {
    const stale: string[] = [];
    if (cycle.base !== identity.base) stale.push(`base ${cycle.base} → ${identity.base}`);
    if (cycle.head !== identity.head) stale.push(`head ${cycle.head} → ${identity.head}`);
    if (cycle.dirtySha256 !== identity.dirtySha256) {
      stale.push('the working-tree diff changed since the review');
    }
    if (stale.length > 0) {
      gaps.push({
        field: 'stale-review-identity',
        detail: `review ${cycle.cycleId} is stale: ${stale.join('; ')}`,
      });
    }
    const blocking = new Set(
      (input.blockingSeverities ?? DEFAULT_BLOCKING_SEVERITIES).map((s) => s.toLowerCase()),
    );
    const closed = new Map<string, DevDispositionRecord['action']>();
    for (const record of ledger.records) {
      if (record.kind === 'disposition') closed.set(record.findingId, record.action);
    }
    const open = cycle.findings.filter((finding) => {
      if (!blocking.has(finding.severity.toLowerCase())) return false;
      const action = closed.get(finding.id);
      return action !== 'fixed' && action !== 'rejected';
    });
    if (open.length > 0) {
      gaps.push({
        field: 'open-blocking-findings',
        detail: `open blocking findings: ${open
          .map((finding) => `${finding.id} (${finding.severity})`)
          .join(', ')}`,
      });
    }
  }

  const greenChecks = ledger.records.filter(
    (record): record is DevCheckRecord => record.kind === 'check' && record.passed,
  );
  const check = greenChecks[greenChecks.length - 1];
  if (check === undefined) {
    gaps.push({ field: 'green-check', detail: 'no green dev.check recorded — run dev.check' });
  } else {
    const stale: string[] = [];
    if (check.base !== identity.base) stale.push(`base ${check.base} → ${identity.base}`);
    if (check.head !== identity.head) stale.push(`head ${check.head} → ${identity.head}`);
    if (check.dirtySha256 !== identity.dirtySha256) {
      stale.push('the working-tree diff changed since the check');
    }
    if (stale.length > 0) {
      gaps.push({
        field: 'stale-check-identity',
        detail: `check ${check.checkId} is stale: ${stale.join('; ')}`,
      });
    }
  }

  if (input.untracked.length > 0) {
    gaps.push({
      field: 'untracked-files',
      detail: `untracked non-ignored files are outside every recorded review scope: ${input.untracked.join(', ')}`,
    });
  }

  if (gaps.length > 0 || cycle === undefined || check === undefined) {
    if (gaps.length === 0) {
      // Unreachable by construction (both gap sets above are exhaustive);
      // the guard keeps the narrowing honest for the compiler.
      gaps.push({ field: 'internal', detail: 'readiness precondition vanished during assembly' });
    }
    return { ready: false, gaps };
  }
  const readyRecord: DevReadinessRecord = {
    ready: true,
    evidenceClass: 'author',
    caveat: AUTHOR_EVIDENCE_CAVEAT,
    branch: input.branch,
    target: input.target,
    base: identity.base,
    head: identity.head,
    dirtySha256: identity.dirtySha256,
    cycleId: cycle.cycleId,
    checkId: check.checkId,
    at: input.nowIso,
  };
  return { ready: true, record: readyRecord };
}

// --- Atomic publish (the ledger store's pattern, restated for this family) --

function publishAtomic(targetPath: string, bytes: string): void {
  // Preserve an operator-chosen mode across the inode swap; a NEW ledger is
  // born 0600 (restrictive by default for local evidence).
  let mode = 0o600;
  try {
    const existing = lstatSync(targetPath);
    if (existing.isFile()) mode = existing.mode & 0o777;
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  let tempPath: string | undefined;
  let tempCreated = false;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      tempPath = join(
        dirname(targetPath),
        `.${basenameOf(targetPath)}.${process.pid}.${attempt}.tmp`,
      );
      try {
        writeFileSync(tempPath, bytes, { flag: 'wx' });
        tempCreated = true;
        break;
      } catch (err) {
        if (!isEexist(err) || attempt === 4) throw err;
      }
    }
    if (tempCreated === false || tempPath === undefined) {
      throw new Error('dev-record: all temp candidates already existed');
    }
    chmodSync(tempPath, mode);
    renameSync(tempPath, targetPath);
  } catch (err) {
    if (tempPath !== undefined && tempCreated) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup: the primary fault is rethrown below.
      }
    }
    throw err;
  }
}

function basenameOf(path: string): string {
  const index = path.lastIndexOf(sep);
  return index === -1 ? path : path.slice(index + 1);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'EEXIST'
  );
}
