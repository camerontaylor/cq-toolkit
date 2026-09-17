// F4 slice 3 — tests for the shipped merge-prs plan module and the merge
// family registry (src/plans/merge-prs.ts + src/ops/merge/registry.ts).
//
// Pinned here:
//   1. THE PLAN SHAPE: makeMergePrsPlan authors exactly one job naming
//      'merge.runPrs' with the input carried verbatim; the id is stable.
//   2. THE SHIPPED ENTRY: name 'merge-prs'; its importer resolves the
//      schema-valid EMPTY run — the job input parses against the registry's
//      RunMergePrsInputSchema, proving the discovery default dispatches
//      without a vendor name.
//   3. FILE DISCOVERY: getPlan('merge-prs') finds the module through the
//      plans-root scan (default root), and the central op registry's
//      default-root list() contains all six merge family entries.
//   4. THE LAZY IMPORTER CHAIN, END TO END: the registry entry's importer
//      resolves the default op, and one dispatch over an empty input (empty
//      temp dir, no modelSpec, nothing conflicting) completes ok with empty
//      totals — zero real processes.
//   5. MIRROR FIDELITY spot-checks: the strict mirrors REJECT an unknown
//      key, a verdict outside the frozen union, and an action outside
//      'merge'|'retarget-self'.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { OpResult } from '../../src/kernel/types.js';
import type { MergePrsOutcome } from '../../src/ops/merge/runPrs.js';
import {
  ExecuteMergesInputSchema,
  PlanMergeOrderInputSchema,
  ResolveConflictInputSchema,
  RunMergePrsInputSchema,
} from '../../src/ops/merge/registry.js';
import { MERGE_PRS_PLAN_ID, makeMergePrsPlan, plan } from '../../src/plans/merge-prs.js';
import { getPlan } from '../../src/plans/registry.js';
import { get, list } from '../../src/registry/index.js';

/** The merge family's six op names (the registry must register them all). */
const MERGE_OPS = [
  'merge.classifyPrs',
  'merge.planMergeOrder',
  'merge.executeMerges',
  'merge.resolveConflict',
  'merge.diagnoseMergeFailure',
  'merge.runPrs',
] as const;

describe('makeMergePrsPlan', () => {
  test('one job naming merge.runPrs with the input verbatim; stable id and label', () => {
    const input = { baseBranch: 'trunk', repoRoot: '/repo', prs: [], nowMs: 0 };
    const constructed = makeMergePrsPlan(input);

    expect(constructed.id).toBe(MERGE_PRS_PLAN_ID);
    expect(constructed.id).toBe('merge-prs');
    expect(constructed.label).toBe(
      'merge-prs: classify → plan → execute (+ one conflict-agent pass)',
    );
    expect(constructed.jobs).toEqual([{ id: 'merge-prs-run', op: 'merge.runPrs', input }]);
  });
});

describe('the shipped merge-prs plan entry', () => {
  test("name 'merge-prs'; importer resolves the schema-valid EMPTY run", async () => {
    expect(plan.name).toBe('merge-prs');

    const resolved = await plan.importer();
    expect(resolved.id).toBe(MERGE_PRS_PLAN_ID);
    const job = resolved.jobs[0];
    expect(job?.op).toBe('merge.runPrs');
    // The discovery default parses against the registry-time input schema —
    // it dispatches without a vendor name (modelSpec omitted; no conflicts
    // → the agent is never needed).
    expect(RunMergePrsInputSchema.safeParse(job?.input).success).toBe(true);
    expect(job?.input).toEqual({ repoRoot: '.', baseBranch: 'merge-queue', prs: [] });
  });

  test('getPlan discovers the module by file through the default plans root', async () => {
    const discovered = await getPlan('merge-prs');
    expect(discovered?.name).toBe('merge-prs');
    expect(typeof discovered?.importer).toBe('function');
  });
});

