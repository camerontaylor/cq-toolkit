// D4 smoke tests — the shipped sweep and test-fix plans (goal D4; ws-i item
// 2: "each shipped plan has a smoke test"). Pinned here:
//   1. DISCOVERY + the smoke claim: both plans are discovered by FILE through
//      the plans-root scan (no registry line) and their importers resolve.
//   2. PLAN SHAPE: both floors parse against the kernel PlanSchema; the
//      floor's planner job input parses the sweep registry's mirror.
//   3. THE EXPANSION CONTRACT: buildSweepPlan embeds the planner report's
//      unit jobs verbatim, re-rooted on the planner job, with ONE
//      pr.assemblePrs job that depends on every unit — and an EMPTY fleet
//      carries NO assemble job (assemblePrs is tracker-first; a zero-package
//      run must never touch a forge).
//   4. THE TEST-FIX PIN: buildTestFixPlan REPLACES the fixer set with the one
//      test-only label — the plan's identity is the restriction (UC §1 row 4)
//      — and validates EVERYWHERE: the report's units AND its embedded unit
//      jobs; a clean-units/foreign-job report is plan corruption, thrown.
//   5. THE FLOOR RUNS: the sweep floor through the real runner + the real
//      sweep registry entry is a harmless pass (empty manifest plans nothing,
//      zero effect calls).
//   6. THE BINDINGS RIDE THE SEAMS: the unit composition's sandboxPolicy
//      binding (default `none`, caller-overridable for production) lands
//      verbatim in the Driver's OpInvocation.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Driver, OpInvocation } from '../../src/driver/types.js';
import { generateScratchRepo } from '../fixtures/scratch-repo/generate.js';
import { PlanSchema } from '../../src/kernel/schema.js';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type { OpRegistryEntry, Plan } from '../../src/kernel/types.js';
import { registry as prRegistry } from '../../src/ops/pr/registry.js';
import {
  AssemblePrsInputSchema,
  EnsureTrackerBranchInputSchema,
} from '../../src/ops/pr/registry.js';
import {
  PlanSweepInputSchema,
  SweepUnitDispatchInputSchema,
} from '../../src/ops/sweep/registry.js';
import type { PlanSweepReport, WorkUnit } from '../../src/ops/sweep/planSweep.js';
import { SWEEP_UNIT_OP } from '../../src/ops/sweep/planSweep.js';
import { registry as sweepRegistry } from '../../src/ops/sweep/registry.js';
import { makeSweepUnitOp, sweepUnitSegments } from '../../src/ops/sweep/unit.js';
import {
  buildSweepPlan,
  SWEEP_PLAN_ID,
  SweepUnitJobOverlay,
  type SweepPlanConfig,
} from '../../src/plans/sweep.js';
import { buildTestFixPlan, TEST_FIX_FIXER, TEST_FIX_PLAN_ID } from '../../src/plans/test-fix.js';
import { getPlan } from '../../src/plans/registry.js';

/** A two-unit planner report as planSweep would have produced it. */
function twoUnitReport(fixer: string = 'fix'): PlanSweepReport {
  const units = [
    { package: 'alpha', fixer, files: ['packages/alpha/test/suite.test.js'] },
    { package: 'beta', fixer, files: ['packages/beta/test/suite.test.js'] },
  ];
  return {
    jobs: units.map((unit) => ({
      id: `sweep-${unit.package}-fix`,
      op: SWEEP_UNIT_OP,
      input: unit,
      dependsOn: [],
    })),
    units,
    suppressed: [],
    needsHuman: [],
  };
}

const CONFIG: SweepPlanConfig = {
  repoRoot: '/repo',
  worktreesDir: 'worktrees',
  runPrefix: 'cq/09-16a',
  base: 'main',
  packages: [
    { name: 'alpha', path: 'packages/alpha' },
    { name: 'beta', path: 'packages/beta' },
  ],
  selector: { mode: 'workspace-all' },
  fixers: ['fix'],
  packageFiles: { alpha: ['packages/alpha/test/suite.test.js'] },
};

