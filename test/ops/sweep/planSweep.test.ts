// Sweep lane (WS-D, goal D1) — evidence for the sweep planner
// (src/ops/sweep/planSweep.ts) and the gates→ledger signature recipe.
//
// Pinned here:
//   1. THE SELECTOR IS REQUIRED (UC §1 row 16): a missing selector and an
//      unknown selector mode are `failed` results naming the requirement —
//      no hardcoded default selector exists at any layer.
//   2. SELECTION: workspace-all takes the whole manifest; changed-vs-base
//      maps the injected changed-file listing by LONGEST path-prefix with a
//      path boundary (`packages/core` ≠ `packages/corex`), does not select
//      packages no changed file touches, and reports orphans instead of
//      dropping them; explicit validates every name (unknown → failed
//      naming it).
//   3. THE LEDGER CONSULT (UC §1 row 8, on the fixture pinned by
//      test/ops/ledger/planner-contract.test.ts — the memory-backed fake
//      below goes through makeLedgerQuery exactly as that contract does):
//      a package whose baseline signatures are ALL known noise contributes
//      NO fix units; needsHuman signatures route to the report rows; a
//      mixed package (one fresh, one noise) is NOT suppressed; a failing
//      query is `failed` — store faults never fabricate ok.
//   4. JOBS ARE DISPATCH-READY: JSON-serializable, one per unit, op always
//      SWEEP_UNIT_OP, stable sanitized ids, collisions disambiguated
//      deterministically.
//   5. ledgerSignature: deterministic, tool-namespaced, pinned to the FNV-1a
//      compact form over the exact canonical tuple (fnv1a32Hex is itself
//      pinned to the PUBLISHED vectors in test/ops/gates/fingerprint.test.ts,
//      so this chain inherits a non-circular anchor), and RangeError on an
//      empty/non-string tool — the fingerprint default-tool trap.
import { describe, expect, test } from 'vitest';
import type { Op } from '../../../src/kernel/types.js';
import type { CheckFailure } from '../../../src/ops/gates/checkRunner.js';
import { fingerprintFailure, fnv1a32Hex } from '../../../src/ops/gates/fingerprint.js';
import type { LedgerEntry, LedgerFile } from '../../../src/ops/ledger/store.js';
import type { LedgerQueryInput, LedgerStore, LedgerView } from '../../../src/ops/ledger/ledger.js';
import { makeLedgerQuery } from '../../../src/ops/ledger/ledger.js';
import {
  SWEEP_UNIT_OP,
  changedFilesArgs,
  ledgerSignature,
  makePlanSweep,
  makeSubprocessSweepPlannerDeps,
  parseNullDelimitedPaths,
} from '../../../src/ops/sweep/planSweep.js';
import type {
  PlanSweepDeps,
  PlanSweepInput,
  PlanSweepPackage,
  PlanSweepReport,
} from '../../../src/ops/sweep/planSweep.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A small monorepo manifest: nested prefix pair (longest-prefix pin), siblings, an app. */
const PACKAGES: PlanSweepPackage[] = [
  { name: 'core', path: 'packages/core' },
  { name: 'core-tests', path: 'packages/core/test' },
  { name: 'cli', path: 'packages/cli' },
  { name: 'web', path: 'apps/web' },
];

function baseInput(overrides?: Partial<PlanSweepInput>): PlanSweepInput {
  return {
    repoRoot: '/repo',
    packages: PACKAGES,
    selector: { mode: 'workspace-all' },
    fixers: ['lint'],
    ...overrides,
  };
}

function makePlanner(overrides?: Partial<PlanSweepDeps>): Op<PlanSweepInput, PlanSweepReport> {
  return makePlanSweep({ changedFiles: async () => [], ...overrides });
}

/** Unwraps an `ok` result; anything else fails the test with what came back. */
async function okPlan(op: Op<PlanSweepInput, PlanSweepReport>, input: PlanSweepInput) {
  const result = await op(input);
  if (result.status !== 'ok') {
    const detail =
      result.status === 'failed'
        ? result.error
        : result.status === 'indeterminate'
          ? result.detail
          : result.status === 'needs-human'
            ? result.reason
            : 'budget-exhausted';
    throw new Error(`expected ok, got ${result.status}: ${detail}`);
  }
  return result.value;
}

