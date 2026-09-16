// runPrs — the merge-prs pipeline composition (goal F4, ws-f scope item 6):
// classify (F1's table) → plan (F2) → execute (F3) → resolve conflicts
// (F4's agent, bounded-parallel) → re-plan and re-execute ONCE → the
// needs-human union and the post-mortem. The composition owns no git, no
// gh, no transport of its own: mutations ride the injected MergeEffects,
// the conflict agent rides the injected resolve op — testable end to end
// with zero real processes, networks, or filesystems.
//
// WHY EXACTLY TWO PASSES: a resolution that decided 'acted' pushed a
// NORMAL merge commit onto the PR's head branch — the resolution SURVIVES
// on the pushed branch (the same premise as F3's retry doc), so a fresh
// plan can see the branch clean and merge it. One retry is the whole
// budget: the composition is bounded by design (pass cap 2). A resolution
// that decided anything else — or a branch still conflicting at pass 2 —
// lands in needsHuman instead of looping; a human owes the next move.
//
// WHY THE needsHuman ROWS ARE DATA: every row is plain { pr, reason } —
// the CLI layer owns any exit-code mapping (I1: the op never sees exit
// codes), so the composition only carries the frozen taxonomy. Rows are
// pr-sorted and deduped; a pr appears ONCE with the FIRST reason in the
// priority escalation > planner withhold > execution outcome (a decided
// escalation outranks the planner's 'not_eligible' for the same pr — the
// human needs the agent's summary, not the gate that preceded it).
//
// CONCURRENCY SHAPE: the resolve stage is the ONE bounded-parallel stage —
// each resolution is an independent worktree + worker run, capped by
// `resolveConcurrency` (default 2) through p-limit. executeMerges stays
// INTERNALLY SEQUENTIAL in both passes (F3 rule d: same plan + same
// effects behavior → same report, always), so the report determinism
// carries through the composition.
//
// NO RE-GRADING: the conflict set is derived from the F1 classification
// itself (verdict 'conflicting'), NEVER from the planner's reason strings,
// and the planner's decisions are carried whole. The second pass
// re-classifies the candidates AS THEY STAND at pass-2 time: the resolve
// stage's real-world effect (the pushed resolution) is what flips a branch
// DIRTY → CLEAN — the composition fabricates no data and never marks a pr
// eligible by fiat.
//
// DETERMINISM: classify and plan are pure and clock-free; Date.now() is
// read ONCE, here (the composition is the one place the ambient clock is
// allowed — tests inject `nowMs`). Same input + same nowMs → deep-equal
// outcome, always.
import pLimit from 'p-limit';
import type { Driver, ModelSpec } from '../../driver/types.js';
import type { Op, OpResult } from '../../kernel/types.js';
import { classifyPr } from './classifyPrs.js';
import type { PrCandidate } from './classifyPrs.js';
import { executeMerges } from './executeMerges.js';
import type { ExecutionReport } from './executeMerges.js';
import { realMergeEffects } from './effects.js';
import type { MergeEffects } from './effects.js';
import { diagnoseMergeFailure } from './diagnoseMergeFailure.js';
import type { MergeFailureDiagnosis } from './diagnoseMergeFailure.js';
import { planMergeOrder } from './planMergeOrder.js';
import type { PlanMergeResult, PlannedPr } from './planMergeOrder.js';
import { makeResolveConflictOp } from './resolveConflict.js';
import type { ConflictResolutionValue, ResolveConflictInput } from './resolveConflict.js';

/**
 * The default in-flight cap for the resolve stage (two independent
 * worktree+worker runs at a time — enough overlap to hide worktree
 * latency, few enough to keep forge and driver load boring).
 */
export const DEFAULT_RESOLVE_CONCURRENCY = 2;

/** Why a conflicting pr was NOT dispatched to the agent: no ModelSpec was
 * configured. The composition never fabricates a vendor default (the same
 * rule as the resolve op's dispatch gate — this is its upstream copy). */
export const MODEL_SPEC_REQUIRED_REASON =
  'conflict agent requires a modelSpec (model/provider) — none configured';

/**
 * A candidate as the fetch layer delivered it: the full F1 evidence
 * (PrCandidate) PLUS the stack graph edges — what this pr's head branch
 * is, what it proposes to merge into, and whether it is open (closed prs
 * are structure only, exactly as in F2).
 */