describe('plans barrel surface (jZ59o)', () => {
  test('the builder surface resolves through src/plans/index.js and is callable', async () => {
    // Imported from the BARREL — the supported-API path SDK consumers take.
    const {
      buildSweepPlan: barrelBuild,
      buildTestFixPlan: barrelBuildTestFixPlan,
      sweepPlannerInput: barrelPlannerInput,
    } = (await import('../../src/plans/index.js')) as typeof import('../../src/plans/index.js');
    const plan = barrelBuild(CONFIG, twoUnitReport());
    expect(plan.id).toBe(SWEEP_PLAN_ID);
    expect(plan.jobs[0]?.op).toBe('sweep.planSweep');
    expect(() => PlanSweepInputSchema.parse(barrelPlannerInput(CONFIG))).not.toThrow();
    const testFixPlan = barrelBuildTestFixPlan(CONFIG, twoUnitReport(TEST_FIX_FIXER));
    expect(testFixPlan.id).toBe(TEST_FIX_PLAN_ID);
    // The naming contract rides the barrel too.
    expect(sweepUnitSegments('cq/x', { package: '@scope/pkg', fixer: 'fix' }).slug).toBe(
      'scope-pkg',
    );
    for (const job of testFixPlan.jobs.filter((candidate) => candidate.op === 'sweep.unit')) {
      expect((job as { input: { proposeOnly?: boolean } }).input.proposeOnly).toBe(true);
    }
  });
});

