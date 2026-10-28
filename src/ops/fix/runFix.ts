import {
  createEscalationState,
  nextEscalation,
  recordFixedFailures,
  rescueAllocation,
  type EscalationState,
} from './escalation.js';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { z } from 'zod';
import { createDriverFactory, type DriverFactory } from '../../driver/factory.js';
import type { Usage } from '../../driver/types.js';
import { createGovernor, currentJobContext } from '../../kernel/governor.js';
import { runPlan, type OpRegistryView } from '../../kernel/runner.js';
import type { OpRegistryEntry, OpResult, RunReport } from '../../kernel/types.js';
import { list } from '../../registry/index.js';
import { buildSweepPlan, sweepPlannerInput, SWEEP_PLAN_JOB_IDS } from '../../plans/sweep.js';
import {
  parseCqConfig,
  resolveCqConfigDefaults,
  requireAgenticTokenBudget,
} from '../analyze/index.js';
import {
  makePlanSweep,
  makeSubprocessSweepPlannerDeps,
  type PlanSweepReport,
} from '../sweep/planSweep.js';
import { SweepUnitDispatchInputSchema } from '../sweep/registry.js';
import { isScopedEslintTemplate } from '../sweep/tasks.js';
import {
  bindingsFromDispatch,
  makeSweepUnitOp,
  readCommittedMarkers,
  sweepUnitSegments,
  type SweepUnitDispatchInput,
  type SweepUnitReport,
} from '../sweep/unit.js';
import type { AssemblePrsInput } from '../pr/assemblePrs.js';
import type { FixTaskReport, TaskAttempt } from '../sweep/taskLoop.js';
import type { FixRunInputSchema } from './registry.js';
import {
  fixRunCounters,
  isNoArtifactFailure,
  neverStartedRow,
  plannedTaskRowOf,
  unitLabelOf,
  type FixRunCounters,
  type FixTaskOutcome,
  type PlannedTaskRow,
} from './report.js';
import { makePortableReviewScanner, type DiffSecretScanner } from '../dev/denylist.js';
import { makeSubprocessDevEffects } from '../dev/effects.js';

export type FixRunInput = z.input<typeof FixRunInputSchema>;
export interface FixRunReport {
  source: 'tests' | 'static';
  runPrefix: string;
  reportPath: string;
  verdict: 'pass' | 'fail' | 'needs-human';
  units: Array<{ jobId: string; result: OpResult<SweepUnitReport>; report?: SweepUnitReport }>;
  tasks: FixTaskReport[];
  failed: Array<
    | {
        unit: string;
        task: string;
        outcome: 'unfixed' | 'escalated-to-human';
        gate: import('../sweep/taskLoop.js').FailedAttemptGate;
        reason: string;
        branch: string;
        sha: string;
      }
    | { unit: string; task: string; outcome: FixTaskOutcome; gate: 'none'; reason: string }
  >;
  /** Every planned unit of work with its outcome, evidence and counters. */
  planned: PlannedTaskRow[];
  /** Explicit denominators over `planned` (see {@link FixRunCounters}). */
  counters: FixRunCounters;
  fixesPerRun: number;
  usage: Usage;
  wallMs: number;
  run?: RunReport;
  assembly?: RunReport;
  escalation?: Omit<EscalationState, 'events'> & {
    rescuePool: number;
    events: Array<EscalationState['events'][number] & { attempts: TaskAttempt[] }>;
  };
}
export type FixRunResult = OpResult<FixRunReport> & { report?: FixRunReport };
export interface FixRunDeps {
  drivers?: DriverFactory;
  registry?: OpRegistryView;
  /** Test seam for the mandatory pre-upload scan of each complete PR body. */
  prBodyScanner?: DiffSecretScanner;
}

async function scanPrBodyForUpload(scanner: DiffSecretScanner, body: string): Promise<void> {
  const component = { component: 'fix-pr-body', path: 'pr-body.md', text: body };
  const scans = await scanner([component]);
  if (
    scans.length !== 1 ||
    scans[0]?.component !== component.component ||
    !Array.isArray(scans[0].hits)
  )
    throw new Error('PR body denylist scanner returned an incomplete result');
  const hits = scans[0].hits;
  if (hits.length > 0) {
    const evidence = hits
      .map(
        (hit) => `${hit.ruleId} at line${hit.lines.length === 1 ? '' : 's'} ${hit.lines.join(',')}`,
      )
      .join('; ');
    throw new Error(`PR body upload refused by denylist scan: ${evidence}`);
  }
}