export interface MergePrsCandidate extends PrCandidate {
  /** The pr's head branch (git ref name) — the stack graph's node id. */
  headRefName: string;
  /** The branch the pr proposes to merge into — its stack position. */
  baseRefName: string;
  /** Open prs classify and merge; closed prs anchor the stack only. */
  state: 'open' | 'closed';
}

/** The composition's input: the fetched candidates plus the run's
 * configuration. Everything optional has a documented default. */
export interface RunMergePrsInput {
  /** The trunk/queue branch — configuration at the call site. */
  baseBranch: string;
  /** Absolute path of the checked-out repository (the effects target). */
  repoRoot: string;
  /** The fetched candidates, in any array order (planning sorts). */
  prs: MergePrsCandidate[];
  /** Bounded in-flight conflict resolutions; default
   * DEFAULT_RESOLVE_CONCURRENCY; must be an integer >= 1. */
  resolveConcurrency?: number;
  /** executeMerges passthrough (bounded retry per merge action). */
  maxRetries?: number;
  /** resolveConflict passthrough — the branch pushes may never land on. */
  protectedBranch?: string;
  /** resolveConflict passthrough — the agent's wall-clock budget. */
  wallClockMs?: number;
  /**
   * The conflict-agent binding. REQUIRED only when a conflict actually
   * needs the agent: an input with conflicts and no modelSpec diverts
   * those prs to needsHuman instead of dispatching (never a fabricated
   * vendor default).
   */
  modelSpec?: ModelSpec;
  /** resolveConflict passthrough — the SessionStore dir. */
  sessionsDir?: string;
  /** The classify clock; default Date.now() read once at call time (the
   * composition is the one place the ambient clock is allowed; tests
   * inject). */
  nowMs?: number;
}

/** The composition's output: both execution reports, every resolution the
 * agent decided, the needs-human union, and the final report's
 * post-mortem. All plain data — persistable, loggable, exit-code-free. */
export interface MergePrsOutcome {
  /** Pass 1's report — always present. */
  firstPass: ExecutionReport;
  /** Pass 2's report — present IFF at least one conflict resolution
   * decided 'acted' (only acted earns the second pass). */
  secondPass: ExecutionReport | null;
  /** Every conflict resolution the agent was dispatched on, in pr order:
   * 'acted' — the resolved branch was pushed; 'escalate' — a human must
   * take over (summary carries the agent's reason, or the
   * 'conflict agent did not complete: …' text for a non-acted verdict —
   * the composition NEVER hides a non-acted outcome as silent success). */
  resolutions: Array<{ pr: number; decision: 'acted' | 'escalate'; summary: string }>;
  /** The needs-human union — escalations + the FINAL plan's withheld prs +
   * the FINAL report's stale/failed/blocked — pr-sorted, deduped; a pr
   * appears once with the first reason in the priority escalation >
   * planner withhold > execution outcome. Data for the CLI layer (I1). */
  needsHuman: Array<{ pr: number; reason: string }>;
  /** The post-mortem of the FINAL report (pass 2 when it ran, else pass 1). */
  diagnosis: MergeFailureDiagnosis;
}

/** The injected seams. `resolve` is the conflict agent op (slice 1's
 * makeResolveConflictOp bound to the effects/driver/sessionsDir by the
 * caller or by makeRunMergePrsOp); tests inject a recording fake — the
 * whole pipeline then runs with zero real I/O. */
export interface RunMergePrsDeps {
  /** Every git/gh mutation — the SAME seam instance both passes execute
   * through and the resolve op's effects target. */
  effects: MergeEffects;
  /** The conflict agent: ResolveConflictInput → frozen OpResult. */
  resolve: Op<ResolveConflictInput, ConflictResolutionValue>;
  /** executeMerges passthrough (input.maxRetries wins when both are set). */
  maxRetries?: number;
}

/** Stage 1: classify every OPEN candidate through F1's table (the default
 * config — R3 tunes via classify.config, not here); closed candidates
 * carry `classification: null` (stack structure only, per F2). */
const classifyStage = (candidates: MergePrsCandidate[], nowMs: number): PlannedPr[] =>
  candidates.map((candidate) => ({
    pr: candidate.pr,
    headRefName: candidate.headRefName,
    baseRefName: candidate.baseRefName,
    state: candidate.state,
    authorLogin: candidate.authorLogin,
    classification: candidate.state === 'open' ? classifyPr(candidate, nowMs) : null,
    truncated: candidate.truncated,
  }));

