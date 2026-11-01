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
import { createDriverFactory, type DriverFactory } from '../../driver/factory.js';
import type { Usage, WorkerResult } from '../../driver/types.js';
import { createGovernor, currentJobContext } from '../../kernel/governor.js';
import { runPlan, type OpRegistryView } from '../../kernel/runner.js';
import type { OpRegistryEntry, OpResult, Plan, RunReport } from '../../kernel/types.js';
import { makeGhRunner, type GhFn } from '../../adapters/forge-github/gh.js';
import { fetchReviewState } from '../../adapters/forge-github/fetchReviewState.js';
import { requestReviewers } from '../../adapters/forge-github/requestReviewers.js';
import { fileWorktreeRegistry, type WorktreeRegistry } from '../../adapters/git/prWorktree.js';
import { loopReplyVerdict, replySignature } from '../../plans/review-loop.js';
import { parseCqConfig, type CqConfig } from '../analyze/cqConfig.js';
import { resolveCqConfigDefaults, requireAgenticTokenBudget } from '../analyze/cqConfigDefaults.js';
import { makeDevDisposition } from '../dev/disposition.js';
import { makeSubprocessDevEffects } from '../dev/effects.js';
import {
  FindingsRecordSchema,
  isComplete,
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
} from './addressWorker.js';
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
  addressChildSignal,
  addressCancelledResult,
  noteAddressOpaqueInvocation,
  bindAddressTerminalReport,
  addressTerminalWorkerBinding,
  addressOwnedEvidence,
  isAddressOwnershipAdmissionRefusal,
  runAddressReviewLoop,
  withAddressOwnership,
  type AddressLease,
} from './internal/addressOwnership.js';
import { DEV_LEDGER_VERSION, devLedgerPath, type DevCycleRecord } from '../dev/record.js';

