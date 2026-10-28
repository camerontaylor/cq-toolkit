import { isDeepStrictEqual } from 'node:util';
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DriverFactory } from '../../driver/factory.js';
import type { OpResult } from '../../kernel/types.js';
import { parseCqConfig } from '../analyze/cqConfig.js';
import { resolveCqConfigDefaults, requireAgenticTokenBudget } from '../analyze/cqConfigDefaults.js';
import {
  makeDevReview,
  renderAgentReviewEvidence,
  verifyAgentReviewCoverage,
} from '../dev/review.js';
import { makeSubprocessDevEffects } from '../dev/effects.js';
import type { DevEffects } from '../dev/effects.js';
import type { DiffSecretScanner } from '../dev/denylist.js';
import {
  prepareDeferredVendorReview,
  retainedReceiptFindings,
  loadCurrentDeferredVendorDebt,
  readCurrentEnrollment,
} from '../dev/internal/deferredLedger.js';
import {
  hasDeferredReviewSources,
  verifiedCompletedDebt,
  deferredReceiptFindings,
  type DeferredVendorDebt,
} from '../dev/internal/deferredReview.js';
import type { DeferredQueueClient } from './internal/queueProtocol.js';
import { DEV_LEDGER_VERSION, type DevCycleRecord, type DevLedgerFile } from '../dev/record.js';
import {
  makeGitleaksDefaultsScanner,
  makeRepoDiffScanner,
  composeScanners,
} from '../dev/denylist.js';
import { currentJobContext } from '../../kernel/governor.js';
import { startFixerDeadline } from '../sweep/internal/fixerBudget.js';
import { CLEAN_TREE, driftSince, readWorkState } from '../dev/internal/workState.js';
import { HARDENED_DIFF_FLAGS } from '../../shared/gitHarden.js';
import { runAgentReviewer } from './agentReviewer.js';
import { ReviewCoverageV2Schema } from './internal/reviewCoverageV2.js';
import {
  FindingsRecordSchema,
  isComplete,
  merge,
  type Finding,
  type FindingsRecord,
  type ReviewSource,
} from './findings.js';
import { ReviewCoverageSchema } from './internal/reviewPartitions.js';
import { collectBoundedReviewContext } from './internal/reviewContext.js';

export interface ReviewRunInput {
  repoRoot: string;
  uncommitted?: boolean;
  target?: string;
  base?: string;
  maxTokens?: number;
  wallMs?: number;
  reviewers?: ('agent' | 'coderabbit')[];
  /**
   * Previous-round findings for an internal address round. The engine sees
   * them only when `review.reReview.includePriorFindings` is true; the
   * reviewed base and scope stay the whole branch.
   */
  priorFindings?: readonly Finding[];
}
export interface ReviewRunDeps {
  drivers: DriverFactory;
  queueClient?: DeferredQueueClient;
  onEvidenceImported?: (evidence: { receiptId: string; path: string }) => Promise<void>;
  /** Abortable CodeRabbit backoff, injected by deterministic tests. */
  sleep?: import('../dev/review.js').DevReviewDeps['sleep'];
  /** Injection seam for the engine; production binds {@link runAgentReviewer}. */
  runAgentReviewer?: typeof runAgentReviewer;
  parentSignal?: AbortSignal;
  effectsFactory?: (repoRoot: string) => DevEffects;
  writeFindingsRecord?: (path: string, content: string) => Promise<void>;
  /**
   * Observe a completed engine-owned ledger write inside this run, so the
   * caller can register the new bytes even when the review outcome is
   * blocked/failed (the write itself already succeeded under its own mutex).
   */
  noteLedgerWrite?: (branch: string, repoRoot: string) => Promise<void>;
  scannerFactory?: (
    repoRoot: string,
    effects: DevEffects,
    patternsFile?: string,
  ) => DiffSecretScanner;
}

/** A blocked run still exposes the persisted record so consumers can surface advisories. */
/**
 * The blocked result's report may carry `blockedTransient` (#509): every
 * blocked source stopped on the network/transient class, so a caller may
 * retry the review once. `blockedBudget` requires every blocked source to
 * have stopped on the engine's budget and no repository drift or parent cancel.
 * Both ride the report envelope and are never persisted.
 */
export type ReviewRunResult = OpResult<FindingsRecord> & {
  report?: FindingsRecord & {
    blockedTransient?: true;
    blockedBudget?: true;
    deferredVendorDebt?: DeferredVendorDebt;
  };
};