describe('sweep + test-fix smoke: discovery and shape (ws-i item 2)', () => {
  test('both plans are discovered by file and their importers resolve', async () => {
    for (const name of [SWEEP_PLAN_ID, TEST_FIX_PLAN_ID]) {
      const entry = await getPlan(name);
      expect(entry, `plan '${name}' discovered`).toBeDefined();
      const resolved = await entry?.importer();
      expect(resolved?.id).toBe(name);
      expect(resolved?.label).toContain('two-phase contract');
    }
  });

  test('both floors parse against the kernel PlanSchema and the registry mirrors', async () => {
    for (const name of [SWEEP_PLAN_ID, TEST_FIX_PLAN_ID]) {
      const plan = await (await getPlan(name))?.importer();
      expect(() => PlanSchema.parse(plan)).not.toThrow();
      const plannerJob = plan?.jobs[0];
      expect(plannerJob?.op).toBe('sweep.planSweep');
      expect(() => PlanSweepInputSchema.parse(plannerJob?.input)).not.toThrow();
      // An empty fleet carries NO assemble job (tracker-first would touch a
      // real forge even for zero packages).
      expect(plan?.jobs).toHaveLength(1);
    }
    // The test-fix floor pins the one test-only fixer label.
    const testFix = (await (await getPlan(TEST_FIX_PLAN_ID))?.importer()) as Plan;
    const testFixPlannerJob = PlanSchema.parse(testFix).jobs[0] as { input: unknown };
    expect(PlanSweepInputSchema.parse(testFixPlannerJob.input).fixers).toEqual([TEST_FIX_FIXER]);
  });

  test('buildSweepPlan: planner job first, unit jobs verbatim, tracker branch then assemble', () => {
    const plan = buildSweepPlan(CONFIG, twoUnitReport());
    expect(plan.id).toBe(SWEEP_PLAN_ID);
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    expect(plan.jobs.map((job) => job.id)).toEqual([
      'sweep-plan',
      'sweep-alpha-fix',
      'sweep-beta-fix',
      'sweep-tracker-branch',
      'sweep-assemble',
    ]);
    expect(plan.jobs[0]?.op).toBe('sweep.planSweep');
    // The planner job's input parses the registry mirror.
    expect(() => PlanSweepInputSchema.parse(plan.jobs[0]?.input)).not.toThrow();
    // Unit jobs: verbatim planner output, re-rooted on the planner job, and
    // their inputs parse the unit schema.
    for (const job of plan.jobs.slice(1, 3)) {
      expect(job.op).toBe(SWEEP_UNIT_OP);
      expect(job.dependsOn).toEqual(['sweep-plan']);
      expect(() => SweepUnitDispatchInputSchema.parse(job.input)).not.toThrow();
    }
    // The tracker-branch leg (review-debt #173): every unit a dependency, and
    // the assembler depends on it (so the head exists before the PR opens).
    const trackerBranch = plan.jobs[3] as {
      id: string;
      op: string;
      input: unknown;
      dependsOn: string[];
    };
    expect(trackerBranch.op).toBe('pr.ensureTrackerBranch');
    expect(trackerBranch.dependsOn).toEqual(['sweep-alpha-fix', 'sweep-beta-fix']);
    expect(EnsureTrackerBranchInputSchema.parse(trackerBranch.input)).toMatchObject({
      repoRoot: '/repo',
      runPrefix: 'cq/09-16a',
      base: 'main',
      branch: 'cq/09-16a/tracker',
    });
    // The assembler: static data, derived branches, the tracker-branch leg a dependency.
    const assemble = plan.jobs[4] as {
      id: string;
      op: string;
      input: unknown;
      dependsOn: string[];
    };
    expect(assemble.op).toBe('pr.assemblePrs');
    expect(assemble.dependsOn).toEqual(['sweep-tracker-branch']);
    const input = AssemblePrsInputSchema.parse(assemble.input);
    expect(input.tracker.branch).toBe('cq/09-16a/tracker');
    expect(input.packages.map((pkg) => pkg.branch)).toEqual([
      sweepUnitSegments('cq/09-16a', { package: 'alpha', fixer: 'fix' }).branch,
      sweepUnitSegments('cq/09-16a', { package: 'beta', fixer: 'fix' }).branch,
    ]);
    expect(input.packages.every((pkg) => pkg.branch.startsWith('cq/09-16a/'))).toBe(true);
  });

  test('buildTestFixPlan REPLACES the fixer set with the test-only label (UC §1 row 4)', () => {
    const plan = buildTestFixPlan(
      { ...CONFIG, fixers: ['evil-fix'] },
      twoUnitReport(TEST_FIX_FIXER),
    );
    expect(plan.id).toBe(TEST_FIX_PLAN_ID);
    const plannerInput = PlanSweepInputSchema.parse((plan.jobs[0] as { input: unknown }).input);
    expect(plannerInput.fixers).toEqual([TEST_FIX_FIXER]);
    // Every unit job carries the test-only fixer (the plan's identity).
    for (const job of plan.jobs.slice(1, 3)) {
      const input = SweepUnitDispatchInputSchema.parse((job as { input: unknown }).input);
      expect(input.fixer).toBe(TEST_FIX_FIXER);
      expect(input.proposeOnly).toBe(true);
    }
    // A report from a DIFFERENTLY-configured phase A is plan corruption.
    expect(() => buildTestFixPlan(CONFIG, twoUnitReport('fix'))).toThrow(
      /outside the test-only set/,
    );
    // And so is a report whose UNITS are clean but whose EMBEDDED unit-job
    // inputs carry a foreign fixer — the jobs are what get dispatched.
    const corrupted: PlanSweepReport = {
      jobs: [
        {
          id: 'sweep-alpha-evil',
          op: SWEEP_UNIT_OP,
          input: { package: 'alpha', fixer: 'evil-fix', files: [] },
          dependsOn: [],
        },
      ],
      units: [{ package: 'alpha', fixer: TEST_FIX_FIXER, files: [] }],
      suppressed: [],
      needsHuman: [],
    };
    expect(() => buildTestFixPlan(CONFIG, corrupted)).toThrow(
      /embed inputs outside the test-only set/,
    );
  });

  test('the suffix loop reserves FINAL slugs: natural scope-foo-2 cannot be collided (jcqEj)', () => {
    // The finder's exact fixture: '@scope/foo' normalizes to 'scope-foo',
    // and BOTH 'scope-foo' and 'scope-foo-2' are NATURAL packages. The old
    // seen-inputs ordinal gave the third unit 'scope-foo-2' — colliding with
    // the second. The reserved-set loop keeps suffixing until free.
    const units: Array<WorkUnit> = [
      { package: '@scope/foo', fixer: 'fix', files: [] },
      { package: 'scope-foo', fixer: 'fix', files: [] },
      { package: 'scope-foo-2', fixer: 'fix', files: [] },
    ];
    const report: PlanSweepReport = {
      jobs: units.map((unit, index) => ({
        id: `sweep-natural-${index}`,
        op: SWEEP_UNIT_OP,
        input: unit,
        dependsOn: [],
      })),
      units,
      suppressed: [],
      needsHuman: [],
    };
    const plan = buildSweepPlan(CONFIG, report);
    const inputs = plan.jobs
      .slice(1, 4)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    const slugs = inputs.map((input) => input.slug);
    // Each unit suffixes its OWN base when taken — deterministic, traceable,
    // and all three DISTINCT (the old seen-inputs ordinal handed 'scope-foo-2'
    // to BOTH the second and the third unit).
    expect(slugs).toEqual(['scope-foo', 'scope-foo-2', 'scope-foo-2-2']);
    expect(new Set(slugs).size).toBe(3);
    // The assembler accepts all three DISTINCT branches.
    const assemble = AssemblePrsInputSchema.parse((plan.jobs[5] as { input: unknown }).input);
    expect(assemble.packages.map((pkg) => pkg.branch)).toEqual([
      'cq/09-16a/fix/scope-foo',
      'cq/09-16a/fix/scope-foo-2',
      'cq/09-16a/fix/scope-foo-2-2',
    ]);
  });

  test('the overlay cannot override the builder-owned kind/slug (jcqEl)', () => {
    // TYPE pin: kind/slug (and package/fixer/files) are the collision
    // resolution's and the planner's to set — an overlay carrying them is a
    // compile error (excess property against the Omit type).
    const clean: SweepUnitJobOverlay = { push: false };
    expect(clean.push).toBe(false);
    const overridden: SweepUnitJobOverlay = {
      push: false,
      // @ts-expect-error — kind is builder-owned (jcqEl)
      kind: 'overridden',
    };
    void overridden;
    // RUNTIME pin: the enrichment ships the RESOLVED segments regardless.
    const plan = buildSweepPlan(CONFIG, twoUnitReport(), SWEEP_PLAN_ID, { push: false });
    const inputs = plan.jobs
      .slice(1, 3)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    expect(inputs.map((input) => input.kind)).toEqual(['fix', 'fix']);
    expect(inputs.map((input) => input.slug)).toEqual(['alpha', 'beta']);
    // The local-only knob reaches the tracker-branch leg too (review-debt
    // #173): a `push:false` fleet must not push the tracker branch.
    const trackerBranchJob = plan.jobs.find((job) => job.id === 'sweep-tracker-branch');
    expect(
      EnsureTrackerBranchInputSchema.parse((trackerBranchJob as { input: unknown }).input).push,
    ).toBe(false);
  });

  test('config.unitDispatch makes the enriched jobs dispatch-ready; absent leaves them unwired (jeDch)', () => {
    const driver = {
      binary: ['node', '/opt/agent.mjs'],
      provider: 'cq-e2e',
      model: 'sweep-fake',
      sessionsDir: '/tmp/sweep-sessions',
    };
    const check = {
      adapter: 'tsc-lines' as const,
      command: 'node',
      args: ['scripts/check.js', '{package}'],
      timeoutMs: 30_000,
    };
    const wired = buildSweepPlan(
      { ...CONFIG, unitDispatch: { driver, check, promptTemplate: 'fix {package} at {worktree}' } },
      twoUnitReport(),
    );
    const wiredInputs = wired.jobs
      .slice(1, 3)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    // Dispatch-ready: driver/check/promptTemplate on EVERY unit job, and the
    // whole input parses the registry mirror.
    for (const input of wiredInputs) {
      expect(input.driver).toEqual(driver);
      expect(input.check).toEqual(check);
      expect(input.promptTemplate).toBe('fix {package} at {worktree}');
    }
    // ABSENT: unchanged — no driver/check keys (the exactOptional shape).
    const unwired = buildSweepPlan(CONFIG, twoUnitReport());
    const unwiredInputs = unwired.jobs
      .slice(1, 3)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    for (const input of unwiredInputs) {
      expect(input.driver).toBeUndefined();
      expect(input.check).toBeUndefined();
      expect(input.promptTemplate).toBeUndefined();
    }
  });

  test('test-fix carries PREP mode: probe-only plan, no assemble (ws-i)', () => {
    const prepReport = twoUnitReport(TEST_FIX_FIXER);
    const prepPlan = buildTestFixPlan({ ...CONFIG, mode: 'prep' }, prepReport);
    expect(prepPlan.id).toBe(TEST_FIX_PLAN_ID);
    // Planner job + two probe-only unit jobs; NO assemble job.
    expect(prepPlan.jobs.map((job) => job.id)).toEqual([
      'sweep-plan',
      'sweep-alpha-fix',
      'sweep-beta-fix',
    ]);
    const inputs = prepPlan.jobs
      .slice(1, 3)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    for (const input of inputs) {
      expect(input.mode).toBe('prep');
      expect(input.fixer).toBe(TEST_FIX_FIXER);
    }
  });

  test('a hand-built report with misaligned jobs/units is plan corruption (jTPa1-era guard)', () => {
    const units: Array<WorkUnit> = [
      { package: 'alpha', fixer: 'fix', files: [] },
      { package: 'beta', fixer: 'fix', files: [] },
    ];
    const misaligned: PlanSweepReport = {
      jobs: [{ id: 'sweep-alpha-fix', op: SWEEP_UNIT_OP, input: units[0], dependsOn: [] }],
      units,
      suppressed: [],
      needsHuman: [],
    };
    expect(() => buildSweepPlan(CONFIG, misaligned)).toThrow(/misaligned/);
  });

  test('an ORDER-mismatched report of equal length is plan corruption (#175 item 6)', () => {
    const units: Array<WorkUnit> = [
      { package: 'alpha', fixer: 'fix', files: [] },
      { package: 'beta', fixer: 'fix', files: [] },
    ];
    // Equal length, but job 0 embeds beta while unit 0 is alpha: the old
    // length-only guard would attach alpha's resolved kind/slug to beta's
    // job and mis-slug the unit.
    const swapped: PlanSweepReport = {
      jobs: [
        { id: 'sweep-beta-fix', op: SWEEP_UNIT_OP, input: units[1], dependsOn: [] },
        { id: 'sweep-alpha-fix', op: SWEEP_UNIT_OP, input: units[0], dependsOn: [] },
      ],
      units,
      suppressed: [],
      needsHuman: [],
    };
    expect(() => buildSweepPlan(CONFIG, swapped)).toThrow(/misaligned at index 0/);
  });

  test('a deletion-only root package keeps a scope pin from selection evidence (r1 major)', () => {
    const units: Array<WorkUnit> = [{ package: 'monorepo', fixer: 'fix', files: [] }];
    const report: PlanSweepReport = {
      jobs: [{ id: 'sweep-monorepo-fix', op: SWEEP_UNIT_OP, input: units[0], dependsOn: [] }],
      units,
      suppressed: [],
      needsHuman: [],
      selectionEvidence: { monorepo: ['old.ts'] },
    };
    const plan = buildSweepPlan({ ...CONFIG, packages: [{ name: 'monorepo', path: '.' }] }, report);
    const input = SweepUnitDispatchInputSchema.parse(plan.jobs[1]?.input);
    // Pre-fix this was `undefined` (no allowlist at all → fail open) because a
    // '.' package's only patterns come from `files`, which the #150 deletion
    // filter had emptied.
    expect(input.stagePathAllowlist?.patterns).toEqual(['^old\\.ts$']);
  });

  test("a 'toString'-named package never reads an inherited selection-evidence member (r2 major)", () => {
    const units: Array<WorkUnit> = [{ package: 'toString', fixer: 'fix', files: [] }];
    const report: PlanSweepReport = {
      jobs: [{ id: 'sweep-toString-fix', op: SWEEP_UNIT_OP, input: units[0], dependsOn: [] }],
      units,
      suppressed: [],
      needsHuman: [],
      // Evidence for ANOTHER package makes the map non-empty, so an
      // unguarded `map['toString']` would return Object.prototype.toString
      // and crash the allowlist loop.
      selectionEvidence: { other: ['gone.ts'] },
    };
    const plan = buildSweepPlan({ ...CONFIG, packages: [{ name: 'toString', path: '.' }] }, report);
    const input = SweepUnitDispatchInputSchema.parse(plan.jobs[1]?.input);
    expect(input.stagePathAllowlist).toBeUndefined();
  });

  test('slug normalization and deterministic collision disambiguation (jTPa1)', () => {
    // '@scope/pkg' normalizes to the DISPATCHABLE slug 'scope-pkg' (the old
    // fold produced '-scope-pkg', which SEGMENT_RE refuses).
    expect(sweepUnitSegments('cq/x', { package: '@scope/pkg', fixer: 'fix' })).toEqual({
      kind: 'fix',
      slug: 'scope-pkg',
      branch: 'cq/x/fix/scope-pkg',
    });
    // Distinct packages normalizing to the SAME slug resolve deterministically:
    // a '-2' suffix in unit order (the planner's job-id idiom), shipped on the
    // enriched jobs and mirrored in the assembler input.
    const units: Array<WorkUnit> = [
      { package: '@a/b', fixer: 'fix', files: [] },
      { package: 'a.b', fixer: 'fix', files: [] },
    ];
    const colliding: PlanSweepReport = {
      jobs: units.map((unit, index) => ({
        id: `sweep-collide-${index}`,
        op: SWEEP_UNIT_OP,
        input: unit,
        dependsOn: [],
      })),
      units,
      suppressed: [],
      needsHuman: [],
    };
    const plan = buildSweepPlan(CONFIG, colliding);
    const inputs = plan.jobs
      .slice(1, 3)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    expect(inputs.map((input) => input.slug)).toEqual(['a-b', 'a-b-2']);
    const assemble = AssemblePrsInputSchema.parse((plan.jobs[4] as { input: unknown }).input);
    expect(assemble.packages.map((pkg) => pkg.branch)).toEqual([
      'cq/09-16a/fix/a-b',
      'cq/09-16a/fix/a-b-2',
    ]);
  });

  test('the sweep floor runs through the real runner as a harmless pass', async () => {
    const plan: Plan = (await (await getPlan(SWEEP_PLAN_ID))?.importer()) as Plan;
    // The real sweep registry entry (real subprocess planner deps) — the
    // empty manifest selects nothing and consults nothing.
    const entryByName = new Map<string, OpRegistryEntry<never, never>>(
      // The bottom-instantiation cast (the review-loop precedent: unknown
      // does not widen down to never, so the view cast goes through here).
      [...sweepRegistry, ...prRegistry].map((entry) => [
        entry.name,
        entry as unknown as OpRegistryEntry<never, never>,
      ]),
    );
    const view: OpRegistryView = { get: (name) => entryByName.get(name) };
    const report = await runPlan(plan, { concurrency: 1, stopOnError: true }, view);
    expect(report.counts).toMatchObject({ done: 1, failed: 0, blocked: 0 });
    expect(report.jobs[0]?.result.status).toBe('ok');
  });

  test(
    'the unit composition binds sandboxPolicy: default none, the override rides the invocation',
    { timeout: 120_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'd4-unit-bindings-'));
      try {
        const repo = join(root, 'repo');
        await generateScratchRepo(repo);
        const captured: OpInvocation[] = [];
        // A capturing fake driver: records the invocation, then stops the
        // pipeline (the op folds the throw into a `failed` result — the
        // capture is the point).
        const driver: Driver = {
          run: async (invocation) => {
            captured.push(invocation);
            throw new Error('captured — stopping the pipeline here');
          },
        };
        const base = {
          repoRoot: repo,
          worktreesDir: 'worktrees',
          runPrefix: 'cq/unit-bind',
          base: 'main',
          adapter: 'tsc-lines' as const,
          // A clean probe — no subprocess needed for this pin.
          runCheck: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          checkCommand: (unit: WorkUnit, worktreePath: string) => ({
            command: process.execPath,
            args: ['scripts/check.js', unit.package],
            cwd: worktreePath,
            timeoutMs: 30_000,
          }),
          driver,
          modelSpec: { model: 'sweep-fake', provider: 'cq-d4-e2e' },
          sessionsDir: join(root, 'sessions'),
          prompt: () => 'capture me',
          git: async () => ({ code: 0, stdout: '', stderr: '' }),
        };
        const unit: WorkUnit = { package: 'alpha', fixer: 'fix', files: [] };
        // DEFAULT: none (the shipped behavior, unchanged).
        const failed = await makeSweepUnitOp(base)(unit);
        expect(failed.status).toBe('failed'); // the capture's deliberate stop
        expect(captured[0]?.sandboxPolicy).toEqual({ level: 'none' });
        // OVERRIDE: the binding rides verbatim into the OpInvocation.
        const hardened: WorkUnit = { package: 'alpha', fixer: 'hardened', files: [] };
        await makeSweepUnitOp({ ...base, sandboxPolicy: { level: 'workspace-write' } })(hardened);
        expect(captured[1]?.sandboxPolicy).toEqual({ level: 'workspace-write' });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