/** Unwraps a `failed` result's error; any other status fails the test. */
async function failedPlan(op: Op<PlanSweepInput, PlanSweepReport>, input: PlanSweepInput) {
  const result = await op(input);
  if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
  return result.error;
}

/** In-memory ledger store over a deep-cloned file — the planner-contract fake. */
function memoryStore(entries: LedgerEntry[]): LedgerStore {
  let file: LedgerFile = { version: 1, entries };
  return {
    load: () => structuredClone(file),
    save: (next) => {
      file = structuredClone(next);
    },
  };
}

/**
 * A planner whose ledger dep is the REAL makeLedgerQuery over a memory
 * store — the same wiring test/ops/ledger/planner-contract.test.ts pins.
 */
function plannerWithLedger(entries: LedgerEntry[]): Op<PlanSweepInput, PlanSweepReport> {
  const query = makeLedgerQuery(() => memoryStore(entries));
  return makePlanSweep({ changedFiles: async () => [], queryLedger: query });
}

const EMPTY_VIEW: LedgerView = { entries: [], knownNoise: [], needsHuman: [] };

/** A positioned failure; the message is filler (positioned identity ignores it). */
const A_FAILURE: CheckFailure = {
  file: 'src/a.ts',
  line: 1,
  column: 1,
  ruleId: 'rule',
  message: 'message text',
  severity: 'error',
};

// ---------------------------------------------------------------------------
// 1. The selector contract (UC §1 row 16)
// ---------------------------------------------------------------------------

describe('planSweep selector contract (UC §1 row 16: no default selector)', () => {
  test('a missing selector is a failed result naming the selector requirement', async () => {
    // The cast mirrors an untyped/JSON caller that omitted the field; the
    // required-selector check is the library-level contract behind the
    // registry schema's arg-error.
    const input = {
      repoRoot: '/repo',
      packages: PACKAGES,
      fixers: ['lint'],
    } as PlanSweepInput;
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/selector is required/);
    expect(error).toMatch(/workspace-all/);
  });

  test('an explicitly-undefined selector fails the same way', async () => {
    const input = {
      repoRoot: '/repo',
      packages: PACKAGES,
      fixers: ['lint'],
      selector: undefined,
    } as unknown as PlanSweepInput;
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(/selector is required/);
  });

  test('an unknown selector mode is failed — no hardcoded default falls out', async () => {
    const input = baseInput({
      selector: { mode: 'magic' } as unknown as PlanSweepInput['selector'],
    });
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/unknown selector mode "magic"/);
    expect(error).toMatch(/NO default selector/);
  });

  test('changed-vs-base requires a non-empty base ref', async () => {
    const input = baseInput({ selector: { mode: 'changed-vs-base', base: '' } });
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(/non-empty base ref/);
  });

  test('a flag-impersonating changed-vs-base base is refused — the diff arg is positional', async () => {
    const input = baseInput({
      selector: { mode: 'changed-vs-base', base: '--output=/tmp/x' },
    });
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/changed-vs-base base/);
    expect(error).toMatch(/never a flag/);
  });
});

// ---------------------------------------------------------------------------
// 1b. The library input boundary (untyped-caller hardening)
// ---------------------------------------------------------------------------

