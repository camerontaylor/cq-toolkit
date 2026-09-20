// Merge family registry slice — the `merge.classifyPrs`, `merge.planMergeOrder`,
// `merge.executeMerges`, `merge.resolveConflict`, `merge.diagnoseMergeFailure`,
// and `merge.runPrs` op entries, typed against the FROZEN OpRegistryEntry
// (src/kernel/types.ts). Discovery is by this file: the central registry's
// runtime scan of src/ops/* imports every family's `registry.js` and reads its
// `registry` export (src/registry/index.ts header — the family convention).
//
// THE LAZY RULE (gates C1's precedent, kept exactly): module scope imports
// ONLY zod plus type-only imports (erased at compile time) — loading this
// registry never loads an op module; every op is reached through its entry's
// dynamic `import('./<op>.js')` at dispatch. That rule is also why the zod
// mirrors live HERE (the shared spot) rather than being imported from the op
// modules — an op-module schema value would eagerly load the op and its whole
// dependency tree — and why the ModelSpec mirror below is INLINED rather than
// imported from src/kernel/schema.js (a schema value like any other; the
// inline twin is drift-pinned by its `z.ZodType<ModelSpec>` annotation, the
// repo's accepted one-directional freeze check).
//
// DRIFT PINNING: every mirror is annotated `z.ZodType<T>` against the op's
// hand-written input type (type-only import). A schema whose output drifts
// from the type fails typecheck — the mirror cannot loosen silently.
//
// CONFIG IS THE DEFAULT BY DESIGN (merge.classifyPrs): ClassifyPrConfig
// carries RegExp skip/all-clear patterns, which are not JSON, so a
// JSON-dispatched classify runs the shipped defaultClassifyPrConfig. R3's
// policy-as-data pass owns a string-pattern schema later; this entry does not
// guess one.
//
// EFFECTS ARE BOUND PER DISPATCH (merge.executeMerges): the entry's importer
// dynamically imports executeMerges AND realMergeEffects and binds the
// effects seam from the INPUT's plain-JSON config (repoRoot,
// protectedBranch) — the registry entry carries no repo state.
import { z } from 'zod';
import type { ModelSpec } from '../../driver/types.js';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import type { PrCandidate, PrClassification } from './classifyPrs.js';
import type { ExecutionReport } from './executeMerges.js';
import type { MergeFailureDiagnosis } from './diagnoseMergeFailure.js';
import type {
  PlanBlockReason,
  PlanMergeResult,
  PlannedMergeEntry,
  PlannedPr,
} from './planMergeOrder.js';
import type { ResolveConflictInput } from './resolveConflict.js';
import type { MergePrsCandidate, RunMergePrsInput } from './runPrs.js';
import type { RestComment, ReviewSummary, ThreadComment, ReviewThread } from '../review/threads.js';

// ---------------------------------------------------------------------------
// Registry-time mirrors — shared leaves first (compose upward)
// ---------------------------------------------------------------------------

/**
 * The registry-time twin of kernel/schema.js's ModelSpecSchema — inlined
 * because the lazy rule keeps module scope to zod plus erased type imports
 * (a cross-module schema VALUE import is still a value import). Drift is
 * pinned by the annotation: the twin's output must stay assignable to the
 * frozen ModelSpec.
 */
const ModelSpecSchema: z.ZodType<ModelSpec> = z
  .object({
    model: z.string(),
    provider: z.string(),
  })
  .strict();

/** Twin of the shared review vocabulary (src/ops/review/threads.ts). */
export const ThreadCommentSchema: z.ZodType<ThreadComment> = z
  .object({
    authorLogin: z.string().nullable(),
    body: z.string(),
    createdAt: z.string().nullable(),
  })
  .strict();

/** Twin of ReviewThread: the root comment's fields plus the reply chain. */
export const ReviewThreadSchema: z.ZodType<ReviewThread> = z
  .object({
    id: z.string(),
    rootDatabaseId: z.number().int().nullable(),
    path: z.string().nullable(),
    line: z.number().int().nullable(),
    isResolved: z.boolean(),
    isOutdated: z.boolean(),
    authorLogin: z.string().nullable(),
    createdAt: z.string().nullable(),
    body: z.string(),
    replies: z.array(ThreadCommentSchema),
  })
  .strict();

/** Twin of ReviewSummary: the verdict enum is FROZEN — copied verbatim from
 * the hand-written union (a new verdict word must land in both). */
export const ReviewSummarySchema: z.ZodType<ReviewSummary> = z
  .object({
    id: z.string(),
    authorLogin: z.string().nullable(),
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']).nullable(),
    body: z.string(),
    submittedAt: z.string().nullable(),
  })
  .strict();

