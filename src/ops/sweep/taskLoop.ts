import { randomUUID } from 'node:crypto';
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
  relatedCheckCommand,
  normalizeFailurePaths,
  type FixTask,
} from './tasks.js';
import { fixerBudgetBreach, startFixerDeadline } from './internal/fixerBudget.js';
import type { SweepUnitBindings, SweepUnitReport, UnitProbe } from './unit.js';
import type { WorkUnit } from './planSweep.js';
import { SWEEP_DIFF_FLAGS } from '../../shared/gitDiffFlags.js';

export interface TaskLoopConfig {
  relatedArgs?: string[];
  denylistPatternsFile?: string;
  protectTests?: boolean;
  wallMs?: number;
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
}
export interface FixTaskReport {
  task: FixTask;
  attempts: TaskAttempt[];
  outcome: 'fixed' | 'unfixed' | 'escalated-to-human';
  branch: string;
  commits: string[];
  validation?: ValidationVerdict;
  reason?: string;
  preservedEdits?: { ref: string; sha: string };
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
    bindings.deriveTasks?.(baseline.failureSet) ?? tasksFromFailures(baseline.failureSet);
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
    const remainingWall = (config.wallMs ?? 3_600_000) - (Date.now() - unitStart);
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
  for (const task of tasks) {
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
    if (
      !accepted.failureSet.failures.some(
        (failure) => failure.file !== null && task.files.includes(failure.file),
      )
    ) {
      row.outcome = 'fixed';
      row.reason = 'earlier verified task resolved this file';
      continue;
    }
    let parent: string | undefined;
    let finalTree: { final: UnitProbe; treeSha: string } | undefined;
    try {
      parent = await git(['rev-parse', 'HEAD']);
      const fullCheck = bindings.checkCommand(unit, worktree.path);
      const related = relatedCheckCommand(
        fullCheck,
        task.files.map((file) =>
          relative(fullCheck.cwd ?? worktree.path, resolve(worktree.path, file)),
        ),
        config.relatedArgs,
      );
      const resolved = bindings.taskWorker?.(task, related) ?? {
        driver: bindings.driver,
        modelSpec: bindings.modelSpec,
      };
      const prompt = `${bindings.prompt(unit, worktree)}\nTask: ${JSON.stringify(task)}\nRelated argv: ${JSON.stringify([related.command, ...related.args])}\nDo not stage or commit. Return outcome (broken-test, code-bug, todo), summary and confidence (0 to 1) as structured output.`;
      const invoke = async (
        invocation: TaskAttempt['invocation'],
        text: string,
      ): Promise<WorkerResult> => {
        try {
          if (bindings.cancelled?.()) throw new Error('enclosing job cancelled');
          if (bindings.scanPrompt === undefined)
            throw new Error('worker upload scanner is required');
          await bindings.scanPrompt(text);
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
        );
        const deadline = startFixerDeadline(currentJobContext()?.signal, remainingWall);
        const attempt: TaskAttempt = {
          tier: 'worker',
          attempt: 1,
          invocation,
          model: resolved.modelSpec,
          wallMs: 0,
          reason: invocation === 'edit' ? 'initial task' : 'related-check feedback',
        };
        row.attempts.push(attempt);
        try {
          const worker = await resolved.driver.run(
            {
              prompt: text,
              modelSpec: resolved.modelSpec,
              workspace: { path: worktree.path },
              budget: { ...bindings.budget, wallClockMs: remainingWall },
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
            (bindings.budget.maxTokens !== undefined && spentTokens >= bindings.budget.maxTokens) ||
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
      const first = await invoke('edit', prompt);
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
          verdict: pathGate.kind === 'scope' || pathGate.kind === 'infra' ? 'fail' : 'needs-human',
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
          row.preservedEdits = await preserveTaskEdits(git, branch);
          continue;
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
      const validation = await validateFix({
        baseline: accepted.failureSet,
        related: () => check(related),
        broader: async () => {
          if (parent === undefined) throw new Error('missing task parent');
          const remainingWall = (config.wallMs ?? 3_600_000) - (Date.now() - unitStart);
          if (remainingWall <= 0) {
            budgetStopped = true;
            throw new Error('unit wall budget exhausted');
          }
          finalTree = await effects.broader(parent, remainingWall);
          return finalTree.final.failureSet;
        },
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
      lastSha = sha;
      accepted = finalTree.final;
    } catch (error) {
      if (!bindings.cancelled?.() && Date.now() - unitStart >= (config.wallMs ?? 3_600_000))
        budgetStopped = true;
      row.reason = String(error);
      row.outcome =
        row.outcome === 'escalated-to-human' || row.validation?.verdict === 'needs-human'
          ? 'escalated-to-human'
          : 'unfixed';
      try {
        if (parent === undefined || (await git(['rev-parse', 'HEAD'])) !== parent) {
          row.outcome = 'escalated-to-human';
          row.reason += '; HEAD changed; remaining tasks stopped for human review';
          break;
        }
        if (await git(['status', '--porcelain'])) {
          row.preservedEdits = await preserveTaskEdits(git, branch);
        }
      } catch (cleanupError) {
        indeterminate = `failed-task evidence cleanup failed: ${String(cleanupError)}`;
        row.reason += `; ${indeterminate}`;
        row.outcome = 'escalated-to-human';
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
) => { driver: Driver; modelSpec: ModelSpec };

/** No refs/stash mutation: sibling worktrees retain independent evidence refs. */
export async function preserveTaskEdits(
  git: (args: string[]) => Promise<string>,
  branch: string,
): Promise<{ ref: string; sha: string }> {
  await git(['add', '-A', '--', '.']);
  const sha = await git(['stash', 'create']);
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error('could not snapshot failed task');
  const ref = `refs/cq/fix-run/${branch}/${randomUUID()}`;
  await git(['update-ref', ref, sha]);
  await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
  return { ref, sha };
}