describe('planSweep library input boundary (reachable past any schema)', () => {
  test('a non-array packages field is a failed result — never an escaping TypeError', async () => {
    const input = baseInput({ packages: 'packages/core' as unknown as PlanSweepPackage[] });
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(
      /packages must be an array of manifest entries/,
    );
  });

  test('a null selector is a failed result — the required-selector taxonomy', async () => {
    const input = baseInput({
      selector: null as unknown as PlanSweepInput['selector'],
    });
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(/selector is required/);
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(/NO default selector/);
  });

  test('a null packages ELEMENT is a failed result naming the index', async () => {
    const input = baseInput({
      packages: [null as unknown as PlanSweepPackage, PACKAGES[0] as PlanSweepPackage],
    });
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/packages\[0\]/);
  });

  test('a non-array baselineSignatures is a failed result — the packages-guard mirror', async () => {
    const input = baseInput({
      baselineSignatures: 'sig-noise' as unknown as NonNullable<
        PlanSweepInput['baselineSignatures']
      >,
    });
    await expect(failedPlan(makePlanner(), input)).resolves.toMatch(
      /baselineSignatures must be an array/,
    );
  });

  test('a null ledger is a failed result, not a TypeError at the root read', async () => {
    const input = baseInput({
      ledger: null as unknown as NonNullable<PlanSweepInput['ledger']>,
    });
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/ledger must be an object/);
  });

  test('a null/garbage baselineSignatures ELEMENT is a failed result naming the index', async () => {
    type Entries = NonNullable<PlanSweepInput['baselineSignatures']>;
    const nullEntry = baseInput({
      baselineSignatures: [null] as unknown as Entries,
    });
    await expect(failedPlan(makePlanner(), nullEntry)).resolves.toMatch(/baselineSignatures\[0\]/);
    const garbage = baseInput({
      baselineSignatures: [42] as unknown as Entries,
    });
    await expect(failedPlan(makePlanner(), garbage)).resolves.toMatch(/baselineSignatures\[0\]/);
    const blank = baseInput({
      baselineSignatures: [{ package: 'core', signature: '' }] as unknown as Entries,
    });
    await expect(failedPlan(makePlanner(), blank)).resolves.toMatch(/baselineSignatures\[0\]/);
  });

  test('an empty explicit selector is a failed result — aligned with the registry min(1)', async () => {
    const error = await failedPlan(
      makePlanner(),
      baseInput({ selector: { mode: 'explicit', packages: [] } }),
    );
    expect(error).toMatch(/at least one package/);
  });

  test('a packageFiles value that is not an array of strings is a failed result naming the key', async () => {
    const input = baseInput({
      packageFiles: { core: 'build' } as unknown as NonNullable<PlanSweepInput['packageFiles']>,
    });
    const error = await failedPlan(makePlanner(), input);
    expect(error).toMatch(/packageFiles\['core'\]/);
  });
});

// ---------------------------------------------------------------------------
// 2. Selection
// ---------------------------------------------------------------------------