const execFileAsync = promisify(execFile);

async function githubCompareBase(repoRoot: string, base: string): Promise<string | undefined> {
  try {
    const [{ stdout: remote }, { stdout: revision }] = await Promise.all([
      execFileAsync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      }),
      execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--verify', `${base}^{commit}`], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
      }),
    ]);
    return githubCompareBaseUrl(remote.trim(), revision.trim());
  } catch {
    return undefined;
  }
}

export function githubCompareBaseUrl(remote: string, revision: string): string | undefined {
  const match =
    /^(?:https?:\/\/|ssh:\/\/git@)github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote) ??
    /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (!match?.[1] || !/^[0-9a-f]{40,64}$/.test(revision)) return undefined;
  const safeRef = (ref: string) => encodeURIComponent(ref).replaceAll('%2F', '/');
  return `https://github.com/${match[1]}/compare/${safeRef(revision)}...`;
}

/** Two-phase sweep composition; no kernel policy or taxonomy changes. */
export function makeFixRun(deps: FixRunDeps = {}) {
  return async (input: FixRunInput): Promise<FixRunResult> => {
    const start = Date.now();
    const parentSignal = currentJobContext()?.signal;
    const repoRoot = resolve(input.repoRoot);
    const runPrefix = input.runPrefix ?? `cq/fix-${randomUUID()}`;
    const journalDir = resolve(
      input.journalDir ?? resolve(repoRoot, '..', '.cq-fix-runs', randomUUID()),
    );
    const report: FixRunReport = {
      source: input.source,
      runPrefix,
      reportPath: resolve(journalDir, `fix-run-report-${randomUUID()}.json`),
      verdict: 'needs-human',
      units: [],
      tasks: [],
      failed: [],
      planned: [],
      counters: {
        planned: 0,
        attempted: 0,
        fixed: 0,
        skipped: 0,
        unresolved: 0,
        rescueAttempts: 0,
        rescueFixes: 0,
      },
      fixesPerRun: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      wallMs: 0,
    };
    let escalation = createEscalationState();
    let escalationPolicy: Parameters<typeof rescueAllocation>[1] | undefined;
    const unstartedUnits: Array<{
      unit: SweepUnitDispatchInput;
      segments: { kind: string; slug: string; branch: string };
      reason: string;
    }> = [];
    const collected = new Map<string, SweepUnitReport>();
    const finish = async (
      status: 'ok' | 'failed' | 'needs-human',
      detail = '',
    ): Promise<FixRunResult> => {
      report.verdict = status === 'ok' ? 'pass' : status === 'failed' ? 'fail' : 'needs-human';
      if (report.tasks.length === 0)
        report.tasks = [...collected.values()].flatMap((unit) => unit.tasks ?? []);
      report.failed = report.tasks.flatMap((task) => {
        const attempts = (task.rounds ?? []).filter((round) => round.failedAttempt !== undefined);
        if (attempts.length > 0)
          return attempts.map((round) => ({
            unit: unitLabelOf(task.branch),
            task: task.task.id,
            outcome: round.outcome ?? (task.outcome === 'fixed' ? 'unfixed' : task.outcome),
            gate: round.gate ?? 'none',
            reason: round.reason,
            branch: round.failedAttempt!.branch,
            sha: round.failedAttempt!.sha,
          }));
        return task.failedAttempt === undefined
          ? []
          : [
              {
                unit: unitLabelOf(task.branch),
                task: task.task.id,
                outcome: task.outcome === 'fixed' ? 'unfixed' : task.outcome,
                gate: 'none' as const,
                reason: task.reason ?? 'failed attempt',
                branch: task.failedAttempt.branch,
                sha: task.failedAttempt.sha,
              },
            ];
      });
      // Every planned unit of work is accounted for: tasks the units planned,
      // plus one branchless row per planned unit that never ran. Unfixed
      // branchless rows join the legacy `failed` evidence so the local JSON
      // and the PR summary name every outstanding unit (no commit URL is
      // invented where no attempt left a branch).
      report.planned = report.tasks
        .map(plannedTaskRowOf)
        .concat(
          unstartedUnits.map((entry) =>
            neverStartedRow(entry.segments, entry.unit.package, entry.reason),
          ),
        );
      report.counters = fixRunCounters(report.planned);
      for (const row of report.planned) {
        const branchless = row.failures.filter(isNoArtifactFailure);
        if (row.outcome !== 'fixed' && branchless.length > 0)
          report.failed.push(
            ...branchless.map((failure) => ({
              unit: failure.unit,
              task: failure.task,
              outcome: failure.outcome,
              gate: failure.gate,
              reason: failure.reason,
            })),
          );
      }
      report.fixesPerRun = report.tasks.filter((task) => task.outcome === 'fixed').length;
      // Sum landed invocation evidence even when governance replaces a job result.
      report.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const task of report.tasks)
        for (const attempt of task.attempts) {
          if (!attempt.usage) continue;
          report.usage.input += attempt.usage.input;
          report.usage.output += attempt.usage.output;
          report.usage.cacheRead += attempt.usage.cacheRead;
          report.usage.cacheWrite += attempt.usage.cacheWrite;
          if (attempt.usage.reasoning !== undefined)
            report.usage.reasoning = (report.usage.reasoning ?? 0) + attempt.usage.reasoning;
        }
      if (escalationPolicy)
        report.escalation = {
          ...escalation,
          events: escalation.events.map((event) => ({
            ...event,
            attempts: [...collected.values()]
              .filter((unit) => unit.package === event.package)
              .flatMap((unit) =>
                (unit.tasks ?? []).filter(
                  (row) => `${unit.fixer}:${row.task.signature ?? row.task.id}` === event.task,
                ),
              )
              .flatMap((row) =>
                row.attempts.filter(
                  (attempt) => attempt.tier === event.tier && attempt.attempt === event.attempt,
                ),
              ),
          })),
          rescuePool: rescueAllocation(escalation, escalationPolicy),
        };
      report.wallMs = Date.now() - start;
      try {
        await mkdir(dirname(report.reportPath), { recursive: true });
        await writeFile(report.reportPath, JSON.stringify(report, null, 2) + '\n');
      } catch (error) {
        report.verdict = 'fail';
        return {
          status: 'failed',
          error: `could not persist report at ${report.reportPath}: ${String(error)}`,
          report,
        };
      }
      if (status === 'ok') return { status, value: report };
      const evidence = `${detail}; report: ${report.reportPath}`;
      return status === 'failed'
        ? { status, error: evidence, report }
        : { status, reason: evidence, report };
    };
    try {
      if (parentSignal?.aborted)
        return await finish('needs-human', 'enclosing job cancelled before dispatch');
      const configText = await readFile(resolve(repoRoot, 'cq.json'), 'utf8');
      const parsed = parseCqConfig(configText, repoRoot);
      if (!parsed.ok) return await finish('needs-human', parsed.reason);
      const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as {
        name?: string;
      };
      const policy = resolveCqConfigDefaults(parsed.config, {
        packageName: pkg.name ?? 'root',
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      });
      escalationPolicy = policy.escalation;
      let sharedTokens = 0;
      const remainingWallMs = () => policy.budgets.run.wallMs - (Date.now() - start);
      const refusal = requireAgenticTokenBudget(policy);
      if (refusal) return await finish('needs-human', refusal.reason);
      const maxTokens = policy.budgets.run.maxTokens;
      if (maxTokens === undefined) return await finish('needs-human', 'token budget required');
      const role = policy.roles.worker;
      if (!role) return await finish('needs-human', 'cq.json roles.worker is required');
      const selected =
        input.checks === undefined
          ? undefined
          : Array.isArray(input.checks)
            ? input.checks
            : [input.checks];
      const aliases = { tsc: 'tsc-lines', eslint: 'eslint-json', vitest: 'vitest-json' } as const;
      const available = fixSourceChecks(policy.checks, input.source);
      if (selected?.some((alias) => !available.some((check) => check.adapter === aliases[alias])))
        return await finish(
          'needs-human',
          'requested checks are unavailable for this source; use tsc, eslint or vitest from cq.json',
        );
      const checks = available.filter(
        (check) =>
          selected === undefined || selected.some((alias) => check.adapter === aliases[alias]),
      );
      if (!checks.length)
        return await finish('needs-human', `cq.json has no ${input.source} checks`);
      if (input.source === 'static') {
        if (checks.some((check) => !['tsc-lines', 'eslint-json'].includes(check.adapter)))
          return await finish(
            'needs-human',
            'static source supports tsc-lines and eslint-json checks only',
          );
        if (
          checks.some(
            (check) =>
              check.adapter === 'eslint-json' && !isScopedEslintTemplate(check.relatedArgs),
          )
        )
          return await finish(
            'needs-human',
            'static ESLint requires checks[].relatedArgs with a standalone {files} token replacing the full argv, without broad . or ./ operands (for example ["{files}", "--format=json"])',
          );
      }
      if (
        checks.some(
          (check) =>
            check.command.cwd !== undefined &&
            (check.command.cwd.startsWith('/') ||
              check.command.cwd.includes('\\') ||
              check.command.cwd.split('/').includes('..')),
        )
      )
        return await finish('needs-human', 'check cwd must be repository-relative');
      if (input.pr && input.proposeOnly)
        return await finish('needs-human', 'pr and proposeOnly cannot be combined');
      const config = {
        repoRoot,
        worktreesDir: resolve(journalDir, 'worktrees'),
        runPrefix,
        base: input.base ?? 'HEAD',
        packages: policy.packages,
        selector: input.selector,
        fixers: checks.map((_, index) => `${input.source}-${String(index + 1)}`),
      };
      const planned = await makePlanSweep(makeSubprocessSweepPlannerDeps(repoRoot))(
        sweepPlannerInput(config),
      );
      if (planned.status !== 'ok')
        return await finish(
          planned.status === 'needs-human' ? 'needs-human' : 'failed',
          JSON.stringify(planned),
        );
      const fullPlan = buildSweepPlan(config, planned.value, 'fix-run');
      const plan = {
        ...fullPlan,
        jobs: fullPlan.jobs.filter(
          (job) =>
            job.id !== SWEEP_PLAN_JOB_IDS.assemble && job.id !== SWEEP_PLAN_JOB_IDS.trackerBranch,
        ),
      };
      for (const job of plan.jobs) {
        if (job.op !== 'sweep.unit') continue;
        const unit = job.input as SweepUnitDispatchInput;
        const check = checks[config.fixers.indexOf(unit.fixer)];
        if (!check) throw new Error('unit has no configured check');
        unit.driver = { ...role, budget: { maxTokens, wallClockMs: policy.budgets.step.wallMs } };
        unit.check = { adapter: check.adapter, ...check.command };
        unit.taskLoop = {
          source: input.source,
          pushFailed: input.pushFailed ?? false,
          protectTests: input.protectTests ?? false,
          ...(policy.review.denylistPatternsFile === undefined
            ? {}
            : { denylistPatternsFile: policy.review.denylistPatternsFile }),
          wallMs: policy.budgets.unit.wallMs,
          ...(check.relatedArgs === undefined ||
          (input.source === 'static' && check.adapter === 'tsc-lines')
            ? {}
            : { relatedArgs: check.relatedArgs }),
        };
        unit.push = (input.push ?? false) || (input.pr ?? false);
        unit.proposeOnly = input.proposeOnly ?? false;
        unit.runStateDir = resolve(journalDir, 'state');
      }
      const central = new Map((await list()).map((entry) => [entry.name, entry]));
      const plannerEntry = central.get('sweep.planSweep');
      if (!plannerEntry) throw new Error('sweep.planSweep is not registered');
      central.set('sweep.planSweep', {
        ...plannerEntry,
        importer: async () => {
          const original = await plannerEntry.importer();
          return async (raw) => {
            const result = await original(raw);
            if (result.status === 'ok') {
              const rederived = result.value as PlanSweepReport;
              if (JSON.stringify(rederived.units) !== JSON.stringify(planned.value.units))
                return {
                  status: 'failed',
                  error:
                    'planner fan-out changed after phase A; re-run with fresh planning evidence',
                };
            }
            return result;
          };
        },
      });
      const drivers = deps.drivers ?? createDriverFactory();
      const unitEntry: OpRegistryEntry = {
        name: 'sweep.unit',
        inputSchema: SweepUnitDispatchInputSchema,
        importer: async () => async (raw: unknown) => {
          try {
            const unit = raw as SweepUnitDispatchInput;
            if (parentSignal?.aborted)
              return {
                status: 'needs-human',
                reason: 'enclosing job cancelled before unit dispatch',
              };
            const bindings = bindingsFromDispatch(unit, drivers);
            bindings.taskRunBudget = {
              remainingWallMs,
              remainingTokens: () => maxTokens - sharedTokens,
              reportResult: (worker) => {
                sharedTokens +=
                  worker.usage.input +
                  worker.usage.output +
                  worker.usage.cacheRead +
                  worker.usage.cacheWrite +
                  (worker.usage.reasoning ?? 0);
              },
            };
            bindings.taskEscalation = {
              ...(policy.roles.rescue === undefined ? {} : { rescueModel: policy.roles.rescue }),
              next: (task, progress) => {
                const transition = nextEscalation(escalation, policy.escalation, {
                  ...progress,
                  package: unit.package,
                  task: `${unit.fixer}:${task.signature ?? task.id}`,
                  canRescue: policy.roles.rescue !== undefined,
                  ...(remainingWallMs() <= 0 || sharedTokens >= maxTokens
                    ? { stopReason: 'run token or wall budget exhausted' }
                    : {}),
                });
                escalation = transition.state;
                return transition.decision;
              },
              verified: (before, after) => {
                escalation = recordFixedFailures(escalation, before, after);
              },
            };
            if (parentSignal !== undefined) bindings.cancelled = () => parentSignal.aborted;
            const result = await makeSweepUnitOp(bindings)(unit);
            if (result.status === 'ok')
              collected.set(`${unit.package}\0${unit.fixer}`, result.value);
            else if (
              parentSignal?.aborted ||
              result.status === 'indeterminate' ||
              result.status === 'needs-human' ||
              result.status === 'budget-exhausted'
            )
              unstartedUnits.push({
                unit,
                segments: bindings.segments ?? sweepUnitSegments(bindings.runPrefix, unit),
                reason:
                  result.status === 'indeterminate'
                    ? `unit did not produce a verdict: ${result.detail}`
                    : result.status === 'needs-human'
                      ? `unit stopped for human review: ${result.reason}`
                      : result.status === 'budget-exhausted'
                        ? 'unit halted on a budget bound'
                        : 'enclosing job cancelled before unit dispatch',
              });
            return result;
          } catch (error) {
            return { status: 'needs-human', reason: String(error) };
          }
        },
      };
      const view: OpRegistryView = {
        get: (name) =>
          (deps.registry?.get(name) ?? (name === 'sweep.unit' ? unitEntry : central.get(name))) as
            | OpRegistryEntry<never, never>
            | undefined,
      };
      const abort = new AbortController();
      const runSignal =
        parentSignal === undefined ? abort.signal : AbortSignal.any([parentSignal, abort.signal]);
      const timer = setTimeout(() => abort.abort(), Math.max(0, remainingWallMs()));
      try {
        report.run = await runPlan(
          plan,
          { concurrency: input.concurrency ?? 1, stopOnError: false, journalDir, maxTokens },
          view,
          {
            governor: createGovernor({ maxTokens, perJobWallClockMs: policy.budgets.unit.wallMs }),
            signal: runSignal,
            allowAdvisory: true,
            allowAdvisoryProvenance: 'product',
          },
        );
      } finally {
        clearTimeout(timer);
      }
      // Jobs the run cancelled (an enclosing cancel races dispatch): a job
      // with no journal row is one the runner never dispatched. The blocked
      // set feeds the cancelled path's unstarted rows below.
      const dispatchedJobIds = new Set(report.run.jobs.map((row) => row.jobId));
      const blockedJobIds = new Set(
        plan.jobs.map((job) => job.id).filter((id) => !dispatchedJobIds.has(id)),
      );
      report.units = report.run.jobs
        .filter((row) => row.op === 'sweep.unit')
        .map((row) => {
          const unit = plan.jobs.find((job) => job.id === row.jobId)
            ?.input as SweepUnitDispatchInput;
          const evidence = collected.get(`${unit.package}\0${unit.fixer}`);
          return {
            jobId: row.jobId,
            result: row.result as OpResult<SweepUnitReport>,
            ...(evidence === undefined ? {} : { report: evidence }),
          };
        });
      report.tasks = report.units.flatMap(
        (row) =>
          (row.report ?? (row.result.status === 'ok' ? row.result.value : undefined))?.tasks ?? [],
      );
      for (const row of report.units) {
        const unit = plan.jobs.find((job) => job.id === row.jobId)?.input as SweepUnitDispatchInput;
        if (unit === undefined) continue;
        const known = unstartedUnits.some(
          (entry) => entry.unit.package === unit.package && entry.unit.fixer === unit.fixer,
        );
        if (row.result.status !== 'ok' && !known) {
          unstartedUnits.push({
            unit,
            segments: sweepUnitSegments(runPrefix, unit),
            reason:
              row.result.status === 'failed'
                ? `unit failed before deriving tasks: ${row.result.error}`
                : row.result.status === 'indeterminate'
                  ? `unit did not produce a verdict: ${row.result.detail}`
                  : row.result.status === 'needs-human'
                    ? `unit stopped for human review: ${row.result.reason}`
                    : 'unit halted on a budget bound',
          });
        }
      }
      report.fixesPerRun = report.tasks.filter((task) => task.outcome === 'fixed').length;
      report.usage = report.run.usage ?? report.usage;
      const human =
        parentSignal?.aborted ||
        report.run.stoppedEarly ||
        report.units.some(
          (row) =>
            row.result.status === 'needs-human' ||
            row.result.status === 'budget-exhausted' ||
            (row.result.status === 'ok' && row.result.value.budgetStopped),
        ) ||
        report.tasks.some((task) => task.outcome === 'escalated-to-human');
      if (input.pr && !parentSignal?.aborted) {
        const markers = await readCommittedMarkers(
          repoRoot,
          config.worktreesDir,
          runPrefix,
          resolve(journalDir, 'state'),
        );
        const template = fullPlan.jobs.find((job) => job.id === SWEEP_PLAN_JOB_IDS.assemble);
        const tracker = fullPlan.jobs.find((job) => job.id === SWEEP_PLAN_JOB_IDS.trackerBranch);
        if (template && tracker && markers.length) {
          const assembly = template.input as AssemblePrsInput;
          const compareBase = report.tasks.some((task) => task.failedAttemptPublished)
            ? await githubCompareBase(repoRoot, assembly.base)
            : undefined;
          const packages: typeof assembly.packages = [];
          for (const pkg of assembly.packages.filter((candidate) =>
            markers.some(
              (marker) => marker.branch === candidate.branch && marker.package === candidate.name,
            ),
          )) {
            const unfixed = report.tasks.filter(
              (task) =>
                task.branch === pkg.branch &&
                task.outcome !== 'fixed' &&
                task.failedAttempt !== undefined,
            );
            const lines = unfixed.map((task) => {
              const failed = task.rounds?.find(
                (round) => round.failedAttempt?.branch === task.failedAttempt?.branch,
              );
              const branch = task.failedAttempt!.branch;
              const branchRef =
                task.failedAttemptPublished && compareBase !== undefined
                  ? `[compare](${compareBase}${encodeURIComponent(branch).replaceAll('%2F', '/')})`
                  : `local branch \`${branch}\``;
              return `- \`${task.task.id}\` — ${task.outcome}; ${failed?.gate ?? 'none'}: diagnostic retained in local report; ${branchRef}`;
            });
            // Work the run never reached is named without a fabricated
            // branch or link: branchless rows show their stop reason only.
            const branchless = report.planned.filter(
              (row) =>
                row.outcome !== 'fixed' &&
                row.failures.every(isNoArtifactFailure) &&
                !report.tasks.some(
                  (task) =>
                    task.task.id === row.task.id &&
                    task.outcome !== 'fixed' &&
                    task.failedAttempt !== undefined,
                ),
            );
            const outstanding = branchless.map((row) => {
              const detail = row.failures[0]?.reason ?? row.reason ?? 'not started';
              return `- \`${row.task.id}\` — ${row.outcome}; ${detail}`;
            });
            const unfixedCount = unfixed.length + outstanding.length;
            const section =
              unfixedCount === 0
                ? ''
                : `## Unfixed (${String(unfixedCount)})\n\n${[...lines, ...outstanding].join('\n')}`;
            const body = [pkg.body?.trim(), section].filter(Boolean).join('\n\n');
            const outgoing = {
              ...pkg,
              ...(body.length === 0 ? {} : { body }),
            };
            const scanner =
              deps.prBodyScanner ??
              makePortableReviewScanner(
                repoRoot,
                makeSubprocessDevEffects(repoRoot),
                configText,
                pkg.name,
              );
            try {
              await scanPrBodyForUpload(scanner, outgoing.body ?? '');
            } catch (error) {
              return await finish(
                'needs-human',
                error instanceof Error ? error.message : String(error),
              );
            }
            packages.push(outgoing);
          }
          if (packages.length)
            report.assembly = await runPlan(
              {
                id: 'fix-run-assembly',
                jobs: [
                  {
                    ...tracker,
                    dependsOn: [],
                    input: { ...(tracker.input as object), push: true },
                  },
                  { ...template, input: { ...assembly, packages }, dependsOn: [tracker.id] },
                ],
              },
              { concurrency: 1, stopOnError: false, journalDir },
              view,
              parentSignal === undefined
                ? undefined
                : {
                    governor: createGovernor({ maxTokens }),
                    signal: parentSignal,
                    allowAdvisory: true,
                  },
            );
        }
      }
      if (human || parentSignal?.aborted) {
        if (parentSignal?.aborted) {
          // Distinguish already-accounted non-ok units from jobs the runner
          // never dispatched before the cancel: only the latter get a
          // cancelled row here (the unit seam recorded the former).
          const cancelledIds = new Set(
            plan.jobs
              .filter((job) => job.op === 'sweep.unit')
              .filter((job) => !job.dependsOn?.some((id) => blockedJobIds.has(id)))
              .map((job) => job.id),
          );
          for (const row of report.units)
            if (row.result.status !== 'ok') cancelledIds.delete(row.jobId);
          for (const entry of plan.jobs) {
            if (entry.op !== 'sweep.unit' || !cancelledIds.has(entry.id)) continue;
            const unit = entry.input as SweepUnitDispatchInput;
            const check = checks[config.fixers.indexOf(unit.fixer)];
            if (!check) continue;
            unstartedUnits.push({
              unit,
              segments: sweepUnitSegments(runPrefix, unit),
              reason: 'enclosing job cancelled before unit dispatch',
            });
          }
        }
        return await finish(
          'needs-human',
          parentSignal?.aborted
            ? 'enclosing job cancelled; verified commits retained without publishing'
            : 'run stopped for budget or human review',
        );
      }
      if (
        report.run.jobs.some((row) => row.result.status !== 'ok') ||
        report.units.some((row) => row.report?.indeterminate) ||
        report.tasks.some((task) => task.outcome !== 'fixed') ||
        report.assembly?.jobs.some((row) => row.result.status !== 'ok')
      )
        return await finish('failed', 'one or more tasks or jobs remain unfixed');
      return await finish('ok');
    } catch (error) {
      return await finish('failed', String(error));
    }
  };
}

/**
 * The cq.json checks a fix source may draw on: those of the source's kind,
 * minus the verification-only format, typed-lint and bounded-test checks. These are not
 * something fix.run repairs; it still gates every candidate wherever the
 * full check list runs (review.address validation, dev.check).
 */
export function fixSourceChecks<
  T extends { kind?: string; adapter: string; addressOnly?: boolean },
>(checks: readonly T[], source: string): T[] {
  return checks.filter(
    (check) =>
      check.addressOnly !== true &&
      check.kind === source &&
      !['oxfmt-check', 'oxlint-json', 'test-narrow'].includes(check.adapter),
  );
}