describe('the merge family op registry', () => {
  test('the central default-root list contains all six merge entries', async () => {
    const names = (await list()).map((entry) => entry.name);
    for (const name of MERGE_OPS) {
      expect(names).toContain(name);
    }
  });

  test("get('merge.runPrs').inputSchema parses the empty template input", async () => {
    const entry = await get('merge.runPrs');
    if (entry === undefined) throw new Error('no registry entry named merge.runPrs');
    expect(
      entry.inputSchema.safeParse({ repoRoot: '.', baseBranch: 'merge-queue', prs: [] }).success,
    ).toBe(true);
  });

  test("get('merge.resolveConflict') inputSchema: refname rejection at the dispatch boundary", async () => {
    const entry = await get('merge.resolveConflict');
    if (entry === undefined) throw new Error('no registry entry named merge.resolveConflict');
    const parses = (over: Record<string, unknown>): boolean =>
      entry.inputSchema.safeParse({
        pr: 7,
        repoRoot: '/repo',
        headBranch: 'feat/7',
        baseBranch: 'main',
        ...over,
      }).success;

    // A well-formed input parses.
    expect(parses({})).toBe(true);
    // The refname gate is a SCHEMA rule: a hostile branch name is rejected
    // at the dispatch boundary.
    expect(parses({ headBranch: 'topic$(touch x)' })).toBe(false);
    // headBranch === baseBranch === 'main' is NOT schema-rejected — that
    // cross-field refusal is the OP's runtime check (headBranch vs the
    // protected branch), which only exists at op level.
    expect(parses({ headBranch: 'main', baseBranch: 'main' })).toBe(true);
  });

  test('one dispatch smoke through the lazy importer chain: empty run → ok, empty totals', async () => {
    const entry = await get('merge.runPrs');
    if (entry === undefined) throw new Error('no registry entry named merge.runPrs');
    const op = await entry.importer();

    // An empty temp dir as repoRoot: the empty plan never spawns a process
    // (no effect call can reach git), and with no prs there is nothing to
    // conflict, so the resolve op — and the driver behind it — never runs.
    const dir = await mkdtemp(join(tmpdir(), 'merge-prs-plan-'));
    try {
      // The registry entry's op is typed Op<unknown, unknown> (the erased
      // dispatch shape); the cast restores the outcome type this op is
      // known to produce — narrowing below stays honest.
      const result = (await op({
        baseBranch: 'main',
        repoRoot: dir,
        prs: [],
      })) as OpResult<MergePrsOutcome>;
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.firstPass).toEqual({
          merged: [],
          retargeted: [],
          stale: [],
          failed: [],
          blocked: [],
        });
        expect(result.value.secondPass).toBeNull();
        expect(result.value.resolutions).toEqual([]);
        expect(result.value.needsHuman).toEqual([]);
        expect(result.value.diagnosis.needsHuman).toEqual([]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('registry mirror fidelity (spot-checks)', () => {
  test('planMergeOrder mirror: strict on unknown keys and frozen on the verdict union', () => {
    const plannedPr = {
      pr: 7,
      headRefName: 'feat/7',
      baseRefName: 'main',
      state: 'open',
      authorLogin: null,
      classification: {
        verdict: 'eligible',
        reason: 'settle_window_elapsed',
        unresolvedExternalThreads: 0,
      },
      truncated: false,
    };

    expect(
      PlanMergeOrderInputSchema.safeParse({ baseBranch: 'main', prs: [plannedPr] }).success,
    ).toBe(true);
    // Strict: a typo'd key fails loudly instead of being stripped.
    expect(
      PlanMergeOrderInputSchema.safeParse({ baseBranch: 'main', prs: [plannedPr], bogus: true })
        .success,
    ).toBe(false);
    // The verdict enum is the frozen union: an invented word is rejected.
    const invented = {
      ...plannedPr,
      classification: { ...plannedPr.classification, verdict: 'mergeable' },
    };
    expect(
      PlanMergeOrderInputSchema.safeParse({ baseBranch: 'main', prs: [invented] }).success,
    ).toBe(false);
  });

  test('executeMerges mirror: rejects an action outside the frozen merge|retarget-self union', () => {
    const entry = { pr: 7, action: 'merge', basePr: null, depth: 0 };
    const validPlan = { order: [entry], needsHuman: [], baseBranch: 'main' };

    expect(ExecuteMergesInputSchema.safeParse({ plan: validPlan, repoRoot: '/repo' }).success).toBe(
      true,
    );
    // I3's only method is the merge commit: 'squash' is not in the frozen
    // action union and must fail the mirror before any op can see it.
    const squashed = { ...validPlan, order: [{ ...entry, action: 'squash' }] };
    expect(ExecuteMergesInputSchema.safeParse({ plan: squashed, repoRoot: '/repo' }).success).toBe(
      false,
    );
    const retargeted = { ...validPlan, order: [{ ...entry, action: 'retarget-self' }] };
    expect(
      ExecuteMergesInputSchema.safeParse({ plan: retargeted, repoRoot: '/repo' }).success,
    ).toBe(true);
  });

  // TWIN PARITY REQUIREMENT: the registry's ResolveConflictInputSchema is a
  // hand-inlined twin of resolveConflict.ts's conservativeRefname gate (the
  // lazy rule forbids importing the op module's builder) — this test pins
  // the SAME accept/reject set on BOTH fields, so the dispatch boundary
  // never loosens behind the op's back.
  test('conflict agent twin: the SAME conservative refname gate as the op module', () => {
    const parses = (over: Record<string, unknown>): boolean =>
      ResolveConflictInputSchema.safeParse({
        pr: 7,
        repoRoot: '/repo',
        headBranch: 'feat/7',
        baseBranch: 'main',
        ...over,
      }).success;

    expect(parses({ headBranch: 'feature/x-2.0' })).toBe(true);
    expect(parses({ baseBranch: 'feature/x-2.0' })).toBe(true);
    // The injection class.
    expect(parses({ headBranch: 'topic$(touch x)' })).toBe(false);
    expect(parses({ baseBranch: 'topic$(touch x)' })).toBe(false);
    // Refname hygiene: leading dash and '..' sequence.
    expect(parses({ headBranch: '-lead' })).toBe(false);
    expect(parses({ baseBranch: 'a..b' })).toBe(false);
  });

  // TWIN PARITY extended to the candidate fields: the composition's
  // stack-graph branch names are prompt-interpolated by the resolver too,
  // so MergePrsCandidateSchema's headRefName/baseRefName carry the SAME
  // conservative gate as the conflict agent's input.
  test('runPrs twin: candidate headRefName/baseRefName carry the refname gate', () => {
    const candidate = {
      pr: 7,
      headRefName: 'feat/7',
      baseRefName: 'main',
      state: 'open',
      authorLogin: null,
      draft: false,
      mergeState: 'CLEAN',
      truncated: false,
      threads: [],
      reviews: [],
      issueComments: [],
      lastCommitAt: '2026-01-01T00:00:00Z',
    };
    const parses = (over: Record<string, unknown>): boolean =>
      RunMergePrsInputSchema.safeParse({
        baseBranch: 'main',
        repoRoot: '/repo',
        prs: [{ ...candidate, ...over }],
      }).success;

    expect(parses({})).toBe(true);
    expect(parses({ headRefName: 'topic$(touch x)' })).toBe(false);
    expect(parses({ baseRefName: 'a..b' })).toBe(false);
  });
});

describe('plans barrel surface (review-debt #147)', () => {
  test('the merge-prs builder resolves through src/plans/index.js and is callable', async () => {
    // Imported from the BARREL — the supported-API path SDK consumers take.
    const { makeMergePrsPlan: barrelBuild } =
      (await import('../../src/plans/index.js')) as typeof import('../../src/plans/index.js');
    const input = { baseBranch: 'trunk', repoRoot: '/repo', prs: [], nowMs: 0 };
    const constructed = barrelBuild(input);
    expect(constructed.id).toBe(MERGE_PRS_PLAN_ID);
    expect(constructed.jobs).toEqual([{ id: 'merge-prs-run', op: 'merge.runPrs', input }]);
  });
});
