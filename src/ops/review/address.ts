import {
  leasedPush,
  resolvePushDestination,
  type PushDestination,
} from '../../adapters/git/leasedPush.js';
import { reviewBranchKey } from './internal/branchKey.js';
import { provenanceConfig } from '../../config/provenance.js';
import { currentCqEnv } from '../../config/run-env.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  realpath,
  lstat,
  rename,
  unlink,
} from 'node:fs/promises';
import { resolve, join, posix, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createDriverFactory, type DriverFactory } from '../../driver/factory.js';
import { correlationInvocation } from '../../driver/correlationInvocation.js';
import type { Usage, WorkerResult } from '../../driver/types.js';
import { createGovernor, currentJobContext } from '../../kernel/governor.js';
import { runPlan, type OpRegistryView } from '../../kernel/runner.js';
import type { OpRegistryEntry, OpResult, Plan, RunReport } from '../../kernel/types.js';
import { makeGhRunner, type GhFn } from '../../adapters/forge-github/gh.js';
import { fetchReviewState } from '../../adapters/forge-github/fetchReviewState.js';
import { requestReviewers } from '../../adapters/forge-github/requestReviewers.js';
import type { SlotWorktreeRegistry } from '../../adapters/git/slotWorktreeRegistry.js';
import { loopReplyVerdict, replySignature } from '../../plans/review-loop.js';
import { DEFAULT_REVIEW_WALL_MS, parseCqConfig, type CqConfig } from '../analyze/cqConfig.js';
import { resolveCqConfigDefaults, requireAgenticTokenBudget } from '../analyze/cqConfigDefaults.js';
import { makeDevDisposition } from '../dev/disposition.js';
import { makeSubprocessDevEffects, type DevEffects } from '../dev/effects.js';
import {
  FindingsRecordSchema,
  findingDispositionView,
  isComplete,
  legacyEvidenceText,
  merge,
  openBlocking,
  type Finding,
  type FindingsRecord,
} from './findings.js';
import { makeReviewRun, type ReviewRunInput, type ReviewRunResult } from './run.js';
import { restoreDurableDisposition, sameFindingContent } from './internal/durableDisposition.js';
import {
  makeAddressWorker,
  type AddressAttempt,
  type AddressFix,
  type AddressWorker,
  type AddressPrecondition,
} from './addressWorker.js';
import {
  verifyClosureEvidence,
  type ClosurePacket,
  type ClosureVerification,
} from './internal/addressVerification.js';
import { makeAddressBookkeepingReceipt } from './internal/addressBookkeeping.js';
import { parseQueueReceipt } from './internal/queueEvidence.js';
import type { DeferredQueueClient } from './internal/queueProtocol.js';
import {
  resolveDeferredVendorContext,
  type DeferredVendorContextRequest,
  type DeferredVendorContext,
} from './internal/addressDeferred.js';
import {
  hasDeferredReviewSources,
  type DeferredVendorDebt,
} from '../dev/internal/deferredReview.js';
import type { AddressFailedAttempt } from './internal/addressEvidence.js';
import { FixReviewItemInputSchema } from './registry.js';
import {
  NO_OUTCOME_REASON,
  type FixReviewItemInput,
  type FindingReviewItemInput,
  type FixReviewItemResult,
} from './fixReviewItem.js';
import { readWorkState } from '../dev/internal/workState.js';
import {
  addressCancelledResult,
  noteAddressOpaqueInvocation,
  bindAddressTerminalReport,
  addressTerminalBookkeeping,
  addressOrdinaryReport,
  addressTerminalWorkerBinding,
  isAddressOwnershipAdmissionRefusal,
  isAddressCheckoutIncomplete,
  runAddressReviewLoop,
  withAddressOwnership,
  type AddressLease,
} from './internal/addressCheckoutOwnership.js';
import {
  DEV_LEDGER_VERSION,
  devLedgerPath,
  type DevCycleRecord,
  type DevLedgerFile,
} from '../dev/record.js';
import {
  createKnownUsageLedger,
  normalizeUsageObservation,
  type KnownUsageSummary,
} from '../../shared/knownUsage.js';
import {
  openObservationWriter,
  readKernelRunDescriptors,
  type KernelRunDescriptor,
  type ObservationWriter,
} from '../../kernel/observation.js';
import type {
  AvailabilityRecord,
  CompositionStartedJournalEvent,
  FindingDispositionJournalEvent,
  FindingFingerprint,
  ReportV2,
  KernelRunLinkedJournalEvent,
  ProvenanceRecord,
  ReviewObservedJournalEvent,
} from '../../kernel/types.js';
import { ReviewCoverageSchema } from './internal/reviewPartitions.js';
import { isCoverageV2Complete } from './internal/reviewCoverageV2.js';
import { repoIdFromRemote, sanitizeObservation } from '../fix/attemptRecord.js';
import { resolveCorrelation } from '../fix/correlation.js';
import { assembleReportV2 } from '../fix/reportFold.js';
import { measureRun, reviewPlannedUnitsOf } from '../fix/measurement.js';

export interface ReviewAddressInput {
  repoRoot: string;
  source: string;
  /** Prepared checkout matching PR metadata; read-only dependency source. */
  dependencyRoot?: string;
  expectedHead?: string;
  record?: string;
  target?: string;
  base?: string;
  maxTokens?: number;
  wallMs?: number;
  rounds?: number;
  concurrency?: number;
  journalDir?: string;
  push?: boolean;
  /** Require deterministic closure evidence before persisting a fixed disposition. */
  verifyClosure?: boolean;
}
export interface ReviewAddressReport {
  /**
   * The persisted report format version (ADR-0005 decision 10). The writer
   * always writes 1; a reader treats an absent version as legacy v1 (old
   * runner caches hold pre-version reports) and refuses any other value
   * fail-closed. The cross-process measurement reader enforces this on the
   * reportV2 envelope; the in-process consumers receive the same object.
   */
  version: 1;
  source: string;
  /** Selected dependency source; prerequisite checks may still refuse it. */
  dependencySource?: { kind: 'caller' | 'prepared'; root: string };
  reportPath: string;
  /** One entry per round; the latest reviewed record and all settled batch runs. */
  rounds: Array<{ round: number; record: FindingsRecord; runs: RunReport[] }>;
  findings: Finding[];
  /** Report context only: review advisories never enter `findings` or dispatch. */
  advisories?: string[];
  openBlocking: Finding[];
  /**
   * ADR-0008 baseline seam: the ROUND-1 open-blocker population. It is seeded
   * BEFORE the dispatch loop from the PLANNED item population (the open
   * blocking threads the run is about to work), so an exit taken before any
   * item admits (an admission or closure refusal, a truncated fetch, a moved
   * worker branch, a throwing fetch) still reports the planned population and
   * not just the ids dispatched so far. The FULL open-thread population is
   * merged only on the normal path, before the PR re-review: on an early
   * exit, a thread excluded from planning (blocked) can be missing from this
   * baseline. Round 1 may only GAIN ids afterwards, deduplicated, in
   * first-seen order: each PR dispatch item still captures its own id before
   * `admitRecord` can refuse, the round-1 agent re-review's record is
   * captured before its same-round dispatch, and the local path captures its
   * admitted record after deferred-source restoration and before dispatch,
   * so a blocker the restoration reopens or appends is in the population the
   * run works. It is never reassigned and never shrunk: `openBlocking` is
   * recomputed after fixes and replaced by each successful re-review, so
   * substituting it for the measurement baseline would inflate
   * fixes-per-run. Absent only when the run exits before that population is
   * known: unknown, never an empty baseline.
   */
  initialOpenBlocking?: string[];
  fixes: AddressFix[];
  closureVerifications?: Array<{
    finding: string;
    packet: ClosurePacket;
    verification: ClosureVerification;
  }>;
  attempts: AddressAttempt[];
  failed: AddressFailedAttempt[];
  fixesPerRun: number;
  usage: Usage;
  costUSD?: number;
  /**
   * Retained exit spend (M7-address): each settled driver dispatch folds into
   * this summary exactly once, on every terminal exit — success, failure,
   * budget exhaustion, cancellation and a thrown fault included. A dispatch
   * whose provider supplied no measurement settles as an explicit unknown,
   * never a measured zero. The ONLY report-shape addition of this slice: a
   * new optional field carrying the existing KnownUsageSummary shape (the
   * same carrier the agent review leg already uses); no event kinds,
   * migration versions or other wire contracts change.
   */
  usageSummary?: KnownUsageSummary;
  wallMs: number;
  reasons: string[];
  preconditions?: AddressPrecondition[];
  escalation?: ReturnType<AddressWorker['escalation']>;
  /**
   * The leg's structured terminal outcome: round cap, run budget, or a
   * re-review still blocked on a network/transient class after one retry
   * with verified fixes. Compositions use it to decide draft publication.
   * Deliberately NOT parsed
   * out of `reason` — finish() appends '; report: <path>' to every
   * needs-human reason, so string-matching the reason can never be exact.
   * Rides the report envelope (the kernel-sanctioned extension, stripped
   * before the strict OpResultSchema base parse) — a top-level result field
   * would be an unrecognized key and trip the frozen taxonomy.
   */
  stop?: 'round-cap' | 'budget' | 'rereview-blocked';
  /** Last admitted head, advanced only by verified fix commits. */
  verifiedHead?: string;
  /**
   * The engine-verified head this invocation's report is attributable to,
   * captured once at the first successful admission and never advanced by fix
   * commits or refreshed by a re-review. Consumers that must attribute a report
   * to an observed head compare against THIS witness; `verifiedHead` (last
   * admitted) and `rounds[].record.head` (overwritten by `noteRound` after a
   * successful re-review) are not substitutes. Absent when the invocation
   * refused before admitting any head — and a report that admitted earlier work
   * keeps its witness through a later refusal.
   */
  admissionHead?: string;
  /** Durable author debt remains explicit; address success is not vendor completion. */
  deferredVendorDebt?: DeferredVendorDebt;
  /**
   * ADR-0008 T31: the composition observation surface. Present whenever the
   * composition declared one: a durable stream once ownership is held, or the
   * explicit no-stream surface (unavailable/indeterminate plus a reason) when
   * the run never held ownership, the base was unwitnessable, or the journal
   * was unusable. It never claims durable observation without an open stream,
   * and never carries the writer.
   */
  observation?: ReviewAddressObservation;
  reportV2?: ReportV2;
}

/** The composition observation surface makeReviewAddress exposes to its report. */
export interface ReviewAddressObservation {
  persistence: ObservationWriter['persistence'];
  status: 'durable' | 'unavailable' | 'indeterminate';
  compositionRunId: string;
  workId: string;
  /**
   * The engine-witnessed composition base: the local HEAD, or the
   * caller-asserted PR head this composition's checkout starts from. null
   * means UNAVAILABLE — no base could be witnessed (never an inferred value,
   * and never the coordination checkout's HEAD on a `pr:N` source).
   */
  baseSha: string | null;
  failure: string | null;
  kernelRuns: KernelRunDescriptor[];
  /** Availability of ReportV2 assembly; observational failures never change the verdict. */
  availability?: AvailabilityRecord;
}
export type ReviewAddressResult = OpResult<ReviewAddressReport> & {
  report?: ReviewAddressReport;
};
export interface ReviewAddressDeps {
  /** Durable receipts and per-PR exclusion domain for isolated bulk checkouts. */
  coordinationRoot?: string;
  drivers?: DriverFactory;
  managedSubmit?: import('../dev/managedReview.js').ManagedReviewSubmit;
  git?: GhFn;
  gh?: GhFn;
  worktreeRegistry?: SlotWorktreeRegistry;
  config?: CqConfig;
  initialRecord?: FindingsRecord;
  /**
   * Narrow queue capability for the DEFAULT runner only: it is forwarded verbatim
   * into `makeReviewRun`, never into `deps.review`, and changes no other wiring.
   */
  queueClient?: DeferredQueueClient;
  review?: (input: ReviewRunInput) => Promise<ReviewRunResult>;
  workerFactory?: (deps: Parameters<typeof makeAddressWorker>[0]) => AddressWorker;
  disposition?: (root: string, finding: Finding) => Promise<OpResult<unknown>>;
  resolveDeferredVendorContext?: (
    request: DeferredVendorContextRequest,
  ) => Promise<DeferredVendorContext | undefined>;
  /**
   * ADR-0008 T31 test seam: a writer the composition adopts INSTEAD of
   * opening its own (memory-only fixtures). Production callers omit this.
   * Runtime-only: never serialized into any dispatch input.
   */
  observationWriter?: ObservationWriter;
}

/**
 * ADR-0008 T31 header metadata helpers for the composition stream.
 *
 * Provenance is captured engine-side with sanitized text (the raw remote
 * never persists — repoId is the hashed digest or null/unavailable when no
 * remote exists, never a failure). Correlation is allocated by the merged
 * T05 {@link resolveCorrelation} (validated UUID workId; unknown null).
 */
async function captureAddressProvenance(
  runPrefix: string,
  startedAt: string,
  baseSha: string,
  configJsonText: string,
  gitText: (args: string[]) => Promise<string>,
): Promise<{ provenance: ProvenanceRecord }> {
  // The resolved snapshot: a blank CQ_PRODUCER_VERSION is unset (registry contract).
  const cqEnv = currentCqEnv();
  const resolved = cqEnv.values['CQ_PRODUCER_VERSION'];
  const envVersion = typeof resolved === 'string' ? resolved : undefined;
  const [remote, packageVersion] = await Promise.all([
    // The composition's git transport answers this like every other read; a
    // missing remote is repoId null/unavailable (ADR-0008), never a failure.
    gitText(['config', '--get', 'remote.origin.url']).catch(() => ''),
    // The emitting package version: the toolkit's own package.json. The env
    // override never reads the file, and a read or parse failure degrades to
    // 'unavailable' — an observation PRE-FLIGHT failure never fails the run.
    envVersion !== undefined
      ? Promise.resolve(envVersion)
      : readFile(new URL('../../../package.json', import.meta.url), 'utf8')
          .then((text) => (JSON.parse(text) as { version?: string }).version)
          .catch(() => undefined),
  ]);
  const version = packageVersion ?? 'unavailable';
  const provenance: ProvenanceRecord = {
    cqVersion: version,
    producerVersion: version,
    repoId: repoIdFromRemote(remote).repoId,
    // Hash canonical effective cq.json CONTENT, never formatting or location.
    cqJsonHash: `sha256:${createHash('sha256').update(configJsonText, 'utf8').digest('hex')}`,
    baseSha,
    runPrefix,
    startedAt,
    endedAt: null,
    journalLink: 'unavailable',
    reportLink: 'unavailable',
    witnesses: { base: baseSha, admitted: null, execution: null, reviewed: null, accepted: null },
    config: provenanceConfig(cqEnv),
  };
  return sanitizeObservation({ provenance });
}

/** Deterministic file-disjoint waves. Missing scope is handled explicitly, never fanned out. */
export function addressBatches(findings: readonly Finding[], concurrency: number): Finding[][] {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('address concurrency must be positive');
  const pending = [...findings];
  const batches: Finding[][] = [];
  while (pending.length) {
    const files = new Set<string>();
    const batch: Finding[] = [];
    for (let i = 0; i < pending.length && batch.length < concurrency;) {
      const finding = pending[i]!;
      const file =
        finding.file === undefined || finding.file === ''
          ? undefined
          : posix.normalize(finding.file);
      if (file === undefined) {
        if (batch.length) break;
        batch.push(finding);
        pending.splice(i, 1);
        break;
      }
      if (!files.has(file)) {
        batch.push(finding);
        files.add(file);
        pending.splice(i, 1);
      } else i++;
    }
    batches.push(batch);
  }
  return batches;
}
const issue = (result: OpResult<unknown>) =>
  result.status === 'needs-human'
    ? result.reason
    : result.status === 'failed'
      ? result.error
      : result.status === 'indeterminate'
        ? result.detail
        : result.status;
const identity = (f: Finding) => JSON.stringify([f.file, f.line, f.rule, f.text]);
const discussionText = (
  body: string,
  comments: readonly { authorLogin: string | null; body: string; createdAt: string | null }[],
) =>
  comments.length
    ? `${body}\n\nFollow-up discussion (chronological):\n${comments.map((comment) => `Author: ${comment.authorLogin ?? 'unknown'}; at: ${comment.createdAt ?? 'unknown'}\n${comment.body}`).join('\n\n')}`
    : body;

/**
 * The address leg's ROUND-CAP stop reason, exported verbatim: the ONE
 * terminal outcome a pre-PR composition may publish a draft for (the spec's
 * "draft PR with the open findings at the round cap"). Every other refusal
 * — budget exhaustion, a blocked re-review, an admission failure, a parent
 * cancel — carries a report too, but publishing over it would turn a failed
 * run into needs-human-with-PR; callers must propagate those verbatim.
 */
export const REVIEW_ADDRESS_ROUNDCAP_REASON = 'review round cap reached with open findings';

/**
 * The severity every PR-thread finding is stamped with: the loop's dispatch
 * item, the fetched-thread record built before the re-review, and the round-1
 * seed's minimal PR-thread shape. One shared constant so the seed's blocking
 * filter and the produced rows can never drift apart — the seed filters the
 * ids it is handed against `blockingSeverities`, which must mean the same
 * severity the real rows carry.
 */
