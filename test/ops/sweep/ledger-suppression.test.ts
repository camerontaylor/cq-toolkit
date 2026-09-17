// CONTRACT FIXTURE — the D1 integration test lane C deferred to us: the
// `test.todo` at the end of test/ops/ledger/planner-contract.test.ts pins
// this handoff (that file stays untouched — "nothing here needs to change
// when D1 lands"). This is the full registry-level path:
//   - the sweep REGISTRY supplies the entry resolution + the input schema
//     (getOp-style: find by name, inputSchema.parse);
//   - the ledger consult is the REAL makeLedgerQuery over the memory-backed
//     store fake the planner-contract fixture pins — the query is never
//     stubbed;
//   - the subprocess-bound IMPORTER is dispatched for real where no ledger
//     is involved (workspace-all never touches changedFiles).
//
// Proven here:
//   (a) a registry-dispatched planSweep consults view.knownNoise — a fully-
//       noise package contributes NO units; a fresh package still plans;
//   (b) every view.needsHuman baseline signature lands in the report's
//       needsHuman rows — routed to a human, never planned as auto-fix;
//   (c) the registry schema REJECTS a selector-less input at the boundary —
//       the CLI's generic missing-required-field path turns that into
//       exit 2 with no op ever run (pinned at test/cli/i1.test.ts:196);
//   (d) the REAL makePlanSweep factory bound with the REAL makeLedgerQuery
//       over the memory store reproduces the same semantics end-to-end.
// Also pinned: gitMutex is NOT a registry op (library utility only).
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { OpRegistryEntry, OpResult } from '../../../src/kernel/types.js';
import type { LedgerEntry, LedgerFile } from '../../../src/ops/ledger/store.js';
import type { LedgerStore } from '../../../src/ops/ledger/ledger.js';
import { makeLedgerQuery } from '../../../src/ops/ledger/ledger.js';
import { get } from '../../../src/registry/index.js';
import type { CleanupReport } from '../../../src/ops/sweep/cleanup.js';
import { SWEEP_UNIT_OP, makePlanSweep } from '../../../src/ops/sweep/planSweep.js';
import type { PlanSweepInput } from '../../../src/ops/sweep/planSweep.js';
import { registry } from '../../../src/ops/sweep/registry.js';
import type { SalvagePlan } from '../../../src/ops/sweep/salvage.js';

// ---------------------------------------------------------------------------
// Fixtures — the planner-contract store fake and ledger state
// ---------------------------------------------------------------------------

/** In-memory store over a deep-cloned file — the fake test/ops/ledger/planner-contract.test.ts pins. */
function memoryStore(entries: LedgerEntry[]): LedgerStore {
  let file: LedgerFile = { version: 1, entries };
  return {
    load: () => structuredClone(file),
    save: (next) => {
      file = structuredClone(next);
    },
  };
}

/** knownNoise = [sig-human, sig-noise]; needsHuman = [sig-human] (suppressAt 2, escalateAt 3). */
const LEDGER_ENTRIES: LedgerEntry[] = [
  { signature: 'sig-noise', count: 2 },
  { signature: 'sig-human', count: 4 },
  { signature: 'sig-fresh', count: 1 },
];

const PACKAGES = [
  { name: 'core', path: 'packages/core' },
  { name: 'cli', path: 'packages/cli' },
];

function sweepEntry(name: string): OpRegistryEntry {
  const entry = registry.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`the sweep registry has no entry '${name}'`);
  return entry;
}

/**
 * getOp-style registry dispatch of the planner: entry resolution +
 * inputSchema.parse are the REGISTRY-level contract, then the REAL
 * makePlanSweep factory — the one the importer resolves — runs with the
 * memory-backed ledger through makeLedgerQuery. changedFiles is inert
 * here: every selector in this suite is workspace-all.
 */
async function dispatchPlanSweep(
  input: unknown,
  entries: LedgerEntry[],
): Promise<OpResult<unknown>> {
  const entry = sweepEntry('sweep.planSweep');
  // The entry's schema is typed `unknown` at OpRegistryEntry's default —
  // the cast mirrors the dispatch seam: the schema IS the registry-time
  // mirror of PlanSweepInput, so its parse result is that input.
  const parsed = entry.inputSchema.parse(input) as PlanSweepInput;
  const planner = makePlanSweep({
    changedFiles: async () => [],
    queryLedger: makeLedgerQuery(() => memoryStore(entries)),
  });
  return planner(parsed);
}