describe('planSweep selection', () => {
  test('workspace-all selects every manifest package × every requested fixer', async () => {
    const report = await okPlan(makePlanner(), baseInput({ fixers: ['lint', 'format'] }));
    expect(report.units.map((u) => [u.package, u.fixer])).toEqual([
      ['core', 'lint'],
      ['core', 'format'],
      ['core-tests', 'lint'],
      ['core-tests', 'format'],
      ['cli', 'lint'],
      ['cli', 'format'],
      ['web', 'lint'],
      ['web', 'format'],
    ]);
    expect(report.jobs).toHaveLength(report.units.length);
    expect(report.suppressed).toEqual([]);
    expect(report.needsHuman).toEqual([]);
    expect(report.orphans).toBeUndefined();
  });

  test('fixers are a set: duplicate labels do not duplicate units', async () => {
    const report = await okPlan(makePlanner(), baseInput({ fixers: ['lint', 'lint'] }));
    // One lint unit PER PACKAGE — the set semantics deduplicate the labels,
    // not the packages.
    expect(report.units.map((u) => u.fixer)).toEqual(['lint', 'lint', 'lint', 'lint']);
  });

  test('workspace-all units carry the known file-set, empty when packageFiles is absent', async () => {
    const report = await okPlan(
      makePlanner(),
      baseInput({
        packageFiles: { core: ['packages/core/src/a.ts'], web: [] },
      }),
    );
    expect(report.units.find((u) => u.package === 'core')?.files).toEqual([
      'packages/core/src/a.ts',
    ]);
    expect(report.units.find((u) => u.package === 'web')?.files).toEqual([]);
    expect(report.units.find((u) => u.package === 'cli')?.files).toEqual([]);
  });

  test('an empty manifest plans an honest empty sweep (ok, zero jobs)', async () => {
    const report = await okPlan(makePlanner(), baseInput({ packages: [] }));
    expect(report.units).toEqual([]);
    expect(report.jobs).toEqual([]);
  });

  test('changed-vs-base maps by LONGEST path-prefix, boundary-aware, and reports orphans', async () => {
    const changed = [
      'packages/core/src/a.ts', // → core (core-tests' prefix does not reach)
      'packages/core/test/a.test.ts', // → core-tests (longer prefix beats core)
      'packages/cli/main.ts', // → cli
      'packages/corex/y.ts', // string prefix but NOT a path prefix → orphan
      'docs/readme.md', // no package → orphan
    ];
    let askedBase: string | undefined;
    const planner = makePlanSweep({
      changedFiles: async (base) => {
        askedBase = base;
        return changed;
      },
    });
    const report = await okPlan(
      planner,
      baseInput({ selector: { mode: 'changed-vs-base', base: 'origin/main' } }),
    );
    expect(askedBase).toBe('origin/main');
    // Manifest order; packages with no mapped file are not selected.
    expect(report.units.map((u) => u.package)).toEqual(['core', 'core-tests', 'cli']);
    expect(report.units.find((u) => u.package === 'core')?.files).toEqual([
      'packages/core/src/a.ts',
    ]);
    expect(report.units.find((u) => u.package === 'core-tests')?.files).toEqual([
      'packages/core/test/a.test.ts',
    ]);
    // Orphans are reported, never silently dropped — sorted, boundary orphan included.
    expect(report.orphans).toEqual(['docs/readme.md', 'packages/corex/y.ts']);
  });

  test('changed-vs-base units carry the mapped changed files as their file-set', async () => {
    const report = await okPlan(
      makePlanner({ changedFiles: async () => ['packages/cli/main.ts'] }),
      baseInput({
        selector: { mode: 'changed-vs-base', base: 'HEAD~1' },
        packageFiles: { cli: ['packages/cli/stale.ts'] },
      }),
    );
    // The diff is this mode's file-set; it supersedes packageFiles.
    expect(report.units).toEqual([
      { package: 'cli', fixer: 'lint', files: ['packages/cli/main.ts'] },
    ]);
  });

  test("a '.' package path names the repo ROOT: it owns everything no nested prefix claims", async () => {
    const report = await okPlan(
      makePlanner({
        changedFiles: async () => ['packages/core/src/a.ts', 'README.md', 'docs/guide.md'],
      }),
      baseInput({
        packages: [
          { name: 'monorepo', path: '.' },
          { name: 'core', path: 'packages/core' },
        ],
        selector: { mode: 'changed-vs-base', base: 'origin/main' },
      }),
    );
    // The nested prefix beats the root package under `packages/core`; the
    // root package sweeps the rest — and nothing is an orphan.
    expect(report.units).toEqual([
      {
        package: 'monorepo',
        fixer: 'lint',
        files: ['README.md', 'docs/guide.md'],
      },
      { package: 'core', fixer: 'lint', files: ['packages/core/src/a.ts'] },
    ]);
    expect(report.orphans).toBeUndefined();
  });

  test('explicit selects exactly the named manifest packages (deduplicated)', async () => {
    const report = await okPlan(
      makePlanner(),
      baseInput({
        selector: { mode: 'explicit', packages: ['web', 'core', 'web'] },
        packageFiles: { web: ['apps/web/index.ts'] },
      }),
    );
    expect(report.units.map((u) => [u.package, u.files])).toEqual([
      ['web', ['apps/web/index.ts']],
      ['core', []],
    ]);
  });

  test('an explicit selector naming an unknown package is a failed result naming it', async () => {
    const error = await failedPlan(
      makePlanner(),
      baseInput({ selector: { mode: 'explicit', packages: ['core', 'nope'] } }),
    );
    expect(error).toMatch(/unknown package\(s\): nope/);
  });

  test('empty fixers is a failed result — zero units must never be silent', async () => {
    await expect(failedPlan(makePlanner(), baseInput({ fixers: [] }))).resolves.toMatch(
      /non-empty set/,
    );
  });

  test('a failing changed-files dep is a failed result, never a fabricated plan', async () => {
    const planner = makePlanSweep({
      changedFiles: async () => {
        throw new Error('git died');
      },
    });
    const error = await failedPlan(
      planner,
      baseInput({ selector: { mode: 'changed-vs-base', base: 'origin/main' } }),
    );
    expect(error).toMatch(/could not list files changed/);
    expect(error).toMatch(/git died/);
  });
});

// ---------------------------------------------------------------------------
// 3. The ledger consult (UC §1 row 8)
// ---------------------------------------------------------------------------