/** Twin of RestComment. */
export const RestCommentSchema: z.ZodType<RestComment> = z
  .object({
    id: z.number().int(),
    nodeId: z.string().nullable(),
    authorLogin: z.string().nullable(),
    body: z.string(),
    createdAt: z.string().nullable(),
    inReplyToId: z.number().int().nullable(),
  })
  .strict();

/**
 * The concrete PrCandidate object, kept un-annotated so its `.shape` can
 * seed the MergePrsCandidate mirror (the gates CheckRunnerInputObject
 * pattern: the annotated export and the composable object are one schema).
 */
const PrCandidateObject = z
  .object({
    pr: z.number().int().positive(),
    authorLogin: z.string().nullable(),
    draft: z.boolean(),
    mergeState: z.enum(['DIRTY', 'BEHIND', 'CLEAN', 'UNKNOWN', 'HAS_HOOKS', 'BLOCKED']),
    truncated: z.boolean(),
    threads: z.array(ReviewThreadSchema),
    reviews: z.array(ReviewSummarySchema),
    issueComments: z.array(RestCommentSchema),
    lastCommitAt: z.string().nullable(),
  })
  .strict();

/** Twin of PrCandidate (classifyPrs.ts). */
export const PrCandidateSchema: z.ZodType<PrCandidate> = PrCandidateObject;

// ---------------------------------------------------------------------------
// merge.classifyPrs
// ---------------------------------------------------------------------------

/** The JSON-dispatch input of the pure classifier: one candidate + the
 * caller's clock reading (classifyPr steals no time of its own). */
export interface ClassifyPrsInput {
  candidate: PrCandidate;
  nowMs: number;
}

export const ClassifyPrsInputSchema: z.ZodType<ClassifyPrsInput> = z
  .object({
    candidate: PrCandidateSchema,
    nowMs: z.number(),
  })
  .strict();

// ---------------------------------------------------------------------------
// merge.planMergeOrder
// ---------------------------------------------------------------------------

/** Twin of PrClassification — both enums copied EXACTLY from the frozen
 * unions in classifyPrs.ts (first match wins; the words are the contract). */
