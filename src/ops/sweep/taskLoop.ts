import { randomUUID } from 'node:crypto';
import type { Driver, ModelSpec, Usage, WorkerResult } from '../../driver/types.js';
import { currentJobContext } from '../../kernel/governor.js';
import type { OpResult } from '../../kernel/types.js';
import type { SweepWorkspace } from '../../adapters/git/worktreeFor.js';
import type { CheckCommand, FailureSet } from '../gates/checkRunner.js';
import { adapterByName, parseCheckOutput } from '../gates/checkRunner.js';
import { validateFix, type ValidationVerdict } from '../fix/validate.js';
import { classifyStagePaths, stagedPathsOf } from './stagePaths.js';
import { tasksFromFailures, relatedCheckCommand, type FixTask } from './tasks.js';
import { fixerBudgetBreach, startFixerDeadline } from './internal/fixerBudget.js';
import type { SweepUnitBindings, SweepUnitReport, UnitProbe } from './unit.js';
import type { WorkUnit } from './planSweep.js';
import { SWEEP_DIFF_FLAGS } from '../../shared/gitDiffFlags.js';

export interface TaskLoopConfig {
  relatedArgs?: string[];
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
  broader: (parent: string) => Promise<{ final: UnitProbe; treeSha: string }>;
  commit: (message: string, treeSha: string) => Promise<string>;
  verify: (sha: string, parent: string) => Promise<void>;
  publish: (sha: string) => Promise<void>;
}

export async function runTaskLoop(
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
  let spentTokens = 0;
  const unitStart = Date.now();
  const git = async (args: string[]) => {
    const result = await bindings.git(['-C', worktree.path, ...args]);
    if (result.code !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  const check = async (command: CheckCommand): Promise<FailureSet> => {
    const remainingWall = (config.wallMs ?? 3_600_000) - (Date.now() - unitStart);
    if (remainingWall <= 0) {
      budgetStopped = true;
      throw new Error('unit wall budget exhausted');
    }
    const boundedCommand = {
      ...command,
      timeoutMs: Math.min(command.timeoutMs ?? 600_000, remainingWall),
    };
    const parsed = parseCheckOutput(
      adapterByName(bindings.adapter),
      await bindings.runCheck(boundedCommand),
    );
    if (parsed.verdict !== 'parsed') throw new Error(parsed.reason);
    return parsed.set;
  };
  for (const task of tasks) {
    const row: FixTaskReport = { task, attempts: [], outcome: 'unfixed', branch, commits: [] };
    reports.push(row);
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
    const parent = await git(['rev-parse', 'HEAD']);
    const related = relatedCheckCommand(
      bindings.checkCommand(unit, worktree.path),
      task.files,
      config.relatedArgs,
    );
    let finalTree: { final: UnitProbe; treeSha: string } | undefined;
    try {
      const resolved = bindings.taskWorker?.(task, related) ?? {
        driver: bindings.driver,
        modelSpec: bindings.modelSpec,
      };
      const prompt = `${bindings.prompt(unit, worktree)}\nTask: ${JSON.stringify(task)}\nDo not stage or commit. Return outcome (broken-test, code-bug, todo) and summary as structured output.`;
      const invoke = async (
        invocation: TaskAttempt['invocation'],
        text: string,
      ): Promise<WorkerResult> => {
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
              toolPolicy: { allow: ['read', 'edit', 'run'], mode: 'allowlist' },
              sandboxPolicy: bindings.sandboxPolicy ?? { level: 'workspace-write' },
              outputSchema: {
                name: 'fix.task/v1',
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    outcome: { enum: ['broken-test', 'code-bug', 'todo'] },
                    summary: { type: 'string' },
                  },
                  required: ['outcome', 'summary'],
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
          break;
        }
        throw new Error(pathGate.message ?? 'path refusal');
      }
      const output = second.structuredOutput as
        | { outcome?: unknown; summary?: unknown }
        | undefined;
      if (
        !output ||
        !['broken-test', 'code-bug', 'todo'].includes(String(output.outcome)) ||
        typeof output.summary !== 'string'
      )
        throw new Error('worker returned no valid outcome');
      const subject =
        output.outcome === 'broken-test'
          ? 'fix(test)'
          : output.outcome === 'todo'
            ? 'chore(test)'
            : `fix(${unit.package})`;
      const message = `${subject}: ${output.outcome === 'todo' ? 'todo ' : ''}${output.summary.replace(/[\r\n]/g, ' ')}\n\nConfidence: 1\nTested: configured related and broader checks\nOutcome: ${String(output.outcome)}`;
      const validation = await validateFix({
        baseline: accepted.failureSet,
        related: () => check(related),
        broader: async () => {
          finalTree = await effects.broader(parent);
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
      const sha = await effects.commit(message, finalTree.treeSha);
      await effects.verify(sha, parent);
      row.commits.push(sha);
      row.outcome = 'fixed';
      lastSha = sha;
      accepted = finalTree.final;
    } catch (error) {
      row.reason = String(error);
      row.outcome = row.validation?.verdict === 'needs-human' ? 'escalated-to-human' : 'unfixed';
      if ((await git(['rev-parse', 'HEAD'])) !== parent) {
        row.outcome = 'escalated-to-human';
        row.reason += '; HEAD changed; remaining tasks stopped for human review';
        break;
      }
      if (await git(['status', '--porcelain'])) {
        row.preservedEdits = await preserveTaskEdits(git, branch);
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
    lastSha &&
    bindings.pushBranch &&
    !budgetStopped &&
    !reports.some((row) => row.reason?.includes('HEAD changed'))
  ) {
    await effects.publish(lastSha);
    pushed = true;
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
