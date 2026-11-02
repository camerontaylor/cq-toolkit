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
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { makeGitMutex } from '../../shared/gitMutex.js';
import {
  DeferredVendorDebtSchema,
  VendorFailureProvenanceSchema,
  hasPersistedVendorOutageOrigin,
  matchesDeferredVendorDebt,
  deferredReceiptFindings,
  type DeferredVendorDebt,
  type VendorFailureProvenance,
} from './internal/deferredReview.js';
import { readCurrentEnrollment } from './internal/deferredLedger.js';
import {
  isCoverageV2Complete,
  ReviewCoverageV2Schema,
  type ReviewCoverageV2,
} from '../review/internal/reviewCoverageV2.js';
import { FindingEvidenceV1Schema, type FindingEvidenceV1 } from '../review/findings.js';
import { branchPathFault } from '../../shared/refname.js';

export { branchPathFault };

/**
 * The persisted record format version — the only one parseDevLedger accepts.
 * v2 adds `target` to cycle records: review evidence is bound to the
 * intended PR target it was recorded against (the check record's existing
 * rule), and a v1 ledger — whose cycles cannot prove their target — refuses
 * to parse rather than silently re-labeling its evidence.
 */
export const DEV_LEDGER_VERSION = 2;

/**
 * Built-in defaults (strategy §5, first cut): the policy file
 * `policy/dev-protocol.json` lands in the protected batch with exactly the
 * consumers that will read it there; until then the built-in values are
 * authoritative here and are NOT copied into any policy file.
 */

/** The default intended PR target for direct development. */
export const DEFAULT_DEV_TARGET = 'main';

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
  /** The reported line, when the producer's contract supplies one (never inferred). */
  line?: number;
  /** The reported rule/lint id, when the producer's contract supplies one. */
  rule?: string;
  /**
   * The producer's receipt reference (vendor receipts only), preserved verbatim so a
   * later projection can prove WHICH receipt this finding came from.
   */
  evidence?: string;
  /**
   * The R3S versioned agent evidence payload, carried verbatim. It is persisted and
   * compared structurally; it is never re-derived, repaired or used as authority here.
   */
  evidenceV1?: FindingEvidenceV1;
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
  /** The intended PR target the cycle was recorded against. */
  target: string;
  /** The pinned immutable base the review ran against. */
  base: string;
  /** The reviewed HEAD sha. */
  head: string;
  /** The dirty identity (staged, unstaged, untracked; workState.ts) the review saw. */
  dirtySha256: string;
  completion: DevReviewCompletion;
  findings: DevFinding[];
  /**
   * Report context only: a size/coverage note the reviewer emitted. It is
   * never dispatched to a fixer and never counted as a blocking finding.
   * Optional so v2 ledgers written before this field still parse.
   */
  advisories?: string[];
  /** Positive structured local CLI provenance; never a completed vendor review. */
  vendorFailure?: VendorFailureProvenance;
  /** Retained engine proof for a fresh agent cycle; legacy cycles remain readable. */
  agentCoverage?: ReviewCoverageV2;
  /** Where the raw stream log was saved — OUTSIDE the repository (protocol §3). */
  logPath: string;
  /** Untracked non-ignored files present at cycle time (outside the review scope). */
  untracked: string[];
  /** ISO-8601 timestamp. */
  at: string;
}

/** The reuse basis a {@link DevReuseRecord} attests. */
export type DevReuseBasis = 'exact-terminal' | 'no-fresh-tail';

/**
 * One deliberate reuse selection (Q4, #485): the cycle op found a terminal
 * full-scope record with the EXACT requested identity (repository ledger,
 * target, base, head, dirtySha256, scope and reviewer all matching) and
 * settled the author review requirement from it — zero vendor calls, zero
 * new cycles, every finding and disposition intact. The record is
 * APPEND-ONLY audit trail: it never overwrites, deletes or re-labels the
 * cycle it selects, and it is not a review run, a completion, or
 * independent acceptance.
 *
 * `basis: 'no-fresh-tail'` is the narrower later case: the LEDGER'S LATEST
 * same-identity cycle is a BLOCKED attempt whose reason is the reviewer's
 * affirmative no-fresh notice — the vendor never reviewed, so re-running
 * cannot create the review the earlier receipt already holds, and an
 * unchanged retry would spend quota to record the same refusal again. The
 * reuse record names that blocked attempt in `resolvesCycleId`, keeping it
 * verbatim in the ledger (readiness resolves it only through the linkage,
 * never by ignoring or rewriting the tail). Any OTHER blocked attempt —
 * error, auth, rate limit, malformed stream, deadline kill, or a
 * structured vendor-failure provenance — is a genuine blocker and stays
 * one; the selector refuses it.
 */