export const PrClassificationSchema: z.ZodType<PrClassification> = z
  .object({
    verdict: z.enum(['never', 'conflicting', 'awaiting', 'has-issues', 'eligible']),
    reason: z.enum([
      'is_draft',
      'merge_conflicts',
      'merge_state_ambiguous',
      'merge_state_blocked',
      'review_data_truncated',
      'last_commit_unknown',
      'unresolved_external_threads',
      'merge_objection_outstanding',
      'no_acceptable_review',
      'explicit_all_clear',
      'settle_window_elapsed',
      'settle_window_pending',
    ]),
    unresolvedExternalThreads: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Twin of PlannedPr (planMergeOrder.ts).
 *
 * REFNAME ASYMMETRY, deliberate: `headRefName`/`baseRefName` are plain
 * non-empty strings here — NOT the conservative-refname gate the F4
 * dispatch surfaces enforce (MergePrsCandidateSchema +
 * ResolveConflictInputSchema). planMergeOrder is PURE — it interpolates no
 * refname anywhere (ordering is number/graph math), so a hostile refname
 * has no execution surface on this schema; and F2's frozen type predates
 * the gate. The gate lives exactly where a refname can become a command:
 * the F4 dispatch boundary.
 */
export const PlannedPrSchema: z.ZodType<PlannedPr> = z
  .object({
    pr: z.number().int().positive(),
    headRefName: z.string().min(1),
    baseRefName: z.string().min(1),
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .exactOptional(),
    state: z.enum(['open', 'closed']),
    authorLogin: z.string().nullable(),
    classification: PrClassificationSchema.nullable(),
    truncated: z.boolean(),
  })
  .strict();

/** The JSON-dispatch input of the pure planner. */
export interface PlanMergeOrderInput {
  baseBranch: string;
  prs: PlannedPr[];
}

export const PlanMergeOrderInputSchema: z.ZodType<PlanMergeOrderInput> = z
  .object({
    baseBranch: z.string().min(1),
    prs: z.array(PlannedPrSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// merge.executeMerges
// ---------------------------------------------------------------------------

/** Twin of PlanBlockReason — the planner's frozen withhold vocabulary. */
export const PlanBlockReasonSchema: z.ZodType<PlanBlockReason> = z.enum([
  'duplicate_pr',
  'review_data_truncated',
  'unclassified',
  'not_eligible',
  'unresolved_base',
  'stack_cycle',
  'stack_base_needs_human',
]);

/** Twin of PlannedMergeEntry. */
export const PlannedMergeEntrySchema: z.ZodType<PlannedMergeEntry> = z
  .object({
    pr: z.number().int().positive(),
    action: z.enum(['merge', 'retarget-self']),
    basePr: z.number().int().positive().nullable(),
    depth: z.number().int().nonnegative(),
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .exactOptional(),
  })
  .strict();

/** Twin of PlanMergeResult. */
export const PlanMergeResultSchema: z.ZodType<PlanMergeResult> = z
  .object({
    order: z.array(PlannedMergeEntrySchema),
    needsHuman: z.array(
      z.object({ pr: z.number().int().positive(), reason: PlanBlockReasonSchema }).strict(),
    ),
    baseBranch: z.string().min(1),
  })
  .strict();

/** The JSON-dispatch input of the executor: a plan plus the repo config the
 * effects seam binds from (the entry owns no repo state). */
export interface ExecuteMergesInput {
  plan: PlanMergeResult;
  repoRoot: string;
  protectedBranch?: string;
  maxRetries?: number;
}

export const ExecuteMergesInputSchema: z.ZodType<ExecuteMergesInput> = z
  .object({
    plan: PlanMergeResultSchema,
    repoRoot: z.string().min(1),
    protectedBranch: z.string().min(1).exactOptional(),
    maxRetries: z.number().int().min(0).exactOptional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// merge.resolveConflict
// ---------------------------------------------------------------------------

/**
 * The conservative git-refname gate — the REGISTRY-TIME TWIN of
 * resolveConflict.ts's conservativeRefname. A value import of the op
 * module's builder would eagerly load the op module (the lazy rule), so
 * the SAME regex chain is inlined here; both are type-pinned and the
 * twin-parity test in test/plans/mergePrs.test.ts pins the behavioral
 * parity (same accept/reject set on both fields).
 */
const REFNAME_REASON = 'must be a conservative git refname (project branch names)';
const conservativeRefname = (): z.ZodString =>
  z
    .string()
    .max(250, `${REFNAME_REASON}: longer than 250 characters`)
    .regex(
      /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/,
      `${REFNAME_REASON}: must start with a letter, digit, '_' or '.', and use only [A-Za-z0-9._/-] — never a leading '-', a space, or a shell metacharacter ('~', '^', ':', '?', '*', '[', '\\', '$', '@{')`,
    )
    .regex(/^(?!.*\.\.).*$/, `${REFNAME_REASON}: must not contain the '..' sequence`);

/**
 * The registry-time twin of the conflict agent's input (the op module's own
 * MergeConflictInputSchema cannot be imported here — a schema VALUE import
 * would eagerly load the op module, breaking the lazy rule). The `z.ZodType`
 * annotation pins the twin to `ResolveConflictInput`: drift is a typecheck
 * failure, and the dispatch seam re-validates through THIS schema before the
 * op ever runs — which is why the headBranch/baseBranch gate is mirrored
 * HERE (see conservativeRefname above).
 */
export const ResolveConflictInputSchema: z.ZodType<ResolveConflictInput> = z
  .object({
    pr: z.number().int().positive(),
    repoRoot: z.string().min(1),
    headBranch: conservativeRefname(),
    baseBranch: conservativeRefname(),
    conflictFiles: z.array(z.string().min(1)).exactOptional(),
    modelSpec: ModelSpecSchema.exactOptional(),
    wallClockMs: z.number().int().positive().exactOptional(),
    protectedBranch: z.string().min(1).exactOptional(),
    sessionsDir: z.string().min(1).exactOptional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// merge.diagnoseMergeFailure
// ---------------------------------------------------------------------------

/** Twin of ExecutionReport (executeMerges.ts). The blocked bucket's reason
 * is the FROZEN single-value ExecutionBlockReason union — mirrored as the
 * literal, not a bare string (the drift the annotation exists to catch). */
export const ExecutionReportSchema: z.ZodType<ExecutionReport> = z
  .object({
    merged: z.array(z.number().int().positive()),
    retargeted: z.array(z.number().int().positive()),
    stale: z.array(z.object({ pr: z.number().int().positive(), detail: z.string() }).strict()),
    failed: z.array(z.object({ pr: z.number().int().positive(), error: z.string() }).strict()),
    blocked: z.array(
      z
        .object({ pr: z.number().int().positive(), reason: z.literal('blocked_by_ancestor') })
        .strict(),
    ),
  })
  .strict();

/** The JSON-dispatch input of the pure post-mortem. */
export interface DiagnoseMergeFailureInput {
  report: ExecutionReport;
}

export const DiagnoseMergeFailureInputSchema: z.ZodType<DiagnoseMergeFailureInput> = z
  .object({
    report: ExecutionReportSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// merge.runPrs
// ---------------------------------------------------------------------------

/**
 * The registry-time twin of the composition's candidate (runPrs.ts's
 * MergePrsCandidate = PrCandidate + the stack graph), composed from
 * PrCandidateObject.shape — one source for the shared evidence fields, no
 * drift (the gates composition pattern). The stack-graph branch fields
 * carry the SAME conservative refname gate as the conflict agent's input
 * (conservativeRefname above): a candidate's headRefName/baseRefName are
 * interpolated into the resolver's prompt commands, so the dispatch
 * boundary refuses hostile refnames here too.
 */
export const MergePrsCandidateSchema: z.ZodType<MergePrsCandidate> = z
  .object({
    ...PrCandidateObject.shape,
    headRefName: conservativeRefname(),
    baseRefName: conservativeRefname(),
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .exactOptional(),
    state: z.enum(['open', 'closed']),
  })
  .strict();

export const RunMergePrsInputSchema: z.ZodType<RunMergePrsInput> = z
  .object({
    baseBranch: z.string().min(1),
    repoRoot: z.string().min(1),
    prs: z.array(MergePrsCandidateSchema),
    resolveConcurrency: z.number().int().min(1).exactOptional(),
    maxRetries: z.number().int().min(0).exactOptional(),
    protectedBranch: z.string().min(1).exactOptional(),
    wallClockMs: z.number().int().positive().exactOptional(),
    modelSpec: ModelSpecSchema.exactOptional(),
    sessionsDir: z.string().min(1).exactOptional(),
    nowMs: z.number().exactOptional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// The entries
// ---------------------------------------------------------------------------

/** Merge family op registry (F1 classify; F2 plan; F3 execute + diagnose;
 * F4 conflict agent + composition). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'merge.classifyPrs',
    inputSchema: ClassifyPrsInputSchema,
    importer: async () => {
      const { classifyPr } = await import('./classifyPrs.js');
      const { defaultClassifyPrConfig } = await import('./classify.config.js');
      // The config is the DEFAULT, passed explicitly: ClassifyPrConfig's
      // RegExp patterns are not JSON, so a JSON-dispatched classify runs
      // the shipped table (R3 owns a string-pattern schema later).
      const op: Op<ClassifyPrsInput, PrClassification> = (input) =>
        Promise.resolve({
          status: 'ok',
          value: classifyPr(input.candidate, input.nowMs, defaultClassifyPrConfig),
        });
      return op as Op<unknown, unknown>;
    },
  },
  {
    name: 'merge.planMergeOrder',
    inputSchema: PlanMergeOrderInputSchema,
    importer: async () => {
      const { planMergeOrder } = await import('./planMergeOrder.js');
      const op: Op<PlanMergeOrderInput, PlanMergeResult> = (input) =>
        Promise.resolve({
          status: 'ok',
          value: planMergeOrder({ baseBranch: input.baseBranch, prs: input.prs }),
        });
      return op as Op<unknown, unknown>;
    },
  },
  {
    name: 'merge.executeMerges',
    inputSchema: ExecuteMergesInputSchema,
    importer: async () => {
      const { executeMerges } = await import('./executeMerges.js');
      const { realMergeEffects } = await import('./effects.js');
      const op: Op<ExecuteMergesInput, ExecutionReport> = async (input) => {
        // The effects seam binds PER DISPATCH from the input's plain-JSON
        // repo config — the entry carries no repo state.
        const effects = realMergeEffects({
          repoRoot: input.repoRoot,
          ...(input.protectedBranch !== undefined
            ? { protectedBranch: input.protectedBranch }
            : {}),
        });
        return {
          status: 'ok',
          value: await executeMerges({
            plan: input.plan,
            effects,
            ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
          }),
        };
      };
      return op as Op<unknown, unknown>;
    },
  },
  {
    name: 'merge.resolveConflict',
    inputSchema: ResolveConflictInputSchema,
    importer: async () => (await import('./resolveConflict.js')).default as Op<unknown, unknown>,
  },
  {
    name: 'merge.diagnoseMergeFailure',
    inputSchema: DiagnoseMergeFailureInputSchema,
    importer: async () => {
      const { diagnoseMergeFailure } = await import('./diagnoseMergeFailure.js');
      const op: Op<DiagnoseMergeFailureInput, MergeFailureDiagnosis> = (input) =>
        Promise.resolve({ status: 'ok', value: diagnoseMergeFailure(input.report) });
      return op as Op<unknown, unknown>;
    },
  },
  {
    name: 'merge.runPrs',
    inputSchema: RunMergePrsInputSchema,
    importer: async () => (await import('./runPrs.js')).default as Op<unknown, unknown>,
  },
];