const INPUT = {
  repoRoot: '/repo',
  packages: PACKAGES,
  selector: { mode: 'workspace-all' },
  fixers: ['lint', 'format'],
  ledger: { root: '.cq', storePath: '.cq/ledger.json' },
  baselineSignatures: [
    { package: 'core', signature: 'sig-noise' }, // all-known-noise → core suppressed
    { package: 'cli', signature: 'sig-fresh' }, // fresh → cli still plans
  ],
};

// ---------------------------------------------------------------------------
// The registry surface itself
// ---------------------------------------------------------------------------

describe('sweep registry surface', () => {
  test('exactly four entries: planSweep + worktreeFor + salvage + cleanup — gitMutex is NOT an op', () => {
    expect(registry.map((entry) => entry.name).sort()).toEqual([
      'sweep.cleanup',
      'sweep.planSweep',
      'sweep.salvage',
      'sweep.worktreeFor',
    ]);
  });

  test('(c) the registry schema REJECTS a selector-less input — the exit-2 boundary', () => {
    // Without `selector`, dispatch dies HERE as schema-invalid input; the
    // CLI maps that to exit 2 with no op ever run (test/cli/i1.test.ts:196).
    const { selector: _omitted, ...selectorLess } = INPUT;
    const parsed = sweepEntry('sweep.planSweep').inputSchema.safeParse(selectorLess);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes('selector'))).toBe(true);
    }
    // An unknown mode fails the union the same way — no default branch exists.
    const unknownMode = sweepEntry('sweep.planSweep').inputSchema.safeParse({
      ...INPUT,
      selector: { mode: 'magic' },
    });
    expect(unknownMode.success).toBe(false);
  });

  test('the worktreeFor schema accepts the plain JSON a caller sends and bounds the mutex', () => {
    const input = {
      repoRoot: '/repo',
      worktreesDir: '/runs/wt',
      runPrefix: 'cq/09-16a',
      kind: 'fix',
      slug: 'core',
      base: 'origin/main',
    };
    expect(sweepEntry('sweep.worktreeFor').inputSchema.safeParse(input).success).toBe(true);
    expect(
      sweepEntry('sweep.worktreeFor').inputSchema.safeParse({
        ...input,
        mutex: { lockPath: '/repo/.cq/git-mutex.lock', staleMs: 1999 }, // below the clamp floor
      }).success,
    ).toBe(false);
  });

  test('the mutex retry budget is cross-checked at the schema boundary (jFLDD, exit 2 not runtime-failed)', () => {
    const input = {
      repoRoot: '/repo',
      worktreesDir: '/runs/wt',
      runPrefix: 'cq/09-16a',
      kind: 'fix',
      slug: 'core',
      base: 'origin/main',
    };
    const entry = sweepEntry('sweep.worktreeFor');
    // Individually valid, collectively insufficient: floor 1×(2^0−1) = 0 ms
    // < the 2000 ms stale window — makeGitMutex would reject at construction.
    expect(
      entry.inputSchema.safeParse({
        ...input,
        mutex: { lockPath: '/repo/.cq/git-mutex.lock', staleMs: 2000, retries: 0, retryBaseMs: 1 },
      }).success,
    ).toBe(false);
    // A satisfying triple passes the same boundary.
    expect(
      entry.inputSchema.safeParse({
        ...input,
        mutex: {
          lockPath: '/repo/.cq/git-mutex.lock',
          staleMs: 60_000,
          retries: 10,
          retryBaseMs: 100,
        },
      }).success,
    ).toBe(true);
  });

  test('the salvage schema accepts the plain JSON a caller sends and rejects inventory faults (PR156 r1 E)', () => {
    const entry = sweepEntry('sweep.salvage');
    const input = {
      repoRoot: '/repo',
      entries: [
        {
          path: '/runs/wt/fix/core',
          branch: 'cq/09-16a/fix/core',
          runPrefix: 'cq/09-16a',
          journal: { lastStep: 'fix.core.lint', stepsTotal: 4, allTerminal: false },
        },
        { path: '/runs/wt/fix/cli' },
      ],
      discardDirty: true,
    };
    expect(entry.inputSchema.safeParse(input).success).toBe(true);
    // The selector-class faults: a missing required field dies at this
    // boundary (exit 2), never mid-op.
    const { entries: _omitted, ...entriesLess } = input;
    expect(entry.inputSchema.safeParse(entriesLess).success).toBe(false);
    // Shape faults on the inventory and its metadata.
    expect(entry.inputSchema.safeParse({ ...input, entries: 'build' }).success).toBe(false);
    expect(entry.inputSchema.safeParse({ ...input, entries: [{}] }).success).toBe(false);
    expect(
      entry.inputSchema.safeParse({ ...input, entries: [{ path: '/x', journal: 'done' }] }).success,
    ).toBe(false);
    expect(
      entry.inputSchema.safeParse({
        ...input,
        entries: [{ path: '/x', journal: { stepsTotal: -1 } }],
      }).success,
    ).toBe(false);
    expect(entry.inputSchema.safeParse({ ...input, discardDirty: 'yes' }).success).toBe(false);
    // Strict: an unknown key is rejected, not stripped.
    expect(entry.inputSchema.safeParse({ ...input, extra: 1 }).success).toBe(false);
  });

  test('the cleanup schema accepts plain JSON and bounds olderThanMs + the SHARED mutex schema (PR156 r1 E)', () => {
    const entry = sweepEntry('sweep.cleanup');
    const input = {
      repoRoot: '/repo',
      worktreesDir: '/runs/wt',
      runPrefix: 'cq/09-16a',
      olderThanMs: 0,
      dryRun: false,
      force: true,
      mutex: { lockPath: '/repo/.cq/git-mutex.lock', staleMs: 2000, retries: 9, retryBaseMs: 100 },
    };
    expect(entry.inputSchema.safeParse(input).success).toBe(true);
    // olderThanMs is REQUIRED and bounds-checked at the schema.
    const { olderThanMs: _omitted, ...cutoffLess } = input;
    expect(entry.inputSchema.safeParse(cutoffLess).success).toBe(false);
    expect(entry.inputSchema.safeParse({ ...input, olderThanMs: -1 }).success).toBe(false);
    expect(entry.inputSchema.safeParse({ ...input, olderThanMs: 1.5 }).success).toBe(false);
    // Mutex bounds via the SHARED GitMutexBindingSchema: the clamp floor…
    expect(
      entry.inputSchema.safeParse({
        ...input,
        mutex: { lockPath: '/l', staleMs: 1999 },
      }).success,
    ).toBe(false);
    // …and the jFLDD cross-field invariant, one definition for the family.
    expect(
      entry.inputSchema.safeParse({
        ...input,
        mutex: { lockPath: '/l', staleMs: 2000, retries: 0, retryBaseMs: 1 },
      }).success,
    ).toBe(false);
    expect(entry.inputSchema.safeParse({ ...input, dryRun: 'yes' }).success).toBe(false);
    expect(entry.inputSchema.safeParse({ ...input, force: 1 }).success).toBe(false);
  });

  test('the salvage importer dispatches through the registry get/importer path — empty entries, ok, zero rows', async () => {
    const entry = await get('sweep.salvage');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const op = await entry.importer();
    const result = await op({ repoRoot: '/repo', entries: [] });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      const plan = result.value as SalvagePlan;
      expect(plan.rows).toEqual([]);
      expect(Object.values(plan.counts).every((n) => n === 0)).toBe(true);
    }
  });

  test('the cleanup importer dispatches through the registry get/importer path — dry run on a scratch repo, ok report (PR156 r2#3)', async () => {
    // A REAL scratch repo (the subprocess binding runs real git): a bare
    // init is enough — no commits, no run worktrees, nothing under the
    // prefix, and dry-run means zero mutators regardless.
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-importer-'));
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'git',
          ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'init', '-q', '-b', 'main', dir],
          { timeout: 10_000, killSignal: 'SIGKILL' },
          (error) => (error === null ? resolve() : reject(error)),
        );
      });
      const entry = await get('sweep.cleanup');
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      const op = await entry.importer();
      const result = await op({
        repoRoot: dir,
        worktreesDir: join(dir, 'wt'),
        runPrefix: 'cq/x',
        olderThanMs: 1_000,
        dryRun: true,
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        const report = result.value as CleanupReport;
        expect(report.dryRun).toBe(true);
        expect(report.removed).toEqual([]);
        expect(report.pruned).toEqual([]);
        expect(report.skippedDirty).toEqual([]);
        expect(report.branchesRemoved).toEqual([]);
        // The main checkout is accounted for as an untouchable kept row.
        expect(report.kept).toHaveLength(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (a)+(b) — registry-schema-mediated dispatch over the real query
// ---------------------------------------------------------------------------

describe('registry-dispatched planSweep consults the ledger (UC §1 row 8)', () => {
  test('(a) a fully-known-noise package contributes NO units; the fresh package plans', async () => {
    const result = await dispatchPlanSweep(INPUT, LEDGER_ENTRIES);
    if (result.status !== 'ok') {
      throw new Error(`expected ok, got ${result.status}`);
    }
    const report = result.value as {
      units: Array<{ package: string }>;
      jobs: Array<{ op: string }>;
    };
    expect(report.units.map((unit) => unit.package)).toEqual(['cli', 'cli']);
    expect(report.jobs).toHaveLength(2);
    for (const job of report.jobs) {
      expect(job.op).toBe(SWEEP_UNIT_OP);
    }
  });

  test('(b) every needsHuman signature routes to the report rows — never planned as auto-fix', async () => {
    const result = await dispatchPlanSweep(
      {
        ...INPUT,
        baselineSignatures: [
          { package: 'core', signature: 'sig-human' }, // escalated: routes AND suppresses
          { package: 'cli', signature: 'sig-fresh' },
        ],
      },
      LEDGER_ENTRIES,
    );
    if (result.status !== 'ok') {
      throw new Error(`expected ok, got ${result.status}`);
    }
    const report = result.value as {
      units: Array<{ package: string }>;
      suppressed: Array<{ package: string }>;
      needsHuman: Array<{ package: string; signature: string }>;
    };
    // The escalated signature is routed to a human…
    expect(report.needsHuman).toEqual([{ package: 'core', signature: 'sig-human' }]);
    // …and its package is suppressed (needsHuman ⊆ knownNoise).
    expect(report.suppressed.map((row) => row.package)).toEqual(['core']);
    expect(report.units.map((unit) => unit.package)).toEqual(['cli', 'cli']);
  });
});

// ---------------------------------------------------------------------------
// (d) — the real factory bound with the real query, end to end
// ---------------------------------------------------------------------------

describe('makePlanSweep + makeLedgerQuery end-to-end (no stub in between)', () => {
  test('the view the planner consumed is the ledger family view, and the semantics hold', async () => {
    // The planner-contract fixture's own assertions, re-derived at the
    // integration layer: what knownNoise/needsHuman ARE for this store.
    const query = makeLedgerQuery(() => memoryStore(LEDGER_ENTRIES));
    const view = await query({ root: 'unused-by-the-fake', storePath: 'unused-by-the-fake' });
    if (view.status !== 'ok') {
      throw new Error(`query failed: ${view.status === 'failed' ? view.error : view.status}`);
    }
    expect(view.value.knownNoise).toEqual(['sig-human', 'sig-noise']);
    expect(view.value.needsHuman).toEqual(['sig-human']);

    // The REAL factory over that SAME query reproduces the suppression and
    // the routing with no registry schema and no fake in between.
    const planner = makePlanSweep({
      changedFiles: async () => [],
      queryLedger: query,
    });
    const result = await planner({
      repoRoot: '/repo',
      packages: PACKAGES,
      selector: { mode: 'workspace-all' },
      fixers: ['lint'],
      ledger: { root: 'unused-by-the-fake', storePath: 'unused-by-the-fake' },
      baselineSignatures: [
        { package: 'core', signature: 'sig-noise' },
        { package: 'cli', signature: 'sig-human' },
      ],
    });
    if (result.status !== 'ok') {
      throw new Error(`expected ok, got ${result.status}`);
    }
    expect(result.value.units.map((unit) => unit.package)).toEqual([]);
    expect(result.value.suppressed.map((row) => row.package)).toEqual(['core', 'cli']);
    expect(result.value.needsHuman).toEqual([{ package: 'cli', signature: 'sig-human' }]);
    expect(result.value.jobs).toHaveLength(0);
  });

  test('the REAL registry importer dispatches workspace-all end-to-end (subprocess deps bound, never invoked)', async () => {
    const entry = sweepEntry('sweep.planSweep');
    const op = await entry.importer();
    const result = await op(
      entry.inputSchema.parse({
        repoRoot: '/repo',
        packages: PACKAGES,
        selector: { mode: 'workspace-all' },
        fixers: ['lint'],
      }),
    );
    if (result.status !== 'ok') {
      throw new Error(
        `expected ok, got ${result.status}: ${result.status === 'failed' ? result.error : result.status}`,
      );
    }
    const report = result.value as { units: unknown[]; jobs: Array<{ id: string; op: string }> };
    expect(report.units).toHaveLength(2);
    expect(report.jobs.map((job) => job.id)).toEqual(['sweep-core-lint', 'sweep-cli-lint']);
    for (const job of report.jobs) {
      expect(job.op).toBe(SWEEP_UNIT_OP);
    }
  });
});