const PR_THREAD_FINDING_SEVERITY = 'major' as const;

/** SDK-first fix/disposition/re-review composition; kernel dispatch itself remains retry-free. */
export function makeReviewAddress(deps: ReviewAddressDeps = {}) {
  return async (input: ReviewAddressInput): Promise<ReviewAddressResult> => {
    const start = Date.now();
    const enclosingContext = currentJobContext();
    const ownershipAbort = new AbortController();
    const parent = AbortSignal.any(
      [enclosingContext?.signal, ownershipAbort.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    );
    let addressLease: AddressLease | undefined;
    const journalDir = resolve(
      input.journalDir ?? resolve(input.repoRoot, '..', '.cq-address-runs', randomUUID()),
    );
    const report: ReviewAddressReport = {
      version: 1,
      source: input.source,
      dependencySource: {
        kind: input.dependencyRoot === undefined ? 'caller' : 'prepared',
        root: resolve(input.repoRoot, input.dependencyRoot ?? '.'),
      },
      reportPath: resolve(journalDir, 'review-address-report.json'),
      rounds: [],
      findings: [],
      openBlocking: [],
      fixes: [],
      attempts: [],
      failed: [],
      fixesPerRun: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      wallMs: 0,
      reasons: [],
    };
    // M7-address: a fresh ledger per invocation, so one run's observations
    // never leak into another's summary. Dispatches settle exactly once
    // through account(); the snapshot is stamped onto every finish() exit.
    const usageLedger = createKnownUsageLedger();
    let dispatchSequence = 0;
    // ADR-0008 T31: the composition owns ONE observation stream for the whole
    // invocation — every round and every runPlan call — opened before the
    // first dispatch and closed in finish() BEFORE the report persists. The
    // writer (deps.observationWriter) or its failure never changes the
    // verdict; a write failure only marks the surface indeterminate.
    // An injected writer owns the identity it was opened with (ADR-0008 T31):
    // adopting it must not allocate a second, divergent composition run id.
    const injectedWriter = deps.observationWriter;
    const compositionRunId = injectedWriter?.compositionRunId ?? randomUUID();
    // `writer` is the streaming surface: link appends and the worker handoff
    // only ever use it once the composition header has ACTUALLY landed.
    // `closeWriter` is the lifecycle handle: every writer the composition
    // opened or adopted is closed exactly once, header or no header.
    let observation:
      | (ReviewAddressObservation & {
          writer?: ObservationWriter;
          closeWriter?: ObservationWriter;
          header?: CompositionStartedJournalEvent;
        })
      | undefined;
    let observationClosed = false;
    // T21 rulings: every exposure is emitted or counted withheld (one entry
    // per source, with its distinct reason); representable records count
    // separately so /reviews can distinguish known-zero from never-attempted.
    const withheldReviewReasons: string[] = [];
    let reviewExposureRecords = 0;
    // Links recorded by a settled PR fix run are appended asynchronously (the
    // loop does not await that callback). Keep every pending link so finish()
    // can drain them BEFORE the stream closes: a link must never race close(),
    // and a rejected link is an observation failure, never a silent swallow.
    const pendingLinks = new Set<Promise<void>>();
    const trackLink = (link: Promise<void>) => {
      pendingLinks.add(link);
      // `link` is always caught before it is tracked, so this chain cannot
      // reject; the trailing catch keeps the cleanup promise handled.
      void link.finally(() => pendingLinks.delete(link)).catch(() => undefined);
    };
    const observationFailure = (error: unknown) => {
      if (observation) {
        observation.status = 'indeterminate';
        observation.failure ??= sanitizeObservation(String(error));
      }
    };
    const closeObservation = async () => {
      if (!observation || observationClosed) return;
      observationClosed = true;
      const writer = observation.closeWriter;
      if (writer === undefined) return;
      try {
        await writer.close();
      } catch (error) {
        observationFailure(error);
      }
      if (writer.failure !== null) observationFailure(writer.failure);
    };
    /**
     * The report DTO for the observation surface — never the writer instance.
     * Shared by finish() and by the pre-ownership refusal paths, so a run that
     * never held ownership reports the same explicit no-stream shape instead
     * of silently omitting it.
     */
    const observationSurface = (): ReviewAddressObservation | undefined => {
      if (observation === undefined) return undefined;
      const writer = observation.writer;
      const assembled = assembleReportV2({
        writer,
        header: observation.header,
        failureFree: observation.status !== 'indeterminate',
        kernelRuns: observation.kernelRuns,
        producer: 'address',
        withheldReviewReasons: [...withheldReviewReasons],
        reviewExposureRecords,
      });
      if (assembled.reportV2) report.reportV2 = assembled.reportV2;
      return {
        availability: assembled.availability,
        persistence: observation.persistence,
        status: observation.status,
        compositionRunId: observation.compositionRunId,
        workId: observation.workId,
        baseSha: observation.baseSha,
        failure: observation.failure,
        kernelRuns: [...observation.kernelRuns],
      };
    };
    /**
     * ADR-0008 T23: print the honest review denominators on every exit AFTER
     * THE COMPOSITION STREAM OPENS — exactly one measurement-summary per run
     * through the composition writer, computed from this run's evidence
     * alone (no cross-run state). The exits before the header lands print
     * nothing: no stream exists, and that is correct.
     * `plannedUnits` is the captured INITIAL open-blocker population passed
     * with no `?? []`: an unseeded report is an unavailable denominator,
     * never a known-zero empty list, and each captured blocker is one
     * observed baseline failure. A commit whose message cannot be read
     * leaves the numerator unknown. An emission failure is evidence
     * (indeterminate observation), never a verdict.
     */
    let measurementEmitted = false;
    const appendMeasurementSummary = async (): Promise<void> => {
      const writer = observation?.writer;
      if (writer === undefined || measurementEmitted) return;
      measurementEmitted = true;
      try {
        const planned = reviewPlannedUnitsOf(report);
        const git =
          deps.git ?? makeGhRunner({ bin: 'git', cwd: input.repoRoot, timeoutMs: 10_000 });
        const messages = new Map<string, string>();
        for (const sha of new Set(
          report.fixes.flatMap((fix) => (fix.commit === undefined ? [] : [fix.commit])),
        )) {
          // Only a full lowercase object id ever reaches git: any other
          // value is an unreadable message (unknown), never a spawn.
          if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) continue;
          try {
            const message = await git(['show', '-s', '--format=%B', sha]);
            if (message.code === 0) messages.set(sha, message.stdout);
          } catch {
            // Unreadable message: that closure's trailer status is unknown.
          }
        }
        const { availability, ...metric } = measureRun(
          report.fixes,
          planned,
          new Map((planned ?? []).map((unitId) => [unitId, { completed: true, count: 1 }])),
          (sha) => messages.get(sha),
        );
        await writer.append({
          type: 'measurement-summary',
          runId: compositionRunId,
          at: new Date().toISOString(),
          unitId: null,
          jobId: null,
          taskId: null,
          attempt: null,
          payload: { metric, availability },
        });
      } catch (error) {
        observationFailure(error);
      }
    };
    const bookkeeping = new Map<string, string>();
    let bookkeepingTampered = false;
    let bookkeepingRevision = 0;
    let persistedBookkeeping: ReturnType<typeof makeAddressBookkeepingReceipt> | undefined;
    const noteAdvisories = (record: FindingsRecord) => {
      if (record.advisories === undefined || record.advisories.length === 0) return;
      report.advisories = [...new Set([...(report.advisories ?? []), ...record.advisories])];
    };
    const noteBookkeeping = async (path: string) => {
      const canonical = await realpath(path);
      const stat = await lstat(canonical);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error('bookkeeping is not an ordinary owned file');
      bookkeeping.set(
        canonical,
        createHash('sha256')
          .update(await readFile(canonical))
          .digest('hex'),
      );
      if (addressLease) await addressTerminalBookkeeping(addressLease, input.repoRoot, bookkeeping);
      bookkeepingRevision++;
    };
    let worker: AddressWorker | undefined;
    let publishOnExit: (() => Promise<void>) | undefined;
    let cleanStop: (() => string | undefined) | undefined;
    // Set by stop() when it observes the token/wall budget spent (after its
    // parent-cancel and tampered-bookkeeping precedence): every exit from
    // then on is a budget stop, whichever route reaches finish() — a direct
    // `finish(stop())`, or the driver wrapper's thrown stop reaching a catch.
    let budgetSpent = false;
    /**
     * The terminal state of the most recent publication attempt for the
     * CURRENT outstanding range, settled by the wrapper below: 'published'
     * once a push left this process, 'failed' with its error otherwise.
     * #469's report-truth rule consumes it — the engine, not a loop-side
     * guess, is the only witness of what was actually pushed. Per-range
     * (publication-range truth, PRRT_kwDOUY73E86w9hwK): a verified commit
     * remembered after a settled push opens a NEW outstanding range and
     * resets a 'published' witness, so a later range's pre-push failure is
     * recorded instead of being suppressed by the earlier range's success.
     * Irreversible within one attempt: once 'published', a post-push failure
     * of that same attempt never downgrades it — the commit is out
     * regardless of what the post-push bookkeeping threw.
     */
    let exitPublication: { state: 'published' } | { state: 'failed'; error: string } | undefined;
    /**
     * Publication-range truth (PRRT_kwDOUY73E86w9hwK): withhold rows settle
     * PER RANGE, at the moment that range's truth is decided — never all at
     * once at exit. A successful push settles every not-yet-settled row
     * immediately (at the witness below); finish() settles only the rows
     * still unsettled, by the most recent attempt. Indices are stable:
     * report.reasons is append-only and settled rows are replaced in place.
     */
    const settledWithholdRows = new Set<number>();
    const settleWithholdRows = (tail: string) => {
      for (const [index, row] of report.reasons.entries()) {
        if (!row.includes('publish-withheld-mixed-worktree')) continue;
        // A settled row keeps the shared label, so re-match it here and skip.
        if (settledWithholdRows.has(index)) continue;
        // Keep only the shared item prefix ("item …: " + the label); the
        // loop-side clauses after it describe the pre-publication state and
        // are REPLACED by the settled tail, never appended to.
        const label = 'publish-withheld-mixed-worktree';
        const at = row.indexOf(label);
        report.reasons[index] = `${row.slice(0, at + label.length)}${tail}`;
        settledWithholdRows.add(index);
      }
    };
    /**
     * #490: the exact findings array each dispatch started from, mapped to
     * the number of fixes already recorded then. The local loop's report rows
     * are that pre-dispatch snapshot until a re-review succeeds, so a run that
     * stops after fixing (budget, blocked re-review, round cap) would leave
     * fixed rows reading 'open'. finish() overlays only fixes recorded AFTER
     * the stamp, and only onto a stamped array: a successful re-review
     * assigns a new array, so its rows stay authoritative (a reopened defect
     * stays open). The stamp also carries the blocking severities the
     * dispatch ran under, so finish() can re-derive openBlocking from the
     * overlaid rows under the same policy.
     */
    const rowsDispatchedAt = new WeakMap<
      Finding[],
      { fixes: number; severities: readonly string[] }
    >();
    const finish = async (
      status: 'ok' | 'failed' | 'needs-human',
      reason = '',
      structuredStop?: 'round-cap' | 'rereview-blocked' | 'budget',
    ): Promise<ReviewAddressResult> => {
      // M7-address: every terminal exit — success, failure, needs-human,
      // budget exhaustion, cancellation and a thrown fault included — retains
      // the settled usage summary, so spend already paid is never lost to the
      // exit route. Stamped before persistence, so the written artifact
      // matches the returned envelope. The sole report-shape addition is the
      // optional usageSummary field (existing KnownUsageSummary shape); no
      // other wire contract changes.
      report.usageSummary = usageLedger.snapshot();
      if (parent?.aborted) {
        // Cancellation is an exit too (ADR-0008 T23): print this run's
        // counts before the cancelled result returns, and surface the
        // observation state — the lease's cancelled result carries this
        // same report object, so an emission failure must not vanish from
        // the cancelled envelope. The writer's close stays with the normal
        // exit: a pr flow's tracked links may still append during unwind.
        await appendMeasurementSummary();
        const observedSurface = observationSurface();
        if (observedSurface !== undefined) report.observation = observedSurface;
        delete report.stop;
        if (!report.reasons.includes('parent cancelled')) report.reasons.push('parent cancelled');
        if (!addressLease) return { status: 'needs-human', reason: 'parent cancelled', report };
        if (worker) report.escalation = worker.escalation();
        return addressCancelledResult(addressLease);
      }
      const incomplete = addressLease?.incompleteReason?.();
      if (incomplete) {
        if (!report.reasons.includes(incomplete)) report.reasons.push(incomplete);
        // Incomplete ownership cannot erase an already observed gate/budget
        // refusal. It changes a successful surface to needs-human only.
        if (status === 'ok') {
          status = 'needs-human';
          reason = incomplete;
        }
      }
      if (reason && !report.reasons.includes(reason)) report.reasons.push(reason);
      let publicationFailed = false;
      if (publishOnExit && !parent?.aborted) {
        try {
          await publishOnExit();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A post-push failure (the inner throws after the witness is set)
          // must not rewrite the truth: 'published' stays published, so the
          // withhold rows below never claim a pushed commit stays local.
          if (exitPublication?.state !== 'published')
            exitPublication = { state: 'failed', error: message };
          status = 'needs-human';
          reason = `verified publication failed: ${message}`;
          report.reasons.push(reason);
          // The outcome is now the publication failure, not the round cap: a
          // composition must not publish a draft over it.
          structuredStop = undefined;
          publicationFailed = true;
        }
      }
      const stopped = status === 'ok' ? cleanStop?.() : undefined;
      if (stopped) {
        status = 'needs-human';
        reason = stopped;
        report.reasons.push(stopped);
      }
      // The budget marker: a needs-human exit after the budget ran out —
      // never over a cancelled parent or a failed exit publication.
      // Preserve #513's clearing before considering the budget marker:
      // a budget stop must never masquerade as a blocked re-review.
      if (structuredStop === 'rereview-blocked' && (parent?.aborted || cleanStop?.() !== undefined))
        structuredStop = undefined;
      const reviewBudgetBlocked = structuredStop === 'budget';
      let marker: ReviewAddressReport['stop'] = reviewBudgetBlocked ? undefined : structuredStop;
      if (
        marker === undefined &&
        status === 'needs-human' &&
        !publicationFailed &&
        !bookkeepingTampered &&
        !parent?.aborted
      ) {
        // Only an engine-attributed budget block may observe a new stop here.
        // Safety/admission errors and arbitrary throws never gain eligibility.
        // Consume the late call's return like every other stop() call site: a
        // surfaced reason is recorded in report.reasons, never silently
        // dropped. Only the budget branch of stop() sets budgetSpent, and the
        // gate above already cleared cancellation and tampering in this same
        // synchronous slice, so the marker below can only ride the budget
        // exhaustion itself.
        if (reviewBudgetBlocked) {
          const lateStop = cleanStop?.();
          if (lateStop) report.reasons.push(lateStop);
        }
        if (budgetSpent) marker = 'budget';
      }
      // The structured round-cap marker rides the report envelope — the
      // kernel-sanctioned extension the CLI strips before the strict
      // OpResultSchema parse. It must be assigned BEFORE the report is
      // persisted below so the written artifact agrees with the returned
      // envelope (and the publication-failure clearing above, which erases
      // the marker, is included in both).
      if (marker !== undefined) report.stop = marker;
      // #469 + publication-range truth: settle the mixed-worktree withhold
      // rows with the engine's own publication truth. The loop wrote them
      // BEFORE the exit publication ran ("the loop pushed nothing" and
      // caller-owned publication); only the engine knows what its exit
      // push actually did. A successful push already settled its range's
      // rows AT the push; only rows of the CURRENT outstanding range reach
      // here, and they take the most recent actual attempt's truth. Each
      // row is amended IN PLACE (a separate appended reason cannot be tied
      // to its item and would leave the stale claim standing):
      //   - a settled push → "exit-published": the exact verified range is
      //     out; only the reply/resolve stay withheld (S6 attempt D's
      //     8f78ca91 read "not published" while remote head already had
      //     it). Normally a no-op here — the push settles its rows at the
      //     witness itself — but it stands as the truthful branch for the
      //     most-recent-attempt rule;
      //   - a failed exit publication → the row names the failure and that
      //     the commit stays local (the outcome reason carries it too);
      //   - a run with no push → "publication is off": the commit truly is
      //     unpublished (the one state where the old text was right);
      //   - a --push run whose exit publication never ran (finish's guard
      //     skips publishOnExit on a parent cancel) → "no engine publication
      //     ran": the dead run can never publish, so the verified commit
      //     stays local.
      if (exitPublication?.state === 'published') {
        settleWithholdRows(
          "; exit-published — the engine's exit publication pushed the exact verified range; only this item's reply and resolve remain withheld",
        );
      } else if (exitPublication?.state === 'failed') {
        settleWithholdRows(
          `; exit publication failed (${exitPublication.error}) — the verified commit stays local`,
        );
      } else if (input.push !== true) {
        settleWithholdRows(
          '; publication is off for this run (no --push) — the verified commit stays unpublished in the worktree',
        );
      } else {
        // --push was requested, yet no exit publication ever ran: finish's
        // guard above skips publishOnExit when the parent cancelled (and the
        // publication's own early-returns never witness a push), so this dead
        // run can never publish. The loop's caller-neutral publication tail
        // would otherwise stand — replace it with
        // the engine's terminal truth: the row's own premise is that the loop
        // pushed nothing, so with no engine push either, the verified commit
        // stays local.
        settleWithholdRows(
          '; no engine publication ran for this run — the verified commit stays local',
        );
      }
      // #490: rows still holding a dispatched snapshot take the outcome each
      // later fix recorded for them, as the producer recorded it (status,
      // reason, evidence). A fix whose disposition write failed already reads
      // 'open', so it leaves its row open. No publication claim is added here.
      const dispatchedAt = rowsDispatchedAt.get(report.findings);
      if (dispatchedAt !== undefined) {
        const later = report.fixes.slice(dispatchedAt.fixes);
        report.findings = report.findings.map((finding) => {
          const outcome = later.findLast((fix) => fix.finding.id === finding.id)?.finding;
          if (outcome === undefined || outcome.status === 'open') return finding;
          const { reason, evidence } = outcome;
          const { reason: _reason, evidence: _evidence, ...row } = finding;
          return {
            ...row,
            status: outcome.status,
            ...(reason === undefined ? {} : { reason }),
            ...(evidence === undefined ? {} : { evidence }),
          };
        });
        // The same rows, so the same blockers: openBlocking was taken from the
        // pre-dispatch snapshot, and would still list a finding whose fix
        // outcome (persisted, or its row would still read 'open') is fixed or
        // rejected. Deferred and still-open rows stay blocking.
        report.openBlocking = openBlocking({ findings: report.findings }, dispatchedAt.severities);
      }
      // Jobs cancelled by the enclosing runner still retain independently
      // recorded branch pointers, even when their result/disposition is absent.
      report.findings = report.findings.map((finding) => {
        const failed = report.failed.findLast((row) => row.finding === finding.id);
        return failed && (finding.status === 'open' || finding.status === 'deferred')
          ? { ...finding, evidence: JSON.stringify(failed) }
          : finding;
      });
      report.wallMs = Date.now() - start;
      report.fixesPerRun = new Set(
        report.fixes.flatMap((fix) => (fix.commit ? [fix.commit] : [])),
      ).size;
      if (worker) report.escalation = worker.escalation();
      const preconditions = worker?.preconditions?.();
      if (preconditions?.length) report.preconditions = [...preconditions];
      // ADR-0008 T31: drain every link a settled run recorded, THEN close the
      // stream BEFORE persisting the report, so the persisted artifact never
      // disagrees with the stream's final state (each tracked link is already
      // caught, so this await never rejects).
      await Promise.all([...pendingLinks]);
      // ADR-0008 T14: settle every fixer invocation still in flight BEFORE the
      // attempt failures are read and the stream closes. runPlan can return
      // while an op body is still running (the ladder's kill rung DETACHES an
      // invocation that ignored the abort), and that invocation appends its
      // attempt event last: racing close() would push the refusal after the
      // fold below, silently losing it. The bounded drain either lands those
      // events first, or records the outstanding invocation as evidence.
      await worker?.settleObservations?.();
      // ADR-0008 T14: attempt observations the worker could not hand to the
      // writer (a strict-schema refusal, or an append the writer refused
      // without marking its own `failure`) are EVIDENCE only: they make the
      // surface indeterminate and never change the run verdict.
      for (const failure of worker?.observationFailures?.() ?? []) observationFailure(failure);
      // ADR-0008 T23: the run's counts print on every exit — as the stream's
      // terminal event, after every link and attempt observation landed.
      await appendMeasurementSummary();
      await closeObservation();
      // A refusal recorded while the writer drained is evidence too: fold once
      // more after close so no attempt-observation failure is silently lost.
      for (const failure of worker?.observationFailures?.() ?? []) observationFailure(failure);
      const observedSurface = observationSurface();
      if (observedSurface !== undefined) report.observation = observedSurface;
      // ADR-0008 T31: sanitize the WHOLE persisted artifact at the same
      // boundary T30 uses (runFix), not just the observation surface — every
      // string that reaches disk passes the same redaction/cap discipline.
      const plannedReportPath = report.reportPath;
      Object.assign(report, sanitizeObservation(report));
      // The write target is engine-owned identity, not observational text:
      // sanitizing it would strip a credential-looking prefix from a journal
      // path whose parent directory holds an `@` and resolve the write against
      // the process cwd instead.
      report.reportPath = plannedReportPath;
      try {
        if (parent?.aborted) return finish('needs-human', 'parent cancelled');
        if (addressLease) await addressLease.assertOwned();
        await mkdir(journalDir, { recursive: true });
        if (parent?.aborted) return finish('needs-human', 'parent cancelled');
        if (addressLease) await addressLease.assertOwned();
        const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
        await writeFile(report.reportPath, reportBytes, { mode: 0o600 });
        if (addressLease) await addressOrdinaryReport(addressLease, report.reportPath, reportBytes);
      } catch (error) {
        return {
          status: 'failed',
          error: `review.address report write failed at ${report.reportPath}: ${String(error)}`,
          report,
        };
      }
      if (parent?.aborted) return finish('needs-human', 'parent cancelled');
      if (status === 'ok') return { status, value: report };
      const detail = `${reason || report.reasons.join('; ') || 'open blocking findings or incomplete review'}; report: ${report.reportPath}`;
      return status === 'failed'
        ? { status, error: detail, report }
        : { status, reason: detail, report };
    };
    try {
      if (parent?.aborted) return await finish('needs-human', 'parent cancelled');
      if (input.source !== 'local' && !/^pr:[1-9]\d*$/.test(input.source))
        return await finish('failed', 'source must be local or pr:<positive number>');
      // ADR-0008 T31 / P3-6: provenance hashes the cq.json FILE TEXT exactly
      // as T30's captureProvenance does, so both compositions record the same
      // hash for the same file. An injected config is still the policy
      // authority; the file, when present, stays the provenance content.
      const readCqJsonText = () => readFile(resolve(input.repoRoot, 'cq.json'), 'utf8');
      const configText =
        deps.config === undefined
          ? await readCqJsonText()
          : await readCqJsonText().catch(() => undefined);
      let config = deps.config;
      if (!config) {
        const parsed = parseCqConfig(configText!, input.repoRoot);
        if (!parsed.ok) return await finish('needs-human', parsed.reason);
        config = parsed.config;
      }
      const policy = resolveCqConfigDefaults(config, {
        packageName: 'repository',
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        review: {
          ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
          ...(input.concurrency === undefined ? {} : { addressConcurrency: input.concurrency }),
        },
      });
      const budget = requireAgenticTokenBudget(policy);
      if (budget) return await finish('needs-human', budget.reason);
      if (!policy.roles.worker || !policy.roles.reviewer)
        return await finish('needs-human', 'cq.json roles.worker and roles.reviewer are required');
      // Wall is a runaway guard, not a calibrated allocation between fixing and review.
      const reviewWallMs = DEFAULT_REVIEW_WALL_MS;
      const cap = Math.min(config.budgets?.run?.wallMs ?? reviewWallMs, input.wallMs ?? Infinity);
      const remainingTokens = () =>
        policy.budgets.run.maxTokens! -
        report.usage.input -
        report.usage.output -
        report.usage.cacheRead -
        report.usage.cacheWrite -
        (report.usage.reasoning ?? 0);
      const remainingWallMs = () => cap - (Date.now() - start);
      // A fixed share keeps final verification inside the same authoritative wall.
      const reviewReserveMs = Math.ceil(cap / 4);
      const remainingFixWallMs = () => remainingWallMs() - reviewReserveMs;
      const fixWallStop = 'fix dispatch stopped to preserve final re-review wall';
      const stop = () => {
        if (parent?.aborted) return 'parent cancelled';
        if (bookkeepingTampered) return 'engine bookkeeping changed; worker tree is dirty';
        if (remainingTokens() <= 0 || remainingWallMs() <= 0) {
          budgetSpent = true;
          return 'token or wall budget exhausted';
        }
        return worker?.preconditionFailure?.();
      };
      cleanStop = stop;
      const account = (result: WorkerResult, governed = true) => {
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
          report.usage[key] += result.usage[key];
        if (result.costUSD !== undefined) report.costUSD = (report.costUSD ?? 0) + result.costUSD;
        if (result.usage.reasoning !== undefined)
          report.usage.reasoning = (report.usage.reasoning ?? 0) + result.usage.reasoning;
        // Retain the dispatch's settled spend exactly once (M7-address): a
        // measured provider report keeps its usage, anything else — including
        // an unmeasured placeholder and a legacy result without provenance —
        // is an explicit unknown. The summary is snapshotted at exit, so a
        // thrown fault after settlement never loses spend already paid.
        usageLedger.record(
          `dispatch-${++dispatchSequence}`,
          normalizeUsageObservation({
            ...(result.usageProvenance === 'measured' ? { usage: result.usage } : {}),
            ...(result.costUSD === undefined ? {} : { costUSD: result.costUSD }),
          }),
        );
        if (governed) {
          const context = currentJobContext();
          const measurement = {
            usage: result.usage,
            ...(result.costUSD === undefined ? {} : { costUSD: result.costUSD }),
          };
          context?.reportResult(measurement);
          if (enclosingContext && enclosingContext !== context)
            enclosingContext.reportResult(measurement);
        }
      };
      const rawDrivers = deps.drivers ?? createDriverFactory();
      const rawGit =
        deps.git ??
        makeGhRunner({ bin: 'git', cwd: input.repoRoot, timeoutMs: Math.min(cap, 60_000) });
      // ADR-0008 T31: resolve the header metadata once, then open the
      // composition stream — ONE stream for all rounds and plans. The
      // engine-captured base witness must agree with witnesses.base; when no
      // base can be witnessed, the surface records null/unavailable and the
      // run proceeds — an observation PRE-FLIGHT failure never fails the run
      // and never records an inferred value.
      //
      // local: the composition's own HEAD, read from the repository it runs.
      // pr:N: the caller-asserted PR head is this composition's checkout base;
      // it is recorded ONLY when git confirms that exact commit exists. The
      // coordination checkout's HEAD is NEVER read as a PR base — it is a
      // different repository state and the run's checkout does not start there.
      const resolveBaseWitness = async (): Promise<string | null> => {
        const candidate = input.source === 'local' ? 'HEAD' : input.expectedHead;
        if (candidate === undefined) return null;
        // A PR base is the caller-asserted head OID, never an arbitrary rev:
        // anything that is not a commit id is unavailable, not a probe target.
        if (input.source !== 'local' && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(candidate))
          return null;
        try {
          const probe = await rawGit(
            input.source === 'local'
              ? ['-C', input.repoRoot, 'rev-parse', candidate]
              : ['-C', input.repoRoot, 'rev-parse', '--verify', `${candidate}^{commit}`],
          );
          const head = probe.stdout.trim();
          return probe.code === 0 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head) ? head : null;
        } catch {
          return null;
        }
      };
      const baseSha = await resolveBaseWitness();
      const correlationRecord = {
        ...resolveCorrelation({ branch: input.source }),
        // ADR-0008 T31: an injected writer owns the identity it was opened
        // with; the correlation record joins its streams on that same workId.
        ...(injectedWriter === undefined ? {} : { workId: injectedWriter.workId }),
      };
      // ADR-0008 T31: a provenance rejection is an observation failure, never
      // a run failure — the surface records the sanitized reason and the run
      // proceeds with no header.
      let provenanceFailure: string | undefined;
      const sanitizedProvenance =
        baseSha === null
          ? null
          : await captureAddressProvenance(
              input.source,
              new Date(start).toISOString(),
              baseSha,
              configText ?? JSON.stringify(config),
              async (args) => {
                const probe = await rawGit(['-C', input.repoRoot, ...args]);
                return probe.stdout.trim();
              },
            ).then(
              (captured) => captured.provenance,
              (error: unknown) => {
                provenanceFailure = sanitizeObservation(
                  `observation: provenance unavailable: ${String(error)}`,
                );
                return null;
              },
            );
      // ADR-0008 T31: DECLARE the observation surface here, but open nothing
      // yet. Opening the writer creates the journal directory (mkdir -p) and
      // the composition header append is journal IO; a run refused before it
      // holds ownership (admission/active-guard refusal) or one that fails in
      // the lifetime catch owns no journal, so it must perform none of that.
      // Until the owned path opens the stream the surface reports honestly:
      // no stream, indeterminate, with the reason.
      const surface: ReviewAddressObservation & {
        writer?: ObservationWriter;
        closeWriter?: ObservationWriter;
        header?: CompositionStartedJournalEvent;
      } = {
        persistence: 'unavailable',
        status: 'indeterminate',
        compositionRunId,
        workId: correlationRecord.workId,
        baseSha,
        failure:
          provenanceFailure ??
          (baseSha === null
            ? 'observation: base witness unavailable'
            : 'observation: ownership not held'),
        kernelRuns: [],
        ...(sanitizedProvenance === null
          ? {}
          : {
              header: {
                type: 'composition-started' as const,
                runId: compositionRunId,
                at: new Date(start).toISOString(),
                unitId: null,
                jobId: null,
                taskId: null,
                attempt: null,
                payload: {
                  journalVersion: 3 as const,
                  provenance: sanitizedProvenance,
                  correlation: correlationRecord,
                },
              },
            }),
      };
      observation = surface;
      // Called ONLY from the owned path, after the ownership entry created the
      // journal directory. A null base has no schema-valid header, so no
      // stream opens (an injected writer is retained for CLOSE only: no link
      // append, no worker handoff — nothing may precede a header); otherwise
      // the writer opens and the header is its first event. An OPEN failure
      // is an observation failure, never a verdict: it is recorded on the
      // surface, which stays indeterminate, and the run continues with no
      // writer. P2-1 is preserved: a fresh journal dir (ENOENT at
      // pre-flight) is usable because the ownership entry creates it first.
      const openCompositionObservation = async () => {
        if (baseSha === null) {
          if (injectedWriter !== undefined) surface.closeWriter = injectedWriter;
          return;
        }
        // Ownership is held from here on, so the pre-ownership reason is
        // stale: the open (or header append) below records its own reason.
        surface.failure = null;
        let writer: ObservationWriter;
        try {
          writer =
            injectedWriter ??
            (await openObservationWriter({
              ...(input.journalDir === undefined ? {} : { journalDir }),
              workId: correlationRecord.workId,
              compositionRunId,
            }));
        } catch (error) {
          // EACCES/ENOSPC/EEXIST from the exclusive create is observed, not
          // owned: the surface stays indeterminate with the sanitized reason
          // and the run continues WITHOUT a writer. This must never reach the
          // owned catch, which would turn the run into needs-human/failed.
          observationFailure(error);
          return;
        }
        // Close is a lifecycle duty independent of the header landing.
        surface.closeWriter = writer;
        surface.persistence = writer.persistence;
        surface.status = writer.persistence;
        if (sanitizedProvenance === null) return;
        try {
          await writer.append({
            type: 'composition-started',
            runId: compositionRunId,
            at: new Date().toISOString(),
            unitId: null,
            jobId: null,
            taskId: null,
            attempt: null,
            payload: {
              journalVersion: 3,
              provenance: sanitizedProvenance,
              correlation: correlationRecord,
            },
          });
        } catch (error) {
          observationFailure(error);
          return;
        }
        // Only a stream whose header ACTUALLY landed may receive link appends
        // or be handed to the worker: an event before the header would make
        // the on-disk stream unreadable, and a worker append would land one.
        surface.writer = writer;
      };
      // ADR-0008: link every RETURNED kernel run explicitly, after the
      // runPlan result — including partial results when present. Never a
      // guessed link: unreturned kernel runs stay unlinked/unknown. The
      // descriptor list feeds the T29 foldObservations join surface.
      const linkKernelRun = async (
        run: RunReport,
        planId: string,
        round: number,
        runJournalDir: string,
      ) => {
        // A descriptor read failure is an observation failure, never a
        // round-aborting throw: the run's own verdict stands, and the link is
        // recorded without the descriptor list (P2-4).
        let descriptors: KernelRunDescriptor[] = [];
        if (input.journalDir !== undefined)
          try {
            descriptors = await readKernelRunDescriptors(runJournalDir, [run.runId]);
          } catch (error) {
            observationFailure(error);
          }
        observation?.kernelRuns.push(...descriptors);
        const event: KernelRunLinkedJournalEvent = {
          type: 'kernel-run-linked',
          runId: compositionRunId,
          at: new Date().toISOString(),
          unitId: null,
          jobId: null,
          taskId: null,
          attempt: null,
          payload: { kernelRunId: run.runId, planId, round },
        };
        try {
          await observation?.writer?.append(event);
        } catch (error) {
          observationFailure(error);
        }
      };
      const drivers: DriverFactory = {
        resolve(request) {
          const resolved = rawDrivers.resolve(request);
          return {
            ...resolved,
            driver: {
              ...resolved.driver,
              run: (input, options) => {
                if (!addressLease) throw new Error('address ownership: driver before acquisition');
                return addressLease.track(() =>
                  resolved.driver
                    .run(input, {
                      ...options,
                      signal: options?.signal ? AbortSignal.any([parent, options.signal]) : parent,
                    })
                    .catch((error) => {
                      // A rejected dispatch settles as an explicit unknown,
                      // never vanishes: the spend may already have been paid
                      // upstream (M7-address).
                      usageLedger.record(`dispatch-${++dispatchSequence}`, {});
                      throw error;
                    }),
                );
              },
            },
          };
        },
      };
      // Review source calls share the same landed usage meter as fix/feedback/closure calls.
      const reviewDrivers: DriverFactory = {
        resolve(request) {
          const resolved = drivers.resolve(request);
          return {
            ...resolved,
            driver: {
              ...resolved.driver,
              run: async (invocation, options) => {
                const stopped = stop();
                if (stopped) throw new Error(stopped);
                // Session-log correlation (M5b3): forward the governed job's
                // minted work identity onto the review-leg invocation. The
                // KERNEL reads the job context; the shared driver helper
                // stays pure over the correlation value (ADR-0002
                // one-directional rule). Absent outside a governed dispatch.
                const result = await resolved.driver.run(
                  {
                    ...invocation,
                    ...correlationInvocation(currentJobContext()?.info?.correlation),
                  },
                  options,
                );
                account(result, false);
                return result;
              },
            },
          };
        },
      };
      // Bound inside the ownership lock below (it needs the bookkeeping FIFO);
      // reviews only fire after that lock is held, so the binding is always set.
      let noteEvidenceImportedImpl:
        | ((evidence: { receiptId: string; path: string }) => Promise<void>)
        | undefined;
      let noteLedgerWriteImpl: ((branch: string, repoRoot: string) => Promise<void>) | undefined;
      const rawReviewImplementation =
        deps.review ??
        makeReviewRun({
          drivers: reviewDrivers,
          ...(deps.managedSubmit ? { managedSubmit: deps.managedSubmit } : {}),
          ...(deps.queueClient ? { queueClient: deps.queueClient } : {}),
          ...(parent ? { parentSignal: parent } : {}),
          writeFindingsRecord: async (path, content) => {
            await writeFile(path, content, { flag: 'wx', mode: 0o600 });
            await noteBookkeeping(path);
          },
          onEvidenceImported: async (evidence) => {
            if (!noteEvidenceImportedImpl) throw new Error('queue evidence ownership unavailable');
            await noteEvidenceImportedImpl(evidence);
          },
          noteLedgerWrite: async (branch, repoRoot) => {
            await noteLedgerWriteImpl?.(branch, repoRoot);
          },
        });
      const reviewImplementation: typeof rawReviewImplementation = (input) => {
        if (!addressLease) throw new Error('address ownership: review before acquisition');
        return addressLease.track(() => {
          if (deps.review) noteAddressOpaqueInvocation(addressLease!);
          return rawReviewImplementation(input);
        });
      };
      // The ownership helper alone uses rawGit for read-only bootstrap.
      // Every operational command, including injected runners, needs an owner.
      const git: GhFn = async (args) => {
        if (!addressLease) throw new Error('address ownership: command before acquisition');
        parent.throwIfAborted();
        await addressLease.assertOwned();
        return rawGit(args);
      };
      const gh =
        deps.gh ??
        makeGhRunner({
          cwd: input.repoRoot,
          unsetEnv: ['GH_REPO'],
          timeoutMs: Math.min(cap, 60_000),
        });
      // Ownership spans worker edits, restoration, reports and publication.
      // PR slots coordinate resolution; the actual checkout slot excludes edits
      // across entrypoints and canonical aliases.
      const withOwnership = async (
        action: (lease: AddressLease) => Promise<ReviewAddressResult>,
      ) => {
        let entered = false;
        try {
          return await withAddressOwnership(
            {
              repoRoot: input.repoRoot,
              git: rawGit,
              source: input.source,
              ...(deps.coordinationRoot ? { coordinationRoot: deps.coordinationRoot } : {}),
              legacySources: [resolve(journalDir, 'worktrees.json')],
              ...(input.expectedHead ? { expectedHead: input.expectedHead } : {}),
              production: Object.keys(deps).length === 0,
              controller: ownershipAbort,
              signal: parent,
            },
            (lease) => {
              entered = true;
              return action(lease);
            },
          );
        } catch (cause) {
          let detail = 'unprintable ownership error';
          try {
            detail = String(cause instanceof Error ? cause.message : cause);
          } catch {
            // Error formatting cannot reenter effectful finalization.
          }
          // A run that never entered the owned action holds no ownership and
          // performed no journal IO. Report the observation surface honestly
          // (no stream, indeterminate, with its reason) instead of omitting
          // it, so a future change cannot start writing before ownership
          // without a visible report-shape change.
          const unheld = entered ? undefined : observationSurface();
          const reportOfRefusal = <T extends object>(observed: T) =>
            unheld === undefined || 'observation' in observed
              ? observed
              : { ...observed, observation: unheld };
          if (
            (!entered && isAddressOwnershipAdmissionRefusal(cause)) ||
            isAddressCheckoutIncomplete(cause)
          ) {
            const { stop: _stop, ...observed } = report;
            return {
              status: 'needs-human' as const,
              reason: detail,
              report: {
                ...reportOfRefusal(observed),
                reasons: observed.reasons.includes(detail)
                  ? [...observed.reasons]
                  : [...observed.reasons, detail],
              },
            };
          }
          const error = `address lifetime finalization failed; durability unconfirmed: ${detail}`;
          const { stop: _stop, ...observed } = report;
          return {
            status: 'failed' as const,
            error,
            report: {
              ...reportOfRefusal(observed),
              reasons: observed.reasons.includes(error)
                ? [...observed.reasons]
                : [...observed.reasons, error],
            },
          };
        }
      };
      const runOwned = () =>
        withOwnership(async (lease) => {
          addressLease = lease;

          await bindAddressTerminalReport(lease, report);
          if (input.source === 'local')
            await addressTerminalBookkeeping(lease, input.repoRoot, bookkeeping);
          try {
            await lease.assertOwned();
            await mkdir(journalDir, { recursive: true });
            // ADR-0008 T31: ownership is held and the journal directory exists
            // (created above, or already present) — only NOW may the
            // observation writer open and the header append.
            await openCompositionObservation();
            const bookkeepingKey = async (root: string, path: string) =>
              resolve(await realpath(root), path);
            const untrackedAllowed = async (root: string, path: string) => {
              const key = await bookkeepingKey(root, path);
              const expected = bookkeeping.get(key);
              if (!expected) return false;
              const stat = await lstat(key);
              const unchanged =
                stat.isFile() &&
                stat.nlink === 1 &&
                (await realpath(key)) === key &&
                createHash('sha256')
                  .update(await readFile(key))
                  .digest('hex') === expected;
              if (!unchanged) bookkeepingTampered = true;
              return unchanged;
            };
            const gitText = async (root: string, args: string[]) => {
              const result = await git(['-C', root, ...args]);
              if (result.code !== 0)
                throw new Error(`git ${args[0]} failed: ${result.stderr.slice(0, 500)}`);
              return result.stdout.trim();
            };
            const branchName = async (root: string) => {
              const ref = await gitText(root, ['symbolic-ref', '--quiet', 'HEAD']);
              if (!ref.startsWith('refs/heads/') || ref.length === 'refs/heads/'.length)
                throw new Error('worker HEAD does not name a local branch ref');
              return ref.slice('refs/heads/'.length);
            };
            const admitHistory = async (root: string, branch: string) => {
              // PR history must have an exact engine receipt; filenames/schema alone confer no ownership.
              if (persistedBookkeeping) return;
              const folder = resolve(root, '.cq', 'review', reviewBranchKey(branch));
              let names: string[];
              try {
                names = await readdir(folder);
              } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
                throw error;
              }
              for (const name of names.filter((name) => /^\d+\.json$/.test(name))) {
                const path = join(folder, name);
                if (bookkeeping.has(await bookkeepingKey(root, relative(root, path)))) continue;
                let raw: unknown;
                try {
                  raw = JSON.parse(await readFile(path, 'utf8'));
                } catch (error) {
                  if (error instanceof SyntaxError) continue;
                  throw error;
                }
                const record = FindingsRecordSchema.safeParse(raw);
                // History is bookkeeping only, never current clean proof.
                if (
                  !record.success ||
                  record.data.branch !== branch ||
                  !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.data.head)
                )
                  continue;
                const ancestor = await git([
                  '-C',
                  root,
                  'merge-base',
                  '--is-ancestor',
                  record.data.head,
                  'HEAD',
                ]);
                if (ancestor.code === 0) await noteBookkeeping(path);
              }
            };
            const assertBookkeeping = async (root: string) => {
              try {
                if (bookkeepingTampered) throw new Error('prior bookkeeping mismatch');
                for (const path of bookkeeping.keys())
                  if (!(await untrackedAllowed(root, path)))
                    throw new Error('bookkeeping mismatch');
              } catch (error) {
                bookkeepingTampered = true;
                throw new Error('engine bookkeeping changed; worker tree is dirty', {
                  cause: error,
                });
              }
            };
            // Parallel PR workers share the ledger. Keep the fingerprint check,
            // engine write and replacement fingerprint in one composition-owned FIFO.
            let bookkeepingWrites: Promise<unknown> = Promise.resolve();
            const withBookkeepingAccess = <T>(
              root: string,
              action: () => Promise<T>,
            ): Promise<T> => {
              const pending = bookkeepingWrites.then(async () => {
                await assertBookkeeping(root);
                try {
                  await persistedBookkeeping?.assertUnchanged();
                } catch (error) {
                  bookkeepingTampered = true;
                  throw error;
                }
                const revision = bookkeepingRevision;
                const outcome = await action().then(
                  (value) => ({ ok: true as const, value }),
                  (error: unknown) => ({ ok: false as const, error }),
                );
                // Import ownership survives a later ack/settlement failure.
                if (persistedBookkeeping && bookkeepingRevision !== revision) {
                  try {
                    await persistedBookkeeping.persist();
                  } catch (error) {
                    bookkeepingTampered = true;
                    throw error;
                  }
                }
                if (!outcome.ok) throw outcome.error;
                return outcome.value;
              });
              bookkeepingWrites = pending.catch(() => undefined);
              return pending;
            };
            const reviewOnce = (request: ReviewRunInput) =>
              withBookkeepingAccess(request.repoRoot, async () => {
                // Review.run legitimately appends to the same ledger. Check ownership
                // before its write, then register only that engine-produced revision.
                const result = await reviewImplementation(request);
                if (!deps.review && result.status === 'ok')
                  await noteBookkeeping(devLedgerPath(request.repoRoot, result.value.branch));
                return result;
              });
            // #509 (owner, 2026-10-27): a re-review blocked on the network/
            // transient class (review.run's structured `blockedTransient`) is
            // retried ONCE within the remaining budgets. If the retry is still
            // blocked on that class, `rereviewStillTransient` lets the exit mark
            // the run for a draft publication when verified fixes exist.
            let rereviewStillTransient = false;
            const review = async (request: ReviewRunInput) => {
              const first = await reviewOnce(request);
              if (
                first.status === 'needs-human' &&
                first.report?.deferredVendorDebt &&
                first.report.blockedBudget !== true &&
                !stop() &&
                (await hasRequiredSources(request.repoRoot, first.report))
              )
                return first;
              if (
                first.status !== 'needs-human' ||
                first.report?.blockedTransient !== true ||
                stop()
              )
                return first;
              report.reasons.push('re-review blocked on a network/transient class; retrying once');
              const second = await reviewOnce({
                ...request,
                maxTokens: Math.max(1, remainingTokens()),
                wallMs: Math.max(1, remainingWallMs()),
              });
              // A budget, cancellation or bookkeeping stop observed after the
              // retry outranks it: never mark a draft over a stopped run.
              rereviewStillTransient =
                second.status === 'needs-human' &&
                second.report?.blockedTransient === true &&
                stop() === undefined;
              return second;
            };
            const rereviewStop = (
              result: ReviewRunResult,
            ): 'rereview-blocked' | 'budget' | undefined =>
              result.status === 'needs-human' && result.report?.blockedBudget === true
                ? 'budget'
                : rereviewStillTransient && report.fixes.some((fix) => fix.commit !== undefined)
                  ? 'rereview-blocked'
                  : undefined;
            // Blocked/failed re-reviews still write engine-owned ledger cycles.
            // reviewImplementation only runs inside review()'s bookkeeping FIFO
            // slot, so this registration must NOT re-enter that queue (it would
            // deadlock); running inline keeps check/settle bracketing in the
            // slot that already owns the mutation.
            noteLedgerWriteImpl = async (branch, repoRoot) => {
              const path = await bookkeepingKey(
                repoRoot,
                relative(repoRoot, devLedgerPath(repoRoot, branch)),
              );
              await noteBookkeeping(path);
            };
            // Already inside the review/context bookkeeping FIFO: never re-enter it.
            const noteQueueEvidence = async (
              root: string,
              evidence: { receiptId: string; path: string },
            ) => {
              const canonicalRoot = await realpath(root);
              if (!/^[0-9a-f]{64}$/.test(evidence.receiptId))
                throw new Error('invalid queue evidence identity');
              const expected = resolve(
                canonicalRoot,
                '.cq/queue-evidence',
                evidence.receiptId + '.json',
              );
              if (evidence.path !== expected || (await realpath(expected)) !== expected)
                throw new Error('queue evidence path mismatch');
              const stat = await lstat(expected);
              if (!stat.isFile() || stat.nlink !== 1)
                throw new Error('queue evidence is not an ordinary exact file');
              const bytes = await readFile(expected);
              const hash = createHash('sha256').update(bytes).digest('hex');
              if (
                hash !== evidence.receiptId ||
                (bookkeeping.has(expected) && bookkeeping.get(expected) !== hash)
              )
                throw new Error('queue evidence changed or digest mismatch');
              parseQueueReceipt(JSON.parse(bytes.toString('utf8')));
              if (!persistedBookkeeping)
                throw new Error('durable queue evidence ownership unavailable');
              bookkeeping.set(expected, hash);
              if (addressLease)
                await addressTerminalBookkeeping(addressLease, input.repoRoot, bookkeeping);
              bookkeepingRevision++;
              // The caller sends ack immediately after this observer returns. Commit
              // ownership inline in the FIFO slot, before that irreversible boundary.
              try {
                await persistedBookkeeping.persist();
              } catch (error) {
                bookkeepingTampered = true;
                throw error;
              }
            };
            const bindWorker = (root: string): AddressWorker => {
              if (worker) return worker;
              const workerDeps: Parameters<typeof makeAddressWorker>[0] = {
                repoRoot: root,
                dependencyRoot:
                  input.dependencyRoot === undefined
                    ? input.repoRoot
                    : resolve(input.repoRoot, input.dependencyRoot),
                preferDependencyRoot: input.dependencyRoot !== undefined,
                journalDir,
                policy,
                git,
                drivers,
                attempts: report.attempts,
                failedAttempts: report.failed,
                prepareBookkeeping: () =>
                  withBookkeepingAccess(root, async () => {
                    try {
                      await persistedBookkeeping?.prepare(root);
                    } catch (error) {
                      bookkeepingTampered = true;
                      throw error;
                    }
                  }),
                isBookkeepingPath: (path) =>
                  withBookkeepingAccess(root, () => untrackedAllowed(root, path)),
                inspectUntracked: (read) =>
                  withBookkeepingAccess(root, async () => {
                    // Snapshot inside the write fence: a Git subprocess must not
                    // retain a ledger's transient atomic-publish path and classify
                    // it after the writer has renamed it away. Never exempt names.
                    const paths = await read();
                    const unknown = [];
                    for (const path of paths)
                      if (!(await untrackedAllowed(root, path))) unknown.push(path);
                    return { paths, unknown };
                  }),
                remainingTokens,
                remainingWallMs: remainingFixWallMs,
                account,
                // ADR-0008 T31: runtime deps only — the writer is NEVER
                // serialized into any dispatch input/plan JSON.
                ...(surface.writer === undefined
                  ? {}
                  : {
                      observationWriter: surface.writer,
                      observationRunId: compositionRunId,
                    }),
                observationUnitId: null,
                ...(parent ? { parentSignal: parent } : {}),
              };
              const implementation = deps.workerFactory
                ? deps.workerFactory(workerDeps)
                : makeAddressWorker({
                    ...workerDeps,
                    terminalBinding: addressTerminalWorkerBinding(lease),
                  });
              worker = {
                fix: (finding, round) =>
                  lease.track(() => {
                    if (deps.workerFactory) noteAddressOpaqueInvocation(lease);
                    return implementation.fix(finding, round);
                  }),
                escalation: () => implementation.escalation(),
                ...(implementation.preconditionFailure
                  ? { preconditionFailure: () => implementation.preconditionFailure!() }
                  : {}),
                ...(implementation.preconditions
                  ? { preconditions: () => implementation.preconditions!() }
                  : {}),
                ...(implementation.observationFailures
                  ? { observationFailures: () => implementation.observationFailures!() }
                  : {}),
                ...(implementation.settleObservations
                  ? { settleObservations: () => implementation.settleObservations!() }
                  : {}),
                ...(implementation.withVerifiedHead
                  ? {
                      withVerifiedHead: <T>(action: (head: string) => Promise<T>) =>
                        lease.track(() => {
                          if (deps.workerFactory) noteAddressOpaqueInvocation(lease);
                          return implementation.withVerifiedHead!(action);
                        }),
                    }
                  : {}),
              };
              return worker;
            };
            const publicationTreeClean = async (root: string) => {
              // A later engine rewrite must not erase an observed ownership violation.
              if (bookkeepingTampered) return false;
              // With no fix jobs, publication must still restore metadata before inspection,
              // inside the same mutation → checkout → bookkeeping order.
              if (persistedBookkeeping && !worker) {
                const bound = bindWorker(root);
                if (bound.withVerifiedHead) await bound.withVerifiedHead(async () => {});
                else await withBookkeepingAccess(root, () => persistedBookkeeping!.prepare(root));
              }
              await withBookkeepingAccess(root, async () =>
                admitHistory(root, await branchName(root)),
              );
              if (await gitText(root, ['diff', '--cached', '--name-only', '-z'])) return false;
              if (await gitText(root, ['diff', '--name-only', '-z'])) return false;
              const untracked = await git([
                '-C',
                root,
                'ls-files',
                '-z',
                '--others',
                '--exclude-standard',
              ]);
              if (untracked.code !== 0) throw new Error('publication untracked paths unavailable');
              for (const path of untracked.stdout.split('\0').filter(Boolean))
                if (!(await untrackedAllowed(root, path))) return false;
              return true;
            };
            const unpublished = new Set<string>();
            let publishBranch: string | undefined;
            let publishRemote = 'origin';
            let publishDestination: PushDestination | undefined;
            let publishedBase: string | undefined;
            let expectedRemoteHead: string | undefined;
            let workerRoot = resolve(input.repoRoot);
            noteEvidenceImportedImpl = (evidence) => noteQueueEvidence(workerRoot, evidence);
            const remember = (fix: AddressFix) => {
              report.fixes.push(fix);
              if (fix.commit) {
                // Publication-range truth: a verified commit arriving after a
                // settled push opens a NEW outstanding range. The previous
                // push's 'published' witness speaks only for its own range —
                // whose withhold rows it already settled at the push — so it
                // must not suppress the record of THIS range's later failure.
                // A 'failed' witness stands: it is the most recent actual
                // attempt for the still-outstanding range.
                if (exitPublication?.state === 'published') exitPublication = undefined;
                unpublished.add(fix.commit);
                report.verifiedHead = fix.commit;
              }
            };
            const publishOnExitInner = async (): Promise<void> => {
              if (!input.push || unpublished.size === 0 || parent?.aborted) return;
              if (!publishedBase || expectedRemoteHead === undefined)
                throw new Error('publication baseline unavailable');
              const verifiedTip = await gitText(workerRoot, ['rev-parse', 'HEAD']);
              const range = (
                await gitText(workerRoot, ['rev-list', `${publishedBase}..${verifiedTip}`])
              )
                .split('\n')
                .filter(Boolean);
              if (
                range.length === 0 ||
                range.some((sha) => !unpublished.has(sha)) ||
                [...unpublished].some((sha) => !range.includes(sha))
              )
                throw new Error('publication contains an unverified commit or changed ancestry');
              await gitText(workerRoot, [
                'merge-base',
                '--is-ancestor',
                publishedBase,
                verifiedTip,
              ]);
              if (!(await publicationTreeClean(workerRoot)))
                throw new Error('worker tree/index is dirty; verified commits retained');
              const branch = publishBranch ?? (await branchName(workerRoot));
              if (parent?.aborted) throw new Error('parent cancelled');
              const pushed = await leasedPush(
                git,
                workerRoot,
                (publishDestination ??= await resolvePushDestination(
                  git,
                  workerRoot,
                  publishRemote,
                )),
                branch,
                expectedRemoteHead,
                verifiedTip,
              );
              if (pushed.code !== 0)
                throw new Error(`publication failed: ${pushed.stderr.slice(0, 500)}`);
              // The engine's own witness: a push actually left the process, so
              // the withhold rows' commit is out (#469). Set ONLY here — an
              // early return (no push run, nothing unpublished) never counts
              // as published.
              exitPublication = { state: 'published' };
              // Publication-range truth: settle the not-yet-settled withhold
              // rows NOW, at the witness, before the post-push rev-parse can
              // throw. Invariant — every row settled here describes a commit
              // this push carried out, without inferring anything from the
              // row's prose: each unsettled row was written for an item whose
              // verified commit entered `unpublished` (remember runs before
              // the loop writes its row) and leaves it only through a
              // successful push — which settles the rows outstanding at that
              // moment — or the loop's own ok-push reset, which only runs on
              // a round that wrote no withhold rows while none were left
              // unsettled; so the rows still unsettled name commits of THIS
              // outstanding range, which the checks above proved identical to
              // the pushed range (and the push sends HEAD, so any earlier
              // verified commit rides along inside it). A later range's
              // failure must never rewrite these rows.
              settleWithholdRows(
                "; exit-published — the engine's exit publication pushed the exact verified range; only this item's reply and resolve remain withheld",
              );
              publishedBase = verifiedTip;
              expectedRemoteHead = verifiedTip;
              unpublished.clear();
            };
            // The engine witnesses its own exit publication so the report can
            // state the truth about what was pushed (#469): the inner sets
            // 'published' only after a real push; a failure before the push is
            // recorded and rethrown for finish()'s outcome rewrite. A failure
            // AFTER the push (e.g. the post-push rev-parse) never downgrades
            // the already-set 'published' witness — the commit is out, so the
            // settled withhold rows must not claim it stays local.
            publishOnExit = async () => {
              try {
                await publishOnExitInner();
              } catch (error) {
                if (exitPublication?.state !== 'published')
                  exitPublication = {
                    state: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                  };
                throw error;
              }
            };
            const dispositions = new Map<string, Finding>();
            let bookkeepingFailed = false;
            let reviewedBase: string | undefined;
            const hasRequiredSources = async (root: string, record: FindingsRecord) => {
              if (stop()) return false;
              const complete = isComplete(record, policy.review.reviewers);
              if (!policy.review.reviewers.includes('coderabbit')) return complete;
              return withBookkeepingAccess(root, async () => {
                if (stop()) return false;
                const request: DeferredVendorContextRequest = {
                  repoRoot: root,
                  target: input.target ?? 'main',
                  base: reviewedBase,
                  record,
                  onEvidenceImported: (evidence) => noteQueueEvidence(root, evidence),
                  remainingMs: remainingWallMs,
                  ...(parent ? { signal: parent } : {}),
                };
                // Correlate durable ledger bytes with the mutation the loader
                // itself requested: never bless bytes the engine did not write
                // (an external append stays unowned and fails closed at the
                // next bookkeeping fingerprint check).
                let requestedLedger: DevLedgerFile | undefined;
                let provisionalLedger: DevLedgerFile | undefined;
                const context = deps.resolveDeferredVendorContext
                  ? await deps.resolveDeferredVendorContext(request)
                  : await resolveDeferredVendorContext(request, {
                      ...(deps.queueClient ? { queueClient: deps.queueClient } : {}),
                      effectsFactory: (effectRoot): DevEffects => {
                        const effects = makeSubprocessDevEffects(effectRoot);
                        return {
                          ...effects,
                          openLedger: (branch) => {
                            const store = effects.openLedger(branch);
                            return {
                              ...store,
                              mutate: (update) =>
                                store
                                  .mutate((latest) => {
                                    const change = update(latest);
                                    provisionalLedger = structuredClone(change.ledger);
                                    return change;
                                  })
                                  .then((result) => {
                                    // Promote only once the store durably
                                    // accepted the requested state.
                                    requestedLedger = provisionalLedger;
                                    return result;
                                  }),
                            };
                          },
                        };
                      },
                    });
                if (!deps.resolveDeferredVendorContext && context) {
                  const after = makeSubprocessDevEffects(root).openLedger(record.branch).load();
                  if (requestedLedger !== undefined && isDeepStrictEqual(requestedLedger, after))
                    await noteBookkeeping(devLedgerPath(root, record.branch));
                }
                if (stop()) return false;
                if (!context) {
                  if (complete) delete report.deferredVendorDebt;
                  // Q17b ordinary path: retained dispositions live in the branch ledger, so
                  // restore them here too (the deferred context is not the only authority).
                  // The restoration is content-bound: a same-id row whose original content
                  // differs never inherits a status or reason, and the raw ledger is never
                  // rewritten. Run under the same bookkeeping access as every ledger read.
                  const ledger = makeSubprocessDevEffects(root).openLedger(record.branch).load();
                  record.findings = record.findings.map((finding) =>
                    restoreDurableDisposition(finding, ledger),
                  );
                  return complete;
                }
                if (
                  !complete &&
                  !hasDeferredReviewSources(
                    record,
                    policy.review.reviewers,
                    context.debt,
                    context.identity,
                  )
                )
                  return false;
                // New receipt findings enter the normal dispatcher. Existing
                // dispositions come from the ledger, never a cached record's
                // status. A newer record cannot silently adjudicate an old ID.
                const retained = new Map(context.findings.map((finding) => [finding.id, finding]));
                record.findings = [
                  ...record.findings.map((finding) => {
                    const current = retained.get(finding.id);
                    // Q17b: only an identical original witness may lend its disposition.
                    // A same-id row with changed content (or a legacy row missing the
                    // metadata) never inherits one — no ID-only authority. Such a row is
                    // reset to OPEN with its cached reason cleared, exactly as the ordinary
                    // path's restoreDurableDisposition does, so a stale fixed/rejected
                    // status can never suppress openBlocking.
                    if (current === undefined) return finding;
                    if (!sameFindingContent(finding, current)) {
                      const { reason: _reason, ...row } = finding;
                      return { ...row, status: 'open' as const };
                    }
                    return {
                      ...finding,
                      status: current.status,
                      ...(current.reason !== undefined ? { reason: current.reason } : {}),
                    };
                  }),
                  ...context.findings.filter(
                    (finding) => !record.findings.some((item) => item.id === finding.id),
                  ),
                ];
                report.deferredVendorDebt = context.debt;
                return true;
              });
            };
            /**
             * Capture the immutable admission witness exactly once: the
             * engine-verified head of the first successful admission. It is never
             * advanced by a verified fix commit and never refreshed by a
             * re-review, and it is deliberately NOT set on a refusal or on an
             * injected-disposition bypass (`admitRecord` returns before admission
             * there), so no caller can fabricate one.
             */
            const noteAdmission = (head: string) => {
              report.admissionHead ??= head;
            };
            /**
             * ADR-0008 baseline seam: the ROUND-1 open-blocker population.
             * It is seeded from the full pre-dispatch item population (the
             * open blocking threads the run is about to work) BEFORE the
             * dispatch loop, so every exit reports the whole round-1
             * population, not just the ids dispatched so far. Every capture
             * only GAINS ids, deduplicated, in first-seen order, and a later
             * round is ignored, so the list is never reassigned or shrunk.
             * An early exit taken before the post-fetch merge saves only the
             * planned population, which can omit threads that were excluded
             * from planning (blocked).
             * Round-1 sources: the pre-dispatch seed, each PR dispatch item
             * before `admitRecord` can refuse (a dispatched item that is then
             * refused stays counted), the full open-thread population merged
             * before the PR re-review (dedup-only; already seeded), the
             * round-1 PR agent re-review's record captured before its
             * same-round dispatch (the merge above saw only the forge-thread
             * population, and the baseline must cover what is dispatched),
             * and the local path's admitted record captured after
             * deferred-source restoration and before its dispatch
             * (restoration can reopen or append blockers, and the baseline
             * must cover what is dispatched).
             * Nothing else writes this field: `openBlocking` is recomputed
             * after fixes and `rounds[].record` is replaced by a re-review,
             * so neither may feed the measurement baseline.
             */
            const noteInitialOpenIds = (round: number, ids: readonly string[]) => {
              if (round !== 1) return;
              report.initialOpenBlocking = [
                ...new Set([...(report.initialOpenBlocking ?? []), ...ids]),
              ];
            };
            const noteInitialOpenBlocking = (
              round: number,
              record: Pick<FindingsRecord, 'findings'>,
            ) => {
              noteInitialOpenIds(
                round,
                openBlocking(record, policy.review.blockingSeverities).map((finding) => finding.id),
              );
            };
            const admitCleanRecord = async (root: string, record: FindingsRecord) => {
              const effects = makeSubprocessDevEffects(root);
              const read = await readWorkState(effects, {
                target: input.target ?? 'main',
                ...(reviewedBase ? { base: reviewedBase } : {}),
              });
              if (!read.ok) throw new Error(read.reason);
              const state = read.state;
              if (record.head !== state.head || record.branch !== state.branch)
                throw new Error('clean findings record does not match current branch/head');
              if (state.staged || state.unstaged || !(await publicationTreeClean(root)))
                throw new Error(
                  'clean findings record cannot prove dirty or untracked worktree content; run review.run again',
                );
              if (record.reviewed?.scope !== 'full' || record.reviewed.base !== reviewedBase)
                throw new Error(
                  'clean findings record lacks matching full reviewed base/scope; run review.run again',
                );
              if (stop()) throw new Error(stop());
              // Final guards passed: this clean record's head is the engine-read
              // head of a comparable, admitted comparison.
              noteAdmission(state.head);
            };
            const admitRecord = async (root: string, record: FindingsRecord) => {
              if (deps.disposition) return;
              return withBookkeepingAccess(root, async () => {
                await persistedBookkeeping?.prepare(root);
                const effects = makeSubprocessDevEffects(root);
                // ADMISSION PIN DECISION: admission pins to the invocation's
                // engine-captured base. Admission guards the head/branch
                // identity of the SAME comparison the invocation reviews; a
                // live-base drift mid-invocation would silently move the
                // admitted cycle's base field. The pin (like an explicit base)
                // is schema-validated hex from this engine's own capture.
                const read = await readWorkState(effects, {
                  target: input.target ?? 'main',
                  ...(input.base
                    ? { base: input.base }
                    : reviewedBase
                      ? { base: reviewedBase }
                      : reviewedBasePinned
                        ? { base: await reviewedBasePinned() }
                        : {}),
                });
                if (!read.ok) throw new Error(read.reason);
                const state = read.state;
                if (record.head !== state.head || record.branch !== state.branch)
                  throw new Error('findings admission head/branch changed');
                await admitHistory(root, state.branch);
                if (stop()) throw new Error(stop());
                await effects.openLedger(state.branch).mutate((ledger) => {
                  const entry: DevCycleRecord = {
                    kind: 'cycle',
                    cycleId: `address-${randomUUID()}`,
                    reviewer: 'review.address:import',
                    scope: 'full',
                    target: input.target ?? 'main',
                    base: state.base,
                    head: state.head,
                    dirtySha256: state.dirtySha256,
                    completion: { kind: 'terminal' },
                    findings: record.findings.map((finding) => {
                      const evidence = legacyEvidenceText(finding);
                      return {
                        id: finding.id,
                        severity: finding.severity,
                        ...(finding.file !== undefined ? { fileName: finding.file } : {}),
                        ...(finding.line !== undefined ? { line: finding.line } : {}),
                        ...(finding.rule !== undefined ? { rule: finding.rule } : {}),
                        ...(evidence === undefined ? {} : { evidence }),
                        ...(finding.evidenceV1 !== undefined
                          ? { evidenceV1: finding.evidenceV1 }
                          : {}),
                        excerpt: finding.text,
                      };
                    }),
                    logPath: report.reportPath,
                    untracked: state.untracked,
                    at: effects.nowIso(),
                  };
                  return {
                    ledger: {
                      version: DEV_LEDGER_VERSION,
                      branch: ledger.branch,
                      records: [...ledger.records, entry],
                    },
                    value: undefined,
                  };
                });
                await noteBookkeeping(
                  await bookkeepingKey(root, relative(root, devLedgerPath(root, state.branch))),
                );
                // The ledger mutation above completed for this engine-verified
                // head: that is the one admission event, so the witness is taken
                // here and nowhere else. Both admissions funnel through this
                // function; the `deps.disposition` bypass above returned before
                // it and must never fabricate a witness.
                noteAdmission(state.head);
              });
            };
            const DEFERRED_REVIEW_TRIGGER =
              'review.address: retained and re-presented at next re-review';
            /**
             * ADR-0008 T19 boundary: `isDeliberateDisposition` admits only a
             * real terminal adjudication. The worker's OPERATIONAL failure
             * path reuses `status: 'deferred'` for an unresolved finding but
             * marks itself with `failure` — that is never a deferral, and it
             * stays out of the disposition record even when a caller injects
             * its own disposition authority (a thrown worker, a timeout or a
             * driver error adjudicates nothing). The converse holds too: a
             * custom worker's deliberate `rejected`/`deferred` is recorded
             * even when it omits the optional evidence array. No injected dep
             * and no evidence shape may widen or narrow this predicate.
             */
            const isDeliberateDisposition = (fix: AddressFix): boolean =>
              fix.finding.status !== 'open' && fix.failure === undefined;
            /**
             * ADR-0008 T19: a new disposition records the worker's observed
             * points as one `path:line` entry each (never a single JSON blob,
             * which a reader would have to re-parse). A fixed disposition has
             * no evidence array; the finding's commit SHA is adapted by the
             * shared dual-read view.
             */
            const dispositionEvidenceFor = (fix: AddressFix): string[] | null =>
              fix.evidence === undefined
                ? findingDispositionView(fix.finding).evidence
                : fix.evidence.map((entry) => `${entry.path}:${entry.line}`);
            /**
             * ADR-0008 T19: one `finding-disposition` per DURABLE terminal
             * adjudication. Only a successful recordDisposition reaches this
             * call, so an infrastructure failure (whose finding stays open)
             * never becomes a deferral. An append failure marks the
             * observation surface indeterminate; it never rewrites the
             * finding, the durable disposition or the verdict.
             */
            const emitFindingDisposition = async (
              finding: Finding,
              observedHead: string,
              evidence: string[] | null,
            ): Promise<void> => {
              if (observation === undefined) return;
              if (finding.status === 'open') return;
              if (finding.reason === undefined || finding.reason.trim() === '') {
                observationFailure(
                  `finding-disposition ${finding.id}: no reason recorded; incomplete disposition withheld`,
                );
                return;
              }
              const at = new Date().toISOString();
              const availability: Record<string, AvailabilityRecord> = {
                '/fingerprint/spanContentHash': {
                  state: 'unavailable',
                  reason:
                    'address dispatch does not extract the pinned span; a null hash cannot prove equality',
                  source: null,
                },
                '/acceptedRisk': {
                  state: 'not-collected',
                  reason: 'the adjudicator recorded no accepted risk (null is unknown, never none)',
                  source: null,
                },
              };
              if (evidence === null)
                availability['/evidence'] = {
                  state: 'not-collected',
                  reason: 'no evidence was recorded; absence is unknown, never an empty proof',
                  source: null,
                };
              if (finding.status !== 'deferred')
                availability['/reviewTrigger'] = {
                  state: 'n-a',
                  reason: 'the disposition is not deferred, so no re-review trigger applies',
                  source: null,
                };
              const event: FindingDispositionJournalEvent = {
                type: 'finding-disposition',
                runId: observation.compositionRunId,
                at,
                unitId: null,
                jobId: null,
                taskId: null,
                attempt: null,
                payload: {
                  // F1 identity from what the review finding proves: the
                  // source is the check, rule/path are recorded values, and
                  // span content is UNAVAILABLE (null cannot match) until the
                  // F1 adapter extracts it. Never a guessed identity.
                  fingerprint: {
                    version: 1,
                    checkId: finding.source,
                    rule: finding.rule ?? null,
                    path: finding.file ?? '',
                    spanContentHash: null,
                  },
                  status: finding.status,
                  reason: finding.reason,
                  owner: 'review.address',
                  evidence: evidence ?? [],
                  reviewTrigger: finding.status === 'deferred' ? DEFERRED_REVIEW_TRIGGER : null,
                  observedHead,
                  observedAt: at,
                  acceptedRisk: null,
                  availability,
                },
              };
              try {
                await observation.writer?.append(sanitizeObservation(event));
              } catch (error) {
                observationFailure(error);
              }
            };
            type DispositionRecorded = 'recorded' | 'withheld' | 'failed';
            const recordDisposition = async (
              root: string,
              fix: AddressFix,
            ): Promise<DispositionRecorded> => {
              const finding = fix.finding;
              try {
                // A disposition exists only for a deliberate terminal
                // adjudication: an open finding is an unfinished attempt and a
                // failure-path `deferred` is an operational failure, never a
                // deferral.
                if (finding.status === 'open' || !isDeliberateDisposition(fix)) return 'withheld';
                // The worker's observed evidence (path:line per point) or, for a
                // fixed disposition, the adapted finding evidence (the commit
                // SHA). One value feeds both the ledger and the journal event.
                const evidence = dispositionEvidenceFor(fix);
                return await withBookkeepingAccess(root, async () => {
                  const recorded = deps.disposition
                    ? await deps.disposition(root, finding)
                    : await makeDevDisposition(makeSubprocessDevEffects(root))({
                        repoRoot: root,
                        findingId: finding.id,
                        action: finding.status as 'fixed' | 'rejected' | 'deferred',
                        why: finding.reason ?? 'engine validated fix',
                        owner: 'review.address',
                        // The worker's own evidence: the commit SHA for a fixed
                        // disposition, `path:line` per observed point for
                        // rejected/deferred. Never manufactured, never dropped;
                        // an absent value records no evidence entries.
                        evidence: evidence ?? [],
                        ...(finding.status === 'deferred'
                          ? {
                              reviewTrigger: DEFERRED_REVIEW_TRIGGER,
                            }
                          : {}),
                      });
                  if (recorded.status !== 'ok') {
                    bookkeepingFailed = true;
                    report.reasons.push(`disposition ${finding.id}: ${issue(recorded)}`);
                    return 'failed';
                  }
                  if (!deps.disposition) {
                    const branch = await branchName(root);
                    await noteBookkeeping(
                      await bookkeepingKey(root, relative(root, devLedgerPath(root, branch))),
                    );
                  }
                  dispositions.set(identity(finding), finding);
                  await emitFindingDisposition(finding, fix.observedHead, evidence);
                  return 'recorded';
                });
              } catch (error) {
                bookkeepingFailed = true;
                report.reasons.push(`disposition ${finding.id}: ${String(error)}`);
                return 'failed';
              }
            };
            const noteRound = (round: number, record: FindingsRecord, run?: RunReport) => {
              let entry = report.rounds.find((entry) => entry.round === round);
              if (!entry) {
                entry = { round, record, runs: [] };
                report.rounds.push(entry);
              }
              if (run) entry.runs.push(run);
              return entry;
            };
            let closureRefused: string | undefined;
            const verifyFix = async (root: string, fix: AddressFix) => {
              if (!input.verifyClosure || fix.finding.status !== 'fixed') return;
              const validatedParent = fix.validatedParent ?? fix.observedHead;
              const packet: ClosurePacket = {
                finding: { ...fix.finding },
                task: fix.finding.text,
                patch: '',
                before: '',
                after: '',
                dependencies: [],
                // Neither a fixer claim nor a file list proves dependency completeness.
                relevantDependenciesComplete: false,
                metadata: { revision: { head: fix.commit ?? '', parent: validatedParent } },
              };
              let unavailable: string | undefined;
              const read = async (args: string[]) => {
                const result = await git(['-C', root, ...args]);
                if (result.code !== 0) throw new Error('pinned closure evidence unavailable');
                return result.stdout;
              };
              try {
                if (
                  !fix.commit ||
                  !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(fix.commit) ||
                  !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(validatedParent) ||
                  !fix.finding.file
                )
                  throw new Error('pinned closure identity or file unavailable');
                if ((await read(['rev-parse', `${fix.commit}^`])).trim() !== validatedParent)
                  throw new Error('closure parent differs from validated parent');
                packet.before = await read(['show', `${validatedParent}:${fix.finding.file}`]);
                packet.after = await read(['show', `${fix.commit}:${fix.finding.file}`]);
                packet.patch = await read([
                  'diff',
                  '--no-ext-diff',
                  '--no-textconv',
                  '--no-color',
                  validatedParent,
                  fix.commit,
                  '--',
                  `:(literal)${fix.finding.file}`,
                ]);
              } catch (error) {
                unavailable =
                  error instanceof Error ? error.message : 'closure evidence unavailable';
              }
              const verification = verifyClosureEvidence(packet, {
                admit: () => {
                  const reason = stop() ?? unavailable;
                  if (reason) throw new Error(reason);
                },
              });
              (report.closureVerifications ??= []).push({
                finding: fix.finding.id,
                packet,
                verification,
              });
              if (verification.verdict !== 'resolved') {
                closureRefused = `closure ${fix.finding.id}: ${verification.verdict}: ${verification.reason}`;
                fix.finding.status = 'open';
                fix.finding.reason = closureRefused;
                fix.reason = closureRefused;
              }
            };
            const dispatchFindings = async (
              root: string,
              record: FindingsRecord,
              round: number,
            ) => {
              rowsDispatchedAt.set(record.findings, {
                fixes: report.fixes.length,
                severities: policy.review.blockingSeverities,
              });
              if (
                new Set(record.findings.map((finding) => finding.id)).size !==
                record.findings.length
              )
                throw new Error('duplicate finding identity');
              await admitRecord(root, record);
              report.verifiedHead ??= record.head;
              publishedBase ??= await gitText(root, ['rev-parse', 'HEAD']);
              try {
                if (input.push && expectedRemoteHead === undefined) {
                  publishDestination ??= await resolvePushDestination(git, root, publishRemote);
                  const branch = publishBranch ?? (await branchName(root));
                  const ref = `refs/heads/${branch}`;
                  const remote = await gitText(root, [
                    'ls-remote',
                    '--refs',
                    publishDestination.url,
                    ref,
                  ]);
                  const [sha, destination, extra] = remote.split('\t');
                  if (
                    remote !== '' &&
                    (!/^[0-9a-f]{40,64}$/i.test(sha ?? '') ||
                      destination !== ref ||
                      extra !== undefined)
                  )
                    throw new Error('publication remote head unavailable');
                  expectedRemoteHead = remote === '' ? '' : sha!;
                }
              } catch {
                const reason = 'publication remote head unavailable; fixes withheld';
                report.reasons.push(reason);
                return reason;
              }

              const unresolvedReason = 'unresolved: finding has no file path';
              const pathless = record.findings.filter(
                (finding) => finding.status === 'open' && finding.file === '',
              );
              for (const finding of pathless) finding.reason = unresolvedReason;
              noteRound(round, record);
              for (const batch of addressBatches(
                record.findings.filter(
                  (finding) => finding.status === 'open' && finding.file !== '',
                ),
                policy.review.addressConcurrency,
              )) {
                if (stop() || remainingFixWallMs() <= 0) return;
                const jobs = batch.map((finding, index) => ({
                  id: `finding-${index}`,
                  op: 'review.fixItem',
                  input: {
                    item: { kind: 'finding', finding },
                    worktree: { path: root, branch: record.branch },
                    driver: policy.roles.worker!,
                  } satisfies FindingReviewItemInput,
                }));
                const plan: Plan = { id: `review-address-${round}-${randomUUID()}`, jobs };
                const entry: OpRegistryEntry = {
                  name: 'review.fixItem',
                  inputSchema: FixReviewItemInputSchema,
                  importer: async () => async (raw: unknown) => {
                    const request = raw as FindingReviewItemInput;
                    const fix = await bindWorker(root).fix(request.item.finding, round);
                    await verifyFix(root, fix);
                    remember(fix);
                    return { status: 'ok', value: fix };
                  },
                };
                const run = await runPlan(
                  plan,
                  {
                    concurrency: policy.review.addressConcurrency,
                    stopOnError: false,
                    maxTokens: Math.max(1, remainingTokens()),
                    journalDir: resolve(journalDir, `round-${round}`),
                  },
                  {
                    // SAFETY: the runner's registry view is generic over op I/O; this
                    // entry is the concrete single-job 'review.fixItem' op built immediately
                    // above, and the plan resolves it by that exact name only, so the erased
                    // I/O type parameters cannot be observed through this view.
                    get: (name) =>
                      name === entry.name
                        ? (entry as unknown as OpRegistryEntry<never, never>)
                        : undefined,
                  },
                  {
                    governor: createGovernor({
                      maxTokens: Math.max(1, remainingTokens()),
                      perJobWallClockMs: Math.min(policy.budgets.unit.wallMs, remainingFixWallMs()),
                    }),
                    ...(parent ? { signal: parent } : {}),
                    allowAdvisory: true,
                    allowAdvisoryProvenance: 'product',
                  },
                );
                await linkKernelRun(run, plan.id, round, resolve(journalDir, `round-${round}`));
                if (parent?.aborted) {
                  noteRound(round, record, run);
                  return;
                }
                for (const row of run.jobs) {
                  if (row.result.status !== 'ok') {
                    report.reasons.push(`finding job ${row.jobId}: ${issue(row.result)}`);
                    continue;
                  }
                  const fix = row.result.value as AddressFix;
                  if (fix.finding.status === 'open') continue;
                  if ((await recordDisposition(root, fix)) !== 'recorded')
                    fix.finding.status = 'open';
                }
                noteRound(round, record, run);
              }
              return closureRefused ?? (pathless.length > 0 ? unresolvedReason : undefined);
            };
            const retainDeferred = (record: FindingsRecord): FindingsRecord => {
              const findings = record.findings.map((finding) => {
                const prior = dispositions.get(identity(finding));
                return prior?.status === 'deferred'
                  ? {
                      ...finding,
                      status: prior.status,
                      reason: prior.reason ?? '',
                      ...(prior.evidence ? { evidence: prior.evidence } : {}),
                    }
                  : finding;
              });
              for (const prior of dispositions.values())
                if (
                  prior.status === 'deferred' &&
                  !findings.some((finding) => identity(finding) === identity(prior))
                )
                  findings.push(prior);
              return { ...record, findings };
            };
            // Address uploads the prior round's findings with the dispositions
            // recorded for them; `review.run` owns the config gate
            // (review.reReview.includePriorFindings) and the whole-branch
            // comparison. `current` overlays a fresher record (PR threads)
            // before final dispositions are applied.
            const priorRoundFindings = (
              base: FindingsRecord | undefined,
              current: readonly Finding[] = [],
            ): Finding[] => {
              const ordered = new Map<string, Finding>();
              if (base !== undefined)
                for (const finding of retainDeferred(base).findings)
                  ordered.set(identity(finding), finding);
              for (const finding of current) ordered.set(identity(finding), finding);
              for (const key of ordered.keys()) {
                const disposition = dispositions.get(key);
                if (disposition !== undefined) ordered.set(key, disposition);
              }
              return [...ordered.values()];
            };
            let root = resolve(input.repoRoot);
            let previous: FindingsRecord | undefined;
            let prMetadata:
              | {
                  owner: string;
                  repo: string;
                  pr: number;
                  headRefName: string;
                  headRepo?: string;
                  login: string;
                }
              | undefined;
            let dispatchLogPath: string | undefined;
            let bookkeepingReceiptPath: string | undefined;
            let pendingRerequestPath: string | undefined;
            // The invocation-pinned PR comparison base (engine-captured against
            // the resolved worktree HEAD; undefined when an explicit base was
            // given or the source is local). Its provider resolves lazily after
            // the PR worktree exists.
            let pinnedBase: string | undefined;
            let reviewedBasePinned: (() => Promise<string>) | undefined;
            const reviewers = new Set<string>();
            if (input.source !== 'local') {
              const pr = Number(input.source.slice(3));
              const repoResult = await gh(['repo', 'view', '--json', 'nameWithOwner']);
              const loginResult = await gh(['api', 'user', '--jq', '.login']);
              if (repoResult.code !== 0 || loginResult.code !== 0 || !loginResult.stdout.trim())
                return await finish(
                  'needs-human',
                  'current authenticated forge identity/repository unavailable',
                );
              const name = (JSON.parse(repoResult.stdout) as { nameWithOwner: string })
                .nameWithOwner;
              const [owner, repo] = name.split('/');
              if (!owner || !repo)
                return await finish('needs-human', 'invalid forge repository identity');
              const metaResult = await gh([
                'pr',
                'view',
                String(pr),
                '--repo',
                name,
                '--json',
                'headRefName,headRepositoryOwner,headRepository',
              ]);
              if (metaResult.code !== 0)
                return await finish('needs-human', 'PR head metadata unavailable');
              const meta = JSON.parse(metaResult.stdout) as {
                headRefName: string;
                headRepositoryOwner: { login: string };
                headRepository: { name: string };
              };
              if (
                !/^[A-Za-z0-9_.-]+$/.test(meta.headRepositoryOwner.login) ||
                !/^[A-Za-z0-9_.-]+$/.test(meta.headRepository.name) ||
                !meta.headRefName ||
                meta.headRefName.startsWith('-')
              )
                return await finish('needs-human', 'invalid PR head repository/branch');
              prMetadata = {
                owner,
                repo,
                pr,
                headRefName: meta.headRefName,
                headRepo: `${meta.headRepositoryOwner.login}/${meta.headRepository.name}`,
                login: loginResult.stdout.trim(),
              };
              publishBranch = prMetadata.headRefName;
              publishRemote =
                prMetadata.headRepo === name
                  ? 'origin'
                  : `https://github.com/${prMetadata.headRepo}.git`;

              // Publication receipts outlive run-specific reports. A changed target,
              // fork/branch or authenticated actor cannot borrow another run's log.
              // The loop still requires fetched authenticated current-head/round proof;
              // a stored receipt alone never authorizes resolution.
              const commonDir = await gitText(root, [
                'rev-parse',
                '--path-format=absolute',
                '--git-common-dir',
              ]);
              if (!commonDir)
                return await finish('needs-human', 'Git common directory unavailable');
              const namespace = createHash('sha256')
                .update(
                  JSON.stringify([
                    owner.toLowerCase(),
                    repo.toLowerCase(),
                    pr,
                    input.target ?? 'main',
                    input.base ?? null,
                    prMetadata.headRepo!.toLowerCase(),
                    meta.headRefName,
                    prMetadata.login.toLowerCase(),
                  ]),
                )
                .digest('hex');
              const receiptDir = resolve(
                deps.coordinationRoot ?? resolve(root, commonDir),
                'cq-review-address',
                namespace,
              );
              await mkdir(receiptDir, { recursive: true });
              dispatchLogPath = resolve(receiptDir, 'dispatch.jsonl');
              const checkoutReceipts = resolve(root, commonDir, 'cq-review-address', namespace);
              await mkdir(checkoutReceipts, { recursive: true });
              bookkeepingReceiptPath = resolve(
                await realpath(checkoutReceipts),
                'bookkeeping.json',
              );
              pendingRerequestPath = resolve(await realpath(receiptDir), 'pending-rerequests.json');
              persistedBookkeeping = makeAddressBookkeepingReceipt({
                path: bookkeepingReceiptPath,
                identity: namespace,
                fingerprints: bookkeeping,
                git: gitText,
              });
            }
            if (input.source === 'local') {
              const read = await readWorkState(makeSubprocessDevEffects(root), {
                target: input.target ?? 'main',
                ...(input.base ? { base: input.base } : {}),
              });
              if (!read.ok) return await finish('needs-human', read.reason);
              reviewedBase = read.state.base;
            }
            if (input.source !== 'local' && !input.base) {
              // Pin the PR comparison base ONCE per invocation, computed against
              // the RESOLVED PR worktree HEAD (not the caller checkout, whose
              // HEAD may differ from the PR head on real runs). The capture is
              // lazy: it runs at the first consumer after resolvePrWorktree has
              // produced the per-PR checkout, and rides this invocation's own
              // injected git transport so fakes answer it like every other
              // PR-path git read. Explicit-base invocations keep passing their
              // own base through.
              reviewedBasePinned = async () => {
                if (pinnedBase === undefined) {
                  const target = input.target ?? 'main';
                  const result = await git([
                    '-C',
                    workerRoot,
                    'merge-base',
                    '--end-of-options',
                    `origin/${target}`,
                    'HEAD',
                  ]);
                  const base = result.stdout.trim();
                  if (result.code !== 0 || !base)
                    throw new Error(
                      `cannot pin the merge-base: 'origin/${target}' did not resolve — fetch the target and re-run`,
                    );
                  pinnedBase = base;
                }
                return pinnedBase;
              };
            }
            /**
             * ADR-0008 T21: one `review-observed` event per review source per
             * reviewed record — append-only, never a last-head overwrite;
             * blocked vendors count as not-completed. Scope base: the
             * record's `reviewed` proof, else the lane base for records this
             * composition produced; else withheld silently (one entry per
             * source, distinct reason) and folded into /reviews as partial.
             * A foreign coverage proof (head or base naming another record)
             * is never attached. Rows carry the findings attributed to their
             * source; with no attributable findings anywhere the record
             * union stands in. A failed append is an observation failure; it
             * never rewrites the verdict.
             */
            const emitReviewObserved = async (
              round: number,
              record: FindingsRecord,
              lane?: { base?: string | undefined; unresolved?: string | undefined },
            ): Promise<void> => {
              if (observation?.writer === undefined) return;
              const writer = observation.writer;
              const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
              const withhold = (reason: string): void => {
                for (let index = 0; index < record.sources.length; index++)
                  withheldReviewReasons.push(reason);
              };
              if (!COMMIT_ID.test(record.head)) {
                withhold('record head is not a commit id');
                return;
              }
              const base =
                record.reviewed !== undefined && COMMIT_ID.test(record.reviewed.base)
                  ? record.reviewed.base
                  : lane?.base !== undefined && COMMIT_ID.test(lane.base)
                    ? lane.base
                    : undefined;
              if (base === undefined) {
                withhold(lane?.unresolved ?? 'no reviewed base proof');
                return;
              }
              reviewExposureRecords++;
              const fingerprintOf = (finding: Finding): FindingFingerprint =>
                finding.fingerprint ?? {
                  version: 1,
                  checkId: finding.source,
                  rule: finding.rule ?? null,
                  path: finding.file ?? '',
                  spanContentHash: null,
                };
              const notCollected = (reason: string): AvailabilityRecord => ({
                state: 'not-collected',
                reason,
                source: null,
              });
              const anyAttributed = record.findings.some((finding) =>
                record.sources.some((source) => source.kind === finding.source),
              );
              for (const source of record.sources) {
                const parsed =
                  source.coverage === undefined
                    ? undefined
                    : ReviewCoverageSchema.safeParse(source.coverage);
                const proof = parsed?.success ? parsed.data : undefined;
                const usable =
                  proof !== undefined && proof.head === record.head && proof.base === base
                    ? proof
                    : undefined;
                const v2 = usable !== undefined && 'version' in usable ? usable : undefined;
                const legacy = usable !== undefined && !('version' in usable) ? usable : undefined;
                const availability: Record<string, AvailabilityRecord> = {};
                let delivered: string[] = [];
                let completed: string[] = [];
                let omissions: string[] = [];
                let coverage = 'none-recorded';
                if (proof !== undefined && usable === undefined) {
                  for (const pointer of ['/delivered', '/completed', '/omissions'])
                    availability[pointer] = notCollected(
                      'the coverage proof names another head or base; a foreign proof is never attached',
                    );
                  coverage = 'foreign';
                } else if (v2 !== undefined) {
                  delivered = v2.pieces
                    .filter((piece) => piece.state === 'delivered' || piece.state === 'completed')
                    .map((piece) => piece.path);
                  completed = v2.pieces
                    .filter((piece) => piece.state === 'completed')
                    .map((piece) => piece.path);
                  omissions = v2.pieces
                    .filter((piece) => piece.state === 'excluded' || piece.state === 'planned')
                    .map((piece) => piece.path);
                  coverage = `v2:${v2.mode}:${v2.scope}`;
                } else if (legacy !== undefined) {
                  delivered = legacy.partitions.map((partition) => partition.receipt);
                  completed = legacy.partitions
                    .filter((partition) => partition.complete)
                    .map((partition) => partition.receipt);
                  coverage = `legacy:${legacy.scope}`;
                  availability['/omissions'] = notCollected(
                    'legacy coverage records no omission evidence; absence is unknown, never none',
                  );
                } else {
                  for (const pointer of ['/delivered', '/completed', '/omissions'])
                    availability[pointer] = notCollected(
                      'the review source recorded no coverage proof; empty lists are unknown, never known-empty',
                    );
                }
                const vendorCompletion =
                  source.status === 'blocked'
                    ? ('not-completed' as const)
                    : v2 !== undefined
                      ? isCoverageV2Complete(v2)
                        ? ('completed' as const)
                        : ('not-completed' as const)
                      : legacy !== undefined
                        ? legacy.partitions.every((partition) => partition.complete)
                          ? ('completed' as const)
                          : ('not-completed' as const)
                        : ('unknown' as const);
                if (source.cycleId === undefined)
                  availability['/reviewerId'] = notCollected(
                    'the source recorded no cycle id; the producer kind stands in, never a guessed vendor identity',
                  );
                const row = anyAttributed
                  ? record.findings.filter((finding) => finding.source === source.kind)
                  : record.findings;
                const event: ReviewObservedJournalEvent = {
                  type: 'review-observed',
                  runId: observation.compositionRunId,
                  at: new Date().toISOString(),
                  unitId: null,
                  jobId: null,
                  taskId: null,
                  attempt: null,
                  payload: {
                    baseSha: base,
                    headSha: record.head,
                    findingFingerprints: row.map(fingerprintOf),
                    coverage,
                    initialBlocking: openBlocking(
                      { findings: row },
                      policy.review.blockingSeverities,
                    ).map(fingerprintOf),
                    reviewerId: source.cycleId ?? source.kind,
                    source: source.kind,
                    round,
                    delivered,
                    completed,
                    omissions,
                    vendorCompletion,
                    availability,
                  },
                };
                try {
                  await writer.append(sanitizeObservation(event));
                } catch (error) {
                  observationFailure(error);
                }
              }
            };
            /**
             * The PR lane comparison base for review-observed scope rows: the
             * caller-asserted base, else the once-pinned merge-base. A pin
             * failure carries its own withheld reason.
             */
            const prLaneBase = async (): Promise<{
              base?: string | undefined;
              unresolved?: string | undefined;
            }> => {
              if (input.base !== undefined) return { base: input.base };
              try {
                return { base: await reviewedBasePinned?.() };
              } catch {
                return { unresolved: 'merge-base unresolved' };
              }
            };
            for (let round = 1; round <= policy.review.rounds; round++) {
              const stopped = stop();
              if (stopped) return await finish('needs-human', stopped);
              if (round > 1 && remainingFixWallMs() <= 0)
                return await finish('needs-human', fixWallStop);
              if (prMetadata) {
                const meta = prMetadata;
                const fixesById = new Map<string, AddressFix>();
                const dispatchedFindings: Finding[] = [];
                let dispatchedRecord: FindingsRecord | undefined;
                let admissionRefused = false;
                const entry: OpRegistryEntry = {
                  name: 'review.fixItem',
                  inputSchema: FixReviewItemInputSchema,
                  importer: async () => async (raw: unknown) => {
                    const item = raw as FixReviewItemInput;
                    root = item.worktree.path;
                    workerRoot = root;
                    publishBranch = meta.headRefName;
                    publishRemote =
                      meta.headRepo === `${meta.owner}/${meta.repo}`
                        ? 'origin'
                        : `https://github.com/${meta.headRepo}.git`;
                    publishedBase ??= await gitText(root, ['rev-parse', 'HEAD']);
                    const finding: Finding = {
                      id: item.item.id,
                      source: 'pr-threads',
                      ...(item.item.path ? { file: item.item.path } : {}),
                      ...(item.item.line && item.item.line > 0 ? { line: item.item.line } : {}),
                      severity: PR_THREAD_FINDING_SEVERITY,
                      text: discussionText(item.item.body, item.item.comments),
                      status: 'open',
                    };
                    if (remainingFixWallMs() <= 0)
                      return { status: 'needs-human', reason: fixWallStop };
                    const bound = bindWorker(root);
                    const admit = async (head: string) => {
                      if ((await branchName(root)) !== item.worktree.branch)
                        throw new Error('worker execution branch changed');
                      const record: FindingsRecord = {
                        schemaVersion: 1,
                        branch: item.worktree.branch,
                        head,
                        sources: [{ kind: 'pr-threads', status: 'terminal' }],
                        findings: [finding],
                      };
                      // Before this item's fix, and before admitRecord can
                      // refuse: the finding was dispatched as an open blocker.
                      noteInitialOpenBlocking(round, record);
                      await admitRecord(root, record);
                      report.verifiedHead ??= record.head;
                      dispatchedRecord ??= record;
                    };
                    try {
                      if (bound.withVerifiedHead) await bound.withVerifiedHead(admit);
                      else await admit(await gitText(root, ['rev-parse', 'HEAD']));
                    } catch (error) {
                      // Initial ownership/admission refusal must not become a
                      // re-review write to unregistered caller metadata. Model and
                      // normal edit failures occur after this narrow fence.
                      admissionRefused = true;
                      throw error;
                    }
                    dispatchedFindings.push(finding);
                    const fix = await bound.fix(finding, round);
                    if (parent?.aborted)
                      return {
                        status: 'needs-human',
                        reason: 'parent cancelled; disposition withheld',
                      };
                    await verifyFix(root, fix);
                    if (fix.finding.status === 'open') {
                      fixesById.set(finding.id, fix);
                      remember(fix);
                      return { status: 'needs-human', reason: fix.reason };
                    }
                    const disposition = await recordDisposition(root, fix);
                    if (disposition !== 'recorded') fix.finding.status = 'open';
                    remember(fix);
                    fixesById.set(finding.id, fix);
                    if (disposition === 'withheld')
                      return {
                        status: 'needs-human',
                        reason: `${NO_OUTCOME_REASON}: ${fix.reason}`,
                      };
                    if (disposition === 'failed')
                      return {
                        status: 'needs-human',
                        reason: `${NO_OUTCOME_REASON}: disposition persistence failed`,
                      };
                    if (fix.finding.status === 'rejected' && fix.evidence?.length)
                      return {
                        status: 'ok',
                        value: {
                          disposition: 'unchanged_with_reason',
                          observedHead: fix.observedHead,
                          changed: false,
                          summary: fix.reason,
                          commits: [],
                          evidence: fix.evidence,
                          denials: [],
                        } satisfies FixReviewItemResult,
                      };
                    if (!fix.commit)
                      return {
                        status: 'needs-human',
                        reason: `${NO_OUTCOME_REASON}: ${fix.reason}`,
                      };
                    const value: FixReviewItemResult = {
                      observedHead: fix.observedHead,
                      disposition: 'fixed',
                      changed: true,
                      summary: fix.reason,
                      commits: [fix.commit],
                      evidence: [],
                      denials: [],
                    };
                    return { status: 'ok', value };
                  },
                };
                // The head check is admission-only: from round 2 on the
                // previous round's commit has legitimately moved the worktree
                // HEAD, so no expected head is passed.
                const roundOneExpectedHead =
                  round === 1 ? (lease.expectedHead ?? input.expectedHead) : undefined;
                const loop = await runAddressReviewLoop(lease, {
                  owner: meta.owner,
                  repo: meta.repo,
                  pr: meta.pr,
                  headRefName: meta.headRefName,
                  ...(meta.headRepo ? { headRepo: meta.headRepo } : {}),
                  repoRoot: input.repoRoot,
                  ...(roundOneExpectedHead ? { expectedHead: roundOneExpectedHead } : {}),
                  gh,
                  git,
                  registry: deps.worktreeRegistry ?? lease.registry!,
                  isBookkeepingPath: (path, resolvedRoot) =>
                    withBookkeepingAccess(resolvedRoot, async () => {
                      // Resolution already holds this checkout's slot. Import only
                      // exact receipt-authenticated bytes before its reuse gate.
                      await persistedBookkeeping?.prepare(resolvedRoot);
                      return untrackedAllowed(resolvedRoot, path);
                    }),
                  beforeWorktreeResolve: () =>
                    lease.assertSelection({
                      pr: meta.pr,
                      headRepo: meta.headRepo ?? `${meta.owner}/${meta.repo}`,
                      headRefName: meta.headRefName,
                    }),
                  onWorktreeResolved: async (info) => {
                    expectedRemoteHead ??= await gitText(info.path, ['rev-parse', 'HEAD']);
                    publishedBase ??= expectedRemoteHead;
                    await lease.claimCheckout({
                      ...info,
                      head: await gitText(info.path, ['rev-parse', 'HEAD']),
                    });
                  },
                  onPublished: (sha) => {
                    unpublished.clear();
                    publishedBase = sha;
                    expectedRemoteHead = sha;
                  },
                  driver: policy.roles.worker!,
                  driverRegistryView: {
                    get: (name) => (name === 'review.fixItem' ? entry : undefined),
                  } as OpRegistryView,
                  responderLogin: meta.login,
                  nowMs: Date.now(),
                  dispatchLogPath: dispatchLogPath!,
                  allowAdvisoryBudget: true,
                  engineOwnedConcurrency: policy.review.addressConcurrency,
                  publish: input.push === true,
                  publicationTreeClean,
                  // ADR-0008: the round's item population is known HERE,
                  // before anything dispatches, so an exit taken before the
                  // post-fetch merge (an admission or closure refusal, a
                  // truncated fetch, a moved branch, a throwing fetch) still
                  // reports the whole round-1 population. An EMPTY plan may
                  // not CREATE a baseline: every thread skipped (answered
                  // this round, loop-replied at this head) is still an open
                  // population this seed never observed, and a pre-merge
                  // exit below would persist a present-empty list a
                  // measurement consumer reads as known-zero. Absent stays
                  // absent — the post-fetch merge and the local-path
                  // capture still write a genuinely known-empty population.
                  onItemsPlanned: (ids) => {
                    if (ids.length === 0 && report.initialOpenBlocking === undefined) return;
                    noteInitialOpenBlocking(round, {
                      // Minimal PR-thread shape; only id/severity/status feed the filter.
                      findings: ids.map((id) => ({
                        id,
                        source: 'pr-threads',
                        severity: PR_THREAD_FINDING_SEVERITY,
                        text: '',
                        status: 'open' as const,
                      })),
                    });
                  },
                  onFixRunSettled: (run) => {
                    // Retain the settled run before later Git/forge work can throw.
                    // An initial refusal has no admitted work to record; a refused
                    // sibling must not erase the history of earlier admitted work.
                    if (!dispatchedRecord || dispatchedFindings.length === 0) return;
                    // ADR-0008 T31: keep the link promise. It is drained by
                    // finish() before the stream closes, and a rejection is an
                    // observation failure — never a swallowed error behind a
                    // report that still claims durable evidence.
                    trackLink(
                      linkKernelRun(
                        run,
                        `review-address-pr-${meta.pr}`,
                        round,
                        resolve(journalDir, `pr-round-${round}`),
                      ).catch((error) => observationFailure(error)),
                    );
                    noteRound(
                      round,
                      {
                        ...dispatchedRecord,
                        findings: dispatchedFindings.map(
                          (finding) => fixesById.get(finding.id)?.finding ?? finding,
                        ),
                      },
                      run,
                    );
                  },
                  onWorktreeStaleRefresh: async () => {
                    await lease.assertOwned();
                    // The refresh removal refused on untracked files. Clear
                    // ONLY what the existing receipt strictly attests as
                    // engine-owned (identity/root/branch/head, path allowlist
                    // and exact bytes re-validated by the receipt's own
                    // machinery); any other dirt keeps the strict refusal.
                    // onCreated still performs the receipt rotation afterwards.
                    // Once bookkeeping fingerprints exist, deleting receipt-owned
                    // files would leave the in-memory map pointing at deleted
                    // paths, so the next check would (wrongly) declare the run
                    // tampered: keep the strict refusal instead.
                    if (!persistedBookkeeping || bookkeeping.size > 0) return false;
                    const owned = await persistedBookkeeping.ownedFiles();
                    for (const path of owned) await unlink(path);
                    return true;
                  },
                  onWorktreeCreated: async () => {
                    await lease.assertOwned();
                    // Engine-verified creation of the per-PR worktree: any
                    // receipt from a previous checkout instance describes a
                    // root/head this run did not create. Retire it so the fresh
                    // checkout can earn its own; a caller-trusted change would
                    // still refuse inside prepare(). The in-memory fingerprints
                    // stay empty for the fresh tree; they are earned through the
                    // normal noteBookkeeping writes.
                    if (!persistedBookkeeping || !bookkeepingReceiptPath) return;
                    try {
                      await rename(bookkeepingReceiptPath, `${bookkeepingReceiptPath}.retired`);
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    }
                  },
                  ...(parent ? { signal: parent } : {}),
                  runOptions: {
                    maxTokens: Math.max(1, remainingTokens()),
                    journalDir: resolve(journalDir, `pr-round-${round}`),
                  },
                });
                if (!loop.worktree.path) {
                  report.reasons.push(...loop.reasons);
                  return await finish(
                    'needs-human',
                    loop.headRefused ? 'PR head changed before dispatch' : loop.reasons.join('; '),
                  );
                }
                root = loop.worktree.path;
                workerRoot = root;
                publishBranch = meta.headRefName;
                if (loop.status !== 'ok') report.reasons.push(...loop.reasons);
                if (loop.headRefused)
                  return await finish('needs-human', 'PR head changed before dispatch');
                if (admissionRefused)
                  return await finish(
                    'needs-human',
                    worker?.preconditionFailure?.() ??
                      'PR worker admission refused; persisted/caller bytes retained',
                  );
                if (closureRefused) {
                  if (dispatchedRecord) {
                    const record = {
                      ...dispatchedRecord,
                      findings: dispatchedFindings.map(
                        (finding) => fixesById.get(finding.id)?.finding ?? finding,
                      ),
                    };
                    report.findings = record.findings;
                    report.openBlocking = openBlocking(record, policy.review.blockingSeverities);
                  }
                  return await finish('needs-human', closureRefused);
                }
                const fetched = await fetchReviewState(
                  { owner: meta.owner, repo: meta.repo, pr: meta.pr },
                  undefined,
                  gh,
                );
                if (fetched.truncated)
                  return await finish('needs-human', 'PR review source truncated');
                for (const thread of fetched.threads) {
                  if (
                    thread.isResolved &&
                    fixesById.get(thread.id)?.commit &&
                    thread.authorLogin &&
                    (thread.authorType === 'Bot' || thread.authorLogin.endsWith('[bot]'))
                  ) {
                    const reason = `advisory: bot reviewer ${thread.authorLogin} cannot be re-requested through the human reviewer API; no bot re-request performed`;
                    if (!report.reasons.includes(reason)) report.reasons.push(reason);
                    continue;
                  }
                  if (
                    thread.isResolved &&
                    fixesById.get(thread.id)?.commit &&
                    thread.authorLogin &&
                    thread.authorType !== 'Bot' &&
                    !thread.authorLogin.endsWith('[bot]') &&
                    thread.authorLogin !== meta.login
                  )
                    reviewers.add(thread.authorLogin);
                }
                if (pendingRerequestPath) {
                  // Re-request attempts are recovered across runs: merge the
                  // persisted names from a failed attempt into this round's
                  // scan and repersist the union before any dispatch. The store
                  // clears only after a successful re-request below.
                  try {
                    const parsed: unknown = JSON.parse(
                      await readFile(pendingRerequestPath, 'utf8'),
                    );
                    if (Array.isArray(parsed))
                      for (const name of parsed)
                        if (typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name))
                          reviewers.add(name);
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                  }
                  if (reviewers.size) {
                    await writeFile(
                      `${pendingRerequestPath}.tmp`,
                      `${JSON.stringify([...reviewers].sort())}\n`,
                      {
                        mode: 0o600,
                      },
                    );
                    await rename(`${pendingRerequestPath}.tmp`, pendingRerequestPath);
                  }
                }
                // A failed after-snapshot leaves the loop's replies/resolves
                // published but the round unverified. Stop BEFORE the
                // re-review, after preserving pending reviewer requests. That pass
                // would replace the settled record with the re-reviewed
                // population and lose the history of what the fixes did.
                if (loop.verifyFailure !== undefined)
                  return await finish(
                    'needs-human',
                    `verify snapshot failed: ${loop.verifyFailure}`,
                  );
                if ((await branchName(root)) !== loop.worktree.branch)
                  return await finish('needs-human', 'PR worker branch changed');
                const currentHead = await gitText(root, ['rev-parse', 'HEAD']);
                const rejectionReasons = new Map<string, string>();
                const ledger = makeSubprocessDevEffects(root)
                  .openLedger(loop.worktree.branch)
                  .load();
                for (const thread of fetched.threads) {
                  const proof = loopReplyVerdict(thread, {
                    signature: replySignature(meta.owner, meta.repo, meta.pr),
                    headSha: currentHead,
                    ownLogin: meta.login,
                    requireCurrentIdentity: true,
                  });
                  const latest = ledger.records
                    .filter(
                      (entry) => entry.kind === 'disposition' && entry.findingId === thread.id,
                    )
                    .at(-1);
                  if (
                    proof.kind === 'settled' &&
                    !proof.carryResolve &&
                    latest?.kind === 'disposition' &&
                    latest.action === 'rejected' &&
                    latest.head === currentHead
                  )
                    rejectionReasons.set(thread.id, latest.why);
                }
                const threads: FindingsRecord = {
                  schemaVersion: 1,
                  branch: loop.worktree.branch,
                  head: currentHead,
                  sources: [{ kind: 'pr-threads', status: 'terminal' }],
                  findings: fetched.threads
                    .filter(
                      (thread) =>
                        !thread.isResolved &&
                        thread.authorLogin !== meta.login &&
                        thread.authorLogin !== fetched.authorLogin,
                    )
                    .map((thread) => ({
                      id: thread.id,
                      source: 'pr-threads',
                      ...(thread.path ? { file: thread.path } : {}),
                      ...(thread.line && thread.line > 0 ? { line: thread.line } : {}),
                      text: discussionText(thread.body, thread.replies),
                      severity: PR_THREAD_FINDING_SEVERITY,
                      status: rejectionReasons.has(thread.id) ? 'rejected' : 'open',
                      ...(rejectionReasons.has(thread.id)
                        ? { reason: rejectionReasons.get(thread.id)! }
                        : {}),
                    })),
                };
                // T21: the PR-thread population of this round's head.
                await emitReviewObserved(round, threads, await prLaneBase());
                report.findings = retainDeferred(threads).findings;
                noteAdvisories(threads);
                report.openBlocking = openBlocking(
                  { ...threads, findings: report.findings },
                  policy.review.blockingSeverities,
                );
                // Round 1 ALWAYS merges the full open-thread population: items
                // stopped BEFORE admission (the fix-wall stop, a refusal, a
                // parent cancel) never reached the dispatch capture, so the
                // baseline is completed here. The helper is round-1-only and
                // only gains ids (deduplicated, first-seen order), so it can
                // never shrink or replace the list a later round sees.
                noteInitialOpenBlocking(round, { findings: report.findings });
                if (stop()) return await finish('needs-human', stop());
                const priorFindings = priorRoundFindings(previous, [
                  ...threads.findings,
                  ...[...fixesById.values()].map((fix) => fix.finding),
                ]);
                const agent = await review({
                  repoRoot: root,
                  target: input.target ?? 'main',
                  ...(input.base
                    ? { base: input.base }
                    : reviewedBasePinned
                      ? { base: await reviewedBasePinned() }
                      : {}),
                  maxTokens: Math.max(1, remainingTokens()),
                  wallMs: Math.max(1, remainingWallMs()),
                  reviewers: ['agent'],
                  ...(priorFindings.length > 0 ? { priorFindings } : {}),
                });
                if (agent.status !== 'ok') {
                  if (agent.report) noteAdvisories(agent.report);
                  // T21/P1: the aborted re-review is still an exposure —
                  // emit its record (blocked vendors as not-completed) or
                  // count it withheld; never dropped on the exit path.
                  if (agent.report !== undefined)
                    await emitReviewObserved(round, agent.report, await prLaneBase());
                  else withheldReviewReasons.push('re-review returned no anchored head');
                  return await finish(
                    'needs-human',
                    `PR re-review: ${issue(agent)}`,
                    rereviewStop(agent),
                  );
                }
                if (agent.value.branch !== threads.branch || agent.value.head !== threads.head) {
                  withheldReviewReasons.push('identity changed before the re-review was recorded');
                  return await finish('needs-human', 'PR re-review identity changed');
                }
                // T21: the agent re-review exposure of the same head.
                await emitReviewObserved(round, agent.value, await prLaneBase());
                previous = retainDeferred(merge([threads, agent.value]));
                noteAdvisories(previous);
                noteRound(round, previous).record = previous;
                report.findings = previous.findings;
                report.openBlocking = openBlocking(previous, policy.review.blockingSeverities);
                if (
                  report.openBlocking.length === 0 &&
                  !bookkeepingFailed &&
                  loop.status === 'ok' &&
                  isComplete(previous, ['agent', 'pr-threads'])
                ) {
                  if (stop()) return await finish('needs-human', stop());
                  if (reviewers.size) {
                    await requestReviewers({
                      owner: meta.owner,
                      repo: meta.repo,
                      pr: meta.pr,
                      reviewers: [...reviewers],
                      run: gh,
                    });
                    // Dispatch succeeded: the persisted recovery store is done.
                    if (pendingRerequestPath)
                      await unlink(pendingRerequestPath).catch((error) => {
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                      });
                  }
                  return await finish('ok');
                }
                // Local agent findings share the same engine and round cap as forge threads.
                const agentRecord = retainDeferred(agent.value);
                // ADR-0008: the agent re-review can return NEW blockers this
                // same round then dispatches; the merge before the re-review
                // saw only the forge-thread population, so they join the
                // round-1 baseline here, before dispatchFindings plans them.
                // The helper's round guard keeps later rounds out, as elsewhere.
                noteInitialOpenBlocking(round, agentRecord);
                const unresolved = await dispatchFindings(root, agentRecord, round);
                await publishOnExit();
                if (unresolved) return await finish('needs-human', stop() ?? unresolved);
                continue;
              }
              if (!previous) {
                const branch = await branchName(root);
                let record = deps.initialRecord;
                if (!record) {
                  let path = input.record;
                  if (!path) {
                    const folder = resolve(root, '.cq', 'review', reviewBranchKey(branch));
                    // A branch with no review.run yet has no folder: that is the
                    // documented "no findings record" guidance, not a raw ENOENT.
                    let names: string[];
                    try {
                      names = await readdir(folder);
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                      names = [];
                    }
                    const files = names
                      .filter((name) => /^\d+\.json$/.test(name))
                      .sort((a, b) => Number(b.slice(0, -5)) - Number(a.slice(0, -5)));
                    if (!files[0])
                      return await finish(
                        'needs-human',
                        'no findings record; run review.run or pass --record',
                      );
                    path = join(folder, files[0]);
                  }
                  record = FindingsRecordSchema.parse(
                    JSON.parse(await readFile(resolve(root, path), 'utf8')),
                  );
                  await noteBookkeeping(
                    await bookkeepingKey(root, relative(root, resolve(root, path))),
                  );
                }
                if (
                  record.branch !== branch ||
                  record.head !== (await gitText(root, ['rev-parse', 'HEAD']))
                )
                  return await finish(
                    'needs-human',
                    'findings record does not match current branch/head',
                  );
                previous = record;
                report.verifiedHead ??= record.head;
                // T21: the inherited initial population, stamped round 0
                // (inherited before round 1); its base proof is the record's
                // own (produced outside this composition).
                await emitReviewObserved(0, record);
              }
              report.findings = previous.findings;
              noteAdvisories(previous);
              report.openBlocking = openBlocking(previous, policy.review.blockingSeverities);
              if (!(await hasRequiredSources(root, previous)))
                return await finish('needs-human', 'review source incomplete');
              if (stop()) return await finish('needs-human', stop());
              // AFTER source validation and disposition restoration, BEFORE any
              // dispatch: round 1's admitted record — including blockers that
              // the restoration reopened or appended — is the initial
              // open-blocker population, so the baseline covers exactly the
              // rows this run dispatches. Later rounds are ignored by the guard.
              noteInitialOpenBlocking(round, previous);
              report.findings = previous.findings;
              report.openBlocking = openBlocking(previous, policy.review.blockingSeverities);
              const pending = previous.findings.filter((f) => f.status === 'open');
              if (!pending.length && !report.openBlocking.length && !bookkeepingFailed) {
                await admitCleanRecord(root, previous);
                return await finish('ok');
              }
              const unresolved = await dispatchFindings(root, previous, round);
              await publishOnExit();
              if (stop()) return await finish('needs-human', stop());
              if (unresolved) return await finish('needs-human', unresolved);
              const priorFindings = priorRoundFindings(previous);
              const refreshed = await review({
                repoRoot: root,
                target: input.target ?? 'main',
                ...(reviewedBase ? { base: reviewedBase } : {}),
                maxTokens: Math.max(1, remainingTokens()),
                wallMs: Math.max(1, remainingWallMs()),
                ...(priorFindings.length > 0 ? { priorFindings } : {}),
              });
              const refreshedRecord =
                refreshed.status === 'ok'
                  ? refreshed.value
                  : refreshed.status === 'needs-human' &&
                      refreshed.report?.deferredVendorDebt &&
                      refreshed.report.blockedBudget !== true &&
                      !stop() &&
                      (await hasRequiredSources(root, refreshed.report))
                    ? FindingsRecordSchema.strip().parse(refreshed.report)
                    : undefined;
              if (!refreshedRecord) {
                if (refreshed.report) noteAdvisories(refreshed.report);
                // T21/P1: the aborted re-review is still an exposure —
                // emit its record (blocked vendors as not-completed) or
                // count it withheld; never dropped on the exit path.
                if (refreshed.report !== undefined)
                  await emitReviewObserved(round, refreshed.report, { base: reviewedBase });
                else withheldReviewReasons.push('re-review returned no anchored head');
                return await finish(
                  'needs-human',
                  `re-review: ${issue(refreshed)}`,
                  rereviewStop(refreshed),
                );
              }
              try {
                if (
                  refreshedRecord.branch !== (await branchName(root)) ||
                  refreshedRecord.head !== (await gitText(root, ['rev-parse', 'HEAD']))
                ) {
                  withheldReviewReasons.push('identity changed before the re-review was recorded');
                  return await finish('needs-human', 're-review identity changed');
                }
              } catch (error) {
                // T21/P3: the exposure exists but the check itself failed —
                // count it withheld so /reviews stays truthful, then let the
                // run's own failure path decide the outcome.
                withheldReviewReasons.push(
                  'identity check failed before the re-review was recorded',
                );
                throw error;
              }
              // T21: the re-review exposure of this round's head.
              await emitReviewObserved(round, refreshedRecord, { base: reviewedBase });
              previous = retainDeferred(refreshedRecord);
              const complete = await hasRequiredSources(root, previous);
              if (stop()) return await finish('needs-human', stop());
              noteAdvisories(previous);
              report.findings = previous.findings;
              report.openBlocking = openBlocking(previous, policy.review.blockingSeverities);
              noteRound(round, previous).record = previous;
              if (complete && !report.openBlocking.length && !bookkeepingFailed) {
                await admitCleanRecord(root, previous);
                return await finish('ok');
              }
            }
            return await finish('needs-human', REVIEW_ADDRESS_ROUNDCAP_REASON, 'round-cap');
          } catch (error) {
            return await finish(
              'needs-human',
              error instanceof Error ? error.message : String(error),
            );
          }
        });
      return await runOwned();
    } catch (error) {
      return await finish('needs-human', error instanceof Error ? error.message : String(error));
    }
  };
}