describe('planSweep ledger suppression (UC §1 row 8 / R2 D6)', () => {
  // knownNoise = [sig-human, sig-noise], needsHuman = [sig-human].
  const LEDGER: LedgerEntry[] = [
    { signature: 'sig-noise', count: 2 },
    { signature: 'sig-human', count: 4 },
    { signature: 'sig-fresh', count: 1 },
  ];

  /** The consult trigger: without a ledger config the planner never queries. */
  const LEDGER_CONFIG = { root: '.cq', storePath: '.cq/ledger.json' };

  test('a fully-known-noise package contributes NO fix units and lands in suppressed', async () => {
    const report = await okPlan(
      plannerWithLedger(LEDGER),
      baseInput({
        fixers: ['lint', 'format'],
        ledger: LEDGER_CONFIG,
        baselineSignatures: [
          { package: 'core', signature: 'sig-noise' },
          { package: 'web', signature: 'sig-fresh' },
        ],
      }),
    );
    // core suppressed; the remaining 3 packages × 2 fixers all plan.
    expect(report.units.map((u) => u.package)).toEqual([
      'core-tests',
      'core-tests',
      'cli',
      'cli',
      'web',
      'web',
    ]);
    expect(report.jobs).toHaveLength(6);
    expect(report.suppressed).toEqual([
      { package: 'core', reason: 'all 1 baseline signature(s) are known ledger noise' },
    ]);
    expect(report.needsHuman).toEqual([]);
  });

  test('an escalated baseline signature routes to needsHuman, and its package is still suppressed', async () => {
    const report = await okPlan(
      plannerWithLedger(LEDGER),
      baseInput({
        ledger: LEDGER_CONFIG,
        baselineSignatures: [{ package: 'cli', signature: 'sig-human' }],
      }),
    );
    // needsHuman ⊆ knownNoise (the planner-contract fixture), so the
    // package is suppressed AND the signature is routed to a human.
    expect(report.suppressed.map((s) => s.package)).toEqual(['cli']);
    expect(report.needsHuman).toEqual([{ package: 'cli', signature: 'sig-human' }]);
    expect(report.units.map((u) => u.package)).toEqual(['core', 'core-tests', 'web']);
  });

  test('a mixed package (one fresh, one known-noise signature) is NOT suppressed', async () => {
    const report = await okPlan(
      plannerWithLedger(LEDGER),
      baseInput({
        ledger: LEDGER_CONFIG,
        baselineSignatures: [
          { package: 'core', signature: 'sig-noise' },
          { package: 'core', signature: 'sig-fresh' },
        ],
      }),
    );
    expect(report.suppressed).toEqual([]);
    expect(report.units.map((u) => u.package)).toContain('core');
  });

  test('a needsHuman signature routes even when the package still plans (the row is the human surface)', async () => {
    const report = await okPlan(
      plannerWithLedger(LEDGER),
      baseInput({
        ledger: LEDGER_CONFIG,
        baselineSignatures: [
          { package: 'core', signature: 'sig-human' },
          { package: 'core', signature: 'sig-fresh' },
        ],
      }),
    );
    // One fresh signature keeps the package plannable; the escalated
    // signature is still routed — never repackaged as an auto-fix decision.
    expect(report.needsHuman).toEqual([{ package: 'core', signature: 'sig-human' }]);
    expect(report.suppressed).toEqual([]);
    expect(report.units.map((u) => u.package)).toContain('core');
  });

  test('without a ledger config the planner plans everything the selector selected', async () => {
    const report = await okPlan(
      makePlanner(),
      baseInput({
        baselineSignatures: [{ package: 'core', signature: 'sig-noise' }],
      }),
    );
    expect(report.suppressed).toEqual([]);
    expect(report.units).toHaveLength(PACKAGES.length);
  });

  test('needsHuman routing is SELECTOR-INDEPENDENT: an escalated package changed-vs-base does not select still routes', async () => {
    // Only cli has a changed file; core is NOT selected — its escalated
    // baseline signature must still route to the report's needsHuman rows.
    const planner = makePlanSweep({
      changedFiles: async () => ['packages/cli/main.ts'],
      queryLedger: makeLedgerQuery(() => memoryStore(LEDGER)),
    });
    const report = await okPlan(
      planner,
      baseInput({
        selector: { mode: 'changed-vs-base', base: 'origin/main' },
        ledger: LEDGER_CONFIG,
        baselineSignatures: [
          { package: 'core', signature: 'sig-human' }, // escalated, NOT selected
          { package: 'cli', signature: 'sig-fresh' }, // fresh, selected
        ],
      }),
    );
    expect(report.needsHuman).toEqual([{ package: 'core', signature: 'sig-human' }]);
    // Suppression logic is unchanged: unselected packages produce no
    // suppression entries, and the selected fresh package plans.
    expect(report.suppressed).toEqual([]);
    expect(report.units.map((u) => u.package)).toEqual(['cli']);
  });

  test('needsHuman routing is bounded by the MANIFEST: a ghost-package baseline routes nothing', async () => {
    const planner = makePlanSweep({
      changedFiles: async () => ['packages/cli/main.ts'],
      queryLedger: makeLedgerQuery(() => memoryStore(LEDGER)),
    });
    const report = await okPlan(
      planner,
      baseInput({
        selector: { mode: 'changed-vs-base', base: 'origin/main' },
        ledger: LEDGER_CONFIG,
        baselineSignatures: [
          { package: 'ghost', signature: 'sig-human' }, // non-manifest → NO row
          { package: 'core', signature: 'sig-human' }, // manifest, NOT selected → row
        ],
      }),
    );
    // A human is never routed to a package the manifest does not define,
    // while the round-1 selector-independence contract still holds for the
    // real (manifest) package nothing selected.
    expect(report.needsHuman).toEqual([{ package: 'core', signature: 'sig-human' }]);
    expect(report.units.map((u) => u.package)).toEqual(['cli']);
  });

  test('the query receives exactly the configured root, storePath and thresholds', async () => {
    const seen: LedgerQueryInput[] = [];
    const planner = makePlanSweep({
      changedFiles: async () => [],
      queryLedger: async (q) => {
        seen.push(q);
        return { status: 'ok', value: EMPTY_VIEW };
      },
    });
    await okPlan(
      planner,
      baseInput({
        ledger: { root: '.cq', storePath: '.cq/ledger.json', thresholds: { suppressAt: 3 } },
      }),
    );
    expect(seen).toEqual([
      { root: '.cq', storePath: '.cq/ledger.json', thresholds: { suppressAt: 3 } },
    ]);
  });

  test('a failing ledger query is a failed result carrying the fault — never a fabricated ok', async () => {
    const planner = makePlanSweep({
      changedFiles: async () => [],
      queryLedger: async () => ({ status: 'failed', error: 'ledger: could not load' }),
    });
    const error = await failedPlan(
      planner,
      baseInput({ ledger: { root: '.cq', storePath: '.cq/ledger.json' } }),
    );
    expect(error).toMatch(/ledger query returned failed/);
    expect(error).toMatch(/could not load/);
  });

  test('a ledger config without a queryLedger dep is a failed result', async () => {
    const error = await failedPlan(
      makePlanner(),
      baseInput({ ledger: { root: '.cq', storePath: '.cq/ledger.json' } }),
    );
    expect(error).toMatch(/queryLedger dependency was not provided/);
  });
});

