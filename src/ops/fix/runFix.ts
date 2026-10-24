import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
import {
  bindingsFromDispatch,
  makeSweepUnitOp,
  readCommittedMarkers,
  type SweepUnitDispatchInput,
  type SweepUnitReport,
} from '../sweep/unit.js';
import type { AssemblePrsInput } from '../pr/assemblePrs.js';
import type { FixTaskReport } from '../sweep/taskLoop.js';
import type { FixRunInputSchema } from './registry.js';

export type FixRunInput = z.input<typeof FixRunInputSchema>;
export interface FixRunReport {
  source: 'tests';
  runPrefix: string;
  reportPath: string;
  verdict: 'pass' | 'fail' | 'needs-human';
  units: Array<{ jobId: string; result: OpResult<SweepUnitReport>; report?: SweepUnitReport }>;
  tasks: FixTaskReport[];
  fixesPerRun: number;
  usage: Usage;
  wallMs: number;
  run?: RunReport;
  assembly?: RunReport;
}
export type FixRunResult = OpResult<FixRunReport> & { report?: FixRunReport };
export interface FixRunDeps {
  drivers?: DriverFactory;
  registry?: OpRegistryView;
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
      source: 'tests',
      runPrefix,
      reportPath: resolve(journalDir, `fix-run-report-${randomUUID()}.json`),
      verdict: 'needs-human',
      units: [],
      tasks: [],
      fixesPerRun: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      wallMs: 0,
    };
    const collected = new Map<string, SweepUnitReport>();
    const finish = async (
      status: 'ok' | 'failed' | 'needs-human',
      detail = '',
    ): Promise<FixRunResult> => {
      report.verdict = status === 'ok' ? 'pass' : status === 'failed' ? 'fail' : 'needs-human';
      if (report.tasks.length === 0)
        report.tasks = [...collected.values()].flatMap((unit) => unit.tasks ?? []);
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
      const parsed = parseCqConfig(await readFile(resolve(repoRoot, 'cq.json'), 'utf8'), repoRoot);
      if (!parsed.ok) return await finish('needs-human', parsed.reason);
      const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as {
        name?: string;
      };
      const policy = resolveCqConfigDefaults(parsed.config, {
        packageName: pkg.name ?? 'root',
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      });
      const refusal = requireAgenticTokenBudget(policy);
      if (refusal) return await finish('needs-human', refusal.reason);
      const maxTokens = policy.budgets.run.maxTokens;
      if (maxTokens === undefined) return await finish('needs-human', 'token budget required');
      const role = policy.roles.worker;
      if (!role) return await finish('needs-human', 'cq.json roles.worker is required');
      const checks = policy.checks.filter((check) => check.kind === input.source);
      if (!checks.length)
        return await finish('needs-human', `cq.json has no ${input.source} checks`);
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
        fixers: checks.map((_, index) => `tests-${String(index + 1)}`),
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
          protectTests: input.protectTests ?? false,
          ...(policy.review.denylistPatternsFile === undefined
            ? {}
            : { denylistPatternsFile: policy.review.denylistPatternsFile }),
          wallMs: policy.budgets.unit.wallMs,
          ...(check.relatedArgs === undefined ? {} : { relatedArgs: check.relatedArgs }),
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
            if (parentSignal !== undefined) bindings.cancelled = () => parentSignal.aborted;
            const result = await makeSweepUnitOp(bindings)(unit);
            if (result.status === 'ok')
              collected.set(`${unit.package}\0${unit.fixer}`, result.value);
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
      const timer = setTimeout(() => abort.abort(), policy.budgets.run.wallMs);
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
          const packages = assembly.packages.filter((pkg) =>
            markers.some((marker) => marker.branch === pkg.branch && marker.package === pkg.name),
          );
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
      if (human || parentSignal?.aborted)
        return await finish(
          'needs-human',
          parentSignal?.aborted
            ? 'enclosing job cancelled; verified commits retained without publishing'
            : 'run stopped for budget or human review',
        );
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