/**
 * Run the merge-prs pipeline (see the module doc). Never throws for a
 * pipeline outcome — every not-merged, not-resolved, not-dispatched pr
 * lands in the outcome's data; the one throw is a caller misconfiguration
 * (resolveConcurrency < 1), the same loud-at-entry discipline as the
 * driver's constructor validation.
 */
export async function runMergePrs(
  input: RunMergePrsInput,
  deps: RunMergePrsDeps,
): Promise<MergePrsOutcome> {
  const resolveConcurrency = input.resolveConcurrency ?? DEFAULT_RESOLVE_CONCURRENCY;
  if (!Number.isInteger(resolveConcurrency) || resolveConcurrency < 1) {
    throw new Error(
      `runMergePrs: resolveConcurrency must be an integer >= 1, got ${String(input.resolveConcurrency)}`,
    );
  }
  const nowMs = input.nowMs ?? Date.now();
  const maxRetries = input.maxRetries ?? deps.maxRetries;
  const execute = (plan: PlanMergeResult): Promise<ExecutionReport> =>
    executeMerges({
      plan,
      effects: deps.effects,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    });

  // Stages 1–3: classify → plan → execute (pass 1). The planner's seven
  // fail-closed rules stand untouched; conflicting prs are withheld
  // 'not_eligible' by the planner — carried, never re-graded.
  const planned1 = classifyStage(input.prs, nowMs);
  const plan1 = planMergeOrder({ baseBranch: input.baseBranch, prs: planned1 });
  const firstPass = await execute(plan1);

  // Stage 4: the conflict set — open candidates whose F1 VERDICT is
  // 'conflicting' (exactly the ones the planner withheld as conflicting;
  // derived from the classification, never from a reason string), pr-sorted
  // so the resolutions order is deterministic.
  const resolutions: Array<{ pr: number; decision: 'acted' | 'escalate'; summary: string }> = [];
  const undispatched: Array<{ pr: number; reason: string }> = [];
  let secondPass: ExecutionReport | null = null;
  let finalPlan = plan1;
  let finalReport = firstPass;

  const conflictSet = planned1
    .filter(
      (planned) => planned.state === 'open' && planned.classification?.verdict === 'conflicting',
    )
    .sort((a, b) => a.pr - b.pr);

  if (conflictSet.length > 0) {
    if (input.modelSpec === undefined) {
      // The dispatch gate's upstream copy: no ModelSpec configured → the
      // prs are NOT resolved (no fabricated vendor default); they divert
      // to needsHuman at escalation priority. secondPass stays null.
      for (const candidate of conflictSet) {
        undispatched.push({ pr: candidate.pr, reason: MODEL_SPEC_REQUIRED_REASON });
      }
    } else {
      const { modelSpec } = input;
      // The ONE bounded-parallel stage: each resolution is an independent
      // worktree + worker run; p-limit caps in-flight at resolveConcurrency.
      const limit = pLimit(resolveConcurrency);
      const settled = await Promise.all(
        conflictSet.map((candidate) =>
          limit(
            async (): Promise<{
              candidate: PlannedPr;
              result: OpResult<ConflictResolutionValue>;
            }> => {
              const result = await deps.resolve({
                pr: candidate.pr,
                repoRoot: input.repoRoot,
                headBranch: candidate.headRefName,
                baseBranch: input.baseBranch,
                modelSpec,
                ...(input.protectedBranch !== undefined
                  ? { protectedBranch: input.protectedBranch }
                  : {}),
                ...(input.wallClockMs !== undefined ? { wallClockMs: input.wallClockMs } : {}),
                ...(input.sessionsDir !== undefined ? { sessionsDir: input.sessionsDir } : {}),
              });
              return { candidate, result };
            },
          ),
        ),
      );
      // Record EVERY outcome; only 'acted' is success — a failed,
      // indeterminate, or budget-exhausted verdict escalates with its
      // payload text (the budget-exhausted verdict carries none, so its
      // class name is the text). Never silent, never re-guessed.
      for (const { candidate, result } of settled) {
        if (result.status === 'ok') {
          resolutions.push({
            pr: candidate.pr,
            decision: 'acted',
            summary: result.value.summary,
          });
        } else if (result.status === 'needs-human') {
          resolutions.push({ pr: candidate.pr, decision: 'escalate', summary: result.reason });
        } else {
          const detail =
            result.status === 'failed'
              ? result.error
              : result.status === 'indeterminate'
                ? result.detail
                : 'the conflict agent hit its budget bound';
          resolutions.push({
            pr: candidate.pr,
            decision: 'escalate',
            summary: `conflict agent did not complete: ${detail}`,
          });
        }
      }
    }
  }

  // Stage 5: the second pass — ONLY when at least one resolution acted
  // (only a pushed resolution can change what the next plan sees). The
  // WHOLE open set re-classifies fresh from the candidates as they stand
  // now; the LAST pass — pass cap 2. Anything still conflicting after this
  // is the final plan's 'not_eligible', and the union carries it.
  if (resolutions.some((resolution) => resolution.decision === 'acted')) {
    const planned2 = classifyStage(input.prs, nowMs);
    const plan2 = planMergeOrder({ baseBranch: input.baseBranch, prs: planned2 });
    const second = await execute(plan2);
    secondPass = second;
    finalPlan = plan2;
    finalReport = second;
  }

  // Stage 6: the needs-human union + the final post-mortem. Insertion
  // order IS the priority: escalations (undispatched conflicts first —
  // they were never resolved — then decided escalations), then the final
  // plan's withheld prs, then the final report's execution outcomes; a pr
  // keeps its FIRST reason.
  const byPr = new Map<number, string>();
  const addRow = (pr: number, reason: string): void => {
    if (!byPr.has(pr)) byPr.set(pr, reason);
  };
  for (const row of undispatched) addRow(row.pr, row.reason);
  for (const resolution of resolutions) {
    if (resolution.decision === 'escalate') addRow(resolution.pr, resolution.summary);
  }
  for (const row of finalPlan.needsHuman) addRow(row.pr, row.reason);
  for (const entry of finalReport.stale) addRow(entry.pr, entry.detail);
  for (const entry of finalReport.failed) addRow(entry.pr, entry.error);
  for (const entry of finalReport.blocked) addRow(entry.pr, entry.reason);
  const needsHuman = [...byPr.entries()]
    .map(([pr, reason]) => ({ pr, reason }))
    .sort((a, b) => a.pr - b.pr);

  return {
    firstPass,
    secondPass,
    resolutions,
    needsHuman,
    diagnosis: diagnoseMergeFailure(finalReport),
  };
}

