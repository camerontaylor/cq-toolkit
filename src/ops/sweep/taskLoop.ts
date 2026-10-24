import type { EscalationDecision } from '../fix/escalation.js';
import { unlink } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { Driver, ModelSpec, Usage, WorkerResult } from '../../driver/types.js';
import { currentJobContext } from '../../kernel/governor.js';
import type { OpResult } from '../../kernel/types.js';
import type { SweepWorkspace } from '../../adapters/git/worktreeFor.js';
import type { CheckCommand, FailureSet } from '../gates/checkRunner.js';
import { adapterByName, parseCheckOutput } from '../gates/checkRunner.js';
import { validateFix, type ValidationVerdict } from '../fix/validate.js';
import { classifyStagePaths, stagedPathsOf } from './stagePaths.js';
import {
  tasksFromFailures,
  staticTasksFromFailures,
  staticRelatedCheckCommand,
  taskHasFailures,
  relatedCheckCommand,
  normalizeFailurePaths,
  type FixTask,
} from './tasks.js';
import { fixerBudgetBreach, startFixerDeadline } from './internal/fixerBudget.js';
import type { SweepUnitBindings, SweepUnitReport, UnitProbe } from './unit.js';
import type { WorkUnit } from './planSweep.js';
import { SWEEP_DIFF_FLAGS } from '../../shared/gitDiffFlags.js';

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
    gate?: FailedAttemptGate;
    outcome?: 'unfixed' | 'escalated-to-human';
  }>;
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
  task: string;
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
  let spentTokens = 0;
  const unitStart = Date.now();
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
      delete row.failedAttemptPublished;
      let parent: string | undefined;
      let failedModel: ModelSpec = bindings.modelSpec;
      let finalTree: { final: UnitProbe; treeSha: string } | undefined;
      const recordFailedAttempt = async (
        gate: FailedAttemptGate,
        reason: string,
      ): Promise<FailedAttempt> => {
        if (parent === undefined) throw new Error('failed attempt has no pre-attempt HEAD');
        const segment = (raw: string) => raw.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const kind = bindings.segments?.kind ?? segment(unit.fixer);
        const slug = bindings.segments?.slug ?? segment(unit.package);
        if (!kind || !slug || !segment(task.id))
          throw new Error('failed attempt identity has an empty branch segment');
        await git(['add', '-A', '--', '.']);
        const failedAttempt = await commitFailedAttempt(git, {
          runPrefix: bindings.runPrefix,
          kind,
          slug,
          task: task.id,
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
          priorFailedFeedback = await failedAttemptFeedback(git, priorRound.failedAttempt);
        }
        const prompt = `${bindings.prompt(unit, worktree)}\nTier: ${decision.tier}; attempt: ${decision.attempt}; reason: ${decision.reason}\nPrevious attempt: ${JSON.stringify(priorRound ?? null)}${priorFailedFeedback === undefined ? '' : `\nPrior failed-attempt patch (engine-owned feedback; do not repeat rejected changes):\n${priorFailedFeedback.patch}`}\nTask: ${JSON.stringify(task)}\nRelated argv: ${JSON.stringify([related.command, ...related.args])}\nDo not stage or commit. Return outcome (broken-test, code-bug, todo), summary and confidence (0 to 1) as structured output.`;
        const invoke = async (
          invocation: TaskAttempt['invocation'],
          text: string,
          contents?: Array<{ text: string; path: string }>,
        ): Promise<WorkerResult> => {
          try {
            if (bindings.cancelled?.()) throw new Error('enclosing job cancelled');
            if (bindings.scanPrompt === undefined)
              throw new Error('worker upload scanner is required');
            await bindings.scanPrompt(text, contents);
          } catch {
            row.outcome = 'escalated-to-human';
            throw new Error('worker upload refused: missing, failed or positive denylist scan');
          }
          if (bindings.cancelled?.()) {
            row.outcome = 'escalated-to-human';
            throw new Error('enclosing job cancelled');
          }
          const start = Date.now();
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
            throw new Error('token or wall budget exhausted');
          }
          const deadline = startFixerDeadline(currentJobContext()?.signal, remainingWall);
          const attempt: TaskAttempt = {
            tier,
            attempt: decision.attempt,
            invocation,
            model: resolved.modelSpec,
            wallMs: 0,
            reason: invocation === 'edit' ? decision.reason : 'related-check feedback',
          };
          row.attempts.push(attempt);
          try {
            const worker = await resolved.driver.run(
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
                      : (bindings.toolPolicy?.allow ?? ['read', 'edit', 'run']).filter(
                          (tool) =>
                            ['read', 'edit', 'run'].includes(tool) &&
                            (tool !== 'run' || bindings.taskWorker !== undefined),
                        ),
                  mode: bindings.toolPolicy?.mode === 'none' ? 'none' : 'allowlist',
                },
                sandboxPolicy: bindings.sandboxPolicy ?? { level: 'workspace-write' },
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
            attempt.usage = worker.usage;
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
              row.outcome = 'escalated-to-human';
              throw new Error('enclosing job cancelled');
            }
            if (
              deadline.expired() ||
              (bindings.taskRunBudget?.remainingTokens() ?? Infinity) <= 0 ||
              (bindings.taskRunBudget?.remainingWallMs() ?? Infinity) <= 0 ||
              (bindings.budget.maxTokens !== undefined &&
                spentTokens >= bindings.budget.maxTokens) ||
              fixerBudgetBreach(bindings.budget, worker) !== undefined ||
              worker.stopReason === 'budget' ||
              currentJobContext()?.signal.aborted
            ) {
              budgetStopped = true;
              throw new Error('token or wall budget exhausted');
            }
            if (worker.stopReason !== 'complete')
              throw new Error(`worker stopped: ${worker.stopReason}`);
            return worker;
          } finally {
            attempt.wallMs = Date.now() - start;
            deadline.dispose();
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
          false,
          config.protectTests ?? false,
        );
        if (earlyGate.kind !== 'clean') {
          const verdict = earlyGate.kind === 'protected' ? 'needs-human' : 'fail';
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
        const message = `${subject}: ${output.outcome === 'todo' ? 'todo ' : ''}${output.summary.replace(/[\r\n]/g, ' ')}\n\nConfidence: ${String(output.confidence)}\nTested: configured related and broader checks\nOutcome: ${String(output.outcome)}`;
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
        } catch (cleanupError) {
          indeterminate = `failed-task evidence recording failed: ${String(cleanupError)}`;
          row.reason += `; ${indeterminate}`;
          row.outcome = 'escalated-to-human';
          break taskLoop;
        }
        if (config.pushFailed && row.failedAttempt !== undefined) {
          try {
            await scanFailedAttempt(git, bindings, parent, row.failedAttempt.sha);
            const unsafeRefusal = row.validation?.gates.some(
              (gate) =>
                ['paths', 'tamper', 'commit'].includes(gate.gate) && gate.verdict !== 'pass',
            );
            if (!unsafeRefusal) {
              await git([
                'push',
                'origin',
                `refs/heads/${row.failedAttempt.branch}:refs/heads/${row.failedAttempt.branch}`,
              ]);
              row.failedAttemptPublished = true;
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
): Promise<void> {
  if (bindings.scanPrompt === undefined)
    throw new Error('failed-attempt publication requires the configured denylist scanner');
  const contents = await failedAttemptContents(git, parent, sha);
  await bindings.scanPrompt(`Failed-attempt commit ${sha} publication scan`, contents);
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
  const taskSlug = input.task.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!taskSlug) throw new Error('failed attempt identity has an empty task segment');
  const tree = await git(['write-tree']);
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error('could not write failed-attempt tree');
  let attempt = Math.max(1, input.firstAttempt);
  for (;;) {
    const branch = `${input.runPrefix}/failed/${input.kind}/${input.slug}/${taskSlug}/a${String(attempt)}`;
    const reasonLine = input.reason.replace(/[\r\n]+/g, ' ').trim() || 'task attempt refused';
    const taskLine = input.task.replace(/[\r\n]+/g, ' ');
    const subject = `cq-failed(${input.outcome}): ${taskLine}${input.pushFailed ? ' [skip ci]' : ''}`;
    const message = `${subject}\n\n${reasonLine}\n\nCq-Run: ${input.runPrefix}\nCq-Unit: ${input.kind}/${input.slug}\nCq-Task: ${taskLine}\nCq-Attempt: ${String(attempt)}\nCq-Tier: ${input.tier}\nCq-Model: ${input.model.provider}/${input.model.model}\nCq-Gate: ${input.gate}\nCq-Outcome: ${input.outcome}`;
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
      await git([
        'update-ref',
        `refs/heads/${branch}`,
        sha,
        '0000000000000000000000000000000000000000',
      ]);
      return { branch, sha };
    } catch (error) {
      try {
        await git(['rev-parse', '--verify', `refs/heads/${branch}`]);
        attempt++;
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