// ---------------------------------------------------------------------------
// 4. Dispatch-ready jobs
// ---------------------------------------------------------------------------

describe('planSweep jobs are dispatch-ready', () => {
  test('the report is JSON-serializable; every job references SWEEP_UNIT_OP with empty dependsOn', async () => {
    const report = await okPlan(
      makePlanSweep({
        // The changed-vs-base selector needs a changed file that actually
        // maps — the default empty listing would plan ZERO jobs and the
        // dispatch-behavior loop below would pass vacuously.
        changedFiles: async () => ['packages/core/src/a.ts'],
      }),
      baseInput({
        fixers: ['lint'],
        selector: { mode: 'changed-vs-base', base: 'main' },
        packageFiles: { core: ['a.ts'] },
      }),
    );
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.jobs.length).toBeGreaterThanOrEqual(1);
    for (const job of report.jobs) {
      expect(job.op).toBe(SWEEP_UNIT_OP);
      expect(job.dependsOn).toEqual([]);
      expect(report.units).toContainEqual(job.input);
    }
  });

  test('job ids are the stable sanitized sweep-<package>-<fixer>', async () => {
    const report = await okPlan(
      makePlanner(),
      baseInput({
        packages: [
          { name: 'pkg with spaces/x', path: 'p' },
          { name: 'plain', path: 'q' },
        ],
        fixers: ['type check'],
      }),
    );
    expect(report.jobs.map((j) => j.id)).toEqual([
      'sweep-pkg-with-spaces-x-type-check',
      'sweep-plain-type-check',
    ]);
  });

  test('sanitized-id collisions disambiguate deterministically', async () => {
    const input = baseInput({
      packages: [
        { name: 'a/b', path: 'p1' },
        { name: 'a', path: 'p2' },
      ],
      fixers: ['c', 'b/c'],
    });
    const first = await okPlan(makePlanner(), input);
    const second = await okPlan(makePlanner(), input);
    const ids = first.jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('sweep-a-b-c');
    expect(ids).toContain('sweep-a-b-c-2');
    expect(second.jobs.map((j) => j.id)).toEqual(ids);
  });
});

