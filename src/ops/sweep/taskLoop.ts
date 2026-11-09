import type { EscalationDecision } from '../fix/escalation.js';
import { unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import type { Driver, ModelSpec, Usage, WorkerResult } from '../../driver/types.js';
import { errorClassOf } from '../../driver/errors.js';
import { currentJobContext } from '../../kernel/governor.js';
import { correlationInvocation } from '../../driver/correlationInvocation.js';
import type { OpResult } from '../../kernel/types.js';
import type { SweepWorkspace } from '../../adapters/git/worktreeFor.js';
import type { CheckCommand, FailureSet } from '../gates/checkRunner.js';
import { adapterByName, parseCheckOutput } from '../gates/checkRunner.js';
import { validateFix, type ValidationVerdict } from '../fix/validate.js';
import { classifyStagePaths, stagedPathsOf, type StagePathGateResult } from './stagePaths.js';
import {
  tasksFromFailures,
  staticTasksFromFailures,
  staticRelatedCheckCommand,
  taskHasFailures,
  relatedCheckCommand,
  normalizeFailurePaths,
  type FixTask,
} from './tasks.js';
import {
  fixerBudgetBreach,
  startFixerDeadline,
  type FixerDeadline,
} from './internal/fixerBudget.js';
import { finishAttempt, type FinishAttemptStop } from '../fix/attemptRecord.js';
import type { AttemptFinishedJournalEvent } from '../../kernel/types.js';
import type { SweepUnitBindings, SweepUnitReport, UnitProbe } from './unit.js';
import type { WorkUnit } from './planSweep.js';
import { SWEEP_DIFF_FLAGS } from '../../shared/gitDiffFlags.js';
import { formatCqTrailers } from '../../shared/cqTrailers.js';
import { fingerprintPairs } from '../gates/fingerprint.js';
import { hackDetector } from '../gates/hackDetector.js';

export interface TaskLoopConfig {
  source?: 'tests' | 'static';
  relatedArgs?: string[];
  denylistPatternsFile?: string;
  protectTests?: boolean;
  wallMs?: number;
  pushFailed?: boolean;
}
export interface TaskAttempt {
  tier: 'worker' | 'rescue';
  attempt: number;
  invocation: 'edit' | 'feedback';
  model: ModelSpec;
  usage?: Usage;
  wallMs: number;
  reason: string;
  stopReason?: string;
  costUSD?: number;
  costBasis?: WorkerResult['costBasis'];
}
export interface FixTaskReport {
  task: FixTask;
  attempts: TaskAttempt[];
  outcome: 'fixed' | 'unfixed' | 'escalated-to-human';
  branch: string;
  commits: string[];
  validation?: ValidationVerdict;
  reason?: string;
  failedAttempt?: { branch: string; sha: string };
  failedAttemptPublished?: boolean;
  rounds?: Array<{
    tier: 'worker' | 'rescue';
    attempt: number;
    reason: string;
    validation?: ValidationVerdict;
    failedAttempt?: { branch: string; sha: string };
    /** This round's failed attempt was pushed to `origin` (per-round history). */
    published?: boolean;
    gate?: FailedAttemptGate;
    outcome?: 'unfixed' | 'escalated-to-human';
  }>;
}
/**
 * The failed-attempt branch this task actually pushed to `origin`, if any.
 *
 * `failedAttemptPublished` is the task-level aggregate of the per-round history:
 * an earlier round can have been published while the CURRENT `failedAttempt`
 * was refused publication (path or tamper gate, failed push). Consumers that
 * render a ref — the report's `publishedBranch` and the fix run's compare link —
 * must read the round that belongs to the current attempt, never the aggregate,
 * or they name a branch that was never pushed.
 */
export function publishedFailedAttemptBranch(task: FixTaskReport): string | undefined {
  const branch = task.failedAttempt?.branch;
  if (branch === undefined) return undefined;
  const round = task.rounds?.find((entry) => entry.failedAttempt?.branch === branch);
  return round?.published === true ? branch : undefined;
}
/** Prompt-only projection; durable rounds retain complete failure evidence. */
export function promptRound(
  round: NonNullable<FixTaskReport['rounds']>[number] | undefined,
  baseline: FailureSet,
) {
  if (round === undefined) return null;
  const { validation, ...context } = round;
  const baselineKeys = new Set(fingerprintPairs(baseline).map((pair) => pair.key));
  const novel =
    validation?.final === undefined
      ? []
      : fingerprintPairs(validation.final, undefined, baseline).filter(
          (pair) => !baselineKeys.has(pair.key),
        );
  return {
    ...context,
    ...(validation === undefined
      ? {}
      : {
          validation: {
            verdict: validation.verdict,
            gates: validation.gates,
            novelFailures: novel.slice(0, 10).map(({ failure }) => ({
              ...failure,
              message: failure.message.slice(0, 1000),
            })),
            omittedNovelFailures: Math.max(0, novel.length - 10),
            ...(validation.regression ? { regression: true } : {}),
          },
        }),
  };
}

export type FailedAttemptGate =
  | 'related'
  | 'broader'
  | 'path-policy'
  | 'tamper'
  | 'commit'
  | 'budget'
  | 'none';
export interface FailedAttempt {
  branch: string;
  sha: string;
}
export interface FailedAttemptInput {
  runPrefix: string;
  kind: string;
  slug: string;
  /** Raw unit names, kept separate from the resolved display segments. */
  kindIdentity?: string;
  slugIdentity?: string;
  task: string;
  /** Full logical identity for compact task IDs (for example static clusters). */
  taskIdentity?: string;
  parent: string;
  firstAttempt: number;
  tier: 'worker' | 'rescue';
  model: ModelSpec;
  gate: FailedAttemptGate;
  outcome: 'unfixed' | 'escalated-to-human';
  reason: string;
  pushFailed: boolean;
}
const FAILED_ATTEMPT_SCAN_FILE_CAP_BYTES = 4 * 1024 * 1024;
const FAILED_ATTEMPT_SCAN_TOTAL_CAP_BYTES = 32 * 1024 * 1024;
export interface TaskEscalation {
  rescueModel?: ModelSpec;
  next: (
    task: FixTask,
    progress: {
      workerUsed: number;
      rescueUsed: number;
      reason: string;
      regression: boolean;
      stopReason?: string;
    },
  ) => EscalationDecision;
  verified: (before: FailureSet, after: FailureSet) => void;
}
export interface TaskRunBudget {
  remainingTokens: () => number;
  remainingWallMs: () => number;
  reportResult: (worker: WorkerResult) => void;
}
/** Existing sweep owns detached-tree validation and verified commits. */
export interface TaskLoopEffects {
  broader: (
    parent: string,
    remainingWallMs: number,
  ) => Promise<{ final: UnitProbe; treeSha: string }>;
  commit: (message: string, treeSha: string) => Promise<string>;
  verify: (sha: string, parent: string) => Promise<void>;
  publish: (sha: string) => Promise<void>;
  pendingPublish?: () => Promise<string | undefined>;
}

export async function runTaskLoop(
  bindings: SweepUnitBindings,
  unit: WorkUnit,
  worktree: SweepWorkspace,
  baseline: UnitProbe,
  branch: string,
  effects: TaskLoopEffects,
): Promise<OpResult<SweepUnitReport>> {
  try {
    return await runTaskLoopInner(bindings, unit, worktree, baseline, branch, effects);
  } catch (error) {
    return { status: 'failed', error: `[INFRA] task loop failed: ${String(error)}` };
  }
}

async function runTaskLoopInner(
  bindings: SweepUnitBindings,
  unit: WorkUnit,
  worktree: SweepWorkspace,
  baseline: UnitProbe,
  branch: string,
  effects: TaskLoopEffects,
): Promise<OpResult<SweepUnitReport>> {
  const config = bindings.taskLoop ?? {};
  const tasks =
    bindings.deriveTasks?.(baseline.failureSet) ??
    (config.source === 'static'
      ? staticTasksFromFailures(baseline.failureSet)
      : tasksFromFailures(baseline.failureSet));
  const reports: FixTaskReport[] = [];
  let accepted = baseline;
  let lastSha: string | undefined;
  let budgetStopped = false;
  let indeterminate: string | undefined;
  // ADR-0008 T13: observation failures are EVIDENCE, never a verdict. An
  // attempt event that fails to build (finishAttempt's strict payload schema,
  // or the writer's validation) never reaches the writer, so the writer's own
  // failure surface cannot record it; this field carries it for runFix to fold
  // into `observation.status`. It never gates publication or changes the unit
  // verdict.
  const observationFailures: string[] = [];
  let spentTokens = 0;
  // ADR-0008 T13: inner attempt ordinal — one per worker invocation, distinct
  // from the kernel job retry ordinal (LadderContextInfo.attempt).
  let attemptOrdinal = 0;
  const unitStart = Date.now();
  // ADR-0008 T13 emitter: one attempt-finished event per worker invocation,
  // written through the T30 runtime observation writer in the invocation's
  // finally (spawn failure, cancellation and budget exhaustion all finish
  // exactly once). Observation failures NEVER change the run verdict: an I/O
  // write failure fail-stops the writer and is read back from `failure` by
  // closeObservation, while a build/validation failure — which never reaches
  // the writer — is recorded on the report's `observationFailures`. Neither
  // ever breaks the loop or marks the unit indeterminate.
  const emitAttempt = async (build: () => AttemptFinishedJournalEvent): Promise<void> => {
    const writer = bindings.observationWriter;
    if (writer === undefined) return;
    let event: AttemptFinishedJournalEvent;
    try {
      event = build();
    } catch (error) {
      observationFailures.push(`attempt observation failed: ${String(error)}`);
      return;
    }
    try {
      await writer.append(event);
    } catch (error) {
      // The writer fail-stops on an I/O write failure and exposes it through
      // `failure` (closeObservation folds it into observation.status). A
      // writer-side validation/identity refusal does not mark the writer, so
      // record that one here rather than losing it.
      if (writer.failure === null)
        observationFailures.push(`attempt observation failed: ${String(error)}`);
    }
  };
  const git = async (args: string[]) => {
    const result = await bindings.git(['-C', worktree.path, ...args]);
    if (result.code !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  const check = async (command: CheckCommand): Promise<FailureSet> => {
    if (bindings.cancelled?.()) throw new Error('enclosing job cancelled');
    const remainingWall = Math.min(
      (config.wallMs ?? 3_600_000) - (Date.now() - unitStart),
      bindings.taskRunBudget?.remainingWallMs() ?? Infinity,
    );
    if (remainingWall <= 0) {
      budgetStopped = true;
      throw new Error('unit wall budget exhausted');
    }
    const boundedCommand = {
      ...command,
      timeoutMs: Math.min(command.timeoutMs ?? 600_000, remainingWall),
    };
    const untracked = async () =>
      new Set(
        (await git(['ls-files', '--others', '--exclude-standard', '-z']))
          .split('\0')
          .filter(Boolean),
      );
    const before = await untracked();
    let raw;
    try {
      raw = await bindings.runCheck(boundedCommand);
    } finally {
      for (const path of await untracked()) {
        if (!before.has(path)) await unlink(resolve(worktree.path, path));
      }
    }
    const parsed = parseCheckOutput(adapterByName(bindings.adapter), raw);
    if (parsed.verdict !== 'parsed') throw new Error(parsed.reason);
    return normalizeFailurePaths(parsed.set, worktree.path, command.cwd ?? worktree.path);
  };
  taskLoop: for (const task of tasks) {
    const row: FixTaskReport = { task, attempts: [], outcome: 'unfixed', branch, commits: [] };
    reports.push(row);
    if (bindings.cancelled?.()) {
      row.outcome = 'escalated-to-human';
      row.reason = 'enclosing job cancelled';
      continue;
    }
    if (
      budgetStopped ||
      currentJobContext()?.signal.aborted ||
      Date.now() - unitStart >= (config.wallMs ?? 3_600_000)
    ) {
      budgetStopped = true;
      row.reason = 'token or wall budget exhausted';
      continue;
    }
    if (task.files.length === 0) {
      row.outcome = 'escalated-to-human';
      row.reason = 'failure has no attributed file';
      continue;
    }
    if (!taskHasFailures(task, accepted.failureSet, config.source)) {
      row.outcome = 'fixed';
      row.reason = 'earlier verified task resolved this file or cluster';
      continue;
    }
    let workerUsed = 0;
    let rescueUsed = 0;
    let regression = false;
    while (true) {
      const decision = bindings.taskEscalation?.next(task, {
        workerUsed,
        rescueUsed,
        reason: row.reason ?? 'initial task',
        regression,
        ...(budgetStopped || bindings.cancelled?.() || currentJobContext()?.signal.aborted
          ? {
              stopReason: bindings.cancelled?.()
                ? 'enclosing job cancelled'
                : 'token or wall budget exhausted',
            }
          : {}),
      }) ?? { tier: 'worker' as const, attempt: 1, reason: 'initial task' };
      if (decision.tier === 'human') {
        row.outcome = 'escalated-to-human';
        row.reason = decision.reason;
        break;
      }
      const tier = decision.tier;
      if (decision.tier === 'worker') workerUsed++;
      else rescueUsed++;
      const priorRound = row.rounds?.at(-1);
      let priorFailedFeedback:
        | { patch: string; contents: Array<{ text: string; path: string }> }
        | undefined;
      delete row.validation;
      delete row.failedAttempt;
      // `row.failedAttemptPublished` is DERIVED from the rounds below (never
      // deleted per attempt): an earlier attempt's pushed ref stays visible
      // when a later attempt replaces its `failedAttempt`.
      let parent: string | undefined;
      let failedModel: ModelSpec = bindings.modelSpec;
      let finalTree: { final: UnitProbe; treeSha: string } | undefined;
      const recordFailedAttempt = async (
        gate: FailedAttemptGate,
        reason: string,
      ): Promise<FailedAttempt> => {
        if (parent === undefined) throw new Error('failed attempt has no pre-attempt HEAD');
        const kind = bindings.segments?.kind ?? unit.fixer;
        const slug = bindings.segments?.slug ?? unit.package;
        await git(['add', '-A', '--', '.']);
        const failedAttempt = await commitFailedAttempt(git, {
          runPrefix: bindings.runPrefix,
          kind,
          slug,
          kindIdentity: unit.fixer,
          slugIdentity: unit.package,
          task: task.id,
          taskIdentity: task.signature ?? task.id,
          parent,
          firstAttempt: Math.max(1, (row.rounds?.length ?? 0) + 1),
          tier,
          model: failedModel,
          gate,
          outcome: row.outcome === 'fixed' ? 'unfixed' : row.outcome,
          reason,
          pushFailed: config.pushFailed ?? false,
        });
        await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
        return failedAttempt;
      };
      // Task-level publication state, derived from the per-round history: any
      // round whose failed attempt reached `origin` keeps the task published.
      const deriveFailedAttemptPublished = (): void => {
        if (row.rounds?.some((round) => round.published === true) === true)
          row.failedAttemptPublished = true;
        else delete row.failedAttemptPublished;
      };
      try {
        parent = await git(['rev-parse', 'HEAD']);
        const fullCheck = bindings.checkCommand(unit, worktree.path);
        const related = (
          config.source === 'static'
            ? (command: CheckCommand, files: string[], args?: string[]) =>
                staticRelatedCheckCommand(command, bindings.adapter, files, args)
            : relatedCheckCommand
        )(
          fullCheck,
          task.files.map((file) =>
            relative(fullCheck.cwd ?? worktree.path, resolve(worktree.path, file)),
          ),
          config.relatedArgs,
        );
        const resolved = bindings.taskWorker?.(
          task,
          related,
          decision.tier === 'rescue' ? bindings.taskEscalation?.rescueModel : undefined,
        ) ?? {
          driver: bindings.driver,
          modelSpec: bindings.modelSpec,
        };
        failedModel = resolved.modelSpec;
        if (decision.tier === 'rescue' && priorRound?.failedAttempt !== undefined) {
          try {
            priorFailedFeedback = await failedAttemptFeedback(git, priorRound.failedAttempt);
          } catch {
            // Prior-attempt feedback is advisory: an unscannable failed attempt
            // (binary/oversized file, U+FFFD content, oversized patch) must not
            // consume the rescue reservation without invoking the model.
            priorFailedFeedback = undefined;
          }
        }
        const prompt = `${bindings.prompt(unit, worktree)}\nTier: ${decision.tier}; attempt: ${decision.attempt}; reason: ${decision.reason}\nPrevious attempt: ${JSON.stringify(promptRound(priorRound, accepted.failureSet))}${priorFailedFeedback === undefined ? '' : `\nPrior failed-attempt patch (engine-owned feedback; do not repeat rejected changes):\n${priorFailedFeedback.patch}`}\nTask: ${JSON.stringify(task)}\nRelated argv: ${JSON.stringify([related.command, ...related.args])}\nDo not stage or commit. Return outcome (broken-test, code-bug, todo), summary and confidence (0 to 1) as structured output.`;
        const invoke = async (
          invocation: TaskAttempt['invocation'],
          text: string,
          contents?: Array<{ text: string; path: string }>,
        ): Promise<WorkerResult> => {
          // ADR-0008 T13: every invocation ends at exactly one attempt-finished
          // boundary. `stop` carries the observed stop variant; the fallback is
          // an unclassified infrastructure stop, never an invented completion.
          const ordinal = ++attemptOrdinal;
          let stopSet = false;
          let stop: FinishAttemptStop = {
            stopCode: 'unclassified',
            stopReason: 'attempt ended without an observed stop',
          };
          const setStop = (next: FinishAttemptStop): void => {
            stop = next;
            stopSet = true;
          };
          let usage: typeof first.usage | undefined;
          let servedModel: string | undefined;
          let thrown: unknown;
          let driverThrew = false;
          let allowedTokens: number | null = null;
          let allowedWall: number | null = null;
          let boundWallMs: number | null = null;
          let deadline: FixerDeadline | undefined;
          let attempt: TaskAttempt | undefined;
          const start = Date.now();
          const cancelStop = (): FinishAttemptStop => ({
            stopCode: 'cancelled',
            stopReason: 'enclosing job cancelled',
          });
          try {
            try {
              if (bindings.cancelled?.()) {
                setStop(cancelStop());
                throw new Error('enclosing job cancelled');
              }
              if (bindings.scanPrompt === undefined) {
                setStop({
                  stopCode: 'human-deferred',
                  stopReason: 'worker upload scanner is required',
                });
                throw new Error('worker upload scanner is required');
              }
              await bindings.scanPrompt(text, contents);
            } catch {
              if (!stopSet) {
                setStop({
                  stopCode: 'human-deferred',
                  stopReason: 'worker upload refused: missing, failed or positive denylist scan',
                });
              }
              row.outcome = 'escalated-to-human';
              throw new Error('worker upload refused: missing, failed or positive denylist scan');
            }
            if (bindings.cancelled?.()) {
              setStop(cancelStop());
              row.outcome = 'escalated-to-human';
              throw new Error('enclosing job cancelled');
            }
            const remainingWall = Math.min(
              bindings.budget.wallClockMs ?? 1_200_000,
              (config.wallMs ?? 3_600_000) - (start - unitStart),
              bindings.taskRunBudget?.remainingWallMs() ?? Infinity,
            );
            const remainingTokens = Math.min(
              bindings.budget.maxTokens === undefined
                ? Infinity
                : bindings.budget.maxTokens - spentTokens,
              bindings.taskRunBudget?.remainingTokens() ?? Infinity,
            );
            if (remainingWall <= 0 || remainingTokens <= 0) {
              budgetStopped = true;
              // The tripped budget cap is named, never a bare boolean.
              setStop({
                budgetExpired: true,
                budgetStopCode: remainingWall <= 0 ? 'wall-cap' : 'token-cap',
                stopReason: 'token or wall budget exhausted',
              });
              throw new Error('token or wall budget exhausted');
            }
            allowedWall = Number.isFinite(remainingWall) ? remainingWall : null;
            allowedTokens = Number.isFinite(remainingTokens) ? remainingTokens : null;
            boundWallMs = remainingWall;
            deadline = startFixerDeadline(currentJobContext()?.signal, remainingWall);
            attempt = {
              tier,
              attempt: decision.attempt,
              invocation,
              model: resolved.modelSpec,
              wallMs: 0,
              reason: invocation === 'edit' ? decision.reason : 'related-check feedback',
            };
            row.attempts.push(attempt);
            let worker: Awaited<ReturnType<typeof resolved.driver.run>>;
            try {
              worker = await resolved.driver.run(
                {
                  prompt: text,
                  modelSpec: resolved.modelSpec,
                  workspace: { path: worktree.path },
                  budget: {
                    ...bindings.budget,
                    ...(Number.isFinite(remainingTokens) ? { maxTokens: remainingTokens } : {}),
                    wallClockMs: remainingWall,
                  },
                  toolPolicy: {
                    allow:
                      bindings.toolPolicy?.mode === 'none'
                        ? []
                        : (bindings.toolPolicy?.allow ?? ['read', 'edit', 'bash'])
                            .map((tool) => (tool === 'run' ? 'bash' : tool))
                            .filter(
                              (tool) =>
                                ['read', 'edit', 'bash'].includes(tool) &&
                                (tool !== 'bash' || bindings.taskWorker !== undefined),
                            ),
                    mode: bindings.toolPolicy?.mode === 'none' ? 'none' : 'allowlist',
                  },
                  sandboxPolicy: bindings.sandboxPolicy ?? { level: 'workspace-write' },
                  // Session-log correlation (items 1.3–1.5): forward the
                  // runner's minted work identity so the lane stamps the
                  // child's CQ_* env. Absent outside a governed dispatch —
                  // unchanged behavior there.
                  ...correlationInvocation(currentJobContext()?.info?.correlation),
                  outputSchema: {
                    name: 'fix.task/v1',
                    schema: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        outcome: { enum: ['broken-test', 'code-bug', 'todo'] },
                        summary: { type: 'string' },
                        confidence: { type: 'number', minimum: 0, maximum: 1 },
                      },
                      required: ['outcome', 'summary', 'confidence'],
                    },
                  },
                },
                { signal: deadline.signal },
              );
            } catch (driverError) {
              // Only a driver-call rejection is a driver-sourced cause; loop
              // throws must not be misattributed to the driver.
              driverThrew = true;
              throw driverError;
            }
            try {
              attempt.usage = worker.usage;
              usage = worker.usage;
              servedModel = worker.model;
              if (worker.costUSD !== undefined) attempt.costUSD = worker.costUSD;
              if (worker.costBasis !== undefined) attempt.costBasis = worker.costBasis;
              bindings.taskRunBudget?.reportResult(worker);
              spentTokens +=
                worker.usage.input +
                worker.usage.output +
                worker.usage.cacheRead +
                worker.usage.cacheWrite +
                (worker.usage.reasoning ?? 0);
              attempt.stopReason = worker.stopReason;
              currentJobContext()?.reportResult(worker);
              if (bindings.cancelled?.()) {
                setStop(cancelStop());
                row.outcome = 'escalated-to-human';
                throw new Error('enclosing job cancelled');
              }
              const breach = fixerBudgetBreach(bindings.budget, worker);
              const budgetCause = deadline.expired()
                ? {
                    code: 'wall-cap' as const,
                    reason: 'sweep fixer wallClockMs deadline expired',
                  }
                : (bindings.taskRunBudget?.remainingWallMs() ?? Infinity) <= 0
                  ? {
                      code: 'wall-cap' as const,
                      reason: 'task-run wall budget exhausted',
                    }
                  : breach !== undefined
                    ? { code: 'token-cap' as const, reason: breach }
                    : (bindings.taskRunBudget?.remainingTokens() ?? Infinity) <= 0
                      ? {
                          code: 'token-cap' as const,
                          reason: 'task-run token budget exhausted',
                        }
                      : bindings.budget.maxTokens !== undefined &&
                          spentTokens >= bindings.budget.maxTokens
                        ? {
                            code: 'token-cap' as const,
                            reason: `spent ${String(spentTokens)} tokens reached maxTokens ${String(bindings.budget.maxTokens)}`,
                          }
                        : worker.stopReason === 'budget'
                          ? // The driver reported a budget stop without naming a
                            // cap: never guess. stopCode 'budget' is not in the
                            // fixed table, so finishAttempt records it as the
                            // sanitized raw code with class unclassified
                            // (infrastructure, certainty unknown).
                            {
                              code: 'budget' as const,
                              reason: 'worker reported a budget stop',
                            }
                          : null;
              if (budgetCause !== null || currentJobContext()?.signal.aborted) {
                budgetStopped = true;
                // A budget breach while the attempt is otherwise complete is
                // the budget variant, never a generic failure. A worker-reported
                // budget stop without a named cap keeps the raw code 'budget':
                // the cap is never guessed; finishAttempt's unknown branch then
                // records it as infrastructure/unclassified with certainty
                // unknown and the sanitized raw code preserved.
                if (budgetCause === null) setStop(cancelStop());
                else if (budgetCause.code === 'budget')
                  setStop({ stopCode: 'budget', stopReason: budgetCause.reason });
                else
                  setStop({
                    budgetExpired: true,
                    budgetStopCode: budgetCause.code,
                    stopReason: budgetCause.reason,
                  });
                throw new Error('token or wall budget exhausted');
              }
              if (worker.stopReason !== 'complete') {
                setStop({
                  stopCode: worker.stopReason,
                  stopReason: `worker stopped: ${worker.stopReason}`,
                });
                throw new Error(`worker stopped: ${worker.stopReason}`);
              }
              setStop({ completed: true });
              return worker;
            } finally {
              // wallMs is measured and set BEFORE the attempt-finished append;
              // it is never an invented zero.
              if (attempt !== undefined) attempt.wallMs = Date.now() - start;
              deadline.dispose();
            }
          } catch (error) {
            thrown ??= error;
            // Classify throws with no observed stop before the boundary: a
            // fired wallClockMs deadline is the budget variant with the cap
            // named; a cancelled or governed-aborted job is the cancel stop.
            // budgetStopped is set so escalation stops scheduling attempts.
            if (!stopSet) {
              if (deadline?.expired() === true) {
                budgetStopped = true;
                setStop({
                  budgetExpired: true,
                  budgetStopCode: 'wall-cap',
                  stopReason: 'sweep fixer wallClockMs deadline expired',
                });
              } else if (bindings.cancelled?.() || currentJobContext()?.signal.aborted) {
                setStop(cancelStop());
              }
            }
            throw error;
          } finally {
            deadline?.dispose();
            const wallMs = attempt?.wallMs ?? Date.now() - start;
            const tokens =
              usage === undefined
                ? null
                : usage.input +
                  usage.output +
                  usage.cacheRead +
                  usage.cacheWrite +
                  (usage.reasoning ?? 0);
            await emitAttempt(() => ({
              type: 'attempt-finished',
              runId:
                bindings.observationRunId ?? bindings.observationWriter?.compositionRunId ?? '',
              at: new Date().toISOString(),
              // Production identity is `<package>/<fixer>` (runFix, registry,
              // unit.ts); the fallback matches it rather than inventing a
              // second order for unwired callers.
              unitId: bindings.observationUnitId ?? `${unit.package}/${unit.fixer}`,
              jobId: currentJobContext()?.info.jobKey ?? null,
              taskId: task.id,
              attempt: ordinal,
              payload: finishAttempt({
                ...stop,
                // The prose message of a driver throw stays in stopReason;
                // error.code keeps the stable code, never the prose.
                ...(driverThrew && thrown instanceof Error
                  ? { stopReason: `${stop.stopReason as string}; ${thrown.message}` }
                  : {}),
                tier,
                invocation: `${bindings.runPrefix}:${task.id}:${String(ordinal)}:${invocation}`,
                model: resolved.modelSpec,
                provider: resolved.modelSpec.provider,
                requestedModel: resolved.modelSpec.model,
                ...(servedModel === undefined ? {} : { servedModel }),
                tokens,
                usageChannels:
                  usage === undefined
                    ? {}
                    : {
                        input: usage.input,
                        output: usage.output,
                        cacheRead: usage.cacheRead,
                        cacheWrite: usage.cacheWrite,
                        reasoning: usage.reasoning ?? null,
                      },
                requests: usage === undefined ? null : 1,
                wallMs,
                ...(driverThrew && thrown !== undefined
                  ? {
                      error: {
                        type: thrown instanceof Error ? thrown.name : null,
                        // A stable code when the error carries one; the prose
                        // message stays in stopReason, never in code.
                        code:
                          typeof (thrown as { code?: unknown } | null)?.code === 'string'
                            ? (thrown as { code: string }).code
                            : // A pre-dispatch DispatchError carries its class as
                              // structured data; it is the stable code when the
                              // error has no `code` of its own.
                              (errorClassOf(thrown) ?? null),
                        providerFinishReason: null,
                        source: 'driver',
                        certainty: 'observed' as const,
                      },
                    }
                  : {}),
                timeout:
                  deadline === undefined || !deadline.expired()
                    ? null
                    : {
                        scope: 'attempt' as const,
                        boundMs: boundWallMs ?? 0,
                        source: 'sweep fixer wallClockMs deadline',
                      },
                budget: {
                  allowed: { tokens: allowedTokens, wallMs: allowedWall },
                  spent: { tokens, wallMs },
                  remaining: {
                    tokens:
                      allowedTokens === null || tokens === null
                        ? null
                        : Math.max(0, allowedTokens - tokens),
                    wallMs: allowedWall === null ? null : Math.max(0, allowedWall - wallMs),
                  },
                },
              }),
            }));
          }
        };
        const first = await invoke('edit', prompt, priorFailedFeedback?.contents);
        // Stage and classify BEFORE executing any check on worker-controlled bytes.
        if ((await git(['rev-parse', 'HEAD'])) !== parent)
          throw new Error('worker moved HEAD; unscanned self-commit');
        await git(['add', '-A', '--', '.']);
        const earlyPaths = stagedPathsOf(
          await git(['diff', '--cached', ...SWEEP_DIFF_FLAGS, '--name-status', '-z']),
        );
        const earlyGate = classifyStagePaths(
          earlyPaths,
          bindings.stagePathAllowlist,
          bindings.proposeOnly === true,
          config.protectTests ?? false,
        );
        if (earlyGate.kind !== 'clean') {
          // A propose-only worker's non-empty staged set is escalated to a
          // human (nothing is probed, committed or pushed), never an ordinary
          // failure: the contract in SweepUnitBindings.proposeOnly and
          // classifyStagePaths says so, and only `needs-human` reaches the
          // escalation branch in the catch below.
          const verdict =
            earlyGate.kind === 'protected' || earlyGate.kind === 'propose-only'
              ? 'needs-human'
              : 'fail';
          row.validation = {
            verdict,
            gates: [{ gate: 'paths', verdict, wallMs: 0, detail: earlyGate.message }],
          };
          throw new Error(earlyGate.message);
        }
        const feedback = await check(related);
        const second = await invoke(
          'feedback',
          `${prompt}\nPrior output: ${JSON.stringify(first.structuredOutput)}\nRelated check: ${JSON.stringify(feedback)}\nUse this feedback to finish the task.`,
          priorFailedFeedback?.contents,
        );
        if ((await git(['rev-parse', 'HEAD'])) !== parent)
          throw new Error('worker moved HEAD; unscanned self-commit');
        await git(['add', '-A', '--', '.']);
        // The tree THIS attempt's gates inspect. The related/broader checks
        // below execute worker-controlled code and could stage more bytes in
        // this same index; the commit is bound to this tree (see the compare
        // after validation), never to whatever the index became.
        const gatedTree = await git(['write-tree']);
        const paths = stagedPathsOf(
          await git(['diff', '--cached', ...SWEEP_DIFF_FLAGS, '--name-status', '-z']),
        );
        // Refuse protected evidence before executing checks from a mutable tree.
        const pathGate = classifyStagePaths(
          paths,
          bindings.stagePathAllowlist,
          bindings.proposeOnly,
          config.protectTests ?? false,
        );
        if (pathGate.kind !== 'clean') {
          row.validation = {
            verdict:
              pathGate.kind === 'scope' || pathGate.kind === 'infra' ? 'fail' : 'needs-human',
            gates: [
              {
                gate: 'paths',
                verdict:
                  pathGate.kind === 'scope' || pathGate.kind === 'infra' ? 'fail' : 'needs-human',
                wallMs: 0,
                detail: pathGate.message ?? 'path refusal',
              },
            ],
          };
          if (bindings.proposeOnly) {
            row.outcome = 'escalated-to-human';
            row.reason = pathGate.message ?? 'propose-only';
            row.failedAttempt = await recordFailedAttempt('path-policy', row.reason);
            (row.rounds ??= []).push({
              tier,
              attempt: decision.attempt,
              reason: row.reason,
              validation: row.validation,
              ...(row.failedAttempt === undefined ? {} : { failedAttempt: row.failedAttempt }),
              gate: 'path-policy',
              outcome: row.outcome,
            });
            // A path-policy refusal must never publish the rejected tree, even
            // when the caller opted into publishing other failed attempts.
            continue taskLoop;
          }
          throw new Error(pathGate.message ?? 'path refusal');
        }
        const output = second.structuredOutput as
          | { outcome?: unknown; summary?: unknown; confidence?: unknown }
          | undefined;
        if (
          !output ||
          !['broken-test', 'code-bug', 'todo'].includes(String(output.outcome)) ||
          typeof output.summary !== 'string' ||
          typeof output.confidence !== 'number' ||
          !Number.isFinite(output.confidence) ||
          output.confidence < 0 ||
          output.confidence > 1
        )
          throw new Error('worker returned no valid outcome');
        const subject =
          output.outcome === 'broken-test'
            ? 'fix(test)'
            : output.outcome === 'todo'
              ? 'chore(test)'
              : `fix(${unit.package})`;
        // Trailer values here are plan-controlled labels (task.id, unit
        // fixer/package) that plan validation enforces as non-empty; unlike
        // the failed path no extra sanitization is applied, so a malformed label
        // fails the commit closed via formatCqTrailers instead of emitting a
        // forged trailer line. Deliberate asymmetry with the failed path,
        // which sanitizes before the helper.
        const message = `${subject}: ${output.outcome === 'todo' ? 'todo ' : ''}${output.summary.replace(/[\r\n]/g, ' ')}\n\nConfidence: ${String(output.confidence)}\nTested: configured related and broader checks\nOutcome: ${String(output.outcome)}\n${formatCqTrailers(
          [
            ['Cq-Run', bindings.runPrefix],
            [
              'Cq-Unit',
              `${bindings.segments?.kind ?? unit.fixer}/${bindings.segments?.slug ?? unit.package}`,
            ],
            ...(output.outcome === 'todo' ? [['Cq-Todo', 'true'] as const] : []),
            ['Cq-Task', task.id],
            ['Cq-Attempt', String(decision.attempt)],
            ['Cq-Tier', tier],
            ['Cq-Model', `${resolved.modelSpec.provider}/${resolved.modelSpec.model}`],
          ],
        )}`;
        const identical =
          config.source === 'static' && JSON.stringify(related) === JSON.stringify(fullCheck);
        const broader = async () => {
          if (parent === undefined) throw new Error('missing task parent');
          const remainingWall = Math.min(
            (config.wallMs ?? 3_600_000) - (Date.now() - unitStart),
            bindings.taskRunBudget?.remainingWallMs() ?? Infinity,
          );
          if (remainingWall <= 0) {
            budgetStopped = true;
            throw new Error('unit wall budget exhausted');
          }
          finalTree = await effects.broader(parent, remainingWall);
          return finalTree.final.failureSet;
        };
        const validation = await validateFix({
          baseline: accepted.failureSet,
          related: identical ? broader : () => check(related),
          broader,
          ...(config.source !== 'static'
            ? {}
            : {
                relatedAccepts: (set: FailureSet) =>
                  set.exitCode !== null &&
                  (set.exitCode === 0 || set.failures.length > 0) &&
                  !taskHasFailures(task, set, 'static'),
                reuseRelatedForBroader: identical,
              }),
          stagedPaths: paths,
          diff: await git(['diff', '--cached', ...SWEEP_DIFF_FLAGS, '--']),
          message,
          requireProgress: true,
          protectTests: config.protectTests ?? false,
          ...(bindings.stagePathAllowlist === undefined
            ? {}
            : { allowlist: bindings.stagePathAllowlist }),
        });
        row.validation = validation;
        if (validation.verdict !== 'pass' || finalTree === undefined)
          throw new Error('validation refused task');
        if (finalTree.treeSha !== gatedTree)
          throw new Error('index changed after path/tamper gating; refusing unscanned tree');
        if (bindings.cancelled?.()) {
          row.outcome = 'escalated-to-human';
          throw new Error('enclosing job cancelled');
        }
        const sha = await effects.commit(message, finalTree.treeSha);
        await effects.verify(sha, parent);
        row.commits.push(sha);
        row.outcome = 'fixed';
        delete row.reason;
        lastSha = sha;
        bindings.taskEscalation?.verified(accepted.failureSet, finalTree.final.failureSet);
        accepted = finalTree.final;
        (row.rounds ??= []).push({
          tier,
          attempt: decision.attempt,
          reason: decision.reason,
          validation,
        });
        break;
      } catch (error) {
        if (row.failedAttempt !== undefined && config.pushFailed) {
          indeterminate = `failed-attempt push failed: ${String(error)}`;
          row.reason = `${String(error)}; ${indeterminate}`;
          row.outcome = 'escalated-to-human';
          break taskLoop;
        }
        if (!bindings.cancelled?.() && Date.now() - unitStart >= (config.wallMs ?? 3_600_000))
          budgetStopped = true;
        row.reason = String(error);
        row.outcome =
          row.outcome === 'escalated-to-human' || row.validation?.verdict === 'needs-human'
            ? 'escalated-to-human'
            : 'unfixed';
        const unsafe = row.validation?.gates.some(
          (gate) => ['paths', 'tamper', 'commit'].includes(gate.gate) && gate.verdict !== 'pass',
        );
        if (unsafe && bindings.taskEscalation) row.outcome = 'escalated-to-human';
        try {
          if (parent === undefined || (await git(['rev-parse', 'HEAD'])) !== parent) {
            row.outcome = 'escalated-to-human';
            row.reason += '; HEAD changed; remaining tasks stopped for human review';
            break taskLoop;
          }
          const gate = failedGateOf(row.validation, row.reason);
          row.failedAttempt = await recordFailedAttempt(gate, row.reason);
          (row.rounds ??= []).push({
            tier,
            attempt: decision.attempt,
            reason: row.reason ?? 'attempt failed',
            ...(row.validation === undefined ? {} : { validation: row.validation }),
            ...(row.failedAttempt === undefined ? {} : { failedAttempt: row.failedAttempt }),
            gate,
            outcome: row.outcome,
          });
          deriveFailedAttemptPublished();
        } catch (cleanupError) {
          indeterminate = `failed-task evidence recording failed: ${String(cleanupError)}`;
          row.reason += `; ${indeterminate}`;
          row.outcome = 'escalated-to-human';
          break taskLoop;
        }
        const unsafeRefusal = row.validation?.gates.some(
          (gate) => ['paths', 'tamper', 'commit'].includes(gate.gate) && gate.verdict !== 'pass',
        );
        // A gate that already refused this attempt means it will never be
        // pushed: skip the publication scan entirely. Scanning it anyway ran
        // the tamper detector on a rejected patch whose throw then stopped the
        // whole unit (and its verified, publishable commits).
        if (
          config.pushFailed &&
          bindings.publishFailedAttempts === true &&
          row.failedAttempt !== undefined &&
          !unsafeRefusal
        ) {
          try {
            const uploadGate = await scanFailedAttempt(
              git,
              bindings,
              parent,
              row.failedAttempt.sha,
              config.protectTests ?? false,
            );
            if (bindings.cancelled?.() || currentJobContext()?.signal.aborted)
              throw new Error('parent job cancelled before failed-attempt publication');
            if (uploadGate.kind !== 'clean') {
              const detail = uploadGate.message;
              row.validation = {
                verdict: 'needs-human',
                gates: [
                  ...(row.validation?.gates ?? []),
                  { gate: 'paths', verdict: 'needs-human', wallMs: 0, detail },
                ],
              };
              row.outcome = 'escalated-to-human';
              row.reason = `${row.reason ?? 'failed attempt'}; ${detail}`;
              const recordedRound = row.rounds?.at(-1);
              if (recordedRound?.failedAttempt?.branch === row.failedAttempt.branch) {
                recordedRound.reason = row.reason;
                recordedRound.outcome = row.outcome;
                recordedRound.validation = row.validation;
              }
            } else {
              await git([
                'push',
                'origin',
                `${row.failedAttempt.sha}:refs/heads/${row.failedAttempt.branch}`,
              ]);
              const publishedRound = row.rounds?.at(-1);
              if (publishedRound?.failedAttempt?.branch === row.failedAttempt.branch)
                publishedRound.published = true;
              deriveFailedAttemptPublished();
            }
          } catch (publishError) {
            indeterminate = `failed-attempt publication refused: ${String(publishError)}`;
            row.reason = `${row.reason ?? 'failed attempt'}; ${indeterminate}`;
            row.outcome = 'escalated-to-human';
            const recordedRound = row.rounds?.at(-1);
            if (recordedRound?.failedAttempt?.branch === row.failedAttempt.branch) {
              recordedRound.reason = row.reason;
              recordedRound.outcome = row.outcome;
            }
            break taskLoop;
          }
        }
        regression = row.validation?.regression === true;
        if (
          !bindings.taskEscalation ||
          row.outcome === 'escalated-to-human' ||
          unsafe ||
          budgetStopped
        )
          break;
      }
    }
  }
  // A stopped task must not erase undispatched siblings from the report.
  for (const task of tasks.slice(reports.length))
    reports.push({
      task,
      attempts: [],
      outcome: 'escalated-to-human',
      branch,
      commits: [],
      reason: 'unit stopped for human review',
    });
  let pushed = false;
  if (
    bindings.pushBranch &&
    !bindings.cancelled?.() &&
    !indeterminate &&
    !reports.some((row) => row.reason?.includes('HEAD changed'))
  ) {
    try {
      lastSha ??= await effects.pendingPublish?.();
      if (lastSha !== undefined) {
        await effects.publish(lastSha);
        pushed = true;
      }
    } catch (error) {
      indeterminate = `publish failed: ${String(error)}`;
    }
  }
  return {
    status: 'ok',
    value: {
      package: unit.package,
      fixer: unit.fixer,
      worktree,
      mode: 'fix',
      baseline,
      final: accepted,
      prBranch: branch,
      committed: lastSha !== undefined,
      ...(lastSha === undefined ? {} : { committedSha: lastSha }),
      pushed,
      tasks: reports,
      budgetStopped,
      ...(observationFailures.length === 0 ? {} : { observationFailures }),
      ...(indeterminate === undefined ? {} : { indeterminate }),
    },
  };
}

export type TaskWorker = (
  task: FixTask,
  related: CheckCommand,
  modelSpec?: ModelSpec,
) => { driver: Driver; modelSpec: ModelSpec };

async function scanFailedAttempt(
  git: (args: string[]) => Promise<string>,
  bindings: SweepUnitBindings,
  parent: string,
  sha: string,
  protectTests: boolean,
): Promise<StagePathGateResult> {
  if (bindings.scanPrompt === undefined)
    throw new Error('failed-attempt publication requires the configured denylist scanner');
  const contents = await failedAttemptContents(git, parent, sha);
  const message = await git(['show', '-s', '--format=%B', sha]);
  contents.push({ text: message, path: '.git/cq-failed-commit-message' });
  const patch = await git([
    'diff',
    ...SWEEP_DIFF_FLAGS,
    '--binary',
    '--full-index',
    parent,
    sha,
    '--',
  ]);
  const tamper = await hackDetector({ diff: patch });
  if (tamper.status !== 'ok')
    throw new Error(`failed-attempt tamper scan could not complete: ${tamper.status}`);
  if (tamper.value.length > 0) {
    const finding = tamper.value[0];
    // A positive tamper finding is a REFUSAL OF THIS ATTEMPT, not an
    // infrastructure fault: it is returned so the caller escalates this one
    // task and keeps the unit's verified commits publishable. A scan that
    // cannot complete (above) stays a throw — that one is uncertain.
    return {
      kind: 'protected',
      paths: finding === undefined ? [] : [finding.file],
      message: `failed-attempt tamper gate refused publication${finding === undefined ? '' : ` (${finding.kind} at ${finding.file}:${String(finding.line ?? '?')})`}`,
    };
  }
  await bindings.scanPrompt(`Failed-attempt commit ${sha} publication scan`, contents);
  const paths = await failedAttemptPaths(git, parent, sha);
  return classifyStagePaths(
    paths,
    bindings.stagePathAllowlist,
    bindings.proposeOnly === true,
    protectTests,
  );
}

async function failedAttemptPaths(
  git: (args: string[]) => Promise<string>,
  parent: string,
  sha: string,
): Promise<string[]> {
  const capture = await git([
    'diff',
    ...SWEEP_DIFF_FLAGS,
    '--name-status',
    '-z',
    parent,
    sha,
    '--',
  ]);
  return stagedPathsOf(capture);
}

async function failedAttemptFeedback(
  git: (args: string[]) => Promise<string>,
  attempt: FailedAttempt,
): Promise<{ patch: string; contents: Array<{ text: string; path: string }> }> {
  if ((await git(['rev-parse', '--verify', `refs/heads/${attempt.branch}`])) !== attempt.sha)
    throw new Error('prior failed-attempt branch no longer matches its recorded ordinal');
  const commitLine = await git(['rev-list', '--parents', '-n', '1', attempt.sha]);
  const [sha, parent, extra] = commitLine.split(/\s+/);
  if (sha !== attempt.sha || parent === undefined || extra !== undefined)
    throw new Error('prior failed-attempt commit has invalid parentage');
  const contents = await failedAttemptContents(git, parent, attempt.sha);
  const patch = await git([
    'diff',
    ...SWEEP_DIFF_FLAGS,
    '--binary',
    '--full-index',
    parent,
    attempt.sha,
    '--',
  ]);
  if (Buffer.byteLength(patch, 'utf8') > FAILED_ATTEMPT_SCAN_TOTAL_CAP_BYTES)
    throw new Error('prior failed-attempt patch exceeds the feedback cap');
  return { patch, contents };
}

async function failedAttemptContents(
  git: (args: string[]) => Promise<string>,
  parent: string,
  sha: string,
): Promise<Array<{ text: string; path: string }>> {
  const capture = await git([
    'diff',
    ...SWEEP_DIFF_FLAGS,
    '--name-status',
    '-z',
    parent,
    sha,
    '--',
  ]);
  const tokens = capture.split('\0').filter((token) => token !== '');
  const contents: Array<{ text: string; path: string }> = [];
  let totalBytes = 0;
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const path = tokens[index++];
    if (status === undefined || path === undefined || !['A', 'D', 'M', 'T'].includes(status))
      throw new Error('failed-attempt diff has an invalid or unsupported path record');
    if (path.startsWith('/') || path.split(/[\\/]/).some((segment) => segment === '..'))
      throw new Error('failed-attempt diff contains a path outside the repository');
    const revisions = status === 'A' ? [sha] : status === 'D' ? [parent] : [parent, sha];
    for (const revision of revisions) {
      const sizeText = await git(['cat-file', '-s', `${revision}:${path}`]);
      if (!/^\d+$/.test(sizeText))
        throw new Error(`cannot determine failed-attempt size for ${path}`);
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size > FAILED_ATTEMPT_SCAN_FILE_CAP_BYTES)
        throw new Error(`failed-attempt file exceeds the scan cap: ${path}`);
      totalBytes += size;
      if (totalBytes > FAILED_ATTEMPT_SCAN_TOTAL_CAP_BYTES)
        throw new Error('failed-attempt contents exceed the total scan cap');
      const text = await git(['show', `${revision}:${path}`]);
      if (
        Buffer.byteLength(text, 'utf8') > FAILED_ATTEMPT_SCAN_FILE_CAP_BYTES ||
        text.includes('\0') ||
        text.includes('\uFFFD')
      )
        throw new Error(`failed-attempt file is too large or not safely scannable text: ${path}`);
      contents.push({ text, path });
    }
  }
  return contents;
}