export interface DevReuseRecord {
  kind: 'reuse';
  /** `r<NNN>-<head8>` — the NNN is the 1-based reuse count in this ledger when written. */
  reuseId: string;
  /** The selected source cycle. Terminal (exact-terminal) or the earlier receipt (no-fresh-tail). */
  cycleId: string;
  /** Why the source cycle satisfies the requirement (the selector's basis). */
  basis: DevReuseBasis;
  /**
   * The same-identity no-fresh BLOCKED attempt this selection resolves —
   * set only when `basis` is `no-fresh-tail`. It stays in the ledger verbatim.
   */
  resolvesCycleId?: string;
  /** The intended PR target the selection was made against. */
  target: string;
  /** The pinned immutable base both the selection and the source cycle carry. */
  base: string;
  /** The reviewed HEAD sha both the selection and the source cycle carry. */
  head: string;
  /** The dirty identity both the selection and the source cycle carry. */
  dirtySha256: string;
  /** The diff scope of both the selection and the source cycle. */
  scope: 'full' | 'uncommitted';
  /** The reviewer of both the selection and the source cycle. */
  reviewer: string;
  /** Where the selection's own raw log was saved (outside the repository). */
  logPath: string;
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
  /**
   * The test:narrow gate ran with `--include-integration` (the caller's
   * explicit opt-in): integration suites executed inside this check, so a
   * reader knows the gate's scope was widened (skipped LIVE_GH tests still
   * count as not-executed for the wrapper's own verdict).
   */
  includeIntegration?: boolean;
  /**
   * HOW the gate's test files were chosen — a readiness reader must tell a
   * NARROWED gate from an automatic one: `named` lists the caller's exact
   * files (the diff was NOT the selection), `range`/`base` are the
   * automatic diff-driven forms. Always written by current code; OPTIONAL
   * on read so ledgers written before this field existed still parse (the
   * same evolution rule as includeIntegration).
   */
  testSelection?: { mode: 'base' | 'range' } | { mode: 'named'; files: string[] };
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
export type DevRecord =
  | DevCycleRecord
  | DevCheckRecord
  | DevDispositionRecord
  | DevReuseRecord
  | DevVendorDebtRecord;

/** Additive audit snapshot, including predecessors whose obligations remain open. */
export interface DevVendorDebtRecord {
  kind: 'vendor-debt';
  debt: DeferredVendorDebt;
  at: string;
}

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

/**
 * The ledger's finding mirror. Identity-bearing STRINGS accept exactly what the
 * review record (FindingSchema) accepts, including the empty string, and are stored
 * verbatim: the ledger never rejects a value its producer was allowed to emit, and
 * never drops one either (an empty value is stored, not treated as absent). `id`,
 * `severity` and `line` keep their strict constraints because FindingSchema has the
 * same ones. Widening acceptance cannot invalidate an existing ledger.
 */
const DevFindingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.string().min(1),
    fileName: z.string().exactOptional(),
    excerpt: z.string().exactOptional(),
    line: z.number().int().positive().exactOptional(),
    rule: z.string().exactOptional(),
    evidence: z.string().exactOptional(),
    evidenceV1: FindingEvidenceV1Schema.exactOptional(),
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
    target: z.string().min(1),
    base: z.string().min(1),
    head: z.string().min(1),
    dirtySha256: z.string().min(1),
    completion: DevCompletionSchema,
    findings: z.array(DevFindingSchema),
    advisories: z.array(z.string().min(1)).exactOptional(),
    vendorFailure: VendorFailureProvenanceSchema.exactOptional(),
    agentCoverage: ReviewCoverageV2Schema.exactOptional(),
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
    includeIntegration: z.boolean().exactOptional(),
    testSelection: z
      .union([
        z.object({ mode: z.literal('base') }).strict(),
        z.object({ mode: z.literal('range') }).strict(),
        z.object({ mode: z.literal('named'), files: z.array(z.string().min(1)).min(1) }).strict(),
      ])
      .exactOptional(),
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

const DevReuseRecordSchema = z
  .object({
    kind: z.literal('reuse'),
    reuseId: z.string().min(1),
    cycleId: z.string().min(1),
    basis: z.enum(['exact-terminal', 'no-fresh-tail']),
    resolvesCycleId: z.string().min(1).exactOptional(),
    target: z.string().min(1),
    base: z.string().min(1),
    head: z.string().min(1),
    dirtySha256: z.string().min(1),
    scope: z.enum(['full', 'uncommitted']),
    reviewer: z.string().min(1),
    logPath: z.string().min(1),
    at: z.string().min(1),
  })
  .strict()
  .refine(
    (record) => record.basis !== 'exact-terminal' || record.resolvesCycleId === undefined,
    'an exact-terminal reuse selects a terminal cycle and names no blocked attempt',
  );

const DevRecordSchema = z.discriminatedUnion('kind', [
  DevCycleRecordSchema,
  DevCheckRecordSchema,
  DevDispositionRecordSchema,
  DevReuseRecordSchema,
  z
    .object({
      kind: z.literal('vendor-debt'),
      debt: DeferredVendorDebtSchema,
      at: z.string().min(1),
    })
    .strict(),
]);

/**
 * The affirmative no-fresh/skipped notice, VERBATIM as
 * `decideCompletion` (coderabbit.ts) records it: the blocked reason of a
 * run the reviewer itself said never reviewed. A reuse resolution exists
 * for exactly this tail — nothing else (an error, auth, rate limit,
 * malformed stream, a deadline kill, or any structured vendor-failure
 * class) may ever be selected over or resolved away.
 */
const NO_FRESH_TAIL_PATTERN =
  /^reviewer completed '.+?' with an AFFIRMATIVE no-fresh\/skipped notice \(".+"\) — a fresh detailed review never ran$/u;

/**
 * True when the cycle is an affirmative no-fresh BLOCKED attempt: the vendor
 * itself said it never reviewed, with no structured vendor-failure class.
 * EXACTLY these attempts are eligible for a `no-fresh-tail` reuse — as the
 * resolved tail, and as every attempt between that tail and its selected
 * terminal. Nothing else (an error, auth, rate limit, malformed stream, a
 * deadline kill, or any vendor-failure class) is ever eligible.
 */
const isAffirmativeNoFreshAttempt = (cycle: DevCycleRecord): boolean =>
  cycle.vendorFailure === undefined &&
  cycle.completion.kind === 'blocked' &&
  NO_FRESH_TAIL_PATTERN.test(cycle.completion.reason);

/** The exact match {@link findReusableCycle} looks for (record.ts reuse/readiness). */
export interface ReuseSelectionInput {
  /** The intended PR target of the review request. */
  target: string;
  /** The pinned immutable base of the review request. */
  base: string;
  /** The HEAD sha of the review request. */
  head: string;
  /** The dirty identity of the review request. */
  dirtySha256: string;
  /** The diff scope of the review request. */
  scope: 'full' | 'uncommitted';
  /** The reviewer of the review request. */
  reviewer: string;
}

/** One reuse selection: the matching cycle, why it qualifies, and the blocked tail it resolves. */
export type ReuseSelection =
  | { cycle: DevCycleRecord; basis: 'exact-terminal' }
  | {
      cycle: DevCycleRecord;
      basis: 'no-fresh-tail';
      /** The latest same-identity affirmative no-fresh blocked attempt. */
      resolvesCycleId: string;
    };

/**
 * Pure Q4 selector (#485): find the terminal full-scope cycle whose record
 * identity EXACTLY equals the request (target, base, head, dirtySha256,
 * scope and reviewer — the readiness anchor's identity fields plus the
 * request shape; a dirty scope mismatch, a changed target at the same
 * merge-base, a moved head or base, or a different reviewer never match),
 * and classify the ledger's same-identity resolution tail — every attempt
 * after the selected cycle:
 *   - there is no tail (the latest cycle IS the selected cycle) →
 *     `exact-terminal`;
 *   - EVERY tail attempt is an affirmative NO-FRESH blocked attempt (the
 *     vendor itself said it never reviewed; retries may each come back
 *     empty) → `no-fresh-tail` carrying `resolvesCycleId` of the last one —
 *     the explicit, auditable reuse resolution; every blocked attempt stays
 *     in the ledger verbatim;
 *   - the latest cycle is any OTHER blocked attempt, a genuine blocker
 *     ANYWHERE in the tail, or a terminal cycle that is not the selection
 *     (an earlier terminal does not paper over a newer unrelated one) → no
 *     reuse. An intervening genuine blocker is never resolved away by a
 *     later no-fresh attempt: it was never reviewed, so no reuse may be
 *     selected over it.
 *
 * Configuration (which reviewers count) is the readiness core's concern;
 * the cycle op additionally re-checks its own scope emptiness before
 * selecting, so this function deliberately reads ONLY identity and
 * completion. `null` means: dispatch a fresh cycle.
 */
export function findReusableCycle(
  records: readonly DevRecord[],
  input: ReuseSelectionInput,
): ReuseSelection | null {
  const sameIdentity = (cycle: DevCycleRecord): boolean =>
    cycle.scope === input.scope &&
    cycle.reviewer === input.reviewer &&
    cycle.target === input.target &&
    cycle.base === input.base &&
    cycle.head === input.head &&
    cycle.dirtySha256 === input.dirtySha256;
  const cycles = records.filter(
    (record): record is DevCycleRecord =>
      record.kind === 'cycle' && record.scope === 'full' && sameIdentity(record),
  );
  const selected = [...cycles]
    .reverse()
    .find((cycle) => cycle.completion.kind === 'terminal' && cycle.vendorFailure === undefined);
  if (selected === undefined) return null;
  const tail = cycles.slice(cycles.lastIndexOf(selected) + 1);
  const latest = tail.at(-1);
  if (latest === undefined) return { cycle: selected, basis: 'exact-terminal' };
  // The WHOLE tail is the resolution: an attempt between the selected
  // terminal and the latest one is never skipped over. A genuine blocker
  // there (unknown error, action required, malformed stream, deadline kill,
  // structured vendor failure) was never reviewed, so it refuses reuse even
  // when the latest attempt is a resolvable affirmative no-fresh notice.
  if (!tail.every(isAffirmativeNoFreshAttempt)) return null;
  return { cycle: selected, basis: 'no-fresh-tail', resolvesCycleId: latest.cycleId };
}

const DevLedgerFileSchema: z.ZodType<DevLedgerFile> = z
  .object({
    version: z.literal(DEV_LEDGER_VERSION),
    branch: z.string().min(1),
    records: z.array(DevRecordSchema),
  })
  .strict();

/**
 * The record id of a cycle/check/reuse record (dispositions have none).
 * The kinds share ONE uniqueness space: a duplicate id is a format error,
 * so a hand-merged file can never slip a second cycle or reuse past the
 * store under another record's identity.
 */
function recordIdOf(record: DevRecord): string | null {
  if (record.kind === 'cycle') return record.cycleId;
  if (record.kind === 'check') return record.checkId;
  if (record.kind === 'reuse') return record.reuseId;
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

// The refname grammar itself is the shared zero-import leaf (shared/refname.ts):
// the dev ledger validator and the queue wire/origin schemas must agree on it, and
// this module cannot host it without closing the queueProtocol -> record ->
// deferredReview -> queueProtocol runtime cycle.

/**
 * The branch encoded into ONE bounded, collision-free filename segment: a
 * readable prefix of the branch (slashes flattened, '%' escaped first so
 * the flattening stays injective on the prefix) plus a 16-hex sha256 of the
 * FULL branch name. The hash keeps distinct branches distinct (`a%2Fb` vs
 * `a/b` hash apart), and the prefix+hash cap keeps even git's maximal
 * hierarchical refs under the filesystem's 255-byte name limit.
 */
export function encodeBranchForFilename(branch: string): string {
  const flattened = branch.replaceAll('%', '%25').replaceAll('/', '-');
  const hash = createHash('sha256').update(branch, 'utf8').digest('hex').slice(0, 16);
  return `${flattened.slice(0, 64)}-${hash}`;
}

/** The ledger's path inside the repo root: `.cq/dev/<encoded-branch>.json`. */
export function devLedgerPath(repoRoot: string, branch: string): string {
  const fault = branchPathFault(branch);
  if (fault !== null) throw new Error(`dev-record: ${fault}`);
  return resolve(repoRoot, '.cq', 'dev', `${encodeBranchForFilename(branch)}.json`);
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
  const branchFile = `${encodeBranchForFilename(branch)}.json`;

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
    const ledger = parseDevLedger(readFileSync(realFile, 'utf8'));
    if (ledger.branch !== branch) {
      throw new Error(
        `dev-record: the ledger at '${realFile}' belongs to branch '${ledger.branch}', not '${branch}' — refusing to read another branch's evidence`,
      );
    }
    return ledger;
  };

  const publish = (file: DevLedgerFile): void => {
    mkdirSync(dirname(targetAbs), { recursive: true });
    const realParent = realpathSync(dirname(targetAbs));
    containedOrThrow(join(realParent, branchFile), 'write');
    publishAtomic(targetAbs, serializeDevLedger(file));
  };

  const mutex = makeGitMutex({
    lockPath: join(rootReal, '.cq', 'dev', `${encodeBranchForFilename(branch)}.lock`),
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
  'is green required CI on the exact resolved candidate SHA (not the PR head: required status ' +
  "checks are non-strict here, so a green head can be stale), plus the reviewer bots' PR review " +
  'at the final head and a non-author exact-head attestation.';

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
  /** Which configured reviewer supplied the terminal cycle. */
  reviewer: string;
  /** Visible vendor obligation or verified affected-current completion; never full-branch credit. */
  vendorDebt?: DeferredVendorDebt;
  /**
   * The explicit Q4 reuse selection behind this record, when readiness
   * resolved an affirmative no-fresh blocked tail (#485) — the reuse
   * record's id in the same ledger. Report context only: the reuse is
   * author evidence, never verification or independent acceptance.
   */
  reuse?: string;
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
  /** Configured reviewer families (`agent` admits `agent:<role>` ledger identities). */
  configuredReviewers?: readonly string[];
  /** Fresh authoritative queue read over the latest exact persisted debt. */
  deferredVendorDebt?: DeferredVendorDebt;
  /** ISO-8601 timestamp for the assembled record. */
  nowIso: string;
}

/**
 * The dev.ready / pr.open shared core: assemble the author-tier readiness
 * record from the ledger, or name every gap. The requirements (strategy §3,
 * dev.ready row; ONE completed CodeRabbit cycle per ruling D-J, §6 "Now"):
 *   - the latest TERMINAL FULL-SCOPE review cycle is at the CURRENT identity
 *     and target (base, head and dirty identity all three — any mismatch is
 *     a stale identity; a blocked or uncommitted-scope cycle never counts);
 *     a stacked branch pins its stack parent by naming it as the target;
 *   - the latest review ATTEMPT was not blocked (a blocker is reported, never
 *     papered over by an older terminal cycle) — with ONE Q4 exception
 *     (#485): an affirmative NO-FRESH blocked attempt at the current
 *     identity is resolved by an explicit reuse record that names both it
 *     and the selected terminal cycle; any other blocked attempt, or a
 *     reuse record for anything else, stays a gap and is reported;
 *   - zero OPEN blocking findings across EVERY cycle in the ledger, blocked
 *     attempts included: a blocking-severity finding is open until a
 *     fixed/rejected disposition names it. A newer cycle re-reviews the
 *     current state — it does not adjudicate the past. A deferred
 *     disposition does NOT close one;
 *   - the LATEST check record (whatever its verdict — a red run after a
 *     green one is the current verdict) is GREEN at the current identity
 *     and target;
 *   - no untracked non-ignored files (their content is outside every
 *     recorded review scope).
 */
export function assembleReadiness(
  input: AssembleReadinessInput,
): { ready: true; record: DevReadinessRecord } | { ready: false; gaps: ReadinessGap[] } {
  const gaps: ReadinessGap[] = [];
  const { identity, ledger } = input;
  const configuredReviewers = new Set(input.configuredReviewers ?? ['coderabbit', 'agent']);
  const isConfigured = (reviewer: string) =>
    configuredReviewers.has(reviewer) ||
    (reviewer.startsWith('agent:') && configuredReviewers.has('agent'));
  const debt = input.deferredVendorDebt;
  const cycles = ledger.records.filter(
    (record): record is DevCycleRecord => record.kind === 'cycle',
  );
  // Current authority is the identity-matched enrollment and its authorized predecessor chain,
  // never the positionally last appended snapshot.
  const enrollmentRead = readCurrentEnrollment(ledger, identity, input.target);
  if (enrollmentRead.kind === 'ambiguous')
    gaps.push({
      field: 'vendor-debt',
      detail: `ambiguous current enrollment: ${enrollmentRead.requestIds.join(', ')} claim one identity`,
    });
  const enrollment = enrollmentRead.kind === 'enrollment' ? enrollmentRead.enrollment : undefined;
  const binding = debt?.reference.binding;
  const debtValid =
    debt !== undefined &&
    binding?.kind === 'deferred-author' &&
    enrollment !== undefined &&
    JSON.stringify(enrollment.snapshot.reference) === JSON.stringify(debt.reference) &&
    JSON.stringify(enrollment.snapshot.originAttempt) === JSON.stringify(debt.originAttempt) &&
    JSON.stringify(enrollment.snapshot.deferral) === JSON.stringify(debt.deferral) &&
    hasPersistedVendorOutageOrigin(debt.originAttempt, cycles) &&
    matchesDeferredVendorDebt(debt, {
      repo: binding.repo,
      producer: binding.producer,
      target: input.target,
      head: identity.head,
      base: identity.base,
      dirtySha256: identity.dirtySha256,
      deferralId: debt.deferral.id,
    }) &&
    configuredReviewers.has('coderabbit') &&
    configuredReviewers.has('agent') &&
    [...configuredReviewers].every((reviewer) => reviewer === 'coderabbit' || reviewer === 'agent');
  if (debt !== undefined && !debtValid)
    gaps.push({
      field: 'vendor-debt',
      detail:
        'deferred debt does not match the retained origin, latest enrollment and current identity',
    });
  // A pending current enrollment legitimately continues; an unsettled AUTHORIZED ANCESTOR never
  // does. This is derived from the ledger, so a truncated or unrefreshed lineage is never clean.
  if (enrollment !== undefined && enrollment.pendingAncestry.length > 0)
    gaps.push({
      field: 'vendor-debt',
      detail: `authorized predecessor obligation(s) unsettled: ${enrollment.pendingAncestry
        .map((ancestor) => ancestor.reference.requestId)
        .join(', ')}`,
    });

  // Only a FULL-scope terminal cycle satisfies readiness: an
  // uncommitted-scope cycle never covered the committed part of the
  // intended PR diff, so calling it evidence for the whole diff would
  // fabricate readiness.
  const terminalCycles = ledger.records.filter(
    (record): record is DevCycleRecord =>
      record.kind === 'cycle' &&
      record.scope === 'full' &&
      record.completion.kind === 'terminal' &&
      record.vendorFailure === undefined &&
      (!debtValid || record.reviewer.startsWith('agent:')) &&
      isConfigured(record.reviewer),
  );
  const cycle = terminalCycles[terminalCycles.length - 1];
  if (cycle === undefined) {
    gaps.push({
      field: 'terminal-review-cycle',
      detail:
        'no terminal full-scope review cycle recorded — run dev.review without --uncommitted (a blocked or uncommitted-scope cycle does not count)',
    });
  } else {
    if (
      debtValid &&
      (!cycle.agentCoverage ||
        !isCoverageV2Complete(cycle.agentCoverage) ||
        cycle.agentCoverage.scope !== 'full' ||
        cycle.agentCoverage.head !== identity.head ||
        cycle.agentCoverage.base !== identity.base)
    )
      gaps.push({
        field: 'agent-coverage',
        detail:
          'deferred vendor readiness requires fresh full v2 engine coverage at the current head and base',
      });
    const stale: string[] = [];
    // The cycle's RECORDED TARGET must be the requested one — the same rule
    // the check record enforces: when two targets share a merge-base,
    // identity alone cannot tell the evidence apart, and attributing a
    // cycle to a target it never ran against would fabricate readiness.
    if (cycle.target !== input.target) {
      stale.push(`recorded for target '${cycle.target}', not '${input.target}'`);
    }
    if (cycle.base !== identity.base) stale.push(`base ${cycle.base} → ${identity.base}`);
    if (cycle.head !== identity.head) stale.push(`head ${cycle.head} → ${identity.head}`);
    if (cycle.dirtySha256 !== identity.dirtySha256) {
      stale.push('the working-tree diff changed since the review');
    }
    if (stale.length > 0) {
      gaps.push({
        field: 'stale-review-identity',
        detail: `review ${cycle.cycleId} (reviewer '${cycle.reviewer}', scope '${cycle.scope}') is stale: ${stale.join('; ')}`,
      });
    }
    // EVERY cycle's blocking findings — any scope, blocked attempts
    // included — must be closed by a disposition: the readiness anchor must
    // be full-scope, but an uncommitted-scope cycle's critical finding is
    // just as open.
    const blocking = new Set(
      (input.blockingSeverities ?? DEFAULT_BLOCKING_SEVERITIES).map((s) => s.toLowerCase()),
    );
    const closed = new Map<string, DevDispositionRecord['action']>();
    for (const record of ledger.records) {
      if (record.kind === 'disposition') closed.set(record.findingId, record.action);
    }
    // Configuration chooses which reviewer may satisfy the readiness anchor;
    // it does not erase findings already recorded by a reviewer that was later
    // removed from cq.json. Every cycle remains subject to disposition.
    const adjudicable = ledger.records.filter(
      (record): record is DevCycleRecord => record.kind === 'cycle',
    );
    const open: string[] = [];
    for (const entry of adjudicable) {
      for (const finding of entry.findings) {
        if (!blocking.has(finding.severity.toLowerCase())) continue;
        const action = closed.get(finding.id);
        if (action === 'fixed' || action === 'rejected') continue;
        open.push(
          entry.cycleId === cycle.cycleId
            ? `${finding.id} (${finding.severity})${finding.fileName === '' ? ': unresolved: finding has no file path' : ''}`
            : `${finding.id} (${finding.severity}, from earlier cycle ${entry.cycleId} — a newer cycle does not adjudicate it; record its disposition)${finding.fileName === '' ? ': unresolved: finding has no file path' : ''}`,
        );
      }
    }
    const receipts = deferredReceiptFindings([
      ...ledger.records.filter((entry) => entry.kind === 'vendor-debt').map((entry) => entry.debt),
      ...(debt ? [debt] : []),
    ]);
    for (const finding of receipts) {
      if (!blocking.has(finding.severity.toLowerCase())) continue;
      const action = closed.get(finding.id);
      if (action !== 'fixed' && action !== 'rejected')
        open.push(
          `${finding.id} (${finding.severity}, from verified affected-current vendor receipt)${finding.file === '' ? ': unresolved: finding has no file path' : ''}`,
        );
    }
    if (open.length > 0) {
      gaps.push({
        field: 'open-blocking-findings',
        detail: `open blocking findings: ${open.join(', ')}`,
      });
    }
  }

  // The LATEST configured review ATTEMPT overall: if it was BLOCKED, the author's most
  // recent review evidence is a failure — readiness never silently leans on
  // an older terminal cycle past a blocked attempt. The ONE Q4 resolution
  // (#485): an affirmative NO-FRESH attempt at the CURRENT request identity
  // (the vendor itself said it never reviewed — the earlier receipt is the
  // only review that exists) is settled by an explicit reuse record naming
  // both the blocked tail and the selected terminal cycle. That resolution
  // is auditable, additive, and reported on the ready record; every other
  // blocked attempt (error, auth, rate limit, malformed stream, deadline
  // kill, or any structured vendor-failure class) stays a real gap.
  const allCycles = ledger.records.filter(
    (record): record is DevCycleRecord => record.kind === 'cycle' && isConfigured(record.reviewer),
  );
  const latestAttempt = allCycles[allCycles.length - 1];
  // A later unrelated vendor blocker must survive even when a fresh agent ran after it.
  const latestVendor = allCycles.filter((entry) => entry.reviewer === 'coderabbit').at(-1);
  const latestAgent = allCycles.filter((entry) => entry.reviewer.startsWith('agent:')).at(-1);
  if (debtValid && latestAgent?.cycleId !== cycle?.cycleId)
    gaps.push({
      field: 'latest-review-blocked',
      detail: 'the latest agent attempt is not the current full terminal coverage anchor',
    });
  if (!debtValid && latestVendor?.vendorFailure !== undefined)
    gaps.push({
      field: 'vendor-debt',
      detail: 'vendor outage requires verified durable current enrollment before continuation',
    });
  if (
    debtValid &&
    latestVendor?.completion.kind === 'blocked' &&
    latestVendor.cycleId !== debt.originAttempt.cycleId
  )
    gaps.push({
      field: 'latest-review-blocked',
      detail: 'a newer vendor blocker is not covered by the persisted outage origin',
    });
  const noFreshReuse =
    [...ledger.records]
      .reverse()
      .find(
        (record): record is DevReuseRecord =>
          record.kind === 'reuse' && record.basis === 'no-fresh-tail',
      ) ?? null;
  // The row that actually resolves this readiness, set ONLY where the linkage
  // is validated below: the ready record attributes this row, so attribution
  // can never rest on a second, divergent predicate.
  let resolvedNoFreshReuse: DevReuseRecord | undefined;
  if (
    latestAttempt !== undefined &&
    latestAttempt.completion.kind === 'blocked' &&
    !(
      debtValid &&
      latestAttempt.reviewer === 'coderabbit' &&
      latestAttempt.cycleId === debt.originAttempt.cycleId
    )
  ) {
    const sameRequest =
      latestAttempt.target === input.target &&
      latestAttempt.base === identity.base &&
      latestAttempt.head === identity.head &&
      latestAttempt.dirtySha256 === identity.dirtySha256;
    // The reuse row resolves ONLY the eligible tail: every same-identity
    // full-scope attempt after the named anchor terminal must itself be an
    // affirmative no-fresh notice. A genuine blocker in between (unknown
    // error, action required, malformed stream, deadline kill, structured
    // vendor failure) was never reviewed and is never resolved away —
    // findReusableCycle refuses it too, so a linkage persisted before that
    // rule (or forged into the ledger) cannot pass readiness either.
    const identityCycles = cycles.filter(
      (entry) =>
        entry.scope === 'full' &&
        entry.reviewer === latestAttempt.reviewer &&
        entry.target === latestAttempt.target &&
        entry.base === latestAttempt.base &&
        entry.head === latestAttempt.head &&
        entry.dirtySha256 === latestAttempt.dirtySha256,
    );
    // The persisted reuse resolves against the terminal cycle IT NAMES — the
    // blocked attempt's own reviewer at the exact request identity — not the
    // global readiness anchor, which may be another configured reviewer's
    // later terminal (PR580 thread 4394615080, tracking #593). The global
    // anchor keeps its coverage role on the ready record below and must still
    // exist; it just may not stand in for a different reviewer's evidence.
    const referencedIndex =
      noFreshReuse === null
        ? -1
        : identityCycles.findIndex(
            (entry) =>
              entry.cycleId === noFreshReuse.cycleId &&
              entry.completion.kind === 'terminal' &&
              entry.vendorFailure === undefined,
          );
    const tailIndex = identityCycles.findIndex((entry) => entry.cycleId === latestAttempt.cycleId);
    // The full-tail proof stays (Q6 #485 / 70601ab1): every same-reviewer
    // same-identity attempt AFTER the referenced terminal — the blocked tail
    // included — must be an eligible affirmative no-fresh notice.
    const resolvedTailIsEligible =
      referencedIndex >= 0 &&
      tailIndex > referencedIndex &&
      identityCycles.slice(referencedIndex + 1).every(isAffirmativeNoFreshAttempt);
    const reuseResolves =
      sameRequest &&
      latestAttempt.scope === 'full' &&
      isConfigured(latestAttempt.reviewer) &&
      isAffirmativeNoFreshAttempt(latestAttempt) &&
      resolvedTailIsEligible &&
      noFreshReuse !== null &&
      noFreshReuse.resolvesCycleId === latestAttempt.cycleId &&
      noFreshReuse.reviewer === latestAttempt.reviewer &&
      noFreshReuse.scope === 'full' &&
      noFreshReuse.target === input.target &&
      noFreshReuse.head === identity.head &&
      noFreshReuse.base === identity.base &&
      noFreshReuse.dirtySha256 === identity.dirtySha256 &&
      ledger.records.indexOf(noFreshReuse) > ledger.records.indexOf(latestAttempt) &&
      cycle !== undefined;
    if (!reuseResolves) {
      gaps.push({
        field: 'latest-review-blocked',
        detail: `the latest review attempt ${latestAttempt.cycleId} was BLOCKED (${latestAttempt.completion.reason}) — resolve the blocker and re-run dev.review (an older terminal cycle does not paper over it)`,
      });
    } else if (noFreshReuse !== null) {
      resolvedNoFreshReuse = noFreshReuse;
    }
  }

  // The LATEST check record, WHATEVER its verdict: a green run followed by
  // a red run at the same identity is not ready — filtering to passed runs
  // would read a stale green past a fresh red verdict.
  const allChecks = ledger.records.filter(
    (record): record is DevCheckRecord => record.kind === 'check',
  );
  const check = allChecks[allChecks.length - 1];
  if (check === undefined) {
    gaps.push({ field: 'green-check', detail: 'no dev.check recorded — run dev.check' });
  } else if (!check.passed) {
    gaps.push({
      field: 'red-check',
      detail: `the latest check ${check.checkId} is RED — fix and re-run dev.check (an earlier green run does not override it)`,
    });
  } else {
    const stale: string[] = [];
    // The check's RECORDED TARGET must be the requested one: when two
    // targets share a merge-base, identity alone cannot tell the evidence
    // apart, and relabeling another target as main-target readiness
    // would be fabrication.
    if (check.target !== input.target) {
      stale.push(`recorded for target '${check.target}', not '${input.target}'`);
    }
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
    reviewer: cycle.reviewer,
    ...(debtValid ? { vendorDebt: debt } : {}),
    ...(resolvedNoFreshReuse === undefined ? {} : { reuse: resolvedNoFreshReuse.reuseId }),
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