// ---------------------------------------------------------------------------
// 5. ledgerSignature — THE gates→ledger signature recipe
// ---------------------------------------------------------------------------

describe('ledgerSignature (the gates→ledger signature recipe)', () => {
  test('deterministic, and the compact 8-hex FNV form', () => {
    const sig = ledgerSignature(A_FAILURE, 'eslint');
    expect(sig).toBe(ledgerSignature(A_FAILURE, 'eslint'));
    expect(sig).toMatch(/^[0-9a-f]{8}$/);
  });

  test('tool-namespaced: the same failure under different tools never collides', () => {
    expect(ledgerSignature(A_FAILURE, 'eslint')).not.toBe(ledgerSignature(A_FAILURE, 'vitest'));
  });

  test('pins the FNV-1a compact form over the exact canonical tuple', () => {
    // The canonical key of A_FAILURE under tool 'tool' is the JSON of its
    // component tuple [tool, file, ruleId, severity, 'position', line 0
    // bucket, column 0 bucket] — hand-written here so the pin is on the
    // recipe's hash INPUT, anchored (non-circularly) by fnv1a32Hex, which
    // fingerprint.test.ts pins against the published FNV-1a vectors.
    expect(ledgerSignature(A_FAILURE, 'tool')).toBe(
      fnv1a32Hex('["tool","src/a.ts","rule","error","position","0","0"]'),
    );
    // Location-less regime: identity by normalized message, offset bucket.
    const locationLess: CheckFailure = {
      ...A_FAILURE,
      line: null,
      column: null,
      message: 'suite > handles iso dates',
    };
    expect(ledgerSignature(locationLess, 'tool')).toBe(
      fnv1a32Hex('["tool","src/a.ts","rule","error","content","suite > handles iso dates","0"]'),
    );
  });

  test('wiring pin: exactly fingerprintFailure(failure, { tool }) — gates math, not new math', () => {
    expect(ledgerSignature(A_FAILURE, 'tool')).toBe(
      fingerprintFailure(A_FAILURE, { tool: 'tool' }),
    );
  });

  test('an empty tool is a RangeError — the fingerprint default would collide across tools', () => {
    expect(() => ledgerSignature(A_FAILURE, '')).toThrow(RangeError);
    expect(() => ledgerSignature(A_FAILURE, '')).toThrow(/tool is required/);
  });

  test('a non-string tool is a RangeError', () => {
    expect(() => ledgerSignature(A_FAILURE, 42 as unknown as string)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 6. The shipped subprocess deps binding (the registry importer's seam)
// ---------------------------------------------------------------------------

describe('makeSubprocessSweepPlannerDeps (captured fixtures)', () => {
  test('NUL-delimited diff parse: spaces survive, empty entries from the trailing NUL drop', () => {
    expect(parseNullDelimitedPaths('packages/core/src/a.ts\0docs/my file.md\0')).toEqual([
      'packages/core/src/a.ts',
      'docs/my file.md',
    ]);
    expect(parseNullDelimitedPaths('only-one.ts')).toEqual(['only-one.ts']);
    expect(parseNullDelimitedPaths('')).toEqual([]);
  });

  test('the shipped binding exposes both seams; effects bind input-driven at dispatch', () => {
    const deps = makeSubprocessSweepPlannerDeps('/repo');
    expect(typeof deps.changedFiles).toBe('function');
    expect(typeof deps.queryLedger).toBe('function');
  });

  test('the changed-files argv terminates the rev list AFTER the base', () => {
    const args = changedFilesArgs('origin/main');
    expect(args).toEqual(['diff', '--name-only', '-z', 'origin/main', '--']);
    // The base is a REVISION (before the terminator); the trailing `--`
    // ends the rev list with an empty pathspec — never `-- <base>`, which
    // would read the base as a PATH.
    expect(args.indexOf('origin/main')).toBeLessThan(args.indexOf('--'));
    expect(args[args.length - 1]).toBe('--');
    // A ref spelled exactly like a tracked file can no longer die with
    // "ambiguous argument: both revision and filename" — the terminator
    // disambiguates without reclassifying the base.
  });
});
