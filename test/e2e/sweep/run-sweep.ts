// The D4 e2e wiring — the production sweep composition (src/plans/sweep-run.ts:
// phase A planner, phase B expanded graph, rescue lane, fleet gate, marker
// filter, tracker-branch + assemble recomposition, salvage) over REAL
// effects:
//
//   - the planner is sweep.planSweep over its REAL subprocess deps (the
//     production default);
//   - 'sweep.unit' dispatches through its REGISTERED central entry
//     (bindingsFromDispatch → real subprocess worktree effects, the REAL
//     subprocess driver over the input's driver section — the fake agent CLI
//     fixture IS that driver's binary — real probes, the real git push
//     against the scratch repo's LOCAL bare origin);
//   - `pr.assemblePrs` is the ONE override (the injected fake gh — no forge
//     is contacted; tracker-branch creation on a real forge is the deferred
//     WS-K surface, review-debt #173).
//
// Every git leg (worktrees, check.js probes, diffs, commits, pushes) is
// real, in tmpdirs. The journal is the runner's own NDJSON (one file per run
// invocation under journalDir) — the tests read it back as evidence. The
// composition's decisions are pinned in-process by test/plans/sweep-run.test.ts.
import { join } from 'node:path';
import type { Op, OpRegistryEntry } from '../../../src/kernel/types.js';
import type { OpRegistryView } from '../../../src/kernel/runner.js';
import { makeAssemblePrs } from '../../../src/ops/pr/assemblePrs.js';
import type {
  AssemblePrsInput,
  PrCreateRequest,
  PrCreateResult,
  PrEffects,
  PrReadinessSnapshot,
  PrSearchResult,
} from '../../../src/ops/pr/assemblePrs.js';
import { AssemblePrsInputSchema } from '../../../src/ops/pr/registry.js';
import { list } from '../../../src/registry/index.js';
import type { SweepPlanConfig } from '../../../src/plans/sweep.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { SweepUnitCheckConfig, SweepUnitDriverConfig } from '../../../src/ops/sweep/unit.js';
import { runSweep, type SweepRunOutcome } from '../../../src/plans/sweep-run.js';

export { runEventsAt, salvageInterruptedRun } from '../../../src/plans/sweep-run.js';

// ---------------------------------------------------------------------------
// The fake gh seam — an in-memory PrEffects that records its call order
// ---------------------------------------------------------------------------

export interface FakeGh {
  /** The injected seam for makeAssemblePrs. */
  effects: PrEffects;
  /** Every effect call, in order — the tracker-first assertion reads this. */
  calls: string[];
  /** The PRs created, in creation order (numbers allocate 1, 2, 3, …). */
  created: Array<{ number: number; head: string; base: string; title: string; draft: boolean }>;
  /** Body per PR number (the tracker's in-place manifest updates land here). */
  bodies: Map<number, string>;
}

/**
 * An in-memory forge: search by head+base, create, body read/edit, record
 * everything. `headExists` is the forge-SIMULATING check (review-debt #173):
 * when supplied, `createPr` refuses a head that is not on the real remote —
 * so a tracker PR can never be recorded for an unpushed branch.
 */
export function makeFakeGh(opts?: { headExists?: (head: string) => Promise<boolean> }): FakeGh {
  const calls: string[] = [];
  const created: FakeGh['created'] = [];
  const bodies = new Map<number, string>();
  const heads = new Map<string, number>(); // `${head} -> ${base}` → number

  const searchPrByHead = async (head: string, base: string): Promise<PrSearchResult | null> => {
    calls.push(`searchPrByHead ${head} -> ${base}`);
    const number = heads.get(`${head} -> ${base}`);
    return number === undefined ? null : { number, state: 'open', isCrossRepository: false };
  };
  const createPr = async (request: PrCreateRequest): Promise<PrCreateResult> => {
    calls.push(`createPr ${request.head} -> ${request.base}`);
    if (opts?.headExists !== undefined && !(await opts.headExists(request.head))) {
      throw new Error(
        `the fake forge refuses to open a PR for head '${request.head}' — the branch does not exist on the origin`,
      );
    }
    const number = created.length + 1;
    created.push({
      number,
      head: request.head,
      base: request.base,
      title: request.title,
      draft: request.draft,
    });
    heads.set(`${request.head} -> ${request.base}`, number);
    bodies.set(number, request.body ?? '');
    return { number };
  };

  const effects: PrEffects = {
    searchPrByHead,
    createPr,
    editPrBody: async (number, body) => {
      calls.push(`editPrBody #${String(number)}`);
      bodies.set(number, body);
    },
    getPrBody: async (number) => {
      calls.push(`getPrBody #${String(number)}`);
      return bodies.get(number) ?? '';
    },
    comment: async (number, body) => {
      calls.push(`comment #${String(number)} ${body}`);
    },
    getPrReadiness: async (number): Promise<PrReadinessSnapshot> => {
      calls.push(`getPrReadiness #${String(number)}`);
      const draft = created.find((pr) => pr.number === number)?.draft ?? true;
      return {
        checks: { state: 'none' },
        review: { state: 'none' },
        meta: { isDraft: draft, state: 'open', mergeable: 'mergeable', mergeStateStatus: 'clean' },
      };
    },
  };
  return { effects, calls, created, bodies };
}