/** Pin a failed attempt as an inspectable commit without moving the unit branch. */
export async function commitFailedAttempt(
  git: (args: string[]) => Promise<string>,
  input: FailedAttemptInput,
): Promise<FailedAttempt> {
  const identity = Buffer.from(
    JSON.stringify([
      input.kindIdentity ?? input.kind,
      input.slugIdentity ?? input.slug,
      input.taskIdentity ?? input.task,
    ]),
  ).toString('base64url');
  const component = (display: string, raw: string, digits: number): string => {
    const readable = display.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'id';
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, digits);
    return `${readable.slice(0, 79 - digits)}-${digest}`;
  };
  const tree = await git(['write-tree']);
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('could not write failed-attempt tree');
  if (!Number.isSafeInteger(input.firstAttempt) || input.firstAttempt < 1)
    throw new Error('failed attempt number must be a positive safe integer');
  let digits = 16;
  let attempt = input.firstAttempt;
  for (;;) {
    const base = `${input.runPrefix}/failed/${component(input.kind, input.kindIdentity ?? input.kind, digits)}/${component(input.slug, input.slugIdentity ?? input.slug, digits)}/${component(input.task, input.taskIdentity ?? input.task, digits)}`;
    const existing = await git(['for-each-ref', '--format=%(refname)', `refs/heads/${base}/`]);
    let conflict = false;
    const occupied = new Set<number>();
    for (const ref of existing.split('\n').filter(Boolean)) {
      const suffix = ref.slice(`refs/heads/${base}/`.length);
      if (!ref.startsWith(`refs/heads/${base}/`) || !/^a[1-9][0-9]*$/.test(suffix)) {
        conflict = true;
        break;
      }
      const message = await git(['show', '-s', '--format=%B', ref]);
      const identityTrailers = message
        .split('\n')
        .filter((line) => line.startsWith('Cq-Ref-Identity:'));
      if (identityTrailers.length !== 1 || identityTrailers[0] !== `Cq-Ref-Identity: ${identity}`) {
        conflict = true;
        break;
      }
      occupied.add(Number(suffix.slice(1)));
    }
    if (conflict) {
      if (digits === 64) throw new Error('failed attempt ref identity conflicts at full digest');
      digits = Math.min(64, digits + 8);
      attempt = input.firstAttempt;
      continue;
    }
    while (occupied.has(attempt)) attempt++;
    if (!Number.isSafeInteger(attempt)) throw new Error('failed attempt number exhausted');
    const branch = `${base}/a${String(attempt)}`;
    const reasonLine = input.reason.replace(/[\r\n]+/g, ' ').trim() || 'task attempt refused';
    const taskLine = input.task.replace(/[\r\n]+/g, ' ');
    const subject = `cq-failed(${input.outcome}): ${taskLine}${input.pushFailed ? ' [skip ci]' : ''}`;
    const message = `${subject}\n\n${reasonLine}\n\n${formatCqTrailers([
      ['Cq-Run', input.runPrefix],
      ['Cq-Unit', `${input.kind}/${input.slug}`],
      ['Cq-Task', taskLine],
      ['Cq-Ref-Identity', identity],
      ['Cq-Attempt', String(attempt)],
      ['Cq-Tier', input.tier],
      ['Cq-Model', `${input.model.provider}/${input.model.model}`],
      ['Cq-Gate', input.gate],
      ['Cq-Outcome', input.outcome],
    ])}`;
    const sha = await git([
      '-c',
      'user.name=CQ fix engine',
      '-c',
      'user.email=cq-fix-engine@invalid',
      'commit-tree',
      tree,
      '-p',
      input.parent,
      '-m',
      message,
    ]);
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('could not create failed-attempt commit');
    try {
      await git(['update-ref', `refs/heads/${branch}`, sha, '0'.repeat(tree.length)]);
      return { branch, sha };
    } catch (error) {
      try {
        await git(['rev-parse', '--verify', `refs/heads/${branch}`]);
        // A concurrent writer won this exact ref. Recheck its recorded identity.
        // Only a matching identity may consume the next attempt number.
      } catch {
        throw error;
      }
    }
  }
}

function failedGateOf(
  validation: ValidationVerdict | undefined,
  reason: string,
): FailedAttemptGate {
  if (validation?.gates.some((gate) => gate.gate === 'tamper' && gate.verdict !== 'pass'))
    return 'tamper';
  if (validation?.gates.some((gate) => gate.gate === 'commit' && gate.verdict !== 'pass'))
    return 'commit';
  if (validation?.gates.some((gate) => gate.gate === 'paths' && gate.verdict !== 'pass'))
    return 'path-policy';
  if (validation?.gates.some((gate) => gate.gate === 'broader' && gate.verdict !== 'pass'))
    return 'broader';
  if (validation?.gates.some((gate) => gate.gate === 'related' && gate.verdict !== 'pass'))
    return 'related';
  if (/budget/i.test(reason)) return 'budget';
  return 'none';
}