function blocked(kind: ReviewSource['kind'], reason: string, cycleId?: string): FindingsRecord {
  return {
    schemaVersion: 1,
    branch: '',
    head: '',
    sources: [{ kind, status: 'blocked', reason, ...(cycleId ? { cycleId } : {}) }],
    findings: [],
  };
}

/** Produce a single normalized record from the configured sources. */
export function makeReviewRun(
  deps: ReviewRunDeps,
): (input: ReviewRunInput) => Promise<ReviewRunResult> {
  return async (input): Promise<ReviewRunResult> => {
    const runReview = deps.runAgentReviewer ?? runAgentReviewer;
    const started = Date.now();
    const effects =
      deps.effectsFactory?.(input.repoRoot) ?? makeSubprocessDevEffects(input.repoRoot);
    const configText = await readFile(join(input.repoRoot, 'cq.json'), 'utf8').catch(() => null);
    if (configText === null)
      return { status: 'needs-human', reason: 'review.run: cq.json is required' };
    const parsedConfig = parseCqConfig(configText, input.repoRoot);
    if (!parsedConfig.ok)
      return { status: 'needs-human', reason: `review.run: ${parsedConfig.reason}` };
    const packageText = await readFile(join(input.repoRoot, 'package.json'), 'utf8').catch(
      () => '{}',
    );
    let packageName = 'repository';
    try {
      const value: unknown = JSON.parse(packageText);
      if (
        typeof value === 'object' &&
        value !== null &&
        'name' in value &&
        typeof value.name === 'string'
      )
        packageName = value.name;
    } catch {
      /* fallback is descriptive only */
    }
    const policy = resolveCqConfigDefaults(parsedConfig.config, {
      packageName,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.reviewers === undefined ? {} : { review: { reviewers: input.reviewers } }),
    });
    const wallMs = Math.min(policy.budgets.run.wallMs, input.wallMs ?? Infinity);
    const parent = deps.parentSignal ?? currentJobContext()?.signal;
    const deadline = startFixerDeadline(parent, Math.max(0, wallMs - (Date.now() - started)));
    const remainingWallMs = () => wallMs - (Date.now() - started);
    try {
      const target = input.target ?? 'merge-queue';
      const read = await readWorkState(effects, {
        target,
        ...(input.base ? { base: input.base } : {}),
      });
      if (!read.ok) return { status: 'needs-human', reason: `review.run: ${read.reason}` };
      const { state } = read;
      const scanner =
        deps.scannerFactory?.(input.repoRoot, effects, policy.review.denylistPatternsFile) ??
        (policy.review.denylistPatternsFile === undefined
          ? composeScanners(makeGitleaksDefaultsScanner(effects))
          : composeScanners(
              makeGitleaksDefaultsScanner(effects),
              makeRepoDiffScanner(input.repoRoot, policy.review.denylistPatternsFile),
            ));
      const coderabbitConfigured = policy.review.reviewers.includes('coderabbit');
      const agentConfigured = policy.review.reviewers.includes('agent');
      const records: FindingsRecord[] = [];
      // #509: the sources whose block was the network/transient class.
      const transientBlocks = new Set<ReviewSource['kind']>();
      const budgetBlocks = new Set<ReviewSource['kind']>();
      const budgetStopped = () =>
        !parent?.aborted && (deadline.expired() || remainingWallMs() <= 0);
      let deferredVendorDebt: DeferredVendorDebt | undefined;
      const prepareDebt = async () => {
        const before = structuredClone(effects.openLedger(state.branch).load());
        // Correlate durable bytes with the mutation this invocation requested,
        // including an enrollment whose status read later fails; never bless
        // bytes the engine did not request — external appends stay unowned and
        // fail closed at the address bookkeeping fingerprint check.
        let requestedLedger: DevLedgerFile | undefined;
        let provisionalLedger: DevLedgerFile | undefined;
        let debt: DeferredVendorDebt | undefined;
        let failure: { thrown: boolean; error: unknown } | undefined;
        try {
          debt = await prepareDeferredVendorReview(
            {
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
                        // Promote only once the store durably accepted the
                        // requested state; a capture that never successfully
                        // persisted must never own the notification.
                        requestedLedger = provisionalLedger;
                        return result;
                      }),
                };
              },
            },
            target,
            state,
            deps.queueClient,
            deadline.signal,
            {
              remainingMs: remainingWallMs,
              ...(deps.onEvidenceImported ? { onEvidenceImported: deps.onEvidenceImported } : {}),
            },
          );
        } catch (error) {
          failure = { thrown: true, error };
        }
        // Ownership settlement for both outcomes: durable bytes are owned only
        // when they exactly equal the engine-requested, successfully persisted
        // mutation. Unowned changed bytes never reach the ownership callback;
        // on a preparation failure the original error propagates and the
        // enclosing address bookkeeping fingerprint check fails closed.
        const after = effects.openLedger(state.branch).load();
        if (!isDeepStrictEqual(before, after)) {
          if (requestedLedger !== undefined && isDeepStrictEqual(requestedLedger, after))
            await deps.noteLedgerWrite?.(state.branch, input.repoRoot);
          else if (!failure)
            throw new Error('deferred preparation changed unrecognized ledger bytes');
        }
        if (failure) throw failure.error;
        if (debt) {
          if (
            input.uncommitted ||
            !agentConfigured ||
            policy.review.reviewers.some((source) => source !== 'agent' && source !== 'coderabbit')
          )
            throw new Error(
              'deferred vendor review requires full coverage of every configured nonvendor source',
            );
        }
        return debt;
      };
      if (coderabbitConfigured && agentConfigured) {
        try {
          deferredVendorDebt = await prepareDebt();
        } catch (error) {
          return {
            status: 'indeterminate',
            detail: `review.run: deferred vendor trust/enrollment failed — ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      // Retained receipt findings are obligations, not a current review source.
      // Include them even when settling an old head requires a fresh vendor run.
      const retainedLedger = effects.openLedger(state.branch).load();
      const retainedFindings = retainedReceiptFindings(retainedLedger);
      if (retainedFindings.length > 0)
        records.push({
          schemaVersion: 1,
          branch: state.branch,
          head: state.head,
          sources: [],
          findings: retainedFindings,
        });
      if (deferredVendorDebt) {
        const ledger = retainedLedger;
        const dispositions = new Map(
          ledger.records
            .filter((entry) => entry.kind === 'disposition')
            .map((entry) => [entry.findingId, entry]),
        );
        records.push({
          schemaVersion: 1,
          branch: state.branch,
          head: state.head,
          sources: [
            {
              kind: 'coderabbit',
              status: 'blocked',
              cycleId: deferredVendorDebt.originAttempt.cycleId,
              reason: deferredVendorDebt.vendorCompleted
                ? 'verified affected-current vendor completion; full-branch coverage remains agent evidence'
                : 'vendor review remains outstanding under durable deferred debt',
            },
          ],
          findings: [
            ...ledger.records
              .filter(
                (entry): entry is DevCycleRecord =>
                  entry.kind === 'cycle' && entry.reviewer === 'coderabbit',
              )
              .flatMap((entry) =>
                entry.findings.map((finding): Finding => {
                  const disposition = dispositions.get(finding.id);
                  return {
                    id: finding.id,
                    source: 'coderabbit',
                    severity: finding.severity,
                    text: finding.excerpt ?? '',
                    ...(finding.fileName ? { file: finding.fileName } : {}),
                    status: disposition?.action ?? 'open',
                    ...(disposition ? { reason: disposition.why } : {}),
                  };
                }),
              ),
          ],
        });
      }
      if (coderabbitConfigured && !deferredVendorDebt) {
        const result = await makeDevReview({
          effects,
          ...(deadline.signal ? { signal: deadline.signal } : {}),
          remainingWallMs,
          ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
          scanSecrets: scanner,
          ...(policy.review.denylistPatternsFile === undefined
            ? {}
            : { patternsFile: policy.review.denylistPatternsFile }),
        })({
          repoRoot: input.repoRoot,
          reviewer: 'coderabbit',
          target,
          base: state.base,
          ...(input.uncommitted === undefined ? {} : { uncommitted: input.uncommitted }),
        });
        if (result.status === 'ok') {
          const value = result.value as {
            cycleId: string;
            findings: Array<{ id: string; severity: string; fileName?: string; excerpt?: string }>;
          };
          records.push({
            schemaVersion: 1,
            branch: state.branch,
            head: state.head,
            sources: [{ kind: 'coderabbit', status: 'terminal', cycleId: value.cycleId }],
            findings: value.findings.map((item) => ({
              id: item.id,
              source: 'coderabbit',
              ...(item.fileName ? { file: item.fileName } : {}),
              severity: item.severity,
              text: item.excerpt ?? '',
              status: 'open',
            })),
          });
        } else {
          const reason =
            result.status === 'needs-human'
              ? result.reason
              : result.status === 'failed'
                ? result.error
                : result.status === 'indeterminate'
                  ? result.detail
                  : `CodeRabbit cycle did not produce a terminal record (${result.status})`;
          if ((result as { report?: { transient?: boolean } }).report?.transient === true)
            transientBlocks.add('coderabbit');
          if (
            (result as { report?: { budgetStopped?: boolean } }).report?.budgetStopped === true &&
            budgetStopped()
          )
            budgetBlocks.add('coderabbit');
          const cycleId = /review cycle (c\d+-[a-f0-9]+)/.exec(reason)?.[1];
          let cycle: DevCycleRecord | undefined;
          if (cycleId !== undefined) {
            try {
              cycle = effects
                .openLedger(state.branch)
                .load()
                .records.find(
                  (entry): entry is DevCycleRecord =>
                    entry.kind === 'cycle' &&
                    entry.cycleId === cycleId &&
                    entry.reviewer === 'coderabbit',
                );
            } catch (error) {
              return {
                status: 'indeterminate',
                detail: `review.run: blocked CodeRabbit cycle ${cycleId} was recorded but its findings could not be read — ${error instanceof Error ? error.message : String(error)}`,
              };
            }
            // The blocked cycle's ledger bytes were still written by the
            // engine: let the caller register them before the refusal.
            try {
              await deps.noteLedgerWrite?.(state.branch, input.repoRoot);
            } catch {
              /* the review outcome below carries the block reason */
            }
          }
          records.push({
            schemaVersion: 1,
            branch: state.branch,
            head: state.head,
            sources: [
              {
                kind: 'coderabbit',
                status: 'blocked',
                reason,
                ...(cycle?.kind === 'cycle' ? { cycleId: cycle.cycleId } : {}),
              },
            ],
            findings:
              cycle?.kind === 'cycle'
                ? cycle.findings.map((item) => ({
                    id: item.id,
                    source: 'coderabbit',
                    ...(item.fileName ? { file: item.fileName } : {}),
                    severity: item.severity,
                    text: item.excerpt ?? '',
                    status: 'open' as const,
                  }))
                : [],
          });
          if (cycle?.vendorFailure && agentConfigured) {
            try {
              deferredVendorDebt = await prepareDebt();
            } catch (error) {
              return {
                status: 'needs-human',
                reason: `review.run: vendor failure retained but durable queue enrollment failed — ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          }
        }
      }
      if (agentConfigured && (deadline.signal?.aborted || remainingWallMs() <= 0)) {
        records.push(blocked('agent', 'review cancelled or wall budget exhausted'));
        if (budgetStopped()) budgetBlocks.add('agent');
      } else if (agentConfigured) {
        const budgetStop = requireAgenticTokenBudget(policy);
        if (budgetStop !== undefined) records.push(blocked('agent', budgetStop.reason));
        else {
          const comparison = input.uncommitted ? 'HEAD' : state.base;
          let listing;
          try {
            listing = await effects.runCommand(
              'git',
              ['diff', '--name-only', '-z', ...HARDENED_DIFF_FLAGS, comparison],
              {
                timeoutMs: Math.max(1, Math.min(60_000, remainingWallMs())),
                ...(deadline.signal ? { signal: deadline.signal } : {}),
              },
            );
          } catch (error) {
            return {
              status: 'failed',
              error: `review.run: could not collect review diff — ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          if (listing.exitCode !== 0)
            records.push(
              blocked(
                'agent',
                `could not list review diff paths (exit ${String(listing.exitCode)})`,
              ),
            );
          else {
            const context = await collectBoundedReviewContext(
              effects,
              comparison,
              state.head,
              input.uncommitted ? 'uncommitted' : 'full',
              { ...(deadline.signal ? { signal: deadline.signal } : {}), remainingWallMs },
            );
            if (!context.ok && context.fatal)
              return { status: 'failed', error: `review.run: ${context.reason}` };
            if (!context.ok) {
              records.push(blocked('agent', context.reason));
            } else {
              const components: { component: string; path: string; text: string }[] = [];
              let collectionFailure: string | undefined;
              for (const path of listing.stdout.split('\0').filter(Boolean)) {
                let patch;
                try {
                  patch = await effects.runCommand(
                    'git',
                    ['diff', ...HARDENED_DIFF_FLAGS, comparison, '--', path],
                    {
                      timeoutMs: Math.max(1, Math.min(60_000, remainingWallMs())),
                      ...(deadline.signal ? { signal: deadline.signal } : {}),
                    },
                  );
                } catch (error) {
                  return {
                    status: 'failed',
                    error: `review.run: could not collect diff for '${path}' — ${error instanceof Error ? error.message : String(error)}`,
                  };
                }
                if (patch.exitCode !== 0) {
                  collectionFailure = `could not collect diff for '${path}' (exit ${String(patch.exitCode)})`;
                  break;
                }
                components.push({ component: `tracked:${path}`, path, text: patch.stdout });
              }
              if (collectionFailure !== undefined) {
                records.push(blocked('agent', collectionFailure));
              } else {
                for (const path of state.untracked) {
                  let content: Awaited<ReturnType<DevEffects['readWorktreeFile']>>;
                  try {
                    content = await effects.readWorktreeFile(path, 4 * 1024 * 1024);
                  } catch (error) {
                    return {
                      status: 'failed',
                      error: `review.run: could not read untracked file '${path}' for scanning — ${error instanceof Error ? error.message : String(error)}`,
                    };
                  }
                  if (!content.ok)
                    return {
                      status: 'needs-human',
                      reason: `review.run: untracked file '${path}' cannot be scanned — ${content.reason}`,
                    };
                  components.push({ component: `untracked:${path}`, path, text: content.text });
                }
                let check;
                try {
                  check = await scanner(components);
                } catch (error) {
                  return {
                    status: 'needs-human',
                    reason: `review.run: denylist scan failed closed — ${error instanceof Error ? error.message : String(error)}`,
                  };
                }
                if (check.some((scan) => scan.hits.length > 0))
                  return {
                    status: 'needs-human',
                    reason:
                      'review.run: denylist scan found protected content; refusing reviewer upload',
                  };
                const current = await readWorkState(effects, {
                  target,
                  ...(input.base ? { base: input.base } : {}),
                });
                if (
                  !current.ok ||
                  current.state.base !== state.base ||
                  current.state.head !== state.head ||
                  current.state.dirtySha256 !== state.dirtySha256
                ) {
                  return {
                    status: 'needs-human',
                    reason:
                      'review.run: repository state changed after the scan; retry on a stable tree',
                  };
                }
                const role = policy.roles.reviewer;
                if (role === undefined) {
                  records.push(
                    blocked('agent', 'cq.json roles.reviewer is required for an agent review'),
                  );
                } else {
                  const reviewedBase = input.uncommitted ? state.head : state.base;
                  const reviewedScope = input.uncommitted
                    ? ('uncommitted' as const)
                    : ('full' as const);
                  const agent = await runReview(deps.drivers, {
                    repoRoot: input.repoRoot,
                    head: state.head,
                    branch: state.branch,
                    diff: components
                      .map((component) => `--- ${component.path} ---\n${component.text}`)
                      .join('\n'),
                    components,
                    base: reviewedBase,
                    scope: reviewedScope,
                    intent: context.context.intent,
                    fileList: context.context.fileList,
                    searchTools: policy.review.searchTools,
                    logToolFailures: policy.harness.logToolFailures,
                    session: policy.review.session,
                    size: policy.review.size,
                    exclude: policy.review.exclude,
                    ...(policy.review.reReview.includePriorFindings &&
                    input.priorFindings !== undefined
                      ? { priorFindings: input.priorFindings }
                      : {}),
                    scanSecrets: scanner,
                    role,
                    maxTokens: policy.budgets.run.maxTokens!,
                    wallMs: Math.max(1, remainingWallMs()),
                    stepWallMs: Math.max(
                      1,
                      Math.min(policy.budgets.step.wallMs, remainingWallMs()),
                    ),
                    ...(deadline.signal ? { signal: deadline.signal } : {}),
                    severityMap: policy.review.agentSeverityMap,
                  });
                  let blockedReason =
                    agent.status === 'needs-human'
                      ? agent.reason
                      : agent.status === 'failed'
                        ? agent.error
                        : agent.status === 'ok'
                          ? undefined
                          : `agent review did not complete (${agent.status})`;
                  if ((await driftSince(effects, state)).length > 0)
                    blockedReason = 'repository state changed during agent review';
                  else {
                    if (agent.status === 'needs-human' && agent.report?.transient === true)
                      transientBlocks.add('agent');
                    if (
                      agent.status === 'budget-exhausted' ||
                      agent.report?.budgetExhausted === true ||
                      (agent.report?.cancelled === true && budgetStopped())
                    )
                      budgetBlocks.add('agent');
                  }
                  const at = effects.nowIso();
                  const report = agent.status === 'ok' ? agent.value : agent.report;
                  const coverage = verifyAgentReviewCoverage(report?.coverage, {
                    head: state.head,
                    base: reviewedBase,
                    scope: reviewedScope,
                  });
                  if (blockedReason === undefined && !coverage.ok)
                    blockedReason = `agent review returned no verifiable coverage proof — ${coverage.reason}`;
                  if (
                    blockedReason === undefined &&
                    (deadline.signal?.aborted || remainingWallMs() <= 0)
                  )
                    blockedReason = 'review cancelled or wall budget exhausted';
                  const agentFindings = report?.findings ?? [];
                  const advisories = report?.advisories ?? [];
                  const failureEvidence = ReviewCoverageV2Schema.safeParse(report?.coverage);
                  let logPath: string;
                  try {
                    logPath = await effects.writeReviewLog(
                      state.branch,
                      `agent-${Date.now()}`,
                      [
                        'agent reviewer: reviewer',
                        `head: ${state.head}`,
                        `completion: ${blockedReason === undefined ? 'terminal' : `blocked — ${blockedReason}`}`,
                        `findings: ${String(agentFindings.length)}`,
                        ...renderAgentReviewEvidence(report),
                        `usage: ${String(report?.usage ?? 0)}`,
                        `tool failures: ${failureEvidence.success ? String(failureEvidence.data.sessions.reduce((sum, session) => sum + (session.toolFailures ?? 0), 0)) : 'unavailable'}`,
                        '',
                      ].join('\n'),
                    );
                  } catch (error) {
                    return {
                      status: 'indeterminate',
                      detail: `review.run: agent review attempt was dispatched but its log outcome is uncertain — ${error instanceof Error ? error.message : String(error)}`,
                    };
                  }
                  let cycleId: string;
                  try {
                    cycleId = await effects.openLedger(state.branch).mutate((ledger) => {
                      const count = ledger.records.filter((entry) => entry.kind === 'cycle').length;
                      const id = `c${String(count + 1).padStart(3, '0')}-${state.head.slice(0, 8)}`;
                      const entry: DevCycleRecord = {
                        kind: 'cycle',
                        cycleId: id,
                        reviewer: 'agent:reviewer',
                        scope: input.uncommitted ? 'uncommitted' : 'full',
                        target,
                        base: state.base,
                        head: state.head,
                        dirtySha256: state.dirtySha256,
                        completion:
                          blockedReason === undefined
                            ? { kind: 'terminal' }
                            : { kind: 'blocked', reason: blockedReason },
                        ...(blockedReason === undefined && coverage.ok
                          ? { agentCoverage: coverage.coverage }
                          : {}),
                        findings: agentFindings.map((finding, index) => ({
                          id: `${id}#f${String(index + 1)}`,
                          severity: finding.severity,
                          ...(finding.file ? { fileName: finding.file } : {}),
                          excerpt: finding.text,
                        })),
                        ...(advisories.length > 0 ? { advisories } : {}),
                        logPath,
                        untracked: state.untracked,
                        at,
                      };
                      return {
                        ledger: {
                          version: DEV_LEDGER_VERSION,
                          branch: ledger.branch,
                          records: [...ledger.records, entry],
                        },
                        value: id,
                      };
                    });
                    await deps.noteLedgerWrite?.(state.branch, input.repoRoot);
                  } catch (error) {
                    return {
                      status: 'indeterminate',
                      detail: `review.run: agent review attempt was dispatched but its dev ledger outcome is uncertain — ${error instanceof Error ? error.message : String(error)}`,
                    };
                  }
                  // One identity for the report and the ledger: blocked partial
                  // findings must use the exact cycle ids the ledger recorded.
                  const cycleFindings = agentFindings.map((finding, index) => ({
                    ...finding,
                    id: `${cycleId}#f${String(index + 1)}`,
                  }));
                  if (agent.status === 'ok' && blockedReason === undefined) {
                    records.push({
                      schemaVersion: 1,
                      branch: state.branch,
                      head: state.head,
                      sources: [
                        {
                          kind: 'agent',
                          status: 'terminal',
                          cycleId,
                          coverage: coverage.ok ? coverage.coverage : agent.value.coverage,
                        },
                      ],
                      findings: cycleFindings,
                      ...(advisories.length > 0 ? { advisories } : {}),
                    });
                  } else {
                    const partial = blocked(
                      'agent',
                      blockedReason ?? 'agent review did not complete',
                      cycleId,
                    );
                    partial.findings = cycleFindings;
                    if (report) {
                      // A malformed coverage object must not invalidate the
                      // blocked findings record. Valid incomplete v2 (and
                      // legacy v1) evidence is still preserved.
                      if (ReviewCoverageSchema.safeParse(report.coverage).success)
                        partial.sources[0]!.coverage = report.coverage;
                    }
                    if (advisories.length > 0) partial.advisories = advisories;
                    records.push(partial);
                  }
                }
              }
            }
          }
        }
      }
      const stopped = () => deadline.signal?.aborted || remainingWallMs() <= 0;
      if (stopped()) {
        for (const item of records)
          item.sources = item.sources.map((source) => {
            // Do not erase a prior auth/coverage/scan/etc refusal with the clock.
            if (source.status !== 'terminal') return source;
            if (budgetStopped()) budgetBlocks.add(source.kind);
            return {
              ...source,
              status: 'blocked',
              reason: 'review cancelled or wall budget exhausted',
            };
          });
      }
      // A full review can see uncommitted repairs. Restoring those bytes later
      // must not turn that review into clean proof about the unchanged HEAD.
      const reusableCleanProof =
        !stopped() &&
        state.dirtySha256 === CLEAN_TREE &&
        (await driftSince(effects, state)).length === 0;
      const boundRecords = records.map((record) => ({
        ...record,
        ...(reusableCleanProof
          ? {
              reviewed: {
                base: input.uncommitted ? state.head : state.base,
                scope: input.uncommitted ? ('uncommitted' as const) : ('full' as const),
              },
            }
          : {}),
        branch: record.branch || state.branch,
        head: record.head || state.head,
      }));
      let record: FindingsRecord;
      try {
        record = FindingsRecordSchema.parse(merge(boundRecords));
      } catch (error) {
        return {
          status: 'failed',
          error: `review.run: normalized findings record failed validation — ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const folder = join(input.repoRoot, '.cq', 'review', encodeURIComponent(state.branch));
      let names: string[];
      try {
        await mkdir(folder, { recursive: true });
        names = await readdir(folder);
      } catch (error) {
        return {
          status: 'failed',
          error: `review.run: could not prepare findings record storage — ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const indexes = names
        .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
        .filter((value): value is string => value !== undefined)
        .map(Number);
      const next = Math.max(0, ...indexes) + 1;
      const path = join(folder, `${next}.json`);
      try {
        const content = `${JSON.stringify(record, null, 2)}\n`;
        if (deps.writeFindingsRecord !== undefined) await deps.writeFindingsRecord(path, content);
        else await writeFile(path, content, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        return {
          status: 'indeterminate',
          detail: `review.run: findings record write outcome is uncertain at '${path}' — ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      let deferredComplete = false;
      if (deferredVendorDebt && !stopped()) {
        try {
          const beforeRefresh = structuredClone(effects.openLedger(state.branch).load());
          // Correlate durable bytes with this loader's mutation, including a
          // successful write whose return fails; never bless an external append.
          let requestedLedger: DevLedgerFile | undefined;
          const refreshed = await loadCurrentDeferredVendorDebt(
            {
              ...effects,
              openLedger: (branch) => {
                const store = effects.openLedger(branch);
                return {
                  ...store,
                  mutate: (update) =>
                    store.mutate((latest) => {
                      const change = update(latest);
                      requestedLedger = structuredClone(change.ledger);
                      return change;
                    }),
                };
              },
            },
            target,
            state,
            beforeRefresh,
            deps.queueClient,
            deadline.signal,
            {
              remainingMs: remainingWallMs,
              ...(deps.onEvidenceImported ? { onEvidenceImported: deps.onEvidenceImported } : {}),
            },
          ).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          const afterRefresh = effects.openLedger(state.branch).load();
          if (!isDeepStrictEqual(beforeRefresh, afterRefresh)) {
            // This refresh may settle the current enrollment AND its authorized ancestors, so the
            // owned shape is an append-only extension in which every added snapshot is a verified
            // completion of the current enrollment or of one of its authorized ancestors. Any other
            // extra byte still fails closed.
            const authority = readCurrentEnrollment(
              beforeRefresh,
              { head: state.head, base: state.base, dirtySha256: state.dirtySha256 },
              target,
            );
            const authorized = new Set<string>([deferredVendorDebt.reference.requestId]);
            if (authority.kind === 'enrollment')
              for (const ancestor of authority.enrollment.ancestry)
                authorized.add(ancestor.reference.requestId);
            const appended = afterRefresh.records.slice(beforeRefresh.records.length);
            if (
              !requestedLedger ||
              !isDeepStrictEqual(requestedLedger, afterRefresh) ||
              !isDeepStrictEqual(
                afterRefresh.records.slice(0, beforeRefresh.records.length),
                beforeRefresh.records,
              ) ||
              appended.length === 0 ||
              appended.some(
                (record) =>
                  record.kind !== 'vendor-debt' ||
                  !verifiedCompletedDebt(record.debt) ||
                  !authorized.has(record.debt.reference.requestId),
              )
            )
              throw new Error('final queue refresh changed unrecognized ledger bytes');
            if (!deps.noteLedgerWrite)
              throw new Error('final queue settlement requires ledger ownership notification');
            await deps.noteLedgerWrite(state.branch, input.repoRoot);
          }
          if (!refreshed.ok) throw refreshed.error;
          deferredVendorDebt = refreshed.value;
          const imported = deferredReceiptFindings(
            effects
              .openLedger(state.branch)
              .load()
              .records.filter((entry) => entry.kind === 'vendor-debt')
              .map((entry) => entry.debt),
          );
          const unseen = imported.filter(
            (finding) => !record.findings.some((item) => item.id === finding.id),
          );
          if (unseen.length > 0)
            return {
              status: 'needs-human',
              reason:
                'review.run: newly consumed vendor findings retained; re-run composition to address them',
              report: {
                ...record,
                findings: [...record.findings, ...unseen],
                ...(deferredVendorDebt ? { deferredVendorDebt } : {}),
              },
            };
          deferredComplete =
            deferredVendorDebt !== undefined &&
            hasDeferredReviewSources(record, policy.review.reviewers, deferredVendorDebt, {
              repo: deferredVendorDebt.reference.binding.repo,
              producer:
                deferredVendorDebt.reference.binding.kind === 'deferred-author'
                  ? deferredVendorDebt.reference.binding.producer
                  : '',
              target,
              head: state.head,
              base: state.base,
              dirtySha256: state.dirtySha256,
              deferralId: deferredVendorDebt.deferral.id,
            });
        } catch (error) {
          return {
            status: 'needs-human',
            reason: `review.run: current queue trust could not be verified — ${error instanceof Error ? error.message : String(error)}`,
            report: record,
          };
        }
      }
      if (stopped() || (!deferredComplete && !isComplete(record, policy.review.reviewers))) {
        const blockedSources = record.sources.filter((source) => source.status !== 'terminal');
        const blockedTransient =
          !stopped() &&
          blockedSources.length > 0 &&
          blockedSources.every((source) => transientBlocks.has(source.kind));
        const blockedBudget =
          !parent?.aborted &&
          blockedSources.length > 0 &&
          blockedSources.every((source) => budgetBlocks.has(source.kind)) &&
          (await driftSince(effects, state)).length === 0;
        return {
          status: 'needs-human',
          reason:
            'review.run: not every configured reviewer completed a terminal cycle; the findings record, including partial findings, was persisted',
          report: {
            ...record,
            ...(blockedTransient ? { blockedTransient: true as const } : {}),
            ...(blockedBudget ? { blockedBudget: true as const } : {}),
          },
        };
      }
      // Q15d clean refusal asks ONE question: is an authorized obligation pending AT THIS REVIEW
      // IDENTITY? It is read from the post-refresh ledger, so a predecessor settled by this
      // invocation is not counted, and it refuses here rather than decorating outer usage or
      // rewriting notifications. A superseded OLDER-head predecessor does not refuse the run: its
      // receipt is carried as a retained obligation and its findings block once imported, while the
      // durable READINESS gap in record.ts still refuses ANY pending ancestor. Run acceptance and
      // durable readiness are therefore deliberately different verdicts.
      const currentIdentity = {
        head: state.head,
        base: state.base,
        dirtySha256: state.dirtySha256,
      };
      const ancestry = readCurrentEnrollment(
        effects.openLedger(state.branch).load(),
        currentIdentity,
        target,
      );
      const pendingAtThisIdentity =
        ancestry.kind === 'ambiguous'
          ? ancestry.requestIds
          : ancestry.kind === 'enrollment'
            ? ancestry.enrollment.pendingAncestry
                .filter((ancestor) => {
                  const binding = ancestor.reference.binding;
                  return (
                    binding.kind === 'deferred-author' &&
                    binding.head === currentIdentity.head &&
                    binding.target === target &&
                    ancestor.deferral.base === currentIdentity.base
                  );
                })
                .map((ancestor) => ancestor.reference.requestId)
            : [];
      if (pendingAtThisIdentity.length > 0)
        return {
          status: 'needs-human',
          reason: `review.run: authorized predecessor obligation(s) remain unsettled at this review identity (${pendingAtThisIdentity.join(
            ', ',
          )}); a clean completion cannot be claimed`,
          report: record,
        };
      return {
        status: 'ok',
        value: record,
        ...(deferredComplete && deferredVendorDebt
          ? { report: { ...record, deferredVendorDebt } }
          : {}),
      };
    } finally {
      deadline.dispose();
    }
  };
}