/** Construction-time seams for the DEFAULT op — everything optional; a
 * test injects fakes here, production builds real ones per call. */
export interface MakeRunMergePrsOpDeps {
  /** Default: realMergeEffects built lazily per call from
   * input.repoRoot (+ input.protectedBranch). */
  effects?: MergeEffects;
  /** Default: the resolve op builds its own default SubprocessDriver. */
  driver?: Driver;
  /** Default: input.sessionsDir, else the resolve op's own default. */
  sessionsDir?: string;
}

/**
 * The `merge.prs` op (the registry entry lands in the next slice): the
 * composition with its defaults wired. The effects and the conflict-agent
 * op are built LAZILY PER CALL — the effects target THIS run's repoRoot,
 * and the resolve op binds the SAME effects instance (the executor's
 * mutations and the agent's worktree lifecycle share one seam), plus the
 * caller's driver/sessionsDir seams. Absent optionals are OMITTED
 * (exactOptionalPropertyTypes); an absent driver means the resolve op's
 * own default SubprocessDriver.
 */
export function makeRunMergePrsOp(
  deps?: MakeRunMergePrsOpDeps,
): Op<RunMergePrsInput, MergePrsOutcome> {
  return async (input): Promise<OpResult<MergePrsOutcome>> => {
    const effects =
      deps?.effects ??
      realMergeEffects({
        repoRoot: input.repoRoot,
        ...(input.protectedBranch !== undefined ? { protectedBranch: input.protectedBranch } : {}),
      });
    const sessionsDir = deps?.sessionsDir ?? input.sessionsDir;
    const resolve = makeResolveConflictOp({
      effects,
      ...(deps?.driver !== undefined ? { driver: deps.driver } : {}),
      ...(sessionsDir !== undefined ? { sessionsDir } : {}),
    });
    const outcome = await runMergePrs(input, {
      effects,
      resolve,
      ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
    });
    // The pipeline is total — every not-done pr is DATA in the outcome —
    // so a completed composition is exactly an 'ok' result.
    return { status: 'ok', value: outcome };
  };
}

/** The production op: every dep at its default. */
export default makeRunMergePrsOp();