export interface ReviewAddressInput {
  repoRoot: string;
  source: string;
  record?: string;
  target?: string;
  base?: string;
  maxTokens?: number;
  wallMs?: number;
  rounds?: number;
  concurrency?: number;
  journalDir?: string;
  push?: boolean;
}
export interface ReviewAddressReport {
  source: string;
  reportPath: string;
  /** One entry per round; the latest reviewed record and all settled batch runs. */
  rounds: Array<{ round: number; record: FindingsRecord; runs: RunReport[] }>;
  findings: Finding[];
  /** Report context only: review advisories never enter `findings` or dispatch. */
  advisories?: string[];
  openBlocking: Finding[];
  fixes: AddressFix[];
  attempts: AddressAttempt[];
  failed: AddressFailedAttempt[];
  fixesPerRun: number;
  usage: Usage;
  costUSD?: number;
  wallMs: number;
  reasons: string[];
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
}
export type ReviewAddressResult = OpResult<ReviewAddressReport> & {
  report?: ReviewAddressReport;
};
export interface ReviewAddressDeps {
  drivers?: DriverFactory;
  git?: GhFn;
  gh?: GhFn;
  worktreeRegistry?: WorktreeRegistry;
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

/** SDK-first fix/disposition/re-review composition; kernel dispatch itself remains retry-free. */
export function makeReviewAddress(deps: ReviewAddressDeps = {}) {
  return async (input: ReviewAddressInput): Promise<ReviewAddressResult> => {
    const start = Date.now();
    const enclosingContext = currentJobContext();
    const ownershipAbort = new AbortController();
    const parent = AbortSignal.any(
      [enclosingContext?.signal, addressChildSignal(), ownershipAbort.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    );
    let addressLease: AddressLease | undefined;
    const journalDir = resolve(
      input.journalDir ?? resolve(input.repoRoot, '..', '.cq-address-runs', randomUUID()),
    );
    const report: ReviewAddressReport = {
      source: input.source,
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
    const bookkeeping = new Map<string, string>();
    let bookkeepingTampered = false;
    let bookkeepingRevision = 0;
    let persistedBookkeeping: ReturnType<typeof makeAddressBookkeepingReceipt> | undefined;
    const noteAdvisories = (record: FindingsRecord) => {
      if (record.advisories === undefined || record.advisories.length === 0) return;
      report.advisories = [...new Set([...(report.advisories ?? []), ...record.advisories])];
    };
    const noteBookkeeping = async (path: string) => {
      if (!addressLease) throw new Error('bookkeeping before ownership');
      const canonical = await realpath(path);
      const hash = await addressOwnedEvidence(addressLease, { kind: 'hash', path: canonical });
      bookkeeping.set(canonical, hash as string);
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
      if (parent?.aborted) {
        delete report.stop;
        if (!report.reasons.includes('parent cancelled')) report.reasons.push('parent cancelled');
        if (!addressLease) return { status: 'needs-human', reason: 'parent cancelled', report };
        if (worker) report.escalation = worker.escalation();
        return addressCancelledResult(addressLease);
      }
      if (!addressLease) {
        return withOwnership(async (lease) => {
          addressLease = lease;
          await bindAddressTerminalReport(lease, report);
          return finish(status, reason, structuredStop);
        });
      }
      if (reason) report.reasons.push(reason);
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
      // BEFORE the exit publication ran ("the loop pushed nothing … may
      // still happen at engine exit"); only the engine knows what its exit
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
        // run can never publish. The loop's stale "publication may still
        // happen at engine exit" claim would stand forever — replace it with
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
      try {
        if (parent?.aborted) return finish('needs-human', 'parent cancelled');
        if (addressLease) await addressLease.assertOwned();
        await mkdir(journalDir, { recursive: true });
        if (parent?.aborted) return finish('needs-human', 'parent cancelled');
        if (addressLease) await addressLease.assertOwned();
        if (!addressLease) throw new Error('report before ownership');
        await addressOwnedEvidence(addressLease, {
          kind: 'report',
          path: report.reportPath,
          report,
        });
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
    const withOwnership = async (action: (lease: AddressLease) => Promise<ReviewAddressResult>) => {
      let entered = false;
      try {
        return await withAddressOwnership(
          {
            repoRoot: input.repoRoot,
            git: deps.git ?? makeGhRunner({ bin: 'git', cwd: input.repoRoot, timeoutMs: 60_000 }),
            source: input.source,
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
        if (!entered && isAddressOwnershipAdmissionRefusal(cause)) {
          const { stop: _stop, ...observed } = report;
          return {
            status: 'needs-human' as const,
            reason: detail,
            report: {
              ...observed,
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
            ...observed,
            reasons: observed.reasons.includes(error)
              ? [...observed.reasons]
              : [...observed.reasons, error],
          },
        };
      }
    };
    try {
      if (parent?.aborted) return await finish('needs-human', 'parent cancelled');
      if (input.source !== 'local' && !/^pr:[1-9]\d*$/.test(input.source))
        return await finish('failed', 'source must be local or pr:<positive number>');
      let config = deps.config;
      if (!config) {
        const parsed = parseCqConfig(
          await readFile(resolve(input.repoRoot, 'cq.json'), 'utf8'),
          input.repoRoot,
        );
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
      const cap = Math.min(policy.budgets.run.wallMs, input.wallMs ?? Infinity);
      const remainingTokens = () =>
        policy.budgets.run.maxTokens! -
        report.usage.input -
        report.usage.output -
        report.usage.cacheRead -
        report.usage.cacheWrite -
        (report.usage.reasoning ?? 0);
      const remainingWallMs = () => cap - (Date.now() - start);
      const stop = () => {
        if (parent?.aborted) return 'parent cancelled';
        if (bookkeepingTampered) return 'engine bookkeeping changed; worker tree is dirty';
        if (remainingTokens() <= 0 || remainingWallMs() <= 0) {
          budgetSpent = true;
          return 'token or wall budget exhausted';
        }
        return undefined;
      };
      cleanStop = stop;
      const account = (result: WorkerResult, governed = true) => {
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const)
          report.usage[key] += result.usage[key];
        if (result.costUSD !== undefined) report.costUSD = (report.costUSD ?? 0) + result.costUSD;
        if (result.usage.reasoning !== undefined)
          report.usage.reasoning = (report.usage.reasoning ?? 0) + result.usage.reasoning;
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
                  resolved.driver.run(input, {
                    ...options,
                    signal: options?.signal ? AbortSignal.any([parent, options.signal]) : parent,
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
              run: async (...args) => {
                const stopped = stop();
                if (stopped) throw new Error(stopped);
                const result = await resolved.driver.run(...args);
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
      const rawGit =
        deps.git ??
        makeGhRunner({ bin: 'git', cwd: input.repoRoot, timeoutMs: Math.min(cap, 60_000) });
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
      // Ownership spans worker edits as well as index mutation, restoration and
      // publication. Linked worktrees share this conservative exclusion domain;
      // UUID journal paths and lexical checkout aliases cannot split it.
      return await withOwnership(async (lease) => {
        addressLease = lease;
        await bindAddressTerminalReport(lease, report);
        try {
          await lease.assertOwned();
          await mkdir(journalDir, { recursive: true });
          const bookkeepingKey = async (root: string, path: string) =>
            resolve(await realpath(root), path);
          const untrackedAllowed = async (root: string, path: string) => {
            const key = await bookkeepingKey(root, path);
            const expected = bookkeeping.get(key);
            if (!expected) return false;
            const unchanged =
              (await addressOwnedEvidence(lease, { kind: 'hash', path: key })) === expected;
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
            const folder = resolve(root, '.cq', 'review', encodeURIComponent(branch));
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
                if (!(await untrackedAllowed(root, path))) throw new Error('bookkeeping mismatch');
            } catch (error) {
              bookkeepingTampered = true;
              throw new Error('engine bookkeeping changed; worker tree is dirty', { cause: error });
            }
          };
          // Parallel PR workers share the ledger. Keep the fingerprint check,
          // engine write and replacement fingerprint in one composition-owned FIFO.
          let bookkeepingWrites: Promise<unknown> = Promise.resolve();
          const withBookkeepingAccess = <T>(root: string, action: () => Promise<T>): Promise<T> => {
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
              await addressOwnedEvidence(lease, {
                kind: 'bookkeeping',
                root,
                entries: [...bookkeeping],
              });
              return outcome.value;
            });
            bookkeepingWrites = pending.catch(() => undefined);
            return pending;
          };
          const reviewOnce = async (request: ReviewRunInput) => {
            let observed: Awaited<ReturnType<typeof reviewImplementation>> | undefined;
            try {
              return await withBookkeepingAccess(request.repoRoot, async () => {
                // Review.run legitimately appends to the same ledger. Check ownership
                // before its write, then register only that engine-produced revision.
                const result = await reviewImplementation(request);
                observed = result;
                if (!deps.review && result.status === 'ok')
                  await noteBookkeeping(devLedgerPath(request.repoRoot, result.value.branch));
                return result;
              });
            } catch (cause) {
              if (observed === undefined || observed.status === 'ok') throw cause;
              throw new Error(
                `${cause instanceof Error ? cause.message : 'review acknowledgement/persistence refused'}; observed review: ${issue(observed).slice(0, 2048)}`,
                { cause },
              );
            }
          };
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
            if (first.status !== 'needs-human' || first.report?.blockedTransient !== true || stop())
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
              dependencyRoot: input.repoRoot,
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
              remainingWallMs,
              account,
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
          let publishedBase: string | undefined;
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
            if (!publishedBase) throw new Error('publication baseline unavailable');
            const range = (await gitText(workerRoot, ['rev-list', `${publishedBase}..HEAD`]))
              .split('\n')
              .filter(Boolean);
            if (
              range.length === 0 ||
              range.some((sha) => !unpublished.has(sha)) ||
              [...unpublished].some((sha) => !range.includes(sha))
            )
              throw new Error('publication contains an unverified commit or changed ancestry');
            await gitText(workerRoot, ['merge-base', '--is-ancestor', publishedBase, 'HEAD']);
            if (!(await publicationTreeClean(workerRoot)))
              throw new Error('worker tree/index is dirty; verified commits retained');
            const branch = publishBranch ?? (await branchName(workerRoot));
            if (parent?.aborted) throw new Error('parent cancelled');
            await gitText(workerRoot, ['push', publishRemote, `HEAD:refs/heads/${branch}`]);
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
            publishedBase = await gitText(workerRoot, ['rev-parse', 'HEAD']);
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
              const context = await (
                deps.resolveDeferredVendorContext ?? resolveDeferredVendorContext
              )({
                repoRoot: root,
                target: input.target ?? 'merge-queue',
                base: reviewedBase,
                record,
                onEvidenceImported: (evidence) => noteQueueEvidence(root, evidence),
                ...(parent ? { signal: parent } : {}),
              });
              if (!deps.resolveDeferredVendorContext && context)
                await noteBookkeeping(devLedgerPath(root, record.branch));
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
          const admitCleanRecord = async (root: string, record: FindingsRecord) => {
            const effects = makeSubprocessDevEffects(root);
            const read = await readWorkState(effects, {
              target: input.target ?? 'merge-queue',
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
                target: input.target ?? 'merge-queue',
                ...(input.base
                  ? { base: input.base }
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
                  target: input.target ?? 'merge-queue',
                  base: state.base,
                  head: state.head,
                  dirtySha256: state.dirtySha256,
                  completion: { kind: 'terminal' },
                  findings: record.findings.map((finding) => ({
                    id: finding.id,
                    severity: finding.severity,
                    ...(finding.file !== undefined ? { fileName: finding.file } : {}),
                    ...(finding.line !== undefined ? { line: finding.line } : {}),
                    ...(finding.rule !== undefined ? { rule: finding.rule } : {}),
                    ...(finding.evidence !== undefined ? { evidence: finding.evidence } : {}),
                    ...(finding.evidenceV1 !== undefined ? { evidenceV1: finding.evidenceV1 } : {}),
                    excerpt: finding.text,
                  })),
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
          const recordDisposition = async (root: string, finding: Finding) => {
            try {
              return await withBookkeepingAccess(root, async () => {
                const recorded = deps.disposition
                  ? await deps.disposition(root, finding)
                  : await makeDevDisposition(makeSubprocessDevEffects(root))({
                      repoRoot: root,
                      findingId: finding.id,
                      action: finding.status as 'fixed' | 'rejected' | 'deferred',
                      why: finding.reason ?? 'engine validated fix',
                    });
                if (recorded.status !== 'ok') {
                  bookkeepingFailed = true;
                  report.reasons.push(`disposition ${finding.id}: ${issue(recorded)}`);
                  return false;
                }
                if (!deps.disposition) {
                  const branch = await branchName(root);
                  await noteBookkeeping(
                    await bookkeepingKey(root, relative(root, devLedgerPath(root, branch))),
                  );
                }
                dispositions.set(identity(finding), finding);
                return true;
              });
            } catch (error) {
              bookkeepingFailed = true;
              report.reasons.push(`disposition ${finding.id}: ${String(error)}`);
              return false;
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
          const dispatchFindings = async (root: string, record: FindingsRecord, round: number) => {
            rowsDispatchedAt.set(record.findings, {
              fixes: report.fixes.length,
              severities: policy.review.blockingSeverities,
            });
            if (
              new Set(record.findings.map((finding) => finding.id)).size !== record.findings.length
            )
              throw new Error('duplicate finding identity');
            await admitRecord(root, record);
            report.verifiedHead ??= record.head;
            publishedBase ??= await gitText(root, ['rev-parse', 'HEAD']);
            const unresolvedReason = 'unresolved: finding has no file path';
            const pathless = record.findings.filter(
              (finding) => finding.status === 'open' && finding.file === '',
            );
            for (const finding of pathless) finding.reason = unresolvedReason;
            noteRound(round, record);
            for (const batch of addressBatches(
              record.findings.filter((finding) => finding.status === 'open' && finding.file !== ''),
              policy.review.addressConcurrency,
            )) {
              if (stop()) return;
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
                    perJobWallClockMs: Math.min(policy.budgets.unit.wallMs, remainingWallMs()),
                  }),
                  ...(parent ? { signal: parent } : {}),
                  allowAdvisory: true,
                  allowAdvisoryProvenance: 'product',
                },
              );
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
                if (!(await recordDisposition(root, fix.finding))) fix.finding.status = 'open';
              }
              noteRound(round, record, run);
            }
            return pathless.length > 0 ? unresolvedReason : undefined;
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
            const name = (JSON.parse(repoResult.stdout) as { nameWithOwner: string }).nameWithOwner;
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
            // Publication receipts outlive run-specific reports. A changed target,
            // fork/branch or authenticated actor cannot borrow another run's log.
            // The loop still requires fetched authenticated current-head/round proof;
            // a stored receipt alone never authorizes resolution.
            const commonDir = await gitText(root, [
              'rev-parse',
              '--path-format=absolute',
              '--git-common-dir',
            ]);
            if (!commonDir) return await finish('needs-human', 'Git common directory unavailable');
            const namespace = createHash('sha256')
              .update(
                JSON.stringify([
                  owner.toLowerCase(),
                  repo.toLowerCase(),
                  pr,
                  input.target ?? 'merge-queue',
                  input.base ?? null,
                  prMetadata.headRepo!.toLowerCase(),
                  meta.headRefName,
                  prMetadata.login.toLowerCase(),
                ]),
              )
              .digest('hex');
            const receiptDir = resolve(root, commonDir, 'cq-review-address', namespace);
            await mkdir(receiptDir, { recursive: true });
            dispatchLogPath = resolve(receiptDir, 'dispatch.jsonl');
            bookkeepingReceiptPath = resolve(await realpath(receiptDir), 'bookkeeping.json');
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
              target: input.target ?? 'merge-queue',
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
                const target = input.target ?? 'merge-queue';
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
          for (let round = 1; round <= policy.review.rounds; round++) {
            const stopped = stop();
            if (stopped) return await finish('needs-human', stopped);
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
                    severity: 'major',
                    text: discussionText(item.item.body, item.item.comments),
                    status: 'open',
                  };
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
                  const dispositionRecorded = await recordDisposition(root, fix.finding);
                  if (!dispositionRecorded) fix.finding.status = 'open';
                  remember(fix);
                  fixesById.set(finding.id, fix);
                  if (!dispositionRecorded)
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
                    return { status: 'needs-human', reason: `${NO_OUTCOME_REASON}: ${fix.reason}` };
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
              const loop = await runAddressReviewLoop(lease, {
                owner: meta.owner,
                repo: meta.repo,
                pr: meta.pr,
                headRefName: meta.headRefName,
                ...(meta.headRepo ? { headRepo: meta.headRepo } : {}),
                repoRoot: input.repoRoot,
                gh,
                git,
                registry:
                  deps.worktreeRegistry ??
                  lease.registry ??
                  fileWorktreeRegistry(resolve(journalDir, 'worktrees.json')),
                ...(lease.expectedHead ? { expectedHead: lease.expectedHead } : {}),
                beforeWorktreeResolve: () =>
                  lease.assertSelection({
                    pr: meta.pr,
                    headRepo: meta.headRepo ?? `${meta.owner}/${meta.repo}`,
                    headRefName: meta.headRefName,
                  }),
                onWorktreeResolved: async (info) =>
                  lease.claimCheckout({
                    ...info,
                    head: await gitText(info.path, ['rev-parse', 'HEAD']),
                  }),
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
                onFixRunSettled: (run) => {
                  // Retain the settled run before later Git/forge work can throw.
                  // An initial refusal has no admitted work to record; a refused
                  // sibling must not erase the history of earlier admitted work.
                  if (!dispatchedRecord || dispatchedFindings.length === 0) return;
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
                  if (!persistedBookkeeping) return false;
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
              root = loop.worktree.path;
              workerRoot = root;
              publishBranch = meta.headRefName;
              if (input.push && loop.status === 'ok') {
                unpublished.clear();
                publishedBase = await gitText(root, ['rev-parse', 'HEAD']);
              }
              if (loop.status !== 'ok') report.reasons.push(...loop.reasons);
              if (admissionRefused)
                return await finish(
                  'needs-human',
                  'PR worker admission refused; persisted/caller bytes retained',
                );
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
                  const parsed: unknown = JSON.parse(await readFile(pendingRerequestPath, 'utf8'));
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
              if ((await branchName(root)) !== loop.worktree.branch)
                return await finish('needs-human', 'PR worker branch changed');
              const currentHead = await gitText(root, ['rev-parse', 'HEAD']);
              const rejectionReasons = new Map<string, string>();
              const ledger = makeSubprocessDevEffects(root).openLedger(loop.worktree.branch).load();
              for (const thread of fetched.threads) {
                const proof = loopReplyVerdict(thread, {
                  signature: replySignature(meta.owner, meta.repo, meta.pr),
                  headSha: currentHead,
                  ownLogin: meta.login,
                  requireCurrentIdentity: true,
                });
                const latest = ledger.records
                  .filter((entry) => entry.kind === 'disposition' && entry.findingId === thread.id)
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
                    severity: 'major',
                    status: rejectionReasons.has(thread.id) ? 'rejected' : 'open',
                    ...(rejectionReasons.has(thread.id)
                      ? { reason: rejectionReasons.get(thread.id)! }
                      : {}),
                  })),
              };
              report.findings = retainDeferred(threads).findings;
              noteAdvisories(threads);
              report.openBlocking = openBlocking(
                { ...threads, findings: report.findings },
                policy.review.blockingSeverities,
              );
              if (stop()) return await finish('needs-human', stop());
              const priorFindings = priorRoundFindings(previous, [
                ...threads.findings,
                ...[...fixesById.values()].map((fix) => fix.finding),
              ]);
              const agent = await review({
                repoRoot: root,
                target: input.target ?? 'merge-queue',
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
                return await finish(
                  'needs-human',
                  `PR re-review: ${issue(agent)}`,
                  rereviewStop(agent),
                );
              }
              if (agent.value.branch !== threads.branch || agent.value.head !== threads.head)
                return await finish('needs-human', 'PR re-review identity changed');
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
              const unresolved = await dispatchFindings(root, retainDeferred(agent.value), round);
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
                  const folder = resolve(root, '.cq', 'review', encodeURIComponent(branch));
                  const files = (await readdir(folder))
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
            }
            report.findings = previous.findings;
            noteAdvisories(previous);
            report.openBlocking = openBlocking(previous, policy.review.blockingSeverities);
            if (!(await hasRequiredSources(root, previous)))
              return await finish('needs-human', 'review source incomplete');
            if (stop()) return await finish('needs-human', stop());
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
              target: input.target ?? 'merge-queue',
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
              return await finish(
                'needs-human',
                `re-review: ${issue(refreshed)}`,
                rereviewStop(refreshed),
              );
            }
            if (
              refreshedRecord.branch !== (await branchName(root)) ||
              refreshedRecord.head !== (await gitText(root, ['rev-parse', 'HEAD']))
            )
              return await finish('needs-human', 're-review identity changed');
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
    } catch (error) {
      return await finish('needs-human', error instanceof Error ? error.message : String(error));
    }
  };
}