// ---------------------------------------------------------------------------
// The sweep run — the production composition over the e2e's real effects
// ---------------------------------------------------------------------------

/** Everything one e2e sweep invocation needs; the test owns the scenario. */
export interface RunSweepOpts {
  /** Config-grade sweep inputs (repo, worktrees, naming, manifest, selector). */
  config: SweepPlanConfig;
  /** NDJSON journal dir — one run file per invocation, shared across re-invokes. */
  journalDir: string;
  /** The injected forge (makeFakeGh) — no real gh is ever spawned. */
  gh: PrEffects;
  /** The JSON driver binding (the fake agent CLI + fake endpoint), per unit job. */
  driver: SweepUnitDriverConfig;
  /** The JSON probe binding (the scratch check.js command template), per unit job. */
  check: SweepUnitCheckConfig;
  /** The per-unit fixer prompt TEMPLATE — the scenario steering (faults ride here). */
  promptTemplate?: (unit: WorkUnit) => string;
  /** Push committed branches to the scratch repo's origin; default true. */
  push?: boolean;
  /** Optional staged-path allowlist overlay (the test-fix scope pin). */
  stagePathAllowlist?: { patterns: string[] };
  /**
   * The explicit run-state dir every unit job carries (review-debt #174's
   * trust vouch). Default `<repoRoot>/cq-run-state` — the harness's vouch,
   * outside the worktrees dir. `null` OMITS the field entirely — the derived
   * (driver-reachable) location — so the strand-retry refuses.
   */
  runStateDir?: string | null;
  /** The units dispatch's concurrency; default 1 (the e2e's serial default). */
  concurrency?: number;
}

/** Run the full sweep once through the production composition. */
export async function runSweepPlan(opts: RunSweepOpts): Promise<SweepRunOutcome> {
  // The dispatch view: the CENTRAL registry (sweep.planSweep AND the
  // registered sweep.unit — the e2e exercises the real dispatch path), with
  // the ONE injected seam: pr.assemblePrs over the fake forge.
  const central = new Map((await list()).map((entry) => [entry.name, entry] as const));
  if (!central.has('sweep.unit')) throw new Error('e2e setup: sweep.unit is not registered');
  if (!central.has('pr.assemblePrs'))
    throw new Error('e2e setup: pr.assemblePrs is not registered');
  const overridden = new Map<string, OpRegistryEntry>([
    [
      'pr.assemblePrs',
      {
        name: 'pr.assemblePrs',
        inputSchema: AssemblePrsInputSchema,
        importer: async () =>
          (async (input: AssemblePrsInput) => makeAssemblePrs(opts.gh)(input)) as Op<
            unknown,
            unknown
          >,
      },
    ],
  ]);
  const registry: OpRegistryView = {
    // The bottom instantiation cast (the review-loop's centralRegistryView
    // precedent: unknown-instantiated entries do not widen down to never).
    get: (name) =>
      (overridden.get(name) ?? central.get(name)) as OpRegistryEntry<never, never> | undefined,
  };
  return runSweep(
    {
      config: opts.config,
      journalDir: opts.journalDir,
      driver: opts.driver,
      check: opts.check,
      runStateDir:
        opts.runStateDir === undefined
          ? join(opts.config.repoRoot, 'cq-run-state')
          : opts.runStateDir,
      ...(opts.promptTemplate !== undefined ? { promptTemplate: opts.promptTemplate } : {}),
      ...(opts.push !== undefined ? { push: opts.push } : {}),
      ...(opts.stagePathAllowlist !== undefined
        ? { stagePathAllowlist: opts.stagePathAllowlist }
        : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    },
    // The planner stays the production default: sweep.planSweep over REAL
    // subprocess deps at config.repoRoot.
    { registry },
  );
}
